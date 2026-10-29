# aidrian harness

A shared AI harness for Claude Code and Codex.
It ships one plugin, `aidrian`, with generic agents and skills.
Each project that installs it supplies only its own knowledge buckets: folders of Markdown rules with a small index.

## What is in the plugin

| Kind | Names |
| --- | --- |
| Agents | `planning-agent`, `initiative-agent`, `agent-issue-writer`, `explorer`, `github-archaeologist`, `integrator`, `doc-updater`, `design-source-explorer`, `harness-engineer` |
| Skills | `knowledge`, `planning-agent`, `initiative-agent`, `agent-issue-writer`, `worktree-integrate`, `design-import`, `grill-me` |
| Command | `aidrian-knowledge`: checks a project's buckets and prints what a tag loads |

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
├── bin/aidrian-knowledge           on the Bash PATH in Claude Code sessions
├── lib/                            the code behind aidrian-knowledge
└── codex/
    ├── agents/aidrian-*.toml       generated from agents/*.md; never edit
    └── install-agents.mjs          copies those roles into ~/.codex/agents
scripts/build.mjs                   generates codex/agents
examples/consumer/                  a small project that uses the plugin
docs/knowledge.md                   the knowledge-bucket format
test/                               node --test suites
```

## Build and check

```sh
npm ci
npm run build    # after editing plugins/aidrian/agents/*.md
npm run check    # what CI runs
```

`npm run check` fails when the generated Codex agents are stale, when the example buckets are invalid, or when a test fails.
The tests also check that both manifests agree, that every agent preloads the `knowledge` skill,
that agents only ask for tags the `knowledge` skill lists, and that no project-specific path leaks into the plugin.
When `claude` and `codex` are on your PATH, `test/hosts.test.mjs` also checks the real hosts:
Claude Code validates the plugin and loads every agent and skill,
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

## Adopting in a project

A project adds knowledge, never agents or skills.
[`examples/consumer`](examples/consumer) is a complete example; copy it as a start.

1. Write the buckets. List them in `.aidrian/knowledge.json`, and give each folder a `bucket.json`:

   ```json
   { "buckets": ["docs/knowledge/engineering", "docs/knowledge/product"] }
   ```

   ```json
   {
     "id": "engineering",
     "description": "How this project is built, tested, and shipped.",
     "always": ["working-agreement.md"],
     "tags": { "testing": ["testing.md"], "issue_tracker": ["issue-tracker.md"] }
   }
   ```

   Use the tags in the [`knowledge` skill](plugins/aidrian/skills/knowledge/SKILL.md#tags), so the agents find your docs.
   [docs/knowledge.md](docs/knowledge.md) describes every field.

2. Point the main session at the buckets. Add to `AGENTS.md`, and put `@AGENTS.md` in `CLAUDE.md`:

   ```md
   Project rules live in knowledge buckets, listed in `.aidrian/knowledge.json`.
   Load them with the `knowledge` skill before you plan, edit, or review.
   ```

3. Offer the plugin to everyone who opens the project in Claude Code. Commit `.claude/settings.json`:

   ```json
   {
     "extraKnownMarketplaces": {
       "aidrian-harness": { "source": { "source": "github", "repo": "qgadrian/aidrian-harness" } }
     },
     "enabledPlugins": { "aidrian@aidrian-harness": true }
   }
   ```

   Codex users install once per machine, as in [Codex](#codex).

4. Keep local plans and worktrees out of git. Add to `.gitignore`:

   ```text
   .aidrian/plans/
   .aidrian/worktrees/
   ```

   To use other folders, say so in an `always` doc; project knowledge overrides the plugin's defaults.

5. Check the buckets, locally and in CI:

   ```sh
   aidrian-knowledge check             # in a Claude Code session, where it is on PATH
   path/to/aidrian-harness/plugins/aidrian/bin/aidrian-knowledge check   # anywhere else; needs Node 22 or later
   ```

## Not included

- OpenCode support.
- Hooks: the plugin changes no session by itself and asks for no hook trust.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.
