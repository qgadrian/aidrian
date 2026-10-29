# Lenses and briefs

Read this file in step 3, before a spawn or a refresh.
It holds the cold brief, the refresh message, and one lens per agent.
An agent with no section here gets the generic lens.

## Cold brief

Fill every placeholder and send the result as the spawn prompt.
The agent's lens decides the brief shape: `diff` sends the diff, `ac` sends the linked issue's acceptance criteria first, then the diff.

```text
You are running a focused <agent> review of a branch that is still in progress, not a pull request.
Follow the `knowledge` skill first, and load only the docs this review needs.

# Scope
Branch: <branch>
Base: <base_ref> @ <base_sha, 7 characters>    Head: <head_sha, 7 characters>
Linked issue: <key "title" (state)>, or none found
Diff: <file_count> files, <diff_lines> lines, <full | summary> mode

Changed files:
<one path per line>

[ac shape only] Acceptance criteria:
<the linked issue's criteria, verbatim; or "none found">

Diff:
<diff_body>

# Lens
<the numbered questions from the agent's section>

# Not yours
<the agent's "not yours" line>. Name that owner in a finding's next step; do not judge it yourself.

# Weighing what you find
Spend your time on what users and operators hit in normal use.
Do not construct rare combinations of conditions to break the change. When you notice one, report it as contrived and move on.
Report every finding you see, with its axes:
- severity: critical (harm no one can undo), high (breaks a main flow), medium (degrades a flow), low (polish)
- likelihood: routine (normal use), plausible (one realistic condition), contrived (a coincidence of rare conditions)
- affects: users, operators, revenue, or internal (only developers and tooling see it)
- cost: trivial, bounded, or structural (a migration, a contract change, or a redesign); leave it out when bounded
The skill turns the axes into a verdict, so a contrived finding becomes an accepted residual, not a fix.

# Return
The machine handoff from the `knowledge` skill, with `findings`: one object per finding with
severity, likelihood, affects, cost, file, line, summary, next_step, and state "open". Use [] when you found nothing.
<the agent's "nothing to review" line>
```

## Refresh message

```text
The branch moved since your last review. For each finding you raised before:
- set state "resolved" when the new diff addresses it, and cite the change;
- keep state "open" when it does not;
- change its axes only when the change shifts its impact.
Add any new finding the update brings, with state "open".

# Updated scope
<the Scope block of the cold brief, with Head: <head_sha, 7 characters> (was <stored head_sha, 7 characters>)>

Return the same handoff. Start decision with the counts: "<r> resolved, <o> still open, <n> new".
```

## architect

Shape: `diff`.

1. Boundaries: does the change keep module boundaries and the dependency direction? Lower layers never import higher ones,
   and shared code never imports a feature.
2. Extension: which likely next changes does this make harder?
3. New shared abstractions: justified at this size, or premature?
4. Reuse: an existing helper or pattern the change should have used. The project's `code_style` knowledge names them.
5. A critical flow (the project's `product_sensitive` knowledge names them) whose trust or isolation the change weakens:
   flag it for `security-engineer`.

Not yours: product rules (`product-manager`), per-file code quality (`code-reviewer`), presentation (`designer`),
exploitability (`security-engineer`).
Nothing to review: return `done` with the decision "no structural change in this diff".

## backend-developer

Shape: `diff`.

1. Correctness: error propagation, guard clauses, early returns, the scope of error handling, side effects.
2. Data integrity: schema changes and migrations, default values, idempotency, races.
3. API shape: validation at the boundary, response shape, status codes, pagination, authorization checks.
4. Runtime cost: a query per item in a loop, unbounded reads, missing caching.
5. Persistence: transaction boundaries, retries, and what happens to a job that keeps failing.
6. Reuse: a helper the change rebuilt instead of calling.

Not yours: presentation (`designer`), product rules (`product-manager`), structure (`architect`),
exploitability (`security-engineer`; flag trust-boundary code for it).
Nothing to review: return `done` with the decision "no server-side change in this diff".

## designer

Shape: `diff`.

1. Component reuse: does the change rebuild a shared component? Cite the existing one.
2. Tokens: spacing, colour, and type come from the project's tokens (its `design_bundle` knowledge), not hand-picked values.
3. Consistency with the neighbouring screens of the same flow.
4. Accessibility: focus states, contrast, labels, touch targets.
5. Layout at the screen widths the project checks.
6. Hover, focus, disabled, loading, and empty states: present and consistent.

Not yours: task success (`ux-specialist`), code quality (`code-reviewer`), product rules (`product-manager`).
Nothing to review: return `done` with the decision "no UI change in this diff".

## ux-specialist

Shape: `diff`.

1. Task success: can a user finish the affected flow without new friction?
2. Recovery: error, empty, and loading states say what to do next.
3. Load: new fields, steps, or choices that do not pay for themselves.
4. Small screens: anything that gets worse at narrow widths.
5. Interruption: a refresh, the back button, or a half-filled form keeps what the user entered.
6. The product's primary flows, named in its `product_sensitive` knowledge: does the change keep them clear?

Not yours: visual polish (`designer`), whether a step should exist at all (`product-manager`), code (`code-reviewer`).
Nothing to review: return `done` with the decision "no user-facing change in this diff".

## product-manager

Shape: `ac`.

1. Acceptance criteria: does the change meet each one? With none found, review against the project's product rules
   and add a risk that no criteria were loaded; missing criteria alone are not a reason for `needs_input`.
2. Product rules in the project's `product_sensitive` knowledge: does the change put one at risk?
3. Missing product truth: name the exact decision a user-visible change needs and the docs do not settle,
   and return `needs_input` with `decision_options`.
4. Copy: new or changed user-facing text fits the product's voice.
5. Reach: other entry points, plans, or languages the change should also have covered.

Add `critical_flow` with a `sign_off` for each critical flow the change touches.
Not yours: code quality, structure, presentation, exploitability, and end-to-end test runs.
Nothing to review: return `done` with the decision "no product behaviour change in this diff".

## security-engineer

Shape: `diff`.

1. Authentication and authorization: a missing role or membership check.
2. Tenant isolation, and records fetched by an id the caller controls.
3. Validation at each trust boundary the project's `security` knowledge names.
4. Redirects, file handling, HTML rendering, and external content.
5. Webhook and callback verification, and replay.
6. Secrets and personal data in code, logs, or error messages.

Lead each finding with who can realistically reach it and what they gain.
Not yours: product policy (`product-manager`), trade-offs that are not about security (`architect`).
Nothing to review: return `done` with the decision "no trust boundary in this diff".

## Generic lens

Shape: `diff`. For any other agent, such as a project's convention reviewer or front-end developer.

1. Review the change through your own agent instructions and the project's knowledge for your area.
2. Stay within the work your agent description names.

Not yours: anything outside that work.
Nothing to review: return `done` with the decision "nothing in this diff for <agent>".
