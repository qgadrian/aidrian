// Where each session's folders lie: the state folders a session started in, so the session-folder guard
// (lib/handoff-guard.mjs sessionFoldersWriteDenial) keeps a subagent out of them wherever it works later, in another
// project, in another checkout whose config moves `state.dir`, or in no project, and before the hooks first write there.
// The main session's SessionStart hook writes `<state root>/session-origins/<session id>.json`, `{ states, at }`, a list
// of absolute state folders, each added once, MAX_STATES at most; no subagent or unattended session may write the folder
// (handoff-guard.mjs stateFoldersWriteDenial). A record untouched for STALE_DAYS goes when another is written. It names
// no host, forge, or tracker.

import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { SESSION_ID } from './handoff-markers.mjs';
import { stateRoot } from './project.mjs';

export const ORIGIN_FOLDER = 'session-origins';
export const MAX_STATES = 8;
const STALE_DAYS = 30;
const MAX_BYTES = 16 * 1024;

// The origins folder under the state root `env` names.
export const originFolder = (env = process.env) => path.join(stateRoot(env), ORIGIN_FOLDER);

// Every folder an origin record may be written in, for the guard: the state root's, as `env` names it, and the user's
// own, under `home`, as lib/terminal-replace.mjs terminalFolders.
export function originFolders({ env = process.env, home } = {}) {
  const folders = [];
  try {
    folders.push(originFolder(env));
  } catch {
    // A state root the environment cannot give: the user's own still holds.
  }
  try {
    folders.push(path.join(home ?? userInfo().homedir, '.local/state', 'aidrian', ORIGIN_FOLDER));
  } catch {
    // No user record: the environment's root alone.
  }
  return [...new Set(folders.map((folder) => path.resolve(folder)))];
}

const recordOf = (session, env) => (typeof session === 'string' && SESSION_ID.test(session) ? path.join(originFolder(env), `${session}.json`) : null);

// The state folders recorded for `session`, absolute paths, [] for none or a record that cannot be read. Never throws.
export function readOrigins(session, { env = process.env } = {}) {
  try {
    const file = recordOf(session, env);
    if (file === null || !lstatSync(file).isFile()) return [];
    const { states } = JSON.parse(readFileSync(file, 'utf8').slice(0, MAX_BYTES));
    return Array.isArray(states) ? states.filter((each) => typeof each === 'string' && path.isAbsolute(each)).slice(0, MAX_STATES) : [];
  } catch {
    return [];
  }
}

// Adds the absolute state folder `state` to the record of `session`, unless it holds it, through a temporary file and a
// rename, mode 0600. Returns the record's file, or null when nothing could be written. Never throws.
export function noteOrigin(session, state, { env = process.env, now = Date.now() } = {}) {
  try {
    const file = recordOf(session, env);
    if (file === null || typeof state !== 'string' || !path.isAbsolute(state)) return null;
    const states = readOrigins(session, { env });
    if (states.includes(state)) return file;
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    pruneStale(path.dirname(file), now);
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ states: [...states, state].slice(-MAX_STATES), at: now })}\n`, { mode: 0o600 });
    renameSync(temporary, file);
    return file;
  } catch {
    return null;
  }
}

function pruneStale(folder, now) {
  for (const name of readdirSync(folder)) {
    try {
      const file = path.join(folder, name);
      if (now - lstatSync(file).mtimeMs > STALE_DAYS * 24 * 60 * 60 * 1000) unlinkSync(file);
    } catch {
      // Gone already.
    }
  }
}
