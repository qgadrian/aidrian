---
name: quorum
description: Run an expert quorum on a high-stakes plan, where two adversaries raise cited objections and an architect rules on each, into a ledger.
---

# quorum

Two adversaries attack a plan, and an architect rules on each objection, all with cited evidence.
The output is an objection ledger, not a consensus.
This session coordinates: it dispatches, writes the ledger, runs the checks, and asks the Human.
It never rules, never edits the plan, and never commits.

Before you start, follow the `knowledge` skill. Knowledge tags: `product_sensitive`, `docs`.

## Inputs

```text
<plan path>
```

Any plan; without a path, find it as the `plan-review` skill's step 1 does. A calling skill also passes the gate
verdicts and the trigger, the plan line or gate that started the run; run by the Human, the trigger is `the Human asked`.

## Roles

Pick each owner by the agent rule in the `knowledge` skill.
[references/briefs.md](references/briefs.md) holds every brief: read it before the first dispatch, and fill each placeholder.

- **A, "it will break"**: `code-reviewer`.
- **B, "it is the wrong thing, or too much"**: Codex, through `aidrian quorum codex`. On the Codex host, or once a
  `codex` call exits non-zero, this and every later B run of the quorum go to `product-manager` with the same brief.
- **Adjudicator**: `architect`. It rules on each objection and never votes to agree.

When any B run was an agent, the ledger records `same_model: true` and why, as ledger.md § Fields says.

Each adversary returns at most 7 objections, ranked `blocking`, `important`, or `improvement`.

## Commands

Give every `aidrian quorum codex` shell call a 15-minute timeout: a shorter one kills the wrapper, not the detached Codex.
Write each brief and answer in a fresh `mktemp -d` folder.

```bash
aidrian quorum codex --plan <plan> --brief <dir>/b.md --out <dir>/b.json
aidrian quorum codex --mode rebut --ledger <ledger> --plan <plan> --brief <dir>/b-rebut.md --out <dir>/b-rebut.json
aidrian quorum check <ledger> --plan <plan>
```

`codex` prints one line, `{"status", "reason"}`, and exits 0 on `done`, 3 on `unavailable`, and 1 on `timed_out`,
`quota`, or `failed`. When `aidrian` is not on PATH, run it from the folder that holds the `aidrian-knowledge` the start hook names.

## Evidence rule

Every objection, ruling, and rebuttal cites at least one `{kind, ref, quote}`: `doc`, `adr`, `code`, `plan`, or `absence`,
each with the ref form the briefs' Evidence block gives, and a verbatim quote of at most 200 characters.
`quorum check` proves a quote exists, not that it supports the claim: the architect opens the cited files.

- An objection with no passing citation becomes `opinion`: never ruled on, never accepted, and named only in the report's footnote.
- A ruling `check` names invalid, and a backed objection the architect left without one, go back to the architect once.
  Invalid again, the objection escalates; still without a ruling, stop with `blocked`.
- A rebuttal `check` names invalid (no passing citation, or nothing new) escalates its objection.

Hold every agent's answer to its schema before writing it, as [references/ledger.md](references/ledger.md) § Agent answers says.
When `quorum check` still exits 1, stop with `blocked`, quoting what it printed.

## Ledger

`<state>/quorum/<name>-<plan-hash>.json`: `<state>` is what `aidrian state` prints, `<name>` the plan's file name
without `.md` (`<parent-folder>-plan` for a `plan.md`), and `<plan-hash>` is `git hash-object <plan>`.
[references/ledger.md](references/ledger.md) gives every field and what each round writes: read it before writing the ledger.

Before round 1:

- A `complete` ledger at this hash for which `quorum check` exits 0 is reused: skip the rounds, and report from it.
- An `open` ledger at this hash is discarded, and the run starts over.
- Every other `complete` ledger whose `plan` is this plan's absolute path gives its Human answers to every brief as
  settled, as ledger.md § Settled answers says. They are never copied into the new ledger.

## Rounds

The cap is 7 dispatches. Every agent dispatch and Codex run counts, retries and fallbacks included.
Whatever the cap leaves open escalates to the Human.

1. **Objections.** A and B in parallel, each with the plan, the gate verdicts, and its brief.
2. **Rulings.** Write the ledger with `status: open`, run `quorum check`, then the architect rules on each backed objection:
   - `accept`: the required plan change, in words. When only part holds, it accepts that part with a precise change
     and names the rest in a `Rejected part:` line.
   - `reject`: the counter-evidence.
   - `escalate`: a product or lasting architecture trade-off only the Human can settle, with both positions,
     a recommended answer, and the one reason that decides it.

   Record the rulings, and run `quorum check`.
3. **Rebuttals**, only for objections `rejected` or partly accepted; an `escalated` one gets none. Only the adversary
   that raised one answers, A and B in parallel; `--mode rebut` runs only when B has such an objection. When one dispatch
   is left and both have one, neither runs, and those objections escalate. Each answers by objection id, `rebut` or
   `concede`. Record them, and run `quorum check`. A concession keeps the first ruling and skips the final one.
   When something is rebutted, the architect rules once more on those only, and `quorum check` runs again.
   A final ruling other than `accept` escalates the objection. Then the rounds stop.

The longest run: 2 adversaries, 1 ruling, 1 retry, 2 rebuttals, and 1 final ruling. A fallback costs one more and
happens at most once, since it sticks; then the retry and the final ruling cannot both run.

A valid partial accept's accepted part always stands. Its rebuttal, its escalation, and the Human's answer cover only its
rejected part, so `escalated` on it means that part is escalated.

No compromise: a dispute the evidence does not settle escalates with both positions, never split down the middle.

## Asking the Human

Ask the escalations one at a time, as the `challenge` skill asks, and wait for each answer before the next.
Each question names both positions with their citations, the recommended answer, and the one reason that decides it.
An answer goes into `human_answers`, and the objection becomes `accepted` or `rejected`; a partial accept stays
`accepted` either way, with its rejected part settled by the answer.
An escalation the Human defers stays `escalated` and goes into the report's open questions: the plan cannot be
`status: ready` while it is open.

Then write `status: complete`, and run `quorum check` once more; it must exit 0.

## Report

1. **Ledger**: its path, `trigger`, `same_model`, `same_model_reason`, dispatches used of 7, and each dropped entry or citation.
2. **Accepted**: each id with its plan change, including the accepted part of every valid partial accept, even escalated.
3. **Rejected**: each id with its counter-evidence.
4. **Escalated**: each id with both positions, their citations, and the Human's answer, or `deferred`.
5. **Open questions**: each deferred escalation, for the plan's `Open questions`.
6. **Revision-history line**: the objection ids to apply and each Human answer, for the plan change that applies them.
7. **Opinions**, as a footnote: each id and claim.

Next: `planning-agent` turns accepted objections and the Human's answers into a plan diff for the Human to approve.
