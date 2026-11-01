# Running the cases

Read before Step 7's first case run.

- This plugin: `claude plugin eval plugins/aidrian --case <name> --model <model> --no-publish`.
  It loads the worktree's plugin, not the installed one, and adds a baseline run without it.
  `--no-publish` keeps the report local; without it the report is published.
- A project skill: from the worktree, `claude -p --model <model> --output-format stream-json "<request>"`,
  once with the skill and once with it moved aside.
- A normal session or subagent loads the installed plugin by version, so it tests the old skill, never the draft.

Read the event stream and list the files the run read, in order:

- A reference never opened was either not needed or not signaled: drop it, or say when to read it.
- A reference opened on every run belongs in `SKILL.md`.
- Files read in an odd order mean the steps point the wrong way.
