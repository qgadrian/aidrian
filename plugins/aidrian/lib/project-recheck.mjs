// The driver's re-check of a halt whose cause the preflight can check again (docs/config.md#project-run): when
// `aidrian project wait` or `start` meets a run halted by an environment result or a start whose proof failed, it runs
// the preflight's checks of that cause for that run (lib/project-preflight.mjs recheckLines, the same checks, on the
// repository the run pinned, with no person), and when they pass, writes a `resume` row by the driver,
// `via: "recheck"`, naming the checks. One re-check a halt row: one that fails writes a `recheck` row, and the halt
// stays for a person. A forge that could not answer now, as a rate limit, writes a `recheck` row with `retry: true` and
// the time to try again, which uses up nothing. A halt of the same kind on the same issue after a self-lift stays for a
// person too, so a cause the preflight cannot see never starts the issue over and over. Any other halt, such as a usage
// limit's or a failed sandbox proof's, stays for a person as before.

import { appendToRun, latestHalt } from './project-run.mjs';
import { driverOf } from './project-run-guard.mjs';
import { endedIn } from './run-driver.mjs';

// The preflight checks that show each kind of halt cleared: an environment result names its session's sandbox, forge
// sign-in, push, or forge reads; a failed proof, the host's start and hooks, its trust, and its access. The repository
// check, that origin still names the run's repository, runs first for both, and the state folder and the team's policy
// the others need.
export const RECHECKS = Object.freeze({
  environment: Object.freeze(['commit', 'host', 'trust', 'access']),
  proof: Object.freeze(['host', 'trust', 'access']),
});
// The time a re-check may take, as its reads' own limits add up: a `wait` with less left skips it, and a later one runs it.
export const RECHECK_TIMEOUT_MS = 90_000;
// How long a re-check the forge could not answer waits when its line names no time, and the longest, in seconds.
const RETRY_S = 60;
const RETRY_CAP_S = 3600;

// The re-check's lines `lines` (recheckLines), read: { passed, failed, retry }, `passed` the names of its `ok` lines,
// `failed` its blocker lines, and `retry` its `retry` lines, a forge that could not answer now.
export function recheckVerdict(lines) {
  const passed = lines.filter((line) => /^ok \S+$/u.test(line)).map((line) => line.slice(3));
  return { passed, failed: lines.filter((line) => line.startsWith('blocker ')), retry: lines.filter((line) => line.startsWith('retry ')) };
}

// Whether the run `found` self-lifted a halt of `kind` on issue `key` before row `index`.
const liftedBefore = (found, { kind, key, index }) => found.rows.slice(0, index).some((row) => row.event === 'resume' && row.via === 'recheck' && row.kind === kind && row.key === key);
// Whether the halt row at `index` was re-checked already: a `recheck` row that was no retry, or a self-lift, after it.
const checkedAfter = (found, index) => found.rows.slice(index + 1).some((row) => (row.event === 'recheck' && row.retry !== true) || (row.event === 'resume' && row.via === 'recheck'));
// The time, in milliseconds, before which the halt row at `index` waits out a forge that could not answer, or 0.
const retryAfter = (found, index) => Math.max(0, ...found.rows.slice(index + 1).filter((row) => row.event === 'recheck' && row.retry === true).map((row) => Date.parse(row.until) || 0));

// When the halt of the run `found` (readRun) is next re-checked after the forge could not answer, in milliseconds, while
// that time is after `now`; else 0.
export function recheckDue(found, now) {
  const halt = latestHalt(found);
  if (!halt || !RECHECKS[halt.kind] || checkedAfter(found, halt.index)) return 0;
  const due = retryAfter(found, halt.index);
  return due > now ? due : 0;
}

// Re-checks the halt of run `run` in `state`, as `found` (readRun) holds it, for the driver `session`, whose custody
// rests with `custodian` (the run's driver, or the driver a successor takes over from), with `recheck({ repository,
// names })` the re-check's lines for the run's pinned repository: { lifted, lines }, `lines` the lines to print. It lifts
// only when no line is a blocker or a retry and at least one check passed. Nothing happens for a run that is not halted,
// a halt of another kind, one re-checked already or waiting out a retry, with less than RECHECK_TIMEOUT_MS of
// `timeLeft`, or without `recheck`; a second halt of its kind on its issue after a self-lift is kept with no probe. The
// row goes in under the ledger's lock, only while that halt still stands, the run has not ended, and custody still
// rests with `custodian`, so each halt row is re-checked once and its lines printed once.
export function recheckHalt({ state, run, found, session, custodian = session, recheck, now = Date.now(), timeLeft = Infinity }) {
  const halt = latestHalt(found);
  if (!halt || typeof recheck !== 'function' || !RECHECKS[halt.kind] || checkedAfter(found, halt.index)) return { lifted: false, lines: [] };
  if (timeLeft < RECHECK_TIMEOUT_MS || retryAfter(found, halt.index) > now) return { lifted: false, lines: [] };
  const at = new Date(now).toISOString();
  const base = { session, kind: halt.kind, key: halt.key, attempt: halt.attempt };
  const kept = [`recheck kept the halt: ${halt.cause}`];
  let row;
  let lines;
  if (liftedBefore(found, halt)) {
    row = { event: 'recheck', ...base, pass: false, why: 'lifted once', at };
    lines = [...kept, `the run lifted a halt of ${halt.key} of this kind (${halt.kind}) by itself once, so this one waits on a person`];
  } else {
    let out = [];
    try {
      const answer = recheck({ repository: found.init.repository, names: RECHECKS[halt.kind] });
      out = Array.isArray(answer) ? answer : [];
    } catch (error) {
      out = [`retry recheck: the re-check failed (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`];
    }
    const { passed, failed, retry } = recheckVerdict(out);
    if (retry.length && !failed.length) {
      const said = Number(/try again in (\d+) s/u.exec(retry.join(' '))?.[1]);
      const wait = Math.min(Number.isFinite(said) && said > 0 ? said : RETRY_S, RETRY_CAP_S);
      row = { event: 'recheck', ...base, retry: true, until: new Date(now + wait * 1000).toISOString(), why: retry[0].slice(0, 300), at };
      lines = [`recheck waits: ${halt.cause}; the forge could not answer now, so a later wait or start re-checks it after ${row.until}`, ...retry];
    } else {
      let why = failed;
      if (!why.length && !passed.length) why = ['no check of this halt ran'];
      row = why.length ? { event: 'recheck', ...base, pass: false, checks: passed, failed: why.slice(0, 10).map((line) => line.slice(0, 300)), at }
        : { event: 'resume', ...base, via: 'recheck', checks: passed, at };
      lines = why.length ? [...kept, ...why] : [`recheck lifted the halt: ${halt.cause}; ok ${passed.join(', ')}`];
    }
  }
  let written = null;
  try {
    written = appendToRun(state, run, (fresh) => {
      const still = latestHalt(fresh);
      const live = !endedIn(fresh) && driverOf(fresh).session === custodian;
      return live && still && still.index === halt.index && !checkedAfter(fresh, halt.index) ? { rows: [row] } : { rows: [] };
    });
  } catch {
    written = null;
  }
  if (!written || written.problem || !written.rows?.length) return { lifted: false, lines: [] };
  return { lifted: row.event === 'resume', lines };
}
