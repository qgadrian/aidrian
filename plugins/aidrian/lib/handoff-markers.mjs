// The continuation store: the markers that carry a handoff brief from the session that wrote it to the session that
// resumes it, in `<state>/handoffs/.continue/` (docs/handoff.md#continue). `aidrian handoff check` stamps a brief that
// passed, the gate (lib/handoff-continue.mjs) arms it, and the hooks promote, take, and note it.
//   checked-<brief name>.json  { sha256, at }                                       the brief that passed the check
//   armed-<session>.json       { route, session, brief, slug, chain, sha256, armed_at }
//   ready-<session>.json       the armed marker, plus ended_at and host_pid          after the session ended by a clear
//   from-<session>.json        { slug, chain, brief, route, at }                      the chain floor of a session
// A subagent may write none of them (lib/handoff-guard.mjs), so the store's own rules keep a stray file harmless:
// every write is a temporary file and a rename; every read refuses a symlink, a file another user owns, a wrong shape,
// and a time outside its window, on the recorded field and on the file's own modification time, in the past or the
// future; and a store that resolves inside a checkout of the repository, as with `state.dir` set to a folder in it, or
// whose state, handoffs, or store folder another user owns or every user may write, is never written or read.
// No function throws on a missing folder; a read returns null for anything it cannot use.

import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { CONTINUE_ROUTES } from './config-schema.mjs';
import { checkoutHolding, foldCase, isObject, processUid, resolvedPath } from './fs.mjs';

// A session id that may name a file.
export const SESSION_ID = /^[\w-]{1,128}$/u;
// The one slug pattern of every route, held at the gate and on every read.
export const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
// The name of a brief the gate takes: `<UTC date>-<slug>.md`.
export const BRIEF_FILE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/u;
// A brief this size or larger is never read, at the gate or at delivery.
export const BRIEF_CAP = 256 * 1024;
// How long after its session ended a ready marker may be taken.
export const READY_WINDOW = 10 * 1000;
// Whether `text`, a path, holds a character that could end or forge a line in what a session reads: a C0 or C1 control,
// or a Unicode line or paragraph separator. Such a path is never armed, delivered, or printed.
export const hasControl = (text) => /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(String(text));
// A marker file larger than this is never read: the store's own markers are a few hundred bytes, and a hook may read
// one each step of its wait.
export const MARKER_CAP = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const DAY = 24 * 60 * 60 * 1000;
// How long each kind of file lives: a read past it ignores the file, and the sweep deletes it.
const AGES = { armed: DAY, ready: DAY, checked: DAY, tasks: DAY, taken: DAY, from: 30 * DAY, gone: 30 * DAY };
const KIND = /^(armed|ready|checked|tasks|taken|from|gone)-/u;
// The names of the files the store writes, and of its temporary files: the sweep deletes nothing else.
const SESSION_PART = String.raw`[\w-]{1,128}`;
const BRIEF_PART = String.raw`\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.md`;
const STORE_FILE = new RegExp(String.raw`^(?:(?:armed|ready|tasks|from|gone)-${SESSION_PART}|checked-${BRIEF_PART}|taken-${SESSION_PART}\.\d+\.[0-9a-f]{12})\.json$`, 'u');
// The names of the files whose forgery would arm or deliver a continuation: lib/handoff-guard.mjs refuses a subagent's
// write of one in any folder it cannot place.
export const ARMING_FILE = new RegExp(String.raw`^(?:(?:armed|ready|gone)-${SESSION_PART}|checked-${BRIEF_PART}|taken-${SESSION_PART}\.\d+\.[0-9a-f]{12})\.json$`, 'u');
const TEMPORARY = /^\.(.+)\.\d+\.[0-9a-f]{12}\.tmp$/u;
// No read follows a symlink, and none waits on a FIFO or a device that has no writer.
const NO_FOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

