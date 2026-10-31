# Project rules: pull request contract, review gate, terms

Three rules a project can turn on in `config.json`, each off or loose until the project sets it.
They generalize rules one consumer project held in its own scripts, so the project can delete those scripts and keep the behavior.

## Goals

- One mechanism per job: a rule runs in one place, and a second surface only reuses its code.
- Config only: a project sets values, never code. The values a project sets reproduce its old behavior exactly.
- Fail open where a false block costs more than a miss (pull request text); fail closed where the step is the point (the review gate).
- Scale: hundreds of terms live in their own file, not in `config.json`.

## 1. Pull request contract: `github.pullRequest`

The existing pull request body rule (`lib/rules/github/pr-body.mjs`) already reads every `gh pr create` and `gh pr edit`.
`github.requiredSections` stays the presence check. The new keys extend the same rule, in the same Bash hook:

| Key | Checks | Default |
| --- | --- | --- |
| `title` | `--title` matches this regular expression; `{types}` stands for `git.commits.types`, `{issueKey}` for `issueKey` | `null`, no check |
| `issueKey` | One issue key, as a regular expression. With `title` set, a key outside the title's leading `[...]` is refused | `null` |
| `sections` | The closed list of `## ` headings a body may have, outside code fences | `null`, any heading |
| `deferrals` | Each list item of one section names a reason from a closed list, none of the never-valid ones, and an issue key | `null` |
| `residuals` | Each list item of one section has every listed field, and no issue key | `null` |
| `sharedTempBodyFile` | `--body-file` under `/tmp`, `/var/tmp`, `/var/folders`, or `$TMPDIR` is refused: sessions race on it | `true` |
| `duplicateBody` | A body identical to another open pull request's is refused; this one check runs `gh pr list` | `false` |

A title is checked only when the command sets one, so a body-only `gh pr edit` never blocks on an old title.
The override stays `AIDRIAN_ALLOW_PR_BODY=1`.

## 2. Review gate: `github.reviewGate`

`{ "enabled": true, "checklist": "docs/review-checklist.md" }` refuses to ask the review bot until one review by an agent
that did not write the change is on record for the pull request. The record is written once per pull request.

- `aidrian pr attest <PR> --head <sha> --reviewer <who> --findings <n> --fixed <n> [--note <text>]` writes the record to the
  state folder (shared by every worktree) and prints a marker comment. `aidrian pr attest <PR> --check` reads it.
- The marker `<!-- aidrian-review: pr=<n> repo=<owner/name> head=<sha> ... -->` in the request comment also passes,
  so a new session or a cloud container, whose local record is gone, need not review again.
- Where requests are seen, one place each:
  - `aidrian pr await-review --request` checks the gate itself before it posts, and puts the marker in its request.
    This covers the plugin's own path however it is started.
  - The Bash rule `lib/rules/github/review-request.mjs` reads `gh pr comment`, `gh issue comment`, `gh pr review`, and a
    `gh api .../issues/<n>/comments` POST whose body asks `@codex review`, and `gh pr create --reviewer` or
    `gh pr edit --add-reviewer` naming `github.reviewer`.
  - A PreToolUse hook on the GitHub MCP comment tools reads the same body.
- A request to another repository passes; a request whose pull request number cannot be read is refused.
- Override: `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1`, set by a person; it records an override for the pull request.

## 3. Terms: `terms.file`

`"terms": { "file": ".aidrian/terms.json" }` turns the rule on; without it nothing runs.
The file holds rules of banned terms and their replacements, so a project can list hundreds without touching `config.json`.
[config.md](../config.md#terms) describes every key.

- A term matches as a whole word, in any case, after Unicode normalization; `*` inside it stands for more letters of the word.
- A rule reads its `paths`, its `locale`'s translation values, or, with neither, every file git keeps but the terms file.
- Three modes: plain text; `prose`, a Markdown file's own voice, without code, quotes, and blockquotes; and `code`,
  identifiers matched whole in any case style.
- `severity`: `block` (default) or `warn`.

Where it runs, one surface per moment:

- Agent writes: the PreToolUse file-write hook checks only the lines an Edit, Write, or `apply_patch` adds.
  A `block` hit refuses the write, recorded as `terms`; a `warn` hit lets it run and tells the agent.
  A `prose` hit warns when the hook cannot see the whole file.
- Commits and CI: `aidrian lint terms` checks every tracked file, and `--staged` the staged files as the index holds them.
  A project runs it from its own git hook. A `block` hit fails; a `warn` hit is printed. `code` rules are not run here.
- `aidrian check` validates the file.

## Not included

- A syntax-aware identifier check: a `code` rule tells an agent at the moment it writes a banned name, and the
  project's own linter, which sees declarations, stays the gate at commit and in CI, reading the same terms file.
- A glossary injected into every session: the knowledge docs already carry project vocabulary.
