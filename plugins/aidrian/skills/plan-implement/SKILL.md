---
name: plan-implement
description: Implement a reviewed local plan with no Linear issue, such as a design-import plan, end to end to a draft pull request, through the issue-implement steps.
---

# plan-implement

Implement a decision-complete plan that no Linear issue anchors: a plan under `<state>/plans/`, where `<state>` is the folder
`aidrian state` prints, or a design import's `docs/design-imports/<slug>/plan.md`.
This skill replaces the `issue-implement` skill's phase 0 with the plan's own, then runs its phases 1 to 8 with the substitutions below.
Everything else there applies as written. When the two disagree on shared behaviour, `issue-implement` wins: report the drift.

Before you start, follow the `knowledge` skill. Then read the `issue-implement` skill's SKILL.md and `references/hard-rules.md`,
in `../issue-implement/` from this folder. Read its step files where it says, except `steps/phase-0-resolve.md`: phase 0 below replaces it.

## Inputs

```text
[<plan path>] [--base <branch>]
```

- The plan path: absolute or from the repository root. Without one, look in `<state>/plans/*.md` and the main checkout's
  `docs/design-imports/*/plan.md`: first a plan whose `workspace_decision.branch_name` is the current branch,
  then the newest plan whose `status` is not `complete`. No candidate, or several: list them, newest first, and ask.
- `--base`: the branch the pull request targets. Default: the plan's `workspace_decision.base_branch`, else config.json `defaultBranch`.
  A base other than the default must exist, as the issue-implement phase 0 base-branch section says.

## Phase 0: resolve the plan

1. **Wrong skill.** Frontmatter with `issue_id` or `issue_ref`: stop and ask. It belongs to `issue-implement`, which runs the Linear guards.
2. **Read the plan**: `plan_kind`, `status`, `workspace_decision`, slices, non-goals, acceptance criteria when it declares them, open questions.
3. **Ready.** Stop and ask on `status: complete`, a likely wrong plan; on `blocked` or a load-bearing open question,
   which goes back to `planning-agent`; or on a status other than `ready` or `in-progress`, with a recommendation to review it first.
   An "implement anyway" from the Human goes in the report.
4. **Gates.** A critical flow in the project's `product_sensitive` knowledge: a `product-manager` sign-off,
   unless the plan records one. A security-sensitive slice: `security-engineer` on the approach, unless the plan records its sign-off.
   `blocked` or `needs_evidence` stops the run.
5. **Re-entry**: as issue-implement's phase 0 re-entry section says, against the plan's slices.

## Substitutions

| In issue-implement | Here |
| --- | --- |
| The issue's description, criteria, and non-goals | The plan's frontmatter and body; criteria only when it declares them |
| The issue's `gitBranchName` | `workspace_decision.branch_name`, else `feat/<plan name>` (`feat/design-<slug>` for a design import), saved in the plan |
| The issue guards of phase 0 | Phase 0 above; `upstream_dependency` order still holds |
| The In Progress move, the estimate correction | None: this skill makes no tracker call at all |
| Phase 2, the slice plan | Skipped: the plan is the slice plan. `planning-agent` runs only when it has no slices |
| Slice state in the issue's plan file | The plan file. A committed plan's state change rides in the slice's own commit |
| `Refs` and `Fixes` lines | None |
| The coverage gate of phase 5 | Declared criteria only; otherwise each slice's closure criteria |

## Design-import plans

The `design-import` skill's `references/plan-requirements.md` sets their rules; it binds here:

- `S0`, when present, comes first: no screen slice starts before its sign-offs are recorded.
- Owners come from the plan: `designer` for visual slices, the project's frontend agent for data wiring, after its recorded sign-offs.
- A screen slice is complete only with screenshot-against-artboard evidence for each artboard in its coverage table,
  reviewed by `designer` against the deviation ledger. No evidence: report the exact failure; never claim parity without it.

## Rules

- The plan file is the only record of slice state. Never track progress in the conversation alone.
- No tracker calls. The run's only pull request write is the `pr-write` step, and its body never names a local plan path.
- Never fork the engine: cite issue-implement's steps in a brief; never paraphrase them.
