# OpenCode

How the plugin installs and runs in OpenCode 2.0 and later.
On OpenCode the plugin keeps the [session ledger](../hooks.md#session-ledger) only: a bridge plugin runs that one hook
on OpenCode's shell calls, and no aidrian guard holds an OpenCode session ([Limits](#limits)).
OpenCode 1.x is not supported. The install command is also in the [README](../../README.md#opencode).

## Install

The plugin installs as a package from this repository, by a Git specifier whose `::path:` selector names the plugin
folder. The package is that whole folder, so `scripts/`, `lib/`, `bin/`, and `hooks/hooks.json` arrive with the bridge.
There is no npm package: `plugins/aidrian/package.json` is private, so never install by the bare name `aidrian`,
which names whatever a registry holds under it. It needs OpenCode 2.0 or later; 1.x is not supported.

`<owner>/aidrian` is this repository on GitHub: the [README](../../README.md#opencode) gives the command with its
owner. Following main, as the other two hosts do; `plugin add` writes the global configuration:

```sh
opencode plugin add 'github:<owner>/aidrian#main::path:plugins/aidrian'
```

Pinned to a release, with that release's tag in place of `main`:

```sh
opencode plugin add 'github:<owner>/aidrian#vX.Y.Z::path:plugins/aidrian'
```

For a team, in the project's `opencode.jsonc`, so every session in that project loads it:

```jsonc
{ "plugins": ["github:<owner>/aidrian#main::path:plugins/aidrian"] }
```

From a checkout, to try a branch: an absolute path to the plugin folder, which must be a directory.

```jsonc
{ "plugins": ["/absolute/path/to/aidrian-harness/plugins/aidrian"] }
```

To turn it off for one project while the global configuration names it, add `"-aidrian"` to that project's `plugins`.

## Update

- A branch entry, such as `#main`, is checked at OpenCode's startup and every 24 hours.
- A tag entry, such as `#vX.Y.Z`, or a full commit stays where it is. To move it, change the tag in the entry.
- A `#main` entry runs ahead of releases: a pull request lands on main before the release commit that names its
  version, so such an install can hold code no version names yet.
- A `semver:` range is not documented: whether OpenCode honors one against this repository's tags has not been checked.
- Whether `opencode plugin update` keeps a Git entry has not been checked.

## Running aidrian

- The bridge puts the plugin's `bin/` first on the `PATH` of every shell OpenCode starts, so `aidrian` and
  `aidrian-knowledge` run in its shell tool, and the `aidrian` that reads the ledger is the copy whose hook wrote it.
  It adds nothing when that `PATH` already holds the folder, when the shell and OpenCode have no `PATH`, or when the
  folder's path is not absolute or holds the path delimiter.
- In a terminal outside OpenCode, put the folder on the `PATH` first; from a checkout:
  `export PATH="/absolute/path/to/aidrian-harness/plugins/aidrian/bin:$PATH"`.
- The hook scripts need Node 22, and OpenCode's own binary is Bun. Server plugins run in OpenCode's background
  service, unless a command passes `--standalone`, so Node 22 must be on that service's `PATH`, or `AIDRIAN_NODE` in its
  environment must name a Node 22 binary by an absolute path; a relative `AIDRIAN_NODE` is ignored. For example, in the
  form the help of `opencode service set` gives on 2.4.0:

  ```sh
  opencode service set env AIDRIAN_NODE /absolute/path/to/node
  opencode service restart
  ```

- Restart the service after changing either, so it runs with the new value: a bridge that found no Node stops running
  hooks for the life of its process ([Troubleshooting](#troubleshooting)).

## Hooks

OpenCode reads no `hooks.json`. The bridge, `plugins/aidrian/opencode/bridge.mjs`, registers one callback for each row
of `ROUTES` in `plugins/aidrian/opencode/routes.mjs`, and a hook runs on OpenCode only once a row names it
([Adding a host](adding-a-host.md#delivery-comes-first)). This version has one row: after a `shell` call that
completed, it runs `scripts/hook-bash-post.mjs` as `hooks.json` runs it after a Bash call, stopped at its 5 s timeout.
The callback sends the script the standard hook payload on stdin, with a top-level `opencode` object that marks it as
OpenCode's, and the adapter, `plugins/aidrian/lib/hosts/opencode.mjs`, maps the rest. A call that errored or was
stopped sends nothing, as Claude Code runs `PostToolUse` only after a call that succeeded. No route blocks a call,
none changes a call's result, and a hook that cannot run leaves the call as it would be without the plugin.

`test/opencode-bridge.test.mjs` fails when `hooks.json` names a script this table lacks, and when its yes rows differ
from the scripts of `ROUTES`. Fixture only means the hook ran in tests on
`test/fixtures/hosts/opencode/bash-post.json`, built from the types of `@opencode/plugin@2.4.0` and the source
embedded in the OpenCode 2.4.0 binary; no live OpenCode has sent that payload.

| Script | Runs on OpenCode | Verified | Why not |
| --- | --- | --- | --- |
| `hook-bash-post.mjs` | yes | fixture only | |
| `hook-session-start.mjs` | no | - | The start lines must reach the model, and the bridge gives no hook a way to add context |
| `hook-prompt.mjs` | no | - | Its lines must reach the model too, and it reads transcripts, which no OpenCode reader exists for |
| `hook-agent-gates.mjs` | no | - | A guard: no route blocks a call until a live tool payload and its agent identity are recorded |
| `hook-enter-worktree.mjs` | no | - | Claude Code's `EnterWorktree` tool, which OpenCode does not have |
| `hook-bash.mjs` | no | - | The Bash rules and the merge guard block a call, which waits on a recorded live shell payload |
| `hook-write.mjs` | no | - | The write hook: the bridge forwards no file edit, and the `edit` tool's path field has not been read |
| `hook-mcp-github.mjs` | no | - | The bridge forwards no MCP tool call, and how OpenCode names one has not been read |
| `hook-tracker-pre.mjs` | no | - | The tracker guard: no MCP tool call reaches a hook |
| `hook-ask.mjs` | no | - | Claude Code's `AskUserQuestion` tool |
| `hook-agent-pre.mjs` | no | - | No agent of this plugin runs on OpenCode, so no model choice reaches one |
| `hook-markdown-wrap.mjs` | no | - | Its feedback must reach the model, and no file edit is forwarded |
| `hook-agent-post.mjs` | no | - | No agent of this plugin runs on OpenCode, so no dispatch row is written |
| `hook-plan-exit.mjs` | no | - | Claude Code's `ExitPlanMode` tool |
| `hook-tracker-post.mjs` | no | - | No MCP tool call reaches a hook |
| `hook-compact.mjs` | no | - | The compaction checklist must reach the model |
| `hook-stop.mjs` | no | - | The stop checks send a session back, which needs a way to reach the model, and some read transcripts |
| `hook-subagent-stop.mjs` | no | - | No agent of this plugin runs on OpenCode, and the checks must reach the model |
| `hook-session-end.mjs` | no | - | The session row reads transcripts, and OpenCode's are not read |

The ledger hook writes the ledger and the worktree links on OpenCode. It writes no
[check-run record](../hooks.md#check-runs), since the adapter declares no `shellRun`. It reads a created pull
request's link from the call's output, which the adapter's `shellOutput` takes from the shell result's `output.output`.

The bridge finds the call's folder in its input's `workdir` when that is an absolute path; with no `workdir`, in the
calling session's folder, and in the plugin's own when that read fails. A `workdir` that is not absolute, a relative
path or another machine's `name:path`, records nothing, since the folder it names is not known here.

## Session ids

- Every command OpenCode's shell tool runs has `OPENCODE=1` and `OPENCODE_SESSION_ID`, the calling session's id. The
  adapter reads that variable as a command's session, so `aidrian session snapshot` in an OpenCode shell finds its
  session's pull requests.
- The bridge files a subagent's rows under the root session: it follows each session's `parentID` up to the root, at
  most 8 steps, and sends the root as `session_id` and the calling session as `agent_id`, as a subagent's rows land on
  Claude Code. A read that fails gives the calling session's own id.
- A subagent's own shell names the child session in `OPENCODE_SESSION_ID`, so a snapshot run there shows none of the
  root session's pull requests.
- A command in an OpenCode that was itself started from a Claude Code or Codex shell reads the outer host's session:
  the variables of that host stay in its environment, and detection asks OpenCode's variables last. A hook the bridge
  runs is OpenCode's by its `opencode` mark, whatever variables the process inherited.
- Whether a subagent's child session carries `parentID` has not been checked on a live OpenCode.

## Troubleshooting

Every failure of the bridge is silent, so it keeps one trace. With `AIDRIAN_OPENCODE_TRACE` naming an absolute file in
the environment OpenCode's plugins run in, the bridge appends one JSON line a step, `{ at, step, script, status }`, to
that file, which it creates owner-only; a file already there keeps its mode.
It never writes a command, a payload, or output there, and a relative path writes nothing.
Set it as `AIDRIAN_NODE` is set: `opencode service set env AIDRIAN_OPENCODE_TRACE <file>`, then a service restart.

| `step` | When | `status` |
| --- | --- | --- |
| `setup` | Once, when OpenCode loads the plugin | How many routes it registered |
| `run` | Each time it ran a script | The exit code or signal, `timeout` when it killed the script at the deadline, or a start error's code |
| `skip` | A call of a route's tool it sent nothing for | `status` (not completed), `command`, `session`, `cwd` (no folder found), `timeout` (the session reads outlasted the deadline), `off`, or `gone` (the call's folder was removed) |
| `off` | Once, when a script could not start for want of Node | `ENOENT` |

- No `setup` line: OpenCode did not load the plugin, or the variable is not in its plugins' environment. Check the
  entry, and that `opencode --version` prints 2.0 or later.
- An `off` line: no Node on the service's `PATH`. Set `PATH` or `AIDRIAN_NODE`, then restart the service
  ([Running aidrian](#running-aidrian)).
- `skip` with `cwd`: the call's `workdir` was not an absolute path.
- `run` with `0` and no row: the folder holds no project with `.aidrian/`, or the command made no pull request call
  the [session ledger](../hooks.md#session-ledger) records.

What OpenCode 2.4.0 showed with the plugin folder loaded by a path entry, as `test/hosts.test.mjs` loads it, with
`--standalone` on every call but the last:

- The loader takes the package's server entry, `opencode/server.mjs`, whose default export is
  `{ id: 'aidrian', setup }`.
- `opencode models --standalone` loads plugins, and its trace holds the `setup` line.
- `opencode plugin list --standalone` prints `No plugins found` whatever is installed: it asks its private server
  before any plugin has loaded. Against a server whose plugins have loaded, `plugin list --server <url>` names a
  path entry as `aidrian  local  <path>`.
- The commands that wait for plugins, such as `models`, wait at most 5 seconds and then go on without them, so on a
  loaded machine the first start may end before `setup` runs.

## Rules for the other hosts' sessions

These rules hold Claude Code and Codex sessions, the hosts whose hooks run the guards: a session no Human attends on
either may not plant what an OpenCode session would load, nor run OpenCode to start a session or change its config.
They hold no session that runs on OpenCode, where no guard runs ([Limits](#limits)).

**Host files at a checkout's root.** `.opencode`, a folder refused with all it holds, and `opencode.json` and
`opencode.jsonc`, files, also met through a hard link: `.opencode/plugins/` loads code into the next OpenCode session
in that checkout, and either config file can name plugins. The agent gate hook refuses their writes to a session no
Human attends in its own worktree, each checkout nested in it, and its attempt's clone
([Agent gates](../hooks.md#agent-gates)). A protected name ending `.json` or `.jsonc` is a file; any other is a folder.

**At any depth of a confined clone.** Any path with a `.opencode` part, and any `opencode.json` or `opencode.jsonc`,
in any case, by a file tool, the shell, a link's target, or a glob that may reach one. Whether OpenCode loads a nested
`.opencode` folder or config file has not been checked, so they are held wherever they lie.

**Auto-merge.** A pull request that changes `.opencode`, `opencode.json`, or `opencode.jsonc` at any depth keeps
auto-merge off, as do the plugin's own `opencode/` and `package.json` ([Auto-merge](../config.md#auto-merge)).

**Commands.** A subagent, and a session the background handoff route started, may not start or resume an OpenCode
session outside the [handoff gate](../handoff.md#the-gate); the refusal says the command "starts or resumes a session
of OpenCode". Every `opencode` command line counts as a start but `-h`, `--help`, `-v`, `--version`, and
`--completions` first, and these nine: `debug paths`, `mcp add`, `plugin add`, `plugin remove`, `service status`,
`service stop`, `service get`, `service set`, and `service unset`. The lists were read from the help of OpenCode 2.4.0
on 2026-11-23, failing closed: a command whose help takes `--server` talks to the background service, which OpenCode
discovers or starts, and a started service serves sessions, so it counts as a start. So do `upgrade` and `update`,
which may restart the service, `uninstall`, `auth export`, whose help was not read, and any word a later version adds.

A session no Human attends, and its subagents, may not run the subcommands that write OpenCode's config, a credential,
a pairing, the session store, or the program itself: `mcp add`, `mcp auth`, and `mcp logout`; `auth` whole, with
each of its subcommands; `plugin add`, `remove`, and `update`; `service set`, `unset`, and `stop`; `machine add` and
`remove`; `pair`; `session import` and `delete`; and `uninstall`, `upgrade`, and `update`. A subcommand is found
past the global options that take a value: `--server`, `--log-level`, `--completions`, `--session`, `-s`, and
`--prompt`.

Both guards read a package runner as the program it runs: `npx`, `bunx`, `npm exec`, `npm x`, `pnpm dlx`,
`pnpm exec`, and `yarn dlx` of `@opencode/cli` or `opencode-ai` run `opencode`, and of `@anthropic-ai/claude-code`
run `claude`.

**A confined clone.** On Claude Code's confined start, the clone gets an empty `.opencode` folder, and `opencode.json`
and `opencode.jsonc` holding `{}`, as placeholders, each file kept out of git through the git folder's `info/exclude`,
so on Linux the sandbox's denial holds on a path there at launch. An entry the clone tracks stays as it is. Codex's
confined start declares no placeholders, so its clone gets none ([Codex](codex.md#project-start)). A clone whose index
tracks `.opencode`, `opencode.json`, or `opencode.jsonc` as a link, at its root or any depth, is refused at start, on
Claude Code and Codex alike, as a Claude Code clone that tracks `.claude` as a link is.

Claude Code's sandbox denies writes to the three at the clone's root and to `**/.opencode`, `**/.opencode/**`,
`**/opencode.json`, and `**/opencode.jsonc` below it. It denies reads of OpenCode's own folders: `opencode` in the data
folder, the state folder, and the config folder, each under its `XDG_*_HOME` and its default below the home folder,
and the folder `OPENCODE_CONFIG_DIR` names; and of Codex's `auth.json`, under `CODEX_HOME` and in `~/.codex`. The
[sandbox proof](claude-code.md#the-sandbox-proof) tries to read those that are there. Whole folders, since OpenCode
2.4.0 imports `auth.json` into the credential table of `opencode.db`, the service's config holds the values
`service set env` gives, and `opencode.json` may hold a provider's key.

What each layer holds: the sandbox holds every write of a sandboxed command to a denied path. The write guard refuses a
write by a file tool and one the shell lexer reads in a command; it does not see a write a program makes by itself,
such as an interpreter writing a relative path, which only the sandbox stops. A file that reaches a pull request keeps
auto-merge off.

The one residual: the nested entries get no placeholder, so on Linux the sandbox's `**` globs may not hold a nested
`.opencode` or config file made after launch, as with Claude Code's own nested files. There the write guard is the
layer that holds, within the limit above.

## Limits

- No aidrian guard runs on an OpenCode session: not the agent gates, the Bash rules, the write hook, the merge guard,
  nor the tracker guard. Each blocks a call, and no live OpenCode tool payload or agent identity has been recorded.
- No unattended mark and no rule holds an OpenCode session, so `aidrian pr auto-merge` run there reads the session as
  one a Human attends, and `gh pr merge` runs unchecked.
- The rules on OpenCode's files and commands (`.opencode`, `opencode.json`, `opencode.jsonc`, and `opencode`'s own
  subcommands) hold Claude Code and Codex sessions, which may not plant what OpenCode loads, and hold no session that
  runs on OpenCode.
- No start lines, compaction checklist, line-length feedback, or stop checks: each must reach the model, and the
  bridge gives no hook a way to.
- No check-run record: the adapter declares no `shellRun`, and the one reader of that record, the subagent stop's
  evidence check, does not run here.
- No transcripts and no handoff route: no transcript reader exists for OpenCode, so no cost rows or reminders that read
  one, and `session.handoff.continue` falls back to `none`.
- No agents: no agent of this plugin is installed on OpenCode.
- `models.opencode` is accepted in config.json and read by nothing ([Models](../config.md#models)).
- A shell call whose `workdir` is not an absolute path records nothing, since its folder is not known here.
- No MCP tool call reaches a hook, so while `tracker.enabled` is true, `aidrian check` warns on a machine where
  OpenCode is set up: "on OpenCode, a write through any MCP tool passes unchecked".
- The command guards do not read a package runner's command-string option, such as `npx -c` or `npm exec -c`, nor the
  forms `bun x` and `pnpx`.
- Claude Code's confined sandbox hides Codex's `auth.json` only, not its `config.toml` or `history.jsonl`, and does not
  hide a config file `OPENCODE_CONFIG` names.
- Codex's own sandbox takes no list of credential stores, so a confined Codex session reads OpenCode's folders and
  Codex's own `auth.json` ([Codex residuals](codex.md#project-start)).
- Not checked on a live OpenCode: the Git install and the entry `plugin add` writes, a `semver:` range, what
  `plugin update` does to a Git entry, whether the shell hook's environment holds `PATH`, whether a subagent's session
  carries `parentID`, the `edit` tool's path field, where a server plugin's console output goes, whether the plugin
  context gives a version, whether OpenCode loads nested host files, and how its background service listens.
- Follow-ups: the guard routes, each with its own recorded live payload; phase 2, a handoff and transcript reader; and
  phase 3, a mod for OpenCode's terminal interface.
