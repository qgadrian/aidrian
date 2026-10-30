# Lessons

The lesson inbox turns what goes wrong in sessions into fixes.
An agent captures a lesson with one command and goes back to its task.
Later, a session opened for the `lesson-triage` skill routes each lesson to one end: a fix, an issue, a merge, or a rejection.
A lesson that comes back after its fix reopens, so a fix that did not hold is visible.

## The inbox

The inbox is `lessons/inbox.jsonl` in the [state folder](project-folder.md#local-state): on this machine only,
shared by every worktree and clone of the repository. `aidrian lesson` is the only thing that reads or writes it.

The file is only ever appended to. Each row is one event on one lesson, and the command replays them in order:

| `event` | Written by | What it does |
| --- | --- | --- |
| `add` | `aidrian lesson add` | Starts a lesson. A row whose `key` an earlier lesson holds is that lesson seen again instead. |
| `seen` | `aidrian lesson add --same <id>` | Records the lesson once more, with an optional note and evidence. |
| `update` | `aidrian lesson update` | Changes the tier, kind, or target. |
| `resolve` | `aidrian lesson resolve` | Closes the lesson with an outcome and a link. |

No lock is needed: a row is one append, so rows from concurrent sessions never interleave, and nothing rewrites the file.
A line that does not parse is skipped.
An `add` row with a `key` may also carry `once`, naming the event it reports: a later row with the same key and `once`
is that event observed again, and adds nothing.

## A lesson

| Field | Meaning |
| --- | --- |
| `id` | Eight hex digits. |
| `title` | The note's first line, cut to 120 characters. |
| `note`, `evidence` | What went wrong and what should have happened, verbatim; evidence is paths, links, or ids. |
| `tier` | `P1` blocks work or loses it, `P2` costs time or tokens, `P3` is polish. `P2` when not given. |
| `kind` | `bug` (something misbehaves), `gap` (nothing covers the case), `improvement` (it works, could cost less), or `rule` (a judgment to keep). |
| `target` | Who fixes it: `plugin` for this plugin's agents, skills, hooks, and commands; `project` for the project's knowledge, config, and code. |
| `key` | Optional. Rows with the same key are one lesson. [Automatic lessons](#automatic-lessons) always have one. |
| `source` | `manual`, or `auto` for an automatic lesson. |
| `session`, `agent`, `branch`, `worktree` | Where it was captured; `session` is Claude Code's session id, as on [dispatch log](dispatch-log.md) rows. |
| `seen`, `occurrences` | How many times it happened, and the later times with their notes. `--json` shows the last five. |
| `status`, `outcome`, `link`, `expect` | `open` or `resolved`; how it ended, where to, and for a fix, what number should move. |
| `reopened`, `resolutions` | How many times a fix did not hold, and every resolution with the occurrences that came after it. |
| `merged`, `mergedInto` | The lessons merged into this one, or the one this one was merged into. |

## Commands

```console
$ aidrian lesson add --tier P1 --kind bug --target plugin <<'LESSON'
evidence: logs/push.txt
git push exited 141 after the pre-push hook passed, and the remote did not move
The ssh connection idled out while the hook ran for ten minutes.
LESSON
5ad59dae
```

Everything after the options travels on stdin through a quoted heredoc, so nothing in it is expanded.
Leading `evidence:` lines are evidence; the note is the rest.

- `add` prints the lesson's id. When other lessons look like the same problem, it names up to three and the command that
  merges the new one into one of them. It compares words, weighting the ones that are rare in the inbox.
- `add --same <id>` records a known lesson again. `--key <key>` does the same for any row with that key, so a script can
  report one problem many times and keep one lesson.
- `list` shows open lessons in triage order: tier, then age. `--status resolved|all`, `--tier`, `--kind`, `--target`,
  `--source`, and `--limit N` narrow it. `list <id>` shows one lesson in full. `--json` adds `similar`, the ids of up to three
  lessons that look like the same problem.
- `resolve <id> --outcome <outcome> --link <ref>` closes a lesson; `--link -` reads the link from stdin.
  `--expect '<what should move, and the command that reads it>'` records how to check a fix later.
- `update <id> --tier P1` changes the tier, kind, or target, such as when triage disagrees with the capture.
- `stats` counts what is open, what moved in the last `--since 30d`, and whether each fix since then held.
- `nudge` prints the session-start line.

Every command takes `--project <dir>`, so one checkout can read another project's inbox.

## Outcomes

| Outcome | When | `--link` | A later occurrence |
| --- | --- | --- | --- |
| `mechanism` | A script, check, or hook now catches it | the commit or pull request | reopens it |
| `rule` | Judgment no mechanism can encode, now written in the doc that owns the topic | the doc or pull request | reopens it |
| `issue` | Work bigger than one change, now in the tracker | the issue | counts, and stays resolved: the tracker owns it |
| `merged` | Another lesson is the same problem | that lesson's id | goes to that lesson |
| `rejected` | Specific to one session, already fixed, or not worth its cost | the reason | reopens it |

Merging moves the lesson's occurrences to the lesson it names, and any later row for its id or key goes there too.
An occurrence counts against a resolution only when it happened after it, so merging an old duplicate into a fixed lesson
never reopens the fix. Every occurrence after the latest resolution counts against it, also those after the first one
reopened the lesson, so a fix shows how often it failed, not only that it did.

`stats` lists the fixes in its window: each held for how many days, or recurred, with its `expect`.

```console
$ aidrian lesson stats
Lesson inbox /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/lessons/inbox.jsonl
Open: 4 (P1 0, P2 3, P3 1); plugin 2, project 1, no target 1; 1 automatic; the oldest 9 days old.
Since 30d: 7 added, 5 seen again, 6 resolved (mechanism 3, rule 1, merged 2), median 2 days to resolve.
Fixes since 30d: 4; 3 held, 1 recurred.
  5ad59dae  mechanism  2026-10-02  held 27 days  git push exited 141 after the pre-push hook passed
            expect: aidrian report: no push retries in the session rows
```

## Session start

The main session's start line ends with one line about the inbox while a lesson is open, and with nothing otherwise:

```text
Lesson inbox: 4 open (P2 3, P3 1), the oldest 9 days old. The lesson-triage skill drains it in a session opened for it.
```

It escalates, naming every reason, when a `P1` is open, when more than `lessons.maxOpen` lessons are open (20),
or when the oldest is older than `lessons.maxAgeDays` days (14). It then asks the agent to tell the Human once:

```text
Lesson inbox needs triage: 1 P1 open; the oldest is 31 days old, over 14. Tell the Human once, then go on with the task: ...
```

A limit of `0` turns that reason off. [config.md](config.md) lists the keys.

## Automatic lessons

The plugin records three signals it already sees as lessons of its own, with `source: auto`.
Each has a key, so it dedupes by itself: one lesson per signal, one occurrence per event,
and an occurrence after its fix reopens it like any other.

- **The [delivery check](hooks.md#delivery-check) sends a subagent back.** Key `delivery-check:<agent type>`; P2, `bug`;
  target `plugin` for an `aidrian:` agent, `project` for any other.
  It stays quiet: it fires only when a file the agent said it wrote does not exist, once per stop.
- **One of the plugin's [blocking rules](hooks.md#recorded-blocks) blocks one session 3 times.** Key `hook-deny:<rule>`; P2, `gap`;
  target `project` for `agent-gates`, whose gates the project writes, `plugin` for any other.
  It stays quiet: one block is the rule doing its job; three in a session is an agent fighting it.
- **`aidrian pr await-review --request` stops at the round limit**, config.json `github.maxReviewRounds`.
  Key `review-rounds`; P2, `project`.
  It stays quiet: it fires once per pull request and round count, and a re-run at the same count adds nothing.

A row holds names, counts, paths, and ids, never a prompt, a command, or tool output; the `session` id finds the rest.
The block counts live in the system's temporary folder, one small file per session and rule, which grows a byte per block,
so subagents that block at the same time all count; the session-end hook deletes them.

Not recorded: the session-length reminder fires in most long sessions by design, and its numbers are already in the dispatch log.
Another producer, such as a script that reads `aidrian report`, can add its own signal with `aidrian lesson add --key <key>`.
The `harness-health` skill does that for the problems of [`aidrian report health`](dispatch-log.md#health) that the Human accepts:
a sent-back agent, a blocking rule, and review rounds take the keys above, so each is the same lesson seen again,
and the other problems take `health:<kind>`, followed by `:<agent or doc>` when the problem has one.
A problem whose key belongs to a resolved lesson is captured only when the rows dated after that resolution show it again,
so the failures that led to a fix never reopen it.
`"lessons": { "auto": false }` in config.json turns all three off.

## Rows from the first version

Rows written before events existed still read: the first row of an id adds the lesson, and a row with
`"status": "resolved"` resolves it, whether it is that same row or a later one.
Their `kind` of `harness`, `product`, or `process` is dropped, and their outcomes `duplicate` and `dropped` read as
`merged` and `rejected`.
