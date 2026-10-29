// SessionEnd hook (Claude Code): one `session` row in the dispatch log with the session's tokens and estimated cost,
// read from its transcript and its subagents' transcripts. Inside a project only; a session whose transcript holds no
// API usage (an empty session, or another host's format) and any error log nothing.

import { runHook } from '../lib/hook-io.mjs';
import { logPath, sessionRow } from '../lib/dispatch-log.mjs';
import { appendRow } from '../lib/jsonl.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const row = project && sessionRow(input);
  if (row?.models.length) appendRow(logPath(project), row);
});
