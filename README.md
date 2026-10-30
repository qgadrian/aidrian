# aidrian harness

A shared AI harness for Claude Code and Codex.
It ships one plugin, `aidrian`, with generic agents, skills, hooks, and two commands.
A project that installs it adds only its own rules, as Markdown docs, and one small folder, `.aidrian/`, that indexes them.
[Concepts](#concepts) defines the words this file uses.

## Quick start

You need Node 22 or later, and git access to `github.com/qgadrian/aidrian-harness`, which is private.

1. Install the plugin. In Claude Code:

   ```sh
   claude plugin marketplace add qgadrian/aidrian-harness
   claude plugin install aidrian@aidrian-harness
   ```

   In Codex, pass the SSH URL, because Codex clones over HTTPS ([Codex](#codex) has the details):

   ```sh
   codex plugin marketplace add git@github.com:qgadrian/aidrian-harness.git
   codex plugin add aidrian@aidrian-harness
   node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
   ```

   Then open Codex and trust the plugin's hooks in `/hooks`.

2. Set up the project at the root of its repository.
   `aidrian` is on the PATH inside a Claude Code session.
   In a terminal, put it there first: [Outside a session, and in CI](#outside-a-session-and-in-ci).

   ```sh
   aidrian init                  # creates .aidrian/config.json
   aidrian-knowledge init docs   # indexes an existing docs folder as a knowledge bucket
   aidrian check                 # prints ok, or one line per problem
   ```

3. Commit `.aidrian/`, and push it to the default branch.
   A new task worktree starts from `origin/<default branch>`, so one made before the push has no project folder.

4. Start a session with the orchestrator, the agent that splits work and hands each part to the right agent:

   ```sh
   claude --agent aidrian:orchestrator
   ```

[Adopting in a project](#adopting-in-a-project) finishes the setup: tags, `always` docs, `AGENTS.md`, and CI.

## Concepts

- **Knowledge bucket**: a folder of Markdown docs with one team's rules, plus its index, `.aidrian/knowledge/<bucket-id>.json`.
  The index gives each doc a one-line summary and tags, so an agent reads only the docs its work needs.
- **Project folder**: `.aidrian/` at the repository root. It holds `config.json` and the bucket indexes.
- **State folder**: one folder per project outside the repository, for plans, handoff briefs, lessons, and the dispatch log.
- **Task worktree**: a git worktree in `.worktrees/`, one per task, so the main checkout stays clean.
- **Dispatch**: one agent handing a task to another. The **dispatch log** records each dispatch, its cost, and the docs it read.
- **Slice**: one part of a larger task, built on its own branch. The `integrator` agent lands the slices in order.
- **The Human**: what agents call the person running the session. [`names`](docs/config.md#names) in config.json changes it.

## What is in the plugin

Two commands, the agents and skills below, and the [hooks](#hooks).

### Commands

Run either command with no arguments to print every subcommand and its options.

| Command | What it does |
| --- | --- |
| `aidrian init` | Creates the project folder and adds its local files to `.gitignore`. |
| `aidrian check` | Checks the project folder and every bucket index. Run it in CI too. |
| `aidrian lint` | Checks the project's skills and agents, personal paths in tracked files, and the knowledge budget. |
| `aidrian state` | Prints the state folder. |
| `aidrian worktree` | `new` creates a task worktree; `cleanup` removes the ones whose work has merged. |
| `aidrian pr` | Waits for the review bot, gives a one-line check verdict, or decides what to do with one review finding. |
| `aidrian commit-msg` | Checks a commit message against Conventional Commits. |
| `aidrian lesson` | Adds, lists, resolves, and counts lessons in the lesson inbox ([docs/lessons.md](docs/lessons.md)). |
| `aidrian handoff` | Checks a handoff brief against the one it replaces. |
| `aidrian report` | Summarizes the dispatch log per agent, with the calls the plugin's rules blocked ([docs/dispatch-log.md](docs/dispatch-log.md)). |
| `aidrian report docs` | Lists the knowledge docs agents read, and the ones nobody read. |
| `aidrian report sessions` | Shows what each session cost. |
| `aidrian report reviews` | Shows the review bot's rounds and findings on recent pull requests. |
| `aidrian report health` | Judges each of those signals against its threshold. |
| `aidrian-knowledge` | Routes, searches, lists, and drafts the bucket indexes ([docs/knowledge.md](docs/knowledge.md#commands)). |

### Agents

Claude Code names each agent `aidrian:<agent>`, and Codex `aidrian-<agent>`.
A project's own agent wins over the plugin's for the work it covers ([docs/knowledge.md](docs/knowledge.md#project-agents)).

| Agent | What it does |
| --- | --- |
| `orchestrator` | The coordination entry: classifies work that spans agents, routes each part, and keeps the Human in the loop. Never edits. |
| `planning-agent` | Writes or revises a decision-complete local plan before implementation or Linear publishing. |
| `initiative-agent` | Breaks a broad goal into a Linear initiative blueprint of ordered issues and dependencies. Read-only. |
| `agent-issue-writer` | Drafts or creates Linear issues with exact scope, dependencies, and verification steps. |
| `integrator` | Lands ordered slice branches onto a shared task branch and routes the first conflict to its owner. |
| `architect` | Designs a change before it is built: boundaries, interfaces, trade-offs, and a contract for the builders. Read-only. |
| `product-manager` | Checks a request, plan, or change against the project's product rules and names missing decisions. Read-only. |
| `backend-developer` | Implements backend and API work, following the project's backend rules and reusing its helpers. |
| `designer` | Implements UI presentation: visual consistency, layout, component reuse, and responsive polish. |
| `ux-specialist` | Diagnoses and fixes UX in the product's main flows: task success, friction, recovery states, and accessibility. |
| `design-source-explorer` | Classifies a Claude Design bundle and writes its design import, for the `design-import` skill. |
| `e2e-runner` | Runs and triages end-to-end tests, classifies each failure, and reports reproducible evidence. |
| `doc-updater` | Maintains docs on their own, such as drift repair; doc edits a code change causes ride with that change. |
| `code-reviewer` | Reviews code for correctness, trust boundaries, consistency, and test gaps against the project's rules. Read-only. |
| `security-engineer` | Threat modeling and secure code review for work that touches a trust boundary, each finding with a fix. Read-only. |
| `helper-scout` | Lists existing project helpers a task could reuse, or a diff reinvented. Advisory and read-only. |
| `explorer` | Maps flows, source-of-truth modules, call graphs, tests, and edge cases. Read-only. |
| `github-archaeologist` | Explains why code changed, from pull requests, issues, reviews, and commits. Read-only. |
| `support-agent` | Answers support tickets from the project's canonical answers and confirmed evidence, and escalates the rest. |
| `marketing-orchestrator` | Coordinates the marketing agents below into one answer. Read-only. |
| `growth-hacker` | Finds acquisition, activation, and retention opportunities, and designs small growth experiments. |
| `content-creator` | Drafts channel-aware posts, landing copy, and launch copy grounded in documented product behavior. |
| `seo-specialist` | Finds high-intent search opportunities and recommends content and site-structure improvements. Read-only. |
| `ai-citation-strategist` | Improves how AI answer engines find and cite the product. Read-only. |
| `brand-guardian` | Keeps messaging and positioning clear, consistent, and distinctive. Read-only. |
| `feedback-synthesizer` | Turns support tickets, reviews, and product signals into ranked, evidence-backed themes. |
| `ux-researcher` | Finds confusion and friction on activation and marketing surfaces from evidence and user questions. Read-only. |
| `harness-librarian` | Sets up and keeps a project's `.aidrian/` folder and knowledge indexes, and writes knowledge docs from evidence. |
| `harness-mechanic` | Maintains this repository: its agents, skills, hooks, scripts, tests, and docs. |

### Skills

Claude Code runs each skill as `/aidrian:<skill>`; in Codex, ask for it by name.

| Skill | What it does |
| --- | --- |
| `knowledge` | Loads the project's rules from its knowledge buckets. Every agent preloads it. |
| `knowledge-update` | Adds or refreshes knowledge docs from the code, docs, pull requests, and history. |
| `orchestration` | The orchestrator's editing steps: worktrees, parallel slices, the pull request, and review findings. |
| `planning-agent` | Writes or revises a decision-complete local plan file. |
| `plan-review` | Has `planning-agent` critique a local plan and propose a diff; the Human approves it before it is applied. |
| `issue-plan` | Plans one Linear issue before implementation, through `planning-agent`. Read-only on Linear. |
| `initiative-agent` | Decomposes a broad goal into a Linear Project with ordered issues and dependencies. |
| `agent-issue-writer` | Drafts or creates Linear issues, parent issues, or Project items for agents to implement. |
| `challenge` | Tests a plan or design against the project's docs and code, one question at a time. |
| `adr-writer` | Writes an architecture decision record with the next free number, or supersedes an earlier one. |
| `issue-implement` | Implements one Linear issue end to end, to a draft pull request. Linear stays read-only. |
| `plan-implement` | Implements a reviewed local plan with no Linear issue, through the `issue-implement` steps. |
| `autopilot` | Runs one task unattended to a draft pull request and a bounded review loop, then reports. Never merges. |
| `issue-verify-ac` | Checks a Linear issue's acceptance criteria against the code, and ticks the met ones after asking. |
| `design-import` | Turns a Claude Design export into a committed design import and plan. |
| `worktree-new` | Creates a task worktree with `aidrian worktree new` and runs the project's bootstrap there. |
| `worktree-integrate` | Runs `integrator` to land ordered slice branches onto a shared task branch. |
| `worktree-cleanup` | Removes task worktrees whose work has merged, asking before each one it cannot prove done. |
| `pr-write` | Drafts, creates, or updates a pull request title and body from the real diff and real test evidence. |
| `pr-review` | Reviews a pull request with the right agents, records each finding in a JSON manifest, and posts one comment. |
| `pr-review-fix` | Fixes the findings a `pr-review` round recorded, routing each to its owner. |
| `pr-review-loop` | Takes every review comment on a pull request to a verified fix or a reply with evidence. |
| `pr-merge-when-green` | Waits until every check is final and passes the project's check policy, then merges once. |
| `pr-screenshot` | Attaches local screenshots or files to a pull request as evidence. |
| `specialist-review` | One agent's focused review of the current branch's changes, kept warm for follow-up questions. |
| `session-handoff` | Writes a brief so a fresh session can resume the work, when the Human or `session.handoff` allows one. |
| `session-continue` | Resumes work in a fresh session from a handoff brief. |
| `lesson` | Captures a session lesson into the local inbox without leaving the task. |
| `lesson-triage` | Drains the lesson inbox: dedupes each lesson and routes it to a mechanism, a rule, an issue, or nothing. |
| `harness-health` | Reads `aidrian report health`, explains the top three problems with their numbers and samples, and names each one's fix. Read-only. |
| `skill-writer` | Creates, updates, audits, or retires a skill so it triggers predictably and stays lean. |

For work that spans several agents, start Claude Code with `claude --agent aidrian:orchestrator`, the coordination entry:
the orchestrator classifies the work, routes each part to an agent, and keeps the Human in the loop.

The `knowledge` skill is the shared rule set.
Every agent preloads it: it says how to load the project's buckets, which project rules win, and the defaults a project can override.

## Install

The repository is private: git on your machine needs read access to `github.com/qgadrian/aidrian-harness`.
The plugin's hooks and commands need Node 22 or later.

### Claude Code

```sh
claude plugin marketplace add qgadrian/aidrian-harness
claude plugin install aidrian@aidrian-harness
```

Claude Code clones the short name over SSH.
Inside a session, the same steps are `/plugin marketplace add qgadrian/aidrian-harness` and `/plugin install aidrian@aidrian-harness`.
Agents appear as `aidrian:<agent>`, skills as `/aidrian:<skill>`.
To update, run `claude plugin marketplace update aidrian-harness`, then `claude plugin update aidrian@aidrian-harness`.

### Codex

Codex clones over HTTPS, so pass the SSH URL:

```sh
codex plugin marketplace add git@github.com:qgadrian/aidrian-harness.git
codex plugin add aidrian@aidrian-harness
node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
```

When git already has HTTPS credentials for GitHub, for example after `gh auth setup-git`,
the short name works too: `codex plugin marketplace add qgadrian/aidrian-harness`.

Two errors mean that the clone failed:

- `fatal: could not read Username for 'https://github.com': terminal prompts disabled`:
  Codex tried HTTPS, and git had no credentials. Use the SSH URL.
- ``plugin `aidrian` was not found in marketplace `aidrian-harness` ``: the marketplace step before it failed.
  `codex plugin marketplace list` then shows no `aidrian-harness`. Add the marketplace again with the SSH URL.

Codex plugins can carry skills but not agents, so the last command copies the agents into `$CODEX_HOME/agents`,
`~/.codex/agents` by default, as `aidrian-<agent>`.
The `*` matches the installed version: Codex keeps one version folder and replaces it on update.
To update, run `codex plugin marketplace upgrade aidrian-harness`, then `codex plugin add aidrian@aidrian-harness`,
then the agents command again.
Add `--target .codex/agents` to the agents command to install the agents into one project instead.

Codex roles inherit the session's model; only the reasoning effort carries over from each agent.
A project can choose a model and effort per agent for both hosts: [docs/config.md](docs/config.md#models).
Claude Code enforces each agent's tool limits; on Codex the read-only agents are told to stay read-only.

### From a local checkout

To try a branch before it merges, add a checkout of this repository as the marketplace, then install as above:

```sh
claude plugin marketplace add /path/to/aidrian-harness
codex plugin marketplace add /path/to/aidrian-harness
```

To pick up a change:

- Claude Code caches the plugin by version, so a change arrives only after `npm run bump`.
  Then run `claude plugin marketplace update aidrian-harness` and `claude plugin update aidrian@aidrian-harness`.
- Codex copies the checkout again on each `codex plugin add aidrian@aidrian-harness`, with or without a bump.
  From the checkout, `make codex-agents` installs the Codex agents.

### Outside a session, and in CI

`aidrian` and `aidrian-knowledge` are on the PATH only inside a Claude Code session.
In a terminal, a git hook, or a Codex session, run them from the plugin folder the host installed:

| Host | Plugin folder |
| --- | --- |
| Claude Code | `~/.claude/plugins/cache/aidrian-harness/aidrian/<version>`, under `$CLAUDE_CONFIG_DIR` instead of `~/.claude` when it is set |
| Codex | `$CODEX_HOME/plugins/cache/aidrian-harness/aidrian/<version>`, with `CODEX_HOME` at `~/.codex` by default |

Claude Code keeps the old version folder after an update, so ask it for the current one.
This puts both commands on the PATH of the current shell:

```sh
plugin=$(claude plugin list --json |
  node -p 'JSON.parse(require("fs").readFileSync(0)).find((p) => p.id === "aidrian@aidrian-harness").installPath')
export PATH="$plugin/bin:$PATH"
```

Codex keeps one version folder, so a `*` finds it:

```sh
export PATH="$(echo "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/bin):$PATH"
```

`bin/aidrian` is a shell script, so run it directly, not with `node`.
Where no shell runs it, use `node <plugin folder>/lib/cli.mjs`, and `node <plugin folder>/lib/knowledge-cli.mjs` for `aidrian-knowledge`.

CI installs no plugin. Give the job Node 22 or later and read access to this repository, such as a deploy key, then run:

```sh
git clone --depth 1 git@github.com:qgadrian/aidrian-harness.git /tmp/aidrian-harness
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian check
/tmp/aidrian-harness/plugins/aidrian/bin/aidrian lint
```

## Adopting in a project

A project adds knowledge, and may keep its own agents: an agent of the project wins over the plugin's for the work it covers
([docs/knowledge.md](docs/knowledge.md#project-agents)).
[`examples/consumer`](examples/consumer) is a complete example; copy it as a start.

1. Create the project folder at the repository root with `aidrian init`
   ([outside a Claude Code session](#outside-a-session-and-in-ci), run it by its path).

   It writes `.aidrian/config.json` and adds `.aidrian.local.json` and `.worktrees/`, where task worktrees go, to `.gitignore`.
   To keep agents out of the main checkout, add `"mainCheckout": { "guard": true }` to the config ([docs/hooks.md](docs/hooks.md#main-checkout)).
   [docs/project-folder.md](docs/project-folder.md) describes the folder, how to keep it elsewhere, its version,
   and the state folder outside the repository where the plugin keeps plans, handoffs, and lessons.

2. Write the buckets: one index per bucket, `.aidrian/knowledge/<bucket-id>.json`, with a one-line summary per doc.
   For a docs folder that already exists, `aidrian-knowledge init <folder>` drafts it:

   ```json
   {
     "dir": "docs/knowledge/engineering",
     "description": "How this project is built, tested, and shipped.",
     "always": ["working-agreement.md"],
     "docs": {
       "working-agreement.md": { "summary": "Rules every task follows.", "tags": [] },
       "testing.md": { "summary": "How tests are written and run.", "tags": ["testing"] }
     }
   }
   ```

   Use the tags in the [`knowledge` skill](plugins/aidrian/skills/knowledge/SKILL.md#tags), so the agents find your docs.
   [docs/knowledge.md](docs/knowledge.md) describes every index field, and [docs/config.md](docs/config.md) every config key.

3. Point the main session at the buckets. Add to `AGENTS.md`, and put `@AGENTS.md` in `CLAUDE.md`:

   ```md
   Project rules live in knowledge buckets, indexed in `.aidrian/knowledge/`.
   Load them with the `knowledge` skill before you plan, edit, or review.
   ```

4. Offer the plugin to everyone who opens the project in Claude Code. Commit `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "aidrian-harness": { "source": { "source": "github", "repo": "qgadrian/aidrian-harness" } }
     },
     "enabledPlugins": { "aidrian@aidrian-harness": true }
   }
   ```

   Codex users install once per machine, as in [Codex](#codex).

5. Run `aidrian check` and `aidrian lint`, then commit and push, before anyone creates a task worktree.
   A worktree made earlier has no project folder, and the hooks stay silent there
   ([Task worktrees](docs/project-folder.md#task-worktrees)).
   Run both commands in CI too, as in [Outside a session, and in CI](#outside-a-session-and-in-ci),
   so a broken folder never reaches the agents.

## Hooks

The hooks in `plugins/aidrian/hooks/hooks.json` run in every session where the plugin is enabled.
In Claude Code there is nothing to do. In Codex, trust them in `/hooks` after you install and after every update.
[docs/hooks.md](docs/hooks.md) lists each hook, the host it runs on, and how to turn it off.

| When | What the plugin does |
| --- | --- |
| A session or subagent starts | Prints one line naming the `always` docs and how to find the rest. |
| Before each Bash command | Applies the git, process, and pull request body rules. |
| Before each file write | An opt-in guard keeps the main checkout clean. |
| Before each dispatch | Applies the project's model and effort for that agent. |
| After a Markdown write | Checks the line length. |
| Before compaction | Adds a checklist of what to keep. |
| A long session ends a turn | Offers once to hand off to a fresh session. |
| After each dispatch, subagent stop, session end, or block by one of its rules | Writes a dispatch log row. |

- A hook that cannot read its input lets the action run, so a hook never breaks a session.
- The guard on the main checkout is off until a project turns it on.
- A project that keeps its own copies of these checks runs both until it removes its own.

## Not included

- OpenCode support.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.

## Contributing

[docs/contributing.md](docs/contributing.md) covers the repository layout, the agent sources, the build and check,
and the version bump every plugin change needs.
