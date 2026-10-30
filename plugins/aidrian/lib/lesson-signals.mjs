// Automatic lessons: strong signals the plugin's hooks and commands already see, written to the lesson inbox as rows
// with a `key`. The first row of a key starts a lesson; every later one is that lesson seen again (lesson-inbox.mjs), so
// a signal dedupes itself and one recurring after a fix reopens it. Each signal fires only on an event that is rare by
// construction, and none ever changes what the hook or command that saw it does. config.json `lessons.auto: false`
// turns all of them off. Rows hold names, counts, paths, and ids; never a prompt, a command, or tool output.

import { readFileSync, writeFileSync } from 'node:fs';
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

// A Bash or write rule blocked one session REPEATED_DENIALS times.
export function denialSignal({ rule, session = null, agent = null }) {
  return {
    key: `hook-deny:${rule}`,
    tier: 'P2',
    kind: 'gap',
    target: 'plugin',
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

// Counts one block by `rule` for the hook payload's session, in a file in the temporary folder, and records the signal
// on the block that reaches REPEATED_DENIALS, once per session and rule. Never throws.
export function noteDenial(input, rule, { dir = tmpdir(), env = process.env, now = new Date() } = {}) {
  try {
    const session = input.session_id;
    if (typeof session !== 'string' || !/^[\w-]+$/.test(session)) return null;
    const file = path.join(dir, `aidrian-denials-${session}.json`);
    let counts = {};
    try {
      counts = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // The session's first block.
    }
    counts[rule] = (Number.isInteger(counts[rule]) ? counts[rule] : 0) + 1;
    writeFileSync(file, JSON.stringify(counts));
    if (counts[rule] !== REPEATED_DENIALS) return null;
    const project = findProject(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (!project) return null;
    const agent = typeof input.agent_type === 'string' && input.agent_type ? input.agent_type : env.CLAUDE_CODE_AGENT || null;
    return recordSignal(project, denialSignal({ rule, session, agent }), { now });
  } catch {
    return null;
  }
}
