# aidrian harness

A shared AI harness for Claude Code and Codex.
It ships one plugin, `aidrian`, with generic agents and skills.
Each project that installs it supplies only its own knowledge buckets, folders of Markdown rules,
and one project folder, `.aidrian/`, that indexes them and holds the plugin's settings.

## What is in the plugin

| Kind | Names |
| --- | --- |
| Commands | `aidrian`: sets up and checks the project folder (`aidrian init`, `aidrian check`), prints the state folder (`aidrian state`), creates and cleans up task worktrees (`aidrian worktree`), waits for the review bot and reads check and finding verdicts (`aidrian pr`), checks commit messages (`aidrian commit-msg`), lints skills, agents, paths, and the knowledge budget (`aidrian lint`), keeps the lesson inbox (`aidrian lesson`), checks handoff briefs (`aidrian handoff`), and reports on the dispatch log (`aidrian report`); `aidrian-knowledge`: routes, searches, and drafts a project's buckets |
| Hooks | at session and subagent start, one line naming the `always` docs and how to find the rest; before each Bash command, git, process, and pull request body rules; before each file write, an opt-in guard that keeps the main checkout clean; before each dispatch, the project's model and effort for that agent; after a Markdown write, a line-length check; before compaction, a checklist of what to keep; when a long session ends a turn, one offer to hand off; after each dispatch, subagent stop, and session end, a dispatch log row. [docs/hooks.md](docs/hooks.md) lists them |

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
| `skill-writer` | Creates, updates, audits, or retires a skill so it triggers predictably and stays lean. |

For work that spans several agents, start Claude Code with `claude --agent aidrian:orchestrator`, the coordination entry:
the orchestrator classifies the work, routes each part to an agent, and keeps the Human in the loop.

The `knowledge` skill is the shared rule set.
Every agent preloads it: it says how to load the project's buckets, which project rules win, and the defaults a project can override.

## Layout

```text
.claude-plugin/marketplace.json     Claude Code marketplace "aidrian-harness"
.agents/plugins/marketplace.json    Codex marketplace "aidrian-harness"
plugins/aidrian/
├── .claude-plugin/plugin.json      Claude Code manifest
├── plugin.json                     Codex manifest (same name, version, description)
├── agents/*.md                     the agents; the only source to edit
├── agent-addons/<name>.codex.md    optional text only Codex gets, after that agent's body
├── skills/*/SKILL.md               the skills; both hosts read them as they are
├── bin/aidrian                     project commands; on the Bash PATH in Claude Code sessions
├── bin/aidrian-knowledge           the knowledge command; on the same PATH
├── hooks/hooks.json                the plugin's hooks, for both hosts
├── scripts/hook-*.mjs              the programs those hooks run
├── lib/                            the code behind the commands and hooks
│   └── rules/                      the rules the Bash and write hooks run; rules/github/ holds those that read only gh
└── codex/
    ├── agents/aidrian-*.toml       generated from agents/*.md; never edit
    └── install-agents.mjs          copies those roles into ~/.codex/agents
scripts/build.mjs                   generates codex/agents
examples/consumer/                  a small project that uses the plugin
docs/project-folder.md              the project folder: structure, location, version, checks
docs/config.md                      the project config file, .aidrian/config.json
docs/hooks.md                       what each hook does, and its override
docs/dispatch-log.md                the dispatch log rows and aidrian report
docs/knowledge.md                   the knowledge-bucket format
test/                               node --test suites
```

## Host add-ons

An agent is written for every host.
When Codex needs extra text for one agent, put it in `plugins/aidrian/agent-addons/<name>.codex.md`:
`npm run build` adds it after the agent's body in the Codex role, and Claude Code never reads it.
The folder sits beside `agents/` because Claude Code loads every `.md` file in `agents/` as an agent.

