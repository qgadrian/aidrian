# Working agreement

The rules every change to this repository keeps. Every agent and session here reads this page, so it stays short.
How to build, check, and release a change is in [contributing.md](contributing.md).

## Where to work

- Work in a task worktree, `aidrian worktree new <branch>`, never in the main checkout.
  Several sessions share that folder, so the [main-checkout guard](hooks.md#main-checkout) blocks edits there,
  branch switches away from `main`, and `git add -A` or `git commit -a`.
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
- A change to a surface updates that surface's doc in the same branch, and [agents-and-skills.md](agents-and-skills.md)
  when an agent or skill is added, renamed, or removed.
- A change under `plugins/aidrian/` bumps the version ([Versions](contributing.md#versions)).
- `npm run check` passes before a push.

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
