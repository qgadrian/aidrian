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

Last, `scripts/code-shape.mjs` lists on stderr the files of `plugins/aidrian/lib/` over 300 lines, the functions over 40,
and the nested ternaries, by the [default code style](../plugins/aidrian/skills/knowledge/references/code-style.md).
These are warnings, and never fail the check.

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
- No skill, agent source, host add-on, or brief template asks for `git commit --amend`, which the amend rule refuses.
- Every host and tracker adapter passes the conformance suite, `test/adapters.test.mjs`, which iterates the registries.
- Shared code reads no host's variable and branches on no host's tool, past a list in `test/host-coupling.test.mjs` that can only shrink.
- Every `SKILL.md` fits in 7,500 bytes, because Codex cuts it at 8,000.
  A longer skill moves detail into `references/` files that `SKILL.md` names, with when to read each,
  and a skill with several modes keeps each mode in `modes/<mode>.md`, read once the mode is selected.

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
and `CLAUDE.md` it needs from `scaffold.sh`, never `fixture/`. A case that needs lessons, such as
`lesson-triage-peek`, sets `state.dir` in the copy's config.json and `XDG_STATE_HOME` to folders in the run's folder,
then seeds them with `aidrian lesson add`, so seeding writes no inbox outside it; the run's own `aidrian lesson` commands
still resolve the plugin's inbox from the machine's state root. A case that needs persona audits, such as
`persona-audit-triage-confirm`, sets the same `state.dir` and copies the synthetic reports of
`test/fixtures/persona-audit/` into its `audits/` folder, with small images the Read tool opens for their screenshots, and gives the
project a small knowledge bucket: a product-access doc and an issue tracker kept as files, which needs no network and
which `persona-audit-triage-no-tracker` leaves out. `test/audits.test.mjs` runs those scaffolds, without a
model, to check they seed the run folder alone. A run's PATH can hold an installed plugin's `aidrian` before the
branch's; the [start hook](hooks.md#start-lines) then names the branch's by its path, so the run exercises the branch.
The `product-quorum-auto-start-*` cases share the fixture of `product-quorum-auto-start-off`, and their scaffolds copy it from the working tree,
so they run before a commit.
Every other case reads HEAD, so commit first. Then, from the worktree root:

```sh
claude plugin eval plugins/aidrian --case <name> --model <model> --no-publish --scaffold --trust-plugin --runs 1 --allow-tools Bash Write Edit
```

`--scaffold` runs the case's `scaffold.sh`; without it the run folder is empty. `--allow-tools` grants the tools a run may use:
without Bash no case reaches a command, and a case that writes a doc also needs `Write` and `Edit`. Add `--keep-temp` to keep each run's trace.
On macOS, the eval's sandbox can make Node's spawn of a bare `git` fail with EPERM when PATH holds a folder it denies.
Then `aidrian` reads no base, and a case on routing prints the rule `no-base`.
Put a `git` the sandbox can run first on PATH, such as `PATH="/opt/homebrew/bin:$PATH"`.

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

- OpenCode support, or a tracker other than Linear. [Adding a host, a tracker, or a forge](providers/adding-a-host.md) says what each needs.
- The optional cockpit pane. It lives on the `parked/cockpit` branch and is not reviewed.
