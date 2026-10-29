# Project config

A project that uses the aidrian plugin writes one file, `.aidrian/config.json`, at its root.
The plugin's commands, hooks, and skills read it; nothing else in the project configures the plugin.

[`examples/consumer/.aidrian/config.json`](../examples/consumer/.aidrian/config.json) is a minimal, checked example.

## Keys

Only `buckets` is required. Every other key is optional, and the values below are the defaults.
In a group such as `pr`, set only the keys you change; the others keep their defaults.

```json
{
  "buckets": ["docs/knowledge/engineering"],
  "defaultBranch": "main",
  "worktrees": { "dir": ".aidrian/worktrees", "bootstrap": null },
  "mainCheckout": { "guard": true, "allowWrites": [] },
  "commits": { "types": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] },
  "pr": {
    "requiredSections": ["Summary", "Tests run"],
    "reviewer": "chatgpt-codex-connector[bot]",
    "maxReviewRounds": 10,
    "requiredChecks": [],
    "ignoreCancelledChecks": []
  },
  "docs": { "wrapLimit": 155, "alwaysBudgetBytes": 40000 },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 }
}
```

| Key | Meaning |
| --- | --- |
| `buckets` | The knowledge bucket folders, relative to the project root, in load order. [knowledge.md](knowledge.md) describes them. |
| `defaultBranch` | The branch that work merges into. |
| `worktrees.dir` | The folder for task worktrees, relative to the project root. |
| `worktrees.bootstrap` | One shell command to run inside each new worktree, such as `npm ci`; `null` runs nothing. |
| `mainCheckout.guard` | `false` lets agents edit tracked files in the main checkout; turn it off in a project that does not use worktrees. |
| `mainCheckout.allowWrites` | Tracked paths agents may still edit in the main checkout, as globs with `*` and `**`. Ignored paths are always allowed. |
| `commits.types` | The Conventional Commits types a commit subject may use. |
| `pr.requiredSections` | The `## ` sections every pull request body must have. |
| `pr.reviewer` | The login of the review bot to wait for. |
| `pr.maxReviewRounds` | How many review rounds to run before stopping. |
| `pr.requiredChecks` | Parts of check names that must be present and pass before a pull request is ready. |
| `pr.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `docs.wrapLimit` | The longest line, in characters, allowed in a Markdown file an agent writes; `0` turns the check off. |
| `docs.alwaysBudgetBytes` | The most bytes all `always` knowledge docs may add up to. |
| `skills.descriptionChars` | The longest skill or agent description, in characters. |
| `skills.listingBytes` | The most bytes all skill descriptions may add up to. |

The plugin keeps its other local state in fixed places under `.aidrian/`: `plans/`, `handoffs/`, `lessons/`, and `dispatch-log.jsonl`.
Keep them, and `worktrees.dir`, out of git.

## Checking

```sh
aidrian config check                   # validate .aidrian/config.json
aidrian config check --project DIR     # the same, for the project at or above DIR
```

`check` prints `ok`, or lists every problem and exits 1: a missing file, invalid JSON, an unknown key, a value of the wrong type,
or no `buckets`.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed.
