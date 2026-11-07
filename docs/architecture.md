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
├── agents-src/<group>/*.md         the agents, for every host, one folder per group; the source to edit
├── providers/<provider>.json       each host's model, effort, and tools per agent
├── agent-addons/*.<provider>.md    optional text only that host gets, after the agent's body
├── agents/*.md                     generated Claude Code agents; never edit
├── skills/*/SKILL.md               the skills; both hosts read them as they are
├── bin/aidrian                     project commands; on the Bash PATH in Claude Code sessions
├── bin/aidrian-knowledge           the knowledge command; on the same PATH
├── hooks/hooks.json                the plugin's hooks, for both hosts
├── scripts/hook-*.mjs              the programs those hooks run
├── lib/                            the code behind the commands and hooks
│   ├── forges/                     the code forge facade: forgeFor in index.mjs, the GitHub adapter, and github-cli.mjs, the one way gh runs
│   ├── hosts/                      one adapter per host and their registry; what shared code calls instead of a host's names
│   ├── review/                     aidrian pr review: run.mjs, the entry and the step's outcome; step.mjs plans, stages.mjs runs the stages, record.mjs the attest and signoff writes
│   ├── trackers/                   one adapter per tracker and their registry; what expands the short tracker key
│   └── rules/                      the rules the Bash and write hooks run; rules/github/ holds those that read only gh
└── codex/
    ├── agents/aidrian-*.toml       generated Codex roles; never edit
    └── install-agents.mjs          copies those roles into $CODEX_HOME/agents (~/.codex/agents by default)
scripts/build.mjs                   generates the flat agents/ and codex/agents from agents-src/ and providers/
scripts/version.mjs                 checks a branch keeps the version, and raises it on release
scripts/code-shape.mjs              warns about long files, long functions, and nested ternaries in lib/
.github/workflows/release.yml       releases the plugin after each merge to main
examples/consumer/                  a small project that uses the plugin
docs/                               one page per surface; docs/providers/ has one page per host
test/                               node --test suites
```

## How the parts connect

- **Agents**: each agent is written once, in a group folder of `agents-src/`.
  `npm run build` writes the Claude Code agent and the Codex role from it, in flat folders. [agent-sources.md](agent-sources.md) has the details.
- **Skills**: both hosts read `skills/*/SKILL.md` as they are. Nothing is generated.
  They have no group folders: Claude Code finds a plugin skill only at `skills/<name>/SKILL.md`.
- **Composition**: a skill ends at its own output and never names who continues; the caller's text names the next step.
  A skill that runs another, or the agent that runs a skill, says what follows its end, as the `orchestrator` does after `issue-implement`.
  A test holds the rule for the plugin's callers, and the `skill-writer` checklist for new skills.
- **Hooks**: `hooks/hooks.json` names the events. Each event runs one `scripts/hook-*.mjs`.
  The Bash and write rules live in `lib/rules/`. [hooks.md](hooks.md) describes each one.
- **Hosts and trackers**: hook payloads pass through `lib/hosts/` on their way in, so the hooks read one standard, and config.json's short `tracker` key
  expands through `lib/trackers/`. [Adding a host, a tracker, or a forge](providers/adding-a-host.md) has the files.
- **Forges**: every command, hook, and step that reads or writes a pull request, its checks, or its repository on the
  forge does it through `forgeFor(cwd)` in `lib/forges/`, whose named methods hold gh's commands and routes; no other
  file runs gh. Shared code imports `lib/forges/index.mjs` alone, never an adapter: it gives `forgeFor` and the
  helpers `repoIdentity` (`identity.mjs`), the facade's own, which reads a repository to its canonical host and full
  path before any forge is chosen, `isTrustedCommenter`, which says who belongs to it, and `REVIEWS_PAGE`. The last two
  are GitHub's today, as the payloads are, until a second forge reshapes them. An option bounds a hook's calls (`timeoutMs`, and `killSignal`, which stops one at that bound), `strictJson` reads an empty answer as null, as
  `aidrian pr await-review` always has, and `{ host }` names the host of a pull request's URL.
  Callers' tests stub those methods; `test/forge-github.test.mjs` holds the gh command behind each one, and
  `test/forge-coupling.test.mjs` fails on shared code that imports an adapter, runs gh, or builds a GitHub route.
  [Adding a forge](providers/adding-a-host.md#adding-a-forge) has the files.
- **Commands**: `bin/aidrian` and `bin/aidrian-knowledge` are shell scripts.
  They run `lib/cli.mjs` and `lib/knowledge-cli.mjs` with `node`.
- **Codex agents**: Codex plugins cannot carry agents, so `codex/install-agents.mjs` copies the generated roles into Codex.
