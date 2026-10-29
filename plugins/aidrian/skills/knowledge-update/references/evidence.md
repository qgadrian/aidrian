# Evidence

Where evidence comes from, when a missing source stops the run, and the packet you build for each doc.

## Sources

| Source | How | Notes |
| --- | --- | --- |
| Code and docs | Dispatch `explorer` with the topic: current behavior, types, invariants, validation, feature conditions | The truth about what the code does now |
| Pull requests, issues, commits | Dispatch `github-archaeologist` with the topic and the brief below; `git log` covers history without a pull request | It returns links and titles, never bare numbers |
| Tracker issues | The tracker tool the session has, which the project's `issue_tracker` knowledge names | Read its relations and the links attached to it |
| Other systems | Error tracking, a support inbox, or similar, through the tools the session has; at most 20 results per call | Only when the user or the project's `docs` knowledge names them |

The brief for `github-archaeologist`: the topic, the time window when there is one, the links to skip,
and "decisions made, alternatives rejected, scope framing, won't-do entries, and review-thread findings; links and titles only".

Dispatch every researcher in one message, so they run in parallel.
If that fails, run them one at a time, and summarize each result before the next.
If an agent named here is not installed, say so in the report; never stand in a generic agent for it.

## When a source is down

A source the user asked for, or that the project's `docs` knowledge requires, may be unavailable: not connected, or refused.
Then stop before proposing anything, write nothing, and report each such source with how to fix it and how to run again.
Any other unavailable source is skipped and listed in the report.
One missing item, such as a deleted pull request, is a skipped item, not a stop.

## Already cited

Collect the links a doc already has, and never present one of them as new evidence:

```sh
grep -oE 'https?://[^[:space:])"<>]+' <doc> | sort -u
```

## Evidence packet

Build one per doc before the proposal; the proposal and the write both come from it.

```json
{
  "target_path": "docs/knowledge/engineering/<topic>.md",
  "mode": "create",
  "section_brief": ["What it is and why it exists", "Rules and invariants", "Edge cases and errors", "Sources"],
  "evidence": {
    "repo": "<explorer findings: behavior, types, invariants>",
    "history": [
      { "url": "https://github.com/<owner>/<repo>/pull/<number>", "title": "<title>", "finding": "<decision, won't-do, or review finding>" }
    ],
    "other": { "<source>": "<findings, or null when skipped>" }
  },
  "already_cited": ["<links the target doc has>"],
  "today": "YYYY-MM-DD"
}
```

- `mode` is `create` for a new file, `update_section` to revise a named section, or `append` to add a section.
- `create` never overwrites a file that exists.
