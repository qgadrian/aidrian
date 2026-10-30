---
name: worktree-new
description: Create a task worktree with `aidrian worktree new` and run the project's bootstrap. Use when a task needs one.
---

# worktree-new

A thin adapter for `aidrian worktree new`. The command owns the git and setup steps; never run them yourself.

## Inputs

- **Branch**: from the request or its issue, in the project's branch format. When nothing names one, ask.
- **Base**: `origin/<defaultBranch>` from config.json unless the request names another ref.

## Run

1. Plan first and show the result's `worktree_path` and `branch_mode`:

   ```bash
   aidrian worktree new <branch> --plan [--base <ref>] [--fetch]
   ```

2. Ask before you create:
   - `branch_mode: new`: Proceed or Cancel.
   - `reuse-local` or `reuse-remote`: the branch already exists. Ask Reuse, Choose another name, or Cancel.
   - Skip the question only when the caller already approved this exact plan.
3. Create: the same command without `--plan`. Add `--reuse-existing` only after a reuse was approved.
   The project's bootstrap command (config.json `worktrees.bootstrap`) runs inside the new worktree and can take minutes,
   so give the shell call a 10-minute timeout.
4. On `"status": "created"`, report `worktree_path`, `branch`, and `branch_mode`, and run every later command inside `worktree_path`.
5. On `"status": "blocked"`, relay `phase`, `reason`, and `next_step` as they are.
   After a failed fetch, offer the same run without `--fetch`. Never delete what a failed run left: a failed bootstrap keeps the worktree.

Worktrees go in `.worktrees/` at the repository root unless config.json `worktrees.dir` moves them.
The command never commits, pushes, opens a pull request, or moves uncommitted changes.
When `aidrian` is not on your PATH, run it from the folder that holds the `aidrian-knowledge` the start hook names.
