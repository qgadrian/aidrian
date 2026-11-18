// A usage or rate limit an issue's session of a project run met, and the pause it puts on the run
// (lib/project-run-gate.mjs `wait` and `start`). The host adapter reads the limit from its own error record
// (`capabilities.projectStart.limitOf`), with the record's own time, against which its reset time is read; where a host
// reads none, or its record goes unrecognised, the session ends as any other with no result, and projectRun.issueHours
// stops one that never ends.
// A limit writes a `limit` row whose `until` every start waits for:
//   - the reset time the host's record names, clamped to PAUSE_FLOOR .. PAUSE_CEILING from now, so no text stretches a
//     pause past 6 hours, and a reset already past waits the floor;
//   - with no reset time, BACKOFF: 15, then 30, then 60 minutes for each pause in a row since the last result;
//   - a limit met while a pause lasts joins it: the same `wait` number, its `until` moved later only by a named reset;
//   - past LIMIT_WAITS pauses a run, a `halt` row instead, which an attended `aidrian project resume` lifts.
// A host that continues its own session once the limit resets (`capabilities.projectStart.continuesAtLimit`) keeps it:
// `wait` records the pause and waits on that session. A session that ended on the limit, or one of a host that does not
// continue, ends the attempt (`ended`, reason `limit`), which counts toward no cap of the issue
// (project-run-guard.mjs spentAttempts), and opens the issue again; the next start of it, once the pause is over, is a
// new attempt in a fresh clone on the issue's branch as the forge holds it. Time paused does not count toward
// issueHours (pausedTime). The rows live in the run's ledger, so a continuation of the driver sees each pause. A limit
// the driver session meets itself is not this file's: nothing here restarts a driver.

import { cleanText, CAPS } from './project-result.mjs';
import { LIMIT_WAITS } from './project-run-guard.mjs';

