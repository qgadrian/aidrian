# Quorum briefs

The text the coordinator gives each role. Fill every `<placeholder>`, and paste the Evidence block where a brief names it.

- [Shared parts](#shared-parts): the placeholders, the Evidence block, and the settled answers.
- [A: it will break](#a-it-will-break), for `code-reviewer`.
- [B: it is the wrong thing, or too much](#b-it-is-the-wrong-thing-or-too-much), for Codex or `product-manager`.
- [Architect: ruling](#architect-ruling), for the first ruling and for the final ruling.
- [A rebuttal](#a-rebuttal) and [B rebuttal](#b-rebuttal).

## Shared parts

Placeholders:

- `<plan>`: the plan's absolute path. `<ledger>`: the ledger's absolute path.
- `<gates>`: the gate verdicts a calling skill passed, word for word, or `none`.
- `<knowledge>`: `aidrian-knowledge`, or its full path from the start hook when it is not on PATH.
  A brief for Codex always takes the full path, since Codex's PATH may not include it.
- `<settled>`: the Settled answers block below, or `none`.

### Evidence block

Paste this, word for word, where a brief says `<evidence>`:

```text
Evidence: every objection, ruling, and rebuttal carries at least one citation {kind, ref, quote}, all three required.
- doc: ref is path#anchor of a knowledge doc; the quote is in that section.
- adr: ref is path#anchor of a decision record; the quote is in that section.
- code: ref is path:line; the quote is in that file (the line is advisory).
- plan: ref is #anchor of a heading in the plan under review; the quote is in that section.
- absence: ref is a file or folder path; the quote is a needle that no file git tracks there contains.
Paths are relative to the repository root and stay inside it. An anchor is a heading's text or its slug.
The quote is verbatim, at most 200 characters, and compared with whitespace collapsed.
A citation that fails this check does not count; an objection with no passing citation is dropped as opinion.
Find docs with `<knowledge> route <tag>` and `<knowledge> search <words>`.
```

### Settled answers

When earlier `complete` ledgers of this plan hold `human_answers` (the `quorum` skill's `references/ledger.md`
§ Settled answers says which ledgers), paste one line per answer, with the claim of the objection it answered:

```text
Settled by the Human, not to be reopened:
- "<the earlier objection's claim>": <the Human's answer>
The plan's revision history records each one it applied.
```

## A: it will break

```text
Role: adversary A of a plan quorum. Attack whether the plan will break: correctness, failure halfway through,
concurrency, ordering, missing tests, and gaps against the code, as design properties of the plan.
Plan: <plan>. Gate verdicts, authoritative: <gates>. <settled>
Scope: every objection anchors on what the plan states (approach, slices, closure criteria, planned tests, files in
scope), or on a code fact the stated approach contradicts. An objection about how the code will be written, which needs
an implementation detail the plan does not state, is dropped as opinion: how the code gets written is the pull request
review's job.
<evidence>
Return at most 7 objections, ranked by severity, most severe first: blocking, important, or improvement
(critical, high, medium, and low are read as these).
Return one JSON object, in the handoff's artifacts: {"objections": [{"severity", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## B: it is the wrong thing, or too much

```text
Role: adversary B of a plan quorum. Attack whether the plan is the wrong thing, or too much: scope, product fit,
a simpler alternative that meets the goal, and contradictions with the project's docs and decision records.
The plan under review follows this brief. Gate verdicts, authoritative: <gates>. <settled>
<evidence>
Return at most 7 objections, ranked by severity, most severe first: blocking, important, or improvement
(critical, high, medium, and low are read as these).
Return one JSON object: {"objections": [{"severity", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
As an agent, put it in the handoff's artifacts. Change no file.
```

As `product-manager`, B gets this brief with `The plan under review follows this brief.` replaced by `Plan: <plan>.`

## Architect: ruling

The first ruling lists every backed objection; the final ruling lists only the rebutted ones, each with its rebuttal.
A retry lists only the rulings `quorum check` named invalid, each with the reason it printed,
and the backed objections the architect left without a ruling.

```text
Role: adjudicator of a plan quorum. Rule on each objection below; never vote to agree, and never settle on a
compromise between the two sides. Each adversary raised at most 7 objections, and the run is capped at 7 dispatches,
so a ruling may get no second chance.
Plan: <plan>. Ledger: <ledger>. Gate verdicts, authoritative: <gates>. <settled>
Open every file an objection cites: a quote that exists may still not support the claim.
Objections to rule on: <id, by, severity, claim, citations, and for the final ruling the rebuttal, per objection>.
Decisions:
- accept: state the required plan change in words. When only part of the objection holds, accept that part with a
  precise change, and end with one line "Rejected part: <what does not hold, and why>".
- reject: the counter-evidence. An objection that reopens a settled answer is rejected, citing the plan's
  revision-history line that applied it.
- escalate: a product or lasting architecture trade-off only the Human can settle: both positions, a recommended
  answer, and the one reason that decides it.
Final ruling: accept when the rebuttal holds, so the objection, or its rejected part, is accepted; any other decision
leaves it contested, and it goes to the Human.
<evidence>
Rule on every objection listed. Each ruling carries its own citation; one with no passing citation is invalid.
Return one JSON object, in the handoff's artifacts:
{"rulings": [{"objection_id", "decision": "accept|reject|escalate", "change_or_reason", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## A rebuttal

```text
Role: adversary A of a plan quorum, answering the architect's rulings on A's objections.
Plan: <plan>. Ledger: <ledger>. <settled>
Answer each objection below, and only these:
<for each A objection rejected or partly accepted, and not escalated: its id, claim, and citations, and its first ruling with its citations>.
For a partly accepted objection, answer only its rejected part.
verdict "rebut": the ruling is wrong, with a citation that no objection or first ruling in the ledger already holds.
verdict "concede": the ruling stands; a concession needs no citation.
<evidence>
Return at most 7 entries, one per objection id. Return one JSON object, in the handoff's artifacts:
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
<for each B objection rejected or partly accepted, and not escalated: its id, claim, and citations, and its first ruling with its citations>.
Each rejected objection needs an entry. For a partly accepted objection, answer only its rejected part.
verdict "rebut": the ruling is wrong, with a citation not in this list of the citations already held:
<every citation of every objection and every first ruling in the ledger, one per line as kind ref "quote">.
verdict "concede": the ruling stands; a concession needs no citation.
<evidence>
Return at most 7 entries, one per objection id:
{"rebuttals": [{"objection_id", "verdict": "rebut|concede", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
As an agent, put it in the handoff's artifacts. Change no file.
```

As `product-manager`, B gets this brief with `The plan under review follows this brief.` replaced by `Plan: <plan>.`
