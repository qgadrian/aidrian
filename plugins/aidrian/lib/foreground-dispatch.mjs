// A subagent's agent dispatch runs in the foreground. A subagent that ends its turn goes idle, and the end of a
// background agent it started never wakes it, so its report is lost and the subagent waits until someone messages it.
// The stop hook's background check sends it back once to wait (docs/hooks.md#background-check), and subagents still
// ended their turn with the child running. So the dispatch itself is rewritten: the subagent gets the child's report as
// the call's result, as a foreground call returns it, and several dispatches in one turn still run side by side.
// The main session keeps its background dispatches: a background agent's report wakes it.
// A call that leaves `run_in_background` out is rewritten too: Claude Code launches a subagent's dispatch in the background
// by default, so only an explicit `false` already runs in the foreground. (A child's `.meta.json` `launchedWithDefaults`
// says the call named no model, not that it named no flag.)
// The host does not always honor the flag. Claude Code applies the rewrite, as the transcript's hook record shows, and still
// runs every dispatch in the background while its fork-subagent mode is on, which it is by default in an interactive
// session, for any caller but an in-process teammate: the launch is forced asynchronous whatever `run_in_background` says.
// Only `CLAUDE_CODE_FORK_SUBAGENT=0` in the session's environment turns that off. So on such a session a subagent's
// dispatch stays `async_launched`, and the stop hook relies on the host waking the subagent with the child's report
// instead (capabilities.wakesOnChildReport, docs/providers/claude-code.md#background-agents).
//
// It reads the standard payload: `agent_id`, set on a call a subagent makes, and the Agent tool's `run_in_background`.
// A host that names them otherwise maps to them in its adapter's `hookInput` (lib/hosts/).

// Whether the call comes from a subagent.
const fromSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';

// The dispatch `toolInput` with `run_in_background` off when a subagent's call does not already set it off, else null.
export function foregroundDispatch(input, toolInput) {
  if (!fromSubagent(input) || !toolInput || typeof toolInput !== 'object' || toolInput.run_in_background === false) return null;
  return { ...toolInput, run_in_background: false };
}
