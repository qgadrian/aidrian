// The OpenCode bridge (plugins/aidrian/opencode/): on a fake OpenCode context and a fake spawn, what each tool event
// sends a hook script, how the spawn is pinned, and that no failure reaches OpenCode; then, with the real spawn and this
// Node, a completed `gh pr create` filed in the session ledger, and a call in a removed folder that leaves spawning on;
// that the routes it picks from the generated list by the leaf's standard name are the ones hooks.json fires on the
// name the adapter reads; and that docs/providers/opencode.md and the README say what runs on OpenCode and that no
// guard holds a session there.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';
import { infoRead, RAW_NAMES, STANDARD_NAMES, standardToolName } from '../plugins/aidrian/lib/hosts/opencode-names.mjs';
import { sectionLines } from '../plugins/aidrian/lib/markdown-sections.mjs';
import { setup } from '../plugins/aidrian/opencode/bridge.mjs';
import { selectRoutes } from '../plugins/aidrian/opencode/route-select.mjs';
import { EVENTS } from '../plugins/aidrian/opencode/routes.mjs';
import server from '../plugins/aidrian/opencode/server.mjs';


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

// A fake spawn that records each call { program, args, options, stdin, killed, child } and returns a child that `behave`
// drives.
function fakeSpawn(behave = closes()) {
  const calls = [];
  const spawn = (program, args, options) => {
    const call = { program, args, options, stdin: '', killed: [] };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: (text) => { call.stdin += text; behave(child, call); } });
    child.kill = (signal) => call.killed.push(signal);
    call.child = child;
    return child;
  };
  return { spawn, calls };
}

// A fake OpenCode context: `sessions` maps an id to what session.get gives, to an Error it throws, or to a function
// whose result it gives on each read; `app` is 2.4.0's { name, version, channel }; `reads` lists the ids it was asked
// for, and `hooks` each registration by its name.
function fakeContext({ sessions = {}, app, location = { directory: OWN_DIR }, toolHook, shellHook } = {}) {
  const hooks = {};
  const reads = [];
  const keep = (name, callback) => { hooks[name] = callback; };
  return {
    ...(app === undefined ? {} : { app }),
    location,
    tool: { hook: toolHook ?? keep },
    shell: { hook: shellHook ?? keep },
    session: {
      get: async ({ sessionID }) => {
        reads.push(sessionID);
        const entry = sessions[sessionID];
        const session = typeof entry === 'function' ? await entry() : entry;
        if (session instanceof Error) throw session;
        return session ?? { location: { directory: SESSION_DIR } };
      },
    },
    hooks,
    reads,
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

// The bridge set up on a fake context and spawn: `fire(event)` runs its execute.after callback.
async function bridge({ context = fakeContext(), spawn = fakeSpawn(), env = ENV, ...seams } = {}) {
  assert.equal(await setup(context, { spawn: spawn.spawn, env, node: '/opt/node22/bin/node', ...seams }), undefined);
  const fire = (event) => context.hooks['execute.after'](event);
  return { context, calls: spawn.calls, fire };
}

const sent = (call) => JSON.parse(call.stdin);
const APP = Object.freeze({ name: 'opencode', version: '2.4.0', channel: 'latest' });
const ENOENT = () => Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
const traceLines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);

test('EVENTS is PostToolUse on execute.after alone, frozen: no guard runs on OpenCode yet', () => {
  assert.deepEqual(EVENTS, { PostToolUse: 'execute.after' });
  assert.ok(Object.isFrozen(EVENTS));
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
  await fire(shellEvent({ tool: 'read', input: { filePath: '/x' } }));
  await fire(shellEvent({ tool: 'edit', input: { path: 'a.md' } }));
  assert.equal(calls.length, 0);
  assert.deepEqual(traceLines(trace).map(({ at, ...rest }) => rest), [
    { step: 'setup', status: 1 }, { step: 'skip', status: 'unguarded', count: 1 }, { step: 'skip', status: 'unguarded', count: 2 },
  ], 'edit has a name, and no PostToolUse route fires on it');
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

test('the session reads end at the longest selected route`s timeout, and each script then has its own from its spawn', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scripts = scriptsFolder('deadline-scripts', ['hook-one.mjs', 'hook-three.mjs']);
  const routes = routesFile('deadline.json', [bashRoute('hook-one.mjs', { timeoutMs: 1000 }), bashRoute('hook-three.mjs', { timeoutMs: 3000 })]);
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({}), 2500));
  const context = fakeContext({ sessions: { ses_slow: slow } });
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ context, spawn, scripts, routes });
  const running = fire(shellEvent({ sessionID: 'ses_slow' }));
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(2500);
  while (spawn.calls.length < 2) await settle();
  t.mock.timers.tick(999);
  await settle();
  assert.deepEqual(spawn.calls.map((call) => call.killed), [[], []], 'reads past the shorter timeout still spawn both');
  t.mock.timers.tick(2001);
  await running;
  assert.deepEqual(spawn.calls.map((call) => call.killed), [['SIGKILL'], ['SIGKILL']]);
});

