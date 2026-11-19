import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stateRoot } from '../plugins/aidrian/lib/project.mjs';
import { appendSessionFile, APPENDED_FILES, boundFolder, existingSessionFolder, heldFolder, readSessionFile, readSessionTail, reservationName, reserveSessionFile, SESSION_FILES, SESSION_RESERVATION, SESSION_TEMPORARY, sessionFolder, sessionFolderNames, sweepSessions, temporaryName, writeSessionFile } from '../plugins/aidrian/lib/session-folder.mjs';
import { cachedSessionUsage } from '../plugins/aidrian/lib/session-usage-cache.mjs';

const DAY = 24 * 60 * 60 * 1000;
const POSIX = process.platform !== 'win32';
const NONE = { checkouts: [] };

// A primary group no folder in these tests has, so a group-writable folder is in a shared group whatever the machine.
const SHARED = POSIX ? process.getuid() + 1 : null;

const scratch = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-folder-')));

// A session folder under `sessions`, made for its user alone, holding `files`, every one last changed `days` ago.
function oldFolder(sessions, name, days, files = ['usage.json']) {
  const dir = path.join(sessions, name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const then = new Date(Date.now() - days * DAY);
  for (const file of files) {
    writeFileSync(path.join(dir, file), '{}');
    utimesSync(path.join(dir, file), then, then);
  }
  utimesSync(dir, then, then);
  return dir;
}

// A state folder with its sessions folder, both for its user alone.
function stateWithSessions() {
  const state = path.join(scratch(), 'state');
  const sessions = path.join(state, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  return { state, sessions };
}

test('a session id that fails SESSION_ID gets no folder, and nothing is made', () => {
  const state = path.join(scratch(), 'state');
  for (const id of ['../x', 'a/b', '', '.', 'x'.repeat(129), null]) assert.equal(sessionFolder(state, id, NONE), null);
  assert.equal(existsSync(state), false);
});

test('a call that names no checkouts gets no folder, and nothing is made', () => {
  const state = path.join(scratch(), 'state');
  assert.equal(sessionFolder(state, 'abc'), null);
  assert.equal(sessionFolder(state, 'abc', { checkouts: 'nope' }), null);
  assert.equal(existsSync(state), false);
});

test('a session folder is made for its user alone, under the real state folder', () => {
  const state = path.join(scratch(), 'state');
  const folder = sessionFolder(state, 'abc-123', NONE);
  assert.equal(folder, path.join(state, 'sessions', 'abc-123'));
  assert.equal(lstatSync(folder).isDirectory(), true);
  if (POSIX) {
    assert.equal(statSync(folder).mode & 0o777, 0o700);
    assert.equal(statSync(path.dirname(folder)).mode & 0o777, 0o700);
  }
  assert.equal(sessionFolder(state, 'abc-123', NONE), folder);
});

test('a session folder that is a symlink gives no folder, and nothing is written behind it', () => {
  const { state, sessions } = stateWithSessions();
  const elsewhere = path.join(path.dirname(state), 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, path.join(sessions, 'abc'));
  assert.equal(sessionFolder(state, 'abc', NONE), null);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('a sessions folder that is a symlink gets no write and no sweep', () => {
  const root = scratch();
  const state = path.join(root, 'state');
  const elsewhere = path.join(root, 'elsewhere');
  const old = oldFolder(elsewhere, 'old', 31);
  mkdirSync(state);
  symlinkSync(elsewhere, path.join(state, 'sessions'));
  assert.equal(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(elsewhere), ['old']);
  assert.deepEqual(readdirSync(old), ['usage.json']);
});

test('a state folder every user may write gets no folder, no write, and no sweep', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const old = oldFolder(sessions, 'old', 31);
  chmodSync(state, 0o777);
  assert.equal(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(sessions), ['old']);
  assert.deepEqual(readdirSync(old), ['usage.json']);
  const fresh = path.join(scratch(), 'loose');
  mkdirSync(fresh, { mode: 0o777 });
  chmodSync(fresh, 0o777);
  assert.equal(sessionFolder(fresh, 'new', NONE), null);
  assert.deepEqual(readdirSync(fresh), []);
});

test('a state folder below one its group or other users may write gets no session folder, unless that one is sticky', { skip: !POSIX }, () => {
  const open = path.join(scratch(), 'open');
  mkdirSync(open);
  const state = path.join(open, 'state');
  for (const mode of [0o777, 0o775, 0o757]) {
    chmodSync(open, mode);
    assert.equal(sessionFolder(state, 'abc', { ...NONE, gid: SHARED }), null, mode.toString(8));
  }
  // A shared folder like /tmp: every user may write it, but only an entry's owner may rename or remove that entry.
  chmodSync(open, 0o1777);
  const folder = sessionFolder(state, 'abc', NONE);
  assert.equal(folder, path.join(state, 'sessions', 'abc'));
  assert.ok(writeSessionFile(folder, 'usage.json', '{}\n'));
  // Once it loses the sticky bit, the folder below is no longer bound: its files are neither written nor read.
  chmodSync(open, 0o777);
  assert.equal(boundFolder(folder), false);
  assert.equal(writeSessionFile(folder, 'usage.json', 'x\n'), null);
  assert.equal(readSessionFile(folder, 'usage.json', { cap: 1024 }), null);
  chmodSync(open, 0o700);
  // The default location, under the state root, which the test run keeps in a temporary folder of its own.
  assert.ok(sessionFolder(path.join(stateRoot(), 'projects', 'session-folder-test'), 'abc', NONE));
});

// Runs `run` while every folder under `root` reads, through lstat, as in the group `gid`: a test cannot chgrp a folder to
// a group it is not in, such as a user private group on a machine that has none.
function inGroup(root, gid, run) {
  const real = fs.lstatSync;
  fs.lstatSync = (file, ...rest) => {
    const stat = real(file, ...rest);
    if (!stat || (file !== root && !String(file).startsWith(`${root}${path.sep}`))) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { gid });
  };
  syncBuiltinESMExports();
  try {
    return run();
  } finally {
    fs.lstatSync = real;
    syncBuiltinESMExports();
  }
}

// A state folder below a folder its group may write, both mode 0775, as a umask of 002 makes them.
function groupChain() {
  const root = scratch();
  const state = path.join(root, 'open', 'state');
  mkdirSync(state, { recursive: true });
  chmodSync(path.dirname(state), 0o775);
  chmodSync(state, 0o775);
  return { root, state };
}

test('a 0775 state folder and the one above it, in a user private group, get a session folder and its writes', { skip: !POSIX }, () => {
  const { root, state } = groupChain();
  const ids = { uid: process.getuid(), gid: process.getuid() };
  inGroup(root, ids.uid, () => {
    const folder = sessionFolder(state, 'abc', { ...NONE, ...ids });
    assert.equal(folder, path.join(state, 'sessions', 'abc'));
    assert.equal(boundFolder(folder, ids), true);
    assert.ok(writeSessionFile(folder, 'usage.json', '{}\n', ids));
    assert.equal(readSessionFile(folder, 'usage.json', { cap: 1024, ...ids })?.text, '{}\n');
  });
});

test('the same 0775 chain in a shared group gets no session folder, and nothing is made', { skip: !POSIX }, () => {
  const { root, state } = groupChain();
  const uid = process.getuid();
  // The user's primary group, whose id is not the uid, so other users are in it.
  inGroup(root, SHARED, () => assert.equal(sessionFolder(state, 'abc', { ...NONE, uid, gid: SHARED }), null));
  // A group whose id is the uid, but not the user's primary group.
  inGroup(root, uid, () => assert.equal(sessionFolder(state, 'abc', { ...NONE, uid, gid: SHARED }), null));
  // Another group, while the user's primary group is a user private group.
  inGroup(root, SHARED, () => assert.equal(sessionFolder(state, 'abc', { ...NONE, uid, gid: uid }), null));
  assert.equal(existsSync(path.join(state, 'sessions')), false);
  // A state folder not there yet is checked by the nearest folder above it that is, before anything is made.
  const missing = path.join(path.dirname(state), 'missing', 'state');
  inGroup(root, SHARED, () => assert.equal(sessionFolder(missing, 'abc', { ...NONE, uid, gid: SHARED }), null));
  assert.equal(existsSync(path.dirname(missing)), false);
});

test('a group-writable state folder never yields a session folder that boundFolder refuses', { skip: !POSIX }, () => {
  const { root, state } = groupChain();
  // The state folder alone: the check before a session folder is made then reads no group-writable folder above it.
  chmodSync(path.dirname(state), 0o700);
  const folder = sessionFolder(state, 'abc', NONE);
  assert.ok(folder === null || boundFolder(folder), 'in this machine\'s own groups');
  inGroup(root, SHARED, () => {
    const shared = sessionFolder(state, 'def', { ...NONE, gid: SHARED });
    assert.ok(shared === null || boundFolder(shared, { gid: SHARED }), 'in a shared group');
  });
});

test('a folder that is a symlink fails heldFolder, even to a folder that passes it', { skip: !POSIX }, () => {
  const root = scratch();
  const target = path.join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, path.join(root, 'link'));
  assert.equal(heldFolder(target, { above: true }), true);
  assert.equal(heldFolder(path.join(root, 'link'), { above: true }), false);
  assert.equal(heldFolder(path.join(root, 'link')), false);
});

test('a session or sessions folder any other user may read or write gives no folder', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const folder = sessionFolder(state, 'abc', NONE);
  for (const mode of [0o777, 0o770, 0o755]) {
    chmodSync(folder, mode);
    assert.equal(sessionFolder(state, 'abc', NONE), null, mode.toString(8));
  }
  chmodSync(folder, 0o700);
  chmodSync(sessions, 0o755);
  assert.equal(sessionFolder(state, 'abc', NONE), null);
  assert.equal(sessionFolder(state, 'other', NONE), null);
  assert.equal(existsSync(path.join(sessions, 'other')), false);
});

