# Phases

Read at the start of an autopilot run. Each phase names the skill that does the work.
Follow that skill as written, with the autopilot `SKILL.md` § Who decides in place of each question it would ask the Human.

The bounds compose: the implementing skill's own per-slice fix cap holds inside phase 1,
and config.json `github.maxReviewRounds`, the `orchestration` skill's round cap, bounds phase 3.

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

1. Leave the pull request a draft. Mark it ready with `gh pr ready <n>` only when the Human asked for that at launch,
   the loop ended at sign-off, and `aidrian pr checks <n>` says ready. Pending or failing: leave it a draft and say why.
   After `gh pr ready`, push nothing more: a later finding belongs in a new pull request.
2. Never merge.
3. Write the last checkpoint when allowed, then the report of `SKILL.md` § Report.
