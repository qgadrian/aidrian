---
name: pr-write
description: Draft, create, or update a GitHub pull request title and body from the real diff and real test evidence.
---

# pr-write

Write a pull request a reviewer understands in 30 seconds: what changed, why, how risky it is, and what proves it works.
This skill writes the title and body and publishes them. It never edits code, pushes, or merges.

Before you start, follow the `knowledge` skill. Load your `issue_tracker` docs for the issue key format and closing keyword.

## Read the branch, not your memory

Derive everything from the branch as it is now, even when you think you know its scope.

```bash
git fetch origin <base>
git log --oneline origin/<base>..HEAD
git diff --stat origin/<base>...HEAD
```

- `<base>` is the branch the pull request targets: the one the caller names, else config.json `git.defaultBranch`.
  Always the `origin/` ref, because a local branch can be days behind.
- Read a large diff by its stat, then open only the files that matter. Never dump the whole diff.
- When a pull request already exists, `gh pr view <n> --json number,title,body,commits,baseRefName` must agree with the
  commit count above; if it does not, fetch again before you write.
- Find the issues the branch implements in its name, its commits, and the existing pull request.

## Title

A plain Conventional Commits title: `<type>(<scope>): <subject>`.
Only when config.json `github.titleIssuePrefix` is `true`, prefix the issue key: `[<issue key>] <type>(<scope>): <subject>`,
or `[NOISSUE] <type>: <subject>` when no issue exists. The key format comes from the project's `issue_tracker` knowledge. The type is a Conventional Commits type from config.json
`git.commits.types`. The subject names the real scope of the branch.
When config.json `github.pullRequest.title` is set, the title matches that pattern; the Bash hook refuses one that does not.

## Body

Every section in config.json `github.requiredSections` (default `Summary`, `Tests run`), as `## ` headings, in that order.
`aidrian check` validates the config; the Bash hook refuses a body that lacks a required section.
Add an optional section only when it carries something: [references/body-template.md](references/body-template.md)
lists the sections and what goes in each.
When config.json `github.pullRequest` sets them, use only the `sections` it lists, give each `deferrals` item a reason
from its list and the issue it went to, and each `residuals` item every field it lists, as `field: value`.

- **Evidence is what ran.** List the exact commands you or an agent ran in this branch, and what each proved.
  If evidence is missing, say so; never invent a test, a screenshot, or a result.
- **Close issues in plain text.** One line per issue the branch fully implements, such as `Fixes ABC-12` on Linear
  or `Fixes #12` on GitHub, as the `knowledge` skill's `references/tracker.md` writes the key in a body line,
  never inside backticks, a link, or a quote, where trackers ignore it. Use `Refs ABC-12` or `Refs #12` for partial work.
- **The reader is a reviewer.** No plan paths, handoff files, agent names, worktree paths, or local paths, visible or
  in HTML comments. No commit-by-commit history or file counts: GitHub shows those.
- **No generated-by footer**, and no `--fill`: gh would write the body from commit messages.
- Flag a mixed-scope or oversized branch in the risk section instead of smoothing it over.

## Publish

Write the body to `<state>/tmp/pr-body-<branch>.md`, where `<state>` is the folder `aidrian state` prints and
`<branch>` is the branch name with each `/` replaced by `-`. It sits outside the repository, one file per branch, so no
other session overwrites it; a path under `.git/` fails in a worktree, where `.git` is a file.
Give gh that path written out, never `$(aidrian state)/…`: the Bash hook checks only a body file it can name. Then:

```bash
gh pr create --draft --base <base> --title "<title>" --body-file <file>   # new: draft by default
gh pr edit <n> --title "<title>" --body-file <file>                       # existing: update, never recreate
```

- Draft by default: the review loop runs on the draft, and the author marks it ready. Open it ready only when asked.
- Before an edit, read the live body again (`gh pr view <n> --json body`) and keep what is still true.
- After publishing, read it back and confirm each closing line is plain text on its own line.

## Stop instead of guessing

Return the drafted title and body, the reason, and the next step, instead of publishing, when:

- the branch is not pushed, or `gh auth status` fails;
- the branch has no diff against the base, or the base is unclear;
- a doc the branch makes wrong is not updated in the branch: route it back to the owner of the change first.
