// `aidrian project start` on Codex (lib/hosts/codex-exec.mjs, lib/project-start.mjs), checked on fixtures only: a fake
// `codex` that prints the events `codex exec --json` prints and runs the real agent gate hook as Codex would on a first
// tool call. Codex is a confined host: each attempt works in a fresh clone under the run's folder, with `--add-dir` for
// exactly its git folder, its drop folder, and the state work folders; it hands its result over in the drop folder,
// and the driver's `wait` takes it in. A start holds the session only once its id, its first tool call, and the hook's
// beacon arrive; a failed proof gives the attempt back and halts the run until an attended `resume`. No test waits the
// full time: the steps are counted through a short `wait`. The fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { anchorClones } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { resolveAutoMerge } from '../plugins/aidrian/lib/config.mjs';
import { machineSwitch } from '../plugins/aidrian/lib/config-local.mjs';
import { pauseSync, resolvedPath } from '../plugins/aidrian/lib/fs.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { BEACON_GRACE, configFlags, FIRST_TOOL_WAIT, findProcesses, firstEvent, firstTool, launchCommand, processEnded, processState, PS_BUFFER, runCommand, SESSION_WAIT, START_CAP, startProject, stopProcess } from '../plugins/aidrian/lib/hosts/codex-exec.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { ATTEMPT_ENV, cacheVars } from '../plugins/aidrian/lib/project-registries.mjs';
import { projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { appendToRun, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { markFolder, markPending, markUnattended, noteBeacon, PENDING_AGE, readBeacon, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, runFixture } from './project-start-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const HOOKS_JSON = path.resolve(import.meta.dirname, '../plugins/aidrian/hooks/hooks.json');
const THREAD = '0199a7f1-0000-7000-8000-00000000c0de';
const BYPASS = /dangerously|bypass|full-auto|danger-full-access|--yolo/u;
const at = (ms) => new Date(ms).toISOString();
// A wait that pauses each step in real time until `ready()`, then counts the rest of the steps at once.
const until = (ready) => (ms) => {
  if (!ready()) pauseSync(ms);
};
const shortWait = (ms) => pauseSync(Math.min(ms, 50));

// Every handler key hooks.json lists, `<event>:<group>:<handler>`, in Codex's snake case.
function hookKeys() {
  const { hooks } = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const snake = (event) => event.replace(/[A-Z]/gu, (letter, i) => `${i ? '_' : ''}${letter.toLowerCase()}`);
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group, i) => group.hooks.map((hook, handler) => ({ key: `${snake(event)}:${i}:${handler}`, command: hook.command }))));
}

// Codex's config.toml: the plugin installed, its hooks trusted (`trusted`: 'all', 'tracker', or 'none'; `off`, a script
// whose hook is turned off), and the workspace-write sandbox's network on, with `roots` its writable roots.
function codexConfig({ trusted = 'all', off = null, network = true, roots = null, slashTmp = false, extra = '' } = {}) {
  const id = 'aidrian@aidrian-harness';
  const keys = hookKeys().filter(({ command }) => trusted === 'all' || (trusted === 'tracker' && /hook-tracker-(?:pre|post)\.mjs/u.test(command)));
  const trust = keys.map(({ key, command }) => `[hooks.state."${id}:hooks/hooks.json:${key}"]\ntrusted_hash = "sha256:x"\n${off && command.includes(off) ? 'enabled = false\n' : ''}`).join('');
  // /tmp holds the whole fixture on Linux, so the sandbox's own /tmp is excluded unless `slashTmp`.
  const sandbox = `[sandbox_workspace_write]\n${network ? 'network_access = true\n' : ''}${slashTmp ? '' : 'exclude_slash_tmp = true\n'}${roots ? `writable_roots = [${roots.map((each) => JSON.stringify(each)).join(', ')}]\n` : ''}`;
  return `[plugins."${id}"]\nenabled = true\n${trusted === 'none' ? '' : trust}${sandbox}${extra}`;
}

// A fake `codex` in `bin`. It records its arguments, folder, pid, inherited session id, and the cache variables it got
// (project-registries.mjs cacheVars) in `<bin>/codex-call.json`,
// prints the first event `mode.event` names ('thread', 'other', or 'none'), a to-do list item first when `mode.todo`,
// and a `turn.failed` event with the message `mode.failed`; then, unless `mode.tool` is false, after `mode.slow`
// milliseconds, its first tool call's event and, when `mode.hook`, runs the agent gate hook as Codex runs it for that
// call. Then it runs each of `mode.hooks`, { script, input }, as Codex runs a hook in its folder, and records their exit
// codes in `<bin>/hook-results.json`; then it runs until it is stopped, until `bin` is gone, or ten minutes at most.
function fakeCodex(t, bin, mode) {
  const record = path.join(bin, 'codex-call.json');
  rmSync(record, { force: true });
  writeFileSync(path.join(bin, 'codex-mode.json'), JSON.stringify({ tool: true, slow: 0, ...mode }));
  writeFileSync(path.join(bin, 'codex'), `#!${process.execPath}
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const mode = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(bin, 'codex-mode.json'))}, 'utf8'));
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid, inherited: process.env.CODEX_THREAD_ID ?? null, caches: Object.fromEntries(Object.entries(process.env).filter(([name]) => ${JSON.stringify(Object.keys(cacheVars('/c', {}, { registries: ['npm'] })))}.includes(name))) }));
if (mode.reject) {
  console.error(mode.reject);
  process.exit(1);
}
console.error('codex: reading the prompt');
const say = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
if (mode.event === 'thread') say({ type: 'thread.started', thread_id: ${JSON.stringify(THREAD)} });
if (mode.event === 'other') say({ type: 'turn.started' });
if (mode.event === 'thread') say({ type: 'item.completed', item: { id: 'r0', type: 'reasoning', text: 'thinking' } });
if (mode.todo) say({ type: 'item.started', item: { id: 't0', type: 'todo_list', items: [] } });
if (mode.failed) say({ type: 'turn.failed', error: { message: mode.failed } });
setTimeout(() => {
  if (mode.event !== 'thread' || !mode.tool) return;
  say({ type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'git status' } });
  if (mode.hook) spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(HOOK)}], { input: JSON.stringify({ session_id: ${JSON.stringify(THREAD)}, turn_id: 'turn-1', hook_event_name: 'PreToolUse', cwd: process.cwd(), tool_name: 'Bash', tool_input: { command: 'git status' } }), env: process.env, encoding: 'utf8' });
  const results = (mode.hooks ?? []).map(({ script, input }) => {
    const ran = spawnSync(${JSON.stringify(process.execPath)}, [script], { input: JSON.stringify({ session_id: ${JSON.stringify(THREAD)}, turn_id: 'turn-2', hook_event_name: 'PreToolUse', cwd: process.cwd(), ...input }), cwd: process.cwd(), env: process.env, encoding: 'utf8' });
    return { status: ran.status, stderr: ran.stderr };
  });
  fs.writeFileSync(${JSON.stringify(path.join(bin, 'hook-results.json'))}, JSON.stringify(results));
}, mode.slow);
// The start runs it detached, so no test's cleanup reaches it by pid: it ends once the fixture's cleanup deletes \`bin\`,
// and after ten minutes should a killed run leave the folder behind. Before this, every run left its fakes running.
setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(bin)})) process.exit(0);
}, 200);
setTimeout(() => process.exit(0), 600000);
`, { mode: 0o755 });
  const call = () => (existsSync(record) ? JSON.parse(readFileSync(record, 'utf8')) : null);
  return { call };
}

