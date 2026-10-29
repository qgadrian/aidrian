# Phases 5 to 8: gates, push, pull request, report

## Phase 5: before the pull request

Check each gate in the task worktree: `git -C <worktree> rev-parse --show-toplevel` and `--abbrev-ref HEAD`
must name the worktree and the task branch.

1. Every slice in the plan is `complete`, with passing verification in its handoff.
2. The full suite the project's `testing` knowledge names passed on the branch's last commit; the last `code-reviewer` pass shows it.
   A commit landed after that pass: dispatch `code-reviewer` once more on the delta.
   A change to a critical flow: `e2e-runner` on that flow, in the foreground and alone.
3. No doc the branch makes stale is left without its update.
4. No `scope_collision` is open.
5. Every slice that called `security-engineer` has its `sign_off: approved`. A `concerns`, a dispute, or no verdict blocks the pull request.
6. A critical flow has the `product-manager` `sign_off: approved` from phase 0.
7. **Acceptance criteria coverage.** Every acceptance criterion id maps to a committed slice.
   A gap turns `Fixes <key>` into `Refs <key>`, and the report names the gap.

A gate that fails: fix and check again, or stop. Never skip to the pull request.

## Phase 6: push

Follow the `orchestration` skill § 3 step 1: push the branch and confirm the last commit is on the remote. Never force-push.
A pre-push hook can run for minutes: give the shell call a long timeout, and check `git ls-remote` before assuming a hang.
A rejected push stops the run.

## Phase 7: the pull request

Run the `pr-write` skill with:

- the branch, and the base from phase 0, passed explicitly so the pull request never targets the wrong branch;
- the closing line in the project's `issue_tracker` format: `Fixes <key>` when the branch covers the whole issue, else `Refs <key>`;
- the slices and their commit subjects, the verification commands with their outcomes, and the acceptance criteria covered;
- the residual risks, and the accepted residuals;
- draft, unless the Human asked for a pull request ready for review.

The `pr-write` skill owns the title, the body, and the publishing. This run ends at the draft;
the review loop of the `orchestration` skill § 3 runs after it when the Human or the calling skill asks for it.

**Estimate correction.** Only when phase 4 recorded a re-size, after the pull request opens, make two Linear writes:

1. One `save_comment` with the new size and its one-line reason.
2. One `save_issue` that sets `estimate` to the new size on the scale the project's `issue_tracker` knowledge gives,
   and patches the size wherever the description states it. Keep every other character of the description as it was.
   Skip it when the estimate and every size in the description already match.

A failed write goes in the report; it never fails a finished implementation.

## Phase 8: report

Write the report the skill's output section defines.
