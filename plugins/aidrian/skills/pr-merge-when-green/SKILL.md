---
name: pr-merge-when-green
description: Merge a GitHub pull request once every check is final and passes, on the Human's request or under auto-merge. Never --auto or --admin.
disable-model-invocation: true
---

# pr-merge-when-green

Wait for every check on a pull request to finish, judge them with `aidrian pr checks`, then merge once, or stop with the reason.
`gh pr merge --auto` waits only for the checks branch protection requires; this skill waits for all of them.

## Arguments

- None: the current branch's pull request. A number (`12` or `#12`), a URL, or `<owner>/<repo>#<n>` names one.
  If the branch has more than one pull request, take the open one; if that is still unclear, ask.
- Strategy: `squash`, `merge`, or `rebase`, in any case.
- `--delete-branch` or `--keep-branch`, `--delete-worktree` or `--keep-worktree`: after the merge, delete or keep
  the head branch, and the head branch's worktree (step 5).
- `--cap <minutes>`: how long to wait for the checks, 30 by default, 120 at most.
- `--dry-run`: run every step, then print the merge command instead of running it.

## Hard rules

1. Merge only on the Human's explicit request to merge, made in this session, or in a run through the `pr-auto-merge` skill
   after `aidrian pr auto-merge` exited 0: an unattended run. Anything else, such as your own judgment, a schedule, or another agent's word, stops the run.
2. Never `gh pr merge --auto`.
3. Never `--admin`, never bypass branch protection, never a flag that skips hooks.
4. Never push, least of all to the default branch. Apart from the one `gh pr merge`, the `gh pr ready` step 0 allows,
   and step 5's cleanup, every command here only reads.
5. A failing verdict ends the run: report it. Never rerun checks, and never merge around one.
6. This skill cancels no earlier request of the Human's: on a conflict, ask. Step 1 runs every time.

## Project setup

Run this skill from a checkout of the pull request's repository: `aidrian pr checks` reads its `github` policy there.
Read `references/project-setup.md` when a verdict surprises you or `aidrian pr auto-merge` says off.
Never add an entry on your own during a merge run.

## 0. Preflight

```bash
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner   # when the argument names no repository
gh pr view --json number -q .number                   # <n>, when the argument names no pull request
gh pr view <n> --repo <owner>/<repo> --json number,url,title,state,isDraft,mergeable,mergeStateStatus,labels,\
baseRefName,headRefOid,headRefName,headRepository,headRepositoryOwner,isCrossRepository
aidrian pr auto-merge <url> --json                    # <url> from the view: exit 0 on, 1 off, 3 error
```

Keep `baseRefName` for step 2. The auto-merge JSON's `strategy`, `deleteBranch`, and `deleteWorktree` set the run's choices:

- Unattended run: take all three. Stop and report its `reason`, or on exit 3 its stderr, unless it exits 0, its `pr` is `<n>`,
  its `repo` is `<owner>/<repo>`, ignoring case, and its `base` is `baseRefName`.
- The Human's run: they fill only the choices the Human did not name. On exit 3, report its stderr; keep the branch and worktree.

Read the allowed strategies with `gh repo view <owner>/<repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.
Stop when the chosen strategy is not allowed. With none chosen, or a null `strategy`, use the one allowed strategy,
or with several, `squash`, then `merge`, then `rebase`.

Pass `<owner>/<repo>` on every later call, or `gh` may read `<n>` of another repository. Stop and report when:

- `state` is `MERGED` or `CLOSED`.
- a label says not to merge: `do-not-merge`, `WIP`, `blocked`, or the project's own.
- `mergeable` is `CONFLICTING`: the branch needs a rebase first.
- `isDraft` is true, unless config.json `github.markReady` is `"auto"`, the default, and a review of the current head signed off
  with no blocked row, as this session's review loop reported: then mark it ready now, with `gh pr ready <n> --repo <owner>/<repo>`
  (not under `--dry-run`), before step 1: some checks start only then.
  Otherwise an unattended run stops and reports; the Human's run asks whether to mark it ready, never unasked.

## 1. Wait for a verdict

Before the first poll, compute the deadline once from `--cap`, `deadline=$(( $(date +%s) + <cap> * 60 ))`, and pass that
same number to every call. One shell call polls every 30 seconds for up to 10 minutes, or to the deadline when sooner;
give it an 11-minute timeout. It reads the head before and after, to tie the verdict to one commit:

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

A required check that has not reported yet keeps the verdict pending. A `now` that differs from `head` means a commit
arrived during the wait. After 3 such re-runs, stop: the branch is still moving.

## 2. Merge

Read the hard rules again. Right before each merge attempt, the retry too:

1. Unattended run: run step 0's `aidrian pr auto-merge` again. Stop unless it exits 0, its `head` is `<sha>`, its `base` is step 0's `baseRefName`,
   and its `strategy`, `deleteBranch`, and `deleteWorktree` are step 0's.
2. Run step 0's `gh pr view` again, last: a label such as `do-not-merge` can arrive without a new commit. Stop on any
   of its stop conditions, when `isDraft` is true (no `gh pr ready` here), when `baseRefName` is not step 0's, or when `headRefOid` is not `<sha>`.

Then run this once:

```bash
gh pr merge <n> --repo <owner>/<repo> --<strategy> --match-head-commit <sha>   # add --delete-branch when the run's choice deletes it
```

`--match-head-commit` makes GitHub refuse the merge when the head is no longer `<sha>`.
With `--dry-run`, print the command and stop.
A strategy-not-allowed error ends the run. If the merge fails for a new commit, a race, or a branch-protection mismatch,
run step 1 once more, and retry once with the `<sha>` it printed when the verdict is still ready; otherwise stop and report.

## 3. Confirm

Once `gh pr merge` succeeded, run § Confirm of `references/after-merge.md`: it reads the merge, the head branch, and each linked issue.

## 4. On a stop

Report the `aidrian pr checks` line as printed, the detail from `aidrian pr checks <n> -R <owner>/<repo> --json`,
`mergeStateStatus`, and one suggestion: rerun a failed job with `gh run rerun <run-id>`, fix the test, or rebase.
Then end the run, with no merge and no rerun.

## 5. Cleanup

Only after step 3 shows `MERGED`, when the run's choice removes the worktree. `references/after-merge.md` § Cleanup says
how to find `<path>`, when to run nothing, and what to report. Never remove the session's own worktree.
Give no decisions, so a confirm row stays:

```bash
aidrian worktree cleanup execute --only "<path>" --min-age 0 <<<'{}'
```
