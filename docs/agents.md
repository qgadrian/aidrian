# Agents

Each plugin agent is written once, for every host, and `npm run build` generates what each host loads.
This page is for editing the plugin's own agents.
A project keeps its own agents in its own folders, such as `.claude/agents/`, and none of this applies to them.

| Path | What it holds | Edit it |
| --- | --- | --- |
| `plugins/aidrian/agents-src/<name>.md` | The agent: neutral frontmatter and the body every host gets | yes |
| `plugins/aidrian/providers/<provider>.json` | What one host decides per agent, such as model, effort, and tools | yes |
| `plugins/aidrian/agent-addons/<name>.<provider>.md` | Optional text only one host gets, after the body | yes |
| `plugins/aidrian/agents/<name>.md` | The Claude Code agent | no, generated |
| `plugins/aidrian/codex/agents/aidrian-<name>.toml` | The Codex role | no, generated |

After an edit, run `npm run build`, and commit the sources and the generated files together.
`npm run check` fails while a generated file is missing, stale, extra, or edited by hand.

## Neutral fields

An agent source may set only these fields:

| Field | Value |
| --- | --- |
| `name` | The file name without `.md` |
| `description` | When to use the agent, in at most 160 characters |
| `access` | `read-only` or `write`: whether the agent may create or edit files itself |
| `skills` | Plugin skills to preload, by folder name, such as `[knowledge]` |

The body follows the frontmatter unchanged.
The build fails on any other field, on a skill the plugin does not ship,
and on a provider's model or tool name in a neutral field, such as `opus` or `Bash`.
A tool name that is also an English word, such as `Read`, counts only as a whole value or in backticks.

## Provider files

`providers/claude.json` and `providers/codex.json` map an agent name to that host's fields.
An optional `"*"` entry holds defaults for every agent:

```json
{
  "*": { "model": "sonnet", "effort": "medium" },
  "explorer": { "color": "yellow", "disallowedTools": ["Write", "Edit", "NotebookEdit", "Bash", "Agent"] }
}
```

The fields an entry may set, per provider:

- `claude`: `model`, `effort`, `color`, `tools`, `disallowedTools`, `maxTurns`, `autoCompactWindow`, `memory`, `background`,
  `omitClaudeMd`, `isolation`, `experimental`.
- `codex`: `model`, `model_reasoning_effort`, `model_reasoning_summary`, `model_verbosity`, `features`, `skills`.

Each value passes through to the generated agent as it is.
The build fails on an entry for an agent that has no source, and on any other field.
Claude Code ignores `hooks`, `mcpServers`, `permissionMode`, and `initialPrompt` in a plugin agent,
and a Codex role cannot set `sandbox_mode`, `approval_policy`, or `mcp_servers`, so neither list has them.
The fields the build writes from the source, such as `name` and `description`, are refused too.

## Merge order

Each field merges on its own, and the most specific value wins:

1. The provider's `"*"` defaults.
2. The `access` shortcut.
   For `read-only`, Claude Code gets `disallowedTools: [Write, Edit, NotebookEdit]`,
   and the Codex role gets a preamble line telling it not to create or edit files directly.
   Codex has no field for this: a role keeps the sandbox of the session that spawns it.
3. The agent's own provider entry.
   It replaces the shortcut's value for the same field, so it can add tools to the list, such as `Bash`, or deny others.
   An agent whose Claude Code entry denies `Bash` needs a Codex add-on with the line
   `You are read-only: do not create or edit files, and run only commands that change nothing.`; a test fails without it.
4. At run time, the project's `models` config, then `.aidrian.local.json`: [config.md](config.md#models).

The build fails when a Claude Code entry undoes `access`:
a `read-only` agent that can still use `Write`, `Edit`, or `NotebookEdit`, or a `write` agent that can use neither `Write` nor `Edit`.

## Adding a provider

A host such as OpenCode needs two things:

1. `plugins/aidrian/providers/opencode.json`, with the agents' OpenCode settings.
2. An `opencode` entry in `GENERATORS` in `scripts/build.mjs`:
   the folder its agents go in, the file name per agent, the fields an entry may set, what `access` sets,
   and a function that writes one agent from its source and its merged settings.

The build fails on a provider file without a generator, and on a generator without its provider file.
Once the generator exists, `<name>.opencode.md` add-ons work too.
