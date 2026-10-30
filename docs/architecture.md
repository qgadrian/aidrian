# Architecture

How this repository is laid out, and how its parts connect.
This page is for contributors; [contributing.md](contributing.md) says how to build and check a change.

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
docs/                               one page per surface; docs/providers/ has one page per host
test/                               node --test suites
```

## How the parts connect

- **Agents**: each agent is written once, in `agents-src/`.
  `npm run build` writes the Claude Code agent and the Codex role from it. [agents.md](agents.md) has the details.
- **Skills**: both hosts read `skills/*/SKILL.md` as they are. Nothing is generated.
- **Hooks**: `hooks/hooks.json` names the events. Each event runs one `scripts/hook-*.mjs`.
  The Bash and write rules live in `lib/rules/`. [hooks.md](hooks.md) describes each one.
- **Commands**: `bin/aidrian` and `bin/aidrian-knowledge` are shell scripts.
  They run `lib/cli.mjs` and `lib/knowledge-cli.mjs` with `node`.
- **Codex agents**: Codex plugins cannot carry agents, so `codex/install-agents.mjs` copies the generated roles into Codex.