// `<state>/handoffs/.continue`: the folder of the store, as a subagent's writes are guarded against it.
export const storePath = (state) => path.join(state, 'handoffs', '.continue');

// The slug of a brief's file name: its part after the date, or the name without `.md` when it has no date.
export function slugOf(name) {
  const base = path.basename(String(name));
  return BRIEF_FILE.exec(base)?.[2] ?? base.replace(/\.md$/u, '');
}

// The store of the state folder `state`: { dir, handoffs, maxChain, uid, refused }. `dir` is the real path of the
// store's folder. `refused` says why no marker may be written or read there, or is null: the store's folder is a
// symlink; it resolves inside one of `checkouts`, compared in the case the disk folds to, since a real path keeps the
// case it was spelled in; or `state`, its handoffs folder, or the store's folder is owned by another user than `uid` or
// writable by every user, where the system has user ids. A folder its group may write passes: a umask of 002 is common. A folder not made yet passes,
// and the store makes its own folder for its owner alone. `maxChain` is session.handoff.maxChain, which bounds every
// chain a marker holds. `uid` is this process's user, null where the system has none, and every read refuses a marker
// or a brief another user owns.
export function openStore(state, { checkouts = [], maxChain, uid = processUid() }) {
  const handoffs = path.join(state, 'handoffs');
  const real = resolvedPath(storePath(state));
  const checkout = real && checkoutHolding(real, checkouts);
  let refused = null;
  if (real === null) refused = `the continuation store ${storePath(state)} is behind a broken symlink`;
  else if (isLink(storePath(state))) refused = `the continuation store ${storePath(state)} is a symlink, and no continuation marker is kept behind one`;
  else if (checkout) refused = `the continuation store ${real} is inside the checkout ${checkout}, where no continuation marker is kept; move state.dir out of the repository`;
  else {
    const loose = [state, handoffs, storePath(state)].map((dir) => [dir, looseFolder(dir, uid)]).find(([, why]) => why);
    if (loose) refused = `the folder ${loose[0]} of the continuation store ${loose[1]}, so no continuation marker is kept there; make it the user's own, writable by that user alone`;
  }
  return Object.freeze({ dir: real ?? storePath(state), handoffs, maxChain, uid, refused });
}

// Whether a stat names a file of another user than `uid`; never where the system has no user ids.
const foreign = (stat, uid) => Number.isInteger(uid) && stat.uid !== uid;

// Why the folder `dir` cannot hold the store, or null: another user than `uid` owns it, or every user may write it.
// Both checks hold only where the system has user ids: Windows has none, and Node reports its writable folders with the
// other-write bit set, so there the mode tells nothing.
// A folder that is not there, or cannot be read, gives null: the store's own checks then refuse what they cannot read.
// lib/session-folder.mjs holds its folders to the same rule.
export function looseFolder(dir, uid) {
  if (!Number.isInteger(uid)) return null;
  let stat;
  try {
    stat = statSync(dir);
  } catch {
    return null;
  }
  if (foreign(stat, uid)) return `is owned by another user (uid ${stat.uid})`;
  if ((stat.mode & 0o002) !== 0) return 'is writable by every user';
  return null;
}

