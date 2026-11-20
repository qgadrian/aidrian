// Stop hook: the checks that can send the main session back for one more turn. Claude Code and Codex both run it from
// hooks.json, and both send `stop_hook_active` and `last_assistant_message` (docs/providers/codex.md#hooks).
// - The result hold (lib/project-run-guard.mjs resultHoldReason): the newest session of a project run's issue stops
//   before it recorded the issue's result. It is sent back once to record it, or to go on with the work. It goes first,
//   and holds wherever the session's folder is: its unattended mark names the run's project.
// - The announce check (lib/stop-announce.mjs): the turn's last message announces work the AI is about to start, such
//   as "Starting now unless the Human says otherwise", and stops without starting it. The agent is sent back to do it,
//   or to ask the Human with the question tool, named as the host's model calls it. It goes second: the Human is waiting
//   on that work now, and the session-length reminder writes its marker only when it fires, so it fires at the next stop.
// - The review-loop check (lib/stop-review-loop.mjs): under config.json `github.reviewLoop` "auto", the turn opened or
//   updated a draft pull request and ran no review after it, as lib/transcript.mjs turnActions reads the turn since the
//   Human's last prompt. The agent is sent back to run the `pr-review-loop` skill. It comes third: work the run still
//   owes comes before the wording of its report. It reads Claude Code transcripts only.
// - The merge hand-back check (lib/stop-handback.mjs mergeHandBack): an `aidrian pr auto-merge` run in the same turn
//   refused a pull request because it changes a path the gate never merges, no merge of it ran after, and no report of
//   the turn hands it to the Human, rated, for review and merge. The agent is sent back to add the item. It comes fourth: before the hand-back
//   check, whose rating it asks for too, so one send-back settles the item. It reads Claude Code transcripts only.
// - The hand-back check (lib/stop-handback.mjs): the last message lists items for the Human, under a label such as
//   "For Adrian", and an item says nothing of how critical it is. The agent is sent back to try each item, keep only
//   real blocks, and rate each. It comes fifth: like the announce check, it is about the message the Human reads now.
// - The session-length reminder. Once continuing the main session costs config.json `session.handoff.costRatio` times
//   what a fresh session started from a handoff brief would, or its context passes the optional `maxTokens` ceiling, the
//   agent is sent back for one more turn to judge whether a handoff is worth it: in `ask` mode to ask the user, in `auto`
//   mode to write the brief, or in either to do nothing (lib/session-length.mjs). A marker in the hooks' counts folder holds
//   the ratio at the last cost firing and the ceiling's firings, so the cost reminder comes back once the ratio doubles
//   in `ask` mode, or climbs one step in `auto` (lib/session-length.mjs nextRatio), and the ceiling once the context
//   doubles. It reads Claude Code transcripts only. Its text follows the continue route the session's host can do
//   (lib/session-length.mjs continuation): with `clear` or `background` the agent ends the turn after the brief, and on
//   the background route in `auto` mode a Human who is not watching is no reason to skip the handoff. The marker's path
//   is stopMarkerPath's, which `aidrian session snapshot` reads too; it is read no-follow, capped, and only when this user
//   owns it (fs.mjs readOwnText), and written, only in a counts folder this user owns (ownFolderSync), as a new temporary
//   file, mode 0600, renamed over it, so no write follows a symlink there.
// Each check sends a turn back at most once (checkReason). `stop_hook_active` is true on every stop after a turn's first
// send-back, so on such a stop the checks run only when the turn's last send-back is one of theirs, as the transcript
// shows it (lib/transcript.mjs SENT_BACK), and only those that have not sent the turn back yet: the stop that ends a
// direct run's review loop, after the review-loop check sent it back, still checks its report. The result hold runs
// only on a stop no hook sent back, and its send-back is none of the checks', so the stop it causes runs none of them.
// A payload without `stop_hook_active` (a host that does not send it) is never sent back, so nothing can loop: each stop
// sends back at most once, for one of the six, and a chain of stops this hook caused at most once per check.
// - The terminal hand-over (lib/terminal-replace.mjs endAfterTurn): on a stop no check sends back, sent back before or
//   not, a session whose handoff gate asked to end itself once its turn ends does, so the terminal that ran it, or
//   follows it, opens the background session that took the work; a background session no terminal follows only stops
//   (docs/handoff.md#replacing-the-terminal). It skips the session-length reminder: the work has moved.

import { randomBytes } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';
import { ownFolderSync, readOwnText } from '../lib/fs.mjs';
import { MARKER_CAP, noteFollow, takeEnding } from '../lib/handoff-markers.mjs';
import { deny, runHook } from '../lib/hook-io.mjs';
import { detectHost } from '../lib/hosts/index.mjs';
import { findProject } from '../lib/project.mjs';
import { resultHoldReason } from '../lib/project-run-guard.mjs';
import { continuation, stopMarkerPath, stopReminder } from '../lib/session-length.mjs';
import { ANNOUNCE_LEAD, announcedWork, QUESTION_TOOL } from '../lib/stop-announce.mjs';
import { HAND_BACK_LEAD, handBack, MERGE_HAND_BACK_LEAD, mergeHandBack } from '../lib/stop-handback.mjs';
import { REVIEW_LOOP_LEAD, reviewLoopOwed } from '../lib/stop-review-loop.mjs';
import { readText, SENT_BACK, turnActions } from '../lib/transcript.mjs';

// A refusal as the transcript holds the gate's output: its plain line, or its --json object's reason, whose quotes the
// transcript's own JSON escapes (lib/transcript.mjs gateVerdicts reads both).
const GATE_REFUSAL = ['auto-merge off for #', '\\"reason\\":\\"paths\\"'];

