# Running the cases

Read before Step 7's first case run.

- This plugin: `claude plugin eval plugins/aidrian --case <name> --model <model> --no-publish --scaffold --trust-plugin --runs 1 --allow-tools Bash Write Edit`.
  It loads the worktree's plugin, not the installed one, and adds a baseline run without it.
  `--no-publish` keeps the report local; without it the report is published.
  `--scaffold` runs the case's `scaffold.sh`; without it the run folder is empty.
  `--allow-tools` grants what a run may use: without Bash no case reaches a command, and a case that writes a doc also needs `Write` and `Edit`.
  On macOS, the eval's sandbox can make Node's spawn of a bare `git` fail with EPERM when PATH holds a folder it denies.
  Then `aidrian` reads no base, and a case on routing prints the rule `no-base`.
  Put a `git` the sandbox can run first on PATH, such as `PATH="/opt/homebrew/bin:$PATH"`.
- A project skill: from the worktree, `claude -p --model <model> --output-format stream-json "<request>"`,
  once with the skill and once with it moved aside.
- A normal session or subagent loads the installed plugin by version, so it tests the old skill, never the draft.

Read the event stream and list the files the run read, in order:

- A reference never opened was either not needed or not signaled: drop it, or say when to read it.
- A reference opened on every run belongs in `SKILL.md`.
- Files read in an odd order mean the steps point the wrong way.
