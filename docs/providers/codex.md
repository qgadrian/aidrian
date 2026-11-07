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
  and `aidrian check` warns of it while `tracker.enabled` is true and Codex has the plugin with no trust on record, or with those hooks turned off.
  A trust that an update made stale keeps its hash in Codex's config, so only `/hooks` shows that one.
- Codex has no Edit, Write, or Agent tool, so the hooks on those tools never run. [hooks.md](../hooks.md) marks them Claude Code.
- Shell commands reach the hooks as `Bash`, file edits as `apply_patch`, and MCP tools as `mcp__<server>__<tool>`.
- An app connector, such as Linear's, runs through the host's own MCP server, `codex_apps`, so its tools reach the hooks too.
  `codex mcp list` does not list them. They arrive as `mcp__codex_apps__<connector>__<tool>`,
  and the [adapter](../../plugins/aidrian/lib/hosts/codex.mjs) gives the hooks `mcp__codex_apps_<connector>__<tool>`,
  so a connector counts as a server of its own. The model sees `mcp__codex_apps__<connector>_<tool>`, with one underscore there.
- Codex replaces each character outside `[A-Za-z0-9_]` in a tool's name,
  so an MCP server `linear-server` reaches the hooks as `mcp__linear_server__<tool>`.
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
3. The write is refused with `this session has not read the connected workspace`,
   and the reason names `mcp__codex_apps__linear_get_workspace`, as the model sees that tool.
   That refusal proves the name and the hook. After the read, a write to another team is refused, and one to the project's team runs.

A write that runs with no refusal means the hook did not fire or the name differs: `mcp__codex_apps__` in `hookInput` is where to look,
and a collision between two connectors of one name, which Codex suffixes with a hash, is the one known way the name can differ.

## GitHub through the app connector

GitHub's app connector merges, comments, and marks a draft ready under names and inputs of its own, so the
[merge guard](../hooks.md#merge-guard), the [review gate](../config.md#review-gate), and the [ready hold](../hooks.md#ready-hold)
read these six tools. `hooks.json` lists each as Codex sends it and in the
model's flat form, and `githubTools` of the [adapter](../../plugins/aidrian/lib/hosts/codex.mjs) maps its inputs:

| `mcp__codex_apps__github__<tool>` | Read as | Pull request, repository, and text or head |
| --- | --- | --- |
| `merge_pull_request` | a merge | `pr_number`, `repository_full_name`, `expected_head_sha` |
| `enable_auto_merge` | a merge, as `gh pr merge --auto` is | `pr_number`, `repository_full_name`; it names no head, so the guard asks `gh` |
| `add_comment_to_issue` | a comment | `pr_number`, `repo_full_name`, `comment` |
| `reply_to_review_comment` | a comment | `pr_number`, `repo_full_name`, `comment` |
| `add_review_to_pr` | a comment | `pr_number`, `repo_full_name`, `review` |
| `mark_pull_request_ready_for_review` | a ready, as `update_pull_request_draft_state` with `draft: false` is | `pr_number`, `repository_full_name` |

This is not proven live. No hook on Codex has received these calls, and no merge went through the connector to test it:
the tests run a recorded shape, `test/fixtures/hosts/codex/github.json`, through the real hook.
How the name is joined comes from the source at `rust-v0.166.0`, as for [Linear](../hooks.md#where-the-tracker-guard-is-verified).
The tool names and inputs come from the connector catalog a Codex 0.166.0 install cached on 2026-11-05, and the ready tool's
from the one a 0.167.0 install cached on 2026-11-06, whose own `update_pull_request` takes no `draft`.

- OpenAI's servers serve that catalog, so no Codex version pins it. A tool renamed or added there passes these two rules unchecked.
- The text the gate reads is the body of the comment, reply, or review. The inline `file_comments` of `add_review_to_pr`,
  and an edit through `update_issue_comment` or `update_review_comment`, are not read, as the GitHub MCP server's are not.
- Two connectors of one name get a hash suffix from Codex, and then the name differs, as for any connector.
- A hook runs only after a person trusts it in `/hooks`, and `aidrian check` looks only at the tracker hooks' trust.

To prove it, a person trusts the hooks, records an owed review on a throwaway pull request with `aidrian pr request <PR>`,
and asks in a Codex session for a merge of it through the GitHub app. The merge is refused, with a reason naming
`aidrian pr await-review`. If it runs, the hook did not fire or the name differs.

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
- A tool pattern matches a call by its standard name or by what Codex sends:
  `mcp__codex_apps_linear__*` and `mcp__codex_apps__linear__*` hold the same tools,
  and `mcp__codex_apps__*` holds every connector. The model's flat form, `mcp__codex_apps__linear_*`, matches nothing, since no hook sees it.
  A server's name is matched as Codex spells it, so a gate on `mcp__linear-server__*` does not hold here, and one on `mcp__linear_server__*` does.
- A call without `agent_id` counts as the main session's: `main` gates apply,
  and neither the config guard, the [`decisions-set` rule](../hooks.md#bash-rules), nor the [session's gates](../hooks.md#the-sessions-gates) does.

## Limits

- Codex cannot make one agent read-only.
  Codex 0.165.0 reads a role's `sandbox_mode` and drops it: a spawned agent keeps the sandbox of the session that spawned it
  ([`apply_role_to_config`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/role.rs)).
  So `install-agents.mjs` writes no sandbox into a role.
- A read-only agent is told so in its instructions, and nothing on Codex enforces it.
- The session's own sandbox binds every agent in it, such as `codex --sandbox read-only`.
