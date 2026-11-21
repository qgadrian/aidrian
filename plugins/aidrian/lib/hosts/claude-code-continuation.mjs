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
// read in the folder of `cwd` first, else in any project folder there, as lib/hosts/claude-code-limit.mjs reads it.

import { readdirSync } from 'node:fs';
import path from 'node:path';

import { tailObjects } from '../fs.mjs';
import { configFolder } from './claude-code-sandbox.mjs';

// How much of the old transcript's end is read: the row is its last.
const TAIL = 64 * 1024;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;

// The transcript files of `session`, the one of `cwd`'s folder first.
function transcriptFiles({ session, cwd, env, home }) {
  const projects = path.join(configFolder(env, home), 'projects');
  const name = `${session}.jsonl`;
  const first = typeof cwd === 'string' ? [path.join(projects, cwd.replace(/[^A-Za-z0-9]/gu, '-'), name)] : [];
  let folders = [];
  try {
    folders = readdirSync(projects);
  } catch {
    // No projects folder: no transcript.
  }
  return [...new Set([...first, ...folders.map((folder) => path.join(projects, folder, name))])];
}

// The session `session` was continued in, as { id, at }, `at` the row's time in milliseconds, or null when the first
// transcript of it that can be read records none. `cwd` is the folder it likely started in; `env` and `home` find the
// host's config folder.
export function continuedIn({ session, cwd, env = process.env, home } = {}) {
  if (typeof session !== 'string' || !ID.test(session)) return null;
  for (const file of transcriptFiles({ session, cwd, env, home })) {
    const rows = tailObjects(file, TAIL);
    if (rows === null) continue;
    const index = rows.findLastIndex((row) => row.type === 'continued-in' && row.sessionId === session);
    if (index < 0) return null;
    const row = rows[index];
    const went = rows.slice(index + 1).some((later) => (later.type === 'user' || later.type === 'assistant') && later.sessionId === session);
    const at = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN;
    const id = row.continuedInSessionId;
    if (went || !Number.isFinite(at) || typeof id !== 'string' || !ID.test(id) || id === session) return null;
    return { id, at };
  }
  return null;
}
