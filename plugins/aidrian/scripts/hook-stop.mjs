// Stop hook: two checks that can send the main session back for one more turn. Claude Code and Codex both run it from
// hooks.json, and both send `stop_hook_active` and `last_assistant_message` (docs/providers/codex.md#hooks).
// - The announce check (lib/stop-announce.mjs): the turn's last message announces work the AI is about to start, such
//   as "Starting now unless the Human says otherwise", and stops without starting it. The agent is sent back to do it,
//   or to ask the Human with the question tool, named as the host's model calls it. It goes first: the Human is waiting
//   on that work now, and the session-length reminder writes its marker only when it fires, so it fires at the next stop.
// - The hand-back check (lib/stop-handback.mjs): the last message lists items for the Human, under a label such as
//   "For Adrian", and an item says nothing of how critical it is. The agent is sent back to try each item, keep only
//   real blocks, and rate each. It comes second: like the announce check, it is about the message the Human reads now.
// - The session-length reminder. Once continuing the main session costs config.json `session.handoff.costRatio` times
//   what a fresh session started from a handoff brief would, or its context passes the optional `maxTokens` ceiling, the
//   agent is sent back for one more turn to judge whether a handoff is worth it: in `ask` mode to ask the user, in `auto`
//   mode to write the brief, or in either to do nothing (lib/session-length.mjs). A marker in the temporary folder holds
//   the ratio at the last cost firing and the ceiling's firings, so the cost reminder comes back once the ratio doubles
//   and the ceiling once the context does. It reads Claude Code transcripts only.
// `stop_hook_active` is true on the stop this hook caused, and a payload without it (a host that does not send it) is never
// sent back, so nothing can loop: each stop sends back at most once, for one of the three.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { stopReminder } from '../lib/session-length.mjs';
import { announcedWork, QUESTION_TOOL } from '../lib/stop-announce.mjs';
import { handBack } from '../lib/stop-handback.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook((input) => {
  if (input.stop_hook_active !== false) return;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { names, session } = loadConfig(project).config;
  const host = detectHost({ input });
  const text = typeof input.transcript_path === 'string' ? readText(input.transcript_path) : null;
  const transcriptText = host.capabilities.transcripts === false ? null : text;
  const announced = announcedWork(input, transcriptText, {
    ai: names.ai ?? host.ai, human: names.human, questionTool: host.nativeToolName(QUESTION_TOOL),
  });
  if (announced) deny(announced);
  const handedBack = handBack(input, transcriptText, { human: names.human });
  if (handedBack) deny(handedBack);
  if (typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return;
  const { handoff } = session;
  if (handoff.mode === 'off' || !text) return;
  const marker = path.join(tmpdir(), `aidrian-session-length-${input.session_id}`);
  const reminder = stopReminder(text, handoff, readText(marker));
  if (!reminder) return;
  writeFileSync(marker, `${JSON.stringify(reminder.marker)}\n`);
  deny(reminder.reason);
});
