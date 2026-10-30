# The dispatch log

The dispatch log records which agents a session dispatched, what each cost, which knowledge docs it read,
whether it delivered the files it said it wrote, what each session cost, and which of the plugin's rules blocked a tool call.
`aidrian report` reads it, and `aidrian report health` judges what it read against thresholds.

It is `dispatch-log.jsonl` in the [state folder](project-folder.md#local-state): one JSON object per line,
on this machine only, shared by every worktree of the repository.
Three Claude Code hooks append the dispatch, stop, and session rows, and the plugin's blocking hooks append a `hook_deny` row,
only inside a project folder, and only while config.json `telemetry.enabled` is on:
[config.md](config.md#telemetry) has the switches.
A row holds names, counts, durations, costs, and file paths. It never holds a prompt, a command, or tool output.

## Rows

### `dispatch`: after each Agent tool call

| Field | Meaning |
| --- | --- |
| `ts`, `session_id` | When, and in which session. |
| `dispatcher` | The agent that dispatched: the subagent's type inside a subagent, else the session's `--agent`, else `main`. |
| `agent_id`, `agent_type`, `name` | The dispatched agent, as the host names it. `agent_type` is `general-purpose` when none was given. |
| `description` | The task label the dispatcher gave, cut to 80 characters. |
| `background`, `status` | Whether it runs in the background, and the tool's status, such as `completed` or `async_launched`. |
| `duration_ms`, `tool_uses` | Wall time and tool calls, as the host reports them. A background dispatch reports neither. |

### `stop`: when a subagent ends

| Field | Meaning |
| --- | --- |
| `ts`, `session_id`, `agent_id`, `agent_type` | Which subagent. `agent_id` joins it to its `dispatch` row. |
| `tokens` | `input`, `output`, `cache_read`, and `cache_write` over the requests the subagent made, counted once per API request. `cache_write` is `cache_write_5m` plus `cache_write_1h`, the cache writes kept 5 minutes and 1 hour, which cost 1.25x and 2x the input price. |
| `models`, `cost_usd` | The models it used, and the cost estimated from list prices (`lib/transcript.mjs`). |
| `requests`, `tool_requests`, `tool_calls` | Its API requests, the requests that made a tool call, and its tool calls, as on a `session` row's sides. |
| `docs_read` | The knowledge docs it opened with the Read tool, as `{ "path", "bytes" }`: the path the index gives, and the doc's size. `null` while `telemetry.docReads` is off. |
| `delivered` | `file` when every `.md` or `.json` path its last message presents as delivered exists, `missing` when one does not, `chat` when it presents none. |
| `paths` | Those paths, at most 20. |
| `sent_back` | `true` when the hook sent the subagent back at this stop, `false` when it let it end. A row written before the field has none. |

A forked subagent's transcript starts with a copy of its parent's requests, and those stay the parent's:
their tokens and Read calls count on the main conversation's `session` row, or on the `stop` row of the subagent
that the `.meta.json` beside the transcript names as `parentAgentId`. Each request counts once.

When `delivered` is `missing` and Claude Code marks the stop as a first one (`stop_hook_active: false`), the hook sends
the subagent back once: it is told which paths do not exist, and either writes them, corrects its report, or says it
removed them on purpose. Its second stop always ends, and writes a second `stop` row; the report counts the last one.
A stop that ends with `delivered: missing`, such as that second one, has `sent_back: false`.

### `session`: when a session ends

| Field | Meaning |
| --- | --- |
| `ts`, `session_id`, `agent`, `reason` | Which session, its `--agent` if any, and why it ended. |
| `duration_min` | From the first to the last transcript entry. |
| `effort`, `effort_varied` | The effort level Claude Code stamped on the main conversation's last request, `null` when none; `effort_varied` is `true` when its requests ran at more than one level. |
| `models`, `tokens_by_model`, `cost_usd`, `cost_by_model` | Tokens and estimated cost of the whole session, main conversation and subagents together, per model and in total. |
| `main`, `subagents` | The same split two ways: `tokens`, `cost_usd`, `requests` (API requests), `tool_requests` (those that made a tool call), and `tool_calls`. A request found in both transcripts counts as the main conversation's. |
| `subagent_count` | How many subagent transcripts the session has. |
| `docs_read` | The knowledge docs the main conversation opened, as on a `stop` row. Each subagent's reads are on its own `stop` row. |

A session whose transcript holds no API usage writes no row.
A resumed session that ends again writes another row over its whole transcript; the report counts the last one.

### `hook_deny`: when one of the plugin's rules blocks a tool call

The Bash rules, the main-checkout rule for writes, the [agent gates](hooks.md#agent-gates), and the config guard write one row
per block, while config.json `telemetry.hookDenies` is on. The call is still blocked when it is off.

| Field | Meaning |
| --- | --- |
| `ts`, `session_id` | When, and in which session. |
| `rule` | The rule's name: `git-hook-bypass`, `git-amend`, `process-kill`, `grep-exit-chain`, `pr-body`, `main-checkout`, `agent-gates`, or `config-guard`. |
| `tool` | The tool it blocked, such as `Bash`, `Edit`, or a tool an agent gate names. |
| `agent_type` | The agent that made the call, named as a `dispatch` row names its dispatcher: `main` for the main session. |
| `reason` | What the rule matched, at most 120 characters: the first sentence of its message, such as `this skips a git hook.`, or for a gate the gate itself, such as `agents.explorer.deny has "WebFetch"`. A parenthesized absolute path, such as the main checkout's folder, is left out. |

The row never holds the command. Its `reason` can name the file a write rule matched, as the message the agent reads does.

### `rotate`: when the log rotates

Once the log reaches config.json `telemetry.maxMb`, the next hook moves it to `dispatch-log.1.jsonl`, replacing the file there,
and starts a new log with this row. `aidrian report` reads `dispatch-log.1.jsonl` first, then the log.

| Field | Meaning |
| --- | --- |
| `ts`, `session_id` | When; `session_id` is `null`. |
| `dropped` | `true` when an older `dispatch-log.1.jsonl` was replaced, so rows before the oldest one left are gone. |

## The report

```console
$ aidrian report --since 7d
Dispatch log /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 7d
Explore: 12 dispatches, 8% re-dispatched, median 88s and 85k tokens, $3.08, delivered 2 file / 9 chat / 0 missing
  11 runs, $0.28 a run, 9% sent back by the delivery check, 1.40 tool calls per request that made one
  docs read: 1.5 docs and 13.0 KB a run; docs/knowledge/engineering/testing.md (11), docs/knowledge/engineering/code-style.md (5)
Sessions: 2, $42.10 estimated, main conversation and subagents together
Hook denies: 6 in 2 sessions
  git-amend: 4, by main 3, Explore 1; 1 session blocked 3 times or more, an automatic lesson
    most often: `git commit --amend` rewrites the branch tip, and another agent working on this branch may already have built on it.
  agent-gates: 1, by aidrian:explorer 1
    most often: agents.explorer.deny has "WebFetch"
  main-checkout: 1, by main 1
    most often: this writes 'src/app.js', a tracked file in the main checkout.
```

`aidrian report agents` is the same view.

- **re-dispatched**: the share of dispatches that repeat a task already dispatched in the same session,
  `1 - distinct (session, description) / dispatches`. A high rate means agents are sent back to redo work.
- **median time and tokens**: per dispatch, from the `dispatch` and `stop` rows.
- **cost**: the sum of the agent type's `stop` rows. The session total already includes it; do not add them.
- **delivered**: how the agents' reports turned out: files that exist, chat only, or a named file that did not exist.
- **runs**: the subagents of that type that stopped, and the cost of each on average.
- **sent back by the delivery check**: the share of runs with any `stop` row whose `sent_back` is `true`.
  A run that named a missing file before rows recorded `sent_back` is unknown: the share leaves it out, and a `Partial:` line counts it.
  `delivered` counts each run's last row, so a run that wrote the file on its second try shows there as `file`.
- **tool calls per request that made one**: as in [Sessions](#sessions), over the runs' own requests.
- **docs read**: how many knowledge docs a run opened, and their bytes, on average, then the five that agent type opened most.
  The averages leave out runs logged with doc reads off, and the bytes, runs logged before sizes.
- **Hook denies**: the `hook_deny` rows, per rule, most blocks first: the agents it blocked, the sessions it blocked
  3 times or more, which is when a block becomes an [automatic lesson](lessons.md#automatic-lessons),
  and the `reason` it logged most often. A rule an agent keeps hitting needs clearer words in that agent's instructions or in the rule's message.

`--since` takes `30m`, `24h`, `7d`, or a date such as `2026-10-01`; the default is `7d`.
`--json` prints the same summary as one JSON object, with `rotated`, the path of the rotated part or `null`, `coverage`,
and `hook_denies` with every rule's agents and up to three reasons.

### Sessions

`aidrian report sessions` shows what sessions cost, and where: the main conversation or its subagents, which models, which effort.

```console
$ aidrian report sessions --since 7d
Sessions, from /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 7d
3 sessions, $10.50 estimated; 1 ended more than once, counted at the last end
Main conversation: $8.00 (80%), 2.0M tokens, 1.20 tool calls per request that made one
Subagents: $2.00 (20%), 1.1M tokens, 1.50 tool calls per request that made one
Cache writes: 500k tokens; 1-hour 400k (80%) at 2x the input price, 5-minute 100k at 1.25x
Per day:
  2026-10-28  1 session         $8.00
  2026-10-29  2 sessions        $2.50
Per model:
  claude-opus-5-5        $8.50  2.4M tokens
  claude-sonnet-5-5      $1.50  700k tokens
Per effort (the main conversation at its last request):
  high    1 session         $8.00
  medium  1 session         $2.00
  -       1 session         $0.50
Most costly sessions, top 3:
      $8.00  2026-10-28 18:30  0b6f3c2e-41d7-4a8e-9c1f-6d2b7e5a9f10  orchestrator, high, 95 min; main $6.00, subagents $2.00
      $2.00  2026-10-29 10:00  5d1a9e07-8c3b-4f62-a1d4-2e9b6c0f7a35  medium, 20 min; main $2.00, subagents $0.00
      $0.50  2026-10-29 11:00  9c44e1b8-2f6a-4d09-b7e3-5a8c1d3e6f27
```

- **ended more than once**: a resumed session writes a row at each end; only its last row counts.
- **tool calls per request that made one**: 1.00 means every turn made one tool call at a time;
  a higher number means the agent batched independent calls into one turn, which saves a round trip each.
- **Cache writes**: a 1-hour write costs 2x the input price, a 5-minute write 1.25x. A large 1-hour share explains a cost that tokens alone do not.
- **Per effort**: `-` is a session whose main conversation recorded no level, such as one logged before the field existed.
- A session logged before the main and subagent split counts in the total, per day, and per effort; a `Partial:` line says how many.

`--since` works as above; `--json` prints the same summary. `--prs` belongs to the default view and to `reviews`.

### When the report is incomplete

Every view says so under its first line, and `--json` carries the same facts in `coverage`:

```console
$ aidrian report docs
Knowledge docs read, from /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 7d
Doc reads are off (telemetry.docReads is false): new rows do not record them.
Partial: 4 agent and session rows in the window were written with doc reads off.
Partial: the log starts at 2026-10-27T09:12:44.000Z; older rows were rotated out at telemetry.maxMb.
```

| Line | `coverage` field | When |
| --- | --- | --- |
| Telemetry is off | `enabled: false` | config.json or `.aidrian.local.json` sets `telemetry.enabled` to `false` now. |
| Doc reads are off | `doc_reads: false` | The same for `telemetry.docReads`. |
| Hook denies are off | `hook_denies: false` | The same for `telemetry.hookDenies`; only the default and health views say it. |
| Partial: rows written with doc reads off | `rows_without_doc_reads` | Agent and session rows in the window that hold `docs_read: null`. |
| Partial: runs named a missing file before stop rows recorded send-backs | `runs_without_send_back` | Agent runs in the window with a `stop` row whose `delivered` is `missing` and that has no `sent_back`; only the default and health views say it. |
| Partial: the log starts at | `rotated_out_before` | Rotation dropped rows, and the window starts before the oldest row left. |

The default view also says `Partial: N agent runs were logged before tool counts` when some `stop` rows have no tool counts:
its tool calls per request leave those runs out.
A time when telemetry was off leaves no rows at all, so no report can tell that it happened,
and blocks from before this plugin logged `hook_deny` rows are not in the log either.

### Reviews

`aidrian report reviews` reads the last 20 merged pull requests through `gh`, not the log, and shows how the review bot,
config.json `github.reviewer`, did on them. `gh` runs in the project's folder, so `--project` reads that project's repository.

```console
$ aidrian report reviews --prs 4
Review rounds by chatgpt-codex-connector[bot] on 3 of the last 4 merged pull requests: 33% clean on the first pass, 2.7 rounds on average, 1 needed 5 or more
Partial: 1 pull request had more than 100 reviews or comments in one review; the counts stop at 100.
Findings: 10 in 8 rounds, 1.3 a round; round 1 2, round 2 4, round 3 1, round 4+ 3
Late findings, from round 2 on: 8 (80%); 3 of 4 checked sat on a line already there at the first review (75%); not checked: 1 file-level, 1 on a deleted line, 1 after a rebase, 1 commit gone
Most rounds: #4 6, #1 2
```

- **Review rounds**: a round is one formal review by the bot. A pull request it answered with only its 👍 passed clean,
  in 0 rounds; one it never answered is left out.
- **Findings**: the top-level comments in the bot's reviews, per round. Replies are not findings.
- **Late findings**: the findings from round 2 on, and how many sat on a line that was already there when the bot first reviewed:
  it could have found them then. GitHub's compare of the first review's commit with the finding's commit decides:
  a line it does not add since was there. A finding is not checked when it is on the whole file or on a deleted line,
  when the branch was rebased or force-pushed between the two reviews, when gh cannot read the compare, or when the compare is too large.
- **Most rounds**: up to five pull requests, most rounds first.

`--prs N` sets how many merged pull requests to read. `--since` keeps those merged since then, at most N, and says so when N cut the list short;
without `--since` the view takes the last N, whatever their age. `--json` prints `rounds`, every pull request with its findings per round,
`null` where gh could not read them, and the totals. It needs `gh`, and makes one call per answered pull request and one per later commit
with a late finding.

`aidrian report --since 7d --prs N` keeps the form the view grew from: the default view, then the reviews of the last N merged pull requests.
Its `--since` applies to the log only, and its `--json` holds the reviews under `reviews`.

### Doc reads

`aidrian report docs` answers three questions about the knowledge docs in one view:
what the `always` docs cost every agent, which docs cost agents the most context, and which indexed docs nobody reads.

```console
$ aidrian report docs --since 30d
Knowledge docs read, from /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 30d
Always docs: 4710 of 16384 bytes, read by every session and subagent (engineering 4710, product 0)
89 reads of 6 docs, 1909.6 KB in all, by 4 readers: Explore, code-reviewer, main, planner
Most bytes read (reads × size), top 6:
     23 ×   53.4 KB = 1228.2 KB  docs/knowledge/engineering/booking-status.md  (Explore, code-reviewer)
      3 ×   96.0 KB =  288.0 KB  docs/knowledge/plans/sharing-v2-plan.md  (planner)
     32 ×    4.6 KB =  147.2 KB  docs/knowledge/engineering/working-agreement.md  (Explore, code-reviewer, main, planner)
     14 ×    9.8 KB =  137.2 KB  docs/knowledge/engineering/testing.md  (code-reviewer)
     14 ×    7.1 KB =   99.4 KB  docs/knowledge/engineering/code-style.md  (code-reviewer)
      3 ×    3.2 KB =    9.6 KB  docs/knowledge/product/product-rules.md  (planner)
Read by the most readers:
  4 of 4  docs/knowledge/engineering/working-agreement.md
  2 of 4  docs/knowledge/engineering/booking-status.md
Indexed docs never read since 30d, 2:
     12.3 KB  docs/knowledge/engineering/issue-tracker.md
      2.0 KB  docs/knowledge/product/sharing.md
```

- **Always docs**: the bytes of every bucket's `always` docs against config.json `knowledge.budgets.alwaysBytes`,
  the same numbers [`aidrian check`](config.md#knowledge-budgets) prints. It is the size on disk now, not from the log.
- **reads × size**: how many times a doc was read, its size, and the two multiplied: the context it took. The ten largest are listed.
- **readers**: the agent types that read the doc, and `main` for the main conversation.
  A subagent counts once, even when it was sent back; a session counts its main conversation once.
- **Read by the most readers**: up to five docs that more than one reader opened.
  A doc that every reader opens costs as much as an `always` doc, so keep it as short as one.
- `?` marks a doc whose reads were all logged before sizes were.
- **Indexed docs never read**: the docs the knowledge index lists that no agent or main conversation read in the window,
  in index order, at most 20. A tagged doc here is routed to and never opened; drop it from the index or fix its tags.
  The list is left out when no row in the window recorded doc reads.

`--since` works as above; `--json` prints every doc, not only the top ten, with the totals, `always`, and every unread doc in `never_read`.

### Health

`aidrian report health` puts the views above on one page and judges each signal against a threshold,
so that the `harness-health` skill can say what to fix first.
Its window is the last 30 days unless `--since` sets another, because each signal needs a sample.

```console
$ aidrian report health
Harness health, from /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 30d
Problems, worst first: 5
  1. 1 P1 lesson open: each blocked or lost work. Fix: lesson-triage.
  2. aidrian:explorer: 25% of 8 dispatches repeated a task already dispatched in the same session, over 20%. Fix: agent-prompt.
  3. The git-amend rule blocked 6 calls in 10 sessions, 5 or more: by main 6; most often: `git commit --amend` rewrites the branch tip. Fix: deny-rule.
  4. docs/knowledge/engineering/code-style.md takes 54% of the 206.6 KB of knowledge docs read, over 50%: 16 reads of 6.9 KB. Fix: split-doc.
  5. 5 tagged docs never read in 26 rows with doc reads: docs/knowledge/engineering/issue-tracker.md, docs/knowledge/engineering/branches-and-reviews.md, docs/knowledge/engineering/docs-ownership.md, and 2 more. Fix: split-doc.
Signals; n is the sample, and a signal under 5 (telemetry.health.minSample) is not judged:
  Knowledge budget: ok; always docs 479 of 16384 bytes, 0 of 8 indexed docs tagged and over 24576 bytes
  Doc reads: problem (n=26 rows); most bytes read: docs/knowledge/engineering/code-style.md 54%, docs/knowledge/engineering/testing.md 46% of 206.6 KB (over 50% is a problem); 6 indexed docs never read, 5 of them tagged
  Agents: problem (thresholds: 20% re-dispatched, 10% sent back)
    aidrian:code-reviewer: 0% re-dispatched (n=6), 0% sent back (n=6)
    aidrian:explorer: 25% re-dispatched (n=8), 0% sent back (n=8)
    aidrian:planning-agent: re-dispatched not enough data (n=2, needs 5), sent back not enough data (n=2, needs 5)
  Reviews: not enough data; rounds not enough data (n=0, needs 5 reviewed); late findings not enough data (n=0, needs 5 checked)
  Hook denies: problem (n=10 sessions); 6 blocks: git-amend 6 (5 or more by one rule is a hot spot)
  Session cost: ok (n=5 sessions a half); 10 sessions, $22.50; $2.50 a session in the newer half against $2.00, up 25% (threshold 50%)
  Lessons: problem; 2 open, 1 P1, the oldest 6 days; 0 fixes in the window, 0 recurred
```

Each signal names its sample and is judged by config.json [`telemetry.health`](config.md#health-thresholds), the knowledge budgets, and the lesson limits:

| Signal | Sample | A problem when | Fix |
| --- | --- | --- | --- |
| Knowledge budget | the indexed docs | the `always` docs pass `knowledge.budgets.alwaysBytes`, or a tagged doc passes `taggedDocBytes` | `split-doc` |
| Doc reads | the agent and session rows that recorded doc reads | the doc with the most bytes read takes over `topDocPercent` of them, of two docs read or more; or a tagged doc nobody read | `split-doc` |
| Agents | per agent type, its dispatches, and its runs with a known send-back | over `redispatchPercent` of its dispatches repeat a task; over `sentBackPercent` of those runs were sent back by the delivery check | `agent-prompt` |
| Reviews | the reviewed pull requests merged in the window, and the late findings checked | over `reviewRounds` rounds a pull request on average; over `lateFindingPercent` of late findings on a line already reviewed | `round-cap` |
| Hook denies | the sessions with a row in the window | one rule blocked `denyHotSpot` calls or more | `deny-rule` |
| Session cost | the sessions in each half of the window's sessions, in the order they ended | the newer half costs over `costRisePercent` more a session than the older half | `cost` |
| Lessons | the open lessons | a P1 is open, a fix resolved in the window recurred, or the inbox passes `lessons.maxOpen` or `lessons.maxAgeDays` | `lesson-triage` |

- **not enough data**: the sample is under `telemetry.health.minSample`. Such a signal is never a problem, whatever its rate:
  3 of 4 is not a trend. The knowledge budget and the lessons are sizes and counts, not rates, so no minimum applies;
  the budget says not enough data only when nothing is indexed.
- **unknown**: a run that named a missing file before `stop` rows recorded `sent_back`. The share sent back and its sample leave it out,
  the agent's line counts it as `N unknown`, and a `Partial:` line under the title counts them all.
- **unavailable**: the reviews when `gh` cannot answer, and the hook denies while `telemetry.hookDenies` is off.
- **Problems** are ranked by kind: a P1 lesson; the knowledge budget; an agent re-dispatched, then sent back;
  review rounds, then late findings; a hook-deny hot spot; a fix that recurred; rising cost; the doc with the most bytes read;
  tagged docs nobody read; the lesson backlog. Within a kind, the one furthest over its threshold comes first.
- **Fix** names a row of the `harness-health` skill's fix table, which says what to do and who does it. A test holds the two lists equal.

`--prs N` reads at most N pull requests merged in the window, 20 by default, through `gh` as the reviews view does.
`--json` prints `problems`, each with `kind`, `fix`, `subject` (the agent, doc, or rule, or `null`), `value`, `threshold`,
`sample` (`n` and what it counts), `summary`, and `lesson` (the `tier`, `kind`, `target`, and `key` for `aidrian lesson add`,
or `null` when the problem is a lesson already); `signals`, every signal with its `status` (`ok`, `problem`, `not_enough_data`,
or `unavailable`) and its numbers; `thresholds`; and `coverage`, as the other views print it.

## Limits

- **Claude Code only**, except `hook_deny` rows. Codex has no Agent tool, and its stop and session payloads are not verified.
  The hooks let any payload they cannot read pass: a transcript with no Claude Code usage writes no `session` row,
  and a stop payload without `stop_hook_active` is never sent back.
  The Bash rules and the agent gates also run in Codex, so its blocks write `hook_deny` rows there too.
- **Only the plugin's own blocks.** A block by Claude Code's permissions, or by another plugin's or the project's hook, writes no row.
- **Costs are estimates** from list prices, read on the date in `lib/transcript.mjs`. A model missing from the price
  map counts as zero.
- **A background dispatch** writes its `dispatch` row at launch, without time or tool counts; its `stop` row has the rest.
  The report counts `stop` rows with no `dispatch` row, so a host change that breaks the join is visible.
- **The delivery check reads the last message only, line by line.** It cannot know a path the dispatcher expected but
  the agent never named, and it reads a path mentioned on the same line as a delivery word as a claim.
  [hooks.md](hooks.md#delivery-check) has the rule.
- **`bytes` is the whole doc**, measured when the row is written, even when the agent read only part of it.
  It is the size of the copy the agent read, or of the project's copy once that one is gone, as with a removed worktree.
  Rows written before sizes were logged hold bare paths, of unknown size.
- **Doc reads come from transcripts.** The stop and session hooks take the paths from the agent's transcript when it ends;
  no hook runs on each Read. A doc an agent opens several times counts once for that agent.
- **No "read, not cited" count.** Agents follow a doc without naming it, and a handoff that lists `loaded_docs` names
  every doc it read, so whether the last message names a doc says nothing about whether the doc was used.
- **One lock, for rotation only.** Rows from concurrent processes never interleave, because each is one append.
  Only rotation renames the log, one process at a time, while it holds `dispatch-log.jsonl.lock`; nothing rewrites a row.
