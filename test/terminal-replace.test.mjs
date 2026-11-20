// Replacing the terminal after a background handoff (docs/handoff.md#replacing-the-terminal): the store's request to
// end, the Stop hook's step, the detached helper that sends the signal, and the shell function that opens the next
// session. The only process any test signals is one it started itself, a process named `claude`; no test starts a
// session. The shell function runs in `zsh -f` with a fake `claude` first on PATH, and is skipped where zsh is missing.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectStore } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { ENDING_WINDOW, FOLLOW_AGE, noteEnding, noteFollow, openStore, readFollow, takeEnding } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { nameMatcher, stopOwnBackground } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';
import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { terminalRecordWriteDenial } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { shellInit } from '../plugins/aidrian/lib/shell-init.mjs';
import { END_DELAY, endAfterTurn, endHost, NAME_BYTES, NEXT_WINDOW, readFollows, terminalFolder, writeNext } from '../plugins/aidrian/lib/terminal-replace.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const claudeCode = HOSTS.find((host) => host.id === 'claude-code');
const codex = HOSTS.find((host) => host.id === 'codex');
const SESSION = 'session-1';
const WRAPPED = { AIDRIAN_SHELL_PID: '4242', CLAUDE_PID: '4343', CLAUDE_CODE_SESSION_ATTENDED: '1' };
const psSays = (line) => (command, args) => (command === '/bin/ps' && args.at(-1) === '4343' ? { status: 0, stdout: `${line}\n` } : { status: 1, stdout: '' });
const OWN = psSays('4343 4242 claude');
// A stand-in for `ps -A`, listing `rows`, each `pid ppid comm`.
const psAll = (rows) => (command, args) => (command === '/bin/ps' && args[0] === '-A' ? { status: 0, stdout: `${rows.join('\n')}\n` } : { status: 1, stdout: '' });
const ATTACHED = psAll(['1 0 launchd', '4242 900 -zsh', '5000 4242 claude', '6000 1 claude bg-spare']);
const ZSH = spawnSync('zsh', ['-f', '-c', 'exit 0']).status === 0;
const BASH = spawnSync('bash', ['--norc', '--noprofile', '-c', 'exit 0']).status === 0;
const SHELL_ARGS = { zsh: ['-f', '-c'], bash: ['--norc', '--noprofile', '-c'] };

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A process named `claude` that waits, started by this process, so its parent is this process: the shell, for the
// tests. Each platform names a process by what it ran: Linux by the file, so a script named `claude` shows as `claude`;
// macOS by the program's own path, which for a script is its interpreter, so there a link to node named `claude`. Not
// a link to /bin/sleep: where coreutils is one program that picks its tool by its name, it would exit 1, and on Linux
// node names its main thread `MainThread`, which `ps` then shows.
function fakeClaude(t) {
  const bin = folder(t, 'aidrian-fake-claude-');
  const file = path.join(bin, 'claude');
  const script = process.platform === 'linux';
  if (script) writeFileSync(file, '#!/bin/sh\ni=0\nwhile [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done\n', { mode: 0o755 });
  else symlinkSync(process.execPath, file);
  const child = spawn(file, script ? [] : ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
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
  assert.deepEqual(takeEnding(store, SESSION), { hostPid: 4343, shell: 4242, id: 'abcd1234', next: null });
  assert.equal(takeEnding(store, SESSION), null, 'taken once');
  for (const bad of [{ hostPid: 1, shell: 4242, id: 'abcd1234' }, { hostPid: 4343, shell: 0, id: 'abcd1234' }, { hostPid: 4343, shell: 4242, id: 'a b' }, { hostPid: '4343', shell: 4242, id: 'abcd1234' }, { hostPid: null, own: 'abcd1234', shell: null, id: 'efgh5678' }]) {
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
  const { AIDRIAN_SHELL_PID: _, ...unwrapped } = env;
  const plain = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, stop_hook_active: true }), env: unwrapped, encoding: 'utf8' });
  assert.equal(plain.status, 0, plain.stderr);
  assert.ok(existsSync(path.join(store.dir, `ending-${SESSION}.json`)), 'an attended session the shell function did not start opens no store, so the request stays');
  const result = stop({ stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '', 'it sends nothing back');
  const record = path.join(terminalFolder(env), String(process.pid));
  assert.match(readFileSync(record, 'utf8'), /^abcd1234 \d+\n$/u);
  assert.deepEqual(await withTimeout(exited, END_DELAY + 5000), { code: null, signal: 'SIGTERM' });
  assert.equal(takeEnding(store, SESSION), null, 'the request is taken');
});

