# Contributing

This page is for changing the plugin itself. To use the plugin in a project, start at the [README](../README.md#install).
[architecture.md](architecture.md) maps the repository.

Read [working-agreement.md](working-agreement.md) first: the rules every change keeps, and where to work.

## Build and check

```sh
npm ci
make hooks       # once per clone, run by the Human in the main checkout: the hooks in .githooks/
npm run build    # after editing plugins/aidrian/agents-src/<group>/, providers/, agent-addons/, or hooks/hooks.json
aidrian test changed  # before a push: the test files the change touches
npm run check    # npm run check:static && npm test, what CI runs on the pushed head
```

`npm run check:static` is everything but the tests: the generated-files check, `aidrian check` on the example and on
this repository, `npm run lint`, the version check, and the code-shape scan. For each of Node 22, 24, and 26, CI runs it
as `Static checks (Node N)` and the tests as `Tests (Node N, 1/2)` and `Tests (Node N, 2/2)`, half the test files each,
every file whole in one shard and held to its [budget](test-processes.md#child-process-budget) there. Each of those jobs
that passes uploads a record of it, `passed-tests-nodeN-shardS` or `passed-static-nodeN`. `Check (Node N)`, the required
check, passes only when every one of those jobs passed and it finds every one's record: a matrix job's result can read
success when one of its jobs was cancelled before a runner took it, so a missing record fails the check instead.
A record is kept 30 days, the time GitHub allows a rerun in, so a partial rerun of the failed jobs reuses the records
the jobs that passed earlier left. `test/ci-workflow.test.mjs` holds the list the check looks for to the jobs' matrices,
and each record's retention to those 30 days.

Push a change once its touched tests pass, and let CI run the commands of `npm run check`: a full local run on a loaded machine once
held a fix back for two hours. Run it locally only when CI cannot, once, before marking ready.
This repository opts into [push first](hooks.md#push-first) and the [check-run record](hooks.md#check-runs):
`.aidrian/config.json` sets
`"testing": { "fullSuite": ["npm run check", "npm test", "npm run test", "node scripts/run-tests.mjs"], "pushFirstMinutes": 5 }`,
since `npm test` and the script behind it run the whole suite here too. So a session's `npm run check`, bare `npm test`,
or bare `node scripts/run-tests.mjs` is refused while the pushed branch lacks a commit older than 5 minutes, and a `## Tests run` line that says one of them passed needs a finished run of it.
With `env -C`, write a literal absolute path: a run in a variable's folder supports no line.
`npm test -- <files>` runs only those files, and push first leaves it alone. Its `requires.aidrian` asks for 0.73.1, the first release whose
config check knows the `testing` keys; an older installed plugin rejects them.

`npm test` and `npm run check` run the suite through `scripts/run-tests.mjs`, which runs `node --test` with its arguments
and passes the runner's output through. After the run it prints on stderr the ten test files that took the most time,
each with its seconds, its `git` calls, and its other child processes, and a line of totals summed over every file that ran, one shard's in CI:
the numbers a change to the suite's time moves. The counts cover the processes a test file's own process starts:
a command or hook a test starts counts as one, and the processes it starts in turn are not counted.
A file run alone, `node --test test/<name>.test.mjs`, still works the same way, with no table.

`make` lists the same tasks.

A change under `plugins/aidrian-claude-mod/` also passes `claude plugin validate plugins/aidrian-claude-mod` and
`claude plugin test plugins/aidrian-claude-mod` before a push. CI does not run them, so they are the local gate for
the [Claude mod](claude-mod.md).

Every test file imports `scripts/test-state.mjs` first, and `test/test-state.test.mjs` fails on one that does not.
It gives the run its own state folder, temporary folder, and fake `gh`, so a file run alone, `node --test test/<name>.test.mjs`,
writes no fixture lesson or state folder into this machine's own state folder.
The unattended marks and chain floors are read in the user's own `~/.local/state/aidrian` too, which no variable moves,
so a test call that reads them, such as `continueBrief`, `routeOf`, or `readUnattendedMark`, passes `home`, as `TEST_HOME` from
`test/fixtures/test-home.mjs`, and `test/unattended-mark.test.mjs` fails on one that does not.
A gate or hook a test starts as its own process, such as `aidrian handoff continue` or the Stop hook, still reads the
user's own folder, so a test runs the gate in process where the command line is not what it checks.
A probe script that runs a hook or a command by hand takes the same preload: `node --import ./scripts/test-state.mjs probe.mjs`.
The hooks in `.githooks/` keep the private words of `.banned-terms.local` out of commit messages and branch names,
and refuse a commit in the main checkout, one that newly stages a git-ignored file, or one that adds a conflict marker ([Commit guard](hooks.md#commit-guard)).
`make hooks` sets `core.hooksPath` to the main checkout's `.githooks` by absolute path, so git runs them for a commit
made through `GIT_DIR` or `--git-dir` from another folder too, and every worktree runs the main checkout's copy.
A clone set up with the earlier relative `.githooks` reruns `make hooks`. Agents are denied setting `core.hooksPath`.

`npm run check` fails when:

- a generated agent is stale, or edited by hand;
- `plugins/aidrian/opencode/routes.generated.json`, the hooks the OpenCode bridge runs, is missing, stale, or edited by hand,
  or `hooks/hooks.json` holds a hook it cannot run: one other than `node "$CLAUDE_PLUGIN_ROOT/scripts/<name>.mjs"`
  followed by `--flag` arguments, one with no positive `timeout`, one with a field besides `type`, `command`, and `timeout`
  or in a group with one besides `matcher` and `hooks`, such as `if` or `async`, or a matcher the bridge would read otherwise than
  Claude Code: none on a tool event, where `"*"` means every tool, or one with a comma or whitespace, where `|` separates names;
- the example's project folder, or this repository's own, is invalid;
- a test fails;
- a test file starts more child processes than its [budget](test-processes.md#child-process-budget);
- the branch changes the plugin version ([Versions](#versions)).

At the end of `npm run check:static`, `scripts/code-shape.mjs` lists on stderr the files of `plugins/aidrian/lib/` over 300 lines, the functions over 40,
and the nested ternaries, by the [default code style](../plugins/aidrian/skills/knowledge/references/code-style.md).
These are warnings, and never fail the check.

## Load-independent deadlines

A full local run loads the machine, and a test that races a real deadline then fails at random.
A test that does not test the deadline itself gives the code the time the test says:

- In process, through the rule's clock seam, such as the ready hold's `now` (`deadlineForge`, `FROZEN` in
  `test/ready-hold.test.mjs`), or a `Date.now` mock that steps 1 ms a read, which still ends a lock's wait
  (`test/hook-bash-post.test.mjs`).
- For a hook run as a program, under a test-owned preload: `test/fixtures/frozen-clock.mjs` stands `Date.now` at the
  process's start, so the ready hold gives each `gh` call its 3.5 s; `test/fixtures/frozen-performance.mjs` stands
  `performance.now`, the guards' clock (`lib/deadline.mjs`), at `FROZEN_PERFORMANCE_MS` from the hook's start (`late`
  in `test/guard-budget.test.mjs`). The plugin reads no test switch: a real session's hook keeps its whole deadline.
- `node --import test/fixtures/gh-spawns.mjs <cli>` records each `gh` call in the command's process before the spawn,
  with the time limit and signal asked for, and in `<GH_SPAWN_LOG>.exits` the status and signal it ended with.
  Assert what was asked, never the wall time from it.
- `node --import test/fixtures/waits.mjs <hook>` with `WAIT_LOG` set records each sleep and `Atomics.wait` it starts:
  "at once" is no wait at all.
- A "fast" claim bounds processor time: `process.cpuUsage()` around an in-process call, or
  `node --import test/fixtures/cpu-used.mjs <cli>` with `CPU_USED_LOG`, which counts that process alone.

A test of the deadline itself keeps the real clock, and no production deadline changes for a test.

## Hooks in the test's process

Each hook script exports its body as `handle`, and runs it only as the main script. A test calls a hook with
`await hookCall(script, { input, cwd, env })` (`test/hook-call.mjs`), which runs `handle` in the test's own process and
returns spawnSync's `{ status, stderr, stdout }`, without starting a node process for each call. Calls run one at a
time: `callHook` (`lib/hook-io.mjs`) swaps in the call's folder and environment, and each call starts with no stopped
git call and no clone anchor, as a host's fresh process does. A hook with a time budget counts it from the call's start.

A lib call outside `withGitFacts` (`lib/git.mjs`) asks git every time, so a test may change a repository between two
calls, such as with `git remote add`. Inside one, a checkout's roots, its prefix, origin's URL, and the remote URLs are
each read once per folder, until the call ends. A review step runs inside one (`lib/review/run.mjs` reviewStep), so a
test that changes a repository's remotes or folders does it between steps, or during the bot wait: that wait runs in
`withoutGitFacts`, which asks git for each read and makes the step forget every answer once the wait ends. Outside a review
step, one read or write of the review record (`lib/review/state.mjs` readLocalState and writeLocalState,
`lib/review/record.mjs` recordPass) opens one for that call alone, and inside one it shares the step's, so a test changes
the remotes between two such calls. The forge reading a record write may ask for runs in `withoutGitFacts` too.
Two guard reads open one for that call alone as well: the places of a session no Human attends
(`lib/unattended-write.mjs` unattendedPlaces) and the whole list of a project's state folders (`lib/handoff-guard.mjs`
stateFolders without `lazy`, whose iterator opens none), so a test changes a repository between two such calls.
`test/git-call-log.mjs` logs the git calls a test makes: `factReads` gives the fact reads of a call in the test's process,
and `gitLog` a PATH value for an environment the test hands a call.
Nothing opens one for a whole process, a hook's or a command's.

A test still starts the script as a program where only a process shows the behaviour: its stdin reading, a `timeout`
or signal it relies on, exit timing, or a deadline it measures. Keep at least one such run for each hook script a file
covers, so the script's own entry stays tested. A hook body that reads the clock under `Date.now` can be held still
in process by replacing `Date.now` around the call, as `test/ready-hold.test.mjs` does.

The tests' git config holds a user identity: without one, git guesses an email from the machine's host name, and on a
machine whose name does not resolve each clone, checkout, or commit waits about 5 seconds for that lookup.

## What the tests hold

- The Claude Code marketplace lists `aidrian`, from `./plugins/aidrian`, then the optional Claude mod `aidrian-mod`,
  from `./plugins/aidrian-claude-mod`; the Codex marketplace lists `aidrian` alone.
  Both `aidrian` manifests have the same `name`, `version`, `description`, `author`, and `repository`,
  and the Claude mod's manifest has their `author` and `repository`.
- Every agent preloads the `knowledge` skill, and asks only for tags that skill lists.
- [Agents and skills](agents-and-skills.md) lists every agent and skill shipped, once.
  Its agent tables match the [group folders](agent-sources.md#groups) of the agent sources.
- No project-specific path leaks into the plugin.
- No tracked file names a person.
  The owner's GitHub name appears only where a user installs: the README, the example's settings, and the manifests.
- Every agent and skill description fits in 160 characters. Hosts can exclude manual-only skills from implicit prompts.
- No skill, agent source, host add-on, or brief template asks for `git commit --amend`, which the amend rule refuses.
- Every host and tracker adapter passes the conformance suite, `test/adapters.test.mjs`, which iterates the registries.
- Shared code reads no host's variable and branches on no host's tool, past a list in `test/host-coupling.test.mjs` that can only shrink.
- Every `SKILL.md` fits in 7,500 bytes, because Codex cuts it at 8,000.
  A longer skill moves detail into `references/` files that `SKILL.md` names, with when to read each,
  and a skill with several modes keeps each mode in `modes/<mode>.md`, read once the mode is selected.

When `claude` and `codex` are on your PATH, `test/hosts.test.mjs` also checks the real hosts. Neither check runs a model.

- Claude Code validates the plugin and loads every agent, skill, and hook event.
- Codex installs every skill, lists manual-only skills in the explicit catalog, and shows implicit skills and agents in the project prompt.

## Model prices

The costs in the dispatch log come from price rows each host adapter owns ([Model prices](dispatch-log.md#model-prices)).
The `model-prices` skill, `.claude/skills/model-prices/SKILL.md`, says how to refresh them from each vendor's page
and open the pull request. It is a skill of this repository only, never shipped in the plugin.
`aidrian report health` names a model with no row of its own, and a table read over 60 days ago.

## Trying a branch

To try a branch in a real session before it merges, install the plugin from your checkout:
[Claude Code](providers/claude-code.md#from-a-local-checkout), [Codex](providers/codex.md#from-a-local-checkout).

### A live Claude Code run the session drives

A session can run a live Claude Code test of its own change, with no Human at the keyboard: it drives a second
`claude` through tmux, with the branch's plugin loaded and the installed one turned off. A live test is never handed to
the Human when this recipe can run it.

```sh
copy=$(mktemp -d)/aidrian && cp -R plugins/aidrian "$copy"
# Raise the copy's version, never the checkout's, so the run reads as a version of its own.
node -e 'for (const f of process.argv.slice(1)) { const fs = require("fs"); const j = JSON.parse(fs.readFileSync(f)); j.version += "-try"; fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n"); }' "$copy/plugin.json" "$copy/.claude-plugin/plugin.json"
tmux new-session -d -s try -c <scratch project> \
  "claude --plugin-dir $copy --settings '{\"enabledPlugins\":{\"aidrian@aidrian-harness\":false}}'"
tmux send-keys -t try '<the prompt that exercises the change>' Enter
tmux capture-pane -p -t try   # read the screen; repeat until the run settles
tmux kill-session -t try
```

The scratch project is a git repository whose `.aidrian/config.json` is committed: a worktree the run makes has only
committed files, so with the config left untracked its worktrees have none, and a knowledge route there reads `none`.

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

Users receive a change only after its plugin's version changes on main: Claude Code and Codex install from main and
cache by version. OpenCode is the exception: an entry that follows `#main` gets a merge before its release commit
([OpenCode](providers/opencode.md#update)). A version change is a release, and only the release workflow, `.github/workflows/release.yml`, makes one.
Each plugin of the marketplace versions, tags, and releases on its own: the `PLUGINS` table in `scripts/version.mjs`
names each plugin's folder, its tag prefix, and the files that carry its version.

| Plugin | Folder | Tags | Version files |
| --- | --- | --- | --- |
| `aidrian` | `plugins/aidrian/` | `vX.Y.Z` | both plugin manifests, `plugins/aidrian/package.json` (the OpenCode package), the root `package.json`, `package-lock.json` |
| `aidrian-mod` | `plugins/aidrian-claude-mod/` | `aidrian-mod-vX.Y.Z` | `.claude-plugin/plugin.json` |

A marketplace entry that sets a version is one more version file, for the plugin its name matches; an entry that sets
a version under a name no plugin has fails `npm run check`. A table plugin whose folder does not exist yet is skipped.

A pull request never changes a version, so two open pull requests never conflict on it.
`npm run check` fails when a plugin's version files disagree, and when the branch holds a version other than its merge
base with `origin/main` in any of them. A plugin new on the branch, with no version file at the merge base, is not a
version change: its files need only agree. Nor is a version file new on the branch, such as a manifest a host gains:
the check holds it to the plugin's other files. Main may release while a branch is open: the branch takes the new version
when it merges main, and need not before. Without `origin/main`, or on `main` itself, that comparison is skipped.

After each merge to main, the workflow runs `node scripts/version.mjs release`. For each plugin, it counts the commits
since that plugin's latest tag that change its folder; with none, that plugin releases nothing. Otherwise it raises
the version in every file that carries it, and prints one result line for the plugin. It reads the current version
from the files that its latest tag holds: a version file a pull request added may hold an older version, from the
branch's last merge of main, and the release raises it with the others. A first job, with no write token,
runs `release` and writes its commit and result lines as outputs, then installs with `npm ci --ignore-scripts` and runs
`npm run check`. A second job, the only one with the write token, first fails unless that commit is a full sha that
is on `origin/main`. It installs nothing, caches nothing, and runs no repository code but `scripts/version.mjs`, one call
per step: `release --expect` runs `release` again on that commit and fails, before it writes, unless its result lines
are the first job's; `commit-and-tag --results` commits the version files once as
`chore(release): aidrian vX.Y.Z, aidrian-mod vX.Y.Z` and tags each released plugin, deciding by each place a
version is written, so a marketplace that versions both plugins serves one plugin's release and another's first.
The job then pushes the commit and the tags at once, with no git hook, and publishes each tag's release notes; only
aidrian's release is marked the repository's latest. A plugin's notes list every pull request merged since that
plugin's previous tag, the other plugin's too, since both share one history.

The commit subjects pick the level. Main takes squash merges, so each subject is a pull request's title, and the
`PR title` workflow fails a title that is not a Conventional Commit subject, such as `fix(hooks): let a hook pass`.

| Subject | Level | Example |
| --- | --- | --- |
| A `!` before the colon | major | `feat(config)!: rename the review keys` |
| `feat` | minor | `feat(review): cite focus` |
| Any other type, or no Conventional Commit at all | patch | `fix(pr-body): name the allowed path` |

The highest level among a plugin's subjects wins. While a version is `0.x`, a breaking change raises minor:
`1.0.0`, and any major release, comes only from running the workflow by hand with `level` set to `major`.
That input reaches `aidrian` alone: it forces aidrian's level, and releases it even when no aidrian commit is waiting.
Every other plugin releases in the same run at the level its own commits call for.

When a project's `requires.aidrian` should name a new version ([Plugin version](config.md#plugin-version)),
raise it after that release ships, in a later pull request: before the release, no plugin satisfies it.

To try a change in a local install, `npm run bump` raises aidrian's version in the working tree (`minor` or `major` as
an argument; patch by default), so the host sees a new version. Set it back before you commit: `npm run check` fails
until you do.

A plugin's first release happens when no tag of its prefix exists anywhere in the repository. It takes the version in
the plugin's manifest, with no bump, changes no file, and tags the commit that added the manifest, which is already on
main. When a later commit changes the plugin's folder before that first tag exists, the first release is refused, since
the tag would name a version whose installs got later content: the release log names the tag and the commit, the other
plugins still release, and the run fails at its last step, `tag-check`, until a person pushes that tag by hand:
`git tag -a aidrian-mod-vX.Y.Z <commit> -m "aidrian-mod vX.Y.Z" && git push origin refs/tags/aidrian-mod-vX.Y.Z`.
The next run releases the later commits from it.

The release fails, changing no file, when a plugin's tag exists but none is reachable from main, or its latest tag is
not the version in its files. It fails the same way when a plugin has no tag of its prefix and the history cannot
show a first release: the clone is shallow, or the commit that added the manifest holds another version than the files,
as `aidrian`'s does in a clone with no tags. Tag the commit that set the version by hand, as the message says.

## Not included

- Any guard on OpenCode, which runs only the hooks that cannot block ([OpenCode](providers/opencode.md#limits)), and a tracker
  other than Linear. [Adding a host, a tracker, or a forge](providers/adding-a-host.md) says what each needs.
- A band for Codex: the optional Claude mod, `aidrian-mod`, is a Claude Code mod alone.
