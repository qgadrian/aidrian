# Decisions: who settles one

`knowledge/references/decisions.md` is the one rule for a decision the project's docs do not settle.
Read it when you return such a decision, dispatch or relay an agent that does, or write its marker.
Every agent and skill that handles one points here and restates none of it.

## Who does what

- **The deciding agent**, such as `product-manager` or `architect`, supplies the decision's `class`, its four `reversible` answers,
  and `docs`, each written rule the decision touches.
  `aidrian decisions resolve --vocab` defines the classes and the questions, the project's own classes among them.
  With no shell, read `../../../lib/decisions.json` from this file, and config.json `decisions.classes` for the project's.
- **The dispatcher with a shell** runs the command and passes `authority: decide` or `authority: ask` in the specialist's brief.

  ```bash
  aidrian decisions resolve --domain <domain> --class <class> --reversible <no|yes>,<no|yes>,<no|yes>,<no|yes> [--doc <path>]...
  ```

  `--reversible` answers the questions in the order `--vocab` gives. `--doc` is required whenever a decision touches a written rule, once per doc.
  `--domain` follows the owner: `product` for `product-manager`, `backlog` for `product-manager` on the order of work, `architecture` for `architect`, and `ux` for `ux-specialist` or `designer`.
  A class `--vocab` gives a `domain` is always in that domain, whoever raises it: the command judges it there, and its marker names that domain.
- **The specialist never computes authority itself.** A brief with no `authority` line means `ask`.
- **The fourth question.** The deciding agent answers it literally, whatever the team has opted in to, and the command applies the team's acceptance.
  Where a team has both `decide-reversible` and auto-merge allowed, at the base branch, a change may reach users
  with no person looking at it; those two opt-ins are the acceptance, so a yes on that question does not ask, and the `reason` it prints says so.
  Floor classes, the escalate lists, and the other three questions still ask.

## The order

1. The specialist, with no `authority` line, returns `decision_options` with the class, answers, and docs.
2. The dispatcher runs the command on them. A missing class, answer, or `docs` field, or a command that fails, means `ask`; `docs: []` states it touches none.
3. Under `ask`, relay the options to the Human, attributed. Under `decide`, send them back to the same specialist with `authority: decide`;
   when the host cannot reach it, dispatch a fresh one with `authority: decide` and the options.
4. The specialist returns `decided_provisional`. When its class, answers, or docs differ from what was resolved, run the command again on what it returned.
   `ask` wins: send it back for `decision_options`.
