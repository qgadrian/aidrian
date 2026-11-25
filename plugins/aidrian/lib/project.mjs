// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder, the git-ignored `.aidrian.local.json` that adds local knowledge sources,
// personal model choices, personal names, personal telemetry settings, personal decision settings, and the machine's
// auto-merge, background handoff, and product feedback choices, and the machine-local state folder outside the repository.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import path from 'node:path';

import { anchorReaders } from './attempt-clone.mjs';
import { loadConfig, pluginRepository } from './config.mjs';
import { localForgeTokenKeychain, splitUnknownKeys } from './config-local.mjs';
import { insidePath, isDirectory, isFile, isObject, isWithin, joinedInside, knownFields, quoteName, readJson } from './fs.mjs';
import { checkoutRoots, mainRoot, readOriginUrl, readPrefix, readRemoteUrls, repositoryCheckouts, runGit } from './git.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { readUnattendedMark } from './unattended-mark.mjs';

// The readers an attempt clone's link is anchored with (lib/attempt-clone.mjs): the session the host names, its
// unattended mark, and the state folders the project at a main checkout names, its state.dir as the environment and as
// the user's own home resolve it. Given here, where every command and hook loads them, so attempt-clone.mjs, which
// lib/git.mjs loads, imports no local module. Each is called only when a link is read, never on load.
anchorReaders({
  sessionOf: (env) => sessionIdentity(env).session,
  readMark: (session, options) => readUnattendedMark(session, options),
  namedStates(main, { env, home } = {}) {
    const project = findProject(main);
    if (!project) return [];
    const reads = [() => stateDir(project, { env }), () => defaultStateDir(project, home ? { home } : {})];
    return reads.flatMap((read) => {
      try {
        return [read()];
      } catch {
        return [];
      }
    });
  },
});

