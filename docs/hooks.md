# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
Claude Code runs them once the plugin is enabled. Codex asks you to trust them in `/hooks` after you install or update the plugin.

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
A blocking hook exits 2 and tells the agent why on stderr.

| Event | What runs | Blocks |
| --- | --- | --- |
| Session and subagent start | One line naming the `always` knowledge docs and the commands that find the rest | no |
| Before a Bash command | The Bash rules below, in this order, in one process | yes |

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | `--no-verify` on commit, push, or merge; `-n` on commit; `-c core.hooksPath=…`; `HUSKY=0` | none |
| Git amend | `git commit --amend` | `AIDRIAN_ALLOW_GIT_AMEND=1` |

A rule reads the command the way the shell splits it.
It sees through `sudo`, `env`, `timeout`, `command`, `rtk`, and similar wrappers, and ignores text in quotes, comments, and heredocs.

An override is for a human: set it in your own shell before you start the session.
Agents must never set one.

## Commit messages

`aidrian commit-msg --file <path>` checks a commit subject against Conventional Commits and the types in config.json `commits.types`.
A project runs it from its own `commit-msg` git hook, where git passes the message file:

```sh
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs commit-msg --file "$1"
```