test('creating a folder sweeps session folders untouched for 30 days, deleting only the helper\'s own files', () => {
  const { state, sessions } = stateWithSessions();
  const temporaries = SESSION_FILES.map((name) => path.basename(temporaryName(path.join(sessions, 'gone'), name)));
  oldFolder(sessions, 'gone', 31, [...SESSION_FILES, ...temporaries, ...SESSION_FILES.map((name) => reservationName(name, 29_000_000))]);
  const kept = oldFolder(sessions, 'kept', 31, ['usage.json', 'notes.txt', 'usage.json.lock', 'notes.txt.1.lock']);
  oldFolder(sessions, 'recent', 29);
  const touched = oldFolder(sessions, 'touched', 31, ['usage.json', 'prs.jsonl']);
  utimesSync(path.join(touched, 'prs.jsonl'), new Date(), new Date());
  utimesSync(touched, new Date(Date.now() - 31 * DAY), new Date(Date.now() - 31 * DAY));
  oldFolder(sessions, 'not.a-session', 31);
  writeFileSync(path.join(sessions, 'stray.json'), '{}');
  assert.notEqual(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(sessions).sort(), ['kept', 'new', 'not.a-session', 'recent', 'stray.json', 'touched']);
  assert.deepEqual(readdirSync(kept).sort(), ['notes.txt', 'notes.txt.1.lock', 'usage.json.lock'], 'only the exact reservation pattern goes');
  assert.deepEqual(readdirSync(touched).sort(), ['prs.jsonl', 'usage.json']);
});

