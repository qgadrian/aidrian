# CODING AGENTS: READ THIS FIRST

This is a **handoff bundle** from Claude Design (claude.ai/design).

A user mocked up designs in HTML/CSS/JS using an AI design tool, then exported
this bundle so a coding agent can implement the designs for real.

> **Fixture note.** This is the committed verification fixture for the
> `design-import` workflow — it is intentionally minimal, not a real product
> export. It exists so the workflow can be exercised end-to-end and so every
> file-classification path has coverage:
>
> - two generations of the Home screen (`v1-home.jsx`, `v2-home.jsx`) → the
>   multi-variant `needs_input` stop fires (classified *translate*);
> - one editor-harness file (`tweaks-panel.jsx`) → harness-discard path
>   (classified *discard*);
> - one mock-data file (`ts-shared.jsx`) → mock-data-discard path (classified
>   *discard*);
> - one icon-set file (`ts-icons.jsx`) → icon-set path (classified
>   *translate*);
> - `components.jsx` and `colors_and_type.css` → shared-UI and token paths
>   (classified *translate*).

## What you should do — IMPORTANT

**Find the primary design file under `project/` and read it top to bottom.**
Then **follow its imports**: open every file it pulls in (shared components,
CSS, scripts) so you understand how the pieces fit together before you start
implementing.

**If anything is ambiguous, ask the user to confirm before you start
implementing.** It is much cheaper to clarify scope up front than to build the
wrong thing.

## About the design files

The design medium is **HTML/CSS/JS** — these are prototypes, not production
code. Your job is to **recreate them** in whatever technology fits the target
codebase. Match the visual output; do not copy the prototype's internal
structure unless it happens to fit.

## Bundle contents

- `README.md` — this file
- `project/` — the `Example Home` project files:
  - `index.html` — entry; lists every `.jsx` in load order
  - `app.jsx` — root render + artboard list (the de-facto screen index)
  - `colors_and_type.css` — design tokens
  - `components.jsx` — shared UI primitives
  - `ts-icons.jsx` — icon set
  - `ts-shared.jsx` — mock data + shared constants
  - `v1-home.jsx`, `v2-home.jsx` — two generations of the Home product screen
  - `tweaks-panel.jsx` — editor-harness file (not a product screen)
