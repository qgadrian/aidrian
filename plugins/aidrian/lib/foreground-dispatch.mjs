// A subagent's agent dispatch runs in the foreground. A subagent that ends its turn goes idle, and the end of a
// background agent it started never wakes it, so its report is lost and the subagent waits until someone messages it.
// The stop hook's background check sends it back once to wait (docs/hooks.md#background-check), and subagents still
// ended their turn with the child running. So the dispatch itself is rewritten: the subagent gets the child's report as
// the call's result, as a foreground call returns it, and several dispatches in one turn still run side by side.
// The main session keeps its background dispatches: a background agent's report wakes it.
//
// It reads the standard payload: `agent_id`, set on a call a subagent makes, and the Agent tool's `run_in_background`.
// A host that names them otherwise maps to them in its adapter's `hookInput` (lib/hosts/).

// Whether the call comes from a subagent.
const fromSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';

// The dispatch `toolInput` with `run_in_background` off when a subagent asked for the background, else null.
export function foregroundDispatch(input, toolInput) {
  if (!fromSubagent(input) || toolInput?.run_in_background !== true) return null;
  return { ...toolInput, run_in_background: false };
}