// The start of each check's reason, by which its send-back is known (sentBack).
const MARKS = [ANNOUNCE_LEAD, REVIEW_LOOP_LEAD, MERGE_HAND_BACK_LEAD, HAND_BACK_LEAD];
// What the host writes before a hook's reason in a send-back: the hook's command in brackets (marked).
const HOOK_PREFIX = /^\[.*?\]: /u;

await runHook(async (input) => {
  const settled = input.stop_hook_active === false;
  const caused = input.stop_hook_active === true;
  // The result hold goes first, wherever the session's folder is.
  if (settled) {
    const held = resultHoldReason(input);
    if (held) deny(held);
  }
  const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
  if (!project) return;
  const { config } = loadConfig(project);
  const { session } = config;
  const host = detectHost({ input });
  // A stop no hook sent back reads the transcript for the checks and the reminder, and a stop a hook caused for the checks.
  const text = (settled || caused) && typeof input.transcript_path === 'string' ? readText(input.transcript_path) : null;
  if (settled || caused) {
    const reason = checkReason(input, host.capabilities.transcripts === false ? null : text, config, host);
    if (reason) deny(reason);
  }
  const marker = stopMarkerPath(input.session_id);
  if (marker === null) return;
  if (await endsTerminal(host, project, config, input.session_id)) return;
  if (!settled) return;
  const { handoff } = session;
  if (handoff.mode === 'off' || !text) return;
  const earlier = readOwnText(marker, MARKER_CAP);
  // The route is read only on a stop that fires: on the background route it asks git for the base branch's config.
  if (!stopReminder(text, handoff, earlier)) return;
  const reminder = stopReminder(text, handoff, earlier, await continuation(handoff, host, project, config));
  writeMarker(marker, `${JSON.stringify(reminder.marker)}\n`);
  deny(reminder.reason);
});

// The reason of the first of the four checks that sends this stop back, or null. On a stop a hook caused, a check runs
// only when sentBack lets it. `transcript` is null on a host whose transcripts lib/transcript.mjs cannot read.
function checkReason(input, transcript, config, host) {
  const { names } = config;
  const { reviewLoop } = config.github;
  const settled = input.stop_hook_active === false;
  // The transcript is parsed once, for the checks that read the turn, and only when one can fire: under "auto", or when
  // it holds a refusal as the gate prints it (GATE_REFUSAL), or on a stop a hook caused, when it holds a send-back. The
  // parse is their whole cost on a long session.
  let actions;
  const turn = () => {
    if (actions !== undefined) return actions;
    const parse = typeof transcript === 'string' && (settled
      ? reviewLoop === 'auto' || GATE_REFUSAL.some((form) => transcript.includes(form))
      : transcript.includes(SENT_BACK));
    actions = parse ? turnActions(transcript) : null;
    return actions;
  };
  const spent = settled ? new Set() : sentBack(turn());
  if (spent === null) return null;
  const checks = [
    [ANNOUNCE_LEAD, () => announcedWork(input, transcript, { ai: names.ai ?? host.ai, human: names.human, questionTool: host.nativeToolName(QUESTION_TOOL) })],
    [REVIEW_LOOP_LEAD, () => reviewLoopOwed(input, turn(), { reviewLoop, human: names.human })],
    [MERGE_HAND_BACK_LEAD, () => mergeHandBack(input, transcript, turn(), { human: names.human })],
    [HAND_BACK_LEAD, () => handBack(input, transcript, { human: names.human })],
  ];
  for (const [mark, check] of checks) {
    const reason = spent.has(mark) ? null : check();
    if (reason) return reason;
  }
  return null;
}

// The marks of the checks that already sent this turn back, read from the send-backs turnActions found, on a stop a hook
// caused; null, so no check runs, when the turn's last send-back holds none of them: one by another hook, by the
// session-length reminder, or none the transcript shows, as on a host that writes none. Each send-back a check makes is
// then in the transcript at the next stop, so it runs at most once a turn: nothing can loop.
function sentBack(actions) {
  const texts = (actions ?? []).filter((action) => action?.kind === 'sent-back').map((action) => action.text);
  if (!texts.length || !marked(texts.at(-1)).length) return null;
  return new Set(texts.flatMap(marked));
}

// The marks a send-back's text holds, each only as the start of a reason: at the start of a line, after `Stop hook
// feedback:` on its first line and after the `[<command>]: ` the host writes before a hook's reason, when it does.
// A mark inside a reason, as in a path the merge hand-back reason quotes or report text the hand-back reason quotes, is
// data and marks nothing: each quotes it on the reason's one line.
// SHORTCUT: another Stop hook's reason line that starts with a check's lead marks that check spent, since the host does
// not name each reason's hook reliably. It can only skip a send-back, and another hook writing this plugin's words is
// contrived.
function marked(text) {
  return text.split('\n').flatMap((line) => {
    const reason = (line.startsWith(SENT_BACK) ? line.slice(SENT_BACK.length).trimStart() : line).replace(HOOK_PREFIX, '');
    return MARKS.filter((mark) => reason.startsWith(mark));
  });
}

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

// Writes `text` to a new temporary file beside `file`, with a random suffix, then renames it over `file`, in a folder
// this user owns alone: none is written in another. A write that fails throws, and runHook lets the stop go on.
function writeMarker(file, text) {
  if (!ownFolderSync(path.dirname(file))) return;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, text, { flag: 'wx', mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
