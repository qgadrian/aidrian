# Product mode

A product owner interviews the end user, shapes options, grills them with UX and an engineer, walks the end user through
its recommendation, and recommends one option. The Human approves it, unless a run the route started continues provisionally.
Read this file once the mode is `product`. Here `<plan>` is the question file.

The end user is a persona: a simulated user from a doc. Its answers are hypotheses, never evidence about real users, and
the report names what only a real user could confirm. The ruling stands only on the Human's answer, or provisionally where
the route in `knowledge/references/decisions.md` lets work continue, and it never becomes a product rule until the Human
keeps it and the project's docs say so. Start this mode when the Human asks for it, or when the route says `quorum`.

- [Roles](#roles), [Files](#files), [Rounds](#rounds), [Asking the Human](#asking-the-human), and [Report](#report).
- Briefs: [Trace](#trace), [Prepare](#prepare), [Interview](#interview), [Shape](#shape), [Grill](#grill),
  [Draft](#draft), [Walkthrough](#walkthrough), and [Ruling](#ruling). Paste the Evidence block of
  `references/briefs.md` where a brief says `<evidence>`.

## Roles

`aidrian quorum roles product` prints this run's roles and cap. The values below are the defaults.

- **Tracer**: `code-reviewer`, the current behavior, from the code and docs. It needs a shell to search, which `explorer` may lack.
- **Product owner**: `product-manager`. A fresh run for each brief, each given what that brief names.
- **End user**: `ux-researcher`, as a persona. Its brief loads no product rule, though a project's `always` docs still reach it.
- **Grillers**: `ux-specialist` and, as the engineer, `architect`.

The cap is 10 dispatches with no loop: the trace, the prepare, the interview, the shape, two grills, the draft, the
walkthrough, the ruling, and one retry. Each of `maxLoops` loops, 2 by default, adds up to 6. `roles` prints both. Every role runs on the host's model, so `same_model` is `true`, and its reason says so. A resume of an agent counts as a dispatch.

An agent's answer returns only to a parent still running. A coordinator that is itself a subagent, such as `orchestrator`, never ends its turn to wait: it stays running with a shell wait, such as 30 seconds at a time, until each answer arrives.

A missing trace, prepare, shape, or draft stops the run with `blocked`. A missing interview or walkthrough answer leaves
that field empty, and a missing grill raises no points; the report names each.

## Files

The input is the Human's text, or a question file of an earlier product run. With no keyword, a file under
`<state>/quorum/product/` selects this mode.
The question file is `<state>/quorum/product/questions/<slug>-<h7>.md`. `<h7>` is the first 7 characters of its
`git hash-object`. `<slug>` comes from its first line without the `# `: lowercase it; drop backticks, `*`, and `_`; turn
each run of other characters outside a-z and 0-9 into one `-`; leave none at either end; cut it to 60 characters, with
no `-` left at the end; use `question` when nothing is left. The ledger is
`<state>/quorum/product/<name>-<plan-hash>.json`, so the two modes never reuse each other's. The core's rule to write
the question file before round 1 does not apply: round 4 writes it.
A `plan` citation anchors on a heading of the question file. Its first line is `# <the question>`. It has `## Context`, the
Human's text word for word, and `## Options`, with one `### A: <label>` per option, holding its description and a
`Rule changed:` line. Never overwrite it.

When the core finds no reusable ledger for an input question file:

- A complete ledger whose check exited 1: say the recommendation went stale, quoting the lines printed, and start at round 1
  with only its `## Context` as the Human's text.
- An open ledger: say the earlier run did not finish, and do the same.
- No ledger at this hash: say the file has no run at its current content, read the whole file as the Human's text, and start at round 1.

A complete ledger the core reuses with `provisional` set and `human_answer` `null` asks nothing while the route lets work continue:
it resumes the continue path of `knowledge/references/decisions.md` at the first step not yet done,
and never reruns the writer when `provisional` already holds this marker.
When the route waits, that file's § After a ruling applies.
Any other complete ledger the core reuses with `human_answer` `null` asks the one question before reporting, writes the
answer (`null` again when deferred), and runs `quorum check`.

## Filling a brief

When the project is not the working directory, a brief's first line is `Project root: <path>`.
An input over 2 KB, such as the trace or the cases, may be the path of its exact copy in `<state>`, never a summary.
`against` and `winner` always name a position's id, `A` to `C`.
The product owner has no shell: for the Evidence block's `route` and `search`, it reads `.aidrian/knowledge/*.json`.
`<the decision's domain>` is the one the route named when it started this run; otherwise `product`, or `ux` for how the product looks and reads.
`<the starting route's class, answers, and docs, or none>` is what the coordinator sent the route; on a run the Human started, `none`.

## Rounds

1. **Trace.** The tracer, with the Trace brief.
2. **Prepare.** The product owner, with the Prepare brief. With `open: false`, the written rules settle the question, or
   it is not a product decision: write the answer to a file, and run `aidrian quorum premise <file>`. Exit 0: stop before any
   ledger, and report the answer with its citations. Exit 1: send it back once, on the retry; still 1, stop with `blocked`.
3. **Interview.** Pick the end user: each row of `aidrian-knowledge index` whose tags hold `personas`, inside the repository, other than `product-access` and any
   with an `aidrian lint personas` problem, is a candidate, and the one the decision changes most is the pick. It answers the
   product owner's questions. With no candidate, skip this round and round 7, on every pass: `witness` is `null`, and the report warns that no end user took part. Never invent one.
4. **Shape.** The product owner, with the Shape brief, proposes 2 or 3 options, each with its case. Fewer than 2: stop before
   any ledger, and report that there is no choice to make. Write the question file as § Files says, and show the Human the
   path. It never changes from here: a later change is a condition on the ruling.
5. **Open the ledger.** Write every field `references/ledger.md` § Product-mode fields lists, `status: open`, and run
   `quorum check`. `trigger` is `the Human asked`, or, on a run the route started, `the route, with resolve's <authority>`.
   `persona_docs` lists every such row, other than `product-access`, from the repository root, whether or not it lints clean.
   A `premise: invalid` line goes back to the product owner once, on
   the retry; still invalid, stop with `blocked`. A retry that answers `open: false` follows round 2's exit.
6. **Grill.** The two grillers in parallel, each without the other's answer. Number UX's points `U1` to `U5` and the
   engineer's `E1` to `E5`, `by: U` or `E`, `status: pending`. Run `quorum check`.
7. **Draft and walk through.** The product owner, with the Draft brief; write `draft`. Then the end user, with the Walkthrough
   brief; write `witness.walkthrough`. Run `quorum check`.
8. **Ruling.** With no dispatch left for it, write the coordinator's escalate below, with the premise's citations, and ask.
   Otherwise the product owner, with the Ruling brief. It may keep the draft, change the winner, add conditions, or return `loop`.
   Write `ruling`, with its `class`, `reversible`, `docs`, `domain`, `severity`, and `reverts_by`, and `outcome`, and run `quorum check`.
   One the check names invalid, or a missing one, goes back once, on the retry.
   Missing again, or with the retry spent, stop with `blocked`, unless a loop was spent: then write the escalate. Invalid again, or with the retry spent, write
   `{decision: escalate, winner: null, change_or_reason: <the line it printed, then the last decision and winner>, citations: <the premise's citations, since an invalid ruling's may not pass>, tested: [], inferences: []}`
   and `outcome: null`, and run `quorum check`.
   **Loop.** The Ruling can return `loop` while loops remain. Add it to `loops`, then:
   - `interview`: ask the end user the new question; add the answer to `witness.interview`, up to its limit; then round 7. With no witness, a `loop` of `interview` counts as a missing ruling.
   - `grill`: round 6 with the reason, new points taking the next free ids, and with none free the griller's first ones stand; then round 7.
   - `shape`: no option survives. The Shape brief with the reason;
     a new question file and ledger, carrying `trace`, `premise`, `witness`, `loops`, and `trigger`; then round 6.
   Then rule again. With no loop left, rule on what exists, and put what stays open in `outcome.flips_if`, or escalate.
9. **Ask the Human.** First write `status: complete` with `human_answer: null`, and run `quorum check`, so a session that
   ends here leaves a deferred ledger.
   **Resolve.** Run `aidrian decisions resolve` as `knowledge/references/decisions.md` says, in the ruling's own domain,
   with the Ruling's `class`, `reversible`, and `docs`. A missing field, or a command that fails, means `ask`.
   **Route.** Run the route on the ledger, as that file's § After a ruling says.
   A run whose starting route had `resolve.authority` `ask` waits, whatever the Ruling's answers resolve to.
   Only a run the route started, with `quorum.product.autoStart` on, `approval: "review-later"`, and `resolve`'s `decide`, can let work continue.
   The route and the writer read `trigger`, and only `the route, with resolve's decide` continues:
   then follow its continue path, ask nothing, and report.
   **Ask.** Otherwise ask, write `human_answer`, and run `quorum check`. A run that waits always asks, under `ask` and `decide` alike:
   `decide` settles nothing here,
   no `authority` line goes back to the product owner, and no `decided_provisional` or marker follows.

## Asking the Human

A run the Human started, or one whose route waits, asks one question, on a rule and on an escalation alike.
Each position is an option named by its label, with its citations in the description, and the recommended one first
with the one reason that decides it; on an escalation with no leaning, say that no option is recommended.
Say which written rule would change, from the option's `Rule changed:` line, what the end user said, marked as simulated,
and each fact that would flip the ruling and how to settle it.
Report `resolve`'s `authority` and `reason` beside the question, or `ask` and why it did not answer.
The answer goes into `human_answer`, word for word. Deferred, it stays `null`, the report's Open questions carries the
question, and nothing is decided.

## Report

After the core's Ledger item, which also names each role's agent and the question file:

1. **Premise**: what the trace found, and why the decision is open.
2. **End user (simulated)**: the interview's main answers, the walkthrough, and what only a real user could confirm.
3. **Recommendation**: the winner, or `escalated`; whether it moved from the draft; its conditions;
   and the Human's answer, `provisional` with its marker, or `deferred`.
4. **What would flip it**: each fact and how to settle it.
5. **Disputes left**: each topic and its owner.
6. **Options**: each label, its case, and each backed point against it.
7. **Next**: on an approved option, the written rule to change, from its `Rule changed:` line, and the skill that writes it,
   `knowledge-update` or `adr-writer`. On a deferred one, `quorum product <question file>` asks again while its citations hold, and otherwise reruns.
   On a provisional one, the same line resumes that continue path while the route lets work continue, and otherwise follows § After a ruling.

## Trace

```text
Role: tracer in a product decision. Report what the product does today on this question, and where its rules say so.
Question: <the Human's text>.
Trace the code as well as the docs: what decides the behavior, and whether its parts agree. Cite each statement with a file and line or a doc section. Say what you could not find. Propose nothing. Change no file.
```

## Prepare

```text
Role: product owner preparing to interview an end user. The trace: <the tracer's answer>. Question: <the Human's text>.
First: is this decision open? Answer open: false when the written rules settle it, or it is not a product decision.
A premise the question states may be wrong: test it against the trace.
When open, write at most 3 questions for the end user about what they do, need, and fear today, in their words.
Describe a concrete situation and ask what they would do and fear in it: a persona holds no past events to recall. Propose no solution, and name no product rule.
Cite with `doc`, `adr`, `code`, or `absence`: no question file exists yet.
<evidence>
Return one JSON object, in the handoff's artifacts: {"open", "premise": {"summary", "citations"}, "questions": ["<question>"]}.
Change no file.
```

## Interview

```text
Role: <persona id>, as its doc describes. Persona doc: <path>. Load no other knowledge.
A product owner asks: <each question>.
Answer each as this person. Say when the doc does not tell you, and never guess a fact about real users.
Return one JSON object, in the handoff's artifacts: {"answers": [{"question", "answer"}]}. Change no file.
```

## Shape

```text
Role: product owner shaping a decision. The trace: <the tracer's answer>. Question: <the Human's text>.
The end user's interview, simulated: <each question and answer, or none>.
<On a loop: why the earlier options failed: the reason.> The docs not settling the point does not block you here: the Human approves.
Propose 2 or 3 options that differ in what a user gets, and the strongest case for each, in at most 200 words, from the
product's docs, decision records, code, and data committed to the repository. A persona's answer is not evidence.
Put the written rule each would change in "rule_changed", or "none". A fact you cannot cite goes on an `inference:` line.
<evidence>
Return one JSON object, in the handoff's artifacts:
{"options": [{"label", "description", "rule_changed", "case": {"claim", "citations": [{"kind", "ref", "quote"}]}}]}.
Change no file.
```

## Grill

```text
Role: <UX specialist | engineer> grilling a product decision. Argue for no option. <On a loop: what to look at: the reason.>
Question: <plan>. The trace: <`trace`>. The cases, word for word: <id, label, claim, and citations, per position>.
The end user's interview, simulated: <each, or none>.
Return at most 5 points, each naming in "against" the option it attacks: UX, where a user would fail, get confused, or
lose time; engineer, what it would really cost, break, or make hard to undo. Show where a case does not hold.
<evidence>
Return one JSON object, in the handoff's artifacts: {"cross": [{"against", "claim", "citations": [{"kind", "ref", "quote"}]}]}.
Change no file.
```

## Draft

```text
Role: product owner drafting a recommendation, for the end user to try. Question: <plan>.
The cases and the grillers' points: <each>. The end user's interview, simulated: <each, or none>.
The docs not settling the point does not block you here: the Human approves.
Pick one option, and describe it as what this person would meet, in their words, with no product rule.
Return one JSON object, in the handoff's artifacts: {"winner", "reason", "walkthrough": "<the description>"}. Change no file.
```

## Walkthrough

```text
Role: <persona id>, as its doc describes. Persona doc: <path>. Load no other knowledge.
You told a product owner: <each interview answer>. It now proposes: <the draft's walkthrough>.
Walk through your real tasks with it. Say what you would do, where you would get stuck, and what you would ask for.
Say when the doc does not tell you, and never guess a fact about real users.
Return one JSON object, in the handoff's artifacts: {"walkthrough": "<your answer>"}. Change no file.
```

## Ruling

```text
Role: product owner recommending one option to the Human. Never split the difference, and never merge options.
The docs not settling the point does not block you here: recommend on the evidence and the product's stated goals, and the Human approves.
Question: <plan>. Ledger: <ledger>. The trace: <`trace`>. Your draft: <`draft`>.
This run may give a ruling no second chance. Open every file a case or point cites: a quote that exists may still not support the claim.
To rule on: <each case and each backed point, with its id and citations>.
Cases with no passing citation: <each `case X: no citation passes` line, or none>. Such a position cannot win.
The end user's interview and walkthrough, hypotheses only: <each, or none>. They may change your draft or add a condition, with your reason; no ruling may rest on them alone.
Decisions:
- rule: name the winner. In change_or_reason, name the losing case's strongest cited claim and the citation that
  defeats it. A rule rests on at least one citation of the winner's case that supports it, other than a persona doc.
- escalate: only when no option can be recommended, as when a missing fact decides everything. Give every position,
  your leaning if you have one, and what would settle it.
Verdicts: `tested`, one entry per citation of each entry you rule on, each index once, from 0:
{"of": the position or point id, "citation", "supports": true|false, "reason"}.
`inferences`, one entry per `inference:` line: {"statement", "holds": true|false, "reason", "citations"}.
On a rule, also return `outcome`: "conditions", changes the winner needs, each a sentence; "flips_if":
[{"fact", "how_to_settle", "settles_from_repo", "could_harden_undo"}],
each unknown that would change the winner, with what only a real user could confirm,
`settles_from_repo` true when reading the repository could settle it, and `could_harden_undo` true when it could make the decision harder to undo;
a value you cannot answer is true; "disputes": [{"topic", "owner"}], smaller disagreements and who settles each.
<evidence>
Return one JSON object, in the handoff's artifacts:
{"decision": "rule|escalate", "winner", "change_or_reason", "citations": [{"kind", "ref", "quote"}], "tested": [...], "inferences":
[...], "outcome", "class", "reversible", "docs", "domain", "severity", "reverts_by"}.
`class`, `reversible`, and `docs` are as `knowledge/references/decisions.md` defines them, for this decision:
`reversible` is one comma-separated string or a list of the four words, `no` or `yes`, in that file's order.
The starting route asked on: <the starting route's class, answers, and docs, or none>. A `yes` among those answers stands.
`domain` is <the decision's domain>. `severity` is the harm if it is wrong. `reverts_by` is how to undo it.
Any of these missing means the decision waits for the Human.
With loops left (<loops left>) and a problem only another pass could settle, return instead {"loop": {"back_to": "<interview|shape|grill, leaving out interview with no end user>", "reason"}}. Never loop for polish.
Change no file.
```
