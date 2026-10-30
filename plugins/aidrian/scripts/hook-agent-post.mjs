// PostToolUse hook for the Agent tool (Claude Code): one `dispatch` row in the dispatch log per subagent dispatch.
// Inside a project only, and only while config.json `telemetry.enabled` is on; any error lets the session go on with
// nothing logged.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { dispatchRow } from '../lib/dispatch-rows.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (project) appendEvent(project, loadConfig(project).config, dispatchRow(input));
});
