# The review plan, step by step

`aidrian pr review <n>` prints one JSON object. Every status carries `pr`, `head`, `base`, `depth`, `round`,
`max_rounds`, `engine`, and `plan` (its depth, reasons, flows, and stages). docs/review.md in the aidrian
repository describes the plan itself.

With `--with-bot`, run the step right after each push, before any other review of that head: the step that opens the
head's round asks the review bot, so the bot, CI, and the local passes review the head together. Never hold the bot
back for the local passes, and never ask it yourself. The bot's stage is still the last one judged: `received` comes
only after its answer, so the pull request stays a draft until the bot is clean.

## `dispatch`

`dispatch[]` lists the agent passes of the current stage. Run them in parallel, one read-only agent each:

- `agent`: the agent to run. Never the agent that wrote the change.
- `base`..`head` and `context`: `full` reviews the whole change; `delta` only what changed since the agent's last
  review, with `priorFindings` from it. `files`: the files to report findings in, or null for all.
  For a project below the repository root, `brief` says so: hand it to the agent, which runs every `git diff` in the
  project's folder with `--relative` and cites from the project root, as `files` lists them.
- `flows[]`: each critical flow with its `invariants`. The agent returns one verdict per invariant in its final JSON:

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
  and have it open the files. `status` other than `captured` (no base URL, no Playwright) means review from code,
  except that entries with `ingested: true` (images taken outside the tool, with a `source` and no facts) are opened
  and may be cited as `capture:<key>` too.
- `record`: the command that records the pass, `aidrian pr attest <PR> --pass <id> --head <sha> --reviewer <who>
  --findings-file <state>/tmp/review-<PR>/<pass>-<hash>.findings.json`, with `--verdicts <file.json>` when the pass judges flows. The step names that file
  under the state folder, outside every checkout, so the findings' text is never committed. The agent is read-only
  and writes no file: it returns each finding, with its axes and state, in the `findings` array of its final JSON.
  This session writes that array, as it is, to the file `record` names, then pipes the agent's final JSON to `record`,
  with `--verdicts -` in place of the file, and never retypes a finding or a verdict; `--verdicts FILE` still reads a
  file.
  Write the findings file with the file tool, or with `cat > <file> <<'EOF'` (quoted delimiter),
  never `echo` or an unquoted heredoc, so the shell never expands reviewer text.
  Pipe the final JSON the same way, from a file the file tool wrote or a heredoc with a quoted delimiter (`<<'EOF'`),
  never `echo` or an unquoted heredoc.
  The disposition table decides what stays open, not the agent's count (`aidrian pr disposition --vocab` lists
  the words):

  ```json
  [{ "id": "", "title": "Label clipped at 360px", "file": "src/app/x.tsx", "line": 4, "severity": "medium", "likelihood": "routine", "affects": "users", "cost": "trivial", "state": "open" }]
  ```

  `state` is `open`, `fixed` (in a pushed commit), or `accepted`. A fix_now finding cannot be accepted, and one
  without likelihood and affects stays open until it has them; give `cost` too, since a trivial fix is fix_now. Add `"security": true` to a security problem; the engine
  then keeps its text and place off a pull request that is not private. A finding that reports a `priorFindings`
  entry again, reworded or not, takes that entry's `id`; every other finding has an empty `id` or none, and the engine
  gives it one. Only a `priorFindings` entry listed to the pass carries an `id`; any other `id` is read as none and named in the
  pass's `dropped` notes.
  The older `--findings <n> --fixed <n>` form is still accepted, for a pass an older release dispatched.

A split review's passes carry `role`: a `slice` reviews only its `files` and also writes `contracts` and
`cross_notes` (lists of strings) in its final JSON, as `{ "verdicts": [...], "contracts": [...], "cross_notes": [...] }`; the `cross` pass reads `slices` and reports only what
crosses them.

## `fix_required`

- `findings_merged[]` (split reviews): each mistake once, with the passes that reported it in `sources`.
- `open[]`: passes with findings still open: `findings` lists them for a local model; the bot's are on the pull request.
- `flows[]`: flows not signed off: `violated` invariants are findings to fix; `unverified` need a verdict with evidence.
  A `disputed` invariant has a `violated` verdict and another reviewer's `holds` or `not_affected` with evidence.
  When the fix is wrong, settle it through the entry's `settle` route below, else ask the Human which side is right,
  in their terms, as the sign-off route below says.
  `aidrian pr signoff --flow` without `--overrule` never clears a violated invariant, and the command refuses a flow
  the head does not ask the Human to sign.
  Each flow's `next` lists, per open invariant, the only ways to close it on this head: `commands` for the Human's
  shell, and `notes` for the rest. `fix the code` means fix it; an approval note is a request for the named approver
  to post that review with its `aidrian-approve:` line; a capture note is the capture's status, not a command.
- Never hand the Human a terminal block while another route is open. In this order:
  1. A note says a reviewer's evidence does not count: dispatch that reviewer again to cite it. This closes the invariant.
  2. An entry has `settle`, so this project allows unattended rulings: dispatch an independent read-only agent, such as
     the critic, as judge, with the diff and the invariant. It rules `accept` only when the diff shows the invariant
     cannot be affected or a comment of the pull request holds the evidence, and `overrule` only when the reviewer that
     holds is right. Post its ruling as a comment, and run `settle` with that comment's URL. A change that does alter
     what is rendered gets a capture or `aidrian pr ingest`, never a ruling. On a refusal, go to the next route.
  3. Ask the Human with AskUserQuestion, one question per decision, and run the printed long-form command on "Approve":
     the question names `<owner>/<name>#<PR>`, the short head, and `<flow>/<invariant>`, `<flow>/*` for every unverified invariant of
     the flow, `<flow>/signoff`, or `stage:<name>/signoff`. Write the command with no shell variables, one call per invariant.
  4. Only on a host with no such question, hand the command over for the Human's own shell.
