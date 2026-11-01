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
    "conditionalChecks": [],
    "titleIssuePrefix": false,
    "markReady": "ask",
    "pullRequest": {
      "title": null,
      "issueKey": null,
      "sections": null,
      "deferrals": null,
      "residuals": null,
      "sharedTempBodyFile": true,
      "duplicateBody": false
    },
    "reviewGate": { "enabled": false, "checklist": null }
  },
  "review": { "engine": null, "record": "comment", "rules": [], "ignore": ["<lockfiles, snapshots, generated, vendored, minified>"], "nonBehaviour": ["<docs and assets>"], "flows": {}, "planCommand": null, "reviewers": {} },
  "docs": { "wrapLimit": 155 },
  "terms": { "file": null },
  "knowledge": { "budgets": { "alwaysBytes": 16384, "taggedDocBytes": 24576 } },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 },
  "session": { "handoff": "ask", "maxTokens": 150000, "maxCalls": 250, "maxHours": 4 },
  "lessons": { "auto": true, "maxOpen": 20, "maxAgeDays": 14 },
  "models": { "claude": { "agents": {} }, "codex": { "agents": {} } },
  "names": { "human": "the Human", "ai": null },
  "requires": { "aidrian": null },
  "attribution": { "commit": [], "pullRequest": [], "exclude": ["explorer", "helper-scout", "Explore", "claude-code-guide", "statusline-setup"] },
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
| `git.commits.types` | The Conventional Commits types a commit subject may use; at least one. |
| `state.dir` | The machine-local [state folder](project-folder.md#local-state); `null` is the one under `$XDG_STATE_HOME`. |
| `github.requiredSections` | The `## ` sections every pull request body must have ([Bash rules](hooks.md#bash-rules)); `[]` checks none. |
| `github.reviewer` | The login of the Codex review bot that `aidrian pr await-review` waits for. `null` or `"none"`: no bot ([below](#no-review-bot)). |
| `github.maxReviewRounds` | The review rounds a pull request may get, 3 by default: the review loop and `aidrian pr await-review --request` stop there. They read it from the pull request's base branch, so an edit to the working copy does not raise it. A `--max-rounds` above it runs only with `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`, which the Human sets; a Bash rule refuses an agent command that sets it, and any bot request made outside `aidrian pr`. |
| `github.requiredChecks` | Parts of check names that must be present and pass before `aidrian pr checks` says ready. |
| `github.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `github.conditionalChecks` | Parts of check names whose `SKIPPED` or `NEUTRAL` result is routine, such as a job a path filter turns off. |
| `github.markReady` | Who marks a draft pull request ready. `"ask"`, the default: its author, or the review loop when the Human asks in the session. `"auto"`: the `pr-review-loop` skill, or `autopilot` and the `orchestrator` when they run it, mark it ready once review signs off and `aidrian pr checks` says ready. Either way, nothing is pushed after it is marked ready, and nothing merges it. |
| `github.titleIssuePrefix` | `true` writes pull request titles as `[<issue key>] type(scope): subject`, or `[NOISSUE] type: subject`; `false`, the default, writes a plain Conventional Commits title. |
| `github.pullRequest` | The project's [pull request contract](#pull-request-contract), beyond the required sections; off by default but for `sharedTempBodyFile`. |
| `github.reviewGate.enabled` | `true` asks the review bot only once a review of the diff is on record: [Review gate](#review-gate). |
| `github.reviewGate.checklist` | A file the reviewer reads the diff against, named in the gate's message; `null` names none. |
| `review.engine` | The project's [review engine](review.md#the-engine); it wins over the machine's. `null` leaves the choice to each machine. |
| `review.record` | Where the [review record](review.md#the-record) goes: `"comment"` also writes a summary comment on the pull request; `"local"` keeps it in the state folder only. |
| `terms.file` | The [terms file](#terms) of banned terms and their replacements, relative to the project root; `null` turns the rule off. |
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
| `requires.aidrian` | The oldest plugin version the project's config needs, such as `"0.17.0"`; `null` asks for none: [Plugin version](#plugin-version). |
| `attribution.commit` | The trailers an agent's commit must carry: [Attribution](#attribution). `[]`, the default, is off. |
| `attribution.pullRequest` | The lines a pull request body an agent opens must end with: [Attribution](#attribution). `[]` is off. |
| `attribution.exclude` | The agents the `Assisted-by:` lines leave out; by default the ones that only search and read. |
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

## Pull request contract

The pull request body rule ([hooks.md](hooks.md#bash-rules)) reads every `gh pr create` and `gh pr edit`.
`github.requiredSections` says which sections a body must have; `github.pullRequest` adds what else it holds to:

| Key | The rule refuses |
| --- | --- |
| `title` | A `--title` that does not match this regular expression. `{types}` stands for `git.commits.types`, `{issueKey}` for `issueKey`. |
| `issueKey` | One issue key, as a regular expression, such as `"ABC-\\d+"`. With `title` set, a title with a key outside its leading `[...]`. |
| `sections` | A `## ` heading not on this closed list. Headings inside code fences are quotes and do not count. |
| `deferrals` | An item of the `section` list that names no `field:` reason from `reasons`, names one of `neverValid`, or, with `issueKey`, no issue. |
| `residuals` | An item of the `section` list that lacks one of `fields`, written `field:`, or that names an issue. |
| `sharedTempBodyFile` | `--body-file` in `/tmp`, `/var/tmp`, `/var/folders`, or `$TMPDIR`, unless inside the project: concurrent sessions overwrite those. |
| `duplicateBody` | A body identical to another open pull request's. This check runs `gh pr list`, and lets the command run when gh does not answer in 3 s. |

A title is checked only when the command sets one, so a body-only `gh pr edit` never blocks on a title written before the rule.
The items of a section are its list items; prose under the heading, and a bullet indented under an item, are not items.
The first `field:` on an item's own line is its reason, and the reason's first word decides it, so prose may follow it.
In `neverValid`, a `<word>` stands for any one word, so `needs <specialist> oversight` also matches `needs backend-developer oversight`.

```json
{
  "github": {
    "requiredSections": ["Summary"],
    "pullRequest": {
      "title": "^\\[(?:{issueKey}|NOISSUE)\\] (?:{types})(?:\\([a-z0-9./_-]+\\))?!?: \\S.*",
      "issueKey": "ABC-\\d+",
      "sections": ["Summary", "Risk", "Tests run", "Deferred to issues"],
      "deferrals": { "section": "Deferred to issues", "field": "defer_reason", "reasons": ["human_only", "user_chose"], "neverValid": ["out of scope"] }
    }
  }
}
```

## Review plan

`review` decides how `aidrian pr review` reviews a pull request: its depth, its stages, the critical flows it holds
to their invariants, the reviewers a project adds, and the [visual capture](review.md#visual-review).
[review.md](review.md) describes every key. Two machine settings live in `.aidrian.local.json`: the engine,
`review.engine`, unless the project sets it here, and the visual capture's base URL, `review.visual.baseUrl`.

## Review gate

With `aidrian pr review`, an enabled gate is one more required reviewer: the code-reviewer agent runs in the local
stage before any model or bot. The rest of this section is about asking the bot directly.

With `"github": { "reviewGate": { "enabled": true } }`, the review bot is asked to review a pull request only once one
review of its diff, by an agent that did not write it, is on record. The record is written once per pull request:

```sh
aidrian pr attest <PR> --head <sha> --reviewer <who> --findings <n> --fixed <n> [--note <text>]
aidrian pr attest <PR> --check     # exit 0 recorded, 3 not
```

`attest` writes the record to the [state folder](project-folder.md#local-state), which every worktree shares, and prints a marker:
`<!-- aidrian-review: pr=<n> repo=<owner/name> head=<sha> ... -->`. A request that carries the marker for its own pull request
and repository also passes, so a new session or machine need not review again.

- `aidrian pr await-review --request` checks the gate before it posts. It ends with `review_required`, exit 5, and posts
  nothing, or puts the marker in its request.
- The Bash rule refuses `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose
  body asks `@codex review` outside code and quotes, and `gh pr create --reviewer` or `gh pr edit --add-reviewer` naming `github.reviewer`.
- A hook on the GitHub MCP comment tools refuses the same body.
- A request to another repository passes. A request whose pull request number the rule cannot read is refused: name it.
- `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1`, set by a person in their own shell, lets the request run and records an override
  for the pull request.

`checklist` names a file the reviewer reads the diff against; the gate's message names it.

## Terms

`"terms": { "file": ".aidrian/terms.json" }` turns on the terms rule: a project's vocabulary, as banned terms each with
its replacement. The file is JSON of its own, so a project can list hundreds of terms without growing `config.json`:

```json
{
  "version": 1,
  "locales": "locales/{locale}/*.json",
  "rules": [
    { "id": "clients", "severity": "warn", "exclude": ["locales/**", "src/**"], "terms": { "guest": "client", "guests": "clients" } },
    { "id": "es guests", "locale": "es*", "terms": { "comensal": "cliente", "comensales": "clientes" } },
    { "id": "shared docs", "paths": ["docs/**/*.md"], "prose": true, "terms": { "you": "the agent" } },
    { "id": "guest count", "paths": ["src/**/*.ts"], "code": true, "severity": "warn", "terms": { "party size": "guestCount" } }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `version` | `1`. |
| `locales` | Where translation files are, as a glob with `{locale}`. Needed by a rule with `locale`. |
| `rules[].id` | A unique name, shown with every hit. |
| `rules[].paths` | The files the rule reads, as globs relative to the project root, with `*` and `**`. Without it, and without `locale`, the rule reads every file. |
| `rules[].locale` | A translation locale, put in place of `{locale}` in `locales`; it may hold `*`, so `"es*"` reads `es`, `es-ES`, and `es-419`. It reads only a JSON file's string values, never its keys. |
| `rules[].exclude` | Globs of files the rule skips, such as a vendor's contract or marketing copy where a term is meant. |
| `rules[].severity` | `"block"`, the default, or `"warn"`. |
| `rules[].message` | Shown with every hit. |
| `rules[].prose` | `true`: read only a Markdown file's own prose (see below). |
| `rules[].code` | `true`: match code names, whole, in any case style (see below). Needs `paths`. |
| `rules[].terms` | Each banned term and what to write instead. |

A term matches as a whole word, in any case, after Unicode normalization: `comensal` does not match `comensales`.
List each word form a rule bans (`guest`, `guests`, `guest's`); synonyms are more entries. A `*` stands for more letters
of the same word, so `usuári*` matches `usuárias`; use it only when every continuation is wrong, since `guest*` also
matches `guestbook`. A term in a script written without spaces, such as Japanese or Chinese, matches anywhere.

A rule with neither `paths` nor `locale` holds everywhere: every text file git tracks, and on agent writes every file
git does not ignore. Binaries, lockfiles, and `*.min.*` files are never read, and no rule reads the terms file itself.
Such a rule reads whole lines, JSON keys included, so translations belong to `locale` rules and code names to `code`
rules; `exclude` takes out the rest.

A `prose` rule reads what a Markdown file says in its own voice. It skips fenced code, blockquotes, lines with
`<!-- lint-skip -->`, and, within a line, inline code, URLs, and "quoted" or “quoted” spans. A word joined by `-` is part
of a compound, so `you` does not match `show-your-work`.
On an agent write it reads the lines whose prose is new: a line moved out of a code block counts, a reordered line does
not. When the hook cannot see the whole file, as with Codex's `apply_patch`, a `prose` hit only warns.

A `code` rule matches identifiers whole: `party size` is `partySize`, `PartySize`, `party_size`, `PARTY_SIZE`, and
`party-size`, never `minimumPartySize`. Strings and `//` or `/* */` comments are skipped. It reads text, not a syntax
tree, so a read such as `booking.partySize` also matches, code inside a template literal's `${}` and after a quote in a
regular expression can be missed, and JSX text reads as code; start such a rule at `warn`. It runs on agent writes
only: the project's own linter is the gate for code names at commit and in CI, and can read the same file.

Where it runs:

- The file-write hook checks the lines an Edit, Write, or `apply_patch` adds: a `block` hit refuses the write, and a `warn`
  hit lets it run and tells the agent. A line the file already had is never reported, so old text does not block new work.
- `aidrian lint terms` checks every tracked file, and `--staged` the staged files as the index holds them: a `block` hit fails,
  a `warn` hit is printed. `--rule <id>` runs one rule. A project runs `aidrian lint terms --staged` from its own git hook,
  as it runs [commit-msg](hooks.md#commit-messages).
- `aidrian check` names every problem in the file; a bad rule is left out, and the others still apply.

To add a rule, start it at `"severity": "warn"`, run `aidrian lint terms --rule <id>`, and fix or `exclude` each hit.
Then drop `severity`, so it blocks. A vocabulary rule that reads every file can match thousands of lines in a large
project; this order finds them before they stop anyone's work.

## Models

Each agent file in the plugin sets the model and effort the agent ships with, from the plugin's [provider files](agent-sources.md#provider-files).
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

## Plugin version

A config that uses a newer key fails on an older plugin, and a session can load an older install than the one the
project was set up with, such as a resumed session from another checkout. `requires.aidrian` names the oldest plugin
the project needs:

```json
{ "requires": { "aidrian": "0.17.0" } }
```

When the running plugin is older, `aidrian check` fails and the session-start hook adds a line, both naming the
version and the folder of the copy that runs, so the stale install shows at the first prompt. A plugin older than
0.17.0 does not know the key and rejects it as unknown, which fails as loudly with a less specific message.

## Attribution

`attribution` says which agents wrote a commit or a pull request. The values come from the hook payload, the session
transcript, the environment, git, and the [dispatch log](dispatch-log.md), never from what an agent writes about itself.
The attribution rule ([hooks.md](hooks.md#bash-rules)) blocks an agent's `git commit` or `gh pr create` that lacks them
and prints the exact lines to add. Both lists are empty by default, which turns the rule off.

| Field | Value | Read from | Commit trailer |
| --- | --- | --- | --- |
| `agent` | `backend-developer`, or `main` | The subagent making the call, else the session's `--agent`; without the `aidrian:` prefix | `Agent:` |
| `model` | `claude-opus-5-5` | The agent's last API request in its own transcript | `Agent-Model:` |
| `effort` | `high` | That request, else `CLAUDE_EFFORT` in the main session only: a subagent inherits it | `Agent-Effort:` |
| `tool` | `Claude Code` or `Codex` | `CODEX_THREAD_ID` | `Agent-Tool:` |
| `env` | `local`, `cloud`, or `ci` | `CLAUDE_CODE_REMOTE=true` is `cloud`; `GITHUB_ACTIONS` or `CI` is `ci` | `Agent-Env:` |

`commit` takes any of these fields. A commit carries a trailer as a `--trailer` option, or in its message's trailer
block: the last paragraph, past the subject, with only `Key: value` lines, as git reads it.
Each `git commit` in a command is checked on its own message, and a `-F` file is read where the commit runs.
A message from stdin (`-F -`), an editor, or another commit (`-C`, `-c`) counts only its `--trailer` options. `-h`, `--help`, `--dry-run`, and the status formats, such as `--short`, pass.
The rule also reads `sh -c` and `bash -c` command lines and a script fed to a shell, such as `bash <<'EOF'`.
The trailers are those `git interpret-trailers` reads in the commit's folder, with its `git -c` settings.

`pullRequest` takes `tool`, `model`, `effort`, and `env` for one line, and `agents` for one line per agent:

```text
Authored-with: Claude Code — claude-opus-5-5 (high effort, local)
Assisted-by: backend-developer (claude-sonnet-5-5)
Assisted-by: code-reviewer (claude-opus-5-5)
```

- The agents are those in the `Agent:` trailers of the commits on the pull request's head (`--head`, else the current branch)
  past its base (`--base`, else `git.defaultBranch`), from any session,
  and those this session dispatched, with the models their `stop` rows name; `main` and `exclude` are left out.
- The `Authored-with:` line must match as written. Each agent needs an `Assisted-by:` line, in any order, whatever models it names.
- Only `gh pr create`, and its alias `gh pr new`, is checked; `gh pr edit`, `--web`, and `--dry-run` pass. A body the rule cannot read, such as `--body "$VAR"`, is refused.
- A field with no known value is left out, never guessed.
- The commit names only the agent that runs `git commit`. When the main session commits a subagent's work,
  the subagent shows in the pull request's `Assisted-by:` lines, not as a co-author.
- On Codex, `tool` and `env` are known, and `agent` when Codex sends it. `model`, `effort`, and the dispatched agents
  are not: the transcript reader and the dispatch log read Claude Code's formats. Codex never reports `cloud`.

The rule catches an agent that forgot or mistyped its attribution in an ordinary command. It is not a security
boundary: a command built to hide its message from a static reader is out of scope, and where the rule cannot read a
message it asks for `--trailer` options.

To skip the rule, the Human sets `AIDRIAN_ALLOW_UNATTRIBUTED=1` before starting the session.
The host adds its own attribution, such as Claude Code's `Co-Authored-By:` trailer and session link.
Claude Code's `attribution` setting in `.claude/settings.json` turns those off.

```json
{ "attribution": { "commit": ["agent", "model", "effort"], "pullRequest": ["tool", "model", "effort", "agents"] } }
```

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
- An `allow` or `deny` that is not a list, or a `deny` with an invalid pattern, leaves the gates unknown: a subagent may then
  only read files until the file is fixed.
- With `allow` set, a call that matches none of its patterns is blocked; `"allow": []` blocks every tool.
- A Bash call passes an `allow` list through its `Bash(...)` patterns only when every command in it starts with an allowed prefix.
  `cd app && npm test` needs both `Bash(cd)` and `Bash(npm test)`.
- A command line is read as the [Bash rules](hooks.md#bash-rules) read it: each step of `&&`, `;`, and `|`, and each command substitution.
  It also reads past wrappers such as `sudo` and `env`, and past git's own options, so `Bash(git push)` also blocks `git -C app push`.
- The first word matches the program by its file name, so `Bash(git push)` also matches `/usr/bin/git push`.
- The command line of `sh -c` or `bash -c` is read too, so `Bash(git push)` blocks `bash -c 'git push'`; an `allow` list must also allow the shell.
  So is a heredoc or here-string fed to a shell (`bash <<'EOF'`), a function body, and a `case` arm.
- A gate matches the command text, so a command run by `xargs`, `find -exec`, `eval`, a script, an interpreter, or text piped
  into a shell (`echo 'git push' | bash`) is out of sight;
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
