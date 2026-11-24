// The OpenCode bridge: a server plugin that runs the plugin's hook scripts on OpenCode's tool events, as hooks.json runs
// them on a host that reads it. For each row of ROUTES (routes.mjs) it registers one callback, which sends the script
// the standard hook envelope on stdin, with OpenCode's own tool name, input, and result inside and a top-level `opencode`
// object that marks it as OpenCode's; lib/hosts/opencode.mjs maps that to the standard names. It also prepends the
// plugin's bin/ to every shell's PATH, so the `aidrian` that reads a record is the copy whose hook wrote it.
//
// The payload holds text a model wrote, so the spawn is pinned: the program is Node, the one argument the script's
// absolute path, the options `cwd`, `env` as the process has it, and `stdio`, with no shell, and the payload reaches
// the child on stdin alone. No callback rejects, `setup` never throws, and the tool's result is never changed: a hook
// that cannot run leaves the call as it would be without the plugin. This file never changes when a route is added.
//
// With AIDRIAN_OPENCODE_TRACE naming an absolute file, it appends one JSON line a step, { at, step, script?, status? }:
// `setup` once, `run` for each script it ran, `skip` for a call of a route's tool it sent nothing for, and `off` once,
// when it stops spawning. No command, payload, or output is ever written there.
//
// It imports only node: built-ins and routes.mjs, so it loads in OpenCode's Bun and under `node --test` alike.

import { spawn as nodeSpawn } from 'node:child_process';
import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTES } from './routes.mjs';

// How many parent sessions the root walk reads at most, and how many child-to-root answers it keeps before it forgets them.
const PARENT_STEPS = 8;
const ROOTS_MAX = 256;

