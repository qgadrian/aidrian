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
A test change a finding suggests must still catch its mistake: with the change in place, put the mistake back in the code
under test, see the test fail by assertion, undo only that edit, and report both runs.
Run only the tests of the touched files (`aidrian test changed`), never the full suite: CI runs it on the pushed head.
Then `git add -- <paths>`, check that `git diff --cached --name-only` lists exactly these files, commit with a Conventional
Commits subject and one body line per finding, `Addresses <id> from pr-review round <raised_in>`, and `git push`
(with `--no-push`, skip the push). Return the machine handoff from the `knowledge` skill, with the tests you added or changed,
each command and its result, the short SHA, and `not_bypassed` or `hook_failed`.
```

On a corrective pass, add: `The review of the first fix said: <the reviewer's words, verbatim>.`

## 2. Check the return

- Each verification command ran and passed. A failure goes back to the owner within the same pass.
- A behaviour change comes with a test change. Without one, it goes back to the owner within the same pass.
- `git show --name-only --format= <sha>` lists exactly the slice's files, and `git status --porcelain` is clean. Ask the owner about any other file; revert nothing yourself.
- `needs_input` or `blocked` from the owner stops the slice: set its findings `blocked`, with the reason in `note`, and ask the user.

## 3. Review the fix

The review runs on the pushed commit, beside CI, as the review rules' § Pushing a fix says.
Send the agent that raised the finding (its `specialist`; `security-engineer` for a security finding) the finding verbatim,
the commit (`git show <sha>`), and one question: is it fixed, not fixed, or fixed but broken elsewhere?
Ask for evidence with the answer. Scope the review to the finding and what the fix changed:
"broken elsewhere" means a regression this diff introduced, never an edge case the code had before the fix.
Ask the reviewer to list anything else it notices as a follow-up, with no verdict.

- Follow-ups never start a corrective pass. Each one becomes a new finding for the next `pr-review` round,
  or a new issue through `agent-issue-writer`. The report lists them.

- Fixed: go to step 4.
- Not fixed, or broken elsewhere, after the first pass: run a corrective pass from step 1, a new commit.
- The same after the second pass: set the findings `blocked`, with the reviewer's reason in `note`.
  Ask the user whether the owner reverts the attempt (`git revert <sha>`, pushed) or leaves it for a person to finish.

## 4. Write back

Set each finding of the slice to `fixed`, with the short SHA of its last commit in `commit`.

Write the manifest after each step that changes a status, never once at the end:
a run that stops halfway then leaves a record the next run can resume from.
