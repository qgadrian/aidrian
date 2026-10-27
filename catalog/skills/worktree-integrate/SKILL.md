---
name: worktree-integrate
description: Dispatch the integrator role to land ordered slice branches into a shared task branch and route the first conflict to its owner.
conditionalTags: [worktrees, orchestration]
---

# Worktree Integrate

Thin dispatcher for `{{slot:runtime_state_root}}/agents/integrator.md`; that role owns all Git mechanics, mutation limits, conflict routing, and the return schema.

Require `task_branch`, `task_worktree_path`, `base_sha`, and at least two ordered `slice_branches` entries shaped as `{slice_id, branch, worktree_path, owner}`. The caller must already have approved parallelization and locked the landing order.

Prepare `{{slot:runtime_state_root}}/worktrees/<task-slug>` for `integrator` with the strict
resolver-v2 dispatch boundary. Preparation is not authorization. Run the
parent validation gate and pass the exact validated `payload_contract` with
`non_goals` and `escalate_if`. The integrator loads its ordered
`allRequiredDocs`, using `additionalDocs` as the delta, and returns a full
machine handoff with exact `loaded_docs` and `loaded_docs_fingerprint`. Validate
that full handoff parent-side before relaying it. Do not pass `loaded_docs` as
dispatcher input. Do not run Git commands, restate its landing procedure,
resolve conflicts, push branches, or remove slice worktrees.

Save the prepared contract to a dispatch-scoped file (`--output "$CTX"`)
and the integrator's full machine handoff JSON to `$HANDOFF`, then run both
parent-side gates:

```sh
node scripts/agent-context.mjs --validate-dispatch-context \
  --expected-role integrator --contract "$CTX"
node scripts/agent-context.mjs --validate-dispatch-return \
  --expected-role integrator --contract "$CTX" --child-return "$HANDOFF"
```
`/worktree-cleanup` owns disposal after the task PR merges.
