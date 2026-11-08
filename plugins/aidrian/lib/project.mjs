// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder, the git-ignored `.aidrian.local.json` that adds local knowledge sources,
// personal model choices, personal names, personal telemetry settings, personal decision settings, and the machine's
// auto-merge and product feedback choices, and the machine-local state folder outside the repository.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { loadConfig, pluginRepository } from './config.mjs';
import { insidePath, isDirectory, isFile, isObject, isWithin, joinedInside, readJson } from './fs.mjs';
import { checkoutRoots, mainRoot, runGit } from './git.mjs';

const DEFAULT_DIR = '.aidrian';
const OVERRIDE = '.aidrian.json';
const LOCAL = '.aidrian.local.json';
// The changed files that keep auto-merge off, in any case (lib/pr-auto-merge.mjs): what instructs an AI session, and
// what decides CI's verdict, and this plugin's own code that decides auto-merge, so the gate never approves a change to
// itself. Not configurable. Under plugins/aidrian/: bin/; the module each bin/ script starts (lib/cli.mjs,
// lib/knowledge-cli.mjs), `aidrian pr` (lib/pr.mjs), the gate, the review that writes its record, every hook that
// hooks.json runs, and every module and data file those load (test/auto-merge-guard.test.mjs walks them and fails on a
// load it cannot follow); the agents that review, as generated and as sources; the skills with every reference and step
// file they tell a session to read; the Codex install; and the plugin manifests. The modules behind the other `aidrian`
// subcommands, such as check.mjs, lint.mjs, worktree.mjs, and report-*.mjs, are not guarded.
// At the repository root: the marketplace manifests that install the plugin.
const GUARDED_LIB = [
  'agent-gates', 'agent-models', 'attribution', 'audit-import', 'audits', 'cli', 'code-words', 'config', 'config-committed', 'config-defaults',
  'config-guard', 'config-local', 'config-merge', 'config-schema', 'config-tracker', 'config-types', 'config-version',
  'decisions', 'dispatch-log', 'dispatch-rows', 'feedback-record', 'finding-disposition', 'foreground-dispatch', 'fs', 'gate-snapshot', 'git',
  'hook-deny', 'hook-io', 'jsonl', 'knowledge', 'knowledge-cli', 'lesson-inbox', 'lesson-signals', 'main-commits',
  'markdown-prose', 'markdown-sections', 'markdown-wrap', 'names', 'personas', 'pr', 'pr-auto-merge', 'pr-await-review',
  'pr-checks', 'pr-product-feedback', 'pr-resolve', 'project', 'review-gate', 'session-length', 'shell-lex',
  'stop-announce', 'terms', 'tracker-check', 'tracker-guard', 'transcript', 'usage',
].join('|');
const GUARDED_PLUGIN = String.raw`bin/|scripts/|hooks/|lib/(?:forges|rules|review|hosts|trackers)/|lib/(?:${GUARDED_LIB})\.(?:mjs|json)$|agents/|codex/|agents-src/|providers/|agent-addons/|skills/|(?:\.claude-plugin/)?plugin\.json$`;
export const GUARDED_PATHS = new RegExp(
  String.raw`(?:^|/)(?:AGENTS\.md|CLAUDE\.md|SKILL\.md|CODEOWNERS|\.aidrian\.json|\.aidrian\.local\.json)$` +
    String.raw`|^(?:\.claude|\.codex|\.aidrian|\.github/workflows|\.github/actions)(?:/|$)` +
    String.raw`|^(?:\.claude-plugin|\.agents/plugins)/marketplace\.json$` +
    `|^plugins/aidrian/(?:${GUARDED_PLUGIN})`,
  'iu',
);

// The files the gate reads its policy from, as names at any depth and in any case: config.json in a default project
// folder, the pointer file, the local switch, and the default project folder's own entry. pr-auto-merge.mjs refuses them
// even under `github.autoMerge.includeGuardedPaths`, so no pull request edits the policy that judges the next one; with
// the key off, GUARDED_PATHS decides. A folder `.aidrian.json` names is no fixed name, so the gate also refuses the exact
// paths it read on each branch (pr-auto-merge.mjs branchPolicies). Not configurable.
export const POLICY_PATHS = /(?:^|\/)(?:\.aidrian\/config\.json|\.aidrian\.json|\.aidrian\.local\.json|\.aidrian)$/iu;

