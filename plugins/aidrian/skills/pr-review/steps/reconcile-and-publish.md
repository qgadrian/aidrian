# Reconcile and publish

Read this file when the first agent returns. Start merging once every agent of the round has returned.

## 1. Merge

- The same file, overlapping lines, and the same root cause make one finding.
  Keep the axes of the agent whose area it is, and name both agents in `specialist`.
- Two agents who disagree about the same behaviour at the same place make one finding with status `disputed`,
  both positions in `summary`. Put it to the user, even in an unattended run; never pick a side or average them.
- A finding in code the pull request did not change gets status `pre_existing`: it is reported, and fixed in a later change.
- Only `security-engineer` may drop or downgrade a security finding.
- On a re-review, a finding its agent confirms fixed becomes `resolved`, and one it finds still there goes back to `open`.
  A new finding that matches an open one by file and summary is that finding, not a new one.

## 2. Verdicts

For each new finding:

```bash
aidrian pr disposition --severity <s> --likelihood <l> --affects <a> [--cost <c>]
```

Store its `disposition`. The table behind it does the weighing: a critical finding is always fixed,
a contrived one becomes an accepted residual, and a low one is reported only when it cites a project rule.

## 3. Order

Sort so the first row is the first thing to fix: by disposition (`fix_now`, `accepted_residual`, `drop_unless_cited`, `acceptable_as_is`),
then severity (critical to low), then likelihood (routine to contrived).

## 4. Manifest

Write the round as `references/manifest.md` says: new findings with status `open` and the next free ids,
the changed statuses, `round` raised by one, and this round's `head_sha` and `base_sha`.

## 5. Comment

Skip this step with `--no-comment`. Otherwise one comment per pull request carries the latest round.
Its first line is the marker `<!-- aidrian:pr-review -->`. Write the body to `<state>/tmp/pr-<n>-review.md`:

```md
<!-- aidrian:pr-review -->
## Review, round <r>, head <head_sha, 7>

**Verdict: <verdict line>**

| # | Verdict | Severity | Likelihood | Affects | Location | Finding | Agent |
| --- | --- | --- | --- | --- | --- | --- | --- |
| F3 | fix_now | high | routine | users | `src/cart.js:42` | <summary> | code-reviewer |

**Accepted residuals:** <id, location, and in one line why a fix is not worth it now>, each.
**Disputed, needs a decision:** <id and both positions>, each.
**Not introduced here:** <id and summary>, each.
**Resolved since the last round:** <ids>.

Reviewed by <agents>. Regression check clean on <n> files. Not reviewed: <each left-out file and why>.
```

- The table lists `fix_now` findings whose status is `open` or `blocked`.
  `drop_unless_cited` findings that cite no project rule, and `acceptable_as_is` findings, are counted in one line under it, not listed.
- Leave out each bold line that would be empty.
- The verdict line: `changes needed, <a> to fix now` while the table has a row;
  `decision needed, <d> disputed` while a disputed one exists (both parts when both hold); otherwise `no blocking findings`.
  From round 2, start it with "<r> resolved, <o> still open, <n> new."

Find the comment of an earlier round, then update it or post a new one:

```bash
gh api --paginate repos/{owner}/{repo}/issues/<n>/comments \
  --jq '.[] | select(.body | startswith("<!-- aidrian:pr-review -->")) | .id'
gh api -X PATCH repos/{owner}/{repo}/issues/comments/<id> -F body=@<file>      # when an id came back
gh api repos/{owner}/{repo}/issues/<n>/comments -F body=@<file> --jq .id        # otherwise
```

Check the response. Store the id in the manifest's `comment_id`. A failed post means nothing was published: say so.

## 6. Close

The review is `done` only when:

- every agent of the plan returned, and each modified, renamed, or removed file it had has a finding or a clean line;
- every gate ran: a `security-engineer` verdict on its files, and a `product-manager` `sign_off` for each critical flow;
- every disputed finding was put to the user;
- the manifest holds this round, and the comment was posted or `--no-comment` was given.

Otherwise report `needs_input` while a dispute waits, or `blocked` with the step that failed and how to resume.

Report in chat: the scope, the plan with the reason for each agent, the comment body, the manifest path,
and the next step: the `pr-review-fix` skill fixes the `fix_now` findings, and running this skill again confirms them.
