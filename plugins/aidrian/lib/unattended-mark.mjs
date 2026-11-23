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
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { attemptOf } from './attempt-clone.mjs';
import { exists, isObject } from './fs.mjs';
import { SESSION_ID } from './handoff-markers.mjs';
import { stateRoot } from './project.mjs';

// The folder's name under the state root; lib/handoff-guard.mjs guards it by this name too.
export const MARK_FOLDER = 'unattended';
// A short id a mark may be filed under, as a chain floor may (lib/handoff-markers.mjs).
const SHORT = /^([0-9A-Za-z][0-9A-Za-z-]{3,63})\.json$/u;
const MARK = /^[\w-]{1,128}\.json$/u;
// A pending mark, named for the session that ran the gate; the dot keeps it apart from a mark under a short id.
const PENDING = /^pending\.[\w-]{1,128}\.json$/u;
const TEMPORARY = /^\.(?:pending\.|beacon\.|driver\.|attended\.)?[\w-]{1,128}\.json\.\d+\.[0-9a-f]{12}\.tmp$/u;
// A session's attended record (liftAttended), swept with the marks it lifts.
const ATTENDED_FILE = /^attended\.[\w-]{1,128}\.json$/u;
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
// The states a mark's `confine` tag takes (lib/project-confine.mjs): owed, passed, or failed.
export const CONFINE_STATES = Object.freeze([true, 'passed', 'failed']);
// The proof plan a project run's start writes in an attempt's folder (lib/project-confine.mjs).
export const CONFINE_PLAN = 'confine-plan.json';
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
// { project, issue, confine? }, adds a project run's id, an issue key, and the state of the session's sandbox proof;
// a tag of a wrong shape writes nothing. Returns the file, or null when the session id cannot name a file, or the folder is a
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

// Files the driver mark of `session`, `driver.<session>.json`, { role: 'driver', run, root, state, at }, in
// markFolder(env): the session drives the project run `run` of the main checkout `root`, whose ledger is in the state
// folder `state`, by its real path. `aidrian project init` files it before its init row, and the current driver files it
// again on each start and wait, as custody does for the continuation it moves to (lib/project-run-gate.mjs). It is
// never swept: it holds until the run's ledger records its end (run-driver.mjs). Returns the file, or null as
// markUnattended. Never throws.
export function markDriver(session, { run, root, state, env = process.env, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session) || typeof run !== 'string' || !RUN_TAG.test(run)) return null;
  if ([root, state].some((each) => typeof each !== 'string' || !path.isAbsolute(each))) return null;
  try {
    return writeMark(ownFolder(env, now), `driver.${session}.json`, { role: 'driver', run, root, state, at: now });
  } catch {
    return null;
  }
}

