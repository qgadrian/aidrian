# OpenCode

How the plugin installs and runs in OpenCode 2.0 and later.
On OpenCode a bridge plugin runs each session's start, the hooks after a tool call, the
[session ledger](../hooks.md#session-ledger) among them, and a root session's end ([Hooks](#hooks)), and no aidrian
guard holds an OpenCode session ([Limits](#limits)). No OpenCode session has run any of these hooks.
OpenCode 1.x is not supported. The install command is also in the [README](../../README.md#opencode).

## Install

The plugin installs as a package from this repository, by a Git specifier whose `::path:` selector names the plugin
folder. The package is the folder's tracked files, so `scripts/`, `lib/`, `bin/`, and `hooks/hooks.json` arrive with
the bridge; on 2.4.0 the install left out the folder's `.gitignore` files, which nothing on OpenCode reads.
There is no npm package: `plugins/aidrian/package.json` is private, so never install by the bare name `aidrian`,
which names whatever a registry holds under it. It needs OpenCode 2.0 or later; 1.x is not supported.

`<owner>/aidrian` is this repository on GitHub: the [README](../../README.md#opencode) gives the command with its
owner. Following main, as the other two hosts do; `plugin add` writes the global configuration:

```sh
opencode plugin add 'github:<owner>/aidrian#main::path:plugins/aidrian'
```

On OpenCode 2.4.0, `plugin add` wrote the specifier as it was given, a string in `plugins` of `opencode.json` in the
global config folder: `{ "plugins": ["github:<owner>/aidrian#<ref>::path:plugins/aidrian"] }`. It installed the
package under OpenCode's cache folder, pinned in a lock file to the commit the ref named, with `bin/` executable.

Pinned to a release, with that release's tag in place of `main`:

```sh
opencode plugin add 'github:<owner>/aidrian#vX.Y.Z::path:plugins/aidrian'
```

A release tag installs only from the first release whose `plugins/aidrian/` holds `package.json`: on 2.4.0, the tag
`v0.85.4`, older than that file, failed with `Could not read package.json` and left the configuration unchanged.

For a team, in the project's `opencode.jsonc`, so every session in that project loads it, the same entry `plugin add`
writes:

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
- A `semver:` range is not documented. On 2.4.0, `#semver:^0.85.0::path:plugins/aidrian` was resolved and cloned,
  then failed with `Could not read package.json`, as no release tag held the package yet, so whether it installs the
  newest matching release has not been checked.
- `opencode plugin update` keeps the Git entry, and moves a branch entry's install to the branch's newest commit,
  when it asks a server whose plugins have loaded.
  On 2.4.0, against an isolated `opencode serve --port 0` after a `models` call loaded the plugins, with the
  install's lock set back one commit: `plugin check --server <url>` printed `aidrian 8420a18 (update available)`
  and changed nothing; `plugin update --server <url>` installed the branch's
  head in a new folder of OpenCode's cache, after which `plugin list --server <url>` showed `b9b0f0a`, and the entry
  in `opencode.json` was byte for byte the same. Its own output said `No plugin updates available` even so, so read
  `plugin list` after it, not its output. Against the background service, which runs the same server, it was not
  run.
- With `--standalone`, `plugin update` and `plugin check` change nothing: they ask a private server before any plugin
  has loaded, so they print `No plugin updates available` and `No package plugins found`, and given the entry as a
  target, both fail with `Plugin is not configured`.

## Running aidrian

- The bridge puts the plugin's `bin/` first on the `PATH` of every shell OpenCode starts, so `aidrian` and
  `aidrian-knowledge` run in its shell tool, and the `aidrian` that reads the ledger is the copy whose hook wrote it.
  It adds nothing when that `PATH` already holds the folder, or when the folder's path is not absolute or holds the
  path delimiter. A shell with no `PATH` of its own, such as one on another machine, is left as it is.
- In a terminal outside OpenCode, put the folder on the `PATH` first; from a checkout:
  `export PATH="/absolute/path/to/aidrian-harness/plugins/aidrian/bin:$PATH"`.
- The hook scripts need Node 22, and OpenCode's own binary is Bun. Server plugins run in OpenCode's background
  service, unless a command passes `--standalone`, so Node 22 must be on that service's `PATH`, or `AIDRIAN_NODE` in its
  environment must name a Node 22 binary by an absolute path; a relative `AIDRIAN_NODE` is ignored. The bridge finds
  Node once, at setup, as an absolute file: `AIDRIAN_NODE`, else its own process's program when that is Node, else the
  first `node` on an absolute entry of the service's `PATH`; it never runs a bare `node`. By the 2.4.0
  source, `opencode run` with no service running uses a private server instead, as `--standalone` does, while
  `models`, `reload`, `session list`, `session delete`, and `api` start the service; `stats` and the `service`
  subcommands were not traced. A service a command starts inherits that command's whole environment.
  For example, in the form the help of `opencode service set` gives on 2.4.0:

  ```sh
  opencode service set env AIDRIAN_NODE /absolute/path/to/node
  opencode service restart
  ```

- Restart the service after changing either, so it runs with the new value: a bridge that found no Node at setup runs
  no hook for the life of that setup; it says so in a system part of every model step and compaction request
  ([Session hooks](#session-hooks-and-what-reaches-the-model)), and in the trace's `off` line
  ([Troubleshooting](#troubleshooting)). A script that fails to start later,
  or is not on disk when its call checks it, fails that call alone, and on a blocking route refuses a subagent's call
  ([Hooks](#hooks)).
- `AIDRIAN_NODE` reaches only the bridge's hook scripts. The `aidrian` and `aidrian-knowledge` commands run `node`
  from the shell's `PATH`, so a shell where only `AIDRIAN_NODE` names Node records the ledger through its hooks while
  `aidrian session snapshot` in that shell fails: put Node 22 on the shell's `PATH` as well.
- A `--standalone` command of OpenCode 2.4.0 does not load a project's `.env` into the private server its plugins run
  in: a dummy variable in a `.env` at the start folder and at its parent reached no plugin. Whether the background
  service loads one has not been checked.

### How OpenCode's server listens

Checked on OpenCode 2.4.0 on 2026-11-23, in an isolated home:

- The private server a `--standalone` command starts, `opencode serve --stdio --port 0`, listened on one TCP port of
  `127.0.0.1`, chosen by the system, and on no socket file (`lsof` on its process).
- Its API needs a password, a new one each start by the 2.4.0 source: `/api/info`, `/api/session`, `/api/config`,
  and `/api/plugin` answered `401` to a request with no credential and to one with a wrong one. Each other path
  tried, such as `/` and `/session`, answered `200` with the same 9,401-byte HTML page, the web interface's.
- `opencode serve --port 0`, with the password in `OPENCODE_PASSWORD`, listened the same way, on `127.0.0.1`, and
  answered `/api/info` with `401` without the password and `200` with it. Its HTML page held neither the password
  nor any word like password, token, secret, or authorization; the one match for "credential" was the attribute
  `crossorigin="use-credentials"` of its manifest link. The scripts the page loads were not read.
- The background service was not started, since it takes a fixed port that the user's own service held. The 2.4.0
  source gives it `127.0.0.1:49374` on the release channel, unless `service set` changes the host or port, and the
  same password rule: a password from `service set`, or a new one each start, written to `service.json` in
  OpenCode's state folder, which its commands read to find and reach it. A request to that port with no credential
  has not been checked. What that password guards is in [Limits](#limits).

## Hooks

OpenCode reads no `hooks.json`. `npm run build` writes every hook of it, in its order, to
`plugins/aidrian/opencode/routes.generated.json`, and the bridge, `plugins/aidrian/opencode/bridge.mjs`, reads that
list, through `plugins/aidrian/opencode/route-select.mjs`, when OpenCode loads it
([Adding a host](adding-a-host.md#delivery-comes-first)). `HOOKS` in `plugins/aidrian/opencode/routes.mjs` maps each
standard event the bridge has an OpenCode hook for, and `EVENTS`, the events it runs, is the part of it no hook can
block on, as `plugins/aidrian/lib/hook-result.mjs` reads each event's answer (`canBlock`, an exit 2 that blocks):
`SessionStart` and `SubagentStart`, whose lines reach the model on `context`, `PostToolUse` on `execute.after`, and
`SessionEnd` on OpenCode's `session.deleted` event, which is no hook: the bridge reads it from the event stream
([Session end](#session-end)).
The events a hook can block on, `PreToolUse`, `UserPromptSubmit`, `PreCompact`, and `Stop`, stay out until a live
OpenCode session shows that hook refuse a call and let a control call run, so no guard runs and no route blocks a
call in this version.
On each call the bridge reads the tool's standard name from `plugins/aidrian/lib/hosts/opencode-names.mjs`, the one
table the adapter reads too, and runs every route of that event whose matcher fires on the name, in parallel, as
Claude Code runs matching hooks. A matcher fires as Claude Code reads it: a list of names, such as `Edit|Write`, on
those names alone, and any other pattern, such as `mcp__.*`, on a match anywhere in the name.
The build accepts only part of what Claude Code does. A matcher is `"*"`, a list of names made of letters, digits,
`_`, and `-`, separated by `|`, or a regular expression with no comma and no whitespace. So a pattern holds no `{1,3}`
quantifier; write the repeats out or use a character class. A pattern holds no lookaround and no backreference,
which Codex's Rust regex rejects. An empty matcher fails the build, and so does a group with
no matcher on a tool event, such as `PreToolUse` or `PostToolUse`. Such a group says `"*"` to mean every tool.
The leaf names each built-in tool by the standard tool of its job, as `shell` is `Bash` and `patch` is `Edit`, and an
MCP tool `mcp__<server>__<tool>` from its `info`. A call it cannot name, such as an MCP tool's with no `info` or a tool
of [this list](#built-in-tools-no-gate-names-by-a-standard-name), runs nothing and is counted unguarded
([Troubleshooting](#troubleshooting)). So after a call that completed, this version runs `hook-bash-post.mjs`,
`hook-markdown-wrap.mjs`, `hook-agent-post.mjs`, or `hook-tracker-post.mjs`, as `hooks.json` runs them, each stopped
at its own timeout. It also runs each session's start
([Session hooks](#session-hooks-and-what-reaches-the-model)), and a root session's end ([Session end](#session-end)).

Each selected script gets the standard hook payload on stdin, with a top-level `opencode` object that marks it as
OpenCode's, and the adapter, `plugins/aidrian/lib/hosts/opencode.mjs`, maps the rest. A call that errored or was
stopped sends nothing, as Claude Code runs `PostToolUse` only after a call that succeeded. The session reads happen
once a call, before any script starts, under their own 2 s cap (`READ_MS` in `plugins/aidrian/opencode/call.mjs`);
a read that fails or comes later is no reason to skip the call, which is sent with what was read
([Session ids](#session-ids)). Each script then has its own route's timeout from its own start, and is killed when it
ends. The program is Node, its arguments the script's path and the route's literal flags, with no shell, and it runs
in the session's folder.

The bridge reads each script's answer, its exit and what it wrote, as Claude Code reads it
(`plugins/aidrian/lib/hook-result.mjs`), merges the answers of one call, and applies the result in
`plugins/aidrian/opencode/output.mjs`. It keeps at most 256 KiB of each script's stdout and of its stderr
(`CAPTURE_BYTES`): far above the longest answer a hook script gives, a refusal's few lines or the context of a start
hook, so every such answer fits, while a script that writes without end costs the OpenCode service a bounded amount of
memory. Past the bound the bridge keeps reading, keeps no more, and still waits
for the script's exit; it never kills a script for writing, since a killed script reads as no answer. An answer past
the bound carries no text: an exit 2 on a blocking route still refuses, with
`A hook refused this call, and its message was too long to show.`, and any other answer is read as empty.
A `PostToolUse` answer gives no block. Its context, `additionalContext` or an exit 2's stderr, reaches the model at the
end of the call's result, only once every after-route of the call has read the original result
([Hook context in a tool result](#hook-context-in-a-tool-result)). Only an `execute.before` callback ever
rejects, and only for a refusal; every other callback resolves whatever fails inside it. A hook that cannot run, by a
bridge timeout or crash, lets the call run, as a hook error does on Claude Code, with one exception: on a blocking
route, a script that does not start refuses a subagent's call. A script missing when its call checks it, or gone when
it exits 1, does not start: Node exits 1 on a missing script, which would read as a hook error, so the bridge checks
each script is a file right before it spawns it, and again when it exits 1. Any other exit 1 stays a hook error.
A route whose script was missing at setup stays registered for that reason: each call checks again, so the script
runs once restored, with no restart. Until then a subagent's call on a blocking route is refused, a root session's
call runs, and a record-only route records nothing.

A blocking route, on `execute.before`, which `EVENTS` does not name in this version, is built to these rules, and the
tests reach it through the bridge's `events` seam. It never skips a call for a reason the call's input controls: a
`workdir` that names no folder, such as another machine's, or an input of another shape still sends the call, and only
a call with no session id, which OpenCode sets, sends nothing. Its script is killed no sooner than its route's timeout,
nor than 1 s past the longest guard budget a script gives itself (`BLOCKING_KILL_MS` in `bridge.mjs`, from
`lib/deadline.mjs`), so the script's own "could not finish in time" refusal comes first. A script's exit 2 refuses
the call: the callback rejects with an `Error` whose message is the script's stderr, which OpenCode 2.4.1's plugin
adapter turns into a `Tool.Error` with that message, failing that call alone, so the bridge imports nothing of
OpenCode's. An `updatedInput` replaces the event's `input` before the tool runs, and two hooks that rewrite the input
differently refuse it. The context of a call no hook refused is kept for that call's result
([Hook context in a tool result](#hook-context-in-a-tool-result)), so a routed `execute.before` registers
`execute.after` too, even with no `PostToolUse` route. A subagent's call, or one whose caller could not be read ([Session ids](#session-ids)), is
refused when a script does not start, one not on disk when the call checks it included, and when it is made in code
mode (`codemode` true): no recorded OpenCode session shows this plugin's hooks reading a code-mode call as they read a
direct one.

The stop route, `Stop` on OpenCode's `experimental.idle` session hook, which `EVENTS` does not name either, is built
the same way and reached through the same seam, as are the `prompt` and `compaction` routes. On a root session's idle
it sends `hook-stop.mjs` the root session's own folder, `stop_hook_active`, `last_assistant_message`, the text of the
last assistant message of `session.context`, which gives every message since the latest compaction, read under the
same 2 s cap, and the idle hook's `background` as it came, as `opencode.background`. A child session's idle runs no
stop route, nor does the idle of a session whose caller could not be read ([Session ids](#session-ids)), which reads
as a child's, nor that of a root whose folder is not on disk. A stop route's block sends the session back with a
`session.synthetic` message holding the hook's reason. The bridge keeps `stop_hook_active` for each session: false on
a turn's first idle, set once the session admitted a send-back, and dropped at that session's next idle, which reads
it, and on its `session.deleted` event, which the bridge listens for once it routes a start or `SessionEnd`, whether
or not `context` registered, or registered the idle hook. A
turn interrupted after a send-back leaves it for the next turn's first idle, which then sends nothing back.

`test/opencode-bridge.test.mjs` fails when `hooks.json` names a script this table lacks, and when its yes rows differ
from the scripts the bridge can run, the generated routes of `EVENTS` whose matcher fires on a name the leaf returns.
Its conformance test runs each OpenCode call the tests hold a payload of through the bridge, and checks that the
scripts it ran are those `hooks.json` fires on the name the adapter reads from the payload. Fixture only means the
real script ran in tests on a payload shaped as the bridge sends it, which no live OpenCode has sent: for
`hook-bash-post.mjs`, `test/fixtures/hosts/opencode/bash-post.json`, built from the types of `@opencode/plugin@2.4.0`
and the source embedded in the OpenCode 2.4.0 binary; for `hook-session-end.mjs`, the payload the bridge sends on a
root's `session.deleted`, run in process on the bridge's fake spawn; for the others, a payload
`test/opencode-adapter.test.mjs` builds from the 2.4.1 source and runs in process, not through the bridge's spawn, for
`hook-markdown-wrap.mjs` a `write` call alone: a `patch` carries no text that script reads. Script not run, on no row
today, means the bridge's tests run its route with a fake spawn alone.
`test/opencode-fixtures.test.mjs` fails on a committed OpenCode fixture that holds a home path; a key the fixture, the
payload the bridge sends, its `opencode` mark, or a tool result does not have; a message or system key; a prompt or last
message other than a placeholder; a session id of another shape; an environment beyond the adapter's session variables,
as a map or a list of `NAME=value`; or text the public-text guard refuses, such as a local path, an email address, or a
secret. No check can tell conversation text from tool output inside a recorded result: that text is bounded by the
fixture's `live` flag, its provenance line, and the pull request's review.

| Script | Runs on OpenCode | Verified | Why not |
| --- | --- | --- | --- |
| `hook-bash-post.mjs` | yes | fixture only | |
| `hook-session-start.mjs` | yes | fixture only | |
| `hook-prompt.mjs` | no | - | `UserPromptSubmit` can block, and no live session has shown what its refusal does on OpenCode; it also reads transcripts, which no OpenCode reader exists for |
| `hook-agent-gates.mjs` | no | - | A guard: no route blocks a call until a live tool payload and its agent identity are recorded |
| `hook-enter-worktree.mjs` | no | - | Claude Code's `EnterWorktree` tool, which OpenCode does not have |
| `hook-bash.mjs` | no | - | The Bash rules and the merge guard block a call, which waits on a recorded live shell payload |
| `hook-write.mjs` | no | - | The write hook blocks a call, which waits on a recorded live refusal |
| `hook-mcp-github.mjs` | no | - | The GitHub MCP rules block a call, which waits on a recorded live refusal |
| `hook-tracker-pre.mjs` | no | - | The tracker guard blocks a call, which waits on a recorded live refusal |
| `hook-ask.mjs` | no | - | It runs before a question, and no route runs before a tool call |
| `hook-agent-pre.mjs` | no | - | No agent of this plugin runs on OpenCode, so no model choice reaches one |
| `hook-markdown-wrap.mjs` | yes | fixture only | |
| `hook-agent-post.mjs` | yes | fixture only | |
| `hook-plan-exit.mjs` | no | - | Claude Code's `ExitPlanMode` tool |
| `hook-tracker-post.mjs` | yes | fixture only | |
| `hook-compact.mjs` | no | - | `PreCompact` can block, and no live session has shown what its refusal does on OpenCode |
| `hook-stop.mjs` | no | - | `Stop` is not in `EVENTS`: no live OpenCode session has recorded a send-back, and some of its checks read transcripts |
| `hook-subagent-stop.mjs` | no | - | No agent of this plugin runs on OpenCode, and the checks must reach the model |
| `hook-session-end.mjs` | yes | fixture only | |

### Hook context in a tool result

OpenCode 2.4.1's `execute.after` event carries a completed call's `result`, a `Tool.Result` of `output`, `content`,
and `metadata`, which a plugin may replace, and the model reads its `content`: text, a list of text and file parts,
or, when that is empty or missing, the `output` written out as text or JSON. On a completed call the bridge appends
the call's hook context to that content as text parts, after the content as OpenCode would read it, and leaves
`output` and `metadata` as they were: first the call's `PreToolUse` context, then the merged `PostToolUse` context of
its routes, in route order. It does so only after every after-route has run on the result as it came, so no route's
payload holds another's context, and it replaces the result instead of changing it in place. An errored call's
result is left as it was. A `PreToolUse` context, such as a `warn` hit, is the bounded stdout the reader read; the
bridge keeps it from `execute.before`, once every before-route answered and none refused the call, under the calling
session's id and the event's `id`, in one map cleared whole once it holds 256 calls (`CONTEXTS_MAX` in `bridge.mjs`),
and takes it out on that call's `execute.after`, whatever its status. A `warn` hit reaches the agent with the call's
result, and is lost for a call with no event id and for one the size bound cleared. No hook context goes to the trace
or into `system`. Fixture only: no live OpenCode session has shown a model read the appended part.

### Session end

`SessionEnd` runs `hook-session-end.mjs` for a session with no parent, on its `session.deleted` event, and on nothing
else: `session.archived` runs no hook, and what an archived session leaves, such as its gate snapshot, goes with the
snapshot's 30-day sweep. The event carries the session's id alone, and the session may no longer be readable, so the
bridge reads no session there: it runs the hook only for a session a finished walk ended at, its own or a child's, and
that holds no parent link ([Session ids](#session-ids)), with the last folder such a walk gave as its folder and
`cwd`, and the root's id as `session_id`. A start of that session that still runs ends first, within its own
timeout. A child's delete runs nothing, since its payload would carry its root's id and delete the root's records while
the root runs on. A session whose root-ness the bridge cannot tell runs none, traced as a `skip` with `read`: one it
never read in this setup, and one whose folder the 256-entry map of root folders forgot. Nor does a root whose folder is
gone, traced with `cwd`. The root's start lines, stop state, and kept folder are dropped after its end ran. The payload
carries no `reason` and no `transcript_path`, so the hook deletes the session's records and writes no session row.
OpenCode publishes a root's delete event before it removes the root's children, so the root's records are deleted
before its children stop, and a child's call that settles later can leave records under the root's id until the
30-day sweep. The bridge reads the event from OpenCode's event stream: if that stream fails or is absent, no
`SessionEnd` runs for the rest of that setup, and no notice says so. Fixture only: no live OpenCode session has sent a
`session.deleted` event to the bridge.

### Session hooks and what reaches the model

Each text the plugin gives the model goes through the one hook OpenCode 2.4.1 lets a plugin change at the moment that
text must reach it, so no text waits for a later request or lands in another session:

| Text | OpenCode hook | Where it goes | Why that hook |
| --- | --- | --- | --- |
| The start lines, and the bridge's notices | `context` and `compaction` (session hooks) | A system part after OpenCode's own, marked `metadata.aidrian` | `context` is the one hook that changes the `system` of each model step; the compaction request has its own hook, and the same part there keeps the prefix it shares with the session's requests |
| The prompt hook's lines | `prompt` | Its own file part of the prompt, plain text inline, named `aidrian` and described `aidrian hook context`, after the Human's files; the Human's text part stays as it was | The prompt is the one mutable input of that moment, and the lines may quote a reply the model wrote, which never goes into `system` |
| The compaction checklist | `compaction` | A system part of the compaction request, after the start lines | The compaction request is built after its hook runs, and its summary prompt is added after, so the hook's `system` is where the summary's instructions can go |

Only plugin text goes into `system`: the start lines, the bridge's notices, and the compaction checklist. The start
lines are the plugin's own sentences, filled with counts, the indexed docs' paths, `config.json` values, folders, and
the main checkout's branch name. The one text of a model's a start can print, a cleared session's handoff, needs a
continue route OpenCode lacks. The bridge's `prompt` and `compaction` callbacks never reject, so a block from one of
their routes is not applied, one more reason both events stay out of `EVENTS`.

The session start runs `hook-session-start.mjs` once for each root session for the life of one setup of the bridge,
not of the process: by the 2.4.1 source, OpenCode sets a plugin up once for each Location, and again when a plugin
loaded at or before it changes, so a start may run again after either. It runs, and is waited for, in the first
awaited callback, `context`, `compaction`, `prompt`, a tool hook, or the idle hook, that names a session of that root
with no start yet, before that callback's routes; OpenCode's `session.created` event starts nothing. A child session's
first callback runs its root's start first, then its own `--subagent` run. The lines a start gives, the context of its
answer, are kept for that session, a root's or a child's, and every model step and compaction request of it carries
them; a child's requests carry its own lines, as a subagent gets only its own on Claude Code. A start that fails is
traced and kept as no lines, so it never runs again, as a failed `SessionStart` is not repeated on Claude Code. A
session read that fails is no run, traced as a `skip` with `read`, and neither is a folder that is not on disk, with
`cwd`: the next callback asks again, and a child's start waits for its root's. A start script gets the `PATH` a shell
gets, the plugin's `bin/` first on the service's, so its lines name commands as a shell there finds them; a session
with a `PATH` of its own in OpenCode is not read. No script runs on a request of a session that started. A session's
`session.deleted` event drops its kept lines. The bridge registers `context` and `compaction` when it has something
for them: a start route, a `PreCompact` route, or a notice, such as the one that says no Node was found.

Every hook that is no tool hook, the start, stop, compaction, and prompt hooks, runs with the root session's own folder,
from its session read, as its folder and its payload's `cwd`, and a child's `--subagent` start with the child's own. A
session whose folder is not on disk, or names none, runs none of them, traced as a `skip` with `cwd`; that folder is
never replaced by the plugin's or the service's, which may be another checkout. Each payload sends the root session's
id as `session_id`, and a child's own as `agent_id`.

### Standard tools with no OpenCode equivalent

The standard tools `hooks.json` matchers name that OpenCode has no tool for, or none this plugin reads yet, each with
its reason.
`test/opencode-bridge.test.mjs` holds each name to a `hooks.json` matcher and to no name the leaf returns, and fails
when a plain tool name of a matcher is none the leaf maps, no other host's own name, and not on this list.

- `EnterWorktree`: OpenCode has no such tool.
- `ExitPlanMode`: OpenCode has no such tool.
- `NotebookEdit`: OpenCode has no such tool.
- `Task`: Claude Code's older name of `Agent`, which OpenCode's `subagent` tool reads as.

The ledger hook writes the ledger and the worktree links on OpenCode. It writes no
[check-run record](../hooks.md#check-runs), since the adapter declares no `shellRun`. It reads a created pull
request's link from the call's output, which the adapter's `shellOutput` takes from the shell result's `output.output`.

The bridge sends the call's folder as `cwd`, for a shell call as OpenCode 2.4.1's shell tool resolves its `workdir`,
which is read from no other tool's input: `~` and `~/` from the home
folder, then the result resolved against the calling session's folder by path alone, so an absolute `workdir` keeps
its place with its dot segments normalized, and a relative one, `ab:x/../..` among them, may climb out of the
session's folder. With no `workdir`, it sends the session's folder: the calling session's, read on every call since a
session can move, else the plugin's own, else the folder the OpenCode service runs in. A `workdir` that names no
folder here, as another machine's `name:/path` does, is sent with the session's folder on a blocking route, and skips
the call on `execute.after`, so the ledger records nothing for it. `execute.after` also skips a call whose folder is
not known: the calling session's folder is gone, as a removed worktree's is, or could not be read, and its `workdir`
is neither absolute nor `~`. That call never goes to the plugin's folder or the service's in its place, which may be
another checkout, while a blocking route still sends it from there. The script itself runs in the session's folder,
else the plugin's own, else the service's, which exists whatever the call names.

### Built-in tools no gate names by a standard name

OpenCode 2.4.1's built-in tools that have no Claude Code tool of the same job, by the name a hook receives.
A gate pattern written with a standard name, such as `Read` or `Bash`, meets none of them, and the bridge leaves them
unrouted: a gate that names one by OpenCode's own name does not make the bridge route it.
The leaf, `plugins/aidrian/lib/hosts/opencode-names.mjs`, maps every other built-in tool,
and `test/opencode-names.test.mjs` fails when a tool 2.4.1 registers is in neither, in both, or when an entry here
names no such tool. An entry that ends in `*` is a family.

- `execute`: Code Mode's own tool, which runs a program of other tools; a call inside it reaches the hooks under that tool's name, with `codemode` true.
- `opencode_session_*`: `rename` and `move` a session, `search` and `read` sessions behind the `sqlite_fts` flag,
  and `interrupt` one behind the `full_codemode` flag.
- `opencode_worktree_*`: create, list, and remove a repository's worktrees; none moves the session into one, as `EnterWorktree` does.
- `opencode_models`: searches the models available to use.
- `opencode_list_mcp_events`: the types of events an MCP server pushes, to trigger an automation with.
- `opencode_artifact_*`: OpenCode's artifacts, behind its `artifacts` flag.
- `automation_*`: a project's jobs, each a prompt, a Code Mode script, or a shell command,
  run once at a set time, on an interval, on a cron, or on an MCP server's event.
- `machine_list`: the other computers the server can work on, those still waiting to join among them, behind the `machines` flag.
- `browser_*`: the browser plugin's 44 tools.
- `generate_image`: an image from an image model, while one is available.
- `generate_video`: a video from a video model, while one is available.

### Payload fields

Each field a script of `hooks.json` reads from its payload, itself or through the rules it calls, and where the bridge
takes it from on OpenCode. By the types of `@opencode/plugin@2.4.1`, a tool event carries `tool`, `sessionID`, `agent`,
`messageID`, `id`, and `codemode`, `info` when OpenCode has the tool's, and the tool's `input`; after a call, also
`status`, and `result` when the call completed. The idle hook, `experimental.idle`, carries `sessionID` and
`background` alone, and the `session.deleted` event `sessionID` alone. The bridge sends the `PostToolUse`,
`SessionStart`, `SubagentStart`, and `SessionEnd` fields on the routes of
`EVENTS`, and the `PreToolUse`, `UserPromptSubmit`, `PreCompact`, and `Stop` fields on the routes its tests reach
through the `events` seam. None means no OpenCode hook or session read gives the field, and the checks that need it are in
[Limits](#limits).

| Field | Read by | OpenCode source |
| --- | --- | --- |
| `hook_event_name` | OpenCode's adapter's `detect`, which tells a hook's payload from a shell's environment | The bridge, from the route's standard event |
| `opencode` | OpenCode's adapter: `payloadMark`, and `hookInput`, which hands `info` to the name table | The bridge: `version`, the plugin context's `app.version` when it is text, and `info`, the part of the event's `info` the name table reads, `{ name, namespace }`, or `{}` when it holds no such pair |
| `turn_id` | Codex's adapter, as its payload mark | None |
| `effort` | `hook-session-start.mjs`, for a subagent's effort line, through Claude Code's adapter (`subagentEffort`, which reads `effort.level`) | None: the OpenCode adapter reads no effort |
| `session_id` | `hook-agent-gates.mjs`, `hook-bash.mjs`, `hook-bash-post.mjs`, `hook-write.mjs`, `hook-mcp-github.mjs`, `hook-tracker-pre.mjs`, `hook-tracker-post.mjs`, `hook-agent-post.mjs`, `hook-session-start.mjs`, `hook-prompt.mjs`, `hook-stop.mjs`, `hook-subagent-stop.mjs`, `hook-session-end.mjs`, and every hook's refusal row (`lib/hook-deny.mjs`) | The event's `sessionID`, followed up its parents to the root session ([Session ids](#session-ids)) |
| `agent_id` | `hook-agent-gates.mjs` and the guards it calls, `hook-bash.mjs` and its rules, `hook-bash-post.mjs`, `hook-tracker-pre.mjs`, `hook-tracker-post.mjs`, `hook-agent-pre.mjs`, `hook-agent-post.mjs`, `hook-enter-worktree.mjs`, `hook-plan-exit.mjs`, `hook-session-start.mjs`, `hook-prompt.mjs`, `hook-subagent-stop.mjs`, `hook-session-end.mjs`, and every hook's refusal row (`lib/hook-deny.mjs`) | The event's `sessionID`, when it is a child session's |
| `agent_type` | `hook-agent-gates.mjs`, `hook-tracker-pre.mjs`, `hook-tracker-post.mjs`, `hook-subagent-stop.mjs` (its delivery check and stop row), `hook-agent-post.mjs`, and every hook's refusal row (`lib/hook-deny.mjs`) | None: a tool event's `agent` names the agent a session runs, OpenCode's own `build` or `plan` among them, and no agent of this plugin is installed there. A child session's call carries `agent_id` alone, so the agent gates hold it to every `agents` entry, as the strictest subagent ([Agents](../config.md#agents)), once a route runs before a tool call; none does yet |
| `cwd` | Every script but `hook-compact.mjs` | A tool event: a shell call's `workdir`, which no other tool's input is read for, `~` from the home folder, resolved by path from the session's folder, else the session's folder from a session read; on `execute.after`, a call whose folder neither names is skipped, as [Hooks](#hooks) says. Any other hook: the root session's folder, from its session read, and a child's `--subagent` start the child's own. `SessionEnd`: the root's last folder a finished walk gave, since a deleted session is not read |
| `tool_name`, `raw_tool_name` | `hook-agent-gates.mjs`, `hook-bash.mjs`, `hook-mcp-github.mjs`, `hook-tracker-pre.mjs`, `hook-tracker-post.mjs`, `hook-agent-pre.mjs`, `hook-agent-post.mjs`, `hook-ask.mjs`, `hook-enter-worktree.mjs`, `hook-plan-exit.mjs`, and every hook's refusal row (`lib/hook-deny.mjs`) | The event's `tool`, mapped by the adapter's `hookInput` through the name table the bridge picks its routes by: a built-in tool as the standard tool of its job, and an MCP tool as `mcp__<server>__<tool>` from `info` |
| `permission_tool_name` | `hook-agent-gates.mjs` | None: the adapter sets none, as no OpenCode tool is known to run under another tool's permission rules |
| `sandbox_escape` | `hook-agent-gates.mjs`, through its sandbox escape guard (`lib/confine-guard.mjs`) | None: OpenCode's shell tool input asks for no sandbox escape, and the adapter maps none |
| `tool_input.command` | `hook-bash.mjs`, `hook-bash-post.mjs`, `hook-agent-gates.mjs` and the guards it calls | The shell tool's input, which names it `command` too, so it needs no mapping. Its `workdir` is read by the bridge alone, as `cwd` |
| A file edit's path and text | `hook-write.mjs`, `hook-markdown-wrap.mjs`, `hook-agent-gates.mjs`, each through `fileEditOf` alone | The adapter's `fileEdit`, from the `edit`, `write`, and `patch` tools' input; only `hook-markdown-wrap.mjs`, after the edit, is routed |
| A file read's path | `hook-agent-gates.mjs`, through `fileReadOf` alone | The adapter's `fileRead`: `path` of the `read`, `grep`, and `glob` tools' input, the call's folder when unset |
| An MCP tool's input | `hook-mcp-github.mjs`, `hook-tracker-pre.mjs` | The event's `input`, as the server takes it, once a route runs before a tool call |
| The input of `Agent`, `AskUserQuestion`, and `EnterWorktree` | `hook-agent-pre.mjs`, `hook-agent-post.mjs`, `hook-ask.mjs`, `hook-enter-worktree.mjs` | None: OpenCode has no `EnterWorktree`, and its `subagent` and `question` tools take inputs of their own, of which the adapter maps a `subagent` call's `agent` to `subagent_type` alone. `hook-agent-post.mjs` reads that and `description` |
| `tool_response` | `hook-bash-post.mjs` (`shellOutput`), `hook-tracker-post.mjs` (`toolResponse`), `hook-agent-post.mjs` | A completed call's `result`, read through the adapter; for an agent dispatch, none |
| `transcript_path` | `hook-agent-gates.mjs` (the Human's typed prompts, which lift a session's unattended mark), `hook-subagent-stop.mjs` (the requests a subagent's transcript copies from its parent's), `hook-prompt.mjs`, `hook-stop.mjs`, `hook-session-end.mjs`, `hook-plan-exit.mjs`, and the rules of `hook-bash.mjs` and `hook-mcp-github.mjs` that read the Human's answers or a commit's author | None: OpenCode keeps a session in its own store, which no transcript reader of this plugin reads (`transcripts: false`) |
| `agent_transcript_path` | `hook-subagent-stop.mjs` | None, for the same reason |
| `stop_hook_active` | `hook-stop.mjs`, `hook-subagent-stop.mjs` | The bridge's own state for each session: false on a turn's first idle, true on the idle after a send-back the session admitted ([Hooks](#hooks)). With no value, neither hook sends a stop back |
| `last_assistant_message` | `hook-stop.mjs` (the announce, merge hand-back, and hand-back checks), `hook-subagent-stop.mjs` (the delivery check and the final report) | The text parts of the last assistant message `session.context` gives, read at idle under the 2 s cap; left out when the read fails or finds none |
| `background_tasks` | `hook-stop.mjs` (the announce, review-loop, and merge hand-back checks), `hook-subagent-stop.mjs` (the running-children check) | The idle hook's `background`, which the bridge sends as it came, as `opencode.background`, which the adapter maps. Its entries name a `kind` and no standard `id`, `type`, or `status`: a `shell` entry's id is its `shellID`, a `subagent` entry's its `childSessionID`, a `codemode` entry's its `jobID`, and an `image` or `video` entry has none. The stop checks count only an entry with a string `id`, so the mapping gives an entry of the idle session's own the id its kind names, and a descendant's entry none |
| `prompt` | `hook-prompt.mjs`, for its handoff lines alone | The prompt hook's `prompt`, read only on a host with a continue route, and OpenCode declares none |
| `source` | `hook-session-start.mjs`, for a clear alone | None: OpenCode's `session.created` event names no source such as a clear, and the value is read only on a host with a continue route |
| `reason` | `hook-session-end.mjs`, for a clear and for the session row | None: the `session.deleted` event gives no reason, so no clear is seen there; with no `transcript_path` either, the hook writes no session row |
| `custom_instructions` | `hook-compact.mjs` | None: the compaction hook takes no instructions of the Human's, and the hook prints its checklist when the field is missing |

## Session ids

- By the 2.4.0 source, every command OpenCode's shell tool runs has `OPENCODE=1` and `OPENCODE_SESSION_ID`, the
  calling session's id; no live shell call has shown it. The adapter reads that variable as a command's session.
- The snapshot reads no host variable, so in an OpenCode shell pass the session to it:
  `aidrian session snapshot --session "$OPENCODE_SESSION_ID"` shows that session's pull requests.
- The bridge files a subagent's rows under the root session: it follows each session's `parentID` up to the root, at
  most 8 steps, and sends the root as `session_id` and the calling session as `agent_id`, as a subagent's rows land on
  Claude Code. A read counts as the session only when it gives an object whose `id` is the id asked for, as 2.4.1's
  `Session.Info` always carries, so `{}` or an error object is no session.
  The bridge reads a session's parents on each call, with its folder, and keeps each parent link a read gave, at most 256
  before it forgets them all. A session a read once named a parent for stays a subagent for that setup: its delete event
  keeps its link, so a late call of it, or of its own child, stays under its root.
  A walk finishes at a session whose read names no parent and that holds no link, and that session is the root: the call
  is the root session's own only when the walk finished without a step. A read that fails, comes past the 2 s cap, or
  gives no session, a walk that runs out of its 8 steps, as on a cycle, and a walk that ends at a linked session are
  unfinished. Such a call is sent with the id the kept links lead to as `session_id`, 8 of them at most, the calling
  session's own id when it holds none, and the calling session as `agent_id`, never as the root session's own call, so a
  child's call keeps its root session's holds, and the agent gates would judge it as the strictest subagent once a route
  runs before a tool call ([Agents](../config.md#agents)); none does yet. A start, stop, prompt, or compaction runs
  nothing for an unfinished walk.
- A subagent's own shell names the child session in `OPENCODE_SESSION_ID`, so that command run there shows none of
  the root session's pull requests.
- A command in an OpenCode that was itself started from a Claude Code or Codex shell reads the outer host's session:
  the variables of that host stay in its environment, and detection asks OpenCode's variables last. A hook the bridge
  runs is OpenCode's by its `opencode` mark, whatever variables the process inherited. A background service that a
  command in a Claude Code or Codex shell started gives that host's variables to every OpenCode session it serves, so
  their shell commands read the outer host's session too; restarting the service from a plain terminal clears them.
  The snapshot command above still names the OpenCode session, since it passes `OPENCODE_SESSION_ID` itself.
- Whether a subagent's child session carries `parentID` has not been checked on a live OpenCode.

## Troubleshooting

A session hears only of what failed at setup, in the bridge's notices
([Session hooks](#session-hooks-and-what-reaches-the-model)); every later failure is silent there, a session's end that
ran nothing included, so the bridge keeps one trace. With `AIDRIAN_OPENCODE_TRACE` naming an absolute file in the
environment OpenCode's plugins run in, the bridge appends one JSON line a step, `{ at, step, script, status, count }`,
each field after `step` only where it applies, to that file, which it creates owner-only; a file already there keeps
its mode. `at` is the time, `script` a hook script's file name, `status` a word or a number from the table below, and
`count` a number: how many calls this setup of the bridge has counted unguarded, on an `unguarded` line.
It never writes a command, a path, a payload field, stderr, or stdout there, a value of another shape is left out, and
a relative path writes nothing.
Set it as `AIDRIAN_NODE` is set: `opencode service set env AIDRIAN_OPENCODE_TRACE <file>`, then a service restart.

| `step` | When | `status` |
| --- | --- | --- |
| `setup` | Once, when OpenCode loads the plugin | How many OpenCode hooks it registered besides `create.before`: 3 in this version, `execute.after`, `context`, and `compaction`, or 2, the last two, to give a notice, when it read no route list or found no Node |
| `off` | Once, at setup, when it found no Node, before `setup` | `node` |
| `unregistered` | At setup, for each OpenCode hook that failed to register, and each route whose script is not on disk, before `setup` | The OpenCode hook, such as `execute.after`, with `script`, one line for each script it would have run (`create.before`, `context`, and `compaction` have no `script`), or `missing`, with the script not on disk at setup, whose route stays registered: each call checks again, as a `run` with `missing` until the script is restored |
| `run` | Each time it ran a script, or found it gone | The exit code or signal, `timeout` when it killed the script at its time, a start error's code, such as `ENOENT`, or `missing`, a script not on disk when the call came, which it does not spawn, or gone when it exited 1, and it runs again on the first call after it is restored; each of the last two ends that call alone, and on a blocking route refuses a subagent's call |
| `skip` | A call, or a session's start, stop, prompt, compaction, or end, it sent nothing for, and once at setup for a route list it could not read | `status` (after a call that did not complete), `command` (after a shell call whose `command` is no text), `session` (no session id, a session's end included), `cwd` (after a shell call whose `workdir` names no folder here, such as one on another machine, or whose session's folder is gone or could not be read while its `workdir` is neither absolute nor `~`, before a start, stop, prompt, or compaction route whose session's folder is not on disk, and at the end of a root whose last folder is not on disk), `unguarded` (a tool whose name the leaf does not read, such as an MCP tool with no `info`, with `count`, how many such calls this setup has met), `read` (a walk that did not finish ([Session ids](#session-ids)), before a start or a prompt or compaction route, and the end of a session the bridge cannot tell is a root ([Session end](#session-end))), `subagent` (a child session's idle, or one whose caller could not be read ([Session ids](#session-ids)), which runs no stop route, and a child session's end, which runs no `SessionEnd`), or `routes` (at setup: `routes.generated.json` is missing or no JSON list, so no tool hook is registered) |
| `refuse` | A call a blocking route refused, after its `run` lines | `hook` (a script's exit 2), `rewrite` (two rewrites of the input that differ), `spawn` (a subagent's call whose script did not start), or `codemode` (a subagent's call in code mode) |
| `send-back` | A session a stop route sent back, once the session admitted the message | `stop` |

- No `setup` line: OpenCode did not load the plugin, or the variable is not in its plugins' environment. Check the
  entry, and that `opencode --version` prints 2.0 or later.
- An `off` line: no Node on the service's `PATH`. Set `PATH` or `AIDRIAN_NODE`, then restart the service
  ([Running aidrian](#running-aidrian)).
- An `unregistered` line: OpenCode refused that hook, so the scripts it names do not run in that process, or the
  script is `missing` from the installed package at setup. A missing script is checked again on each call, so it runs
  once restored, with no restart; until then it runs nothing, and a script missing when its call checks it, or gone
  when it exits 1, refuses a subagent's call on a blocking route. The bridge gives the session a notice of it, as
  of `off` and of `routes`; when `context` is the hook that did not register, the trace is the sign.
- `skip` with `cwd`: the call's `workdir` names no folder on this machine, or the session's folder is gone, as a
  removed worktree's is, or could not be read, and no absolute `workdir` names the folder instead.
- `run` with `0` and no row: the folder holds no project with `.aidrian/`, or the command made no pull request call
  the [session ledger](../hooks.md#session-ledger) records.

What OpenCode 2.4.0 showed with the plugin folder loaded by a path entry, as `test/hosts.test.mjs` loads it, and by
the Git entry `plugin add` wrote, with `--standalone` on every call but those that name `--server`:

- The loader takes the package's server entry, `opencode/server.mjs`, whose default export is
  `{ id: 'aidrian', setup }`. From the Git install, OpenCode's log names that entry inside the installed package.
- `opencode models --standalone` loads plugins, and its trace holds the `setup` line, written owner-only.
- The plugin context names OpenCode's version as `app.version`, `2.4.0`, which the bridge sends in its `opencode`
  mark.
- `opencode plugin list --standalone` prints `No plugins found` whatever is installed: it asks its private server
  before any plugin has loaded. Against a server whose plugins have loaded, `plugin list --server <url>` names a
  path entry as `aidrian  local  <path>`.
- The commands that wait for plugins, such as `models`, wait 5 seconds and then go on without them: with a probe
  plugin whose setup took 12 seconds, `models` printed its list at 5.2 seconds and ended at 8.2, once its private
  server stopped. The bridge, loaded after the probe, wrote no `setup` line in that command, so another plugin with a
  slow setup can keep it from running, as a loaded machine can on the first start.
- A server plugin's `console.error` goes to the private server's standard error, which a command shows only with
  `--print-logs` or `OPENCODE_PRINT_LOGS=1`; its `console.log` is shown nowhere, and neither reaches OpenCode's log
  file. Where the background service sends them has not been checked.

## Rules for the other hosts' sessions

These rules hold Claude Code and Codex sessions, the hosts whose hooks run the guards. A session no Human attends on
either is refused a write of OpenCode's host files in the places below, and the OpenCode commands below; a subagent
and a session the background handoff route started are also refused a start of an OpenCode session. They do not
cover every place an OpenCode session loads from ([Limits](#limits)), and they hold no session that runs on OpenCode,
where no guard runs.

**Host files at a checkout's root.** `.opencode` and `.agents`, folders refused with all they hold, and
`opencode.json` and `opencode.jsonc`, files, also met through a hard link: `.opencode/plugins/` loads code into the
next OpenCode session in that checkout, either config file can name plugins, and OpenCode loads skills from
`.agents/skills/`. The agent gate hook refuses their writes to a session no Human attends in its own worktree, each
checkout nested in it, and its attempt's clone ([Agent gates](../hooks.md#agent-gates)). A protected name ending
`.json` or `.jsonc` is a file; any other is a folder. So a session no Human attends no longer edits a project's
`.agents/plugins/marketplace.json` or `.agents/skills/`, as it never edits `.claude/skills/`.

**Between a session's place and the checkouts nested in it.** The same root names of every host, Claude Code's
`.claude` settings and folders and `.mcp.json` among them, in each folder strictly between the session's worktree and
a checkout git lists inside it, such as `.claude/`, `.claude/worktrees/`, and `.worktrees/` of a main checkout that
holds task worktrees. OpenCode loads those of every folder above a session's start folder, and a worktrees folder is
git-ignored, so a file planted there would reach every session started in a task worktree below with no review. The
worktrees folder `git.worktrees.dir` names, `.worktrees` by default, is held so whether or not a checkout is in it
yet, and so is each folder between it and the main checkout. Any other folder between is told from the checkouts git
lists on that call, so a host's own worktrees folder, such as `.claude/worktrees`, holds no refusal while no checkout is
nested in it (the residuals below).

**In the temporary folders.** In `TMPDIR`, `/tmp`, and every folder below them, any host file a host loads from any
depth: the union of every host's nested list, here the `.opencode` and `.agents` folders and config files OpenCode's
adapter lists and
Claude Code's `.claude` folder's skills, agents, commands, hooks, workflows, and settings, and any `SKILL.md`; and
any instruction file a host loads from every folder above a session, `CLAUDE.md`, `CLAUDE.local.md`,
`.claude/CLAUDE.md`, `AGENTS.md`, or `AGENTS.override.md` (each adapter's `instructionFiles`), since a review's exec
reviewer, such as `claude -p`, starts in a base checkout under `TMPDIR`. An
OpenCode session started anywhere below such a folder would load it with no sandbox. The refusal says it is "a host
file a session started below that temporary folder loads". A copy, move, or link is judged by the path it names and by
the name it makes inside a destination folder, the source's relative path under `rsync -R` and `cp --parents`, not by
what a copied or moved folder holds: `mv stage .opencode`, `cp pkg/opencode.json <tmp>/x/`,
`rsync -aR p/.opencode/plugins/x.js <tmp>/w/`, and `ln -s` that names a host file as the link or as its target are refused. Other
files there pass, as before, and a state folder or a checkout inside a temporary folder keeps its own rules.

**At any depth of a confined clone.** Any path with a `.opencode` or `.agents` part, and any `opencode.json` or
`opencode.jsonc`, in any case, by a file tool, the shell, a link's target, or a glob that may reach one. OpenCode 2.4.0 loads the
`.opencode` folder and the `opencode.json` of the folder a session starts in and of each folder above it, and none
below it: a probe plugin in `pkg/.opencode/plugins/` and one that `pkg/opencode.json` names ran when a command started
in `pkg`, not when it started at the project root, and the root's two ran from both. So a nested one loads into every
session that starts at or below its folder, and in a confined clone they are held wherever they lie. Its plugin
folders, `plugin/` and `plugins/`, load a `.js` or `.ts` file, or a folder; a `.mjs` file there is not loaded.

What OpenCode 2.4.0's log and source show of that walk: it goes up to `/`, with no stop at a git repository's root
(a command started in a checkout watched the folders above the checkout too); and in each folder it reads `.claude`
and `.agents` as well as `.opencode` (the log shows it watching `skills` inside them).

What `.claude` and `.agents` feed, as read from the 2.4.0 binary as text, not seen in a run. Its function
`ConfigDiscovery.discover` walks up from the start folder through `FileSystem.up` with no stop folder, and in each
folder looks for `.claude`, `.agents`, `.opencode`, `opencode.jsonc`, and `opencode.json`. Its `claude` list is
`~/.claude` and each `.claude` folder found; its `agents` list is `~/.agents` and each `.agents` folder found. The one
caller of `Config.compatibility()`, which returns those lists, is the plugin `opencode.config.compatibility`: it joins
`skills` to each folder of both lists, watches it, and reads every skill file `SkillScan.scan` lists there, each
`SKILL.md` up to six folders down and each `.md` file in `skills` itself, then adds the parsed skills to the session.
So both feed skills, from `<folder>/.claude/skills` and `<folder>/.agents/skills`. `.claude/skills` is already Claude
Code's host file, at a root and at any depth; OpenCode's adapter holds `.agents` whole, which Codex also uses, for its
plugin marketplace. The binary's other `.claude`
strings sit in an embedded copy of the Claude Agent SDK, which runs Claude Code and names Claude Code's own settings;
no other reader of a project's `.agents` was found.

**Auto-merge.** A pull request that changes `.opencode`, `.agents`, `opencode.json`, or `opencode.jsonc` at any depth
keeps auto-merge off, as do the plugin's own `opencode/` and `package.json` ([Auto-merge](../config.md#auto-merge)).

**Commands.** A subagent, and a session the background handoff route started, may not start or resume an OpenCode
session outside the [handoff gate](../handoff.md#the-gate); the refusal says the command "starts or resumes a session
of OpenCode". Every `opencode` command line counts as a start but `-h`, `--help`, `-v`, `--version`, and
`--completions` first, and these nine: `debug paths`, `mcp add`, `plugin add`, `plugin remove`, `service status`,
`service stop`, `service get`, `service set`, and `service unset`. A `-h` or `--help` past the first word and before a `--`
reads a command's help, as `opencode serve --help` does, and starts nothing, unless the line holds a word the shell
expands, such as a variable or a brace list. The lists were read from the help of OpenCode 2.4.0
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
run `claude`. No list of the runner's options is kept: the program is the first word after the runner's own word,
such as npm's `exec` or pnpm's `dlx`, that names a host's program or package, wherever the runner's options stand, so
`npm --cache /d exec opencode run x` and `pnpm --dir x dlx opencode-ai run x` count (`lib/package-runner.mjs`).
The program the runner plainly runs is checked as well, so a host's name later in the call, as
`npx npm publish opencode`, leaves `npm publish` refused.
Its false refusals, to a subagent or a session no Human attends: a runner call that names a host's program as a later argument
of another program, such as `npx prettier claude` to the session-start guard or `npx prettier codex login` to the
config guard, and a runner option's value whose last path part is a host's program, such as
`npx --cache /tmp/opencode prettier x` to the session-start guard, since the runner's options are not parsed.

**A confined clone.** On Claude Code's confined start, the clone gets empty `.opencode` and `.agents` folders, and
`opencode.json` and `opencode.jsonc` holding `{}`, as placeholders, each file kept out of git through the git folder's
`info/exclude`, so on Linux the sandbox's denial holds on a path there at launch; an empty folder needs no exclude
line, since git shows none. An entry the clone tracks stays as it is, such as `.agents/plugins/marketplace.json`.
Codex's confined start declares no placeholders, so its clone gets none ([Codex](codex.md#project-start)). A clone
whose index tracks `.opencode`, `.agents`, `opencode.json`, or `opencode.jsonc` as a link, at its root or any depth, is
refused at start, on Claude Code and Codex alike, as a Claude Code clone that tracks `.claude` as a link is.

Claude Code's sandbox denies writes to the four at the clone's root and to `**/.opencode`, `**/.opencode/**`,
`**/opencode.json`, `**/opencode.jsonc`, `**/.agents`, and `**/.agents/**` below it, so git in a confined session
cannot write a tracked file below `.agents` either, as it cannot below `.claude/skills`. It denies reads of OpenCode's own folders: `opencode` in the data
folder, the state folder, and the config folder, each under its `XDG_*_HOME` and its default below the home folder,
and the folder `OPENCODE_CONFIG_DIR` names; and of Codex's `auth.json`, under `CODEX_HOME` and in `~/.codex`. The
[sandbox proof](claude-code.md#the-sandbox-proof) tries to read those that are there. Whole folders, since OpenCode
2.4.0 imports `auth.json` into the credential table of `opencode.db`, the service's config holds the values
`service set env` gives, and `opencode.json` may hold a provider's key.

What each layer holds: the sandbox holds every write of a sandboxed command to a denied path. The write guard refuses a
write by a file tool and one the shell lexer reads in a command; it does not see a write a program makes by itself,
such as an interpreter writing a relative path, which only the sandbox stops. A file that reaches a pull request keeps
auto-merge off.

The residuals, each with its reason:

- The nested entries get no placeholder, so on Linux the sandbox's `**` globs may not hold a nested `.opencode`,
  `.agents`, or config file made after launch, as with Claude Code's own nested files. There the write guard is the
  layer that holds, within the limit above.
- A sandboxed program's own write in a temporary folder passes: both confined sandboxes allow writes there, and a
  denial would break the tests and builds that make host-file fixtures there.
- A glob in a temporary folder is not judged for host files, so `cp x $TMPDIR/*/.opencode/plugins/` reaches a host
  folder another writer already made there: a glob expands only to paths that are there, which a program's own write
  can reach too, and judging it would refuse ordinary cleanup such as `rm -rf /tmp/work/*`.
- A session a pending mark holds keeps only the entries refused wherever they lie, since it may be one a Human opened
  in another repository.
- Depth inside a worktree that is not a confined clone is not held: the session writes a `pkg/.opencode` there, and
  only one that reaches a pull request keeps auto-merge off. That includes a host's own worktrees folder, such as
  `.claude/worktrees`, while no checkout is nested in it, since only the configured worktrees folder is held empty.
- A copy, move, sync, archive extraction, or clone of a folder whose contents hold a host file, such as
  `cp -R pkg <tmp>/x`, `mv pkg <tmp>/z`, `cp -R pkg/. dest`, `rsync -a pkg/ dest/`, `tar -x`, or `git clone`, or one
  that names its sources by a glob, is judged by its destination alone, in a temporary folder and at a worktree's root,
  with the reach of a program's own write.
- An rsync destination spelled `host:path` is judged by its path part only when the remote shell the call names, by
  `-e`, `--rsh`, or an `RSYNC_RSH=` it sets itself, may run here: anything but a bare `ssh` or `rsh`, or one by its
  absolute path in a system program folder such as `/usr/bin`, so `./sh` and `./ssh` are judged;
  one exported in an earlier step or inherited, a shim on `PATH` named `ssh`, or an `ssh` or `rsh` that reaches this
  machine, as `-e ssh localhost:<path>`, writes there unjudged, with the reach of a program's own write. So does the
  program `scp -S` or `sftp -S` runs in place of `ssh`, since neither is read as a writer. A source spelled `host:path`
  that `--remove-source-files` or `--remove-sent-files` deletes is not judged as a removal, even under such a shell.
- A move into a folder the same command line makes first, by a name with no closing slash, as
  `mkdir <tmp>/a && mv pkg/.opencode <tmp>/a`, is judged as a rename, since the folder is read from the disk when the call
  is checked.
- A target built at run time, such as `d=$TMPDIR/a; echo x > $d/.opencode/plugins/x.js` or
  `d=<main>/.worktrees; echo x > $d/opencode.json`, is judged by its names, and host-file names are not among them, so
  it passes, with the reach of a program's own write.
- A write to a path that an existing link in a temporary folder makes a host file passes, since the temporary rule
  reads the path's own parts and no links.
- The configured worktrees folder is read from `config.json` on each call, and a session in the main checkout may edit
  that file, so renaming `git.worktrees.dir`, writing a host file in the old folder, and renaming it back is not
  refused: three deliberate steps, and the tracked edit shows until it is reverted.

Never start OpenCode below the temporary folder: what any program wrote there loads into that session.

## Limits

- No aidrian guard runs on an OpenCode session: not the agent gates, the Bash rules, the write hook, the merge guard,
  nor the tracker guard. Each blocks a call, and no live OpenCode tool payload or agent identity has been recorded.
  Where OpenCode is set up, `aidrian check` warns that no merge guard, Bash rule, or write guard holds an OpenCode
  session, so a session there works only in a task worktree and never merges. OpenCode is set up when its global
  config, the file `OPENCODE_CONFIG` names, or a config in the project's root or a folder above it names this plugin
  ([the probe](adding-a-host.md#the-adapters-fields)). The probe reads at most 64 folders, the root among them, while
  OpenCode reads up to `/`, so a config deeper above than that loads in OpenCode with no warning from `aidrian check`.
- No unattended mark and no rule holds an OpenCode session, so `aidrian pr auto-merge` run there reads the session as
  one a Human attends, and `gh pr merge` runs unchecked.
- The rules on OpenCode's files and commands (`.opencode`, `.agents`, `opencode.json`, `opencode.jsonc`, and
  `opencode`'s own subcommands) hold Claude Code and Codex sessions no Human attends, in the places
  [above](#rules-for-the-other-hosts-sessions) names, and hold no session that runs on OpenCode.
- No compaction checklist, prompt lines, or stop checks: `PreCompact`, `UserPromptSubmit`, and `Stop` can block, so
  they stay out of `EVENTS` until a live session shows their refusal. The other routes are built, and run only through
  the tests' `events` seam ([Hooks](#hooks)). The start lines run, unchecked on a live OpenCode: no model turn has
  shown them reach the model.
- A hook's context, `hook-markdown-wrap.mjs`'s line-length feedback among them, is appended to a completed call's
  result ([Hook context in a tool result](#hook-context-in-a-tool-result)); no model turn has shown it read there.
  An errored call's context is dropped. A kept `PreToolUse` context is lost for a call with no event id and for one
  the 256-call bound cleared, and one whose `execute.after` never comes, as when a plugin loaded after this one
  refuses the call, stays in the map until that bound clears it or the same call id is seen again in that session.
- `SessionEnd` runs for a root session's delete alone ([Session end](#session-end)): an archived session's records stay
  until the gate snapshot's 30-day sweep, and so do those of a root the bridge cannot tell is one, such as one it never
  read in this setup, one it forgot past 256 sessions, or one deleted after OpenCode loaded the plugin anew,
  and of a root whose folder is gone. No session row is written, since the hook reads no transcript here.
- OpenCode removes a root's children only after the root's delete event, so the root's records are deleted before its
  children stop: a child's call that settles later can leave records under the root's id, and those wait for the
  30-day sweep.
  This is owed before any route runs before a tool call ([Adding a host](adding-a-host.md#before-a-bridge-host-routes-a-blocking-event)).
  A start still reading its session when that session's delete event comes is not waited for, so the records it saves
  wait for the sweep too.
- A session read that fails puts the session's start off to its next callback, so a model step can run without the
  start lines.
- If OpenCode's event stream fails or is absent, `SessionEnd` stops running for that setup, with no notice.
- The start lines go into `system` with the values a project and its machine hold: those of `config.json` and the names
  of `.aidrian.local.json` over them, doc paths, and the main checkout's branch name. No OpenCode session has run this.
- No skills: the bridge registers none of this plugin's skills, so a start line that names one, such as
  `lesson-triage`, `decision-review`, `persona-audit-triage`, or `session-handoff`, names a skill an OpenCode session
  has only when something else installed it. No OpenCode session has run this.
- A compaction request carries the start lines and, once `PreCompact` runs, the checklist as system parts: the
  checklist's part comes after the start lines, so a provider whose prompt cache keys on the request's prefix reads none
  of the conversation from it for that request.
- Checks that need a field no OpenCode hook gives ([Payload fields](#payload-fields)), which stay off even once the
  prompt and stop hooks run there: the names reminder, which is all `hook-prompt.mjs` prints while OpenCode declares
  no continue route, and reads the last reply from the transcript; the review-loop check and the merge hand-back check,
  which read the turn from the transcript; the session-length reminder, which reads the session's cost from the
  transcript; the subagent stop's running-children check, which tells the subagent's own tasks from the others by its
  transcript; and the delivery check's handoff file, whose brief it reads from the subagent's transcript.
  The announce, hand-back, and delivery checks read the last message from `session.context`, read at idle.
- Once the Bash rules run there, a rule that needs an answer the Human gave through the question tool, such as the
  review sign-off rule, finds none in a transcript and refuses.
- Once the agent gates run there, they never lift a session's unattended mark when the Human types, since they read
  the Human's prompt from the transcript.
- No check-run record: the adapter declares no `shellRun`, and the one reader of that record, the subagent stop's
  evidence check, does not run here.
- No transcripts and no handoff route: no transcript reader exists for OpenCode, so no cost rows or reminders that read
  one, and `session.handoff.continue` falls back to `none`.
- No background sessions: the harness starts none here, with no handoff route and no project start, so none can stay
  after its work. The adapter's `capabilities.backgroundSessions` declares `{ unsupported }` with that reason and
  nothing else ([the adapter's fields](adding-a-host.md#the-adapters-fields)), which `backgroundList` and
  `backgroundHeld` pass on as `byDesign: true`. By the adapter's declaration, held by `test/adapters.test.mjs`.
- No agents: no agent of this plugin is installed on OpenCode. A `subagent` call of OpenCode's own agents still writes
  a dispatch row.
  Its agent type is the agent the call named, or `general-purpose` when its input names none.
  Its dispatcher is `main` in a root session, and `general-purpose` in a child session, whose call carries no agent type.
  A call whose input sets `sessionID` is a follow-up to a subagent already started, by the 2.4.1 source.
  It writes a row too, so the rows count more dispatches than there were subagents.
  A row says its subagent did not run in the background, since it reads Claude Code's
  `run_in_background` and `async_launched`, which OpenCode's call does not have, though by that source OpenCode's
  subagents always do; no test asserts this. No OpenCode session has run this.
- An MCP server whose namespace ends in `_`, holds `__`, or is `opencode`, `automation`, `machine`, or `browser`, or
  whose tool's effective name starts with `mcp__`, has no standard name: its calls run no route and are counted
  unguarded. This too is owed before any route runs before a tool call. No OpenCode session has run this.
- What a route before a tool call would not see, once one runs there. Each is read from the 2.4.1 source alone; no
  OpenCode session has run any of it:
  - A tool offered only inside Code Mode that the model calls at the top level: `execute.before` gets no `info` and
    `codemode` false, so an MCP tool of that kind has no name the leaf can read, runs no route, and is counted
    unguarded, and the code-mode refusal does not meet it. Its `execute.after` has both. This is owed before any route
    runs before a tool call, when a refusal has to cover every call whose name the leaf cannot read: an MCP call with
    `info` and no standard name, and a call a plugin renamed, among them.
  - `automation_create` with a shell action: its command later runs through `Shell.create`, which triggers only the
    shell hook `create.before`, and the leaf has no standard name for the tool, so no Bash rule reads that command.
    This is owed before `hook-bash.mjs` runs there.
  - A plugin loaded after this one may change the event's `tool` or `input` once the guards answered, since both are
    mutable on `execute.before`.
  - The `move` tool of `opencode_session_*` changes a session's folder, which a route before a tool call has to read
    as a directory change for the main-checkout guard. This is owed before any such route runs.
  - A command in a child session's shell gets no session identity from the shell hook, since the shell's
    `create.before` event carries no session id: the hook cannot name the root session or mark the command a
    subagent's, so the command reads the child as its own session ([Session ids](#session-ids)).
  - `read` of a path that does not exist opens the one file of that folder whose name differs only in Unicode
    normalization, no-break spaces, or curly single quotes, so a gate reads the path as written, not the file opened.
  - `patch`, which can add a whole file, reads as `Edit`, so a gate that denies `Write` alone does not hold it.
  - In a machine's local settings file of mixed line endings, a `replaceAll` is replayed as written, while `edit` matches
    past the line endings.
  - `hook-agent-pre.mjs` would return a rewritten `subagent` input with the `subagent_type` the adapter adds for the
    hooks, a field OpenCode's tool does not declare. This is owed before that hook runs there.
- `models.opencode` is accepted in config.json and read by nothing ([Models](../config.md#models)).
- A shell call whose `workdir` names no folder here, such as one on another machine, records nothing, since its folder
  is not known here; so does one whose session's folder is gone or could not be read, unless an absolute or `~`
  `workdir` names its folder.
- No route runs before a tool call, so while `tracker.enabled` is true, `aidrian check` warns on a machine where
  OpenCode is set up: "on OpenCode, a write through any MCP tool passes unchecked".
  The `Tracker guard` start line names only the servers whose tools the lists leave out; on OpenCode no tracker write is
  judged, whatever the lists hold.
- The command guards do not read a package runner's command-string option, such as `npx -c` or `npm exec -c`, nor the
  forms `bun x` and `pnpx`.
- Claude Code's confined sandbox hides Codex's `auth.json` only, not its `config.toml` or `history.jsonl`, and does not
  hide a config file `OPENCODE_CONFIG` names.
- Codex's own sandbox takes no list of credential stores, so a confined Codex session reads OpenCode's folders and
  Codex's own `auth.json` ([Codex residuals](codex.md#project-start)).
- OpenCode reads the `.opencode` folder and `opencode.json` of every folder above a session's start folder, so a
  session started in a worktree below a main checkout loads that checkout's, and one started below the home folder
  reads the home folder's `.opencode` whatever `HOME` says: on 2.4.0 a command started inside an isolated home below
  the real one listed the real `~/.opencode` among its config sources. Of the folders above a start folder, the rules
  above hold every host's files in each folder between a session's place and a checkout nested in it, and at any depth
  of the temporary folders, `TMPDIR` and `/tmp`; a folder above the session's own checkout lies outside its places,
  where the write guard refuses every write, and the home folder's dot entries are refused whole. What stays open is
  listed in [the residuals above](#rules-for-the-other-hosts-sessions): depth inside a worktree that is not a confined
  clone, a session a pending mark holds, and the writes the guard does not see.
- By the 2.4.0 source, the background service's API runs sessions and shell commands as the user, and only the
  password in OpenCode's `service.json`, in its state folder, guards it.
  So any process that can read that folder and reach the loopback address can drive OpenCode as the user.
  Claude Code's confined sandbox denies that read; Codex's sandbox does not ([Codex residuals](codex.md#project-start)).
  A Claude Code or Codex session no Human attends, confined or not, such as a background handoff session, may not run
  a shell command that names one of OpenCode's credential stores, by its path, `~`, `$HOME`, `$XDG_STATE_HOME`, or any
  variable the hook's environment gives, with `/./` and `//` normalized, or the service's port after a host, as
  `127.0.0.1:49374`, `localhost:49374`, or `[::1]:49374` (the adapter's `localService`,
  [Agent gates](../hooks.md#agent-gates)). What stays open: a path or port the command builds at run time or reads
  from a file, a relative path from a folder above the store, a glob, a host and port given to a program as separate
  values, as `nc localhost 49374` or a Python `('127.0.0.1', 49374)` tuple, a host or port `service set` moved, a read
  of a store by the file tools, as Read, Grep, or Glob, in a session no sandbox confines, and a program that reads the
  store or reaches the port by itself, with the reach of a program's own write. A store path holding a space, as
  under a home or XDG folder whose name has one, may not be normalized in full, since quoting is dropped before
  paths are split at spaces.
- Not checked on a live OpenCode, since no model turn ran: a shell call's payload, and with it the Verified column's
  fixture only; whether the shell hook's environment holds `PATH`; whether a shell command gets
  `OPENCODE_SESSION_ID`; whether a subagent's session carries `parentID`; the `edit` tool's path field; and that the
  Git-installed bridge runs `scripts/` from inside the installed package, which only a `run` line would show. Also
  not checked: a `semver:` range against a release that holds the package, what `plugin update` does against the
  background service itself, where that service sends a plugin's console output, whether it loads a project's
  `.env`, and whether it answers a request with no credential.
- Follow-ups: the guard routes, each with its own recorded live payload; phase 2, a handoff and transcript reader; and
  phase 3, a mod for OpenCode's terminal interface.
