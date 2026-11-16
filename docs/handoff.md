# Handoff

A long session pays for its whole context on every model call. A fresh session started from a handoff brief pays for
much less, once it has read the brief and rebuilt its cache. The plugin weighs the two, tells the agent when continuing
costs more, and lets it hand off, ask, or carry on. This page is the feature in one place.

- The [session-length reminder](#the-reminder): the Stop hook, at the end of a main-session turn.
- The [plan handoff offer](#the-plan-offer): when the Human approves a plan.
- The [continuation](#continue): how the session goes on once the brief is written.
- The [cost model](#the-cost-model) both use, with its measured constants.
- The [config](#config): `session.handoff` in config.json.
- The [skills](#the-skills) that write and read the brief: `session-handoff` and `session-continue`.

Both hooks run in Claude Code's main session only, and read its transcript. A subagent, another host, or a transcript
with no Claude Code usage gets nothing. [hooks.md](hooks.md#session-length) lists them with the other hooks.
On a stop where the [announce check](hooks.md#announced-work) sends the agent back, the reminder waits for the next stop.

## The reminder

When the main session ends a turn, the Stop hook reads its transcript and computes the cost ratio `r`:
how many times more each call costs here than it would in a fresh session.
Once `r` reaches `costRatio`, and again each time it doubles since the last firing, the hook sends the agent back
for one more turn, with `r` and an estimate of `N`, the calls the work left must take before a handoff pays back, such as:

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

With the [clear route](#the-clear-route), `auto` runs the skill, whose continue step arms the continuation and prints
the line for the Human; the agent says that line and ends the turn. `ask` adds to its question what a handoff then
takes from the Human, in the host's words, such as typing the clear command and then any message.
The reasons a handoff is not worth it stay the same.

**Once, then at double.** The first firing is at `costRatio`, 2 by default. The reminder comes back only once `r`
reaches twice the ratio at its last firing: 2, 4, 8 by default, or 1.5, 3, 6 at a `costRatio` of 1.5, and a first
firing at 2.5 comes back at 5. It never comes back below `costRatio`, so a `costRatio` raised mid-session holds
even where twice the last firing is lower. So neither a "keep going" nor a quiet skip turns the reminder off for the rest of the
session, and a session that keeps going is nudged a few times at most.
The thresholds scale with the session's own baseline: with a 30,000-token baseline the first fires near 148,000 tokens of
context, with a 60,000-token baseline near 208,000.

**Token ceiling.** `maxTokens`, off by default, is a ceiling on the context, for the quality of the answers rather than
their cost. It fires on its own, whatever `r` is, at `maxTokens` and then at each doubling of it:
`maxTokens × 2^n` after `n` firings. Its message names the context only, with no `r` or `N`.

**Re-arming.** A marker in the system's temporary folder, `aidrian-session-length-<session id>`, holds
`{"lastRatio": r, "tokens": n, "compactions": n}`: the cost ratio at the last cost firing (0 for none), how often the
ceiling fired, and the compactions seen. A firing changes only what its own trigger holds: a cost firing records its
ratio, and a ceiling firing raises its count past every doubling the context already reached, so a jump of two
doublings in one turn is not reminded again at the next.
A marker older versions wrote reads as follows. A mode word or one count is one firing of each trigger, the cost one
at `costRatio`, at the session's current compactions. A marker from v0.28.0 to v0.47.0,
`{"ratio": n, "tokens": n, "compactions": n}`, keeps its own `tokens` and `compactions`; a `ratio` above 0 is a cost
firing at `costRatio`, and a `ratio` of 0 is none.
The `SessionEnd` hook deletes the marker; a new session starts fresh.

**Compaction.** A compaction writes a `compact_boundary` entry into the same transcript, under the same session id.
When the transcript holds more of them than the marker's `compactions`, both triggers reset first,
so a compacted session is reminded again once `r` climbs back to `costRatio`.

## The plan offer

When the Human approves a plan (Claude Code's `ExitPlanMode`), the plan is on disk and nothing is running,
so a handoff costs least at that moment. Another hook tells the agent to offer the handoff before its first build step
once `r ≥ 1 + (costRatio − 1) / 2`, 1.5 by default, or once the context reaches half of `maxTokens` when it is set.
`ask` asks "hand off now, or build here?", and `auto` writes the brief. Either skips the offer when a few calls finish
the build, or when the Human said to finish here or is not watching. The offer keeps no marker.
With the clear route, `auto` sets up the continuation and ends the turn, so the build starts in the session the clear
begins, never here; `ask` names what a handoff takes from the Human, as the reminder does.

## Continue

`session.handoff.continue` says how the session goes on once its brief is written. It is independent of `mode`,
and the two give a ladder:

| Step | Config | What happens |
| --- | --- | --- |
| No handoff | `mode: "off"` | Nothing. |
| Warn only | `mode: "ask"`, `continue: "none"` | The agent asks; on a yes it writes the brief and prints the resume line. |
| Brief, no new session | `mode: "auto"`, `continue: "none"` | The agent writes the brief unasked and prints the resume line. |
| Brief, then a clear | `mode: "auto"` or `"ask"`, `continue: "clear"` | The brief, then the Human types the clear command and one message, and the new session resumes from the brief with nothing else typed. |

The schema takes `"compact"` and `"background"` too, the routes where nothing is typed, but no host lists them yet:
until their release, either falls back to `"none"`, and the gate says so in its `fallback:` line.
A route the host does not list falls back the same way. Which host does which route:

| Route | Host |
| --- | --- |
| `clear` | Claude Code: verified on 2.1.325: [Handoff continuation](providers/claude-code.md#handoff-continuation) |
| any | Codex: none, so every route falls back to `"none"` |

### The route the host runs

`aidrian handoff route [--route <route>]` prints `route: <route>`, the route a handoff would go on by here, as the gate
decides it from `--route` or `session.handoff.continue` and the host's routes. A route the host does not run prints
`route: none` and the `fallback:` line, as with `"compact"` on Claude Code in this release or any route on Codex.
It reads the config and nothing else, writes nothing, and exits 2 on an unknown `--route` or a config with errors.
The `session-handoff` skill runs it in its first step, so it settles every running agent only when a continuation can
follow. The gate may still fall back for what only the brief or the store tells, such as the brief's chain.

### The gate

The `session-handoff` skill's continue step runs `aidrian handoff continue <brief> [--route <route>]` after
`aidrian handoff check` passed, in the turn that hands off. `--route` is the Human's choice for this brief, the skill's
`--continue`; without it the command reads `session.handoff.continue`. `--route` may pick `none`, `clear`, or `compact`
whatever the config says, and `background` only when the config says `"background"`, else it falls back. In order:

1. Exit 2: usage, an unknown `--route`, a config with errors, or a brief the store does not hold. The brief must be,
   by its real path, a regular file right inside `<state>/handoffs/`, no symlink, named `<UTC date>-<slug>.md`, and
   under 256 KB. A disk that refuses the marker's write exits 2 too.
2. `none` prints `continue: none` and exits 0.
3. A fallback prints `continue: none` and one `fallback:` line, exit 0: the host does not list the route, or tells the
   command no session id; the slug is not letters, digits, dots, dashes, and underscores, up to 100; the path holds a
   control character; the store resolves inside a checkout of the repository, as with `state.dir` set to a folder in
   it; the state, handoffs, or store folder is owned by another user or writable by every user, where the system has
   user ids (not on Windows, where Node reports every writable folder as writable by others); or the brief's chain
   is `maxChain` or more.
4. A refusal exits 1 with the reason and the remedy on stderr, since the session can fix it: no passing check of the
   brief's current bytes (run `aidrian handoff check` first), a brief last written more than 15 minutes ago or dated in
   the future (refresh it), or a `Chain` below the floor this session was given (set it, and check again).
5. Otherwise it arms the continuation and prints `continue: <route>` and one `say:` line, the words the skill tells the
   Human: what the route takes from them, the brief's path, and how to resume by hand when no banner names the slug.

The latest run decides: once the brief resolves and the session is known, any continuation the session armed before is
gone, whatever the exit, so a clear never delivers an earlier brief.
The pass is a stamp the check writes when it exits 0 on a brief inside `<state>/handoffs/`, with the sha256 of its bytes:
an edit after the check needs a new check. The 15 minutes fit a check and fix round in the turn that wrote the brief.
Only the main session runs the gate: the [agent gates](hooks.md#agent-gates) hook refuses it to a subagent, whose shell
carries the main session's id, and keeps a subagent from writing in the store, with or without gates set.

The store is `<state>/handoffs/.continue/` ([project-folder.md](project-folder.md#local-state)), shared by every
worktree and clone of the project. Every write is a temporary file and a rename. Every read refuses a symlink, a marker
or a brief another user owns, a marker of the wrong shape, and a time outside its window, in the past or the future.
A store whose state, handoffs, or store folder another user owns, or every user may write, is neither written nor read,
where the system has user ids (not on Windows, where Node reports every writable folder as writable by others);
a folder its group may write passes, since a umask of 002 is common. A sweep deletes the armed, ready, and
stamp files after 24 hours, and the chain floors after 30 days.

### The chain

A brief's header carries `Chain: <n>` on its `Written:` line; none means 0. It counts the automatic continuations in a
row that led to the session writing the brief. A session started by an automatic continuation writes the number its
start context names; a session a person started by typing the resume writes 0.

- `aidrian handoff check` fails a `Chain` that is not a whole number, and one below the floor of the session that runs
  it: the number its delivery recorded, whatever the brief's slug, since a continued session that hands off under
  another name is still the same run. So an agent that forgets to count, or renames the work, is caught by a script.
  The gate refuses such a brief too.
- The gate falls back at `Chain` `maxChain` or more: with the default 3, briefs with Chain 0, 1, and 2 continue, and the
  brief the third continued session writes is resumed by a person, which starts the count again.

### The clear route

1. The session writes the brief, checks it, and runs the gate, which arms the continuation for this session. The
   `say:` line tells the Human to type the clear command and then any message.
2. A prompt in the session before the clear cancels the continuation, with one line in the turn that says so; the
   skill arms a new one at the next handoff. The host's own clear and compact commands cancel nothing.
   So a continuation stays armed until the session goes on, however long the Human is away.
3. The clear ends the session: the session-end hook makes its continuation ready, bound to the host process the hook
   runs under. An exit or any other end does nothing here.
4. The session the clear starts takes the ready continuation of its own host process, ended at most 10 seconds before.
   A session in another terminal runs under another host process, so it never takes it. While a `clear` continuation
   is armed but none is ready yet, the hook looks again every 100 ms for at most 600 ms, for a session end that has
   not finished; a plain clear pays one directory listing.
5. It holds the brief to the gate's checks again and to the sha256 it armed. When they pass, it records the chain
   floor of the new session, shows a banner that names the brief and says to send any message, and adds to the start
   context the brief's path, its slug, and the continuation's number, never the brief's text. The first message, unless
   it asks for something else, follows the `session-continue` skill on that brief.
   When the brief is gone or changed, nothing is added, and the banner says to resume with the `session-continue`
   skill and the slug.

Limits:

- Anything that starts a turn in the session after the gate cancels the continuation: a prompt, and also a background
  agent's report, a scheduled or loop run, and a message from another session. So the skill settles every agent,
  background job, and scheduled or loop run in its first step, before it writes the brief and runs the gate.
- The Human types two things: the clear command and one message.
- A store inside a checkout of the repository delivers nothing, and the gate's `fallback:` line says so.
- A hook that cannot read the store lets the session start as it would without one: the Human resumes by hand.

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
  "handoff": { "mode": "ask", "costRatio": 2, "maxTokens": 0, "continue": "none", "maxChain": 3 }
}
```

| Key | Meaning |
| --- | --- |
| `session.handoff.mode` | `"ask"`, `"auto"`, or `"off"`: what the reminder and the plan offer do. |
| `session.handoff.costRatio` | The cost ratio of the first firing, a number of 1.1 or more; the reminder comes back once the ratio doubles since its last firing, never below `costRatio`. |
| `session.handoff.maxTokens` | A ceiling on the context, in tokens, that fires on its own and doubles; `0`, the default, is off. |
| `session.handoff.continue` | How the session goes on after its handoff: `"none"`, the default, `"clear"`, `"compact"`, or `"background"`. A route the host cannot do falls back to `"none"`; which routes each host does is its adapter's `capabilities.handoffContinue` ([Adding a host](providers/adding-a-host.md)). |
| `session.handoff.maxChain` | How many handoffs in a row a session may continue before a person looks, a whole number above 0; `3` by default. |

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
  The brief says under its title that it is an agent's advice, not a spec, and `aidrian handoff check` fails one that does not.
  It is written from the skill's `references/brief-template.md`.
  When the session hands off now, at the reminder, the plan offer, a usage-limit warning, or the Human's request, its
  continue step runs [the gate](#the-gate) after the check: `continue: none` prints the resume instructions, and a
  route tells the Human the `say:` line alone. A checkpoint brief that a running skill writes and works past skips it.
- `aidrian handoff check <brief> [--prior <brief>]` holds the brief it checks to what a resume needs, since after a
  continuation the brief is all the new session has. It exits 1, with one finding each, for:
  - a required section that is missing or empty: `## Objective` with a line of text, `## Current state` with a
    `Worktree:` value and a `Branch:` value, `## Still running` and `## Open risks and questions` with a line of text
    (`None.` when there is nothing), and `## Next steps` with a numbered item at the start of a line.
    A heading matches by its first words in any case, so `## Next steps (ordered)` counts; a line inside a code fence does not.
  - a header, the text above the first section, with no `Supersedes:` value. A value that begins with `none` names no
    brief; any other value names one, and when no superseded brief is found, nothing was compared, which is a finding:
    run the check again with `--prior <that brief>`.
  - a backticked identifier of the superseded brief's Decisions locked, Gotchas, Next steps, Key paths, or Open risks and
    questions that the new brief names nowhere. Current state, Still running, and Done are not compared: they hold
    state, which the next session reads fresh.

  The superseded brief is held to nothing: a brief of any older format compares as it is. It is `--prior`, else the
  snapshot in `<state>/handoffs/.prior/<name>` that `aidrian handoff snapshot` took before a refresh, else the newest
  other brief of the same slug. A passing check keeps the brief that passed as that snapshot, so the next check of the
  file compares with what last passed; a copy the disk refuses changes neither the output nor the exit code.
  A `--prior` that is the brief itself exits 2 for both `check` and `snapshot`: its earlier text is gone. Same file
  means the same device and inode, so a symlink, a hard link, and a letter-case variant on a case-insensitive disk count.
  A header that names this same file, with no snapshot to compare, is a finding the session tells the Human.
  A snapshot is written to a temporary file of a random name in `.prior/` and renamed over its name, so a link planted
  there is replaced, never written through. Every snapshot file is 0600, and a `.prior/` the command creates is 0700;
  one that exists keeps its mode. A `.prior` that is itself a link is refused: nothing is written or removed through it.
- `session-continue`, the first step of the fresh session, reads the newest brief in full, enters its worktree,
  reads the state fresh, and continues at its next steps. It keeps the brief's locked decisions, and checks each other
  claim a step builds on against the docs and code; where they disagree, the docs and code win.
  Started by a continuation, it searches nothing and reads the brief at the path the start context names.
  The next brief for the work carries the [chain](#the-chain) the start context names, or 0 after a typed resume.
