import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseCapture } from '../plugins/aidrian/lib/lesson-inbox.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');

// A git repository with an `origin`, and an empty state folder for it.
function setup(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-lessons-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', repo]);
  spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@example.test:acme/notes.git']);
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state'), CLAUDE_CODE_AGENT: 'planner' };
  const run = (args, input = '') => spawnSync(CLI, ['lesson', ...args], { cwd: repo, input, encoding: 'utf8', env });
  const inbox = () => path.join(base, 'state/aidrian/projects', spawnSync(CLI, ['state'], { cwd: repo, encoding: 'utf8', env }).stdout.trim().split('/').pop(), 'lessons/inbox.jsonl');
  const rows = () => readFileSync(inbox(), 'utf8').trim().split('\n').filter((line) => line.startsWith('{"id"')).map((line) => JSON.parse(line));
  return { base, repo, env, run, inbox, rows };
}

test('parseCapture takes leading evidence lines, blank lines between them, then the note verbatim', () => {
  assert.deepEqual(parseCapture('evidence: a.mjs\n\nevidence:   https://x.test/?a=1&b=2  \nthe note\n  line two\n'), {
    note: 'the note\n  line two',
    evidence: ['a.mjs', 'https://x.test/?a=1&b=2'],
  });
  assert.deepEqual(parseCapture('\nevidence: not evidence after a blank first line'), { note: 'evidence: not evidence after a blank first line', evidence: [] });
});

test('add appends one open lesson to the state folder, with where it was captured, and prints its id', (t) => {
  const { run, rows } = setup(t);
  const note = 'ran `git rev-parse` and $(false) with "$HOME" & saw: Error: ENOENT';
  const added = run(['add', '--kind', 'harness'], `evidence: scripts/it's.mjs\n${note}\n`);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^[0-9a-f]{8}\n$/);
  assert.equal(run(['add'], 'second').status, 0);
  const [first, second] = rows();
  assert.deepEqual(
    { ...first, at: undefined, worktree: undefined },
    { id: added.stdout.trim(), at: undefined, note, kind: 'harness', evidence: ["scripts/it's.mjs"], worktree: undefined, branch: 'main', agent: 'planner', status: 'open' },
  );
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/);
  assert.match(first.worktree, /repo$/);
  assert.equal(second.kind, null);
});

test('add refuses an empty note and an unknown kind, and writes nothing', (t) => {
  const { run } = setup(t);
  assert.deepEqual([run(['add'], 'evidence: x\n\n').status, run(['add'], 'evidence: x\n').stderr], [1, 'the lesson needs a note on stdin, after any "evidence: <ref>" lines\n']);
  assert.deepEqual([run(['add', '--kind', 'other'], 'note').status, run(['add', '--kind', 'other'], 'note').stderr], [1, '--kind must be one of harness, product, process\n']);
  assert.equal(run(['list']).stdout.startsWith('no open lessons in '), true);
});

test('list shows open lessons, --all shows resolved ones, and a damaged line is skipped', (t) => {
  const { run, inbox } = setup(t);
  const id = run(['add'], 'first').stdout.trim();
  run(['add'], 'second');
  appendFileSync(inbox(), '{"torn": \n');
  assert.equal(run(['resolve', id, '--outcome', 'dropped', '--link', 'fixed already']).status, 0);
  assert.deepEqual(JSON.parse(run(['list', '--json']).stdout).map((row) => row.note), ['second']);
  assert.deepEqual(JSON.parse(run(['list', '--all', '--json']).stdout).map((row) => [row.note, row.status]), [['first', 'resolved'], ['second', 'open']]);
  assert.match(run(['list', '--all']).stdout, /^[0-9a-f]{8} {2}\d{4}-\d\d-\d\d {2}\[resolved: dropped\] {2}first\n {10}planner @ main\n {10}link: fixed already\n/);
});

