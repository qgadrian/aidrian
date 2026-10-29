---
name: issue-plan
description: Plan one Linear issue before implementation. planning-agent writes a decision-complete local plan; this skill checks it. Read-only on Linear.
disable-model-invocation: true
---

# issue-plan

Plan one Linear issue before anyone implements it: resolve it read-only, advise a workspace, have `planning-agent` write the plan,
check the plan against its schema, and report. The `issue-implement` skill then runs from that plan.
This skill writes no code, creates no branch or worktree, opens no pull request, and writes nothing to Linear.

Before you start, follow the `knowledge` skill. Load your `issue_tracker` docs for the key format and the issue's sections.

## Inputs

```text
<issue> [--mode new|revise]
```

- `<issue>`: a Linear issue key, such as `ABC-123`, or its URL. Missing: ask once.
- `--mode new`, the default, refuses when a plan exists. `revise` updates it, and keeps each completed slice as it is.

**stop** ends the run with a report; **stop and ask** adds one question only the Human can answer.

## 1. Resolve the issue

Read the `issue-implement` skill's `steps/phase-0-resolve.md` (`../issue-implement/` from this folder).
Run its sections 2, 3, and 6 to 8, with these changes:

- The plan path is `<state>/plans/<key>-implementation.md`: `<state>` is what `aidrian state` prints, the key is lowercase.
  `new` with a plan there: stop and ask whether to revise it, delete it and start again (losing completed slices' commits), or abort.
  `revise` with no plan: ask whether to switch to `new`. Report any other `<state>/plans/<key>-*.md`.
- Of its critical-flow guard, keep only the finding: whether the issue touches a critical flow.
  `planning-agent` consults `product-manager` itself.
- **Acceptance criteria without ids**: ask whether to number them by position (`AC1` is the first) and record that in the plan,
  or to have `agent-issue-writer` add ids first. Never count an unnumbered bullet as covered.
- **Sub-issues** (`list_issues` with this issue as parent): one with a linked pull request: stop and ask.
  Sub-issues with their own criteria: ask whether to write one combined plan or one per child. Never fold a child's criteria in silently.
- **Stale paths**: a file to modify or reference that does not exist, or a file to create that already does:
  ask whether `agent-issue-writer` refreshes the issue first, or `planning-agent` re-derives the paths and records the drift.

## 2. Advise a workspace

Decide; create nothing. The branch is the issue's `gitBranchName`.
The main checkout is the parent folder of `git rev-parse --path-format=absolute --git-common-dir`.

- A worktree already has the branch: clean and at its tip, mode `worktree` with that path. Dirty or diverged: stop and ask.
- The current checkout is on the branch, clean, and not the main checkout: mode `current_branch`.
- Otherwise mode `worktree`, at the `worktree_path` that `aidrian worktree new <branch> --plan` prints.

A dirty main checkout goes in the rationale: a new worktree starts without its changes.

## 3. Dispatch planning-agent

One foreground dispatch, whose brief carries:

- the issue summary: goal, scope, acceptance criteria with ids, non-goals, constraints, and dependencies, never the whole description;
- the agent action plan as it is, since it constrains the owners;
- the workspace decision: mode, branch, worktree path, rationale;
- the snapshot's `updatedAt` for `ticket_updated_at`, so it never fetches the issue again;
- the mode, and for `revise` the plan path and the rule: a `complete` slice is frozen except `notes`, and new work becomes new slices at the end;
- the output path and the `planning-agent` skill's `references/plan-file.md` schema, Linear variant, `plan_kind: implementation`;
- the knowledge tags: `orchestration`, `issue_tracker`, `testing`, plus `product_sensitive` for a critical flow.

## 4. Check the plan

Read the plan; never fix it yourself. Each check that fails is a gap.

1. The file exists, with YAML frontmatter holding every field the schema requires.
   `ticket_updated_at` equals the snapshot's; `status` is `ready`, `open-questions`, or `blocked`.
2. Every slice has `files_in_scope`, `verification_path`, and `closure_criteria`. Each `upstream_dependency` is null or a slice of the plan.
3. Every `primary_owner` is an agent that exists, as a project agent or this plugin's.
4. A plan with two or more implementation slices ends with the `INTEGRATION-REVIEW` slice.
5. Every acceptance criterion id from the issue is in some slice's `acceptance_criteria_covered`.
   An uncovered id may be deliberate: the Human confirms it.
6. Every id a slice covers exists in the issue. A made-up id is a planning error.
7. `revise`: each completed slice is unchanged except `notes`.
8. A critical flow: `## Approach` reports the `product-manager` consultation, or why it was skipped.

On a gap, report it and ask: dispatch `planning-agent` again with a fresh brief that lists the gaps,
accept the plan as `open-questions`, or abort. On accept, set `status: open-questions` and add the gaps under `## Open questions`:
the one edit this skill makes. Two failed dispatches in a row: stop; offer `blocked` with the gaps, or `architect`.

## 5. Report

1. **Verdict**: `done: plan ready`, `done: plan revised`, `done: plan with open questions`, or `partial: blocked on <reason>`.
2. **Plan**: its path, title, slice ids with one-line goals, and `status`.
3. **Workspace** recorded, with the rationale.
4. **Coverage**: each acceptance criterion id and its slice; uncovered ids flagged.
5. **Decided alone**, and the open questions when there are any.
6. **Next step**: ready, run the `issue-implement` skill on the issue; otherwise the question to settle, or the blocker and its owner.

No agent-doable work stays a Human follow-up in the report or the plan: it runs during implementation,
or becomes an issue through `agent-issue-writer`. Only work no agent can do goes to the Human, with the reason.
