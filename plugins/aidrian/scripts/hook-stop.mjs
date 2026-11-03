// Stop hook (Claude Code): the session-length reminder. Once the main session passes a config.json `session` limit, the
// agent is sent back for one more turn to judge whether a handoff is worth it: in `ask` mode to ask the user, in `auto`
// mode to write the brief, or in either to do nothing. A marker in the temporary folder counts how often it fired, and
// each firing doubles the limits for the next. `stop_hook_active` is true on the stop this hook caused, and a payload
// without it (another host) is never sent back, so nothing can loop.

import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { handoffReason, overLimits, scaledLimits, sessionLength } from '../lib/session-length.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (input.stop_hook_active !== false || typeof input.transcript_path !== 'string') return;
  if (typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { session } = loadConfig(project).config;
  const marker = path.join(tmpdir(), `aidrian-session-length-${input.session_id}`);
  if (session.handoff === 'off') return;
  const fired = timesFired(marker);
  const text = readText(input.transcript_path);
  const over = text ? overLimits(sessionLength(text), scaledLimits(session, fired)) : [];
  if (!over.length) return;
  writeFileSync(marker, `${fired + 1}\n`);
  deny(handoffReason(session.handoff, over));
});

// How often the reminder fired in this session: 0 with no marker. A marker an older version wrote holds the mode, not a
// count, and counts as one firing.
function timesFired(marker) {
  let text;
  try {
    text = readFileSync(marker, 'utf8');
  } catch {
    return 0;
  }
  const count = Number.parseInt(text, 10);
  return Number.isInteger(count) && count > 0 ? count : 1;
}
