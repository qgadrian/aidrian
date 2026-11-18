// `aidrian session snapshot` across a handoff (lib/session-links.mjs): the pull requests and the ticket of the sessions a
// chain floor's `parent` leads back to, each file read once, and no row value in any process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { noteFrom, openStore, storeNames } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { findProject, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { readRows } from '../plugins/aidrian/lib/session-rows.mjs';
import { snapshot } from '../plugins/aidrian/lib/session-snapshot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/lib/cli.mjs');
const POSIX = process.platform !== 'win32';
const ID = 'kid-1';
const PARENT = 'mom-1';
const GIT_CONFIG_NONE = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const REAL_GIT = POSIX ? spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim() : 'git';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_CONFIG_NONE, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

// A project on `branch` whose `upstream` remote names acme/notes on github.com (origin stays unset, so the merged-heads
// read starts no forge call), with its own state root, a fake gh that logs each call and answers what `answer` last set,
// and a fake git before the real one that logs each call's argv, folder, and environment.
function setup({ branch = 'main', remotes = { upstream: 'https://github.com/acme/notes.git' }, failRemotes = false } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-snapshot-links-')));
  const dir = path.join(base, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  git(dir, 'init', '-q', '-b', branch);
  for (const [name, url] of Object.entries(remotes)) git(dir, 'remote', 'add', name, url);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'start');
  const state = path.join(base, 'state');
  mkdirSync(state, { mode: 0o700 });
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const ghLog = path.join(base, 'gh.log');
  const gitLog = path.join(base, 'git.log');
  const answerFile = path.join(base, 'answer.json');
  const record = (log) => `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env, input }) + '\\n');\n`;
  writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}\nconst fs = require('node:fs');\nconst input = process.argv.includes('--input') ? fs.readFileSync(0, 'utf8') : null;\n${record(ghLog)}` +
    `const { text } = JSON.parse(fs.readFileSync(${JSON.stringify(answerFile)}, 'utf8'));\nprocess.stdout.write(text);\n`);
  const fail = failRemotes ? `if (process.argv.includes('--get-regexp')) { process.exitCode = 128; return; }\n` : '';
  writeFileSync(path.join(bin, 'git'), `#!${process.execPath}\nconst input = null;\n${record(gitLog)}(() => {\n${fail}` +
    `const r = require('node:child_process').spawnSync(${JSON.stringify(REAL_GIT)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.exitCode = r.status ?? 1;\n})();\n`);
  chmodSync(path.join(bin, 'gh'), 0o755);
  chmodSync(path.join(bin, 'git'), 0o755);
  const answer = (value) => writeFileSync(answerFile, JSON.stringify({ text: JSON.stringify(value) }));
  answer({ data: {} });
  const env = { ...process.env, ...GIT_CONFIG_NONE, XDG_STATE_HOME: state, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (args = []) => {
    const result = spawnSync(process.execPath, [CLI, 'session', 'snapshot', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const projectState = spawnSync(process.execPath, [CLI, 'state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  const store = openStore(projectState, { checkouts: [], maxChain: 3 });
  const folder = (id) => {
    const made = path.join(projectState, 'sessions', id);
    mkdirSync(made, { recursive: true, mode: 0o700 });
    return made;
  };
  const ledger = (id, rows) => writeFileSync(path.join(folder(id), 'prs.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''), { mode: 0o600 });
  const hop = (child, parent, at = Date.now()) => noteFrom(store, child, { slug: 'task', chain: 1, brief: path.join(store.handoffs, '2026-11-17-task.md'), route: 'clear', parent }, { now: at });
  const lines = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const ghCalls = () => lines(ghLog);
  const gitCalls = () => lines(gitLog);
  const variables = () => ghCalls().filter((call) => call.input).map((call) => JSON.parse(call.input).variables);
  return { base, dir, state, env, run, answer, ledger, hop, folder, projectState, store, ghCalls, gitCalls, variables };
}

// One ledger row, `minute` minutes past an hour that is past.
const row = (fields, minute = 0) => ({
  at: new Date(Date.UTC(2026, 10, 18, 8, minute)).toISOString(), agentId: null, kind: 'created', forge: 'github', host: 'github.com',
  path: 'acme/notes', number: null, branch: null, cwd: ROOT, ...fields,
});
const node = (number, fields = {}) => ({
  number, title: `Change ${number}`, url: `https://github.com/acme/notes/pull/${number}`, isDraft: false, state: 'OPEN', mergeable: 'MERGEABLE', reviewDecision: null,
  createdAt: '2026-11-18T07:00:00Z', headRefName: 'feat/x', headRepository: { name: 'notes', owner: { login: 'acme' } }, repository: { name: 'notes', owner: { login: 'acme' } },
  reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: null } }] }, ...fields,
});
// The forge's answer, one alias a ref, in the order the refs are sent: a number gives its node, a branch none.
const answerFor = (numbers, states = {}) => ({ data: Object.fromEntries(numbers.map((number, index) => [`r${index}`, { pullRequest: node(number, { state: states[number] ?? 'OPEN' }) }])) });
const sentNumbers = (vars) => Object.keys(vars).filter((key) => /^p\d+$/u.test(key)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((key) => vars[key]);

test('the parent`s created and pushed refs follow the session`s own, open ones shown with inherited true', { skip: !POSIX }, () => {
  const env = setup();
  env.ledger(ID, [1, 2, 3].map((number) => row({ number }, 30 + number)));
  env.ledger(PARENT, [
    row({ number: 4 }, 1), row({ number: 5 }, 2), row({ kind: 'pushed', number: 6 }, 3), row({ number: 7 }, 4),
    row({ number: 3 }, 5),
  ]);
  env.hop(ID, PARENT);
  env.answer(answerFor([3, 2, 1, 7, 6, 5, 4], { 2: 'MERGED', 5: 'MERGED', 4: 'CLOSED' }));
  const json = env.run(['--session', ID]);
  assert.deepEqual(sentNumbers(env.variables()[0]), [3, 2, 1, 7, 6, 5, 4], 'own first, newest first, then the parent`s; #3 once');
  assert.equal(env.variables().length, 1, 'one forge call');
  assert.deepEqual(json.prs.map(({ number, inherited, state }) => [number, inherited, state]), [[3, false, 'open'], [2, false, 'merged'], [1, false, 'open'], [7, true, 'open'], [6, true, 'open']],
    'an own merged one shows; an inherited merged or closed one does not, though it was sent');
  assert.deepEqual(json.errors, []);
});

test('a parent`s touched rows, and its rows on a repository the remotes do not name, are neither sent nor shown', { skip: !POSIX }, () => {
  const env = setup();
  env.ledger(ID, [row({ kind: 'touched', number: 1, path: 'outsider/x' }, 40)]);
  env.ledger(PARENT, [
    row({ kind: 'touched', number: 2 }, 1), row({ kind: 'touched', branch: 'fix/9-touched' }, 2),
    row({ number: 3, path: 'other/repo' }, 3), row({ kind: 'pushed', branch: 'feat/other', path: 'other/repo' }, 4),
  ]);
  env.hop(ID, PARENT);
  env.answer({ data: { r0: { pullRequest: node(1, { repository: { name: 'x', owner: { login: 'outsider' } }, url: 'https://github.com/outsider/x/pull/1' }) } } });
  const json = env.run(['--session', ID]);
  assert.deepEqual(env.variables().map((vars) => sentNumbers(vars)), [[1]], 'the session`s own touched ref on another repository alone');
  assert.deepEqual(json.prs.map(({ number, inherited }) => [number, inherited]), [[1, false]]);
  assert.equal(json.ticket, null, 'a parent`s touched branch gives no ticket');
});

test('25 own refs leave the parent`s file unread; 20 own and 10 of the parent send the 20 and its 5 newest', { skip: !POSIX }, () => {
  const env = setup();
  env.ledger(ID, Array.from({ length: 25 }, (_, index) => row({ number: index + 1 }, index)));
  env.folder(PARENT);
  spawnSync('mkfifo', [path.join(env.projectState, 'sessions', PARENT, 'prs.jsonl')]);
  env.hop(ID, PARENT);
  env.answer(answerFor(Array.from({ length: 25 }, (_, index) => 25 - index)));
  const full = env.run(['--session', ID, '--ticket-prefixes', 'ABC']);
  assert.deepEqual([full.prs.length, full.errors], [25, []], 'a named pipe at the parent`s ledger fails nothing');
  const env2 = setup();
  env2.ledger(ID, Array.from({ length: 20 }, (_, index) => row({ number: index + 1 }, 30 + index)));
  env2.ledger(PARENT, Array.from({ length: 10 }, (_, index) => row({ number: 101 + index }, index)));
  env2.hop(ID, PARENT);
  env2.answer({ data: {} });
  env2.run(['--session', ID]);
  const sent = sentNumbers(env2.variables()[0]);
  assert.deepEqual(sent, [...Array.from({ length: 20 }, (_, index) => 20 - index), 110, 109, 108, 107, 106]);
});

test('a parent`s pushed row on gitlab.com, in a project whose remote names it, counts and shows unsupported and inherited', { skip: !POSIX }, () => {
  const env = setup({ remotes: { upstream: 'https://gitlab.com/acme/notes.git' } });
  env.ledger(ID, []);
  env.ledger(PARENT, [row({ kind: 'pushed', host: 'gitlab.com', branch: 'feat/x' }, 1)]);
  env.hop(ID, PARENT);
  const json = env.run(['--session', ID]);
  assert.deepEqual(json.prs.map(({ host, unsupported, inherited }) => [host, unsupported, inherited]), [['gitlab.com', true, true]]);
  assert.deepEqual(env.ghCalls(), []);
});

test('remotes that git cannot read hand nothing down, and fail no section', { skip: !POSIX }, () => {
  const env = setup({ failRemotes: true });
  env.ledger(ID, [row({ number: 1 }, 40)]);
  env.ledger(PARENT, [row({ number: 2 }, 1), row({ kind: 'pushed', branch: 'fix/5-parent' }, 2)]);
  env.hop(ID, PARENT);
  env.answer(answerFor([1]));
  const json = env.run(['--session', ID]);
  assert.deepEqual(sentNumbers(env.variables()[0]), [1]);
  assert.deepEqual([json.prs.map(({ number }) => number), json.ticket, json.errors], [[1], null, []]);
});

test('a row dated next year is dropped, own or inherited: not sent, not shown, and no ticket; 30 seconds ahead is kept', { skip: !POSIX }, () => {
  const env = setup();
  const nextYear = new Date(Date.now() + 365 * 86_400_000).toISOString();
  env.ledger(ID, [row({ kind: 'pushed', branch: 'fix/1-future', at: nextYear })]);
  assert.deepEqual([env.run(['--session', ID]).prs, env.run(['--session', ID]).errors, env.run(['--session', ID]).ticket], [[], [], null]);
  env.ledger(ID, [row({ number: 2, at: nextYear }), row({ number: 3, at: new Date(Date.now() + 30_000).toISOString() })]);
  env.ledger(PARENT, [row({ number: 4, at: nextYear }), row({ kind: 'pushed', branch: 'fix/5-future', at: nextYear })]);
  env.hop(ID, PARENT, Date.now());
  env.answer(answerFor([3]));
  const json = env.run(['--session', ID]);
  assert.deepEqual(sentNumbers(env.variables().at(-1)), [3]);
  assert.deepEqual([json.prs.map(({ number }) => number), json.ticket], [[3], null]);
});

test('the ticket comes from the current branch, else the session`s pushed rows, else the parent`s as cut', { skip: !POSIX }, () => {
  const env = setup();
  env.ledger(ID, [row({ kind: 'pushed', branch: 'fix/42-login' }, 1)]);
  assert.deepEqual(env.run(['--session', ID]).ticket, { key: '#42', source: 'ledger' });
  env.ledger(ID, [row({ kind: 'pushed', branch: 'feat/abc-7-x' }, 1)]);
  assert.deepEqual(env.run(['--session', ID, '--ticket-prefixes', 'ABC']).ticket, { key: 'ABC-7', source: 'ledger' });
  assert.equal(env.run([]).ticket, null, 'without --session no ledger is read');
  assert.equal(env.run([]).errors.includes('ticket'), false);
  env.ledger(ID, []);
  env.ledger(PARENT, [row({ kind: 'pushed', branch: 'fix/5-parent' }, 1)]);
  env.hop(ID, PARENT);
  assert.deepEqual(env.run(['--session', ID]).ticket, { key: '#5', source: 'ledger' });
  const keyed = setup({ branch: 'fix/9-here' });
  keyed.ledger(ID, [row({ kind: 'pushed', branch: 'fix/42-login' }, 1)]);
  assert.deepEqual(keyed.run(['--session', ID]).ticket, { key: '#9', source: 'branch' });
});

test('no row value reaches a process: no argv, environment, or folder of git or gh holds one', { skip: !POSIX }, () => {
  const env = setup();
  const madeUp = path.join(env.base, 'made', 'up');
  const branch = 'fix/7--upload-pack=evil';
  env.ledger(ID, [row({ kind: 'pushed', branch, cwd: madeUp }, 1)]);
  env.ledger(PARENT, [row({ kind: 'pushed', branch: 'feat/parent-branch', cwd: madeUp }, 2)]);
  env.hop(ID, PARENT);
  env.run(['--session', ID]);
  const calls = [...env.gitCalls(), ...env.ghCalls()];
  assert.ok(calls.length > 0);
  for (const call of calls) {
    const seen = JSON.stringify([call.args, call.env]);
    for (const value of [branch, 'feat/parent-branch', madeUp, PARENT]) assert.ok(!seen.includes(value), `${value} in ${call.args.join(' ')}`);
    assert.ok(!call.cwd.startsWith(madeUp));
  }
  assert.equal(existsSync(madeUp), false);
  const own = env.gitCalls().filter(({ args }) => ['--get-regexp', 'symbolic-ref'].some((word) => args.includes(word)));
  for (const { cwd } of own) assert.equal(cwd, env.dir, 'in the process`s own folder');
  assert.deepEqual(own.filter(({ args }) => args.includes('--get-regexp')).map(({ args }) => args), [['config', '--get-regexp', '^(remote\\..*\\.(url|pushurl)|branch\\..*\\.merge)$']], 'the remotes, once, with constant arguments');
  assert.ok(own.some(({ args }) => args.join(' ') === 'symbolic-ref --quiet --short HEAD'));
  assert.ok(own.some(({ args }) => args[0] === 'config' && args[1] === '--get-regexp'));
  const alone = setup();
  alone.ledger(ID, [row({ number: 1 }, 1)]);
  alone.answer(answerFor([1]));
  alone.run(['--session', ID]);
  assert.equal(alone.gitCalls().some(({ args }) => args.includes('--get-regexp')), false, 'a session with no floor reads no remotes');
});

// The snapshot run in this process, with the state root of `env`, and counters on the readers it shares.
function inProcess(env, options) {
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = env.state;
  try {
    assert.equal(stateDir(findProject(env.dir)), env.projectState);
    return snapshot({ cwd: env.dir, session: ID, ...options });
  } finally {
    process.env.XDG_STATE_HOME = saved;
  }
}

test('one snapshot lists the store once, reads each ledger once, and lists the sessions folder only for a short floor', { skip: !POSIX }, () => {
  const env = setup();
  const transcript = path.join(env.base, 'session.jsonl');
  writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: 'hi' } })}\n`);
  env.ledger(ID, [row({ number: 1 }, 40)]);
  for (const [child, parent] of [[ID, 'a-1'], ['a-1', 'b-1'], ['b-1', 'c-1']]) {
    env.hop(child, parent);
    env.ledger(parent, [row({ number: parent.charCodeAt(0) }, 1)]);
  }
  const counts = { store: 0, names: 0, reads: new Map() };
  const io = {
    storeNames: (store) => (counts.store += 1, storeNames(store)),
    sessionNames: () => (counts.names += 1, []),
    readRows: (folder, name, options) => {
      const key = `${path.basename(folder)}/${name}`;
      counts.reads.set(key, (counts.reads.get(key) ?? 0) + 1);
      return readRows(folder, name, options);
    },
  };
  const snap = inProcess(env, { transcript, io, ticketPrefixes: '' });
  assert.equal(snap.handoff.chain, 1, 'the handoff section read the floor');
  assert.equal(counts.store, 1, 'the store is listed once, its handoff section included');
  assert.equal(counts.names, 0, 'every floor under a full id: the sessions folder is not listed');
  assert.deepEqual([...counts.reads.values()].every((count) => count === 1), true, JSON.stringify([...counts.reads]));
  assert.deepEqual([...counts.reads.keys()].sort(), ['a-1/prs.jsonl', 'b-1/prs.jsonl', 'c-1/prs.jsonl', `${ID}/prs.jsonl`]);
  const short = setup();
  short.ledger(ID, []);
  noteFrom(short.store, 'kid-', { slug: 'task', chain: 1, brief: path.join(short.store.handoffs, '2026-11-17-task.md'), route: 'clear', parent: PARENT });
  short.ledger(PARENT, [row({ number: 8 }, 1)]);
  const listed = { names: 0 };
  inProcess(short, { io: { sessionNames: () => (listed.names += 1, []) } });
  assert.equal(listed.names, 1, 'a floor under a short id: listed once');
});
