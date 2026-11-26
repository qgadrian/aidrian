// An attempt of a project run leaves no work uncommitted unseen (lib/project-tree.mjs): `aidrian project result` reads
// the clone's tree in the session's sandbox and holds a result back while work no commit on the branch has is there,
// and the driver's sweep keeps an ended attempt's folder by the ledger, never running git in a clone a session had.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { attemptFolder } from '../plugins/aidrian/lib/project-start.mjs';
import { ledgerKeep, treeLines } from '../plugins/aidrian/lib/project-tree.mjs';
import { runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;
const FAILED = { status: 'failed', pr: null, decisions: [], stop: 'out of time' };

// A started attempt of ENG-1 on a tracked file and an ignore rule: its folder, clone, git in the clone, and `result`,
// which hands `value` over with `options` and gives the command's answer and the drop it left, or null.
function attempt(t) {
  const fx = runFixture(t, { files: { 'src.js': 'one\n', '.gitignore': 'out/\n' } });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const folder = attemptFolder(fx.state, 'launch', 'ENG-1', 1);
  const work = path.join(folder, 'work');
  const drop = path.join(folder, 'drop', 'result.json');
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env: fx.env, encoding: 'utf8' }).trim();
  const result = (value = FAILED, options = []) => {
    rmSync(drop, { force: true });
    const file = path.join(fx.root, 'result.json');
    writeFileSync(file, JSON.stringify(value));
    const answer = fx.cmd(['result', 'launch', 'ENG-1', '--file', file, ...options], { session: CHILD });
    return { ...answer, drop: existsSync(drop) ? JSON.parse(readFileSync(drop, 'utf8')) : null };
  };
  return { fx, folder, work, git, result };
}

