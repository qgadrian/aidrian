# Quorum ledger

The objection ledger, `<state>/quorum/<name>-<plan-hash>.json`, and how each round fills it.
`<name>` is the plan's file name without `.md`, or `<parent-folder>-plan` for a file named `plan.md`.

- [Schemas](#schemas): where the authoritative schemas live.
- [Fields](#fields): every field of the ledger.
- [Agent answers](#agent-answers): how an agent's answer is held to its schema before it is written.
- [Settled answers](#settled-answers): the Human's answers from earlier runs on the same plan.
- [Filling it](#filling-it): what the coordinator writes after each round.

## Schemas

The plugin's `lib/quorum.mjs` is the one source of truth, and this page keeps no copy of it:

- `LEDGER_SCHEMA`: the ledger.
- `OBJECTIONS_SCHEMA`: an adversary's objections, `{objections: [{severity, claim, citations}]}`.
- `REBUTTALS_SCHEMA`: an adversary's rebuttals, `{rebuttals: [{objection_id, verdict, claim, citations}]}`.

`aidrian quorum check` refuses a ledger off `LEDGER_SCHEMA`, and `aidrian quorum codex` refuses a Codex answer off its
schema. A test holds the list below to `LEDGER_SCHEMA`: a field added there and not here, or here and not there, fails it.

## Fields

- `status`: `open` while the rounds run, `complete` once the final rulings and the Human's answers are recorded.
- `plan`: the plan's absolute path.
- `plan_hash`: `git hash-object` of the plan, the same hash as in the file name.
- `same_model`: `true` when adversary B ran as an agent on any of its runs; `false` when Codex ran every one.
- `same_model_reason`: why B ran as an agent, or `null` when `same_model` is `false`.
  It is the `status: reason` line `aidrian quorum codex` printed, or `Codex host`.
  When the command printed no line (a usage error, exit 127, a shell timeout), it is the exit code and the last stderr line.
- `trigger`: what started the run: the plan line or gate a calling skill names, or `the Human asked`.
- `objections`: every objection both adversaries raised.
  - `objections[].id`: `A1` to `A7` and `B1` to `B7`, in each adversary's own order.
  - `objections[].by`: `A` or `B`.
  - `objections[].severity`: `blocking`, `important`, or `improvement`.
  - `objections[].claim`: the objection, in the adversary's words.
  - `objections[].citations`: its evidence.
    - `objections[].citations[].kind`: `doc`, `adr`, `code`, `plan`, or `absence`.
    - `objections[].citations[].ref`: where the evidence is, in the form its kind takes.
    - `objections[].citations[].quote`: the verbatim text, at most 200 characters.
  - `objections[].status`: `pending` until the architect rules; then `opinion`, `accepted`, `rejected`, or `escalated`.
    A valid partial accept is `accepted`, and its accepted part always stands: `escalated` on it means its rejected part is escalated.
    A partial accept whose ruling is still invalid after its retry escalates whole.
  - `objections[].ruling`: the architect's first ruling, or `null` before it and for an opinion.
    - `objections[].ruling.decision`: `accept`, `reject`, or `escalate`.
    - `objections[].ruling.change_or_reason`: for an accept, the plan change, ending in a `Rejected part:` line for a partial accept.
      For a reject, the counter-evidence. For an escalation, both positions, the recommended answer, and the deciding reason.
    - `objections[].ruling.citations`: the ruling's own evidence, in the same form as an objection's.
  - `objections[].rebuttal`: the adversary's answer to a rejection or to a partial accept's rejected part, or `null`.
    - `objections[].rebuttal.verdict`: `rebut` or `concede`.
    - `objections[].rebuttal.claim`: why the ruling is wrong, or that it stands.
    - `objections[].rebuttal.citations`: new evidence for a rebuttal; may be empty for a concession.
    - `objections[].rebuttal.ruling`: the architect's final ruling, in the same form as the first; `null` for a concession.
- `human_answers`: the Human's answers to this run's escalations, and only those.
  - `human_answers[].objection_id`: the objection in this ledger that the answer settles.
  - `human_answers[].answer`: the Human's answer, word for word.

## Agent answers

Codex's answers arrive held to their schema by `aidrian quorum codex`. An agent's answer does not, so before writing one
from A, from `product-manager` as B, or from the architect, hold it to its shape: objections to `OBJECTIONS_SCHEMA`,
rebuttals to `REBUTTALS_SCHEMA`, and rulings to `{objection_id, decision, change_or_reason, citations}`, the ledger's
ruling with its objection's id.

- A severity of `critical` or `high` is read as blocking, `medium` as important, and `low` as improvement, since the A
  and B briefs allow those words. Any other value outside its enum drops the entry. A dropped ruling counts as missing.
- An entry missing a required field is dropped.
- A citation that is not `{kind, ref, quote}` with a known kind is dropped; an objection left with none becomes an
  opinion at `quorum check`.
- From every answer, Codex's included, drop a citation whose ref is absolute or climbs out of the root with `..`:
  `quorum check` exits 1 on it.
- Past 7 entries, keep the first 7.
- Never edit a claim, a change, or a quote. The report names every entry and citation dropped.

When `quorum check` still exits 1, stop with `blocked`, quoting what it printed.

## Settled answers

Before round 1, read every `complete` ledger in `<state>/quorum/` whose `plan` is this plan's absolute path, other than
one at this plan's hash. For each of their `human_answers`, the settled block of every brief gives the claim of the
objection it answered, from that ledger, and the answer.
Settled answers stay in their own ledgers: the new ledger's `human_answers` holds only this run's answers.
The architect rejects an objection that reopens a settled answer, citing the plan's revision-history line that applied it.

## Filling it

- **After round 1.** Write each objection with its id, `by`, the adversary's fields, `status: pending`, and `ruling`
  and `rebuttal` `null`. Write `status: open` and `human_answers: []`. Run `quorum check`: an objection with no passing
  citation becomes `opinion`, and the architect never rules on it.
- **After round 2.** Copy each ruling into `ruling`, and set `status`: `accept` to `accepted`, `reject` to `rejected`,
  `escalate` to `escalated`. Run `quorum check`. The rulings it names invalid, and the backed objections still
  `pending`, go back to the architect once. Invalid again, the objection becomes `escalated`, keeping the ruling.
  A partial accept escalated this way escalates whole: its accepted part does not stand, and Report item 2 leaves it out.
  Still `pending`, stop with `blocked`: a complete ledger cannot hold it.
- **After round 3.** Answers come only for objections `rejected` or partly accepted; an `escalated` objection gets no
  rebuttal. For each answered id, write `rebuttal` with the answer's `verdict`, `claim`, and `citations`, and
  `ruling: null`. Drop an entry for any id the brief did not list. An A answer that names an id twice, or leaves a
  `rejected` objection unanswered, is an invalid rebuttal for those ids. Run `quorum check`: a rebuttal it names invalid
  makes its objection `escalated`, with no final ruling. A concession keeps the status of the first ruling.
  When one dispatch is left and both A and B have objections to answer, neither runs, and those objections become `escalated`.
- **After the final ruling.** Copy it into `rebuttal.ruling`, and run `quorum check`. `accept` makes the objection
  `accepted`; any other decision makes it `escalated`. A final ruling that is invalid or missing gets one retry when the
  cap leaves a dispatch for it; otherwise its objection becomes `escalated`.
- **After the Human.** Add each answer to `human_answers`. The objection becomes `accepted` or `rejected` as the answer
  says; a partial accept stays `accepted` either way, with its rejected part settled by the answer. A deferred
  escalation stays `escalated`. Then write `status: complete`, and run `quorum check`: it exits 1 on a complete ledger
  that still holds a `pending` objection, or a ruled status with no `ruling`.
