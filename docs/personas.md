# Personas

A persona is one of the people who use a project's product: a waiter, a restaurant owner, a professor, a backend
developer. The project writes each one as a knowledge doc, and the `persona-audit` skill walks the product as that
person and reports what they would hit: friction, confusing copy, missing or wrong translations, dead ends, and
whether each of their tasks can be done. Personas are synthetic: a run is a lead for the Human, not a substitute for real users.

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
has at least one `### <task>`, every task has a `Success:` line with an outcome after it, no two docs share an id
(two `product-access` docs included), and no doc is named `all.md`. It names each doc by its path as the bucket gives it:
relative to the project, or absolute for a doc from a [local source](project-folder.md#local-knowledge-sources).
A project with no personas passes. The skill ships a template that passes it:
[persona-template.md](../plugins/aidrian/skills/persona-audit/references/persona-template.md).

A new persona is a new doc. Personalization lives in the doc, in `Cares about`, `Voice`, and `Context`; there are no config keys.

## Product access

The doc named `product-access`, tagged `personas` too and exempt from the lint, says how a session reaches the product:
a URL and a demo account, a simulator command, an API base URL and its docs, and what is off limits. It is optional;
without it, a run asks the Human once, then falls back to screenshots or code.
[product-access-template.md](../plugins/aidrian/skills/persona-audit/references/product-access-template.md) shows its shape.
It names where a secret comes from, never the secret.

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

A run reaches the product only the way `product-access` says, keeps to its `Off limits`, and never pays, messages a
real person, changes data outside the demo account, or writes a secret or personal data into the report.

The report goes to `<state>/audits/<personas>-<date>.md` in the [state folder](project-folder.md#local-state), with any
screenshots it cites in a folder of the same name. The skill never edits code, files an issue, posts to a pull
request or opens one, and never signs off. With `--pr`, the report is input to the Human's review of a user-facing
change; it never approves, blocks, or posts. A project that wants a persona pass in its sign-off wires the skill in by its own rules.
