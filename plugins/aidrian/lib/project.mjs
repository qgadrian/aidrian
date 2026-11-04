// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder, the git-ignored `.aidrian.local.json` that adds local knowledge sources,
// personal model choices, personal names, personal telemetry settings, personal decision settings, and the machine's
// auto-merge opt-in, and the machine-local state folder outside the repository.

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
// what decides CI's verdict. Not configurable.
export const GUARDED_PATHS = /(?:^|\/)(?:AGENTS\.md|CLAUDE\.md|SKILL\.md|CODEOWNERS|\.aidrian\.json|\.aidrian\.local\.json)$|^(?:\.claude|\.codex|\.aidrian|\.github\/workflows|\.github\/actions)(?:\/|$)/iu;

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
// localAutoMerge, errors, unreadable }.
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from:
// the project folder first, then each local source. `checkouts` is `root`, then, when it is in a git worktree, the same
// folder in the main checkout. `localModels`, `localNames`, `localTelemetry`, `localAgents`, `localReview`, and
// `localDecisions` are the `models`, `names`, `telemetry`, `agents`, `review`, and `decisions` values of
// `.aidrian.local.json`, as written; config.mjs checks them. `localAutoMerge`
// is its `github.autoMerge`: "on" or "off", checked here, "unset" when no file sets it, and "off" for a file with an error; the team's
// ceiling still decides (resolveAutoMerge). `errors` lists the problems in the root files; a broken
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
export function committedConfigFile(project, commit) {
  const shown = runGit(['show', `${commit}:./${OVERRIDE}`], project.root);
  if (shown.status === 128) return `${DEFAULT_DIR}/config.json`;
  if (shown.status !== 0) throw new Error(`git show ${commit}:./${OVERRIDE} failed`);
  let raw;
  try {
    raw = JSON.parse(shown.stdout);
  } catch {
    return null;
  }
  const dir = insidePath(project.root, '', raw?.dir);
  return dir ? `${dir}/config.json` : null;
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

// `root`, then, when it is in a git worktree, the same folder in the main checkout.
function checkoutsOf(root, roots) {
  const main = inMainCheckout(root, roots);
  return main && main !== realpathSync(root) ? [root, main] : [root];
}

const LOCAL_KEYS = ['sources', 'models', 'names', 'telemetry', 'agents', 'review', 'decisions', 'github'];

// `.aidrian.local.json`: { sources, models, names, telemetry, agents, review, decisions, autoMerge }. A git worktree has no copy of that git-ignored file, so it is read
// from the main checkout then: from the first of `checkouts` that has it. Each source is a folder with its own knowledge/
// and, optionally, a config.json with `version`. `decisions` and the auto-merge switch come only from the main checkout's
// file (checkouts.at(-1)): a copy a session writes in its own worktree raises nothing and never turns merging on.
function readLocal(checkouts, errors, unreadable) {
  const none = { sources: [], models: undefined, names: undefined, telemetry: undefined, agents: undefined, autoMerge: 'unset' };
  const holder = checkouts.find((dir) => isFile(path.join(dir, LOCAL)));
  if (!holder) return none;
  const raw = readJson(holder, LOCAL, errors);
  const main = checkouts.at(-1);
  if (!raw) {
    unreadable.push(holder === checkouts[0] ? LOCAL : path.join(holder, LOCAL));
    return { ...none, autoMerge: machineSwitch(raw, holder, main, errors) };
  }
  for (const key of Object.keys(raw)) {
    if (!LOCAL_KEYS.includes(key)) errors.push(`${LOCAL}: unknown key "${key}"`);
  }
  const { models, names, telemetry, agents, review, decisions } = raw;
  const sources = localSources(holder, raw, errors);
  const autoMerge = machineSwitch(raw, holder, main, errors);
  // A main-checkout file with any error never follows a team default of "on": a wrong local file never turns merging on.
  const broken = holder === main && autoMerge === 'unset' && errors.some((each) => each.startsWith(`${LOCAL}:`));
  return { sources, models, names, telemetry, agents, review, decisions: mainDecisions(main, holder, decisions), autoMerge: broken ? 'off' : autoMerge };
}

// The `decisions` of the local file in `main`, the main checkout; `held` when that file is the one already read. A main
// file that cannot be read gives none, and is that checkout's error, as machineSwitch reads it.
function mainDecisions(main, holder, held) {
  if (main === holder) return held;
  if (!isFile(path.join(main, LOCAL))) return undefined;
  return readJson(main, LOCAL, [])?.decisions;
}

// This machine's auto-merge switch: the main checkout's. `raw` is the file read from `holder`, null when that could not
// be read, so a worktree's own broken copy leaves the main checkout's switch in force, as any other copy does.
function machineSwitch(raw, holder, main, errors) {
  let autoMerge = raw ? localAutoMerge(raw, errors) : 'off';
  if (holder !== main) {
    const mainFile = isFile(path.join(main, LOCAL)) ? readJson(main, LOCAL, []) : null;
    autoMerge = !isFile(path.join(main, LOCAL)) ? 'unset' : mainFile ? switchOfValidFile(mainFile, main) : 'off';
  }
  // A local file git tracks travels with a branch, so it is no machine's own switch. Only git's answer "untracked"
  // (exit 1) keeps it on: tracked under any case, a git that fails or stalls, or no repository at all reads "off". Asked
  // only when the switch is on, so a hook pays no git call for a file that keeps auto-merge off.
  if (autoMerge === 'on') {
    const { status } = runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main);
    if (status === 0) errors.push(`${LOCAL}: git tracks it, so a branch could carry it; "github.autoMerge" reads "off" until it is untracked (git rm --cached ${LOCAL})`);
    else if (status !== 1) errors.push(`${LOCAL}: git could not say whether it tracks it, so "github.autoMerge" reads "off"`);
    if (status !== 1) autoMerge = 'off';
  }
  return autoMerge;
}

