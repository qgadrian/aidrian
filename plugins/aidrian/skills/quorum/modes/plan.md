# Plan mode

Two adversaries attack a plan, and the architect rules on each objection. Read this file once the mode is `plan`.

- [Roles](#roles): who argues, who rules, and on which agent.
- [Rounds](#rounds): the cap, the merge, the rulings, the rebuttals, and the proportionality pass.
- [Asking the Human](#asking-the-human): where each answer goes.
- [Report](#report): this mode's items.
- Briefs: [A: it will break](#a-it-will-break), [B: the wrong thing, or too much](#b-the-wrong-thing-or-too-much),
  [Architect: ruling](#architect-ruling), [Proportionality pass](#proportionality-pass),
  [A rebuttal](#a-rebuttal), and [B rebuttal](#b-rebuttal).

## Roles

- **A, "it will break"**: `code-reviewer`.
- **B, "the wrong thing, or too much"**: Codex, through `aidrian quorum codex`; its agent fallback is `product-manager`.
  B's first objection is the strongest alternative plan, or a note that none beats the plan.
- **Architect**: `architect`. It rules on each objection, and runs the proportionality pass.

Each adversary returns at most 5 objections, each `blocking` or `important`, and its improvements, which no one rules on.
The coordinator moves every `improvement` entry, A's or B's, to `notes` with its `by`, keeps the first 5 notes and
the first 5 objections per adversary, and numbers the objections `A1`, `A2`, ... and `B1`, `B2`, ..., in the
adversary's order.

## Rounds

The cap is 8 dispatches: one is reserved for the proportionality pass, and no other dispatch may spend it.

1. **Objections.** A and B in parallel, each with the plan, the gate verdicts, and its brief.
2. Write the ledger with `mode: plan` and `status: open`, and run `quorum check`.
3. **Merge**, by the coordinator, with no dispatch. Two backed objections of different adversaries are duplicates when
   they anchor on the same plan section and ask for the same change, judged by their claims' text, never by whether
   they hold. Unsure means no merge. The survivor is the higher severity; on a tie, the one with more passing
   citations; on a tie, A's. The other gets `status: merged` and `merged_into: <survivor>`, and the coordinator appends
   its citations to the survivor's `citations`, so the architect's `tested` covers them. Run `quorum check`.
4. **Rulings.** The architect rules on each backed objection that is not merged, with its brief. Record the rulings,
   and run `quorum check`.
5. **Rebuttals**, only for objections `rejected` or partly accepted; an `escalated` or `merged` one gets none. Only the
   adversary that raised one answers, A and B in parallel; `--mode rebut` runs only when B has such an objection.
   When one dispatch outside the reserved one is left and both A and B have objections to answer, neither runs, and
   those objections escalate.
   Record them, and run `quorum check`. A concession keeps the first ruling and skips the final one.
   When something is rebutted and a dispatch outside the reserved one is left, the architect rules once more on those
   only, and `quorum check` runs again; with none left, those objections escalate.
   A final ruling other than `accept` escalates the objection.
6. **Proportionality pass**, when any first or final ruling is `accept`: the architect gets the accepted set with its
   brief. Write its answer to `proportionality`, set each flagged objection `escalated` in the same write, and run
   `quorum check`. With no accept, write `proportionality: {flagged: []}` with no dispatch. When the pass returns no
   usable answer, write `proportionality: {flagged: [], failed: true}`, with no retry, and the report says the pass
   failed.
   Then the rounds stop.

The longest run: 2 adversaries, 1 ruling, 1 retry, 2 rebuttals, 1 final ruling, and the pass. A fallback costs one more
and happens at most once, since it sticks; then the retry and the final ruling cannot both run.

An unflagged valid partial accept's accepted part always stands. Its rebuttal, its escalation, and the Human's answer cover only
its rejected part, so `escalated` on it means that part is escalated.

A proportionality flag is the exception: on a partial accept, it covers the accepted part.

## Asking the Human

An answer goes into `human_answers`, and the objection becomes `accepted` or `rejected`; an unflagged valid partial
accept stays `accepted`, with its rejected part settled by the answer.
A flagged objection's question carries the accepted change, the architect's reason, and `smaller_change` as the
recommended answer; when `smaller_change` is empty, the recommended answer is none, dropping the change, with the
flag's reason as the deciding reason. The answer settles it: the change as accepted or the smaller change makes it
`accepted`, none makes it `rejected`. When a flagged partial accept also has its rejected part escalated, one answer settles both parts.

## Report

After the core's Ledger item, which also lists every note dropped:

1. **Accepted**: each id with its plan change, including the accepted part of every valid partial accept, even escalated.
   A flagged objection the Human has not answered is left out: it shows under Escalated and Proportionality.
   For an answered one, the change is the one the answer chose.
2. **Rejected**: each id with its `ground` and counter-evidence, or, when the Human rejected it, the Human's answer.
3. **Escalated**: each id with both positions, their citations, and the Human's answer, or `deferred`.
4. **Merged**: each merged id with its survivor; a merged objection's outcome is its survivor's. Or `no duplicates`.
5. **Proportionality**: each flagged id with its reason, the smaller change, and the Human's answer or `deferred`;
   or `none flagged`; or `pass failed`, with what it returned when this run dispatched it.

Footnotes, beside the core's: **Notes**, each with its `by`, claim, and citations; context, never a plan change.

Next: `planning-agent` turns accepted objections and the Human's answers into a plan diff for the Human to approve.

## A: it will break

```text
Role: adversary A of a plan quorum. Attack whether the plan will break: correctness, failure halfway through,
concurrency, ordering, missing tests, and gaps against the code, as design properties of the plan.
Plan: <plan>. Gate verdicts, authoritative: <gates>. <settled>
Scope: every objection anchors on what the plan states (approach, slices, closure criteria, planned tests, files in
scope), or on a code fact the stated approach contradicts. An objection about how the code will be written, which needs
an implementation detail the plan does not state, is rejected with ground `implementation`: how the code gets written
is the pull request review's job.
<evidence>
Return at most 5 objections, each blocking or important, most severe first (critical and high are read as blocking,
medium as important, low as improvement). Then, at most 5 improvements with severity improvement: notes that no
one rules on. At most 7 entries in all.
Return one JSON object, in the handoff's artifacts: {"objections": [{"severity", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## B: the wrong thing, or too much

```text
Role: adversary B of a plan quorum. Attack whether the plan is the wrong thing, or too much: scope, product fit,
a simpler alternative that meets the goal, and contradictions with the project's docs and decision records.
The plan under review follows this brief. Gate verdicts, authoritative: <gates>. <settled>
State, as your first objection, the strongest alternative plan that meets the same goal: what it does instead, in at
most ten lines, with the citations that show it fits the project. When no alternative beats the plan, say so in an
improvement entry instead, with the citation that shows the plan is the simplest fit.
<evidence>
Return at most 5 objections, each blocking or important: the alternative first, then the rest most severe first
(critical and high are read as blocking, medium as important, low as improvement). Then, at most 5 improvements
with severity improvement: notes that no one rules on. At most 7 entries in all.
Return one JSON object: {"objections": [{"severity", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
As an agent, put it in the handoff's artifacts. Change no file.
```

As `product-manager`, B gets this brief with `The plan under review follows this brief.` replaced by `Plan: <plan>.`

## Architect: ruling

The first ruling lists every backed objection that is not merged; the final ruling lists only the rebutted ones, each
with its rebuttal. A retry lists only the rulings `quorum check` named invalid, each with the reason it printed, and the
backed objections the architect left without a ruling.

```text
Role: adjudicator and moderator of a plan quorum. Rule on each objection below; never vote to agree, and never settle
on a compromise between the two sides. The run is capped at 8 dispatches, so a ruling may get no second chance.
In eight earlier runs the architect accepted 56 of A's 56 objections at first ruling. An objection the plan covers is
rejected, not accepted with a restatement.
Plan: <plan>. Ledger: <ledger>. Gate verdicts, authoritative: <gates>. <settled>
Open every file an objection cites: a quote that exists may still not support the claim.
Objections to rule on: <id, by, severity, claim, citations, and for the final ruling the rebuttal, per objection>.
Start each change_or_reason with one line, `Covers: #<anchor> "<quote>"` or `Covers: nothing`: what the plan already
states on the point.
Decisions:
- reject, with one ground in "ground", each with its counter-evidence:
  `covered` (the plan already states it: the plan citation),
  `implementation` (it needs a detail of how the code gets written, the pull request review's job: the plan citation
  of the design-level approach the plan does state),
  `settled` (it reopens a settled answer: the plan's revision-history line that applied it),
  `off-goal` (outside the plan's goal or scope),
  `disproportionate` (the change costs more than the risk it removes),
  `speculative` (no cited failure path).
- accept: only a change no plan section states, and cite the `plan` section it changes, on the first ruling and on
  the final one. Write the change in words, then two lines: `Cost: <the files, rules, and tests it adds>` and
  `Removes: <the cited risk>`. Prefer the smallest change that removes the cited risk: accept that change, and name the
  larger one asked for in a last line, "Rejected part: <what does not hold, and why>". When only part of the objection
  holds, accept that part, and name the rest in the same line.
- escalate: a product or lasting architecture trade-off only the Human can settle: both positions, a recommended
  answer, and the one reason that decides it.
Final ruling: accept when the rebuttal holds, so the objection, or its rejected part, is accepted; any other decision
leaves it contested, and it goes to the Human.
Verdicts, on every ruling:
- `tested`: one entry per citation of the objection (on the final ruling, of the rebuttal), each index once, from 0:
  {"citation", "supports": true|false, "reason"}. Name each citation marked false in change_or_reason, with why.
  An accept rests on at least one citation that supports.
- `inferences`: one entry per `inference:` line of the objection's claim (on the final ruling, the rebuttal's):
  {"statement": the line's text after the label, "holds": true|false, "reason", "citations"}.
Moderation governs scope and proportion, never which side wins: a ground is never a reason to prefer one adversary.
<evidence>
Rule on every objection listed. Each ruling carries its own citation; one with no passing citation is invalid.
Return one JSON object, in the handoff's artifacts:
{"rulings": [{"objection_id", "decision": "accept|reject|escalate", "change_or_reason", "citations": [{"kind", "ref", "quote"}],
"tested": [...], "inferences": [...], "ground": "<on a reject only>"}]}.
Change no file.
```

## Proportionality pass

The set is every objection whose first or final ruling is `accept`, each with its accepted change and its `Cost:` and
`Removes:` lines; for a partial accept, its accepted part.

```text
Role: moderator of a plan quorum, reviewing the accepted changes as a set. Plan: <plan>. Ledger: <ledger>.
The plan's Goal and Scope, word for word: <goal and scope>.
Accepted changes: <id, the change, its Cost and Removes lines, per objection>.
Flag only an accepted change that, with the others, over-complicates the plan for its goal, and give the smaller
change that keeps its risk removed, or "" when you see none. Never reopen a rejection, an escalation, or a contested
rebuttal, never add a change, and never weigh which adversary raised it. An empty list is the common answer.
Return one JSON object, in the handoff's artifacts:
{"flagged": [{"objection_id", "reason", "smaller_change"}]}.
Change no file.
```

## A rebuttal

```text
Role: adversary A of a plan quorum, answering the architect's rulings on A's objections.
Plan: <plan>. Ledger: <ledger>. <settled>
Answer each objection below, and only these:
<for each A objection rejected or partly accepted, and not escalated: its id, claim, and citations, and its first ruling with its citations, tested verdicts, and ground>.
For a partly accepted objection, answer only its rejected part.
verdict "rebut": the ruling is wrong, with a citation that no objection or first ruling in the ledger already holds.
A rebuttal may contest a `supports: false` verdict or a ground with that new citation.
verdict "concede": the ruling stands; cite the ruling's evidence you accept.
<evidence>
Return at most 5 entries, one per objection id. Return one JSON object, in the handoff's artifacts:
{"rebuttals": [{"objection_id", "verdict": "rebut|concede", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## B rebuttal

Codex sees only this brief and the plan, so the brief carries each objection with its citations and first ruling, and
every citation the ledger already holds, so a rebuttal can bring a new one. An `escalated` objection gets no rebuttal.
The coordinator passes the ledger as `--ledger`, which the command checks the answer against.

```text
Role: adversary B of a plan quorum, answering the architect's rulings on B's objections.
The plan under review follows this brief. <settled>
Answer each objection below, and only these:
<for each B objection rejected or partly accepted, and not escalated: its id, claim, and citations, and its first ruling with its citations, tested verdicts, and ground>.
Each rejected objection needs an entry. For a partly accepted objection, answer only its rejected part.
verdict "rebut": the ruling is wrong, with a citation not in this list of the citations already held:
<every citation of every objection and every first ruling in the ledger, one per line as kind ref "quote">.
A rebuttal may contest a `supports: false` verdict or a ground with that new citation.
verdict "concede": the ruling stands; cite the ruling's evidence you accept.
<evidence>
Return at most 5 entries, one per objection id:
{"rebuttals": [{"objection_id", "verdict": "rebut|concede", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
As an agent, put it in the handoff's artifacts. Change no file.
```

As `product-manager`, B gets this brief with `The plan under review follows this brief.` replaced by `Plan: <plan>.`
