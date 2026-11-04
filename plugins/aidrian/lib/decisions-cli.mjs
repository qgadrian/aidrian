// `aidrian decisions`: who settles one decision, the agent or the Human (lib/decisions.mjs), and the decisions agents
// made alone, on record as marker lines in the indexed knowledge docs.
//
//   aidrian decisions resolve --domain ux --class copy --reversible no,no,no,no
//   aidrian decisions resolve --vocab            # every class and reversibility question, defined
//   aidrian decisions list [--json]              # every marker, and what is wrong with the malformed ones
//   aidrian decisions list --added-since REF     # only what the branch committed since it left REF, new and settled
//   aidrian decisions set ID confirmed|rejected  # the Human's answer: rewrites that one marker in the working copy
//
// `--reversible` answers the questions of decisions.json in its order: storedData, external, pricingOrContract,
// reachesUsersUnreviewed. An answer left out asks. `--doc` names a doc, with an optional `#section`: from the current folder
// and, when relative, from the project root too.
// Output: { authority, rule, reason, secondLook, base }, where `base` is the commit whose config was read, or null when
// none was, and `secondLook` is that config's `decisions.secondLook`, or null when none was read.
// Exit 0 on either answer; 1 on bad arguments or an invalid config. docs/config.md#decisions has the rules, and
// docs/project-folder.md#decision-markers the marker. `list` exits 0 with problems: they are part of what it reports.

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, committedDecisions, DEFAULTS, localDecisions } from './config.mjs';
import { ghJson } from './gh.mjs';
import { ageDays, loadVocab, parseDecisions, resolveAuthority, setDecisionStatus } from './decisions.mjs';
import { checkoutRoots, runGit } from './git.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { committedConfigFile, findProject, noProjectMessage, projectAt } from './project.mjs';
import { checkTool as mainCheckoutDenial } from './rules/main-checkout.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'resolve --domain D --class C [--reversible A,B,C,D] [--doc PATH]... [--project DIR] | resolve --vocab ' +
  '| list [--added-since REF] [--json] [--project DIR] | set ID confirmed|rejected [--project DIR]';
const SETTLED = ['confirmed', 'rejected'];
// A branch-scoped list reads whole docs from git, which can outlast git.mjs's default for a hook.
const GIT_READ = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
const ANSWERS = { no: false, yes: true };

export const commands = {
  decisions: {
    usage: USAGE,
    about: 'say whether an agent may settle one decision or must ask the Human, from config.json `decisions` at the base branch, with A,B,C,D the four reversibility answers, each no or yes; print the decision classes; list the decisions on record in the indexed docs, or those a branch added since REF; or set the Human\'s answer on one',
    run(args) {
      const [action, ...rest] = args;
      if (action === 'list') return list(rest);
      if (action === 'set') return set(rest);
      if (action !== 'resolve') return fail(`decisions takes resolve, list, or set${action ? `, not "${action}"` : ''}`);
      const word = { type: 'string' };
      const { values } = parseArgs({
        args: rest,
        options: { domain: word, class: word, reversible: word, doc: { type: 'string', multiple: true }, project: word, vocab: { type: 'boolean' } },
      });
      if (values.vocab) {
        console.log(JSON.stringify(vocabulary(), null, 2));
        return 0;
      }
      if (!values.domain || !values.class) return fail('resolve needs --domain and --class');
      const reversible = answers(values.reversible);
      if (!reversible) return fail(`--reversible takes up to ${questions().length} answers, each no or yes, separated by commas: ${questions().join(', ')}`);
      const project = projectAt(values.project ?? process.cwd());
      const { decisions, base } = decisionsInForce(project);
      const docs = (values.doc ?? []).flatMap((doc) => docReadings(project, doc));
      const out = decisions === null
        ? { authority: 'ask', rule: 'no-base', reason: 'git could not give the base branch\'s config, so the decision goes to the Human' }
        : resolveAuthority({ decisions: withResolvedEntries(project, decisions) }, { domain: values.domain, class: values.class, reversible, docs });
      console.log(JSON.stringify({ ...out, secondLook: decisions?.secondLook ?? null, base }));
      return 0;
    },
  },
};

