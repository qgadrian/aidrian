// Codex's side of `aidrian project start` (lib/project-run-gate.mjs), checked on fixtures only: no live Codex has run it,
// so hosts/codex.mjs declares it `verified: 'unverified'`, and a run uses it only where the team's default branch sets
// projectRun.unverifiedHosts. Codex is a confined host: the session works in a fresh clone made for its attempt
// (lib/project-start.mjs), under `codex exec --json --sandbox workspace-write --cd <work> --add-dir <dir>...`, whose
// events go to the run's log. Codex lists no background sessions, so a session is known by its process: its id is
// `pid-<pid>-<digest of its start time>`, and liveness and stop read the process table for that pid, under LC_ALL=C and
// TZ=UTC so the start time reads the same in every environment, and stop it only while its start time is the one
// recorded, so a reused pid is never stopped.
// A start holds the session only after its proofs, else it stops the process at once and says the proof failed:
//   - the session id, the `thread_id` of the first JSON event Codex prints (`thread.started`), within SESSION_WAIT; the
//     gate then files the session's floor and mark (`identify`), so the hooks hold it by its own mark from then on;
//   - its first tool call, the first `item.*` event of an item that is neither a message nor reasoning, within
//     FIRST_TOOL_WAIT;
//   - the beacon the plugin's agent gate hook files on that call (lib/unattended-mark.mjs noteBeacon), within
//     BEACON_GRACE of it, since the hook runs before the tool: it shows Codex runs the plugin's hooks under `codex exec`.
// The sandbox is pinned to workspace-write; no flag that bypasses the sandbox or the approvals is ever passed.
// Every process call goes through `run` (spawnSync's shape) or `launch`, which a test replaces or points at a fake
// `codex`; the waits count their steps through `wait`, so a test passes a short one and never waits the full time.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { pauseSync } from '../fs.mjs';
import { programNames, programOnPath, runCommand } from './process.mjs';

// How long a start waits for each proof, and the step between reads.
export const SESSION_WAIT = 30_000;
export const FIRST_TOOL_WAIT = 180_000;
export const BEACON_GRACE = 5_000;
const STEP = 250;
// How long a stop waits for the process to end after SIGTERM, then after SIGKILL.
const STOP_WAIT = 3_000;
// The longest a start runs from its launch: every proof's wait, and a stop. A pending mark must outlive it
// (unattended-mark.mjs PENDING_AGE; test/project-start-codex.test.mjs holds the two apart).
export const START_CAP = SESSION_WAIT + FIRST_TOOL_WAIT + BEACON_GRACE + 2 * STOP_WAIT;
const PS_TIMEOUT = 10_000;
// The most of the run log read for an event.
const LOG_CAP = 8 * 1024 * 1024;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const NAME = /^[^\s-][^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,99}$/u;
const PLAIN_NAME = /^[\w .@:\u00b7-]+$/u;
// A Codex thread id, and the id a start gives its process.
const THREAD = /^[0-9A-Za-z][\w-]{3,127}$/u;
const PROCESS_ID = /^pid-([1-9][0-9]{0,9})-([0-9a-f]{16})$/u;
// The items of `codex exec --json` that are a tool call: a shell command, a file change, and an MCP tool's call. A
// to-do list, a web search, a message, or reasoning is none.
const TOOLS = new Set(['command_execution', 'file_change', 'mcp_tool_call']);
// The variables a Codex session sets for what it runs; the new session gets its own, never the driver's.
const OWN_VARS = ['CODEX_THREAD_ID'];
const NO_CODEX = '`codex` is not on PATH, in an absolute folder';
// The process table read the same in every environment: its start time in English, in UTC.
const PS_ENV = () => ({ ...process.env, LC_ALL: 'C', TZ: 'UTC' });

export { runCommand };

// Starts `command` detached, in its own process group, with its output to the open file `fd`: { pid }, with pid
// undefined when it could not be started.
export function launchCommand(command, args, { cwd, env, fd }) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
  child.on('error', () => {});
  child.unref();
  return { pid: child.pid };
}

// The `codex` executable on the absolute folders of `env.PATH`, or null.
export const codexOnPath = (env) => programOnPath(env, programNames('codex'));

// The process table's program, by its absolute path, so no folder on PATH can stand in for it; null where there is none,
// as on Windows. Looked for on first use: hooks load every adapter, which reads no file when loaded.
let ps;
const psProgram = () => (ps ??= ['/bin/ps', '/usr/bin/ps'].find((file) => existsSync(file)) ?? null);

