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
  "worktrees": { "dir": null, "bootstrap": null },
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
| `version` | The format of the project folder. [project-folder.md](project-folder.md#versioning) gives the rule. |
| `defaultBranch` | The branch that work merges into. |
| `state.dir` | The machine-local [state folder](project-folder.md#local-state); `null` is the one under `$XDG_STATE_HOME`. |
| `worktrees.dir` | The folder for task worktrees; `null` is the state folder's `worktrees/`. |
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

A path in `state.dir` or `worktrees.dir` may start with `~`, the home folder, or be relative to the repository root.
The other local state has fixed places in the state folder; [project-folder.md](project-folder.md#local-state) lists them.

## Checking

`aidrian check` validates this file with the rest of the project folder.
It lists every problem: a missing file, invalid JSON, a missing or other `version`, an unknown key, or a value of the wrong type.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed.
