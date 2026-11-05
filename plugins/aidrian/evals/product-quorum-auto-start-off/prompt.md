---
name: product-quorum-auto-start-off
max_turns: 25
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent]
---

`product-manager` came back on a booking question, and its handoff is in handoff.json. Its brief carried no `authority` line.
This session is the dispatcher, with a shell. Take the next step the plugin's shared decision rule, in the `knowledge` skill, gives for this handoff.
No person is around to answer, and no file changes. End the reply with the JSON line the command printed, word for word,
and then one sentence on what happens to the decision next.
