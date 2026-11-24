// The OpenCode bridge: a server plugin that runs the plugin's hook scripts on OpenCode's tool events, as hooks.json runs
// them on a host that reads it. At setup it reads routes.generated.json, every hooks.json hook as `npm run build` writes
// it, through route-select.mjs, and registers one callback for each OpenCode tool hook that EVENTS (routes.mjs) maps a standard event to. On each
// call it reads the tool's standard name through lib/hosts/opencode-names.mjs, the one table the adapter reads too, and
// runs every route of that event whose matcher fires on the name, in parallel, as Claude Code runs matching hooks. It
// sends each script the standard hook envelope on stdin, with OpenCode's own tool name, input, and result inside and a
// top-level `opencode` object, { version?, info }, that marks it as OpenCode's and holds the part of the tool's `info`
// the leaf read, so lib/hosts/opencode.mjs maps the payload to the name the bridge picked. It also prepends the
// plugin's bin/ to every shell's PATH, so the `aidrian` that reads a record is the copy whose hook wrote it.
//
// The payload holds text a model wrote, so the spawn is pinned: the program is Node, the arguments the script's absolute
// path and the route's literal flags, the options `cwd`, `env` as the process has it, and `stdio`, with no shell, and
// the payload reaches the child on stdin alone. No callback rejects, `setup` never throws, and the tool's result is
// never changed: a hook that cannot run leaves the call as it would be without the plugin. EVENTS names PostToolUse
// alone, since a blocking route needs this file to turn the script's exit 2 into a throw that keeps its stderr first,
// which it does not yet do.
//
// With AIDRIAN_OPENCODE_TRACE naming an absolute file, it appends one JSON line a step, { at, step, script?, status?,
// count? }: `setup` once, `run` for each script it ran, `skip` for a call it sent nothing for, and `off` once, when it
// stops spawning. A call whose tool name the leaf cannot read, such as an MCP tool's, runs nothing and is a `skip` with
// status `unguarded`, whose `count` is how many such calls this process has met. No command, payload, or output is
// ever written there.
//
// It imports node: built-ins, routes.mjs, route-select.mjs, and the leaf, which imports nothing, so it loads in
// OpenCode's Bun and under `node --test` alike.

