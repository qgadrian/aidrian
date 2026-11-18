// A session's handoff numbers, sessionUsage's answer, read incrementally: the usage cache, `usage.json` in the session's
// folder (lib/session-folder.mjs), keeps the fold of the transcript's lines read so far, so each call reads only the
// lines written since. It folds with the fold sessionUsage uses (lib/session-length.mjs), so the answer is the same as a
// read of the whole transcript. Display data only: the Stop hook keeps reading the whole transcript.
//   usage.json  { offset, size, dev, inode, prefix, requests: [{ key, model, usage }], compactions }
// `offset` is the byte after the last line folded, `size`, `dev`, and `inode` the transcript's when it was read, `prefix`
// the SHA-256 of the first and the last PREFIX_WINDOW bytes before `offset` (every byte before it, when that is no more
// than both windows), and `requests` the fold's requests in first-seen order. A key is `id:<id>` for a request with a
// message or request id, and `unkeyed` for a line with neither, an entry of its own that no id can merge with.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { foldedUsage, foldUsage, newUsageFold, storedUsage, USAGE_FIELDS, usageFromStored } from './session-length.mjs';
import { readSessionFile, writeSessionFile } from './session-folder.mjs';

// A usage.json larger than this is never read.
export const USAGE_CACHE_CAP = 16 * 1024 * 1024;
const KEY_CAP = 256;
const MODEL_CAP = 200;
const ID_PREFIX = 'id:';
const UNKEYED = 'unkeyed';
const SHA256 = /^[0-9a-f]{64}$/u;
// The transcript is opened non-blocking, so a FIFO given as one never makes the read wait.
const READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

// How much of the transcript one step reads, at most, past the end of the line it must finish.
export const CHUNK_BYTES = 8 * 1024 * 1024;
// SHORTCUT: `prefix` hashes this much at each end of the bytes folded before, never the middle, so a warm call costs the
// same at any transcript size. A rewrite in place confined to the middle goes unseen, and its old fold stays: the cache
// is display data, and a transcript is only ever appended to. A window rewritten while a fold runs goes unseen too: each
// save hashes the windows read again from the file, not the bytes it folded, so the cache can pair the old fold with the
// new bytes. The way to close it: hash the tail from the bytes just folded, and the head from the first step.
export const PREFIX_WINDOW = 64 * 1024;

