# Decisions: who settles one

`knowledge/references/decisions.md` is the one rule for a decision the project's docs do not settle.
Read it when you return such a decision, or dispatch or relay an agent that does.
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
  `--domain` follows the owner: `product` for `product-manager`, `architecture` for `architect`, `ux` for `ux-specialist` or `designer`, and `backlog` for the order of work.
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