There is no Claude add-on. Claude Code reads `agents/<name>.md` as it is, so nothing could add a `<name>.claude.md` to it;
text only Claude needs stays in the agent until the build generates Claude agents too.
`<name>.opencode.md` is kept for an OpenCode build, which does not exist.
The build fails on either name, and on an add-on whose agent does not exist.

## Build and check

```sh
npm ci
npm run build    # after editing plugins/aidrian/agents/*.md
npm run check    # what CI runs
```

`npm run check` fails when the generated Codex agents are stale, when the example's project folder is invalid, or when a test fails.
The tests also check that both manifests agree, that every agent preloads the `knowledge` skill,
that agents only ask for tags the `knowledge` skill lists, that the agent and skill tables above list every one shipped,
and that no project-specific path leaks into the plugin.
No tracked file may name a person; the owner's GitHub name appears only in the install steps and the manifests' repository URLs.
Every agent and skill description must fit in 160 characters: both hosts put all of them into every session, used or not.
Every `SKILL.md` must fit in 7,500 bytes, because Codex cuts it at 8,000.
A longer skill keeps its steps in `SKILL.md` and moves detail into `references/` files that `SKILL.md` names, with when to read each.
When `claude` and `codex` are on your PATH, `test/hosts.test.mjs` also checks the real hosts:
Claude Code validates the plugin and loads every agent, skill, and hook event,
and Codex installs it and shows every skill and agent in a project session. Neither check runs a model.
`make` lists the same tasks.

Users receive a change only after the version changes.
Bump `version` in both `plugins/aidrian/.claude-plugin/plugin.json` and `plugins/aidrian/plugin.json`; a test fails if they differ.

## Install

The repository is private, so git on your machine needs access to `github.com/qgadrian/aidrian-harness`.

### Claude Code

```sh
claude plugin marketplace add qgadrian/aidrian-harness
claude plugin install aidrian@aidrian-harness
```

Inside a session, the same steps are `/plugin marketplace add qgadrian/aidrian-harness` and `/plugin install aidrian@aidrian-harness`.
Agents appear as `aidrian:<agent>`, skills as `/aidrian:<skill>`.

### Codex

```sh
codex plugin marketplace add qgadrian/aidrian-harness
codex plugin add aidrian@aidrian-harness
node ~/.codex/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
```

Codex plugins can carry skills but not agents, so the last command copies the agents into `~/.codex/agents/` as `aidrian-<agent>`.
The `*` matches the installed version: Codex keeps one version folder and replaces it on update.
Run the command again after each update.
From a checkout of this repository, `make codex-agents` does the same.
Add `--target .codex/agents` to install the agents into one project instead.

Codex roles inherit the session's model; only the reasoning effort carries over from each agent.
A project can choose a model and effort per agent for both hosts: [docs/config.md](docs/config.md#models).
Claude Code enforces each agent's tool limits; on Codex the read-only agents are told to stay read-only.

## Hooks

The hooks in `plugins/aidrian/hooks/hooks.json` run in every session where the plugin is enabled.
In Claude Code there is nothing to do. In Codex, trust them in `/hooks` after you install and after every update.
[docs/hooks.md](docs/hooks.md) lists each hook, the host it runs on, and how to turn it off.

- A hook that cannot read its input lets the action run, so a hook never breaks a session.
- The guard on the main checkout is off until a project turns it on.
- A project that keeps its own copies of these checks runs both until it removes its own.

## Adopting in a project

A project adds knowledge, and may keep its own agents: an agent of the project wins over the plugin's for the work it covers
([docs/knowledge.md](docs/knowledge.md#project-agents)).
[`examples/consumer`](examples/consumer) is a complete example; copy it as a start.

1. Create the project folder at the repository root:

   ```sh
   aidrian init         # in a Claude Code session, where the plugin's commands are on PATH
   path/to/aidrian-harness/plugins/aidrian/bin/aidrian init     # anywhere else; needs Node 22 or later
   ```

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

5. Run `aidrian check` and `aidrian lint`, then commit. Run both in CI too, so a broken folder never reaches the agents.

## Not included

- OpenCode support.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.
