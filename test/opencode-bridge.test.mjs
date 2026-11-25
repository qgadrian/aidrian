// The OpenCode bridge (plugins/aidrian/opencode/): on a fake OpenCode context and a fake spawn, what each tool event
// sends a hook script, how the spawn is pinned, and that no failure reaches OpenCode; then, with the real spawn and this
// Node, a completed `gh pr create` filed in the session ledger, and a call in a removed folder that leaves spawning on;
// through the `events` seam, a blocking (execute.before) route that skips no call the call's input could make it skip,
// with hook-bash.mjs run in this process on what the bridge sent;
// that the routes it picks from the generated list by the leaf's standard name are the ones hooks.json fires on the
// name the adapter reads; and that docs/providers/opencode.md and the README say what runs on OpenCode and that no
// guard holds a session there.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';
import { infoRead, RAW_NAMES, STANDARD_NAMES, standardToolName } from '../plugins/aidrian/lib/hosts/opencode-names.mjs';
import { HELD_BUDGET_MS } from '../plugins/aidrian/lib/deadline.mjs';
import { sectionLines } from '../plugins/aidrian/lib/markdown-sections.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { canBlock, OVERFLOW_REASON, REWRITE_CONFLICT } from '../plugins/aidrian/lib/hook-result.mjs';
import { ANNOUNCE_LEAD } from '../plugins/aidrian/lib/stop-announce.mjs';
import { snapshotPath } from '../plugins/aidrian/lib/gate-snapshot.mjs';
import { BLOCKING_KILL_MS, CONTEXTS_MAX, setup } from '../plugins/aidrian/opencode/bridge.mjs';
import { folderOf, lastAssistantText, READ_MS } from '../plugins/aidrian/opencode/call.mjs';
import { nodeOf } from '../plugins/aidrian/opencode/environment.mjs';
import { CAPTURE_BYTES, capture, CODEMODE_REFUSAL, settle as resolving, SPAWN_REFUSAL, transform } from '../plugins/aidrian/opencode/output.mjs';
import { selectRoutes } from '../plugins/aidrian/opencode/route-select.mjs';
import { EVENTS, HOOKS as OPENCODE_HOOKS } from '../plugins/aidrian/opencode/routes.mjs';
import server from '../plugins/aidrian/opencode/server.mjs';

import { hookCall } from './hook-call.mjs';


const REPO = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(REPO, 'plugins/aidrian');
const HOOK = path.join(PLUGIN, 'scripts/hook-bash-post.mjs');
const BIN = path.join(PLUGIN, 'bin');
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-bridge-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const PROJECT_DIR = path.join(ROOT, 'work');
const SESSION_DIR = path.join(ROOT, 'session-folder');
const OWN_DIR = path.join(ROOT, 'plugin-folder');
for (const dir of [PROJECT_DIR, SESSION_DIR, OWN_DIR]) mkdirSync(dir, { recursive: true });

const ENV = Object.freeze({ PATH: '/usr/bin:/bin', HOME: ROOT });
const GENERATED = JSON.parse(readFileSync(path.join(PLUGIN, 'opencode/routes.generated.json'), 'utf8'));
const HOOKS = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks;

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A child process the fake spawn returns: `behave(child, call)` runs once the payload is written, by default a close with 0.
const closes = (code = 0) => (child) => queueMicrotask(() => child.emit('close', code, null));
// Has `child` write a hook's { status, stdout, stderr } and close with its status, as a script's process does.
const answers = (child, { status, stdout = '', stderr = '' }) => queueMicrotask(() => {
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', status, null);
});
// A child that answers `answer` once its payload is written.
const writes = (answer) => (child) => answers(child, answer);

// A fake spawn that records each call { program, args, options, stdin, killed, child } and returns a child, with stdout
// and stderr emitters, that `behave` drives.
function fakeSpawn(behave = closes()) {
  const calls = [];
  const spawn = (program, args, options) => {
    const call = { program, args, options, stdin: '', killed: [] };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: (text) => { call.stdin += text; behave(child, call); } });
    child.kill = (signal) => call.killed.push(signal);
    call.child = child;
    return child;
  };
  return { spawn, calls };
}

// What a fake session.get gives exactly as written, with no `id` added: `asGiven({})` is a read of an object that is no
// session.
const AS_GIVEN = Symbol('as given');
const asGiven = (value) => ({ [AS_GIVEN]: value });

// A fake OpenCode context: `sessions` maps an id to what session.get gives, to an Error it throws, or to a function
// whose result it gives on each read (an id it does not hold reads as a root session in SESSION_DIR). A session object
// with no `id` of its own is given with the id asked for, as OpenCode 2.4.1's Session.Info always carries one;
// `asGiven(value)` gives value as it is. `app` is 2.4.0's { name, version, channel }; `reads` lists the ids it was
// asked for, and `hooks` each registration by its name.
function fakeContext({ sessions = {}, app, location = { directory: OWN_DIR }, toolHook, shellHook, sessionHook, messages = {}, synthetic, subscribe } = {}) {
  const hooks = {};
  const reads = [];
  const synthetics = [];
  const keep = (name, callback) => { hooks[name] = callback; };
  return {
    ...(app === undefined ? {} : { app }),
    location,
    tool: { hook: toolHook ?? keep },
    shell: { hook: shellHook ?? keep },
    event: { subscribe: subscribe ?? (() => ({ async *[Symbol.asyncIterator]() {} })) },
    session: {
      // `sessionHook` is asked first for each session hook, and what it throws or rejects with refuses that one.
      hook: async (name, callback) => { await sessionHook?.(name); keep(name, callback); },
      // `messages` maps an id to what session.context gives, an Error it throws, or a function whose result it gives.
      context: async ({ sessionID }) => {
        const entry = messages[sessionID];
        const value = typeof entry === 'function' ? await entry() : entry;
        if (value instanceof Error) throw value;
        return value ?? [];
      },
      synthetic: synthetic ?? (async (input) => { synthetics.push(input); return { id: `syn_${synthetics.length}` }; }),
      get: async ({ sessionID }) => {
        reads.push(sessionID);
        const entry = sessions[sessionID];
        const session = typeof entry === 'function' ? await entry() : entry;
        if (session instanceof Error) throw session;
        if (!Object.hasOwn(sessions, sessionID)) return { id: sessionID, location: { directory: SESSION_DIR } };
        if (typeof session === 'object' && session !== null && Object.hasOwn(session, AS_GIVEN)) return session[AS_GIVEN];
        const plain = typeof session === 'object' && session !== null && !Array.isArray(session) && !Object.hasOwn(session, 'id');
        return plain ? { id: sessionID, ...session } : session;
      },
    },
    hooks,
    reads,
    synthetics,
  };
}

// The execute.after event of a shell call, as @opencode/plugin@2.4.0 types it.
const shellEvent = (fields = {}) => ({
  tool: 'shell',
  sessionID: 'ses_root',
  id: 'call_1',
  input: { command: 'gh pr create --draft', workdir: PROJECT_DIR },
  status: 'completed',
  result: { output: { output: 'https://github.com/acme/widgets/pull/12\n', exitCode: 0 }, content: [], metadata: { status: 'completed' } },
  ...fields,
});

// A route list written to `name` under ROOT, for the `routes` seam: the routes as JSON, or `text` as it is.
const routesFile = (name, routes) => {
  const file = path.join(ROOT, name);
  writeFileSync(file, typeof routes === 'string' ? routes : JSON.stringify(routes));
  return file;
};
// A scripts folder holding `names`, empty files, for routes that name scripts of their own.
const scriptsFolder = (name, names) => {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  for (const each of names) writeFileSync(path.join(dir, each), '');
  return dir;
};
const bashRoute = (script, fields = {}) => ({ event: 'PostToolUse', matcher: '^(?:Bash)$', script, args: [], timeoutMs: 5000, ...fields });

// A blocking route, as a PreToolUse route on execute.before would be: EVENTS names none in this version, so the tests set
// the bridge up with the `events` seam.
const HOOK_BASH = path.join(PLUGIN, 'scripts/hook-bash.mjs');
const BLOCKING = Object.freeze({ PreToolUse: 'execute.before' });
const preRoute = (fields = {}) => ({ event: 'PreToolUse', matcher: '^(?:Bash)$', script: 'hook-bash.mjs', args: [], timeoutMs: 5000, ...fields });
const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const MERGE = `gh pr merge 7 --squash --match-head-commit ${SHA}`;
// The execute.before event of a shell call: no status and no result, since the call has not run.
const beforeEvent = (fields = {}) => ({ tool: 'shell', sessionID: 'ses_main', id: 'call_b', input: { command: MERGE }, ...fields });

// The tool events of EVENTS alone, which the tests of the tool routes set the bridge up with, so no session start runs
// before their calls; the start's own tests use EVENTS.
const AFTER_ONLY = Object.freeze(Object.fromEntries(Object.entries(EVENTS).filter(([, hook]) => hook.startsWith('execute.'))));

// The bridge set up on a fake context and spawn, with the tool events alone unless `events` says otherwise: `fire(event)`
// runs its execute.after callback.
async function bridge({ context = fakeContext(), spawn = fakeSpawn(), env = ENV, events = AFTER_ONLY, ...seams } = {}) {
  assert.equal(await setup(context, { spawn: spawn.spawn, env, node: '/opt/node22/bin/node', events, ...seams }), undefined);
  const fire = (event) => context.hooks['execute.after'](event);
  return { context, calls: spawn.calls, fire };
}

const sent = (call) => JSON.parse(call.stdin);
const APP = Object.freeze({ name: 'opencode', version: '2.4.0', channel: 'latest' });
const ENOENT = () => Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
const traceLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

test('EVENTS is every event of HOOKS no hook can block on, by hook-result`s reading, frozen: no guard runs on OpenCode yet', () => {
  assert.deepEqual(EVENTS, { SessionStart: 'context', SubagentStart: 'context', PostToolUse: 'execute.after', SessionEnd: 'session.deleted' });
  assert.deepEqual(EVENTS, Object.fromEntries(Object.entries(OPENCODE_HOOKS).filter(([event]) => !canBlock(event))), 'hook-result is the one source');
  for (const event of ['PreToolUse', 'UserPromptSubmit', 'PreCompact', 'Stop']) {
    assert.ok(Object.hasOwn(OPENCODE_HOOKS, event) && !Object.hasOwn(EVENTS, event), `${event} has a hook and stays unrouted`);
  }
  assert.ok(Object.isFrozen(EVENTS) && Object.isFrozen(OPENCODE_HOOKS));
  assert.deepEqual(Object.keys(OPENCODE_HOOKS).filter((event) => !Object.hasOwn(HOOKS, event)), [], 'each event of HOOKS is a hooks.json event');
});

test('a completed shell call runs hook-bash-post.mjs alone of the generated routes', async () => {
  assert.deepEqual(selectRoutes(GENERATED, EVENTS, 'execute.after', 'Bash').map((route) => route.script), ['hook-bash-post.mjs']);
  const { context, calls, fire } = await bridge();
  assert.deepEqual(Object.keys(context.hooks).sort(), ['create.before', 'execute.after']);
  await fire(shellEvent());
  assert.deepEqual(calls.map((call) => call.args), [[HOOK]]);
});

test('selectRoutes takes the routes of the hook`s events whose matcher fires on the name, in order, and none for a null name', () => {
  const routes = [
    { event: 'PostToolUse', matcher: '*', script: 'all.mjs' },
    { event: 'PostToolUse', matcher: '^(?:Bash|Edit)$', script: 'bash.mjs' },
    { event: 'PostToolUse', matcher: '^(?:Bas)$', script: 'prefix.mjs' },
    { event: 'PostToolUse', matcher: 'ash.*', script: 'pattern.mjs' },
    { event: 'PostToolUse', matcher: null, script: 'none.mjs' },
    { event: 'PostToolUse', matcher: '(', script: 'broken.mjs' },
    { event: 'PreToolUse', matcher: '*', script: 'pre.mjs' },
    { event: 'toString', matcher: '*', script: 'proto.mjs' },
  ];
  const scripts = (hook, name, events = EVENTS) => selectRoutes(routes, events, hook, name).map((route) => route.script);
  assert.deepEqual(scripts('execute.after', 'Bash'), ['all.mjs', 'bash.mjs', 'pattern.mjs'], 'a pattern matches anywhere in the name');
  assert.deepEqual(scripts('execute.after', 'bash'), ['all.mjs', 'pattern.mjs'], 'a list of names is case-sensitive');
  assert.deepEqual(scripts('execute.before', 'Bash'), []);
  assert.deepEqual(scripts('execute.before', 'Bash', { PreToolUse: 'execute.before' }), ['pre.mjs']);
  assert.deepEqual(scripts('execute.after', null), []);
  assert.deepEqual(selectRoutes(null, EVENTS, 'execute.after', 'Bash'), []);
});

test('a call whose tool name the leaf cannot read spawns nothing, and the trace counts it unguarded', async () => {
  const trace = path.join(ROOT, 'trace-unguarded.jsonl');
  const { calls, fire } = await bridge({ env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await fire(shellEvent({ tool: 'linear_save_issue', input: { title: 'x' } }));
  await fire(shellEvent({ tool: 'execute', input: {} }));
  await fire(shellEvent({ tool: 'opencode_models', input: {} }));
  assert.equal(calls.length, 0);
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [
    { step: 'setup', status: 1 }, ...[1, 2, 3].map((count) => ({ step: 'skip', status: 'unguarded', count })),
  ]);
});

test('two matching routes start together, each under its own timeout from its spawn: the one that outlives it is killed', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trace = path.join(ROOT, 'trace-parallel.jsonl');
  const scripts = scriptsFolder('parallel-scripts', ['hook-slow.mjs', 'hook-fast.mjs']);
  const routes = routesFile('parallel.json', [bashRoute('hook-slow.mjs', { timeoutMs: 1000, args: ['--subagent'] }), bashRoute('hook-fast.mjs', { timeoutMs: 3000 })]);
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ spawn, scripts, routes, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  let resolved = false;
  const running = fire(shellEvent()).then(() => { resolved = true; });
  while (spawn.calls.length < 2) await settle();
  assert.deepEqual(spawn.calls.map((call) => call.args), [[path.join(scripts, 'hook-slow.mjs'), '--subagent'], [path.join(scripts, 'hook-fast.mjs')]], 'both started, the flags as given');
  assert.deepEqual(spawn.calls.map((call) => sent(call).hook_event_name), ['PostToolUse', 'PostToolUse']);
  t.mock.timers.tick(999);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [[], []]);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], []], 'the slow one killed at its own 1000 ms');
  assert.equal(resolved, false, 'the callback waits for the other');
  t.mock.timers.tick(1500);
  await settle();
  assert.deepEqual(spawn.calls[1].killed, []);
  spawn.calls[1].child.emit('close', 0, null);
  await running;
  assert.deepEqual(traceLines(trace).map(({ step, script, status }) => [step, script, status]), [
    ['setup', undefined, 1], ['run', 'hook-slow.mjs', 'timeout'], ['run', 'hook-fast.mjs', 0],
  ]);
});

test('the session reads that outlast a route`s timeout still spawn it, and each script then has its own from its spawn', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scripts = scriptsFolder('deadline-scripts', ['hook-one.mjs', 'hook-three.mjs']);
  const routes = routesFile('deadline.json', [bashRoute('hook-one.mjs', { timeoutMs: 1000 }), bashRoute('hook-three.mjs', { timeoutMs: 3000 })]);
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({}), 1500));
  const context = fakeContext({ sessions: { ses_slow: slow } });
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ context, spawn, scripts, routes });
  const running = fire(shellEvent({ sessionID: 'ses_slow' }));
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(1500);
  while (spawn.calls.length < 2) await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [[], []], 'reads past the shorter timeout still spawn both, and do not count against it');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], []]);
  t.mock.timers.tick(2000);
  await running;
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], ['SIGKILL']]);
});

test('a route list that is missing, no JSON, or no list registers no tool hook, keeps the PATH hook and the notices` hooks, and is traced', async () => {
  const cases = { missing: path.join(ROOT, 'no-routes.json'), garbage: routesFile('garbage.json', '{ not json'), object: routesFile('object.json', { PostToolUse: [] }) };
  for (const [name, routes] of Object.entries(cases)) {
    const trace = path.join(ROOT, `trace-routes-${name}.jsonl`);
    const context = fakeContext();
    assert.equal(await setup(context, { spawn: fakeSpawn().spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace }, routes }), undefined, name);
    assert.deepEqual(Object.keys(context.hooks), ['create.before', 'context', 'compaction'], name);
    assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['skip', 'routes'], ['setup', 2]], name);
  }
  const notices = [];
  await setup(fakeContext(), { spawn: fakeSpawn().spawn, env: ENV, routes: cases.garbage, notices });
  assert.deepEqual(notices, ['aidrian could not read its route list, routes.generated.json, so no aidrian hook runs in this session.']);
});

test('a generated route the bridge cannot spawn as it is, such as one whose flag is no literal --flag, is left out', async () => {
  const scripts = scriptsFolder('odd-scripts', ['hook-ok.mjs']);
  const odd = [
    bashRoute('hook-ok.mjs', { args: ['; rm -rf /'] }), bashRoute('hook-ok.mjs', { args: '--x' }), bashRoute('../hook-ok.mjs'),
    bashRoute('hook-ok.mjs', { timeoutMs: 0 }), bashRoute('hook-ok.mjs', { timeoutMs: 1.5 }), bashRoute('hook-ok.mjs', { matcher: 7 }), null, 'hook-ok.mjs',
  ];
  const { context } = await bridge({ scripts, routes: routesFile('odd.json', odd) });
  assert.deepEqual(Object.keys(context.hooks), ['create.before']);
  const kept = await bridge({ scripts, routes: routesFile('odd-kept.json', [...odd, bashRoute('hook-ok.mjs', { args: ['--subagent'] })]) });
  await kept.fire(shellEvent());
  assert.deepEqual(kept.calls.map((call) => call.args), [[path.join(scripts, 'hook-ok.mjs'), '--subagent']], 'the one usable route alone runs');
});

test('a completed shell call spawns node once with the hook`s absolute path and the standard envelope on stdin', async () => {
  const { calls, fire } = await bridge({ context: fakeContext({ app: APP }) });
  const event = shellEvent();
  assert.equal(await fire(event), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, '/opt/node22/bin/node');
  assert.deepEqual(calls[0].args, [HOOK]);
  assert.deepEqual(sent(calls[0]), {
    hook_event_name: 'PostToolUse', opencode: { version: '2.4.0', info: {} }, session_id: 'ses_root', cwd: PROJECT_DIR,
    tool_name: 'shell', tool_input: event.input, tool_response: event.result, tool_use_id: 'call_1',
  });
});

test('a call of another tool, an errored or stopped call, and a call with no string command spawn nothing', async () => {
  const { calls, fire } = await bridge();
  await fire(shellEvent({ tool: 'execute' }));
  await fire(shellEvent({ tool: 'read' }));
  await fire(shellEvent({ status: 'error' }));
  await fire(shellEvent({ status: 'running' }));
  await fire(shellEvent({ input: { command: ['gh', 'pr', 'create'], workdir: PROJECT_DIR } }));
  await fire(shellEvent({ input: null }));
  await fire(shellEvent({ sessionID: 42 }));
  await fire(shellEvent({ sessionID: undefined }));
  await fire(null);
  assert.equal(calls.length, 0);
});

test('the spawn is pinned: one argument, cwd env stdio and no shell, env as given, the command on stdin alone', async () => {
  const nasty = `it's "a" $HOME; rm -rf /tmp/x\n$(whoami) \`id\``;
  const dir = path.join(ROOT, `q'u "o" $t;e\nd`);
  mkdirSync(dir, { recursive: true });
  const env = { ...ENV, AIDRIAN_NODE: '/ignored/by/the/seam' };
  const given = { ...env };
  const { calls, fire } = await bridge({ env });
  await fire(shellEvent({ input: { command: `gh pr create --title ${nasty}`, workdir: dir }, result: { output: { output: nasty, exitCode: 0 } } }));
  const [call] = calls;
  assert.equal(call.program, '/opt/node22/bin/node');
  assert.deepEqual(call.args, [HOOK]);
  assert.deepEqual(Object.keys(call.options).sort(), ['cwd', 'env', 'stdio']);
  assert.equal(call.options.cwd, SESSION_DIR, 'spawned in the session`s folder');
  assert.equal(sent(call).cwd, dir, 'the payload names the folder the call ran in');
  assert.equal(call.options.env, env);
  assert.deepEqual(call.options.env, given, 'no key added to the environment');
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.ok(call.stdin.includes(JSON.stringify(nasty).slice(1, -1)));
  assert.equal(sent(call).tool_input.command, `gh pr create --title ${nasty}`);
  for (const value of [...call.args, ...Object.values(call.options.env)]) assert.ok(!value.includes('rm -rf') && !value.includes('whoami'), value);
});

// A folder holding an executable `node`, and a folder holding one that is not executable.
const nodeFolder = (name, mode = 0o755) => {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n');
  chmodSync(path.join(dir, 'node'), mode);
  return dir;
};

