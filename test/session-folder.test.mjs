import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appendSessionFile, APPENDED_FILES, readSessionTail, reservationName, reserveSessionFile, SESSION_FILES, SESSION_RESERVATION, SESSION_TEMPORARY, sessionFolder, temporaryName, writeSessionFile } from '../plugins/aidrian/lib/session-folder.mjs';

const DAY = 24 * 60 * 60 * 1000;
const POSIX = process.platform !== 'win32';
const NONE = { checkouts: [] };

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
  assert.deepEqual(APPENDED_FILES, ['prs.jsonl']);
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
