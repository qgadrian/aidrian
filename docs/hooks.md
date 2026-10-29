# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
Claude Code runs them once the plugin is enabled. Codex asks you to trust them in `/hooks` after you install or update the plugin.

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
A blocking hook exits 2 and tells the agent why on stderr.

| Event | What runs | Blocks |
| --- | --- | --- |
| Session and subagent start | One line naming the `always` knowledge docs and the commands that find the rest | no |
| Before a Bash command | The Bash rules below, in this order, in one process | yes |
| Before Edit, Write, NotebookEdit, or Codex's `apply_patch` | The main-checkout rule | yes |
| After Edit or Write of a Markdown file | The line-length check: lines the write made longer than config.json `docs.wrapLimit` | feedback |

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | `--no-verify` on commit, push, or merge; `-n` on commit; `-c core.hooksPath=…`; `HUSKY=0` | none |
| Git amend | `git commit --amend` | `AIDRIAN_ALLOW_GIT_AMEND=1` |
| Kill by name | `pkill`, `killall`, `pgrep --signal`, `kill` fed by `pgrep` or `ps`, and `kill -- -1`; `kill <pid>` stays allowed | `AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1` |
| Command-line listing | `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, and `cmd` | `AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1` |
| Counting grep in `&&` | `grep -c` whose exit status an `&&` chain reads, such as `grep -c x log && npm test` | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Main checkout | A write to a tracked file in the main checkout: `>`, `>>`, `tee`, `sed -i`, `cp`, `mv`, `rm`, `touch`, `mkdir` | `AIDRIAN_ALLOW_MAIN_WRITE=1` |

A rule reads the command the way the shell splits it.
It sees through `sudo`, `env`, `timeout`, `command`, `rtk`, and similar wrappers, and ignores text in quotes, comments, and heredocs.
The process rules also read `sh -c`, `eval`, `xargs`, and the command substitutions that run.
A command reached only through a script or an interpreter such as `python -c` is out of their sight.

## Main checkout

Task work happens in a git worktree, so the main checkout stays clean and on the default branch.
The main-checkout rule blocks a write to a file git tracks, or would track, in the main checkout of a project that has a project folder.
It allows a git-ignored path, a path in `mainCheckout.allowWrites`, and anything in a worktree or outside the repository.
A project that does not use worktrees turns it off with `"mainCheckout": { "guard": false }`; [config.md](config.md) lists both keys.
When git cannot answer, an Edit or Write is blocked to be safe, and a Bash command runs.

## Markdown line length

After an Edit or Write of a `.md`, `.markdown`, or `.mdx` file in a project, the hook reads the whole file and names the lines
the write touched that are longer than `docs.wrapLimit`. The write already happened, so the agent fixes them with a follow-up edit.
Frontmatter, fenced and indented code, table rows, and a line whose overflow is one unbreakable token such as a URL are never reported.
`"docs": { "wrapLimit": 0 }` turns it off. Codex has no Edit or Write tool, so it never runs there.

## Overrides

An override is for a human: set it in your own shell before you start the session.
Agents must never set one.

## Commit messages

`aidrian commit-msg --file <path>` checks a commit subject against Conventional Commits and the types in config.json `commits.types`.
A project runs it from its own `commit-msg` git hook, where git passes the message file:

```sh
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs commit-msg --file "$1"
```
