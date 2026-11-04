// `aidrian decisions resolve`: who settles one decision, the agent or the Human (lib/decisions.mjs).
//
//   aidrian decisions resolve --domain ux --class copy --reversible no,no,no,no
//   aidrian decisions resolve --vocab            # every class and reversibility question, defined
//
// `--reversible` answers the questions of decisions.json in its order: storedData, external, pricingOrContract,
// visibleBeforeReview. An answer left out asks. `--doc` names a doc, with an optional `#section`: from the current folder
// and, when relative, from the project root too.
// Output: { authority, rule, reason, base }, where `base` is the commit whose config was read, or null when none was.
// Exit 0 on either answer; 1 on bad arguments or an invalid config. docs/config.md#decisions has the rules.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, committedDecisions, DEFAULTS, localDecisions } from './config.mjs';
import { loadVocab, resolveAuthority } from './decisions.mjs';
import { checkoutRoots, runGit } from './git.mjs';
import { committedConfigFile, projectAt } from './project.mjs';
import { usageLines } from './usage.mjs';

const USAGE = 'resolve --domain D --class C [--reversible A,B,C,D] [--doc PATH]... [--project DIR] | resolve --vocab';
const ANSWERS = { no: false, yes: true };

export const commands = {
  decisions: {
    usage: USAGE,
    about: 'say whether an agent may settle one decision or must ask the Human, from config.json `decisions` at the base branch, with A,B,C,D the four reversibility answers, each no or yes; or print the decision classes',
    run(args) {
      const [action, ...rest] = args;
      if (action !== 'resolve') return fail(`decisions takes resolve${action ? `, not "${action}"` : ''}`);
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
        : resolveAuthority({ decisions }, { domain: values.domain, class: values.class, reversible, docs });
      console.log(JSON.stringify({ ...out, base }));
      return 0;
    },
  },
};

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
// when relative, from the project root, the spelling config.json uses, unless that climbs out of it. resolveAuthority
// asks when either reading is covered, and for a path outside the project, which starts with `../`.
function docReadings(project, doc) {
  const at = doc.indexOf('#');
  const [file, section] = at === -1 ? [doc, ''] : [doc.slice(0, at), doc.slice(at)];
  const root = real(project.root);
  const fromRoot = (absolute) => `${path.relative(root, real(absolute)).replaceAll(path.sep, '/') || '.'}${section}`;
  const readings = [fromRoot(path.resolve(file))];
  const climbs = path.normalize(file).split(path.sep)[0] === '..';
  if (!path.isAbsolute(file) && !climbs) readings.push(fromRoot(path.join(root, file)));
  return [...new Set(readings)];
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
// branch's, in the config folder the base branch names, so an edit to the working copy, committed or not, cannot raise
// an agent's authority; the machine's local file then goes over it, held to that block's ceilings. commandConfig stops
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
// name on origin. A branch that names itself in config.json `git.defaultBranch` is not its own base. With no origin
// remote, a local branch of that name is the only record of the base; with one, a local branch can hold commits no one
// reviewed, so it never stands in. null when none resolves, or when git fails on one, whose answer the next ref must
// not replace: for rev-parse, 1 is git saying no such ref; for get-url, 2 is git saying no such remote.
function baseTip(project) {
  const branch = DEFAULTS.git.defaultBranch;
  const tipOf = (ref) => runGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], project.root);
  for (const ref of ['refs/remotes/origin/HEAD', `refs/remotes/origin/${branch}`]) {
    const tip = tipOf(ref);
    if (tip.status === 0) return tip.stdout.trim();
    if (tip.status !== 1) return null;
  }
  if (runGit(['remote', 'get-url', 'origin'], project.root).status !== 2) return null;
  const local = tipOf(`refs/heads/${branch}`);
  return local.status === 0 ? local.stdout.trim() : null;
}

function fail(problem) {
  console.error(`${usageLines('decisions', USAGE).map((line, i) => (i ? `       ${line}` : `usage: ${line}`)).join('\n')}\n\n${problem}`);
  return 1;
}
