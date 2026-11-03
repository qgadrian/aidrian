# Quorum ledger

The ledger, `<state>/quorum/<name>-<plan-hash>.json`, and how each round fills it.
`<name>` is the plan's file name without `.md`, or `<parent-folder>-plan` for a file named `plan.md`.
In decide mode, `<name>` is the question file's name without `.md`, and `<plan-hash>` is `git hash-object` of it.

- [Schemas](#schemas): where the authoritative schemas live.
- [Fields](#fields): every field of a plan-mode ledger.
- [Decide-mode fields](#decide-mode-fields): every field of a decide-mode ledger.
- [Agent answers](#agent-answers): how an agent's answer is held to its schema before it is written.
- [Settled answers](#settled-answers): the Human's answers from earlier runs on the same plan.
- [Filling it](#filling-it): what the coordinator writes after each round of `modes/plan.md`.
  In decide mode, the rounds of `modes/decide.md` say what each one writes.
- [Under plan-review](#under-plan-review): the triggers `plan-review` passes, and what its critique receives.

## Schemas

The plugin's `lib/quorum.mjs` is the one source of truth, and this page keeps no copy of it:

- `LEDGER_SCHEMA`: the plan-mode ledger.
- `OBJECTIONS_SCHEMA`: an adversary's objections, `{objections: [{severity, claim, citations}]}`.
- `REBUTTALS_SCHEMA`: an adversary's rebuttals, `{rebuttals: [{objection_id, verdict, claim, citations}]}`.
- `DECIDE_LEDGER_SCHEMA`: the decide-mode ledger.
- `CASE_SCHEMA`: an advocate's case, `{case: {claim, citations}}`.
- `CROSS_SCHEMA`: an advocate's cross points, `{cross: [{against, claim, citations}]}`, at most 5.
- `DECIDE_REBUTTAL_SCHEMA`: an advocate's rebuttal, `{rebuttal: {verdict, claim, citations}}`.

`aidrian quorum check` refuses a ledger off its mode's schema, and `aidrian quorum codex` refuses a Codex answer off its
schema. A test holds each fields list below to its schema: a field added there and not here, or here and not there,
fails it.

## Fields

A ledger written before the `mode` field has none of the fields marked optional, and `quorum check` holds it to the
rules it was written under and never adds them. A ledger that carries `mode` is held to the rules each optional field names.
Such an old ledger is `complete`: `quorum check` exits 1 on an `open` one with `mode: missing in an open plan ledger`.

- `mode`: `plan`, on a ledger written under the plan-mode briefs. Optional: absent on a ledger written before them.
- `status`: `open` while the rounds run, `complete` once the final rulings and the Human's answers are recorded.
- `plan`: the plan's absolute path.
- `plan_hash`: `git hash-object` of the plan, the same hash as in the file name.
- `same_model`: `true` when adversary B ran as an agent on any of its runs; `false` when Codex ran every one.
- `same_model_reason`: why B ran as an agent, or `null` when `same_model` is `false`.
  It is the `status: reason` line `aidrian quorum codex` printed, or `Codex host`.
  When the command printed no line (a usage error, exit 127, a shell timeout), it is the exit code and the last stderr line.
- `trigger`: what started the run: the plan line or gate a calling skill names, as [Under plan-review](#under-plan-review)
  lists, or `the Human asked`.
- `objections`: every objection both adversaries raised.
  - `objections[].id`: `A1` to `A7` and `B1` to `B7`, in each adversary's own order, each once. `quorum check` refuses any other, or a repeated one.
    With `mode`, it also refuses more than 5 objections from one adversary.
  - `objections[].by`: `A` or `B`.
  - `objections[].severity`: `blocking`, `important`, or `improvement`. With a mode, only `blocking` or `important`:
    an improvement goes to the notes.
  - `objections[].claim`: the objection, in the adversary's words.
  - `objections[].citations`: its evidence.
    - `objections[].citations[].kind`: `doc`, `adr`, `code`, `plan`, or `absence`.
    - `objections[].citations[].ref`: where the evidence is, in the form its kind takes.
    - `objections[].citations[].quote`: the verbatim text, at most 200 characters.
  - `objections[].status`: `pending` until the architect rules; then `opinion`, `accepted`, `rejected`, or `escalated`.
    A valid partial accept is `accepted`. Unless the proportionality pass flags it, its accepted part always stands, and
    `escalated` on it means its rejected part is escalated; a flag escalates its accepted part too.
    A partial accept whose ruling is still invalid after its retry escalates whole.
    `merged` when the coordinator folds it into the other adversary's duplicate: it is never ruled on or rebutted.
  - `objections[].merged_into`: optional. The id of the objection a merged one was folded into, or `null`.
    `quorum check` exits 1 when a merged objection has a ruling or a rebuttal, or names no objection, an unknown one,
    one of its own adversary, or one that is itself merged or an opinion; and when an objection that is not merged names one.
    It also exits 1 unless each citation of a merged objection is among its survivor's `citations`, by kind, ref, and
    quote, whitespace collapsed: `objection X is merged into Y, which lacks its citation N`.
  - `objections[].ruling`: the architect's first ruling, or `null` before it and for an opinion.
    - `objections[].ruling.decision`: `accept`, `reject`, or `escalate`.
    - `objections[].ruling.change_or_reason`: for an accept, the plan change, ending in a `Rejected part:` line for a partial accept.
      For a reject, the counter-evidence. For an escalation, both positions, the recommended answer, and the deciding reason.
      With `mode`, its first line is `Covers: #<anchor> "<quote>"` or `Covers: nothing`, and an accept also holds a
      `Cost: ` line (the files, rules, and tests the change adds) and a `Removes: ` line (the cited risk it removes).
    - `objections[].ruling.citations`: the ruling's own evidence, in the same form as an objection's.
      With `mode`, an accept holds at least one passing `plan` citation: the section it changes.
    - `objections[].ruling.tested`: optional; with `mode`, one verdict per citation of the entry ruled on, the
      objection for the first ruling and the rebuttal for the final one, each citation exactly once. An accept needs one
      verdict that supports.
      - `objections[].ruling.tested[].citation`: the citation's index in the ruled entry's `citations`, from 0.
      - `objections[].ruling.tested[].supports`: `true` when the cited text supports the statement it backs, else `false`.
        A citation marked `false` stays in the ledger and leaves the report's evidence.
      - `objections[].ruling.tested[].reason`: why, in one line.
    - `objections[].ruling.inferences`: optional; with `mode`, one entry per `inference:` line of the ruled entry's claim.
      - `objections[].ruling.inferences[].statement`: that line's text after `inference:`.
      - `objections[].ruling.inferences[].holds`: `true` when the evidence settles it as stated, else `false`.
      - `objections[].ruling.inferences[].reason`: why, in one line.
      - `objections[].ruling.inferences[].citations`: the evidence that settles it, checked as every citation is; may
        be empty when it does not hold. One that holds with no passing citation leaves the ruling invalid:
        `inference "<statement>" holds on no passing citation`.
    - `objections[].ruling.ground`: optional; with a mode, present exactly on a reject, naming its one ground:
      `covered` (the plan already states it), `implementation` (how the code gets written, for pull request review),
      `settled` (reopens a settled answer), `off-goal` (outside the plan's goal or scope), `disproportionate` (the change
      costs more than the risk it removes), or `speculative` (no cited failure path).
  - `objections[].rebuttal`: the adversary's answer to a rejection or to a partial accept's rejected part, or `null`.
    - `objections[].rebuttal.verdict`: `rebut` or `concede`.
    - `objections[].rebuttal.claim`: why the ruling is wrong, or that it stands.
    - `objections[].rebuttal.citations`: new evidence for a rebuttal. For a concession, the evidence of the ruling it
      accepts: with `mode`, at least one passing citation; without it, it may be empty.
    - `objections[].rebuttal.ruling`: the architect's final ruling, in the same form as the first, its verdicts over the
      rebuttal's citations and claim; `null` for a concession.
- `notes`: optional. Improvements, and B's line that no alternative beats the plan, that no one rules on; at most 10.
  `quorum check` removes a note with no passing citation and names it.
  - `notes[].by`: `A` or `B`.
  - `notes[].claim`: the note, in the adversary's words.
  - `notes[].citations`: its evidence.
- `human_answers`: the Human's answers to this run's escalations, and only those.
  - `human_answers[].objection_id`: the objection in this ledger that the answer settles, at most one answer each.
  - `human_answers[].answer`: the Human's answer, word for word.
- `proportionality`: optional. The architect's review of every accepted change as a set, or `null` before it runs.
  With `mode`, `quorum check` exits 1 on a complete ledger with an accepted change and no review.
  - `proportionality.flagged`: each accepted change that, with the others, over-complicates the plan; often empty.
    `quorum check` exits 1 on a flagged objection with no accept ruling, or one neither escalated nor answered.
    - `proportionality.flagged[].objection_id`: the flagged objection.
    - `proportionality.flagged[].reason`: why, in one line.
    - `proportionality.flagged[].smaller_change`: the smaller change that keeps its risk removed, the recommended
      answer when it is asked of the Human; empty when the architect sees none.
  - `proportionality.failed`: optional; `true` when the pass returned no usable answer. It comes only with an empty
    flagged list, so a reused ledger still reports that the pass failed.

## Decide-mode fields

Every decide ledger carries every field below; `quorum check` refuses one that lacks any, or holds another.
It holds a decide ledger to the decide rules only, and prints `checked: mode decide, ...` as its last line.
A ledger the Human did not settle (no `human_answer`, and no ruling of `escalate`, first or final) that is `complete`
fails `quorum check` on every invalid ruling or rebuttal, so it is not reused.

- `mode`: `decide`.
- `status`: `open` while the rounds run, `complete` once the last ruling and the Human's answer are recorded.
- `plan`: the question file's absolute path.
- `plan_hash`: `git hash-object` of the question file, the same hash as in the file name.
- `same_model`: `true` exactly when two positions share a runner, as three or four always do; else `false`.
  `quorum check` exits 1 when it does not match the runners.
- `same_model_reason`: which positions share a runner, and why, such as the Codex status line of a fallback;
  `null` when `same_model` is `false`.
- `trigger`: what started the run: the calling skill's line, or `the Human asked`.
- `positions`: 2 to 4 positions, from the question file; `quorum check` exits 1 unless they run from A in order.
  - `positions[].id`: `A`, `B`, `C`, or `D`, in the question file's order. A claim has A for true and B for false.
  - `positions[].label`: the option's heading text after its id, or true or false for a claim.
  - `positions[].runner`: `codex` while every run of the position went to Codex, `agent` once one did not.
- `cases`: each position's opening case, at most one each. A `complete` ledger needs one for every position.
  - `cases[].position`: the position it argues: `A`, `B`, `C`, or `D`.
  - `cases[].claim`: the case, in the advocate's words, at most 200 words.
  - `cases[].citations`: its evidence. A case with no passing citation is named, and its position cannot win.
    - `cases[].citations[].kind`: `doc`, `adr`, `code`, `plan`, or `absence`.
    - `cases[].citations[].ref`: where the evidence is, in the form its kind takes.
    - `cases[].citations[].quote`: the verbatim text, at most 200 characters.
- `cross`: the cross-examination points, at most 5 per position.
  - `cross[].id`: the raising position's letter and a number, `A1` to `D5`, each once.
  - `cross[].by`: the position that raised it, the id's letter: `A`, `B`, `C`, or `D`.
  - `cross[].against`: the position it attacks, never its own: `A`, `B`, `C`, or `D`.
  - `cross[].claim`: the point, in the advocate's words.
  - `cross[].citations`: its evidence, in the same form as a case's.
  - `cross[].status`: `pending` until the check runs; then `backed` when a citation passes, or `opinion` when none
    does. Only a pending point is relabeled: a backed one whose citations stop passing stays backed, and is named.
- `ruling`: the architect's first ruling, or `null` before it. When it is invalid twice, the coordinator writes an
  `escalate` here instead, with `tested: []`, as `modes/decide.md` round 4 says.
  - `ruling.decision`: `rule` or `escalate`. Rebuttals and a final ruling follow a rule only.
  - `ruling.winner`: the winning position on a rule, `A`, `B`, `C`, or `D`; `null` on an escalate.
  - `ruling.change_or_reason`: for a rule, the losing case's strongest cited claim and the citation that defeats it.
    For an escalation, every position, the recommended answer, the deciding reason, and what would settle it.
  - `ruling.citations`: the ruling's own evidence, in the same form as a case's. One with no passing citation is invalid.
  - `ruling.tested`: one verdict per citation of every case and every backed cross point, each once.
    A rule needs one that supports, on the winner's case.
    - `ruling.tested[].of`: the case's position or the cross point's id that the citation belongs to;
      on the final ruling, the rebuttal's position.
    - `ruling.tested[].citation`: the citation's index in that entry's `citations`, from 0.
    - `ruling.tested[].supports`: `true` when the cited text supports the statement it backs, else `false`.
      A citation marked `false` stays in the ledger and leaves the report's evidence.
    - `ruling.tested[].reason`: why, in one line; for a point the architect moderated, its ground.
  - `ruling.inferences`: one entry per `inference:` line of the claims it rules on.
    - `ruling.inferences[].statement`: that line's text after `inference:`.
    - `ruling.inferences[].holds`: `true` when the evidence settles it as stated, else `false`.
    - `ruling.inferences[].reason`: why, in one line.
    - `ruling.inferences[].citations`: the evidence that settles it, checked as every citation is; may be empty when
      it does not hold. One that holds with no passing citation leaves the ruling invalid, first or final:
      `inference "<statement>" holds on no passing citation`.
- `rebuttals`: each losing position's answer to a first ruling of rule, at most one each, never from the winner.
  - `rebuttals[].position`: the losing position: `A`, `B`, `C`, or `D`.
  - `rebuttals[].verdict`: `rebut` or `concede`.
  - `rebuttals[].claim`: why the ruling is wrong, or that it stands.
  - `rebuttals[].citations`: for a rebut, at least one passing citation that no case, cross point, or first ruling
    holds. For a concession, the evidence of the ruling it accepts, with at least one that passes.
- `final_ruling`: the architect's ruling on the rebuttals, in the same form as `ruling`, or `null`.
  It comes only after a first `rule`. A final `rule` needs a `rebut`, its `tested` covers every rebuttal's citations,
  and its winner is the first ruling's winner or a position that rebutted.
  A flip, a final winner other than the first, rests on a citation of the new winner's rebuttal that passes and
  that `tested` marks as supporting. A final `escalate` is not held to `tested` or to an `inferences` entry per line, so the coordinator can write one when the
  rebuttal round ends short. The governing winner is the final ruling's winner on a final `rule`, else the first
  ruling's; in a `complete` ledger, its case needs a passing citation, whatever the Human answered.
- `human_answer`: the Human's answer to the escalated ruling, word for word, or `null`.
  `quorum check` exits 1 on an answer when no ruling, first or final, is `escalate`.

## Agent answers

Codex's answers arrive held to their schema by `aidrian quorum codex`. An agent's answer does not, so before writing one
from A, from `product-manager` as B, or from the architect, hold it to its shape: objections to `OBJECTIONS_SCHEMA`,
rebuttals to `REBUTTALS_SCHEMA`, rulings to the ledger's ruling with its objection's id
(`{objection_id, decision, change_or_reason, citations, tested, inferences, ground}`, `ground` on a reject only),
and the proportionality pass to `{flagged: [{objection_id, reason, smaller_change}]}`.

- A severity of `critical` or `high` is read as blocking, `medium` as important, and `low` as improvement, since the A
  and B briefs allow those words. Any other value outside its enum drops the entry. A dropped ruling counts as missing.
- An entry missing a required field is dropped.
- A citation that is not `{kind, ref, quote}` with a known kind is dropped; an objection left with none becomes an
  opinion at `quorum check`.
- Past 7 entries, keep the first 7. With `mode`, each `improvement` entry becomes a note with its `by`, and of each
  adversary's entries the first 5 objections and the first 5 notes are kept.
- A flagged entry that names no objection with an `accept` ruling is dropped.
- Never edit a claim, a change, or a quote. The report names every entry and citation dropped.

In decide mode, hold an advocate's case to `CASE_SCHEMA`, its cross points to `CROSS_SCHEMA`, its rebuttal to
`DECIDE_REBUTTAL_SCHEMA`, and the architect's ruling to the ledger's `ruling`. The rules above on missing fields,
citations, and edits hold, and:

- A ruling whose winner is not set exactly on `rule`, or is not a position in the ledger, is dropped, and counts as missing.
- A cross point against the advocate's own position, or a position the ledger does not hold, is dropped.
- Past 5 cross points, keep the first 5.

When `quorum check` still exits 1, stop with `blocked`, quoting what it printed.

## Settled answers

Before round 1, read every `complete` ledger in `<state>/quorum/` whose `plan` is this plan's absolute path, other than
one at this plan's hash, and whose mode is this run's (a ledger with no `mode` is plan mode).
For each of their `human_answers`, the settled block of every brief gives the claim of the objection it answered,
from that ledger, and the answer.
Settled answers stay in their own ledgers: the new ledger's `human_answers` holds only this run's answers.
In decide mode, `<settled>` is always `none`, as `modes/decide.md` says.
The architect rejects an objection that reopens a settled answer, citing the plan's revision-history line that applied it.
An answer the plan holds no revision-history line for yet, as after a `plan-review` restart from its step 5.1, is asked
again: its objection escalates with the earlier answer as the recommended answer, and its ruling gets no retry.

## Filling it

Each step names the round of `modes/plan.md` it follows.

- **After the objections.** Write each objection with its id, `by`, the adversary's fields, `status: pending`, and
  `ruling` and `rebuttal` `null`, and each note with its `by`, claim, and citations. Write `mode: plan`, `status: open`,
  `human_answers: []`, and `proportionality: null`. Run `quorum check`: an objection with no passing citation becomes
  `opinion`, and the architect never rules on it; a note with no passing citation is removed, and the report names it.
  Only a `pending` objection is relabeled: one already ruled on keeps its status when its citations stop passing, and
  `quorum check` names it.
- **After the merge.** Set each merged objection's `status: merged` and `merged_into` to its survivor, with `ruling`
  and `rebuttal` left `null`, append its citations to the survivor's `citations`, and run `quorum check`.
  When a survivor's citations stop passing and it becomes an opinion, `quorum check` unmerges each objection merged
  into it, which becomes an opinion too, since the survivor holds its citations.
- **After the rulings.** Copy each ruling into `ruling`, its `tested`, `inferences`, and `ground` included, and set
  `status`: `accept` to `accepted`, `reject` to `rejected`, `escalate` to `escalated`. Run `quorum check`.
  The rulings it names invalid, and the backed objections still `pending`, go back to the
  architect once. Invalid again, the objection becomes `escalated`, keeping the ruling.
  A partial accept escalated this way escalates whole: its accepted part does not stand, and the Accepted item leaves it out.
  Still `pending`, stop with `blocked`: a complete ledger cannot hold it.
- **After the rebuttals.** Answers come only for objections `rejected` or partly accepted; an `escalated` or `merged`
  objection gets no rebuttal. For each answered id, write `rebuttal` with the answer's `verdict`, `claim`, and
  `citations`, and `ruling: null`. Drop an entry for any id the brief did not list. An agent's answer, A's or B's from
  `product-manager`, that names an id twice, or leaves one of its own `rejected` objections unanswered, is an invalid
  rebuttal for those ids; `aidrian quorum codex` holds Codex's answer to the same rules. Run `quorum check`: a rebuttal
  it names invalid, or with `mode` a concession with no passing citation, makes its objection `escalated`, with no
  final ruling. A concession keeps the status of the first ruling.
  When one dispatch outside the reserved one is left and both A and B have objections to answer, neither runs, and
  those objections become `escalated`.
- **After the final ruling.** Copy it into `rebuttal.ruling`, its verdicts over the rebuttal's citations and claim, and
  run `quorum check`. `accept` makes the objection `accepted`; any other decision makes it `escalated`. A final ruling
  that is invalid or missing gets one retry when the cap leaves a dispatch for it outside the reserved one; otherwise
  its objection becomes `escalated`.
- **After the proportionality pass.** Write `proportionality` with the pass's `flagged` list, and in the same write set
  each flagged objection `escalated`. With no accepted ruling, write `{flagged: []}`; when the pass returned no usable
  answer, write `{flagged: [], failed: true}`, with no retry. Run `quorum check`.
- **After the Human.** Add each answer to `human_answers`. The objection becomes `accepted` or `rejected` as the answer
  says; an unflagged valid partial accept stays `accepted`, with its rejected part settled by the answer. On a flagged
  objection, the answer settles both parts, and none makes it `rejected`. A deferred
  escalation stays `escalated`. Then write `status: complete`, and run `quorum check`: it exits 1 on a complete ledger
  that still holds a `pending` objection, or a ruled status with no `ruling`. On an objection the Human did not settle
  (not `escalated`, not answered), it also exits 1 on a rebuttal with no final ruling, a final ruling other than
  `accept`, a status its final decision does not give, a `rejected` objection with no rebuttal or concession, or an
  invalid ruling or rebuttal, as when cited code changed. An unflagged valid partial accept's first ruling is held to
  its evidence even when its objection is escalated or answered: its accepted part stands, and the answer covers only
  the rest. A flagged one is not: the flag escalated its accepted part too, so the Human's answer, or the deferral,
  covers it.

## Under plan-review

`plan-review` runs this skill at its step 3b, after its gates and before its critique, with the gate verdicts and one
trigger, the first of these that holds:

- `critical flow gate` or `security gate`: that gate ran in its step 3. With both, `critical flow gate, security gate`.
- The plan line, word for word, that names a decision-record path or the `adr-writer` skill. A decision-record path is
  a path in the ADR folder that the `adr-writer` skill's step 1 finds.
- `forced by the Human`: the Human passed `--quorum` on a plan that neither of the above covers.

`--no-quorum`, a missing `quorum` skill, or no trigger skips the run, and `plan-review`'s report says which.
`plan-review`'s Gates item carries the Report's Ledger item, with `same_model`.

Ask every escalation, one at a time, before `plan-review`'s critique starts. The Report goes back to `plan-review`,
not to a separate dispatch: its accepted objections, with each plan change, the Human's answers, and its
revision-history line go into `planning-agent`'s critique brief as authoritative, like gate verdicts, so they land in
the diff the Human approves. That diff's `revision_history_entry` includes the Report's revision-history line, as
`plan-review`'s review lens says.
Rejected objections, opinions, and notes go there as context, never authoritative and never findings to apply.
A deferred escalation goes into the critique's open questions.
When this skill stops with `blocked`, `plan-review` stops with `blocked on quorum`, naming the ledger and what
`quorum check` printed, and resumes from step 3b.

A `plan-review` re-critique of a plan it just applied does not run the quorum again. A restart of `plan-review` because
the plan changed runs it under the new hash, with this run's answers as [settled answers](#settled-answers).