// The state and start of process `pid` as the process table gives them: { gone: true } when it lists no such process,
// { digest, zombie } with the digest of its start time, or null when the table cannot be read.
export function processState(pid, run = runCommand) {
  const program = psProgram();
  if (!program || !Number.isInteger(pid) || pid < 1) return null;
  const result = run(program, ['-o', 'stat=', '-o', 'lstart=', '-p', String(pid)], { cwd: undefined, timeout: PS_TIMEOUT, env: PS_ENV() });
  if (result.error) return null;
  const text = String(result.stdout ?? '').trim();
  if (text === '') return result.status === 0 ? null : { gone: true };
  const [stat, ...start] = text.split(/\s+/u);
  if (start.length === 0) return null;
  return { digest: createHash('sha256').update(start.join(' ')).digest('hex').slice(0, 16), zombie: stat.startsWith('Z') };
}

// The pid and start digest a start's id names, or null.
function processOf(id) {
  const match = PROCESS_ID.exec(String(id ?? ''));
  return match ? { pid: Number(match[1]), digest: match[2] } : null;
}

// Whether the process a start's id names runs no more: true when the table lists no such pid, a zombie, or a process
// that started at another time, which took the pid over; false while it runs; null when the table cannot be read or the
// id names no process.
export function processEnded({ id, run = runCommand }) {
  const own = processOf(id);
  if (!own) return null;
  const state = processState(own.pid, run);
  if (!state) return null;
  return Boolean(state.gone || state.zombie || state.digest !== own.digest);
}

// Sends `signal` to the process group of `pid`, else to `pid` alone: whether it went.
function signalGroup(pid, signal) {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      // No such group, or gone: the process alone, or nothing.
    }
  }
  return false;
}

// Stops the process a start's id names, and its process group, only while its start time is the recorded one: SIGTERM,
// then SIGKILL once STOP_WAIT has passed. Whether it runs no more: a process that had already ended counts.
// `started`, when given, is the id the start returned, which the gate passes beside the session's own id.
export function stopProcess({ id, started, run = runCommand, wait = pauseSync }) {
  const own = processOf(started ?? id);
  if (!own) return false;
  const ended = () => processEnded({ id: `pid-${own.pid}-${own.digest}`, run });
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    // Read right before each signal: the pid is signalled only while it is still the recorded process.
    const now = ended();
    if (now !== false) return now === true;
    signalGroup(own.pid, signal);
    for (let step = 0; step < STOP_WAIT / STEP; step += 1) {
      if (ended() === true) return true;
      wait(STEP);
    }
  }
  return ended() === true;
}

