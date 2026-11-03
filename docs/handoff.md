# Handoff

A long session pays for its whole context on every model call. A fresh session started from a handoff brief pays for
much less, once it has read the brief and rebuilt its cache. The plugin weighs the two, tells the agent when continuing
costs more, and lets it hand off, ask, or carry on. This page is the feature in one place.

- The [session-length reminder](#the-reminder): the Stop hook, at the end of a main-session turn.
- The [plan handoff offer](#the-plan-offer): when the Human approves a plan.
- The [cost model](#the-cost-model) both use, with its measured constants.
- The [config](#config): `session.handoff` in config.json.
- The [skills](#the-skills) that write and read the brief: `session-handoff` and `session-continue`.

Both hooks run in Claude Code's main session only, and read its transcript. A subagent, another host, or a transcript
with no Claude Code usage gets nothing. [hooks.md](hooks.md#session-length) lists them with the other hooks.

## The reminder

When the main session ends a turn, the Stop hook reads its transcript and computes the cost ratio `r`:
how many times more each call costs here than it would in a fresh session.
Once `r` reaches the next step, the hook sends the agent back for one more turn, with `r` and an estimate of `N`,
the calls the work left must take before a handoff pays back, such as:

> each call costs 2.1 times what it would in a fresh session started from a handoff brief, and a handoff pays back
> after about 54 more model calls, an estimate

The agent judges first whether a handoff is worth it. It is not when the task is done or nearly done, or the work left
takes fewer calls than `N`; when a subagent or background job is still running and reports back to this session;
or when the Human already said to finish here or that they are not watching, since a fresh session needs someone to
start it. Then the agent ends the turn without a word about it. Otherwise it acts as `session.handoff.mode` says:

| `mode` | What happens |
| --- | --- |
| `ask` (default) | The agent ends the turn with one question: hand off now, or keep going? Hand off runs the `session-handoff` skill. |
| `auto` | The agent writes the brief with the `session-handoff` skill and tells the Human its path. |
| `off` | Nothing; neither hook sends the agent anything. |

**Steps.** The first step is `costRatio`, 2 by default, and each step after it adds `costRatio − 1`:
2, 3, 4 by default, or 1.5, 2, 2.5 at a `costRatio` of 1.5. So neither a "keep going" nor a quiet skip turns the
reminder off for the rest of the session; it comes back once the next step is reached.
The steps scale with the session's own baseline: with a 30,000-token baseline the first fires near 148,000 tokens of
context, with a 60,000-token baseline near 208,000.

**Token ceiling.** `maxTokens`, off by default, is a ceiling on the context, for the quality of the answers rather than
their cost. It fires on its own, whatever `r` is, at `maxTokens` and then at each doubling of it:
`maxTokens × 2^n` after `n` firings. Its message names the context only, with no `r` or `N`.

**Re-arming.** A marker in the system's temporary folder, `aidrian-session-length-<session id>`, holds
`{"ratio": n, "tokens": n, "compactions": n}`: how often each trigger fired, and the compactions seen.
A firing raises only the count of the trigger that fired, past every step the session already reached,
so a jump of two steps in one turn is not reminded again at the next.
A marker an older version wrote, a mode word or one count, counts as one firing of each. The `SessionEnd` hook deletes the marker; a new session starts fresh.

**Compaction.** A compaction writes a `compact_boundary` entry into the same transcript, under the same session id.
When the transcript holds more of them than the marker's `compactions`, both counts reset to 0 first,
so a compacted session is reminded again from the first step.

## The plan offer

When the Human approves a plan (Claude Code's `ExitPlanMode`), the plan is on disk and nothing is running,
so a handoff costs least at that moment. Another hook tells the agent to offer the handoff before its first build step
once `r ≥ 1 + (costRatio − 1) / 2`, 1.5 by default, or once the context reaches half of `maxTokens` when it is set.
`ask` asks "hand off now, or build here?", and `auto` writes the brief. Either skips the offer when a few calls finish
the build, or when the Human said to finish here or is not watching. The offer keeps no marker.

## The cost model

All costs are in input tokens of the model of the session's last main-session call.

| Symbol | What it is |
| --- | --- |
| `C` | The context of the last main-session call: input, cache read, and cache write together. |
| `W` | The context of the first main-session call: the system prompt, tools, and project instructions a fresh session reads too. |
| `B` | What a fresh session reads to resume, 44,000 tokens. |
| `H` | The calls the long session spends writing the brief, 8. |
| `m` | The model's cache-read multiple of its input price, from `priceFor` in `lib/transcript.mjs`; 0.1 when the model sets none or is unknown. |
| `k` | The cache-write multiple: 2 when the session writes 1-hour cache, else 1.25 for 5-minute cache. |

- Cost ratio `r = C / (W + B)`. The multiples cancel out, so `r` does not depend on the model.
- Handoff cost: `k × (W + B)` to build the fresh session's cache, `5 × 3,000` for the brief's output,
  and `H × m × C` for the calls that write the brief, which run only on the handoff path.
- Break-even calls `N = handoff cost / (m × (C − W − B))`, defined only when `C > W + B`.
  A transcript with no usage, or with `C ≤ W + B`, never fires the cost trigger.

Output tokens and subagent calls cost the same either way, so the model leaves them out.
`N` is an estimate: `B` and `H` are medians over many sessions, not this session's numbers.

**Where the constants come from.** They were measured over one machine's Claude Code transcripts:
405 sessions that ran `session-handoff`, and 105 that began with `session-continue`.

- `B`: a fresh session's context grew by a median of 43,985 tokens before its first edit or dispatch,
  quartiles 30,542 and 82,407.
- `H`: a median of 9 main-session calls from the `session-handoff` skill call to the end of the session,
  quartiles 7 and 47; the top quartile kept working after the brief.

## Config

```json
"session": {
  "handoff": { "mode": "ask", "costRatio": 2, "maxTokens": 0 }
}
```

| Key | Meaning |
| --- | --- |
| `session.handoff.mode` | `"ask"`, `"auto"`, or `"off"`: what the reminder and the plan offer do. |
| `session.handoff.costRatio` | The cost ratio of the first step, a number of 1.1 or more; each later step adds `costRatio − 1`. |
| `session.handoff.maxTokens` | A ceiling on the context, in tokens, that fires on its own and doubles; `0`, the default, is off. |

Most projects set only `mode`. A config written before these settings became a group still loads, with an error from
`aidrian check` and every `aidrian` command:

| Old key | Now |
| --- | --- |
| `"session": { "handoff": "off" }`, or `"ask"`, `"auto"` | `session.handoff.mode`; the hooks keep honouring the mode until it moves. |
| `session.maxTokens` | `session.handoff.maxTokens`, now off by default; the old value is not carried. |
| `session.maxCalls`, `session.maxHours` | Gone: neither measures cost. Delete them. |

A project that adopts the group sets `requires.aidrian` to the release that ships it ([Plugin version](config.md#plugin-version)).

## The skills

- `session-handoff` writes the brief into `<state>/handoffs/`, where `<state>` is the folder `aidrian state` prints.
  It writes one only when the Human allowed it: the Human asks, a run's `--handoff` flag asks, or `mode` is `"auto"`.
- `session-continue`, the first step of the fresh session, reads the newest brief in full, enters its worktree,
  reads the state fresh, and continues at its next steps.
