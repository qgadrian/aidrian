# Persona audit: front-desk, 2026-05-02

Scope: the whole product, every task of front-desk.
Reached: read only: no browser tool in the session.
Personas are synthetic: this report is a lead for the Human, not a substitute for real users.

## Tasks

| Persona | Task | Evidence | Outcome |
| --- | --- | --- | --- |
| front-desk | Take a repair by phone or at the counter | read | not walked |

## Findings

### F1. friction: the part note sits behind a collapsed "Optional" section

- Persona: front-desk. Task: Note a part. Evidence: read. Label: observed.
- Cited: `src/repairs/RepairForm.tsx:40` collapses "Optional" by default.
- Owner: `ux-specialist`.

### F2. friction: the second language names the drop-in three ways

- Persona: front-desk. Task: Check a bike in. Evidence: read. Label: observed.
- Cited: `locales/second.json:12`, `locales/second.json:30`.
- Owner: `ux-specialist`.

### F3. polish: the second language mixes formal and informal address

- Persona: front-desk. Task: Take a repair. Evidence: read. Label: observed.
- Cited: `locales/second.json:44`.
- Owner: `ux-specialist`.

## Not reached

- Every walk: no browser tool.