const DEFAULT_DIR = '.aidrian';
const OVERRIDE = '.aidrian.json';
// The machine's own git-ignored settings file, which other modules name through LOCAL_FILE.
const LOCAL = '.aidrian.local.json';
export const LOCAL_FILE = LOCAL;
// config.json in the default project folder, where a checkout looks when its `.aidrian.json` names no usable folder.
export const DEFAULT_CONFIG = `${DEFAULT_DIR}/config.json`;
// A git read with runGit's own options.
const defaultRead = () => undefined;
// The changed files that keep auto-merge off, in any case (lib/pr-auto-merge.mjs): what instructs an AI session, and
// what decides CI's verdict, and this plugin's own code that decides auto-merge, so the gate never approves a change to
// itself. Not configurable. What instructs an AI session is every host's, not one host's: HOST_NAMES and HOST_PATHS.
// The knowledge docs the start hook loads differ per project, so the gate reads them from the default branch beside this
// list (pr-auto-merge.mjs startDocs). Under plugins/aidrian/: bin/; the module each bin/ script starts (lib/cli.mjs,
// lib/knowledge-cli.mjs), `aidrian pr` (lib/pr.mjs), the gate, the review that writes its record, every hook that
// hooks.json runs, and every module and data file those load (test/auto-merge-guard.test.mjs walks them and fails on a
// load it cannot follow); the agents that review, as generated and as sources; the skills with every reference and step
// file they tell a session to read; the Codex install; the OpenCode bridge (opencode/) and the package manifest that
// names it (package.json, at the plugin folder's top only); and the plugin manifests. The modules behind the other `aidrian`
// subcommands, such as check.mjs, lint.mjs, worktree.mjs, and report-*.mjs, are not guarded, except project-run.mjs,
// project-run-cli.mjs, project-run-gate.mjs, project-run-guard.mjs, project-recheck.mjs, and project-stops.mjs: they decide
// which session may start a project run, which issue it starts, which session records its result, when a halt lifts,
// and what an issue whose merge stopped does, so a pull request that auto-merged itself cannot change them.
// At the repository root: the marketplace manifests that install the plugin, and the optional `aidrian-mod`
// plugin's folder, `plugins/aidrian-claude-mod/`, whole, since it picks and runs the aidrian binary.
const GUARDED_LIB = [
  'agent-gates', 'agent-models', 'attempt-clone', 'attribution', 'audit-import', 'audits', 'banned-terms', 'bounded-regexp', 'check-runs',
  'child-send-backs', 'clean-text', 'cli', 'closing-words', 'code-words', 'config', 'config-committed', 'config-defaults', 'config-guard',
  'config-local', 'config-merge', 'config-schema', 'config-tracker', 'config-types', 'config-version', 'confine-guard', 'deadline', 'decisions',
  'delivery-check', 'dispatch-log', 'dispatch-rows', 'feedback-record', 'finding-disposition', 'foreground-dispatch', 'fs', 'gate-snapshot', 'git',
  'git-push', 'glob-links', 'handoff-continue', 'handoff-guard', 'handoff-markers', 'handoff-sections', 'hidden-text', 'hook-deny', 'hook-io', 'hook-result', 'issue-forge-guard', 'issue-push-checkout',
  'jsonl', 'knowledge', 'knowledge-cli', 'lesson-inbox', 'lesson-signals', 'main-commits', 'markdown-prose', 'markdown-sections', 'markdown-wrap',
  'model-prices', 'names', 'override-guard', 'package-runner', 'personas', 'pr', 'pr-auto-merge', 'pr-auto-merge-docs', 'pr-await-review', 'pr-checks', 'pr-diff', 'pr-product-feedback',
  'pr-ready-wait', 'pr-resolve', 'project', 'project-confine', 'project-decision', 'project-decision-store', 'project-forge-holds', 'project-full-auto', 'project-human-merges', 'project-issue-text', 'project-limit', 'project-linger', 'project-preflight', 'project-recheck', 'project-registries', 'project-report',
  'project-result', 'project-run', 'project-run-cli', 'project-run-gate', 'project-run-guard', 'project-start', 'project-stops', 'project-token', 'project-trust', 'push-preflight',
  'remotes', 'resume-tokens', 'review-gate', 'run-driver', 'session-folder', 'session-length', 'session-links', 'session-links-writer', 'session-origins',
  'session-prs', 'session-rows', 'session-start-gate', 'shell-init', 'shell-lex', 'solo', 'stop-announce', 'stop-handback', 'stop-history', 'stop-review-loop',
  'terminal-replace', 'terms', 'test-changed', 'tracker-check', 'tracker-guard', 'transcript', 'transcript-guard', 'unattended-mark', 'unattended-shell',
  'unattended-write', 'usage', 'worktree',
].join('|');
const GUARDED_PLUGIN = String.raw`bin/|scripts/|hooks/|lib/(?:forges|rules|review|hosts|trackers)/|lib/(?:${GUARDED_LIB})\.(?:mjs|json)$|agents/|codex/|agents-src/|providers/|agent-addons/|skills/|opencode/|package\.json$|(?:\.claude-plugin/)?plugin\.json$`;
// The instruction files AI hosts read by name, at any depth and in any case: AGENTS.md, CLAUDE.md, and GEMINI.md, with
// any infix, such as AGENTS.override.md, which Codex reads first, or CLAUDE.local.md; and AGENT.md, QWEN.md, WARP.md,
// CRUSH.md, and CONVENTIONS.md.
const HOST_NAMES = String.raw`(?:AGENTS?|CLAUDE|GEMINI|QWEN|WARP|CRUSH|CONVENTIONS)(?:\.[^/]+)?\.md`;
// The instruction files and folders AI hosts read by path: Cursor's, Cline's, Windsurf's, and OpenCode's, its `.agents`
// skills folder included, at any depth, since they read nested ones or may; GitHub Copilot's at the repository root or
// the project root.
const HOST_PATHS = String.raw`(?:^|/)(?:\.cursor|\.windsurf|\.clinerules|\.opencode|\.agents)(?:/|$)|(?:^|/)(?:\.cursorrules|\.windsurfrules)$` +
  String.raw`|^\.github/copilot-instructions\.md$|^\.github/instructions(?:/|$)`;
export const GUARDED_PATHS = new RegExp(
  String.raw`(?:^|/)(?:${HOST_NAMES}|SKILL\.md|CODEOWNERS|opencode\.jsonc?|\.aidrian\.json|\.aidrian\.local\.json|\.banned-terms\.local)$` +
    `|${HOST_PATHS}` +
    // A `.claude` folder at any depth, which Claude Code reads in a nested project too; the others at the root.
    String.raw`|(?:^|/)\.claude(?:/|$)|^(?:\.codex|\.aidrian|\.github/workflows|\.github/actions)(?:/|$)` +
    String.raw`|^(?:\.claude-plugin|\.agents/plugins)/marketplace\.json$` +
    `|^plugins/aidrian/(?:${GUARDED_PLUGIN})` +
    String.raw`|^plugins/aidrian-claude-mod/`,
  'iu',
);

// The paths, from the top of the repository, a review trail reads each branch's policy files at for the project folder
// `prefix` (the forge's reviewTrail `paths`): the pointer file, the default folder's config.json, and its knowledge folder.
export const trailPaths = (prefix = '') => ({ pointer: `${prefix}${OVERRIDE}`, config: `${prefix}${DEFAULT_DIR}/config.json`, knowledge: `${prefix}${DEFAULT_DIR}/knowledge` });
// Guarded only in the plugin's own repository (isPluginRepository), from its root: the release script, which runs in the
// release job that holds the write token. Another project's file at that path is its own, and stays unguarded.
export const PLUGIN_REPOSITORY_PATHS = /^scripts\/version\.mjs$/iu;

