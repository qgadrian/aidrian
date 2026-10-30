// Automatic lessons: strong signals the plugin's hooks and commands already see, written to the lesson inbox as rows
// with a `key`. The first row of a key starts a lesson; every later one is that lesson seen again (lesson-inbox.mjs), so
// a signal dedupes itself and one recurring after a fix reopens it. Each signal fires only on an event that is rare by
// construction, and none ever changes what the hook or command that saw it does. config.json `lessons.auto: false`
// turns all of them off. Rows hold names, counts, paths, and ids; never a prompt, a command, or tool output.

import { appendFileSync, closeSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { appendRow } from './jsonl.mjs';
import { addRow, inboxPath } from './lesson-inbox.mjs';
import { findProject } from './project.mjs';

// One block is a guard doing its job; this many of the same rule in one session is an agent fighting it.
export const REPEATED_DENIALS = 3;

// Appends the signal's row and returns it; null when the project turned signals off or anything failed.
export function recordSignal(project, signal, { config, now = new Date() } = {}) {
  try {
    const settings = config ?? loadConfig(project).config;
    if (!settings.lessons.auto) return null;
    const row = addRow({ ...signal, source: 'auto', now });
    appendRow(inboxPath(project, settings), row);
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

// The rule whose patterns the project writes, config.json `agents`: a block that keeps recurring is the project's to fix.
const PROJECT_RULES = new Set(['agent-gates']);

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
// The temporary files of one session's block counts: `<prefix><session>.<rule>`, and `.recorded` after one that fired.
const DENIALS_PREFIX = 'aidrian-denials-';

// Counts one block by `rule` for the hook payload's session, and records the signal once the count reaches
// REPEATED_DENIALS, once per session and rule. Parallel subagents share their parent's session and may block at once,
// so the count is the size of a file in the temporary folder that each block appends one byte to, and the block that
// creates the `.recorded` marker first is the one that records. Never throws.
export function noteDenial(input, rule, { dir = tmpdir(), env = process.env, now = new Date() } = {}) {
  try {
    const session = input.session_id;
    if (typeof session !== 'string' || !FILE_NAME_PART.test(session) || !FILE_NAME_PART.test(rule)) return null;
    const file = path.join(dir, `${DENIALS_PREFIX}${session}.${rule}`);
    appendFileSync(file, '.');
    if (statSync(file).size < REPEATED_DENIALS) return null;
    try {
      closeSync(openSync(`${file}.recorded`, 'wx'));
    } catch {
      return null; // Another block already recorded it.
    }
    const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (!project) return null;
    const agent = typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : env.CLAUDE_CODE_AGENT || null;
    return recordSignal(project, denialSignal({ rule, session, agent }), { now });
  } catch {
    return null;
  }
}

// Deletes the block counts of `session`, when it ends. Never throws.
export function forgetDenials(session, { dir = tmpdir() } = {}) {
  if (typeof session !== 'string' || !FILE_NAME_PART.test(session)) return;
  try {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(`${DENIALS_PREFIX}${session}.`)) unlinkSync(path.join(dir, name));
    }
  } catch {
    // The temporary folder clears them in time.
  }
}
