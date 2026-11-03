// Stop hook (Claude Code): the session-length reminder. Once continuing the main session costs config.json
// `session.handoff.costRatio` times what a fresh session started from a handoff brief would, or its context passes the
// optional `maxTokens` ceiling, the agent is sent back for one more turn to judge whether a handoff is worth it: in `ask`
// mode to ask the user, in `auto` mode to write the brief, or in either to do nothing (lib/session-length.mjs).
// A marker in the temporary folder counts the firings of each trigger, so each comes back only at its next step.
// `stop_hook_active` is true on the stop this hook caused, and a payload without it (another host) is never sent back,
// so nothing can loop.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { findProject } from '../lib/project.mjs';
import { stopReminder } from '../lib/session-length.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (input.stop_hook_active !== false || typeof input.transcript_path !== 'string') return;
  if (typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { handoff } = loadConfig(project).config.session;
  if (handoff.mode === 'off') return;
  const text = readText(input.transcript_path);
  if (!text) return;
  const marker = path.join(tmpdir(), `aidrian-session-length-${input.session_id}`);
  const reminder = stopReminder(text, handoff, readText(marker));
  if (!reminder) return;
  writeFileSync(marker, `${JSON.stringify(reminder.marker)}\n`);
  deny(reminder.reason);
});
