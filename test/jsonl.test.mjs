import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { appendRow, LOCKED, readRows, withLocks } from '../plugins/aidrian/lib/jsonl.mjs';

function tempFile(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-jsonl-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'state/log.jsonl');
}

test('a missing file has no rows', (t) => {
  assert.deepEqual(readRows(tempFile(t)), { rows: [], skipped: 0 });
});

test('append creates the folder, and rows read back in order', (t) => {
  const file = tempFile(t);
  appendRow(file, { id: 1 });
  appendRow(file, { id: 2, text: 'line\nbreak' });
  assert.equal(readFileSync(file, 'utf8'), '{"id":1}\n{"id":2,"text":"line\\nbreak"}\n');
  assert.deepEqual(readRows(file), { rows: [{ id: 1 }, { id: 2, text: 'line\nbreak' }], skipped: 0 });
});

test('a line that holds no JSON object is skipped and counted; blank lines are ignored', (t) => {
  const file = tempFile(t);
  appendRow(file, { id: 1 });
  appendFileSync(file, '{"id":\n\n[1]\n"text"\n');
  appendRow(file, { id: 2 });
  assert.deepEqual(readRows(file), { rows: [{ id: 1 }, { id: 2 }], skipped: 3 });
});

test('a row appended after a write cut short starts its own line, so it still reads back', (t) => {
  const file = tempFile(t);
  appendRow(file, { id: 1 });
  appendFileSync(file, '{"id":2,"no');
  appendRow(file, { id: 3 });
  assert.equal(readFileSync(file, 'utf8'), '{"id":1}\n{"id":2,"no\n{"id":3}\n');
  assert.deepEqual(readRows(file), { rows: [{ id: 1 }, { id: 3 }], skipped: 1 });
});

test('appends from concurrent processes all land, one per line', async (t) => {
  const file = tempFile(t);
  const jsonl = pathToFileURL(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/jsonl.mjs')).href;
  const writer = (name) => {
    const code = `import { appendRow } from ${JSON.stringify(jsonl)};
for (let i = 0; i < 200; i++) appendRow(${JSON.stringify(file)}, { name: ${JSON.stringify(name)}, i, pad: 'x'.repeat(500) });`;
    return new Promise((resolve, reject) => {
      spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' })
        .on('error', reject)
        .on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`writer exited ${status}`))));
    });
  };
  appendRow(file, { start: true });
  await Promise.all([writer('a'), writer('b')]);
  const { rows, skipped } = readRows(file);
  assert.equal(skipped, 0);
  assert.equal(rows.filter((row) => row.name === 'a').length, 200);
  assert.equal(rows.filter((row) => row.name === 'b').length, 200);
});

