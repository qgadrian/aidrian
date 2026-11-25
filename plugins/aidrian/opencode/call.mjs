// Who one OpenCode event's hooks run for, and where: for a tool event, the folder the script is spawned in, the folder the
// call runs in, and who made the call (callOf), and for a session event, the session's root and the two folders its hooks
// run in (sessionCall), from the event and the session reads, and for a session's end, whether it is a root and its last
// folder, from what the bridge kept (endCall). bridge.mjs and session-hooks.mjs build the payload and spawn
// from this. It imports node: built-ins alone, so it loads in OpenCode's Bun and under `node --test` alike.
//
// A blocking route (execute.before) never skips a call for a reason the call's input controls: a `workdir` that names no
// folder, or an input of another shape, still sends the call, with the session's folder as its `cwd`. Only a call with no
// session id, which OpenCode sets and the input cannot, sends nothing. A record-only route (execute.after) runs, as a
// hook of a host that reads hooks.json does, only after a call that completed, on a Bash call only with a string
// command, and only when it knows the folder the call ran in: the session's folder, read and on disk, or one an
// absolute or `~` workdir names. Only a Bash call has a workdir: OpenCode's shell tool alone runs where that field says,
// and another tool's input, such as an MCP call's, may hold a field of that name. A session folder that is gone or could not be read is never replaced there by the
// plugin's folder or the service's, which may be another checkout.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// How many sessions the root walk reads at most, how many parent links, the last used, and root folders the bridge keeps,
// and how long all the session reads of one call may take together: past that the call is sent with what was read.
const PARENT_STEPS = 8;
const ROOTS_MAX = 256;
export const READ_MS = 2000;

const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
// A read gave the session `id` only when it is an object whose own `id` is that id, as OpenCode 2.4.1's Session.Info
// always carries; any other object, such as {} or an error's, counts as a failed read.
const isSession = (value, id) => isObject(value) && value.id === id;
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
  // The session's folder is looked up on disk once: `base`, the cwd of a call with no workdir, and `known` all come from
  // that one answer, so a folder that comes or goes between two looks can neither record a call under the plugin's
  // folder nor drop one.
  const sessionFolder = isFolder(session.dir) ? session.dir : null;
  const own = runner.context.location?.directory;
  const base = sessionFolder ?? (isFolder(own) ? own : process.cwd());
  const home = absolute(runner.env?.HOME) ? runner.env.HOME : homedir();
  const workdir = name === 'Bash' && isObject(event.input) ? event.input.workdir : undefined;
  const given = workdir !== undefined && workdir !== null && workdir !== '';
  const cwd = given ? folderOf(workdir, absolute(session.dir) ? session.dir : base, home) : base;
  // The call's folder is known when the session's folder is one, or when the workdir names a folder by itself: a
  // record-only route never records a call under the plugin's folder or the service's in its place.
  const known = sessionFolder !== null || (typeof workdir === 'string' && path.isAbsolute(expandedOf(workdir, home)));
  if (!blocking && (cwd === null || !known)) return { skip: 'cwd' };
  return { base, cwd: cwd ?? base, event, root: session.root, agent: session.agent, info };
}

// Traces a `skip` for each route of a call sent nothing, and gives that call.
export function skipped(runner, routes, call) {
  for (const route of routes) runner.trace('skip', { script: route.script, status: call.skip });
  return call;
}