// Whether the process `pid` runs no more: gone, or a zombie its parent has not reaped.
const gone = (pid) => {
  const state = processState(pid);
  return Boolean(state?.gone || state?.zombie);
};

// The forge's hosts an adapter's start allows through Codex's network proxy.
const DOMAINS = ['github.com', 'api.github.com'];

// The fixture as a Codex driver session sees it: CODEX_THREAD_ID names the driver, CODEX_HOME holds `codexConfig`, and
// HOME is the fixture's. `projectRun` is the base branch's.
function codexRun(t, { projectRun = { allow: true, unverifiedHosts: true }, forgeConfig, config = {}, mode = { event: 'thread', hook: true }, project = {} } = {}) {
  const fx = runFixture(t, { projectRun, forgeConfig, config: project });
  const codexHome = path.join(fx.root, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(path.join(codexHome, 'config.toml'), codexConfig(config));
  // A temporary folder apart from the state folders, as on a machine: the suite's own holds the whole fixture.
  const temp = path.join(fx.root, 'tmp');
  mkdirSync(temp);
  const env = { ...fx.env, HOME: fx.home, CODEX_THREAD_ID: DRIVER, CODEX_HOME: codexHome, TMPDIR: temp };
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CONFIG_DIR']) delete env[name];
  const fake = fakeCodex(t, fx.bin, mode);
  const attempt = (n = 1) => path.join(runsFolder(fx.state), 'launch', 'attempts', `ENG-1.${n}`);
  const log = (n = 1) => path.join(runsFolder(fx.state), 'launch', 'logs', `ENG-1.${n}.jsonl`);
  // Pauses only until the fake codex made its first tool call and the hook filed its beacon: a session whose hook never
  // runs pauses each step of the beacon's grace.
  const beacon = path.join(markFolder(env), `beacon.${THREAD}.json`);
  const ready = (n = 1) => until(() => existsSync(log(n)) && firstEvent(log(n)) !== undefined && readFileSync(log(n), 'utf8').includes('item.started') && existsSync(beacon));
  // `aidrian project` as the Codex driver; the host's commands run for real, through the fake codex on PATH.
  const cmd = (args, more = {}) => fx.cmd(args, { env, spawn: undefined, wait: shortWait, ...more });
  return { ...fx, env, codexHome, cmd, fake, attempt, log, ready };
}

// An adapter's start outside the gate: a folder, a log, a grant, and a hold that files a real pending mark.
function adapterStart(t, fx, { beacon = () => true, wait = shortWait, limits, identify = () => true, caches, domains = DOMAINS } = {}) {
  const cwd = path.join(fx.root, 'work');
  const grant = path.join(fx.root, 'grant');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(grant, { recursive: true });
  const log = path.join(fx.root, 'issue.1.jsonl');
  const hold = ({ cwd: folder, known }) => markPending(DRIVER, { cwd: folder, root: fx.dir, known, env: fx.env }) !== null;
  const prompt = 'Project run launch, issue ENG-1, attempt 1: work the issue.';
  const env = { ...fx.env, CODEX_THREAD_ID: DRIVER };
  return { cwd, grant, log, prompt, result: startProject({ cwd, prompt, name: 'launch · ENG-1 · 1', env, hold, identify, log, beacon, grants: [grant], domains, cacheVars: caches, wait, limits }) };
}

test('Codex declares an unverified, confined project start behind its hook trust, its sandbox network, and its writable roots', () => {
  const cap = codex.capabilities.projectStart;
  assert.deepEqual([cap.verified, cap.confined], ['unverified', true]);
  for (const field of ['start', 'stop', 'ended', 'find', 'hookTrust', 'access', 'attachLine', 'stopLine', 'sessionNote']) assert.equal(typeof cap[field], 'function', field);
  assert.match(cap.sessionNote({ work: '/w', branch: 'feat/x' }), /work only in that folder.*git push origin HEAD:refs\/heads\/feat\/x.*--head feat\/x/su);
});

test('the fake codex ends once its fixture folder is gone, so a run leaves none of them running', (t) => {
  const fx = runFixture(t, { init: false });
  const bin = path.join(fx.root, 'fake-bin');
  mkdirSync(bin);
  const fake = fakeCodex(t, bin, { event: 'none', tool: false });
  const fd = openSync(path.join(fx.root, 'fake.log'), 'w');
  const { pid } = launchCommand(path.join(bin, 'codex'), [], { cwd: fx.root, env: process.env, fd });
  closeSync(fd);
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Ended by itself, as it should.
    }
  });
  for (let step = 0; step < 200 && fake.call()?.pid !== pid; step += 1) pauseSync(25);
  assert.equal(fake.call()?.pid, pid, 'the fake started');
  assert.equal(gone(pid), false);
  rmSync(bin, { recursive: true, force: true });
  for (let step = 0; step < 200 && !gone(pid); step += 1) pauseSync(25);
  assert.equal(gone(pid), true, 'the fake still runs after its folder was removed');
});

test('a start lasts less than a pending mark holds, by 30 seconds at least', () => {
  assert.ok(START_CAP <= PENDING_AGE - 30_000, `${START_CAP} against ${PENDING_AGE}`);
  assert.deepEqual([SESSION_WAIT, FIRST_TOOL_WAIT], [30_000, 180_000]);
  assert.ok(BEACON_GRACE > 0 && BEACON_GRACE <= 10_000);
});

test('the process table reads the same start time whatever the time zone or language of the environment', (t) => {
  const fx = runFixture(t, { init: false });
  const fd = openSync(path.join(fx.root, 'sleep.log'), 'w');
  const { pid } = launchCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: fx.root, env: process.env, fd });
  closeSync(fd);
  t.after(() => process.kill(pid, 'SIGKILL'));
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  try {
    process.env.TZ = 'America/Los_Angeles';
    process.env.LC_ALL = 'de_DE.UTF-8';
    const west = processState(pid).digest;
    process.env.TZ = 'Asia/Tokyo';
    const east = processState(pid).digest;
    assert.equal(west, east);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a process table listing past 1 MiB, as on a busy machine, is still read whole and finds the start by its folder', () => {
  const cwd = path.join(tmpdir(), 'aidrian-busy-table', 'work');
  // A stand-in for ps, run through the real runCommand with the options the adapter passes: 2 MiB of other processes'
  // command lines, then the start's codex exec; the start time for the pid alone.
  const listing = `const filler = '9 S /usr/bin/other ' + 'x'.repeat(1000) + '\\n'; process.stdout.write(filler.repeat(2048) + '4242 S /usr/local/bin/codex exec --json --cd ${cwd} prompt\\n');`;
  const seen = [];
  const run = (program, args, options) => {
    seen.push(options.maxBuffer);
    const script = args.includes('-A') ? listing : "process.stdout.write('S Mon Jan  5 10:00:00 2026\\n')";
    return runCommand(process.execPath, ['-e', script], options);
  };
  const found = findProcesses({ cwd, run });
  assert.ok(Array.isArray(found), 'the listing is read, not cut at 1 MiB');
  assert.equal(found.length, 1);
  assert.match(found[0].id, /^pid-4242-[0-9a-f]{16}$/u);
  assert.ok(seen.every((each) => each === PS_BUFFER), 'every process table call passes the larger buffer');
  assert.ok(PS_BUFFER >= 64 * 1024 * 1024);
  // Without it, spawnSync stops the listing at its 1 MiB default.
  const cut = runCommand(process.execPath, ['-e', listing], {});
  assert.equal(cut.error?.code, 'ENOBUFS');
});

