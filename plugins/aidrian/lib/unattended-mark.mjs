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
// gate files a pending mark, `pending.<old session>.json`, { pending, cwd, session, root, known, at }, which holds as
// unattended, wherever its calls run, every session that has no mark of its own and is neither the session that ran the
// gate nor one in `known`, the ids the host listed before the start, for PENDING_AGE at most. A session the host had not
// listed then cannot be told apart from the new one by anything a hook reads: no folder, since the new session may change
// to any, and no start time, which neither the hook's input nor the host's listing gives. So a session the Human starts
// in that window is held too. A pending mark with no `known` holds every session but the gate's. The gate removes it once
// the session's own mark is written, or when it knows nothing started; a launch whose outcome it cannot know keeps it
// until it lapses. A pending file it cannot read holds every session but none: the session it names cannot be told
// apart from another.
// A session a project run starts for an issue (lib/project-run-gate.mjs) carries the run and the issue in its mark,
// { root, at, project, issue }, so it is known as that issue's wherever it runs; such a session starts no continuation
// (lib/handoff-continue.mjs), so its chain is that one session.
// While a pending mark holds a session, the agent gate hook files its beacon, `beacon.<session>.json`, on its first tool
// call (noteBeacon): a host adapter that cannot otherwise tell whether the host runs this plugin's hooks for the session
// it started waits on it (lib/hosts/codex-exec.mjs). It lapses with the pending mark, at PENDING_AGE.

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
// A pending mark, named for the session that ran the gate; the dot keeps it apart from a mark under a short id.
const PENDING = /^pending\.[\w-]{1,128}\.json$/u;
const TEMPORARY = /^\.(?:pending\.|beacon\.)?[\w-]{1,128}\.json\.\d+\.[0-9a-f]{12}\.tmp$/u;
// The beacon of a session a pending mark holds, which the agent gate hook files on its first call (noteBeacon).
const BEACON = /^beacon\.[\w-]{1,128}\.json$/u;
const DAY = 24 * 60 * 60 * 1000;
// How long a mark holds, as long as the chain floor beside it.
export const MARK_AGE = 30 * DAY;
// How long a pending mark holds: past the host's longest start and listing, so it never lapses while the gate waits.
export const PENDING_AGE = 5 * 60 * 1000;
// The most session ids a pending mark keeps as known; a longer listing keeps none, and the mark holds every session.
const KNOWN_CAP = 1000;
// A mark this size or larger is never read for its root; it still counts as a mark.
const MARK_CAP = 64 * 1024;
// The tags a mark may carry: a project run's id and an issue key, as lib/project-run.mjs holds them, which imports this
// file through others; test/project-start-guard.test.mjs holds the copies equal.
export const RUN_TAG = /^[a-z0-9][a-z0-9-]{0,63}$/u;
export const ISSUE_TAG = /^(?:[A-Z][A-Z0-9]{0,15}-)?[1-9][0-9]{0,8}$/u;
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

// Files the mark of `session`, { root, cwd, at }, in markFolder(env), where `root` is the main checkout of the project the
// gate ran in and `cwd`, when absolute, the folder it started the session in, after sweeping marks past MARK_AGE. `tags`,
// { project, issue }, adds a project run's id and an issue key; a tag of a wrong shape writes nothing. Returns the file, or null when the session id cannot name a file, or the folder is a
// symlink, not a folder, or another user's, or the write fails. Never throws.
export function markUnattended(session, { root, cwd = null, env = process.env, now = Date.now(), tags = null } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || typeof root !== 'string' || !path.isAbsolute(root)) return null;
  const tagged = tags === null ? {} : tagsOf(tags);
  if (tagged === null) return null;
  try {
    const start = typeof cwd === 'string' && path.isAbsolute(cwd) ? { cwd } : {};
    return writeMark(ownFolder(env, now), `${session}.json`, { root, ...start, at: now, ...tagged });
  } catch {
    return null;
  }
}

