# The review plan, step by step

`aidrian pr review <n>` prints one JSON object. Every status carries `pr`, `head`, `base`, `depth`, `round`,
`max_rounds`, `engine`, and `plan` (its depth, reasons, flows, and stages). docs/review.md in the aidrian
repository describes the plan itself.

## `dispatch`

`dispatch[]` lists the agent passes of the current stage. Run them in parallel, one read-only agent each:

- `agent`: the agent to run. Never the agent that wrote the change.
- `base`..`head` and `context`: `full` reviews the whole change; `delta` only what changed since the agent's last
  review, with `priorFindings` from it. `files`: the files to report findings in, or null for all.
  For a project below the repository root, `brief` says so: hand it to the agent, which runs every `git diff` in the
  project's folder with `--relative` and cites from the project root, as `files` lists them.
- `flows[]`: each critical flow with its `invariants`. The agent writes one verdict per invariant to a JSON file:

  ```json
  [{ "flow": "booking-creation", "invariant": "no-double-booking", "verdict": "holds", "evidence": "src/lib/booking/lock.ts:42" }]
  ```

  `verdict` is `holds`, `violated`, `not_affected`, or `cannot_verify`. `holds` and `not_affected` need evidence the
  command can check: `path:line` at the head, `test:<name>`, or `capture:<key>` for an image in `visual.captures`.
  Anything else counts as `cannot_verify`, and the flow stays unsigned. A citation shows the place exists; the
  independent stage challenges whether it proves the point. An invariant with a `source` (the doc section it cites)
  is judged against that source; its `text` is only the question.
- `visual` (the visual reviewers, designer and ux-specialist by default): the screenshots this head was captured in,
  per route, width, locale, and variant, each with its `file`, its upload `url` when attached, and measured `facts`
  (horizontal overflow, clipped text, controls under 44 px), plus the project's checklist. Hand the agent `brief`,
  and have it open the files. `status` other than `captured` (no base URL, no Playwright) means review from code.
- `record`: the command that records the pass. `--findings` is what the agent found, `--fixed` what was fixed in a
  pushed commit, `--accepted` what was dispositioned another way (step 3). `--verdicts` takes the file above.
  When `record` asks for `--findings-file` instead, the agent writes each finding with its axes and state, and the
  disposition table decides what stays open (`aidrian pr disposition --vocab` lists the words):

  ```json
  [{ "title": "Label clipped at 360px", "file": "src/app/x.tsx", "line": 4, "severity": "medium", "likelihood": "routine", "affects": "users", "state": "open" }]
  ```

  `state` is `open`, `fixed` (in a pushed commit), or `accepted`. A fix_now finding cannot be accepted, and one
  without likelihood and affects stays open until it has them.

A split review's passes carry `role`: a `slice` reviews only its `files` and also writes `contracts` and
`cross_notes` (lists of strings) into its `--verdicts` file, as `{ "verdicts": [...], "contracts": [...], "cross_notes": [...] }`; the `cross` pass reads `slices` and reports only what
crosses them.

## `fix_required`

- `findings_merged[]` (split reviews): each mistake once, with the passes that reported it in `sources`.
- `open[]`: passes with findings still open: `findings` lists them for a local model; the bot's are on the pull request.
- `flows[]`: flows not signed off: `violated` invariants are findings to fix; `unverified` need a verdict with evidence.
  A `disputed` invariant has a `violated` verdict and another reviewer's `holds` or `not_affected` with evidence.
  When the fix is wrong, ask the Human which side is right, in their terms. If the Human sides with the evidence,
  give them its `overrule` command, with their reason in place of `<why>`, alone in a code block for their own shell.
  `aidrian pr signoff --flow` without `--overrule` never clears a violated invariant, and the command refuses a flow
  the head does not ask the Human to sign.
  Each flow's `next` lists, per open invariant, the only ways to close it on this head. An `unverified` invariant whose
  evidence lives outside the tool, such as a designer's approval, closes on an approver's review with the
  `aidrian-approve:` line `next` gives, or on the Human's `--accept` command.
- Offer the Human only a command from `next`, `command`, or `overrule`, with its placeholders filled, and only after
  the same command with `--check` added exits 0 in your shell; `--check` records nothing. Never write a sign-off
  command of your own. When `--check` refuses, report the refusal instead.
- `tests_removed[]`: a flow's test was deleted. Restore it, or the Human accepts it with the `accept` command.
- `checks_failing[]`: a check the flow requires failed or was skipped on the head.

