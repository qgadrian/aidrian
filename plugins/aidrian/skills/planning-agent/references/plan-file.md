# Plan-File Schema

Implementation-ready plans driven by a tracker issue (e.g., consumed by a project's issue-implementation skill) must use this schema. File path convention:
`<state>/plans/<issue-id>-implementation.md`, where `<issue-id>` is the lowercased issue identifier (e.g., `3737-implementation.md`).

A design-import plan (`plan_kind: technical-design`) changes the frontmatter and the per-slice coverage field:
read `references/design-import-plan.md` too.

## Frontmatter

```yaml
---
issue_id: "3737"               # bare issue number, string
issue_ref: "acme/notes#3737"  # owner/repo#N or URL
generated_at: "2026-05-07T14:30:00Z" # ISO 8601 UTC, when the plan was authored
ticket_updated_at: "2026-05-06T09:12:00Z" # ISO 8601 UTC, from the issue's updatedAt at the time of authoring; used for staleness detection
status: "ready"                # one of: open-questions | ready | in-progress | complete | blocked
workspace_decision:
  mode: "worktree"             # one of: current_branch | new_branch | worktree
  branch_name: "feat/3737-…"   # task-scoped conventional branch name
  worktree_path: "<repo>/.worktrees/3737"  # only when mode == worktree; absolute
  rationale: "main checkout dirty with unrelated changes"
plan_kind: "implementation"    # one of: implementation | rollout | technical-design | revision
related_plans: []              # other <state>/plans/* paths that depend on or supersede this one
---
```

### Linear-issue-driven frontmatter variant

Plans driven by a Linear issue use this shape for `issue_id` / `issue_ref` /
`ticket_updated_at`. File path convention:
`<state>/plans/<key>-<digits>-implementation.md` (lowercase) — see "Naming and
lifecycle" below for how this coexists with the bare-numeric GitHub
convention.

```yaml
---
issue_id: "ABC-483"                  # Linear issue key, string
issue_ref: "https://linear.app/acme/issue/ABC-483/observability-lint-rule"  # full Linear issue URL
generated_at: "2026-07-08T14:30:00Z" # ISO 8601 UTC, when the plan was authored
ticket_updated_at: "2026-07-07T09:12:00Z" # ISO 8601 UTC, from the Linear issue's updatedAt at the time of authoring; used for staleness detection
status: "ready"                # one of: open-questions | ready | in-progress | complete | blocked
workspace_decision:
  mode: "worktree"             # one of: current_branch | new_branch | worktree
  branch_name: "<username>/abc-483-…"  # the issue's own gitBranchName field, verbatim
  worktree_path: "<repo>/.worktrees/483-observability-lint-rule"  # only when mode == worktree; absolute
  rationale: "main checkout dirty with unrelated changes"
plan_kind: "implementation"    # one of: implementation | rollout | technical-design | revision
related_plans: []              # other <state>/plans/* paths that depend on or supersede this one
---
```

All other frontmatter fields and every body section are unchanged from the
base schema above. See the project's `issue_tracker` knowledge for the
canonical issue-ref resolution procedure this variant follows.

## Body sections (in order)

1. `# <Title>` — short, action-oriented.
2. `## Goal` — one paragraph.
3. `## Current state` — short factual summary of repo reality at `generated_at`.
4. `## Scope` — bullet list of in-scope changes.
5. `## Non-goals` — bullet list of explicit exclusions.
6. `## Approach` — chosen implementation shape and rationale; reference `architect` consultation when used.
7. `## Affected surfaces` — paths or modules touched, grouped by area.
8. `## Slices` — ordered list of independently verifiable slices (see schema below). Required for implementation plans.
9. `## Risks` — known risks and mitigations.
10. `## Open questions` — remaining unresolved questions; must be empty when `status: ready`.
11. `## Verification` — repo-wide verification commands beyond per-slice checks.

## Multi-slice integration review step

Every plan that defines two or more slices MUST include a final `### Slice INTEGRATION-REVIEW` entry
as the last implementation-side slice, after all implementation slices.
This slice is owned by `code-reviewer` (or the relevant specialist), is non-negotiable for multi-slice plans, and must appear in `## Slices`.
Its purpose is the holistic integration review: after the project's PR flow opens the PR as a draft and before closure/merge,
re-examine stubs, default values, and fallback paths from earlier slices
against behavioral rules, escalation triggers, and constraints introduced by later slices.

Minimal schema for the integration-review slice:

```yaml
slice_id: "INTEGRATION-REVIEW"
goal: "Holistic integration review of assembled branch — re-check earlier slices' stubs, defaults, and fallbacks against all later-slice rules"
primary_owner: "code-reviewer"
non_goals:
  - "No new implementation — review only"
files_in_scope: []   # all files touched by the preceding slices
closure_criteria:
  - "code-reviewer confirms no cross-slice stub/default/fallback invalidated by a later slice"
verification_path: []
planned_tests: []
upstream_dependency: "<last implementation slice_id>"
planned_commit_subject: null
status: "pending"
```

A plan with two or more implementation slices that omits this entry is not `status: ready`.

## Per-slice schema (under `## Slices`)

Each slice is an `### Slice <slice_id>` subsection with these fields:

```yaml
slice_id: "S1"                 # stable short identifier, S1..Sn
goal: "Add feature flag scaffold for foo"
primary_owner: "backend-developer" # specialist agent name, from the installed agents
non_goals:
  - "No locale changes (scaffold-only)"
files_in_scope:
  - "src/lib/feature-gates/<feature>.ts"
  - "src/lib/feature-gates/__tests__/<feature>.test.ts"
closure_criteria:
  - "Flag definition exported and consumed by no callers yet"
  - "Unit test covers default-off behavior"
verification_path:
  - "npm run typecheck"
  - "npm run lint"
  - "npx jest --testPathPatterns=src/lib/feature-gates --no-coverage"  # example only: use the test command the project's testing knowledge names
planned_tests:
  - "src/lib/feature-gates/__tests__/<feature>.test.ts (new)"
upstream_dependency: null        # null or another slice_id this slice depends on
planned_commit_subject: "feat(feature-gates): scaffold foo flag"
acceptance_criteria_covered:
  - "AC1"
  - "AC2"
status: "pending"                # one of: pending | in_progress | complete | blocked
notes: ""                        # free-form notes added during execution; safe to overwrite on re-entry
```

## Decision-complete definition

A plan is `status: ready` (decision-complete) only when ALL of:

- every slice has `files_in_scope` and `verification_path`
- no `Open questions` section entries remain
- no `decision_options` are deferred to the user
- the `workspace_decision` frontmatter block is populated
- for issue-driven plans, every `acceptance_criteria_covered` entry maps to a real AC ID from the issue; for design-import plans
  (`plan_kind: technical-design`), every `screens_covered` entry maps to a real screen ID in `docs/design-imports/<slug>/inventory.md`
- `upstream_dependency` references resolve to slices in the same plan or are `null`

If any condition fails, return `status: open-questions` or `status: blocked` and stop.

## Re-entry contract

Tools that resume execution from a plan (e.g., `issue-implement`) treat the plan file as the durable source of truth for slice state:

- Re-read the plan at the start of each slice iteration.
- Update `slice.status` to `in_progress` before dispatch.
- Update `slice.status` to `complete` just before the slice's commit; a plan file git tracks goes in that commit.
  Record no commit SHA: `git log` finds the commit by its `planned_commit_subject`.
- If the plan's `ticket_updated_at` is older than the issue's live `updatedAt`, treat the plan as stale and ask the user whether to regenerate before
  resuming.
- Never silently rewrite slice content; revisions belong in a new plan or an explicit revision pass.

## Naming and lifecycle

- Issue-driven plans: `<state>/plans/<issue-id>-implementation.md`.
  Linear-issue-driven plans use the lowercase issue key (e.g., `abc-483-implementation.md`);
  GitHub-issue-driven plans use the bare number (e.g., `3737-implementation.md`).
- Multi-issue or initiative-driven plans: `<state>/plans/<initiative-slug>-plan.md`.
- Design-import plans (`plan_kind: technical-design`, authored by the `design-import` skill): `docs/design-imports/<slug>/plan.md`.
  This is the sole planning artifact authored outside `<state>/plans/**` — see the design-import carve-out under "Responsibility Boundary" in the skill.
  Re-runs of `design-import` against the same slug keep `plan_kind: technical-design` (never flip to `revision`), bump `generated_at`, and append a
  `## Revision history` entry.
- Revisions: keep the same file; bump `generated_at`; record what changed in a top-level `## Revision history` section if the change is material.
- Completed plans (all slices `complete`, PR merged): set frontmatter `status: complete` but do not delete the file — it remains the durable record.