test('a stop that ends the session skips the session-length reminder, though the session is long enough for one', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t, 'aidrian-stop-long-');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, session: { handoff: { mode: 'ask' } } }));
  const project = findProject(dir);
  const store = projectStore(project, loadConfig(project).config);
  const { child, exited } = fakeClaude(t);
  const temp = folder(t, 'aidrian-stop-long-tmp-');
  const env = { ...process.env, TMPDIR: temp, CLAUDECODE: '1', CLAUDE_PID: String(child.pid), AIDRIAN_SHELL_PID: String(process.pid), CLAUDE_CODE_SESSION_ATTENDED: '1' };
  const record = path.join(terminalFolder(env), String(process.pid));
  // An earlier test of this file may have left this process's record; the shell would have taken it.
  rmSync(record, { force: true });
  // Each call of this transcript costs 2.7 times a fresh session's, past the default costRatio of 2: on its own, this
  // stop would send the turn back with the reminder (test/session-length.test.mjs walks the same fixture).
  const transcript = path.resolve(import.meta.dirname, 'fixtures/transcripts/handoff-cost.jsonl');
  assert.ok(noteEnding(store, SESSION, { hostPid: child.pid, shell: process.pid, id: 'abcd1234' }));

  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, transcript_path: transcript, stop_hook_active: false }), env, encoding: 'utf8',
  });
  assert.equal(result.status, 0, 'the stop is not sent back');
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /This session is long/u, 'no session-length reminder');
  assert.equal(existsSync(path.join(temp, `aidrian-session-length-${SESSION}`)), false, 'no session-length marker');
  assert.match(readFileSync(record, 'utf8'), /^abcd1234 \d+\n$/u, 'the shell opens the session that took the work');
  assert.deepEqual(await withTimeout(exited, END_DELAY + 5000), { code: null, signal: 'SIGTERM' }, 'the session ends');
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
    `printf '%s\\n' "$(cat "$dir/follows-$AIDRIAN_SHELL_PID" 2>/dev/null)" >> '${log}.follows'`,
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
  // What this shell's `follows-` record held while each program ran: its id, or '' when there was none.
  const follows = existsSync(`${log}.follows`) ? readFileSync(`${log}.follows`, 'utf8').split('\n').slice(0, -1).map((line) => line.split(' ')[0]) : [];
  return { result, shell: pid, calls, follows, record: path.join(records, String(pid)), records };
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
    assert.match(printed.stdout, /^function claude \{$/mu);
    assert.doesNotMatch(printed.stdout, /^function codex\b/mu, 'a host with no route has no function');
  }
  assert.match(shellInit('zsh'), /^ {2}emulate -L zsh$/mu);
  assert.doesNotMatch(shellInit('bash'), /emulate/u);
  for (const args of [['fish'], [], ['zsh', 'extra'], ['zsh', '--install', '--uninstall']]) {
    assert.equal(spawnSync(CLI, ['shell-init', ...args], { encoding: 'utf8' }).status, 2, args.join(' '));
  }
});

