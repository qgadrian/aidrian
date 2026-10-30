# Project config

`config.json` in the [project folder](project-folder.md) holds the folder version and the project's settings for the plugin.
The plugin's commands, hooks, and skills read it.
An `aidrian` command never acts on a `config.json` with an error, such as a renamed key.
It prints the errors and exits with its error code instead, such as 3 for `aidrian pr checks`.
The hooks keep working, with the default in place of each bad value.
Without a `config.json`, the commands use the defaults.

[`examples/consumer/.aidrian/config.json`](../examples/consumer/.aidrian/config.json) is a minimal, checked example.

## Keys

Only `version` is required. Every other key is optional, and the values below are the defaults.
In a group such as `github`, set only the keys you change; the others keep their defaults.

```json
{
  "version": 1,
  "git": {
    "defaultBranch": "main",
    "worktrees": {
      "dir": ".worktrees",
      "bootstrap": null,
      "disposable": ["node_modules", "dist", "build", ".next", ".cache", "coverage", ".turbo"]
    },
    "mainCheckout": { "guard": false, "allowWrites": [] },
    "commits": { "types": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] }
  },
  "state": { "dir": null },
  "github": {
    "requiredSections": ["Summary", "Tests run"],
    "reviewer": "chatgpt-codex-connector[bot]",
    "maxReviewRounds": 3,
    "requiredChecks": [],
    "ignoreCancelledChecks": [],
    "conditionalChecks": []
  },
  "docs": { "wrapLimit": 155 },
  "knowledge": { "budgets": { "alwaysBytes": 16384, "taggedDocBytes": 24576 } },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 },
  "session": { "handoff": "ask", "maxTokens": 150000, "maxCalls": 250, "maxHours": 4 },
  "lessons": { "auto": true, "maxOpen": 20, "maxAgeDays": 14 },
  "models": { "claude": { "agents": {} }, "codex": { "agents": {} } },
  "names": { "human": "the Human", "ai": null },
  "telemetry": {
    "enabled": true,
    "docReads": true,
    "hookDenies": true,
    "maxMb": 20,
    "health": {
      "minSample": 5,
      "redispatchPercent": 20,
      "sentBackPercent": 10,
      "topDocPercent": 50,
      "reviewRounds": 3,
      "lateFindingPercent": 50,
      "denyHotSpot": 5,
      "costRisePercent": 50
    }
  },
  "agents": {}
}
```

