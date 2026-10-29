# Hard rules

Read at the start of the run. These hold in every step.

## Stop at once

Report the blocker as **stop**, or **stop and ask** when the Human can settle it.

- The acceptance criteria are silent, vague, or contradictory on a behaviour the code would have to invent.
- `product-manager` returns `blocked` with `decision_options`: relay them to the Human, attributed.
- A slice would set an architecture precedent for other areas: `architect` first, then the Human.
- A slice widens privileged access or changes a shared wrapper the project's knowledge protects: the Human authorizes it first.
- A phase 0 guard fails: a closed, foreign-assigned, or blocked issue, or an unmerged merge dependency.
- A `scope_collision`: a directive contradicts the issue's non-goals or leaves its files to modify.
- A test still fails after two fix-and-rerun cycles. One retry of a flaky end-to-end test comes first.
- A third review round still has an open critical or high finding.
- The current branch belongs to another issue, or holds uncommitted changes unrelated to this one.
- The local and remote target branch have diverged: neither is a fast-forward of the other.
- A hook fails for a reason outside the slice.
- Repository, Linear, GitHub, or agent access is missing, or a load-bearing linked document cannot be read.
- Two agents dispute a finding. Escalate with both positions and the missing evidence.
- Files outside the slice are dirty after a dispatch, or the commit-count guard trips.
- `git push` is rejected for any reason.
- An open pull request for the branch exists and the Human has not chosen between updating it and starting over.
- Linear or GitHub fails three calls in a row with a rate limit or a server error.

## Decide and move on

Note each in the report under decided alone.

- Choosing between two equivalent names, the file a small helper lives in, or a test file path.
- Creating the task worktree, or using an existing clean one at the branch tip.
- Reusing a fresh plan instead of planning again.
- Retrying a flaky end-to-end test once.
- Demoting a finding that fails self-verification.

## Every step

- **Linear stays read-only.** The exceptions are the In Progress move in phase 1 and the two estimate writes in phase 7.
  No other field, comment, label, attachment, assignment, or state change, ever. Never close the issue.
- **No merge.** The run ends at a draft. A merge happens only when the Human asks for it, through the `pr-merge-when-green` skill.
- **No hook bypass**: no `--no-verify`, `HUSKY=0`, or empty `core.hooksPath`. A failing hook is fixed at its cause, or the run stops.
- **No invention.** Never make up an acceptance criterion id, a path, a function, a label, or issue context.
- **No silent product or architecture call.** Stop and ask once, with every open question together.
- **One slice, one commit.** Never batch slices into one commit, and never push a slice without its verification.
- **Run every task command in the worktree**, with `git -C <worktree>`, or check `git rev-parse --show-toplevel` first.
  A shell that drifted back to the main checkout gives a clean, meaningless result.
- **Check each claim.** After a dispatch, confirm with git that the claimed files changed. Never report a result no handoff or command shows.
- **Keep internal data out of web searches**: no issue text, code, or tool output.
