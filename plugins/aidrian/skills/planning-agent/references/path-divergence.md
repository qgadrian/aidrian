# Path divergence assessment

When an acceptance criterion or slice goal names two or more triggering surfaces — for example, a slice that modifies both a `create` endpoint and an
`update` endpoint, or a slice whose closure criteria mention both a form submit handler and an API route handler — the planning agent must produce a
`path_divergence_assessment` artifact before the slice is locked.

## What the artifact must contain

`path_divergence_assessment` must identify the code path each named surface flows through (function name, route handler, or predicate) and determine
whether those paths are convergent or divergent.

**Convergent paths:** Two surfaces are convergent when they share a common function, validator, or predicate that processes both before any branching
occurs. If convergent, one test at the convergence point is sufficient. The plan must cite the convergence `file:line` in `path_divergence_assessment`.

**Divergent paths:** Two surfaces are divergent when they flow through different functions, route handlers, predicates, or sinks — even if they share a
surrounding module. If divergent, the plan must emit a parity matrix with:

- one test obligation per named surface
- one targeted E2E obligation per divergent path

Both obligations must appear in the slice's `planned_tests` and `closure_criteria`. A divergent assessment without both entries is an incomplete slice.

## Artifact requirement

`path_divergence_assessment` is a required plan artifact, not an optional note.
When a slice goal or acceptance criterion names two or more triggering surfaces, its absence is a blocked plan.
Do not lock the slice until the artifact is present.

## Example

A slice touches both the `POST /api/orders` create branch and the `PUT /api/orders/:id` update branch of the orders API route.

- If both branches call a shared `validateOrderPayload(body)` validator before any handler logic runs, the paths are **convergent** at that validator.
  The assessment cites `src/app/api/orders/route.ts:42` (the validator call) and one unit test at that point is sufficient. <!-- lint-skip -->
- If the create branch calls `createOrderHandler(body)` and the update branch calls `updateOrderHandler(body, id)` with no shared pre-processing, the
  paths are **divergent** at the handler level. The plan must emit a parity matrix:

  | Surface | Test obligation | E2E obligation |
  |---|---|---|
  | `POST /api/orders` (create) | Unit test: `createOrderHandler` reads the changed field | E2E: creates an order with the field set, asserts stored value |
  | `PUT /api/orders/:id` (update) | Unit test: `updateOrderHandler` reads the changed field | E2E: updates an order with the field set, asserts stored value |

  Both rows must appear in `planned_tests` and `closure_criteria` before the slice is locked.
