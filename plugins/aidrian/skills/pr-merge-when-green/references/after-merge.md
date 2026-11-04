# After the merge

Read once `gh pr merge` succeeded, before step 3. § Confirm is step 3; § Cleanup report is the end of step 5.

## Confirm

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

## Cleanup report

`aidrian worktree cleanup execute` prints `removed`, `kept`, `refused`, `failed`, and `unmatched`. Report the worktree's row:

- `removed`: the worktree is gone. With `branch_deleted` false, name the local branch and its `branch_error`:
  git found commits on it that no merge holds, or one landed during the run.
- `refused` or `failed`: its `reason` or `error`, verbatim.
- `kept`, or in none of them: run `aidrian worktree cleanup plan --only <path> --min-age 0`, which only reads.
  A `confirm` row was kept because the cleanup could not prove the work merged: report its `reasons`, and that the
  `worktree-cleanup` skill asks the Human about it. A `skip` row was skipped: report its `reason`, such as `locked`.
