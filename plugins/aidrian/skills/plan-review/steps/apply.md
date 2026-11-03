# Step 5: Apply

Read this file for the `plan-review` skill's step 5, once its preconditions hold.
Its items are steps 5.1 to 5.4, the numbers the skill's step 6 and Close name.

1. Hash the plan again. When it changed since step 2, say so and start again at step 2:
   the changed plan gets a new hash, and the gates judge its new text before the next critique.
2. Dispatch `planning-agent` with the plan path, the approved findings, the approved diff with the Human's edits,
   and the revision-history line. It writes the same file.
3. It keeps `issue_id`, `issue_ref`, and `workspace_decision` unless an approved finding changes them; report any such change first.
4. Read the plan again: a schema plan passes the schema checks of `references/review-lens.md`, and `status` matches reality.
