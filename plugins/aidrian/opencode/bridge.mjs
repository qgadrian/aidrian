// The OpenCode bridge: a server plugin that runs the plugin's hook scripts on OpenCode's hooks, as hooks.json runs them
// on a host that reads it. At setup it reads routes.generated.json, every hooks.json hook as `npm run build` writes it,
// through route-select.mjs, and registers one callback for each OpenCode hook that EVENTS (routes.mjs) maps a standard
// event to, and listens for the `session.deleted` event SessionEnd maps to. On each tool call it reads the tool's
// standard name through lib/hosts/opencode-names.mjs, the one table the adapter reads too, and runs every route of that
// event whose matcher fires on the name, in parallel, as Claude Code runs matching hooks. It sends each script the
// standard hook envelope on stdin, with OpenCode's own tool name, input, and result inside and a top-level `opencode`
// object, { version?, info }, that marks it as OpenCode's and holds the part of the tool's `info` the leaf read, so
// lib/hosts/opencode.mjs maps the payload to the name the bridge picked.
// call.mjs finds the call's folders and who made it, output.mjs turns the scripts' answers into OpenCode's, and
// session-hooks.mjs runs each session's start once and puts the plugin's text where it reaches the model. Through
// environment.mjs it finds Node, writes the trace, and prepends the plugin's bin/ to every shell's PATH, so the `aidrian`
// that reads a record is the copy whose hook wrote it, and to the PATH the start script names commands by.
//
// output.mjs spawns each script, pinned to Node resolved to an absolute file at setup, and reads its bounded answer. A
// script missing when its call checks it, or gone when it exits 1, is a script that does not start: its route stays
// registered, and it refuses a subagent's call on a blocking route, while a root's runs. `setup` never throws. Only an
// execute.before callback rejects, for a refusal (output.mjs); every other callback resolves, and a hook that cannot
// run leaves the call as it would be without the plugin. EVENTS names the events no hook can block on (routes.mjs);
// tests reach the blocking, stop, prompt, and compaction paths through the `events` seam. Every callback that runs
// routes runs the session's start first (session-hooks.mjs started); the shell's callback, an execute.after registered
// only to deliver a kept PreToolUse context, and a session's end run none.
//
// A tool call's hook context reaches the model at the end of that call's result, once it completed: a PreToolUse
// context is kept from execute.before, under the calling session's id and the event's `id`, in a map cleared whole at
// CONTEXTS_MAX, and taken out by that call's execute.after whatever its status; the PostToolUse context follows it, once
// every after-route read the result as it came (afterCallback). So a routed before-hook registers the after-hook too.
//
// The stop path keeps `stop_hook_active` for each session: true once a Stop route sent that session back with a
// `session.synthetic` message the session admitted, and dropped at the session's next idle, which reads it, and on its
// `session.deleted` event, which also drops its start lines, and which the bridge listens for once it routes a start
// or SessionEnd, or registered the idle hook. That event runs SessionEnd for a root session alone, known as one by the
// roots the bridge kept, in its last known folder, before the root's state is dropped; a child's end, a session whose
// root-ness the bridge cannot tell, and an archived session run none (call.mjs endCall). This state is one setup's:
// OpenCode 2.4.1 runs setup once for each Location, and again when it loads the plugin anew.
//
// With AIDRIAN_OPENCODE_TRACE naming an absolute file, it appends one JSON line a step, { at, step, script?, status?,
// count? }: `setup` once, `off` once at setup when it found no Node, `unregistered` for a hook OpenCode refused and for a
// route whose script is not on disk, `run` for each script it ran or found `missing`, `skip` for a call it sent
// nothing for, a start's included, `refuse` for a call it refused, and `send-back` for a session it sent back. A call
// whose tool name the leaf cannot read, such as an MCP tool's with no `info`, runs nothing and is a `skip` with status
// `unguarded`, whose `count` is how many such calls this setup has met. Each value is a script's file name, a word, or a number;
// no command, path, payload, or output is ever written there. What the session should be told, that no hook runs, that
// one did not register, or that a route file or script is missing, is kept in `notices`, which the context hook gives
// the model.
//
// It imports node: built-ins, its own folder, the leaf and lib/deadline.mjs, which import nothing, so it loads in
// OpenCode's Bun and under `node --test` alike.

import { spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HELD_BUDGET_MS } from '../lib/deadline.mjs';
import { infoRead, standardToolName } from '../lib/hosts/opencode-names.mjs';
import { callOf, endCall, forgetSession, lastAssistantText, markOf, sessionCall, skipped } from './call.mjs';
import { absolute, addBin, nodeOf, tracer } from './environment.mjs';
import { appendContext, BLOCKING_HOOK, isFile, run, settle, transform } from './output.mjs';
import { readRoutes, selectRoutes } from './route-select.mjs';
import { DELETED_EVENT, EVENTS } from './routes.mjs';
import { addChecklist, addPromptPart, compactionHook, contextHook, promptFields, sessionRoutes, started } from './session-hooks.mjs';

// The OpenCode session hook that runs before a session goes idle, where a Stop route can send it back.
const IDLE_HOOK = 'experimental.idle';
// The OpenCode tool hook that runs once a call ended, completed or not.
const AFTER_HOOK = 'execute.after';
// The OpenCode hooks a call of a tool runs; every other hook of EVENTS is a session hook.
const TOOL_HOOKS = new Set([BLOCKING_HOOK, AFTER_HOOK]);
// How many calls' PreToolUse contexts the bridge keeps at most before it forgets them all, as the roots map does.
export const CONTEXTS_MAX = 256;
// The session hooks the plugin's text reaches the model on, registered after the others (registerAll).
export const SESSION_HOOKS = Object.freeze(['context', 'compaction']);
// A blocking route's script is killed no sooner than this long after its spawn: 1 s past the longest guard budget a
// script gives itself from its start (lib/deadline.mjs), so its own "could not finish in time" refusal comes first.
export const BLOCKING_KILL_MS = HELD_BUDGET_MS + 1000;

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

// Registers one callback for each OpenCode hook of `events` that a route runs on, its script on disk or not, the tool
// hooks on `context.tool` and the others on `context.session`, then the PATH hook, then the `context` and `compaction`
// hooks when a start route, a PreCompact route, or a notice gives them something to deliver. The `setup` trace line
// counts the hooks registered. With no Node it registers no hook of a route, and says so once, in the notices.
async function registerAll(context, seams) {
  const { spawn = nodeSpawn, env = process.env, scripts = fileURLToPath(new URL('../scripts', import.meta.url)),
    bin = fileURLToPath(new URL('../bin', import.meta.url)), node = nodeOf(env),
    routes: routesFile = fileURLToPath(new URL('./routes.generated.json', import.meta.url)), events = EVENTS, notices = [] } = seams ?? {};
  const trace = tracer(env);
  const routes = routesOf(routesFile, scripts, events, trace, notices);
  // The environment of a start script: the service's, with bin/ on its PATH as a shell has it.
  const startEnv = { ...env };
  addBin({ env: startEnv }, bin);
  const runner = {
    context, env, startEnv, node, spawn, trace, routes, events, notices, unguarded: 0,
    roots: new Map(), folders: new Map(), contexts: new Map(), stops: new Map(), starts: new Map(), listening: false,
  };
  const hooks = new Set(routes.map((route) => events[route.event]));
  // A PreToolUse context reaches the model with its call's result, so a routed before-hook registers the after-hook too.
  if (hooks.has(BLOCKING_HOOK)) hooks.add(AFTER_HOOK);
  const scriptsOf = (hook) => [...new Set(routes.filter((route) => events[route.event] === hook).map((route) => route.script))];
  let registered = 0;
  const add = async (domain, hook, callback, what) => {
    if (await register(() => domain.hook(hook, callback))) {
      registered += 1;
      if (hook === IDLE_HOOK) listen(runner);
    } else {
      lost(trace, notices, hook, what === undefined ? scriptsOf(hook) : [], what);
    }
  };
  if (!absolute(node)) {
    trace('off', { status: 'node' });
    notices.push('aidrian found no Node program (Node 22 on the PATH of the OpenCode service, or AIDRIAN_NODE as an absolute path), so no aidrian hook runs in this session.');
  } else {
    if (hooks.has('context') || hooks.has(DELETED_EVENT)) listen(runner);
    for (const hook of [...hooks].filter((each) => !SESSION_HOOKS.includes(each) && each !== DELETED_EVENT)) {
      const only = hook === AFTER_HOOK && scriptsOf(hook).length === 0 ? "the context aidrian's hooks give before a tool call does not reach the model" : undefined;
      await add(TOOL_HOOKS.has(hook) ? context.tool : context.session, hook, callbackOf(runner, hook), only);
    }
  }
  if (!await register(() => context.shell.hook('create.before', (event) => addBin(event, bin)))) lost(trace, notices, 'create.before', [], "aidrian's bin folder is not put on the shell's PATH");
  if (notices.length > 0 || hooks.has('context')) await add(context.session, 'context', contextHook(runner), "aidrian's start lines and these notices do not reach the model");
  if (notices.length > 0 || hooks.has('context') || hooks.has('compaction')) {
    const checklist = absolute(node) && hooks.has('compaction') ? sessionRoutes(runner, 'compaction', 'PreCompact', { apply: addChecklist }) : null;
    await add(context.session, 'compaction', compactionHook(runner, checklist), "aidrian's start lines and compaction checklist do not reach the compaction request");
  }
  trace('setup', { status: registered });
}

