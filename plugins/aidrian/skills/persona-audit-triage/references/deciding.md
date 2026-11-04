# Deciding an item

Read before the first question of step 5, and § The tracker at step 3.

Sections: The tracker; How to ask; What follows a decision; A rule verdict; Search for an existing issue first; Priority;
A product decision before an issue; Works as documented; A delegated answer.

## The tracker

The tracker is the one the `agent-issue-writer` skill uses: the one the project's `issue_tracker` knowledge names. Never
guess it from a remote or a key. When that knowledge names none, the tracker is unresolved:

- In `confirm`, ask it as its own question before any finding, and stop for the answer. Never put it in a question
  about a finding, and never leave it for a later one. The reply is that question and why it is needed, nothing else:
  it names no finding, gives no counts, and proposes no decision on the items, such as deferring them all. It offers
  no tracker as a recommendation drawn from the remote.
- In `auto`, no issue can be filed: record each item `defer`, with that reason, and say so in the summary.

## How to ask

- A question holds one decision. Lead with it: a fact that changes no decision, such as a screenshot that will not
  open, gets one line at most. Offer only the item's `allowed_decisions`; `pending --json` prints them, and `record`
  refuses any other.
- A `held` item's question asks the Human for the product decision: what should happen, with a recommended answer and
  the reason, and the verdict in one plain line. Issue options come only after that decision.
- After the question, at most one line on what comes next, such as "Then seven more groups, one at a time".
  Never preview later groups or a leaning on them: each gets its recommendation when its turn comes.
- A line of an older report may name a task by its number, such as "Task 2", and `pending` marks it `numbered_task`.
  Say which task in plain words, from the report's task table; never write the number, and never change the stored line.

## What follows a decision

- A Not reached line is a follow-up for a rerun: an `issue` or `defer` to walk that task again once what stopped it,
  a width, a host, or an account, is solved.
- A doc gap goes to `harness-librarian` for a persona or product-access doc in the knowledge, else to `doc-updater`.
- A `needs_trace` finding's issue says the cause was not traced; a `likely_cause` goes in labelled as likely.

## A rule verdict

A persona finding reports what a person experienced. It never settles whether the product breaks a rule, even when it
cites one: that citation is a lead to check. So before a draft may call a change a conformance fix, or say "no new
product decision", a verdict from `product-manager`, or the project's product owner, must exist for that finding.

A finding needs one when its draft would state or imply what the rule is, or when it asks to change behaviour rather
than fix a defect the product itself reports as an error. A plain crash or a broken string needs none.

Ask only for the findings of the question coming next, not the whole report: the blocker before its question, the others
when their group comes up, one batch per group. Ask for one of three answers:

| Verdict | Means | What follows |
| --- | --- | --- |
| `breaks` | The product breaks the rule | A conformance fix: the draft may say so, citing the rule |
| `conforms` | The product follows the rule, so changing it is a product decision | The item is `held`: the Human decides before any draft says what to build; also a candidate for `documented` |
| `silent` | The docs do not settle it, also a product decision | The item is `held`: the Human decides before any draft says what to build |

The verdict quotes the rule with its doc's path and section. It follows any term the rule leaves undefined, such as
an amount, a limit, or a time span, into the docs that define it, decision records included. A paragraph that names a
term without its value settles nothing.

A verdict is evidence, not a decision: recording it changes no item's state, and needs no answer from the Human.
A `silent` says what was searched instead of quoting:

```bash
aidrian audits verdict <report> '<audit_key>' conforms --by product-manager --reason '"<the rule>" <path#section-slug>'
```

The command checks the cited section exists. On a held item it refuses `issue` and `fix-now` until the Human's product
decision is recorded, `decided --by human`, with the decision as the reason; that releases the hold. Here a delegated
"your recommendation" is the Human's decision: record it `--by human`, with the reason naming whose pick it adopts.
An agent's own `decided` releases nothing. In `auto`, record a held item `defer`, with the verdict as the reason.
The verdict stays in `triage.json` through later decisions.

## Search for an existing issue first

Before an item is recorded `issue` or `duplicate`, search the tracker, as the `knowledge` skill's
`references/tracker.md` says, open and in-progress issues first, in this order:

1. The finding's title words: two to five plain words that name the problem, never a pasted id or path.
2. The surface it touches: the screen, route, or command the finding's steps and evidence name.
3. The issues opened or updated since the audit's date, read by title.

`search_labels` and the item's `audit_key` are one more signal, never the only one: an issue filed by hand, without
the audit label, can already hold the work. An issue that covers several findings is a `duplicate` for each.

When an open or in-progress issue holds an approved decision that a triage decision would contradict, such as an
issue that settles a rule the other way, show the Human that conflict, with the issue and its decision, before any
draft is written. Draft nothing for that finding until the Human settles it.

## Priority

A reviewer, such as `product-manager`, may re-rank a finding: the audit's severity says what the persona hit, and
stays as the run wrote it; the triage priority says what to do first. Record it apart from the decision:

```bash
aidrian audits rank <report> '<audit_key>' urgent|high|medium|low --by <role or human> [--reason '<why>']
```

`pending` then shows the priority beside the finding and lists it first in its group. Pass it to `agent-issue-writer`
as the issue's priority.

## A product decision before an issue

When a finding needs a product decision before an issue can be written, record the decision as it is taken:

```bash
aidrian audits record <report> '<audit_key>' decided --reason '<the decision>' --by <who decided>
```

`decided` is not final: the finding stays untriaged, and `pending` shows the decision beside it, until it reaches a
final outcome, usually `issue`, with the decision in the issue's body.

## Works as documented

When the product does what a doc says it should, record `documented`, not `drop`, with the doc's file and section:

```bash
aidrian audits record <report> '<audit_key>' documented --doc '<path#section>' --reason '<what the doc says>'
```

The path is relative to the project root. The section is a heading of that doc, as it is written, such as
`docs/rules.md#Known gaps / Do not infer`, or as its slug; the command checks it against the doc's headings, keeps
the slug, and refuses a file or a section it cannot find.

## A delegated answer

When the Human answers "your recommendation", "go with what you suggest", or the like, adopt the pick of the agent
that owns the finding, such as `product-manager` for a product rule, and record it with `--by <that role>`; a pick
the Human made is `--by human`. The summary names whose pick each decision was.
