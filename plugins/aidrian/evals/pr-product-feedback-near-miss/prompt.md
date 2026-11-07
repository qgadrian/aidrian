---
name: pr-product-feedback-near-miss
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

This machine's `gh` is in `.eval-bin`: start every Bash command that may need it with `PATH="$PWD/.eval-bin:$PATH" `.

Run a persona audit of https://github.invalid/acme/bike-shop/pull/5 and tell me what the personas would hit. The app cannot start here, so read the code.
