# Existing work

Read when `start` parks an issue as unreconciled, or says that work is left, replaced, or started again.

A run never discards or rebuilds existing work unless the Human asks for it in words.

- On `parked <key> unreconciled` from start, exit 0: nothing started.
  Never delete, rename, reset, or close anything to make it start.
  Keep the line for the final report, and take the next issue.
- A resumed issue whose pull request conflicts with its moved base needs nothing from the driver: its session merges
  `origin/<base>` in with a merge commit, never a rebase or a force push, and goes on to review.
  Two stops come back, each as a `pr_open` result whose stop names the file: a host config or instruction file that
  would conflict, and a merge git refuses over one.
- On any start output that says a branch, a pull request, or an attempt's work is left, replaced, closed, cut fresh, or
  started again from the base: start nothing more, follow the loop's § Stop, and raise the line to the Human.
