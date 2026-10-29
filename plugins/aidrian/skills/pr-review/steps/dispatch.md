# Dispatch

Read this file before the first dispatch.

## Order

1. `product-manager` first and alone, when a gate in step 5 calls it. Its `sign_off` per critical flow comes back before anyone else starts.
2. Then `security-engineer`, when its gate fires, with the other agents of the plan: at most four at the same time.
   A retry counts toward the four.
3. An agent that needs facts it cannot read in its files may get one `explorer` pass per finding, never more.

## The brief

Each agent gets its own files and what it needs to read them. Never paste the whole diff.

```text
Review pull request #<n>, "<title>", as <agent>.
Follow the `knowledge` skill first, and load only the docs this review needs.

Base: <base_sha>
Head: <head_sha>. It is pinned: read every file at this commit, never in the working tree.
Your files and their status:
<path>  <added | modified | renamed | removed>

Read a file with `git show <head_sha>:<path>`, its old version with `git show <base_sha>:<path>`,
and its change with `git diff <base_sha> <head_sha> -- <path>`.

<the regression check below>

<the weighing paragraph below>

Return the machine handoff from the `knowledge` skill, with `findings`: one object per finding with
severity, likelihood, affects, cost, file, line, summary, and next_step. Use [] when you found nothing.
For each modified, renamed, or removed file with no finding, add one `evidence` item:
"regression_check: clean, <path> compared at <base_sha, 7> and <head_sha, 7>".
```

Add to it when it applies:

- An agent without a shell, such as `product-manager`, cannot run `git`: paste the diff of its files into the brief instead.
- `product-manager` under the critical-flow gate: ask for `critical_flow`, one entry per flow, each with its `sign_off`.
- A re-review: list the agent's `fix_now` findings whose status is `open` or `fixed` (id, file and line, summary), and ask each one's state:
  "resolved", citing the change, or "open".

## The regression check

Put this in every brief:

```text
For each modified or renamed file, compare the old version with the new one. Check error propagation, guard clauses and early returns,
the scope of error handling, side effects, default values, and the return shape, including null results and thrown errors.
For each removed file, find every remaining caller of what it exported.
For a new caller of a shared helper the change did not touch, read the helper against the new input: bugs hide at that seam.
For a file that code or tests read at run time, such as a prompt, a locale file, or a config file, run the tests that read it.
Treat these as high until shown otherwise: a wider catch on a main path, a removed guard, a new default in place of a skip or an error,
and a removed export that something still uses.
```

## The weighing paragraph

Put this in every brief, unchanged:

```text
Spend your time on what users and operators hit in normal use.
Do not construct rare combinations of conditions to break the change. When you notice one, report it as contrived and move on.
Report every finding you see, with its axes:
- severity: critical (harm no one can undo), high (breaks a main flow), medium (degrades a flow), low (polish)
- likelihood: routine (normal use), plausible (one realistic condition), contrived (a coincidence of rare conditions)
- affects: users, operators, revenue, or internal (only developers and tooling see it)
- cost: trivial, bounded, or structural (a migration, a contract change, or a redesign); leave it out when bounded
The review turns the axes into a verdict, so a contrived finding becomes an accepted residual, not a fix.
```

## When an agent returns

- "No regressions" without a finding or a clean line for each of its files is incomplete. Send the brief back once, naming what is missing.
  A second miss is a coverage gap: report it.
- A finding without `likelihood` or `affects` goes back to its agent once. Never fill in an axis yourself.
- `needs_input` or `blocked` goes to the user as it is; it is not a finished review.
