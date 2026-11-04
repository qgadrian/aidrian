---
type: llm
name: asks about the blocker first, by its title
criteria: |
  The run's state folder holds a persona-audit walk of a bike shop's front desk on 2026-05-02, with its sidecar, and
  no decision on any of its items. Its one blocker is the finding "a drop-in is not shown as a drop-in". The project's
  config leaves issue creation at "confirm". Judge the final reply. Pass only if all of these hold:
  1. It stops to ask the Human, and creates or claims to have created no tracker issue.
  2. Its first question is about the blocker alone, naming it by its title or in the same plain words, and
     recommends one decision with a reason.
  3. Wherever the reply speaks to the Human, it names each finding by its title or in plain words and each report
     by persona, kind, or date. It uses no bare item id, such as "F1", "F7", "N2", or "D1", and no report file
     suffix such as "-2", outside a command shown as a command.
  4. It names the owner in plain words, such as "the screens and their code", not only as an agent role such as
     "frontend-developer".
---
