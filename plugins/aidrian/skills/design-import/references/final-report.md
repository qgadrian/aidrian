# Final report contract

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
   1. Review `docs/design-imports/<slug>/plan.md` with the `plan-review`
      skill, and approve or refine the plan — the human gate before any code.
   2. Run the `plan-implement` skill on that plan — it executes
      the plan slice-by-slice (`designer` owns visual slices,
      `frontend-developer` owns the gated data-wiring slices), with screenshot
      evidence plus the `designer` deviation-ledger review as each screen
      slice's closure gate. Slice state lives in the plan file, so the run is
      safe to resume after an interruption.
   3. Review the draft PR that `plan-implement` opens through the `pr-write` skill.
   When blocked, replace this checklist with the explicit question to
   resolve.
