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
// The new session's id is known only after the host lists it, seconds after it starts working. So before the start the
// gate files a pending mark, `pending.<old session>.json`, { pending, cwd, session, root, at }, which holds every other
// session whose call runs in the start folder `cwd`, or below it, and has no mark of its own, for PENDING_AGE at most;
// the gate removes it once the session's own mark is written, or nothing started. A pending file it cannot read holds
// every session but none: the session it names cannot be told apart from another.

import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { foldCase, isObject, isWithin, resolvedPath } from './fs.mjs';
import { stateRoot } from './project.mjs';

// The folder's name under the state root; lib/handoff-guard.mjs guards it by this name too.
export const MARK_FOLDER = 'unattended';
// A session id that may name a file.
const SESSION_ID = /^[\w-]{1,128}$/u;
// A short id a mark may be filed under, as a chain floor may (lib/handoff-markers.mjs).
const SHORT = /^([0-9A-Za-z][0-9A-Za-z-]{3,63})\.json$/u;
const MARK = /^[\w-]{1,128}\.json$/u;
// A pending mark, named for the session that ran the gate; the dot keeps it apart from a mark under a short id.
const PENDING = /^pending\.[\w-]{1,128}\.json$/u;
const TEMPORARY = /^\.(?:pending\.)?[\w-]{1,128}\.json\.\d+\.[0-9a-f]{12}\.tmp$/u;
const DAY = 24 * 60 * 60 * 1000;
// How long a mark holds, as long as the chain floor beside it.
export const MARK_AGE = 30 * DAY;
// How long a pending mark holds: past the host's longest start and listing, so it never lapses while the gate waits.
export const PENDING_AGE = 5 * 60 * 1000;
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

// The folder the gate files marks in, made the user's alone, after sweeping marks past their age, or null when it is a
// symlink, not a folder, or another user's. Throws when it cannot be made.
function ownFolder(env, now) {
  const folder = markFolder(env);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  const uid = processUid();
  if (!stat.isDirectory() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
  if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
  sweepMarks(folder, now);
  return folder;
}

// Writes `value` to `<folder>/<name>`, owner-only, through a temporary file: the file, or null when `folder` is null.
function writeMark(folder, name, value) {
  if (!folder) return null;
  const file = path.join(folder, name);
  const temporary = path.join(folder, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  return file;
}

// Files the mark of `session`, { root, at }, in markFolder(env), where `root` is the main checkout of the project the gate
// ran in, after sweeping marks past MARK_AGE. Returns the file, or null when the session id cannot name a file, or the
// folder is a symlink, not a folder, or another user's, or the write fails. Never throws.
export function markUnattended(session, { root, env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || typeof root !== 'string' || !path.isAbsolute(root)) return null;
  try {
    return writeMark(ownFolder(env, now), `${session}.json`, { root, at: now });
  } catch {
    return null;
  }
}

// Files the pending mark of the gate run by `session`, which is about to start a session in the folder `cwd`, with
// `root` the main checkout of its project: the file, or null, as markUnattended. Never throws.
export function markPending(session, { cwd, root, env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || [cwd, root].some((each) => typeof each !== 'string' || !path.isAbsolute(each))) return null;
  try {
    return writeMark(ownFolder(env, now), `pending.${session}.json`, { pending: true, cwd, session, root, at: now });
  } catch {
    return null;
  }
}

// Removes the pending mark `file` that markPending wrote: whether it is gone. Never throws.
export function dropPending(file) {
  if (typeof file !== 'string' || !PENDING.test(path.basename(file))) return false;
  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

// The mark of `session`, { root } where `root` is the main checkout the gate named, or null when it named none that can
// be read; null when no mark holds. It reads each of markFolders the session's own mark and every mark under a short id
// it starts with. A mark of another user, or one past MARK_AGE, does not hold; an entry or a folder it cannot check does.
// With no mark of its own, a pending mark holds a session whose call runs in `cwd`, as { root, pending: true }.
export function readUnattendedMark(session, { env = process.env, home, now = Date.now(), cwd } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  const uid = processUid();
  let unchecked = false;
  const pending = [];
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
    pending.push(...names.filter((name) => PENDING.test(name)).map((name) => path.join(folder, name)));
  }
  if (unchecked) return { root: null };
  return typeof cwd === 'string' ? pendingHold(pending, session, cwd, uid, now) : null;
}

// The hold of the first of the pending marks `files` that holds `session` in the folder `cwd`, or null.
function pendingHold(files, session, cwd, uid, now) {
  const real = (file) => foldCase(resolvedPath(file) ?? path.resolve(file));
  let here;
  for (const file of files) {
    const found = readPending(file, uid, now);
    if (found === null || found.session === session) continue;
    if (found === 'unchecked') return { root: null, pending: true };
    here ??= real(cwd);
    if (isWithin(real(found.cwd), here)) return { root: found.root, pending: true };
  }
  return null;
}

// One pending mark: { session, cwd, root } when it holds, null when it does not, or 'unchecked' when it holds and cannot
// be read.
function readPending(file, uid, now) {
  let stat;
  try {
    stat = lstatSync(file);
  } catch (error) {
    return error.code === 'ENOENT' ? null : 'unchecked';
  }
  if (Number.isInteger(uid) && stat.uid !== uid) return null;
  if (now - Math.floor(stat.mtimeMs) > PENDING_AGE) return null;
  const value = stat.isFile() && stat.size < MARK_CAP ? readJson(file) : null;
  const fits = isObject(value) && value.pending === true && typeof value.session === 'string'
    && [value.cwd, value.root].every((each) => typeof each === 'string' && path.isAbsolute(each));
  return fits ? { session: value.session, cwd: value.cwd, root: value.root } : 'unchecked';
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
  const value = readJson(file);
  return isObject(value) && typeof value.root === 'string' && path.isAbsolute(value.root) ? value.root : null;
}

// The JSON value of the regular file `file`, read without following a link, or null.
function readJson(file) {
  let fd;
  try {
    fd = openSync(file, NO_FOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Deletes the marks in `folder` past MARK_AGE, its pending marks past PENDING_AGE, and its own temporary files past a
// day, and nothing else. Never throws.
function sweepMarks(folder, now) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  const ages = [[MARK, MARK_AGE], [PENDING, PENDING_AGE], [TEMPORARY, DAY]];
  for (const name of names) {
    const age = ages.find(([pattern]) => pattern.test(name))?.[1];
    if (age === undefined) continue;
    try {
      const file = path.join(folder, name);
      if (now - Math.floor(lstatSync(file).mtimeMs) > age) unlinkSync(file);
    } catch {
      // Gone already, or another sweep got it.
    }
  }
}
