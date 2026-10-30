---
name: design-import
description: Turn a Claude Design export (folder or zip) into a committed design import and plan.
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

`design-source-explorer`, `planning-agent`, `designer`, `frontend-developer`, `architect`, and `product-manager` are this plugin's agents:
spawn them as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.

Implementation runs separately: after the plan exists, the user reviews it
with the `plan-review` skill and runs the `plan-implement` skill, which executes the plan
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

In Claude Code the skill runs as `/aidrian:design-import`; on any host it takes:

```
<bundle-path> [--slug <slug>] [--variant <id>]
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
   Read `references/explorer-outcomes.md` and act on the outcome it describes:
   an unresolvable canonical source or a malformed bundle **stops**; token divergence **proceeds** with a flag.

4. **Re-invocation with `--variant`.** When re-invoked with `--variant` after
   an unresolvable-source stop, the explorer proceeds with the chosen
   page/variant and writes the design import.

5. **Dispatch `planning-agent`** to author the generated
   plan per the slice requirements in `references/plan-requirements.md`; put them in the dispatch. The
   plan is written to `docs/design-imports/<slug>/plan.md`.

6. **Mechanical contract check.** When the project has a design-import lint,
   `design-source-explorer`'s handoff names its command (from the
   `design_bundle` knowledge); run it after the plan is written. A failure means `design-source-explorer` or
   `planning-agent` produced a structurally non-conformant artifact — route
   the fix back to that specialist before reporting success; never hand the
   user a plan that fails the committed contract.

7. **Commit the design import.** Commit `docs/design-imports/<slug>/`, including
   any `source/` files the explorer deleted on a re-import (and the
   superseded banner in an older import's `DESIGN.md`, when the explorer added
   one) as one commit through the project's normal git hooks. The dispatched
   agents only write files; this is the one commit the skill makes.
   Under the `orchestrator`, which writes no git, `doc-updater` makes it.

8. **Recommend a plan review, then stop.** Surface the final report, shaped as `references/final-report.md` says; tell the
   user to review `docs/design-imports/<slug>/plan.md` before
   implementation. Implementation is a separate run; this skill does not implement.

## Hard rules

- **No production code, no PRs, no commits of source.** The skill never edits
  application source and never runs `git commit`/`git push` on production code. The only
  commit is the design import under `docs/design-imports/<slug>/`, written by
  `design-source-explorer` and `planning-agent` and committed by the skill in
  workflow step 7 with the project's git hooks running — never with
  `--no-verify` or any hook bypass.
- **No bloat in skill context.** The skill does not Read the project's
  `design_bundle` knowledge into its own context. Specialists load it through the `knowledge` skill.
- **Project knowledge is authoritative.** See the `knowledge` skill § Precedence.
- **The bundle is a visual source only.** It is never a logic or product
  source. Data-wiring and behavior stay gated on `product-manager` +
  `architect`.
- **Never guess past a blocking stop.** Unresolvable-source and
  malformed-bundle stops are relayed verbatim; the user resolves them. Token
  divergence is not a stop — it is flagged into a gated `S0` plan slice and
  the pipeline proceeds (see workflow step 3 and `references/explorer-outcomes.md`).
- **Stateless sub-agents.** Every dispatch includes the context that agent
  needs; never paste this skill or the parent conversation verbatim.
- **Concise final report.** No restating the bundle contents.

## Cross-references

- The project's `design_bundle` knowledge — the bundle spec (invariants,
  role-classification procedure, self-healing format-drift rule) and the
  fidelity contract implementation slices inherit.
- The `design-source-explorer` agent — the bundle explorer.
- The `planning-agent` skill — the Plan-File Schema, in its `references/plan-file.md` and
  `references/design-import-plan.md`.