test('the node program is resolved at setup to an absolute file: AIDRIAN_NODE, this process`s Node, or node on an absolute PATH entry', async () => {
  const onPath = nodeFolder('node-on-path');
  const unrunnable = nodeFolder('node-unrunnable', 0o644);
  const own = path.join(onPath, 'node');
  const bun = '/opt/opencode/bin/bun';
  const cases = [
    [{ AIDRIAN_NODE: own, PATH: '' }, bun, own],
    [{ PATH: '' }, process.execPath, process.execPath],
    [{ PATH: ['relative/bin', unrunnable, onPath].join(path.delimiter) }, bun, own],
    [{ AIDRIAN_NODE: 'bin/node', PATH: onPath }, bun, own],
    [{ AIDRIAN_NODE: path.join(ROOT, 'no-such-node'), PATH: onPath }, bun, own],
    [{ PATH: `relative/bin${path.delimiter}${unrunnable}` }, bun, null],
    [{}, bun, null],
  ];
  for (const [env, execPath, program] of cases) assert.equal(nodeOf(env, execPath), program, JSON.stringify(env));
  const spawn = fakeSpawn();
  const context = fakeContext();
  await setup(context, { spawn: spawn.spawn, env: { ...ENV, AIDRIAN_NODE: own }, events: AFTER_ONLY });
  await context.hooks['execute.after'](shellEvent());
  assert.equal(spawn.calls[0].program, own, 'the seam left out, setup resolves it');
});

test('with no Node found, setup registers no route hook, traces off once, and gives the session its one notice on every request', async () => {
  const trace = path.join(ROOT, 'trace-no-node.jsonl');
  const notices = [];
  const context = fakeContext();
  await setup(context, { spawn: fakeSpawn().spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace }, node: null, notices });
  assert.deepEqual(Object.keys(context.hooks), ['create.before', 'context', 'compaction'], 'the PATH hook and the notices` hooks still register');
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [{ step: 'off', status: 'node' }, { step: 'setup', status: 2 }]);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /no Node program .* so no aidrian hook runs in this session/u);
  for (const hook of ['context', 'compaction']) {
    const request = { sessionID: 'ses_main', system: [{ type: 'text', text: 'OpenCode' }], messages: [] };
    assert.equal(await context.hooks[hook](request), undefined);
    assert.deepEqual(request.system, [{ type: 'text', text: 'OpenCode' }, { type: 'text', text: notices[0], metadata: { aidrian: 'notice' } }], hook);
  }
  assert.deepEqual(context.reads, [], 'no start, so no session read');
});

test('the payload holds no turn_id, and its opencode mark is an object: app.version when a string, and the info the leaf read', async () => {
  const cases = [[APP, { version: '2.4.0', info: {} }], [undefined, { info: {} }], [{ ...APP, version: 24 }, { info: {} }], [{ name: 'opencode' }, { info: {} }], [null, { info: {} }]];
  for (const [app, mark] of cases) {
    const { calls, fire } = await bridge({ context: fakeContext({ app }) });
    await fire(shellEvent());
    const payload = sent(calls[0]);
    assert.deepEqual(payload.opencode, mark);
    assert.equal(Object.hasOwn(payload, 'turn_id'), false);
  }
  const topLevel = await bridge({ context: { ...fakeContext(), version: '2.4.0' } });
  await topLevel.fire(shellEvent());
  assert.deepEqual(sent(topLevel.calls[0]).opencode, { info: {} }, 'a version outside app is not 2.4.0`s field');
  const withInfo = await bridge();
  await withInfo.fire(shellEvent({ info: { namespace: 'x', secret: 'hush' } }));
  assert.deepEqual(sent(withInfo.calls[0]).opencode, { info: infoRead({ namespace: 'x' }) }, 'only what the leaf reads of info is sent');
});

test('cwd on execute.after: the script runs in the session`s folder, and the payload names the folder the call ran in, else the call records nothing', async () => {
  mkdirSync(path.join(SESSION_DIR, 'work'), { recursive: true });
  mkdirSync(path.join(SESSION_DIR, 'ab:x'), { recursive: true });
  mkdirSync(path.join(ROOT, 'home-work'), { recursive: true });
  const trace = path.join(ROOT, 'trace-cwd.jsonl');
  const cwdOf = async (event, contextOptions = {}) => {
    const { calls, fire } = await bridge({ context: fakeContext(contextOptions), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    await fire(event);
    return calls.map((call) => [call.options.cwd, sent(call).cwd]);
  };
  const at = (workdir) => shellEvent({ input: { command: 'gh pr create', workdir } });
  assert.deepEqual(await cwdOf(shellEvent()), [[SESSION_DIR, PROJECT_DIR]], 'an absolute workdir');
  assert.deepEqual(await cwdOf(shellEvent({ input: { command: 'gh pr create' } })), [[SESSION_DIR, SESSION_DIR]]);
  assert.deepEqual(await cwdOf(shellEvent(), { sessions: { ses_root: new Error('gone') } }), [[OWN_DIR, PROJECT_DIR]], 'a failed read: an absolute workdir is known, and the script runs in the plugin`s own');
  assert.deepEqual(await cwdOf(at('~/home-work'), { sessions: { ses_root: new Error('gone') } }), [[OWN_DIR, path.join(ROOT, 'home-work')]], 'a failed read: a ~ workdir is known too');
  for (const workdir of ['work', './work', 'work/', '../session-folder/work', 'ab:x/../work']) assert.deepEqual(await cwdOf(at(workdir)), [[SESSION_DIR, path.join(SESSION_DIR, 'work')]], workdir);
  assert.deepEqual(await cwdOf(at('ab:x')), [[SESSION_DIR, path.join(SESSION_DIR, 'ab:x')]], 'a local folder named like name:part is that folder');
  assert.deepEqual(await cwdOf(at('..')), [[SESSION_DIR, ROOT]], 'a relative workdir may climb out of the session`s folder');
  assert.deepEqual(await cwdOf(at(`${PROJECT_DIR}/../work`)), [[SESSION_DIR, PROJECT_DIR]], 'an absolute workdir`s dot segments are normalized');
  // ENV's HOME is ROOT.
  assert.deepEqual(await cwdOf(at('~')), [[SESSION_DIR, ROOT]]);
  assert.deepEqual(await cwdOf(at('~/home-work/')), [[SESSION_DIR, path.join(ROOT, 'home-work')]]);
  assert.deepEqual(await cwdOf(at('')), [[SESSION_DIR, SESSION_DIR]], 'an empty workdir is none');
  rmSync(trace, { force: true });
  const skipped = ['gpu:/srv/work', 42, { dir: PROJECT_DIR }, path.join(ROOT, 'never-made'), 'never-made', '~/never-made'];
  for (const workdir of skipped) assert.deepEqual(await cwdOf(at(workdir)), [], `${JSON.stringify(workdir)}: on another machine, of another type, or no folder`);
  assert.deepEqual(traceLines(trace).filter((line) => line.step === 'skip').map(({ script, status }) => [script, status]), Array(skipped.length).fill(['hook-bash-post.mjs', 'cwd']));
});

test('cwd on execute.before: a workdir that names no folder sends the call with the session`s folder, never a skip', async () => {
  const scripts = scriptsFolder('before-cwd-scripts', ['hook-pre.mjs']);
  const routes = routesFile('before-cwd.json', [preRoute({ script: 'hook-pre.mjs' })]);
  const { context, calls } = await bridge({ scripts, routes, events: BLOCKING, context: fakeContext({ sessions: { ses_main: { location: { directory: SESSION_DIR } } } }) });
  const workdirs = ['gpu:/srv/work', 42, { dir: PROJECT_DIR }, path.join(ROOT, 'never-made'), 'never-made', '~/never-made'];
  for (const workdir of workdirs) await context.hooks['execute.before'](beforeEvent({ input: { command: MERGE, workdir } }));
  assert.deepEqual(calls.map((call) => [call.options.cwd, sent(call).cwd]), Array(workdirs.length).fill([SESSION_DIR, SESSION_DIR]));
});

test('a workdir is read from a Bash call alone: an edit`s or an MCP call`s input chooses no folder, before the call or after it', async () => {
  const scripts = scriptsFolder('workdir-scripts', ['hook-any.mjs']);
  const any = (event) => ({ event, matcher: '*', script: 'hook-any.mjs', args: [], timeoutMs: 5000 });
  const routes = routesFile('workdir.json', [any('PreToolUse'), any('PostToolUse')]);
  const { context, calls } = await bridge({ scripts, routes, events: { ...BLOCKING, ...AFTER_ONLY } });
  const tools = [
    { tool: 'edit', input: { path: 'a.md', oldString: 'a', newString: 'b', workdir: PROJECT_DIR } },
    { tool: 'linear_save_issue', input: { title: 'x', workdir: PROJECT_DIR }, info: { name: 'save_issue', options: { namespace: 'linear' } } },
    { tool: 'linear_save_issue', input: { title: 'x', workdir: 'never-made' }, info: { name: 'save_issue', options: { namespace: 'linear' } } },
  ];
  for (const fields of tools) {
    for (const hook of ['execute.before', 'execute.after']) await context.hooks[hook](shellEvent(fields));
  }
  assert.deepEqual(calls.map((call) => [call.options.cwd, sent(call).cwd]), Array(tools.length * 2).fill([SESSION_DIR, SESSION_DIR]));
  await context.hooks['execute.before'](shellEvent());
  assert.equal(sent(calls.at(-1)).cwd, PROJECT_DIR, 'a shell call`s still does');
});

test('folderOf resolves a workdir by path as OpenCode`s shell does, and gives null for one that is no text or names no folder', () => {
  mkdirSync(path.join(SESSION_DIR, 'work'), { recursive: true });
  mkdirSync(path.join(SESSION_DIR, 'ab:x'), { recursive: true });
  mkdirSync(path.join(ROOT, 'home-work'), { recursive: true });
  const cases = [
    ['work', path.join(SESSION_DIR, 'work')], ['~', ROOT], ['~/home-work/', path.join(ROOT, 'home-work')], [PROJECT_DIR, PROJECT_DIR],
    [`${PROJECT_DIR}/../work`, PROJECT_DIR], ['ab:x', path.join(SESSION_DIR, 'ab:x')], ['ab:x/../work', path.join(SESSION_DIR, 'work')],
  ];
  for (const [workdir, folder] of cases) assert.equal(folderOf(workdir, SESSION_DIR, ROOT), folder, workdir);
  for (const workdir of [null, 42, ['work'], 'gpu:/srv/work', 'never-made', '~never-made']) assert.equal(folderOf(workdir, SESSION_DIR, ROOT), null, JSON.stringify(workdir));
});

test('the session`s folder is read on every call, so a session that moves is followed by the spawn and the payload alike', async () => {
  let at = SESSION_DIR;
  const context = fakeContext({ sessions: { ses_mover: () => ({ location: { directory: at } }) } });
  const { calls, fire } = await bridge({ context });
  await fire(shellEvent({ sessionID: 'ses_mover', input: { command: 'gh pr create' } }));
  at = PROJECT_DIR;
  await fire(shellEvent({ sessionID: 'ses_mover', input: { command: 'gh pr create' } }));
  assert.deepEqual(calls.map((call) => [call.options.cwd, sent(call).cwd]), [[SESSION_DIR, SESSION_DIR], [PROJECT_DIR, PROJECT_DIR]]);
  assert.deepEqual(context.reads, ['ses_mover', 'ses_mover']);
});

test('a child session`s call carries the root as session_id and itself as agent_id; a failed read sends it as a subagent`s, never the root`s', async () => {
  const sessions = { ses_grandchild: { parentID: 'ses_child' }, ses_child: { parentID: 'ses_root' }, ses_root: {} };
  const context = fakeContext({ sessions });
  const { calls, fire } = await bridge({ context });
  await fire(shellEvent({ sessionID: 'ses_grandchild' }));
  assert.deepEqual([sent(calls[0]).session_id, sent(calls[0]).agent_id], ['ses_root', 'ses_grandchild']);
  const reads = context.reads.length;
  await fire(shellEvent({ sessionID: 'ses_grandchild' }));
  assert.deepEqual(context.reads.slice(reads), ['ses_grandchild', 'ses_child', 'ses_root'], 'its parents are read again on every call');
  await fire(shellEvent({ sessionID: 'ses_root' }));
  assert.equal(Object.hasOwn(sent(calls[2]), 'agent_id'), false);

  const failing = await bridge({ context: fakeContext({ sessions: { ses_sub: { parentID: 'ses_top' }, ses_top: new Error('read failed'), ses_main: new Error('read failed'), ses_null: null, ses_text: 'ses' } }) });
  await failing.fire(shellEvent({ sessionID: 'ses_sub' }));
  assert.deepEqual([sent(failing.calls[0]).session_id, sent(failing.calls[0]).agent_id], ['ses_top', 'ses_sub'], 'the walk stops where the read failed');
  for (const id of ['ses_main', 'ses_null', 'ses_text']) {
    await failing.fire(shellEvent({ sessionID: id }));
    assert.deepEqual([sent(failing.calls.at(-1)).session_id, sent(failing.calls.at(-1)).agent_id], [id, id], `${id}: a first read that fails or gives no session sets agent_id`);
  }
  const before = failing.context.reads.length;
  await failing.fire(shellEvent({ sessionID: 'ses_null' }));
  assert.deepEqual(failing.context.reads.slice(before), ['ses_null'], 'a read that gave no object is not kept');
  assert.equal(sent(failing.calls.at(-1)).agent_id, 'ses_null');
});

// Has every read of the sessions `ids` fail.
function misread(context, ...ids) {
  const { get } = context.session;
  context.session.get = async (input) => { if (ids.includes(input.sessionID)) throw new Error('read'); return get(input); };
}

test('past 256 kept links the least recently used one goes: the oldest is lost, one followed lately and the walker`s own are kept', async () => {
  const sessions = { ses_top: {} };
  for (let n = 0; n <= 256; n += 1) sessions[`ses_kid${n}`] = { parentID: 'ses_top' };
  const context = fakeContext({ sessions });
  const { calls, fire } = await bridge({ context });
  for (let n = 0; n < 256; n += 1) await fire(shellEvent({ sessionID: `ses_kid${n}` }));
  misread(context, 'ses_kid0');
  await fire(shellEvent({ sessionID: 'ses_kid0' }));
  assert.deepEqual([sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id], ['ses_top', 'ses_kid0'], 'with 256 links kept, the first`s is still known');
  await fire(shellEvent({ sessionID: 'ses_kid256' }));
  misread(context, 'ses_kid1', 'ses_kid2', 'ses_kid256');
  for (const [sessionID, root, why] of [
    ['ses_kid1', 'ses_kid1', 'the oldest not used since is gone'], ['ses_kid0', 'ses_top', 'followed lately'], ['ses_kid2', 'ses_top', 'one link past the bound drops one'], ['ses_kid256', 'ses_top', 'the walker`s own'],
  ]) {
    await fire(shellEvent({ sessionID }));
    assert.deepEqual([sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id], [root, sessionID], why);
  }
});

// The bridge with the record-only shell route and the SessionEnd route, on ses_top, ses_mid with the parent `parent()` gives
// on each read, ses_low, a child of ses_mid, and the cycle of ses_a and ses_b; `topParent()` gives ses_top's parent. `prompt` fires the prompt hook,
// `last()` is the last call's [session_id, agent_id], and `skips()` each skip traced, [script, status].
async function middleBridge(name, parent, topParent = () => undefined) {
  const stream = eventStream();
  const at = { location: { directory: PROJECT_DIR } };
  const kids = Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`ses_kid${n}`, { parentID: 'ses_top', ...at }]));
  const sessions = { ses_top: () => ({ parentID: topParent(), ...at }), ses_mid: () => ({ parentID: parent(), ...at }), ses_low: { parentID: 'ses_mid', ...at }, ses_a: { parentID: 'ses_b', ...at }, ses_b: { parentID: 'ses_a', ...at }, ...kids };
  const context = fakeContext({ sessions, subscribe: () => stream.iterable });
  const trace = path.join(ROOT, `trace-${name}.jsonl`);
  const events = { PostToolUse: EVENTS.PostToolUse, SessionEnd: EVENTS.SessionEnd, UserPromptSubmit: 'prompt' };
  const { calls, fire } = await startBridge(name, { context, routes: [END_ROUTE, PROMPT_ROUTE], events, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const skips = () => traceLines(trace).filter((line) => line.step === 'skip').map(({ script, status }) => [script, status]);
  const call = (sessionID) => fire(shellEvent({ sessionID }));
  const remove = (sessionID) => stream.send([{ type: 'session.deleted', data: { sessionID } }]);
  const last = () => [sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id ?? null];
  const prompt = (sessionID) => context.hooks.prompt({ sessionID, messageID: 'msg_1', prompt: { text: 'x' }, delivery: 'steer' });
  return { call, calls, context, last, prompt, remove, skips };
}

test('a session answered as a root is a subagent once its own read names a parent', async () => {
  let parentID;
  const { call, last } = await middleBridge('root-then-child', () => parentID);
  await call('ses_mid');
  assert.deepEqual(last(), ['ses_mid', null]);
  parentID = 'ses_top';
  await call('ses_mid');
  assert.deepEqual(last(), ['ses_top', 'ses_mid']);
});

test('a linked child stays a child when a later read names no parent for it, its walker goes on to its root, and its delete runs nothing', { timeout: 10_000 }, async () => {
  for (const others of [0, 257]) {
    let parentID = 'ses_top';
    const { call, calls, last, remove } = await middleBridge(`kept-child-${others}`, () => parentID);
    await call('ses_mid');
    parentID = undefined;
    await call('ses_low');
    assert.deepEqual(last(), ['ses_top', 'ses_low'], 'the grandchild is the top`s');
    await call('ses_mid');
    assert.deepEqual(last(), ['ses_top', 'ses_mid']);
    // Past the 256 links the child is forgotten, and its read of no parent left no folder for its end to run in.
    for (let n = 0; n < others; n += 1) await call(`ses_kid${n}`);
    await remove('ses_mid');
    assert.deepEqual(ends(calls), [], `${others} others`);
  }
});

test('a session a grandchild`s walk reached with no parent read, whose own call reads one, is sent as a subagent`s under the root, and its delete runs nothing', { timeout: 10_000 }, async () => {
  for (const others of [0, 257]) {
    let parentID;
    const { call, calls, context, last, prompt, remove } = await middleBridge(`late-parent-${others}`, () => parentID);
    await call('ses_low');
    assert.deepEqual(last(), ['ses_mid', 'ses_low']);
    parentID = 'ses_top';
    await call('ses_mid');
    assert.deepEqual(last(), ['ses_top', 'ses_mid']);
    // The grandchild goes on to the top, on a tool call and on a session hook.
    await call('ses_low');
    assert.deepEqual(last(), ['ses_top', 'ses_low'], 'a tool call');
    await prompt('ses_low');
    assert.deepEqual(last(), ['ses_top', 'ses_low'], 'a session hook');
    const { get } = context.session;
    misread(context, 'ses_low');
    await call('ses_low');
    assert.deepEqual(last(), ['ses_top', 'ses_low'], 'a call whose read fails');
    context.session.get = get;
    // Past the 256 links the middle session is forgotten, and so is the folder kept while it read as a root.
    for (let n = 0; n < others; n += 1) await call(`ses_kid${n}`);
    await remove('ses_mid');
    assert.deepEqual(ends(calls), [], `${others} others`);
  }
});

test('a walk that fails above a learned link is sent under where the link leads, and the session hooks skip it', async () => {
  const { call, calls, context, last, prompt, skips } = await middleBridge('link-above', () => 'ses_top');
  await call('ses_low');
  misread(context, 'ses_mid');
  await call('ses_low');
  assert.deepEqual(last(), ['ses_top', 'ses_low']);
  const before = calls.length;
  await prompt('ses_low');
  assert.equal(calls.length, before);
  assert.deepEqual(skips(), [['hook-prompt.mjs', 'read']]);
  const unlearned = await middleBridge('no-link-above', () => 'ses_top');
  misread(unlearned.context, 'ses_mid');
  await unlearned.call('ses_low');
  assert.deepEqual(unlearned.last(), ['ses_mid', 'ses_low'], 'with no link above, the last id a read named');
});

test('a walk that ends at a linked session is unfinished: a subagent`s call, no session hook, and no end', { timeout: 10_000 }, async () => {
  let [parentID, topParent] = ['ses_top', undefined];
  const { call, calls, last, prompt, remove, skips } = await middleBridge('ends-at-link', () => parentID, () => topParent);
  await call('ses_mid');
  [parentID, topParent] = [undefined, 'ses_mid'];
  await call('ses_top');
  assert.deepEqual(last(), ['ses_top', 'ses_top']);
  const before = calls.length;
  await prompt('ses_top');
  assert.equal(calls.length, before);
  await remove('ses_top');
  assert.deepEqual(ends(calls), []);
  assert.deepEqual(skips(), [['hook-prompt.mjs', 'read'], ['hook-session-end.mjs', 'subagent']]);
});

test('a walk that meets the 256-link bound loses none of its own links', async () => {
  for (const links of [254, 255, 256]) {
    const { call, context, last } = await middleBridge(`links-${links}`, () => 'ses_top');
    for (let n = 0; n < links; n += 1) await call(`ses_kid${n}`);
    await call('ses_low');
    misread(context, 'ses_low', 'ses_mid', 'ses_kid0', 'ses_kid1');
    // The next call, since each call drops what is past the bound.
    await call('ses_kid1');
    assert.deepEqual(last(), [links === 256 ? 'ses_kid1' : 'ses_top', 'ses_kid1'], `${links} links: two past the bound drop two`);
    for (const sessionID of ['ses_low', 'ses_mid']) {
      await call(sessionID);
      assert.deepEqual(last(), ['ses_top', sessionID], `${links} links`);
    }
    await call('ses_kid0');
    assert.deepEqual(last(), [links === 254 ? 'ses_top' : 'ses_kid0', 'ses_kid0'], `${links} links`);
  }
});

test('a call of a child already linked, with 256 links kept, clears none: another child`s link still leads to its root', async () => {
  const { call, context, last } = await middleBridge('full-of-links', () => 'ses_top');
  for (let n = 0; n < 256; n += 1) await call(`ses_kid${n}`);
  await call('ses_kid0');
  misread(context, 'ses_kid1');
  await call('ses_kid1');
  assert.deepEqual(last(), ['ses_top', 'ses_kid1']);
  // The first child's second walk stored its link anew, so the next link drops the third child's.
  await call('ses_kid256');
  misread(context, 'ses_kid0', 'ses_kid2');
  for (const [sessionID, root] of [['ses_kid0', 'ses_top'], ['ses_kid2', 'ses_kid2']]) {
    await call(sessionID);
    assert.deepEqual(last(), [root, sessionID]);
  }
});

test('with 256 links kept, a new descendant`s walk that ends at a linked child goes to that child`s root, and the child`s delete runs nothing', { timeout: 10_000 }, async () => {
  let parentID = 'ses_top';
  const { call, calls, last, remove, skips } = await middleBridge('descendant-at-bound', () => parentID);
  await call('ses_mid');
  for (let n = 0; n < 255; n += 1) await call(`ses_kid${n}`);
  parentID = undefined;
  await call('ses_low');
  assert.deepEqual(last(), ['ses_top', 'ses_low']);
  await call('ses_low');
  assert.deepEqual(last(), ['ses_top', 'ses_low'], 'its next callback too');
  await remove('ses_mid');
  assert.deepEqual(ends(calls), []);
  assert.deepEqual(skips(), [['hook-session-end.mjs', 'subagent']], 'its link was used last, so it stays');
});

test('a two-session cycle`s links count once: with 254 links kept, its walk clears none', async () => {
  const { call, context, last } = await middleBridge('cycle-at-bound', () => 'ses_top');
  for (let n = 0; n < 254; n += 1) await call(`ses_kid${n}`);
  await call('ses_a');
  assert.deepEqual(last(), ['ses_a', 'ses_a']);
  misread(context, 'ses_kid0');
  await call('ses_kid0');
  assert.deepEqual(last(), ['ses_top', 'ses_kid0']);
});

test('a deleted middle child`s link stays: its late call and its child`s go to the top, and a replayed delete runs nothing', { timeout: 10_000 }, async () => {
  const { call, calls, context, last, remove, skips } = await middleBridge('deleted-middle', () => 'ses_top');
  await call('ses_low');
  await call('ses_mid');
  await remove('ses_mid');
  misread(context, 'ses_mid');
  for (const sessionID of ['ses_mid', 'ses_low']) {
    await call(sessionID);
    assert.deepEqual(last(), ['ses_top', sessionID]);
  }
  await remove('ses_mid');
  assert.deepEqual(ends(calls), []);
  assert.deepEqual(skips(), Array(2).fill(['hook-session-end.mjs', 'subagent']));
});

test('a session hook makes one walk, and reads the root once', async () => {
  const { context, last, prompt } = await middleBridge('one-walk', () => 'ses_top');
  await prompt('ses_low');
  assert.deepEqual(last(), ['ses_top', 'ses_low']);
  assert.deepEqual(context.reads, ['ses_low', 'ses_mid', 'ses_top']);
});

test('a failed parent read is not kept: the next call of that session reads again and finds its root', async () => {
  let failures = 1;
  const parent = () => {
    if (failures === 0) return { parentID: 'ses_top' };
    failures -= 1;
    return new Error('read failed');
  };
  const { calls, fire } = await bridge({ context: fakeContext({ sessions: { ses_sub: parent, ses_top: {} } }) });
  await fire(shellEvent({ sessionID: 'ses_sub' }));
  await fire(shellEvent({ sessionID: 'ses_sub' }));
  assert.deepEqual(calls.map((call) => [sent(call).session_id, sent(call).agent_id ?? null]), [['ses_sub', 'ses_sub'], ['ses_top', 'ses_sub']]);
});

// The ways a session read fails, each the value the fake's read gives: a throw, no object, and a read that never settles.
const MISREADS = Object.freeze({ rejects: () => new Error('read failed'), 'gives none': () => null, 'gives another session': () => ({ id: 'ses_other' }), 'comes late': () => new Promise(() => {}) });
// Runs `fire` and ends its session reads at their cap, once the first read of it started.
async function capped(t, context, fire) {
  const before = context.reads.length;
  const running = fire();
  while (context.reads.length === before) await settle();
  t.mock.timers.tick(READ_MS);
  return running;
}

test('a kept root answers only a call whose own read gave the session: one that fails, comes late, or gives none sends agent_id, and its idle runs no Stop route', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let read = () => ({ location: { directory: SESSION_DIR } });
  const context = fakeContext({ sessions: { ses_main: () => read() } });
  const { calls, fire } = await bridge({ context });
  await capped(t, context, () => fire(shellEvent({ sessionID: 'ses_main' })));
  assert.equal(Object.hasOwn(sent(calls[0]), 'agent_id'), false, 'the root`s own call, whose root is now kept');
  for (const [name, misread] of Object.entries(MISREADS)) {
    read = misread;
    await capped(t, context, () => fire(shellEvent({ sessionID: 'ses_main' })));
    assert.deepEqual([sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id], ['ses_main', 'ses_main'], name);
  }
  read = () => ({ location: { directory: SESSION_DIR } });
  await capped(t, context, () => fire(shellEvent({ sessionID: 'ses_main' })));
  assert.equal(Object.hasOwn(sent(calls.at(-1)), 'agent_id'), false, 'a read that gives the session again is the root`s own call');

  const trace = path.join(ROOT, 'trace-stop-kept.jsonl');
  let stopRead = () => ({ location: { directory: SESSION_DIR } });
  const stopContext = fakeContext({ sessions: { ses_main: () => stopRead() } });
  const stop = await stopBridge('stop-kept', { context: stopContext, spawn: fakeSpawn(), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await capped(t, stopContext, () => stop.idle('ses_main'));
  assert.equal(stop.calls.length, 1, 'the root`s idle runs its Stop route, and its root is now kept');
  for (const [name, misread] of Object.entries(MISREADS)) {
    stopRead = misread;
    await capped(t, stopContext, () => stop.idle('ses_main'));
    assert.equal(stop.calls.length, 1, `${name}: no Stop route`);
  }
  assert.deepEqual(traceLines(trace).filter((line) => line.step === 'skip').map(({ script, status }) => [script, status]), Array(4).fill(['hook-stop.mjs', 'subagent']));
});

test('a kept child`s call whose own read fails, comes late, or gives none keeps its kept root as session_id and itself as agent_id', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let read = () => ({ parentID: 'ses_top', location: { directory: SESSION_DIR } });
  const context = fakeContext({ sessions: { ses_kid: () => read(), ses_top: {} } });
  const { calls, fire } = await bridge({ context });
  await capped(t, context, () => fire(shellEvent({ sessionID: 'ses_kid' })));
  assert.deepEqual([sent(calls[0]).session_id, sent(calls[0]).agent_id], ['ses_top', 'ses_kid'], 'the child`s root is now kept');
  for (const [name, misread] of Object.entries(MISREADS)) {
    read = misread;
    await capped(t, context, () => fire(shellEvent({ sessionID: 'ses_kid' })));
    assert.deepEqual([sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id], ['ses_top', 'ses_kid'], name);
  }
  assert.deepEqual(context.reads, ['ses_kid', 'ses_top', 'ses_kid', 'ses_kid', 'ses_kid', 'ses_kid'], 'a failed read walks no parent: the kept link answers');
});

test('a read that gives no session of the id asked for, {} or another id`s, on a child`s first call or mid-walk, sends agent_id, and the next call reads again', async () => {
  const NOT_SESSIONS = Object.freeze({ 'an empty object': () => asGiven({}), 'another id`s session': () => ({ id: 'ses_other' }), 'an error object': () => asGiven({ error: 'not found' }) });
  for (const [name, misread] of Object.entries(NOT_SESSIONS)) {
    let first = misread;
    const context = fakeContext({ sessions: { ses_kid: () => first(), ses_top: {} } });
    const { calls, fire } = await bridge({ context });
    await fire(shellEvent({ sessionID: 'ses_kid' }));
    first = () => ({ parentID: 'ses_top' });
    await fire(shellEvent({ sessionID: 'ses_kid' }));
    assert.deepEqual(calls.map((call) => [sent(call).session_id, sent(call).agent_id ?? null]), [['ses_kid', 'ses_kid'], ['ses_top', 'ses_kid']], `first read, ${name}`);

    let middle = misread;
    const walk = fakeContext({ sessions: { ses_kid: { parentID: 'ses_mid' }, ses_mid: () => middle(), ses_top: {} } });
    const walked = await bridge({ context: walk });
    await walked.fire(shellEvent({ sessionID: 'ses_kid' }));
    middle = () => ({ parentID: 'ses_top' });
    await walked.fire(shellEvent({ sessionID: 'ses_kid' }));
    assert.deepEqual(walked.calls.map((call) => [sent(call).session_id, sent(call).agent_id ?? null]), [['ses_mid', 'ses_kid'], ['ses_top', 'ses_kid']], `mid-walk, ${name}`);
    assert.deepEqual(walk.reads, ['ses_kid', 'ses_mid', 'ses_kid', 'ses_mid', 'ses_top'], `mid-walk, ${name}: the next call walks again`);
  }
});

test(`session reads that never settle end at their own ${READ_MS} ms cap, and the call is sent as a subagent's from the plugin's folder`, { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trace = path.join(ROOT, 'trace-stalled.jsonl');
  const stalled = () => new Promise(() => {});
  const context = fakeContext({ sessions: { ses_child: stalled } });
  const spawn = fakeSpawn(() => {});
  const { calls, fire } = await bridge({ context, spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const event = shellEvent({ sessionID: 'ses_child', input: { command: 'gh pr create', workdir: PROJECT_DIR } });
  const before = structuredClone(event.result);
  const running = fire(event);
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(READ_MS - 1);
  await settle();
  assert.equal(calls.length, 0);
  t.mock.timers.tick(1);
  while (calls.length === 0) await settle();
  assert.deepEqual([sent(calls[0]).session_id, sent(calls[0]).agent_id, calls[0].options.cwd, sent(calls[0]).cwd], ['ses_child', 'ses_child', OWN_DIR, PROJECT_DIR], 'a late read is no skip');
  calls[0].child.emit('close', 0, null);
  await running;
  assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['setup', 1], ['run', 0]]);
  assert.deepEqual(event.result, before);
});

test(`the reads have their own ${READ_MS} ms cap, whatever the routes' timeouts, and the script its own timeout from its spawn`, { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({}), 3000));
  const context = fakeContext({ sessions: { ses_slow: slow } });
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ context, spawn });
  let resolved = false;
  const running = fire(shellEvent({ sessionID: 'ses_slow' })).then(() => { resolved = true; });
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(READ_MS);
  while (spawn.calls.length === 0) await settle();
  assert.equal(sent(spawn.calls[0]).agent_id, 'ses_slow', 'a read past the cap is a late read');
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual([resolved, spawn.calls[0].killed], [false, []], 'not killed at 4999 ms after its spawn');
  t.mock.timers.tick(1);
  await running;
  assert.deepEqual(spawn.calls[0].killed, ['SIGKILL'], 'killed at 5000 ms after its spawn');
});

