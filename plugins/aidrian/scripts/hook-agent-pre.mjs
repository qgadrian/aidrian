// PreToolUse hook for the Agent tool (Claude Code): the project's model and effort for this plugin's agents.
// Prints the rewritten call as `updatedInput` and decides nothing else, so permissions work as before.
// Inside a project only; any error lets the call run as Claude wrote it.

import { writeSync } from 'node:fs';

import { agentCall } from '../lib/agent-models.mjs';
import { loadConfig } from '../lib/config.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const updatedInput = agentCall(input.tool_input, loadConfig(project).config.models);
  if (updatedInput) writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } }));
});
