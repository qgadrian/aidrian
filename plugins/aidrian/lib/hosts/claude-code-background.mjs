// Claude Code's side of the background route of session.handoff.continue (docs/providers/claude-code.md#the-background-route).
// `claude --bg` starts a session under the background-session supervisor and prints its short id; `claude agents --json`,
// the listing its docs name as the stable interface, gives each session's `id`, `sessionId`, `name`, `kind`, and `cwd`.
// `--bg` ignores `--session-id`, so the new session's id is read back from that listing, which may lag the start.
// Every call goes through `run`, spawnSync's shape, which a test replaces, so no test starts a real session. `claude` is
// found on the absolute folders of PATH alone: an empty or relative entry would run whatever `claude` the folder holds.

import { spawnSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

// `claude --bg` may first start the supervisor, which takes a few seconds.
const START_TIMEOUT = 60_000;
const LIST_TIMEOUT = 15_000;
// How often, and how far apart, the listing is read again for a session the start just made: about 5 seconds.
const LIST_TRIES = 10;
const LIST_PAUSE = 500;
// Its output: `backgrounded · <short id> · <name>`, then the commands that manage the session.
const STARTED = /\bbackgrounded\s*·\s*([0-9A-Za-z][0-9A-Za-z-]{3,63})\b/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
// A session name the command passes on: plain text that cannot read as a flag.
const NAME = /^[^\s-][^\u0000-\u001f\u007f-\u009f\u2028\u2029]{0,99}$/u;
// A name the say line prints, in single quotes: no quote, `$`, `;`, or other character a shell reads inside them.
// lib/handoff-markers.mjs holds a started marker's name to the same pattern; importing it here would loop the modules.
const PLAIN_NAME = /^[\w .@:\u00b7-]+$/u;
// An agent name the command passes on: a word, or `<plugin>:<agent>`.
const AGENT = /^[A-Za-z0-9][\w.:-]{0,127}$/u;
const ID = /^[0-9A-Za-z][\w-]{3,127}$/u;

export const runCommand = (command, args, { cwd, timeout }) => spawnSync(command, args, { cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

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

// The sessions `claude agents --json` lists, or null when it cannot answer.
function listed(run, claude, cwd) {
  const result = run(claude, ['agents', '--json'], { cwd, timeout: LIST_TIMEOUT });
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

// Starts the session that resumes a brief, in the background, in the folder of the handing-off session `session` as the
// host lists it: { id, session, name, cwd }, or { problem } when none started. `id` is the id to name it by, the short
// one when the output printed it; `session` its full id, or null when the listing did not name it within about 5
// seconds; `name` its name when it is plain text no other listed session has, else null. A start that timed out or
// failed still counts when the listing then shows it. `agent` and `effort` are the handing-off session's, passed on when
// known. `run` and `wait` are a test's stand-ins, and `resolve` finds `claude` from `env`.
export function startBackground({ session, slug, chain, agent, effort, efforts, prompt, env, run = runCommand, wait = pause, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude) return { problem: '`claude` is not on PATH, in an absolute folder' };
  const before = listed(run, claude, undefined);
  if (!before) return { problem: '`claude agents --json` did not answer, so the folder of this session is unknown' };
  const own = before.find((each) => each.sessionId === session);
  if (typeof own?.cwd !== 'string' || !path.isAbsolute(own.cwd) || CONTROL.test(own.cwd)) {
    return { problem: '`claude agents --json` does not list the folder of this session' };
  }
  const name = sessionName(own.name, slug, chain);
  const args = ['--bg', '--name', name];
  if (typeof agent === 'string' && AGENT.test(agent)) args.push('--agent', agent);
  if (efforts.includes(effort)) args.push('--effort', effort);
  const result = run(claude, [...args, prompt], { cwd: own.cwd, timeout: START_TIMEOUT });
  const printed = STARTED.exec(String(result.stdout ?? ''))?.[1] ?? null;
  const want = { before: new Set(before.map((each) => each.sessionId)), cwd: own.cwd, id: printed, name };
  const { entry, list } = awaitSession({ run, claude, wait, ...want });
  if (!entry && !printed) return { problem: startProblem(result) };
  const id = printed ?? (typeof entry.id === 'string' && ID.test(entry.id) ? entry.id : entry.sessionId);
  const unique = (list ?? []).filter((each) => each.name === name).length === 1;
  return { id, session: entry?.sessionId ?? null, name: unique && PLAIN_NAME.test(name) ? name : null, cwd: own.cwd };
}

// Why a start that printed no id and that the listing does not show made no session.
function startProblem(result) {
  if (result.error?.code === 'ENOENT') return '`claude` is not on PATH';
  if (result.error) return `\`claude --bg\` did not finish (${result.error.code ?? 'no code'}), and \`claude agents\` lists no session it started`;
  if (result.status !== 0) return `\`claude --bg\` exited ${result.status}: ${firstLine(result.stderr || result.stdout) || 'no message'}`;
  return '`claude --bg` printed no session id, and `claude agents` lists no session it started';
}

// Stops the background session `id`, as `claude stop` does: whether it exited 0.
export function stopBackground({ id, env, run = runCommand, resolve = claudeOnPath }) {
  const claude = resolve(env);
  if (!claude || typeof id !== 'string' || !ID.test(id)) return false;
  const result = run(claude, ['stop', id], { cwd: undefined, timeout: LIST_TIMEOUT });
  return !result.error && result.status === 0;
}
