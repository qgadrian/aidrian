# Config recipes

Four starting configs for a project, from the most autonomous to the most hands-on, written for a developer working
alone. Pick the one closest to how the Human works, copy it, and change what the project needs. Each is checked by `test/config-recipes.test.mjs`:
`aidrian check` passes on it, and this page shows each file in [`plugins/aidrian/recipes/`](../plugins/aidrian/recipes) exactly.
The `harness-setup` skill offers them as its working-style question.

| Recipe | The Human | Sessions stop for |
| --- | --- | --- |
| [Full autonomy, solo](#full-autonomy-solo) | Runs the project alone, and is not there for a whole tracker project | The same as full autonomy |
| [Full autonomy](#full-autonomy) | Is not there | Security verdicts, critical-flow sign-offs, and hard product calls in a floor class |
| [Autopilot](#autopilot) | Supervises several sessions from above | Product calls, extra review rounds, the floor classes |
| [Hands-on](#hands-on) | Works beside each session | Every decision, the ready mark, the review loop, the handoff |

How to apply one:

1. Merge the recipe into `.aidrian/config.json` and commit it on the default branch.
   Its switches, such as `autoMerge.allow`, are read from the base branch, never from the working copy,
   so they count only once merged.
2. Add the machine switches the recipe names, if any, to `.aidrian.local.json` in the main checkout.
   A few switches live only there, so a pull request alone never turns them on: [`solo`](config.md#solo), committed on
   the default branch, turns the unset ones on, and only the Human merges the change that adds it. A subagent may not
   write them.
   No recipe sets one in `config.json`, and none opens a project run's sandbox further: a team adds
   `projectRun.registries`, `unverifiedHosts`, `outsideSandbox`, or `mcpServers` itself, after reading its risk.
3. Replace `"test"` in `github.requiredChecks` with the names of the project's CI checks. Auto-merge stays off without one.
4. Set [`requires.aidrian`](config.md#plugin-version) to the plugin release the project runs, since an older plugin
   rejects keys it does not know.

A recipe sets only the keys it changes; [config.md](config.md#keys) holds every key and its default.
It sets nothing about the host's own permissions: how often Claude Code or Codex asks before a tool runs is the host's
setting, and the more autonomous recipes pay off only with a permission mode that does not stop each command.

## Full autonomy, solo

One person owns the project and runs whole tracker projects with no one watching, with the `project-autopilot`
skill: one attended first turn, then a session per issue. It is the [full autonomy](#full-autonomy) recipe, with two
keys more.

`.aidrian/config.json`:

```json
{
  "version": 1,
  "solo": true,
  "github": {
    "requiredChecks": ["test"],
    "markReady": "auto",
    "reviewLoop": "auto",
    "extraRounds": "auto",
    "autoMerge": { "allow": true, "default": "on", "strategy": "squash", "deleteBranch": true, "deleteWorktree": true },
    "unattendedWaiver": { "allow": true }
  },
  "review": { "unattendedSignoff": { "allow": true } },
  "decisions": {
    "mode": "decide-reversible",
    "maxMode": "decide-reversible",
    "unattended": { "safeDefaults": "all" }
  },
  "quorum": { "product": { "autoStart": true, "approval": "review-later" } },
  "session": { "handoff": { "mode": "auto", "continue": "background", "maxChain": 5 } },
  "audits": { "triage": { "issueCreation": "auto" } },
  "projectRun": { "allow": true }
}
```

No machine switch: [`solo`](config.md#solo) turns on each of the three that full autonomy names, the unattended
waiver, `unattendedSignoff`, and `handoff.background`, on every machine whose local file leaves it unset.
A local `"off"`, or a local file that git tracks or that has an error, still wins on that machine.

What it adds to full autonomy:

- `solo` is read from the default branch on GitHub, and its local ref must say it too, so a working copy or a pull
  request alone turns nothing on. A pull request that adds it changes a policy file, which auto-merge never lets
  through: the Human merges it. Whoever can push to the default branch turns the switches on for every machine that
  sets none, so protect it with no bypass.
- [`projectRun.allow`](config.md#project-run) lets the `project-autopilot` skill start a run. Its other keys keep
  their defaults: one issue at a time, at most 300 sessions a run, and 6 hours an issue.

What a project run needs beyond this recipe; `aidrian project preflight`, in the run's first, attended turn, names each
one missing as a blocker, but the registries:

- `github.reviewer`, the review bot every unattended merge waits on, and `tracker.provider`.
- `projectRun.unverifiedHosts: true`, set after reading its risk: no live run has verified either host's project
  start yet ([Claude Code](providers/claude-code.md#project-start), [Codex](providers/codex.md#project-start)).
- `projectRun.registries` for the package registries the project installs from, when its sessions install
  dependencies; this recipe lists none, since each one widens the hosts the sandbox reaches, and most give a channel
  out of it ([Project run](config.md#project-run)).
- On Claude Code, `"autoContinueAtUsageLimit": true` in the user's own settings, since a usage limit stops the driver too.

How a run relates to the handoff chain, and what stops it for a person, are in [Handoff](handoff.md#a-project-run).

## Full autonomy

No one is watching. A session takes a task to a merged pull request and continues itself in a new session when its
context grows, and the Human reads the results afterwards: the merged pull requests, the decisions queued in their
bodies, and the lesson inbox.

`.aidrian/config.json`:

```json
{
  "version": 1,
  "github": {
    "requiredChecks": ["test"],
    "markReady": "auto",
    "reviewLoop": "auto",
    "extraRounds": "auto",
    "autoMerge": { "allow": true, "default": "on", "strategy": "squash", "deleteBranch": true, "deleteWorktree": true },
    "unattendedWaiver": { "allow": true }
  },
  "review": { "unattendedSignoff": { "allow": true } },
  "decisions": {
    "mode": "decide-reversible",
    "maxMode": "decide-reversible",
    "unattended": { "safeDefaults": "all" }
  },
  "quorum": { "product": { "autoStart": true, "approval": "review-later" } },
  "session": { "handoff": { "mode": "auto", "continue": "background", "maxChain": 5 } },
  "audits": { "triage": { "issueCreation": "auto" } }
}
```

Machine switches, in `.aidrian.local.json`:

```json
{ "github": { "unattendedWaiver": { "enabled": true } }, "unattendedSignoff": "on", "handoff": { "background": "on" } }
```

What it turns on:

- Pull requests are marked ready and merged with no one asking, once `aidrian pr checks` and the review pass
  ([Auto-merge](config.md#auto-merge)). `default: "on"` needs no machine switch.
- At the review round cap, a judge grants one more round (`extraRounds: "auto"`), and a judge's recorded verdict can
  stand in for the Human's answer to the merge guard ([Unattended waiver](config.md#unattended-waiver)) and close a
  disputed invariant ([unattended rulings](review.md#unattended-rulings)).
- Agents settle every reversible decision ([Decisions](config.md#decisions)), and an unattended run takes a safe default
  even on a floor class (`safeDefaults: "all"`). A hard product call runs a quorum, and work goes on on its ruling,
  unless the call is in a floor class, such as money or data loss: then the ruling waits for a person, and the work that
  depends on it is parked.
- On Claude Code, the handoff continues in a background session with nothing typed, up to 5 in a row ([Handoff](handoff.md)).
  Codex has no background route: there the handoff writes a brief, and a person resumes it.
- Persona-audit triage files issues without asking.

What it still keeps for a person: a security verdict and a critical-flow sign-off, which no setting hands to an agent;
a hard product call in a floor class, after its quorum; on Codex, resuming a handoff;
a pull request that edits what steers the harness, such as `AGENTS.md`, a skill, or `.claude/`, unless the project also sets
`github.autoMerge.includeGuardedPaths` after reading its risk; and a merge that branch protection forbids.

## Autopilot

The Human runs several sessions at once and looks in now and then. Sessions do the routine work alone and stop at a
few points that keep them from drifting: a product call and a review that needs a round past the cap.

`.aidrian/config.json`:

```json
{
  "version": 1,
  "github": {
    "requiredChecks": ["test"],
    "markReady": "auto",
    "reviewLoop": "auto",
    "extraRounds": "ask",
    "autoMerge": { "allow": true, "default": "on", "strategy": "squash", "deleteBranch": true, "deleteWorktree": true }
  },
  "decisions": {
    "mode": "decide-reversible",
    "maxMode": "decide-reversible",
    "domains": { "product": "ask" }
  },
  "quorum": { "product": { "autoStart": true, "approval": "first" } },
  "session": { "handoff": { "mode": "auto", "continue": "background", "maxChain": 3 } }
}
```

Machine switch, in `.aidrian.local.json`:

```json
{ "handoff": { "background": "on" } }
```

What it turns on, and where it stops:

- Ready marks, the review loop, and the merge run alone, once `aidrian pr checks` and the review pass.
- Agents settle reversible UX, architecture, and backlog decisions. Product decisions ask (`domains.product: "ask"`),
  and a hard product call first runs a quorum, so the question the Human gets comes with a recommendation.
- An extra review round past the cap needs the Human's yes (`extraRounds: "ask"`), and so does a waiver: it is left off.
- An unattended run parks a floor-class decision for the Human instead of taking a default.
- On Claude Code, the handoff continues in the background, up to 3 in a row before a person looks.
  On Codex it writes a brief for a person to resume.

## Hands-on

The Human works beside each session and wants the harness's checks without its autonomy. This is the most
interrupting recipe: sessions ask before each decision, before the review loop, before marking a pull request ready,
and before a handoff.

`.aidrian/config.json`:

```json
{
  "version": 1,
  "git": { "mainCheckout": { "guard": true } },
  "github": {
    "markReady": "ask",
    "reviewLoop": "ask",
    "extraRounds": "ask",
    "reviewGate": { "enabled": true, "checklist": null }
  },
  "decisions": { "mode": "ask", "maxMode": "ask", "secondLook": { "agent": "critic", "minSeverity": "medium" } },
  "session": { "handoff": { "mode": "ask", "continue": "none" } },
  "audits": { "triage": { "issueCreation": "confirm" } }
}
```

No machine switch.

What it turns on:

- The [main-checkout guard](hooks.md#main-checkout): work happens in task worktrees, never in the folder the Human uses.
- The [review gate](config.md#review-gate): the review bot is asked only once a local review of the diff is on record.
- Every decision goes to the Human, and the second look starts at `medium` severity instead of `high`.
- The review loop is offered, not started, and the author marks a pull request ready. Nothing merges unasked.
- The session-length reminder asks before a handoff, and the handoff writes a brief only.
- Persona-audit triage confirms each issue before creating it.