import { spawn as nodeSpawn } from 'node:child_process';
import { appendFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { infoRead, standardToolName } from '../lib/hosts/opencode-names.mjs';
import { readRoutes, selectRoutes } from './route-select.mjs';
import { EVENTS } from './routes.mjs';

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

// The trace writer of `env`: appends { at, step, script?, status?, count? } to an absolute AIDRIAN_OPENCODE_TRACE, else
// nothing.
function tracer(env) {
  const file = env?.AIDRIAN_OPENCODE_TRACE;
  if (!absolute(file)) return () => {};
  return (step, { script, status, count } = {}) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), step, script, status, count })}\n`, { mode: 0o600 });
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
// plugin's scripts/ and bin/ folders, the generated route file (`routes`), and the Node program; OpenCode passes none.
// It resolves whatever fails.
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

// Registers one callback for each OpenCode tool hook of EVENTS that a route with its script on disk runs on, then the
// PATH hook. The `setup` trace line counts the tool hooks registered; a route file that cannot be read is a `skip` with
// status `routes` before it, and registers no tool hook.
async function registerAll(context, seams) {
  const { spawn = nodeSpawn, env = process.env, scripts = fileURLToPath(new URL('../scripts', import.meta.url)),
    bin = fileURLToPath(new URL('../bin', import.meta.url)), node = nodeOf(env),
    routes: routesFile = fileURLToPath(new URL('./routes.generated.json', import.meta.url)) } = seams ?? {};
  const trace = tracer(env);
  const read = readRoutes(routesFile);
  if (read === null) trace('skip', { status: 'routes' });
  const routes = (read ?? []).filter((route) => Object.hasOwn(EVENTS, route.event))
    .map((route) => ({ ...route, file: path.join(scripts, route.script) })).filter((route) => isFile(route.file));
  const runner = { context, env, node, spawn, trace, routes, off: false, unguarded: 0, roots: new Map() };
  let registered = 0;
  for (const hook of new Set(routes.map((route) => EVENTS[route.event]))) {
    if (await register(() => context.tool.hook(hook, (event) => onCall(runner, hook, event)))) registered += 1;
  }
  await register(() => context.shell.hook('create.before', (event) => addBin(event, bin)));
  trace('setup', { status: registered });
}

// The callback of the OpenCode tool hook `hook`, for one tool event: runs the script of every route it selects, and
// resolves. OpenCode waits for the callback before it hands the call back. The session reads happen once, before any
// spawn, under one deadline of the longest selected route's timeout, and a call whose reads outlast it sends nothing;
// each script then has its own route's timeout from its own spawn, and is killed when that ends.
async function onCall(runner, hook, event) {
  let deadline = null;
  try {
    // One read of info, which picks the routes and reaches the scripts, so the adapter reads the name the bridge picked.
    const info = infoRead(event?.info);
    const name = standardToolName(event?.tool, info);
    if (name === null) {
      runner.unguarded += 1;
      runner.trace('skip', { status: 'unguarded', count: runner.unguarded });
      return;
    }
    const selected = selectRoutes(runner.routes, EVENTS, hook, name);
    if (selected.length === 0) return;
    deadline = deadlineOf(Math.max(...selected.map((route) => route.timeoutMs)));
    let call = runner.off ? { skip: 'off' } : await callOf(runner, name, event, info, deadline.read);
    if (!call.skip && deadline.passed()) call = { skip: 'timeout' };
    deadline.end();
    if (call.skip) {
      for (const route of selected) runner.trace('skip', { script: route.script, status: call.skip });
      return;
    }
    await Promise.all(selected.map((route) => run(runner, route, call)));
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

// What one event of the standard tool `name` sends, { cwd, event, root, info }, or { skip: <why> } for a call it sends
// nothing for; `info` is what the leaf read of the event's. A hook of a host that reads hooks.json runs after a call that succeeded, so only a completed call is
// sent. Each session read goes through `read`, the deadline's.
async function callOf(runner, name, event, info, read) {
  if (event.status !== 'completed') return { skip: 'status' };
  const input = event.input ?? {};
  if (name === 'Bash' && typeof input.command !== 'string') return { skip: 'command' };
  if (typeof event.sessionID !== 'string') return { skip: 'session' };
  const get = (sessionID) => read(() => runner.context.session.get({ sessionID }));
  const cwd = await folderOf(runner.context, get, event.sessionID, input.workdir);
  if (!cwd) return { skip: 'cwd' };
  const root = await rootOf(runner, get, event.sessionID);
  return { cwd, event, root, info };
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

// The standard envelope of the call for `route`: a subagent's call carries its root as session_id and its own id as
// agent_id, so its records land in the root session's folder, as a subagent's do on a host that reads hooks.json.
// `tool_name` is OpenCode's own, which the adapter maps through the same leaf, reading `opencode.info`.
function payloadOf(context, route, { cwd, event, root, info }) {
  // OpenCode 2.4.0's plugin context names its version under `app`: { name, version, channel }.
  const version = context.app?.version;
  const mark = typeof version === 'string' ? { version, info } : { info };
  const agent = root === event.sessionID ? {} : { agent_id: event.sessionID };
  const callId = typeof event.id === 'string' ? { tool_use_id: event.id } : {};
  return {
    hook_event_name: route.event, opencode: mark, session_id: root, ...agent, cwd,
    tool_name: event.tool, tool_input: event.input, tool_response: event.result, ...callId,
  };
}

// Runs `route`'s script on the call and resolves when it closes, fails to start, or is killed when its own timeout,
// counted from its spawn, ends. An ENOENT is a missing `cwd` when that is no folder, as for a call in a folder it then
// removed, and skips that call alone; with `cwd` a folder it is a missing Node, and the bridge stops spawning for the
// life of the process.
function run(runner, route, call) {
  const { cwd } = call;
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = (step, status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner.trace(step, { script: route.script, status });
      resolve();
    };
    let text;
    let child;
    try {
      text = JSON.stringify(payloadOf(runner.context, route, call));
      child = runner.spawn(runner.node, [route.file, ...route.args], { cwd, env: runner.env, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      done('run', 'error');
      return;
    }
    child.on('error', (error) => done(...failed(runner, error, cwd)));
    child.on('exit', (code, signal) => done('run', code ?? signal));
    child.on('close', (code, signal) => done('run', code ?? signal));
    timer = setTimeout(() => {
      if (settled) return;
      kill(child);
      done('run', 'timeout');
    }, route.timeoutMs);
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
