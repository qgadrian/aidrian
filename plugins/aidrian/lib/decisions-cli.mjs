// `aidrian decisions`: who settles one decision, the agent or the Human (lib/decisions.mjs), and the decisions agents
// made alone, on record as marker lines in the indexed knowledge docs.
//
//   aidrian decisions resolve --domain ux --class copy --reversible no,no,no,no
//   aidrian decisions resolve --vocab            # every class and reversibility question, defined
//   aidrian decisions list [--json]              # every marker, and what is wrong with the malformed ones
//   aidrian decisions list --added-since REF     # decisions, settled, and removed are the branch's; problems may also hold rows marked inherited; --json adds queue, the base branch's decisions.record.queue
//   aidrian decisions set ID confirmed|changed|rejected  # the Human's answer: rewrites that one marker in the working copy; changed confirms it
//   aidrian decisions undo ID                    # the Human's undo: puts back the old wording and removes the decision's lines
//
// `--reversible` answers the questions of decisions.json in its order: storedData, external, pricingOrContract,
// reachesUsersUnreviewed. An answer left out asks, and a yes asks but for one on the last that the base commit's
// `github.autoMerge.allow` and a decide-reversible mode accept, as the printed reason says. `--doc` names a doc, with an optional `#section`: from the current folder
// and, when relative, from the project root too.
// Output: { authority, rule, reason, unattended, secondLook, base }, where `base` is the commit whose config was read, or
// null when none was, and `secondLook` is that config's `decisions.secondLook`, or null with the rule `no-base`. `unattended`
// says what an unattended run does with an `ask`, "park" or "safe-default", from that config, and is null under `decide`.
// Exit 0 on either answer; 1 on bad arguments or an invalid config. docs/config.md#decisions has the rules, and
// docs/project-folder.md#decision-markers the marker. `list` exits 0 with problems: they are part of what it reports.
// `list --added-since` in a repository with no project folder prints the empty result and exits 0: no folder, no markers.
// `undo` exits 1 and writes nothing when it refuses, after printing why, both wordings, and the block it searched.
// `resolve`, `set`, and `undo` each add a row to the dispatch log (logDecision), and `quorum route` adds `resolve`'s;
// docs/dispatch-log.md describes them.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, committedAuthority, committedDecisions, DEFAULTS, loadConfig, localDecisions } from './config.mjs';
import { appendEvent, stamp } from './dispatch-log.mjs';
import { ghJson } from './gh.mjs';
import { ageDays, blockOf, DECISION_STATUSES, isClassName, loadVocab, parseDecisions, recordAt, resolveAuthority, setDecisionStatus, unattendedAnswer, undoDecision, wordingProblems } from './decisions.mjs';
import { checkoutRoots, runGit } from './git.mjs';
import { indexedPaths, loadKnowledge } from './knowledge.mjs';
import { committedConfigFile, findProject, noProjectMessage, projectAt } from './project.mjs';
import { checkTool as mainCheckoutDenial } from './rules/main-checkout.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'resolve --domain D --class C [--reversible A,B,C,D] [--doc PATH]... [--project DIR] | resolve --vocab [--project DIR] ' +
  '| list [--added-since REF] [--json] [--project DIR] | set ID confirmed|changed|rejected [--project DIR] | undo ID [--project DIR]';
// Each answer `set` takes, and the status it writes. `changed` is the Human's wording in place of the agent's: the rule stands, so
// the marker reads confirmed, and the log counts the answer as an override.
const SET_STATUS = { confirmed: 'confirmed', changed: 'confirmed', rejected: 'rejected' };
// A branch-scoped list reads whole docs from git, which can outlast git.mjs's default for a hook.
const GIT_READ = { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 };
const ANSWERS = { no: false, yes: true };

