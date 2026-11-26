// The driver's re-check of a halt whose cause the preflight can check again (docs/config.md#project-run): when the
// driver's `aidrian project start` of the halted issue meets a run halted by that issue's environment result or a start
// of it whose proof failed, it runs the preflight's checks of that cause for that run (lib/project-preflight.mjs
// recheckLines, the same checks, on the repository the run pinned, with no person), and when they all pass, writes a
// `resume` row by the driver, `via: "recheck"`, naming the checks, and that start launches nothing: the next one starts
// the issue afresh. An environment result's checks are those of the `cause` its session named (CAUSE_CHECKS), never read
// from its `stop` text: a cause no check covers, or none recorded, as on a row an older plugin wrote, keeps the halt for a
// person with no probe. A re-check that does not pass, for whatever reason,
// writes nothing: the halt stays, and the driver's Halt steps end the run for a person. A halt of the same kind on the
// same issue after a self-lift stays for a person with no re-check, so a cause the preflight cannot see never starts the
// issue over and over. Any other halt, such as a usage limit's or a failed sandbox proof's, stays for a person as before.

import { LOCKED } from './jsonl.mjs';
import { appendToRun, latestHalt } from './project-run.mjs';
import { driverOf } from './project-run-guard.mjs';
import { endedIn } from './run-driver.mjs';

// The preflight checks that show a failed proof cleared: the host's start and hooks, its trust, and its access. An
// environment result's are those of its cause (CAUSE_CHECKS). The repository check, that origin still names the run's
// repository, runs first for both, and the state folder and the team's policy the others need.
export const RECHECKS = Object.freeze({
  proof: Object.freeze(['host', 'trust', 'access']),
});

// The causes an environment result names (project-result.mjs validateResult), each with the preflight checks that can see
// it cleared: `commit` the commit check; `host`, a host or host tool that will not run, the host's start and its trust;
// `sign_in`, `push`, and `network`, the forge token's access; `sandbox_refused`, a path, port, or domain the sandbox
// refused, and `other`, none, so their halt waits on a person. The table is rule 5 of issue 745's security contract.
// Accepted residual: a covered cause's checks are the driver's, so a host tool, push, or network path that fails only
// inside the issue session can pass them. That costs one more attempt at most, since the one-self-lift backstop
// (liftedBefore) then keeps the halt for a person.
export const CAUSE_CHECKS = Object.freeze({
  commit: Object.freeze(['commit']),
  host: Object.freeze(['host', 'trust']),
  sign_in: Object.freeze(['access']),
  push: Object.freeze(['access']),
  network: Object.freeze(['access']),
  sandbox_refused: Object.freeze([]),
  other: Object.freeze([]),
});
export const ENVIRONMENT_CAUSES = Object.freeze(Object.keys(CAUSE_CHECKS));

// The one line that answers the trust check of a host that keeps no record of trusted folders, as Codex
// (project-preflight.mjs recheckLines): a re-check matches it whole. A `note trust:` line, such as a trust record that
// cannot be read or parsed, answers nothing, so its halt stays.
export const NO_TRUST_RECORD = 'none trust: this host keeps no record of trusted folders';

// The checks of halt `halt` (project-run.mjs latestHalt): for an environment halt its cause's, empty for a cause off the
// list or none recorded; else its kind's, or null for a kind no re-check covers.
const checksOf = (halt) => {
  if (halt.kind === 'environment') return Object.hasOwn(CAUSE_CHECKS, halt.class) ? CAUSE_CHECKS[halt.class] : [];
  return Object.hasOwn(RECHECKS, halt.kind) ? RECHECKS[halt.kind] : null;
};
// The class an uncovered environment halt's line names.
const classOf = (halt) => {
  if (halt.class === null) return 'none recorded';
  return Object.hasOwn(CAUSE_CHECKS, halt.class) ? halt.class : 'not a known cause';
};

