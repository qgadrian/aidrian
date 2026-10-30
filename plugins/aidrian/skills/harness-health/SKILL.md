---
name: harness-health
description: Read-only harness health check from aidrian report health. The top 3 problems, their numbers, and fixes.
---

# harness-health

Read the harness's own numbers and say what to fix first.
This skill is read-only: it changes no file, config, or threshold. It may capture a lesson for a problem,
and the `lesson-triage` skill decides later what that lesson becomes.

Name both parties as the start hook's `Names:` line does: the human by config.json `names.human`,
yourself by `names.ai` or the host's name. Never write "you" or "me" in the report or in a lesson.

## 1. Read

```bash
aidrian report health --json
```

The window is the last 30 days; `--since 60d` widens it. `--prs N` reads N merged pull requests, 20 by default,
and `--project <dir>` reads another project than the current folder. The output has:

- `problems`, ranked worst first. Each has `kind`; `subject`, the agent, doc, or rule, or null; `value` and `threshold`;
  `sample`, its `n` and what it counts; `summary`, one sentence with the numbers; `fix`, a row of the table in step 3;
  `lesson`, the labels for a lesson, or null when the problem is a lesson already;
  and `resolved` and `since_resolution`, null unless a resolved lesson holds `lesson.key` (step 4).
- `signals`: the knowledge budget, doc reads, agents, reviews, hook denies, session cost, and lessons,
  each with its `status` (`ok`, `problem`, `not_enough_data`, or `unavailable`) and its sample.
- `thresholds`: the limits used. `thresholds.health.minSample` is the smallest sample a signal is judged on;
  config.json `telemetry.health` sets them.
- `coverage`: what the log cannot see, such as doc reads turned off.

## 2. Explain the top 3

Take the first three `problems`, in their order. For each, write:

- what is wrong, in plain words, with `value`, `threshold`, and `sample.n` and what it counts;
- what it costs: work blocked or lost, context every agent pays for, or a task done twice;
- the fix from the table in step 3, and who acts on it.

Never re-rank them, merge two into one, or add a problem the list does not have.
With more than three, say how many more there are and stop. With none, say so in one line.

Then, in one line, name the signals whose status is `not_enough_data`, with their `sample.n` against the minimum,
and those `unavailable`, with their `error`. Such a signal is neither a problem nor healthy: never guess which way it leans.
When `coverage` reports a switch off or a partial window, say so once; it explains a missing number.

## 3. Fix table

Each problem's fix is the row its `fix` names, never another.
Agents are named as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.

| Fix | Problems | What to do |
| --- | --- | --- |
| `lesson-triage` | A P1 lesson, a fix that recurred, or an inbox past `lessons.maxOpen` or `lessons.maxAgeDays` | Run the `lesson-triage` skill in a session opened for it. |
| `split-doc` | The `always` docs over budget, a tagged doc over `taggedDocBytes`, one doc taking most of the bytes read, or a tagged doc nobody read | `harness-librarian` splits the doc into a short rule card and a reference, or drops its tags so that only search finds it. |
| `agent-prompt` | An agent re-dispatched, or sent back by the delivery check, too often | `harness-mechanic` reviews that agent's prompt when it is a plugin agent (`lesson.target` is `plugin`); a project's own agent goes to the agent that owns its file. |
| `deny-rule` | One of the plugin's rules blocking again and again | Check the rule against what the agents tried, which `aidrian report` shows as its most frequent match: reword the rule's message or the blocked agent's instructions, or capture a lesson. |
| `round-cap` | Many review rounds a pull request, or late findings on lines the bot had already reviewed | Check the review-round cap, config.json `github.maxReviewRounds`, which the `orchestration` and `autopilot` skills read. |
| `cost` | The cost a session rising | Name the costly sessions with `aidrian report sessions`, with their main conversation against subagent split, and capture a lesson. |

## 4. Capture lessons

Offer the Human a lesson for each of the top three problems whose `lesson` is not null, and capture only those accepted.
First run `aidrian lesson list --json`: skip a problem whose `lesson.key` an open lesson already holds.

A problem whose `resolved` is set has a fixed lesson with that key, and its window can hold the failures that led to the fix.
Its `since_resolution` judges the same problem on the evidence dated after `resolved.at` alone, by its `status`:

- `problem`: the fix did not hold. Capture it if accepted; it reopens the lesson, so say so.
- `not_enough_data` or `unavailable`: neither offer nor capture. Say "resolved on <the date of `resolved.at`>; recheck after more data".
- `ok`: neither offer nor capture. Say it was resolved on that date and is within its threshold on the `since_resolution.n` samples since.

Capture each accepted lesson with:

```bash
aidrian lesson add --tier <lesson.tier> --kind <lesson.kind> --target <lesson.target> --key '<lesson.key>' <<'LESSON'
evidence: aidrian report health --since <window>
<the problem's summary>
<value, threshold, sample.n and what it counts, and the fix row>
LESSON
```

Leave out `--kind` or `--target` when its value is null. The note travels on stdin through the quoted heredoc, as the `lesson` skill does.

## 5. Report

To the Human, in this order: the window and any coverage gap, in one line; the top three problems as in step 2;
how many more there are; the signals with not enough data; and the ids of the lessons captured.

## Rules

- Read-only. Never edit config, docs, agents, skills, or hooks, and never change `telemetry.health` to clear a problem.
- Every number comes from the report, with its sample. Never estimate one.
- Recommend only from the fix table. Fixing is for the owner the table names, after `lesson-triage` or the Human decides.
