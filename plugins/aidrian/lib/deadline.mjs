// A time budget for work a hook may cut short. scripts/hook-agent-gates.mjs runs its guards under one, as they resolve the
// paths, globs, and links a command gives, so a command that would hold them past the host's hook timeout, where the host
// runs the call with no guard, is answered in time instead. The guards check it in their loops (checkDeadline); outside
// a budget, as in every other hook and command, the check does nothing.

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

// The milliseconds left of the running budget, Infinity outside one: for a read that takes its own limit, such as git's.
export const remainingMs = () => deadline - performance.now();
