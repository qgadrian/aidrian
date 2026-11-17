import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { temporaryName, writeSessionFile } from '../plugins/aidrian/lib/session-folder.mjs';
import { sessionUsage } from '../plugins/aidrian/lib/session-length.mjs';
import { cachedSessionUsage, readUsageCache } from '../plugins/aidrian/lib/session-usage-cache.mjs';

const OPUS = 'claude-opus-5-5';

// One transcript line of a request: `id` is its message id, `requestId` its request id, neither for a line with no id.
const call = ({ id, requestId, context, model = OPUS, oneHour = 0 }) => `${JSON.stringify({
  ...(requestId ? { requestId } : {}),
  message: {
    ...(id ? { id } : {}),
    model,
    usage: { input_tokens: 1, cache_read_input_tokens: context - 1 - oneHour, cache_creation_input_tokens: oneHour, cache_creation: { ephemeral_1h_input_tokens: oneHour } },
  },
})}\n`;
const COMPACTION = `${JSON.stringify({ type: 'system', subtype: 'compact_boundary' })}\n`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-usage-cache-'));
  return { dir, transcript: path.join(dir, 'transcript.jsonl'), cacheFile: path.join(dir, 'usage.json') };
}

const whole = (transcript) => sessionUsage(readFileSync(transcript, 'utf8'));
const onDisk = (cacheFile) => JSON.parse(readFileSync(cacheFile, 'utf8'));

test('the cached usage equals a read of the whole transcript after every append, a split line and repeated keys included', () => {
  const { transcript, cacheFile } = fixture();
  const unkeyed = call({ context: 9_000, oneHour: 300 });
  const later = call({ id: 'c', context: 12_000 });
  const appends = [
    call({ id: 'a', context: 5_000 }) + unkeyed + call({ requestId: 'r1', context: 6_000 }),
    // `a` again across the read boundary, after another request's lines, and a line split at the boundary.
    call({ id: 'a', context: 5_500, oneHour: 200 }) + COMPACTION + later.slice(0, 40),
    later.slice(40) + call({ id: 'b', context: 8_000 }),
    // A second line with no id, after the boundary: an entry of its own.
    unkeyed + call({ id: 'a', context: 5_600 }) + call({ requestId: 'r1', context: 6_100, model: 'claude-fable-5-1' }),
    '{"not json',
    ' at all"}\n',
  ];
  for (const text of appends) {
    appendFileSync(transcript, text);
    assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
    // The cache read back from disk carries the next call.
    assert.notEqual(readUsageCache(cacheFile), null);
  }
  const cache = onDisk(cacheFile);
  assert.deepEqual(Object.keys(cache).sort(), ['compactions', 'dev', 'inode', 'offset', 'requests', 'size']);
  assert.deepEqual(cache.requests.map(({ key }) => key), ['id:a', 'unkeyed', 'id:r1', 'id:c', 'id:b', 'unkeyed']);
  assert.equal(cache.offset, statSync(transcript).size);
  assert.equal(cache.compactions, 1);
  assert.equal(whole(transcript).calls, 6);
});

test('a request with no id is an entry no id can merge with, even an id that spells the stored form', () => {
  const { transcript, cacheFile } = fixture();
  appendFileSync(transcript, call({ context: 4_000 }));
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  appendFileSync(transcript, call({ id: 'unkeyed', context: 7_000 }) + call({ requestId: 'id:unkeyed', context: 8_000 }));
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  assert.equal(whole(transcript).calls, 3);
});

test('a call reads only the lines written since the cache was saved', () => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }));
  const before = cachedSessionUsage({ transcript, cacheFile });
  // The same bytes count, the same file: rewritten in place, the folded part is not read again.
  const fd = openSync(transcript, 'r+');
  writeSync(fd, call({ id: 'a', context: 7_000 }), 0);
  closeSync(fd);
  assert.notDeepEqual(whole(transcript), before);
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), before);
});

test('a transcript rewritten in place so the cached offset no longer follows a line feed is read again from the start', () => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  // A longer first line overwrites the line feed the cache stopped after: same file, no smaller.
  const fd = openSync(transcript, 'r+');
  writeSync(fd, call({ id: 'b', context: 123_456_789, model: 'claude-fable-5-1' }), 0);
  closeSync(fd);
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  assert.equal(whole(transcript).model, 'claude-fable-5-1');
});

test('a cache of another device is read again from the start, though its inode, size, and offset match', () => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  const cache = onDisk(cacheFile);
  const wrong = { ...cache, dev: cache.dev + 1, requests: cache.requests.map((each) => ({ ...each, model: 'wrong' })) };
  writeFileSync(cacheFile, JSON.stringify(wrong));
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  // The same cache on the right device is used as it is: the test above is the device check's alone.
  writeFileSync(cacheFile, JSON.stringify({ ...wrong, dev: cache.dev }));
  assert.equal(cachedSessionUsage({ transcript, cacheFile }).model, 'wrong');
});

