---
name: decision-review
description: Go through the decisions agents made alone with the Human, in one batch, and keep, undo, or change each.
disable-model-invocation: true
---

# decision-review

Before you start, follow the `knowledge` skill. Knowledge tags: `docs`.

The Human settles the decisions agents made alone.
Run this in the main session: a hook refuses `aidrian decisions set` and `undo` to a subagent.
Every answer changes a doc, so work in a task worktree (`aidrian worktree new <branch>`) unless the session is already in one.
This skill ends at a commit for the Human's review. It never merges.

## 1. Read

```bash
aidrian decisions list --json
```

First report each row of `problems` about a file no index lists: name the doc, and say to move the marker to an indexed doc, or index the doc.
Such a marker counts toward the domain pause, and this skill cannot reach it.
Report each row about a class no list holds the same way: that marker counts toward the domain pause, and `set` and `undo` cannot reach it,
so say to restore the class in config.json `decisions.classes`, or to correct the marker's class.
Relay each entry of `notes` too: it says which markers went unscanned, so an empty batch may not be the whole record.

The batch is every decision with `status` `unconfirmed`, oldest first. None: say so and stop.
Each has `id`, `class`, `domain`, `doc`, `line`, `date`, `pr`, `oldWording`, and `newWording`.
Read the rule around `line` in its doc, and the pull request at `pr` when one is set, so each decision can be told in plain words.
A row of `problems` on one of these markers goes with it: say what it means for that decision.

## 2. Ask

Ask about the whole batch at once, one question per decision.
When the host's question tool caps a call, send the next group after the answers.
Each question stands alone, in the Human's terms, with no marker id or class name:

- what the rule says now, and what it said before, or that it filled a gap;
- what the agent chose, and what that does for a user or a contributor;
- the options **Keep**, **Undo**, and **Change**. Keep comes first, with one reason, unless a problem says the rule has moved.

Take no answer from a reply that did not name that decision. A decision left unanswered stays `unconfirmed`, and goes in the report.

## 3. Apply

- **Keep.** `aidrian decisions set <id> confirmed`.
- **Undo.** On the Human's word, `aidrian decisions undo <id>`. It puts the old wording back and removes the decision's lines;
  when the decision filled a gap, it removes the wording.
  Then draft a revert task for the behaviour, in the report: what the pull request at `pr` changed to match the rule, and what to take back.
  The doc change alone reverts no behaviour.
  When several undo on one rule, go from the lowest marker up: the command refuses any other order.
- **Undo refused.** The command exits 1 and writes nothing.
  Show the Human its reason and both wordings as printed, and hand the edit to the Human or `doc-updater`.
  Never edit the rule here, and never run `set rejected` to stand in for the undo.
- **Change.** It applies to the bottom marker of a stack.
  To change an earlier decision, the Human answers about the bottom one, or undoes down to the earlier one first.
  Dispatch `doc-updater` with the doc, the `id`, and the Human's wording.
  It writes that wording as the rule, and in the marker's `decision-new` line, as the rule's lines exactly; the `decision-old` lines stay.
  When it returns, run `aidrian decisions list` while the marker is still `unconfirmed`, and send any drift on that `id` back to `doc-updater`.
  Only then, in this session, run `aidrian decisions set <id> confirmed`.

Then read it again:

```bash
aidrian decisions list
aidrian check
```

A problem on a marker this batch touched goes back to its step, or in the report.
`set` on a decision already answered prints `already confirmed`, which is no failure.

## 4. Commit and report

Commit the changed docs in the task worktree, with a Conventional Commit subject such as `docs(decisions): review <n> decisions`,
and leave the commit there.
Open no pull request and merge nothing unless the Human asks.

Report to the Human, in plain words, grouped: kept, undone, changed, refused with the reason, and unanswered, each naming the rule.
End with each revert task drafted, and the branch that holds the commit.
