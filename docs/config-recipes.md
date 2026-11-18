# Config recipes

Three starting configs for a project, from the most autonomous to the most hands-on, written for a developer working
alone. Pick the one closest to how the Human works, copy it, and change what the project needs. Each is checked by `test/config-recipes.test.mjs`:
`aidrian check` passes on it, and this page shows each file in [`plugins/aidrian/recipes/`](../plugins/aidrian/recipes) exactly.
The `harness-setup` skill offers them as its working-style question.

| Recipe | The Human | Sessions stop for |
| --- | --- | --- |
| [Full autonomy](#full-autonomy) | Is not there | Security verdicts, critical-flow sign-offs, and hard product calls in a floor class |
| [Autopilot](#autopilot) | Supervises several sessions from above | Product calls, extra review rounds, the floor classes |
| [Hands-on](#hands-on) | Works beside each session | Every decision, the ready mark, the review loop, the handoff |

How to apply one:

1. Merge the recipe into `.aidrian/config.json` and commit it on the default branch.
   Its switches, such as `autoMerge.allow`, are read from the base branch, never from the working copy,
   so they count only once merged.
2. Add the machine switches the recipe names, if any, to `.aidrian.local.json` in the main checkout.
   A few switches live only there, so that a pull request can never turn them on; a subagent may not write them.
3. Replace `"test"` in `github.requiredChecks` with the names of the project's CI checks. Auto-merge stays off without one.
   In a recipe that merges alone, replace the placeholder screen target too, `src/app/**` at `/`, with the project's
   web screen files and routes. With no web screen, leave out `review.visual`, and with no screen at all, both keys:
   [Screens checked on every device](#screens-checked-on-every-device).
4. Set [`requires.aidrian`](config.md#plugin-version) to the plugin release the project runs, since an older plugin
   rejects keys it does not know.

A recipe sets only the keys it changes; [config.md](config.md#keys) holds every key and its default.
The two that merge alone, full autonomy and autopilot, also turn on a screen check: `review.visual` captures for the
visual reviewers and `review.productFeedback` before the ready mark, around a placeholder target that setup replaces,
as it replaces `"test"`. What each part needs to run, and what it does without it, is in the section below.
Hands-on leaves that check out, since the Human tries the screens, and can add it:
[Screens checked on every device](#screens-checked-on-every-device).
It sets nothing about the host's own permissions: how often Claude Code or Codex asks before a tool runs is the host's
setting, and the more autonomous recipes pay off only with a permission mode that does not stop each command.

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
  "review": {
    "unattendedSignoff": { "allow": true },
    "visual": { "platform": "web", "targets": [{ "files": ["src/app/**"], "routes": ["/"] }], "viewports": [390, 1024, 1440] },
    "productFeedback": { "auto": true }
  },
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
- The screen check: a user-facing change owes product feedback before the ready mark, with a persona walk when the
  project has a persona. A change to a screen a target names is captured at a phone, a tablet, and a desktop width only
  when the review runs a visual reviewer and the capture can reach the app; the recipe adds no flow that requires one,
  so add the review doc's flow to put one in the plan
  ([Screens checked on every device](#screens-checked-on-every-device)).

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
  "review": {
    "visual": { "platform": "web", "targets": [{ "files": ["src/app/**"], "routes": ["/"] }], "viewports": [390, 1024, 1440] },
    "productFeedback": { "auto": true }
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
- The same screen check as full autonomy, with the same needs.

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

## Screens checked on every device

Full autonomy and autopilot merge with no person looking, so they turn on two checks of a screen change:

- `review.visual` captures each route a change touches at 390, 1024, and 1440 px, a phone, a tablet, and a desktop,
  for the visual reviewers to check. A route is touched when a changed file matches its target's `files`, and the
  capture runs only when the review's plan holds a visual reviewer, `designer` or `ux-specialist` by default.
  The recipes add no flow that requires one, so a review whose plan leaves both out captures nothing. The
  `staff-screens` flow of [the review doc's config](review.md#screens-checked-on-every-device), which requires
  `agent:designer` and `agent:ux-specialist`, puts them in the plan of each change that triggers it.
- `review.productFeedback.auto` makes a user-facing pull request owe product feedback before it is marked ready: the
  `product-manager` agent's read, and a persona's walk of the change in the running app when the project has a usable
  persona. The feedback is no approval and no merge block; only the ready mark waits for it.

A change that matches only `review.productFeedback.files`, and no target, gets feedback but no capture.
Product feedback reads `files`, and the targets, from the default branch and the base, never from the pull request:
a pull request that adds a path to the list does not owe feedback for that path itself; the next one does.

The target, `{ "files": ["src/app/**"], "routes": ["/"] }`, is a placeholder, as `"test"` is: replace it with the
project's screen files and the routes that show them, one target per group of screens. The `harness-setup` skill does
this when it applies the recipe. [Screens checked on every device](review.md#screens-checked-on-every-device) has a
fuller config, with a flow whose invariants block the review, and what each key does.
`platform` takes only `"web"` today: the capture opens routes in Playwright, and no adapter captures a native app.

Set `review.productFeedback.files` too, to the project's whole UI surface: every screen component, the hooks and
helpers beside them, the locales, and the styles. Unset, product feedback falls back to the visual targets' files,
which name only the routes worth capturing. A pull request whose every changed file is outside the lists of both the
default branch and the base then reads as `not_user_facing`, unless it holds a rename, a file with no change type, or
more files than its list shows, which count as user-facing ([`status`](config.md#the-commands)). In one real project
the fallback left out about 800 UI files, whole sections, every locale file, and the UI hooks among them: a pull
request that changed only those read as `not_user_facing`, and the ready hold let it through with no feedback.
The recipes leave `files` out on purpose, since a placeholder there would hide the same gap.

What each part needs, and what happens without it:

- **Images**: Playwright in the project's dependencies and a base URL, `review.visual.baseUrl` in `.aidrian.local.json`
  or a `preview` command. Without either, the visual reviewers get a status instead of images and review from the code;
  the review goes on.
- **The persona walk**: a usable persona doc for the people who use the screens ([Personas](personas.md)). Without
  one, only the `product-manager` read runs.

A project with no screens yet leaves out `review.visual` and `review.productFeedback`: `review.visual.targets` may not
be empty, and a target that matches no file checks nothing. With its first UI of any kind, native included, the team
turns on `review.productFeedback.auto` with `files` for that UI, and adds `review.visual` only for web screens.
Do not wait for a warning: while auto-merge is allowed, `aidrian check` warns once git tracks a web screen file and
`review.visual` is still unset, but a native screen never triggers it, and the warning says nothing of product feedback.
[Auto-merge](config.md#auto-merge) says what counts as a screen file: web screen extensions only, so a `.tsx` or `.jsx`
file whose nearest `package.json` depends on `react-native` and not on `react-dom` does not count.

A project whose screens are all native, such as an iOS, Android, or React Native app, leaves out `review.visual`, since
no capture reaches its screens, and still sets `review.productFeedback` with `files` for its UI, so its changes still
owe product feedback before the ready mark.

Hands-on leaves the check out, since the Human is there to try the screens. A hands-on project that wants the captures
too adds the same two keys, or the fuller config of the review doc.

How a flow on the screens, as in the review doc's config, sits with each recipe:

- **Full autonomy**: leave `signoff` on the flow unset. The flow's reviewers close its invariants from the captures,
  and a disputed one goes to an [unattended ruling](review.md#unattended-rulings). `"signoff": "human"` makes every
  pull request that touches the screens wait for a person, which this recipe exists to avoid. Its
  `quorum.product.autoStart` is already on.
- **Autopilot**: the same, with `"signoff": "human"` only on the one or two flows a person must try before a merge.
  Its `quorum.product.autoStart` is already on.
- **Hands-on**: `"signoff": "human"` fits, since the Human is there to try the screens. Leave
  `quorum.product.autoStart` off: every product decision already goes to the Human, and the quorum would add dispatches
  before each question.

The persona walk runs at the persona's own device width only; the captures cover the other widths.
