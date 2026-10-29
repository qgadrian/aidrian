---
name: pr-review-fix
description: Fix the findings a pr-review round recorded on a pull request. Routes each to its owner, verifies, commits, pushes, and records the progress.
---

# pr-review-fix

Take the findings the `pr-review` skill recorded for a pull request to a verified commit, or to the user with the reason it stopped.
This skill coordinates: an owner fixes each finding, the agent that raised it reviews the fix,
and the skill commits and keeps the manifest current.
Review comments that a person or a bot left on GitHub belong to the `pr-review-loop` skill instead.

Before you start, follow the `knowledge` skill. Load your `orchestration` docs for the agent registry,
`testing` docs for the commands that verify a fix, and `product_sensitive` docs when a finding touches what users see, money, or data.

## Arguments

```text
[<pull request number or URL>] [--only <id>,<id>] [--no-push]
```

- Without a number, use the current branch's pull request (`gh pr view --json number,headRefOid,headRefName,isDraft`).
- `--only F2,F5`: work on these findings only.
- `--no-push`: commit, then print the push command instead of running it.

## 1. Preflight

- Work in the pull request's worktree, on its branch, never on the default branch.
  `git status --porcelain` must be clean or hold only this pull request's work; ask about anything else.
- `git fetch origin && git pull --ff-only`, before you read the manifest. When that fails, the branch was rewritten upstream: ask before resetting.
- On a pull request already marked ready for review (not a draft), stop after step 3:
  report the selected findings as follow-ups for a new pull request, and change nothing on this branch.

## 2. Source

In that worktree, after the sync, read the manifest `<state>/reviews/pr-<n>.json`, where `<state>` is the folder `aidrian state` prints.
The `pr-review` skill's `references/manifest.md` defines its fields and statuses, and how to write it.

- No manifest: stop, and say to run the `pr-review` skill first.
- Check that the manifest's `head_sha` still covers the synced `HEAD`. It does not when `git merge-base --is-ancestor <head_sha> HEAD` fails,
  or when `git log --format=%h <head_sha>..HEAD` lists a commit that no finding records in its `commit`: nobody reviewed that commit.
  Then stop and ask the user: run the `pr-review` skill again first (recommended), or go on with the old findings.
- A finding left `in_progress` by a run that stopped: look for its commit with `git log --grep "Addresses <id> " <head_sha>..HEAD`.
  When one exists, record it as `fixed` with that commit. Otherwise ask the user whether to start it again.
  Never revert or clean up a stopped run's work on your own.

## 3. Selection

1. `fix_now` findings with status `open`, by severity, then likelihood. With `--only`, those ids alone.
2. `accepted_residual` findings with status `open` get no code fix: a short code comment at the line that names the residual,
   and a line in the pull request body's Accepted residuals section, written with the `pr-write` skill.
   Their comments go in one last commit; record it in each finding's `commit` and `note`, and keep the status `open`.
3. `disputed` findings go to the user, one at a time, each with both positions. Never choose for the user.
   Record the answer as the manifest's rules say; a finding that becomes `open` joins this selection.
4. `blocked` findings are listed, and tried again only on the user's word.
5. Everything else needs no action here: `drop_unless_cited`, `acceptable_as_is`, `needs_axis`, `pre_existing`, `fixed`, and `resolved`.

## 4. Owners

Before the first dispatch, read the agent registry in the project's `orchestration` knowledge and apply the `knowledge` skill's rule:
a project agent that fits the task, or shares a name, wins; this plugin's agents are the fallback.

- A finding's owner is the agent the registry gives its file.
- With no registry entry: `backend-developer` for server code and data, `designer` for presentation;
  the session fixes anything else itself, with the same brief.
- A security finding is fixed by the owner of its area, and reviewed by `security-engineer`.
- When a fix needs a product decision the docs do not settle, ask `product-manager` first, and put its answer in the brief.
- Group findings into one slice only when they share the owner and the files. Never give one owner another owner's findings.

## 5. Fix loop

Read `steps/fix-loop.md` before the first dispatch, and run it once per slice.
Each slice is briefed, verified, reviewed by the agent that raised its findings, committed, and written back to the manifest.
A finding gets at most 2 passes: the fix, and one corrective pass when the review says it is not fixed or broke something.
After the second pass it is `blocked`, with the reason in `note`, and goes to the user.

## 6. Commit and push

- One Conventional Commits commit per slice, made by the session once the review passes, with only that slice's files staged.
  Its body has one line per finding: `Addresses <id> from pr-review round <raised_in>`.
- A failing hook is a verdict: fix the cause and commit again. Never bypass a hook.
- With more than one slice, one `code-reviewer` pass over `git diff <head_sha>..HEAD` checks that no fix broke another before the push.
  A real problem becomes one corrective slice for its owner.
- `git push`, to the fork's remote when the head lives in a fork. Then confirm with `git ls-remote --heads <remote> <branch>`
  that the last commit is there. Never push to the default branch. With `--no-push`, print the command instead.

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