export const commands = {
  decisions: {
    usage: USAGE,
    about: 'say whether an agent may settle one decision or must ask the Human, from config.json `decisions` at the base branch, with A,B,C,D the four reversibility answers, each no or yes; print the decision classes; list the decisions on record in the indexed docs, or those a branch added since REF; set the Human\'s answer on one; or undo one, putting back the wording it replaced',
    run(args) {
      const [action, ...rest] = args;
      if (action === 'list') return list(rest);
      if (action === 'set') return set(rest);
      if (action === 'undo') return undo(rest);
      if (action !== 'resolve') return fail(`decisions takes resolve, list, set, or undo${action ? `, not "${action}"` : ''}`);
      const word = { type: 'string' };
      const { values } = parseArgs({
        args: rest,
        options: { domain: word, class: word, reversible: word, doc: { type: 'string', multiple: true }, project: word, vocab: { type: 'boolean' } },
      });
      if (values.vocab) {
        const { decisions } = decisionsInForce(projectAt(values.project ?? process.cwd()));
        console.log(JSON.stringify(vocabulary(decisions?.classes), null, 2));
        return 0;
      }
      if (!values.domain || !values.class) return fail('resolve needs --domain and --class');
      const reversible = answers(values.reversible);
      if (!reversible) return fail(reversibleProblem());
      const project = projectAt(values.project ?? process.cwd());
      console.log(JSON.stringify(resolveQuestion(project, { domain: values.domain, class: values.class, reversible, docs: values.doc ?? [] })));
      return 0;
    },
  },
};

// Who settles one decision, from the base branch's rules: what `decisions resolve` prints,
// `{ authority, rule, reason, unattended, secondLook, base }`, with its one row in the dispatch log.
// `decisions resolve` and `quorum route` both ask through here, so they cannot disagree, and the row's `key` counts one
// question once, whichever asked. commandConfig stops it on an invalid config.
export function resolveQuestion(project, { domain, class: kind, reversible, docs: named = [] }) {
  const { decisions, base, autoMergeAllow } = decisionsInForce(project);
  const docs = named.flatMap((doc) => docReadings(project, doc));
  const pending = decisions === null || decisions.unreviewed.pauseDomainAt === null ? [] : pendingDecisions(project, base, decisions.classes);
  const block = decisions === null ? null : withResolvedEntries(project, decisions);
  const question = { domain, class: kind, reversible, docs, pending };
  const out = decisions === null
    ? { authority: 'ask', rule: 'no-base', reason: 'git could not give the base branch\'s config, so the decision goes to the Human' }
    : pending === null
      ? { authority: 'ask', rule: 'no-base', reason: 'git could not give the unreviewed decisions, so the decision goes to the Human' }
      : resolveAuthority({ decisions: block, github: { autoMerge: { allow: autoMergeAllow } } }, question);
  const unattended = out.authority === 'decide' ? null : out.rule === 'no-base' ? 'park' : unattendedAnswer(block, question);
  logDecision(project, resolveRow(out, question));
  return { ...out, unattended, secondLook: out.rule === 'no-base' ? null : decisions.secondLook, base };
}

// What resolve logs: the rule, and the domain and class when each is a name. An argument is free text to the parser, and the
// log holds names; so is the rule's `reason`, which can quote a doc, left out. `key` is one question, asked in one session
// (or, with no session id, one day): the same words again carry the same key, and `aidrian report health` counts them once.
function resolveRow({ authority, rule }, { domain, class: kind, reversible, docs }, { env = process.env, now = Date.now() } = {}) {
  const asked = [env.CLAUDE_CODE_SESSION_ID || stamp(now).slice(0, 10), domain, kind, questions().map((key) => reversible[key] ?? null), [...docs].sort()];
  return {
    event: authority === 'decide' ? 'decision_made' : 'decision_escalated',
    rule,
    domain: isClassName(domain) ? domain : null,
    class: isClassName(kind) ? kind : null,
    key: createHash('sha256').update(JSON.stringify(asked)).digest('hex').slice(0, 16),
  };
}

// Appends one row to the dispatch log, while telemetry is on and only inside a project folder. A row that cannot be written
// is lost, and the command's answer stands: nothing here fails a command.
function logDecision(project, row, { env = process.env } = {}) {
  try {
    if (!findProject(project.root)) return;
    appendEvent(project, loadConfig(project).config, { event: row.event, ts: stamp(Date.now()), session_id: env.CLAUDE_CODE_SESSION_ID || null, ...row });
  } catch {
    // The state folder is out of reach, or a disk is full: the log says less, and the decision is still on record.
  }
}