test('the adapter gives the cache variables to the sandboxed commands alone, through the shell policy, never the codex process, and refuses ones that are not plain text', (t) => {
  const fx = runFixture(t);
  const fake = fakeCodex(t, fx.bin, { event: 'thread', hook: false });
  const cache = path.join(fx.root, 'attempt', 'cache');
  const caches = cacheVars(cache, { GOFLAGS: '-mod=mod' }, { registries: ['npm'] });
  const { result } = adapterStart(t, fx, { caches });
  assert.equal(result.problem, undefined, result.problem);
  const { argv, caches: inherited } = fake.call();
  for (const [name, value] of Object.entries(caches)) assert.ok(argv.includes(`shell_environment_policy.set.${name}=${JSON.stringify(value)}`), name);
  assert.deepEqual(configFlags({ domains: DOMAINS, cacheVars: caches }).filter((each) => each !== '-c').length, 2 + Object.keys(caches).length);
  assert.ok(Object.values(inherited).every((value) => !value.startsWith(cache)), 'the codex process, which its hooks and MCP servers inherit, gets none');
  assert.equal(caches.GOFLAGS, '-mod=mod -modcacherw', 'the driver\'s go flags, and the module cache left writable');
  // A value with a quote or a backslash stays one TOML string.
  assert.deepEqual(configFlags({ domains: DOMAINS, cacheVars: { A: 'it\'s "x" \\ y' } }).at(-1), 'shell_environment_policy.set.A="it\'s \\"x\\" \\\\ y"');
  assert.equal(stopProcess({ id: THREAD, started: result.id, wait: shortWait }), true);

  for (const bad of [{ npm_config_cache: '/c\n/x' }, { 'bad name': '/c' }, { npm_config_cache: 7 }, ['/c'], null]) {
    const fresh = fakeCodex(t, fx.bin, { event: 'thread', hook: false });
    const refused = adapterStart(t, fx, { caches: bad }).result;
    assert.match(refused.problem ?? '', /the cache environment the gate passes the session is not variable names to plain text/u, JSON.stringify(bad));
    assert.equal(fresh.call(), null, 'no codex ran');
  }
  for (const domains of [[], ['github.com; rm -rf /'], null]) {
    const fresh = fakeCodex(t, fx.bin, { event: 'thread', hook: false });
    assert.match(adapterStart(t, fx, { domains }).result.problem ?? '', /the network hosts the gate grants the session are not host names/u, JSON.stringify(domains));
    assert.equal(fresh.call(), null, 'no codex ran');
  }
});

test('a Codex that refuses the network proxy or shell policy keys is stopped on its first proof, and the problem names the key', (t) => {
  const fx = runFixture(t);
  fakeCodex(t, fx.bin, { event: 'none', reject: 'Error loading config.toml: unknown variant `network_proxy` for key `features`' });
  const { result } = adapterStart(t, fx);
  assert.equal(result.proof, 'session', 'a failed start proof, which halts the run');
  assert.equal(result.uncertain, false);
  assert.match(result.problem, /^Codex refused a setting the start passes \(Error loading config\.toml: unknown variant `network_proxy` for key `features`\)/u);
});

test('the adapter runs codex exec with the sandbox pinned and each granted folder, and holds the session on its id, its first tool call, and the beacon', (t) => {
  const fx = runFixture(t);
  const fake = fakeCodex(t, fx.bin, { event: 'thread', hook: false });
  const order = [];
  const { cwd, grant, log, prompt, result } = adapterStart(t, fx, {
    identify: (ids) => order.push(['identify', ids.session]) > 0,
    beacon: (id) => order.push(['beacon', id]) > 0,
  });
  assert.equal(result.problem, undefined, result.problem);
  const { argv, cwd: ran, pid, inherited } = fake.call();
  assert.deepEqual(argv, ['exec', '--json', '--sandbox', 'workspace-write', '-c', 'features.network_proxy.enabled=true', '-c', 'features.network_proxy.domains={ "github.com" = "allow", "api.github.com" = "allow" }',
    '--cd', resolvedPath(cwd), '--add-dir', resolvedPath(grant), prompt]);
  assert.ok(argv.every((arg) => arg === prompt || !BYPASS.test(arg)), 'no flag that bypasses the sandbox or the approvals');
  assert.equal(ran, resolvedPath(cwd));
  assert.equal(inherited, null, 'the driver\'s session id is not the new session\'s');
  assert.equal(result.session, THREAD);
  assert.match(result.id, new RegExp(`^pid-${pid}-[0-9a-f]{16}$`, 'u'));
  assert.deepEqual(order[0], ['identify', THREAD], 'the floor and mark are filed as soon as the id is known, before the beacon');
  assert.deepEqual(order[1], ['beacon', THREAD]);
  assert.equal(statSync(log).mode & 0o777, 0o600);
  assert.equal(processEnded({ id: result.id }), false);
  assert.deepEqual(findProcesses({ cwd }).map((each) => each.id), [result.id], 'found by the folder it runs in, as given or by its real path');
  assert.equal(stopProcess({ id: THREAD, started: result.id, wait: shortWait }), true, 'stopped by its process, the session id beside it');
  assert.ok(gone(pid));
});

test('each failed proof stops the process at once and names the proof', (t) => {
  const cases = [
    [{ event: 'none' }, 'session', /`codex exec` gave no session id in its first JSON event within 30 seconds; the process was stopped/u],
    [{ event: 'other' }, 'session', /gave no session id/u],
    [{ event: 'thread', tool: false }, 'tool', /the session made no tool call within 180 seconds/u],
    [{ event: 'thread' }, 'beacon', /the plugin's agent gate hook did not run on the session's first tool call within 5 seconds of it/u],
  ];
  for (const [mode, proof, message] of cases) {
    const fx = runFixture(t);
    const fake = fakeCodex(t, fx.bin, { hook: false, ...mode });
    const log = path.join(fx.root, 'issue.1.jsonl');
    const { result } = adapterStart(t, fx, { beacon: () => false, wait: until(() => fake.call() !== null && existsSync(log) && (mode.event !== 'thread' || mode.tool === false || readFileSync(log, 'utf8').includes('item.started'))) });
    assert.deepEqual([result.uncertain, result.proof], [false, proof], JSON.stringify(mode));
    assert.match(result.problem, message, JSON.stringify(mode));
    assert.ok(gone(fake.call().pid), `${JSON.stringify(mode)}: the process runs no more`);
  }
});

test('a slow first tool call still starts the session', (t) => {
  const fx = runFixture(t);
  fakeCodex(t, fx.bin, { event: 'thread', hook: false, slow: 1500 });
  const log = path.join(fx.root, 'issue.1.jsonl');
  // Each step pauses until the tool call is in the log: far more than 30 seconds of steps pass before it, all counted.
  let steps = 0;
  const { result } = adapterStart(t, fx, { wait: (ms) => {
    steps += 1;
    if (!(existsSync(log) && readFileSync(log, 'utf8').includes('item.started'))) pauseSync(Math.min(ms, 20));
  } });
  assert.equal(result.problem, undefined, result.problem);
  assert.equal(result.session, THREAD);
  assert.ok(steps > 0);
  stopProcess({ id: result.id, wait: shortWait });
});

test('a stop by pid leaves alone a process whose start time is not the recorded one, as a reused pid', (t) => {
  const fx = runFixture(t, { init: false });
  const fd = openSync(path.join(fx.root, 'other.log'), 'w');
  const { pid } = launchCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: fx.root, env: process.env, fd });
  closeSync(fd);
  t.after(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Stopped by the test.
    }
  });
  const recorded = `pid-${pid}-${'0'.repeat(16)}`;
  assert.equal(processEnded({ id: recorded }), true, 'the recorded process runs no more: another took its pid');
  assert.equal(stopProcess({ id: recorded, wait: shortWait }), true);
  assert.equal(gone(pid), false, 'the process now at that pid still runs');
  assert.equal(stopProcess({ id: `pid-${pid}-${processState(pid).digest}`, wait: shortWait }), true);
  assert.ok(gone(pid));
});

