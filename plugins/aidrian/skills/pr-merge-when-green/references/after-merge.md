# After the merge

Read once `gh pr merge` succeeded, before step 3. § Confirm is step 3; § Cleanup is step 5.

## Confirm

```bash
gh pr view <n> --repo <owner>/<repo> --json state,mergedAt,mergeCommit
gh api repos/<head-owner>/<head-repo> --silent                          # fails when the head repository is gone or unreadable
gh api "repos/<head-owner>/<head-repo>/branches/<encoded-head>" --silent   # exits non-zero with 404 once the branch is gone
```

`<head-owner>/<head-repo>` is `headRepositoryOwner.login`/`headRepository.name` from step 0: a fork's branch lives in the fork.
`<encoded-head>` is `headRefName` URL-encoded: every character but letters, digits, `-`, `_`, and `.` as `%XX`, `/` too. The name is the author's text.
Read the branch only when the repository call succeeds. GitHub answers 404 for a repository you cannot read, as for a gone
branch, so when that call fails or `headRepository` is null, skip the branch check and report it unverified, naming the fork.
When `isCrossRepository` is true, gh never deletes the head branch, so a branch still in the fork is expected.
Deleting or keeping the branch means the remote one; removing the worktree in step 5 takes the local one with it.

When the body names an issue the pull request closes, check that issue's state in the tracker the project's
`issue_tracker` knowledge names.

A command that succeeded with `state` not `MERGED` went into a merge queue: report it queued, with no cleanup, and end the run.

Otherwise report one line each: merged, with the strategy and the merge commit; every check passed, with the skipped ones named;
the branch deleted, kept, kept in the fork, or unverified and why; each linked issue and its state, or none; the pull request title.

## Cleanup

Run nothing, and report, in each of these cases:

- `isCrossRepository` is true: a local branch of that name is not the fork's. Report `worktree: none`.
- `git worktree list --porcelain` has no block with `branch refs/heads/<headRefName>`: report `worktree: none`.
  Otherwise the block's `worktree` line is `<path>`.
- the block's `HEAD` is not `<sha>`, the head that merged: report `worktree kept: its HEAD is not the merged head`.
- `<path>` is `git rev-parse --show-toplevel`, the session's own worktree:
  report `worktree kept: run worktree-cleanup from the main checkout`. The command skips that worktree too.

Otherwise run step 5's command, and report as follows.

`aidrian worktree cleanup execute` prints `removed`, `kept`, `refused`, `failed`, and `unmatched`. Report the worktree's row.
Exit 1 prints `"status":"blocked"` instead: report its `reason`. A failure with no JSON: report its stderr.

- `removed`: the worktree is gone. With `branch_deleted` false, name the local branch and its `branch_error`:
  git found commits on it that no merge holds, or one landed during the run.
- `refused` or `failed`: its `reason` or `error`, verbatim.
- `kept`, or in none of them: run `aidrian worktree cleanup plan --only "<path>" --min-age 0`, which only reads.
  A `confirm` row was kept because the cleanup could not prove the work merged: report its `reasons`, and that the
  `worktree-cleanup` skill asks the Human about it. A `skip` row was skipped: report its `reason`, such as `locked`.