test('aidrian shell-init refuses --wrap without --install, and writes nothing', (t) => {
  const home = folder(t, 'aidrian-home-');
  const env = { ...process.env, HOME: home };
  delete env.ZDOTDIR;
  for (const args of [['zsh', '--wrap', 'cc'], ['zsh', '--uninstall', '--wrap', 'cc']]) {
    const result = spawnSync(CLI, ['shell-init', ...args], { env, encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^usage: aidrian shell-init /u);
    assert.equal(result.stdout, '', 'nothing printed');
  }
  assert.deepEqual(readdirSync(home), [], 'no startup file written');
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

// The next hops: a background session the terminal follows ends its own session, through the host's stop command.
const BG_SESSION = 'abcd1234-0000-4000-8000-000000000001';
const NEXT_SESSION = 'efgh5678-0000-4000-8000-000000000002';

test('a request names one way to end, and the store says which shell follows a session, under its id or a short one', (t) => {
  const store = openStore(folder(t, 'aidrian-store-'), { maxChain: 3 });
  assert.ok(noteEnding(store, BG_SESSION, { own: 'abcd1234', shell: 4242, id: 'efgh5678', next: NEXT_SESSION }));
  assert.deepEqual(takeEnding(store, BG_SESSION), { own: 'abcd1234', shell: 4242, id: 'efgh5678', next: NEXT_SESSION });
  assert.equal(noteEnding(store, BG_SESSION, { own: 'abcd1234', hostPid: 4343, shell: 4242, id: 'efgh5678' }), null, 'never both');
  assert.equal(noteEnding(store, BG_SESSION, { shell: 4242, id: 'efgh5678' }), null, 'never neither');
  assert.equal(noteEnding(store, BG_SESSION, { own: 'a b', shell: 4242, id: 'efgh5678' }), null);
  assert.ok(noteEnding(store, BG_SESSION, { own: 'abcd1234', shell: null, id: 'efgh5678' }), 'a background session no terminal follows only stops');
  assert.deepEqual(takeEnding(store, BG_SESSION), { own: 'abcd1234', shell: null, id: 'efgh5678', next: null });
  assert.equal(noteEnding(store, SESSION, { hostPid: 4343, shell: null, id: 'efgh5678' }), null, 'an attended session ends only for a shell');
  assert.equal(noteEnding(store, BG_SESSION, { own: 'abcd1234', id: 'efgh5678' }), null, 'no shell is null, never missing');

  assert.equal(readFollow(store, BG_SESSION), null);
  assert.ok(noteFollow(store, 'abcd1234', { shell: 4242 }));
  assert.deepEqual(readFollow(store, BG_SESSION), { shell: 4242, id: 'abcd1234' }, 'a short id the session starts with');
  assert.equal(readFollow(store, BG_SESSION, { live: () => false }), null, 'none whose shell runs no client');
  assert.equal(readFollow(store, 'abcd9999-0000'), null, 'another session');
  assert.equal(noteFollow(store, BG_SESSION, { shell: 1 }), null);

  const later = Date.now() + FOLLOW_AGE + 1000;
  assert.equal(readFollow(store, BG_SESSION, { now: later }), null, 'under the short id, past FOLLOW_AGE');
  assert.ok(noteFollow(store, BG_SESSION, { shell: 4242 }));
  assert.deepEqual(readFollow(store, BG_SESSION), { shell: 4242, id: BG_SESSION });
  assert.equal(readFollow(store, BG_SESSION, { now: later }), null, 'under the full id, past FOLLOW_AGE');
});

test('the shell function\'s record says which shell shows a session, under its id or a short one, while fresh and its own', (t) => {
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-xdg-') };
  const records = terminalFolder(env);
  const now = Date.now();
  const seconds = (ms = now) => Math.floor(ms / 1000);
  assert.equal(readFollows(BG_SESSION, { env, now }), null, 'no folder');
  mkdirSync(records, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(records, 'follows-4242'), `abcd1234 ${seconds(now - 60_000)}\n`);
  writeFileSync(path.join(records, 'follows-4343'), `${BG_SESSION} ${seconds()}\n`);
  writeFileSync(path.join(records, 'follows-4444'), `efgh5678 ${seconds()}\n`);
  writeFileSync(path.join(records, '4545'), `abcd1234 ${seconds()}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now }), { shell: 4343, id: BG_SESSION }, 'the latest of those that name it');
  assert.deepEqual(readFollows(NEXT_SESSION, { env, now }), { shell: 4444, id: 'efgh5678' }, 'a short id the session starts with');
  assert.equal(readFollows('zzzz0000-0000', { env, now }), null, 'another session');
  assert.deepEqual(readFollows(BG_SESSION, { env, now, live: (shell) => shell !== 4343 }), { shell: 4242, id: 'abcd1234' }, 'a newer record whose shell runs no client hides no live one');
  writeFileSync(path.join(records, 'follows-4646'), `zzzz ${seconds()}\n`);
  assert.equal(readFollows('zzzz0000-0000', { env, now }), null, 'a prefix shorter than a short id names no other session');
  rmSync(path.join(records, 'follows-4646'));
  assert.equal(readFollows(BG_SESSION, { env, now: now + FOLLOW_AGE + 120_000 }), null, 'past FOLLOW_AGE');
  rmSync(path.join(records, 'follows-4343'));
  assert.deepEqual(readFollows(BG_SESSION, { env, now }), { shell: 4242, id: 'abcd1234' });

  for (const [name, text] of [['a wrong line', 'abcd1234\n'], ['an id that is no plain id', `ab;cd ${seconds()}\n`], ['a time ahead', `abcd1234 ${seconds(now + 60_000)}\n`]]) {
    writeFileSync(path.join(records, 'follows-4242'), text);
    assert.equal(readFollows(BG_SESSION, { env, now }), null, name);
  }
  const target = path.join(folder(t, 'aidrian-target-'), 'line');
  writeFileSync(target, `abcd1234 ${seconds()}\n`);
  rmSync(path.join(records, 'follows-4242'));
  symlinkSync(target, path.join(records, 'follows-4242'));
  assert.equal(readFollows(BG_SESSION, { env, now }), null, 'a symlink is never read');
  rmSync(path.join(records, 'follows-4242'));
  writeFileSync(path.join(records, 'follows-4242'), `abcd1234 ${seconds()}\n`);
  chmodSync(records, 0o777);
  assert.equal(readFollows(BG_SESSION, { env, now }), null, 'a folder others may write');
  chmodSync(records, 0o700);
  assert.deepEqual(readFollows(BG_SESSION, { env, now }), { shell: 4242, id: 'abcd1234' });
});

test('a shell record that opened a session by a name says which shell shows it, when the host says that name opens it', (t) => {
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-xdg-') };
  const records = terminalFolder(env);
  mkdirSync(records, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const seconds = Math.floor(now / 1000);
  const hex = (text) => `~${Buffer.from(text, 'utf8').toString('hex')}`;
  const asked = [];
  const named = (target) => {
    asked.push(target);
    return target === 'staff-perm · 6' || target === 'staff';
  };
  writeFileSync(path.join(records, 'follows-4242'), `${hex('staff-perm · 6')} ${seconds}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now, named }), { shell: 4242, id: BG_SESSION }, 'by its name: the session is its own id');
  assert.deepEqual(asked, ['staff-perm · 6'], 'the name is decoded before it is asked');
  assert.equal(readFollows(BG_SESSION, { env, now }), null, 'with no host to say what a name opens, a name opens nothing');
  assert.equal(readFollows(BG_SESSION, { env, now, named: () => 'yes' }), null, 'only a true answer counts');

  writeFileSync(path.join(records, 'follows-4242'), `${hex('staff-perm · 7')} ${seconds}\n`);
  assert.equal(readFollows(BG_SESSION, { env, now, named }), null, 'another name');
  writeFileSync(path.join(records, 'follows-4242'), `staff ${seconds}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now, named }), { shell: 4242, id: BG_SESSION }, 'a name that reads as a plain id');

  asked.length = 0;
  writeFileSync(path.join(records, 'follows-4242'), `${BG_SESSION} ${seconds}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now, named }), { shell: 4242, id: BG_SESSION });
  assert.deepEqual(asked, [], 'a record its id matches asks the host nothing');
  writeFileSync(path.join(records, 'follows-4242'), `${hex('staff-perm · 6')} ${seconds - FOLLOW_AGE / 1000 - 120}\n`);
  assert.equal(readFollows(BG_SESSION, { env, now, named }), null, 'past FOLLOW_AGE');
  assert.deepEqual(asked, [], 'a stale record asks the host nothing');

  writeFileSync(path.join(records, 'follows-4242'), `${hex('staff-perm · 6')} ${seconds}\n`);
  writeFileSync(path.join(records, 'follows-4343'), `${hex('staff-perm · 6')} ${seconds - 30}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now, named, live: (shell) => shell !== 4242 }), { shell: 4343, id: BG_SESSION }, 'a newer record whose shell runs no client hides no live one');
  rmSync(path.join(records, 'follows-4343'));

  for (const [why, text] of [
    ['an odd count of hex digits', `~abc ${seconds}\n`],
    ['capital hex digits', `~4A4B ${seconds}\n`],
    ['no hex at all', `~ ${seconds}\n`],
    ['more than NAME_BYTES bytes', `${hex('x'.repeat(NAME_BYTES + 1))} ${seconds}\n`],
    ['a name typed as it is', `staff-perm · 6 ${seconds}\n`],
  ]) {
    writeFileSync(path.join(records, 'follows-4242'), text);
    assert.equal(readFollows(BG_SESSION, { env, now, named: () => true }), null, why);
  }
  writeFileSync(path.join(records, 'follows-4242'), `${hex('x'.repeat(NAME_BYTES))} ${seconds}\n`);
  assert.deepEqual(readFollows(BG_SESSION, { env, now, named: () => true }), { shell: 4242, id: BG_SESSION }, 'NAME_BYTES bytes');
});

test('the shell function records the session it opens by a plain id, typed or from a record, while that program runs', { skip: !ZSH }, (t) => {
  for (const shell of ['zsh', ...(BASH ? ['bash'] : [])]) {
    const typed = inShell(t, { shell, script: 'claude attach abcd1234; echo rc=$?' });
    assert.deepEqual(typed.calls, [`${typed.shell} attach abcd1234`], `${shell}: typed`);
    assert.deepEqual(typed.follows, ['abcd1234'], `${shell}: typed`);
    assert.match(typed.result.stdout, /rc=5$/mu, `${shell}: the exit code stays the program's`);
    assert.equal(existsSync(path.join(typed.records, `follows-${typed.shell}`)), false, `${shell}: deleted once the program exits`);
    assert.equal((statSync(typed.records).mode & 0o777), 0o700, `${shell}: the folder is the user's alone`);

    const chained = inShell(t, { shell, next: `first-id ${later()}`, chain: { 'first-id': `second-id ${later()}` } });
    assert.deepEqual(chained.calls.slice(1), [`${chained.shell} attach first-id`, `${chained.shell} attach second-id`], `${shell}: chained`);
    assert.deepEqual(chained.follows, ['', 'first-id', 'second-id'], `${shell}: chained`);
    assert.equal(existsSync(path.join(chained.records, `follows-${chained.shell}`)), false, `${shell}: chained`);

    const flagged = inShell(t, { shell, script: 'claude --skip-something attach abcd1234' });
    assert.deepEqual(flagged.follows, ['abcd1234'], `${shell}: typed through an alias that adds an option`);
    const valued = inShell(t, { shell, script: 'claude --model sonnet --x=1 attach abcd1234' });
    assert.deepEqual(valued.follows, ['abcd1234'], `${shell}: past options with values`);
    const prompt = inShell(t, { shell, script: 'claude --model sonnet hello attach abcd1234' });
    assert.deepEqual(prompt.follows, [''], `${shell}: not past a word that is no option value`);

    const stale = inShell(t, { shell, script: 'd="$XDG_STATE_HOME/aidrian/handoff-terminals"; mkdir -p "$d"; echo "abcd1234 1" > "$d/follows-$$"; claude --resume x' });
    assert.deepEqual(stale.follows, [''], `${shell}: a record an earlier run left is gone before a plain run starts`);

    const open = inShell(t, { shell, script: 'd="$XDG_STATE_HOME/aidrian/handoff-terminals"; mkdir -p "$d"; chmod 777 "$d"; claude attach abcd1234' });
    assert.deepEqual(open.follows, ['abcd1234'], `${shell}: written in a folder others could write`);
    assert.equal((statSync(open.records).mode & 0o777), 0o700, `${shell}: and that folder is made the user's alone first`);

    for (const script of ['claude agents', 'set -eu; claude attach', 'set -eu; claude attach ""', `claude attach '${'\u00b7'.repeat(NAME_BYTES / 2 + 1)}'`]) {
      const plain = inShell(t, { shell, script });
      assert.equal(plain.calls.length, 1, `${shell}: ${script}: ${plain.result.stderr}`);
      assert.deepEqual(plain.follows, [''], `${shell}: ${script}`);
    }
  }
});

