---
name: agent-issue-writer
description: Draft or create Linear or GitHub issues, parent issues, or projects for AI agents to implement.
---

# Agent Issue Writer

Before you start, follow the `knowledge` skill. Knowledge tags: `issue_tracker`, `testing`, `e2e`, `product_sensitive`, `docs`.

Create tracker artifacts for coding agents, not summaries for humans.

The result must let an execution agent complete the task in one pass and verify it without making hidden scope, testing, or ownership decisions.

The project's `issue_tracker` knowledge names the tracker and owns its rules (team, transition rules, magic-word grammar, status taxonomy).
Read the `knowledge` skill's `references/tracker.md` for each step's tool, and on Linear also this skill's `references/linear.md`
before creating or updating Linear-native artifacts.

Read `references/examples.md` when you need a concrete example for a standalone issue, initiative issue tree, or blocked ticket.

Read `references/issue-body.md` (banned phrases, tracker artifact rules, body structure, section rules, Priority and Effort,
final quality gate) and `references/action-plan.md` (Agent Action Plan schema, project defaults) before workflow step 8.

## Responsibility Boundary

You own tracker-ready artifacts:

- issues
- parent issues
- project membership: a Linear Project, or a GitHub milestone or project
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
- If the tracker's tool is available (the host's Linear tools, or `gh` for GitHub Issues), create or update the issue there;
  otherwise return a draft payload only.
- Do not edit repository files. Your responsibility is the tracker artifact only.

## Required Inputs

Before finalizing, resolve or infer these inputs:

- tracker: the one the `issue_tracker` knowledge names: `linear`, `github`, or another
- artifact type: `issue`, `parent_issue`, or `project_issue`
- mode: `draft_only` or `create_native`
- target repo or workspace
- exact goal
- dependency context
- target branch or merge target when known
- whether the issue belongs to an initiative
- whether preflight delegation is needed

If repo context is available, discover missing fields through repo inspection before asking the user.

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

   **Verify repository context against the working tree before sizing.** Every listed path under files to modify / reference / reuse must pass `git ls-files -- <path>` (tracked and existing), and each files-to-modify entry must be opened far enough to confirm it actually plays the role the issue assigns it — a pure dispatcher/barrel is not a render target; a type-only module is not a mutation site. Derive `size` only from verified context; an unverified assumption about a file's role invalidates the estimate. An S-sized issue that named a pure dispatcher as its render target once took hours.
6. Identify whether the task is product-sensitive, migration-sensitive, or e2e-sensitive.
7. For product-sensitive work, decide whether the issue must also update shared
   product knowledge in a doc from the project's `product_sensitive` knowledge.
8. Draft the Markdown body using the canonical structure and its Agent Action Plan.
9. Populate the tracker's native fields and links when the tool supports them.
   Priority and Effort are always set, as `references/issue-body.md` § Issue Fields says per tracker;
   on Linear, `priority` **and** `estimate` are parameters of the creating `save_issue` call, never a follow-up call.
10. Run the final quality gate in `references/issue-body.md`. If any required detail is still vague, rewrite or block.

## Output Modes

### Issue creation mode

If the tracker's tool is available and the user asked to create the issue:

- populate native fields first: on Linear, `priority` and `estimate` on the creating `save_issue` call, by `references/linear.md`;
  on GitHub, `gh issue create` with the labels and milestone the `issue_tracker` knowledge names
- keep the Markdown body aligned with the canonical structure
- derive native dependency links from `dependencies`

### Draft mode

If no tracker tool is available, return:

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
