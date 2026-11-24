// The record of a project run (lib/project-run.mjs): init validates the snapshot input and starts a run only for an
// attended main session, in a state folder held as the background route holds its store, pins the repository, the driver's
// session, and the snapshot's hash in the ledger's first row, and keeps one run active per project; the ledger is appended
// under its lock; summary.md is written from the ledger. No tracker text but the branch enters the run's state.
// Temporary repositories are made with `git init` under mkdtemp and driven with `git -C`; no test sets GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import { SCHEMA } from '../plugins/aidrian/lib/config-schema.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { noteFrom, openStore, storePath } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { LOCKED } from '../plugins/aidrian/lib/jsonl.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { appendToRun, INPUT_CAP, initRun, issueBranch, pinnedRepository, planRun, readCapped, readRun, runFolder, runPlace, runsFolder, writeSummary } from '../plugins/aidrian/lib/project-run.mjs';
import { markPending, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { recordIssue } from './project-start-fixture.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SESSION = 'abcd1234-0000-4000-8000-00000000aa01';

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { stdio: 'pipe' });

// A project on `main` whose origin is `remote`, with `config` committed, its own marks folder and home, and an input
// writer. Unless `config` says otherwise, it commits a state.dir of its own, so the run's folder is that one.
function setup(t, { remote = 'git@github.com:Acme/widgets.git', config, stateDir } = {}) {
  const dir = folder(t, 'aidrian-run-');
  const git = gitIn(dir);
  const state = stateDir === undefined ? folder(t, 'aidrian-run-state-') : stateDir;
  const committed = config ?? { version: 1, state: { dir: state } };
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(committed));
  writeFileSync(path.join(dir, '.gitignore'), 'snapshot*.json\n*.json.input\n');
  git('init', '-q', '-b', 'main');
  if (remote) git('remote', 'add', 'origin', remote);
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  // With a remote, the base is origin's default branch: no local branch stands in for it.
  if (remote) git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const project = findProject(dir);
  const loaded = loadConfig(project).config;
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-run-marks-') };
  const home = folder(t, 'aidrian-run-home-');
  const input = (value, name = 'snapshot.json') => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  const init = (run, file, more = {}) => initRun({ project, config: loaded, run, file, session: SESSION, env, home, ...more });
  return { dir, git, project, config: loaded, state, env, home, input, init };
}

const SNAPSHOT = {
  project: 'Launch plan',
  issues: [
    { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted', priority: 1, title: 'Export the report', description: 'Long body text' },
    { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'backlog', blockedBy: ['ENG-1'], priority: 2, title: 'Import' },
    { key: 'ENG-3', branch: 'feat/eng-3-share', status: 'unstarted', blockedBy: ['ENG-2'] },
    { key: 'ENG-4', branch: 'fix/eng-4-typo', status: 'unstarted', priority: 3 },
  ],
  outside: [{ key: 'OPS-1', status: 'completed', title: 'Other team' }],
};

const ledgerPath = (state, run) => path.join(runFolder(state, run), 'ledger.jsonl');
const ledgerRows = (state, run) => readFileSync(ledgerPath(state, run), 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('init keeps the snapshot without tracker text but the branch, and pins the repository, session, and snapshot hash', (t) => {
  const { dir, state, input, init } = setup(t);
  const result = init('launch', input(SNAPSHOT));
  assert.deepEqual([result.exitCode, result.err], [0, []]);
  assert.deepEqual(result.out.slice(0, 3), ['run: launch', 'issues: 4', 'repository: github.com/acme/widgets']);
  assert.match(result.out.join('\n'), /dropped: 5 fields the snapshot never keeps/u);
  assert.equal(runFolder(state, 'launch'), path.join(state, 'runs', 'launch'));
  const snapshot = readFileSync(path.join(runFolder(state, 'launch'), 'snapshot.json'), 'utf8');
  assert.doesNotMatch(snapshot, /Export the report|Long body|Launch plan|Other team|title|description/u);
  assert.deepEqual(JSON.parse(snapshot).issues[1], { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'backlog', blockedBy: ['ENG-1'], priority: 2 });
  const [first, ...rest] = ledgerRows(state, 'launch');
  assert.deepEqual(rest, []);
  const hash = execFileSync('shasum', ['-a', '256', path.join(runFolder(state, 'launch'), 'snapshot.json')], { encoding: 'utf8' }).split(' ')[0];
  // `main`: the run's main checkout by its real path, which an attempt clone stands for (lib/attempt-clone.mjs).
  assert.deepEqual({ ...first, at: null }, { event: 'init', run: 'launch', at: null, session: SESSION, repository: { host: 'github.com', owner: 'acme', name: 'widgets' }, main: realpathSync(dir), issues: 4, sha256: hash });
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
});

test('init names the workspace\'s teams the snapshot leaves out, which the closing-word check reads keys against', (t) => {
  const note = 'teams: the snapshot names no "teams", so keys of teams outside the run will not be seen by the closing-word check; give every team key of the tracker workspace in "teams"';
  const missing = setup(t);
  const bare = missing.init('launch', missing.input(SNAPSHOT));
  assert.equal(bare.exitCode, 0, bare.err.join('\n'));
  assert.ok(bare.out.includes(note), bare.out.join('\n'));
  const empty = setup(t);
  assert.ok(empty.init('launch', empty.input({ ...SNAPSHOT, teams: [] })).out.includes(note), 'an empty list names no team');
  const named = setup(t);
  const full = named.init('launch', named.input({ ...SNAPSHOT, teams: ['ENG', 'OPS', 'WEB'] }));
  assert.equal(full.exitCode, 0, full.err.join('\n'));
  assert.equal(full.out.some((line) => line.startsWith('teams:')), false, full.out.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(runFolder(named.state, 'launch'), 'snapshot.json'), 'utf8')).teams, ['ENG', 'OPS', 'WEB']);
  // Keys that are numbers alone, as a forge's issues have, carry no team to name.
  const numbered = setup(t);
  const plain = numbered.init('launch', numbered.input({ issues: [{ key: '12', branch: 'feat/12-export', status: 'unstarted' }] }));
  assert.equal(plain.exitCode, 0, plain.err.join('\n'));
  assert.equal(plain.out.some((line) => line.startsWith('teams:')), false, plain.out.join('\n'));
});

