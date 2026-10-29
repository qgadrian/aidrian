# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
Claude Code runs them once the plugin is enabled. Codex asks you to trust them in `/hooks` after you install or update the plugin.

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
A blocking hook exits 2 and tells the agent why on stderr.

| Event | What runs | Host | Blocks |
| --- | --- | --- | --- |
| Session and subagent start | One line naming the `always` knowledge docs and the commands that find the rest, one line with the [names](config.md#names) for the human and the AI, and, for the main session, a last line while the lesson inbox holds open lessons | both | no |
| Before a Bash command | The Bash rules below, in this order, in one process | both | yes |
| Before Edit, Write, NotebookEdit, or Codex's `apply_patch` | The main-checkout rule, when the project turns it on | both | yes |
| Before an Agent tool call | The project's [model and effort](config.md#models) for this plugin's agent, added to the call | Claude Code | no |
| After Edit or Write of a Markdown file | The line-length check: lines the write made longer than config.json `docs.wrapLimit` | Claude Code | feedback |
| Before compaction | A checklist of what the summary must keep, unless instructions were typed after `/compact` | both | no |
| After an Agent tool call | A `dispatch` row in the [dispatch log](dispatch-log.md) | Claude Code | no |
| When the main session ends a turn | The [session-length reminder](#session-length), once a limit is passed | Claude Code | once |
| When a subagent stops | A `stop` row, then the [delivery check](#delivery-check) | Claude Code | once |
| When a session ends | A `session` row with the session's tokens and estimated cost | Claude Code | no |

Codex has no Edit, Write, or Agent tool, so those rows never run there.
Its stop, subagent-stop, and session-end payloads are not verified: the hooks run, write nothing they cannot read,
and never send a Codex agent back.
After you install the plugin in Codex, open a session, run `git commit --amend --dry-run`, and check that the Bash hook blocks it.

## Turning hooks off

| Hook | Off with |
| --- | --- |
| Main-checkout rule | Off unless config.json sets `"mainCheckout": { "guard": true }` |
| Markdown line length | `"docs": { "wrapLimit": 0 }` |
| Pull request body sections | `"github": { "requiredSections": [] }`; the footer and `--fill` checks stay |
| Session-length reminder | `"session": { "handoff": "off" }` |
| A Bash rule, once | Its override variable, set by a person: [Overrides](#overrides) |

The start lines and the dispatch log have no switch; they act only inside a project folder.
The Agent hook changes only what config.json or `.aidrian.local.json` sets in `models.claude`.
Another hook in the same project that rewrites Agent calls may override it, because each rewrite replaces the whole call.
It never reaches a session started with `claude --agent`, which takes the `--model` and `--effort` flags instead.
The compaction checklist steps aside whenever instructions are typed after `/compact`.

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | `--no-verify` on commit, push, or merge; `-n` on commit; core.hooksPath set in any letter case through `-c`, `--config-env`, or `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_KEY_<n>`; `HUSKY=0`; `git config` writing or unsetting core.hooksPath | none |
| Git amend | `git commit --amend` | `AIDRIAN_ALLOW_GIT_AMEND=1` |
| Kill by name | `pkill`, `killall`, `pgrep --signal`, `kill` fed by `pgrep` or `ps`, and `kill -- -1`; `kill <pid>` stays allowed | `AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1` |
| Command-line listing | `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, and `cmd` | `AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1` |
| Counting grep in `&&` | `grep -c` whose exit status an `&&` chain reads, such as `grep -c x log && npm test` | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Pull request body | `gh pr create` or `gh pr edit` with a body that lacks a config.json `github.requiredSections` heading or carries the "Generated with [Claude Code]" footer, and `gh pr create --fill` | `AIDRIAN_ALLOW_PR_BODY=1` |
| Main checkout, when turned on | A write to a tracked file in the main checkout: `>`, `>>`, `tee`, `sed -i`, `cp`, `mv` and `git mv` (sources and destination), `rm`, `git rm`, `unlink`, `touch`, `mkdir`, and `rsync` (sources too under `--remove-source-files`) | `AIDRIAN_ALLOW_MAIN_WRITE=1` |

A rule reads the command the way the shell splits it.
It sees through `sudo`, `env`, `timeout`, `command`, `rtk`, and similar wrappers, and ignores text in quotes, comments, and heredocs.
A long option it blocks also matches the shorter prefixes the program accepts, such as `--no-veri` for `--no-verify`,
`--am` for `--amend`, and `--cou` for grep's `--count`.
Every rule also reads the command substitutions that run: `$(…)`, backticks, `<(…)`, and those in a heredoc that expands.
The process rules also read `sh -c`, `eval`, and `xargs`.
A command reached only through a script or an interpreter such as `python -c` is out of their sight.

## Main checkout

The main-checkout rule is off until a project turns it on in config.json:

```json
{ "version": 1, "mainCheckout": { "guard": true, "allowWrites": ["notes/**"] } }
```

Then task work has to happen in a git worktree, so the main checkout stays clean and on the default branch.
The deny reason names `aidrian worktree new <branch>`, which creates one.
The rule blocks a write to a file git tracks, or would track, in the main checkout.
It allows a git-ignored path, a path in `mainCheckout.allowWrites`, and anything in a worktree or outside the repository.
[config.md](config.md) lists both keys.
When git cannot answer, an Edit or Write is blocked to be safe, and a Bash command runs.

## Markdown line length

After an Edit or Write of a `.md`, `.markdown`, or `.mdx` file in a project, the hook reads the whole file and names the lines
the write touched that are longer than `docs.wrapLimit`. The write already happened, so the agent fixes them with a follow-up edit.
Frontmatter, fenced and indented code, table rows, and a line whose overflow is one unbreakable token such as a URL are never reported.
`"docs": { "wrapLimit": 0 }` turns it off. Codex has no Edit or Write tool, so it never runs there.

## Delivery check

When a subagent's last message presents a `.md` or `.json` path as delivered and that path exists nowhere, the stop hook
sends it back once with the missing paths: it writes them, corrects its report, or says it removed them on purpose.
Its second stop always ends.
A path counts as delivered only on a line that also has the 📄 marker or one of the words wrote, written, created, saved,
handoff, or output, in any case, outside a path.
A path on any other line is a mention, such as "docs/old.md does not exist", and is never checked.
[dispatch-log.md](dispatch-log.md) describes the rows and `aidrian report`.

## Session length

A long session pays for its whole context on every turn; a fresh session started from a handoff brief costs less.
When the main session ends a turn, the Stop hook reads its transcript and measures three things:

- tokens: the context the last model call read, input and cache together;
- calls: the model calls the main session made, subagents not included;
- hours: the time worked, where a pause of more than an hour counts as one hour, so a night away does not count.

When one of them reaches its limit in config.json `session`, the hook acts once per session, as `session.handoff` says:

| `handoff` | What happens |
| --- | --- |
| `ask` (default) | The agent ends the turn with one question: hand off now, or keep going? Hand off runs the `session-handoff` skill. |
| `auto` | The agent writes the brief with the `session-handoff` skill, unless nothing is left to resume, and tells you its path. |
| `off` | Nothing. |

Either way it never comes back in that session, so a "keep going" is final.
A marker in the system's temporary folder remembers this; a new session starts fresh.
The defaults are 150,000 tokens, 250 calls, and 4 hours; a limit of `0` turns that one off. [config.md](config.md) lists the keys.
It reads Claude Code transcripts only: a transcript with no Claude Code usage, or a payload without `stop_hook_active`, does nothing.

## Overrides

An override is for a human: set it in your own shell before you start the session.
Agents must never set one.

## Commit messages

`aidrian commit-msg --file <path>` checks a commit subject against Conventional Commits and the types in config.json `commits.types`.
A project runs it from its own `commit-msg` git hook, where git passes the message file:

```sh
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs commit-msg --file "$1"
```
