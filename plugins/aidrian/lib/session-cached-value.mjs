// A value a session keeps in its folder (lib/session-folder.mjs) and refreshes at most once a window, such as the merged
// heads `aidrian session snapshot` reads from the forge. The file holds { value, valueAt, attemptAt }: the value, when it
// was stored, and when the last refresh was attempted. Display data only.

import path from 'node:path';

import { readOwnFile } from './handoff-markers.mjs';
import { reserveSessionFile, writeSessionFile } from './session-folder.mjs';

const EMPTY = Object.freeze({ value: null, valueAt: null, attemptAt: null });

// A value a session keeps in the file `name` of its folder, refreshed at most once a window: { value, stale }, or null
// when none is stored and none can be read now. The file holds { value, valueAt, attemptAt }. When the last attempt is
// less than `windowMs` from `now`, before or after it, it starts none, and gives the stored value, stale unless that attempt stored it. Otherwise it records
// the attempt as one exclusive step: it reserves the file (reserveSessionFile, which takes over a reservation older than
// the window), reads it again, writes the attempt by writeSessionFile's temporary file and rename unless another process
// recorded one since the first read, and releases. Only then does it call `refresh`, whose null or throw keeps the stored
// value, stale. An attempt another process recorded meanwhile counts as inside the window. With no folder, a reservation
// another process holds, or an attempt it cannot record, it calls nothing and gives the stored value, stale. So a session starts at most one refresh a window, whether
// the last succeeded, failed, ran out of time, or was killed, and however many readers start at once. `cap` bounds the
// file's read, and `isValue` checks the value's shape.
export function cachedValue({ folder, name, windowMs, cap, isValue, refresh, now = Date.now() }) {
  const file = folder ? path.join(folder, name) : null;
  const stored = file ? readCached(file, cap, isValue) : EMPTY;
  if (inWindow(stored, now, windowMs)) return kept(stored, stored.valueAt < stored.attemptAt);
  const attempt = file ? recordAttempt({ folder, name, file, cap, isValue, windowMs, now, seen: stored }) : null;
  if (attempt === null) return kept(stored, true);
  if (attempt !== RECORDED) return kept(attempt, attempt.valueAt < attempt.attemptAt);
  let value;
  try {
    value = refresh() ?? null;
  } catch {
    value = null;
  }
  if (value === null) return kept(stored, true);
  // A value whose text no later read would take is not stored; the attempt still is, so the window holds.
  const text = cacheText({ value, valueAt: Math.max(Date.now(), now), attemptAt: now });
  writeSessionFile(folder, name, Buffer.byteLength(text) > cap ? cacheText({ ...EMPTY, attemptAt: now }) : text);
  return { value, stale: false };
}

const RECORDED = Symbol('recorded');
// An attempt a little after `now` is another process's, whose clock read came later: it counts as inside the window. One a
// window or more away either way, as after the clock went back, does not.
const inWindow = ({ attemptAt }, now, windowMs) => attemptAt !== null && Math.abs(now - attemptAt) < windowMs;
const kept = (stored, stale) => (stored.valueAt === null ? null : { value: stored.value, stale });

// Records the attempt at `now` under the file's reservation: RECORDED when this call recorded it, the cache as read again
// when another process recorded one after `seen` was read, or null when the reservation or the write failed.
function recordAttempt({ folder, name, file, cap, isValue, windowMs, now, seen }) {
  const release = reserveSessionFile(folder, name, { staleMs: windowMs, now });
  if (!release) return null;
  try {
    const current = readCached(file, cap, isValue);
    if (current.attemptAt !== seen.attemptAt) return current;
    return writeSessionFile(folder, name, cacheText({ ...current, attemptAt: now })) ? RECORDED : null;
  } finally {
    release();
  }
}

const cacheText = ({ value, valueAt, attemptAt }) => `${JSON.stringify({ value, valueAt, attemptAt })}\n`;
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;

// The cache at `file` under the Reads rule (readOwnFile), or EMPTY; a value of the wrong shape reads as none.
function readCached(file, cap, isValue) {
  const read = readOwnFile(file, { cap });
  try {
    const { value, valueAt, attemptAt } = JSON.parse(read?.text ?? 'null');
    if (!isTime(attemptAt)) return EMPTY;
    return isTime(valueAt) && isValue(value) ? { value, valueAt, attemptAt } : { ...EMPTY, attemptAt };
  } catch {
    return EMPTY;
  }
}