// sessionUsage of the transcript at `transcript`, folding only what was written since the cache at `cacheFile`, a
// usage.json in a folder sessionFolder gave (readSessionFile), was saved. With no cache file, or a cache that cannot be
// used, it folds the whole transcript: a cache of another file, of a larger one, or whose `prefix` is not the hash of the
// transcript's windows before its offset, as after the file was rewritten in place there, at the same length included.
// So a warm call reads at most two windows of the bytes folded before. It reads in steps of `chunkBytes`, each folded up to
// its last line feed and saved to the cache, so memory stays bounded by the step, or by one longer line, and a read
// stopped midway goes on from there next time. The read stops at the size fstat gave. Null when the transcript is missing, unreadable, or no regular file.
// It writes no cache its reader would refuse: none past `cacheCap`, or with a key or model past its length; the last good
// one then stays. Never throws.
export function cachedSessionUsage({ transcript, cacheFile = null, chunkBytes = CHUNK_BYTES, cacheCap = USAGE_CACHE_CAP }) {
  let fd;
  try {
    fd = openSync(transcript, READ);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const cache = cacheFile ? readUsageCache(cacheFile, { cap: cacheCap }) : null;
    const step = Number.isSafeInteger(chunkBytes) && chunkBytes > 0 ? chunkBytes : CHUNK_BYTES;
    const windows = Buffer.allocUnsafe(2 * PREFIX_WINDOW);
    const sameFile = cache && cache.dev === stat.dev && cache.inode === stat.ino && cache.size <= stat.size;
    const fits = sameFile && prefixHash(fd, cache.offset, windows) === cache.prefix;
    const fold = fits ? cache.fold : newUsageFold();
    const save = (offset) => {
      const prefix = cacheFile && prefixHash(fd, offset, windows);
      const text = prefix && cacheText(fold, { offset, size: stat.size, dev: stat.dev, inode: stat.ino, prefix });
      return text && Buffer.byteLength(text) <= cacheCap ? writeSessionFile(path.dirname(cacheFile), path.basename(cacheFile), text) : null;
    };
    let offset = fits ? cache.offset : 0;
    let saved = fits && cache.size === stat.size;
    for (let line = nextLines(fd, offset, stat.size, step); line.length; line = nextLines(fd, offset, stat.size, step)) {
      foldUsage(fold, line.toString('utf8'));
      offset += line.length;
      saved = save(offset) !== null || saved;
    }
    if (!saved) save(offset);
    const rest = readRange(fd, offset, stat.size);
    if (!rest.length) return foldedUsage(fold);
    // A last line with no line feed yet is read now and again next time, when it may have grown.
    const copy = { requests: new Map(fold.requests), compactions: fold.compactions };
    return foldedUsage(foldUsage(copy, rest.toString('utf8')));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The whole lines of `fd` from `offset`, about `chunkBytes` of them, ending at a line feed: a step grows by `chunkBytes`
// until it holds one, and is empty when none is left before `size`.
function nextLines(fd, offset, size, chunkBytes) {
  for (let end = Math.min(offset + chunkBytes, size); ; end = Math.min(end + chunkBytes, size)) {
    const bytes = readRange(fd, offset, end);
    const whole = bytes.lastIndexOf(0x0a) + 1;
    if (whole > 0 || end >= size) return bytes.subarray(0, whole);
  }
}

// The hex SHA-256 of the first and the last PREFIX_WINDOW bytes of `fd` before `end`, read into `windows`, a buffer of
// both windows that every call reuses: every byte before `end` when that fits. Null when the file ends first.
function prefixHash(fd, end, windows) {
  const head = Math.min(end, PREFIX_WINDOW);
  const tail = Math.max(head, end - PREFIX_WINDOW);
  const length = head + end - tail;
  if (readInto(fd, windows, 0, head, 0) < head || readInto(fd, windows, head, length, tail) < length) return null;
  return createHash('sha256').update(windows.subarray(0, length)).digest('hex');
}

// Reads the bytes of `fd` from `position` into `buffer` from `start` up to `end`; how far it got, short when the file ends.
function readInto(fd, buffer, start, end, position) {
  let at = start;
  for (let n = 1; n > 0 && at < end; at += n) n = readSync(fd, buffer, at, end - at, position + at - start);
  return at;
}

// The bytes of `fd` from `start` to `end`, or fewer when the file ends first.
function readRange(fd, start, end) {
  const bytes = Buffer.alloc(Math.max(end - start, 0));
  let read = 0;
  for (let n = 1; n > 0 && read < bytes.length; read += n) n = readSync(fd, bytes, read, bytes.length - read, start + read);
  return bytes.subarray(0, read);
}

// The cache's text, or null when a request's key or model is longer than the reader takes.
function cacheText(fold, { offset, size, dev, inode, prefix }) {
  const requests = [...fold.requests].map(([key, { model, usage }]) => ({
    key: typeof key === 'string' ? `${ID_PREFIX}${key}` : UNKEYED,
    model,
    usage: storedUsage(usage),
  }));
  if (!requests.every(isRequest)) return null;
  return `${JSON.stringify({ offset, size, dev, inode, prefix, requests, compactions: fold.compactions })}\n`;
}

const count = (value) => Number.isInteger(value) && value >= 0;
const isStoredUsage = (usage) => typeof usage === 'object' && usage !== null && !Array.isArray(usage)
  && Object.keys(usage).length === USAGE_FIELDS.length
  && USAGE_FIELDS.every((field) => Number.isFinite(usage[field]) && usage[field] >= 0);
const isRequest = (each) => typeof each === 'object' && each !== null
  && typeof each.key === 'string' && each.key.length <= KEY_CAP && (each.key === UNKEYED || each.key.startsWith(ID_PREFIX))
  && typeof each.model === 'string' && each.model.length <= MODEL_CAP && isStoredUsage(each.usage);

// The cache at `file`, read through readSessionFile alone: { offset, size, dev, inode, prefix, fold }, or null when its
// folder fails boundFolder, or it is missing, a symlink, no regular file,
// owned by another user, larger than USAGE_CACHE_CAP, not JSON, or not of the cache's shape: offset, size, dev, inode,
// and compactions non-negative integers with offset at most size, prefix a hex SHA-256, and each request a key, a model, and usage numbers, no
// id twice. The requests are rebuilt as the fold's Map, never as an object keyed by a transcript value.
export function readUsageCache(file, { cap = USAGE_CACHE_CAP } = {}) {
  const read = readSessionFile(path.dirname(file), path.basename(file), { cap });
  if (!read) return null;
  let value;
  try {
    value = JSON.parse(read.text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { offset, size, dev, inode, prefix, requests, compactions } = value;
  if (![offset, size, dev, inode, compactions].every(count) || offset > size || typeof prefix !== 'string' || !SHA256.test(prefix)) return null;
  if (!Array.isArray(requests) || !requests.every(isRequest)) return null;
  const fold = newUsageFold();
  fold.compactions = compactions;
  for (const { key, model, usage } of requests) {
    const id = key === UNKEYED ? Symbol('unkeyed') : key.slice(ID_PREFIX.length);
    if (fold.requests.has(id)) return null;
    fold.requests.set(id, { model, usage: usageFromStored(usage) });
  }
  return { offset, size, dev, inode, prefix, fold };
}