test('the shell function records a session it opens by a name, as the hex of its bytes, under set -eu too', { skip: !ZSH }, (t) => {
  const hex = (text) => `~${Buffer.from(text, 'utf8').toString('hex')}`;
  for (const shell of ['zsh', ...(BASH ? ['bash'] : [])]) {
    // NAME_BYTES bytes in half as many characters: the cap counts bytes.
    for (const name of ['staff-perm · 6', 'ab;cd $(exit 3) `false` \'q\' "d" *', '\u00b7'.repeat(NAME_BYTES / 2)]) {
      const quoted = `'${name.replaceAll('\'', '\'\\\'\'')}'`;
      const typed = inShell(t, { shell, script: `set -eu; claude attach ${quoted} || echo rc=$?` });
      assert.deepEqual(typed.calls, [`${typed.shell} attach ${name}`], `${shell}: ${name}: ${typed.result.stderr}`);
      assert.deepEqual(typed.follows, [hex(name)], `${shell}: ${name}`);
      assert.match(typed.result.stdout, /rc=5$/mu, `${shell}: ${name}: the exit code stays the program's`);
      assert.equal(existsSync(path.join(typed.records, `follows-${typed.shell}`)), false, `${shell}: ${name}: deleted once the program exits`);
    }
  }
});

test('a background session the terminal follows ends only its own session, and passes the terminal on to the next', (t) => {
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-xdg-') };
  const request = { own: 'abcd1234', shell: 4242, id: 'efgh5678', next: NEXT_SESSION };
  const started = [];
  const follows = [];
  const step = (overrides = {}) => endAfterTurn({
    host: claudeCode, session: BG_SESSION, take: () => request, unattended: () => true, env, run: ATTACHED,
    follow: (each) => follows.push(each), start: (each) => started.push(each), ...overrides,
  });
  assert.equal(step(), true);
  assert.deepEqual(started, [{ host: 'claude-code', own: 'abcd1234', session: BG_SESSION, delay: END_DELAY }]);
  assert.deepEqual(follows, [{ session: NEXT_SESSION, shell: 4242 }], 'the terminal follows the next session');
  assert.match(readFileSync(path.join(terminalFolder(env), '4242'), 'utf8'), /^efgh5678 \d+\n$/u);

  const noEndOwn = { ...claudeCode, capabilities: { ...claudeCode.capabilities, handoffContinue: { ...claudeCode.capabilities.handoffContinue, replaceTerminal: { ...claudeCode.capabilities.handoffContinue.replaceTerminal, endOwn: undefined } } } };
  for (const [name, overrides] of [
    ['another session asked', { session: 'zzzz0000-0000' }],
    ['a session a Human attends ends by its process alone', { unattended: () => false }],
    ['a host that cannot end its own session', { host: noEndOwn }],
    ['a session the host says a Human attends, as a resumed one', { env: { ...env, CLAUDE_CODE_SESSION_ATTENDED: '1' } }],
  ]) {
    started.length = 0;
    follows.length = 0;
    assert.equal(step(overrides), false, name);
    assert.deepEqual([started, follows], [[], []], name);
  }
  // With no terminal that follows it, the session still stops itself, and hands no shell a record.
  for (const [name, overrides] of [
    ['no shell follows it', { take: () => ({ ...request, shell: null }) }],
    ['the shell is gone', { run: psAll(['1 0 launchd', '5000 1 claude']) }],
    ['the shell runs no claude client', { run: psAll(['1 0 launchd', '4242 900 -zsh', '5000 4242 vim']) }],
    ['ps cannot list', { run: () => ({ status: 1, stdout: '' }) }],
  ]) {
    started.length = 0;
    follows.length = 0;
    rmSync(path.join(terminalFolder(env), '4242'), { force: true });
    assert.equal(step(overrides), true, name);
    assert.deepEqual(started, [{ host: 'claude-code', own: 'abcd1234', session: BG_SESSION, delay: END_DELAY }], `${name}: it stops itself`);
    assert.deepEqual(follows, [], `${name}: no terminal follows the next session`);
    assert.equal(existsSync(path.join(terminalFolder(env), '4242')), false, `${name}: no shell record`);
  }
  started.length = 0;
  follows.length = 0;
  const attended = { ...process.env, ...WRAPPED, XDG_STATE_HOME: env.XDG_STATE_HOME };
  assert.equal(endAfterTurn({ host: claudeCode, session: SESSION, take: () => ({ hostPid: 4343, shell: 4242, id: 'abcd1234', next: null }), unattended: () => false, env: attended, run: OWN, follow: (each) => follows.push(each), start: (each) => started.push(each) }), true);
  assert.deepEqual(follows, [{ session: 'abcd1234', shell: 4242 }], 'the first hop passes the terminal on too, under the short id while the full one is unknown');
});