// The callback of the OpenCode hook `hook` other than `context` and `compaction`: the idle hook's Stop routes, the
// prompt hook's UserPromptSubmit routes, and any other hook's tool routes.
function callbackOf(runner, hook) {
  if (hook === IDLE_HOOK) return transform(hook, idleSteps(runner, hook));
  if (hook === 'prompt') return sessionRoutes(runner, hook, 'UserPromptSubmit', { fields: promptFields, apply: addPromptPart });
  if (hook === AFTER_HOOK) return afterCallback(runner, hook);
  return transform(hook, toolSteps(runner, hook));
}

// The execute.after callback. First it takes the call's kept PreToolUse context out of the map, whatever the call's
// status and whether or not a route runs on it, then it runs the call's PostToolUse routes, each on the result as it
// came, and only then, on a completed call, appends the kept context and the routes' merged context, in that order, to
// the result (output.mjs appendContext). An errored call's result is left as it was. It never rejects.
function afterCallback(runner, hook) {
  const given = new WeakMap();
  const routed = runner.routes.some((route) => runner.events[route.event] === hook) ? transform(hook, toolSteps(runner, hook, given)) : null;
  return settle(async (event) => {
    const kept = takeContext(runner, event);
    await routed?.(event);
    if (event?.status !== 'completed') return;
    appendContext(event, [kept, given.get(event)]);
  });
}

// The key of a call's kept context: the calling session's id and the event's `id`, or null when either is no string.
const contextKey = (event) => (typeof event?.sessionID === 'string' && typeof event?.id === 'string' ? JSON.stringify([event.sessionID, event.id]) : null);

// Keeps the PreToolUse context `text` of the call `event` until its execute.after, in a map cleared whole once it holds
// CONTEXTS_MAX calls, so a call whose after event never comes costs a bounded amount.
function keepContext(runner, event, text) {
  const key = contextKey(event);
  if (key === null || typeof text !== 'string' || text === '') return;
  if (runner.contexts.size >= CONTEXTS_MAX && !runner.contexts.has(key)) runner.contexts.clear();
  runner.contexts.set(key, text);
}

// The kept PreToolUse context of the call `event`, deleted from the map, or null.
function takeContext(runner, event) {
  const key = contextKey(event);
  if (key === null) return null;
  const text = runner.contexts.get(key) ?? null;
  runner.contexts.delete(key);
  return text;
}