test('a route list that is missing, no JSON, or no list registers no tool hook, keeps the PATH hook, and is traced', async () => {
  const cases = { missing: path.join(ROOT, 'no-routes.json'), garbage: routesFile('garbage.json', '{ not json'), object: routesFile('object.json', { PostToolUse: [] }) };
  for (const [name, routes] of Object.entries(cases)) {
    const trace = path.join(ROOT, `trace-routes-${name}.jsonl`);
    const context = fakeContext();
    assert.equal(await setup(context, { spawn: fakeSpawn().spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace }, routes }), undefined, name);
    assert.deepEqual(Object.keys(context.hooks), ['create.before'], name);
    assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['skip', 'routes'], ['setup', 0]], name);
  }
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
  await fire(shellEvent({ tool: 'edit' }));
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
  assert.equal(call.options.cwd, dir);
  assert.equal(call.options.env, env);
  assert.deepEqual(call.options.env, given, 'no key added to the environment');
  assert.deepEqual(call.options.stdio, ['pipe', 'ignore', 'ignore']);
  assert.ok(call.stdin.includes(JSON.stringify(nasty).slice(1, -1)));
  assert.equal(sent(call).tool_input.command, `gh pr create --title ${nasty}`);
  for (const value of [...call.args, ...Object.values(call.options.env)]) assert.ok(!value.includes('rm -rf') && !value.includes('whoami'), value);
});

