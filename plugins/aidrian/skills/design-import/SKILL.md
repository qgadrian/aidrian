---
name: design-import
description: Bring a Claude Design handoff bundle into the repo as an implementation-ready design import. Use on /design-import, "import a design export", or a bundle path.
user-invocable: true
---

# design-import

Ingest a Claude Design (`claude.ai/design`) handoff bundle into the project. The
skill resolves the bundle, dispatches `design-source-explorer` to classify it
and write a durable design import under `docs/design-imports/<slug>/`,
dispatches `planning-agent` to produce a technical-design plan the
implementation specialists can execute from, then commits the import.

This is the project's design-to-code entry point. It never writes production code,
never opens a PR, never closes anything, and never bypasses git hooks. It
does not load the project's `design_bundle` knowledge into its own context —
the specialists it dispatches load it through the `knowledge` skill.

`design-source-explorer` and `planning-agent` are this plugin's agents: spawn them as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.
`designer`, `frontend-developer`, `architect`, and `product-manager` are roles the project supplies.

Implementation runs separately: after the plan exists, the user reviews it
and runs the project's plan-implementation flow, which executes the plan
slice-by-slice through `designer` and `frontend-developer`.

## Design-source specs (per-tool)

Generic implementation rules are tool-agnostic and live in the project's
`design_bundle` knowledge, next to one recognition spec per design tool:

- Claude Design → the project's Claude Design bundle spec (the only
  supported tool today). The spec is invariant- and role-based because Claude
  Design's export format drifts; its self-healing rule keeps ingestion
  working on unseen layouts while routing a spec update to `doc-updater`.
  Without a spec, `design-source-explorer` classifies from first principles and records the gap.
- A future tool → add a sibling spec under the same tag; this skill and the
  generic rules do not change.

## Argument grammar

```
/design-import <bundle-path> [--slug <slug>] [--variant <id>]
```

- **`<bundle-path>`** (required) — a local folder or a local zip of a Claude
  Design handoff bundle. If missing, ask once and proceed.
- **`--slug <slug>`** (optional) — the design-import slug; defaults to a name
  derived from the bundle directory or zip filename (lowercased, non-`[a-z0-9]`
  runs collapsed to `-`, leading/trailing `-` stripped). The import is
  committed to `docs/design-imports/<slug>/`.
- **`--variant <id>`** (optional) — resumes after an unresolvable-source
  `needs_input` stop. The `<id>` is one of the page / generation / variant
  identifiers the prior run listed.

## Stop semantics

- **stop** — abort and surface a structured report.
- **stop and ask** — surface a specific question that needs a user answer.

## Workflow

1. **Accept arguments.** Resolve `<bundle-path>`, `<slug>`, and `<variant>`.
   Confirm the bundle path exists on disk. If it does not → **stop and ask**.

2. **Dispatch `design-source-explorer`** with the bundle
   path, the slug, and the chosen variant when one was supplied. The explorer
   recognizes the bundle by markers, resolves the canonical design source
   (page / surfaces), classifies every file per
   the project's bundle spec, and — when unblocked —
   writes the design import to `docs/design-imports/<slug>/` (`DESIGN.md`,
   `inventory.md`, curated `source/`).

