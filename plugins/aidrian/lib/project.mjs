// Finds a project and its project folder: `.aidrian/` at the project root, or the folder the committed root file
// `.aidrian.json` names. This is the only file that knows those names; every other file asks it for paths.
// docs/project-folder.md describes the folder.

import path from 'node:path';

import { insidePath, isFile, readJson } from './config.mjs';

const DEFAULT_DIR = '.aidrian';
const OVERRIDE = '.aidrian.json';

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
// `dir` and every path are POSIX-style and relative to `root`. `sources` lists where knowledge indexes are read from.
// `errors` lists the problems in the root files; a broken `.aidrian.json` leaves the default folder in place.
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
  };
  const sources = [{ label: dir, base: root, index: paths.knowledge, local: false }];
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
