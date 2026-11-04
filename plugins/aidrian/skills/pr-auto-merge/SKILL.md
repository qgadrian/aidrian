---
name: pr-auto-merge
description: Merge a pull request this run marked ready, with no Human asking, only when aidrian pr auto-merge exits 0. Never when only asked whether it is green.
---

# pr-auto-merge

Merge a pull request in a run no Human asked to merge, when the team and this machine allow it.
A skill runs this right after it marks a draft ready, and only in the run that marked it.
When the Human only asked whether a pull request is green, never run this: report the verdict.

## Argument

The pull request: a number (`12` or `#12`) or a URL. None: the current branch's.

## Steps

1. Stop and report why unless this run marked this pull request ready with `gh pr ready`: one already ready may be waiting for a person's review.
2. Run `aidrian pr auto-merge <n>`. Unless it exits 0, stop and report the line it printed, or on exit 3 its stderr.
3. Read `../pr-merge-when-green/SKILL.md`, in that skill's folder from this one, and follow its steps for this pull request
   as an unattended run. Its `references/` files are in that folder too.