test('the run stores no projectRun value from the working copy', (t) => {
  const state = folder(t, 'aidrian-run-state-');
  const { input, init } = setup(t, { config: { version: 1, state: { dir: state }, projectRun: { maxParallel: 4 } } });
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  assert.equal(JSON.stringify(ledgerRows(state, 'launch')).includes('maxParallel'), false);
});

test('one run per project is active: a second run waits until the first is done, and a run id is never reused', (t) => {
  const { state, input, init } = setup(t);
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  assert.match(init('launch', input(SNAPSHOT)).err[0], /the run launch exists already/u);
  const other = init('second', input(SNAPSHOT));
  assert.deepEqual([other.exitCode, other.err], [1, [`aidrian project init: the run launch is still active in ${runFolder(state, 'launch')}; finish it, or remove its folder, before another starts`]]);
  assert.ok(!existsSync(runFolder(state, 'second')));
  for (const key of ['ENG-1', 'ENG-2', 'ENG-3']) recordIssue(state, 'launch', { key, state: 'done' });
  recordIssue(state, 'launch', { key: 'ENG-4', state: 'parked', decision: 'typo-scope' });
  assert.equal(init('second', input(SNAPSHOT)).exitCode, 0, 'nothing runs or may start in the first run, so it is done');
});

test('a landed row that names no branch carries nothing on', (t) => {
  const { state, input, init } = setup(t);
  const at = new Date().toISOString();
  const issue = { issues: [{ key: 'ENG-1', branch: 'feat/eng-1-export', status: 'started' }] };
  // The run the row names, and the run that wrote it, both on the snapshot's branch: neither tells which branch the
  // merge was checked for, so a match with either proves nothing.
  // Each run inits a minute after the one before, so which is the latest never rests on the clock's resolution.
  const minute = (n) => ({ now: Date.now() + n * 60_000 });
  assert.equal(init('zero', input({ issues: [{ key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted' }] }, 'zero.json'), minute(0)).exitCode, 0);
  appendToRun(state, 'zero', () => ({ rows: [{ event: 'issue', key: 'ENG-1', state: 'parked', decision: 'pr-open', at }] }));
  assert.equal(init('first', input(issue, 'first.json'), minute(1)).exitCode, 0);
  appendToRun(state, 'first', () => ({ rows: [{ event: 'landed', key: 'ENG-1', run: 'zero', attempt: 1, pr: 12, at }, { event: 'issue', key: 'ENG-1', state: 'done', at }] }));
  const next = init('second', input(issue, 'second.json'), minute(2));
  assert.equal(next.exitCode, 0, next.err.join('\n'));
  assert.equal(next.out.some((line) => line.startsWith('landed:')), false, 'which branch its merge was checked for cannot be told');
  assert.deepEqual(planRun(readRun(state, 'second').snapshot, readRun(state, 'second').states).blocked, [{ key: 'ENG-1', reason: 'status', on: ['started'] }]);
});

test('init starts a started issue an earlier run parked on the same branch, and keeps every other started issue blocked', (t) => {
  const { state, input, init } = setup(t);
  const first = { issues: [
    { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted' },
    { key: 'ENG-5', branch: 'feat/eng-5-done', status: 'unstarted' },
    { key: 'ENG-6', branch: 'feat/eng-6-moved', status: 'unstarted' },
  ] };
  assert.equal(init('first', input(first, 'first.json')).exitCode, 0);
  const at = new Date().toISOString();
  // ENG-1 parked on its pull request; ENG-6 parked after its latest attempt moved to a branch no attempt cuts; ENG-5 merged.
  appendToRun(state, 'first', () => ({ rows: [
    { event: 'result', key: 'ENG-1', attempt: 1, status: 'pr_open', pr: 12, head: 'a'.repeat(40), at },
    { event: 'issue', key: 'ENG-1', state: 'parked', decision: 'pr-open', at },
    { event: 'start', key: 'ENG-6', attempt: 2, branch: 'feat/eng-6-other', outcome: 'started', at },
    { event: 'issue', key: 'ENG-6', state: 'parked', decision: 'blocked', at },
    { event: 'issue', key: 'ENG-5', state: 'done', at },
  ] }));
  const second = { issues: [
    { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'started' },
    { key: 'ENG-6', branch: 'feat/eng-6-moved', status: 'started' },
    { key: 'ENG-7', branch: 'feat/eng-7-outside', status: 'started' },
    { key: 'ENG-8', branch: 'feat/eng-8-renamed', status: 'unstarted' },
  ], resumed: [{ key: 'ENG-7', run: 'first', pr: null }] };
  const result = init('second', input(second, 'second.json'));
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.ok(result.out.includes('resumed: 1 started issue an earlier run parked on its branch, which this run starts again: ENG-1'), result.out.join('\n'));
  const found = readRun(state, 'second');
  assert.equal(found.problem, undefined);
  // The driver's own `resumed` is dropped: only init's read of the earlier runs names one.
  assert.deepEqual(found.snapshot.resumed, [{ key: 'ENG-1', run: 'first', pr: 12, head: 'a'.repeat(40), branch: 'feat/eng-1-export' }]);
  const plan = planRun(found.snapshot, found.states, { maxParallel: 4 });
  assert.deepEqual(plan.next.map(({ key }) => key), ['ENG-1', 'ENG-8']);
  // ENG-6's work is on another branch than the snapshot names, and no run parked ENG-7: someone's work outside the run.
  assert.deepEqual(plan.blocked, [{ key: 'ENG-6', reason: 'status', on: ['started'] }, { key: 'ENG-7', reason: 'status', on: ['started'] }]);
  // The latest run that records an issue decides: ENG-1 is done in the second run, so a third does not resume it.
  for (const key of ['ENG-1', 'ENG-8']) appendToRun(state, 'second', () => ({ rows: [{ event: 'issue', key, state: 'done', at }] }));
  const later = init('third', input({ issues: [{ key: 'ENG-1', branch: 'feat/eng-1-export', status: 'started' }] }, 'third.json'));
  assert.equal(later.exitCode, 0, later.err.join('\n'));
  assert.equal(readRun(state, 'third').snapshot.resumed, undefined);
  assert.deepEqual(planRun(readRun(state, 'third').snapshot).blocked, [{ key: 'ENG-1', reason: 'status', on: ['started'] }]);
});

test('init resumes no parked issue of a run that pinned another repository, and carries a null head when the run recorded none', (t) => {
  const { git, state, input, init } = setup(t);
  const issues = [{ key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted' }, { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'unstarted' }];
  assert.equal(init('first', input({ issues }, 'first.json')).exitCode, 0);
  const at = new Date().toISOString();
  // ENG-1 parked before any push, so its result recorded no head; ENG-2 parked with no result at all.
  appendToRun(state, 'first', () => ({ rows: [
    { event: 'result', key: 'ENG-1', attempt: 1, status: 'blocked', pr: null, at },
    ...issues.map(({ key }) => ({ event: 'issue', key, state: 'parked', decision: 'blocked', at })),
  ] }));
  const started = { issues: issues.map((issue) => ({ ...issue, status: 'started' })) };
  // The same state folder after origin moved to another repository: the first run's work is not this one's.
  git('remote', 'set-url', 'origin', 'git@github.com:Acme/gadgets.git');
  const moved = init('moved', input(started, 'moved.json'));
  assert.equal(moved.exitCode, 0, moved.err.join('\n'));
  assert.equal(readRun(state, 'moved').snapshot.resumed, undefined);
  assert.deepEqual(planRun(readRun(state, 'moved').snapshot).blocked.map(({ key }) => key), ['ENG-1', 'ENG-2']);
  rmSync(runFolder(state, 'moved'), { recursive: true });
  git('remote', 'set-url', 'origin', 'git@github.com:Acme/widgets.git');
  assert.equal(init('second', input(started, 'second.json')).exitCode, 0);
  assert.deepEqual(readRun(state, 'second').snapshot.resumed, [{ key: 'ENG-1', run: 'first', pr: null, head: null, branch: 'feat/eng-1-export' }, { key: 'ENG-2', run: 'first', pr: null, head: null, branch: 'feat/eng-2-import' }]);
});

test('init resumes a parked issue on the attempt branch its earlier run cut from the snapshot\'s, and on no branch that run did not cut', (t) => {
  const { state, input, init } = setup(t);
  const issues = [
    { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted' },
    { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'unstarted' },
  ];
  assert.equal(init('first', input({ issues }, 'first.json')).exitCode, 0);
  const at = new Date().toISOString();
  const head = 'a'.repeat(40);
  // ENG-1's second attempt left its branch for a fresh one; ENG-2's latest start is on a name no attempt cuts.
  appendToRun(state, 'first', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 2, branch: 'feat/eng-1-export-a2', outcome: 'started', at },
    { event: 'result', key: 'ENG-1', attempt: 2, status: 'pr_open', pr: 10, head, at },
    { event: 'start', key: 'ENG-2', attempt: 2, branch: 'feat/eng-2-import-b2', outcome: 'started', at },
    ...issues.map(({ key }) => ({ event: 'issue', key, state: 'parked', decision: 'pr-open', at })),
  ] }));
  const started = { issues: issues.map((issue) => ({ ...issue, status: 'started' })) };
  const second = init('second', input(started, 'second.json'));
  assert.equal(second.exitCode, 0, second.err.join('\n'));
  const found = readRun(state, 'second');
  assert.deepEqual(found.snapshot.resumed, [{ key: 'ENG-1', run: 'first', pr: 10, head, branch: 'feat/eng-1-export-a2' }]);
  // The new run works on that branch from its first attempt, which every reader of the branch takes.
  assert.equal(issueBranch(found, 'ENG-1'), 'feat/eng-1-export-a2');
  assert.deepEqual(planRun(found.snapshot, found.states).blocked, [{ key: 'ENG-2', reason: 'status', on: ['started'] }]);
  // A third run, after the second parked ENG-1 with no start of its own: the second run never cut that branch.
  appendToRun(state, 'second', () => ({ rows: [{ event: 'issue', key: 'ENG-1', state: 'parked', decision: 'blocked', at }] }));
  assert.equal(init('third', input(started, 'third.json')).exitCode, 0);
  assert.equal(readRun(state, 'third').snapshot.resumed, undefined);
});

test('an attempt branch resumes only when cut from the snapshot\'s branch the earlier run named too, past the branch cap as the gate cuts it, and never onto another issue\'s branch', (t) => {
  const { state, input, init } = setup(t);
  const at = new Date().toISOString();
  // A run whose start of `key` at attempt 2 worked on `branch`, then parked it; its snapshot named `named`.
  const parked = (run, key, named, branch) => {
    assert.equal(init(run, input({ issues: [{ key, branch: named, status: 'unstarted' }] }, `${run}.json`)).exitCode, 0);
    appendToRun(state, run, () => ({ rows: [
      { event: 'start', key, attempt: 2, branch, outcome: 'started', at },
      { event: 'issue', key, state: 'parked', decision: 'pr-open', at },
    ] }));
  };
  // ENG-1's earlier snapshot named the -a2 branch itself: the run cut nothing from the branch the new snapshot names.
  parked('named', 'ENG-1', 'feat/eng-1-export-a2', 'feat/eng-1-export-a2');
  // ENG-2's snapshot branch is BRANCH_CAP long, and the gate cut its -a2 past it.
  const long = `feat/${'x'.repeat(115)}`;
  parked('long', 'ENG-2', long, `${long}-a2`);
  const result = init('second', input({ issues: [
    { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'started' },
    { key: 'ENG-2', branch: long, status: 'started' },
  ] }, 'second.json'));
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  const found = readRun(state, 'second');
  assert.equal(found.problem, undefined, 'a 123-character attempt branch passes the run\'s own checks');
  assert.deepEqual(found.snapshot.resumed.map(({ key, branch }) => [key, branch]), [['ENG-2', `${long}-a2`]]);
  assert.deepEqual(planRun(found.snapshot, found.states).blocked, [{ key: 'ENG-1', reason: 'status', on: ['started'] }]);
  appendToRun(state, 'second', () => ({ rows: [{ event: 'issue', key: 'ENG-2', state: 'done', at }] }));
  // ENG-3 resumes on feat/eng-3-share-a2, which ENG-4 names: two sessions would push to one ref, so init refuses.
  parked('third', 'ENG-3', 'feat/eng-3-share', 'feat/eng-3-share-a2');
  const clash = init('fourth', input({ issues: [
    { key: 'ENG-3', branch: 'feat/eng-3-share', status: 'started' },
    { key: 'ENG-4', branch: 'feat/eng-3-share-a2', status: 'unstarted' },
  ] }, 'fourth.json'));
  assert.deepEqual([clash.exitCode, clash.err], [1, [
    'aidrian project init: the snapshot input has problems; fix them and run init again',
    '  ENG-3 resumes on the branch feat/eng-3-share-a2, an earlier run\'s attempt branch, which ENG-4 names too; give one of them another branch',
  ]]);
  assert.equal(existsSync(runFolder(state, 'fourth')), false);
});

test('init holds the runs lock while it checks and makes the run: a live foreign lock makes it throw, and no run is made', (t) => {
  const { state, input, init } = setup(t);
  mkdirSync(runsFolder(state), { recursive: true });
  // Another live process holds the lock: this process's own pid, with a nonce it never wrote, so it is not held here.
  writeFileSync(path.join(runsFolder(state), '.runs.lock.99'), JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'other' }));
  assert.throws(() => init('launch', input(SNAPSHOT)), (error) => error.code === LOCKED);
  assert.ok(!existsSync(runFolder(state, 'launch')));
});

test('init refuses a subagent, a session with no id, an unattended mark, a pending hold, and a background floor, and writes nothing', (t) => {
  const { dir, project, config, state, env, input, init } = setup(t);
  const file = input(SNAPSHOT);
  const refused = (more) => {
    const result = init('launch', file, more);
    assert.equal(result.exitCode, 1);
    assert.ok(!existsSync(runsFolder(state)), 'nothing written');
    return result.err[0];
  };
  assert.match(refused({ input: { agent_id: 'agent-7' } }), /a subagent may not start a project run/u);
  assert.match(refused({ session: null }), /no session id/u);
  assert.match(refused({ session: 'not a session id' }), /no session id/u);

  const pending = markPending('abcd1234-0000-4000-8000-00000000ff01', { cwd: dir, root: dir, env });
  assert.ok(pending);
  assert.match(refused(), /starting a background session/u);
  rmSync(pending);

  const mark = markUnattended(SESSION, { root: dir, env });
  assert.ok(mark);
  assert.match(refused(), /the background handoff route started this session/u);
  rmSync(mark);

  assert.ok(noteFrom(openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain }), SESSION, { slug: 'widget', chain: 1, brief: path.join(state, 'handoffs/2026-11-15-widget.md'), route: 'background' }));
  assert.match(refused(), /the background handoff route started this session/u);
});

test('init fails closed on a continuation store it cannot read', (t) => {
  const { state, input, init } = setup(t);
  const store = storePath(state);
  mkdirSync(store, { recursive: true, mode: 0o700 });
  chmodSync(store, 0o000);
  let result;
  try {
    result = init('launch', input(SNAPSHOT));
  } finally {
    chmodSync(store, 0o700);
  }
  assert.equal(result.exitCode, 1);
  assert.match(result.err[0], /the continuation store .* cannot be read \(EACCES\), so whether the background handoff route started this session cannot be read/u);
  assert.ok(!existsSync(runsFolder(state)));
});

test('the run folder is the base branch\'s, under the host\'s own environment, and never a loose or linked folder', (t) => {
  // No state.dir: the folder under XDG_STATE_HOME must be the one under the user's own home.
  const plain = setup(t, { config: { version: 1 } });
  const elsewhere = runPlace(plain.project, plain.config, { env: plain.env, home: plain.home });
  assert.match(elsewhere.problem, /is not .*the one the base branch's config\.json names under the host's own environment, as an XDG_STATE_HOME or HOME set for this command would move it/u);
  assert.match(plain.init('launch', plain.input(SNAPSHOT)).err[0], /XDG_STATE_HOME or HOME/u);
  const own = runPlace(plain.project, plain.config, { env: { ...plain.env, XDG_STATE_HOME: path.join(plain.home, '.local/state') }, home: plain.home });
  assert.equal(own.problem, undefined);
  assert.ok(own.state.startsWith(path.join(plain.home, '.local/state', 'aidrian', 'projects')));

  // A working copy that moves state.dir away from the base branch's.
  const moved = setup(t);
  writeFileSync(path.join(moved.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: folder(t, 'aidrian-run-moved-') } }));
  const working = loadConfig(moved.project).config;
  assert.match(runPlace(moved.project, working, { env: moved.env, home: moved.home }).problem, /the working copy's state\.dir differs from the base branch's config\.json/u);

  // A state folder inside the checkout.
  const inside = setup(t, { config: { version: 1, state: { dir: 'run-state' } }, stateDir: null });
  assert.match(runPlace(inside.project, inside.config, { env: inside.env, home: inside.home }).problem, /is inside the checkout/u);

  // A state folder every user may write, and one behind a symlink.
  const loose = setup(t);
  chmodSync(loose.state, 0o777);
  assert.match(loose.init('launch', loose.input(SNAPSHOT)).err[0], /is writable by every user, so no project run is kept there/u);
  chmodSync(loose.state, 0o700);
  const target = folder(t, 'aidrian-run-target-');
  const linked = path.join(folder(t, 'aidrian-run-link-'), 'state');
  symlinkSync(target, linked);
  const behind = setup(t, { stateDir: linked });
  assert.match(runPlace(behind.project, behind.config, { env: behind.env, home: behind.home }).problem, /is a symlink/u);

  // No base branch git can read.
  const bare = folder(t, 'aidrian-run-bare-');
  mkdirSync(path.join(bare, '.aidrian'));
  writeFileSync(path.join(bare, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: folder(t, 'aidrian-run-state-') } }));
  gitIn(bare)('init', '-q', '-b', 'main');
  const unborn = findProject(bare);
  assert.match(runPlace(unborn, loadConfig(unborn).config, { home: plain.home }).problem, /git names no base branch commit/u);
});

