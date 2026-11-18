// The folder of one session in the project's state folder, `<state>/sessions/<session id>/`, and the one way its files
// are written. It holds caches a reader keeps between calls, such as the usage cache (lib/session-usage-cache.mjs);
// docs/project-folder.md lists them. Display data only: no hook, gate, skill, or agent decides anything from it.
// The folder follows the continuation store's rules (lib/handoff-markers.mjs), checked before every write, read, and
// sweep: the state folder resolves inside no checkout of the repository, and no other user owns it or may write it; the
// sessions folder and the session folder are each a real folder, no symlink, owned by this process's user, that no other
// user may read or write; and the session folder's real path is `<real state>/sessions/<id>`, and is still the folder's
// own path at each write, read, and sweep, so a folder above it swapped for a symlink since gets none; and no folder above
// the state folder or the session folder lets another user swap one below it (openAbove), which closes the gap between
// each check and the open that follows it. Its files are written as a
// temporary file and a rename, mode 0600, under the names in SESSION_FILES alone; a file's reservation for one fixed
// window, which lets one process alone read, check, and write it in that window, is `<name>.<window>.lock`, created only
// where nothing is, mode 0600, and never renamed, linked, or deleted by any process but its creator. Creating a session folder sweeps the ones
// untouched for SWEEP_DAYS, and the sweep deletes only those names, their temporary files, and their reservations, then
// the folder, which it never empties of anything else.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { checkoutHolding, processUid, resolvedPath } from './fs.mjs';
import { looseFolder, readOwnFile, SESSION_ID } from './handoff-markers.mjs';

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
// user than `uid` owns it or every user may write it, checked before it is made and again after, or a folder above it
// fails openAbove.
function ownState(state, checkouts, uid) {
  const resolved = resolvedPath(state);
  if (resolved === null || checkoutHolding(resolved, checkouts) || looseFolder(state, uid) !== null) return null;
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const real = realpathSync(state);
  if (!statSync(real).isDirectory() || checkoutHolding(real, checkouts) || looseFolder(real, uid) !== null || openAbove(real, uid)) return null;
  return real;
}

// Whether a folder above the real path `dir` lets a user other than `uid` rename or replace what lies below it: one is
// owned by another user than `uid` and root, or its group or every user may write it and it has no sticky bit, as
// OpenSSH's StrictModes holds the folders above a key. A shared folder such as /tmp, root's and sticky, passes. Never
// where the system has no user ids, as on Windows. Throws when a folder cannot be read.
function openAbove(dir, uid) {
  if (!Number.isInteger(uid)) return false;
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    const stat = statSync(current);
    if ((stat.uid !== uid && stat.uid !== 0) || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) return true;
    if (path.dirname(current) === current) return false;
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
  return !Number.isInteger(uid) || (looseFolder(dir, uid) === null && (stat.mode & 0o077) === 0);
}

// Whether the session folder `folder`, a real path sessionFolder gave, is still the folder it checked: its real path is
// still itself, so no folder above it was swapped for a symlink since, it passes privateFolder, and no folder above it
// fails openAbove. False for a folder that is missing or cannot be read. Every write, reservation, read, and sweep asks
// it first.
export function boundFolder(folder, { uid = processUid() } = {}) {
  try {
    return realpathSync(folder) === folder && privateFolder(folder, uid) && !openAbove(folder, uid);
  } catch {
    return false;
  }
}

// The text of the file `name`, one of SESSION_FILES, in `folder`, under the Reads rule (readOwnFile) and `cap`, as
// { text, stat }, or null: the name is not one of SESSION_FILES, `folder` fails boundFolder, or readOwnFile gives none.
export function readSessionFile(folder, name, { cap, uid = processUid() }) {
  if (!SESSION_FILES.includes(name) || !boundFolder(folder, { uid })) return null;
  return readOwnFile(path.join(folder, name), { cap, uid });
}

// The temporary file `name` in `folder` is written through: `.<name>.<pid>.<token>.tmp`, which SESSION_TEMPORARY matches.
export const temporaryName = (folder, name, token = newToken()) => path.join(folder, `.${name}.${process.pid}.${token}.tmp`);

// Writes `text` to the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave: to a new temporary
// file, opened only where nothing is and never through a symlink, mode 0600, then renamed over the file. Returns the
// file, or null when the name is not one of SESSION_FILES, `folder` fails boundFolder at the time of the write, or the
// write fails. Never throws. `token` is the temporary name's random part, which a test may fix.
export function writeSessionFile(folder, name, text, { token = newToken(), uid = processUid() } = {}) {
  if (!SESSION_FILES.includes(name) || !TOKEN.test(token) || !boundFolder(folder, { uid })) return null;
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

// Reserves the file `name`, one of SESSION_FILES, in `folder`, which sessionFolder gave, for the fixed window of `windowMs`
// that holds `now`, so that one process alone reads, checks, and writes it in that window: creates `<name>.<window>.lock`
// only where nothing is, never through a symlink, mode 0600. Nothing is ever taken over: a reservation a killed process
// left blocks only its own window. Returns the function that releases it, deleting the reservation while it is still the
// one this call made, or null when the name is not one of SESSION_FILES, `folder` fails boundFolder, any entry holds the
// name, or it cannot be made. Never throws.
export function reserveSessionFile(folder, name, { windowMs, now = Date.now(), uid = processUid() } = {}) {
  const index = Math.floor(now / windowMs);
  if (!SESSION_FILES.includes(name) || !Number.isSafeInteger(index) || index < 0 || !boundFolder(folder, { uid })) return null;
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
export function sweepSessions(sessions, { current, uid, now }) {
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
      sweepFolder(path.join(sessions, name), uid, now);
    } catch {
      // Gone already, changed meanwhile, or another session's sweep got it.
    }
  }
}

function sweepFolder(dir, uid, now) {
  if (!boundFolder(dir, { uid })) return;
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
