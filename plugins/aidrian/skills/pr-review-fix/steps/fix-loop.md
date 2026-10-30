# Fix loop

Read this file before the first dispatch. Run it once per slice, in the order of the selection.

## 1. Brief the owner

First set each finding of the slice to `in_progress` in the manifest, and raise its `attempts` by one.

```text
Fix <ids> on pull request #<n>, branch <branch>, as <owner>.
Follow the `knowledge` skill first. Start with `git pull --ff-only`.

<for each finding, verbatim from the manifest: id, file and line, severity, likelihood, affects, summary, next_step>

Change only these files: <paths>. No unrelated edits, refactors, or renames.
Fix the cause the finding names, and every copy of the same mistake in these files.
Add or update a test for each behaviour change: a behaviour change without a test change is not done.
Run the commands the project's `testing` knowledge names for the touched files, and report each one with its result.
Do not commit yet: the review comes first. Return the machine handoff from the `knowledge` skill, with the changed files,
the tests you added or changed, each command and its result, and a Conventional Commits subject for the commit.
```

On a corrective pass, add: `The review of the first fix said: <the reviewer's words, verbatim>.`

## 2. Check the return

- Each verification command ran and passed. A failure goes back to the owner within the same pass.
- A behaviour change comes with a test change. Without one, it goes back to the owner within the same pass.
- `git status --porcelain` shows changes only in the slice's files. Ask the owner about any other file; revert nothing yourself.
- `needs_input` or `blocked` from the owner stops the slice: set its findings `blocked`, with the reason in `note`, and ask the user.

## 3. Review the fix

Send the agent that raised the finding (its `specialist`; `security-engineer` for a security finding) the finding verbatim,
the diff of the slice's files (`git diff -- <paths>`), and one question: is it fixed, not fixed, or fixed but broken elsewhere?
Ask for evidence with the answer.

- Fixed: go to step 4.
- Not fixed, or broken elsewhere, after the first pass: run a corrective pass from step 1.
- The same after the second pass: set the findings `blocked`, with the reviewer's reason in `note`.
  Ask the user whether the owner discards the attempt (`git restore --staged --worktree -- <paths>`) or leaves it uncommitted to finish by hand.
  Keeping it ends this run; discarding it lets the next slice start on a clean tree.

## 4. Commit and write back

1. Continue the owner with: `git add -- <paths>`, check that `git diff --cached --name-only` lists exactly these files,
   commit with your subject and the body lines `Addresses <id> from pr-review round <raised_in>`, one per finding,
   then `git push` (with `--no-push`, skip the push). Return the exact commands, the short SHA, and `not_bypassed` or `hook_failed`.
2. Check that `git show --name-only --format= <sha>` lists exactly the slice's files.
3. Set each finding of the slice to `fixed`, with the short SHA in `commit`.

Write the manifest after each step that changes a status, never once at the end:
a run that stops halfway then leaves a record the next run can resume from.
