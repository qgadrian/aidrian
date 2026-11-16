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
call it ([tools reference](https://code.claude.com/docs/en/tools-reference#monitor-tool)). A hook whose matcher is Bash
gets those commands as Bash calls; one whose matcher takes every tool, as the agent gates hook's does, gets the Monitor
call itself ([hooks reference](https://code.claude.com/docs/en/hooks#match-monitor-commands)). So the adapter's
`hookInput` reads a Monitor call with a `command` as `Bash`, with `raw_tool_name: "Monitor"`, and the guards of a shell
command, such as the [handoff guard](../hooks.md#agent-gates), read it as they read Bash. A gate that names `Monitor`
still matches it. A WebSocket watch takes `ws` in place of `command`, runs no shell, and stays as it is.

## Handoff continuation

Claude Code does the `clear` route of [`session.handoff.continue`](../handoff.md#continue): after the brief, the Human
types `/clear` and then any message, which is the adapter's `steps.clear`, and the new session resumes from the brief.
`compact` and `background` fall back to `none` until their release, and `aidrian handoff route` prints `route: none` for them.
What follows is the host behavior the route rests on; the route itself has not yet run live from end to end.

Verified on Claude Code 2.1.325 on 2026-11-15, with a throwaway plugin:

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
| Whether `CLAUDE_CODE_SESSION_ID` in the Bash tool follows a clear | The gate arms for the id the Bash tool gives. Were it the old id, a second continuation in a row would arm for a session that has already ended, and deliver nothing: the `say:` line names the resume by hand. |
| Whether UserPromptSubmit fires for the clear or compact command | The adapter's `keepsArmed(prompt)` leaves the continuation for `/clear`, `/reset`, `/new`, and `/compact`. |
| Whether other built-in commands fire UserPromptSubmit | Each one that does cancels the continuation, as any prompt does: only those four are spared. |
| Whether a hook payload's `cwd` follows a `cd` in the Bash tool | No hook compares a folder: the session start matches the host process, and every checkout of the project shares one store. |

UserPromptSubmit also fires when a background subagent reports back, on a scheduled-task or loop iteration, on a
message from another session, and on the output of Claude's code in a Code Mode session when that code runs in the
background ([its hooks reference](https://code.claude.com/docs/en/hooks#userpromptsubmit)). Each of those after the
gate cancels the continuation, so the `session-handoff` skill's first step settles them all, Code Mode code running
in the background among its background jobs, before it writes the brief and runs the gate.
The SessionEnd hook promotes the continuation before it hands the session row to its worker, within the host's 1.5 seconds.

## Limits

Claude Code enforces each agent's tool limits.
A read-only agent cannot use `Write`, `Edit`, or `NotebookEdit`: [Merge order](../agent-sources.md#merge-order).
