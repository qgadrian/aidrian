// A value a session keeps in its folder (lib/session-folder.mjs) and refreshes at most once a window, such as the merged
// heads `aidrian session snapshot` reads from the forge. The file holds { value, valueAt, attemptAt }: the value, when it
// was stored, and when the last refresh was attempted. Display data only.

import path from 'node:path';

import { readOwnFile } from './handoff-markers.mjs';
import { writeSessionFile } from './session-folder.mjs';

const EMPTY = Object.freeze({ value: null, valueAt: null, attemptAt: null });

// A value a session keeps in the file `name` of its folder, refreshed at most once a window: { value, stale }, or null
// when none is stored and none can be read now. The file holds { value, valueAt, attemptAt }. When the last attempt is
// inside `windowMs` it starts none, and gives the stored value, stale unless that attempt stored it. Otherwise it first
// records the attempt, by writeSessionFile's temporary file and rename, then calls `refresh`, whose null or throw keeps
// the stored value, stale. With no folder, or an attempt it cannot record, it calls nothing. So a session starts at most
// one refresh a window, whether the last succeeded, failed, ran out of time, or was killed. `cap` bounds the file's
// read, and `isValue` checks the value's shape.
export function cachedValue({ folder, name, windowMs, cap, isValue, refresh, now = Date.now() }) {
  const stored = folder ? readCached(path.join(folder, name), cap, isValue) : EMPTY;
  const kept = (stale) => (stored.valueAt === null ? null : { value: stored.value, stale });
  if (stored.attemptAt !== null && now >= stored.attemptAt && now - stored.attemptAt < windowMs) return kept(stored.valueAt < stored.attemptAt);
  if (!folder || !writeSessionFile(folder, name, cacheText({ ...stored, attemptAt: now }))) return kept(true);
  let value;
  try {
    value = refresh() ?? null;
  } catch {
    value = null;
  }
  if (value === null) return kept(true);
  // A value whose text no later read would take is not stored; the attempt still is, so the window holds.
  const text = cacheText({ value, valueAt: Math.max(Date.now(), now), attemptAt: now });
  writeSessionFile(folder, name, Buffer.byteLength(text) > cap ? cacheText({ ...EMPTY, attemptAt: now }) : text);
  return { value, stale: false };
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
