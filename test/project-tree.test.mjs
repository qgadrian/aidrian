// An attempt of a project run leaves no work uncommitted unseen (lib/project-tree.mjs): `aidrian project result` reads
// the clone's tree in the session's sandbox and holds a result back while work no commit on the branch has is there,
// and the driver's sweep keeps an ended attempt's folder by the ledger, never running git in a clone a session had.
// One fixture clone serves every read of a real tree; the drop's take-in and the sweep run on a run written by hand,
// whose clone's refs are files, with no git and no child process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stubGitSpawn } from '../plugins/aidrian/lib/git.mjs';
import { DROP_FILE, ingestDrops } from '../plugins/aidrian/lib/project-result.mjs';
import { appendToRun, readRun, runFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { attemptFolder, sweepAttempts } from '../plugins/aidrian/lib/project-start.mjs';
import { ledgerKeep, treeLines, treeOf } from '../plugins/aidrian/lib/project-tree.mjs';
import { DRIVER, ISSUES, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;
const BRANCH = 'feat/eng-1-export';
const FAILED = { status: 'failed', pr: null, decisions: [], stop: 'out of time' };
const HAS = 'a'.repeat(40);

test('the tree check reads every way work can lie outside a commit, and `result` holds back only what it may', (t) => {
  const fx = runFixture(t, { files: { 'src.js': 'one\n', '.gitignore': 'out/\n' } });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const folder = attemptFolder(fx.state, 'launch', 'ENG-1', 1);
  const work = path.join(folder, 'work');
  const drop = path.join(folder, 'drop', DROP_FILE);
  const start = fx.rows().findLast((row) => row.event === 'start');
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env: fx.env, encoding: 'utf8' }).trim();
  const tree = () => treeOf({ start, env: fx.env });
  const result = (value = FAILED, options = []) => {
    rmSync(drop, { force: true });
    const file = path.join(fx.root, 'result.json');
    writeFileSync(file, JSON.stringify(value));
    const answer = fx.cmd(['result', 'launch', 'ENG-1', '--file', file, ...options], { session: CHILD });
    return { ...answer, drop: existsSync(drop) ? JSON.parse(readFileSync(drop, 'utf8')) : null };
  };

  // A fresh clone, with the host's placeholders and an ignored file: clean.
  mkdirSync(path.join(work, 'out'));
  writeFileSync(path.join(work, 'out', 'build.log'), 'ignored\n');
  assert.ok(existsSync(path.join(work, '.claude', 'settings.json')), 'the placeholders are there');
  assert.deepEqual(tree(), { tree: 'clean', files: 0, others: 0, commits: 0, names: [] });
  // A changed tracked file, then an untracked one by a cleaned name.
  writeFileSync(path.join(work, 'src.js'), 'two\n');
  assert.deepEqual(tree(), { tree: 'uncommitted', files: 1, others: 0, commits: 0, names: ['src.js'] });
  git('checkout', '--', 'src.js');
  writeFileSync(path.join(work, 'notes​.md'), 'draft\n');
  assert.deepEqual(tree(), { tree: 'uncommitted', files: 1, others: 0, commits: 0, names: ['notes.md'] });
  rmSync(path.join(work, 'notes​.md'));
  // A linked worktree with a change of its own, then its branch's commit, which HEAD lacks.
  const slice = path.join(fx.root, 'slice');
  git('worktree', 'add', '-q', '-b', 'slice', slice);
  writeFileSync(path.join(slice, 'src.js'), 'slice\n');
  assert.deepEqual(tree(), { tree: 'uncommitted', files: 0, others: 1, commits: 0, names: ['src.js'] });
  execFileSync('git', ['-C', slice, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'slice'], { env: fx.env });
  assert.deepEqual(tree(), { tree: 'uncommitted', files: 0, others: 0, commits: 1, names: [] });
  // Brought onto the issue branch, it counts no more; nor does the worktree, removed.
  git('merge', '-q', '--ff-only', 'slice');
  git('worktree', 'remove', slice);
  assert.equal(tree().tree, 'clean');
  // The stash: one entry is two commits to git, its work and its index.
  writeFileSync(path.join(work, 'src.js'), 'stashed\n');
  git('stash', '-q');
  assert.deepEqual(tree(), { tree: 'uncommitted', files: 0, others: 0, commits: 2, names: [] });
  git('stash', 'pop', '-q');

  // `result` over that work: refused, with no drop, and three ways on, none of which discards work or stages everything.
  const held = result();
  assert.equal(held.exitCode, 1);
  assert.equal(held.drop, null);
  assert.deepEqual(held.err.slice(0, 2), ['aidrian project result: the clone holds work no commit on the issue\'s branch has: 1 changed or untracked file in the clone', '  src.js']);
  assert.match(held.err.at(-1), /^Commit the issue's own work on its branch by path .* or run the same command again with --uncommitted/u);
  assert.doesNotMatch(held.err.join('\n'), /add -A|add \.|git (?:reset|restore|stash|clean|checkout)|discard/u);
  // merged and environment are not held: the work landed, or a commit may be what broke.
  for (const value of [{ status: 'merged', pr: 12, decisions: [], stop: null }, { status: 'environment', pr: null, decisions: [], stop: 'git commit failed', cause: 'commit' }]) {
    const handed = result(value);
    assert.equal(handed.exitCode, 0, handed.err.join('\n'));
    assert.equal(Object.hasOwn(handed.drop, 'tree'), false, value.status);
  }
  // --uncommitted hands the work over as it is, and runs no git in the clone to do it.
  const inClone = [];
  stubGitSpawn((command, args, options) => {
    if (String(options.cwd).startsWith(folder)) inClone.push(args);
    return spawnSync(command, args, options);
  });
  const over = result({ ...FAILED, status: 'parked', decisions: [{ question: 'Which?', options: ['a', 'b'], recommended: 0, class: 'scope' }] }, ['--uncommitted']);
  stubGitSpawn(null);
  assert.equal(over.exitCode, 0, over.err.join('\n'));
  assert.equal(over.drop.tree, 'uncommitted');
  assert.deepEqual(inClone, []);

  // A filter in the clone's own config that would run a program on the changed file: git runs nowhere there, and the
  // result hands over as unknown, so it can still be recorded.
  const marker = path.join(fx.root, 'marker');
  const config = path.join(folder, 'git', 'config');
  const before = readFileSync(config, 'utf8');
  execFileSync('git', ['config', '--file', config, 'filter.mark.clean', `touch ${marker}; cat`]);
  writeFileSync(path.join(folder, 'git', 'info', 'attributes'), '* filter=mark\n');
  const unknown = result();
  assert.equal(unknown.exitCode, 0, unknown.err.join('\n'));
  assert.equal(unknown.drop.tree, 'unknown');
  assert.equal(existsSync(marker), false, 'no program of the clone\'s config ran');
  writeFileSync(config, before);
  rmSync(path.join(folder, 'git', 'info', 'attributes'));

  // Committed by path: every status the check runs for hands over clean.
  git('add', '--', 'src.js');
  git('commit', '-q', '-m', 'work in progress: export');
  for (const status of ['failed', 'blocked', 'pr_open']) {
    const handed = result({ ...FAILED, status, pr: status === 'pr_open' ? 12 : null });
    assert.equal(handed.exitCode, 0, handed.err.join('\n'));
    assert.equal(handed.drop.tree, 'clean', status);
  }
});

// A run `launch` written by hand, with ENG-1's attempt 1 running in an attempt folder whose clone's refs are files at
// HAS, a commit the forge holds: no git and no child process. `take(tree)` hands a failed result over with `tree` and
// takes it in; `sweep()` sweeps the ended attempt, as `wait` does.
function handRun(t) {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-tree-run-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const folder = attemptFolder(state, 'launch', 'ENG-1', 1);
  const drop = path.join(folder, 'drop');
  mkdirSync(drop, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(folder, 'git', 'refs', 'heads', 'feat'), { recursive: true });
  writeFileSync(path.join(folder, 'git', 'HEAD'), `ref: refs/heads/${BRANCH}\n`);
  writeFileSync(path.join(folder, 'git', 'refs', 'heads', BRANCH), `${HAS}\n`);
  const snapshot = JSON.stringify({ issues: [ISSUES[0]] });
  writeFileSync(path.join(runFolder(state, 'launch'), 'snapshot.json'), snapshot);
  const at = new Date(Date.now() - 60_000).toISOString();
  const rows = [
    { event: 'init', run: 'launch', at, session: DRIVER, repository: { host: 'github.com', owner: 'acme', name: 'widgets' }, issues: 1, sha256: createHash('sha256').update(snapshot).digest('hex') },
    { event: 'issue', key: 'ENG-1', state: 'running', at },
    { event: 'start', key: 'ENG-1', attempt: 1, outcome: 'started', session: DRIVER, id: CHILD, child: CHILD, cwd: path.join(folder, 'work'), branch: BRANCH, name: 'ENG-1', drop, at },
  ];
  writeFileSync(path.join(runFolder(state, 'launch'), 'ledger.jsonl'), rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  const forge = { branchHead: () => null, hasCommit: (repo, sha) => sha === HAS };
  const take = (tree) => {
    writeFileSync(path.join(drop, DROP_FILE), JSON.stringify({ run: 'launch', key: 'ENG-1', attempt: 1, ...FAILED, tree }));
    return ingestDrops({ state, run: 'launch', found: readRun(state, 'launch'), forge, now: Date.now() });
  };
  const sweep = () => sweepAttempts({ state, run: 'launch', found: readRun(state, 'launch'), cap: { ended: () => true }, env: {}, forge });
  const rowsOf = (event) => readRun(state, 'launch').rows.filter((row) => row.event === event);
  return { state, folder, take, sweep, rowsOf };
}

test('a handed-over tree reaches the result row only as one of its words, and the sweep keeps the folder once, with one row and one line', (t) => {
  for (const [tree, why] of [['uncommitted', 'its session handed its result over with work left uncommitted'], ['unknown', 'its session\'s result could not tell whether work was left uncommitted'],
    [['clean'], 'its result does not say its clone was left clean'], [7, 'its result does not say its clone was left clean'], ['dirty', 'its result does not say its clone was left clean']]) {
    const run = handRun(t);
    assert.deepEqual(run.take(tree), ['result ENG-1 failed -> open']);
    const [row] = run.rowsOf('result');
    assert.equal(row.tree, typeof tree === 'string' && tree !== 'dirty' ? tree : undefined, String(tree));
    const work = path.join(run.folder, 'work');
    assert.deepEqual(run.sweep(), [`kept ENG-1 attempt 1: ${why}, so its folder stays for the run's life; copy any work out of ${work}, and run no git or program there`]);
    assert.deepEqual(run.sweep(), [], 'a later sweep writes nothing more');
    assert.deepEqual(run.rowsOf('kept').map(({ head, why: said }) => [head, said]), [[null, why]]);
    assert.ok(existsSync(run.folder));
  }
});

test('a clean result over a tree its session read clean is swept, and no end with no result is', (t) => {
  const clean = handRun(t);
  assert.deepEqual(clean.take('clean'), ['result ENG-1 failed -> open']);
  assert.deepEqual(clean.sweep(), []);
  assert.equal(existsSync(clean.folder), false);
  for (const reason of ['timeout', 'no_result', 'limit', 'bad_result']) {
    const ended = handRun(t);
    appendToRun(ended.state, 'launch', () => ({ rows: [{ event: 'ended', key: 'ENG-1', attempt: 1, reason, at: new Date().toISOString() }, { event: 'issue', key: 'ENG-1', state: 'open', at: new Date().toISOString() }] }));
    assert.match(ended.sweep()[0], /^kept ENG-1 attempt 1: its session ended with no result that says its clone was left clean, /u, reason);
    assert.ok(existsSync(ended.folder), reason);
  }
});

// ledgerKeep over hand-made rows: attempt 1 of ENG-1, started with `start` fields, then `rows`.
const keep = (rows, { start = {}, forge = { hasCommit: () => true } } = {}) => {
  const row = { event: 'start', key: 'ENG-1', attempt: 1, outcome: 'started', ...start };
  const found = { rows: [row, ...rows.map((each) => ({ key: 'ENG-1', attempt: 1, ...each }))] };
  return ledgerKeep({ found, row, repository: { owner: 'acme', name: 'widgets', host: 'github.com' }, forge });
};

test('the sweep keeps by the ledger: every end but a merge, a clean result, a start that never ran, and an offer never taken', () => {
  const ended = 'its session ended with no result that says its clone was left clean';
  for (const reason of ['timeout', 'no_result', 'limit', 'bad_result', 'cycle']) assert.deepEqual(keep([{ event: 'ended', reason }]), { why: ended }, reason);
  assert.equal(keep([]), null, 'a start given back or settled as an orphan, with no result or ended row');
  assert.equal(keep([{ event: 'orphan' }]), null);
  assert.equal(keep([{ event: 'result', status: 'merged' }]), null);
  assert.equal(keep([{ event: 'result', status: 'failed', tree: 'clean' }]), null);
  for (const tree of [undefined, 'dirty', 7, null]) assert.deepEqual(keep([{ event: 'result', status: 'failed', tree }]), { why: 'its result does not say its clone was left clean' }, String(tree));
  assert.deepEqual(keep([{ event: 'result', status: 'parked', tree: 'uncommitted' }]), { why: 'its session handed its result over with work left uncommitted' });
  assert.deepEqual(keep([{ event: 'result', status: 'pr_open', tree: 'unknown' }]), { why: 'its session\'s result could not tell whether work was left uncommitted' });
  // An offer never taken: the forge still lacks the offered commit, so the clone holds no work by its first message.
  const took = { start: { took: { attempt: 1, head: 'b'.repeat(40) } } };
  assert.equal(keep([{ event: 'ended', reason: 'limit' }], { ...took, forge: { hasCommit: () => false } }), null);
  assert.deepEqual(keep([{ event: 'ended', reason: 'limit' }], { ...took, forge: { hasCommit: () => true } }), { why: ended });
  assert.deepEqual(keep([{ event: 'ended', reason: 'limit' }], { ...took, forge: { hasCommit: () => { throw new Error('gh: HTTP 502'); } } }), { wait: true });
  assert.deepEqual(keep([{ event: 'ended', reason: 'limit' }], { ...took, forge: null }), { wait: true });
});

test('the refusal\'s lines count each kind of work and name at most ten files', () => {
  const names = Array.from({ length: 10 }, (_, at) => `f${at}`);
  const lines = treeLines({ tree: 'uncommitted', files: 1, others: 2, commits: 3, names });
  assert.equal(lines[0], 'the clone holds work no commit on the issue\'s branch has: 1 changed or untracked file in the clone, 2 in its other worktrees, 3 commits only a local branch, another worktree, or the stash holds');
  assert.equal(lines.length, 12);
});
