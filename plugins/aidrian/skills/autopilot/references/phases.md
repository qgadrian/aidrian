# Phases

Read at the start of an autopilot run. Each phase names the skill that does the work.
Follow that skill as written, with the autopilot `SKILL.md` § Who decides in place of each question it would ask the Human.

The bounds compose: the implementing skill's own per-slice fix cap holds inside phase 1,
and config.json `github.maxReviewRounds`, the `orchestration` skill's round cap, bounds phase 3.

## Bounds

- **Review rounds**: the `orchestration` skill § 3 stop rule, the one rule this run stops by, at most config.json
  `github.maxReviewRounds` rounds as the review rules count them, unless the Human set another number at launch,
  plus an extra round `github.extraRounds: "auto"` grants at the cap.
- **No rare edge cases.** End the loop early once a review of the current head leaves every open finding `accepted_residual`,
  `acceptable_as_is`, or `drop_unless_cited` by `aidrian pr disposition`. Reply with the reason; resolve only the bot's threads.
  A round that pushed a fix has not reached that point: the next round reviews the new head.
- **The bot is asked at most once per round** through `aidrian pr await-review`, and never once it is out,
  as the review rules define it. Its state is recorded every round.
- **Fix passes**: the review rules' cap of 2 per finding or failing check; then it is parked. An agent blocked twice is parked too.

## Product decisions

A `product` or `ux` decision takes the route of `knowledge/references/decisions.md` § Hard product calls, with the Human away.
With `autoStart` off, `as-today` keeps `unattended` as ever, on a hard call too.
With `autoStart` on, only the small, clear row follows `unattended`, as § Who decides says of `ask`.

- Count this session's automatic runs, for the route. A hard call past `quorum.product.maxAutoRuns` is parked with no quorum.
- `quorum` runs the `quorum` skill's product mode in this session. One run can spend 22 dispatches.
- When the route waits, the ledger stays deferred, the question goes in the report with the recommendation and the simulated-user caveat,
  or that no end user took part,
  and independent work continues.
  Its dependent work is parked.
- When the route continues, follow that file's continue path, and record the `decided_provisional` in the report, with the ledger's path.

## 1. Implement

Pick the engine by the input:

| Input | Engine |
| --- | --- |
| An issue key or URL | the `issue-implement` skill on the issue |
| A plan path whose frontmatter has `issue_id` or `issue_ref` | the `issue-implement` skill on that issue |
| Any other plan path | the `plan-implement` skill on the plan |
| A one-line task | `planning-agent` writes a plan, then the `plan-implement` skill runs it |

- **A one-line task.** Dispatch `planning-agent` in the foreground with the task, the Human's launch words,
  and the path `<state>/plans/<slug>-plan.md`, where `<state>` is the folder `aidrian state` prints
  and `<slug>` is the task in a few lowercase words joined by `-`.
  A plan that comes back `open-questions` or `blocked` leaves nothing to implement: park its questions and stop.
