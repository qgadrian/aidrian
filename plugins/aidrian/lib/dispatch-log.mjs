// The dispatch log: `dispatch-log.jsonl` in the state folder, one row per subagent dispatch, per subagent stop, per
// session end, and per block by one of the plugin's own hooks, appended unless config.json `telemetry` turns them off;
// `aidrian report` reads it. A row holds names, counts, durations, costs, and file paths; never a prompt, a command, or
// tool output. docs/dispatch-log.md describes every field. Row keys are snake_case and config.json keys camelCase:
// each layer keeps its own convention.
// This file writes, rotates, and reads the log, and holds what more than one view needs to read its rows.
// dispatch-rows.mjs builds the rows the hooks write; report.mjs is the `aidrian report` command, and report-*.mjs its views.

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { fileBytes } from './fs.mjs';
import { appendRow, latestRows as latest, readRows } from './jsonl.mjs';
import { stateDir } from './project.mjs';

// `config` is the project's config when the caller has it; stateDir reads it otherwise.
export const logPath = (project, config) => path.join(stateDir(project, { config }), 'dispatch-log.jsonl');
// The log's previous part, which rotation keeps beside it.
const rotatedPath = (file) => file.replace(/\.jsonl$/u, '.1.jsonl');
// A lock older than this was left by a process that died while rotating.
const STALE_LOCK_MS = 60_000;

// Appends `row`, unless `config.telemetry.enabled` is false. A log of `telemetry.maxMb` or more rotates first.
export function appendEvent(project, config, row) {
  if (!config.telemetry.enabled) return;
  const file = logPath(project, config);
  rotate(file, config.telemetry.maxMb * 1024 * 1024);
  appendRow(file, row);
}

// Moves a log of `maxBytes` or more to `dispatch-log.1.jsonl`, replacing the one there, and starts the new log with a
// `rotate` row whose `dropped` says whether older rows were lost. One process rotates at a time: it holds a lock file it
// created exclusively. A process that cannot create the lock appends to whichever log is there.
function rotate(file, maxBytes) {
  if ((fileBytes(file) ?? 0) < maxBytes) return;
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    } catch {
      // The lock went away: the process that held it is done.
    }
    return;
  }
  try {
    // Another process may have rotated between the size check and the lock.
    if ((fileBytes(file) ?? 0) < maxBytes) return;
    const rotated = rotatedPath(file);
    const dropped = existsSync(rotated);
    renameSync(file, rotated);
    appendRow(file, { event: 'rotate', ts: stamp(Date.now()), session_id: null, dropped });
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

// Every row of the log, its rotated part first: { file, rotated, rows, skipped }. `rotated` is null when there is none.
export function readLog(project, config) {
  const file = logPath(project, config);
  const rotated = rotatedPath(file);
  const older = readRows(rotated);
  const newer = readRows(file);
  return { file, rotated: existsSync(rotated) ? rotated : null, rows: [...older.rows, ...newer.rows], skipped: older.skipped + newer.skipped };
}

export const stamp = (now) => new Date(now).toISOString();

// A row's `docs_read` as { path, bytes }. A row written before sizes were logged holds bare paths, of unknown size.
export const docsRead = (row) =>
  (Array.isArray(row.docs_read) ? row.docs_read : []).map((entry) => (typeof entry === 'string' ? { path: entry, bytes: null } : entry));

// Whether each run among `stops` was sent back by the delivery check: true, false, or null for unknown, keyed by
// agent_id. A stop row without an agent_id is a run of its own, so it is its own key here as in latestRows. A row says
// so in `sent_back`; a row from before that field is unknown when its `delivered` is `missing`, and was never sent back
// otherwise. A run is sent back when any of its rows was, else unknown when any is.
export function sendBackStates(stops) {
  const runs = new Map();
  for (const row of stops) {
    const key = row.agent_id ?? row;
    const states = [runs.get(key), typeof row.sent_back === 'boolean' ? row.sent_back : row.delivered === 'missing' ? null : false];
    runs.set(key, states.includes(true) ? true : states.includes(null) ? null : false);
  }
  return runs;
}

// What a report over `rows` cannot see: { enabled, doc_reads, hook_denies, rows_without_doc_reads, runs_without_send_back,
// rotated_out_before }. `enabled`, `doc_reads`, and `hook_denies` are the switches now. `rows_without_doc_reads` counts
// the stop and session rows since `sinceMs` written while doc reads were off; `runs_without_send_back`, the runs since
// then whose send-back is unknown (sendBackStates). `rotated_out_before` is the oldest row's time when rotation dropped
// older rows and the window starts before it; else null. A time telemetry was off leaves no rows, so no report can see it.
export function coverage(rows, config, { sinceMs = 0 } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs);
  const counted = [...latest(fresh, 'stop', 'agent_id'), ...latest(fresh, 'session', 'session_id')];
  const sendBacks = sendBackStates(fresh.filter((row) => row.event === 'stop'));
  const oldest = rows.reduce((min, row) => Math.min(min, Date.parse(row.ts) || Infinity), Infinity);
  const lost = rows.some((row) => row.event === 'rotate' && row.dropped === true);
  return {
    enabled: config.telemetry.enabled,
    doc_reads: config.telemetry.docReads,
    hook_denies: config.telemetry.hookDenies,
    rows_without_doc_reads: counted.filter((row) => row.docs_read === null).length,
    runs_without_send_back: [...sendBacks.values()].filter((state) => state === null).length,
    rotated_out_before: lost && oldest > sinceMs && oldest !== Infinity ? new Date(oldest).toISOString() : null,
  };
}

// The lines that tell a reader the report is incomplete, and why. `docReads: false` leaves out the doc-read lines, for a
// view that shows no doc reads; `hookDenies: true` adds the hook-deny line, and `sendBacks: true` the send-back line, for
// the view that shows them.
export function coverageLines(cover, { docReads = true, hookDenies = false, sendBacks = false } = {}) {
  const lines = [];
  if (!cover.enabled) lines.push('Telemetry is off (telemetry.enabled is false): the hooks write no rows, so this shows only older ones.');
  else {
    if (docReads && !cover.doc_reads) lines.push('Doc reads are off (telemetry.docReads is false): new rows do not record them.');
    if (hookDenies && !cover.hook_denies) lines.push('Hook denies are off (telemetry.hookDenies is false): the hooks still block, and log no hook_deny rows.');
  }
  if (docReads && cover.rows_without_doc_reads) {
    lines.push(`Partial: ${cover.rows_without_doc_reads} agent and session rows in the window were written with doc reads off.`);
  }
  if (sendBacks && cover.runs_without_send_back) {
    lines.push(
      `Partial: ${cover.runs_without_send_back} agent runs named a missing file before stop rows recorded send-backs; ` +
        'the share sent back leaves them out.',
    );
  }
  if (cover.rotated_out_before) {
    lines.push(`Partial: the log starts at ${cover.rotated_out_before}; older rows were rotated out at telemetry.maxMb.`);
  }
  return lines;
}