test('init reads the input as a regular file with a size cap, never through a symlink, and checks the run id, branches, and origin', (t) => {
  const { dir, git, state, input, init } = setup(t);
  const real = input(SNAPSHOT);
  const link = path.join(dir, 'link.json.input');
  symlinkSync(real, link);
  assert.match(init('launch', link).err.join('\n'), /is a symlink/u);
  assert.match(init('launch', input(`${JSON.stringify(SNAPSHOT)}${' '.repeat(INPUT_CAP)}`, 'big.json.input')).err.join('\n'), /over the 1048576 it may hold/u);
  assert.match(init('launch', input('{ nope', 'bad.json.input')).err.join('\n'), /is not JSON/u);
  assert.match(init('launch', path.join(dir, 'missing.json')).err.join('\n'), /cannot be read \(ENOENT\)/u);
  assert.match(init('launch', dir).err.join('\n'), /is not a regular file/u);
  const bad = init('launch', input({ issues: [{ key: 'ENG-1', branch: '-rf', status: 'unstarted', title: 'x' }] }, 'dash.json.input'));
  assert.deepEqual(bad.err, ['aidrian project init: the snapshot input has problems; fix them and run init again', '  issues[0].branch "-rf" starts with a dash']);
  git('remote', 'add', 'upstream', 'git@github.com:acme/upstream.git');
  for (const [branch, why] of [['main', /is the default branch/u], ['origin/x', /starts with origin, the name of a remote/u], ['upstream/x', /starts with upstream/u]]) {
    assert.match(init('launch', input({ issues: [{ key: 'ENG-1', branch, status: 'unstarted' }] }, 'names.json.input')).err.join('\n'), why, branch);
  }
  for (const run of ['../x', 'Launch', '-x', '']) assert.match(init(run, real).err[0], /is not lower-case letters/u, run);
  assert.ok(!existsSync(runsFolder(state)));
  const local = setup(t, { remote: '/srv/git/widgets' });
  assert.match(local.init('launch', local.input(SNAPSHOT)).err[0], /the origin remote names no forge repository/u);
  const none = setup(t, { remote: null });
  assert.match(none.init('launch', none.input(SNAPSHOT)).err[0], /the origin remote names no forge repository/u);
});

