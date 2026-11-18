// The rows of a session file appended in place (lib/session-rows.mjs): read by their tail, no-follow and non-blocking.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';
import { readRows } from '../plugins/aidrian/lib/session-rows.mjs';

const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-rows-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const POSIX = process.platform !== 'win32';
let sessions = 0;
const folderOf = () => sessionFolder(path.join(ROOT, 'state'), `rows-${(sessions += 1)}`, { checkouts: [] });
const KB = 1024;

test('readRows gives the rows of the file`s last maxBytes alone, oldest first, and [] for no file', { skip: !POSIX }, () => {
  const folder = folderOf();
  assert.deepEqual(readRows(folder, 'prs.jsonl', { maxBytes: 64 * KB }), []);
  const rows = Array.from({ length: 2000 }, (_, index) => ({ index, pad: 'x'.repeat(80) }));
  const text = rows.map((row) => `${JSON.stringify(row)}\n`).join('');
  assert.ok(Buffer.byteLength(text) > 200 * KB);
  writeFileSync(path.join(folder, 'prs.jsonl'), `${text}{"partial":`, { mode: 0o600 });
  const read = readRows(folder, 'prs.jsonl', { maxBytes: 64 * KB });
  const bytes = read.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
  assert.ok(bytes <= 64 * KB, `${bytes} bytes`);
  assert.ok(read.length > 100);
  assert.deepEqual(read.at(-1), rows.at(-1), 'the last whole row; the line still being written is dropped');
  assert.deepEqual(read.map((row) => row.index), rows.slice(-read.length).map((row) => row.index), 'oldest first, and a cut first line dropped');
});

test('readRows refuses a named pipe and a symlink, without waiting', { skip: !POSIX }, () => {
  const folder = folderOf();
  spawnSync('mkfifo', [path.join(folder, 'prs.jsonl')]);
  const started = Date.now();
  assert.equal(readRows(folder, 'prs.jsonl', { maxBytes: 64 * KB }), null);
  assert.ok(Date.now() - started < 2000);
  const other = folderOf();
  writeFileSync(path.join(ROOT, 'target.jsonl'), '{"a":1}\n', { mode: 0o600 });
  symlinkSync(path.join(ROOT, 'target.jsonl'), path.join(other, 'prs.jsonl'));
  assert.equal(readRows(other, 'prs.jsonl', { maxBytes: 64 * KB }), null);
  assert.equal(readRows(other, 'usage.json', { maxBytes: 64 * KB }), null, 'a name that is not appended in place');
});