test('the agent gate hook files a beacon for a session a pending mark holds, or one whose mark names an issue, once, in its own folder', (t) => {
  const fx = runFixture(t);
  const { env } = fx;
  const since = Date.now();
  assert.equal(noteBeacon(THREAD, { env }), null, 'no mark holds it');
  markPending(DRIVER, { cwd: fx.dir, root: fx.dir, known: [], env });
  assert.equal(noteBeacon(DRIVER, { env }), null, 'the session that ran the gate is not held by its own pending mark');
  assert.equal(noteBeacon(THREAD, { env }), path.join(markFolder(env), `beacon.${THREAD}.json`));
  assert.equal(noteBeacon(THREAD, { env }), null, 'once');
  assert.equal(readBeacon(THREAD, { env, home: fx.home, since }), true);
  assert.equal(readBeacon(THREAD, { env, home: fx.home, since: Date.now() + 60_000 }), false, 'one written before the start does not count');
  const issue = '0199a7f1-0000-7000-8000-00000000beef';
  markUnattended(issue, { root: fx.dir, env, tags: { project: 'launch', issue: 'ENG-1' } });
  rmSync(path.join(markFolder(env), `pending.${DRIVER}.json`));
  assert.ok(noteBeacon(issue, { env }), 'its own mark names an issue');
});

test('start on Codex halts unless Codex trusts and runs every hook of the plugin', (t) => {
  for (const [config, reads] of [[{ trusted: 'none' }, 'untrusted'], [{ trusted: 'tracker' }, 'untrusted'], [{ off: 'hook-bash.mjs' }, 'off']]) {
    const fx = codexRun(t, { config });
    const result = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(result.exitCode, 1);
    assert.match(result.out[0], new RegExp(`^halt this host does not run the plugin's hooks unasked \\(its hook trust reads ${reads}\\)`, 'u'), JSON.stringify(config));
    assert.match(result.out[1], /^unverified: /u);
    assert.equal(fx.fake.call(), null, 'nothing ran');
    assert.deepEqual(fx.rows(), [], 'a halt of the host records nothing');
  }
});

test('start on Codex halts unless the default branch, on the forge and by its local ref, sets projectRun.unverifiedHosts', (t) => {
  const cases = [
    [{ allow: true }, undefined, 'unset'],
    [{ allow: true, unverifiedHosts: true }, { version: 1, projectRun: { allow: true } }, 'the forge does not set it'],
    [{ allow: true }, { version: 1, projectRun: { allow: true, unverifiedHosts: true } }, 'only the forge sets it'],
  ];
  for (const [projectRun, forgeConfig, label] of cases) {
    const fx = codexRun(t, { projectRun, forgeConfig });
    const result = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.match(result.out[0] ?? '', /^halt this host's project start is not verified on a live host, and the default branch's config\.json.*does not set projectRun\.unverifiedHosts to true/u, label);
    assert.match(result.out[1] ?? '', /^unverified: /u, label);
    assert.equal(fx.fake.call(), null, `${label}: nothing ran`);
  }
});

test('a session that could not push, reach the forge, or keep out of a guarded folder halts the start, and records nothing', (t) => {
  const sandboxed = codexRun(t, { config: { network: false } });
  const result = sandboxed.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /^halt Codex runs the session in its workspace-write sandbox, whose network is off/u);
  assert.match(result.out[1], /^unverified: /u);
  assert.equal(sandboxed.fake.call(), null, 'nothing ran');
  assert.deepEqual(sandboxed.rows(), []);
  assert.equal(sandboxed.run().states.get('ENG-1'), undefined, 'the issue is not parked');

  // A user network proxy setting halts until a live run shows the start's own allow rules replace it; a comment does not.
  for (const extra of ['[features.network_proxy]\ndomains = { "evil.example" = "allow" }\n', '[features]\nnetwork_proxy = { enabled = true }\n', 'features.network_proxy.domains = { "evil.example" = "allow" }\n']) {
    const proxied = codexRun(t, { config: { extra } });
    const halted = proxied.cmd(['start', 'launch', 'ENG-1']);
    assert.match(halted.out[0], /^halt Codex's config\.toml sets a features\.network_proxy key/u, extra);
    assert.equal(proxied.fake.call(), null, 'nothing ran');
    assert.deepEqual(proxied.rows(), []);
  }
  const commented = codexRun(t, { config: { extra: '# features.network_proxy is set per start\n' } });
  assert.equal(codex.capabilities.projectStart.access({ env: commented.env, guarded: [] }), null, 'a comment that names it does not halt');

  const roots = codexRun(t, { config: { roots: ['~/.local/state'] } });
  assert.match(roots.cmd(['start', 'launch', 'ENG-1']).out[0], /^halt Codex's config\.toml makes ~\/\.local\/state writable in its workspace-write sandbox, which reaches /u);

  const noPush = (fx) => ({ ...fx.forge, repository: () => ({ default_branch: 'main', permissions: { pull: true, push: false } }) });
  const claude = runFixture(t);
  const refused = claude.cmd(['start', 'launch', 'ENG-1'], { forge: noPush(claude) });
  assert.match(refused.out[0], /^halt the forge does not let this user push to github\.com\/acme\/widgets/u);
  assert.deepEqual(claude.claude.starts(), []);
  assert.deepEqual(claude.rows(), []);
});

test('a forge that cannot say now whether this user may push refuses the start plainly: no row, the issue still open', (t) => {
  const fx = runFixture(t);
  // Only the access read fails: the default branch and the policy are read through the same facade first.
  let reads = 0;
  const flaky = { ...fx.forge, repository: (repo, options) => {
    reads += 1;
    if (new Error().stack.includes('accessProblem')) throw new Error('gh: could not resolve host');
    return fx.forge.repository(repo, options);
  } };
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { forge: flaky });
  assert.equal(result.exitCode, 1);
  assert.ok(result.out.every((line) => line.startsWith('unverified: ')), 'nothing but the unverified line of the host\'s start');
  assert.match(result.err[0], /^aidrian project start: the forge cannot say now whether this user may push to github\.com\/acme\/widgets \(gh: could not resolve host\); start again$/u);
  assert.ok(reads > 1);
  assert.deepEqual(fx.rows(), []);
  assert.equal(fx.run().states.get('ENG-1'), undefined, 'still open');
});

