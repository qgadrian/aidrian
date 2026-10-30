# Phases 1 to 4: workspace, slice plan, slices

## Phase 1: workspace

1. The branch is the issue's `gitBranchName`, as it is. Without one, use the branch format the project's `issue_tracker` knowledge names.
2. Follow the `orchestration` skill § 1 with that branch and `--base origin/<base>`.
   - An existing worktree for the branch: `git -C <path> status --porcelain` and `git -C <path> log -1 --oneline`.
     Clean and at the branch tip: use it. Dirty with unrelated changes, or diverged: stop and ask.
   - The `worktree-new` skill asks before it reuses an existing branch. A new name the Human picks becomes the target branch.
   - A blocked result: relay its reason and next step, and stop.
3. **Move the issue to In Progress.** This session does it, never an agent, and only when `statusType` is `backlog` or `unstarted`.
   Already `started`: skip it, so a resumed run never writes twice and a status never moves back.
   Use the status name the project's `issue_tracker` knowledge gives. When Linear rejects it, find the team's `started` state
   with `list_issue_statuses` and try once more. A failure goes in the report; it never blocks the run.

## Phase 2: slice plan

Every non-trivial issue gets a slice plan, even when the issue carries an agent action plan.
A chore, a docs-only change, or a one-file refactor with no behaviour change may be a single slice.
A single slice still gets its review, its verification, and its hooks.

1. A fresh plan from phase 0: use its slices, order, and verification. A load-bearing open question in it: stop and ask.
2. Otherwise dispatch `planning-agent` in the foreground with: the issue summary (goal, scope, acceptance criteria with ids,
   non-goals, constraints, dependencies), the agent action plan as it is, the workspace from phase 1,
   the snapshot's `updatedAt` for `ticket_updated_at`, and the path `<state>/plans/<key>-implementation.md`.
   It writes a decision-complete plan in its schema, or returns `blocked`.
3. **Preview gate.** A plan with a new schema, an irreversible migration, a change to data-access rules, wider privileged access,
   or a change to a shared wrapper the project's knowledge protects: show the Human the plan before any implementation.
4. Acceptance criteria silent on a behaviour the code must invent, such as error copy, defaults, retries, limits, ordering,
   or page size: stop and ask one question that covers every gap. Never invent product behaviour.

## Phase 3: one slice at a time

Slices run in plan order. Slices with disjoint files may run in parallel by the `orchestration` skill § 2.
The review-only `INTEGRATION-REVIEW` slice never enters this loop: phase 7 runs it once the draft is open.
For each slice:

1. **Plan state.** Read the plan again and set the slice's `status: in_progress`. Step 9 sets `status: complete`.
   The plan records no commit SHA: `git log` finds a slice's commit by its subject.
   When git tracks the plan file, as a design import's, the plan is one of the slice's files and goes in its commit.
   The plan file is the record a resumed run trusts.
2. **Scope gate.** A directive from a knowledge doc that contradicts the issue's non-goals or leaves its files to modify
   is a `scope_collision`: stop and ask, citing both.
3. **Owner.** An agent that can edit files: the issue's agent action plan, else the agent registry in the project's `orchestration` knowledge,
   else this plugin's: `backend-developer` for server code and data, `designer` for presentation, `ux-specialist` for flow friction.
   A trust-boundary slice goes to the owner of its surface, such as `backend-developer`; `security-engineer` cannot edit,
   so it is the slice's required reviewer in step 6. No owner fits: stop and ask.
   When the slice may add a helper, run `helper-scout` first; its result is advisory.
4. **Dispatch a fresh agent** with the brief from the authority contract, plus:
   - the closure gate: the commands the project's `testing` knowledge names for the changed files pass, and the docs it makes stale are updated;
   - when to escalate: scope grows, product truth or a type is missing, a trust boundary or shared wrapper changes,
     or a hook would need bypassing;
   - tests first where practical. An exception goes in `compliance` as `tdd_exception: <reason>`, with the closest regression test;
   - implement and verify only, no commit yet.
5. **Check what landed.** Before the slice's first dispatch, keep `git -C <worktree> rev-parse HEAD` as the slice base.
   After each dispatch:
   - `git -C <worktree> status --porcelain` shows the claimed files. Missing: one retry with the same owner, then stop.
   - The commit-count guard: `git -C <worktree> rev-list --count <slice base>..HEAD` equals what the dispatch allowed, 0 or 1.
     More is an overstep: stop, list the extra commits, and put each one through its skipped review and verification first.
6. **Review, before the commit.** The slice's diff is `git -C <worktree> diff <slice base>`, the index and the working tree,
   plus the untracked files `git -C <worktree> ls-files --others --exclude-standard` lists.
   `code-reviewer` reviews it, and in parallel `security-engineer` when the slice crosses a trust boundary or touches auth,
   sessions, tokens, tenancy, payments, webhooks, uploads, redirects, untrusted content, or privileged access.
   `architect` only when the shape changed materially or `code-reviewer` asks for it.
7. **Findings.** Take each through the `orchestration` skill § 4. Before a `fix_now` goes to the owner, check that
   the cited file or symbol exists as cited, that the preferred pattern appears in two other places or in a knowledge doc,
   and that the fix stays inside the acceptance criteria. A finding that fails a check moves to residual risks,
   with `false_positive_on_reverification` and the reason.
   A security `fix_now` never moves on a failed check: only `security-engineer` closes it, as phase 5 gate 5 says.
   Send it the failed check; a finding it confirms goes to the owner.
   Send every verified `fix_now` of the round in one pass, never one dispatch per finding.
   The next review reads the slice's diff again, as step 6 defines it, never a commit range: the fixes are not committed yet.
8. **Verification.** The owner's handoff lists each command from its closure gate in `commands_run`, with its result.
   A missing or failing command goes back to the owner. A slice that touches a critical flow also gets `e2e-runner`,
   in the foreground and alone, on that flow.
9. **Commit.** Once the review is clean, set the slice's `status: complete` in the plan.
   Then the slice's own agent makes exactly one Conventional Commits commit
   with the planned subject and a `Refs <key>` body line. The closing keyword goes in the pull request body, not in a commit.
   Its handoff lists the exact `git commit` command and `not_bypassed`, or `hook_failed`, in `compliance`.
   Run the commit-count guard again: one commit. A failed commit sets the status back to `in_progress`.
10. **Cycle cap.** At most two fix passes per slice, counting review findings, security verdicts, and test failures together.
    A third round with an open critical or high finding, an open security `fix_now`, or a failing test: stop.

## Phase 4: between slices

- Read the plan again. A remaining slice that now spans two owners, two commits, or unclear verification is split before its dispatch.
- Work found outside the issue goes to `agent-issue-writer` as a new issue; never widen the scope in silence.
- **Re-size.** When the work has left the issue's files to modify, or no longer fits its size, check with the Human:
  go on, split, or defer. Record the new size and a one-line reason in the plan's frontmatter for phase 7.
