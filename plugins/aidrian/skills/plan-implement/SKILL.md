---
name: plan-implement
description: Implement a reviewed local plan with no tracker issue, such as a design import, to a draft pull request.
---

# plan-implement

Implement a decision-complete plan that no tracker issue anchors: a plan under `<state>/plans/`, where `<state>` is the folder
`aidrian state` prints, or a design import's `docs/design-imports/<slug>/plan.md`.
This skill replaces the `issue-implement` skill's phase 0 with the plan's own, then runs its phases 1 to 8 with the substitutions below.
Everything else there applies as written. When the two disagree on shared behaviour, `issue-implement` wins: report the drift.

Before you start, follow the `knowledge` skill. Then read the `issue-implement` skill's SKILL.md and `references/hard-rules.md`,
in `../issue-implement/` from this folder. Read its step files where it says. Phase 0 below replaces `steps/phase-0-resolve.md`,
except its base branch and re-entry sections, which it cites.

## Inputs

```text
[<plan path>] [--base <branch>]
```

- The plan path: absolute or from the repository root. Without one, look in `<state>/plans/*.md` and the current checkout's
  `docs/design-imports/*/plan.md`: first a plan whose `workspace_decision.branch_name` is the current branch,
  then the newest plan whose `status` is not `complete`. No candidate, or several: list them, newest first, and ask.
- `--base`: the branch the pull request targets. Default: config.json `git.defaultBranch`.
  A base other than the default must exist, as the issue-implement phase 0 base-branch section says.

## Phase 0: resolve the plan

1. **Wrong skill.** Frontmatter with `issue_id` or `issue_ref`: stop and ask. It belongs to `issue-implement`, which runs the tracker guards.
2. **Read the plan**: `plan_kind`, `status`, `workspace_decision`, slices, non-goals, acceptance criteria when it declares them, open questions.
3. **Ready.** Stop and ask on `status: complete`, a likely wrong plan; on `blocked` or a load-bearing open question,
   which goes back to `planning-agent`; or on a status other than `ready` or `in-progress`,
   with a recommendation to review it first with the `plan-review` skill.
   An "implement anyway" from the Human goes in the report.
4. **Gates.** A critical flow in the project's `product_sensitive` knowledge: a `product-manager` return where every `critical_flow[].sign_off` is `approved`,
   unless the plan records one; any other `sign_off` stops the run.
   A security-sensitive slice: `security-engineer` reviews the approach, unless the plan records that review;
   a finding whose disposition is `fix_now` stops the run.
5. **Re-entry**: as issue-implement's phase 0 re-entry section says, against the plan's slices.

## Substitutions

| In issue-implement | Here |
| --- | --- |
| The issue's description, criteria, and non-goals | The plan's frontmatter and body; criteria only when it declares them |
| The issue's `gitBranchName` | `workspace_decision.branch_name`, else `feat/<plan name>` (`feat/design-<slug>` for a design import), saved in the plan |
| The issue guards of phase 0 | Phase 0 above; `upstream_dependency` order still holds |
| The In Progress move, the estimate correction | None: this skill makes no tracker call at all |
| Phase 2, the slice plan | Skipped: the plan is the slice plan. `planning-agent` runs only when it has no slices |
| Slice state in the issue's plan file | The plan file. When git tracks it, its state goes in commits as phases 3 and 7 say |
| `Refs` and `Fixes` lines | None |
| The coverage gate of phase 5 | Declared criteria only; otherwise each slice's closure criteria |

## Design-import plans

The `design-import` skill's `references/plan-requirements.md` sets their rules; it binds here:

- `S0`, when present, comes first: no screen slice starts before its sign-offs are recorded.
- Owners come from the plan: `designer` for visual slices, `frontend-developer` for data wiring, after its recorded sign-offs.
- A screen slice is complete only with screenshot-against-artboard evidence for each artboard in its coverage table,
  reviewed by `designer` against the deviation ledger. No evidence: report the exact failure; never claim parity without it.

## Change a closure criterion during implementation

A review finding can show a slice's closure criterion unmet as written while the behaviour it names is proven elsewhere.
Changing the plan then is not a question for the Human. The finding's `plan_change` sets the route;
the orchestrator may make `proof` stricter, to `promise`, never the other way. With no `plan_change`, or on disagreement, it is `promise`.
Issue acceptance criteria never change here: they are the tracker's text.

- **`proof`**: the orchestrator decides it, with no question, only when every condition holds:
  - `existing_tests` names at least one committed test that runs the real logic;
  - in the fix pass already under way, within its round cap, the developer applied `break`, saw those tests fail,
    reverted it, and recorded the run in its handoff;
  - any evidence in a later slice is added to that slice's closure criteria, so the run cannot close without it;
  - no critical-flow or security sign-off named the tests being replaced, or its owner signed again.
  Any condition unmet: the slice keeps its criterion and the developer writes the tests.
- **`promise`**: it drops or changes behaviour, a parity row, or a non-goal. `product-manager` returns `decision_options`,
  and `aidrian decisions resolve` sets the authority, as `knowledge/references/decisions.md` says. The Human sees it only under `ask`.
- **Record**: `planning-agent` writes the change as one revision history entry, attributed to the orchestrator,
  and the pull request summary lists it, through the `pr-write` skill.

## Rules

- The plan file is the only record of slice state. Never track progress in the conversation alone.
- No tracker calls. The run writes to the pull request only through the `pr-write` step and phase 7's integration review,
  and never names a local plan path there.
- Never fork the engine: cite issue-implement's steps in a brief; never paraphrase them.
