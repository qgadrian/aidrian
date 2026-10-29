---
name: issue-implement
description: Implement one Linear issue end to end. Worktree, slice plan, a fresh agent per slice, review, commits, and a draft pull request; Linear stays read-only.
---

# issue-implement

Take one Linear issue to a draft pull request.
The session that runs this skill coordinates: it resolves the issue, locks a slice plan, dispatches one agent per slice,
checks each result, and opens the pull request through the `pr-write` skill.
It never edits a file itself, never merges, and never closes the issue.

Before you start, follow the `knowledge` skill. Load your `issue_tracker` docs for the key format, branch names, status names,
and closing keyword, and your `orchestration` docs for the agent registry. Each dispatched agent loads its own docs.
Load the `orchestration` skill too: it owns the worktree, parallel slices, the pull request, and review findings.
This skill adds what an issue needs on top of it.

## Inputs

```text
<issue> [--base <branch>]
```

- `<issue>`: a Linear issue key in the project's format, such as `ABC-123`, or the issue's URL. Missing: ask once.
  A GitHub reference such as `#123`: ask for the Linear key.
- `--base`: the branch the pull request targets. Default: the target branch the issue declares, else config.json `defaultBranch`.

One issue per run. When the Human names two, ask which comes first, and report the other as related, not in scope.
Work anchored to a plan with no issue belongs to the `plan-implement` skill, which reuses this skill's steps.

## Stop semantics

- **stop**: end the run with a report of what is done, what blocks, and the exact error.
- **stop and ask**: the same, with one question only the Human can answer. The answer resumes the run.

## Authority contract

- **Coordination only.** Every edit, review, and test run goes to an agent, even a one-line fix.
  Pick each owner by the `knowledge` skill's rule: a project agent that fits wins; this plugin's agents are the fallback.
- **One fresh agent per slice.** Never continue an earlier slice's agent to start the next slice.
  A warm agent that has seen the plan runs ahead: it implements and commits later slices and skips their reviews.
  Within one slice, its own agent may be continued for fixes and the commit.
- **A sanitized brief.** Each agent gets only its slice: id, goal, the acceptance criteria it covers, files in scope, non-goals,
  an upstream summary, the worktree's absolute path, the planned commit subject, its knowledge tags, and when to escalate.
  Never paste this skill, the conversation, or the whole issue description.
- **Two delivery legs.** An agent allowed to write gets an absolute handoff path,
  `<state>/dispatch/<branch>-<slice>-<agent>.json`, where `<state>` is the folder `aidrian state` prints.
  It writes its machine handoff there first, then sends a short summary as its last message.
  An agent denied `Write`, such as `explorer`, returns the handoff as its last message instead.
- **Linear is read-only until the pull request exists**, except one move of the issue to In Progress, made by this session.
  No dispatched agent writes to Linear.
- **No hand-back.** Work an agent can do is done now, or filed as a new issue through `agent-issue-writer`;
  it never reaches the Human as a follow-up.

## Steps

Read each file once, at the point the table names, and follow it.

| When | Read |
| --- | --- |
| At the start | `references/hard-rules.md`: what stops the run, what does not, and the rules every step keeps |
| At the start, after the rules | `steps/phase-0-resolve.md`: preflight, base branch, re-entry, and the issue guards |
| Once every guard in phase 0 passed | `steps/phases-1-4-implement.md`: workspace, slice plan, the per-slice loop, reassessment |
| Once every slice is committed | `steps/phases-5-8-close.md`: final gates, push, the pull request, the report |

Never dispatch planning or implementation before `steps/phases-1-4-implement.md` is loaded,
and never run the pull request step before `steps/phases-5-8-close.md` is.

## Output

One concise report, in this order. Leave out a section with nothing to say.

1. **Verdict**: `done: draft pull request opened`, `partial: blocked on <reason>`, or `partial: review left findings open`.
2. **Workspace**: worktree path, branch, and the base with where it came from: input, issue, or default.
3. **Slices**: id, goal, owner, files, and status of each.
4. **Commits**: the subjects, in order.
5. **Verification**: per slice, the exact commands and outcomes the handoffs report.
6. **Decided alone**: choices the Human should check, such as slice boundaries, a branch name, or a demoted finding.
7. **Residual risks**: open risks, findings demoted with a one-line reason, and accepted residuals.
8. **Pull request**: title, base, link, and the closing line, such as `Fixes ABC-123` or `Refs ABC-123`.

When a blocker stops the run, report what is done, what blocks, and the one question that needs an answer.
No restated issue, no "read file X" lines.
