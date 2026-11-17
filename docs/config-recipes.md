# Config recipes

Three starting configs, from the most autonomous to the most hands-on. Pick the one closest to how the Human works,
copy its two files, and change what the project needs. Each is checked by `test/config-recipes.test.mjs`:
`aidrian check` passes on it, and this page shows the files in [`plugins/aidrian/recipes/`](../plugins/aidrian/recipes) exactly.
The `harness-setup` skill offers them as its working-style question.

| Recipe | The Human | Sessions stop for |
| --- | --- | --- |
| [Full autonomy](#full-autonomy) | Is not there | A security verdict or a critical-flow sign-off; every other call takes a safe default |
| [Autopilot](#autopilot) | Supervises several sessions from above | Product calls, extra review rounds, the floor classes |
| [Hands-on](#hands-on) | Works beside each session | Every decision, the ready mark, the review loop, the handoff |

How to apply one:

1. Merge the recipe's `config.json` into `.aidrian/config.json` and commit it on the default branch.
   The team switches (`autoMerge.allow`, `unattendedWaiver.allow`, the handoff route) are read from the base branch,
   never from the working copy, so they count only once merged.
2. Copy its `local.json` to `.aidrian.local.json` in the main checkout, on each machine that takes part.
   That file is git-ignored, and a subagent may not write its switches: the Human, or the main session, does.
3. Replace `"test"` in `github.requiredChecks` with the names of the project's CI checks. Auto-merge stays off without one.
4. Set [`requires.aidrian`](config.md#plugin-version) to the plugin release the project runs, since an older plugin
   rejects keys it does not know.

A recipe sets only the keys it changes; [config.md](config.md#keys) holds every key and its default.
It sets nothing about the host's own permissions: how often Claude Code or Codex asks before a tool runs is the host's
setting, and the more autonomous recipes pay off only with a permission mode that does not stop each command.

## Full autonomy

No one is watching. A session takes a task to a merged pull request and continues itself in a new session when its
context grows, and the Human reads the results afterwards: the merged pull requests, the decisions queued in their
bodies, and the lesson inbox.

Team, `.aidrian/config.json`:

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

Machine, `.aidrian.local.json`:

```json
{
  "github": { "autoMerge": { "enabled": true }, "unattendedWaiver": { "enabled": true } },
  "unattendedSignoff": "on",
  "handoff": { "background": "on" }
}
```

What it turns on:

- Pull requests are marked ready and merged with no one asking, once `aidrian pr checks` and the review pass
  ([Auto-merge](config.md#auto-merge)). `default: "on"` makes every machine with no local setting take part.
- At the review round cap, a judge grants one more round (`extraRounds: "auto"`), and a judge's recorded verdict can
  stand in for the Human's answer to the merge guard ([Unattended waiver](config.md#unattended-waiver)) and close a
  disputed invariant ([unattended rulings](review.md#unattended-rulings)).
- Agents settle every reversible decision ([Decisions](config.md#decisions)), and an unattended run takes a safe default
  even on a floor class (`safeDefaults: "all"`). A hard product call runs a quorum, and work goes on on its ruling.
- The handoff continues in a background session with nothing typed, up to 5 in a row ([Handoff](handoff.md)).
- Persona-audit triage files issues without asking.

What it still keeps for a person: a security verdict and a critical-flow sign-off, which no setting hands to an agent;
a pull request that edits what steers the harness, such as `AGENTS.md`, a skill, or `.claude/`, unless the team also sets
`github.autoMerge.includeGuardedPaths` after reading its risk; and a merge that branch protection forbids.

## Autopilot

The Human runs several sessions at once and looks in now and then. Sessions do the routine work alone and stop at a
few points that keep them from drifting: a product call, a review that needs a round past the cap, and a merge on a
machine that has not opted in.

Team, `.aidrian/config.json`:

```json
{
  "version": 1,
  "github": {
    "requiredChecks": ["test"],
    "markReady": "auto",
    "reviewLoop": "auto",
    "extraRounds": "ask",
    "autoMerge": { "allow": true, "default": "off", "strategy": "squash", "deleteBranch": true, "deleteWorktree": true }
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

Machine, `.aidrian.local.json`:

```json
{
  "github": { "autoMerge": { "enabled": true } },
  "handoff": { "background": "on" }
}
```

What it turns on, and where it stops:

- Ready marks and the review loop run alone. Auto-merge is allowed, but `default: "off"` lets each machine choose;
  the local file above opts this one in. A machine without it gets a ready pull request to merge by hand.
- Agents settle reversible UX, architecture, and backlog decisions. Product decisions ask (`domains.product: "ask"`),
  and a hard product call first runs a quorum, so the question the Human gets comes with a recommendation.
- An extra review round past the cap needs the Human's yes (`extraRounds: "ask"`), and so does a waiver: it is left off.
- An unattended run parks a floor-class decision for the Human instead of taking a default.
- The handoff continues in the background, up to 3 in a row before a person looks.

## Hands-on

The Human works beside each session and wants the harness's checks without its autonomy. This is the most
interrupting recipe: sessions ask before each decision, before the review loop, before marking a pull request ready,
and before a handoff.

Team, `.aidrian/config.json`:

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

Machine, `.aidrian.local.json`: none needed. Its file is empty:

```json
{}
```

What it turns on:

- The [main-checkout guard](hooks.md#main-checkout): work happens in task worktrees, never in the folder the Human uses.
- The [review gate](config.md#review-gate): the review bot is asked only once a local review of the diff is on record.
- Every decision goes to the Human, and the second look starts at `medium` severity instead of `high`.
- The review loop is offered, not started, and the author marks a pull request ready. Nothing merges unasked.
- The session-length reminder asks before a handoff, and the handoff writes a brief only.
- Persona-audit triage confirms each issue before creating it.