const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};
const isFolder = (dir) => {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

// The trace writer of `env`: appends { at, step, script?, status? } to an absolute AIDRIAN_OPENCODE_TRACE, else nothing.
function tracer(env) {
  const file = env?.AIDRIAN_OPENCODE_TRACE;
  if (!absolute(file)) return () => {};
  return (step, { script, status } = {}) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), step, script, status })}\n`, { mode: 0o600 });
    } catch {
      // A trace that cannot be written changes nothing the bridge does.
    }
  };
}

// Registers `call`'s hook; false when it throws or rejects, so one registration that fails leaves the others.
async function register(call) {
  try {
    await call();
    return true;
  } catch {
    return false;
  }
}

// The plugin's setup on OpenCode's `context`. The seams stand in for Node's spawn, the process environment, the
// plugin's scripts/ and bin/ folders, and the Node program; OpenCode passes none. It resolves whatever fails.
export async function setup(context, seams) {
  try {
    await registerAll(context, seams);
  } catch {
    // A plugin that cannot set up leaves OpenCode as it would be without it.
  }
}

// The Node program: an absolute AIDRIAN_NODE, else `node` from PATH, since OpenCode's own binary is Bun and a relative
// value would resolve against each call's folder.
const nodeOf = (env) => (absolute(env?.AIDRIAN_NODE) ? env.AIDRIAN_NODE : 'node');

async function registerAll(context, seams) {
  const { spawn = nodeSpawn, env = process.env, scripts = fileURLToPath(new URL('../scripts', import.meta.url)),
    bin = fileURLToPath(new URL('../bin', import.meta.url)), node = nodeOf(env) } = seams ?? {};
  const runner = { context, env, node, spawn, trace: tracer(env), off: false, roots: new Map() };
  let registered = 0;
  for (const route of ROUTES) {
    const file = path.join(scripts, route.script);
    if (!isFile(file)) continue;
    if (await register(() => context.tool.hook(route.on, (event) => onCall(runner, route, file, event)))) registered += 1;
  }
  await register(() => context.shell.hook('create.before', (event) => addBin(event, bin)));
  runner.trace('setup', { status: registered });
}

// The callback of `route`, for one tool event: runs its script on the call when the call is the route's, and resolves.
// OpenCode waits for the callback before it hands the call back, so one deadline of the route's timeout ends it all:
// the session reads, and the script, which is killed when it ends. A call whose reads outlast it sends nothing.
async function onCall(runner, route, file, event) {
  let deadline = null;
  try {
    if (event?.tool !== route.tool) return;
    deadline = deadlineOf(route.timeoutMs);
    let call = runner.off ? { skip: 'off' } : await callOf(runner, route, event, deadline.read);
    if (!call.skip && deadline.passed()) call = { skip: 'timeout' };
    if (call.skip) {
      runner.trace('skip', { script: route.script, status: call.skip });
      return;
    }
    await run(runner, route, file, call, deadline);
  } catch {
    // A call the bridge cannot send runs on as it would without the plugin.
  } finally {
    deadline?.end();
  }
}

// One timer of `ms`: `ended` resolves when it fires and `passed()` says whether it has; `read(call)` gives what `call`
// gives, and throws, as a failed read does, for a call that throws or rejects and for one not settled by then. `end`
// stops the timer.
function deadlineOf(ms) {
  let timer = null;
  let passed = false;
  const ended = new Promise((resolve) => {
    timer = setTimeout(() => {
      passed = true;
      resolve();
    }, ms);
  });
  const late = ended.then(() => {
    throw new Error('the deadline passed');
  });
  late.catch(() => {});
  const read = (call) => Promise.race([Promise.resolve().then(call), late]);
  return { ended, passed: () => passed, read, end: () => clearTimeout(timer) };
}

// What one event sends, { cwd, payload }, or { skip: <why> } for a call it sends nothing for. A hook of a host that
// reads hooks.json runs after a call that succeeded, so only a completed call is sent. Each session read goes through
// `read`, the deadline's.
async function callOf(runner, route, event, read) {
  if (event.status !== 'completed') return { skip: 'status' };
  const input = event.input ?? {};
  if (route.standard === 'Bash' && typeof input.command !== 'string') return { skip: 'command' };
  if (typeof event.sessionID !== 'string') return { skip: 'session' };
  const get = (sessionID) => read(() => runner.context.session.get({ sessionID }));
  const cwd = await folderOf(runner.context, get, event.sessionID, input.workdir);
  if (!cwd) return { skip: 'cwd' };
  const root = await rootOf(runner, get, event.sessionID);
  return { cwd, payload: payloadOf(runner.context, route, event, root, cwd) };
}

// The folder the call ran in: an absolute `workdir`; with none, the calling session's folder, or the plugin's own when
// that read fails. A `workdir` that is not absolute, a relative path or another machine's `name:path`, gives null,
// since the folder it names is not known here.
async function folderOf(context, get, sessionID, workdir) {
  if (workdir !== undefined && workdir !== null) return absolute(workdir) ? workdir : null;
  let dir = null;
  try {
    dir = (await get(sessionID))?.location?.directory;
  } catch {
    dir = null;
  }
  if (absolute(dir)) return dir;
  const own = context.location?.directory;
  return absolute(own) ? own : null;
}

// The root of `sessionID`'s session tree, by its parents, PARENT_STEPS reads at most; the calling id when a read fails,
// which is not kept, so the next call reads again.
async function rootOf(runner, get, sessionID) {
  const known = runner.roots.get(sessionID);
  if (known) return known;
  let id = sessionID;
  try {
    for (let step = 0; step < PARENT_STEPS; step += 1) {
      const parent = (await get(id))?.parentID;
      if (typeof parent !== 'string' || parent === '' || parent === id) break;
      id = parent;
    }
  } catch {
    return sessionID;
  }
  if (runner.roots.size >= ROOTS_MAX) runner.roots.clear();
  runner.roots.set(sessionID, id);
  return id;
}

// The standard envelope of `event`: a subagent's call carries its root as session_id and its own id as agent_id, so its
// records land in the root session's folder, as a subagent's do on a host that reads hooks.json.
function payloadOf(context, route, event, root, cwd) {
  // OpenCode 2.4.0's plugin context names its version under `app`: { name, version, channel }.
  const version = context.app?.version;
  const mark = typeof version === 'string' ? { version } : {};
  const agent = root === event.sessionID ? {} : { agent_id: event.sessionID };
  const callId = typeof event.id === 'string' ? { tool_use_id: event.id } : {};
  return {
    hook_event_name: route.event, opencode: mark, session_id: root, ...agent, cwd,
    tool_name: event.tool, tool_input: event.input, tool_response: event.result, ...callId,
  };
}

// Runs `file` on the call and resolves when it closes, fails to start, or is killed when `deadline` ends. An ENOENT
// is a missing `cwd` when that is no folder, as for a call in a folder it then removed, and skips that call alone;
// with `cwd` a folder it is a missing Node, and the bridge stops spawning for the life of the process.
function run(runner, route, file, { cwd, payload }, deadline) {
  const text = JSON.stringify(payload);
  return new Promise((resolve) => {
    let settled = false;
    const done = (step, status) => {
      if (settled) return;
      settled = true;
      runner.trace(step, { script: route.script, status });
      resolve();
    };
    let child;
    try {
      child = runner.spawn(runner.node, [file], { cwd, env: runner.env, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      done('run', 'error');
      return;
    }
    child.on('error', (error) => done(...failed(runner, error, cwd)));
    child.on('exit', (code, signal) => done('run', code ?? signal));
    child.on('close', (code, signal) => done('run', code ?? signal));
    deadline.ended.then(() => {
      if (settled) return;
      kill(child);
      done('run', 'timeout');
    });
    feed(child, text);
  });
}

// The trace step and status of a child that failed to start with `error`, turning spawning off on a missing Node.
function failed(runner, error, cwd) {
  if (error?.code !== 'ENOENT') return ['run', error?.code ?? 'error'];
  if (!isFolder(cwd)) return ['skip', 'gone'];
  const first = !runner.off;
  runner.off = true;
  return [first ? 'off' : 'run', 'ENOENT'];
}

// Writes the payload to the child's stdin, where a child that exits first gives an EPIPE that changes nothing.
function feed(child, text) {
  try {
    child.stdin?.on('error', () => {});
    child.stdin?.end(text);
  } catch {
    // A child that cannot read its payload ends as it would without one.
  }
}

function kill(child) {
  try {
    child.kill('SIGKILL');
  } catch {
    // A child that already ended needs no signal.
  }
}

// The PATH hook: prepends `bin` to a shell's PATH unless the PATH holds it. A `bin` that is not absolute, or that holds
// the delimiter, would add a relative entry or more than one, so it changes nothing.
function addBin(event, bin) {
  try {
    if (!absolute(bin) || bin.includes(path.delimiter)) return;
    const vars = event?.env;
    if (typeof vars !== 'object' || vars === null) return;
    // A shell with no PATH of its own keeps none: bin alone would hide every system program. In OpenCode 2.4.0 the event
    // lacks a PATH only for a shell on another machine, where the server's own PATH is not that machine's.
    const current = vars.PATH;
    if (typeof current !== 'string' || current === '' || current.split(path.delimiter).includes(bin)) return;
    vars.PATH = `${bin}${path.delimiter}${current}`;
  } catch {
    // A shell whose environment cannot be changed starts as it would without the plugin.
  }
}
