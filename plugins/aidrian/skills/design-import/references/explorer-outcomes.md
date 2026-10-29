# Explorer outcomes and blocking rules

Workflow step 3 of the skill: handle each `design-source-explorer` outcome as below.

## Outcomes

- **Unresolvable canonical source (STOP).** If the bundle holds competing
  pages, generations, or variants with no declared outcome (a bundle with
  a clearly-consolidated outcome page is NOT this case — the explorer
  proceeds with it), the explorer returns `needs_input`. Relay the listed
  candidates to the user and **stop**. The user re-runs this skill with
  `<bundle-path> --slug <slug> --variant <id>`. Never invent
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