test('start on Codex works in a fresh clone with exactly its granted folders, holds the session once the real hook files its beacon, and prints an unverified line', (t) => {
  const fx = codexRun(t);
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() });
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.match(result.out[0], /^unverified: this host's project start is checked on fixtures only/u);
  const folder = resolvedPath(fx.attempt());
  const [work, git, drop, cache] = ['work', 'git', 'drop', 'cache'].map((name) => path.join(folder, name));
  const state = resolvedPath(fx.state);
  const { argv, pid, caches } = fx.fake.call();
  // The network proxy holds the session to the forge's hosts, and the cache variables reach its sandboxed commands alone.
  const vars = { ...cacheVars(path.join(fx.attempt(), 'cache'), fx.env), [ATTEMPT_ENV]: JSON.parse(readFileSync(path.join(fx.attempt(), 'shell-env.json'), 'utf8'))[ATTEMPT_ENV] };
  assert.match(vars[ATTEMPT_ENV], /^launch\/ENG-1\.1\/[0-9a-f]{16}$/u, 'the launch\'s marker');
  assert.deepEqual(argv.slice(0, -1), ['exec', '--json', '--sandbox', 'workspace-write', ...configFlags({ domains: ['github.com', 'api.github.com'], cacheVars: vars }), '--cd', work,
    '--add-dir', git, '--add-dir', drop, '--add-dir', cache, ...['plans', 'reviews', 'tmp', 'dispatch'].flatMap((name) => ['--add-dir', path.join(state, name)])]);
  assert.ok(Object.values(caches).every((value) => !value.startsWith(cache) && !value.startsWith(path.join(fx.attempt(), 'cache'))), 'none in the codex process\'s own environment');
  assert.equal(statSync(cache).mode & 0o777, 0o700);
  assert.match(argv.at(-1), /work only in that folder/u, 'the session note');
  // The clone: at the base tip, on the issue's branch, with the pinned origin and a git folder of its own.
  assert.equal(fx.git('-C', work, 'rev-parse', 'HEAD').trim(), fx.git('rev-parse', 'refs/remotes/origin/main').trim());
  assert.equal(fx.git('-C', work, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/eng-1-export');
  assert.equal(fx.git('-C', work, 'remote', 'get-url', 'origin').trim(), 'https://github.com/acme/widgets.git');
  assert.equal(resolvedPath(fx.git('-C', work, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()), git);
  assert.equal(statSync(drop).mode & 0o777, 0o700);
  assert.equal(fx.git('worktree', 'list').trim().split('\n').length, 1, 'no worktree of the main checkout');
  const [, , start] = fx.rows();
  assert.deepEqual([start.event, start.outcome, start.child, start.drop], ['start', 'started', THREAD, path.join(fx.attempt(), 'drop')]);
  assert.match(start.id, new RegExp(`^pid-${pid}-[0-9a-f]{16}$`, 'u'));
  assert.deepEqual(readUnattendedMark(THREAD, { env: fx.env, home: fx.home }), { root: fx.dir, cwd: path.join(fx.attempt(), 'work'), project: 'launch', issue: 'ENG-1' }, 'the mark names the attempt\'s work folder it starts in');
  assert.equal(statSync(path.dirname(fx.log())).mode & 0o777, 0o700);
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['running ENG-1']);
});

test('start on Codex allows through its network proxy exactly the forge\'s hosts and the registries both reads list, and passes corepack the npm registry', (t) => {
  const fx = codexRun(t, { projectRun: { allow: true, unverifiedHosts: true, registries: ['npm', 'pypi'] } });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const { argv } = fx.fake.call();
  const rules = argv[argv.indexOf('features.network_proxy.enabled=true') + 2];
  assert.equal(rules, 'features.network_proxy.domains={ "github.com" = "allow", "api.github.com" = "allow", "registry.npmjs.org" = "allow", "registry.yarnpkg.com" = "allow", "pypi.org" = "allow", "files.pythonhosted.org" = "allow" }');
  assert.ok(argv.includes('shell_environment_policy.set.COREPACK_NPM_REGISTRY="https://registry.npmjs.org"'));
  assert.ok(argv.includes(`shell_environment_policy.set.COREPACK_HOME=${JSON.stringify(path.join(fx.attempt(), 'cache', 'corepack'))}`));
});

test('start on Codex lets the proxy allow local binding only where the forge and the local ref both set projectRun.localBinding', (t) => {
  const flag = 'features.network_proxy.allow_local_binding=true';
  const argvOf = (options) => {
    const fx = codexRun(t, options);
    assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
    return fx.fake.call().argv;
  };
  const on = { allow: true, unverifiedHosts: true, localBinding: true };
  const argv = argvOf({ projectRun: on });
  assert.equal(argv[argv.indexOf(flag) - 1], '-c');
  assert.ok(!argvOf({}).some((each) => each.includes('allow_local_binding')), 'off by default');
  assert.ok(!argvOf({ projectRun: on, forgeConfig: { version: 1, projectRun: { allow: true, unverifiedHosts: true } } }).some((each) => each.includes('allow_local_binding')), 'the local ref alone');
  assert.deepEqual(configFlags({ domains: DOMAINS }).filter((each) => each.includes('allow_local_binding')), []);
  assert.deepEqual(configFlags({ domains: DOMAINS, localBinding: true }).slice(4, 6), ['-c', flag]);
});

test('a confined session hands its result over in its drop folder, and the driver\'s wait takes it in, then removes the attempt once the session ends', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const work = path.join(fx.attempt(), 'work');
  const file = path.join(fx.root, 'result.json');
  writeFileSync(file, JSON.stringify({ status: 'parked', pr: null, decisions: [{ question: 'Which export format?', options: ['CSV', 'JSON'], recommended: 0, class: 'product' }], stop: null }));
  const child = { ...fx.env, CODEX_THREAD_ID: THREAD };
  const before = fx.rows().length;
  const handed = projectCommand(['result', 'launch', 'ENG-1', '--file', file], { cwd: work, env: child, home: fx.home, forge: fx.forge });
  assert.deepEqual([handed.exitCode, handed.out, handed.err], [0, ['handed ENG-1 parked'], []]);
  assert.equal(fx.rows().length, before, 'no ledger write');
  assert.ok(!fx.forge.calls.some(([kind]) => kind === 'change'), 'no forge call');
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  // The fake Codex process still runs once its result is in: the run answers for it as a lingering session
  // (lib/project-linger.mjs), so the wait is not idle yet.
  assert.deepEqual(waited.out, ['result ENG-1 parked -> parked decision-1', 'lingering ENG-1 attempt 1']);
  assert.ok(fx.rows().some((row) => row.event === 'linger' && row.key === 'ENG-1' && row.attempt === 1), 'its linger row');
  const result = fx.rows().find((row) => row.event === 'result');
  assert.deepEqual([result.session, result.via, result.status], [THREAD, 'drop', 'parked']);
  assert.ok(existsSync(fx.attempt()), 'kept while its session runs');
  const [, , start] = fx.rows();
  codex.capabilities.projectStart.stop({ id: THREAD, started: start.id });
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['lingered ENG-1 attempt 1 ended', 'idle'], 'nothing left to answer for once it ended');
  assert.equal(existsSync(fx.attempt()), false, 'removed once its session ended');
  const gone = fx.rows().find((row) => row.event === 'gone');
  assert.deepEqual([gone?.key, gone?.attempt, gone?.how], ['ENG-1', 1, 'ended'], 'the host lists it ended');
});

