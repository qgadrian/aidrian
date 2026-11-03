---
name: quorum
description: Run an expert quorum on a high-stakes plan, where two adversaries raise cited objections and an architect rules on each, into a ledger.
---

# quorum

Experts argue over the input with cited evidence, and an architect rules. The output is a ledger, not a consensus.
This session coordinates: it dispatches, writes the ledger, runs the checks, and asks the Human.
It never rules, never edits the input, and never commits.

Before you start, follow the `knowledge` skill. Knowledge tags: `product_sensitive`, `docs`.

## Inputs

```text
[plan] <plan path>
```

The mode is a leading keyword, never a flag. The first row that holds picks it:

| Input | Mode |
| --- | --- |
| The keyword | that mode |
| A file with YAML frontmatter holding `plan_kind`, a file under `<state>/plans/`, the plan `plan-review` passes, or no path | `plan` |
| Anything else | stop and ask which mode |

With no path, find the plan as the `plan-review` skill's step 1 does.
Read `modes/<mode>.md` once the mode is selected, and only that one. The mode files: [modes/plan.md](modes/plan.md).
A calling skill also passes the gate verdicts and the trigger, the plan line or gate that started the run;
run by the Human, the trigger is `the Human asked`.

## Roles

Pick each owner by the agent rule in the `knowledge` skill. The mode file names each role, its agent, and its brief.
[references/briefs.md](references/briefs.md) holds the parts every brief pastes: read it before the first dispatch,
and fill each placeholder.

A Codex role runs through `aidrian quorum codex`. On the Codex host, or once a `codex` call exits non-zero, it and
every later run of that role go to the fallback agent the mode file names, with the same brief.
When any Codex role ran as an agent, the ledger records `same_model: true` and why, as ledger.md § Fields says.
The judge, `architect`, rules and never votes to agree.

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
`quorum check` proves a quote exists, not that it supports the claim: the judge opens the cited files.

- Each statement of fact carries its own citation; one its author cannot cite goes on its own line as `inference: <statement>`.
- Where a knowledge doc or decision record covers the point, prefer a `doc` or `adr` citation.
- The judge gives each citation it rules on a verdict in `tested`, and each `inference:` line one in `inferences`.
  A citation marked `supports: false` stays in the ledger and leaves the report's evidence.
- A concession cites the evidence of the ruling it accepts.
- A `pending` objection with no passing citation becomes `opinion`: never ruled on or accepted, and only in the report's footnote.
- A ruling `check` names invalid, and a backed objection the judge left without one, go back to the judge once.
  Invalid again, the objection escalates; still without a ruling, stop with `blocked`.
- A rebuttal or concession `check` names invalid escalates its objection.

Hold every agent's answer to its schema before writing it, as [references/ledger.md](references/ledger.md) § Agent answers says.
When `quorum check` still exits 1, stop with `blocked`, quoting what it printed.

## Moderator

The judge also moderates: it keeps the run on the input's goal. A rejection names its ground: `covered`,
`implementation`, `settled`, `off-goal`, `disproportionate`, or `speculative`. An accept states its `Cost:` beside the
risk it `Removes:`, and the judge prefers the smallest change that removes the cited risk.
Moderation governs scope and proportion, never which side wins.

## Ledger

`<state>/quorum/<name>-<plan-hash>.json`, where `<state>` is what `aidrian state` prints and `<plan-hash>` is
`git hash-object <plan>`. It records the mode in `mode`.
[references/ledger.md](references/ledger.md) gives every field and what each round writes: read it before round 1.

Before round 1:

- A `complete` ledger at this hash for which `quorum check` exits 0 is reused: skip the rounds, and report from it,
  with every line `check` printed in the Ledger item.
- An `open` ledger at this hash, or a `complete` one whose check exits 1, is discarded, and the run starts over.
- Every other `complete` ledger of the same mode whose `plan` is this input's absolute path gives its Human answers to
  every brief as settled, as ledger.md § Settled answers says. They are never copied into the new ledger.

The mode file sets the dispatch cap. Every agent dispatch and Codex run counts, retries and fallbacks included.
Whatever the cap leaves open escalates to the Human.
No compromise: a dispute the evidence does not settle escalates with both positions, never split down the middle.

## Asking the Human

Ask the escalations one at a time, as the `challenge` skill asks, and wait for each answer before the next.
Each question names both positions with their citations, the recommended answer, and the one reason that decides it.
The mode file says where an answer goes. An escalation the Human defers stays open and goes into the report's open
questions: the plan cannot be `status: ready` while it is open.

Then write `status: complete`, and run `quorum check` once more; it must exit 0.

## Report

1. **Ledger**: its path, `mode`, `trigger`, `same_model`, `same_model_reason`, dispatches used of the cap, and each
   dropped entry or citation.
2. The mode file's items, in its order.
3. **Open questions**: each deferred escalation, for the plan's `Open questions`.
4. **Revision-history line**: the objection ids to apply and each Human answer, for the plan change that applies them.
5. Footnotes: **Opinions**, each id and claim; **Dropped citations**, each citation the judge marked `supports: false`,
   with its reason; and the mode file's.