Fix, commit, push, and run the step again. The next round reviews only what changed, and carries forward every pass
the change does not touch.

## Stops

- `human_required`: a flow the Human signs off, or with `stage`, a stage the Human chose to review in place of a
  reviewer out of quota. Once `command` with `--check` added exits 0, give them `command`,
  alone in a code block with nothing after it on the line, to run in their own shell (`!` in the prompt, or another terminal); never
  run it for them, and the `review-signoff` rule blocks it if you try. A flow's sign-off holds across later pushes that
  touch nothing of the flow; a stage's holds for its head only.
- `unsatisfied`: the plan needs a reviewer this machine cannot run, such as `independent-model` with no Codex login.
- `stuck`: a reviewer failed 3 times on this head. `too_large`: the change is past what one review covers, or its
  visual capture is past 200 images; `reason` names the routes.
- `round_limit`: the round cap, `github.maxReviewRounds` as the base branch commits it. Its last round always runs
  the final stage. `extension` says why no extra round: `off`, the ceiling, the judge, or the Human. A red flag
  never stops it alone: it goes to the judge. With `unreviewed_head: true`, the head is a fix no round reviewed: say so when reporting
  the stop, so the Human does not merge it as reviewed.

## Out of quota: `blocked_quota`

A reviewer, Codex on this machine or the review bot, ran out of quota on this head, and its stage stopped.

- With `question` and `options`: ask the Human that one question with AskUserQuestion, the options as given, word for
  word, the recommended one first. Then run the `run` command of the option the Human picked, and act on its result:
  - "Run a critic agent": `--quota-fallback agent:critic` returns `dispatch` of the `critic` agent in place of the
    stopped passes. Run and record it as any agent pass. It is a fallback on the session's own model, not an
    independent review, and the record and the summary comment say so.
  - "The Human reviews it": `--quota-fallback human` returns `human_required` with the `stage` and the sign-off
    `command`, which the Human runs once they have reviewed the change.
  - "Wait": `run` is null. Stop and report it; a later push runs the reviewer again.
- With `fallback_refused` instead: the plan requires an independent model, which no fallback gives. Stop, and report
  `fallback_refused` to the Human.
- The choice holds for this head only, and only the Human makes it: the `review-fallback` rule refuses
  `--quota-fallback` without the Human's answer in the session. Under `autopilot`, nobody is there to ask: stop.
- Every later result on that head carries `quota_fallback`: say in the step 7 summary which stage ran on a fallback.
- The merge guard refuses a merge while the head is stopped on quota, and until the step after the fallback, or after
  the Human's stage sign-off, returns `received`.

## At the cap: extra rounds

With `github.extraRounds` on, the cap first checks whether one more round is worth it.

- `extension_check`: `extension` holds each round's open findings, each fix's size, the pull request's `files`, its
  `goal`, and the `signals`; `extension.red_flags` lists each red flag the judge must answer. When the head is a fix no round reviewed, `extension.unreviewed_head` names
  that `head`, the last reviewed head (`from`), and the `fix` between them.
  Run `dispatch[0]` as its read-only `agent` with `brief` and `extension`. It returns `extend` or `stop` with
  evidence; record it with `record`, its `--reason` naming that evidence. Then run the step again.
  The session never writes a verdict the judge did not give.
- `extension_ask`: the judge said extend, under `"ask"` or over a red flag, and the Human decides. Ask `question` with AskUserQuestion, with `options`
  as given, word for word. Record what the Human picked: `aidrian pr extend <n> --human approve` for the option that
  starts with "Approve", `--human deny` otherwise. The `review-extend` rule refuses an approval the Human did not give
  in this session. Under `autopilot`, nobody is there to ask: park it as a Decision for the Human.
- A grant is one round: the step then returns `fix_required` for the same head. At the next cap the check runs again.

## Owed reviews

- The Human asks for a bot review: run `aidrian pr request <n>` at once, before any review the project requires first.
  `aidrian pr await-review <n> --request` sends it; it stays owed until the bot's answer arrives.
- Before dispatching the review the review gate needs outside `aidrian pr review`, run
  `aidrian pr request <n> --kind review`; `aidrian pr attest` answers it.
- Until then, and until `aidrian pr review` returns `received` or `none_needed` for the head, the merge guard hook
  refuses every merge of the pull request. A later instruction, a merge command included, does not cancel a request
  the Human made: ask the Human which one stands.