test('a drop the driver cannot trust ends the attempt bad_result', (t) => {
  const plant = {
    link: (drop, fx) => {
      writeFileSync(path.join(fx.root, 'elsewhere.json'), '{}');
      symlinkSync(path.join(fx.root, 'elsewhere.json'), path.join(drop, 'result.json'));
    },
    hardlink: (drop, fx) => {
      writeFileSync(path.join(fx.root, 'elsewhere.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'failed', pr: null, decisions: [], stop: 'x' }));
      linkSync(path.join(fx.root, 'elsewhere.json'), path.join(drop, 'result.json'));
    },
    attempt: (drop) => writeFileSync(path.join(drop, 'result.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 2, status: 'failed', pr: null, decisions: [], stop: 'x' })),
    unchecked: (drop) => writeFileSync(path.join(drop, 'result.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'merged', pr: 'x' })),
    pull: (drop) => writeFileSync(path.join(drop, 'result.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'pr_open', pr: 7, decisions: [], stop: null })),
  };
  for (const [label, write] of Object.entries(plant)) {
    const fx = codexRun(t);
    assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0, label);
    write(path.join(fx.attempt(), 'drop'), fx);
    // Pull request 7 is another branch's.
    const forge = { ...fx.forge, change: () => ({ state: 'OPEN', headRefName: 'feat/other', headRefOid: 'a'.repeat(40), url: 'https://github.com/acme/widgets/pull/7', isCrossRepository: false }) };
    const waited = fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge });
    assert.equal(waited.out[0], 'ended ENG-1 bad_result -> open', label);
    const ended = fx.rows().find((row) => row.event === 'ended');
    assert.deepEqual([ended.reason, ended.attempt], ['bad_result', 1], label);
  }
});

test('a start whose hooks never ran under codex exec gives its attempt back and halts the run; the driver\'s re-check lifts it once, and the second halt waits on another attended session', (t) => {
  const fx = codexRun(t, { mode: { event: 'thread', hook: false } });
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() });
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /^halt the start of ENG-1 attempt 1 failed its proof: the plugin's agent gate hook did not run/u);
  assert.match(result.out[1], /^unverified: /u);
  assert.match(result.err[0], /aidrian project resume launch/u);
  assert.ok(gone(fx.fake.call().pid));
  const shape = () => fx.rows().map((row) => [row.event, row.outcome ?? row.state ?? row.via ?? null]);
  const proofRows = [['start', 'uncertain'], ['issue', 'running'], ['start', 'void'], ['issue', 'open'], ['halt', null]];
  assert.deepEqual(shape(), proofRows);
  assert.equal(fx.rows().at(-1).kind, 'proof');
  const next = fx.cmd(['next', 'launch']);
  assert.match(next.out[0], /^halted the start of ENG-1 attempt 1 failed its proof/u);
  assert.match(JSON.parse(fx.cmd(['next', 'launch', '--json']).out[0]).halt, /failed its proof/u);
  // The driver's next start re-checks the host, its trust, and its access, which pass, so it lifts the halt and launches
  // nothing; the start after it runs, the hooks still do not, so the proof fails again, and this second halt of ENG-1
  // waits on a person.
  const lifting = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(lifting.exitCode, 0, lifting.out.join('\n'));
  assert.match(lifting.out[0], /^recheck lifted the halt: the start of ENG-1 attempt 1 failed its proof/u);
  assert.equal(lifting.out[1], 'lifted the proof halt of ENG-1; start it again');
  const again = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() });
  assert.match(again.out[0], /^halt the start of ENG-1 attempt 1 failed its proof/u, again.out.join('\n'));
  assert.deepEqual(shape(), [...proofRows, ['resume', 'recheck'], ...proofRows]);
  const lifted = fx.rows()[5];
  assert.deepEqual([lifted.session, lifted.kind, lifted.key, lifted.checks.includes('host')], [DRIVER, 'proof', 'ENG-1', true]);
  const kept = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.match(kept.out[0], /^halt the run is halted: /u);
  assert.ok(kept.out.includes('the run lifted a halt of ENG-1 of this kind (proof) by itself once, so this one waits on a person'), kept.out.join('\n'));
  // However long ago the halt was written.
  assert.match(fx.cmd(['start', 'launch', 'ENG-1'], { now: Date.now() + 20 * 60 * 1000 }).out[0], /^halt the run is halted: /u, '20 minutes on');
  assert.match(fx.cmd(['next', 'launch']).out[0], /^halted /u);
  assert.equal(fx.rows().length, 11, 'a halted run records no other start, and the re-check that kept it no row');
  // The driver may not lift its own halt; another session a person attends may.
  const driver = fx.cmd(['resume', 'launch']);
  assert.equal(driver.exitCode, 1);
  assert.match(driver.err[0], /this session drives the run launch, or did, and a halt is lifted by another session a person attends/u);
  const resumed = fx.cmd(['resume', 'launch'], { env: { ...fx.env, CODEX_THREAD_ID: 'abcd1234-0000-4000-8000-00000000f001' } });
  assert.deepEqual([resumed.exitCode, resumed.out], [0, ['resumed launch']]);
  assert.equal(fx.cmd(['next', 'launch']).out[0], 'next ENG-1 feat/eng-1-export');
  fakeCodex(t, fx.bin, { event: 'thread', hook: true });
  const retried = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() });
  assert.equal(retried.exitCode, 0, retried.err.join('\n'));
  assert.match(retried.out[1], /^started ENG-1 attempt 1 /u, 'the attempt given back is taken again');
});

test('resume is the Human\'s shell\'s, or another attended session\'s: never an issue\'s session, nor the driver', (t) => {
  const fx = codexRun(t);
  const halt = () => appendToRun(fx.state, 'launch', () => ({ rows: [{ event: 'halt', cause: 'a test halt', at: at(Date.now()) }] }));
  halt();
  markUnattended(THREAD, { root: fx.dir, env: fx.env, tags: { project: 'launch', issue: 'ENG-1' } });
  const refused = fx.cmd(['resume', 'launch'], { env: { ...fx.env, CODEX_THREAD_ID: THREAD } });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.err[0], /a halt is lifted by a person/u);
  assert.match(fx.cmd(['resume', 'launch']).err[0], /this session drives the run launch, or did/u, 'the driver');
  // The hook holds the same rule.
  const hooked = (session) => projectCommandDenial({ tool_name: 'Bash', tool_input: { command: 'aidrian project resume launch' }, session_id: session, cwd: fx.dir }, fx.config, { unattended: () => false, home: fx.home });
  assert.match(hooked(DRIVER)?.reason ?? '', /`aidrian project resume` lifts a run's halt, which a person decides, and this session drives the run launch/u);
  assert.equal(hooked('abcd1234-0000-4000-8000-00000000f001'), null, 'another attended session');
  // The Human's own shell names no session.
  const shell = { ...fx.env };
  delete shell.CODEX_THREAD_ID;
  assert.deepEqual(fx.cmd(['resume', 'launch'], { env: shell }).out, ['resumed launch']);
  assert.deepEqual(fx.cmd(['resume', 'launch'], { env: shell }).out, ['not halted launch']);
});

test('a start a gate left written ahead, killed mid-wait, is found by its folder, stopped, and its issue opened again', (t) => {
  const fx = codexRun(t);
  // A gate wrote the start ahead and launched codex, then was killed before it settled the row.
  const work = path.join(fx.attempt(), 'work');
  mkdirSync(work, { recursive: true });
  const fd = openSync(path.join(fx.root, 'orphan.log'), 'w');
  launchCommand(path.join(fx.bin, 'codex'), ['exec', '--json', '--sandbox', 'workspace-write', '--cd', work, 'prompt'], { cwd: work, env: fx.env, fd });
  closeSync(fd);
  for (let step = 0; step < 100 && !fx.fake.call(); step += 1) pauseSync(20);
  const when = Date.now();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch · ENG-1 · 1', cwd: work, branch: 'feat/eng-1-export', drop: path.join(fx.attempt(), 'drop'), at: at(when), outcome: 'uncertain', pending: true },
    { event: 'issue', key: 'ENG-1', state: 'running', at: at(when) },
  ] }));
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: when + 1000 }).out, ['running ENG-1'], 'a start this young may still run');
  const settled = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: when + PENDING_AGE + 1000 });
  assert.deepEqual(settled.out, ['orphan ENG-1 attempt 1 stopped 1', 'idle']);
  assert.ok(gone(fx.fake.call().pid));
  assert.equal(fx.run().states.get('ENG-1').state, 'open');
});

test('an issue running past its hours on Codex is stopped by its process', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const { pid } = fx.fake.call();
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0'], { now: Date.now() + 7 * 60 * 60 * 1000 });
  assert.deepEqual(waited.out, ['ended ENG-1 timeout -> open', 'idle']);
  assert.ok(gone(pid));
});

