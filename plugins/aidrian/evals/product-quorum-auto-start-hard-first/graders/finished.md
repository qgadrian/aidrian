---
type: llm
name: a whole product run finishes in the coordinator, and work waits for the Human
criteria: |
  The reply reports a product quorum a subagent coordinator ran. Pass only if all hold:
  1. The ledger's `status` is `complete`, and `human_answer` is `null`, so nothing was decided.
     The wait may come from approval first, or from `resolve`'s `ask` on the Ruling's answers: either passes.
  2. `ruling.decision` is `rule` with a winner, or `escalate`.
  3. The reply gives a question for the Human on what happens to the slot, with the recommendation,
     and says the end user was simulated or that its answers are hypotheses.
  4. It says every nested agent's answer reached the coordinator directly, with none read back from a transcript.
---