5. Take the second look below, then go on, and list each `decided_provisional` in the report, attributed.
6. Give its writer the decision, its domain, and the doc that governs it, as [Record it](#record-it) says, so it goes on record in the same branch.

A dispatcher that already holds the class, answers, and docs may resolve first, and send `authority` in the first brief.
`authority` covers the one decision its brief names. Another decision the specialist meets starts again at step 1.
In the `product` and `ux` domains, [Hard product calls](#hard-product-calls) changes step 2.

## Under ask

Return `decision_options` with an advisory recommendation. The Human chooses.

## Under decide

Return `decided_provisional`, with status `done`: the recommendation is the decision. `handoff.md` lists its fields.
It settles this change only, and becomes product truth only once the Human keeps it, with `aidrian decisions set <id> confirmed`.

## Record it

Every `decided_provisional` goes on record, so every machine and session can see it: one line in the indexed knowledge doc that governs it, committed.
It is an HTML comment, so a reader of the rendered doc never sees it. It goes directly below the rule's last line, the one place undo looks for that rule.
A rule ending in a code block takes its marker directly below the closing fence.
A table row's marker goes directly below the table, with the row as its wording. Under a bullet, the marker is indented to the bullet's text.
A later decision on the same rule goes directly below the earlier one's lines, oldest nearest the rule.
A marker elsewhere still counts, and `aidrian decisions list` reports it.

```md
<!-- aidrian:decision id=<slug> status=unconfirmed class=<class> domain=<domain> date=YYYY-MM-DD pr=<n> -->
```

- `id`: lowercase letters, digits, and `-`, at most 32 characters, unique across the docs.
- `pr`: `none` until the pull request exists. A writer on a branch whose pull request already exists writes the real number.
  The `pr-write` skill has `doc-updater` write the number on each marker the branch added with `none`, commit, and push.
  That push moves the head, so it comes before the review of the new head, or the report says it did not.
  `aidrian decisions list --added-since <ref>` flags any `pr=none` left once a pull request exists.
- **The writer.** The slice's implementer, in its commit; else `doc-updater`.
  `product-manager` and `architect` decide; neither writes. When no indexed doc covers the area, `harness-librarian` adds one.
- **Old wording is required.** A decision that replaces a written rule keeps the old wording, in lines directly below its marker, so undo can restore it.
  A decision that fills a gap has no such line.
- **New wording is required.** Every decision records the lines it wrote, in lines directly below the old wording,
  exactly as in the doc, indentation and any fence lines included. Undo finds exactly that text.
  The wording must sit in one block, with no blank line outside a fence and no heading inside it; a rule spanning blocks takes one decision per block:

  ```md
  <!-- aidrian:decision-old id=<slug> text="<the old wording, as a JSON string>" -->
  <!-- aidrian:decision-new id=<slug> text="<the wording it wrote, as a JSON string>" -->
  ```

  `text` writes a line break as `\n`, a quote as `\"`, and `-->` as `-\u002d>`.
  Wording may span several such lines, one piece each; they join with nothing between them. The line-length check skips these lines and the marker.
- **Only the Human settles one.** The main session runs `aidrian decisions set <id> confirmed|changed|rejected` or `aidrian decisions undo <id>`,
  on the Human's word. A hook refuses a subagent.
  `set` rewrites that one marker; `undo` puts the old wording back and removes the decision's lines, or refuses and writes nothing.
  Run either in a worktree and commit the change; with the main-checkout guard on, each refuses the main checkout.
  Nothing settles a decision by time. `aidrian decisions list` prints each one, and each marker it cannot read; `aidrian check` warns about those.
  The `decision-review` skill goes through them with the Human, in a batch.
- **The pull request.** The `pr-write` skill lists the branch's decisions in the body.

## Never self-approved

A critical-flow sign-off or a security verdict is never self-approved, in any mode, and no `authority` covers one.
Such a gate stops as its skill says, with no command to run: its class always asks.

## Second look

`aidrian decisions resolve` prints `secondLook` from the base branch's config: an agent and a `minSeverity`, or `null`, which turns it off.
Read it from that output, never from the working copy.
When the decision's `severity` is at or above `minSeverity`, send the `decided_provisional` to the named agent before going on, and ask it for `sign_off`.
A missing or unknown `severity` counts as at or above `minSeverity`.
`approved` is agreement. Anything else escalates: the decision goes to the Human as under `ask`, with both positions.

## Hard product calls

A team may let a session start the `quorum` skill's product mode on a hard call,
with `quorum.product.autoStart`, `approval`, and `maxAutoRuns` at the base branch.
The route reads them, so a branch cannot raise them. With `autoStart` off it prints `as-today`, and nothing else changes.
A run the Human starts always asks; only a run the route started continues provisionally.

### The five answers

`product-manager`, `designer`, and `ux-specialist` return `hardness` with every `product` or `ux` decision,
each key `yes` or `no`, from the decision in front of them:

1. `open_options`: are two or more options that differ in what a user gets each still viable after reading the project's docs?
2. `no_written_answer`: does no doc, decision record, or committed data favour one option, so that the pick rests on an inference?
3. `conflict`: do two written rules disagree, or the docs and the code on this behaviour?
4. `disagreement`: did a specialist, a reviewer, or `secondLook` object to the pick with a citation?
5. `reach`: does it change a step of a flow a persona doc describes, rather than only copy, layout, ordering, a default value, or naming?

All five `no` is small and clear. Any `yes`, or a missing answer, makes the call hard.
Read the first two together: wording with one obvious option stays small.
These are facts a reviewer can check against the cited docs, not a confidence score.
A `backlog` decision carries no answers and never routes.
Neither does any domain other than `product` and `ux`: [The order](#the-order) applies as written.

### The route

`aidrian quorum route` takes the place of `aidrian decisions resolve` at step 2 of the order, and a dispatcher that resolved first routes at step 4.
A dispatcher holding a `decided_provisional` from any of those agents routes it before anyone commits it.

```bash
aidrian quorum route --domain <domain> --class <class> --reversible <no|yes>,<no|yes>,<no|yes>,<no|yes> --hard <a,b,c,d,e> [--doc <path>]... [--runs <n>]
```

`--hard` takes the five answers in the order above.
`--runs` is this session's automatic quorum runs so far: the coordinator counts them, and a handoff brief carries the count.
It prints one JSON line, `{ route, wait, reason, resolve }`.
`resolve` is what `aidrian decisions resolve` prints, so `authority` and `secondLook` come from there.
It logs `resolve`'s dispatch row, sharing its key, so no separate `resolve` runs for the log.
Exit 3, or any other non-zero exit, waits for the Human.

| `route` | What happens |
| --- | --- |
| `as-today` | `resolve`'s answer stands, whatever the five answers say: step 3 of the order, by its `authority`, and `unattended` as ever. |
| `agent` | A small, clear call the agent decides: step 3 under `decide`. |
| `human` | Step 3 under `ask`, with no quorum. This is the small, clear call under `ask`, or a hard call at `maxAutoRuns`, which waits. |
| `quorum` | Run the `quorum` skill's product mode on the decision, with `product` or `ux` as its domain, then [After a ruling](#after-a-ruling). |

With `autoStart` off, `as-today` keeps `unattended` as ever, on a hard call too: the five answers change nothing there.
With `autoStart` on, only the small, clear row follows `unattended`; every other route is the stricter path, so a hard call takes no `safe-default`.
Under `resolve`'s `ask` or `approval: "first"`, `wait` is true, and the quorum only recommends.

**Who runs a quorum.** The main session, or a subagent coordinator such as `orchestrator`.
A coordinator that is itself a subagent stays running while it waits, never ends its turn to wait,
and brings any question for the Human back in its handoff.
When it cannot stay running to the end of the run, it starts no quorum, and returns the decision and its answers for the main session to run.

### After a ruling

Run `aidrian quorum check <ledger> --plan <question>` before `route --ledger`, which checks no schema. A check that exits 1 waits.

```bash
aidrian quorum route --ledger <ledger> --domain <the ruling's domain>
```

It prints `{ route, wait, reason, resolve, settle, listed }`.
A class `--vocab` gives a `domain` resolves in that domain, whatever the ruling's own says:
`resolve` judges the class, and the route only holds the ruling to the domain named.

- On `human` for a ledger with `human_answer` set, act on `human_answer` rather than ask again.
- A `secondLook` disagreement or a `blocked` run waits for the Human.
- A run whose starting route had `resolve.authority` `ask` waits, whatever the Ruling's answers resolve to.
  Give the Ruling that route's class, answers, and docs, and write the authority in the ledger's `trigger`.
  `route --ledger`, the writer, and `quorum check` on a provisional ledger read it, and only `the route, with resolve's decide` continues:
  a run the Human started, or one whose route asked, prints `human` or waits, whatever the settings.
- **It waits**, on `wait` true with an empty `settle`. With the Human present, round 9 of the mode asks as usual.
  With the Human absent, the ledger stays deferred, the question goes in the report with the recommendation and the simulated-user caveat,
  and independent work continues.
  Dependent code keeps no guess at the answer.
- **It continues**, on `wait` false or a non-empty `settle`: the order below.
  Each fact in `listed` goes in the record for the batch review.

### The continue path

In this order. Each step that fails waits for the Human.

1. `aidrian quorum check <ledger> --plan <question>`.
2. `aidrian quorum route --ledger <ledger> --domain <domain>`.
   Then pick the indexed doc that governs the behaviour, for the marker, and send it through the plain form:
   `aidrian quorum route --domain <domain> --class <class> --reversible <answers> --doc <marker doc>`, with no `--runs`,
   since `--ledger` takes no `--doc` and no script catches a marker there.
   On `wait` true, a continued ruling whose marker doc `escalateDocs` covers waits. A floor class such as money waits the same way.
   When no indexed doc covers the area, `harness-librarian` adds one first, as [Record it](#record-it) says.
3. **Settle** each fact in `settle` with one read-only `explorer` dispatch, in all. A result that flips the winner, or settles nothing, waits.
   No ledger field records a settled fact, so `route` still lists it, with `wait` true, and the writer accepts that:
   the result, with its citation, goes in the report and the pull request's Decisions section, and the coordinator holds it for the session.
   Then, with or without a fact to settle, take the [second look](#second-look) on the ruling's `severity`;
   its answer goes in the ledger's `second_look`, as `{ agent, sign_off, reason }`.
4. **The writer**, `aidrian quorum provisional <ledger> --plan <question> --marker <id>`.
   It refuses until a second look the ruling's `severity` calls for holds `sign_off: approved`, an unknown severity included.
   It runs before the implementing commit, since afterwards it can refuse on a changed citation, its check having no exemption.
   It runs before the marker, since each committed marker counts toward the domain's pause and could turn the route to `human`.
   After it, `route --ledger` prints `human` until the marker exists in the working copy, so a resume in that window waits.
   A `human` whose reason names a settled marker means read the rule in its doc, not ask again.
5. **The marker**, in the slice's commit, by the writer [Record it](#record-it) names, and `outcome.conditions` join the task.
   Write it before changing anything a case cites: until it is on record, `quorum check` holds the ledger to its citations.
6. **The guard.** Before dependent work goes on, `aidrian decisions list --added-since <base>` must show the committed marker with no unmarked `problems`.
   Plain `list` reads the working copy, so it would pass an uncommitted one.
   An uncommitted marker, or a problem on it, makes the decision wait, so no continued ruling can miss the batch review.

**The record.** The ruling becomes a `decided_provisional`: `decision` is the winner, `options_considered` the positions,
`reason` its `change_or_reason`, `revisit_trigger` its `flips_if`, and the rest come from `ruling` by name.

- Every continued ruling gets a marker, even with `Rule changed: none`: that line means no existing rule changes, so the ruling fills a gap.
  The winner goes in as one line of wording in the indexed doc, with its marker and `decision-new` line.
- That line goes directly below a non-blank line of prose, never as a heading's or a doc's first line, with its text once in that block, so undo works.
- A ruling that is not lasting starts its wording with the change it covers, such as `Only for <the change>: <winner>`.
  Keep confirms the marker and leaves the line as a scoped record, not a standing rule, and a later run reads it as prior context for that change only.
- As `decisions.record.queue` says, the recommendation, what would flip it, any settled fact's result, and the note that winners have varied between runs
  go in the pull request's Decisions section or the report.
  No ledger path goes in a doc or a pull request body, since it means nothing on another machine: the report names it.
  `decision-review` reaches the ruling through the marker's `pr=<n>`.
- A later Human answer wins, and both stay on record.
