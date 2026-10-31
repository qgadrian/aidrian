# aidrian harness

One plugin, `aidrian`, gives Claude Code and Codex a team of agents, skills, and safety hooks.
A project adds only its own rules, as Markdown docs, and a small `.aidrian/` folder that indexes them.

## Concepts

- **The Human**: what agents call the person running the session. [`names`](docs/config.md#names) changes it.
- **Knowledge bucket**: a folder of Markdown docs with one team's rules, and its index in `.aidrian/knowledge/`.
- **Project folder**: `.aidrian/` at the repository root. It holds `config.json` and the bucket indexes.
- **State folder**: one folder per project outside the repository, for plans, handoff briefs, lessons, and the dispatch log.
- **Tag**: a word, such as `testing`, that marks a doc in a bucket index. An agent reads the docs with the tags its task needs.
- **`always` doc**: a doc in a bucket that every agent reads, whatever the tags.
- **Orchestrator**: the agent that splits a task into parts and dispatches each one to the right agent.
- **Autopilot**: the skill that runs one task from issue to pull request without the Human.
- **Review bot**: the GitHub app that reviews each pull request. The agents wait for it, then fix what it finds.
- **Task worktree**: a git worktree in `.worktrees/`, one per task, so the main checkout stays clean.
- **Dispatch**: one agent handing a task to another. The dispatch log records each one.
- **Slice**: one part of a larger task, built on its own branch.

## Prerequisites

- Node 22 or later, and git.
- Claude Code, Codex CLI, or both.
- The GitHub CLI, signed in with `gh auth login`. The `aidrian pr`, `aidrian report`, and `aidrian worktree` commands,
  and the `pr-*` skills, call `gh`.
- Optional: a review bot. The default is `chatgpt-codex-connector[bot]`, the Codex GitHub connector, which reviews pull requests.
  Without one, see [No review bot](docs/config.md#no-review-bot).
- Optional: an issue tracker. The [tracker reference](plugins/aidrian/skills/knowledge/references/tracker.md) says how agents use it.

## Install

### Claude Code

Run these in a terminal:

```sh
claude plugin marketplace add qgadrian/aidrian
claude plugin install aidrian@aidrian-harness
```

### Codex

Run these in a terminal:

```sh
codex plugin marketplace add qgadrian/aidrian
codex plugin add aidrian@aidrian-harness
node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
```

The last command installs the agents. Its `*` assumes one version folder, which is what Codex keeps.
Then open Codex and trust the plugin's hooks in `/hooks`.
Installing from a private fork or mirror: [Codex](docs/providers/codex.md#private-fork-or-mirror).

### In CI

CI needs no plugin. Give the job Node 22 or later, and pin a tag or commit instead of the default branch:

```sh
git clone --depth 1 --branch <tag> https://github.com/qgadrian/aidrian.git /tmp/aidrian-harness
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian check
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian lint
```

Updates, install errors, and installing from a checkout: [Claude Code](docs/providers/claude-code.md), [Codex](docs/providers/codex.md).

## Quick start

Run the commands below in a terminal, at the root of the project's repository. Step 3 then opens a session.
Inside a Claude Code session, `aidrian` is already on the PATH. In a terminal, put it there first; for Claude Code:

```sh
plugin=$(claude plugin list --json |
  node -p 'JSON.parse(require("fs").readFileSync(0)).find((p) => p.id === "aidrian@aidrian-harness").installPath')
export PATH="$plugin/bin:$PATH"
```

If that fails, run the commands from the plugin folder instead: [Running aidrian](docs/providers/claude-code.md#running-aidrian).
For Codex, see [Running aidrian](docs/providers/codex.md#running-aidrian).

1. Set up the project folder and index the existing docs:

   ```sh
   aidrian init                  # creates .aidrian/config.json
   aidrian-knowledge init docs   # indexes the folder of Markdown docs; name yours if it is not docs
   aidrian check                 # prints ok, or one line per problem
   ```

   No Markdown docs yet? Skip the middle line, and run it once the project has a folder of them.

2. Commit `.aidrian/` and push it to the default branch. New task worktrees start from there.

3. Start a session with the orchestrator, the agent that splits work and routes each part:

   ```sh
   claude --agent aidrian:orchestrator
   ```

   In Codex, ask the session for the `aidrian-orchestrator` agent by name.

[Adopting in a project](docs/adopting.md) finishes the setup: tags, `always` docs, `AGENTS.md`, and the team's install.

## What is in the plugin

### Commands

Run `aidrian` or `aidrian-knowledge` with no arguments to list every subcommand and its options.

| Command | What it does | Read more |
| --- | --- | --- |
| `aidrian init` | Creates the project folder. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian check` | Checks the project folder and its indexes. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian lint` | Lints the project's skills, agents, paths, knowledge size, and banned terms. | [Setting up](docs/project-folder.md#setting-up-and-checking) |
| `aidrian state` | Prints the state folder. | [Local state](docs/project-folder.md#local-state) |
| `aidrian worktree new` | Creates a task worktree. | [Task worktrees](docs/project-folder.md#task-worktrees) |
| `aidrian worktree cleanup` | Removes the task worktrees whose work merged. | [Task worktrees](docs/project-folder.md#task-worktrees) |
| `aidrian pr await-review` | Waits for the review bot. | [`pr-review-loop`](plugins/aidrian/skills/pr-review-loop/SKILL.md) |
| `aidrian pr attest` | Records the review the review gate asks for before the bot. | [Review gate](docs/config.md#review-gate) |
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

### Agents and skills

[Agents and skills](docs/agents-and-skills.md) lists each one, grouped, with what it does. In short:

- **Coordination**: the `orchestrator` agent splits work and routes each part; the `autopilot` skill runs one task unattended.
- **Planning**: agents that plan, design, and write tracker issues, and skills that plan an issue or review a plan.
- **Build**: backend, frontend, and docs agents, and the skills that build an issue or a plan to a draft pull request.
- **Pull requests and review**: `code-reviewer`, `security-engineer`, and the skills that write, review, and fix pull requests.
- **Product, design, support, and growth**: agents for product rules, UI and UX, support answers, and marketing.
- **Harness**: `harness-librarian`, and the skills that load and update the project's knowledge and lessons.

Claude Code names an agent `aidrian:<agent>` and runs a skill as `/aidrian:<skill>`.
Codex names an agent `aidrian-<agent>`; ask for a skill by name.

## Docs

| Doc | Read it to |
| --- | --- |
| [Adopting in a project](docs/adopting.md) | Finish setting up a project. |
| [Claude Code](docs/providers/claude-code.md) | Update the plugin and see how Claude Code runs it. |
| [Codex](docs/providers/codex.md) | Update the plugin and see how Codex runs it. |
| [Agents and skills](docs/agents-and-skills.md) | Find the agent or skill for a job. |
| [Agents](docs/agents.md) | See how the agent sources are written and built. |
| [Architecture](docs/architecture.md) | See how the plugin's parts fit together. |
| [Project folder](docs/project-folder.md) | Know the `.aidrian/` folder, the state folder, and task worktrees. |
| [Config](docs/config.md) | Change a setting in `config.json`. |
| [Knowledge buckets](docs/knowledge.md) | Write and index the project's rules. |
| [Hooks](docs/hooks.md) | See what each hook blocks, and turn one off. |
| [Dispatch log](docs/dispatch-log.md) | See what agents cost and read. |
| [Lessons](docs/lessons.md) | Use the lesson inbox. |
| [Contributing](docs/contributing.md) | Change the plugin itself. |
