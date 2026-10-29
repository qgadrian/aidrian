import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { appendRow, readRows } from '../plugins/aidrian/lib/jsonl.mjs';

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
