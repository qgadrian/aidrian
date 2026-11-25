// A usage or rate limit an issue's session of a project run met, and the pause it puts on the run
// (lib/project-run-gate.mjs `wait` and `start`). The host adapter reads the limit from its own error record
// (`capabilities.projectStart.limitOf`), with the record's own time, against which its reset time is read; where a host
// reads none, or its record goes unrecognised, the session ends as any other with no result, and projectRun.issueHours
// stops one that never ends.
// A limit writes a `limit` row whose `until` every start waits for:
//   - the reset time the host's record names, at most PAUSE_CEILING after the record's own time (after the read, where
//     the host gave none or one dated ahead), so no text stretches a pause past 6 hours, and a driver that comes back
//     hours after the limit waits only the rest; and at least PAUSE_FLOOR from the read, as for a reset already past;
//   - with no reset time, BACKOFF: 15, then 30, then 60 minutes for each pause in a row since the last result;
//   - a limit met while a pause lasts joins it: the same `wait` number, its `until` moved later only by a named reset;
//   - past LIMIT_WAITS pauses a run, a `halt` row instead, which an attended `aidrian project resume` lifts.
// A pause ends early, with a `lifted` row (liftRow), only when the host's own record shows the signed-in account changed
// after each limit the pause holds (`changed` of `limitOf`). No session's answer lifts one, a driver's least of all: an
// answer shows nothing of a limit on another model. Each record's pause lifts once, so an account still limited pauses
// again, as a new pause that counts toward LIMIT_WAITS. A pause over early is over for every reader below.
// A host that continues its own session once a usage limit resets (`capabilities.projectStart.continuesAtLimit`) keeps
// it: `wait` records the pause and waits on that session while the pause runs, and RESUME_GRACE past the later of its end
// and the session's newest entry after the limit (recordedPauseRuns). A rate limit, a pause and its grace over with the
// same record still the session's last, a limit past LIMIT_WAITS, a session that ended on the limit, and one of a host that
// does not continue all end the attempt (`ended`, reason `limit`), which counts toward no cap of the issue
// (project-run-guard.mjs spentAttempts), and opens the issue again, or parks it on `attempts` once its attempt numbers
// ran out (project-result.mjs afterFailure); the next start of it, once the pause is over, is a
// new attempt in a fresh clone on the issue's branch as the forge holds it. Time paused does not count toward
// issueHours (pausedTime). The rows live in the run's ledger, so a continuation of the driver sees each pause. A limit
// the driver session meets itself is not this file's: nothing here restarts a driver.

import { afterFailure, cleanText, CAPS } from './project-result.mjs';
import { LIMIT_WAITS, spentAttempts } from './project-run-guard.mjs';

export { LIMIT_WAITS };
const MINUTE = 60_000;
export const PAUSE_FLOOR = MINUTE;
export const PAUSE_CEILING = 6 * 60 * MINUTE;
export const BACKOFF = Object.freeze([15 * MINUTE, 30 * MINUTE, 60 * MINUTE]);
// How long a session the host continues stays held past its pause's end, or past its newest entry after the limit; and
// the most it stays held past its pause's end, however its entries go on, so issueHours is never skipped for long.
export const RESUME_GRACE = 5 * MINUTE;
export const RESUME_CEILING = 30 * MINUTE;
export const LIMIT_KINDS = Object.freeze(['usage', 'rate']);

const iso = (now) => new Date(now).toISOString();
const timeOf = (text) => (typeof text === 'string' ? Date.parse(text) : Number.NaN);

// The `limit` rows of the run `found` (project-run.mjs readRun), in order.
export const limitRows = (found) => found.rows.filter((row) => row.event === 'limit' && Number.isInteger(row.wait) && row.wait >= 1
  && Number.isFinite(timeOf(row.until)) && Number.isFinite(timeOf(row.at)));

// When each lifted pause of the run `found` was lifted, by its `wait` number: the time of its first `lifted` row.
function liftTimes(found) {
  const times = new Map();
  for (const row of found.rows) {
    const at = row.event === 'lifted' && Number.isInteger(row.wait) ? timeOf(row.at) : Number.NaN;
    if (Number.isFinite(at) && !times.has(row.wait)) times.set(row.wait, at);
  }
  return times;
}

