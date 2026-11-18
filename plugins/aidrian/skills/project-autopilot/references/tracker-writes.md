# Tracker writes of a project run

Read before the first report. The run writes the tracker in two places only, and the tracker guard
(`lib/tracker-guard.mjs` runWriteRefusal) holds each to its part, whatever the working copy's `tracker.enabled` says.

| Who | May write |
| --- | --- |
| The driver | only the writes `aidrian project report` owes: a settled issue's status, label, and comment, exactly as printed |
| An issue's session | only its own issue, by its key: status, estimate, body, and a new comment |
| Either | no tool that merges code, such as a tracker's merge of a pull request: merges go only through `pr-auto-merge` |

## What a report owes

An issue owes one report when it settles for good: done after a merge the forge confirmed, or parked.
A failed attempt with attempts left owes nothing: the issue starts again.

| Outcome | Status | Label | Comment |
| --- | --- | --- | --- |
| merged | `completed`, the status type: the tracker takes the team's first completed status | none | the pull request |
| parked, pr_open, failed out of attempts, ended | none | `projectRun.decisionLabel`, `needs-decision` by default | why it stopped, and each decision with its options and recommendation |
| blocked | `projectRun.blockedStatus` when the base branch sets one | `projectRun.decisionLabel` | what is missing |

The label and status come from the base branch's config, never the working copy's.
The comment quotes what the issue's session wrote, after the run has read its result file again and checked it:
no link, mention, HTML, or hidden character survives.

## Writing one

1. `aidrian project report <run> --json` lists each owed report: `key`, `outcome`, `status`, `label`, `body`, `sha256`,
   and `calls`, the exact tool calls for the base branch's tracker, such as Linear's `save_issue` and `save_comment`.
2. Make each call in `calls` as given, on the tracker's connected server: the tool, and its input byte for byte.
   With no `calls`, the tracker has no run tools: report each owed write to the Human instead.
3. After both calls succeed, run `aidrian project recorded <run> <key>`. The guard then refuses any further write on it.

A refusal from the guard names what differs: fix the call to match the report, never the report.
A write the tracker itself refuses, such as a label the team lacks: leave it owed, and name it in the final report.
