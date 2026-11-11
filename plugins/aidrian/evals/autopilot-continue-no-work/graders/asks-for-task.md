---
type: llm
name: finds nothing under way and asks for a task
criteria: |
  The run was launched to take over the work a session already had under way, in a fresh repository on its default
  branch with a clean checkout, no task branch, no pull request, and no plan. Judge the final reply. Pass only if all
  of these hold:
  1. It says it found no work under way to take over.
  2. It asks the user for a task to run.
  3. It reports no implementation, plan, or pull request started, and claims none was.
---
