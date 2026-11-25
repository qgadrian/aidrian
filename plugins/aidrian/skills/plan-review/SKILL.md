---
name: plan-review
description: Review a local plan before anyone implements it. Use when asked to review a plan file. planning-agent proposes a diff; the Human approves it.
---

# plan-review

One critique-and-refine pass before implementation. This session runs the gates and has `planning-agent`
critique the plan, propose a diff, and apply it on the Human's approval. It never commits the plan.

Before you start, follow the `knowledge` skill. Load your `product_sensitive` docs for the critical flows
and `security` docs for the surfaces that need a security pass.

## Inputs

```text
[<plan path> | <issue key or URL>] [--findings-only] [--apply] [--extended] [--quorum | --no-quorum]
```

- A plan path: absolute or from the repository root. An issue key or URL: that issue's plan, as step 1 finds it.
- `--findings-only`: critique without a proposed diff.
- `--apply`: the Human approves the diff this session proposed earlier; go to step 5. Valid only as step 5 says.
- `--extended`: allow one refinement pass more than step 6 does.
- `--quorum`: run step 3b on any plan. `--no-quorum`: skip it.

**stop** ends the run with a report; **stop and ask** adds one question only the Human can answer.

## 1. Find the plan

Plans live in `<state>/plans/`, where `<state>` is the folder `aidrian state` prints.
A design import keeps its plan at `docs/design-imports/<slug>/plan.md` in its worktree, on branch `feat/design-<slug>`.
Skip backups, editor and temporary files, and `.json` files. Without a path, take the first of these that finds a plan:

1. The issue: the argument, else the key in the current branch name, as the project's `issue_tracker` knowledge writes it.
   Look for `<state>/plans/<key>-*.md`, with the key in lowercase, and for a plan whose `issue_id` is the key.
2. A plan whose `workspace_decision.branch_name` is the current branch.
3. The newest plan whose `status` is not `complete`.

Several candidates: list up to five, newest first, and ask. None: stop, and point to the `planning-agent` skill,
or `issue-plan` for an issue. Never build a plan from the conversation.

## 2. Preflight

- Read the plan. With YAML frontmatter it is a schema plan of its `plan_kind`; without `plan_kind`, review it as `implementation`
  and add a finding. Without frontmatter it is a free-form plan, with the generic lens and no penalty for the missing schema.
- `status: complete`: ask whether to review it again.
- An issue-anchored plan whose `ticket_updated_at` is older than the issue's `updatedAt` is stale. Ask: the Human revises it
  with the `issue-plan` skill's `--mode revise`, which only the Human starts; review it as it is; or stop.
  On a critical flow, offer only revise or stop.
- Record the plan's hash, `git hash-object <plan>`, for step 5.

## 3. Gates

Both run before the critique; their verdicts go into its brief as authoritative.
A gate's brief carries the plan path, the trigger (the plan lines and the flow or surface they touch), and the knowledge
docs to check against. It carries nothing of your own: no suspected findings, risks, or hints.
Read [steps/reruns.md](steps/reruns.md) before the first gate or quorum dispatch.

- **Critical flow.** The plan's goal, scope, approach, affected surfaces, or slice files touch a flow the project's
  `product_sensitive` knowledge declares critical (the whole text, for a free-form plan): `product-manager` first.
  `blocked` or `needs_evidence` stops the run with its `decision_options`, attributed: no `authority` covers this gate (`knowledge/references/decisions.md`).
- **Security.** The plan touches auth, sessions, tokens, tenancy, permissions, payments, webhooks, uploads, redirects, secrets,
  untrusted content, privileged access, or a surface the project's `security` knowledge lists: `security-engineer` first.
  Its verdict and required invariants bind the critique; no critique finding drops them.
- **Re-runs.** A re-run with no blocking finding, and every finding `low` or narrower than the last run's, approves,
  its findings carried as implementation notes.

## 3b. Quorum

When a gate in step 3 ran, or the plan names a decision-record path or the `adr-writer` skill, load the `quorum` skill
and follow it, with the gate verdicts and the trigger. Its `references/ledger.md` § Under plan-review defines the
triggers, its reruns under step 3's stop rule and cap, and the `blocked on quorum` stop that resumes here.
Its accepted objections, the Human's answers, and its Report's revision-history line go into step 4's brief as authoritative.
Not installed: skip it.

## 4. Critique

Dispatch `planning-agent` alone, in the foreground. Its brief carries the plan path, the gate verdicts, the flags,
the issue's acceptance criteria and non-goals for an issue-anchored plan, and `references/review-lens.md` from this folder,
which it applies. It consults `product-manager`, `architect`, or `explorer` itself when the lens needs one:
dispatch no consult beside it. When it returns blocked on missing evidence, dispatch `explorer` for that evidence,
then critique once more.

Then report, in this order, and stop:

1. **Verdict**: `plan ready: no findings`, `findings: diff proposed`, `findings only`, or `blocked on <gate or evidence>`.
2. **Plan**: path, `plan_kind` or free-form, `status`, and freshness against the issue.
3. **Gates**: each verdict, or not applicable; the quorum Report's Ledger item with its trigger, or why it was skipped.
4. **Findings**: blocking, important, then improvements, each with its anchor.
5. **Open questions** from the plan, word for word, then **escalations**: product or architecture decisions, scope growth, disputes.
6. **Proposed diff** with its revision-history line, unless `--findings-only`.
7. **Ask**: `apply`, `apply with edits: <edits>`, or `skip`.

## 5. Apply

Only on the Human's explicit `apply` after step 4 in this session: it needs step 2's hash and step 4's diff.
`--apply` without both: refuse, and say to rerun without it.
Then read [steps/apply.md](steps/apply.md) and follow its steps 5.1 to 5.5.

## 6. Cap

One critique, one apply, and one more critique only when step 5.4 finds a new blocking flaw.
`--extended` adds one refinement pass, never more. Past the cap, escalate to the Human.
A restart from step 5.1 starts this count again and waits on the next `apply` like the first.
A gate or the quorum runs at most 3 times a review, the first included, across restarts; past that,
non-blocking findings are carried, and a blocking one escalates.
A consult that returns a dispute stops the run: escalate both positions and the missing evidence; never settle on a compromise.

## Close

The run is done only when each gate is cleared or not applicable, the Human answered step 4, an applied plan passed step 5.4,
the report names each carried finding, and no dispute or blocked consult was dropped. Otherwise report `blocked` or `needs_input` with the step to resume from.

End with the next step: the `issue-implement` skill for an issue-anchored plan, `plan-implement` for any other,
design imports included. The report names a changed design-import plan as a file change.

## Do not

- Critique, rewrite, or restyle the plan yourself, in a report or in any brief, or prefer your structure to the author's when both are valid.
- Apply a change without the Human's approval in this session, or a scope-growing change without its own approval.
- Skip a gate, or loop past the cap.
- Hand work an agent can do to the Human as a follow-up.
