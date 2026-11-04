---
type: llm
name: asks which tracker, alone, before any finding
criteria: |
  The run's state folder holds a persona-audit walk of a bike shop's front desk on 2026-05-02, with its sidecar, and no
  decision on any item. The project's knowledge names no issue tracker. Judge the final reply. Pass only if all hold:
  1. It asks the Human which tracker the project uses, and says in plain words why it needs to know.
  2. That is the only question in the reply: it asks no decision about any finding, and proposes none.
  3. It creates or claims to have created no issue.
---
