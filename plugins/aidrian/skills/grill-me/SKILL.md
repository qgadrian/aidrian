---
name: grill-me
description: Interview the user one question at a time to stress-test a plan or design against the project's docs and code. Use when asked to be grilled.
---

# grill-me

Interview the user relentlessly about every part of the plan until both of you share one understanding of it.
Walk down each branch of the design tree, and resolve the decisions a branch depends on before the branch itself.

Before you start, follow the `knowledge` skill. Knowledge tags: `product_sensitive`, `docs`.
Add the tags of each area the plan touches, such as `backend` or `testing`, when you reach it.

## Each question

Ask one question at a time, and wait for the answer before the next one.
Before you ask, look for the answer, in this order:

1. Run `aidrian-knowledge search <topic words>` and read the docs that fit.
   When a doc settles the question, cite its path and heading, state what it settles, and move on instead of asking.
   Without a project folder, search the repository's docs with `grep -rli <word>` instead.
2. When an accepted decision record already settles it, cite the record and do not reopen it.
3. When the code can prove it, read the code. Ask only where the code and the plan disagree, and name the file.
4. Otherwise ask, with your recommended answer and the one reason that decides it.

While you ask:

- When the user's word differs from the term the docs or the code use, name both and ask which one is meant.
  A term no doc defines is a finding: it needs a definition, or it is a loose synonym for an existing concept.
- Test each boundary with a concrete scenario: an edge case, a failure halfway through, two users at once.
- When the plan changes a flow the `product_sensitive` knowledge marks as critical, say so at once, citing the doc,
  and carry every gate that doc requires into the summary.

## Doc drift

When a doc is stale, or contradicts the code or a settled answer, record it as drift and keep grilling:
the doc and heading, what it says, what is true now, and who owns the fix.
This skill edits no doc; the drift list routes each fix to its owner.

## Close the session

The session is done when every branch is resolved, or parked as an open question with an owner.
Then write the summary:

1. **Decisions**: each resolved term, behavior, or boundary, with the doc or plan section it belongs in.
2. **Doc drift**: every entry recorded above.
3. **Decision records**: only decisions that are hard to reverse, surprising without context, and the result of a real trade-off.
   Give each a slug for the `adr-writer` skill, and name any earlier record it supersedes.
4. **Open questions**: each with who must answer it.
5. **Follow-ups**: one line per next action, in order, each with its owner: an agent, a skill, or the user.

Capture it before the session ends:

- About a plan file: add the decisions to its `## Approach` and the open questions to its `## Open questions`.
  The summary in the reply carries the rest.
- Otherwise: write the summary into a handoff brief with the `session-handoff` skill, so a fresh session can act on it.

Leave each follow-up to the user, or to the agent that ran this skill: they decide when to act on it.
