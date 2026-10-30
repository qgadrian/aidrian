---
name: pr-review-fix
description: Fix the findings a pr-review round recorded, through their owners, and track progress in its manifest.
---

# pr-review-fix

Take the findings the `pr-review` skill recorded for a pull request to a verified commit, or to the user with the reason it stopped.
This skill coordinates: an owner fixes each finding, the agent that raised it reviews the fix,
the owner commits and pushes it, and the skill keeps the manifest current.
Review comments that a person or a bot left on GitHub belong to the `pr-review-loop` skill instead.

Before you start, follow the `knowledge` skill. Load your `testing` docs for the commands that verify a fix,
and `product_sensitive` docs when a finding touches what users see, money, or data.

## Arguments

```text
[<pull request number or URL>] [--only <id>,<id>] [--no-push]
```

- Without a number, use the current branch's pull request (`gh pr view --json number,headRefOid,headRefName,isDraft`).
- `--only F2,F5`: work on these findings only.
- `--no-push`: owners commit but do not push; print the push command instead.

## 1. Preflight

- Run the branch preflight of the `orchestration` skill's `references/review-rules.md`, before you read the manifest.
  Its § A ready pull request says when a ready pull request stops after step 3.
  Its other sections define the fix-pass cap and the disposition actions.

## 2. Source

In that worktree, after the fetch, read the manifest `<state>/reviews/pr-<n>.json`, where `<state>` is the folder `aidrian state` prints.
The `pr-review` skill's `references/manifest.md` defines its fields and statuses, and how to write it.

- No manifest: stop, and say to run the `pr-review` skill first.
- Check that the manifest's `head_sha` still covers the remote head `@{u}`. It does not when `git merge-base --is-ancestor <head_sha> @{u}` fails,
  or when `git log --format=%h <head_sha>..@{u}` lists a commit that no finding records in its `commit`: nobody reviewed that commit.
  Then stop and ask the user: run the `pr-review` skill again first (recommended), or go on with the old findings.
- A finding left `in_progress` by a run that stopped: look for its commit with `git log --grep "Addresses <id> " HEAD @{u} --not <head_sha>`.
  When one exists, record it as `fixed` with that commit. Otherwise ask the user whether to start it again.
  Never revert or clean up a stopped run's work on your own.

## 3. Selection

1. `fix_now` findings with status `open`, by severity, then likelihood. With `--only`, those ids alone.
2. `accepted_residual` findings with status `open` get no code fix: a short code comment at the line that names the residual,
   and a line in the pull request body's Accepted residuals section, written with the `pr-write` skill.
   The owner of their files writes the comments in one last commit and pushes it; record it in each finding's `commit` and `note`,
   and keep the status `open`.
3. `disputed` findings go to the user, one at a time, each with both positions. Never choose for the user.
   In an unattended run, park each as a Decision for the Human, as the review rules say, and never fix it.
   Record the answer as the manifest's rules say; a finding that becomes `open` joins this selection.
4. `blocked` findings are listed, and tried again only on the user's word.
5. Everything else needs no action here: `drop_unless_cited`, `acceptable_as_is`, `needs_axis`, `pre_existing`, `fixed`, and `resolved`.

## 4. Owners

Pick each owner by the `knowledge` skill's agent rule; this plugin's agents are the fallback.

- A finding's owner is the agent the registry gives its file.
- With no registry entry: `backend-developer` for server code and data, `frontend-developer` for client code and UI state,
  `designer` for presentation. A session the Human runs directly fixes anything else itself, with the same brief;
  under the `orchestrator`, the `orchestration` skill § 4 names the owner.
- A security finding is fixed by the owner of its area, and reviewed by `security-engineer`.
- When a fix needs a product decision the docs do not settle, ask `product-manager` first, and put its answer in the brief.
- Group findings into one slice only when they share the owner and the files. Never give one owner another owner's findings.

## 5. Fix loop

Read `steps/fix-loop.md` before the first dispatch, and run it once per slice.
Each slice is briefed, verified, reviewed by the agent that raised its findings, committed and pushed by its owner,
and written back to the manifest.
Each finding gets at most 2 passes, as the review rules say; a `blocked` finding keeps the reason in `note`.

## 6. Commit and push

- One Conventional Commits commit per slice, made by the slice's owner once the review passes, with only that slice's files staged.
  Its body has one line per finding: `Addresses <id> from pr-review round <raised_in>`.
- A failing hook is a verdict: the owner fixes the cause and commits again. Never bypass a hook.
- The owner runs `git push`, to the fork's remote when the head lives in a fork. Never to the default branch.
  With `--no-push`, the owner does not push, and the report prints the command.
- With more than one slice, one `code-reviewer` pass over `git diff <head_sha>..HEAD` checks that no fix broke another.
  A real problem becomes one corrective slice for its owner.
- Unless `--no-push`, confirm with `git ls-remote --heads <remote> <branch>` that the last commit is there.

## 7. Report

```text
| id | verdict | owner | reviewer | verification | status | commit |
```

Then each finding that needs the user (disputed, blocked) with the decision it needs,
and the next step: run the `pr-review` skill again to confirm the fixes. Only a review round marks a finding `resolved`.

## Do not

- Mark a finding `resolved`, or settle a dispute. A review round resolves; the user decides.
- Drop, downgrade, or reword a finding on your own judgment.
- Give a finding a third pass.
- Revert, reset, or delete work you did not make in this run without asking.
