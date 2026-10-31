# Review rules

The rules the `pr-review-loop`, `pr-review-fix`, and `autopilot` skills share. Each links here; none keeps a copy.

## Branch preflight

Before triage or any fix on a pull request's branch:

1. Work in the pull request's worktree, on its branch, never on the default branch.
   `git status --porcelain` must be clean or hold only this pull request's work; ask about anything else.
2. `git fetch origin`. When `git status -sb` says the branch has diverged from its remote, it was rewritten upstream:
   ask before anything else.
3. Whoever makes a fix starts with `git pull --ff-only`. Until then the checkout can be behind,
   so triage and search read the fetched head `@{u}`, never the working tree: `git show @{u}:<path>`, `git grep <pattern> @{u}`.

## A ready pull request

A pull request that `autopilot` or the `orchestrator` marked ready in this run gets no more pushes:
report the remaining items as follow-ups for a new pull request, and change nothing on its branch.
Any other ready pull request is worked as a draft is, in a session the Human runs: a person's review usually lands on one.

## Verify the premise

Before a finding gets a fix or reaches the Human as fact, read the code it names at `@{u}`.
A claim that something is missing, such as "no test covers the deny path", is checked with a search, not trusted:
reviewers often miss what sits in another file.
A finding that says a project knowledge doc is wrong is a conflict between two sources, not a verdict: read the passage it
cites once, then fix nothing and report it to the Human as disputed, naming the doc's owner (`harness-librarian`).
A premise that does not hold is `does not apply`, answered with the file and line that show it.

## Fix passes

A finding or a failing check gets at most 2 passes: the fix, and one corrective pass when the review or the check says
it is not fixed or broke something. After the second pass it is `blocked`, with the reason, and goes to the Human.

## Disposition actions

`aidrian pr disposition` gives each finding one action; `--vocab` defines every word.

| Action | Meaning |
| --- | --- |
| `fix_now` | Fixed in this pull request, by its owner. |
| `accepted_residual` | No code fix: a short code comment at the line, and a line in the body's Accepted residuals section. |
| `acceptable_as_is` | No fix: a reply with the reason. |
| `drop_unless_cited` | No fix unless it cites a written project rule: a reply with the reason. |
| `needs_axis` | A person's comment lacks likelihood or affects: set them from the comment and the code, or ask its author. |

## The bot is out

For the whole task once `aidrian pr await-review` reports `no_reviewer` (exit 0; config.json `github.reviewer` is `null`
or `"none"`), `blocked_quota`, or `round_limit`; for one round when it reports `timed_out` after its retry.
Without the bot, review rests on the `pr-review` skill and people's comments, which `pr-review-loop` answers.

## A review round

A round is one review of the current head: the bot's, or the `pr-review` skill's when the bot is out, with every comment
and check it raises answered. config.json `github.maxReviewRounds` (default 3) caps these rounds.
The bot count is another number: `codex_rounds` in the `aidrian pr await-review` JSON counts the bot's reviews on the pull request,
including any before this run. `aidrian pr await-review` holds that count to the same cap and reports `round_limit` (exit 4)
there, which can arrive before the round count reaches it. Only `--round` of `aidrian pr disposition` takes `codex_rounds`.

## Disputes in an unattended run

A disputed finding in an unattended run is parked as a Decision for the Human, with both positions. It is never fixed.
