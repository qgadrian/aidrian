# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
How each host runs them: [Claude Code](providers/claude-code.md#hooks), [Codex](providers/codex.md#hooks).

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
A git call a hook makes is stopped after 2 seconds and counts as git not answering; the hook's later git calls then do not wait.
A blocking hook exits 2 and tells the agent why on stderr.
The Bash rules, the main-checkout rule, the terms rule, the GitHub MCP hook, the agent gates, and the config guard also record each block:
see [Recorded blocks](#recorded-blocks).

| When | What runs | Host | Blocks |
| --- | --- | --- | --- |
| A session or subagent starts | The [start lines](#start-lines) | both | no |
| Before any tool call | The [agent gates](#agent-gates), when the project sets any | both | yes |
| Before a Bash command | The [Bash rules](#bash-rules) | both | yes |
| Before a file edit | The [main-checkout rule](#main-checkout), when the project turns it on, then the [terms rule](#terms) | both | yes |
| Before `EnterWorktree` in a subagent | A block: the tool would move the whole session into the worktree | Claude Code | yes |
| Before a GitHub MCP comment | The [review gate](config.md#review-gate), when the project turns it on | both | yes |
| Before an Agent tool call | The project's [model and effort](config.md#models) for that agent | Claude Code | no |
| After a Markdown write | The [line-length check](#markdown-line-length) | Claude Code | feedback |
| Before compaction | A checklist of what the summary must keep | both | no |
| The Human approves a plan | The [plan handoff offer](#session-length), in a long main session | Claude Code | no |
| After an Agent tool call | A `dispatch` row in the [dispatch log](dispatch-log.md) | Claude Code | no |
| The main session ends a turn | The [session-length reminder](#session-length) | Claude Code | once |
| A subagent stops | A `stop` row, then the [delivery check](#delivery-check) | Claude Code | once |
| A session ends | A `session` row with its tokens and estimated cost | Claude Code | no |

The Bash rules run in the order of their table, in one process.
A file edit is an Edit, Write, or NotebookEdit call, or Codex's `apply_patch`.

## Start lines

At the start of every session and subagent, the hook prints:

- one line naming the `always` knowledge docs and the commands that find the rest;
- one line with the [names](config.md#names) for the human and the AI;
- in the main session only, one more line while the [lesson inbox](lessons.md#session-start) holds open lessons.

## Turning hooks off

| Hook | Off with |
| --- | --- |
| Agent gates | Off unless config.json or `.aidrian.local.json` sets `agents` |
| Main-checkout rule | Off unless config.json sets `"git": { "mainCheckout": { "guard": true } }` |
| Markdown line length | `"docs": { "wrapLimit": 0 }` |
| Pull request body sections | `"github": { "requiredSections": [] }`; the footer and `--fill` checks stay |
| Pull request contract | Off unless config.json sets `github.pullRequest`, but for `"sharedTempBodyFile": false` |
| Review gate | Off unless config.json sets `"github": { "reviewGate": { "enabled": true } }` |
| Terms rule | Off unless config.json sets `"terms": { "file": "…" }` |
| Session-length reminder and plan handoff offer | `"session": { "handoff": "off" }` |
| Dispatch log rows | `"telemetry": { "enabled": false }`, in config.json or `.aidrian.local.json`; the delivery check still runs |
| `hook_deny` rows alone | `"telemetry": { "hookDenies": false }`; the rules still block |
| Automatic lessons from the stop hook and the blocking rules | `"lessons": { "auto": false }` |
| A Bash rule, once | Its override variable, set by a person: [Overrides](#overrides) |

The start lines have no switch; they act only inside a project folder.
[config.md](config.md#telemetry) lists the other `telemetry` keys.
The Agent hook changes only what config.json or `.aidrian.local.json` sets in `models.claude`.
The compaction checklist steps aside whenever instructions are typed after `/compact`.

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | Skipping or turning off git hooks | none |
| Git amend | `git commit --amend` | `AIDRIAN_ALLOW_GIT_AMEND=1` |
| Kill by name | Killing processes by name | `AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1` |
| Command-line listing | Listing the command lines of other processes | `AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1` |
| Counting grep in `&&` | A `grep -c` whose exit status an `&&` chain reads | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Pull request body | A pull request body without the required sections, or with the footer; the [contract](config.md#pull-request-contract) | `AIDRIAN_ALLOW_PR_BODY=1` |
| Review gate, when turned on | Asking the review bot before a review is on record ([config.md](config.md#review-gate)) | `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1` |
| Main checkout, when turned on | A shell write to a tracked file in the main checkout | `AIDRIAN_ALLOW_MAIN_WRITE=1` |

What each rule matches:

- Git hook bypass: `--no-verify` on commit, push, or merge; `-n` on commit; `HUSKY=0`;
  core.hooksPath set in any letter case through `-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_KEY_<n>`;
  and `git config` writing or unsetting core.hooksPath.
- Kill by name: `pkill`, `killall`, `pgrep --signal`, `kill` fed by `pgrep` or `ps`, and `kill -- -1`. `kill <pid>` stays allowed.
- Command-line listing: `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, and `cmd`.
- Counting grep in `&&`: such as `grep -c x log && npm test`.
- Pull request body: `gh pr create` or `gh pr edit` with a body that lacks a config.json `github.requiredSections` heading,
  or that carries the "Generated with [Claude Code]" footer; and `gh pr create --fill`.
  With `github.pullRequest` set, also the title, the closed list of sections, the deferral and residual items,
  a body file in a shared temp folder, and a body identical to another open pull request's.
- Review gate: `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose body
  asks `@codex review`; `gh pr create --reviewer` and `gh pr edit --add-reviewer` naming `github.reviewer`.
- Main checkout: `>`, `>>`, `tee`, `sed -i`, `perl -i`, `ruby -i`, `cp`, `mv` and `git mv` (sources and destination), `rm`, `git rm`, `unlink`,
  `touch`, `mkdir`, and `rsync` (sources too under `--remove-source-files`).

Each rule is a file in `plugins/aidrian/lib/rules/`; a rule that reads only `gh` commands, such as the pull request body rule, is in `rules/github/`.
Each block is recorded: [Recorded blocks](#recorded-blocks).
A rule reads the command the way the shell splits it.
It sees through `sudo`, `env`, `timeout`, `command`, `rtk`, and similar wrappers, and ignores text in quotes, comments, and heredocs.
A long option it blocks also matches the shorter prefixes the program accepts, such as `--no-veri` for `--no-verify`,
`--am` for `--amend`, and `--cou` for grep's `--count`.
Every rule also reads the command substitutions that run: `$(…)`, backticks, `<(…)`, and those in a heredoc that expands.
The process rules also read `sh -c`, `eval`, and `xargs`.
A command reached only through a script or an interpreter such as `python -c` is out of their sight.

## Recorded blocks

Every block by a Bash rule, the main-checkout rule, an [agent gate](#agent-gates), or the config guard is recorded twice,
in `plugins/aidrian/lib/hook-deny.mjs`, before the hook exits 2:

- A `hook_deny` row in the [dispatch log](dispatch-log.md#hook_deny-when-one-of-the-plugins-rules-blocks-a-tool-call):
  the rule, the tool, the agent, and what the rule matched, never the command.
  `"telemetry": { "hookDenies": false }` turns the row off. `aidrian report` lists the rows by rule and agent.
- A count toward an [automatic lesson](lessons.md#automatic-lessons): when one rule blocks the same session a third time,
  an agent that keeps trying was not shown the allowed way. The count does not depend on telemetry.

The rules are named in the rows and lessons as `git-hook-bypass`, `git-amend`, `process-kill` (both the kill and the listing rule),
`grep-exit-chain`, `pr-body`, `review-gate` (the Bash rule and the MCP hook), `main-checkout`, `terms`, `agent-gates`, and `config-guard`.
The hooks load the recorder only when they block, so a call they let run costs no more than before.
When the recorder fails, the call is still blocked.

## Main checkout

The main-checkout rule is off until a project turns it on in config.json:

```json
{ "version": 1, "git": { "mainCheckout": { "guard": true, "allowWrites": ["notes/**"] } } }
```

Then task work has to happen in a git worktree, so the main checkout stays clean and on the default branch.
The deny reason names `aidrian worktree new <branch>`, which creates one.
The rule blocks a write to a file git tracks, or would track, in the main checkout.
It allows a git-ignored path, a path in `git.mainCheckout.allowWrites`, and anything in a worktree or outside the repository.
[config.md](config.md) lists both keys.
When git cannot answer, an Edit or Write is blocked to be safe, and a Bash command runs.

## Agent gates

Before every tool call, the hook checks the call against the project's `agents` gates; [config.md](config.md#agents) gives the keys and patterns.
A blocked call exits 2 with the rule on stderr, such as `agents.main.deny has "Bash(git push)"`.
A `Bash(...)` gate matches the command text: it reads the command line of `sh -c` and `bash -c`, a heredoc or here-string fed
to a shell (`bash <<'EOF'`), function bodies and `case` arms, and commands behind wrappers such as `sudo`, `doas`, `setsid`,
`flock`, and `coproc`.
It does not read a command run by `xargs`, `find -exec`, `eval`, a script, or text piped into a shell (`echo 'git push' | bash`),
so `xargs git push` passes `Bash(git push)`; a `deny` list can name `Bash(xargs)`, `Bash(find)`, or `Bash(bash)` itself, and an
`allow` list that names no shell keeps them out.
The reason also tells the agent not to reach the same result with another tool, and to tell the human what the task needs.
The block is [recorded](#recorded-blocks) as `agent-gates`, with that gate as its reason.
A gate that blocks one session a third time becomes a lesson for the project, not the plugin: the gates are the project's.
The hook runs for every tool, so a project without gates still pays for one process that finds the project, reads its config, and exits.

While any gate is set, the hook also blocks a subagent that changes a file that sets the gates, so an agent cannot lift its own:
config.json, `.aidrian.json`, and `.aidrian.local.json`, also the main checkout's when the project is a git worktree.

- It reads writes as the [main-checkout rule](#main-checkout) does: Edit, Write, NotebookEdit, and `apply_patch` by the path they name,
  and a Bash command by the paths it writes, such as `>`, `sed -i`, `cp`, `mv`, and `rm`.
- Unlike that rule, it follows each `cd`, and reads the command line of `sh -c` and `bash -c`.
  After a `cd` to a folder it cannot name, such as `cd "$dir"`, a relative path counts when its name is one of the files or the project folder.
- An interpreter given code on its command line or its input, such as `python3 -c`, `node -e`, `perl -e`, `ruby -e`, or a heredoc,
  counts as a write to each of the files its code or its other words name, whatever the code calls.
  Only code that is nothing but reads runs: in Python `json.load(open(p))` and `open(p).read()`,
  in Node `require(p)`, `readFileSync(p)`, and `JSON.parse(readFileSync(p))`, each printed or not, with `p` a quoted path.
  perl and ruby have none. Read, `cat`, and `jq` still read the files, as the block says.
- A write to a folder that holds one of the files, such as `rm -rf .aidrian`, counts; one to the project root, such as `cp notes.md .`, does not.
- A call without `agent_id` is the main session's, which may still change them.
- A block is [recorded](#recorded-blocks) as `config-guard`, with the file it changes as its reason.
- A write the rule cannot see, such as one by a script, `xargs`, or `eval`, or a file name the code builds, still runs.
  It changes the file, but lifts no gate before the session ends: see the session's gates below.
  Like the gates, the guard is for agents that cooperate, not a sandbox.

When config.json, `.aidrian.json`, or `.aidrian.local.json` is there but cannot be read, such as invalid JSON or another `version`,
the hook cannot know the gates, so it fails closed for subagents.
A subagent may then use only Read, Grep, Glob, LS, and NotebookRead; the reason names the file and the problem.
The main session keeps every tool, so it can fix the file. The block is [recorded](#recorded-blocks) as `agent-gates`.

### The session's gates

At session start, the hook saves the gates in force, from config.json and `.aidrian.local.json` together, for that session.
A subagent's call must pass those gates as well as the current ones, so a change during the session can add a gate, never lift one.
Deleting, replacing, or moving config.json, `git stash`, and `git clean` lift no gate for a subagent until the session ends.

- The main session always reads the current config alone.
- To drop a gate, change the config and start a new session. A compaction keeps the session, and adds the gates then in force.
- The file is `$XDG_STATE_HOME/aidrian/sessions/<session id>.json`, with `<session id>.gated` beside it to mark that the session
  started with gates. The guard protects both as it protects the config files, and interpreter code may not name their folder.
  The end of the session deletes both.
- A snapshot that is there but cannot be read keeps subagents to reading, as a broken config does, until a new session starts.
  So does one that is gone while the marker is there, however it went.
- Without a snapshot or a marker, such as when the plugin was installed during the session, only the current config counts.

Each host tells the hook who is calling in its own way.

- Claude Code: [Agent gates](providers/claude-code.md#agent-gates).
- Codex: [Agent gates](providers/codex.md#agent-gates).
  Codex's [hook documentation](https://developers.openai.com/codex/hooks) lists no agent fields for a tool call,
  but the input schema built into Codex 0.165.0 has `agent_type` and `agent_id` as optional fields.

## Terms

When config.json `terms.file` names a [terms file](config.md#terms), the file-write hook checks the lines an Edit, Write,
or `apply_patch` adds against its rules: an Edit's new text without the lines it replaces, a Write's content without the
lines the file already has, and a patch's `+` lines.
A `block` hit refuses the write, naming each term and its replacement, and is [recorded](#recorded-blocks) as `terms`.
A `warn` hit lets the write run and gives the agent the same lines as additional context; Claude Code shows it to the agent.
The rule has no override: a term that is right in some file belongs in its rule's `exclude`.

## Markdown line length

After an Edit or Write of a `.md`, `.markdown`, or `.mdx` file in a project, the hook reads the whole file and names the lines
the write touched that are longer than `docs.wrapLimit`. The write already happened, so the agent fixes them with a follow-up edit.
Frontmatter, fenced and indented code, table rows, and a line whose overflow is one unbreakable token such as a URL are never reported.
`"docs": { "wrapLimit": 0 }` turns it off.

## Delivery check

When a subagent's last message presents a `.md` or `.json` path as delivered and that path exists nowhere, the stop hook
sends it back once with the missing paths: it writes them, corrects its report, or says it removed them on purpose.
Its second stop always ends. Each send-back is also an occurrence of an [automatic lesson](lessons.md#automatic-lessons)
for that agent type.
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
When the Human approves a plan (Claude Code's `ExitPlanMode`) and the main session has passed half of one limit,
another hook tells the agent to offer the same handoff before its first build step: `ask` asks, `auto` writes the brief.
The plan is on disk and nothing is running, so this is the cheapest moment for a fresh session.
It reads Claude Code transcripts only: a transcript with no Claude Code usage, or a payload without `stop_hook_active`, does nothing.

## Overrides

An override is for a human: set it in your own shell before you start the session.
Agents must never set one.

## Commit messages

`aidrian commit-msg --file <path>` checks a commit subject against Conventional Commits and the types in config.json `git.commits.types`.
A project runs it from its own `commit-msg` git hook, where git passes the message file:

```sh
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs commit-msg --file "$1"
```

`path/to/aidrian-harness/plugins/aidrian` stands for the plugin folder: `plugins/aidrian` in a clone of the plugin's repository,
or the folder the host installed: [Claude Code](providers/claude-code.md#running-aidrian), [Codex](providers/codex.md#running-aidrian).