// The row of the Human's answer on one marker: `action` is `confirmed`, `changed`, `rejected`, or `undo`, and `was` its status before.
const answerRow = ({ id, class: kind, domain }, action, was) =>
  ({ event: action === 'confirmed' ? 'decision_confirmed' : 'decision_overridden', id, class: kind, domain, action, was });

// Every marker of `text` on record, a class in neither list included: what the pause counts, and what is no new or removed marker.
const onRecord = (text, classes) => {
  const { decisions, unlisted } = parseDecisions(text, { classes });
  return [...decisions, ...unlisted];
};

// The markers of `docs`, each read by `read`, which may return null for a doc to pass over: { decisions, problems, unlisted, lineAt },
// where a decision and an `unlisted` marker (parseDecisions) add { doc, ageDays }, a problem is { doc, line, problem }, and
// `lineAt` gives the trimmed text of the line either names. An id on two markers is a problem on each. `classes` is config.json
// `decisions.classes`.
function readMarkers(docs, read, classes) {
  const decisions = [];
  const problems = [];
  const unlisted = [];
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
    const found = parseDecisions(text, { classes });
    const placed = (each) => ({ ...each, doc, ageDays: ageDays(each.date) });
    decisions.push(...found.decisions.map(placed));
    unlisted.push(...found.unlisted.map(placed));
    problems.push(...[...found.problems, ...wordingProblems(text, found)].map((each) => ({ doc, ...each })));
  }
  for (const decision of decisions) {
    const others = decisions.filter((each) => each !== decision && each.id === decision.id);
    if (others.length) problems.push({ doc: decision.doc, line: decision.line, problem: `id "${decision.id}" is also at ${others.map(place).join(', ')}` });
  }
  problems.sort((a, b) => docs.indexOf(a.doc) - docs.indexOf(b.doc) || a.line - b.line);
  return { decisions, problems, unlisted, lineAt: ({ doc, line }) => lines.get(doc)[line - 1].trim() };
}

const strayProblem = (id) => `"${id}" is in a doc no knowledge index lists: markers belong in an indexed doc`;
const indexProblems = (errors) => errors.map((problem) => ({ doc: null, line: null, problem }));

// The markers of every indexed knowledge doc, as the working copy holds them, so a branch sees its own: { decisions,
// problems, unlisted, notes, docs, lineAt }, with `docs` the count of docs read, and `lineAt` as readMarkers gives it. A problem of
// the indexes has a null doc and line; `aidrian check` reports those as errors. A marker of a doc a local source indexes
// lists too, under its absolute path, though no other machine sees it. A marker in a tracked Markdown file no index lists
// is a problem: it counts toward the domain pause, so the Human must be able to find it. A doc through a symlink is the
// file it reaches. When git cannot search a checkout, `notes` says those markers went unscanned. A marker may hold a class of
// the working copy's `decisions.classes`, as it holds the working copy's docs; only `resolve` needs the base branch's.
export function scanDecisions(project) {
  const { classes } = commandConfig(project).decisions;
  const { buckets, errors } = loadKnowledge(project);
  const docs = indexedPaths(buckets);
  const read = (doc) => readFileSync(path.resolve(project.root, doc), 'utf8');
  const { decisions, problems, unlisted, lineAt } = readMarkers(docs, read, classes);
  const stray = new Map();
  const outside = [];
  const onDisk = (doc) => real(path.resolve(project.root, doc));
  const known = new Set(docs.map(onDisk));
  const tracked = gitReader(project).markerFiles();
  const notes = tracked === null && insideGit(project.root) ? ['markers in files no index lists could not be scanned: git grep failed'] : [];
  for (const doc of (tracked ?? []).filter((file) => !known.has(onDisk(file)))) {
    let text;
    try {
      text = read(doc);
    } catch {
      continue;
    }
    stray.set(doc, text.split(/\r?\n/u));
    outside.push(...onRecord(text, classes).map(({ id, line }) => ({ doc, line, problem: strayProblem(id) })));
  }
  const textAt = (each) => (stray.has(each.doc) ? stray.get(each.doc)[each.line - 1].trim() : lineAt(each));
  return { decisions, problems: [...indexProblems(errors), ...problems, ...outside], unlisted, notes, docs: docs.length, lineAt: textAt };
}

