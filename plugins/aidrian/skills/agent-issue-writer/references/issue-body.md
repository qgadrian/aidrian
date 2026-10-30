# Issue body

How to write the Markdown body of an issue, a parent issue, or a project issue, and the quality gate it must pass.
The Agent Action Plan JSON and the owner defaults are in `references/action-plan.md`.

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

## Tracker Artifact Rules

Use the tracker's native primitives whenever possible: on Linear, `references/linear.md`; on GitHub Issues,
the GitHub column of the `knowledge` skill's `references/tracker.md`.

- Use a real issue for executable work (Linear `save_issue`, GitHub `gh issue create`).
- Use a parent issue when an initiative groups multiple execution issues.
- Link each child to its parent: Linear's native `parentId`; on GitHub, the parent's task list.
- Use `blockedBy` / `blocks` for blocker links on Linear; on GitHub, the body's dependencies section.
- Use a Linear Project, or the GitHub milestone or project the `issue_tracker` knowledge names, for multi-issue tracking.
- Leave an issue in the backlog status only for incomplete backlog capture, never for an AI-ready executable task — every issue created by this
  skill is a first-class issue, there is no separate "draft issue" artifact type to avoid.
- Use the parent issue as the canonical body for issue trees and `PR & Merge Plan`.
- Treat merge into the default branch, config.json `defaultBranch`, as production deployment unless the project's knowledge says otherwise
  or the plan explicitly targets a different integration branch or base PR first.

Keep the Tracker Metadata mirror and the Agent Action Plan in the issue body even when native fields exist.

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

- Always include `XS`, `S`, `M`, or `L`. There is deliberately no `XL`:
  `L` is the ceiling that forces a split justification, so a size above it would sanction exactly what that rule prevents.
  Work that feels larger than `L` is a split, not a bigger t-shirt.
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

- Capture required formulas, mappings, enums, route names, invariants, product rules, copy constraints, query params, state transitions, and forbidden
  approaches.
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
  - project name (a Linear Project, or a GitHub milestone or project) or `none`
  - parent issue reference or `none`
  - filed from work on another issue (deferral, follow-up, split): the project defaults to the source issue's
  - the parent link is conditional — set it only for a true child of that parent, otherwise relate this issue to its source and leave the parent unset:
    the project's `issue_tracker` knowledge owns both rules, including when a deviation needs a reason
  - dependency links if applicable
  - milestone if provided
  - assignee if provided
  - Priority (always set; see Issue Fields below)
  - Effort (always set, and mirrored in this section's prose; see Issue Fields below)

### Issue Fields (Priority and Effort)

Set both in the tracker's own fields when you create the issue:

- Linear: the native `priority` and `estimate` on the same `save_issue` call that creates or updates the issue, never a follow-up call.
  `references/linear.md` holds the call and both mapping tables.
- GitHub Issues: the labels or project fields the `issue_tracker` knowledge names; with none, Tracker Metadata alone holds them.

**Always set Priority and Effort on every issue created, and always mirror Effort in the issue body.
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

Derive Effort from the issue's `## Size` t-shirt estimate, and set the tracker's effort field from it in the same step.
An explicitly supplied Effort overrides the derivation by changing the recorded `## Size`, never by setting a tracker value that disagrees with the Size.

| `## Size` | `issue_fields.effort` |
|---|---|
| XS | Low |
| S | Low |
| M | Medium |
| L | High |

`## Size` is the sole source of truth for the tracker's effort field: on Linear, `estimate` by `references/linear.md`.
Effort stays a three-value prose mirror (`Low` covers both `XS` and `S`), so it is deliberately coarser than Size.
When only an Effort is supplied, `Low` means Size `S`; `XS` is reachable only by declaring Size `XS` explicitly.

Never leave the effort field unset on a created issue when the tracker has one, and never let it disagree with the Effort prose in `Tracker Metadata`.

#### Label rules (domain/work-type only)

On Linear, add no `priority:*` or `effort:*` labels: the native fields are already filterable.
On GitHub Issues, priority and effort labels are only the ones the `issue_tracker` knowledge names.
Otherwise add only domain/work-type labels (`bug`, `chore`, `feature`, etc.) to `tracker_fields.labels`; on Linear, follow the create-if-missing
procedure and the label-set-replacement warning in `references/linear.md`.

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
- Explicitly state whether merge into the default branch is production deployment.

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
- Are Priority and Effort set where the tracker keeps them, as § Issue Fields says (on Linear, `priority` and `estimate` on the creating
  `save_issue` call), with the effort value matching the Size and the Effort recorded in `Tracker Metadata`?
- Does the issue include tracker metadata and an `agent_action_plan` with `review_owners`, `validation_owners`,
  `required_authority_docs`, and at least one `approval_gate`?
- Has every vague phrase been removed?
- Has the issue avoided listing unnecessary agents?
- Would the review and validation gates still block closure if the executor skipped required docs, tests, or repo contracts?
- Would two different agents produce materially similar work from this issue?

If any answer is `no`, tighten the issue or return blocked mode.
