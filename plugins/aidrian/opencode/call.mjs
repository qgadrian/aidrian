// What one OpenCode tool event sends a hook script: the folder the script is spawned in, the folder the call runs in, and
// who made the call, from the event and the session reads. bridge.mjs builds the payload and spawns from this. It imports
// node: built-ins alone, so it loads in OpenCode's Bun and under `node --test` alike.
//
// A blocking route (execute.before) never skips a call for a reason the call's input controls: a `workdir` that names no
// folder, or an input of another shape, still sends the call, with the session's folder as its `cwd`. Only a call with no
// session id, which OpenCode sets and the input cannot, sends nothing. A record-only route (execute.after) runs, as a
// hook of a host that reads hooks.json does, only after a call that completed, on a Bash call only with a string
// command, and only when it knows the folder the call ran in: the session's folder, read and on disk, or one an
// absolute or `~` workdir names. A session folder that is gone or could not be read is never replaced there by the
// plugin's folder or the service's, which may be another checkout.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// How many sessions the root walk reads at most, how many answers it keeps before it forgets them all, and how long all
// the session reads of one call may take together: past that the call is sent with what was read.
const PARENT_STEPS = 8;
const ROOTS_MAX = 256;
export const READ_MS = 2000;

const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isFolder = (dir) => {
  try {
    return absolute(dir) && statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// What one event of the standard tool `name` sends, { base, cwd, event, root, agent, info }, or { skip: <why> }:
// `base` the folder the script is spawned in, `cwd` the payload's, `root` the root of the calling session's tree, and
// `agent` the calling session's id when the call is not the root session's own, or when who made it could not be read.
export async function callOf(runner, { blocking, name, event, info }) {
  if (!blocking && event.status !== 'completed') return { skip: 'status' };
  if (!blocking && name === 'Bash' && typeof event.input?.command !== 'string') return { skip: 'command' };
  if (typeof event.sessionID !== 'string' || event.sessionID === '') return { skip: 'session' };
  const reads = readsOf(runner.context, READ_MS);
  let session;
  try {
    session = await sessionOf(runner, reads.get, event.sessionID);
  } finally {
    reads.end();
  }
  const own = runner.context.location?.directory;
  const base = [session.dir, own].find(isFolder) ?? process.cwd();
  const home = absolute(runner.env?.HOME) ? runner.env.HOME : homedir();
  const workdir = isObject(event.input) ? event.input.workdir : undefined;
  const given = workdir !== undefined && workdir !== null && workdir !== '';
  const cwd = given ? folderOf(workdir, absolute(session.dir) ? session.dir : base, home) : base;
  // The call's folder is known when the session's folder is one, or when the workdir names a folder by itself: a
  // record-only route never records a call under the plugin's folder or the service's in its place.
  const known = isFolder(session.dir) || (typeof workdir === 'string' && path.isAbsolute(expandedOf(workdir, home)));
  if (!blocking && (cwd === null || !known)) return { skip: 'cwd' };
  return { base, cwd: cwd ?? base, event, root: session.root, agent: session.agent, info };
}

// A workdir with `~` and `~/` taken from `home`, as OpenCode 2.4.1's shell tool expands them.
const expandedOf = (workdir, home) => (workdir === '~' || workdir.startsWith('~/') ? path.join(home, workdir.slice(1)) : workdir);

// The folder a shell call's `workdir` names, as OpenCode 2.4.1's shell tool resolves it: `~` and `~/` from `home`,
// then the result resolved against `dir`, the session's folder, by path alone, an absolute one included, so its dot
// segments are normalized; null for one that is no text or names no folder, as another machine's `name:/path` does
// here.
export function folderOf(workdir, dir, home) {
  if (typeof workdir !== 'string') return null;
  const folder = path.resolve(dir, expandedOf(workdir, home));
  return isFolder(folder) ? folder : null;
}

// The calling session `sessionID`'s { root, agent, dir }: its own folder from a read on every call, as a session can
// move, and its root by its parents, PARENT_STEPS reads at most. A read that fails, comes too late, or gives no object,
// and a walk that runs out of steps, stop where they are, and the call is sent as a subagent's, with `agent` the
// calling id, never as the root session's own; only a walk that reached its end is kept, so the next call reads again.
// A kept root answers only a call whose own read gave the session: one whose read failed is a subagent's, kept or not,
// with its kept root still as `root`, so a kept child's call keeps its root's session-keyed holds. A kept answer comes
// only from a walk that reached its end for that same id, and a session's parent never changes, so it still holds.
async function sessionOf(runner, get, sessionID) {
  let current;
  try {
    current = await get(sessionID);
  } catch {
    current = null;
  }
  const known = runner.roots.get(sessionID);
  if (!isObject(current)) return { root: known?.root ?? sessionID, agent: sessionID, dir: null };
  const dir = current.location?.directory ?? null;
  if (known) return { ...known, dir };
  let id = sessionID;
  let ended = false;
  try {
    for (let read = 1; isObject(current); read += 1) {
      const parent = current.parentID;
      if (typeof parent !== 'string' || parent === '' || parent === id) {
        ended = true;
        break;
      }
      id = parent;
      if (read >= PARENT_STEPS) break;
      current = await get(id);
    }
  } catch {
    ended = false;
  }
  const answer = { root: id, agent: !ended || id !== sessionID ? sessionID : null };
  if (ended) {
    if (runner.roots.size >= ROOTS_MAX) runner.roots.clear();
    runner.roots.set(sessionID, answer);
  }
  return { ...answer, dir };
}

// The text of the session `sessionID`'s last assistant message, its text parts joined, or null when there is none or the
// read fails or takes longer than `ms`. OpenCode 2.4.1's `session.context` gives every message since the latest
// compaction, with no cap of its own, so the bridge's cap is the read's only bound.
export async function lastAssistantText(context, sessionID, ms = READ_MS) {
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const messages = await Promise.race([Promise.resolve().then(() => context.session.context({ sessionID })), late]);
    if (!Array.isArray(messages)) return null;
    const last = messages.findLast((message) => isObject(message) && message.type === 'assistant');
    const content = Array.isArray(last?.content) ? last.content : [];
    const texts = content.filter((part) => isObject(part) && part.type === 'text' && typeof part.text === 'string').map((part) => part.text);
    return texts.length > 0 ? texts.join('\n\n') : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The session reads of one call under one timer of `ms`: `get(id)` gives what `context.session.get` gives, and throws,
// as a failed read does, for a read that throws or rejects and for one not settled by then. `end` stops the timer.
function readsOf(context, ms) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('the session reads ran out of time')), ms);
  });
  late.catch(() => {});
  const get = (sessionID) => Promise.race([Promise.resolve().then(() => context.session.get({ sessionID })), late]);
  return { get, end: () => clearTimeout(timer) };
}
