---
name: agent-issue-writer
description: Draft or create Linear implementation issues and initiative artifacts for AI agents. Use when a Linear issue, parent issue, or Project item is needed.
---

# Agent Issue Writer

Before you start, load project knowledge with the `knowledge` skill. Knowledge tags: `issue_tracker`, `testing`, `e2e`, `product_sensitive`, `docs`.

Create Linear artifacts for coding agents, not summaries for humans.

The result must let an execution agent complete the task in one pass and verify it without making hidden scope, testing, or ownership decisions.

Read `references/linear.md` before creating or updating Linear-native artifacts. The project's `issue_tracker` knowledge owns the tracker rules (active tracker, team, transition rules, magic-word grammar, status taxonomy).

Read `references/examples.md` when you need a concrete example for a standalone issue, initiative issue tree, or blocked ticket.

## Responsibility Boundary

You own Linear-ready artifacts:

- Linear issues
- parent issues
- Linear Project membership
- issue dependency links
- parent issue sequencing plans
- issue body quality
- embedded machine-readable contracts

You do not own broad initiative decomposition when multiple issues must be invented from a vague brief. In that case, route or defer to `initiative-agent` first unless the user explicitly asked for a single issue only.

If the user provides a local plan artifact from the project's plans folder, treat it as source context only. If issue topology, dependency order, or PR grouping is still implicit, route to `initiative-agent` first instead of inventing those decisions locally.

You may run bounded planning-time preflight delegation to sharpen one issue before publishing it.

## Allowed Preflight Delegation

You may consult only these specialist agents before drafting an issue:

- `explorer` to discover exact files, tests, fixtures, and source-of-truth docs
- `architect` to clarify implementation boundaries, module ownership, and interface constraints
- `product-manager` to confirm product-sensitive behavior and acceptance criteria
- `security-engineer` to confirm security-triggered trust boundaries, review ownership, and validation expectations

Rules:

- Use the minimal specialist set required.
- Preflight ends when the issue is concrete enough to publish or block.
- Do not turn preflight into execution orchestration.
- Do not delegate implementation, review, or validation work from this agent.
- Use `security-engineer` only when the issue is primarily about exploitability, auth/authz, tenant isolation, secrets/PII exposure, payments/webhooks, uploads/downloads, redirects, or other material trust-boundary risk.

## Core Rules

- Inspect the local repo before drafting when repo context is available.
- Replace vague statements with exact file paths, symbols, commands, labels, and invariants.
- Preserve user-provided scope and tighten it with discovered repo evidence.
- State what to change, what not to change, and how to prove completion.
- If exact files, product truth, or type constraints cannot be discovered, return blocked mode instead of inventing requirements.
- For product-sensitive issues, decide whether the implementation should also
  update a product doc from the project's `product_sensitive` knowledge, and encode
  that in the issue scope or as an explicit follow-up.
- If a Linear tool is available, create or update the issue or project there; otherwise return a draft payload only.
- Do not edit repository files. Your responsibility is the tracker artifact only.

## Required Inputs

Before finalizing, resolve or infer these inputs:

- tracker: must be `linear`
- artifact type: `issue`, `parent_issue`, or `project_issue`
- mode: `draft_only` or `create_native`
- target repo or workspace
- exact goal
- dependency context
- target branch or merge target when known
- whether the issue belongs to an initiative
- whether preflight delegation is needed

If repo context is available, discover missing fields through repo inspection before asking the user.

## Anti-Vagueness Rules

Do not use phrases such as:

- relevant files
- as needed
- where appropriate
- handle edge cases
- update tests
- use existing patterns
- ensure it works
- clean up related code
- refactor if necessary
- add the necessary labels
- use the right agents
- review as needed

Replace each with a concrete path, command, mapping, invariant, owner, or blocked reason.

## Workflow

1. Classify the request as:
   - standalone issue
   - issue within an existing initiative
   - initiative parent issue from an existing blueprint
