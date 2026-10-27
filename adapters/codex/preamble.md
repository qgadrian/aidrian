The {{slot:project_harness_name}} harness is running on Codex. Apply these host mappings whenever canonical Claude-oriented instructions use the source term:

- `Agent(...)` and `subagent_type` mean: spawn the named Codex custom agent. Use the structured identifier returned by the spawn operation; never parse a Claude response footer.
- `SendMessage` means: steer or follow up with the Codex agent identified by that structured spawned-agent identifier.
- `Skill tool` means: load and execute the named canonical workflow under `.agents/skills`; do not substitute an ad hoc workflow.
- `${CLAUDE_SESSION_ID}` means `${CODEX_THREAD_ID}` on Codex.
- A handoff instruction that prints `claude --agent orchestrator` must print `codex` on Codex.
- `WebFetch` means the equivalent available Codex web fetch or browsing capability.
- Claude `SessionEnd` cleanup is unavailable on Codex. For `worktree-dev`, use explicit stop and the script's stale-server self-healing behavior.
- Paths under `.claude/plans`, `.claude/runs`, `.claude/reviews`, `.claude/handoffs`, and `.claude/worktrees` are intentional shared runtime-state paths and are not host commands.

Fail visibly when the named custom agent, canonical skill, GPT-5.6 model, hook trust, or required MCP server is unavailable. Never silently downgrade the model or replace a specialist with a generic agent.
