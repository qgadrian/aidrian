---
type: llm
name: the setting off keeps resolve's answer, and does not apply the hard-call rule
criteria: |
  The reply shows a route of `as-today`, on a call whose answers include a `yes`. Pass only if all hold:
  1. It says the decision follows `resolve`'s answer as it stands: it goes to the Human, or an unattended run follows `unattended`.
  2. It does not apply the hard-call rule: it does not start or plan a quorum,
     and it does not say that being hard makes the call wait or rules out a `safe-default`.
---
