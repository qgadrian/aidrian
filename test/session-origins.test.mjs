// The session origins (lib/session-origins.mjs): the state folders each session started with, which the session-folder
// guard holds for its subagents. Read as the store reads its own files, written as the unattended marks are, one update
// at a time.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { reserveFile } from '../plugins/aidrian/lib/session-folder.mjs';
import { noteOrigin, originFolder, readOrigins } from '../plugins/aidrian/lib/session-origins.mjs';
import { LOCK_WINDOW_MS } from '../plugins/aidrian/lib/session-rows.mjs';

const POSIX = process.platform !== 'win32';
const DAY = 24 * 60 * 60 * 1000;

// A state root of its own, and two state folders outside any checkout.
function setup(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-origins-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'root') };
  const states = ['a', 'b', 'c'].map((name) => path.join(base, `state-${name}`));
  const folder = originFolder(env);
  return { base, env, states, folder, record: (session) => path.join(folder, `${session}.json`) };
}

test('a named pipe, a link, or a record others may read at the record reads as none, at once', { skip: !POSIX }, (t) => {
  const { base, env, states, folder, record } = setup(t);
  assert.ok(noteOrigin('kept-1', states[0], { env, checkouts: [] }));
  assert.deepEqual(readOrigins('kept-1', { env }), [states[0]]);
  spawnSync('mkfifo', [record('pipe-1')]);
  const outside = path.join(base, 'outside.json');
  writeFileSync(outside, `${JSON.stringify({ states: [states[1]] })}\n`, { mode: 0o600 });
  symlinkSync(outside, record('link-1'));
  writeFileSync(record('open-1'), `${JSON.stringify({ states: [states[2]] })}\n`, { mode: 0o644 });
  chmodSync(record('open-1'), 0o644);
  const started = Date.now();
  for (const session of ['pipe-1', 'link-1', 'open-1']) assert.deepEqual(readOrigins(session, { env }), [], session);
  assert.ok(Date.now() - started < 1000, 'no read waits on the pipe');
  assert.ok(existsSync(folder));
});

test('a link planted at the old temporary name, or an origins folder that is a link, receives no write', { skip: !POSIX }, (t) => {
  const { base, env, states, folder, record } = setup(t);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const victim = path.join(base, 'victim.txt');
  writeFileSync(victim, 'mine\n');
  symlinkSync(victim, `${record('plant-1')}.${process.pid}.tmp`);
  assert.ok(noteOrigin('plant-1', states[0], { env, checkouts: [] }));
  assert.equal(readFileSync(victim, 'utf8'), 'mine\n', 'the planted link`s target is untouched');
  assert.deepEqual(readOrigins('plant-1', { env }), [states[0]]);
  const elsewhere = path.join(base, 'elsewhere');
  mkdirSync(elsewhere);
  const linked = { ...env, XDG_STATE_HOME: path.join(base, 'linked-root') };
  mkdirSync(path.join(base, 'linked-root', 'aidrian'), { recursive: true });
  symlinkSync(elsewhere, originFolder(linked));
  assert.equal(noteOrigin('plant-2', states[0], { env: linked, checkouts: [] }), null);
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the linked folder');
});

test('two SessionStart hooks of one session updating together keep both folders', { skip: !POSIX }, async (t) => {
  const { base, env, states, folder, record } = setup(t);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const held = [reserveFile(folder, 'race-1.json', { windowMs: LOCK_WINDOW_MS, now }), reserveFile(folder, 'race-1.json', { windowMs: LOCK_WINDOW_MS, now: now + LOCK_WINDOW_MS })];
  assert.ok(held.every(Boolean));
  const started = path.join(base, 'started');
  const lib = pathToFileURL(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/session-origins.mjs')).href;
  const script = `import { writeFileSync } from 'node:fs';\nimport { noteOrigin } from ${JSON.stringify(lib)};\nwriteFileSync(${JSON.stringify(started)}, '');\n`
    + `noteOrigin('race-1', ${JSON.stringify(states[1])}, { checkouts: [] });\n`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore', env });
  const until = Date.now() + 10_000;
  while (!existsSync(started) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  // The other hook's update, made while it holds the reservations.
  writeFileSync(record('race-1'), `${JSON.stringify({ states: [states[0]], at: now })}\n`, { mode: 0o600 });
  for (const release of held) release();
  await once(child, 'exit');
  assert.deepEqual(readOrigins('race-1', { env }), [states[0], states[1]]);
});

test('a resumed session`s record is written again, so pruning keeps it', { skip: !POSIX }, (t) => {
  const { env, states, record } = setup(t);
  assert.ok(noteOrigin('resumed-1', states[0], { env, checkouts: [] }));
  const old = new Date(Date.now() - 40 * DAY);
  utimesSync(record('resumed-1'), old, old);
  assert.ok(noteOrigin('resumed-1', states[0], { env, checkouts: [] }), 'the same folder again, on resume');
  assert.ok(Date.now() - lstatSync(record('resumed-1')).mtimeMs < DAY, 'its time is fresh');
  assert.ok(noteOrigin('other-1', states[1], { env, checkouts: [] }), 'another record`s write prunes the stale ones');
  assert.deepEqual(readOrigins('resumed-1', { env }), [states[0]]);
});

test('a state folder the session folder writer refuses, inside a checkout of its repository, is not recorded', { skip: !POSIX }, (t) => {
  const { base, env, states } = setup(t);
  const checkout = path.join(base, 'repo');
  mkdirSync(checkout);
  assert.equal(noteOrigin('inside-1', checkout, { env, checkouts: [checkout] }), null, 'the state folder is the checkout');
  assert.equal(noteOrigin('inside-2', base, { env, checkouts: [path.join(base, 'sessions')] }), null, 'its sessions folder is a checkout');
  assert.equal(noteOrigin('inside-3', states[0], { env }), null, 'checkouts git could not list');
  assert.deepEqual(['inside-1', 'inside-2', 'inside-3'].flatMap((session) => readOrigins(session, { env })), []);
  assert.ok(noteOrigin('outside-1', states[0], { env, checkouts: [checkout] }));
});
