// The session-end worker: hook-session-end.mjs starts it detached and hands it the hook payload on stdin, plus
// `ended_at`, the hook's own time in milliseconds. It writes the one `session` row in the dispatch log with the
// session's tokens and estimated cost, its skills, draft pull requests, and review runs, read from its transcript and
// its subagents' transcripts, and the knowledge docs the main conversation read. Reading tens of MB of transcripts takes
// longer than the host gives a SessionEnd hook, so it runs here, after the session has closed. Inside a project only,
// and only while config.json `telemetry.enabled` is on. A transcript that holds no API usage (an empty session, or
// another host's format) and any error log nothing.

import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { sessionRow } from '../lib/dispatch-rows.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const config = project && loadConfig(project).config;
  if (!config?.telemetry.enabled) return;
  const now = Number.isFinite(input.ended_at) ? input.ended_at : Date.now();
  const row = sessionRow(input, project, { docReads: config.telemetry.docReads, now });
  if (row.models.length) appendEvent(project, config, row);
});
