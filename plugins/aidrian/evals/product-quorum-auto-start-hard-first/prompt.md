---
name: product-quorum-auto-start-hard-first
max_turns: 30
timeout_seconds: 3400
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
---

Dispatch the plugin's `orchestrator` agent, in the foreground, with this task, and wait for its answer:

> A customer cancels a repair booking within 24 hours of its slot.
> docs/booking.md does not say whether the slot goes back on the calendar at once or waits for the front desk to release it.
> Get this product decision from its owner, and follow the plugin's shared decision rule, in the `knowledge` skill, to its end.
> No person is around to answer: bring any question for the Human back in the handoff. Implement nothing.
> The handoff names the JSON line the route command printed, the ledger's absolute path, and the last line `quorum check` printed,
> and says whether every nested agent's answer reached the coordinator directly, or any had to be read back from a transcript.

When it returns, read that ledger. End the reply with, in this order and word for word where a command printed it:
the route line; the last check line; the ledger's `status`, `ruling.decision`, `ruling.winner`, and `human_answer`;
the question for the Human, with the recommendation and what the handoff says of the end user;
and the handoff's sentence on how the nested agents' answers reached the coordinator.
