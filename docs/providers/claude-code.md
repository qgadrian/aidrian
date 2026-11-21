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

## Answers the Human gave

The adapter's `humanAnswer` says whether an AskUserQuestion result entry of the transcript is the Human's own answer in
the terminal: `isSidechain` false (not merely absent), not a meta entry or a compaction summary, `entrypoint` `cli`, and
`permissionDecision.source` `user_temporary`. Read from local transcripts on 2026-11-19 and 2026-11-20: every answer on
Claude Code 2.1.295 to 2.1.328 from the terminal carries all three, the desktop app writes `entrypoint`
`claude-desktop`, and before 2.1.295 no entry carries the permission decision. No host document states the shape, so a
shape the adapter does not know never counts. Whether an SDK callback or a hook that answers the question writes other
marks is not verified: its entry counts only if it carries all three. The
[round limit delegation rule](../hooks.md#bash-rules) reads it.

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
`unknown`, and the gate never judges its own folder in its place; with no folder from `startFolder`, step 1 reads its own.
In a folder that is not there, `claude` cannot run (`ENOENT`), so nothing starts, the gate removes its pending mark, and
the handoff goes on by the clear route:

1. `claude agents --json`, for the handing-off session's `name` and `cwd`, by its `sessionId`. That folder, where the
   host already runs a session, is where the new one starts, never the brief's worktree; a session the listing does
   not place starts nothing. The adapter then calls the gate's `hold` with that folder and the `sessionId` of every
   listed session, which files the pending mark that holds every other session until the new one's id is listed;
   when that fails, nothing starts.
2. `claude --bg --name '<name> · <n>' [--agent <agent>] [--effort <effort>] [--permission-mode <mode>] -- <prompt>` there,
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

## Project start

`aidrian project start` starts an issue's session on Claude Code confined, as on [Codex](codex.md#project-start), but
no live Claude Code has run it this way: the host declares it `verified: 'unverified'`, and a run starts it only where
the default branch, on the forge and by its local ref, sets [`projectRun.unverifiedHosts`](../config.md#project-run).
Every start then prints an `unverified:` line. The sandbox's key names come from the host's settings reference and
sandboxing page, read on 2026-11-18; a value the host does not validate in a session no Human attends is silently
ignored, so the live checks below must show each one holds.
How issue sessions and the driver relate to the cap of five background continuations in a row is
[A project run](../handoff.md#a-project-run). Every one-time step the Human takes before a run, each a section that an
`aidrian project preflight` blocker line points at, is in [Project run setup](../project-run-setup.md).

- Each attempt works in a fresh clone, never a linked worktree: in a linked worktree, the host's sandbox lets a
  session write the main repository's whole shared `.git` but its `hooks/` and `config`.
  `<state>/runs/<run>/attempts/<issue>.<attempt>/` holds `work/`, the clone, `git/`, its own git folder, which borrows
  the main checkout's objects read-only, `drop/`, where the session hands its result over, and `cache/`, empty and
  owner-only, where its package managers keep their caches, as on Codex. A first
  attempt cuts the issue's branch from the base tip, and is refused when the forge has that branch already. A clone
  that could not be made, or is refused so, leaves no attempt folder.
- The session starts with `claude --bg --name '<run> · <issue> · <attempt>' --permission-mode <the driver's>
  --setting-sources user --settings '<sandbox JSON>' --strict-mcp-config --mcp-config '<servers JSON>' -- <prompt>`, in the
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
- The beacon proves only that the hooks run. Before the start holds the session, the session proves from inside its
  sandbox that the sandbox is in force ([The sandbox proof](#the-sandbox-proof)): its first call must be `aidrian
  project confine <run> <issue>`, and nothing else runs until the start confirmed it.
- An issue's session starts no continuation: `aidrian handoff continue` from it prints `continue: none`, and
  `aidrian handoff route` `route: none`, before any floor, mark, or start record. It pushes its work and records its result.
- A usage or rate limit is read from the session's transcript alone (`lib/hosts/claude-code-limit.mjs`): its last
  `assistant` entry, only when the host marked it `isApiErrorMessage: true`. Its structured `error` decides where the
  host writes one, and only `rate_limit` is a limit; with none, its text must start with a limit's words, as
  `Claude AI usage limit reached|<epoch seconds>`, `5-hour limit reached ∙ resets 5pm`, or `API Error: 429`. The reset
  time is read against the entry's `timestamp`: from the epoch, from `resets <time> (<zone>)`, then from `resets in`
  a span. The session starts with `autoContinueAtUsageLimit`, so the host waits out a usage limit and continues it,
  and the adapter declares `continuesAtLimit`: `wait` keeps a session the host still lists running only for a `usage`
  limit, and only while its pause runs, with 5 minutes' grace past the later of the pause's end and the newest entry
  of the transcript after the limit record, such as the host's own entry when it continues the session, and never more
  than 30 minutes past the pause's end. Only an entry that carries the session's id and a time no later than the read
  counts. The host continues only a claude.ai usage limit, on
  billing that is not usage-based; anything else takes the stop path: a rate limit, a pause over with the same record
  still the session's last, and a limit past the run's 24 pauses each stop the session and end its attempt. These
  shapes and the setting's effect come from the host's issue reports, changelog, and binary, not a live run (live check
  19): until one shows them, a limit the reader misses ends the session with no result, or past `issueHours`
  ([Project run](../config.md#project-run)).

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
| `sandbox.filesystem.denyWrite` | the clone's `.git` pointer, its git folder's `config`, `hooks`, `commondir`, and `config.worktree`, on every platform, each a placeholder there at launch; each protected host file of the clone: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/hooks`, `.claude/workflows`, `.claude/scheduled_tasks.json`, and `.mcp.json`; and, as `**` globs, any `.claude` folder itself at any depth, so none is made or made a link, those of each, its `settings*.json`, and any `SKILL.md`; the [sign-off store](../review.md#merge-trust)'s folders, `$XDG_STATE_HOME/aidrian/signoffs` and `~/.local/state/aidrian/signoffs`, the gate's `guarded`, by their real paths, the first made owner-only before the start, so no user `allowWrite` opens them; `permissions.deny` adds an `Edit` rule for each, for the file tools, which run outside the sandbox; and the keep file `.keep-attempt` of the attempt's `drop` and `cache` folders, there at launch, so neither can be emptied and removed, and a link put in its place |
| `sandbox.filesystem.denyRead` | the user's credential stores, below, and the main checkout, whose git-ignored files, such as env files, a session never reads |
| `sandbox.filesystem.allowRead` | the main checkout's git folder, when it lies in the main checkout: the clone borrows its objects |
| `sandbox.network` | `strictAllowlist: true`, `allowedDomains` the forge's hosts (`github.com` and its API host for GitHub) and the hosts of each registry the base branch's [`projectRun.registries`](../config.md#project-run) lists, none by default, `allowAllUnixSockets: false`, `allowLocalBinding: false`, or `true` where the base branch sets [`projectRun.localBinding`](../config.md#project-run); no `allowUnixSockets` |
| `sandbox.credentials.envVars` | `{ name, mode: "deny" }`, so the variable is unset before each sandboxed command, for each variable of the driver's environment whose name says it holds a credential (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH`, and the like) and the well-known ones, such as `AWS_SECRET_ACCESS_KEY`, `NPM_TOKEN`, and `SSH_AUTH_SOCK`, but the forge CLI's own token variables (`GH_TOKEN`, `GITHUB_TOKEN`, and their Enterprise forms) |
| `permissions.deny` | `Read(//<path>)` and `Read(//<path>/**)` for each credential store and the main checkout, since the file tools run outside the sandbox |
| `disableClaudeAiConnectors` | `true`: the claude.ai connectors, which `--strict-mcp-config` leaves on, neither load nor connect; a `true` from any source wins |
| `worktree.bgIsolation` | `"none"`, so `claude --bg` stays in the clone instead of moving into `.claude/worktrees` |
| `autoContinueAtUsageLimit` | `true`: at a usage limit the host waits for the reset and continues the session, keeping its unpushed work, where its limit dialog would wait on a person |

`allowLocalBinding: false` has a cost on macOS, where it is the switch for localhost: a test that listens on a local
port, or connects to one, fails in a confined session. On Linux it has no effect, and the network namespace keeps a
sandboxed command off the host's localhost. An issue whose checks need a database, an API server, a worker, or a
browser on localhost cannot run them so; a team whose issues need them sets
[`projectRun.localBinding`](../config.md#project-run) on the default branch, which the forge and the local ref must
both set, and the session starts with `allowLocalBinding: true`. No clone or local file turns it on. On macOS that
opens binding, and inbound connections, on every interface of this machine, not only the loopback (the host's sandbox
runtime, `src/sandbox/macos-sandbox-utils.ts`), so a project binds each test server to `127.0.0.1`, never `0.0.0.0`.
On Linux it changes nothing, as above.

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
  `~/.claude/.credentials.json`, `~/.claude/ide`, and its `~/.claude/session-env` tree, which holds every session's
  `CLAUDE_ENV_FILE` (and those of `CLAUDE_CONFIG_DIR` when it moves them), the
  keyrings in `~/.local/share/keyrings`, and the shell histories `~/.bash_history`, `~/.zsh_history`, and
  `~/.local/share/fish`; and the package registries' other token stores: `~/.yarnrc.yml`, `~/.yarnrc`,
  `~/.config/npm/npmrc`, the npm user and global config files the driver's `npm_config_userconfig` and
  `npm_config_globalconfig` name, in either case, npm's global config `<prefix>/etc/npmrc` for the prefix the driver's
  environment names and the one the `npm` on PATH lies under, `~/.bunfig.toml`, `~/.local/share/gem/credentials`, `~/.bundle/config`,
  pnpm's `~/.config/pnpm/rc` and `~/Library/Preferences/pnpm/rc`, pip's `pip.conf` in `~/.config/pip`, `~/.pip`, and
  `~/Library/Application Support/pip`, poetry's `auth.toml` in `~/.config/pypoetry` and
  `~/Library/Application Support/pypoetry`, and `~/.local/share/uv/credentials`. Credential-named environment variables are unset in the sandbox, as the table says, and the
  main checkout is unreadable but its git folder. The forge CLI's login, `~/.config/gh`, and its token variables stay:
  the session pushes and opens pull requests through them. Since the sandbox also hides the system keyring, where gh
  keeps its token by default, the session gets the forge token as `GH_TOKEN` (`GH_ENTERPRISE_TOKEN` for a GitHub
  Enterprise Server host, as gh reads it) in its sandboxed commands' environment:
  the start reads it outside the sandbox, from the first of the project's keychain entry
  ([`projectRun.forgeTokenKeychain`](../config.md#project-run) in `.aidrian.local.json`), the machine's default entry,
  service `aidrian-project-run`, both on macOS, the default entry for a github.com run alone, so no github.com token
  reaches another host, and `gh auth token --hostname <host>`. It halts when none gives one, when the token belongs
  to another account than gh's own login, `gh api user` asked with the token (the preflight checks the forge's rules
  for that login alone), or when that very token may not push, whatever the driver's own login may do: the start asks GitHub for the
  repository's receive-pack advertisement, `https://<host>/<owner>/<name>.git/info/refs?service=git-receive-pack`,
  with the token as basic auth, from a Node process with no shell that gets the token in its environment. GitHub
  answers 200 with `application/x-git-receive-pack-advertisement` only to a token that may write the contents, and
  401 or 403 otherwise; a 200 of any other content type counts as not writable. The probe writes nothing. The
  start records which source gave the token and the token's SHA-256, with the digest of a random claim it passes the
  session it launches as the one `env` key of its inline settings, `AIDRIAN_START_CLAIM`. The plugin's SessionStart
  hook of the confined session hands the token over only when its environment holds that claim, so no other session
  opened in the clone gets it, before the host names the launched one or after; it reads the token again, outside the
  sandbox, from that one source, never another, hands it over only when its SHA-256 is the one the start recorded, and
  appends it, in a file it first makes owner-only, to the file `CLAUDE_ENV_FILE` names, as it does the cache
  variables. With it go git's command-scope config entries, after any `GIT_CONFIG_COUNT` the environment already
  holds, both scoped to the forge's host as `credential.https://<host>.helper`: an empty one, which drops every helper
  git collected for that host from the user's and the repository's config, then gh's own `auth git-credential`, by the
  absolute path of the gh on PATH, so git's push takes the token whatever helpers the config names. Another host keeps
  the user's own helpers, so gh never offers the run's token there (checked live: `git credential fill` gave the gh
  token for github.com and no credential for an unrelated host). A source that gives no token then, or another one, or a session without the claim, gets a line saying
  why instead, and no token. The hook of the session that holds the claim, and only it, records in the attempt's
  folder whether it handed the token over, and why not, nothing secret, and the start's check of the sandbox proof fails a start whose record is missing or says not
  handed, so the run halts as on a failed proof. The host reads that file in its own
  process and runs its lines ahead of each Bash command (2.1.330: "Session environment loaded from CLAUDE_ENV_FILE"),
  so the sandbox hides the whole `session-env` tree and each session still gets its own variables, while no session
  reads another's. The token reaches the sandboxed Bash commands alone, never the host's hooks or MCP servers, and no
  file of the run, argv, or printed line carries it.
  Variables of the shell that runs `claude --bg` never reach the session, so the driver's own `GH_TOKEN` is no channel.
  `gh auth git-credential`, the helper `gh auth setup-git` writes, answers git with `GH_TOKEN` (checked on gh 2.105.0),
  so git's HTTPS push signs in with it too. `sandbox.excludedCommands` for gh or git is no channel either: git runs
  hooks the session can write. Git's `store` credential helper keeps the push token in
  `~/.git-credentials`, which the sandbox hides, so a main checkout whose git config names it halts the start: use the
  forge CLI's helper, `gh auth setup-git`, which leaves a `store` entry in place, and remove that entry from the file
  that defines it ([Origin over HTTPS](../project-run-setup.md#origin-over-https)).

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
config makes it, or that pushes to more than one URL (`git remote get-url --push --all origin`), as a second
`remote.origin.pushurl` there makes it, halts too. On Linux, `bwrap` and `socat` must be on an absolute folder of PATH. A state folder that
lies in the main checkout starts nothing, since the session may not read the main checkout.

In a folder the host has not trusted, `claude --bg` exits with `Workspace not trusted` and starts nothing. The Human
trusts the project's runs folder, `<state>/runs`, once: `mkdir -p` it when the run's init has not made it yet, then run
`claude` there and accept its trust question. Inside a git repository the host looks trust up at the repository's own
root alone (2.1.330, checked live), so an attempt's clone, a repository of its own, never inherits that trust: each
start records the host's trust for its own clone in the host's trust record, `.claude.json` in `CLAUDE_CONFIG_DIR` or
the home folder, and only when that record trusts the runs folder itself or a folder above it at that moment, as
preflight checks it: an entry for one run's folder below it, or one an earlier start left for the same clone path,
never stands in for that consent. Nothing else of the state folder is trusted. The consent and the update come from one
read of the record; the new record is staged in `.claude-trust-stage` beside it, a sandbox read barrier as the record
is and never a link, under a lock file there that keeps two starts from undoing each other's update, and renamed
over it only when the file still holds what was read. The lock holds its start's process id, only its holder removes
it, and it is never taken over: a lock a start left when it ended is named for the Human to remove. A clone the record
trusts already needs neither the stage nor the lock. The stage and the record lie in the user's own config folder,
which no confined session may write, so only a process outside the sandbox could swap the stage for a link between
its check and the write, and such a process can read the record itself. That narrows, but cannot close,
the race with a host session that saves the record in the instant between that check and the rename, since the host
takes no lock a writer outside it could share: such a save can lose the new entry, so that start refuses with
`Workspace not trusted` and the same trust step, or be lost itself. A session started by an earlier plugin version,
whose settings predate the staging folder's read barrier, could read the staged copy while it exists. `aidrian project preflight` reads the record
and blocks a runs folder that neither it nor a folder above it trusts; a record it cannot read is only a note, since
the file is the host's own and undocumented.

Residual risks, each known and accepted:

- WebFetch, Read, Edit, and Write run outside the sandbox. Edit and Write are held by the agent gate hook's write
  allowlist alone, and WebFetch reaches any host the permission rules allow.
- The session holds the forge token in its sandboxed commands' environment, as before it held gh's: any command it runs
  can read it, and a token of gh's own login, or a classic one, reaches every repository and scope the user can, which
  the preflight's `note token:` line names. A fine-grained token in the keychain, limited to the run's repository,
  narrows that. The host keeps the file `CLAUDE_ENV_FILE` names, which then holds the token, owner-only, in its own
  config folder, which the sandbox hides, for the session's life; whether it removes it when the session ends is not
  checked.
- The forge CLI's token in `~/.config/gh`, when gh keeps it there, is readable, and reaches every repository the user can. In the run's repository,
  the default branch's protection and the tag rule that `aidrian project preflight` requires hold it; in the user's
  other repositories, nothing does.
- On macOS, `~/Library/Keychains` is unreadable to sandboxed commands, and a live run on 0.80.1 showed gh's keychain
  login does not answer there, which is why the session gets `GH_TOKEN`; whether git's `osxkeychain` helper, when the
  git config names it before gh's, fails at once there and lets gh's helper sign the push in is part of live check 7.
- The host's own git calls in the clone, such as for its status line or its view of changes, run outside the sandbox
  without the plugin's hardened settings. The `commondir` placeholder is there at launch, so the sandbox denies its
  write by path on every platform, and the hook refuses it too; should either fail, the host's own calls would follow a
  `commondir` a session wrote, though every plugin git call refuses that clone.
- A `.claude` link a session's git makes, as by checking out a branch that holds one, is denied by the `**/.claude`
  glob, and the hook refuses a write through it or, while git's index lists it, to the folder it leads to; a link git
  does not list is judged by the path as written alone.
- With [`projectRun.localBinding`](../config.md#project-run) set, on macOS, where `allowLocalBinding` is the switch
  for local networking: a service an issue session starts, such as a database or an API server for its tests, may
  listen on any interface of this machine, where any other local process of any user, and any other machine the
  firewall lets through when it binds `0.0.0.0`, can reach it; and the session's sandboxed commands reach every service
  listening on this machine's loopback, such as the user's own databases, development servers, and any local admin
  port, outside the network allowlist. The sandbox proof runs no localhost listener then, so on macOS with the key on
  it does not check the loopback at all. On Linux the network namespace holds as without it, and the proof keeps its
  listener.
  Bind each test server to `127.0.0.1`; a team sets the key only on a machine where the rest is acceptable.
- Each registry `projectRun.registries` lists is a host a sandboxed command can send data to, an accepted channel;
  [Dependency installs](#dependency-installs) names each one's path and the ruling. Hosts an install reaches beyond its registry, such as a
  native module's prebuilt binary, node-gyp's headers, or a toolchain download, stay refused.
- A script the session runs can write any record in `reviews` and `dispatch`, which the sandbox grants for the review
  commands; merge trust that rests on the forge alone closes that for the merge.
- A subagent's handoff file can be overwritten after that subagent stopped.
- For a few seconds between the launch and the session's own mark, only the pending mark holds it.
- On Linux the host masks a path it denies with an empty mount, so a read probe opens and sees nothing; the proof
  judges a read by the target's fingerprint the start took outside the sandbox, never by whether it opened.
- The sandbox proof runs once, at the start: a sandbox that weakens later in the session is not caught. Its network
  probes count a host that gives no answer within 3 seconds as refused, so on a machine with no network they prove
  nothing of the network; its write and read probes still do.
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
   placeholder denied. The denial of `commondir` stays whatever this shows: should git die on the host's own empty
   placeholder for a denied absent file on Linux, the start's placeholder, which names the git folder itself, is
   there before the launch, checked to hold exactly that and to have a single link. The denial goes only when the
   trace of live check 21 shows the host makes no git call mid-session.
6. A `settings.local.json` put in the clone mid-session changes none of 2 to 5.
7. An HTTPS push, `gh api user`, and `gh pr create` work on macOS and on Linux, with `~/Library/Keychains` denied on
   macOS, through the `GH_TOKEN` the SessionStart hook hands the sandboxed commands; the hook's environment holds the
   `AIDRIAN_START_CLAIM` of the inline settings; the hook's `security` and `gh auth token` reads answer in a
   background session within its 5 seconds, with no keychain prompt; an unlisted
   host is refused with no prompt in every permission mode. A live run on 0.80.1 showed gh's keychain login does not
   answer inside the sandbox, so `~/Library/Keychains` stays denied and the token goes through the forge CLI's token
   variable, which `secretVars` keeps. Verified live: the start's push probe (`receivePackStatus`), run with a project's
   dedicated keychain token, answered 200 for the repository that token may write and 403 for another repository.
   Verified live too: with the hook's command-scope helper entries, `git credential fill` for github.com answered with
   `GH_TOKEN`'s value though the user's config named `osxkeychain`, which alone did not.
8. The same from a subagent, a background Bash command, and Monitor.
9. With no `bwrap`, nothing runs.
10. An invalid `--settings` value: what the host does with it. And each key the start passes that no earlier check
    covers is accepted, on a named host version, on macOS and on Linux: `denyWrite` entries with `**` globs,
    `filesystem.allowRead`, `credentials.envVars` entries as `{ name, mode }` objects, the top-level
    `disableClaudeAiConnectors`, `allowAppleEvents`, and `allowNestedUserNamespaces`. The sandbox proof halts a start
    whose settings the host dropped whole; this check shows which single key it would drop.
11. `claude --bg` or `claude -p` from inside the sandbox starts nothing outside it.
12. The plugin's hooks still run under `--setting-sources user`, with the plugin installed at user scope.
13. A sandboxed process cannot connect to a localhost listener outside the sandbox, on macOS with
    `allowLocalBinding: false`; with `projectRun.localBinding` set, a sandboxed command can listen on a local port and
    connect to it, on macOS and on Linux, a server it binds to `0.0.0.0` on macOS takes a connection from another
    machine only where the firewall allows it, and on Linux it still cannot reach a listener outside the sandbox.
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
19. What a usage limit and a rate limit leave at the end of a background session's transcript, and which state
    `claude agents --json --all` then lists the session in, so `lib/hosts/claude-code-limit.mjs` reads the real record;
    and whether a `claude --bg` session started with `autoContinueAtUsageLimit` in `--settings` continues on its own
    once the limit resets: the host's code reads the key, and may honor it only from the user's own settings.
20. The sandbox proof in a live session, on macOS and on Linux: `aidrian project confine` runs as the session's first
    call and every probe is refused; the Bash tool's environment names the session in `CLAUDE_CODE_SESSION_ID`, as
    the verdict's session; the sandbox's proxy variables, when set, name an HTTP proxy that refuses the unlisted host;
    the localhost listener sees no connection; the cache variables are in force in the shell and absent from the hook's
    own environment; a line the SessionStart hook appends to `CLAUDE_ENV_FILE` runs inside the sandbox only, as a
    probe line whose write outside the sandbox does not land; on Linux, the read probes of a masked folder and file see
    nothing of the fingerprints; and the session's next call runs once the start confirmed the proof. With the
    sandbox turned off by a user setting the start does not check, the proof fails and the run halts. Once the Bash
    tool's environment is shown to name the session, the verdict's session becomes mandatory. A background Bash
    command and Monitor run under the same sandbox (live check 8).
21. A trace of the host's own git calls in a background session after its launch, on both platforms, as with a
    `git` wrapper first on PATH that logs each call. Should any run mid-session, they are hardened through the inline
    settings' `env` (`GIT_CONFIG_COUNT` with `core.fsmonitor=false`, `submodule.recurse=false`,
    `diff.ignoreSubmodules=dirty`, and `protocol.ext.allow=never`, never `core.hooksPath`), and `denyWrite` gains the
    config and hooks of every nested `.git` folder by pattern. Until the trace, neither is passed: the settings'
    `env` reaches the hooks and MCP servers too.
22. Managed settings: a `managed-settings.json` and a `managed-settings.d/` file with `sandbox.allowUnsandboxedCommands:
    true` halt the start on macOS and on Linux; a macOS configuration profile in the `com.anthropic.claudecode` domain
    does too; and whether server-managed settings, which the start does not read, leave a local cache a later check
    could read.
23. Claude Code's file tools expand a leading `~` and `~/` to the home folder of the user the host runs as, as the
    adapter's `filePath` does for every guard of a file tool; and a Glob pattern's `..` reaches above its path. A `..`
    past the pattern's first glob character is bounded by no folder, so the adapter reads it as the file system's root.

### The sandbox proof

A beacon proves only that the plugin's hooks run, and the host ignores a sandbox setting it does not validate in a
session no Human attends. So each start proves, from inside the session, that its sandbox holds, before it holds the
session (`lib/project-confine.mjs`); the adapter declares it with `confineProof: true`. Codex starts no such proof:
its start stays as [its page](codex.md#project-start) says.

1. Before the launch, the start writes `confine-plan.json` in the attempt's folder, which no confined session writes,
   and runs a localhost listener outside the sandbox, a `node` process that notes each connection in that folder.
   The plan names every probe, the listener's port and process, a host outside every allowed domain (the session's,
   and those the user's and the organization's `sandbox.network.allowedDomains` add) and every registry's host, a
   nonce that names each probe path, and the stores the sandbox hides. What each read target holds, its fingerprint,
   stays in the start's memory: for a folder, one entry the sandbox does not open again (for the main checkout, any
   but its git folder); for a file, its first bytes. An empty target is not probed.
2. The session's prompt makes `aidrian project confine <run> <issue>` its first call. Until the start confirms the
   proof, the agent gate hook refuses that session every call but that exact command, alone, on one line, in Bash,
   and only while no verdict is there: while its mark says the proof is owed, and, with no readable mark of its own,
   whenever its call runs in an attempt's clone with a plan, whichever pending mark it reads
   ([hooks](../hooks.md#agent-gates)). The hook also refuses the confine command, and fails the proof, when its own
   environment, which is the host process's, holds a cache variable of the session: those reach the session's
   sandboxed commands alone. Before and after the proof, the hook refuses a Read, Grep, Glob, or LS that reaches a store
   the plan lists as hidden, a folder that holds one included, since the file tools run outside the sandbox.
3. `aidrian project confine` runs once a start, under a lock in the drop folder, in the session's sandboxed shell, and
   tries: to make a file in each unattended mark folder, in the attempt's folder, and in the home folder, one there
   already counting as made; to open the clone's git `config` and `.claude/settings.json` for writing; to remove the
   keep file of `cache` and of `drop`; to move each folder away, or else to put a link beside it, and to write through
   the link; to read each store in the plan; to connect to the unlisted host, directly and through each HTTP proxy the
   shell's environment names; and to connect to the listener. Where the session's binding reaches this machine's
   loopback, which the adapter declares through `confineLoopback` for macOS alone, the start runs no listener when the
   base branch sets `projectRun.localBinding`, the plan's `local` is `null`, and the proof neither probes nor judges a
   listener; the start decides that from the team's policy, the host, and the platform, never from the plan. On Linux
   the listener stays required. The one known gap: on macOS with the key on, the proof does not check the loopback.
   The start does not read managed settings for this; one that keeps `allowLocalBinding` false leaves the session
   off the loopback, more isolated than the proof assumes. It also checks that each cache variable is in force in
   the shell with the value the start wrote. Any write, removal, move, link, or connection that succeeds is undone and
   fails the proof, and so does one whose target is not there. A read that opens is not yet a landed read: on Linux
   the host masks a denied folder with an empty one and a denied file with an empty one, so the proof hands what each
   read saw, salted with the nonce, to the start. It writes the verdict, `confine.json`, in the drop folder.
4. The start, outside the sandbox, reads the verdict once the beacon came, for at most 180 seconds: one of its own
   plan that passed, names no other session, holds no read that saw a target's fingerprint, with the listener the
   start ran alive on its recorded port and pid, no zombie, and no connection on it, no probe path left, and `cache`
   and `drop` plain folders that keep their keep files, passes. A connection completes before the listener notes it,
   so the start first connects to the listener itself and waits, up to 5 seconds for the connection and the wait
   together, until the listener notes that sentinel: it notes connections in the order it accepts them, so any the session made are noted by then, and every
   line but the sentinel's counts as a connection. A sentinel that cannot connect, or that is not noted in time,
   fails the proof as unverified. The start reads its listener's state from
   `/proc/<pid>/stat` on Linux and from `/bin/ps` elsewhere, and a start that can read neither refuses before its
   launch. It then files `confine: "passed"` in the session's mark, and the hook lets the session's calls through to
   the other guards. Any other verdict, or none in time, stops the session, files `confine: "failed"`, rewrites the
   verdict without what its reads saw, gives the attempt back, and halts the run until an attended
   `aidrian project resume`; when the stop itself fails, the start stays for `wait` to settle, and the run halts all
   the same. The hook refuses that session every later call. The listener stops when the start ends.

A start whose proof cannot be prepared refuses with `the sandbox proof cannot be prepared`, records nothing, and leaves
no attempt folder; [Project run](../config.md#project-run) names each cause and its fix.

The hook also refuses, to every session an unattended mark holds, a Bash call that sets `dangerouslyDisableSandbox`,
the host's ask to run outside the sandbox, which the adapter reads as the standard `sandbox_escape`; with
`allowUnsandboxedCommands: false` the host ignores it, so this is a second wall.

### Managed settings

The host ranks the organization's managed settings above `--settings`, so a managed value can undo the session's own
sandbox. Before a start, the start reads each managed source the host documents on this machine
(code.claude.com/docs/en/managed-settings, read on 2026-11-19), lowest rank first: `managed-settings.json` and each
`*.json` in `managed-settings.d/` beside it, in `/Library/Application Support/ClaudeCode/` on macOS and
`/etc/claude-code/` on Linux and WSL, then on macOS the managed preferences of the `com.anthropic.claudecode` domain,
`/Library/Managed Preferences/com.anthropic.claudecode.plist` and the same under the user's own folder there, read
through `plutil`. Each is judged by the user settings' rules for `sandbox` keys, granted folders, and commands, with
one more: a scalar the session's own settings set, such as `allowUnsandboxedCommands`, passes only at the session's
value, but `network.allowLocalBinding`, which passes at `false` too where `projectRun.localBinding` sets the session's
`true`, since `false` only narrows it, and `allowManagedPermissionRulesOnly` halts, since the host then drops the session's own permission rules that
keep its file tools from the stores its sandbox hides. Its `enabledPlugins` switches count over the user's for the plugin checks. A source that is there and cannot
be read halts the start; a platform with no documented sources halts it too.

Server-managed settings, which the host fetches from the claude.ai console and caches where its docs do not say, are
not read: a residual, which live check 22 covers.

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
file the host names in `CLAUDE_ENV_FILE`, which it reads and runs ahead of each Bash command. No package manager
variable is passed in the settings' `env`, whose one key is the start's claim (Project start, above). On Codex the same variables reach its sandboxed commands through `shell_environment_policy.set`.

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
  A reviewer and the test suite run without `CLAUDE_PID` and `CLAUDE_CODE_SESSION_ATTENDED`, which the adapter lists in
  its `identityVars`: one that inherited `CLAUDE_CODE_SESSION_ATTENDED=1` would take itself for the developer's attended
  session. It could not end that session, since it runs without `AIDRIAN_SHELL_PID` too.
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
   `permissions.allow` rule that may cover one: a `Bash` pattern whose text before its first `*`, less a final `:`,
   starts `git push`, such as `Bash(git:*)`, `Bash(git *)`, or `Bash(git p*)`; or `git push`, then any flags, then
   nothing, `:*`, ` *`, or `origin` with any rest after a word boundary, such as `Bash(git push)`,
   `Bash(git push --force:*)`, or `Bash(git push -u origin:*)`, `origin` being the remote the push preflight reads.
   `Bash(git pushall)` and `Bash(git push upstream main)` do not. On entering auto mode Claude Code drops broad allow
   rules, such as `Bash(*)`, and keeps narrow ones ([permission modes](https://code.claude.com/docs/en/permission-modes),
   read on 2026-11-20), so `Bash`, `Bash(*)`, `*`, `B*`, and a pattern that starts with `*` leave the verdict to the
   next steps.
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
