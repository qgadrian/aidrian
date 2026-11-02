# Lessons

The lesson inbox turns what goes wrong in sessions into fixes.
An agent captures a lesson with one command and goes back to its task.
Later, a session opened for the `lesson-triage` skill routes each lesson to one end: a fix, an issue, a merge, or a rejection.
A lesson that comes back after its fix reopens, so a fix that did not hold is visible.

## The inbox

The inbox is `lessons/inbox.jsonl` in the [state folder](project-folder.md#local-state): on this machine only,
shared by every worktree and clone of the repository. `aidrian lesson` is the only thing that reads or writes it.

### The plugin's inbox

A lesson with `target: plugin` is the plugin's to fix, so it goes to the plugin's inbox, not the project's:
the inbox of the plugin's own repository on this machine, `projects/<id>/lessons/inbox.jsonl` in the state root,
where `<id>` is the [project id](project-folder.md#local-state) of the `repository` that the plugin's `plugin.json` names.
A checkout of that repository has the same id, so its `aidrian lesson list` holds the plugin lessons of every project,
and the `lesson-triage` skill run there sees them all. Every row in it names the project it came from in `project`.

This holds for every way a lesson is written: `aidrian lesson add --target plugin`, `--same` and `--key` on a plugin lesson,
and the [automatic lessons](#automatic-lessons) whose target is `plugin`. The similar lessons that `add` names match against
the inbox the lesson lands in. `--same <id>` finds the lesson in the project's inbox first, then in the plugin's, and
records it there. `--key <key>` looks in the project's inbox first too, and in the plugin's only for a plugin lesson:
with `--target plugin`, or with no target when the lesson there that holds the key has `target: plugin`.
So a plugin key is one lesson across projects, and a project key never leaves the project's inbox.
A lesson whose target is unset or `project` stays in the project's own inbox.
The plugin's inbox is always in the state root: a `state.dir` in the plugin repository's config.json does not move it.

The file is only ever appended to. Each row is one event on one lesson, and the command replays them in order:

| `event` | Written by | What it does |
| --- | --- | --- |
| `add` | `aidrian lesson add` | Starts a lesson. A row whose `key` an earlier lesson holds is that lesson seen again instead. |
| `seen` | `aidrian lesson add --same <id>` | Records the lesson once more, with an optional note and evidence. |
| `update` | `aidrian lesson update` | Changes the tier, kind, or target, or records the lesson's triage. |
| `resolve` | `aidrian lesson resolve` | Closes the lesson with an outcome and a link. |
| `move` | `aidrian lesson update --target`, `aidrian lesson migrate` | Takes the lesson out of this inbox, after its rows were copied to another. |

A row is one append, so rows from concurrent sessions never interleave, and nothing rewrites the file.
A move reads the inbox, copies the lesson's rows, then writes its `move` row, so it holds the lock of both inboxes
from that read to its last row. Every writer that acts on what it read, `add`, `resolve`, `update`, and the automatic
signals, holds the lock of the inboxes it reads from that read to its append, so a row for a moving lesson lands before
the move reads it, and goes with it, or after, where its writer finds the lesson in its new inbox.
`update --target` takes the lock of the inbox the lesson moves to before it writes its `update` row, so a destination
it cannot lock leaves nothing written.
A command waits up to 5 seconds for a lock; then it fails with `is locked by another process`, naming the pid and the
lock file, and writes nothing. An automatic signal never waits, because hooks record it inside the host's hook timeout:
while another process holds the lock, it records nothing, and for a repeated block the next block tries again.

The lock is a numbered file beside the inbox, `inbox.jsonl.lock.<n>`, holding the holder's pid and host; the highest
number is the lock, and `inbox.jsonl.lock.<n>.released` marks it free. A process takes it by creating the next number,
which only one process can create, when the highest is released or abandoned. A lock held from this host is abandoned
only when its pid no longer runs: a live holder keeps it however long it runs. One held from another host, or naming no
pid, is abandoned after 10 minutes. No process deletes a lock it did not supersede, so two never hold it at once.
An inbox is locked, and compared with another, by its real path, so a `state.dir` that reaches an inbox through a
symlink is that inbox: one lock, and no move onto itself. Once the lock is idle, its last two files stay. A process that reuses the pid of a holder that died keeps that lock
held; when no aidrian command is running, delete the lock files.
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
| `project` | In the plugin's inbox, the project id it came from, such as `notes-1a2b3c4d`. `list` shows it as `from <project>`. |
| `seen`, `occurrences` | How many times it happened, and the later times with their notes. `--json` shows the last five. |
| `status`, `outcome`, `link`, `expect` | `open` or `resolved`; how it ended, where to, and for a fix, what number should move. |
| `reopened`, `resolutions` | How many times a fix did not hold, and every resolution with the occurrences that came after it. |
| `merged`, `mergedInto` | The lessons merged into this one, or the one this one was merged into. |
| `triage` | What triage found, from `update --triage -`: `existing`, `proposed_end`, `owner`, `expect`, `verdict`, `reason`, and the `at`, `project`, and `target` the command stamps. `--json` shows it for 14 days, and only in the project that wrote it; `null` otherwise. A resolution, a new target, or an occurrence after its `at` clears it, including a lesson merged in, or its occurrences, from after that time. |

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
Leading `evidence:` lines are evidence, and a leading `title:` line is the title, for a note whose first line is not one;
the note is the rest.

- `add` prints the lesson's id. When other lessons look like the same problem, it names up to three and the command that
  merges the new one into one of them. It compares words, weighting the ones that are rare in the inbox.
- `add --same <id>` records a known lesson again. `--key <key>` does the same for any row with that key, so a script can
  report one problem many times and keep one lesson. A key no lesson holds yet starts one where `--target` sends it.
- `list` shows the project's open lessons in triage order: tier, then age. `--status resolved|all`, `--tier`, `--kind`,
  `--source`, and `--limit N` narrow it; `--target project` too, and `--target plugin` reads the plugin's inbox instead.
  `list <id>` shows one lesson in full. `--json` adds `similar`, the ids of up to three lessons that look like the same problem.
  A lesson read from the plugin's inbox shows `from <project>`, the project it came from.
- `resolve <id> --outcome <outcome> --link <ref>` closes a lesson; `--link -` reads the link from stdin.
  `--expect '<what should move, and the command that reads it>'` records how to check a fix later.
- `update <id> --tier P1` changes the tier, kind, or target, such as when triage disagrees with the capture.
  A new target moves the lesson, whole: `plugin` to the plugin's inbox, and `project` out of it, back to the inbox of the
  project it came from. Run that one from the project's checkout, or with `--project <dir>`: from anywhere else, the lesson
  goes to that project's folder in the state root, which a `state.dir` in its config.json moves away from.
  A new tier or kind alone moves nothing.
- `update <id> --triage -` keeps what triage found on the lesson, so a later triage reuses it instead of searching again.
  It reads one JSON object on stdin with these keys. Three are required: `existing` (the docs, issues, or pull requests
  that already cover it), `proposed_end` (`Fix now`, `Issue`, `Merge`, or `Reject`), and `owner`. `expect`, `verdict`
  (`declined`, `failed`, or `null`), and `reason` are `null` when left out. The command adds `at`, `project`, and the lesson's
  current `target`, over any the record carries, so a record resent from `list --json` passes; any other key fails.
  It takes no `--tier`, `--kind`, or `--target`, and each write replaces the record whole.
  `list --json` and `update --json` show the record for 14 days after its `at`, and only in the checkout of the project
  that wrote it; otherwise `triage` is `null`, and triage reads the lesson afresh.
- `stats` counts what is open, what moved in the last `--since 30d`, and whether each fix since then held.
- `nudge` prints the session-start line.
- `migrate` moves every plugin lesson that an earlier version left in a project's inbox to the plugin's inbox:
  from each project folder in the state root, and from this project's inbox wherever `state.dir` puts it.
  It keeps each lesson's id, occurrences, evidence, status, and the lessons merged into it, and writes `project` on the copies.
  It never touches a lesson whose target is `project` or unset. A second run moves nothing; `--dry-run` only prints the list.
  A run cut short and run again copies no row twice, and finishes each lesson it had started copying, whole.
  A moved lesson whose key a lesson in the plugin's inbox already holds joins that lesson, and the output says so:
  only its occurrences move, its `add` and `seen` rows and those of the lessons merged into it, and its ids find the holder.
  Its own updates and resolutions are dropped from the record: nothing lists them after the move, and the holder keeps
  its tier, kind, target, and status. An occurrence dated after the holder's fix reopens it, as any occurrence does.
  Run `migrate --dry-run` first to read which lessons join which. A joining lesson's resolution never moves,
  even one written just before the move: when it matters, record it on the holder after the move with `aidrian lesson resolve`.
  Upgrade the plugin on every host of the machine before you run it: an older copy reads no `move` row, so it still lists the
  moved lessons in the project's inbox, and it files new plugin lessons there; run `migrate` again after one did.

`resolve`, `update`, `list <id>`, and `add --same` look an id up in the project's inbox, then in the plugin's.
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

A signal with target `plugin` lands in the [plugin's inbox](#the-plugins-inbox).

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
The block counts live in the system's temporary folder, in one folder per session with a small file per rule, which grows
a byte per block, so subagents that block at the same time all count; the session-end hook deletes the session's folder.

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