test('the parent walk stops at 8 reads, on a chain longer than that and on a cycle, and sends the call as a subagent`s, on every call', async () => {
  const chain = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`ses_${n}`, { parentID: `ses_${n + 1}` }]));
  const cycle = { ses_a: { parentID: 'ses_b' }, ses_b: { parentID: 'ses_a' } };
  for (const [sessions, start, root] of [[chain, 'ses_0', 'ses_8'], [cycle, 'ses_a', 'ses_a']]) {
    const context = fakeContext({ sessions });
    const { calls, fire } = await bridge({ context });
    await fire(shellEvent({ sessionID: start }));
    assert.equal(context.reads.length, 8);
    assert.deepEqual([sent(calls[0]).session_id, sent(calls[0]).agent_id], [root, start], start);
    await fire(shellEvent({ sessionID: start }));
    assert.equal(context.reads.length, 16, `${start}: the next call walks again`);
  }
});

test('the callback resolves, and leaves the result as it was, whatever the child does', async (t) => {
  const behaviours = {
    'spawn throws': null,
    'the child emits error': (child) => queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }))),
    'stdin emits EPIPE': (child) => queueMicrotask(() => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      child.emit('close', 0, null);
    }),
    'the child exits 2': closes(2),
  };
  for (const [name, behave] of Object.entries(behaviours)) {
    const spawn = behave ? fakeSpawn(behave) : { spawn: () => { throw new Error('spawn failed'); }, calls: [] };
    const { fire } = await bridge({ spawn });
    const event = shellEvent();
    const before = structuredClone(event.result);
    const result = event.result;
    assert.equal(await fire(event), undefined, name);
    assert.equal(event.result, result, name);
    assert.deepEqual(event.result, before, name);
  }

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ spawn });
  const event = shellEvent();
  const before = structuredClone(event.result);
  let resolved = false;
  const running = fire(event).then(() => { resolved = true; });
  while (spawn.calls.length === 0) await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual([resolved, spawn.calls[0].killed], [false, []]);
  t.mock.timers.tick(1);
  await running;
  assert.deepEqual(spawn.calls[0].killed, ['SIGKILL'], 'killed at the route`s timeoutMs');
  assert.deepEqual(event.result, before);
});


test('a spawn error, an ENOENT included, ends that call alone: every later call still spawns', async () => {
  const trace = path.join(ROOT, 'trace-enoent.jsonl');
  let failures = 2;
  const spawn = fakeSpawn((child) => queueMicrotask(() => {
    if (failures-- > 0) child.emit('error', ENOENT());
    else child.emit('close', 0, null);
  }));
  const { calls, fire } = await bridge({ spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await fire(shellEvent());
  await fire(shellEvent());
  await fire(shellEvent());
  assert.equal(calls.length, 3);
  assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['setup', 1], ['run', 'ENOENT'], ['run', 'ENOENT'], ['run', 0]]);
});

test('a workdir that is gone skips a record-only call, and sends a blocking one from the session`s folder, which exists', async () => {
  const gone = path.join(ROOT, 'removed');
  mkdirSync(gone);
  const after = shellEvent({ input: { command: 'gh pr create', workdir: gone } });
  const before = beforeEvent({ input: { command: MERGE, workdir: gone } });
  rmSync(gone, { recursive: true });
  const trace = path.join(ROOT, 'trace-gone.jsonl');
  const recorded = await bridge({ env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await recorded.fire(after);
  assert.deepEqual([recorded.calls.length, traceLines(trace).map(({ step, status }) => [step, status])], [0, [['setup', 1], ['skip', 'cwd']]]);
  const scripts = scriptsFolder('gone-scripts', ['hook-pre.mjs']);
  const blocking = await bridge({ scripts, routes: routesFile('gone.json', [preRoute({ script: 'hook-pre.mjs' })]), events: BLOCKING });
  await blocking.context.hooks['execute.before'](before);
  assert.deepEqual(blocking.calls.map((call) => [call.options.cwd, sent(call).cwd]), [[SESSION_DIR, SESSION_DIR]]);
});

test('a record-only call whose session folder is gone or could not be read, with no absolute workdir, is skipped, never recorded under the plugin`s folder', async () => {
  const gone = path.join(ROOT, 'removed-session');
  mkdirSync(path.join(gone, 'work'), { recursive: true });
  rmSync(gone, { recursive: true });
  const sessions = { ses_root: { location: { directory: gone } }, ses_main: { location: { directory: gone } }, ses_unread: new Error('read failed') };
  const trace = path.join(ROOT, 'trace-session-gone.jsonl');
  const recorded = await bridge({ context: fakeContext({ sessions }), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const events = [
    shellEvent({ input: { command: 'gh pr create' } }), shellEvent({ input: { command: 'gh pr create', workdir: 'work' } }),
    shellEvent({ input: { command: 'gh pr create', workdir: '..' } }), shellEvent({ sessionID: 'ses_unread', input: { command: 'gh pr create' } }),
    shellEvent({ sessionID: 'ses_unread', input: { command: 'gh pr create', workdir: '.' } }),
  ];
  for (const event of events) await recorded.fire(event);
  assert.equal(recorded.calls.length, 0, 'nothing spawned');
  assert.deepEqual(traceLines(trace).filter((line) => line.step === 'skip').map(({ script, status }) => [script, status]), Array(events.length).fill(['hook-bash-post.mjs', 'cwd']));
  await recorded.fire(shellEvent());
  assert.deepEqual(recorded.calls.map((call) => [call.options.cwd, sent(call).cwd]), [[OWN_DIR, PROJECT_DIR]], 'an absolute workdir is known: recorded');
  const scripts = scriptsFolder('session-gone-scripts', ['hook-pre.mjs']);
  const blocking = await bridge({ context: fakeContext({ sessions }), scripts, routes: routesFile('session-gone.json', [preRoute({ script: 'hook-pre.mjs' })]), events: BLOCKING });
  for (const sessionID of ['ses_main', 'ses_unread']) await blocking.context.hooks['execute.before'](beforeEvent({ sessionID }));
  assert.deepEqual(blocking.calls.map((call) => [call.options.cwd, sent(call).cwd]), [[OWN_DIR, OWN_DIR], [OWN_DIR, OWN_DIR]], 'a blocking route still sends both, from the plugin`s folder');
});

// fs.statSync, as call.mjs's own `statSync` import sees it, with the session's folder gone on the looks `gone(n)` names:
// the n-th look at SESSION_DIR, from 1, and every look at any other path, ask the disk.
async function withSessionLooks(t, gone, body) {
  const real = fs.statSync;
  let looks = 0;
  t.mock.method(fs, 'statSync', (file, ...rest) => {
    if (file === SESSION_DIR && gone(++looks)) throw Object.assign(new Error(`ENOENT: ${file}`), { code: 'ENOENT' });
    return real(file, ...rest);
  });
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('a record-only call looks at its session`s folder once: one that comes back after that look is not recorded under the plugin`s folder, and one gone after it is still recorded', async (t) => {
  const looks = async (gone) => withSessionLooks(t, gone, async () => {
    const { calls, fire } = await bridge();
    await fire(shellEvent({ input: { command: 'gh pr create' } }));
    return calls.map((call) => [call.options.cwd, sent(call).cwd]);
  });
  assert.deepEqual(await looks((look) => look === 1), [], 'gone on the first look, back after it: skipped, never sent from the plugin`s folder');
  assert.deepEqual(await looks((look) => look > 1), [[SESSION_DIR, SESSION_DIR]], 'there on the first look, gone after it: recorded, never dropped');
  assert.deepEqual(await looks(() => false), [[SESSION_DIR, SESSION_DIR]], 'there on every look');
});

test('setup resolves when one registration rejects, still makes the other, and traces and keeps a notice naming the one lost', async () => {
  const rejects = async () => { throw new Error('no hooks here'); };
  const trace = path.join(ROOT, 'trace-unregistered.jsonl');
  const notices = [];
  const toolFails = fakeContext({ toolHook: rejects });
  await bridge({ context: toolFails, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace }, notices });
  assert.deepEqual(Object.keys(toolFails.hooks), ['create.before', 'context', 'compaction'], 'the notice`s hooks register');
  const lostScripts = [...new Set(GENERATED.filter((route) => route.event === 'PostToolUse').map((route) => route.script))];
  assert.ok(lostScripts.includes('hook-bash-post.mjs'));
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [...lostScripts.map((script) => ({ step: 'unregistered', script, status: 'execute.after' })), { step: 'setup', status: 2 }]);
  assert.deepEqual(notices, [`OpenCode did not register aidrian's execute.after hook, so ${lostScripts.join(', ')} do not run in this session.`]);
  const one = [];
  await bridge({ context: fakeContext({ toolHook: rejects }), scripts: scriptsFolder('lost-scripts', ['hook-one.mjs']), routes: routesFile('lost.json', [bashRoute('hook-one.mjs'), bashRoute('hook-one.mjs', { args: ['--x'] })]), notices: one });
  assert.deepEqual(one, ["OpenCode did not register aidrian's execute.after hook, so hook-one.mjs does not run in this session."], 'a script named once');
  const shellTrace = path.join(ROOT, 'trace-unregistered-shell.jsonl');
  const shellNotices = [];
  const shellFails = fakeContext({ shellHook: rejects });
  await bridge({ context: shellFails, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: shellTrace }, notices: shellNotices });
  assert.deepEqual(Object.keys(shellFails.hooks), ['execute.after', 'context', 'compaction']);
  assert.deepEqual(traceLines(shellTrace).map(({ at, ...rest }) => rest), [{ step: 'unregistered', status: 'create.before' }, { step: 'setup', status: 3 }]);
  assert.match(shellNotices.join('\n'), /create\.before hook, so aidrian's bin folder is not put on the shell's PATH/u);
  // The context hook lost: the trace says so, the start still runs from the other callbacks, and the notice of it goes
  // to the compaction request, the one place left.
  const contextTrace = path.join(ROOT, 'trace-unregistered-context.jsonl');
  const lostStream = eventStream();
  const contextFails = fakeContext({ subscribe: () => lostStream.iterable, sessionHook: (name) => (name === 'context' ? rejects() : undefined) });
  const contextNotices = [];
  const lostContext = await startBridge('lost-context', { context: contextFails, notices: contextNotices, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: contextTrace } });
  assert.deepEqual(Object.keys(contextFails.hooks), ['execute.after', 'create.before', 'compaction']);
  assert.deepEqual(traceLines(contextTrace).map(({ at, ...rest }) => rest), [{ step: 'unregistered', status: 'context' }, { step: 'setup', status: 2 }]);
  assert.match(contextNotices.join('\n'), /context hook, so aidrian's start lines and these notices do not reach the model/u);
  const compacted = request('ses_main');
  await contextFails.hooks.compaction(compacted);
  assert.deepEqual(compacted.system.slice(1), [startPart(contextNotices[0], 'notice'), startPart(ROOT_LINES)]);
  assert.deepEqual(ran(lostContext.calls), [['hook-session-start.mjs']]);
  lostStream.push({ type: 'session.deleted', data: { sessionID: 'ses_main' } });
  await settle();
  await contextFails.hooks.compaction(request('ses_main'));
  assert.equal(lostContext.calls.length, 2, 'a deleted session drops its start with no context hook too');
  assert.equal(await setup(null, { spawn: fakeSpawn().spawn, env: ENV }), undefined, 'not even a context');
  assert.equal(await setup(fakeContext(), null), undefined, 'no seams');
  const throwing = { get scripts() { throw new Error('no scripts here'); } };
  for (const seams of [throwing, { spawn: fakeSpawn().spawn, env: ENV, scripts: 42 }, { env: ENV, scripts: null }]) {
    assert.equal(await setup(fakeContext(), seams), undefined, 'a scripts seam that throws or is no string');
  }
});

test('a route whose script is not a file in the scripts folder is traced missing with a notice naming it, and its call records nothing', async () => {
  const context = fakeContext();
  const trace = path.join(ROOT, 'trace-missing.jsonl');
  const notices = [];
  const { calls, fire } = await bridge({ context, scripts: path.join(ROOT, 'no-scripts'), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace }, notices });
  assert.deepEqual(Object.keys(context.hooks), ['execute.after', 'create.before', 'context', 'compaction'], 'its route stays registered');
  const lost = [...new Set(GENERATED.filter((route) => route.event === 'PostToolUse').map((route) => route.script))];
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [...lost.map((script) => ({ step: 'unregistered', script, status: 'missing' })), { step: 'setup', status: 3 }]);
  assert.deepEqual(notices, [`aidrian's hook scripts not on disk at setup run nothing until restored, as each call checks again, and a script missing when its call checks it, or gone when it exits 1, refuses a subagent's call on a blocking route: ${lost.join(', ')}.`]);
  const event = shellEvent();
  const before = structuredClone(event);
  assert.equal(await fire(event), undefined);
  assert.deepEqual([calls.length, event], [0, before], 'nothing spawned, and the call stays as it was');
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest).at(-1), { step: 'run', script: 'hook-bash-post.mjs', status: 'missing' });
  const scripts = scriptsFolder('half-scripts', ['hook-here.mjs', 'hook-later.mjs']);
  const half = await bridge({ scripts, routes: routesFile('half.json', [bashRoute('hook-here.mjs'), bashRoute('hook-gone.mjs'), bashRoute('hook-later.mjs'), bashRoute('hook-gone.mjs', { args: ['--x'] })]), notices: [] });
  rmSync(path.join(scripts, 'hook-later.mjs'));
  assert.equal(await half.fire(shellEvent()), undefined);
  assert.deepEqual(half.calls.map((call) => path.basename(call.args[0])), ['hook-here.mjs'], 'the script on disk still runs; one gone at setup or since spawns nothing');
});

