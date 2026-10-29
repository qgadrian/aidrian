---
name: skill-writer
description: Create, update, audit, or retire a skill so it triggers predictably, stays lean, and cites only verified facts. Use to write or revise a SKILL.md.
---

# skill-writer

A skill exists to wring a predictable process out of a stochastic model.
**Predictability**, the agent taking the same path on every run rather than producing the same output, is the root virtue.
Every phase below is a lever on it.

Before you start, follow the `knowledge` skill. Knowledge tags: `harness_engineering`, `docs`.

The craft vocabulary (leading word, completion criterion, and the failure modes) is in [references/glossary.md](references/glossary.md).
Read it in full on your first run in a session; after that, read it when a phase names a term you cannot define precisely.

## Where skills live, and their limits

- This plugin's own skills: `plugins/aidrian/skills/<name>/SKILL.md`, in the plugin's repository.
- A project's skills: the folder its `harness_engineering` knowledge names, else `.claude/skills/<name>/SKILL.md`.
  When that knowledge names a generator or a mirror for another host, run it after every edit.
- `SKILL.md` stays at or under 7,500 bytes (`wc -c`): Codex cuts it at 8,000 bytes without a warning.
  Detail that only some runs need moves into `references/` or `steps/` files beside it.
- The `description` is one line of at most 160 characters (config.json `skills.descriptionChars`),
  and all skill names and descriptions together fit in `skills.listingBytes`: both hosts list them in every session.

## Branches

- **Create** a skill: Phases 1 to 7 in order.
- **Update** a skill's behavior: Phase 1 to re-scope, then 2 to 7.
- **Audit** with no behavior change: Phase 6 first, Phase 4 for each citation the sweep touched, then 5 and 7 if the file changed.
- **Retire or rename** a skill: § Retire or rename.

## Phase 1: Scope

1. List the neighbors: every skill in this plugin and in the project. Read the description of each one that could overlap.
   Run `aidrian-knowledge search <words>` for a doc that already owns the behavior.
2. Choose: **extend** an existing skill (the default when trigger and audience are shared),
   **create** one (only for a distinct phrase the user will actually say), or **decline** (a one-off prompt, not a repeatable process).
3. Name it in kebab-case, verb-first or by role (`pr-write`, `adr-writer`), and unused by any skill or agent in the plugin or the project.

**Done when** one sentence names the closest existing skill and why extending it was or was not right.

## Phase 2: Description

The `description` is the skill's trigger and its permanent context cost, so it earns harder pruning than the body.

- Lead with the skill's leading word: the word the user types when they want it.
- Say what the skill is in one clause, then "Use when ..." with each distinct branch once. Synonyms for one branch are duplication.
- A skill only the human ever runs gets `disable-model-invocation: true`: Claude Code drops it from the model's listing,
  and the human still runs it by name.

**Done when** every branch from Phase 1 appears exactly once, and deleting any remaining word would lose a trigger.

## Phase 3: Draft the body

Arrange content on the ladder in the glossary: steps first, then in-file reference, then disclosed reference.

- Each step ends on a completion criterion that is checkable, and exhaustive where it matters ("every modified file accounted for").
- Disclose what only some branches need into `references/<topic>.md`; inline what every path needs.
  Name each disclosed file in `SKILL.md` with when to read it: "Read `references/<topic>.md` before <the step that needs it>."
- Co-locate a concept's definition, rules, and caveats under one heading.
- Reach for leading words, and state the target behavior instead of prohibiting its opposite.

**Done when** every step has a checkable completion criterion, and every disclosed file is named with its trigger.

## Phase 4: Verify every claim

Open the source of every field, path, flag, tool behavior, or script while you write the sentence that cites it, never from memory.

| The draft cites | Check before it ships |
| --- | --- |
| A schema field or enum value | Read the schema and one real artifact; both must agree |
| A file path or glob | `ls` a real instance; compare the glob's match count with the folder's total |
| A skill or agent | Its folder or file exists in the plugin or the project |
| A command or flag | Run it with `--help` or real arguments, and check the output shape |
| A script | It exists at that path; read its header; say what to do when it is absent |
| "The project does X" | `grep` finds at least one real instance |

Write placeholders as `<name>`. A path that differs per worktree is derived from `git rev-parse`, never guessed.

**Done when** every citation has had its check, and you hold the list of commands you ran: Phase 7 needs it verbatim.

## Phase 5: Check

Run `aidrian lint skills <folder>` and `wc -c` on each `SKILL.md`; in this plugin's repository, run `npm run check`.
Run any generator or check the project's `harness_engineering` knowledge names.

**Done when** every command exits 0, and any generated file is staged beside its source.

## Phase 6: Prune

Sweep the draft, or on the audit branch the existing skill, sentence by sentence against the failure modes in the glossary:

- **No-op**: the model does it by default. Delete the whole sentence.
- **Duplication**: one meaning in two places. Keep one, or replace both with a leading word.
- **Sediment**: a stale line about behavior or paths that drifted. Verify it again, or delete it.
- **Sprawl**: all live and unique, still too long. Move reference down the ladder, or split by branch.
- **Negation**: a prohibition that names what to avoid. Rewrite it as the target behavior.
- **Premature completion**: a step that rushes. Sharpen its completion criterion before splitting the sequence.

When the sweep changed any file, run Phase 5 on the result before Phase 7, generators included: the version that ships is the one that passed.

**Done when** each surviving sentence passes the no-op and relevance tests. An audit of an old skill that deletes nothing is suspect.

## Phase 7: Ship

Skip this phase only for a report-only audit: an audit that changed no file in any phase of the run.

1. Commit from the task worktree (`aidrian worktree new`), with the Phase 4 commands in the message:

   ```text
   Verification:
   - <command> (<what it showed>)
   ```

2. Open a draft pull request with the `pr-write` skill only when the caller asked for one, or the running flow owns publishing.
   Otherwise report the commit as ready to publish.

**Done when** the commit lists the commands actually run, and the pull request exists or the commit is reported as ready.

## Retire or rename

In one commit, never a follow-up:

1. Delete the skill's folder and any generated copy of it.
2. `grep -rn '<old-name>'` across skills, agents, docs, and the project folder.
   Point every live reference at the skill that now owns the work, or remove it.
3. Run Phase 5.

**Done when** the grep finds the old name only in history, such as changelogs and decision records.
