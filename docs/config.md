# Project config

`config.json` in the [project folder](project-folder.md) holds the folder version and the project's settings for the plugin.
The plugin's commands, hooks, and skills read it.

[`examples/consumer/.aidrian/config.json`](../examples/consumer/.aidrian/config.json) is a minimal, checked example.

## Keys

Only `version` is required. Every other key is optional, and the values below are the defaults.
In a group such as `pr`, set only the keys you change; the others keep their defaults.

```json
{
  "version": 1,
  "defaultBranch": "main",
  "state": { "dir": null },
  "worktrees": { "dir": ".worktrees", "bootstrap": null },
  "mainCheckout": { "guard": false, "allowWrites": [] },
  "commits": { "types": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] },
  "pr": {
    "requiredSections": ["Summary", "Tests run"],
    "reviewer": "chatgpt-codex-connector[bot]",
    "maxReviewRounds": 10,
    "requiredChecks": [],
    "ignoreCancelledChecks": []
  },
  "docs": { "wrapLimit": 155, "alwaysBudgetBytes": 40000 },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 },
  "session": { "handoff": "ask", "maxTokens": 150000, "maxCalls": 250, "maxHours": 4 },
  "models": { "claude": { "agents": {} }, "codex": { "agents": {} } }
}
```

| Key | Meaning |
| --- | --- |
| `version` | The format of the project folder. [project-folder.md](project-folder.md#versioning) gives the rule. |
| `defaultBranch` | The branch that work merges into. |
| `state.dir` | The machine-local [state folder](project-folder.md#local-state); `null` is the one under `$XDG_STATE_HOME`. |
| `worktrees.dir` | The folder for [task worktrees](project-folder.md#task-worktrees), `.worktrees` at the repository root by default. |
| `worktrees.bootstrap` | One shell command to run inside each new worktree, such as `npm ci`; `null` runs nothing. |
| `mainCheckout.guard` | `true` blocks agent edits to tracked files in the main checkout, so task work happens in worktrees. Off by default. |
| `mainCheckout.allowWrites` | Tracked paths agents may still edit in the main checkout, as globs with `*` and `**`. Ignored paths are always allowed. |
| `commits.types` | The Conventional Commits types a commit subject may use. |
| `pr.requiredSections` | The `## ` sections every pull request body must have; the Bash hook refuses a `gh pr create` or `gh pr edit` body without them. `[]` checks none. |
| `pr.reviewer` | The login of the Codex review bot that `aidrian pr await-review` waits for. |
| `pr.maxReviewRounds` | How many bot reviews a pull request may get before `aidrian pr await-review --request` stops asking. |
| `pr.requiredChecks` | Parts of check names that must be present and pass before `aidrian pr checks` says ready. |
| `pr.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `docs.wrapLimit` | The longest line, in characters, allowed in a Markdown file an agent writes; `0` turns the check off. |
| `docs.alwaysBudgetBytes` | The most bytes all `always` knowledge docs may add up to (`aidrian lint budget`). |
| `skills.descriptionChars` | The longest skill or agent description, in characters (`aidrian lint skills` and `agents`). |
| `skills.listingBytes` | The most bytes all skill names and descriptions may add up to (`aidrian lint skills`). |
| `session.handoff` | What the [session-length reminder](hooks.md#session-length) does once a limit is passed: `"ask"` asks whether to hand off, `"auto"` writes the handoff brief, `"off"` does nothing. |
| `session.maxTokens` | The context, in tokens, of the main session's last model call that counts as long; `0` turns this limit off. |
| `session.maxCalls` | The main session's model calls that count as long; `0` turns this limit off. |
| `session.maxHours` | The hours worked that count as long, a pause of more than an hour counting as one; `0` turns this limit off. |
| `models` | The model and effort of the plugin's agents, per host, in place of the ones the plugin ships: [Models](#models). |

A path in `state.dir` or `worktrees.dir` may start with `~`, the home folder, or be relative to the repository root.
The other local state has fixed places in the state folder; [project-folder.md](project-folder.md#local-state) lists them.

## Models

Each agent file in the plugin sets the model and effort the agent ships with.
A team can choose others in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{
  "models": {
    "claude": { "agents": { "planning-agent": { "model": "opus", "effort": "high" } } },
    "codex": { "agents": { "planning-agent": { "model": "gpt-5.5", "effort": "medium" } } }
  }
}
```

`.aidrian.local.json` wins over `config.json`, and `config.json` wins over the agent file, one value at a time:
set `model`, `effort`, or both, and the other keeps the value from below.
`aidrian check` names an unknown host, agent, or key, and a value the host does not take.

| Host | `model` | `effort` |
| --- | --- | --- |
| `claude` | `sonnet`, `opus`, `haiku`, or `fable` | `low`, `medium`, `high`, `xhigh`, or `max` |
| `codex` | a Codex model name, such as `gpt-5.5` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `persistent` |

In Claude Code, a hook adds the choice to each Agent tool call to that agent, from the next call on.

- An `effort` choice needs Claude Code 2.1.292 or later, the first version whose Agent tool call takes `effort`.
- The Agent tool takes only the four model names above, never a full model id or `inherit`.
- A model or effort the dispatching agent passes for one call still wins.
- An agent that runs the whole session, as with `claude --agent aidrian:planning-agent`, keeps its file's values.

In Codex, the agents are roles outside the plugin, so `install-agents.mjs` writes the choice into them.
It does that only when it installs into a folder inside the project, because the user folder `~/.codex/agents` serves every project:

```sh
node ~/.codex/plugins/cache/aidrian-harness/aidrian/*/codex/install-agents.mjs --target .codex/agents
```

- Run it again after each change to `models.codex`; the next Codex session reads the new roles.
- Codex reads a project's `.codex/agents` only when the project is trusted.
- The installed roles carry the personal choice too, so keep `.codex/agents` out of git while `.aidrian.local.json` sets `models.codex`.

Neither host lets a project change the model or effort of a plugin skill, so `models` has no `skills` key, and `aidrian check` refuses one.
Claude Code reads a skill's `model` and `effort` only from its own `SKILL.md`, and Codex skills have neither.
The plugin's skills set neither, so they run on the session's model and effort.

## Checking

`aidrian check` validates this file with the rest of the project folder.
It lists every problem: a missing file, invalid JSON, a missing or other `version`, an unknown key, or a value of the wrong type.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed.
