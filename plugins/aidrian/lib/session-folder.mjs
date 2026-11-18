// The folder of one session in the project's state folder, `<state>/sessions/<session id>/`, and the one way its files
// are written. It holds caches a reader keeps between calls, such as the usage cache (lib/session-usage-cache.mjs);
// docs/project-folder.md lists them. Display data only: no hook, gate, skill, or agent decides anything from it.
// The state folder and every folder above it pass heldFolder, checked before every write, read, and sweep, so no other
// user can swap a folder between a check and the open that follows it, and the state folder resolves inside no checkout
// of the repository. The sessions folder and the session folder are each a real folder, no symlink, owned by this
// process's user, that no other user may read or write; and the session folder's real path is `<real state>/sessions/<id>`,
// and is still the folder's own path at each write, read, and sweep (boundFolder), so a folder above it swapped for a
// symlink since gets none. Its files are written as a temporary file and a rename, mode 0600, under the names in
// SESSION_FILES alone, with one exception: the session's pull request ledger, `prs.jsonl` (APPENDED_FILES), which
// lib/session-prs.mjs reads by its tail through readSessionTail, and appends to in place through appendSessionFile,
// no-follow, mode 0600, only while it is a regular file with one link this user alone may read, and rewrites through
// writeSessionFile when it is past its cap or an append would pass it; a file's reservation for one fixed
// window, which lets one process alone read, check, and write it in that window, is `<name>.<window>.lock`, created only
// where nothing is, mode 0600, and never renamed, linked, or deleted by any process but its creator. Creating a session folder sweeps the ones
// untouched for SWEEP_DAYS, and the sweep deletes only those names, their temporary files, and their reservations, then
// the folder, which it never empties of anything else.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';

import { checkoutHolding, isEntry, processGid, processUid, resolvedPath } from './fs.mjs';
import { readOwnFile, SESSION_ID } from './handoff-markers.mjs';

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
// The reservation of the file `name` for the fixed window `index`, floor(now / windowMs), which reserveSessionFile takes and
// the sweep deletes with the file.
export const reservationName = (name, index) => `${name}.${index}.lock`;
export const SESSION_RESERVATION = new RegExp(String.raw`^(?:${SESSION_FILES.map(escaped).join('|')})\.\d+\.lock$`, 'u');
// A temporary file or a reservation is created only where nothing is, and never through a symlink.
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
// The files appended to in place, never renamed over: the session ledger alone.
export const APPENDED_FILES = Object.freeze(['prs.jsonl']);
// An append opens where no symlink is, and never waits on a named pipe.
const APPEND = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The real path of the folder of `sessionId` under the state folder `state`, created for this user alone when missing,
// or null, with nothing made, written, or swept: the id fails SESSION_ID; `checkouts`, the project's, is no list; the
// state folder fails its rule, or a sessions or session folder fails its own; or the folder fails boundFolder, so no
// folder it gives is one its writes refuse. Creating the folder sweeps the others. `uid` and `gid` are this user's ids,
// which a test may set. Never throws.
export function sessionFolder(state, sessionId, { checkouts, uid = processUid(), gid = processGid(), now = Date.now() } = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !Array.isArray(checkouts)) return null;
  const ids = { uid, gid };
  try {
    const real = ownState(state, checkouts, ids);
    if (real === null) return null;
    const sessions = path.join(real, 'sessions');
    made(sessions);
    if (!privateFolder(sessions, uid)) return null;
    const folder = path.join(sessions, sessionId);
    const created = made(folder);
    if (!boundFolder(folder, ids)) return null;
    if (created) sweepSessions(sessions, { current: sessionId, ...ids, now });
    return folder;
  } catch {
    return null;
  }
}

// The real path of the state folder, made when missing, or null when it resolves inside one of `checkouts`, or it fails
// stateHeld, checked before anything is made and again after.
function ownState(state, checkouts, ids) {
  const resolved = resolvedPath(state);
  if (resolved === null || checkoutHolding(resolved, checkouts) || !stateHeld(state, ids)) return null;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const real = realpathSync(state);
  if (checkoutHolding(real, checkouts) || !heldChain(real, ids, false)) return null;
  return real;
}

