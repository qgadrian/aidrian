---
name: product-quorum-auto-start-human-started
max_turns: 25
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Bash, Agent, Edit, Write]
---

The Human started a product quorum on what happens to a slot when a customer cancels within 24 hours, and has left.
It has just reached its last round: its complete ledger is the one JSON file in .eval-state/quorum/product/.
This session is its coordinator, on the branch task/booking, whose base is main, and the ruling is in the `product` domain.
No person is around to answer.
Follow the plugin's shared decision rule, in the `knowledge` skill, from that ruling on, and do whatever it allows with no person here.
End the reply with the JSON line the route command printed, word for word; then what happens to the decision;
then the question for the Human, with the recommendation, if there is one.
