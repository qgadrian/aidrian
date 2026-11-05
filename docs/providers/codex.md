# Codex

How the plugin installs and runs in Codex.
The install commands are in the [README](../../README.md#codex).

## Install

Codex plugins carry skills but not agents.
So `install-agents.mjs` copies the agents in, as `aidrian-<agent>`:

- by default into `$CODEX_HOME/agents`, which is `~/.codex/agents` unless `CODEX_HOME` is set;
- with `--target .codex/agents`, into one project instead.

After you install, open Codex and trust the plugin's hooks in `/hooks`.

### Private fork or mirror

Codex clones a short name, such as `owner/aidrian-harness`, over HTTPS.
For a private repository, that fails when git has no HTTPS credentials for it:

- `fatal: could not read Username for 'https://github.com': terminal prompts disabled`: git had no HTTPS credentials.
- ``plugin `aidrian` was not found in marketplace `aidrian-harness` ``: the marketplace step before it failed.
  `codex plugin marketplace list` then shows no `aidrian-harness`.

Run `gh auth setup-git` to give git HTTPS credentials, or add the marketplace by its SSH URL:

```sh
codex plugin marketplace add git@github.com:<owner>/aidrian-harness.git
```

## Update

```sh
codex plugin marketplace upgrade aidrian-harness
codex plugin add aidrian@aidrian-harness
aidrian_dir="$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/ | sort -V | tail -1)"
node "${aidrian_dir}codex/install-agents.mjs"
```

Then trust the hooks in `/hooks` again.
`aidrian_dir` is the newest version folder by version number, so an old folder left in the cache is never used.

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
aidrian_dir="$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/ | sort -V | tail -1)"
export PATH="${aidrian_dir}bin:$PATH"
```

## Hooks

- Codex runs the plugin's hooks only after you trust them in `/hooks`, after each install and each update.
  The [tracker write guard](../config.md#tracker) needs that trust too: without it, every tracker write passes unchecked,
  and `aidrian check` warns of it while `tracker.enabled` is true and Codex has the plugin with no trust on record.
  A trust that an update made stale keeps its entry in Codex's config, so only `/hooks` shows that one.
- Codex has no Edit, Write, or Agent tool, so the hooks on those tools never run. [hooks.md](../hooks.md) marks them Claude Code.
- Shell commands reach the hooks as `Bash`, file edits as `apply_patch`, and MCP tools as `mcp__<server>__<tool>`.
- An app connector, such as Linear's, runs through the host's own MCP server, `codex_apps`, so its tools reach the hooks too.
  `codex mcp list` does not list them. They arrive as `mcp__codex_apps__<connector>__<tool>`,
  and the [adapter](../../plugins/aidrian/lib/hosts/codex.mjs) gives the hooks `mcp__codex_apps_<connector>__<tool>`,
  so a connector counts as a server of its own.
- Hosted tools, such as web search, never reach a hook. No tracker write goes through one.
- The names reminder runs on each prompt but prints nothing: it reads only Claude Code transcripts.
- The stop, subagent-stop, and session-end inputs are not verified.
  Those hooks run, write nothing they cannot read, and never send a Codex agent back.

To check that the hooks run, open a session, run `git commit --amend --dry-run`, and check that the Bash hook blocks it.

## Prove the tracker guard

Everything below the hook is verified, and no live hook has run:
see [Where the tracker guard is verified](../hooks.md#where-the-tracker-guard-is-verified).
The one thing that takes a person is the trust step, so a person runs this once,
in a project with `"tracker": { "enabled": true, "provider": "linear", ... }`:

1. Trust the plugin's hooks in `/hooks`.
2. In a Codex session, ask for a Linear write through the Linear app.
3. The write is refused with `this session has not read the connected workspace`, and the reason names `mcp__codex_apps_linear__get_workspace`.
   That refusal proves the name and the hook. After the read, a write to another team is refused, and one to the project's team runs.

A write that runs with no refusal means the hook did not fire or the name differs: `mcp__codex_apps__` in `hookInput` is where to look,
and a collision between two connectors of one name, which Codex suffixes with a hash, is the one known way the name can differ.

## Models and effort

A shipped Codex role inherits the session's model. Only each agent's reasoning effort carries over.

A project's `models.codex` choice reaches the roles only when `install-agents.mjs` installs them into the project.
The user folder, `$CODEX_HOME/agents`, serves every project, so it never gets a project's choice.
[config.md](../config.md#models) has the keys.

```sh
aidrian_dir="$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/aidrian-harness/aidrian/*/ | sort -V | tail -1)"
node "${aidrian_dir}codex/install-agents.mjs" --target .codex/agents
```

- Run it again after each change to `models.codex`. The next Codex session reads the new roles.
- Codex reads a project's `.codex/agents` only when the project is trusted.
- The installed roles carry one developer's choice too.
  So keep `.codex/agents` out of git while `.aidrian.local.json` sets `models.codex`.

## Agent gates

In Codex, only `*` and `main` [agent gates](../hooks.md#agent-gates) are sure to hold.

- A named agent's gates hold only when Codex sends the call's `agent_type`, which no live session has confirmed yet.
- Codex names this plugin's roles `aidrian-<agent>`; the gates read that as `<agent>`.
- A call without `agent_id` counts as the main session's: `main` gates apply,
  and neither the config guard, the [`decisions-set` rule](../hooks.md#bash-rules), nor the [session's gates](../hooks.md#the-sessions-gates) does.

## Limits

- Codex cannot make one agent read-only.
  Codex 0.165.0 reads a role's `sandbox_mode` and drops it: a spawned agent keeps the sandbox of the session that spawned it
  ([`apply_role_to_config`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/role.rs)).
  So `install-agents.mjs` writes no sandbox into a role.
- A read-only agent is told so in its instructions, and nothing on Codex enforces it.
- The session's own sandbox binds every agent in it, such as `codex --sandbox read-only`.
