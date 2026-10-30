---
name: issue-verify-ac
description: Check an issue's acceptance criteria against the code, tick met ones after asking, and plan the rest.
---

# issue-verify-ac

Verify each acceptance criterion of one tracker issue against the code at one commit, tick the criteria that are met,
and plan the work for the rest. Agents gather the evidence; the session classifies, writes back, and reports.
It never edits code, never implements a fix, and never closes the issue.
The `issue-implement` skill implements the plan, when the Human starts it.

Before you start, follow the `knowledge` skill. Load your `issue_tracker` docs for the key format and the issue's sections.

## Inputs

```text
<issue> [--against head|pr|worktree] [--writeback ask|auto|never]
```

- `<issue>`: an issue key in the project's tracker format, such as `ABC-123` or `#123`, or its URL. One issue per run; for several, ask which one.
- `--against`, the code to verify:
  - `head`: the default branch on `origin`.
  - `pr`: the head of an open, non-draft pull request the issue links.
  - `worktree`: the current working tree, to track progress during implementation.
- `--writeback`:
  - `ask`, the default: show the change and write after the Human confirms.
  - `auto`: write without asking, only in an unattended run where every `met` criterion has an anchor, none is disputed,
    and nothing would be unticked. Otherwise it falls back to `ask`.
  - `never`: report only.

**stop** ends the run with a report of what is done and what blocks; **stop and ask** adds one question only the Human can answer.

## Contract

- **Coordination only.** Every piece of evidence comes from an agent. Read code only to route, and to check an anchor in step 3.
- **An agent's verdict stands.** Never substitute your own. Two agents that disagree on one criterion make it disputed:
  the Human decides before any writeback.
- **The tracker is read-only** except one body edit that changes checkboxes in the description. No comment, label, assignee,
  priority, state, attachment, or criterion text changes.
- **No hand-back.** A remediation item an agent can do never becomes a Human follow-up.

## Verdicts

Each criterion gets exactly one.

- `met`: the code at the ref satisfies it, with at least one evidence anchor: `path:lines` at the ref, or a test command and its passing result.
  Only `met` can be ticked. A `met` without an anchor is `needs_evidence`, whatever the agent says.
- `not_met`: it does not. The evidence names the missing behaviour, the file that should hold it, or the failing test.
- `partial`: some parts are met. It is not ticked, and the plan covers only the missing parts.
- `needs_evidence`: plausibly met, but no agent could produce an anchor, such as data no agent can read. Never ticked.
- `untestable_without_runtime`: only a run proves it, such as a latency or a message on first start.
  `e2e-runner` runs it when the flow has end-to-end tests; otherwise report the exact runtime check.
- `ambiguous`: the text is vague or contradictory, such as "as needed", "where appropriate", or "use existing patterns".
  Never define it yourself: ask to tighten it, or have `agent-issue-writer` rewrite it. Never ticked.

## Steps

1. **Resolve.** Read the `issue-implement` skill's `steps/phase-0-resolve.md` (`../issue-implement/` from this folder)
   and run its sections 2 and 3. A closed issue: stop and ask whether this is an audit.
   From the description's acceptance criteria section, record its exact line range, and each line's checkbox (`- [ ]` or `- [x]`)
   and id, such as `AC1`. Without ids, number them by position and report them as derived.
   No section and no checklist: stop and ask, offering `agent-issue-writer`. Vague criteria are `ambiguous` at once and skip step 3.
   A comment that amends a criterion goes in the report; the criteria come from the description unless it defers to a comment.
2. **Ref.** `--against` when given; `pr` finds its pull request as the first case below. Otherwise:
   - The issue links a pull request: `gh pr view <url> --json state,isDraft,headRefOid`.
     The first open, non-draft one makes the ref `pr`, at its `headRefOid`. Fetch it: `git fetch origin pull/<n>/head`.
   - The current branch is the issue's, with uncommitted source changes: ask whether to verify `worktree` or `head`.
   - Else `head`: `git fetch origin <default>`, then `git rev-parse origin/<default>`, where `<default>` is config.json `defaultBranch`.
3. **Verify.** Read `steps/verify.md` and run it.
4. **Delta**, per criterion:
   - unticked and `met`: tick it.
   - ticked and `met`: leave it.
   - ticked and anything else: leave it, and ask the Human whether to untick. Unticking erases a person's signal.
   - unticked and anything else: leave it; it goes into the plan.
5. **Writeback**, by `--writeback`: one edit of the body, the tracker's step in the `knowledge` skill's `references/tracker.md`, nothing else.
   - Toggle only checkbox markers inside the acceptance criteria section. Keep every other character as it was,
     including the criterion text, bold ids, other sections, and whitespace.
   - Just before the write, fetch the issue again. A description that changed since step 1: stop, and resolve again.
   - After the write, fetch it and confirm the patched lines. An unexpected result is reported, never retried.
   - A second run on the same issue and ref yields the same delta, often an empty one.
6. **Plan** the criteria that are not met, as `steps/verify.md` says.

## Output

1. **Scope**: key, title, URL, state, labels, assignee; the ref and its SHA; the criteria's line range and count.
2. **Verdicts**: `| id | verdict | evidence anchor | agent | ticked now |`, with exact paths and lines, or commands and outcomes.
3. **Writeback**: the ids to tick, untick, or leave, and the resulting state; then the confirmation question, the applied change,
   or `writeback: never`.
4. **Remediation plan**, when any criterion is not `met`. It ends with:
   "Reply approve to hand this to the `issue-implement` skill, or reply with corrections." This skill never starts it.
5. **Decided alone**, such as a derived id or an agent choice.
6. **Residual risks**: disputed verdicts, `needs_evidence` left without its evidence pass, and doc drift found on the way.

No restated issue, no "read file X" lines.
