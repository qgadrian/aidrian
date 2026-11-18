// Stop hook: the checks that can send the main session back for one more turn. Claude Code and Codex both run it from
// hooks.json, and both send `stop_hook_active` and `last_assistant_message` (docs/providers/codex.md#hooks).
// - The result hold (lib/project-run-guard.mjs resultHoldReason): the newest session of a project run's issue stops
//   before it recorded the issue's result. It is sent back once to record it, or to go on with the work. It goes first,
//   and holds wherever the session's folder is: its unattended mark names the run's project.
// - The announce check (lib/stop-announce.mjs): the turn's last message announces work the AI is about to start, such
//   as "Starting now unless the Human says otherwise", and stops without starting it. The agent is sent back to do it,
//   or to ask the Human with the question tool, named as the host's model calls it. It goes second: the Human is waiting
//   on that work now, and the session-length reminder writes its marker only when it fires, so it fires at the next stop.
// - The hand-back check (lib/stop-handback.mjs): the last message lists items for the Human, under a label such as
//   "For Adrian", and an item says nothing of how critical it is. The agent is sent back to try each item, keep only
//   real blocks, and rate each. It comes third: like the announce check, it is about the message the Human reads now.
// - The session-length reminder. Once continuing the main session costs config.json `session.handoff.costRatio` times
//   what a fresh session started from a handoff brief would, or its context passes the optional `maxTokens` ceiling, the
//   agent is sent back for one more turn to judge whether a handoff is worth it: in `ask` mode to ask the user, in `auto`
//   mode to write the brief, or in either to do nothing (lib/session-length.mjs). A marker in the temporary folder holds
//   the ratio at the last cost firing and the ceiling's firings, so the cost reminder comes back once the ratio doubles
//   in `ask` mode, or climbs one step in `auto` (lib/session-length.mjs nextRatio), and the ceiling once the context
//   doubles. It reads Claude Code transcripts only. Its text follows the continue route the session's host can do
//   (lib/session-length.mjs continuation): with `clear` or `background` the agent ends the turn after the brief, and on
//   the background route in `auto` mode a Human who is not watching is no reason to skip the handoff.
// `stop_hook_active` is true on the stop this hook caused, and a payload without it (a host that does not send it) is never
// sent back, so nothing can loop: each stop sends back at most once, for one of the four.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { resultHoldReason } from '../lib/project-run-guard.mjs';
import { continuation, stopReminder } from '../lib/session-length.mjs';
import { announcedWork, QUESTION_TOOL } from '../lib/stop-announce.mjs';
import { handBack } from '../lib/stop-handback.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook(async (input) => {
  if (input.stop_hook_active !== false) return;
  const held = resultHoldReason(input);
  if (held) deny(held);
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const { names, session } = config;
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
  const earlier = readText(marker);
  // The route is read only on a stop that fires: on the background route it asks git for the base branch's config.
  if (!stopReminder(text, handoff, earlier)) return;
  const reminder = stopReminder(text, handoff, earlier, await continuation(handoff, host, project, config));
  writeFileSync(marker, `${JSON.stringify(reminder.marker)}\n`);
  deny(reminder.reason);
});