// Why the checks `names` a halt selects did not all answer in the re-check's `lines`, with `passed` the checks that
// answered `ok`: none when each did, or for trust NO_TRUST_RECORD exactly. The repository, state, and policy lines
// alone, a check the host cannot run, such as access with no project-start capability, and a check that answered only
// with a note, such as a trust record that cannot be read, never lift a halt; its notes say why.
function unansweredLines(names, lines, passed) {
  const unanswered = names.filter((name) => !passed.includes(name) && !(name === 'trust' && lines.includes(NO_TRUST_RECORD)));
  if (!unanswered.length) return [];
  return [`the checks of this halt that did not run or answer ok: ${unanswered.join(', ')}`, ...lines.filter((line) => unanswered.some((name) => line.startsWith(`note ${name}: `)))];
}

// Whether the run `found` self-lifted a halt of `kind` on issue `key` before row `index`.
const liftedBefore = (found, { kind, key, index }) => found.rows.slice(0, index).some((row) => row.event === 'resume' && row.via === 'recheck' && row.kind === kind && row.key === key);

// Re-checks the halt of run `run` in `state`, as `found` (readRun) holds it, for the driver `session` starting issue
// `key`, whose custody rests with `custodian` (the run's driver, or the driver a successor takes over from), with
// `recheck({ repository, names })` the re-check's lines for the run's pinned repository: { lifted, lines }, `lines` the
// lines to print. It lifts only when every line is `ok` or a `note`, and every check the halt selects answered `ok`, or for trust NO_TRUST_RECORD. Nothing happens for a
// run that is not halted, a halt of another kind or of another issue than `key`, or without `recheck`; an environment
// halt whose cause maps to no check, or names none, and a second halt of its kind on its issue after a self-lift, are
// kept with no probe. The `resume` row goes in under the ledger's lock,
// only while that halt still stands, the run has not ended, and custody still rests with `custodian`, so a halt lifts once;
// a run that changed so meanwhile gets a line saying so, and a write that fails, its own line. A ledger another process
// holds throws LOCKED, which the command answers with exit 75, to be tried again.
export function recheckHalt({ state, run, found, session, key, custodian = session, recheck, now = Date.now() }) {
  const halt = latestHalt(found);
  const names = halt ? checksOf(halt) : null;
  if (!names || typeof recheck !== 'function' || halt.key !== key) return { lifted: false, lines: [] };
  const kept = `recheck kept the halt: ${halt.cause}`;
  if (!names.length) return { lifted: false, lines: [kept, `no check covers this cause (${classOf(halt)}): a person fixes it, then lifts the halt with \`aidrian project resume ${run}\` from a session they attend`] };
  if (liftedBefore(found, halt)) return { lifted: false, lines: [kept, `the run lifted a halt of ${halt.key} of this kind (${halt.kind}) by itself once, so this one waits on a person`] };
  let lines;
  try {
    const answer = recheck({ repository: found.init.repository, names });
    lines = Array.isArray(answer) ? answer : [];
  } catch (error) {
    lines = [`blocker recheck: the re-check failed (${String(error?.message ?? error).split('\n')[0].slice(0, 200)})`];
  }
  const passed = lines.filter((line) => /^ok \S+$/u.test(line)).map((line) => line.slice(3));
  const failed = lines.filter((line) => !line.startsWith('ok ') && !line.startsWith('note ') && line !== NO_TRUST_RECORD);
  if (failed.length) return { lifted: false, lines: [kept, ...failed] };
  const unanswered = unansweredLines(names, lines, passed);
  if (unanswered.length) return { lifted: false, lines: [kept, ...unanswered] };
  const row = { event: 'resume', session, kind: halt.kind, key: halt.key, attempt: halt.attempt, via: 'recheck', checks: passed, ...(halt.kind === 'environment' ? { cause: halt.class } : {}), at: new Date(now).toISOString() };
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
  return { lifted: true, lines: [`recheck lifted the halt: ${halt.cause}; ok ${passed.join(', ')}`, `lifted the ${halt.kind} halt of ${halt.key}; run \`next\` again`] };
}
