---
type: llm
name: shows the import and asks before writing it
criteria: |
  The run's state folder holds two persona-audit reports of a bike shop's front desk on 2026-05-02, both written
  without a sidecar: a walk with 11 findings, and the read-only run it replaces, with 3 findings: "the part note sits
  behind a collapsed "Optional" section", "the second language names the drop-in three ways", and "the second
  language mixes formal and informal address". Judge the final reply. Pass only if all of these hold:
  1. It shows the Human what the import would record for the walk, its findings by title, as a table or a list.
  2. It lists the read-only run's three findings by title and asks the Human which a finding of the walk covers and
     which the walk did not re-check, or proposes a sort and asks the Human to confirm it.
  3. It asks the Human to approve before the import is written, and says nothing was written or recorded yet.
  4. It names the findings by title and the reports by persona, kind, or date, never by a bare item id such as "F1"
     or a file suffix such as "-2", outside a command shown as a command.
---
