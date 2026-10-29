// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder, the git-ignored `.aidrian.local.json` that adds local knowledge sources,
// personal model choices, and personal names, and the machine-local state folder outside the repository.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { insidePath, isDirectory, isFile, loadConfig, readJson } from './config.mjs';
import { checkoutRoots, currentRoot, mainRoot, runGit } from './git.mjs';

const DEFAULT_DIR = '.aidrian';
const OVERRIDE = '.aidrian.json';
const LOCAL = '.aidrian.local.json';

// The project at or above `start`: the nearest folder that has `.aidrian.json` or `.aidrian/config.json`. Null when none.
// In a git checkout the search stops at its top folder, so a worktree whose branch has no project folder has no project,
// even inside a main checkout that has one. Outside git it goes on to the file-system root.
export function findProject(start) {
  let dir = path.resolve(start);
  let probe = dir;
  while (!isDirectory(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const top = currentRoot(probe);
  for (;;) {
    if (top !== null && outside(dir, top)) return null;
    if (isFile(path.join(dir, OVERRIDE)) || isFile(path.join(dir, DEFAULT_DIR, 'config.json'))) return openProject(dir);
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
  const rel = path.relative(top, real);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// The project at or above `start`, or one rooted at `start` that has no folder yet. For commands that work either way.
export function projectAt(start) {
  return findProject(start) ?? openProject(path.resolve(start));
}

// The project rooted at `root`, whether or not its folder exists yet:
// { root, dir, paths, sources, localModels, localNames, errors }.
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from:
// the project folder first, then each local source. `localModels` and `localNames` are the `models` and `names` values
// of `.aidrian.local.json`, as written; config.mjs checks them. `errors` lists the problems in the root files; a broken
// `.aidrian.json` leaves the default folder in place, and a broken local source is left out.
export function openProject(root) {
  const errors = [];
  const dir = folderDir(root, errors);
  const paths = { config: `${dir}/config.json`, knowledge: `${dir}/knowledge`, local: LOCAL };
  const local = readLocal(root, errors);
  const sources = [{ label: dir, base: root, index: paths.knowledge, local: false }, ...local.sources];
  return { root, dir, paths, sources, localModels: local.models, localNames: local.names, errors };
}

function folderDir(root, errors) {
  if (!isFile(path.join(root, OVERRIDE))) return DEFAULT_DIR;
  const raw = readJson(root, OVERRIDE, errors);
  if (!raw) return DEFAULT_DIR;
  for (const key of Object.keys(raw)) {
    if (key !== 'dir') errors.push(`${OVERRIDE}: unknown key "${key}"`);
  }
  const dir = insidePath(root, '', raw.dir);
  if (dir) return dir;
  errors.push(`${OVERRIDE}: "dir" must be a relative folder inside the project`);
  return DEFAULT_DIR;
}

// `.aidrian.local.json`: { sources, models, names }. A git worktree has no copy of that git-ignored file, so it is read
// from the main checkout then. Each source is a folder with its own knowledge/ and, optionally, a config.json with
// `version`.
function readLocal(root, errors) {
  const none = { sources: [], models: undefined, names: undefined };
  let holder = root;
  if (!isFile(path.join(holder, LOCAL))) holder = inMainCheckout(root);
  if (!holder || !isFile(path.join(holder, LOCAL))) return none;
  const raw = readJson(holder, LOCAL, errors);
  if (!raw) return none;
  for (const key of Object.keys(raw)) {
    if (!['sources', 'models', 'names'].includes(key)) errors.push(`${LOCAL}: unknown key "${key}"`);
  }
  return { sources: localSources(holder, raw, errors), models: raw.models, names: raw.names };
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

// The same folder in the main checkout, when `root` is inside a git worktree; null outside git. One git call: this runs
// at the start of every session and subagent.
function inMainCheckout(root) {
  const roots = checkoutRoots(root);
  return roots ? path.join(roots.main, path.relative(roots.current, realpathSync(root))) : null;
}

// The machine-local state folder: plans, handoffs, the lesson inbox, and the dispatch log.
// `$XDG_STATE_HOME/aidrian/projects/<project id>/`, with `~/.local/state` when that variable is unset or relative, so
// git never sees it and every worktree and clone of a repository shares it. config.json `state.dir` moves it.
export function stateDir(project, { config = loadConfig(project).config, env = process.env } = {}) {
  if (config.state.dir) return localPath(project, config.state.dir);
  const base = path.isAbsolute(env.XDG_STATE_HOME ?? '') ? env.XDG_STATE_HOME : path.join(homedir(), '.local/state');
  return path.join(base, 'aidrian', 'projects', projectId(project));
}

// Task worktrees: config.json `worktrees.dir`, `.worktrees` at the repository root by default.
export function worktreesDir(project, { config = loadConfig(project).config } = {}) {
  return localPath(project, config.worktrees.dir);
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
  const key = below ? `${repository}\0${below}` : repository;
  const slug = path.posix.basename(repository).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}`;
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