2. If the request starts from a local plan artifact, decide whether that artifact is already normalized into an initiative blueprint.
3. If the task is broader than one issue and no initiative blueprint exists, stop and route to `initiative-agent`.
4. Decide whether bounded preflight delegation is needed.
5. Inspect the repo and collect exact implementation context:
   - files to modify
   - files to create
   - files to reference
   - files or helpers to reuse
   - size
   - tasks
   - non-goals
   - dependencies
   - sequencing
   - acceptance criteria
   - minimum verification commands

   **Verify repository context against the working tree before sizing.** Every listed path under files to modify / reference / reuse must pass `git ls-files -- <path>` (tracked and existing), and each files-to-modify entry must be opened far enough to confirm it actually plays the role the issue assigns it — a pure dispatcher/barrel is not a render target; a type-only module is not a mutation site. Derive `size` only from verified context; an unverified assumption about a file's role invalidates the estimate. (Encoded after a 2026-07 run where an S-sized issue named a pure dispatcher as the render target and assumed a settings blob was directly readable — neither held, and "S" became hours plus a shared-helper contract change.)
6. Identify whether the task is product-sensitive, migration-sensitive, or e2e-sensitive.
7. For product-sensitive work, decide whether the issue must also update shared
   product knowledge in a doc from the project's `product_sensitive` knowledge.
8. Draft the Markdown body using the canonical structure below.
9. Populate native Linear fields and links when the tool supports them.
   `priority` **and** `estimate` are non-optional parameters of the creating `save_issue` call — never a follow-up call, never left to the caller.
10. Run the final quality gate. If any required detail is still vague, rewrite or block.

## Linear Artifact Rules

Use Linear-native primitives whenever possible:

- Use a real issue (`save_issue`) for executable work.
- Use a parent issue when an initiative groups multiple execution issues.
- Use `parentId` for issue hierarchy — Linear's native sub-issue mechanism.
- Use `blockedBy` / `blocks` for blocker links.
- Use a Linear Project for multi-issue tracking and views.
- Leave an issue in the `backlog` status only for incomplete backlog capture, never for an AI-ready executable task — every Linear issue created by this skill is a first-class issue, there is no separate "draft issue" artifact type to avoid.
- Use the parent issue as the canonical body for issue trees and `PR & Merge Plan`.
- Treat merge into `main` as production deployment unless the plan explicitly targets a different integration branch or base PR first.

Keep the Tracker Metadata mirror and the Agent Action Plan in the issue body even when native Linear fields exist.

## Canonical Markdown Structure

Use the exact section order for the relevant artifact type.

### Executable Issue Or Child Issue

```md
## Context

## Goal

## Issue Type

## Size

## Scope

## Tasks

## Non-goals

## Repository Context

### Files to modify

### Files to create

### Files to reference

### Files to reuse

## Constraints

## Dependencies & Sequencing

## Acceptance Criteria

## Verification

## Tracker Metadata

## Agent Action Plan
```

### Parent Issue

```md
## Context

## Goal

## Initiative Shape

## Success Criteria

## Issue Tree

## PR & Merge Plan

## Tracker Metadata

## Agent Action Plan
```

### Project Issue

```md
## Context

## Goal

## Project Tracking

## Parent Issue Pointer

## Tracker Metadata

## Agent Action Plan
```

## Section Rules

### Context

- Keep this short.
- Explain why the task exists and any sequencing or dependency notes.
- Include parent issue, branch, PR, or migration dependency only when it changes execution order.

### Goal

- Describe the required end state, not generic intent.
- State the user-visible or system-visible outcome.

### Issue Type

- Use one value only: `feature`, `bug`, `refactor`, `test`, `docs`, `follow-up`, or `migration`.

### Size

- Always include `XS`, `S`, `M`, or `L`. There is deliberately no `XL`: `L` is the ceiling that forces a split justification, so a size above it would sanction exactly what that rule prevents. Work that feels larger than `L` is a split, not a bigger t-shirt.
- Reserve `XS` for a genuinely trivial, single-site change (a one-line fix, a typo, a constant). Anything needing its own regression test is at least `S`.
- Add one short rationale grounded in review scope, rollout complexity, or splitability.
- For initiative children, `L` requires a red-alert `split_alert` note with why it remains unsplit and which split candidates were considered.

### Scope

- Use flat bullets.
- Each bullet must describe a concrete required change.
- Large tasks must be split into discrete bullets so the executor can map code changes directly.

### Tasks

- Use flat bullets.
- Each bullet must describe an execution task the implementer will perform.
- Keep tasks narrower than acceptance criteria; they describe work, not proof.

### Non-goals

- Explicitly list nearby work that must not be folded into the issue.
- If the title could imply a broad cleanup, this section is mandatory.

### Repository Context

Every file entry must be an exact path plus a short reason.

