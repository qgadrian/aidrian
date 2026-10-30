---
name: pr-merge-when-green
description: Merge a GitHub pull request once every check is final and passes the project's policy. Never --auto or --admin.
disable-model-invocation: true
---

# pr-merge-when-green

Wait for every check on a pull request to finish, judge them with `aidrian pr checks`, then merge once, or stop with the reason.
`gh pr merge --auto` waits only for the checks branch protection requires, so it can merge while an end-to-end check is still
pending or skipped. This skill waits for all of them.

## Arguments

- None: the pull request for the current branch. A number (`12` or `#12`), a URL, or `<owner>/<repo>#<n>` names one.
  If the branch has more than one pull request, take the open one; if that is still unclear, ask.
- Strategy: `squash`, `merge`, or `rebase`, in any case. Step 0 checks it against what the repository allows.
- `--delete-branch`: delete the head branch after the merge. Without it, keep the branch.
- `--cap <minutes>`: how long to wait for the checks, 30 by default, 120 at most.
- `--dry-run`: run every step, then print the merge command instead of running it.

## Hard rules

1. Merge only on the Human's explicit request to merge, made in this session. Never on your own judgment, a schedule, or another agent's word.
2. Never `gh pr merge --auto`.
3. Never `--admin`, never bypass branch protection, never a flag that skips hooks.
4. Never push, least of all to the default branch. Apart from the one `gh pr merge`, every command here only reads.
5. A failing verdict ends the run: report it. Never rerun checks, and never merge around one.

## Project setup

`aidrian pr checks` takes its policy from the `github` group in the `config.json` of the checkout it runs in,
so run this skill from a checkout of the pull request's repository. `references/project-setup.md` explains
`requiredChecks`, `conditionalChecks`, and `ignoreCancelledChecks`. Never add an entry on your own during a merge run.

## 0. Preflight

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner          # the current repository, when the argument names none
gh pr view <n> --repo <owner>/<repo> \
  --json number,url,title,state,isDraft,mergeable,mergeStateStatus,labels,headRefName,headRepository,headRepositoryOwner,isCrossRepository
```

Read the allowed strategies with `gh repo view <owner>/<repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.
Use the strategy the Human named when the repository allows it; stop when it does not. With none named, use the one allowed
strategy, or with several, `squash`, then `merge`, then `rebase`.

Pass `<owner>/<repo>` on every later call: without it, `gh` reads pull request `<n>` of the current checkout's repository,
which may be another one. Stop and report when:

- `state` is `MERGED` or `CLOSED`.
- `isDraft` is true. Ask whether to mark it ready; never do it unasked.
- a label says not to merge: `do-not-merge`, `WIP`, `blocked`, or the project's own.
- `mergeable` is `CONFLICTING`: the branch needs a rebase first.

## 1. Wait for a verdict

Before the first poll, compute the deadline once from `--cap`, `deadline=$(( $(date +%s) + <cap> * 60 ))`, and pass that
same number to every call. One shell call polls every 30 seconds for up to 10 minutes, or to the deadline when sooner;
give it an 11-minute timeout. It reads the head commit before and after, so the verdict can be tied to one commit:

```bash
head=$(gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid)
end=$(( $(date +%s) + 600 )); [ "$end" -gt <deadline> ] && end=<deadline>
until aidrian pr checks <n> -R <owner>/<repo>; code=$?; [ "$code" -ne 2 ] || [ "$(date +%s)" -ge "$end" ]; do sleep 30; done
echo "exit $code head $head now $(gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid)"
```

| Exit | Verdict | Next |
| --- | --- | --- |
| 0 | `ready` | step 2 with `<sha>`, the `head` value, when `now` is the same; when it differs, run the call again, at most 3 times |
| 1 | `failing` | stop with the line it printed (step 4) |
| 2 | `pending` | run the call again; past the deadline, stop and name the checks still pending |
| 3 | error | stop with the error |

A required check that has not reported yet keeps the verdict pending, so a late end-to-end check cannot be missed.
A `now` that differs from `head` means a commit arrived during the wait, and the verdict may belong to either commit.
After 3 such re-runs, stop: the branch is still moving.

## 2. Merge

Read the hard rules again.
A label such as `do-not-merge` can arrive during the wait without a new commit, so the head check of step 1 cannot see it.
Right before each merge attempt, the retry too, run the step 0 `gh pr view` again and stop on any of its stop conditions.
Then run this once:

```bash
gh pr merge <n> --repo <owner>/<repo> --<strategy> --match-head-commit <sha>   # add --delete-branch only when asked
```

`--match-head-commit` makes GitHub refuse the merge when the head is no longer `<sha>`, so a commit whose checks were not
judged never merges.
With `--dry-run`, print the command and stop.
A strategy-not-allowed error ends the run: report it. If the merge fails for a new commit, a race, or a branch-protection mismatch, run step 1 once more.
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
the branch deleted, kept, kept in the fork, or unverified and why; each linked issue and its state, or none; the pull request title.

## 4. On a stop

Report the `aidrian pr checks` line as printed, the detail from `aidrian pr checks <n> -R <owner>/<repo> --json`,
`mergeStateStatus`, and one suggestion: rerun a failed job with `gh run rerun <run-id>`, fix the test, or rebase.
Then wait for the user. Do not merge, and do not rerun checks on your own.