// The markers of `docs`, each read by `read`, which may return null for a doc to pass over: { decisions, problems, lineAt },
// where a decision adds { doc, ageDays }, a problem is { doc, line, problem }, and `lineAt` gives the trimmed text of the
// line either names. An id on two markers is a problem on each.
function readMarkers(docs, read) {
  const decisions = [];
  const problems = [];
  const lines = new Map();
  for (const doc of docs) {
    let text;
    try {
      text = read(doc);
    } catch (error) {
      problems.push({ doc, line: null, problem: `cannot read the doc: ${error.code ?? error.message}` });
      continue;
    }
    if (text === null) continue;
    lines.set(doc, text.split(/\r?\n/u));
    const found = parseDecisions(text);
    decisions.push(...found.decisions.map((each) => ({ ...each, doc, ageDays: ageDays(each.date) })));
    problems.push(...found.problems.map((each) => ({ doc, ...each })));
  }
  for (const decision of decisions) {
    const others = decisions.filter((each) => each !== decision && each.id === decision.id);
    if (others.length) problems.push({ doc: decision.doc, line: decision.line, problem: `id "${decision.id}" is also at ${others.map(place).join(', ')}` });
  }
  problems.sort((a, b) => docs.indexOf(a.doc) - docs.indexOf(b.doc) || a.line - b.line);
  return { decisions, problems, lineAt: ({ doc, line }) => lines.get(doc)[line - 1].trim() };
}

const indexed = (buckets) => [...new Set(buckets.flatMap((bucket) => bucket.docs.map((doc) => doc.path)))];
const indexProblems = (errors) => errors.map((problem) => ({ doc: null, line: null, problem }));

// The markers of every indexed knowledge doc, as the working copy holds them, so a branch sees its own: { decisions,
// problems, docs }, with `docs` the count of docs read. A problem of the indexes has a null doc and line; `aidrian check`
// reports those as errors. A marker of a doc a local source indexes lists too, under its absolute path, though no other
// machine sees it.
export function scanDecisions(project) {
  commandConfig(project);
  const { buckets, errors } = loadKnowledge(project);
  const docs = indexed(buckets);
  const { decisions, problems } = readMarkers(docs, (doc) => readFileSync(path.resolve(project.root, doc), 'utf8'));
  return { decisions, problems: [...indexProblems(errors), ...problems], docs: docs.length };
}

