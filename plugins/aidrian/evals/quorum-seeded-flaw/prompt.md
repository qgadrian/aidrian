---
name: quorum-seeded-flaw
max_turns: 150
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent, Write]
---

Run the plan-review skill on plans/stores-per-app-plan.md with --findings-only, so nothing is applied: we build it
next. I am away until tomorrow, so don't stop to ask me anything: list every decision or escalation you need from me at
the end instead. Don't edit any file in this project. Wait for every agent you start before you answer, then give one
complete final report in a single message. For every problem you raise, say which doc or code backs it, by path and
section or line. End that report with the changes the plan must make before implementation, under the heading
"Required changes".
