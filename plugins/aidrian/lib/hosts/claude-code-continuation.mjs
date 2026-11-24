// The session a Claude Code session went on as (`capabilities.continuedIn`), for a project run whose driver the host
// continued (lib/project-run-gate.mjs strandedDriver). The host can continue a session under a new id, as on a resume
// that forks it: it writes a `continued-in` row, { type, timestamp, sessionId, continuedInSessionId }, at the end of the
// old session's transcript, and the new session starts with a `derived-from` row whose `via` is `fork`. Seen live on
// 2026-11-21: a project run's driver session became another id mid-run, and every driver command was refused. Only the
// old transcript's own row is read: a `derived-from` row alone also marks a branch, which leaves the old session
// running. A `user` or `assistant` entry of the old session after the row voids it: that session went on itself.
// The row grants nothing by itself: it says the old session runs no more, so an attended `aidrian project resume` may
// take custody, as for a driver the host lists as ended.
// The transcript is `<config folder>/projects/<start folder, each character but a letter or digit as ->/<session>.jsonl`,
// The copy in the folder of `cwd`, the folder the session started in, is read; with none there, the one copy in any
// other project folder, and none when several are, since which is the live one cannot be told.

import { lstatSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { tailObjects } from '../fs.mjs';
import { configFolder } from './claude-code-sandbox.mjs';

// How much of the old transcript's end is read: the row is its last.
const TAIL = 64 * 1024;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;

// The folder of the project folders that hold a session's transcripts, as continuedIn reads them: under the config
// folder `env` names (CLAUDE_CONFIG_DIR), else under `home`, else under `env.HOME`. The transcript guard takes its
// folders from here too (claude-code.mjs transcriptFolders), so it protects the folder this reader reads.
export const transcriptRoot = (env = process.env, home) => path.join(configFolder(env, home), 'projects');

// The transcript of `session`: the one in `cwd`'s project folder, else the only one in any project folder, or null.
function transcriptFile({ session, cwd, env, home }) {
  const projects = transcriptRoot(env, home);
  const name = `${session}.jsonl`;
  const isFile = (file) => {
    try {
      return lstatSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (typeof cwd === 'string') {
    const own = path.join(projects, cwd.replace(/[^A-Za-z0-9]/gu, '-'), name);
    if (isFile(own)) return own;
  }
  let folders = [];
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  const found = folders.map((folder) => path.join(projects, folder, name)).filter(isFile);
  return found.length === 1 ? found[0] : null;
}

// The session `session` was continued in, as { id, at }, `at` the row's time in milliseconds, or null when its
// transcript records none, or cannot be read. `cwd` is the folder it started in; `env` and `home` find the host's
// config folder.
export function continuedIn({ session, cwd, env = process.env, home } = {}) {
  if (typeof session !== 'string' || !ID.test(session)) return null;
  const file = transcriptFile({ session, cwd, env, home });
  const rows = file ? tailObjects(file, TAIL) : null;
  if (rows === null) return null;
  const index = rows.findLastIndex((row) => row.type === 'continued-in' && row.sessionId === session);
  if (index < 0) return null;
  const row = rows[index];
  const went = rows.slice(index + 1).some((later) => (later.type === 'user' || later.type === 'assistant') && later.sessionId === session);
  const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
  const id = row.continuedInSessionId;
  if (went || !Number.isFinite(at) || typeof id !== 'string' || !ID.test(id) || id === session) return null;
  return { id, at };
}
