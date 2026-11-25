// Replacing the terminal after a background handoff (docs/handoff.md#replacing-the-terminal). A session that handed
// its work to a background session ends itself once its turn ends, and the shell that ran it opens the new session in
// the same terminal, with nothing typed. It needs the shell function of lib/shell-init.mjs, which the Human writes into
// the shell's startup file: the function runs the host's program with SHELL_VAR set to the shell's pid, and once the
// program exits it reads and deletes this shell's record, and opens the session the record names.
//   1. The gate (lib/handoff-continue.mjs), once the background session started, asks terminalOf whether the host
//      process was started by that function's shell and a Human attends it, and notes the request in the continuation
//      store (handoff-markers.mjs noteEnding), which no subagent or unattended session may write.
//   2. The Stop hook takes the request (endAfterTurn), checks it again against its own environment, writes the shell's
//      record, and starts a detached helper, scripts/end-host.mjs, which waits END_DELAY for the turn to settle and
//      sends the host's signal to the host process (endHost), when it is still the one that shell started.
//   3. The shell function reads `<state root>/handoff-terminals/<shell pid>`, `<id> <expiry in epoch seconds>`, deletes
//      it, and opens the session `id` when it is fresh and `id` is plain, again after that session's program exits.
// The next hops chain the same way. When a session ends itself, the Stop hook also notes in the store that the shell's
// terminal now follows the new session (handoff-markers.mjs noteFollow). The shell function says so too, each time it
// opens a session by a plain id, typed or from a record, or by another typed target, such as the session's name:
// `<state root>/handoff-terminals/follows-<shell pid>`, `<id> <epoch seconds>` or `~<hex of the target> <epoch seconds>`,
// deleted once that program exits (readFollows); the host adapter says which session a name opens (nameMatcher).
// A session the background route started carries no SHELL_VAR, and the host does not say a Human attends it, whether or
// not the Human typed into it since; when it hands off in turn, the gate notes a request that names its own id instead
// of a host process, with the shell whose terminal follows it, by the store or the shell's own record,
// while that shell runs the host's client (replaceTerminal.hasClient), or with no shell. Its Stop hook ends that session
// alone, through the host's own stop command (replaceTerminal.endOwn), never another process, so the host lists it as
// done rather than idle; with a shell, it first writes the shell's record and passes the follow on. The client in the
// shell then exits, and the shell function opens the next one. Such a request holds as long as the start record of the
// session that took the work (handoff-markers.mjs OWN_ENDING_WINDOW), so a turn that waited on a question or a
// permission prompt still ends the session once it ends; one that names a host process holds 30 minutes (ENDING_WINDOW).
// It ends only the turn that noted it: a Human prompt after it in the session's own transcript (typedSince) drops it.
// A residual: where the host keeps no transcript its adapter vouches for, the agent gate cannot lift the session's mark
// either, so the mark still holds it, and a request a turn the Human interrupted left ends it at the end of a later
// turn the Human typed, within OWN_ENDING_WINDOW (docs/handoff.md#replacing-the-terminal).
// A former background session a Human resumed as an interactive session, which the host says a Human attends, never
// names itself.
// A background session that stays open after its successor started says why in the gate's say line. The chain floor
// and its cap bound the hops.
// Which host process, which signal, and which program and words open a session are the host adapter's
// `capabilities.handoffContinue.replaceTerminal`; this file names no host.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { FOLLOW_AGE, isPid, readOwnFile } from './handoff-markers.mjs';
import { HOSTS } from './hosts/index.mjs';
import { stateRoot } from './project.mjs';
import { transcriptTail } from './unattended-mark.mjs';

