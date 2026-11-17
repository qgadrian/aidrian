// Replacing the terminal after a background handoff (docs/handoff.md#replacing-the-terminal): the store's request to
// end, the Stop hook's step, the detached helper that sends the signal, and the shell function that opens the next
// session. The only process any test signals is one it started itself, a `sleep` named `claude`; no test starts a
// session. The shell function runs in `zsh -f` with a fake `claude` first on PATH, and is skipped where zsh is missing.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectStore } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { ENDING_WINDOW, noteEnding, openStore, takeEnding } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { END_DELAY, endAfterTurn, endHost, NEXT_WINDOW, shellInit, terminalFolder, writeNext } from '../plugins/aidrian/lib/terminal-replace.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const claudeCode = HOSTS.find((host) => host.id === 'claude-code');
const codex = HOSTS.find((host) => host.id === 'codex');
const SESSION = 'session-1';
const WRAPPED = { AIDRIAN_SHELL_PID: '4242', CLAUDE_PID: '4343', CLAUDE_CODE_SESSION_ATTENDED: '1' };
const psSays = (line) => (command, args) => (command === '/bin/ps' && args.at(-1) === '4343' ? { status: 0, stdout: `${line}\n` } : { status: 1, stdout: '' });
const OWN = psSays('4343 4242 claude');
const ZSH = spawnSync('zsh', ['-f', '-c', 'exit 0']).status === 0;
const BASH = spawnSync('bash', ['--norc', '--noprofile', '-c', 'exit 0']).status === 0;
const SHELL_ARGS = { zsh: ['-f', '-c'], bash: ['--norc', '--noprofile', '-c'] };

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A `sleep` named `claude`, started by this process, so its parent is this process: the shell, for the tests.
function fakeClaude(t) {
  const bin = folder(t, 'aidrian-fake-claude-');
  symlinkSync('/bin/sleep', path.join(bin, 'claude'));
  const child = spawn(path.join(bin, 'claude'), ['30'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => child.kill('SIGKILL'));
  return { child, exited };
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);

test('a request to end acts once, holds for its window, and refuses a wrong shape', (t) => {
  const store = openStore(folder(t, 'aidrian-store-'), { maxChain: 3 });
  const now = Date.now();
  assert.ok(noteEnding(store, SESSION, { hostPid: 4343, shell: 4242, id: 'abcd1234' }, { now }));
  assert.equal(takeEnding(store, SESSION, { now: now + ENDING_WINDOW + 1 }), null, 'past its window it is none, and goes');
  assert.equal(takeEnding(store, SESSION, { now }), null, 'and it is gone');
  noteEnding(store, SESSION, { hostPid: 4343, shell: 4242, id: 'abcd1234' });
  assert.deepEqual(takeEnding(store, SESSION), { hostPid: 4343, shell: 4242, id: 'abcd1234' });
  assert.equal(takeEnding(store, SESSION), null, 'taken once');
  for (const bad of [{ hostPid: 1, shell: 4242, id: 'abcd1234' }, { hostPid: 4343, shell: 0, id: 'abcd1234' }, { hostPid: 4343, shell: 4242, id: 'a b' }, { hostPid: '4343', shell: 4242, id: 'abcd1234' }]) {
    assert.equal(noteEnding(store, SESSION, bad, { now }), null, JSON.stringify(bad));
  }
  assert.equal(noteEnding(store, '../x', { hostPid: 4343, shell: 4242, id: 'abcd1234' }, { now }), null, 'a session id that cannot name a file');
});

test('the Stop hook\'s step writes the shell\'s record and starts the helper only when its own environment confirms the request', (t) => {
  const env = { ...process.env, ...WRAPPED, XDG_STATE_HOME: folder(t, 'aidrian-xdg-') };
  const request = { hostPid: 4343, shell: 4242, id: 'abcd1234' };
  const now = Date.now();
  const started = [];
  const step = (overrides = {}) => endAfterTurn({ host: claudeCode, take: () => request, unattended: () => false, env, now, run: OWN, start: (each) => started.push(each), ...overrides });

  assert.equal(step(), true);
  assert.deepEqual(started, [{ host: 'claude-code', pid: 4343, shell: 4242, delay: END_DELAY }]);
  const record = path.join(terminalFolder(env), '4242');
  assert.equal(readFileSync(record, 'utf8'), `abcd1234 ${Math.floor((now + NEXT_WINDOW) / 1000)}\n`);
  assert.equal(statSync(record).mode & 0o777, 0o600);
  assert.equal(statSync(terminalFolder(env)).mode & 0o777, 0o700);
  rmSync(record);

  const refusals = [
    ['no request', { take: () => null }],
    ['a session no Human attends', { unattended: () => true }],
    ['another shell asked', { take: () => ({ ...request, shell: 4100 }) }],
    ['another process asked', { take: () => ({ ...request, hostPid: 4400 }) }],
    ['the hook runs under no shell function', { env: { ...env, AIDRIAN_SHELL_PID: undefined } }],
    ['the process is not the shell\'s claude', { run: psSays('4343 4242 node') }],
    ['an id the shell would not open', { take: () => ({ ...request, id: 'a;b' }) }],
  ];
  for (const [name, overrides] of refusals) {
    started.length = 0;
    assert.equal(step(overrides), false, name);
    assert.deepEqual(started, [], name);
    assert.equal(existsSync(record), false, name);
  }
  let taken = false;
  assert.equal(endAfterTurn({ host: codex, take: () => { taken = true; return request; }, unattended: () => false, env, start: () => assert.fail('started') }), false);
  assert.equal(taken, false, 'a host that cannot replace a terminal takes nothing');
});

test('the helper signals the host process only while it is still the one the shell started', async (t) => {
  const kills = [];
  const kill = (pid, signal) => kills.push([pid, signal]);
  const common = { host: 'claude-code', pid: 4343, shell: 4242, delay: 0, kill };
  assert.equal(await endHost({ ...common, run: OWN }), true);
  assert.deepEqual(kills, [[4343, 'SIGTERM']]);
  kills.length = 0;
  for (const [name, overrides] of [
    ['its parent changed', { run: psSays('4343 1 claude') }],
    ['the pid now names another program', { run: psSays('4343 4242 sleep') }],
    ['ps cannot read it', { run: () => ({ status: 1, stdout: '' }) }],
    ['a host that cannot replace a terminal', { host: 'codex', run: OWN }],
    ['an unknown host', { host: 'nope', run: OWN }],
    ['no pid', { pid: 1, run: OWN }],
  ]) {
    assert.equal(await endHost({ ...common, ...overrides }), false, name);
  }
  assert.deepEqual(kills, []);
  let waited = 0;
  await endHost({ ...common, run: OWN, delay: 25, wait: async (ms) => { waited = ms; } });
  assert.equal(waited, 25, 'it waits for the turn to settle first');

  const { child, exited } = fakeClaude(t);
  assert.equal(await endHost({ host: 'claude-code', pid: child.pid, shell: process.pid + 1, delay: 0 }), false, 'a real process another shell started');
  assert.equal(await endHost({ host: 'claude-code', pid: child.pid, shell: process.pid, delay: 0 }), true, 'read with the real ps');
  assert.deepEqual(await withTimeout(exited, 5000), { code: null, signal: 'SIGTERM' });
});

test('the Stop hook ends the session its gate asked to end, after the turn, and leaves the shell its record', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t, 'aidrian-stop-');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = findProject(dir);
  const store = projectStore(project, loadConfig(project).config);
  const { child, exited } = fakeClaude(t);
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_PID: String(child.pid), AIDRIAN_SHELL_PID: String(process.pid), CLAUDE_CODE_SESSION_ATTENDED: '1' };
  const stop = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, ...payload }), env, encoding: 'utf8' });

  assert.equal(stop({ stop_hook_active: false }).status, 0, 'no request: nothing ends');
  assert.equal(await withTimeout(exited, END_DELAY + 1000), 'timeout');

  assert.ok(noteEnding(store, SESSION, { hostPid: child.pid, shell: process.pid, id: 'abcd1234' }));
  const result = stop({ stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'it sends nothing back');
  const record = path.join(terminalFolder(env), String(process.pid));
  assert.match(readFileSync(record, 'utf8'), /^abcd1234 \d+\n$/u);
  assert.deepEqual(await withTimeout(exited, END_DELAY + 5000), { code: null, signal: 'SIGTERM' });
  assert.equal(takeEnding(store, SESSION), null, 'the request is taken');
});