- Offer the Human only a sign-off command the step printed: an entry of `next[].commands`, `overrule`, `command`, or
  `tests_removed[].accept`, each starting with `aidrian pr signoff`, with its placeholders filled. Hand it over only
  after the same command with `--check` added exits 0 in your shell; `--check` records nothing. Never write a sign-off
  command of your own, with one exception: at `human_required` naming one flow, once
  `aidrian pr signoff <PR> --last --check` exits 0, offer the short form `aidrian pr signoff <PR> --last` in place of
  the printed command, naming in plain words the flow and short head that `--check` printed.
  When `--check` refuses, report the refusal instead.
- `tests_removed[]`: a flow's test was deleted. Restore it, or the Human accepts it with the `accept` command.
- `checks_failing[]`: a check the flow requires failed or was skipped on the head.

Fix, commit, push, and run the step again. The next round reviews only what changed, and carries forward every pass
the change does not touch. A push that touches only comments, docs, or tests keeps its round, and the passes it touches
still re-review it, in delta context; a quiet push changes only the round count. `residuals` on any result lists the
late-round low findings the step accepted, which go into the body's Accepted residuals.

## Stops

- `human_required`: a flow the Human signs off, or with `stage`, a stage the Human chose to review in place of a
  reviewer out of quota. Once `command` with `--check` added exits 0, ask with AskUserQuestion as the sign-off route
  under `fix_required` says, naming `<flow>/signoff` or `stage:<name>/signoff`, and run `command` on "Approve". The
  `review-signoff` rule blocks it with no such answer. A flow's sign-off holds across later pushes that
  touch nothing of the flow; a stage's holds for its head only.
- `unsatisfied`: the plan needs a reviewer this machine cannot run, such as `independent-model` with no Codex login.
- `stuck`: a reviewer failed 3 times on this head. `too_large`: the change is past what one review covers, or its
  visual capture is past 200 images; `reason` names the routes.
- `round_limit`: the round cap, `github.maxReviewRounds` as the base branch commits it. Its last round always runs
  the final stage. `extension` says why no extra round: `off`, the ceiling, the judge, or the Human. A red flag
  never stops it alone: it goes to the judge. With `unreviewed_head: true`, the head is a fix no round reviewed: say so when reporting
  the stop, so the Human does not merge it as reviewed. A session the Human told to merge, and then left, reads
  § At the cap: a judge's waiver before it reports the stop.

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

## At the cap: a judge's waiver

Only for a session the Human told to merge and then left, when the step returned `round_limit` on the pull request's
current head and the merge guard's denial names `aidrian pr waive`, which it does only while the team's
`github.unattendedWaiver.allow` and this machine's switch are both on. Not under `autopilot`: it merges only through the
`pr-auto-merge` skill, and `aidrian pr auto-merge` reads no verdict. A head pushed after the last review step gets no
waiver: run the step again on it.

- Dispatch a fresh `code-reviewer` as the waiver's judge, read-only, as `extension_check` dispatches its judge: never
  the agent that wrote the change, and never one that reviewed a round of this pull request. One judge per head:
  never dispatch another to get a different verdict. Brief it with the pull request, the head, the step's result, and:

  > Read-only. Decide whether pull request `<n>` may merge at head `<sha>`, whose review stopped at the round cap.
  > Read every finding still open on the head, at the head's code, and its verdict from `aidrian pr disposition`.
  > Verdict `waive` only when every open finding is `accepted_residual`, `acceptable_as_is`, or `drop_unless_cited`,
  > no flow has a `violated` or `unverified` invariant, the result has no `unreviewed_head`, and `aidrian pr checks <n>`
  > is not failing; otherwise `refuse`. Return the verdict and the evidence for each open finding: `path:line` at the
  > head, the round that raised it, and its disposition.

- Record the verdict the judge gave, and only that one:
  `aidrian pr waive <n> --verdict <the judge's verdict> --reason "<the judge's evidence>" --head <sha>`.
  The session never writes a verdict the judge did not give, and never turns the judge's `refuse` into `waive`.
- On `waive`, merge naming the head, as the command's `next` says: `gh pr merge <n> --match-head-commit <sha>`.
  On `refuse`, report the stop with the judge's evidence: the Human merges, or answers the merge guard's question with "Merge with the findings filed".

## Owed reviews

- The Human asks for a bot review: run `aidrian pr request <n>` at once, before any review the project requires first.
  `aidrian pr await-review <n> --request` sends it; it stays owed until the bot's answer arrives.
- Before dispatching the review the review gate needs outside `aidrian pr review`, run
  `aidrian pr request <n> --kind review`; `aidrian pr attest` answers it.
- Until then, and until `aidrian pr review` returns `received` or `none_needed` for the head, the merge guard hook
  refuses every merge of the pull request. A later instruction, a merge command included, does not cancel a request
  the Human made: ask the Human which one stands.
