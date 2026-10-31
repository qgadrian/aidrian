# The review plan, step by step

`aidrian pr review <n>` prints one JSON object. Every status carries `pr`, `head`, `base`, `depth`, `round`,
`max_rounds`, `engine`, and `plan` (its depth, reasons, flows, and stages). docs/review.md in the aidrian
repository describes the plan itself.

## `dispatch`

`dispatch[]` lists the agent passes of the current stage. Run them in parallel, one read-only agent each:

- `agent`: the agent to run. Never the agent that wrote the change.
- `base`..`head` and `context`: `full` reviews the whole change; `delta` only what changed since the agent's last
  review, with `priorFindings` from it. `files`: the files to report findings in, or null for all.
- `flows[]`: each critical flow with its `invariants`. The agent writes one verdict per invariant to a JSON file:

  ```json
  [{ "flow": "booking-creation", "invariant": "no-double-booking", "verdict": "holds", "evidence": "src/lib/booking/lock.ts:42" }]
  ```

  `verdict` is `holds`, `violated`, `not_affected`, or `cannot_verify`. `holds` and `not_affected` need evidence the
  command can check: `path:line` at the head, or `test:<name>`. Anything else counts as `cannot_verify`, and the flow
  stays unsigned. A citation shows the place exists; the independent stage challenges whether it proves the point.
- `record`: the command that records the pass. `--findings` is what the agent found, `--fixed` what was fixed in a
  pushed commit, `--accepted` what was dispositioned another way (step 3). `--verdicts` takes the file above.

A split review's passes carry `role`: a `slice` reviews only its `files` and also writes `contracts` and
`cross_notes` (lists of strings) into its `--verdicts` file, as `{ "verdicts": [...], "contracts": [...], "cross_notes": [...] }`; the `cross` pass reads `slices` and reports only what
crosses them.

## `fix_required`

- `findings_merged[]` (split reviews): each mistake once, with the passes that reported it in `sources`.
- `open[]`: passes with findings still open: `findings` lists them for a local model; the bot's are on the pull request.
- `flows[]`: flows not signed off: `violated` invariants are findings to fix; `unverified` need a verdict with evidence.
- `tests_removed[]`: a flow's test was deleted. Restore it, or the Human accepts it with the `accept` command.
- `checks_failing[]`: a check the flow requires failed or was skipped on the head.

Fix, commit, push, and run the step again. The next round reviews only what changed, and carries forward every pass
the change does not touch.

## Stops

- `human_required`: a flow the Human signs off. Give them `command`; never run it for them.
- `unsatisfied`: the plan needs a reviewer this machine cannot run, such as `independent-model` with no Codex login.
- `stuck`: a reviewer failed 3 times on this head. `too_large`: the change is past what one review covers.
- `round_limit`: the round cap, config.json `github.maxReviewRounds`. Its last round always runs the final stage.