test('the helper ends a background session through the host\'s own stop, and the adapter stops only the session it runs in', async () => {
  const calls = [];
  const fake = { id: 'fake', capabilities: { handoffContinue: { replaceTerminal: { endOwn: (args) => { calls.push(args); return true; } } } } };
  assert.equal(await endHost({ host: 'fake', own: 'abcd1234', session: BG_SESSION, delay: 0, hosts: [fake], env: {} }), true);
  assert.deepEqual(calls, [{ id: 'abcd1234', session: BG_SESSION, env: {}, run: undefined }]);
  assert.equal(await endHost({ host: 'fake', own: 'a;b', session: BG_SESSION, delay: 0, hosts: [fake] }), false);
  assert.equal(await endHost({ host: 'fake', own: 'abcd1234', session: '../x', delay: 0, hosts: [fake] }), false);
  assert.equal(calls.length, 1);

  const listing = [
    { kind: 'background', id: 'abcd1234', sessionId: BG_SESSION },
    { kind: 'background', id: 'efgh5678', sessionId: NEXT_SESSION },
    { kind: 'interactive', sessionId: 'session-1' },
  ];
  const fakeRun = (list) => {
    const ran = [];
    return { ran, run: (command, args) => { ran.push(args); return args[0] === 'agents' ? { status: 0, stdout: JSON.stringify(list) } : { status: 0, stdout: '' }; } };
  };
  const stop = (id, session, list = listing) => {
    const { ran, run } = fakeRun(list);
    const ok = stopOwnBackground({ id, session, env: {}, run, resolve: () => '/bin/claude' });
    return { ok, stops: ran.filter((args) => args[0] === 'stop') };
  };
  assert.deepEqual(stop('abcd1234', BG_SESSION), { ok: true, stops: [['stop', 'abcd1234']] });
  assert.deepEqual(stop('efgh5678', BG_SESSION), { ok: false, stops: [] }, 'an id the listing gives another session');
  assert.deepEqual(stop('abcd1234', NEXT_SESSION), { ok: false, stops: [] }, 'a session that is not the id\'s');
  assert.deepEqual(stop('session-1', 'session-1'), { ok: false, stops: [] }, 'an interactive session is never stopped this way');
  assert.deepEqual(stop('abcd1234', BG_SESSION, [...listing, { kind: 'background', id: 'abcd1234', sessionId: BG_SESSION }]), { ok: false, stops: [] }, 'two that fit are none');
});

