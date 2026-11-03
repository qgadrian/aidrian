# Persona audit report format

The shape of `<state>/audits/<personas>-<date>.md`. Keep the headings and their order; leave out a section only
where it says so.

```markdown
# Persona audit: floor-manager, owner, 2026-11-03

Scope: pull request #123, the tasks its diff touches (or: the whole product; or: the tasks named).
Reached: walked at http://localhost:3000 with the demo account from product-access (or what stopped a walk).
Personas are synthetic: this report is a lead for the Human, not a substitute for real users.

## Tasks

| Persona | Task | Evidence | Outcome |
| --- | --- | --- | --- |
| floor-manager | Seat a walk-in party | walked | done |
| floor-manager | Move a booking to another table | walked | blocked: no table offered after the move |
| owner | Read last month's revenue | read | not walked |
| owner | Export the guest list | none | out of scope |

## Findings

### F1. blocker: a moved booking cannot be saved

- Persona: floor-manager. Task: Move a booking to another table. Evidence: walked. Label: observed.
- In their words: "I picked the new table and it just sat there. The party is at the door."
- Seen: the Save button stays disabled after a table is picked (`floor-manager+owner-2026-11-03/move-3.png`).
- Finding: the table picker never sets the form's table field; `src/bookings/MoveDialog.tsx:84`.
- Owner: `frontend-developer`.

### F2. polish: "Covers" means nothing to an owner

- Personas: owner, floor-manager. Task: Read tonight's covers. Evidence: read. Label: opinion (Cares about: plain words).
- In their words: "Covers? I want to know how many guests are coming."
- Finding: the dashboard title uses an industry term; `locales/en.json:12` "covers.title".
- Owner: `product-manager`.

## Not reached

- What the run could not see, and why: no simulator, a task behind a payment, a screen with no demo data.
- A persona skipped by `aidrian lint personas`, with the lint's line.

## Persona doc gaps

- Leave this section out when there are none: a task the product no longer has, a Success line that cannot be observed.
```

- Number findings `F1`, `F2`, in severity order: `blocker`, then `friction`, then `polish`.
- A screenshot the run saves goes in `<state>/audits/<report name>/`, beside the report, and the report cites its path.
- An `observed` finding cites what was seen: a screen, a response, or a `file:line`. An `opinion` names the line of
  `## Cares about` it comes from.
- An outcome other than `not walked` or `out of scope` needs `walked` in the Evidence column.
