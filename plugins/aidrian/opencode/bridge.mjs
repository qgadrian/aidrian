// The OpenCode bridge: a server plugin that runs the plugin's hook scripts on OpenCode's tool events, as hooks.json runs
// them on a host that reads it. At setup it reads routes.generated.json, every hooks.json hook as `npm run build` writes
// it, through route-select.mjs, and registers one callback for each OpenCode tool hook that EVENTS (routes.mjs) maps a standard event to. On each
// call it reads the tool's standard name through lib/hosts/opencode-names.mjs, the one table the adapter reads too, and
// runs every route of that event whose matcher fires on the name, in parallel, as Claude Code runs matching hooks. It
// sends each script the standard hook envelope on stdin, with OpenCode's own tool name, input, and result inside and a
// top-level `opencode` object, { version?, info }, that marks it as OpenCode's and holds the part of the tool's `info`
// the leaf read, so lib/hosts/opencode.mjs maps the payload to the name the bridge picked. call.mjs finds the call's
// folders and who made it. It also prepends the plugin's bin/ to every shell's PATH, so the `aidrian` that reads a
// record is the copy whose hook wrote it.
//
// The payload holds text a model wrote, so the spawn is pinned: the program is Node, resolved to an absolute file at
// setup, the arguments the script's absolute path and the route's literal flags, the options `cwd`, the session's
// folder, `env` as the process has it, and `stdio`, with no shell, and the payload reaches the child on stdin alone. No
// callback rejects, `setup` never throws, and the tool's result is never changed: a hook that cannot run leaves the call
// as it would be without the plugin. EVENTS names PostToolUse alone, since a blocking route needs this file to turn the
// script's exit 2 into a throw that keeps its stderr first, which it does not yet do; tests reach the blocking
// (execute.before) path through the `events` seam.
//
// With AIDRIAN_OPENCODE_TRACE naming an absolute file, it appends one JSON line a step, { at, step, script?, status?,
// count? }: `setup` once, `off` once at setup when it found no Node, `unregistered` for a hook OpenCode refused and for a
// route whose script is not on disk, `run` for each script it ran, and `skip` for a call it sent nothing for. A call
// whose tool name the leaf cannot read, such as an MCP tool's, runs nothing and is a `skip` with status `unguarded`,
// whose `count` is how many such calls this process has met. Each value is a script's file name, a word, or a number;
// no command, path, payload, or output is ever written there. What the session should be told, that no hook runs, that
// one did not register, or that a route file or script is missing, is kept in `notices`, which no hook reads in this
// version.
//
// It imports node: built-ins, its own folder, the leaf, which imports nothing, and lib/deadline.mjs, which imports
// nothing, so it loads in OpenCode's Bun and under `node --test` alike.

import { spawn as nodeSpawn } from 'node:child_process';
import { accessSync, appendFileSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELD_BUDGET_MS } from '../lib/deadline.mjs';
import { infoRead, standardToolName } from '../lib/hosts/opencode-names.mjs';
import { callOf } from './call.mjs';
import { readRoutes, selectRoutes } from './route-select.mjs';
import { EVENTS } from './routes.mjs';

// The OpenCode tool hook whose callback runs before a call, where a route's exit 2 is meant to block it.
const BLOCKING_HOOK = 'execute.before';
// A blocking route's script is killed no sooner than this long after its spawn: 1 s past the longest guard budget a
// script gives itself from its start (lib/deadline.mjs), so its own "could not finish in time" refusal comes first.
export const BLOCKING_KILL_MS = HELD_BUDGET_MS + 1000;

