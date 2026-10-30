---
name: knowledge
description: Load the project's rules from its .aidrian/ knowledge before planning, editing, or reviewing.
---

# Project knowledge

The aidrian plugin ships generic agents and skills.
Each project brings its own rules as knowledge buckets: folders of Markdown docs, indexed in the project folder,
`.aidrian/` at the repository root or the folder `.aidrian.json` names (`.aidrian/` below means that folder; `aidrian check` validates it).
This skill is how you find and read them, and which shared defaults apply when a project says nothing.

## Load before you work

1. Read the `always` docs now. A hook names them at the start of every session and subagent.
2. When the task touches the area of one of your tags, read the docs routed to that tag.
   Your tags are your agent's knowledge tags, plus any tag your dispatcher or the task names.
   Add `product_sensitive` when the task touches what users see, money, data, or lifecycle rules.
3. For anything else, search the docs' one-line summaries, and read the ones that fit the task.
4. Read each doc once. Never read a whole bucket "to be safe".

With a shell, step 2 is `aidrian-knowledge route <tag>` and step 3 is `aidrian-knowledge search <words>`.
When the command is not on your PATH, run it by the full path the start hook prints.

Without a shell, or without the command, read the indexes `.aidrian/knowledge/*.json` with your file tools
(Read and Grep in Claude Code), in file-name order. Each index has:

- `dir`: the folder of its docs, relative to the project root, which holds `.aidrian/` or `.aidrian.json`; doc paths are relative to `dir`.
- `always`: the docs of step 1. Read them when the hook did not name them.
- `docs`: each doc with its `summary` and `tags`. Step 2 reads the docs whose `tags` hold the tag;
  step 3 searches the `summary` lines for your words.

A tag from the Tags list below that no bucket defines loads nothing; that is not an error.
A tag that is on neither that list nor a bucket is a typo, and `route` fails on it.

If `.aidrian/config.json` does not exist, read the project's `AGENTS.md`, `CLAUDE.md`, and `README.md` instead,
and report `knowledge: none` in your result. `harness-librarian` sets the folder up.

## Precedence

1. The project: its knowledge docs, `AGENTS.md`, and `CLAUDE.md`.
2. The workflow of the skill that is running.
3. Your agent instructions from this plugin, and the defaults below.

When a project doc contradicts a plugin instruction, follow the project and name the conflict in your result.

## Shared defaults

A project overrides any of these in an `always` doc.

- Local plans live in `<state>/plans/`, where `<state>` is the folder `aidrian state` prints. Create task worktrees with `aidrian worktree new`.
- No `testing` docs: a step that runs the test commands that knowledge names takes them from `package.json` scripts,
  the `Makefile`, or the CI workflow, and says which. None found: say so in `risks`; a check that never ran never passed.
- No branch format in the `issue_tracker` knowledge: `<type>/<key>-<slug>`, or `<type>/<slug>` with no issue,
  where `<type>` is a Conventional Commits type, such as `fix/123-login-redirect`.
- A tool your role denies is a routing signal: when the task needs one, stop and return `status: blocked`,
  with `next_owner` the agent that has the tool and one line on what you needed and why. Never work around a denial.
- When another agent reads your result, return one JSON object, the machine handoff, with these fields:
  - `status`: `done`, `blocked`, `needs_input`, or `no_op`.
  - `role`, and `decision`: what you concluded, in two sentences at most.
  - `evidence`: at most six items, each a file, command, or link with what it shows.
  - `loaded_docs`, `deferred_refs` (what to read next, in order), `blockers`, `risks`, and `next_owner`.
  - `artifacts`: bulky output such as long search results, so the fields above stay short.
- In replies, docs, handoffs, commits, and pull request bodies, name the human and the AI instead of writing "you", "me", or "I".
  The start hook gives both names; without it, write "the Human" and your host's name, such as Claude or Codex.
- An agent named in this plugin's text, such as `explorer`, is this plugin's agent when the host lists it as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex; spawn it by that name.
  Any other named agent is a role the project may supply, under its own name.
  If one is missing, say so in `blockers`; never replace it with a generic agent.
- **The agent rule.** Every skill and agent picks an owner by this rule. The project may supply its own agents.
  Before the first dispatch, read the agent registry in the project's `orchestration` knowledge when it has one.
  When a project agent's description fits the task, dispatch it under its own name instead of this plugin's agent for that surface;
  when a project agent and a plugin agent share a name, the project's wins.
  A plugin agent is the fallback for a surface no project agent covers.
  Say in `decision` which agent you chose when both existed.

## Tags

The plugin's agents and skills ask for these tags. Use them in your buckets so the agents find your docs.
A project may add its own tags for its own skills and dispatches.

- `product_sensitive`: product rules a change must not break: what users see, money, data, and lifecycle rules.
- `code_style`: code conventions and the helpers to reuse.
- `backend`: server-side rules: API shape, validation, persistence, jobs, and the data-access boundaries to respect.
- `frontend`: client-side rules: framework conventions, routing, data fetching, state, and the client/server boundary.
- `security`: trust boundaries, sensitive data, and the surfaces that need a security pass.
- `testing`: how tests are written and which suites to run.
- `e2e`: end-to-end tests: how to write and run them.
- `review`: the project's review checklists per language and framework, and what counts as a blocking finding.
- `issue_tracker`: the tracker (Linear, GitHub Issues, or another), team keys, labels, estimates, and the issue format.
  `references/tracker.md` maps each issue step to the tracker's tool; read it before any issue read or write.
- `orchestration`: how work is split, dispatched, reviewed, and merged; branch and worktree rules.
- `design_bundle`: design handoff bundles, design tokens, and component reuse.
- `docs`: which docs exist, who owns each tree, and how docs stay current with code.
- `harness_engineering`: how the project maintains its AI instructions, checks, and budgets.
- `i18n`: translations and locale files.
- `feature_flags`: feature-flag scaffolds and rollout rules.
- `support`: canonical support answers, tone rules, escalation policy, and how to look up a customer's state.
- `marketing`: positioning, voice, channels, competitor and market notes, and experiment rules.
