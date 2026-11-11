# Briefs

What a brief from the `orchestrator` holds beyond its slice, and how to correct one an agent is working on.
Read it before the first brief that changes behaviour, before you retract or replace a brief, and before several
pull requests land on the default branch.

## A decision on record

Before a brief changes behaviour, look for a decision that already settles that behaviour:

- `aidrian decisions list`, for the decisions on record in the project's knowledge docs;
- the Decisions locked of the plan, the issue, and any handoff brief, and the project's decision records.

When one settles it, the brief keeps it. Changing it is a new decision: ask the Human as a yes or no question that names
the decision and what the brief would change, and send no brief against it before the answer.

## Retracting or replacing a brief

A running agent may act on a brief before a retraction reaches it.

1. Stop the agent, or send it a message that asks what it has done, and wait for its answer.
2. Read what it changed in its worktree: `git -C <worktree> status --porcelain`, `git -C <worktree> log --oneline <base>..HEAD`,
   and `git ls-remote --heads origin <branch>` for a push.
3. Brief the correction from that state, naming each change to undo or keep.

Never send a retraction and go on as if it landed.

## Pushes and logs

Every brief to an agent that pushes says:

- Push only after the verification passed, chained with `&&`: `<test command> && git push`.
  Never `;`, a new line, or a script that pushes whatever the run returned.
- Write logs and other scratch output to `<state>/tmp/<issue or slice>/`, a folder named for this agent's issue or slice,
  where `<state>` is the folder `aidrian state` prints. Never a shared name, such as `scratchpad/test.log`:
  another agent may overwrite it. Report numbers only from a log this agent wrote in this run.

## Several pull requests onto the default branch

Land them one at a time, in the locked order:

1. Tell the next owner: "merge `<default branch>` now, nothing else lands first." No other owner merges the default branch
   into its branch, and no other pull request lands, until this one has landed.
2. Wait for its checks and its merge, by § 3 step 8 or by the Human, then go on to the next.

CI does not start on a head that conflicts with its base, so a run that never starts looks like a slow one.
When `aidrian pr checks <n>` stays pending and no run started, read `gh pr view <n> --json mergeable,mergeStateStatus`:
`CONFLICTING` goes back to the owner.
