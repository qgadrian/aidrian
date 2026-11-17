// The folder of one session in the project's state folder, `<state>/sessions/<session id>/`, and the one way its files
// are written. It holds caches a reader keeps between calls, such as the usage cache (lib/session-usage-cache.mjs);
// docs/project-folder.md lists them. Display data only: no hook, gate, skill, or agent decides anything from it.
// The folder follows the continuation store's rules (lib/handoff-markers.mjs), checked before every write, read, and
// sweep: the state folder resolves inside no checkout of the repository, and no other user owns it or may write it; the
// sessions folder and the session folder are each a real folder, no symlink, owned by this process's user, that no other
// user may read or write; and the session folder's real path is `<real state>/sessions/<id>`. Its files are written as a
// temporary file and a rename, mode 0600, under the names in SESSION_FILES alone; a file's reservation, which makes a
// read-check-write of it exclusive, is `<name>.lock`, created the same way. Creating a session folder sweeps the ones
// untouched for SWEEP_DAYS, and the sweep deletes only those names, their temporary files, and their reservations, then
// the folder, which it never empties of anything else.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { checkoutHolding, processUid, resolvedPath } from './fs.mjs';
import { looseFolder, SESSION_ID } from './handoff-markers.mjs';

// A session folder whose newest file is older than this goes when another session's folder is created.
export const SWEEP_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
// The files a session folder holds: nothing else is written there, and the sweep deletes nothing else.
export const SESSION_FILES = Object.freeze(['usage.json', 'prs.jsonl', 'prs-cache.json', 'merged-heads-cache.json']);
// The random part of a temporary file's name, and the names of the temporary files, `.<file>.<pid>.<token>.tmp`.
const TOKEN = /^[0-9a-f]{12}$/u;
const newToken = () => randomBytes(6).toString('hex');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
export const SESSION_TEMPORARY = new RegExp(String.raw`^\.(?:${SESSION_FILES.map(escaped).join('|')})\.\d+\.[0-9a-f]{12}\.tmp$`, 'u');
// The reservation of the file `name`, which reserveSessionFile takes and the sweep deletes with the file.
export const reservationName = (name) => `${name}.lock`;
const SESSION_RESERVATIONS = Object.freeze(SESSION_FILES.map(reservationName));
// A temporary file or a reservation is created only where nothing is, and never through a symlink.
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

// The real path of the folder of `sessionId` under the state folder `state`, created for this user alone when missing,
// or null, with nothing made, written, or swept: the id fails SESSION_ID; `checkouts`, the project's, is no list; the
// state folder fails its rule, or a sessions or session folder fails its own; or the folder's real path is not
// `<real state>/sessions/<id>`. Creating the folder sweeps the others. Never throws.
export function sessionFolder(state, sessionId, { checkouts, uid = processUid(), now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !Array.isArray(checkouts)) return null;
  try {
    const real = ownState(state, checkouts, uid);
    if (real === null) return null;
    const sessions = path.join(real, 'sessions');
    made(sessions);
    if (!privateFolder(sessions, uid)) return null;
    const folder = path.join(sessions, sessionId);
    const created = made(folder);
    if (!privateFolder(folder, uid) || realpathSync(folder) !== folder) return null;
    if (created) sweepSessions(sessions, { current: sessionId, uid, now });
    return folder;
  } catch {
    return null;
  }
}

// The real path of the state folder, made when missing, or null when it resolves inside one of `checkouts`, or another
// user than `uid` owns it or every user may write it, checked before it is made and again after.
function ownState(state, checkouts, uid) {
  const resolved = resolvedPath(state);
  if (resolved === null || checkoutHolding(resolved, checkouts) || looseFolder(state, uid) !== null) return null;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const real = realpathSync(state);
  if (!statSync(real).isDirectory() || checkoutHolding(real, checkouts) || looseFolder(real, uid) !== null) return null;
  return real;
}

// Whether this call made the folder `dir`; false when it was there already, made by another process meanwhile included.
function made(dir) {
  try {
    mkdirSync(dir, { mode: 0o700 });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

// Whether `dir` is a real folder, no symlink, owned by `uid`, that no other user may read or write. Where the system has
// no user ids, as on Windows, the folder alone is checked.
function privateFolder(dir, uid) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) return false;
  return !Number.isInteger(uid) || (looseFolder(dir, uid) === null && (stat.mode & 0o077) === 0);
}

// privateFolder, false for a folder that is missing or cannot be read.
function isPrivateFolder(dir, uid) {
  try {
    return privateFolder(dir, uid);
  } catch {
    return false;
  }
}

// The temporary file `name` in `folder` is written through: `.<name>.<pid>.<token>.tmp`, which SESSION_TEMPORARY matches.
export const temporaryName = (folder, name, token = newToken()) => path.join(folder, `.${name}.${process.pid}.${token}.tmp`);