- **An issue-anchored plan.** `plan-implement` stops on one, so read the plan's frontmatter before picking the engine.
  Run `issue-implement` on its `issue_id`, else its `issue_ref`. That skill's phase 0 reads the plan only at
  `<state>/plans/<key>-implementation.md` (the `planning-agent` skill's `references/plan-file.md`): a plan at another path is not the one it would run, so stop.
- **Workspace.** The current checkout when it is a task worktree on the task's branch; otherwise the engine creates one
  through the `orchestration` skill § 1. The launch approves a new branch, so the `worktree-new` skill's question is answered
  for `branch_mode: new`. Its question about reusing an existing branch, and the question about changes in the main checkout,
  are not: stop, since no work can start without a workspace.
- The engine's slice plan, per-slice review, verification, and one commit per slice all hold.
  A "stop and ask" inside it becomes park and go on; when it leaves no independent slice, the engine stops and so does the run.

## 2. The draft pull request

The engine's last phase opens it through the `pr-write` skill. Ask for a draft, even when the Human wants it ready in the end:
§ 4 marks it ready.
An engine that stops before that phase leaves no pull request, because its gates refuse one with a slice missing.
Report what is committed, and stop.
Record the pull request's number, link, and head commit.
Then, before round 1, run its product feedback step: the `pr-product-feedback` skill's `references/in-a-flow.md`
§ After the draft opens. Its `fix-now` items are findings of round 1, and step 3 routes them. Ask the Human nothing:
each open product choice is a Decision for the Human.

## 3. Review rounds

Up to config.json `github.maxReviewRounds` rounds, or the number the Human set at launch. Each round:

1. **Bot review.** Run the `pr-review-loop` skill on the pull request with `--await-codex`; once the bot is out, without it.
   Record the state its step 1 reports from `aidrian pr await-review`.

   | Exit | State | In this run |
   | --- | --- | --- |
   | 0 | `received` or `already_present` | the loop triages it with the other comments |
   | 0 | `no_reviewer` | no bot: config.json `github.reviewer` is `null` or `"none"`. Ask no more; the `pr-review` skill runs every round |
   | 2 | `timed_out` | after the loop's single retry, record `timed_out`; the `pr-review` skill runs this round |
   | 3 | `blocked_quota` | ask the bot no more in this run; the `pr-review` skill runs this round and each later one |
   | 4 | `round_limit` | the same. The loop's question about raising `--max-rounds` is the Human's: record it, never raise it (the command refuses without `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`) |
   | 10 | `extension_check` | at the cap: run the judge it dispatches and record its verdict, as the loop's `references/review-plan.md` § At the cap says |
   | 11 | `extension_ask` | the judge says one more round, and only the Human grants it: park it as a Decision for the Human, with the judge's evidence; the bot is out for this run |

2. **Specialist review.** Run the `pr-review` skill when `--full-review` is set, when the bot is out this round, as the
   `orchestration` skill's `references/review-rules.md` defines it, or in round 1 when the branch has more than one slice, as that section says.
   Skip that round-1 run when the engine's integration review already ran `pr-review` on the current head.
   Its findings go through the `pr-review-fix` skill.
3. **Findings.** Every finding from either skill goes through the `orchestration` skill § 4: `aidrian pr disposition` gives
   its verdict, and each `fix_now` goes to its owner, highest likelihood × impact first.
4. **Rare edge cases.** A finding whose verdict is `accepted_residual`, `acceptable_as_is`, or `drop_unless_cited` is not fixed.
   Reply on its thread with the reason, in the `pr-review-loop` skill's reply shapes. Resolve a bot's thread;
   a person's thread stays open for its author.
   An `accepted_residual` also goes in the pull request body through the `pr-write` skill, with a code comment.
   A comment that does not apply at all is not a rare edge case: its thread stays open with the evidence, as the loop says.
5. **Push.** The agent that made each fix commits and pushes it. Confirm the remote has the new head with
   `git ls-remote --heads origin <branch>`, then checkpoint as `SKILL.md` § Checkpoints allows.

## 4. Stop at sign-off

The loop ends at the first of these:

- **Sign-off**: the `orchestration` skill § 3 stop rule: a round's review of the current head finds no `fix_now`,
  and `aidrian pr checks <n>` is not failing, so the round pushes no fix: nothing is open, or every open finding is a rare edge case.
  A round that pushes a fix moves the head, and no review has seen the new one: run the next round on it.
  The code comment an `accepted_residual` gets is not a fix.
- **The cap**: the last round ends with `fix_now` findings open, or with fixes pushed that no review has seen.
  List both in the report, and start no further round.
- **A stop** from `SKILL.md` § Stop.

Then:

1. Leave the pull request a draft. Mark it ready only when config.json `github.markReady` is `"auto"`,
   the default, or the Human asked for that at launch, the loop ended at sign-off, and `aidrian pr checks <n>` says ready.
   Then run `aidrian pr product-feedback status <n>`, and the re-check when only that is owed, by that file's
   § Before `gh pr ready`. On exit 0, mark it ready with `gh pr ready <n>`.
   Pending, failing, or any other exit: leave it a draft and say why. The report lists each owed item with its command,
   and each open product choice as a Decision for the Human.
   After `gh pr ready`, push nothing more: a later finding belongs in a new pull request.
2. Once step 1 marked it ready in this run, run the `pr-auto-merge` skill.
   Keep the line it stops on for the report. Merge only through that step, never otherwise.
3. Write the last checkpoint when allowed, then the report of `SKILL.md` § Report.
