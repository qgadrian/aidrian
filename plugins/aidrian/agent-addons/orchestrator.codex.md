On Codex, an agent you spawn cannot message you: its final reply is its return, and you get it only by waiting for it.
Codex has no `run_in_background`: foreground means you wait for the agent at once,
background means you spawn it, keep routing, and wait for it before you use its result.
Wait for each agent's return before the next dispatch that depends on it.
Spawn independent slices together, then wait for all of them before you report.
A background dispatch's short summary is that final reply; read its handoff file after the wait returns.
An agent denied `Write` writes no handoff file: its final reply is the handoff.
Claude Code hooks log each dispatch and send back an agent whose claimed handoff file is missing; Codex runs neither.
So check that a claimed handoff file exists before you use it; if it does not, ask the agent once for it in its reply.
Skip `aidrian report` at closure: the dispatch log comes from those hooks, so it shows nothing reliable about a Codex session.