// The `codex exec` processes the process table lists with `--cd <cwd>`, by `cwd` as given or by its real path, as
// [{ id, session, state }], or null when it cannot be read: how a project run finds a process an uncertain start may
// have left. `name` is not Codex's: it names no session, and one attempt's folder holds one session.
export function findProcesses({ cwd, run = runCommand }) {
  const program = psProgram();
  if (!program || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const result = run(program, ['-A', '-ww', '-o', 'pid=', '-o', 'stat=', '-o', 'command='], { cwd: undefined, timeout: PS_TIMEOUT, env: PS_ENV() });
  if (result.error || result.status !== 0) return null;
  let real = cwd;
  try {
    real = realpathSync(cwd);
  } catch {
    // Gone: its spelling as given.
  }
  const found = [];
  for (const line of String(result.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/u.exec(line);
    if (!match || match[2].startsWith('Z')) continue;
    const words = match[3].split(' ');
    const at = words.indexOf('exec');
    if (at < 0 || !/(?:^|\/)codex(?:\.exe|\.cmd)?$/u.test(words.slice(0, at).join(' '))) continue;
    if (![cwd, real].some((folder) => match[3].includes(` --cd ${folder} `))) continue;
    const state = processState(Number(match[1]), run);
    if (state?.digest) found.push({ id: `pid-${match[1]}-${state.digest}`, session: null, state: 'working' });
  }
  return found;
}

// The JSON objects of the whole lines of the log `log`, at most LOG_CAP of it, or null when it cannot be read.
function logEvents(log) {
  let fd;
  let text;
  try {
    fd = openSync(log, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(Math.min(fstatSync(fd).size, LOG_CAP));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const events = [];
  for (const line of text.split('\n').slice(0, -1)) {
    try {
      const value = JSON.parse(line);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) events.push(value);
    } catch {
      // Codex's own messages on stderr: not an event.
    }
  }
  return events;
}

// The thread id of the first JSON event the log `log` holds: the id when it is a `thread.started` event with one, null
// when the first is anything else, or undefined while there is none. Lines that are not JSON objects are passed over.
export function firstEvent(log) {
  const [first] = logEvents(log) ?? [];
  if (!first) return undefined;
  return first.type === 'thread.started' && typeof first.thread_id === 'string' && THREAD.test(first.thread_id) ? first.thread_id : null;
}

// Whether the log `log` holds the session's first tool call: true; { failed } with the message of a `turn.failed` event
// before any, which ends the wait; or undefined while it holds neither. A top-level `error` event is no cause to halt:
// which of them are fatal no live run has shown yet (docs/providers/codex.md), and Codex goes on after some, such as a
// retried stream, so the wait reads on to a tool call, a `turn.failed`, or its own limit.
export function firstTool(log) {
  for (const event of logEvents(log) ?? []) {
    if (typeof event.type !== 'string') continue;
    if (event.type.startsWith('item.') && TOOLS.has(event.item?.type)) return true;
    if (event.type === 'turn.failed') {
      const message = event.error?.message ?? event.message;
      return { failed: String(typeof message === 'string' ? message : event.type).replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ').slice(0, 200) };
    }
  }
  return undefined;
}

// Reads `read()` every STEP until it gives anything but undefined, or `gone()` says the process ended, at most `ms`
// worth of steps: what it gave, or undefined. The steps are counted, not timed, so a test's `wait` sets how long that takes.
function poll(ms, wait, read, gone = () => false) {
  for (let step = 0; step <= Math.ceil(ms / STEP); step += 1) {
    if (step > 0) wait(STEP);
    const value = read();
    if (value !== undefined) return value;
    if (gone()) return read();
  }
  return undefined;
}

// The environment of the new session: the driver's, without the variables Codex sets for a session of its own.
const childEnv = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => !OWN_VARS.includes(name)));

// Why the start's inputs cannot start a session, or null: the folder, name, prompt, log, beacon read, and each folder
// `grants` names, which must be absolute paths of plain text.
function inputProblem({ cwd, name, prompt, log, beacon, grants }) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || CONTROL.test(cwd)) return 'the folder to start the session in is not an absolute path of plain text';
  if (typeof name !== 'string' || !NAME.test(name)) return 'the session\'s name is not plain text of at most 100 characters that cannot read as a flag';
  if (typeof prompt !== 'string' || prompt.trim() === '' || /^\s*[-/]/u.test(prompt)) {
    return 'the first message is empty, or starts with a dash, which would read as a flag, or a slash, which would read as a command';
  }
  if (typeof log !== 'string' || !path.isAbsolute(log) || CONTROL.test(log)) return 'the gate named no run log for the session\'s events';
  if (typeof beacon !== 'function') return 'the gate gave no way to read the agent gate hook\'s beacon';
  if (!Array.isArray(grants) || grants.some((each) => typeof each !== 'string' || !path.isAbsolute(each) || CONTROL.test(each))) return 'a folder the gate grants the session is not an absolute path of plain text';
  return null;
}

// The real path of each of `folders`, or { problem }.
function realPaths(folders) {
  try {
    const real = folders.map((each) => realpathSync(each));
    return real.some((each) => CONTROL.test(each)) ? { problem: 'a folder of the start resolves to a path that is not plain text' } : { real };
  } catch (error) {
    return { problem: `a folder of the start cannot be resolved (${error.code ?? 'no code'})` };
  }
}

// Starts the session of one issue of a project run, as hosts/codex.mjs `capabilities.projectStart.start`: `codex exec`
// in the attempt's work folder `cwd`, by its real path, with `--add-dir` for each of `grants`, whose first message is
// `prompt`, and its events in the run log `log`, a file this start makes or empties, owner-only. `hold({ cwd, known })`
// files the pending mark that holds every session but the driver's: no id is known before the start. Then the proofs:
// the session id, after which `identify({ id, session })` files its floor and mark; its first tool call; and
// `beacon(thread)`. Returns { id, session, name, cwd, mode: null }; { problem, uncertain: false } when nothing runs, with
// `proof` naming the proof that failed when a process that started was stopped for it; or { problem, uncertain: true }
// when it could not be stopped. `limits` is a test's { session, tool, beacon } in milliseconds of steps.
export function startProject({ cwd, prompt, name, env, hold, identify, log, beacon, grants = [], run = runCommand, wait = pauseSync, launch = launchCommand, resolve = codexOnPath, limits = {} }) {
  const bad = inputProblem({ cwd, name, prompt, log, beacon, grants });
  if (bad) return { problem: bad };
  const folders = realPaths([cwd, ...grants]);
  if (folders.problem) return { problem: folders.problem };
  const [real, ...granted] = folders.real;
  const codex = resolve(env);
  if (!codex) return { problem: NO_CODEX };
  if (!psProgram()) return { problem: 'this system has no process table program at /bin/ps or /usr/bin/ps, so a Codex session could never be stopped safely' };
  if (typeof hold !== 'function' || !hold({ cwd: real, known: [] })) return { problem: 'the gate could not record the pending mark that holds the new session as unattended until its own mark is written' };
  const launched = launchIn({ codex, real, granted, prompt, env, log, launch });
  if (launched.problem) return launched;
  return proveStart({ ...launched, real, name, log, beacon, identify, run, wait, limits });
}

