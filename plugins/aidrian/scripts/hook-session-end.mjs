// SessionEnd hook (Claude Code): one `session` row in the dispatch log with the session's tokens and estimated cost,
// read from its transcript and its subagents' transcripts, and the knowledge docs the main conversation read. Inside a
// project only, and only while config.json `telemetry.enabled` is on. A session whose transcript holds no API usage (an
// empty session, or another host's format) and any error log nothing. It first deletes the session's block counts
// (lesson-signals.mjs noteDenial), its gate snapshot (gate-snapshot.mjs), and the session-length reminder's marker
// (hook-stop.mjs), wherever the session ran.

import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { appendEvent } from '../lib/dispatch-log.mjs';
import { sessionRow } from '../lib/dispatch-rows.mjs';
import { forgetGateSnapshot } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { forgetDenials } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

await runHook((input) => {
  forgetDenials(input.session_id);
  forgetGateSnapshot(input.session_id);
  if (typeof input.session_id === 'string' && /^[\w-]+$/u.test(input.session_id)) {
    rmSync(path.join(tmpdir(), `aidrian-session-length-${input.session_id}`), { force: true });
  }
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const config = project && loadConfig(project).config;
  if (!config?.telemetry.enabled) return;
  const row = sessionRow(input, project, { docReads: config.telemetry.docReads });
  if (row.models.length) appendEvent(project, config, row);
});
