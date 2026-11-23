// The OpenCode bridge (plugins/aidrian/opencode/): on a fake OpenCode context and a fake spawn, what each tool event
// sends a hook script, how the spawn is pinned, and that no failure reaches OpenCode; then, with the real spawn and this
// Node, a completed `gh pr create` filed in the session ledger, and a call in a removed folder that leaves spawning on.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { setup } from '../plugins/aidrian/opencode/bridge.mjs';
import { ROUTES } from '../plugins/aidrian/opencode/routes.mjs';
import server from '../plugins/aidrian/opencode/server.mjs';

import { cliCall } from './cli-call.mjs';

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

const settle = () => new Promise((resolve) => setImmediate(resolve));

// A child process the fake spawn returns: `behave(child, call)` runs once the payload is written, by default a close with 0.
const closes = (code = 0) => (child) => queueMicrotask(() => child.emit('close', code, null));

// A fake spawn that records each call { program, args, options, stdin, killed } and returns a child that `behave` drives.
function fakeSpawn(behave = closes()) {
  const calls = [];
  const spawn = (program, args, options) => {
    const call = { program, args, options, stdin: '', killed: [] };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: (text) => { call.stdin += text; behave(child, call); } });
    child.kill = (signal) => call.killed.push(signal);
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

test('ROUTES is one frozen row: the shell tool`s execute.after runs the session ledger hook', () => {
  assert.deepEqual(ROUTES, [{ on: 'execute.after', event: 'PostToolUse', tool: 'shell', standard: 'Bash', script: 'hook-bash-post.mjs', timeoutMs: 5000 }]);
  assert.ok(Object.isFrozen(ROUTES) && Object.isFrozen(ROUTES[0]));
});

test('a completed shell call spawns node once with the hook`s absolute path and the standard envelope on stdin', async () => {
  const { calls, fire } = await bridge({ context: fakeContext({ app: APP }) });
  const event = shellEvent();
  assert.equal(await fire(event), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, '/opt/node22/bin/node');
  assert.deepEqual(calls[0].args, [HOOK]);
  assert.deepEqual(sent(calls[0]), {
    hook_event_name: 'PostToolUse', opencode: { version: '2.4.0' }, session_id: 'ses_root', cwd: PROJECT_DIR,
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

test('the payload holds no turn_id, and its opencode mark is an object: with app.version when a string, else {}', async () => {
  const cases = [[APP, { version: '2.4.0' }], [undefined, {}], [{ ...APP, version: 24 }, {}], [{ name: 'opencode' }, {}], [null, {}]];
  for (const [app, mark] of cases) {
    const { calls, fire } = await bridge({ context: fakeContext({ app }) });
    await fire(shellEvent());
    const payload = sent(calls[0]);
    assert.deepEqual(payload.opencode, mark);
    assert.equal(Object.hasOwn(payload, 'turn_id'), false);
  }
  const topLevel = await bridge({ context: { ...fakeContext(), version: '2.4.0' } });
  await topLevel.fire(shellEvent());
  assert.deepEqual(sent(topLevel.calls[0]).opencode, {}, 'a version outside app is not 2.4.0`s field');
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

test('one deadline ends the reads and the script together: reads that take 3000 ms leave the child 2000 ms', { timeout: 10_000 }, async (t) => {
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
  t.mock.timers.tick(1999);
  await settle();
  assert.deepEqual([resolved, spawn.calls[0].killed], [false, []], 'not killed at 4999 ms in all');
  t.mock.timers.tick(1);
  await running;
  assert.deepEqual(spawn.calls[0].killed, ['SIGKILL'], 'killed at 5000 ms in all');
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

test('create.before prepends bin once, leaves a PATH that holds it, and reads the process PATH when the shell`s has none', async () => {
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
  assert.deepEqual(shell({ TERM: 'dumb' }), { TERM: 'dumb', PATH: `${BIN}:${ENV.PATH}` }, 'the process PATH, with bin first');
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

test('create.before changes nothing when neither the shell nor the process has a PATH', async () => {
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

test('the bridge files import only node: built-ins and each other', () => {
  const dir = path.join(PLUGIN, 'opencode');
  const files = readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  assert.deepEqual(files, ['bridge.mjs', 'routes.mjs', 'server.mjs']);
  for (const name of files) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    const specifiers = [...text.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]|^\s*import\s+['"]([^'"]+)['"]|\bimport\(\s*['"`]([^'"`]+)/gmu)].map((match) => match[1] ?? match[2] ?? match[3]);
    for (const specifier of specifiers) assert.ok(specifier.startsWith('node:') || files.includes(specifier.replace(/^\.\//u, '')), `${name} imports ${specifier}`);
    assert.doesNotMatch(text, /\brequire\(/u, name);
  }
});

test('server.mjs`s default export is { id: aidrian, setup }', () => {
  assert.deepEqual(Object.keys(server), ['id', 'setup']);
  assert.equal(server.id, 'aidrian');
  assert.equal(server.setup, setup);
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
  const snapshotEnv = { ...env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_rootE2E' };
  const ran = await cliCall(['session', 'snapshot', '--session', 'ses_rootE2E'], { cwd: project, env: snapshotEnv });
  assert.equal(ran.status, 0, ran.stderr);
  const json = JSON.parse(ran.stdout);
  assert.deepEqual(json.prs.map(({ repo, number }) => `${repo}#${number}`), ['acme/widgets#12'], ran.stdout);
});
