// The mark of a session the background handoff route started, which no Human attends, kept apart from any project
// (docs/handoff.md#the-background-route). lib/handoff-guard.mjs startedUnattended finds such a session by its chain floor,
// in its project's continuation store, which only a call whose folder lies in that project reads. So the gate
// (lib/handoff-continue.mjs) also files `<state root>/unattended/<session>.json`, { root, at }, where `root` is the main
// checkout of the project it ran in, and scripts/hook-agent-gates.mjs reads it on every call, wherever the call runs.
// It is written in the state root the gate's environment names (project.mjs stateRoot), and read there, as the hook's
// environment names it, and in the user's own, `~/.local/state/aidrian` of the user this process runs as, which no HOME
// or XDG_STATE_HOME moves. Like a floor, it may be filed under the short id a host prints for the new session before
// it lists the full id, and every session id that starts with that short id reads it; it holds 30 days, and each write
// sweeps the older ones. The folder is the user's alone, 0700, and each mark 0600. lib/handoff-guard.mjs
// unattendedMarkWriteDenial keeps a subagent, and a session no Human attends, from changing the folder.
// A mark only ever refuses more, so a read fails closed: an entry it cannot check counts as a mark.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { isObject } from './fs.mjs';
import { stateRoot } from './project.mjs';

// The folder's name under the state root; lib/handoff-guard.mjs guards it by this name too.
export const MARK_FOLDER = 'unattended';
// A session id that may name a file.
const SESSION_ID = /^[\w-]{1,128}$/u;
// A short id a mark may be filed under, as a chain floor may (lib/handoff-markers.mjs).
const SHORT = /^([0-9A-Za-z][0-9A-Za-z-]{3,63})\.json$/u;
const MARK = /^[\w-]{1,128}\.json$/u;
const TEMPORARY = /^\.[\w-]{1,128}\.json\.\d+\.[0-9a-f]{12}\.tmp$/u;
const DAY = 24 * 60 * 60 * 1000;
// How long a mark holds, as long as the chain floor beside it.
export const MARK_AGE = 30 * DAY;
// A mark this size or larger is never read for its root; it still counts as a mark.
const MARK_CAP = 64 * 1024;
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// The folder the gate files marks in, under the state root `env` names.
export const markFolder = (env = process.env) => path.join(stateRoot(env), MARK_FOLDER);

// Every folder a mark is read in: the state root's, as `env` names it, and the user's own, under `home`, the home folder
// of the user this process runs as by default. A test gives `home`, since it may not reach the user's own.
export function markFolders({ env = process.env, home } = {}) {
  const folders = [];
  try {
    folders.push(markFolder(env));
  } catch {
    // A state root the environment cannot give: the user's own still holds.
  }
  try {
    folders.push(path.join(home ?? userInfo().homedir, '.local/state', 'aidrian', MARK_FOLDER));
  } catch {
    // No user record: the environment's root alone.
  }
  return [...new Set(folders.map((folder) => path.resolve(folder)))];
}

// Files the mark of `session`, { root, at }, in markFolder(env), where `root` is the main checkout of the project the gate
// ran in, after sweeping marks past MARK_AGE. Returns the file, or null when the session id cannot name a file, or the
// folder is a symlink, not a folder, or another user's, or the write fails. Never throws.
export function markUnattended(session, { root, env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || typeof root !== 'string' || !path.isAbsolute(root)) return null;
  try {
    const folder = markFolder(env);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stat = lstatSync(folder);
    const uid = processUid();
    if (!stat.isDirectory() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
    if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
    sweepMarks(folder, now);
    const file = path.join(folder, `${session}.json`);
    const temporary = path.join(folder, `.${session}.json.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temporary, `${JSON.stringify({ root, at: now })}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
    return file;
  } catch {
    return null;
  }
}

// The mark of `session`, { root } where `root` is the main checkout the gate named, or null when it named none that can
// be read; null when no mark holds. It reads each of markFolders the session's own mark and every mark under a short id
// it starts with. A mark of another user, or one past MARK_AGE, does not hold; an entry or a folder it cannot check does.
export function readUnattendedMark(session, { env = process.env, home, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  const uid = processUid();
  let unchecked = false;
  for (const folder of markFolders({ env, home })) {
    let names;
    try {
      names = readdirSync(folder);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      unchecked = true;
      continue;
    }
    const own = `${session}.json`;
    const ours = names.filter((name) => name === own || (SHORT.exec(name)?.[1] !== undefined && session.startsWith(SHORT.exec(name)[1])));
    for (const name of ours) {
      const found = readMark(path.join(folder, name), uid, now);
      if (found === 'unchecked') unchecked = true;
      else if (found) return found;
    }
  }
  return unchecked ? { root: null } : null;
}

// One mark file: { root } when it holds, null when it does not, or 'unchecked' when it cannot be checked.
function readMark(file, uid, now) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    return error.code === 'ENOENT' ? null : 'unchecked';
  }
  if (Number.isInteger(uid) && stat.uid !== uid) return null;
  if (now - Math.floor(stat.mtimeMs) > MARK_AGE) return null;
  return { root: stat.isFile() && stat.size < MARK_CAP ? rootOf(file) : null };
}

// The main checkout a mark names, or null.
function rootOf(file) {
  let fd;
  try {
    fd = openSync(file, NO_FOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    const value = JSON.parse(readFileSync(fd, 'utf8'));
    return isObject(value) && typeof value.root === 'string' && path.isAbsolute(value.root) ? value.root : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Deletes the marks in `folder` past MARK_AGE, and its own temporary files past a day, and nothing else. Never throws.
function sweepMarks(folder, now) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!MARK.test(name) && !TEMPORARY.test(name)) continue;
    const age = MARK.test(name) ? MARK_AGE : DAY;
    try {
      const file = path.join(folder, name);
      if (now - Math.floor(lstatSync(file).mtimeMs) > age) unlinkSync(file);
    } catch {
      // Gone already, or another sweep got it.
    }
  }
}
