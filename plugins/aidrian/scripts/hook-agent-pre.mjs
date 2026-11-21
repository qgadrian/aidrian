// PreToolUse hook for the Agent tool: the project's model and effort for this plugin's agents (Claude Code), and a
// subagent's background dispatch moved to the foreground (lib/foreground-dispatch.mjs).
// Prints the rewritten call as `updatedInput` and decides nothing else, so permissions work as before.
// Inside a project only; any error lets the call run as the agent wrote it.


import { agentCall } from '../lib/agent-models.mjs';
import { loadConfig } from '../lib/config.mjs';
import { foregroundDispatch } from '../lib/foreground-dispatch.mjs';
import { isMain, print, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const modelled = agentCall(input.tool_input, loadConfig(project).config.models);
  const updatedInput = foregroundDispatch(input, modelled ?? input.tool_input) ?? modelled;
  if (updatedInput) print(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
}

if (isMain(import.meta.url)) await runHook(handle);