// The knowledge index folder beside a config.json path, such as one configPathIn located: `<folder>/knowledge`, with the
// same prefix, as openProject's `paths.knowledge` is.
export const knowledgeIn = (configFile) => `${path.posix.dirname(configFile)}/knowledge`;

// The files the gate reads its policy from, as names at any depth and in any case: config.json in a default project
// folder, the pointer file, the local switch, and the default project folder's own entry. pr-auto-merge.mjs refuses them
// even under `github.autoMerge.includeGuardedPaths`, so no pull request edits the policy that judges the next one, unless
// `github.autoMerge.includePolicyFiles` counts too, the team's acceptance of that risk on both branches; with the first
// key off, GUARDED_PATHS decides. A folder `.aidrian.json` names is no fixed name, so the gate also refuses the exact
// paths it read on each branch (pr-auto-merge.mjs branchPolicies). Not configurable.
export const POLICY_PATHS = /(?:^|\/)(?:\.aidrian\/config\.json|\.aidrian\.json|\.aidrian\.local\.json|\.aidrian)$/iu;

// Whether `file`, from the top of the repository, is a policy file: a POLICY_PATHS name, or one of `policyFiles`, the
// paths pr-auto-merge.mjs branchPolicies read the gate's policy from, as a config.json a pointer file relocates, in any
// case, as the auto-merge gate matches them.
export const isPolicyPath = (file, policyFiles = []) => POLICY_PATHS.test(file) || policyFiles.some((each) => typeof each === 'string' && each.toLowerCase() === file.toLowerCase());