// How to read `rev`s of the project from git: { git, show, markerFiles, markersAt }. `show` gives a file's text, or null.
// `markerFiles` gives the Markdown files of `rev`, or with none the tracked files of the working copy, that mention a
// marker, or null when git fails; 1 is git saying there are none. `markersAt` gives the decisions of a rev's such files,
// each with its `doc`, or null when git fails on one, reading config.json `decisions.classes` as `classes`.
function gitReader(project, classes) {
  const git = (...args) => runGit(args, project.root, GIT_READ);
  const show = (rev, file) => {
    const shown = git('show', `${rev}:./${file}`);
    return shown.status === 0 ? shown.stdout : null;
  };
  const markerFiles = (rev) => {
    const listed = git('grep', '-l', '-z', '-F', 'aidrian:decision', ...(rev ? [rev] : []), '--', '*.md');
    if (listed.status !== 0 && listed.status !== 1) return null;
    return listed.stdout.split('\0').filter(Boolean).map((entry) => (rev ? entry.slice(rev.length + 1) : entry));
  };
  const markersAt = (rev) => {
    const files = markerFiles(rev);
    if (files === null) return null;
    const found = [];
    for (const doc of files) {
      const text = show(rev, doc);
      if (text === null) return null;
      found.push(...onRecord(text, classes).map((each) => ({ ...each, doc })));
    }
    return found;
  };
  return { git, show, markerFiles, markersAt };
}

// The unreviewed decisions for the domain pause, as [{ domain, date }], or null when git cannot give them. Each unconfirmed
// marker of `base`, plus each marker the branch committed whose id neither `base` nor the merge base holds, whatever its
// status. So nothing in the working copy, or a status the branch set, lifts a pause: only the base branch's own record
// does. A marker whose only problem is a class in neither list counts too, so a commit that removes a class lifts nothing.
// With no git at all, `base` is null, and the working copy is the only record.
function pendingDecisions(project, base, classes) {
  if (base === null) {
    const { decisions, unlisted } = scanDecisions(project);
    return [...decisions, ...unlisted].filter(({ status }) => status === 'unconfirmed');
  }
  const { git, markersAt } = gitReader(project, classes);
  const fork = git('merge-base', base, 'HEAD');
  if (fork.status !== 0 && fork.status !== 1) return null;
  const atBase = markersAt(base);
  const atFork = fork.status === 0 ? markersAt(fork.stdout.trim()) : [];
  const atHead = markersAt('HEAD');
  if (atBase === null || atFork === null || atHead === null) return null;
  const known = new Set([...atBase, ...atFork].map(({ id }) => id));
  return [...atBase.filter(({ status }) => status === 'unconfirmed'), ...atHead.filter(({ id }) => !known.has(id))];
}

// A marker line with a valid status and pull request blanked, so changing one of those does not make a line new, and
// writing an invalid one does.
const STATUS_VALUE = new RegExp(`(\\sstatus=)(?:${DECISION_STATUSES.join('|')})(?=\\s|-->)`, 'u');
const sameLine = (line) => line.trim().replace(STATUS_VALUE, '$1').replace(/(\spr=)(?:[1-9]\d*|none)(?=\s|-->)/u, '$1');

