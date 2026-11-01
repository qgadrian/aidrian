---
type: llm
name: audit by the skill's method
criteria: |
  Pass only if the final reply does all of these:
  1. Checks the skill's size or description against concrete limits: the SKILL.md byte limit (7,500 or 8,000
     bytes) or the 160-character description limit, with the measured number.
  2. Names a lint or check command that targets the folder holding the skill folders
     (`aidrian lint skills plugins/aidrian/skills`) or `npm run check`, not the skill's own folder.
  3. Checks at least one factual claim of the skill (a path, command, flag, or other file) against the
     repository and says what it found.
  4. Gives concrete changes, each with a reason, and says it changed nothing.
---