test('the node program is AIDRIAN_NODE when it is an absolute path, else node', async () => {
  const cases = [
    [{ ...ENV, AIDRIAN_NODE: '/opt/n/bin/node' }, '/opt/n/bin/node'],
    [ENV, 'node'],
    [{ ...ENV, AIDRIAN_NODE: 'bin/node' }, 'node'],
    [{ ...ENV, AIDRIAN_NODE: './node' }, 'node'],
    [{ ...ENV, AIDRIAN_NODE: '' }, 'node'],
  ];
  for (const [env, program] of cases) {
    const spawn = fakeSpawn();
    const context = fakeContext();
    await setup(context, { spawn: spawn.spawn, env });
    await context.hooks['execute.after'](shellEvent());
    assert.equal(spawn.calls[0].program, program);
  }
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

test('cwd: an absolute workdir; with none, the session`s folder, or the plugin`s own when that read fails; a relative workdir sends nothing', async () => {
  const cwdOf = async (event, contextOptions = {}) => {
    const { calls, fire } = await bridge({ context: fakeContext(contextOptions) });
    await fire(event);
    return calls.map((call) => [call.options.cwd, sent(call).cwd]);
  };
  assert.deepEqual(await cwdOf(shellEvent()), [[PROJECT_DIR, PROJECT_DIR]]);
  assert.deepEqual(await cwdOf(shellEvent({ input: { command: 'gh pr create' } })), [[SESSION_DIR, SESSION_DIR]]);
  assert.deepEqual(await cwdOf(shellEvent({ input: { command: 'gh pr create' } }), { sessions: { ses_root: new Error('gone') } }), [[OWN_DIR, OWN_DIR]]);
  for (const workdir of ['work', './work', 'box:/srv/work', '']) assert.deepEqual(await cwdOf(shellEvent({ input: { command: 'gh pr create', workdir } })), [], workdir);
});

test('a child session`s call carries the root as session_id and itself as agent_id; a failed read gives the calling id', async () => {
  const sessions = { ses_grandchild: { parentID: 'ses_child' }, ses_child: { parentID: 'ses_root' }, ses_root: {} };
  const context = fakeContext({ sessions });
  const { calls, fire } = await bridge({ context });
  await fire(shellEvent({ sessionID: 'ses_grandchild' }));
  assert.deepEqual([sent(calls[0]).session_id, sent(calls[0]).agent_id], ['ses_root', 'ses_grandchild']);
  const reads = context.reads.length;
  await fire(shellEvent({ sessionID: 'ses_grandchild' }));
  assert.equal(context.reads.length, reads, 'the root of a session is read once');
  await fire(shellEvent({ sessionID: 'ses_root' }));
  assert.equal(Object.hasOwn(sent(calls[2]), 'agent_id'), false);

  const failing = await bridge({ context: fakeContext({ sessions: { ses_sub: { parentID: 'ses_top' }, ses_top: new Error('read failed') } }) });
  await failing.fire(shellEvent({ sessionID: 'ses_sub' }));
  assert.equal(sent(failing.calls[0]).session_id, 'ses_sub');
  assert.equal(Object.hasOwn(sent(failing.calls[0]), 'agent_id'), false);
});

test('the root cache forgets every answer once it holds 256, so the 257th session`s call makes the first read again', async () => {
  const sessions = { ses_top: {} };
  for (let n = 0; n <= 256; n += 1) sessions[`ses_kid${n}`] = { parentID: 'ses_top' };
  const context = fakeContext({ sessions });
  const { calls, fire } = await bridge({ context });
  for (let n = 0; n < 256; n += 1) await fire(shellEvent({ sessionID: `ses_kid${n}` }));
  const reads = context.reads.length;
  await fire(shellEvent({ sessionID: 'ses_kid0' }));
  assert.equal(context.reads.length, reads, 'with 256 answers kept, the first is still known');
  await fire(shellEvent({ sessionID: 'ses_kid256' }));
  const cleared = context.reads.length;
  await fire(shellEvent({ sessionID: 'ses_kid0' }));
  assert.deepEqual(context.reads.slice(cleared), ['ses_kid0', 'ses_top'], 'its chain is read again');
  assert.deepEqual([sent(calls.at(-1)).session_id, sent(calls.at(-1)).agent_id], ['ses_top', 'ses_kid0']);
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
  assert.deepEqual(calls.map((call) => [sent(call).session_id, sent(call).agent_id ?? null]), [['ses_sub', null], ['ses_top', 'ses_sub']]);
});

test('session reads that never settle end at the route`s timeout, and the call that outlasted it sends nothing', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const trace = path.join(ROOT, 'trace-stalled.jsonl');
  const stalled = () => new Promise(() => {});
  const context = fakeContext({ sessions: { ses_child: stalled } });
  const { calls, fire } = await bridge({ context, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  const event = shellEvent({ sessionID: 'ses_child', input: { command: 'gh pr create' } });
  const before = structuredClone(event.result);
  let resolved = false;
  const running = fire(event).then(() => { resolved = true; });
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual([resolved, calls.length], [false, 0]);
  t.mock.timers.tick(1);
  await running;
  assert.equal(calls.length, 0, 'no script runs after the deadline');
  assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['setup', 1], ['skip', 'timeout']]);
  assert.deepEqual(event.result, before);
});

test('the reads have the route`s timeout, and the script its own from its spawn: reads of 3000 ms leave the child 5000 ms', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const slow = () => new Promise((resolve) => setTimeout(() => resolve({}), 3000));
  const context = fakeContext({ sessions: { ses_slow: slow } });
  const spawn = fakeSpawn(() => {});
  const { fire } = await bridge({ context, spawn });
  let resolved = false;
  const running = fire(shellEvent({ sessionID: 'ses_slow' })).then(() => { resolved = true; });
  while (context.reads.length === 0) await settle();
  t.mock.timers.tick(3000);
  while (spawn.calls.length === 0) await settle();
  t.mock.timers.tick(4999);
  await settle();
  assert.deepEqual([resolved, spawn.calls[0].killed], [false, []], 'not killed at 4999 ms after its spawn');
  t.mock.timers.tick(1);
  await running;
  assert.deepEqual(spawn.calls[0].killed, ['SIGKILL'], 'killed at 5000 ms after its spawn');
});

