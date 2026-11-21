// The session a Claude Code session went on as (`capabilities.continuedIn`), for custody of a project run
// (lib/project-run-guard.mjs custody). The host can continue a session under a new id, as on a resume that forks it: it
// writes a `continued-in` row, { type, timestamp, sessionId, continuedInSessionId }, at the end of the old session's
// transcript, and the new session starts with a `derived-from` row whose `via` is `fork`. Seen live on 2026-11-21: a
// project run's driver session became another id mid-run, and every driver command was refused. Only the old
// transcript's own row is read: a `derived-from` row alone also marks a branch, which leaves the old session running.
// A `user` or `assistant` entry of the old session after the row voids it: that session went on itself.
// Only the transcript of the folder the session started in is read, `<config folder>/projects/<that folder, each
// character but a letter or digit as ->/<session>.jsonl`: no other project's file, which any session could write, stands
// in for it. The config folder comes from the caller's environment: the agent gate hook, which authorizes every driver
// command first, reads it from the host's own.

import path from 'node:path';

import { tailObjects } from '../fs.mjs';
import { configFolder } from './claude-code-sandbox.mjs';

// How much of the old transcript's end is read: the row is its last.
const TAIL = 64 * 1024;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;

// The session `session`, started in the folder `cwd`, was continued in, as { id, at }, `at` the row's time in
// milliseconds, or null when its transcript records none, or cannot be read. `env` and `home` find the host's config
// folder.
export function continuedIn({ session, cwd, env = process.env, home } = {}) {
  if (typeof session !== 'string' || !ID.test(session) || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const file = path.join(configFolder(env, home), 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'), `${session}.jsonl`);
  const rows = tailObjects(file, TAIL);
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