// A blocking route whose script is gone, at setup (`at`) or after it (`since`): a subagent's call is refused, a root's runs.
for (const when of ['at', 'since']) {
  test(`a blocking route whose script is gone ${when} setup refuses a subagent's call and lets a root's run, and spawns nothing`, async () => {
    const scripts = scriptsFolder(`gone-${when}-setup-scripts`, when === 'since' ? ['hook-pre.mjs'] : []);
    const trace = path.join(ROOT, `trace-gone-${when}-setup.jsonl`);
    const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: SESSION_DIR } } } });
    const { calls } = await bridge({ context, scripts, routes: routesFile(`gone-${when}-setup.json`, [preRoute({ script: 'hook-pre.mjs' })]), events: BLOCKING, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    const noticed = when === 'at' ? ['context', 'compaction'] : [];
    assert.deepEqual(Object.keys(context.hooks), ['execute.before', 'execute.after', 'create.before', ...noticed], 'its route stays registered, with the after-hook its context reaches the model on, and a missing script`s notice is given');
    if (when === 'since') rmSync(path.join(scripts, 'hook-pre.mjs'));
    await assert.rejects(context.hooks['execute.before'](beforeEvent({ sessionID: 'ses_child' })), { message: SPAWN_REFUSAL });
    assert.equal(await context.hooks['execute.before'](beforeEvent()), undefined, 'the root session`s call runs');
    assert.equal(calls.length, 0, 'nothing spawned');
    const steps = traceLines(trace).map(({ at, ...rest }) => rest).filter((line) => line.step !== 'setup');
    const missing = { step: 'run', script: 'hook-pre.mjs', status: 'missing' };
    assert.deepEqual(steps, [...(when === 'at' ? [{ step: 'unregistered', script: 'hook-pre.mjs', status: 'missing' }] : []), missing, { step: 'refuse', status: 'spawn' }, missing]);
  });
}

// A blocking route whose script exits 1, once removed after the call's check (`gone`, as Node exits on a script it cannot
// load) or still on disk (`kept`, a hook error).
test('a blocking route`s script gone when it exits 1 refuses a subagent`s call and lets a root`s run; one still there is a hook error', async () => {
  const scripts = scriptsFolder('exit-one-scripts', ['hook-pre.mjs']);
  const file = path.join(scripts, 'hook-pre.mjs');
  const exitsOne = (gone) => fakeSpawn((child, call) => {
    if (gone) rmSync(call.args[0], { force: true });
    queueMicrotask(() => {
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
    });
  });
  const runs = async (gone, name) => {
    const trace = path.join(ROOT, `trace-exit-one-${name}.jsonl`);
    const spawn = exitsOne(gone);
    const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: SESSION_DIR } } } });
    const routes = routesFile(`exit-one-${name}.json`, [preRoute({ script: 'hook-pre.mjs' })]);
    await bridge({ context, spawn, scripts, routes, events: BLOCKING, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    const steps = () => traceLines(trace).map(({ at, ...rest }) => rest).filter((line) => line.step !== 'setup');
    return { fire: context.hooks['execute.before'], spawn, steps };
  };
  const gone = await runs(true, 'gone');
  await assert.rejects(gone.fire(beforeEvent({ sessionID: 'ses_child' })), { message: SPAWN_REFUSAL });
  writeFileSync(file, '');
  assert.equal(await gone.fire(beforeEvent()), undefined, 'the root session`s call runs');
  assert.equal(gone.spawn.calls.length, 2, 'each call spawned the script, which was gone by its exit');
  const missing = { step: 'run', script: 'hook-pre.mjs', status: 'missing' };
  assert.deepEqual(gone.steps(), [missing, { step: 'refuse', status: 'spawn' }, missing]);
  writeFileSync(file, '');
  const kept = await runs(false, 'kept');
  const call = kept.fire(beforeEvent({ sessionID: 'ses_child' }));
  assert.equal(await call, undefined, 'an exit 1 of a script still on disk is a hook error, and the call runs');
  assert.deepEqual(kept.steps(), [{ step: 'run', script: 'hook-pre.mjs', status: 1 }]);
});

test('create.before prepends bin once, leaves a PATH that holds it, and leaves a shell with no PATH of its own as it is', async () => {
  const { context } = await bridge({ bin: BIN });
  const shell = (env) => {
    const event = { command: 'ls', cwd: PROJECT_DIR, timeout: 1, shell: '/bin/sh', env };
    assert.equal(context.hooks['create.before'](event), undefined);
    return event.env;
  };
  const once = shell({ PATH: '/usr/local/bin:/usr/bin' });
  assert.equal(once.PATH, `${BIN}:/usr/local/bin:/usr/bin`);
  assert.equal(shell({ ...once }).PATH, once.PATH, 'a PATH that holds bin is left as it is');
  assert.deepEqual(shell({ PATH: `/usr/bin:${BIN}` }), { PATH: `/usr/bin:${BIN}` });
  // A shell on another machine has no PATH in the event: the server's PATH is not that machine's.
  assert.deepEqual(shell({ TERM: 'dumb' }), { TERM: 'dumb' }, 'a shell with no PATH of its own is left as it is');
  assert.equal(context.hooks['create.before']({ command: 'ls' }), undefined, 'an event with no env changes nothing');
});

test('create.before changes nothing when bin is relative or holds the path delimiter', async () => {
  for (const bin of ['plugins/aidrian/bin', `${BIN}${path.delimiter}/tmp/evil`]) {
    const { context } = await bridge({ bin });
    for (const env of [{ PATH: '/usr/bin' }, { TERM: 'dumb' }]) {
      const before = structuredClone(env);
      context.hooks['create.before']({ command: 'ls', env });
      assert.deepEqual(env, before, bin);
    }
  }
});

test('create.before changes nothing when the shell has no PATH, an empty one, or one that is no text', async () => {
  const { context } = await bridge({ bin: BIN, env: { HOME: ROOT } });
  for (const env of [{ TERM: 'dumb' }, { PATH: '' }, { PATH: 7 }]) {
    const event = { command: 'ls', env };
    const before = structuredClone(event);
    context.hooks['create.before'](event);
    assert.deepEqual(event, before, JSON.stringify(env));
  }
});

test('the trace holds setup and each run with no command, payload, or output; unset or relative, nothing is written', async () => {
  const trace = path.join(ROOT, 'trace.jsonl');
  const { fire } = await bridge({ env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await fire(shellEvent({ sessionID: 'ses_secret_9', input: { command: 'gh pr create --title hush', workdir: PROJECT_DIR } }));
  await fire(shellEvent({ status: 'error' }));
  const text = readFileSync(trace, 'utf8');
  for (const word of ['hush', 'ses_secret_9', 'pull/12', PROJECT_DIR, 'call_1']) assert.ok(!text.includes(word), word);
  const lines = traceLines(trace);
  assert.deepEqual(lines.map(({ at, ...rest }) => rest), [
    { step: 'setup', status: 1 }, { step: 'run', script: 'hook-bash-post.mjs', status: 0 }, { step: 'skip', script: 'hook-bash-post.mjs', status: 'status' },
  ]);
  for (const { at } of lines) assert.match(at, /^\d{4}-\d\d-\d\dT/u);

  const relative = `aidrian-trace-${process.pid}.jsonl`;
  const cwdBefore = readdirSync(process.cwd()).sort();
  for (const env of [ENV, { ...ENV, AIDRIAN_OPENCODE_TRACE: relative }, { ...ENV, AIDRIAN_OPENCODE_TRACE: '' }]) {
    const quiet = await bridge({ env });
    await quiet.fire(shellEvent());
  }
  assert.deepEqual(readdirSync(process.cwd()).sort(), cwdBefore, 'no relative trace file written');
});

// Every module a file names: static and re-export `from`, bare side-effect imports, and dynamic import().
const specifiersOf = (text) => [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"`]([^'"`]+)/gmu)].map((match) => match[1] ?? match[2] ?? match[3]);
// The lib files the bridge may import, each a leaf that imports node: built-ins alone, so the bridge loads in Bun with
// no other lib file: the name table, the hook-result reader, which output.mjs reads each script's answer with, and
// lib/deadline.mjs, the one source of the held guard budget a blocking route's kill time is counted from.
const LIB_LEAVES = ['lib/hosts/opencode-names.mjs', 'lib/hook-result.mjs', 'lib/deadline.mjs'];

test('the bridge files import only node: built-ins, each other, the generated routes, and the lib leaves', () => {
  const dir = path.join(PLUGIN, 'opencode');
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['bridge.mjs', 'call.mjs', 'environment.mjs', 'output.mjs', 'route-select.mjs', 'routes.generated.json', 'routes.mjs', 'server.mjs', 'session-hooks.mjs']);
  const allowed = new Set([...files.map((name) => `./${name}`), ...LIB_LEAVES.map((leaf) => `../${leaf}`)]);
  for (const name of files.filter((each) => each.endsWith('.mjs'))) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const specifier of specifiersOf(text)) assert.ok(specifier.startsWith('node:') || allowed.has(specifier), `${name} imports ${specifier}`);
    assert.doesNotMatch(text, /\brequire\(/u, name);
  }
  assert.deepEqual(specifiersOf(readFileSync(path.join(dir, 'bridge.mjs'), 'utf8')).filter((each) => !each.startsWith('node:')),
    ['../lib/deadline.mjs', '../lib/hosts/opencode-names.mjs', './call.mjs', './environment.mjs', './output.mjs', './route-select.mjs', './routes.mjs', './session-hooks.mjs']);
  assert.deepEqual(specifiersOf(readFileSync(path.join(dir, 'output.mjs'), 'utf8')).filter((each) => !each.startsWith('node:')), ['../lib/hook-result.mjs']);
  for (const half of ['route-select.mjs', 'call.mjs']) {
    assert.deepEqual(specifiersOf(readFileSync(path.join(dir, half), 'utf8')).filter((each) => !each.startsWith('node:')), [], `${half} imports node: built-ins alone`);
  }
});

test('each lib leaf the bridge may import imports node: built-ins alone', () => {
  for (const leaf of LIB_LEAVES) {
    const text = readFileSync(path.join(PLUGIN, leaf), 'utf8');
    for (const specifier of specifiersOf(text)) assert.match(specifier, /^node:/u, `${leaf} imports ${specifier}`);
    assert.doesNotMatch(text, /\brequire\(/u, leaf);
  }
  assert.deepEqual(specifiersOf("import { x } from '../y.mjs';\nimport './side.mjs';\nawait import('z');"), ['../y.mjs', './side.mjs', 'z'], 'the scan sees each form');
});

test('server.mjs`s default export is { id: aidrian, setup }, whose setup hands the bridge the context alone', async () => {
  assert.deepEqual(Object.keys(server), ['id', 'setup']);
  assert.equal(server.id, 'aidrian');
  const context = fakeContext();
  const spawn = fakeSpawn();
  const notices = [];
  assert.equal(await server.setup(context, { spawn: spawn.spawn, node: null, routes: path.join(ROOT, 'no-routes.json'), events: BLOCKING, notices }), undefined);
  assert.deepEqual(Object.keys(context.hooks).sort(), ['compaction', 'context', 'create.before', 'execute.after'], 'a second argument is no seam: the plugin`s own routes and events register');
  assert.deepEqual(notices, []);
});

// The plugin folder is the package OpenCode installs by Git specifier: private, so no npm publish can happen, its version
// aidrian's own, and exports naming the server entry. No type (it would change how Node reads the eval fixtures' .js),
// no files (the package holds what the other hosts install), and no bin, dependencies, or install scripts.
test('the plugin folder`s package.json is private, aidrian`s version, and exports the server entry, with no other field', async () => {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['name', 'version', 'private', 'description', 'license', 'exports']);
  assert.equal(manifest.name, 'aidrian');
  assert.equal(manifest.private, true);
  assert.equal(manifest.version, JSON.parse(readFileSync(path.join(PLUGIN, 'plugin.json'), 'utf8')).version);
  assert.match(manifest.description, /OpenCode 2\.0 and later/u);
  assert.equal(manifest.license, 'Apache-2.0');
  assert.deepEqual(Object.keys(manifest.exports), ['.']);
  const entry = path.join(PLUGIN, manifest.exports['.']);
  assert.ok(existsSync(entry), entry);
  const loaded = (await import(entry)).default;
  assert.deepEqual(Object.keys(loaded), ['id', 'setup']);
  assert.equal(loaded.id, 'aidrian');
  assert.equal(typeof loaded.setup, 'function');
});

// OpenCode installs the plugin folder's tracked files by Git specifier, and an ignore file there narrows what a Git or
// npm install takes: an `.npmignore` anywhere, or a `.gitignore` outside `evals/`, where each of the two tracked eval
// fixtures narrows its own fixture folder only, and a third there needs this list changed. A walk of the folder on disk, so
// an ignore file not yet tracked fails too.
const IGNORE_FIXTURES = ['evals/harness-setup-rerun/fixture/.gitignore', 'evals/product-quorum-auto-start-off/fixture/.gitignore'];
// Skipped: the folders the repository's .gitignore names, `node_modules` anywhere and `results` below `evals/`, which no
// install takes. The walk checks a folder before it descends, so it never reads inside one; `read` lists one folder.
const ignored = (each) => each.split('/').includes('node_modules') || (each.startsWith('evals/') && each.split('/').includes('results'));
function ignoreFiles(root, rel = '', read = readdirSync) {
  const found = [];
  for (const entry of read(path.join(root, rel), { withFileTypes: true })) {
    const each = rel ? `${rel}/${entry.name}` : entry.name;
    if (ignored(each)) continue;
    if (entry.isDirectory()) found.push(...ignoreFiles(root, each, read));
    else if (['.npmignore', '.gitignore'].includes(entry.name)) found.push(each);
  }
  return rel ? found : found.sort();
}
const narrowing = (files) => files.filter((each) => path.posix.basename(each) === '.npmignore' || !each.startsWith('evals/'));

test('the plugin folder holds no .npmignore, and no .gitignore but the two eval fixtures, so a Git install takes every tracked file', () => {
  const files = ignoreFiles(PLUGIN);
  assert.deepEqual(narrowing(files), []);
  assert.deepEqual(files.filter((each) => each.startsWith('evals/')), IGNORE_FIXTURES, 'a new ignore file below evals/ is added here on purpose');
  assert.deepEqual(narrowing(['lib/.npmignore', 'evals/x/.npmignore', 'scripts/.gitignore', '.gitignore', ...IGNORE_FIXTURES]),
    ['lib/.npmignore', 'evals/x/.npmignore', 'scripts/.gitignore', '.gitignore']);
});

// A folder the walk skips is never listed: the walk's `read` records each folder it is given.
test('the ignore-file walk never lists a node_modules or evals results folder, or one inside them', () => {
  const root = mkdtempSync(path.join(ROOT, 'ignore-walk-'));
  for (const dir of ['node_modules/x', 'evals/a/results/y']) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, '.gitignore'), '');
  }
  mkdirSync(path.join(root, 'lib'));
  writeFileSync(path.join(root, 'lib', '.npmignore'), '');
  const listed = [];
  const read = (dir, options) => {
    listed.push(dir);
    return readdirSync(dir, options);
  };
  assert.deepEqual(ignoreFiles(root, '', read), ['lib/.npmignore']);
  const skipped = [path.join(root, 'node_modules'), path.join(root, 'evals', 'a', 'results')];
  assert.deepEqual(listed.filter((dir) => skipped.some((each) => dir === each || dir.startsWith(`${each}${path.sep}`))), []);
  assert.ok(listed.includes(path.join(root, 'lib')), listed.join('\n'));
});

// The scripts the bridge can run: the generated routes it selects on each of its hooks for a name the leaf can return,
// an MCP tool's among them, and each route of an event of EVENTS that names no tool, as the session start's.
const DELIVERED = [...new Set([
  ...Object.values(EVENTS).flatMap((hook) => [...STANDARD_NAMES, 'mcp__server__tool'].flatMap((name) => selectRoutes(GENERATED, EVENTS, hook, name))),
  ...GENERATED.filter((route) => route.matcher === null && Object.hasOwn(EVENTS, route.event)),
].map((route) => route.script))].sort();

// Whether a hooks.json matcher fires on the tool `name` as Claude Code reads it (code.claude.com/docs/en/hooks): "*", empty,
// or none on every tool; only letters, digits, _, -, spaces, commas, and | a list of exact names split on | or ,; any
// other a regular expression that may match anywhere in the name.
const hooksJsonFires = (matcher, name) => {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_ ,|-]+$/u.test(matcher)) return matcher.split(/\s*[|,]\s*/u).includes(name);
  return new RegExp(matcher, 'u').test(name);
};