// The `opencode` mark of a payload: the plugin context's `app.version` when it is text, as OpenCode 2.4.0's plugin
// context names it, and `fields`.
export function markOf(context, fields) {
  const version = context?.app?.version;
  return typeof version === 'string' ? { version, ...fields } : { ...fields };
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

// The calling session `sessionID`'s { root, agent, dir, rootDir, failed? }: its own folder and its root's, and its root by
// its parents, all read on every call, as a session can move, PARENT_STEPS reads at most. Each parent a read named is kept
// as a link in `runner.roots`, the child's id to its parent's, so a session a read once named a parent for is a child for
// that setup, whatever a later read gives. The walk finishes at a session whose read names no parent and that holds no
// link, and that is the root: the call is the root session's own only when the walk finished with no step taken. Any other
// walk, one whose read fails, comes too late, or gives no session of the id asked for, one that runs out of steps, and one
// that ends at a linked session, sets `failed`: the call is sent as a subagent's, with `agent` the calling id and `root`
// where the links lead, never as the root session's own. A link drops any folder kept for the child as a root, and a
// finished walk keeps its root's for its end (endCall). A walk is resolved by the links held with its own, and only then,
// past ROOTS_MAX, do the least recently stored or followed go. Nothing is awaited between the last read and the last store, so two calls
// in flight cannot undo each other's.
async function sessionOf(runner, get, sessionID) {
  const own = await readOf(get, sessionID);
  const links = [];
  let id = sessionID;
  let last = own;
  while (last !== null && last.parent !== null) {
    links.push([id, last.parent]);
    id = last.parent;
    last = links.length < PARENT_STEPS ? await readOf(get, id) : null;
  }
  for (const [child, parent] of links) {
    use(runner, child, parent);
    runner.folders.delete(child);
  }
  const finished = last !== null && !runner.roots.has(id);
  const root = finished ? id : linkedRoot(runner, sessionID);
  for (const oldest of runner.roots.keys()) {
    if (runner.roots.size <= ROOTS_MAX) break;
    runner.roots.delete(oldest);
  }
  const dir = own?.dir ?? null;
  if (!finished) return { root, agent: sessionID, dir, rootDir: null, failed: true };
  remember(runner, root, last.dir);
  return { root, agent: links.length === 0 ? null : sessionID, dir, rootDir: last.dir };
}

// What one read gave of the session `id`, { parent, dir }, `parent` null when it names none or itself, or null when the
// read failed, came late, or gave no such session.
async function readOf(get, id) {
  try {
    const session = await get(id);
    if (!isSession(session, id)) return null;
    const { parentID } = session;
    const names = typeof parentID === 'string' && parentID !== '' && parentID !== id;
    return { parent: names ? parentID : null, dir: session.location?.directory ?? null };
  } catch {
    return null;
  }
}

// Where the kept links lead from the session `id`, PARENT_STEPS of them at most, each then the last used: `id` itself when
// it holds none.
function linkedRoot(runner, id) {
  let root = id;
  for (let step = 0; step < PARENT_STEPS && runner.roots.has(root); step += 1) {
    const parent = runner.roots.get(root);
    use(runner, root, parent);
    root = parent;
  }
  return root;
}

// Keeps the link from `child` to `parent` as the last used, the newest of the map's order.
function use(runner, child, parent) {
  runner.roots.delete(child);
  runner.roots.set(child, parent);
}

// Keeps `dir`, the folder a finished walk gave the root session `root`, for its SessionEnd (endCall), which runs once the
// session can no longer be read. Only an absolute path is kept, and the map is cleared whole at ROOTS_MAX.
function remember(runner, root, dir) {
  if (!absolute(dir)) return;
  if (runner.folders.size >= ROOTS_MAX && !runner.folders.has(root)) runner.folders.clear();
  runner.folders.set(root, dir);
}

// What a session's `session.deleted` event sends its SessionEnd routes: { base, cwd, root, agent: null }, or { skip }.
// The event carries the session's id alone, and the session may no longer be readable, so the bridge reads nothing:
// the session runs SessionEnd only when it holds no parent link and a finished walk, its own or a child's, kept its folder,
// and that folder, the last one, is on disk. `skip` is `session` for no id, `subagent` for a session that holds a link,
// `read` for one with no folder kept, as one the bridge never read or one it forgot, and `cwd` for a folder not on disk. A
// child's end never runs its root's SessionEnd, which would delete the root's records while the root runs on.
export function endCall(runner, sessionID) {
  if (typeof sessionID !== 'string' || sessionID === '') return { skip: 'session' };
  if (runner.roots.has(sessionID)) return { skip: 'subagent' };
  if (!runner.folders.has(sessionID)) return { skip: 'read' };
  const dir = runner.folders.get(sessionID);
  if (!isFolder(dir)) return { skip: 'cwd' };
  return { base: dir, cwd: dir, root: sessionID, agent: null };
}

// Forgets the folder the bridge keeps of the session `sessionID`, once its end ran. Its parent link stays, so a late call
// of it, or of its own child, stays a subagent's under its root.
export function forgetSession(runner, sessionID) {
  runner.folders.delete(sessionID);
}

// Who a hook that is not a tool hook (start, stop, compaction, prompt) runs for, and in which folder, for the session
// `sessionID`: { root, agent, dir, rootDir }, each folder one on disk or null, or { skip } to run nothing. `dir` is the
// session's own folder, which a child's `--subagent` start runs in, and `rootDir` its root's, which every other such
// hook runs in, from the one walk. `skip` is `session` for no id, and `read` for a walk that did not finish
// (sessionOf). A missing folder is never replaced by the plugin's or the service's, which may be another checkout.
export async function sessionCall(runner, sessionID) {
  if (typeof sessionID !== 'string' || sessionID === '') return { skip: 'session' };
  const reads = readsOf(runner.context, READ_MS);
  try {
    const session = await sessionOf(runner, reads.get, sessionID);
    if (session.failed) return { skip: 'read' };
    const folder = (dir) => (isFolder(dir) ? dir : null);
    return { root: session.root, agent: session.agent, dir: folder(session.dir), rootDir: folder(session.rootDir) };
  } catch {
    return { skip: 'read' };
  } finally {
    reads.end();
  }
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
