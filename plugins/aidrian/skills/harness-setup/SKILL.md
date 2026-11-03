---
name: harness-setup
description: Set up aidrian in a project in one guided session, or check a set-up project and say what to fix. Asks first; shows docs before writing.
disable-model-invocation: true
---

# harness-setup

Before you start, follow the `knowledge` skill.

Take a project from no aidrian setup to a checked one in one session, or, on a set-up project, say what to fix.
This skill asks its questions before any write, and shows the docs before they are written.
It writes no project file itself: `harness-librarian` makes every setup write; in step 6, the owner the fix table names.
It never commits, pushes, opens a pull request, or files an issue, in the project's tracker or the plugin's repository.
It never sets `AIDRIAN_ALLOW_MAIN_WRITE` or adds a `git.mainCheckout.allowWrites` entry. No dispatch passes a model or effort.
When a librarian dispatch returns `blocked`, such as a config guard denying a config write,
print the exact config.json or `.aidrian.local.json` lines for the Human to add, and go on.

The project root is `git rev-parse --show-toplevel`. The plugin root is this skill's folder plus `../..`, as an absolute path.
Run `aidrian` and `aidrian-knowledge` from the PATH; when they are not on it, run them from `<plugin root>/bin/`.
Read `references/dispatches.md` before the first dispatch: it holds every librarian brief, each with the plugin root.

## 1. Readiness

Check, read-only, and print each item as `R<n> ok` or `R<n> missing`:

- R1: `.aidrian/config.json` exists.
- R2: at least one `.aidrian/knowledge/*.json` index exists.
- R3: `AGENTS.md` holds `` indexed in `.aidrian/knowledge/` `` and `CLAUDE.md` holds `@AGENTS.md`.
- R4: config.json has a `github.reviewer` key, or the Human confirms the default in this run (Q2).
- R5: `aidrian check` exits 0.

All five ok: step 6. R4 the only one missing: ask Q2 now. Yes: R4 ok, step 6.
No: one `harness-librarian` dispatch with the R4 brief, which writes `github.reviewer: null` and nothing else, then step 6.
Otherwise onboard from the first missing item; later steps skip what already holds.

**Guarded main checkout.** When config.json has `git.mainCheckout.guard: true` and
`git rev-parse --path-format=absolute --git-dir --git-common-dir` prints one folder twice, the session is in the main checkout:
write nothing. R4 the only one missing still asks Q2, and a yes goes to step 6. Report only the items that need a write,
with their fixes, and say to run this skill again from a task worktree (`aidrian worktree new <branch>`).

**Done when** the five items are printed.

## 2. Ask

Take each answer the request already gives as given. Ask only the missing ones, one at a time:
AskUserQuestion in Claude Code, one question in the reply in Codex. Skip a question whose answer already holds.

| Question | Holds when | Choices, default | Where the answer goes |
| --- | --- | --- | --- |
| Q1 Tracker | `aidrian-knowledge tags` lists `issue_tracker` | Linear with its team key, GitHub Issues with `owner/repo`, or none | A doc tagged `issue_tracker`, through `knowledge-update`. None: no doc. Never a config key. |
| Q2 Review bot | R4 ok | Does the Codex GitHub connector review this repository's pull requests? Default yes | No: `github.reviewer: null`. Yes: nothing written; R4 counts as confirmed. |
| Q3 Docs folder | R2 ok | A folder of Markdown docs; default `docs` when it holds `.md` files; or none | `aidrian-knowledge init <folder>`. None: new docs go to `docs/knowledge/`. Never a config key. |
| Q4 Names | config.json or `.aidrian.local.json` sets `names` | Two names and a scope, asked as written below; default `the Human` and the host's name | Team: config.json `names`. One developer: the git-ignored `.aidrian.local.json`. Default: nothing written. |
| Q5 Main-checkout guard | config.json has `git.mainCheckout.guard: true` | Turn it on? Default no | `git.mainCheckout.guard: true`, the last write of the run. |
| Q6 Team install, Claude Code only | `.claude/settings.json` has both keys of the setup block | Commit `.claude/settings.json` so Claude Code offers the plugin to everyone? Default yes | The settings block of `references/setup-files.md`. In Codex, not asked: the report prints that file's Codex install link. |

Never show a question's `Q` label. Ask Q4 as `references/names-question.md` writes it.

**Done when** every question is answered or skipped.

## 3. Dispatch 1: set up and propose

Dispatch `harness-librarian` once with the step 3 brief. It runs `aidrian init` and `aidrian-knowledge init`,
writes config.json, `AGENTS.md`, `CLAUDE.md`, and the settings file, skipping what holds.
Then it runs `knowledge-update` on the topics `working-agreement`, `testing`, `architecture`,
and `issue-tracker` when Q1 is not none, and returns the proposal as `needs_input`.

**Done when** the librarian returned its `pending_commit` and the proposal.

## 4. Approve, then dispatch 2: write and check

Print the proposal under a line `Proposed docs:`, and offer: write as shown, change something, or cancel.
When the request already approved it, print it and go on.
Run dispatch 2 only when docs were approved or Q5 is yes.
Continue the same librarian when the host keeps it, else dispatch it again, with the step 4 brief:
it writes the docs, runs `aidrian check` and `aidrian lint` until both exit 0, writes `git.mainCheckout.guard: true`
when Q5 is yes as the very last write, and runs `aidrian check` once more, read-only.
When the checks cannot pass, it returns `blocked` naming what the Human must approve, and writes no guard.
After the last dispatch, run `aidrian check` and `aidrian lint` here, read-only, for the report.

**Done when** this session ran both commands after the last dispatch.

## 5. Report onboarding

In this order, printing each label in backticks as is, at the start of its own line: never bold, rename, or merge it.

1. The five items after the run, one line each: `R1 ok` ... `R5 ok`, or `missing` with the fix.
2. Each answer applied, in write order, one line each: `<key>: <value>` (such as `github.reviewer: null`,
   `names: default`, `git.mainCheckout.guard: true` last), or `<file>: written`; in Codex, the install link.
3. The line `Docs written:`, then each doc with its mode; the line `Docs skipped:`, then each with why. Either list empty: `none`.
4. Every line the step 4 `aidrian check` and `aidrian lint` printed, unchanged.
5. `git status --porcelain`, and the commit to make:
   `chore(aidrian): set up the project folder and first knowledge docs`. When the guard was written in the main checkout,
   say the Human makes that commit from a terminal before creating any task worktree.

**Done when** the report has all five parts.

## 6. Check a set-up project

Load and follow the `harness-health` skill, and relay its report.
A `not_enough_data` or `unavailable` signal is reported as such, never offered as a fix.
For a problem whose fix the Human accepts, dispatch only two fixes, each told "do not commit; return `pending_commit`":
`split-doc` to `harness-librarian`, and a fix for one of the project's own agents to the agent that owns its file.
For every other fix row, relay the fix and the lesson `harness-health` offers.
In a guarded main checkout, dispatch nothing: say to apply the fix from a task worktree.
With nothing written, end the report with `changed no file`.

**Done when** the report ends with what changed, or `changed no file`.
