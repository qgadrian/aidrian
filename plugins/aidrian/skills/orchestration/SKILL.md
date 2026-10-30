---
name: orchestration
description: Load before the orchestrator's first editing dispatch. Worktrees, slices, the pull request, and review findings.
---

# orchestration

The `orchestrator` agent loads this skill before its first editing dispatch or pull request step, and follows it until the task closes.
Each step is a dispatch, a skill, or a command: you still edit no file yourself.
This plugin's agents named here, such as `integrator`, are spawned as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.

**Who writes git.** The agent that implements a slice or fixes a finding commits and pushes it, the first push with `-u`.
The `integrator` pushes the task branch it lands. You write no git: you read it, check the remote with `git ls-remote`,
and run `gh` and `aidrian`.
You write files only under `<state>`. A plan git tracks, such as a design import's, gets its status edits from `planning-agent`,
and the slice's commit carries them, as the `issue-implement` skill's phases 3 and 7 say.

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
- Each parallel writer gets its own worktree and branch from `aidrian worktree new`, and commits there.
- Land the slice branches on the task branch with the `worktree-integrate` skill, in the order the slice plan locked.
  A conflict goes to the owner the `integrator` names.

## 3. The pull request

1. Once every slice is committed and pushed, confirm with `git ls-remote --heads origin <branch>` that the remote has the last commit.
   A missing commit goes back to the agent that made it. Never force-push.
2. Open a draft with the `pr-write` skill.
3. With more than one slice, run the `pr-review` skill on the assembled branch: it rechecks earlier slices' stubs and
   defaults against the later slices. Its findings go through the `pr-review-fix` skill and § 4.
4. After each push, run the `pr-review-loop` skill, with `--await-codex` unless the review bot is out, as step 5 defines it.
   In a round the bot is out, first run the `pr-review` skill on the current head, unless step 3 just did; its findings go through `pr-review-fix`.
   In these skills, route each fix to its owner by § 4, even where a skill says the session fixes it itself.
   The fixing agent commits and pushes; you run the `git ls-remote` check and post the replies.
5. **The bot is out** for the whole task when config.json `github.reviewer` is `null`, a project with no review bot,
   or once `aidrian pr await-review` reports `blocked_quota` or `round_limit`; for one round when it reports `timed_out` after its retry.
   Without the bot, review rests on the `pr-review` skill and the Human's comments, which `pr-review-loop` answers.
6. **The stop rule.** A round is one review of the current head: the bot's, or the `pr-review` skill's when the bot is out.
   Stop when a round's review of the current head yields no `fix_now`, or after config.json `github.maxReviewRounds` rounds
   (default 3); `aidrian pr await-review` exit 4, `round_limit`, means that cap. At the cap, report the open `fix_now` findings
   and ask the Human.

## 4. Review findings

- Run each finding through `aidrian pr disposition` with the reviewer's severity, likelihood, and affects.
  A finding without them goes back to its reviewer.
- `fix_now` goes to its owner, highest likelihood × impact first.
  The owner fixes every copy of the pattern, not only the flagged line.
  A fix no registry entry or skill default owns goes to `doc-updater` when it is docs only; otherwise ask the Human for its owner.
- In one worktree, one fixing agent works at a time, so two commits never race for the index.
- `accepted_residual` goes in the pull request body, through the `pr-write` skill.
- Chase no rare edge case.