test('the sweep leaves an old session folder any other user may write in place, files included', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const loose = oldFolder(sessions, 'loose', 31);
  chmodSync(loose, 0o777);
  const then = new Date(Date.now() - 31 * DAY);
  utimesSync(loose, then, then);
  assert.notEqual(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(loose), ['usage.json']);
});

test('a folder that is already there sweeps nothing, and the sweep never takes the current session\'s folder', () => {
  const { state, sessions } = stateWithSessions();
  oldFolder(sessions, 'mine', 31);
  oldFolder(sessions, 'old', 31);
  assert.notEqual(sessionFolder(state, 'mine', NONE), null);
  assert.deepEqual(readdirSync(sessions).sort(), ['mine', 'old']);
  // Seen from 31 days on, the folder just made is as old as the rest, and still stays.
  assert.notEqual(sessionFolder(state, 'later', { checkouts: [], now: Date.now() + 31 * DAY }), null);
  assert.deepEqual(readdirSync(sessions), ['later']);
});

test('a symlinked entry pointing at an old folder elsewhere is left alone', () => {
  const { state, sessions } = stateWithSessions();
  const old = oldFolder(path.join(path.dirname(state), 'elsewhere'), 'old', 31);
  symlinkSync(old, path.join(sessions, 'linked'));
  // The link itself is as old as its target, so only the symlink check keeps the sweep out.
  const then = new Date(Date.now() - 31 * DAY);
  lutimesSync(path.join(sessions, 'linked'), then, then);
  assert.notEqual(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(old), ['usage.json']);
  assert.equal(lstatSync(path.join(sessions, 'linked')).isSymbolicLink(), true);
});

