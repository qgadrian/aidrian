# Codex

How the plugin installs and runs in Codex.
The install commands are in the [README](../../README.md#codex).

## Install

Codex clones a short name, such as the one Claude Code uses, over HTTPS.
That is why the README passes the SSH URL.
When git already has HTTPS credentials for GitHub, for example after `gh auth setup-git`, the short name works too.

Two errors mean that the clone failed:

- `fatal: could not read Username for 'https://github.com': terminal prompts disabled`:
  git had no HTTPS credentials. Use the SSH URL.
- ``plugin `aidrian` was not found in marketplace `aidrian-harness` ``: the marketplace step before it failed.
  `codex plugin marketplace list` then shows no `aidrian-harness`. Add the marketplace again with the SSH URL.

Codex plugins carry skills but not agents.
So `install-agents.mjs` copies the agents in, as `aidrian-<agent>`:

- by default into `$CODEX_HOME/agents`, which is `~/.codex/agents` unless `CODEX_HOME` is set;
- with `--target .codex/agents`, into one project instead.

After you install, open Codex and trust the plugin's hooks in `/hooks`.

## Update

```sh
codex plugin marketplace upgrade aidrian-harness
codex plugin add aidrian@aidrian-harness
node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs
```

Then trust the hooks in `/hooks` again.
Codex keeps one version folder and replaces it on update, so the `*` finds it.

## From a local checkout

To try a branch before it merges, add a checkout of this repository as the marketplace, then install as usual:

```sh
codex plugin marketplace add /path/to/aidrian-harness
```

Codex copies the checkout again on each `codex plugin add aidrian@aidrian-harness`, with or without a version bump.
From the checkout, `make codex-agents` installs the agents.

## Running aidrian

`aidrian` and `aidrian-knowledge` are not on the PATH in Codex.
This puts both commands on the PATH of the current shell:

```sh
export PATH="$(echo "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/bin):$PATH"
```

## Hooks

- Codex runs the plugin's hooks only after you trust them in `/hooks`, after each install and each update.
- Codex has no Edit, Write, or Agent tool, so the hooks on those tools never run. [hooks.md](../hooks.md) marks them Claude Code.
- Shell commands reach the hooks as `Bash`, file edits as `apply_patch`, and MCP tools as `mcp__<server>__<tool>`.
- Hosted tools, such as web search, never reach a hook.
- The stop, subagent-stop, and session-end inputs are not verified.
  Those hooks run, write nothing they cannot read, and never send a Codex agent back.

To check that the hooks run, open a session, run `git commit --amend --dry-run`, and check that the Bash hook blocks it.

## Models and effort

A shipped Codex role inherits the session's model. Only each agent's reasoning effort carries over.

A project's `models.codex` choice reaches the roles only when `install-agents.mjs` installs them into the project.
The user folder, `$CODEX_HOME/agents`, serves every project, so it never gets a project's choice.
[config.md](../config.md#models) has the keys.

```sh
node "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs --target .codex/agents
```

- Run it again after each change to `models.codex`. The next Codex session reads the new roles.
- Codex reads a project's `.codex/agents` only when the project is trusted.
- The installed roles carry one developer's choice too.
  So keep `.codex/agents` out of git while `.aidrian.local.json` sets `models.codex`.

## Agent gates

In Codex, only `*` and `main` [agent gates](../hooks.md#agent-gates) are sure to hold.

- A named agent's gates hold only when Codex sends the call's `agent_type`, which no live session has confirmed yet.
- Codex names this plugin's roles `aidrian-<agent>`; the gates read that as `<agent>`.
- A call without `agent_id` counts as the main session's: `main` gates apply, and the config guard does not.

## Limits

- Codex cannot make one agent read-only.
  Codex 0.165.0 reads a role's `sandbox_mode` and drops it: a spawned agent keeps the sandbox of the session that spawned it
  ([`apply_role_to_config`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/role.rs)).
  So `install-agents.mjs` writes no sandbox into a role.
- A read-only agent is told so in its instructions, and nothing on Codex enforces it.
- The session's own sandbox binds every agent in it, such as `codex --sandbox read-only`.