// The routes of `file` whose event `events` names, each with its script's absolute `file`. A route file that cannot be
// read is a `skip` with status `routes`, and a route whose script is not on disk an `unregistered` line with status
// `missing`; each keeps a notice. A missing script's route stays, and each call checks for the script again
// (output.mjs run), so a script restored after setup runs without a restart; until then its call meets the script's
// absence as a script that does not start: a blocking route refuses a subagent's call, and a record-only one records
// nothing.
function routesOf(file, scripts, events, trace, notices) {
  const read = readRoutes(file);
  if (read === null) {
    trace('skip', { status: 'routes' });
    notices.push("aidrian could not read its route list, routes.generated.json, so no aidrian hook runs in this session.");
  }
  const routes = (read ?? []).filter((route) => Object.hasOwn(events, route.event)).map((route) => ({ ...route, file: path.join(scripts, route.script) }));
  const missing = [...new Set(routes.filter((route) => !isFile(route.file)).map((route) => route.script))];
  for (const script of missing) trace('unregistered', { script, status: 'missing' });
  if (missing.length > 0) notices.push(`aidrian's hook scripts not on disk at setup run nothing until restored, as each call checks again, and a script missing when its call checks it, or gone when it exits 1, refuses a subagent's call on a blocking route: ${missing.join(', ')}.`);
  return routes;
}

// Traces and keeps a notice for the OpenCode hook `hook` that did not register, with the `scripts` it would have run,
// and `what` is lost when it says more than that they do not run.
function lost(trace, notices, hook, scripts, what) {
  if (scripts.length === 0) trace('unregistered', { status: hook });
  for (const script of scripts) trace('unregistered', { script, status: hook });
  const said = what ?? `${scripts.join(', ')} ${scripts.length === 1 ? 'does' : 'do'} not run`;
  notices.push(`OpenCode did not register aidrian's ${hook} hook, so ${said} in this session.`);
}

// The steps (output.mjs transform) of the OpenCode tool hook `hook`, for one tool event: the session's start, the
// routes it selects for the leaf's name, the call they are sent, read once before any spawn under its own cap
// (call.mjs), and each script under its own time from its own spawn. On execute.before it first drops any context kept
// under the call's key, then a PreToolUse context of a call no hook refused is kept for that call's execute.after
// (keepContext); a PostToolUse context goes into `given`, keyed by the event, for afterCallback to append once every
// route ran. Neither blocks, and neither changes the call before then.
function toolSteps(runner, hook, given) {
  const blocking = hook === BLOCKING_HOOK;
  return {
    async select(event) {
      // A context kept for an earlier call of the same key, whose execute.after never came, never reaches this one.
      if (blocking) takeContext(runner, event);
      await started(runner, event?.sessionID);
      // One read of info, which picks the routes and reaches the scripts, so the adapter reads the name the bridge picked.
      const info = infoRead(event?.info);
      const name = standardToolName(event?.tool, info);
      if (name === null) {
        runner.unguarded += 1;
        runner.trace('skip', { status: 'unguarded', count: runner.unguarded });
        return null;
      }
      return { routes: selectRoutes(runner.routes, runner.events, hook, name), name, info };
    },
    async call(event, { routes, name, info }) {
      const call = await callOf(runner, { blocking, name, event, info });
      if (call.skip) return skipped(runner, routes, call);
      return { ...call, payload: (route) => toolPayload(runner.context, route, call) };
    },
    run: (route, call) => run(runner, route, call, blocking ? Math.max(route.timeoutMs, BLOCKING_KILL_MS) : route.timeoutMs),
    apply(event, verdict) {
      if (blocking) keepContext(runner, event, verdict.context);
      else if (typeof verdict.context === 'string') given?.set(event, verdict.context);
    },
    trace: runner.trace,
  };
}