// What the branch committed since it left `ref`, parsed at both ends: { decisions, settled, problems, pullRequest }, or
// null when git cannot compare them. A decision counts when its id is on no marker at the merge base, in any Markdown
// file, so a moved marker is not new. `settled` holds each marker the base has whose status the branch changed, with
// `was`. A problem counts when its line, status and pull request aside, is not there, so one the branch inherited is not
// its own. A new decision in a Markdown file no index lists is a problem, and with a pull request open for the branch, so
// is a `pr=none` the branch added.
function addedSince(project, ref) {
  commandConfig(project);
  const { buckets, errors } = loadKnowledge(project);
  const git = (...args) => runGit(args, project.root, GIT_READ);
  const merged = ref.startsWith('-') ? null : git('merge-base', ref, 'HEAD');
  if (merged?.status !== 0) return null;
  const base = merged.stdout.trim();
  const show = (rev, file) => {
    const shown = git('show', `${rev}:./${file}`);
    return shown.status === 0 ? shown.stdout : null;
  };
  // The Markdown files of `rev` that mention a marker, or null when git fails; 1 is git saying there are none.
  const markerFiles = (rev) => {
    const listed = git('grep', '-l', '-z', '-F', 'aidrian:decision', rev, '--', '*.md');
    if (listed.status !== 0 && listed.status !== 1) return null;
    return listed.stdout.split('\0').filter(Boolean).map((entry) => entry.slice(rev.length + 1));
  };
  const atBase = markerFiles(base);
  const atHead = markerFiles('HEAD');
  if (atBase === null || atHead === null) return null;
  const sameLine = (line) => line.trim().replace(/(\s(?:status|pr)=)[^\s-]+/gu, '$1');
  const statuses = new Map();
  const lines = new Set();
  for (const file of atBase) {
    const text = show(base, file) ?? '';
    for (const { id, status } of parseDecisions(text).decisions) statuses.set(id, status);
    for (const line of text.split(/\r?\n/u)) if (line.includes('aidrian:decision')) lines.add(sameLine(line));
  }
  const docs = indexed(buckets).filter((doc) => !path.isAbsolute(doc));
  const { decisions, problems, lineAt } = readMarkers(docs, (doc) => show('HEAD', doc));
  const added = decisions.filter(({ id }) => !statuses.has(id));
  const settled = decisions.filter(({ id, status }) => statuses.has(id) && statuses.get(id) !== status).map((each) => ({ ...each, was: statuses.get(each.id) }));
  const stray = atHead.filter((file) => !docs.includes(file)).flatMap((doc) => parseDecisions(show('HEAD', doc) ?? '').decisions
    .filter(({ id }) => !statuses.has(id))
    .map(({ id, line }) => ({ doc, line, problem: `"${id}" is in a doc no knowledge index lists: markers belong in an indexed doc` })));
  const pullRequest = openPullRequest(project);
  const unset = pullRequest === null ? [] : added.filter(({ pr }) => pr === null)
    .map(({ doc, line, id }) => ({ doc, line, problem: `"${id}" still says pr=none, but pull request #${pullRequest} exists: write its number on the marker` }));
  const own = problems.filter((each) => each.line === null || !lines.has(sameLine(lineAt(each))));
  return { decisions: added, settled, problems: [...indexProblems(errors), ...own, ...stray, ...unset], pullRequest };
}

