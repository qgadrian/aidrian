// A usage or rate limit an issue's session of a project run met, and the pause it puts on the run
// (lib/project-run-gate.mjs `wait` and `start`). The host adapter reads the limit from its own error record
// (`capabilities.projectStart.limitOf`); where a host reads none, or its record goes unrecognised, the session ends as
// any other with no result, and projectRun.issueHours stops one that never ends.
// A limit ends the attempt (`ended`, reason `limit`), which counts as every attempt does, and opens the issue again while
// attempts remain, so the next start of the same issue, once the pause is over, is a new attempt in a fresh clone on the
// issue's branch as the forge holds it. It writes a `limit` row whose `until` every start waits for:
//   - the reset time the host's record names, clamped to PAUSE_FLOOR .. PAUSE_CEILING from now, so no text stretches a
//     pause past 6 hours;
//   - with no reset time, BACKOFF: 15, then 30, then 60 minutes for each limit in a row since the last result;
//   - past LIMIT_WAITS pauses a run, a `halt` row instead, which an attended `aidrian project resume` lifts.
// The rows live in the run's ledger, so a continuation of the driver sees each pause. A limit the driver session meets
// itself is not this file's: nothing here restarts a driver.

import { afterFailure, cleanText, CAPS } from './project-result.mjs';

const MINUTE = 60_000;
export const PAUSE_FLOOR = MINUTE;
export const PAUSE_CEILING = 6 * 60 * MINUTE;
export const BACKOFF = Object.freeze([15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
// The most pauses one run waits out; the next limit halts it.
export const LIMIT_WAITS = 24;
export const LIMIT_KINDS = Object.freeze(['usage', 'rate']);

const iso = (now) => new Date(now).toISOString();
const timeOf = (text) => (typeof text === 'string' ? Date.parse(text) : Number.NaN);

// The `limit` rows of the run `found` (project-run.mjs readRun), in order.
export const limitRows = (found) => found.rows.filter((row) => row.event === 'limit' && Number.isFinite(timeOf(row.until)) && Number.isFinite(timeOf(row.at)));

// The pause on the run `found` at `now`: { until, key, kind } of the limit row whose pause lasts longest, while it lasts,
// or null.
export function pauseOf(found, now) {
  const longest = limitRows(found).filter((row) => timeOf(row.until) > now).sort((a, b) => timeOf(b.until) - timeOf(a.until))[0];
  return longest ? { until: longest.until, key: longest.key, kind: longest.kind } : null;
}

// The limit a host adapter answered, `given`, as the run keeps it: { kind, until } with kind one of LIMIT_KINDS and
// until a finite time or null, or null when the answer names no limit.
export function checkedLimit(given) {
  if (given === null || typeof given !== 'object') return null;
  const kind = LIMIT_KINDS.includes(given.kind) ? given.kind : 'usage';
  const until = typeof given.until === 'number' && !Number.isNaN(given.until) ? given.until : null;
  return { kind, until };
}

// When the pause for `limit` (checkedLimit) ends, from `now`, with `streak` the limits met in a row before it: its reset
// time clamped to PAUSE_FLOOR .. PAUSE_CEILING from now, or the BACKOFF step for the streak when it names none.
export function pauseEnd(limit, streak, now) {
  const wanted = limit.until ?? now + BACKOFF[Math.min(streak, BACKOFF.length - 1)];
  return Math.min(Math.max(wanted, now + PAUSE_FLOOR), now + PAUSE_CEILING);
}

// The limits the run `found` met in a row: its limit rows since its last `result` row, the last time a session got as far
// as handing its result over.
function streakOf(found) {
  const last = found.rows.findLastIndex((row) => row.event === 'result');
  return found.rows.slice(last + 1).filter((row) => row.event === 'limit').length;
}

// The rows that record the limit `limit` the attempt `attempt` of issue `key` met, at `now`, for the run `found`: the
// attempt `ended` on it, then a `limit` row and its pause, or, once the run waited out LIMIT_WAITS, a `halt` row; then the
// issue open again, or parked once its attempts are spent. { rows, until } with until null when the run halts.
export function limitEndRows({ found, key, attempt, limit, now }) {
  const at = iso(now);
  const ended = { event: 'ended', key, attempt, reason: 'limit', kind: limit.kind, at };
  const waited = limitRows(found).length;
  if (waited >= LIMIT_WAITS) {
    const cause = cleanText(`the run waited out ${waited} usage or rate limits, the most a run waits, and ${key} attempt ${attempt} met another`, CAPS.stop);
    return { rows: [ended, { event: 'halt', cause, key, attempt, at }, { ...afterFailure(key, attempt), at }], until: null };
  }
  const until = pauseEnd(limit, streakOf(found), now);
  const row = { event: 'limit', key, attempt, kind: limit.kind, until: iso(until), named: limit.until !== null, wait: waited + 1, at };
  return { rows: [ended, row, { ...afterFailure(key, attempt), at }], until };
}
