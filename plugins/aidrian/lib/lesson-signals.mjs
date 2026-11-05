// Automatic lessons: strong signals the plugin's hooks and commands already see, written to the lesson inbox as rows
// with a `key`. The first row of a key starts a lesson; every later one is that lesson seen again (lesson-inbox.mjs), so
// a signal dedupes itself and one recurring after a fix reopens it. Each signal fires only on an event that is rare by
// construction, and none ever changes what the hook or command that saw it does. config.json `lessons.auto: false`
// turns all of them off. Rows hold names, counts, paths, and ids; never a prompt, a command, or tool output.
// A signal with target `plugin` lands in the plugin's inbox, as `aidrian lesson add --target plugin` does.

import { appendFileSync, closeSync, mkdirSync, openSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { sessionIdentity } from './hosts/index.mjs';
import { appendRow, withLocks } from './jsonl.mjs';
import { addRow, homeInbox } from './lesson-inbox.mjs';
import { findProject } from './project.mjs';

// One block is a guard doing its job; this many of the same rule in one session is an agent fighting it.
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

// The delivery check sent a subagent back: its last message named files as written that do not exist.
// A plugin agent (`aidrian:<name>`) is the plugin's to fix; any other is the project's.
export function deliverySignal({ agentType, agentId = null, session = null, missing }) {
  return {
    key: `delivery-check:${agentType}`,
    tier: 'P2',
    kind: 'bug',
    target: agentType.startsWith('aidrian:') ? 'plugin' : 'project',
    title: `The delivery check sent ${agentType} back: its report named files that did not exist`,
    note: `${agentType} presented ${missing.join(', ')} as written, and ${missing.length === 1 ? 'it did' : 'they did'} not exist.`,
    evidence: agentId ? [`dispatch log: agent ${agentId}`] : [],
    session,
    agent: agentType,
  };
}

// A subagent ended its turn while a background shell or agent it started still ran, after the stop hook had already sent
// it back once to wait: it went idle, and the task's completion will not wake it. The rule and the hook are the plugin's.
export function idleChildrenSignal({ agentType, agentId = null, session = null, children }) {
  const kinds = [...new Set(children.map((child) => child.type))].join(', ');
  return {
    key: `idle-with-children:${agentType}`,
    tier: 'P2',
    kind: 'gap',
    target: 'plugin',
    title: `${agentType} went idle while a background task it started still ran`,
    note:
      `${agentType} ended its turn with ${children.length} background ${kinds} task${children.length === 1 ? '' : 's'} still running, ` +
      'after the stop hook sent it back once to wait in the foreground. Nothing wakes it when the task ends.',
    evidence: [...children.map((child) => `background task ${child.id}`), ...(agentId ? [`dispatch log: agent ${agentId}`] : [])],
    session,
    agent: agentType,
  };
}

// The rules whose values the project writes, config.json `agents` and `tracker`: a block that keeps recurring is the
// project's to fix.
const PROJECT_RULES = new Set(['agent-gates', 'tracker-guard']);

// One of the plugin's blocking rules (lib/hook-deny.mjs) blocked one session REPEATED_DENIALS times.
export function denialSignal({ rule, session = null, agent = null }) {
  return {
    key: `hook-deny:${rule}`,
    tier: 'P2',
    kind: 'gap',
    target: PROJECT_RULES.has(rule) ? 'project' : 'plugin',
    title: `The ${rule} rule blocked one session ${REPEATED_DENIALS} times`,
    note:
      `Agents tried ${REPEATED_DENIALS} times in one session what the ${rule} rule blocks. ` +
      'Neither their instructions nor the rule\'s message showed them the allowed way.',
    evidence: session ? [`session ${session}`] : [],
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
// The temporary folder of one session's block counts, `<prefix><session>`, holds a `<rule>` file per rule,
// `<rule>.recorded` after one that fired, and `<tool>.noted` per tool noted (noteUnlistedTool). One folder per session lets
// the session's end delete them by path alone.
const DENIALS_PREFIX = 'aidrian-denials-';
const denialsDir = (dir, session) => path.join(dir, `${DENIALS_PREFIX}${session}`);
const agentOf = (input, env) => (typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : sessionIdentity(env).agent);

// Counts one block by `rule` for the hook payload's session, and records the signal once the count reaches
// REPEATED_DENIALS, once per session and rule. Parallel subagents share their parent's session and may block at once,
// so the count is the size of a file in the temporary folder that each block appends one byte to, and the block that
// creates the `.recorded` marker first is the one that records. Never throws.
export function noteDenial(input, rule, { dir = tmpdir(), env = process.env, now = new Date() } = {}) {
  try {
    const session = input.session_id;
    if (typeof session !== 'string' || !FILE_NAME_PART.test(session) || !FILE_NAME_PART.test(rule)) return null;
    const folder = denialsDir(dir, session);
    mkdirSync(folder, { recursive: true });
    const file = path.join(folder, rule);
    appendFileSync(file, '.');
    if (statSync(file).size < REPEATED_DENIALS) return null;
    try {
      closeSync(openSync(`${file}.recorded`, 'wx'));
    } catch {
      return null; // Another block already recorded it.
    }
    const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (!project) return null;
    const row = recordSignal(project, denialSignal({ rule, session, agent: agentOf(input, env) }), { now });
    // Not recorded, such as when the inbox's lock was held: the next block of the rule in this session tries again.
    if (!row) unlinkSync(`${file}.recorded`);
    return row;
  } catch {
    return null;
  }
}

// Records the signal of the unlisted tool in the hook payload, once per session and tool: the hook runs on every call of the
// tool, and the `<tool>.noted` marker keeps the inbox from growing a row per call. Parallel subagents share their parent's
// session, so the call that creates the marker first is the one that records. Never throws.
export function noteUnlistedTool(input, project, config, { dir = tmpdir(), env = process.env, now = new Date() } = {}) {
  try {
    const { session_id: session, tool_name: tool } = input;
    if (!config.lessons.auto || typeof session !== 'string' || !FILE_NAME_PART.test(session) || !FILE_NAME_PART.test(tool)) return null;
    const folder = denialsDir(dir, session);
    mkdirSync(folder, { recursive: true });
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

// Deletes the block counts of `session`, when it ends, by path: the temporary folder can hold more than a hundred
// thousand entries, and listing it would eat the session-end hook's time budget. Never throws.
export function forgetDenials(session, { dir = tmpdir() } = {}) {
  if (typeof session !== 'string' || !FILE_NAME_PART.test(session)) return;
  try {
    rmSync(denialsDir(dir, session), { recursive: true, force: true });
  } catch {
    // The temporary folder clears them in time.
  }
}