| Key | Meaning |
| --- | --- |
| `version` | The format of the project folder. [project-folder.md](project-folder.md#versioning) gives the rule. |
| `git.defaultBranch` | The branch that work merges into. |
| `git.worktrees.dir` | The folder for [task worktrees](project-folder.md#task-worktrees), `.worktrees` at the repository root by default. |
| `git.worktrees.bootstrap` | One shell command to run inside each new worktree, such as `npm ci`; `null` runs nothing. |
| `git.worktrees.disposable` | Folder names, at any depth, whose git-ignored files a cleanup removes without asking. `[]` asks for any ignored file. |
| `git.mainCheckout.guard` | `true` blocks agent edits to tracked files in the main checkout, so task work happens in worktrees. Off by default. |
| `git.mainCheckout.allowWrites` | Tracked paths agents may still edit in the main checkout, as globs with `*` and `**`. Ignored paths are always allowed. |
| `git.commits.types` | The Conventional Commits types a commit subject may use. |
| `state.dir` | The machine-local [state folder](project-folder.md#local-state); `null` is the one under `$XDG_STATE_HOME`. |
| `github.requiredSections` | The `## ` sections every pull request body must have ([Bash rules](hooks.md#bash-rules)); `[]` checks none. |
| `github.reviewer` | The login of the Codex review bot that `aidrian pr await-review` waits for. `null` or `"none"`: no bot ([below](#no-review-bot)). |
| `github.maxReviewRounds` | The review rounds a pull request may get, 3 by default: the review loop and `aidrian pr await-review --request` stop there. |
| `github.requiredChecks` | Parts of check names that must be present and pass before `aidrian pr checks` says ready. |
| `github.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `github.conditionalChecks` | Parts of check names whose `SKIPPED` or `NEUTRAL` result is routine, such as a job a path filter turns off. |
| `docs.wrapLimit` | The longest line, in characters, allowed in a Markdown file an agent writes; `0` turns the check off. |
| `knowledge.budgets.alwaysBytes` | The bytes all `always` knowledge docs may add up to: [Knowledge budgets](#knowledge-budgets). |
| `knowledge.budgets.taggedDocBytes` | The bytes one tagged knowledge doc may have: [Knowledge budgets](#knowledge-budgets). |
| `skills.descriptionChars` | The longest skill or agent description, in characters (`aidrian lint skills` and `agents`). |
| `skills.listingBytes` | The most bytes all skill names and descriptions may add up to (`aidrian lint skills`). |
| `session.handoff` | What the [session-length reminder](hooks.md#session-length) does once a limit is passed: `"ask"`, `"auto"`, or `"off"`. |
| `session.maxTokens` | The context, in tokens, of the main session's last model call that counts as long; `0` turns this limit off. |
| `session.maxCalls` | The main session's model calls that count as long; `0` turns this limit off. |
| `session.maxHours` | The hours worked that count as long, a pause of more than an hour counting as one; `0` turns this limit off. |
| `lessons.auto` | `false` turns off the [automatic lessons](lessons.md#automatic-lessons) the hooks and `aidrian pr await-review` record. |
| `lessons.maxOpen` | The open [lessons](lessons.md) past which the session-start line asks for triage; `0` turns this limit off. |
| `lessons.maxAgeDays` | The age, in days, of the oldest open lesson past which the session-start line asks for triage; `0` turns this limit off. |
| `models` | The model and effort of the plugin's agents, per host, in place of the ones the plugin ships: [Models](#models). |
| `names.human` | What agents call the person they work for: [Names](#names). |
| `names.ai` | What agents call themselves; `null` is the host's name, Claude or Codex: [Names](#names). |
| `telemetry.enabled` | `false` stops the hooks from writing the [dispatch log](dispatch-log.md): [Telemetry](#telemetry). |
| `telemetry.docReads` | `false` leaves out which knowledge docs each agent read. |
| `telemetry.hookDenies` | `false` leaves out the `hook_deny` row each block by one of the plugin's rules writes; the rules still block. |
| `telemetry.maxMb` | The size, in megabytes, at which the dispatch log moves to its rotated part. |
| `telemetry.health` | The thresholds of `aidrian report health`: [Health thresholds](#health-thresholds). |
| `agents` | The tools each agent may use in this project; `{}` gates none: [Agents](#agents). |

A path in `state.dir` or `git.worktrees.dir` may start with `~`, the home folder, or be relative to the repository root.
The other local state has fixed places in the state folder; [project-folder.md](project-folder.md#local-state) lists them.

Once `github.conditionalChecks` has an entry, `aidrian pr checks` fails on any other skip; `[]` lets every skip pass, named in the output.

### No review bot

A project without the Codex review bot sets `"github": { "reviewer": null }`, or `"none"`.

- `aidrian pr await-review` then ends at once with exit 0 and `"status": "no_reviewer"`.
  It runs no `gh`, posts no review request, and waits for nothing. `--reviewer none` does the same for one run.
- `aidrian report reviews` and the Reviews line of `aidrian report health` say that no review bot is set.
- The `orchestration` and `autopilot` skills then run the `pr-review` skill in every review round.

## Models

Each agent file in the plugin sets the model and effort the agent ships with, from the plugin's [provider files](agents.md#provider-files).
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

How each host applies the choice, and its limits: [Claude Code](providers/claude-code.md#models-and-effort),
[Codex](providers/codex.md#models-and-effort).

Neither host lets a project change the model or effort of a plugin skill, so `models` has no `skills` key, and `aidrian check` refuses one.
Claude Code reads a skill's `model` and `effort` only from its own `SKILL.md`, and Codex skills have neither.
The plugin's skills set neither, so they run on the session's model and effort.

## Names

Agent output that says "you" or "me" leaves the reader unsure who is meant.
The start hook gives every session and subagent one line with both names, and the `knowledge` skill tells agents to use them
in replies, docs, handoffs, commits, and pull request bodies:

```text
Names: call the human "the Human" and yourself "Claude"; never "you"/"me".
```

A team sets its names in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{ "names": { "human": "the product owner", "ai": "the agent" } }
```

`.aidrian.local.json` wins over `config.json`, one name at a time.
`aidrian check` names an unknown key and a name that is not a non-empty string.

## Telemetry

The hooks record what agents cost and read in the [dispatch log](dispatch-log.md), on this machine only; nothing goes over the network.
A team sets `telemetry` in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{ "telemetry": { "enabled": false } }
```

`.aidrian.local.json` wins over `config.json`, one key at a time.

- `enabled: false`: the hooks write no rows.
  The [delivery check](hooks.md#delivery-check) still sends a subagent back for a file it named and did not write.
- `docReads: false`: `stop` and `session` rows keep tokens and cost, and hold `docs_read: null` instead of the docs read.
- `maxMb`: once the log reaches this size, the next row moves it to `dispatch-log.1.jsonl`, replacing the file there.
  The two files hold about twice `maxMb` at most, and `aidrian report` reads both.
- `hookDenies: false`: the Bash rules, the main-checkout rule, the agent gates, and the config guard still block,
  and write no `hook_deny` row ([hooks.md](hooks.md#recorded-blocks)). A rule that keeps blocking one session still becomes a lesson.

The last three keys were `doc_reads`, `max_mb`, and `hook_denies`; a file that still sets one gets an error naming the new key.

`aidrian report` says when telemetry is off, and when the rows it read miss part of the window:
[dispatch-log.md](dispatch-log.md#when-the-report-is-incomplete).

### Health thresholds

[`aidrian report health`](dispatch-log.md#health) judges each signal against `telemetry.health`.
Set only the keys you change; a team sets them in `config.json`, and one developer in `.aidrian.local.json`, as above.

| Key | A problem when |
| --- | --- |
| `minSample` | Not a threshold: a signal with a smaller sample says "not enough data" and is never a problem. |
| `redispatchPercent` | More than this share of an agent type's dispatches repeat a task already dispatched in the same session. |
| `sentBackPercent` | More than this share of an agent type's runs were sent back by the [delivery check](hooks.md#delivery-check). |
| `topDocPercent` | One knowledge doc takes more than this share of all the bytes of knowledge docs read. |
| `reviewRounds` | The review bot takes more than this many rounds a pull request on average; 3 is the `autopilot` skill's cap. |
| `lateFindingPercent` | More than this share of the late findings checked sat on a line the bot had already reviewed. |
| `denyHotSpot` | One of the plugin's rules blocks this many calls or more in the window. |
| `costRisePercent` | A session in the newer half of the window's sessions costs more than this percent above one in the older half, on average. |

The four `Percent` keys take a whole number from 1 to 100; the others, a whole number above 0.
The knowledge budget uses [`knowledge.budgets`](#knowledge-budgets), and the lesson backlog `lessons.maxOpen` and `lessons.maxAgeDays`.

## Knowledge budgets

Every session and subagent reads the `always` docs, and `aidrian-knowledge route <tag>` lists each doc of the tag to read whole.
`aidrian check` and `aidrian lint budget` hold both to a size:

- The `always` docs of all buckets together: a warning above `alwaysBytes`, 16 KB by default, and an error above twice that.
- Each doc with at least one tag: a warning above `taggedDocBytes`, 24 KB by default.
  Split such a doc into a short rule card and a reference, or drop its tags so that only search finds it.

The warnings print on stderr, and the check still passes. `aidrian check` prints the `always` total on its last line;
the warning below is one line, wrapped here:

```console
$ aidrian check
warning: docs/knowledge/engineering/sync-protocol.md: 41230 bytes, over knowledge.budgets.taggedDocBytes (24576); every route to
  backend reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it
ok: .aidrian (2 buckets, 8 docs)
state: /home/you/.local/state/aidrian/projects/notes-1a2b3c4d
budget: 2479 of 16384 always-doc bytes (engineering 2479, product 0)
```

The key `docs.alwaysBudgetBytes` moved here as `alwaysBytes`; a `config.json` that still sets it gets an error naming the new key.
[knowledge.md](knowledge.md#shaping-buckets) says how to shape buckets that stay within the budgets.
[`aidrian report docs`](dispatch-log.md#doc-reads) prints the same `always` total beside the docs agents read and the ones nobody read.

## Agents

`agents` limits the tools each agent may use in this project, and those of the main session.
A team sets it in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{
  "agents": {
    "*": { "deny": ["mcp__slack__*"] },
    "main": { "deny": ["Bash(git push)"] },
    "explorer": { "allow": ["Read", "Grep", "Glob", "Bash(git log)", "Bash(git show)"] }
  }
}
```

Each key names who its entry applies to:

| Key | Applies to |
| --- | --- |
| `*` | Every agent and the main session. |
| `main` | The main session, also one started with `claude --agent <name>`. |
| A short name, such as `explorer` | Every agent of that name: `aidrian:explorer`, another plugin's `explorer`, and a project's `explorer`. |
| A full name, such as `aidrian:explorer` | That plugin's agent only. |

Every entry that applies is checked, and a tool call runs only when each one lets it.
A session started with `claude --agent aidrian:explorer` is both `main` and `explorer`.

An entry has `deny`, `allow`, or both, each a list of tool patterns:

| Pattern | Matches |
| --- | --- |
| A tool name, such as `Read` or `WebFetch` | That tool. |
| A name ending in `*`, such as `mcp__github__*` | Every tool whose name starts with the text before the `*`; `*` alone matches every tool. |
| `Bash(<command prefix>)`, such as `Bash(git push)` | A Bash call that runs a command whose words start with the prefix. |

- `deny` wins: a call that matches a `deny` pattern is blocked, whatever `allow` says.
- With `allow` set, a call that matches none of its patterns is blocked; `"allow": []` blocks every tool.
- A Bash call passes an `allow` list through its `Bash(...)` patterns only when every command in it starts with an allowed prefix.
  `cd app && npm test` needs both `Bash(cd)` and `Bash(npm test)`.
- A command line is read as the [Bash rules](hooks.md#bash-rules) read it: each step of `&&`, `;`, and `|`, and each command substitution.
  It also reads past wrappers such as `sudo` and `env`, and past git's own options, so `Bash(git push)` also blocks `git -C app push`.
- The first word matches the program by its file name, so `Bash(git push)` also matches `/usr/bin/git push`.
- The command line of `sh -c` or `bash -c` is read too, so `Bash(git push)` blocks `bash -c 'git push'`; an `allow` list must also allow the shell.
- A gate matches the command text, so a command run by `xargs`, `eval`, a script, or an interpreter is out of sight;
  an `allow` list blocks it unless it allows the outer command, and a `deny` list can name the outer command, such as `Bash(xargs)`.

`.aidrian.local.json` wins over `config.json` one list at a time.
Its `deny` for an agent replaces the team's `deny` for that agent, and its `allow` replaces the team's `allow`.
A developer can lift a team's `allow` list on one machine with `"allow": ["*"]`.
An agent cannot: while `agents` sets any gate, no subagent may change config.json, `.aidrian.json`, or `.aidrian.local.json`,
also the main checkout's when the project is a git worktree. The main session still can.
While one of those files is there but cannot be read, the gates are unknown, so every subagent may only read files until it is fixed.
`aidrian check` names an unknown key, a key that is not an agent name, and a pattern it cannot read, such as `Bash(git *)`.
A bad pattern is left out and the rest of its list still applies, so a bad `allow` pattern makes the list stricter.
`aidrian check` cannot know every agent's name, so a name that matches no agent is not an error: its entry never applies.
[hooks.md](hooks.md#agent-gates) describes the hook that enforces the gates, and what each host supports.

## Checking

`aidrian check` validates this file with the rest of the project folder.
It lists every problem: a missing file, invalid JSON, a missing or other `version`, an unknown key, or a value of the wrong type.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed.
