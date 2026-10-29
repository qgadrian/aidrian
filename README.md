# aidrian harness

A shared AI harness for Claude Code and Codex.
It ships one plugin, `aidrian`, with generic agents and skills.
Each project that installs it supplies only its own knowledge buckets, folders of Markdown rules,
and one project folder, `.aidrian/`, that indexes them and holds the plugin's settings.

## What is in the plugin

| Kind | Names |
| --- | --- |
| Agents | `planning-agent`, `initiative-agent`, `agent-issue-writer`, `explorer`, `github-archaeologist`, `integrator`, `doc-updater`, `design-source-explorer`, `harness-engineer` |
| Skills | `knowledge`, `planning-agent`, `initiative-agent`, `agent-issue-writer`, `worktree-new`, `worktree-cleanup`, `worktree-integrate`, `pr-write`, `pr-review-loop`, `design-import`, `grill-me`, `lesson`, `lesson-triage`, `session-handoff`, `session-continue` |
| Commands | `aidrian`: sets up and checks the project folder (`aidrian init`, `aidrian check`), prints the state folder (`aidrian state`), creates and cleans up task worktrees (`aidrian worktree`), waits for the review bot and reads check and finding verdicts (`aidrian pr`), checks commit messages (`aidrian commit-msg`), lints skills, agents, paths, and the knowledge budget (`aidrian lint`), keeps the lesson inbox (`aidrian lesson`), checks handoff briefs (`aidrian handoff`), and reports on the dispatch log (`aidrian report`); `aidrian-knowledge`: routes, searches, and drafts a project's buckets |
| Hooks | at session and subagent start, one line naming the `always` docs and how to find the rest; before each Bash command, git, process, and pull request body rules; before each file write, an opt-in guard that keeps the main checkout clean; after a Markdown write, a line-length check; before compaction, a checklist of what to keep; after each dispatch, subagent stop, and session end, a dispatch log row. [docs/hooks.md](docs/hooks.md) lists them |

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
├── skills/*/SKILL.md               the skills; both hosts read them as they are
├── bin/aidrian                     project commands; on the Bash PATH in Claude Code sessions
├── bin/aidrian-knowledge           the knowledge command; on the same PATH
├── hooks/hooks.json                the plugin's hooks, for both hosts
├── scripts/hook-*.mjs              the programs those hooks run
├── lib/                            the code behind the commands and hooks
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

## Build and check

```sh
npm ci
npm run build    # after editing plugins/aidrian/agents/*.md
npm run check    # what CI runs
```

`npm run check` fails when the generated Codex agents are stale, when the example's project folder is invalid, or when a test fails.
The tests also check that both manifests agree, that every agent preloads the `knowledge` skill,
that agents only ask for tags the `knowledge` skill lists, and that no project-specific path leaks into the plugin.
Every agent and skill description must fit in 160 characters: both hosts put all of them into every session, used or not.
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
Claude Code enforces each agent's tool limits; on Codex the read-only agents are told to stay read-only.

## Hooks

The hooks in `plugins/aidrian/hooks/hooks.json` run in every session where the plugin is enabled.
In Claude Code there is nothing to do. In Codex, trust them in `/hooks` after you install and after every update.
[docs/hooks.md](docs/hooks.md) lists each hook, the host it runs on, and how to turn it off.

- A hook that cannot read its input lets the action run, so a hook never breaks a session.
- The guard on the main checkout is off until a project turns it on.
- A project that keeps its own copies of these checks runs both until it removes its own.

## Adopting in a project

A project adds knowledge, never agents or skills.
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
