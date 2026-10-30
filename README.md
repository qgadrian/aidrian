# aidrian harness

One plugin, `aidrian`, gives Claude Code and Codex a team of agents, skills, and safety hooks.
A project adds only its own rules, as Markdown docs, and a small `.aidrian/` folder that indexes them.

## Install

You need Node 22 or later, and git access to `github.com/qgadrian/aidrian-harness`, which is private.

### Claude Code

```sh
claude plugin marketplace add qgadrian/aidrian-harness
claude plugin install aidrian@aidrian-harness
```

### Codex

Use the SSH URL. Codex clones a short name over HTTPS, which fails when git has no HTTPS credentials.

```sh
codex plugin marketplace add git@github.com:qgadrian/aidrian-harness.git
codex plugin add aidrian@aidrian-harness
node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
```

The last command installs the agents. Then open Codex and trust the plugin's hooks in `/hooks`.

### In CI

CI needs no plugin. Give the job Node 22 or later and read access to this repository, such as a deploy key:

```sh
git clone --depth 1 git@github.com:qgadrian/aidrian-harness.git /tmp/aidrian-harness
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian check
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian lint
```

Updates, install errors, and installing from a checkout: [Claude Code](docs/providers/claude-code.md), [Codex](docs/providers/codex.md).

## Quick start