test('a Codex turn that failed on a usage limit pauses the run through wait: its process is stopped and the issue opens again', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const { pid } = fx.fake.call();
  appendFileSync(fx.log(), `${JSON.stringify({ type: 'turn.failed', error: { message: 'You\'ve hit your usage limit. Try again in 2 hours.' } })}\n`);
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  const row = fx.rows().find((each) => each.event === 'limit');
  assert.deepEqual(waited.out, [`limit ENG-1 usage until ${row.until} -> open`, `paused until ${row.until}`, 'idle']);
  assert.ok(Math.abs(Date.parse(row.until) - Date.now() - 2 * 60 * 60 * 1000) < 60_000, 'two hours from the log\'s last write');
  assert.ok(gone(pid), 'Codex continues no session at the reset, so its process is stopped');
  assert.match(fx.cmd(['start', 'launch', 'ENG-4']).out.join('\n'), /paused until /u);
});

test('a later attempt on Codex clones again, and takes the issue branch from the forge', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const work = path.join(fx.attempt(), 'work');
  writeFileSync(path.join(work, 'export.txt'), 'first try\n');
  fx.git('-C', work, 'add', 'export.txt');
  fx.git('-C', work, 'commit', '-q', '-m', 'first try');
  fx.git('-C', work, 'push', '-q', fx.bare, 'HEAD:refs/heads/feat/eng-1-export');
  const [, , start] = fx.rows();
  codex.capabilities.projectStart.stop({ id: THREAD, started: start.id });
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
  assert.equal(existsSync(fx.attempt(1)), false, 'the ended attempt\'s clone is removed');
  // A live Codex names each session anew; this fake reuses its id, so its first session's beacon goes.
  rmSync(path.join(markFolder(fx.env), `beacon.${THREAD}.json`));
  fakeCodex(t, fx.bin, { event: 'thread', hook: true });
  const second = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready(2) });
  assert.equal(second.exitCode, 0, second.err.join('\n'));
  assert.equal(readFileSync(path.join(fx.attempt(2), 'work', 'export.txt'), 'utf8'), 'first try\n');
});

test('an uncertain Codex start is found by its folder through wait, stopped, and its issue opened again', (t) => {
  const fx = codexRun(t);
  const work = path.join(fx.attempt(), 'work');
  mkdirSync(work, { recursive: true });
  const fd = openSync(path.join(fx.root, 'uncertain.log'), 'w');
  launchCommand(path.join(fx.bin, 'codex'), ['exec', '--json', '--sandbox', 'workspace-write', '--cd', work, 'prompt'], { cwd: work, env: fx.env, fd });
  closeSync(fd);
  for (let step = 0; step < 100 && !fx.fake.call(); step += 1) pauseSync(20);
  // A start the gate settled as uncertain: it ran codex and could not say what came of it.
  const when = Date.now();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch \u00b7 ENG-1 \u00b7 1', cwd: work, branch: 'feat/eng-1-export', at: at(when), outcome: 'uncertain', stopped: false },
    { event: 'issue', key: 'ENG-1', state: 'running', at: at(when) },
  ] }));
  const settled = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.deepEqual(settled.out, ['orphan ENG-1 attempt 1 stopped 1', 'idle']);
  assert.ok(gone(fx.fake.call().pid));
  assert.equal(fx.run().states.get('ENG-1').state, 'open');
});

test('a state work folder planted as a link into the runs folder, or a state file with a second hard link, halts the start', (t) => {
  const linked = codexRun(t);
  symlinkSync(runsFolder(linked.state), path.join(linked.state, 'tmp'));
  const refused = linked.cmd(['start', 'launch', 'ENG-1']);
  assert.match(refused.out[0], /^halt the state work folder .*tmp is not a plain folder/u);
  assert.equal(linked.fake.call(), null);
  const tripped = codexRun(t);
  linkSync(path.join(runsFolder(tripped.state), 'launch', 'ledger.jsonl'), path.join(tripped.root, 'ledger-copy'));
  assert.match(tripped.cmd(['start', 'launch', 'ENG-1']).out[0], /^halt .*ledger\.jsonl has 2 hard links/u);
  assert.equal(tripped.fake.call(), null);
});

test('only a shell command, a file change, or an MCP call counts as the first tool call; a failed turn before one names its cause', (t) => {
  const todo = runFixture(t);
  const later = fakeCodex(t, todo.bin, { event: 'thread', hook: false, todo: true, slow: 300 });
  const log = path.join(todo.root, 'issue.1.jsonl');
  const seen = [];
  const { result } = adapterStart(t, todo, {
    wait: until(() => existsSync(log) && readFileSync(log, 'utf8').includes('command_execution')),
    beacon: () => seen.push(readFileSync(log, 'utf8').includes('command_execution')) > 0,
  });
  assert.equal(result.problem, undefined, result.problem);
  assert.deepEqual(seen, [true], 'the to-do list did not count: the beacon was read only after the command');
  stopProcess({ id: result.id, wait: shortWait });
  assert.ok(gone(later.call().pid));

  const failed = runFixture(t);
  const fake = fakeCodex(t, failed.bin, { event: 'thread', hook: false, tool: false, failed: 'You have hit your usage limit.' });
  const failedLog = path.join(failed.root, 'issue.1.jsonl');
  const { result: stopped } = adapterStart(t, failed, { wait: until(() => existsSync(failedLog) && readFileSync(failedLog, 'utf8').includes('turn.failed')) });
  assert.equal(stopped.proof, 'tool');
  assert.match(stopped.problem, /Codex reported `You have hit your usage limit\.` before the session made any tool call/u);
  assert.ok(gone(fake.call().pid));
});

test('a session whose first tool call comes after the step, with the real hook, still starts', (t) => {
  const fx = codexRun(t, { mode: { event: 'thread', hook: true, slow: 600 } });
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() });
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.match(result.out[1], /^started ENG-1 attempt 1 /u);
});

test('a merged result the forge cannot confirm yet waits for the next wait, never ends no_result, and is recorded merged once the forge answers', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const work = path.join(fx.attempt(), 'work');
  const file = path.join(fx.root, 'result.json');
  writeFileSync(file, JSON.stringify({ status: 'merged', pr: 9, decisions: [], stop: null }));
  const handed = projectCommand(['result', 'launch', 'ENG-1', '--file', file], { cwd: work, env: { ...fx.env, CODEX_THREAD_ID: THREAD }, home: fx.home, forge: fx.forge });
  assert.deepEqual(handed.out, ['handed ENG-1 merged']);
  const [, , start] = fx.rows();
  codex.capabilities.projectStart.stop({ id: THREAD, started: start.id });
  let reads = 0;
  const view = { state: 'MERGED', mergedAt: new Date(Date.now() + 1000).toISOString(), headRefName: 'feat/eng-1-export', baseRefName: 'main', headRefOid: 'b'.repeat(40), url: 'https://github.com/acme/widgets/pull/9', isCrossRepository: false };
  const forge = { ...fx.forge, change: () => {
    reads += 1;
    if (reads === 1) throw new Error('gh: could not resolve host');
    return view;
  } };
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge }).out, ['running ENG-1'], 'the session ended, but its handed result waits on the forge');
  assert.ok(existsSync(fx.attempt()), 'its folder is kept');
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge });
  assert.deepEqual(waited.out, ['result ENG-1 merged -> done', 'idle']);
  assert.equal(fx.rows().find((row) => row.event === 'result').verified, true);
});

