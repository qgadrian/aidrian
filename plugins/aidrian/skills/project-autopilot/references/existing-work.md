# Existing work

Read when `start` parks an issue as unreconciled, prints an `offered` or `not taken` line, or says that work is left,
replaced, or started again.

A run never discards or rebuilds existing work unless the Human asks for it in words.

- On `parked <key> unreconciled` from start, exit 0: nothing started.
  Never delete, rename, reset, or close anything to make it start.
  Keep the line for the final report, and take the next issue.
- A resumed issue whose pull request conflicts with its moved base needs nothing from the driver: its session merges
  `origin/<base>` in with a merge commit, never a rebase or a force push, and goes on to review.
  Three stops come back, each as a `pr_open` result: a host config or instruction file that would conflict, and a merge
  git refuses over one, each naming the file, and a branch whose head no longer holds the forge's, naming the divergence.
- `offered <key> attempt <n>: ...` and `not taken <key> attempt <n>: <why>` are notes beside `started`, never a stop:
  the session may take the unpushed commits an attempt a usage limit ended left, or works without them, and that
  attempt's folder stays as it was. A `kept <key> attempt <n>: ...` line there is the sweep's, as from `wait`: a
  note too. Keep a `not taken` line for the final report, for a person to recover the work; never touch the folder
  or its commits.
- On any other start output that says a branch, a pull request, or an attempt's work is left, replaced, closed, cut fresh, or
  started again from the base: start nothing more, follow the loop's § Stop, and raise the line to the Human.
