# Product mode

Agents check that a product decision is really open, shape up to three options, and a product owner recommends one on
the evidence. The Human approves it. Read this file once the mode is `product`. Here `<plan>` is the question file.

The ruling is a recommendation: it never stands without the Human's answer, and it never becomes a product rule until
the project's docs say so. Start this mode only when the Human asks for it.

- [Roles](#roles): who does what, and the cap.
- [Rounds](#rounds): from the premise to the Human's answer.
- [Asking the Human](#asking-the-human): the one question.
- [Report](#report): this mode's items.
- Briefs: [Trace](#trace), [Frame](#frame), [Second framing](#second-framing), [Witness](#witness), [Case](#case),
  [Examiner](#examiner), and [Ruling](#ruling). Paste the Evidence block of `references/briefs.md` where a brief says `<evidence>`.

## Roles

`aidrian quorum roles product` prints this run's roles, judge, and caps. The values below are the defaults.

- **Tracer**: `explorer`, the current behavior, from the code and docs.
- **Framer**: `product-manager`, the premise and its options. **Second framer**: `ux-specialist`, options on its own.
- **Witness**: `ux-researcher`, as a persona. It never loads `product_sensitive` knowledge or the product's rules.
  Its reactions are hypotheses from a doc, never evidence about real users: they carry no citation, and no one rules on them.
- **Advocate**: `product-manager`, one fresh run per position, on `agent` by default. On `codex`, it runs
  `aidrian quorum codex --mode case`, with its fallback as `decide.md` says of a runner.
- **Examiner**: `critic`, one run that attacks every case.
- **Judge**: `product-manager`, in a fresh run that shaped nothing.

The cap is `N + 7` dispatches for N positions, 10 for three: the trace, the frame, the second framing, the witness, N
cases, the examiner, the ruling, and one retry. Advocates on Codex add one fallback each.
A second model is optional. `same_model` records when positions share a runner, and the report shows it.

## Rounds

1. **Trace.** The tracer, with the Trace brief.
2. **Frame.** The framer and the second framer, in parallel, each without the other's answer.
3. **Premise.** The framer answers `open: false` when the written rules settle the question, or when it is not a
   product decision. Then stop before any ledger, and report the answer with its citations: there is nothing to decide.
4. **Freeze.** Merge the options into 2 or 3 that differ in what a user gets; merge only exact duplicates, and keep
   each framer's wording. Write the question file as `decide.md` § Question file says, with the framing in `## Context`,
   and show the Human the path. It never changes from here: a later change is a condition on the ruling.
5. **Open the ledger.** Write every field `references/ledger.md` § Product-mode fields lists, `status: open`, and run `quorum check`.
6. **Witness.** Each doc tagged `personas` that the options touch is a candidate: pick the one whose tasks the decision
   changes most. With none, `witness` stays `null`, and the report says no persona reacted. Never invent one.
7. **Cases.** One advocate per position, in parallel. A position with no case stops the run with `blocked`.
8. **Examiner.** The examiner, with every case. Number its points `X1` to `X9`, `by: X`, `status: pending`. Run `quorum check`.
9. **Ruling.** The judge, on the cases, the backed points, and the persona's reactions. Write `ruling` and `outcome`, and run
   `quorum check`. One the check names invalid, or a missing one, goes back once. Invalid again, or missing again,
   write `{decision: escalate, winner: null, change_or_reason: <the line it printed>, citations: <its citations>, tested: [], inferences: []}`.
10. **Ask the Human**, then write `human_answer`, `status: complete`, and run `quorum check`.

## Asking the Human

A run asks one question, on a rule and on an escalation alike.
Each position is an option named by its label, with its citations in the description, and the recommended one first
with the one reason that decides it. Say which written rule would change, and each fact that would flip the ruling and how to settle it.
The answer goes into `human_answer`, word for word. Deferred, it stays `null`, the report's Open questions carries the
question, and nothing is decided.

A session that acts on the answer records it where the project keeps product rules: the ledger is local to one machine.

## Report

After the core's Ledger item, which also names each role's agent:

1. **Premise**: what the trace found, and why the decision is open.
2. **Recommendation**: the winner, or `escalated`; its conditions; and the Human's answer, or `deferred`.
3. **What would flip it**: each fact and how to settle it.
4. **Disputes left**: each topic and its owner.
5. **Options**: each label, its case, the persona's reaction marked as a hypothesis, and each backed point against it.

## Trace

```text
Role: tracer in a product decision. Report what the product does today on this question, and where its rules say so.
Question: <the Human's text>.
Cite each statement with a file and line or a doc section. Say what you could not find. Propose nothing. Change no file.
```

## Frame

```text
Role: product owner framing a decision. The trace: <the tracer's answer>. Question: <the Human's text>.
First: is this decision open? Answer open: false when the written rules settle it, or it is not a product decision.
A premise the question states may be wrong: test it against the trace.
When open, propose up to three options that differ in what a user gets, and state which written rule each would change.
<evidence>
Return one JSON object, in the handoff's artifacts: {"open", "premise": {"summary", "citations"}, "options": [{"label", "description"}]}.
Change no file.
```

## Second framing

```text
Role: second framer of a product decision, working alone. The trace: <the tracer's answer>. Question: <the Human's text>.
Propose up to three options that differ in what a user gets, including any the question does not name.
Return one JSON object, in the handoff's artifacts: {"options": [{"label", "description"}]}. Change no file.
```

## Witness

Give it the persona doc and each option, in the user's terms, with no product rule, trace, or case.

```text
Role: <persona id>, as its doc describes. Persona doc: <path>. Load no other knowledge.
The options, each as what this person would meet: <id, label, description>.
For each, say what this person would do and where they would get stuck. Say when the doc does not tell you, and never guess a fact about real users.
Return one JSON object, in the handoff's artifacts: {"reactions": [{"position", "reaction"}]}. Change no file.
```

## Case

```text
Role: advocate for position <id>, "<label>", in a product decision. Argue your position only.
Question: <plan>. Positions: <id and label of every position>.
Make the strongest case, in at most 200 words, from the product's docs, decision records, code, and data committed to the repository.
A persona's reaction is not evidence. A fact you cannot cite goes on an `inference:` line.
<evidence>
Return one JSON object: {"case": {"claim", "citations": [{"kind", "ref", "quote"}]}}.
As an agent, put it in the handoff's artifacts. Change no file.
```

## Examiner

```text
Role: examiner in a product decision. Argue for no position.
Question: <plan>. The cases, word for word: <id, label, claim, and citations, per position>.
Return at most 9 points. Each names in "against" the position it attacks, and shows where its evidence does not hold,
its claim does not follow, or a cost to a user goes unnamed.
<evidence>
Return one JSON object, in the handoff's artifacts: {"cross": [{"against", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## Ruling

```text
Role: product owner recommending one option to the Human. Never split the difference, and never merge options.
The docs not settling the point does not block you here: recommend on the evidence and the product's stated goals, and the Human approves.
Question: <plan>. Ledger: <ledger>. The run is capped at <cap> dispatches, so a ruling may get no second chance.
Open every file a case or point cites: a quote that exists may still not support the claim.
To rule on: <each case and each backed point, with its id and citations>.
Cases with no passing citation: <each `case X: no citation passes` line, or none>. Such a position cannot win.
The persona's reactions, hypotheses only: <each, or none>. They may add a condition; they never decide the winner.
Decisions:
- rule: name the winner. In change_or_reason, name the losing case's strongest cited claim and the citation that
  defeats it. A rule rests on at least one citation of the winner's case that supports it, other than the persona doc.
- escalate: only when no option can be recommended, as when a missing fact decides everything. Give every position
  and what would settle it.
Verdicts: `tested`, one entry per citation of each entry you rule on, each index once, from 0:
{"of": the position or point id, "citation", "supports": true|false, "reason"}.
`inferences`, one entry per `inference:` line: {"statement", "holds": true|false, "reason", "citations"}.
On a rule, also return `outcome`: "conditions", changes the winner needs, each a sentence; "flips_if": [{"fact", "how_to_settle"}],
each unknown that would change the winner; "disputes": [{"topic", "owner"}], smaller disagreements and the agent or person who settles each.
<evidence>
Return one JSON object, in the handoff's artifacts:
{"decision": "rule|escalate", "winner", "change_or_reason", "citations": [{"kind", "ref", "quote"}], "tested": [...], "inferences": [...], "outcome"}.
Change no file.
```
