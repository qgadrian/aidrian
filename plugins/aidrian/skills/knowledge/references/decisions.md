# Decisions: who settles one

`knowledge/references/decisions.md` is the one rule for a decision the project's docs do not settle.
Read it when you return such a decision, or dispatch or relay an agent that does.
Every agent and skill that handles one points here and restates none of it.

## Who does what

- **The deciding agent**, such as `product-manager` or `architect`, supplies the decision's `class`, its four `reversible` answers,
  and `docs`, each written rule the decision touches.
  `aidrian decisions resolve --vocab` defines the classes and the questions. With no shell, read `../../../lib/decisions.json` from this file.
- **The dispatcher with a shell** runs the command and passes `authority: decide` or `authority: ask` in the specialist's brief.

  ```bash
  aidrian decisions resolve --domain <domain> --class <class> --reversible <no|yes>,<no|yes>,<no|yes>,<no|yes> [--doc <path>]...
  ```

  `--reversible` answers the questions in the order `--vocab` gives. `--doc` is required whenever a decision touches a written rule, once per doc.
  `--domain` follows the owner: `product` for `product-manager`, `architecture` for `architect`, `ux` for `ux-specialist` or `designer`, and `backlog` for the order of work.
- **The specialist never computes authority itself.** A brief with no `authority` line means `ask`.

## The order

1. The specialist, with no `authority` line, returns `decision_options` with the class, answers, and docs.
2. The dispatcher runs the command on them. A missing class, answer, or `docs` field, or a command that fails, means `ask`; `docs: []` states it touches none.
3. Under `ask`, relay the options to the Human, attributed. Under `decide`, send them back to the same specialist with `authority: decide`;
   when the host cannot reach it, dispatch a fresh one with `authority: decide` and the options.
4. The specialist returns `decided_provisional`. When its class, answers, or docs differ from what was resolved, run the command again on what it returned.
   `ask` wins: send it back for `decision_options`.
5. Take the second look below, then go on, and list each `decided_provisional` in the report, attributed.

A dispatcher that already holds the class, answers, and docs may resolve first, and send `authority` in the first brief.
`authority` covers the one decision its brief names. Another decision the specialist meets starts again at step 1.

## Under ask

Return `decision_options` with an advisory recommendation. The Human chooses.

## Under decide

Return `decided_provisional`, with status `done`: the recommendation is the decision. `handoff.md` lists its fields.
It settles this change only, and becomes product truth only once the Human keeps it and a doc records it.

## Never self-approved

A critical-flow sign-off or a security verdict is never self-approved, in any mode, and no `authority` covers one.
Such a gate stops as its skill says, with no command to run: its class always asks.

## Second look

`aidrian decisions resolve` prints `secondLook` from the base branch's config: an agent and a `minSeverity`, or `null`, which turns it off.
Read it from that output, never from the working copy.
When the decision's `severity` is at or above `minSeverity`, send the `decided_provisional` to the named agent before going on, and ask it for `sign_off`.
A missing or unknown `severity` counts as at or above `minSeverity`.
`approved` is agreement. Anything else escalates: the decision goes to the Human as under `ask`, with both positions.
