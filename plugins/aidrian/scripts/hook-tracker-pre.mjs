// PreToolUse hook for every MCP tool: the refusal half of the tracker write guard (docs/config.md#tracker).
// First, whatever the working copy's `tracker.enabled` says, the project run rule (lib/tracker-guard.mjs runWriteRefusal):
// a session of a project run writes only what its role allows (lib/project-report.mjs runWriter reads the role from the
// session's marks), a session no Human attends calls no tool a merge verb names on any server, and no session merges or
// marks a pull request ready through a tracker's tool.
// Then lib/tracker-guard.mjs judges a call of a tool in `tracker.writeTools` against the session's record of the connected
// workspace, which hook-tracker-post.mjs writes, and a refused call exits 2 with the reason on stderr, recorded as the
// other hooks record their blocks (lib/hook-deny.mjs), except the routine refusal of a session's first write, which every
// session that writes meets, and which would read as a problem in the counts. That one leaves a marker instead, and
// hook-session-end.mjs records it when the session ends with no read recorded. With the tracker off it stops as soon as it
// has read the config.
// The run rule runs under the agent gate hook's time budget (lib/deadline.mjs guardBudget), from the hook's start: past
// it, a session with a mark, a pending hold, or a driver mark is refused every MCP call whose name does not say it reads,
// and an attended one runs, as the agent gate hook answers a call its guards cannot finish in time.
// A session id that cannot name a file can hold no record, and neither can a record folder that cannot be written, so no
// read could clear the rule that asks for one: that rule is skipped and the others run. A record from the write's server is
// still judged, and one from another server is skipped with the rule. A record file that is not a record reads as no read,
// which a new read replaces.

import { accessSync, constants, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isObject, writeOwnText } from '../lib/fs.mjs';
import { loadConfig } from '../lib/config.mjs';
import { checkDeadline, guardBudget, PastDeadline, withinDeadline } from '../lib/deadline.mjs';
import { snapshotPath } from '../lib/gate-snapshot.mjs';
import { baseReader } from '../lib/handoff-guard.mjs';
import { block, deny, isMain, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { runWriter } from '../lib/project-report.mjs';
import { runDriver } from '../lib/run-driver.mjs';
import { judgeTrackerWrite, readsByName, refusalMarker, runWriteRefusal } from '../lib/tracker-guard.mjs';
import { readUnattendedMark } from '../lib/unattended-mark.mjs';

// The hook's body, for the payload `input` (lib/hook-io.mjs callHook).
export async function handle(input) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const project = findProject(cwd);
  const config = project ? loadConfig(project).config : null;
  const run = runDenial(input, project, config);
  if (run) {
    if (!project) deny(run.reason);
    await block(input, 'tracker-guard', run.reason, { match: run.match, project, config });
  }
  if (!project || config.tracker.enabled !== true) return;
  const file = snapshotPath(input.session_id)?.replace(/\.json$/u, '.tracker.json');
  const denial = judgeTrackerWrite(config, input.tool_name, input.tool_input, file ? readRecord(file) : null, { skipMissingRecord: !file || !canHoldRecord(file), rawTool: input.raw_tool_name, host: detectHost({ input }) });
  if (!denial) return;
  if (denial.routine) {
    markRefusal(input);
    deny(denial.reason);
  }
  await block(input, 'tracker-guard', denial.reason, { match: denial.match, project, config });
}

if (isMain(import.meta.url)) await runHook(handle);

// The project run rule's refusal of the call in `input`, or null. Who calls comes from the session's marks alone
// (lib/project-report.mjs runWriter). A session no mark names is judged on the working copy's tracker key, for a
// tracker's merge and ready calls only. A marked session is judged on the base branch's `tracker`,
// projectRun.mcpServers, and projectRun.nonTrackerServers, read through the main checkout its mark names, never this
// call's folder; a read that fails, or a mark that names no project, leaves an issue's session and the driver no server
// they may write unscreened (tracker-guard.mjs runWriteRefusal `unread`). A read or a judgment that throws refuses a
// session with a mark, a pending hold, or a driver mark, and lets an attended one run; one cut short by the time budget
// refuses such a session only a call whose name does not say it reads.
function runDenial(input, project, config) {
  const tool = input.tool_name;
  if (typeof tool !== 'string' || !tool.startsWith('mcp__')) return null;
  const listed = [...(config?.tracker?.writeTools ?? [])];
  const human = config?.names?.human ?? 'the Human';
  let writer = null;
  try {
    return withinDeadline(guardBudget(process.env), () => {
      writer = runWriter({ session: input.session_id, env: process.env });
      if (!writer) return runWriteRefusal({ writer, tool, rawTool: input.raw_tool_name, input: input.tool_input, tracker: config?.tracker ?? null, writeTools: listed, human });
      const read = writer.project ? baseReader(writer.project)() : { why: 'the main checkout its mark names is no project' };
      const tracker = read.config?.tracker ?? null;
      const refusal = runWriteRefusal({
        writer, tool, rawTool: input.raw_tool_name, input: input.tool_input, tracker, mcpServers: read.config?.projectRun?.mcpServers ?? {},
        otherServers: read.config?.projectRun?.nonTrackerServers ?? [], unread: read.config ? null : `the base branch's config could not be read (${read.why ?? 'no reason given'})`,
        writeTools: [...(tracker?.writeTools ?? []), ...listed], human,
      });
      // A call the rule let through counts only when it was judged in time.
      if (!refusal) checkDeadline();
      return refusal;
    });
  } catch (error) {
    if (writer === null && !heldSession(input.session_id)) return null;
    if (error instanceof PastDeadline) {
      if (readsByName(tool)) return null;
      return { match: 'the project run rule ran out of time', reason: `aidrian: this tracker call is refused because the project run rule could not judge it in time, and its name does not say it reads, so it may write a tracker for a session no Human attends. Try again, or tell ${human}.` };
    }
    return { match: 'the project run rule could not be read', reason: 'aidrian: this tracker call is refused because the project run rule could not read who this session is or what it may write, and a session no Human attends is never let through on a guess. Try again, or tell the Human.' };
  }
}

// Whether `session` has an unattended mark, a pending hold, or a driver mark, or one that cannot be read.
function heldSession(session) {
  try {
    return readUnattendedMark(session) !== null || runDriver(session) !== null;
  } catch {
    return true;
  }
}

// Leaves what the row at the session's end needs, which the SessionEnd payload lacks. The first refusal of a session keeps
// its marker. Never throws: a marker that cannot be written costs that row, never the refusal.
function markRefusal({ session_id: session, tool_name: tool, agent_type: agent, cwd }) {
  const marker = refusalMarker(session);
  // Already marked, or the counts folder cannot be written: nothing is written.
  if (marker) writeOwnText(marker, JSON.stringify({ tool, agent_type: agent, cwd }), { exclusive: true });
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