// Runs `script` in `zsh -f` after the shell function, with a fake `claude` first on PATH that logs its shell variable and
// arguments; on a start it writes `next` as this shell's record and exits 143, and on `attach <id>` it writes the record
// `chain[id]` when given, and exits 5.
function inShell(t, { shell = 'zsh', next = null, chain = {}, script = 'claude --resume x; echo rc=$?' } = {}) {
  const root = folder(t, 'aidrian-zsh-');
  const state = path.join(root, 'state');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'log');
  const records = path.join(state, 'aidrian', 'handoff-terminals');
  const chained = Object.entries(chain).map(([id, value]) => `[ "$2" = '${id}' ] && printf '%s\\n' '${value}' > "$dir/$AIDRIAN_SHELL_PID"`).join('\n');
  writeFileSync(path.join(bin, 'claude'), [
    '#!/bin/sh',
    `echo "$AIDRIAN_SHELL_PID $*" >> '${log}'`,
    `dir='${records}'`,
    'mkdir -p "$dir"',
    'if [ "$1" = attach ]; then',
    chained || ':',
    '  exit 5',
    'fi',
    next === null ? ':' : `printf '%s\\n' '${next}' > "$dir/$AIDRIAN_SHELL_PID"`,
    'exit 143',
  ].join('\n'), { mode: 0o755 });
  const init = path.join(root, 'init.sh');
  writeFileSync(init, shellInit(shell));
  const result = spawnSync(shell, [...SHELL_ARGS[shell], `source '${init}'; echo shell=$$; ${script}`], {
    env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: root, XDG_STATE_HOME: state }, encoding: 'utf8',
  });
  const pid = /shell=(\d+)/u.exec(result.stdout)?.[1];
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { result, shell: pid, calls, record: path.join(records, String(pid)), records };
}

