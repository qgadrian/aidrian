# Personas

A persona is one of the people who use a project's product: a waiter, a restaurant owner, a professor, a backend
developer. The project writes each one as a knowledge doc, and the `persona-audit` skill walks the product as that
person and reports what they would hit: friction, confusing copy, missing or wrong translations, dead ends, and
whether each of their tasks can be done. Personas are synthetic: a run is a lead for the Human, not a substitute for real users.
The `quorum` skill's product mode also interviews one before a decision's options exist, and walks it through the recommendation, as a hypothesis no ruling may rest on alone.
A team that sets [review later](config.md#automatic-product-quorums) lets work continue on such a recommendation until the Human reviews it,
so the report says the end user was simulated.

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
  product's words or a screen's name: screen text in the product's first language would never match a walk in its second.
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

Each account in `Accounts` names its role, its plan, and the features it lacks: a task behind a plan or feature the demo
account lacks is not reached, with that reason, never a product gap. A run signs in as each persona's role with the
seeded account `Accounts` names for it. With none, it sets one up only within `Allowed changes`, writes the setup as
steps the next run can repeat, and lists the missing seed as a doc gap; with no allowed way, the tasks that need the
role are not reached. Three sections are optional, and a doc without them is
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

Before the first walk, a run checks that it can reach each persona's width and every product host the tasks pass
through, and tells the Human before walking when it cannot. A browser that will not resize falls back to device
emulation, then to a window opened at a set size; a width or host still out of reach is a `Not reached` line.

A defect seen more than once whose cause the run did not trace is marked `needs_trace`. After the walk, and only with
the Human's yes, a read-only `explorer` trace may add a likely cause, labeled as likely and never confirmed.

A run reaches the product only the way `product-access` says, keeps to its `Off limits`, and never pays, messages a
real person, changes data outside the demo account, or writes a secret or personal data into the report.

The report goes to `<state>/audits/<personas>-<date>.md` in the [state folder](project-folder.md#local-state), with any
screenshots it cites in a folder of the same name, each cited by its full path from the audits folder, never by a
suffix such as `-24.jpg`. Beside it, `<personas>-<date>.json` is its sidecar: the same findings, Not reached lines,
and doc gaps as JSON, for the [triage](#triage). A run that repeats an earlier report's personas and tasks replaces
it: the report says so, and the sidecar names it in `supersedes`, with the earlier findings it covers in
`carried_forward` and those it did not re-check in `not_rechecked`. `aidrian audits check <report>` validates the sidecar. The skill never edits code, files an issue, posts to a pull
request or opens one, and never signs off. With `--pr`, the report is input to the Human's review of a user-facing
change; it never approves, blocks, or posts. A project that wants a persona pass in its sign-off wires the skill in by its own rules.

## Triage

The `persona-audit-triage` skill takes each item of a report to a decision with the Human: each finding, each
`Not reached` line, each doc gap, and each finding of a replaced report that the new run did not re-check.
A final decision is one of `issue`, `fix-now`, `duplicate`, `drop`, `defer`, `documented`, or `covered`.
`documented` means the product works as a doc says, and cites it as `path#section`; the skill prefers it to `drop`.
`covered` is a `Not reached` line of an imported report that restates the replaced report's findings not re-checked,
which `pending` offers with those findings, so the Human decides them once. `decided` comes before a final one: a
product decision an issue needs first, with the decision and who took it; the item stays untriaged until it reaches
a final decision. A report is fully triaged when every item has a final one.

A triage priority, `urgent`, `high`, `medium`, or `low`, is set apart from the audit's severity, which is never
rewritten: a reviewer re-ranks a finding with it, and `pending` shows it beside the finding, first in its group.
Each decision and priority records who made the pick, `human` or the role of the agent whose pick the Human adopted.
The tracker is the one the project's `issue_tracker` knowledge names. With none, the skill asks for it as its own
question before any finding, naming no finding and recommending none from the remote, or, in `auto`, defers every item and says why. It asks one question at a time and stops,
with at most a line on what comes next.
The skill searches the tracker for an existing issue by the finding's words, the surface it touches, and the issues
opened or updated since the audit, before the audit label, and shows the Human any open issue whose decision a
triage decision would contradict before it drafts one. The skill sends a finding about a product rule, or an open question in a product doc, to `product-manager`
first; it drafts an issue with `agent-issue-writer` and creates it in the project's tracker. It names owners in plain
words, from each finding's `owner_description`.

[Audit triage](config.md#audit-triage) in config.json sets two things. `audits.triage.issueCreation` is `confirm` by
default: each draft is shown, and no issue, route, or label is created until the Human says yes. `auto`
creates issues without asking, for unsupervised runs: it files what it would recommend as an issue or a duplicate,
defers everything else, including a finding `product-manager` does not settle, records every decision, and ends with
the issues it created. `audits.triage.labels` gives every issue the `persona-audit` label, one per persona, and one
for its severity by default; the duplicate search queries the plain label as well as the finding's words. Each issue
body names its source in words, such as `Source: the front-desk walk on 2026-05-02, finding "a drop-in is not shown as
a drop-in" (<path>)`, and keeps the item's machine key, `<report file>#<id>`, out of sight in a footer.

Keys are for machines only: the sidecar, `triage.json`, and the arguments of `aidrian audits record` hold them. What a
person reads, a report, a question, a summary, an issue, or the commands' text output, names a finding by its title and
a report by its personas, kind, and date, such as "the front-desk read-only run on 2026-05-02", with a path only as a
location. A second report with the same words gets an ordinal: "the second front-desk walk on 2026-05-02".

The decisions live in `<state>/audits/triage.json`, never in the repository, keyed by report file and item id:

```json
{ "version": 1, "reports": { "floor-manager-2026-11-03.md": { "F1": { "decision": "issue", "issue": "ABC-12", "url": null, "reason": null, "doc": null, "by": "human", "date": "2026-11-04", "priority": { "value": "high", "set_by": "product-manager", "reason": null, "date": "2026-11-04" } } } } }
```

`aidrian audits` reads and writes them; `--project <dir>` runs it for another project:

Their text output is for a person: it names each report by its personas, kind, date, and run, such as "the front-desk
walk of 2026-05-02, run 2", and each item by its title, never by its id or file name. `--json` carries the ids and
file names the other commands take.

- `list [--json]`: each report with its finding count and untriaged items. A replaced report shows `replaced by
  <report>`, and its items count toward the report that replaced it: before that report's import, every finding of
  the replaced one, which has no decision until the import sorts it, and after it, those not re-checked. A report with no sidecar shows
  `no sidecar: import needed`; one whose sidecar is invalid names the first problem.
- `check <report>`: refuses a sidecar whose `supersedes` names a report the folder lacks, or whose `carried_forward` or
  `not_rechecked` names a finding that report does not hold; so do `import` and `list`, which shows it as invalid. It warns, and still passes, on a task named by its number, such as "Task 2". It validates the sidecar: every required key, finding, `N` and `D` id, evidence paths that name
  files and are never a suffix, a blocker only when walked and observed, no id in both `carried_forward` and
  `not_rechecked`, and the report's finding headings matching the sidecar's findings by title. It prints `ok` or each problem.
- `import <report> [--not-rechecked IDS] [--carried-forward IDS] [--from FILE] [--write]`: drafts the sidecar of a
  report written without one, best effort, from its prose, and prints it with warnings for what the prose could not
  settle, such as the findings of a replaced report, by title, to sort into carried forward and not re-checked;
  `--json` gives one object, with `replaced`, each of those titles with its key. Those include what the replaced report
  still carries from a run before it, keyed `<file>#<id>`: a finding left open stays open down a chain of replacements,
  whether or not a later run names it, until it has a final decision or a sidecar lists it in `carried_forward`. A screenshot cited by a suffix becomes the
  one file in the report's folder that ends with it. `--write` validates the draft and writes it; it never overwrites a sidecar.
  Without `--json`, it ends with the next step: each of the replaced report's findings, led by its title, with the key
  the flags take, and the `--write` command ready to edit.
- `pending <report> [--json]`: the untriaged items in the order the Human answers them, each group headed
  `<Severity>, for <owner in plain words>`, after a line on how issues are created and which label the duplicate
  search starts from: each blocker alone, the other findings grouped by severity and owner, the replaced report's
  findings not re-checked with any `Not reached` line that restates them, proposed as `covered`, the other `Not
  reached` lines, then doc gaps.
  With `--json`, it also gives `issue_creation`, the mode, `search_labels`, the plain labels, and for each item its
  `labels`, its `source` line for an issue body, its `audit_key`, its `verdict`, `held`, and its `allowed_decisions`. An older report's line that names a task by its
  number is shown as stored, marked `numbered_task` and with a note, so the session says which task in words.
- `record <report> <keys> <decision> [--issue KEY] [--url URL] [--reason TEXT] [--doc PATH#SECTION] [--by WHO]`:
  records one decision for each key, and keeps each item's priority. A key is the item's `audit_key`,
  `<report file>#<id>`, as `pending --json` gives it with the item's exact `record` command, or a bare id of the
  report's own items; a key names one finding even when the walk and the run it replaces both hold the same id.
  Several keys, joined by commas, are recorded in one write: when one names no item, nothing is written. `issue` and `duplicate` need `--issue` or `--url`; `drop` and
  `covered` need `--reason`; `decided` needs `--reason`, the decision, and `--by`; `documented` needs `--doc`, a file
  of the project and one of its headings, as written or as its slug, kept as the slug. `--by` is `human` or an agent role. A finding of a replaced report is recorded under
  that report. It refuses an id the report does not offer, and a `triage.json` it cannot read.
- `verdict <report> <keys> breaks|conforms|silent --by ROLE --reason TEXT`: records a [rule verdict](#rule-verdicts),
  which changes no item's state.
- `rank <report> <keys> urgent|high|medium|low --by WHO [--reason TEXT]`: sets the item's triage priority, and keeps
  its decision.

While any report holds untriaged items, the main session's [start lines](hooks.md#start-lines) say how many, in how
many reports; the count includes `Not reached` lines and doc gaps, and a report without a sidecar counts the items its
prose holds.

### Rule verdicts

A finding reports what a person experienced, and a rule it cites is a lead to check. Before an issue may call a change
a conformance fix, or say it needs no product decision, `product-manager`, or the project's product owner, gives a
verdict: `breaks` the rule, `conforms` to it, or `silent`, the docs do not settle it. A finding needs one when its draft
would state or imply what the rule is, or when it asks to change behaviour rather than fix a defect the product itself
reports as an error; a plain crash or broken string needs none. The verdict quotes the rule with its path and section,
and follows a term the rule leaves undefined, such as an amount or a limit, into the docs that define it.

A verdict is evidence, not a decision, and recording one changes no item's state:
`verdict <report> <keys> breaks|conforms|silent --by <role> --reason '"<rule>" <path#section-slug>'`, with a `silent`
saying what was searched. It is kept in the item's entry as `verdict`, through later decisions. The command checks that
`breaks` and `conforms` cite a section that exists. After `conforms` or `silent` the item is held: `pending --json`
marks it `held`, and prints each item's `allowed_decisions`, and `record` refuses `issue` and `fix-now`, and `documented`
after `silent`. `record ... decided --by human`, a delegated answer included, releases the hold and keeps the decision on
the verdict as `settled`; an agent's own `decided` releases nothing. `auto` defers a held item. Verdicts are asked for
one question at a time, the blocker before its question and the others when their group comes up.

A held item's question asks the Human for the product decision, with a recommended answer and the verdict in one plain
line; issue options come only after it. Whether a verdict was asked for at all is the skill's rule, not the command's:
it cannot see what a draft will claim.
