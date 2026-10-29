# Verify each criterion

## Owner by surface

Take the owner from the agent registry in the project's `orchestration` knowledge first, by the `knowledge` skill's rule;
these are the fallbacks.

- **Static or structural**, such as a function with a given signature, a type with a field, or a file that exists: `explorer`.
- **Behaviour at run time**: `e2e-runner` when the flow has end-to-end tests. Otherwise the code's owner, such as `backend-developer`,
  proves it with the targeted test command the project's `testing` knowledge names.
- **Code pattern**, such as reusing a helper, not adding a privileged client, or using the project's error reporter: `code-reviewer`.
- **Product meaning**, such as matching the documented lifecycle or keeping user-facing copy: `product-manager` reads it,
  and `explorer` brings the static evidence.
- **Security**, such as a trust boundary kept or data-access rules still applied: `security-engineer`.
- **Data**, such as what stored records or a customer's state show: the data-investigation agent the project's `support` knowledge names.
  When it names none, the verdict is `needs_evidence`, with the query that would settle it.

## Dispatch

- One dispatch per owner, carrying all of that owner's criteria, never one per criterion.
- At most four agents at once; the rest start when a batch returns. `e2e-runner` runs in the foreground, alone.
- A test run needs the ref checked out: the task worktree for `worktree` and `pr` when it is at that commit,
  or else a detached worktree, `git worktree add --detach <path> <sha>`, removed afterwards.

The brief, with nothing else from the issue or this conversation:

```text
Verify these acceptance criteria of <key> as <agent>. Follow the `knowledge` skill first. Change no file.
Code: <sha>. Read a file with `git show <sha>:<path>`, never from the working tree.
<id>: <criterion text>
Files the issue names: <paths>
Return the machine handoff from the `knowledge` skill with `criteria`: one object per id with
ac_id; verdict: met, not_met, partial, needs_evidence, untestable_without_runtime, or ambiguous;
evidence_anchor: path:lines at <sha>, or a command and its result, or why there is none; notes: one line;
and regression_risk_if_marked when the verdict is met on a critical flow.
```

For the `worktree` ref, the code line names the working tree's path instead of a commit.

## When an agent returns

- A `met` without an anchor goes back once for one. A second miss makes it `needs_evidence`.
- Check every `met` before it can be ticked: the path exists at the ref (`git cat-file -e <sha>:<path>`),
  and the cited lines show the claimed behaviour. A failed check makes it `needs_evidence`.
- Two agents with different verdicts on one criterion: it is disputed, and goes to the Human with both positions.
- `needs_input` or `blocked` goes to the Human as it is.

## Remediation plan

Open with one short paragraph on what is missing. Then one entry per criterion that is not `met`:

1. **Owner**: the issue's agent action plan when it fits the surface, else the owner by surface above.
2. **Files**: the issue's files to modify or create when the criterion maps to one, else the file the evidence names.
3. **Slice**: one sentence on the change.
4. **Size**: `S`, `M`, or `L`, as the project's `issue_tracker` knowledge sizes issues.
5. **Verification**: the shortest set of commands that would turn the verdict into `met` on a rerun.

- An `ambiguous` criterion: owner `agent-issue-writer`, slice "rewrite the criterion without vague wording".
- A `needs_evidence` criterion: owner is the agent that can produce the anchor, such as `explorer`, `e2e-runner`, or the data agent;
  the slice is "produce the evidence", not an implementation.
