---
name: session-continue
description: Resume work in a fresh session from a session-handoff brief. Read it, enter the task worktree, check the state, and continue. Use first after a handoff.
---

# session-continue

Resume the work a handoff brief describes. The `session-handoff` skill writes the brief; this skill reads it.

## Find the brief

The briefs are in `<state>/handoffs/`, where `<state>` is the folder `aidrian state` prints. The argument is optional:

1. None: the newest brief, by the date in its name.
2. A path ending in `.md`: that brief.
3. Anything else: the newest brief whose name contains it.

When nothing matches, stop. List the briefs in the folder when there are any; otherwise say no brief was found.
When several match, take the newest and say which one you picked.

## Steps

1. **Read the brief in full** before anything else. It is the contract: objective, locked decisions, done,
   next steps, gotchas.
2. **Enter the worktree** named in Current state.
   - Check it is listed in `git worktree list --porcelain`, then `cd` into it.
   - If it is gone, stop, say so, and offer to create it again for the brief's branch with the `worktree-new` skill. Never fall back to the main checkout.
   - A brief that names no worktree means the work happens where you are.
3. **Read the state fresh.** The brief holds no snapshots on purpose:

   ```bash
   git branch --show-current     # must be the brief's branch
   git status --porcelain        # changes in progress to account for
   git log --oneline -3          # new commits beyond Done
   gh pr view --json number,url,state && gh pr checks   # only when the brief names a pull request
   ```

   When the brief says an agent was still running, check whether it still is before you start the same work again.
   Report anything surprising in two to five lines before you go on: commits beyond Done, unexplained changes,
   a pull request that merged or closed. Surprises do not stop you; ignoring them does.
   Rerun a verification command from the brief before you rely on its outcome.
4. **Continue at Next steps, step 1.** Keep the Decisions locked, and read the Key paths before you edit them.

## Rules

1. Read before acting: no edit, commit, or hand-off until the brief is read in full.
2. Never edit or delete a brief; the `session-handoff` skill refreshes it.
3. Never work in the main checkout when the brief names a worktree.
4. Echo no secrets.
5. A usage-limit warning right after resuming is about the account, not this session's context, and a fresh session
   does not help. Finish the cheapest current step, report the state against the brief, and say this session continues
   at Next steps once the limit resets. The brief stays current; write no new one.
