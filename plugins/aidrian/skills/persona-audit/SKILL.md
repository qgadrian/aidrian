---
name: persona-audit
description: Walk the product as one of its personas, like a user test, and report friction, copy, translation gaps, and task outcomes, with owners. Read-only.
---

# persona-audit

Walk the product as one of the people who use it, and report what that person would hit: friction, confusing copy,
missing or wrong translations, dead ends, and whether each of their tasks can be done.
The project writes its personas as knowledge docs; this skill is the run.

Read-only: it never edits code, docs, or config, files an issue, posts to a pull request or opens one, and never
signs anything off. It writes only under `<state>/audits/`: the report, and the screenshots it cites.
The Human picks what follows.

Before you start, follow the `knowledge` skill. Knowledge tags: `i18n` when the product ships more than one language.
Name both parties as the start hook's `Names:` line does; outside a persona's quoted words, never write "you" or "me" in the report.

## Arguments

```text
<persona>... [--task "<task>"]... [--pr <number>]
```

- `<persona>`: a persona id, the doc's file name without `.md`, such as `floor-manager`. Several run one after another,
  into one report. `all` runs every persona. With none, list the ids and ask which.
- Scope, one of: the whole product, every task of each persona (the default); `--task`, only the `### <task>` named;
  `--pr`, only the tasks the pull request's diff touches.

## 1. Load the personas

1. `aidrian-knowledge index` prints each doc's path and tags. Each doc whose tags include `personas` is a persona,
   except `product-access`; the persona id is its file name without `.md`.
   None: stop, and point the Human to [references/persona-template.md](references/persona-template.md). Never invent a persona.
2. `aidrian lint personas`. A persona that fails it is skipped, with the lint's line in the report: a doc without
   a `Success:` line per task cannot be judged. Without the command, hold each doc to the template's sections.
3. Read only the chosen personas, each whole, and `product-access` when it exists
   ([references/product-access-template.md](references/product-access-template.md) shows its shape).
4. Scale: before walking more than one persona's whole product, list each persona and its task count, and ask the
   Human to confirm or narrow. With `--task` and several personas, a persona without that task skips it, with a line
   in what the run could not reach.
5. With `--pr`, read the diff (`gh pr diff <number>`, read-only). For each task, name the screens, routes, endpoints,
   commands, or strings it passes through, found by searching the code for the names the task uses. Keep the task when
   a changed file defines, renders, or serves one of them, or changes a string it shows; unsure: keep it.
   Each other task is `out of scope`. No task kept: say so in the report and stop.

## 2. Reach the product, and pick the evidence level per task

Read [references/reaching-the-product.md](references/reaching-the-product.md) before the first task: the levels
`walked`, `seen`, and `read`, the tools each needs, which build a `--pr` run may walk, and the safety rules.
Use the best level the session has and record it on every task.

## 3. Walk each task, as the persona

For each persona, for each task in scope:

1. Start where the persona starts: their device (the nearest width `product-access` lists), and their language,
   from `## Context`, where the tool allows.
2. Do the task with only what `## Who` says they know and what the product gives them: its screens, or for a
   technical persona its public docs, SDK, `--help`, and responses (`product-access` names them). Never the source behind them.
3. Record each step: what the persona did, and what came back, as a screen or a response.
4. The outcome, from the `Success:` line: `done` when the outcome was observed, `blocked` with where and why.
   Only a `walked` task has an outcome; any other is `not walked`, whatever the code suggests.
5. Note along the way what `## Cares about` makes them notice: extra steps, waits, copy they would misread, text in
   another language or a raw string key, a dead end, an error. Skip what `## Does not care about` lists.

At `seen` or `read`, with no walk: go through the screens or the code path in the task's order, and report only what
the persona would see there: copy, a string shown as its key or in another language, a screen with no way forward.
No outcome, no step record, and no quote: a quote needs a walk.

The persona judges only what it sees. After the walk, the session may read code to locate a finding for its owner,
never to judge as the persona.

## 4. Write each finding

Read [references/report-format.md](references/report-format.md) before the first finding: the finding's shape,
its label (`observed` with a citation, or `opinion`), its severity, and the table that names its owner by the
`knowledge` skill's agent rule. Never put words in a persona that its doc does not support.

Several personas: walk once per persona, then merge. One finding two personas share is written once, naming both.
A gap in a persona doc, such as a task the product no longer has, is a finding about the doc, with no owner.

## 5. Report

Write the report to `<state>/audits/<personas>-<date>.md`, where `<state>` is the folder `aidrian state` prints,
`<personas>` the ids joined by `+`, or `all` when the run was given `all`, and `<date>` today as `YYYY-MM-DD`.
When the file exists, add `-2`, `-3`. Its shape is in [references/report-format.md](references/report-format.md).

Then reply to the Human with the report's path, each persona's task table, the blockers, and what the run
could not reach, and say that personas are synthetic and do not replace real users.
With `--pr`, the report is input to the Human's review: it never approves, blocks, or posts to the pull request.
