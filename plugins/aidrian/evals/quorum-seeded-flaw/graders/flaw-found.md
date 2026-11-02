---
type: llm
name: finds that the existing spec also imports orders.js, backed by the code
focus: last_message
criteria: |
  The plan says `src/orders.js` is imported only by `src/checkout.js`, so checkout is the only caller to update, and
  S1's files in scope leave out the existing spec. In the code, `src/checkout.spec.js` imports `findOrder` from
  `src/orders.js`, so removing the module-level exports breaks that spec, which the plan neither lists nor updates.
  Judge the final report the assistant gives the user at the end of the run.
  Pass only if that report does both:
  1. Reports as a problem the plan must fix that `src/checkout.spec.js` also imports from `src/orders.js`, so the
     plan's "only checkout imports it" claim is wrong and the spec would break or must be in scope.
  2. Backs it with `src/checkout.spec.js`, by path, line, or its import.
---
