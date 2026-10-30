---
name: knowledge-update
description: Add or refresh the project's knowledge docs from its code, docs, pull requests, and history.
---

# knowledge-update

Before you start, follow the `knowledge` skill. Knowledge tags: `docs`, `harness_engineering`.

Turn evidence into the project's knowledge docs, the docs its buckets index in `.aidrian/knowledge/`.
Researchers gather the evidence and change nothing; you propose the edits, the user approves them,
then you write the docs and their index entries.

## Pick the mode

| Mode | Use when | Input | Read |
| --- | --- | --- | --- |
| `generate` | No doc covers the topic, or only a stub does | a topic | `steps/generate.md` |
| `refresh` | Docs exist, and recent work may have made them stale | a time window such as `7d`; optionally a tag or topic | `steps/refresh.md` |
| `extend` | One resource holds knowledge an existing doc lacks | a pull request, issue, commit, tracker key, or doc path | `steps/extend.md` |

When the request does not name a mode, pick it from the table.
A topic that already has a real doc is never `generate`. Ask only when two modes fit equally.

## Steps

1. **Anchor.** Check that `git rev-parse --show-toplevel` is the checkout you mean to change.
   Take today from `date -u +%Y-%m-%d`, and use it for every date in this run.
2. **See what exists.** Use `aidrian-knowledge search <words>`, `aidrian-knowledge route <tag>`, and `aidrian-knowledge index`.
   Read the project's `docs` knowledge for which doc trees you may write and which are read-only.
3. **Follow the mode's file** for scope and research. Read `references/evidence.md` before you dispatch a researcher:
   it lists the sources, when a missing source stops the run, and the evidence packet you build per doc.
4. **Propose, then wait.** For each doc show its path; its mode (`create`, `update_section`, or `append`); its sections;
   two or three load-bearing findings per source, with links; for a new doc, its bucket, summary, and tags;
   and every contradiction between sources, for the user to settle.
   Offer three choices: write as shown, change something, or cancel. Write nothing before the user approves.
5. **Write** each approved doc:
   - Rules and behavior in plain prose. No line numbers, commit hashes, or branch names: they go stale.
   - A `## Sources` section with the evidence links. On an update, keep every link already there and add the new ones.
   - A new doc gets its entry in its bucket's index: a summary of at most 160 characters that names its topics,
     and the narrowest tags from the `knowledge` skill's list.
     Add a doc to `always` only when the user asks: every `always` doc costs context in every session.
6. **Check.** Run `aidrian check`, and `aidrian lint budget` when `always` changed. Fix what they report.
   Never raise a limit to make a check pass.
7. **Report:** the docs written, with their modes; the docs skipped, with why; key evidence per source, with links;
   each contradiction and how the user settled it; the sources that were skipped or down; the `aidrian check` line;
   the extra items the mode's file lists; and a Conventional Commits message for the change.
   Do not commit: the user does.

## Rules

- **Research changes nothing.** No comments, posts, labels, or edits in GitHub, the tracker, or any other system.
- **Links, never `#N`.** Cite a pull request or issue by its full URL or its title. A bare number means nothing outside its tracker.
- **The rule, not the case.** From an incident or a support conversation, write the rule that was broken, not the one-off fix.
- **Fail loudly.** A source that is down or finds nothing is a line in the report, never silence or padding.
- **Read-only stays read-only.** Never write a doc the project's `docs` knowledge marks read-only or authoritative,
  nor a decision record. Name the change for its owner in the report instead.
- **Product truth is decided, not inferred.** When the evidence shows a product rule no doc states, propose it for
  `product-manager` or the user to confirm; never write it as fact on your own.
