// Where each session's folders lie: the state folders a session started in, so the session-folder guard
// (lib/handoff-guard.mjs sessionFoldersWriteDenial) keeps a subagent out of them wherever it works later, in another
// project, in another checkout whose config moves `state.dir`, or in no project, and before the hooks first write there.
// The main session's SessionStart hook writes `<state root>/session-origins/<session id>.json`, `{ states, at }`, a list
// of absolute state folders, each added once, MAX_STATES at most; no subagent or unattended session may write the folder
// (handoff-guard.mjs stateFoldersWriteDenial). The folder is the user's alone, 0700, and each record 0600, written as
// lib/unattended-mark.mjs writes a mark: a random temporary file created only where nothing is, then a rename. An update
// reads and writes the record as one step under its reservations (session-folder.mjs exclusive), and every update, a
// resume's too, writes it again, so its time is fresh. A record untouched for STALE_DAYS goes when another is written.
// It names no host, forge, or tracker.

import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

import { checkoutHolding, processUid, resolvedPath } from './fs.mjs';
import { readOwnFile, SESSION_ID } from './handoff-markers.mjs';
import { stateRoot } from './project.mjs';
import { exclusive, LOCK_WINDOW_MS, reserveFile } from './session-folder.mjs';

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

const recordName = (session) => (typeof session === 'string' && SESSION_ID.test(session) ? `${session}.json` : null);

// The state folders the record `name` in `folder` holds, absolute paths, or [] for none: a record read as the store reads
// its own files (handoff-markers.mjs readOwnFile), opened no-follow and non-blocking, a regular file this user owns,
// within MAX_BYTES, and mode 0600, so a link, a named pipe, another user's file, or one others may read or write gives [].
function statesIn(folder, name) {
  const read = readOwnFile(path.join(folder, name), { cap: MAX_BYTES });
  if (read === null || (Number.isInteger(processUid()) && (read.stat.mode & 0o077) !== 0)) return [];
  try {
    const { states } = JSON.parse(read.text);
    return Array.isArray(states) ? states.filter((each) => typeof each === 'string' && path.isAbsolute(each)).slice(0, MAX_STATES) : [];
  } catch {
    return [];
  }
}

// The state folders recorded for `session`, absolute paths, [] for none or a record that cannot be read so. Never throws.
export function readOrigins(session, { env = process.env } = {}) {
  try {
    const name = recordName(session);
    return name === null ? [] : statesIn(originFolder(env), name);
  } catch {
    return [];
  }
}

// The origins folder, made the user's alone, after sweeping records past their age, or null when it is a symlink, not a
// folder, or another user's, as lib/unattended-mark.mjs ownFolder makes the marks' folder. Throws when it cannot be made.
function ownFolder(env, now) {
  const folder = originFolder(env);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const stat = lstatSync(folder);
  const uid = processUid();
  if (!stat.isDirectory() || (Number.isInteger(uid) && stat.uid !== uid)) return null;
  if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
  pruneStale(folder, now);
  return folder;
}

// Writes `value` to `<folder>/<name>`, owner-only, through a random temporary file created only where nothing is, then
// a rename; a failed rename deletes the temporary file. As lib/unattended-mark.mjs writeMark.
function writeRecord(folder, name, value) {
  const file = path.join(folder, name);
  const temporary = path.join(folder, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
  try {
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The sweep removes it later.
    }
    throw error;
  }
  return file;
}

// Whether the session folder writer would keep session folders under `state`: `checkouts`, the repository's checkouts
// as project.mjs projectCheckouts lists them, is a list, and neither the state folder nor its sessions folder resolves
// inside one of them (session-folder.mjs sessionFolder). A state the writer refuses holds no session folder to guard.
const held = (state, checkouts) => Array.isArray(checkouts)
  && [state, path.join(state, 'sessions')].map(resolvedPath).every((each) => each !== null && checkoutHolding(each, checkouts) === undefined);

// Adds the absolute state folder `state` to the record of `session`, when the session folder writer would keep session
// folders there by the checkouts `checkouts` of its own repository (held), and writes the record again when it holds
// it already, so a resumed session's record is fresh. The read and the write are one step under the record's
// reservations, so two SessionStart hooks of one session lose neither folder. Returns the record's file, or null when
// nothing could be written: a bad id or state, a state the writer refuses, a folder that is a link or another user's,
// reservations held past their wait, or a write the disk refuses. Never throws.
export function noteOrigin(session, state, { checkouts, env = process.env, now = Date.now() } = {}) {
  try {
    const name = recordName(session);
    if (name === null || typeof state !== 'string' || !path.isAbsolute(state) || !held(state, checkouts)) return null;
    const folder = ownFolder(env, now);
    if (!folder) return null;
    return exclusive((at) => reserveFile(folder, name, { windowMs: LOCK_WINDOW_MS, now: at }), () => {
      const states = statesIn(folder, name).filter((each) => each !== state);
      return writeRecord(folder, name, { states: [...states, state].slice(-MAX_STATES), at: now });
    }, null);
  } catch {
    return null;
  }
}

// Deletes what in `folder` was last changed more than STALE_DAYS before `now`: records, their reservations, and
// temporary files. Never throws.
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
