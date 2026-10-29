# Code style

- JavaScript modules, no build step. Use `export function`, not default exports.
- Name functions after what they return or do: `canRead`, `revokeShareLink`.
- Comments say why, never what. Delete commented-out code.
- Dates are stored and compared in UTC. Format them for the user only at the edge.
