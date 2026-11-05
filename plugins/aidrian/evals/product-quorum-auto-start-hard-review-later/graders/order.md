---
type: llm
name: the continue path runs in the rule's order, and the ruling goes on record
criteria: |
  The reply lists the commands the session ran, in order. Other read-only commands, such as listing or reading a file, may sit between them.
  Pass only if all hold:
  1. `aidrian quorum check` on the ledger comes first, then `aidrian quorum route --ledger`.
     The settle dispatch, whose result keeps winner A, and the plain `aidrian quorum route --domain ... --doc` on the marker's doc both come after those,
     in either order, and before the writer.
     Then, in this order: `aidrian quorum provisional`; a git commit holding the marker; `aidrian decisions list --added-since`.
  2. The output it gives for that last command shows the committed marker, with no problem on it.
  3. For the pull request's Decisions section it gives the recommendation, what would flip it, and the settled fact's result,
     and it names no ledger path in that section.
---
