# Adding a host or a tracker

A new host, such as OpenCode, DeepSeek Code, or Kimi Code, or a new tracker, such as Jira, is one adapter file and its registration.
Shared code calls `lib/hosts/index.mjs` and `lib/trackers/index.mjs`, and never reads a host's variables or names a host's tools.
`test/adapters.test.mjs` iterates both registries, so an adapter added to one is checked by that alone,
and `test/host-coupling.test.mjs` fails when shared code reads a host variable or branches on a host's tool.

## Adding a host

| File | What it holds |
| --- | --- |
| `plugins/aidrian/lib/hosts/<id>.mjs` | The adapter, with the fields below |
| `plugins/aidrian/lib/hosts/index.mjs` | The adapter in `HOSTS`; order is detection order, the host a shell can start inside another first |
| `test/fixtures/hosts/<id>/tracker.json` | Recorded payloads, with `live` and `provenance` saying where they came from |
| `plugins/aidrian/providers/<id>.json` and a `GENERATORS` entry in `scripts/build.mjs` | The agents: [Adding a provider](../agent-sources.md#adding-a-provider) |
| `docs/providers/<id>.md` and its index entry | How it installs, and what was verified on it |

An adapter declares:

| Field | What it says |
| --- | --- |
| `id`, `name`, `ai` | Its id in the registries, what attribution records, and what the names line calls the AI |
| `detect({ env, input })` | Whether this process runs under it. It is false on an empty environment and a plain payload |
| `identityVars`, `detectVars` | The variables a reviewer and a test run without, and those a test run also drops |
| `sessionId(env)`, `agentName(env)`, `effort(env)`, `runEnv(env)` | What its environment says, null where it says nothing |
| `pluginAgentPrefix`, `agentAliases(type)` | How it names this plugin's agents, and the short names a type answers to |
| `toolName(name)` | A tool's name in the standard `mcp__<server>__<tool>`. A standard name stays as it is |
| `toolResponse(response)` | The objects a tool's response holds, the most direct first |
| `hookInput(input)` | The hook payload in the standard field names. A standard payload stays as it is |
| `hookEvents` | Each event of `hooks.json` as this host names it, or null when it has none |
| `fileEditTools`, `fileEdit(tool, input)` | Its file edit tools, and each call in a shape `fileEditOf` in `lib/hosts/index.mjs` lists |
| `projectFolders` | Where a project keeps its skills and agents for it, if the plugin's lint can read them |
| `modelsKey`, `modelChoices` | Its key under `models` in config.json, and what that key takes |
| `capabilities.transcripts` | Whether `lib/transcript.mjs` reads its transcripts: cost rows, the names reminder, and the session-length reminder need it |
| `capabilities.prFooterSettings` | The settings files that say whether it asks for a generated-by footer, when it does |
| `capabilities.trackerGuard` | `verified` (`live`, `source`, or `none`), `evidence`, `unguardedRoutes`, and, when its hooks wait on a person, `hookTrust` and `trustStep` |

`unguardedRoutes` is how a host says what cannot be held: `[{ name, reason }]`, one per way a tracker write reaches no hook.
`aidrian check` warns of each, and of a `hookTrust` that answers `untrusted`, while `tracker.enabled` is true.

The standard the shared code reads is what `hooks.json` matches: `Bash`, `Agent`, the events as Claude Code names them, and `mcp__<server>__<tool>`.
A host that differs maps to it in `hookInput` and `toolName`, as `test/fixtures/adapters/fake-host.mjs` does for a host that differs in every field.
Keep the adapter small and let it read no file when it loads: every hook loads it.

### What a new host still has to check by hand

- **The hook manifest.** Both hosts read `hooks/hooks.json` as it is, and Codex sets `CLAUDE_PLUGIN_ROOT` for compatibility.
  A host that reads another format or sets no such variable needs a generated manifest,
  which `scripts/build.mjs` writes from `hooks.json` and `hookEvents`, as it writes agents.
  No host needs one yet, so that generator is not built.
- **The auto-merge guard.** `GUARDED_PATHS` in `lib/project.mjs` lists the folders that instruct a host, such as `.codex/`.
  A change to one keeps auto-merge off.
  It takes the host's folder by hand, since it is one rule over every path. The conformance suite fails on a `projectFolders` entry it does not cover.
- **Skills.** They are one text for every host, and some name a host's tool, such as `AskUserQuestion`.
- **Quorum.** `quorum.*.provider` takes `agent` or `codex`.
  That names a second-opinion command the plugin runs, whichever host is running, so a new host needs nothing there.

## Adding a tracker

| File | What it holds |
| --- | --- |
| `plugins/aidrian/lib/trackers/<id>.mjs` | The adapter, with the fields below |
| `plugins/aidrian/lib/trackers/index.mjs` | The adapter in `TRACKERS` |
| `plugins/aidrian/skills/knowledge/references/tracker.md` | Its column: which tool each issue step uses |
| `plugins/aidrian/skills/harness-setup/references/dispatches.md` | The answers setup asks for it, when setup should offer it |

| Field | What it says |
| --- | --- |
| `id`, `name` | What `tracker.provider` takes, and how a message names it |
| `servers` | The server names a connection shows: `any` on every host, then one list per host id, as that host's `toolName` gives them |
| `readTool` | The tool that reports the connected workspace, an exact name |
| `writeVerbs` | Its write tools, as patterns after `mcp__<server>__` |
| `workspaceField` | The field of the read's response that holds the workspace |
| `team` | `createFields`, the inputs that put a write in a team, and `keyFields`, the inputs that name an issue |
| `project` | `field`, the input that names a project |

A project then writes `"tracker": { "enabled": true, "provider": "<id>", ... }` ([Tracker](../config.md#tracker)) and asks a person for no tool name.
`test/fixtures/adapters/fake-tracker.mjs` shows one, and `test/adapters.test.mjs` runs it through the guard with no change to shared code.
