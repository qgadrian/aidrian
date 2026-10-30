# Contributing

This page is for changing the plugin itself. To use the plugin in a project, start at the [README](../README.md#quick-start).

## Layout

```text
.claude-plugin/marketplace.json     Claude Code marketplace "aidrian-harness"
.agents/plugins/marketplace.json    Codex marketplace "aidrian-harness"
plugins/aidrian/
├── .claude-plugin/plugin.json      Claude Code manifest
├── plugin.json                     Codex manifest (same name, version, description)
├── agents-src/*.md                 the agents, for every host; the source to edit
├── providers/<provider>.json       each host's model, effort, and tools per agent
├── agent-addons/*.<provider>.md    optional text only that host gets, after the agent's body
├── agents/*.md                     generated Claude Code agents; never edit
├── skills/*/SKILL.md               the skills; both hosts read them as they are
├── bin/aidrian                     project commands; on the Bash PATH in Claude Code sessions
├── bin/aidrian-knowledge           the knowledge command; on the same PATH
├── hooks/hooks.json                the plugin's hooks, for both hosts
├── scripts/hook-*.mjs              the programs those hooks run
├── lib/                            the code behind the commands and hooks
│   └── rules/                      the rules the Bash and write hooks run; rules/github/ holds those that read only gh
└── codex/
    ├── agents/aidrian-*.toml       generated Codex roles; never edit
    └── install-agents.mjs          copies those roles into $CODEX_HOME/agents (~/.codex/agents by default)
scripts/build.mjs                   generates agents/ and codex/agents from agents-src/ and providers/
scripts/version.mjs                 raises the plugin version (npm run bump) and checks it
examples/consumer/                  a small project that uses the plugin
docs/                               one page per surface; this page for contributors
test/                               node --test suites
```

## Agent sources

An agent is written once, for every host, in `plugins/aidrian/agents-src/<name>.md`:
neutral frontmatter (`name`, `description`, `access`, `skills`) and the body.
Each host's model, effort, and tools for it are in `plugins/aidrian/providers/claude.json` and `codex.json`.
`npm run build` generates the Claude Code agents in `agents/` and the Codex roles in `codex/agents/`.
When one host needs extra text for one agent, put it in `plugins/aidrian/agent-addons/<name>.<provider>.md`:
the build adds it after the body in that host's agent only.
[agents.md](agents.md) lists the fields, the merge order, and how to add a host.

## Build and check

```sh
npm ci
npm run build    # after editing plugins/aidrian/agents-src/, providers/, or agent-addons/
npm run check    # what CI runs
```

`npm run check` fails when a generated agent is stale or edited by hand, when the example's project folder is invalid,
when a test fails, or when the plugin changed without a version bump ([Versions](#versions)).
The tests also check that both manifests agree, that every agent preloads the `knowledge` skill,
that agents only ask for tags the `knowledge` skill lists, that the README's agent and skill tables list every one shipped,
and that no project-specific path leaks into the plugin.
No tracked file may name a person. The owner's GitHub name appears only where a user needs it to install:
the README, the example's settings, and the manifests' repository URLs.
Every agent and skill description must fit in 160 characters: both hosts put all of them into every session, used or not.
Every `SKILL.md` must fit in 7,500 bytes, because Codex cuts it at 8,000.
A longer skill keeps its steps in `SKILL.md` and moves detail into `references/` files that `SKILL.md` names, with when to read each.
When `claude` and `codex` are on your PATH, `test/hosts.test.mjs` also checks the real hosts:
Claude Code validates the plugin and loads every agent, skill, and hook event,
and Codex installs it and shows every skill and agent in a project session. Neither check runs a model.
`make` lists the same tasks.

To try a branch in a real session before it merges, install the plugin from your checkout:
[From a local checkout](../README.md#from-a-local-checkout).

## Versions

Users receive a change only after the version changes.
A branch that changes anything under `plugins/aidrian/` raises the version before it merges:

```sh
npm run bump           # 0.3.0 -> 0.3.1, for a fix
npm run bump minor     # 0.3.0 -> 0.4.0, for a new feature
npm run bump major     # 0.3.0 -> 1.0.0, for a change a project must adapt to
```

`npm run bump` writes the new version to every file that carries it: both plugin manifests, `package.json`, and `package-lock.json`.
`npm run check` fails when those files disagree, and when the branch changes `plugins/aidrian/` without a version above `origin/main`'s.
Changes only to docs, tests, examples, or `scripts/` need no bump: they live outside the plugin.
Without `origin/main`, or on `main` itself, the comparison with main is skipped.

Two open branches that both bump the version conflict on the version lines.
To resolve the conflict, take main's version in every conflicted file, then run `npm run bump` again with the same level.