test('Claude Code\'s adapter says a name opens a session only when it is its whole name, and no other row\'s name or any id holds it', () => {
  const listing = [
    { kind: 'background', id: 'abcd1234', sessionId: BG_SESSION, name: 'staff-perm · 6', startedAt: 1 },
    { kind: 'background', id: 'efgh5678', sessionId: NEXT_SESSION, name: 'staff-perm · 7', startedAt: 2 },
    { kind: 'background', id: 'ijkl9012', sessionId: 'ijkl9012-0000', name: 'widget build', startedAt: 3 },
    { kind: 'interactive', sessionId: 'session-1', name: 'deploy' },
  ];
  const lists = [];
  const matcher = (session, list = listing, result = {}) => nameMatcher({ session, env: {}, resolve: () => '/bin/claude', run: (command, args) => {
    lists.push(args);
    return { status: 0, stdout: JSON.stringify(list), ...result };
  } });
  const own = matcher(BG_SESSION);
  assert.deepEqual(lists, [['agents', '--json']], 'one read of the listing');
  assert.equal(own('staff-perm · 6'), true, 'its exact name, which no other row\'s name holds');
  assert.equal(own('staff-perm'), false, 'a part of its name');
  assert.equal(own('perm · 6'), false, 'another part');
  assert.equal(own('Staff-perm · 6'), false, 'case and all');
  assert.equal(own('staff-perm · 7'), false, 'another session\'s name');
  assert.equal(own(''), false);
  assert.equal(own(undefined), false);
  assert.equal(lists.length, 1, 'each test reads nothing more');
  assert.equal(matcher('session-1')('deploy'), true, 'a row with no start time and no short id is a whole row');

  // Another row whose name holds the target blocks it: the same name, a longer one, dated or not.
  for (const [why, row] of [
    ['a row with the same name', { kind: 'background', id: 'mnop3456', sessionId: 'mnop3456-0000', name: 'staff-perm · 6', startedAt: 4 }],
    ['a row whose name holds it', { kind: 'background', id: 'mnop3456', sessionId: 'mnop3456-0000', name: 'staff-perm · 60', startedAt: 4 }],
    ['an undated row whose name holds it', { kind: 'background', id: 'mnop3456', sessionId: 'mnop3456-0000', name: 'old staff-perm · 6' }],
    ['a row renamed to it since', { kind: 'background', sessionId: 'mnop3456-0000', name: 'staff-perm · 6' }],
  ]) assert.equal(matcher(BG_SESSION, [...listing, row])('staff-perm · 6'), false, why);

  // A target that is an id, or the start of one, of any row, this one included, never opens by a name.
  const named = (name, extra = []) => [{ ...listing[0], name }, ...listing.slice(1), ...extra];
  assert.equal(matcher(BG_SESSION, named('ijkl9012'))('ijkl9012'), false, 'another row\'s short id');
  assert.equal(matcher(BG_SESSION, named('ijkl'))('ijkl'), false, 'the start of another row\'s id, however short');
  assert.equal(matcher(BG_SESSION, named('ijkl9012-0000'))('ijkl9012-0000'), false, 'another row\'s full id');
  assert.equal(matcher(BG_SESSION, named('abcd'))('abcd'), false, 'the start of its own id');
  assert.equal(matcher(BG_SESSION, named('abcd1234-0000-4000-8000-000000000001'))(BG_SESSION), false, 'its own full id');

  // A listing that fails, or a row no check can read, gives no test at all.
  assert.equal(matcher(BG_SESSION, listing, { status: 1 }), null, 'a listing that exits non-zero');
  assert.equal(matcher(BG_SESSION, listing, { error: new Error('timeout') }), null, 'a listing that did not finish');
  assert.equal(nameMatcher({ session: BG_SESSION, env: {}, resolve: () => '/bin/claude', run: () => ({ status: 0, stdout: 'not json' }) }), null, 'output that is not JSON');
  assert.equal(nameMatcher({ session: BG_SESSION, env: {}, resolve: () => '/bin/claude', run: () => ({ status: 0, stdout: '{}' }) }), null, 'output that is no list');
  for (const [why, row] of [['a row that is no object', null], ['a row with no name', { sessionId: 'x-0000' }], ['a row whose name is a number', { sessionId: 'x-0000', name: 7 }], ['a row with no session id', { name: 'x' }], ['a row whose id is no string', { sessionId: 'x-0000', name: 'x', id: 7 }]]) {
    assert.equal(matcher(BG_SESSION, [...listing, row]), null, why);
  }
  assert.equal(matcher('zzzz0000-0000'), null, 'a session the listing does not name');
  assert.equal(matcher(BG_SESSION, [...listing, listing[0]]), null, 'a session the listing names twice');

  // The session the handoff just started, and that row alone, is left out: its name holds this one's.
  const chain = [
    { kind: 'background', id: 'abcd1234', sessionId: BG_SESSION, name: 'widget' },
    { kind: 'background', id: 'efgh5678', sessionId: NEXT_SESSION, name: 'widget · 1' },
  ];
  const skipping = (skip, list = chain) => nameMatcher({ session: BG_SESSION, skip, env: {}, resolve: () => '/bin/claude', run: () => ({ status: 0, stdout: JSON.stringify(list) }) });
  assert.equal(skipping(NEXT_SESSION)('widget'), true, 'the next session\'s name does not block it');
  assert.equal(skipping(null)('widget'), false, 'without the next session\'s id, its name blocks it');
  assert.equal(skipping('efgh5678')('widget'), false, 'only a full session id leaves a row out');
  assert.equal(skipping(NEXT_SESSION, [...chain, { kind: 'background', sessionId: 'mnop3456-0000', name: 'widget build' }])('widget'), false, 'any other row whose name holds it still blocks it');
  assert.equal(skipping(NEXT_SESSION, [...chain, { kind: 'background', sessionId: 'mnop3456-0000', name: 'widget' }])('widget'), false, 'and so does a row with the same name');
  assert.equal(skipping(NEXT_SESSION, [...chain, { sessionId: NEXT_SESSION, name: 7 }]), null, 'a malformed row is never left out to pass the check');
  assert.equal(skipping(BG_SESSION), null, 'it never leaves out the session itself');
  assert.equal(nameMatcher({ session: BG_SESSION, env: {}, resolve: () => null, run: () => assert.fail('no claude, no run') }), null);
  assert.equal(typeof claudeCode.capabilities.handoffContinue.replaceTerminal.nameMatcher, 'function', 'the adapter declares it');
});

