// `aidrian sessions idle` (lib/sessions-cli.mjs) lists the background sessions the harness started that a host still
// holds while idle, their turn ended or waiting on a response, from the unattended marks (lib/unattended-mark.mjs
// listMarks) and each host's listing (lib/hosts/index.mjs backgroundList), and changes nothing. Every host here is a fake one, or a real adapter whose
// every call goes through a run stand-in, so no test starts a process. The marks live in a temporary state root and
// home, but for the command-line case: cliCall cannot give the command a home, so it reads the user's own marks folder,
// read-only, and lists nothing from it, since no host there can list.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { ageText, idleSessions, plainLines } from '../plugins/aidrian/lib/sessions-cli.mjs';
import { listMarks, MARK_AGE, markFolder, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { cliCall } from './cli-call.mjs';

const MINUTE = 60 * 1000;
const NOW = Date.now();
const HANDOFF = '189eaf3d-aaaa-4bbb-8ccc-ddddeeeeffff';
const ATTEMPT = '42cf8d0a-1111-4222-8333-444455556666';
const WORKING = '306d6ea0-6f93-4ac6-abe0-473db3caabb0';
const UNMARKED = '77777777-1111-4222-8333-444455556666';
const INTERACTIVE = '0badf00d-1234-4567-89ab-cdef01234567';
const SHORT = 'abcd1234-0000-4000-8000-000000000001';

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A state root and a home of the test's own, with no mark yet.
function place(t) {
  return { env: { XDG_STATE_HOME: folder(t, 'aidrian-idle-state-') }, home: folder(t, 'aidrian-idle-home-') };
}

// A host that lists `rows` (each filled with the fields backgroundList keeps), or answers `answer` instead.
function fakeHost({ rows = [], answer, name = 'Fake Host' } = {}) {
  const asked = [];
  return {
    asked,
    host: {
      id: 'fake-host',
      name,
      capabilities: {
        backgroundSessions: {
          list: () => {
            asked.push('list');
            return answer ?? { sessions: rows.map((row) => ({ name: null, cwd: null, startedAt: null, idle: true, waiting: false, ...row })) };
          },
          held: () => { throw new Error('held is never asked'); },
          stop: () => { throw new Error('nothing is stopped'); },
          stopLine: ({ id }) => {
            asked.push(`stopLine ${id}`);
            return `\`fake stop ${id}\` stops it`;
          },
        },
      },
    },
  };
}

test('an idle handoff continuation and an idle run attempt are listed oldest first, with age, what each is, and the stop line', (t) => {
  const { env, home } = place(t);
  assert.ok(markUnattended(HANDOFF, { root: '/work/app', cwd: '/work/app', env, now: NOW }));
  assert.ok(markUnattended(ATTEMPT, { root: '/work/app', cwd: '/runs/app/TAX-8', env, now: NOW, tags: { project: 'night-run', issue: 'TAX-8' } }));
  const { host } = fakeHost({
    rows: [
      { id: '189eaf3d', session: HANDOFF, name: 'harness-supporter', cwd: '/work/app', startedAt: NOW - 3 * 60 * MINUTE - 5 * MINUTE },
      { id: '42cf8d0a', session: ATTEMPT, name: 'TAX-8 · 1', startedAt: NOW - 2 * 24 * 60 * MINUTE - 4 * 60 * MINUTE, waiting: true },
    ],
  });
  const read = idleSessions({ hosts: [host], env, home, now: NOW });
  assert.deepEqual(read.notes, []);
  assert.deepEqual(read.idle.map(({ id, kind, run, issue, cwd, stop }) => [id, kind, run, issue, cwd, stop]), [
    ['42cf8d0a', 'attempt', 'night-run', 'TAX-8', '/runs/app/TAX-8', '`fake stop 42cf8d0a` stops it'],
    ['189eaf3d', 'continuation', null, null, '/work/app', '`fake stop 189eaf3d` stops it'],
  ], 'a folder the host does not give comes from the mark');
  assert.deepEqual(plainLines(read), [
    'idle 42cf8d0a 2d4h attempt of TAX-8 in run night-run \'TAX-8 · 1\' in /runs/app/TAX-8 (waiting on a response): `fake stop 42cf8d0a` stops it',
    'idle 189eaf3d 3h05m handoff continuation \'harness-supporter\' in /work/app: `fake stop 189eaf3d` stops it',
  ]);
});

test('it changes nothing: every host call is a listing or a stop line, and the marks folder is the same after', (t) => {
  const { env, home } = place(t);
  for (const session of [HANDOFF, WORKING, INTERACTIVE]) markUnattended(session, { root: '/work/app', env, now: NOW });
  const marks = markFolder(env);
  writeFileSync(path.join(marks, `pending.${WORKING}.json`), JSON.stringify({ pending: true }));
  const old = path.join(marks, 'ffff0000-1111-4222-8333-444455556666.json');
  writeFileSync(old, JSON.stringify({ root: '/work/app', at: 1 }));
  utimesSync(old, new Date(NOW - MARK_AGE - MINUTE), new Date(NOW - MARK_AGE - MINUTE));
  const snapshot = () => readdirSync(marks).sort().map((name) => {
    const stat = lstatSync(path.join(marks, name));
    return [name, stat.size, stat.mtimeMs];
  });
  const before = snapshot();
  // The real adapters, each call through the run stand-in: Claude Code finds a `claude` on PATH that never runs.
  const bin = folder(t, 'aidrian-idle-bin-');
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  const calls = [];
  const run = (program, args) => {
    calls.push([path.basename(program), ...args]);
    // Of three marked sessions, only the background one whose turn ended is idle: the interactive one never is, and one
    // whose task still runs (`state: "working"`, `status: "idle"`) is not either.
    return {
      status: 0,
      stdout: JSON.stringify([
        { kind: 'interactive', sessionId: INTERACTIVE, cwd: '/work/app', startedAt: NOW - 20 * MINUTE, state: 'done', status: 'idle' },
        { kind: 'background', id: '306d6ea0', sessionId: WORKING, cwd: '/work/app', startedAt: NOW - 15 * MINUTE, state: 'working', status: 'idle' },
        { kind: 'background', id: '189eaf3d', sessionId: HANDOFF, cwd: '/work/app', startedAt: NOW - 10 * MINUTE, state: 'done', status: 'idle' },
      ]),
    };
  };
  const read = idleSessions({ env: { ...env, PATH: bin }, home, now: NOW, run });
  assert.deepEqual(calls, [['claude', 'agents', '--json']], 'one listing, no stop');
  assert.deepEqual(read.idle.map(({ host, id, stop }) => [host, id, stop]), [['Claude Code', '189eaf3d', '`claude stop 189eaf3d` stops it']]);
  assert.deepEqual(read.notes.map(({ host, byDesign }) => [host, byDesign]), HOSTS.filter((host) => host.id !== 'claude-code').map((host) => [host.name, true]));
  assert.deepEqual(snapshot(), before, 'no mark written, removed, or swept, an expired one included');
  assert.deepEqual(readdirSync(home), [], 'the user\'s own marks folder, under the test\'s home, is not made');
});

test('a row the host does not call idle and an idle row no mark names are left out; a mark under a short id matches', (t) => {
  const { env, home } = place(t);
  markUnattended(WORKING, { root: '/work/app', env, now: NOW });
  markUnattended('abcd1234', { root: '/work/app', env, now: NOW });
  markUnattended('abc', { root: '/work/app', env, now: NOW });
  const { host } = fakeHost({
    rows: [
      { id: '306d6ea0', session: WORKING, idle: false },
      { id: '77777777', session: UNMARKED },
      { id: 'abcd1234', session: SHORT },
      { id: 'abcf0000', session: 'abcf0000-0000-4000-8000-000000000001' },
    ],
  });
  const read = idleSessions({ hosts: [host], env, home, now: NOW });
  assert.deepEqual(read.idle.map(({ id, startedAt }) => [id, startedAt]), [['abcd1234', NOW]], 'a short id of 3 characters matches nothing; with no start time, the mark\'s');
  markUnattended('ab_c', { root: '/work/app', env, now: NOW });
  const underscore = fakeHost({ rows: [{ id: 'ab_c0000', session: 'ab_c0000-0000-4000-8000-000000000001' }] }).host;
  assert.deepEqual(idleSessions({ hosts: [underscore], env, home, now: NOW }).idle, [], 'a name no short id takes, with an underscore, names no other session');
  const marks = listMarks({ env, home, now: NOW });
  assert.deepEqual(marks.map(({ session }) => session).sort(), [WORKING, 'ab_c', 'abc', 'abcd1234'].sort());
  markUnattended('feed0001', { root: '/work/app', env, now: NOW });
  const apart = fakeHost({ rows: [{ id: 'feed0001', session: UNMARKED }, { id: 'feed00012', session: UNMARKED }] }).host;
  assert.deepEqual(idleSessions({ hosts: [apart], env, home, now: NOW }).idle.map(({ id }) => id), ['feed0001'], 'a short id the full id does not start with matches the row\'s own id, and only the whole of it');
});

test('a session takes the mark under its full id, then under its exact short id, then under a short id it starts with, whatever the order of the marks', (t) => {
  const { env, home } = place(t);
  // The state root's folder is read before the user's own, so these marks come first: a prefix, and an exact short id.
  markUnattended('abcd', { root: '/work/app', cwd: '/prefix', env, now: NOW });
  markUnattended('42cf8d0a', { root: '/work/app', cwd: '/exact', env, now: NOW });
  const own = path.join(home, '.local/state/aidrian/unattended');
  mkdirSync(own, { recursive: true });
  writeFileSync(path.join(own, 'abcd1234.json'), JSON.stringify({ root: '/work/app', cwd: '/exact', at: NOW }));
  writeFileSync(path.join(own, `${ATTEMPT}.json`), JSON.stringify({ root: '/work/app', cwd: '/full', at: NOW }));
  const order = listMarks({ env, home, now: NOW }).map(({ session }) => session);
  assert.ok(order.indexOf('abcd') < order.indexOf('abcd1234') && order.indexOf('42cf8d0a') < order.indexOf(ATTEMPT), order.join(' '));
  const { host } = fakeHost({ rows: [{ id: 'abcd1234', session: SHORT, startedAt: NOW - MINUTE }, { id: '42cf8d0a', session: ATTEMPT, startedAt: NOW }] });
  assert.deepEqual(idleSessions({ hosts: [host], env, home, now: NOW }).idle.map(({ id, cwd }) => [id, cwd]), [['abcd1234', '/exact'], ['42cf8d0a', '/full']]);
});

test('listMarks reads plain and issue marks of this user within their age, and leaves every other file out', (t) => {
  const { env, home } = place(t);
  markUnattended(HANDOFF, { root: '/work/app', cwd: '/work/app/sub', env, now: NOW - MINUTE });
  markUnattended(ATTEMPT, { root: '/work/app', env, now: NOW, tags: { project: 'night-run', issue: '12' } });
  const marks = markFolder(env);
  for (const name of [`pending.${WORKING}.json`, `driver.${WORKING}.json`, `attended.${HANDOFF}.json`, `beacon.${ATTEMPT}.json`, `.${HANDOFF}.json.1.0123456789ab.tmp`]) {
    writeFileSync(path.join(marks, name), JSON.stringify({ root: '/work/app', at: 1 }));
  }
  writeFileSync(path.join(marks, 'badtags1.json'), JSON.stringify({ root: '/work/app', project: 'Bad Run', issue: '1' }));
  writeFileSync(path.join(marks, 'noroot01.json'), JSON.stringify({ at: 1 }));
  writeFileSync(path.join(marks, 'noat0001.json'), JSON.stringify({ root: '/work/app' }));
  // The user's own folder, under the test's home, with the same name: the state root's is given once.
  const own = path.join(home, '.local/state/aidrian/unattended');
  mkdirSync(own, { recursive: true });
  writeFileSync(path.join(own, `${HANDOFF}.json`), JSON.stringify({ root: '/elsewhere', at: 5 }));
  writeFileSync(path.join(own, 'ownmark1.json'), JSON.stringify({ root: '/elsewhere', at: 5 }));
  const read = listMarks({ env, home, now: NOW });
  const noAt = read.find((each) => each.session === 'noat0001');
  assert.ok(Math.abs(noAt.at - NOW) < 10 * MINUTE, 'a mark with no time of its own takes its file\'s');
  assert.deepEqual(read.filter((each) => each !== noAt).sort((a, b) => a.session.localeCompare(b.session)), [
    { session: HANDOFF, root: '/work/app', cwd: '/work/app/sub', at: NOW - MINUTE, project: null, issue: null },
    { session: ATTEMPT, root: '/work/app', cwd: null, at: NOW, project: 'night-run', issue: '12' },
    { session: 'ownmark1', root: '/elsewhere', cwd: null, at: 5, project: null, issue: null },
  ]);
  assert.deepEqual(listMarks({ env: { XDG_STATE_HOME: path.join(env.XDG_STATE_HOME, 'none') }, home: path.join(home, 'none'), now: NOW }), [], 'no folder: no mark, and none made');
  assert.equal(readdirSync(env.XDG_STATE_HOME).includes('none'), false);
});

test('a host that cannot list prints its reason as a note, and with no idle row and no failure the line is none', (t) => {
  const { env, home } = place(t);
  const failing = fakeHost({ answer: { problem: '`fake` is not on PATH' } }).host;
  const byDesign = { id: 'quiet', name: 'Quiet Host', capabilities: { backgroundSessions: { unsupported: 'it starts no session' } } };
  const empty = fakeHost({ rows: [], name: 'Empty Host' }).host;
  assert.deepEqual(plainLines(idleSessions({ hosts: [empty, byDesign], env, home, now: NOW })), ['none'], 'a host that holds none by design prints nothing');
  const read = idleSessions({ hosts: [empty, failing, byDesign], env, home, now: NOW });
  assert.deepEqual(plainLines(read), ['note Fake Host: `fake` is not on PATH']);
  assert.deepEqual(read.notes, [
    { host: 'Fake Host', problem: '`fake` is not on PATH', byDesign: false },
    { host: 'Quiet Host', problem: 'it starts no session', byDesign: true },
  ]);
});

test('a name that is not plain words, a folder or stop line with a hidden character, and an id unsafe to print are left out', (t) => {
  const { env, home } = place(t);
  markUnattended(HANDOFF, { root: '/work/app', cwd: '/work/\u202eppa', env, now: NOW });
  markUnattended(ATTEMPT, { root: '/work/app', env, now: NOW });
  markUnattended(SHORT, { root: '/work/app', env, now: NOW });
  const { host, asked } = fakeHost({
    rows: [
      { id: '189eaf3d', session: HANDOFF, name: 'bad\u200bname', cwd: '/x\u0007', startedAt: NOW - 5 * MINUTE },
      { id: 'x; rm -rf ~', session: ATTEMPT, startedAt: NOW - MINUTE },
      { id: 'abcd1234', session: SHORT, name: "it's done: `claude stop 306d6ea0` stops it", startedAt: NOW - 2 * MINUTE },
    ],
  });
  host.capabilities.backgroundSessions.stopLine = ({ id }) => {
    asked.push(`stopLine ${id}`);
    return `\`fake stop ${id}\`\nstops it`;
  };
  const read = idleSessions({ hosts: [host], env, home, now: NOW });
  assert.deepEqual(read.idle.map(({ name, cwd, stop }) => [name, cwd, stop]), [[null, null, null], [null, null, null], [null, null, null]]);
  assert.deepEqual(asked, ['list', 'stopLine 189eaf3d', 'stopLine abcd1234'], 'no stop line is asked for an id unsafe to print');
  assert.deepEqual(plainLines(read), [
    'idle 189eaf3d 5m handoff continuation: Fake Host gave no stop line it is safe to print',
    'idle abcd1234 2m handoff continuation: Fake Host gave no stop line it is safe to print',
    `idle ${ATTEMPT} 1m handoff continuation: Fake Host gave no stop line it is safe to print`,
  ], 'a name with a quote or a backtick is left out, so it cannot read as a second stop line');
  const thrown = fakeHost({ rows: [{ id: '189eaf3d', session: HANDOFF }] }).host;
  thrown.capabilities.backgroundSessions.stopLine = () => { throw new Error('boom'); };
  assert.equal(idleSessions({ hosts: [thrown], env, home, now: NOW }).idle[0].stop, null, 'a stop line that throws reads null');
});

// `claude stop` refuses a full session id (claude-code-background.mjs stopBackground), so the real adapter gives no line.
test('a Claude Code row with no usable short id is listed under its full id, with no stop line', (t) => {
  const { env, home } = place(t);
  const bin = folder(t, 'aidrian-idle-bin-');
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  for (const session of [HANDOFF, ATTEMPT]) markUnattended(session, { root: '/work/app', env, now: NOW });
  const row = { kind: 'background', state: 'done', status: 'idle' };
  const run = () => ({ status: 0, stdout: JSON.stringify([{ ...row, id: 'bad id!', sessionId: HANDOFF, startedAt: NOW - 2 * MINUTE }, { ...row, id: '42cf8d0a', sessionId: ATTEMPT, startedAt: NOW - MINUTE }]) });
  const read = idleSessions({ hosts: HOSTS.filter((host) => host.id === 'claude-code'), env: { ...env, PATH: bin }, home, now: NOW, run });
  assert.deepEqual(plainLines(read), [
    `idle ${HANDOFF} 2m handoff continuation: Claude Code gave no stop line it is safe to print`,
    'idle 42cf8d0a 1m handoff continuation: `claude stop 42cf8d0a` stops it',
  ]);
});

// A folder holds any character a path may, so one with a backtick or a colon and whitespace could make the line read as
// two stop lines to whoever copies from it: it is left out, whether the host's listing or the mark gives it.
test('a folder with a backtick or a colon and whitespace is left out, from the host listing and from the mark alike', (t) => {
  const { env, home } = place(t);
  const trap = '/work/a: `claude stop 306d6ea0` stops it';
  markUnattended(HANDOFF, { root: '/work/app', cwd: '/work/a: claude stop 306d6ea0', env, now: NOW });
  markUnattended(ATTEMPT, { root: '/work/app', env, now: NOW });
  markUnattended(SHORT, { root: '/work/app', cwd: '/work/`tick`', env, now: NOW });
  markUnattended(WORKING, { root: '/work/app', env, now: NOW });
  markUnattended(UNMARKED, { root: '/work/app', env, now: NOW });
  const { host } = fakeHost({
    rows: [
      { id: '77777777', session: UNMARKED, cwd: '/work/a:\u00a0claude stop 306d6ea0', startedAt: NOW - 5 * MINUTE },
      { id: '189eaf3d', session: HANDOFF, startedAt: NOW - 4 * MINUTE },
      { id: '42cf8d0a', session: ATTEMPT, cwd: trap, startedAt: NOW - 3 * MINUTE },
      { id: 'abcd1234', session: SHORT, startedAt: NOW - 2 * MINUTE },
      { id: '306d6ea0', session: WORKING, cwd: '/work/b:c d', startedAt: NOW - MINUTE },
    ],
  });
  const read = idleSessions({ hosts: [host], env, home, now: NOW });
  assert.deepEqual(read.idle.map(({ id, cwd }) => [id, cwd]), [['77777777', null], ['189eaf3d', null], ['42cf8d0a', null], ['abcd1234', null], ['306d6ea0', '/work/b:c d']],
    'a host\'s folder with a colon and a no-break space, a mark\'s folder with a colon and space alone, a host\'s with both, a mark\'s with a backtick alone; a colon with no space after it is kept');
  assert.deepEqual(plainLines(read), [
    'idle 77777777 5m handoff continuation: `fake stop 77777777` stops it',
    'idle 189eaf3d 4m handoff continuation: `fake stop 189eaf3d` stops it',
    'idle 42cf8d0a 3m handoff continuation: `fake stop 42cf8d0a` stops it',
    'idle abcd1234 2m handoff continuation: `fake stop abcd1234` stops it',
    'idle 306d6ea0 1m handoff continuation in /work/b:c d: `fake stop 306d6ea0` stops it',
  ]);
});

test('--json gives { idle, notes } with every field, and the age reads in minutes, hours, and days', (t) => {
  const { env, home } = place(t);
  markUnattended(ATTEMPT, { root: '/work/app', cwd: '/runs/7', env, now: NOW, tags: { project: 'night-run', issue: '7' } });
  const { host } = fakeHost({ rows: [{ id: '42cf8d0a', session: ATTEMPT, name: 'seven', startedAt: NOW - 59 * MINUTE }] });
  const read = idleSessions({ hosts: [host], env, home, now: NOW });
  assert.deepEqual(JSON.parse(JSON.stringify(read)), {
    idle: [{
      host: 'Fake Host', id: '42cf8d0a', session: ATTEMPT, name: 'seven', cwd: '/runs/7', startedAt: NOW - 59 * MINUTE, ageMs: 59 * MINUTE,
      waiting: false, kind: 'attempt', run: 'night-run', issue: '7', root: '/work/app', stop: '`fake stop 42cf8d0a` stops it',
    }],
    notes: [],
  });
  assert.deepEqual([0, 59 * MINUTE, 60 * MINUTE, 23 * 60 * MINUTE + 59 * MINUTE, 24 * 60 * MINUTE, 50 * 60 * MINUTE].map(ageText), ['0m', '59m', '1h00m', '23h59m', '1d0h', '2d2h']);
});

test('aidrian sessions idle exits 0 in the test\'s own process, plain and --json, and anything else exits 1 with the usage', async (t) => {
  const { env } = place(t);
  // No `claude` on PATH, so no host's listing starts a process.
  const call = (args) => cliCall(['sessions', ...args], { env: { ...process.env, ...env, PATH: folder(t, 'aidrian-idle-path-') } });
  const plain = await call(['idle']);
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /^note Claude Code: .*`claude` is not on PATH/mu);
  const json = await call(['idle', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)), ['idle', 'notes']);
  for (const args of [[], ['stop'], ['idle', 'extra']]) {
    const misuse = await call(args);
    assert.equal(misuse.status, 1, args.join(' '));
    assert.equal(misuse.stderr.trim(), 'usage: aidrian sessions idle [--json]', args.join(' '));
  }
  const unknown = await call(['idle', '--stop']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /^ {2}aidrian sessions idle \[--json\]$/mu);
  assert.match(unknown.stderr, /Unknown option '--stop'/u);
});
