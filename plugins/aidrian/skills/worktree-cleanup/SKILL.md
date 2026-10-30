---
name: worktree-cleanup
description: Remove task worktrees whose work has merged with `aidrian worktree cleanup`, asking before each one it cannot prove done. Supports --force and --dry-run.
---

# worktree-cleanup

A thin adapter for `aidrian worktree cleanup`. Never remove a worktree or a branch with your own git commands.

1. Plan, from anywhere in the repository:

   ```bash
   aidrian worktree cleanup plan [--min-age <duration>]
   ```

   Add `--min-age` only when the user asked to reach worktrees younger than the default `24h`.
   It takes seconds (`3600`) or one unit (`30m`, `2h`, `1d`); `0` turns the age check off.
2. Report the plan:
   - `auto`: removed without asking. Only a worktree whose HEAD is a merged pull request's head, with a clean tree and no git-ignored files, gets here.
   - `confirm`: each row's `path` and `reasons`.
   - `skip`: how many, and why when it is not the main checkout or the current worktree.
   - With `gh_available: false`, say that nothing is automatic this run: only GitHub can prove a pull request merged.
3. With `--dry-run`, stop here.
4. Ask once per `confirm` row: Delete, Keep, or Stop. Record `"delete"` or `"keep"` under its exact `path`.
   Stop ends the questions; every row not asked is kept. Never infer a decision from the plan.
5. Execute with the same `--min-age`, and `--force` only when the user invoked this skill with `--force`.
   Give the shell call a 10-minute timeout: a worktree with large ignored folders takes time to remove.

   ```bash
   aidrian worktree cleanup execute [--min-age <duration>] [--force] <<'JSON'
   {"<path>": "delete", "<other path>": "keep"}
   JSON
   ```

6. Report `removed`, `kept`, `refused`, and `failed`, with errors verbatim.
   A `removed` row with `branch_error` lost its worktree but kept its branch,
   because git found unmerged commits on it or a commit landed on it during the run.
   List those branches so they do not pile up.

Execute sorts the worktrees again before it removes anything, so a row that changed since the plan is judged as it is now.
A row whose HEAD moves, or whose clean tree gains changes or ignored files, while execute runs is refused, and its worktree and branch stay.
A confirmed row with uncommitted changes, or a detached HEAD with commits on no branch, is refused without `--force`.
The main checkout, the current worktree, and locked worktrees are never touched.
When `aidrian` is not on your PATH, run it from the folder that holds the `aidrian-knowledge` the start hook names.
