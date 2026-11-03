# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
How each host runs them: [Claude Code](providers/claude-code.md#hooks), [Codex](providers/codex.md#hooks).

Every hook lets the action run when it cannot read its input, so a hook never breaks a session.
A git call a hook makes is stopped after 2 seconds and counts as git not answering; the hook's later git calls then do not wait.
A blocking hook exits 2 and tells the agent why on stderr.
The Bash rules, the main-checkout rule, the terms rule, the GitHub MCP hook, the agent gates, the config guard, and the question names check also record each block:
see [Recorded blocks](#recorded-blocks).

| When | What runs | Host | Blocks |
| --- | --- | --- | --- |
| A session or subagent starts | The [start lines](#start-lines) | both | no |
| Before any tool call | The [agent gates](#agent-gates), when the project sets any | both | yes |
| A new turn starts: a prompt, a background agent's report, or a scheduled run | The [names reminder](config.md#names), when the last reply said "I" or "you" | Claude Code | no |
| Before a Bash command | The [Bash rules](#bash-rules) | both | yes |
| Before a file edit | The [main-checkout rule](#main-checkout), when the project turns it on, then the [terms rule](#terms) | both | yes |
| Before `EnterWorktree` in a subagent | A block: the tool would move the whole session into the worktree | Claude Code | yes |
| Before `AskUserQuestion` | A block when a question or option says "I", "me", "my", "you", or "your" (or a form of them, such as "I'm" or "yourself") outside code and quotes: [Names](config.md#names) | Claude Code | yes |
| Before a GitHub MCP comment | The [review gate](config.md#review-gate), when the project turns it on, and the review-round rule | both | yes |
| Before an Agent tool call | The project's [model and effort](config.md#models) for that agent | Claude Code | no |
| After a Markdown write | The [line-length check](#markdown-line-length) | Claude Code | feedback |
| Before compaction | A checklist of what the summary must keep | both | no |
| The Human approves a plan | The [plan handoff offer](#session-length), when the main session already costs more per call | Claude Code | no |
| After an Agent tool call | A `dispatch` row in the [dispatch log](dispatch-log.md) | Claude Code | no |
| The main session ends a turn | The [session-length reminder](#session-length) | Claude Code | once per step |
| A subagent stops | A `stop` row, then the [delivery check](#delivery-check) and the [background check](#background-check) | Claude Code | once |
| A session ends | A `session` row with its tokens, estimated cost, skills, draft pull requests, and review runs | Claude Code | no |

The Bash rules run in the order of their table, in one process.
A file edit is an Edit, Write, or NotebookEdit call, or Codex's `apply_patch`.

## Start lines

At the start of every session and subagent, the hook prints:

- one line naming the `always` knowledge docs and the commands that find the rest;
- one line with the [names](config.md#names) for the human and the AI;
- one `Voice:` line: say so, with the reason, when a request or premise looks wrong, then follow the human's call;
  and ask the human questions they can answer without the session's context, one decision each, recommendation first;
- in the main session only, one `Format:` line: headers, quotes, and a few emoji in chat replies, never in commits,
  pull requests, docs, or code, which a subagent's report feeds, so a subagent does not get it;
- in the main session only, one more line while the [lesson inbox](lessons.md#session-start) holds open lessons.

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

## Turning hooks off

| Hook | Off with |
| --- | --- |
| Agent gates | Off unless config.json or `.aidrian.local.json` sets `agents` |
| Main-checkout rule | Off unless config.json sets `"git": { "mainCheckout": { "guard": true } }` |
| [Commit guard](#commit-guard), and its [start lines](#start-lines) | Off unless config.json sets `"git": { "mainCheckout": { "guard": true } }`, the main-checkout rule's switch |
| Markdown line length | `"docs": { "wrapLimit": 0 }` |
| Pull request body sections | `"github": { "requiredSections": [] }`; the footer and `--fill` checks stay |
| Pull request contract | Off unless config.json sets `github.pullRequest`, but for `"sharedTempBodyFile": false` |
| Review gate | Off unless config.json sets `"github": { "reviewGate": { "enabled": true } }` |
| Terms rule | Off unless config.json sets `"terms": { "file": "…" }` |
| Session-length reminder and plan handoff offer | `"session": { "handoff": { "mode": "off" } }` |
| Dispatch log rows | `"telemetry": { "enabled": false }`, in config.json or `.aidrian.local.json`; the delivery and background checks still run |
| `hook_deny` rows alone | `"telemetry": { "hookDenies": false }`; the rules still block |
| Automatic lessons from the stop hook and the blocking rules | `"lessons": { "auto": false }` |
| A Bash rule, once | Its override variable, set by a person: [Overrides](#overrides) |

The knowledge, names, and lessons start lines have no switch; they act only inside a project folder.
The main-checkout start lines follow the commit guard, so they are off with it.
[config.md](config.md#telemetry) lists the other `telemetry` keys.
The Agent hook changes only what config.json or `.aidrian.local.json` sets in `models.claude`.
The compaction checklist steps aside whenever instructions are typed after `/compact`.

## Bash rules

| Rule | Blocks | Override |
| --- | --- | --- |
| Git hook bypass | Skipping or turning off git hooks, and setting `AIDRIAN_ALLOW_MAIN_COMMIT`, the [commit guard](#commit-guard)'s override | none |
| Git amend | `git commit --amend` | `AIDRIAN_ALLOW_GIT_AMEND=1` |
| Kill by name | Killing processes by name | `AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME=1` |
| Command-line listing | Listing the command lines of other processes | `AIDRIAN_ALLOW_PROCESS_ARGS_LISTING=1` |
| Counting grep in `&&` | A `grep -c` whose exit status an `&&` chain reads | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Pull request body | A pull request body without the required sections, or with the footer; the [contract](config.md#pull-request-contract) | `AIDRIAN_ALLOW_PR_BODY=1` |
| Attribution, when turned on | An agent's commit or new pull request without the [attribution](config.md#attribution) lines | `AIDRIAN_ALLOW_UNATTRIBUTED=1` |
| Review gate, when turned on | Asking the review bot before a review is on record ([config.md](config.md#review-gate)) | `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1` |
| Review rounds, when a review bot is set | Setting `AIDRIAN_ALLOW_EXTRA_ROUNDS`, and asking the bot for a review outside `aidrian pr`, which counts rounds first ([config.md](config.md#review-gate)) | none |
| Review sign-off | `aidrian pr signoff`, which records the Human's sign-off of a flow under their name ([review.md](review.md#sign-off-by-the-human)) | none: the Human runs it in their own shell |
| Extra round approval | `aidrian pr extend <PR> --human approve` without the Human's answer in the session ([review.md](review.md#extra-rounds)) | none: the Human answers, or runs it in their own shell |
| Main checkout, when turned on | A shell write to a tracked file in the main checkout; a git call there that makes a commit or moves the branch; after a `cd` it cannot trust, a relative write or a git call that may change the main checkout; and a relative write that lands there only if a `cd` inside it fails ([After a cd](#after-a-cd)) | `AIDRIAN_ALLOW_MAIN_WRITE=1` |

What each rule matches:

- Git hook bypass: `--no-verify` on commit, push, or merge; `-n` on commit; `HUSKY=0`;
  core.hooksPath set in any letter case through `-c`, `--config-env`, `GIT_CONFIG_PARAMETERS`, or `GIT_CONFIG_KEY_<n>`;
  `git config` writing or unsetting core.hooksPath;
  and any command that sets `AIDRIAN_ALLOW_MAIN_COMMIT`, inline (`VAR=1 cmd`), through `env`, or with `export`, `declare`,
  `typeset`, `local`, or `readonly`. The name in a quoted argument or a comment passes, and so does `env -u`.
  This rule reads `sh -c` bodies and heredocs or here-strings fed to a shell, as well as command substitutions.
- Kill by name: `pkill`, `killall`, `pgrep --signal`, `kill` fed by `pgrep` or `ps`, and `kill -- -1`. `kill <pid>` stays allowed.
- Command-line listing: `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, and `cmd`.
- Counting grep in `&&`: such as `grep -c x log && npm test`.
- Pull request body: `gh pr create` or `gh pr edit` with a body that lacks a config.json `github.requiredSections` heading,
  or that carries the "Generated with [Claude Code]" footer; `gh pr create --fill`;
  and, when sections are configured, a non-web `gh pr create` with no `--body` or `--body-file`.
  With `github.pullRequest` set, also the title, the closed list of sections, the deferral and residual items,
  a body file in a shared temp folder, and a body identical to another open pull request's.
  A deny about where the body comes from names the one path the `pr-write` skill writes, `<state>/tmp/pr-body-<branch>.md`,
  written out for the project and the branch. The footer deny says that line does not apply even when the host asks for it,
  and that the `attribution.pullRequest` lines replace it when set.
- Attribution: an agent's `git commit` whose message's last paragraph and `--trailer` options lack a configured trailer;
  and a `gh pr create` body without the configured `Authored-with:` and `Assisted-by:` lines.
- Review gate: `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose body
  asks `@codex review`; `gh pr create --reviewer` and `gh pr edit --add-reviewer` naming `github.reviewer`.
- Review sign-off: `aidrian pr signoff`, also as `node …/cli.mjs` or `node …/bin/aidrian`. In a Claude Code session the
  Human runs it with `!`; if a host routes `!` through the hooks too, the Human runs it from another terminal.
- Extra round approval: `aidrian pr extend <PR> --human approve`, also as `node …/cli.mjs` or `--human=approve`, while the
  pull request's check at the cap waits for the Human. It runs when the session transcript holds an AskUserQuestion
  answer, given after the judge's verdict, to a question naming `#<PR>` and the round it grants, `round <N>`, whose chosen
  option starts with "Approve". `--human deny` and `--verdict` run. With no check waiting for the Human in this
  machine's review record, as when the record came from another machine, the approval is refused.
  An answer the rule cannot read, such as `--human "$X"`, counts as approve; a pull request it cannot read is refused.
- Main checkout: `>`, `>>`, `tee`, `sed -i`, `perl -i`, `ruby -i`, `cp`, `mv` and `git mv` (sources and destination), `rm`, `git rm`, `unlink`,
  `touch`, `mkdir`, and `rsync` (sources too under `--remove-source-files`); a branch switch or `git add -A` there;
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
A long option it blocks also matches the shorter prefixes the program accepts, such as `--no-veri` for `--no-verify`,
`--am` for `--amend`, and `--cou` for grep's `--count`.
Every rule also reads the command substitutions that run: `$(…)`, backticks, `<(…)`, and those in a heredoc that expands.
The process rules also read `sh -c`, `eval`, and `xargs`; the git hook bypass rule reads `sh -c` and a heredoc or here-string fed to a shell.
A command reached only through a script or an interpreter such as `python -c` is out of their sight.

## Recorded blocks

Every block by a Bash rule, the main-checkout rule, an [agent gate](#agent-gates), the config guard, or the question names check is recorded twice,
in `plugins/aidrian/lib/hook-deny.mjs`, after the hook writes its reason and before it exits 2.
Neither record waits on a lock, so a block stays well inside the host's 5-second hook timeout:

- A `hook_deny` row in the [dispatch log](dispatch-log.md#hook_deny-when-one-of-the-plugins-rules-blocks-a-tool-call):
  the rule, the tool, the agent, and what the rule matched, never the command.
  `"telemetry": { "hookDenies": false }` turns the row off. `aidrian report` lists the rows by rule and agent.
- A count toward an [automatic lesson](lessons.md#automatic-lessons): when one rule blocks the same session a third time,
  an agent that keeps trying was not shown the allowed way. The count does not depend on telemetry.

The rules are named in the rows and lessons as `git-hook-bypass`, `git-amend`, `process-kill` (both the kill and the listing rule),
`grep-exit-chain`, `pr-body`, `review-gate` (the Bash rule and the MCP hook), `review-rounds` (the Bash rule and the MCP hook), `review-signoff`, `review-extend`, `main-checkout`, `terms`, `agent-gates`, `config-guard`, and `ask-names`.
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

## Background check

A subagent that ends its turn goes idle, and the end of a background shell or agent it started does not wake it:
a background push, or a reviewer whose report can no longer reach it, leaves it waiting until someone messages it.
So when a subagent stops while one of its own background tasks still runs, the stop hook sends it back once, naming each task,
to wait for it in the foreground: poll it with a foreground command and a timeout, and repeat the call until it ends,
or stop it with `TaskStop` when it should not outlive the turn. Its second stop always ends; ending with the task still running
is an occurrence of an [automatic lesson](lessons.md#automatic-lessons) for the plugin.

Claude Code's SubagentStop payload lists the session's in-flight tasks in `background_tasks`, without the agent that started each.
A task is the subagent's own only when one of its own calls launched or resumed it, as the structured result Claude Code
stores beside that call's result in the transcript (`toolUseResult`) names it: a Bash call's `backgroundTaskId`, set when
it started in the background or was moved there at its timeout; an async Agent launch's `agentId`; or a SendMessage call's
`resumedAgentId`. A result's text never counts, so a command's output or an agent's report that quotes a launch line claims nothing.
Reading, waiting on, or stopping another agent's task, such as tailing its output file, does not make it the subagent's own.
A peer teammate is never a child: a message wakes it. A payload without `background_tasks`, such as Codex's, checks nothing.

## Session length

Two hooks weigh what continuing the main session costs against a fresh session started from a handoff brief.
[handoff.md](handoff.md) has the cost model, its steps, and the config.

- When the main session ends a turn, the Stop hook reads its transcript. Once each call costs `session.handoff.costRatio`
  times what it would in a fresh session, or the context passes the optional `maxTokens` ceiling, it sends the agent back
  for one more turn, with the ratio and the calls a handoff needs to pay back. The agent judges first whether a handoff
  is worth it, and may end the turn without a word; otherwise it asks the Human (`ask`) or writes the brief (`auto`).
  It fires once per step: a marker in the system's temporary folder counts the firings, and a compaction resets them.
- When the Human approves a plan (Claude Code's `ExitPlanMode`), the plan hook tells the agent to offer the same handoff
  before its first build step, from half a step: a cost ratio of 1.5 by default.

Both read Claude Code transcripts only: a transcript with no Claude Code usage, a subagent, or a payload without
`stop_hook_active` does nothing.

## Overrides

An override is for a human, and agents must never set one.
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
It refuses two commits:

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

The message names each problem and the override, and the commit is refused. A check whose input git cannot give,
such as an index it cannot read, finds nothing and prints one line naming what it could not read; what the other check
found still counts. A missing config.json gives the defaults, so the guard is off, except with HEAD unborn in a
repository that has branches: `git switch --orphan` empties the working tree, config.json with it, so the guard reads
the config.json committed on `origin/HEAD`, else on the local `main`, else on the first branch that holds one.
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
