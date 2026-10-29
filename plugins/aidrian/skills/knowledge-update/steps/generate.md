# Mode: generate

A new doc, or a small set, for a topic with no coverage or only a stub.

1. **Check coverage.** Search for the topic. If a doc covers it and is not a stub, stop:
   tell the user to use `refresh` mode for stale facts, or `extend` mode to add one resource.
2. **Plan the target.** Put the doc in the bucket whose description fits the topic, inside that bucket's `dir`.
   Plan one doc. Plan a second only when the evidence clearly splits, such as an overview and a lifecycle, and say why.
   When no bucket fits, or two fit, offer the user two or three concrete paths.
3. **Gather** from the sources in `references/evidence.md`, in one parallel batch:
   `explorer` and `github-archaeologist` always, and the other sources the project names.
4. **Build** one evidence packet per planned doc, mode `create`.
   Put each contradiction between sources, such as code that does X and a review thread that says not X, in the proposal.

Go on with step 4 of the skill.
The report adds nothing to the skill's list. Commit message: `docs(<area>): add <topic> knowledge`.
