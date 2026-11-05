# Project config

`config.json` in the [project folder](project-folder.md) holds the folder version and the project's settings for the plugin.
The plugin's commands, hooks, and skills read it.
An `aidrian` command never acts on a `config.json` with an error, such as a renamed key.
It prints the errors and exits with its error code instead, such as 3 for `aidrian pr checks`.
The hooks keep working, with the default in place of each bad value.
Without a `config.json`, the commands use the defaults.

[`examples/consumer/.aidrian/config.json`](../examples/consumer/.aidrian/config.json) is a minimal, checked example.

## Keys

Only `version` is required. Every other key is optional, and the values below are the defaults.
In a group such as `github`, set only the keys you change; the others keep their defaults.

```json
{
  "version": 1,
  "git": {
    "defaultBranch": "main",
    "worktrees": {
      "dir": ".worktrees",
      "bootstrap": null,
      "disposable": ["node_modules", "dist", "build", ".next", ".cache", "coverage", ".turbo"]
    },
    "mainCheckout": { "guard": false, "allowWrites": [] },
    "commits": { "types": ["build", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test"] }
  },
  "state": { "dir": null },
  "github": {
    "requiredSections": ["Summary", "Tests run"],
    "reviewer": "chatgpt-codex-connector[bot]",
    "maxReviewRounds": 3,
    "extraRounds": "ask",
    "maxExtraRounds": 2,
    "requiredChecks": [],
    "ignoreCancelledChecks": [],
    "conditionalChecks": [],
    "titleIssuePrefix": false,
    "markReady": "auto",
    "reviewLoop": "auto",
    "pullRequest": {
      "title": null,
      "issueKey": null,
      "sections": null,
      "deferrals": null,
      "residuals": null,
      "sharedTempBodyFile": true,
      "duplicateBody": false
    },
    "reviewGate": { "enabled": false, "checklist": null },
    "autoMerge": { "allow": false, "default": "off", "strategy": null, "deleteBranch": false, "deleteWorktree": false }
  },
  "review": { "engine": null, "record": "comment", "rules": [], "ignore": ["<lockfiles, snapshots, generated, vendored, minified>"], "nonBehaviour": ["<docs and assets>"], "flows": {}, "planCommand": null, "reviewers": {} },
  "docs": { "wrapLimit": 155 },
  "terms": { "file": null },
  "knowledge": { "budgets": { "alwaysBytes": 16384, "taggedDocBytes": 24576 } },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 },
  "session": { "handoff": { "mode": "ask", "costRatio": 2, "maxTokens": 0 } },
  "lessons": { "auto": true, "maxOpen": 20, "maxAgeDays": 14 },
  "models": { "claude": { "agents": {} }, "codex": { "agents": {} } },
  "names": { "human": "the Human", "ai": null },
  "requires": { "aidrian": null },
  "attribution": { "commit": [], "pullRequest": [], "exclude": ["explorer", "helper-scout", "Explore", "claude-code-guide", "statusline-setup"] },
  "telemetry": {
    "enabled": true,
    "docReads": true,
    "hookDenies": true,
    "maxMb": 20,
    "health": {
      "minSample": 5,
      "redispatchPercent": 20,
      "sentBackPercent": 10,
      "topDocPercent": 50,
      "reviewRounds": 3,
      "lateFindingPercent": 50,
      "denyHotSpot": 5,
      "costRisePercent": 50,
      "decisionOverridePercent": 20,
      "decisionMinSample": 5
    }
  },
  "agents": {},
  "quorum": {
    "judge": { "agent": "architect" },
    "plan": {
      "a": { "agent": "code-reviewer" },
      "b": { "provider": "codex", "agent": "product-manager" },
      "maxObjections": 5,
      "maxDispatches": 8
    },
    "decide": {
      "odd": { "provider": "agent", "agent": "code-reviewer" },
      "even": { "provider": "codex", "agent": "code-reviewer" },
      "swap": true
    },
    "product": {
      "owner": { "agent": "product-manager" },
      "witness": { "agent": "ux-researcher" },
      "ux": { "agent": "ux-specialist" },
      "engineer": { "agent": "architect" },
      "maxLoops": 2,
      "autoStart": false,
      "approval": "first",
      "maxAutoRuns": 3
    }
  },
  "decisions": {
    "mode": "ask",
    "maxMode": "ask",
    "domains": { "product": "inherit", "ux": "inherit", "architecture": "inherit", "backlog": "inherit" },
    "classes": {},
    "escalate": [],
    "escalateDocs": [],
    "unattended": { "safeDefaults": "outside-escalated" },
    "secondLook": { "agent": "critic", "minSeverity": "high" },
    "record": { "queue": "pr-body" },
    "unreviewed": { "remind": "session-start", "pauseDomainAt": { "pending": 10, "oldestDays": 7 } }
  },
  "audits": {
    "triage": { "issueCreation": "confirm", "labels": ["persona-audit", "persona:{persona}", "severity:{severity}"] }
  }
}
```