// The steps of the idle hook `hook`, for one session about to go idle: the session's start, its Stop routes, sent the
// root session's own folder, whether the bridge sent this session back since its last idle, which this idle reads and
// drops, and the session's last assistant message, from one capped read. A child session's idle runs no Stop route, nor
// does one whose session read failed, which reads as a child's, nor one whose folder is not on disk. A Stop route's
// block sends the session back with its reason, and only a send-back the session admitted marks it.
function idleSteps(runner, hook) {
  return {
    async select(event) {
      await started(runner, event?.sessionID);
      return { routes: runner.routes.filter((route) => route.event === 'Stop' && runner.events[route.event] === hook) };
    },
    async call(event, { routes }) {
      const sessionID = event?.sessionID;
      const active = typeof sessionID === 'string' && runner.stops.delete(sessionID);
      const [who, message] = await Promise.all([sessionCall(runner, sessionID), lastAssistantText(runner.context, sessionID)]);
      let skip = who.skip ?? null;
      if (skip === 'read' || (!skip && who.agent !== null)) skip = 'subagent';
      else if (!skip && who.rootDir === null) skip = 'cwd';
      if (skip) return skipped(runner, routes, { skip });
      const background = Array.isArray(event?.background) ? event.background : [];
      const call = { base: who.rootDir, cwd: who.rootDir, root: who.root, agent: null };
      return { ...call, payload: (route) => stopPayload(runner.context, route, call, { active, message, background }) };
    },
    run: (route, call) => run(runner, route, call, route.timeoutMs),
    async apply(event, verdict) {
      if (!verdict.block) return;
      await runner.context.session.synthetic({ sessionID: event.sessionID, text: verdict.reason });
      runner.stops.set(event.sessionID, true);
      runner.trace('send-back', { status: 'stop' });
    },
    trace: runner.trace,
  };
}

// On a session's `session.deleted` event, runs its SessionEnd routes when it is a root (endSteps), then drops its
// `stop_hook_active`, its start lines, and its kept walk and folder, for as long as OpenCode's event stream
// runs, listening once a setup. Events are read one at a time, so a root's end has run before the next event is read.
// Only `session.deleted` runs anything: an archived session is not ended, and runs no hook. A stream that fails ends
// the listening and nothing else.
function listen(runner) {
  if (runner.listening) return;
  runner.listening = true;
  const end = transform(DELETED_EVENT, endSteps(runner));
  const drop = settle(async (event) => {
    if (event?.type !== DELETED_EVENT) return;
    const sessionID = event.data?.sessionID;
    await end(event);
    runner.stops.delete(sessionID);
    runner.starts.delete(sessionID);
    forgetSession(runner, sessionID);
  });
  (async () => {
    for await (const event of runner.context.event.subscribe({ types: [DELETED_EVENT] })) await drop(event);
  })().catch(() => {});
}

// The steps of a session's end, on its `session.deleted` event: the SessionEnd routes of `events`, sent the deleted
// session's id and its last known folder, for a root alone, by what the bridge kept of it (call.mjs endCall). The
// session may no longer be readable, so no start runs and no session is read. Its payload carries no `reason`, since
// the event gives none, and no `transcript_path`.
function endSteps(runner) {
  return {
    select: () => ({ routes: runner.routes.filter((route) => route.event === 'SessionEnd' && runner.events[route.event] === DELETED_EVENT) }),
    call(event, { routes }) {
      const call = endCall(runner, event?.data?.sessionID);
      if (call.skip) return skipped(runner, routes, call);
      const mark = markOf(runner.context, {});
      return { ...call, payload: (route) => ({ hook_event_name: route.event, opencode: mark, session_id: call.root, cwd: call.cwd }) };
    },
    run: (route, call) => run(runner, route, call, route.timeoutMs),
    trace: runner.trace,
  };
}

// The standard envelope of the call for `route`: a subagent's call carries its root as session_id and its own id as
// agent_id, so its records land in the root session's folder, as a subagent's do on a host that reads hooks.json.
// `tool_name` is OpenCode's own, which the adapter maps through the same leaf, reading `opencode.info`.
function toolPayload(context, route, { cwd, event, root, agent, info }) {
  const callId = typeof event.id === 'string' ? { tool_use_id: event.id } : {};
  return {
    hook_event_name: route.event, opencode: markOf(context, { info }), session_id: root, ...(agent ? { agent_id: agent } : {}), cwd,
    tool_name: event.tool, tool_input: event.input, tool_response: event.result, ...callId,
  };
}

// The standard envelope of a root session's stop: `stop_hook_active` the bridge's own state, the last assistant
// message when the read gave one, and the idle hook's `background` under the mark, as OpenCode gives it, for the
// adapter to map to `background_tasks`.
function stopPayload(context, route, { cwd, root }, { active, message, background }) {
  return {
    hook_event_name: route.event, opencode: markOf(context, { background }), session_id: root, cwd, stop_hook_active: active,
    ...(message === null ? {} : { last_assistant_message: message }),
  };
}