test('init refuses the branch origin\'s HEAD points to, which no config names, and the default branch in another case', (t) => {
  const { git, input, init } = setup(t);
  git('update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk');
  for (const [branch, why] of [['trunk', /"trunk" is the default branch/u], ['Trunk', /"Trunk" is the default branch/u], ['Main', /"Main" is the default branch/u], ['ORIGIN/x', /the name of a remote/u]]) {
    assert.match(init('launch', input({ issues: [{ key: 'ENG-1', branch, status: 'unstarted' }] }, 'names.json.input')).err.join('\n'), why, branch);
  }
  assert.equal(init('launch', input({ issues: [{ key: 'ENG-1', branch: 'feat/trunk-fix', status: 'unstarted' }] }, 'names.json.input')).exitCode, 0);
});

test('the run folder of a nested project the base branch does not commit is refused', (t) => {
  const { dir, git, home, env } = setup(t, { config: { version: 1 } });
  mkdirSync(path.join(dir, 'app/.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, 'app/.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const nested = findProject(path.join(dir, 'app'));
  assert.equal(nested.root, path.join(dir, 'app'));
  const own = { ...env, XDG_STATE_HOME: path.join(home, '.local/state') };
  assert.match(runPlace(nested, loadConfig(nested).config, { env: own, home }).problem, /the base branch does not commit this project's config\.json/u);
  git('add', 'app');
  git('commit', '-q', '-m', 'app');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  assert.equal(runPlace(nested, loadConfig(nested).config, { env: own, home }).problem, undefined, 'once committed on the base, it holds');
});

test('the pinned repository refuses an owner or name of . or ..', (t) => {
  for (const remote of ['git@github.com:./widgets.git', 'git@github.com:acme/...git', 'git@github.com:acme/../widgets.git']) {
    const { project } = setup(t, { remote });
    assert.equal(pinnedRepository(project), null, remote);
  }
  assert.deepEqual(pinnedRepository(setup(t, { remote: 'git@gitlab.example.com:group/sub/app.git' }).project), { host: 'gitlab.example.com', owner: 'group/sub', name: 'app' });
});

test('a ledger row is appended under the ledger\'s lock, and a run id of a wrong shape appends none', (t) => {
  const { state, input, init } = setup(t);
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  const ledger = ledgerPath(state, 'launch');
  writeFileSync(`${ledger}.lock.99`, JSON.stringify({ pid: process.pid, host: hostname(), nonce: 'other' }));
  assert.throws(() => recordIssue(state, 'launch', { key: 'ENG-1', state: 'running' }), (error) => error.code === LOCKED);
  assert.equal(ledgerRows(state, 'launch').length, 1, 'nothing appended while another holds the lock');
  writeFileSync(`${ledger}.lock.99.released`, '');
  recordIssue(state, 'launch', { key: 'ENG-1', state: 'running' });
  assert.deepEqual(ledgerRows(state, 'launch').slice(1).map(({ event, key, state: issueState }) => [event, key, issueState]), [['issue', 'ENG-1', 'running']]);
  assert.equal(recordIssue(state, '../escape', { key: 'ENG-1', state: 'done' }).problem, '"../escape" is not a run id');
  assert.ok(!existsSync(path.join(state, 'escape')));
});

test('recording to a run that is not there makes no folder or lock, and init still works after', (t) => {
  const { state, input, init } = setup(t);
  assert.match(recordIssue(state, 'ghost', { key: 'ENG-1', state: 'running' }).problem, /no run ghost in /u);
  assert.ok(!existsSync(runsFolder(state)), 'no runs folder, run folder, or lock file');
  assert.equal(init('ghost', input(SNAPSHOT)).exitCode, 0);
  mkdirSync(path.join(runsFolder(state), 'empty'));
  assert.match(recordIssue(state, 'empty', { key: 'ENG-1', state: 'running' }).problem, /no run empty in /u);
  assert.deepEqual(readdirSync(path.join(runsFolder(state), 'empty')), []);
});

test('the run reads the latest row per issue, leaves out rows of a wrong shape, and refuses an init row of a wrong shape', (t) => {
  const { state, input, init } = setup(t);
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  const ledger = ledgerPath(state, 'launch');
  const [first] = ledgerRows(state, 'launch');
  recordIssue(state, 'launch', { key: 'ENG-1', state: 'running' });
  recordIssue(state, 'launch', { key: 'ENG-1', state: 'done' });
  writeFileSync(ledger, `${readFileSync(ledger, 'utf8')}not json\n${JSON.stringify({ event: 'issue', key: 'ENG-2', state: 'exploded' })}\n${JSON.stringify({ event: 'issue', key: 'ENG-4', state: 'parked', decision: 'has spaces in it' })}\n`);
  assert.deepEqual([...readRun(state, 'launch').states], [['ENG-1', { state: 'done', decision: null }], ['ENG-4', { state: 'parked', decision: null }]]);
  for (const bad of [{ ...first, session: 'two words' }, { ...first, repository: { ...first.repository, name: '..' } }, { ...first, at: 'yesterday' }, { ...first, at: '2026-13-45T99:99:99.000Z' }, { ...first, sha256: 'x' }, { event: 'issue', key: 'ENG-1', state: 'done' }]) {
    writeFileSync(ledger, `${JSON.stringify(bad)}\n`);
    assert.match(readRun(state, 'launch').problem, /does not start with its init row/u, JSON.stringify(bad));
  }
  writeFileSync(ledger, `${JSON.stringify({ ...first, issues: 3 })}\n`);
  assert.match(readRun(state, 'launch').problem, /does not pass its checks/u, 'the issue count the init row recorded');
  assert.match(readRun(state, 'nope').problem, /no run nope/u);
});

test('the run refuses a snapshot changed after init, a linked file, and a FIFO, without waiting on it', (t) => {
  const { state, input, init } = setup(t);
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  const snapshot = path.join(runFolder(state, 'launch'), 'snapshot.json');
  const text = readFileSync(snapshot, 'utf8');
  writeFileSync(snapshot, text.replace('"priority":3', '"priority":1'));
  assert.match(readRun(state, 'launch').problem, /is not the one its init row recorded/u);
  rmSync(snapshot);
  const elsewhere = path.join(folder(t, 'aidrian-run-elsewhere-'), 'snapshot.json');
  writeFileSync(elsewhere, text);
  symlinkSync(elsewhere, snapshot);
  assert.match(readRun(state, 'launch').problem, /snapshot\.json is a symlink/u);
  rmSync(snapshot);
  writeFileSync(snapshot, text);
  assert.equal(readRun(state, 'launch').problem, undefined);
  const ledger = ledgerPath(state, 'launch');
  rmSync(ledger);
  assert.equal(spawnSync('mkfifo', [ledger]).status, 0);
  const started = Date.now();
  assert.match(readRun(state, 'launch').problem, /ledger\.jsonl is not a regular file/u);
  assert.ok(Date.now() - started < 2000, 'a FIFO is never waited on');
});

test('summary.md holds each issue\'s status, the parked decisions, and the skipped issues, from the ledger alone', (t) => {
  const { state, input, init } = setup(t);
  assert.equal(init('launch', input(SNAPSHOT)).exitCode, 0);
  recordIssue(state, 'launch', { key: 'ENG-1', state: 'parked', decision: 'export-format' });
  recordIssue(state, 'launch', { key: 'ENG-4', state: 'running' });
  const { text, file } = writeSummary(state, 'launch');
  assert.equal(readFileSync(file, 'utf8'), text);
  assert.equal(file, path.join(runFolder(state, 'launch'), 'summary.md'));
  assert.match(text, /^# Project run launch\n\n- Repository: github\.com\/acme\/widgets\n- Driver session: abcd1234-0000-4000-8000-00000000aa01\n/u);
  assert.match(text, /- Issues: 4, 1 running, 1 parked, 2 skipped\n- Next: wait\n/u);
  assert.match(text, /\| ENG-1 \| `feat\/eng-1-export` \| parked \| decision `export-format` \|\n/u);
  assert.match(text, /\| ENG-3 \| `feat\/eng-3-share` \| skipped \| blocked by ENG-1 \|\n/u);
  assert.match(text, /## Parked decisions\n\n- ENG-1: decision `export-format`\n/u);
  assert.match(text, /## Skipped\n\n- ENG-2: blocked by ENG-1\n- ENG-3: blocked by ENG-1\n/u);
  assert.doesNotMatch(text, /Export the report|Long body|Launch plan|Other team/u);
  assert.deepEqual(readdirSync(runFolder(state, 'launch')).filter((name) => !/\.lock\.\d+(?:\.released)?$/u.test(name)).sort(), ['ledger.jsonl', 'snapshot.json', 'summary.md'], 'no temporary file is left');
});

test('projectRun: its keys and defaults, as docs/config.md shows them', () => {
  assert.deepEqual(DEFAULTS.projectRun, { allow: false, maxParallel: 1, maxStarts: 300, issueHours: 6, blockedStatus: null, decisionLabel: 'needs-decision', unverifiedHosts: false, workflowSecretsAccepted: false, forgeProtectionAccepted: false, outsideSandbox: [], mcpServers: {}, nonTrackerServers: [], registries: [], localBinding: false, recordedDecisions: false, fullAuto: false });
  assert.deepEqual(Object.keys(SCHEMA.projectRun), Object.keys(DEFAULTS.projectRun));
  const doc = readFileSync(path.join(ROOT, 'docs/config.md'), 'utf8');
  const example = JSON.parse(doc.match(/## Keys[\s\S]*?```json\n([\s\S]*?)```/u)[1]);
  assert.deepEqual(example.projectRun, DEFAULTS.projectRun);
  assert.match(doc, /^## Project run$/mu);
});

test('projectRun: a project sets any key within its bounds, and a value past one names its key and keeps the default', (t) => {
  const project = (projectRun) => setup(t, { config: { version: 1, projectRun } }).project;
  const top = { maxParallel: 4, maxStarts: 1000, issueHours: 24, blockedStatus: 'Blocked' };
  const { config, errors } = loadConfig(project(top));
  assert.deepEqual([errors, config.projectRun], [[], { ...DEFAULTS.projectRun, ...top }]);
  const low = loadConfig(project({ maxParallel: 1, maxStarts: 1, issueHours: 1 }));
  assert.deepEqual(low.errors, []);
  const over = loadConfig(project({ maxParallel: 5, maxStarts: 1001, issueHours: 25 }));
  assert.match(over.errors.join('\n'), /"projectRun\.maxParallel" must be a whole number from 1 to 4/u);
  assert.match(over.errors.join('\n'), /"projectRun\.maxStarts" must be a whole number from 1 to 1000/u);
  assert.match(over.errors.join('\n'), /"projectRun\.issueHours" must be a whole number from 1 to 24/u);
  assert.deepEqual([over.config.projectRun.maxParallel, over.config.projectRun.maxStarts, over.config.projectRun.issueHours], [1, 300, 6]);
  const under = loadConfig(project({ maxParallel: 0, maxStarts: 0, issueHours: 0 }));
  assert.equal(under.errors.length, 3);
});

test('projectRun.recordedDecisions is a switch: an object of entries is refused with where they go now, and the default stands', (t) => {
  const project = (recordedDecisions) => setup(t, { config: { version: 1, projectRun: { recordedDecisions } } }).project;
  for (const value of [true, false]) {
    const read = loadConfig(project(value));
    assert.deepEqual([read.errors, read.config.projectRun.recordedDecisions], [[], value]);
  }
  const moved = loadConfig(project({ 'ENG-1': { heading: 'Export format', sha256: 'a'.repeat(64) } }));
  assert.match(moved.errors.join('\n'), /"projectRun\.recordedDecisions" must be true or false, no longer an object of entries: record each issue's decision in this machine's store with `aidrian project decision ISSUE --heading TEXT --record` from a session the Human attends/u);
  assert.equal(moved.config.projectRun.recordedDecisions, false, 'no entry of the old object is read');
  for (const value of [{}, 'true', 1, null]) {
    const read = loadConfig(project(value));
    assert.ok(read.errors.some((error) => error.includes('"projectRun.recordedDecisions" must be true or false')), JSON.stringify(value));
    assert.equal(read.config.projectRun.recordedDecisions, false);
  }
});

test('readCapped reads what the stat gave of a file another process appends to meanwhile, and refuses one that grew past its cap', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-capped-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.jsonl');
  const real = fs.fstatSync;
  t.after(() => {
    fs.fstatSync = real;
    syncBuiltinESMExports();
  });
  // One append between the stat and the read.
  const appendOnce = (row) => {
    let once = true;
    fs.fstatSync = (fd, ...rest) => {
      const stat = real(fd, ...rest);
      if (once) {
        once = false;
        fs.appendFileSync(file, row);
      }
      return stat;
    };
    syncBuiltinESMExports();
  };
  writeFileSync(file, '{"event":"init"}\n');
  appendOnce('{"event":"issue"}\n');
  assert.deepEqual(readCapped(file, 1024), { bytes: Buffer.from('{"event":"init"}\n') }, 'the rows the stat gave');
  assert.equal(readCapped(file, 1024).bytes.toString('utf8'), '{"event":"init"}\n{"event":"issue"}\n', 'the next read has both');
  // Grown past the cap while read: refused.
  writeFileSync(file, '{"event":"init"}\n');
  appendOnce('{"event":"issue"}\n');
  assert.match(readCapped(file, 20).problem, /grew while it was read, past the 20 bytes it may hold/u);
});

test('readCapped allocates what the file holds, not its cap: a small file reads under any cap, and one past its cap is refused', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-capped-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'small.json');
  writeFileSync(file, '{"a":1}');
  // A cap no buffer could hold: only the file's own size is allocated.
  assert.equal(readCapped(file, Number.MAX_SAFE_INTEGER).bytes?.toString('utf8'), '{"a":1}');
  assert.equal(readCapped(file, 7).bytes?.toString('utf8'), '{"a":1}');
  assert.match(readCapped(file, 6).problem, /is 7 bytes, over the 6 it may hold/u);
  writeFileSync(path.join(dir, 'empty'), '');
  assert.equal(readCapped(path.join(dir, 'empty'), 10).bytes.length, 0);
});
