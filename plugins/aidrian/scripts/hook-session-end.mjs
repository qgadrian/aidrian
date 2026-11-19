// SessionEnd hook (Claude Code): records a tracker refusal no read followed (settleRefusal), then deletes the session's block counts (lesson-signals.mjs noteDenial), its gate snapshot
// (gate-snapshot.mjs), its tracker record (hook-tracker-post.mjs), its recorded issue reads (project-issue-text.mjs),
// and the session-length reminder's marker
// (hook-stop.mjs), wherever the session ran. Then, inside a project with config.json `telemetry.enabled` on, it hands the
// payload to session-row.mjs, which writes the session's row in the dispatch log. The host cancels a SessionEnd hook after
// a short time, and reading a long session's transcripts takes longer, so the worker runs detached and the hook exits as
// soon as the payload is written to it.
// Before that, a main session that ends by a clear on a host with a continuation route has its armed handoff continuation
// promoted, bound to the host process this hook runs under, for the session the clear starts (lib/handoff-continue.mjs).

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { forgetGateSnapshot, snapshotPath } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { continueRoutes, detectHost } from '../lib/hosts/index.mjs';
import { readOwnText } from '../lib/fs.mjs';
import { forgetDenials, sweepHookCounts } from '../lib/lesson-signals.mjs';
import { sessionLengthMarker } from '../lib/session-length.mjs';
import { findProject } from '../lib/project.mjs';
import { dropIssueReads } from '../lib/project-issue-text.mjs';
import { NO_READ_LANDED, refusalMarker } from '../lib/tracker-guard.mjs';

const WORKER = path.join(import.meta.dirname, 'session-row.mjs');

await runHook(async (input) => {
  const endedAt = Date.now();
  // First: it reads the tracker record the next lines delete, and the recorder's count lands in the folder they delete.
  await settleRefusal(input);
  forgetDenials(input.session_id);
  sweepHookCounts();
  forgetGateSnapshot(input.session_id);
  forgetTrackerRecord(input.session_id);
  // A main session's recorded issue reads (lib/project-issue-text.mjs); a subagent's reads are its main session's.
  if (!input.agent_id) dropIssueReads(input.session_id);
  if (typeof input.session_id === 'string' && /^[\w-]+$/u.test(input.session_id)) {
    const marker = sessionLengthMarker(input.session_id);
    if (marker) rmSync(marker, { force: true });
  }
  // A subagent's payload promotes nothing: the continuation is the main session's.
  const cleared = input.reason === 'clear' && !input.agent_id;
  if (!cleared && typeof input.transcript_path !== 'string') return;
  // Found once for both: the host gives this hook a short budget.
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  const config = project && loadConfig(project).config;
  if (cleared && config) await promoteCleared(input, project, config);
  if (typeof input.transcript_path !== 'string' || !config?.telemetry.enabled) return;
  // detached: the worker outlives this process, in its own process group. The hook does not call process.exit: it
  // exits once stdin.end has flushed the payload, while unref lets it exit without waiting for the worker.
  const worker = spawn(process.execPath, [WORKER], { detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
  worker.on('error', () => {});
  worker.stdin.on('error', () => {});
  worker.stdin.end(JSON.stringify({ ...input, ended_at: endedAt }));
  worker.unref();
});

// The ending session's armed continuation becomes ready for the session the clear starts. Any other reason does
// nothing here, so an exit keeps its short budget. Never throws: a store it cannot read costs the continuation alone.
async function promoteCleared(input, project, config) {
  try {
    const host = detectHost({ input });
    if (!continueRoutes(host).length) return;
    const { projectStore, promoteCleared: promote } = await import('../lib/handoff-continue.mjs');
    promote(projectStore(project, config), host, input.session_id);
  } catch {
    // Not promoted: the Human resumes by hand, as the gate's say: line names.
  }
}

function trackerRecord(sessionId) {
  return snapshotPath(sessionId)?.replace(/\.json$/u, '.tracker.json');
}

// A routine refusal that no read followed: the session could not read, or never tried, so it counts as one block by
// the tracker guard (hook-tracker-pre.mjs markRefusal). Taking the marker first means one end writes one row. The recorder
// loads only for such a session. Never throws: a row that cannot be written must not cost the deletions or the session row.
async function settleRefusal(input) {
  try {
    const marker = refusalMarker(input.session_id);
    if (!marker) return;
    const refusal = readOwnText(marker);
    rmSync(marker, { force: true });
    if (refusal === null) return;
    const record = trackerRecord(input.session_id);
    if (record && existsSync(record)) return;
    const { tool, agent_type: agent, cwd } = JSON.parse(refusal);
    (await import('../lib/hook-deny.mjs')).recordBlock({ ...input, tool_name: tool, agent_type: agent, cwd: cwd ?? input.cwd }, 'tracker-guard', NO_READ_LANDED);
  } catch {
    // No marker, which is almost every session, or the row is lost.
  }
}

// Never throws, as forgetGateSnapshot: a record that cannot be deleted must not cost the marker or the session row.
function forgetTrackerRecord(sessionId) {
  const file = trackerRecord(sessionId);
  if (!file) return;
  try {
    rmSync(file, { force: true });
  } catch {
    // Left behind. Only the stale-file sweep of gate-snapshot.mjs removes it, and that runs only when a gated session starts.
  }
}