const absolute = (value) => typeof value === 'string' && path.isAbsolute(value);
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const isProgram = (file) => {
  if (!absolute(file) || !isFile(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// A trace value that names no path, command, or payload: a script's file name, a word, or a number.
const SCRIPT = /^[a-z0-9-]+\.mjs$/u;
const WORD = /^[A-Za-z0-9._-]{1,40}$/u;
const kept = (value, pattern) => (typeof value === 'string' && pattern.test(value) ? value : undefined);
const counted = (value) => (Number.isInteger(value) ? value : undefined);

// The trace writer of `env`: appends { at, step, script?, status?, count? } to an absolute AIDRIAN_OPENCODE_TRACE, else
// nothing. A value of another shape is left out.
function tracer(env) {
  const file = env?.AIDRIAN_OPENCODE_TRACE;
  if (!absolute(file)) return () => {};
  return (step, { script, status, count } = {}) => {
    const line = { at: new Date().toISOString(), step, script: kept(script, SCRIPT), status: counted(status) ?? kept(status, WORD), count: counted(count) };
    try {
      appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
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
// plugin's scripts/ and bin/ folders, the generated route file (`routes`), the Node program (null for none found), the
// event map (`events`), and the list the session's notices go to; OpenCode passes none. It resolves whatever fails.
export async function setup(context, seams) {
  try {
    await registerAll(context, seams);
  } catch {
    // A plugin that cannot set up leaves OpenCode as it would be without it.
  }
}

// The Node program as an absolute file, or null: an absolute AIDRIAN_NODE, else this process's own program when it is
// Node, else the first `node` on an absolute PATH entry. OpenCode's own binary is Bun, and a bare `node` would be
// looked up on each spawn.
export function nodeOf(env, execPath = process.execPath) {
  if (isProgram(env?.AIDRIAN_NODE)) return env.AIDRIAN_NODE;
  if (/^node(?:\.exe)?$/u.test(path.basename(execPath ?? '')) && isProgram(execPath)) return execPath;
  const dirs = typeof env?.PATH === 'string' ? env.PATH.split(path.delimiter).filter(absolute) : [];
  return dirs.map((dir) => path.join(dir, 'node')).find(isProgram) ?? null;
}

// Registers one callback for each OpenCode tool hook of `events` that a route with its script on disk runs on, then the
// PATH hook. The `setup` trace line counts the tool hooks registered. With no Node it registers no tool hook, and says
// so once.
async function registerAll(context, seams) {
  const { spawn = nodeSpawn, env = process.env, scripts = fileURLToPath(new URL('../scripts', import.meta.url)),
    bin = fileURLToPath(new URL('../bin', import.meta.url)), node = nodeOf(env),
    routes: routesFile = fileURLToPath(new URL('./routes.generated.json', import.meta.url)), events = EVENTS, notices = [] } = seams ?? {};
  const trace = tracer(env);
  const routes = routesOf(routesFile, scripts, events, trace, notices);
  // `notices`: what the session's context should be told, kept in notices, which no hook reads in this version.
  const runner = { context, env, node, spawn, trace, routes, events, notices, unguarded: 0, roots: new Map() };
  let registered = 0;
  if (!absolute(node)) {
    trace('off', { status: 'node' });
    notices.push('aidrian found no Node program (Node 22 on the PATH of the OpenCode service, or AIDRIAN_NODE as an absolute path), so no aidrian hook runs in this session.');
  } else {
    for (const hook of new Set(routes.map((route) => events[route.event]))) {
      if (await register(() => context.tool.hook(hook, (event) => onCall(runner, hook, event)))) registered += 1;
      else lost(trace, notices, hook, [...new Set(routes.filter((route) => events[route.event] === hook).map((route) => route.script))]);
    }
  }
  if (!await register(() => context.shell.hook('create.before', (event) => addBin(event, bin)))) lost(trace, notices, 'create.before', []);
  trace('setup', { status: registered });
}

// The routes of `file` whose event `events` names, each with its script's absolute `file`, that script on disk. A route
// file that cannot be read is a `skip` with status `routes`, and a route whose script is not on disk an `unregistered`
// line with status `missing`; each keeps a notice.
function routesOf(file, scripts, events, trace, notices) {
  const read = readRoutes(file);
  if (read === null) {
    trace('skip', { status: 'routes' });
    notices.push("aidrian could not read its route list, routes.generated.json, so no aidrian hook runs in this session.");
  }
  const routes = (read ?? []).filter((route) => Object.hasOwn(events, route.event)).map((route) => ({ ...route, file: path.join(scripts, route.script) }));
  const missing = [...new Set(routes.filter((route) => !isFile(route.file)).map((route) => route.script))];
  for (const script of missing) trace('unregistered', { script, status: 'missing' });
  if (missing.length > 0) notices.push(`aidrian's hook scripts not on disk do not run in this session: ${missing.join(', ')}.`);
  return routes.filter((route) => isFile(route.file));
}

// Traces and keeps a notice for the OpenCode hook `hook` that did not register, with the `scripts` it would have run.
function lost(trace, notices, hook, scripts) {
  if (scripts.length === 0) trace('unregistered', { status: hook });
  for (const script of scripts) trace('unregistered', { script, status: hook });
  const what = scripts.length === 0 ? "aidrian's bin folder is not put on the shell's PATH" : `${scripts.join(', ')} ${scripts.length === 1 ? 'does' : 'do'} not run`;
  notices.push(`OpenCode did not register aidrian's ${hook} hook, so ${what} in this session.`);
}

// The callback of the OpenCode tool hook `hook`, for one tool event: runs the script of every route it selects, and
// resolves. OpenCode waits for the callback before it hands the call back. The session reads happen once, before any
// spawn, under their own cap (call.mjs); each script then has its own time from its own spawn.
async function onCall(runner, hook, event) {
  try {
    // One read of info, which picks the routes and reaches the scripts, so the adapter reads the name the bridge picked.
    const info = infoRead(event?.info);
    const name = standardToolName(event?.tool, info);
    if (name === null) {
      runner.unguarded += 1;
      runner.trace('skip', { status: 'unguarded', count: runner.unguarded });
      return;
    }
    const selected = selectRoutes(runner.routes, runner.events, hook, name);
    if (selected.length === 0) return;
    const blocking = hook === BLOCKING_HOOK;
    const call = await callOf(runner, { blocking, name, event, info });
    if (call.skip) {
      for (const route of selected) runner.trace('skip', { script: route.script, status: call.skip });
      return;
    }
    await Promise.all(selected.map((route) => run(runner, route, call, blocking ? Math.max(route.timeoutMs, BLOCKING_KILL_MS) : route.timeoutMs)));
  } catch {
    // A call the bridge cannot send runs on as it would without the plugin.
  }
}

// The standard envelope of the call for `route`: a subagent's call carries its root as session_id and its own id as
// agent_id, so its records land in the root session's folder, as a subagent's do on a host that reads hooks.json.
// `tool_name` is OpenCode's own, which the adapter maps through the same leaf, reading `opencode.info`.
function payloadOf(context, route, { cwd, event, root, agent, info }) {
  // OpenCode 2.4.0's plugin context names its version under `app`: { name, version, channel }.
  const version = context.app?.version;
  const mark = typeof version === 'string' ? { version, info } : { info };
  const callId = typeof event.id === 'string' ? { tool_use_id: event.id } : {};
  return {
    hook_event_name: route.event, opencode: mark, session_id: root, ...(agent ? { agent_id: agent } : {}), cwd,
    tool_name: event.tool, tool_input: event.input, tool_response: event.result, ...callId,
  };
}

// Runs `route`'s script on the call, in the session's folder, and resolves when it closes, fails to start, or is killed
// once `ms`, counted from its spawn, ends. A start that fails, Node gone since setup included, ends this call alone.
function run(runner, route, call, ms) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runner.trace('run', { script: route.script, status });
      resolve();
    };
    let text;
    let child;
    try {
      text = JSON.stringify(payloadOf(runner.context, route, call));
      child = runner.spawn(runner.node, [route.file, ...route.args], { cwd: call.base, env: runner.env, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      done('error');
      return;
    }
    child.on('error', (error) => done(error?.code ?? 'error'));
    child.on('exit', (code, signal) => done(code ?? signal));
    child.on('close', (code, signal) => done(code ?? signal));
    timer = setTimeout(() => {
      if (settled) return;
      kill(child);
      done('timeout');
    }, ms);
    feed(child, text);
  });
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
