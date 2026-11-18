// Claude Code's side of the background route of session.handoff.continue (docs/providers/claude-code.md#the-background-route).
// `claude --bg` starts a session under the background-session supervisor and prints its short id; `claude agents --json`,
// the listing its docs name as the stable interface, gives each session's `id`, `sessionId`, `name`, `kind`, and `cwd`.
// `--bg` ignores `--session-id`, so the new session's id is read back from that listing, which may lag the start.
// `startIn` starts a session in a given folder with a given first message and name, for any gate; `startBackground` is
// the handoff's wrapper of the same launch, which takes the folder, name, and mode from the handing-off session, and
// `startProject` a project run's, which starts in the issue's worktree under the driver session's permission mode.
// Every call goes through `run`, spawnSync's shape, which a test replaces, so no test starts a real session. `claude` is
// found on the absolute folders of PATH alone: an empty or relative entry would run whatever `claude` the folder holds.

import { spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { pauseSync } from '../fs.mjs';

// `claude --bg` may first start the supervisor, which takes a few seconds.
const START_TIMEOUT = 60_000;
const LIST_TIMEOUT = 15_000;
// How often, and how far apart, the listing is read again for a session the start just made: about 5 seconds.
const LIST_TRIES = 10;
const LIST_PAUSE = 500;
// Its output: `backgrounded · <short id> · <name>`, then the commands that manage the session. Read only at the start of
// a line, so text echoed before it, such as part of the prompt, cannot name another id.
const STARTED = /^[ \t]*backgrounded[ \t]*·[ \t]*([0-9A-Za-z][0-9A-Za-z-]{3,63})\b/mu;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// A session name the command passes on: plain text that cannot read as a flag.
const NAME = /^[^\s-][^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,99}$/u;
// A name the say line prints, in single quotes: no quote, `$`, `;`, or other character a shell reads inside them.
// lib/handoff-markers.mjs holds a started marker's name to the same pattern; importing it here would loop the modules.
const PLAIN_NAME = /^[\w .@:\u00b7-]+$/u;
// An agent name the command passes on: a word, or `<plugin>:<agent>`.
const AGENT = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;
// The permission modes `claude --help` lists for `--permission-mode` on 2.1.326, but `bypassPermissions`: a session no
// Human attends never runs without permission checks. A transcript may name the manual mode `default`.
const PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'dontAsk', 'manual', 'plan']);
const MODE_NAMES = new Map([['default', 'manual']]);
const BYPASS = 'bypassPermissions';
// How much of a transcript's end is read for its last permission mode entry.
const MODE_TAIL = 16 * 1024 * 1024;
const MODE_ENTRY = /^\{"type":"permission-mode".*$/gmu;
// A spawn that failed before `claude` ran, and the output of a `claude --bg` that refused the start before the supervisor
// took it, checked on 2.1.326: no other failure proves that nothing started.
const NOT_RUN = new Set(['ENOENT', 'EACCES']);
const REFUSED = /\bWorkspace not trusted\b/u;
const NO_CLAUDE = '`claude` is not on PATH, in an absolute folder';

export const runCommand = (command, args, { cwd, timeout }) => spawnSync(command, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pause = pauseSync;

// The first line of a command's message, on one line and at most 200 characters, for a fallback line.
const firstLine = (text) => String(text ?? '').trim().split('\n')[0].replace(new RegExp(CONTROL, 'gu'), ' ').slice(0, 200);

// The `claude` executable on the absolute folders of `env.PATH`, or null.
export function claudeOnPath(env) {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const folders = String(env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '' && path.isAbsolute(dir));
  for (const file of folders.flatMap((dir) => names.map((name) => path.join(dir, name)))) {
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // Not there, or not executable: the next folder.
    }
  }
  return null;
}

// The sessions `claude agents --json` lists, with `extra` its further options, or null when it cannot answer.
function listed(run, claude, cwd, extra = []) {
  const result = run(claude, ['agents', '--json', ...extra], { cwd, timeout: LIST_TIMEOUT });
  if (result.error || result.status !== 0) return null;
  try {
    const list = JSON.parse(result.stdout);
    return Array.isArray(list) ? list.filter((each) => each !== null && typeof each === 'object') : null;
  } catch {
    return null;
  }
}

// The one listed background session the start made: a `sessionId` the listing before it did not hold, in `cwd`, with
// the short `id` the start printed, else with `name`. null when none, or more than one, fits.
function newSession(list, { before, cwd, id, name }) {
  const fits = (list ?? []).filter((each) => each.kind === 'background' && typeof each.sessionId === 'string' && ID.test(each.sessionId)
    && !before.has(each.sessionId) && each.cwd === cwd
    && (id ? each.id === id || each.sessionId.startsWith(id) : each.name === name));
  return fits.length === 1 ? fits[0] : null;
}

// Reads the listing until it names the new session, at most LIST_TRIES times: { entry, list }, the last listing read.
function awaitSession({ run, claude, wait, ...want }) {
  let list = null;
  for (let attempt = 0; attempt < LIST_TRIES; attempt += 1) {
    if (attempt > 0) wait(LIST_PAUSE);
    list = listed(run, claude, want.cwd) ?? list;
    const entry = newSession(list, want);
    if (entry) return { entry, list };
  }
  return { entry: null, list };
}

// The permission mode the session `session` runs in, from the last `permission-mode` entry of its transcript,
// `<config folder>/projects/<start folder, each character but a letter or digit as ->/<session>.jsonl`, else that file
// in any project folder there: the mode's name, or null when none can be read. `env.CLAUDE_CONFIG_DIR` moves the config
// folder, as it does for Claude Code. On 2.1.326 neither the gate's shell nor `claude agents --json` gives the mode; the
// transcript holds `{"type":"permission-mode","permissionMode":<mode>,"sessionId":<id>}` from the start and each change.
export function sessionMode({ session, cwd, env }) {
  if (typeof session !== 'string' || !ID.test(session)) return null;
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects');
  const name = `${session}.jsonl`;
  const first = path.join(projects, String(cwd).replace(/[^A-Za-z0-9]/gu, '-'), name);
  let folders;
  try {
    folders = readdirSync(projects);
  } catch {
    return null;
  }
  for (const file of [first, ...folders.map((folder) => path.join(projects, folder, name))]) {
    const tail = readTail(file);
    if (tail === null) continue;
    const entry = [...tail.matchAll(MODE_ENTRY)].map(([line]) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter((each) => each !== null && (each.sessionId === undefined || each.sessionId === session)).at(-1);
    return typeof entry?.permissionMode === 'string' ? entry.permissionMode : null;
  }
  return null;
}

// The last MODE_TAIL bytes of the regular file `file`, as text, or null.
function readTail(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, MODE_TAIL);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The new session's name: the handing-off session's, else the slug, then ` · <chain>`, within 100 characters.
function sessionName(own, slug, chain) {
  const suffix = ` · ${chain}`;
  const base = typeof own === 'string' && NAME.test(own) ? own : slug;
  return `${base.slice(0, 100 - suffix.length).trimEnd()}${suffix}`;
}

// How the Human looks at the session `id`: `claude attach <id>` first, and its name when it is plain text and `unique`.
export function attachLine({ id, name }) {
  const byName = typeof name === 'string' && PLAIN_NAME.test(name) ? `, or \`claude attach '${name}'\` by its name` : '';
  return `\`claude attach ${id}\` opens it${byName}, and \`claude agents\` lists it`;
}

// How the Human stops the session `id` by hand, when stopBackground could not.
export const stopLine = ({ id }) => `\`claude stop ${id}\` stops it`;

// Starts a session in the background in the folder `cwd`, by its real path, whose first message is `prompt`, under the name `name`, in
// the permission mode `mode`: { id, session, name, cwd, mode }, or { problem, uncertain } when none it can name started,
// as startBackground's. `mode` must be one of PERMISSION_MODES: a session no Human attends never runs without permission
// checks, and the host's default may. `cwd` is an absolute path of plain text, `name` plain text that cannot read as a
// flag, and `prompt` text that does not start with a dash or a slash; `agent` and `effort` are passed on when they are valid.
// `hold`, `run`, `wait`, and `resolve` are startBackground's. It names no brief: lib/session-start-gate.mjs startHeld
// holds what it starts.
export function startIn({ cwd, prompt, name, mode, agent, effort, efforts = [], env, hold, run = runCommand, wait = pause, resolve = claudeOnPath }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || CONTROL.test(cwd)) return { problem: 'the folder to start the session in is not an absolute path of plain text' };
  if (typeof name !== 'string' || !NAME.test(name)) return { problem: 'the session\'s name is not plain text of at most 100 characters that cannot read as a flag' };
  if (typeof prompt !== 'string' || prompt.trim() === '' || /^\s*[-/]/u.test(prompt)) {
    return { problem: 'the first message is empty, or starts with a dash, which would read as a flag, or a slash, which would read as a command' };
  }
  if (!PERMISSION_MODES.has(mode)) return { problem: 'the permission mode is not one a session no Human attends may start in' };
  let real;
  try {
    real = realpathSync(cwd);
  } catch (error) {
    return { problem: `the folder to start the session in cannot be resolved (${error.code ?? 'no code'})` };
  }
  if (CONTROL.test(real)) return { problem: 'the folder to start the session in resolves to a path that is not plain text' };
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the sessions listed before the start are unknown' };
  return launch({ claude, before, cwd: real, prompt, name, mode, agent, effort, efforts, hold, run, wait });
}

// The permission mode the session `session`, as `list` names it, runs in: { mode } or { problem }. A session whose mode is
// bypassPermissions, or cannot be read, gives a problem: the host's default may bypass permission checks.
function ownMode({ session, list, env, readMode }) {
  const own = list.find((each) => each.sessionId === session);
  if (typeof own?.cwd !== 'string' || !path.isAbsolute(own.cwd) || CONTROL.test(own.cwd)) {
    return { problem: '`claude agents --json` does not list the folder of this session' };
  }
  const read = readMode({ session, cwd: own.cwd, env });
  if (read === BYPASS) return { problem: 'this session runs with permission checks bypassed, and a session no Human attends never starts that way' };
  const mode = MODE_NAMES.get(read) ?? read;
  if (!PERMISSION_MODES.has(mode)) return { problem: 'the permission mode of this session could not be read, and the host\'s default may bypass permission checks' };
  return { mode, own };
}

// Starts the session of one issue of a project run, in the background, in the issue's worktree `cwd`, under the name
// `name`, whose first message is `prompt`, as startIn does, in the permission mode the driver session `session` runs in
// (`readMode`, sessionMode by default; never bypassPermissions). No agent is passed, so the session runs as the host's
// main agent and no agent's own permission mode can stand in for the one passed; the driver's effort is passed on.
// Returns startIn's answer. `hold`, `run`, `wait`, and `resolve` are startBackground's.
export function startProject({ session, cwd, prompt, name, effort, efforts = [], env, hold, run = runCommand, wait = pause, resolve = claudeOnPath, readMode = sessionMode }) {
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the permission mode of the driver session is unknown' };
  const read = ownMode({ session, list: before, env, readMode });
  if (read.problem) return { problem: read.problem.replace('this session', 'the driver session') };
  return startIn({ cwd, prompt, name, mode: read.mode, effort, efforts, env, hold, run, wait, resolve: () => claude });
}

// The background sessions `claude agents --json --all` lists in the folder `cwd` under the exact name `name`, as [{ id,
// session, state }], or null when the listing gives no answer: how a project run finds a session an uncertain start may
// have made.
export function findSessions({ cwd, name, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof cwd !== 'string' || typeof name !== 'string') return null;
  const list = listed(run, claude, undefined, ['--all']);
  if (!list) return null;
  return list.filter((each) => each.kind === 'background' && each.cwd === cwd && each.name === name && typeof each.sessionId === 'string' && ID.test(each.sessionId))
    .map((each) => ({ id: typeof each.id === 'string' && ID.test(each.id) ? each.id : each.sessionId, session: each.sessionId, state: typeof each.state === 'string' ? each.state : null }));
}

// Starts the session that resumes a brief, in the background, in the folder of the handing-off session `session` as the
// host lists it: { id, session, name, cwd }, or { problem, uncertain } when none it can name started. `id` is the id to
// name it by, the short one when the output printed it; `session` its full id, or null when the listing did not name it
// within about 5 seconds; `name` its name when it is plain text no other listed session has, else null. A start that
// timed out or failed still counts when the listing then shows it. `uncertain` is true when `claude --bg` ran and what
// it did is unknown: it may have started a session the listing never named (startProblem). `agent` and `effort` are the
// handing-off session's, passed on when known, and so is its permission mode (`readMode`, sessionMode by default), when
// it is one of PERMISSION_MODES: `mode` in the result is the mode passed. A session whose mode is bypassPermissions, or
// cannot be read, starts nothing: the host's default may bypass permission checks. `hold({ cwd, known })`, the gate's, files the pending mark that holds
// every session the host had not listed, `known` being the ids it had, until the new session's own mark is written; it
// runs before `claude --bg`, and a start it does not confirm is none. `run` and `wait` are a test's stand-ins, and
// `resolve` finds `claude` from `env`. It is the handoff's wrapper of the launch startIn makes.
export function startBackground({ session, slug, chain, agent, effort, efforts, prompt, env, hold, run = runCommand, wait = pause, resolve = claudeOnPath, readMode = sessionMode }) {
  const claude = resolve(env);
  if (!claude) return { problem: NO_CLAUDE };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the folder of this session is unknown' };
  const read = ownMode({ session, list: before, env, readMode });
  if (read.problem) return { problem: read.problem };
  const { mode, own } = read;
  const name = sessionName(own.name, slug, chain);
  return launch({ claude, before, cwd: own.cwd, prompt, name, mode, agent, effort, efforts, hold, run, wait });
}

// The start itself, once `before`, the listing read before it, is known: `hold` files the pending mark with the ids that
// listing names, then `claude --bg` starts the session in `cwd`, and the listing is read until it names the new one.
function launch({ claude, before, cwd, prompt, name, mode, agent, effort, efforts, hold, run, wait }) {
  const known = before.map((each) => each.sessionId).filter((id) => typeof id === 'string' && ID.test(id));
  if (typeof hold !== 'function' || !hold({ cwd, known })) {
    return { problem: 'the gate could not record the pending mark that holds the new session as unattended until its own mark is written' };
  }
  const args = ['--bg', '--name', name];
  if (typeof agent === 'string' && AGENT.test(agent)) args.push('--agent', agent);
  if (efforts.includes(effort)) args.push('--effort', effort);
  args.push('--permission-mode', mode);
  const result = run(claude, [...args, prompt], { cwd, timeout: START_TIMEOUT });
  const printed = STARTED.exec(String(result.stdout ?? ''))?.[1] ?? null;
  const want = { before: new Set(before.map((each) => each.sessionId)), cwd, id: printed, name };
  const { entry, list } = awaitSession({ run, claude, wait, ...want });
  if (!entry && !printed) return startProblem(result, list, want.before);
  const id = printed ?? (typeof entry.id === 'string' && ID.test(entry.id) ? entry.id : entry.sessionId);
  const unique = (list ?? []).filter((each) => each.name === name).length === 1;
  return { id, session: entry?.sessionId ?? null, name: unique && PLAIN_NAME.test(name) ? name : null, cwd, mode };
}

// Why a start that printed no id and that the listing does not show made no session it can name: { problem, uncertain }.
// It is certain that none started only when `claude` never ran (NOT_RUN), or when its output is a known refusal (REFUSED)
// and the last listing it read, `list`, holds no background session that the listing before the start, `before`, did
// not. Any other exit, a timeout, a signal, a listing that never answered, or any new background session leaves it
// uncertain: the supervisor may have taken the start, and its session may be listed later.
function startProblem(result, list, before) {
  if (NOT_RUN.has(result.error?.code)) return { problem: `\`claude\` could not be run (${result.error.code})`, uncertain: false };
  const unknown = list === null || list.some((each) => each.kind === 'background' && !before.has(each.sessionId));
  if (result.error) return { problem: `\`claude --bg\` did not finish (${result.error.code ?? 'no code'}), and \`claude agents\` lists no session it started`, uncertain: true };
  if (Number.isInteger(result.status) && result.status !== 0) {
    const refused = REFUSED.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
    return { problem: `\`claude --bg\` exited ${result.status}: ${firstLine(result.stderr || result.stdout) || 'no message'}`, uncertain: unknown || !refused };
  }
  if (result.status !== 0) return { problem: `\`claude --bg\` was stopped (${result.signal ?? 'no signal'}), and \`claude agents\` lists no session it started`, uncertain: true };
  return { problem: '`claude --bg` printed no session id, and `claude agents` lists no session it started', uncertain: true };
}

// Whether the host lists the background session a start record names as ended: true only when `claude agents --json
// --all`, which adds the completed background sessions to the active ones, names it, by its full id `session`, or by
// `id`, the id the start printed, when the full one was never listed, and every row that names it is a background
// session with `state: "done"`, as a completed session's row is on 2.1.326, where a running one has `state: "working"`;
// false when a row that names it has any other state, or none names it; null when the listing gives no answer or
// `claude` cannot be found. Only true lets a gate start another session for the same starting session.
export function sessionEnded({ id, session, env, run = runCommand, resolve = claudeOnPath }) {
  return listedIn({ id, session, env, run, resolve, states: DONE });
}

// The states of a background session that runs no more: completed (`done`), stopped by `claude stop` (`stopped`), or
// ended by an error (`failed`), as 2.1.326 names them (docs/providers/claude-code.md).
const DONE = new Set(['done']);
const FINISHED = new Set(['done', 'stopped', 'failed']);

// Whether the host lists the background session a project run started as one that runs no more: sessionEnded's read,
// with `stopped` and `failed` counted as ended too. A project run's driver stops an issue's session past its hours and
// starts the next issue; a session that failed records no result, and the issue opens again. The handoff route keeps
// sessionEnded, where only `done` lets a session start another.
export function sessionFinished({ id, session, env, run = runCommand, resolve = claudeOnPath }) {
  return listedIn({ id, session, env, run, resolve, states: FINISHED });
}

// Whether every row of `claude agents --json --all` that names the session is a background session in one of `states`;
// sessionEnded says how it is named, and when it answers false or null.
function listedIn({ id, session, env, run, resolve, states }) {
  const claude = resolve(env);
  if (!claude) return null;
  const list = listed(run, claude, undefined, ['--all']);
  if (!list) return null;
  const full = typeof session === 'string' && ID.test(session);
  if (!full && (typeof id !== 'string' || !ID.test(id))) return false;
  const names = (each) => typeof each.sessionId === 'string'
    && (full ? each.sessionId === session : each.id === id || each.sessionId === id || each.sessionId.startsWith(id));
  const rows = list.filter(names);
  return rows.length > 0 && rows.every((each) => each.kind === 'background' && states.has(each.state));
}

// How the Human finds and stops a session a start may have made, when the gate cannot name it.
export const findLine = () => '`claude agents` lists the background sessions, with the folder each started in, and `claude stop <id>` stops one';

// Stops the background session `id`, as `claude stop` does: whether it exited 0.
export function stopBackground({ id, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof id !== 'string' || !ID.test(id)) return false;
  const result = run(claude, ['stop', id], { cwd: undefined, timeout: LIST_TIMEOUT });
  return !result.error && result.status === 0;
}
