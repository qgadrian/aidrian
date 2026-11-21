# Tracker writes of a project run

Read before the first report. The tracker guard (`lib/tracker-guard.mjs` runWriteRefusal) holds every session of the
run to its part, whatever the working copy's `tracker.enabled` says. Who a session is comes from its marks alone.

| Who | May write |
| --- | --- |
| The driver | only the writes `aidrian project report` owes: a started issue's started status, and a settled issue's status, label, and comment, exactly as printed |
| An issue's session | optionally, when its tracker server answers: only its own issue, by its key: status `started`, an estimate, a patch of its body, and a new comment, each in plain text with no mention, link, address, image, or HTML, and a file or host name in backticks |
| Any session | no tracker tool that merges code or marks a pull request ready: `gh pr merge` and `gh pr ready` are the routes their guards judge, and a session no Human attends merges only through `pr-auto-merge` |

For the driver and an issue's session, every call on the tracker's server is a write unless its name says it reads.

## What a report owes

Once `aidrian project start` starts an issue, it owes a `started` report while it runs: the adapter's started status
type (Linear `started`, the team's first started status) alone, no label and no comment. It is owed once a run, never
again after `recorded`, and only for an issue the run's snapshot read before started, so it never moves a status back.
An issue that settles before it lands owes the settle report instead.

An issue owes one report when it settles for good: done after a merge the forge confirmed, or parked.
A failed attempt with attempts left owes nothing: the issue starts again.

| Outcome | Status | Label | Comment |
| --- | --- | --- | --- |
| started | the adapter's started status type (Linear `started`) | none | none |
| merged | the adapter's done status type (Linear `completed`): the tracker takes the team's first completed status | none | the pull request |
| parked, pr_open, failed out of attempts, ended | none | `projectRun.decisionLabel`, `needs-decision` by default | why it stopped, and each decision with its options and recommendation |
| blocked | `projectRun.blockedStatus` when the base branch sets one | `projectRun.decisionLabel` | what is missing |

The label and status come from the base branch's config, never the working copy's.
The comment quotes what the issue's session wrote, after the run has read its result file again and checked it:
no link, mention, HTML, or hidden character survives, and a file or host name stays as code text.

## Writing one

1. `aidrian project report <run> --json` lists each owed report: `key`, `outcome`, `status`, `label`, `body`, `sha256`,
   and `calls`, the exact tool calls for the base branch's tracker, such as Linear's `save_issue` and `save_comment`.
2. Make the calls in `calls`, in order, as given, on the tracker's connected server: the tool, and its input byte for
   byte. The issue call comes before the comment. Stop at the first call that fails: leave the report owed, and name the
   failure in the final report, such as a label the team lacks.
   With no `calls`, the tracker has no run tools: report each owed write to the Human instead.
   A `started` report has one call, the status. Read the issue first: when it already reads as started or later, such
   as In Review, which the forge's integration may set once a pull request opens, make no call, since the write would
   move it back.
3. After every call succeeds, or a `started` report needed none, run `aidrian project recorded <run> <key>`.
   The guard then refuses any further write of that report.

A refusal from the guard names what differs: fix the call to match the report, never the report.

## Accepted residuals

- A pull request's title, body, or commit that pairs a closing word, such as `Fixes`, with another issue's key moves
  that issue through the tracker's forge integration when it merges. Review is what stands between it and the merge.
- A session that writes the tracker through `gh` or `curl` instead of its MCP tools passes these guards.
- Every tracker connection in `projectRun.mcpServers` must reach its adapter's endpoint or be named in `tracker.servers`:
  the rule screens no tracker write on a server it maps to no tracker, which the preflight's `note mcp-servers` lists.
- A session another session's start holds, for the up to 5 minutes until the host lists the new one, is refused every
  tracker write; the refusal says so, and it lapses by itself.
