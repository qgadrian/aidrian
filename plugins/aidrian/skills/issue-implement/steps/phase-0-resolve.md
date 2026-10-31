# Phase 0: resolve the issue

Read-only on the tracker. A failed guard below is a **stop and ask** unless it says otherwise.
The `knowledge` skill's `references/tracker.md` maps each step below to the tracker's tool; read it first.
Linear tool names are the connector's, such as `get_issue`; use the host's Linear tools with the same intent.

## 1. Preflight

- The main checkout is the parent folder of `git rev-parse --path-format=absolute --git-common-dir`.
- `<state>` is the folder `aidrian state` prints. A plan for this issue may exist at
  `<state>/plans/<key>-implementation.md`, the key in lowercase, in the `planning-agent` skill's `references/plan-file.md` schema.
  Use it for phase 2 unless it is stale: `generated_at` older than 7 days, the issue's `updatedAt` newer than its `ticket_updated_at`,
  or a `files_in_scope` path missing that no slice creates. Stale: ask whether to plan again or go on with it.

## 2. Resolve the reference

- A key in the project's format, or an issue URL of its tracker: take the key, as `references/tracker.md` says.
- Anything else, such as a reference to another tracker: ask for the key. Never search a tracker to guess it.
  A key the Human offers may be confirmed by its links back to the old reference.

## 3. Fetch

The tracker's read step returns the title, description, labels, state, assignee, links, blocking issues, parent,
branch name on Linear, comments, and `updatedAt`. Keep one snapshot for the run; fetch again only when the Human asks.

## 4. Base branch

First match wins: `--base`; the target branch the issue declares under its dependencies and sequencing; config.json `git.defaultBranch`.
Only a successful read that finds no declaration falls back to the default: a failed read is unknown.

A base other than the default must already exist: `git fetch origin`, then `git rev-parse --verify origin/<base>`.
Missing: stop and ask, quoting the commands that create it from the default branch. Never create it, and never fall back:
a pull request against the wrong base ships a partial change.
Record the base and its source for the report.

## 5. Re-entry

When the issue's branch (phase 1) exists with commits ahead of `origin/<base>`:

- `git log --oneline origin/<base>..<branch>` and `git diff --stat origin/<base>...<branch>`.
- Mark each plan slice whose commit subject appears there `complete`.
- `gh pr list --head <branch> --state open --json number,url`. An open pull request: stop and ask whether to update it or start over.
- Otherwise resume at the first incomplete slice. Do not plan again or rewind.

## 6. Parse the description

Read the sections of the issue format the project's `issue_tracker` knowledge defines, such as goal, scope, non-goals,
files to modify, create, reference, and reuse, constraints, dependencies and sequencing, acceptance criteria with ids
such as `AC1`, verification, and the agent action plan with its owners, reviewers, and validators.

Every agent the action plan names must exist, as a project agent or this plugin's.
A missing one: ask whether to substitute by the routing rule.

## 7. Precedence

On a conflict: the Human's explicit scope in this session, then project knowledge, then the issue's agent action plan,
non-goals, and files to modify, then the critical-flow, product, and security gates, then this skill's defaults.

## 8. Guards

- **Terminal**: the issue is closed, as `references/tracker.md` defines it.
- **Assignee**: assigned to someone other than the current user. Never change the assignee.
- **Blocked**: an issue it is blocked by is not closed. Note the issues it blocks, and its parent, in the report.
- **Merge dependencies**: the dependencies section lists one that has not merged.
- **Silent issue**: no acceptance criteria, no meaningful description, and no files to modify. Offer `agent-issue-writer` to fill it in.
- **Critical flow**: run `aidrian-knowledge route product_sensitive` and read what it lists.
  When the issue touches a flow those docs declare critical: `product-manager` first, then a `planning-agent` plan.
  Implement only after every `critical_flow[].sign_off` is `approved`; `code-reviewer` signs off after the implementation.

Nothing writes to the tracker but the writes `references/hard-rules.md` § Tracker writes lists, and nothing before phase 7 opens anything on GitHub.
