// A time budget for work a hook may cut short. scripts/hook-agent-gates.mjs runs its guards under one, as they resolve the
// paths, globs, and links a command gives, and scripts/hook-tracker-pre.mjs its project run rule, so a call that would
// hold them past the host's hook timeout, where the host runs the call with no guard, is answered in time instead. The
// guards check it in their loops and before their slow reads (checkDeadline); outside a budget, as in every other hook
// and command, the check does nothing.

// The milliseconds from a hook's start its guards may take, at least 2.5 seconds inside the 10 second timeout hooks.json
// gives each hook that runs under it, past which the host runs the call with no guard: GUARD_BUDGET_MS for a call that
// runs past it, an attended main session's, and HELD_BUDGET_MS for a `held` call, which past it is refused: a
// subagent's, or a session's an unattended or driver mark holds. AIDRIAN_GUARD_BUDGET_MS in `env` gives a lower budget
// for both, as a test sets it; the variable may only lower them.
// The guards read a call in about 100 ms on a quiet machine. A loaded one, with several sessions and test suites at
// once, held small Edits and Writes past 2.5 seconds, and each refusal cost a held session a retry or its work: for a
// call a refusal would stop, a slower answer costs less. An attended session's call runs at the budget's end anyway,
// so it waits no longer.
export const GUARD_BUDGET_MS = 2500;
export const HELD_BUDGET_MS = 7500;
export function guardBudget(env = process.env, { held = false } = {}) {
  const own = held ? HELD_BUDGET_MS : GUARD_BUDGET_MS;
  const lowered = env.AIDRIAN_GUARD_BUDGET_MS ? Number(env.AIDRIAN_GUARD_BUDGET_MS) : Number.NaN;
  return Number.isFinite(lowered) && lowered >= 0 ? Math.min(lowered, own) : own;
}

// The causes, the `match` of hook-deny.mjs recordBlock, of a refusal because a time budget ran out: the guards'
// (config-guard.mjs deadlineDenial) and the project run rule's (scripts/hook-tracker-pre.mjs). Such a refusal says the
// machine was too loaded to judge the call in time, and its message gives the retry steps, so it never counts toward the
// automatic lesson for a rule an agent keeps fighting (lesson-signals.mjs noteDenial), nor reads as one in the report
// (report-agents.mjs summarizeDenies); the report still counts it by reason.
export const GUARDS_PAST_BUDGET = 'past the guards\' time budget';
export const RUN_RULE_PAST_BUDGET = 'the project run rule ran out of time';
export const BUDGET_CAUSES = new Set([GUARDS_PAST_BUDGET, RUN_RULE_PAST_BUDGET]);

// What checkDeadline throws once the budget is spent.
export class PastDeadline extends Error {}

let deadline = Infinity;

// `body()`, run with checkDeadline throwing PastDeadline once performance.now(), the milliseconds since the process
// started, passes `at`. The budget ends with the body, whatever it returns or throws.
export function withinDeadline(at, body) {
  const before = deadline;
  deadline = at;
  try {
    return body();
  } finally {
    deadline = before;
  }
}

// Throws PastDeadline when the running budget is spent.
export function checkDeadline() {
  if (performance.now() > deadline) throw new PastDeadline('the guards ran out of time');
}

// The milliseconds left in the running budget, or Infinity outside one: a guard that runs a slow read, such as git,
// passes it on as that read's timeout, so the read ends in time for the deadline's refusal instead of past the host's.
export const remainingMs = () => deadline - performance.now();