// The switch of the main checkout's file when a worktree's own copy was the one loaded: any error in it reads "off", as
// it does when that file is the one loaded, so a worktree's copy cannot hide it.
function switchOfValidFile(raw, main) {
  const problems = [];
  for (const key of Object.keys(raw)) {
    if (!LOCAL_KEYS.includes(key)) problems.push(key);
  }
  localSources(main, raw, problems);
  const value = localAutoMerge(raw, problems);
  return value === 'unset' && problems.length > 0 ? 'off' : value;
}

// Whether a machine with no setting may follow a team default of "on": git says it tracks no local file in the main
// checkout, under any case, present on disk or not. Asked only when the default applies, so a hook pays no git call. A tracked file, or a git that fails
// or stalls, is no machine's own, as machineSwitch reads it.
export function mayFollowTeamDefault(project) {
  const main = project.checkouts.at(-1);
  return runGit(['ls-files', '--error-unmatch', '--', `:(icase)${LOCAL}`], main).status === 1;
}

// The local file's `github.autoMerge` as "on", "off", or "unset": `{ "enabled": true | false }`, the shape of the team's
// key, or the older "on" and "off". It is the only local `github` key: the team sets the strategy,
// the cleanup, the default, and the ceiling in config.json, and no machine can change them. Unset follows the team's
// default; a `github` group with any error, so a wrong local file never turns merging on.
function localAutoMerge(raw, errors) {
  if (!Object.hasOwn(raw, 'github')) return 'unset';
  if (!isObject(raw.github)) {
    errors.push(`${LOCAL}: "github" must be an object`);
    return 'off';
  }
  const before = errors.length;
  for (const key of Object.keys(raw.github)) {
    if (key !== 'autoMerge') errors.push(`${LOCAL}: unknown key "github.${key}"; only "github.autoMerge" is a machine setting`);
  }
  const given = Object.hasOwn(raw.github, 'autoMerge') ? raw.github.autoMerge : 'unset';
  const value = isObject(given) && Object.keys(given).length === 1 && typeof given.enabled === 'boolean' ? (given.enabled ? 'on' : 'off') : given;
  if (!['on', 'off', 'unset'].includes(value) || given === 'unset' && Object.hasOwn(raw.github, 'autoMerge')) errors.push(`${LOCAL}: "github.autoMerge" must be { "enabled": true } or { "enabled": false }`);
  return errors.length === before ? value : 'off';
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
