---
name: product-quorum-auto-start-hard-review-later
max_turns: 50
timeout_seconds: 1500
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent, Edit, Write]
---

A product quorum on what happens to a slot when a customer cancels within 24 hours has just reached its last round:
its complete ledger is the one JSON file in .eval-state/quorum/product/.
Its route came from a hard call in the `product` domain, and this session is its coordinator, on the branch task/booking, whose base is main.
No person is around to answer.
Follow the plugin's shared decision rule, in the `knowledge` skill, from that ruling on:
this session is also the slice's implementer, so write what the implementer writes, and commit it. Stop at the rule's last step; change no code.
End the reply with each command and agent dispatch you ran, in order, one line each, with its last output line or its answer;
then the marker's line, word for word; then the ledger's path, as the report names it;
and then, last, what the rule says goes in the pull request's Decisions section for this ruling.
