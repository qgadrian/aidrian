---
generated_at: "2026-10-28T09:00:00Z"
status: "ready"
plan_kind: "implementation"
workspace_decision:
  mode: "worktree"
  branch_name: "feat/self-serve-refunds"
  rationale: "one task, one worktree"
related_plans: []
---

# Self-serve refunds

## Goal

Let a customer refund their own order from the order page, within the refund window, without writing to support.
Support keeps its own refund path for late refunds.

## Current state

- Only support can refund today, by hand, in the card provider's dashboard.
- `src/orders.js` keeps each order with its `total`, `creditUsed`, `chargeId`, `placedAt`, and `refundedAt`.
- `src/payments.js` has `refund(chargeId, cents)`, which no code calls yet.

## Scope

- A `refundOrder` function that both the order page and support call.
- A "Refund this order" button on the order page, shown while the order is inside the refund window.

## Non-goals

- No partial refunds: a refund always covers the whole order.
- No change to checkout.
- No refund reason in this version.

## Approach

- Add `src/refunds.js` with `refundOrder(orderId, { by, customer, now })`:
  1. Find the order with `findOrder`. A missing or already refunded order is an error, so a second click refunds nothing.
  2. When `by` is `customer`, refuse an order placed more than 30 days before `now`.
  3. Give the money back the way the customer paid it: the card part goes back to the card, and the store-credit part
     goes back as store credit. That is `refund(order.chargeId, order.total)`, then
     `customer.creditCents += order.creditUsed`.
  4. Set `refundedAt` and save the order.
- The order page calls `refundOrder(id, { by: 'customer', customer })`;
  the support tool calls it with `{ by: 'support', customer }`.

## Affected surfaces

- `src/refunds.js` (new) and `src/refunds.spec.js` (new).
- The order page's refund button.

## Slices

### Slice S1

```yaml
slice_id: "S1"
goal: "refundOrder refunds a whole order the way it was paid, inside the window for customers"
primary_owner: "backend-developer"
files_in_scope:
  - "src/refunds.js"
  - "src/refunds.spec.js"
closure_criteria:
  - "A customer refund inside 30 days calls refund(order.chargeId, order.total) once, adds order.creditUsed back to the customer's credit, and sets refundedAt"
  - "A customer refund after 30 days is refused; a support refund after 30 days goes through"
  - "A second refund of the same order is refused"
verification_path:
  - "npm test"
planned_tests:
  - "src/refunds.spec.js: window, support override, double refund, credit returned"
upstream_dependency: null
planned_commit_subject: "feat(refunds): refund a whole order the way it was paid"
status: "pending"
```

### Slice S2

```yaml
slice_id: "S2"
goal: "The order page shows a refund button inside the window and calls refundOrder"
primary_owner: "frontend-developer"
files_in_scope:
  - "the order page"
closure_criteria:
  - "The button shows only while the order is inside the 30-day window and not refunded"
verification_path:
  - "npm test"
planned_tests: []
upstream_dependency: "S1"
planned_commit_subject: "feat(refunds): add the refund button to the order page"
status: "pending"
```

## Risks

- The card provider retries a refund call that times out, so one click can refund a customer twice.
  S1 should add a table of refunded order ids, checked before every provider call, to stop the second refund.

## Open questions

- None.

## Verification

- `npm test`

## Revision history

- 2026-10-28: first draft.
