---
type: llm
name: evidence-first method
criteria: |
  Pass only if the final reply does all of these:
  1. Checks for overlap with existing skills or agents before proposing a new skill, and names the closest
     one it found (this plugin ships an e2e-runner agent; naming it, or another real neighbor, counts).
  2. Gives frontmatter whose description starts with a verb, says what and when, and is at most 160 characters.
  3. Plans to prove it works by running real requests or test cases before and after the skill (a baseline),
     not only by linting or reading it over.
  4. Names a lint or check command that targets the folder holding the skill folders (plugins/aidrian/skills),
     or `npm run check`, rather than only the new skill's own folder.
---
