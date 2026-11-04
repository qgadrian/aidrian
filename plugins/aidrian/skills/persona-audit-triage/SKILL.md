---
name: persona-audit-triage
description: Triage persona-audit findings with the Human, to an issue, a fix now, a duplicate, a drop, or later, each recorded in the state folder.
---

# persona-audit-triage

Turn the findings of persona-audit reports into decisions with the Human, so none stays lost in `<state>/audits/`.
Every finding, Not reached line, and doc gap ends as `issue`, `fix-now`, `duplicate`, `drop`, or `defer`, recorded
with `aidrian audits record`. Nothing is drafted for a tracker, routed, or created before the Human says yes.

Before you start, follow the `knowledge` skill. Knowledge tags: `issue_tracker`, `personas`, `product_sensitive`.

Argument: `[<report>]`, a report file name in `<state>/audits/`; with none, step 1 picks.
Copy this checklist and tick it:

```text
- [ ] 1. Report chosen
- [ ] 2. Sidecar imported, if missing, after the Human's yes
- [ ] 3. Batch read, with its screenshots
- [ ] 4. Product-rule findings answered by product-manager
- [ ] 5. Each group decided by the Human
- [ ] 6. Each decision acted on and recorded
- [ ] 7. Summary
```

## 1. Find the reports

```bash
aidrian audits list
```

Each line is a report with its findings and untriaged items, or `replaced by <report>`, `no sidecar: import needed`,
or `invalid sidecar: <problem>`. Take the report named, else the oldest with untriaged items; several: ask the Human.
An invalid sidecar is the run's to fix: tell the Human the problem and take another report.

**Done when** one report is chosen and it has a sidecar or needs an import.

## 2. Import a report written without a sidecar

Once per report. `aidrian audits import <report>` prints a draft sidecar, and its warnings on stderr. Read the report
whole and check each finding in the draft against it: severity, tasks, owner, `owner_description` in plain words,
evidence, and `needs_trace` for a cause the report says was not traced.

When a warning says the report replaces an earlier one, read that report too and sort its findings, as the "This run
replaces" sentence says: `carried_forward`, those a finding here covers; `not_rechecked`, those this run did not look at.
Show the Human a table of the draft (id, severity, title, owner in plain words, screenshots) and the sorted earlier
findings. After the Human's yes:

```bash
aidrian audits import <report> --not-rechecked F2,F3 --carried-forward F1 --write
```

A correction the flags cannot carry: save the draft to `<state>/tmp/<report name>.json`, change it, and add
`--from <that file>`. The command validates every write and never overwrites a sidecar; never write one by hand.

**Done when** `aidrian audits list` shows the report with its untriaged count.

## 3. Read the batch

```bash
aidrian audits pending <report> --json
```

It lists the untriaged items in the order to ask: each blocker alone; the other findings grouped by severity and owner;
the earlier report's findings this run did not re-check, each once and never one carried forward; Not reached lines;
doc gaps. Each item names the report it belongs to. Read each item's section of its report, and open the screenshots
it cites: each `evidence` path is relative to `<state>/audits/`.

**Done when** every item in the batch was read with its evidence.

## 4. Product rules first

A finding that touches a product rule in the `product_sensitive` knowledge, or an open question in a product doc,
as a report's "already an open question" says, goes to `product-manager` before the Human is asked about it,
with the finding and its evidence. Its answer goes into the question; no issue is drafted before it.

**Done when** each such finding has the product manager's answer.

## 5. Ask the Human

Blockers one at a time; then one question per group. Name the owner in plain words, from `owner_description`, never
as an agent role. Each question lists its items (id, title, what was seen, in one line each), recommends one decision
with one reason, and lets the Human answer per item where they differ.

| Decision | When | After the Human's yes |
| --- | --- | --- |
| `issue` | Work beyond one small change | `agent-issue-writer` drafts it; the Human approves the draft; then it is created in the tracker that skill uses for the project |
| `duplicate` | An issue already covers it | Search the tracker first, as the `knowledge` skill's `references/tracker.md` says; record the issue's key |
| `fix-now` | One small, clear change | Route it to the owner the finding names, with `other_owners` |
| `drop` | Not worth its cost, or not a problem | Record the reason |
| `defer` | The Human decides later | Record it |

- A Not reached line is a follow-up for a rerun: an `issue` or `defer` to walk that task again once what stopped it,
  a width, a host, or an account, is solved.
- A doc gap goes to `harness-librarian` for a persona or product-access doc in the knowledge, else to `doc-updater`.
- A `needs_trace` finding's issue says the cause was not traced; a `likely_cause` goes in labelled as likely, not confirmed.

**Done when** every item in the batch has the Human's decision.

## 6. Act, then record

Only after the Human's yes for that item:

- `issue`: run the `agent-issue-writer` skill with the finding, its steps, its quote, and its evidence; show the draft;
  create it only after the Human approves the draft. Attach each screenshot the finding cites: on GitHub, upload it
  with `gh image` as the `pr-screenshot` skill's preflight sets up, and put the reference in the body; on Linear, the
  host's Linear file upload. Neither works: list the screenshots' full paths in the issue and tell the Human they are local.
- `duplicate`: comment on the existing issue with the finding and its evidence, when the Human asks.
- `fix-now`: dispatch the owner with the finding, its evidence, and the project folder.

Then record it, with the report the item names, which is the earlier report for a finding it did not re-check:

```bash
aidrian audits record <report> <id> <decision> [--issue <key>] [--url <url>] [--reason '<why>']
```

`issue` and `duplicate` need `--issue` or `--url`; `drop` needs `--reason`. Never edit `triage.json` by hand.
A route that fails records nothing: the item stays untriaged, with the failure in the summary.

**Done when** `aidrian audits pending <report>` prints `fully triaged`, or the summary names what is left and why.

## 7. Summary

Per item: report, id, decision, and the issue link or reason. Then the untriaged count before and after, and the
commands run. One report per run; take the next only when the Human asks.
