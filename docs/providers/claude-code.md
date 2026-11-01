# Claude Code

How the plugin installs and runs in Claude Code.
The install commands are in the [README](../../README.md#claude-code).

## Install

- Claude Code clones the plugin's short name over SSH.
- Inside a session, type the same commands after `/plugin`, such as `/plugin install aidrian@aidrian-harness`.
- Agents appear as `aidrian:<agent>`, and skills as `/aidrian:<skill>`.
- To offer the plugin to everyone who opens a project, commit `.claude/settings.json`,
  as in the [example project](../../examples/consumer/.claude/settings.json).

## Update

```sh
claude plugin marketplace update aidrian-harness
claude plugin update aidrian@aidrian-harness
```

## From a local checkout

To try a branch before it merges, add a checkout of this repository as the marketplace, then install as usual:

```sh
claude plugin marketplace add /path/to/aidrian-harness
```

Claude Code caches the plugin by version.
A change arrives only after `npm run bump` in the checkout, then the two [update](#update) commands.

## Running aidrian

`aidrian` and `aidrian-knowledge` are on the PATH inside a Claude Code session.
In a terminal or a git hook, run them from the plugin folder, `~/.claude/plugins/cache/aidrian-harness/aidrian/<version>`.
When `CLAUDE_CONFIG_DIR` is set, that folder is under it instead of `~/.claude`.

Claude Code keeps the old version folder after an update, so ask it for the current one.
This puts both commands on the PATH of the current shell:

```sh
plugin=$(claude plugin list --json |
  node -p 'JSON.parse(require("fs").readFileSync(0)).find((p) => p.id === "aidrian@aidrian-harness").installPath')
export PATH="$plugin/bin:$PATH"
```

## Hooks

Claude Code runs every hook in [`hooks.json`](../../plugins/aidrian/hooks/hooks.json) once the plugin is enabled.
There is nothing to trust or turn on.
[hooks.md](../hooks.md) lists each hook; the ones marked Claude Code run only here.

## Models and effort

A hook adds the project's `models.claude` choice to each Agent tool call, from the next call on.
[config.md](../config.md#models) has the keys.

- An `effort` choice needs Claude Code 2.1.292 or later, the first version whose Agent tool call takes `effort`.
- The Agent tool takes only the four `claude` model names in config.md, never a full model id or `inherit`.
- A model or effort the dispatching agent passes for one call still wins.
- Another hook in the project that rewrites Agent calls may override the choice.
  Claude Code runs matching hooks in parallel, and each rewrite replaces the whole call.
- A session started with `claude --agent <name>` keeps the agent file's values.
  Start it with `--model` and `--effort` to choose others.

## Agent gates

The [agent gates](../hooks.md#agent-gates) learn who is calling from the hook input.
Checked on Claude Code 2.1.314, with a hook that logged each call:

- A subagent's call carries `agent_type` and `agent_id`.
  `agent_type` is `aidrian:<agent>` for this plugin's agents, and the agent's own name for a project agent.
- The main session's call carries neither, so it is `main`.
- A session started with `claude --agent <name>` carries `agent_type` alone, so it is both `main` and that agent.

So Claude Code holds each agent to its gates, tool by tool and pattern by pattern.

## Limits

Claude Code enforces each agent's tool limits.
A read-only agent cannot use `Write`, `Edit`, or `NotebookEdit`: [Merge order](../agent-sources.md#merge-order).
