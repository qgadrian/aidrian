# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
How each host runs them: [Claude Code](providers/claude-code.md#hooks), [Codex](providers/codex.md#hooks),
[OpenCode](providers/opencode.md#hooks), which runs the session ledger alone, through a bridge plugin.

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
Two exceptions: the [merge guard](#merge-guard) refuses a merge whose pull request or head it cannot read,
as the review gate refuses a request whose pull request it cannot read, and the reason says how to name both;
and the [ready hold](#ready-hold), in a project that runs product feedback, refuses text fed to a shell that names a ready,
such as `echo 'gh pr ready 7' | bash`. Every other ready it cannot read, such as `gh pr ready "$PR"`, runs.
It also refuses a command that marks more than one pull request ready, since one deadline cannot check them all.
A git call a hook makes is stopped after 2 seconds and counts as git not answering; the hook's later git calls then do not wait.
A blocking hook exits 2 and tells the agent why on stderr.
The Bash rules, the main-checkout rule, the review-disposition rule, the terms rule, the GitHub MCP hook, the agent gates, the config guard,
the tracker write guard, and the question names check also record each block: see [Recorded blocks](#recorded-blocks).

| When | What runs | Host | Blocks |
| --- | --- | --- | --- |
| A session or subagent starts | The [start lines](#start-lines); in a main session the clear command started, the [handoff continuation](handoff.md#the-clear-route) the cleared session armed, as a banner and start context | Claude Code, Codex; the continuation Claude Code (verified on 2.1.325, [provider page](providers/claude-code.md#handoff-continuation)) | no |
| Before any tool call | The [agent gates](#agent-gates), when the project sets any | Claude Code, Codex | yes |
| A new turn starts: a prompt, a background agent's report, or a scheduled run | In the main session, the cancel of the `clear` [handoff continuation](handoff.md#the-clear-route) it armed, with one line, unless the prompt is the host's own clear or compact command, and one line naming the [background session](handoff.md#the-background-route) that owns the work when the session handed it off in the last 24 hours; then the [names reminder](config.md#names), when the last reply said "I" or "you" | Claude Code; the cancel Claude Code (verified on 2.1.325, [provider page](providers/claude-code.md#handoff-continuation)) | no |
| Before a Bash command | The [Bash rules](#bash-rules) | Claude Code, Codex | yes |
| After a Bash command | The [session ledger](#session-ledger): a row for each pull request the command created, pushed a branch of, or acted on; and the [check-run record](#check-runs): a row for each test run the command finished | Claude Code (verified by the hook test on a recorded result); Codex by payload fixture only ([not live](#session-ledger)); OpenCode the ledger and links only, no check-run record, by payload fixture only ([provider page](providers/opencode.md#hooks)) | no |
| Before a file edit | The [main-checkout rule](#main-checkout), when the project turns it on, then the [review-disposition rule](#review-dispositions), then the [terms rule](#terms) | Claude Code, Codex; the review-disposition rule judges no `apply_patch` | yes |
| Before `EnterWorktree` | In a subagent, a block: the tool would move the whole session into the worktree. In the main session, a block of entering an existing worktree (`path`): outside the repository's `.claude/worktrees/`, such as an `aidrian worktree new` worktree, the host asks the Human before that move whatever the permission rules say, and a session works in a linked worktree by absolute path instead | Claude Code | yes |
| Before `AskUserQuestion` | A block when a question or option says "I", "me", "my", "you", or "your" (or a form of them, such as "I'm" or "yourself") outside code and quotes: [Names](config.md#names) | Claude Code | yes |
| Before a GitHub MCP comment | The [review gate](config.md#review-gate), when the project turns it on, and the review-round rule | Claude Code, Codex (its [GitHub connector is not live](providers/codex.md#github-through-the-app-connector)) | yes |
| Before a GitHub MCP merge | The [merge guard](#merge-guard) | Claude Code, Codex (its [GitHub connector is not live](providers/codex.md#github-through-the-app-connector)) | yes |
| Before a GitHub MCP call that marks a draft ready | The [ready hold](#ready-hold), in a project that runs product feedback, then the [ready checks hold](#ready-checks) | Claude Code, Codex ([not live](#where-the-ready-hold-is-verified)) | yes |
| Before any MCP tool call | The [tracker write guard](config.md#tracker), when the project turns it on, on a tool in `tracker.writeTools`; and, whatever the working copy says, the [project run rule](config.md#project-run): a run session's tracker writes by its marks, and a tracker's merge or ready tool for every session | Claude Code, Codex ([not live](#where-the-tracker-guard-is-verified)) | yes |
| After any MCP tool call | The tracker write guard's record of the connected workspace, on a tool in `tracker.readTools`, and its note of a [tool neither list names](config.md#how-a-write-is-judged); and, whatever the working copy says, where the base branch allows project runs, the record of each issue's text a tracker's issue read answers, the only text a [project run](config.md#project-run) keeps, swept after a day | Claude Code, Codex ([not live](#where-the-tracker-guard-is-verified)) | no |
| Before an Agent tool call | The project's [model and effort](config.md#models) for that agent, and a subagent's background dispatch moved to the [foreground](#background-check) | Claude Code | no |
| After a Markdown write | The [line-length check](#markdown-line-length) | Claude Code | feedback |
| Before compaction | A checklist of what the summary must keep | Claude Code, Codex | no |
| The Human approves a plan | The [plan handoff offer](#session-length), when the main session already costs more per call | Claude Code | no |
| After an Agent tool call | A `dispatch` row in the [dispatch log](dispatch-log.md) | Claude Code | no |
| The main session ends a turn | The [result hold](config.md#project-run) of a project run's issue session that has not handed its result over, first, then the [announce check](#announced-work), the [review-loop check](#review-loop-check), the [merge hand-back check](#merge-hand-back-check), the [hand-back check](#hand-back-check), the [terminal hand-over](handoff.md#replacing-the-terminal) of a session whose background handoff asked to end itself, which skips the reminder, then the [session-length reminder](#session-length) | Claude Code; the result hold, announce, and hand-back checks also Codex ([not live](providers/codex.md#hooks)), the review-loop and merge hand-back checks Claude Code only; the hand-over not verified live ([provider page](providers/claude-code.md#replacing-the-terminal)) | once per stop, and each check once per turn ([send-backs](#send-backs-per-turn)); the reminder once, then at each doubling of the cost ratio (`ask`) or each step of it (`auto`) |
| A subagent stops | A `stop` row, then the [delivery check](#delivery-check), the [background check](#background-check), and the [evidence check](#check-runs) | Claude Code | once |
| A session ends | The main session's recorded issue reads for a [project run](config.md#project-run) removed. When the clear command ends a main session, its armed [handoff continuation](handoff.md#the-clear-route) made ready for the session the clear starts, bound to the host process; then a `session` row with its tokens, estimated cost, skills, draft pull requests, and review runs | Claude Code; the continuation Claude Code (verified on 2.1.325, [provider page](providers/claude-code.md#handoff-continuation)) | no |

The Bash rules run in the order of their table, in one process.
A file edit is an Edit, Write, or NotebookEdit call, or Codex's `apply_patch`.

## Start lines

Before anything else, in a main session whose own mark names a run and issue whose ledger gives it the confined
attempt it starts in, or whose pending mark starts it in that attempt's clone, and whose folder resolves inside that clone, the hook hands the host the environment that attempt's sandboxed commands get,
the package managers' caches in its `cache` folder, on a host that takes it: Claude Code, through the file it names in
`CLAUDE_ENV_FILE` ([Dependency installs](providers/claude-code.md#dependency-installs)). On a host that declares
`forgeTokenEnv`, as Claude Code does, it then hands over the forge token as `GH_TOKEN` the same way, only to a session
whose environment holds the claim the start gave the session it launched, read again outside the sandbox from the one
source the start checked, and only the token the start checked, by its SHA-256, with git's command-scope config that
makes git take it from gh's own credential helper alone, for the forge's host only
([Project start](providers/claude-code.md#project-start)). It records in the attempt's folder whether it handed the
token over, which the start's proof check reads. It prints nothing for either, but a line saying why the token was not
handed over.

At the start of every session and subagent, the hook prints:

- one line naming the `always` knowledge docs and the commands that find the rest;
- one line with the [names](config.md#names) for the human and the AI;
- one `Voice:` line: say so, with the reason, when a request or premise looks wrong, then follow the human's call;
  ask the human questions they can answer without the session's context, one decision each, recommendation first;
  and in anything a person reads, replies, questions, summaries, and pull request and issue bodies, name each thing in
  plain words, such as its title, never by a bare internal id, such as a finding or slice number, or a file-name
  suffix such as `-2`, with a path or link only as a location;
- in Claude Code, one `Pull requests:` line: a body here never carries the "Generated with [Claude Code]" line, and this
  project rule takes precedence over the host's attribution instructions, which ask for it. It is left out when Claude
  Code's own settings drop the line: the `attribution.pr` of the first of `.claude/settings.local.json`,
  `.claude/settings.json`, and the user's `settings.json` that sets it holds no such line, or, with none set,
  `includeCoAuthoredBy` is `false`. `{ "attribution": { "pr": "" } }` in `.claude/settings.json` settles it for a project;
- one `Commands:` line when the first `aidrian` on the PATH is another copy of the plugin, such as an installed
  release while a branch is tried: it names this copy's `aidrian` by its path, so the session runs the code it loaded;
- in the main session only, one `Format:` line: headers, quotes, and a few emoji in chat replies, never in commits,
  pull requests, docs, or code, which a subagent's report feeds, so a subagent does not get it;
- in the main session only, while [`session.handoff.mode`](handoff.md#the-reminder) is `"auto"`, one `Handoff:` line:
  the session never asks the Human whether to hand off or keep going; it judges by itself and runs the
  `session-handoff` skill when a handoff is worth it. `"ask"` and `"off"` print nothing;
- in the main session only, on a host that can [replace the terminal](handoff.md#replacing-the-terminal), while this
  machine's `handoff.background` is `"on"`, one `Handoff terminal:` line at most, the first of these that applies:
  1. A shell startup file holds a block of the shell function that is not the current one: the line names every such
     file, and the `aidrian shell-init <shell> --install` command that replaces its block, for the Human to run. Any
     session gets it, one the function started or a background one too.
  2. config.json resolves `session.handoff` to the background route in `"auto"` mode, and a session a Human attends was
     not started by the shell function, while a startup file holds the current block: the session was started past the
     function, such as by a launcher, an editor command, or a terminal opened before the install, so its terminal will not
     switch at a background handoff. The line says a new terminal settles the last, and names
     `aidrian shell-init <shell> --install --wrap <launcher>`, for the shell whose file holds the block, for a launcher
     on PATH that ends in `exec claude`. It adds that an older copy of the plugin refuses `--wrap` as an unknown
     option, so the plugin is updated first, with the host's update command.
  3. The same session, with no block installed: after a background handoff its terminal stays on the old session, and
     the line names `aidrian shell-init zsh --install`, or bash's, for the Human to run once, after updating an older
     copy of the plugin, which answers `unknown command: shell-init`, with the host's update command
     (`claude plugin update aidrian@aidrian-harness`).

  It reads the two startup files and no process. A file it cannot read counts as holding no block;
- in the main session only, one more line while the [lesson inbox](lessons.md#session-start) holds open lessons;
- in the main session only, one `Decisions to review: N (oldest X days)` line while the indexed docs hold unconfirmed
  [decision markers](project-folder.md#decision-markers), unless [`decisions.unreviewed.remind`](config.md#decisions) is `"off"`.
  A doc it cannot read counts for nothing here, and never stops the hook. The line names the `decision-review` skill.
- in the main session only, one `Tracker guard:` line while the guard is on and the host this session runs on reaches a known server of
  the tracker that `tracker.writeTools` leaves out, so a write through it passes unchecked. `aidrian check` says the fix.
- in the main session only, one more line while the persona audits in the state folder hold untriaged items
  ([Triage](personas.md#triage)): `Audit inbox: N untriaged findings in M reports. The persona-audit-triage skill triages them.`
  Nothing prints when every item has a decision, or when the audits folder, a report, or `triage.json` cannot be read.

Last, in the main session only and while `git.mainCheckout.guard` is on ([commit guard](#commit-guard)),
a line when the session inherited the commit guard's override, then up to three lines about the main checkout,
wherever the session started, with `<db>` the `git.defaultBranch`:

| Prints when | Line |
| --- | --- |
| The session's environment has `AIDRIAN_ALLOW_MAIN_COMMIT=1` | `AIDRIAN_ALLOW_MAIN_COMMIT is set in this session, so the commit guard lets every commit through. Tell the Human: restart the session without it, and use it per command in their own terminal.` |
| Local `<db>` has commits that `origin/<db>` does not | `Local <db> has N commit(s) not on origin/<db>; only worktrees commit here. Inspect: git log origin/<db>..<db>` |
| The main checkout is on another branch | `The main checkout is on <branch>, not <db>; only worktrees change branch. Switch back: git switch <db>` |
| The main checkout's HEAD is detached | `The main checkout's HEAD is detached, not on <db>. Switch back: git switch <db>` |
| The main checkout has changed tracked files, staged or not | `The main checkout has changed tracked files; task work belongs in a worktree. Inspect: git status` |

They compare local refs only, with no fetch, so a stale `origin/<db>` can count commits that are already pushed.
An untracked file alone prints nothing. Each line is one git call: a missing `origin/<db>` or a failing git drops
that line alone, and a git that hangs past the timeout drops its own line and the ones after it.

## Where the tracker guard is verified

Hook payloads pass through `lib/hosts/` first, so the guard reads every tool as `mcp__<server>__<tool>`.

| On | Live | Not live |
| --- | --- | --- |
| Claude Code | The `PostToolUse` payload of a real `get_workspace` call on 2.1.318, kept as `test/fixtures/hosts/claude-code/tracker.json` | The payload of a write, which the same fixture builds from the documented shape |
| OpenCode | Nothing: no tracker hook runs there, since the bridge forwards no MCP tool call | Every tracker write, which passes unchecked; while `tracker.enabled` is true, `aidrian check` says so where OpenCode is set up ([OpenCode](providers/opencode.md#limits)) |
| Codex | On 0.166.0, `codex exec --json` called `linear.get_workspace` through the Linear app, with server `codex_apps`, and returned the `url` the guard reads | Any hook on Codex: no session has run the guard with a person's trust. The names and payload come from the source and `test/fixtures/hosts/codex/tracker.json` |

What the Codex source says, at `rust-v0.166.0`:

- An app connector's tool runs through the same MCP handler as a server's, and its `PreToolUse` and `PostToolUse` hooks fire on it:
  `codex-rs/core/src/tools/registry.rs` and `handlers/mcp.rs`.
- Its hook name is `mcp__codex_apps__<connector>__<tool>`, as `hook_tool_name` joins it.
  The model sees one underscore in the same place, such as `mcp__codex_apps__linear_get_workspace`, and a refusal names that form.
  The Codex adapter takes either, and gives the standard `mcp__codex_apps_linear__get_workspace`, so each connector counts as its own server.
  `raw_tool_name` keeps what Codex sent, and a project's pattern may name either.
- Every character outside `[A-Za-z0-9_]` in a tool's name becomes `_`, so the server `linear-server` reaches a hook as `mcp__linear_server__<tool>`:
  `codex-rs/codex-mcp/src/mcp/mod.rs`.
- A hook runs only when its entry holds a `trusted_hash` and `enabled` is not false: `codex-rs/hooks/src/engine/discovery.rs`.
- Exit 2 with a reason on stderr blocks the call: `codex-rs/hooks/src/events/pre_tool_use.rs`. A call that fails fires no `PostToolUse`, as on Claude Code.

The tests run those payloads through the real hooks, but they are not live.
[The Codex page](providers/codex.md#prove-the-tracker-guard) has the one step a person takes to prove it, and what to look for.
A hook on Codex runs only after that person's trust, so while `tracker.enabled` is true,
`aidrian check` warns when Codex has the plugin and no trust on record for both tracker hooks, or has either of them turned off.
A session that reaches a known server the key leaves out hears it at the start.

## Turning hooks off

| Hook | Off with |
| --- | --- |
| Agent gates | Off unless config.json or `.aidrian.local.json` sets `agents` |
| Main-checkout rule | Off unless config.json sets `"git": { "mainCheckout": { "guard": true } }` |
| [Commit guard](#commit-guard), and its [start lines](#start-lines) | Off unless config.json sets `"git": { "mainCheckout": { "guard": true } }`, the main-checkout rule's switch |
| Markdown line length | `"docs": { "wrapLimit": 0 }` |
| Pull request body sections | `"github": { "requiredSections": [] }`; the footer and `--fill` checks stay |
| Pull request contract | Off unless config.json sets `github.pullRequest`, but for `"sharedTempBodyFile": false` |
| Public text | Off unless config.json lists `github.publicText.patterns`, or `.banned-terms.local` gives a pattern |
| Review gate | Off unless config.json sets `"github": { "reviewGate": { "enabled": true } }` |
| Terms rule | Off unless config.json sets `"terms": { "file": "…" }` |
| [Tracker write guard](config.md#tracker) | Off unless config.json sets `"tracker": { "enabled": true }`, with the keys that key needs |
| [Review-loop check](#review-loop-check) | `"github": { "reviewLoop": "ask" }` |
| Session-length reminder and plan handoff offer | `"session": { "handoff": { "mode": "off" } }` |
| [Handoff continuation](handoff.md#continue), and its session start, new turn, and session end steps | No config turns the steps off: on a host with a route they run, and act only on a continuation the gate armed. The gate arms one only for `session.handoff.continue`, such as `"session": { "handoff": { "continue": "clear" } }`, or the `session-handoff` skill's `--continue`; with `"none"`, the default, and no `--continue`, nothing is armed |
| Dispatch log rows | `"telemetry": { "enabled": false }`, in config.json or `.aidrian.local.json`; the delivery and background checks still run |
| `hook_deny` rows alone | `"telemetry": { "hookDenies": false }`; the rules still block |
| Automatic lessons from the stop hook and the blocking rules | `"lessons": { "auto": false }` |
| A Bash rule, once | Its override variable, set by a person: [Overrides](#overrides) |

The knowledge, names, and lessons start lines and the [announce check](#announced-work) have no switch; they act only inside a project folder.
The [review-loop check](#review-loop-check) has no switch of its own: it follows `github.reviewLoop`.
The [merge hand-back check](#merge-hand-back-check) has no switch: it acts only on a refusal the gate printed in the turn.
The main-checkout start lines follow the commit guard, so they are off with it.
[config.md](config.md#telemetry) lists the other `telemetry` keys.
The Agent hook changes only what config.json or `.aidrian.local.json` sets in `models.claude`.
The compaction checklist steps aside whenever instructions are typed after `/compact`.

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | Skipping or turning off git hooks, and setting `AIDRIAN_ALLOW_MAIN_COMMIT`, the [commit guard](#commit-guard)'s override | none |
| Git amend | `git commit --amend`; the deny names a follow-up commit, which a squash merge folds in, and `aidrian lint` fails a skill or agent that asks for an amend | `AIDRIAN_ALLOW_GIT_AMEND=1` |
| Kill by name | Killing processes by name | `AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1` |
| Command-line listing | Listing the command lines of other processes | `AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1` |
| Shell startup file | `aidrian shell-init <shell> --install` or `--uninstall` from any agent, the main session's included, with `--wrap` or without: both write the Human's `~/.zshrc` or `~/.bashrc` ([Replacing the terminal](handoff.md#replacing-the-terminal)). It reads the command in a substitution, `sh -c`, `eval`, a heredoc or pipe fed to a shell, and carried by `xargs`, `find -exec`, `watch`, `script`, `parallel`, `arch`, or a shell the walk does not read, such as `fish -c`. Out of sight: a flag behind a variable, a script file or an interpreter (`python -c`, `node -e`) that runs it, and a shell alias or function that hides it | none: the deny says to hand the Human the command with the `!` prefix |
| Counting grep in `&&` | A `grep -c` whose exit status an `&&` chain reads | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Dependency link | An `ln` of a `node_modules` or `.venv` folder: a package manager run in the copy installs through the link and changes the original's packages. The deny sends the agent to install in its own task worktree, where `aidrian worktree new` already runs the project's bootstrap. For a worktree under review it names no install and no command: the reviewer installs nothing, there or in a copy, reviews read-only or reports that the run needs the pull request's own task worktree, and leaves that run to its owner. A pull request controls its tree, its bootstrap, and its package manager's hooks, so any install there runs its code | `AIDRIAN_ALLOW_DEPENDENCY_LINK=1` |
| Pull request body | A pull request body without the required sections, or with the footer; the [contract](config.md#pull-request-contract); a `## Tests run` line that says a test command passed with no [finished run](#check-runs) to show it | `AIDRIAN_ALLOW_PR_BODY=1` |
| Public text, when turned on | An issue, pull request, or comment whose text matches [`github.publicText.patterns` or `.banned-terms.local`](config.md#public-text), or that the rule cannot read | `AIDRIAN_ALLOW_PUBLIC_TEXT=1` |
| Attribution, when turned on | An agent's commit or new pull request without the [attribution](config.md#attribution) lines | `AIDRIAN_ALLOW_UNATTRIBUTED=1` |
| Review gate, when turned on | Asking the review bot before a review is on record ([config.md](config.md#review-gate)) | `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1` |
| Review rounds, when a review bot is set | Setting `AIDRIAN_ALLOW_EXTRA_ROUNDS`, and asking the bot for a review outside `aidrian pr`, which counts rounds first ([config.md](config.md#review-gate)) | none: on the Human's answer or typed grant, the exact raise runs ([review.md](review.md#unattended-rulings)) |
| Review sign-off | `aidrian pr signoff`, `--last` included, which records the Human's sign-off of a flow under their name ([review.md](review.md#sign-off-by-the-human)) | none: the Human runs it in their own shell |
| Decision answer | `aidrian decisions set` or `undo` from a subagent, which carry out the Human's answer on a decision ([Decision markers](project-folder.md#decision-markers)) | none: the main session runs them on the Human's word |
| Project run start | `aidrian project init` from a subagent, which would make it the driver of a [project run](config.md#project-run) | none: the main session runs it |
| Extra round approval | `aidrian pr extend <PR> --human approve` without the Human's answer in the session ([review.md](review.md#extra-rounds)) | none: the Human answers, or runs it in their own shell |
| Round limit delegation | `aidrian pr delegate <PR>` without the Human's own answer to the merge guard's round-limit question in the session that leaves the ship decision to the session, and from a subagent ([Merge guard](#merge-guard)). Verified on Claude Code 2.1.295 to 2.1.328 in the terminal; in the desktop app, and on Codex, whose transcript the rule cannot read, the Human runs it | none: the Human answers, or runs it in their own shell |
| Quota fallback choice | `aidrian pr review <PR> --quota-fallback` without the Human's pick in the session ([review.md](review.md#out-of-quota)) | none: the Human answers, or runs it in their own shell |
| Product feedback answer | `--by human` on a [product feedback](config.md#product-feedback) item without the Human's answer in the session | none: the Human answers, or runs it in their own shell |
| Product feedback post | `aidrian pr product-feedback post` on a pull request from outside the team without the Human's answer in the session, and from a subagent | none: the Human answers, or runs `post` in their own shell |
| Ready hold, in a project that runs product feedback | Marking a draft ready while its [product feedback](config.md#product-feedback) is owed ([Ready hold](#ready-hold)) | `AIDRIAN_ALLOW_UNHELD_READY=1`, set by a person in their own shell before the session |
| Ready checks | Marking a draft ready while a check on its head has not finished, or before a check its last edit re-queues has shown, and editing a title or body in the same call as a ready ([Ready checks](#ready-checks)) | `AIDRIAN_ALLOW_UNHELD_READY=1`, the ready hold's, set the same way |
| Merge guard | Merging a pull request while a review it owes is open, or the review of its head has not finished ([Merge guard](#merge-guard)) | none: the Human answers the guard's question, "Merge anyway" or, at the round cap, "Merge with the findings filed", or merges in their own shell; at the round cap with every open finding low, the Human's answer that the session decides, recorded with `aidrian pr delegate`; under `github.unattendedWaiver`, a verdict recorded with `aidrian pr waive` |
| Push first, when turned on | A full test suite while the branch holds a commit older than `testing.pushFirstMinutes` that its remote copy lacks ([Push first](#push-first)) | `AIDRIAN_ALLOW_FULL_SUITE=1` |
| Main checkout, when turned on | A shell write to a tracked file in the main checkout; a git call there that makes a commit or moves the branch; after a `cd` it cannot trust, a relative write or a git call that may change the main checkout; and a relative write that lands there only if a `cd` inside it fails ([After a cd](#after-a-cd)) | `AIDRIAN_ALLOW_MAIN_WRITE=1` |

What each rule matches:

- Git hook bypass: `--no-verify` on commit, push, or merge; `-n` on commit; `HUSKY=0`;
  core.hooksPath set in any letter case through `-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_KEY_<n>`;
  `git config` writing or unsetting core.hooksPath;
  and any command that sets `AIDRIAN_ALLOW_MAIN_COMMIT`, inline (`VAR=1 cmd`), through `env`, or with `export`, `declare`,
  `typeset`, `local`, or `readonly`. The name in a quoted argument or a comment passes, and so does `env -u`.
  This rule reads `sh -c` bodies and heredocs or here-strings fed to a shell, as well as command substitutions.
- Kill by name: `pkill`, `killall`, `pgrep --signal`, `kill` fed by `pgrep` or `ps`, and `kill -- -1`. `kill <pid>` stays allowed.
  The deny of a plain `pkill` or `killall` names the `pgrep` that lists what it would stop, such as `pgrep -f 'next dev'`.
- Command-line listing: `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, `cmd`, and `comm`.
  On macOS `comm` is the full executable path, and for a process that sets its own title that title, arguments and all;
  `ucomm`, the accounting name, is neither. On Linux `ucomm` and `pgrep -l` show the task name,
  which a process can set itself, at most 15 bytes.
  A listing on the command line itself, or in a substitution of it, whose output reaches only `/dev/null` or a counter
  (`wc`, `grep -c`, `grep -q`) runs: `ps -p <pid> >/dev/null` and `ps aux | grep -c x` print no command line.
  Between the listing and the counter only `grep`, `head`, `tail`, `sort`, `uniq`, and `cut` may stand, with no operand
  but grep's pattern, no long option, no `sort -o`, and no word that may expand, an option value included.
  Inside `sh -c`, `eval`, `env -S`, or xargs a listing never passes.
  The deny starts with the command to run instead, the whole line with each listing replaced:
  `pgrep -fl x` and `ps aux | grep x` become `pgrep -d, -f x | xargs -r ps -o pid=,ppid=,etime=,ucomm= -p`,
  and a `ps` format trades `args`, `command`, `cmd`, and `comm` for `ucomm`.
- Counting grep in `&&`: such as `grep -c x log && npm test`. The deny starts with the line to run instead,
  each such count wrapped as `{ grep -c x log || true; }`, which keeps the count and the chain.
- Neither rule rewrites a segment that starts with a shell word (`if`, `while`, `!`), opens or closes a group or a `case`
  arm, or sits in a substitution whose text occurs twice in the line: that deny names the fixes in general.
- Pull request body: `gh pr create` or `gh pr edit` with a body that lacks a config.json `github.requiredSections` heading,
  or that carries the "Generated with [Claude Code]" footer; `gh pr create --fill`;
  and, when sections are configured, a non-web `gh pr create` with no `--body` or `--body-file`.
  With `github.pullRequest` set, also the title, the closed list of sections, the deferral and residual items,
  a body file in a shared temp folder, and a body identical to another open pull request's.
  These rules and the attribution rule's pull request lines follow the repository the call targets.
  The project is the one found from the folder gh runs in: `env -C`, or a `cd` when every link from it to gh is `&&` in the
  same shell (`cd /other && gh …`, `x; cd /other && gh …`). Anything else leaves the session's project: a `;`, newline, `||`,
  pipe, `&`, `!`, or subshell boundary after the `cd`, a `cd` that may not move the shell gh runs in (after `||` or in a pipe,
  negated, in a subshell, or under a wrapper such as `env`), and a folder the rule cannot read (`cd "$WT"`).
  So gh on a new line after `cd /other && cat > b.md <<'EOF'` answers to the session's rules, since a failed `cd` would leave
  it in the session's folder. To be judged by the other project, join gh on the heredoc's first line
  (`cd /other && cat > b.md <<'EOF' && gh pr edit 1 --body-file b.md`, then the body) or use `env -C /other gh …`.
  Naming the repository with `-R` gets none of these rules, as the next lines say.
  A call that names a repository other than that checkout's remotes, through `-R`, a pull request URL, or `GH_REPO`,
  gets none of these rules: that repository's config cannot be found from there, so its rules go unchecked.
  A `-R` that names a remote of the checkout, a fork's parent included, keeps them; so does a value the rule cannot read
  (`-R "$REPO"`), a checkout with no remote to compare, and a `GH_REPO` exported earlier on the same command line.
  A body file the same command writes first is read as that command writes it: `cat > file` or `tee file` fed a quoted
  heredoc, or a `cp` of a file the rule reads, also through a variable the line sets to a literal path (`F=…; cat > "$F"`).
  `--body-file -` reads the heredoc fed to gh. The rule fails closed where the shell could change what it read:
  a heredoc beside a `< file` or `<<< word` input, or fed to a descriptor other than 0 (`3<<EOF`); a `cat` write
  through a descriptor other than 1 (`cat 2> b.md`) or with standard output duplicated off it (`>&2`), while `2>&1`
  writes no file; a `tee` whose own output lands on its file; a body file a
  redirect writes, gh's own output on any descriptor included (`-F b.md {fd}>b.md`); any
  command between the write and gh that is not a known reader (such as `sed -i`, a script, or a program fed code on
  stdin); and a variable a nested shell or substitution assigns, or one used inside it. Such a body is one the rule
  cannot read: gh then runs as its own command after it.
  The deny for a body it cannot read names the one cause that applies, never the whole list: a `--body` the shell builds,
  a body file path it cannot resolve, `--body-file -` with no heredoc, a relative path after a directory change, a file
  that does not exist yet, is not a regular file, or is one the hook cannot open, a redirect on gh onto its own body file, or another command on the
  line that changes the file first, whose deny says to run that command first, then gh as its own command.
  Only an unquoted number or `{name}` right against `<` or `>` names a descriptor: a quoted `--body '2'> /dev/null` is the
  body `2`, as bash passes it, and the rule checks it.
  A deny about where the body comes from states the cause first, then the two steps that pass: write the body to the one
  path the `pr-write` skill writes, `<state>/tmp/pr-body-<branch>.md`, written out for the project and the branch, then
  run `gh pr create --body-file` with that path. The footer deny says this project's rule takes precedence over the host's
  attribution instructions, that the `attribution.pullRequest` lines replace it when set, and that Claude Code's
  `attribution.pr` setting set to `""` stops the host from asking. The [start lines](#start-lines) say the same up front.
- Public text: with a pattern from config.json `github.publicText.patterns` or the git-ignored `.banned-terms.local`,
  `gh issue create|edit|comment|close|reopen` and `gh pr create|edit|comment|close|reopen|merge` whose text matches a pattern:
  `--body` or `--body-file`, `--title`, the `--comment` of a close or a reopen, and the `--subject` of a merge.
  Each run of whitespace counts as one space, so a phrase wrapped across lines matches. GitHub keeps the old text in a public edit history that no API deletes, so this stops it before the first post.
  The body is read as the pull request body rule reads it, heredoc and `--body-file -` included, and a call that names another repository
  answers to the target repository for the config patterns and for text it cannot read. Private words hold for every call.
  The deny for a config pattern names the pattern, cut at 80 characters, never the text around the match, and says to rewrite the text as the rule or limit,
  keep the detail in the state folder, and that an edit does not remove what was already posted.
  A hit from `.banned-terms.local` is denied without the word, the pattern, or the text around it, here and in the recorded row:
  the deny says a private word from that file matched in the body, the title, the closing comment, or the merge subject,
  then names the line of the first hit, says to reword it, and says not to open the file.
  The rule runs before the pull request body rule, whose title deny quotes the title.
  The rule reads the file from the project root and from the main checkout, and uses both when both exist, as `scripts/banned-terms.mjs` does:
  git does not copy an ignored file, so a linked worktree normally has none. It reads a copy only when it is a regular file of
  modest size, so a link to one works; a copy it cannot read drops only itself. A line that does not compile drops only itself in the hook,
  and `aidrian check` names its line number, and fails on a copy git does not ignore, never printing what the file holds.
  The patterns of one command share a time budget, and one that runs out is dropped, as a bad line is.
  Private words are checked on every call of the command before any config pattern runs, so config patterns never use up their time.
  A rule of this hook that fails lets the command through that rule only; the later rules still run.
  A body or title the rule cannot read is refused, with the two steps that pass for a body, and that includes a device or a pipe given as the body file.
  The deny names the same one cause as the pull request body and attribution rules, from one read of the same reader (`bodyRead`), since this rule runs first:
  a script or `sed -i` that edits the body file on the gh line gets the step that passes, gh as its own command after it.
  A call with no body flag whose text would come
  from an editor, a prompt, a template, or the commit messages is refused too. `--fill` with no `--title` is refused the same way.
  `--web`, `--dry-run`, `--help`, `--delete-last`, and an edit, close, reopen, or merge with no text flag pass.
  With no pattern from either, the default, the rule refuses nothing: it reads only the config and looks for the file, which runs git once,
  and it looks up no remotes and reads no body. It never asks whether the repository is public: a project opting in is the signal.
  A pattern catches only obvious wording. It is no substitute for writing rules only: text that avoids the listed words passes.
  A dynamic body reads only a heredoc in the gh call's own words, never another command's on the same line.
  The rule reads only these commands: `gh api`, `gh pr review`, gh run through `xargs`, and the GitHub MCP tools are not checked,
  and neither is the alt text of an `--attach` file. A comment with attachments and no body flag is refused as having no body.
  The pull request body rule has no MCP counterpart in the GitHub MCP hook either, so a post through an MCP tool goes unread by both.
- Attribution: an agent's `git commit` whose message's last paragraph and `--trailer` options lack a configured trailer;
  and a `gh pr create` body without the configured `Authored-with:` and `Assisted-by:` lines.
  A body it cannot read is refused with the one cause the pull request body rule's reader names from one read (`bodyRead`).
- Review gate: `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose body
  asks `@codex review`; `gh pr create --reviewer` and `gh pr edit --add-reviewer` naming `github.reviewer`. It gates a
  request to any repository this checkout's remotes name, not origin's alone, against a review of that same repository,
  as it does `aidrian pr await-review --request --repo <owner>/<name>` ([config.md](config.md#review-gate)).
- Review sign-off: `aidrian pr signoff`, with `--overrule`, `--accept`, and `--last` too, also as `node …/cli.mjs` or `node …/bin/aidrian`,
  and inside a substitution, `sh -c`, `eval`, or a heredoc or pipe fed to a shell. In a Claude Code session the
  Human runs it with `!`; if a host routes `!` through the hooks too, the Human runs it from another terminal.
  A sign-off with `--check` among its words runs: it is the dry run, which runs every refusal and records nothing,
  so a session can try a command before it hands it to the Human. A pipe into a shell that names a sign-off stays
  blocked, `--check` or not, since the rule cannot read it. Only a plain `--check` counts: one the shell builds at run
  time, such as `` `printf …`--check ``, is no dry run. An `aidrian` whose subcommand the shell builds at run time,
  such as `aidrian "$@"`, is denied too, and so is a program the shell builds (`$x pr signoff`,
  `"$(command -v aidrian)" pr signoff`) and a call only text names: `xargs`, `parallel`, `npx`, an interpreter's code,
  or a variable or alias whose words hold `aidrian … pr signoff`, as the product-feedback rule reads its own (its
  `textDenial`). A `--check` in such text is no dry run. A command that only handles text, such as `echo`, `grep`, or
  `git commit -m`, still runs. A subagent and a session no Human attends are refused these shapes outside a project too.
  When the session holds answers and none approves the call, the deny names the nearest miss: a word the shell builds,
  no question naming `<owner>/<name>#<PR>`, the head, or the `<flow>/<invariant>` written as one word, an answer that
  is not "Approve", or a checkout whose remotes need `--repo`. A subagent is told to return `status: needs_input` with
  the sign-off question and the command for its dispatcher, which has the answer route. The rule's message stops the session; at `human_required` naming one flow,
  once `--last --check` exits 0, it hands the Human the short form, `aidrian pr signoff <PR> --last`, short enough to
  type from a phone, which refuses any other stop. A long form runs on the Human's AskUserQuestion answer naming
  `<owner>/<name>#<PR>` of the repository it acts on ([review.md](review.md#answering-in-the-session)): its `--repo`,
  one of this checkout's remotes, else the one repository the remotes name; a checkout whose remotes name more than one
  needs the `--repo`. The rule reads no forge to learn it. A subagent's sign-off, one from a session no Human
  attends (its unattended mark), and one from a project run's driver are refused with no answer route, since a flow
  sign-off also writes the [sign-off store](review.md#merge-trust); the dry run still runs.
- Decision answer: `aidrian decisions set` and `aidrian decisions undo`, also as `node …/cli.mjs` or `node …/bin/aidrian`,
  and in `sh -c`, `eval`, or a heredoc fed to a shell,
  in a call with an `agent_id`. The main session has none, so it stays allowed. A subagent on a host that sends no `agent_id` passes too.
  The rule stops accidents and is no security boundary: a form it does not read, such as `xargs` or `npx`, runs.
- Project run start: `aidrian project init`, read the same way as the decision answer, in a call with an `agent_id`. The same limit holds.
- Extra round approval: `aidrian pr extend <PR> --human approve`, also as `node …/cli.mjs` or `--human=approve`, while the
  pull request's check at the cap waits for the Human. It runs when the session transcript holds an AskUserQuestion
  answer, given after the judge's verdict, to a question naming `<owner>/<name>#<PR>` of the repository the call acts on
  (`#<PR>` alone in a checkout with no remote) and the round it grants, `round <N>`, whose chosen option starts with
  "Approve". That repository is the call's `--repo`, one of this checkout's remotes, else the one repository the remotes
  name; with several, a call without `--repo` is refused, and the record read is that repository's. `--human deny` and `--verdict` run. With no check waiting for the Human in this
  machine's review record, as when the record came from another machine, the approval is refused.
  Each call in a chain is judged against its own pull request, and the deny names every call it refuses. A deny says
  why the transcript's answers miss: none after the verdict, none naming `<owner>/<name>#<PR>` or `round <N>`, or the label picked.
  While the check waits for the judge, the deny names the judge's route: run the `dispatch` the review step prints and record
  its verdict with `aidrian pr extend <PR> --verdict`. After a judge's stop, nothing waits for an answer, so the deny names the
  route to one more round instead: `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review <PR> --max-rounds <N>`, on the Human's
  answer or on their typed `grant up to <N> review rounds on <owner>/<name>#<PR>` ([review.md](review.md#unattended-rulings)),
  naming `--repo <owner>/<name>` in a checkout whose remotes name more than one repository, as the review step's printed rerun does.
  An answer the rule cannot read, such as `--human "$X"`, counts as approve; a pull request it cannot read is refused.
- Round limit delegation: `aidrian pr delegate <PR>`, also as `node …/cli.mjs`, in a substitution, `sh -c`, `eval`, or a
  heredoc fed to a shell. It runs when this machine's review record of the repository the call acts on holds a review
  stopped at its round limit (`extension_check` or `round_limit`, nothing owed), and the session transcript holds an
  AskUserQuestion answer, given at or after that outcome, to the merge guard's round-limit question: its very text, which
  the guard and the rule build from the outcome's head and the open count, offered with exactly its two options. The
  latest such answer decides. One that starts with either option is that option: "Merge with the findings filed" (or
  "Merge anyway") the merge guard takes by itself, with nothing to record, and "Grant more review rounds" means do not
  merge, even with "your call how many" after it. Otherwise the answer must be the Human's own words and leave the
  decision to the session: the whole answer, with case, spaces, and a closing `.` or `!` aside, is one of a fixed
  English list, such as "whatever you recommend best", "you decide", "up to you", or "your call". A word before or after
  the phrase, such as a condition ("if CI is green"), a lean ("I would rather grant more rounds"), "stop.", or a quote
  mark, refuses it. The answer must also be one the host's adapter reads as the Human's own in the terminal
  (`humanAnswer` in `lib/hosts/`, [Adding a host](providers/adding-a-host.md#the-adapters-fields)): on Claude Code, not a
  sidechain, the `cli` entrypoint, and a permission decision whose source is `user_temporary`, as every AskUserQuestion
  answer carries on Claude Code 2.1.295 to 2.1.328 ([Answers the Human gave](providers/claude-code.md#answers-the-human-gave));
  an answer the desktop app, an SDK app, or a hook gave is refused, and so is every answer on a host whose adapter reads none.
  The rule binds to the record's head, never to the call's `--head`. A deny names the nearest miss and never quotes the
  Human's answer. A subagent's call (one with an `agent_id`) is refused: the Human answered the main session. With no
  review stopped at its round limit in this machine's record, as when another machine ran the review, the Human runs the
  command in their own shell. A pull request number or subcommand the shell builds at run time, a shell fed text the
  rule cannot read that names the command, and a program that runs its words as a command and names it are refused:
  `xargs`, `find -exec`, `watch`, `script`, `parallel`, `arch`, `npx`, `bunx`, `npm exec` (also after the manager's
  options and their values, as `npm --yes exec` and `npm -w a -w b exec`), `pnpm dlx`, `yarn dlx`, `bun x`, inline code
  (`node -e` or `-pe`, `python3 -c`, `perl -e`, `ruby -e`, a versioned name such as `perl5.34` included, the same table the
  [agent gates](#agent-gates) guard of config files reads, and `deno eval`), and a program name the shell builds, such as `$A` or `"$(command -v aidrian)"`. So is such a
  program that leaves aidrian's `pr` subcommand for itself to fill in: `xargs aidrian pr`, which adds its input, a
  `{}` it replaces (`find -exec aidrian pr {}`), or xargs's replace string (`xargs -I S aidrian pr S`). The repository is the call's `--repo`, one of this checkout's remotes, else the one repository the remotes
  name, as for the extra round approval.
- Quota fallback choice: `aidrian pr review <PR> --quota-fallback agent:<name>` or `--quota-fallback human`, also as
  `node …/cli.mjs` or `--quota-fallback=<value>`. It runs when this machine's review record of the repository the call
  acts on holds a quota stop and the session transcript holds an AskUserQuestion answer, given after that stop, to a
  question naming `<owner>/<name>#<PR>` of that repository (`#<PR>` alone in a checkout with no remote) and the quota,
  that picks that exact value: an option starting "Run a critic agent" authorizes `agent:critic` only; any other agent
  needs an answer that names it, "Run a <name> agent" or `agent:<name>`; and `human` needs "The Human reviews it".
  That repository is the call's `--repo`, one of this checkout's remotes, else the one repository the remotes name;
  where they name several, a call with no `--repo` is refused, and no other repository's record of the number counts.
  A value or a pull request the rule cannot read is refused.
- Product feedback answer: on only where the state folder holds `product-feedback/`, save two cases that also reach a project
  without the feature, as [With the key off](config.md#with-the-key-off) says. One is a call whose folder or project it cannot
  read (below); the other it judges anywhere: a command that also runs `record`, or an aidrian call whose subcommand it cannot
  read, such as `aidrian $X && aidrian $Y`, beside a call that claims a human or that it cannot read (below).
  It reads `aidrian pr product-feedback answer` with `--by human`, `--by=human`, or a word it cannot read, also as a
  runner, such as `node`, given `…/cli.mjs` among its arguments, and `aidrian audits record` with the same, on a key a
  [feedback record](config.md#product-feedback) lists, before and after its answer. A call with an `agent_id` is refused, whatever key
  it names. A main session passes only when the transcript holds an AskUserQuestion answer, given after the record was written,
  to a question naming `#<PR>`, not after a `/` or a word character, the item's id, and its title in double quotes, and no other item,
  whose chosen option is that decision alone: `fix-now` also reads as "Fix now", and "Drop nothing, keep it open" is no drop. A note goes in the option's description: "Fix now, in this pull request" as a label is refused, since a typed reply and a picked label read the same, and the refusal says so.
  A call whose folder or project it cannot read is refused only while this machine keeps product feedback: a `product-feedback/` folder
  in a project's state folder under the state root, in a state folder that config.json `state.dir` moved, which every
  `aidrian pr product-feedback` command that writes (`record`, `answer`, `recheck`, `post`, `diff`) notes in the state root's
  `feedback-folders/` before it writes or calls GitHub (a note that cannot be written stops the command there), or in the
  current project's state folder. A moved folder whose feedback was
  written before that note existed is seen once its next write notes it. That is a call after a `cd` it cannot
  follow, such as `cd "$D" &&`, `cd ~/x &&`, `(cd "$D"; …)`, `pushd "$D" &&`, or `env -C "$D"`; after a `cd` whose word the shell
  expands, such as `cd ../proj[B] &&`, or a `cd` or `pushd` with two operands, as zsh's `cd old new`; in a folder, or with a
  `--project`, that is no existing directory; in any folder but the current one when the command or the environment holds a `CDPATH`,
  such as `CDPATH=.. cd projB &&`; or with a dynamic, expanding, or `~` `--project`.
  Such a call, `--project $P` with no `--by` included, may claim no `--by human`, so its deny says only that the rule cannot read
  which project or words it holds. Where this machine keeps none, such a call passes, a subagent's included.
  A deny says why the transcript's answers miss, and names the question to ask. With no such transcript, as on Codex or in an unattended
  run, the Human runs it in their own shell.
  A `--by`, pull request, item, decision, or subcommand it cannot read is refused, and so is any word the shell expands: one holding
  an unquoted `*`, `?`, `[`, or a brace list or range, wherever quotes sit around it, a `--reason` or other prose value included,
  since it can become several words, one of them `--by`. A quoted brace or bracket is a character: `'F{1..1}'` is read as written.
  So is a dynamic value that is not one quoted scalar: `--reason "$R"` runs, and `--reason $R` or `--reason "$@"` does not.
  A report or key the shell expands, such as `F{1..1}`, `F{1..1}' '`, or `'<report>#'F{1..1}`, is a key it cannot read: refused while
  a record lists any item, and passed when none does, since no key is held then. So is a bare number two repositories' records hold. A dynamic program whose words read as either call is judged as that call.
  It reads the call through `sh -c`, `eval`, a substitution, and a heredoc fed to a shell. It refuses text fed to a shell that names
  either command, and `xargs`, `parallel`, or a shell fed unread text on a line naming a call: `product-feedback` and `answer`, or
  `audits` and `record` while a record lists a key, together with `--by` and `human`.
  It also refuses a command it did not judge whose own words or heredoc name a call, such as `find -exec`, `npx`, an interpreter, a
  variable's assignment, or a git global option, unless that command only handles text. So a commit message, `grep`, `rg`, `cat`, `tee`,
  `echo`, `printf`, `git log`, or `gh pr comment` may name a call, as long as a pipe out of it ends in another such command.
  It runs no gh, so it finds a record by the pull request's number.
  A command that also runs `aidrian pr product-feedback record`, or an aidrian call whose subcommand it cannot read, can write the
  record a call is judged against only after the hook ran, a first record included. There every `audits record` or `answer` that
  claims a human, or that it cannot read, is refused whatever is on disk, a subagent's with the subagent deny, and the deny says to
  run `record` on its own first. A command with neither call sees nothing new from this.
- Product feedback post: `aidrian pr product-feedback post`, also as a runner given `…/cli.mjs`, and through `sh -c`, `eval`, and
  a heredoc fed to a shell, read with the answer rule's helpers. `record` stores `limited` in the record, from the reads and the rule
  of `aidrian pr resolve`: a branch from another repository, a base that is a fork, or an author with no standing in the repository.
  The rule is on only where the state folder holds `product-feedback/`, and holds a post only when a record of that pull request
  does not say `limited: false`, so a member's pull request posts as before. There a call with an `agent_id` is refused, and a main
  session passes only a `post` run as its own command, with at most a plain `cd <folder> &&` before it and no redirect that writes
  a file, from the skill's own `<state>/tmp/product-feedback-<PR>.md`, when the transcript holds an AskUserQuestion answer, given
  after that file was last written, to a question naming `#<PR>` and posting, whose chosen option is `Post` alone. A comment
  rewritten after that answer, in a separate command, needs a new one; a held post beside another command the rule can read, such
  as a `sed -i`, `cp`, `tee`, or `>` on the comment, is refused, and the deny says to run `post` as its own command. A pull
  request, body file, or subcommand it cannot read is refused while a record holds a post; so is text fed to a shell, `xargs`,
  `parallel`, or a command it did not judge, such as `npx`, whose words name `product-feedback` and `post`, and a post in the same
  command as `record` or an aidrian call it cannot read. The deny says the Human can run `post` in their own shell.
- Ready hold: `gh pr ready` with a number, a URL, a branch, or none, with `-R`, `--repo`, or `GH_REPO`, and with quotes or
  backslashes the shell takes out anywhere in its words (`r""eady`), but `--undo` with no value or a true one, and a
  `gh api` call to any spelling of the graphql endpoint that names `markPullRequestReadyForReview` ([Ready hold](#ready-hold)).
- Ready checks: the same `gh pr ready` calls, but not the `gh api` form, and a `gh pr edit` with `--title`, `--body`, or
  `--body-file` (`-t`, `-b`, `-F`), or any `gh pr create`, in the same command as one ([Ready checks](#ready-checks)).
- Merge guard: `gh pr merge` but `--disable-auto` and a read of its `--help` or `-h`, `--auto` included, and a `gh api repos/<owner>/<name>/pulls/<n>/merge`
  sent as a PUT or a POST ([Merge guard](#merge-guard)).
- Push first: a command of `testing.fullSuite` as written, through wrappers such as `rtk` and redirects, in the folder a leading
  `cd` names; `npm test -- <file>` runs no full suite. [Push first](#push-first) says when it refuses.
- Main checkout: `>`, `>>`, `tee`, `sed -i`, `perl -i`, `ruby -i`, `cp`, `mv` and `git mv` (sources and destination), `rm`, `git rm`, `unlink`,
  `touch`, `mkdir`, and `rsync` (sources too under `--remove-source-files`); a branch switch or `git add -A` there;
  a `cp`, `ln`, `install`, `mv`, `git mv`, or `rsync` into a folder also writes the file it makes there,
  `<folder>/<source's last part>`, or the source's relative path under `rsync -R` and `cp --parents`, when the text shows
  a folder (`-t`, `--parents`, two or more sources, a closing slash, `.`, `..`, or `ln` with one operand) or the
  destination is a folder on the disk, so the config guard judges it the same way;
  `rsync` does so for each source with no closing slash, or every source under `-R`, since one with it copies its
  contents, a source spelled `host:path` by its path part, since an `-e` shim can make it local, and a `/./` marker by
  the path with and without the part before it, as GNU rsync and openrsync differ, whatever the destination is, since
  rsync never renames a folder source (so `rsync pkg/x.md new.md` also names `new.md/x.md`);
  and there `git commit`, `commit-tree`, `cherry-pick`, `revert`, `rebase`, `am` (all but `--abort` and `--quit`),
  `merge` and `pull` but a `--ff-only` toward the default branch's upstream, and a `git reset` of anything but named
  files ([Main checkout](#main-checkout)).
  After a `cd`, `pushd`, or `popd` that leaves the repository's checkouts, names a missing folder, or names one it cannot
  read (`cd "$S"`, `cd ~/x`, `cd -`), also a relative write, a glob included, and any git call but a read, such as
  `git init` or `git commit`, that would act on the main checkout if that `cd` failed.
  After a `cd` inside the main checkout, a relative write that lands there only if that `cd` fails, such as
  `cd build && echo x > a.txt` ([After a cd](#after-a-cd)).

Each rule is a file in `plugins/aidrian/lib/rules/`; a rule that reads only `gh` commands, such as the pull request body rule, is in `rules/github/`.
Each block is recorded: [Recorded blocks](#recorded-blocks).
A rule reads the command the way the shell splits it.
It sees through `sudo`, `env`, `timeout`, `command`, `rtk`, and similar wrappers, and ignores text in quotes, comments, and heredocs.
`builtin` counts as a wrapper only before `command`, `exec`, `eval`, or another `builtin`, the builtins that run another command;
`builtin cd` stays `builtin`.
It also peels zsh's precommand modifiers, `noglob`, `nocorrect`, and a bare `-`, and zsh's `repeat` with its count, as in `noglob git reset --hard HEAD^`.
In a `case` arm it reads the command after the pattern: a word that ends in an unquoted `)`, as `x)`, `*)`, and `"$x")` do,
or a word before a bare `)`, as in `a ) git push`. A function definition is read from its body, `f()` or `f ()` alike.
A quoted word that ends in `)`, such as `"$(command -v gh)"`, is a program word the shell builds, never a pattern.
The command behind a zsh modifier, `repeat`, or a spaced pattern or function name may never run:
bash has no `noglob`, `repeat 0` runs nothing, and an arm may go untaken or a function uncalled.
Those reads only refuse: a `cd` behind one moves no rule's folder, and a test run behind one adds no row to the [check-run record](#check-runs).
Four shapes still hide the program from every rule: a case pattern glued to its command (`*)git push`),
a function head with a space inside its parentheses (`f ( ) { git push; }`),
a zsh glob qualifier on the program path (`/usr/bin/git(N) push`), and an array assignment before the command (`x=(a b) gh pr merge 5`).
A long option it blocks also matches the shorter prefixes the program accepts, such as `--no-veri` for `--no-verify`,
`--am` for `--amend`, and `--cou` for grep's `--count`.
Every rule also reads the command substitutions that run: `$(…)`, backticks, `<(…)`, and those in a heredoc that expands.
The process rules also read `sh -c`, `eval`, and `xargs`. The git hook bypass, attribution, pull request body, extra round
approval, quota fallback, product feedback answer and post, and merge guard rules read `sh -c`, `eval`, and a heredoc or here-string fed
to a shell; the last four refuse text piped or scripted into a shell that names the command they guard, such as
`echo 'gh pr merge 5' | bash`.
The ready hold reads them too, and refuses text fed to a shell, or a shell's `-c` string or `eval` words built by a command
substitution, that holds the word `gh` and a word close to `ready` (`"ready"`, `re""ady`, printf's `re%sdy`), or names
`markPullRequestReadyForReview`, in a project where git says product feedback is on.
A command reached only through a script or an interpreter such as `python -c` is out of their sight.

The product feedback answer rule has limits it accepts, so a reader does not take it for more than it is:

- A session with a shell can forge `record.json` or `triage.json` directly, the limit the review record shares.
- A main session can write `auto: false` to the main checkout's local file, since the guard stops only subagents. The deny never
  names the opt-out as a route, and `aidrian pr product-feedback status --json` then gives `opted_out`.
- `recheck confirmed` is the session's word that a fix works, and it needs only a different head, so a force-push back counts.
- A `record` of a later run copies an existing decision under the new finding's key: a copy of an answer already given, never a new one.
  The rule holds no key before a record lists it, so a word given in an earlier command runs, and counts for nothing; one in the same
  command as `record`, or as an aidrian call it cannot read, is refused, since it would land after adoption. Out of its sight: a word
  started in the background before `record`, such as `sleep N && aidrian audits record … --by human &`, which lands after a `record`
  that a later command runs. A `by: human` entry `record` finds under a key it adopts, which it did not copy there, leaves the item
  owed until a later decision replaces it, and a verdict settled before adoption, whatever decision overwrote that entry since, still holds until the Human answers `decided --by human`
  after adoption, which the rule asks for ([Product feedback](config.md#product-feedback)).
- `--none-found --read-by` is the session's word that a read ran.
- `diff.patch` keeps the pull request's code in the state folder with default file modes, the same exposure as other local state.
- A token broken across a line passes `post`, and `<?` and similar hidden text survive neutralizing.
- A carried finding whose item was already answered is owed again.
- Answered feedback stays clear after later pushes, since later commits stay unwalked unless someone uses `--full`:
  a decision, so there is no stale-head reason.
- `answer` checks the form of `--doc`, but not, as `aidrian audits record` does, that the file and section exist.
- `aidrian pr product-feedback status` run from a folder a session made its own project reads `off`.
- `post` reads the `product-access` terms from the working copy, so a branch can change what it refuses.
- On Codex, with no transcript, a `--by human` answer is the Human's to run in their own shell.
- The post rule holds what `record` stored, so a session that forges `limited: false` in `record.json`, or posts before any record,
  passes it; `post` itself refuses a pull request with no record. On Codex, or with no Human to answer, a post on a pull request
  from outside is the Human's to run in their own shell.
- The post rule dates the comment by its file's modified time, so a session that sets that time back (`touch -r`, `touch -t`) in an
  earlier command, or moves an older file into place, passes on an earlier answer. The answer it reads names `#<PR>`, not
  `owner/name#<PR>`, so where two repositories hold records with the same number, an answer about one counts for the other.
  A `product-feedback/` folder the hook can enter but not list hides its records, and the post passes. A `record` that runs
  before the post through `npx`, `xargs`, or a script, in the same command, is out of its sight, as a post with no record is.
  A word whose expansion runs code is not read: an assignment before the post, a `<` redirect target, or the program word, using
  zsh `${(e)…}`, a glob qualifier `(e:…:)`, or bash `$[…]` or `${…@P}`.
  A job an earlier command started in the background can rewrite the comment after the hook passes a plain post, the limit the
  answer rule names for a word started in the background.
  The rule reads only `aidrian … post`: a post through `gh pr comment` or a `gh api …/comments` POST is out of its sight, and only
  the skill text forbids it.
- Out of the rule's sight: a variable set in an earlier Bash call and run as `$B` or `eval "$C"`, `$B $S`, words that `xargs` takes from its
  input with `human` nowhere on the line, a script, an interpreter that builds the words, such as `python -c` with a joined string, and a
  command that only handles text whose own option or environment runs one, such as `sort --compress-program` or `GH_PAGER`.
  A dynamic program with no words to read stays out too: refusing those would stop every `$EDITOR` or `"$PYTHON"` call.
  A call whose folder it cannot read, reaching a project whose `state.dir` keeps its state folder outside the state root, passes
  while no other `product-feedback/` folder is in that one look.
  A program word the shell itself expands or rewrites is not read as the call: bash's `{aidrian,} audits record …`, zsh's `=aidrian …`,
  or a wrapper the rule does not know, such as `faketime now aidrian …`.
  It ignores the option words of `cd` and `pushd`, so `pushd -n <dir>`, which leaves the folder as it was, and `cd -P link/..`,
  which resolves the link first, can be read as the wrong folder.

## Recorded blocks

Every block by a Bash rule, the main-checkout rule, the review-disposition rule, an [agent gate](#agent-gates), the config guard,
the [tracker write guard](config.md#tracker), or the question names check is recorded twice,
in `plugins/aidrian/lib/hook-deny.mjs`, after the hook writes its reason and before it exits 2.
Neither record waits on a lock, so a block stays well inside the host's 5-second hook timeout:

- A `hook_deny` row in the [dispatch log](dispatch-log.md#hook_deny-when-one-of-the-plugins-rules-blocks-a-tool-call):
  the rule, the tool, the agent, and what the rule matched, never the command.
  `"telemetry": { "hookDenies": false }` turns the row off. `aidrian report` lists the rows by rule and agent.
- A count toward an [automatic lesson](lessons.md#automatic-lessons): when one rule blocks the same agent run a third time
  for the same cause, the rule's own words for what it matched, an agent that keeps trying was not shown the allowed way.
  The count does not depend on telemetry.

The rules are named in the rows and lessons as `git-hook-bypass`, `git-amend`, `dependency-link`, `process-kill` (both the kill and the listing rule),
`shell-init-install`, `grep-exit-chain`, `pr-body`, `public-text`, `review-gate` (the Bash rule and the MCP hook), `review-rounds` (the Bash rule and the MCP hook), `review-signoff`,
`decisions-set`, `project-init`, `review-extend`, `review-delegate`, `review-fallback`, `merge-review` (the Bash rule and the MCP hook), `main-checkout`, `review-disposition`, `terms`, `agent-gates`,
`config-guard`, `tracker-guard`, and `ask-names`.
The hooks load the recorder only when they block, so a call they let run costs no more than before.
When the recorder fails, the call is still blocked.
One refusal is not recorded when it happens: the tracker write guard's [first refusal](config.md#how-a-write-is-judged) of a write with no read yet,
when it names a read to call. Every session that writes meets it, so recording each would make a healthy flow read as a hot spot.
The session-end hook records it instead, once, through the same recorder, when the session ends with no read recorded.
On a host with no SessionEnd it is never recorded.

## Merge guard

A session must not merge a pull request while a review of its head is still open, or while a review the Human asked for
was never sent. The rule, `plugins/aidrian/lib/rules/github/merge-review.mjs`, reads `gh pr merge`, a `gh api` PUT or POST
to `repos/<owner>/<name>/pulls/<n>/merge`, the MCP tool `mcp__github__merge_pull_request`, on Claude Code
[a GitHub MCP server a plugin installs](providers/claude-code.md#a-github-mcp-server-from-a-plugin), and on Codex
[the GitHub connector's merge tools](providers/codex.md#github-through-the-app-connector). It is on in every project.

Before it reads the record, a merge of this repository, one that names none or one of this checkout's remotes, holds the
working copy to [the base branch's config](review.md#the-record) from local git alone. A merge naming its number compares
with origin's default branch first, and with the base the head lookup names once it makes one. Origin's default branch is
`refs/remotes/origin/HEAD`, else `refs/remotes/origin/main`, the plugin's default branch; the `git.defaultBranch` a
working copy sets is never read here. A difference refuses the merge, whatever the record says, and its recourse says which
compare failed. A difference from the base the lookup names says to merge from a checkout on the base branch or that the
Human merges in their own shell. A difference from the default branch says to merge from a clean checkout at that branch's
tip when it is the pull request's base, and that with another base, or no such checkout, the Human merges in their own shell:
a long-lived base that differs from the default branch stays refused from its own checkout.
The hold also refuses a state folder, or a folder the review records go in, inside a checkout of the repository,
with `state.dir` set or unset: that denial says to move the folder first, and that the Human merges until the move lands,
or with `state.dir` unset until the folder is outside. It refuses a checkout at the folder the review records go in too,
with `state.dir` set or unset: that denial says to move that checkout first, and that the Human merges until it is gone.
It refuses a state folder whose path holds a line break the same way, which git's list of checkouts cannot show:
that denial says to move the folder first, and that the Human merges until its path holds none.
The hold applies with no review record too, and no answer of the waiver paragraphs below
waives it. With neither default-branch ref here it makes only the refusals about
a checkout, which need no base. So a repository with no `refs/remotes/origin/HEAD` whose default branch is not `main`
gets no compare of `state.dir` or the project folder from a merge naming its number, unless a head lookup names the base;
`git remote set-head origin --auto` sets that ref.
With a read that fails, or no time left, it goes on.

It reads only this machine's [review record](review.md#the-record), and decides in this order:

1. An owed review, one `aidrian pr request` recorded and no answer has marked since, refuses the merge, whatever the
   head or the outcome: a bot review sent is owed until the bot answers. Its reason says how to send it or wait for
   it, and that a later instruction does not cancel it.
2. No record from the review step, no outcome and no round, lets it run: the guard holds a review that is open or
   asked for, not that one happens. A review run outside `aidrian pr review` leaves no record and is not guarded.
3. Otherwise the head needs an `outcome` of `received` or `none_needed` on that very head. An outcome on an earlier
   head, or any other status, `running` and `error` included, refuses it.

It never reads pull request comments. Outside the unattended waiver below, its one network call is
`gh pr view --json number,headRefOid,baseRefName,url`, made only when the
command names no head or no pull request and a record may apply, and stopped after 3 seconds, or sooner at the
deadline the unattended waiver's paragraph below states. A merge whose head it then
cannot read is refused with a reason that says to pass `gh pr merge <PR> --match-head-commit <sha>`; so is one whose
pull request number it cannot read, such as `gh pr merge "$PR"`, or a `gh api` merge path whose number or repository
part is a variable; a method it cannot read, `-X "$M"`, counts as a merge.
The review record is one file a repository and number ([review.md](review.md#answering-in-the-session)), and a record
written before then may still hold owed entries of another repository's #5, each naming that repository: a merge of it
counts them, though it never reads the rest of that record. A merge whose target is named, as `-R`,
a URL, a `gh api` path, or the MCP owner and repo, reads that repository's record and only its part: the owed reviews
for it, each an entry's own repository, else the record's, else origin's, and the outcome and rounds when the record is
for it. A merge that names no repository, or one it cannot read, reads every entry of the record it finds, since gh's
default may be the upstream; when this machine holds records of that number for more than one repository, it reads
none of them in another's place and is refused, naming the `-R` to add.

The Human waives it. The reason prints a question naming `#<PR>` and the head's first 7 characters; the merge runs when
the session transcript holds the Human's AskUserQuestion answer to a question naming both, whose chosen option starts
with "Merge anyway", given at or after the head's outcome and every owed review. Without a transcript in that shape
(Codex), the Human merges in their own shell.

At the round cap, with nothing owed and the head's outcome `extension_check` or `round_limit`, the review is stopped
and not running, so the reason offers no wait. It says the review is stopped at its round limit and not running, and
asks "Review of pull request #<PR> at <sha7> stopped at its round limit, with <N> findings open. Ship, and file them as
an issue?", or with one, "..., with 1 finding open. Ship, and file it as an issue?". The count is the open findings of the
record's last round; it is left out, and the question ends "Ship, and file what it left open as an issue?", when that
round is not for the head, records no count, or left none.
The options are "Merge with the findings filed" and "Grant more review rounds", with neither marked preferred. "Merge with the findings filed", or
"Merge anyway", lets the merge run under the same conditions as the paragraph above. On that answer the session files
what the review left open as a follow-up issue first, then merges; the guard does not check the issue. "Grant more
review rounds" merges nothing, and the reason names the route to one more round: the waiting check's own while the check
at the cap waits for its judge or the Human, else `aidrian pr extend <PR> --human approve`, whose refusal names the
route when no extension waits for the Human ([Extra rounds](review.md#extra-rounds)). `extension_ask` keeps the first
question: the step waits for the Human's answer to the extra-round question there.

When every open finding of the head is low, the reason also names a third route, for an answer in the Human's own words
that the session decides, such as "whatever you recommend": the session files what the review left open as an open
follow-up issue that names the pull request, runs `aidrian pr delegate <PR> --issue <issue> --head <sha>` as its own
command, ending in `--repo <owner>/<name>` when this checkout's remotes name several repositories (the merge's own when
it names one), then merges with `gh pr merge <PR> --match-head-commit <sha>`, with `--repo <owner>/<name>` when the merge named its repository. Every open finding is low when the record's last
round is for the head and lists each of its open findings, as many as its count, each `low` and none marked security,
and the cap's cause kept on the outcome is for the head, lists every pass's open findings, each `low`, none marked
security, and none missing from the round (another stage's finding, or a second pass's id for one, refuses), and names no
pass that never reviewed the head, remote reviewer such as the review bot that has not answered yet, flow, removed
test, failing check, or the review bot's own limit: in the last round a stage can run first and leave findings the round does not
list. A posted copy keeps no cause, so a record read from another machine names no delegation route, and only a
`round_limit` outcome keeps one, so a check at the cap that still waits on its judge names none either;
a finding of medium or higher, one with a severity the table does not know, such as a violated flow invariant, a
security mark, or a round that recorded counts only, keeps today's reason, word for word. The
[round limit delegation rule](#bash-rules) lets the command run only on the Human's answer in the session. The command
then refuses, and writes nothing, unless the pull request's current head is the one the review stopped on with nothing
owed, this machine's own record (before the summary comment's copy is merged in) is stopped on that head with the same
open count, since the rule read the question the Human answered from it, every open finding is low and has an id, and
the follow-up issue the forge reads is in the pull request's own repository, exists, is an issue and not a pull request,
is open, was filed at or after the review stopped (to the second), names the pull request in its title or body
(`<owner>/<name>#<PR>`, its URL, or `#<PR>` with no repository or path before it, so `other/repo#<PR>` does not count),
and lists each open finding's id, such as `R2-1`. It records `{ head, kind: "round_cap", answer: "delegate", issue, url, by, session, at }` under
`delegations` in [the record](review.md#the-record). The guard takes that entry on three conditions: the merge names
its head (`--match-head-commit`, `sha=` in a `gh api` merge, or the merge tool's `sha`), every open finding of the
head is still low, and the entry is for that head, at or after its outcome. An entry another session recorded is passed
over when the hook gives the merging session's id and the entry holds its own; one recorded with no session id counts
for any. A merge that names no head is refused, and told to name it. A "Grant more review rounds" answer in the
merging session's transcript to the same question, at or after the entry, outranks it: the merge is refused, and the
reason names `aidrian pr extend <PR> --human approve`. The guard reads the entry from the record it already loaded: it
makes no call for it; without a transcript, the entry stands. `aidrian pr auto-merge` reads no delegation.

Under the [unattended waiver](config.md#unattended-waiver), a judge's verdict recorded with `aidrian pr waive` stands in
for that answer, for one denial only: `round_limit` on the merge's own head, with nothing owed. A head pushed after the
last review step, whatever its outcome, is never waived, and its denial names no `aidrian pr waive` route: the review
can still run on it. Every other denial keeps its reason. A verdict counts only for
a merge that names its head, `--match-head-commit <sha>`, `sha=` in a `gh api` merge, or the merge tool's `sha`; for
any other, the denial says to name it. It never stands in for the review bot: it stands only when the review bot
passed exactly that head in the review trail, open findings of this machine's own reviewers, each of `medium`
severity or lower and no security finding, are the whole cause of the cap the record keeps, no sign-off of the Human's
is owed on the head in the sign-off store, and, for a project run's session, the run has not spent its budget of
waived merges; otherwise the denial says which, and offers no route to record a verdict. A verdict stands only for the
judge it names (`--judge`), whose dispatch, a `code-reviewer` between the cap and the verdict, the recording session's
[dispatch log](dispatch-log.md) shows, so one recorded with no judge never stands, as for auto-merge. A run's driver
counts against its run's budget as an issue's session does. A project run's session takes the merge from that budget
only after every other check of the merge, merge trust included, passed, so a refused merge spends none of it. The store and the run's
ledger and records are read only before the deadline below: past it, the denial says the team's value could not be
read in time. The ledger is read through the main checkout and its config, as the pinned repository is, and the count
stops at the budget, each record read checked against the deadline. Any `aidrian pr auto-merge`
under these switches takes a verdict too, on the same judge check. The guard reads the waiver only when the denial is that one and this
machine's `github.unattendedWaiver` switch is on, or unset under the team's [`solo`](config.md#solo), so with the
switch off it makes no network call it did not make before. With the switch unset it reads git first, once, each
read held to the deadline below: the default branch's local ref, and whether git tracks the local file. It reads the
network only when the local ref says solo and git tracks no local file.
It then reads `github.unattendedWaiver.allow`, and `solo` with it, at the default branch and the pull request's base on GitHub,
after the pull request's view: its own when it made one with the base, else one more, and git's project folder. One
GraphQL read, the review trail, gives both branches' policy files and the bot's verdict, as merge trust reads it; only
a pointer to another folder reads the policies over REST too. For a session no Human attends, merge trust then takes
that trail and reads it no second time.
Every one of these calls shares one deadline for the whole command, counted from when the hook's process started:
none begins once 4 seconds have gone, and each is stopped with SIGKILL after 1 second (3 for the view and the trail), or at the
deadline if that comes first. The waiver starts reading only when at most 1.5 seconds have gone: it checks that once,
before its first read, and its later reads are held to the deadline alone. The guard's own head lookup above is not
held to 1.5 seconds, only to the deadline: once it has passed, the lookup is not made, and a merge that names no head
is refused and told to name it.
The hold's git reads, the checkout list included with `state.dir` set or unset, all run at the project root and share the deadline, each stopped after 1 second, and a read asked for once it has passed skips the hold.
The guard's git reads outside the hold, such as the one that finds the project and the one that reads the record, keep
git's 2 second default; one that begins as the deadline comes can end up to 2 seconds later, and once one is stopped
the later ones do not wait.
A call held to the deadline, the guard's own view included, ends within 4 seconds of the hook's start, however many merges
one command holds.
A read that fails or would begin too late keeps the denial, which then says the team's value could not be read in time.
With both switches on, the denial names `aidrian pr waive` as a second route.

A session no Human attends, one whose [unattended mark](handoff.md#the-background-route) the hook reads by the host's own
session id, a pending or unreadable mark included, such as a project run's issue session, may not take the record's word
alone: a confined session can write the review records. The guard holds it to the projects its mark names, the gate's
start folder, else its main checkout, wherever its call runs, so a git folder of its own makes no hole; a mark that
names no project the guard can read refuses, and so does a main checkout that does not resolve to a project, whatever
the start folder; the start folder gives only the project's folder in the repository and its record folders. A project
run's driver is held the same way, from its driver mark. Its `gh pr merge --auto`, and any `gh api` call naming
`mergePullRequest`, `enablePullRequestAutoMerge`, or `enqueuePullRequest`, at any endpoint, or a GraphQL call
(`graphql`, `/graphql`, `graphql/`, `graphql?x=1`, or an absolute URL whose path is GraphQL's, or an endpoint the
shell builds) whose query is in a file it names or the shell builds, and fed text naming one, are refused: each leaves
the merge to GitHub. Before any record is parsed, its pull request's record files are checked: more than 8, more than
8 MiB in all, or one that is a link, a FIFO, a hard link, or over 2 MiB refuses, and so does a records folder past
20,000 entries, or one the guard cannot list within its time, each folder read one entry at a time. Every other merge such a
session makes that the checks above let through, with a record or none, the Human's answer, or a waiver, must also:
name its number and its full 40-character head (`--match-head-commit`, `sha=`, the merge tool's `sha`, or the GitHub MCP
server's `expectedHeadSha`, which its merge passes to GitHub), in the repository the session is pinned to, its project
run's, read from the run's ledger, else the main checkout's origin (a merge naming another repository is refused); read
its record files bounded, each parsed once a call; and pass on the forge, in one GraphQL
read on the waiver's clock below, `aidrian pr auto-merge`'s policy and [merge trust](review.md#merge-trust). The policy:
`github.autoMerge.allow` on both branches, the main checkout's own switch on, the default branch's required checks named,
the paths check with `includeGuardedPaths` and the policy files, the gh user's own pull request, no outsider's comment
or review in comment and review lists the forge gave whole, no changes requested, not a draft, and every check of exactly the head finished and passed, so gh merges at
once rather than leave the merge to auto-merge or a merge queue. For a pull request of a [project run](config.md#project-run)'s
issue, the issue its mark names, or, for any other mark such as the driver's, the issue whose snapshot branch, or a branch any attempt of it recorded, is the
pull request's head, the merge also keeps [`closes`](config.md#when-it-is-on): its title, body, and every commit
message, as the same read gives them at merge time, and the merge's own subject and body (`-t`, `-b`, `commit_title`,
`commit_message`), close or name no other issue of a team the run knows. A body from a file (`-F`, `@file`,
`--input`) or a variable refuses, and so do commit messages the forge gave only in part. A read that fails or runs out of time refuses, and says
one more try is safe. Whether GitHub keeps `--match-head-commit` when a push lands between the guard's read and the
merge is not verified live; the guard's read is of the same head it names. An attended session's merges are unchanged,
and read nothing more.

[Auto-merge](config.md#auto-merge) goes through this guard: the rule reads its `gh pr merge` like any other.
The guard is not proof that a review happened, because no record lets a merge run (step 2 above).
So `aidrian pr auto-merge` reads the record itself, and no record keeps auto-merge off. In a session no Human attends
it asks for [merge trust](review.md#merge-trust) too.
It also stays off for a changed instruction or workflow file (`paths`), a comment from outside the repository (`outsider`),
and requested changes (`review`). Neither it nor this guard stops a session with a shell or a forged local record:
for proof, protect the branch with a required review from a second account. [Limits](config.md#limits).

Limits:

- A record written on another machine is not read here.
- Two sessions writing the same record at once can lose an update; the last write wins.
- Two concurrent review steps on one pull request share one open mark: the first to finish clears the other's.
- In a fork checkout with gh offline, `aidrian pr request`, `attest`, and `signoff` fall back to origin, and a merge
  that names the upstream is then not guarded: pass `--repo` when gh cannot answer.
- A record written before this release has rounds but no outcome: a merge waits until `aidrian pr review` runs again.
- On Claude Code, a GitHub MCP server a plugin installs under a name that holds no "github" is not read, and neither is
  a merge through any other forge's server: [A GitHub MCP server from a plugin](providers/claude-code.md#a-github-mcp-server-from-a-plugin).
- Three heredoc forms, which the [ready hold](#ready-hold) shares:
  - A heredoc piped into a shell from a group or a subshell, such as `{ cat <<'EOF'; } | bash` or `( cat <<'EOF' … ) | bash`,
    is not read, so a merge or a ready in it is not refused.
  - A shell's own heredoc that it runs as a script, such as `bash /dev/stdin <<'EOF'`, is not read either.
  - The other way: `cat <<'EOF' | bash script.sh`, whose body only mentions `gh pr merge` or `gh pr ready`, is refused, as
    `echo '…' | bash script.sh` already is.

## Ready hold

A session must not mark a draft ready while its [product feedback](config.md#product-feedback) is owed: the flows run
`aidrian pr product-feedback status` before each `gh pr ready`, and this rule holds the step, so the hold does not rest on a
sentence in a skill. The rule, `plugins/aidrian/lib/rules/github/ready-hold.mjs`, reads `gh pr ready` and a `gh api` call
naming `markPullRequestReadyForReview`, whatever its endpoint (`graphql`, `/graphql`, or the full URL), in the Bash hook, and
in the GitHub MCP hook the server's `update_pull_request` and `update_pull_request_draft_state` with a `draft` that is not
`true`, under the server's own name or, on Claude Code, [a plugin's](providers/claude-code.md#a-github-mcp-server-from-a-plugin),
and on Codex the GitHub connector's `mark_pull_request_ready_for_review`
([its tools](providers/codex.md#github-through-the-app-connector)). It approves nothing and blocks no merge: `pr-auto-merge`
and `aidrian pr checks` read nothing of it. In the Bash hook it runs after the merge guard, so a command that marks ready
and merges leaves the guard its own time. It decides in this order:

1. `AIDRIAN_ALLOW_UNHELD_READY=1` in the hook's own environment lets it run. Only this rule reads it, so a setter in the
   command, `AIDRIAN_ALLOW_UNHELD_READY=1 gh pr ready 7` or an `export` before it, lifts nothing. `gh pr ready --undo` runs
   when its last `--undo` has no value or one gh reads as true; `--undo=false` and `--undo=0` are held.
2. Each call is judged in the project of the folder gh runs in, read by the product feedback answer rule's folder rules.
   A folder it cannot read, as after `cd "$PWD"`, is the session's project: gh resolves the branch there. A folder in no
   project lets a call run unless it names its repository. A call that names its repository (a URL, `-R`, `GH_REPO`, a
   graphql id, or the MCP call's owner and repo) is judged in the session's project as well, whenever that repository is
   one of its remotes, so a `cd` to another project does not steer it away. Either project saying owed holds it.
3. From git alone (`localFeedback` in `lib/pr-product-feedback.mjs`), it reads whether that project may run product feedback.
   Off is the one answer that does not go to GitHub, so off needs every origin default ref and `HEAD` to say off, and the state
   folder to hold no `product-feedback/` record folder; every other answer sends the decision to GitHub.
   It is on when the main checkout's local `auto` is true, `review.productFeedback.auto` is true at `origin/HEAD`, `origin/<git.defaultBranch>`, `origin/main`,
   or `HEAD`, or the state folder holds `product-feedback/`; maybe when a ref's config cannot be read, such as a config file
   missing at the ref; off when the local `auto` is false, or every ref says off. Each ref's config is found through that
   ref's own `.aidrian.json`, so a branch that moves the project folder moves nothing. `HEAD` can only raise: with no default
   branch git names on origin, and nothing saying on, the read is unsure and the command runs. Off, or unsure: it runs, with
   no gh call. `status` takes the same off path, before any gh call. [With the key off](config.md#with-the-key-off) names
   where a project without the key still pays.
4. Where git says on, two forms are refused with no network call: text fed to a shell that names a ready, as
   [Bash rules](#bash-rules) describes, and a command that marks more than one pull request ready, whose deny says to run one
   `gh pr ready <n>` per command, since one deadline cannot check them all. The second also holds where git says maybe.
5. Otherwise it runs `status` for each pull request the call marks, in its own process, at each project's root, and refuses
   on exit 2, naming each owed item with the command that answers it. A bare number with no repository goes to `status` as it
   is; any other target is viewed once with `gh pr view <target as written> [-R <value as written>]`, so every spelling gh
   reads, such as `http://`, `www.`, a URL's tail, `-R` as a URL or `git@`, is read as gh reads it, and with a URL `-R` is
   ignored as gh ignores it. `status` takes that view and asks for the pull request no more. Each literal graphql id is read
   through a `node` query. When `origin/HEAD` names the default branch and the pull request is on origin's repository, `status`
   reads that name and skips the GitHub call for it.

Every gh call of one check shares one deadline: 3.5 seconds from its first gh call, and never later than 4 seconds after
the hook started, so another rule's lookups in the same command leave the hook inside its 5. A ready on origin's repository
costs three gh calls: the view and the default branch's two config reads. A pull request stacked on a branch other than the
default one costs two more, for the base's config, and a ready on another remote, such as a fork's upstream, one more for
its default branch; on a slow network those can pass the deadline, and the command then runs.
A gh call that fails, one past the deadline, `status` exiting 3, or anything else it cannot read about the state lets the
command run. The deny never names the override or the local opt-out as a route. A choice is the Human's, so an unattended
run leaves the draft.

What it cannot read runs, by the Human's decision, and is out of its sight:

- A word the shell fills in or expands where gh's program, `pr`, `ready`, or the pull request goes: `"$GH" pr ready 7`,
  `gh pr {ready,} 7`, `gh pr ready "$PR"`, `gh pr ready {7,}`, a loop such as `for n in 7 8; do gh pr ready $n; done`.
  A repository the shell fills in or expands (`-R "$REPO"`) counts as the session's own, as the merge guard reads it.
- A graphql call with no literal pull request id (`$id` from `-f id="$ID"`, `@file`, or `--input`), and an id that resolves to
  no pull request.
- A script, an interpreter, `xargs`, a variable set in an earlier Bash call, a `gh alias` such as `gh rd 7`, and `curl` to the
  GraphQL endpoint.
- The three heredoc forms the [merge guard](#merge-guard)'s limits list, which both rules share.
- A GitHub MCP server installed under a name that holds no "github", such as a plugin `gh` with a server `gh`, or a connector
  Codex suffixes with a hash: the merge guard and the review gate share this gap
  ([A GitHub MCP server from a plugin](providers/claude-code.md#a-github-mcp-server-from-a-plugin)).
- An `AIDRIAN_ALLOW_UNHELD_READY` entry in a host's settings `env` reaches every later session, as it does for every override;
  a follow-up covers them all.
- `origin/HEAD` names the default branch for the call `status` skips: a session that rewrites it, on a pull request stacked
  on its own branch, chooses both branches whose config is read.
- An off read from stale or rewritten git refs: [The commands](config.md#the-commands) names both limits, which the hold
  shares with `status`.
- A pull request opened as no draft is never held. A person's own shell outside a session is never held.

### Where the ready hold is verified

| On | Verified | Not verified |
| --- | --- | --- |
| Claude Code | The Bash form, through the real hook, in `test/ready-hold.test.mjs`, with a fake gh | The MCP form with a live GitHub MCP server, under its own name or a plugin's: the tests run its documented input through the real hook |
| Codex | Nothing live: the Bash hook payload is the standard one, as for every Bash rule | The connector's `mark_pull_request_ready_for_review`, from the catalog a Codex 0.167.0 install cached on 2026-11-06, run through the real hook from `test/fixtures/hosts/codex/github.json` |

The GitHub MCP server's input, read from its source at `pkg/github/pullrequests.go` and `pullrequests_granular.go`:
`update_pull_request` takes `draft`, a boolean, "ready for review (false)", from v0.10.0 to v2.1.0, the latest on 2026-11-06,
and v0.9.0 and earlier take none; `update_pull_request_draft_state` takes `owner`, `repo`, `pullNumber`, and a required
`draft` from v1.0.0. In v2.x, `update_pull_request` may hand the edit to an interactive form the person submits; that
submit is the person's, and no hook is known to see it. Codex's connector `update_pull_request` takes no `draft`.
Only these names are read: the [Ready hold](#ready-hold) list above names the ones that pass unchecked.

A host that stops a hook at its timeout may let the command run. On Codex `rust-v0.167.0` the source says so: a timed-out
`PreToolUse` hook is recorded as failed and blocks nothing (`codex-rs/hooks/src/engine/command_runner.rs` and
`events/pre_tool_use.rs`). On Claude Code it is not verified. The rule's own deadline ends first and lets the command run,
so it fails open either way, and the test of a stalled gh checks that the hook ends inside 5 seconds.

## Ready checks

A session must not mark a draft ready while a check on its head has not finished: editing a pull request's title or body
re-runs the workflows that listen for the edit, such as a Conventional Commit title check, and a ready sent in the same batch
as the check read lands while that check is still queued. The rule, `plugins/aidrian/lib/rules/github/ready-checks.mjs`,
runs in every project, product feedback or not, after the [ready hold](#ready-hold) in the Bash hook and in the GitHub MCP
hook. It reads the ready calls the ready hold reads, and decides in this order:

1. `AIDRIAN_ALLOW_UNHELD_READY=1` in the hook's own environment lets it run, as it does for the ready hold, and `--undo` runs.
   A folder in no project, for the session and for gh, runs.
2. A command that edits a title or body (`gh pr edit` with `--title`, `--body`, or `--body-file`) or opens a pull request
   (`gh pr create`), and marks one ready, is refused with no network call, in either order. So is a GitHub MCP
   `update_pull_request` that sets `draft: false` with a `title` or a `body`.
3. One view of the pull request through the forge (`gh pr view <target> [-R <repo>] --json
   url,number,isDraft,createdAt,statusCheckRollup`). A pull request that is not a draft runs: ready changes nothing. A check
   run on the head that is not `COMPLETED` (queued, waiting, pending, in progress) or a status that is `PENDING` or
   `EXPECTED` holds it, and the deny names each.
4. With nothing pending, a draft opened, or whose body was edited or title changed, less than 30 seconds ago, with no check
   started since, is held: GitHub takes a few seconds to queue a re-run, and until then the checks shown are the ones from
   before. The body's last edit and the newest title rename come from one GraphQL read, made only when nothing is pending
   and the draft was not just opened. The times are GitHub's; only the 30 seconds is read against this machine's clock, and
   an edit time ahead of it by more than that runs. A check that started after the change lifts the hold, and so does the
   end of the 30 seconds, for a project with no check that runs on an edit; the deny says when.

Every deny names the route: wait with `gh pr checks <n> --watch` until every check reports, then mark it ready with
`gh pr ready <n>` in a separate call. A check that finished and failed does not hold the draft; the review reads it.

Its gh calls share one deadline, as the ready hold's do: 3.5 seconds from its first call, and never later than 4 seconds
after the hook started, so a ready hold that spent the time leaves this one none, and the command runs.
A view that fails, an edit read that fails, a call past the deadline, or a rollup it cannot read lets the command run.

What it cannot read runs, and is out of its sight:

- What the ready hold cannot read: a target or program the shell fills in, text fed to a shell, a script, and a `gh alias`.
- A `gh api` call to `markPullRequestReadyForReview`, whose pull request is a node id.
- A push followed at once by a ready in another call: the new head shows no check until GitHub queues one, and a push is not
  a change this rule reads, unless the push opened the pull request less than 30 seconds ago.
- An edit made in an earlier call more than 30 seconds before the ready, whose re-run GitHub has still not queued.

It is verified on Claude Code through the real hooks in `test/ready-checks.test.mjs`, with a fake gh, and on Codex as the
[ready hold](#where-the-ready-hold-is-verified) is: the Bash payload is the standard one, and the connector is not live.

## Main checkout

The main-checkout rule is off until a project turns it on in config.json:

```json
{ "version": 1, "git": { "mainCheckout": { "guard": true, "allowWrites": ["notes/**"] } } }
```

Then task work has to happen in a git worktree, so the main checkout stays clean and on the default branch.
The deny reason names `aidrian worktree new <branch>`, which creates one.
The rule blocks a write to a file git tracks, or would track, in the main checkout.
It allows a git-ignored path, a path in `git.mainCheckout.allowWrites`, and anything in a worktree or outside the repository.
A target that is a link is judged as itself too, wherever it points ([The state folder](#the-state-folder)).
[config.md](config.md) lists both keys.
When git cannot answer, an Edit or Write is blocked to be safe, and a Bash command runs.
A file edit whose payload names no file the host's adapter can read, such as a Write with no path or a patch it cannot
parse, is blocked from the main checkout too, since the rule cannot tell it writes no tracked file.

Several sessions can share the main checkout, so the rule also keeps its git state, and lets only what is plainly safe
through, whatever the spelling:

- `git add` of named files only: no folder, glob, `-A`, `-u`, or other option but `-v`, `-f`, `-N`, and `-p`.
- `git switch` and `git checkout` only back to `git.defaultBranch`; `git checkout -- <path>`, `git checkout <path>`, and
  `git checkout <commit> <path>` restore files and pass.
- `git merge --ff-only` and `git pull --ff-only` toward the default branch's upstream only, which make no commit and
  bring in nothing that is not on origin: `git merge --ff-only` with no operand or with `origin/<defaultBranch>`,
  `@{u}`, `@{upstream}`, or `FETCH_HEAD`, and `git pull --ff-only` with no operand or with `origin <defaultBranch>`.
  Any other operand, `.` included, is blocked: `git merge --ff-only feature` moves main onto commits origin lacks.
  No other option passes but `-q`, `-v`, `--stat`, `-n` or `--no-stat`, `--progress` or `--no-progress`, and, for pull,
  `--no-rebase`.
- `git reset` of named files only, read as `git add` is, which unstages them: `git reset <file>`,
  `git reset -- <file>`, and `git reset <commit> <file>`. A mode (`--hard`, `--soft`, `--mixed`, `--keep`, `--merge`),
  a lone commit (`git reset HEAD~1`), a bare `git reset`, a folder, a glob, pathspec magic (`git reset .`,
  `git reset :/`), and `--pathspec-from-file` unstage other sessions' work or move the branch, and are blocked.
- `--abort` or `--quit` alone, for `merge`, `rebase`, `cherry-pick`, `revert`, and `am`: that is how a stray operation
  is cleaned up. `--continue` and `--skip` make commits, and are blocked.
- Never `git commit` or `commit-tree`, nor `cherry-pick`, `revert`, `rebase`, or `am` but to abort: each makes commits
  on the branch every session shares. The rule blocks them whether or not the project installed the [commit guard](#commit-guard),
  which refuses a commit the rule cannot read, such as the Human's own.
- A word that may expand (`"$MSG"`, `"$(…)"`, `{a,b}`) makes none of these plainly safe.

The rule follows `env -C`, `git -C`, `--work-tree`, and `--git-dir`, so a call from a worktree into the main checkout
is blocked and one into a worktree passes. Anything blocked here belongs in a task worktree.
Like the Bash rules, it reads the command's text: it stops accidents, not someone set on getting around it.

### After a cd

A `cd` can fail and still return 0: a shell alias or function for `cd` can. The shell then stays in the main checkout,
and what follows runs there. So from a session in a guarded main checkout, the rule reads each `cd`, `pushd`, and
`popd` on the command line, `builtin cd` included, its folder taken past one `--` (`cd -- X` names `X`), and sorts it:

- **Into a linked worktree** of the same repository, a folder that exists: trusted. Nothing after it is judged, as
  before; this is the documented `cd <worktree> && …` workflow.
- **Inside the main checkout**, a folder that exists (`cd src`, `cd .`): trusted. The shell is in the main checkout
  whether the `cd` works or not, so what follows is judged by the rules above, at the folders before and after it.
  A write that reaches the main checkout only when the `cd` fails, such as `cd build && echo x > a.txt` into the
  ignored `build/`, is blocked with a reason that names that `cd`. So is a relative glob after it (`cd build && rm -rf *`),
  which fails closed: if the `cd` fails, it runs at the folder before it.
- **Any other `cd`**: untrusted. It leaves the repository's checkouts (`cd /tmp`, `cd ..` above the root), names a
  folder that does not exist (`cd wt/typo`), or names one the rule cannot read (`cd "$S"`, `cd`, `cd -`, `popd`,
  `cd ~/x`). For the rest of the line, a second `cd` included, what follows is judged against the folders before it:
  - a relative write, as the rules above judge it there, and a relative glob (`rm -rf *`), which is blocked outright;
  - the same inside `sh -c` and `bash -c`, and, for the git calls below, in a heredoc or here-string fed to a shell:
    such a shell starts where its command runs;
  - a git call that may change the repository, when its folder is a guarded main checkout. Its folder is resolved
    through `-C`, `env -C`, `--git-dir`, and `--work-tree` from the folders before the `cd`, so `git -C /tmp/x init`
    passes and `git -C src commit` does not. Reads pass: `status`, `log`, `diff`, `show`, `rev-parse`, `ls-files`,
    `ls-tree`, `ls-remote`, `cat-file`, `rev-list`, `describe`, `blame`, `grep`, `shortlog`, `name-rev`,
    `for-each-ref`, `show-ref`, `check-ignore`, `check-attr`, `merge-base`, `count-objects`, `var`, `version`, `help`,
    and `fsck`; `branch` and `tag` with no operand, `worktree list`, `stash list` and `stash show`, `config --get`,
    `config get`, and `config --list`, and `remote` alone, `-v`, `show`, and `get-url`. Every other subcommand,
    an unknown one included, counts as a change.
  - a git call whose subcommand an expansion hides (`git "$sub"`, `git $opts commit`).

A `builtin cd` skips a shell alias or function, so it fails loudly, but it can still fail, as on a missing folder: it is
sorted the same, and its reason says only that it may fail.
A `cd` or `pushd` through `command`, as in `command cd <worktree>`, is untrusted: zsh's `command` runs no builtin, so the shell stays where it was.

The reason names the `cd` and the way out: name the folder in each command, with an absolute path,
`git -C <absolute folder>`, or `env -C <absolute folder>`. From a worktree or a project with the guard off, nothing
changes, and `AIDRIAN_ALLOW_MAIN_WRITE=1` lifts this with the rest of the rule.

What it does not stop:

- A trusted `cd` into an existing worktree that fails still runs what follows in the main checkout: tracked-file
  writes, `git init`, `git branch`, `git checkout -b`, `git worktree add`, and fast-forward merges land there.
  Only a commit is refused, by the [commit guard](#commit-guard) where the project installs it.
- After an untrusted `cd`, a git folder held in an expansion (`git -C "$PWD"`, `git -C "$(pwd)"`, `--git-dir="$D"`)
  is not read, although after a failed `cd` it may name the main checkout.
- A write reached only through a heredoc fed to a shell is not read, with or without a `cd`.

From a guarded main checkout, `cd <other repository> && git pull` is blocked as well; `git -C <other repository> pull`
is the way.

### The state folder

Agents write plans and handoffs to the project's state folder by its absolute path, the one `aidrian state` prints:
`cat > <state>/plans/x.md`, a heredoc included, passes from a guarded main checkout, as any write outside the
repository does. A `cd` into it is still untrusted: `cd <state> && cat > x.md` is blocked, as [After a cd](#after-a-cd)
says, because the write lands in the main checkout if the `cd` fails.

The state folder gets no trust of its own. A target that is a link is judged both as itself and where it leads, a link
whose target does not exist yet included, so a link in the state folder into the repository (`<state>/src -> <repo>/src`)
blocks a tracked or new file there, and `rm` of a tracked link in the main checkout is blocked wherever it points.
A state folder that is, holds, or sits in the main checkout (config.json `state.dir` set to `.`, `..`, or `~` around
the repository) is judged as the main checkout and the folders around it are.

Not covered: a target held in an expansion (`cat > "$S/x.md"`) is not read, so it passes, wherever it points; a state
folder inside the git folder (`state.dir` under `.git`) takes writes, since a write inside the git folder is not judged,
and after `cd <state>` there, a relative write that climbs back (`../../src/app.js`) is judged from the folder before
the `cd` and passes. A link whose text climbs out of another link (`<state>/inner -> <repo>/src`, then
`<state>/x -> inner/../src/app.js`) is read with `..` taken from the text, not after the link, so its target may be
misjudged. A chain of links not made yet is followed for 40 links at most, as Linux does.

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
A gate that blocks one agent run a third time for the same cause becomes a lesson for the project, not the plugin: the gates are the project's.
The hook runs for every tool, so a project without gates still pays for one process that finds the project, reads its config, and exits.
It asks the gates before any guard below, so a call a gate denies is denied before the guards read its paths and globs,
however long they would take.

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
  A read may be bound to a name, as in `const r = require(p)` or `r = json.load(open(p))`, and that name printed by keys only, as `r.status`.
  The name may not be one a read calls, such as `readFileSync`, `JSON`, or `open`.
  perl and ruby have none. Read, `cat`, and `jq` still read the files, as the block says.
- A write to a folder that holds one of the files, such as `rm -rf .aidrian`, counts; one to the project root, such as `cp notes.md .`, does not.
  A glob counts when it may match one of the files, and so does a bracket class, such as `conf[i]g.json`, which the shell expands.
  A glob from a folder the guard knows also counts when a link already on disk, in any part it expands, leads to one of
  the files or a folder that holds it, as `printf x | tee out/alias*` does when `out/alias` links to config.json.
- A call without `agent_id` is the main session's, which may still change them.
- A block is [recorded](#recorded-blocks) as `config-guard`, with the file it changes as its reason.
- With or without gates, a subagent may not target `.aidrian.local.json` with a Write, Edit, or apply_patch that changes a machine switch,
  or a Bash command that names `autoMerge`, `unattendedWaiver`, or `reviewApprovals`, whether it names the file, a glob
  that matches it, such as `.aidrian.local.js*`, or a glob that passes a link to it already on disk, such as `tee out/alias*`:
  the [auto-merge](config.md#auto-merge), [unattended waiver](config.md#unattended-waiver), and review-approvals switches
  are the main session's. Any other Bash write, move, remove, truncate, or copy over that file counts as changing every
  switch, since erasing a local `off` lets [`solo`](config.md#solo) turn it on: `rm`, `mv`, `: >`, or `cp` over it is
  refused too, however its name is quoted. So is a link made from it (`ln`, `ln -s`, `cp -l`, `cp -s`); `git clean -x`
  or `-X`, and `git stash -a` or `--all`, run in the main checkout or a folder the guard cannot know; and a command that
  names the file and writes to a word built from a variable or a bracket glob. A read, such as `cat`, or a plain copy
  from it, runs. Its known limits: a link already on disk under another name, and a program that deletes what it
  finds, such as `find -delete`.
- With or without gates, the same holds for `review.productFeedback` in that file: a Write, Edit, or apply_patch that changes it,
  through a JSON-escaped key, a removed key, or a file left unparsable included, or a Bash command that names `productFeedback`:
  the machine's [product feedback](config.md#product-feedback) choice is the main session's. So does
  `projectRun.forgeTokenKeychain`, through `forgeTokenKeychain`: which keychain entry gives a project run's issue
  sessions their [forge token](config.md#project-run) is the main session's.
- A main session the [background handoff route](handoff.md#the-background-route) started is refused every machine
  switch in that file the same way, as a subagent is: no Human attends it. The hook knows it by the unattended mark the
  gate files, `$XDG_STATE_HOME/aidrian/unattended/<session id>.json`, or the one in `~/.local/state/aidrian/unattended/`
  of the user it runs as, read on every call before it runs, wherever it runs: with no project at the call's folder,
  the project the mark names is guarded, and from another project, that project's store and switches are guarded too.
  A session started before the marks is known by its chain floor of route `background`, under its full id or a short
  one, in the continuation store of the working copy's `state.dir` or the base branch's, where the hook's environment
  and the user's own put it, and the hook reads that floor, and git, at most once a call, only for a call one of these
  guards would refuse it. It is held as a subagent is to the continuation store, below, so it can neither delete
  nor hide its own floor, and to the next three rules.
  The host lists the new session's id only seconds after the session starts working, so before the gate starts it,
  it files a pending mark, `pending.<the gate's session id>.json` in the same folder, naming the start folder and the
  ids of the sessions the host lists then. While that mark is under 5 minutes old, every session with no mark of its
  own, wherever its call runs, but the one that ran the gate and those the host listed, is held as unattended, since the
  new session may change folder before its id is listed; the gate removes it once the new session's own mark is
  written, or when nothing started, and a start whose outcome is unknown leaves it to lapse. A pending mark the hook
  cannot read, or one that names no listing, holds every session but the gate's.
  A session such a pending mark holds, or one whose own mark names an issue of a project run, files its beacon on its
  first call, `beacon.<session id>.json` in the folder the gate files marks in, once: a host adapter that cannot
  otherwise tell whether its host runs this plugin's hooks for the session it started, as Codex's under `codex exec`,
  waits on it ([Project start](providers/codex.md#project-start)). A beacon lapses with the pending mark.
- A session whose start proves its sandbox from inside it, as every Claude Code issue session's does
  ([The sandbox proof](providers/claude-code.md#the-sandbox-proof)), runs only the exact
  `aidrian project confine <run> <issue>` of its own issue, alone, on one line, in Bash, and only while no verdict is in
  the drop folder, until the start files the passed proof in its mark; a call it makes before then is refused,
  wherever it runs. A session with no readable mark of its own, whichever pending mark it reads, is held the same way
  whenever its call's folder, as the system resolves it or as its spelling folds, lies in an attempt's clone whose
  start wrote the proof's plan. Once the mark or the verdict in the
  drop folder says the proof failed, or the mark's proof state cannot be read, every call is refused, the confine
  command too. Before and after the proof, a file-tool read (Read, Grep, Glob, or LS, as the host's adapter names its
  read tools) that reaches a store the plan lists as hidden, or a folder that holds one, is refused. A Glob pattern
  with a `..` segment past its literal folder climbs from wherever a glob matched, so it reaches the file system's root
  and is refused. The hook also refuses the confine command, and writes a failed verdict, when
  its own environment, the host process's, holds a variable whose value names the attempt's `cache` folder. Only that
  issue's session may run the confine command (`lib/project-run-guard.mjs`), and one its pending mark starts only from a folder that resolves inside its clone. A session with no proof in its mark
  and no plan beside its clone, as Codex's, is not held so. And a session an unattended mark holds never runs a call
  that asks the host to run it outside its sandbox (`sandbox_escape`, Claude Code's `dangerouslyDisableSandbox`).
- `aidrian project decision`, which prints the entry that pins a [decision the Human recorded](config.md#recorded-decisions),
  is held as `init` and `resume` are (`attendedProblem`, by `lib/project-run-guard.mjs`): a subagent, a session the
  background handoff route started, and an issue session of a project run never run it, and the command checks the same.
- With or without gates or a project, a subagent, and a main session the background handoff route started, may not
  write in the unattended marks' folder, nor change the mode or owner of it or of the state root, by a path, a glob
  that may reach it, a link already on disk, or, where the folder is unknown, a part named `unattended`. The same holds
  for the shell records' folder, `handoff-terminals/` beside it, which names the session a shell opens in its terminal
  next ([Replacing the terminal](handoff.md#replacing-the-terminal)).
- A project run's driver counts as a session no Human attends for writes to the
  [continuation store](handoff.md#continue), `<state>/handoffs/.continue/`, the runs folder (its ledger and snapshot),
  the unattended marks, and the sign-off store, from `aidrian project init` on, wherever its call runs, its first
  driver too, which has no unattended mark of its own: from another project's folder, the run's project, which the
  driver mark names, is guarded as the call's own, and a call the guards cannot read whole or in time is refused.
  The state folder the driver mark names is guarded by the mark itself, so a run whose main checkout no longer resolves
  to a project, as when its config was removed, still holds its driver from the store and the runs folder there, from
  any folder. A refusal names the driver's run as what holds it. The same holds for the
  [merge guard](#merge-guard), `aidrian pr auto-merge`, and the review-signoff rule. `aidrian project init` files its
  driver mark, `driver.<session id>.json` beside the unattended marks, naming the run, its main checkout, and its state
  folder, before the init row, and refuses when it cannot; each start and wait by the current driver files it again,
  and custody files one for the continuation it moves to; a driver whose driver mark is there but cannot be read whole
  starts no background continuation at all (`runDriver` in `lib/run-driver.mjs`, which reads the mark
  alone, and the ledger only in the state folder it names). It holds whatever its age, until that ledger records the
  run's end (`aidrian project end`); a mark it cannot read, a missing state folder, or a ledger it cannot read holds
  the session too, and authorizes nothing. The driver's own `aidrian project` commands still write the ledger.
  After the run's end, a session that drove it stays held for the unattended marks and the sign-off store for the rest
  of the session (`droveRun`), so it can neither remove nor rewrite its own driver mark to lift the sign-off hold,
  and it is still refused a shell call or a write the guards cannot read whole or in time, which may reach either.
  Past the time budget, a driver's call that is no shell and writes no file, such as a Read, runs; its shell calls,
  `aidrian project wait` among them, are refused until the guards read them in time.
- The same two, and a project run's driver, may not write in the
  [sign-off store](review.md#merge-trust), `$XDG_STATE_HOME/aidrian/signoffs/` or `~/.local/state/aidrian/signoffs/`,
  read the same way, with the part named `signoffs`: a merge no Human asks for reads the Human's flow sign-offs there,
  and only `aidrian pr signoff` in a main session the Human attends writes it. A session no Human attends may not run an
  `aidrian pr` command with a variable set or unset by the command line itself that moves the state root, such as
  `XDG_STATE_HOME` or `HOME`, or one a host names the session by or says a Human attends it with.
- With or without gates, a subagent, and a main session the background handoff route started, may not start or resume
  a host's session outside the [handoff gate](handoff.md#the-gate), such as `claude -p`, `claude --bg`,
  `claude --resume`, `codex exec`, or `opencode run`, by the matcher each host adapter declares (`sessionStart`,
  [Adding a host](providers/adding-a-host.md)), every host's whatever host runs the session; a shell it cannot read
  that names such a program counts, and a package runner, such as `npx`, `pnpm dlx`, or `bunx`, is read as the program
  its package installs, so `npx @anthropic-ai/claude-code -p` counts as `claude -p`. The refusal says the command
  "starts or resumes a session of" that host. A command that only manages sessions, such as `claude agents` or
  `claude stop`, runs; of `opencode`, only the info flags and the nine commands its
  [page](providers/opencode.md#rules-for-the-other-hosts-sessions) lists run.
- With or without gates or a project, the same two may not repoint a git remote or gh's default repository, nor
  change how git reads them: `git remote add`, `set-url`, or `rename`; a `git config` write of a `remote.*`,
  `include.path`, `includeIf.*`, `url.*`, or `alias.*` key, or any `--edit`, `--rename-section`, or `--remove-section`;
  any of those keys given to one git call by `git -c` or `--config-env`, such as `remote.origin.url`,
  `remote.origin.pushurl`, `remote.origin.fetch`, `url.<base>.insteadOf`, or `pushInsteadOf`, or a key built at run
  time; a `git fetch`, `pull`, `push`, or `remote` on a line that sets, exports, or unsets a variable that moves git's
  repository or config, such as `GIT_DIR`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, or any other `GIT_CONFIG_*`;
  `gh repo set-default`; and `gh alias set` or `import`.
  Nor may they move a remote-tracking ref, which names the commit a project run cuts each issue from: `git update-ref`
  of one or with `--stdin`; `git symbolic-ref` that writes or deletes one, past its `-m` reason, or points a ref such
  as `HEAD` at one, which every later commit would move; `git remote set-head`
  but `git remote set-head <remote> --auto` (or `-a`), which sets it from the forge's own default branch; `git branch`
  deleting remote-tracking branches; a fetch, pull, or push refspec, or a `--refmap` value, whose destination git
  expands to one (`remotes/x` is `refs/remotes/x`, and `refs/REMOTES/x` the same file on a disk that folds case), a
  fetch or pull destination holding git's `*`, quoted or not, whose literal part before it, case-folded, starts
  `refs/remotes/` (`refs/*`, `refs/*/origin/main`, `*`, and `refs/remotes/origin/*` itself, so a held session's
  `git fetch origin 'refs/heads/*:refs/remotes/origin/*'` is refused while a plain `git fetch origin` runs), or
  one the shell builds or expands that holds a `:` and names `remote`, or whose destination starts with what the shell
  builds, as `+HEAD:refs/$R/origin/main`; and a push to a repository on the disk whose destination is no full branch or
  tag, as `git push . HEAD:origin/main`. The push's repository is read past the options that take a value
  (`--receive-pack`, `--exec`, `-o`, `--push-option`, `--repo`), and counts as on the disk when it is a path (`.`,
  `.git`, `~/x`), a `file:` URL, a word built at run time, such as `"$PWD"`, or any word that is no remote
  `git remote` lists in the call's folder.
  The plugin reads the team's policy, such as [`solo`](config.md#solo), from the repository a remote names on GitHub.
  A read, such as `git remote -v`, `git config --get remote.origin.url`, or `gh repo set-default --view`, runs, as do
  `git fetch origin`, `git pull --rebase origin main`, and a push to a configured remote;
  a shell it cannot read that names such an action counts. Its known limits: a write by its path to `.git/config`,
  a file it includes, or `~/.config/gh`; a program that runs its arguments, such as `xargs git ...`; a git
  subcommand held in a variable, as in `git $ACTION ...`; a git or gh word built by an expansion, such as
  ANSI-C quoting (`$'...'`) or a command substitution inside the subcommand (#340); and `HOME` or `XDG_CONFIG_HOME`
  moved on the line, which points git at another user config.
- With or without gates, the same two may not run `aidrian handoff continue` or `aidrian handoff route` with any
  variable the command line sets, exports, or unsets, anywhere in the command: by a prefix assignment, `env`, or
  `export`, or by `env -u`, `env -i`, `sudo`, or `unset`. The gate needs none. The reason names the ones that move its
  store, session, agent, host command, or the policy it reads: `XDG_STATE_HOME`, `HOME`, `PATH`, the variables that move
  the repository git reads, such as `GIT_DIR` and `GIT_CONFIG_PARAMETERS`, `GH_CONFIG_DIR`, and each variable a host
  names or tells itself by. The gate also holds its store to the base branch's under the host's own environment
  ([handoff.md](handoff.md#the-background-route)).
- With or without gates, a subagent may not run `aidrian handoff continue`, the [handoff gate](handoff.md#the-gate),
  which arms a continuation of the main session: its shell carries the main session's id, so the command cannot tell it
  from the main session. It reads the command wherever it runs in the line, as the [decision answer rule](#bash-rules) does,
  and refuses a command word built from a variable or a substitution, as in `$AIDRIAN handoff continue x.md`,
  when its later plain words read `handoff`, then `continue`.
- With or without gates, a subagent may not write in the continuation store, `<state>/handoffs/.continue/`, nor
  change the mode or owner of the store, a file in it, its handoffs folder, or the state folder, by a
  literal path to it, in any letter case on a disk that folds case, through a glob that may reach it, or after a `cd`
  the guard can follow, nor a file named as a marker that arms or delivers a continuation where the path is unknown,
  such as after a `cd` it cannot follow. Otherwise a subagent could write the marker it may not arm.
  A glob from a known folder also counts when a link already on disk, in any part it expands, leads to a marker, into
  the store, or to a folder that holds it, as `tee /tmp/alias*` does when `/tmp/alias` links to a marker, and `/va*/…`
  does through macOS's `/var` link; that walk shares the time and link budgets below. A `**` part spans any number of
  folders, as `tee out/**/alias*` reaches `out/a/b/alias`, and the walk follows links to folders inside it, though the
  shell may not; it reads each folder once a part, so a link that loops ends the walk. A plain part, with no wildcard,
  is looked up by its name, as a shell passes it with search permission alone, so `tee /tmp/x*/n/alias` counts when
  `n` may be passed but not listed (mode `0311`); a wildcard part in such a folder counts as one that reaches the store.
  The guard reads the call's literal paths and names first, and walks links only after the other guards' path and name
  checks, so a call they refuse by name, such as a write of `.aidrian.local.json`, is refused before any link walk.
  It reads literal paths only: a path built from a variable or a substitution, such as `"$STATE/handoffs/.continue/armed-s1.json"`,
  and a write after a `cd ~/…`, pass even when they name a marker. Only a relative target after a `cd` the guard
  cannot follow, such as `cd "$X" && echo {} > armed-s1.json`, is matched by its file name. A request to end a session
  or a record that a terminal follows one ([Replacing the terminal](handoff.md#replacing-the-terminal)) is matched only
  with the id shape the store writes, `ending-` or `follow-` and 8 hex digits or a whole UUID, so a common name such as
  `follow-up.json` stays allowed. That is an accepted limit
  of a guard for agents that cooperate; the store still never delivers a marker of the wrong shape, time, owner, or host process.
  Both blocks are [recorded](#recorded-blocks) as `config-guard`.
- When the base branch's config.json cannot be read in a repository with a remote, as when origin was added and never
  fetched, a subagent's or an unattended session's write outside every checkout is refused only where the project keeps
  a project run or a held session: a run or a continuation store entry in a state folder the guard can find, or an
  unattended or pending mark naming one of its checkouts. The folder that keeps them is then unknown. A project with
  neither writes outside its checkout as before; the refusal says what failed, not which store.
- A session no Human attends may not write the main checkout's paths a session in a linked worktree reads, such as
  Claude Code's `.claude/skills`, `agents`, `commands`, and `.claude/settings.local.json`, and while the project has a
  project run under way, an active run in any of its state folders, a folder of runs that cannot be listed, or a live
  unattended or pending mark naming it, no subagent may either, whichever session it belongs to. In a project with no
  run, a subagent writes them as before. These files refuse no project start: an issue's session works in its
  attempt's clone, which loads none of them, and a start checks only the clone's own host files and the folders above
  it ([Host files no review saw](handoff.md#a-project-run)); the rule keeps them as a review saw them for the sessions
  that do load them, in the main checkout and its linked worktrees.
  A confined session, as Codex's, writes the `work`, `git`, `drop`, and `cache` folders of its issue's running attempt
  under `<state>/runs/<run>/attempts/`, as the run's ledger names it, and nothing else in the runs folder.
  A project run's attempt clone is no shared main checkout: the [main-checkout rule](#main-checkout) reads the run's
  main checkout as its own.
- In a project run's attempt clone, every call is refused while the clone's own git config sets a key that makes git
  run a program or send elsewhere, while its work folder's `.git` is not the pointer file to the attempt's own git
  folder, or while that git folder holds a `commondir` or a `config.worktree` other than the placeholder the start
  gate puts there (`commondir` holding exactly `.` and a newline, the git folder itself, and an empty
  `config.worktree`, each a regular file with one link), before any git call of the hook runs there. The same check
  stands before every git call of the plugin, in a hook or a command, whose folder lies in a clone's work or git folder:
  `lib/git.mjs runGit` and `gateGit`, the committed config's `git show` (`lib/config-committed.mjs`), the review
  selector's reads (`lib/review/content.mjs`), and `aidrian worktree` (`lib/worktree.mjs`), each through
  `lib/attempt-clone.mjs cloneGitProblem`; while it fails, the call runs no git and answers as git failing. The call's
  folder and the `.git` pointer's target are each resolved as the system resolves them, where git lands, so a `..`
  after a link, as in `<folder>/link/..`, climbs from the link's target and is never folded as text first. Every git
  call of the plugin runs with `core.fsmonitor`, `core.hooksPath`, submodule recursion, the `ext::` transport, and
  signature display turned off (`lib/git.mjs`), the start gate's that make each attempt clone among them; another
  `commondir` would lead git to a config those settings do not cover. One call runs as the person's own git would:
  `aidrian worktree new`'s `git worktree add`, so a repository's post-checkout hook, such as husky's, pre-commit's, or
  git-lfs's, runs in the new worktree as it does by hand. The command runs in its caller's own shell, inside a confined
  session's sandbox when an issue session runs it, so it has no more rights than a hand-typed `git worktree add` there.
- An attempt clone stands linked to its run's main checkout only for the session whose unattended mark names that run,
  that issue, and that main checkout, or, before the gate files that mark, whose pending mark names that main checkout
  and that clone as the folder it starts the session in. A hook reads the session from its payload's id; a command
  reads it from its caller's environment, which is acceptable while no hook relies on a command's answer. The clone's
  state folder must also be one the project at that main checkout names, so a ledger and a main checkout a session
  builds in its temporary folder or a state work folder link nothing; so must its git folder hold no `commondir` or
  `config.worktree` but the gate's placeholders. Any other reader, and a clone that fails a check, read every machine switch off.
- **The write allowlist of a session no Human attends** (`lib/unattended-write.mjs`). A session its own unattended
  mark holds, read by the hook payload's session id, and every subagent of it, writes only:
  - its own worktree: the checkout of the folder its mark says the gate started it in, when that checkout shares its git
    folder with the main checkout the mark names: a linked worktree from any folder inside it, such as a package of a
    monorepo, and the main checkout only from its own top, so a removed worktree's folder left as a plain one inside the
    main checkout gives none; never the call's folder, so another worktree of the same repository
    is outside, unless it lies inside that checkout, as a task worktree under the main checkout's `.claude/worktrees/`
    does for a session started in the main checkout; each checkout nested so keeps its `.git` pointer and its host
    files refused, as below, and so does each folder strictly between the worktree's top and such a checkout, such as
    `.claude/` or `.claude/worktrees/`, since a host that reads the folders above a start folder loads its root host
    files into every session started below; the worktrees folder `git.worktrees.dir` names, `.worktrees` by default,
    keeps its root host files refused too, with no checkout in it yet; a checkout whose nested checkouts git cannot list
    is no worktree. A mark filed before
    the start folder was recorded, by an older gate, names the main checkout as its root wherever the session started,
    so that checkout never stands in: the start folder is the one the gate's start record in the continuation store
    names for the session, by the payload's full id or the short id the host printed (`lib/handoff-guard.mjs
    startedFolder`), read only from a store the handoff writer would keep, outside every checkout of the repository,
    and within the guards' time budget; with no such record, or records that name two folders, the session gets no worktree, so it
    writes none of the main checkout's task worktrees. A start record lasts a day. A project run's issue session whose
    mark names no start folder gets no worktree;
  - each task worktree `aidrian worktree new` made in the session, so an orchestrator that started in one worktree
    dispatches an editing subagent to another it made: the command records the worktree's real path for the session its
    caller's host names (verified on Claude Code, whose `CLAUDE_CODE_SESSION_ID` a subagent's shell shares with its main
    session; on Codex it is `CODEX_THREAD_ID`, and a grant holds only where that is the hook payload's session id), as
    `worktree-<session id>.<hash>.json` in the continuation store the hook opens for the session: the store of the
    project at its unattended mark's root, under that project's config, so neither a worktree whose own config moves
    `state.dir` nor another project of the same repository, as in a monorepo, changes where it goes; a session with no
    mark records in the store of the calling project at the main checkout. Such a session and every subagent never
    write that store by hand, as above, by a path, a glob, or a marker's name. The hook reads the records for the
    payload's session id (`lib/handoff-guard.mjs sessionWorktrees`), and checks each one on every call, one git call
    apiece, only for that session's records. A record grants a worktree only while git lists a checkout of the
    repository at exactly that path, as git prints it, never resolved, and git, asked at that path, reads it as a linked
    worktree of the mark's repository whose top is that path, as the start worktree is told. Both must hold, so none of
    these grants anything: a stale registration whose folder another checkout took, a folder restored at a path git
    moved the worktree away from, and a registration a link aliases to an old path. The path, and every part above it,
    must be no link, and lie in no state folder, no host folder of any
    of the repository's checkouts, such as `.claude/skills`, and no dot folder of the home folder outside the main
    checkout, since the worktrees folder is the config's. It keeps its nested checkouts, git folders, `.git` pointer, and
    host files refused from the same call on, as the start worktree does, the folders between it and a checkout nested
    in it and a host file that is a link included. A worktree
    made by plain `git worktree add`, by another session, or by a shell with no session id, is outside, and a project
    run's issue session gets none: it stays confined to its attempt. The session ledger's `links.jsonl` is display data
    that a call's output can forge, so no grant reads it. A record lasts 30 days. Accepted residuals: a recorded checkout
    git is slow to read spends the guards' time budget on every call, as the start worktree's read does; and a record is
    told by its path alone, so one forged by running the plugin's own code, which no guard sees, grants only another
    linked worktree of the same repository;
  - its issue's running attempt folders `work`, `drop`, and `cache`, under `<state>/runs/<run>/attempts/`, each only
    while it is a plain folder: one replaced by a link is refused, and so is the keep file `.keep-attempt` in `drop`
    and `cache`;
  - the state folders it writes by hand, each when it is no link, of every state folder of the project its mark names:
    `plans`, `tmp`, `handoffs` (the continuation store in it stays refused, as above), and `quorum`, where the product
    quorum runs under auto decisions; in `reviews`, only a review manifest, `pr-<n>.json` or a temporary copy of it,
    and a capture under `pr-<n>/captures/`; in `dispatch`, only a subagent's handoff file, a `.json` file directly
    in it; and in `audits`, a persona audit's report, sidecar, and screenshots, never as a grant into a checkout the
    folder holds or lies in. A confined host is granted `plans`, `reviews`, `tmp`, and `dispatch` for the programs it runs, such as the
    review commands, which write the records there. A project run's issue session, one whose mark names an issue, or
    whose mark cannot be read, is held tighter there: it writes no `handoffs`, since it asks for no handoff and a brief
    there could become a driver's prior ([handoff.md](handoff.md#the-check)), and no `quorum`, whose hard calls it
    parks for the Human (`aidrian quorum route` routes them to `human`); in `plans` and `tmp`, only an entry named for
    its own issue, the key itself or the key followed by `-` or `.` in any case, such as `plans/eng-1-implementation.md`
    or `tmp/eng-1/`, and in `tmp` also the body files the pr-write skill and the pull request body hook name for its own
    branch, such as `tmp/pr-body-feat-eng-1-export.md`; and in `dispatch`, only a handoff file named for its own branch, each `/` a `-`, such as
    `feat-eng-1-export-S1-explorer.json`. Its issue and branch are the run snapshot's, read while the ledger names its
    issue running (`lib/project-run-guard.mjs ownIssue`); with none, it writes none of them. When another issue of the
    run has a branch, planned or attempted, spelled the same once each `/` is a `-` (as `feat/eng-1-export` and
    `feat-eng-1/export`), or spelled the same and then `-` more, a body or handoff file named for the branch is neither
    issue's: the refusal names a key-named body file, such as `tmp/eng-1-pr-body.md`, which `--body-file` takes;
  - the temporary folder, this process's `TMPDIR` and `/tmp`, but for a host file some host loads from any depth
    (`nestedProtected`, the union of every host's), at any depth there, such as a `.claude` folder's skills or settings,
    a `SKILL.md`, an `.opencode` or `.agents` folder, or an `opencode.json`: a host that reads the folders above its
    start folder, as OpenCode does, loads it into every session started below that folder, so it is refused by the
    write tool and the shell, as "a host file a session started below that temporary folder loads", a copy, move, or
    link by the path it names and by the name it makes inside a destination folder, never by what a copied or moved
    folder holds; a glob there is not judged for one ([OpenCode residuals](providers/opencode.md#rules-for-the-other-hosts-sessions)).
    Also but for a state folder inside it, as one under `/tmp`
    is, where only the state places above pass, and for any checkout of the repository inside it, which keeps the rules
    above: a checkout that is not the session's worktree stays outside, and the worktree's host files and `.git` entries
    stay refused; with checkouts git cannot list, or a main checkout git cannot read though a `.git` lies at or above it,
    as the system resolves its folder, the temporary folder passes nothing and no checkout is granted;
  - `/dev/null`, `/dev/stdout`, `/dev/stderr`, `/dev/tty`, and `/dev/fd/<n>`, by the path a command spells.

  Everything else is refused, and these always, inside a place or not, checked first: every git folder, whole (the
  shared one, the worktree's own, and the attempt's; only git writes there, and git running is no write this guard
  sees), and a worktree's or the attempt clone's `.git` pointer, with every `.git` entry at any depth of the session's
  worktree, its attempt folders, and the state folders it writes, such as the pointer of a worktree nested in it: by
  the real path's parts and by the path as written, so a `.git` that is a link counts, by a glob part that may name
  `.git` (`.g*`), and, for a session its own mark holds, by a `.git` named in a folder no path gives; the pointer of each
  checkout of the repository nested in the worktree is refused too when a write, a delete, a move, or a glob reaches a
  folder that holds it, the worktree itself included, as `rm -rf .claude/worktrees` does; a glob is judged from its
  folder as written. A removal, move, or glob that reaches the `.git` of a standalone repository nested in a place, which
  no git listing names, without naming `.git` itself, such as `rm -rf vendor`, is not refused; `~/.gitconfig`, the `git` folder of `$XDG_CONFIG_HOME`
  and of `~/.config`, and the global and system git config files git itself names (`git var GIT_CONFIG_GLOBAL` and
  `GIT_CONFIG_SYSTEM`, such as a package manager's `etc/gitconfig`, asked only for a write that would otherwise pass);
  the shell startup files in the home folder and in `ZDOTDIR`; the user's macOS launch agents, `~/Library/LaunchAgents`;
  the host's session transcripts under the account's home folder, as an adapter's `transcriptFolders` names them
  (Claude Code's `~/.claude/projects`), whatever the session's places, since one is the proof that a Human typed into a
  session ([The background route](handoff.md#the-background-route));
  the review and attest records in `reviews`, by a write or a delete; any other path in `dispatch`, and the dispatch log
  beside it, `<state>/dispatch-log.jsonl`; the persona audits' triage record, `<state>/audits/triage.json`, its lock,
  and a temporary copy of either, by a write, a delete, a removal of a folder above them, or a hard link to the record,
  in every layout, a state folder inside the session's own checkout or a limited mark's included, and for a project
  run's issue session the whole `audits` folder; the host files every host's adapter protects (`protectedPaths`), in the
  session's own worktree, each checkout of the repository nested in it, each folder strictly between the two, and its
  attempt's clone: `.claude/settings.json`, `.claude/settings.local.json`,
  `.claude/skills`, `.claude/agents`, `.claude/commands`, `.claude/hooks`, `.claude/workflows`,
  `.claude/scheduled_tasks.json`, and `.mcp.json`, and OpenCode's `.opencode` folder, `opencode.json`, and
  `opencode.jsonc`, and the `.agents` folder, which OpenCode's adapter holds whole and where Codex keeps its plugin
  marketplace ([OpenCode](providers/opencode.md#rules-for-the-other-hosts-sessions)), which a later session there
  loads, to a Claude Code or Codex session alike; at any depth of the attempt's clone, and of the temporary folder, the
  host files a host loads from a nested folder (`nestedProtected`): a `.claude` folder itself, the `skills`, `agents`,
  `commands`, `hooks`, `workflows`, `scheduled_tasks.json`, and `settings*.json` of any `.claude` folder, any
  `SKILL.md`, any `.opencode` or `.agents` folder and all it holds, and any `opencode.json` or `opencode.jsonc`, by the
  write tool, the shell, a link's target,
  or a glob that may reach one, such as a part that may name `.claude` or `.opencode`, or a last part that may name
  `SKILL.md` (`*.md`) or an OpenCode config file; judged
  by the real path's parts, by the path as written past each leading part that resolves into the clone, so a write
  through a `.claude` link counts as one to that host file, and by the parts past each link git's index lists whose own
  path is such a host file, so a write to the folder `pkg/.claude -> ../shared` leads to counts as one under
  `pkg/.claude` (git lists only the index entries named `.claude`, below one, or `SKILL.md`, and those of each host's `nestedGlobs`, such as `**/.opencode/**`, and a clone whose links git cannot list then refuses); for a project run's issue session, the forge's workflow folders of its worktree and its attempt's clone, which the forge adapter names (`forgeWorkflowFolders`: `.github/workflows` and `.github/actions` on GitHub), since the forge runs their files with the repository's secrets on a push of any branch, before any review, so an issue that needs such a change is parked for the Human; and any other dot file or folder of the home folder, such as a host's user-level
  settings and instruction files, unless it lies in the session's own worktree, a state folder above, or its attempt
  folders. A repository under a dot folder, such as `~/.dotfiles`, still writes itself when it is the session's worktree.
  A write through a hard link to a refused file counts as one to it, and a link a command makes (`ln`, `ln -s`,
  `cp -s`, `cp -l`) is judged by the path it points at: it is refused when that path is refused or outside the places.
  Accepted residuals of the host-file rules
  ([OpenCode residuals](providers/opencode.md#rules-for-the-other-hosts-sessions)): a copy, move, sync, archive
  extraction, or clone of a folder whose contents hold a host file, or one that names its sources by a glob, is judged
  by its destination alone, with the reach of a program's own write. A move into a folder the same command line makes
  first, by a name with no closing slash, is judged as a rename, since the folder is read from the disk when the call is
  checked. A target built at run time, such as `d=$TMPDIR/a; echo x > $d/.opencode/plugins/x.js`, is judged by its
  names, and host-file names are not among them, so it passes, with the reach of a program's own write. A write to a
  path that an existing link in a temporary folder makes a host file passes, since the temporary rule reads the path's
  own parts and no links. The configured worktrees folder is read from `config.json` on each call, and a session in the
  main checkout may edit that file, so renaming `git.worktrees.dir`, writing a host file in the old folder, and renaming
  it back is not refused: three deliberate steps, and the tracked edit shows until it is reverted.
  - A target built from a variable is read with `$HOME`, `${HOME}`, `$XDG_CONFIG_HOME`, `$ZDOTDIR`, and `$TMPDIR`
    expanded from the hook's environment, unless the command sets that variable itself. One that still holds `$` or a
    backtick is judged by its names (a startup file, a git config, a dot entry of the home folder), by a git folder it
    asks git for, as `"$(git rev-parse --git-common-dir)/hooks/x"` does, and by its literal path before the first `$`,
    which must not meet a refused entry or lie outside the places. A bare `"$f"`, `"$out"`, or `"$dir"` has no such
    path and passes on its names. For a session its own mark holds, such a target first has the whole command judged
    once: a literal path anywhere in it that meets a refused entry, a startup file or a git config by its name, a dot
    entry of the home folder, a git folder git names, or a `.git` word refuses it as a write to a path built at run
    time, and the refusal says to write to a literal path instead. So `d=~/.ssh; echo x > "$d/k"` and
    `p=.git/hooks; cp x "$p/pre-commit"` refuse, and a loop over plain words or a target from `mktemp` passes.
  - `mkdir` of the `reviews` or `dispatch` folder itself, with no `-m` or `--mode` and no other write of it in the call,
    passes: the review commands and a subagent's handoff write there, and the folder may not be there yet. A folder
    below it, a mode, and `rm`, `rmdir`, or `mv` of it refuse, as does any write of it by a file tool. `rmdir` is read
    as a write of each folder it names.
  - A program that writes its own config is refused: a `git config` write (anything but a read, a list, or a key alone)
    to the user's, the system's, the shared, or the worktree's config, or with `--file` to a file outside the places;
    a key that makes git run a program at any scope, and `git config --edit`; the folders `git worktree add`,
    `git clone`, and `git init` make, and the file or folder a git call writes its output to (`--output=<file>` or
    `--output <file>` on any subcommand, as `git log`, `show`, or `diff`, and `-o` or `--output-directory` of
    `git format-patch`, and `-o` of `git archive`, alone, attached, or last in a cluster), and the file
    `git bundle create` writes, when outside the places, or when built at run time; a relative name lies in the folder
    every leading `-C` moves to, the last one included; the forge CLI's, which its adapter declares
    (`gh auth setup-git`, `login`, `logout`, `switch`, and `refresh`, `gh config set`, and `gh extension install` on
    GitHub); each host's own config subcommands, which its adapter declares (`configCommands`: `claude mcp add`,
    `claude config set`, `claude plugin install`, and `claude plugin marketplace add` for Claude Code, `codex mcp add`,
    `codex login`, and `codex logout` for Codex, and their removals, and for OpenCode those its
    [page](providers/opencode.md#rules-for-the-other-hosts-sessions) lists, such as `opencode plugin add`,
    `opencode auth`, and `opencode service set`); `npm`, `pnpm`, and `yarn config set`, `npm set`,
    `npm login`, `npm adduser`, `crontab` but `-l`, `launchctl` but its reads, and `defaults write`, `delete`, `import`,
    and `rename`; and every command that publishes, withdraws, or changes a package or its owners on a registry:
    `npm`, `pnpm`, `yarn`, and `bun` `publish`, `unpublish`, `dist-tag`, `deprecate`, `owner`, `access`, and `token`,
    `yarn npm publish`, `tag`, and `login`, `lerna publish`, `changeset publish`, `gem push`, `yank`, `owner`, and
    `signin`, `rake release` and `bundle exec rake release`, `cargo publish`, `yank`, `owner`, and `login`, also after
    `+<toolchain>`, `twine upload`, `uv publish`, and `poetry publish`, past options in any order and yarn's
    `workspace <name>`, with the read forms `owner ls`, `dist-tag ls`, and `access list` and `get` passing
    ([Dependency installs](providers/claude-code.md#dependency-installs)). A subcommand is found past the program's global options that take a value, as in
    `codex --profile p login` or `gh -R o/r config set`, and through a package runner: `npx`, `pnpm dlx`, `bunx`,
    `yarn dlx`, `npm exec`, `npm x`, and `pnpm exec`, by a host's own package name too (an adapter's `packages`), so
    `npx opencode-ai plugin add x` reads as `opencode plugin add x`.
  - A review manifest takes the name of the review gate's old attest record, `pr-<n>.json`, so a write that may give it
    a top-level `reviewer` key is refused: a file tool's text that parses as JSON with that key, escapes read as JSON
    reads them, or, when it does not parse, holds the key or a quoted key with an escape in it; a shell write of a
    temporary copy whose command names one; and any shell write to `pr-<n>.json` itself but a delete, or a rename or
    copy of a file on disk with no such key that the same call does not write.

  The two ways a session writes are read differently, so a refused path is refused through both:

  | What the guard reads | Bash | The file tools (Edit, Write, NotebookEdit, apply_patch) |
  | --- | --- | --- |
  | Literal targets of redirections and writing programs | placed by path | placed by the path the tool names |
  | A target built from a variable or a substitution | expanded where it can be, else judged by its names and the whole command | none: a file tool names a literal path |
  | Code an interpreter runs, such as `python3 -c` | judged by the paths and names in its text | none |
  | Links a command makes, and a program's own config | judged by what they point at or change | none |
  | Text written into a review manifest | the command must not name a `reviewer` key | the text must not give it one |
  | Where the host's sandbox stands | outside the guard: a confined session's Bash also runs in the host's sandbox | the file tools run outside the sandbox, held by this hook alone |

  A session a pending mark holds, while a gate starts a session, or whose mark cannot be read, may be one a Human opened
  in another repository: it keeps only the entries refused wherever they lie (the shared git config and hooks of the
  mark's main checkout and of the call's folder, the user's and the system's git config, the startup files, the home
  folder's dot entries outside the project's state folders, and the programs' config writes above), with no refusal for
  a write outside the places, and a variable it cannot expand is judged only by those names, never by the whole
  command. Its refusal says a project start is in progress. When its own mark names a main checkout with no project the
  hook can read, every write is refused. An attended session and its subagents are never held. The block is [recorded](#recorded-blocks) as
  `config-guard`.

  The guard reads what the shared lexer reads, and like the other guards it is for agents that cooperate. It does not
  see a write by `xargs`, `eval` of a built string, `tar -C`, `curl -o`, or another program's own output option; by a
  program or script the session wrote, or one of the project's own scripts; or by an MCP tool that writes files. An
  unsandboxed Claude Code issue session can still write anywhere through a program it runs. A ledger a session forges in
  the `quorum` folder, which it may write, could shape a later quorum run on the same plan. The sandbox grants a
  confined session the whole `plans`, `reviews`, `tmp`, and `dispatch` folders, which every session of the project
  shares, so a program or script it runs can still write another session's plan, scratch files, handoff, or review
  manifest there; the hook holds only what it writes by hand, and the review gate trusts no manifest, only the records
  the review commands write. A review manifest or capture is named for a pull request, whose number the hook cannot tie
  to the session, so any session may still write any manifest by hand, as before.

- **What a project run's issue session asks of the forge** (`lib/issue-forge-guard.mjs`, asked through the write
  allowlist above, for the same sessions and their subagents). The session keeps the forge token in its sandbox, so
  the hook holds what it runs with it:
  - `git push` only as `git push origin HEAD:refs/heads/<branch>`, `<branch>` the one its issue's latest start names
    (the snapshot's, or a fresh one a later attempt cut), in a call of its own, from its own worktree or attempt clone, with `+`, `--force`, or `--force-with-lease` (bare, or naming that
    branch) and the switches `-u`, `-q`, `-v`, `-n`, `--set-upstream`, `--quiet`, `--verbose`, `--progress`,
    `--porcelain`, `--dry-run`, and `--force-if-includes`. Refused: a tag, `--tags`, `--follow-tags`, `--mirror`,
    `--all`, `--delete`, `-d`, a `:ref` delete, any other ref or a second refspec, a URL or another remote, `--repo`,
    `-o`, `--no-verify`, any other option, a word built at run time, a git `-c`, `--git-dir`, or `--work-tree`, a
    variable that moves git's repository or config (`GIT_DIR`, `GIT_CONFIG_*`, `HOME`, `XDG_CONFIG_HOME`) on the line,
    any variable set or removed for the push itself (`VAR=value`, `env VAR=value`, `env -u`), as `GIT_SSH_COMMAND`,
    which runs a program, or `GIT_TRACE`, which writes a file, a push from any other folder, and every push while no running start of its issue names a branch. In a call of its
    own: beside the push only `cd`, git's reads `status`, `log`, `diff`, `show`, `rev-parse`, with only the options
    that read (`--oneline`, `-<n>`, `-n <n>`, `--format=`, `--stat`, `--name-only`, `--cached`, and the like, never
    `--output`, `-o`, `--ext-diff`, `--textconv`, `--exec`, `-c`, or one the hook does not list, which write a file,
    such as a branch's ref in the clone's git folder, or run a program), and
    `branch --show-current`, and the filters `echo`, `printf`, `true`, `head`, `tail`, `wc`, `cat`, and `grep` may run,
    none with a variable set or removed for it, as `GIT_EXTERNAL_DIFF=x git diff`, which runs a program, so `git apply --cached p && git commit -m x && git push ...`, a merge, a reset, or a fetch on the push's line,
    which would change its commits after the hook read them, is refused with "push in a call of its own". Then git
    holds the checkout: the folder's `git rev-parse --git-common-dir` is its worktree's or attempt clone's own, not a
    repository cloned inside it; origin pushes to one URL (`git remote get-url --push --all origin`), the one the start row's
    `pushUrl` pinned, read from the clone before its session started (a start that recorded none pushes nothing),
    so a second `remote.origin.pushurl` refuses the push; its
    commits change no file of the forge's workflow folders (`forgeWorkflowFolders`), nor a folder that holds them, as a
    `.github` made a link, from their merge base with origin's default branch (`refs/remotes/origin/HEAD`, else
    `origin/main`), however the file got there, as by `git apply --cached`, `patch`, `tar -x`, `unzip`, or `git am`,
    which the write rule above does not see, read with `--no-relative`, so a clone's `diff.relative` hides no path
    outside the subfolder a push runs in; and `git status --porcelain`, which names paths from the root whatever
    `status.relativePaths` says, names no staged, unstaged, or untracked change in those folders. Both reads take git's NUL-ended output (`-z`), so a file name git would quote, with a space or a
    non-ASCII letter, counts as it is. A merge of the default branch brings none of its own changes into that diff; a git that cannot
    answer within the hook's budget refuses the push, and one that names no base advises `git fetch origin`, which sets
    origin/HEAD again from git 2.48 on, or `git remote set-head origin --auto` with an older git. `git send-pack`, `git http-push`, and every git subcommand outside
    the list of git's own commands an issue session runs, such as an alias or `git subtree`, are refused; of `git lfs`,
    only `ls-files`, `status`, `env`, `version`, `fetch`, `pull`, `checkout`, `track`, `untrack`, `logs`, and `pointer`
    pass. `git submodule`, `rebase`, `bisect`, `difftool`, and `mergetool` are refused when the command they run names
    git, the forge CLI, or a push.
  - git or the forge CLI run through `xargs`, `xcrun`, or `find -exec`, `-execdir`, `-ok`, or `-okdir`, which the shared
    lexer does not unwrap, or a shell or a word built at run time they run whose words name git, the forge, or a push.
  - The forge CLI's subcommands its adapter declares (`forgeRefCommands`: on GitHub, `gh release create`, `delete`,
    `edit`, `upload`, and `delete-asset`, `gh workflow run`, `enable`, and `disable`, `gh run rerun`, `cancel`, and
    `delete`, `gh secret` and `gh variable` `set` and `delete`, `gh repo edit`, `delete`, `rename`, `archive`,
    `unarchive`, `sync`, and `deploy-key add` and `delete`, `gh cache delete`, `gh ssh-key` and `gpg-key` `add` and
    `delete`, and `gh repo create` and `fork` and `gh gist create`, where the token could copy the work and push
    anything), and a subcommand word built at run time. The read forms, such as `gh release list`, pass.
  - A raw API call the adapter reads as a write the session never makes (`forgeApiWrite`): on GitHub, `gh api` with a
    writing method, or a field (`-f`, `-F`, `--input`) and no `-X`, which makes it a POST, to any REST route but its
    pull requests' and issues' own (comments, reviews, replies, labels, reactions, requested reviewers, and
    `update-branch`; never `pulls/<n>/merge`), so git refs, tags, releases, dispatches, contents, statuses, Actions'
    secrets and variables, rulesets, and the repository's settings are refused; a GraphQL mutation other than those on
    review threads, comments, reviews, reactions, labels, requested reviewers, and draft state; and a GraphQL document
    read from a file or the input, or built at run time.
  - A shell the lexer cannot read, or a command word built at run time, whose text names a push, a release, a workflow,
    or the API.

  An attended session, a run's driver, and a session a pending mark holds are not held by it. Its residual: a script or
  program the session runs, or `curl` with the token, can still push or call the forge, a command an earlier call left
  running in the background can still commit between the hook's read and the push, and git in the session's own
  checkout can move its copy of origin's default branch, the base the workflow diff starts from; the forge itself holds
  that, so `aidrian project preflight` blocks a run whose default branch asks the signed-in user, admin or not, for no
  pull request, or whose tags no rule that user cannot bypass stops being created or moved, unless the team sets
  `projectRun.forgeProtectionAccepted`, which removes that backstop, so a script the session runs can push to the
  default branch or a tag; and one whose workflows see CI secrets, whatever that token's `workflow` scope, unless the
  team sets `projectRun.workflowSecretsAccepted`, which accepts all current and future workflow secret exposure for
  project runs, so a team sets it only when that is acceptable ([review.md](review.md)).
  A refusal of this rule, the write allowlist above, the remote rule, the `aidrian project` command rule,
  or the guards' word, target, and time limits names the session as the issue session of a project run,
  with the run and the issue (`blocked for the issue session of a project run (launch, ENG-1)`), and a subagent as one
  of that session, never as the main session, and the remote rule says the session works an issue of a project run,
  not that the background handoff route started it. When the guards run out of their time budget, an issue
  session's refusal says it works an issue of a project run. The block is [recorded](#recorded-blocks) as
  `config-guard`.

- A subagent, and a main session the background route started, may not write in the session folders,
  `<state>/sessions/`, read as the continuation store is: a target in them, a folder that holds them and no checkout,
  a glob that may reach them by its path or through a link on disk, and a change of mode or owner of them or of a
  folder that holds them. The folders are those of the call's project; those of the state folders the session started
  with, which the main session's `SessionStart` hook records in `<state root>/session-origins/<session id>.json`
  (`lib/session-origins.mjs`), whether or not the hooks have written there yet. It records a state folder only when the
  session folder writer would keep folders there by its own repository's checkouts, writes the record as the
  unattended marks are written (a folder the user's alone, 0700, and a random temporary file created only where nothing
  is, then a rename), reads and writes it as one step under its reservations (`exclusive` in `lib/session-folder.mjs`),
  and writes it again on a resume, so a resumed session's record is never pruned as stale; the guard reads it once a
  call as the store reads its own files: no-follow, non-blocking, a regular file the user owns, mode 0600, within
  16 KB, so a link, a named pipe, or a record others may read gives none. Also those of every project's default state
  folder under the state root (`<root>/projects/<id>/sessions`) that are there, listed one entry at a time with the
  guards' deadline checked at each, their real paths kept for both passes of the call; the writer's checkout list it
  reads stops its git at what is left of the deadline. And those of the project the session's gate snapshot or unattended mark names, each
  project folder by itself, so a linked checkout whose config moves `state.dir` is its own. The snapshot's project is
  opened, which runs git, only for a call that may write, a shell call or one with a write target, and never when it
  is the call's own project, so a subagent's Read runs one git, to find its project. So a subagent that works in
  another project, another checkout, or a folder with no project still meets the session folders of the project its
  session started in, gated or not. No subagent or unattended session may write the origins folder, as for the marks.
  A sessions folder that a checkout holds is no session folder, by the checkouts the session folder's writer keeps it
  out of (`projectCheckouts`: the project's, the repository root, and every worktree), so a `state.dir` of `..` in a
  checkout named `sessions`, of `.` in a project below the repository root, or in a sibling worktree leaves those
  checkouts writable. A target in a folder no path gives, interpreter code such as
  `python3 -c "open('…/prs.jsonl', 'a')"`, and a word of a command in a shell the lexer cannot read count when they
  name `sessions/<a part>/<a session file>`, with `/` or `\` between the parts, one or more, as a native Windows path in
  a string spells it, or a session file but `usage.json` by its name alone, read as a path part, whatever quote stands
  around it, so `cd "$X" && echo {} >> prs.jsonl` is refused; the word `sessions` alone never counts, so a project's
  own folder of that name stays writable, and nor does `usage.json` alone, a name other tools use.
  The hooks and the `aidrian` commands write there through their own code, which no guard reads, so the
  [ledger](#session-ledger) still records a subagent's push. An attended main session is not held. The guard shares
  the store guard's reach check (`reachesStateFolder` in `lib/handoff-guard.mjs`) and its limits, and runs where it
  runs, first without its link walk and again with it.
- A Claude Code Monitor call that runs a shell command reads as a Bash call, its `command` included, for every rule
  above and the gates ([provider page](providers/claude-code.md#shell-commands-of-the-monitor-tool)).
- A command in a shell the shared lexer cannot read, Claude Code's PowerShell tool today, is never read as Bash:
  the guards read its `command` as opaque text, split into words at blanks, quotes, and the characters that join words,
  with `\` read as `/`, in any letter case, and fail closed for a subagent. The words come from the command as given
  and from a copy with its joins undone: backticks removed, a literal join such as `'a'+'b'` folded, and quotes removed,
  so ``hand`off`` reads `handoff`; a typographic quote, U+2018 to U+201E, is a quote. A word that is a path counts as
  that path, from the call's folder when it is relative and from the home folder after a leading `~`.
  A word with `*`, `?`, or `[` is a glob, judged two ways. From the call's folder, it reaches a guarded file when each of
  its parts matches the file's path at that depth, in any case, among what is there: the file, a folder that holds it, or a
  link to either; so `src\*` or `*.json` in a folder without the file reaches nothing, while `Remove-Item *` at the project
  root reaches `.aidrian/`. A glob with a wildcard before its last part, as `src\*\x\l\*.json`, is followed through
  each folder it reaches, so a link below its first folder to a guarded folder counts too. By name alone, since the shell
  may change its folder first, it counts only when its last part matches the file's name or its folder's and starts with
  at least three plain characters past any dots, as `.aidrian.local.js*`, `conf*`, `.aid*`, `conf[i]g.json`, or `.con*`
  and `han*` for `handoffs/.continue` do, or when its last two parts match the file's folder and name, as `.aidrian\*` or
  `handoffs\*` do. Its last part never names a checkout's folder, whose name a project's paths share, and names the gate
  snapshot's folder only with the folder above it, as `aidrian\ses*`. So `*`, `*.json`, `.*`, `c*`, `.c*`, and `src\w*`
  in a checkout named `webapp` name nothing. A `-Name:value` word, its dash `-` or U+2013 to U+2015, counts its value as a
  word too. One pipeline of read-only cmdlets, such as `Get-ChildItem`, `Get-Content`, `Select-String`, `Where-Object`, or
  `Get-Process`, each word plain, with no variable, subexpression, script block, redirection, or `;`, writes nothing and is
  not judged by its paths and globs, so `Get-ChildItem *` and `dir .*` run anywhere; `Get-ChildItem * | Remove-Item` is
  judged. Such a pipeline still may not hold both `handoff` and `continue`, and still counts toward the 512-word cap below.
  A glob is matched in at most its length times the name's steps, never by backtracking.
  It may not hold both the words `handoff` and `continue`, nor a word that names or reaches the continuation store
  (`handoffs/.continue`, a `.continue` part, a marker's file name, a folder that holds the store, or a glob that reaches
  it), nor `.aidrian.local.json`, by name or by a glob that may reach it; while gates are set, nor a word that names or
  reaches a file that sets them. Outside a read-only pipeline, each counts whether the command reads or writes, since the
  guard cannot tell, so the block
  says it may change the file, or, for a glob, that it may reach it; Read still reads the file
  ([provider page](providers/claude-code.md#powershell-commands)). A command of more than 512 words, counting
  each case, of a subagent, of a session the background route started, or of a session a project run's driver mark
  holds, is refused, since the guards resolve no more. In the gates, every `Bash` and `Bash(<prefix>)` deny blocks
  such a call, and the gates are asked before any guard ([config](config.md#agents)).
- The guards run under a time budget: 2.5 seconds from the hook's start, well inside the host's 5 second hook timeout,
  past which the host runs the call with no guard. They check it as they read targets, words, folders, and links; past it,
  a call of a subagent, of a main session the background handoff route started, or of a main session a project run's
  driver mark holds, its run's first driver included, is refused, as the guards could not finish reading the command
  in time, and an attended main session's runs, as the guards allow it anyway.
  The time depends on the machine's load, so that refusal gives one ordered recovery: retry the same call by itself, up
  to three times, then run a shell call as shorter commands where a split keeps what it does, and only then stop and
  report it to the Human.
  An agent that read "tell the Human" first stopped at one small Edit instead. A call that is no shell and has no
  write target, such as a Read, a search, or an MCP tool's call, runs past it for every session, since every guard
  reads a shell command or the files a call writes. The walk checks it at each entry it tests, so a folder of many long names cannot hold
  the hook past it, and a glob part rejects at once a name with fewer characters than it must match, or one whose end it
  does not match. A Bash call of more than 1024 write targets, counting each folder a path may
  be in, of a subagent, of a session the background route started, or of a run's driver, is refused at once, and a glob that leads the guards through more than 100,000 entries counts as one that may
  reach a guarded file. Each folder a glob reaches counts once a call, however many guarded files are tested against it,
  so `Remove-Item -Recurse node_modules\*\dist` over a `node_modules` of 30,000 entries runs.
  A link a glob passes is resolved from the spelling of its folder that reached it, and its target is compared with a
  guarded file in any letter case on macOS and Windows, whose disks ignore case by default, so a glob in another case of
  the project folder, such as `WEBAPP\node_modules\*\dist`, is judged as the one in its own case is.
  A path that passes more links than the system follows in one lookup is read as spelled: a command that reaches it in
  two lookups, as after a `cd` partway along, is not followed, an accepted limit.
  `AIDRIAN_GUARD_BUDGET_MS` in the hook's environment may only lower the budget, as a test does.
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

## Review dispositions

A `pr-review` manifest, `<state>/reviews/pr-<n>.json` ([its fields](../plugins/aidrian/skills/pr-review/references/manifest.md)),
gives each finding the `disposition` that `aidrian pr disposition` prints for its axes, never one set by hand.
Before an Edit or Write of a manifest, or of a temporary copy of one (a file in a `reviews` folder named `pr-<n>.json`,
or starting with it, such as `pr-42.json.tmp`), the file-write hook reads the file as the write leaves it.
It refuses the write when a finding's `disposition` is not a value the [disposition table](../plugins/aidrian/lib/finding-disposition.json)
gives its severity, likelihood, affects, and cost, and names each such finding with the value its axes give. A finding whose axes are not in the vocabulary refuses
whatever its disposition, even `invalid`, the word the command prints for such axes.
Both readings count: with no source, as the `pr-review` skill runs the command, and as an agent's finding in its
`raised_in` round (`--source bot --round`), where the late-round rule can change it. A finding with no `disposition` yet is not judged, and neither is one that drifted the same way before the write,
with the same id, disposition, and axes, so a run can still record its status; a new temporary copy is compared with
the `pr-<n>.json` beside it.
An edit to an axis alone refuses too, as the old disposition no longer follows from it.
The block is [recorded](#recorded-blocks) as `review-disposition`. The rule has no switch and no override:
a disposition that looks wrong means its axes are wrong.

Text that does not parse as JSON, and an `apply_patch`, whose result the hook cannot see, are let through.
A manifest written from the shell is not judged here: `aidrian pr disposition --manifest <file>` checks one, exiting 1
with each drifting finding (`drift`: its `id`, `disposition`, and the `expected` values, empty for axes outside the vocabulary), and the `pr-review` and
`pr-review-fix` skills run it after each write and before each fix.
`aidrian pr disposition` splits an argument that starts with `--` and holds spaces into words, as zsh passes a variable
of flags unsplit, so `aidrian pr disposition $flags` reads every flag.

## Markdown line length

After an Edit or Write of a `.md`, `.markdown`, or `.mdx` file in a project, the hook reads the whole file and names the lines
the write touched that are longer than `docs.wrapLimit`. The write already happened, so the agent fixes them with a follow-up edit.
Frontmatter, fenced and indented code, table rows, a [decision marker](project-folder.md#decision-markers) line, and a line whose overflow is
one unbreakable token such as a URL are never reported.
`"docs": { "wrapLimit": 0 }` turns it off.

## Delivery check

When a subagent's last message presents a `.md` or `.json` path as delivered and that path exists nowhere, the stop hook
sends it back once, on the first stop of its turn, with the missing paths: it writes them, corrects its report, or says
it removed them on purpose. A later stop of that turn is not sent back for them. Each send-back is also an occurrence of an [automatic lesson](lessons.md#automatic-lessons)
for that agent type.
A path counts as delivered only on a line that also has the 📄 marker or one of the words wrote, written, created, saved,
handoff, or output, in any case, outside a path.
A path on any other line is a mention, such as "docs/old.md does not exist", and is never checked.
A relative path counts as there when it exists under any root it can be relative to (`lib/delivery-check.mjs`):
the hook's folder, its checkout and the main checkout, the project, the project's [state folder](project-folder.md#local-state)
(`dispatch/`, `plans/`, `reviews/`, `tmp/`), every worktree of the repository, this plugin, its `skills/` folder and each
skill's folder (`references/tracker.md`), or the end of a file the agent's own Read, Write, or Edit calls named, such as a
doc in another project. An absolute or `~/` path is checked as written.
A path shortened with `...` or `…`, such as `.../review/x.json`, cannot be checked, so it is never sent back.

The check also reads the subagent's brief, the first prompt of its transcript.
A brief names the run's own handoff file with a `Handoff file:` marker, such as
`Handoff file: <state>/dispatch/<branch>-signoff-product-manager.json`, or `**Handoff file:**` or `**Handoff file**:`,
in any case, with LF or CRLF line ends. The marker opens a line, after an optional list marker, or opens a sentence
later in one, as in `Under 4 KB. Handoff file: <path>`. Inside a sentence, as in `Read the earlier handoff file: <path>`,
it names a file to read, which is never owed. A line may hold several markers, each opening a sentence. A mid-line
marker counts only with no backtick before it on the line, so one in inline code, an example the brief quotes, is not
read; a marker after a stray backtick is not read either, the residual of that rule.
Each such marker names one file: everything inside the backticks that open its value, spaces included, else its first word,
without the trailing `.`, `,`, `;`, `:`, or `)` that ends a sentence, as in `Handoff file: <path>.`.
The whole value must be an absolute path in the state folder's `dispatch/` that ends in `.json`; prose after it is not read.
A marker that names no path, or a path that is not one, such as `<state>/dispatch/...` left unexpanded or a relative
path, cannot be filled by the hook. Unless this run wrote a regular file there, by the transcript's start time, the agent
is sent back once, on the first stop of its turn, with the marker and the reason, and with no "write it now" for that
path even when its report claims it: it writes nothing at that path, which may lie outside the
dispatch folder, and hands back its report as its last message, saying that the brief's path was rejected, so its
dispatcher corrects its briefs.
Only the files these markers name are owed, and a brief with no marker owes none: the agent still writes its own file,
and the hook no longer searches the brief's prose for one, since a file named to read there could be taken for the output.
Another file of the agent's role the brief names, such as the gate run's `<branch>-gate-product-manager.json` to read,
is never written, whether it is there or not.
In a project run's issue session, a file is owed only when the unattended write guard would let that session write it:
one named for its own issue's branch that no other issue of the run spells alike, and none when its issue cannot be read.
So one issue's report never replaces another issue's handoff.
A file a marker names must exist when the agent stops: an absolute path in the state folder's `dispatch/` whose file name ends with the agent's name,
or with it and one more word, such as `<state>/dispatch/feat-12-S1-code-reviewer.json` or `S1-code-reviewer-result.json`
for `code-reviewer`. A branch name that holds the agent's name does not make another agent's file its own. When one does not,
the hook writes the agent's final report there: the message of its last handback call (Claude Code's `SubagentHandback`)
when no text follows it, else its last message. A report that is a JSON object, alone or as its one fenced block, is
written as that object; any other report as `{ "written_by": "stop-hook", "report": "<text>" }`. A file that appeared
in the meantime, such as one its dispatcher wrote, is kept. A file counts as written by this dispatch only when it is a
regular file changed at or after the subagent's transcript began, by the timestamp of its first entry: one an earlier
dispatch of the same name left, a link, or a folder is stale and owed, and the hook replaces it with the report through
a new temporary file renamed over it, so a link is replaced, never followed, and the file it named stays as it was; a
folder stays owed.
A transcript with no timestamp keeps the older test, that the file is there.
So a brief that names the file for an agent with no file tool
or shell, or makes it optional, costs no send-back, and the report also no longer counts as naming a missing file.
The hook sends the agent back once, on the first stop of its turn, to write the file only when it has no report to write.
While a background task of its own still runs and a later stop is sure to come, that stop is no end of its work, so the
file is not due yet. A later stop is sure while a running task is one whose end starts the agent again after it ended its
turn, or while the [background check](#background-check) sends it back; this is decided apart from that check, which
still sends the agent back for a shell. On Claude Code a background shell's end notice and a background agent's report
each wake it ([Background agents](providers/claude-code.md#background-agents)), so the file waits for the stop after the
wake, even past the check's cap. The file is then neither a send-back reason, an occurrence of the lesson, nor `missing`
on the row, which says `delivered: pending` and leaves it out of `paths`, even when the report names it on a delivery line; another path the report names still counts. Such stops
once made most of the lesson's occurrences, though the next stop wrote the file. A stop let end with only tasks that
nothing wakes the agent for, such as any task on a host that declares no wake, may be its last, so the hook writes the
file then. A shell that never ends, such as a dev server, never wakes the agent either, and its file waits for a stop
with that shell stopped. It writes the file only on a stop it lets end: a stop sent back, as for another missing path, has a report the agent will correct, and the file holds
the corrected one. The file is the record its dispatcher reads:
a subagent's handback can reach another session than the one that dispatched it, such as the main session for an agent
a named teammate started, or none once that one has ended. A forked subagent's first prompt is its parent's, so the check finds nothing there.
[dispatch-log.md](dispatch-log.md) describes the rows and `aidrian report`.

## Background check

A subagent that ends its turn goes idle. Claude Code wakes it with a notice when a background shell it started ends,
but a background agent it started, such as a reviewer resumed with SendMessage, cannot hand its report back to an idle
agent, and the work waiting on that report stalls until someone messages it.
So when a subagent stops while one of its own background tasks still runs, the stop hook sends it back, naming each task,
to wait for it in the foreground: poll it with a foreground command whose loop ends on its own before the command's timeout,
and repeat the call until the task ends, or stop it with `TaskStop` when it should not outlive the turn.

One send-back did not hold. A foreground wait that outlives its timeout is moved to the background, so at the next stop it
is one more running task, and some agents answered the send-back by arming a Monitor, another task, and ending the turn.
Claude Code marks every stop after the first send-back of a turn with `stop_hook_active: true`, so that flag cannot count
the rounds. The hook counts them instead, in a file per agent in the hooks' counts folder, `<state root>/hook-counts`,
which no confined session's sandbox may write (`lib/child-send-backs.mjs`), opened without following a link or waiting
on a FIFO, and only as a regular file of the user with one link:
it sends the subagent back at each stop while its task runs, up to 5 times in a row, and says which round it is.
A stop with none of its own tasks running clears the count, and a turn no stop hook started counts from zero.
The stop the cap lets end with the task still running is an occurrence of an [automatic lesson](lessons.md#automatic-lessons)
for the plugin, once per run of send-backs. The count is written before each send-back, and a stop whose count cannot be
written is let end, so the check never loops.

A host that delivers a background agent's report to the subagent that started it after that subagent ended its turn,
and starts it again, declares it in its adapter (`capabilities.wakesOnChildReport`), and the check leaves such a task out:
the agent is neither sent back for it nor an occurrence of the lesson. Claude Code does
([Background agents](providers/claude-code.md#background-agents)): there the send-backs only cost turns, and an agent
with no shell, which cannot wait in the foreground, answered them by handing back before the report came.

The send-back alone did not hold: subagents still ended their turn with a background agent running. So the Agent hook
also rewrites the dispatch before it runs: a call a subagent makes, one whose payload has `agent_id`, runs with
`run_in_background: false` unless it already sets that. A call that leaves the flag out is rewritten too: Claude Code
launches a subagent's dispatch in the background by default. The subagent then gets the child's report as the call's result, and
several dispatches in one turn still run side by side. The main session's background dispatches run as written, since a
background agent's report wakes it. A background shell is left as it is, for a server the subagent polls; the stop hook
still checks it. A host whose agent tool reaches no hook, such as Codex, is not rewritten. Claude Code applies the rewrite
but still runs the dispatch in the background while its fork-subagent mode is on, its default in an interactive session
([Background agents](providers/claude-code.md#background-agents)).

Claude Code's SubagentStop payload lists the session's in-flight tasks in `background_tasks`, without the agent that started each.
A task is the subagent's own only when one of its own calls launched or resumed it, as the structured result Claude Code
stores beside that call's result in the transcript (`toolUseResult`) names it: a Bash call's `backgroundTaskId`, set when
it started in the background or was moved there at its timeout; an async Agent launch's `agentId`; or a SendMessage call's
`resumedAgentId`. A result's text never counts, so a command's output or an agent's report that quotes a launch line claims nothing.
Reading, waiting on, or stopping another agent's task, such as tailing its output file, does not make it the subagent's own.
A peer teammate is never a child: a message wakes it. A payload without `background_tasks`, such as Codex's, checks nothing.

## Announced work

When the main session ends a turn on a message whose last paragraph announces work the AI is about to start, and does
not start it, the Stop hook sends it back once: nothing wakes the session until the Human writes, so the Human would wait
on work that never begins. The agent does the work, asks the Human with the question tool when it needs a decision first,
or ends the turn again when the message only reports work done or work that something else wakes it for.
It sends a turn back at most once, as each Stop check does ([Send-backs per turn](#send-backs-per-turn)).

These phrases count, in any case, where the AI is its name from [names](config.md#names), "I", or "we":

- "unless the Human says otherwise", "unless told otherwise", "unless the Human objects";
- "starting now", "proceeding now", "starting on it now";
- "Claude will now", "I'll start", "Claude will proceed", "we're going to begin";
- "Next, Claude writes", "Next up: Claude will", with one of a short list of verbs.

It does not fire when the last paragraph ends with a question mark, waits on the Human ("once the Human approves",
"waits for the Human"), or names another actor, or when the payload lists a background task still running, whose end
wakes the session on its own. A question tool call earlier in the turn exempts nothing: the call waits for the Human's
answer, so a turn never stops on it, and an announcement written after the answer stalls the same.
The message is the payload's `last_assistant_message`, else the last turn of the transcript.
It runs before the session-length reminder, which writes its marker only when it fires, so a reminder due on the same
stop comes at the next one. A payload without `stop_hook_active` does nothing. `lib/stop-announce.mjs` holds the phrases.

It runs on both hosts, from the same `hooks.json` entry. Claude Code is verified live. On Codex, the Stop input's
`stop_hook_active` and `last_assistant_message`, and exit 2 with stderr as the continuation prompt, come from the
0.167.0 binary, and no live session has run it: [codex.md](providers/codex.md#hooks).
Codex's transcript is not read, so there the message is the payload's alone;
the reason names the question tool as each host's model calls it, `AskUserQuestion` or `request_user_input`.

## Review-loop check

When the main session ends a turn that opened or updated a draft pull request and ran no review after it, and config.json
[`github.reviewLoop`](config.md#keys) is `"auto"`, the default, the Stop hook sends it back once (`lib/stop-review-loop.mjs`).
A direct run of a skill such as `issue-implement` ends at the draft and its report, so a turn that stopped there left the
review loop, marking the draft ready, and [auto-merge](config.md#auto-merge) undone. The agent runs the `pr-review-loop`
skill on the pull request as the session's own step, or ends the turn again when a skill or agent that runs its own loop
owns the pull request, when none was opened or updated, when the run is stopped on a question only the Human can answer,
or when the Human asked the run to stop at the draft. It sends a turn back at most once, and the stop that ends the
continuation still runs the checks that have not sent it back: the merge hand-back check on a refusal there, and the
hand-back check on the report ([Send-backs per turn](#send-backs-per-turn)).

- The turn is what the transcript holds since the Human's last prompt: a `user` entry that is a prompt, not `isMeta`,
  `isSidechain`, or `isCompactSummary`, with no `origin` or `origin.kind` `"human"`, or a message the Human typed while
  the agent worked, which Claude Code writes as a `queued_command` attachment. A task notification marked with its own
  `origin.kind` is not the Human's prompt; a peer session's message with no `origin` reads as one, which only narrows the
  turn and keeps the check silent. With no such prompt, the whole transcript is the turn. A draft opened before the
  Human last wrote, such as before a request to stop, never counts.
- A draft is a `gh pr create` with `--draft` whose result is no error and names a pull request URL, or a `gh pr edit`
  that ran after a `pr-write` run, a Skill call whose result is no error or a typed slash command.
  A `pr-write` run that published nothing, such as one stopped on a failed check, is no draft.
  A `pr-write` update of a pull request reviewed earlier in the turn is the loop's own, such as copying residuals into
  the body before it marks the draft ready, and is no draft either, even when the turn started at the loop on a pull
  request from an earlier turn. A draft create after a review is a new pull request and counts, and so does an update
  of another pull request.
- A review is a `pr-review-loop` Skill call that ran, or such a typed slash command, or an `aidrian pr review` or
  `aidrian pr await-review` call whose result printed its JSON, or that sent its output to a file (`> r.json`).
  A call that sends it to a file prints no JSON, so it counts, of each pull request it was given, only when the call
  ended with no error, or stopped on a question only the Human answers (`human_required` 9, `extension_ask` 11).
  Any other nonzero exit, a round stopped at `extension_check` (10) or a file the shell could not open, leaves the
  turn a step to run, so a send-back is right; the exit is the whole call's.
  A call run in the background has only its launch as its result,
  so it settles neither a review sent to a file nor a merge. A `pr-review` run is none: it is the integration
  review `issue-implement` runs after the draft, and the loop still follows it. The health report still counts it.
- Each draft and review is of the pull request the transcript shows: a create's printed URL, an edit's target or its
  printed URL, the loop's first argument, and the `pr` each review command printed, else the one it was given, as its
  last `--pr` or its first word that is no option or an option's value.
  A draft is owed when no review of its pull request follows it in the turn: a review before it, or of another pull
  request, leaves it unreviewed. A `gh pr merge` of its pull request that ran after it settles it too: a merged pull
  request owes no review, and a merge that names none (the current branch's) settles any.
  A draft or a review whose pull request the transcript does not show matches any, since
  a false send-back costs more than a missed one: a loop run with no argument counts for every draft before it.
  The one send-back names each draft still owed, by its number, or as a draft with no number shown.
- `"ask"` turns it off, and the transcript is then not parsed for it. A background task still running holds it, as it
  holds the announce check: its end wakes the session.
- A subagent's calls are not read, so a draft an `orchestrator` opens is its own loop's.

It reads Claude Code transcripts only (`lib/transcript.mjs` `turnActions`); on Codex, whose rollout is not read, it is silent.
It runs after the announce check and before the merge hand-back check.

## Merge hand-back check

When the main session ends a turn in which [`aidrian pr auto-merge`](config.md#auto-merge) refused a pull request because
it changes a path the gate never merges, and no report of the turn hands that pull request to the Human, the Stop hook
sends it back once (`lib/stop-handback.mjs` `mergeHandBack`). The gate stopped at its path check, before its author,
comment, and review checks, so the pull request waits for the Human's review and merge, and a report that ended on
"ready, not merged" left the Human to find that out. The agent adds the item the `pr-auto-merge` skill's step 2 gives,
`needs your review and merge: #<n> touches <path>, which auto-merge never merges`, with the Human's name in place of
"your", and a rating. It sends a turn back at most once ([Send-backs per turn](#send-backs-per-turn)).
It runs on the stop that ends a continuation another check started too, such as the review loop a direct run runs after
the review-loop check sends it back, where `pr-auto-merge` refuses the pull request; a refusal that send-back held off,
earlier in the turn, is read there as well.

- A refusal counts when the gate's line reads `auto-merge off for #<n>: it changes "<path>", …`, or its `--json` object
  has `effective` false, `reason` `"paths"`, and a `why` of that shape: a guarded path, a policy file, a file the gate
  reads its policy from, the release script, a knowledge doc the start hook loads, or a file outside the project's folder.
  A refusal for a rename, a file count, or any other reason names no path and does not count.
- The gate counts only as a Bash call that runs `aidrian pr auto-merge`, by any path to aidrian. Its verdicts are read
  in order, each for the next gate command that could print it: one given that pull request, or one given none, which
  reads the current branch's. Fewer verdicts than gate commands count, as in `aidrian pr auto-merge && aidrian pr
  auto-merge 58`, where the first refusal exits 1 and the second gate never runs. Two gates on one pull request, a
  retry, print two verdicts, and the later one stands. A verdict no gate is left for is another command's: one for a
  pull request no gate names is dropped; one a gate could have printed drops that pull request's verdicts, or every
  verdict when a gate was given none. It is read after the lines that quote the command are dropped, as a refusal
  quoting it shows: a line holding the whole command or its first line, or equal, trimmed, to another of its lines.
  An `echo` of the line, an error exit with no verdict, and a path that holds the command text count as no gate run.
- The last gate run or merge of each pull request in the turn counts: a later run that passed, or refused for another
  reason, and a `gh pr merge` of that pull request whose result is no error clear an earlier refusal. `gh pr merge` with
  `--help`, `-h`, `--auto`, or `--disable-auto` merges nothing and clears nothing. A merge with no target, or one this
  cannot read as a number, counts for the number gh printed in its `merged pull request` line; gh prints that line on a
  terminal only, so one that printed no number clears a refusal only when it is the one refusal that stands then.
  A refused or failed merge clears nothing.
- The turn is the one the [review-loop check](#review-loop-check) reads: since the Human's last prompt. A refusal before
  the Human last wrote never counts.
- The item counts in any reply of the main session after the refusal in the turn, or in the final message, as an item of
  a list addressed to the Human, as the [hand-back check](#hand-back-check) reads one. It holds the pull request as `#<n>`,
  `/pull/<n>`, `PR <n>`, or `pull request <n>`, with no digit after it; the path as the gate quoted it, or as the reason
  quotes it, or its first 200 characters when longer; and one of the hand-back check's ratings. The wording is not
  matched, so the named form passes. A sentence outside such a list does not. A wake, such as a task notification,
  does not start a new turn, so a report before it still counts, and a short reply after it with no item before it is
  sent back.
- With several pull requests refused and not handed over, the one send-back names each, with its path, and asks for
  one item per pull request: after it the check is spent for the turn.
- The path is branch text. The reason quotes it as one JSON string that holds printable ASCII alone, every other
  character and `<`, `>`, and the backtick written `\uXXXX`, cut at 200 characters, and calls it data.
- A background task still running holds it, as it holds the announce check, and so does a stop with no final message.
- It has no switch and follows no `github.reviewLoop` setting. The transcript is parsed for it only when it holds a
  refusal as the gate prints it.
- A subagent's calls are not read, so a gate an `orchestrator` runs is its own report's to hand over.

It reads Claude Code transcripts only (`lib/transcript.mjs` `turnActions`); on Codex, whose rollout is not read, it is silent.
It runs after the review-loop check and before the hand-back check, since its item carries the rating that check asks for;
the hand-back check still reads the report that adds the item.

## Hand-back check

When the main session ends a turn on a message that lists items for the Human and any item says nothing of how critical
it is, the Stop hook sends it back once (`lib/stop-handback.mjs`). Such a list once handed the Human work no agent had
tried. The agent tries each item first, through its owner, and keeps only real blocks that only the Human can clear,
such as a permission, a credential, or a product decision. Each block that stays says what is needed, why no agent can
do it, and how critical it is. It sends a turn back at most once ([Send-backs per turn](#send-backs-per-turn)).

- A list counts when a label addressed to the Human comes before it: a heading, a bold line, or a line that ends in a colon,
  such as "For Adrian", "Needs the Human", "Open items for the user", "Waiting on Adrian", or "Adrian's to-do", where the
  Human is the name from [names](config.md#names), "the Human", "the user", or "you". Text after the label's colon is an item too.
- An item is a top-level list entry with its continuation lines. The list ends at a heading, or at a paragraph after a blank line
  that is neither an entry nor indented under one.
- A fenced code block, read as the pull request body rule reads one (`lib/markdown-sections.mjs`), is skipped:
  a Markdown example the message quotes is not work handed back, and a code block inside an item does not end its list.
- An item counts as rated when it holds one of blocking, blocker, critical, high, medium, or low, in any case.

The announce, review-loop, and merge hand-back checks run first; a stop any of them sends back is checked here at the
stop that ends its continuation, unless this check sent the turn back already.

## Send-backs per turn

The announce, review-loop, merge hand-back, and hand-back checks each send a turn back at most once.
Claude Code marks every stop after a turn's first send-back with `stop_hook_active: true`, and writes each send-back's
reason into the transcript as a `user` entry marked `isMeta` whose text starts `Stop hook feedback:`
(`lib/transcript.mjs` `turnActions`). On such a stop the hook runs the checks that have not sent the turn back yet,
when the turn's last send-back is one of theirs. A send-back is a check's when a line of it starts with that check's
reason's fixed opening, after `Stop hook feedback:` or the `[<command>]: ` the host writes before a reason, when it
writes one. Text a reason quotes, such as a pull request's path or an item of the report, sits inside its one line,
so it marks no check. So the stop that ends the continuation one check
started still checks its report: after the review-loop check sends a direct run back to run `pr-review-loop`, a path
refusal by `aidrian pr auto-merge` that the continuation's report leaves out is sent back, and so is an unrated item for
the Human; after the announce check, a draft the continuation opens with no review is sent back.
A stop whose last send-back is another hook's, the session-length reminder's, or the [result hold](config.md#project-run)'s,
which runs only on a stop no hook sent back, a transcript that shows none, a payload
without `stop_hook_active`, and Codex, whose rollout is not read, run none. Each send-back is in the transcript by the
next stop, so a chain of stops gets at most four from these checks, and nothing can loop.

## Session length

Two hooks weigh what continuing the main session costs against a fresh session started from a handoff brief.
[handoff.md](handoff.md) has the cost model, its re-arming rule, and the config.

- When the main session ends a turn, the Stop hook reads its transcript. Once each call costs `session.handoff.costRatio`
  times what it would in a fresh session, or the context passes the optional `maxTokens` ceiling, it sends the agent back
  for one more turn, with the ratio and the calls a handoff needs to pay back. The agent judges first whether a handoff
  is worth it, and may end the turn without a word; otherwise it asks the Human (`ask`) or writes the brief (`auto`).
  It fires once, then again once the ratio doubles in `ask` mode, or climbs a step of `max(costRatio − 1, 1)` in `auto`:
  a marker in the hooks' counts folder, `<state root>/hook-counts`, holds the ratio of the last firing, and a compaction
  resets it.
- When the Human approves a plan (Claude Code's `ExitPlanMode`), the plan hook tells the agent to offer the same handoff
  before its first build step, from halfway to `costRatio`: a cost ratio of 1.5 by default.
- Both word the handoff for the [continue route](handoff.md#continue) the session's host can do. With `clear`, `auto`
  runs the `session-handoff` skill, whose continue step arms the continuation, and ends the turn, and `ask` names what a
  handoff then takes from the Human. With `background`, `auto` does the same and says a new session goes on in the
  background while this one does nothing more, and a Human who is not watching is no reason to skip it; `ask` says
  nothing is typed, and still counts a Human who is not watching. A background route this machine or the base branch
  has not turned on is worded as the clear route the gate falls back to, read only on a stop that fires.
  With `none`, or a route the host does not list, the text is as above.
- Both price a fresh session with this project's resume tokens, and the Stop hook records a sample for each session
  that resumed from a brief, once, at its first stop after its first edit or dispatch, in any `mode`
  ([Resume tokens](handoff.md#resume-tokens)).

Both read Claude Code transcripts only: a transcript with no Claude Code usage, a subagent, or a payload without
`stop_hook_active` does nothing.

## Session ledger

After a Bash command, `scripts/hook-bash-post.mjs` appends a row to the session's pull request ledger,
`<state>/sessions/<session id>/prs.jsonl`, for each pull request the command created, pushed a branch of, or acted on.
`aidrian session snapshot` reads it, as display data only: no hook, gate, skill, or agent decides anything from it.
A subagent's call carries its parent's session id, so a dispatched slice lands in the same ledger, with its `agentId`.

A row is `{ at, agentId, kind, forge, host, path, number, branch, cwd }`, and never a link, command text, or output.
`forge` is the forge adapter's `id`, `host` and `path` the repository as `repoIdentity` reads it, or `remoteIdentity` for a remote's URL, and `cwd` the folder
the call ran in. A row is written only for a host the adapter declares (`hosts`, github.com today), and only when the
adapter's `changeRef` takes its fields: a path of exactly `owner/name`, a positive number, and a branch that passes
git's ref-name rules within 255 bytes and holds no hidden character. `cwd` is absolute, within 1,024 bytes, with no
hidden character: none of the Unicode categories Cc, Cf, Zl, Zp, and Cs (`lib/hidden-text.mjs`, the pattern the
snapshot's `displayText` removes). One call writes at most 32 rows and has git read at most 8 folders.

| Kind | From | Its repository and pull request |
| --- | --- | --- |
| `created` | `gh pr create`, never with `--dry-run`, which creates nothing | A line of the output, from its last 64 KB, that is exactly a pull request link. Its repository must be the one `-R` or `GH_REPO` names, else one of the repositories the remotes of the call's folder name, so a fork's pull request on its parent records the parent and an echoed link of another repository records nothing. The output is read only when `gh pr create` is the line's one command, after a leading `cd` or bare variable assignments, with no other command that could print, so `git -C <folder> status; gh pr create` records nothing: a `cat` with no redirection inside a substitution, such as a heredoc body, is the one other command allowed, so `gh pr create && echo <link>` records nothing |
| `pushed` | `git push` | What git itself recorded, not the command's words: each remote-tracking ref whose reflog, `<git common dir>/logs/refs/remotes/<remote>/<branch>`, ends in an `update by push` entry written within the last 60 s (`PUSH_WINDOW_MS` in `lib/git-push.mjs`) whose new commit is the HEAD commit of the call's folder, so git's own remote selection, `push.default`, `remote.<name>.push`, and refspec mapping decide the branch, and `git push origin HEAD && git switch main` records the branch pushed. The branch is the ref's path after `<remote>/`, the remote the configured one whose name, the longest, starts that path, and the repository that remote's first `remote.<name>.pushurl` when one is set, so a push to a fork records the fork and a push URL that names no repository records nothing, else its first `remote.<name>.url`. Logs older than the window by their mtime are skipped, a symlink is never followed, and only each log's last line is read, from its last 4 KB, 4,096 entries at most. A push to a URL that no remote names, a tag, a delete, and a dry run update no remote-tracking ref, and a reftable repository keeps no such log, so they record nothing, an accepted limit. Every worktree of a repository shares those logs, so the HEAD commit keeps another worktree's push out; a push of a branch other than the one checked out, such as `git push origin other`, records nothing for the same reason, also accepted, and so is a sibling worktree's push of that same commit within the window. A push an earlier call made within the window is read again, also accepted, and its repeat is left out as below |
| `touched` | `gh pr ready`, `edit`, `merge`, `checks`, `view`, `comment` | A link names its own repository. A number, a branch, or no target takes the repository `-R` or `GH_REPO` names, else the one repository on a declared host the folder's remotes name, and nothing when they name several, as in a fork checkout. No target is the folder's current branch, or the pull request gh checked out on it, as its `branch.<name>.merge` of `refs/pull/<n>/head` names, and nothing when a later command on the line runs `git checkout`, `git switch`, or `git worktree add`, since the branch is read after the line. An `owner:branch` target is that branch of the owner's repository of the same name, gh's fork |

A bare `owner/name` in `-R` or `GH_REPO` names nothing while `GH_HOST` is set, since gh then reads it on that host.
A remote whose URL git reads as a path on this machine, a `file:` URL or one with neither a scheme nor git's `host:path`
form, such as `archive/widgets`, names no repository (`remoteIdentity`, as the snapshot reads origin), so no call or
push records it.

The call's folder holds under either reading of the payload's `cwd`, the folder the line started in or the one it
ended in, which no host documents for a Bash call ([Claude Code](providers/claude-code.md)): it is the absolute folder
a leading `cd <folder> &&`, `git -C`, or `env -C` names, as `lib/shell-lex.mjs` reads it, or a leading `cd <folder>` that
`;` or a newline ends, as in `cd <folder>; gh pr create` or `cd <folder>; git push`, when the line's own text opens,
after any blank or comment lines, with spaces or tabs, `cd`, and one unquoted absolute folder of plain characters with no `.` or `..` part, then `;`, or a
newline after an optional comment, so no option, redirection, heredoc, wrapper, or other character stands in it, and that folder
is a directory the hook may search just after the call, so the `cd` cannot have failed: after a failed one the
commands ran in the folder the line started in, which no row then names; the payload's `cwd` only on a
line where no command, a nested one included, runs `cd`, `pushd`, or `popd`, plain or through `builtin`, and nothing
else moves the call; and
otherwise none, so the call records nothing. `cd sub && gh pr create`, `cd /gone; gh pr create`, `cd <folder> & gh pr view`,
and `git push && cd /other` record nothing.
The current branch is read with `git symbolic-ref`, the remotes' `url` and `pushurl` and branches' `merge` with one `git config --get-regexp`, and, on a line that runs `git push`, the git common dir with one `git rev-parse --git-common-dir` and the HEAD commit with one `git rev-parse HEAD`, in that folder: no word of the line or value of the ledger reaches git's arguments.

What may point a call at another repository records nothing: a folder, repository, or target the shell
fills in, a word it fills in unquoted anywhere in a `gh` call, since it may split into a second `-R`, a line that sets,
unsets, or empties `GH_REPO` or `GH_HOST` outside the call's own prefix, a git global option other than `-C` and plain
switches such as `--no-pager` (so `-c`, `--config-env`, `--git-dir`, and `--work-tree`), and a line that changes
`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_NAMESPACE`, or a `GIT_CONFIG` variable, or reads a shell file into the
shell with `source` or `.`, which may set any of them.
A `url.<base>.insteadOf` rewrite in the folder's config is not applied, an accepted limit: such a remote records its
URL as written.

The forge seam: `scripts/hook-bash-post.mjs` and `lib/session-prs.mjs` name no forge. The reading of `gh pr` calls,
`GH_REPO`, and the pull request link is GitHub's, in `lib/rules/github/session-calls.mjs`, which runs nothing; the hook
hands it to `session-prs.mjs` in a table keyed by the adapter's `id`. A later forge adds its reader under
`lib/rules/<forge id>/` ([Adding a forge](providers/adding-a-host.md#adding-a-forge)).

The output comes from the host's adapter, its `shellOutput`, never from a payload field read in shared code: Claude
Code's `stdout`, Codex's one string of output, and OpenCode's `output.output`, the text of its shell tool's result.
A response the adapter cannot read gives no `created` row, while `pushed` and `touched` rows still record. A call the host reports as interrupted, a session id that fails `SESSION_ID`,
a payload folder with no project, and input the hook cannot read write nothing. The hook never refuses, always exits 0,
and prints nothing on stdout or stderr.

The folder and its file follow [the session folder's rules](project-folder.md#local-state): `lib/session-folder.mjs` makes the
folder 0700, refuses a symlink, and, when it makes one, sweeps the session folders untouched for 30 days. As for the
snapshot, a state folder inside any checkout of the repository, or one git could not list the checkouts for, or one
that, with a folder above it, fails the rule `heldFolder` sets, gets no folder, so the call records nothing. Its
`appendSessionFile` checks the folder again, as every write does (`boundFolder`), so a folder above it swapped for a
symlink since gets nothing, then opens the ledger write-only, append, create, no-follow, and
non-blocking, mode 0600, and writes only when the open file is a regular file with one link that this user owns and no
other user may read or write. Before a write it reads the ledger's last 256 KB, no-follow, as the snapshot does, and leaves out a row whose folder
is not a folder on disk, and a row whose fields, all but `at` and `agentId`, the newest row of its pull request or
branch holds, when that row was written within the last 60 s (`REPEAT_WINDOW_MS`), so a call made again at once adds
nothing. Any other repeat is written with its new time, so a touch, a push, then a touch again of one branch writes all
three and the branch resolves as its last call did, and a
pull request acted on again shows first again and stays among the 25 the snapshot shows while newer ones come.
The ledger stays within 256 KB (`LEDGER_MAX_BYTES` in `lib/session-prs.mjs`, the most the snapshot reads: it reads the
last 256 KB, so it reads every row, and drops a first line the cut fell inside if an older writer left the ledger past
the cap): a write that would pass it, or that finds the ledger past it, rewrites the ledger, through a temporary file
and a rename under the same checks, with the newest of the new rows that fit in the cap, after the newest rows of that
tail that fit in what is left and in half of it at most, so the file never passes its cap and the newest pull requests
always show. Each write, append or rewrite, is one step no other writer of the file runs beside: it holds the file's
reservations (`<file>.<window>.lock`, `reserveSessionFile`) for the 5-second window that holds its start and the next
one, and a second writer waits up to a second for them, so two hooks of one session that write together within that
second lose no row. These are the accepted limits, for display data: a writer that waits past its second, as while a
killed writer's reservations hold their two windows, writes nothing and its row is lost, and the hook does not try
again; and a writer paused for more than both windows, past the hook's own timeout, may rename a compaction over a
later append. A write after a line cut short, as a killed writer leaves it, starts on a new line, so the new row is
read and only the cut one is dropped. The `SessionEnd` hook and worktree
cleanup leave it alone, so a resumed session keeps its pull requests.

The snapshot also reads the ledgers of the sessions a handoff came from, through the `parent` each chain floor names
([Across a handoff](handoff.md#across-a-handoff)): at most 5 of them, the last 64 KB of each, from a folder it finds by
the full id and never creates. Of those it keeps only `created` and `pushed` rows on a repository the project's remotes
name, written at or before the hop, and it reads no further ledger once it holds 25 refs. A row more than 60 seconds
ahead of the snapshot's clock, of any ledger, is dropped when read.

The same hook records the worktree a session creates, in a second file, `<state>/sessions/<session id>/links.jsonl`:
one row `{ at, kind: "worktree", host, path, branch, cwd }` for each worktree an `aidrian worktree new <branch>` of a
shell call created. It reads the command with `lib/shell-lex.mjs` (`lib/session-links-writer.mjs`), and a word the
shell fills in, a branch or an option it does not know that starts with `-`, or `--plan`, records nothing. A row also
needs the command's own result in the call's output: the one JSON line `aidrian worktree new` prints, whatever happens,
here with `status: "created"`, that branch, and an absolute `worktree_path`, read from the output's first 64 KB. Each
result is matched to its own call by its place (`worktreeCalls` and `createdWorktrees`): the line must open with bare
assignments and `cd`s the walk leaves out, joined by `&&`, `;`, or a newline, then one or more calls joined by `&&`, so
nothing prints before the first call, each call runs only once the one before it succeeded, and the nth JSON line with a
`status` is the nth call's.
From the first call to the end of the line, every command is joined to the next by `&&`, a pipe allowed inside a
command after the calls, and only a `;` or a newline may end the line, so no command after a call runs unless that
call succeeded.
What follows the last call may print anything, so `aidrian worktree new <branch> && npm test` records its worktree, and
`aidrian worktree new <a> && aidrian worktree new <b>` records both, in order.
A line with `;`, `||`, a newline, or a `&` after its first call records nothing, as
`aidrian worktree new <branch> && npm test || cat <saved result>` would let a saved result take the place of a call
that failed and printed nothing.
Pairing stops at the first result that is neither created nor planned: that call failed, and no call after it ran.
A call piped elsewhere or whose output is redirected records nothing, with any call after it, and so do a negated
call and every call after a substitution other than a plain `cat`, whose error output the shell does not capture.
So a call that was skipped, as after `false &&`, refused, as for a branch already checked out, or printed nothing
records nothing, and neither does an echoed or replayed result, such as
`echo '<saved result>'; aidrian worktree new <branch>` or `aidrian worktree new <branch>; cat <saved result>`.
Claude Code runs `PostToolUse` only for a Bash call that succeeded, so there a worktree is recorded only when the whole
line succeeded; on Codex, which runs it either way, a line that failed after its calls still records them.
Within that rule an existing worktree is not recorded as one the session made, but the output is what the
host hands the hook, which the model's own shell call shapes: a call made to print a forged result, such as a wrapper
named `aidrian`, can still claim one. That is accepted for display data. Each command is looked up in the folder it ran
in by the ledger's rule (`knownFolders`), which holds whether a host's payload names the folder the line started in or
the one it ended in: the folder an absolute leading `cd` names, else the payload's folder only when nothing on the line
changes directory; after a relative `cd`, a `cd` the walk cannot follow, or in a folder with no project, it records
nothing. It is filed in that folder's project's session folder. `cwd` is the worktree's path as `git worktree list`
prints it in that project's main checkout, read after the call, so the snapshot compares two spellings by git; it must
be the folder the result names, through any symlink, and a branch git lists no worktree for, lists as prunable, or
holds in the main checkout records nothing. `host` and `path` are origin's repository read from the raw
`remote.origin.url` in the folder the command ran in, so an origin only that checkout's own config sets
(`config.worktree`, `includeIf.onbranch`) is the one recorded, as the snapshot there reads its remotes; a
`url.<base>.insteadOf` rewrite applies on neither side; both null with no origin. Every step of the links, finding the
project, its main checkout, origin, the list, and the session folder, for every call of the line together, shares a
1-second budget, each git read stopped by SIGKILL at what is left, the check whether git tracks the main checkout's
`.aidrian.local.json`, which finding a project makes when that file sets a machine switch or
`review.productFeedback.auto`, among them, and runs after the ledger's row is written and apart from it, so a git that stalls neither
passes the host's 5-second hook timeout nor loses the call's ledger row. Every field is checked as the reader checks it, and the row is filed under
the payload's session id, so a subagent's call lands in its session's file. The command itself writes nothing, and its
output and exit code are its own ([Session links](providers/adding-a-host.md#session-links) says why the hook and not
the command is the writer). `links.jsonl` keeps to 64 KB under the ledger's rules, through the same append
(`appendRows` in `lib/session-rows.mjs`), but with no key: every row is appended, and the reader settles repeats. Its
read-time key is `host/path:branch`, or the branch alone with no origin, and for each key the row with the newest `at`
decides, the later line on a tie. That differs from the pull request ledger on purpose: the ledger leaves out a repeat
within a minute of the row it repeats, so that row keeps its `at`, while a repeat after the minute is written with its
new `at`, and the snapshot orders its refs, and the tickets their rows, by the latest, each session's rows before the
keys of its own pull requests; `links.jsonl` keeps every row, so its newest `at` is the real latest, which a worktree
that went needs.

A `created` or `touched` row records what the command line names, not what each command did. Claude Code runs
`PostToolUse` only for a Bash call that succeeded, but one command's status inside a line is not seen, so
`gh pr view 12 || true` records its row, and on Codex a shell call that exits non-zero still runs `PostToolUse`. A failed
push leaves no record of its own, so it records nothing. A row whose branch has no
pull request shows nothing.

Where it is verified:

| On | Verified | Not live |
| --- | --- | --- |
| Claude Code | `test/hook-bash-post.test.mjs` runs the hook on `test/fixtures/hosts/claude-code/bash-post.json`, whose `tool_response` is the result Claude Code 2.1.326 recorded for a real `gh pr create` Bash call | No hook has received that payload, an accepted limit: a session may not start another to record one, and the fixture says `live: false` |
| Codex | The same test runs `test/fixtures/hosts/codex/bash-post.json`, built from the source at `rust-v0.169.0` | Any hook on Codex, which runs only after a person trusts it |
| OpenCode | The same test runs `test/fixtures/hosts/opencode/bash-post.json`, the payload the bridge sends, built from the types of `@opencode/plugin@2.4.0` and the source embedded in the 2.4.0 binary; `test/opencode-bridge.test.mjs` runs the bridge against the real hook | Any hook on a live OpenCode: no live shell payload has been recorded ([OpenCode](providers/opencode.md#hooks)) |

What the Codex source says, at `rust-v0.169.0`: a shell call reaches the hook as `Bash`, with `tool_input` `{ command }`
(`codex-rs/core/src/tools/handlers/unified_exec.rs`, `post_unified_exec_tool_use_payload`); its `tool_response` is the
command's output as one string, stdout and stderr together; and a call still running or stopped sends no `PostToolUse`
(`codex-rs/core/src/tools/context.rs`, `ExecCommandToolOutput`). The payload's fields are `PostToolUseCommandInput` in
`codex-rs/hooks/src/schema.rs`. The group comes last in `PostToolUse`, so the trust keys of the tracker hooks,
`pre_tool_use:5:0` and `post_tool_use:3:0`, do not move.

## Check runs

A report once said a full suite passed, 4071 of 4071, after the runs behind it were stopped before they ended; the real
result was 40 failures. So a result a report states must be one a tool returned, and the plugin keeps the record that shows it.

After each Bash call, the PostToolUse hook appends a row to the session folder's `checks.jsonl` for each test run on the
command line's top level that the call finished (`lib/check-runs.mjs`): its command, the agent whose call ran it
(`agentId`), two git trees of the checkout's files as they are when the run ends, one with the untracked files git does
not ignore and one with the tracked files alone, each null when git cannot read it, the untracked code and test files
beside the run (20 at most), its pass and fail counts, and `passed`, `failed`, or `unjudged`.
A test run is a command of config.json [`testing.fullSuite`](config.md#testing) or `testing.changedCommand`, `npm test`
and its pnpm, yarn, and bun forms, `node --test`, vitest, jest, pytest, `go test`, `cargo test`, `mix test`, rspec,
`make test`, `make check`, or `aidrian test changed`, read through wrappers such as `rtk`, `timeout`, and `npx`, with
redirects dropped. A project's own script, such as `npm run check`, counts once `testing.fullSuite` names it.
A call stopped, started in the background, or moved there at its timeout records nothing: no hook sees it end.
A line of only programs that run no tests, such as git and grep, reads no config and records nothing.

Claude Code runs the hook only for a call that exited 0, so there a run passed unless its counts show a failure, when
the line's status is the run's: no separator but `&&` before or after it. After `;` or `||` the run may not have run,
or another command's status is the line's. Such a run, a run behind a pipe, and every run on Codex, which runs the hook
for a failed call too and sends no exit status, is judged by its counts alone: passed with a pass count above 0 and a
fail count of 0, failed with a fail count above 0, and `unjudged` when it printed no count. A counts-only verdict reads
the runner's summary, not the command's exit, so a script that runs the tests and then fails a later step reads as
passed there: an accepted limit until a host sends an exit status.
The counts come from one family of summary lines, summed over every line of it and never added to another family's,
since a script or a monorepo tool prints one summary a runner: the first of node's runner summary (`ℹ pass 12`,
`# fail 0`); `Tests` lines, as vitest and jest print them, also behind a task prefix such as turbo's `web:test: `;
cargo's `test result:` lines, one a test binary and the doc-tests; `go test -v`'s `--- PASS: TestX` and
`--- FAIL: TestX` lines, one a top-level test, subtests left out, with at least one failure a package that failed, so a
package that did not build, a test binary that timed out, or a TestMain that exited 1 after its tests passed fails the
run; else, since go test prints no pass count, its package lines, `ok  <package>  0.01s` and `FAIL  <package>  0.01s`,
one a package, where a package whose tests were all filtered out (`[no tests to run]`) or that has none counts no
pass, as a `-v` run whose tests were all skipped counts none; go lines that count nothing, `-v` or not, leave the
counts to a later family, and with none, the run counts 0 passes; any other line with "N passed" or
"N failed", as pytest's and Playwright's; rspec's and mix's "12 examples, 0 failures". A family that names passes and
no failure counts 0 failures. Unless node's runner counted, whose fail count stands, a line that is only "N failed"
above 0, colours stripped, as Playwright's own `1 failed` line, makes the run failed; a test named
"lists 2 failed payments" never does. The counts read the last 64 KB of the output. When Claude Code keeps a stdout too
long for the payload in a file (`persistedOutputPath`), and sends only its head, the counts read the last 64 KB of that
file, then the stderr. The file is read only when it is a regular file by `lstat`, never a symlink or a FIFO, in a
`tool-results` folder whose real path is under the real path of Claude Code's projects folder (`CLAUDE_CONFIG_DIR`, else
`.claude` under `HOME`, then `projects`), so a symlinked config folder still counts and a folder linked from elsewhere does not.
It is opened without following a symlink and without taking a terminal, and its descriptor must show a regular file.
Any other path, or a file it cannot read, leaves the head.
The record keeps its newest rows within 64 KB.

Two checks read it:

- The [pull request body rule](#bash-rules) reads the `## Tests run` section outside fenced code, one list item or
  paragraph at a time with its wrapped lines joined, split at `;` and sentence ends. A clause that names a test command,
  in backticks or, for a `testing.fullSuite` command, as plain words, and says it passed (a pass word, a check mark, or
  "N/N"), needs a row of that command that passed with more than 0 passes, at the tree of HEAD in the folder gh runs in,
  or of the commit the clause names, such as "at 056c3c2", and with each pass count the clause states. An id of digits
  alone, as about one abbreviated id in 27 is, names a commit only after "at" or "commit", and only when git knows that
  commit; otherwise it is a number, such as "at 1234567 ms", and is not the commit the clause names. A clause that
  names a commit git cannot read is not judged. A number after a word, as in "Node 22", is no count.
  Either of the row's trees may match, so a run made beside an untracked scratch file
  still proves the commit that leaves it out; the tracked files' tree alone does not count while an untracked code or
  test file sat beside the run, which it may have loaded and the commit lacks, and the deny names that file.
  A clause that names a failure, "not finished", or CI is not a pass claim: a CI result is quoted from the checks the
  forge shows, such as `gh pr checks` on GitHub. A session whose record cannot be read is not judged. The record is this
  checkout's, so a body for another branch is not judged: a `--head` that names another branch, or an edit of a pull
  request whose head is another branch or that the open list cannot show. An edit names its pull request by number,
  URL, branch name (`feat/x`, or `owner:feat/x`), or nothing for the checked-out branch's; a URL counts only as gh
  reads one, with a scheme and host, so `team/pull/3` is a branch name. A branch name is matched against each open pull
  request's `headRefName`, and an `owner:` one against its `headRepositoryOwner` too; when several open pull requests
  fit and nothing settles which, the edit is judged as if the body were new. An edit judges only the clauses its pull
  request's current body does not already hold. The duplicate-body check reads the edit's target the same way.
- The evidence check of the subagent stop hook reads the subagent's final report the same way, at any tree, against its
  own rows since its run started: a run of the session or of another agent is that one's to report. The report is
  read in one pass over its lines, with fences found as the body rule finds them. A machine handoff's JSON, a
  ```` ```json ```` fence whose content parses or an object that opens on a line starting with `{` outside fenced code,
  is read one string value at a time, and the prose around it as text of its own. Any other fence, such as a
  ```` ```jsonc ```` one or a ```` ```json ```` one that does not parse, stays fenced code, so a `{` line inside it
  is no handoff and a claim after it still counts. At most 100 JSON values are parsed a report, and none is read by
  recursion, so no report makes the check throw.
  It skips only fenced code, block quote lines, and what an outside source governs: a clause that opens with
  "according to" an outside source, and a part of a clause, split at a coordinating "and", in which an outside source
  and a verb of saying come right before the command, as "the pull request body says
  `npm test` passed" or "the reviewer wrote \"`npm test` passed\"". Such a part that ends at its list of commands
  carries into the next part, whose predicate is the source's, so "the pull request body says `npm test` and
  `vitest run` passed" is all the body's, while "the issue says `npm test` hangs, and `vitest run` passed 3/3" keeps
  the second claim. Words in double quotes are the writer's own, so "`npm run check` reported \"4071/4071 pass\"" is a
  claim. An outside source is another agent, a subagent, a pull request, an issue, a review, or a handoff; a report,
  handoff, or review after "this", "my", or "our", with at most one word between, "this agent", "this subagent",
  "my run", and "the test output" are the writer's own, so "according to the test output, `npm test` passed",
  "my final report lists ...", and "fixed the issue reported in the ticket and `npm test` passed" stay claims.
  An accepted residual: a report that puts its own claim in fenced code other than a JSON handoff, or in a block
  quote, is not checked; the check stops the mistake seen live, a report written from runs that never ended, not one
  set on hiding.
  It sends the subagent back once, on the first stop of its turn, to quote the output a finished run returned or to
  call the run "not finished".

`aidrian test changed` with nothing to run prints a summary of 0 tests, so its row shows no test passed and supports no claim.

An accepted residual: the record is a file the session's own user may write, so an agent that appends a row by hand
forges evidence the checks accept. The checks stop the mistake seen live, a report written from runs that never ended,
not a session set on lying; a forged row is itself a fabrication, and the rows name the agent and time of each run.

Where it is verified: on Claude Code, `test/check-runs.test.mjs` runs the hooks on the Bash payload shape of the
[session ledger](#session-ledger)'s recorded fixture, and the persisted output on the `persistedOutputPath` and
`persistedOutputSize` fields Claude Code 2.1.317 to 2.1.327 recorded in transcripts for long Bash results; no live hook
has run it. On Codex, the record reads the shell output the source sends, as the session ledger does, and no hook has run there.

## Push first

A subagent fixing review findings once held two small fixes for two hours: it ran the whole suite after each change on
a machine three other suites loaded, and timing tests failed under that load, while CI was green on the previous head
the whole time. So a project can make a full suite wait for the push. With config.json `testing.pushFirstMinutes` above
0 (0, the default, turns the rule off), a command of [`testing.fullSuite`](config.md#testing), as written with no more
arguments, is refused while the branch it runs on has a remote copy that lacks a commit older than that many minutes.
The remote is the branch's push remote, else `remote.pushDefault`, else its upstream's remote, else `origin`; a branch
with no remote copy is not judged.
The deny says to push, let CI run the suite, run a reviewer's re-check on the pushed head beside CI, and run locally
only the test files the change touches:

```bash
aidrian test changed            # the touched test files, through testing.changedCommand
aidrian test changed --list     # only print them
aidrian test changed --base origin/main
```

`aidrian test changed` reads the change against `--base`, else the branch's remote copy, else its merge base with the
default branch on `origin`, uncommitted and untracked files included. A test file is a changed one, a Go `_test.go`
beside a changed `.go` file, or one that names a changed file: a code file by its name and by its name without the
extension, `index.*` by its folder and name, any other file by its path. A test file in a nested package, a folder with
its own package.json, is left out for that package's runner. It runs `testing.changedCommand` with the files after it,
else `npm test --` when package.json has a test script, and exits with that command's status. With `npm test --`, a test
file must also be a module `node --test` loads with no flag, `.js`, `.mjs`, or `.cjs`, and no Go test is given. Any other
file in a test folder, such as a fixture or a `.jsx` file named like a test, counts as a changed file named by its path or
its file name, so the tests that name it run instead of the fixture itself. A configured command gets every changed file
in a test folder as it is, with no search for the tests that name it, unless it is no longer a file on disk, staged or not, or is in a nested package.
A project with `.ts` tests sets `testing.changedCommand`.
A project whose CI cannot run the suite leaves `testing.pushFirstMinutes` at 0, and runs the suite once before marking ready.

## Overrides

An override is for a human, and agents must never set one, `AIDRIAN_ALLOW_UNHELD_READY` of the [ready hold](#ready-hold) included.
A Bash rule's override is read by the hook, which runs in the session's environment,
so the Human sets it in their own shell before they start the session.

`AIDRIAN_ALLOW_MAIN_COMMIT=1` is different: git runs the [commit guard](#commit-guard) inside the commit, so it reads the
commit's own environment. The Human puts it in front of one command in their own terminal,
`AIDRIAN_ALLOW_MAIN_COMMIT=1 git commit …`, and never exports it before a session:
every agent command in that session would inherit it, and the guard would let each commit through with no signal.
A main session that starts with it set says so in its [start lines](#start-lines).
The [git hook bypass](#bash-rules) rule denies an agent's command that sets it.

## Commit messages

`aidrian commit-msg --file <path>` checks a commit subject against Conventional Commits and the types in config.json `git.commits.types`.
A project runs it from its own `commit-msg` git hook, where git passes the message file:

```sh
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs commit-msg --file "$1"
```

`path/to/aidrian-harness/plugins/aidrian` stands for the plugin folder: `plugins/aidrian` in a clone of the plugin's repository,
or the folder the host installed: [Claude Code](providers/claude-code.md#running-aidrian), [Codex](providers/codex.md#running-aidrian).

## Commit guard

`aidrian pre-commit [--project DIR]` runs from a project's `pre-commit` and `pre-merge-commit` git hooks.
It is a git hook, not a plugin hook, so it has no row in the table of plugin hooks at the top of this page,
as [commit messages](#commit-messages) have none.
It is on while config.json `git.mainCheckout.guard` is `true` ([config.md](config.md)), and checks nothing while it is off.
It refuses three commits:

- **A commit in the main checkout**, which several sessions share. The message names `aidrian worktree new <branch>`.
  A repository's first commit passes, as no worktree exists before it: an unborn HEAD in a repository with no branch
  or tag. An orphan branch in a repository with history is still refused.
- **A commit that newly stages a git-ignored file**, in any checkout: each path the commit adds that `.gitignore`
  matches, such as a `git add -f` or a `git mv` into an ignored folder. The message names `git rm --cached <path>`,
  unless another branch already tracks the path; then the agent asks the Human.
  A gitlink under an ignored worktrees folder is one. A file tracked before a later `.gitignore` matched it passes.
  So does a merge that brings in an ignored file the other parent already tracks, such as a force-added `.env.example`
  on main: a path counts only when no parent tracks it. The parents are `MERGE_HEAD` while a merge waits for its commit,
  and the `GITHEAD_<oid>` names `git merge` sets for `pre-merge-commit`, which runs before `MERGE_HEAD` is written;
  a parent that is HEAD or one of its ancestors brings nothing in, and is dropped.
  A squash merge or a path restored from another branch (`git checkout <branch> -- <path>`) counts as a fresh add.
- **A commit whose staged lines add a conflict marker**, in any checkout: each line that `git diff --cached --check`
  reports as a leftover conflict marker, a line that starts with seven `<`, `=`, `>`, or `|` and then a space or its end.
  A merge's commit counts what it brings in from the other side, as the diff is against HEAD. The message names each
  file and line. A line meant to look like a marker, such as one in a doc about merges, passes once `.gitattributes`
  gives its path a larger `conflict-marker-size`. Whitespace that `--check` also reports is left alone.

The message names each problem and the override, and the commit is refused. A check whose input git cannot give,
such as an index it cannot read, finds nothing and prints one line naming what it could not read; what the other check
found still counts. A missing config.json gives the defaults, so the guard is off, except with HEAD unborn in a
repository that has branches: `git switch --orphan` empties the working tree, config.json with it, so the guard reads
the config.json committed on `origin/HEAD`, else on the local `main`, else on the first branch that holds one.
For a project below the repository root, `--project <folder>` names it, and the guard reads that folder's config.json on the same branch.
One that is there but does not load,
as when it does not parse, prints `aidrian pre-commit: config.json unreadable; not checked` and lets the commit run.

The project is the one at the hook's folder. A commit routed through `GIT_DIR` or `--git-dir` from a folder outside the
repository runs the hook in that folder: there the project is the one in the main checkout git names, the folder that
holds the common git folder, and that repository is judged. So when git finds the hook through the git folder
(`.git/hooks`, or an absolute `core.hooksPath`), such a commit on the main checkout is refused too.
A hook script that finds the plugin through `git rev-parse --show-toplevel` finds it in that outside folder and fails;
name the plugin by an absolute path, or by one relative to the script (`"$(dirname "$0")/…"`), as below.

The override is `AIDRIAN_ALLOW_MAIN_COMMIT=1`, per command in the Human's own terminal,
`AIDRIAN_ALLOW_MAIN_COMMIT=1 git commit …`, and never exported before a session ([Overrides](#overrides)).
CI is not exempt: the command does not read `CI`, which any agent or child process could set.
A CI job that commits in its own checkout either runs without the project's git hooks installed,
or sets `AIDRIAN_ALLOW_MAIN_COMMIT=1` in the job's env, a line the Human writes in the workflow file; agents never set it.

It does not cover the commits that run neither hook: `cherry-pick`, `rebase`, `revert`, `am`, `pull --rebase`,
`stash`, and `commit-tree`; nor a fast-forward merge or pull, which makes no commit.
From agents, the [main-checkout](#main-checkout) Bash rule blocks each of these in the main checkout but `stash`
and the fast-forward ones.
`--no-verify` and a `core.hooksPath` override skip it; from agents the [git hook bypass](#bash-rules) rule denies both.
It does not cover a relative install either: a relative `core.hooksPath`, such as `.githooks` or husky's `.husky/_`,
is read against the commit's work tree, so a commit routed through `GIT_DIR` or `--git-dir` from another folder runs
no hook at all.

To install it, put the lines in `.git/hooks`, or in a folder an absolute `core.hooksPath` names
(`git config core.hooksPath "$PWD/.githooks"`, run once per clone by the Human in the main checkout).
Use the plugin folder as in [commit messages](#commit-messages):

```sh
# .git/hooks/pre-commit, or the pre-commit file in the folder core.hooksPath names
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs pre-commit
# .git/hooks/pre-merge-commit, which a non-fast-forward git merge runs instead of pre-commit
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs pre-commit
# .husky/pre-commit and .husky/pre-merge-commit, in a project that uses husky
node path/to/aidrian-harness/plugins/aidrian/lib/cli.mjs pre-commit
```

husky sets the relative `.husky/_` again on each install, so under husky the guard runs for no commit whose work tree
is elsewhere. This repository's `make hooks` sets its own `.githooks` by absolute path.
A project without these lines still gets the [main-checkout](#main-checkout) Bash rule, which reads command text:
it blocks an agent's commit in the main checkout, but not the Human's.
