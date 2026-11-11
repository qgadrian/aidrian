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
- The branch's plan: the first match of the plan path lookup of the `plan-implement` skill's Inputs, run in the session's worktree,
  design-import plans included; its fallback to the newest plan never names the branch's plan.
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
| The branch has an open pull request, or a review skill is mid-way on it | publish as § 5 says, then adopt it: `references/phases.md` § 2 from the line that records the pull request, then § 3 and § 4 |
| An implementing skill is mid-way, or the branch holds commits or changes with no pull request | publish as § 5 says, then implement what remains, as § 7 says, then phases 2 to 4 |
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

## 5. Publish what is local

The second and third rows of § 3 publish first, never with force: the owner the `knowledge` skill's agent rule picks
pushes the branch's commits to `origin/<branch>` in the foreground, as the `issue-implement` skill's
`steps/phases-1-4-implement.md` step 9 pushes a slice, the first push with `-u`.
On an adopted pull request, and on § 7's path with no plan and nothing left to change, that owner first finishes,
verifies with the project's checks, commits, and pushes the uncommitted work.
Before an engine or `planning-agent`, uncommitted work stays in the worktree for the owner of the plan's first incomplete slice.
A failed check, a remote head that is not an ancestor of HEAD, or a rejected push stops the run: park the rest and report, as `SKILL.md` § Stop says.
Confirm that `git ls-remote --heads origin <branch>` then prints HEAD.
Uncommitted changes the run cannot tie to the work stop the run with no question: on a pull request's branch,
as the branch preflight of the `orchestration` skill's `references/review-rules.md` says; with none,
as the `issue-implement` skill's `references/hard-rules.md` stops on changes unrelated to this one.

## 6. An adopted pull request

An open pull request on the branch is adopted, never implemented again: start no implementing skill on it.

- Rounds the pull request already had count toward the cap.
  The round is the `round` that `aidrian pr review <n>` prints, never a fresh count from 1.
  The cap is the `status` it prints, never `round` against the cap:
  a round at the cap can still be open on the same head, and an extra round can be granted.
  `round_limit` goes to the cap of `references/phases.md` § 4; any other status runs the round as its § 3 says.
- A review skill mid-way is the round in progress: `references/phases.md` § 3 enters at the step the session reached,
  and its § 4 owns ready and merge.
- An implementing skill that stopped after its draft opened left its integration review: on a branch with more than one slice,
  the round-1 specialist review of `references/phases.md` § 3 stands in for it.
- A pull request that is already ready stays ready. The rounds run on it as the review rules say;
  `references/phases.md` § 4 marks nothing and merges nothing, since this run marked nothing ready.

## 7. Work with no pull request

Only the engine table of `references/entry-task.md` § 1 is used: this file's § 2 replaces its Workspace bullet.
Never start from the base again, and never write a plan that repeats what the branch already holds.

- A plan for the branch: run the engine the table picks from its phase 0, whose re-entry step, the `issue-implement` skill's
  `steps/phase-0-resolve.md` § 5 or step 5 of the `plan-implement` skill's Phase 0, takes up the branch's commits.
- No plan and nothing left to change: run the gates of Phase 5 of the `issue-implement` skill's `steps/phases-5-8-close.md`
  on `origin/<base>..HEAD`, all but gates 1 and 4, which read a plan.
  With no slice, a security-sensitive diff gets a `security-engineer` review and a critical flow a `product-manager` sign-off.
  When they pass, open the draft through the `pr-write` skill with the inputs that file's Phase 7 passes, `<base>` from § 1 among them,
  and go on from the line of `references/phases.md` § 2 that records the pull request. A gate that fails is work left to change.
- Work left to change with no plan: dispatch `planning-agent` in the foreground, to `<state>/plans/<key>-implementation.md`
  when the session's task is an issue and `<state>/plans/<slug>-plan.md` otherwise.
  Besides the task, the brief carries the commits `git log --oneline origin/<base>..HEAD` lists, the uncommitted changes,
  each decision with whose it is, and this worktree and branch as the workspace.
  The plan covers only what remains, and the uncommitted work is its first slice.
  A plan that comes back `open-questions` or `blocked` is parked, and the run stops.
  Otherwise run the written plan with the engine the table picks for it: `issue-implement` for `<key>-implementation.md`, `plan-implement` for `<slug>-plan.md`.

## 8. The report

Its first item says what the run took over: the skill, the pull request and the round it entered at, or the plan.