// The lock files of `file` on disk, sorted, and whether its newest generation is held (not released).
function lockFiles(file) {
  return readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.lock`)).sort();
}
function held(file) {
  const names = lockFiles(file);
  const top = Math.max(0, ...names.map((name) => /\.lock\.(\d+)$/u.exec(name)?.[1]).filter(Boolean).map(Number));
  return top > 0 && !names.includes(`${path.basename(file)}.lock.${top}.released`);
}
// A lock's first generation, held by `pid` on `host`, last written `ageMs` ago.
function planted(file, { pid, host = hostname(), ageMs = 0 }) {
  mkdirSync(path.dirname(file), { recursive: true });
  const name = `${file}.lock.1`;
  writeFileSync(name, `${JSON.stringify({ pid, host, nonce: 'test' })}\n`);
  if (ageMs) utimesSync(name, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return name;
}
const HOUR = 3_600_000;

test('withLocks holds each file\'s lock while it runs, again inside itself, and lets go after a throw', (t) => {
  const file = tempFile(t);
  const other = file.replace(/log/u, 'other');
  assert.deepEqual(withLocks([file, other], () => withLocks([file], () => [held(file), held(other)])), [true, true]);
  assert.deepEqual([held(file), held(other)], [false, false]);
  assert.throws(() => withLocks([file], () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(held(file), false);
  assert.deepEqual(lockFiles(file), ['log.jsonl.lock.2', 'log.jsonl.lock.2.released'], 'each holder sweeps the generations below its own');
});

test('withLocks takes over a lock whose holder on this host is gone, and gives up on a live one after its wait', (t) => {
  const file = tempFile(t);
  planted(file, { pid: spawnSync(process.execPath, ['-e', '']).pid });
  assert.equal(withLocks([file], () => 'ran'), 'ran');
  assert.deepEqual(lockFiles(file), ['log.jsonl.lock.2', 'log.jsonl.lock.2.released']);
  rmSync(path.dirname(file), { recursive: true });
  const name = planted(file, { pid: process.pid });
  const before = readFileSync(name, 'utf8');
  const started = Date.now();
  assert.throws(() => withLocks([file], () => 'never', { waitMs: 100 }), (error) => error.code === LOCKED && error.message === `${file} is locked by another process (pid ${process.pid}, ${name}); try again`);
  assert.ok(Date.now() - started >= 100);
  assert.deepEqual([lockFiles(file), readFileSync(name, 'utf8')], [['log.jsonl.lock.1'], before], 'a lock it never took is left alone');
});

test('a live holder on this host keeps its lock however old it is; one on another host is abandoned only after a long time', (t) => {
  const file = tempFile(t);
  planted(file, { pid: process.pid, ageMs: HOUR });
  assert.throws(() => withLocks([file], () => 'never', { waitMs: 50 }), (error) => error.code === LOCKED, 'an hour old, its pid still runs');
  rmSync(path.dirname(file), { recursive: true });
  planted(file, { pid: 1, host: 'another-host', ageMs: 5 * 60_000 });
  assert.throws(() => withLocks([file], () => 'never', { waitMs: 50 }), (error) => error.code === LOCKED && error.message.includes('pid 1 on another-host'), 'its pid cannot be checked from here');
  rmSync(path.dirname(file), { recursive: true });
  planted(file, { pid: 1, host: 'another-host', ageMs: HOUR });
  assert.equal(withLocks([file], () => 'ran', { waitMs: 50 }), 'ran');
});

test('processes that find an abandoned lock at once take it one at a time, and never two together', async (t) => {
  // Each contender takes the lock once and exits while it holds it, so every lock after the first is taken over from a
  // holder that is gone, by the contenders still waiting, all at once.
  const jsonl = JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/jsonl.mjs')).href);
  for (let round = 0; round < 4; round += 1) {
    const file = tempFile(t);
    const log = `${file}.holders`;
    planted(file, { pid: spawnSync(process.execPath, ['-e', '']).pid });
    const start = Date.now() + 700;
    const code = (name) => `import { appendFileSync } from 'node:fs';
import { withLocks } from ${jsonl};
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
nap(Math.max(0, ${start} - Date.now()));
withLocks([${JSON.stringify(file)}], () => {
  appendFileSync(${JSON.stringify(log)}, 'in ${name}\\n');
  nap(5);
  appendFileSync(${JSON.stringify(log)}, 'out ${name}\\n');
  process.exit(0);
}, { waitMs: 60_000 });`;
    const names = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const exits = await Promise.all(names.map((name) => new Promise((resolve) => {
      spawn(process.execPath, ['--input-type=module', '-e', code(name)], { stdio: 'inherit' }).on('close', resolve);
    })));
    assert.deepEqual(exits, names.map(() => 0));
    const lines = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(lines.length, names.length * 2);
    for (let i = 0; i < lines.length; i += 2) {
      assert.deepEqual([lines[i].split(' ')[0], lines[i + 1]], ['in', lines[i].replace('in', 'out')], `round ${round + 1}, line ${i + 1}: one holder at a time`);
    }
  }
});
