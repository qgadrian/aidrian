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
- The round-cap raise reads no Codex transcript, so no answer or typed grant lets an agent set `AIDRIAN_ALLOW_EXTRA_ROUNDS`:
  the Human runs the raise in their own shell, as the refusal writes it.
- The Stop input holds `stop_hook_active` and `last_assistant_message`, and a Stop hook's exit 2 makes its stderr the
  continuation prompt: both come from the schema and messages the 0.167.0 binary embeds, and no live session has run them.
  So the [announce check](../hooks.md#announced-work) sends a Codex main session back once, naming `request_user_input`
  as its question tool, and the [hand-back check](../hooks.md#hand-back-check) reads the same message;
  the session-length reminder reads Claude Code transcripts only and stays quiet.
- The adapter lists no [model prices](../dispatch-log.md#model-prices): no Codex transcript is read, so no cost is estimated.
  OpenAI's price page is `https://developers.openai.com/api/docs/pricing`; rows come with a transcript reader.
- The subagent-stop and session-end inputs are not verified.
  Those hooks run, write nothing they cannot read, and never send a Codex agent back.
- No [handoff continuation](../handoff.md#continue) route runs here: the adapter lists none, so every
  `session.handoff.continue` falls back to `none`, and the reminder and the plan offer keep their text.
  Its `sessionStart` still names `codex` as a command that starts a session, so a subagent, or a Claude Code session
  the background route started, may not run `codex`, `codex exec`, `codex resume`, or any subcommand but `login`,
  `logout`, `mcp`, `completion`, `features`, `help`, `--version`, and `--help` ([agent gates](../hooks.md#agent-gates)).
  That list has not been checked against a live Codex; a subcommand it does not name counts as a start.

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

## Project start

`aidrian project start` can start an issue's session on Codex, but no live Codex has run it: the host declares it
`verified: 'unverified'`, and a run starts it only where the default branch, on the forge and by its local ref, sets
[`projectRun.unverifiedHosts`](../config.md#project-run). Every start then prints an `unverified:` line.

- Codex is a confined host. Each attempt works in a fresh clone, never a linked worktree of the main checkout:
  `<state>/runs/<run>/attempts/<issue>.<attempt>/` holds `work/`, the clone, `git/`, its own git folder, which borrows
  the main checkout's objects read-only, `drop/`, owner-only, where the session hands its result over, and `cache/`,
  owner-only, where its package managers keep their caches.
  The first attempt cuts the issue's branch from the base tip; a later one fetches it from the forge.
  The main repository never fetches from a clone, and the driver's `wait` removes an attempt's folder once its session ended.
- The session runs `codex exec --json --sandbox workspace-write --cd <work>`, with `--add-dir` for exactly its git
  folder, its drop folder, its `cache` folder, and the state work folders `plans`, `reviews`, `tmp`, and `dispatch`,
  each a plain folder of the user directly in the state folder. No flag that bypasses the sandbox or the approvals is
  ever passed.
- Its environment holds the variables that put each package manager's cache and global store in the attempt's
  `cache` folder, the same as on Claude Code ([Dependency installs](claude-code.md#dependency-installs) lists them);
  `HOME` stays as it is. Codex hands its environment to the commands it runs through `shell_environment_policy`:
  its default inherits every variable but those whose names hold `KEY`, `SECRET`, or `TOKEN`, which none of these
  does. A user policy of `inherit = "core"` or `"none"`, or an `include_only` that leaves them out, drops them, and an
  install then fails to write its cache outside the writable roots; nothing reaches another folder.
  Its events go to `logs/<issue>.<attempt>.jsonl` in the run's folder.
- Git cannot reach the main checkout from there: nothing under its `.git` is granted, the clone's origin is the
  pinned forge URL, and work moves only through the forge. The session pushes with a full refspec and names the branch
  to every forge command, as its prompt says.
- Its `aidrian project result` writes `result.json` in the drop folder and prints `handed <issue> <status>`; it writes
  no ledger row and calls no forge. The driver's `wait` reads the file without following a link, as a regular file of
  the user with one link, checks every field again, and, for `merged` or `pr_open`, that the pull request is the
  issue's own on the forge. Anything else ends the attempt `bad_result`.
- Codex must run every hook of this plugin unasked: each handler hooks.json lists, of every event, needs a trusted
  `[hooks.state]` entry for this plugin's id in `config.toml`, not turned off. Trust them in `/hooks` after each install
  and update. `[sandbox_workspace_write] network_access = true` must be set, or the session could neither push nor
  reach the forge. That switch opens every host to a sandboxed command, so the registries the base branch's
  [`projectRun.registries`](../config.md#project-run) lists, which hold a Claude Code session's network to them, narrow
  nothing here: a Codex session reaches every registry, and every other host, whatever the list says. Install scripts
  a package runs still run inside the sandbox, under its writable roots. Codex's experimental network proxy,
  `features.network_proxy` with its `domains` rules, could hold a session to the forge's and the listed registries'
  hosts; no live run has checked it, so the start does not turn it on. `writable_roots` must reach neither the main checkout's `.git`, the state root, the mark
  folders, nor the runs folder. Each failure halts the start, and records nothing.
- A start holds the session only after three proofs, each in a bounded wait: its session id in the first JSON event
  within 30 seconds, its first tool call within 180 seconds, and the agent gate hook's beacon a few seconds after it.
  A failed proof stops the process at once, gives the attempt back, and halts the run until the Human's own shell, or
  another attended session that never drove the run, runs `aidrian project resume <run>`. Only a shell command, a file
  change, or an MCP tool's call counts as a tool call; a `turn.failed` event before one names its cause.
  A top-level `error` event does not end the wait: which of them are fatal is not shown yet, so the wait goes on
  to a tool call, a `turn.failed`, or its limit.
- The clone is no shared main checkout for the issue's own session, whose unattended mark names the run, the issue, and
  the main checkout: its machine switches and decisions come from the run's main checkout, its own
  `.aidrian.local.json` is never read, and the main-checkout rule lets the session edit and commit there. A hook refuses
  every call in the clone while its own git config sets a key that makes git run a program, such as `core.fsmonitor`,
  `gpg.program` with `log.showSignature`, or a credential helper, and every git call of the plugin runs with
  fsmonitor, hooks, and signature display off.
- A session is known by its process: liveness and stop read the process table, and stop a pid only while its start
  time is the one recorded. The table is read whole, up to 64 MiB of command lines, so a busy machine's listing still
  finds a start by its folder.

Before `verified` changes, a live Codex must show every one of these:

1. A hard link from the workspace to a file outside it is refused.
2. A write through a symlink to a file outside the writable roots is refused.
3. Whether a `.git` folder or pointer in a writable root is writable, and whether `--add-dir` can grant one.
4. `--add-dir` grants exactly the named folders, and no folder above or beside them.
5. PreToolUse fires for shell, `apply_patch`, and MCP calls, with `session_id` equal to the `thread_id` of
   `thread.started`.
6. Hooks run outside the sandbox, so the beacon can be written in the state folder.
7. What `network_access` covers: git over SSH and HTTPS, and `gh`.
8. Whether `codex exec` loads a project's `.codex/config.toml` from a clone of a trusted repository.
9. Which environment hook processes get.
10. Which top-level `error` events are fatal, so a start may halt on them as it halts on `turn.failed`.
11. With `projectRun.registries` listing `npm`, `npm ci` in the clone installs into the attempt's `cache` folder,
    `echo $npm_config_cache` names it, nothing new appears in `~/.npm`, and the driver's `wait` removes the attempt's
    folder once the session ended; the same for `pip`, `cargo`, `go`, and `bundler`.
12. Whether `features.network_proxy` with `domains` allow rules holds `git push`, `gh`, and an install to the listed
    hosts under `codex exec --sandbox workspace-write`, and refuses an unlisted one.

## Limits

- Codex cannot make one agent read-only.
  Codex 0.165.0 reads a role's `sandbox_mode` and drops it: a spawned agent keeps the sandbox of the session that spawned it
  ([`apply_role_to_config`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/role.rs)).
  So `install-agents.mjs` writes no sandbox into a role.
- A read-only agent is told so in its instructions, and nothing on Codex enforces it.
- The session's own sandbox binds every agent in it, such as `codex --sandbox read-only`.
