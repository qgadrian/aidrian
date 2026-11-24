// Automatic lessons: strong signals the plugin's hooks and commands already see, written to the lesson inbox as rows
// with a `key`. The first row of a key starts a lesson; every later one is that lesson seen again (lesson-inbox.mjs), so
// a signal dedupes itself and one recurring after a fix reopens it. Each signal fires only on an event that is rare by
// construction, and none ever changes what the hook or command that saw it does. config.json `lessons.auto: false`
// turns all of them off. Rows hold names, counts, paths, and ids; never a prompt, a command, or tool output.
// A signal with target `plugin` lands in the plugin's inbox, as `aidrian lesson add --target plugin` does.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, opendirSync, openSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { appendRow, withLocks } from './jsonl.mjs';
import { addRow, homeInbox } from './lesson-inbox.mjs';
import { openOwnFile, ownFolderSync } from './fs.mjs';
import { findProject, hookCountsFolder } from './project.mjs';

// One block is a guard doing its job; this many of the same rule, for the same cause, in one agent run is an agent
// fighting it. A count per session once filed lessons for blocks days apart, by different agents, on different pull
// requests, for different causes, each of which the rule was right to make.
export const REPEATED_DENIALS = 3;

// Appends the signal's row and returns it; null when the project turned signals off, the inbox's lock is held, or
// anything failed. Hooks call this before they exit, under the host's hook timeout, so it never waits: the append runs
// under the inbox's lock, so a lesson move never reads the inbox before this row and marks the lesson moved after it,
// and when another process holds that lock, the signal is not recorded this time.
export function recordSignal(project, signal, { config, now = new Date() } = {}) {
  try {
    const settings = config ?? loadConfig(project).config;
    if (!settings.lessons.auto) return null;
    const { file, project: from } = homeInbox(project, settings, { target: signal.target });
    const row = addRow({ ...signal, source: 'auto', now, ...(from ? { project: from } : {}) });
    withLocks([file], () => appendRow(file, row), { waitMs: 0 });
    return row;
  } catch {
    return null;
  }
}

// The delivery check sent a subagent back: its last message named files as written that do not exist (`missing`), or
// it ended its turn with no report the hook could write to a handoff file its brief named (`unwritten`). The note tells
// the two apart: a lesson that called an unwritten handoff "presented as written" sent its triage looking for a claim
// the agent never made. A plugin agent (`aidrian:<name>`) is the plugin's to fix; any other is the project's.
export function deliverySignal({ agentType, agentId = null, session = null, missing, unwritten = [] }) {
  const claims = missing.filter((file) => !unwritten.includes(file));
  const notes = [];
  if (claims.length) notes.push(`${agentType} presented ${claims.join(', ')} as written, and ${claims.length === 1 ? 'it did' : 'they did'} not exist.`);
  if (unwritten.length) notes.push(`${agentType} ended its turn with no report to write to the handoff file its brief named, ${unwritten.join(', ')}.`);
  const title = claims.length || !unwritten.length ? 'its report named files that did not exist' : 'it left the handoff file its brief named unwritten';
  return {
    key: `delivery-check:${agentType}`,
    tier: 'P2',
    kind: 'bug',
    target: agentType.startsWith('aidrian:') ? 'plugin' : 'project',
    title: `The delivery check sent ${agentType} back: ${title}`,
    note: notes.join(' '),
    evidence: agentId ? [`dispatch log: agent ${agentId}`] : [],
    session,
    agent: agentType,
  };
}

// A subagent ended its turn while a background shell or agent it started still ran, after the stop hook had sent it back
// `sendBacks` times in a row to wait (child-send-backs.mjs): it went idle with work in flight, and a subagent task's
// handback to an idle agent is refused. The rule and the hook are the plugin's.
export function idleChildrenSignal({ agentType, agentId = null, session = null, children, sendBacks = 1 }) {
  const kinds = [...new Set(children.map((child) => child.type))].join(', ');
  const times = sendBacks === 1 ? 'once' : `${sendBacks} times`;
  return {
    key: `idle-with-children:${agentType}`,
    tier: 'P2',
    kind: 'gap',
    target: 'plugin',
    title: `${agentType} went idle while a background task it started still ran`,
    note:
      `${agentType} ended its turn with ${children.length} background ${kinds} task${children.length === 1 ? '' : 's'} still running, ` +
      `after the stop hook sent it back ${times} in a row to wait in the foreground. A subagent task cannot hand its result back to an idle agent.`,
    evidence: [...children.map((child) => `background task ${child.id}`), ...(agentId ? [`dispatch log: agent ${agentId}`] : [])],
    session,
    agent: agentType,
  };
}

