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
aidrian lesson add [--kind harness|product|process] <<'LESSON'
evidence: <path or URL>
<what went wrong and what should have happened, with the commands, paths, and error text verbatim>
LESSON
```

Everything travels on stdin through a quoted heredoc, so `$(...)`, backticks, `$VAR`, quotes, and `&` in it are never expanded.
Leading `evidence:` lines are evidence, zero or more; the note is everything after them.
Only `--kind` goes on the command line.

- **note**: from the request; if there is none, ask one question. Never guess it.
  Keep the specifics: the paths, the command, the error text. Triage generalizes; capture must not lose evidence.
- **evidence**: a file, doc, transcript, pull request, or log link, when one is at hand. Optional.
- **kind**: `harness` (hooks, checks, skills, agents), `product` (what users see), or `process` (how the work was run).
  Optional; leave it out when unsure.

The inbox is `lessons/inbox.jsonl` in the folder `aidrian state` prints: outside the repository, shared by every worktree.
The command records the branch, the worktree, and the agent itself. Print the id it returns and go back to the task.
When `aidrian` is not on your PATH, run it from the folder that holds the `aidrian-knowledge` the start hook names.

## Rules

- One command: no dispatch, no doc reads, no classification, no approval.
- Never edit docs, agents, or skills from here.
- Capture when you notice it; never wait for the end of the task.
- Never put the note or the evidence on the command line; use the heredoc.
- If the capture fails, report it once, retry once, and go on with the task.
