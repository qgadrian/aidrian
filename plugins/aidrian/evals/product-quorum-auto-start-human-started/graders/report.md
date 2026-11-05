---
type: llm
name: the decision waits, because the Human started the run, and the question goes in the report
criteria: |
  Pass only if all hold:
  1. The reply says the decision waits for the Human and work on it does not continue,
     because the Human started this run, or because only a run the route started under decide continues.
  2. It gives a question for the Human on what happens to the slot, with the recommendation (release at once),
     and says the end user was simulated or its answers are hypotheses.
  3. It writes no marker and keeps no guess at the answer in code.
---
