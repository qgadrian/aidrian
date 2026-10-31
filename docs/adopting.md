# Adopting the plugin in a project

The README's [Quick start](../README.md#quick-start) creates the project folder and a first knowledge index.
This page finishes the setup.
[`examples/consumer`](../examples/consumer) is a complete example; copy it as a start.
Its `.aidrian/`, `.claude/settings.json`, `AGENTS.md`, and `CLAUDE.md` are the harness's part.
Its `src/` and `package.json` are a stand-in app; use your own.

## 1. Shape the knowledge buckets

Each bucket has one index, `.aidrian/knowledge/<bucket-id>.json`, with a one-line summary per doc.
`aidrian-knowledge init <folder>` drafts it; then edit the summaries, tags, and `always` docs:

```json
{
  "dir": "docs/knowledge/engineering",
  "description": "How this project is built, tested, and shipped.",
  "always": ["working-agreement.md"],
  "docs": {
    "working-agreement.md": { "summary": "Rules every task follows.", "tags": [] },
    "testing.md": { "summary": "How tests are written and run.", "tags": ["testing"] }
  }
}
```

- Use the tags in the [`knowledge` skill](../plugins/aidrian/skills/knowledge/SKILL.md#tags), so the agents find your docs.
- [knowledge.md](knowledge.md) describes every index field and [how to shape buckets](knowledge.md#shaping-buckets).

## 2. Point the main session at the buckets

Add this to `AGENTS.md`, and put `@AGENTS.md` in `CLAUDE.md`:

```md
Project rules live in knowledge buckets, indexed in `.aidrian/knowledge/`.
Load them with the `knowledge` skill before you plan, edit, or review.
```

## 3. Install the plugin for the team

- Claude Code: commit `.claude/settings.json`, so Claude Code offers the plugin to everyone who opens the project
  ([Claude Code install](providers/claude-code.md#install)):

  ```json
  {
    "extraKnownMarketplaces": {
      "aidrian-harness": { "source": { "source": "github", "repo": "qgadrian/aidrian" } }
    },
    "enabledPlugins": { "aidrian@aidrian-harness": true }
  }
  ```

- Codex: each user installs once per machine, as in the [README](../README.md#codex).
  Or install the agents into the project with `install-agents.mjs --target .codex/agents`, and run it again after each update.
  [Models and effort](providers/codex.md#models-and-effort) says when to keep that folder out of git.

## 4. Set the review bot

The agents wait for `chatgpt-codex-connector[bot]`, the Codex GitHub connector, to review each pull request.
No Codex review bot? Set `"github": { "reviewer": null }` in `.aidrian/config.json`: [No review bot](config.md#no-review-bot).

## 5. Check before the first task

Run `aidrian check` and `aidrian lint`, then commit and push.
Do it before anyone creates a task worktree: a worktree made earlier has no project folder ([Task worktrees](project-folder.md#task-worktrees)).
Run both commands in CI too, as in the README's [In CI](../README.md#in-ci), so a broken folder never reaches the agents.

## Options

- Keep agents out of the main checkout: the [main-checkout guard](hooks.md#main-checkout).
- Keep your own agents beside the plugin's: [Project agents](knowledge.md#project-agents).
- Change models, names, limits, and more: [config.md](config.md).
