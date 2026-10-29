---
name: knowledge
description: Load the project's own rules and docs from its knowledge buckets (.aidrian/knowledge.json) before planning, editing, or reviewing. Every aidrian agent preloads it; the main session uses it at the start of a task.
---

# Project knowledge

The aidrian plugin ships generic agents and skills.
Each project brings its own rules as knowledge buckets: folders of Markdown docs with a `bucket.json` index.
This skill is how you find and read them, and which shared defaults apply when a project says nothing.

## Load before you work

1. Open `.aidrian/knowledge.json` at the repository root. It lists the bucket folders, for example
   `{ "buckets": ["docs/knowledge/engineering", "docs/knowledge/product"] }`.
2. In each bucket, open `bucket.json`. Its doc paths are relative to the bucket folder.
3. Read every doc in `always`, then the docs under each tag you were given:
   your agent's knowledge tags, plus any tag that your dispatcher or the task names.
   Add `product_sensitive` when the task touches what users see, money, data, or lifecycle rules.
4. Read each doc once, in bucket order. A tag from the Tags list below that no bucket defines loads nothing; that is not an error.
   A tag that is neither on that list nor defined by a bucket is a typo, and `aidrian-knowledge route` fails on it.

`aidrian-knowledge route <tag>...` prints the same list when that command is on your PATH.

If `.aidrian/knowledge.json` does not exist, read the project's `AGENTS.md`, `CLAUDE.md`, and `README.md` instead,
and report `knowledge: none` in your result.
Never read every doc in a bucket "to be safe"; load what the tags select, then search for more only when the task needs it.

## Precedence

1. The project: its knowledge docs, `AGENTS.md`, and `CLAUDE.md`.
2. The workflow of the skill that is running.
3. Your agent instructions from this plugin, and the defaults below.

When a project doc contradicts a plugin instruction, follow the project and name the conflict in your result.

## Shared defaults

A project overrides any of these in an `always` doc.

- Local plans live in `.aidrian/plans/` and task worktrees in `.aidrian/worktrees/`. Both are git-ignored.
- When another agent reads your result, return one JSON object, the machine handoff, with these fields:
  - `status`: `done`, `blocked`, `needs_input`, or `no_op`.
  - `role`, and `decision`: what you concluded, in two sentences at most.
  - `evidence`: at most six items, each a file, command, or link with what it shows.
  - `loaded_docs`, `deferred_refs` (what to read next, in order), `blockers`, `risks`, and `next_owner`.
  - `artifacts`: bulky output such as long search results, so the fields above stay short.
- An agent named in this plugin's text, such as `explorer`, is this plugin's agent when the host lists it as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex; spawn it by that name.
  Any other named agent (for example `code-reviewer` or `product-manager`) is a role the project may supply, under its own name.
  If one is missing, say so in `blockers`; never replace it with a generic agent.

## Tags

The plugin's agents and skills ask for these tags. Use them in your buckets so the agents find your docs.
A project may add its own tags for its own skills and dispatches.

- `product_sensitive`: product rules a change must not break: what users see, money, data, and lifecycle rules.
- `code_style`: code conventions and the helpers to reuse.
- `testing`: how tests are written and which suites to run.
- `e2e`: end-to-end tests: how to write and run them.
- `issue_tracker`: the tracker, team keys, labels, estimates, and the issue format.
- `orchestration`: how work is split, dispatched, reviewed, and merged; branch and worktree rules.
- `design_bundle`: design handoff bundles, design tokens, and component reuse.
- `docs`: which docs exist, who owns each tree, and how docs stay current with code.
- `harness_engineering`: how the project maintains its AI instructions, checks, and budgets.
- `i18n`: translations and locale files.
- `feature_flags`: feature-flag scaffolds and rollout rules.
