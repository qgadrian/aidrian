# Personas

A persona is one of the people who use a project's product: a waiter, a restaurant owner, a professor, a backend
developer. The project writes each one as a knowledge doc, and the `persona-audit` skill walks the product as that
person and reports what they would hit: friction, confusing copy, missing or wrong translations, dead ends, and
whether each of their tasks can be done. Personas are synthetic: a run is a lead for the Human, not a substitute for real users.
The `quorum` skill's product mode also interviews one before a decision's options exist, and walks it through the recommendation, as a hypothesis no ruling may rest on alone.

## The persona contract

A persona is one Markdown doc in a knowledge bucket, tagged `personas` in the bucket's index. Its file name without
`.md` is the persona id, such as `floor-manager`, unique across every bucket and source; `all` is reserved, since
it runs every persona. It has these `## ` sections:

| Section | Required | What it holds |
| --- | --- | --- |
| `Who` | yes | Their role, and how technical they are, in plain words. |
| `Goals` | yes | What they want from the product. |
| `Tasks` | yes | One `### <task>` each, with a `Success:` line: an outcome a run can observe, not a feeling. |
| `Cares about` | yes | What they judge the product on. |
| `Does not care about` | yes | What a run skips for them. |
| `Context` | yes | Device, language, how often they use it, and anything else that shapes their judgment. |
| `Voice` | no | How they would say it, for the report's quotes. |
| `Evidence` | no | Where the persona comes from: interviews, support tickets, data. |

