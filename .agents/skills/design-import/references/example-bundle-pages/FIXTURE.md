# Fixture — current page-based primary provider Design layout

Committed verification fixture for the `design-import` workflow, matching
the **page-based canvas layout** observed in the
`hospitality-booking-modal-revisited-6` export (see "Observed layouts" in
`docs/ai-rules/shared/claude-design-bundle.md`). Intentionally minimal, not a
real product export. A real bundle of this shape has no
`README.md`/`FIXTURE.md` — recognition is invariant-based, so this note does
not affect classification.

Coverage this fixture exercises:

- **Marker recognition without `README.md`/`project/`** — root `.html` pages
  with CDN React + Babel and a `DesignCanvas`/`DCSection`/`DCArtboard` index.
- **Canonical-source resolution → proceed** — `Home.html` is a consolidated
  outcome page (its notes board declares the outcome and retires the wizard),
  so ingestion proceeds with it; `Home Explorations.html` is read-only
  rationale. This is NOT a multi-variant stop.
- **vN = surfaces, not generations** — `v1.jsx` is the canonical Home screen;
  `v2.jsx` is a retired wizard only the explorations page loads.
- **Notes-board extraction** — `FinalNotes` in `Home.html` carries decisions
  the design import must capture.
- **Tweaks defaults** — `TWEAK_DEFAULTS` marks the approved configuration.
- **Artboard widths** — Desktop · 1280 and Mobile · 390 form the fit matrix.
- **Mixed `shared.jsx` classification** — icon + primitive exports are
  *translate*; `EX_ITEMS` mock data is *discard*.
- **Variable token filename** — tokens live in `example-tokens.css`,
  identified by content.
- **Harness discard** — `design-canvas.jsx`, `tweaks-panel.jsx`.