function isLink(file) {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// The brief at `file` as the gate and the delivery take it: { path, bytes, mtimeMs } when its real path is a regular
// file right inside the store's handoffs folder, not a symlink, owned by the store's user, named by BRIEF_FILE, and
// under BRIEF_CAP, all checked before it is read; else { problem }. The bytes are read once, from the file that was checked.
export function readContainedBrief({ handoffs, uid }, file) {
  const place = briefPlace(handoffs, file);
  if (place.problem) return place;
  let fd;
  try {
    fd = openSync(place.path, NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { problem: 'is not a regular file' };
    if (foreign(stat, uid)) return { problem: `is owned by another user (uid ${stat.uid}), and the gate reads no brief of another user` };
    if (stat.size >= BRIEF_CAP) return { problem: `is ${stat.size} bytes, and the gate reads no brief of ${BRIEF_CAP} bytes or more` };
    return { path: place.path, bytes: readFileSync(fd), mtimeMs: stat.mtimeMs };
  } catch (error) {
    return { problem: error.code === 'ENOENT' ? 'does not exist' : `cannot be read (${error.code ?? 'unreadable'})` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// { path } when `file` is a regular file and no symlink, the folder of its real path is the `handoffs` folder, and its
// name is a brief's; else { problem }.
function briefPlace(handoffs, file) {
  try {
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) return { problem: 'is a symlink' };
    if (!stat.isFile()) return { problem: 'is not a regular file' };
    const real = realpathSync(file);
    if (!sameFolder(path.dirname(real), handoffs)) return { problem: `is not in ${handoffs}` };
    if (!BRIEF_FILE.test(path.basename(real))) return { problem: 'is not named <UTC date>-<slug>.md' };
    return { path: real };
  } catch (error) {
    return { problem: error.code === 'ENOENT' ? `does not exist, or ${handoffs} does not` : `cannot be read (${error.code ?? 'unreadable'})` };
  }
}

// Whether the real folder `real` is the folder `dir`, by identity: the same device and inode, which every spelling of
// one folder shares. A real path keeps the letter case it was given, so on a disk that folds case two spellings of one
// folder differ as text. Where the disk reports no inode, as some Windows disks do, the real paths compare in the case
// the disk folds to.
function sameFolder(real, dir) {
  const [one, other] = [statSync(real, { bigint: true }), statSync(dir, { bigint: true })];
  if (one.dev !== other.dev) return false;
  if (one.ino !== 0n || other.ino !== 0n) return one.ino === other.ino;
  return foldCase(real) === foldCase(realpathSync(dir));
}

// Whether `t` is a time no later than `now` and at most `window` before it.
export const fresh = (t, now, window) => Number.isFinite(t) && now - t >= 0 && now - t <= window;
const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const isPid = (value) => Number.isInteger(value) && value > 1;
const sessionFile = (kind, session) => (typeof session === 'string' && SESSION_ID.test(session) ? `${kind}-${session}.json` : null);

// Whether `brief` is an absolute path to a brief of `slug`.
const briefOf = (brief, slug) => typeof brief === 'string' && path.isAbsolute(brief) && !brief.includes('\0')
  && BRIEF_FILE.test(path.basename(brief)) && slugOf(brief) === slug;

function isArmed(value, maxChain) {
  return isObject(value) && CONTINUE_ROUTES.includes(value.route) && value.route !== 'none' && typeof value.session === 'string'
    && SESSION_ID.test(value.session) && typeof value.slug === 'string' && SLUG.test(value.slug) && whole(value.chain, 0, maxChain)
    && typeof value.sha256 === 'string' && SHA256.test(value.sha256) && briefOf(value.brief, value.slug) && Number.isFinite(value.armed_at);
}

const isReady = (value, maxChain) => isArmed(value, maxChain) && Number.isFinite(value.ended_at) && isPid(value.host_pid);

const isFrom = (value, maxChain) => isObject(value) && CONTINUE_ROUTES.includes(value.route) && typeof value.slug === 'string'
  && SLUG.test(value.slug) && whole(value.chain, 0, maxChain) && briefOf(value.brief, value.slug) && Number.isFinite(value.at);

const isChecked = (value) => isObject(value) && typeof value.sha256 === 'string' && SHA256.test(value.sha256) && Number.isFinite(value.at);

// The marker in the file `name` of the store, or null: when the store is refused, the file is missing, a symlink, no
// regular file, owned by another user, or larger than MARKER_CAP, its modification time or `value[field]` is outside
// `window`, or `shape` refuses it.
function readMarker(store, name, { now, field, window = AGES[KIND.exec(name)?.[1]] ?? DAY, shape }) {
  if (store.refused || !name) return null;
  const read = readOwnFile(path.join(store.dir, name), { cap: MARKER_CAP, uid: store.uid });
  if (!read || !fresh(Math.floor(read.stat.mtimeMs), now, window)) return null;
  try {
    const value = JSON.parse(read.text);
    return shape(value, store.maxChain) && fresh(value[field], now, window) ? value : null;
  } catch {
    return null;
  }
}

// The text of `file` and its stat, { text, stat }, or null when it is missing, a symlink, no regular file, owned by
// another user than `uid`, or larger than `cap` bytes. It is opened no-follow and non-blocking, so no read follows a
// symlink or waits on a FIFO, and at most the size fstat gave is read, so a file that grows meanwhile stays under the cap.
export function readOwnFile(file, { cap, uid = processUid() }) {
  let fd;
  try {
    if (!lstatSync(file).isFile()) return null;
    fd = openSync(file, NO_FOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || foreign(stat, uid) || stat.size > cap) return null;
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    for (let n = 1; n > 0 && read < bytes.length; read += n) n = readSync(fd, bytes, read, bytes.length - read, read);
    return { text: bytes.subarray(0, read).toString('utf8'), stat };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Writes `value` to the file `name` of the store, through a temporary file and a rename. Returns the file, or null when
// the store is refused. Creates the folder; throws only on a write the disk refuses.
function writeMarker(store, name, value) {
  if (store.refused || !name) return null;
  mkdirSync(store.dir, { recursive: true, mode: 0o700 });
  const file = path.join(store.dir, name);
  const temporary = path.join(store.dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return file;
}

function remove(store, name) {
  if (store.refused || !name) return;
  rmSync(path.join(store.dir, name), { force: true });
}

// Arms `marker`, { route, session, brief, slug, chain, sha256 }, for its session, over any marker armed before.
// Returns the file, or null when the store is refused or the marker has a wrong shape.
export function arm(store, marker, { now = Date.now() } = {}) {
  const value = { route: marker.route, session: marker.session, brief: marker.brief, slug: marker.slug, chain: marker.chain, sha256: marker.sha256, armed_at: now };
  return isArmed(value, store.maxChain) ? writeMarker(store, sessionFile('armed', value.session), value) : null;
}

// The marker `session` armed, or null.
export function readArmed(store, session, { now = Date.now() } = {}) {
  const marker = readMarker(store, sessionFile('armed', session), { now, field: 'armed_at', shape: isArmed });
  return marker?.session === session ? marker : null;
}

// Deletes the marker `session` armed, when its route is `route` or no route is given. Returns what it deleted, or null.
export function cancelArmed(store, session, { route, now = Date.now() } = {}) {
  const marker = readArmed(store, session, { now });
  if (!marker || (route !== undefined && marker.route !== route)) return null;
  remove(store, sessionFile('armed', session));
  return marker;
}

// When `session` ends by a clear: its armed marker of route `clear` becomes its ready marker, with `ended_at` and
// `host_pid`, the host process the ending hook ran under. Any other armed marker of the session is deleted, as is a
// `clear` one with no host process to bind it to: the session is over. Returns the ready marker, or null.
export function promote(store, session, { hostPid, now = Date.now() } = {}) {
  const marker = readArmed(store, session, { now });
  if (!marker) return null;
  const ready = marker.route === 'clear' && isPid(hostPid) ? { ...marker, ended_at: now, host_pid: hostPid } : null;
  if (ready) writeMarker(store, sessionFile('ready', session), ready);
  remove(store, sessionFile('armed', session));
  return ready;
}

// Claims the newest ready marker of the host process `hostPid` whose session ended at most READY_WINDOW ago, by
// renaming it, so of two callers one gets it and the other null. Returns the marker, or null.
export function takeReady(store, { hostPid, now = Date.now() } = {}) {
  if (store.refused || !isPid(hostPid)) return null;
  const read = (name) => {
    const marker = readMarker(store, name, { now, field: 'ended_at', window: READY_WINDOW, shape: isReady });
    return marker?.host_pid === hostPid ? marker : null;
  };
  const candidates = listStore(store)
    .filter((name) => /^ready-[\w-]{1,128}\.json$/u.test(name))
    .map((name) => [name, read(name)])
    .filter(([name, marker]) => marker && name === sessionFile('ready', marker.session))
    .sort(([, a], [, b]) => b.ended_at - a.ended_at);
  for (const [name] of candidates) {
    const claimed = `taken-${name.slice('ready-'.length, -'.json'.length)}.${process.pid}.${randomBytes(6).toString('hex')}.json`;
    try {
      renameSync(path.join(store.dir, name), path.join(store.dir, claimed));
    } catch {
      continue;
    }
    const marker = read(claimed);
    remove(store, claimed);
    if (marker) return marker;
  }
  return null;
}

const ARMED_FILE = new RegExp(String.raw`^armed-(${SESSION_PART})\.json$`, 'u');

// What the store holds for a session start after a clear, from one listing: { listed, armed }. `listed` is whether any
// armed or ready file is there at all; `armed`, whether some session has a well-formed `clear` marker armed, so its
// session end may still promote it.
export function clearPending(store, { now = Date.now() } = {}) {
  const names = store.refused ? [] : listStore(store);
  const listed = names.some((name) => /^(?:armed|ready)-/u.test(name));
  const armed = listed && names.some((name) => {
    const session = ARMED_FILE.exec(name)?.[1];
    return session !== undefined && readArmed(store, session, { now })?.route === 'clear';
  });
  return { listed, armed };
}

// Records the chain floor of `session`, { slug, chain, brief, route }, which `aidrian handoff check` holds it to.
export function noteFrom(store, session, { slug, chain, brief, route }, { now = Date.now() } = {}) {
  const value = { slug, chain, brief, route, at: now };
  return isFrom(value, store.maxChain) ? writeMarker(store, sessionFile('from', session), value) : null;
}

// The chain floor `session` was given, or null.
export function readFrom(store, session, { now = Date.now() } = {}) {
  return readMarker(store, sessionFile('from', session), { now, field: 'at', shape: isFrom });
}

const checkedFile = (name) => (BRIEF_FILE.test(name) && SLUG.test(slugOf(name)) ? `checked-${name}.json` : null);

// Stamps the brief at `briefPath` as passed, with the sha256 of the bytes that passed, when it is a brief right inside
// the store's handoffs folder. Returns the file, or null.
export function stampChecked(store, briefPath, sha256, { now = Date.now() } = {}) {
  const place = briefPlace(store.handoffs, briefPath);
  if (place.problem || !SHA256.test(sha256)) return null;
  return writeMarker(store, checkedFile(path.basename(place.path)), { sha256, at: now });
}

// The sha256 of the brief named `name` when it last passed the check, or null.
export function checkedSha(store, name, { now = Date.now() } = {}) {
  return readMarker(store, checkedFile(name), { now, field: 'at', shape: isChecked })?.sha256 ?? null;
}

// Deletes each file the store wrote that is past its kind's age, a leftover temporary file of its own included, and
// nothing else. Never throws.
export function sweep(store, now = Date.now()) {
  if (store.refused) return;
  for (const name of listStore(store)) {
    const temporary = TEMPORARY.exec(name)?.[1];
    if (!STORE_FILE.test(temporary ?? name)) continue;
    const age = temporary ? DAY : AGES[KIND.exec(name)[1]];
    try {
      const file = path.join(store.dir, name);
      if (now - Math.floor(lstatSync(file).mtimeMs) > age) unlinkSync(file);
    } catch {
      // Gone already, or another sweep got it.
    }
  }
}

function listStore(store) {
  try {
    return readdirSync(store.dir);
  } catch {
    return [];
  }
}
