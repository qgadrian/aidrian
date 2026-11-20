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
the absolute folders of PATH alone, so an empty or relative entry never runs a `claude` the folder holds. Before it,
the gate's [push preflight](../handoff.md#the-push-preflight) reads the folder through `startFolder`, and judges that
folder's remote; `startBackground` then starts there from that same listing, and never reads the folder again. When
that listing does not answer or does not list the session's folder, or the folder is not there, the preflight answers
`unknown`, and the gate never judges its own folder in its place; with no folder from `startFolder`, step 1 reads its own:

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

## Push permission in auto mode

The adapter's `capabilities.pushPermission` ([the adapter's fields](adding-a-host.md#the-adapters-fields)),
in `lib/hosts/claude-code-push.mjs`, says whether auto mode would let a session push to the repository's remote.
In the `auto` permission mode a classifier judges each action against `autoMode` in the settings, whose `environment`
lists the trusted repositories as prose, such as `"Trusted repo: github.com/acme/widget and its remotes"`
([auto mode configuration](https://code.claude.com/docs/en/auto-mode-config)). It reads `autoMode` from one file,
`<config folder>/settings.json`, the user settings, where the config folder is `CLAUDE_CONFIG_DIR`, else `.claude` in
the home folder. It also reads `permissions.allow`, `permissions.deny`, and `permissions.ask` from that file and from
the project's `.claude/settings.json` and `.claude/settings.local.json`, since a rule there settles a push before the
classifier runs. It does not emulate how Claude Code matches a rule: a deny or ask rule that may reach a push, or an
allow rule that covers one, only makes the answer `unknown`, and no rule answers `allowed` or `denied`. It writes nothing.
Each step answers `unknown` when it cannot go on:

1. The session's permission mode, from its transcript, as the [background route](#the-background-route) reads it.
   Anything but `auto`, a session with no id, and a transcript it cannot read, a named pipe in its place included,
   answer `unknown`, and no settings file is read.
2. The settings files, each following a symlink, opened without blocking and read as a regular file of at most 1 MB,
   parsed as JSON: the user settings, and the project's `.claude/settings.json` and `.claude/settings.local.json`.
   The adapter reads each file only from the folder Claude Code loads it from
   ([settings files](https://code.claude.com/docs/en/settings), read on 2026-11-20). `.claude/settings.json` is read
   from the session's folder alone, the `cwd` of the ask, the folder the run will work in: Claude Code reads it from the
   session's primary working directory, so a session started below the repository root never loads the root's.
   `.claude/settings.local.json` is read from the root of the git repository, the nearest folder at or above `cwd`
   holding `.git`, or, when that `.git` is a file naming a worktree's git folder, the main checkout its `commondir`
   names; and from `cwd` too, where Claude Code before 2.1.211 kept it and still reads it, and where it stays outside a
   repository. A file that is there and is not a regular file, such as a named pipe, is too large, holds bad
   JSON, or is not an object cannot be read; a project file that is not there holds no rule, and a `cwd` that is not
   absolute reads no project file.
3. `unknown` when any of those files holds a `permissions.deny` or `permissions.ask` rule that may reach a push, or a
   `permissions.allow` rule that covers one: `Bash(git push)`, `Bash(git push:*)`, `Bash(git push *)`, or
   `Bash(git push origin` with any rest after a word boundary, `origin` being the remote the push preflight reads, so
   `Bash(git pushall)` does not. On entering auto mode Claude Code drops broad allow rules, such as `Bash(*)`
   ([permission modes](https://code.claude.com/docs/en/permission-modes), read on 2026-11-20), so a whole-tool allow,
   such as `Bash`, `Bash(*)`, `*`, or `B*`, leaves the verdict to the next steps; so does `Bash(git:*)` or
   `Bash(git *)`, which that page does not name, so a session it would let push may be told `denied`.
   Each rule is read in lower case, with its spaces run together. A deny or ask rule may reach a push when it mentions
   `git push`, such as `Bash(git push:*)`, `Bash(git push origin main)`, or `Bash(git pushall)`; or when its tool is the
   shell tool, `Bash` or a tool-name glob that matches it, such as `B*` or `*`, with no pattern, an empty one, or one
   whose text before its first `*`, less a final `:`, starts `git push`, such as `Bash(*)`, `Bash(git:*)`,
   `Bash(git *)`, or `Bash(g*)`. `Bash(git status)`, `Bash(npm run *)`, `Read(**)`, and `mcp__github__push_files` do
   not. This comes first, before auto mode's trust, so `"$defaults"` or an entry that names the remote answers
   `unknown` beside such a rule too. Any file that cannot be read as in step 2, or whose `permissions` is not an object,
   or whose `permissions.allow`, `permissions.deny`, or `permissions.ask` is not a list of strings, answers `unknown`,
   and so does a `cwd` that is not absolute, whose project files cannot be found.
4. The user settings cannot be read as in step 2, or `autoMode` is absent or not an object: `unknown`.
5. `autoMode.environment` absent, not a list, empty, or holding a non-string: `unknown`.
   `autoMode.allow`, when present, not a list of strings: `unknown`.
6. `allowed` when `environment` holds `"$defaults"`, or an `environment` entry names the repository, or an `allow`
   entry names the repository and holds the word `push`, in any case, as in `pushes` or `git push`.
7. `unknown` when an `environment` entry is not one the matchers understand. An entry is understood when it names
   exactly one source-control name and nothing else that could cover this remote. A source-control name is a host of
   labels of letters, digits, and `-` joined by dots, the last of two or more letters, with no letter, digit, `_`, `.`,
   `-`, `/`, `@`, or `:` before it, and an optional scheme, user, port, and path, such as `git.example.com`,
   `https://git.example.com/acme/widget`, or `git@git.example.com:acme`. A bare host whose last label is a file
   extension reads as a file and names nothing, unless it is the remote's own host: `md`, `markdown`, `rst`, `txt`, `js`,
   `mjs`, `cjs`, `jsx`, `ts`, `mts`, `cts`, `tsx`, `json`, `jsonl`, `yml`, `yaml`, `toml`, `ini`, `lock`, `sh`, `bash`,
   `zsh`, `py`, `rb`, `go`, `rs`, `java`, `kt`, `swift`, `c`, `h`, `cpp`, `css`, `html`, `xml`, `csv`, `log`, `env`,
   `cfg`, and `conf` (`FILE_EXTENSIONS` in `lib/hosts/claude-code-push.mjs`); with a path after it, such as
   `tools.example.sh/acme`, it is a host. An entry that names no such name, such as `"We build with Node.js"`,
   `"See README.md"`, `"All repositories of our organisation"`, or `"Trusted repo: acme/other"`, names several, such as
   `"gitlab.example.com and bitbucket.org"`, or holds, outside its one name, the word for the remote's host, its label
   before the last, such as `github` for `github.com` in `"our GitHub org, and gitlab.example.com"`, may trust the remote
   in words no matcher reads, so a denial never stands beside it.
8. Otherwise `denied`: `autoMode.environment` in that file replaces the default trusted repositories, with no
   `"$defaults"` in its list, and names this remote in no entry, though each entry names one other source-control host
   or path, such as `"Source control: github.example.com/other-org and all repos under it"`, and no file holds a rule
   that may reach a push. The fix it gives adds `"$defaults"` to that list, or an entry such as
   `"Trusted repo: github.com/acme/widget"`.

An entry names the repository `github.com/acme/widget`, compared in lower case, when it holds any of:

- `acme/widget`, the path after the host, with no letter, digit, `_`, `.`, or `-` before it, and no letter, digit,
  `_`, or `-` after it: `acme/widget.git` and `github.com/acme/widget)` name it, and `acme/widget-site` does not.
- `github.com/acme`, the host and the owner, for the whole organisation, with no letter, digit, `_`, `.`, or `-`
  before it, and after it no letter, digit, `_`, or `-`, no `.` followed by one of those, and no `/` followed by one of
  those or a `.`: `github.com/acme and all repos under it`, `github.com/acme.` at the end of a sentence, and
  `github.com/acme/*` name it, and `github.com/acme/other`, `github.com/acme/.github`, and `github.com/acme.io` do not.
  The scp-style `github.com:acme` names it the same way.
- `github.com`, the host alone, for every repository there, as in `"Trusted source control: git.example.com"` for a
  remote on `git.example.com`, with no letter, digit, `_`, `.`, or `-` before it, and after it, past a port such as
  `:443`, no letter, digit, `_`, or `-`, no `.` followed by one of those, and no `/` or `:` followed by one of those or
  a `.`, which would narrow it to some owner: `github.com`, `GitHub.com.` at the end of a sentence,
  `https://github.com`, and `github.com/*` name it, and `enterprise.github.com`, `github.com.example.io`,
  `github.com/other`, and `git@github.com:other/repo` do not.

Read on 2026-11-19 from the [auto mode configuration](https://code.claude.com/docs/en/auto-mode-config),
[settings](https://code.claude.com/docs/en/settings), [permissions](https://code.claude.com/docs/en/permissions), and
[permission modes](https://code.claude.com/docs/en/permission-modes) references, with Claude Code 2.1.328 installed.
The fixtures' shape of `autoMode` was compared by hand with one user settings file; that comparison is no
verification. Four assumptions follow from the references:

- `autoMode` is read from the user settings file alone. The classifier ignores `autoMode` in `.claude/settings.json`
  and `.claude/settings.local.json`, so a checked-in file cannot add its own rules, and counting them would count
  entries the host ignores.
- A permission rule that matches a command settles it before the classifier runs, in every settings file the
  permission system reads: an allow rule approves it, a deny rule refuses it, and an ask rule asks, which a session no
  Human attends cannot answer. How a rule matches a command is the host's to decide, so a rule that may reach a push
  leaves no answer to predict, and none is given.
- `denied` from `autoMode.environment` is a prediction of what a prose classifier will do. A custom `environment` with no `"$defaults"` that names
  this repository in no entry is the shape of a run whose push was refused, and the only shape that answers `denied`.
- `soft_deny` and `hard_deny` are never read: no pattern over prose says whether one forbids a push.

Limits: managed settings and a `--settings` value can add `autoMode` entries the user file does not show, and an entry
that names one other host and trusts the remote in prose under another word, such as `"Microsoft's forge, and
gitlab.example.com"`, reads as naming that host only; either can answer `denied` where the classifier would allow the
push, and the fix still works. The other way round, some
entries that name another repository answer `allowed`: one on another host whose path is the same, such as
`gitlab.example.com/acme/widget`, a name that goes on past a `.`, such as `acme/widget.site`, and an `allow` entry
phrased as a refusal, such as `Never push to github.com/acme/widget`; the run then starts as it would without the
check. A permission rule that reaches a push some other way, such as a rule for a script that pushes or
`Bash(git -C <dir> push:*)`, reads as no push rule, and a rule in managed settings or a `--settings` value is not
read; either can answer `denied` where the push would go through. A deny or ask rule that refuses the push answers
`unknown`, not `denied`: the run starts, as it did before the check, and stops at its push. A relative `CLAUDE_CONFIG_DIR`
answers `unknown`. Every shape of `autoMode` the adapter does not know answers `unknown`.

Verified on Claude Code by `node --test` on fixtures (`test/adapters.test.mjs`); not live: no denial of a real
classifier has been held against the answer. `claude auto-mode config` shows the rules the host applies, as a check by hand.

## The Claude mod

`aidrian-mod` is an optional mod for Claude Code alone: a band above the prompt, a pane, and notifications, drawn
from `aidrian session snapshot`. It installs beside the plugin, `claude plugin install aidrian-mod@aidrian-harness`.
[Claude mod](../claude-mod.md) has what it shows, its settings, the status line fallback, and its limits.

## Limits

Claude Code enforces each agent's tool limits.
A read-only agent cannot use `Write`, `Edit`, or `NotebookEdit`: [Merge order](../agent-sources.md#merge-order).
