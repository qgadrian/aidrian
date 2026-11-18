# Working-style recipes

Q7 of the `harness-setup` skill, and how the step 3 brief applies its answer.
The recipes are `<plugin root>/recipes/<name>.json`. The plugin repository's `docs/config-recipes.md` explains each key.

## The question

Ask it before the main-checkout guard question, whose answer hands-on sets, as one question with these choices, in this order:

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

## Applying it, in the step 3 brief

- Merge the recipe into `.aidrian/config.json`, key by key; a key the project already sets keeps its value,
  and the proposal names each kept key. Leave out `git.mainCheckout`: Q5 writes the guard, last.
- `github.requiredChecks`: put the names of the CI checks the project's workflows run on a pull request in place of `"test"`.
  With none found, leave the key out, and the report says auto-merge stays off until it names one.
- `full-autonomy` and `autopilot`: put the project's web screens in place of the placeholder target in `review.visual.targets`,
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
  `unattendedWaiver`, `review.unattendedSignoff`, or `session.handoff.continue` key.
- Never write `.aidrian.local.json`: the config guard refuses a subagent's write of its switches. Return the recipe's
  machine switches below, for the Human to add in the main checkout. The report prints them.

## Machine switches

Switches only `.aidrian.local.json` holds, so a pull request can never turn them on.

- `full-autonomy`: `{ "github": { "unattendedWaiver": { "enabled": true } }, "unattendedSignoff": "on", "handoff": { "background": "on" } }`
- `autopilot`: `{ "handoff": { "background": "on" } }`
- `hands-on`: none.
