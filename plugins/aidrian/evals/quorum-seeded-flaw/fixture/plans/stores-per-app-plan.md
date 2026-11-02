---
generated_at: "2026-10-29T09:00:00Z"
status: "ready"
plan_kind: "implementation"
workspace_decision:
  mode: "worktree"
  branch_name: "refactor/order-store-per-app"
  rationale: "one task, one worktree"
related_plans: []
---

# Create the order store per app

## Goal

Apply `docs/adr/0002-stores-are-created-per-app.md` to the orders module first: move its module-level Map into an
order store that one `createApp()` builds, so tests stop sharing orders. The payments module follows in its own plan.

## Current state

- `src/orders.js` keeps the orders in a module-level Map and exports `saveOrder` and `findOrder`.
- `src/orders.js` is imported only by `src/checkout.js`.

## Scope

- `createOrders()` in `src/orders.js`, returning `{ saveOrder, findOrder }` over its own Map.
- `src/app.js` (new): `createApp()` builds an order store and a checkout bound to it.

## Non-goals

- No change to the payments module or to what checkout does.
- No persistence: the store stays in memory.

## Approach

- `src/orders.js` exports only `createOrders()`; the module-level Map and exports go away.
- `src/checkout.js` exports `createCheckout({ orders })`, which returns `placeOrder`; it still imports `charge` from
  `src/payments.js` as today.
- `src/app.js` exports `createApp()`, which returns `{ orders, checkout }`.
- Since only `src/checkout.js` imports the orders module, it is the only caller to update.

## Affected surfaces

- `src/orders.js`, `src/checkout.js`, and `src/app.js` (new).

## Slices

### Slice S1

```yaml
slice_id: "S1"
goal: "The order store is created per app, and checkout takes the store it is given"
primary_owner: "backend-developer"
files_in_scope:
  - "src/orders.js"
  - "src/checkout.js"
  - "src/app.js"
  - "src/app.spec.js"
closure_criteria:
  - "src/orders.js keeps no state at module level"
  - "Two apps from createApp() share no orders"
  - "Checkout saves the same order as before"
verification_path:
  - "npm test"
planned_tests:
  - "src/app.spec.js: two apps share no orders; checkout through an app saves what it did before"
upstream_dependency: null
planned_commit_subject: "refactor(orders): create the order store per app"
status: "pending"
```

## Risks

- Saving an order whose id the store already holds adds a second copy of it, so one order can appear twice in the
  store. The per-app store keeps this behaviour as it is today.

## Open questions

- None.

## Verification

- `npm test`

## Revision history

- 2026-10-29: first draft.
