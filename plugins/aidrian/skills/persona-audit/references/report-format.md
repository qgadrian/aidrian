# Persona audit report format

The shape of a finding, of `<state>/audits/<personas>-<date>.md`, and of its sidecar. Read it before the first finding.

Sections: A finding; An untraced cause; A task the product cannot do; The report; A run that replaces a report; The sidecar.

## A finding

Each finding has:

- the persona and the task;
- a label: `observed`, with a citation, or `opinion`, the persona's judgment, naming the line of `## Cares about`
  it comes from. A finding with no citation is an `opinion`. An `observed` finding cites a screenshot the run saved,
  when the tool can save one; else the URL or screen and the exact text seen, quoted; or a response's status and an
  excerpt of its body. At `read`, it cites a `file:line`;
- the evidence level, and a severity: `blocker`, the task cannot be done; `friction`, done at a cost; or `polish`.
  `blocker` is only for a `walked`, `observed` finding whose task is `blocked`; at `seen` or `read` the most is `friction`;
- every screenshot cited by its full path from the audits folder, `<report name>/<file>`, each time it is cited:
  never a suffix such as `-24.jpg`, which names no file for the reader or the triage;
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

## An untraced cause

A defect the walk saw more than once, such as "seen 3 times out of 3", whose cause the session did not find, says so
in its `Finding:` line ("where it is chosen was not traced") and gets `needs_trace: true` in the sidecar.
After the walk, and only when the Human agrees, the session may hand such findings to the `explorer` agent for a
read-only trace. Its answer goes in the finding as `Likely cause (explorer trace, not confirmed): <what and where>`,
and in the sidecar as `likely_cause`; it never changes the finding's label, severity, or owner.

## A task the product cannot do

A product gap is a finding only from a walk.

- A `walked` task that is `blocked`: after the walk, the session reads code to locate it, and that read picks the owner.
  The capability exists and the persona did not reach it: a dead end, for `ux-specialist`. No screen, route, endpoint,
  or command for the capability: a missing capability, for `product-manager`. Either is `observed`, citing the screen
  or response, and a `blocker`, because the task was walked and is `blocked`.
- At `seen` or `read`, a task whose capability the run cannot find gets no finding and no severity. Its task row stays
  `not walked`, and `## Not reached` lists it as `no screen, route, endpoint, or command found for <task>`, naming what
  was searched and `product-manager` as the one to ask.
- A task behind a plan or feature the demo account lacks, as `## Accounts` lists, is `not walked`, and `## Not reached`
  gives that reason: never a product gap.

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
| floor-manager | Check how busy tonight is | read | not walked |
| owner | Check how busy tonight is | read | not walked |
| owner | Export the guest list | - | out of scope |

## Findings

### blocker: a moved booking cannot be saved

- Persona: floor-manager. Task: Move a booking to another table. Evidence: walked. Label: observed.
- Steps: open tonight's floor plan; tap the 20:00 booking on table 4; tap Move; pick table 7.
- In their words: "I picked the new table and it just sat there. The party is at the door."
- Seen: the Save button stays disabled after a table is picked (`floor-manager+owner-2026-11-03/move-3.png`).
- Finding: the table picker never sets the form's table field; `src/bookings/MoveDialog.tsx:84`.
- Owner: `frontend-developer`.

### friction: "Covers" means nothing to these personas

- Personas: floor-manager, owner. Task: Check how busy tonight is. Evidence: read. Label: observed.
- Cited: the dashboard title is "Covers"; `locales/en.json:12` "covers.title". Cares about: plain words.
- Finding: the title uses an industry term the personas do not; "Guests tonight" says what the number counts.
- Owner: `ux-specialist`.

## Not reached

- What the run could not see, and why: no simulator, a task behind a payment, a screen with no demo data.
- A persona skipped by `aidrian lint personas`, with the lint's line.
- At `seen` or `read`: `no screen, route, endpoint, or command found for <task>`, what was searched, and
  `product-manager` to ask.
- A task behind a plan or feature the demo account lacks, with that reason.

## Persona doc gaps

