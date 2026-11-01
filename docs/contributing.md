# Contributing

This page is for changing the plugin itself. To use the plugin in a project, start at the [README](../README.md#install).
[architecture.md](architecture.md) maps the repository.

This repository runs the plugin on itself with the [main-checkout guard](hooks.md#main-checkout) on (`.aidrian/config.json`).
Change it in a task worktree, `aidrian worktree new <branch>`, never in the main checkout: several sessions share that
folder, so the guard blocks edits there, branch switches away from `main`, and `git add -A` or `git commit -a`.

## Build and check

```sh
npm ci
npm run build    # after editing plugins/aidrian/agents-src/<group>/, providers/, or agent-addons/
npm run check    # what CI runs
```

`make` lists the same tasks.

`npm run check` fails when:

- a generated agent is stale, or edited by hand;
- the example's project folder is invalid;
- a test fails;
- the plugin changed without a version bump ([Versions](#versions)).

## What the tests hold

- Both marketplaces publish the one plugin from `./plugins/aidrian`.
  Both plugin manifests have the same `name`, `version`, `description`, `author`, and `repository`.
- Every agent preloads the `knowledge` skill, and asks only for tags that skill lists.
- [Agents and skills](agents-and-skills.md) lists every agent and skill shipped, once.
  Its agent tables match the [group folders](agents.md#groups) of the agent sources.
- No project-specific path leaks into the plugin.
- No tracked file names a person.
  The owner's GitHub name appears only where a user installs: the README, the example's settings, and the manifests.
- Every agent and skill description fits in 160 characters. Both hosts load all of them into every session.
- Every `SKILL.md` fits in 7,500 bytes, because Codex cuts it at 8,000.
  A longer skill moves detail into `references/` files that `SKILL.md` names, with when to read each.

When `claude` and `codex` are on your PATH, `test/hosts.test.mjs` also checks the real hosts. Neither check runs a model.

- Claude Code validates the plugin and loads every agent, skill, and hook event.
- Codex installs the plugin and shows every skill and agent in a project session.

## Trying a branch

To try a branch in a real session before it merges, install the plugin from your checkout:
[Claude Code](providers/claude-code.md#from-a-local-checkout), [Codex](providers/codex.md#from-a-local-checkout).

## Skill evals

`plugins/aidrian/evals/<case>/` holds behavior cases for skills, run with model calls, so not by `npm run check`.
Each case's `scaffold.sh` clones the committed HEAD into the run's folder and removes the skill under test, so the
baseline run without the plugin cannot read it. Commit first, then, from `plugins/aidrian`:

```sh
claude plugin eval . --scaffold --trust-plugin --no-publish --runs 1 --model <haiku|sonnet|opus>
```

A case earns its place when it passes with the plugin and fails without it. Results go to `evals/**/results/`, which git ignores.

## Versions

Users receive a change only after the version changes.
A branch that changes anything under `plugins/aidrian/` raises the version before it merges:

```sh
npm run bump           # 0.3.0 -> 0.3.1, for a fix
npm run bump minor     # 0.3.0 -> 0.4.0, for a new feature
npm run bump major     # 0.3.0 -> 1.0.0, for a change a project must adapt to
```

`npm run bump` writes the new version to every file that carries it: both plugin manifests, `package.json`, and `package-lock.json`.
`npm run check` fails when those files disagree, and when the branch changes `plugins/aidrian/` without a version above `origin/main`'s.
Changes only to docs, tests, examples, or `scripts/` need no bump: they live outside the plugin.
Without `origin/main`, or on `main` itself, the comparison with main is skipped.

Two open branches that both bump the version conflict on the version lines.
To resolve the conflict, take main's version in every conflicted file, then run `npm run bump` again with the same level.

## Not included

- OpenCode support. [Adding a provider](agents.md#adding-a-provider) says what a new host needs.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.
