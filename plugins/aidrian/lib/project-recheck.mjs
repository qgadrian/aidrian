// The driver's re-check of a halt whose cause the preflight can check again (docs/config.md#project-run): when
// `aidrian project wait` or `start` meets a run halted by an environment result or a start whose proof failed, it runs
// the preflight for that run (lib/project-preflight.mjs, the same checks, with no person), and when every check
// RECHECKS maps to the halt's kind passes, writes a `resume` row by the driver, `via: "recheck"`, naming the checks.
// One re-check a halt row: a check that fails writes a `recheck` row, and the halt stays for a person. A halt of the
// same kind on the same issue after a self-lift stays for a person too, so a cause the preflight cannot see never
// starts the issue over and over. Any other halt, such as a usage limit's or a failed sandbox proof's, stays for a
// person as before.

import { appendToRun, latestHalt } from './project-run.mjs';

// The preflight checks whose pass shows each kind of halt cleared: an environment result names its session's
// sandbox, forge sign-in, push, or forge reads; a failed proof, the host's start and hooks, its trust, and its access.
export const RECHECKS = Object.freeze({
  environment: Object.freeze(['commit', 'host', 'trust', 'access', 'token-reads']),
  proof: Object.freeze(['host', 'trust', 'access']),
});

// The checks of `kind` the preflight answer `lines` ran: { passed, failed }, `passed` the names of its `ok` lines and
// `failed` its blocker lines. A check the preflight did not run on this host, such as a trust it cannot read, is neither.
export function recheckVerdict(kind, lines) {
  const names = RECHECKS[kind] ?? [];
  const passed = names.filter((name) => lines.includes(`ok ${name}`));
  const failed = lines.filter((line) => names.some((name) => line.startsWith(`blocker ${name}:`)));
  return { passed, failed };
}

// Whether the run `found` self-lifted a halt of `kind` on issue `key` before row `index`.
const liftedBefore = (found, { kind, key, index }) => found.rows.slice(0, index).some((row) => row.event === 'resume' && row.via === 'recheck' && row.kind === kind && row.key === key);
// Whether the halt row at `index` was re-checked already: a `recheck` row, or a self-lift, after it.
const checkedAfter = (found, index) => found.rows.slice(index + 1).some((row) => row.event === 'recheck' || (row.event === 'resume' && row.via === 'recheck'));

// Re-checks the halt of run `run` in `state`, as `found` (readRun) holds it, for the driver `session`, with `recheck()`
// the preflight's answer for the run ({ out }): { lifted, lines }, `lines` the lines to print. It lifts only when no
// check RECHECKS maps to the halt's kind is a blocker and at least one passed. Nothing happens for a run that is not
// halted, a halt of another kind, one re-checked already, or without `recheck`; a second halt of its kind on its issue
// after a self-lift is kept with no preflight. Either way its row goes in under the ledger's lock, only while that halt
// still stands, so each halt row is re-checked once and its lines printed once.
export function recheckHalt({ state, run, found, session, recheck, now = Date.now() }) {
  const halt = latestHalt(found);
  if (!halt || typeof recheck !== 'function' || !RECHECKS[halt.kind] || checkedAfter(found, halt.index)) return { lifted: false, lines: [] };
  const at = new Date(now).toISOString();
  const base = { session, kind: halt.kind, key: halt.key, attempt: halt.attempt };
  const kept = [`recheck kept the halt: ${halt.cause}`];
  let row;
  let lines;
  if (liftedBefore(found, halt)) {
    row = { event: 'recheck', ...base, pass: false, why: 'lifted once', at };
    lines = [...kept, `the run lifted a halt of ${halt.key} of this kind (${halt.kind}) by itself once, so this one waits on a person`];
  } else {
    let answer = null;
    // Why the re-check keeps the halt, from the preflight's own lines, or none when it lifts it.
    let why = [];
    try {
      answer = recheck();
    } catch (error) {
      why = [`the preflight failed (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`];
    }
    const { passed, failed } = recheckVerdict(halt.kind, Array.isArray(answer?.out) ? answer.out : []);
    if (!why.length) why = failed;
    if (!why.length && !passed.length) why = ['no check of this halt ran'];
    row = why.length ? { event: 'recheck', ...base, pass: false, checks: passed, failed: why.slice(0, 10).map((line) => line.slice(0, 300)), at }
      : { event: 'resume', ...base, via: 'recheck', checks: passed, at };
    lines = why.length ? [...kept, ...why] : [`recheck lifted the halt: ${halt.cause}; ok ${passed.join(', ')}`];
  }
  let written = null;
  try {
    written = appendToRun(state, run, (fresh) => {
      const still = latestHalt(fresh);
      return still && still.index === halt.index && !checkedAfter(fresh, halt.index) ? { rows: [row] } : { rows: [] };
    });
  } catch {
    written = null;
  }
  if (!written || written.problem || !written.rows?.length) return { lifted: false, lines: [] };
  return { lifted: row.event === 'resume', lines };
}