Run these at the root of the project's repository.
`aidrian` is on the PATH inside a Claude Code session.
Elsewhere, add it first: [Claude Code](docs/providers/claude-code.md#running-aidrian), [Codex](docs/providers/codex.md#running-aidrian).

1. Set up the project folder and index the existing docs:

   ```sh
   aidrian init                  # creates .aidrian/config.json
   aidrian-knowledge init docs   # indexes the docs folder as a knowledge bucket
   aidrian check                 # prints ok, or one line per problem
   ```

2. Commit `.aidrian/` and push it to the default branch. New task worktrees start from there.

3. Start a session with the orchestrator, the agent that splits work and routes each part:

   ```sh
   claude --agent aidrian:orchestrator
   ```

[Adopting in a project](docs/adopting.md) finishes the setup: tags, `always` docs, `AGENTS.md`, and the team's install.

## Concepts

- **Knowledge bucket**: a folder of Markdown docs with one team's rules, and its index in `.aidrian/knowledge/`.
- **Project folder**: `.aidrian/` at the repository root. It holds `config.json` and the bucket indexes.
- **State folder**: one folder per project outside the repository, for plans, handoff briefs, lessons, and the dispatch log.
- **Task worktree**: a git worktree in `.worktrees/`, one per task, so the main checkout stays clean.
- **Dispatch**: one agent handing a task to another. The dispatch log records each one.
- **Slice**: one part of a larger task, built on its own branch.
- **The Human**: what agents call the person running the session. [`names`](docs/config.md#names) changes it.

## What is in the plugin

### Commands

Run `aidrian` or `aidrian-knowledge` with no arguments to list every subcommand and its options.

| Command | What it does | Read more |
| --- | --- | --- |
| `aidrian init` | Creates the project folder. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian check` | Checks the project folder and its indexes. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian lint` | Lints the project's skills, agents, paths, and knowledge size. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian state` | Prints the state folder. | [Local state](docs/project-folder.md#local-state) |
| `aidrian worktree new` | Creates a task worktree. | [Task worktrees](docs/project-folder.md#task-worktrees) |
| `aidrian worktree cleanup` | Removes the task worktrees whose work merged. | [Task worktrees](docs/project-folder.md#task-worktrees) |
| `aidrian pr await-review` | Waits for the review bot. | [`pr-review-loop`](plugins/aidrian/skills/pr-review-loop/SKILL.md) |
| `aidrian pr checks` | Gives a one-line verdict on the checks. | [`pr-merge-when-green`](plugins/aidrian/skills/pr-merge-when-green/SKILL.md) |
| `aidrian pr disposition` | Decides what to do with one review finding. | [`pr-review`](plugins/aidrian/skills/pr-review/SKILL.md) |
| `aidrian commit-msg` | Checks a commit message. | [Commit messages](docs/hooks.md#commit-messages) |
| `aidrian lesson` | Keeps the lesson inbox. | [Lessons](docs/lessons.md#commands) |
| `aidrian handoff` | Checks a session handoff brief. | [`session-handoff`](plugins/aidrian/skills/session-handoff/SKILL.md) |
| `aidrian report` | Shows what each agent type cost and read. | [The report](docs/dispatch-log.md#the-report) |
| `aidrian report docs` | Lists the knowledge docs agents read. | [Doc reads](docs/dispatch-log.md#doc-reads) |
| `aidrian report sessions` | Shows what each session cost. | [Sessions](docs/dispatch-log.md#sessions) |
| `aidrian report reviews` | Shows the review bot's rounds and findings. | [Reviews](docs/dispatch-log.md#reviews) |
| `aidrian report health` | Flags each signal past its threshold. | [Health](docs/dispatch-log.md#health) |
| `aidrian-knowledge route` | Lists the docs to read for a tag. | [Knowledge commands](docs/knowledge.md#commands) |
| `aidrian-knowledge search` | Finds docs by words. | [Knowledge commands](docs/knowledge.md#commands) |
| `aidrian-knowledge init` | Drafts the index for a docs folder. | [Indexing](docs/knowledge.md#indexing-a-repository-that-has-docs-but-no-buckets) |

### Agents

Claude Code names each agent `aidrian:<agent>`, and Codex `aidrian-<agent>`.
A project's own agent wins over the plugin's for the work it covers: [Project agents](docs/knowledge.md#project-agents).

| Coordination | What it does |
| --- | --- |
| `orchestrator` | Splits work and routes each part to the right agent. Never edits. |
| `integrator` | Lands slice branches in order onto one task branch. |

| Planning | What it does |
| --- | --- |
| `planning-agent` | Writes a complete local plan before the build. |
| `architect` | Designs boundaries and interfaces before the build. Read-only. |
| `initiative-agent` | Breaks a broad goal into ordered Linear issues. Read-only. |
| `agent-issue-writer` | Writes Linear issues with exact scope and checks. |
| `explorer` | Maps flows, call graphs, tests, and edge cases. Read-only. |
| `github-archaeologist` | Explains why code changed, from its history. Read-only. |

| Build | What it does |
| --- | --- |
| `backend-developer` | Builds backend and API work. |
| `frontend-developer` | Builds UI: components, state, accessibility; stack facts from knowledge. |
| `doc-updater` | Fixes stale docs when no code change is involved. |

| Review and quality | What it does |
| --- | --- |
| `code-reviewer` | Reviews code for bugs, trust boundaries, and test gaps. Read-only. |
| `security-engineer` | Reviews trust-boundary work, with a fix for each finding. Read-only. |
| `helper-scout` | Finds existing helpers a change could reuse. Read-only. |
| `e2e-runner` | Runs end-to-end tests and triages each failure. |

| Product and design | What it does |
| --- | --- |
| `product-manager` | Checks work against the product rules. Read-only. |
| `designer` | Builds UI presentation: layout, consistency, and polish. |
| `ux-specialist` | Fixes friction in the product's main flows. |
| `ux-researcher` | Finds confusion on activation and marketing pages. Read-only. |
| `design-source-explorer` | Classifies a Claude Design export and writes its import. |

| Support and growth | What it does |
| --- | --- |
| `support-agent` | Answers support tickets from documented answers. |
| `feedback-synthesizer` | Turns feedback into ranked themes. |
| `marketing-orchestrator` | Combines the marketing agents below into one answer. Read-only. |
| `growth-hacker` | Designs small growth experiments. |
| `content-creator` | Drafts posts and landing copy. |
| `seo-specialist` | Finds search opportunities. Read-only. |
| `ai-citation-strategist` | Helps AI answer engines cite the product. Read-only. |
| `brand-guardian` | Keeps messaging clear and consistent. Read-only. |

| Harness | What it does |
| --- | --- |
| `harness-librarian` | Sets up a project's `.aidrian/` folder and writes its knowledge docs. |
| `harness-mechanic` | Maintains this repository. |

### Skills

Claude Code runs each skill as `/aidrian:<skill>`. In Codex, ask for it by name.

| Coordination | What it does |
| --- | --- |
| `orchestration` | The orchestrator's steps for worktrees, slices, and pull requests. |
| `autopilot` | Runs one task unattended to a draft pull request. Never merges. |
| `session-handoff` | Writes a brief so a fresh session can resume the work. |
| `session-continue` | Resumes work from a handoff brief. |

| Planning | What it does |
| --- | --- |
| `planning-agent` | Writes or revises a local plan file. |
| `plan-review` | Critiques a local plan. The Human approves each change. |
| `issue-plan` | Plans one Linear issue before the build. |
| `initiative-agent` | Breaks a broad goal into a Linear project of ordered issues. |
| `agent-issue-writer` | Drafts or creates Linear issues for agents. |
| `challenge` | Tests a plan against the docs and code, one question at a time. |
| `adr-writer` | Writes an architecture decision record. |

| Build | What it does |
| --- | --- |
| `issue-implement` | Builds one Linear issue to a draft pull request. |
| `plan-implement` | Builds a reviewed local plan to a draft pull request. |
| `design-import` | Turns a Claude Design export into a design import and plan. |
| `worktree-new` | Creates a task worktree and runs the project's bootstrap. |
| `worktree-integrate` | Lands slice branches in order onto one task branch. |
| `worktree-cleanup` | Removes the task worktrees whose work merged. |

| Pull requests | What it does |
| --- | --- |
| `pr-write` | Writes a pull request title and body from the real diff. |
| `pr-screenshot` | Attaches screenshots or files to a pull request. |
| `pr-review-loop` | Takes each review comment to a fix or a reply with evidence. |
| `pr-merge-when-green` | Merges once every check is final and passes. |

| Review and quality | What it does |
| --- | --- |
| `pr-review` | Reviews a pull request with the right agents. |
| `pr-review-fix` | Fixes the findings of a `pr-review` round. |
| `specialist-review` | One agent reviews the current branch's changes. |
| `issue-verify-ac` | Checks a Linear issue's acceptance criteria against the code. |

| Harness | What it does |
| --- | --- |
| `knowledge` | Loads the project's rules. Every agent preloads it. |
| `knowledge-update` | Adds or refreshes knowledge docs from evidence. |
| `lesson` | Captures a session lesson into the inbox. |
| `lesson-triage` | Routes each open lesson to a fix. |
| `harness-health` | Explains the top problems in `aidrian report health`. |
| `skill-writer` | Creates, updates, or audits a skill. |

## Docs

| Doc | Read it to |
| --- | --- |
| [Adopting in a project](docs/adopting.md) | Finish setting up a project. |
| [Claude Code](docs/providers/claude-code.md) | Update the plugin and see how Claude Code runs it. |
| [Codex](docs/providers/codex.md) | Update the plugin and see how Codex runs it. |
| [Project folder](docs/project-folder.md) | Know the `.aidrian/` folder, the state folder, and task worktrees. |
| [Config](docs/config.md) | Change a setting in `config.json`. |
| [Knowledge buckets](docs/knowledge.md) | Write and index the project's rules. |
| [Hooks](docs/hooks.md) | See what each hook blocks, and turn one off. |
| [Dispatch log](docs/dispatch-log.md) | See what agents cost and read. |
| [Lessons](docs/lessons.md) | Use the lesson inbox. |
| [Contributing](docs/contributing.md) | Change the plugin itself. |
