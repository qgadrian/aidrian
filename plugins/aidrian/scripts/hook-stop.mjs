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
//   in `ask` mode, or climbs one step in `auto` (lib/session-length.mjs nextRatio), and the ceiling once the context
//   doubles. It reads Claude Code transcripts only. Its text follows the continue route the session's host can do
//   (lib/session-length.mjs continuation): with `clear` or `background` the agent ends the turn after the brief, and on
//   the background route in `auto` mode a Human who is not watching is no reason to skip the handoff.
// `stop_hook_active` is true on the stop this hook caused, and a payload without it (a host that does not send it) is never
// sent back, so nothing can loop: each stop sends back at most once, for one of the three.
// - The terminal hand-over (lib/terminal-replace.mjs endAfterTurn): on a stop no check sends back, sent back before or
//   not, a session whose handoff gate asked to end itself once its turn ends does, so the terminal that ran it opens
//   the background session that took the work (docs/handoff.md#replacing-the-terminal). It skips the session-length
//   reminder: the work has moved.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { continuation, stopReminder } from '../lib/session-length.mjs';
import { announcedWork, QUESTION_TOOL } from '../lib/stop-announce.mjs';
import { handBack } from '../lib/stop-handback.mjs';
import { readText } from '../lib/transcript.mjs';

await runHook(async (input) => {
  const settled = input.stop_hook_active === false;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const { names, session } = config;
  const host = detectHost({ input });
  const text = typeof input.transcript_path === 'string' ? readText(input.transcript_path) : null;
  if (settled) {
    const transcriptText = host.capabilities.transcripts === false ? null : text;
    const announced = announcedWork(input, transcriptText, {
      ai: names.ai ?? host.ai, human: names.human, questionTool: host.nativeToolName(QUESTION_TOOL),
    });
    if (announced) deny(announced);
    const handedBack = handBack(input, transcriptText, { human: names.human });
    if (handedBack) deny(handedBack);
  }
  if (typeof input.session_id !== 'string' || !/^[\w-]+$/.test(input.session_id)) return;
  if (await endsTerminal(host, project, config, input.session_id)) return;
  if (!settled) return;
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

// Whether this stop ends the session `id` so its terminal opens the background session it handed off to. The modules
// load only on a host that can replace a terminal.
async function endsTerminal(host, project, config, id) {
  if (!host.capabilities.handoffContinue?.replaceTerminal) return false;
  const { endAfterTurn, shellPid } = await import('../lib/terminal-replace.mjs');
  // A session no shell function started has nothing to end: no store is opened on its stops.
  if (shellPid(process.env) === null) return false;
  const { projectStore, unattendedHere } = await import('../lib/handoff-continue.mjs');
  const { takeEnding } = await import('../lib/handoff-markers.mjs');
  const store = projectStore(project, config);
  return endAfterTurn({ host, take: () => takeEnding(store, id), unattended: () => unattendedHere(id, { store, env: process.env, now: Date.now() }) });
}