export const TERMINAL_FOLDER = 'handoff-terminals';
// The variable the shell function sets for the host's program: the shell's own pid.
export const SHELL_VAR = 'AIDRIAN_SHELL_PID';
// How long a shell's record holds: the shell reads it the moment the host's program exits. The shell function refuses an
// expiry later than this, plus NEXT_MARGIN for a clock that moved, from the time it reads the record.
export const NEXT_WINDOW = 60 * 1000;
export const NEXT_MARGIN = 5 * 1000;
// How long the helper waits after the Stop hook, so the host finishes its other Stop hooks and shows the last message.
export const END_DELAY = 2000;
// An id the shell function opens; the shell function holds it to the same pattern.
export const OPEN_ID = /^[0-9A-Za-z][-_0-9A-Za-z]{3,127}$/u;
// The shell function's record of the session its terminal shows, `follows-<shell pid>`, and its one line: `<id> <epoch
// seconds>` for a plain id, or `~<hex> <epoch seconds>` for any other attach target, such as a session's name, its bytes
// in lowercase hexadecimal, at most NAME_BYTES of them, so no character of it reaches the line as it was typed.
export const FOLLOWS_PREFIX = 'follows-';
const FOLLOWS_FILE = new RegExp(`^${FOLLOWS_PREFIX}(\\d{1,10})$`, 'u');
// The shortest id a follows record may name a session by when it is not the full id: the short id a host lists, such as
// the first 8 characters of a Claude Code session id. A shorter typed name never matches another session by prefix.
export const SHORT_ID_MIN = 8;
export const NAME_BYTES = 128;
const FOLLOWS_LINE = new RegExp(`^(?:(${OPEN_ID.source.slice(1, -1)})|~((?:[0-9a-f]{2}){1,${NAME_BYTES}})) (\\d{1,12})\\n?$`, 'u');
const FOLLOWS_CAP = 512;
const HELPER = path.resolve(import.meta.dirname, '../scripts/end-host.mjs');

export const replacer = (host) => host.capabilities.handoffContinue?.replaceTerminal ?? null;

// The pid of the shell whose function started this session's host program, from `env`, or null.
export function shellPid(env) {
  const text = env[SHELL_VAR];
  return typeof text === 'string' && /^\d{1,10}$/u.test(text) && isPid(Number(text)) ? Number(text) : null;
}

// The terminal a session of `host` with the environment `env` can hand over: { hostPid, shell } when the host can
// replace a terminal, the shell function started its program, and a Human attends it; else null.
export function terminalOf(host, { env, run }) {
  const replace = replacer(host);
  const shell = shellPid(env);
  if (!replace || shell === null) return null;
  const hostPid = replace.hostProcess({ env, shell, run });
  return isPid(hostPid) ? { hostPid, shell } : null;
}

// The folder shell records live in, under the state root `env` names.
export const terminalFolder = (env = process.env) => path.join(stateRoot(env), TERMINAL_FOLDER);

// Every folder a shell record may be written in, for the guard that keeps a subagent and an unattended session out of
// them: the state root's, as `env` names it, and the user's own, under `home`, as lib/unattended-mark.mjs markFolders.
export function terminalFolders({ env = process.env, home } = {}) {
  const folders = [];
  try {
    folders.push(terminalFolder(env));
  } catch {
    // A state root the environment cannot give: the user's own still holds.
  }
  try {
    folders.push(path.join(home ?? userInfo().homedir, '.local/state', 'aidrian', TERMINAL_FOLDER));
  } catch {
    // No user record: the environment's root alone.
  }
  return [...new Set(folders.map((folder) => path.resolve(folder)))];
}

