# Contributing

This page is for changing the plugin itself. To use the plugin in a project, start at the [README](../README.md#install).
[architecture.md](architecture.md) maps the repository.

Read [working-agreement.md](working-agreement.md) first: the rules every change keeps, and where to work.

## Build and check

```sh
npm ci
make hooks       # once per clone, run by the Human in the main checkout: the hooks in .githooks/
npm run build    # after editing plugins/aidrian/agents-src/<group>/, providers/, or agent-addons/
npm run check    # what CI runs
```

`make` lists the same tasks.
The hooks in `.githooks/` keep the private words of `.banned-terms.local` out of commit messages and branch names,
and refuse a commit in the main checkout or one that newly stages a git-ignored file ([Commit guard](hooks.md#commit-guard)).
`make hooks` sets `core.hooksPath` to the main checkout's `.githooks` by absolute path, so git runs them for a commit
made through `GIT_DIR` or `--git-dir` from another folder too, and every worktree runs the main checkout's copy.
A clone set up with the earlier relative `.githooks` reruns `make hooks`. Agents are denied setting `core.hooksPath`.

`npm run check` fails when:

- a generated agent is stale, or edited by hand;
- the example's project folder, or this repository's own, is invalid;
- a test fails;
- the branch changes the plugin version ([Versions](#versions)).

## What the tests hold

- Both marketplaces publish the one plugin from `./plugins/aidrian`.
  Both plugin manifests have the same `name`, `version`, `description`, `author`, and `repository`.
- Every agent preloads the `knowledge` skill, and asks only for tags that skill lists.
- [Agents and skills](agents-and-skills.md) lists every agent and skill shipped, once.
  Its agent tables match the [group folders](agent-sources.md#groups) of the agent sources.
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
Bash runs inside that temporary clone. Each case's `scaffold.sh` clones the committed HEAD into the run's folder and removes the skill under test, so the
baseline run without the plugin cannot read it. A case that needs a file HEAD lacks, such as the plan `plan-review-trigger`
reviews, keeps it in its own folder, and its `scaffold.sh` copies it in. A case about a consumer project, such as
`harness-setup-onboard`, builds the run folder from its own committed `fixture/` alone, and writes any `AGENTS.md`
and `CLAUDE.md` it needs from `scaffold.sh`, never `fixture/`. Commit first, then, from `plugins/aidrian`:

```sh
claude plugin eval . --scaffold --trust-plugin --no-publish --runs 1 --allow-tools Bash --model <haiku|sonnet|opus>
```

A case earns its place when it passes with the plugin and fails without it. Results go to `evals/**/results/`, which git ignores.

## Versions

Users receive a change only after the version changes on main: both hosts install from main and cache by version.
A version change is a release, and only the release workflow, `.github/workflows/release.yml`, makes one.

A pull request never changes the version, so two open pull requests never conflict on it.
`npm run check` fails when the version files disagree, and when the branch holds a version other than its merge base
with `origin/main` in any of them. Main may release while a branch is open: the branch takes the new version when it
merges main, and need not before. Without `origin/main`, or on `main` itself, that comparison is skipped.

After each merge to main, the workflow runs `node scripts/version.mjs release`. It counts the commits since the latest
`v*` tag that change `plugins/aidrian/`; with none, it releases nothing. Otherwise it raises the version in every file
that carries it, runs `npm run check`, commits `chore(release): aidrian vX.Y.Z`, tags `vX.Y.Z`, pushes both at once,
and publishes the release notes.

The commit subjects pick the level. Main takes squash merges, so each subject is a pull request's title, and the
`PR title` workflow fails a title that is not a Conventional Commit subject, such as `fix(hooks): let a hook pass`.

| Subject | Level | Example |
| --- | --- | --- |
| A `!` before the colon | major | `feat(config)!: rename the review keys` |
| `feat` | minor | `feat(review): cite focus` |
| Any other type, or no Conventional Commit at all | patch | `fix(pr-body): name the allowed path` |

The highest level among the subjects wins. While the version is `0.x`, a breaking change raises minor:
`1.0.0`, and any major release, comes only from running the workflow by hand with `level` set to `major`.
The same input forces any level, and releases even when no plugin commit is waiting.

When a project's `requires.aidrian` should name a new version ([Plugin version](config.md#plugin-version)),
raise it after that release ships, in a later pull request: before the release, no plugin satisfies it.

To try a change in a local install, `npm run bump` raises the version in the working tree (`minor` or `major` as an
argument; patch by default), so the host sees a new version. Set it back before you commit: `npm run check` fails until
you do.

The release counts from the latest `v*` tag, and fails when that tag is missing or is not the version in the files.
A repository that starts releasing this way tags the commit that set the current version once, by hand:
`git tag vX.Y.Z <commit> && git push origin vX.Y.Z`.

## Not included

- OpenCode support. [Adding a provider](agent-sources.md#adding-a-provider) says what a new host needs.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.
