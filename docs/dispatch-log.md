# The dispatch log

The dispatch log records which agents a session dispatched, what each cost, which knowledge docs it read,
and whether it delivered the files it said it wrote. `aidrian report` reads it.

It is `dispatch-log.jsonl` in the [state folder](project-folder.md#local-state): one JSON object per line,
on this machine only, shared by every worktree of the repository.
Three Claude Code hooks append to it, and only inside a project folder.
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
| `tokens` | `input`, `output`, `cache_read`, and `cache_write` over the subagent's transcript, counted once per API request. |
| `models`, `cost_usd` | The models it used, and the cost estimated from list prices (`lib/transcript.mjs`). |
| `docs_read` | The knowledge docs it opened with the Read tool, as `{ "path", "bytes" }`: the path the index gives, and the doc's size. |
| `delivered` | `file` when every `.md` or `.json` path its last message presents as delivered exists, `missing` when one does not, `chat` when it presents none. |
| `paths` | Those paths, at most 20. |

When `delivered` is `missing`, the hook sends the subagent back once:
it is told which paths do not exist, and either writes them, corrects its report, or says it removed them on purpose.
Its second stop always ends, and writes a second `stop` row; the report counts the last one.

### `session`: when a session ends

| Field | Meaning |
| --- | --- |
| `ts`, `session_id`, `agent`, `reason` | Which session, its `--agent` if any, and why it ended. |
| `duration_min` | From the first to the last transcript entry. |
| `models`, `tokens_by_model`, `cost_usd` | Tokens per model and the estimated cost of the whole session: main conversation and subagents together. |
| `subagent_count` | How many subagent transcripts the session has. |
| `docs_read` | The knowledge docs the main conversation opened, as on a `stop` row. Each subagent's reads are on its own `stop` row. |

A session whose transcript holds no API usage writes no row.

## The report

```console
$ aidrian report --since 7d
Dispatch log /home/you/.local/state/aidrian/projects/notes-1a2b3c4d/dispatch-log.jsonl, since 7d
Explore: 12 dispatches, 8% re-dispatched, median 95s and 85k tokens, $3.10, delivered 2 file / 10 chat / 0 missing
  docs read: docs/knowledge/engineering/testing.md (4), docs/knowledge/engineering/code-style.md (2)
Sessions: 5, $42.10 estimated, main conversation and subagents together
```

- **re-dispatched**: the share of dispatches that repeat a task already dispatched in the same session,
  `1 - distinct (session, description) / dispatches`. A high rate means agents are sent back to redo work.
- **median time and tokens**: per dispatch, from the `dispatch` and `stop` rows.
- **cost**: the sum of the agent type's `stop` rows. The session total already includes it; do not add them.
- **delivered**: how the agents' reports turned out: files that exist, chat only, or a named file that did not exist.
- **docs read**: the five knowledge docs that agent type opened most.

`--since` takes `30m`, `24h`, `7d`, or a date such as `2026-10-01`; the default is `7d`.
`--json` prints the same summary as one JSON object.
`--prs N` adds the review rounds of the last N merged pull requests: how many formal reviews config.json `github.reviewer`
left on each, the share that passed clean on the first look, and how many needed five or more. It needs `gh`.

## Limits

- **Claude Code only.** Codex has no Agent tool, and its stop and session payloads are not verified.
  The hooks let any payload they cannot read pass: a transcript with no Claude Code usage writes no `session` row,
  and a stop payload without `stop_hook_active` is never sent back.
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
- **No lock.** Rows from concurrent processes never interleave, because each is one append; nothing ever rewrites the file.