// Runs `codex exec` with its output to `log`: { pid } of a process this one has not reaped, or { problem, uncertain }.
function launchIn({ codex, real, granted, prompt, env, log, launch }) {
  let fd;
  try {
    fd = openSync(log, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    return { problem: `the run log ${log} cannot be written (${error.code ?? 'no code'})`, uncertain: false };
  }
  let started;
  try {
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--cd', real, ...granted.flatMap((each) => ['--add-dir', each]), prompt];
    started = launch(codex, args, { cwd: real, env: childEnv(env), fd });
  } catch (error) {
    started = { pid: undefined, error };
  } finally {
    closeSync(fd);
  }
  const pid = started?.pid;
  if (!Number.isInteger(pid) || pid < 1) return { problem: `\`codex\` could not be run (${started?.error?.code ?? 'no process'})`, uncertain: false };
  return { pid };
}

// The proofs of a launched session, process `pid`: { id, session, ... } once all hold, else it is stopped.
function proveStart({ pid, real, name, log, beacon, identify, run, wait, limits }) {
  // This process has not reaped the child, so its pid is still its own: read its start time now.
  const state = processState(pid, run);
  const id = state?.digest ? `pid-${pid}-${state.digest}` : null;
  const stopped = (why, proof = null) => {
    const gone = id ? stopProcess({ id, run, wait }) : signalGroup(pid, 'SIGKILL');
    if (!gone) return { problem: `${why}, and the process ${pid} could not be stopped`, uncertain: true };
    return { problem: `${why}; the process was stopped`, uncertain: false, ...(proof ? { proof } : {}) };
  };
  if (!id) return stopped('the start time of the `codex exec` process cannot be read, so it could never be stopped safely');
  const gone = () => processEnded({ id, run }) === true;
  const seconds = (ms) => Math.round(ms / 1000);
  const sessionWait = limits.session ?? SESSION_WAIT;
  const thread = poll(sessionWait, wait, () => firstEvent(log), gone);
  if (!thread) return stopped(`\`codex exec\` gave no session id in its first JSON event within ${seconds(sessionWait)} seconds`, 'session');
  if (typeof identify === 'function' && identify({ id, session: thread }) !== true) return stopped('the gate could not file the new session\'s floor and mark');
  const toolWait = limits.tool ?? FIRST_TOOL_WAIT;
  const tool = poll(toolWait, wait, () => firstTool(log), gone);
  if (tool?.failed) return stopped(`Codex reported \`${tool.failed}\` before the session made any tool call, so whether it runs the plugin's hooks cannot be shown`, 'tool');
  if (tool !== true) return stopped(`the session made no tool call within ${seconds(toolWait)} seconds, so whether Codex runs the plugin's hooks cannot be shown`, 'tool');
  const grace = limits.beacon ?? BEACON_GRACE;
  const beaconed = poll(grace, wait, () => {
    try {
      return beacon(thread) === true ? true : undefined;
    } catch {
      return undefined;
    }
  });
  if (!beaconed) return stopped(`the plugin's agent gate hook did not run on the session's first tool call within ${seconds(grace)} seconds of it, so Codex may not run the plugin's hooks under \`codex exec\``, 'beacon');
  return { id, session: thread, name: PLAIN_NAME.test(name) ? name : null, cwd: real, mode: null };
}

// How the Human looks at a session a start made: its events in the run log, and its process.
export function attachLine({ id }) {
  const own = processOf(id);
  return own ? `it runs as the process ${own.pid} under \`codex exec\`, with its events in the run's log` : 'it runs under `codex exec`, with its events in the run\'s log';
}

// How the Human stops one by hand, when the gate could not.
export function stopLine({ id }) {
  const own = processOf(id);
  return own ? `\`kill ${own.pid}\` stops it, once \`ps -p ${own.pid}\` shows it is still \`codex exec\`` : '`ps` lists the `codex exec` processes, and `kill <pid>` stops one';
}

// What the session is told beside the project prompt: it works only in its attempt's folder, pushes its branch with a
// full refspec, and names the branch to every forge command, since its clone tracks no branch of the forge.
export const sessionNote = ({ work, branch }) => `This session runs in Codex's workspace-write sandbox, in ${work}, a clone made for this attempt: work only in that folder. ` +
  `Push only with \`git push origin HEAD:refs/heads/${branch}\`, and name the branch to every forge command, as \`gh pr create --head ${branch}\`.`;
