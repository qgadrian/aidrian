# Scope resolver

Read this file in step 1. It turns the branch and the flags into one scope object, in this order.
Every command is read-only.

## 1. Refuse states with no stable diff

- `git rev-parse --abbrev-ref HEAD` prints `HEAD`: return `blocked`, reason `detached_head`.
- A merge or rebase in progress: return `blocked`, reason `merge_or_rebase_in_progress`.
  Test each of `MERGE_HEAD`, `REBASE_HEAD`, `rebase-merge`, and `rebase-apply` with `test -e "$(git rev-parse --git-path <name>)"`;
  `--git-path` finds them in a worktree too.

## 2. Branch

`branch` is the output of `git rev-parse --abbrev-ref HEAD`.
`git.defaultBranch` comes from `.aidrian/config.json`, `main` when unset.
On the default branch there is nothing to compare: return `blocked`, reason `on_default_branch`.

## 3. Base

`base_ref` is `--base` when given, else `origin/<defaultBranch>`.
When `git rev-parse --verify <base_ref>` fails and the ref has a remote part, run `git fetch <remote> <branch part>` once and try again.
If it still fails, return `blocked`, reason `base_unresolvable: pass --base`.

## 4. Commits

```bash
base_sha="$(git merge-base "$base_ref" HEAD)"   # empty: blocked, reason merge_base_failed
head_sha="$(git rev-parse HEAD)"
```

## 5. Diff

`git diff "$base_sha"` compares the base with the working tree, so one diff holds the branch's commits and its uncommitted changes
to tracked files. Untracked files are left out; say so in `warnings` when `git status --porcelain` lists any.

```bash
git diff --name-only "$base_sha"   # changed_files; file_count is its length
git diff --numstat "$base_sha"     # diff_lines: the sum of added and deleted lines
git diff "$base_sha"               # diff_body
```

## 6. Empty and large diffs

- No changed files: return `nothing_to_review`. Spawn nothing.
- More than 50 files or more than 2,000 lines, without `--full`: use summary mode.
  `diff_body` is `git diff --stat "$base_sha"` followed by the first 50 lines of each file's diff,
  and `warnings` gets "summary mode: run again with --full for the whole diff".

## 7. Linked issue

Best effort; it never blocks.
Look for an issue key in the branch name, then in a `Fixes`, `Closes`, or `Refs` line of the open pull request's body
(`gh pr view --json body -q .body`).
Read the issue with the tool the project's `issue_tracker` knowledge names: its title, its state, and its acceptance criteria.
On any failure, go on with `linked_issue: null`.

## Output

```yaml
status: ok | blocked | nothing_to_review
reason: <string or null>
branch: <name>
base_ref: <ref>
base_sha: <full sha>
head_sha: <full sha>
diff_mode: full | summary
file_count: <n>
diff_lines: <n>
changed_files: [<path>, ...]
linked_issue: { key, title, state, criteria } | null
diff_body: <text>
warnings: [<string>, ...]
```