// Conformance: each OpenCode call the tests hold a payload of runs the scripts hooks.json fires on the name the adapter
// reads from the payload the bridge sends, and a call whose name the leaf cannot read, as an MCP tool's with no info,
// runs none and is counted unguarded. The tool events of EVENTS alone (AFTER_ONLY): the session start, which runs once
// before a session's first call, has its own tests. The fixture's shell call, the adapter tests' shell call, each tool of the leaf's
// table, OpenCode's read tool, and an MCP tool, with no info and with info that carries fields the leaf drops.
test('the bridge runs on each OpenCode call the scripts hooks.json fires on the name the adapter reads from its payload', async () => {
  const fixture = JSON.parse(readFileSync(path.join(REPO, 'test/fixtures/hosts/opencode/bash-post.json'), 'utf8')).post;
  const fromPayload = (post) => shellEvent({ tool: post.tool_name, sessionID: post.session_id, id: post.tool_use_id, input: { ...post.tool_input, workdir: PROJECT_DIR }, result: post.tool_response });
  const events = [
    fromPayload(fixture),
    shellEvent({ input: { command: 'gh pr view 3', workdir: PROJECT_DIR } }),
    shellEvent({ tool: 'edit', input: { path: 'a.md', oldString: 'a', newString: 'b' } }),
    shellEvent({ tool: 'write', input: { path: 'a.md', content: 'x' } }),
    shellEvent({ tool: 'patch', input: { patchText: '*** Begin Patch\n*** End Patch\n' } }),
    shellEvent({ tool: 'read', input: { filePath: '/x' } }),
    shellEvent({ tool: 'linear_save_issue', input: { title: 'x' } }),
    shellEvent({ tool: 'linear_save_issue', input: { title: 'x' }, info: { namespace: 'linear', title: 'Save issue', secret: 'hush' } }),
    shellEvent({ tool: 'linear_save_issue', input: { title: 'x' }, info: { name: 'save_issue', options: { namespace: 'linear' }, secret: 'hush' } }),
    shellEvent({ tool: 'subagent', input: { agent: 'build', description: 'x', prompt: 'y' } }),
    shellEvent({ info: { namespace: 'builtin', secret: 'hush' } }),
  ];
  for (const event of events) {
    const trace = path.join(ROOT, `trace-conformance-${event.tool}-${events.indexOf(event)}.jsonl`);
    const { calls, fire } = await bridge({ context: fakeContext({ app: APP }), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    await fire(event);
    const ran = calls.map((call) => path.basename(call.args[0])).sort();
    const payload = { hook_event_name: 'PostToolUse', opencode: { version: APP.version, info: infoRead(event.info) }, session_id: event.sessionID, cwd: PROJECT_DIR, tool_name: event.tool, tool_input: event.input };
    const name = opencode.hookInput(payload).tool_name;
    const expected = [...new Set(Object.keys(AFTER_ONLY).flatMap((standard) => HOOKS[standard].filter((group) => hooksJsonFires(group.matcher, name))
      .flatMap((group) => group.hooks.map((hook) => /scripts\/(hook-[\w-]+\.mjs)/u.exec(hook.command)[1]))))].sort();
    assert.deepEqual(ran, expected, `${event.tool} as ${name}`);
    for (const call of calls) {
      assert.deepEqual(sent(call).opencode.info, infoRead(event.info), 'the info sent is the info the routes were picked by');
      assert.deepEqual(opencode.hookInput(sent(call)).tool_name, name, 'the adapter reads the name the bridge picked');
    }
    const unguarded = traceLines(trace).filter((line) => line.status === 'unguarded');
    if (standardToolName(event.tool, infoRead(event.info)) === null) assert.deepEqual([ran, unguarded.length], [[], 1], event.tool);
    else assert.equal(unguarded.length, 0, event.tool);
  }
});

// The OpenCode page (docs/providers/opencode.md) says which hooks run there: its Hooks table has one row for each
// script hooks.json runs, and its yes rows are the scripts the bridge can run (DELIVERED), so a route or a hook added
// without the page fails here. The README's entry and the page's Limits say no guard holds an OpenCode session.
const PAGE = readFileSync(path.join(REPO, 'docs/providers/opencode.md'), 'utf8');
const hooksJsonScripts = () => {
  const { hooks } = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  const commands = Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
  return new Set(commands.map((command) => /scripts\/(hook-[\w-]+\.mjs)/u.exec(command)?.[1]).filter(Boolean));
};
// The rows of the Hooks section's first table, { script, runs, verified }, by its header's column names. The section's
// later tables, such as its payload fields, are not this one.
function hookRows(page) {
  const section = sectionLines(page, 'Hooks');
  const start = section.findIndex((line) => line.startsWith('|'));
  const end = section.findIndex((line, at) => at > start && !line.startsWith('|'));
  const lines = section.slice(start, end === -1 ? undefined : end);
  const cells = (line) => line.slice(1, -1).split('|').map((cell) => cell.trim());
  const header = cells(lines[0]);
  assert.deepEqual(header, ['Script', 'Runs on OpenCode', 'Verified', 'Why not']);
  return lines.slice(2).map(cells).map(([script, runs, verified, why]) => ({ script: script.replaceAll('`', ''), runs, verified, why }));
}

test('the bridge can run the session start and the after-hooks of the tools the leaf names alone on OpenCode', () => {
  assert.deepEqual(DELIVERED, ['hook-agent-post.mjs', 'hook-bash-post.mjs', 'hook-markdown-wrap.mjs', 'hook-session-end.mjs', 'hook-session-start.mjs', 'hook-tracker-post.mjs']);
});

test('the OpenCode page`s Hooks table has a row for each hooks.json script, and its yes rows are the scripts the bridge can run', () => {
  const rows = hookRows(PAGE);
  assert.deepEqual(rows.map((row) => row.script).sort(), [...hooksJsonScripts()].sort());
  assert.equal(new Set(rows.map((row) => row.script)).size, rows.length, 'one row a script');
  assert.deepEqual(rows.filter((row) => row.runs === 'yes').map((row) => row.script).sort(), DELIVERED);
  // The scripts a test runs for real on a payload in the bridge's shape: hook-bash-post.mjs's fixture, the four of
  // test/opencode-adapter.test.mjs, and hook-session-end.mjs, run in this process on what the bridge sends on a root's
  // `session.deleted`. Every other route is run with a fake spawn alone.
  assert.deepEqual(rows.filter((row) => row.verified === 'fixture only').map((row) => row.script).sort(),
    ['hook-agent-post.mjs', 'hook-bash-post.mjs', 'hook-markdown-wrap.mjs', 'hook-session-end.mjs', 'hook-session-start.mjs', 'hook-tracker-post.mjs']);
  for (const row of rows) {
    assert.ok(['yes', 'no'].includes(row.runs), row.script);
    assert.ok(row.verified === '-' || row.verified === 'fixture only' || row.verified === 'script not run' || /^live on OpenCode \d+\.\d+\.\d+/u.test(row.verified), `${row.script}: ${row.verified}`);
    if (row.runs === 'no') assert.notEqual(row.why, '', `${row.script} says why it does not run`);
    else assert.notEqual(row.verified, '-', `${row.script} says how it was verified`);
  }
});

test('the hook table check fails on a missing script and on a yes row the bridge cannot run', () => {
  const rows = hookRows(PAGE.replace(/^\| `hook-stop\.mjs` .*\n/mu, ''));
  assert.notDeepEqual(rows.map((row) => row.script).sort(), [...hooksJsonScripts()].sort());
  const yes = hookRows(PAGE.replace('| `hook-bash.mjs` | no |', '| `hook-bash.mjs` | yes |')).filter((row) => row.runs === 'yes').map((row) => row.script);
  assert.notDeepEqual(yes.sort(), DELIVERED);
});

// The standard tools hooks.json names that OpenCode has no tool for, each with its reason, in the page's list: each
// listed name is an alternative of a hooks.json matcher, and none is a name the leaf returns.
const NO_EQUIVALENT = 'Standard tools with no OpenCode equivalent';
// The lines under the `### <NO_EQUIVALENT>` heading, to the next heading of any level.
const subsectionLines = (page, title) => {
  const lines = page.split('\n');
  const start = lines.indexOf(`### ${title}`);
  if (start === -1) return [];
  const end = lines.findIndex((line, at) => at > start && /^#{1,6} /u.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end);
};
const noEquivalentNames = (page) => subsectionLines(page, NO_EQUIVALENT).map((line) => /^- `([^`]+)`: \S/u.exec(line)?.[1]).filter(Boolean)
  .flatMap((entry) => entry.split('|'));
const matcherAlternatives = new Set(Object.values(HOOKS).flat().flatMap((group) => (typeof group.matcher === 'string' ? group.matcher.split('|') : [])));

test('the OpenCode page lists the standard tools with no OpenCode equivalent, each a hooks.json matcher name the leaf never returns', () => {
  const names = noEquivalentNames(PAGE);
  assert.deepEqual(names, ['EnterWorktree', 'ExitPlanMode', 'NotebookEdit', 'Task']);
  for (const name of names) {
    assert.ok(matcherAlternatives.has(name), `${name} is no hooks.json matcher name`);
    assert.ok(!STANDARD_NAMES.includes(name), `${name} is a name the leaf returns`);
  }
  const page = PAGE.replace('- `EnterWorktree`:', '- `Frobnicate`:');
  assert.ok(!noEquivalentNames(page).every((name) => matcherAlternatives.has(name)), 'a name hooks.json does not hold fails');
});

// The other direction: each plain tool name a hooks.json matcher names, an identifier that is no MCP name, in a matcher
// that is a plain list of names (a pattern such as the plugin GitHub server's is not one), is one the leaf maps (a key of RAW_NAMES), another host's own raw name for a standard tool (as Codex's apply_patch),
// or on the page's list, so a tool added to hooks.json says how OpenCode meets it.
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const plainAlternatives = new Set(Object.values(HOOKS).flat().map((group) => group.matcher)
  .filter((matcher) => typeof matcher === 'string' && matcher.split('|').every((name) => PLAIN_NAME.test(name))).flatMap((matcher) => matcher.split('|')));
const otherHostNames = new Set(HOSTS.filter((host) => host.id !== 'opencode')
  .flatMap((host) => [...plainAlternatives].map((standard) => [standard, host.rawToolName(standard)]))
  .filter(([standard, raw]) => raw !== standard).map(([, raw]) => raw));
const unaccounted = (alternatives, listed) => [...alternatives].filter((name) => !name.startsWith('mcp__'))
  .filter((name) => !Object.hasOwn(RAW_NAMES, name) && !otherHostNames.has(name) && !listed.includes(name));

test('every plain tool name of a hooks.json matcher is mapped by the leaf, another host`s raw name, or on the no-equivalent list', () => {
  assert.ok(otherHostNames.has('apply_patch'), 'Codex`s file edit tool is read from its adapter');
  for (const name of ['Bash', 'EnterWorktree', 'apply_patch', 'Task']) assert.ok(plainAlternatives.has(name), `the plain names hold ${name}`);
  assert.deepEqual(unaccounted(plainAlternatives, noEquivalentNames(PAGE)), []);
  assert.deepEqual(unaccounted(new Set([...plainAlternatives, 'Frobnicate']), noEquivalentNames(PAGE)), ['Frobnicate'], 'a new tool name fails');
  assert.deepEqual(unaccounted(plainAlternatives, noEquivalentNames(PAGE).filter((name) => name !== 'ExitPlanMode')), ['ExitPlanMode']);
});

test('the README`s OpenCode entry says the plugin runs the start lines, the after-hooks, and a root`s end, and that no guard holds an OpenCode session', () => {
  const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const entry = /^### OpenCode\n([\s\S]*?)(?=^#{2,3} )/mu.exec(readme)?.[1] ?? '';
  const flat = entry.replace(/\s+/gu, ' ');
  assert.match(flat, /runs each session's start lines, the hooks after a tool call, the session ledger among them, and a root session's end/u);
  assert.doesNotMatch(flat, /session ledger (?:only|alone)/u, 'the ledger is not all that runs there');
  assert.match(flat, /no aidrian guard holds an OpenCode session/u);
  assert.match(entry, /docs\/providers\/opencode\.md#limits/u);
  // The repository's slug comes from the manifest, so this file never names its owner (test/plugin.test.mjs).
  const slug = new URL(JSON.parse(readFileSync(path.join(PLUGIN, 'plugin.json'), 'utf8')).repository).pathname.replace(/^\/|\.git$/gu, '');
  assert.ok(entry.includes(`opencode plugin add 'github:${slug}#main::path:plugins/aidrian'`), entry);
  assert.match(entry, /docs\/providers\/opencode\.md/u);
});

test('the OpenCode page`s Limits say aidrian pr auto-merge reads an OpenCode session as attended and gh pr merge runs unchecked', () => {
  const limits = (sectionLines(PAGE, 'Limits') ?? []).join(' ').replace(/\s+/gu, ' ');
  assert.match(limits, /`aidrian pr auto-merge` run there reads the session as one a Human attends/u);
  assert.match(limits, /`gh pr merge` runs unchecked/u);
  assert.doesNotMatch(PAGE, /write guard holds every write/iu);
});

// End to end, with the real spawn and this Node: a project checkout whose origin is on GitHub, as test/hook-bash-post.test.mjs makes one.
const STATE = path.join(ROOT, 'state');
const HOOK_ENV = { PATH: process.env.PATH, HOME: ROOT, XDG_STATE_HOME: STATE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

function checkout(name, remotes, branch = 'feat/ledger') {
  const dir = path.join(ROOT, name);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir, env: HOOK_ENV }).status, 0, args.join(' '));
  git('init', '-q', '-b', branch);
  // Each remote as `git remote add` writes it, with no git call of its own.
  const config = Object.entries(remotes).map(([remote, url]) => `[remote "${remote}"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/${remote}/*\n`).join('');
  appendFileSync(path.join(dir, '.git/config'), config);
  return dir;
}

function ledgerFiles(session) {
  const projects = path.join(STATE, 'aidrian/projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).map((id) => path.join(projects, id, 'sessions', session, 'prs.jsonl')).filter((file) => existsSync(file));
}

// A gh on PATH that answers every GraphQL read with pull request 12 of acme/widgets, and every list with none.
function fakeGh(bin) {
  mkdirSync(bin, { recursive: true });
  const node = { number: 12, title: 'feat: a title', url: 'https://github.com/acme/widgets/pull/12', isDraft: true, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null,
    createdAt: '2026-11-23T09:00:00Z', headRefName: 'feat/ledger', headRepository: { name: 'widgets', owner: { login: 'acme' } }, repository: { name: 'widgets', owner: { login: 'acme' } },
    reviewThreads: { nodes: [] }, commits: { nodes: [] } };
  const answer = JSON.stringify({ data: { r0: { pullRequest: node } } });
  const script = path.join(bin, 'gh.cjs');
  writeFileSync(script, `process.stdout.write(process.argv.includes('list') ? '[]' : ${JSON.stringify(answer)});\n`);
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
}

test('end to end: a removed folder skips its call, and a completed gh pr create files pull request 12 under the root session', { skip: process.platform === 'win32' }, async () => {
  const project = checkout('e2e', { origin: 'git@github.com:acme/widgets.git' });
  const gone = path.join(ROOT, 'e2e-removed');
  mkdirSync(gone);
  rmSync(gone, { recursive: true });
  const trace = path.join(ROOT, 'trace-e2e.jsonl');
  const env = { ...HOOK_ENV, AIDRIAN_OPENCODE_TRACE: trace };
  const context = fakeContext({ app: APP, sessions: { ses_child: { parentID: 'ses_rootE2E' }, ses_rootE2E: {} } });
  await setup(context, { env, node: process.execPath });
  const fire = (event) => context.hooks['execute.after'](event);
  const command = "gh pr create --draft --title 'feat: a title' --body-file /nowhere/body.md";
  const output = '\nCreating draft pull request for me:feat/ledger into main in acme/widgets\n\nhttps://github.com/acme/widgets/pull/12\n';
  const result = { output: { output, exitCode: 0 }, content: [], metadata: { status: 'completed' } };
  await fire(shellEvent({ sessionID: 'ses_child', input: { command, workdir: gone }, result }));
  await fire(shellEvent({ sessionID: 'ses_child', input: { command, workdir: project }, result }));
  // The root's session read names no folder, so no start runs, and each callback asks again.
  assert.deepEqual(traceLines(trace).map(({ step, script, status }) => [step, script, status]), [
    ['setup', undefined, 3], ['skip', 'hook-session-start.mjs', 'cwd'], ['skip', 'hook-bash-post.mjs', 'cwd'],
    ['skip', 'hook-session-start.mjs', 'cwd'], ['run', 'hook-bash-post.mjs', 0],
  ]);

  const rows = ledgerFiles('ses_rootE2E').flatMap((file) => readFileSync(file, 'utf8').trim().split('\n')).map((line) => JSON.parse(line));
  assert.deepEqual(rows.map(({ at, ...row }) => row), [
    { agentId: 'ses_child', kind: 'created', forge: 'github', host: 'github.com', path: 'acme/widgets', number: 12, branch: null, cwd: project },
  ]);
  assert.deepEqual(ledgerFiles('ses_child'), [], 'nothing filed under the child session');

  const bin = path.join(ROOT, 'gh-bin');
  fakeGh(bin);
  // As docs/providers/opencode.md says to run it in OpenCode's shell, which has this plugin's bin first on its PATH: the
  // snapshot reads no host variable, so the command passes the session from OPENCODE_SESSION_ID.
  const snapshotEnv = { ...env, PATH: [bin, BIN, process.env.PATH].join(path.delimiter), OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_rootE2E' };
  const ran = spawnSync('/bin/sh', ['-c', 'aidrian session snapshot --session "$OPENCODE_SESSION_ID"'], { cwd: project, env: snapshotEnv, encoding: 'utf8' });
  assert.equal(ran.status, 0, ran.stderr);
  const json = JSON.parse(ran.stdout);
  assert.deepEqual(json.prs.map(({ repo, number }) => `${repo}#${number}`), ['acme/widgets#12'], ran.stdout);
});

// The blocking route's tests: the bridge set up with the `events` seam, and hook-bash.mjs run in this process
// (test/hook-call.mjs) on the payload the fake spawn was given, from the folder it was spawned in.

// A project checkout with the main-checkout guard on, a tracked src/, a task worktree inside it at wt/task, and a review
// record for pull request 7 that owes the review bot's request, so the merge guard refuses `gh pr merge 7`.
function guardedCheckout(name) {
  const dir = path.join(ROOT, name);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: `../${name}-state` }, git: { mainCheckout: { guard: true } } }));
  writeFileSync(path.join(dir, '.gitignore'), 'wt/\n');
  writeFileSync(path.join(dir, 'src/app.js'), 'export {};\n');
  const git = (...args) => assert.equal(spawnSync('git', ['-C', dir, ...args], { env: HOOK_ENV }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/notes.git');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  const state = emptyState(7, 'acme/notes');
  state.pending.push({ kind: 'request', head: SHA, at: '2026-11-03T13:50:00.000Z', by: 'the Human' });
  writeLocalState(projectAt(dir), state);
  return dir;
}
// One checkout for the merge and the climb tests.
const GUARDED = process.platform === 'win32' ? null : guardedCheckout('guarded-checkout');

// A spawn that runs hook-bash.mjs in this process on what the bridge sent, and keeps each { status, stderr }.
function inProcessSpawn() {
  const results = [];
  const spawn = fakeSpawn((child, call) => {
    hookCall(HOOK_BASH, { input: call.stdin, cwd: call.options.cwd, env: call.options.env }).then((result) => {
      results.push(result);
      answers(child, result);
    });
  });
  return { ...spawn, results };
}

async function blockingBridge({ context, trace, routes = routesFile('blocking.json', [preRoute()]) }) {
  const spawn = inProcessSpawn();
  await setup(context, { spawn: spawn.spawn, env: { ...HOOK_ENV, AIDRIAN_OPENCODE_TRACE: trace }, node: process.execPath, routes, events: BLOCKING });
  return { ...spawn, fire: (event) => context.hooks['execute.before'](event) };
}

// The bridge with the blocking route on the fake spawn, which runs nothing: `fire` runs its execute.before callback.
async function fakeBlocking(context) {
  const made = await bridge({ context, routes: routesFile('blocking.json', [preRoute()]), events: BLOCKING });
  return { ...made, fire: (event) => context.hooks['execute.before'](event) };
}

test('a blocking route skips no call for a reason its input controls: each is sent as the plain call is, from the session`s folder', { skip: process.platform === 'win32' }, async () => {
  const repo = GUARDED;
  const gone = path.join(repo, 'src', 'gone');
  mkdirSync(gone);
  const cases = {
    'a relative workdir': [{ command: MERGE, workdir: 'src' }, path.join(repo, 'src')],
    'a relative workdir that starts like another machine`s': [{ command: MERGE, workdir: 'ab:x/../src' }, path.join(repo, 'src')],
    'a workdir on another machine': [{ command: MERGE, workdir: 'box:/srv/notes' }, repo],
    'a workdir of another type': [{ command: MERGE, workdir: 42 }, repo],
    'an input with fields the shell does not take': [{ command: MERGE, timeout: 'x', extra: { nested: true } }, repo],
    'a workdir that vanished': [{ command: MERGE, workdir: gone }, repo],
  };
  rmSync(gone, { recursive: true });
  const { calls, fire } = await fakeBlocking(fakeContext({ sessions: { ses_main: { location: { directory: repo } } } }));
  await fire(beforeEvent());
  const plain = sent(calls[0]);
  assert.deepEqual([calls[0].options.cwd, plain.cwd, plain.hook_event_name, Object.hasOwn(plain, 'agent_id')], [repo, repo, 'PreToolUse', false]);
  const without = ({ cwd, tool_input: input, ...rest }) => rest;
  for (const [name, [input, cwd]] of Object.entries(cases)) {
    await fire(beforeEvent({ input }));
    const call = calls.at(-1);
    assert.equal(calls.length, Object.keys(cases).indexOf(name) + 2, `${name}: sent`);
    assert.deepEqual(without(sent(call)), without(plain), name);
    assert.deepEqual([call.options.cwd, sent(call).cwd, sent(call).tool_input], [repo, cwd, input], name);
  }
  await fire(beforeEvent({ status: 'running' }));
  assert.deepEqual(sent(calls.at(-1)), plain, 'a status of no completed call changes nothing');

  // A session read that fails: the plugin's folder, and the call sent as a subagent's.
  const failing = await fakeBlocking(fakeContext({ sessions: { ses_main: new Error('read failed') }, location: { directory: repo } }));
  await failing.fire(beforeEvent());
  assert.equal(failing.calls[0].options.cwd, repo);
  assert.deepEqual(sent(failing.calls[0]), { ...plain, agent_id: 'ses_main' });
});

test('the merge guard refuses gh pr merge on what a blocking route sends, from each folder a payload names, the call rejects with its stderr, and the trace keeps none of it', { skip: process.platform === 'win32' }, async () => {
  const repo = GUARDED;
  const trace = path.join(ROOT, 'trace-blocking.jsonl');
  const context = fakeContext({ sessions: { ses_main: { location: { directory: repo } } } });
  const { calls, results, fire } = await blockingBridge({ context, trace });
  const refusals = [];
  for (const input of [{ command: MERGE }, { command: MERGE, workdir: 'src' }]) await fire(beforeEvent({ input })).then(() => assert.fail('the call ran'), (error) => refusals.push(error));
  assert.deepEqual(calls.map((call) => [call.options.cwd, sent(call).cwd]), [[repo, repo], [repo, path.join(repo, 'src')]]);
  for (const [at, result] of results.entries()) {
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /never sent/u);
    assert.equal(refusals[at].message, result.stderr.trim(), 'the refusal is the hook`s stderr');
  }
  // The trace of each refused call holds the allowed fields alone, and none of the command, the folder, or the refusal.
  const text = readFileSync(trace, 'utf8');
  for (const word of ['gh pr merge', 'match-head-commit', SHA.slice(0, 7), repo, 'never sent', 'ses_main', 'call_b']) assert.ok(!text.includes(word), word);
  for (const line of traceLines(trace)) assert.deepEqual(Object.keys(line).filter((key) => !['at', 'step', 'script', 'status', 'count'].includes(key)), [], JSON.stringify(line));
  assert.deepEqual(traceLines(trace).filter((line) => line.step !== 'setup').map(({ step, script, status }) => [step, script, status]), Array(2).fill([['run', 'hook-bash.mjs', 2], ['refuse', undefined, 'hook']]).flat());
});

