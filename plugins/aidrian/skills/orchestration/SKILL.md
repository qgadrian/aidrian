---
name: orchestration
description: Load before the orchestrator's first editing dispatch or pull request step. Covers worktrees, parallel slices, the pull request, and review findings.
---

# orchestration

The `orchestrator` agent loads this skill before its first editing dispatch or pull request step, and follows it until the task closes.
Each step is a dispatch, a skill, or a command: you still edit no file yourself.
This plugin's agents named here, such as `integrator`, are spawned as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.

## 1. The task worktree

Editing never happens in the main checkout, the parent folder of `git rev-parse --path-format=absolute --git-common-dir`.

- When the current checkout is not the main checkout, it is the task worktree, on whatever branch it has. Use it.
- Otherwise create one with the `worktree-new` skill, which runs `aidrian worktree new <branch>`.
  - First run `git status --porcelain` in the main checkout. When it prints anything, show it to the Human and ask once
    whether the task needs those changes: a new worktree starts without them.
  - When the command reports that the branch is checked out in the main checkout, ask the Human whether to work there instead.
- Give the worktree's absolute path to every editing dispatch.

## 2. Parallel slices

- Slices run in parallel only when their files are disjoint and they share no generated file, such as a lockfile.
- Each parallel writer gets its own worktree and branch from `aidrian worktree new`.
- Land the slice branches on the task branch with the `worktree-integrate` skill, in the order the slice plan locked.
  A conflict goes to the owner the `integrator` names.

## 3. The pull request

1. Once every slice is committed on the task branch, push it with `git push -u origin <branch>`.
   Confirm with `git ls-remote --heads origin <branch>` that the remote has the last commit. Never force-push.
2. Open a draft with the `pr-write` skill.
3. With more than one slice, run the `pr-review` skill on the assembled branch: it rechecks earlier slices' stubs and
   defaults against the later slices. Its findings go through the `pr-review-fix` skill and § 4.
4. After each push, run the `pr-review-loop` skill with `--await-codex`.
   In both skills, route each fix to its owner by § 4, even where a skill says the session fixes it itself.
5. Stop the loop when a round yields no `fix_now`.

## 4. Review findings

- Run each finding through `aidrian pr disposition` with the reviewer's severity, likelihood, and affects.
  A finding without them goes back to its reviewer.
- `fix_now` goes to its owner, highest likelihood × impact first.
  The owner fixes every copy of the pattern, not only the flagged line.
  A fix no registry entry or skill default owns goes to `doc-updater` when it is docs only; otherwise ask the Human for its owner.
- `accepted_residual` goes in the pull request body, through the `pr-write` skill.
- Chase no rare edge case.