test('a state folder inside a checkout gets no folder and no sweep', () => {
  const checkout = scratch();
  const state = path.join(checkout, '.state');
  const sessions = path.join(state, 'sessions');
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  oldFolder(sessions, 'old', 31);
  assert.equal(sessionFolder(state, 'new', { checkouts: [checkout] }), null);
  assert.deepEqual(readdirSync(sessions), ['old']);
  assert.deepEqual(readdirSync(path.join(sessions, 'old')), ['usage.json']);
});

test('a session file is written only under a name the folder holds, through a temporary name the sweep knows', () => {
  const folder = sessionFolder(path.join(scratch(), 'state'), 'abc', NONE);
  for (const name of SESSION_FILES) assert.equal(SESSION_TEMPORARY.test(path.basename(temporaryName(folder, name))), true, name);
  assert.equal(SESSION_TEMPORARY.test('.notes.txt.1.0123456789ab.tmp'), false);
  for (const name of ['notes.txt', '../usage.json', 'usage.json/x', '']) assert.equal(writeSessionFile(folder, name, '{}'), null, name);
  assert.equal(writeSessionFile(folder, 'usage.json', '{}', { token: 'not-hex' }), null);
  assert.deepEqual(readdirSync(folder), []);
  assert.equal(writeSessionFile(folder, 'usage.json', '{"a":1}'), path.join(folder, 'usage.json'));
  assert.equal(readFileSync(path.join(folder, 'usage.json'), 'utf8'), '{"a":1}');
  if (POSIX) assert.equal(statSync(path.join(folder, 'usage.json')).mode & 0o777, 0o600);
});

test('a state folder inside a checkout that is not there yet gets no folder, and is not made', () => {
  const checkout = scratch();
  const state = path.join(checkout, '.state');
  assert.equal(sessionFolder(state, 'new', { checkouts: [checkout] }), null);
  assert.equal(existsSync(state), false);
});