- Leave this section out when there are none: a doc that is unclear or contradicts itself, a Success line that cannot
  be observed, a lint warning from `aidrian lint personas`, with its line, or a suggested task.
- Suggested task for floor-manager: Join two tables: seat a party of eight at two free tables for four; from Goals:
  "Seat every guest quickly, without double-booking a table."
```

- Order findings by severity: `blocker`, then `friction`, then `polish`. A heading is `### <severity>: <title>`, with no
  number: the sidecar keys each finding by its place, `F1` for the first, and only the sidecar holds those keys.
- A person reads the report, so it never names a finding or a report by a key or a file suffix: another finding by its
  title, such as "as in a moved booking cannot be saved", and another report by persona, kind, and date, such as
  "the floor-manager read-only run on 2026-11-03", with its path once, as its location.
- A screenshot the run saves goes in `<state>/audits/<report name>/`, beside the report, and the report cites its path.
- An outcome other than `not walked` or `out of scope` needs `walked` in the Evidence column.
  An `out of scope` task was not looked at, so its Evidence is `-`.
- A suggested task is an idea that came up in character during the walk, beyond the tasks in scope. It was not walked
  and has no finding. Its shape: `Suggested task for <persona id>: <title>: <the job, one line>; from <the Goals or
  Cares about line it comes from>`. The author adds the ones worth walking, with a `Success:` line, and the next run walks them.

## A run that replaces a report

A run of the same personas and tasks as an earlier report, at a better evidence level or because the Human asked for
it again, replaces that report. `aidrian audits list` shows the earlier reports. Say so under the header, naming the
report in words with its path, then its findings by title:
``This run replaces the floor-manager read-only run on 2026-11-03 (`<earlier report>.md`).``
``Carried forward: <title>; <title>. Not re-checked: <title>; <title>.``
Carried forward are those a finding of this run covers, the same problem seen again; not re-checked, those this run
did not look at, which the triage offers again. A finding this run re-checked and did not see again is in neither,
and none is in both. In the sidecar, name the earlier report in `supersedes`, and list the same findings, by the keys
the earlier sidecar gives them, in `carried_forward` and `not_rechecked`.

## The sidecar

Beside each report `<name>.md`, write `<name>.json`, the same run for the triage to read. `aidrian audits check
<name>.md` validates it against the report: its findings are the report's finding headings, by title and in order,
and every evidence path names a file. Every key is required except `other_owners`, `cited`, and `likely_cause`.

```json
{
  "version": 1,
  "report": "floor-manager-2026-11-03.md",
  "personas": ["floor-manager"],
  "date": "2026-11-03",
  "supersedes": null,
  "carried_forward": [],
  "not_rechecked": [],
  "findings": [
    {
      "id": "F1",
      "title": "a moved booking cannot be saved",
      "severity": "blocker",
      "label": "observed",
      "evidence_level": "walked",
      "personas": ["floor-manager"],
      "tasks": ["Move a booking to another table"],
      "owner": "frontend-developer",
      "owner_description": "the screens and their code",
      "evidence": ["floor-manager-2026-11-03/move-3.png"],
      "cited": ["src/bookings/MoveDialog.tsx:84"],
      "needs_trace": false
    }
  ],
  "not_reached": [{ "id": "N1", "text": "Tablet width: the browser would not resize below its window width." }],
  "doc_gaps": [{ "id": "D1", "text": "Suggested task for floor-manager: Join two tables: ..." }]
}
```

- `owner` is the agent role; `owner_description` says in plain words what that owner looks after, for the Human who
  triages: "how the product flows and what its words say" (`ux-specialist`), "how the screens look" (`designer`),
  "the screens and their code" (`frontend-developer`), "the server and the answers it gives" (`backend-developer`),
  "what the product should do, and its rules" (`product-manager`); for a project agent, its own job in a few words.
  `other_owners` lists any further roles the `Owner:` line names.
- `evidence` holds the screenshot paths, relative to the audits folder; `cited` holds any other citation: a
  `file:line`, a URL, or the exact text seen. An `observed` finding has at least one of the two.
- `not_reached` and `doc_gaps` hold one item per line of those sections, `N1`, `D1`, in the report's order.