// What the branch committed since it left `ref`, parsed at both ends: { decisions, settled, removed, problems, pullRequest, queue },
// or null when git cannot compare them. A decision counts when its id is on no marker at the merge base, in any Markdown
// file, so a moved marker is not new. `settled` holds each marker the base has whose status the branch changed, with
// `was`. `removed` holds each id at the merge base, with its `status` and `doc` there, that no indexed doc at HEAD holds,
// such as one undone; a marker the merge base held outside the indexed docs, and HEAD still holds there, is not removed.
// A problem is `inherited: true` when the merge base has the same problem on the same line, a valid status and pull request
// aside, and every other is the branch's own. A new decision in a Markdown file no index lists is a problem, and with a pull
// request open for the branch, so is a `pr=none` the branch added. Each end reads its markers with its own commit's
// `decisions.classes`, so a branch that removes a class owns the problems that makes, and a marker that only lost its class
// is neither new nor removed.
function addedSince(project, ref) {
  commandConfig(project);
  const { buckets, errors } = loadKnowledge(project);
  const { git, show, markerFiles } = gitReader(project);
  const merged = ref.startsWith('-') ? null : git('merge-base', ref, 'HEAD');
  if (merged?.status !== 0) return null;
  const base = merged.stdout.trim();
  const atBase = markerFiles(base);
  const atHead = markerFiles('HEAD');
  if (atBase === null || atHead === null) return null;
  const baseClasses = classesAt(project, base);
  const headClasses = classesAt(project, 'HEAD');
  if (baseClasses === null || headClasses === null) return null;
  const atMergeBase = readMarkers(atBase, (file) => show(base, file) ?? '', baseClasses);
  const baseMarkers = [...atMergeBase.decisions, ...atMergeBase.unlisted];
  const statuses = new Map(baseMarkers.map(({ id, status }) => [id, status]));
  const homes = new Map(baseMarkers.map(({ id, doc }) => [id, doc]));
  const sameProblem = (each, lineAt) => `${sameLine(lineAt(each))}\0${each.problem}`;
  const baseProblems = new Set(atMergeBase.problems.filter(({ line }) => line !== null).map((each) => sameProblem(each, atMergeBase.lineAt)));
  const docs = indexedPaths(buckets).filter((doc) => !path.isAbsolute(doc));
  const { decisions, problems, unlisted, lineAt } = readMarkers(docs, (doc) => show('HEAD', doc), headClasses);
  const added = decisions.filter(({ id }) => !statuses.has(id));
  const settled = decisions.filter(({ id, status }) => statuses.has(id) && statuses.get(id) !== status).map((each) => ({ ...each, was: statuses.get(each.id) }));
  const outside = atHead.filter((file) => !docs.includes(file)).flatMap((doc) => onRecord(show('HEAD', doc) ?? '', headClasses).map((each) => ({ ...each, doc })));
  const stray = outside.filter(({ id }) => !statuses.has(id))
    .map(({ doc, line, id }) => ({ doc, line, problem: strayProblem(id) }));
  const held = new Set([...decisions, ...unlisted].map(({ id }) => id));
  const removed = [...statuses].filter(([id]) => !held.has(id) && !outside.some((each) => each.id === id && each.doc === homes.get(id)))
    .map(([id, status]) => ({ id, status, doc: homes.get(id) }));
  const pullRequest = openPullRequest(project);
  // From the commit `resolve` reads, so no working-copy edit or commit on the branch changes where the list goes.
  const queue = decisionsInForce(project).decisions?.record.queue ?? DEFAULTS.decisions.record.queue;
  const unset = pullRequest === null ? [] : added.filter(({ pr }) => pr === null)
    .map(({ doc, line, id }) => ({ doc, line, problem: `"${id}" still says pr=none, but pull request #${pullRequest} exists: write its number on the marker` }));
  const marked = problems.map((each) => (each.line !== null && baseProblems.has(sameProblem(each, lineAt)) ? { ...each, inherited: true } : each));
  return { decisions: added, settled, removed, problems: [...indexProblems(errors), ...marked, ...stray, ...unset], pullRequest, queue };
}

// What a branch added where no project folder exists, so no marker does: the empty result, so a repository that has not
// adopted the plugin can still publish, or null when git cannot compare the branch with `ref`, which stays an unclear base.
function addedWithNoFolder(start, ref) {
  const merged = ref.startsWith('-') ? null : runGit(['merge-base', ref, 'HEAD'], start, GIT_READ);
  return merged?.status === 0 ? { decisions: [], settled: [], removed: [], problems: [], pullRequest: null, queue: DEFAULTS.decisions.record.queue } : null;
}

