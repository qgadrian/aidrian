# Generated plan — slice requirements

The skill instructs `planning-agent` to author a plan that conforms to the
Plan-File Schema in the `planning-agent` skill (its `references/plan-file.md` and
`references/design-import-plan.md`) with these
design-import specifics:

- **`plan_kind: technical-design`.** A design import has no tracker issue, so
  the issue-driven `plan_kind: implementation` does not apply. The frontmatter
  omits `issue_id` / `issue_ref` / `ticket_updated_at`; it records the
  bundle path, the chosen page/variant, and the slug.
- **Plan home.** The plan is written to the committed path
  `docs/design-imports/<slug>/plan.md` — **not** `<state>/plans/`, which is
  machine-local. The committed home keeps the spec, inventory, curated source,
  and plan as one durable, PR-reviewable unit.
- **Re-runs revise the existing plan; `plan_kind` stays `technical-design`.**
  Re-running this skill against an existing slug updates the plan in
  place under `planning-agent`'s revision rules — it does **not** flip
  `plan_kind` to `revision`. The frontmatter keeps `plan_kind:
  technical-design`; `generated_at` is bumped; completed slices are preserved
  byte-for-byte; new scope is appended as new slices; and the change is
  recorded as a new entry in a top-level `## Revision history` section.
- **One slice per approved screen.** A separate slice covers shell / nav when
  it is in scope.
- **Each slice `primary_owner` is `designer` or `frontend-developer`.**
- **Each screen slice's `verification_path`** includes the project's typecheck,
  lint, and the exact tests for the touched components (its `testing` knowledge names them),
  **plus visual fit checks at the widths the bundle's
  artboards declare** (fall back to 360 / 768 / 1280px only when the source
  declares no widths) **and screenshot-vs-artboard evidence for every
  artboard in the slice's coverage table** — produced with the
  project's screenshot tool (for example a `design-verify` skill) — with a
  `designer` review of the resulting pairs.
- **Each screen slice inherits the fidelity contract** of the project's
  visual-implementation rules: the per-artboard
  coverage table from `inventory.md`, the deviation ledger, and the
  `parity_status` / `fit_status` / `interpretation_status` handoff fields are
  required outputs of the slice — a slice handoff missing them is incomplete.
- **Visual slices and data-wiring slices are separated.** Visual / presentation
  slices proceed by default. Data-wiring and behavior slices are ordered after
  the visual shell and are marked `needs product-manager + architect
  sign-off`.
- **Token-divergence slice.** When `design-source-explorer` recorded a
  token-divergence flag in `DESIGN.md` (see workflow step 3 — divergence is a
  proceed-with-flag outcome, not a stop), `planning-agent` emits slice `S0` as
  the design-system-token decision and change. `S0` is gated on `designer` +
  `architect` + `product-manager` sign-off and is an `upstream_dependency` of
  every screen slice — no screen slice may start until `S0` is signed off.
  When `DESIGN.md` records no divergence, there is no `S0` and screen slices
  start at `S1`.
