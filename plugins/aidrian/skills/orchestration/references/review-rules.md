# Review rules

The rules the `pr-review-loop`, `pr-review-fix`, and `autopilot` skills share;
`issue-implement` and `plan-implement` cite § A closure criterion proven elsewhere. Each links here; none keeps a copy.

## Branch preflight

Before triage or any fix on a pull request's branch:

1. Work in the pull request's worktree, on its branch, never on the default branch.
   `git status --porcelain` must be clean or hold only this pull request's work; ask about anything else.
2. `git fetch origin`. When `git status -sb` says the branch has diverged from its remote, it was rewritten upstream:
   ask before anything else.
3. Whoever makes a fix starts with `git pull --ff-only`. Until then the checkout can be behind,
   so triage and search read the fetched head `@{u}`, never the working tree: `git show @{u}:<path>`, `git grep <pattern> @{u}`.

## A ready pull request

A pull request that `autopilot`, the `orchestrator`, or `pr-review-loop` marked ready in this run gets no more pushes:
report the remaining items as follow-ups for a new pull request, and change nothing on its branch.
Any other ready pull request is worked as a draft is, in a session the Human runs: a person's review usually lands on one.

## Verify the premise

Before a finding gets a fix or reaches the Human as fact, read the code it names at `@{u}`.
A claim that something is missing, such as "no test covers the deny path", is checked with a search, not trusted:
reviewers often miss what sits in another file.
A finding that says a project knowledge doc is wrong is a conflict between two sources, not a verdict: read the passage it
cites once, then fix nothing and report it to the Human as disputed, naming the doc's owner (`harness-librarian`).
A premise that does not hold is `does not apply`, answered with the file and line that show it.

## Check the proposed fix

A true premise does not make the reviewer's fix safe. Before a fix goes to its owner, compare what it would change with:

- each condition an approval or sign-off on this pull request set, and each flow invariant in the review record;
- each fix brief, verdict, and decision of an earlier round on this pull request;
- the test it touches: a suggested test change must still fail on the mistake the test catches.
  The owner's brief asks for the proof: with the change in place, put that mistake back in the code under test,
  see the test fail by assertion, undo only that edit, and report both runs.

A fix that would weaken any of these is a conflict, not a `fix_now`: send it, with both sources, to the agent that set
the condition or made the decision, such as `product-manager` for a product condition or `security-engineer` for a
security one, and fix nothing until that agent answers. If it keeps its position, the finding is disputed.
A fix that changes a slice's closure criterion follows § A closure criterion proven elsewhere:
the Human approving a plan does not make the Human the owner of how it is proven.
Set `affects` from what the fix puts at risk as well as what the finding describes, and use the higher one:
a bot or engine finding carries only a severity, so its other axes are yours to set.

## A closure criterion proven elsewhere

A review finding can show a slice's closure criterion unmet as written while other tests already prove the behaviour it names.
The coordinating session settles it; it is not a question for the Human.
It covers a slice's closure criteria only: an issue's acceptance criteria and non-goals, and a plan's declared acceptance criteria,
never change here, and a finding that would change them is a `scope_collision`.

- **The default.** A finding with no `plan_change`, a `plan_change` with any condition below unmet, or a coordinator who doubts
  the reviewer's `kind`: the slice keeps its criterion, and the developer meets it as written.
- **`proof`**: the coordinating session decides it when every condition holds:
  - `existing_tests` names at least one committed test that uses no test double for any component the criterion names;
  - `break` changes the behaviour the criterion names, in production code and never in a test, and leaves every module loading;
  - in the fix pass already under way, within its round cap, the developer applied `break` and every test in `existing_tests` failed
    by assertion; a suite that failed to load rejects the run;
  - the developer undid only the `break` edit, never with checkout, restore, or stash on a slice file, reran `existing_tests` green,
    and showed in `commands_run` the same slice hash before the break and after the undo: `git diff <slice base> | git hash-object --stdin`,
    and `git hash-object` on each file `git ls-files --others --exclude-standard` lists;
  - on a slice that touches a critical flow or had a security review, its gate owner, `product-manager` or `security-engineer`,
    answered fresh, dispatched with the `plan_change` and the break run: from `product-manager`, every `critical_flow[].sign_off`
    for the flows the slice touches is `approved`; from `security-engineer`, `sign_off` is `approved` with no security `fix_now` open.
- **`promise`**: a finding or fix proposes dropping or changing behaviour, or a parity row or non-goal of a plan with no issue.
  A proof that fails a condition above is not a `promise`: the default applies.
  `product-manager` returns `decision_options`, and `knowledge/references/decisions.md` routes it.
- **Record.** One `planning-agent` dispatch writes the change with all its evidence, and in the same write adds any evidence
  in a later slice to that slice's closure criteria, so the run cannot close without it.
  The change counts as made only once the reread plan shows both. Its revision history entry credits whoever decided it:
  the coordinating session for `proof`, the decision's owner for `promise`.
  The next `pr-write` run lists it, a pull request update included.

## Fix passes

A finding or a failing check gets at most 2 passes: the fix, and one corrective pass when the review or the check says
it is not fixed or broke something. After the second pass it is `blocked`, with the reason, and goes to the Human.

## Proportion

Fix every finding a review identified; never leave one silently open. Do not go hunting for new ones.

- A finding blocks the pull request only when it breaks a path real sessions take: the skill's own steps, a direct
  command, or a checkout the project uses. One that needs a contrived race or a hypothetical setup is fixed in the same
  commit when it is small, and otherwise is `accepted_residual`, named in the body.
- Each round's findings get one fix pass. Add no hardening, check, or config that no review found.
- When the fixes since round 1 pass half of what the pull request first added, or a finding comes back at a spot already
  fixed, stop before the next pass and ask the Human whether the rest is worth its cost.

## Disposition actions

`aidrian pr disposition` gives each finding one action; `--vocab` defines every word.

| Action | Meaning |
| --- | --- |
| `fix_now` | Fixed in this pull request, by its owner. |
| `accepted_residual` | No code fix: a short code comment at the line, and a line in the body's Accepted residuals section, through the `pr-write` skill. |
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
there, which can arrive before the round count reaches it. `--round` of `aidrian pr disposition` takes the review round the finding arrived in: `round` of `aidrian pr review`, or `codex_rounds` for the bot's own comments.

At the cap, with config.json `github.extraRounds` on, `aidrian pr await-review --request` and `aidrian pr review` may
return `extension_check` (exit 10) or `extension_ask` (exit 11) instead of `round_limit`. Run the judge the status
dispatches, or ask the Human its question, as the `pr-review-loop` skill's `references/review-plan.md`
§ At the cap says. A granted round raises the cap by one, for one round; the next cap checks again.

## Disputes in an unattended run

A disputed finding in an unattended run is parked as a Decision for the Human, with both positions. It is never fixed.
