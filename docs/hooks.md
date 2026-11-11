# Hooks

The plugin's hooks are in [`plugins/aidrian/hooks/hooks.json`](../plugins/aidrian/hooks/hooks.json).
How each host runs them: [Claude Code](providers/claude-code.md#hooks), [Codex](providers/codex.md#hooks).

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
| A session or subagent starts | The [start lines](#start-lines) | Claude Code, Codex | no |
| Before any tool call | The [agent gates](#agent-gates), when the project sets any | Claude Code, Codex | yes |
| A new turn starts: a prompt, a background agent's report, or a scheduled run | The [names reminder](config.md#names), when the last reply said "I" or "you" | Claude Code | no |
| Before a Bash command | The [Bash rules](#bash-rules) | Claude Code, Codex | yes |
| Before a file edit | The [main-checkout rule](#main-checkout), when the project turns it on, then the [review-disposition rule](#review-dispositions), then the [terms rule](#terms) | Claude Code, Codex; the review-disposition rule judges no `apply_patch` | yes |
| Before `EnterWorktree` in a subagent | A block: the tool would move the whole session into the worktree | Claude Code | yes |
| Before `AskUserQuestion` | A block when a question or option says "I", "me", "my", "you", or "your" (or a form of them, such as "I'm" or "yourself") outside code and quotes: [Names](config.md#names) | Claude Code | yes |
| Before a GitHub MCP comment | The [review gate](config.md#review-gate), when the project turns it on, and the review-round rule | Claude Code, Codex (its [GitHub connector is not live](providers/codex.md#github-through-the-app-connector)) | yes |
| Before a GitHub MCP merge | The [merge guard](#merge-guard) | Claude Code, Codex (its [GitHub connector is not live](providers/codex.md#github-through-the-app-connector)) | yes |
| Before a GitHub MCP call that marks a draft ready | The [ready hold](#ready-hold), in a project that runs product feedback, then the [ready checks hold](#ready-checks) | Claude Code, Codex ([not live](#where-the-ready-hold-is-verified)) | yes |
| Before any MCP tool call | The [tracker write guard](config.md#tracker), when the project turns it on, on a tool in `tracker.writeTools` | Claude Code, Codex ([not live](#where-the-tracker-guard-is-verified)) | yes |
| After any MCP tool call | The tracker write guard's record of the connected workspace, on a tool in `tracker.readTools`, and its note of a [tool neither list names](config.md#how-a-write-is-judged) | Claude Code, Codex ([not live](#where-the-tracker-guard-is-verified)) | no |
| Before an Agent tool call | The project's [model and effort](config.md#models) for that agent, and a subagent's background dispatch moved to the [foreground](#background-check) | Claude Code | no |
| After a Markdown write | The [line-length check](#markdown-line-length) | Claude Code | feedback |
| Before compaction | A checklist of what the summary must keep | Claude Code, Codex | no |
| The Human approves a plan | The [plan handoff offer](#session-length), when the main session already costs more per call | Claude Code | no |
| After an Agent tool call | A `dispatch` row in the [dispatch log](dispatch-log.md) | Claude Code | no |
| The main session ends a turn | The [announce check](#announced-work), the [hand-back check](#hand-back-check), then the [session-length reminder](#session-length) | Claude Code; the announce and hand-back checks also Codex ([not live](providers/codex.md#hooks)) | once per stop; the reminder once, then at each doubling of the cost ratio |
| A subagent stops | A `stop` row, then the [delivery check](#delivery-check) and the [background check](#background-check) | Claude Code | once |
| A session ends | A `session` row with its tokens, estimated cost, skills, draft pull requests, and review runs | Claude Code | no |

The Bash rules run in the order of their table, in one process.
A file edit is an Edit, Write, or NotebookEdit call, or Codex's `apply_patch`.

## Start lines

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
| Session-length reminder and plan handoff offer | `"session": { "handoff": { "mode": "off" } }` |
| Dispatch log rows | `"telemetry": { "enabled": false }`, in config.json or `.aidrian.local.json`; the delivery and background checks still run |
| `hook_deny` rows alone | `"telemetry": { "hookDenies": false }`; the rules still block |
| Automatic lessons from the stop hook and the blocking rules | `"lessons": { "auto": false }` |
| A Bash rule, once | Its override variable, set by a person: [Overrides](#overrides) |

The knowledge, names, and lessons start lines and the [announce check](#announced-work) have no switch; they act only inside a project folder.
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
| Counting grep in `&&` | A `grep -c` whose exit status an `&&` chain reads | `AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1` |
| Dependency link | An `ln` of a `node_modules` or `.venv` folder: a package manager run in the copy installs through the link and changes the original's packages. The deny names a copy with its own offline install from the lockfile | `AIDRIAN_ALLOW_DEPENDENCY_LINK=1` |
| Pull request body | A pull request body without the required sections, or with the footer; the [contract](config.md#pull-request-contract) | `AIDRIAN_ALLOW_PR_BODY=1` |
| Public text, when turned on | An issue, pull request, or comment whose text matches [`github.publicText.patterns` or `.banned-terms.local`](config.md#public-text), or that the rule cannot read | `AIDRIAN_ALLOW_PUBLIC_TEXT=1` |
| Attribution, when turned on | An agent's commit or new pull request without the [attribution](config.md#attribution) lines | `AIDRIAN_ALLOW_UNATTRIBUTED=1` |
| Review gate, when turned on | Asking the review bot before a review is on record ([config.md](config.md#review-gate)) | `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1` |
| Review rounds, when a review bot is set | Setting `AIDRIAN_ALLOW_EXTRA_ROUNDS`, and asking the bot for a review outside `aidrian pr`, which counts rounds first ([config.md](config.md#review-gate)) | none: on the Human's answer or typed grant, the exact raise runs ([review.md](review.md#unattended-rulings)) |
| Review sign-off | `aidrian pr signoff`, `--last` included, which records the Human's sign-off of a flow under their name ([review.md](review.md#sign-off-by-the-human)) | none: the Human runs it in their own shell |
| Decision answer | `aidrian decisions set` or `undo` from a subagent, which carry out the Human's answer on a decision ([Decision markers](project-folder.md#decision-markers)) | none: the main session runs them on the Human's word |
| Extra round approval | `aidrian pr extend <PR> --human approve` without the Human's answer in the session ([review.md](review.md#extra-rounds)) | none: the Human answers, or runs it in their own shell |
| Quota fallback choice | `aidrian pr review <PR> --quota-fallback` without the Human's pick in the session ([review.md](review.md#out-of-quota)) | none: the Human answers, or runs it in their own shell |
| Product feedback answer | `--by human` on a [product feedback](config.md#product-feedback) item without the Human's answer in the session | none: the Human answers, or runs it in their own shell |
| Product feedback post | `aidrian pr product-feedback post` on a pull request from outside the team without the Human's answer in the session, and from a subagent | none: the Human answers, or runs `post` in their own shell |
| Ready hold, in a project that runs product feedback | Marking a draft ready while its [product feedback](config.md#product-feedback) is owed ([Ready hold](#ready-hold)) | `AIDRIAN_ALLOW_UNHELD_READY=1`, set by a person in their own shell before the session |
| Ready checks | Marking a draft ready while a check on its head has not finished, or before a check its last edit re-queues has shown, and editing a title or body in the same call as a ready ([Ready checks](#ready-checks)) | `AIDRIAN_ALLOW_UNHELD_READY=1`, the ready hold's, set the same way |
| Merge guard | Merging a pull request while a review it owes is open, or the review of its head has not finished ([Merge guard](#merge-guard)) | none: the Human answers "Merge anyway", or merges in their own shell; under `github.unattendedWaiver`, a verdict recorded with `aidrian pr waive` |
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
- Command-line listing: `pgrep -fl`, `pgrep -a`, and `ps` without a format free of `args`, `command`, and `cmd`.
  A listing on the command line itself, or in a substitution of it, whose output reaches only `/dev/null` or a counter
  (`wc`, `grep -c`, `grep -q`) runs: `ps -p <pid> >/dev/null` and `ps aux | grep -c x` print no command line.
  Between the listing and the counter only `grep`, `head`, `tail`, `sort`, `uniq`, and `cut` may stand, with no operand
  but grep's pattern, no long option, no `sort -o`, and no word that may expand, an option value included.
  Inside `sh -c`, `eval`, `env -S`, or xargs a listing never passes.
  The deny starts with the command to run instead, the whole line with each listing replaced:
  `pgrep -fl x` and `ps aux | grep x` become `pgrep -d, -f x | xargs -r ps -o pid=,ppid=,etime=,comm= -p`,
  and a `ps` format trades `args`, `command`, and `cmd` for `comm`.
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
  asks `@codex review`; `gh pr create --reviewer` and `gh pr edit --add-reviewer` naming `github.reviewer`.
- Review sign-off: `aidrian pr signoff`, with `--overrule`, `--accept`, and `--last` too, also as `node …/cli.mjs` or `node …/bin/aidrian`,
  and inside a substitution, `sh -c`, `eval`, or a heredoc or pipe fed to a shell. In a Claude Code session the
  Human runs it with `!`; if a host routes `!` through the hooks too, the Human runs it from another terminal.
  A sign-off with `--check` among its words runs: it is the dry run, which runs every refusal and records nothing,
  so a session can try a command before it hands it to the Human. A pipe into a shell that names a sign-off stays
  blocked, `--check` or not, since the rule cannot read it. Only a plain `--check` counts: one the shell builds at run
  time, such as `` `printf …`--check ``, is no dry run. An `aidrian` whose subcommand the shell builds at run time,
  such as `aidrian "$@"`, is denied too. The rule's message stops the session; at `human_required` naming one flow,
  once `--last --check` exits 0, it hands the Human the short form, `aidrian pr signoff <PR> --last`, short enough to
  type from a phone, which refuses any other stop.
- Decision answer: `aidrian decisions set` and `aidrian decisions undo`, also as `node …/cli.mjs` or `node …/bin/aidrian`,
  and in `sh -c`, `eval`, or a heredoc fed to a shell,
  in a call with an `agent_id`. The main session has none, so it stays allowed. A subagent on a host that sends no `agent_id` passes too.
  The rule stops accidents and is no security boundary: a form it does not read, such as `xargs` or `npx`, runs.
- Extra round approval: `aidrian pr extend <PR> --human approve`, also as `node …/cli.mjs` or `--human=approve`, while the
  pull request's check at the cap waits for the Human. It runs when the session transcript holds an AskUserQuestion
  answer, given after the judge's verdict, to a question naming `#<PR>` and the round it grants, `round <N>`, whose chosen
  option starts with "Approve". `--human deny` and `--verdict` run. With no check waiting for the Human in this
  machine's review record, as when the record came from another machine, the approval is refused.
  Each call in a chain is judged against its own pull request, and the deny names every call it refuses. A deny says
  why the transcript's answers miss: none after the verdict, none naming `#<PR>` or `round <N>`, or the label picked.
  While the check waits for the judge, the deny names the judge's route: run the `dispatch` the review step prints and record
  its verdict with `aidrian pr extend <PR> --verdict`. After a judge's stop, nothing waits for an answer, so the deny names the
  route to one more round instead: `AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review <PR> --max-rounds <N>`, on the Human's
  answer or on their typed `grant up to <N> review rounds on <owner>/<name>#<PR>` ([review.md](review.md#unattended-rulings)),
  or in the Human's own shell in a checkout with several remotes, where neither can approve it.
  An answer the rule cannot read, such as `--human "$X"`, counts as approve; a pull request it cannot read is refused.
- Quota fallback choice: `aidrian pr review <PR> --quota-fallback agent:<name>` or `--quota-fallback human`, also as
  `node …/cli.mjs` or `--quota-fallback=<value>`. It runs when this machine's review record holds a quota stop and the
  session transcript holds an AskUserQuestion answer, given after that stop, to a question naming `#<PR>` and the quota,
  that picks that exact value: an option starting "Run a critic agent" authorizes `agent:critic` only; any other agent
  needs an answer that names it, "Run a <name> agent" or `agent:<name>`; and `human` needs "The Human reviews it".
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
  whose chosen option is that decision alone: `fix-now` also reads as "Fix now", and "Drop nothing, keep it open" is no drop.
  A call whose folder or project it cannot read is refused only while this machine keeps product feedback: a `product-feedback/` folder
  in a project's state folder under the state root, or in the current project's state folder. That is a call after a `cd` it cannot
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
- A count toward an [automatic lesson](lessons.md#automatic-lessons): when one rule blocks the same session a third time,
  an agent that keeps trying was not shown the allowed way. The count does not depend on telemetry.

The rules are named in the rows and lessons as `git-hook-bypass`, `git-amend`, `dependency-link`, `process-kill` (both the kill and the listing rule),
`grep-exit-chain`, `pr-body`, `public-text`, `review-gate` (the Bash rule and the MCP hook), `review-rounds` (the Bash rule and the MCP hook), `review-signoff`,
`decisions-set`, `review-extend`, `review-fallback`, `merge-review` (the Bash rule and the MCP hook), `main-checkout`, `review-disposition`, `terms`, `agent-gates`,
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
to `repos/<owner>/<name>/pulls/<n>/merge`, the MCP tool `mcp__github__merge_pull_request`, and on Codex
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
The hold applies with no review record too, and the `Merge anyway`
answer of the waiver paragraph below does not waive it. With neither default-branch ref here it makes only the refusals about
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
The record file is per number, so in a fork checkout it holds origin's #5 and the upstream's #5 alike. A merge whose
target is named, as `-R`, a URL, a `gh api` path, or the MCP owner and repo, reads only that repository's part: the
owed reviews for it, each an entry's own repository, else the record's, else origin's, and the outcome and rounds when
the record is for it. A merge that names no repository, or one it cannot read, reads every entry, since gh's default
may be the upstream.

The Human waives it. The reason prints a question naming `#<PR>` and the head's first 7 characters; the merge runs when
the session transcript holds the Human's AskUserQuestion answer to a question naming both, whose chosen option starts
with "Merge anyway", given at or after the head's outcome and every owed review. Without a transcript in that shape
(Codex), the Human merges in their own shell.

Under the [unattended waiver](config.md#unattended-waiver), a judge's verdict recorded with `aidrian pr waive` stands in
for that answer, for one denial only: `round_limit` on the merge's own head, with nothing owed. A head pushed after the
last review step, whatever its outcome, is never waived, and its denial names no `aidrian pr waive` route: the review
can still run on it. Every other denial keeps its reason. A verdict counts only for
a merge that names its head, `--match-head-commit <sha>`, `sha=` in a `gh api` merge, or the merge tool's `sha`; for
any other, the denial says to name it. The waiver is for a session the Human told to merge: `aidrian pr auto-merge`'s
review gate does not read waivers. The guard reads the waiver only when the denial is that one and this
machine's `github.unattendedWaiver` switch is on, so with the switch off it makes no network call it did not make
before. It then reads `github.unattendedWaiver.allow` at the default branch and the pull request's base on GitHub,
after the pull request's view: its own when it made one with the base, else one more, and git's project folder.
Every one of these calls shares one deadline for the whole command, counted from when the hook's process started:
none begins once 4 seconds have gone, and each is stopped with SIGKILL after 1 second (3 for the view), or at the
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

[Auto-merge](config.md#auto-merge) goes through this guard: the rule reads its `gh pr merge` like any other.
The guard is not proof that a review happened, because no record lets a merge run (step 2 above).
So `aidrian pr auto-merge` reads the record itself, and no record keeps auto-merge off.
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
`true`, and on Codex the GitHub connector's `mark_pull_request_ready_for_review`
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
- A GitHub MCP server installed under another name, such as a plugin's `mcp__plugin_<name>_github__…`, or a connector Codex
  suffixes with a hash: the merge guard and the review gate share this gap, and a follow-up covers all three.
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
| Claude Code | The Bash form, through the real hook, in `test/ready-hold.test.mjs`, with a fake gh | The MCP form with a live GitHub MCP server: the tests run its documented input through the real hook |
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
- With or without gates, a subagent may not target `.aidrian.local.json` with a Write, Edit, or apply_patch that changes a machine switch,
  or a Bash command that names `autoMerge`, `unattendedWaiver`, or `reviewApprovals`:
  the [auto-merge](config.md#auto-merge), [unattended waiver](config.md#unattended-waiver), and review-approvals switches
  are the main session's. Other writes to that file follow the rules above.
- With or without gates, the same holds for `review.productFeedback` in that file: a Write, Edit, or apply_patch that changes it,
  through a JSON-escaped key, a removed key, or a file left unparsable included, or a Bash command that names `productFeedback`:
  the machine's [product feedback](config.md#product-feedback) choice is the main session's.
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

The check also reads the subagent's brief, the first prompt of its transcript. A handoff file the brief asks this agent to
write must exist when it stops: an absolute path in the state folder's `dispatch/` whose file name ends with the agent's name,
or with it and one more word, such as `<state>/dispatch/feat-12-S1-code-reviewer.json` or `S1-code-reviewer-result.json`
for `code-reviewer`. A branch name that holds the agent's name does not make another agent's file its own. When one does not, the hook
sends the agent back once, on the first stop of its turn, to write it. The file is the record its dispatcher reads:
a subagent's handback can reach another session than the one that dispatched it, such as the main session for an agent
a named teammate started, or none once that one has ended. A path named for another agent, such as a handoff the brief
says to read, is not asked of it. A forked subagent's first prompt is its parent's, so the check finds nothing there.
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
the rounds. The hook counts them instead, in a file per agent in the temporary folder (`lib/child-send-backs.mjs`):
it sends the subagent back at each stop while its task runs, up to 5 times in a row, and says which round it is.
A stop with none of its own tasks running clears the count, and a turn no stop hook started counts from zero.
The stop the cap lets end with the task still running is an occurrence of an [automatic lesson](lessons.md#automatic-lessons)
for the plugin, once per run of send-backs. The count is written before each send-back, and a stop whose count cannot be
written is let end, so the check never loops.

The send-back alone did not hold: subagents still ended their turn with a background agent running. So the Agent hook
also rewrites the dispatch before it runs: a call a subagent makes, one whose payload has `agent_id`, with
`run_in_background: true` runs with it `false`. The subagent then gets the child's report as the call's result, and
several dispatches in one turn still run side by side. The main session's background dispatches run as written, since a
background agent's report wakes it. A background shell is left as it is, for a server the subagent polls; the stop hook
still checks it. A host whose agent tool reaches no hook, such as Codex, is not rewritten.

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
Its second stop always ends.

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

## Hand-back check

When the main session ends a turn on a message that lists items for the Human and any item says nothing of how critical
it is, the Stop hook sends it back once (`lib/stop-handback.mjs`). Such a list once handed the Human work no agent had
tried. The agent tries each item first, through its owner, and keeps only real blocks that only the Human can clear,
such as a permission, a credential, or a product decision. Each block that stays says what is needed, why no agent can
do it, and how critical it is. Its second stop always ends.

- A list counts when a label addressed to the Human comes before it: a heading, a bold line, or a line that ends in a colon,
  such as "For Adrian", "Needs the Human", "Open items for the user", "Waiting on Adrian", or "Adrian's to-do", where the
  Human is the name from [names](config.md#names), "the Human", "the user", or "you". Text after the label's colon is an item too.
- An item is a top-level list entry with its continuation lines. The list ends at a heading, or at a paragraph after a blank line
  that is neither an entry nor indented under one.
- A fenced code block, read as the pull request body rule reads one (`lib/markdown-sections.mjs`), is skipped:
  a Markdown example the message quotes is not work handed back, and a code block inside an item does not end its list.
- An item counts as rated when it holds one of blocking, blocker, critical, high, medium, or low, in any case.

The announce check runs first; a stop it sends back is not checked here.

## Session length

Two hooks weigh what continuing the main session costs against a fresh session started from a handoff brief.
[handoff.md](handoff.md) has the cost model, its re-arming rule, and the config.

- When the main session ends a turn, the Stop hook reads its transcript. Once each call costs `session.handoff.costRatio`
  times what it would in a fresh session, or the context passes the optional `maxTokens` ceiling, it sends the agent back
  for one more turn, with the ratio and the calls a handoff needs to pay back. The agent judges first whether a handoff
  is worth it, and may end the turn without a word; otherwise it asks the Human (`ask`) or writes the brief (`auto`).
  It fires once, then again once the ratio doubles: a marker in the system's temporary folder holds the ratio of the
  last firing, and a compaction resets it.
- When the Human approves a plan (Claude Code's `ExitPlanMode`), the plan hook tells the agent to offer the same handoff
  before its first build step, from halfway to `costRatio`: a cost ratio of 1.5 by default.

Both read Claude Code transcripts only: a transcript with no Claude Code usage, a subagent, or a payload without
`stop_hook_active` does nothing.

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
