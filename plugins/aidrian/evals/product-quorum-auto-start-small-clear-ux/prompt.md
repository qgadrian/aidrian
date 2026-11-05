---
name: product-quorum-auto-start-small-clear-ux
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
---

The list of a customer's bookings can be empty, and docs/booking.md gives no line for that. Ask `ux-specialist` which one line it should show.
This session is the dispatcher, with a shell: take the agent's answer to the next step the plugin's shared decision rule, in the `knowledge` skill, gives,
and stop right after that step's command prints. No person is around to answer, and no file changes.
End the reply with the agent's five answers on how hard the call is, each by its key, then the JSON line the command printed, word for word.
