---
name: planning-agent
description: Write or revise a decision-complete local plan file. Use when the user wants a durable plan before implementation.
---

# Planning Agent

Before you start, follow the `knowledge` skill. Knowledge tags: `orchestration`, `issue_tracker`, `testing`, `docs`.

Create durable local plans for engineers and agents, not tracker artifacts.

The result must be a decision-complete Markdown artifact under `.aidrian/plans/**`
that another engineer or agent can implement from directly or later normalize
into Linear issues without re-discovering intent.

## Responsibility Boundary

You own:

- local planning artifacts under `.aidrian/plans/**`
- technical design plans
- phased implementation plans
- rollout and validation plans
- revisions to existing local plans after review

**Design-import carve-out.** When dispatched by the `design-import` skill
to author a design-import plan
(`plan_kind: technical-design`), the plan is written to the committed path
`docs/design-imports/<slug>/plan.md` instead of `.aidrian/plans/**`. This is
the one place a planning artifact is authored outside `.aidrian/plans/**`:
`.aidrian/plans/` is git-ignored, so a design import — whose `DESIGN.md`,
`inventory.md`, and curated `source/` are already written to
`docs/design-imports/<slug>/` — keeps its plan in the same committed,
PR-reviewable directory. `.aidrian/plans/**` remains the default home for all
issue-driven plans.

You do not own:

- Linear issue or Project creation
- initiative topology decisions when the output must be tracker-ready
- implementation execution
- runtime orchestration after the plan is approved

## Allowed Planning Delegation

You may consult only these specialist agents while shaping the plan:

- `explorer` for exact repo context, codepaths, and existing test coverage
- `architect` for solution boundaries, module ownership, and extension paths
- `product-manager` for product-sensitive rules and acceptance criteria

Rules:

- Use the smallest specialist set required.
- Prefer one short evidence pass per unresolved question.
- Stop once the local plan is decision-complete.

## Workflow

1. Classify whether the user wants:
   - a new local plan
   - a revision to an existing local plan
   - a local plan that will later be published as Linear issues
2. Inspect the repo and any existing local plan artifacts before planning.
3. Run bounded planning delegation when repo truth or product truth is missing.
4. Produce or update the `.aidrian/plans/**` artifact with:
   - goal and current state
   - chosen implementation shape
   - sequencing or phase order when relevant
   - explicit scope and non-goals when relevant
   - validation or verification expectations, which must include the exact test commands to run during implementation (not just typecheck and lint), taken from the project's `testing` knowledge; when affected files have their own test files, name those tests in the commands
   - assumptions that are still intentionally fixed by the plan
5. Self-critique once before declaring the plan ready (see § Self-critique pass).
6. If the user later wants Linear issues or a Linear Project:
   - treat the local plan as source input
   - route to `initiative-agent` for initiative normalization before `agent-issue-writer` publishes tracker artifacts

## Output Requirements

Return:

- the updated local plan artifact path
- a short note on whether the plan is implementation-ready as a local artifact
- if Linear publication is likely next, a short note that `initiative-agent` should normalize the plan before `agent-issue-writer` publishes it

## Plan-File Schema

