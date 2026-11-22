// The driver's re-check of a halt whose cause the preflight can check again (docs/config.md#project-run): when the
// driver's `aidrian project start` of the halted issue meets a run halted by that issue's environment result or a start
// of it whose proof failed, it runs the preflight's checks of that cause for that run (lib/project-preflight.mjs
// recheckLines, the same checks, on the repository the run pinned, with no person), and when they pass, writes a
// `resume` row by the driver, `via: "recheck"`, naming the checks. One re-check a halt row: one that fails writes a
// `recheck` row, and the halt stays for a person. A forge that could not answer now, as a rate limit, writes nothing:
// no lift this time, and the next start re-checks. A halt of the same kind on the same issue after a self-lift stays for
// a person too, so a cause the preflight cannot see never starts the issue over and over. Any other halt, such as a
// usage limit's or a failed sandbox proof's, stays for a person as before.

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

// The re-check's lines `lines` (recheckLines), read: { passed, failed, retry }, `passed` the names of its `ok` lines,
// `failed` its blocker lines, and `retry` its `retry` lines, a forge that could not answer now.
export function recheckVerdict(lines) {
  const passed = lines.filter((line) => /^ok \S+$/u.test(line)).map((line) => line.slice(3));
  return { passed, failed: lines.filter((line) => line.startsWith('blocker ')), retry: lines.filter((line) => line.startsWith('retry ')) };
}

// Whether the run `found` self-lifted a halt of `kind` on issue `key` before row `index`.
const liftedBefore = (found, { kind, key, index }) => found.rows.slice(0, index).some((row) => row.event === 'resume' && row.via === 'recheck' && row.kind === kind && row.key === key);
// Whether the halt row at `index` was re-checked already: a `recheck` row, or a self-lift, after it.
const checkedAfter = (found, index) => found.rows.slice(index + 1).some((row) => row.event === 'recheck' || (row.event === 'resume' && row.via === 'recheck'));

// Re-checks the halt of run `run` in `state`, as `found` (readRun) holds it, for the driver `session` starting issue
// `key`, whose custody rests with `custodian` (the run's driver, or the driver a successor takes over from), with
// `recheck({ repository, names })` the re-check's lines for the run's pinned repository: { lifted, lines }, `lines` the
// lines to print. It lifts only when no line is a blocker or a retry and at least one check passed. Nothing happens for
// a run that is not halted, a halt of another kind or of another issue than `key`, one re-checked already, or without
// `recheck`; a second halt of its kind on its issue after a self-lift is kept with no probe; a forge that could not
// answer now keeps the halt and writes nothing. A row goes in under the ledger's lock, only while that halt still
// stands, the run has not ended, and custody still rests with `custodian`, so each halt row is decided once.
export function recheckHalt({ state, run, found, session, key, custodian = session, recheck, now = Date.now() }) {
  const halt = latestHalt(found);
  if (!halt || typeof recheck !== 'function' || !RECHECKS[halt.kind] || halt.key !== key || checkedAfter(found, halt.index)) return { lifted: false, lines: [] };
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
    // A forge that could not answer says nothing either way: no lift this time, and nothing used up.
    if (retry.length && !failed.length) return { lifted: false, lines: [...kept, ...retry, 'the forge could not answer now, so the next start re-checks it'] };
    const why = failed.length || passed.length ? failed : ['no check of this halt ran'];
    row = why.length ? { event: 'recheck', ...base, pass: false, checks: passed, failed: why.slice(0, 10).map((line) => line.slice(0, 300)), at }
      : { event: 'resume', ...base, via: 'recheck', checks: passed, at };
    lines = why.length ? [...kept, ...why] : [`recheck lifted the halt: ${halt.cause}; ok ${passed.join(', ')}`];
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