test('the Stop hook of a background session the terminal follows stops that session itself, and leaves the shell its record', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t, 'aidrian-stop-bg-');
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = findProject(dir);
  const store = projectStore(project, loadConfig(project).config);
  const bin = folder(t, 'aidrian-fake-bin-');
  const log = path.join(bin, 'log');
  const listing = JSON.stringify([{ kind: 'background', id: 'abcd1234', sessionId: BG_SESSION }]);
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = agents ]; then echo '${listing}'; exit 0; fi\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  const env = { ...process.env, CLAUDECODE: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  assert.ok(markUnattended(BG_SESSION, { root: dir, env }));
  // This process stands for the shell, and a process named `claude` it started for the client attached to the session.
  fakeClaude(t);
  const shell = process.pid;
  assert.ok(noteEnding(store, BG_SESSION, { own: 'abcd1234', shell, id: 'efgh5678', next: NEXT_SESSION }));
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: BG_SESSION, cwd: dir, stop_hook_active: false }), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(terminalFolder(env), String(shell)), 'utf8'), /^efgh5678 \d+\n$/u);
  assert.deepEqual(readFollow(store, NEXT_SESSION), { shell, id: NEXT_SESSION });
  const deadline = Date.now() + END_DELAY + 5000;
  while (!existsSync(log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(log, 'utf8'), 'stop abcd1234\n');
});