const later = () => Math.floor(Date.now() / 1000) + 60;

test('the shell function runs the program with the shell\'s pid, keeps its exit code, and opens nothing with no record', { skip: !ZSH }, (t) => {
  const { result, shell, calls } = inShell(t);
  assert.match(result.stdout, /rc=143$/mu);
  assert.deepEqual(calls, [`${shell} --resume x`]);
});

test('the shell function opens the session a fresh record names, deletes the record, and follows the next hop too', { skip: !ZSH }, (t) => {
  const once = inShell(t, { next: `abcd1234 ${later()}` });
  assert.deepEqual(once.calls, [`${once.shell} --resume x`, `${once.shell} attach abcd1234`]);
  assert.match(once.result.stdout, /rc=5$/mu, 'the exit code of the last program it ran');
  assert.equal(existsSync(once.record), false, 'the record is deleted');

  const twice = inShell(t, { next: `first-id ${later()}`, chain: { 'first-id': `second-id ${later()}` } });
  assert.deepEqual(twice.calls.slice(1), [`${twice.shell} attach first-id`, `${twice.shell} attach second-id`]);
});

test('the shell function runs nothing but a plain id from a fresh record of its own', { skip: !ZSH }, (t) => {
  for (const next of [`ab;true ${later()}`, `$(id) ${later()}`, `abcd1234 ${Math.floor(Date.now() / 1000) - 5}`, 'abcd1234 soon', 'abc 9999999999', `-rf ${later()}`]) {
    const { result, shell, calls, record } = inShell(t, { next });
    assert.deepEqual(calls, [`${shell} --resume x`], next);
    assert.match(result.stdout, /rc=143$/mu, next);
    assert.equal(existsSync(record), false, `${next}: the record is deleted all the same`);
  }
  const root = folder(t, 'aidrian-link-');
  const target = path.join(root, 'target');
  writeFileSync(target, `abcd1234 ${later()}\n`);
  const { calls, record } = inShell(t, { script: `mkdir -p "$XDG_STATE_HOME/aidrian/handoff-terminals" && ln -s '${target}' "$XDG_STATE_HOME/aidrian/handoff-terminals/$$" && claude; echo rc=$?` });
  assert.equal(calls.length, 1, 'a record that is a symlink is never read');
  assert.ok(lstatSync(record).isSymbolicLink());
});

test('aidrian shell-init prints the function for zsh and bash, for each host that replaces a terminal, and refuses another shell', () => {
  for (const shell of ['zsh', 'bash']) {
    const printed = spawnSync(CLI, ['shell-init', shell], { encoding: 'utf8' });
    assert.equal(printed.status, 0, printed.stderr);
    assert.equal(printed.stdout, shellInit(shell));
    assert.match(printed.stdout, /^claude\(\) \{$/mu);
    assert.doesNotMatch(printed.stdout, /^codex\(\)/mu, 'a host with no route has no function');
  }
  assert.match(shellInit('zsh'), /^ {2}emulate -L zsh$/mu);
  assert.doesNotMatch(shellInit('bash'), /emulate/u);
  for (const args of [['fish'], [], ['zsh', 'extra'], ['zsh', '--install', '--uninstall']]) {
    assert.equal(spawnSync(CLI, ['shell-init', ...args], { encoding: 'utf8' }).status, 2, args.join(' '));
  }
});

test('in bash the shell function follows a fresh record and keeps the exit code without one', { skip: !BASH }, (t) => {
  const none = inShell(t, { shell: 'bash' });
  assert.deepEqual(none.calls, [`${none.shell} --resume x`]);
  assert.match(none.result.stdout, /rc=143$/mu);
  const once = inShell(t, { shell: 'bash', next: `abcd1234 ${later()}`, chain: { abcd1234: `ab;true ${later()}` } });
  assert.deepEqual(once.calls, [`${once.shell} --resume x`, `${once.shell} attach abcd1234`]);
  assert.match(once.result.stdout, /rc=5$/mu);
  assert.equal(existsSync(once.record), false);
});

test('a shell record is written only for a pid and a plain id, in a folder that is the user\'s alone', (t) => {
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-xdg-') };
  assert.equal(writeNext({ shell: 1, id: 'abcd1234', env }), null);
  assert.equal(writeNext({ shell: 4242, id: 'ab cd', env }), null);
  mkdirSync(path.join(env.XDG_STATE_HOME, 'aidrian'), { recursive: true });
  const elsewhere = folder(t, 'aidrian-elsewhere-');
  symlinkSync(elsewhere, terminalFolder(env));
  assert.equal(writeNext({ shell: 4242, id: 'abcd1234', env }), null, 'a folder that is a symlink is refused');
  assert.equal(existsSync(path.join(elsewhere, '4242')), false);
});
