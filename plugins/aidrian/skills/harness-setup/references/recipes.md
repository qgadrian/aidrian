# Working-style recipes

Q7 of the `harness-setup` skill, and how the step 3 brief applies its answer.
The recipes are `<plugin root>/recipes/<name>.json`. The plugin repository's `docs/config-recipes.md` explains each key.

## The question

Ask it before the main-checkout guard question, whose answer hands-on sets, as one question with these four choices,
in this order. Claude Code's question tool takes at most four, so the solo recipe is a follow-up, never a fifth choice:

1. **Keep the defaults** (recommended until the project has used the harness): every decision asks, pull requests are
   marked ready and reviewed alone, and nothing merges unasked.
2. **Hands-on** (`hands-on`): the Human works beside each session. Sessions ask before each decision, the review loop,
   the ready mark, and a handoff. The most interrupting.
3. **Autopilot** (`autopilot`): the Human supervises several sessions from above. Sessions merge, decide reversible
   non-product calls, and hand off alone on Claude Code, and stop for product calls and extra review rounds.
4. **Full autonomy** (`full-autonomy`): no one watches. Sessions merge, decide, and continue alone, and an unattended
   run takes a safe default even on a security, critical-flow, money, or data-loss call. A security verdict, a
   critical-flow sign-off, and a hard product call in one of those classes still wait. On Codex, a handoff waits for a
   person to resume it.

Only when the answer is Full autonomy, ask one more question: does one person own the project, and should sessions
also run whole tracker projects with no one watching? Two choices, in this order:

- **No** (recommended unless one person owns the project and its default branch is protected with no bypass): the
  `full-autonomy` recipe.
- **Yes, solo** (`full-autonomy-solo`): full autonomy, and whole tracker projects run with the `project-autopilot`
  skill. `solo: true` turns the machine switches on with no local file, on every machine that leaves them unset, and
  `projectRun.allow` lets a run start. Only for a project whose default branch is protected with no bypass.

## Applying it, in the step 3 brief

- Merge the recipe into `.aidrian/config.json`, key by key; a key the project already sets keeps its value,
  and the proposal names each kept key. Leave out `git.mainCheckout`: Q5 writes the guard, last.
- `github.requiredChecks`: put the names of the CI checks the project's workflows run on a pull request in place of `"test"`.
  With none found, leave the key out, and the report says auto-merge stays off until it names one.
- `full-autonomy`, `full-autonomy-solo`, and `autopilot`: put the project's web screens in place of the placeholder target in `review.visual.targets`,
  one target per group of screens, each with its files' globs and the routes that show them. `review.visual.platform`
  takes only `"web"`: with no web screen, such as a native-only app, leave out `review.visual` and still set
  `review.productFeedback` with `files`, and the report says no capture covers its screens. Set
  `review.productFeedback.files` to the project's UI file patterns: every screen component, the hooks and helpers beside
  them, the locales, and the styles. Unset, it falls back to the targets' files, and a pull request whose every changed file is outside them, on the
  default branch and the base alike, can pass with no feedback. With no screen yet, leave out
  `review.visual` and `review.productFeedback`. The report says the screen check is off, and that with the first UI of
  any kind, native included, the team turns on `review.productFeedback.auto` with `files`, and adds `review.visual`
  only for web screens. `aidrian check` warns only about a tracked web screen, so a native screen gets no reminder.
- Set `requires.aidrian` to the running plugin's version when the recipe sets any `github.autoMerge`,
  `unattendedWaiver`, `review.unattendedSignoff`, `session.handoff.continue`, `solo`, or `projectRun` key.
- `full-autonomy-solo`: the report says the Human merges the change that adds `solo`, since auto-merge never merges a
  policy file, and names what a project run still needs, which `aidrian project preflight` checks: `github.reviewer`,
  `tracker.provider`, `projectRun.unverifiedHosts`, which the team sets only after reading its risk, and, on Claude
  Code, `"autoContinueAtUsageLimit": true` in the user's own settings, since a usage limit stops the run's driver too.
  The proposal never adds `projectRun.registries`, `unverifiedHosts`, `outsideSandbox`, or `mcpServers`.
- Never write `.aidrian.local.json`: the config guard refuses a subagent's write of its switches. Return the recipe's
  machine switches below, for the Human to add in the main checkout. The report prints them.

## Machine switches

Switches only `.aidrian.local.json` holds, so a pull request alone never turns them on: `solo`, committed on the
default branch, turns the unset ones on, and only the Human merges the change that adds it.

- `full-autonomy`: `{ "github": { "unattendedWaiver": { "enabled": true } }, "unattendedSignoff": "on", "handoff": { "background": "on" } }`
- `autopilot`: `{ "handoff": { "background": "on" } }`
- `hands-on`: none.
- `full-autonomy-solo`: none.
