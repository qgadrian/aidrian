---
name: pr-review-loop
description: Answer every review comment on a GitHub pull request with a verified fix or evidence. --await-codex awaits the bot.
---

# pr-review-loop

Take every review item on a pull request to a verified outcome: fixed and replied to, or answered with evidence.
The argument is a pull request number or URL; without one, use the current branch's (`gh pr view --json number,url`).

Before you start, follow the `knowledge` skill. Load your `testing` docs for the commands that verify a fix,
and `product_sensitive` docs when a comment touches what users see, money, or data.

## 0. Preflight

- `git rev-parse --is-inside-work-tree` and `gh auth status` must pass; otherwise stop and say which.
- Run the branch preflight of the `orchestration` skill's `references/review-rules.md`.
  Its § A ready pull request says when a ready pull request stops after the triage in step 3.
  Its other sections define the fix-pass cap, the disposition actions, when the bot is out, and a review round.

## 1. Await the bot review (`--await-codex`)

```bash
aidrian pr await-review <n> --request     # waits up to 14 minutes; give the shell call a 15-minute timeout
```

| Exit | Status | Next |
| --- | --- | --- |
| 0 | `received` or `already_present` | collect it with the rest |
| 0 | `no_reviewer` | the project has no review bot, and nothing was posted: record `bot review: none` |
| 2 | `timed_out` | with `retry_recommended: true`, run it once more without `--request`; otherwise record `bot review: not received` |
| 3 | `blocked_quota` | record `bot review: blocked_quota` and go on with the other comments |
| 4 | `round_limit` | the review-round cap, config.json `github.maxReviewRounds`: stop and ask the Human to raise `--max-rounds`, redesign, or stop |
| 5 | `review_required` | the [review gate](#review-gate): nothing was posted; run the review it names, then this step again |

### Review gate

With config.json `github.reviewGate.enabled`, the bot is asked only once a review of the whole diff is on record.
Dispatch one read-only reviewer that did not write the change, such as the `code-reviewer` agent, with the diff and
config.json `github.reviewGate.checklist` when set. Fix what it finds, then record it once per pull request:
`aidrian pr attest <n> --head <sha> --reviewer <agent> --findings <n> --fixed <n>`.
`--request` then carries the marker by itself; never post a second request by hand.

A `thumbs_up` signal with no other comments and green checks means nothing to address: report it in one line.

## 2. Collect every review surface

Paginate everything; review threads often pass one page.

```bash
gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments    # inline comments
gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews     # review summaries
gh api --paginate repos/{owner}/{repo}/issues/<n>/comments   # conversation comments
aidrian pr checks <n>                                        # one line: ready, failing, or pending
```

For thread state, query `reviewThreads` with `isResolved` and `isOutdated` through `gh api graphql`, and skip
resolved threads. A failing check is a review item too.

## 3. Triage

One row per item:

```text
| # | Source | Severity | Location | Summary | Verdict | Evidence | Action |
```

- **Source**: `inline`, `review-summary`, `comment`, or `check`, and its author: the bot, config.json `github.reviewer`, or a person.
  A person's comment weighs more than a bot's; validate every bot comment before acting on it.
- **Verdict**: `applies`, `partly applies`, `does not apply`, `already handled`, or `needs evidence`.
  An inline comment whose code changed since it was posted (`git log <commit_id>..@{u} -- <path>`) is a candidate
  for `already handled`: read the code at `@{u}` before you decide.
- **Action** comes from the disposition table, never from severity alone:

  ```bash
  aidrian pr disposition --severity <s> --likelihood <l> --affects <a> [--cost <c>] [--source bot --round <codex_rounds>]
  ```

  Add `--source bot --round <codex_rounds>` for the bot's comments only, where `<codex_rounds>` is the `codex_rounds`
  field of step 1's `aidrian pr await-review` JSON. A person's comment omits both, and so does every comment
  in a run without `--await-codex`. The review rules define each action.
- When a comment contradicts a project knowledge doc, the doc wins: reply with the citation and leave the thread open.

## 4. Fix every copy of the mistake

A comment names one place; the bot reports the other copies one round at a time.
For each finding, search the pull request's changed files, and the code they call or are called by, for the same
mistake, and fix every copy in the same commit. A copy outside the pull request's scope becomes a follow-up note.

Pick each fix's owner by the `knowledge` skill's agent rule, and give it its files and findings.
A session the Human runs directly may make a fix itself; under the `orchestrator`, every fix goes to an owner.
In one worktree, one fixing agent works at a time. Each finding gets at most 2 fix passes, as the review rules say.
Fix the root cause the comment points at, not its literal wording, and nothing unrelated.

## 5. Verify and commit

The agent that made the fix verifies, commits, and pushes it, then returns the SHAs:

- Run the checks the project's `testing` knowledge names for the touched files, and a new or updated test for every
  behaviour change. A behaviour change without a test change is not done.
- One Conventional Commits commit per finding or tight group. Never bypass a hook; a failing hook is a verdict.
- Push. Then confirm with `git ls-remote --heads origin <branch>` that every SHA a reply will cite is on the remote.

## 6. Reply

- Inline thread: reply through `gh api repos/{owner}/{repo}/pulls/<n>/comments/<id>/replies -f body=...`.
  Resolve a bot's thread with the `resolveReviewThread` GraphQL mutation when the fix addressed it.
  A person's thread gets the reply and stays open: its author resolves it.
- Review summary or conversation comment: one conversation comment that names the SHA.
- Check the response of every post. A failed post means the thread is not addressed; say so in the summary.
- A thread that does not apply gets the evidence and stays open for the reviewer to confirm.

Reply shapes:

```text
Addressed in <sha>: <one line>.
Not applicable: <evidence>. Leaving this open for you to confirm.
Already handled in <sha>.
Conflicts with <doc path>: <one-line citation>. Open to discussion.
Accepted residual: <why the fix is not worth it now>; marked in <path>.
```

## 7. Summary

Report, in this order: the triage table; what changed per file with its triage numbers; the exact verification
commands with pass or fail; the replies posted, and any that failed; and a sign-off naming the addressed,
not applicable, accepted, and blocked rows, the residual risks, and whether the pull request is ready for another review.
On a draft, report convergence only: the author marks it ready.
