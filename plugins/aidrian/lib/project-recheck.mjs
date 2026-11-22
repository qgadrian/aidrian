// The driver's re-check of a halt whose cause the preflight can check again (docs/config.md#project-run): when the
// driver's `aidrian project start` of the halted issue meets a run halted by that issue's environment result or a start
// of it whose proof failed, it runs the preflight's checks of that cause for that run (lib/project-preflight.mjs
// recheckLines, the same checks, on the repository the run pinned, with no person), and when they all pass, writes a
// `resume` row by the driver, `via: "recheck"`, naming the checks. A re-check that does not pass, for whatever reason,
// writes nothing: the halt stays, and the driver's Halt steps end the run for a person. A halt of the same kind on the
// same issue after a self-lift stays for a person with no re-check, so a cause the preflight cannot see never starts the
// issue over and over. Any other halt, such as a usage limit's or a failed sandbox proof's, stays for a person as before.

import { LOCKED } from './jsonl.mjs';
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

// Whether the run `found` self-lifted a halt of `kind` on issue `key` before row `index`.
const liftedBefore = (found, { kind, key, index }) => found.rows.slice(0, index).some((row) => row.event === 'resume' && row.via === 'recheck' && row.kind === kind && row.key === key);

// Re-checks the halt of run `run` in `state`, as `found` (readRun) holds it, for the driver `session` starting issue
// `key`, whose custody rests with `custodian` (the run's driver, or the driver a successor takes over from), with
// `recheck({ repository, names })` the re-check's lines for the run's pinned repository: { lifted, lines }, `lines` the
// lines to print. It lifts only when every line is `ok` or a `note`, and at least one is `ok`. Nothing happens for a
// run that is not halted, a halt of another kind or of another issue than `key`, or without `recheck`; a second halt
// of its kind on its issue after a self-lift is kept with no probe. The `resume` row goes in under the ledger's lock,
// only while that halt still stands, the run has not ended, and custody still rests with `custodian`, so a halt lifts once;
// a run that changed so meanwhile gets a line saying so, and a write that fails, its own line. A ledger another process
// holds throws LOCKED, which the command answers with exit 75, to be tried again.
export function recheckHalt({ state, run, found, session, key, custodian = session, recheck, now = Date.now() }) {
  const halt = latestHalt(found);
  if (!halt || typeof recheck !== 'function' || !RECHECKS[halt.kind] || halt.key !== key) return { lifted: false, lines: [] };
  const kept = `recheck kept the halt: ${halt.cause}`;
  if (liftedBefore(found, halt)) return { lifted: false, lines: [kept, `the run lifted a halt of ${halt.key} of this kind (${halt.kind}) by itself once, so this one waits on a person`] };
  let lines;
  try {
    const answer = recheck({ repository: found.init.repository, names: RECHECKS[halt.kind] });
    lines = Array.isArray(answer) ? answer : [];
  } catch (error) {
    lines = [`blocker recheck: the re-check failed (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`];
  }
  const passed = lines.filter((line) => /^ok \S+$/u.test(line)).map((line) => line.slice(3));
  const failed = lines.filter((line) => !line.startsWith('ok ') && !line.startsWith('note '));
  if (failed.length || !passed.length) return { lifted: false, lines: [kept, ...(failed.length ? failed : ['no check of this halt ran'])] };
  const row = { event: 'resume', session, kind: halt.kind, key: halt.key, attempt: halt.attempt, via: 'recheck', checks: passed, at: new Date(now).toISOString() };
  const unwritten = (why) => ({ lifted: false, lines: [kept, `the checks passed, but the resume row could not be written: ${String(why).split('\n')[0].slice(0, 200)}`] });
  let written;
  try {
    written = appendToRun(state, run, (fresh) => {
      const still = latestHalt(fresh);
      const live = !endedIn(fresh) && driverOf(fresh).session === custodian;
      return live && still && still.index === halt.index ? { rows: [row] } : { rows: [] };
    });
  } catch (error) {
    if (error?.code === LOCKED) throw error;
    return unwritten(error?.message ?? error);
  }
  if (written?.problem) return unwritten(written.problem);
  if (!written?.rows?.length) return { lifted: false, lines: ['the checks passed, but the run changed meanwhile: its halt was lifted, it ended, or custody moved'] };
  return { lifted: true, lines: [`recheck lifted the halt: ${halt.cause}; ok ${passed.join(', ')}`] };
}