test('a relative workdir that climbs from a worktree into the main checkout gets a commit refused there', { skip: process.platform === 'win32' }, async () => {
  const repo = GUARDED;
  const worktree = path.join(repo, 'wt/task');
  const context = fakeContext({ sessions: { ses_main: { location: { directory: worktree } } } });
  const plain = await fakeBlocking(context);
  await plain.fire(beforeEvent({ input: { command: 'git commit -m x', workdir: '../..' } }));
  assert.deepEqual([plain.calls[0].options.cwd, sent(plain.calls[0]).cwd], [worktree, repo], 'a plain climb');
  await plain.fire(beforeEvent({ input: { command: 'git commit -m x' } }));
  assert.deepEqual([plain.calls[1].options.cwd, sent(plain.calls[1]).cwd], [worktree, worktree], 'with no workdir, the worktree');
  const { calls, results, fire } = await blockingBridge({ context, trace: path.join(ROOT, 'trace-climb.jsonl') });
  await assert.rejects(fire(beforeEvent({ input: { command: 'git commit -m x', workdir: 'ab:x/../../..' } })), (error) => error.message.includes(`in the main checkout (${repo})`));
  assert.deepEqual([calls[0].options.cwd, sent(calls[0]).cwd], [worktree, repo], 'a climb that starts like another machine`s workdir');
  assert.equal(results[0].status, 2, results[0].stderr);
  assert.ok(results[0].stderr.includes(`in the main checkout (${repo})`), results[0].stderr);
});

test('a blocking route sends a call with no input, or a command of another type, that an execute.after route skips', async () => {
  const scripts = scriptsFolder('blocking-shape-scripts', ['hook-pre.mjs']);
  const routes = routesFile('blocking-shape.json', [preRoute({ script: 'hook-pre.mjs' })]);
  const { context, calls } = await bridge({ scripts, routes, events: BLOCKING });
  for (const input of [null, { command: ['gh', 'pr', 'merge'] }, 'gh pr merge 7']) await context.hooks['execute.before'](beforeEvent({ input }));
  assert.deepEqual(calls.map((call) => sent(call).tool_input), [null, { command: ['gh', 'pr', 'merge'] }, 'gh pr merge 7']);
  await context.hooks['execute.before'](beforeEvent({ sessionID: 42 }));
  assert.equal(calls.length, 3, 'a call with no session id, which the input cannot change, is still skipped');
});

test(`a blocking route's script is killed no sooner than ${BLOCKING_KILL_MS} ms from its spawn, 1 s past the held guard budget, or its own longer timeout`, { timeout: 10_000 }, async (t) => {
  assert.equal(BLOCKING_KILL_MS, HELD_BUDGET_MS + 1000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scripts = scriptsFolder('blocking-kill-scripts', ['hook-five.mjs', 'hook-ten.mjs']);
  const routes = routesFile('blocking-kill.json', [preRoute({ script: 'hook-five.mjs', timeoutMs: 5000 }), preRoute({ script: 'hook-ten.mjs', timeoutMs: 10_000 })]);
  // A session read that runs late: the call is sent at the read cap, as a subagent's, and each script's time starts at its spawn.
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({ location: { directory: SESSION_DIR } }), 60_000));
  const context = fakeContext({ sessions: { ses_main: slow } });
  const spawn = fakeSpawn(() => {});
  await bridge({ context, spawn, scripts, routes, events: BLOCKING });
  const running = context.hooks['execute.before'](beforeEvent());
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(READ_MS);
  while (spawn.calls.length < 2) await settle();
  assert.deepEqual(spawn.calls.map((call) => [sent(call).session_id, sent(call).agent_id]), [['ses_main', 'ses_main'], ['ses_main', 'ses_main']], 'a late read is sent with agent_id');
  t.mock.timers.tick(BLOCKING_KILL_MS - 1);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [[], []], 'not at the 5 s timeout');
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], []]);
  t.mock.timers.tick(10_000 - BLOCKING_KILL_MS);
  await running;
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], ['SIGKILL']], 'the 10 s route at its own timeout');
});

// The output transformer (plugins/aidrian/opencode/output.mjs): what a script's answer does to OpenCode's callback.

// The bridge with one blocking route of its own scripts folder on `spawn`: `fire` runs its execute.before callback.
async function guardBridge(name, { spawn, context = fakeContext(), routes = [preRoute({ script: 'hook-pre.mjs' })], env = ENV } = {}) {
  const scripts = scriptsFolder(`${name}-scripts`, [...new Set(routes.map((route) => route.script))]);
  const made = await bridge({ context, spawn, env, scripts, routes: routesFile(`${name}.json`, routes), events: BLOCKING });
  return { ...made, fire: (event) => context.hooks['execute.before'](event) };
}
const rewrite = (updatedInput) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } });

test('capture keeps a stream`s bytes up to its bound, and past it keeps none, reads on, and says it overflowed', () => {
  const at = new EventEmitter();
  const kept = capture(at, 4);
  at.emit('data', Buffer.from('ab'));
  at.emit('data', 'cd');
  assert.deepEqual([kept.text(), kept.overflow], ['abcd', false], 'exactly the bound is kept');
  at.emit('data', Buffer.from('e'));
  at.emit('data', Buffer.from('f'));
  assert.deepEqual([kept.text(), kept.overflow], ['', true]);
  assert.deepEqual([capture(undefined).text(), capture(undefined).overflow], ['', false], 'no stream, no text');
  assert.equal(CAPTURE_BYTES, 256 * 1024);
});

test('an exit 2 on execute.before rejects with the hook`s stderr, and the trace keeps the refusal`s word alone', async () => {
  const trace = path.join(ROOT, 'trace-refuse.jsonl');
  const spawn = fakeSpawn(writes({ status: 2, stderr: 'Never merge here: hush.\n' }));
  const { fire } = await guardBridge('refuse', { spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await assert.rejects(fire(beforeEvent()), (error) => error instanceof Error && error.message === 'Never merge here: hush.');
  const text = readFileSync(trace, 'utf8');
  assert.ok(!text.includes('hush'), text);
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest).slice(1), [{ step: 'run', script: 'hook-pre.mjs', status: 2 }, { step: 'refuse', status: 'hook' }]);
});

test('past the byte bound an exit 2 still refuses, with no text of the hook`s, and the child is never killed for it', async () => {
  const spawn = fakeSpawn((child) => queueMicrotask(() => {
    child.stderr.emit('data', Buffer.alloc(CAPTURE_BYTES, 'x'));
    child.stderr.emit('data', Buffer.from('y'));
    child.emit('close', 2, null);
  }));
  const { calls, fire } = await guardBridge('overflow', { spawn });
  await assert.rejects(fire(beforeEvent()), { message: OVERFLOW_REASON });
  assert.deepEqual(calls[0].killed, []);
  const big = fakeSpawn(writes({ status: 0, stdout: rewrite({ command: 'echo safe', pad: 'x'.repeat(CAPTURE_BYTES) }) }));
  const event = beforeEvent();
  const input = event.input;
  await (await guardBridge('overflow-rewrite', { spawn: big })).fire(event);
  assert.equal(event.input, input, 'a rewrite past the bound is no answer: the input stays');
});

test('a child that exits 2 but never closes its pipes is read at the kill time with what it wrote, and never killed', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawn = fakeSpawn((child) => queueMicrotask(() => {
    child.stderr.emit('data', Buffer.from('Refused, pipes held.\n'));
    child.emit('exit', 2, null);
  }));
  const { calls, fire } = await guardBridge('exit-no-close', { spawn });
  const outcome = fire(beforeEvent()).then(() => 'ran', (error) => error.message);
  while (calls.length === 0) await settle();
  await settle();
  t.mock.timers.tick(BLOCKING_KILL_MS);
  assert.equal(await outcome, 'Refused, pipes held.');
  assert.deepEqual(calls[0].killed, [], 'an exited child is not killed');
});

test('a route runner that throws or rejects never drops a peer`s answer: its exit 2 still refuses, and a subagent`s call fails closed', async () => {
  const routes = [{ event: 'PreToolUse', script: 'hook-a.mjs' }, { event: 'PreToolUse', script: 'hook-b.mjs' }];
  for (const broken of [() => { throw new Error('runner'); }, async () => { throw new Error('runner'); }]) {
    const steps = (agent) => ({ select: () => ({ routes }), call: () => ({ base: ROOT, agent }), run: (route) => (route.script === 'hook-a.mjs' ? broken() : { exit: 2, stderr: 'peer refused' }) });
    await assert.rejects(transform('execute.before', steps(null))({}), { message: 'peer refused' });
    await assert.rejects(transform('execute.before', steps('ses_child'))({}), { message: SPAWN_REFUSAL });
    const applied = [];
    await transform('experimental.idle', { ...steps(null), routes: undefined, run: (route) => (route.script === 'hook-a.mjs' ? broken() : { exit: 2, stderr: 'back' }), select: () => ({ routes: [{ event: 'Stop', script: 'hook-a.mjs' }, { event: 'Stop', script: 'hook-b.mjs' }] }), apply: (event, verdict) => { applied.push(verdict.reason); } })({});
    assert.deepEqual(applied, ['back']);
  }
});

test('an updatedInput replaces the event`s input before the tool runs; the same rewrite twice applies, two that differ refuse', async () => {
  const two = [preRoute({ script: 'hook-one.mjs' }), preRoute({ script: 'hook-two.mjs' })];
  const by = (answer) => fakeSpawn((child, call) => answers(child, answer(path.basename(call.args[0]))));
  const event = beforeEvent();
  await (await guardBridge('rewrite-one', { spawn: by(() => ({ status: 0, stdout: rewrite({ command: 'echo safe' }) })) })).fire(event);
  assert.deepEqual(event.input, { command: 'echo safe' }, 'the event OpenCode passed holds the rewrite');
  const same = beforeEvent();
  await (await guardBridge('rewrite-same', { routes: two, spawn: by(() => ({ status: 0, stdout: rewrite({ command: 'echo safe' }) })) })).fire(same);
  assert.deepEqual(same.input, { command: 'echo safe' });
  const differ = beforeEvent();
  const before = differ.input;
  const spawn = by((script) => ({ status: 0, stdout: rewrite({ command: `echo ${script}` }) }));
  await assert.rejects((await guardBridge('rewrite-differ', { routes: two, spawn })).fire(differ), { message: REWRITE_CONFLICT });
  assert.equal(differ.input, before);
  const plain = beforeEvent();
  await (await guardBridge('rewrite-none', { spawn: by(() => ({ status: 0, stdout: 'not json' })) })).fire(plain);
  assert.deepEqual(plain, beforeEvent(), 'an exit 0 with no rewrite changes nothing');
});

test('a subagent`s call fails closed on a blocking route when a script does not start or the call is in code mode; the root`s runs', async () => {
  const child = { ses_child: { parentID: 'ses_main', location: { directory: SESSION_DIR } } };
  for (const [name, spawn] of Object.entries({ error: fakeSpawn((made) => queueMicrotask(() => made.emit('error', ENOENT()))), throws: { spawn: () => { throw new Error('spawn failed'); }, calls: [] } })) {
    const sub = await guardBridge(`spawn-${name}`, { spawn, context: fakeContext({ sessions: child }) });
    await assert.rejects(sub.fire(beforeEvent({ sessionID: 'ses_child' })), { message: SPAWN_REFUSAL }, name);
    const root = await guardBridge(`spawn-${name}-root`, { spawn });
    assert.equal(await root.fire(beforeEvent()), undefined, `${name}: the root session's call runs`);
  }
  const spawn = fakeSpawn();
  const coded = await guardBridge('codemode', { spawn, context: fakeContext({ sessions: child }) });
  await assert.rejects(coded.fire(beforeEvent({ sessionID: 'ses_child', codemode: true })), { message: CODEMODE_REFUSAL });
  assert.equal(spawn.calls.length, 0, 'nothing is sent for it');
  await coded.fire(beforeEvent({ codemode: true }));
  await coded.fire(beforeEvent({ sessionID: 'ses_child', codemode: false }));
  assert.equal(spawn.calls.length, 2, 'the root`s code-mode call and the subagent`s plain call run');
});

test('a PostToolUse answer gives no block, and its context, an exit 2`s stderr, is appended to the completed call`s result', async () => {
  const answer = { status: 2, stderr: 'context for the model', stdout: '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"x"}}' };
  const { fire } = await bridge({ spawn: fakeSpawn(writes(answer)) });
  const event = shellEvent();
  const before = structuredClone(event);
  assert.equal(await fire(event), undefined);
  // The content was an empty list, which OpenCode reads from `output`: that text stays first, then the context.
  const content = [{ type: 'text', text: JSON.stringify(before.result.output) }, { type: 'text', text: 'context for the model' }];
  assert.deepEqual(event, { ...before, result: { ...before.result, content } });
});

// A PostToolUse or PreToolUse answer that gives `text` as its context.
const contextAnswer = (event, text) => ({ status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) });
// The execute.after event of a shell call that errored: `status` error, an `error`, and no `result`, as 2.4.1 types it.
const erroredEvent = (fields = {}) => {
  const event = { ...shellEvent(fields), status: 'error', error: { message: 'exit 1' } };
  delete event.result;
  return event;
};

