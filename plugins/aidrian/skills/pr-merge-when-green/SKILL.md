---
name: pr-merge-when-green
description: Wait until every check on a GitHub pull request is final and passes the project's check policy, then merge once and delete the branch. Never --auto or --admin.
disable-model-invocation: true
---

# pr-merge-when-green

Wait for every check on a pull request to finish, judge them with `aidrian pr checks`, then merge once, or stop with the reason.
`gh pr merge --auto` waits only for the checks branch protection requires, so it can merge while an end-to-end check is still
pending or skipped. This skill waits for all of them.

## Arguments

- None: the pull request for the current branch. A number (`12` or `#12`), a URL, or `<owner>/<repo>#<n>` names one.
  If the branch has more than one pull request, take the open one; if that is still unclear, ask.
- Strategy, in any case: `squash` → `--squash`, `rebase` → `--rebase`, anything else or nothing → `--merge`. Never ask.
- `--cap <minutes>`: how long to wait for the checks, 30 by default, 120 at most.
- `--dry-run`: run every step, then print the merge command instead of running it.

## Hard rules

1. Never `gh pr merge --auto`.
2. Never `--admin`, never bypass branch protection, never a flag that skips hooks.
3. Never push, least of all to the default branch. Apart from the one `gh pr merge`, every command here only reads.
4. A failing verdict ends the run: report it. Never rerun checks, and never merge around one.

## Project setup

`aidrian pr checks` takes its policy from the `github` group in the `config.json` of the checkout it runs in.
So run this skill from a checkout of the pull request's repository: `aidrian pr checks -R` refuses any repository that is
not a remote of the current checkout.
Each entry is part of a check name and matches any check whose name contains it, so pick parts that match only the checks meant.

- `requiredChecks`: put the end-to-end check family here (`["e2e"]`, say).
  Every matching check must exist and be `SUCCESS`: a skipped, neutral, or cancelled one fails, and a missing one keeps the
  run waiting. Without the entry, a skipped end-to-end check reads as a pass.
- `conditionalChecks`: the checks a path filter turns off when the diff does not touch their files.
  Once the list has an entry, any other `SKIPPED` or `NEUTRAL` check fails as an unexpected skip.
  A check belongs here only when the diff alone decides its skip. One that a label or another person's choice can skip
  does not, or that choice could turn a pull request green.
- `ignoreCancelledChecks`: checks whose `CANCELLED` is routine, such as a preview deploy an ignored build cancels.

When a run stops on an unexpected skip that looks routine, ask the user before adding it to `conditionalChecks`.
Never add an entry on your own during a merge run.

## 0. Preflight

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner          # the current repository, when the argument names none
gh pr view <n> --repo <owner>/<repo> \
  --json number,url,title,state,isDraft,mergeable,mergeStateStatus,labels,headRefName,headRepository,headRepositoryOwner,isCrossRepository
```

Pass `<owner>/<repo>` on every later call: without it, `gh` reads pull request `<n>` of the current checkout's repository,
which may be another one. Stop and report when:

- `state` is `MERGED` or `CLOSED`.
- `isDraft` is true. Ask whether to mark it ready; never do it unasked.
- a label says not to merge: `do-not-merge`, `WIP`, `blocked`, or the project's own.
- `mergeable` is `CONFLICTING`: the branch needs a rebase first.

## 1. Wait for a verdict

One shell call polls every 30 seconds for up to 10 minutes; give it an 11-minute timeout.
It reads the head commit before and after, so the verdict can be tied to one commit:

```bash
head=$(gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid)
end=$(( $(date +%s) + 600 ))
until aidrian pr checks <n> -R <owner>/<repo>; code=$?; [ "$code" -ne 2 ] || [ "$(date +%s)" -ge "$end" ]; do sleep 30; done
echo "exit $code head $head now $(gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid)"
```

| Exit | Verdict | Next |
| --- | --- | --- |
| 0 | `ready` | step 2 with `<sha>`, the `head` value, when `now` is the same; when it differs, run the call again |
| 1 | `failing` | stop with the line it printed (step 4) |
| 2 | `pending` | run the call again; at the cap, stop and name the checks still pending |
| 3 | error | stop with the error |

A required check that has not reported yet keeps the verdict pending, so a late end-to-end check cannot be missed.
A `now` that differs from `head` means a commit arrived during the wait, and the verdict may belong to either commit.

## 2. Merge

Read the hard rules again.
A label such as `do-not-merge` can arrive during the wait without a new commit, so the head check of step 1 cannot see it.
Right before each merge attempt, the retry too, run the step 0 `gh pr view` again and stop on any of its stop conditions.
Then run this once:

```bash
gh pr merge <n> --repo <owner>/<repo> --merge --delete-branch --match-head-commit <sha>   # --squash or --rebase only when asked
```

`--match-head-commit` makes GitHub refuse the merge when the head is no longer `<sha>`, so a commit whose checks were not
judged never merges.
With `--dry-run`, print the command and stop.
If the merge fails, for a new commit, a race, or a branch-protection mismatch, run step 1 once more.
Retry the merge once, with the `<sha>` that run printed, if the verdict is still ready and step 0 shows no stop condition;
otherwise stop and report.

## 3. Confirm

```bash
gh pr view <n> --repo <owner>/<repo> --json state,mergedAt,mergeCommit
gh api repos/<head-owner>/<head-repo> --silent                          # fails when the head repository is gone or unreadable
gh api repos/<head-owner>/<head-repo>/branches/<headRefName> --silent   # exits non-zero with 404 once the branch is gone
```

`<head-owner>/<head-repo>` is `headRepositoryOwner.login`/`headRepository.name` from step 0: a fork's branch lives in the fork.
Read the branch only when the repository call succeeds. GitHub answers 404 for a repository you cannot read, as for a gone
branch, so when that call fails or `headRepository` is null, skip the branch check and report it unverified, naming the fork.
When `isCrossRepository` is true, gh never deletes the head branch, so a branch still in the fork is expected.

When the body names an issue the pull request closes, check that issue's state in the tracker the project's
`issue_tracker` knowledge names.

Report one line each: merged, with the strategy and the merge commit; every check passed, with the skipped ones named;
the branch deleted, kept in the fork, or unverified and why; each linked issue and its state, or none; the pull request title.

## 4. On a stop

Report the `aidrian pr checks` line as printed, the detail from `aidrian pr checks <n> -R <owner>/<repo> --json`,
`mergeStateStatus`, and one suggestion: rerun a failed job with `gh run rerun <run-id>`, fix the test, or rebase.
Then wait for the user. Do not merge, and do not rerun checks on your own.