test('resolve appends the resolution, keeps every earlier line as it was, and reads a link from stdin', (t) => {
  const { run, inbox, rows } = setup(t);
  const first = run(['add'], 'first').stdout.trim();
  const second = run(['add'], 'second').stdout.trim();
  appendFileSync(inbox(), 'not json\n');
  const before = readFileSync(inbox(), 'utf8');
  const resolved = run(['resolve', second, '--outcome', 'rule', '--link', '-'], "the reason's $(here)\n");
  assert.deepEqual([resolved.status, resolved.stdout], [0, `${second} -> rule\n`]);
  const after = readFileSync(inbox(), 'utf8');
  assert.ok(after.startsWith(before), 'every earlier line is byte for byte the same: the file is only appended to');
  const resolution = rows().at(-1);
  assert.deepEqual({ ...resolution, resolvedAt: undefined }, { id: second, status: 'resolved', resolvedAt: undefined, outcome: 'rule', link: "the reason's $(here)" });
  const listed = JSON.parse(run(['list', '--all', '--json']).stdout);
  assert.deepEqual(listed.map((row) => [row.id, row.note, row.status, row.outcome ?? null]), [[first, 'first', 'open', null], [second, 'second', 'resolved', 'rule']]);
  assert.deepEqual([run(['resolve', second, '--outcome', 'rule']).status, run(['resolve', 'ffffffff', '--outcome', 'rule']).stderr], [1, 'no open lesson with id ffffffff\n']);
  assert.equal(run(['resolve', first, '--outcome', 'maybe']).stderr, 'resolve needs --outcome mechanism|rule|issue|duplicate|dropped\n');
});

test('nudge prints one line only while lessons are open, and always exits 0', (t) => {
  const { run } = setup(t);
  assert.deepEqual([run(['nudge']).status, run(['nudge']).stdout], [0, '']);
  const id = run(['add'], 'first').stdout.trim();
  assert.match(run(['nudge']).stdout, /^Lesson inbox: 1 open lesson \(oldest \d{4}-\d\d-\d\d\)\. Run the lesson-triage skill/);
  run(['resolve', id, '--outcome', 'duplicate', '--link', 'abc']);
  assert.equal(run(['nudge']).stdout, '');
});

test('a lesson another session writes while a resolve runs is never lost', (t) => {
  // The other session opened the inbox before the resolve and writes after it. A resolve that replaced the file would
  // leave that write in the replaced copy, and the lesson would be gone.
  const { run, inbox } = setup(t);
  const target = run(['add'], 'to resolve').stdout.trim();
  const other = openSync(inbox(), 'a');
  assert.equal(run(['resolve', target, '--outcome', 'dropped', '--link', 'x']).status, 0);
  writeSync(other, `${JSON.stringify({ id: 'feedf00d', at: new Date().toISOString(), note: 'from another session', status: 'open' })}\n`);
  closeSync(other);
  const listed = JSON.parse(run(['list', '--all', '--json']).stdout);
  assert.deepEqual(listed.map((row) => [row.note, row.status]), [['to resolve', 'resolved'], ['from another session', 'open']]);
});

test('every worktree of a repository shares one inbox, and two processes appending at once both land', async (t) => {
  const { repo, env, run, rows } = setup(t);
  spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init']);
  spawnSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'task', path.join(repo, '..', 'task')]);
  const fromWorktree = spawnSync(CLI, ['lesson', 'add'], { cwd: path.join(repo, '..', 'task'), input: 'from the worktree', encoding: 'utf8', env });
  assert.equal(fromWorktree.status, 0);
  const add = (note) => new Promise((resolve) => {
    const child = spawn(CLI, ['lesson', 'add'], { cwd: repo, env });
    child.on('close', resolve);
    child.stdin.end(note);
  });
  assert.deepEqual(await Promise.all(Array.from({ length: 8 }, (_, i) => add(`parallel ${i}`))), Array(8).fill(0));
  assert.equal(rows().length, 9);
  assert.equal(rows()[0].branch, 'task');
  assert.match(run(['list']).stdout, /from the worktree/);
});
