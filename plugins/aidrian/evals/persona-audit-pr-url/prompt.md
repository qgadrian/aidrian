---
name: persona-audit-pr-url
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

This machine's `gh` is in `.eval-bin`: start every Bash command that may need it with `PATH="$PWD/.eval-bin:$PATH" `.

Run a persona audit of https://github.com/acme/bike-shop/pull/5/files. The app cannot start here, so read the code.
