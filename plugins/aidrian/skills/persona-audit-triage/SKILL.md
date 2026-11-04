---
name: persona-audit-triage
description: Triage persona-audit findings with the Human, to an issue, a fix now, a duplicate, a drop, or later, each recorded in the state folder.
---

# persona-audit-triage

Turn the findings of persona-audit reports into decisions, so none stays lost in `<state>/audits/`.
Every finding, Not reached line, and doc gap ends as `issue`, `fix-now`, `duplicate`, `drop`, or `defer`, recorded
with `aidrian audits record`. The mode is config.json `audits.triage.issueCreation`: in `confirm`, the default,
nothing is routed or created before the Human says yes; in `auto`, for unsupervised runs, issues are created unasked.

Before you start, follow the `knowledge` skill. Knowledge tags: `issue_tracker`, `personas`, `product_sensitive`.

To the Human, name an item by its title and a report by its `title`; ids and file names are for the commands only.

Argument: `[<report>]`, a report file name in `<state>/audits/`; with none, step 1 picks.
Copy this checklist and tick it:

```text
- [ ] 1. Report chosen
- [ ] 2. Sidecar imported, if missing, after the Human's yes
- [ ] 3. Batch read, with its screenshots
- [ ] 4. Product-rule findings answered by product-manager
- [ ] 5. Each item decided
- [ ] 6. Each decision acted on and recorded
- [ ] 7. Summary
```

## 1. Find the reports

```bash
aidrian audits list --json
```

Each row is a report: its file name, `title`, `status` (`ok`, `replaced`, `no-sidecar`, or `invalid`), and counts. Take the report named, else the oldest with untriaged items; several: ask the Human.
An invalid sidecar is the run's to fix: tell the Human the problem and take another report.

**Done when** one report is chosen and it has a sidecar or needs an import.

## 2. Import a report written without a sidecar

Once per report, and only with the Human: in `auto`, skip such a report and name it in the summary.
`aidrian audits import <report> --json` gives the `draft` sidecar, its `warnings`, and `replaced`: the earlier
report's findings, each title with its key. Read the report whole and check each finding of the draft against it:
severity, tasks, owner, `owner_description` in plain words, evidence, and `needs_trace` for an untraced cause.

When the report replaces an earlier one, its findings have no decision yet, whatever `list` says of that report:
the import sorts them. Read it too, and sort each, as the "This run replaces" sentence says: carried forward, when a
finding here covers it; not re-checked, when this run did not look at it. Show the Human a table of the draft
(title, severity, owner in plain words, screenshots), then every earlier finding by title with its proposed sort,
and say nothing is written yet. After the Human's yes, pass their keys:

```bash
aidrian audits import <report> --not-rechecked F2,F3 --carried-forward F1 --write
```

A correction the flags cannot carry: save the draft to `<state>/tmp/<report name>.json`, change it, and add
`--from <that file>`. The command validates every write and never overwrites a sidecar; never write one by hand.

**Done when** `aidrian audits list` shows the report with its untriaged count.

## 3. Read the batch

Settle the tracker first, as [references/deciding.md](references/deciding.md) § The tracker says.

```bash
aidrian audits pending <report> --json
```

It prints `issue_creation`, `search_labels`, and `groups`, the untriaged items in the order to ask: each blocker
alone; the other findings by severity and owner; the earlier report's findings this run did not re-check, with any
Not reached line that restates them, `proposed: covered`; Not reached lines; doc gaps. Each item has its report,
`labels`, `source`, and `audit_key`. Read its section of the report, and open the screenshots it cites, relative to `<state>/audits/`.

**Done when** every item in the batch was read with its evidence.

## 4. Product rules first

In both modes, a finding that touches a product rule in the `product_sensitive` knowledge, or an open question in a
product doc, as a report's "already an open question" says, goes to `product-manager` with its evidence before any
decision. No issue is drafted before its answer. In `auto`, one it does not settle is recorded `defer`, never filed.

**Done when** each such finding has the product manager's answer.

## 5. Decide

Read references/deciding.md before the first question: how to ask, duplicates, conflicts, priorities, and delegated
answers. In `auto`, ask nothing: take the recommended decision when it is `issue` or `duplicate`, and record any other
as `defer` with the reason, for the Human. In `confirm`, ask one question, then stop: blockers one at a time, then one
per group. Name the owner in plain words, from `owner_description`, never as an agent role. Each question lists its
items (title and what was seen, one line each), recommends one decision with one reason, and takes per-item answers.

| Decision | When | Then |
| --- | --- | --- |
| `issue` | Work beyond one small change | `agent-issue-writer` drafts it and creates it in the tracker that skill uses for the project |
| `duplicate` | An open or in-progress issue covers it | Search by content first, as deciding.md says; record its key |
| `fix-now` | One small, clear change | Route it to the owner the finding names, with `other_owners` |
| `documented` | It works as a doc says; prefer it to `drop` | Record `--doc <path#section>` |
| `drop` | Not worth its cost, or not a problem | Record the reason |
| `defer` | Decided later | Record it |
| `covered` | A `proposed: covered` line, once its group is decided | Record the reason |
| `decided` | A product decision an issue needs first; not final | Record `--reason '<decision>' --by <who>` |

**Done when** every item in the batch has a decision.

## 6. Act, then record

In `confirm`, act on an item only after the Human's yes for it:

- `issue`: run the `agent-issue-writer` skill as [references/issues.md](references/issues.md) says, which also
  attaches the screenshots; read it before the first issue.
- `duplicate`: comment on the existing issue with the finding and its evidence, when the Human asks.
- `fix-now`: dispatch the owner with the finding, its evidence, and the project folder.

Then record it: the item's `record` command from `pending --json`, plus the decision. Items with one decision share
a call, their `audit_key`s joined by commas:

```bash
aidrian audits record <report> '<audit_key>,<audit_key>' <decision> [--issue <key>] [--reason '<why>']
```

`issue` and `duplicate` need `--issue` or `--url`; `drop` and `covered`, `--reason`. `--by <role or human>`
says whose pick it was. Never edit `triage.json` by hand.
A route that fails records nothing: the item stays untriaged, with the failure in the summary.

**Done when** `aidrian audits pending <report>` prints `fully triaged`, or the summary names what is left and why.

## 7. Summary

In `auto`, first the issues created, each with its link, and any label left out. Then per item: its title, decision,
whose pick it was, and the issue link or reason; the untriaged count before and after; and the commands run. One report per run;
take the next only when the Human asks.
