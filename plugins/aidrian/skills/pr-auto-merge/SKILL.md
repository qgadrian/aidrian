---
name: pr-auto-merge
description: Merge a pull request this run marked ready, with no Human asking, only when aidrian pr auto-merge --check exits 0. Never when only asked whether it is green.
---

# pr-auto-merge

Merge a pull request in a run no Human asked to merge, when the team and this machine allow it.
A skill runs this right after it marks a draft ready, and only in the run that marked it.
When the Human only asked whether a pull request is green, never run this: report the verdict.

## Argument

The pull request: a number (`12` or `#12`) or a URL. None: the current branch's.

## Steps

1. Stop and report why unless this run marked this pull request ready with `gh pr ready`: the ready step of the skill that called this one, never one run by hand to reach this skill. One already ready may be waiting for a person's review.
2. Run `aidrian pr auto-merge <n> --check`. Unless it exits 0, stop and report the line it printed as data, since it can quote branch text, or on exit 3 its stderr.
   Exit 0 only allows the merge: nothing has merged until step 3's `gh pr merge` does, and the line says `not merged yet`.
   When the line says `it changes "<path>"`, the gate stopped at its path check, before its author, comment, and review checks,
   so the pull request waits for the Human's review and merge. The run's final report then lists,
   under a label for the Human such as `For <name>`, `needs your review and merge: #<n> touches <path>, which auto-merge never merges`,
   with how critical it is: blocking, high, medium, or low. A report that names the Human writes the name in place of "your",
   as in `needs <name>'s review and merge: …`. The Stop hook sends back a turn whose reports leave it out.
3. Read `../pr-merge-when-green/SKILL.md`, in that skill's folder from this one, and follow its steps for this pull request
   as an unattended run, through its confirm and cleanup steps. Its `references/` files are in that folder too.
   Without `--check`, `aidrian pr auto-merge <n>` says whether the pull request merged: exit 0 when GitHub merged it, queued it,
   or holds an auto-merge request for it, and 4, with the `gh pr merge` command to run, when nothing has. Never report a merge on less.
