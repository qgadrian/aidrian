// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder, and the git-ignored `.aidrian.local.json` that adds local knowledge sources.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { insidePath, isDirectory, isFile, readJson } from './config.mjs';
import { runGit } from './git.mjs';

const DEFAULT_DIR = '.aidrian';
const OVERRIDE = '.aidrian.json';
const LOCAL = '.aidrian.local.json';

// The project at or above `start`: the nearest folder that has `.aidrian.json` or `.aidrian/config.json`. Null when none.
export function findProject(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (isFile(path.join(dir, OVERRIDE)) || isFile(path.join(dir, DEFAULT_DIR, 'config.json'))) return openProject(dir);
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The project rooted at `root`, whether or not its folder exists yet: { root, dir, paths, sources, errors }.
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from:
// the project folder first, then each local source. `errors` lists the problems in the root files; a broken
// `.aidrian.json` leaves the default folder in place, and a broken local source is left out.
export function openProject(root) {
  const errors = [];
  const dir = folderDir(root, errors);
  const paths = {
    config: `${dir}/config.json`,
    knowledge: `${dir}/knowledge`,
    plans: `${dir}/plans`,
    handoffs: `${dir}/handoffs`,
    lessons: `${dir}/lessons`,
    dispatchLog: `${dir}/dispatch-log.jsonl`,
    worktrees: `${dir}/worktrees`,
    local: LOCAL,
  };
  const sources = [{ label: dir, base: root, index: paths.knowledge, local: false }, ...localSources(root, errors)];
  return { root, dir, paths, sources, errors };
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

// The folders `.aidrian.local.json` lists. A git worktree has no copy of that git-ignored file, so it is read from the
// main checkout then. Each source is a folder with its own knowledge/ and, optionally, a config.json with `version`.
function localSources(root, errors) {
  let holder = root;
  if (!isFile(path.join(holder, LOCAL))) holder = inMainCheckout(root);
  if (!holder || !isFile(path.join(holder, LOCAL))) return [];
  const raw = readJson(holder, LOCAL, errors);
  if (!raw) return [];
  for (const key of Object.keys(raw)) {
    if (key !== 'sources') errors.push(`${LOCAL}: unknown key "${key}"`);
  }
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
  const { status, stdout } = runGit(['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], root);
  const [commonDir, current] = status === 0 ? stdout.trim().split('\n') : [];
  return commonDir && current ? path.join(path.dirname(commonDir), path.relative(current, realpathSync(root))) : null;
}
