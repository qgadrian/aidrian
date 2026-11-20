// A time budget for work a hook may cut short. scripts/hook-agent-gates.mjs runs its guards under one, as they resolve the
// paths, globs, and links a command gives, and scripts/hook-tracker-pre.mjs its project run rule, so a call that would
// hold them past the host's hook timeout, where the host runs the call with no guard, is answered in time instead. The
// guards check it in their loops and before their slow reads (checkDeadline); outside a budget, as in every other hook
// and command, the check does nothing.

// The milliseconds from a hook's start its guards may take, well inside the host's 5 second hook timeout, past which the
// host runs the call with no guard: GUARD_BUDGET_MS, or AIDRIAN_GUARD_BUDGET_MS in `env` when it is lower, as a test
// sets it. The variable may only lower it.
export const GUARD_BUDGET_MS = 2500;
export function guardBudget(env = process.env) {
  const lowered = env.AIDRIAN_GUARD_BUDGET_MS ? Number(env.AIDRIAN_GUARD_BUDGET_MS) : Number.NaN;
  return Number.isFinite(lowered) && lowered >= 0 ? Math.min(lowered, GUARD_BUDGET_MS) : GUARD_BUDGET_MS;
}

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