// The rules whose values the project writes, config.json `agents` and `tracker`: a block that keeps recurring is the
// project's to fix.
const PROJECT_RULES = new Set(['agent-gates', 'tracker-guard']);

// One of the plugin's blocking rules (lib/hook-deny.mjs) blocked one agent run REPEATED_DENIALS times for the same cause.
// `agentId` names the subagent run; none is the main thread.
export function denialSignal({ rule, session = null, agent = null, agentId = null }) {
  return {
    key: `hook-deny:${rule}`,
    tier: 'P2',
    kind: 'gap',
    target: PROJECT_RULES.has(rule) ? 'project' : 'plugin',
    title: `The ${rule} rule blocked one agent ${REPEATED_DENIALS} times for the same cause`,
    note:
      `${agent ?? 'An agent'} tried ${REPEATED_DENIALS} times in one run what the ${rule} rule blocks, and was blocked for the same cause each time. ` +
      'Neither its instructions nor the rule\'s message showed it the allowed way.',
    evidence: [...(session ? [`session ${session}`] : []), ...(agentId ? [`agent ${agentId}`] : [])],
    session,
    agent,
  };
}

// A tool the tracker write guard let run unjudged (tracker-guard.mjs unlistedTool). `once` makes it one occurrence per tool
// for good: a tool that only reads under a name the guard cannot tell, once its lesson is rejected, never reopens it.
export function unlistedToolSignal({ tool, session = null, agent = null }) {
  return {
    key: `tracker-unlisted:${tool}`,
    once: tool,
    tier: 'P2',
    kind: 'gap',
    target: 'project',
    title: `The tracker write guard did not judge ${tool}`,
    note:
      `${tool} ran on a server that tracker.readTools or tracker.writeTools names, and neither list names the tool, so the guard let it run. ` +
      'If it writes to the tracker, add it to tracker.writeTools; with tracker.provider set, that key replaces the adapter\'s whole list, so the fix is the adapter in the plugin. If it only reads, reject this lesson: this tool will not reopen it.',
    evidence: session ? [`session ${session}`] : [],
    session,
    agent,
  };
}

// `aidrian pr await-review` stopped at the review round limit, with `rounds` bot reviews on the pull request. A re-run that
// stops at the same count is the same event, so it is one occurrence and never reopens a resolved lesson.
export function roundLimitSignal({ repo, pr, maxRounds, rounds, session = null, agent = null }) {
  return {
    key: 'review-rounds',
    once: `${repo ?? ''}#${pr}@${rounds}`,
    tier: 'P2',
    kind: null,
    target: 'project',
    title: 'A pull request reached the bot review round limit',
    note: `Pull request #${pr}${repo ? ` in ${repo}` : ''} reached ${maxRounds} bot review rounds. More review rarely fixes that; look for the problem the rounds kept finding.`,
    evidence: repo ? [`https://github.com/${repo}/pull/${pr}`] : [],
    session,
    agent,
  };
}

// A session id or rule name that may name a file.
const FILE_NAME_PART = /^[\w-]+$/;
// The folder of the hooks' counts (project.mjs hookCountsFolder), which no confined session may write.
export { hookCountsFolder };
// The folder of one session's block counts, `<prefix><session>`, holds a `<rule>.<run>.<cause>` file per rule, agent
// run, and cause (denialCount), `<that>.recorded` after one that fired, and `<tool>.noted` per tool noted
// (noteUnlistedTool). One folder per session lets the session's end delete them by path alone. Every count is opened
// without following a link and without waiting (fs.mjs openOwnFile), in folders of this user that are no links.
const DENIALS_PREFIX = 'aidrian-denials-';
const denialsDir = (dir, session) => path.join(dir, `${DENIALS_PREFIX}${session}`);
const agentOf = (input, env) => (typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : sessionIdentity(env).agent);

// The file name of one count: the rule, the agent run (the payload's `agent_id`, or `main` for the main thread), and a
// digest of the cause, the rule's own words for what it matched (hook-deny.mjs firstSentence). Null for an id or rule
// that is no file name part.
function denialCount(input, rule, cause) {
  const run = input.agent_id === undefined || input.agent_id === null || input.agent_id === '' ? 'main' : input.agent_id;
  if (typeof run !== 'string' || !FILE_NAME_PART.test(run) || !FILE_NAME_PART.test(rule)) return null;
  const digest = createHash('sha256').update(typeof cause === 'string' ? cause : '').digest('hex').slice(0, 16);
  return `${rule}.${run}.${digest}`;
}

