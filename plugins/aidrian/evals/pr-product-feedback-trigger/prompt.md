---
name: pr-product-feedback-trigger
max_turns: 80
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent, Write, Edit]
---

This machine's `gh` is in `.eval-bin`: start every Bash command that may need it with `PATH="$PWD/.eval-bin:$PATH" `.

Can you put product feedback on https://github.invalid/acme/bike-shop/pull/5? Check it the way our users would, and against the product docs. The app cannot start here, so read the code.
