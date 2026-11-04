// SessionEnd hook (Claude Code): deletes the session's block counts (lesson-signals.mjs noteDenial), its gate snapshot
// (gate-snapshot.mjs), its tracker record (hook-tracker-post.mjs), and the session-length reminder's marker
// (hook-stop.mjs), wherever the session ran. Then, inside a project with config.json `telemetry.enabled` on, it hands the
// payload to session-row.mjs, which writes the session's row in the dispatch log. The host cancels a SessionEnd hook after
// a short time, and reading a long session's transcripts takes longer, so the worker runs detached and the hook exits as
// soon as the payload is written to it.

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { forgetGateSnapshot, snapshotPath } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { forgetDenials } from '../lib/lesson-signals.mjs';
import { findProject } from '../lib/project.mjs';

const WORKER = path.join(import.meta.dirname, 'session-row.mjs');

await runHook((input) => {
  const endedAt = Date.now();
  forgetDenials(input.session_id);
  forgetGateSnapshot(input.session_id);
  forgetTrackerRecord(input.session_id);
  if (typeof input.session_id === 'string' && /^[\w-]+$/u.test(input.session_id)) {
    rmSync(path.join(tmpdir(), `aidrian-session-length-${input.session_id}`), { force: true });
  }
  if (typeof input.transcript_path !== 'string') return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const config = project && loadConfig(project).config;
  if (!config?.telemetry.enabled) return;
  // detached: the worker outlives this process, in its own process group. The hook does not call process.exit: it
  // exits once stdin.end has flushed the payload, while unref lets it exit without waiting for the worker.
  const worker = spawn(process.execPath, [WORKER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  worker.on('error', () => {});
  worker.stdin.on('error', () => {});
  worker.stdin.end(JSON.stringify({ ...input, ended_at: endedAt }));
  worker.unref();
});

// Never throws, as forgetGateSnapshot: a record that cannot be deleted must not cost the marker or the session row.
function forgetTrackerRecord(sessionId) {
  const file = snapshotPath(sessionId)?.replace(/\.json$/u, '.tracker.json');
  if (!file) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Left behind. Only the stale-file sweep of gate-snapshot.mjs removes it, and that runs only when a gated session starts.
  }
}
