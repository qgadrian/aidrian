# 2. Stores are created per app

- Status: accepted
- Date: 2026-10-20

## Context

`src/orders.js` and `src/payments.js` keep their state in module-level variables, so every test and every app in
one process share the same orders and provider calls.

## Decision

Each module exports a factory that returns its functions over fresh state. One `createApp()` builds the stores and
passes them to the code that needs them. No module keeps state at module level.

## Consequences

- Tests build their own app and never see another test's state.
- Every caller of a module's functions changes to take the store it is given.
