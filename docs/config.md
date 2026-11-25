# Project config

`config.json` in the [project folder](project-folder.md) holds the folder version and the project's settings for the plugin.
The plugin's commands, hooks, and skills read it.
An `aidrian` command never acts on a `config.json` with an error, such as a renamed key.
It prints the errors and exits with its error code instead, such as 3 for `aidrian pr checks`.
The hooks keep working, with the default in place of each bad value.
Without a `config.json`, the commands use the defaults.

[`examples/consumer/.aidrian/config.json`](../examples/consumer/.aidrian/config.json) is a minimal, checked example,
and [config-recipes.md](config-recipes.md) gives four checked starting configs by how much the Human steers.

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
  "solo": false,
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
    "publicText": { "patterns": [] },
    "reviewGate": { "enabled": false, "checklist": null },
    "autoMerge": { "allow": false, "default": "off", "strategy": null, "deleteBranch": false, "deleteWorktree": false, "includeGuardedPaths": false, "includePolicyFiles": false, "unreviewedPaths": [] },
    "unattendedWaiver": { "allow": false }
  },
  "review": { "engine": null, "record": "comment", "rules": [], "ignore": ["<lockfiles, snapshots, generated, vendored, minified>"], "nonBehaviour": ["<Markdown, LICENSE, NOTICE, raster images, fonts>"], "flows": {}, "planCommand": null, "reviewers": {}, "approvals": { "allow": false }, "fixSmallGaps": false, "productFeedback": { "auto": false, "files": null, "maxPersonas": 2, "allWidths": null } },
  "docs": { "wrapLimit": 155 },
  "testing": { "fullSuite": ["npm test", "npm run test"], "changedCommand": null, "pushFirstMinutes": 0 },
  "terms": { "file": null },
  "knowledge": { "budgets": { "alwaysBytes": 16384, "taggedDocBytes": 24576, "untaggedDocBytes": null, "enforce": "warn", "baseline": {} }, "defaults": { "codeStyle": true } },
  "skills": { "descriptionChars": 160, "listingBytes": 9216 },
  "session": { "handoff": { "mode": "ask", "costRatio": 2, "maxTokens": 0, "continue": "none", "maxChain": 3, "resumeTokens": null } },
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
  },
  "tracker": { "enabled": false, "workspace": null, "readTools": [], "writeTools": [], "team": null, "project": null },
  "projectRun": { "allow": false, "maxParallel": 1, "maxStarts": 300, "issueHours": 6, "blockedStatus": null, "decisionLabel": "needs-decision", "unverifiedHosts": false, "workflowSecretsAccepted": false, "forgeProtectionAccepted": false, "outsideSandbox": [], "mcpServers": {}, "nonTrackerServers": [], "registries": [], "localBinding": false, "recordedDecisions": false, "fullAuto": false }
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
| `solo` | `true` says one person runs the project: each unattended machine switch the local file leaves unset follows the team's keys ([Solo](#solo)). `false`, the default, keeps them to the local file. Read from the base branch on GitHub, never the working copy. |
| `github.requiredSections` | The `## ` sections every pull request body must have ([Bash rules](hooks.md#bash-rules)); `[]` checks none. |
| `github.reviewer` | The login of the Codex review bot that `aidrian pr await-review` waits for. `null` or `"none"`: no bot ([below](#no-review-bot)). The harness asks the bot with an `@codex review` comment, so turn off Automatic reviews in Codex's code review settings, for the repository and in the personal preferences of the account that connected it: with them on, the bot also reviews a pull request when it opens or is marked ready, so a draft head it already reviewed on request gets a second review, which counts as one more round against `github.maxReviewRounds`. |
| `github.maxReviewRounds` | The review rounds a pull request may get, 3 by default: the review loop and `aidrian pr await-review --request` stop there, unless `extraRounds` grants one more. They read it from the pull request's base branch, as the remote naming its repository has it ([The record](review.md#the-record)), so an edit to the working copy does not raise it; `aidrian pr await-review` without `--request` posts nothing and reads no base branch. A `--max-rounds` above it runs only with `AIDRIAN_ALLOW_EXTRA_ROUNDS=1`, and runs at exactly that count; a higher cap an earlier bot request recorded in its comment carries over only to a run with the variable set and no `--max-rounds`. The Human sets it in their own shell, or an agent sets it inline on the exact raise the Human approved by an answer or a typed grant ([review.md](review.md#unattended-rulings)); a Bash rule refuses it on any other ground, and any bot request made outside `aidrian pr`. |
| `github.extraRounds` | What happens at that cap: [Extra rounds](review.md#extra-rounds). `"ask"`, the default: a read-only judge decides whether one more round is worth it, with any red flag of the round history (not converging, looping, drifting, bloating) as evidence, and the Human approves it. `"auto"`: the judge's word grants it, unless a red flag stands, when the Human approves it too. `"off"`: the cap stops, as `round_limit`. Read from the base branch, like the cap. |
| `github.maxExtraRounds` | The most extra rounds `extraRounds` may grant one pull request, 2 by default; a hard ceiling, read from the base branch. `0` grants none. |
| `github.requiredChecks` | Parts of check names that must be present and pass before `aidrian pr checks` says ready. [Auto-merge](#auto-merge) stays off until the default branch names one. |
| `github.ignoreCancelledChecks` | Parts of check names whose `CANCELLED` result is routine and not a failure. |
| `github.conditionalChecks` | Parts of check names whose `SKIPPED` or `NEUTRAL` result is routine, such as a job a path filter turns off. |
| `github.markReady` | Who marks a draft pull request ready. `"auto"`, the default: the `pr-review-loop` skill, or `autopilot` and the `orchestrator` when they run it, mark it ready once a review of the current head signs off with no blocked row and `aidrian pr checks` says ready. `"ask"`: its author, or the review loop when the Human asks in the session. Either way, nothing is pushed after it is marked ready. Marking it ready merges nothing: only the Human's request or [auto-merge](#auto-merge) does. The default was `"ask"` before; [Changed defaults](#changed-defaults) has the opt-out. |
| `github.reviewLoop` | What follows the `pr-write` skill once it opens or updates a pull request. `"auto"`, the default: once `pr-write`, and any skill that ran it, such as a top-level `issue-implement` or `plan-implement`, has ended, the session starts the `pr-review-loop` skill on it right away, without asking. `"ask"`: the session offers the loop and runs it when the Human asks. Run inside a skill or agent that runs its own review loop, such as `autopilot` or the `orchestrator`, `pr-write` leaves the loop to it. |
| `github.titleIssuePrefix` | `true` writes pull request titles as `[<issue key>] type(scope): subject`, or `[NOISSUE] type: subject`; `false`, the default, writes a plain Conventional Commits title. |
| `github.pullRequest` | The project's [pull request contract](#pull-request-contract), beyond the required sections; off by default but for `sharedTempBodyFile`. |
| `github.publicText.patterns` | The case-insensitive regular expressions no issue, pull request, or comment text may match ([Public text](#public-text)); `[]`, the default, adds none. |
| `github.reviewGate.enabled` | `true` asks the review bot only once a review of the diff is on record: [Review gate](#review-gate). |
| `github.reviewGate.checklist` | A file the reviewer reads the diff against, named in the gate's message; `null` names none. |
| `github.autoMerge.allow` | `true` lets a machine opt in to [auto-merge](#auto-merge); `false`, the default, keeps it off. It counts only when the repository's default branch and the pull request's base both allow it, read from GitHub, so a branch cannot raise it. Read at the base branch, with `decide-reversible`, it also stops a yes on `reachesUsersUnreviewed` from asking: [rule 3 under Decisions](#decisions). |
| `github.autoMerge.default` | What a machine with no local setting does under `allow`: `"off"`, the default, stays out until it opts in; `"on"` takes part until it opts out. Read from the default branch. |
| `github.autoMerge.strategy` | How auto-merge merges: `"squash"`, `"merge"`, or `"rebase"`. `null`, the default: the one strategy the repository allows, or with several, `squash`, then `merge`, then `rebase`. Read from the default branch. |
| `github.autoMerge.deleteBranch` | `true` deletes the remote head branch with the merge. Read from the default branch. |
| `github.autoMerge.deleteWorktree` | `true` removes the head branch's worktree after the merge, but never a session's own: [Cleanup](#cleanup-after-the-merge). Read from the default branch. |
| `github.autoMerge.includeGuardedPaths` | `true` lets a pull request that changes a guarded path (the fixed list under `paths` in [Auto-merge](#auto-merge), and the knowledge docs the start hook loads) pass the `paths` check, but never a policy file: the files the gate reads its policy from, including a folder `.aidrian.json` names, and `.aidrian/config.json` at any depth, `.aidrian.json`, `.aidrian.local.json`, and the `.aidrian` entry itself stay refused. `false`, the default, keeps a guarded path off. It counts only when the repository's default branch and the pull request's base both set it, read from GitHub as `allow` is, never from the checkout. Every other check stays. Read the risk under [Auto-merge](#auto-merge) before setting it. |
| `github.autoMerge.includePolicyFiles` | `true` lets the policy files through the `paths` check too: `.aidrian/config.json` at any depth, `.aidrian.json`, `.aidrian.local.json`, the `.aidrian` entry itself, and the files the gate reads its policy from, including a folder `.aidrian.json` names. It also lets a [project run](#project-run)'s issue sessions write those files and the instruction files `includeGuardedPaths` covers, read when the run starts as every key of the team policy is. `false`, the default, keeps them refused. It counts only while `includeGuardedPaths` counts, and only when the repository's default branch and the pull request's base both set it, read from GitHub as `allow` is, never from the checkout, so the pull request that sets it is refused as before. With it counting, a policy file's change also needs no sign-off of the Human, even for a merge no Human attends (`trust`). A change to one of the `review` settings the review step compares, `engine`, `rules`, `ignore`, `nonBehaviour`, `flows`, `planCommand`, `reviewers`, `split`, `visual`, `approvals`, or `unattendedSignoff`, still gets the built-in harness-config review pass, as on main, and its reviewer signs it in place of the Human; any other edit of the file follows the review's usual file rules. The sign-off still applies while either branch's review runs a command of the project's, such as `review.planCommand`, an `exec` reviewer, or `review.visual`'s login or preview, and when the policy file is also a doc a flow's invariants cite. Every other check stays, and the `checks` row still refuses a change to `github.requiredChecks`, `conditionalChecks`, `ignoreCancelledChecks`, or `state.dir`. `aidrian check` warns while it is on. Read the risk under [Auto-merge](#auto-merge) before setting it. An older plugin rejects the key as unknown, so set [`requires.aidrian`](#plugin-version) to the release that ships it. |
| `github.autoMerge.unreviewedPaths` | The files a pull request whose review was `none_needed` may change and still auto-merge, as globs or `re:` entries in the syntax of the review's lists, from the project root. Each entry matches the whole path: `README.md` is the top-level file only, not `prompts/README.md`, and a `re:` entry is anchored at both ends. `[]`, the default, keeps every such pull request for the Human. It counts only when the repository's default branch and the pull request's base both list the file, read from GitHub as `allow` is, never from the checkout, so a branch cannot list its own files. A bad entry, such as a `re:` that does not compile or an empty `re:`, is a config error, and the gate refuses on it. The gate cannot know how a file is read, so list only files that no AI session reads as instructions, through an import, a link, a command, or a plugin, and that no build, docs site, or test reads as code or as an expected result. Common cases that do not qualify: Markdown a docs site parses as MDX, such as Docusaurus, or as pages with script, such as VitePress; a README whose code blocks run as doctests, such as cargo's or pytest's `--doctest-glob`; and an end-to-end test's expected files. A top-level `README.md` that nothing builds or runs is the usual case. The rest of the `review` row under [When it is on](#when-it-is-on) still applies to a listed file. An older plugin rejects the key as unknown, so set [`requires.aidrian`](#plugin-version) to the release that ships it. |
| `github.autoMerge` in `.aidrian.local.json` | This machine's choice, the same key with one field: `{ "enabled": true }` opts in under the team's `allow`, and `{ "enabled": false }` stays out. Unset follows `github.autoMerge.default`. The older `"on"` and `"off"` still work. |
| `review.unattendedSignoff.allow` | `true` lets a machine opt in to [unattended rulings](review.md#unattended-rulings): a judge's `aidrian pr settle` closes an unverified or disputed invariant in place of the Human. `false`, the default, keeps it off. Read from the base branch. The machine's switch is `"unattendedSignoff": "on"` in `.aidrian.local.json`; unset follows [`solo`](#solo). |
| `github.unattendedWaiver.allow` | `true` lets a machine opt in to the [unattended waiver](#unattended-waiver): the merge guard, and any `aidrian pr auto-merge` under these switches, may take a judge's recorded verdict in place of the Human's answer to the merge guard's question, at the round cap, once the review bot passed the head. `false`, the default, keeps it off. It counts only when the repository's default branch and the pull request's base both allow it, read from GitHub, so a branch cannot raise it. |
| `github.unattendedWaiver` in `.aidrian.local.json` | This machine's choice, the same shape as `github.autoMerge` there: `{ "enabled": true }` or `{ "enabled": false }`, or the older `"on"` and `"off"`. Unset is off, unless the team runs the project [`solo`](#solo). |
| `review.engine` | The project's [review engine](review.md#the-engine); it wins over the machine's. `null` leaves the choice to each machine. In a project run's confined issue session, `codex-local` is not ready, as when Codex is not installed, `auto` takes `self`, a flow that requires `independent-model` is `unsatisfied` unless `--with-bot` adds the bot and an agent answers the flow, and a plan with a `codex-local` pass with no result to reuse is refused ([The engine](review.md#the-engine)). |
| `review.record` | Where the [review record](review.md#the-record) goes: `"comment"` also writes a summary comment on the pull request; `"local"` keeps it in the state folder only. The record commands read it as the pull request's base branch commits it, not from the working copy; only a command the forge names no base for reads no comment, keeps this machine's record, and publishes nothing. Another machine builds on the comment's copy only on a private repository; on one that is not private it restarts from its own record, with the copy's round count and id counter as floors, so the round cap still holds, or holds and names the machine that wrote the copy while that copy has an open, blocking finding it holds no text for ([A second machine](review.md#the-posted-copy)). |
| `review.fixSmallGaps` | `true` fixes a [small gap](review.md#small-gaps) the pull request did not bring, one already in the base or outside the issue's scope, in the same pull request when its fix is trivial, instead of reporting it as pre-existing or filing a new issue. `false`, the default, keeps both routes. Read from the working copy. |
| `review.publish.summary` | What the summary comment shows of the findings: `"counts"`, the default, each pass's counts; `"findings"` adds a table of each finding's id, location, severity, disposition, and outcome, with no finding text: [Publishing](review.md#publishing). Read from the base branch, as `review.record` is; under `review.record: "local"` nothing is posted, whatever this group says. An unknown key or value is a config error. |
| `review.publish.publicSecurity` | How a security finding shows on a repository that does not read as private: `"counts"`, the default, a count while it is open and a row of its id, severity, outcome, and closing range once closed; `"full"`, its location and disposition like any other finding's. Its text is never posted there. |
| `review.publish.inline` | `false` by default. `true` posts each step's new blocking findings as one review on the pull request's head, one thread per finding on an added line of the diff, the rest in its body, with a conversation comment in its place when the forge refuses it ([Publishing](review.md#publishing)). It can stay on beside the review bot: the bot leaves the engine's threads alone, but may open its own thread for the same problem ([Inline reviews](review.md#inline-reviews)). |
| `review.publish.replies` | `true` by default: with `inline` on, each finding's thread gets one reply once it closes, and is resolved when it is the engine's alone ([Replies](review.md#replies)). `false` posts no reply. |
| `review.publish` in `.aidrian.local.json` | This machine's choice, which only ever posts less: `"summary": "counts"` and `"inline": false`, and nothing else. Any other key or value there, `"publicSecurity": "full"` included, is a config error, and the team's value stays. |
| `review.productFeedback.maxPersonas` | How many personas `persona-audit` [picks for a pull request](personas.md#a-pull-request-link-alone): a whole number from 1 to 10, 2 by default. A run that names personas, or `all`, has no cap. |
| `review.productFeedback.allWidths` | `null`, the default, or `{ "files": [...] }`: when a pull request changes a listed file, the persona walk does each in-scope browser task once per width of `review.visual.viewports`. Read from the working copy, as `maxPersonas` is. It multiplies the walks by the widths: [Walking every width](#walking-every-width). |
| `review.productFeedback.auto` | `true` makes a pull request that changes a user-facing file owe [product feedback](#product-feedback). `false`, the default. Read from the default branch and the base, never the working copy: it is on when either says true. With neither list below, it is an error here, and `status` reads it as clear. |
| `review.productFeedback.files` | The globs, or `re:` patterns, of the user-facing files. `null`, the default, uses `review.visual.targets[].files`. Read from the default branch and the base, as their union. |
| `review.productFeedback` in `.aidrian.local.json` | This machine's choice: `{ "auto": true }` or `{ "auto": false }`, and no other key. Read only from the main checkout's file. It wins over the branches both ways: [Product feedback](#product-feedback). |
| `terms.file` | The [terms file](#terms) of banned terms and their replacements, relative to the project root; `null` turns the rule off. |
| `docs.wrapLimit` | The longest line, in characters, allowed in a Markdown file an agent writes; `0` turns the check off. |
| `testing.fullSuite` | The commands that run the whole test suite, as written: [Testing](#testing). |
| `testing.changedCommand` | The command `aidrian test changed` gives the touched test files; `null`, the default, is `npm test --` when package.json has a test script, given only the `.js`, `.mjs`, and `.cjs` test files: [Testing](#testing). |
| `testing.pushFirstMinutes` | How old a commit the branch's remote copy lacks may be before a full suite is refused; `0`, the default, turns the refusal off: [Testing](#testing). |
| `knowledge.budgets.alwaysBytes` | The bytes all `always` knowledge docs may add up to: [Knowledge budgets](#knowledge-budgets). |
| `knowledge.budgets.taggedDocBytes` | The bytes one tagged knowledge doc may have: [Knowledge budgets](#knowledge-budgets). |
| `knowledge.budgets.untaggedDocBytes` | The bytes one untagged knowledge doc may have; `null`, the default, sets no cap: [Knowledge budgets](#knowledge-budgets). |
| `knowledge.budgets.enforce` | What a doc over budget does: `"warn"`, the default, prints a warning; `"fail"` fails `aidrian check` and `aidrian lint budget`: [Enforcing the budgets](#enforcing-the-budgets). |
| `knowledge.budgets.baseline` | The docs over budget when `"fail"` came on, each pinned at a size it may not pass, as `{ "<doc path>": <bytes> }`: [Enforcing the budgets](#enforcing-the-budgets). |
| `knowledge.defaults.codeStyle` | `false` takes the plugin's [default code-style doc](knowledge.md#default-code-style) out of every `code_style` route. `true`, the default, lists it after the project's own `code_style` docs, which win where they conflict. |
| `skills.descriptionChars` | The longest skill or agent description, in characters (`aidrian lint skills` and `agents`). |
| `skills.listingBytes` | The most bytes all skill names and descriptions may add up to (`aidrian lint skills`). |
| `session.handoff.mode` | What the [session-length reminder](handoff.md#the-reminder) and the plan handoff offer do: `"ask"`, `"auto"`, or `"off"`. |
| `session.handoff.costRatio` | How many times a fresh session's cost each call must cost before the reminder fires, a number of 1.1 or more; it comes back once the ratio doubles since its last firing in `ask` mode, or climbs a step of `max(costRatio − 1, 1)` in `auto`, never below `costRatio`: [Handoff](handoff.md). |
| `session.handoff.maxTokens` | An optional ceiling on the main session's context, in tokens, that fires the reminder on its own and doubles after each firing; `0`, the default, is off. |
| `session.handoff.continue` | How the session goes on after its handoff: `"none"`, `"clear"`, `"compact"`, or `"background"`. The default follows `mode`: `"background"` with `mode: "auto"`, else `"none"`; a value set here wins. A route the host cannot do falls back to `"none"`; which routes each host does is its adapter's `capabilities.handoffContinue` ([Adding a host](providers/adding-a-host.md)). `"background"` is read from the base branch, never a worktree's copy, and each machine turns it on too, with `"handoff": { "background": "on" }` in `.aidrian.local.json`; without both it falls back to `"clear"` where the host has it: [The background route](handoff.md#the-background-route). |
| `session.handoff.maxChain` | How many handoffs in a row a session may continue before a person looks, a whole number above 0, or `"unlimited"`; `3` by default. On the background route it is the base branch's, and at most 5 for any number. `"unlimited"` lifts that cap, and then the progress check stops a chain: two background hops in a row with no change to the tree of the brief's branch and no new Done item fall back to the clear route ([The progress check](handoff.md#the-progress-check)); a chain floor still records at most 10,000 continuations, and a hop past that arms nothing: a person resumes the brief. `aidrian check` fails any other value. |
| `session.handoff.resumeTokens` | The tokens a fresh session reads to resume from a brief, `B` of the [cost model](handoff.md#the-cost-model), a whole number above 0. When set it wins; `null`, the default, uses this project's measured median once 5 sessions resumed from a brief in the last 30 days, else 44,000 ([Resume tokens](handoff.md#resume-tokens)). `aidrian check` fails any other value. |
| `lessons.auto` | `false` turns off the [automatic lessons](lessons.md#automatic-lessons) the hooks and `aidrian pr await-review` record. |
| `lessons.maxOpen` | The open [lessons](lessons.md) past which the session-start line asks for triage; `0` turns this limit off. |
| `lessons.maxAgeDays` | The age, in days, of the oldest open lesson past which the session-start line asks for triage; `0` turns this limit off. |
| `models` | The model and effort of the plugin's agents, per host, in place of the ones the plugin ships: [Models](#models). |
| `names.human` | What agents call the person they work for: [Names](#names). |
| `names.ai` | What agents call themselves; `null` is the host's name, Claude or Codex, or `the AI` on a host no adapter claims: [Names](#names). |
| `requires.aidrian` | The oldest plugin version the project's config needs, such as `"0.17.0"`; `null` asks for none: [Plugin version](#plugin-version). |
| `attribution.commit` | The trailers an agent's commit must carry: [Attribution](#attribution). `[]`, the default, is off. |
| `attribution.pullRequest` | The lines a pull request body an agent opens must end with: [Attribution](#attribution). `[]` is off. |
| `attribution.exclude` | The agents the `Assisted-by:` lines leave out; by default the ones that only search and read. |
| `telemetry.enabled` | `false` stops the hooks and `aidrian decisions` from writing the [dispatch log](dispatch-log.md): [Telemetry](#telemetry). It also refuses recording a judge with `aidrian pr extend --judge` or `aidrian pr waive --judge`, and keeps auto-merge from taking a judge's verdict, since the log confirms the judge: [Unattended waiver](#unattended-waiver). |
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
| `tracker` | The workspace, team, and project MCP tracker writes belong to, off by default: [Tracker](#tracker). |
| `projectRun` | The keys of a run that works through a tracker project, one issue or a few independent ones at a time: [Project run](#project-run). |

A path in `state.dir` or `git.worktrees.dir` may start with `~`, the home folder, or be relative to the repository root.
A state folder inside the repository's checkouts keeps the plans, lessons, and audits, and `aidrian check` warns about it,
but the review-record commands and the merge guard refuse it ([The record](review.md#the-record)):
put it outside, or leave `state.dir` null.
The default folder counts too: with `state.dir` null, a default folder inside a checkout gets the same warning and refusal, in words of its own that say to point it outside by `state.dir` or by this machine's state root.
They refuse a checkout at the folder the records go in the same way, with `state.dir` set or unset, and the check warns about that too.
A state folder whose path holds a line break gets the same warning and refusal wherever it lies.
The other local state has fixed places in the state folder; [project-folder.md](project-folder.md#local-state) lists them.

Once `github.conditionalChecks` has an entry, `aidrian pr checks` fails on any other skip; `[]` lets every skip pass, named in the output.
On a draft, a `SKIPPED` check that this rule or `github.requiredChecks` would fail reads as not run yet instead: it is
named after "not run on the draft" and under `draft_skips` in `--json`, and does not fail the verdict, since a workflow
may skip its jobs until the pull request is marked ready, and the ready step marks it ready only on a ready verdict.
Once it is ready, the same skip fails. Whether it is a draft is read only when a check skipped; a read that fails counts as ready.
Before any of these, `aidrian pr checks` leaves out two kinds of row gh still lists for the head: a row from an older
run of the same workflow file and event than the newest one listed, such as the run started while the pull request was a
draft, and a `SKIPPED` or `NEUTRAL` row whose name still holds an unexpanded `${{ ... }}` expression, a matrix job that a
skipped run reported under its template name. The workflow file of each run comes from a list of the head's workflow
runs, one for each repository the workflow rows' run links name, on that link's host, read only when some workflow name
has more than one run, since two files may share a name; a run no list names is never taken for superseded. A check no workflow run reports, such as an app's status, always counts.

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

`enabled` is the only field, and `autoMerge` and [`unattendedWaiver`](#unattended-waiver) the only `github` keys,
that file takes. A machine never goes past `allow`,
and `strategy` and the cleanup stay the team's. The older `"on"` and `"off"` still work.

| Team | No local setting | `enabled: true` | `enabled: false` |
| --- | --- | --- | --- |
| `allow: false` | Off | Off | Off |
| `allow: true`, `default: "off"` | Off | On | Off |
| `allow: true`, `default: "on"` | On | On | Off |

With `default: "on"`, every machine with no local setting merges without having chosen to, so a team sets it knowingly.
A local file with an error, or one git tracks, counts as `enabled: false`.
`aidrian check` warns when the machine opts in and the team does not allow it.
It fails when git tracks `.aidrian.local.json`, in any case, and the switch then reads `"off"`: [Setting up](project-folder.md#setting-up-and-checking).
The switch counts only in the main checkout's file: a task worktree's own copy never turns it on or off, though its other keys apply as usual.
Read from a worktree, the main checkout's file gets every check it gets when read there, and its errors are reported the same:
an error anywhere in it reads an unset switch `"off"`, so it never follows a team default of on, whatever the worktree's copy holds.
A subagent may not write `autoMerge` into that file: [the config guard](hooks.md#agent-gates).

`aidrian check` also warns, while `allow` is true and [`review.visual`](review.md#visual-review) is unset, when git
tracks a screen file, since a session could then merge a screen change no capture checked; setting
`review.visual.targets` to the project's screens ends it ([Screens checked on every device](config-recipes.md#screens-checked-on-every-device)).
A screen file is a `.tsx`, `.jsx`, `.vue`, `.svelte`, or `.html` file that git tracks under the project folder, outside any
`docs`, `examples`, `vendor`, `node_modules`, `test`, `tests`, `__tests__`, `e2e`, `fixtures`, or `__fixtures__` folder
and any folder whose name starts with a dot, and not a `.test.`, `.spec.`, or `.stories.` file. The guess leaves out
screens in other files, such as `.ts` or server templates: there the check stays silent. It reads the working copy.
These are web screens, since `review.visual.platform` takes only `"web"` today, so a native-only app is not asked for
targets no capture could reach. Each `.tsx` or `.jsx` file asks its nearest `package.json`, from its own folder up to
the project root: when that one depends on `react-native` and not on `react-dom`, the file does not count. So in a
monorepo each workspace answers for its own files. With no `package.json` up to the root, or one that does not parse,
links outside the project, or is a broken link, the file counts: a broken link does not hand the answer to a manifest
above it.

A project that adopts `github.autoMerge` sets [`requires.aidrian`](#plugin-version) to the release that ships it,
since an older plugin rejects the key.

`includeGuardedPaths` is a team-wide acceptance of a real risk.
With it on, a session can open, review, and merge a pull request that edits what steers and checks it:
the instructions of any host (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/`, `.opencode/`, `.agents/`,
`.github/copilot-instructions.md`, a skill, an agent),
the `.aidrian/` knowledge, and the knowledge docs the start hook loads into every session;
the hook and permission settings in a host's folder, such as `.claude/` and `.codex/`, and OpenCode's `opencode.json(c)`; `CODEOWNERS`;
the plugin code that decides this gate and the merge guard;
and the CI workflows, which once merged run with the repository's secrets on pushes to the default branch, such as a release.
The review that approved such a change may have been shaped by it.
The files the gate reads its policy from, including a folder `.aidrian.json` names, stay refused with the key on or off,
and so do `.aidrian/config.json` at any depth, `.aidrian.json`, `.aidrian.local.json`, and the `.aidrian` entry itself.
A config that is already a symbolic link on the default branch is an accepted gap: an edit of its target is not refused.
The key never lifts the `none_needed` route of the `review` check: a pull request that needed no review and changes a
guarded path waits for the Human whatever the key or `unreviewedPaths` says, since no review read it.
Before setting the key, require on the default branch a review that no session can give, in a branch protection rule or a ruleset:
a Code Owners review, with a `CODEOWNERS` file that covers the guarded paths and itself, and code owners that no session or bot
holds a token for; or an approving review from an account that no session or bot holds a token for.
In the same rule, turn on "Dismiss stale pull request approvals when new commits are pushed"
or "Require approval of the most recent reviewable push", so an approval does not carry over to a later push,
and turn on "Do not allow bypassing the above settings", or leave a ruleset's bypass list empty.
The gate does not check that this protection exists: it reads only the key.
An older plugin rejects the key as unknown, so set `requires.aidrian` as above.

`includePolicyFiles` goes one step further, and counts only with `includeGuardedPaths` on.
With both on, a session can edit the policy that reviews and merges its own pull request:
lower its review flows, drop its visual targets, or change `requiredChecks`.
The gate and the review read the policy of the default branch and the base as GitHub holds them, never the branch's,
so the pull request that changes the policy is still judged under the old one, and the next pull request runs under the new one.
With the key counting, a change to a policy file also needs no sign-off of the Human, even for a merge no Human attends,
such as a project run's.
The review still selects the harness-config flow when one of the `review` settings it compares changes, as on main:
`engine`, `rules`, `ignore`, `nonBehaviour`, `flows`, `planCommand`, `reviewers`, `split`, `visual`, `approvals`, or `unattendedSignoff`.
Its reviewer judges that the change does not weaken how the project is reviewed, in place of the Human.
Any other edit of the config follows the review's usual file rules, and the trust check and the merge guard ask no sign-off for it.
The review step decides who signs that flow from the pull request's base alone, with merge trust's own rule.
An unattended merge also needs the default branch to hold both keys, so with only the base opted in, the merge still asks the Human.
The harness-config flow still needs the Human while either branch's review runs a command of the project's,
such as `review.planCommand`, an `exec` reviewer, or `review.visual`'s login or preview, and for a doc a flow's invariants cite,
the policy file among them when it is one.
The review, the review bot, the required checks, the team, and the author checks all stay.
Only a key both branches already hold lifts the sign-off, so the pull request that turns it on is refused and needs the Human.
A project run still cannot change `github.requiredChecks`, `conditionalChecks`, `ignoreCancelledChecks`, or `state.dir` by itself:
the `checks` row compares the checkout's lists and state folder with the default branch's, with the key on or off,
and the `paths` row reads the head's own config from GitHub and compares the same four,
so a pull request that changes one waits for the Human to merge it, from whichever checkout the gate runs.
That read counts only for a head that holds its base's tip, so the head's config is the one the merge leaves:
a head behind its base, or one the forge cannot compare, is refused until the base is merged in.
The compare names the base's tip by its commit SHA, the pull request's `baseRefOid`, never the branch's name.
The base can still move between that compare and the merge, so with `includePolicyFiles` on, turn on the branch
protection setting "Require branches to be up to date before merging" on the default branch, which GitHub holds at the merge.
A pull request that changes the pointer file `.aidrian.json`, or whose head keeps its config elsewhere than the default
branch does, is refused too, and so is a head whose pointer does not parse or names no usable folder.
So is a head whose pointer or config is a symbolic link, by its folder's listing at the head:
GitHub's file read follows a link inside the repository, while git and every later reader see the link itself.
`aidrian check` warns while the key is on in the checkout's config.

### When it is on

`aidrian pr auto-merge [PR] --check [--json]` reports it for one pull request: a number, `#number`, or URL, or by default the
current branch's. It exits 0 when on, 1 when off, and 3 on an error, such as a bad argument or a failed gh read.
Exit 0 merges nothing and reads no merge state: its line reads `auto-merge allowed for #<PR> at <sha>, this check merges nothing: …`.

Without `--check`, the command says whether the merge happened, so a session that reads it as the merge is never told
it merged when nothing did. When the gate is off, it prints and exits as `--check` does. When it is on, it reads the
pull request on GitHub once more, and its line says which of these holds; `--json` adds `merge`:

| `merge` | Exit | What holds |
| --- | --- | --- |
| `merged` | 0 | GitHub merged the pull request. |
| `queued` | 0 | GitHub's merge queue holds it, and merges it once the queue's checks pass. |
| `requested` | 0 | GitHub holds an auto-merge request for it, which merges it once its required checks pass. |
| `none` | 4 | Nothing merged it, and GitHub holds no request and no queue entry. The line names the command to run once every check passes, `gh pr merge <PR> --repo <host>/<owner>/<name> --<strategy> --match-head-commit <sha>`, with `--delete-branch` when `deleteBranch` is true, and `--json` adds it as `command`. With no `strategy` set, `command` is null and the line says to pick one, as the `pr-merge-when-green` skill does. |
| `closed` | 1 | It is closed with no merge. |

It never merges itself: the session runs that merge, through the [merge guard](hooks.md#merge-guard),
after the `pr-merge-when-green` steps waited for every check. The read must give the head the gate passed:
a head pushed in between exits 3, as does a failed read of the pull request.

It is on only when all of these hold, checked in this order; the last two, `closes` and `trust`, only in a session no Human attends.
With `--json`, `reason` names the first that fails and `why` says it in a sentence; both are `null` when on.

| `reason` | What must hold |
| --- | --- |
| `team` | `github.autoMerge.allow` is true on both the repository's default branch and the pull request's base. Both are read from GitHub as each branch commits them now, never from the checkout. So a branch cannot raise it, and the pull request that turns it on does not merge itself. |
| `checks` | The default branch names `github.requiredChecks`: a named check that has not reported is pending, so a draft's partial set of checks cannot read as ready. This checkout's `requiredChecks`, `conditionalChecks`, and `ignoreCancelledChecks` equal the default branch's as sets, committed or not: `aidrian pr checks` reads this checkout, so a branch cannot relax the lists, and a branch that changes workflows stays off (`paths`), unless `github.autoMerge.includeGuardedPaths` is true on both the default branch and the base. This checkout's `state.dir` equals the default branch's, since the review record is read from it. A working-copy config that cannot be read, or has errors, is off too. |
| `paths` | gh lists every changed file with its `changeType`: `gh pr view` lists at most 100, so past that the gate reads the whole list through the paged files route, which GitHub caps at 3000, maps each REST `status` to its `changeType` (`unchanged` reads as `MODIFIED`), and reads the head again after it. A list whose count is not `changedFiles`, that fails, holds an entry with no path or no known status, lists a path twice, leaves out a file the view gave, or was read while the head moved keeps it off, with that reason. None is `RENAMED`, since gh does not give the old path, and none is on this fixed list, unless `github.autoMerge.includeGuardedPaths` is true on both the default branch and the base (see the end of this row): `SKILL.md`, `CODEOWNERS`, OpenCode's `opencode.json` and `opencode.jsonc`, `.aidrian.json`, `.aidrian.local.json`, and `.banned-terms.local` at any depth, and `.claude`, `.codex`, `.aidrian`, `.github/workflows`, or `.github/actions` at the repository root or the project root, or anything under them. Every AI host's instruction files are on it too, not one host's: by name at any depth and in any case, `AGENT`, `AGENTS`, `CLAUDE`, `GEMINI`, `QWEN`, `WARP`, `CRUSH`, or `CONVENTIONS` then `.md`, with any infix, such as `AGENTS.override.md` or `CLAUDE.local.md`; `.cursor/`, `.windsurf/`, `.clinerules`, OpenCode's `.opencode`, and `.agents`, which OpenCode's adapter holds whole and where Codex keeps its plugin marketplace, each a file or a folder, and `.cursorrules` and `.windsurfrules`, at any depth; and `.github/copilot-instructions.md` and `.github/instructions/` at the repository root or the project root. These instruct AI sessions or decide CI, and a review of the change may not read them as behavior. So do the knowledge docs the start hook loads into every session, which differ per project: the gate reads the default branch's knowledge folder beside the `config.json` it located, and each `.json` index in it, by the knowledge reader's own rules. It refuses each bucket's `always` docs, compared ignoring case, and any file in that knowledge folder, since its indexes decide what loads. A bucket's other docs are not refused, since the start hook does not load them. No knowledge folder on the default branch means no docs; a folder or index the gate cannot read, or an index the reader rejects, keeps it off, naming it. The plugin's own code that decides auto-merge is on the list too, so with that key off the gate never approves a change to itself. Under `plugins/aidrian/`: `bin/`, `scripts/`, `hooks/`, `lib/forges/`, `lib/rules/`, `lib/review/`, `lib/hosts/`, `lib/trackers/`, and every other module in `lib/` loaded by the module each `bin/` script starts, by `aidrian pr`, by the gate, by its review, or by a hook, such as `cli.mjs`, `knowledge-cli.mjs`, `pr.mjs`, `pr-auto-merge.mjs`, `project.mjs`, `config.mjs`, `hook-io.mjs`, `usage.mjs`, and `transcript.mjs`, with the `.json` table of the same name, such as `finding-disposition.json` (`GUARDED_PATHS` in `lib/project.mjs` lists them all). The agents that review are on it too, generated and as sources: `agents/`, `codex/`, `agents-src/`, `providers/`, and `agent-addons/`. So is `skills/`, whole, since a `SKILL.md` sends a session to its `references/` and `steps/` files. So are the OpenCode bridge, `opencode/`, and the package manifest that names it, `package.json` at the plugin folder's top. So are the plugin manifests `plugin.json` and `.claude-plugin/plugin.json`, and the marketplace manifests `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` at the repository root. So is the optional `aidrian-mod` plugin's folder, `plugins/aidrian-claude-mod/`, whole, since it picks and runs the `aidrian` binary. In the plugin's own repository alone, `scripts/version.mjs` at the repository root keeps it off too, since that release script runs in the release job that holds the write token; another project's file at that path is its own, and is not refused. A test walks from the module each `bin/` script starts (`cli.mjs` and `knowledge-cli.mjs`), `pr.mjs`, the gate, its review, and the scripts in `hooks.json`, and fails on a file off the list or a load it cannot follow, so a new import, `bin/` script, or hook cannot fall outside it; a second walk from every module on the list fails on a file one of them loads that is off it, as `project-preflight.mjs`, which `project-run-cli.mjs` loads. The modules behind the other `aidrian` subcommands, such as `check.mjs`, `lint.mjs`, `worktree.mjs`, and `report-*.mjs`, are not on the list, but `project-run.mjs`, `project-run-cli.mjs`, and `project-stops.mjs` are: they decide which session may start a [project run](#project-run), which issue it starts, and what an issue whose merge stopped does, so a pull request that auto-merged itself cannot change them. For a project below the repository root, the setting is read from its own folder, and no file may be outside that folder, since [its review does not cover those](review.md#paths). With `github.autoMerge.includeGuardedPaths` true on both the default branch and the base, read from GitHub like `allow`, the fixed-list refusal and the start hook's knowledge refusal are skipped, but never for a policy file: `.aidrian/config.json` at any depth, `.aidrian.json`, `.aidrian.local.json`, and the `.aidrian` entry itself stay off, with their own reason. The count, rename, change-type, and project-folder refusals of this row stay too. With the key on or off, no file is one of the files the gate reads its policy from, including a folder `.aidrian.json` names: the pointer file and the `config.json` it located, on the default branch and on the base, compared ignoring case. The one exception: with [`github.autoMerge.includePolicyFiles`](#auto-merge) true on both branches too, neither the policy files nor the files the gate read its policy from are refused. Then the gate and the merge guard refuse, in this order: a change to the pointer file `.aidrian.json` at the project root; a head that is behind its base, by the forge's compare of the base's tip by its SHA with the head, or that the forge cannot compare, since the merged config would not be the one checked; and a head whose own config, read from GitHub at exactly the head, sits elsewhere than the default branch's, does not keep its `github.requiredChecks`, `conditionalChecks`, and `ignoreCancelledChecks`, as sets, and its `state.dir`, or cannot be read whole. The head's pointer is read strictly, so one that does not parse or names no usable folder refuses rather than falling back to the default folder. The pointer and the config must each be a regular file at the head, by their folder's listing there, where GitHub names a link `symlink` and never follows it; a listing that fails refuses, and so does one of 1,000 entries or more, GitHub's cap, which may leave the file out. The `checks` row compares only the checkout, which may be the unchanged base. Turn on "Require branches to be up to date before merging" with the key, since the base can move between the compare and the merge. |
| `local` | This machine's setting is on, or it has none and the default branch's `github.autoMerge.default` is `"on"`. |
| `author` | The pull request's author is the gh user. |
| `outsider` | Every issue comment, review, and inline comment on the pull request has the author association `OWNER`, `MEMBER`, or `COLLABORATOR`, or is by the default branch's `github.reviewer` bot. Any other bot, such as a CI or preview bot that comments, counts as an outsider. |
| `review` | Nobody's latest review requests changes, and the review decision is not changes requested. This machine's [review record](review.md#the-record) holds a `received` review of exactly the current head, and nothing is owed. There is no looser mode: no record, a review of an earlier head, an owed review, or a waiver above `low` through an accepted residual, on any pass record, keeps it off, also after the waiver ends, until the body no longer lists it and the review of the current head weighed it again: the pass that raised the finding, as the finding index names it for the finding the ruling names, ran on exactly that head over the finding's file and carries it as ended. Another pass, such as a cross pass or a slice over other files, or a slice result reused from an earlier head, proves nothing, and a waiver with no ruling id holds. The gate then reads the pull request's body at the head, once, under the default branch's `github.pullRequest.residuals.section`. A body item that is the residual's text, or names the finding as the review pass reads a residual line (the anchored residuals of [review.md](review.md#reviewers): its title, a colon, and a reason, over the same raised findings), still lists it, whatever kept it from the pass input, such as the residual limit. A body read that fails, or a head that moves during it, is an error (exit 3). The hold keys on the finding's [id](review.md#finding-ids), so a listing of the same title and file as fixed ends nothing. A `none_needed` record of exactly the current head counts too, with nothing owed, only when all of these hold. Its plan's reasons are exactly "only files that cannot change behaviour", at depth `none`, so any other reason, an extra one such as a rule's, or a record an older plugin wrote with no reasons, waits for the Human. [`github.autoMerge.unreviewedPaths`](#auto-merge) is a non-empty list with no error on both the default branch and the base, and each lists every changed file, from the project root. Every changed file in the paths check's whole list is added, modified, or deleted (never `CHANGED`, a type change, nor `COPIED`); is one the default branch's [`review.nonBehaviour`](review.md#rules), its own or the built-in list, names, and not one its `review.ignore` names, since no review read it, with no error anywhere in its `review` group; and ends in `.md`, `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.avif`, or `.ico`, whatever the lists say. Whatever the team lists, these stay off: a file on the `paths` row's fixed list, which holds every host's instruction files, at the repository root or the project root, even with `github.autoMerge.includeGuardedPaths` on; a knowledge doc the start hook loads, or a file of its knowledge folder, as the `paths` row reads them, with the key on too, and knowledge the gate cannot read; a path with a folder or file name that starts with `.`, which covers every host's folder, such as `.github/prompts/`, `.kiro/`, and `.changeset/`; and a test file, fixture, or golden file: a path the review's test-file patterns match (`*.test.*`, `*.spec.*`, `*_test.*`, or a `test/`, `tests/`, `__tests__/`, or `spec/` folder), or one under a `fixture`, `fixtures`, `__fixtures__`, `testdata`, `test-data`, `golden`, `goldens`, or `__golden__` folder. Every list is read from GitHub as the branches commit it now, never from the head or this checkout, so a pull request that widens a list gets nothing from it. Last, every changed file still at the head is a regular file there. The forge's changed-file list gives no file mode, so the gate reads the head commit's tree, one folder at a time. It refuses a symbolic link (mode `120000`), which a static server or site builder may follow to a file it should not publish, a submodule (`160000`), any other mode, a file the tree does not hold, and a tree it cannot read whole. A deleted file is not looked up. Beyond the two branches' config files and the knowledge the `paths` row read, the route reads only that tree. |
| `closes` | Only for a [project run](#project-run)'s issue session, one whose unattended mark names the run's issue: the pull request's title, body, and every commit message name no issue but that one after a closing word, as GitHub and a tracker's forge integration read them: `close`, `fix`, `resolve`, and `complete`, in each form, followed by a list of `#12`, `owner/name#12`, an issue link, or tracker keys such as `ENG-12`. The title names no key but the issue's own even with no closing word, since Linear links an issue a title names, and may move it at the merge. A token counts as a tracker key only when its prefix is a team key the run knows: the issue's own, the snapshot's `teams`, every team of the tracker workspace as the driver read it at init, and the teams of the run's issues. So `utf-8`, `SHA-256`, and `e2e-2` are none while no team is so named. A snapshot with no `teams` knows only the run's own teams, and a key of any other team is not seen: a named residual. A key a hyphen joins to more text, such as `ENG-9-export`, counts. Any white space separates a closing word from its first reference, line breaks included, and separates the rest of a list but a line break, which ends it; a key of a team the run does not know, and a link to another site, are passed over, and one longer than 50 references keeps it off. A merge would otherwise close those issues too, behind the run's back. The gate reads the pull request at exactly its head, then its commits, and a list shorter than its count, which GitHub caps at 250, keeps it off; a head that moves during the read is an error (exit 3). A mark that is pending or cannot be read names no issue, and a run whose snapshot cannot be read knows no team, so any reference keeps it off. Text that names an issue in the body with no closing word, such as `Refs ENG-9`, does not count. The [merge guard](hooks.md#merge-guard) holds the merge itself to the same rule at the moment it runs, with the merge commit's own subject and body. |
| `trust` | Only in a session no Human attends, one with an [unattended mark](handoff.md#the-background-route), or a project run's driver: the record is this machine's word, which a project run's confined session can write, so the merge also needs [merge trust](review.md#merge-trust), the default branch's `github.reviewer` bot's passing verdict on exactly the head, read from GitHub in one more call, and the Human's sign-off from the sign-off store of every flow the record or the changed files ask for, on that head. With no bot set it stays off, and says to set one. `--json` adds `trust`, `bot` or `signoff`, which half is missing, and the plain line names both: `auto-merge off for #<PR> (trust: bot): ...`. With `signoff`, it adds `flow`, the first flow whose sign-off is missing, and `signoffClass`, `security` when any unsigned flow of the default branch has an id that holds the word `security` or a `require` that names `agent:security-engineer`, else `product`. A session the Human attends skips this row. |

`strategy`, `deleteBranch`, `deleteWorktree`, and the check lists come from the default branch only.
The base counts only for `allow`, `includeGuardedPaths`, `includePolicyFiles`, and `unreviewedPaths`.
So a checkout whose lists differ from the default branch's does not auto-merge, including one behind them until it catches up.

### What a run does

The `pr-review-loop`, `orchestration`, and `autopilot` skills run the `pr-auto-merge` skill, only after that same run marked the draft ready.
`pr-auto-merge` stops unless this run marked the pull request ready and the command, with `--check`, exits 0,
and otherwise reads `pr-merge-when-green` and follows its steps as an unattended run.
When the command refuses because the pull request changes a path it never merges, it has stopped before its author,
comment, and review checks, so the run's final report hands the pull request to the Human for review and merge, rated,
and the [merge hand-back check](hooks.md#merge-hand-back-check) sends back a turn whose reports leave it out.
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
- The `paths` list is fixed: in a project folder that `.aidrian.json` moves elsewhere, it refuses only the `config.json` the gate reads,
  not the knowledge beside it.
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

## Unattended waiver

It lets a session that runs without the Human merge a pull request whose review stopped at the round cap,
on the word of a fresh judge instead of the Human's answer to the merge guard's question, through the merge guard or
through [auto-merge](#auto-merge): with both switches on, any `aidrian pr auto-merge` takes a standing verdict, not only
one under `autopilot`. A verdict never stands in for the review bot: it waives only the findings of this machine's own
reviewers, and only once the bot passed the head. It never lifts a sign-off the Human owes: one found before any
verdict is read stops `aidrian pr auto-merge` as [merge trust](#when-it-is-on) does, `trust: "signoff"`, with its
`flow` and `signoffClass`. Nor does it lift the [`closes`](#when-it-is-on) check, which a waived merge meets first.

### Turn it on

Both switches must be on. The team allows it in `.aidrian/config.json`, committed on the default branch
and on the pull request's base branch:

```json
{ "version": 1, "github": { "unattendedWaiver": { "allow": true } } }
```

Each machine that takes part opts in with `.aidrian.local.json` in its main checkout, or, with the switch unset there,
follows the team's [`solo`](#solo):

```json
{ "github": { "unattendedWaiver": { "enabled": true } } }
```

The team value is read from GitHub, never from the working copy, so a pull request cannot turn it on.
The machine switch reads off when git tracks the local file or the file has any error, even with `enabled: true`,
read from a task worktree too: there the main checkout's file gets every check, whatever the worktree's own copy holds.
A subagent may not write it ([the config guard](hooks.md#agent-gates)).
`aidrian check` warns when the machine switch is on and the team's is not.
Set [`requires.aidrian`](#plugin-version) to the release that ships the key: an older plugin rejects it.

### What it covers

One case only: the review step stopped at the round cap (`round_limit`) on the very head being merged, with no
review owed, and every one of these holds on that head:

- Open findings of this machine's reviewers (the local and independent stages) are the whole cause of the cap. The
  review step keeps the cause on the record's outcome, and a verdict stands only on it: never on a flow left with an
  invariant violated, unverified, or unsigned, a deleted flow test, a failing flow check, the review bot's own round
  limit, or a pass of this machine that never reviewed the head; and never on a record from an older plugin, which
  keeps no cause. Every flow of the plan counts, whichever stage answers for it. When a fix was pushed that no round
  reviewed, the last reviewed round's whole cause, which the record keeps on that round, decides.
- Each of those findings is listed, of `medium` severity or lower, and no security finding: none `critical` or
  `high`, none marked as one, none from a security pass or the security reviewer. Findings only counted refuse, since
  each one's severity cannot be told. No accepted residual above `low` holds the record.
- No sign-off of the Human's is owed on the head: every flow the record names for the Human on that head, which it
  must name, every flow the forge's file list and both branches' configs may select, as
  [merge trust](review.md#merge-trust) reads them, and every flow the cap's cause names has a sign-off on exactly that
  head in the sign-off store. This holds attended or not. Auto-merge reports such a stop as merge trust does: reason
  `trust`, `"trust": "signoff"`, naming the flow.
- The review bot, the default branch's `github.reviewer`, passed exactly that head on GitHub, read from the review
  trail as [merge trust](review.md#merge-trust) reads it. With no bot set, nothing is waived.

The verdict binds to that head: a new push moves the head, and the verdict no longer covers it.
The merge guard takes it only for a merge that names the head: `gh pr merge <PR> --match-head-commit <sha>`.
[Auto-merge](#auto-merge) takes it in place of `received` when, beside the above, the verdict names its judge
(`--judge <agent id>`) and the recording session's [dispatch log](dispatch-log.md) holds that judge's dispatch, a
`code-reviewer`, between the cap and the verdict. Only a host whose hook writes that row confirms a judge: Claude Code
does; Codex does not, so on Codex no verdict stands for auto-merge and the gate exits 1. With `telemetry.enabled`
false no log is written, and the same holds. The merge guard asks the same of the verdict it takes, so a session that
skips auto-merge cannot merge on a verdict it recorded with no `--judge`. In a project run, the run must have merged
fewer than 3 pull requests on a verdict, counted by the verdicts that stand on each merged head; the merge guard holds
a run's sessions to that too, its driver among them.
Its JSON then says `"waived": true`.
The waiver lifts a denial; it merges nothing itself. A session no Human attends still meets every check of
[merge trust](review.md#merge-trust): the waiver changes only the `round_limit` stop.

### Before a judge rules

`aidrian pr waive <PR> --gate [--json]` exits 0 only when the waiver may run on the pull request's current head:
the round cap there, the team's `allow` on the default branch and the base, read through the forge, never the working
copy, this machine's switch, the open findings as above, the bot's pass of the head, no judge's verdict on that head
yet (one judge rules per head), a host that confirms a judge with telemetry on, no sign-off owed, and, in a project
run, its budget of waived merges and a pull request of the run's pinned repository. It also refuses a working copy
whose state folder is not the default branch's. Exit 1 says why; exit 3 is a read that failed.

At the cap, a session types no gate command: the review step runs the same gate and reports it.
At `round_limit` and at `extension_check`, the JSON of `aidrian pr review` carries `waiver`, `{ may, why }`.
Only with `may` true is a judge offered `land`: the check's own judge at `extension_check`, or one judge the step's `dispatch` names at `round_limit`.
With `may` true, the step's `record` takes `land` or `stop`, naming the judge:
`aidrian pr extend <PR> --verdict land|stop --reason "<evidence>" --head <sha> --judge <agent id>`.
At `extension_check`, its `record_extend` takes `extend`, with no `--judge`.
With `may` false, at `extension_check`, `record` takes `extend` or `stop`, and at `round_limit` no judge is dispatched.
`land` asks the same gate again, and is refused, writing nothing, whenever it refuses.
Both verdict commands take the pull request's number, never a URL, which exits 2.
`--repo` is a flag of `aidrian pr extend`; `aidrian pr waive` takes the repository the forge names for the number.
Neither takes origin in its place: when the forge cannot look the pull request up, both exit 3 and write nothing.
It then records the `waive` that `aidrian pr waive --verdict waive --judge` records, through the same code; `stop` with `--judge` records its `refuse`.
[At the cap under autopilot](review.md#at-the-cap-under-autopilot) has the details.
`aidrian pr waive` stays for a session a person attends.

A project run merges at most 3 pull requests on a verdict. The gate and `aidrian pr auto-merge` only count that budget;
the merge guard takes it at the merge itself, under the run's ledger lock, once every other check of the merge,
merge trust included, has passed: it counts again and writes a `waived` row for the pull request, or refuses the merge
once 3 are spent, so the sessions of issues that run in parallel never spend more between them. A merge the guard
refuses spends nothing. A taken merge counts even if the merge then fails after the guard let it run; one the ledger
lock or a read refuses is not merged.

### What it never covers

- A review still owed, such as a bot review that was asked for and has not answered.
- Any other outcome on the head: `blocked_quota`, `error`, `stuck`, `running`, `fix_required`, and the rest.
- A head pushed after the last review step. Run `aidrian pr review` on it instead.
- A finding of the review bot, a finding above `medium`, or a security finding.
- A head the review bot has not passed.
- Any other cause of the cap, or a sign-off the Human owes on the head.

With either switch off, or a cap the waiver does not cover, a session no Human attends is not asked to put a question
to anyone: the merge guard's denial says the session does not merge, files what the review left open as a follow-up
issue, reports the pull request stopped at its round limit, and stops, and it names both switches
([Merge guard](hooks.md#merge-guard)). The Human merges it later, or turns the waiver on for the next run.

### Example

1. The review of pull request #151 stops at the cap on head `abc1234` with `extension_check`, and its `waiver` says `"may": true`.
2. The session dispatches the check's judge with the `brief` the step printed, which offers `land`, and keeps the agent id the host returns.
   The judge rules that no extra round is worth it and that the change may merge with its open findings filed.
3. The session records that verdict, naming the judge's agent id:
   `aidrian pr extend 151 --verdict land --reason "<the judge's evidence>" --head <sha> --judge <agent id>`.
4. `gh pr merge 151 --squash --match-head-commit abc1234` passes the guard. Give the full SHA, as the step prints it.
   Under `autopilot`, the session merges only through the `pr-auto-merge` skill instead.

When the judge says no, the session records `aidrian pr extend 151 --verdict stop --reason "<why>" --head <sha> --judge <agent id>` and stops.
That records a `refuse`, so no second judge rules on the head.
The last verdict for a head counts, so a `refuse` withdraws an earlier `waive`, and a new push needs a new verdict.
`aidrian pr waive 151 --verdict waive|refuse` records the same entries for a session a person attends, `waive` only while this machine's switch is on.
The verdicts are kept in the [review record](review.md#the-record), and shown in the pull request's summary comment
when `review.record` posts the record there.

### Trust

A verdict is the session's word, not proof: a session with a shell can record one and merge under both switches.
The review record, the verdict, and the dispatch log all live in folders a project run's confined session can write.
Only the team switch and the review bot's pass of the head, both read from GitHub, are out of a session's reach.
For proof, protect the default and base branches with a required review from a second account,
as [Sign-off by the Human](review.md#sign-off-by-the-human) says.

## Solo

`solo: true` says one person runs the project. It turns on each unattended machine switch that `.aidrian.local.json`
leaves unset: the [unattended waiver](#unattended-waiver), `unattendedSignoff`, and `handoff.background`.
The team's own key for each still decides: `github.unattendedWaiver.allow`, `review.unattendedSignoff.allow`,
and `session.handoff.continue` resolving to `background`. So a solo project needs no local file.

It is policy, read only from the base branch. A command reads it from GitHub, as each branch commits it now:
on the default branch and, for a pull request, on its base too. The local ref of the default branch must say it too;
it may only refuse. A working copy that alone says `solo: true` turns nothing on, and a pull request that adds it
changes a policy file, which [auto-merge](#auto-merge) never lets through. With no pull request, as for the background
route, GitHub is read at the repository the `origin` remote names, so a subagent and an unattended session may not
change a remote or the local file ([agent gates](hooks.md#agent-gates)). Origin is read from the repository's own git
config alone, and must name one URL. A read that fails turns nothing on.
A local `off`, or a local file that git tracks or that has an error, always wins.

`solo` makes the default branch's content the switch: whoever can push to it turns the three switches on for every
machine that sets none. A solo owner protects the default branch with no bypass, so only a reviewed pull request
changes it. Set [`requires.aidrian`](#plugin-version) to the release that ships the key: an older plugin rejects it.
The [Full autonomy, solo](config-recipes.md#full-autonomy-solo) recipe sets it, beside every key of the full-autonomy
recipe and `projectRun.allow`.

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

`aidrian decisions residuals` reads `residuals.section` too, to set each residual against the decisions on record
([Accepted residuals against decisions](review.md#accepted-residuals-against-decisions)).
The review step reads it as well, and gives its items to exec reviewers as settled residuals ([Reviewers](review.md#reviewers)).
A project's own residual line must open with the finding's title and a colon, or only a `low` repeat settles.

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

## Public text

GitHub keeps the old text of an edited issue, pull request, or comment in a public edit history, and no API deletes it,
so detail that must stay private has to be stopped before the first post.
`github.publicText.patterns` lists case-insensitive regular expressions that the public text rule
([hooks.md](hooks.md#bash-rules)) holds every `gh issue` and `gh pr` create, edit, comment, close, and reopen, and `gh pr merge`, to:
the body, `--title`, the `--comment` of a close or a reopen, and the `--subject` of a merge:

```json
{ "github": { "publicText": { "patterns": ["\\binternal codename\\b"] } } }
```

The rule also reads the git-ignored `.banned-terms.local` when it exists, for words a tracked file must not name:
one case-insensitive regular expression per line, with `#` comments and blank lines skipped.
Add the line `.banned-terms.local` to `.gitignore` before you write the file; `aidrian check` fails while git would track it.
Its deny and its recorded row name only the file, which of the body, the title, the closing comment, or the merge subject
matched, and the line of the first hit, never the word or its pattern.
Private words hold on every call, one that names another repository included; the config patterns, and the refusal of
text the rule cannot read, follow the repository the call targets.
The rule is on when either source gives a pattern, and off with neither. It never looks up whether the repository is public: giving a pattern is the signal.
The rule reads the file from the project root and from the main checkout, and uses both when both exist, so a linked worktree needs no copy.
The rule reads the file only when it is a regular file of at most 64 KiB, so a link to one works and a pipe does not.
A line in the file that does not compile drops only that line in the hook, and `aidrian check` names its line number, never its text.
`aidrian check` reports a pattern that does not compile, and until it is fixed the hook reads the list as empty, so the session keeps running.
`AIDRIAN_ALLOW_PUBLIC_TEXT=1`, set in the Human's own shell, lets a call through.

Each run of whitespace counts as one space, so a phrase wrapped across lines matches; write a space in a pattern, not `\n`.
Keep patterns plain. All the patterns of one command, from both sources, share a time budget of 600 ms, each search at most 200 ms,
ended 2 s after the hook started: a pattern that runs out is dropped, as a bad line is, so a slow one checks nothing.
Private words run first, on every call of the command, so a slow config pattern never leaves them unchecked.

A pattern catches only obvious wording and is no substitute for writing rules only: rewrite the text as the rule or limit,
and keep the detail in the state folder. The [Bash rules](hooks.md#bash-rules) list what the rule does not read.

## Review plan

`review` decides how `aidrian pr review` reviews a pull request: its depth, its stages, the critical flows it holds
to their invariants, the reviewers a project adds, and the [visual capture](review.md#visual-review).
[review.md](review.md) describes every key but `review.productFeedback`,
which [personas.md](personas.md#a-pull-request-link-alone) and [Product feedback](#product-feedback) do.
Four machine settings live in `.aidrian.local.json`: the engine, `review.engine`, unless the project sets it here,
the visual capture's base URL, `review.visual.baseUrl`, `review.productFeedback.auto`, and `review.publish`, which may
only post less than the team's: `summary` `"counts"` and `inline` `false` ([Publishing](review.md#publishing)).

## Product feedback

`aidrian pr product-feedback` keeps one record per pull request of what its product feedback found, and says what a script
can check: whether any of it is still owed. It gives no approval, no sign-off, and no merge block, so `pr-auto-merge` and
`aidrian pr checks` read nothing of it. What it holds is marking a draft ready while feedback is owed: with `auto` on, the flows
run it after a draft opens and check it before marking ready ([review.md](review.md#product-feedback-in-the-rounds)), and the
[ready hold](hooks.md#ready-hold) refuses a ready while `status` exits 2. `AIDRIAN_ALLOW_UNHELD_READY=1`, set by a person in
their own shell before the session, lifts that hold.

```json
"review": { "productFeedback": { "auto": false, "files": null, "maxPersonas": 2, "allWidths": null } }
```

and, in `.aidrian.local.json`:

```json
{ "review": { "productFeedback": { "auto": false } } }
```

The second block may set only `auto`. Local wins both ways, so one person can opt in or out, as `github.autoMerge` lets a
machine choose. It comes only from the main checkout's file: a worktree's copy is not read, a copy git tracks is ignored with
an error, and a broken file or an invalid value reads as unset, so the team's value holds, never `false`. A subagent may not
change it: [the config guard](hooks.md#agent-gates).

### Walking every width

`allWidths` is off by default. Set it to `{ "files": [...] }`, globs or `re:` patterns relative to the project folder:

```json
"review": { "productFeedback": { "allWidths": { "files": ["src/app/**", "re:^src/components/"] } } }
```

When a pull request changes a listed file, the persona walk does each in-scope browser task once per width of
`review.visual.viewports`, each width once, in place of the persona's own width. A task walked another way, such as an API
call or a CLI, has no width and is walked once. `aidrian pr resolve` decides it and prints the widths as
[`walk_widths`](personas.md#a-pull-request-link-alone), `[]` when no listed file changed.

- It is read from the working copy, as `maxPersonas` is, not from the default branch and the base, as `auto` and `files`
  are: it shapes a walk, and decides nothing a pull request owes. `.aidrian.local.json` cannot set it.
- It needs `review.visual.viewports`. Without them it has no effect, and `aidrian check` warns:
  `review.productFeedback.allWidths is set, but review.visual lists no viewports, so it has no effect`.
- A file list gh cuts short, a rename, or a file with no change type counts as a match, as for `status`.
- The cost: the walk count is personas x tasks x widths. With the default 2 personas, 3 tasks each, and 3 widths, that is
  18 walks in place of 6. `maxPersonas` still caps the personas.

### The commands

```sh
aidrian pr product-feedback status <PR> [--json]
aidrian pr product-feedback record <PR> [--report <file>] [--items <file>] [--none-found --read-by product-manager]
aidrian pr product-feedback answer <PR> <item> <decision> [--by <who>] [--reason <text>] [--issue <key>] [--url <url>] [--doc <path#section>]
aidrian pr product-feedback recheck <PR> <item> confirmed|reopened [--note <text>]
aidrian pr product-feedback post <PR> --body-file <file>
aidrian pr product-feedback items <PR> [--json]
aidrian pr product-feedback diff <PR>
```

`<PR>` is what `aidrian pr resolve` takes, held to the checkout's remotes the same way. `status` exits 0, clear, with a reason;
2, owed, with what is owed; and 3 on an error. Each other command exits 0, or 3 with the record untouched.
`items` lists every item of the record and where it stands, whatever `auto` says, with `recorded: false` when there is no record;
`--json` gives `head`, gh's head now; `recorded_head`, the head the record was written at, which the comment names; `limited`; and each
item's id, title, kind, source, `audit_key`, `found_at` head, `state`, decision, re-check with its own head, and the command that answers it.
`diff` writes the pull request's diff, read with `--repo <host>/<owner>/<name>`, to `diff.patch` beside the record, a path held
inside the state folder, and prints that path, alone, on stdout: the [pr-product-feedback](personas.md#product-feedback-on-a-pull-request) skill's
product-manager read takes it, since that agent runs no shell.
When the forge refuses the diff as too large (GitHub's `PullRequest.diff too_large`, past its size limit), and only then,
`diff` reads the pull request's base and head commits from the forge and writes
`git diff --no-relative --ignore-submodules=none --submodule=short <base>...<head>` from the current checkout instead, the merge base to the
head, as the forge shows a pull request: every changed file by its path from the repository's top, even from a project in a
subfolder with `diff.relative` set, and every changed submodule pointer, even one whose `submodule.<name>.ignore` is `all`. A shallow checkout
(`git rev-parse --is-shallow-repository` prints `true`) is refused first, with nothing written and nothing fetched, whether
or not its diff would succeed: its merge base may be missing or an older one, so the diff could fail or be wrong. The
refusal names the fix: `git fetch --unshallow '<remote>'` in that checkout, the remote's name shell-quoted, and then `diff`
again, or `diff` from a full clone, since a clone that fetches one branch alone may still lack the base after that fetch.
A probe that fails, or answers anything but `true` or `false`, exits 3 with git's own error, and nothing is fetched.
A commit the checkout lacks is fetched first,
`git -c fetch.bundleURI= fetch --no-tags --no-prune --no-write-fetch-head --refmap= <remote> <sha>...`: the commit ids are
the only refspecs, with no destination, the empty `--refmap=` applies none of the remote's configured `fetch` refspecs, and
the empty `fetch.bundleURI` imports no bundle and its `refs/bundles/*`, so no ref is written or pruned and `FETCH_HEAD`
stays as it was.
`<remote>` is the one whose fetch URL in `git remote -v`, the list the remotes check reads, names the pull request's
repository, else `origin`; that list applies `url.*.insteadOf` and holds a remote set in any config scope.
git runs from an argument list, never a shell, under the plugin's hardened git settings. A line on stderr says the diff came
from this local fallback, showing the diff command with its flags and both commits, and naming any commit it fetched. Nothing downstream caps the diff, so the local one is written
whole, as the forge's is; one past 64 MB, as with any gh read, exits 3. Any other forge failure, and a local diff or fetch
that fails, exits 3 with nothing written, so the feedback stays owed.

| `status --json` `reason` | Exit | Means |
| --- | --- | --- |
| `off` | 0 | Neither branch turns it on, and this machine does not. |
| `opted_out` | 0 | A branch turns it on, and this machine's `auto` is `false`. |
| `no_file_lists` | 0 | `auto` is on with neither list, which is a config error too. |
| `not_user_facing` | 0 | No changed file matches a branch's `review.productFeedback.files`, else its `review.visual.targets[].files`. A file list shorter than `changedFiles`, or one holding a rename or a file with no change type, counts as user-facing. |
| `nothing_open` | 0 | The record holds nothing owed. |
| `state_dir` | 2 | The working copy's `state.dir` differs from the default branch's, and the record is read from it. |
| `not_run` | 2 | No record, one whose `repo`, `pr`, or `version` does not match, or an empty one with no report and no read named. An unparsable one exits 3. |
| `unanswered` | 2 | An item has no answer that counts. `owed` lists each item's id, title, and the command that answers it. |
| `not_rechecked` | 2 | What is left is a fix-now with no re-check confirmed at a different head. |

`status` takes `auto`, `files`, and `review.visual.targets` only from GitHub, at the default branch and at the base, with the
project's folder as its prefix: `auto` is on when either says true, and the file lists are the union of what each branch gives,
its `files`, else its targets' files. No working copy value counts, so a branch cannot raise or lower the team's value or
narrow its lists. A branch with no config file has none to give, but `status` exits 3 on one that does not parse, has another
version, or has an error under `review.productFeedback`, other than `auto` with neither list. It also exits 3 on an `.aidrian.json`
that does not parse, names no usable folder, or names a folder with no config, and, once on, on a branch whose `files` is null and
whose `review.visual` its checks dropped, since that branch's file list is then unknown.
`status` reads a record whose `report` is null like any other, once it holds items or names its read.

Before any gh call, `status` reads git alone, as the [ready hold](hooks.md#ready-hold) does: the main checkout's local `auto`,
then `review.productFeedback.auto` committed at `origin/HEAD`, `origin/<git.defaultBranch>`, and `origin/main`, each found through
its own `.aidrian.json`, and at `HEAD`, which can only raise. When the local `auto` is false, or every one of those refs says off,
no ref's config is missing, and the state folder holds no `product-feedback/`, it is clear with `off`, or `opted_out` when the
local `auto` is false and a ref says on, with no gh call; `head` is then null.
Anything else, a default branch git does not name on origin included, goes to GitHub, which decides as above. Off is the one
answer that does not go to GitHub, which is why it needs every one of those refs off and no record folder.
Its `why` then says git's origin refs say off, not that the team chose it, or, when the local `auto` is false, that this
machine opted out. Two limits follow, for `status` and the ready hold alike:

- Origin refs fetched before the team turned `auto` on read as off, with no gh call, until a fetch, and so do a fork's stale
  `main` and a clone that never fetched.
- A session that rewrites those refs and `HEAD` to say off turns `status` and the ready hold off. A follow-up keeps the
  session-start answer instead, as the session's gates do.

### With the key off

A project without `review.productFeedback.auto` runs nothing of the feature unasked, and its hooks cost it nothing, save in
two cases it keeps as limits:

- A project that once ran the `pr-product-feedback` skill on demand keeps `<state>/product-feedback/`, so git no longer reads
  off there. Each ready call then pays the [ready hold](hooks.md#ready-hold)'s gh calls, up to its 3.5-second deadline, and
  two readies in one command, or a ready fed to a shell, are refused.
- While another project on this machine keeps product feedback, the [answer rule](hooks.md#bash-rules) refuses a `--by human`
  call whose folder or project it cannot read, such as `cd "$D" && aidrian audits record … --by human` or one with
  `--project "$P"`. It refuses an aidrian call it cannot read beside another, such as `aidrian $X && aidrian $Y`, in every
  project.

### The record

`record` writes `<state>/product-feedback/<owner>/<name>/pr-<n>/record.json`. It reads the repository, the number, and the head
from `gh pr view`, never from an argument, and holds `version`, `pr`, `repo`, `head`, `limited`, `report`, the sidecar's report file or
`null`, `read_by`, `comment_id`, `recorded_at`, and `items`. The answer rule reads `recorded_at`, which only `record` writes.
`limited` is whether the pull request comes from outside the team, by the reads and the rule of `aidrian pr resolve`; `record`
exits 3 and writes nothing when gh does not say. The [product feedback post rule](hooks.md#bash-rules) reads it.
A persona item also keeps `adopted_at`, when `record` adopted its key.

`--report` names the run's report in the audits folder, and `--items` a JSON list. A persona item is `{ "audit_key": "<report>#<id>" }`,
as `aidrian audits pending --json` prints it; a product-manager item is `{ "source": "product-manager", "title": "...", "kind": "..." }`.
A run names itself: with no report and no items, `record` refuses, and names the read to run, unless the run says so with
`--none-found --read-by product-manager`, which the record keeps as `read_by`. A report with no findings counts as a run.
A title is kept on one line, with no control or format character, at most 200 characters, and `record` refuses one under 8,
which a question to the Human could not name apart from its other words.
An item is sorted into a kind, taking the first that fits:

- `choice`: anything the docs do not settle, or any persona finding whose owner is `product-manager`.
- `minor`: `polish`, an `opinion`, or a consideration.
- `defect`: an observed persona finding of severity `blocker` or `friction`, or a `product-manager` gap where the docs do settle the behaviour.

`record` derives a persona item's kind from the sidecar, and the session supplies it only for a `product-manager` item. It refuses
an `audit_key` the sidecar lacks, a sidecar finding left out, a sidecar of another pull request, and a sidecar whose `head` is
not the head gh reports now. It keeps every earlier item, and never lowers a kind. Each item keeps the `head` it was found at,
which a re-check's head must differ from. `Not reached` lines and doc gaps are no items, and never hold.

A later run matches a new finding to an open item through its sidecar's `carried_forward`: by `carried_from`, the earlier
key, on the persona item, or else by the same title. A carried key no finding takes is refused, never a duplicate. The item keeps
its id, takes the higher of its kind and the new finding's, loses any re-check, and points its `audit_key` at the new finding.
Its decision is copied under that key through the triage record, so the Audit inbox and `status` read the same decision, unless
the key already holds one, which is never overwritten.

A decision recorded before `record` adopts its key needs asking again: a `by: human` entry already there, which `record` did not
copy, leaves the item owed, as `unasked_decision`, a copy of its fields with the time it was written, the `at` that `answer` and
`aidrian audits record` set. Any later write has another time, so it replaces the old one and the item can count, and a carry's copy
keeps the time, so a copy of such an entry stays owed.
A settled verdict keeps the time of the `decided --by human` that settled it. One settled with no time, or at a time not after the
item's `adopted_at`, still holds, whatever decision overwrote the entry since: `answer` refuses a fix-now on it, `recheck` refuses to
re-check one, a session's fix-now written to `triage.json` does not count, and `status` names `decided --by human` until the Human
gives one after adoption. A carry that copies the item's own decision keeps the item's `adopted_at`, since the copy is that decision;
one onto a key that already holds a decision takes the time of the carry. `answer` stamps its time after `adopted_at`, by a
millisecond when the clock reads the same or earlier. An item of an older record, with no `adopted_at`, is held by a settle whose time
is that of its `unasked_decision`.

### Answers

A persona item's decision lives in `triage.json` under its `audit_key`, with its `by`, so one recorded through `aidrian audits record`
after `record` counts the same. The Audit inbox reads that file alone, so it can read triaged meanwhile for an item `status` still owes.
A `product-manager` item keeps its own `answer`.
An item is answered when it has a final decision from the [triage vocabulary](personas.md#triage), plus one more rule, applied when it is read:

| Kind | What counts | Extra rule |
| --- | --- | --- |
| `defect` | `fix-now` from anyone; any other final decision only with `by: human` | `fix-now` counts only once re-checked as confirmed at a different head |
| `choice` | a final decision with `by: human`; `decided` alone is not final and stays owed | `fix-now` counts only once re-checked as confirmed at a different head |
| `minor` | `defer` from anyone, with a reason; any other final decision only with `by: human` | none |

A decision with no `by` is the session's. `answer` checks this table and refuses what would not count; a held item takes the
Human's `decided` first, and `status` names that command for it. A `fix-now` re-checked as `reopened` keeps its decision and is owed
through its re-check. `--by human` is held to the Human's own word by the [answer rule](hooks.md#bash-rules).

### Post

`post` is the only path that posts, and a pull request body or comment never receives a local path. Its `--body-file` must really be
inside `<state>/tmp/`, a symlink resolved. The comment opens with a marker, `<!-- aidrian-product-feedback: pr=<n> repo=<owner/name> -->`.

Before any write, `post` exits 3, naming the kind of match and never the value, on the body as written, and on a copy with format
characters stripped and numeric entities and `%xx` decoded. It refuses:

- A path in the state folder, the home folder, or the checkout, and `~/`, `~\`, `$HOME`, or `%USERPROFILE%`.
- An absolute local path: one that starts at a root a machine or runner holds, such as `/Users/`, `/home/`, `/tmp/`, or
  `/github/workspace`, a drive letter, `file:`, `//home`, `/c/Users`, `/cygdrive`, `\\server`, or `\Users`.
  A product route such as `/settings/team` or `/app/bookings` passes. A checkout that sits at such a path is still caught by its value.
- `localhost`, and a loopback, link-local, or private address: `[::1]`, `127.x`, short forms such as `127.1`, `169.254.`, `*.localhost`,
  `host.docker.internal`, `*.local`, `10.x`, `172.16-31.x`, and `192.168.x`.
- A host or account `product-access` names, a named host's subdomains included, a templated first label such as `<pr>`, `{pr}`, or
  `pr-*` read as a pattern, and the value of any variable it names.
- An email address, a secret shape (`gh[pousr]_`, `github_pat_`, `sk-`, `sk_live_`, `sk_test_`, `AKIA`, `ASIA`, `xox[abprs]-`, a JWT,
  a private key block), and a report or screenshot path.

It also exits 3 on any knowledge error that names an index file, since a `product-access` doc may be behind it. A project with no such
doc still posts.

It neutralizes `@` mentions, in any spelling but the `/@name` of a plain `http` or `https` URL, images, and any `<!--` but the one
marker it adds itself. A later run edits the record's `comment_id` only after a read confirms the gh user wrote it and it still
opens with the marker; otherwise the last comment by the gh user that opens with it; otherwise it posts a new one.
A marker from any other author, or one a hand-written comment quotes, is ignored, and nothing is read back from a comment into the record.
A failed or refused post leaves the record and reports the failure.

`review.approvals.allow`, `false` by default and read from the base branch, lets a named approver's GitHub review of the
head close a flow invariant no reviewer could verify: [Sign-off by the Human](review.md#sign-off-by-the-human).
An invariant of a flow's list names its approvers, GitHub logins, in `approvers`; `aidrian lint review` fails a name
that is not one. Each machine turns the path on too, with `"reviewApprovals": "on"` in `.aidrian.local.json`;
`"off"` or no setting keeps it off. Like the auto-merge switch, it counts only in the main checkout's untracked file,
and a subagent may not write it ([the config guard](hooks.md#agent-gates)).

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
`aidrian pr attest <PR> --pass agent:<name> --head <sha> --reviewer <who> --findings-file <the file the step's record names>` (an agent pass
records its findings one by one; the counts form above stays accepted), is that record too, so the bot request needs no second
attest; so is an agent pass its flows merged into, `agent:<name>:<flows>`, when it read the whole diff. A pass over a
flow's or a slice's files alone, the cross pass, and an engine pass do not count.

`--head` takes a commit's full SHA or a short one, and `attest` records its full SHA.
`attest` writes the record to the [state folder](project-folder.md#local-state), which every worktree shares, one file a
repository and number, as the [review record](review.md#answering-in-the-session) is: `reviews/pr-<N>-<owner>--<name>.json`,
whichever remote is origin, so a review of one repository's pull request never counts for another's. A record under the
old name `reviews/pr-<N>.json` counts for the repository it names, or for origin when it names none; when both files
exist, as when a session on an older plugin attests under the old name, the one recorded later counts.
It prints a marker:
`<!-- aidrian-review: pr=<n> repo=<owner/name> head=<sha> ... -->`. A request that carries the marker for its own pull request
and repository also passes, so a new session or machine need not review again.
`attest` files the review under the pull request's repository: `--repo`, else the one `gh pr view` names, gh's default
(the upstream in a fork checkout), else origin, so it works offline.

- `aidrian pr await-review --request` checks the gate before it posts. It ends with `review_required`, exit 5, and posts
  nothing, or puts the marker in its request.
- The Bash rule refuses `gh pr comment`, `gh issue comment`, `gh pr review`, and a `gh api …/issues/<n>/comments` POST whose
  body asks `@codex review` outside code and quotes, and `gh pr create --reviewer` or `gh pr edit --add-reviewer` naming `github.reviewer`.
- A hook on the GitHub MCP comment tools refuses the same body, on Claude Code on
  [those of a GitHub MCP server a plugin installs](providers/claude-code.md#a-github-mcp-server-from-a-plugin), and on Codex on
  [the GitHub connector's comment tools](providers/codex.md#github-through-the-app-connector).
- A request to a repository any of this checkout's remotes names is gated, origin or not, and only a review of that
  repository counts: one of `origin#5` is no review of `upstream#5`. A request to a repository no remote names passes.
  A request whose pull request number the rule cannot read is refused: name it.
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
| `opencode` | any non-empty string, accepted and read by nothing yet: no agent of this plugin runs on [OpenCode](providers/opencode.md#limits) | the same |

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
`session.handoff.continue` and `session.handoff.maxChain` came in a later release, so a project that sets either
sets `requires.aidrian` to that release: an older plugin rejects them as unknown keys.
`session.handoff.resumeTokens` came later still, and a project that sets it does the same.
Since the release with the [background route](handoff.md#the-background-route), an existing `mode: "auto"` config
with no `continue` hands off fully automatically: the brief, then a new session started in the background, with
nothing typed, on a host that runs that route, once the base branch has that config and the machine sets
`"handoff": { "background": "on" }` in `.aidrian.local.json`. Until the machine does, the handoff goes on by the
clear route, and the gate's `fallback:` line names that edit. `continue: "none"` keeps the earlier behaviour, a brief and the resume line.
[handoff.md](handoff.md#config) lists the old keys and where each went.
A project that adopts [`github.autoMerge`](#auto-merge), [`github.unattendedWaiver`](#unattended-waiver), or [`tracker`](#tracker) does the same,
since an older plugin rejects the key.

`.aidrian.local.json` needs no such floor. It is per machine and git-ignored, written once for the newest plugin while
older ones still run on the same machine, so a key the plugin does not read there, such as one a newer release adds, is
a warning, not an error: `aidrian check` prints `warning: .aidrian.local.json: unknown key "<key>"` and passes, the plugin
ignores the key, and the rest of the file applies as if it were not there. That holds at the top level, in every group,
and for a field inside a setting the plugin reads, such as `github.autoMerge`, `handoff`, `projectRun.forgeTokenKeychain`,
`review.visual`, or `decisions.unreviewed.pauseDomainAt`; an agent in `models` that this plugin does not ship is warned
and ignored too. `config.json` keeps each of them an error.
A known key with a bad value stays an error, and so does an unknown key in an agent's gates (`agents.<name>`),
since a misspelt `deny` would lift a gate. A misspelt machine switch is unset, so it follows the team's default or
[`solo`](#solo), and the warning names it.
A key that only `config.json` sets, such as `github.strategy` or `solo`, is unknown there too: warned, ignored, and the team's value holds.
A message that names a key as the team's, such as `"decisions.maxMode" is the team's`, or a `review.publish` key, stays an error.

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
| `tool` | The host's name, such as `Claude Code` or `Codex`, or `unknown` | The [host adapter](providers/adding-a-host.md) that claims the process | `Agent-Tool:` |
| `env` | `local`, `cloud`, or `ci` | `CLAUDE_CODE_REMOTE=true` is `cloud`; `GITHUB_ACTIONS` or `CI` is `ci` | `Agent-Env:` |

`commit` takes any of these fields. A commit carries a trailer as a `--trailer` option, or in its message's trailer
block: the last paragraph, past the subject, with only `Key: value` lines, as git reads it.
With `effort` listed, the subagent start hook tells a Claude Code subagent its `Agent-Effort:` trailer as a hint, from
the effort its start payload carries, else `CLAUDE_CODE_EFFORT_LEVEL`, where `auto` or `unset` gives no hint, else the
[`models`](#models) effort the dispatch takes, else its agent definition's `effort:`: the check still reads the transcript.
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
  and write no `hook_deny` row ([hooks.md](hooks.md#recorded-blocks)). A rule that keeps blocking one agent run for the same cause still becomes a lesson.
  The exception is the tracker write guard's [no-read refusal](#how-a-write-is-judged): with this key or `enabled` off,
  a session stuck on it leaves no row and no lesson, though the agent still sees each refusal.

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
- Each doc with no tag: a warning above `untaggedDocBytes`, when it is set. An agent reads such a doc whole once search
  finds it, so a project whose references grow can cap them too. It is `null` by default, with no cap.

Under the default `"enforce": "warn"`, the warnings print on stderr, and the check still passes. `aidrian check` prints the `always` total on its last line;
the warning below is one line, wrapped here:

```console
$ aidrian check
warning: docs/knowledge/engineering/sync-protocol.md: 41230 bytes, over knowledge.budgets.taggedDocBytes (24576); every route to
  backend reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it
ok: .aidrian (2 buckets, 8 docs)
state: /home/you/.local/state/aidrian/projects/notes-1a2b3c4d
budget: 2479 of 16384 always-doc bytes (engineering 2479, product 0)
```

### Enforcing the budgets

A warning lets a doc grow back past its budget, since nothing stops a push.
`"enforce": "fail"` makes each budget warning above an error, so `aidrian check` and `aidrian lint budget` exit 1:
a doc over its budget, and the `always` docs over `alwaysBytes`. A CI job or a pre-push hook that runs either then stops the push.

A project with docs over budget already pins them first, then turns `"fail"` on:

1. Under `"warn"`, run `aidrian lint budget --pin`. It writes `knowledge.budgets.baseline` in `config.json`, each doc over
   budget at its size in bytes now, such as `{ "docs/guest-crm.md": 29812 }`.
2. Set `"enforce": "fail"` in the same change, and commit both.

A pinned doc stays a warning while it is at or under its pin, and fails once it grows past it, so a pinned doc may only shrink.
A pin above its doc's size, or on a doc within budget or no longer indexed, is a warning to lower or drop it.
Under `"fail"`, `aidrian lint budget --pin` only lowers and drops pins. It never adds a pin or raises one, and it exits 1
naming each doc it left over budget. Pinning a new doc is then a hand edit to `config.json`, a decision a reviewer sees in the diff.
`--pin` pins only the team's docs, never those of a `.aidrian.local.json` source, and it writes nothing while a knowledge
index has an error, since a bucket it cannot read would lose its pins.

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

- On Claude Code, a Monitor call that runs a command is read as a Bash call, so `Bash` and `Bash(<prefix>)` patterns match it,
  and a `Monitor` pattern still does. When an `allow` list has a `Bash(<prefix>)` pattern, a Monitor command must start with one
  of them, as a Bash command must, so `"allow": ["Monitor", "Bash(git status)"]` lets only `git status` run through Monitor.
  A WebSocket watch stays Monitor; a bare `Bash` in `deny` covers it, and no `Bash(<prefix>)` pattern matches it.
  A PowerShell command is never admitted by a `Bash` or `Bash(<prefix>)` pattern in `allow`, only by `PowerShell`.
  In `deny`, every `Bash` and `Bash(<prefix>)` pattern blocks every PowerShell call, whatever its command, on every
  platform, since the gate cannot read a PowerShell command to tell what it runs. Claude Code itself turns the tool off
  for a Bash deny only on Windows with Git Bash installed. So on Windows without Git Bash, a `Bash` deny in `main` or `*`
  leaves the main session no shell tool: a recorded limit ([provider page](providers/claude-code.md#powershell-commands)).
- The gates are asked before the guards below, which read a command's paths and globs, so a call a gate denies is
  denied before the guards read it. The guards then have a time budget from the hook's start, inside the hook's
  10 second timeout: a subagent's call they cannot finish reading in 7.5 seconds is refused, as is one of a main session
  no Human attends or a project run's driver, and an attended main session's runs after 2.5 seconds. A call that is no shell
  and writes no file, such as a Read, runs past the budget for every session, as no guard refuses it.
  A PowerShell command of more than 512 words, counting each case, and a Bash call of more than 1024 write targets,
  of a subagent, a main session no Human attends, or a project run's driver, are refused too, as the guards read no more
  ([hooks](hooks.md#agent-gates)).
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
A write through a link to one of them counts, also a link whose file is not made yet (`out/alias -> ../.aidrian.local.json`).
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
With no candidate, no end user takes part, and the report warns about it.
The question to the Human names the persona, or says no end user took part.
To add a persona, add its doc: see [Personas](personas.md).
`aidrian-knowledge route personas` lists the docs tagged `personas` before a run starts.

### Automatic product quorums

`aidrian quorum route` says what happens to one product decision, so a session need not ask the Human to start a quorum on a hard call.
It starts nothing itself: it prints the route, as [project-folder.md](project-folder.md#local-state) describes.
It reads all three keys from the base branch's tip, as `resolve` reads `decisions`, so a branch cannot raise them.
No readable base, git absent included, counts as off, and so does an error under `quorum.product` at the base.
Only a `product` or `ux` call routes: under any other domain, `resolve`'s answer stands, as with `autoStart` off.

The deciding agent answers five yes/no questions, each from the decision in front of it, as `--hard`, in this order:

1. **Open options:** are there two or more options that differ in what a user gets, each still viable after reading the project's docs?
2. **No written answer:** with open options, does no doc, decision record, or committed data favour one option, so that the pick rests on an inference?
   With no open options, the answer is no.
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
At or above `secondLook`'s `minSeverity`, or with an unknown severity, the writer refuses until the ledger's `second_look` holds `sign_off: approved` from the agent `secondLook` names.
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

`aidrian check` warns when `approval` is `"review-later"` and the product and ux domains both resolve to `ask`, since review later could then never apply,
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
The `persona-audit-triage` skill runs `resolve` on a held finding's product decision, reports the answer, and always asks.

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
  `aidrian decisions list`, `set`, `undo`, and `residuals` read it from the working copy, as they read the docs;
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

## Tracker

`tracker` names the workspace, team, and project that MCP tracker writes belong to.
It is off by default, and `aidrian check` validates it.
`provider` names the tracker, and its [adapter](providers/adding-a-host.md#adding-a-tracker) knows the tools and fields,
so a project writes only what a person knows:

```json
{
  "tracker": {
    "enabled": true,
    "provider": "linear",
    "workspace": { "expect": "https://linear.app/acme" },
    "team": { "key": "NOTES", "values": ["Notes"] },
    "project": { "values": ["Notes launch"] }
  }
}
```

This is what the `harness-setup` skill writes for Linear, with `project` only when the Human names one.
`linear` is the one provider that ships. For it, the adapter gives:

- `readTools` and `writeTools` on the known server names: `mcp__linear__` and `mcp__linear-server__` on any host,
  `mcp__plugin_linear_linear__` and `mcp__claude_ai_Linear__` on Claude Code, and `mcp__codex_apps_linear__` on Codex.
  Each also comes in every host's spelling: Codex replaces a hyphen in a server's name, so `linear-server` also gives `mcp__linear_server__`.
- `get_workspace` as the read tool on each, and the write patterns `save_*`, `create_*`, `delete_*`, `share_*`, `unshare_*`,
  `update_*`, `merge_*`, `submit_*`, `resolve_diff_thread`, `retire_*`, `restore_*`, and `prepare_*`.
- `url` as `workspace.field`, `project` as `project.field`, `team`, `addTeams`, `setTeams`, and `leadTeam` as `team.createFields`,
  and `id`, `issueId`, and `issue` as `team.keyFields`.

`mcp__<server>__<tool>` is the [standard format](working-agreement.md#rules-for-every-change) for naming an MCP tool in permissions and config.
A server name, such as a plugin's `plugin_linear_linear` or a connector's `claude_ai_Linear`, is a host-specific value of `<server>`.
`prepare_*` counts as a write: those tools are the step before file bytes reach the connected workspace.
`mark_notification` stays out of the patterns on purpose, so it is unguarded: it changes only one person's inbox state.
Relation fields, such as `blocks`, `parentId`, and `duplicateOf`, are left out of `keyFields` on purpose, since a relation may cross teams.
`createFields` holds the inputs that put a write in a team: `removeTeams` takes one out, and `teamId` takes a UUID, which skips the check.
`id` stays in `keyFields` on every write tool, which has a limit: a non-issue whose name looks like an issue key, such as a label `Sev-1`,
is refused, and the agent retries with its UUID.

A connection under another server name goes in `servers`, and gets the same tools: `"servers": ["acme-linear"]`, in each host's spelling.

Anything else the adapter gives is a default: a list, field, `workspaceInput`, `readVerbs`, or `idHint` the file sets replaces it.
A pattern may name a tool as the host sends it or in the standard form, such as `mcp__codex_apps__linear__save_*` or `mcp__codex_apps_linear__save_*`,
and the guard and the [agent gates](#agents) match either.
A project that has written out `readTools`, `writeTools`, and every field needs no `provider`,
and its key keeps working as written, with the tools of any tracker:

```json
{
  "tracker": {
    "enabled": true,
    "workspace": { "expect": "https://tracker.example/acme", "field": "url" },
    "readTools": ["mcp__tracker__get_workspace"],
    "writeTools": ["mcp__tracker__save_*"],
    "team": { "key": "NOTES", "values": ["Notes"], "createFields": ["team"], "keyFields": ["id"] }
  }
}
```

Such a key does not grow with the adapter, and a list that replaces an adapter's replaces all of it.
When a host is known to be here, because it runs the command or its adapter finds it set up, and such lists name a known server
of a tracker, `aidrian check` warns of each known server on that host they leave out, or leave a write verb of, with the servers
the adapter lists for any host counted on every host. A hyphenated server the lists name gets the same warning when that host
spells it another way. A write through any of these passes unchecked. Replacing both lists with `"provider"`, and raising
[`requires.aidrian`](#plugin-version) to this plugin's version, ends the warning.
The host a session runs on gets one `Tracker guard:` line about it at [session start](hooks.md#start-lines).
A host that is not set up here, or that no adapter can find, gets no warning, which is the limit of this check.

| Key | Default | Meaning |
| --- | --- | --- |
| `tracker.enabled` | `false` | `true` turns the key on. It needs a pattern in `writeTools`, and one of `workspace`, `team`, or `project`. |
| `tracker.provider` | | The [tracker adapter](providers/adding-a-host.md#adding-a-tracker) that fills in what the file leaves out, such as `linear`. |
| `tracker.servers` | `[]` | With `provider`: more server names, beside the ones the adapter knows, such as `acme-linear`. An error beside a file's `writeTools`, which replaces the list it adds to. |
| `tracker.workspace.expect` | | The workspace a write must belong to, as `readTools` report it. |
| `tracker.workspace.field` | the adapter's | The field of the read's response that holds that value. |
| `tracker.readTools` | the adapter's, or `[]` | The MCP tools that read the connected workspace, as exact tool names, with no `*`; one on each server in `writeTools`. |
| `tracker.writeTools` | the adapter's, or `[]` | The MCP tools that write to the tracker, as [tool patterns](#agents) that start with `mcp__`. |
| `tracker.team.key` | | The team's issue key prefix, such as `NOTES` in `NOTES-12`, with no hyphen or whitespace. |
| `tracker.team.values` | with `provider`, the team's key | The team names a write may set; at least one. |
| `tracker.team.createFields` | the adapter's | The tool input fields that name a team; at least one. |
| `tracker.team.keyFields` | the adapter's | The tool input fields that hold an issue key; at least one. |
| `tracker.project.values` | | The project names a write may set; at least one. |
| `tracker.project.field` | the adapter's | The tool input field that names a project. |
| `tracker.workspaceInput` | the adapter's | For a tracker whose every write names its workspace: that input field. It needs no read tool. |
| `tracker.readVerbs` | the adapter's | Tools that only read under names the [first-word check](#how-a-write-is-judged) does not know, as patterns after the server. |
| `tracker.idHint` | the adapter's | What a refused issue key tells the agent to do when the write is on something else. |

- `workspace`, `team`, and `project` are `null` by default, which leaves them unset.
  One that is set needs every key of its group, after the adapter fills it in.
- `workspace` and `readTools` are set together or not at all; a tracker with no tool that reads its workspace sets neither.
  With `provider`, the adapter's read tools come only with a `workspace`.
- `*` and `Bash(...)` are not tracker tools: both lists take MCP tools only, so `"writeTools": ["mcp__*"]` is the widest.
- A name in `readTools` must not match a pattern in `writeTools`, so that `"mcp__*"` works only with no read tools.
- `aidrian check` also reports a name in `readTools` that a pattern in `writeTools` matches in another form a host sends it, and a name in `readTools`
  or a pattern in `writeTools` no host sends, such as `mcp__codex_apps__linear_get_workspace`, the form only Codex's model sees.
  It only reports: each entry stays, so a read that can never count leaves the guard refusing writes on that server.
  A write pattern that matches nothing runs its writes unjudged, so fix it first.
- With `workspace` set, `aidrian check` reports each pattern in `writeTools` that no read can clear: one on a server no tool in `readTools` is on,
  and one that names no server. It only reports: the guard stays on as written and refuses those writes.
  Both lists' names count by their standard server, so a read and a write on one connector pair in either form, and one on another connector does not.
  A `*` before the server's name ends, as in `mcp__acme*`, can match a server with a read tool, so that pattern is not reported.
- A group with any error falls back to unset, and a bad entry is left out of its list.
  A bad entry in `readTools`, even beside a good one, also unsets `workspace` and `readTools`, except what the reports above keep.
  `enabled` falls back to `false` with no write tool or no group left, so the loaded key is never half set.
  An unknown `provider` or a bad `servers` value leaves a key with no `writeTools` at its defaults, with one error, since nothing else in it can be judged without its tracker.
  A key that writes out `writeTools` keeps its guard and reports the error.
  `aidrian check` names each problem by its key.

While `tracker.enabled` is true, `aidrian check` also warns of what would leave the guard silent:
a route a [host](providers/adding-a-host.md#adding-a-host) or [tracker](providers/adding-a-host.md#adding-a-tracker) adapter says no hook reaches,
a host whose hooks wait on a person's trust with none on record or are turned off, and a host set up here whose guard nobody has verified.
[Where the tracker guard is verified](hooks.md#where-the-tracker-guard-is-verified) says what was checked on each host.

A project that adopts the key sets [`requires.aidrian`](#plugin-version), since an older plugin rejects it, and `provider` needs a plugin that ships it.
On an older plugin, the short key is an unknown key with its groups missing fields, so the whole guard turns off, with no word in a session.
The `harness-setup` skill asks for the key only while setting a project up, so an existing project adds the key by hand, in the short form above.
It raises [`requires.aidrian`](#plugin-version) to the plugin version that ships the key unless it is already higher,
replaces the team in its `issue_tracker` doc and that doc's summary with a pointer to the key, and runs `aidrian check`.

### How a write is judged

Two [hooks](hooks.md) run on every MCP tool call while `tracker.enabled` is true, and stop at once when it is not.
A config.json that cannot be read leaves it false, so a broken config lets every call run.

After a call of a tool in `readTools`, the first hook records what it reported in
`$XDG_STATE_HOME/aidrian/sessions/<session id>.tracker.json`. The latest read replaces an earlier one.
On Claude Code the end of the session deletes the file.
The end of each `claude -p` process counts as that end, so a later `--resume` has to read again.
On Codex, whether the session's end deletes the file is not verified.

On Claude Code, a read that fails counts as no read. It goes to `PostToolUseFailure`, where no tracker hook runs, so it leaves the record as it was.
With no earlier read, the next write is refused as a session that has not read, with no word of the failure.
After a good read, that read stays in force, and writes keep passing.

A tracker with `workspaceInput` takes no read: rules 1 to 3 become one, on the call, that the input must be present and be `workspace.expect`.

Before a call that matches `writeTools`, the second hook checks these rules in order, and the first the call breaks refuses it:

1. With `workspace` set, the session's latest read must be on the write's server, the `mcp__<server>__` that starts both tool names.
   Two servers can be connected to different workspaces, and the one record holds only the latest read,
   so switching servers asks for a new read. The reason names the read tools on the write's server, as the host's model sees them.
   With none listed there, no read can clear the rule, so the reason tells the agent to ask the Human to add one and not to edit the key.
   A write tool with no server in its name cannot be cleared either, so the reason says `tracker.writeTools` names a tool with no server,
   and tells the agent to ask the Human to correct that entry and not to edit the key.
   A session that can hold no record skips this rule and keeps the others: one with no id that can name a file,
   or whose record folder cannot be written. In such a session, a record from the write's server is still judged,
   and one from another server is skipped with the rule.
2. That read must have returned a value in `workspace.field`. If not, the agent asks the Human to fix the connection or the key.
3. That value must be `workspace.expect`. If not, the reason names both, and tells the agent to ask the Human whether the key is wrong
   or the wrong workspace is connected, and not to edit the key.
4. With `team` set, each field in `createFields` must name a listed team, and each field in `keyFields` must hold an issue of that team.
   If not, the reason offers the way that passes, or telling the Human the write belongs elsewhere, and tells the agent not to edit the key.
5. With `project` set, `project.field` must name a listed project.
   If not, the reason offers a listed value, or telling the Human the write belongs elsewhere, and tells the agent not to edit the key.

A server's name ends at the first double underscore in the tool name, so `mcp__plugin_a_b__save` is on `plugin_a_b`.
A server whose own name holds a double underscore reads as the part before it, so `a__b` and `a` count as one server.

The values compare like this:

- **Exact text**: `workspace.expect`, `team.values`, and `project.values` compare with case and spaces counted.
  The one exception is a single trailing `/`, ignored on either side of the workspace comparison.
- **The team key**: in a `createFields` field the value of `team.key` passes too, in any case. An issue key's prefix also compares
  in any case. The team key does not stand in for a project value.
- **UUIDs**: a UUID, in either case, skips the check of that one field, in `createFields`, `keyFields`, or `project.field`,
  since a UUID names no team or project by itself. The other rules still run.
  A project's identifier or slug is no UUID, so it passes only when listed.
- **Arrays**: in a `createFields` field or `project.field`, each entry is judged, and the first wrong one is named. An empty array names no value to check.
- **Null**: an absent field or `null` names no value to check, so the rule passes.
- **Other values**: in a `createFields` field or `project.field`, a number, an empty string, or any other value not listed refuses.
- **`keyFields`**: they apply to every tool in `writeTools`, and read a single string of the form `<KEY>-<n>`.
  A number, an array, or a string of any other shape skips the team check. A tool whose field of that name holds
  something like an issue key but is no issue is refused too, and the reason tells the agent to pass the item's UUID.

Only the fields this key names are read, so a project lists every field it wants checked:
a tool that names its team in a field missing from `createFields` passes unchecked.
The same holds for tools: a tool that matches no pattern in `writeTools` passes unchecked, including every tool of a connection under another server name.

An adapter's lists move with the plugin, and a key written out is copied into the project,
so a tool the tracker adds later is on neither until they change.
After a call of a tool on a server either list names, when neither list names the tool,
the first hook files an [automatic lesson](lessons.md#automatic-lessons), `tracker-unlisted:<tool>`, in the project's inbox.
It never refuses the call. The lesson asks for the tool in `writeTools` when it writes.
A tool that only reads is told apart by its name's first word:
`get`, `list`, `search`, `read`, `find`, `fetch`, `query`, `view`, `show`, `describe`, or `whoami`.
That has two limits. A write tool named that way, such as `get_or_create_item`, is not noted
(the [project run rule](#project-run) reads names stricter).
A read tool named otherwise is noted, and rejecting its lesson ends that, since the same tool never reopens it.
A tool on a server neither list names is not noted, so a connection under another server name stays out of sight.

A refused reason holds the workspace or input value it refused.
While `telemetry.hookDenies` is on, that cause goes to the [`hook_deny` row](dispatch-log.md#hook_deny-when-one-of-the-plugins-rules-blocks-a-tool-call)
of the local dispatch log, so the values may reach it, cut to 120 characters. The rest of the input does not.

The refusal of rule 1 that names a read to call is the guard's normal flow: a session that writes meets it once, reads, and goes on.
When it happens it writes no `hook_deny` row and adds no block count, so healthy sessions and a batch of first writes read as no hot spot.
It leaves a marker in the hooks' counts folder, `<state root>/hook-counts`, instead, and the session's end settles it.
A session that ends with no read recorded writes one `hook_deny` row, whichever way the read was lost: failing, renamed upstream, or never tried.
Over several sessions those rows raise the usual hot spot in `aidrian report health`, and the row counts once toward the session's block count.
With `telemetry.enabled` or `telemetry.hookDenies` off, a session stuck on this refusal leaves no row and no lesson,
though the agent still sees each refusal.
A session with any recorded read writes none, even when the read was on another server than the refused write.
Every other refusal is recorded when it happens, including rule 1's two that no read clears, which need the key corrected.
This depends on the session-end hook: on a host with no SessionEnd, and in a session that crashes, the refusal stays uncounted.

## Project run

`aidrian project` keeps the record of a project run, which a driver session uses to work through a tracker project.
The driver reads the tracker with its own tools and writes a snapshot input; `init RUN --file PATH` validates it and starts the run.
`next RUN` names the issues to start, and `summary RUN` writes the run's `summary.md` from its ledger.
The run's files are in `<state>/runs/RUN/`, where `<state>` is the project's state folder.
How its sessions relate to the cap of five background continuations in a row, and how the driver hands off, is
[A project run](handoff.md#a-project-run). The [Full autonomy, solo](config-recipes.md#full-autonomy-solo) recipe
allows project runs. [Project run setup](project-run-setup.md) lists every one-time step the Human takes for these keys,
the machine's local file, the forge, and the host; each `aidrian project preflight` blocker line ends with its section.

| Key | Default | Meaning |
| --- | --- | --- |
| `projectRun.allow` | `false` | Whether the team allows project runs. |
| `projectRun.maxParallel` | `1` | The most issues that run at once, from 1 to 4, read from the default branch on the forge and held to 4 in code; a local ref only lowers it, and a read that fails runs one at a time. `next` names that many issues to start, less those running, and none while a session runs on after its issue settled; `init --check` names as many for turn 1, and `start` refuses one past it. The driver's starts still run one at a time: each takes the session's start claim and its one pending mark, and its write-ahead row asks the order and the cap again under the ledger's lock, so two starts never pass it together; one that loses the race is refused, and halts nothing. An issue starts only once every blocker in the run is done, which a result counts only for a merge the forge confirmed. |
| `projectRun.maxStarts` | `300` | The most sessions one run starts, from 1 to 1000. |
| `projectRun.issueHours` | `6` | How long one issue may run, in hours, from 1 to 24. |
| `projectRun.blockedStatus` | `null` | The tracker status a blocked issue moves to; `null` moves none. |
| `projectRun.decisionLabel` | `"needs-decision"` | The label an issue parked on a decision gets. |
| `projectRun.unverifiedHosts` | `false` | Whether a run starts sessions on a host whose project start no live run has verified, which today is both hosts, Claude Code and Codex: setting it opts into a sandbox boundary no live run has checked ([Claude Code](providers/claude-code.md#project-start), [Codex](providers/codex.md#project-start)). Read from the default branch on the forge; a local ref only refuses. Each such start prints an `unverified:` line. |
| `projectRun.workflowSecretsAccepted` | `false` | Whether the team accepts that a branch an issue's session pushes runs the repository's workflows with its CI secrets. Without it, `aidrian project preflight` blocks a run whose repository, organization, or an open environment (one with no required reviewers rule that prevents self-review or names only users other than the signed-in one, or any environment when the signed-in user is an admin of the repository or the forge does not say, since an admin's token can edit an environment's protection rules, so no rule holds it; an environment limited to protected branches or branch patterns counts too, since a deployment branch rule is no hold against code the run pushes) gives its workflows a secret, whatever the signed-in token's `workflow` scope: the push and pull request workflows run the pushed branch's own tests, scripts, and build, which the session writes, and a token that may push a workflow file (GitHub's `workflow` scope, or a token that names no scopes) widens that. The agent gate hook refuses an issue session's own workflow writes and pushes that carry them, and a script the session runs is the residual. Keep the secrets in environments held for a reviewer who is not the signed-in user, when the signed-in user is not an admin of the repository (an admin's token can edit the rule), or accept the exposure by setting it: it skips the workflow secrets read whole, so it accepts all current and future workflow secret exposure for project runs, the repository's, its organization's, and every environment's secrets, including any added later. A team sets it only when that is acceptable. `projectRun.forgeProtectionAccepted` waives no secret. Read from the default branch on the forge and the local ref; both must set it. Never set by a recipe. |
| `projectRun.forgeProtectionAccepted` | `false` | Whether the team accepts running with no forge rule that holds the signed-in user, whose token an issue's session keeps, to a pull request on the default branch and from creating or moving a tag. A user who administers the repository is held by no rule, since that token can turn any rule off or edit its bypass list. Without it, `aidrian project preflight` blocks such a run (`branch-protection`, `release-tags`), and every start halts on it, and names the plan when the forge's plan offers no such rule, as GitHub's free plan for a private repository, whose remedies are a paid plan, GitHub Pro for a personal account's repository or GitHub Team for an organization's, or a public repository. With it, both lines are `note` lines naming the risk: a script an issue session runs can push to the default branch or a tag with the token, and only the hooks hold it, since the forge rules that are the hooks' backstop are gone. A working copy never turns it on. Read from the default branch on the forge and the local ref; both must set it. Never set by a recipe. |
| `projectRun.outsideSandbox` | `[]` | The names a confined session may still run outside its host's sandbox, each one the team has reviewed: a key of the user's host settings that runs a command, such as `hooks`, `statusLine`, or `apiKeyHelper`; any plugin other than this one that is installed or enabled, by its id, such as `name@marketplace`, since a plugin's hooks, MCP and LSP servers, and monitors all run outside the sandbox; a skill, agent, or command of the user's config folder whose frontmatter declares hooks or MCP servers, by its path spelled from `~/.claude/`, such as `~/.claude/skills/deploy/SKILL.md`; or one of the repository's, at any depth, by its path, such as `.claude/skills/deploy/SKILL.md`, or a link under a skills, agents, or commands folder that leads out of it, such as `.claude/skills/foo`. Any other such command halts the start. It never lifts a halt on the user's `sandbox` settings. Only the names both the default branch on the forge and the local ref list count. |
| `projectRun.mcpServers` | `{}` | The MCP servers a confined session loads, as the host's `mcpServers` object takes them, each name to its definition. The session starts with only these: a project's `.mcp.json`, the user's own servers, and the host's claude.ai connectors never load. Each listed server, and the helper command it starts, runs outside the sandbox with the user's full access, so list only a server the team trusts with that; its definition travels in the session's command line, which any process of the user can read in the process list, so it holds no secret. Only the servers both the forge and the local ref define alike count. |
| `projectRun.nonTrackerServers` | `[]` | The servers of `projectRun.mcpServers` that reach no tracker, by name, such as a docs server. The [project run rule](#tracker) holds an issue's session and the driver, on every server that list names and no tracker adapter maps, to calls whose name says they read, since it cannot tell a write there from a tracker write; a server named here is free of that. A server an adapter maps by its name or endpoint stays held whatever this lists. Read from the base branch. |
| `projectRun.registries` | `[]` | The package registries a confined session may reach to install the project's dependencies, by ecosystem name, each once: `npm` (`registry.npmjs.org`, and `registry.yarnpkg.com`, yarn's default), `pypi` (`pypi.org` and `files.pythonhosted.org`), `crates` (`index.crates.io` and `static.crates.io`), `go` (`proxy.golang.org` and `sum.golang.org`), and `rubygems` (`index.rubygems.org` and `rubygems.org`). The hosts are fixed in `lib/project-registries.mjs`: no name of a host, and no other domain, is ever accepted. A team opts in; a project with no code yet lists the ecosystems of the stack it will scaffold. Install scripts a package runs, such as npm's `postinstall`, run inside the session's sandbox, under its write and network limits, which is why letting a session install is acceptable. Every listed registry but `pypi` and `crates` gives a channel a sandboxed command can send data out on that an attacker can read, `go` the widest, since its proxy fetches from any host a module path names; each is accepted because the forge channel gives one already, and narrowing the forge token reopens that ruling ([Dependency installs](providers/claude-code.md#dependency-installs) names each one's path). With `npm` listed, corepack downloads pnpm and yarn from it too. Every session, whatever this lists, keeps its package managers' caches in its attempt's `cache` folder, and the home folder stays as it is. Codex holds a session to the same hosts through its network proxy, which no live run has checked yet ([Codex](providers/codex.md#project-start)). Only the names both the default branch on the forge and the local ref list count. |
| `projectRun.localBinding` | `false` | Whether an issue's session may bind local ports, so the services its checks need, such as a database, an API server, a worker, or a browser, run on this machine. On Claude Code the session's sandbox then starts with `allowLocalBinding: true`, and an organization's managed `allowLocalBinding` passes at `true` or `false`. On macOS that lets a sandboxed command bind, and take inbound connections, on every interface of this machine, not only the loopback, so a server bound to `0.0.0.0` takes connections from other machines the firewall lets through, and lets it reach every service listening on this machine's loopback, outside the network allowlist; there the [sandbox proof](providers/claude-code.md#the-sandbox-proof) runs no localhost listener, so it does not check the loopback. On Linux the host gives a sandboxed command a network namespace of its own, so the key changes nothing there, and the proof keeps its listener. On Codex the start adds `-c features.network_proxy.allow_local_binding=true`, which in Codex 0.171.0 also turns off the proxy's refusal of private and link-local addresses, so an allowed host name that resolves to one is reached too; no live run has checked it ([Codex](providers/codex.md#project-start)). Bind each test server to `127.0.0.1`, never `0.0.0.0`. `aidrian project preflight` prints a `note local-binding` line naming the host's risk while it is on ([residual risks](providers/claude-code.md#project-start)). Read from the default branch on the forge and the local ref; both must set it, and no working copy or local file turns it on. Never set by a recipe. |
| `projectRun.recordedDecisions` | `false` | Whether a run's starts read the decisions the Human recorded on issues in this machine's recorded-decision store, each pinning one section of the issue's description by its heading and sha256 ([Recorded decisions](#recorded-decisions)). A start hands a section that still hashes so to the issue's session as the Human's answer to the decision it names, and nothing more. Read from the default branch on the forge and the local ref; both must set it. It took an object of entries until it became a switch: a config that still sets one is refused, and its entries are recorded with `aidrian project decision ISSUE --heading TEXT --record`. Never set by a recipe. |
| `projectRun.fullAuto` | `false` | Standing consent for custody of a driver session the host continued under a new id: that session takes the run with `aidrian project resume RUN --custody` and no person ([Full auto](#full-auto)). It takes no decision, merges nothing more, signs nothing off, and lifts no halt. Read from the default branch on the forge and the local ref; both must set it. Never set by a recipe. |
| `projectRun.forgeTokenKeychain` in `.aidrian.local.json` | unset | This machine's keychain entry for the forge token of this project's issue sessions, `{ "service": "<name>", "account": "<name>" }`, such as a fine-grained token limited to the run's repository. The driver reads the token outside the sandbox, which hides the system keyring from the session, from the first of three sources that gives one: (1) this entry, on macOS; (2) the machine's default entry, service `aidrian-project-run` with any account, which every project on the machine shares, on macOS, and for a github.com run alone; (3) the forge CLI's own login, `gh auth token --hostname <host>`. Each keychain read is `security find-generic-password -s <service> [-a <account>] -w`, an argument list with no shell, with the `security` first on PATH. An entry that is not there passes to the next source; on another platform the key is a preflight `note` that it is unsupported. No source with a token blocks the preflight (`access`) and halts a start, and `note token:` names the source the preflight used, never the token. Read only from the main checkout's file, and only while git tracks no `.aidrian.local.json` there; any other shape is a config error and reads unset. The team's `config.json` cannot set it, and a subagent or a session no Human attends may not write it. How the token reaches the session: [Project start](providers/claude-code.md#project-start). |

On a host whose start proves its sandbox ([Claude Code](providers/claude-code.md#the-sandbox-proof)), a start refuses
with `the sandbox proof cannot be prepared`, records nothing, and leaves no attempt folder, for one of four causes:
every host the proof can name as unlisted (`example.com`, `example.net`, `example.org`) is an allowed domain, as a
`"*"` or an example domain in the user's or the organization's `sandbox.network.allowedDomains` makes it, so remove
it; no unattended mark folder exists to probe, which `aidrian project init` makes, so start the run again from its
init; the start cannot tell whether its localhost listener lives, since on Linux `/proc/self/stat` cannot be read and
elsewhere `/bin/ps` is not there, so install procps or mount `/proc`; or the localhost listener does not start within
5 seconds, or the plan cannot be written in the attempt's folder, so check that `node` runs and the state folder is
writable, then start again.

A start that cannot go on safely halts: `aidrian project start` exits 1, its first line is `halt <cause>`, and no issue
is parked. Most halts record nothing, such as a user the forge does not let push, a sandbox with no network, or a
repository whose git config could run a program; fix the cause and start again. A start whose proof failed, as a
session that never named itself, whose hooks never ran, or whose sandbox proof failed
([Claude Code](providers/claude-code.md#the-sandbox-proof)), gives its attempt back (a `void` start row, the issue open
again) and writes a `halt` row: every later start refuses, however long ago it was written, until the Human's own shell,
or another session a person attends that never drove the run, runs `aidrian project resume RUN`, which writes a `resume`
row. The driver never runs it, and the hooks and the command refuse it to every session of the run's custody; the
session the host continued the driver as takes custody with it and lifts no halt ([Full auto](#full-auto)).
`next` prints `halted <cause>` first, and `--json` adds `halt`.
An issue's session that finds its own environment broken, such as a sandbox that refuses what the work needs, a forge
sign-in or push that fails, or a host tool that fails, records the result `environment`, with the failing command and
its error as its `stop`, which it must name. Every result's `stop` has anything shaped like a token, a URL's password,
or an Authorization value masked as `[redacted]` before it is kept. The driver's `wait` records the result with that
stop as the run's halt cause, in the same row, and prints `result ISSUE environment -> open`, or `-> parked attempts`
on the issue's last attempt: the cause is fixed once for the whole run, not once per issue, and a `start` checks for
a halt again under the ledger's lock. The attempt counts toward the issue's 3, as after `failed`: with attempts left,
`aidrian project resume RUN` lets the next start take the same issue up again. The attempt's folder stays for the
run's life, so work its clone holds that a failed push never sent can be recovered from
`<state>/runs/RUN/attempts/ISSUE.ATTEMPT/work`. So does any ended attempt whose clone holds a commit the forge does not
have, whatever its result, with a `kept` row and a `kept` line from `wait` ([Handoff](handoff.md)): a usage limit or a
crash that ends a session mid-work never loses what it committed and did not push.
The driver lifts two kinds of halt by itself, once each, when the preflight's own checks of that cause pass
(`lib/project-recheck.mjs`): an environment result's, re-checked by `commit`, `host`, `trust`, and `access` with its
`token-reads`, and a failed proof's but the sandbox proof's, by `host`, `trust`, and `access`. When the driver's
`start` of the halted issue meets such a halt, it runs only those checks of `aidrian project preflight RUN`, with no
person, on the repository the run's init row pinned: first `repository`, the start gate's own check that origin still names it,
which on a moved origin keeps the halt before any probe runs, then the state folder and the team's policy the others
need. When every line is `ok` or a `note`, it writes a `resume` row with `via: "recheck"`, the halt's `kind`, issue,
and attempt, and the `checks` that passed, under the ledger's lock only while the halt stands, the run has not ended,
and custody rests where the caller read it, prints `recheck lifted the halt: <cause>; ok <checks>` and
`lifted the <kind> halt of <issue>; start it again`, and exits 0 having launched nothing: the driver's next start of the
issue reads the run, its policy, and its access afresh, and launches it. A run that changed meanwhile prints `the checks
passed, but the run changed meanwhile`; a row that could not be written prints `the checks passed, but the resume row
could not be written: <why>`; and a ledger another process holds exits 75, to be tried again. Any other line, a blocker
or a forge that could not answer alike, keeps the halt and writes nothing: the start prints `recheck kept the halt:
<cause>` and those lines, and the driver stops. The halt stays for the next driver start of that issue, which
re-checks it again, so one the forge could not answer lifts once the forge answers; `aidrian project resume` is for a
person who fixed the cause. `wait` never
re-checks a halt. A second halt of the same kind on the same issue after a self-lift is kept with no re-check, so a cause
the preflight cannot see, such as a missing host tool, costs that issue one more attempt at most. A failed sandbox proof,
a usage limit past the run's pauses, and any halt row an older plugin wrote wait on a person.
When an issue's pull request does not merge, its session runs `aidrian project stop-action RUN ISSUE`, as the
autopilot skill's phases say. Only the issue's own session runs it: the newest session of the chain of the issue's
latest start, while the issue runs, whose mark names that run and issue; never the driver. It finds the pull request
of the issue's branch in the repository init pinned, reads `aidrian pr auto-merge --check --json` in the same process, and
prints one line, `<action> <issue> #<n> at <head>: <why> (<used> of <cap> <scope>); <what to do next>`, for exactly
one action. The `why` is cleaned and capped as a result's `stop` is, and a forge error in it is quoted.

| Stop | Action | Cap |
| --- | --- | --- |
| Merged on the forge, as the result command records `merged`: into the default branch, after the attempt's start | `done`: record the result `merged` | |
| Merged on the forge, where the result command refuses `merged`: into another branch, or at or before the attempt's start | `park`: record the result `parked`, with one decision of class `other` on whether the merge counts as the issue's work, whose first and recommended option is to leave the issue parked; the line names the result command's reason | |
| Closed; a base other than the default branch; a reason `team`, `local`, `checks`, `paths`, `author`, `outsider`, or `closes`; a `review` that is changes requested; a reason it does not know; a draft | `park`: record the result `pr_open` with the line as its stop | |
| `trust` with `signoff` | `park`: record the result `parked`, with one decision for the Human's sign-off, whose first and recommended option is to leave the pull request unmerged; of class `security` when any unsigned flow is a security one (an id that holds the word `security`, or a `require` that names `agent:security-engineer`), and `product` otherwise | |
| A conflict with the base | `merge_base`: the session fetches the base and its branch, and stays on its own branch, its commits kept; a fetch that fails is run again in the same turn, up to three times in all, and one that still fails merges nothing and records `pr_open` naming the failed fetch, with no second `stop-action`, so no second base update is spent; when `git merge-base --is-ancestor origin/<branch> HEAD` fails, it records `pr_open` naming the divergence and merges nothing; when `git merge-tree --write-tree --name-only` names a host config or instruction file that would conflict, or git refuses the merge over one, it records `pr_open` with that file's path in its stop and merges nothing; else it merges the base into HEAD with a merge commit, resolves it, and pushes with a full refspec, never with force | 2 base updates per issue, with the next row |
| Behind the base | `update_branch`: the forge merges the base in, or rebases under the `rebase` strategy where the branch's rules allow a push that is no fast-forward | the same 2 |
| GitHub still computing it, a head that moved while read, or pending checks | `wait` | 3 per head |
| The bot asked already for this head and not passed yet | `wait`: `aidrian pr await-review <n>`, with no second request | the same 3 per head |
| A forge read, its checks' read and a merged pull request's check included, or auto-merge that failed (`aidrian pr auto-merge` exit 3), or a forge action it refused | `wait` 60, then 300, then 900 seconds; a wait past 150 seconds is taken in foreground waits of at most 150 seconds each, since the host moves a longer call to the background | 3 per attempt, apart from the waits above |
| `review` on a head a base update made | `review_round`: one review round of that head | 1 per head |
| `trust` with `bot` | `request_bot`: `aidrian pr await-review <n> --request` | 1 per head |
| Auto-merge on, failing checks that are each a first run of the head, on the issue's branch, in the pinned repository, as the forge reads each Actions run | `rerun_checks`: the forge starts their failed jobs again | 1 per head |
| Auto-merge on, failing checks that are an app's status, a fork's run, or a run that ran again already | `park` | |
| Auto-merge on, checks pass, and the forge still blocks it | `park` | |
| Nothing stops it | `merge`: run the `pr-auto-merge` skill again; a second `merge` on the same head parks with the merge steps' own stop line as the stop, since they stopped for a reason the command does not read | 1 per head |

The order is the table's: a policy refusal, or a sign-off the Human owes, parks before any update, since an update
makes a new head, and every sign-off and review of the old head no longer counts; so a pull request whose flows need
the Human's sign-off parks after its update rather than looping. The forge's part of an action goes through the forge
facade. Each capped action is recorded in `stops.jsonl` in the drop folder of the issue's latest start. Before the
driver's `wait` removes an ended attempt's folder, it keeps that file's rows in the run's `stops/<issue>.jsonl`, with
a row that marks the attempt archived, so a new attempt resets no cap. It keeps only the action, head, pull request number, and attempt of each row. Every history file is opened without following
a link or waiting on a FIFO, and must be a regular file of this user with one link. A history that is not, or holds a
row the command did not write, parks.
With `--catch-up`, which the first message of a later or resumed attempt asks for before any other work, it reads only the pull request:
`park` when it targets another branch than the default, as above.
A merged or closed pull request gets exactly the answer the command gives without `--catch-up`: `done`, `wait`, or a `park`.
A merged pull request is `done` only when the result command's own check (`mergeProblem`) would record it `merged`.
While that check cannot be read, it gives `wait`, then this command again, under the retry cap above.
Every `park` of a pull request the forge shows merged, such as a spent cap, records `parked` on the one decision, as a refused merge does.
On a conflict it gives `merge_base`, and `wait` while the forge works it out, under the caps above; otherwise `none`.
It reads no auto-merge answer, so a draft that conflicts gets `merge_base`, whose line then says to go on with the checks and the review on the new head.
`stop-action` exits 1 when it refuses, such as for another session or a pull
request that is not the issue's own: the session then records `pr_open` with that line as its stop.

At the end of its loop the driver runs `aidrian project end RUN`, which writes an `end` row: an end row counts only when
the session that wrote it was the run's driver, by custody, at that row, and then the run is over, starts no
issue, and no longer counts as active, and its driver mark stops holding the driver session
([hooks.md](hooks.md#agent-gates)). A run whose issues are all done or parked holds its driver until that row: its
parked issues may still owe the Human's sign-offs, which come from a separate session the Human attends.
Each start is written ahead: a start row with `pending: true` before the host starts anything, then one row that
settles it, so a gate killed mid-start leaves a row `wait` finds and settles. A start row's `pushUrl` pins the URL the
attempt's clone pushes to, read before its session starts, and a clone that pushes to more than one URL, as a second
`remote.origin.pushurl` in the user's git config makes it, halts the start; the issue session's one push goes only there
([hooks.md](hooks.md#agent-gates)). A host that would refuse that push in the driver session's permission mode, which the session
takes, halts the start too, before the host starts anything ([the push preflight](handoff.md#the-push-preflight)). Every start is confined to a fresh
clone under its host's sandbox, and a host that is not halts the start.
A run never discards or rebuilds existing work unless a person asks.
A later attempt goes on on the issue's branch, as does the first attempt of an issue `resumed` from an earlier run at a
head the branch still holds.
When that branch's head changes a host config or instruction file, or a policy file, the pointer file and the
`config.json` it locates as the pinned base tip commits them (the one list the whole start uses, and the start row
keeps as `policyFiles`), the session loads the branch's own copies only when
the review bot, github.reviewer on the default branch, passed exactly that head on the forge, and the Human signed off
the harness-config flow on that head, or the default branch sets `github.autoMerge.includeGuardedPaths` and no policy
file changed, or it sets `github.autoMerge.includePolicyFiles` too; otherwise its clone holds the base branch's copies,
git leaves them out of its commits, and a push that
changes one is refused.
With `github.autoMerge.includePolicyFiles` on as the start reads the team policy, the session may write the host
instruction files and the policy files, but no base copy; with it off, it writes none of them,
whatever `github.autoMerge.includeGuardedPaths` says.
Either way, it never writes the host settings, skills, agents, commands, hooks, or MCP servers, nor the forge's workflow files.
One rule decides a review finding in a host file: one in a file the attempt may write is fixed as any other finding.
A low or medium review finding whose fix lies in a host file the attempt may not write, no security finding, is a stated residual named by its
finding id alone, in the project's [residual format](#pull-request-contract), never a decision; once it is the one stop
left, the result is `pr_open`. A security finding, a finding with no engine id, and an item the pull request body rule
refuses for any reason park as before ([Host files no review saw](handoff.md#a-project-run)).
Whenever the pull request's copy of the review record lacks the finding's details, the Human reads them in the review
record on the machine that ran the review.
The start pins the base tip, reads the team policy once with its local half at that commit, and decides everything
from that read: the machine's switch and solo, projectRun.unverifiedHosts, the caps, maxStarts asked again under the
ledger's lock with the write-ahead row, the access check with outsideSandbox and localBinding, the clone's checks, and
every value of the launch, mcpServers and registries among them, as well as github.reviewer,
`github.autoMerge.includeGuardedPaths`, and `github.autoMerge.includePolicyFiles`.
Since a key counts only where the local read and the forge's define it alike, the pinned commit bounds each of them.
Only checks that read no policy run before the pin, and nothing on the path to a launch writes before the policy read,
except a halt recheck's `resume` row; settling an orphan or a lingering session, which writes the ledger and may stop a
session, waits until the policy read and the checks it feeds let the start go on.
A forge that cannot answer, or a fetch of the base that fails, during the pin or the policy read makes `start` exit 75;
a head that moved after a good fetch, or a local base ref that names another commit, refuses it; a change on the forge
after the read is an accepted residual.
The start row records that head as `overlay`, and `<attempt>/base-copies.txt` lists the files, cleaned and fenced as
data from the branch.
The branch's own changes stay in its commits for the pull request's review.
The one change to those files a push may carry is a merge of a moved base, which a later or resumed attempt makes when its pull request conflicts with it.
The session asks `aidrian project stop-action RUN ISSUE --catch-up` first, whose `merge_base` line names the one route (below).
The push guard lets each host file through only as git's clean merge of `overlay` and that base gives it ([agent gates](hooks.md#agent-gates)).
Once HEAD holds a newer base, every host file must be as that merge gives it, one the branch kept as it was too.
It refuses a host file that conflicted in that merge, whatever bytes the session kept for it.
The start keeps each base copy out of the clone's sparse-checkout definition, with `sparse.expectFilesOutsideOfPatterns` set.
So the merge writes git's merge of each to the index alone, the base copy stays on disk, and none needs a refresh.
Without that, git refuses any merge that changes a base copy, as a local change it would overwrite.
Each start row records the commit the branch was at as `head`, and every later attempt goes on only on a branch that
holds the last head recorded, of a start that ran or a result: a start given back (`void`) records none.
A later run resumes from the same latest head of the earlier run's rows; only a run whose rows carry no head at all
falls back to its pull request's head.
A branch the run's ledger cannot account for parks the issue as unreconciled, with the branch and pull request untouched:
a first attempt whose branch the forge has already, and a recorded head the forge's branch does not hold.
So does a base copy that cannot be made safely: a branch that makes a host file, or a folder on its path, a link, a host
file the base keeps as a link, which an overlay never makes, a host file or a folder on its path that the branch turns
between a file and a folder, a host file or a folder on its path that is, or holds, a submodule the branch makes or the base keeps, and a base copy
the branch's committed ignore rules keep stageable (`git check-ignore`).
Every park row names the recorded head.
`start` exits 0 with `parked <key> unreconciled: ...`, writes no start row, and a later run resumes the issue from that
park row.
To start an issue over, a person deletes its branch on the forge; closing the pull request alone does not.
Each attempt's clone commits unsigned: the
start sets `commit.gpgsign` and `tag.gpgsign` to `false` in the clone's own git config, on every attempt, and never in
the user's global or system config. The sandbox hides the signing keys (`~/.gnupg` and `~/.ssh`), so a commit the
user's config signs would fail once the work is done and park the issue with its change staged; the forge asks no
signature of a branch commit, and the run merges each pull request by squash. Every `aidrian project` subcommand
drops git's location variables (`GIT_DIR`, `GIT_INDEX_FILE`, `GIT_CONFIG`, `GIT_TEMPLATE_DIR`, and the rest) once, at
its entry, from its own process and the environment it passes on, so each git call reads and writes only the
repository at its own folder, the attempt's clone included. A clone in
which git still reads either key as true, as a `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS` setting in the driver's
environment makes it, halts the start before any session, with the preflight's own check; so does a read of either
key that git fails, naming git's error. The clone takes no template (`--template=`), so neither `GIT_TEMPLATE_DIR` nor
`init.templateDir` puts a file in its git folder; its `hooks` folder is made empty. The session hands its
result over in its attempt's `drop` folder, and `wait` records it as a `result` row with `via: "drop"`, or ends the
attempt `bad_result`, as it does at once for a pull request the forge says it does not have; a result the forge cannot
confirm yet waits for the next `wait`, until `issueHours`, when its sessions are stopped and it ends `bad_result`.
`wait --max-wait S` counts S from the start of the command, its setup and reads included, as best effort.
After its first read, which always runs, it starts no read that the slowest read so far and 2 seconds would not fit in the time left.
It then prints the last read's lines, such as `running ISSUE`, and the driver runs it again.
One read slower than every earlier one can still run past S.
The Stop hook holds the result: when the newest session of a running issue's chain ends a turn before it handed its
result over, it is sent back once, before any other Stop check, to run `aidrian project result`, or to go on with the
work (`lib/project-run-guard.mjs resultHoldReason`, run by `scripts/hook-stop.mjs`); a session that handed the work on,
or whose mark, run, or ledger cannot be read, stops. It runs on Claude Code, the host whose project start is confined;
Codex runs the same Stop hook, [not verified live](providers/codex.md#hooks).
A session that meets a usage or rate limit pauses the run (`lib/project-limit.mjs`). `wait` asks the host adapter
whether the session's last record is the host's own limit error, never a tool's output or the model's text, and writes
a `limit` row whose `until` is the reset time the host named, read against the record's own time and held to between
1 minute and 6 hours from now, so a reset already past waits 1 minute; or, when it named none, 15, then 30, then 60
minutes for each pause in a row since the last result. A limit met while a pause lasts joins it: the same pause, its
end moved later only by a named reset. Until the pause is over, `start` of any issue exits 1 with `paused until
<time>`, `next` prints that line first and `--json` adds `pause`, and an idle `wait` waits with it, up to `--max-wait`.
Time paused counts toward no issue's `issueHours`.

A session the host still lists running, on a host that continues its own session at the reset (Claude Code, started
with `autoContinueAtUsageLimit`), keeps running for a usage limit while its pause runs, and 5 minutes past the later
of the pause's end and the newest entry its transcript holds after the limit record, such as the host's own entry
when it continues the session, so a session is not stopped before its first new answer, and never more than 30 minutes
past the pause's end, so an entry dated ahead or entries that keep coming never hold it from `issueHours` for long: `wait`
prints `paused <issue> usage until <time>` and goes on waiting on it. Every other limited session is stopped, and its
attempt ends `limit`: one that ended on the limit, one of a host that does not continue (Codex), a rate limit, a
session whose record is unchanged once its pause and that grace are over, and a limit past the run's 24 pauses. `wait` prints
`limit <issue> <kind> until <time> -> open`. A limited attempt counts toward no cap of the
issue, though it takes an attempt number: an issue is started at most 27 times, its 3 attempts that count and one
for each of the run's 24 pauses. An attempt that ends with no number left, on a limit or a failure, parks the issue
`attempts` (`-> parked attempts`) instead of opening it, so the run reports it rather than leave it open with no start
the gate allows, as limits after an attended resume of a halt can make it. Once the pause is over, the same issue starts again as a new attempt: a fresh
clone of the issue's branch as the forge holds it, whose prompt says the attempt before stopped on a limit. Work the
limited session had not pushed is lost, which the host's own continuation makes rarer. A run waits out 24 pauses at
most: the next limit writes a `halt` row instead, which only `aidrian project resume` lifts.

Neither host's limit record is verified live, and a host that reads none, or a record it does not recognise, leaves the
backstop: the session ends with no result, or `issueHours` stops it. The driver session shares the account's limit,
and nothing restarts a driver its own limit stopped: the run goes on when the driver's host continues it after the
reset, which `autoContinueAtUsageLimit` in the user's own settings asks of the host.
For the issue's own session, whose unattended mark names the run and the issue, its attempt clone takes the run's
main checkout, named in the ledger's init row, as its own: the machine's switches and decisions come from that
checkout's `.aidrian.local.json`, never the clone's. Any other reader, and a clone whose link cannot be read or whose
state folder the project does not name, reads every switch off. A confined session's sandbox denies it the main
checkout, so its own commands, such as `aidrian pr auto-merge` and `stop-action`, cannot read that link: for them the
auto-merge switch is the one the start row records as `machine.autoMerge`, which the driver reads in the main checkout
as `aidrian pr auto-merge` reads it there, `unset` only for a local file git does not track, which then follows a team
default of `"on"`. It holds only while the main checkout is denied to the reading process and the session's own mark
names the run, the issue, the main checkout, and the clone as the folder its start began in; every other switch still
reads off there. The merge guard, a hook outside the sandbox, still reads the main checkout's own switch at the merge,
so a switch turned off after the start stops the merge.

`init` reads none of these keys and does not check `allow`; `next` and `init --check` read `maxParallel` from the default branch, as `start` and `wait` read them all.

The snapshot input is one JSON object, at most 1 MiB, read as a regular file and never through a symlink:

```json
{
  "issues": [
    { "key": "ENG-12", "branch": "feat/eng-12-export", "status": "unstarted", "blockedBy": ["ENG-10"], "priority": 2 }
  ],
  "outside": [{ "key": "ENG-3", "status": "completed" }],
  "teams": ["ENG", "OPS"]
}
```

- `issues` holds 1 to 500 issues, each with at most 50 `blockedBy` keys; `outside` holds at most 1000 blockers.
- `key` is a team key and a number, such as `ENG-12`, or a number alone. A run id is lower-case letters, digits, and dashes.
- `branch` is the one text from the tracker the run keeps. It passes `git check-ref-format --branch`, is at most 120 characters
  of letters, digits, `.`, `_`, `-`, and `/`, and starts with no dash. Compared in any case, it is not under `refs/`,
  not the default branch (`git.defaultBranch` in the working copy or on the base branch, or the branch origin's HEAD
  points to), does not start with the name of a remote, and has no part that is a HEAD name, such as `HEAD` or `FETCH_HEAD`.
  No part is 40 or 64 hex digits, as a commit id is.
- `status` is a status type: `triage`, `backlog`, `unstarted`, `started`, `completed`, or `canceled`.
  A run starts only a `backlog` or `unstarted` issue, and a `started` one that an earlier run of the project parked
  on the branch the snapshot names or on an attempt branch it cut from it: in the runs folder, among the runs that pinned
  the same repository, the one with the latest `init` among those that record the issue records it parked, and the
  branch its latest start that ran worked on is the snapshot's, or the snapshot's with `-a<n>` added, as an earlier
  version of the start gate cut it when an attempt left the snapshot's branch, which a start row of that run names, when
  that run's own snapshot named the same branch for the issue. Such a branch may run past the 120-character cap by its
  suffix, as that start gate cut it.
  A run whose latest row of the issue parked it `unreconciled` gives the branch, head, and pull request that row names,
  so a run that parked a resumed issue without starting it hides no earlier record.
  Any other branch keeps the issue blocked. A resumed branch that another issue of the snapshot names, or resumes on,
  compared in any case, is a snapshot problem: `init` refuses it and `init --check` prints a `blocker snapshot` line,
  since both sessions would be let push to that one ref.
  That run moved it to started and parked it, as on a pull request left open, so the issue is the run's own
  work; `init` records it in `snapshot.json` as `resumed`, with that run, the pull request its latest result named,
  the `head` that result recorded, and that `branch`, prints a `resumed:` line, and `next`, `start`, and the gate read
  the same plan. The new run works on that branch from its first attempt: `next` names it, and the start's clone, its
  start row, the session's push, the merge guard, and `stop-action` all take it.
  A parked issue whose latest result in that run names a pull request, `pr_open` or `parked` (on a decision, say),
  whose pull request the forge shows merged now, as after a person merged it once that run ended, is never resumed:
  `init` and its check give it the check `wait` gives a merged `pr_open` result, into the default branch of the pinned
  repository after that attempt started. When it passes, the
  issue counts as done for the plan, so its dependents may start, `init` prints `landed: <n> started issues whose pull
  request an earlier run named merged since, which this run records done: <issue> (#<n>)`, and writes a `landed` row
  and the issue done after its init row. That owes the report a merge owes, the done status, which also takes the
  decision label the earlier run's report set off (Linear `removeLabels`), as that report's `recorded` row names it; a
  ledger from before those rows named a label takes none off, since the team's label may have changed since. The
  driver's first `report` makes that write, within its tracker guard. A run that ends before that report is recorded
  leaves the issue started in the tracker: the next run's `init` takes it in as landed again, with no second forge
  read, while its snapshot names the same branch. When the check fails, or the forge cannot answer, a `pr_open` issue
  is a `blocker snapshot` line naming why, and `init` refuses.
  A `parked` one resumes instead, as before: nothing tied the pull request its result names to the issue's branch, so
  only a merge that passes the check takes it in.
  A result that parks an issue records the commit the forge shows its branch at then, or null when it shows none;
  a `pr_open` result records the head its pull request's check read, with no second read. A `pr_open` result whose
  pull request the forge shows merged by the time `wait` takes it in is checked as a `merged` one is, into the default
  branch of the pinned repository after the attempt started, and then records the issue done, with `reported: "pr_open"`
  in its results file; a merge that fails that check ends the attempt `bad_result`.
  A ledger written before heads were recorded has a latest result row with no `head` field at all: when that result
  named a pull request, `init` and its check read it through the forge and take its head commit, only when it is open,
  from that branch, in the pinned repository. That fallback trusts the pull request's head as the forge shows
  it now, not a commit the run recorded; a row with a `head` field, null included, never falls back.
  A resumed issue's first attempt goes on from its branch on the forge only when the branch holds that head, at it or
  after it; a branch at any other history is refused, and with no head, such as a run that parked before any push, the
  attempt is a plain first attempt, which refuses a branch the forge has already. A branch the forge no longer has is
  cut from the base tip, as a first attempt's, and only an attempt that goes on on the branch the forge has is told the
  earlier run's work and pull request are its own.
  A driver's input never gives `resumed`. Any other `started` issue is someone's work outside the run and stays blocked.
- `priority` is 1, the most urgent, to 4, or 0 for none, which comes last.
- `outside` lists the status of each blocker outside the project. A blocker that is not `completed`, or not listed, blocks.
- `teams`, optional, lists every team key of the tracker workspace, at most 500, each a capital letter then capitals or
  digits, such as `ENG`. The [`closes`](#when-it-is-on) check reads a token as an issue key only when its team is one of
  these or of the run's issues. With no `teams`, a key of a team outside the run is not seen: a named residual.
  The `project-autopilot` skill's first turn reads the tracker's team list into it. When the run's issue keys carry a
  team and `teams` is missing or empty, `init` prints a `teams:` line and `init --check` a `note teams` line that say so.
- Every other field, such as a title or a description, is dropped: no other tracker text enters the run's state.

The state folder is held as the [background route](handoff.md#the-background-route) holds its continuation store.
The working copy's `state.dir` must be the base branch's, and the folder the command resolves must be the one the base branch's
config names under the host's own environment, so an `XDG_STATE_HOME` or `HOME` set for the command cannot move it.
The state folder and its `runs/` folder may not be a symlink, lie inside a checkout, be another user's, or be writable by every user.
`init`, `next`, and `summary` each refuse a folder that fails a check, a base branch git cannot read,
and a project whose `config.json` the base branch does not commit.
A shell that exports `XDG_STATE_HOME` for every command moves the folder away from the one the host's own environment names,
so the commands refuse it: commit a `state.dir` in `config.json`, which both read the same.

`init` runs only from an attended main session. It refuses a subagent, a session the host names no id for,
and a session the background route started or is about to start; when the continuation store cannot be read, it refuses too.
The [project-init rule](hooks.md#bash-rules) denies the command to a subagent, whose shell carries the main session's id.
`--project` on `init` must name the project of the current folder's main checkout.
It pins the repository from the origin remote, refusing an owner or name of `.` or `..`, and records it in the ledger's first row
with the driver's session id and the sha256 and issue count of `snapshot.json`; `next` and `summary` refuse a snapshot that no
longer matches. Both files are read with no symlink followed, as regular files, under a size cap.
One run per project is active at a time.

`next` orders the issues by `blockedBy`, then by priority, then by key. It prints `next KEY BRANCH` for each issue to start,
`wait N running` when none may start while some run or a session runs on after its issue settled, or `done` when nothing
may start and nothing runs.
Lines for the issues that run, are blocked, or are skipped follow. An issue in a cycle of blockers is blocked.
An issue the ledger records parked, or a canceled one, is never started, and every issue that waits on it through issues not done
is skipped and names it. `--json` prints the whole plan, with the `maxParallel` it read.

`preflight [RUN]` runs, at once, every check a start would refuse or halt on, and starts nothing: the repository, the
state folder and any other active run but `RUN`, a host instruction file, such as a `CLAUDE.md`, in a folder above the
runs folder, which every attempt's clone would load, a commit in a clone made as an attempt's (`commit`: an empty commit
in a scratch repository with no template, its git folder apart, origin set to the main checkout's origin URL, and
signing off in its own config; with `RUN` named it lies in that run's attempts folder and checks out the run's first
issue branch, before a run exists in the runs folder on `fix/aidrian-commit-probe`; an `includeIf` on an attempt's
folder or branch may still read it otherwise, since that first issue may be done and the `.commit-probe-*` name is no
attempt's `<issue>.<attempt>`; the start's own check of each real clone guards signing only, so an identity that
differs there, as `user.useConfigOnly` with such an `includeIf` makes it, is an accepted residual: preflight passes,
the attempt's commit fails on identity, and that issue parks; the scratch is removed after;
preflight runs outside the issue session's sandbox, where the signing keys are in reach, so it blocks when git still
reads `commit.gpgsign` or `tag.gpgsign` as true there, as a `GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS` setting in
the environment makes it, or cannot read either, and otherwise on git's own error, such as no identity),
`projectRun.allow` through the forge, the machine's switch, the host's
start and its `projectRun.unverifiedHosts`, the host's access check (push rights, an HTTPS origin, nothing outside the
sandbox that `projectRun.outsideSandbox` does not name, and, on Claude Code, a forge token to hand the issue sessions,
from the project's keychain entry `projectRun.forgeTokenKeychain` names, the machine's default entry `aidrian-project-run`
for a github.com run alone, or the forge CLI's login, in that order, that the forge's push probe with that token says may write the repository,
then `token-reads`, the reads the issue session makes with that token, each a blocker line naming the fine-grained
permission to add, whatever else went unanswered, one `retry token-reads:` line naming the reads the forge could not
answer, whatever the reason,
and a `note token-reads:` line for the check rollup of a repository with no pull request yet
([Forge token permissions](project-run-setup.md#forge-token-permissions)), with a
`note token:` line that names the source it used and, for any token but a fine-grained one, its kind, never the token
itself), and whether the host carries on by itself after a usage limit
(in Claude Code, `"autoContinueAtUsageLimit": true` in the user's own settings, the one source preflight reads, so managed policy and `--settings` go unverified; the host ignores it in a project's settings), since
a limit is the account's and stops the driver with the issues' sessions. Then what the run needs to finish with no one:
the base branch's tracker, with no server in `projectRun.mcpServers` named like a tracker whose endpoint no adapter maps
(no tracker server there is a `note`: issue sessions then write no tracker, and the driver reports; a `note mcp-servers`
lists the servers the run rule maps to no tracker, each of which must be no tracker connection); auto-merge allowed on
the forge's default branch with `github.requiredChecks` listed and this machine's switch on; `session.handoff.continue`
set to `"background"`, since `"clear"` waits on a person; `github.reviewer`, with the bot seen on a recent
pull request and an active CI workflow, read through the forge; and, through the forge too, read with the token the
issue sessions get where the host hands one, as every start reads them again before it launches a session (a rule or
secret that does not hold halts the run there, and a read that fails retries the start), a rule on the default branch
that asks the signed-in user, whose token an issue's session keeps, for a pull request, administrator or not, with no
bypass for that user, and no rule at all for a user who administers the repository, whose token can turn any rule off
or edit its bypass list (`branch-protection`; an `ask` when the forge shows the branch protection's settings only to an
administrator, which halts a start), an active tag rule that names every tag, `~ALL` or `refs/tags/**/*` with no exclusion (a rule's `*` and
`**` stop at a slash, so `refs/tags/*` lets `release/v1` through), restricts creating
and updating a tag, and that user can never bypass, nor administers the repository (`release-tags`; a forge whose plan offers no such rule, as GitHub's
free plan for a private repository, has both blockers name the plan and its remedies, GitHub Pro for a personal
account's repository or GitHub Team for an organization's, or a public repository;
both are `note` lines naming the risk when the team sets `projectRun.forgeProtectionAccepted`), and no CI secret the repository's or its
organization's workflows see, or an open environment's (as [`projectRun.workflowSecretsAccepted`](#project-run) defines
one; a team may hold the signed-in user, so a reviewer rule that names a team holds nothing), whatever
the token's `workflow` scope, since the push and pull request workflows run the pushed branch's own code, unless the
team sets `projectRun.workflowSecretsAccepted` (`workflow-secrets`; the blocker says whether the token may also push a
workflow file); with a `note workflows` line: the forge runs a pushed
branch's workflow files, and the code they call, with the repository's secrets, so release and deploy secrets belong in
environments held for a reviewer who is not the signed-in user, that an environment limited to protected branches or
branch patterns counts as open, since a deployment branch rule is no hold against code the run pushes, that
`projectRun.workflowSecretsAccepted` accepts all current and future workflow secret exposure for project runs, the
repository's, its organization's, and every environment's secrets, so a team sets it only when that is acceptable,
and a cloud role trusted through OIDC federation for any ref of the repository (`repo:<owner>/<name>:*`) can be assumed
from any branch, and a `note triggers` line for other services that act on a push or a comment, such as
preview deploys and ChatOps bots. It prints `ok NAME`, `blocker NAME: WHY`, `note NAME: WHAT`,
or `ask NAME: WHAT` for a read the forge or tracker lacks, such as the decision label's existence, and exits 1 on any
blocker. `init RUN --file PATH --check` checks the input as `init` would, prints its blockers
(problems, cycles, issues started outside the run, a `resumed:` line for the started issues an earlier run parked, a `landed:` line for those whose pull request merged since, and, when `projectRun.mcpServers` holds no tracker server, each issue
that may still start with no text, never a canceled or skipped one) and the `next` lines, and writes no run. An issue's text never comes from a file a session
writes: after each call of a tracker's issue read (Linear's `get_issue` and `list_issues`), whatever `tracker.enabled`
says, in a project whose base branch's config.json sets `projectRun.allow`, the post-call tracker hook records each
issue the tracker's answer holds, by its key, its title, description, and labels, under the unattended marks
(`issue-reads/<session id>/`). The agent gate hook refuses a subagent's or an unattended session's write there as it
reads the call, the same check that keeps the marks: a command that hides the path from that reading, such as an
interpreter's one-liner that builds it, is not refused. `init` keeps, for each snapshot issue, the read its own session
recorded, its subagents' reads included, and none for an issue no read recorded, nor any read through a symlinked or
another user's folder. It then removes the session's recorded reads; the session-end hook removes them too (Claude
Code), and each new record, each `init`, and each `next` remove those older than a day, on every host. It keeps each text capped, with hidden characters and controls but line feeds and
tabs removed, in `<state>/runs/RUN/issues/ISSUE.json`, never in `snapshot.json`, and each start writes it read-only to the attempt's
`issue.md`, fenced and marked as untrusted text from the tracker, which the issue's session reads instead of the tracker. The `project-autopilot` skill runs both in its
attended first turn, and `init` last, once nothing blocks.

`report RUN [--json]` prints, for the driver only, the report the run owes each issue that settled for good, done after
a forge-confirmed merge or parked: a status (the adapter's done status type for a merge, `projectRun.blockedStatus` for a
blocked issue), `projectRun.decisionLabel` for any other, and a comment body with its sha256, with `--json` adding the
exact tool `calls` for the base branch's tracker. Both values come from the base branch's config. The body is built
from the ledger and from `results/ISSUE.json`, read again with no symlink followed, under its size cap, matched to the
ledger's run, issue, attempt, status, and pull request, and checked again; a file that fails gives a body from the
ledger alone that says so. `recorded RUN ISSUE` closes one, with a `recorded` row holding its attempt and sha256.
`end RUN` refuses while any issue still runs, naming them, or while a session runs on after its issue settled.

Every session a start held counts toward the run's caps until the host lists it ended, not only the session of an issue
that runs (`lib/project-linger.mjs`). An issue settles once `wait` takes in its result, often while its session still
finishes its last turn, and a session can keep working past it for good. While the host lists such a session as
working, `next` prints `wait N running`, counting it, and a `lingering <issue> attempt <n>` line (`--json` adds
`lingering`), `start` of any issue exits 75 with a `retry:` line that names it, a wait and not a refusal, and `end`
refuses. `wait` prints `lingering <issue> attempt <n>` and waits on it as on an issue that runs; it writes a `linger` row
the first time, and once 2 minutes have passed since that row it stops the session and writes a `gone` row with
`how: "stopped"`, printing `lingered <issue> attempt <n> stopped`. One the host lists as ended gets a `gone` row with
`how: "ended"`, from `wait`, `start`, or `end`, and `wait` prints `lingered <issue> attempt <n> ended` when it had seen it
run on. A session that cannot be stopped prints
`lingered <issue> attempt <n>: a session of it, <id>, ran on after its issue settled and could not be stopped; <how>`
each `wait`, where `<id>` is the session's id as its `started` line printed it, and `<how>` the host's own command that
stops it by hand, such as `` `claude stop <id>` stops it ``; so do the `overdue` and `limited` lines of a session `wait`
could not stop, `a session of it, <id>, could not be stopped; <how>`. An id of no session's shape is left out, and a
`<how>` that is empty or holds a character no display text keeps, such as a control, a line or paragraph separator,
a bidirectional mark, or a zero-width character, becomes `the host's own command stops it`.
The write-ahead row of a start asks the ledger again under its lock, so no start passes beside such a session.
`resume RUN`, from a session a person attends, also takes custody of a run whose driver's sessions the host lists as
ended, so that session drives on: a `driver` row moves custody, and the session's driver mark is filed.
A command whose ledger another process holds locked, and a `start` whose read of the team's policy the forge cannot
answer now, exit 75 with a `retry:` line, a refusal that may pass. A policy the forge answers and refuses, such as
`projectRun.allow` turned off on the default branch while the run's sessions run, makes `start` exit 1. Neither stops
`wait`, which starts nothing: it prints a first line and settles the run as before, exit 0, stopping each session past
its `projectRun.issueHours`. Each start row records the hours the team confirmed for it, as `issueHours`.
On a refusal, the line is `note policy: <why>`, and the hours are the lowest of the default, 6, its ceiling of 24, the
base branch's local ref, and the forge's own when it answered, so a bound the forge no longer confirms never loosens.
Through a forge outage or rate limit, the line is `note outage: <why>`, and each session's hours are the lowest of
those its start row recorded, the ceiling, and the base branch's local ref, or the default for a start row that
recorded none, so one failed read stops no session the team gave longer.
So the driver's halt wait reaches `idle` and `end` can follow.
`resume` names a driver it cannot read as an ended background session, such as the first one the Human ran: the Human
resumes that same host session, which keeps its id and custody.
A driver the host continued under a new id is stranded the same way, and only the continued session, attended,
resumes the run to drive on ([handoff.md](handoff.md#a-project-run)).

The [tracker write guard](#tracker) holds a project run's sessions whatever the working copy's `tracker.enabled` says,
knowing each by its marks alone, never the folder a call runs in. An issue's session writes only its own issue, by its
key, through its tracker's issue and comment tools and the fields its adapter lists: status `started`, an estimate,
a patch of its body, and a comment, each with no mention, link, address, image, HTML, or hidden character, a file or
host name in backticks; only the text a patch inserts is checked, never the anchors it matches. Result text the run
quotes keeps a file or host name as an inline code span. A live check is still owed: that Linear renders no link inside
inline code. The current
driver (a driver mark the ledger's custody confirms) writes only the calls `report` owes, each matching the status,
label, and body hash it printed, until `recorded`, and one more write: the started status of an issue the run started.
The `project-autopilot` loop sets it once, right after a start succeeds, so the tracker shows the issue in progress.
The guard allows it on an issue whose latest ledger state is running on a start that held its session (outcome
`started`), and that the snapshot holds as triage, backlog, or unstarted, as the adapter's issue tool with the issue's
key and the adapter's started status type alone (Linear `save_issue` with `id` and `state: "started"`, which the tracker
maps to the team's first started status). Any other field or status, a comment, or an issue that is queued, settled, or
open again is refused as any other write is. It owes no report and leaves no record. The loop tries a failed write at
most twice more right away, and the run's final report names an issue whose started status was never set; the issue's
own session sets `started` too, as its backup. A tracker whose adapter names no started status, as GitHub Issues, which
has no adapter, gets no such write. The write does not check the tracker's current status: the snapshot is taken at
init and the guard reads no tracker. So each write can set the issue back to the first started status once, when the
status moved after init, such as an issue a person moved on by hand, or between attempts, such as an issue the tracker
moved to In Review when an earlier attempt's pull request opened. In a run no Human attends, nobody moves its queued
issues. A driver mark the ledger does not confirm, as a continuation's
before its first `wait`, is held, and writes nothing: the background route files the driver's mark for a driver's
continuation as it starts it. For both, every call on the tracker's server is a write unless
its name says it reads, and the tracker's servers include those of `projectRun.mcpServers` whose endpoint an adapter
names. A server `projectRun.mcpServers` lists that no adapter maps, such as Linear's own server started by `npx`
under a name of the team's choosing, may be a tracker connection the rule cannot screen: on it, both are refused every
call whose name does not say it reads (`get_`, `list_`, `search_`, `read_`, and the other read verbs of the
[first-word check](#how-a-write-is-judged)), unless `projectRun.nonTrackerServers` names it as reaching no tracker.
To this rule a name says it reads only with a read verb other than `query`, which may run any statement, first, and no
write verb after it, such as `create`, `update`, `delete`, `add`, `set`, or `save`, in any of its words, so
`get_or_create_item`, `list_and_update`, and `getOrCreate` are writes. The driver runs with the user's own servers, not
`projectRun.mcpServers` alone, so it is held so on every server no adapter maps that `projectRun.nonTrackerServers`
does not name. `aidrian project preflight` notes each such server. When the base branch's config cannot be read, or the mark names no
project, which servers reach a tracker cannot be told, so both are refused that on every server no adapter maps; a held
session, which reads no base branch, always is. The rule runs under the [agent gate hook's time budget](hooks.md#agent-gates):
a call it cannot judge in time is refused to a marked, held, or driving session unless its name says it reads.
The driver may post an owed comment or status more than once before `recorded` closes it: the hook judges each call
against the report, not against what earlier calls wrote. A repeated status changes nothing, and a repeated comment is
a duplicate the driver's report already holds, an accepted residual.
A session that drove a run keeps the sign-off hold after `end`. A session no Human attends calls no tool a tracker's
merge verb names, on any server, and no session merges or
marks a pull request ready through a tracker's own tool: `gh pr merge` and `gh pr ready` are the routes the merge guard
and the ready hold judge. A marked session's base branch config is read through the main checkout its mark names, and
a read that fails refuses it.

### Recorded decisions

The team's `projectRun.recordedDecisions` switch lets the Human answer one decision of an issue before the run, so its
session does not park on it.
The answers live on the machine that runs the run, never in the repository: one team pull request turns the switch on,
and no issue needs one of its own.
The answer is one section of the issue's description in the tracker: an ATX heading of any level, outside code fences,
through the line before the next heading of the same or a higher level.
Write it so it stands alone, naming the question and the chosen path in full: a reference to text outside it, such as
an option's number or "as above", settles nothing.
A description that holds markup the tracker's view hides anywhere, fenced or not, voids every grant on the issue:
any `<!--`, any `<details` in any case, or a `+++` line: `+++` after optional spaces or tabs, alone or followed by a space or a tab.
The run keeps a description's first 20,000 characters, and a description cut off there voids every grant on the issue,
wherever the section sits: keep a pinned issue's description under the cap.

The store is `<state root>/recorded-decisions/<project key>/<ISSUE>.json`, `{ heading, sha256, by: "human", at }`, where
the state root is `$XDG_STATE_HOME/aidrian` or `~/.local/state/aidrian` and the project key names the project's state
folder under `projects/`.
It sits under the state root the environment names, as the [sign-off store](review.md#merge-trust) does, for its
writer and its readers alike, and is kept apart from the state folder's `decisions/`, the decision-review records.
Each folder is the user's alone, mode 0700, each file 0600, written whole and moved into place, as the sign-off store's.
Both stores are checked from the real path of the state root's parent down: a link from the state root on, a folder
another user owns or may write, or such a file voids the grant, and nothing is made, by a write or by a start's sandbox
denies, before those pass.
The [agent gates](hooks.md#agent-gates) refuse a write there by a subagent, a session no Human attends, or a run's
driver, and a confined session's sandbox denies the folder.

`aidrian project decision ISSUE --heading TEXT` prints that section and its sha256, from the attended session's recorded
tracker read of the issue, the bytes `init` keeps, and writes nothing.
Its last line prints the `--record` command to run, which writes the store's entry and prints where;
`aidrian project decision ISSUE --forget` removes it.
Either replaces or removes an entry whose content is malformed, once its place, owner, type, and links pass, and makes
no folder before the ones already there pass.
The printed `--record` command attaches the heading and the project's real path, each one single-quoted shell word,
`--heading='<heading>'` and `--project='<path>'`, so a heading that starts with `-` stays the option's value, nothing in
either expands, and the decision lands in the project the preview read, wherever the command is pasted.
With `--record` or `--forget`, a `--project` that is not the root of the project it resolves to, such as a removed
nested project or worktree, is refused, never written to the project above it.
It runs only from an attended main session that never drove a project run, in every form.
It exits 1 when the session recorded no read of the issue, the description was cut off or holds hidden markup, no
single section has that heading, or the store cannot be written.
The hash is the sha256 of the section's UTF-8, its heading line included, with CRLF read as LF, each line's trailing
blanks dropped, and blank lines at both ends dropped.

`init --check` reads the store as `start` does, only while the switch is on on the forge and the local ref alike.
For each issue that may still start, now or once its blockers are done, with an entry, it prints
`note recorded-decision: KEY stands: <heading>` or `note recorded-decision: KEY void: <why>`; a canceled issue, or one
skipped below it, gets none.
When that policy cannot be read, the base branch sets the switch, and the store holds an entry of such an issue, a
`blocker recorded-decision` names the read that failed.
An issue whose description no read of this session recorded is `blocker recorded-decision`: read it with the tracker's
own full issue read, then check again.

Each start reads the issue's entry and checks it against the text the run kept at `init`.
When it stands, the start writes the section to the attempt's `decision.md`, read-only beside `issue.md`, names it in
the first message, adds `decision: <sha256>` to the start row, and prints `recorded-decision: KEY stands`.
When it does not, the start prints `note recorded-decision: KEY void: <why>`, and the session starts as it would with no entry.
An entry recorded or forgotten during a run counts from the issue's next start; a section edited in the tracker after
`init` changes nothing until the next run's `init`.
The first message and the file say what the answer never does: change a step of the skills, waive a review, test,
check, hook, or gate, or allow a merge or ready.
It allows no real or personal data, no secret, and no new access, and it is no `security-engineer` verdict and no
sign-off of a pull request, so those park as before.
A result that still carries a decision parks as on any other issue, and a flow's sign-off at merge stays the Human's.
Forget the entry once the issue's pull request merges.

### Full auto

The team's `projectRun.fullAuto` switch lets a run go on when the host continues its driver under a new session id,
as Claude Code does when it continues a session as a fork, with no person to take the run up.
The session the host's own record names, and only that one, runs `aidrian project resume RUN --custody` and drives on:
the [hook](hooks.md#agent-gates) lets that exact command through where the local base ref sets the switch, and the
command checks the forge's copy too.
It moves custody only, files a plain unattended mark beside the driver mark, and writes no `resume` row
([A project run](handoff.md#a-project-run)).

It changes nothing else.
The decision settings stay the one lever for what a run settles alone: `decisions.mode`, `decisions.unattended`, and
[recorded decisions](#recorded-decisions).
It merges nothing the auto-merge gate would hold, gives no sign-off a flow asks the Human for, and lifts no halt.
A run whose driver chain ended, with no session the host continued its driver as, still waits for the Human.

With the switch on, `aidrian project preflight` prints a `note full-auto:` line, then one `note human:` line for each
thing that still waits on a person: a policy file's pull request, the default branch's sign-off flows with
`signoff: "human"`, a floor-class decision with no recorded answer, with the count of grants pinned on this machine,
a halt, and a run whose driver chain ended.
A policy file's pull request never merges by itself, unless `github.autoMerge.includePolicyFiles` counts: then it merges
with no sign-off of the Human, but for a change to `github.requiredChecks`, `conditionalChecks`,
`ignoreCancelledChecks`, or `state.dir`, which the `checks` row keeps for the Human.
The harness-config sign-off still applies while either branch's review runs a command of the project's, and when the
policy file is also a doc a flow's invariants cite.
One more `note human:` line names each setting that parks more than it must: `decisions.mode` or `decisions.maxMode`
below `"decide-reversible"`, `decisions.unattended.safeDefaults` other than `"all"`, and
`github.autoMerge.includeGuardedPaths` off.
The driver hands the Human every such line in its one turn-1 message, as the complete list.
The grant count is this machine's store, read as a start reads it, and a count only: a run driven from another machine
sees none, and a grant stands only at a start whose kept text still hashes so.

## Testing

CI runs the full suite on a pushed head, so a session pushes a fix and runs locally only the test files it touches.
With `testing.pushFirstMinutes` above 0, the [push-first rule](hooks.md#push-first) refuses a command of
`testing.fullSuite` while the branch's remote copy lacks a commit older than that many minutes, and names
`aidrian test changed`, which runs `testing.changedCommand` with those files. The default, 0, leaves it off: a project
whose CI runs its suite opts in. The [check-run record](hooks.md#check-runs) reads both lists as test runs, so a project's
own suite script, such as `npm run check`, belongs in `fullSuite`.
An older plugin rejects the `testing` keys as unknown, so set [`requires.aidrian`](#plugin-version) to the release that ships them.

```json
{ "testing": { "fullSuite": ["npm run check"], "changedCommand": "node --test --import ./scripts/test-state.mjs", "pushFirstMinutes": 5 } }
```

## Session snapshot

`aidrian session snapshot [--session ID] [--transcript PATH] [--ticket-prefixes A|B] [--deadline-ms N] [--json|--line]`
prints what a status line shows for a session: its handoff numbers, from `session.handoff`, the pull requests it
touched (`prs`), and the project's open lessons, worktrees, provisional decisions, untriaged audit findings, and the
session's tickets ([Handoff](handoff.md#the-snapshot)).
`prs` shows the pull requests of the session's [ledger](hooks.md#session-ledger) only on the hosts a forge adapter
declares, github.com today, read in one forge call. The ledger hook records rows only on those hosts, so an unsupported
row, on any other host, appears only from a ledger written another way, such as by a later adapter. It reads at most 25
refs, the newest: each ref is a pull request number or a branch, counted before branches resolve, so a branch with no
pull request uses one, and fewer than 25 pull requests can show while an older one is left out.
After a handoff, `prs` also shows the open pull requests the sessions it came from created or pushed, each
`inherited: true`. `tickets` lists up to 10 keys, `[]` when none: the current branch's (`source: "branch"`), those of
the branches the session's ledger, or an earlier session's, recorded (`source: "ledger"`), and those the pull requests
`prs` shows name in their closing references or their titles (`source: "pr"`), read in the same one forge call
([The tickets](handoff.md#the-tickets)).
`links` shows the worktree the session, or an earlier one, created with `aidrian worktree new`, while git still lists
it ([The worktree](handoff.md#the-worktree)).
Unlike the other commands it never stops on a `config.json` with errors: like the hooks, it uses the default in place
of each bad value, and a section that cannot be read is null with its name in `errors`, so the status line keeps working.

## Checking

`aidrian check` validates this file with the rest of the project folder.
It lists every problem: a missing file, invalid JSON, a missing or other `version`, an unknown key, or a value of the wrong type.
In `quorum`, that includes a `provider` on `quorum.plan.a`, a `provider` other than `"agent"` or `"codex"`,
a `plan.maxObjections` outside 1 to 5, a `plan.maxDispatches` under 5 or not a whole number, and an `agent` that is no agent name.
In `tracker`, it includes a `provider` no adapter has, a bad tool pattern, one that does not start with `mcp__`, a `*` in `readTools`,
a read tool that `writeTools` covers, a `team.key` with a hyphen or whitespace, a group missing a key,
a `workspace` without `readTools`, `readTools` without a `workspace`, a write tool no read can clear, and `enabled: true` with no `writeTools`,
or with none of `workspace`, `team`, or `project`.
Each message names the key, such as `quorum.plan.b.provider`.
A key with a bad value falls back to its default, so the plugin's hooks keep working until the file is fixed,
but for a write tool no read can clear, which stays and is refused at run time.
