// Stop hook (Claude Code): the session-length reminder. Once the main session passes a config.json `session` limit, the
// agent is sent back for one more turn, once per session: in `ask` mode to ask the user whether to hand off now, in `auto`
// mode to write the handoff brief. A marker in the temporary folder records that it fired. `stop_hook_active` is true on
// the stop this hook caused, and a payload without it (another host) is never sent back, so nothing can loop.

import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { handoffReason, overLimits, sessionLength } from '../lib/session-length.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (input.stop_hook_active !== false || typeof input.transcript_path !== 'string') return;
  if (typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { session } = loadConfig(project).config;
  const marker = path.join(tmpdir(), `aidrian-session-length-${input.session_id}`);
  if (session.handoff === 'off' || existsSync(marker)) return;
  const text = readText(input.transcript_path);
  const over = text ? overLimits(sessionLength(text), session) : [];
  if (!over.length) return;
  writeFileSync(marker, `${session.handoff}\n`);
  deny(handoffReason(session.handoff, over));
});