// The project at or above `start`: the nearest folder that has `.aidrian.json` or `.aidrian/config.json`. Null when none.
// In a git checkout the search stops at its top folder, so a worktree whose branch has no project folder has no project,
// even inside a main checkout that has one. Outside git it goes on to the file-system root.
// Every hook starts here, some on every tool call: with no project folder above `start` it runs no git, and with one it
// runs git once, for the checkout's top folder and its main checkout together, and once more when the local auto-merge
// switch is on, to ask whether git tracks that file. `read`, when given, gives the options of each of those reads, as
// stateDir's does, for a caller under a deadline.
export function findProject(start, read) {
  const from = path.resolve(start);
  const found = nearestFolder(from);
  if (found === null) return null;
  let probe = from;
  while (!isDirectory(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const roots = checkoutRoots(probe, typeof read === 'function' ? read() : undefined);
  if (roots !== null) {
    for (let dir = from; ; dir = path.dirname(dir)) {
      if (outside(dir, roots.current)) return null;
      if (dir === found) break;
    }
  }
  return openProject(found, roots, read);
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
// localAutoMerge, localUnattendedWaiver, localReviewApprovals, localHandoffBackground, localFeedbackAuto,
// localForgeTokenKeychain, errors, warnings, unreadable }.
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from:
// the project folder first, then each local source. `checkouts` is `root`, then, when it is in a git worktree, the same
// folder in the main checkout. `localModels`, `localNames`, `localTelemetry`, `localAgents`, `localReview`, and
// `localDecisions` are the `models`, `names`, `telemetry`, `agents`, `review`, and `decisions` values of
// `.aidrian.local.json`, as written; config.mjs checks them. `localAutoMerge`
// is its `github.autoMerge`: "on" or "off", checked here, "unset" when no file sets it, and "off" for a file with an error; the team's
// ceiling still decides (resolveAutoMerge). `localUnattendedWaiver` is its `github.unattendedWaiver`, read the same way,
// where "unset" is off unless the base branch's `solo` turns it on (config-local.mjs machineSwitch): the team's
// `github.unattendedWaiver.allow` still decides (resolveUnattendedWaiver). `localUnattendedSignoff` and
// `localHandoffBackground` follow `solo` the same way when unset.
// `localReviewApprovals` is its `reviewApprovals`, read the same way: "on" or
// "off", "unset" when no file sets it; the team's `review.approvals.allow` still decides (lib/review/approvals.mjs).
// `localHandoffBackground` is its `handoff.background`, read the same way; the base branch's session.handoff still
// decides (lib/handoff-continue.mjs backgroundGate).
// `localFeedbackAuto` is the main checkout's `review.productFeedback.auto`: true or false, or undefined when unset or
// unusable (mainFeedbackAuto), so the team's value holds. `localForgeTokenKeychain` is the main checkout's
// `projectRun.forgeTokenKeychain`, `{ service, account }`, or null (config-local.mjs localForgeTokenKeychain, mainKeychain). `errors` lists the problems in the root files; a broken
// `.aidrian.json` leaves the default folder in place, and a broken local source is left out. `warnings` lists each key
// of the local file this plugin does not read, which is ignored (config-local.mjs splitUnknownKeys).
// `unreadable` names each of `.aidrian.json` and `.aidrian.local.json` that is there but whose settings are not in force,
// because it could not be read or names no usable folder: from `root`, or absolute when it is in the main checkout.
// `roots` is git's checkoutRoots for a folder in the same checkout, when the caller already asked; null outside git.
// `read`, when given, gives the options of each git read the local file takes, as findProject's does.
export function openProject(root, roots, read) {
  const errors = [];
  const warnings = [];
  const unreadable = [];
  const dir = folderDir(root, errors, unreadable);
  const paths = { config: `${dir}/config.json`, knowledge: `${dir}/knowledge`, local: LOCAL };
  const found = roots === undefined ? safeRoots(root, read) : roots;
  const checkouts = checkoutsOf(root, found);
  const local = cloneLocal(found, checkouts, { errors, warnings }, unreadable, read);
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
    localUnattendedSignoff: local.unattendedSignoff,
    localHandoffBackground: local.handoffBackground,
    localFeedbackAuto: local.feedbackAuto,
    localForgeTokenKeychain: local.forgeTokenKeychain ?? null,
    // A confined attempt's recorded switch: whether git tracked no local file in the main checkout at the start, which
    // mayFollowTeamDefault answers with, since this process cannot ask git there.
    ...(found?.attempt?.machine ? { recordedFollow: found.attempt.machine.autoMerge === 'unset' } : {}),
    errors,
    warnings,
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
// checkoutRoots for `root`, with the options `read` gives, or null when it is no folder.
function safeRoots(root, read) {
  try {
    return checkoutRoots(root, typeof read === 'function' ? read() : undefined);
  } catch {
    return null;
  }
}

// The local settings of the checkouts `checkouts` whose roots are `roots`: readLocal's, but for a project run's attempt
// clone (lib/attempt-clone.mjs), whose session writes its folder, only the run's main checkout's file counts, the
// clone's own never; and one whose link cannot be read reads every switch off and no decisions, but the auto-merge
// switch a confined session's start row recorded (attempt-clone.mjs confinedMachine). `read` is readLocal's.
function cloneLocal(roots, checkouts, problems, unreadable, read) {
  if (!roots?.attempt) return readLocal(checkouts, problems, unreadable, read);
  if (roots.unlinked) return { sources: [], models: undefined, names: undefined, telemetry: undefined, agents: undefined, ...OFF_SWITCHES, ...(roots.attempt.machine ? { autoMerge: roots.attempt.machine.autoMerge } : {}) };
  return readLocal([checkouts.at(-1)], problems, unreadable, read);
}

function checkoutsOf(root, roots) {
  const main = inMainCheckout(root, roots);
  return main && main !== realpathSync(root) ? [root, main] : [root];
}

// The project's checkouts and every checkout of its repository (lib/git.mjs repositoryCheckouts): what a state folder
// must lie outside of before a session folder or a continuation marker is kept there. A relative `state.dir` of a project
// below the repository root resolves against that root, so the project's own checkouts are not enough. Null when git
// could not list them, so the caller refuses. `read` gives each git call's options.
export function projectCheckouts(project, read) {
  const repository = repositoryCheckouts(project.root, read);
  return repository && [...new Set([...project.checkouts, ...repository])];
}

const LOCAL_KEYS = ['sources', 'models', 'names', 'telemetry', 'agents', 'review', 'decisions', 'github', 'reviewApprovals', 'unattendedSignoff', 'handoff', 'projectRun'];

// `.aidrian.local.json`: { sources, models, names, telemetry, agents, review, decisions, autoMerge, unattendedWaiver, reviewApprovals, feedbackAuto }. A git worktree has no copy of that git-ignored
// file, so it is read from the main checkout then: from the first of `checkouts` that has it. Each source is a folder with
// its own knowledge/ and, optionally, a config.json with `version`. `decisions`, the machine switches (auto-merge, the
// unattended waiver, and review approvals), and `review.productFeedback.auto` come only from the main checkout's file
// (checkouts.at(-1)): a copy a session writes in its own worktree raises nothing, lowers nothing, and never turns merging on.
// Behind such a copy, the main checkout's file gets every check it gets when it is the one loaded, and its errors are
// reported, so a worktree's copy hides none of them. Whether git tracks the main checkout's file is asked once, and only
// when a switch or `review.productFeedback.auto` needs it, with the options `read` gives, as findProject's reads take them.
// `errors` gets every error, and `warnings` every key the plugin does not read (splitUnknownKeys).
function readLocal(checkouts, { errors, warnings }, unreadable, read) {
  const none = { sources: [], models: undefined, names: undefined, telemetry: undefined, agents: undefined, ...UNSET_SWITCHES };
  const holder = checkouts.find((dir) => isFile(path.join(dir, LOCAL)));
  if (!holder) return none;
  const main = checkouts.at(-1);
  const raw = readJson(holder, LOCAL, errors);
  const own = raw && checkedLocal(raw, holder);
  if (own) {
    errors.push(...own.problems);
    warnings.push(...own.unknown);
  } else unreadable.push(holder === checkouts[0] ? LOCAL : path.join(holder, LOCAL));
  const mainFile = holder === main ? own : mainLocal(main, errors, warnings);
  let asked = null;
  const tracked = () => (asked ??= runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main, typeof read === 'function' ? read() : undefined)).status;
  const switches = machineSwitches(mainFile, tracked, errors);
  const feedbackAuto = mainFeedbackAuto(mainFile?.raw, tracked, errors);
  const forgeTokenKeychain = mainKeychain(mainFile, tracked, errors);
  if (!own) return { ...none, ...switches, feedbackAuto, forgeTokenKeychain };
  const { models, names, telemetry, agents, review } = raw;
  return { sources: own.sources, models, names, telemetry, agents, review, decisions: mainFile?.raw.decisions, ...switches, feedbackAuto, forgeTokenKeychain };
}

// Every check of the local file `raw`, read from `dir`, whichever checkout it is in: { raw, sources, autoMerge,
// unattendedWaiver, reviewApprovals, problems, unknown }, with each switch as the file sets it, `problems` every error in
// it, and `unknown` the warning for each key, top-level or in `github`, that this plugin does not read and ignores.
function checkedLocal(raw, dir) {
  const found = [];
  for (const key of Object.keys(raw)) {
    if (!LOCAL_KEYS.includes(key)) found.push(`${LOCAL}: unknown key ${quoteName(key)}`);
  }
  const sources = localSources(dir, raw, found);
  const autoMerge = localAutoMerge(raw, found);
  const unattendedWaiver = localUnattendedWaiver(raw);
  const reviewApprovals = localReviewApprovals(raw, found);
  const unattendedSignoff = localUnattendedSignoff(raw, found);
  const handoffBackground = localHandoffBackground(raw, found);
  const forgeTokenKeychain = localForgeTokenKeychain(raw, found, LOCAL);
  const { errors: problems, warnings: unknown } = splitUnknownKeys(found, LOCAL);
  return { raw, sources, autoMerge, unattendedWaiver, reviewApprovals, unattendedSignoff, handoffBackground, forgeTokenKeychain, problems, unknown };
}

// The main checkout's local file behind a worktree's own copy, through checkedLocal: undefined when there is none, null
// when it cannot be read. Its errors and warnings are added to `errors` and `warnings`, as they are when it is the file loaded.
function mainLocal(main, errors, warnings) {
  if (!isFile(path.join(main, LOCAL))) return undefined;
  const raw = readJson(main, LOCAL, errors);
  if (!raw) return null;
  const file = checkedLocal(raw, main);
  errors.push(...file.problems);
  warnings.push(...file.unknown);
  return file;
}

const UNSET_SWITCHES = Object.freeze({ autoMerge: 'unset', unattendedWaiver: 'unset', reviewApprovals: 'unset', unattendedSignoff: 'unset', handoffBackground: 'unset' });
const OFF_SWITCHES = Object.freeze({ autoMerge: 'off', unattendedWaiver: 'off', reviewApprovals: 'off', unattendedSignoff: 'off', handoffBackground: 'off' });

// This machine's switches, from the main checkout's file as checkedLocal read it: each "unset" when there is no file,
// and "off" when it cannot be read. An error anywhere in the file, a tracked-file one too, reads an unset auto-merge
// "off", so it never follows a team default of "on", and the waiver "off" though it says "on": a wrong local file never
// turns merging on, nor lets a verdict stand in for the Human. A key the plugin does not read is no error: the switches
// resolve as if it were not there, and the check's warning names it.
// `tracked` gives git's status for the question whether it tracks the file (readLocal).
function machineSwitches(file, tracked, errors) {
  if (file === undefined) return UNSET_SWITCHES;
  if (!file) return { autoMerge: 'off', unattendedWaiver: 'off', reviewApprovals: 'off', unattendedSignoff: 'off', handoffBackground: 'off' };
  const problems = [];
  const autoMerge = untrackedSwitch(file.autoMerge, 'github.autoMerge', tracked, problems);
  const unattendedWaiver = untrackedSwitch(file.unattendedWaiver, 'github.unattendedWaiver', tracked, problems);
  const reviewApprovals = untrackedSwitch(file.reviewApprovals, 'reviewApprovals', tracked, problems);
  const unattendedSignoff = untrackedSwitch(file.unattendedSignoff, 'unattendedSignoff', tracked, problems);
  const handoffBackground = untrackedSwitch(file.handoffBackground, 'handoff.background', tracked, problems);
  errors.push(...problems);
  const broken = file.problems.length > 0 || problems.length > 0;
  return {
    autoMerge: broken && autoMerge === 'unset' ? 'off' : autoMerge,
    unattendedWaiver: broken ? 'off' : unattendedWaiver,
    reviewApprovals,
    unattendedSignoff: broken ? 'off' : unattendedSignoff,
    handoffBackground: broken ? 'off' : handoffBackground,
  };
}

// A switch `value` the main checkout's local file sets, named `key` in its errors; `tracked` gives git's status (readLocal).
// A local file git tracks travels with a branch, so it is no machine's own switch. Only git's answer "untracked" (exit 1) keeps it on: tracked under any case, a
// git that fails or stalls, or no repository at all reads "off". Asked only when the switch is on, so a hook pays no git
// call for a file that keeps it off.
function untrackedSwitch(value, key, tracked, errors) {
  if (value !== 'on') return value;
  const status = tracked();
  if (status === 0) errors.push(`${LOCAL}: git tracks it, so a branch could carry it; "${key}" reads "off" until it is untracked (git rm --cached ${LOCAL})`);
  else if (status !== 1) errors.push(`${LOCAL}: git could not say whether it tracks it, so "${key}" reads "off"`);
  return status === 1 ? 'on' : 'off';
}

// This machine's `review.productFeedback.auto`: the main checkout's. `raw` is that file, undefined when there is none or
// it could not be read. Unset, a value that is no boolean, a broken file, and no file all read as undefined, so the
// team's value holds, never false. A file git tracks travels with a branch, so it is no machine's own: only git's answer
// "untracked" (exit 1) keeps the value. Asked only when a value is set, so a hook pays no git call for a file with none.
// The main checkout's `projectRun.forgeTokenKeychain`, as checkedLocal read it, or null: only while git says it tracks
// no local file there, since a branch that carried one could choose which keychain entry gives a session its token.
function mainKeychain(file, tracked, errors) {
  const entry = file?.forgeTokenKeychain ?? null;
  if (!entry) return null;
  const status = tracked();
  if (status === 1) return entry;
  errors.push(status === 0
    ? `${LOCAL}: git tracks it, so a branch could carry it; "projectRun.forgeTokenKeychain" is ignored until it is untracked (git rm --cached ${LOCAL})`
    : `${LOCAL}: git could not say whether it tracks it, so "projectRun.forgeTokenKeychain" is ignored`);
  return null;
}

function mainFeedbackAuto(raw, tracked, errors) {
  const auto = raw?.review?.productFeedback?.auto;
  if (typeof auto !== 'boolean') return undefined;
  const status = tracked();
  if (status === 1) return auto;
  errors.push(status === 0
    ? `${LOCAL}: git tracks it, so a branch could carry it; "review.productFeedback.auto" is ignored until it is untracked (git rm --cached ${LOCAL})`
    : `${LOCAL}: git could not say whether it tracks it, so "review.productFeedback.auto" is ignored`);
  return undefined;
}

// Whether a machine with no setting may follow a team default of "on": git says it tracks no local file in the main
// checkout, under any case, present on disk or not. Asked only when the default applies, so a hook pays no git call. A tracked file, or a git that fails
// or stalls, is no machine's own, as machineSwitch reads it. `options` are runGit's, such as a hook's bounded `timeout`.
// A confined attempt's clone answers from its start row instead (openProject's `recordedFollow`).
export function mayFollowTeamDefault(project, options) {
  if (typeof project.recordedFollow === 'boolean') return project.recordedFollow;
  const main = project.checkouts.at(-1);
  return runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main, options).status === 1;
}

// The machine settings of the local file's `github` group, the only keys it takes: { autoMerge, unattendedWaiver, problems }.
// Each is `{ "enabled": true | false }`, the shape of the team's key, or the older "on" and "off", and reads "on", "off",
// or "unset". The team sets the strategy, the cleanup, the default, and both ceilings in config.json, and no machine can
// change them. `problems` lists every error in the group; both readers below read "off" when there is any but an unknown
// key, which is a warning (splitUnknownKeys), so a wrong local file never turns merging on, nor lets a verdict stand in
// for the Human. A key the team sets, such as `strategy` or `allow`, is unknown here, and the team's value holds.
const MACHINE_GITHUB = Object.freeze(['autoMerge', 'unattendedWaiver']);
function githubGroup(raw) {
  const none = { autoMerge: 'unset', unattendedWaiver: 'unset', problems: [] };
  if (!Object.hasOwn(raw, 'github')) return none;
  if (!isObject(raw.github)) return { ...none, problems: [`${LOCAL}: "github" must be an object`] };
  const problems = [];
  for (const key of Object.keys(raw.github)) {
    if (!MACHINE_GITHUB.includes(key)) problems.push(`${LOCAL}: unknown key ${quoteName(`github.${key}`)}; only "github.autoMerge" and "github.unattendedWaiver" are machine settings`);
  }
  const read = (key) => {
    if (!Object.hasOwn(raw.github, key)) return 'unset';
    let value = raw.github[key];
    if (isObject(value)) {
      const { enabled } = knownFields(value, ['enabled'], `github.${key}`, LOCAL, problems);
      value = typeof enabled === 'boolean' ? (enabled ? 'on' : 'off') : null;
    }
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
  return splitUnknownKeys(problems, LOCAL).errors.length ? 'off' : autoMerge;
}

// The local file's `github.unattendedWaiver`: githubGroup's, "off" when the group has any error. It adds none, since
// localAutoMerge reports the group's errors once. Unset is "unset", which reads off unless the team sets solo
// (config-local.mjs machineSwitch): the waiver has no team default of its own.
function localUnattendedWaiver(raw) {
  const { unattendedWaiver, problems } = githubGroup(raw);
  return splitUnknownKeys(problems, LOCAL).errors.length ? 'off' : unattendedWaiver;
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

// The local file's `unattendedSignoff` as "on", "off", or "unset": whether this machine lets a judge's ruling close an
// unverified or disputed invariant, when the team's `review.unattendedSignoff.allow` is true. Anything else is an error
// and reads "off".
function localUnattendedSignoff(raw, errors) {
  if (!Object.hasOwn(raw, 'unattendedSignoff')) return 'unset';
  if (raw.unattendedSignoff === 'on' || raw.unattendedSignoff === 'off') return raw.unattendedSignoff;
  errors.push(`${LOCAL}: "unattendedSignoff" must be "on" or "off"`);
  return 'off';
}

// The local file's `handoff.background` as "on", "off", or "unset": whether this machine lets a handoff start a new
// session in the background with no Human, when the team's base branch resolves session.handoff.continue to
// "background" (docs/handoff.md#the-background-route). `handoff` reads that one key, and any other is an unknown key
// (knownFields); a value that is neither is an error and reads "off".
function localHandoffBackground(raw, errors) {
  if (!Object.hasOwn(raw, 'handoff')) return 'unset';
  const given = isObject(raw.handoff) ? knownFields(raw.handoff, ['background'], 'handoff', LOCAL, errors) : null;
  if (given && ['on', 'off', undefined].includes(given.background)) return given.background ?? 'unset';
  errors.push(`${LOCAL}: "handoff" must be { "background": "on" } or { "background": "off" }`);
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
// `read` gives the options of each git read it makes, for a caller under a deadline, and may throw to stop it.
export function stateDir(project, { config = loadConfig(project).config, env = process.env, read = defaultRead } = {}) {
  if (config.state.dir) return localPath(project, config.state.dir, read);
  return path.join(stateRoot(env), 'projects', projectId(project, read));
}

// The state folder of `project` under `config` as the host's own environment resolves it: stateDir with no
// XDG_STATE_HOME, and with the home folder of the user this process runs as, which no HOME of a command's own moves.
// It only names the folder, for a comparison, and reads none of it: lib/handoff-continue.mjs backgroundGate holds the
// continuation store it opens to this one, so a variable set on the command line alone cannot move the store, and
// lib/handoff-guard.mjs startedUnattended reads a chain floor there too. `home` is for a test, which may not reach the
// user's own home folder.
export function defaultStateDir(project, { config = loadConfig(project).config, read = defaultRead, home = userInfo().homedir } = {}) {
  if (config.state.dir) return localPath(project, config.state.dir, read, home);
  return path.join(home, '.local/state', 'aidrian', 'projects', projectId(project, read));
}

// The folder under the state folder `state` that review records go in: the record's readers and writers and the check that
// holds them all ask here.
export const recordsFolder = (state) => path.join(state, 'reviews');

// `$XDG_STATE_HOME/aidrian`, with `~/.local/state` when that variable is unset or relative: the folder that holds every
// project's state folder, and what no config.json can move (lib/gate-snapshot.mjs keeps its files there).
// Under node's test runner (`NODE_TEST_CONTEXT`, which it sets for every test file and the processes it spawns), a root in
// the user's real home folder, outside the temporary folder and the run's test state folder, is refused: a test that
// reached it would write fixture lessons and state folders into the developer's own inbox. scripts/test-state.mjs gives
// every test its own root.
export function stateRoot(env = process.env) {
  const base = path.isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : path.join(homedir(), '.local/state');
  const root = path.join(base, 'aidrian');
  const scratch = [tmpdir(), env.AIDRIAN_TEST_STATE].filter((folder) => typeof folder === 'string' && path.isAbsolute(folder));
  if (env.NODE_TEST_CONTEXT && realHome(root) && !scratch.some((folder) => isWithin(path.resolve(folder), root))) {
    throw new Error(`a test reached the real state root ${root}: run it with \`--import ./scripts/test-state.mjs\`, or set XDG_STATE_HOME`);
  }
  return root;
}

// The folder of the hooks' counts and markers: the block counts, a subagent's send-backs, the session-length marker, and
// a tracker refusal's marker. It lies in the state root, which no sandbox of a session the plugin confines may write,
// never in the temporary folder, which one may: a FIFO planted there would stall a hook past its time, after which the
// host runs the call it was refusing, and a link would lead the hook's write outside the sandbox.
export const hookCountsFolder = (env = process.env) => path.join(stateRoot(env), 'hook-counts');

// Whether `folder` is in the home folder of the user this process runs as, which no HOME change moves.
function realHome(folder) {
  try {
    return isWithin(path.resolve(userInfo().homedir), path.resolve(folder));
  } catch {
    return false;
  }
}

// Task worktrees: config.json `git.worktrees.dir`, `.worktrees` at the repository root by default.
export function worktreesDir(project, { config = loadConfig(project).config } = {}) {
  return localPath(project, config.git.worktrees.dir);
}

// The main checkout's top folder, which every worktree shares; the project root outside git.
export function repoRoot(project, options) {
  return mainRoot(project.root, options) ?? project.root;
}

// `<repository name>-<8 hex digits>`: the name and a hash of the normalized `origin` URL, so every clone agrees.
// Without an origin, the main checkout's folder name and absolute path. A project below the repository root adds its
// path from that root to the hash, so two projects in one repository keep apart; a project at the root keeps its id.
// `read` gives the options of each git read, as for stateDir.
export function projectId(project, read = defaultRead) {
  const { status, stdout } = readOriginUrl(project.root, read());
  const repository = (status === 0 && normalizeRemote(stdout)) || realPath(repoRoot(project, read()));
  const prefix = readPrefix(project.root, read());
  const below = prefix.status === 0 ? prefix.stdout.replace(/\/?\n$/u, '') : '';
  return repositoryId(repository, below);
}

// The default state folders this project would have under each of its remotes' URLs, other than its own, so review state
// survives a change of remotes: `git remote rename origin upstream` and a new origin, as `gh repo fork` does, or a change
// of origin's URL, move the default folder, which is keyed by origin's URL. Empty when config.json sets `state.dir`, which
// no remote changes, or when git cannot answer. A folder found here is one this machine kept for a clone whose origin
// was that remote, so its records are read only for the repository each names (lib/review/state.mjs).
export function remoteStateDirs(project, { config = loadConfig(project).config, env = process.env, read = defaultRead } = {}) {
  if (config.state.dir) return [];
  const own = stateDir(project, { config, env, read });
  const urls = readRemoteUrls(project.root, read());
  if (urls.status !== 0) return [];
  const prefix = readPrefix(project.root, read());
  const below = prefix.status === 0 ? prefix.stdout.replace(/\/?\n$/u, '') : '';
  const dirs = urls.stdout.split('\n').map((line) => line.slice(line.indexOf(' ') + 1).trim()).filter(Boolean)
    .map((url) => path.join(stateRoot(env), 'projects', repositoryId(normalizeRemote(url), below)));
  return [...new Set(dirs)].filter((dir) => dir !== own);
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

// Whether `project` is a checkout of the plugin's own repository: its project id is the plugin's, the match that sends
// plugin lessons to this checkout's inbox (lib/lesson-inbox.mjs). False when the manifest names no repository.
export const isPluginRepository = (project) => Boolean(pluginProjectId()) && projectId(project) === pluginProjectId();

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
function localPath(project, value, read = defaultRead, home = homedir()) {
  if (/^~(?=$|\/)/.test(value)) return path.join(home, value.slice(1));
  return path.resolve(repoRoot(project, read()), value);
}

function realPath(file) {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}
