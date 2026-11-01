---
type: llm
name: audit by the skill's method
criteria: |
  Pass only if the final reply does all of these:
  1. Checks the skill's size or description against concrete limits: the SKILL.md byte limit (7,500 or 8,000
     bytes) or the 160-character description limit, with the measured number.
  2. Reports the result of a lint or check run on the skill (for example that `aidrian lint skills` or
     `npm run check` passes or what it flags), or names the command it would run.
  3. Checks at least one factual claim of the skill (a path, command, flag, or other file) against the
     repository and says what it found.
  4. Gives concrete changes, each with a reason, and says it changed nothing.
---
