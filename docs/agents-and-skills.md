# Agents and skills

Every agent and skill the plugin ships, grouped, with what each does.
To edit one of the plugin's own agents, see [agents.md](agents.md).

## Agents

Claude Code names each agent `aidrian:<agent>`, and Codex `aidrian-<agent>`.
A project's own agent wins over the plugin's for the work it covers: [Project agents](knowledge.md#project-agents).
The agent that builds or fixes a change commits and pushes it; the orchestrator never writes git.

| Coordination | What it does |
| --- | --- |
| `orchestrator` | Splits work and routes each part to the right agent. Never edits or writes git. |
| `integrator` | Lands slice branches in order onto one task branch. |

| Planning | What it does |
| --- | --- |
| `planning-agent` | Writes a complete local plan before the build. |
| `architect` | Designs boundaries and interfaces before the build. Read-only. |
| `initiative-agent` | Breaks a broad goal into ordered tracker issues. Read-only. |
| `agent-issue-writer` | Writes tracker issues with exact scope and checks. |
| `explorer` | Maps flows, call graphs, tests, and edge cases. Read-only. |
| `github-archaeologist` | Explains why code changed, from its history. Read-only. |

| Build | What it does |
| --- | --- |
| `backend-developer` | Builds backend and API work. |
| `frontend-developer` | Builds UI: components, state, accessibility; stack facts come from knowledge. |
| `doc-updater` | Fixes stale docs when no code change is involved. |

| Review and quality | What it does |
| --- | --- |
| `code-reviewer` | Reviews code for bugs, trust boundaries, and test gaps. Read-only. |
| `security-engineer` | Reviews trust-boundary work, with a fix for each finding. Read-only. |
| `helper-scout` | Finds existing helpers a change could reuse. Read-only. |
| `e2e-runner` | Runs end-to-end tests and triages each failure. |

| Product and design | What it does |
| --- | --- |
| `product-manager` | Checks work against the product rules. Read-only. |
| `designer` | Builds UI presentation: layout, consistency, and polish. |
| `ux-specialist` | Fixes friction in the product's main flows. |
| `ux-researcher` | Finds confusion on activation and marketing pages. Read-only. |
| `design-source-explorer` | Classifies a Claude Design export and writes its import. |

| Support and growth | What it does |
| --- | --- |
| `support-agent` | Answers support tickets from documented answers. |
| `feedback-synthesizer` | Turns feedback into ranked themes. |
| `marketing-orchestrator` | Combines the marketing agents below into one answer. Read-only. |
| `growth-hacker` | Designs small growth experiments. |
| `content-creator` | Drafts posts and landing copy. |
| `seo-specialist` | Finds search opportunities. Read-only. |
| `ai-citation-strategist` | Helps AI answer engines cite the product. Read-only. |
| `brand-guardian` | Keeps messaging clear and consistent. Read-only. |

| Harness | What it does |
| --- | --- |
| `harness-librarian` | Sets up a project's `.aidrian/` folder and writes its knowledge docs. |
| `harness-mechanic` | Maintains this repository. |

## Skills

Claude Code runs each skill as `/aidrian:<skill>`. In Codex, ask for it by name.

| Coordination | What it does |
| --- | --- |
| `orchestration` | The orchestrator's steps for worktrees, slices, and pull requests. |
| `autopilot` | Runs one task unattended to a draft pull request. Never merges. |
| `session-handoff` | Writes a brief so a fresh session can resume the work. |
| `session-continue` | Resumes work from a handoff brief. |

| Planning | What it does |
| --- | --- |
| `planning-agent` | Writes or revises a local plan file. |
| `plan-review` | Critiques a local plan. The Human approves each change. |
| `issue-plan` | Plans one issue before the build. |
| `initiative-agent` | Breaks a broad goal into a project of ordered tracker issues. |
| `agent-issue-writer` | Drafts or creates tracker issues for agents. |
| `challenge` | Tests a plan against the docs and code, one question at a time. |
| `adr-writer` | Writes an architecture decision record. |

| Build | What it does |
| --- | --- |
| `issue-implement` | Builds one issue to a draft pull request. |
| `plan-implement` | Builds a reviewed local plan to a draft pull request. |
| `design-import` | Turns a Claude Design export into a design import and plan. |
| `worktree-new` | Creates a task worktree and runs the project's bootstrap. |
| `worktree-integrate` | Lands slice branches in order onto one task branch. |
| `worktree-cleanup` | Removes the task worktrees whose work merged. |

| Pull requests | What it does |
| --- | --- |
| `pr-write` | Writes a pull request title and body from the real diff. |
| `pr-screenshot` | Attaches screenshots or files to a pull request. |
| `pr-review-loop` | Takes each review comment to a fix or a reply with evidence. |
| `pr-merge-when-green` | Merges once every check is final and passes. |

| Review and quality | What it does |
| --- | --- |
| `pr-review` | Reviews a pull request with the right agents. |
| `pr-review-fix` | Fixes the findings of a `pr-review` round. |
| `specialist-review` | One agent reviews the current branch's changes. |
| `issue-verify-ac` | Checks one issue's acceptance criteria against the code. |

| Harness | What it does |
| --- | --- |
| `knowledge` | Loads the project's rules. Every agent preloads it. |
| `knowledge-update` | Adds or refreshes knowledge docs from evidence. |
| `lesson` | Captures a session lesson into the inbox. |
| `lesson-triage` | Routes each open lesson to a fix. |
| `harness-health` | Explains the top problems in `aidrian report health`. |
| `skill-writer` | Creates, updates, or audits a skill. |
