---
name: lesson-triage
description: Drain the lesson inbox in a session opened for it. Dedupe each lesson, choose mechanism, rule, issue, or nothing, and route it.
disable-model-invocation: true
---

# lesson-triage

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`, `issue_tracker`.

Turn captured lessons into work, one at a time, until none is open.
Run this in its own session: it reads docs, searches, and hands work on, the cost the `lesson` skill keeps out of a task session.

## 1. Read

Run `aidrian lesson list --json`. When it is empty, report that there is nothing to triage and stop.
Otherwise take the lessons oldest first. Each has `id`, `at`, `note`, `evidence`, `kind`, `worktree`, `branch`, and `agent`.
Read the evidence before you decide anything.

## 2. Dedupe

Before you create anything, look for existing work on the same problem.
Search with two to five plain words you choose that name the problem, never a pasted command, path, or error text.
Single-quote the words on every command line.

- Project knowledge: `aidrian-knowledge search '<words>'`, for a doc that already states the rule.
- The repository: `git grep -n -i '<words>'`, for a hook, script, or check that already covers it.
- The tracker, as the project's `issue_tracker` knowledge describes it, open and recently closed issues,
  and `gh pr list --state all --limit 20 --search '<words>'`.

A match is a `duplicate`, linked to the match. A partial match extends the existing issue or change; it never opens a sibling.

## 3. Decide

Pick one outcome per lesson, in this order of preference:

| Outcome | When | Destination |
| --- | --- | --- |
| `mechanism` | A script, lint, hook, or check can catch it every time | the project's own hook or script, or an issue on the plugin for a plugin hook |
| `rule` | Judgment that no mechanism can encode, worth stating for everyone | the project knowledge doc that owns the topic |
| `issue` | A product or code defect, or work bigger than one change | the project's tracker, through the `agent-issue-writer` skill |
| `duplicate` | Step 2 found it | the match |
| `dropped` | Specific to one session, already fixed, or not worth its cost | the reason |

- Prefer a mechanism: before you choose `rule`, say why it cannot be a mechanism.
- Find the doc that owns a rule with `aidrian-knowledge search`, and read it before you name it.
  A rule that no doc owns becomes an `issue` to write that doc, never a new doc from here.
- A rule names no session specifics: no paths touched this session, no ticket keys, no one-off error text.
- A lesson about this plugin itself, its hooks, skills, agents, or commands, is an issue on the plugin's repository,
  the `repository` in the plugin's `plugin.json`, unless the project can fix it in its own config.json.
- Never fan one lesson out into several outcomes; mention a second surface in the summary.

## 4. Route and resolve

Show the decisions as one table: id, note, outcome, destination. Wait for approval before any write, hand-off, or issue.
After each item lands, record it:

```bash
aidrian lesson resolve <id> --outcome <outcome> --link '<issue, pull request, doc path, or reason>'
```

Single-quote the link. When it holds a single quote or shell syntax, pass `--link -` and send the text on stdin
through a quoted heredoc, as the `lesson` skill does for notes.
Resolve only what landed; a lesson whose route failed stays open, with the failure in the summary.

## 5. Summary

Per lesson: id, outcome, link. Then how many are still open, and the commands you ran.
Commit nothing here; each change commits through its own owner.

## Rules

- Dedupe before you create. A second issue for a known problem is worse than none.
- Approval before any write or issue: the decision table is the gate.
- An outcome that changes what users see goes to the project's product owner, when it has one, before an issue is written.
- Never edit the inbox by hand; `aidrian lesson resolve` is the only change.
