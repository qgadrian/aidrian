// Stop hook: three checks that can send the main session back for one more turn. Claude Code and Codex both run it from
// hooks.json, and both send `stop_hook_active` and `last_assistant_message` (docs/providers/codex.md#hooks).
// - The announce check (lib/stop-announce.mjs): the turn's last message announces work the AI is about to start, such
//   as "Starting now unless the Human says otherwise", and stops without starting it. The agent is sent back to do it,
//   or to ask the Human with the question tool, named as the host's model calls it. It goes first: the Human is waiting
//   on that work now, and the session-length reminder writes its marker only when it fires, so it fires at the next stop.
// - The review-loop check (lib/stop-review-loop.mjs): under config.json `github.reviewLoop` "auto", the turn opened or
//   updated a draft pull request and ran no review after it, as lib/transcript.mjs turnActions reads the turn since the
//   Human's last prompt. The agent is sent back to run the `pr-review-loop` skill. It comes second: work the run still
//   owes comes before the wording of its report. It reads Claude Code transcripts only.
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
//   the background route in `auto` mode a Human who is not watching is no reason to skip the handoff. The marker's path
//   is stopMarkerPath's, which `aidrian session snapshot` reads too; it is read no-follow, capped, and only when this user
//   owns it, and written as a new temporary file, mode 0600, renamed over it, so no write follows a symlink there.
// `stop_hook_active` is true on the stop this hook caused, and a payload without it (a host that does not send it) is never
// sent back, so nothing can loop: each stop sends back at most once, for one of the four.
// - The terminal hand-over (lib/terminal-replace.mjs endAfterTurn): on a stop no check sends back, sent back before or
//   not, a session whose handoff gate asked to end itself once its turn ends does, so the terminal that ran it, or
//   follows it, opens the background session that took the work; a background session no terminal follows only stops
//   (docs/handoff.md#replacing-the-terminal). It skips the session-length reminder: the work has moved.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { MARKER_CAP, noteFollow, readOwnFile, takeEnding } from '../lib/handoff-markers.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { continuation, stopMarkerPath, stopReminder } from '../lib/session-length.mjs';
import { announcedWork, QUESTION_TOOL } from '../lib/stop-announce.mjs';
import { handBack } from '../lib/stop-handback.mjs';
import { reviewLoopOwed } from '../lib/stop-review-loop.mjs';
import { readText, turnActions } from '../lib/transcript.mjs';

await runHook(async (input) => {
  const settled = input.stop_hook_active === false;
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const { names, session } = config;
  const host = detectHost({ input });
  // Only a stop no hook sent back reads the transcript: the checks and the reminder are its only readers.
  const text = settled && typeof input.transcript_path === 'string' ? readText(input.transcript_path) : null;
  if (settled) {
    const transcriptText = host.capabilities.transcripts === false ? null : text;
    const announced = announcedWork(input, transcriptText, {
      ai: names.ai ?? host.ai, human: names.human, questionTool: host.nativeToolName(QUESTION_TOOL),
    });
    if (announced) deny(announced);
    // The transcript is parsed for it only under "auto": the parse is the check's whole cost on a long session.
    const { reviewLoop } = config.github;
    const actions = reviewLoop === 'auto' && typeof transcriptText === 'string' ? turnActions(transcriptText) : null;
    const owed = reviewLoopOwed(input, actions, { reviewLoop, human: names.human });
    if (owed) deny(owed);
    const handedBack = handBack(input, transcriptText, { human: names.human });
    if (handedBack) deny(handedBack);
  }
  const marker = stopMarkerPath(input.session_id);
  if (marker === null) return;
  if (await endsTerminal(host, project, config, input.session_id)) return;
  if (!settled) return;
  const { handoff } = session;
  if (handoff.mode === 'off' || !text) return;
  const earlier = readOwnFile(marker, { cap: MARKER_CAP })?.text ?? null;
  // The route is read only on a stop that fires: on the background route it asks git for the base branch's config.
  if (!stopReminder(text, handoff, earlier)) return;
  const reminder = stopReminder(text, handoff, earlier, await continuation(handoff, host, project, config));
  writeMarker(marker, `${JSON.stringify(reminder.marker)}\n`);
  deny(reminder.reason);
});

// Whether this stop ends the session `id` so its terminal opens the background session it handed off to. The modules
// load only on a host that can replace a terminal.
async function endsTerminal(host, project, config, id) {
  const replace = host.capabilities.handoffContinue?.replaceTerminal;
  if (!replace) return false;
  // An attended session the shell function did not start has nothing to end, and pays for no import: the gate notes a
  // request only for one it started, as AIDRIAN_SHELL_PID (lib/terminal-replace.mjs SHELL_VAR) tells, or for a session
  // no Human attends.
  if (replace.attended(process.env) && !process.env.AIDRIAN_SHELL_PID) return false;
  const { endAfterTurn } = await import('../lib/terminal-replace.mjs');
  const { projectStore, unattendedHere } = await import('../lib/handoff-continue.mjs');
  const store = projectStore(project, config);
  return endAfterTurn({
    host,
    session: id,
    take: () => takeEnding(store, id),
    unattended: () => unattendedHere(id, { store, env: process.env, now: Date.now() }),
    follow: ({ session, shell }) => noteFollow(store, session, { shell }),
  });
}

// Writes `text` to a new temporary file beside `file`, with a random suffix, then renames it over `file`. A write that
// fails throws, and runHook lets the stop go on.
function writeMarker(file, text) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