- `Files to modify`: existing paths that must change.
- `Files to create`: exact new paths and purpose.
- `Files to reference`: source-of-truth paths, tests, docs, fixtures, migrations, or examples to inspect first.
- `Files to reuse`: existing helpers, components, builders, or utilities that should be reused instead of rewritten.

### Constraints

- Capture required formulas, mappings, enums, route names, invariants, product rules, copy constraints, query params, state transitions, and forbidden approaches.
- For product-sensitive tasks, include the exact authoritative doc paths the executor must read.

### Dependencies & Sequencing

- Always state blocker links and why they matter.
- For initiative children, include:
  - PR group key
  - target branch
  - merge prerequisites
  - whether merge is production deployment
  - deployment gates only when the merge carries medium/high production risk
- Do not invent a separate deploy sequence for `main`-targeting PRs. Merge order is deployment order there.

### Acceptance Criteria

- Use checkboxes.
- Every item must be objectively verifiable.
- Mention exact exports, files, behaviors, and invariants when known.
- Include no-regression expectations when relevant.

### Verification

- Always specify the minimum commands or exact manual checks required to close the issue.
- Use exact commands, not categories.
- If a category is not required, say `not_required`.
- If manual QA is required, name the exact route or flow.

### Tracker Metadata

- Always include:
  - one to three domain/work-type labels (`tracker_fields.labels` — optional; omit when none apply)
  - Linear Project name or `none`
  - parent issue reference (`parentId`) or `none`
  - filed from work on another issue (deferral, follow-up, split): the Linear Project defaults to the source issue's
  - `parentId` is conditional — set it only for a true child of that parent, otherwise relate this issue to its source and leave the parent unset:
    the project's `issue_tracker` knowledge owns both rules, including when a deviation needs a reason
  - dependency links if applicable
  - milestone if provided
  - assignee if provided
  - Priority issue field (native `priority`, always set; see Issue Fields below)
  - Effort issue field (native `estimate`, always set, and mirrored in this section's prose; see Issue Fields below)

### Issue Fields (Priority and Effort)

Both fields are native Linear fields set directly on the same `save_issue` call that creates or updates the issue — there is no separate post-creation API call for either. Priority is the native `priority` integer. Effort is the native `estimate` number: when the team uses Linear's t-shirt estimation scale, the issue's `## Size` maps straight onto it. See `references/linear.md` for the exact `save_issue` mechanics and both mapping tables.

**Always set Priority (native `priority`) and Effort (native `estimate`) on every issue created, and always mirror Effort in the issue body.
Neither field may be omitted from the issue body.**

#### Priority inference rule

When the user or initiative blueprint does not supply an explicit Priority, infer:

- declared critical-flow or security-sensitive work → `High`
- active production incident / hotfix explicitly stated → `Urgent`
- normal bug or feature → `Medium`
- docs, chore, or refactor → `Low`
- unclear → `Medium` (fallback)

An explicit user- or initiative-supplied Priority always overrides the inference.

#### Effort derivation rule

Derive Effort from the issue's `## Size` t-shirt estimate and set the native `estimate` in the same step.
An explicitly supplied Effort overrides the derivation by changing the recorded `## Size` — never by setting an `estimate` that disagrees with the Size.
The `check-linear-estimate.mjs` PreToolUse hook denies issue-creating `save_issue` calls that carry a `## Size` but no `estimate`,
and equally one whose `estimate` disagrees with that Size.

| `## Size` | `issue_fields.effort` | `save_issue(estimate:)` |
|---|---|---|
| XS | Low | 1 |
| S | Low | 2 |
| M | Medium | 3 |
| L | High | 5 |

`## Size` is the sole source of truth for `estimate`. Effort stays a three-value prose mirror (`Low` covers both `XS` and `S`), so it is deliberately coarser than Size — when an Effort is supplied with no Size, reverse-map `Low` → `2`; `XS` is reachable only by declaring Size `XS` explicitly.

Never leave `estimate` unset on a created issue, and never let it disagree with the Effort prose in `Tracker Metadata`.

#### Label rules (domain/work-type only)

The retired `priority:*` / `effort:*` label mirror is gone — Linear's native `priority` field is already filterable, so no filterable-copy workaround is needed. Only add domain/work-type labels (`bug`, `chore`, `feature`, etc.) to `tracker_fields.labels`, following the create-if-missing procedure and the label-set-replacement warning in `references/linear.md`.

### Initiative Shape

- Parent issues must state whether the topology is `parent_issue_only` or `tracker_project_plus_parent_issue`.
- State whether the parent issue is the canonical release-plan artifact.

### Success Criteria

- Parent issues must use checkboxes.
- Each item must describe an initiative-level outcome, not a child issue task.

### Issue Tree

- List child issues in creation order with key, title, size, and one-line purpose.

### PR & Merge Plan

- Parent issues must render PR groups as Markdown tables plus short notes.
- Each group must include:
  - PR group key and title
  - member issues
  - size mix when useful
  - target branch
  - merge-after requirements
  - risk
  - migration count
  - deployment gates when required
- Explicitly state that merge into `main` is production deployment.

### Project Tracking

- Project issues are tracking-only artifacts.
- Keep the content short and point back to the parent issue for the full issue tree and sequencing plan.

### Parent Issue Pointer

- State the canonical parent issue reference explicitly.
- Do not duplicate the issue tree or PR group tables here.

### Agent Action Plan

- Always include one short summary plus a fenced `json` block.
- Use compact mode only when one review owner and one validation owner are sufficient.
- Use expanded mode when the issue requires multiple specialist reviews, explicit validation sequencing, or approval gates across more than one agent.

## Agent Action Plan Schema

```json
{
  "mode": "expanded",
  "orchestrator_required": true,
  "planning_owner": "initiative-agent",
  "execution_owner": "backend-developer",
  "review_owners": ["code-reviewer", "backend-developer"],
  "validation_owners": ["e2e-runner"],
  "required_authority_docs": {
    "execution": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "review": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/code-style.md",
      "docs/knowledge/engineering/testing.md"
    ],
    "validation": [
      "docs/knowledge/engineering/working-agreement.md",
      "docs/knowledge/engineering/safety-rules.md",
      "docs/knowledge/engineering/testing.md",
      "docs/knowledge/engineering/e2e.md"
    ]
  },
  "deliverables": ["implement the scoped booking reassignment fix"],
  "verification_flow": [
    "npx jest --testPathPatterns=updateBooking --no-coverage",
    "npm run typecheck",
    "npm run lint",
    "npm run test:e2e:all -- --grep \"booking reassignment\""
  ],
  "escalation_triggers": [
    "required authority docs conflict",
    "product-sensitive behavior is undocumented"
  ],
  "required_agents": ["backend-developer", "code-reviewer", "e2e-runner"],
  "agent_responsibilities": [
    {
      "agent": "code-reviewer",
      "responsibility": "Perform final TypeScript and repo-pattern review."
    },
    {
      "agent": "e2e-runner",
      "responsibility": "Run affected-flow e2e validation and report failures."
    }
  ],
  "handoff_order": ["backend-developer", "code-reviewer", "e2e-runner"],
  "review_chain": ["code-reviewer", "backend-developer"],
  "validation_chain": ["e2e-runner"],
  "approval_gates": [
    {
      "id": "execution-complete",
      "phase": "execution",
      "owners": ["backend-developer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "commands_reported",
        "tests_reported",
        "docs_status_reported"
      ]
    },
    {
      "id": "review-signoff",
      "phase": "review",
      "owners": ["code-reviewer", "backend-developer"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "no_fix_now_findings"
      ]
    },
    {
      "id": "validation-signoff",
      "phase": "validation",
      "owners": ["e2e-runner"],
      "requires": [
        "handoff_complete",
        "required_authority_docs_loaded",
        "verification_passed"
      ]
    }
  ]
}
```

Rules:

- Compact mode must fill the first eight fields and include at least one approval gate.
- Expanded mode must fill every array that applies and must define the review and validation sequence explicitly when more than one owner participates.
- `orchestrator_required` should be `true` only when runtime execution needs explicit coordination across multiple specialist agents.
- Every action plan must include at least one review owner, one validation owner, and one approval gate owned by an agent outside the execution role.
- `required_authority_docs` must name authoritative repo docs only. Code, tests, fixtures, and source modules belong in `Repository Context`.

## Project Defaults

The project's `issue_tracker`, `testing`, `e2e`, and `product_sensitive` knowledge overrides every default below.

- Always set Priority (native `save_issue(priority:)`) and Effort (native `save_issue(estimate:)`) on every created issue, and mirror Effort in the issue body (see Issue Fields section above). Defaults when not explicitly supplied:
  - Priority: infer from issue type (critical-flow/security → `High`; hotfix → `Urgent`; bug/feature → `Medium`; docs/chore/refactor → `Low`; unclear → `Medium`)
  - Effort: derive from Size t-shirt (`XS` → `Low` → `estimate: 1`; `S` → `Low` → `estimate: 2`; `M` → `Medium` → `estimate: 3`; `L` → `High` → `estimate: 5`)
- Do not add `priority:*` or `effort:*` labels. `tracker_fields.labels` carries only domain/work-type labels.
- Default verification is the project's typecheck, lint, and the exact test command for the affected files, as its `testing` knowledge names them.
- If the change touches sign-in, onboarding, payments, admin, or other user-facing lifecycle behavior and unit tests cannot prove correctness, require exact e2e coverage.
- In initiative work, make the parent issue the canonical sequencing artifact and keep project artifacts as short tracking pointers.
- Use repo conventions:
  - colocated tests, when the project's `testing` knowledge uses them
  - existing fixtures and builders that knowledge names
  - authoritative docs from the project's knowledge buckets and linked product docs
- Default owner routing should be deterministic, using the roles the project has:
  - always include `code-reviewer` in `review_owners`
  - add `security-engineer` to `review_owners` for auth, authorization, sessions, tokens, org membership, tenant isolation, public trust boundaries, payments, billing, inbound webhooks, exports/imports, uploads/downloads, redirects, unsafe external content, or explicit security review tasks
  - add `backend-developer` to `review_owners` for backend runtime, API, jobs, auth, database, or data-integrity work
  - add `frontend-developer` to `review_owners` for UI rendering, state, cache, or hydration work
  - add `product-manager` to `review_owners` only for product-sensitive behavior changes
  - use `e2e-runner` in `validation_owners` whenever the issue requires affected-flow e2e proof
  - use `security-engineer` in `validation_owners` when the issue is primarily a security fix or hardening task and affected-flow e2e proof is not the main validation gate
  - otherwise use an independent technical reviewer in `validation_owners`; the execution owner alone must never satisfy the final validation gate
  - when both `security-engineer` and `code-reviewer` are in `review_owners`, put `security-engineer` first in `review_chain` and keep `code-reviewer` in the chain as the final general repo-consistency reviewer
- Default authority-doc loading should be explicit in `required_authority_docs`: list the knowledge docs each owner needs,
  as `aidrian-knowledge route <tags>` prints them for that owner's tags.
  - execution and review: the `always` docs plus `code_style` and `testing`
  - security review/validation: the same docs as review, plus `product_sensitive` when the work is product-sensitive
  - e2e validation: add `e2e`
  - product-sensitive work: add `product_sensitive` and the exact scoped product doc

## Final Quality Gate

Do not finalize until all answers are `yes`:

- Can the executor identify the exact files to touch?
- Was every files-to-modify path verified to exist (`git ls-files`) and confirmed to play the role the issue claims for it?
- Can the executor identify the exact files to read first?
- Does the issue say what is explicitly out of scope?
- Are the acceptance criteria observable and testable?
- Are verification commands exact?
- Does the issue include size, tasks, and sequencing details when applicable?
- If this is a `parent_issue`, does it include initiative shape, success criteria, issue tree, and PR group sequencing?
- If this is a `project_issue`, does it point to the canonical parent issue instead of duplicating the plan?
- If the issue is `L`, does it include a red-alert split note and split candidates?
- Does the `save_issue` call carry both native fields — `priority` (from the Priority mapping) and `estimate` (from the Size→Effort→estimate table: XS→1, S→2, M→3, L→5) — with `estimate` matching the Effort recorded in `Tracker Metadata`?
- Does the issue include tracker metadata and an `agent_action_plan` with `review_owners`, `validation_owners`,
  `required_authority_docs`, and at least one `approval_gate`?
- Has every vague phrase been removed?
- Has the issue avoided listing unnecessary agents?
- Would the review and validation gates still block closure if the executor skipped required docs, tests, or repo contracts?
- Would two different agents produce materially similar work from this issue?

If any answer is `no`, tighten the issue or return blocked mode.

## Output Modes

### Issue creation mode

If a Linear tool is available and the user asked to create the issue:

- populate native fields first — `save_issue(..., priority: <1-4>, estimate: <1|2|3|5>)` on the creating call, both always present
- keep the Markdown body aligned with the canonical structure
- derive native dependency links from `dependencies`

### Draft mode

If no Linear tool is available, return:

```md
Title: ...

Body:
...

Tracker metadata:
- ...
```

## Blocked Mode

If critical truth is missing, return only:

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
