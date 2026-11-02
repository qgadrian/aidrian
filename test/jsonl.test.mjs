import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

test('withLocks holds each file\'s lock while it runs, again inside itself, and lets go after a throw', (t) => {
  const file = tempFile(t);
  const other = file.replace(/log/u, 'other');
  assert.equal(withLocks([file, other], () => withLocks([file], () => [existsSync(`${file}.lock`), existsSync(`${other}.lock`)])).join(), 'true,true');
  assert.deepEqual([existsSync(`${file}.lock`), existsSync(`${other}.lock`)], [false, false]);
  assert.throws(() => withLocks([file], () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(existsSync(`${file}.lock`), false);
});

test('withLocks takes over a lock whose holder is gone, and gives up on a live one after its wait', (t) => {
  const file = tempFile(t);
  mkdirSync(path.dirname(file), { recursive: true });
  const gone = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(`${file}.lock`, `${gone} dead\n`);
  assert.equal(withLocks([file], () => 'ran'), 'ran');
  assert.equal(existsSync(`${file}.lock`), false);
  // This test's own process holds it, from outside withLocks: a live holder.
  writeFileSync(`${file}.lock`, `${process.pid} live\n`);
  const started = Date.now();
  assert.throws(() => withLocks([file], () => 'never', { waitMs: 100 }), (error) => error.code === LOCKED && error.message.includes('is locked by another process'));
  assert.ok(Date.now() - started >= 100);
  assert.equal(readFileSync(`${file}.lock`, 'utf8'), `${process.pid} live\n`, 'a lock it never took is left alone');
});
