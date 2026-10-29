---
name: worktree-integrate
description: Dispatch the integrator agent to land ordered slice branches into a shared task branch and route the first conflict to its owner.
---

# Worktree Integrate

Thin dispatcher for the `integrator` agent; that agent owns all Git mechanics, mutation limits, conflict routing, and the return schema.
`integrator` is this plugin's agent: spawn it as `aidrian:<name>` in Claude Code and `aidrian-<name>` in Codex.

Require `task_branch`, `task_worktree_path`, `base_sha`,
and at least two ordered `slice_branches` entries shaped as `{slice_id, branch, worktree_path, owner}`.
The caller must already have approved parallelization and locked the landing order.

Dispatch `integrator` with those inputs plus `non_goals` and `escalate_if`, and the knowledge tags the task needs beyond the agent's own.
Check its machine handoff before relaying it: every slice appears in `landings[]`, and a `blocked` result names the conflicted files and their owner.
Route a conflict to that owner, then dispatch `integrator` again for the remaining slices.

Do not run Git commands, restate its landing procedure, resolve conflicts, push branches, or remove slice worktrees.
Slice worktrees are removed after the task's pull request merges.