// Files the pending mark of the gate run by `session`, which is about to start a session in the folder `cwd`, with
// `root` the main checkout of its project and `known` the ids of the sessions the host listed before the start: the
// file, or null, as markUnattended. With no usable `known`, the mark holds every session but `session`. Never throws.
export function markPending(session, { cwd, root, known, env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || [cwd, root].some((each) => typeof each !== 'string' || !path.isAbsolute(each))) return null;
  const ids = Array.isArray(known) && known.length <= KNOWN_CAP && known.every((id) => typeof id === 'string' && SESSION_ID.test(id)) ? [...new Set(known)] : null;
  try {
    return writeMark(ownFolder(env, now), `pending.${session}.json`, { pending: true, cwd, session, root, ...(ids ? { known: ids } : {}), at: now });
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

// The tags of a mark, { project, issue } with both or neither, or null when they have a wrong shape.
function tagsOf(value) {
  if (value?.project === undefined && value?.issue === undefined) return {};
  const ok = typeof value.project === 'string' && RUN_TAG.test(value.project) && typeof value.issue === 'string' && ISSUE_TAG.test(value.issue);
  return ok ? { project: value.project, issue: value.issue } : null;
}

// The mark of `session`, { root, cwd }, where `root` is the main checkout the gate named, or null when it named none
// that can be read, and `cwd` the folder it started the session in, when the mark names one; null when no mark holds.
// A mark that carries a project run's tags adds `project` and `issue`; one whose tags have a wrong shape adds
// `issue: null` and `project: null`, so a reader that refuses any session with an issue refuses it. It reads each of
// markFolders the session's own mark and every mark under a short id it starts with. A mark of another user, or one past MARK_AGE, does not hold; an entry or a folder it cannot check does.
// With no mark of its own, a pending mark holds the session, wherever its call runs, as { root, cwd, pending: true }, with
// `cwd` the folder the gate starts the new session in, unless it ran the gate or the host listed it before the start.
export function readUnattendedMark(session, { env = process.env, home, now = Date.now() } = {}) {
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
  return pendingHold(pending, session, uid, now);
}

// Whether an unattended mark, or a pending one, that holds names one of `roots`, the checkouts of a project, as its main
// checkout: a session no Human attends, or one a gate is starting, belongs to that project. A mark or a folder that
// cannot be read counts. lib/handoff-guard.mjs asks it only while the base branch's config cannot be read.
export function marksNaming(roots, { env = process.env, home, now = Date.now() } = {}) {
  const wanted = new Set(roots.filter((each) => typeof each === 'string').map((each) => path.resolve(each)));
  const uid = processUid();
  for (const folder of markFolders({ env, home })) {
    let names;
    try {
      names = readdirSync(folder);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      return true;
    }
    for (const name of names) {
      const file = path.join(folder, name);
      let found = null;
      if (PENDING.test(name)) found = readPending(file, uid, now);
      else if (MARK.test(name)) found = readMark(file, uid, now);
      if (found === 'unchecked' || (found && found.root === null)) return true;
      if (found && wanted.has(path.resolve(found.root))) return true;
    }
  }
  return false;
}

// Files the beacon of `session`, `beacon.<session>.json`, { session, at }, in markFolder(env), once, when a pending mark
// there holds the session or its own mark there names an issue of a project run: the proof a host's start adapter waits
// on that the host runs this plugin's hooks for the session it started, since the agent gate hook files it on that
// session's first tool call (scripts/hook-agent-gates.mjs), before or after the gate has filed its mark. Only the folder
// the gate files marks in counts, so a call never writes in another folder. Returns the file, or null when neither holds
// the session there, the beacon is there already, or the write fails. Never throws.
export function noteBeacon(session, { env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  try {
    const folder = markFolder(env);
    const stat = lstatSync(folder);
    const uid = processUid();
    if (!stat.isDirectory() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
    const names = readdirSync(folder);
    const name = `beacon.${session}.json`;
    if (names.includes(name)) return null;
    const pending = names.filter((each) => PENDING.test(each)).map((each) => path.join(folder, each));
    const own = names.includes(`${session}.json`) ? readMark(path.join(folder, `${session}.json`), uid, now) : null;
    if (!pendingHold(pending, session, uid, now) && !(own && own !== 'unchecked' && own.issue)) return null;
    return writeMark(folder, name, { session, at: now });
  } catch {
    return null;
  }
}

// Whether a beacon of `session` (noteBeacon) written at `since` or later is in one of markFolders: a regular file of
// this user, under MARK_CAP, that names the session. `home` is a test's, as in markFolders.
export function readBeacon(session, { env = process.env, home, since = 0 } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  const uid = processUid();
  for (const folder of markFolders({ env, home })) {
    const file = path.join(folder, `beacon.${session}.json`);
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size >= MARK_CAP || (Number.isInteger(uid) && stat.uid !== uid)) continue;
    const value = readJson(file);
    if (isObject(value) && value.session === session && Number.isFinite(value.at) && value.at >= since) return true;
  }
  return false;
}

// The hold of the first of the pending marks `files` that holds `session`, or null.
function pendingHold(files, session, uid, now) {
  for (const file of files) {
    const found = readPending(file, uid, now);
    if (found === null) continue;
    if (found === 'unchecked') return { root: null, pending: true };
    if (found.session === session || found.known?.includes(session)) continue;
    return { root: found.root, cwd: found.cwd, pending: true };
  }
  return null;
}

// One pending mark: { session, root, cwd, known } when it holds, null when it does not, or 'unchecked' when it holds and
// cannot be read. `known` is null when the mark names none.
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
    && [value.cwd, value.root].every((each) => typeof each === 'string' && path.isAbsolute(each))
    && (value.known === undefined || (Array.isArray(value.known) && value.known.every((id) => typeof id === 'string')));
  return fits ? { session: value.session, root: value.root, cwd: value.cwd, known: value.known ?? null } : 'unchecked';
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
  if (!stat.isFile() || stat.size >= MARK_CAP) return { root: null };
  return markOf(readJson(file));
}

// What a mark's value names: { root } with the main checkout or null, `cwd` when it names the folder the gate started the
// session in, plus its tags when it carries any. A reader that must know whether the session works an issue counts
// `root: null` as one it cannot tell.
function markOf(value) {
  if (!isObject(value)) return { root: null };
  const root = typeof value.root === 'string' && path.isAbsolute(value.root) ? value.root : null;
  const start = root !== null && typeof value.cwd === 'string' && path.isAbsolute(value.cwd) ? { cwd: value.cwd } : {};
  const tags = tagsOf(value);
  return { root, ...start, ...(tags ?? { project: null, issue: null }) };
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
  const ages = [[MARK, MARK_AGE], [PENDING, PENDING_AGE], [BEACON, PENDING_AGE], [TEMPORARY, DAY]];
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