3. **Handle the explorer result.** `design-source-explorer` can return two
   classes of outcome — a hard `needs_input` stop, or a recorded flag that the
   pipeline continues past.
   - **Unresolvable canonical source (STOP).** If the bundle holds competing
     pages, generations, or variants with no declared outcome (a bundle with
     a clearly-consolidated outcome page is NOT this case — the explorer
     proceeds with it), the explorer returns `needs_input`. Relay the listed
     candidates to the user and **stop**. The user re-invokes
     `/design-import <bundle-path> --slug <slug> --variant <id>`. Never invent
     a choice to push past this stop.
   - **Malformed bundle / missing source (STOP).** If the bundle is malformed
     (no entry page satisfying the spec's invariants) or the source cannot be
     resolved, the explorer returns `needs_input`. Relay the explicit gap and
     **stop**. Format drift alone is not malformed — the explorer proceeds
     and records a `format_drift` note per the spec's self-healing rule;
     surface that note in the final report.
   - **Token divergence (PROCEED).** If the bundle tokens materially diverge
     from the repo tokens, this does **not** stop the pipeline. The explorer
     records a token-divergence flag in `DESIGN.md` (with `designer` +
     `architect` + `product-manager` named as the decision owners). The skill
     continues to step 5; `planning-agent` then emits a gated `S0`
     design-system-token slice for that decision. Surface the flag in the
     final report so the user knows `S0` exists and who must sign it off.

4. **Re-invocation with `--variant`.** When re-invoked with `--variant` after
   an unresolvable-source stop, the explorer proceeds with the chosen
   page/variant and writes the design import.

5. **Dispatch `planning-agent`** to author the generated
   plan per the **Generated plan — slice requirements** section below. The
   plan is written to `docs/design-imports/<slug>/plan.md`.

6. **Mechanical contract check.** When the project has a design-import lint
   (its `design_bundle` knowledge names it), run it after the plan is written. A failure means `design-source-explorer` or
   `planning-agent` produced a structurally non-conformant artifact — route
   the fix back to that specialist before reporting success; never hand the
   user a plan that fails the committed contract.

7. **Commit the design import.** Commit `docs/design-imports/<slug>/` (and the
   superseded banner in an older import's `DESIGN.md`, when the explorer added
   one) as one commit through the project's normal git hooks. The dispatched
   agents only write files; this is the one commit the skill makes.

8. **Recommend a plan review, then stop.** Surface the final report; tell the
   user to review `docs/design-imports/<slug>/plan.md` before
   implementation. Implementation is a separate run; this skill does not implement.

## Generated plan — slice requirements

The skill instructs `planning-agent` to author a plan that conforms to the
Plan-File Schema in the `planning-agent` skill with these
design-import specifics:

- **`plan_kind: technical-design`.** A design import has no GitHub issue, so
  the issue-driven `plan_kind: implementation` does not apply. The frontmatter
  omits `issue_id` / `issue_ref` / `ticket_updated_at`; it records the
  bundle path, the chosen page/variant, and the slug.
- **Plan home.** The plan is written to the committed path
  `docs/design-imports/<slug>/plan.md` — **not** `.aidrian/plans/`, which is
  git-ignored. The committed home keeps the spec, inventory, curated source,
  and plan as one durable, PR-reviewable unit.
- **Re-runs revise the existing plan; `plan_kind` stays `technical-design`.**
  Re-invoking `/design-import` against an existing slug updates the plan in
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

## Blocking rules

- Presentation / visual work proceeds by default.
- **Data-wiring, behavior, and design-system-token changes require explicit
  `product-manager` + `architect` sign-off** before implementation. For token
  changes the sign-off is enforced as the gated `S0` slice in the generated
  plan; the ingestion pipeline itself is not stopped.
- **An unresolvable canonical source** and **a missing or malformed bundle**
  each return `needs_input` and stop the pipeline — never a guess.
- **Token divergence does not stop the pipeline.** It is recorded as a flag in
  `DESIGN.md` and becomes the gated `S0` plan slice. This is the one design
  decision the workflow carries forward as a plan slice rather than a stop.
- Opt-in invocation only. The skill runs when the user invokes it; it does not
  auto-trigger implementation.

## Output (final report contract)

A single concise report. Skip a section if it has nothing to say.

1. **Verdict** — `done — design import + plan ready` (use this even when the
   plan carries a gated `S0` token-divergence slice — the divergence is a plan
   slice, not a blocker) / `done — plan revised` / `needs input —
   unresolvable canonical source` / `partial — blocked on <reason>`.
2. **Design-import path** — `docs/design-imports/<slug>/` with the committed
   files listed (`DESIGN.md`, `inventory.md`, `source/`, `plan.md`).
3. **Canonical source chosen** — the page / generation / variant the import
   was built from, and which pages were recorded as read-only rationale.
   Include any supersession decision: which earlier import this one
   supersedes (its `DESIGN.md` now carries the superseded banner), or the
   additive cross-reference recorded instead.
4. **Plan summary** — title, slice count, ordered slice IDs with one-line
   goals, the visual-vs-data-wiring split, declared `status`.
5. **Decisions surfaced** — flagged token-divergence or product-sensitive
   decisions and their owning specialists.
6. **Next steps** — every successful run ends with the remaining pipeline
   spelled out (each step is one user command; the work inside is
   agent-executed), so the user never has to remember it:
   1. Review `docs/design-imports/<slug>/plan.md` and approve or
      refine the plan — the human gate before any code.
   2. Run the project's plan-implementation flow on that plan — it executes
      the plan slice-by-slice (`designer` owns visual slices,
      `frontend-developer` owns the gated data-wiring slices), with screenshot
      evidence plus the `designer` deviation-ledger review as each screen
      slice's closure gate. Slice state lives in the plan file, so the run is
      safe to resume after an interruption.
   3. Open the draft PR the project's way, then review and publish it.
   When blocked, replace this checklist with the explicit question to
   resolve.

## Hard rules

- **No production code, no PRs, no commits of source.** The skill never edits
  application source and never runs `git commit`/`git push` on production code. The only
  commit is the design import under `docs/design-imports/<slug>/`, written by
  `design-source-explorer` and `planning-agent` and committed by the skill in
  workflow step 7 under the git-hook hard wall — never with `--no-verify` or
  any hook bypass.
- **No bloat in skill context.** The skill does not Read the project's
  `design_bundle` knowledge into its own context. Specialists load it through the `knowledge` skill.
- **Project knowledge is authoritative.** See the `knowledge` skill § Precedence.
- **The bundle is a visual source only.** It is never a logic or product
  source. Data-wiring and behavior stay gated on `product-manager` +
  `architect`.
- **Never guess past a blocking stop.** Unresolvable-source and
  malformed-bundle stops are relayed verbatim; the user resolves them. Token
  divergence is not a stop — it is flagged into a gated `S0` plan slice and
  the pipeline proceeds (see workflow step 3 and **Blocking rules**).
- **Stateless sub-agents.** Every dispatch includes the context that agent
  needs; never paste this skill or the parent conversation verbatim.
- **Concise final report.** No restating the bundle contents.

## Cross-references

- The project's `design_bundle` knowledge — the bundle spec (invariants,
  role-classification procedure, self-healing format-drift rule) and the
  fidelity contract implementation slices inherit.
- The `design-source-explorer` agent — the bundle explorer.
- The `planning-agent` skill — the Plan-File Schema.
