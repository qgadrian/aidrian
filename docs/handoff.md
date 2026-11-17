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
Once `r` reaches `costRatio`, and again each time it doubles since the last firing in `ask` mode, or climbs a step
of `max(costRatio − 1, 1)` in `auto`, the hook sends the agent back for one more turn, with `r` and an estimate of `N`,
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

In `auto` the Human has already decided, so the session never asks whether to hand off or keep going, at a reminder
or on its own: it judges by itself, and runs the `session-handoff` skill when a handoff is worth it. The
[session start](hooks.md#start-lines) says so in a `Handoff:` line of the main session's context, and the skill says
it too.

With the [clear route](#the-clear-route), `auto` runs the skill, whose continue step arms the continuation and prints
the line for the Human; the agent says that line and ends the turn. `ask` adds to its question what a handoff then
takes from the Human, in the host's words, such as typing the clear command and then any message.
With the [background route](#the-background-route), `auto` does the same, and the reminder adds that a new session
goes on in the background and this one does nothing more; `ask` says nothing is typed.
The reasons a handoff is not worth it stay the same, but one: with `auto` on the background route, nobody needs to
start the new session, so a Human who is not watching is no reason to stay. `ask` still asks someone who is there.
The hooks word the route the gate would take: a background route this machine or the base branch has not turned on
is worded as the clear route it falls back to ([the switches](#the-background-route)).

**Once, then again.** The first firing is at `costRatio`, 2 by default. When it comes back depends on the mode:

- `ask` comes back only once `r` reaches twice the ratio at its last firing: 2, 4, 8 by default, or 1.5, 3, 6 at a
  `costRatio` of 1.5, and a first firing at 2.5 comes back at 5. So a session that keeps going is asked a few times at most.
- `auto` comes back one step above its last firing, since a skipped reminder costs the Human nothing. The step is
  `max(costRatio − 1, 1)`: 2, 3, 4, 5 by default, or 3, 5, 7 at a `costRatio` of 3. A step of 1 is one more fresh
  session's worth of context, about 74,000 more tokens at a 30,000-token baseline. So a session that skipped because an
  agent was still running is offered the handoff again once each call costs one more fresh session's worth, and even a
  `costRatio` of 1.1 does not fire at nearly every stop.

In either mode it never comes back below `costRatio`, so a `costRatio` raised mid-session holds even where the next
step is lower. So neither a "keep going" nor a quiet skip turns the reminder off for the rest of the session.
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
the build, or when the Human said to finish here or is not watching; `auto` on the background route skips it only
when the Human said to finish here. The offer keeps no marker.
With the clear route, `auto` sets up the continuation and ends the turn, so the build starts in the session the clear
begins, never here; with the background route it starts in the session the gate starts. `ask` names what a handoff
takes from the Human, as the reminder does.

## Continue

`session.handoff.continue` says how the session goes on once its brief is written. Its default follows `mode`,
and the two give a ladder:

| Step | Config | What happens |
| --- | --- | --- |
| No handoff | `mode: "off"` | Nothing. |
| Warn only | `mode: "ask"`, `continue: "none"` | The agent asks; on a yes it writes the brief and prints the resume line. |
| Brief, no new session | `mode: "auto"`, `continue: "none"` | The agent writes the brief unasked and prints the resume line. |
| Brief, then a clear | `mode: "auto"` or `"ask"`, `continue: "clear"` | The brief, then the Human types the clear command and one message, and the new session resumes from the brief with nothing else typed. |
| Fully automatic | `mode: "auto"` on the base branch, and `"handoff": { "background": "on" }` in this machine's `.aidrian.local.json` | The brief is written, a new session is started in the background that resumes from it, and nothing is typed. The old session ends its turn with one line on where the work goes on; with the [shell function](#replacing-the-terminal), it also ends itself, and its terminal opens the new session. |

The `continue` default follows `mode`: with `mode: "auto"` and no `continue`, the route is `"background"`; with any
other mode it is `"none"`. A `continue` that config.json sets always wins, so `mode: "auto"` with `continue: "none"`
keeps the brief-only step, and `continue: "clear"` the clear. Nothing set means `mode: "ask"` and `continue: "none"`.
The fully automatic step in config.json:

```json
{ "session": { "handoff": { "mode": "auto" } } }
```

and, on each machine that lets sessions start sessions with no Human, in the main checkout's git-ignored
`.aidrian.local.json`:

```json
{ "handoff": { "background": "on" } }
```

`"background"` runs only when the resolved `session.handoff.continue` is `"background"`, set or derived from `"auto"`:
the skill's `--continue background` cannot pick it under any other setting. With `mode: "ask"` and
`continue: "background"` the agent still asks first, and on a yes nothing else is typed.
Two switches more hold it, both read as `github.autoMerge` reads its own, so neither a branch nor a session can turn it on:

- **The team's**, read from the config.json the base branch commits (origin's default branch, or the local `main`
  with no remote), never from a worktree's copy: it must resolve `continue` to `"background"` there too. The route's
  `maxChain` is that commit's, and at most 5 whatever it says.
- **The machine's**, `handoff.background: "on"` in the main checkout's `.aidrian.local.json`, a file git does not
  track. A copy in a worktree, a tracked file, and an error in the file read `"off"`, and a subagent may not set it.

Without either, a handoff on the background route goes on by the clear route on a host that has it, else `none`, and
the gate's `fallback:` line says which switch is off and, for the machine's, the exact edit that turns it on.

The schema takes `"compact"` too, but no host lists it yet: until its release it falls back to `"none"`, and the gate
says so in its `fallback:` line. A route the host does not list falls back the same way. Which host does which route:

| Route | Host |
| --- | --- |
| `clear` | Claude Code: verified on 2.1.325: [Handoff continuation](providers/claude-code.md#handoff-continuation) |
| `background` | Claude Code: on 2.1.326, with `claude --bg`: [The background route](providers/claude-code.md#the-background-route) |
| any | Codex: none, so every route falls back to `"none"` |

### The route the host runs

`aidrian handoff route [--route <route>]` prints `route: <route>`, the route a handoff would go on by here, as the gate
decides it from `--route` or `session.handoff.continue` and the host's routes. A route the host does not run prints
`route: none` and the `fallback:` line, as with `"compact"` on Claude Code in this release or any route on Codex.
A background route either switch keeps off prints `route: clear` and the `fallback:` line that names the switch.
It reads the config, the machine's local file, and the base branch's config, writes nothing, and exits 2 on an
unknown `--route` or a config with errors.
The `session-handoff` skill runs it in its first step, so it settles every running agent only when a continuation can
follow. The gate may still fall back for what only the brief or the store tells, such as the brief's chain.

### The gate

The `session-handoff` skill's continue step runs `aidrian handoff continue <brief> [--route <route>]` after
`aidrian handoff check` passed, in the turn that hands off. `--route` is the Human's choice for this brief, the skill's
`--continue`; without it the command reads `session.handoff.continue`. `--route` may pick `none`, `clear`, or `compact`
whatever the config says, and `background` only when the config says `"background"`, else it falls back. In order:

1. Exit 2: usage, an unknown `--route`, a config with errors, or a brief the store does not hold. The brief must be,
   by its real path, a regular file right inside `<state>/handoffs/`, no symlink, named `<UTC date>-<slug>.md`, and
   under 256 KB. Its folder is compared by identity, device and inode, so on a disk that folds letter case any
   spelling of the path passes, at the check's stamp, the gate, and the delivery alike. A disk that refuses the marker's write exits 2 too.
2. `none` prints `continue: none` and exits 0.
3. A fallback prints `continue: none` and one `fallback:` line, exit 0: the host does not list the route, or tells the
   command no session id; the slug is not letters, digits, dots, dashes, and underscores, up to 100; the path holds a
   control character; the store resolves inside a checkout of the repository, as with `state.dir` set to a folder in
   it; the state, handoffs, or store folder is owned by another user or writable by every user, where the system has
   user ids (not on Windows, where Node reports every writable folder as writable by others); or the brief's chain
   is `maxChain` or more, on the background route the base branch's `maxChain`, at most 5.
   On the background route, a switch that is off, a working copy whose `state.dir` differs from the base branch's,
   a session that did not start, and a started session the gate could not hold to a chain floor and stopped fall back
   to the clear route instead where the host has it: `continue: clear`, the `fallback:` line, and the clear route's
   `say:` line, with the clear continuation armed. A started session it could neither hold nor stop gives
   `continue: none`, with a `fallback:` line that names it and the host's command to stop it, and arms nothing beside it.
4. A refusal exits 1 with the reason and the remedy on stderr, since the session can fix it: no passing check of the
   brief's current bytes (run `aidrian handoff check` first), a brief last written more than 15 minutes ago or dated in
   the future (refresh it), or a `Chain` below the floor this session was given (set it, and check again).
5. Otherwise it arms the continuation and prints `continue: <route>` and one `say:` line, the words the skill tells the
   Human: what the route takes from them, the brief's path, and how to resume by hand when no banner names the slug.
   On the background route it arms nothing: it starts the new session, as [The background route](#the-background-route)
   says, and its `say:` line names that session and how to open it. A second run on the same bytes, in the same
   session, prints the same lines again and starts nothing, before any other check.

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
a folder its group may write passes, since a umask of 002 is common. A sweep deletes the armed, ready, started, and
stamp files after 24 hours, and the chain floors and the kept briefs of the background route after 30 days.

### The chain

A brief's header carries `Chain: <n>` on its `Written:` line; none means 0. It counts the automatic continuations in a
row that led to the session writing the brief. A session started by an automatic continuation writes the number its
start context names; a session a person started by typing the resume writes 0.

- `aidrian handoff check` fails a `Chain` that is not a whole number, and one below the floor of the session that runs
  it: the number its delivery recorded, whatever the brief's slug, since a continued session that hands off under
  another name is still the same run. A session with floors under its own id and under a short id it starts with is
  held to the highest of them. So an agent that forgets to count, or renames the work, is caught by a script.
  The gate refuses such a brief too. A floor is never read against `maxChain`: one above the limit of the config that
  reads it is stricter, never void, so a lower `maxChain` in a worktree cannot drop it.
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

### The background route

Nothing is typed. It runs only when `session.handoff.continue` is `"background"`, set or derived from `mode: "auto"`,
on a host whose adapter lists it and declares `startBackground` ([Adding a host](providers/adding-a-host.md)), with
both [switches](#continue) on: the base branch's config, and `"handoff": { "background": "on" }` in this machine's
`.aidrian.local.json`. The working copy's `state.dir` must equal the base branch's too, since the store it opens holds
the chain floors and the kept copy; when it differs, the handoff goes on by the clear route with that reason.
So must the store itself: the gate opens it with the command's environment, and holds it to the one the base branch's
config names with no `XDG_STATE_HOME` and the home folder of the user it runs as, so a variable set on the command
line cannot move the store where the hooks never read a floor. A machine whose own environment sets `XDG_STATE_HOME`
to another folder falls back to the clear route with that reason; committing `state.dir` gives it the route back.

1. The session settles every running agent, writes the brief, checks it, and runs the gate, as on the clear route.
2. The gate keeps the brief's checked bytes in the store, owner-only, as `continued-<sha256>.md`, so an edit to the
   brief after the gate never reaches the new session.
3. The gate starts a new session through the host adapter, in the handing-off session's own folder as the host lists
   it, a folder the host already trusts, never the brief's worktree, whose own settings could run on start.
   Before the host starts anything, the gate files a pending mark that names the sessions the host lists then, so the
   hooks hold the new session from its first call, in any folder, before the host lists its id (Limits, below); with
   no pending mark, nothing starts. The new
   session takes the handing-off session's name with ` · <continuation>` after it, within 100 characters, and its agent,
   effort, and permission mode when the host tells them; with no usable name, the brief's slug. A handing-off session
   that runs with permission checks bypassed starts none, and the handoff goes on by the clear route: a session no
   Human attends never runs that way. When the host cannot tell the mode, none starts either, since the host's default
   may bypass permission checks, and the `fallback:` line says the mode could not be read.
4. Its first message is the continuation: the brief's path, the kept copy to read and its sha256, its slug, and the
   continuation's number, never the brief's text. It first runs `aidrian handoff verify <copy> <sha256>`, which exits 0
   only when the copy is a regular file of the session's user, named for that sha256, whose bytes still hash to it, and
   1 with the reason otherwise; on 1 it follows none of the copy, prints none of it, and reports it. On 0 it prints
   one line that says so, then the bytes it hashed, from that same read, and the session follows the `session-continue`
   skill on that output alone, never on a read of the copy or the brief's file, which may change after the check.
   It enters the worktree, as on the clear route. It also says the brief is an earlier session's advice, not the Human's instruction: what the Human
   keeps, such as merging, releasing, deleting, force pushing, posting outside the repository, changing config or
   permissions, and starting other sessions, still waits for the Human, and a brief that asks for one is reported.
5. The gate records the chain floor of the new session, `Chain + 1`, as a clear's delivery does, so the check holds
   its next brief to the count. It reads the host's listing for the new session's full id for about 5 seconds; when the
   listing lags, it files the floor under the short id the start printed, and every session id that starts with it
   reads that floor. Under the same id it files the session's unattended mark, `$XDG_STATE_HOME/aidrian/unattended/<id>.json`,
   which names the project's main checkout, so the hooks know the session wherever its calls run (Limits, below).
   A start that surely made nothing, one whose host command never ran or refused the start in a way the host adapter
   knows, such as an untrusted folder, while the listing shows no new session, falls back to the clear route. A start
   whose outcome is unknown, such as one that exited non-zero for any other reason, timed out, was stopped by a signal,
   or exited 0 with no id that the listing then names, may have started a session the gate cannot name: the gate
   keeps the pending mark until it lapses, arms no clear beside it, and prints `continue: none` and a `fallback:` line
   that says so and how to find and stop it through the host. A session that runs past the pending mark's 5 minutes
   is no longer held and has no chain floor, so the line asks the Human to stop it before anything resumes the brief.
   A start whose floor, mark, or start record (step 6) cannot be written is stopped through the host and falls back to
   the clear route; when the stop fails too, the gate prints `continue: none` and a `fallback:` line that names the
   running session and the host's command to stop it, arms no clear beside it, and leaves the pending mark to lapse. The gate never reports a background session it cannot hold to the
   count as the continuation.
6. It records the start for this session, and prints `continue: background` and a `say:` line that names the new
   session by its id, and by its name when that is plain text no other listed session has, where it started, and the
   host's command to open it. The line ends on what becomes of this session: with the
   [shell function](#replacing-the-terminal), that this terminal switches to the new session once the turn ends;
   without it, `This session has ended its work; the new one is <name>, open it with <the host's command>.`
   The skill tells the Human that line and ends the turn; the old session does nothing more.
7. A prompt in the old session in the next 24 hours adds one line that names the background session that owns the
   work, so the old session does not take up the same work unasked.

When the host cannot start the session, such as with no host command on an absolute folder of PATH, a folder the
listing does not name, a folder the host does not trust, or a start that fails, the gate falls back to the clear route
with the reason. A start that timed out or failed still counts when the host's listing then shows it, and one the
listing does not show ends as step 5 says, by the clear route only when nothing surely started.

Limits:

- Without the [shell function](#replacing-the-terminal), the old session stays open and idle: it spends no tokens
  while no turn starts, and the Human closes it at will. A turn that starts there after the gate, such as a background
  agent's report, runs beside the new session in the same worktree, so the skill settles every agent first, as on the
  clear route, and the prompt hook names the session that owns the work.
- The new session starts in the host's default model for that folder; a model the old session switched to in the
  session does not carry over. Its permission mode is the old session's, as step 3 says.
- No Human attends the new session, so the [agent gates](hooks.md#agent-gates) hook refuses it the machine's switches
  in `.aidrian.local.json`, as it refuses a subagent: `github.autoMerge`, `github.unattendedWaiver`, `reviewApprovals`,
  `unattendedSignoff`, `handoff.background`, and `review.productFeedback`. The hook knows such a session by its
  unattended mark, read on every call before it runs, wherever the call runs: with no project at the call's folder,
  the mark's project is the one guarded, and from another project, the mark's project's store and switches are guarded
  beside that project's. The folder `$XDG_STATE_HOME/aidrian/unattended/` is the user's alone (0700), each mark too
  (0600); the hook also reads `~/.local/state/aidrian/unattended/` of the user it runs as, which no variable moves.
  A mark lasts 30 days, as a floor does, and each write sweeps older ones; an entry the hook cannot check counts.
  The host lists the new session's id only seconds after it starts working, so before the start the gate files a
  pending mark, `pending.<the gate's session id>.json` beside the marks, naming the start folder and the ids of the
  sessions the host lists then. For at most 5 minutes it holds every session with no mark of its own, wherever its
  calls run, but the session that ran the gate and the sessions the host listed before the start; one it cannot read,
  or one that names no listing, holds every session but the gate's. A folder cannot tell the new session apart, since
  it may change to any folder before the host lists its id, and no start time can: neither a hook's input nor the
  host's listing gives one. So a session the Human starts in those seconds is held too, as is a session of another host,
  which this host's listing never names. While it is held, the new session also cannot run the gate itself: it has no
  chain floor yet, so the gate refuses it until the host lists it. The gate removes the pending mark once the new
  session's own mark is written, or when nothing started or the start was stopped; a start whose outcome is unknown
  keeps it until it lapses.
  Such a session, and one with a mark, is also refused a call the guards cannot finish reading within their time
  budget, and a command with more write targets or words than they read, as a subagent is.
  A session the gate started before the marks is known by its chain floor of route `background`, under its full id or
  a short one, in the store of the working copy's `state.dir` or the base branch's, each where the hook's environment
  puts it and where the user's own puts it, as the gate does; the hook reads it only for a call the guards below would
  refuse, before the call runs, so a call that deletes the floor is judged while the floor is still there. It refuses
  such a session, as a subagent:
  - a write in the continuation store, such as a delete or an overwrite of its own floor, and a `chmod`, `chown`, or
    `chgrp` of the store, a file in it, its handoffs folder, or the state folder, which would hide the floor;
  - a write in the unattended marks' folder, or a change of its mode or owner, or of the state root's, which would
    lift its own mark, with or without a project, as a subagent is refused it too;
  - a host session started outside the gate, such as `claude -p`, `claude --bg`, or `claude --resume`, by the matcher
    each host adapter declares (`sessionStart`, [Adding a host](providers/adding-a-host.md));
  - an `aidrian handoff continue` or `aidrian handoff route` whose command line sets or unsets `XDG_STATE_HOME`, `HOME`,
    `PATH`, or a variable a host names a session or an agent by, as `env -u`, `env -i`, `sudo`, and `unset` do, which
    would move the store, the session the gate reads floors for, or the host command it runs.
  A store the hook cannot read finds no floor, and the session's call runs: only what the session can cause itself is
  closed.

### Replacing the terminal

With one line in the shell's startup file, a background handoff also replaces the old session in its terminal: the
old session ends itself once its turn ends, and the same terminal opens the new one, with nothing typed. For zsh, in
`~/.zshrc`:

```sh
eval "$(aidrian shell-init zsh)"
```

`aidrian shell-init zsh` prints a function named for each host program that can do it, today `claude`, and exits 2 for
any other shell. The function runs the program as `command claude "$@"`, with `AIDRIAN_SHELL_PID` set to the shell's
own pid. Once the program exits, it reads and deletes this shell's record,
`$XDG_STATE_HOME/aidrian/handoff-terminals/<shell pid>`, a line `<id> <expiry in epoch seconds>`. When the record is a
regular file this user owns, not a symlink, its expiry has not passed, and the id is letters, digits, dashes, and
underscores, 4 to 128 of them, starting with a letter or digit, it runs the host's command that opens that session,
`command claude attach <id>`, and reads the record again once that exits. With no record, or one it refuses, it returns
the exit code of the last program it ran. It runs nothing from the record but that id.

It runs only where every switch of the background route is on, and `session.handoff.mode` on the base branch is
`"auto"`, on a host whose adapter declares `replaceTerminal` ([Adding a host](providers/adding-a-host.md)):

1. Once the background session started and the gate recorded it, the gate asks the host adapter for this session's host
   process. It must be a child of the shell `AIDRIAN_SHELL_PID` names, of the host's program, and attended by a Human,
   as the host tells it. The gate then notes in the continuation store, `ending-<session>.json`, the host process, the
   shell, and the new session's id. It notes nothing for a session no Human attends, known by its unattended mark or
   its chain floor of route `background`, or when anything above is missing, and the say line ends with the plain line
   on how to open the new session instead.
2. When the turn ends, the Stop hook takes that request, once, within 30 minutes. It checks the request again against
   its own environment: the shell's pid, the host process, a Human attending, and no unattended mark. Then it writes the
   shell's record, valid for 60 seconds, and starts a detached helper. The helper waits 2 seconds, so the host runs its
   other Stop hooks and shows the last message. It checks the process is still the host's program that shell started,
   and sends the host's signal; on Claude Code, SIGTERM ([provider page](providers/claude-code.md#replacing-the-terminal)).
   A stop the announce or hand-back check sends back ends nothing yet; the next stop does. A stop that ends the session
   skips the session-length reminder.
3. The host's program exits, and the shell function opens the new session in the same terminal.

Limits:

- A subagent cannot run the gate, and its stop is not the Stop hook's, so no subagent ends a process. A session no Human
  attends never notes a request, and the Stop hook refuses one for it; the store, where the request lives, is closed to
  both, as for a chain floor.
- The next hop chains only through a session the shell function started. The session the terminal opens next is a
  background session, which no Human attends as far as the hooks know, so when it hands off in turn, it ends nothing:
  its say line names the next session and the command that opens it, which the Human runs after leaving this one.
- The shell's record lies outside the continuation store, in a folder that is the user's alone (0700), each record 0600.
  The hooks do not refuse a write there. A record another session of the same user wrote can only make the terminal open
  a session by a plain id, within its minute, the next time a program the shell function ran exits.
- A Stop hook of another plugin that sends the turn back gets 2 seconds before the signal, and the session ends
  mid-turn. Its transcript is kept, and the work goes on in the new session.

## The cost model

All costs are in input tokens of the model of the session's last main-session call.

| Symbol | What it is |
| --- | --- |
| `C` | The context of the last main-session call: input, cache read, and cache write together. |
| `W` | The context of the first main-session call: the system prompt, tools, and project instructions a fresh session reads too. |
| `B` | What a fresh session reads to resume, 44,000 tokens. |
| `H` | The calls the long session spends writing the brief, 8. |
| `m` | The model's cache-read multiple of its input price, from `priceFor` in `lib/model-prices.mjs`; 0.1 when the model sets none or is unknown. |
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
| `session.handoff.costRatio` | The cost ratio of the first firing, a number of 1.1 or more; the reminder comes back once the ratio doubles since its last firing in `ask` mode, or climbs a step of `max(costRatio − 1, 1)` in `auto`, never below `costRatio`. |
| `session.handoff.maxTokens` | A ceiling on the context, in tokens, that fires on its own and doubles; `0`, the default, is off. |
| `session.handoff.continue` | How the session goes on after its handoff: `"none"`, `"clear"`, `"compact"`, or `"background"`. The default follows `mode`: `"background"` with `mode: "auto"`, else `"none"`; a value set here wins. A route the host cannot do falls back to `"none"`; which routes each host does is its adapter's `capabilities.handoffContinue` ([Adding a host](providers/adding-a-host.md)). |
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
  route tells the Human the `say:` line, after the `fallback:` line when the gate fell back to the clear route.
  A checkpoint brief that a running skill writes and works past skips it. Its first step runs `aidrian handoff route`
  and settles every running agent unless the route is `none`: on the clear route a turn after the gate cancels the
  continuation, and on the background route it runs beside the new session.
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
  Started by a continuation, it searches nothing and reads the brief at the path the start context or first message
  says to read: on the background route the kept copy of the checked bytes. On the background route, what that message
  reserves for the Human still waits for the Human, whatever the brief asks.
  The next brief for the work carries the [chain](#the-chain) the start context names, or 0 after a typed resume.