test('an attempt clone reads its machine switches and decisions from the run\'s main checkout, never its own local file', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const work = path.join(fx.attempt(), 'work');
  writeFileSync(path.join(fx.dir, '.aidrian.local.json'), JSON.stringify({ handoff: { background: 'on' }, github: { autoMerge: 'off', unattendedWaiver: 'off' }, decisions: { mode: 'ask' } }));
  // The session writes its own local file in the clone, turning everything on.
  writeFileSync(path.join(work, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on', unattendedWaiver: 'on' }, unattendedSignoff: 'on', decisions: { mode: 'auto' } }));
  // Read as the issue's own session, whose mark names the run, the issue, and the main checkout.
  anchorClones({ session: THREAD, env: fx.env, home: fx.home });
  t.after(() => anchorClones(null));
  const clone = projectAt(work);
  assert.equal(resolvedPath(clone.checkouts.at(-1)), resolvedPath(fx.dir), 'the run\'s main checkout stands as the clone\'s');
  assert.deepEqual([clone.localAutoMerge, clone.localUnattendedWaiver, clone.localUnattendedSignoff], ['off', 'off', 'unset']);
  assert.deepEqual(clone.localDecisions, { mode: 'ask' });
  // The auto-merge gate reads that switch (lib/pr-auto-merge.mjs): off, whatever the team allows, and solo cannot turn an off on.
  assert.deepEqual(resolveAutoMerge({ autoMerge: { allow: true, default: 'on' } }, clone.localAutoMerge).effective, false);
  assert.equal(machineSwitch(clone.localUnattendedWaiver, true, clone), 'off');
  // A clone under the runs folder that no start row names reads every switch off.
  const stray = path.join(fx.attempt(2), 'work');
  mkdirSync(stray, { recursive: true });
  fx.git('-C', stray, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(stray, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' }, handoff: { background: 'on' } }));
  const unlinked = projectAt(stray);
  assert.deepEqual([unlinked.localAutoMerge, unlinked.localHandoffBackground, unlinked.localDecisions], ['off', 'off', undefined]);
});

// Every host's protected host files stay refused in the clone (lib/hosts/index.mjs protectedPaths), so the folder made
// here is a plain one.
test('an attempt clone is no shared main checkout: the main-checkout rule lets its session edit and commit there', (t) => {
  const scripts = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts');
  const patch = '*** Begin Patch\n*** Update File: README.md\n@@\n-# widgets\n+# widgets, exported\n*** End Patch';
  const fx = codexRun(t, {
    project: { git: { mainCheckout: { guard: true } } },
    mode: { event: 'thread', hook: true, hooks: [
      { script: path.join(scripts, 'hook-write.mjs'), input: { tool_name: 'apply_patch', tool_input: { command: patch } } },
      { script: path.join(scripts, 'hook-agent-gates.mjs'), input: { tool_name: 'apply_patch', tool_input: { command: patch } } },
      { script: path.join(scripts, 'hook-bash.mjs'), input: { tool_name: 'Bash', tool_input: { command: 'git commit -am "export"' } } },
      { script: path.join(scripts, 'hook-agent-gates.mjs'), input: { tool_name: 'Bash', tool_input: { command: 'mkdir -p docs/x && echo x > docs/x/notes.md' } } },
    ] },
  });
  const results = path.join(fx.bin, 'hook-results.json');
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { wait: until(() => existsSync(results)) });
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  for (let step = 0; step < 600 && !existsSync(results); step += 1) pauseSync(50);
  for (const [i, { status, stderr }] of JSON.parse(readFileSync(results, 'utf8')).entries()) assert.equal(status, 0, `hook ${i}: ${stderr}`);
  // The guard still holds the run's real main checkout.
  const main = spawnSync(process.execPath, [path.join(scripts, 'hook-write.mjs')], { input: JSON.stringify({ session_id: DRIVER, cwd: fx.dir, tool_name: 'Write', tool_input: { file_path: path.join(fx.dir, 'README.md'), content: 'x' } }), cwd: fx.dir, env: { ...fx.env, HOME: fx.home }, encoding: 'utf8' });
  assert.equal(main.status, 2, main.stderr);
});

test('a program a session names in its clone\'s git config runs neither through the hooks nor through the call they let run', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const work = path.join(fx.attempt(), 'work');
  const marker = path.join(fx.root, 'ran');
  const program = path.join(fx.root, 'program.sh');
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
  const gitConfig = path.join(fx.attempt(), 'git', 'config');
  for (const [key, value] of [['log.showSignature', 'true'], ['gpg.program', program], ['core.fsmonitor', program]]) fx.git('config', '--file', gitConfig, key, value);
  const scripts = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts');
  const run = (script, command) => spawnSync(process.execPath, [path.join(scripts, script)], { input: JSON.stringify({ session_id: THREAD, turn_id: 'turn-3', cwd: work, tool_name: 'Bash', tool_input: { command } }), cwd: work, env: { ...fx.env, HOME: fx.home }, encoding: 'utf8' });
  for (const command of ['gh pr create --head feat/eng-1-export --fill', 'git commit -am "export"']) {
    const gates = run('hook-agent-gates.mjs', command);
    assert.equal(gates.status, 2, `${command}: ${gates.stderr}`);
    assert.match(gates.stderr, /the attempt clone's own git config sets (?:log\.showsignature|gpg\.program|core\.fsmonitor)/u);
    run('hook-bash.mjs', command);
  }
  assert.equal(existsSync(marker), false, 'no hook ran the program');
});

test('a dropped result naming a pull request the forge does not have ends the attempt bad_result at once, never a retry', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  writeFileSync(path.join(fx.attempt(), 'drop', 'result.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'pr_open', pr: 999, decisions: [], stop: null }));
  // The fake forge has no pull request 999: it answers 404.
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.equal(waited.out[0], 'ended ENG-1 bad_result -> open');
  const ended = fx.rows().find((row) => row.event === 'ended');
  assert.deepEqual([ended.reason, ended.attempt], ['bad_result', 1]);
  assert.match(ended.why, /no pull request #999/u);
});

test('a dropped result the forge cannot confirm past issueHours ends bad_result, and its session is stopped', (t) => {
  const fx = codexRun(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { wait: fx.ready() }).exitCode, 0);
  const { pid } = fx.fake.call();
  writeFileSync(path.join(fx.attempt(), 'drop', 'result.json'), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, status: 'pr_open', pr: 7, decisions: [], stop: null }));
  const forge = { ...fx.forge, change: () => {
    throw new Error('gh: could not resolve host');
  } };
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge }).out, ['running ENG-1'], 'within issueHours, the next wait reads it again');
  const waited = fx.cmd(['wait', 'launch', '--max-wait', '0'], { forge, now: Date.now() + 25 * 60 * 60 * 1000 });
  assert.deepEqual(waited.out, ['ended ENG-1 bad_result -> open', 'idle']);
  const ended = fx.rows().find((row) => row.event === 'ended');
  assert.match(ended.why, /did not confirm the handed-over result within \d+ hours/u);
  assert.ok(gone(pid), 'its session was stopped');
});

test('a top-level error event before the first tool call ends no wait; a failed turn does', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-events-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = path.join(root, 'issue.1.jsonl');
  const events = (...each) => writeFileSync(log, each.map((event) => `${JSON.stringify(event)}\n`).join(''));
  const thread = { type: 'thread.started', thread_id: THREAD };
  events(thread, { type: 'error', message: 'Reconnecting... 1/5' });
  assert.equal(firstTool(log), undefined, 'a bare error event: the wait reads on');
  events(thread, { type: 'error', message: 'Reconnecting... 1/5' }, { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'git status' } });
  assert.equal(firstTool(log), true);
  events(thread, { type: 'error', message: 'stream lost' }, { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  assert.deepEqual(firstTool(log), { failed: 'You have hit your usage limit.' });
});
