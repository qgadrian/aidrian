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
Set the version back before you commit: a pull request never changes it ([Versions](../contributing.md#versions)).

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
The [host adapter](../../plugins/aidrian/lib/hosts/claude-code.mjs) holds what the shared code reads from this host:
its payloads need no mapping, since their names are the standard, but for [a GitHub MCP server from a plugin](#a-github-mcp-server-from-a-plugin).
[Where the tracker guard is verified](../hooks.md#where-the-tracker-guard-is-verified) has the evidence.

Claude Code cancels a SessionEnd hook that runs longer than a short budget as it exits, about 1.5 seconds whatever
the `timeout` in `hooks.json` says, and reports `Hook cancelled`.
The session-end hook deletes the session's temporary files itself, and hands the [`session` row](../dispatch-log.md#session-when-a-session-ends)
to a detached worker, so a long session's transcripts never hold up the exit.
For a session holding a [tracker refusal marker](../config.md#how-a-write-is-judged), it also writes one `hook_deny` row in process.
That row reads no transcript and waits on no lock, so the hook stays within its budget.

## A GitHub MCP server from a plugin

Claude Code names a tool of an MCP server a plugin bundles `mcp__plugin_<plugin>_<server>__<tool>`
([its hooks reference](https://code.claude.com/docs/en/hooks)), so the GitHub MCP server installed through the `github`
plugin merges through `mcp__plugin_github_github__merge_pull_request`.
The adapter reads such a call as `mcp__github__<tool>`, the name the [merge guard](../hooks.md#merge-guard),
the [ready hold](../hooks.md#ready-hold), and the [review gate](../config.md#review-gate) read, when both hold:

- The tool is one of those the GitHub MCP hook judges: `merge_pull_request`, `update_pull_request`,
  `update_pull_request_draft_state`, `add_issue_comment`, `add_reply_to_pull_request_comment`, and `pull_request_review_write`.
- One word of the plugin and server names, words split at `_`, holds `github` in any case, such as `github_github`,
  `acme-tools_GitHub`, or `github-enterprise_gh`.

The tool name alone is not enough: other forges' MCP servers, such as Gitea's and Bitbucket's, have a `merge_pull_request`
or an `update_pull_request` of their own, and the merge guard refuses a merge whose head it cannot read.
So a GitHub MCP server under a plugin or server name that holds no `github` is not read, and its calls run unchecked.
The hook's payload keeps the name Claude Code sent as `raw_tool_name`, so a pattern a project wrote in that form still matches.
A second `PreToolUse` group in `hooks.json`, last so that no other group's place moves, runs the GitHub MCP hook on these
names, with the adapter's pattern, anchored and with no lookaround so that Codex reads it as well;
`test/host-plugin-github.test.mjs` holds the two equal. Verified with the GitHub MCP server's documented input through the
real hook, not with a live plugin install.

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

## Shell commands of the Monitor tool

The Monitor tool runs its `command` in a shell, in the background, under Bash's permission rules, and a subagent may
call it ([tools reference](https://code.claude.com/docs/en/tools-reference#monitor-tool)). From Claude Code 2.1.314, a hook
whose matcher is Bash gets those commands as Bash calls; before that version the [Bash rules](../hooks.md#bash-rules),
which hooks.json matches to Bash, skip a Monitor command. A hook whose matcher takes every tool, as the agent gates hook's
does, gets the Monitor call itself on every version ([hooks reference](https://code.claude.com/docs/en/hooks#match-monitor-commands)).
So the adapter's `hookInput` reads a Monitor call with a `command` as `Bash`, with `raw_tool_name: "Monitor"`, and the
handoff guard, the config guard, and the machine-switch guard of the [agent gates hook](../hooks.md#agent-gates) read it
as they read Bash on every version.

- A gate's `Bash` and `Bash(<prefix>)` patterns match a Monitor command. A `Monitor` pattern still matches it too,
  but when the same `allow` list has a `Bash(<prefix>)` pattern, the command must start with one of them, as a Bash call's must:
  `["Monitor", "Bash(git status)"]` lets `git status` run through Monitor, and not `rm -rf build` ([config](../config.md#agents)).
- A WebSocket watch takes `ws` in place of `command` and runs no shell, so it keeps the name `Monitor`.
  It runs under Bash's permission rules all the same, so `hookInput` adds `permission_tool_name: "Bash"`, and a bare
  `Bash` deny covers it; a `Bash(<prefix>)` pattern never matches it.
- A block names the tool the agent called, `Monitor`, not `Bash`.

## PowerShell commands

The PowerShell tool runs its `command` in PowerShell. It is on by default on Windows (with Git Bash installed, only for claude.ai and Console accounts unless `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`), and opt-in on
Linux, macOS, and WSL, and a subagent may call it ([tools reference](https://code.claude.com/docs/en/tools-reference#powershell-tool)).
The shared lexer reads POSIX shells, and it misreads PowerShell's `@(...)`, its backtick escapes, and its quoting, so the
adapter never reads a PowerShell call as Bash, and no `Bash(<prefix>)` pattern in an `allow` list ever admits one.

- In a `deny` list, every `Bash` and `Bash(<prefix>)` pattern blocks every PowerShell call, for the main session and every
  agent, on every platform: a gate that cannot read the command cannot hold it to the prefix, and the block says so.
  A `PowerShell` pattern names it too. Claude Code does the like only on Windows with Git Bash installed, and keeps the
  tool on there with `CLAUDE_CODE_USE_POWERSHELL_TOOL=1` or a `PowerShell` permission rule
  ([tools reference](https://code.claude.com/docs/en/tools-reference#bash-deny-rules-also-turn-off-the-powershell-tool)).
  A recorded limit: on Windows without Git Bash, where PowerShell is the only shell tool, a `Bash` deny in `main` or `*`
  leaves the main session no shell tool.
- The adapter lists the tool in `opaqueShellTools`, and the [agent gates hook](../hooks.md#agent-gates) reads its command
  as opaque text, failing closed for a subagent: a command that holds the words `handoff` and `continue`, or names the
  continuation store, a folder that holds it, a marker, or `.aidrian.local.json`, is refused, and, while gates are set,
  one that names a file that sets them. Each word is read as given and with PowerShell's joins undone: backticks removed,
  `'a'+'b'` folded, and quotes removed, typographic quotes such as `‘` and `“` included, so ``hand`off`` is `handoff`.
  A word that is a path counts by that path, from the call's folder when relative and from the home folder after a
  leading `~`, and a word with `*`, `?`, or `[` counts as a glob, judged as the [hooks page](../hooks.md#agent-gates) says.
  One pipeline of read-only cmdlets with plain words, such as `Get-ChildItem *` or `Get-ChildItem | Where-Object Name -like 'h*'`,
  writes nothing and is not judged by its paths and globs, though it still may not hold both `handoff` and `continue`,
  and still counts toward the word cap. A command of more than 512 words, counting each case, is refused for a subagent, as
  the guards read no more, and so is one they cannot finish reading within their time budget.
- The [Bash rules](../hooks.md#bash-rules), which hooks.json matches to Bash, do not run on a PowerShell command.

This rests on the [tools reference](https://code.claude.com/docs/en/tools-reference#powershell-tool) and the
[hooks reference](https://code.claude.com/docs/en/hooks#powershell), which give its command as `tool_input.command`, the
Bash tool's field, and on test fixtures of that shape. It has not run live: no session here had the PowerShell tool on.

## Handoff continuation

Claude Code does the `clear` route of [`session.handoff.continue`](../handoff.md#continue): after the brief, the Human
types `/clear` and then any message, which is the adapter's `steps.clear`, and the new session resumes from the brief.
It also does the `background` route, below, where nothing is typed.
`compact` falls back to `none` until its release, and `aidrian handoff route` prints `route: none` for it.
The route is verified on Claude Code 2.1.325: the host behavior it rests on on 2026-11-15, with a throwaway plugin, and
the route from end to end on 2026-11-16, with the plugin loaded from a branch. That live run found:

- The Bash tool's folder follows a `cd`: the gate ran from inside the task worktree and wrote the same project store,
  and the continuation was delivered. After the clear the new session starts in the folder the session was launched in,
  and the resume enters the worktree.
- `CLAUDE_CODE_SESSION_ID` in the Bash tool follows a clear: after the clear it printed the new session's id, the one
  the delivered continuation was bound to. So a second continuation in a row, with `Chain: 1`, armed for the live
  session and was delivered.
- The line that says a continuation was cancelled is model context only, the prompt hook's `additionalContext`: the Human
  does not see it.
- Whether typing `/clear` alone runs the prompt hook was not observed; `keepsArmed(prompt)` keeps the continuation
  either way.

The host behavior, from the throwaway plugin:

- The clear command issues a new session id. SessionEnd fires with `reason: "clear"` and the old id, then SessionStart
  with `source: "clear"` and the new id, about 100 ms later; both carry the same `cwd`. Its docs do not promise that order,
  so the session start waits up to 600 ms for the session end while a `clear` continuation is armed.
- Every hook's parent process is the `claude` host process, and it is the same before and after the clear: SessionStart
  with `source: "startup"`, SessionEnd with `reason: "clear"`, SessionStart with `source: "clear"`, and UserPromptSubmit
  all had one parent. A Bash tool command's parent is not it: node, then the shell, then that process. So the adapter's
  `hookHostPid()` is the hook's parent, and binds a continuation to the terminal that cleared. Were a later release, or
  a wrapper around a hook's command, to put another process between them, no id would match and nothing would be
  delivered: a miss, never a wrong take.
- SessionStart output `{ systemMessage, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } }`
  shows the banner to the Human, and the context reached the model after a clear.
- SessionStart's sources are `startup`, `resume`, `clear`, `compact`, and `fork`.

Not verified, each with its answer in the design:

| Not verified | What the plugin does |
| --- | --- |
| Whether UserPromptSubmit fires for the clear or compact command | The adapter's `keepsArmed(prompt)` leaves the continuation for `/clear`, `/reset`, `/new`, and `/compact`. |
| Whether other built-in commands fire UserPromptSubmit | Each one that does cancels the continuation, as any prompt does: only those four are spared. |
| Whether a hook payload's `cwd` follows a `cd` in the Bash tool, as the Bash tool's own folder does | No hook compares a folder: the session start matches the host process, and every checkout of the project shares one store. |

UserPromptSubmit also fires when a background subagent reports back, on a scheduled-task or loop iteration, on a
message from another session, and on the output of Claude's code in a Code Mode session when that code runs in the
background ([its hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit)). Each of those after the
gate cancels the continuation, so the `session-handoff` skill's first step settles them all, Code Mode code running
in the background among its background jobs, before it writes the brief and runs the gate.
The SessionEnd hook promotes the continuation before it hands the session row to its worker, within the host's 1.5 seconds.

### The background route

The adapter's `startBackground` (`lib/hosts/claude-code-background.mjs`) runs `claude` by its absolute path, found on
the absolute folders of PATH alone, so an empty or relative entry never runs a `claude` the folder holds:

1. `claude agents --json`, for the handing-off session's `name` and `cwd`, by its `sessionId`. That folder, where the
   host already runs a session, is where the new one starts, never the brief's worktree; a session the listing does
   not place starts nothing. The adapter then calls the gate's `hold` with that folder and the `sessionId` of every
   listed session, which files the pending mark that holds every other session until the new one's id is listed;
   when that fails, nothing starts.
2. `claude --bg --name '<name> · <n>' [--agent <agent>] [--effort <effort>] [--permission-mode <mode>] <prompt>` there,
   where the name is that session's, else the brief's slug, `<n>` the continuation's number, the agent
   `CLAUDE_CODE_AGENT` and the effort `CLAUDE_EFFORT` when each holds a value the adapter accepts, the mode the
   handing-off session's (below), and the prompt the continuation. It reads the short id from its
   `backgrounded · <id> · <name>` line.
3. `claude agents --json` again, every half second for about 5 seconds, for the one background session in that folder
   whose `sessionId` the first listing did not hold, by that short id, or by the name when the output printed none.
   The gate records the chain floor under its `sessionId`, else under the short id.

A start that printed no id and that the listing does not show returns a problem. It is certain that nothing started
only when `claude` never ran (`ENOENT` or `EACCES`), or exited non-zero with `Workspace not trusted` while the last
listing holds no background session the first did not: then the gate falls back to the clear route. Anything else,
such as any other non-zero exit, no exit within 60 seconds, a signal, or exit 0 with no id the listing names, is an
uncertain launch, since the supervisor may have taken the start and list its session later: it keeps the pending
mark (`uncertain: true`), and `findLine` names `claude agents` and `claude stop <id>` for the Human. A started session the gate cannot write a floor, mark, or start record
for is stopped with `claude stop <id>`. The `say:` line leads with `claude attach <id>`, adds `claude attach '<name>'` only when the
name is plain words, digits, spaces, and `.@:·-`, and no other listed session has it, and names `claude agents`.

`sessionEnded` reads `claude agents --json --all`, which `claude agents --help` says also lists the completed background
sessions. It reads a session that a start record names, by its `sessionId`, else by the short id the start printed,
as ended only when every row that names it is `kind: "background"` with `state: "done"`. On 2.1.326, on 2026-11-17,
a completed session's row had `state: "done"` and no `pid` or `status`, and a running one had `state: "working"` and
`status: "busy"`. Any other state, no row, or a listing that gives no answer counts as running, so the session that
started it starts no other. On 2.1.326, `failed` and `stopped` are states of their own, not `done`, so a session that
failed or that `claude stop` stopped holds the gate too: this comes from a reading of the host's source, and was not
run live. The adapter reads the `backgrounded · <id>` line only at the start of a line, so text echoed before it,
such as part of the prompt, cannot name another session.

Checked by hand on Claude Code 2.1.326 on 2026-11-17, with a trivial prompt rather than a real brief:

- `claude --bg` started from the Bash tool of a running session returns at once, prints
  `backgrounded · <id> · <name>` and the commands that manage it, and exits 0; `claude agents --json` then lists the
  session with `id`, `sessionId`, `name`, `kind: "background"`, and `cwd`, and the short id is the first part of the
  session id.
- `--bg` ignores `--session-id` with a warning, so the session id is read back from the listing.
- The background session ran the plugin's SessionStart hook, whose project knowledge line reached its context, and its
  UserPromptSubmit and Stop hooks. Its Bash tool's `CLAUDE_CODE_SESSION_ID` was its own id, not the starting
  session's, and `CLAUDE_CODE_AGENT` was unset: the variables of the shell that ran `claude --bg` do not reach it.
- In a folder the host has not trusted, with no terminal to ask, `claude --bg` exits 1 with `Workspace not trusted`
  before it starts anything, which the gate turns into a fallback. It is the one refusal the adapter knows.
- The background session started on the model and effort of the user's settings, not the starting session's.
  `CLAUDE_EFFORT` carries the effort; the model is not passed on.
- Neither the shell of the session's Bash tool nor `claude agents --json` gives the session's permission mode: the
  listing's rows hold `pid`, `cwd`, `kind`, `startedAt`, `sessionId`, `name`, `status`, `id`, and `state`. The
  transcript does, `~/.claude/projects/<start folder, each character but a letter or digit as ->/<session id>.jsonl`
  (under `CLAUDE_CONFIG_DIR` when set), with a `{"type":"permission-mode","permissionMode":"<mode>","sessionId":"<id>"}`
  entry; `claude --help` lists `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, and `plan` for
  `--permission-mode`.

So the adapter passes the handing-off session's permission mode with `--permission-mode`, so an unattended chain does
not stop at a prompt the old session would not have shown. It reads the last `permission-mode` entry of that session's
transcript, in the start folder's project folder, else in any project folder, from its last 16 MB, and passes it only
when it is `acceptEdits`, `auto`, `dontAsk`, `manual`, or `plan`; a transcript's `default` is passed as `manual`.
A session that runs in `bypassPermissions` starts nothing, and the handoff goes on by the clear route: a session no
Human attends never runs without permission checks. With no mode it can read, none starts either, since the host's
default may be `bypassPermissions`, and the fallback line says the mode could not be read.
Not verified live: a background start with `--permission-mode`.
- `claude agents --json` also lists interactive sessions, with `sessionId`, `name`, `kind: "interactive"`, and `cwd`,
  the folder the session was started in; `claude --help` lists `stop|kill <id>` and `attach <id|name>`.

The adapter's `sessionStart` names `claude` as the command that starts a session, for the
[agent gates](../hooks.md#agent-gates) hook, which refuses one to a subagent and to a session the background route
started: `claude` with no subcommand, with `-p`, `--bg`, `--resume`, or `--continue`, with a prompt, with
`mcp serve`, and with any subcommand it does not list, counts; `agents`, `attach`, `stop`, `kill`, `logs`, `doctor`,
`update`, `install`, `config`, `mcp`, `plugin`, `setup-token`, `auth`, `migrate-installer`, `--version`, and `--help`
do not. The list comes from the CLI reference and the `claude --help` output above; no live run of the hook checked it.

Not verified: a background continuation from a real brief, end to end, with the plugin loaded from this branch:
whether the session-continue skill runs from the first message as intended, and whether a second continuation in a
row reads the floor the gate wrote.

## Project start

`aidrian project start` starts an issue's session on Claude Code confined, as on [Codex](codex.md#project-start), but
no live Claude Code has run it this way: the host declares it `verified: 'unverified'`, and a run starts it only where
the default branch, on the forge and by its local ref, sets [`projectRun.unverifiedHosts`](../config.md#project-run).
Every start then prints an `unverified:` line. The sandbox's key names come from the host's settings reference and
sandboxing page, read on 2026-11-18; a value the host does not validate in a session no Human attends is silently
ignored, so the live checks below must show each one holds.

- Each attempt works in a fresh clone, never a linked worktree: in a linked worktree, the host's sandbox lets a
  session write the main repository's whole shared `.git` but its `hooks/` and `config`.
  `<state>/runs/<run>/attempts/<issue>.<attempt>/` holds `work/`, the clone, `git/`, its own git folder, which borrows
  the main checkout's objects read-only, `drop/`, where the session hands its result over, and `cache/`, empty and
  owner-only, where its package managers keep their caches, as on Codex. A first
  attempt cuts the issue's branch from the base tip, and is refused when the forge has that branch already. A clone
  that could not be made, or is refused so, leaves no attempt folder.
- The session starts with `claude --bg --name '<run> · <issue> · <attempt>' --permission-mode <the driver's>
  --setting-sources user --settings '<sandbox JSON>' --strict-mcp-config --mcp-config '<servers JSON>' <prompt>`, in the
  clone, with no agent. The settings are inline: no settings file is written.
- Before the launch, the start makes placeholders for the protected host files that can be there harmlessly, since on
  Linux a sandbox write denial holds only on a path there at launch: in the clone's git folder, an empty
  `config.worktree`, which git reads only once `extensions.worktreeConfig` is set in the config the sandbox denies, and
  a `commondir` of `.` and a newline, which git reads as "the common folder is this git folder", so status, commit,
  fetch, and push work as before (a test runs each with real git; an empty `commondir`, the host's own placeholder for
  a denied absent file on Linux, makes git die);
  `.claude/settings.json`, `.claude/settings.local.json`, and `.mcp.json` as `{}`, which `--setting-sources user` and
  `--strict-mcp-config` never load, each excluded through the git folder's `info/exclude`; and empty `.claude/skills`,
  `agents`, `commands`, `hooks`, and `workflows` folders. A file the base branch tracks stays as it is.
  `.claude/scheduled_tasks.json` is left out, as its shape is the host's. No placeholder is written through a link:
  each part of its path below the clone is checked, and one that is a link, as a `.claude` that leads elsewhere,
  refuses the start and leaves the link's target untouched. Any other `commondir` or `config.worktree`, a second
  link to either, or a link in their place, would lead git to another config: every git call of the plugin in such a
  clone runs no git, and the agent gate hook refuses every call there ([hooks](../hooks.md#agent-gates)).
- The start holds the session only once the plugin's agent gate hook files its beacon on the session's first tool
  call, within 180 seconds, as on Codex: it shows the plugin's hooks still load under `--setting-sources user`. The
  session's floor and mark are filed first, as soon as the host lists its id. A session whose beacon never comes is
  stopped, gives its attempt back, and halts the run until an attended `aidrian project resume`.
- An issue's session starts no continuation: `aidrian handoff continue` from it prints `continue: none`, and
  `aidrian handoff route` `route: none`, before any store or mark write. It pushes its work and records its result.

The settings the session starts with (`sandboxSettings` in `lib/hosts/claude-code-sandbox.mjs`, which the tests pin
whole). A scalar passed with `--settings` wins over the user's settings; a list merges with theirs, which the start checks.

| Key | Value |
| --- | --- |
| `sandbox.enabled`, `sandbox.failIfUnavailable` | `true`: no sandbox, no run |
| `sandbox.allowUnsandboxedCommands` | `false`: no command runs outside it, and the sandbox's own escape is off |
| `sandbox.autoAllowBashIfSandboxed` | `true`: a sandboxed command needs no prompt, since no Human answers one |
| `sandbox.enableWeakerNestedSandbox` | `false` |
| `sandbox.enableWeakerNetworkIsolation` | `true` on macOS only, where git and gh need it |
| `sandbox.allowAppleEvents`, `sandbox.allowNestedUserNamespaces` | `false`: no sandboxed command launches another application, or a user namespace of its own |
| `sandbox.filesystem.allowWrite` | the clone's git folder, the drop folder, the attempt's `cache` folder, the state work folders `plans`, `reviews`, `tmp`, and `dispatch`, the real `/tmp`, and the host's temporary folder; never the dispatch log |
| `sandbox.filesystem.denyWrite` | the clone's `.git` pointer, its git folder's `config`, `hooks`, `commondir`, and `config.worktree`, on every platform, each a placeholder there at launch; each protected host file of the clone: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/hooks`, `.claude/workflows`, `.claude/scheduled_tasks.json`, and `.mcp.json`; and, as `**` globs, any `.claude` folder itself at any depth, so none is made or made a link, those of each, its `settings*.json`, and any `SKILL.md`; the keep file `.aidrian-keep` of the attempt's `drop` and `cache` folders, there at launch, so neither can be emptied and removed, and a link put in its place |
| `sandbox.filesystem.denyRead` | the user's credential stores, below, and the main checkout, whose git-ignored files, such as env files, a session never reads |
| `sandbox.filesystem.allowRead` | the main checkout's git folder, when it lies in the main checkout: the clone borrows its objects |
| `sandbox.network` | `strictAllowlist: true`, `allowedDomains` the forge's hosts (`github.com` and its API host for GitHub) and the hosts of each registry the base branch's [`projectRun.registries`](../config.md#project-run) lists, none by default, `allowAllUnixSockets: false`, `allowLocalBinding: false`; no `allowUnixSockets` |
| `sandbox.credentials.envVars` | `{ name, mode: "deny" }`, so the variable is unset before each sandboxed command, for each variable of the driver's environment whose name says it holds a credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`, and the like) and the well-known ones, such as `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, and `SSH_AUTH_SOCK`, but the forge CLI's own token variables (`GH_TOKEN`, `GITHUB_TOKEN`, and their Enterprise forms) |
| `permissions.deny` | `Read(//<path>)` and `Read(//<path>/**)` for each credential store and the main checkout, since the file tools run outside the sandbox |
| `disableClaudeAiConnectors` | `true`: the claude.ai connectors, which `--strict-mcp-config` leaves on, neither load nor connect; a `true` from any source wins |
| `worktree.bgIsolation` | `"none"`, so `claude --bg` stays in the clone instead of moving into `.claude/worktrees` |

`allowLocalBinding: false` has a cost on macOS, where it is the switch for localhost: a test that listens on a local
port, or connects to one, fails in a confined session. On Linux it has no effect, and the network namespace keeps a
sandboxed command off the host's localhost.

No `sandbox.excludedCommands` is passed. Three conditions hold on top of the sandbox:

- **Only this plugin's hooks and command keys load.** `--setting-sources user` drops the project's and the local
  settings, with their hooks, `apiKeyHelper`, `statusLine`, and every other key that runs a command. So the start halts,
  recording nothing, unless the user's settings load this plugin: `enabledPlugins` holds `aidrian@<marketplace>: true`,
  or the host records it installed at user scope and no user setting turns it off. A plugin only a project's settings
  enable, or a project-scope install, never loads under `--setting-sources user`, and the start would wait 180 seconds
  for a beacon that never comes; install it at user scope, `claude plugin install aidrian@<marketplace> --scope user`,
  or add the `enabledPlugins` entry to `~/.claude/settings.json`. The user's own settings still load, so the start also
  halts when they set `hooks`, `apiKeyHelper`, `statusLine`, `subagentStatusLine`, `awsAuthRefresh`,
  `awsCredentialExport`, `gcpAuthRefresh`, `otelHeadersHelper`, `fileSuggestion`, `policyHelper`, `processWrapper`, or
  `sshHostCommands`; when any plugin other than this one counts as enabled, since a plugin's hooks, MCP and LSP
  servers, and monitors all run outside the sandbox: every plugin the host records installed, or `enabledPlugins`
  names, counts unless `enabledPlugins` sets it `false` and no enabled plugin depends on it, and one enabled with no
  install record counts too; when a skill, agent, or command of the user's config folder (`~/.claude/skills`,
  `agents`, `commands`) declares `hooks` or `mcpServers` in its frontmatter, bare or quoted; and when the clone holds
  such a skill, agent, or command under a `.claude` folder at any depth, or a link under one of those folders that
  leads out of it, as `.claude/skills/foo -> ../../.agents/skills/foo` does. Each one the base branch's
  [`projectRun.outsideSandbox`](../config.md#project-run) names passes. An entry named `.claude`, in any case, that is
  itself a link, at the clone's root or at any depth, as `pkg/.claude -> ../shared`, halts whatever the team names:
  the host would load its skills and settings from wherever it leads, which the walk never reads; replace the link with
  the folder. A later attempt whose branch changed a host
  file of the clone, such as `.claude/settings.json`, `CLAUDE.md`, or anything under `.claude/`, against the base tip
  is refused before anything starts.
- **Only the team's MCP servers load.** `--strict-mcp-config --mcp-config` passes only the servers the base branch's
  [`projectRun.mcpServers`](../config.md#project-run) names, none by default; a project's `.mcp.json`, the user's own
  servers, and the claude.ai connectors (`disableClaudeAiConnectors`) never load. Each listed server, and the helper
  command it starts, runs outside the sandbox with the user's full access, and its definition travels in the session's
  command line, which any process of the user can read in the process list.
- **The user's credentials are unreadable**, by a sandboxed command and by Read: `~/.ssh`, `~/.gnupg`, `~/.aws`,
  `~/.netrc`, `~/.docker`, `~/.kube`, `~/.config/gcloud`, `~/.azure`, `~/.oci`, `~/Library/Keychains`,
  `~/.password-store`, `~/.config/op`, `~/.1password`, the Chrome, Firefox, Brave, and Edge folders of
  `~/Library/Application Support`, `~/.mozilla`, `~/.config/google-chrome`, `~/.config/chromium`,
  `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, `~/.cargo/credentials.toml` and `~/.cargo/credentials`,
  `~/.gem/credentials`, `~/.vault-token`, `~/.config/hub`, the host's own `~/.claude.json`,
  `~/.claude/.credentials.json`, and `~/.claude/ide` (and those of `CLAUDE_CONFIG_DIR` when it moves them), the
  keyrings in `~/.local/share/keyrings`, and the shell histories `~/.bash_history`, `~/.zsh_history`, and
  `~/.local/share/fish`; and the package registries' other token stores: `~/.yarnrc.yml`, `~/.yarnrc`,
  `~/.config/npm/npmrc`, the npm user and global config files the driver's `npm_config_userconfig` and
  `npm_config_globalconfig` name, in either case, npm's global config `<prefix>/etc/npmrc` for the prefix the driver's
  environment names and the one the `npm` on PATH lies under, `~/.bunfig.toml`, `~/.local/share/gem/credentials`, `~/.bundle/config`,
  pnpm's `~/.config/pnpm/rc` and `~/Library/Preferences/pnpm/rc`, pip's `pip.conf` in `~/.config/pip`, `~/.pip`, and
  `~/Library/Application Support/pip`, poetry's `auth.toml` in `~/.config/pypoetry` and
  `~/Library/Application Support/pypoetry`, and `~/.local/share/uv/credentials`. Credential-named environment variables are unset in the sandbox, as the table says, and the
  main checkout is unreadable but its git folder. The forge CLI's login, `~/.config/gh`, and its token variables stay:
  the session pushes and opens pull requests through them. Git's `store` credential helper keeps the push token in
  `~/.git-credentials`, which the sandbox hides, so a main checkout whose git config names it halts the start: use the
  forge CLI's helper, `gh auth setup-git`.

The start also halts, recording nothing, when the user's settings are not a JSON object; set any `sandbox` key but
those that only narrow it (`filesystem.denyRead`, `filesystem.denyWrite`, `network.deniedDomains`, and
`credentials.files` and `credentials.envVars` entries whose mode is `deny` or `mask`), the scalars the session's own
settings override (`enabled`, `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`,
`enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`, `allowAppleEvents`, `allowNestedUserNamespaces`,
`network.strictAllowlist`, `network.allowAllUnixSockets`, and `network.allowLocalBinding`), and
`network.allowedDomains`, an accepted residual; so `excludedCommands`, `filesystem.allowWrite`, `allowRead`, and
`disabled`, `network.allowUnixSockets`, `allowMachLookup`, `httpProxyPort`, `socksProxyPort`, and `tlsTerminate`,
`ripgrep`, `bwrapPath`, `socatPath`, `ignoreViolations`, which silences the sandbox's reports of what it refused, and any
key added later all halt, and no `projectRun.outsideSandbox` name lifts them; or grant a write, through
`permissions.additionalDirectories` or an `Edit` or `Write` allow rule that starts `//` or `~`, cut at its first glob,
to a folder that holds, is, or lies in the main checkout's `.git`, the state root, a mark folder, or the runs folder.
The clone pushes to origin's URL as the main checkout has it, never its `pushurl`; the sandbox hides `~/.ssh` and
refuses SSH, so an SSH URL halts the start on every platform: `git remote set-url origin
https://<host>/<owner>/<name>.git`, and remove any `url.<base>.insteadOf` rule in the git config that rewrites the
HTTPS URL to SSH, as git applies it to the URL it reports. A clone whose push URL is not that URL, as a `pushInsteadOf` in the user's git
config makes it, halts too. On Linux, `bwrap` and `socat` must be on an absolute folder of PATH. A state folder that
lies in the main checkout starts nothing, since the session may not read the main checkout.

In a folder the host has not trusted, `claude --bg` exits with `Workspace not trusted` and starts nothing; the start
says to trust the project's runs folder, `<state>/runs`, once, by running `claude` there and accepting its trust
question. Trust there covers every attempt's clone, and nothing else of the state folder.

Residual risks, each known and left for a later change:

- WebFetch, Read, Edit, and Write run outside the sandbox. Edit and Write are held by the agent gate hook's write
  allowlist alone, and WebFetch reaches any host the permission rules allow.
- The forge CLI's token in `~/.config/gh` is readable, and reaches every repository the user can. A token scoped to
  the repository, passed in the session's environment, is the follow-up.
- On macOS, `~/Library/Keychains` is unreadable to sandboxed commands; whether gh's token in the keychain and git's
  `osxkeychain` helper still answer through the keychain service is live check 7.
- The host's own git calls in the clone, such as for its status line or its view of changes, run outside the sandbox
  without the plugin's hardened settings. The `commondir` placeholder is there at launch, so the sandbox denies its
  write by path on every platform, and the hook refuses it too; should either fail, the host's own calls would follow a
  `commondir` a session wrote, though every plugin git call refuses that clone.
- A `.claude` link a session's git makes, as by checking out a branch that holds one, is denied by the `**/.claude`
  glob, and the hook refuses a write through it or, while git's index lists it, to the folder it leads to; a link git
  does not list is judged by the path as written alone.
- Each registry `projectRun.registries` lists is a host a sandboxed command can send data to, an accepted channel;
  [Dependency installs](#dependency-installs) names each one's path and the ruling. Hosts an install reaches beyond its registry, such as a
  native module's prebuilt binary, node-gyp's headers, or a toolchain download, stay refused.
- A script the session runs can write any record in `reviews` and `dispatch`, which the sandbox grants for the review
  commands; merge trust that rests on the forge alone closes that for the merge.
- A subagent's handoff file can be overwritten after that subagent stopped.
- For a few seconds between the launch and the session's own mark, only the pending mark holds it.
- No start proves itself beyond the beacon: no per-start proof that the sandbox holds.
- The product quorum parks in a confined session, which starts no other session.
- The agent gate hook refuses a confined session's write to any `SKILL.md` in its clone, and to any glob that may name
  one, such as `docs/*.md`; a session edits such a file with a literal path, and a skill with the Edit tool only where
  the hook allows it.

Before `verified` changes, a live Claude Code must show every one of these, each on a named version:

1. `claude --bg --settings` starts in the clone; the runs folder needs the trust step; `claude agents --json` lists
   the session's `cwd` as the clone.
2. `touch ~/probe` fails, and also with `dangerouslyDisableSandbox`.
3. A script and `npm test` cannot write `~/.zshrc`, `~/.gitconfig`, the main checkout's `.git/config` or hooks, the
   ledger, the marks, or the continuation store.
4. Writes pass in the clone, `git commit`, the drop folder, `plans`, `reviews`, `tmp`, `dispatch`, `TMPDIR`, and
   `/tmp`.
5. Writes fail to the clone's `.git`, its git config and hooks, the `commondir` and `config.worktree` placeholders,
   `.claude/settings*.json`, a skill, `.mcp.json`, and the same under a nested `.claude` folder and a nested
   `SKILL.md`, through the `**` globs, and making a nested `.claude` folder or link; each such path absent at launch,
   on Linux; and git status, commit, fetch, and push work in the clone on both platforms with the `commondir`
   placeholder denied.
6. A `settings.local.json` put in the clone mid-session changes none of 2 to 5.
7. An HTTPS push, `gh api user`, and `gh pr create` work on macOS and on Linux, with `~/Library/Keychains` denied on
   macOS; an unlisted host is refused with no prompt in every permission mode.
8. The same from a subagent, a background Bash command, and Monitor.
9. With no `bwrap`, nothing runs.
10. An invalid `--settings` value: what the host does with it.
11. `claude --bg` or `claude -p` from inside the sandbox starts nothing outside it.
12. The plugin's hooks still run under `--setting-sources user`, with the plugin installed at user scope.
13. A sandboxed process cannot connect to a localhost listener outside the sandbox, on macOS with
    `allowLocalBinding: false`.
14. `cat ~/.ssh/*` and a Read of it fail, and so do `cat ~/.git-credentials`, a read of the main checkout's `.env`,
    and `echo $NPM_TOKEN` with it set in the driver's environment.
15. The session lists no claude.ai connector and no other plugin's MCP server, and only the `projectRun.mcpServers`
    tools.
16. No other plugin's LSP server or monitor runs.
17. A skill with frontmatter hooks written mid-session, at the clone's root and under a nested `.claude` folder, never
    runs: the write is refused, and the host does not load it.
18. With `projectRun.registries` listing `npm`, `npm ci` in the clone installs, its `postinstall` script cannot write
    `~/probe` or reach an unlisted host, `echo $npm_config_cache` names the attempt's `cache` folder, nothing new
    appears in `~/.npm`, and the driver's `wait` removes the attempt's folder once the session ended; with the list
    empty, `npm ci` fails on the network and writes nothing outside the attempt's folder. A hook and an MCP server of
    the session see none of the variables, and the SessionStart hook's lines reach a Bash command under `claude --bg`.
    For a project with no code yet, each with its registry listed and a sweep check after it: `npm create vite@latest`,
    `npx create-next-app`, `pnpm create` and `pnpm dlx` through corepack, `yarn create`, `uv init && uv add`,
    `python -m venv` then `pip install`, `cargo new && cargo add`, and `go mod init && go get`; and `npm ci`,
    `pip install` in a virtual environment, `cargo fetch`, `go mod download`, and `bundle install` in a project that has
    code.

### Dependency installs

A confined session installs the project's dependencies, and a project with no code yet scaffolds its stack, from the
registries the base branch's [`projectRun.registries`](../config.md#project-run) lists, by ecosystem name, never by
host. Each name adds its fixed hosts to `allowedDomains` (`lib/project-registries.mjs`); the list is empty by
default, so a team opts in. Install scripts a package runs, such as npm's `preinstall` and `postinstall`, a Python
build backend, or a cargo `build.rs`, run as the session's commands do: inside the sandbox, writing only the folders
the table above grants and reaching only the listed hosts. That is why letting a session install is acceptable.

Every session, whatever the list holds, keeps its package managers' caches and global stores in its attempt's
`cache` folder; `HOME` stays as it is, so nothing an install writes lands outside the attempt's folder, and the
driver's `wait` removes it with the attempt. The variables reach the session's sandboxed commands alone, never the
host's own process, whose hooks, MCP servers, language servers, and status line run outside the sandbox. The gate
writes them to `shell-env.json` in the attempt's folder, which no confined session writes, before the launch; the
plugin's SessionStart hook, for a session whose own mark names a run and issue whose ledger gives it exactly that
attempt's folder, or whose pending mark starts it in that very clone, appends one `export NAME='value'` line for each
name the gate gives, and no other, single-quoted with each quote escaped, to the
file the host names in `CLAUDE_ENV_FILE`, which it sources before each Bash command. No `env` key is passed in the
settings. On Codex the same variables reach its sandboxed commands through `shell_environment_policy.set`.

| Package manager | Variables, each a folder or file in `cache` |
| --- | --- |
| npm | `npm_config_cache`; `npm_config_userconfig` and `npm_config_globalconfig`, and their upper-case forms, two empty config files the start makes, so npm, pnpm, and yarn 1 never read a token from the user's `~/.npmrc` or npm's global config |
| pnpm | `PNPM_HOME`, whose `store` is the default store of every pnpm since 7; `pnpm_config_store_dir`, `pnpm_config_cache_dir`, and `pnpm_config_state_dir`, which pnpm 10 and later read. `npm_config_store_dir` is left out, since npm warns of a key it does not know on every command |
| yarn | `YARN_CACHE_FOLDER`, and `YARN_GLOBAL_FOLDER`, where yarn 2 and later keep their global cache |
| pip, uv | `PIP_CACHE_DIR`, `UV_CACHE_DIR` |
| cargo | `CARGO_HOME`: its registry cache and installs; the user's `~/.cargo` config no longer loads |
| go | `GOPATH`, `GOMODCACHE`, `GOCACHE`, and `-modcacherw` added to the driver's `GOFLAGS`, so go leaves its module cache writable and the attempt's folder can be removed. A `GOFLAGS` the user set with `go env -w` gives way to this one, so it does not reach a confined session |
| gem, bundler | `GEM_HOME`, where both install, and `BUNDLE_USER_HOME`, bundler's own cache and config; `BUNDLE_PATH` is left unset, so bundler still uses the gems the Ruby already has |
| corepack, with `npm` listed | `COREPACK_HOME`, and `COREPACK_NPM_REGISTRY` set to `https://registry.npmjs.org`, so corepack downloads pnpm and yarn 2 and later from the listed npm registry; neither `nodejs.org` nor `repo.yarnpkg.com` is listed. Without `npm`, corepack's own folder stays readable where it is |

`XDG_CACHE_HOME` stays as it is, so a browser a test tool downloaded before stays readable where it is; a tool that
writes there fails, as before. Each session starts with empty caches, so it downloads every dependency again. Known
limits: pnpm 9 and earlier keep their metadata cache and state outside the attempt, where a write fails; poetry's and
pdm's caches are not moved; `uv python install`, node-gyp's headers, a native module's prebuilt binary, a toolchain
download, and any install script that downloads from a host the list does not hold all fail on the network.

A session no Human attends never publishes, withdraws, or changes a package or its owners: the agent gate hook refuses
`npm`, `pnpm`, `yarn`, and `bun` `publish`, `unpublish`, `dist-tag`, `deprecate`, `owner`, `access`, and `token`
(and `yarn npm publish`, `tag`, and `login`), past options such as `--filter web` or `--loglevel=verbose` and yarn's
`workspace <name>`, with the read forms `owner ls`, `dist-tag ls`, and `access list` and `get` passing; `lerna publish`
and `changeset publish`; `gem push`, `yank`, `owner`, and `signin`, and `rake release`, also through `bundle exec`;
`cargo publish`, `yank`, `owner`, and `login`, also after a `+<toolchain>` word; `twine upload`, also through
`python -m`, `pipx run`, and `uvx`; `uv publish`; and `poetry publish`. Each is found through a package runner too:
`npx`, `bunx`, `npm exec` and `npm x`, `pnpm dlx` and `pnpm exec`, and `yarn dlx`. A script or a raw HTTP call that
does the same passes the hook, as the accepted residual.

The ruling on what each registry opens (security-engineer, 2026-11-18): every listed registry but `pypi` and
`crates` gives a channel a sandboxed command can send data out on that an attacker can read, and each is accepted,
since the forge channel, which a sandboxed command already reaches with the user's forge token, gives one already.
Narrowing the forge token to the repository reopens this ruling. Each one:

- `npm` (`registry.npmjs.org`, `registry.yarnpkg.com`): `npm publish` of the clone's code as a package, with a token
  the session is given, as by text in an issue; the user's own tokens are hidden, and the hook refuses the publish
  commands, so a script is the path left.
- `pypi` (`pypi.org`, `files.pythonhosted.org`): uploads go to `upload.pypi.org`, which is not listed. Downloads of a
  package land in PyPI's public download statistics, a slow channel through the choice of which files to fetch.
- `crates` (`index.crates.io`, `static.crates.io`): publishing goes to `crates.io`, which is not listed; per-version
  download counts are public, the same slow channel.
- `go` (`proxy.golang.org`, `sum.golang.org`): the widest. The proxy fetches any module path it is asked for from the
  host the path names, so a request for `<host>/<data>/@v/list` carries data to any server, through the proxy.
  It stays listable, as an opt-in.
- `rubygems` (`index.rubygems.org`, `rubygems.org`): `gem push` to `rubygems.org`, with a key the session is given;
  `~/.gem/credentials` and `~/.local/share/gem/credentials` are hidden.

## Limits

Claude Code enforces each agent's tool limits.
A read-only agent cannot use `Write`, `Edit`, or `NotebookEdit`: [Merge order](../agent-sources.md#merge-order).
