import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { reservationName, reserveSessionFile, SESSION_FILES, SESSION_TEMPORARY, sessionFolder, temporaryName, writeSessionFile } from '../plugins/aidrian/lib/session-folder.mjs';

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
  oldFolder(sessions, 'gone', 31, [...SESSION_FILES, ...temporaries, ...SESSION_FILES.map(reservationName)]);
  const kept = oldFolder(sessions, 'kept', 31, ['usage.json', 'notes.txt']);
  oldFolder(sessions, 'recent', 29);
  const touched = oldFolder(sessions, 'touched', 31, ['usage.json', 'prs.jsonl']);
  utimesSync(path.join(touched, 'prs.jsonl'), new Date(), new Date());
  utimesSync(touched, new Date(Date.now() - 31 * DAY), new Date(Date.now() - 31 * DAY));
  oldFolder(sessions, 'not.a-session', 31);
  writeFileSync(path.join(sessions, 'stray.json'), '{}');
  assert.notEqual(sessionFolder(state, 'new', NONE), null);
  assert.deepEqual(readdirSync(sessions).sort(), ['kept', 'new', 'not.a-session', 'recent', 'stray.json', 'touched']);
  assert.deepEqual(readdirSync(kept), ['notes.txt']);
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

test('a reservation is one process`s alone until released, mode 0600, and only under a name the folder holds', () => {
  const folder = sessionFolder(path.join(scratch(), 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const reservation = path.join(folder, reservationName(name));
  for (const other of ['notes.txt', '../usage.json', '']) assert.equal(reserveSessionFile(folder, other, { staleMs: 60_000 }), null, other);
  assert.equal(reserveSessionFile(folder, name, { staleMs: 60_000, token: 'not-hex' }), null);
  assert.deepEqual(readdirSync(folder), []);
  const release = reserveSessionFile(folder, name, { staleMs: 60_000 });
  assert.equal(typeof release, 'function');
  if (POSIX) assert.equal(statSync(reservation).mode & 0o777, 0o600);
  assert.equal(reserveSessionFile(folder, name, { staleMs: 60_000 }), null, 'held by another');
  assert.equal(typeof reserveSessionFile(folder, 'usage.json', { staleMs: 60_000 }), 'function', 'each file has its own');
  release();
  assert.equal(existsSync(reservation), false);
  const again = reserveSessionFile(folder, name, { staleMs: 60_000 });
  assert.equal(typeof again, 'function', 'free once released');
  again();
});

test('a reservation older than staleMs, or from the future, is taken over, and the old holder`s release leaves the new one', () => {
  const folder = sessionFolder(path.join(scratch(), 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const reservation = path.join(folder, reservationName(name));
  const killed = reserveSessionFile(folder, name, { staleMs: 60_000 });
  const then = new Date(Date.now() - 61_000);
  utimesSync(reservation, then, then);
  const taken = reserveSessionFile(folder, name, { staleMs: 60_000 });
  assert.equal(typeof taken, 'function', 'a reservation a killed process left goes stale');
  killed();
  assert.equal(existsSync(reservation), true, 'the old holder releases only its own');
  assert.equal(reserveSessionFile(folder, name, { staleMs: 60_000 }), null);
  const later = new Date(Date.now() + 3_600_000);
  utimesSync(reservation, later, later);
  assert.equal(typeof reserveSessionFile(folder, name, { staleMs: 60_000 }), 'function', 'a clock that went back frees it');
  assert.deepEqual(readdirSync(folder), [reservationName(name)], 'no temporary file is left');
});

test('a symlink or a folder at the reservation is never followed, removed, or taken', { skip: !POSIX }, () => {
  const root = scratch();
  const folder = sessionFolder(path.join(root, 'state'), 'abc', NONE);
  const name = 'merged-heads-cache.json';
  const reservation = path.join(folder, reservationName(name));
  const target = path.join(root, 'target');
  writeFileSync(target, 'keep');
  symlinkSync(target, reservation);
  const then = new Date(Date.now() - 61_000);
  lutimesSync(reservation, then, then);
  assert.equal(reserveSessionFile(folder, name, { staleMs: 60_000 }), null);
  assert.equal(lstatSync(reservation).isSymbolicLink(), true);
  assert.equal(readFileSync(target, 'utf8'), 'keep');
});
