# Review lens

`planning-agent` applies this lens in the `plan-review` skill's critique.
It reviews the plan as a product and scope decision. How the code gets written is the pull request review's job, later:
spend no finding on it.

## Find first, rank after

List every finding you can anchor. The classes order the report; they never filter what you look for.

- **Blocking flaw**: the plan cannot proceed. A missing schema field or `files_in_scope`, an open question, a broken hard rule,
  a gate not cleared, an acceptance criterion not covered.
- **Important gap**: implementation can start, but quality or safety suffers.
- **Improvement**: tighter wording, a redundant step removed, a safe slice made parallel.

## Anchors

Every finding cites one. A finding without an anchor is opinion: drop it.

- A field or clause of the plan schema: the `planning-agent` skill's `references/plan-file.md`,
  plus `references/design-import-plan.md` for a design import. Schema plans only.
- A project knowledge doc, by path and heading: an `always` doc for a hard rule,
  a `product_sensitive` doc for product truth and the critical flows.
- The issue's acceptance criteria, non-goals, files to modify, or agent action plan, for an issue-anchored plan.
- For a free-form plan: a stated goal, concrete actions, named owners, verifiable success criteria, named risks and dependencies.

## By plan kind

- `implementation`: the whole lens.
- `revision`: the whole lens, on new content only. Completed slices are frozen.
- `technical-design`: the approach, invariants, extension paths, and trade-offs, with no slice-level code checks.
  A design import also gets the checks of its schema file.
- `rollout`: no slice schema. Feature flags, observability, an alert that fires on failure, migration safety, and rollback.
- Free-form: the generic anchors above. Converting it to the schema is an improvement when the Human wants an implementation
  skill to run it, never a blocking flaw.

## Product first

- **Product truth.** Every user-visible outcome the plan assumes is in the issue's acceptance criteria or the project's
  `product_sensitive` docs. Anything else is a missing product decision: escalate it, never fill it in.
- **Priorities fit.** The plan's size matches the value at stake. A critical flow gets every gate; a minor surface gets no
  multi-slice plan.
- **Simplest solution.** No abstraction, option, configuration, or module the requirement does not need now.
  The plan names the upkeep of anything it adds.

## Scope and clarity

- **Assumptions.** Each guess about product or repository state sits under `## Risks` or `## Open questions`, never inside a slice.
- **Vague wording.** Run `grep -nE 'TBD|etc\.|as needed|as appropriate|if necessary|or similar|something like' <plan>`.
  Each hit in a slice is a finding: the slice states the concrete action instead.
- **Success criteria.** Each slice ends in a state a command or a reader can check.
- **Open questions** go to the Human on their own list, never buried among the flaws.

## Always

- **Hard rules.** Nothing in the plan breaks a rule in the project's `always` docs. Cite the doc and its heading.
- **Schema.** A schema plan matches `references/plan-file.md`:
  - every required frontmatter field, and the body sections in order;
  - each slice's `files_in_scope`, `closure_criteria`, and `verification_path` with the exact test commands;
  - each `upstream_dependency` null or a slice of the same plan;
  - each `primary_owner` an agent that exists, as a project agent or this plugin's;
  - the `INTEGRATION-REVIEW` slice last, when the plan has two or more implementation slices;
  - the decision-complete definition, before `status: ready`.
- **Issue.** An issue-anchored plan matches its issue:
  - each id in `acceptance_criteria_covered` exists in the issue, and each id of the issue is covered or named as left out on purpose;
  - the owners agree with the issue's agent action plan;
  - `files_in_scope` stays inside the files to modify and outside the non-goals;
  - `workspace_decision.branch_name` is the issue's branch name.

## Changes you may propose

Each change in the diff names one of these grounds:

- correctness: the plan would produce a wrong outcome, or one the product docs do not support;
- overbuild: the plan adds structure the requirement does not need; remove it, never restyle it;
- a hard rule, a missing schema field, a gate not cleared, or a contradiction with the issue.

Cosmetic restructuring is out. A change that grows the scope, such as a new slice, a wider scope, or changed non-goals,
is an escalation, never part of the diff.

## Return

Your machine handoff carries these in `artifacts`:

- `findings`: each with an id, its class, its anchor, the evidence, and the suggested fix;
- `open_questions`: the plan's own, word for word;
- `proposed_diff`: a unified diff of the plan file, except under `--findings-only`;
- `revision_history_entry`: the line to append under `## Revision history` on apply: the UTC date, a one-line summary, the finding ids;
- `preserves_intent` and `decision_complete_after_apply`: true or false;
- `consults`: each agent consulted, with its verdict.