test('a session file is not written into a folder another user may read, or through a symlinked folder', { skip: !POSIX }, () => {
  const root = scratch();
  const open = path.join(root, 'open');
  mkdirSync(open, { mode: 0o755 });
  chmodSync(open, 0o755);
  assert.equal(writeSessionFile(open, 'usage.json', '{}'), null);
  assert.deepEqual(readdirSync(open), []);
  const target = path.join(root, 'target');
  mkdirSync(target, { mode: 0o700 });
  const linked = path.join(root, 'linked');
  symlinkSync(target, linked);
  assert.equal(writeSessionFile(linked, 'usage.json', '{}'), null);
  assert.deepEqual(readdirSync(target), []);
  assert.equal(writeSessionFile(path.join(root, 'missing'), 'usage.json', '{}'), null);
});

test('once a folder above a session folder is swapped for a symlink, its files are neither written, appended, reserved, read, nor swept there', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const folder = sessionFolder(state, 'abc', NONE);
  assert.ok(writeSessionFile(folder, 'usage.json', 'mine\n'));
  assert.ok(appendSessionFile(folder, 'prs.jsonl', 'mine\n', { maxBytes: 1024 }));
  // Another user of a state folder moves the sessions folder away and links one elsewhere in its place, holding a
  // private folder of the same name, as the user's own folders are, with a usage cache of the session's transcript
  // whose fold no read of it gives, and an old session folder.
  const elsewhere = path.join(path.dirname(state), 'elsewhere');
  mkdirSync(path.join(elsewhere, 'abc'), { recursive: true, mode: 0o700 });
  const transcript = path.join(path.dirname(state), 'transcript.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ message: { id: 'a', model: 'mine', usage: { input_tokens: 1, cache_read_input_tokens: 9 } } })}\n`);
  const planted = path.join(elsewhere, 'abc', 'usage.json');
  cachedSessionUsage({ transcript, cacheFile: planted });
  const cache = JSON.parse(readFileSync(planted, 'utf8'));
  const theirs = JSON.stringify({ ...cache, requests: cache.requests.map((each) => ({ ...each, model: 'theirs' })) });
  writeFileSync(planted, theirs);
  const then = new Date(Date.now() - 31 * DAY);
  utimesSync(planted, then, then);
  utimesSync(path.dirname(planted), then, then);
  // And a ledger of rows the session never wrote.
  const ledger = path.join(elsewhere, 'abc', 'prs.jsonl');
  writeFileSync(ledger, 'theirs\n', { mode: 0o600 });
  utimesSync(ledger, then, then);
  utimesSync(path.dirname(planted), then, then);
  const old = oldFolder(elsewhere, 'old', 31);
  renameSync(sessions, path.join(state, 'moved'));
  symlinkSync(elsewhere, sessions);
  assert.equal(writeSessionFile(folder, 'usage.json', 'redirected\n'), null);
  assert.equal(reserveSessionFile(folder, 'usage.json', { windowMs: WINDOW }), null);
  assert.equal(readSessionFile(folder, 'usage.json', { cap: 1024 }), null);
  assert.equal(readSessionTail(folder, 'prs.jsonl', { maxBytes: 1024 }), null, 'the planted ledger is not read');
  assert.equal(appendSessionFile(folder, 'prs.jsonl', 'redirected\n', { maxBytes: 1024 }), false, 'nor appended to');
  assert.equal(boundFolder(folder), false);
  // The usage cache neither reads the planted usage.json nor writes over it.
  assert.equal(cachedSessionUsage({ transcript, cacheFile: path.join(folder, 'usage.json') }).model, 'mine');
  // A sweep from a new session's folder deletes nothing behind the symlink, however old.
  sweepSessions(sessions, { current: 'new', uid: process.getuid(), now: Date.now() });
  assert.deepEqual(readdirSync(elsewhere).sort(), ['abc', 'old']);
  assert.deepEqual(readdirSync(path.join(elsewhere, 'abc')).sort(), ['prs.jsonl', 'usage.json']);
  assert.deepEqual(readdirSync(old), ['usage.json']);
  assert.equal(readFileSync(planted, 'utf8'), theirs);
  assert.equal(readFileSync(ledger, 'utf8'), 'theirs\n');
});

const WINDOW = 60_000;

