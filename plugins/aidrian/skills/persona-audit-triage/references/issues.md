# Filing an issue from a finding

Read before the first `issue` of a run: what the `agent-issue-writer` skill gets, and how the screenshots reach it.

- Pass the finding, its steps, its quote, its evidence, its `labels`, its `source` line for the body, and its
  `audit_key` for a hidden footer only, as `pending --json` gives them. The source line names the report in words and
  the finding by its title, with the report's path as its location; the key never goes in the title or the first lines.
- In `confirm`, the skill shows the draft, creates the issue after the Human approves it, and only then may create a
  missing label. In `auto`, it creates the issue at once and leaves a missing label out, for the summary.
  A tracker without labels: the labels go in the body.
- Attach each screenshot the finding cites, from `<state>/audits/<evidence path>`:
  - GitHub: upload it with `gh image`, as the `pr-screenshot` skill's preflight sets up, and put the reference it
    prints in the body.
  - Linear: the host's Linear file upload, and the markdown it returns in the description.
  - Neither works: list the screenshots' full paths in the issue, and say they are on the local machine only.
