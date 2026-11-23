# Existing work

Read when `start` parks an issue as unreconciled, or says that work is left, replaced, or started again.

A run never discards or rebuilds existing work unless the Human asks for it in words.

- On `parked <key> unreconciled` from start, exit 0: nothing started.
  Never delete, rename, reset, or close anything to make it start.
  Keep the line for the final report, and take the next issue.
- On any start output that says a branch, a pull request, or an attempt's work is left, replaced, closed, cut fresh, or
  started again from the base: start nothing more, follow the loop's § Stop, and raise the line to the Human.
