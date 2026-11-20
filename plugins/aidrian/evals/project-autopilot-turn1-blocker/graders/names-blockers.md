---
type: llm
name: names every blocker at once and starts nothing
criteria: |
  The run was launched with no argument in a project whose config names exactly one tracker project and whose team has
  not allowed project runs. Judge the final reply. Pass only if all of these hold:
  1. It does not ask which tracker project to run: it takes the one the config names.
  2. It names the blockers it found in one message, including that project runs are not allowed, each with its fix.
  3. It asks the Human to fix them and says it starts nothing until they are cleared.
  4. It claims no run was started and no issue was started.
---