test('the parent walk stops at 8 reads, on a chain longer than that and on a cycle', async () => {
  const chain = Object.fromEntries(Array.from({ length: 20 }, (_, n) => [`ses_${n}`, { parentID: `ses_${n + 1}` }]));
  const cycle = { ses_a: { parentID: 'ses_b' }, ses_b: { parentID: 'ses_a' } };
  for (const [sessions, start] of [[chain, 'ses_0'], [cycle, 'ses_a']]) {
    const context = fakeContext({ sessions });
    const { calls, fire } = await bridge({ context });
    await fire(shellEvent({ sessionID: start }));
    assert.equal(context.reads.length, 8);
    assert.equal(calls.length, 1);
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


test('after an ENOENT in a folder that exists, no Node is read as there, and later calls spawn nothing', async () => {
  const trace = path.join(ROOT, 'trace-off.jsonl');
  const spawn = fakeSpawn((child) => queueMicrotask(() => child.emit('error', ENOENT())));
  const { calls, fire } = await bridge({ spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await fire(shellEvent());
  await fire(shellEvent());
  await fire(shellEvent());
  assert.equal(calls.length, 1);
  const steps = traceLines(trace).map(({ step }) => step);
  assert.deepEqual(steps.filter((step) => step === 'off'), ['off']);
  assert.deepEqual(steps, ['setup', 'off', 'skip', 'skip']);
});

test('an ENOENT in a folder that is gone skips that call alone: the next call, in a folder that exists, spawns', async () => {
  const trace = path.join(ROOT, 'trace-gone.jsonl');
  const gone = path.join(ROOT, 'removed');
  let first = true;
  const spawn = fakeSpawn((child) => queueMicrotask(() => {
    if (first) child.emit('error', ENOENT());
    else child.emit('close', 0, null);
    first = false;
  }));
  const { calls, fire } = await bridge({ spawn, env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
  await fire(shellEvent({ input: { command: 'gh pr create', workdir: gone } }));
  await fire(shellEvent());
  assert.equal(calls.length, 2);
  assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['setup', 1], ['skip', 'gone'], ['run', 0]]);
});

test('setup resolves when one registration rejects, and still makes the other', async () => {
  const rejects = async () => { throw new Error('no hooks here'); };
  const toolFails = fakeContext({ toolHook: rejects });
  await bridge({ context: toolFails });
  assert.deepEqual(Object.keys(toolFails.hooks), ['create.before']);
  const shellFails = fakeContext({ shellHook: rejects });
  await bridge({ context: shellFails });
  assert.deepEqual(Object.keys(shellFails.hooks), ['execute.after']);
  assert.equal(await setup(null, { spawn: fakeSpawn().spawn, env: ENV }), undefined, 'not even a context');
  assert.equal(await setup(fakeContext(), null), undefined, 'no seams');
  const throwing = { get scripts() { throw new Error('no scripts here'); } };
  for (const seams of [throwing, { spawn: fakeSpawn().spawn, env: ENV, scripts: 42 }, { env: ENV, scripts: null }]) {
    assert.equal(await setup(fakeContext(), seams), undefined, 'a scripts seam that throws or is no string');
  }
});

test('a route whose script is not a file in the scripts folder registers nothing', async () => {
  const context = fakeContext();
  await bridge({ context, scripts: path.join(ROOT, 'no-scripts') });
  assert.deepEqual(Object.keys(context.hooks), ['create.before']);
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
// no other lib file: the name table now, and the hook-result reader once the bridge applies hook output.
const LIB_LEAVES = ['lib/hosts/opencode-names.mjs', 'lib/hook-result.mjs'];

test('the bridge files import only node: built-ins, each other, the generated routes, and the lib leaves', () => {
  const dir = path.join(PLUGIN, 'opencode');
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ['bridge.mjs', 'route-select.mjs', 'routes.generated.json', 'routes.mjs', 'server.mjs']);
  const allowed = new Set([...files.map((name) => `./${name}`), ...LIB_LEAVES.map((leaf) => `../${leaf}`)]);
  for (const name of files.filter((each) => each.endsWith('.mjs'))) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const specifier of specifiersOf(text)) assert.ok(specifier.startsWith('node:') || allowed.has(specifier), `${name} imports ${specifier}`);
    assert.doesNotMatch(text, /\brequire\(/u, name);
  }
  assert.deepEqual(specifiersOf(readFileSync(path.join(dir, 'bridge.mjs'), 'utf8')).filter((each) => !each.startsWith('node:')),
    ['../lib/hosts/opencode-names.mjs', './route-select.mjs', './routes.mjs']);
  assert.deepEqual(specifiersOf(readFileSync(path.join(dir, 'route-select.mjs'), 'utf8')).filter((each) => !each.startsWith('node:')), [], 'the route list half imports node: built-ins alone');
});

test('each lib leaf the bridge may import imports node: built-ins alone', () => {
  for (const leaf of LIB_LEAVES) {
    const text = readFileSync(path.join(PLUGIN, leaf), 'utf8');
    for (const specifier of specifiersOf(text)) assert.match(specifier, /^node:/u, `${leaf} imports ${specifier}`);
    assert.doesNotMatch(text, /\brequire\(/u, leaf);
  }
  assert.deepEqual(specifiersOf("import { x } from '../y.mjs';\nimport './side.mjs';\nawait import('z');"), ['../y.mjs', './side.mjs', 'z'], 'the scan sees each form');
});

test('server.mjs`s default export is { id: aidrian, setup }', () => {
  assert.deepEqual(Object.keys(server), ['id', 'setup']);
  assert.equal(server.id, 'aidrian');
  assert.equal(server.setup, setup);
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

// The scripts the bridge can run: the generated routes it selects on each of its hooks for a name the leaf can return.
const DELIVERED = [...new Set(Object.values(EVENTS).flatMap((hook) => STANDARD_NAMES.flatMap((name) => selectRoutes(GENERATED, EVENTS, hook, name)))
  .map((route) => route.script))].sort();

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
// runs none and is counted unguarded. The fixture's shell call, the adapter tests' shell call, each tool of the leaf's
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
    shellEvent({ info: { namespace: 'builtin', secret: 'hush' } }),
  ];
  for (const event of events) {
    const trace = path.join(ROOT, `trace-conformance-${event.tool}-${events.indexOf(event)}.jsonl`);
    const { calls, fire } = await bridge({ context: fakeContext({ app: APP }), env: { ...ENV, AIDRIAN_OPENCODE_TRACE: trace } });
    await fire(event);
    const ran = calls.map((call) => path.basename(call.args[0])).sort();
    const payload = { hook_event_name: 'PostToolUse', opencode: { version: APP.version, info: infoRead(event.info) }, session_id: event.sessionID, cwd: PROJECT_DIR, tool_name: event.tool, tool_input: event.input };
    const name = opencode.hookInput(payload).tool_name;
    const expected = [...new Set(Object.keys(EVENTS).flatMap((standard) => HOOKS[standard].filter((group) => hooksJsonFires(group.matcher, name))
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

test('the bridge can run hook-bash-post.mjs alone on OpenCode', () => {
  assert.deepEqual(DELIVERED, ['hook-bash-post.mjs']);
});

test('the OpenCode page`s Hooks table has a row for each hooks.json script, and its yes rows are the scripts the bridge can run', () => {
  const rows = hookRows(PAGE);
  assert.deepEqual(rows.map((row) => row.script).sort(), [...hooksJsonScripts()].sort());
  assert.equal(new Set(rows.map((row) => row.script)).size, rows.length, 'one row a script');
  assert.deepEqual(rows.filter((row) => row.runs === 'yes').map((row) => row.script).sort(), DELIVERED);
  for (const row of rows) {
    assert.ok(['yes', 'no'].includes(row.runs), row.script);
    assert.ok(row.verified === '-' || row.verified === 'fixture only' || /^live on OpenCode \d+\.\d+\.\d+/u.test(row.verified), `${row.script}: ${row.verified}`);
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
  assert.deepEqual(names, ['EnterWorktree', 'ExitPlanMode', 'NotebookEdit', 'Agent', 'Task', 'AskUserQuestion']);
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

test('the README`s OpenCode entry says the plugin keeps the session ledger only, and that no guard holds an OpenCode session', () => {
  const readme = readFileSync(path.join(REPO, 'README.md'), 'utf8');
  const entry = /^### OpenCode\n([\s\S]*?)(?=^#{2,3} )/mu.exec(readme)?.[1] ?? '';
  assert.match(entry, /session ledger/u);
  assert.match(entry.replace(/\s+/gu, ' '), /no aidrian guard holds an OpenCode session/u);
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
  git('init', '-q', '-b', 'main');
  git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  for (const [remote, url] of Object.entries(remotes)) git('remote', 'add', remote, url);
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
  assert.deepEqual(traceLines(trace).map(({ step, status }) => [step, status]), [['setup', 1], ['skip', 'gone'], ['run', 0]]);

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
