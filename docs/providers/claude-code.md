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

## Background agents

Claude Code runs every agent dispatch in the background while its fork-subagent mode is on, and that mode is on by
default in an interactive session. The launch is forced asynchronous for any caller but an in-process teammate, whatever
the call's `run_in_background` says. So the Agent hook's rewrite to `run_in_background: false`, which the transcript
records as applied, does not move a subagent's dispatch to the foreground there, and its dispatch row stays
`async_launched`. Only `CLAUDE_CODE_FORK_SUBAGENT=0` in the session's environment turns the mode off, which also removes
the `fork` agent type. A child's `.meta.json` `launchedWithDefaults` says the call named no model, not that it named no flag.

What the [background check](../hooks.md#background-check) guarded against does not happen on this host. A background
agent's report reaches the subagent that started it after that subagent ended its turn: Claude Code starts it again
(`SubagentStart` fires), and the report arrives as a message. The subagent's own dispatcher is told it stopped only once
it stops with no live background child. Each idle-with-children occurrence of 2026-11-14 to 17 whose transcript was kept
shows the wake. The adapter declares it as `capabilities.wakesOnChildReport`, with the `background_tasks` types of an
agent, and the stop hook leaves such a task out of the check. A background shell still counts.

A background shell's end wakes the subagent too: the task notice arrives as a message and starts it again after it
ended its turn. Subagent transcripts of 2.1.316 and later hold 280 such wakes, each right after the turn ended. The
adapter declares it as `capabilities.wakesOnTaskEnd`, and the stop hook lets a handoff file wait for the stop after
such a wake ([delivery check](../hooks.md#delivery-check)). The background check still sends the agent back for a
shell, since one that never ends, such as a dev server, never wakes it.

Checked by reading the transcripts of four such subagents and Claude Code 2.1.328's launch code. Not verified: a
session with the fork-subagent mode turned off.

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

## Session ids

`CLAUDE_CODE_SESSION_ID` in the Bash tool is the session the host gives its hooks. Seen live on 2026-11-18, in a
subagent of a main session: its Bash tool's `CLAUDE_CODE_SESSION_ID` and the `session_id` its hooks recorded in the
dispatch log were both the main session's id, never another one; the live runs under
[Handoff continuation](#handoff-continuation) show it follows a clear and is a background session's own. The
snapshot's [worktree links](adding-a-host.md#session-links) are still written by the PostToolUse Bash hook, under the
payload's `session_id`, since Codex's shell variable is not its hooks' id in a subagent, and one writer serves both hosts.

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
| Whether a hook payload's `cwd` follows a `cd` in the Bash tool, as the Bash tool's own folder does | No hook compares a folder: the session start matches the host process, and every checkout of the project shares one store. The [session ledger](../hooks.md#session-ledger) does not depend on the answer either: it takes a call's folder from an absolute leading `cd`, `git -C`, or `env -C`, and the payload's `cwd` only on a line that changes no directory. |

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
   where the name is that session's, else the brief's slug. A name that ends in ` · <n - 1>` loses that count and
   any before it that count down by one, so a second hop names `widget-work · 2`, not `widget-work · 1 · 2`;
   any other name stays whole, such as `release · 2026`. `<n>` is the continuation's number; the agent is
   `CLAUDE_CODE_AGENT` and the effort `CLAUDE_EFFORT` when each holds a value the adapter accepts, the mode is the
   handing-off session's (below), and the prompt is the continuation. It reads the short id from its
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
  (under `CLAUDE_CONFIG_DIR` when set). It may hold `{"type":"permission-mode","permissionMode":"<mode>","sessionId":"<id>"}`
  entries, and the `user` entry of each prompt carries the mode as a top-level `"permissionMode":"<mode>"` field
  beside `sessionId`; the `user` entries that hold tool results do not. Some transcripts, checked on 2026-11-17, hold
  only the prompt entries' field. `claude --help` lists `acceptEdits`, `auto`,
  `bypassPermissions`, `manual`, `dontAsk`, and `plan` for `--permission-mode`.

So the adapter passes the handing-off session's permission mode with `--permission-mode`, so an unattended chain does
not stop at a prompt the old session would not have shown. It reads the last entry of that session's transcript with
a top-level `permissionMode`, of either shape, in the start folder's project folder, else in any project folder.
It reads backwards from the end in 1 MB chunks until one names the mode, so it finds one however far back it is.
It skips a subagent's sidechain entry and any entry whose `sessionId` is not the session's. A line over 32 MB is not
parsed: one that holds the `"permissionMode"` key reads as no mode, and one without it is skipped. A
`permissionMode` that is not a string reads as no mode either. It passes the mode only
when it is `acceptEdits`, `auto`, `dontAsk`, `manual`, or `plan`; a transcript's `default` is passed as `manual`.
A session that runs in `bypassPermissions` starts nothing, and the handoff goes on by the clear route: a session no
Human attends never runs without permission checks. With no mode it can read, none starts either, since the host's
default may be `bypassPermissions`, and the fallback line says the mode could not be read.
Accepted residual: in a transcript that carries the mode only on prompt entries, a mode changed in the middle of a
turn shows only at the next prompt, so a handoff in that turn passes the mode the turn started in. A background
session of the chain seldom has a Human attached to change its mode, and `bypassPermissions` is never passed.
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

### Replacing the terminal

The adapter's `replaceTerminal` (`lib/hosts/claude-code-terminal.mjs`) lets a session that handed off end itself, so
the terminal that ran it opens the new session ([handoff.md](../handoff.md#replacing-the-terminal)). The shell function
`aidrian shell-init zsh` prints wraps `claude`, opens the next session with `command claude attach <id>`, and gives
`claude` the shell's pid as `AIDRIAN_SHELL_PID`. A session is attended when `CLAUDE_CODE_SESSION_ATTENDED` is `1`.
Its host process is `CLAUDE_PID`, when it is attended and `ps -o pid=,ppid=,comm= -p <pid>` shows a process named
`claude` whose parent is that shell; it reads no process's arguments. It ends that process with SIGTERM.
A launcher wrapped with `--install --wrap <name>` that ends in `exec claude "$@"` passes the same check: `exec` keeps
the launcher's process, so it stays the shell's child, and the program it now runs is `claude`, so `ps` names it
`claude`. One that execs a binary under another file name, or runs `claude` as a child of its own, does not.
Only the first session runs through the launcher, since each later hop opens with `command claude attach <id>` in the
shell's own environment, so a variable or flag the launcher sets before its `exec` does not reach later sessions (not
verified live).

Checked by hand on Claude Code 2.1.326 on 2026-11-17, in a pseudo-terminal, with throwaway sessions in a trusted
folder and a trivial prompt:

- SIGTERM, SIGHUP, and SIGINT each end an interactive session within about 2 seconds, idle and in the middle of a turn.
  Each time the transcript holds the last answer, the terminal is restored, and the session prints
  `Resume this session with: claude --resume <id>`. The session exits 143 on SIGTERM, 129 on SIGHUP, and 0 on SIGINT.
  The adapter sends SIGTERM, the signal whose meaning is to end.
- Each runs the SessionEnd hooks, reason `other`, within the same short time a normal exit gives them: a hook that
  takes 3 seconds is cancelled, with `failed: Hook cancelled`, under all three signals.
- The Bash tool's shell and every hook carry `CLAUDE_PID`, the session's `claude` process, the parent of the Bash tool's
  shell and of a hook's shell. They carry `CLAUDE_CODE_SESSION_ATTENDED=1` in an interactive session and `0` in a
  background one, and a variable the starting shell exported, such as `AIDRIAN_SHELL_PID`.
- The interactive `claude` shows as `claude` in `ps -o comm=`, a child of the program that started it. A background
  session's process shows as `claude bg-spare` under `claude bg-pty-host`, so it never passes the check.

A background session the gate started ends itself with `replaceTerminal.endOwn` (`stopOwnBackground` in
`lib/hosts/claude-code-background.mjs`) once its own handoff started the next one, whether or not a terminal follows it.
It reads `claude agents --json` and runs `claude stop <id>` only when exactly
one background row has that `id`, or a `sessionId` that starts with it, and its `sessionId` is the session's own.
It never signals a process: the supervisor owns the background session's process.

A terminal the Human attached by a name, as `claude attach 'staff-perm · 6'`, follows the session too:
`replaceTerminal.nameMatcher` (`nameMatcher` in `lib/hosts/claude-code-background.mjs`) reads `claude agents --json`
once, every row, with or without a `startedAt`. A typed target opens the session only when it is the session's whole
`name`, case and all; no other row's `name` holds it; and no row's `sessionId` or `id`, the session's own included, is
the target or starts with it. The row whose `sessionId` is the session the handoff just started, and only that row,
is left out of these checks. A part of a name never opens it. A listing that fails, or a row whose `sessionId` or
`name` is not a string, or whose `id` is neither a string nor absent, opens nothing. `claude attach --help` on 2.1.328
gives `claude attach <id|name>` and says part of the session name works in place of the id. Not verified live: which
session the command picks when several names hold the target, or whether it ignores case; the test follows nothing
that could open another session.

Checked by hand on Claude Code 2.1.326, in a pseudo-terminal: `claude attach <id>` on a live background session exits 0
about 1.1 seconds after `claude stop <id>`, so the shell function goes on to the next session.

A client that opened a session from Claude Code's own session list is not followed: the old session still stops, and
the client returned to the list the one time it was seen. `claude attach <id>` typed in the shell is the way that
follows every hop. Checked by hand on Claude Code 2.1.328 on 2026-11-19:

- No command points a running client at another session.
- `claude agents --json`, the job state file, and the daemon roster do not say which client shows which session, so
  the gate cannot find a client the list opened.
- `claude attach <id>` exits 0 within 2 seconds of `claude stop <id>`.

That return to the list was not probed further.

Not verified live: a handoff that ends a session through the Stop hook end to end, or `claude attach` in the shell
function; a handoff through a wrapped launcher, end to end.

## The Claude mod

`aidrian-mod` is an optional mod for Claude Code alone: a band above the prompt, a pane, and notifications, drawn
from `aidrian session snapshot`. It installs beside the plugin, `claude plugin install aidrian-mod@aidrian-harness`.
[Claude mod](../claude-mod.md) has what it shows, its settings, the status line fallback, and its limits.

## Limits

Claude Code enforces each agent's tool limits.
A read-only agent cannot use `Write`, `Edit`, or `NotebookEdit`: [Merge order](../agent-sources.md#merge-order).
