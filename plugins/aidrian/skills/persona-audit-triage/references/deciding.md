# Deciding an item

Read before the first question of step 5: how to search for duplicates, re-rank, take a product decision, close a
finding as documented, and adopt a recommendation the Human delegates.

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
aidrian audits rank <report> <id> urgent|high|medium|low --by <role or human> [--reason '<why>']
```

`pending` then shows the priority beside the finding and lists it first in its group. Pass it to `agent-issue-writer`
as the issue's priority.

## A product decision before an issue

When a finding needs a product decision before an issue can be written, record the decision as it is taken:

```bash
aidrian audits record <report> <id> decided --reason '<the decision>' --by <who decided>
```

`decided` is not final: the finding stays untriaged, and `pending` shows the decision beside it, until it reaches a
final outcome, usually `issue`, with the decision in the issue's body.

## Works as documented

When the product does what a doc says it should, record `documented`, not `drop`, with the doc's file and section:

```bash
aidrian audits record <report> <id> documented --doc '<path#section>' --reason '<what the doc says>'
```

The path is relative to the project root, and the command refuses one that names no file.

## A delegated answer

When the Human answers "your recommendation", "go with what you suggest", or the like, adopt the pick of the agent
that owns the finding, such as `product-manager` for a product rule, and record it with `--by <that role>`; a pick
the Human made is `--by human`. The summary names whose pick each decision was.