test('a reservation for the current window is one process`s alone, mode 0600, and only under a name the folder holds', () => {
  const folder = sessionFolder(path.join(scratch(), 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const now = Math.floor(Date.now() / WINDOW) * WINDOW;
  const reservation = path.join(folder, reservationName(name, Math.floor(now / WINDOW)));
  for (const other of ['notes.txt', '../usage.json', '']) assert.equal(reserveSessionFile(folder, other, { windowMs: WINDOW, now }), null, other);
  for (const windowMs of [0, -1, Number.NaN, undefined]) assert.equal(reserveSessionFile(folder, name, { windowMs, now }), null, String(windowMs));
  assert.deepEqual(readdirSync(folder), []);
  const release = reserveSessionFile(folder, name, { windowMs: WINDOW, now });
  assert.equal(typeof release, 'function');
  assert.equal(SESSION_RESERVATION.test(path.basename(reservation)), true);
  if (POSIX) assert.equal(statSync(reservation).mode & 0o777, 0o600);
  assert.equal(reserveSessionFile(folder, name, { windowMs: WINDOW, now: now + 1 }), null, 'held for this window');
  assert.equal(typeof reserveSessionFile(folder, 'usage.json', { windowMs: WINDOW, now }), 'function', 'each file has its own');
  release();
  assert.equal(existsSync(reservation), false, 'the creator removes its own');
});

test('a reservation from an earlier window, as a killed process leaves, blocks nothing and is left in place', () => {
  const folder = sessionFolder(path.join(scratch(), 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const now = Date.now();
  const killed = reserveSessionFile(folder, name, { windowMs: WINDOW, now: now - WINDOW });
  assert.equal(typeof killed, 'function');
  const release = reserveSessionFile(folder, name, { windowMs: WINDOW, now });
  assert.equal(typeof release, 'function', 'the next window has its own');
  release();
  assert.deepEqual(readdirSync(folder), [reservationName(name, Math.floor((now - WINDOW) / WINDOW))], 'nobody but its creator removes it');
});

test('a symlink at the reservation is never followed or removed', { skip: !POSIX }, () => {
  const root = scratch();
  const folder = sessionFolder(path.join(root, 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const now = Date.now();
  const reservation = path.join(folder, reservationName(name, Math.floor(now / WINDOW)));
  const target = path.join(root, 'target');
  writeFileSync(target, 'keep');
  symlinkSync(target, reservation);
  assert.equal(reserveSessionFile(folder, name, { windowMs: WINDOW, now }), null);
  assert.equal(lstatSync(reservation).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});

test('the sweep deletes a reservation only when it is a regular file', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const old = oldFolder(sessions, 'old', 31, []);
  const linked = path.join(old, reservationName('usage.json', 1));
  symlinkSync(path.join(sessions, 'elsewhere'), linked);
  const then = new Date(Date.now() - 31 * DAY);
  lutimesSync(linked, then, then);
  utimesSync(old, then, then);
  assert.notEqual(sessionFolder(state, 'new', NONE), null);
  assert.equal(lstatSync(linked).isSymbolicLink(), true);
});

test('appendSessionFile appends the ledger in place, within its cap, and only the ledger', { skip: !POSIX }, () => {
  const { state } = stateWithSessions();
  const folder = sessionFolder(state, 'appender', NONE);
  assert.deepEqual(APPENDED_FILES, ['prs.jsonl', 'links.jsonl']);
  assert.ok(SESSION_FILES.includes('prs.jsonl'), 'the sweep deletes it too');
  assert.equal(appendSessionFile(folder, 'prs.jsonl', 'a\n', { maxBytes: 10 }), true);
  assert.equal(appendSessionFile(folder, 'prs.jsonl', 'b\n', { maxBytes: 10 }), true);
  assert.equal(readFileSync(path.join(folder, 'prs.jsonl'), 'utf8'), 'a\nb\n');
  assert.equal(statSync(path.join(folder, 'prs.jsonl')).mode & 0o777, 0o600);
  assert.equal(appendSessionFile(folder, 'prs.jsonl', 'c'.repeat(7), { maxBytes: 10 }), false, 'past the cap: nothing written');
  assert.equal(readFileSync(path.join(folder, 'prs.jsonl'), 'utf8'), 'a\nb\n');
  assert.equal(appendSessionFile(folder, 'usage.json', 'x', { maxBytes: 10 }), false, 'a renamed file is never appended');
  assert.equal(appendSessionFile(folder, 'prs.jsonl', 'x'), false, 'no cap, no write');
  assert.equal(existsSync(path.join(folder, 'usage.json')), false);
});

test('appendSessionFile writes nothing in a symlinked or group-readable folder', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const target = path.join(scratch(), 'target');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, path.join(sessions, 'linked'));
  assert.equal(appendSessionFile(path.join(sessions, 'linked'), 'prs.jsonl', 'x\n', { maxBytes: 100 }), false);
  assert.deepEqual(readdirSync(target), []);
  const open = path.join(sessions, 'open');
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o750);
  assert.equal(appendSessionFile(open, 'prs.jsonl', 'x\n', { maxBytes: 100 }), false);
  assert.deepEqual(readdirSync(open), []);
  assert.equal(sessionFolder(state, 'fine', NONE) !== null, true);
});

test('readSessionTail reads the ledger no-follow: missing is empty, any size is its tail, and a link or a shared file is refused', { skip: !POSIX }, () => {
  const { state } = stateWithSessions();
  const folder = sessionFolder(state, 'reader', NONE);
  const file = path.join(folder, 'prs.jsonl');
  const tail = (maxBytes = 100) => readSessionTail(folder, 'prs.jsonl', { maxBytes });
  assert.deepEqual(tail(), { text: '', cut: false });
  appendSessionFile(folder, 'prs.jsonl', 'row\n', { maxBytes: 100 });
  assert.deepEqual(tail(), { text: 'row\n', cut: false });
  assert.deepEqual(tail(3), { text: 'ow\n', cut: true }, 'past the cap: the tail, never a refusal');
  chmodSync(file, 0o644);
  assert.equal(tail(), null, 'readable by others');
  chmodSync(file, 0o600);
  const other = path.join(scratch(), 'other.txt');
  writeFileSync(other, 'x\n', { mode: 0o600 });
  rmSync(file);
  linkSync(other, file);
  assert.equal(tail(), null, 'a hard link');
  rmSync(file);
  symlinkSync(other, file);
  assert.equal(tail(), null, 'a symlink');
  rmSync(file);
  mkdirSync(file);
  assert.equal(tail(), null, 'no regular file');
});

test('existingSessionFolder finds a folder without creating or sweeping one', { skip: !POSIX }, () => {
  const { state, sessions } = stateWithSessions();
  const old = oldFolder(sessions, 'old-1', 40);
  assert.deepEqual(existingSessionFolder(state, 'gone-1', NONE), { folder: null, refused: false }, 'a missing folder');
  assert.deepEqual(readdirSync(sessions), ['old-1'], 'nothing made');
  assert.equal(existsSync(old), true, 'an old folder is not swept');
  const made = sessionFolder(state, 'here-1', { ...NONE, now: Date.now() - 50 * DAY });
  assert.deepEqual(existingSessionFolder(state, 'here-1', NONE), { folder: made, refused: false });
  assert.deepEqual(existingSessionFolder(path.join(scratch(), 'none'), 'here-1', NONE), { folder: null, refused: false }, 'no state folder yet');
  for (const id of ['../x', 'a/b', 'x'.repeat(129), '']) assert.deepEqual(existingSessionFolder(state, id, NONE), { folder: null, refused: true }, id);
  assert.deepEqual(existingSessionFolder(state, 'here-1', { checkouts: null }), { folder: null, refused: true });
  const elsewhere = path.join(scratch(), 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, path.join(sessions, 'linked-1'));
  assert.equal(existingSessionFolder(state, 'linked-1', NONE).refused, true, 'a symlinked session folder');
  const open = path.join(sessions, 'open-1');
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o755);
  assert.equal(existingSessionFolder(state, 'open-1', NONE).refused, true, 'a folder another user may read');
  chmodSync(open, 0o722);
  assert.equal(existingSessionFolder(state, 'open-1', NONE).refused, true, 'a folder another user may write');
  assert.deepEqual(sessionFolderNames(state, NONE).sort(), ['here-1', 'linked-1', 'old-1', 'open-1']);
  assert.equal(existsSync(old), true, 'still not swept');
});

test('existingSessionFolder and sessionFolderNames refuse a symlinked sessions folder and a state folder inside a checkout', { skip: !POSIX }, () => {
  const base = scratch();
  const real = path.join(base, 'real-sessions');
  mkdirSync(path.join(real, 'one-1'), { recursive: true, mode: 0o700 });
  chmodSync(real, 0o700);
  const state = path.join(base, 'state');
  mkdirSync(state, { mode: 0o700 });
  symlinkSync(real, path.join(state, 'sessions'));
  assert.deepEqual(existingSessionFolder(state, 'one-1', NONE), { folder: null, refused: true });
  assert.equal(sessionFolderNames(state, NONE), null);
  const checkout = path.join(base, 'repo');
  const inside = path.join(checkout, '.state');
  mkdirSync(path.join(inside, 'sessions', 'one-1'), { recursive: true, mode: 0o700 });
  assert.deepEqual(existingSessionFolder(inside, 'one-1', { checkouts: [checkout] }), { folder: null, refused: true });
  assert.equal(sessionFolderNames(inside, { checkouts: [checkout] }), null);
  assert.deepEqual(sessionFolderNames(path.join(base, 'not-made'), NONE), [], 'no state folder: no names, nothing made');
  assert.equal(existsSync(path.join(base, 'not-made')), false);
  const fresh = stateWithSessions();
  writeFileSync(path.join(fresh.sessions, 'file-1'), '');
  mkdirSync(path.join(fresh.sessions, 'bad name'));
  assert.deepEqual(sessionFolderNames(fresh.state, NONE), ['file-1'], 'names that pass SESSION_ID alone');
});

test('links.jsonl is a session file appended in place: written, appended, and swept, and a name off the lists is still refused', { skip: !POSIX }, () => {
  assert.ok(SESSION_FILES.includes('links.jsonl') && APPENDED_FILES.includes('links.jsonl'));
  const { state, sessions } = stateWithSessions();
  const folder = sessionFolder(state, 'links-1', NONE);
  assert.ok(writeSessionFile(folder, 'links.jsonl', '{"a":1}\n'));
  assert.equal(appendSessionFile(folder, 'links.jsonl', '{"b":2}\n', { maxBytes: 1024 }), true);
  assert.equal(readFileSync(path.join(folder, 'links.jsonl'), 'utf8'), '{"a":1}\n{"b":2}\n');
  assert.equal(statSync(path.join(folder, 'links.jsonl')).mode & 0o777, 0o600);
  assert.equal(writeSessionFile(folder, 'links.json', '{}'), null);
  assert.equal(appendSessionFile(folder, 'notes.jsonl', '{}\n', { maxBytes: 1024 }), false);
  const old = oldFolder(sessions, 'old-links', 31, ['links.jsonl', path.basename(temporaryName(path.join(sessions, 'old-links'), 'links.jsonl')), 'links.jsonl.bak']);
  assert.notEqual(sessionFolder(state, 'links-2', NONE), null);
  assert.deepEqual(readdirSync(old), ['links.jsonl.bak'], 'the sweep deletes links.jsonl and its temporary file, and nothing it did not delete before');
});