| Key | Meaning |
| --- | --- |
| `version` | The format of the project folder. [project-folder.md](project-folder.md#versioning) gives the rule. |
| `git.defaultBranch` | The branch that work merges into. |
| `git.worktrees.dir` | The folder for [task worktrees](project-folder.md#task-worktrees), `.worktrees` at the repository root by default. |
| `git.worktrees.bootstrap` | One shell command to run inside each new worktree, such as `npm ci`; `null` runs nothing. |
| `git.worktrees.disposable` | Folder names, at any depth, whose git-ignored files a cleanup removes without asking. `[]` asks for any ignored file. |
| `git.mainCheckout.guard` | `true` blocks agent edits to tracked files in the main checkout, so task work happens in worktrees, and turns on the [commit guard](hooks.md#commit-guard) and its main-checkout [start lines](hooks.md#start-lines). Off by default. |
| `git.mainCheckout.allowWrites` | Tracked paths agents may still edit in the main checkout, as globs with `*` and `**`. Ignored paths are always allowed. |
| `git.commits.types` | The Conventional Commits types a commit subject may use; at least one. |
| `state.dir` | The machine-local [state folder](project-folder.md#local-state); `null` is the one under `$XDG_STATE_HOME`. |
| `github.requiredSections` | The `## ` sections every pull request body must have ([Bash rules](hooks.md#bash-rules)); `[]` checks none. |
| `github.reviewer` | The login of the Codex review bot that `aidrian pr await-review` waits for. `null` or `"none"`: no bot ([below](#no-review-bot)). |
| `github.maxReviewRounds` | The review rounds a pull request may get, 3 by default: the review loop and `aidrian pr await-review --request` stop there, unless `extraRounds` grants one more. They read it from the pull request's base branch, so an edit to the working copy does not raise it; `aidrian pr await-review` without `--request` posts nothing and reads no base branch. A `--max-rounds` above it runs only with `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`, which the Human sets, and so does a higher cap an earlier bot request recorded in its comment; a Bash rule refuses an agent command that sets it, and any bot request made outside `aidrian pr`. |
| `github.extraRounds` | What happens at that cap: [Extra rounds](review.md#extra-rounds). `"ask"`, the default: a read-only judge decides whether one more round is worth it, with any red flag of the round history (not converging, looping, drifting, bloating) as evidence, and the Human approves it. `"auto"`: the judge's word grants it, unless a red flag stands, when the Human approves it too. `"off"`: the cap stops, as `round_limit`. Read from the base branch, like the cap. |
| `github.maxExtraRounds` | The most extra rounds `extraRounds` may grant one pull request, 2 by default; a hard ceiling, read from the base branch. `0` grants none. |
| `github.requiredChecks` | Parts of check names that must be present and pass before `aidrian pr checks` says ready. [Auto-merge](#auto-merge) stays off until the default branch names one. |
| `github.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `github.conditionalChecks` | Parts of check names whose `SKIPPED` or `NEUTRAL` result is routine, such as a job a path filter turns off. |
| `github.markReady` | Who marks a draft pull request ready. `"auto"`, the default: the `pr-review-loop` skill, or `autopilot` and the `orchestrator` when they run it, mark it ready once a review of the current head signs off with no blocked row and `aidrian pr checks` says ready. `"ask"`: its author, or the review loop when the Human asks in the session. Either way, nothing is pushed after it is marked ready. Marking it ready merges nothing: only the Human's request or [auto-merge](#auto-merge) does. The default was `"ask"` before; [Changed defaults](#changed-defaults) has the opt-out. |
| `github.reviewLoop` | What follows the `pr-write` skill once it opens or updates a pull request. `"auto"`, the default: once `pr-write`, and any skill that ran it, has ended, the session starts the `pr-review-loop` skill on it right away, without asking. `"ask"`: the session offers the loop and runs it when the Human asks. Run inside a skill or agent that runs its own review loop, such as `autopilot` or the `orchestrator`, `pr-write` leaves the loop to it. |
| `github.titleIssuePrefix` | `true` writes pull request titles as `[<issue key>] type(scope): subject`, or `[NOISSUE] type: subject`; `false`, the default, writes a plain Conventional Commits title. |
| `github.pullRequest` | The project's [pull request contract](#pull-request-contract), beyond the required sections; off by default but for `sharedTempBodyFile`. |
| `github.reviewGate.enabled` | `true` asks the review bot only once a review of the diff is on record: [Review gate](#review-gate). |
| `github.reviewGate.checklist` | A file the reviewer reads the diff against, named in the gate's message; `null` names none. |
| `github.autoMerge.allow` | `true` lets a machine opt in to [auto-merge](#auto-merge); `false`, the default, keeps it off. It counts only when the repository's default branch and the pull request's base both allow it, read from GitHub, so a branch cannot raise it. Read at the base branch, with `decide-reversible`, it also stops a yes on `reachesUsersUnreviewed` from asking: [rule 3 under Decisions](#decisions). |
| `github.autoMerge.default` | What a machine with no local setting does under `allow`: `"off"`, the default, stays out until it opts in; `"on"` takes part until it opts out. Read from the default branch. |
| `github.autoMerge.strategy` | How auto-merge merges: `"squash"`, `"merge"`, or `"rebase"`. `null`, the default: the one strategy the repository allows, or with several, `squash`, then `merge`, then `rebase`. Read from the default branch. |
| `github.autoMerge.deleteBranch` | `true` deletes the remote head branch with the merge. Read from the default branch. |
| `github.autoMerge.deleteWorktree` | `true` removes the head branch's worktree after the merge, but never a session's own: [Cleanup](#cleanup-after-the-merge). Read from the default branch. |
| `github.autoMerge` in `.aidrian.local.json` | This machine's choice, the same key with one field: `{ "enabled": true }` opts in under the team's `allow`, and `{ "enabled": false }` stays out. Unset follows `github.autoMerge.default`. The older `"on"` and `"off"` still work. |
| `review.engine` | The project's [review engine](review.md#the-engine); it wins over the machine's. `null` leaves the choice to each machine. |
| `review.record` | Where the [review record](review.md#the-record) goes: `"comment"` also writes a summary comment on the pull request; `"local"` keeps it in the state folder only. |
| `terms.file` | The [terms file](#terms) of banned terms and their replacements, relative to the project root; `null` turns the rule off. |
| `docs.wrapLimit` | The longest line, in characters, allowed in a Markdown file an agent writes; `0` turns the check off. |
| `knowledge.budgets.alwaysBytes` | The bytes all `always` knowledge docs may add up to: [Knowledge budgets](#knowledge-budgets). |
| `knowledge.budgets.taggedDocBytes` | The bytes one tagged knowledge doc may have: [Knowledge budgets](#knowledge-budgets). |
| `skills.descriptionChars` | The longest skill or agent description, in characters (`aidrian lint skills` and `agents`). |
| `skills.listingBytes` | The most bytes all skill names and descriptions may add up to (`aidrian lint skills`). |
| `session.handoff.mode` | What the [session-length reminder](handoff.md#the-reminder) and the plan handoff offer do: `"ask"`, `"auto"`, or `"off"`. |
| `session.handoff.costRatio` | How many times a fresh session's cost each call must cost before the reminder fires, a number of 1.1 or more; each later reminder adds `costRatio − 1`: [Handoff](handoff.md). |
| `session.handoff.maxTokens` | An optional ceiling on the main session's context, in tokens, that fires the reminder on its own and doubles after each firing; `0`, the default, is off. |
| `lessons.auto` | `false` turns off the [automatic lessons](lessons.md#automatic-lessons) the hooks and `aidrian pr await-review` record. |
| `lessons.maxOpen` | The open [lessons](lessons.md) past which the session-start line asks for triage; `0` turns this limit off. |
| `lessons.maxAgeDays` | The age, in days, of the oldest open lesson past which the session-start line asks for triage; `0` turns this limit off. |
| `models` | The model and effort of the plugin's agents, per host, in place of the ones the plugin ships: [Models](#models). |
| `names.human` | What agents call the person they work for: [Names](#names). |
| `names.ai` | What agents call themselves; `null` is the host's name, Claude or Codex: [Names](#names). |
| `requires.aidrian` | The oldest plugin version the project's config needs, such as `"0.17.0"`; `null` asks for none: [Plugin version](#plugin-version). |
| `attribution.commit` | The trailers an agent's commit must carry: [Attribution](#attribution). `[]`, the default, is off. |
| `attribution.pullRequest` | The lines a pull request body an agent opens must end with: [Attribution](#attribution). `[]` is off. |
| `attribution.exclude` | The agents the `Assisted-by:` lines leave out; by default the ones that only search and read. |
| `telemetry.enabled` | `false` stops the hooks and `aidrian decisions` from writing the [dispatch log](dispatch-log.md): [Telemetry](#telemetry). |
| `telemetry.docReads` | `false` leaves out which knowledge docs each agent read. |
| `telemetry.hookDenies` | `false` leaves out the `hook_deny` row each block by one of the plugin's rules writes; the rules still block. |
| `telemetry.maxMb` | The size, in megabytes, at which the dispatch log moves to its rotated part. |
| `telemetry.health` | The thresholds of `aidrian report health`: [Health thresholds](#health-thresholds). |
| `agents` | The tools each agent may use in this project; `{}` gates none: [Agents](#agents). |
| `quorum` | The roles, providers, judge, and caps of the `quorum` skill: [Quorum](#quorum). |
| `decisions.mode` | Who settles a decision no other rule covers: `"ask"`, the default, the Human; `"decide-reversible"`, the agent, when every reversibility answer is no, or a yes the team accepted: [Decisions](#decisions). |
| `decisions.maxMode` | The highest mode any setting can reach, the local file's included. `"ask"`, the default, keeps every decision with the Human, until the team commits `"decide-reversible"`. Committed as `"decide-reversible"`, with `github.autoMerge.allow` true at the base branch, it lets a yes on `reachesUsersUnreviewed` stop asking: [rule 3 under Decisions](#decisions). |
| `decisions.domains` | `mode` for one domain, `product`, `ux`, `architecture`, or `backlog`; `"inherit"`, the default, takes `decisions.mode`. |
| `decisions.classes` | The project's own decision classes, each name to a one-line definition, added to the built-in list: [Project classes](#project-classes). Team only. |
| `decisions.escalate` | Ordinary decision classes, built-in or the project's, that always go to the Human in this project. |
| `decisions.escalateDocs` | Docs and folders, from the project root, whose decisions always go to the Human: `docs/pricing.md`, `docs/legal/` for everything in it, or `docs/terms.md#refunds` for one section. No glob characters, absolute paths, or `..`. |
| `decisions.unattended.safeDefaults` | What an unattended `autopilot` run may settle with a safe default: `"outside-escalated"`, the default, or `"all"`: [Unattended runs](#unattended-runs). Team only. |
| `decisions.secondLook` | The agent that must agree with a decision at or above `minSeverity`; `null` turns it off. |
| `decisions.record.queue` | Where the decisions an agent made alone are listed: `"pr-body"`, the default, in the pull request body and the dispatcher's report; `"report"`, in the report alone. Read at the base branch. [Recording decisions](#recording-decisions). |
| `decisions.unreviewed.remind` | When the Human is reminded of unreviewed decisions: `"session-start"`, the default, or `"off"`. |
| `decisions.unreviewed.pauseDomainAt` | The unreviewed `pending` count and `oldestDays` age at which a domain goes back to asking; `null` never pauses. |
| `audits.triage.issueCreation` | Whether the persona-audit triage asks before it creates an issue: `"confirm"`, the default, or `"auto"`: [Audit triage](#audit-triage). |
| `audits.triage.labels` | The labels every issue from the persona-audit triage gets: [Audit triage](#audit-triage). |

A path in `state.dir` or `git.worktrees.dir` may start with `~`, the home folder, or be relative to the repository root.
The other local state has fixed places in the state folder; [project-folder.md](project-folder.md#local-state) lists them.

Once `github.conditionalChecks` has an entry, `aidrian pr checks` fails on any other skip; `[]` lets every skip pass, named in the output.

### Changed defaults

A changed default raises no `aidrian check` line: a project that never set the key gets the new value silently.

- `github.markReady` became `"auto"`, from `"ask"`. To keep the author marking drafts ready, set `"github": { "markReady": "ask" }`.
- `github.reviewLoop` is new, `"auto"`. To have the review loop offered instead of started, set `"github": { "reviewLoop": "ask" }`.
- `decisions.unattended.safeDefaults` is new, `"outside-escalated"`. An unattended `autopilot` run now parks a floor class,
  where it used to take a safe default that could be undone, and a base commit with no config it can read parks every decision.
  To park only what the project listed, set `"decisions": { "unattended": { "safeDefaults": "all" } }`.

### No review bot

A project without the Codex review bot sets `"github": { "reviewer": null }`, or `"none"`.

- `aidrian pr await-review` then ends at once with exit 0 and `"status": "no_reviewer"`.
  It runs no `gh`, posts no review request, and waits for nothing. `--reviewer none` does the same for one run.
- `aidrian report reviews` and the Reviews line of `aidrian report health` say that no review bot is set.
- The `orchestration` and `autopilot` skills then run the `pr-review` skill in every review round.

## Auto-merge

Auto-merge lets a session merge a pull request without asking. It is off unless the team allows it and the machine takes part.
`github.autoMerge.allow`, read at the base branch, also stops a yes on `reachesUsersUnreviewed` from asking under `decide-reversible`:
[rule 3 under Decisions](#decisions).

The team commits this in config.json, on the default branch and on any other branch pull requests target:

```json
{
  "version": 1,
  "github": {
    "requiredChecks": ["test"],
    "autoMerge": { "allow": true, "strategy": "squash", "deleteBranch": true, "deleteWorktree": true }
  }
}
```

`requiredChecks` is not optional here: without it on the default branch, auto-merge stays off.

Each machine opts in with this in `.aidrian.local.json`:

```json
{ "github": { "autoMerge": { "enabled": true } } }
```

`enabled` is the only field, and `autoMerge` the only `github` key, that file takes. A machine never goes past `allow`,
and `strategy` and the cleanup stay the team's. The older `"on"` and `"off"` still work.

| Team | No local setting | `enabled: true` | `enabled: false` |
| --- | --- | --- | --- |
| `allow: false` | Off | Off | Off |
| `allow: true`, `default: "off"` | Off | On | Off |
| `allow: true`, `default: "on"` | On | On | Off |

With `default: "on"`, every machine with no local setting merges without having chosen to, so a team sets it knowingly.
A local file with an error, or one git tracks, counts as `enabled: false`.
`aidrian check` warns when the machine opts in and the team does not allow it.
It fails when git tracks the file, in any case, and the switch then reads `"off"`: [Setting up](project-folder.md#setting-up-and-checking).
The switch counts only in the main checkout's file: a task worktree's own copy never turns it on or off, though its other keys apply as usual.
A subagent may not write `autoMerge` into that file: [the config guard](hooks.md#agent-gates).

A project that adopts `github.autoMerge` sets [`requires.aidrian`](#plugin-version) to the release that ships it,
since an older plugin rejects the key.

### When it is on

`aidrian pr auto-merge [PR] [--json]` reports it for one pull request: a number, `#number`, or URL, or by default the
current branch's. It exits 0 when on, 1 when off, and 3 on an error, such as a bad argument or a failed gh read.

It is on only when all seven of these hold, checked in this order.
With `--json`, `reason` names the first that fails and `why` says it in a sentence; both are `null` when on.

| `reason` | What must hold |
| --- | --- |
| `team` | `github.autoMerge.allow` is true on both the repository's default branch and the pull request's base. Both are read from GitHub as each branch commits them now, never from the checkout. So a branch cannot raise it, and the pull request that turns it on does not merge itself. |
| `checks` | The default branch names `github.requiredChecks`: a named check that has not reported is pending, so a draft's partial set of checks cannot read as ready. This checkout's `requiredChecks`, `conditionalChecks`, and `ignoreCancelledChecks` equal the default branch's as sets, committed or not: `aidrian pr checks` reads this checkout, so a branch cannot relax the lists, and a branch that changes workflows stays off (`paths`). This checkout's `state.dir` equals the default branch's, since the review record is read from it. A working-copy config that cannot be read, or has errors, is off too. |
| `paths` | gh lists every changed file (`files` matches `changedFiles`) with its `changeType`, none is `RENAMED`, since gh does not give the old path, and none is on this fixed list, in any case: `AGENTS.md`, `CLAUDE.md`, `SKILL.md`, `CODEOWNERS`, `.aidrian.json`, and `.aidrian.local.json` at any depth, and `.claude`, `.codex`, `.aidrian`, `.github/workflows`, or `.github/actions` at the repository root or the project root, or anything under them. These instruct AI sessions or decide CI, and a review of the change may not read them as behavior. The plugin's own code that decides auto-merge is on the list too, so the gate never approves a change to itself: under `plugins/aidrian/`, `bin/`, `lib/cli.mjs`, `pr.mjs`, `pr-auto-merge.mjs`, `pr-checks.mjs`, `project.mjs`, `config.mjs`, `fs.mjs`, `git.mjs`, `gh.mjs`, `review-gate.mjs`, and `shell-lex.mjs`, `lib/rules/`, `lib/review/`, `scripts/hook-*`, and `hooks/`. For a project below the repository root, the setting is read from its own folder, and no file may be outside that folder, since [its review does not cover those](review.md#paths). |
| `local` | This machine's setting is on, or it has none and the default branch's `github.autoMerge.default` is `"on"`. |
| `author` | The pull request's author is the gh user. |
| `outsider` | Every issue comment, review, and inline comment on the pull request has the author association `OWNER`, `MEMBER`, or `COLLABORATOR`, or is by the default branch's `github.reviewer` bot. Any other bot, such as a CI or preview bot that comments, counts as an outsider. |
| `review` | Nobody's latest review requests changes, and the review decision is not changes requested. This machine's [review record](review.md#the-record) holds a `received` review of exactly the current head, and nothing is owed. There is no looser mode: no record, a review of an earlier head, or an owed review keeps it off. A pull request that needed no review, `none_needed`, such as plain docs, waits for the Human. |

`strategy`, `deleteBranch`, `deleteWorktree`, and the check lists come from the default branch only. The base counts only for `allow`.
So a checkout whose lists differ from the default branch's does not auto-merge, including one behind them until it catches up.

### What a run does

The `pr-review-loop`, `orchestration`, and `autopilot` skills run the `pr-auto-merge` skill, only after that same run marked the draft ready.
`pr-auto-merge` stops unless this run marked the pull request ready and the command exits 0,
and otherwise reads `pr-merge-when-green` and follows its steps as an unattended run.
The first condition is a step of the skill, not a check the command makes.
The model cannot start `pr-merge-when-green` itself: the skill merges only on the Human's request in the session, or in that run.
An unattended run waits for every check, runs the command again right before the merge, and stops unless it still
exits 0 on the same head and base.
The merge goes through the [merge guard](hooks.md#merge-guard), and never uses `--auto` or `--admin`.

When the Human asks for the merge, the command need not exit 0.
The command's `strategy`, `deleteBranch`, and `deleteWorktree` only fill the choices the Human left out.

### Limits

- Name every check that matters in `requiredChecks`. An unnamed check that starts only once a pull request is ready is not waited for.
- A required check that runs only on ready pull requests keeps the caller's ready step from passing, so auto-merge will not fire for it.
- `deleteBranch` conflicts with a merge queue.
- The `paths` list is fixed: it misses a project folder that `.aidrian.json` moves elsewhere.
  It also misses other files that instruct a session,
  such as a knowledge doc under `docs/`, a doc `CLAUDE.md` imports, a nested `.claude` folder, or `CLAUDE.local.md`.
  In a pull request that also changes code, only the review reads those.
- A branch can still change what a workflow runs, such as `package.json` scripts or tests, and only the review reads that.
- The `outsider` check reads only the pull request's comments and reviews, so text reaching a run by other routes, such as an issue, is not seen.
- `MEMBER` covers every organization member, so a read-only member or an invited collaborator can still forge a record.
- The switch does not stop a session with a shell or a forged local record.
  For proof, protect the branch with a required review from a second account, as [Sign-off by the Human](review.md#sign-off-by-the-human) says.
- The config guard does not apply an `apply_patch`, so it does not see a value changed on its own line with the key on an unchanged context line,
  or a key spelled with a JSON escape. It also does not follow a patch's `*** Move to:` and `*** Delete File:` routes.

### Cleanup after the merge

`deleteWorktree` removes the head branch's worktree without asking only when the cleanup can prove the work merged.
It runs nothing for a fork's pull request, since a local branch of that name is not the fork's, or for a worktree whose
HEAD is not the merged head.
A session's own worktree is never removed, and a session usually works in the pull request's worktree.
That run reports the worktree kept: run the `worktree-cleanup` skill from the main checkout.

`deleteBranch` means the remote branch; removing the worktree takes the local one with it.
It does not reach a fork: gh never deletes a head branch in another repository.

## Pull request contract

The pull request body rule ([hooks.md](hooks.md#bash-rules)) reads every `gh pr create` and `gh pr edit`.
`github.requiredSections` says which sections a body must have; `github.pullRequest` adds what else it holds to:

| Key | The rule refuses |
| --- | --- |
| `title` | A `--title` that does not match this regular expression. `{types}` stands for `git.commits.types`, `{issueKey}` for `issueKey`. |
| `issueKey` | One issue key, as a regular expression, such as `"ABC-\\d+"`. With `title` set, a title with a key outside its leading `[...]`. |
| `sections` | A `## ` heading not on this closed list. Headings inside code fences are quotes and do not count. |
| `deferrals` | An item of the `section` list that names no `field:` reason from `reasons`, names one of `neverValid`, or, with `issueKey`, no issue. |
| `residuals` | An item of the `section` list that lacks one of `fields`, written `field:`, or that names an issue. |
| `sharedTempBodyFile` | `--body-file` in `/tmp`, `/var/tmp`, `/var/folders`, or `$TMPDIR`, such as the host's scratchpad, unless inside the project or its state folder: concurrent sessions overwrite those. |
| `duplicateBody` | A body identical to another open pull request's. This check runs `gh pr list`, and lets the command run when gh does not answer in 3 s. |

A title is checked only when the command sets one, so a body-only `gh pr edit` never blocks on a title written before the rule.
The items of a section are its list items; prose under the heading, and a bullet indented under an item, are not items.
The first `field:` on an item's own line is its reason, and the reason's first word decides it, so prose may follow it.
In `neverValid`, a `<word>` stands for any one word, so `needs <specialist> oversight` also matches `needs backend-developer oversight`.

```json
{
  "github": {
    "requiredSections": ["Summary"],
    "pullRequest": {
      "title": "^\\[(?:{issueKey}|NOISSUE)\\] (?:{types})(?:\\([a-z0-9./_-]+\\))?!?: \\S.*",
      "issueKey": "ABC-\\d+",
      "sections": ["Summary", "Risk", "Tests run", "Deferred to issues"],
      "deferrals": { "section": "Deferred to issues", "field": "defer_reason", "reasons": ["human_only", "user_chose"], "neverValid": ["out of scope"] }
    }
  }
}
```

## Review plan

`review` decides how `aidrian pr review` reviews a pull request: its depth, its stages, the critical flows it holds
to their invariants, the reviewers a project adds, and the [visual capture](review.md#visual-review).
[review.md](review.md) describes every key. Two machine settings live in `.aidrian.local.json`: the engine,
`review.engine`, unless the project sets it here, and the visual capture's base URL, `review.visual.baseUrl`.

## Review gate

With `aidrian pr review`, an enabled gate is one more required reviewer: the code-reviewer agent runs in the local
stage before any model or bot. The rest of this section is about asking the bot directly.

With `"github": { "reviewGate": { "enabled": true } }`, the review bot is asked to review a pull request only once one
review of its diff, by an agent that did not write it, is on record. The record is written once per pull request:

```sh
aidrian pr attest <PR> --head <sha> --reviewer <who> --findings <n> --fixed <n> [--note <text>] [--repo <owner/name>]
aidrian pr attest <PR> --check     # exit 0 recorded, 3 not
```

Inside `aidrian pr review`, the full-diff agent pass it dispatches, recorded with
`aidrian pr attest <PR> --pass agent:<name> --head <sha> ...`, is that record too, so the bot request needs no second
attest; so is an agent pass its flows merged into, `agent:<name>:<flows>`, when it read the whole diff. A pass over a
flow's or a slice's files alone, the cross pass, and an engine pass do not count.

`attest` writes the record to the [state folder](project-folder.md#local-state), which every worktree shares, and prints a marker:
`<!-- aidrian-review: pr=<n> repo=<owner/name> head=<sha> ... -->`. A request that carries the marker for its own pull request
and repository also passes, so a new session or machine need not review again.
`attest` files the review under the pull request's repository: `--repo`, else the one `gh pr view` names, gh's default
(the upstream in a fork checkout), else origin, so it works offline.

- `aidrian pr await-review --request` checks the gate before it posts. It ends with `review_required`, exit 5, and posts
  nothing, or puts the marker in its request.
- The Bash rule refuses `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose
  body asks `@codex review` outside code and quotes, and `gh pr create --reviewer` or `gh pr edit --add-reviewer` naming `github.reviewer`.
- A hook on the GitHub MCP comment tools refuses the same body.
- A request to another repository passes. A request whose pull request number the rule cannot read is refused: name it.
- `AIDRIAN_ALLOW_UNREVIEWED_REQUEST=1`, set by a person in their own shell, lets the request run and records an override
  for the pull request.

`checklist` names a file the reviewer reads the diff against; the gate's message names it.

Whether the gate is on or off, a review the Human asked for is recorded with `aidrian pr request <PR>` the moment they
ask, and a gate review being dispatched with `aidrian pr request <PR> --kind review`
([owed reviews](review.md#the-record)). The [merge guard](hooks.md#merge-guard) refuses a merge while either is owed.

## Terms

`"terms": { "file": ".aidrian/terms.json" }` turns on the terms rule: a project's vocabulary, as banned terms each with
its replacement. The file is JSON of its own, so a project can list hundreds of terms without growing `config.json`:

```json
{
  "version": 1,
  "locales": "locales/{locale}/*.json",
  "rules": [
    { "id": "clients", "severity": "warn", "exclude": ["locales/**", "src/**"], "terms": { "guest": "client", "guests": "clients" } },
    { "id": "es guests", "locale": "es*", "terms": { "comensal": "cliente", "comensales": "clientes" } },
    { "id": "shared docs", "paths": ["docs/**/*.md"], "prose": true, "terms": { "you": "the agent" } },
    { "id": "guest count", "paths": ["src/**/*.ts"], "code": true, "severity": "warn", "terms": { "party size": "guestCount" } }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `version` | `1`. |
| `locales` | Where translation files are, as a glob with `{locale}`. Needed by a rule with `locale`. |
| `rules[].id` | A unique name, shown with every hit. |
| `rules[].paths` | The files the rule reads, as globs relative to the project root, with `*` and `**`. Without it, and without `locale`, the rule reads every file. |
| `rules[].locale` | A translation locale, put in place of `{locale}` in `locales`; it may hold `*`, so `"es*"` reads `es`, `es-ES`, and `es-419`. It reads only a JSON file's string values, never its keys. |
| `rules[].exclude` | Globs of files the rule skips, such as a vendor's contract or marketing copy where a term is meant. |
| `rules[].severity` | `"block"`, the default, or `"warn"`. |
| `rules[].message` | Shown with every hit. |
| `rules[].prose` | `true`: read only a Markdown file's own prose (see below). |
| `rules[].compounds` | `true`: a `prose` rule also matches a term inside a hyphen compound. Needs `prose`. |
| `rules[].code` | `true`: match code names, whole, in any case style (see below). Needs `paths`. |
| `rules[].terms` | Each banned term and what to write instead. |

A term matches as a whole word, in any case, after Unicode normalization: `comensal` does not match `comensales`.
List each word form a rule bans (`guest`, `guests`, `guest's`); synonyms are more entries. A `*` stands for more letters
of the same word, so `usuári*` matches `usuárias`; use it only when every continuation is wrong, since `guest*` also
matches `guestbook`. A term in a script written without spaces, such as Japanese or Chinese, matches anywhere.

A rule with neither `paths` nor `locale` holds everywhere: every text file git tracks, and on agent writes every file
git does not ignore. Binaries, lockfiles, and `*.min.*` files are never read, and no rule reads the terms file itself.
Such a rule reads whole lines, JSON keys included, so translations belong to `locale` rules and code names to `code`
rules; `exclude` takes out the rest.

A `prose` rule reads what a Markdown file says in its own voice. It skips fenced code, blockquotes, lines with
`<!-- lint-skip -->`, and, within a line, inline code, URLs, and "quoted" or “quoted” spans. A word joined by `-` is part
of a compound, so `you` does not match `show-your-work`. A rule with `"compounds": true` matches inside a compound too,
as a rule banning a name must catch `acme-approved`; the term is still a whole word, so `acme` never matches `acmeish`.
On an agent write it reads the lines whose prose is new: a line moved out of a code block counts, a reordered line does
not. When the hook cannot see the whole file, as with Codex's `apply_patch`, a `prose` hit only warns.

A `code` rule matches identifiers whole: `party size` is `partySize`, `PartySize`, `party_size`, `PARTY_SIZE`, and
`party-size`, never `minimumPartySize`. Strings and `//` or `/* */` comments are skipped. It reads text, not a syntax
tree, so a read such as `booking.partySize` also matches, code inside a template literal's `${}` and after a quote in a
regular expression can be missed, and JSX text reads as code; start such a rule at `warn`. It runs on agent writes
only: the project's own linter is the gate for code names at commit and in CI, and can read the same file.

Where it runs:

- The file-write hook checks the lines an Edit, Write, or `apply_patch` adds: a `block` hit refuses the write, and a `warn`
  hit lets it run and tells the agent. A line the file already had is never reported, so old text does not block new work.
- `aidrian lint terms` checks every tracked file, and `--staged` the staged files as the index holds them: a `block` hit fails,
  a `warn` hit is printed. `--rule <id>` runs one rule. A project runs `aidrian lint terms --staged` from its own git hook,
  as it runs [commit-msg](hooks.md#commit-messages).
- `aidrian check` names every problem in the file; a bad rule is left out, and the others still apply.

To add a rule, start it at `"severity": "warn"`, run `aidrian lint terms --rule <id>`, and fix or `exclude` each hit.
Then drop `severity`, so it blocks. A vocabulary rule that reads every file can match thousands of lines in a large
project; this order finds them before they stop anyone's work.

## Models

Each agent file in the plugin sets the model and effort the agent ships with, from the plugin's [provider files](agent-sources.md#provider-files).
A team can choose others in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{
  "models": {
    "claude": { "agents": { "planning-agent": { "model": "opus", "effort": "high" } } },
    "codex": { "agents": { "planning-agent": { "model": "gpt-5.5", "effort": "medium" } } }
  }
}
```

`.aidrian.local.json` wins over `config.json`, and `config.json` wins over the agent file, one value at a time:
set `model`, `effort`, or both, and the other keeps the value from below.
`aidrian check` names an unknown host, agent, or key, and a value the host does not take.

| Host | `model` | `effort` |
| --- | --- | --- |
| `claude` | `sonnet`, `opus`, `haiku`, or `fable` | `low`, `medium`, `high`, `xhigh`, or `max` |
| `codex` | a Codex model name, such as `gpt-5.5` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, or `persistent` |

How each host applies the choice, and its limits: [Claude Code](providers/claude-code.md#models-and-effort),
[Codex](providers/codex.md#models-and-effort).

Neither host lets a project change the model or effort of a plugin skill, so `models` has no `skills` key, and `aidrian check` refuses one.
Claude Code reads a skill's `model` and `effort` only from its own `SKILL.md`, and Codex skills have neither.
The plugin's skills set neither, so they run on the session's model and effort.

## Names

Agent output that says "you" or "me" leaves the reader unsure who is meant.
The start hook gives every session and subagent one line with both names, and the `knowledge` skill tells agents to use them
in replies, docs, handoffs, commits, and pull request bodies:

```text
Names: call the human "the Human" and yourself "Claude", in replies and questions alike; never "I", "me", "my", "you", or "your".
```

A team sets its names in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{ "names": { "human": "the product owner", "ai": "the agent" } }
```

A question dialog often shows without the reply around it, so a hook blocks an `AskUserQuestion` call whose question or
options say "I", "me", "my", "you", or "your", or a form of them such as "I'm" or "yourself",
outside backticks and quotes, and the agent asks again with the names (Claude Code).

A chat reply is read before any check could run, so it is not blocked. When the main session's last reply said one of
those words outside code, quotes, and quoted lines (`> …`), the next turn starts with one line that names
the words and both names (Claude Code).

`.aidrian.local.json` wins over `config.json`, one name at a time.
`aidrian check` names an unknown key and a name that is not a non-empty string.

## Plugin version

A config that uses a newer key fails on an older plugin, and a session can load an older install than the one the
project was set up with, such as a resumed session from another checkout. `requires.aidrian` names the oldest plugin
the project needs:

```json
{ "requires": { "aidrian": "0.17.0" } }
```

When the running plugin is older, `aidrian check` fails and the session-start hook adds a line, both naming the
version and the folder of the copy that runs, so the stale install shows at the first prompt. A plugin older than
0.17.0 does not know the key and rejects it as unknown, which fails as loudly with a less specific message.

A project that adopts the `session.handoff` group (`mode`, `costRatio`, `maxTokens`) sets `requires.aidrian` to the
release that ships it: an older plugin reads only a string `session.handoff` and rejects the group.
[handoff.md](handoff.md#config) lists the old keys and where each went.
A project that adopts [`github.autoMerge`](#auto-merge) does the same, since an older plugin rejects the key.

## Attribution

`attribution` says which agents wrote a commit or a pull request. The values come from the hook payload, the session
transcript, the environment, git, and the [dispatch log](dispatch-log.md), never from what an agent writes about itself.
The attribution rule ([hooks.md](hooks.md#bash-rules)) blocks an agent's `git commit` or `gh pr create` that lacks them
and prints the exact lines to add. Both lists are empty by default, which turns the rule off.

| Field | Value | Read from | Commit trailer |
| --- | --- | --- | --- |
| `agent` | `backend-developer`, or `main` | The subagent making the call, else the session's `--agent`; without the `aidrian:` prefix | `Agent:` |
| `model` | `claude-opus-5-5` | The agent's last API request in its own transcript | `Agent-Model:` |
| `effort` | `high` | That request, else `CLAUDE_EFFORT` in the main session only: a subagent inherits it | `Agent-Effort:` |
| `tool` | `Claude Code` or `Codex` | `CODEX_THREAD_ID` | `Agent-Tool:` |
| `env` | `local`, `cloud`, or `ci` | `CLAUDE_CODE_REMOTE=true` is `cloud`; `GITHUB_ACTIONS` or `CI` is `ci` | `Agent-Env:` |

`commit` takes any of these fields. A commit carries a trailer as a `--trailer` option, or in its message's trailer
block: the last paragraph, past the subject, with only `Key: value` lines, as git reads it.
Each `git commit` in a command is checked on its own message, and a `-F` file is read where the commit runs.
A message from stdin (`-F -`), an editor, or another commit (`-C`, `-c`) counts only its `--trailer` options. `-h`, `--help`, `--dry-run`, and the status formats, such as `--short`, pass.
The rule also reads `sh -c` and `bash -c` command lines and a script fed to a shell, such as `bash <<'EOF'`.
The trailers are those `git interpret-trailers` reads in the commit's folder, with its `git -c` settings.

`pullRequest` takes `tool`, `model`, `effort`, and `env` for one line, and `agents` for one line per agent:

```text
Authored-with: Claude Code — claude-opus-5-5 (high effort, local)
Assisted-by: backend-developer (claude-sonnet-5-5)
Assisted-by: code-reviewer (claude-opus-5-5)
```

- The agents are those in the `Agent:` trailers of the commits on the pull request's head (`--head`, else the current branch)
  past its base (`--base`, else `git.defaultBranch`), from any session,
  and those this session dispatched, with the models their `stop` rows name; `main` and `exclude` are left out.
- The `Authored-with:` line must match as written. Each agent needs an `Assisted-by:` line, in any order, whatever models it names.
- Only `gh pr create`, and its alias `gh pr new`, is checked; `gh pr edit`, `--web`, and `--dry-run` pass. A body the rule cannot read, such as `--body "$VAR"`, is refused.
- A field with no known value is left out, never guessed.
- The commit names only the agent that runs `git commit`. When the main session commits a subagent's work,
  the subagent shows in the pull request's `Assisted-by:` lines, not as a co-author.
- On Codex, `tool` and `env` are known, and `agent` when Codex sends it. `model`, `effort`, and the dispatched agents
  are not: the transcript reader and the dispatch log read Claude Code's formats. Codex never reports `cloud`.

The rule catches an agent that forgot or mistyped its attribution in an ordinary command. It is not a security
boundary: a command built to hide its message from a static reader is out of scope, and where the rule cannot read a
message it asks for `--trailer` options.

To skip the rule, the Human sets `AIDRIAN_ALLOW_UNATTRIBUTED=1` before starting the session.
The host adds its own attribution, such as Claude Code's `Co-Authored-By:` trailer and session link.
Claude Code's `attribution` setting in `.claude/settings.json` turns those off.

```json
{ "attribution": { "commit": ["agent", "model", "effort"], "pullRequest": ["tool", "model", "effort", "agents"] } }
```

## Telemetry

The hooks record what agents cost and read in the [dispatch log](dispatch-log.md), on this machine only; nothing goes over the network.
A team sets `telemetry` in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{ "telemetry": { "enabled": false } }
```

`.aidrian.local.json` wins over `config.json`, one key at a time.

- `enabled: false`: the hooks and `aidrian decisions` write no rows.
  The [delivery check](hooks.md#delivery-check) still sends a subagent back for a file it named and did not write,
  and the [background check](hooks.md#background-check) for a background task it left running.
- `docReads: false`: `stop` and `session` rows keep tokens and cost, and hold `docs_read: null` instead of the docs read.
- `maxMb`: once the log reaches this size, the next row moves it to `dispatch-log.1.jsonl`, replacing the file there.
  The two files hold about twice `maxMb` at most, and `aidrian report` reads both.
- `hookDenies: false`: the Bash rules, the main-checkout rule, the agent gates, and the config guard still block,
  and write no `hook_deny` row ([hooks.md](hooks.md#recorded-blocks)). A rule that keeps blocking one session still becomes a lesson.

The last three keys were `doc_reads`, `max_mb`, and `hook_denies`; a file that still sets one gets an error naming the new key.

`aidrian report` says when telemetry is off, and when the rows it read miss part of the window:
[dispatch-log.md](dispatch-log.md#when-the-report-is-incomplete).

### Health thresholds

[`aidrian report health`](dispatch-log.md#health) judges each signal against `telemetry.health`.
Set only the keys you change; a team sets them in `config.json`, and one developer in `.aidrian.local.json`, as above.

| Key | A problem when |
| --- | --- |
| `minSample` | Not a threshold: a signal with a smaller sample says "not enough data" and is never a problem. |
| `redispatchPercent` | More than this share of an agent type's dispatches repeat a task already dispatched in the same session. |
| `sentBackPercent` | More than this share of an agent type's runs were sent back by the [delivery check](hooks.md#delivery-check). |
| `topDocPercent` | One knowledge doc takes more than this share of all the bytes of knowledge docs read. |
| `reviewRounds` | The review bot takes more than this many rounds a pull request on average; 3 is the `autopilot` skill's cap. |
| `lateFindingPercent` | More than this share of the late findings checked sat on a line the bot had already reviewed. |
| `denyHotSpot` | One of the plugin's rules blocks this many calls or more in the window. |
| `costRisePercent` | A session in the newer half of the window's sessions costs more than this percent above one in the older half, on average. |
| `decisionOverridePercent` | The Human overrides this share or more of the decisions the Human reviewed: rejects them, undoes them, or changes their wording. |
| `decisionMinSample` | Not a threshold: the override rate says "not enough data" over fewer reviewed decisions than this. It stands in for `minSample` there. |

The `Percent` keys take a whole number from 1 to 100, except `costRisePercent`; the others, a whole number above 0.
The knowledge budget uses [`knowledge.budgets`](#knowledge-budgets), and the lesson backlog `lessons.maxOpen` and `lessons.maxAgeDays`.

## Knowledge budgets

Every session and subagent reads the `always` docs, and `aidrian-knowledge route <tag>` lists each doc of the tag to read whole.
`aidrian check` and `aidrian lint budget` hold both to a size:

- The `always` docs of all buckets together: a warning above `alwaysBytes`, 16 KB by default, and an error above twice that.
- Each doc with at least one tag: a warning above `taggedDocBytes`, 24 KB by default.
  Split such a doc into a short rule card and a reference, or drop its tags so that only search finds it.

The warnings print on stderr, and the check still passes. `aidrian check` prints the `always` total on its last line;
the warning below is one line, wrapped here:

```console
$ aidrian check
warning: docs/knowledge/engineering/sync-protocol.md: 41230 bytes, over knowledge.budgets.taggedDocBytes (24576); every route to
  backend reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it
ok: .aidrian (2 buckets, 8 docs)
state: /home/you/.local/state/aidrian/projects/notes-1a2b3c4d
budget: 2479 of 16384 always-doc bytes (engineering 2479, product 0)
```

The key `docs.alwaysBudgetBytes` moved here as `alwaysBytes`; a `config.json` that still sets it gets an error naming the new key.
[knowledge.md](knowledge.md#shaping-buckets) says how to shape buckets that stay within the budgets.
[`aidrian report docs`](dispatch-log.md#doc-reads) prints the same `always` total beside the docs agents read and the ones nobody read.

## Agents

`agents` limits the tools each agent may use in this project, and those of the main session.
A team sets it in `config.json`, and one developer in the git-ignored `.aidrian.local.json` at the project root:

```json
{
  "agents": {
    "*": { "deny": ["mcp__slack__*"] },
    "main": { "deny": ["Bash(git push)"] },
    "explorer": { "allow": ["Read", "Grep", "Glob", "Bash(git log)", "Bash(git show)"] }
  }
}
```

Each key names who its entry applies to:

| Key | Applies to |
| --- | --- |
| `*` | Every agent and the main session. |
| `main` | The main session, also one started with `claude --agent <name>`. |
| A short name, such as `explorer` | Every agent of that name: `aidrian:explorer`, another plugin's `explorer`, and a project's `explorer`. |
| A full name, such as `aidrian:explorer` | That plugin's agent only. |

Every entry that applies is checked, and a tool call runs only when each one lets it.
A session started with `claude --agent aidrian:explorer` is both `main` and `explorer`.

An entry has `deny`, `allow`, or both, each a list of tool patterns:

| Pattern | Matches |
| --- | --- |
| A tool name, such as `Read` or `WebFetch` | That tool. |
| A name ending in `*`, such as `mcp__github__*` | Every tool whose name starts with the text before the `*`; `*` alone matches every tool. |
| `Bash(<command prefix>)`, such as `Bash(git push)` | A Bash call that runs a command whose words start with the prefix. |

- `deny` wins: a call that matches a `deny` pattern is blocked, whatever `allow` says.
- An `allow` or `deny` that is not a list, or a `deny` with an invalid pattern, leaves the gates unknown: a subagent may then
  only read files until the file is fixed.
- With `allow` set, a call that matches none of its patterns is blocked; `"allow": []` blocks every tool.
- A Bash call passes an `allow` list through its `Bash(...)` patterns only when every command in it starts with an allowed prefix.
  `cd app && npm test` needs both `Bash(cd)` and `Bash(npm test)`.
- A command line is read as the [Bash rules](hooks.md#bash-rules) read it: each step of `&&`, `;`, and `|`, and each command substitution.
  It also reads past wrappers such as `sudo` and `env`, and past git's own options, so `Bash(git push)` also blocks `git -C app push`.
- The first word matches the program by its file name, so `Bash(git push)` also matches `/usr/bin/git push`.
- The command line of `sh -c` or `bash -c` is read too, so `Bash(git push)` blocks `bash -c 'git push'`; an `allow` list must also allow the shell.
  So is a heredoc or here-string fed to a shell (`bash <<'EOF'`), a function body, and a `case` arm.
- A gate matches the command text, so a command run by `xargs`, `find -exec`, `eval`, a script, an interpreter, or text piped
  into a shell (`echo 'git push' | bash`) is out of sight;
  an `allow` list blocks it unless it allows the outer command, and a `deny` list can name the outer command, such as `Bash(xargs)`.

`.aidrian.local.json` wins over `config.json` one list at a time.
Its `deny` for an agent replaces the team's `deny` for that agent, and its `allow` replaces the team's `allow`.
A developer can lift a team's `allow` list on one machine with `"allow": ["*"]`.
An agent cannot: while `agents` sets any gate, no subagent may change config.json, `.aidrian.json`, or `.aidrian.local.json`,
also the main checkout's when the project is a git worktree. The main session still can.
While one of those files is there but cannot be read, the gates are unknown, so every subagent may only read files until it is fixed.
`aidrian check` names an unknown key, a key that is not an agent name, and a pattern it cannot read, such as `Bash(git *)`.
A bad pattern is left out and the rest of its list still applies, so a bad `allow` pattern makes the list stricter.
`aidrian check` cannot know every agent's name, so a name that matches no agent is not an error: its entry never applies.
[hooks.md](hooks.md#agent-gates) describes the hook that enforces the gates, and what each host supports.

## Quorum

`quorum` sets who the `quorum` skill dispatches, and how far a plan run may go.
Set only the keys you change; the defaults are the roles and caps the skill names.

Three commands read the group, so the skill text never parses this file:

- `aidrian quorum check` reads `quorum.plan.maxObjections`: on an `open` plan ledger that carries `mode`, it exits 1
  when one adversary raised more objections than that. A `complete` ledger is held to the ceiling, 5, instead,
  so a cap lowered after a run finished never voids its ledger or the Human's answers.
- `aidrian quorum roles plan` and `aidrian quorum roles decide` read the whole group, `maxObjections` included,
  and print that mode's roles, judge, and caps as one JSON line, which the coordinator follows. The decide caps are `3N + 2 + C` for each position count N
  from 2 to 4, where C counts the first N positions whose runner is Codex: 9, 12, and 16 with the defaults.
  `aidrian quorum roles product` reads it too; a product run makes at most 10 dispatches, plus 6 per loop: 22 with the defaults.
- `aidrian quorum route` reads `quorum.product.autoStart`, `approval`, and `maxAutoRuns` from the base branch:
  [Automatic product quorums](#automatic-product-quorums).

All three stop on an invalid config.json, as every `aidrian` command does: they exit 1 naming each bad key, and never run
on defaults the project did not choose.

| Key | Default | Meaning and range |
| --- | --- | --- |
| `quorum.judge.agent` | `"architect"` | The agent that rules on every objection. The judge always runs as a host agent. |
| `quorum.plan.a.agent` | `"code-reviewer"` | Plan adversary A, always a host agent. |
| `quorum.plan.b.provider` | `"codex"` | Plan adversary B's runner: `"agent"` or `"codex"`. |
| `quorum.plan.b.agent` | `"product-manager"` | B's agent on `"agent"`, and its fallback on `"codex"`. |
| `quorum.plan.maxObjections` | `5` | The most objections each plan adversary may raise, a whole number from 1 to 5. |
| `quorum.plan.maxDispatches` | `8` | The most dispatches a plan run may make, one of them kept for the proportionality pass; a whole number, 5 or more. |
| `quorum.decide.odd.provider` | `"agent"` | The runner of decide positions A and C: `"agent"` or `"codex"`. |
| `quorum.decide.odd.agent` | `"code-reviewer"` | Their agent on `"agent"`, and their fallback on `"codex"`. |
| `quorum.decide.even.provider` | `"codex"` | The runner of decide positions B and D: `"agent"` or `"codex"`. |
| `quorum.decide.even.agent` | `"code-reviewer"` | Their agent on `"agent"`, and their fallback on `"codex"`. |
| `quorum.decide.swap` | `true` | Whether a claim with an odd hash swaps the runners of positions A and B. |
| `quorum.product.owner.agent` | `"product-manager"` | Interviews the end user, shapes options, and recommends one to the Human. `quorum.judge` does not apply to this mode. |
| `quorum.product.witness.agent` | `"ux-researcher"` | The agent that plays the end-user persona. It does not turn a persona on, or choose one: [who takes part](#who-plays-the-end-user). |
| `quorum.product.ux.agent` | `"ux-specialist"` | Grills the options for what a user would hit. |
| `quorum.product.engineer.agent` | `"architect"` | Grills the options for cost and risk. |
| `quorum.product.maxLoops` | `2` | How many times a product run may go back after a walkthrough, a whole number from 1 to 5. |
| `quorum.product.autoStart` | `false` | Whether a hard product call runs the quorum with no Human asking for it. A run the Human starts always asks; only a run the route started continues provisionally. |
| `quorum.product.approval` | `"first"` | `"first"`: the Human approves, and work on that decision waits. `"review-later"`: work continues on the recommendation, recorded as provisional and reviewed in a batch. |
| `quorum.product.maxAutoRuns` | `3` | The most automatic runs in one session, a whole number from 1 to 10. Beyond it, a hard call waits for the Human with no quorum. |

- One `agent` field covers both cases: the role's agent when `provider` is `"agent"`, and the agent that takes over
  when `provider` is `"codex"` and Codex cannot run, the same brief in hand.
- `quorum.plan.a` has no `provider`. A's briefs read the ledger, and `aidrian quorum codex --mode rebut` answers only
  B's objections, so A has no Codex path. `aidrian check` names `quorum.plan.a.provider` as an unknown key.
- `maxDispatches` is at least 5: the two objection dispatches, one ruling, one fallback, and the reserved pass.
  Only B can run on Codex, so a plan run falls back at most once.
  Under 8, the default, rebuttals and the final ruling may not fit, and the objections they would answer escalate to the Human.
- Every `agent` is an agent name, such as `code-reviewer` or a project's own agent; `"*"` and `"main"` name no one agent.
- The number of decide positions is the question file's, 2 to 4, never a config value, so no option the Human gave is dropped.

### Who plays the end user

No key turns a persona on, and none names one. In a product run a persona takes part whenever the project has a usable one:
each doc the knowledge index tags `personas`, other than `product-access` and any with an `aidrian lint personas` problem, is a candidate,
and the run picks the one the decision changes most.
With no candidate, no end user takes part, and the report warns about it. To add a persona, add its doc: see [Personas](personas.md).
`aidrian-knowledge route personas` lists the docs tagged `personas` before a run starts.

### Automatic product quorums

`aidrian quorum route` says what happens to one product decision, so a session need not ask the Human to start a quorum on a hard call.
It starts nothing itself: it prints the route, as [project-folder.md](project-folder.md#local-state) describes.
It reads all three keys from the base branch's tip, as `resolve` reads `decisions`, so a branch cannot raise them.
No readable base, git absent included, counts as off, and so does an error under `quorum.product` at the base.
Only a `product` or `ux` call routes: under any other domain, `resolve`'s answer stands, as with `autoStart` off.

The deciding agent answers five yes/no questions, each from the decision in front of it, as `--hard`, in this order:

1. **Open options:** are there two or more options that differ in what a user gets, each still viable after reading the project's docs?
2. **No written answer:** does no doc, decision record, or committed data favour one option, so that the pick rests on an inference?
3. **Conflict:** do two written rules disagree, or do the docs and the code disagree on this behaviour?
4. **Disagreement:** did a specialist, a reviewer, or `secondLook` object to the pick with a citation?
5. **Reach:** does it change a step of a flow a persona doc describes, rather than only copy, layout, ordering, a default value, or naming?

All five `no` is small and clear. Any `yes`, or a missing or unknown answer, makes the call hard.
Questions 1 and 2 are read together: wording with one obvious option stays small.

| `autoStart` | Call | `resolve` | `approval` | `route` | `wait` | What happens |
| --- | --- | --- | --- | --- | --- | --- |
| off | any | any | any | `as-today` | `true` under `ask` | `resolve`'s answer stands |
| on | small, clear | `decide` | any | `agent` | `false` | The agent decides alone |
| on | small, clear | `ask` | any | `human` | `true` | It asks, with no quorum, and an unattended run follows `unattended` |
| on | hard | `decide` | `review-later` | `quorum` | `false` | The quorum runs, and work continues on its recommendation as provisional |
| on | hard | `decide` | `first` | `quorum` | `true` | The quorum runs, then the Human approves |
| on | hard | `ask` | any | `quorum` | `true` | The quorum runs, then the Human approves |
| on | hard, at `maxAutoRuns` | any | any | `human` | `true` | It waits, with no quorum |

`resolve` remains the one authority, and the stricter setting wins.
So `autoStart` alone decides nothing while `decisions` resolves to `ask`, as it does by default:
a small, clear call still goes to the Human, and a hard one runs the quorum and then waits.
For this to change anything but who starts the quorum, a team commits `decide-reversible` for a small, clear decision to be the agent's alone,
through `decisions.maxMode` with `decisions.mode` or `decisions.domains.product`.
A call that is hard to undo, or of a class that must reach the Human, reaches the `ask` rows through `resolve`'s
[rules](#decisions), so `approval` never lets it through.
With `autoStart` on, the quorum route replaces `unattended`'s `safe-default` on a hard call, since it is the stricter path;
`as-today` keeps `unattended` as ever.

After a ruling, `aidrian quorum route --ledger` applies the same answer to the ruling's flipping facts.
Under `review-later` and `decide`, work waits for the Human when the ruling escalates, when a fact could make the decision harder to undo,
when a fact the repository can settle does not keep the winner once a read-only `explorer` dispatch settles it,
or, on a ledger already provisional, when its marker was rejected, was settled, or is not on record.
A run whose starting route had `resolve.authority` `ask` waits, whatever the Ruling's answers resolve to, and so does a run the Human started:
`route --ledger`, `aidrian quorum provisional`, and `quorum check` on a provisional ledger read the ledger's `trigger`, and only `the route, with resolve's decide` continues.
At or above `secondLook`'s `minSeverity`, or with an unknown severity, the writer refuses until the ledger's `second_look` holds `sign_off: approved`.
With `autoStart` on, a `ux` ruling of class `product-behaviour` continues where `domains.product` decides, whatever `domains.ux` says,
since `resolve` judges that class under `product`.
Every other flipping fact goes in the record for the batch review, and work continues. Under `first`, the Human sees them all before deciding.
[decisions.md](../plugins/aidrian/skills/knowledge/references/decisions.md) holds the order: the check, the route, the settle step, the writer,
the marker in the slice's commit, and a last `aidrian decisions list --added-since`, whose missing marker makes the decision wait.
A continued ruling always gets a marker, even with `Rule changed: none`,
so the pull request's Decisions section and the `decision-review` skill both show it, with its pull request number.

Before turning `autoStart` on:

- **Cost.** One run makes at most 22 dispatches with the default `maxLoops`, plus one read-only `explorer` dispatch for the settle step.
  At the default `maxAutoRuns` an unsupervised session can spend 69 dispatches this way.
- **Unreviewed choices.** `review-later` with auto-merge can ship a choice no person reviewed: the work continues on the recommendation,
  and the pull request can merge before the batch review reaches it.
- **Different winners.** Winners have varied between runs: three blind runs on one question chose two different winners.
  A recommendation is the evidence weighed once, not a settled answer.

`aidrian check` warns when `approval` is `"review-later"` and the product domain resolves to `ask`, since review later could then never apply,
and when `approval` or `maxAutoRuns` is set while `autoStart` is off.

## Decisions

`decisions` sets how far agents may settle product and design decisions on their own.
By default every decision goes to the Human, and no setting changes that until the team opts in.
To opt in, commit `"maxMode": "decide-reversible"` with a `mode` or `domains` entry of the same, or leave those to each machine's local file.
An agent may then settle the reversible, ordinary decisions.

`aidrian decisions resolve` answers for one decision, and prints the rule that matched, as one JSON line:

```console
$ aidrian decisions resolve --domain ux --class copy --reversible no,no,no,no
{"authority":"ask","rule":"mode","reason":"mode is ask","unattended":"safe-default","secondLook":{"agent":"critic","minSeverity":"high"},"base":"451dc4b8cce82671ae7afc534c0a7ab8c9604546"}
```

`authority` is `decide` or `ask`, and either one exits 0.
`unattended` says what an unattended run does with this `ask`, and is `null` under `decide`: [Unattended runs](#unattended-runs).
`secondLook` is the block's `decisions.secondLook`, read as the rest is, so a working-copy edit cannot change it; it is `null` with the rule `no-base`.
`--doc PATH`, repeated, names a doc the decision touches, with an optional `#section`. A relative path is read from the current folder and from the
project root, and either reading can match. Any spelling of a path counts as the same doc, and a section matches by its heading's slug.
Case does not count, on any disk: two docs that differ only by case both ask, which fails closed.
A symlink counts as both its own path and its target's, in `--doc` and in `escalateDocs`; a link whose target is outside the project asks.
`aidrian decisions resolve --vocab` prints every class and reversibility question with its definition;
`lib/decisions.json` is the one place the built-in ones live, and the base branch's [`decisions.classes`](#project-classes) adds the project's.
The `quorum` skill's product mode runs `resolve` on its ruling and reports the answer, and asks the Human, under `decide` too,
unless the route after the ruling lets work continue: [Automatic product quorums](#automatic-product-quorums).
The `persona-audit-triage` skill does the same for a held finding's product decision.

The first rule that matches wins:

1. A floor class, `security`, `critical-flow`, `money`, `data-loss`, or `unknown`, or a class in neither list, asks:
   `authority` stays `ask` under every setting.
   An [unattended run](#unattended-runs) under `safeDefaults` `"all"` may still act on one with a safe default.
   No setting lets an agent approve a critical-flow sign-off or a security verdict; the skill text holds that rule, and no command checks it.
2. A class in `escalate` asks. A doc outside the project asks, and so does a doc `escalateDocs` covers.
   `docs/terms.md#refunds` covers that section and the file with no section named, but not `docs/terms.md#other`.
3. Any reversibility answer that is yes or missing asks, but for the yes below that the team accepted.
   The four answers, in order: `storedData`, `external`, `pricingOrContract`, `reachesUsersUnreviewed`.
   The last asks whether the change reaches existing users with no human review of its pull request and no off switch.
   The agent answers it literally, and the command applies the team's acceptance.
   Where a team has both `decide-reversible` and auto-merge allowed, a change may reach users with no person looking at it;
   those two opt-ins are the acceptance.
   So where `github.autoMerge.allow` is true at the base branch, in the commit `resolve` reads,
   and the domain's mode, held to `maxMode`, is `decide-reversible`, a yes on `reachesUsersUnreviewed` does not ask, and `reason` says so.
   `resolve` reads the default branch's commit, since no pull request need exist when an agent decides.
   A pull request aimed at a branch that does not allow auto-merge is still merged by a person,
   and a machine's `github.autoMerge` switch does not change the answer.
   Floor classes, the escalate lists, the other three questions, a missing answer, and the rules below still ask.
   A working-copy value counts for nothing, and no base, git absent included, or no readable block keeps asking.
4. An unknown domain asks. A domain that is paused asks, with the rule `domain-paused`: its unreviewed decisions reach `pauseDomainAt.pending`,
   or the oldest reaches `pauseDomainAt.oldestDays` days.
   Unreviewed means each unconfirmed marker at the base commit, plus each marker the branch committed, whatever its status.
   So an uncommitted edit, or a status set on the branch, cannot lift a pause; the Human's answer lifts it once it reaches the base branch.
   The base is the local `origin/HEAD`, so after that answer merges, `resolve` stays paused until a fetch.
   The reason names the docs that hold the domain's markers, since any tracked Markdown file counts.
   `aidrian decisions list` reports a marker in a file no index lists.
   A marker whose only problem is a class in neither list still counts, so a commit that removes a class lifts no pause.
   `aidrian decisions list` reports it as a problem, and the `decision-review` skill relays it.
   With no git at all, the working copy's unconfirmed markers count. When git cannot read them, the decision asks, with the rule `no-base`.
5. `domains.<domain>`, unless it is `"inherit"`, then `mode`, each held to `maxMode`. Only `"decide-reversible"` decides.
   The class `product-behaviour` always counts as the `product` domain, in this rule and the pause, whatever `--domain` or an older marker says.

### Project classes

`decisions.classes` adds a project's own classes to the built-in list:

```json
{ "decisions": { "classes": { "pricing-page": "the words and layout of the pricing page" }, "escalate": ["pricing-page"] } }
```

- A name takes lowercase letters, digits, and `-`, at most 23 characters, since it goes in a [marker](project-folder.md#decision-markers).
  Its definition is one line.
- A name of the built-in list is a config error, so a project can neither redefine a class nor lift or remove a floor class.
- A project class is an ordinary class: the rules below rule 1 apply to it, and `decisions.escalate` may list it.
- `resolve` and `--vocab` read it from the base branch, so a class the working copy adds counts once it merges.
  `aidrian decisions list`, `set`, and `undo` read it from the working copy, as they read the docs;
  `list --added-since` reads each end's from that commit, so a branch that removes a class owns the problems that makes.
  A class removed later leaves its markers as problems, which `aidrian check` warns about. They still count toward the domain pause.

### Unattended runs

Nobody is there to answer an `ask` during an [`autopilot`](../plugins/aidrian/skills/autopilot/SKILL.md) run.
`resolve` prints what the run does, so the skill reads no config: `unattended` is `park`, or `safe-default`,
take a clearly safe default that can be undone, and flag it in the report.
`decisions.unattended.safeDefaults` sets it, from the base branch:

| Value | The run parks | On any other `ask` |
| --- | --- | --- |
| `"outside-escalated"`, the default | A floor class or a class in neither list, a class in `escalate`, and a doc `escalateDocs` covers | `safe-default` |
| `"all"` | Only a class in `escalate` and a doc `escalateDocs` covers | `safe-default` |

- What the project listed parks whichever rule matched first, such as a floor class on a listed doc, under either value.
- `unattended` is `park` where nobody can say what the project listed: the rule `no-base`; a base commit whose config.json is missing, does not parse,
  or has another version; and an error under `decisions` at that commit. A config.json with no `decisions` key takes the defaults.
- No setting lets an agent approve a critical-flow sign-off or a security verdict: those are gates, not decisions, and `resolve` is never asked about them.
  The skill text holds that rule, and no command checks it.

### How agents use the answer

`plugins/aidrian/skills/knowledge/references/decisions.md` is the one rule the agents and skills follow.
The agent that owns the decision, such as `product-manager` or `architect`, gives its class, four answers, and the docs it touches. A missing one is `ask`.
The dispatcher runs the command and passes `authority: decide` or `authority: ask` in the agent's brief; the agent never computes it, and a brief with no such line is `ask`.

- Under `ask`, the agent returns `decision_options` with an advisory recommendation, and the Human chooses.
- Under `decide`, it returns `decided_provisional` ([the fields](../plugins/aidrian/skills/knowledge/references/handoff.md)), and the work goes on.
  The dispatcher lists each one in its report, and it goes on record: [Recording decisions](#recording-decisions).
- At or above `minSeverity` in the command's `secondLook`, or with no known severity, the agent it names must return `sign_off: approved` before the work goes on; anything else sends the decision to the Human.
- A critical-flow sign-off or a security verdict is never self-approved, in any mode.

### Recording decisions

Each `decided_provisional` is committed as a marker line in the doc that governs it: [Decision markers](project-folder.md#decision-markers).
`aidrian decisions list` prints them, and `aidrian decisions set <id> confirmed|changed|rejected` records the Human's answer. Nothing settles one by time.
`aidrian decisions undo <id>` takes one back.
The [`decision-review`](../plugins/aidrian/skills/decision-review/SKILL.md) skill goes through them with the Human, in a batch.
Session start reminds the main session of them while `unreviewed.remind` is `"session-start"`.
The skill below reads the branch's own with `aidrian decisions list --added-since <ref>`: `decisions`, `settled`, and `removed` are the branch's;
`problems` may also hold rows marked `inherited`.
`resolve`, `set`, and `undo` add a [row to the dispatch log](dispatch-log.md#decision_made-and-decision_escalated-when-resolve-answers),
and `aidrian report health` ranks [how often the Human overrides](dispatch-log.md#health).

Under `decisions.record.queue` `"pr-body"`, the default, the [`pr-write`](../plugins/aidrian/skills/pr-write/SKILL.md) skill also lists
the branch's decisions in the pull request body: in a `## Decisions` section, or, when `github.pullRequest.sections` is set without `Decisions`,
under `## Summary` as a `Decisions:` sub-list.
The [pull request body rule](#pull-request-contract) takes both, and a closed list still refuses the heading.
Under `"report"`, the skill leaves them out of the body. The marker is written under either value.
The skill reads the value from the `queue` that `aidrian decisions list --added-since <ref> --json` prints, from the commit `resolve` reads,
so a working-copy edit, or a commit on the branch, cannot change it; with no readable block, or no project folder, it is `"pr-body"`.

### Which config it reads

The command reads the team's block from the commit of the base branch: `origin/HEAD`, or else `main` on `origin`.
A local `main` counts only in a repository with no remote at all.
It takes the config folder from `.aidrian.json` at that commit too. No name it uses comes from the working copy,
so an uncommitted edit, or a commit on another branch, cannot raise an agent's authority.
The exception: with no remote, a commit on the local `main` is the base, so it does raise authority.

- In a git repository with no such commit, or when git does not answer, every decision asks, with the rule `no-base`.
  That includes a repository whose only remote has another name, such as `upstream`: run `git remote rename upstream origin`, or add `origin` and fetch it.
  A project whose default branch is not `main` needs `origin/HEAD`: `git remote set-head origin --auto` sets it.
- A base commit whose config.json is missing, does not parse, or has another version holds every decision at ask, whatever the local file says.
  So does one with a bad value or an unknown key under `decisions`.
- Only outside git does the command read the working copy's config.json, and `base` is `null`.

`.aidrian.local.json` may set a few of these keys for one machine, on top of the team's block. They are read only from the main checkout's copy,
so a copy in a worktree raises nothing:

```json
{ "decisions": { "mode": "decide-reversible", "domains": { "ux": "ask" }, "unreviewed": { "remind": "off", "pauseDomainAt": { "pending": 3, "oldestDays": 2 } } } }
```

- `mode` and `domains.*` are held to the team's `maxMode`: a higher value counts as `maxMode`, with no error.
  Under the default `"ask"`, they raise nothing.
- `unreviewed.remind` is free.
- `unreviewed.pauseDomainAt` applies only where it is lower than the team's, one limit at a time; a higher value or `null` is ignored.
- Any other key is an error, and the team's value stays: `maxMode`, `classes`, `escalate`, `escalateDocs`, `unattended`, `secondLook`,
  and `record` are the team's.

A bad value or an unknown key under `decisions` in the working copy is a config error: `aidrian check` names it, the hooks keep the default,
as in any other group, and `aidrian decisions resolve` stops.
At the base commit, where no command reports it, it holds every decision at ask instead of keeping the default.
`secondLook` and `pauseDomainAt` are given whole, or `null`.

`aidrian check` warns about settings that do nothing, and still passes:

- `remind` is `"off"` and `pauseDomainAt` is `null`: nothing would say that decisions are piling up, or stop them.
- `mode` or a `domains` entry in config.json is above `maxMode`: it has no effect, and the warning names `decisions.maxMode` as the key to commit.
  The command answers with the rule `maxMode`. A local value above it is held down, as above, with no warning.
- An `escalateDocs` entry whose file or folder no tracked path matches exactly, case included, such as a typo.
  A doc may be listed before it exists, so this is a warning and not an error.
- A [decision marker](project-folder.md#decision-markers) it cannot read, an id on two markers, wording undo could no longer find,
  a stack whose wordings do not chain, or a marker in a tracked Markdown file no index lists.

## Audit triage

`audits.triage` sets how the `persona-audit-triage` skill files the issues it decides on
([Triage](personas.md#triage)). `aidrian audits pending --json` reads it, so the skill never parses this file, and it
stops on an invalid config.json as every `aidrian` command does.

| Key | Default | Meaning |
| --- | --- | --- |
| `audits.triage.issueCreation` | `"confirm"` | `"confirm"` shows each drafted issue, or each batch the Human approved, and creates nothing until the Human says yes. `"auto"` creates issues without asking, for runs no one supervises. |
| `audits.triage.labels` | `["persona-audit", "persona:{persona}", "severity:{severity}"]` | The labels of every issue from the triage. `{persona}` gives one label per persona of the finding, and `{severity}` its severity; a Not reached line or a doc gap takes the report's personas and no severity label. At least one label is plain. |

- In both modes, a finding about a product rule, or an open question in a product doc, goes to `product-manager`
  first. In `"auto"`, a finding it does not settle is deferred, never filed, and every decision is still recorded in
  `triage.json`; the skill ends with a list of what it created.
- `agent-issue-writer` applies the labels where the tracker has them. It creates a missing label only in `"confirm"`,
  after the Human approves; in `"auto"` it leaves a missing label out and names it in the summary.
- Before a finding is recorded as a duplicate, the tracker search also queries the plain labels, which every audit
  issue carries, so an earlier audit's issue is found by its label as well as its words.
- Each issue body names its source in words, the report by persona, kind, and date and the finding by its title, with
  the report's path; the machine key the duplicate search can use stays in a footer, never in the title or first lines.

## Checking

`aidrian check` validates this file with the rest of the project folder.
It lists every problem: a missing file, invalid JSON, a missing or other `version`, an unknown key, or a value of the wrong type.
In `quorum`, that includes a `provider` on `quorum.plan.a`, a `provider` other than `"agent"` or `"codex"`,
a `plan.maxObjections` outside 1 to 5, a `plan.maxDispatches` under 5 or not a whole number, and an `agent` that is no agent name.
Each message names the key, such as `quorum.plan.b.provider`.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed.
