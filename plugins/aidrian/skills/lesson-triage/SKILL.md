---
name: lesson-triage
description: Drain the lesson inbox worst first, routing each lesson to a fix, an issue, a merge, or a rejection.
disable-model-invocation: true
---

# lesson-triage

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`, `issue_tracker`.

Turn captured lessons into work, one batch at a time, worst first.
Run this in its own session: it reads docs, searches, and hands work on, the cost the `lesson` skill keeps out of a task session.

## 1. Read

```bash
aidrian lesson stats
aidrian lesson list --json --limit 10
```

`stats` gives the open count by tier and the recent fixes. The list is the batch, already in triage order: tier, then age.
Each row has `id`, `title`, `note`, `tier`, `kind`, `target`, `evidence`, `seen`, the last `occurrences`, `similar`,
`session`, and `agent`. Read the evidence before you decide anything.

- `reopened` above 0 means a fix did not hold: read its `resolutions` before anything else.
- `source: auto` is a lesson the plugin recorded itself; its `key` names the signal, such as `delivery-check:<agent>`.
- `seen` above 1 makes a P2 or P3 worth more: the same cost, paid again each time.

When nothing is open, go to step 5.

## 2. Dedupe

`similar` lists lessons whose words match. Read their titles with `aidrian lesson list <id>`.
Merge each true duplicate into the lesson with more evidence, usually the older one:

```bash
aidrian lesson resolve <id> --outcome merged --link <other id>
```

Then look for existing work with two to five plain words you choose that name the problem,
never a pasted command, path, or error text. Single-quote the words on every command line.

- Project knowledge: `aidrian-knowledge search '<words>'`, for a doc that already states the rule.
- The repository: `git grep -n -i '<words>'`, for a hook, script, or check that already covers it.
- The tracker, as the project's `issue_tracker` knowledge describes it, open and recently closed issues,
  and `gh pr list --state all --limit 20 --search '<words>'`.

An issue that already covers the lesson is its `issue` outcome, linked to it. A partial match extends that issue; it never opens a sibling.

## 3. Decide

Fix a wrong label first: `aidrian lesson update <id> --tier P1 --target plugin`.
Then pick one end per lesson:

| End | When | Owner | Outcome |
| --- | --- | --- | --- |
| Fix now | One change catches it every time, or states the rule once | `target: plugin`: `harness-mechanic`. `target: project`, knowledge: `harness-librarian`; code or config: the agent that owns that code | `mechanism` or `rule` |
| Issue | Bigger than one change, or it changes what users see | the `agent-issue-writer` skill; the project's product owner first when users see it | `issue` |
| Merge | Another lesson is the same problem | step 2 | `merged` |
| Reject | Specific to one session, already fixed, or not worth its cost | the reason | `rejected` |

- Prefer a mechanism: a script, check, or hook catches it every time. Before you choose `rule`, say why it cannot be a mechanism.
- A rule goes into the knowledge doc that owns the topic; find it with `aidrian-knowledge search` and read it before you name it.
  A rule that no doc owns becomes an issue to write that doc, never a new doc from here.
  It names no session specifics: no paths touched this session, no ticket keys, no one-off error text.
- `harness-mechanic` works only in a checkout of the plugin's repository, the `repository` in the plugin's `plugin.json`.
  When no checkout is at hand, a plugin lesson becomes an issue on that repository.
- Every fix names what should move and the command that reads it, such as an `aidrian report` count;
  for a lesson with no number, "no new occurrence" is enough.
- Never fan one lesson out into several outcomes; mention a second surface in the summary.

## 4. Route and resolve

Show the user the decisions as one table: id, tier, title, end, owner, and what should move.
Wait for the user's approval before any write, hand-off, or issue; merges and label changes need none.

Hand each owner its lessons in one batch: the ids, the project folder, and what should move for each.
`harness-mechanic` and `harness-librarian` resolve what they fix; check with `aidrian lesson list <id>`.
Resolve everything else yourself after it lands:

```bash
aidrian lesson resolve <id> --outcome <outcome> --link '<commit, pull request, issue, or reason>' --expect '<what should move, and the command>'
```

`--expect` is for fixes only. Single-quote the link. When it holds a single quote or shell syntax, pass `--link -` and send the text
on stdin through a quoted heredoc, as the `lesson` skill does for notes.
Resolve only what landed; a lesson whose route failed stays open, with the failure in the summary.

## 5. Re-check fixes

For each fix in `aidrian lesson stats` that has held for 14 days or more and has an `expect` line, run the command it names.
When the number did not move, record that as one more occurrence, with the numbers as evidence:

```bash
aidrian lesson add --same <id> <<'LESSON'
evidence: <the command and its output>
the fix did not move <the number>
LESSON
```

That reopens the lesson for the next batch. When the number moved, record nothing.

## 6. Summary

Per lesson: id, end, and link. Then the open count before and after, the fixes you re-checked, and the commands you ran.
When lessons are still open, say how many and stop; take another batch only when this one is fully routed.
Commit nothing here; each change commits through its own owner.

## Rules

- Dedupe before you create. A second issue for a known problem is worse than none.
- The user's approval before any write, hand-off, or issue: the decision table is the gate.
- An outcome that changes what users see goes to the project's product owner, when it has one, before an issue is written.
- Never edit the inbox by hand; `aidrian lesson` is the only change.