// The project at or above `start`: the nearest folder that has `.aidrian.json` or `.aidrian/config.json`. Null when none.
// In a git checkout the search stops at its top folder, so a worktree whose branch has no project folder has no project,
// even inside a main checkout that has one. Outside git it goes on to the file-system root.
// Every hook starts here, some on every tool call: with no project folder above `start` it runs no git, and with one it
// runs git once, for the checkout's top folder and its main checkout together, and once more when the local auto-merge
// switch is on, to ask whether git tracks that file.
export function findProject(start) {
  const from = path.resolve(start);
  const found = nearestFolder(from);
  if (found === null) return null;
  let probe = from;
  while (!isDirectory(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const roots = checkoutRoots(probe);
  if (roots !== null) {
    for (let dir = from; ; dir = path.dirname(dir)) {
      if (outside(dir, roots.current)) return null;
      if (dir === found) break;
    }
  }
  return openProject(found, roots);
}

// The nearest folder at or above `dir` that has `.aidrian.json` or `.aidrian/config.json`, or null.
function nearestFolder(dir) {
  for (;;) {
    if (isFile(path.join(dir, OVERRIDE)) || isFile(path.join(dir, DEFAULT_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Whether `dir`, symlinks resolved, lies outside the folder `top`, which git reports with symlinks resolved. A folder
// that does not exist holds no project and is never outside: the search goes on to its parent.
function outside(dir, top) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    return false;
  }
  return !isWithin(top, real);
}

// What a command prints when no project is at or above `start`. In a linked git worktree whose main checkout has a
// project folder at the same place, the worktree was made before that folder reached its base branch, so `aidrian init`
// would be the wrong advice: the worktree needs remaking, or the default branch merged in.
export function noProjectMessage(start) {
  const where = `no project folder at or above ${start}`;
  const roots = checkoutRoots(start);
  if (roots && roots.main !== roots.current) {
    const main = findProject(path.join(roots.main, path.relative(roots.current, realPath(start))));
    if (main) {
      const branch = loadConfig(main).config.git.defaultBranch;
      return `${where}: this worktree was created before ${main.dir}/ was committed and pushed; recreate it or merge ${branch}`;
    }
  }
  return `${where}; run aidrian init`;
}

// The project at or above `start`, or one rooted at `start` that has no folder yet. For commands that work either way.
export function projectAt(start) {
  return findProject(start) ?? openProject(path.resolve(start));
}

// The project rooted at `root`, whether or not its folder exists yet:
// { root, dir, paths, sources, checkouts, localModels, localNames, localTelemetry, localAgents, localReview, localDecisions,
// localAutoMerge, localUnattendedWaiver, localReviewApprovals, localFeedbackAuto, errors, unreadable }.
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from:
// the project folder first, then each local source. `checkouts` is `root`, then, when it is in a git worktree, the same
// folder in the main checkout. `localModels`, `localNames`, `localTelemetry`, `localAgents`, `localReview`, and
// `localDecisions` are the `models`, `names`, `telemetry`, `agents`, `review`, and `decisions` values of
// `.aidrian.local.json`, as written; config.mjs checks them. `localAutoMerge`
// is its `github.autoMerge`: "on" or "off", checked here, "unset" when no file sets it, and "off" for a file with an error; the team's
// ceiling still decides (resolveAutoMerge). `localUnattendedWaiver` is its `github.unattendedWaiver`, read the same way,
// where "unset" is off: the team's `github.unattendedWaiver.allow` still decides (resolveUnattendedWaiver).
// `localReviewApprovals` is its `reviewApprovals`, read the same way: "on" or
// "off", "unset" when no file sets it; the team's `review.approvals.allow` still decides (lib/review/approvals.mjs).
// `localFeedbackAuto` is the main checkout's `review.productFeedback.auto`: true or false, or undefined when unset or
// unusable (mainFeedbackAuto), so the team's value holds. `errors` lists the problems in the root files; a broken
// `.aidrian.json` leaves the default folder in place, and a broken local source is left out.
// `unreadable` names each of `.aidrian.json` and `.aidrian.local.json` that is there but whose settings are not in force,
// because it could not be read or names no usable folder: from `root`, or absolute when it is in the main checkout.
// `roots` is git's checkoutRoots for a folder in the same checkout, when the caller already asked; null outside git.
export function openProject(root, roots) {
  const errors = [];
  const unreadable = [];
  const dir = folderDir(root, errors, unreadable);
  const paths = { config: `${dir}/config.json`, knowledge: `${dir}/knowledge`, local: LOCAL };
  const checkouts = checkoutsOf(root, roots);
  const local = readLocal(checkouts, errors, unreadable);
  const sources = [{ label: dir, base: root, index: paths.knowledge, local: false }, ...local.sources];
  return {
    root,
    dir,
    paths,
    sources,
    checkouts,
    localModels: local.models,
    localNames: local.names,
    localTelemetry: local.telemetry,
    localAgents: local.agents,
    localReview: local.review,
    localDecisions: local.decisions,
    localAutoMerge: local.autoMerge,
    localUnattendedWaiver: local.unattendedWaiver,
    localReviewApprovals: local.reviewApprovals,
    localFeedbackAuto: local.feedbackAuto,
    errors,
    unreadable,
  };
}

// Every file that sets the project's configuration, as an absolute path, whether or not it exists yet, in each of its
// checkouts: `.aidrian.json`, config.json in the project folder and in the default one, which a missing `.aidrian.json`
// falls back to, and `.aidrian.local.json`.
export function configFiles(project) {
  const names = [OVERRIDE, project.paths.config, `${DEFAULT_DIR}/config.json`, LOCAL];
  return [...new Set(project.checkouts.flatMap((base) => names.map((name) => path.join(base, name))))];
}

// The config.json path, from the project root, that `commit` names through its own `.aidrian.json`, or the default
// folder's when that commit has none; null when its `.aidrian.json` cannot be read or names no usable folder. What a
// working copy's `.aidrian.json` says, committed later or never, cannot move a lookup at the base branch. Throws when
// git itself fails, stopped by a timeout or the like. 128 is git saying the commit has no such file.
export function committedConfigFile(project, commit, options) {
  const shown = runGit(['show', `${commit}:./${OVERRIDE}`], project.root, options);
  if (shown.status === 128) return `${DEFAULT_DIR}/config.json`;
  if (shown.status !== 0) throw new Error(`git show ${commit}:./${OVERRIDE} failed`);
  let raw;
  try {
    raw = JSON.parse(shown.stdout);
  } catch {
    return null;
  }
  // The commit's own text, with no read of this disk: what the working tree holds at that name cannot change the answer.
  const dir = joinedInside('', raw?.dir);
  return dir ? `${dir}/config.json` : null;
}

// The config path, from the repository top, that the `.aidrian.json` at `<ref>:<prefix>` names, or null when the ref holds
// none or it names no folder inside the project. Read from the ref alone, for a project the working tree no longer has.
export function relocatedConfigAt(ref, prefix, cwd) {
  const shown = runGit(['show', `${ref}:${prefix}${OVERRIDE}`], cwd);
  if (shown.status !== 0) return null;
  try {
    const dir = joinedInside('', JSON.parse(shown.stdout)?.dir);
    return dir ? `${prefix}${dir}/config.json` : null;
  } catch {
    return null;
  }
}

function folderDir(root, errors, unreadable) {
  if (!isFile(path.join(root, OVERRIDE))) return DEFAULT_DIR;
  const raw = readJson(root, OVERRIDE, errors);
  if (!raw) {
    unreadable.push(OVERRIDE);
    return DEFAULT_DIR;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'dir') errors.push(`${OVERRIDE}: unknown key "${key}"`);
  }
  const dir = insidePath(root, '', raw.dir);
  if (dir) return dir;
  errors.push(`${OVERRIDE}: "dir" must be a relative folder inside the project`);
  unreadable.push(OVERRIDE);
  return DEFAULT_DIR;
}

// The path of config.json in a tree that is not checked out, such as a base branch read through GitHub. `read(file)`
// returns the text of `file` at the tree's root, or null when the tree has none, and may throw. As openProject does, a
// missing or broken `.aidrian.json` keeps the default folder; the working copy's `.aidrian.json` is never read.
export function configPathIn(read) {
  const text = read(OVERRIDE);
  let raw = null;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {}
  return `${(isObject(raw) ? joinedInside('', raw.dir) : null) ?? DEFAULT_DIR}/config.json`;
}

// configPathIn for a reader that must not fall back to the default folder: an `.aidrian.json` that is there but does not
// parse, names no usable folder, or names one with no config.json throws. No `.aidrian.json` is still the default folder.
export function strictConfigPathIn(read) {
  const text = read(OVERRIDE);
  if (text === null) return `${DEFAULT_DIR}/config.json`;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${OVERRIDE}: invalid JSON (${error.message})`);
  }
  const dir = isObject(raw) ? joinedInside('', raw.dir) : null;
  if (!dir) throw new Error(`${OVERRIDE}: "dir" must be a relative folder inside the project`);
  const file = `${dir}/config.json`;
  if (read(file) === null) throw new Error(`${OVERRIDE}: it names ${dir}, which holds no config.json`);
  return file;
}

// `root`, then, when it is in a git worktree, the same folder in the main checkout.
function checkoutsOf(root, roots) {
  const main = inMainCheckout(root, roots);
  return main && main !== realpathSync(root) ? [root, main] : [root];
}

const LOCAL_KEYS = ['sources', 'models', 'names', 'telemetry', 'agents', 'review', 'decisions', 'github', 'reviewApprovals'];

// `.aidrian.local.json`: { sources, models, names, telemetry, agents, review, decisions, autoMerge, unattendedWaiver, reviewApprovals, feedbackAuto }. A git worktree has no copy of that git-ignored
// file, so it is read from the main checkout then: from the first of `checkouts` that has it. Each source is a folder with
// its own knowledge/ and, optionally, a config.json with `version`. `decisions`, the machine switches (auto-merge, the
// unattended waiver, and review approvals), and `review.productFeedback.auto` come only from the main checkout's file
// (checkouts.at(-1)): a copy a session writes in its own worktree raises nothing, lowers nothing, and never turns merging on.
// Behind such a copy, the main checkout's file gets every check it gets when it is the one loaded, and its errors are
// reported, so a worktree's copy hides none of them.
function readLocal(checkouts, errors, unreadable) {
  const none = { sources: [], models: undefined, names: undefined, telemetry: undefined, agents: undefined, autoMerge: 'unset', unattendedWaiver: 'unset', reviewApprovals: 'unset' };
  const holder = checkouts.find((dir) => isFile(path.join(dir, LOCAL)));
  if (!holder) return none;
  const main = checkouts.at(-1);
  const raw = readJson(holder, LOCAL, errors);
  const own = raw && checkedLocal(raw, holder);
  if (own) errors.push(...own.problems);
  else unreadable.push(holder === checkouts[0] ? LOCAL : path.join(holder, LOCAL));
  const mainFile = holder === main ? own : mainLocal(main, errors);
  const switches = machineSwitches(mainFile, main, errors);
  const feedbackAuto = mainFeedbackAuto(mainFile?.raw, main, errors);
  if (!own) return { ...none, ...switches, feedbackAuto };
  const { models, names, telemetry, agents, review } = raw;
  return { sources: own.sources, models, names, telemetry, agents, review, decisions: mainFile?.raw.decisions, ...switches, feedbackAuto };
}

// Every check of the local file `raw`, read from `dir`, whichever checkout it is in: { raw, sources, autoMerge,
// unattendedWaiver, reviewApprovals, problems }, with each switch as the file sets it and `problems` every error in it.
function checkedLocal(raw, dir) {
  const problems = [];
  for (const key of Object.keys(raw)) {
    if (!LOCAL_KEYS.includes(key)) problems.push(`${LOCAL}: unknown key "${key}"`);
  }
  const sources = localSources(dir, raw, problems);
  const autoMerge = localAutoMerge(raw, problems);
  const unattendedWaiver = localUnattendedWaiver(raw);
  const reviewApprovals = localReviewApprovals(raw, problems);
  return { raw, sources, autoMerge, unattendedWaiver, reviewApprovals, problems };
}

// The main checkout's local file behind a worktree's own copy, through checkedLocal: undefined when there is none, null
// when it cannot be read. Its errors are added to `errors`, as they are when it is the file loaded.
function mainLocal(main, errors) {
  if (!isFile(path.join(main, LOCAL))) return undefined;
  const raw = readJson(main, LOCAL, errors);
  if (!raw) return null;
  const file = checkedLocal(raw, main);
  errors.push(...file.problems);
  return file;
}

// This machine's switches, from the main checkout's file as checkedLocal read it: each "unset" when there is no file,
// and "off" when it cannot be read. An error anywhere in the file, a tracked-file one too, reads an unset auto-merge
// "off", so it never follows a team default of "on", and the waiver "off" though it says "on": a wrong local file never
// turns merging on, nor lets a verdict stand in for the Human.
function machineSwitches(file, main, errors) {
  if (file === undefined) return { autoMerge: 'unset', unattendedWaiver: 'unset', reviewApprovals: 'unset' };
  if (!file) return { autoMerge: 'off', unattendedWaiver: 'off', reviewApprovals: 'off' };
  const tracked = [];
  const autoMerge = untrackedSwitch(file.autoMerge, 'github.autoMerge', main, tracked);
  const unattendedWaiver = untrackedSwitch(file.unattendedWaiver, 'github.unattendedWaiver', main, tracked);
  const reviewApprovals = untrackedSwitch(file.reviewApprovals, 'reviewApprovals', main, tracked);
  errors.push(...tracked);
  const broken = file.problems.length > 0 || tracked.length > 0;
  return { autoMerge: broken && autoMerge === 'unset' ? 'off' : autoMerge, unattendedWaiver: broken ? 'off' : unattendedWaiver, reviewApprovals };
}

// A switch `value` the local file in `main` sets, named `key` in its errors. A local file git tracks travels with a
// branch, so it is no machine's own switch. Only git's answer "untracked" (exit 1) keeps it on: tracked under any case, a
// git that fails or stalls, or no repository at all reads "off". Asked only when the switch is on, so a hook pays no git
// call for a file that keeps it off.
function untrackedSwitch(value, key, main, errors) {
  if (value !== 'on') return value;
  const { status } = runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main);
  if (status === 0) errors.push(`${LOCAL}: git tracks it, so a branch could carry it; "${key}" reads "off" until it is untracked (git rm --cached ${LOCAL})`);
  else if (status !== 1) errors.push(`${LOCAL}: git could not say whether it tracks it, so "${key}" reads "off"`);
  return status === 1 ? 'on' : 'off';
}

// This machine's `review.productFeedback.auto`: the main checkout's. `raw` is that file, undefined when there is none or
// it could not be read. Unset, a value that is no boolean, a broken file, and no file all read as undefined, so the
// team's value holds, never false. A file git tracks travels with a branch, so it is no machine's own: only git's answer
// "untracked" (exit 1) keeps the value. Asked only when a value is set, so a hook pays no git call for a file with none.
function mainFeedbackAuto(raw, main, errors) {
  const auto = raw?.review?.productFeedback?.auto;
  if (typeof auto !== 'boolean') return undefined;
  const { status } = runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main);
  if (status === 1) return auto;
  errors.push(status === 0
    ? `${LOCAL}: git tracks it, so a branch could carry it; "review.productFeedback.auto" is ignored until it is untracked (git rm --cached ${LOCAL})`
    : `${LOCAL}: git could not say whether it tracks it, so "review.productFeedback.auto" is ignored`);
  return undefined;
}

// Whether a machine with no setting may follow a team default of "on": git says it tracks no local file in the main
// checkout, under any case, present on disk or not. Asked only when the default applies, so a hook pays no git call. A tracked file, or a git that fails
// or stalls, is no machine's own, as machineSwitch reads it.
export function mayFollowTeamDefault(project) {
  const main = project.checkouts.at(-1);
  return runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main).status === 1;
}

// The machine settings of the local file's `github` group, the only keys it takes: { autoMerge, unattendedWaiver, problems }.
// Each is `{ "enabled": true | false }`, the shape of the team's key, or the older "on" and "off", and reads "on", "off",
// or "unset". The team sets the strategy, the cleanup, the default, and both ceilings in config.json, and no machine can
// change them. `problems` lists every error in the group; both readers below read "off" when there is any, so a wrong
// local file never turns merging on, nor lets a verdict stand in for the Human.
const MACHINE_GITHUB = Object.freeze(['autoMerge', 'unattendedWaiver']);
function githubGroup(raw) {
  const none = { autoMerge: 'unset', unattendedWaiver: 'unset', problems: [] };
  if (!Object.hasOwn(raw, 'github')) return none;
  if (!isObject(raw.github)) return { ...none, problems: [`${LOCAL}: "github" must be an object`] };
  const problems = [];
  for (const key of Object.keys(raw.github)) {
    if (!MACHINE_GITHUB.includes(key)) problems.push(`${LOCAL}: unknown key "github.${key}"; only "github.autoMerge" and "github.unattendedWaiver" are machine settings`);
  }
  const read = (key) => {
    if (!Object.hasOwn(raw.github, key)) return 'unset';
    const given = raw.github[key];
    const value = isObject(given) && Object.keys(given).length === 1 && typeof given.enabled === 'boolean' ? (given.enabled ? 'on' : 'off') : given;
    if (value === 'on' || value === 'off') return value;
    problems.push(`${LOCAL}: "github.${key}" must be { "enabled": true } or { "enabled": false }`);
    return 'off';
  };
  const autoMerge = read('autoMerge');
  return { autoMerge, unattendedWaiver: read('unattendedWaiver'), problems };
}

// The local file's `github.autoMerge`: githubGroup's, adding the group's errors, and "off" when it has any. Unset follows
// the team's default.
function localAutoMerge(raw, errors) {
  const { autoMerge, problems } = githubGroup(raw);
  errors.push(...problems);
  return problems.length ? 'off' : autoMerge;
}

// The local file's `github.unattendedWaiver`: githubGroup's, "off" when the group has any error. It adds none, since
// localAutoMerge reports the group's errors once. Unset is off: the waiver has no team default.
function localUnattendedWaiver(raw) {
  const { unattendedWaiver, problems } = githubGroup(raw);
  return problems.length ? 'off' : unattendedWaiver;
}

// The local file's `reviewApprovals` as "on", "off", or "unset": whether this machine lets a named approver's review on
// the forge close an invariant no reviewer could verify, when the team's `review.approvals.allow` is true. Anything but
// "on" or "off" is an error and reads "off".
function localReviewApprovals(raw, errors) {
  if (!Object.hasOwn(raw, 'reviewApprovals')) return 'unset';
  if (raw.reviewApprovals === 'on' || raw.reviewApprovals === 'off') return raw.reviewApprovals;
  errors.push(`${LOCAL}: "reviewApprovals" must be "on" or "off"`);
  return 'off';
}

function localSources(holder, raw, errors) {
  if (!Object.hasOwn(raw, 'sources')) return [];
  if (!Array.isArray(raw.sources) || !raw.sources.every((each) => typeof each === 'string' && each.trim() !== '')) {
    errors.push(`${LOCAL}: "sources" must be a list of folders`);
    return [];
  }
  const sources = [];
  for (const label of raw.sources) {
    const base = path.resolve(holder, label.replace(/^~(?=$|\/)/, homedir()));
    if (isDirectory(base)) sources.push({ label, base, index: 'knowledge', local: true });
    else errors.push(`${LOCAL}: source ${JSON.stringify(label)} is not a folder`);
  }
  return sources;
}

// The same folder in the main checkout, when `root` is inside a git worktree; null outside git. At most one git call,
// none when the caller passes the `roots` it already has: this runs on every hook that reads the project.
function inMainCheckout(root, roots = checkoutRoots(root)) {
  return roots ? path.join(roots.main, path.relative(roots.current, realpathSync(root))) : null;
}

// The machine-local state folder: plans, handoffs, the lesson inbox, and the dispatch log.
// `$XDG_STATE_HOME/aidrian/projects/<project id>/`, with `~/.local/state` when that variable is unset or relative, so
// git never sees it and every worktree and clone of a repository shares it. config.json `state.dir` moves it.
export function stateDir(project, { config = loadConfig(project).config, env = process.env } = {}) {
  if (config.state.dir) return localPath(project, config.state.dir);
  return path.join(stateRoot(env), 'projects', projectId(project));
}

// `$XDG_STATE_HOME/aidrian`, with `~/.local/state` when that variable is unset or relative: the folder that holds every
// project's state folder, and what no config.json can move (lib/gate-snapshot.mjs keeps its files there).
export function stateRoot(env = process.env) {
  const base = path.isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : path.join(homedir(), '.local/state');
  return path.join(base, 'aidrian');
}

// Task worktrees: config.json `git.worktrees.dir`, `.worktrees` at the repository root by default.
export function worktreesDir(project, { config = loadConfig(project).config } = {}) {
  return localPath(project, config.git.worktrees.dir);
}

// The main checkout's top folder, which every worktree shares; the project root outside git.
export function repoRoot(project) {
  return mainRoot(project.root) ?? project.root;
}

// `<repository name>-<8 hex digits>`: the name and a hash of the normalized `origin` URL, so every clone agrees.
// Without an origin, the main checkout's folder name and absolute path. A project below the repository root adds its
// path from that root to the hash, so two projects in one repository keep apart; a project at the root keeps its id.
export function projectId(project) {
  const { status, stdout } = runGit(['config', '--get', 'remote.origin.url'], project.root);
  const repository = (status === 0 && normalizeRemote(stdout)) || realPath(repoRoot(project));
  const prefix = runGit(['rev-parse', '--show-prefix'], project.root);
  const below = prefix.status === 0 ? prefix.stdout.replace(/\/?\n$/u, '') : '';
  return repositoryId(repository, below);
}

// The id of the project at `below` (empty at the root) in the repository `repository`, a normalized remote or a path.
function repositoryId(repository, below = '') {
  const key = below ? `${repository}\0${below}` : repository;
  const slug = path.posix.basename(repository).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
}

// The project id of the plugin's own repository, the `repository` in its manifest: what projectId gives in any clone of
// it, so every project on a machine finds the plugin's state folder without a checkout. Null when the manifest names none.
let pluginId;
export function pluginProjectId() {
  if (pluginId === undefined) {
    const repository = pluginRepository();
    pluginId = repository ? repositoryId(normalizeRemote(repository)) : null;
  }
  return pluginId;
}

// One spelling per remote: `git@host:owner/repo.git`, `ssh://git@host:22/owner/repo`, and `https://host/owner/repo/`
// all become `host/owner/repo`.
export function normalizeRemote(url) {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(\d+\/)?/, '$1/')
    .replace(/(\.git)?\/*$/, '')
    .replace(/^[^/]+/, (host) => host.toLowerCase());
}

// A configured local path: a leading `~` is the home folder, and a relative path starts at the repository root.
function localPath(project, value) {
  if (/^~(?=$|\/)/.test(value)) return path.join(homedir(), value.slice(1));
  return path.resolve(repoRoot(project), value);
}

function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