// A refused result: exit 1, no drop, and the three ways on, none of which discards work or stages everything.
function refused(answer, counts) {
  assert.equal(answer.exitCode, 1, answer.err.join('\n'));
  assert.equal(answer.drop, null);
  assert.equal(answer.err[0], `aidrian project result: the clone holds work no commit on the issue's branch has: ${counts}`);
  assert.match(answer.err.at(-1), /^Commit the issue's own work on its branch by path .* or run the same command again with --uncommitted/u);
  assert.doesNotMatch(answer.err.join('\n'), /add -A|add \.|git (?:reset|restore|stash|clean|checkout)|discard/u);
}

test('a result over work no commit holds is refused with no drop, each way work can lie outside one, and hands over clean once committed', (t) => {
  const { fx, work, git, result } = attempt(t);
  // A changed tracked file.
  writeFileSync(path.join(work, 'src.js'), 'two\n');
  const tracked = result();
  refused(tracked, '1 changed or untracked file in the clone');
  assert.deepEqual(tracked.err.slice(1, -1), ['  src.js']);
  git('checkout', '--', 'src.js');
  // An untracked file, by a cleaned name.
  writeFileSync(path.join(work, 'notes​.md'), 'draft\n');
  const untracked = result();
  refused(untracked, '1 changed or untracked file in the clone');
  assert.deepEqual(untracked.err.slice(1, -1), ['  notes.md']);
  rmSync(path.join(work, 'notes​.md'));
  // A linked worktree with a change of its own.
  const slice = path.join(fx.root, 'slice');
  git('worktree', 'add', '-q', '-b', 'slice', slice);
  writeFileSync(path.join(slice, 'src.js'), 'slice\n');
  refused(result(), '0 changed or untracked files in the clone, 1 in its other worktrees');
  // The slice branch's commit, which HEAD lacks.
  execFileSync('git', ['-C', slice, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-am', 'slice'], { env: fx.env });
  refused(result(), '0 changed or untracked files in the clone, 1 commit only a local branch, another worktree, or the stash holds');
  // Brought onto the issue branch, it counts no more; nor does the worktree, removed.
  git('merge', '-q', '--ff-only', 'slice');
  git('worktree', 'remove', slice);
  // The stash: one entry is two commits to git, its work and its index.
  writeFileSync(path.join(work, 'src.js'), 'stashed\n');
  git('stash', '-q');
  refused(result(), '0 changed or untracked files in the clone, 2 commits only a local branch, another worktree, or the stash holds');
  git('stash', 'pop', '-q');
  // merged and environment are not held: the work landed, or a commit may be what broke.
  for (const value of [{ status: 'merged', pr: 12, decisions: [], stop: null }, { status: 'environment', pr: null, decisions: [], stop: 'git commit failed', cause: 'commit' }]) {
    const handed = result(value);
    assert.equal(handed.exitCode, 0, handed.err.join('\n'));
    assert.equal(Object.hasOwn(handed.drop, 'tree'), false, value.status);
  }
  // Committed by path, with an ignored file and the host's placeholders left: clean.
  git('add', '--', 'src.js');
  git('commit', '-q', '-m', 'work in progress: export');
  mkdirSync(path.join(work, 'out'));
  writeFileSync(path.join(work, 'out', 'build.log'), 'ignored\n');
  assert.ok(existsSync(path.join(work, '.claude', 'settings.json')), 'the placeholders are there');
  for (const status of ['failed', 'blocked', 'pr_open']) {
    const handed = result({ ...FAILED, status, pr: status === 'pr_open' ? 12 : null });
    assert.equal(handed.exitCode, 0, handed.err.join('\n'));
    assert.equal(handed.drop.tree, 'clean', status);
  }
});

test('--uncommitted hands the work over, and so does a clone git may not run in, with no program of its config run; each keeps the folder once', (t) => {
  const { fx, folder, work, result } = attempt(t);
  writeFileSync(path.join(work, 'src.js'), 'unfinished\n');
  const handed = result(FAILED, ['--uncommitted']);
  assert.equal(handed.exitCode, 0, handed.err.join('\n'));
  assert.equal(handed.drop.tree, 'uncommitted');
  fx.claude.states[CHILD] = 'done';
  const kept = `kept ENG-1 attempt 1: its session handed its result over with work left uncommitted, so its folder stays for the run's life; copy any work out of ${work}, and run no git or program there`;
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['result ENG-1 failed -> open', kept, 'idle']);
  assert.equal(fx.rows().find((row) => row.event === 'result').tree, 'uncommitted');
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['idle']);
  assert.deepEqual(fx.rows().filter((row) => row.event === 'kept').map(({ head, why }) => [head, why]), [[null, 'its session handed its result over with work left uncommitted']]);
  assert.equal(readFileSync(path.join(work, 'src.js'), 'utf8'), 'unfinished\n', 'the work is still there');
  assert.ok(existsSync(folder));

  // Attempt 2's clone sets a filter that would run a program on the changed file: git runs nowhere there, and the result
  // hands over as unknown.
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const second = attemptFolder(fx.state, 'launch', 'ENG-1', 2);
  const marker = path.join(fx.root, 'marker');
  execFileSync('git', ['config', '--file', path.join(second, 'git', 'config'), 'filter.mark.clean', `touch ${marker}; cat`]);
  writeFileSync(path.join(second, 'git', 'info', 'attributes'), '* filter=mark\n');
  writeFileSync(path.join(second, 'work', 'src.js'), 'changed\n');
  const file = path.join(fx.root, 'result.json');
  writeFileSync(file, JSON.stringify(FAILED));
  assert.equal(fx.cmd(['result', 'launch', 'ENG-1', '--file', file], { session: STARTED[1].session }).exitCode, 0);
  assert.equal(JSON.parse(readFileSync(path.join(second, 'drop', 'result.json'), 'utf8')).tree, 'unknown');
  fx.claude.states[STARTED[1].session] = 'done';
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out.filter((line) => line.startsWith('kept '));
  assert.deepEqual(out, [`kept ENG-1 attempt 2: its session's result could not tell whether work was left uncommitted, so its folder stays for the run's life; copy any work out of ${path.join(second, 'work')}, and run no git or program there`]);
  assert.equal(existsSync(marker), false, 'no program of the clone\'s config ran');
});

test('a drop whose tree is not one of the words reaches no row, and its folder stays', (t) => {
  const { fx, folder, result } = attempt(t);
  const handed = result();
  assert.equal(handed.drop.tree, 'clean');
  const drop = path.join(folder, 'drop', 'result.json');
  writeFileSync(drop, JSON.stringify({ ...handed.drop, tree: ['clean'] }));
  fx.claude.states[CHILD] = 'done';
  const out = fx.cmd(['wait', 'launch', '--max-wait', '0']).out;
  assert.equal(out[0], 'result ENG-1 failed -> open');
  assert.match(out[1], /^kept ENG-1 attempt 1: its result does not say its clone was left clean, /u);
  assert.equal(Object.hasOwn(fx.rows().find((row) => row.event === 'result'), 'tree'), false);
  assert.ok(existsSync(folder));
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
  const took = { start: { took: { attempt: 1, head: 'a'.repeat(40) } } };
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