// Counts one block by `rule` for `cause` in the hook payload's agent run, and records the signal once the count reaches
// REPEATED_DENIALS, once per session, run, rule, and cause. Parallel subagents share their parent's session and may block
// at once, so the count is the size of a file in the hooks' counts folder that each block appends one byte to, and the
// block that creates the `.recorded` marker first is the one that records. A count whose file or folder is not a plain
// one of this user counts nothing. Never throws.
export function noteDenial(input, rule, { cause = '', dir, env = process.env, now = new Date() } = {}) {
  try {
    const session = input.session_id;
    const name = denialCount(input, rule, cause);
    if (typeof session !== 'string' || !FILE_NAME_PART.test(session) || !name) return null;
    const root = dir ?? hookCountsFolder(env);
    const folder = denialsDir(root, session);
    if (!ownFolderSync(root) || !ownFolderSync(folder)) return null;
    const file = path.join(folder, name);
    const fd = openOwnFile(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT);
    if (fd === null) return null;
    let size;
    try {
      writeSync(fd, '.');
      size = fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
    if (size < REPEATED_DENIALS) return null;
    try {
      closeSync(openSync(`${file}.recorded`, 'wx'));
    } catch {
      return null; // Another block already recorded it.
    }
    const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (!project) return null;
    const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null;
    const row = recordSignal(project, denialSignal({ rule, session, agent: agentOf(input, env), agentId }), { now });
    // Not recorded, such as when the inbox's lock was held: the next such block in this run tries again.
    if (!row) unlinkSync(`${file}.recorded`);
    return row;
  } catch {
    return null;
  }
}

// Records the signal of the unlisted tool in the hook payload, once per session and tool: the hook runs on every call of the
// tool, and the `<tool>.noted` marker keeps the inbox from growing a row per call. Parallel subagents share their parent's
// session, so the call that creates the marker first is the one that records. Never throws.
export function noteUnlistedTool(input, project, config, { dir, env = process.env, now = new Date() } = {}) {
  try {
    const { session_id: session, tool_name: tool } = input;
    if (!config.lessons.auto || typeof session !== 'string' || !FILE_NAME_PART.test(session) || !FILE_NAME_PART.test(tool)) return null;
    const root = dir ?? hookCountsFolder(env);
    const folder = denialsDir(root, session);
    if (!ownFolderSync(root) || !ownFolderSync(folder)) return null;
    const marker = path.join(folder, `${tool}.noted`);
    try {
      closeSync(openSync(marker, 'wx'));
    } catch {
      return null; // Another call already noted it.
    }
    const row = recordSignal(project, unlistedToolSignal({ tool, session, agent: agentOf(input, env) }), { config, now });
    // Not recorded, such as when the inbox's lock was held: the next call of the tool in this session tries again.
    if (!row) unlinkSync(marker);
    return row;
  } catch {
    return null;
  }
}

// Deletes the block counts of `session`, when it ends, by path, never by a listing. Never throws.
export function forgetDenials(session, { dir, env = process.env } = {}) {
  if (typeof session !== 'string' || !FILE_NAME_PART.test(session)) return;
  try {
    rmSync(denialsDir(dir ?? hookCountsFolder(env), session), { recursive: true, force: true });
  } catch {
    // sweepHookCounts removes them once they pass HOOK_COUNTS_AGE.
  }
}

// How long an entry of the hooks' counts folder lives, and the most entries one sweep reads.
export const HOOK_COUNTS_AGE = 7 * 24 * 60 * 60 * 1000;
const SWEEP_CAP = 2000;

// Removes the entries of the hooks' counts folder older than HOOK_COUNTS_AGE, as a session that never ended leaves them,
// reading at most SWEEP_CAP entries a call, one at a time, so the session-end hook that runs it stays inside its time.
// Never throws.
export function sweepHookCounts({ dir, env = process.env, now = Date.now() } = {}) {
  let handle;
  try {
    const folder = dir ?? hookCountsFolder(env);
    handle = opendirSync(folder);
    for (let seen = 0; seen < SWEEP_CAP; seen += 1) {
      const entry = handle.readSync();
      if (entry === null) break;
      const file = path.join(folder, entry.name);
      try {
        if (now - lstatSync(file).mtimeMs > HOOK_COUNTS_AGE) rmSync(file, { recursive: true, force: true });
      } catch {
        // Gone already.
      }
    }
  } catch {
    // No folder yet, or one this user cannot read.
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // Closed already.
    }
  }
}
