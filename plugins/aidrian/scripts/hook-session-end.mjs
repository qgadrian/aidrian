// SessionEnd hook (Claude Code): one `session` row in the dispatch log with the session's tokens and estimated cost,
// read from its transcript and its subagents' transcripts, and the knowledge docs the main conversation read. Inside a
// project only, and only while config.json `telemetry.enabled` is on. A session whose transcript holds no API usage (an
// empty session, or another host's format) and any error log nothing.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent, sessionRow } from '../lib/dispatch-log.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const config = project && loadConfig(project).config;
  if (!config?.telemetry.enabled) return;
  const row = sessionRow(input, project, { docReads: config.telemetry.doc_reads });
  if (row.models.length) appendEvent(project, config, row);
});