test('every after-route reads the result as it came, and their contexts follow the content OpenCode reads, in route order, on a completed call alone', async () => {
  const scripts = scriptsFolder('post-context-scripts', ['hook-one.mjs', 'hook-two.mjs']);
  const spawn = fakeSpawn((child, call) => answers(child, contextAnswer('PostToolUse', path.basename(call.args[0]) === 'hook-one.mjs' ? 'first' : 'second')));
  const trace = path.join(ROOT, 'trace-post-context.jsonl');
  const { calls, fire } = await bridge({ spawn, scripts, routes: routesFile('post-context.json', [bashRoute('hook-one.mjs'), bashRoute('hook-two.mjs')]), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const event = shellEvent();
  const given = event.result;
  const original = structuredClone(given);
  await fire(event);
  assert.deepEqual(calls.map((call) => sent(call).tool_response), [original, original], 'neither route`s payload holds a context');
  assert.deepEqual(given, original, 'the result OpenCode gave is replaced, never changed in place');
  assert.deepEqual(event.result, { ...original, content: [{ type: 'text', text: JSON.stringify(original.output) }, { type: 'text', text: 'first\n\nsecond' }] });
  // A text content is one text part, and a list that is not empty stays as it is, as OpenCode reads each.
  const text = shellEvent({ result: { output: { exitCode: 0 }, content: 'all done' } });
  await fire(text);
  assert.deepEqual(text.result, { output: { exitCode: 0 }, content: [{ type: 'text', text: 'all done' }, { type: 'text', text: 'first\n\nsecond' }] });
  const file = { type: 'file', uri: 'file:///tmp/a.png', mime: 'image/png' };
  const listed = shellEvent({ result: { content: [file] } });
  await fire(listed);
  assert.deepEqual(listed.result, { content: [file, { type: 'text', text: 'first\n\nsecond' }] });
  // An errored call runs no route, and its event is left as it was.
  const errored = erroredEvent();
  const copy = structuredClone(errored);
  const spawned = calls.length;
  await fire(errored);
  assert.deepEqual([errored, calls.length], [copy, spawned]);
  assert.ok(!readFileSync(trace, 'utf8').includes('first'), 'no context is written to the trace');
});

test('a PreToolUse context is kept for its call and ends its completed result; an errored call`s result is left as it was, and the kept context is gone', async () => {
  const warn = 'This command reads a file the project marks as secret.';
  const spawn = fakeSpawn((child, call) => answers(child, contextAnswer('PreToolUse', warn)));
  const trace = path.join(ROOT, 'trace-pre-context.jsonl');
  const context = fakeContext();
  const { calls } = await bridge({ context, spawn, routes: routesFile('pre-context.json', [preRoute()]), events: BLOCKING, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const [before, after] = [context.hooks['execute.before'], context.hooks['execute.after']];
  assert.equal(typeof after, 'function', 'a routed before-hook registers the after-hook, with no after-route of its own');
  assert.equal(await before(beforeEvent({ id: 'call_ok' })), undefined);
  const done = shellEvent({ sessionID: 'ses_main', id: 'call_ok' });
  const original = structuredClone(done.result);
  await after(done);
  assert.deepEqual(done.result, { ...original, content: [{ type: 'text', text: JSON.stringify(original.output) }, { type: 'text', text: warn }] });
  assert.equal(calls.length, 1, 'the after-hook runs no route');

  // An errored call: its event is left as it was, and its kept context is gone, so a completed event of the same id
  // gets none.
  await before(beforeEvent({ id: 'call_err' }));
  const errored = erroredEvent({ sessionID: 'ses_main', id: 'call_err' });
  const copy = structuredClone(errored);
  await after(errored);
  assert.deepEqual(errored, copy);
  const again = shellEvent({ sessionID: 'ses_main', id: 'call_err' });
  const unchanged = structuredClone(again);
  await after(again);
  assert.deepEqual(again, unchanged, 'nothing was left in the map');
  // A call with no string id keeps nothing, and another session's call of the same id gets nothing.
  await before(beforeEvent({ id: undefined }));
  const unnamed = shellEvent({ sessionID: 'ses_main', id: undefined });
  const plain = structuredClone(unnamed);
  await after(unnamed);
  assert.deepEqual(unnamed, plain);
  await before(beforeEvent({ id: 'call_x' }));
  const other = shellEvent({ sessionID: 'ses_other', id: 'call_x' });
  const otherCopy = structuredClone(other);
  await after(other);
  assert.deepEqual(other, otherCopy);
  // A refused call keeps nothing.
  const refusing = fakeContext();
  await bridge({ context: refusing, spawn: fakeSpawn((child) => answers(child, { status: 2, stderr: 'no', stdout: '' })), routes: routesFile('pre-context-refused.json', [preRoute()]), events: BLOCKING });
  await assert.rejects(refusing.hooks['execute.before'](beforeEvent({ id: 'call_no' })), { message: 'no' });
  const refused = shellEvent({ sessionID: 'ses_main', id: 'call_no' });
  const refusedCopy = structuredClone(refused);
  await refusing.hooks['execute.after'](refused);
  assert.deepEqual(refused, refusedCopy);
  assert.ok(!readFileSync(trace, 'utf8').includes('secret'), 'no context is written to the trace');
});

test(`the kept PreToolUse contexts are cleared whole once ${CONTEXTS_MAX} calls hold one: an earlier call's is lost, the next call's kept`, async () => {
  const spawn = fakeSpawn((child, call) => answers(child, contextAnswer('PreToolUse', `context of ${sent(call).tool_use_id}`)));
  const context = fakeContext();
  await bridge({ context, spawn, routes: routesFile('pre-context-bound.json', [preRoute()]), events: BLOCKING });
  const [before, after] = [context.hooks['execute.before'], context.hooks['execute.after']];
  const ended = async (id) => {
    const event = shellEvent({ sessionID: 'ses_main', id });
    await after(event);
    return event.result.content.at(-1)?.text ?? null;
  };
  for (let n = 0; n < CONTEXTS_MAX; n += 1) await before(beforeEvent({ id: `call_${n}` }));
  assert.equal(await ended('call_1'), 'context of call_1', `${CONTEXTS_MAX} calls are held`);
  await before(beforeEvent({ id: 'call_1' }));
  await before(beforeEvent({ id: `call_${CONTEXTS_MAX}` }));
  assert.equal(await ended('call_0'), null, 'cleared with the map: the result is left as it was');
  assert.equal(await ended(`call_${CONTEXTS_MAX}`), `context of call_${CONTEXTS_MAX}`);
});

test('a call with a PreToolUse context and an after-route: the route reads the result as it came, and the result ends with the PreToolUse context, then the PostToolUse one', async () => {
  const scripts = scriptsFolder('pre-post-context-scripts', ['hook-bash.mjs', 'hook-one.mjs']);
  const spawn = fakeSpawn((child, call) => answers(child, path.basename(call.args[0]) === 'hook-bash.mjs' ? contextAnswer('PreToolUse', 'before') : contextAnswer('PostToolUse', 'after')));
  const context = fakeContext();
  const { calls } = await bridge({ context, spawn, scripts, routes: routesFile('pre-post-context.json', [preRoute(), bashRoute('hook-one.mjs')]), events: { ...AFTER_ONLY, ...BLOCKING } });
  await context.hooks['execute.before'](beforeEvent({ id: 'call_both' }));
  const event = shellEvent({ sessionID: 'ses_main', id: 'call_both' });
  const original = structuredClone(event.result);
  await context.hooks['execute.after'](event);
  assert.deepEqual(sent(calls.at(-1)).tool_response, original, 'the after-route read the result as it came, with no context');
  assert.deepEqual(event.result.content, [{ type: 'text', text: JSON.stringify(original.output) }, { type: 'text', text: 'before' }, { type: 'text', text: 'after' }]);
});

test('a refused call keeps no context, though another of its before-routes gave one', async () => {
  const scripts = scriptsFolder('pre-refuse-context-scripts', ['hook-bash.mjs', 'hook-warn.mjs']);
  const spawn = fakeSpawn((child, call) => answers(child, path.basename(call.args[0]) === 'hook-warn.mjs' ? contextAnswer('PreToolUse', 'warned') : { status: 2, stderr: 'no' }));
  const context = fakeContext();
  await bridge({ context, spawn, scripts, routes: routesFile('pre-refuse-context.json', [preRoute(), preRoute({ script: 'hook-warn.mjs' })]), events: BLOCKING });
  await assert.rejects(context.hooks['execute.before'](beforeEvent({ id: 'call_no' })), { message: 'no' });
  const event = shellEvent({ sessionID: 'ses_main', id: 'call_no' });
  const copy = structuredClone(event);
  await context.hooks['execute.after'](event);
  assert.deepEqual(event, copy);
});

test('a later call of the same session and id drops a context kept for an earlier one whose execute.after never came', async () => {
  let speak = true;
  const spawn = fakeSpawn((child) => answers(child, speak ? contextAnswer('PreToolUse', 'the earlier call`s') : { status: 0 }));
  const context = fakeContext();
  await bridge({ context, spawn, routes: routesFile('pre-context-again.json', [preRoute()]), events: BLOCKING });
  await context.hooks['execute.before'](beforeEvent({ id: 'call_k' }));
  speak = false;
  await context.hooks['execute.before'](beforeEvent({ id: 'call_k' }));
  const event = shellEvent({ sessionID: 'ses_main', id: 'call_k' });
  const copy = structuredClone(event);
  await context.hooks['execute.after'](event);
  assert.deepEqual(event, copy, 'the later call`s result gets no text of the earlier call`s');
});

// The bridge with one Stop route on the idle hook, through the `events` seam: `idle(sessionID)` runs its callback.
const STOP_ROUTE = Object.freeze({ event: 'Stop', matcher: null, script: 'hook-stop.mjs', args: [], timeoutMs: 15_000 });
async function stopBridge(name, { context, spawn, env = ENV, scripts }) {
  const made = await bridge({ context, spawn, env, scripts: scripts ?? scriptsFolder(`${name}-scripts`, ['hook-stop.mjs']), routes: routesFile(`${name}.json`, [STOP_ROUTE]), events: { Stop: 'experimental.idle' } });
  return { ...made, idle: (sessionID, background = []) => context.hooks['experimental.idle']({ sessionID, background }) };
}
// A controllable event stream, as context.event.subscribe gives one: `push` an event, then `next` to let it be read.
// `send(events)` pushes each and resolves once the reader has handled them all and asks for the next: the bridge reads
// one event at a time, so by then each one's work has ended.
function eventStream() {
  const queue = [];
  let wake = null;
  let drained = null;
  const iterable = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        drained?.();
        await new Promise((resolve) => { wake = resolve; });
      }
    },
  };
  const push = (event) => { queue.push(event); wake?.(); };
  const send = (events) => new Promise((resolve) => {
    drained = () => { drained = null; resolve(); };
    for (const event of events) push(event);
  });
  return { iterable, push, send };
}

test('no callback but execute.before ever rejects: a throw in any step of the context, prompt, compaction, idle, event, shell, or execute.after callback resolves', async (t) => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const route = { event: 'Stop', script: 'hook-x.mjs' };
  const applied = [];
  const good = { select: () => ({ routes: [route] }), call: () => ({ base: ROOT }), run: () => ({ exit: 2, stderr: 'back' }), apply: (event, verdict) => { applied.push(verdict.reason); }, trace: () => { throw new Error('trace'); } };
  const fails = { throws: (step) => () => { throw new Error(step); }, rejects: (step) => async () => { throw new Error(step); } };
  for (const hook of ['context', 'prompt', 'compaction', 'experimental.idle', 'execute.after']) {
    assert.equal(await transform(hook, good)({ sessionID: 's' }), undefined, hook);
    for (const step of ['select', 'call', 'run', 'apply']) {
      for (const [how, fail] of Object.entries(fails)) {
        assert.equal(await transform(hook, { ...good, [step]: fail(step) })({ sessionID: 's' }), undefined, `${hook}: ${step} ${how}`);
      }
    }
  }
  assert.deepEqual(applied, Array(5).fill(['back', null, null]).flat(), 'a callback whose steps all work applies its verdict, and a runner that fails is a script that gave no answer');
  // On execute.before a step that fails lets the call run, and a trace that fails keeps the refusal.
  const pre = { ...good, select: () => ({ routes: [{ event: 'PreToolUse', script: 'hook-x.mjs' }] }), run: () => ({ exit: 0, stdout: '' }) };
  for (const step of ['select', 'call', 'run', 'apply']) assert.equal(await transform('execute.before', { ...pre, [step]: fails.rejects(step) })({}), undefined, step);
  assert.equal(await transform('execute.before', { ...pre, apply: fails.throws('apply') })({}), undefined, 'apply throws');
  await assert.rejects(transform('execute.before', { ...pre, run: () => ({ exit: 2, stderr: 'no' }) })({}), { message: 'no' });
  assert.equal(await resolving(fails.throws('one'))(), undefined);

  // The bridge's own idle and event callbacks, on a context whose every session call fails.
  const throwing = () => { throw new Error('no'); };
  const contexts = [
    fakeContext({ messages: { ses_main: new Error('no context') }, synthetic: async () => { throw new Error('not admitted'); }, subscribe: throwing }),
    fakeContext({ synthetic: throwing, subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('stream'); } }) }) }),
    fakeContext({ sessions: { ses_main: new Error('read') }, subscribe: () => ({ async *[Symbol.asyncIterator]() { yield { get type() { throw new Error('event'); } }; } }) }),
  ];
  for (const context of contexts) {
    const spawn = fakeSpawn(writes({ status: 2, stderr: 'back' }));
    await stopBridge('idle-throws', { context, spawn });
    assert.equal(await context.hooks['experimental.idle']({ sessionID: 'ses_main', background: [] }), undefined);
    assert.equal(await context.hooks['experimental.idle']({ get sessionID() { throw new Error('id'); } }), undefined);
  }
  // The shell callback, on an event whose environment cannot be read.
  const { context } = await bridge({ bin: BIN });
  assert.equal(context.hooks['create.before']({ get env() { throw new Error('env'); } }), undefined);
  await settle();
  assert.deepEqual(unhandled, []);
});

test('lastAssistantText reads the last assistant message`s text parts, and null for none, a failed read, or one past its cap', async (t) => {
  const reply = (text) => ({ type: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }, { type: 'tool', name: 'shell' }, { type: 'text', text: 'end' }] });
  const context = fakeContext({ messages: { a: [reply('first'), { type: 'user', text: 'go' }, reply('last')], b: [{ type: 'user' }], c: new Error('no') } });
  assert.equal(await lastAssistantText(context, 'a'), 'last\n\nend');
  for (const id of ['b', 'c', 'none']) assert.equal(await lastAssistantText(context, id), null, id);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = fakeContext({ messages: { a: () => new Promise((resolve) => setTimeout(() => resolve([reply('late')]), 60_000)) } });
  const reading = lastAssistantText(slow, 'a');
  await settle();
  t.mock.timers.tick(READ_MS);
  assert.equal(await reading, null);
});

test('stop_hook_active: false on a turn`s first idle, true after a send-back the session admitted, dropped at the next idle and on session.deleted', async () => {
  const stream = eventStream();
  const context = fakeContext({ messages: { ses_main: [{ type: 'assistant', content: [{ type: 'text', text: 'Done.' }] }] }, subscribe: () => stream.iterable });
  // A stop hook that sends a turn back only on a stop no hook caused, as hook-stop.mjs does.
  const stopHook = () => fakeSpawn((child, call) => answers(child, sent(call).stop_hook_active ? { status: 0 } : { status: 2, stderr: 'go on' }));
  const { calls, idle } = await stopBridge('stop-state', { context, spawn: stopHook() });
  const active = () => calls.map((call) => sent(call).stop_hook_active);
  await idle('ses_main');
  await idle('ses_main');
  await idle('ses_main');
  assert.deepEqual(active(), [false, true, false], 'the idle after a send-back reads it, and drops it');
  assert.deepEqual(context.synthetics, [{ sessionID: 'ses_main', text: 'go on' }, { sessionID: 'ses_main', text: 'go on' }]);
  stream.push({ type: 'session.deleted', data: { sessionID: 'ses_main' } });
  await settle();
  await idle('ses_main');
  assert.equal(active().at(-1), false, 'a deleted session keeps no state');
  assert.deepEqual(sent(calls[0]), { hook_event_name: 'Stop', opencode: { background: [] }, session_id: 'ses_main', cwd: SESSION_DIR, stop_hook_active: false, last_assistant_message: 'Done.' });
  const running = [{ kind: 'shell', sessionID: 'ses_main', shellID: 'sh_1', command: 'sleep 9' }, { kind: 'subagent', sessionID: 'ses_main', childSessionID: 'ses_kid', agent: 'build', description: 'x' }];
  await idle('ses_main', running);
  assert.deepEqual(sent(calls.at(-1)).opencode, { background: running }, 'the idle hook`s background, as OpenCode gives it, under the mark');

  const refused = fakeContext({ synthetic: async () => { throw new Error('not admitted'); } });
  const unadmitted = await stopBridge('stop-unadmitted', { context: refused, spawn: stopHook() });
  await unadmitted.idle('ses_main');
  await unadmitted.idle('ses_main');
  assert.deepEqual(unadmitted.calls.map((call) => sent(call).stop_hook_active), [false, false], 'a send-back not admitted marks nothing');
  assert.equal(Object.hasOwn(sent(unadmitted.calls[0]), 'last_assistant_message'), false, 'no message read, no field');

  const trace = path.join(ROOT, 'trace-stop-child.jsonl');
  const child = await stopBridge('stop-child', { context: fakeContext({ sessions: { ses_child: { parentID: 'ses_main' } } }), spawn: stopHook(), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await child.idle('ses_child');
  assert.equal(child.calls.length, 0, 'a child session`s idle runs no Stop route');
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [{ step: 'setup', status: 1 }, { step: 'skip', script: 'hook-stop.mjs', status: 'subagent' }]);
  const unreadTrace = path.join(ROOT, 'trace-stop-unread.jsonl');
  const unread = await stopBridge('stop-unread', { context: fakeContext({ sessions: { ses_main: new Error('read failed') } }), spawn: stopHook(), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: unreadTrace } });
  await unread.idle('ses_main');
  assert.equal(unread.calls.length, 0, 'a root session whose read fails is read as a child: no Stop route');
  assert.deepEqual(traceLines(unreadTrace).map(({ at, ...rest }) => rest), [{ step: 'setup', status: 1 }, { step: 'skip', script: 'hook-stop.mjs', status: 'subagent' }]);
});

test('an idle whose last message announces work sends the session back with the announce check`s reason, and the idle after it sends nothing', { skip: process.platform === 'win32' }, async () => {
  const stalled = 'The decisions are settled.\n\nNext, OpenCode writes the plan file. Starting now unless the Human says otherwise.';
  const context = fakeContext({ sessions: { ses_main: { location: { directory: GUARDED } } }, messages: { ses_main: [{ type: 'assistant', content: [{ type: 'text', text: stalled }] }] } });
  const results = [];
  const spawn = fakeSpawn((child, call) => {
    hookCall(path.join(PLUGIN, 'scripts/hook-stop.mjs'), { input: call.stdin, cwd: call.options.cwd, env: call.options.env }).then((result) => {
      results.push(result);
      answers(child, result);
    });
  });
  const { calls, idle } = await stopBridge('stop-announce', { context, spawn, env: HOOK_ENV, scripts: path.join(PLUGIN, 'scripts') });
  await idle('ses_main');
  assert.equal(results[0].status, 2, results[0].stderr);
  assert.equal(context.synthetics.length, 1);
  assert.ok(context.synthetics[0].text.startsWith(ANNOUNCE_LEAD), context.synthetics[0].text);
  assert.deepEqual(context.synthetics[0], { sessionID: 'ses_main', text: results[0].stderr.trim() });
  await idle('ses_main');
  assert.deepEqual([sent(calls[1]).stop_hook_active, results[1].status, context.synthetics.length], [true, 0, 1]);
});

// The session start and the plugin's text: the bridge set up with the start routes of the generated list, on a fake
// spawn whose root start prints ROOT_LINES and whose `--subagent` start prints CHILD_LINES as SubagentStart JSON.
const CHILD_DIR = path.join(ROOT, 'child-folder');
mkdirSync(CHILD_DIR, { recursive: true });
const ROOT_LINES = 'Project knowledge: read docs/working-agreement.md now.';
const CHILD_LINES = 'Names: call the human "Adrian".';
const START_ROUTES = Object.freeze(GENERATED.filter((route) => route.event === 'SessionStart' || route.event === 'SubagentStart'));
const PROMPT_ROUTE = Object.freeze({ event: 'UserPromptSubmit', matcher: null, script: 'hook-prompt.mjs', args: [], timeoutMs: 5000 });
const COMPACT_ROUTE = Object.freeze({ event: 'PreCompact', matcher: null, script: 'hook-compact.mjs', args: [], timeoutMs: 5000 });
const startAnswer = (call) => (call.args.includes('--subagent')
  ? { status: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CHILD_LINES } }) }
  : { status: 0, stdout: `${ROOT_LINES}\n` });
const startSpawn = (other = () => ({ status: 0 })) => fakeSpawn((child, call) => answers(child, path.basename(call.args[0]) === 'hook-session-start.mjs' ? startAnswer(call) : other(call)));
const startPart = (text, kind = 'start') => ({ type: 'text', text, metadata: { aidrian: kind } });
const request = (sessionID) => ({ sessionID, system: [{ type: 'text', text: 'OpenCode' }], messages: [] });
const ran = (calls) => calls.map((call) => [path.basename(call.args[0]), ...call.args.slice(1)]);

async function startBridge(name, { context = fakeContext(), spawn = startSpawn(), routes = [], events = EVENTS, env = ENV, notices = [], ...seams } = {}) {
  const all = [...START_ROUTES, ...routes, bashRoute('hook-bash-post.mjs')];
  const scripts = scriptsFolder(`${name}-scripts`, [...new Set(all.map((route) => route.script))]);
  return bridge({ context, spawn, env, scripts, routes: routesFile(`${name}.json`, all), events, notices, ...seams });
}

test('the start runs once a root session, awaited before the first callback`s routes, and its lines reach every request as a system part', async () => {
  const stream = eventStream();
  const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: CHILD_DIR } } }, subscribe: () => stream.iterable });
  const { calls } = await startBridge('start-once', { context });
  assert.deepEqual(Object.keys(context.hooks), ['execute.after', 'create.before', 'context', 'compaction']);
  const first = request('ses_main');
  await context.hooks.context(first);
  assert.deepEqual(first.system, [{ type: 'text', text: 'OpenCode' }, startPart(ROOT_LINES)], 'after OpenCode`s own parts');
  assert.deepEqual(ran(calls), [['hook-session-start.mjs']]);
  assert.deepEqual(sent(calls[0]), { hook_event_name: 'SessionStart', opencode: {}, session_id: 'ses_main', cwd: SESSION_DIR });
  assert.equal(calls[0].options.cwd, SESSION_DIR, 'run in the root session`s own folder');
  const reads = context.reads.length;
  for (const hook of ['context', 'compaction']) {
    const again = request('ses_main');
    await context.hooks[hook](again);
    assert.deepEqual(again.system.at(-1), startPart(ROOT_LINES), hook);
  }
  await context.hooks['execute.after'](shellEvent({ sessionID: 'ses_main' }));
  assert.deepEqual(ran(calls), [['hook-session-start.mjs'], ['hook-bash-post.mjs']], 'no script per request, nor per call');
  assert.equal(context.reads.length, reads + 1, 'a started session is read again only by a tool call');

  // A child's first callback runs its own --subagent start in its own folder, before the call's route, and its
  // requests carry its own lines, not the root's.
  await context.hooks['execute.after'](shellEvent({ sessionID: 'ses_child' }));
  assert.deepEqual(ran(calls).slice(2), [['hook-session-start.mjs', '--subagent'], ['hook-bash-post.mjs']]);
  assert.deepEqual(sent(calls[2]), { hook_event_name: 'SubagentStart', opencode: {}, session_id: 'ses_main', agent_id: 'ses_child', cwd: CHILD_DIR });
  assert.equal(calls[2].options.cwd, CHILD_DIR);
  const child = request('ses_child');
  await context.hooks.context(child);
  assert.deepEqual(child.system.slice(1), [startPart(CHILD_LINES)]);
  assert.equal(calls.length, 4);

  // A deleted session drops its start: a session of that id would start again.
  stream.push({ type: 'session.deleted', data: { sessionID: 'ses_main' } });
  await settle();
  await context.hooks.context(request('ses_main'));
  assert.deepEqual(ran(calls).at(-1), ['hook-session-start.mjs']);
});

test('a child`s first callback runs its root`s start, then its own --subagent start, and two callbacks at once run each once', async () => {
  const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: CHILD_DIR } } } });
  const { calls } = await startBridge('start-child-first', { context });
  const requests = [request('ses_child'), request('ses_child'), request('ses_main')];
  await Promise.all(requests.map((each) => context.hooks.context(each)));
  assert.deepEqual(ran(calls), [['hook-session-start.mjs'], ['hook-session-start.mjs', '--subagent']], 'the root`s first, once each');
  assert.deepEqual(calls.map((call) => call.options.cwd), [SESSION_DIR, CHILD_DIR], 'the root`s in the root`s own folder');
  assert.deepEqual(requests.map((each) => each.system.slice(1)), [[startPart(CHILD_LINES)], [startPart(CHILD_LINES)], [startPart(ROOT_LINES)]]);
});

