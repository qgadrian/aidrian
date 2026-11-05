// PreToolUse hook for every MCP tool: the refusal half of the tracker write guard (docs/config.md#tracker).
// lib/tracker-guard.mjs judges a call of a tool in `tracker.writeTools` against the session's record of the connected
// workspace, which hook-tracker-post.mjs writes, and a refused call exits 2 with the reason on stderr, recorded as the
// other hooks record their blocks (lib/hook-deny.mjs), except the routine refusal of a session's first write, which every
// session that writes meets, and which would read as a problem in the counts. That one leaves a marker instead, and
// hook-session-end.mjs records it when the session ends with no read recorded. With the tracker off it stops as soon as it
// has read the config.
// A session id that cannot name a file can hold no record, and neither can a record folder that cannot be written, so no
// read could clear the rule that asks for one: that rule is skipped and the others run. A record from the write's server is
// still judged, and one from another server is skipped with the rule. A record file that is not a record reads as no read,
// which a new read replaces.

import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isObject } from '../lib/fs.mjs';
import { loadConfig } from '../lib/config.mjs';
import { snapshotPath } from '../lib/gate-snapshot.mjs';
import { block, deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { judgeTrackerWrite, refusalMarker } from '../lib/tracker-guard.mjs';

await runHook(async (input) => {
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  if (config.tracker.enabled !== true) return;
  const file = snapshotPath(input.session_id)?.replace(/\.json$/u, '.tracker.json');
  const denial = judgeTrackerWrite(config, input.tool_name, input.tool_input, file ? readRecord(file) : null, { skipMissingRecord: !file || !canHoldRecord(file) });
  if (!denial) return;
  if (denial.routine) {
    markRefusal(input);
    deny(denial.reason);
  }
  await block(input, 'tracker-guard', denial.reason, { match: denial.match, project, config });
});

// Leaves what the row at the session's end needs, which the SessionEnd payload lacks. The first refusal of a session keeps
// its marker. Never throws: a marker that cannot be written costs that row, never the refusal.
function markRefusal({ session_id: session, tool_name: tool, agent_type: agent, cwd }) {
  try {
    writeFileSync(refusalMarker(session), JSON.stringify({ tool, agent_type: agent, cwd }), { flag: 'wx' });
  } catch {
    // Already marked, or the temporary folder cannot be written.
  }
}

// Whether hook-tracker-post.mjs could save `file`: the nearest folder above it that exists can be written, so it could
// make the rest. It only looks, so a session that never reads makes no folder.
function canHoldRecord(file) {
  let folder = path.dirname(file);
  for (;;) {
    try {
      if (!statSync(folder).isDirectory()) return false;
      accessSync(folder, constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      const above = path.dirname(folder);
      if (error.code !== 'ENOENT' || above === folder) return false;
      folder = above;
    }
  }
}

function readRecord(file) {
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return isObject(record) ? record : null;
  } catch {
    return null;
  }
}
