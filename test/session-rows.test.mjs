// The rows of a session file appended in place (lib/session-rows.mjs): read by their tail, no-follow and non-blocking.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, linkSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';

import { sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';
import { appendRows, readRows } from '../plugins/aidrian/lib/session-rows.mjs';

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

const lines = (folder, name = 'links.jsonl') => readFileSync(path.join(folder, name), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('appendRows appends every row with no select, and once with a select that leaves out what a line holds', { skip: !POSIX }, () => {
  const folder = folderOf();
  const row = { at: '2026-11-18T10:00:00.000Z', kind: 'worktree', branch: 'feat/x' };
  assert.equal(appendRows(folder, 'links.jsonl', [row], { maxBytes: 64 * KB }), true);
  assert.equal(appendRows(folder, 'links.jsonl', [row], { maxBytes: 64 * KB }), true);
  assert.equal(lines(folder).length, 2, 'the same row twice, with no select');
  const select = (held, rows) => rows.filter((each) => !held.includes(JSON.stringify(each)));
  assert.equal(appendRows(folder, 'links.jsonl', [row], { maxBytes: 64 * KB, select }), false);
  assert.equal(lines(folder).length, 2, 'once, with a select');
  assert.equal(statSync(path.join(folder, 'links.jsonl')).mode & 0o777, 0o600);
  assert.equal(appendRows(folder, 'notes.jsonl', [row], { maxBytes: 64 * KB }), false, 'a name the folder does not append');
});

test('a file at its cap, or left past it, is rewritten with its newest rows that fit in half, then the new ones', { skip: !POSIX }, () => {
  const folder = folderOf();
  const cap = 4 * KB;
  const row = (index) => ({ index, pad: 'x'.repeat(60) });
  for (let index = 0; index < 80; index += 1) assert.equal(appendRows(folder, 'links.jsonl', [row(index)], { maxBytes: cap }), true);
  const kept = lines(folder);
  assert.ok(statSync(path.join(folder, 'links.jsonl')).size <= cap);
  assert.equal(kept.at(-1).index, 79, 'the newest is kept');
  assert.ok(kept[0].index > 0, 'the oldest went');
  // A file an older writer left past the cap: the next write compacts it.
  writeFileSync(path.join(folder, 'links.jsonl'), Array.from({ length: 100 }, (_, index) => `${JSON.stringify(row(index))}\n`).join(''), { mode: 0o600 });
  assert.equal(appendRows(folder, 'links.jsonl', [row(100)], { maxBytes: cap }), true);
  const compacted = lines(folder);
  assert.ok(statSync(path.join(folder, 'links.jsonl')).size <= cap / 2 + 200);
  assert.deepEqual(compacted.at(-1).index, 100);
  assert.deepEqual(readdirSync(folder).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')), [], 'no temporary file or reservation is left');
});

test('one batch larger than the cap leaves the file within it, with the batch`s newest rows', { skip: !POSIX }, () => {
  const cap = 4 * KB;
  const batch = Array.from({ length: 100 }, (_, index) => ({ index, pad: 'x'.repeat(60) }));
  for (const before of [[], [{ index: -1, pad: 'old' }]]) {
    const folder = folderOf();
    if (before.length) assert.equal(appendRows(folder, 'links.jsonl', before, { maxBytes: cap }), true);
    assert.equal(appendRows(folder, 'links.jsonl', batch, { maxBytes: cap }), true);
    assert.ok(statSync(path.join(folder, 'links.jsonl')).size <= cap, `${statSync(path.join(folder, 'links.jsonl')).size} bytes`);
    const kept = readRows(folder, 'links.jsonl', { maxBytes: cap }).filter((each) => each.index >= 0);
    assert.equal(kept.at(-1).index, 99, 'the newest row of the batch');
    assert.ok(kept.length > 40);
    assert.deepEqual(kept.map((each) => each.index), batch.slice(-kept.length).map((each) => each.index), 'the read sees every row of the batch written');
  }
});

test('a write after a line cut short keeps its own row, and the earlier whole rows', { skip: !POSIX }, () => {
  for (const name of ['links.jsonl', 'prs.jsonl']) {
    const folder = folderOf();
    writeFileSync(path.join(folder, name), '{"a":1}\n{"partial":', { mode: 0o600 });
    assert.equal(appendRows(folder, name, [{ b: 2 }], { maxBytes: 64 * KB }), true);
    assert.deepEqual(readRows(folder, name, { maxBytes: 64 * KB }), [{ a: 1 }, { b: 2 }], name);
    assert.equal(appendRows(folder, name, [{ c: 3 }], { maxBytes: 64 * KB }), true);
    assert.deepEqual(readRows(folder, name, { maxBytes: 64 * KB }), [{ a: 1 }, { b: 2 }, { c: 3 }], name);
  }
});

// Waits up to `ms` for `file` to be there, without giving the event loop a turn, as a writer between its read and its
// write does.
function waitFor(file, ms) {
  const until = Date.now() + ms;
  while (!existsSync(file) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  return existsSync(file);
}

test('a second writer that appends while the first compacts loses no row: the two writes take turns', { skip: !POSIX }, async () => {
  const folder = folderOf();
  const cap = 4 * KB;
  const name = 'links.jsonl';
  const filler = Array.from({ length: 50 }, (_, index) => ({ index, pad: 'x'.repeat(60) }));
  assert.equal(appendRows(folder, name, filler, { maxBytes: cap }), true);
  assert.ok(statSync(path.join(folder, name)).size > cap - 300, 'at the size boundary');
  const started = path.join(folder, '..', `${path.basename(folder)}.started`);
  const done = path.join(folder, '..', `${path.basename(folder)}.done`);
  const rows = pathToFileURL(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/session-rows.mjs')).href;
  const script = `import { writeFileSync } from 'node:fs';\nimport { appendRows } from ${JSON.stringify(rows)};\n`
    + `writeFileSync(${JSON.stringify(started)}, '');\nconst wrote = appendRows(${JSON.stringify(folder)}, ${JSON.stringify(name)}, [{ second: true }], { maxBytes: ${cap} });\n`
    + `writeFileSync(${JSON.stringify(done)}, String(wrote));\n`;
  let child;
  // The first writer reads the file, then, before its compaction, lets the second writer run as far as it may.
  const select = (_, given) => {
    child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' });
    assert.ok(waitFor(started, 10_000), 'the second writer started');
    waitFor(done, 400);
    return given;
  };
  assert.equal(appendRows(folder, name, [{ first: true, pad: 'y'.repeat(400) }], { maxBytes: cap, select }), true);
  await once(child, 'exit');
  assert.equal(readFileSync(done, 'utf8'), 'true', 'the second writer wrote');
  const kept = readRows(folder, name, { maxBytes: cap });
  assert.ok(kept.some((row) => row.first), 'the first writer`s row');
  assert.ok(kept.some((row) => row.second), 'the second writer`s row');
  assert.ok(statSync(path.join(folder, name)).size <= cap);
});

test('a hard link, a symlink, and a named pipe at the file receive no write', { skip: !POSIX }, () => {
  const row = { at: '2026-11-18T10:00:00.000Z' };
  const linked = folderOf();
  const outside = path.join(ROOT, 'outside.jsonl');
  writeFileSync(outside, '', { mode: 0o600 });
  linkSync(outside, path.join(linked, 'links.jsonl'));
  assert.equal(appendRows(linked, 'links.jsonl', [row], { maxBytes: 64 * KB }), false);
  assert.equal(readFileSync(outside, 'utf8'), '');
  const symlinked = folderOf();
  symlinkSync(outside, path.join(symlinked, 'links.jsonl'));
  assert.equal(appendRows(symlinked, 'links.jsonl', [row], { maxBytes: 64 * KB }), false);
  assert.equal(readFileSync(outside, 'utf8'), '');
  const piped = folderOf();
  spawnSync('mkfifo', [path.join(piped, 'links.jsonl')]);
  const started = Date.now();
  assert.equal(appendRows(piped, 'links.jsonl', [row], { maxBytes: 64 * KB }), false);
  assert.ok(Date.now() - started < 2000);
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
