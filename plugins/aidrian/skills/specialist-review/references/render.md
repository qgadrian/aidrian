# Render

Read this file in step 4, and on any early stop in steps 1 and 2. It holds every block the skill shows the user.

## Finished review

```text
## <agent> review of <branch>

Base: <base_ref> @ <base_sha, 7>    Head: <head_sha, 7>    Diff: <file_count> files, <diff_lines> lines (<diff_mode>)
Linked issue: <key "title" (state)> | none found
Agent: <agent_id | not captured>    Mode: <cold | warm refresh>
<each note, one per line: warm reuse failed, agent id not captured, a warning from the scope>

### Verdict
<the agent's decision, verbatim>

### Findings
| # | Verdict | Severity | Likelihood | Affects | State | Location | Finding | Next step |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
<one row per finding>
<n> low findings without a cited project rule are not listed.

### Blockers and open questions
<the agent's blockers and open_questions, or "none">

### Risks
<the agent's risks, or "none">

### Follow-up
Ask about a finding by its number; the session sends the question to agent <agent_id>.
```

Order of the rows, so the first row is the first thing to fix:

1. Open findings before resolved ones.
2. Verdict: `fix_now`, `needs_axis`, `accepted_residual`, `drop_unless_cited`, `acceptable_as_is`.
3. Severity: critical, high, medium, low.
4. Likelihood: routine, plausible, contrived.
5. Otherwise the agent's own order.

A `drop_unless_cited` finding whose summary cites no project rule is counted in the line under the table instead of listed.
Leave that line out when the count is 0.
Without an agent id, the Follow-up section says: "No agent id: run the skill again to ask more."

## Summary mode

Put this above the heading:

```text
The diff passed 50 files or 2,000 lines, so the agent saw the file list and the first 50 lines of each file's diff.
Run again with --full to send the whole diff.
```

## Needs input

```text
## <agent> review of <branch>: needs input

The agent cannot finish without:
<the agent's decision_options or open_questions, verbatim>

Answer them, then run the skill again. Agent: <agent_id | not captured>
```

## Blocked

```text
## <agent> review of <branch>: blocked

Blocker: <the agent's blockers, or the scope reason, verbatim>
Next: <the agent's next_owner, or what would unblock the scope>
```

## Nothing to review

```text
## <agent> review of <branch>: nothing to review

The branch has no change against <base_ref> and no uncommitted change to a tracked file. No agent was spawned.
```

## Stopped

```text
## Specialist review of <branch>: stopped

Forgotten: <each removed key, one per line, or "none">
The agents themselves were not ended; they end with their sessions.
```

## Rules

- Copy each finding's axes and words from the agent; only the verdict column is computed, by `aidrian pr disposition`.
- Relay `needs_input` and `blocked` as they are, never as a finished review.
- An empty section shows `none`; never drop its heading.