// The number of the branch's pull request, or null when it has none or gh cannot say.
function openPullRequest(project) {
  try {
    const { number } = ghJson(['pr', 'view', '--json', 'number'], { cwd: project.root });
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

export const place = ({ doc, line }) => (line === null ? doc : `${doc}:${line}`);

// The project at --project or the current folder, or null after saying there is none.
function knownProject(start = process.cwd()) {
  const project = findProject(start);
  if (!project) console.error(noProjectMessage(path.resolve(start)));
  return project;
}

function list(args) {
  const { values } = parseArgs({ args, options: { 'added-since': { type: 'string' }, json: { type: 'boolean' }, project: { type: 'string' } } });
  const project = knownProject(values.project);
  if (!project) return 1;
  const ref = values['added-since'];
  const found = ref === undefined ? scanDecisions(project) : addedSince(project, ref);
  if (!found) {
    console.error(`cannot compare this branch with "${ref}": git knows no such ref, or could not read it`);
    return 1;
  }
  const { decisions, settled = [], problems, docs, pullRequest } = found;
  if (values.json) {
    console.log(JSON.stringify(ref === undefined ? { decisions, problems } : { decisions, settled, problems, pullRequest }));
    return 0;
  }
  const wording = ({ hasOldWording, oldWording }) => (!hasOldWording ? 'no' : oldWording === null ? 'unreadable' : 'yes');
  const row = (each) => [each.id, each.status, each.class, each.domain, `${each.ageDays}d`, place(each), `pr=${each.pr ?? 'none'}`, `old wording: ${wording(each)}`];
  const rows = [...decisions.map(row), ...settled.map((each) => [...row(each), `settled, was ${each.was}`])];
  rows.push(...problems.map((each) => ['problem', ...(each.doc === null ? [] : [place(each)]), each.problem]));
  console.log(rows.length ? rows.map((row) => row.join('\t')).join('\n') : ref === undefined ? `no decisions in ${docs} indexed doc${docs === 1 ? '' : 's'}` : `no decisions added since ${ref}`);
  return 0;
}

function set(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' } } });
  const [id, status, ...extra] = positionals;
  if (!id || !status || extra.length) return fail('set needs an id and confirmed or rejected');
  if (!SETTLED.includes(status)) return fail(`set takes confirmed or rejected, not "${status}": nothing goes back to unconfirmed`);
  const project = knownProject(values.project);
  if (!project) return 1;
  const { decisions, problems } = scanDecisions(project);
  const found = decisions.filter((each) => each.id === id);
  if (found.length !== 1) {
    const count = problems.filter((each) => each.line !== null).length;
    const hint = count ? ` ${count} marker problem${count === 1 ? '' : 's'}: run aidrian decisions list` : '';
    console.error(found.length ? `id "${id}" is on ${found.length} markers: ${found.map(place).join(', ')}; fix the repeat first` : `no decision marker with id "${id}".${hint}`);
    return 1;
  }
  const [{ doc }] = found;
  const file = path.resolve(project.root, doc);
  // Latin-1 maps each byte to one character and back, so a byte that is not UTF-8 survives; a marker is ASCII.
  const before = readFileSync(file, 'latin1');
  const out = setDecisionStatus(before, id, status);
  if (!out) {
    console.error(`${place(found[0])}: could not rewrite the marker of "${id}"`);
    return 1;
  }
  if (out.from === status) {
    console.log(`${doc}:${out.line}: ${id} already ${status}`);
    return 0;
  }
  // The same answer the main-checkout rule gives an edit of this doc, with its override and `allowWrites`.
  const denied = mainCheckoutDenial({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: project.root });
  if (denied) {
    console.error(denied);
    return 1;
  }
  writeFileSync(file, out.text, 'latin1');
  console.log(`${doc}:${out.line}: ${id} ${status} (was ${out.from})`);
  return 0;
}

const questions = () => Object.keys(loadVocab().reversibility);

// The vocabulary `--vocab` prints: each class with its definition and whether it is a floor class, floor classes first.
function vocabulary() {
  const { classes, reversibility } = loadVocab();
  return { classes: Object.fromEntries(classes.map(({ class: name, floor, definition }) => [name, { floor, definition }])), reversibility };
}

// `--reversible` as { question: boolean }, with a question left out missing, or null when a word is neither no nor yes,
// or there are more words than questions. An absent `--reversible` answers nothing, so every question asks.
function answers(value) {
  if (value === undefined) return {};
  const words = value.split(',').map((word) => word.trim().toLowerCase());
  const keys = questions();
  if (words.length > keys.length || words.some((word) => !Object.hasOwn(ANSWERS, word))) return null;
  return Object.fromEntries(words.map((word, i) => [keys[i], ANSWERS[word]]));
}

// What `doc` can mean, each as a path from the project root with its `#section` kept: from the current folder, and,
// when relative, from the project root, the spelling config.json uses, unless that climbs out of it. Each comes with
// symlinks resolved, and with those inside the project left as written, so an entry that names a link matches it.
// resolveAuthority asks when any reading is covered, and for a path outside the project, which starts with `../`: only
// a resolved reading can start so, since a link out of the project is outside it, however it is written.
function docReadings(project, doc) {
  const [file, section] = splitSection(doc);
  const root = real(project.root);
  const fromRoot = (absolute) => [resolvedFromRoot(root, absolute), writtenFromRoot(root, absolute)].filter((each) => each !== null).map((each) => `${each}${section}`);
  const readings = fromRoot(path.resolve(file));
  const climbs = path.normalize(file).split(path.sep)[0] === '..';
  if (!path.isAbsolute(file) && !climbs) readings.push(...fromRoot(path.join(root, file)));
  return [...new Set(readings)];
}

// `decisions` with each `escalateDocs` entry also in its resolved spelling, so an entry that names a link covers its
// target too. An entry is a path from the project root, so it has one reading.
function withResolvedEntries(project, decisions) {
  const root = real(project.root);
  const resolved = decisions.escalateDocs.map((entry) => {
    const [file, section] = splitSection(entry);
    return `${resolvedFromRoot(root, path.join(root, file))}${section}`;
  });
  return { ...decisions, escalateDocs: [...new Set([...decisions.escalateDocs, ...resolved])] };
}

// A doc path as [file, section], with the section's `#` kept, or empty.
function splitSection(doc) {
  const at = doc.indexOf('#');
  return at === -1 ? [doc, ''] : [doc.slice(0, at), doc.slice(at)];
}

// `absolute` from `root`, a real path, with every symlink resolved. It starts with `../` when it leaves the project.
const resolvedFromRoot = (root, absolute) => path.relative(root, real(absolute)).replaceAll(path.sep, '/') || '.';

// `absolute` from `root`, a real path, with the symlinks past the project root as written; any spelling of the root
// itself counts as it. null when `absolute` is not under the root as written.
function writtenFromRoot(root, absolute) {
  const top = path.parse(absolute).root;
  const parts = path.relative(top, absolute).split(path.sep).filter(Boolean);
  for (let i = 0; i <= parts.length; i += 1) {
    if (real(path.join(top, ...parts.slice(0, i))) === root) return parts.slice(i).join('/') || '.';
  }
  return null;
}

// `file` with symlinks resolved and, on a disk that ignores case, the disk's own spelling, through the nearest folder
// that exists when the file itself does not.
function real(file) {
  try {
    return realpathSync.native(file);
  } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(real(parent), path.basename(file));
  }
}

// The `decisions` block in force, and the commit it was read from: { decisions, base }. The team's block is the base
// branch's, in the config folder the base branch names, so an uncommitted edit, or a commit on another branch, cannot
// raise an agent's authority. The exception: with no remote, a commit on the local main is the base, so it does. The
// machine's local file then goes over the block, held to its ceilings. commandConfig stops
// on an invalid config. Only with no git at all is the working copy the team's block. Inside git, `decisions` is null
// when git cannot give the base, so a stalled git never reads as a project with no rules.
function decisionsInForce(project) {
  const config = commandConfig(project);
  if (!insideGit(project.root)) return { decisions: config.decisions, base: null };
  const base = baseTip(project);
  if (base === null) return { decisions: null, base };
  try {
    const team = committedDecisions(project, base, committedConfigFile(project, base));
    return { decisions: localDecisions(team, project, []), base };
  } catch {
    return { decisions: null, base };
  }
}

// Whether `root` is in a git checkout. A `.git` above it counts when git does not answer: git that stalls, which
// checkoutRoots reports as it does no repository, must not turn the base branch's rules off.
function insideGit(root) {
  if (checkoutRoots(root) !== null) return true;
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

// The commit of the base branch, from names the working copy cannot set: origin/HEAD, then the plugin's default branch
// name on origin. A branch that names itself in config.json `git.defaultBranch` is not its own base. With no remote at
// all, a local branch of that name is the only record of the base; with any remote, whatever its name, a local branch
// can hold commits no one reviewed, so it never stands in. null when none resolves, or when git fails on one, whose
// answer the next ref must not replace: for rev-parse, 1 is git saying no such ref.
function baseTip(project) {
  const branch = DEFAULTS.git.defaultBranch;
  const tipOf = (ref) => runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], project.root);
  for (const ref of ['refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]) {
    const tip = tipOf(ref);
    if (tip.status === 0) return tip.stdout.trim();
    if (tip.status !== 1) return null;
  }
  const remotes = runGit(['remote'], project.root);
  if (remotes.status !== 0 || remotes.stdout.trim() !== '') return null;
  const local = tipOf(`refs/heads/${branch}`);
  return local.status === 0 ? local.stdout.trim() : null;
}

function fail(problem) {
  console.error(`${usageLines('decisions', USAGE).map((line, i) => (i ? `       ${line}` : `usage: ${line}`)).join('\n')}\n\n${problem}`);
  return 1;
}