`aidrian lint personas` checks every doc tagged `personas`: each required section is present and not empty, `Tasks`
has at least one `### <task>`, every task has a `Success:` line with an outcome after it, no two tasks of a doc share a
title (`--task` and the report name a task by its title), no two docs share an id (two `product-access` docs included),
and no doc is named `all.md`. It warns, and still passes, when a task's `Success:` paragraph holds a span in double
quotes, straight or typographic, or in backticks, which reads as the product's text: an outcome is written in the
persona's words, so it holds when the copy changes or another language shows. A run carries each warning into the report's `## Persona doc gaps`.
It names each doc by its path as the bucket gives it:
relative to the project, or absolute for a doc from a [local source](project-folder.md#local-knowledge-sources).
A project with no personas passes. The skill ships a template that passes it:
[persona-template.md](../plugins/aidrian/skills/persona-audit/references/persona-template.md).

A new persona is a new doc. Personalization lives in the doc, in `Cares about`, `Voice`, and `Context`; there are no config keys.

## Writing a persona

A persona doc describes the person's relationship with the product: their goals, how familiar they are with it, where
and how they use it, and the outcomes they would observe. It never describes the product's screens, menu names, rules,
or copy. Product rules stay in the project's `product_sensitive` knowledge, which a run never loads, and `product-access`
holds only how a session reaches the product and what it may touch.

- Start from market and user research, such as interviews, support tickets, and data, and name it in `Evidence`.
  A persona written from the product's feature list restates the product.
- A task is a real job the person has, in their words, whether or not the product does it today.
  Keep a job the product cannot do: [A run](#a-run) says how a run reports it.
- One persona per person. A task whose job differs per business mode is one `### <task>` per mode, each with a title
  that names the mode, such as `Seat a walk-in party (tables)` and `Book a treatment (services)`.
- `Who` names the one familiarity the walk starts from. The doc may say real users range wider.
- `Context` names the persona's language. The walk runs in it, so a `Success:` line names the outcome, never the
  product's words or a screen's name: English screen text would never match a Spanish walk.
- A section the contract does not name, such as `## Open questions`, is allowed. The lint ignores it, and a run reads
  it as the doc's own notes.

Before writing, answer these five questions. The template's comment lists them too.

1. Who is this person, in one sentence with no product term?
2. What do they want, and what is the job behind each task?
3. What would they see when a task is done, in their words?
4. What device, language, and rhythm shape their judgment?
5. Where did each answer come from?

## Product access

The doc named `product-access`, tagged `personas` too and exempt from the lint, says how a session reaches the product:
a URL and a demo account, a simulator command, an API base URL and its docs, and what is off limits. It is optional;
without it, a run asks the Human once, then falls back to screenshots or code.
[product-access-template.md](../plugins/aidrian/skills/persona-audit/references/product-access-template.md) shows its shape.
It names where a secret comes from, never the secret.

Each account in `Accounts` names its plan and the features it lacks: a task behind a plan or feature the demo account
lacks is not reached, with that reason, never a product gap. Three sections are optional, and a doc without them is
read as before:

- `Before a walk`: the start command and the URL it serves, the environment variables that must be set, by name, the
  ports that must be free before the start, and the hosts a sign-in redirect returns to. A run checks them before the first task; when
  the check fails, it walks nothing, says what failed in `Not reached`, and falls back to `seen` or `read`.
- `Allowed changes`: the data a run may change, whether an environment is shared with other sessions, and whether the
  reset command is safe while another session uses it; where it is not, a run walks without the reset. Any other data
  change is off limits.
- `Where each task lives`: one line per persona task, `<persona id>: <task title>: <screen, route, or command>, with
  <account>`, naming the account when `Accounts` lists more than one; a task with no line uses the first account
  `Accounts` lists.

`Off limits` stays a list of what a run never does.

## A run

The `persona-audit` skill takes one or more persona ids, or `all`, and a scope: the whole product, the tasks named
with `--task`, or `--pr <number>`, the tasks that pass through a screen, route, endpoint, command, or string a changed
file defines, renders, or serves, kept when unsure. Before walking more than one persona's whole product, it lists each
persona and its task count and asks the Human to confirm or narrow. With several personas, it walks once per persona
and merges the findings into one report, each labeled with its persona; a persona without a `--task` skips it.

The persona does each task with only what `Who` says they know and what the product gives them: its screens, or for a
technical persona its public docs, SDK, `--help`, and responses, as `product-access` names them. Never the source behind them.

Each task records its evidence level, the best the session had:

- `walked`: the session operated the product with a tool that both acts and reads the result, such as a browser tool,
  a simulator tool that taps and reads the screen, or `curl`, and did the task. With `--pr`, only the pull request's head counts.
- `seen`: screens or responses exist for it, such as the [visual review](review.md#visual-review)'s captures, but no walk.
- `read`: only code, copy, and locale files.

A task outcome, `done` or `blocked`, is claimed only when `walked`; an `out of scope` task has no evidence level,
and any other task in scope is `not walked`. At `seen` or `read`, the run reports only what the persona would see
along the task: copy, a string shown as its key or in another language, a screen with no way forward.

Every finding is `observed`, citing a saved screenshot, the exact text on a screen, a response, or a `file:line`, or
`opinion`, the persona's judgment, naming the line of `Cares about` it comes from. A walked finding lists its steps
and quotes the persona; a finding that was not walked has no quote. Each has a severity: `blocker` only for a walked,
observed finding whose task is blocked, else `friction` or `polish`; and an owner: `ux-specialist`, `designer`,
`frontend-developer`, `backend-developer`, `product-manager`, or the project's docs owner for developer docs and
examples, or the project's own agent for that surface. The persona judges only what it sees; the session reads code
only to locate a finding for its owner.

A task the product cannot do is a finding only from a walk: walked and blocked, the code read after it picks the
owner, `ux-specialist` for a capability the persona did not reach and `product-manager` for one with no screen, route,
endpoint, or command. At `seen` or `read` it gets no finding: `Not reached` lists it, with what was searched and
`product-manager` as the one to ask. The walk stays within the tasks in scope: an idea that comes up in character is
not walked, and the report lists it under `Persona doc gaps` as a suggested task, which the author adds with a `Success:` line for the next run to walk.

A run reaches the product only the way `product-access` says, keeps to its `Off limits`, and never pays, messages a
real person, changes data outside the demo account, or writes a secret or personal data into the report.

The report goes to `<state>/audits/<personas>-<date>.md` in the [state folder](project-folder.md#local-state), with any
screenshots it cites in a folder of the same name. The skill never edits code, files an issue, posts to a pull
request or opens one, and never signs off. With `--pr`, the report is input to the Human's review of a user-facing
change; it never approves, blocks, or posts. A project that wants a persona pass in its sign-off wires the skill in by its own rules.