test('a start that fails is traced and never repeated; a read that fails runs nothing and is read again; a folder not on disk runs nothing', async () => {
  const trace = path.join(ROOT, 'trace-start-fails.jsonl');
  let readFails = true;
  const later = path.join(ROOT, 'start-later-folder');
  const sessions = {
    ses_flaky: () => (readFails ? new Error('read') : { location: { directory: SESSION_DIR } }), ses_gone: { location: { directory: later } },
    ses_kid: { parentID: 'ses_flaky', location: { directory: CHILD_DIR } },
  };
  const context = fakeContext({ sessions });
  const spawn = fakeSpawn(writes({ status: 1, stderr: 'boom' }));
  const { calls } = await startBridge('start-fails', { context, spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  for (let at = 0; at < 2; at += 1) {
    const each = request('ses_main');
    await context.hooks.context(each);
    assert.equal(each.system.length, 1, 'no lines from a failed start');
  }
  assert.equal(calls.length, 1, 'a failed start is not repeated');
  await context.hooks.context(request('ses_flaky'));
  assert.equal(calls.length, 1, 'a failed read runs nothing');
  readFails = false;
  await context.hooks.context(request('ses_flaky'));
  assert.deepEqual(calls.map((call) => sent(call).session_id), ['ses_main', 'ses_flaky'], 'and the next callback reads again');
  await context.hooks.context(request('ses_gone'));
  assert.equal(calls.length, 2, 'never in another folder');
  mkdirSync(later);
  await context.hooks.context(request('ses_gone'));
  await context.hooks.context(request('ses_gone'));
  assert.deepEqual(calls.slice(2).map((call) => call.options.cwd), [later], 'a folder not on disk was no run, so the start runs once it is there');
  assert.deepEqual(traceLines(trace).map(({ step, script, status }) => [step, script, status]), [
    ['setup', undefined, 3], ['run', 'hook-session-start.mjs', 1], ['skip', 'hook-session-start.mjs', 'read'],
    ['run', 'hook-session-start.mjs', 1], ['skip', 'hook-session-start.mjs', 'cwd'], ['run', 'hook-session-start.mjs', 1],
  ]);

  // A child whose walk fails at its root's read: the root's start is not given up for good.
  readFails = false;
  const kept = fakeContext({ sessions });
  const kid = await startBridge('start-kept-child', { context: kept });
  const rootReads = kept.session.get;
  let reads = 0;
  kept.session.get = async (input) => {
    if (input.sessionID === 'ses_flaky') reads += 1;
    if (input.sessionID === 'ses_flaky' && reads === 1) throw new Error('read');
    return rootReads(input);
  };
  await kept.hooks.context(request('ses_kid'));
  assert.equal(kid.calls.length, 0, 'the root was not read');
  await kept.hooks.context(request('ses_kid'));
  assert.deepEqual(ran(kid.calls), [['hook-session-start.mjs'], ['hook-session-start.mjs', '--subagent']]);
});

test('a walk that stops short of the root starts nothing, under no session of it, and the next callback reads again', async () => {
  const chain = Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`ses_${n}`, { parentID: `ses_${n + 1}`, location: { directory: SESSION_DIR } }]));
  let given = asGiven({});
  const cases = [
    ['out-of-steps', chain, 'ses_0', null],
    ['mid-walk', { ses_kid: { parentID: 'ses_mid', location: { directory: CHILD_DIR } }, ses_mid: () => given }, 'ses_kid', () => { given = { parentID: 'ses_main', location: { directory: SESSION_DIR } }; }],
  ];
  for (const [name, sessions, sessionID, heal] of cases) {
    const trace = path.join(ROOT, `trace-start-${name}.jsonl`);
    const { context, calls } = await startBridge(`start-${name}`, { context: fakeContext({ sessions }), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    for (let at = 0; at < 2; at += 1) {
      const each = request(sessionID);
      await context.hooks.context(each);
      assert.equal(each.system.length, 1, name);
    }
    assert.equal(calls.length, 0, `${name}: no start under a session that is not known to be the root`);
    assert.deepEqual(traceLines(trace).slice(1).map(({ script, status }) => [script, status]), Array(2).fill(['hook-session-start.mjs', 'read']), name);
    if (!heal) continue;
    heal();
    await context.hooks.context(request(sessionID));
    assert.deepEqual(calls.map((call) => sent(call).session_id), ['ses_main', 'ses_main'], 'the root`s start, then the child`s, once the walk ends');
  }
});

test('a child whose own folder is not on disk starts nothing of its own, and a started root whose folder is gone holds back no child', async () => {
  const rootDir = path.join(ROOT, 'start-left-folder');
  mkdirSync(rootDir);
  const child = (directory) => ({ parentID: 'ses_main', location: { directory } });
  const sessions = { ses_main: { location: { directory: rootDir } }, ses_lost: child(path.join(ROOT, 'no-such-folder')), ses_later: child(CHILD_DIR) };
  const context = fakeContext({ sessions });
  const { calls } = await startBridge('start-child-folder', { context });
  await context.hooks.context(request('ses_lost'));
  assert.deepEqual(ran(calls), [['hook-session-start.mjs']], 'the root`s start alone');
  rmSync(rootDir, { recursive: true });
  await context.hooks.context(request('ses_later'));
  assert.deepEqual(ran(calls).slice(1), [['hook-session-start.mjs', '--subagent']]);
  assert.equal(calls[1].options.cwd, CHILD_DIR);
});

test('the idle hook and the hook before a tool call each run the session`s start before their routes', async () => {
  const blocking = await startBridge('start-before', { routes: [preRoute()], events: { ...EVENTS, ...BLOCKING } });
  await blocking.context.hooks['execute.before'](beforeEvent());
  assert.deepEqual(ran(blocking.calls), [['hook-session-start.mjs'], ['hook-bash.mjs']]);
  const stopping = await startBridge('start-idle', { routes: [STOP_ROUTE], events: { ...EVENTS, Stop: 'experimental.idle' } });
  await stopping.context.hooks['experimental.idle']({ sessionID: 'ses_main', background: [] });
  assert.deepEqual(ran(stopping.calls), [['hook-session-start.mjs'], ['hook-stop.mjs']]);
});

test('a start script gets the PATH a shell gets, bin first, and no other script or variable changes', async () => {
  const spawn = startSpawn();
  const { context, calls } = await startBridge('start-path', { spawn, bin: BIN });
  await context.hooks['execute.after'](shellEvent());
  const shell = { env: { ...ENV } };
  context.hooks['create.before'](shell);
  assert.deepEqual(calls.map((call) => call.options.env), [shell.env, ENV], 'the start`s is the shell hook`s, the after-hook`s the service`s own');
  assert.equal(shell.env.PATH, `${BIN}${path.delimiter}${ENV.PATH}`);
  const { PATH, ...bare } = ENV;
  const none = await startBridge('start-no-path', { env: bare, bin: BIN });
  await none.context.hooks.context(request('ses_main'));
  assert.deepEqual(none.calls[0].options.env, bare, 'a service with no PATH gives none');
});

test('the prompt hook`s context goes into the prompt as its own file part marked as aidrian`s, never the Human`s text nor a system part', async () => {
  const names = 'Names: the last reply said "I".';
  const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: CHILD_DIR } } } });
  const spawn = startSpawn((call) => (path.basename(call.args[0]) === 'hook-prompt.mjs' ? { status: 0, stdout: `${names}\n` } : { status: 0 }));
  const { calls } = await startBridge('prompt-part', { context, spawn, routes: [PROMPT_ROUTE], events: { ...EVENTS, UserPromptSubmit: 'prompt' } });
  const attached = { uri: 'file:///notes.md', name: 'notes.md' };
  const event = { sessionID: 'ses_main', messageID: 'msg_1', prompt: { text: 'go on', files: [attached] }, delivery: 'steer' };
  await context.hooks.prompt(event);
  assert.deepEqual(ran(calls), [['hook-session-start.mjs'], ['hook-prompt.mjs']], 'the start first');
  assert.deepEqual(sent(calls[1]), { hook_event_name: 'UserPromptSubmit', opencode: {}, session_id: 'ses_main', cwd: SESSION_DIR, prompt: 'go on' });
  assert.equal(event.prompt.text, 'go on', 'the Human`s text part stays as it was');
  const part = { uri: `data:text/plain;base64,${Buffer.from(names).toString('base64')}`, source: { type: 'inline' }, name: 'aidrian', description: 'aidrian hook context' };
  assert.deepEqual(event.prompt.files, [attached, part]);
  const next = request('ses_main');
  await context.hooks.context(next);
  assert.ok(next.system.every((each) => !each.text.includes(names)), 'no text that quotes a reply in system');

  const child = { sessionID: 'ses_child', messageID: 'msg_2', prompt: { text: 'task' }, delivery: 'steer' };
  await context.hooks.prompt(child);
  assert.deepEqual(sent(calls.at(-1)), { hook_event_name: 'UserPromptSubmit', opencode: {}, session_id: 'ses_main', agent_id: 'ses_child', cwd: SESSION_DIR, prompt: 'task' }, 'a child`s prompt runs in its root`s folder');
  assert.deepEqual(child.prompt.files, [part], 'a prompt with no files gets a list of one');

  const blocked = await startBridge('prompt-block', { spawn: startSpawn(() => ({ status: 2, stderr: 'no' })), routes: [PROMPT_ROUTE], events: { ...EVENTS, UserPromptSubmit: 'prompt' } });
  const refused = { sessionID: 'ses_main', messageID: 'msg_3', prompt: { text: 'x' }, delivery: 'steer' };
  assert.equal(await blocked.context.hooks.prompt(refused), undefined);
  assert.deepEqual(refused.prompt, { text: 'x' }, 'a block OpenCode cannot apply adds nothing');
});

test('the compaction request gets the start lines, then the checklist, as system parts, from a route run in the root`s folder', async () => {
  const checklist = 'Preserve everything needed to continue the current task.';
  const context = fakeContext({ sessions: { ses_child: { parentID: 'ses_main', location: { directory: CHILD_DIR } } } });
  const spawn = startSpawn((call) => (path.basename(call.args[0]) === 'hook-compact.mjs' ? { status: 0, stdout: `${checklist}\n` } : { status: 0 }));
  const { calls } = await startBridge('compaction', { context, spawn, routes: [COMPACT_ROUTE], events: { ...EVENTS, PreCompact: 'compaction' } });
  const event = request('ses_child');
  await context.hooks.compaction(event);
  assert.deepEqual(ran(calls), [['hook-session-start.mjs'], ['hook-session-start.mjs', '--subagent'], ['hook-compact.mjs']]);
  assert.deepEqual(sent(calls[2]), { hook_event_name: 'PreCompact', opencode: {}, session_id: 'ses_main', agent_id: 'ses_child', cwd: SESSION_DIR });
  assert.deepEqual(event.system.slice(1), [startPart(CHILD_LINES), startPart(checklist, 'compaction')]);
  assert.deepEqual(event.messages, [], 'the conversation stays as it was');
});

test('the context, prompt, and compaction callbacks resolve whatever fails: a read, a spawn, an event that cannot be read', async (t) => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const throwing = () => { throw new Error('spawn'); };
  const cases = [{ context: fakeContext({ sessions: { ses_main: new Error('read') } }) }, { spawn: { spawn: throwing, calls: [] } }, {}];
  for (const [at, seams] of cases.entries()) {
    const { context } = await startBridge(`start-throws-${at}`, { ...seams, routes: [COMPACT_ROUTE, PROMPT_ROUTE], events: { ...EVENTS, PreCompact: 'compaction', UserPromptSubmit: 'prompt' } });
    for (const hook of ['context', 'prompt', 'compaction']) {
      assert.equal(await context.hooks[hook]({ ...request('ses_main'), prompt: { text: 'x' } }), undefined, hook);
      assert.equal(await context.hooks[hook]({ sessionID: 'ses_main', get system() { throw new Error('system'); }, get prompt() { throw new Error('prompt'); } }), undefined, hook);
      assert.equal(await context.hooks[hook]({ get sessionID() { throw new Error('id'); } }), undefined, hook);
      assert.equal(await context.hooks[hook](null), undefined, hook);
    }
  }
  await settle();
  assert.deepEqual(unhandled, []);
});

test('a root session whose own folder is not on disk runs no Stop route, never one in the plugin`s folder', async () => {
  const trace = path.join(ROOT, 'trace-stop-gone.jsonl');
  const context = fakeContext({ sessions: { ses_main: { location: { directory: path.join(ROOT, 'no-such-folder') } } } });
  const { calls, idle } = await stopBridge('stop-gone', { context, spawn: fakeSpawn(), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await idle('ses_main');
  assert.equal(calls.length, 0);
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest).at(-1), { step: 'skip', script: 'hook-stop.mjs', status: 'cwd' });
});

// SessionEnd on a session's `session.deleted` event: the generated route, through EVENTS, with hook-session-end.mjs run
// in this process on what the bridge sends, in a state folder of its own.
const END_ROUTE = Object.freeze(GENERATED.find((route) => route.event === 'SessionEnd'));
const SESSION_END = path.join(PLUGIN, 'scripts/hook-session-end.mjs');
const END_ENV = Object.freeze({ ...ENV, XDG_STATE_HOME: path.join(ROOT, 'end-state') });
// What hook-session-end.mjs deletes of a session's that a child's end must leave: its gate snapshot, the `.gated` mark
// beside it, and its tracker record.
const endFiles = (sessionID) => {
  const file = snapshotPath(sessionID, { env: END_ENV });
  return [file, file.replace(/\.json$/u, '.gated'), file.replace(/\.json$/u, '.tracker.json')];
};
const writeEndFiles = (sessionID) => {
  for (const file of endFiles(sessionID)) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
  }
};
const present = (sessionID) => endFiles(sessionID).map((file) => existsSync(file));
const ends = (calls) => calls.filter((call) => path.basename(call.args[0]) === 'hook-session-end.mjs');

// The bridge with the SessionEnd route and a record-only shell route, whose calls make the bridge read each session:
// `stream.send` delivers OpenCode events, and `fire` an execute.after event.
async function endBridge(name, { sessions, trace }) {
  const stream = eventStream();
  const context = fakeContext({ sessions, subscribe: () => stream.iterable });
  const spawn = fakeSpawn((child, call) => {
    if (path.basename(call.args[0]) !== 'hook-session-end.mjs') return closes()(child);
    hookCall(SESSION_END, { input: call.stdin, cwd: call.options.cwd, env: call.options.env }).then((result) => answers(child, result));
  });
  const routes = [END_ROUTE, bashRoute('hook-bash-post.mjs')];
  const scripts = scriptsFolder(`${name}-scripts`, routes.map((route) => route.script));
  const events = { PostToolUse: EVENTS.PostToolUse, SessionEnd: EVENTS.SessionEnd };
  const made = await bridge({ context, spawn, env: { ...END_ENV, ...(trace ? { AIDRIAN_OPENCODE_TRACE: trace } : {}) }, scripts, routes: routesFile(`${name}.json`, routes), events });
  return { ...made, stream };
}

const ROOT_AND_CHILD = Object.freeze({ ses_end: { location: { directory: PROJECT_DIR } }, ses_kid: { parentID: 'ses_end', location: { directory: CHILD_DIR } } });

test('deleting or archiving a child session runs no SessionEnd: the root`s gate snapshot, .gated mark, and tracker record stay', { timeout: 10_000 }, async () => {
  const trace = path.join(ROOT, 'trace-end-child.jsonl');
  const { calls, fire, stream } = await endBridge('end-child', { sessions: ROOT_AND_CHILD, trace });
  await fire(shellEvent({ sessionID: 'ses_end' }));
  await fire(shellEvent({ sessionID: 'ses_kid' }));
  writeEndFiles('ses_end');
  await stream.send([{ type: 'session.archived', data: { sessionID: 'ses_kid' } }, { type: 'session.deleted', data: { sessionID: 'ses_kid' } }]);
  assert.deepEqual(ends(calls), [], 'a child`s end sends nothing, though its payload would carry its root`s id');
  assert.deepEqual(present('ses_end'), [true, true, true]);
  // A session the bridge never read cannot be told a root: it runs nothing either.
  await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_never_read' } }]);
  assert.deepEqual(ends(calls), []);
  assert.deepEqual(traceLines(trace).filter((line) => line.script === 'hook-session-end.mjs').map(({ step, status }) => [step, status]), [['skip', 'subagent'], ['skip', 'read']]);
});

test('archiving then unarchiving a root runs no SessionEnd and leaves all three; its delete then runs it once, in its folder, and they go', { timeout: 10_000 }, async () => {
  const { calls, fire, stream } = await endBridge('end-root', { sessions: ROOT_AND_CHILD });
  await fire(shellEvent({ sessionID: 'ses_end' }));
  writeEndFiles('ses_end');
  await stream.send([{ type: 'session.archived', data: { sessionID: 'ses_end' } }, { type: 'session.unarchived', data: { sessionID: 'ses_end' } }]);
  assert.deepEqual([ends(calls), present('ses_end')], [[], [true, true, true]]);
  await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
  const [end] = ends(calls);
  assert.deepEqual(sent(end), { hook_event_name: 'SessionEnd', opencode: {}, session_id: 'ses_end', cwd: PROJECT_DIR });
  assert.equal(end.options.cwd, PROJECT_DIR, 'run in the root`s last known folder');
  assert.deepEqual(present('ses_end'), [false, false, false], 'hook-session-end.mjs deleted them');
  // The root is forgotten once it ended, so a second delete of the id, as a replayed event, runs nothing.
  await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
  assert.equal(ends(calls).length, 1);
});

test('a root whose last known folder is gone runs no SessionEnd, never in the plugin`s folder', { timeout: 10_000 }, async () => {
  const gone = path.join(ROOT, 'end-gone-folder');
  mkdirSync(gone);
  const trace = path.join(ROOT, 'trace-end-gone.jsonl');
  const { calls, fire, stream } = await endBridge('end-gone', { sessions: { ses_end: { location: { directory: gone } } }, trace });
  await fire(shellEvent({ sessionID: 'ses_end' }));
  rmSync(gone, { recursive: true });
  await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
  assert.deepEqual(ends(calls), []);
  assert.deepEqual(traceLines(trace).at(-1), { at: traceLines(trace).at(-1).at, step: 'skip', script: 'hook-session-end.mjs', status: 'cwd' });
});

test('a root whose child alone made a call ends in its own folder', { timeout: 10_000 }, async () => {
  const firsts = {
    start: [EVENTS, (context) => context.hooks.context(request('ses_kid'))],
    'tool-call': [{ PostToolUse: EVENTS.PostToolUse, SessionEnd: EVENTS.SessionEnd }, (context) => context.hooks['execute.after'](shellEvent({ sessionID: 'ses_kid' }))],
  };
  for (const [name, [events, first]] of Object.entries(firsts)) {
    const stream = eventStream();
    const context = fakeContext({ sessions: ROOT_AND_CHILD, subscribe: () => stream.iterable });
    const { calls } = await startBridge(`end-child-first-${name}`, { context, routes: [END_ROUTE], events });
    await first(context);
    await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
    assert.deepEqual(ends(calls).map((call) => [call.options.cwd, sent(call)]), [[PROJECT_DIR, { hook_event_name: 'SessionEnd', opencode: {}, session_id: 'ses_end', cwd: PROJECT_DIR }]], name);
  }
});

test('a root`s end waits for its start to end', { timeout: 10_000 }, async () => {
  let release = null;
  const spawn = fakeSpawn((child, call) => {
    if (path.basename(call.args[0]) === 'hook-session-start.mjs') release = () => answers(child, startAnswer(call));
    else answers(child, { status: 0 });
  });
  const stream = eventStream();
  const context = fakeContext({ sessions: ROOT_AND_CHILD, subscribe: () => stream.iterable });
  const { calls } = await startBridge('end-after-start', { context, spawn, routes: [END_ROUTE] });
  const starting = context.hooks.context(request('ses_end'));
  while (release === null) await settle();
  const ended = stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
  for (let turn = 0; turn < 10; turn += 1) await settle();
  assert.deepEqual(ends(calls), [], 'its start still runs');
  release();
  await Promise.all([starting, ended]);
  assert.deepEqual(ran(calls), [['hook-session-start.mjs'], ['hook-session-end.mjs']]);
});

test('a root that moved ends in the last folder a read gave, on its own call or on a child`s first or later callback', { timeout: 10_000 }, async () => {
  const prompt = (context) => context.hooks.prompt({ sessionID: 'ses_kid', messageID: 'msg_1', prompt: { text: 'x' }, delivery: 'steer' });
  const readers = {
    'own-call': [() => {}, (context) => context.hooks['execute.after'](shellEvent({ sessionID: 'ses_end' }))],
    'child-start': [() => {}, (context) => context.hooks.context(request('ses_kid'))],
    'child-prompt': [prompt, prompt],
  };
  for (const [name, [before, read]] of Object.entries(readers)) {
    let directory = PROJECT_DIR;
    const stream = eventStream();
    const context = fakeContext({ sessions: { ...ROOT_AND_CHILD, ses_end: () => ({ location: { directory } }) }, subscribe: () => stream.iterable });
    const events = { ...EVENTS, UserPromptSubmit: 'prompt' };
    const { calls, fire } = await startBridge(`end-moved-${name}`, { context, routes: [END_ROUTE, PROMPT_ROUTE], events });
    await fire(shellEvent({ sessionID: 'ses_end' }));
    await before(context);
    directory = SESSION_DIR;
    await read(context);
    await stream.send([{ type: 'session.deleted', data: { sessionID: 'ses_end' } }]);
    assert.deepEqual(ends(calls).map((call) => [call.options.cwd, sent(call).cwd]), [[SESSION_DIR, SESSION_DIR]], name);
  }
});

test('the bridge listens for a session`s end once, with a start and a Stop route both routed', async () => {
  let subscribed = 0;
  const context = fakeContext({ subscribe: () => { subscribed += 1; return eventStream().iterable; } });
  await startBridge('listen-once', { context, routes: [STOP_ROUTE], events: { ...EVENTS, Stop: 'experimental.idle' } });
  assert.equal(subscribed, 1);
});

test('a session no session.created announced has its gate snapshot before its first tool call`s routes run', async () => {
  const file = snapshotPath('ses_main', { env: END_ENV });
  rmSync(file, { force: true });
  const seen = [];
  // The start writes the snapshot a turn after its spawn and only then answers, as hook-session-start.mjs saves it
  // before it prints; the before-route's spawn notes whether the snapshot is there.
  const spawn = fakeSpawn((child, call) => {
    if (path.basename(call.args[0]) === 'hook-session-start.mjs') {
      setImmediate(() => {
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, '{}\n');
        answers(child, startAnswer(call));
      });
      return;
    }
    seen.push(existsSync(file));
    answers(child, { status: 0 });
  });
  const { context } = await startBridge('start-snapshot', { spawn, routes: [preRoute()], events: { ...EVENTS, ...BLOCKING } });
  await context.hooks['execute.before'](beforeEvent());
  assert.deepEqual(seen, [true]);
});
