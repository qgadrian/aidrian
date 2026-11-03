---
type: llm
name: asks one plain question, recommendation first
criteria: |
  The plan leaves open whether reworded repeats of a lesson should be merged. Judge the first question the final reply
  asks the user. Pass only if all of these hold:
  1. It asks for exactly one decision.
  2. It says what goes wrong in plain terms, such as repeats still filling the inbox or two different mistakes being
     merged and one note lost, readable by someone who has not read the plan.
  3. It gives a recommended answer before or alongside the options, with one reason.
  4. The question sentence itself uses no plan step IDs (D1, D2, D3), hashes, or file paths.
---
