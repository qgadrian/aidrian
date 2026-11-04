// PostToolUse hook for every MCP tool: the read half of the tracker write guard (docs/config.md#tracker). After a call of
// a tool in `tracker.readTools`, it records what that tool reported as the connected workspace, so hook-tracker-pre.mjs
// can judge the session's writes against it. The record is `<session id>.tracker.json` beside the session's gate
// snapshot (lib/gate-snapshot.mjs), { value, unreadable, tool, at }; the latest read replaces an earlier one, and
// hook-session-end.mjs deletes it. With the tracker off it stops as soon as it has read the config. With no session id
// that can name a file it records nothing.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { snapshotPath } from '../lib/gate-snapshot.mjs';
import { runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { readTrackerValue } from '../lib/tracker-guard.mjs';

await runHook((input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { tracker } = loadConfig(project).config;
  if (tracker.enabled !== true || !tracker.readTools.includes(input.tool_name)) return;
  const file = snapshotPath(input.session_id)?.replace(/\.json$/u, '.tracker.json');
  if (!file) return;
  const value = readTrackerValue(input.tool_response, tracker.workspace.field);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ value, unreadable: value === null, tool: input.tool_name, at: new Date().toISOString() })}\n`);
  renameSync(temporary, file);
});
