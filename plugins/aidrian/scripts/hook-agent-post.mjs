// PostToolUse hook for the Agent tool (Claude Code): one `dispatch` row in the dispatch log per subagent dispatch.
// Inside a project only; any error lets the session go on with nothing logged.

import { runHook } from '../lib/hook-io.mjs';
import { dispatchRow, logPath } from '../lib/dispatch-log.mjs';
import { appendRow } from '../lib/jsonl.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (project) appendRow(logPath(project), dispatchRow(input));
});
