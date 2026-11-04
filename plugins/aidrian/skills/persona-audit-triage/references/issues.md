# Filing an issue from a finding

Read before the first `issue` of a run: what the `agent-issue-writer` skill gets, and how the screenshots reach it.

- Before the first draft of a run, check that every label of `search_labels` and the items' `labels` exists in the
  tracker. In `confirm`, ask the Human once to create the missing ones, all in one question, and create them only
  after that yes. In `auto`, leave the missing ones out of every issue, and name them in the summary.
- Pass the finding, its steps, its quote, its evidence, its `labels`, its `source` line for the body, and its
  `audit_key` for a hidden footer only, as `pending --json` gives them. The source line names the report in words and
  the finding by its title, with the report's path as its location; the key never goes in the title or the first lines.
- Before a draft states what a rule is, calls itself a conformance fix, or says "no new product decision", the finding
  has a `breaks` verdict, as [deciding.md](deciding.md) § A rule verdict says. The body carries the verdict's quote and
  its `path#section`, from the item's `verdict` in `pending --json`. After `conforms` or `silent`, the body builds what
  the Human decided, `verdict.settled.reason`, and says so, and never calls the change a conformance fix.
- Pass a priority `pending` shows as the issue's priority, and a `decided` finding's decision in its body.
- In `confirm`, the skill shows the draft, creates the issue after the Human approves it, and only then may create a
  missing label the Human approved. In `auto`, it creates the issue at once and leaves a missing label out.
  A tracker without labels: the labels go in the body.
- Attach each screenshot the finding cites, from `<state>/audits/<evidence path>`:
  - GitHub: upload it with `gh image`, as the `pr-screenshot` skill's preflight sets up, and put the reference it
    prints in the body.
  - Linear: the host's Linear file upload, and the markdown it returns in the description.
  - Neither works: list the screenshots' full paths in the issue, and say they are on the local machine only.