// The run's pauses, by their `wait` number: [{ wait, begin, end, key, kind }], `begin` its first row's time and `end` the
// latest `until` any of its rows set, or the time it was lifted, if sooner, `key` and `kind` those of the row that set
// that `until`.
export function pauses(found) {
  const byWait = new Map();
  for (const row of limitRows(found)) {
    const was = byWait.get(row.wait);
    const begin = Math.min(was?.begin ?? Infinity, timeOf(row.at));
    const later = !was || timeOf(row.until) > was.end;
    byWait.set(row.wait, later ? { wait: row.wait, begin, end: timeOf(row.until), key: row.key, kind: row.kind } : { ...was, begin });
  }
  const lifts = liftTimes(found);
  return [...byWait.values()].map((each) => ({ ...each, end: Math.min(each.end, lifts.get(each.wait) ?? Infinity) }));
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

// The limit a host adapter answered, `given`, as the run keeps it: { kind, until, at, after, changed } with kind one of
// LIMIT_KINDS, until a time or null (Infinity for a reset on another day), at the record's own time or null, after the
// time of the newest entry the session's record shows after the limit, and changed the time the host's own entry there
// says the signed-in account changed after it, each null when it shows none; null when the answer names no limit or no
// kind the run knows.
export function checkedLimit(given) {
  if (given === null || typeof given !== 'object' || !LIMIT_KINDS.includes(given.kind)) return null;
  const until = typeof given.until === 'number' && !Number.isNaN(given.until) ? given.until : null;
  const at = Number.isFinite(given.at) ? given.at : null;
  const after = Number.isFinite(given.after) ? given.after : null;
  const changed = Number.isFinite(given.changed) ? given.changed : null;
  return { kind: given.kind, until, at, after, changed };
}

// When the pause for `limit` (checkedLimit) ends, read at `now`, with `streak` the pauses in a row before it: its reset
// time, at most PAUSE_CEILING after the limit's own time, or after now when that is unknown or ahead, and at least
// PAUSE_FLOOR from now; or the BACKOFF step for the streak, from now, when it names none.
export function pauseEnd(limit, streak, now) {
  if (limit.until === null) return now + BACKOFF[Math.min(streak, BACKOFF.length - 1)];
  return Math.max(Math.min(limit.until, Math.min(limit.at ?? now, now) + PAUSE_CEILING), now + PAUSE_FLOOR);
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

// Whether a session the host continues is still held at `now` for the pause the run recorded for this very record of
// attempt `attempt` of issue `key`: while the pause runs, and RESUME_GRACE after the later of its end and the newest
// entry the session's record shows after the limit (`limit.after`, held to `now`), and never RESUME_CEILING past the
// pause's end. A host that continues the session writes its own entry first and the model's answer later, so a session
// whose limit record is still its last assistant entry is not stopped before its first new answer had time to come; and
// an entry dated ahead, or entries that keep coming, hold it no longer than the ceiling, after which the stop path ends
// the attempt as for any session past its pause.
export function recordedPauseRuns(found, key, attempt, limit, now) {
  const waits = new Set(limitRows(found).filter((row) => row.key === key && row.attempt === attempt && (row.record ?? null) === recordOf(limit)).map((row) => row.wait));
  const resumed = Number.isFinite(limit.after) ? Math.min(limit.after, now) : -Infinity;
  return pauses(found).some((each) => waits.has(each.wait) && Math.min(Math.max(each.end, resumed) + RESUME_GRACE, each.end + RESUME_CEILING) > now);
}

// The row that lifts the pause on the run `found` at `now`, or null: { event: 'lifted', wait, key, attempt, record, cause,
// at }, `key`, `attempt`, and `record` those of the pause's first limit. `read(row)` answers the limit the session of the
// `limit` row `row` last met, as the host's record shows it now (checkedLimit), or null. A pause lifts only when, for
// every row that set, extended, or joined it, the host's own entry says the signed-in account changed after that limit
// and no later than now: one that joined shows a limit too, and may be the new account's own. A row with no `record`, a
// record whose pause was lifted before, and a read that shows no limit, or one with no time, lift nothing.
export function liftRow({ found, now, read }) {
  const lasting = pauseOf(found, now);
  if (!lasting) return null;
  const lifts = liftTimes(found);
  const rows = limitRows(found).filter((row) => row.wait === lasting.wait);
  const spent = limitRows(found).filter((row) => lifts.has(row.wait));
  const liftable = (row) => {
    if (spent.some((each) => each.key === row.key && each.attempt === row.attempt && each.record === row.record)) return false;
    const limit = read(row);
    // Neither a row with no record, whose time is NaN, nor a limit that shows no change, null, passes the comparison.
    return limit !== null && limit.at !== null && limit.changed > Math.max(timeOf(row.record), limit.at) && limit.changed <= now;
  };
  if (!rows.every(liftable)) return null;
  const [{ key, attempt, record }] = rows;
  const cause = cleanText(`the host's record shows the signed-in account changed after the limit met by ${[...new Set(rows.map((row) => row.key))].join(', ')}`, CAPS.stop);
  return { event: 'lifted', wait: lasting.wait, key, attempt, record, cause, at: iso(now) };
}

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
// the issue open again, since a limited attempt spends none of the issue's, unless its attempt numbers ran out, which
// parks it on `attempts` (afterFailure), then the pause's row unless this record has one already (pauseRow). The issue
// row follows `ended` at once, as every settle's does, so a park owes its report (project-report.mjs owedReports).
// { rows, until }, until null when the run halts, and the lasting pause's end otherwise.
export function limitEndRows({ found, key, attempt, limit, now }) {
  const at = iso(now);
  const ended = { event: 'ended', key, attempt, reason: 'limit', kind: limit.kind, at };
  // The attempts that count, read with this `ended` row, so the limited attempt counts toward none of them.
  const open = { ...afterFailure(key, spentAttempts({ ...found, rows: [...found.rows, ended] }, key), attempt), at };
  if (limitRecorded(found, key, attempt, limit)) {
    const lasting = pauseOf(found, now);
    return { rows: [ended, open], until: lasting ? Date.parse(lasting.until) : now };
  }
  const paused = pauseRow({ found, key, attempt, limit, now });
  return { rows: [ended, open, paused.row], until: paused.until };
}