// Whether the folder `dir` lets no user but this one rename or replace what lies below it, as OpenSSH's StrictModes holds
// the folders above a key, which the state folder and every folder above it must. Read with lstat, it is a folder, no
// symlink; this user, `uid`, owns it, or root does when it lies `above` the state folder; others may not write it unless
// it has the sticky bit; and its group may write it only with the sticky bit, or when it is this user's own folder in a
// user private group: its gid is this user's primary gid, `gid`, and that equals `uid`, as Debian, Ubuntu, and Fedora give
// each user, whose umask 002 makes folders 0775. A shared folder such as /tmp, root's and sticky, passes. Where the system
// has no user ids, as on Windows, only the first rule holds. Throws when the folder cannot be read.
export function heldFolder(dir, { uid = processUid(), gid = processGid(), above = false } = {}) {
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) return false;
  if (!Number.isInteger(uid)) return true;
  const own = stat.uid === uid;
  if (!own && !(above && stat.uid === 0)) return false;
  const sticky = (stat.mode & 0o1000) !== 0;
  if ((stat.mode & 0o002) !== 0 && !sticky) return false;
  return (stat.mode & 0o020) === 0 || sticky || (own && stat.gid === gid && gid === uid);
}

// Whether the real path `dir` and every folder above it pass heldFolder: `dir` as the state folder, unless `above` says it
// lies above it, and the rest as folders above it.
function heldChain(dir, ids, above) {
  for (let current = dir, high = above; ; current = path.dirname(current), high = true) {
    if (!heldFolder(current, { ...ids, above: high })) return false;
    if (path.dirname(current) === current) return true;
  }
}

// Whether the state folder `state` and every folder above it pass heldFolder, or, while it is not there yet, the nearest
// folder above it that is and every one above that: what a session folder needs before anything is made, and what the
// snapshot's lessons and audits sections need. False when a folder cannot be read. Never throws.
export function stateHeld(state, { uid = processUid(), gid = processGid() } = {}) {
  try {
    let current = resolvedPath(state);
    if (current === null) return false;
    let above = false;
    while (!isEntry(current)) {
      current = path.dirname(current);
      above = true;
    }
    return heldChain(current, { uid, gid }, above);
  } catch {
    return false;
  }
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
  return !Number.isInteger(uid) || (stat.uid === uid && (stat.mode & 0o077) === 0);
}

// Whether the session folder `folder`, a real path sessionFolder gave, is still the folder it checked: its real path is
// still itself, so no folder above it was swapped for a symlink since; it passes privateFolder; and its sessions folder,
// the state folder, and every folder above them pass heldFolder, the first two as this user's own. False for a folder that
// is missing or cannot be read. Every write, reservation, read, and sweep asks it first.
export function boundFolder(folder, { uid = processUid(), gid = processGid() } = {}) {
  try {
    const sessions = path.dirname(folder);
    const ids = { uid, gid };
    return realpathSync(folder) === folder && privateFolder(folder, uid) && heldFolder(sessions, ids) && heldChain(path.dirname(sessions), ids, false);
  } catch {
    return false;
  }
}

// The text of the file `name`, one of SESSION_FILES, in `folder`, under the Reads rule (readOwnFile) and `cap`, as
// { text, stat }, or null: the name is not one of SESSION_FILES, `folder` fails boundFolder, or readOwnFile gives none.
export function readSessionFile(folder, name, { cap, uid = processUid(), gid = processGid() }) {
  if (!SESSION_FILES.includes(name) || !boundFolder(folder, { uid, gid })) return null;
  return readOwnFile(path.join(folder, name), { cap, uid });
}

// The temporary file `name` in `folder` is written through: `.<name>.<pid>.<token>.tmp`, which SESSION_TEMPORARY matches.
export const temporaryName = (folder, name, token = newToken()) => path.join(folder, `.${name}.${process.pid}.${token}.tmp`);

