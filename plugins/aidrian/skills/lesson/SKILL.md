---
name: lesson
description: Capture a session lesson into the local inbox without leaving the task. Use on "note this lesson", or when a mistake, a hang, or a missing check appears.
---

# lesson

Write one lesson to the inbox and return to the task. Nothing else.

Capturing and deciding are separate on purpose.
Deciding what a lesson becomes (a hook, a check, a rule, an issue, or nothing) costs context,
so the `lesson-triage` skill does it later, in a session opened for it.
A lesson kept in the session "for later" dies with the session.

## Run

```bash
aidrian lesson add --tier P2 [--kind bug|gap|improvement|rule] [--target plugin|project] <<'LESSON'
evidence: <path, URL, or id>
<one line: what went wrong>
<what happened and what should have happened, with the commands, paths, and error text verbatim>
LESSON
```

Everything travels on stdin through a quoted heredoc, so `$(...)`, backticks, `$VAR`, quotes, and `&` in it are never expanded.
Leading `evidence:` lines are evidence, zero or more; the note is everything after them. Only the options go on the command line.

- **note**: from the request; if there is none, ask one question. Never guess it.
  The first line is the title triage reads first: one sentence that names the problem.
  Keep the specifics after it: the paths, the command, the error text. Triage generalizes; capture must not lose evidence.
- **evidence**: a file, doc, transcript, pull request, log, or session id, when one is at hand. Optional.
- **tier**: always pass it; triage works in tier order.
  - `P1`: it blocked the work or lost some: data, commits, a session's results.
  - `P2`: it cost time or tokens: a retry, a re-dispatch, a hang, a long detour.
  - `P3`: polish.
- **kind**: `bug` (something in place misbehaves), `gap` (nothing covers the case), `improvement` (it works and could cost less),
  or `rule` (a judgment worth writing down). Optional.
- **target**: `plugin` when this plugin's agents, skills, hooks, or `aidrian` commands are at fault;
  `project` for the project's own knowledge, config, or code. Optional; leave it out when unsure.

The command records the session, the agent, the branch, and the worktree itself. Print the id it returns and go back to the task.

When the problem is one you know is already in the inbox, record it again instead of adding a second lesson:
`aidrian lesson add --same <id>`, with any new note and evidence on stdin the same way.

When `add` names similar lessons and one of them is clearly the same problem, merge the new one into it with the command it prints.
When none clearly is, leave it; triage decides.

The inbox is `lessons/inbox.jsonl` in the folder `aidrian state` prints: outside the repository, shared by every worktree.
When `aidrian` is not on your PATH, run it from the folder that holds the `aidrian-knowledge` the start hook names.

## Rules

- One command, two at most with a merge: no dispatch, no doc reads, no approval.
- Never edit docs, agents, or skills from here.
- Capture when you notice it; never wait for the end of the task.
- Never put the note or the evidence on the command line; use the heredoc.
- If the capture fails, report it once, retry once, and go on with the task.