// `decisions.classes` as committed at `rev`, {} for a commit whose block cannot be read, or null when git fails.
function classesAt(project, rev) {
  try {
    return committedDecisions(project, rev, committedConfigFile(project, rev)).classes;
  } catch {
    return null;
  }
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
  const start = values.project ?? process.cwd();
  const ref = values['added-since'];
  let found;
  if (ref !== undefined && !findProject(start)) {
    found = addedWithNoFolder(start, ref);
  } else {
    const project = knownProject(start);
    if (!project) return 1;
    found = ref === undefined ? scanDecisions(project) : addedSince(project, ref);
  }
  if (!found) {
    console.error(`cannot compare this branch with "${ref}": git knows no such ref, or could not read it`);
    return 1;
  }
  const { decisions, settled = [], removed = [], problems, notes = [], docs, pullRequest, queue } = found;
  if (values.json) {
    console.log(JSON.stringify(ref === undefined ? { decisions, problems, notes } : { decisions, settled, removed, problems, pullRequest, queue }));
    return 0;
  }
  const wording = (has, words) => (!has ? 'no' : words === null ? 'unreadable' : 'yes');
  const row = (each) => [each.id, each.status, each.class, each.domain, `${each.ageDays}d`, place(each), `pr=${each.pr ?? 'none'}`,
    `old wording: ${wording(each.hasOldWording, each.oldWording)}`, `new wording: ${wording(each.hasNewWording, each.newWording)}`];
  const rows = [...decisions.map(row), ...settled.map((each) => [...row(each), `settled, was ${each.was}`]), ...removed.map(({ id, status, doc }) => [id, status, `removed from ${doc}`])];
  rows.push(...problems.map((each) => ['problem', ...(each.doc === null ? [] : [place(each)]), each.problem, ...(each.inherited ? ['inherited'] : [])]));
  const empty = ref === undefined ? `no decisions in ${docs} indexed doc${docs === 1 ? '' : 's'}` : `no decisions added since ${ref}`;
  const shown = [...(rows.length ? rows.map((row) => row.join('\t')) : [empty]), ...notes.map((note) => `note\t${note}`)];
  console.log(shown.join('\n'));
  return 0;
}

function set(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' } } });
  const [id, answer, ...extra] = positionals;
  if (!id || !answer || extra.length) return fail('set needs an id and confirmed, changed, or rejected');
  if (!Object.hasOwn(SET_STATUS, answer)) return fail(`set takes confirmed, changed, or rejected, not "${answer}": nothing goes back to unconfirmed`);
  const status = SET_STATUS[answer];
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
  const out = setDecisionStatus(before, id, status, commandConfig(project).decisions);
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
  logDecision(project, answerRow(found[0], answer, out.from));
  console.log(`${doc}:${out.line}: ${id} ${status} (${answer === status ? '' : `${answer}, `}was ${out.from})`);
  return 0;
}

// What a refusal of `undo` prints for one marker: its wordings and the block it searched, or as much as reads.
function refusalDetail(decision, block) {
  const shown = (has, words) => (!has ? 'none' : words === null ? 'unreadable' : JSON.stringify(words));
  console.error(`old wording: ${shown(decision.hasOldWording, decision.oldWording)}`);
  console.error(`new wording: ${shown(decision.hasNewWording, decision.newWording)}`);
  printBlock(block);
}

function printBlock(block) {
  console.error(`block above the marker:${block.length ? '' : ' empty'}`);
  for (const line of block) console.error(`  ${line}`);
}

