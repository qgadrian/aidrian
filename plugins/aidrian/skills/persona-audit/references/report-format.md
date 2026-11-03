# Persona audit report format

The shape of a finding and of `<state>/audits/<personas>-<date>.md`. Read it before the first finding.

## A finding

Each finding has:

- the persona and the task;
- a label: `observed`, with a citation, or `opinion`, the persona's judgment, naming the line of `## Cares about`
  it comes from. A finding with no citation is an `opinion`. An `observed` finding cites a screenshot the run saved,
  when the tool can save one; else the URL or screen and the exact text seen, quoted; or a response's status and an
  excerpt of its body. At `read`, it cites a `file:line`;
- the evidence level, and a severity: `blocker`, the task cannot be done; `friction`, done at a cost; or `polish`.
  `blocker` is only for a `walked`, `observed` finding whose task is `blocked`; at `seen` or `read` the most is `friction`;
- for a `walked` finding, the steps that reach it, and the persona's words: one or two sentences in their `## Voice`
  when the doc has one. A finding that was not walked has neither: a quote needs a walk;
- the technical finding, where in the code when found, and its owner, picked by the `knowledge` skill's agent rule:

| Finding | Owner |
| --- | --- |
| A flow: extra steps, a dead end, a confusing order; copy the persona misreads, or a wrong translation | `ux-specialist` |
| Layout, hierarchy, contrast, something hard to see or tap | `designer` |
| A broken screen, a client error, a string not translated or shown as its key | `frontend-developer` |
| A wrong response, a server error, an unclear API error message | `backend-developer` |
| Developer docs, an SDK example, or `--help` text that fails the task | the project's docs owner, else `backend-developer` |
| A missing capability, a product rule, a promise the copy makes | `product-manager` |

## A task the product cannot do

A product gap is a finding only from a walk.

- A `walked` task that is `blocked`: after the walk, the session reads code to locate it, and that read picks the owner.
  The capability exists and the persona did not reach it: a dead end, for `ux-specialist`. No screen, route, endpoint,
  or command for the capability: a missing capability, for `product-manager`. Either is `observed`, citing the screen
  or response, and a `blocker`, because the task was walked and is `blocked`.
- At `seen` or `read`, a task whose capability the run cannot find gets no finding and no severity. Its task row stays
  `not walked`, and `## Not reached` lists it as `no screen, route, or endpoint found for <task>`, naming what was
  searched and `product-manager` as the one to ask.
- A task behind a plan or feature the demo account lacks, as `product-access` says, is not reached, with that reason:
  never a product gap.

## The report

Keep the headings and their order; leave out a section only where it says so.

```markdown
# Persona audit: floor-manager, owner, 2026-11-03

Scope: pull request #123, the tasks its diff touches (or: the whole product; or: the tasks named).
Reached: walked at the pull request's head, http://localhost:3000, with the demo account from product-access (or what stopped a walk).
Personas are synthetic: this report is a lead for the Human, not a substitute for real users.

## Tasks

| Persona | Task | Evidence | Outcome |
| --- | --- | --- | --- |
| floor-manager | Seat a walk-in party | walked | done |
| floor-manager | Move a booking to another table | walked | blocked: no table offered after the move |
| floor-manager | Read tonight's covers | read | not walked |
| owner | Read tonight's covers | read | not walked |
| owner | Export the guest list | - | out of scope |

## Findings

### F1. blocker: a moved booking cannot be saved

- Persona: floor-manager. Task: Move a booking to another table. Evidence: walked. Label: observed.
- Steps: open tonight's floor plan; tap the 20:00 booking on table 4; tap Move; pick table 7.
- In their words: "I picked the new table and it just sat there. The party is at the door."
- Seen: the Save button stays disabled after a table is picked (`floor-manager+owner-2026-11-03/move-3.png`).
- Finding: the table picker never sets the form's table field; `src/bookings/MoveDialog.tsx:84`.
- Owner: `frontend-developer`.

### F2. friction: "Covers" means nothing to these personas

- Personas: floor-manager, owner. Task: Read tonight's covers. Evidence: read. Label: observed.
- Cited: the dashboard title is "Covers"; `locales/en.json:12` "covers.title". Cares about: plain words.
- Finding: the title uses an industry term the personas do not; "Guests tonight" says what the number counts.
- Owner: `ux-specialist`.

## Not reached

- What the run could not see, and why: no simulator, a task behind a payment, a screen with no demo data.
- A persona skipped by `aidrian lint personas`, with the lint's line.
- At `seen` or `read`: `no screen, route, or endpoint found for <task>`, what was searched, and `product-manager` to ask.
- A task behind a plan or feature the demo account lacks, with that reason.

## Persona doc gaps

- Leave this section out when there are none: a doc that is unclear or contradicts itself, a Success line that cannot
  be observed, a lint warning from `aidrian lint personas`, with its line.
- Suggested task for floor-manager: Join two tables: seat a party of eight at two free tables for four; from Goals:
  "Seat every guest quickly, without double-booking a table."
```

- Number findings `F1`, `F2`, in severity order: `blocker`, then `friction`, then `polish`.
- A screenshot the run saves goes in `<state>/audits/<report name>/`, beside the report, and the report cites its path.
- An outcome other than `not walked` or `out of scope` needs `walked` in the Evidence column.
  An `out of scope` task was not looked at, so its Evidence is `-`.
- A suggested task is an idea that came up in character during the walk, beyond the tasks in scope. It was not walked
  and has no finding. Its shape: `Suggested task for <persona id>: <title>: <the job, one line>; from <the Goals or
  Cares about line it comes from>`. The author adds the ones worth walking, with a `Success:` line, and the next run walks them.