// Writes `text` to the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave: to a new temporary
// file, opened only where nothing is and never through a symlink, mode 0600, then renamed over the file. Returns the
// file, or null when the name is not one of SESSION_FILES, `folder` fails privateFolder at the time of the write, or the
// write fails. Never throws. `token` is the temporary name's random part, which a test may fix.
export function writeSessionFile(folder, name, text, { token = newToken(), uid = processUid() } = {}) {
  if (!SESSION_FILES.includes(name) || !TOKEN.test(token) || !isPrivateFolder(folder, uid)) return null;
  const file = path.join(folder, name);
  const temporary = temporaryName(folder, name, token);
  try {
    writeFileSync(temporary, text, { flag: CREATE, mode: 0o600 });
  } catch {
    return null;
  }
  try {
    renameSync(temporary, file);
    return file;
  } catch {
    try {
      unlinkSync(temporary);
    } catch {
      // The sweep removes it later.
    }
    return null;
  }
}

// Reserves the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave, so that one process alone reads,
// checks, and writes it until it releases: creates `<name>.lock` only where nothing is, never through a symlink, mode
// 0600. A reservation whose last change is `staleMs` or more from `now`, before it, as one a killed process left, or after
// it, as after the clock went back, is taken over: renamed to a temporary name, which only one process can do, deleted
// when the renamed file is still that stale reservation (else put back), then created afresh. Returns the function that releases it, deleting the
// reservation only while it is still this one, or null when the name is not one of SESSION_FILES, `folder` fails
// privateFolder, another process holds a reservation that is not stale, or it cannot be made. Never throws.
export function reserveSessionFile(folder, name, { staleMs, now = Date.now(), token = newToken(), uid = processUid() } = {}) {
  if (!SESSION_FILES.includes(name) || !TOKEN.test(token) || !Number.isFinite(staleMs) || !isPrivateFolder(folder, uid)) return null;
  const reservation = path.join(folder, reservationName(name));
  const taken = createReservation(reservation);
  if (taken || !tookStale(reservation, temporaryName(folder, name, token), { staleMs, now, uid })) return taken;
  return createReservation(reservation);
}

// The release of a new reservation at `file`, or null when one is there or it cannot be made.
function createReservation(file) {
  let fd;
  try {
    fd = openSync(file, CREATE, 0o600);
    const { dev, ino } = fstatSync(fd);
    return () => releaseReservation(file, dev, ino);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function releaseReservation(file, dev, ino) {
  try {
    const stat = lstatSync(file);
    if (stat.dev === dev && stat.ino === ino) unlinkSync(file);
  } catch {
    // Gone already: a later process took it over as stale.
  }
}

// Whether this call removed the stale reservation at `file`, a regular file `uid` owns, by renaming it to `moved`. When
// the rename took a reservation another process made meanwhile, it is put back and the answer is false.
function tookStale(file, moved, { staleMs, now, uid }) {
  try {
    const before = lstatSync(file);
    const owned = !Number.isInteger(uid) || before.uid === uid;
    if (!before.isFile() || !owned || Math.abs(now - before.mtimeMs) < staleMs) return false;
    renameSync(file, moved);
    const after = lstatSync(moved);
    const same = after.dev === before.dev && after.ino === before.ino;
    if (!same) putBack(moved, file);
    unlinkSync(moved);
    return same;
  } catch {
    return false;
  }
}

// SHORTCUT: a link back fails when a third process made a reservation in the moment it was gone; both then hold one.
// That needs a stale reservation and three processes starting within a millisecond, and only costs one extra refresh.
function putBack(moved, file) {
  try {
    linkSync(moved, file);
  } catch {
    // Another reservation is there now.
  }
}

// Removes each session folder under `sessions`, the real path sessionFolder checked, but `current`, whose folder and
// files were all last changed more than SWEEP_DAYS before `now`: it deletes the files named in SESSION_FILES, their
// temporary files, and their reservations, then removes the folder only when that left it empty. An entry whose name
// fails SESSION_ID, or that fails privateFolder, a symlink among them, is left alone.
function sweepSessions(sessions, { current, uid, now }) {
  let names;
  try {
    names = readdirSync(sessions);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === current || !SESSION_ID.test(name)) continue;
    try {
      sweepFolder(path.join(sessions, name), uid, now);
    } catch {
      // Gone already, changed meanwhile, or another session's sweep got it.
    }
  }
}

function sweepFolder(dir, uid, now) {
  if (!privateFolder(dir, uid)) return;
  const names = readdirSync(dir);
  const newest = Math.max(lstatSync(dir).mtimeMs, ...names.map((name) => lstatSync(path.join(dir, name)).mtimeMs));
  if (now - newest <= SWEEP_DAYS * DAY) return;
  for (const name of names) {
    if (SESSION_FILES.includes(name) || SESSION_RESERVATIONS.includes(name) || SESSION_TEMPORARY.test(name)) unlinkSync(path.join(dir, name));
  }
  rmdirSync(dir);
}
