# Entry: continue a session

Read at the start of a run launched with `--continue`. It takes over the work this session already has under way
and finishes it under the same unattended rules. Everything here happens while the Human is still here;
once the entry is picked, `SKILL.md` § Who decides applies.

## 1. Read the state fresh

Read the state fresh, while the Human is here: the session's memory of it is a lead, never the record.

- From the session: the task in the Human's words, the skill it loaded last and the step it reached,
  the worktree and branch it worked in, and each decision so far with whose it is:
  the Human's, an agent's `decided_provisional`, or the session's own.
- From commands: `git worktree list --porcelain`, then in the session's worktree `git branch --show-current`,
  `git status --porcelain`, and `git log --oneline origin/<base>..HEAD`.
  `<base>` is `--base`, else the base of the branch's pull request, else the target branch the issue declares,
  as the `issue-implement` skill's `steps/phase-0-resolve.md` § 4 says, else config.json `git.defaultBranch`.
- Only for a task branch: `gh pr list --head <branch> --state open --json number,url,isDraft,baseRefName,headRefOid`.
  A session with no task worktree, on the default branch with a clean main checkout, has no branch to look up, so `gh` does not run.
- A plan under `<state>/plans/` whose `workspace_decision.branch_name` is the branch, where `<state>` is the folder `aidrian state` prints.
- When the session cannot tell which step a skill reached, or two worktrees or pull requests could be the work, ask now which.
  A failed `gh` or `git` read on a task branch is missing access: say so now, as `SKILL.md` § Stop says.

## 2. The workspace

Launching with `--continue` approves the session's own worktree and branch, and no other:
the `worktree-new` skill's reuse question is answered Reuse, with `--reuse-existing`, for that branch only.

- The worktree that holds the session's work is the run's workspace, wherever the launch happened: every later command runs there.
- A branch with no worktree gets one through the `worktree-new` skill, with that approval.
- Work that sits uncommitted in the main checkout, or a branch checked out there, is not adopted in silence:
  ask the `orchestration` skill § 1's question now. Unanswered, the run does not start.
- With an open pull request, the base is the pull request's. A `--base` that names another is asked about now, never applied.

## 3. Pick the entry

The first row that holds, in this order:

| The state | The run |
| --- | --- |
| A skill is mid-way that is not one of this run's own | finish that skill's own steps, with `SKILL.md` § Who decides in place of each question it would ask the Human; then take the next row only when it is the pull request row, and otherwise report |
| The branch has an open pull request, or a review skill is mid-way on it | adopt it: `references/phases.md` § 2 from the line that records the pull request, then § 3 and § 4 |
| An implementing skill is mid-way, or the branch holds commits or changes with no pull request | implement what remains, as § 6 says, then phases 2 to 4 |
| None of these | Nothing under way: ask for a task now, while the Human is here. With a task, follow `references/entry-task.md`; with no answer, start no run |

This run's own skills are `knowledge`, `orchestration`, `worktree-new`, `issue-implement`, `plan-implement`, `pr-write`,
`pr-review-loop`, `pr-review`, `pr-review-fix`, `pr-product-feedback`, `pr-auto-merge`, and `session-handoff`.
A skill loaded after the launch is never mid-way: only what the session ran before it counts.

## 4. Another skill

Its steps keep their owners, and its own output is the end of its part.

- A question that guards an action that cannot be undone, such as a delete, a merge, or a write in the Human's name,
  is never answered by the launch: park it.
- A skill whose remaining steps are all questions to the Human leaves nothing to run: say so now, and start no run.
- Start nothing new: what remains is what the session was already asked to do.
  Work the skill leaves with no pull request is named in the report's last item, and the run opens nothing for it.
- `SKILL.md` § Hard rules hold for its steps as for any other.

## 5. An adopted pull request

An open pull request on the branch is adopted, never implemented again: start no implementing skill on it.

- The product feedback step of `references/phases.md` § 2 runs as written: `status` decides whether anything is owed.
- Rounds the pull request already had count toward the cap.
  The round is the `round` that `aidrian pr review <n>` prints, never a fresh count from 1.
  The cap is the `status` it prints, never `round` against the cap:
  a round at the cap can still be open on the same head, and an extra round can be granted.
  `round_limit` goes to the cap of `references/phases.md` § 4; any other status runs the round as its § 3 says.
- A review skill mid-way is the round in progress: `references/phases.md` § 3 enters at the step the session reached,
  and its § 4 owns ready and merge.
- An implementing skill that stopped after its draft opened is not entered again:
  its re-entry stops on an open pull request (the `issue-implement` skill's `steps/phase-0-resolve.md` § 5).
  The round-1 specialist review of `references/phases.md` § 3, on a branch with more than one slice,
  stands in for the integration review it had left.
- A pull request that is already ready stays ready. The rounds run on it as the review rules say;
  `references/phases.md` § 4 marks nothing and merges nothing, since this run marked nothing ready.

## 6. Work with no pull request

Only the engine table of `references/entry-task.md` § 1 is used: this file's § 2 replaces its Workspace bullet,
and the plan carries the session's work and decisions.

- A plan for the branch: pick its engine by the table of `references/entry-task.md`;
  the engine's re-entry resumes at the first incomplete slice.
- Nothing uncommitted and nothing left to change: start no engine.
  Dispatch `code-reviewer` in the foreground on `origin/<base>..HEAD`, against the task, with the project's full suite.
  A `fix_now` finding or a failing test is work left to change: plan it as below.
  Otherwise, compare HEAD with the commit `git ls-remote --heads origin <branch>` prints.
  When it is missing or differs, an agent allowed to write, the owner the `knowledge` skill's agent rule picks for the branch's work,
  runs `git push -u origin HEAD:<branch>` in the foreground, never with force:
  a remote head that is not an ancestor of HEAD stops the run.
  Confirm that `git ls-remote --heads origin <branch>` then prints HEAD; a rejected push stops the run, as `SKILL.md` § Stop says.
  Then open the draft through the `pr-write` skill, as `references/phases.md` § 2 says,
  and go on from its line that records the pull request.
- Work left to change, or uncommitted work, with no plan: dispatch `planning-agent` in the foreground, to `<state>/plans/<key>-implementation.md`
  when the session's task is an issue and `<state>/plans/<slug>-plan.md` otherwise.
  A plan that comes back `open-questions` or `blocked` is parked, and the run stops.
  Otherwise run the written plan with the engine the table picks for it:
  `issue-implement` for `<key>-implementation.md`, `plan-implement` for `<slug>-plan.md`.
  Besides the task, the brief carries the commits `git log --oneline origin/<base>..HEAD` lists, the uncommitted changes,
  each decision with whose it is, and this worktree and branch as the workspace.
  The plan covers only what remains, and the uncommitted work is a slice of it.
- Never start from the base again, and never write a plan that repeats what the branch already holds.

## 7. The report

Its first item says what the run took over: the skill, the pull request and the round it entered at, or the plan.
