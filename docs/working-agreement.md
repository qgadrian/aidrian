# Working agreement

The rules every change to this repository keeps. Every agent and session here reads this page, so it stays short.
How to build, check, and release a change is in [contributing.md](contributing.md).

## Where to work

- Work in a task worktree, `aidrian worktree new <branch>`, never in the main checkout.
  Several sessions share that folder, so on Claude Code and Codex the [main-checkout guard](hooks.md#main-checkout)
  blocks edits there, branch switches away from `main`, `git add -A`, and every commit or move of the branch, such as
  a reset or rebase, and the [commit guard](hooks.md#commit-guard) refuses a commit there too.
- On OpenCode no guard holds the session, so work only in a task worktree and never merge ([its limits](providers/opencode.md#limits)).
- A session runs the plugin version installed on its machine, never the branch it edits.
  To see a change to a hook, skill, or agent at work, [try the branch](contributing.md#trying-a-branch).

## Rules for every change

- Edit agents in `agents-src/`, `providers/`, or `agent-addons/`, then `npm run build`.
  Never edit `plugins/aidrian/agents/` or `plugins/aidrian/codex/agents/` by hand.
- `plugins/aidrian/lib/` and its scripts use Node 22 built-ins only: they run from the installed plugin, with no `npm ci`.
- A fix ships with a `node --test` case in `test/` that fails without it. Never weaken a test, check, or hook to pass.
- What a script can check becomes a test or a check, not a sentence in a skill or agent.
- A hook lets the action run when it cannot read its input: a hook never breaks a session.
- Plugin text names no project, project path, person, or bare slash command; a project's rules live in its own `.aidrian/`.
- The harness is provider agnostic: shared rules, code, and config assume no one host.
  Claude Code, Codex, and OpenCode 2.0 and later are today's hosts, OpenCode with the hooks that cannot block and no
  guard ([its limits](providers/opencode.md#limits)); others, such as DeepSeek Code or Kimi Code, may follow.
- `mcp__<server>__<tool>` is the standard format for naming an MCP tool in permissions and config.
  A host that names tools or events differently gets a translation layer that maps to the standard;
  the difference never spreads into shared code.
- A host-specific behavior lives in a translation layer: one adapter a host in `lib/hosts/`, one a tracker in `lib/trackers/`,
  and one a code forge in `lib/forges/` ([Adding a host, a tracker, or a forge](providers/adding-a-host.md)).
  For agents it is `providers/`, `agent-addons/`, and a generator in `scripts/build.mjs` ([Adding a provider](agent-sources.md#adding-a-provider)).
  `test/host-coupling.test.mjs` fails on shared code that reads a host's variable or branches on its tool,
  and `test/forge-coupling.test.mjs` on shared code that imports a forge adapter, runs gh, or builds a GitHub route.
  A doc states which hosts a feature is verified on, as the Host column of [hooks.md](hooks.md) and `docs/providers/` do.
- Support what shipped in about the last five years: current macOS, Linux distributions, shells, Node, and git.
  An older or stripped-down platform, such as an old macOS or BusyBox, gets no fallback, version note, or gate.
  A review finding that only such a platform meets is out of scope: answer it with this rule, and change nothing.
- Keep each mechanism small. When review keeps finding edge cases of one mechanism, simplify or remove it,
  or state the residual in the pull request; never add a gate for every case.
- A change to a surface updates that surface's doc in the same branch, and [agents-and-skills.md](agents-and-skills.md)
  when an agent or skill is added, renamed, or removed.
- A pull request never changes the version: the release workflow raises it on main after the merge, at the level
  the pull request's Conventional Commit title calls for ([Versions](contributing.md#versions)).
- `aidrian test changed` passes before a push; CI runs the commands of `npm run check` on the pushed head, the tests in
  two jobs a Node version ([Build and check](contributing.md#build-and-check)), and every `Check (Node N)` is green before ready.
- On Claude Code and Codex, the session that opens a pull request owns it to the end: it runs the review loop, marks it
  ready, and merges it through `pr-auto-merge` once every review signed off and every check is `SUCCESS`, without asking Adrian.
  Where that gate or the [merge guard](hooks.md#merge-guard) refuses, as for a guarded path such as a workflow,
  knowledge, or a guard rule, or a pull request an earlier session in a handoff chain marked ready, the session never
  works around it. A refusal it can clear, such as a timed-out read, a pending check, or open review work, it retries
  or clears; one that needs Adrian's review, such as a guarded path, it reports with the gate that refused and the one
  command Adrian runs, `gh pr merge <n> --squash --match-head-commit <sha>`. A handoff brief carries the ownership to the next session,
  which asks the gate again: a ready state it inherits is never permission to merge.

## This repository's knowledge

`.aidrian/knowledge/10-harness.json` indexes `docs/`, with this page as its one `always` doc.

- A new `.md` file under `docs/` needs its entry there, or `npm run check` fails.
- A doc is tagged only when every task of that tag needs it whole, within the [budget](config.md#knowledge-budgets).
  The per-surface docs, such as `hooks.md` and `config.md`, stay untagged, and search finds them by summary,
  so a summary names the rules and commands a search would use.
- No file under `docs/` is named `agents.md` or `claude.md` in any case: on a case-insensitive disk,
  Claude Code loads it into every session that reads a file in that folder.

## The plugin's tools for this work

- `worktree-new` starts a task; `worktree-cleanup` removes the worktrees whose pull request merged.
- The `harness-mechanic` agent changes the plugin; `harness-librarian` changes `.aidrian/`.
- `harness-health` ranks what to fix from the dispatch log, and `aidrian report` gives the detail.
- `lesson-triage` routes the lesson inbox: `target: plugin` lessons become plugin fixes, `target: project` lessons
  become changes to this repository's `.aidrian/` or docs. Only a person starts it, in a session opened for it.
- `pr-write`, then `pr-review-loop`, to open and answer a pull request.