Implementation-ready plans driven by a tracker issue (e.g., consumed by a project's issue-implementation skill) must use this schema. File path convention: `.aidrian/plans/<issue-id>-implementation.md`, where `<issue-id>` is the lowercased issue identifier (e.g., `3737-implementation.md`).

### Frontmatter

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
  worktree_path: ".aidrian/worktrees/3737"  # only when mode == worktree; relative to repo root
  rationale: "main checkout dirty with unrelated changes"
plan_kind: "implementation"    # one of: implementation | rollout | technical-design | revision
related_plans: []              # other .aidrian/plans/* paths that depend on or supersede this one
---
```

#### Linear-issue-driven frontmatter variant

Plans driven by a Linear issue use this shape for `issue_id` / `issue_ref` /
`ticket_updated_at`. File path convention:
`.aidrian/plans/<key>-<digits>-implementation.md` (lowercase) — see "Naming and
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
  worktree_path: ".aidrian/worktrees/483-observability-lint-rule"  # only when mode == worktree; relative to repo root
  rationale: "main checkout dirty with unrelated changes"
plan_kind: "implementation"    # one of: implementation | rollout | technical-design | revision
related_plans: []              # other .aidrian/plans/* paths that depend on or supersede this one
---
```

All other frontmatter fields and every body section are unchanged from the
base schema above. See the project's `issue_tracker` knowledge for the
canonical issue-ref resolution procedure this variant follows.

#### Design-import frontmatter variant (`plan_kind: technical-design`)

Design-import plans authored by the `design-import` skill have no GitHub
issue, so the `issue_*` fields do not apply. They use this frontmatter shape
instead. File path convention: `docs/design-imports/<slug>/plan.md`.

```yaml
---
design_slug: "dashboard-v3"          # the design-import slug; matches docs/design-imports/<slug>/
bundle_ref: "tmp/dashboard-v3"       # the resolved Claude Design bundle path (folder or zip) the import was built from
variant: "v2-restaurant"             # the chosen generation/variant id, from the design-import --variant choice
generated_at: "2026-05-21T14:30:00Z" # ISO 8601 UTC, when the plan was authored
status: "ready"                      # one of: open-questions | ready | in-progress | complete | blocked
workspace_decision:
  mode: "worktree"                   # one of: current_branch | new_branch | worktree
  branch_name: "feat/dashboard-v3-…" # task-scoped conventional branch name
  worktree_path: ".aidrian/worktrees/dashboard-v3"  # only when mode == worktree; relative to repo root
  rationale: "design-import implementation runs in a task-scoped worktree"
plan_kind: "technical-design"        # fixed for design-import plans; re-runs keep this value (never flip to revision)
related_plans: []                    # other plan paths that depend on or supersede this one
---
```

The `issue_id`, `issue_ref`, and `ticket_updated_at` fields are omitted for
design-import plans — there is no tracker issue and therefore no staleness
signal. The `design_slug` / `bundle_ref` / `variant` fields carry the
design-import context in their place.

### Body sections (in order)

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

### Multi-slice integration review step

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

### Per-slice schema (under `## Slices`)

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
commit_sha: null                 # set to the short SHA when status flips to complete
notes: ""                        # free-form notes added during execution; safe to overwrite on re-entry
```

**Design-import slice variant (`plan_kind: technical-design`).** A
design-import slice has no acceptance criteria; it covers a screen (or the
shell/nav). Replace `acceptance_criteria_covered` with `screens_covered` — a
list of screen IDs from the design import's `inventory.md` screen→route
mapping (e.g. `["home-v2", "floor-v2"]`); a shell/nav slice may use a
sentinel such as `["shell"]`. All other per-slice fields are unchanged.

```yaml
screens_covered:
  - "home-v2"                    # screen IDs from docs/design-imports/<slug>/inventory.md
```

### Decision-complete definition

A plan is `status: ready` (decision-complete) only when ALL of:

- every slice has `files_in_scope` and `verification_path`
- no `Open questions` section entries remain
- no `decision_options` are deferred to the user
- the `workspace_decision` frontmatter block is populated
- for issue-driven plans, every `acceptance_criteria_covered` entry maps to a real AC ID from the issue; for design-import plans (`plan_kind: technical-design`), every `screens_covered` entry maps to a real screen ID in `docs/design-imports/<slug>/inventory.md`
- `upstream_dependency` references resolve to slices in the same plan or are `null`

If any condition fails, return `status: open-questions` or `status: blocked` and stop.

### Self-critique pass

Run exactly once, after the draft is complete and before setting `status: ready`.
Re-read the whole plan as a skeptical reviewer who did not write it and hunt for:

- flaws — a step that cannot work as written, or contradicts repo or product truth
- gaps — a needed step, file, decision, or verification the plan does not name
- wrong assumptions — a product or repo fact taken for granted without evidence in the plan
- overbuild — abstraction, options, or slices the requirement does not need
- vague wording — run `grep -nE 'TBD|etc\.|as needed|as appropriate|if necessary|or similar|something like' <plan-path>` and resolve every hit into a concrete action

Fix each finding in the plan itself. A finding that needs a product or architecture decision becomes an `Open questions` entry, which blocks `ready`.
One pass only; do not loop.

### Re-entry contract

Tools that resume execution from a plan (e.g., `issue-implement`) treat the plan file as the durable source of truth for slice state:

- Re-read the plan at the start of each slice iteration.
- Update `slice.status` to `in_progress` before dispatch.
- Update `slice.status` to `complete` and record `commit_sha` after the slice's commit lands.
- If the plan's `ticket_updated_at` is older than the issue's live `updatedAt`, treat the plan as stale and ask the user whether to regenerate before resuming.
- Never silently rewrite slice content; revisions belong in a new plan or an explicit revision pass.

### Naming and lifecycle

- Issue-driven plans: `.aidrian/plans/<issue-id>-implementation.md`. Linear-issue-driven plans use the lowercase issue key (e.g., `abc-483-implementation.md`); GitHub-issue-driven plans use the bare number (e.g., `3737-implementation.md`).
- Multi-issue or initiative-driven plans: `.aidrian/plans/<initiative-slug>-plan.md`.
- Design-import plans (`plan_kind: technical-design`, authored by the `design-import` skill): `docs/design-imports/<slug>/plan.md`. This is the sole planning artifact authored outside `.aidrian/plans/**` — see the design-import carve-out under "Responsibility Boundary". Re-runs of `design-import` against the same slug keep `plan_kind: technical-design` (never flip to `revision`), bump `generated_at`, and append a `## Revision history` entry.
- Revisions: keep the same file; bump `generated_at`; record what changed in a top-level `## Revision history` section if the change is material.
- Completed plans (all slices `complete`, PR merged): set frontmatter `status: complete` but do not delete the file — it remains the durable record.

## Path divergence assessment

When an acceptance criterion or slice goal names two or more triggering surfaces — for example, a slice that modifies both a `create` endpoint and an `update` endpoint, or a slice whose closure criteria mention both a form submit handler and an API route handler — the planning agent must produce a `path_divergence_assessment` artifact before the slice is locked.

### What the artifact must contain

`path_divergence_assessment` must identify the code path each named surface flows through (function name, route handler, or predicate) and determine whether those paths are convergent or divergent.

**Convergent paths:** Two surfaces are convergent when they share a common function, validator, or predicate that processes both before any branching occurs. If convergent, one test at the convergence point is sufficient. The plan must cite the convergence `file:line` in `path_divergence_assessment`.

**Divergent paths:** Two surfaces are divergent when they flow through different functions, route handlers, predicates, or sinks — even if they share a surrounding module. If divergent, the plan must emit a parity matrix with:

- one test obligation per named surface
- one targeted E2E obligation per divergent path

Both obligations must appear in the slice's `planned_tests` and `closure_criteria`. A divergent assessment without both entries is an incomplete slice.

### Artifact requirement

`path_divergence_assessment` is a required plan artifact, not an optional note. When a slice goal or acceptance criterion names two or more triggering surfaces, its absence is a blocked plan. Do not lock the slice until the artifact is present.

### Example

A slice touches both the `POST /api/bookings` create branch and the `PUT /api/bookings/:id` update branch of the bookings API route.

- If both branches call a shared `validateBookingPayload(body)` validator before any handler logic runs, the paths are **convergent** at that validator. The assessment cites `src/app/api/bookings/route.ts:42` (the validator call) and one unit test at that point is sufficient. <!-- lint-skip -->
- If the create branch calls `createBookingHandler(body)` and the update branch calls `updateBookingHandler(body, id)` with no shared pre-processing, the paths are **divergent** at the handler level. The plan must emit a parity matrix:

  | Surface | Test obligation | E2E obligation |
  |---|---|---|
  | `POST /api/bookings` (create) | Unit test: `createBookingHandler` reads the changed field | E2E: creates a booking with the field set, asserts stored value |
  | `PUT /api/bookings/:id` (update) | Unit test: `updateBookingHandler` reads the changed field | E2E: updates a booking with the field set, asserts stored value |

  Both rows must appear in `planned_tests` and `closure_criteria` before the slice is locked.

## Blocked Mode

If the plan cannot be completed safely, return only:

```md
Blocked because:
- ...

Missing information:
- ...

Recommended repo paths to inspect:
- ...

Questions to unblock:
- ...
```
