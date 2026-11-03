# Decide mode

Each advocate argues one position on a question, and the architect rules which position the evidence supports.
Read this file once the mode is `decide`. Here `<plan>` is the question file.

- [Question file](#question-file): its name.
- [Positions and roles](#positions-and-roles): who argues which position, on which runner, and who rules.
- [Rounds](#rounds): the cap, the cases, the cross-examination, the rulings, and the rebuttals.
- [Who wins](#who-wins): the governing winner and the flip.
- [Asking the Human](#asking-the-human): the one question, and where the answer goes.
- [Report](#report): this mode's items.
- Briefs: [Case](#case), [Cross-examination](#cross-examination), [Architect: ruling](#architect-ruling), and
  [Rebuttal](#rebuttal). Beside the placeholders of `references/briefs.md`, fill `<id>` and `<label>` with the
  advocate's position, and `<cap>` with this run's cap.
  `<settled>` is always `none` in decide mode: an edited question is a new question, so no earlier answer carries over.

## Question file

The file is `<state>/quorum/questions/<slug>-<h7>.md`. `<h7>` is the first 7 characters of `git hash-object` of the file.
`<slug>` comes from the question's first line, without its `# `, in these steps: lowercase it; drop backticks, `*`,
and `_`; turn each run of other characters outside a-z and 0-9 into one `-`; leave no `-` at either end; cut it to 60
characters, with no `-` left at the end; use `question` when nothing is left.

## Positions and roles

The question file gives the positions. Options give one position each, `A` to `D`, in file order, labelled by the
text after `A: `. A claim gives two: `A`, labelled `true`, and `B`, labelled `false`.
Write each to `positions` as `{id, label, runner}`.
A `plan` citation anchors on a heading of the question file: `#context`, `#claim`, or an option's slug, such as
`#a-keep-one-ledger`.

- **Advocates**: one per position. `A` and `C` run as `code-reviewer`. `B` and `D` run on Codex through
  `aidrian quorum codex`; their fallback agent is `code-reviewer`.
- **The swap**: for a claim, when the ledger's `<plan-hash>` starts with an odd hex digit (`1`, `3`, `5`, `7`, `9`,
  `b`, `d`, or `f`), the runners swap: `A` runs on Codex, with `code-reviewer` as its fallback, and `B` runs as
  `code-reviewer`. Options never swap.
  The swap keeps one model from always arguing `true`.
- **Runner**: `runner` is `codex` while every run of that position went to Codex, and `agent` once one did not.
- `same_model` is `true` exactly when two positions share a runner, which three or four positions always do.
  `same_model_reason` says which positions share one and why, such as the Codex status line of a fallback.
  `quorum check` exits 1 when `same_model` does not match the runners.
- **Judge**: `architect`. It rules on the cases and cross points, and once more on the rebuttals.
  It runs on the Claude host's model, so it may share a model with an advocate: the report shows the runners beside it.

## Rounds

The cap is `3N + 2` dispatches for N positions: 8 for two, 11 for three, 14 for four.
That is N cases, N cross-examinations, one ruling, at most N - 1 rebuttals, one final ruling, and one spare for a retry.
Every agent dispatch and Codex run counts, fallbacks included.

1. **Cases.** Every advocate in parallel, with the Case brief. Codex runs `aidrian quorum codex --mode case`.
2. A position still without a case after its fallback stops the run with `blocked` before round 3, naming the
   position and the Codex status line, or the agent's failure.
   Otherwise, write the ledger with every field `references/ledger.md` § Decide-mode fields lists: `mode: decide`,
   `status: open`, the positions, and the cases. `cross` and `rebuttals` are empty, and `ruling`, `final_ruling`, and
   `human_answer` are `null`. Run `quorum check`. It prints `case X: no citation passes` for a case with no passing
   citation, and that position cannot win.
3. **Cross-examination.** Every advocate in parallel, with the Cross-examination brief. Codex runs
   `aidrian quorum codex --mode cross --ledger <ledger>`, which fails an answer with a point against a position the
   ledger does not hold. Drop any point against the advocate's own position or a position the ledger does not hold,
   and name each in the report.
   Number each advocate's points `<id>1` to `<id>5`, such as `A1`, and write them with `status: pending`.
   Run `quorum check`: a point with a passing citation becomes `backed`, and one with none becomes `opinion`.
4. **Ruling.** The architect, with the ruling brief, on every case and every backed cross point, with each
   `case X: no citation passes` line. Write `ruling`, and run `quorum check`.
   A ruling `quorum check` names invalid, or a missing one, goes back once, with the line it printed.
   Invalid again, stop with `blocked`.
   A ruling of `escalate` skips rounds 5 and 6, since no position lost: ask the Human.
5. **Rebuttals.** Each losing position once, in parallel, with the Rebuttal brief. Codex runs
   `aidrian quorum codex --mode rebut --ledger <ledger>`. Write each answer to `rebuttals`, and run `quorum check`.
6. **Final ruling**, only when a position rebutted: the architect, with the ruling brief, on the rebuttals only,
   with each `case X: no citation passes` line. Write `final_ruling`, and run `quorum check`.
   A ruling `quorum check` names invalid, or a missing one, goes back once, when the cap allows.
   Then the rounds stop. A final ruling of `escalate` goes to the Human.

Rounds 5 and 6 end short when:

- `quorum check` names a rebuttal or a concession invalid. Neither gets a retry.
- `quorum check` names the final ruling invalid, after its retry or with no dispatch left for one.
- The final ruling is missing, after its retry or with no dispatch left for one.
- A losing position never answered, because Codex and its fallback both failed, or the cap ran out.
- A position rebutted, and the cap leaves no dispatch for the final ruling.

Then the coordinator writes `final_ruling` itself, the one ruling it ever writes:
`{decision: escalate, winner: null, change_or_reason: <the reason>, citations: <the first ruling's citations>, tested: [], inferences: []}`.
The reason is the line `quorum check` printed, the Codex status line, or `cap reached, N of M dispatches`.
Then ask the Human, with the first ruling as the recommended answer.

## Who wins

The governing winner is the final ruling's winner when the final ruling is `rule`; otherwise it is the first ruling's.
The report's Ruling item names it.

A final ruling may flip the first: it names as winner a position that rebutted.
A flip rests on at least one citation of the new winner's rebuttal that `tested` marks as supporting.
A flip is final: the overturned winner gets no rebuttal, and the rounds stop.
In a `complete` ledger, the governing winner's case needs a passing citation: a position wins on evidence or not at all.

## Asking the Human

A run asks at most one question: the escalated ruling, first or final.
It names every position with its citations, the recommended answer, and the one reason that decides it.
The answer goes into `human_answer`, word for word. Deferred, `human_answer` stays `null`, and the report's Open
questions carries it. A `human_answer` with no escalation makes `quorum check` exit 1.

## Report

After the core's Ledger item, which also names each position's runner, the judge (`architect`, on the Claude host's
model), any swap, the question-file path the coordinator wrote, and each cross point dropped:

1. **Ruling**: the governing winner and the reason, or `escalated` with the Human's answer or `deferred`.
2. **Cases**: each position's label, its case, and its citations.
3. **Cross points**: each backed point, with its `by` and `against`.
4. **Rebuttals**: each rebuttal or concession, the final ruling, and any flip.

The core's **Opinions** footnote lists each cross point that became `opinion`, and its **Dropped citations** footnote
each citation the architect marked `supports: false`, with its reason.

Next: the caller acts on the ruling. A lasting architecture decision goes to the `adr-writer` skill.

## Case

Codex sees only this brief and the question file.

```text
Role: advocate for position <id>, "<label>", in a decide quorum. Argue your position only.
The question file follows this brief. <settled>
Positions: <id and label of every position>.
Make the strongest case that the evidence supports <id>, in at most 200 words.
Never concede, and never weigh the other side: the other advocates argue theirs, and the architect weighs them all.
Your case is held to the evidence rules below, as an objection is.
<evidence>
Return one JSON object: {"case": {"claim", "citations": [{"kind", "ref", "quote"}]}}.
As an agent, put it in the handoff's artifacts. Change no file.
```

As `code-reviewer`, an advocate gets each brief of this file with `The question file follows this brief.` replaced by
`Question: <plan>.`

## Cross-examination

```text
Role: advocate for position <id>, "<label>", in a decide quorum, cross-examining the other cases.
The question file follows this brief. <settled>
The other positions' cases, word for word: <id, label, claim, and citations, per other position>.
Return at most 5 points. Each names in "against" the position it attacks, and shows where that case's evidence does
not hold, or where its claim does not follow from it. Never attack <id>, your own position.
Never concede, and never weigh the other side.
<evidence>
Return one JSON object: {"cross": [{"against", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
As an agent, put it in the handoff's artifacts. Change no file.
```

## Architect: ruling

The first ruling gets the cases and the backed cross points. The final ruling gets the first ruling and the
rebuttals. A retry gets the ruling and the line `quorum check` printed.

```text
Role: judge and moderator of a decide quorum. Rule which position the evidence supports. Never vote to agree, and
never split the difference. The run is capped at <cap> dispatches, so a ruling may get no second chance.
Question: <plan>. Ledger: <ledger>. <settled>
Open every file a case, point, or rebuttal cites: a quote that exists may still not support the claim.
To rule on: <for the first ruling: each case and each backed cross point, with its id and citations; for the final
ruling: the first ruling, and each rebuttal with its position and citations>.
Cases with no passing citation: <each `case X: no citation passes` line, or none>. Such a position cannot win, on the
first ruling or the final one: rule for another position, or escalate.
Decisions:
- rule: name the winner. In change_or_reason, name the losing case's strongest cited claim and the citation that
  defeats it. A rule rests on at least one citation of the winner's case that supports it.
- escalate: only for a dispute the evidence cannot settle: a value or product trade-off, evidence the repository
  does not hold, or evidence equal on both sides. Give every position, a recommended answer, and the one reason
  that decides it, and name what would settle it. Settle anything the evidence can settle.
Final ruling: rule for the first ruling's winner when no rebuttal holds. Rule for a position whose rebuttal holds,
which flips the ruling; a flip rests on at least one citation of that rebuttal that supports it. Or escalate.
Verdicts, on every ruling:
- `tested`: one entry per citation of each entry you rule on, each index once, from 0:
  {"of": the position or point id, "citation", "supports": true|false, "reason"}.
  Name each citation marked false in change_or_reason, with why.
- `inferences`: one entry per `inference:` line of each claim you rule on:
  {"statement": the line's text after the label, "holds": true|false, "reason", "citations"}.
Moderation: a cross point or rebuttal that is off the question, speculative, or out of proportion to what it attacks
gets `supports: false` on its citations, with that ground in "reason", and you name it in change_or_reason.
Moderation governs scope and proportion; it never decides which position wins.
<evidence>
The ruling carries its own citation; one with no passing citation is invalid.
Return one JSON object, in the handoff's artifacts:
{"decision": "rule|escalate", "winner": "<a position id on rule, null on escalate>", "change_or_reason",
"citations": [{"kind", "ref", "quote"}], "tested": [...], "inferences": [...]}.
Change no file.
```

## Rebuttal

Codex sees only this brief and the question file. So the brief carries the ruling and every citation the ledger
already holds, and a rebuttal can bring a new one.

```text
Role: advocate for position <id>, "<label>", in a decide quorum, answering the architect's ruling against it.
The question file follows this brief. <settled>
Your case: <its claim and citations>.
The ruling: <its winner, change_or_reason, citations, and tested verdicts>.
verdict "rebut": the ruling is wrong, with a citation not in this list of the citations already held:
<every citation of every case, cross point, and the ruling, one per line as kind ref "quote">.
A rebuttal may contest a `supports: false` verdict with that new citation.
verdict "concede": the ruling stands; cite the ruling's evidence you accept.
<evidence>
Return one JSON object: {"rebuttal": {"verdict": "rebut|concede", "claim", "citations": [{"kind", "ref", "quote"}]}}.
As an agent, put it in the handoff's artifacts. Change no file.
```