// The driver mark of `session` (markDriver), read in each of markFolders, the session's own id only, whatever its age:
// { run, root, state } when one is there and reads whole; with `run`, `root`, and `state` null for what cannot be read,
// which holds the session too; null when none is there. A mark of another user does not hold. `home` is a test's, as in
// markFolders.
export function readDriverMark(session, { env = process.env, home } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  const uid = processUid();
  for (const folder of markFolders({ env, home })) {
    const file = path.join(folder, `driver.${session}.json`);
    let stat;
    try {
      stat = lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue;
      return { run: null, root: null, state: null };
    }
    if (Number.isInteger(uid) && stat.uid !== uid) continue;
    const value = stat.isFile() && stat.size < MARK_CAP ? readJson(file) : null;
    const absolute = (each) => typeof each === 'string' && path.isAbsolute(each);
    const fits = isObject(value) && value.role === 'driver' && typeof value.run === 'string' && RUN_TAG.test(value.run) && absolute(value.root);
    if (!fits) return { run: null, root: null, state: null };
    return { run: value.run, root: value.root, state: absolute(value.state) ? value.state : null };
  }
  return null;
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

// The tags of a mark, { project, issue } with both or neither, and, with both, `confine` when the session's start
// proves its sandbox from inside it (lib/project-confine.mjs): true while that proof is owed, 'passed' once the start
// confirmed it, or 'failed'; or null when they have a wrong shape.
function tagsOf(value) {
  if (value?.project === undefined && value?.issue === undefined && value?.confine === undefined) return {};
  const ok = typeof value.project === 'string' && RUN_TAG.test(value.project) && typeof value.issue === 'string' && ISSUE_TAG.test(value.issue);
  if (!ok || (value.confine !== undefined && !CONFINE_STATES.includes(value.confine))) return null;
  return { project: value.project, issue: value.issue, ...(value.confine === undefined ? {} : { confine: value.confine }) };
}

// The mark of `session`, { root, cwd }, where `root` is the main checkout the gate named, or null when it named none
// that can be read, and `cwd` the folder it started the session in, when the mark names one; null when no mark holds.
// A mark that carries a project run's tags adds `project` and `issue`; one whose tags have a wrong shape adds
// `issue: null` and `project: null`, so a reader that refuses any session with an issue refuses it. It reads each of
// markFolders the session's own mark and every mark under a short id it starts with, and gives the most restrictive
// (restriction): a mark of another user, or one past MARK_AGE, does not hold; an entry or a folder it cannot check holds
// as { root: null }. With no mark of its own, or with only plain ones the Human's presence lifted (isAttended), a pending
// mark holds the session, wherever its call runs, as { root, cwd, pending: true }, with `cwd` the folder the gate starts
// the new session in, unless it ran the gate or the host listed it before the start.
export function readUnattendedMark(session, { env = process.env, home, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return null;
  const { holds, pending, unchecked } = scanMarks(session, { env, home, now });
  const found = holds.map(({ mark }) => mark);
  // A proof owed only by its attempt's plan yields to the state another mark records for that attempt.
  const recorded = new Set(found.filter((mark) => mark.confine !== undefined).map((mark) => proofStateOf(mark)?.attempt?.folder).filter(Boolean));
  const inferred = (mark) => mark.confine === undefined && recorded.has(proofStateOf(mark)?.attempt?.folder);
  const marks = [...(unchecked ? [{ root: null }] : []), ...found.filter((mark) => !inferred(mark))];
  const held = marks.reduce((most, mark) => (most === null || restriction(mark) > restriction(most) ? mark : most), null);
  if (held && !(plainMark(held) && isAttended(session, { env, home, now }))) return held;
  return pendingHold(pending, session, processUid(), now);
}

// How much a mark of a session's own refuses, so the scan gives the most: by the proof the agent gate hook holds it to
// (proofStateOf), a failed sandbox proof, which runs nothing, then an owed one, then a passed one, whose plan still hides
// its denied stores from every file-tool read; then a mark it cannot read, then an issue's, then a plain one.
// What holds a mark that holds no proof of its own, a call's folder in an attempt's clone, cannot be ranked here.
const PROOF_RANK = new Map([['failed', 5], [true, 4], ['passed', 3]]);
function restriction(mark) {
  const proof = proofStateOf(mark);
  if (proof) return PROOF_RANK.get(proof.state);
  if (mark.root === null) return 2;
  return plainMark(mark) ? 0 : 1;
}

// The sandbox proof the session's own mark `mark` (readUnattendedMark) holds it to, as the agent gate hook reads it
// (confine-guard.mjs proofHold): { attempt, state }, where `attempt` is the attempt of the folder the mark started the
// session in, or null, and `state` its confine state, true while owed, a state of a wrong shape counting as failed.
// An issue mark with no state owes the proof when the start wrote a proof plan beside its attempt's clone. Null when the
// mark holds no proof: none, a pending one, one with no readable main checkout, or a plain or proof-less one.
export function proofStateOf(mark) {
  if (!isObject(mark) || mark.pending || typeof mark.root !== 'string') return null;
  const attempt = typeof mark.cwd === 'string' ? attemptOf(mark.cwd) : null;
  if (mark.confine !== undefined) return { attempt, state: CONFINE_STATES.includes(mark.confine) ? mark.confine : 'failed' };
  return mark.issue && attempt && exists(path.join(attempt.folder, CONFINE_PLAN)) ? { attempt, state: true } : null;
}

// Every mark of `session`'s own that holds, under its full id or a short one, in each of markFolders, as `holds`,
// [{ mark, folder }]; the pending marks of those folders, as `pending`; and `unchecked`, whether an entry or a folder
// could not be checked.
function scanMarks(session, { env, home, now }) {
  const uid = processUid();
  const holds = [];
  const pending = [];
  let unchecked = false;
  for (const folder of markFolders({ env, home })) {
    let names;
    try {
      names = readdirSync(folder);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') unchecked = true;
      continue;
    }
    for (const name of names.filter((each) => each === `${session}.json` || (SHORT.exec(each)?.[1] !== undefined && session.startsWith(SHORT.exec(each)[1])))) {
      const mark = readMark(path.join(folder, name), uid, now);
      if (mark === 'unchecked') unchecked = true;
      else if (mark) holds.push({ mark, folder });
    }
    pending.push(...names.filter((name) => PENDING.test(name)).map((name) => path.join(folder, name)));
  }
  return { holds, pending, unchecked };
}

// The most of a transcript's end liftAttended reads: the gate asks on every tool call, so a prompt the Human typed since
// the last call is near the end.
export const PROMPT_TAIL = 256 * 1024;
// The record that the Human has typed into a session, `attended.<session>.json` in markFolder: the dot keeps it apart
// from a mark under a short id, and the marks folder is one no unattended session writes (lib/unattended-write.mjs).
const ATTENDED = (session) => `attended.${session}.json`;

// Whether `mark` (readUnattendedMark's own mark of a session) is a plain background mark the Human's presence lifts: no
// project run's issue, no sandbox proof it tracks, and a main checkout it could read.
const plainMark = (mark) => mark.root !== null && mark.project === undefined && mark.issue === undefined && mark.confine === undefined;

// Whether the Human has typed into `session` (liftAttended): its attended record, of this user, within MARK_AGE, is in
// one of markFolders. readUnattendedMark then reads its plain mark as none, and a background floor no longer holds it
// (handoff-guard.mjs startedUnattended, handoff-continue.mjs). Never throws.
export function isAttended(session, { env = process.env, home, now = Date.now() } = {}) {
  if (typeof session !== 'string' || !SESSION_ID.test(session)) return false;
  return markFolders({ env, home }).some((folder) => attendedIn(folder, session, now));
}

// Whether the attended record of `session`, of this user, within MARK_AGE, is in `folder`.
function attendedIn(folder, session, now) {
  const uid = processUid();
  try {
    const stat = lstatSync(path.join(folder, ATTENDED(session)));
    return stat.isFile() && (!Number.isInteger(uid) || stat.uid === uid) && now - Math.floor(stat.mtimeMs) <= MARK_AGE;
  } catch {
    return false;
  }
}

// Records that the Human has typed into `session`, a background continuation, so it is attended from then on
// (docs/handoff.md#the-background-route). `file` is the real path of the session's own transcript, where the session
// cannot write, and `isHuman(entry)` says whether an entry is a prompt the Human typed after the start, both from the
// session's host adapter (hosts/index.mjs humanPrompts); a peer's message, a scheduled prompt, and the start prompt
// never are. Only a session whose every mark is plain is lifted: a project run's issue mark, a mark that tracks a
// sandbox proof, a mark it cannot read, and a pending hold that holds it, one it cannot read included, stay, whoever
// types, read again after the transcript so a hold filed meanwhile counts too.
// The record goes beside each plain mark that holds it, so a reader of either folder sees it, after a sweep of
// that folder. A session already recorded in each of those folders is attended as it is: neither its transcript is read
// nor its record written again. Otherwise it reads at most PROMPT_TAIL bytes of the transcript's end, from the regular
// file the path names when it opens it. Returns whether the session is recorded attended; never throws.
export function liftAttended(session, file, { env = process.env, home, now = Date.now(), isHuman = () => false, still = () => true } = {}) {
  try {
    if (typeof session !== 'string' || !SESSION_ID.test(session) || typeof file !== 'string' || !path.isAbsolute(file)) return false;
    // The folders to record the session attended in, or null when a hold other than plain marks holds it.
    const unrecorded = () => {
      const { holds, pending, unchecked } = scanMarks(session, { env, home, now });
      if (unchecked || !holds.length || !holds.every(({ mark }) => plainMark(mark)) || pendingHold(pending, session, processUid(), now)) return null;
      return [...new Set(holds.map(({ folder }) => folder))].filter((folder) => !attendedIn(folder, session, now));
    };
    const before = unrecorded();
    if (!before?.length) return before !== null;
    if (!tailEntries(file).some((entry) => isHuman(entry)) || !still()) return false;
    // Read again after the transcript: a hold filed meanwhile still holds.
    const missing = unrecorded();
    if (!missing) return false;
    for (const folder of missing) {
      if (!trustedFolder(folder)) return false;
      sweepMarks(folder, now);
      if (writeMark(folder, ATTENDED(session), { at: now }) === null) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Whether `folder` is a marks folder a lift may write and sweep: a real folder, no link, of this user, as ownFolder holds.
function trustedFolder(folder) {
  const stat = lstatSync(folder);
  const uid = processUid();
  return stat.isDirectory() && (!Number.isInteger(uid) || stat.uid === uid);
}

// The entries of the last PROMPT_TAIL bytes of the regular JSONL file `file`, the cut first line left out: the file the
// descriptor opened must be the one the path names now, so a swap between the check and the read reads nothing.
function tailEntries(file) {
  const fd = openSync(file, NO_FOLLOW);
  try {
    const stat = fstatSync(fd);
    const named = lstatSync(file);
    if (!stat.isFile() || stat.dev !== named.dev || stat.ino !== named.ino) return [];
    const length = Math.min(stat.size, PROMPT_TAIL);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (length < stat.size) lines.shift();
    return lines.flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line)] : [];
      } catch {
        return [];
      }
    });
  } finally {
    closeSync(fd);
  }
}

// Whether the mark `mark` (readUnattendedMark) holds a project run's issue session: it names an issue, as a tag of a
// wrong shape does with `issue: null`, or it cannot be read, which may be one. A pending mark holds every session the
// host did not list before a start, and is no issue's.
export const issueHeld = (mark) => mark !== null && typeof mark === 'object' && mark.pending !== true && (mark.issue !== undefined || mark.root === null);

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
// `root: null` as one it cannot tell. Tags of a wrong shape read `confine: 'failed'` too, so a session whose proof
// cannot be read runs nothing.
function markOf(value) {
  if (!isObject(value)) return { root: null };
  const root = typeof value.root === 'string' && path.isAbsolute(value.root) ? value.root : null;
  const start = root !== null && typeof value.cwd === 'string' && path.isAbsolute(value.cwd) ? { cwd: value.cwd } : {};
  const tags = tagsOf(value);
  return { root, ...start, ...(tags ?? { project: null, issue: null, ...(value.confine === undefined ? {} : { confine: 'failed' }) }) };
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
  const ages = [[MARK, MARK_AGE], [ATTENDED_FILE, MARK_AGE], [PENDING, PENDING_AGE], [BEACON, PENDING_AGE], [TEMPORARY, DAY]];
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
