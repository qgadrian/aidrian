// The agent gates a session started with. A subagent's change to the files that set the gates, such as deleting
// config.json or replacing it, must not lift a gate for the rest of the session, and the config guard cannot see every
// write. So at SessionStart, scripts/hook-session-start.mjs saves the effective `agents` (config.json and the local file
// together), and scripts/hook-agent-gates.mjs enforces them for every subagent call beside the current config: a change
// during the session can add a gate, never lift one. A later SessionStart of the same session, such as after a
// compaction, adds the gates then in force. SessionEnd deletes the file.
// It lives in the state root, `$XDG_STATE_HOME/aidrian/sessions/<session id>.json`, not in the project's state folder:
// config.json `state.dir` moves that folder, and config.json is the file a subagent might change.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { agentNameProblem, patternProblem } from './agent-gates.mjs';
import { isObject } from './fs.mjs';
import { stateRoot } from './project.mjs';

// A session id that may name a file.
const SESSION_ID = /^[\w-]{1,128}$/u;
// A snapshot left by a session that never reached SessionEnd, such as one that crashed, goes after this many days.
const STALE_DAYS = 30;

// The snapshot file of `sessionId`, or null when the id cannot name a file.
export function snapshotPath(sessionId, { env = process.env } = {}) {
  return typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? path.join(stateRoot(env), 'sessions', `${sessionId}.json`) : null;
}

// Adds `agents`, a config's effective `agents`, to the snapshot of `sessionId` for the project at `root`, unless it holds
// them already. Writes nothing without gates, and never replaces a snapshot it cannot read: that one keeps subagents to
// reading until a new session starts. Returns the file it wrote, or null. Never throws.
export function saveGateSnapshot(sessionId, root, agents, { env = process.env, now = Date.now() } = {}) {
  try {
    const file = snapshotPath(sessionId, { env });
    if (!file || !isObject(agents) || Object.keys(agents).length === 0) return null;
    const found = readSnapshotFile(file);
    if (found?.problem) return null;
    const gates = found?.gates ?? [];
    if (gates.some((each) => isDeepStrictEqual(each, agents))) return file;
    mkdirSync(path.dirname(file), { recursive: true });
    pruneStale(path.dirname(file), now);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ root: found?.root ?? root, gates: [...gates, agents] })}\n`);
    renameSync(temporary, file);
    return file;
  } catch {
    return null;
  }
}

// The snapshot of the hook payload's session: { file, root, gates }, where `gates` lists `agents` objects, each enforced;
// { file, problem } when the file is there but is not a snapshot this module wrote; null when there is none.
export function readGateSnapshot(input, { env = process.env } = {}) {
  const file = snapshotPath(input?.session_id, { env });
  return file ? readSnapshotFile(file) : null;
}

// Deletes the snapshot of `sessionId`, when the session ends. Never throws.
export function forgetGateSnapshot(sessionId, { env = process.env } = {}) {
  const file = snapshotPath(sessionId, { env });
  if (!file) return;
  try {
    unlinkSync(file);
  } catch {
    // Nothing to delete, or the stale-file sweep removes it later.
  }
}

function readSnapshotFile(file) {
  let text;
  try {
    if (lstatSync(file).isSymbolicLink()) return { file, problem: 'it is a symlink' };
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return error.code === 'ENOENT' ? null : { file, problem: error.code ?? 'unreadable' };
  }
  try {
    const value = JSON.parse(text);
    if (isObject(value) && typeof value.root === 'string' && path.isAbsolute(value.root) && Array.isArray(value.gates) && value.gates.every(isGateSet)) {
      return { file, root: value.root, gates: value.gates };
    }
  } catch {
    // Not JSON: the same answer as the wrong shape.
  }
  return { file, problem: 'it is not a gate snapshot' };
}

// Whether `value` has the shape config.mjs gives `agents`, every name and pattern valid, so gateDenial can read it.
function isGateSet(value) {
  return isObject(value) && Object.entries(value).every(([name, lists]) => agentNameProblem(name) === null && isObject(lists)
    && Object.entries(lists).every(([list, patterns]) => ['deny', 'allow'].includes(list) && Array.isArray(patterns)
      && patterns.every((pattern) => patternProblem(pattern) === null)));
}

function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > STALE_DAYS * 24 * 60 * 60 * 1000) unlinkSync(file);
    } catch {
      // Gone already, or another session's sweep got it.
    }
  }
}
