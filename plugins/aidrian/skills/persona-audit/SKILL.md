---
name: persona-audit
description: Walk the product as one of its personas and report friction, copy, translations, and task outcomes, with owners. Read-only.
---

# persona-audit

Walk the product as one of the people who use it, and report what that person would hit: friction, confusing copy,
missing or wrong translations, dead ends, and whether each of their tasks can be done.
The project writes its personas as knowledge docs; this skill is the run.

Read-only: it never edits code, docs, or config, files an issue, posts to a pull request or opens one, and never
signs anything off. It writes only under `<state>/audits/`: the report, and the screenshots it cites.
The Human picks what follows.

Before you start, follow the `knowledge` skill. Knowledge tags: `personas`, plus `i18n` when the product ships more than one language.
Name both parties as the start hook's `Names:` line does; never write "you" or "me" in the report.

## Arguments

```text
<persona>... [--task "<task>"]... [--pr <number>]
```

- `<persona>`: a persona id, the doc's file name without `.md`, such as `floor-manager`. Several run one after another,
  into one report. `all` runs every persona. With none, list the ids and ask which.
- Scope, one of: the whole product, every task of each persona (the default); `--task`, only the `### <task>` named;
  `--pr`, only the tasks whose screens, endpoints, or copy the pull request's diff touches.

## 1. Load the personas

1. `aidrian-knowledge route personas` lists the `always` docs, then the docs tagged `personas`. Each tagged doc is
   a persona, except `product-access`. None: stop, and point the Human to
   [references/persona-template.md](references/persona-template.md). Never invent a persona.
2. `aidrian lint personas`. A persona that fails it is skipped, with the lint's line in the report: a doc without
   a `Success:` line per task cannot be judged. Without the command, hold each doc to the template's sections.
3. Read each chosen persona whole, and `product-access` when it exists
   ([references/product-access-template.md](references/product-access-template.md) shows its shape).
4. With `--pr`, read the diff (`gh pr diff <number>`, read-only), and keep the tasks whose path through the product
   crosses a changed file: a screen, route, endpoint, string, or locale file. Each other task is `out of scope`.
   No task kept: say so in the report and stop.

## 2. Pick the evidence level, per task

Use the best evidence the session has, in this order, and record it on every task:

| Level | Means | Web | Mobile | Backend API or CLI |
| --- | --- | --- | --- | --- |
| `walked` | The session operated the product and did the task | a browser tool the host offers | a simulator or device tool, by the `product-access` command | `curl` or the CLI, at the `product-access` base URL |
| `seen` | Screens or responses exist for it, but no walk | the visual review's captures in the state folder, screenshots on the pull request | screenshots | recorded responses, examples in the API docs |
| `read` | Only code, copy, and locale files | routes, components, strings | screens, string resources | handlers, schemas, error messages |

- Reach the product only the way `product-access` says. Without it, ask the Human once for a URL and a demo account,
  a simulator command, or an API base URL; with no answer or no tool, fall back to `seen` or `read` and say why.
- Use only the accounts and environments `product-access` names. Never pay, send a message to a real person, or
  delete data outside a demo account. Never write a secret into the report.

## 3. Walk each task, as the persona

For each persona, for each task in scope:

1. Start where the persona starts, with their device, screen width, and language from `## Context` where the tool allows.
2. Do the task with only what `## Who` says they know. Never use what the code says to get past a step they could not.
3. Record each step: what the persona did, and what came back, as a screen, a response, or a `file:line`.
4. The outcome, from the `Success:` line: `done` when the outcome was observed, `blocked` with where and why.
   Only a `walked` task has an outcome; any other is `not walked`, whatever the code suggests.
5. Note along the way what `## Cares about` makes them notice: extra steps, waits, copy they would misread, text in
   another language or a raw string key, a dead end, an error. Skip what `## Does not care about` lists.

The persona judges only what it sees. After the walk, the session may read code to locate a finding for its owner,
never to judge as the persona.

## 4. Write each finding

Each finding has:

- the persona and the task;
- a label: `observed`, which cites a screen, a response, or a `file:line`, or `opinion`, the persona's judgment,
  with the line of `## Cares about` it comes from. A finding with no citation is an `opinion`;
- the evidence level, and a severity: `blocker` (the task cannot be done), `friction` (done, at a cost), or `polish`;
- the persona's words, one or two sentences in their `## Voice` when the doc has one;
- the technical finding, where in the code when found, and its owner, picked by the `knowledge` skill's agent rule:

| Finding | Owner |
| --- | --- |
| A flow: extra steps, a dead end, a confusing order | `ux-specialist` |
| Layout, hierarchy, contrast, something hard to see or tap | `designer` |
| A broken screen, a client error, a string not translated or shown as its key | `frontend-developer` |
| A wrong response, a server error, an unclear API error message | `backend-developer` |
| A missing capability, a product rule, a promise the copy makes | `product-manager` |

Several personas: walk once per persona, then merge. One finding two personas share is written once, naming both.
A gap in a persona doc, such as a task the product no longer has, is a finding about the doc, with no owner.

## 5. Report

Write the report to `<state>/audits/<personas>-<date>.md`, where `<state>` is the folder `aidrian state` prints,
`<personas>` the ids joined by `+`, and `<date>` today as `YYYY-MM-DD`. When the file exists, add `-2`, `-3`.
Its shape is [references/report-format.md](references/report-format.md); read it before writing.

Then reply to the Human with the report's path, each persona's task table, the blockers, and what the run
could not reach, and say that personas are synthetic and do not replace real users.
With `--pr`, the report is evidence for the Human's sign-off: it never approves, blocks, or posts to the pull request.

## Rules

- No task outcome without a walk. No `observed` finding without a citation.
- Never put words in a persona that its doc does not support.
- Never edit, file, post, open, or sign off. Write nothing outside `<state>/audits/`.
