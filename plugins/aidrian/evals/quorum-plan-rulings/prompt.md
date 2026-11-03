---
name: quorum-plan-rulings
max_turns: 40
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
---

A plan quorum on plans/lesson-list-since.md is under way. The open ledger in .eval-state/quorum/ is this run's own
ledger: its objection and merge rounds are done, and its objections are checked. Continue it from the rulings round:
get a ruling on each of the three objections, record the rulings in the ledger, and run
`plugins/aidrian/bin/aidrian quorum check` on it with `--plan`. Stop after that check: no rebuttals, no later round,
and no question to me. End the reply with the last line the check printed, and then the ledger's `objections` array as
JSON, word for word.
