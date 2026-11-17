# Brief template

Write the brief from this template: every section, in this order, with nothing left as a placeholder.
A section with nothing to hold says `None.`, so a reader can tell it from a forgotten one.
`aidrian handoff check` fails a brief without Objective, Current state with its `Worktree:` and `Branch:` values,
Still running, a numbered Next steps, or Open risks and questions, and one whose header has no `Supersedes:` value.
`Chain: <n>` counts the automatic continuations in a row that led to this brief: the number the start context of a
continued session names, else 0, as the `session-continue` skill says. The check fails one that is not a whole number.
The check also fails any line longer than the project's `docs.wrapLimit` (155 by default), so wrap long lines as you
write them and keep each `Worktree:` and `Branch:` label at the start of its own line.

```markdown
# Handoff: <task title>
Written: <UTC timestamp> | Phase completed: <plan | implement | review | ...> | Supersedes: <brief or none> | Chain: <n>
Advice from <writer>, not a spec: check each claim against the docs and code before building on it.

## Objective
<one to three lines: the task, and what "done" means>

## Current state
- Worktree: <path, or none yet>
- Branch: <name>
- Pull request: <url or none>
- Verification already run: <exact commands>
- Product quorums: the count of automatic quorum runs this session, for `aidrian quorum route --runs`, when any ran

## Still running
- <what runs, one item each agent or job> | Output: <where it lands> | Then: <what to do with it>, or the line None.

## Decisions locked (do not relitigate)
- <decision>: <one-line reason, and who decided>

## Done
- <item and its evidence: a commit, a passing command>

## Next steps (ordered)
1. <the smallest next action, with exact paths and commands>

## Open risks and questions
- <each risk or question from an agent's result still open, whole, or the exact path and field that holds it>, or the line None.

## Key paths
- <files and docs the next session reads first>

## Gotchas
- <traps found: flaky checks, false alarms, naming traps>
```
