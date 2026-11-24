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
- Codex reads a matcher of letters, digits, `_`, and `|` as exact names, and any other as a pattern that may match anywhere
  in the name. Unlike Claude Code, a `-`, a space, or a comma makes it a pattern (`HookMatcher` in the Codex source).
- Codex compiles a pattern with Rust's regex crate, which has no lookaround and no backreferences,
  so the build refuses a `hooks.json` matcher that holds one.
- An app connector, such as Linear's, runs through the host's own MCP server, `codex_apps`, so its tools reach the hooks too.
  `codex mcp list` does not list them. They arrive as `mcp__codex_apps__<connector>__<tool>`,
  and the [adapter](../../plugins/aidrian/lib/hosts/codex.mjs) gives the hooks `mcp__codex_apps_<connector>__<tool>`,
  so a connector counts as a server of its own. The model sees `mcp__codex_apps__<connector>_<tool>`, with one underscore there.
- Codex replaces each character outside `[A-Za-z0-9_]` in a tool's name,
  so an MCP server `linear-server` reaches the hooks as `mcp__linear_server__<tool>`.
- Hosted tools, such as web search, never reach a hook. No tracker write goes through one.
- The names reminder runs on each prompt but prints nothing: it reads only Claude Code transcripts.
- The adapter has no `humanAnswer`, so no Codex answer counts as the Human's for the
  [round limit delegation rule](../hooks.md#bash-rules): the Human runs `aidrian pr delegate` in their own shell.
- The round-cap raise reads no Codex transcript, so no answer or typed grant lets an agent set `AIDRIAN_ALLOW_EXTRA_ROUNDS`:
  the Human runs the raise in their own shell, as the refusal writes it.
- The Stop input holds `stop_hook_active` and `last_assistant_message`, and a Stop hook's exit 2 makes its stderr the
  continuation prompt: both come from the schema and messages the 0.167.0 binary embeds, and no live session has run them.
  So the [announce check](../hooks.md#announced-work) sends a Codex main session back once, naming `request_user_input`
  as its question tool, and the [hand-back check](../hooks.md#hand-back-check) reads the same message;
  the [review-loop check](../hooks.md#review-loop-check), the [merge hand-back check](../hooks.md#merge-hand-back-check),
  and the session-length reminder read Claude Code transcripts only and stay quiet.
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
The one-time steps before a run are in [Project run setup](../project-run-setup.md).

- Codex is a confined host. Each attempt works in a fresh clone, never a linked worktree of the main checkout:
  `<state>/runs/<run>/attempts/<issue>.<attempt>/` holds `work/`, the clone, `git/`, its own git folder, which borrows
  the main checkout's objects read-only, `drop/`, owner-only, where the session hands its result over, and `cache/`,
  owner-only, where its package managers keep their caches.
  The first attempt cuts the issue's branch from the base tip; a later one fetches it from the forge.
  The main repository never fetches from a clone, and the driver's `wait` removes an attempt's folder once its session ended.
  The clone commits unsigned, as on [Claude Code](claude-code.md#project-start): the start sets `commit.gpgsign` and
  `tag.gpgsign` to `false` in its own config, never the user's, since a sandboxed signing program may not reach its keys
  or its agent.
- The session runs `codex exec --json --sandbox workspace-write -c <override>... --cd <work>`, with `--add-dir` for exactly its git
  folder, its drop folder, its `cache` folder, and the state work folders `plans`, `reviews`, `tmp`, and `dispatch`,
  each a plain folder of the user directly in the state folder. No flag that bypasses the sandbox or the approvals is
  ever passed.
- The variables that put each package manager's cache and global store in the attempt's `cache` folder, the same as
  on Claude Code ([Dependency installs](claude-code.md#dependency-installs) lists them), reach the session's sandboxed
  commands alone: each is a `-c shell_environment_policy.set.<name>=<value>` override, which Codex injects into a
  command's environment after its exclusions, never the `codex exec` process's own environment, which its hooks and
  MCP servers inherit. `HOME` stays as it is. A user's `include_only` filter, or the `filters` that replace it, can
  still remove them; an install then fails to write its cache outside the writable roots, and nothing reaches another
  folder.
  Its events go to `logs/<issue>.<attempt>.jsonl` in the run's folder.
- The start makes no placeholders: Codex's confined start declares none, so its clone gets none of any host's. A
  clone whose index tracks OpenCode's `.opencode`, `.agents`, `opencode.json`, or `opencode.jsonc` as a link, at its root or any
  depth, is refused at start, as on Claude Code ([OpenCode](opencode.md#rules-for-the-other-hosts-sessions)).
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
  reach the forge. That switch alone opens every host, localhost too, so the start also turns on Codex's experimental
  network proxy for sandboxed commands, `-c features.network_proxy.enabled=true`, with
  `-c features.network_proxy.domains={ "<host>" = "allow", ... }` for exactly the forge's hosts and those of the
  registries the base branch's [`projectRun.registries`](../config.md#project-run) lists. A host with no rule is
  refused, so an empty list fails closed. Where the base branch sets [`projectRun.localBinding`](../config.md#project-run),
  the start adds `-c features.network_proxy.allow_local_binding=true`, the proxy's switch for local binding and
  loopback traffic, read from Codex 0.171.0's binary, not a live run; a Codex that rejects it exits as for either
  override below. In Codex 0.171.0 the same switch also turns off the proxy's refusal of private and link-local
  destinations (`codex-rs/network-proxy/README.md` at `rust-v0.171.0`), so an allowed host name that resolves to such
  an address is reached too; preflight's `note local-binding` line says so. Until live check 12 shows that a `-c` table override replaces the user's
  table rather than merging with it, a `config.toml` that sets any `features.network_proxy` key, in any form, halts the
  start, since a user allow rule could open a host the team never listed. No live run has checked the proxy (live check 12): a Codex that rejects
  either override exits before it names its session, and the start stops on that first proof, says which setting was
  refused, gives its attempt back, and halts the run. Install scripts a package runs run inside the sandbox, under its
  writable roots. `writable_roots` must reach neither the main checkout's `.git`, the state root, the mark
  folders, the [sign-off store](../review.md#merge-trust)'s folders, nor the runs folder; nor may `/tmp` or `$TMPDIR`,
  which the sandbox also writes, unless `exclude_slash_tmp` or `exclude_tmpdir_env_var` is set true there. Each failure halts the start, and records nothing.
- A start holds the session only after three proofs, each in a bounded wait: its session id in the first JSON event
  within 30 seconds, its first tool call within 180 seconds, and the agent gate hook's beacon a few seconds after it.
  A failed proof stops the process at once, gives the attempt back, and halts the run until the Human's own shell, or
  another attended session that never drove the run, runs `aidrian project resume <run>`, or the driver's next start
  of that issue re-checks and lifts it once ([Project run](../config.md#project-run)). Only a shell command, a file
  change, or an MCP tool's call counts as a tool call; a `turn.failed` event before one names its cause.
  A top-level `error` event does not end the wait: which of them are fatal is not shown yet, so the wait goes on
  to a tool call, a `turn.failed`, or its limit.
- The clone is no shared main checkout for the issue's own session, whose unattended mark names the run, the issue, and
  the main checkout: its machine switches and decisions come from the run's main checkout, its own
  `.aidrian.local.json` is never read, and the main-checkout rule lets the session edit and commit there. A hook refuses
  every call in the clone while its own git config sets a key that makes git run a program, such as `core.fsmonitor`,
  `gpg.program` with `log.showSignature`, or a credential helper, and every git call of the plugin runs with
  fsmonitor, hooks, and signature display off.
- A usage or rate limit is read from the run log alone (`logLimit` in `lib/hosts/codex-exec.mjs`): its last turn end,
  only when it is a `turn.failed` whose message names one, as `You've hit your usage limit. ... try again in 2 hours 5
  minutes.` or `... try again at 3:04 PM.`, or `exceeded retry limit, last status: 429 Too Many Requests`; never a
  top-level `error` event, an item's output, or a message. Its reset time is read against the log's last write. No
  Codex setting is known that continues a session once the limit resets, so the adapter declares no
  `continuesAtLimit`: `wait` stops the session and the issue starts again after the pause. These come from Codex's
  source, not a live run: until one shows them, a limit the reader misses ends the session with no result, or past
  `issueHours` ([Project run](../config.md#project-run)).
- A driver on Codex has no route to continue itself: Codex lists no handoff route, so `aidrian project preflight`
  prints a `note handoff` line, and the driver keeps driving in its one session, which Codex compacts
  ([Handoff](../handoff.md#a-project-run)). An issue's session starts no continuation on any host.
- No judge's verdict stands for auto-merge on Codex ([Limits](#limits)), so an issue whose review stops at the round
  cap does not merge on a waiver: its session reports the stop, as the review step's `waiver` says it.
- A session is known by its process: liveness and stop read the process table, and stop a pid only while its start
  time is the one recorded. The table is read whole, up to 64 MiB of command lines, so a busy machine's listing still
  finds a start by its folder. A session `wait` could not stop is named with how the Human stops it: the listing
  `TZ=UTC ps -o pid=,lstart=,ucomm= -p <pid>`, which prints no arguments and the start time in UTC, as the ledger's
  rows are, to the second, and `kill <pid>` only when that start time falls within the seconds of the attempt's two
  start rows in the run's ledger, from the second of the first through the second of the last, since another process
  may have taken the pid. A start that
  recorded no process points to the attempt's run log instead, never to a process picked by its name.

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
    `echo $npm_config_cache` names it, nothing new appears in `~/.npm`, a hook and an MCP server of the session see
    none of the variables, and the driver's `wait` removes the attempt's folder once the session ended; the same for
    `pip`, `cargo`, `go`, and `bundler`. For a project with no code yet, each with its registry listed and a sweep
    check after it: `npm create vite@latest`, `npx create-next-app`, `pnpm create` and `pnpm dlx` through corepack,
    `yarn create`, `uv init && uv add`, `python -m venv` then `pip install`, `cargo new && cargo add`, and
    `go mod init && go get`.
12. `features.network_proxy` with `domains` allow rules holds `git push`, `gh`, and an install to the listed hosts
    under `codex exec --sandbox workspace-write`, refuses an unlisted host and localhost, and Codex accepts both
    overrides; with `projectRun.localBinding` set, `allow_local_binding` lets a sandboxed command listen on a local
    port and connect to it, and whether an allowed host name that resolves to a private (`10.0.0.0/8`, `172.16.0.0/12`,
    `192.168.0.0/16`) or link-local (`169.254.0.0/16`) address is then reached, and an unlisted one still refused; and, with a user `config.toml` holding an allow rule for an unlisted host under
    `[features.network_proxy.domains]`, whether the start's `-c` table replaces it, so that host is refused. Until it
    does, a Codex session's network is held by an unverified proxy alone, and a user proxy setting halts the start.
13. What a usage limit and a rate limit leave in the `codex exec --json` log, so `logLimit` reads the real record.
14. After the session replaces its attempt's `cache` folder with a link, an `apply_patch` through the link is refused.
    Claude Code's per-start sandbox proof checks the same from inside the session, and that a `CLAUDE_ENV_FILE` line
    reaches the sandboxed shell alone ([The sandbox proof](claude-code.md#the-sandbox-proof)); a Codex start runs no
    such proof, so this check stands in for it.

Codex residuals, each open until the live checks hold:

- Until live check 12 holds, a sandboxed command may reach any host, localhost included, if the network proxy does
  not hold as its reference says.
- With `projectRun.localBinding` set, a sandboxed command reaches this machine's loopback by design, a service it
  starts is open to every other local process, and the proxy no longer refuses private and link-local destinations,
  so an allowed host name that resolves to one, as a DNS answer an attacker controls could make it, reaches that
  address. Bind each test server to `127.0.0.1`.
- A sandboxed command reads every file of the user that the workspace-write sandbox does not hide, credential stores
  included, such as `~/.ssh`, `~/.npmrc`, `~/.yarnrc.yml`, Codex's own `auth.json`, and OpenCode's data, state, and
  config folders: Codex has no read denial the start can pass, unlike Claude Code's `denyRead`, so the hosts'
  `credentialStores` reach no Codex sandbox. The publish commands the agent gate hook refuses, as on Claude Code, keep a session from
  publishing with a token it read; a script that does stays the accepted residual.
- Among those folders is OpenCode's state folder, whose `service.json` holds the password of its background service:
  [OpenCode limits](opencode.md#limits) says how a session no Human attends is refused that store and port, and what stays open.
- The keep files of `drop` and `cache` are not denied here: a session may remove either folder and put a link in its
  place, which the agent gate hook then refuses to write through.

## Session ids

Read in Codex's source at `rust-v0.166.0` on 2026-11-18, not live:

- A shell call gets `CODEX_THREAD_ID`, the id of the thread that runs it (`codex-rs/core/src/exec_env.rs`, `create_env`),
  and `CODEX_SESSION_ID`, "the shared root-session identity" (`inject_session_env` there).
- A hook's payload carries `session_id: sess.session_id()` (`codex-rs/core/src/hook_runtime.rs`, the PreToolUse and
  PostToolUse requests), and `session_id()` is "the identity shared by the root thread and all descendant threads",
  equal to the root thread's id (`codex-rs/core/src/session/session.rs`).
- So in the root thread `CODEX_THREAD_ID` equals the hooks' `session_id`, and in a subagent's thread it does not: it is
  the subagent's own thread id. The adapter reads `CODEX_THREAD_ID` as a command's session (`sessionId`), so a command
  that would file a row for a session reads the wrong one in a subagent. That is why the snapshot's
  [worktree links](adding-a-host.md#session-links) are written by the PostToolUse Bash hook, under the payload's
  `session_id`, and not by `aidrian worktree new`.

## Limits

- Codex cannot make one agent read-only.
  Codex 0.165.0 reads a role's `sandbox_mode` and drops it: a spawned agent keeps the sandbox of the session that spawned it
  ([`apply_role_to_config`](https://github.com/openai/codex/blob/rust-v0.165.0/codex-rs/core/src/agent/role.rs)).
  So `install-agents.mjs` writes no sandbox into a role.
- A read-only agent is told so in its instructions, and nothing on Codex enforces it.
- The session's own sandbox binds every agent in it, such as `codex --sandbox read-only`.
- Nothing tells whether Codex would let a session push to the repository's remote: its `capabilities.pushPermission`
  ([the adapter's fields](adding-a-host.md#the-adapters-fields)) answers `unknown`, so the push preflight never stops a run here.
  Verified by `node --test` on fixtures (`test/adapters.test.mjs`), not live.
- No hook writes a `dispatch` row with the agent id of a subagent Codex spawns, so the adapter declares no
  `capabilities.judgeDispatch`: under the [unattended waiver](../config.md#unattended-waiver), no judge's verdict stands
  for `aidrian pr auto-merge` on Codex, and the review step's `waiver` and `aidrian pr waive --gate` both say so.