test('a model named __proto__, in a transcript or in usage.json, leaves Object.prototype alone', () => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000, model: '__proto__' }));
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  assert.equal(Object.hasOwn(Object.prototype, 'calls'), false);
  const cache = onDisk(cacheFile);
  assert.equal(cache.requests[0].model, '__proto__');
  writeFileSync(cacheFile, JSON.stringify(cache));
  assert.equal(cachedSessionUsage({ transcript, cacheFile }).model, '__proto__');
  assert.equal(Object.hasOwn(Object.prototype, 'calls'), false);
  assert.equal({}.calls, undefined);
});

test('a truncated or replaced transcript is read again from the start', () => {
  const { dir, transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }) + call({ id: 'b', context: 9_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  truncateSync(transcript, 0);
  appendFileSync(transcript, call({ id: 'c', context: 3_000 }));
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  assert.equal(whole(transcript).calls, 1);
  const other = path.join(dir, 'other.jsonl');
  writeFileSync(other, call({ id: 'd', context: 4_000 }) + call({ id: 'e', context: 4_500 }) + call({ id: 'f', context: 4_800 }));
  renameSync(other, transcript);
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  assert.equal(whole(transcript).calls, 3);
});

test('a corrupt cache, one keyed __proto__, and one whose offset passes its size are each discarded, not thrown', () => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }) + call({ id: 'b', context: 6_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  const good = onDisk(cacheFile);
  const usage = good.requests[0].usage;
  const bad = [
    'not json',
    JSON.stringify({ ...good, requests: [{ key: '__proto__', model: OPUS, usage }] }),
    JSON.stringify({ ...good, offset: good.size + 1 }),
    JSON.stringify({ ...good, requests: [{ key: 'id:a', model: OPUS, usage: { ...usage, input_tokens: -1 } }] }),
    JSON.stringify({ ...good, requests: [{ key: `id:${'x'.repeat(256)}`, model: OPUS, usage }] }),
    JSON.stringify({ ...good, requests: [good.requests[0], good.requests[0]] }),
    JSON.stringify({ ...good, compactions: 1.5 }),
  ];
  for (const text of bad) {
    writeFileSync(cacheFile, text);
    assert.equal(readUsageCache(cacheFile), null, text.slice(0, 60));
    assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  }
  assert.equal({}.model, undefined);
});

test('a named pipe or a 17 MB file at usage.json is discarded at once', { timeout: 10_000 }, (t) => {
  const { transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  // A good cache padded past the cap: only the cap discards it.
  const good = readFileSync(cacheFile, 'utf8');
  assert.notEqual(readUsageCache(cacheFile), null);
  writeFileSync(cacheFile, good + ' '.repeat(17 * 1000 * 1000));
  assert.equal(readUsageCache(cacheFile), null);
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
  if (spawnSync('mkfifo', [path.join(path.dirname(cacheFile), 'pipe')]).status !== 0) return t.skip('no mkfifo');
  renameSync(path.join(path.dirname(cacheFile), 'pipe'), cacheFile);
  assert.equal(readUsageCache(cacheFile), null);
  assert.deepEqual(cachedSessionUsage({ transcript, cacheFile }), whole(transcript));
});

test('a transcript that is missing or a named pipe gives null at once', { timeout: 10_000 }, (t) => {
  const { dir, cacheFile } = fixture();
  assert.equal(cachedSessionUsage({ transcript: path.join(dir, 'missing.jsonl'), cacheFile }), null);
  const pipe = path.join(dir, 'pipe.jsonl');
  if (spawnSync('mkfifo', [pipe]).status !== 0) return t.skip('no mkfifo');
  assert.equal(cachedSessionUsage({ transcript: pipe, cacheFile }), null);
  assert.deepEqual(readdirSync(dir).sort(), ['pipe.jsonl']);
});

test('usage.json is written through a temporary file and a rename, mode 0600, never through a symlink', () => {
  const { dir, transcript, cacheFile } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }));
  cachedSessionUsage({ transcript, cacheFile });
  if (process.platform !== 'win32') assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).sort(), ['transcript.jsonl', 'usage.json']);
  const target = path.join(dir, 'target');
  writeFileSync(target, 'untouched');
  const token = 'aaaaaaaaaaaa';
  symlinkSync(target, temporaryName(dir, 'usage.json', token));
  assert.equal(writeSessionFile(dir, 'usage.json', 'changed', { token }), null);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.notEqual(readFileSync(cacheFile, 'utf8'), 'changed');
});

test('with no cache file the whole transcript is read and nothing is written', () => {
  const { dir, transcript } = fixture();
  writeFileSync(transcript, call({ id: 'a', context: 5_000 }) + call({ context: 6_000 }).trimEnd());
  assert.deepEqual(cachedSessionUsage({ transcript }), whole(transcript));
  assert.deepEqual(readdirSync(dir), ['transcript.jsonl']);
});