// Writes `text` to the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave: to a new temporary
// file, opened only where nothing is and never through a symlink, mode 0600, then renamed over the file. Returns the
// file, or null when the name is not one of SESSION_FILES, `folder` fails boundFolder at the time of the write, or the
// write fails. Never throws. `token` is the temporary name's random part, which a test may fix.
export function writeSessionFile(folder, name, text, { token = newToken(), uid = processUid(), gid = processGid() } = {}) {
  if (!SESSION_FILES.includes(name) || !TOKEN.test(token) || !boundFolder(folder, { uid, gid })) return null;
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

// A tail read opens where no symlink is, and never waits on a named pipe.
const READ_TAIL = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// The last `maxBytes` of the file `name`, one of APPENDED_FILES, in `folder`, which sessionFolder gave: { text, cut },
// `cut` true when the text starts inside a line, and { text: '', cut: false } when the file is missing. A file of any
// size is read, its tail alone. Null, the read refused, when `folder` fails boundFolder at the time of the read, or the
// file is a symlink (lstat, then opened no-follow), no regular file, has more than one link, or is not owned by `uid`
// with a mode no other user may read or write (fstat of the descriptor). Opened non-blocking, so a named pipe never
// waits. Never throws.
export function readSessionTail(folder, name, { maxBytes, uid = processUid(), gid = processGid() } = {}) {
  if (!APPENDED_FILES.includes(name) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || !boundFolder(folder, { uid, gid })) return null;
  const file = path.join(folder, name);
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, READ_TAIL);
    const stat = fstatSync(fd);
    const owned = !Number.isInteger(uid) || (stat.uid === uid && (stat.mode & 0o077) === 0);
    if (!stat.isFile() || stat.nlink !== 1 || !owned) return null;
    // One byte before the tail, when there is one, says whether the tail starts a line.
    const start = Math.max(0, stat.size - maxBytes - 1);
    const bytes = Buffer.alloc(stat.size - start);
    let read = 0;
    for (let n = 1; n > 0 && read < bytes.length; read += n) n = readSync(fd, bytes, read, bytes.length - read, start + read);
    const text = bytes.subarray(0, read);
    if (stat.size <= maxBytes) return { text: text.toString('utf8'), cut: false };
    return { text: text.subarray(1).toString('utf8'), cut: text[0] !== 0x0a };
  } catch (error) {
    return error?.code === 'ENOENT' && fd === undefined ? { text: '', cut: false } : null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Appends `text` to the file `name`, one of APPENDED_FILES, in `folder`, which sessionFolder gave: opened write-only,
// append, create, no-follow, and non-blocking, mode 0600, and written only when `folder` passes boundFolder at the time
// of the write, fstat of the descriptor shows a regular file with one link, owned by `uid`, that no other user may read
// or write, and its size with `text` stays within `maxBytes`. Returns whether every byte was written. Never throws.
export function appendSessionFile(folder, name, text, { maxBytes, uid = processUid(), gid = processGid() } = {}) {
  if (!APPENDED_FILES.includes(name) || typeof text !== 'string' || !Number.isSafeInteger(maxBytes) || !boundFolder(folder, { uid, gid })) return false;
  const bytes = Buffer.from(text);
  let fd;
  try {
    fd = openSync(path.join(folder, name), APPEND, 0o600);
    const stat = fstatSync(fd);
    const owned = !Number.isInteger(uid) || (stat.uid === uid && (stat.mode & 0o077) === 0);
    if (!stat.isFile() || stat.nlink !== 1 || !owned || stat.size + bytes.length > maxBytes) return false;
    return writeSync(fd, bytes) === bytes.length;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Reserves the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave, for the fixed window of `windowMs`
// that holds `now`, so that one process alone reads, checks, and writes it in that window: creates `<name>.<window>.lock`
// only where nothing is, never through a symlink, mode 0600. Nothing is ever taken over: a reservation a killed process
// left blocks only its own window. Returns the function that releases it, deleting the reservation while it is still the
// one this call made, or null when the name is not one of SESSION_FILES, `folder` fails boundFolder, any entry holds the
// name, or it cannot be made. Never throws.
export function reserveSessionFile(folder, name, { windowMs, now = Date.now(), uid = processUid(), gid = processGid() } = {}) {
  const index = Math.floor(now / windowMs);
  if (!SESSION_FILES.includes(name) || !Number.isSafeInteger(index) || index < 0 || !boundFolder(folder, { uid, gid })) return null;
  const file = path.join(folder, reservationName(name, index));
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
    // Gone already; the sweep removes what is left.
  }
}

// Removes each session folder under `sessions`, the real path sessionFolder checked, but `current`, whose folder and
// files were all last changed more than SWEEP_DAYS before `now`: it deletes the files named in SESSION_FILES, their
// temporary files, and their reservations that are regular files, then removes the folder only when that left it empty. An entry whose name
// fails SESSION_ID, or that fails boundFolder, a symlink among them, is left alone, and so is every entry once `sessions`
// is no longer its own real path. sessionFolder runs it when it creates a folder; it is exported for a test, which cannot
// swap a folder between sessionFolder's checks and its sweep.
export function sweepSessions(sessions, { current, uid, gid, now }) {
  let names;
  try {
    if (realpathSync(sessions) !== sessions) return;
    names = readdirSync(sessions);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === current || !SESSION_ID.test(name)) continue;
    try {
      sweepFolder(path.join(sessions, name), { uid, gid }, now);
    } catch {
      // Gone already, changed meanwhile, or another session's sweep got it.
    }
  }
}

function sweepFolder(dir, ids, now) {
  if (!boundFolder(dir, ids)) return;
  const names = readdirSync(dir);
  const newest = Math.max(lstatSync(dir).mtimeMs, ...names.map((name) => lstatSync(path.join(dir, name)).mtimeMs));
  if (now - newest <= SWEEP_DAYS * DAY) return;
  for (const name of names) {
    const file = path.join(dir, name);
    const reservation = SESSION_RESERVATION.test(name) && lstatSync(file).isFile();
    if (SESSION_FILES.includes(name) || reservation || SESSION_TEMPORARY.test(name)) unlinkSync(file);
  }
  rmdirSync(dir);
}
