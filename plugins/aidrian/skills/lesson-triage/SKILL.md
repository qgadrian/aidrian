---
name: lesson-triage
description: Drain the lesson inbox worst first, routing each lesson to a fix, an issue, a merge, or a rejection.
disable-model-invocation: true
---

# lesson-triage

With `--peek`: skip the `knowledge` skill, run step 1, print the ranked table
(id, tier, seen, age, title, project), and stop. `--limit N` replaces `10` in step 1, in both modes.

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`, `issue_tracker`.

Turn captured lessons into work, one batch at a time, worst first.
Run it in its own session: the `lesson` skill keeps its reads, searches, and hand-offs out of task sessions.

## 1. Read

```bash
aidrian lesson stats
aidrian lesson list --json --limit 10
```

`stats` gives the open count by tier and the recent fixes. The list is the batch, already in triage order: tier, then age.
Each row has `id`, `title`, `note`, `tier`, `kind`, `target`, `evidence`, `seen`, the last `occurrences`, `similar`,
`session`, `agent`, `project`, and `triage`. Read the evidence before you decide anything.

Every project files its `target: plugin` lessons in the plugin repository's inbox.
In a checkout of it, the list holds them all, and `project` names where each came from;
elsewhere, it holds this project's lessons, and `aidrian lesson list --target plugin` reads the plugin's.
A lesson's session, worktree, and evidence belong to its `project`.

- `reopened` above 0 means a fix did not hold: read its `resolutions` before anything else.
- `source: auto` is a lesson the plugin recorded itself; its `key` names the signal, such as `delivery-check:<agent>`.
- `seen` above 1 makes a P2 or P3 worth more: the same cost, paid again each time.

In a full run, when nothing is open, go to step 5.

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

A row whose `triage` is not `null` was searched in this project within 14 days: reuse it without `aidrian-knowledge search`
or `git grep`. Before the table, read whether each issue or pull request in `existing` is open, closed, or merged.
When its end, kept or new, is an `Issue` not yet filed, run the tracker search and `gh pr list` again. A `triage: null` row is searched in full.

## 3. Decide

Fix a wrong label first: `aidrian lesson update <id> --tier P1 --target plugin`.
A new target moves the lesson: `plugin` to the plugin's inbox, `project` back to its project's inbox;
run a move back from that project's checkout, or with `--project <dir>`, so its config.json `state.dir` holds.
Then pick one end per lesson:

| End | When | Owner | Outcome |
| --- | --- | --- | --- |
| Fix now | One change catches it every time, or states the rule once | `target: plugin`: `harness-mechanic`. `target: project`, knowledge: `harness-librarian`; code or config: the agent that owns that code | `mechanism` or `rule` |
| Issue | Bigger than one change, or it changes what users see | the `agent-issue-writer` skill; the project's product owner first when users see it | `issue` |
| Merge | Another lesson is the same problem | step 2 | `merged` |
| Reject | Specific to one session, already fixed, or not worth its cost | the reason | `rejected` |

- Prefer a mechanism: a script, check, or hook catches it every time. Before you choose `rule`, say why it cannot be a mechanism.
- A rule goes into the knowledge doc that owns the topic: a reused row names it in `existing`; else find it with `aidrian-knowledge search`. Read it before you name it.
  A rule that no doc owns becomes an issue to write that doc, never a new doc from here.
  It names no session specifics: no paths touched this session, no ticket keys, no one-off error text.
- `harness-mechanic` works only in a checkout of the plugin's repository, the `repository` in the plugin's `plugin.json`.
  When no checkout is at hand, a plugin lesson becomes an issue on that repository.
- Every fix names what should move and the command that reads it, such as an `aidrian report` count;
  for a lesson with no number, "no new occurrence" is enough.
- Never fan one lesson out into several outcomes; mention a second surface in the summary.

Before the table, record the triage of each lesson searched in full or given a new end, a rule's doc in `existing`:

```bash
aidrian lesson update <id> --triage - <<'TRIAGE'
{"existing": ["<link>"], "proposed_end": "Fix now", "owner": "<owner>", "expect": "<what should move>"}
TRIAGE
```

## 4. Route and resolve

Show the user the decisions as one table: id, tier, title, end, owner, what should move, and prior verdict
(the record's `verdict` and `reason`). Never propose a declined end again unchanged: propose another, or ask.
Wait for the user's approval before any write, hand-off, or issue; merges, label changes, and the triage record need none.

After the gate, rewrite the record whole, its other fields resent:
`"verdict": "declined"` and the reason when the user declines the end; `"verdict": "failed"` and the failure text when a route fails.

Hand each owner its lessons in one batch: the ids, the project folder, and what should move for each.
`harness-mechanic` and `harness-librarian` resolve what they fix; check with `aidrian lesson list <id>`.
Resolve everything else yourself after it lands:

```bash
aidrian lesson resolve <id> --outcome <outcome> --link '<commit, pull request, issue, or reason>' --expect '<what should move, and the command>'
```

`--expect` is for fixes only. Single-quote the link; when it holds a single quote or shell syntax,
pass `--link -` with the text in a quoted heredoc, as in step 3.
Resolve only what landed; a lesson whose route failed stays open, with the failure in the summary.

## 5. Re-check fixes

When `aidrian lesson stats` shows a fix held 14 days or more with an `expect` line, follow [references/recheck.md](references/recheck.md).

## 6. Summary

Per lesson: id, end, and link. Then the open count before and after, the fixes you re-checked, and the commands you ran.
When lessons are still open, say how many and stop; take another batch only when this one is fully routed.
Commit nothing here; each change commits through its own owner.

## Rules

- Dedupe before you create. A second issue for a known problem is worse than none.
- The user's approval before any write, hand-off, or issue: the decision table is the gate; merges, label changes,
  and the triage record pass it, because they route nothing.
- An outcome that changes what users see goes to the project's product owner, when it has one, before an issue is written.
- Never edit the inbox by hand; `aidrian lesson` is the only change.