export { LIMIT_WAITS };
const MINUTE = 60_000;
export const PAUSE_FLOOR = MINUTE;
export const PAUSE_CEILING = 6 * 60 * MINUTE;
export const BACKOFF = Object.freeze([15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
export const LIMIT_KINDS = Object.freeze(['usage', 'rate']);

const iso = (now) => new Date(now).toISOString();
const timeOf = (text) => (typeof text === 'string' ? Date.parse(text) : Number.NaN);

// The `limit` rows of the run `found` (project-run.mjs readRun), in order.
export const limitRows = (found) => found.rows.filter((row) => row.event === 'limit' && Number.isInteger(row.wait) && row.wait >= 1
  && Number.isFinite(timeOf(row.until)) && Number.isFinite(timeOf(row.at)));

// The run's pauses, by their `wait` number: [{ wait, begin, end, key, kind }], `begin` its first row's time and `end` the
// latest `until` any of its rows set, `key` and `kind` those of the row that set it.
export function pauses(found) {
  const byWait = new Map();
  for (const row of limitRows(found)) {
    const was = byWait.get(row.wait);
    const begin = Math.min(was?.begin ?? Infinity, timeOf(row.at));
    const later = !was || timeOf(row.until) > was.end;
    byWait.set(row.wait, later ? { wait: row.wait, begin, end: timeOf(row.until), key: row.key, kind: row.kind } : { ...was, begin });
  }
  return [...byWait.values()];
}

// The pause on the run `found` at `now`: { until, key, kind, wait } of the pause that lasts longest, while it lasts, or
// null.
export function pauseOf(found, now) {
  const longest = pauses(found).filter((each) => each.end > now).sort((a, b) => b.end - a.end)[0];
  return longest ? { until: iso(longest.end), key: longest.key, kind: longest.kind, wait: longest.wait } : null;
}

// How long the run `found` was paused between `from` and `to`, in milliseconds, with pauses that overlap counted once.
export function pausedTime(found, from, to) {
  const spans = pauses(found).map((each) => [Math.max(each.begin, from), Math.min(each.end, to)]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let reach = from;
  for (const [a, b] of spans) {
    const start = Math.max(a, reach);
    if (b > start) total += b - start;
    reach = Math.max(reach, b);
  }
  return total;
}

// The limit a host adapter answered, `given`, as the run keeps it: { kind, until, at } with kind one of LIMIT_KINDS,
// until a time or null (Infinity for a reset on another day), and at the record's own time or null; null when the answer
// names no limit or no kind the run knows.
export function checkedLimit(given) {
  if (given === null || typeof given !== 'object' || !LIMIT_KINDS.includes(given.kind)) return null;
  const until = typeof given.until === 'number' && !Number.isNaN(given.until) ? given.until : null;
  const at = Number.isFinite(given.at) ? given.at : null;
  return { kind: given.kind, until, at };
}

// When the pause for `limit` (checkedLimit) ends, from `now`, with `streak` the pauses in a row before it: its reset
// time clamped to PAUSE_FLOOR .. PAUSE_CEILING from now, or the BACKOFF step for the streak when it names none.
export function pauseEnd(limit, streak, now) {
  const wanted = limit.until ?? now + BACKOFF[Math.min(streak, BACKOFF.length - 1)];
  return Math.min(Math.max(wanted, now + PAUSE_FLOOR), now + PAUSE_CEILING);
}

// The pauses of the run `found` in a row: those whose rows come after its last `result` row, the last time a session got
// as far as handing its result over.
function streakOf(found) {
  const last = found.rows.findLastIndex((row) => row.event === 'result');
  return new Set(limitRows({ rows: found.rows.slice(last + 1) }).map((row) => row.wait)).size;
}

// The record `limit` names: its own time, or null when the host gave none.
const recordOf = (limit) => (limit.at === null ? null : iso(limit.at));

// Whether the run `found` holds a `limit` row for this very record of attempt `attempt` of issue `key`.
export const limitRecorded = (found, key, attempt, limit) => limitRows(found).some((row) => row.key === key && row.attempt === attempt && (row.record ?? null) === recordOf(limit));

// The row that records the limit `limit` attempt `attempt` of issue `key` met, at `now`: { row, until } with `until` the
// pause's end, a row of a new pause or one that joins the pause that lasts, or, past LIMIT_WAITS pauses, a `halt` row
// with `until` null.
export function pauseRow({ found, key, attempt, limit, now }) {
  const at = iso(now);
  const base = { event: 'limit', key, attempt, kind: limit.kind, record: recordOf(limit), named: limit.until !== null, at };
  const lasting = pauseOf(found, now);
  if (lasting) {
    const end = limit.until === null ? Date.parse(lasting.until) : Math.max(Date.parse(lasting.until), pauseEnd(limit, 0, now));
    return { row: { ...base, until: iso(end), wait: lasting.wait, joined: true }, until: end };
  }
  const waited = pauses(found).length;
  if (waited >= LIMIT_WAITS) {
    const cause = cleanText(`the run waited out ${waited} usage or rate limits, the most a run waits, and ${key} attempt ${attempt} met another`, CAPS.stop);
    return { row: { event: 'halt', cause, key, attempt, at }, until: null };
  }
  const end = pauseEnd(limit, streakOf(found), now);
  return { row: { ...base, until: iso(end), wait: waited + 1 }, until: end };
}

// The rows that end attempt `attempt` of issue `key` on the limit `limit`, at `now`, for the run `found`: `ended`, then
// the pause's row unless this record has one already (pauseRow), then the issue open again, since a limited attempt
// spends none of the issue's. { rows, until }, until null when the run halts, and the lasting pause's end otherwise.
export function limitEndRows({ found, key, attempt, limit, now }) {
  const at = iso(now);
  const ended = { event: 'ended', key, attempt, reason: 'limit', kind: limit.kind, at };
  const open = { event: 'issue', key, state: 'open', at };
  if (limitRecorded(found, key, attempt, limit)) {
    const lasting = pauseOf(found, now);
    return { rows: [ended, open], until: lasting ? Date.parse(lasting.until) : now };
  }
  const paused = pauseRow({ found, key, attempt, limit, now });
  return { rows: [ended, paused.row, open], until: paused.until };
}
