// Runs a regular expression a project wrote under a time limit, so a slow one cannot use up a hook's time. Each search runs
// in a node:vm context, the one way to stop a regular expression from outside with only Node's built-ins.

import vm from 'node:vm';

let search;
let context;

// A time budget for several searches: a function that gives the milliseconds the next search may take, at most `sliceMs`,
// so one slow search leaves time for the others. Zero or less means the budget is spent.
export function timeBudget(totalMs, sliceMs) {
  const deadline = performance.now() + totalMs;
  return () => Math.min(sliceMs, Math.ceil(deadline - performance.now()));
}

// The index of the first match of `source` in `text`, -1 for none, or null when the search was dropped: it ran out of
// time, the budget was spent, or the expression does not compile.
export function boundedSearch(source, flags, text, budget) {
  const timeout = budget();
  if (timeout <= 0) return null;
  search ??= new vm.Script('new RegExp(source, flags).exec(text)?.index ?? -1');
  context ??= vm.createContext({});
  Object.assign(context, { source, flags, text });
  try {
    return search.runInContext(context, { timeout });
  } catch {
    return null;
  }
}
