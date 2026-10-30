---
name: autopilot
description: Run one issue, plan, or task unattended to a reviewed draft pull request, then report. Never merges.
disable-model-invocation: true
---

# autopilot

Take one task from implementation to a reviewed draft pull request while the Human is away, then stop and report.
This skill runs other skills and adds two things: what to do with a decision nobody is there to make, and a bound on the review loop.
It never redoes what the skills it runs already do.

Before you start, follow the `knowledge` skill. Load your `product_sensitive` docs for the flows the project declares critical.
Load the `orchestration` skill too: it owns the worktree, the pull request, and review findings.

## Inputs

```text
<task> [--base <branch>] [--full-review] [--handoff]
```

- `<task>`: an issue key or URL, a plan path, or a one-line task description.
  Missing or unclear: ask now, while the Human is here. Never guess the task.
- `--base`: the branch the pull request targets. Default: the one the implementing skill picks.
- `--full-review`: run the `pr-review` skill in every review round, not only when `references/phases.md` § 3 calls for it.
- `--handoff`: write a handoff brief at each checkpoint, as § Checkpoints says.

## What it is, and is not

- It is a bounded runner: implementation, a draft pull request, review rounds, and a report. It cannot loop forever.
- It is not a merge tool. Merging needs the Human's explicit say-so and the `pr-merge-when-green` skill, which only the Human starts.
- It is not an interview. Questions need the Human present, so settle them before launch.

## Before launch

While the Human is still here:

- A vague or large task: run the `challenge` skill first, or the `plan-review` skill on an existing plan.
- Best: launch from the task worktree, already created, so the run never has to ask about one.
- Record what the Human says at launch word for word, such as "skip the end-to-end run" or "five review rounds".

## Who decides

Launching this skill authorizes the run to continue alone through routine work: slice plans, dispatches, verification,
the pull request, and review fixes.

1. **The Human's explicit instructions win** over this skill's defaults and over the process of the skills it runs.
   Only the hard rules below do not yield.
2. **A critical decision**, such as an open product trade-off, an architecture choice with lasting effects, a trust-boundary
   question, a risky refactor, or scope growth: never guess anything that cannot be undone.
   With a clearly safe default that can be undone, take it and flag it in the report.
   Otherwise park it: record it with its options and the safest recommendation, and go on with all work that does not depend on it.
3. **Mandatory gates stay.** A critical-flow `product-manager` sign-off and a `security-engineer` verdict still block their work.
   Never approve one yourself: park it.
4. **A "stop and ask"** in a skill this run uses becomes park and go on. When nothing independent is left, stop.

## Checkpoints

A handoff brief lets a fresh session resume the run. Write one only when the Human allowed it:
`--handoff`, the launch words, or config.json `session.handoff` set to `"auto"`.
With `"ask"`, the default, or `"off"`, write none: the report carries what a resume needs.

When allowed, write it with the `session-handoff` skill, in this session and never through an agent, which knows nothing of the run.
Checkpoint after the implementation is committed, after the draft opens, after each review round, and at any stop, before the report.
Fold each parked decision and each finding left open into the brief as it arises. A failed write never blocks the run.

## Phases

Read `references/phases.md` at the start, and follow it.

1. Implement, to committed work on the task branch.
2. Open the draft pull request through the `pr-write` skill.
3. Review rounds: the bot review, when the project has a bot, through the `pr-review-loop` skill,
   and the `pr-review` skill when the phase says so.
4. Stop at sign-off, or at a bound.

## Bounds

- **Review rounds**: the `orchestration` skill § 3 stop rule, at most config.json `github.maxReviewRounds`,
  unless the Human set another number at launch.
- **No rare edge cases.** End the loop early once a review of the current head leaves every open finding `accepted_residual`,
  `acceptable_as_is`, or `drop_unless_cited` by `aidrian pr disposition`, and close their threads with the reason.
  A round that pushed a fix has not reached that point: the next round reviews the new head.
- **The bot is asked at most once per round** through `aidrian pr await-review`, and never once it is out,
  as the `orchestration` skill § 3 defines it. Its state is recorded every round.
- **One informed retry.** An agent blocked twice on the same work, or a check still failing after one informed fix, is parked.

## Stop

Stop, park the rest, and report when: a parked decision blocks all remaining work; repository, GitHub, tracker,
or agent access is missing; the main checkout holds unrelated changes and no task worktree exists;
the task collides with its stated non-goals; or a push is rejected.
Write the brief first when checkpoints are allowed.

## Hard rules

1. Never merge: no `gh pr merge`, and never the `pr-merge-when-green` skill.
2. Leave the pull request a draft, unless the Human asked at launch to mark it ready; § 4 of the phases says when.
3. Never approve a product or security gate yourself, and never guess a critical decision that cannot be undone.
4. Every edit happens in a task worktree, never in the main checkout. Never bypass a hook.
5. Coordinate only: agents write the code, review it, and verify it.

## Report

Write for a reader who saw nothing of the run: plain words, no internal labels, and the Human and the AI named
by the names the start hook gives, never "you" or "I". In this order:

1. **What shipped**: one or two lines, and the pull request link.
2. **Checks**: verification and CI status, and the bot review state of each round:
   `received`, `already_present`, `timed_out`, `blocked_quota`, `round_limit`, or `no_reviewer`.
3. **Decisions for the Human**: each parked decision, with its options and the safest recommendation.
4. **Left open**: findings closed as rare edge cases, each with its reason, findings still open at the cap,
   and fixes the last round pushed that no review has seen.
5. **Next**: when a brief was written, its path and the resume line the `session-handoff` skill prints;
   otherwise the next action, such as a review by the Human or the `pr-merge-when-green` skill.
