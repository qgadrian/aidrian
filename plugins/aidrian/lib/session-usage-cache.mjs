// A session's handoff numbers, sessionUsage's answer, read incrementally: the usage cache, `usage.json` in the session's
// folder (lib/session-folder.mjs), keeps the fold of the transcript's lines read so far, so each call reads only the
// lines written since. It folds with the fold sessionUsage uses (lib/session-length.mjs), so the answer is the same as a
// read of the whole transcript. Display data only: the Stop hook keeps reading the whole transcript.
//   usage.json  { offset, size, dev, inode, requests: [{ key, model, usage }], compactions }
// `offset` is the byte after the last line folded, `size`, `dev`, and `inode` the transcript's when it was read, and
// `requests` the fold's requests in first-seen order. A key is `id:<id>` for a request with a message or request id, and
// `unkeyed` for a line with neither, an entry of its own that no id can merge with.

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { readOwnFile } from './handoff-markers.mjs';
import { foldedUsage, foldUsage, newUsageFold, storedUsage, USAGE_FIELDS, usageFromStored } from './session-length.mjs';
import { writeSessionFile } from './session-folder.mjs';

// A usage.json larger than this is never read.
export const USAGE_CACHE_CAP = 16 * 1024 * 1024;
const KEY_CAP = 256;
const MODEL_CAP = 200;
const ID_PREFIX = 'id:';
const UNKEYED = 'unkeyed';
// The transcript is opened non-blocking, so a FIFO given as one never makes the read wait.
const READ = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

// sessionUsage of the transcript at `transcript`, reading only what was written since the cache at `cacheFile`, a
// usage.json in a folder sessionFolder gave, was saved, then saving the cache. With no cache file, or a cache that
// cannot be used, it reads the whole transcript: a cache of another file, of a larger one, or whose offset no longer
// follows a line feed, as after the file was rewritten in place. The read stops at the size fstat gave. Null when the
// transcript is missing, unreadable, or no regular file. Never throws.
export function cachedSessionUsage({ transcript, cacheFile = null }) {
  let fd;
  try {
    fd = openSync(transcript, READ);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const cache = cacheFile ? readUsageCache(cacheFile) : null;
    const fits = cache && cache.dev === stat.dev && cache.inode === stat.ino && cache.size <= stat.size
      && (cache.offset === 0 || readRange(fd, cache.offset - 1, cache.offset)[0] === 0x0a);
    const fold = fits ? cache.fold : newUsageFold();
    const offset = fits ? cache.offset : 0;
    const bytes = readRange(fd, offset, stat.size);
    const whole = bytes.lastIndexOf(0x0a) + 1;
    foldUsage(fold, bytes.subarray(0, whole).toString('utf8'));
    if (cacheFile && (!fits || whole > 0 || cache.size !== stat.size)) {
      writeSessionFile(path.dirname(cacheFile), path.basename(cacheFile), cacheText(fold, { offset: offset + whole, size: stat.size, dev: stat.dev, inode: stat.ino }));
    }
    if (whole === bytes.length) return foldedUsage(fold);
    // A last line with no line feed yet is read now and again next time, when it may have grown.
    const copy = { requests: new Map(fold.requests), compactions: fold.compactions };
    return foldedUsage(foldUsage(copy, bytes.subarray(whole).toString('utf8')));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The bytes of `fd` from `start` to `end`, or fewer when the file ends first.
function readRange(fd, start, end) {
  const bytes = Buffer.alloc(Math.max(end - start, 0));
  let read = 0;
  for (let n = 1; n > 0 && read < bytes.length; read += n) n = readSync(fd, bytes, read, bytes.length - read, start + read);
  return bytes.subarray(0, read);
}

function cacheText(fold, { offset, size, dev, inode }) {
  const requests = [...fold.requests].map(([key, { model, usage }]) => ({
    key: typeof key === 'string' ? `${ID_PREFIX}${key}` : UNKEYED,
    model,
    usage: storedUsage(usage),
  }));
  return `${JSON.stringify({ offset, size, dev, inode, requests, compactions: fold.compactions })}\n`;
}

const count = (value) => Number.isInteger(value) && value >= 0;
const isStoredUsage = (usage) => typeof usage === 'object' && usage !== null && !Array.isArray(usage)
  && Object.keys(usage).length === USAGE_FIELDS.length
  && USAGE_FIELDS.every((field) => Number.isFinite(usage[field]) && usage[field] >= 0);
const isRequest = (each) => typeof each === 'object' && each !== null
  && typeof each.key === 'string' && each.key.length <= KEY_CAP && (each.key === UNKEYED || each.key.startsWith(ID_PREFIX))
  && typeof each.model === 'string' && each.model.length <= MODEL_CAP && isStoredUsage(each.usage);

// The cache at `file`: { offset, size, dev, inode, fold }, or null when it is missing, a symlink, no regular file, owned
// by another user, larger than USAGE_CACHE_CAP, not JSON, or not of the cache's shape: offset, size, dev, inode, and
// compactions non-negative integers with offset at most size, and each request a key, a model, and usage numbers, no
// id twice. The requests are rebuilt as the fold's Map, never as an object keyed by a transcript value.
export function readUsageCache(file) {
  const read = readOwnFile(file, { cap: USAGE_CACHE_CAP });
  if (!read) return null;
  let value;
  try {
    value = JSON.parse(read.text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { offset, size, dev, inode, requests, compactions } = value;
  if (![offset, size, dev, inode, compactions].every(count) || offset > size) return null;
  if (!Array.isArray(requests) || !requests.every(isRequest)) return null;
  const fold = newUsageFold();
  fold.compactions = compactions;
  for (const { key, model, usage } of requests) {
    const id = key === UNKEYED ? Symbol('unkeyed') : key.slice(ID_PREFIX.length);
    if (fold.requests.has(id)) return null;
    fold.requests.set(id, { model, usage: usageFromStored(usage) });
  }
  return { offset, size, dev, inode, fold };
}