function undo(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' } } });
  if (positionals.length !== 1) return fail('undo needs one id');
  const [id] = positionals;
  const project = knownProject(values.project);
  if (!project) return 1;
  const { decisions, problems, lineAt } = scanDecisions(project);
  const found = decisions.filter((each) => each.id === id);
  if (found.length === 0) {
    const named = problems.filter((each) => each.line !== null && lineAt(each).split(/\s+/u).includes(`id=${id}`));
    const hint = problems.some((each) => each.line !== null) ? ': run aidrian decisions list for the marker problems' : '';
    if (!named.length) {
      console.error(`no decision marker with id "${id}"${hint}`);
      return 1;
    }
    for (const each of named) console.error(`cannot undo "${id}" at ${place(each)}: ${each.problem}`);
    // The first named line of each doc is its marker's, or the wording left with no marker to read.
    for (const each of named.filter((one, i) => named.findIndex((other) => other.doc === one.doc) === i)) {
      const { wording, block } = recordAt(readFileSync(path.resolve(project.root, each.doc), 'utf8'), each.line);
      console.error(`wording lines from ${place(each)}:${wording.length ? '' : ' none'}`);
      for (const line of wording) console.error(`  ${line}`);
      printBlock(block);
    }
    return 1;
  }
  const textOf = (doc) => readFileSync(path.resolve(project.root, doc));
  if (found.length > 1) {
    console.error(`cannot undo "${id}": id "${id}" is on ${found.length} markers: ${found.map(place).join(', ')}; fix the repeat first`);
    for (const each of found) {
      console.error(place(each));
      refusalDetail(each, blockOf(textOf(each.doc).toString('utf8'), each));
    }
    return 1;
  }
  const [decision] = found;
  const { doc } = decision;
  const file = path.resolve(project.root, doc);
  // Wording compares and writes as text, so the doc must decode: a byte that is not UTF-8 would not survive.
  const bytes = textOf(doc);
  const before = bytes.toString('utf8');
  if (!Buffer.from(before, 'utf8').equals(bytes)) {
    console.error(`cannot undo "${id}" at ${place(decision)}: the doc is not valid UTF-8, so its wording cannot be matched`);
    refusalDetail(decision, blockOf(before, decision));
    return 1;
  }
  const out = undoDecision(before, id, commandConfig(project).decisions);
  if (out.refused) {
    console.error(`cannot undo "${id}" at ${place(decision)}: ${out.refused}`);
    refusalDetail(out.decision ?? decision, out.block);
    return 1;
  }
  // The same answer the main-checkout rule gives an edit of this doc, with its override and `allowWrites`.
  const denied = mainCheckoutDenial({ tool_name: 'Edit', tool_input: { file_path: file }, cwd: project.root });
  if (denied) {
    console.error(denied);
    return 1;
  }
  writeFileSync(file, out.text);
  logDecision(project, answerRow(decision, 'undo', decision.status));
  const count = (n) => `${n} line${n === 1 ? '' : 's'}`;
  const what = out.restored.length ? `replaced ${count(out.wrote.length)} with ${out.restored.length}` : `removed ${count(out.wrote.length)}`;
  console.log([`${doc}:${out.line}: undid ${id}: ${what}`, ...out.wrote.map((line) => `- ${line}`), ...out.restored.map((line) => `+ ${line}`)].join('\n'));
  return 0;
}

const questions = () => Object.keys(loadVocab().reversibility);

// The vocabulary `--vocab` prints: each class with its definition and whether it is a floor class, floor classes first,
// then `own`, the classes config.json `decisions.classes` adds at the base branch, which are never floor classes.
function vocabulary(own = {}) {
  const { classes, reversibility } = loadVocab();
  const added = Object.entries(own).map(([name, definition]) => [name, { floor: false, definition }]);
  return { classes: Object.fromEntries([...classes.map(({ class: name, floor, definition }) => [name, { floor, definition }]), ...added]), reversibility };
}

export const reversibleProblem = () => `--reversible takes up to ${questions().length} answers, each no or yes, separated by commas: ${questions().join(', ')}`;

// `--reversible` as { question: boolean }, with a question left out missing, or null when a word is neither no nor yes,
// or there are more words than questions. An absent `--reversible` answers nothing, so every question asks.
export function answers(value) {
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

// The `decisions` block in force, the commit it was read from, and whether that commit allows auto-merge:
// { decisions, base, autoMergeAllow }. The team's block is the base branch's, in the config folder the base branch names,
// so an uncommitted edit, or a commit on another branch, cannot raise an agent's authority. The exception: with no remote,
// a commit on the local main is the base, so it does. The machine's local file then goes over the block, held to its
// ceilings. commandConfig stops on an invalid config. Only with no git at all is the working copy the team's block.
// Inside git, `decisions` is null when git cannot give the base, so a stalled git never reads as a project with no rules.
function decisionsInForce(project) {
  const config = commandConfig(project);
  // With no base, no team has accepted merging without a person, whatever the working copy says.
  if (!insideGit(project.root)) return { decisions: config.decisions, base: null, autoMergeAllow: false };
  const base = baseTip(project);
  if (base === null) return { decisions: null, base, autoMergeAllow: false };
  try {
    const { decisions, autoMergeAllow } = committedAuthority(project, base, committedConfigFile(project, base));
    return { decisions: localDecisions(decisions, project, []), base, autoMergeAllow };
  } catch {
    return { decisions: null, base, autoMergeAllow: false };
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