test('the Stop hook of a background session no terminal follows stops that session, and writes no shell record', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t, 'aidrian-stop-alone-');
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const project = findProject(dir);
  const store = projectStore(project, loadConfig(project).config);
  const bin = folder(t, 'aidrian-fake-bin-');
  const log = path.join(bin, 'log');
  const listing = JSON.stringify([{ kind: 'background', id: 'abcd1234', sessionId: BG_SESSION }]);
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nif [ "$1" = agents ]; then echo '${listing}'; exit 0; fi\necho "$*" >> '${log}'\n`, { mode: 0o755 });
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ATTENDED: '0', PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  assert.ok(markUnattended(BG_SESSION, { root: dir, env }));
  assert.ok(noteEnding(store, BG_SESSION, { own: BG_SESSION, shell: null, id: 'efgh5678', next: NEXT_SESSION }));
  const records = () => (existsSync(terminalFolder(env)) ? readdirSync(terminalFolder(env)).sort() : []);
  const before = records();
  const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: BG_SESSION, cwd: dir, stop_hook_active: false }), env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(records(), before, 'no shell record');
  assert.equal(readFollow(store, NEXT_SESSION), null, 'no terminal follows the next session');
  const deadline = Date.now() + END_DELAY + 5000;
  while (!existsSync(log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(readFileSync(log, 'utf8'), 'stop abcd1234\n');
});

test('a stop the hand-back check sends back ends nothing and keeps the request; the stop after it ends the session', { skip: process.platform === 'win32' }, async (t) => {
  const dir = folder(t, 'aidrian-stop-back-');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'Adrian', ai: 'HAL9K' } }));
  const project = findProject(dir);
  const store = projectStore(project, loadConfig(project).config);
  const { child, exited } = fakeClaude(t);
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_PID: String(child.pid), AIDRIAN_SHELL_PID: String(process.pid), CLAUDE_CODE_SESSION_ATTENDED: '1' };
  const stop = (payload) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: SESSION, cwd: dir, ...payload }), env, encoding: 'utf8' });
  const record = path.join(terminalFolder(env), String(process.pid));
  // An earlier test of this file may have left this process's record; the shell would have taken it.
  rmSync(record, { force: true });
  const handedBack = '**For Adrian**\n- The advisory on the parser dependency.\n- The edit history of the plan doc.';
  assert.ok(noteEnding(store, SESSION, { hostPid: child.pid, shell: process.pid, id: 'abcd1234' }));

  const sentBack = stop({ stop_hook_active: false, last_assistant_message: handedBack });
  assert.equal(sentBack.status, 2, 'the hand-back check sends the turn back');
  assert.equal(existsSync(record), false, 'no shell record while the turn goes on');
  assert.equal(await withTimeout(exited, END_DELAY + 1000), 'timeout', 'the session runs on');

  const after = stop({ stop_hook_active: true, last_assistant_message: handedBack });
  assert.equal(after.status, 0, after.stderr);
  assert.match(readFileSync(record, 'utf8'), /^abcd1234 \d+\n$/u, 'the request was kept for the next stop');
  assert.deepEqual(await withTimeout(exited, END_DELAY + 5000), { code: null, signal: 'SIGTERM' });
});

test('a subagent and a session no Human attends may not write the shell records; an attended session and other writes may', (t) => {
  const root = folder(t, 'aidrian-guard-');
  const records = path.join(root, 'aidrian', 'handoff-terminals');
  mkdirSync(records, { recursive: true });
  const config = { names: { human: 'Adrian' } };
  const guard = (input, unattended = () => false) => terminalRecordWriteDenial({ cwd: root, ...input }, config, { folders: [records], unattended });
  const subagent = { agent_id: 'a1', agent_type: 'aidrian:explorer' };
  const bash = (command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra });
  const write = (file, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, ...extra });

  for (const [name, input] of [
    ['a Bash write of a record', bash(`echo "abcd1234 9999999999" > ${records}/4242`, subagent)],
    ['a Write of a record', write(path.join(records, '4242'), subagent)],
    ['a delete of the folder', bash(`rm -rf ${records}`, subagent)],
    ['a write by the folder name alone, from a folder no path gives', bash('cd "$X" && echo x > handoff-terminals/4242', subagent)],
  ]) {
    const denied = guard(input);
    assert.ok(denied, name);
    assert.match(denied.reason, /the shell records, aidrian\/handoff-terminals, which name the session a shell opens in its terminal next/u, name);
  }
  assert.ok(guard(write(path.join(records, '4242')), () => true), 'a session no Human attends');
  assert.equal(guard(write(path.join(records, '4242'))), null, 'an attended main session');
  assert.equal(guard(write(path.join(root, 'notes.md'), subagent)), null, 'a write elsewhere');
});

