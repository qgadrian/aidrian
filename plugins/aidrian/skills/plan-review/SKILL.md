---
name: plan-review
description: Review a local plan before implementation. planning-agent critiques it and proposes a diff; the Human approves before it is applied.
---

# plan-review

Run one critique-and-refine pass over a plan before anyone implements it.
This session coordinates: it finds the plan, runs the gates, has `planning-agent` critique the plan and propose a diff,
and has `planning-agent` apply the diff only after the Human approves it.
It never critiques or rewrites the plan itself, and never commits it.

Before you start, follow the `knowledge` skill. Load your `orchestration` docs for the agent registry,
`product_sensitive` docs for the flows the project declares critical, and `security` docs for the surfaces that need a security pass.

## Inputs

```text
[<plan path> | <issue key or URL>] [--findings-only] [--apply] [--extended]
```

- A plan path: absolute or from the repository root. An issue key or URL: the plan for that issue, found as step 1 says.
- `--findings-only`: critique without a proposed diff.
- `--apply`: the Human approves the diff this session proposed earlier; go to step 5.
- `--extended`: allow one refinement pass more than step 6 does.

**stop** ends the run with a report; **stop and ask** adds one question only the Human can answer.

## 1. Find the plan

Plans live in `<state>/plans/`, where `<state>` is the folder `aidrian state` prints.
A design import keeps its plan at `docs/design-imports/<slug>/plan.md` in the main checkout.
Skip backups, editor and temporary files, and `.json` files. Without a path, take the first of these that finds a plan:

1. The issue: the argument, else the key in the current branch name, in the format the project's `issue_tracker` knowledge gives.
   Look for `<state>/plans/<key>-*.md`, with the key in lowercase, and for a plan whose `issue_id` is the key.
2. A plan whose `workspace_decision.branch_name` is the current branch.
3. The newest plan whose `status` is not `complete`.

Several candidates: list up to five, newest first, and ask. None: stop, and point to the `planning-agent` skill,
or the `issue-plan` skill for an issue. Never build a plan from the conversation.

## 2. Preflight

- Read the plan. With YAML frontmatter it is a schema plan of its `plan_kind`; without `plan_kind`, review it as `implementation`
  and add a finding. Without frontmatter it is a free-form plan: it gets the generic lens, never a penalty for the missing schema.
- `status: complete`: ask whether to review it again.
- An issue-anchored plan whose `ticket_updated_at` is older than the issue's `updatedAt` is stale. Ask: revise it with the
  `issue-plan` skill (`--mode revise`), review it as it is, or stop. On a critical flow, offer only revise or stop.
- Record the plan's hash, `git hash-object <plan>`, for step 5.

## 3. Gates

Both run before the critique, and their verdicts go into its brief as authoritative.

- **Critical flow.** The plan's goal, scope, approach, affected surfaces, or slice files touch a flow the project's
  `product_sensitive` knowledge declares critical (the whole text, for a free-form plan): `product-manager` first.
  `blocked` or `needs_evidence` stops the run with its `decision_options`, attributed.
- **Security.** The plan touches auth, sessions, tokens, tenancy, permissions, payments, webhooks, uploads, redirects, secrets,
  untrusted content, privileged access, or a surface the project's `security` knowledge lists: `security-engineer` first.
  Its verdict and required invariants bind the critique; no critique finding drops them.

## 4. Critique

Dispatch `planning-agent` alone, in the foreground. Its brief carries the plan path, the gate verdicts, the flags,
the issue's acceptance criteria and non-goals for an issue-anchored plan, and `references/review-lens.md` from this folder,
which it applies. It consults `product-manager`, `architect`, or `explorer` itself when the lens needs one:
dispatch no consult beside it. When it returns blocked on missing evidence, dispatch `explorer` for that evidence,
then critique once more.

Then report, in this order, and stop:

1. **Verdict**: `plan ready: no findings`, `findings: diff proposed`, `findings only`, or `blocked on <gate or evidence>`.
2. **Plan**: path, `plan_kind` or free-form, `status`, and freshness against the issue.
3. **Gates**: each verdict, or not applicable.
4. **Findings**: blocking, important, then improvements, each with its anchor.
5. **Open questions** from the plan, word for word, then **escalations**: product or architecture decisions, scope growth, disputes.
6. **Proposed diff** with its revision-history line, unless `--findings-only`.
7. **Ask**: `apply`, `apply with edits: <edits>`, or `skip`.

## 5. Apply

Only on the Human's explicit `apply` in this session.

1. Hash the plan again. When it changed since step 2, say so and go back to step 4.
2. Dispatch `planning-agent` with the plan path, the approved findings, the approved diff with the Human's edits,
   and the revision-history line. It writes the same file.
3. It keeps `issue_id`, `issue_ref`, and `workspace_decision` unless an approved finding changes them; report any such change first.
4. Read the plan again: a schema plan passes the lens's schema checks, and `status` matches reality.

## 6. Cap

One critique, one apply, and one more critique only when step 5.4 finds a new blocking flaw.
`--extended` adds one refinement pass, never more. Past the cap, escalate to the Human.
A consult that returns a dispute stops the run: escalate both positions and the missing evidence; never settle on a compromise.

## Close

The run is done only when each gate is cleared or not applicable, the Human answered step 4, an applied plan passed step 5.4,
and no dispute or blocked consult was dropped. Otherwise report `blocked` or `needs_input` with the step to resume from.

End with the next step: the `issue-implement` skill for an issue-anchored plan, and the `plan-implement` skill for any other,
design imports included. A changed design-import plan is a file change the report names; this skill never commits it.

## Do not

- Critique, rewrite, or restyle the plan yourself, or prefer your structure to the author's when both are valid.
- Apply a change without the Human's approval in this session, or a scope-growing change without its own approval.
- Skip a gate, or loop past the cap.
- Hand work an agent can do to the Human as a follow-up.
