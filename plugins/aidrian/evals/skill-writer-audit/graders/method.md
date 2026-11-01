---
type: llm
name: grounded audit
criteria: |
  Pass only if the final reply:
  1. Cites at least two specific lines or sections of plugins/aidrian/skills/pr-screenshot/SKILL.md.
  2. Checks at least one factual claim of the skill (a path, command, flag, or other file) against the
     repository and says what it found, instead of judging the prose alone.
  3. Gives concrete changes (what to cut or rewrite), each with a reason.
  4. Makes no edits and says it changed nothing.
---