// Writes the record of the shell `shell`: open the session `id` before the end of NEXT_WINDOW. Owner-only, through a
// temporary file and a rename, in a folder that is the user's alone. Returns the file, or null. Never throws.
export function writeNext({ shell, id, env = process.env, now = Date.now() }) {
  if (!isPid(shell) || typeof id !== 'string' || !OPEN_ID.test(id)) return null;
  try {
    const folder = terminalFolder(env);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    if ((stat.mode & 0o077) !== 0) chmodSync(folder, 0o700);
    const file = path.join(folder, String(shell));
    const temporary = path.join(folder, `.${shell}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    writeFileSync(temporary, `${id} ${Math.floor((now + NEXT_WINDOW) / 1000)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      renameSync(temporary, file);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return file;
  } catch {
    return null;
  }
}

// The shell whose terminal shows the background session `session`, as the shell function recorded when it opened it by
// its full id, a short id it starts with, or another target `named(target)` says can open this session alone, such as
// its whole name (replaceTerminal.nameMatcher), in the last FOLLOW_AGE: { shell, id }, where `id` is the id it opened,
// or the session's own for a target opened by name, the latest if several; or null. `named` is asked only of a fresh
// record no id matches. Only a regular file this user owns, no symlink, in a folder no other user may write.
// The shell may have moved on since; replaceTerminal.hasClient says whether it still runs the host's client, and
// `live(shell)`, asked of a newer record only, skips one whose shell does not, so a dead one never hides a live one.
export function readFollows(session, { env = process.env, now = Date.now(), live = () => true, named = () => false } = {}) {
  if (typeof session !== 'string' || !OPEN_ID.test(session)) return null;
  let folder;
  let names;
  try {
    folder = terminalFolder(env);
    const stat = lstatSync(folder);
    if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return null;
    names = readdirSync(folder);
  } catch {
    return null;
  }
  let latest = null;
  for (const name of names) {
    const shell = Number(FOLLOWS_FILE.exec(name)?.[1]);
    if (!isPid(shell)) continue;
    const match = FOLLOWS_LINE.exec(readOwnFile(path.join(folder, name), { cap: FOLLOWS_CAP })?.text ?? '');
    if (!match) continue;
    const [, plain, hex, seconds] = match;
    const at = Number(seconds) * 1000;
    if (at > now + NEXT_MARGIN || now - at > FOLLOW_AGE || (latest && at <= latest.at)) continue;
    let id = null;
    if (plain !== undefined && (plain === session || (plain.length >= SHORT_ID_MIN && session.startsWith(plain)))) id = plain;
    else if (named(plain ?? Buffer.from(hex, 'hex').toString('utf8')) === true) id = session;
    if (id !== null && live(shell)) latest = { shell, id, at };
  }
  return latest && { shell: latest.shell, id: latest.id };
}

// The Stop hook's step, in the session `session`: takes the request `take()` returns, as handoff-markers.mjs takeEnding,
// or null, and when this session's own facts confirm it, writes the shell's record, notes through `follow` that the
// shell's terminal follows the next session, and starts the helper. `unattended()` says no Human attends this session,
// and `background()` that the background route started it (handoff-markers.mjs startedInBackground), though the Human
// may have typed into it since. `typedSince(at)` says whether the Human typed into it after the request's time `at`, as
// typedSince below reads it: true, false, or null when it cannot tell.
// An attended session's request names its host process, which its own environment must name as the shell's child, and
// it ends nothing without the shell's record. A background session's names its own id, which `session` must start
// with, on a host that can end its own session and does not say a Human attends it: it ends whether or not a terminal
// follows it, and writes the shell's record only while the shell it names is alive and the parent of the host's
// client, as a terminal attached to the session is (replaceTerminal.hasClient). Returns whether the session is ending.
export function endAfterTurn({ host, session, take, unattended, background = () => false, typedSince: typed = () => false, follow = () => null, env = process.env, now = Date.now(), run, start = startHelper }) {
  const replace = replacer(host);
  if (!replace) return false;
  const request = take();
  if (!request) return false;
  const byProcess = request.own === undefined;
  const ending = byProcess ? ownProcess({ host, request, unattended, env, run }) : ownSession({ replace, request, session, unattended, background, typed, env });
  if (!ending) return false;
  const attached = byProcess || (request.shell !== null && replace.hasClient?.({ shell: request.shell, run }) === true);
  const handed = attached && writeNext({ shell: request.shell, id: request.id, env, now }) !== null;
  if (byProcess && !handed) return false;
  if (handed) follow({ session: request.next ?? request.id, shell: request.shell });
  start({ host: host.id, ...ending, delay: END_DELAY });
  return true;
}

// The helper's arguments for an attended session whose own environment names the request's shell and host process.
function ownProcess({ host, request, unattended, env, run }) {
  if (unattended()) return null;
  const own = terminalOf(host, { env, run });
  return own && own.shell === request.shell && own.hostPid === request.hostPid ? { pid: own.hostPid, shell: own.shell } : null;
}

// The helper's arguments for a background session whose own id `session` is the request's, or starts with it, which the
// host does not say a Human attends, and which the store holds as unattended or as one the background route started.
// The request ends only the turn that noted it: a Human prompt after it, `typed(request.at)`, means this stop ends a
// later turn, as after a turn the Human interrupted or an API error ended, neither of which runs the Stop hook, so it
// ends nothing. When the transcript cannot tell, a session its unattended mark holds still ends, since no Human typed
// into it as the store knows; one held only by its floor, which the Human did type into, stays open.
function ownSession({ replace, request, session, unattended, background, typed, env }) {
  if (typeof replace.endOwn !== 'function' || typeof session !== 'string' || replace.attended(env)) return null;
  const marked = unattended();
  if (!marked && !background()) return null;
  if (session !== request.own && !session.startsWith(request.own)) return null;
  const later = typed(request.at);
  if (later === true || (later === null && !marked)) return null;
  return { own: request.own, session };
}

// Whether the Human typed into a session after `at`, as `prompts` (hosts/index.mjs humanPrompts) reads the session's own
// transcript, each entry's time by its `timeOf`: true when a Human prompt in its tail is dated after `at`, or carries no
// date it can read; false when none is and the tail reaches back to `at`; null when it cannot tell: no reader, no time,
// a transcript it cannot read or that moved meanwhile, or a tail that starts after `at`, which may have cut a prompt off.
export function typedSince(prompts, at) {
  if (!prompts || !Number.isFinite(at)) return null;
  let tail;
  try {
    tail = transcriptTail(prompts.file);
    if (!tail || prompts.still() !== true) return null;
  } catch {
    return null;
  }
  const time = (entry) => {
    const written = prompts.timeOf?.(entry);
    return Number.isFinite(written) ? written : Number.NaN;
  };
  if (tail.entries.some((entry) => prompts.isHuman(entry) && !(time(entry) <= at))) return true;
  if (!tail.cut || tail.entries.some((entry) => time(entry) <= at)) return false;
  return null;
}

// Starts scripts/end-host.mjs detached, so it outlives the hook and the session it ends: `pid <pid> <shell>` for a host
// process, `own <id> <session>` for a background session's own.
function startHelper({ host, pid, shell, own, session, delay }) {
  const way = own === undefined ? ['pid', String(pid), String(shell)] : ['own', own, session];
  const child = spawn(process.execPath, [HELPER, host, ...way, String(delay)], { detached: true, stdio: 'ignore' });
  child.unref();
}

// The helper's step, after `delay` milliseconds, for the host whose id is `host`. With `pid`, it sends the host's signal
// to `pid` when it is still a host process the shell `shell` started, which a pid the system gave to another process
// since is not. With `own`, it ends the background session `session`, listed under `own`, through the host
// (replaceTerminal.endOwn), which ends nothing the host does not list as that very session. Returns whether it ended it.
export async function endHost({ host, pid, shell, own, session, delay, env = process.env, hosts = HOSTS, kill = process.kill.bind(process), wait = sleep, run }) {
  const replace = replacer(hosts.find((each) => each.id === host) ?? { capabilities: {} });
  if (!replace) return false;
  const byId = own !== undefined;
  const named = byId ? canEndOwn(replace, own, session) : isPid(pid) && isPid(shell);
  if (!named) return false;
  if (Number.isInteger(delay) && delay > 0) await wait(delay);
  if (byId) return replace.endOwn({ id: own, session, env, run }) === true;
  if (!replace.isHost({ pid, shell, run })) return false;
  kill(pid, replace.signal);
  return true;
}

const canEndOwn = (replace, own, session) => typeof replace.endOwn === 'function' && typeof own === 'string' && OPEN_ID.test(own)
  && typeof session === 'string' && /^[\w-]{1,128}$/u.test(session);
