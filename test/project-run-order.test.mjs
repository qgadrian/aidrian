// The order of a project run (lib/project-run.mjs planRun): a topological sort by blockedBy, then priority, then key;
// a cycle blocked; a parked issue and every issue below it skipped; and `done` when nothing may start and nothing runs.
// Also the snapshot input's checks: keys, branches, status types, and the fields it drops.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BRANCH_CAP, branchProblem, DECISION_ID, ISSUE_KEY, nextLines, planRun, RUN_ID, validateSnapshot } from '../plugins/aidrian/lib/project-run.mjs';

const issue = (key, { blockedBy = [], priority = 0, status = 'unstarted' } = {}) => ({ key, branch: `feat/${key.toLowerCase()}`, status, blockedBy, priority });
const snapshot = (issues, outside = []) => {
  const { snapshot: kept, problems } = validateSnapshot({ issues, outside });
  assert.deepEqual(problems, []);
  return kept;
};
const states = (entries) => new Map(Object.entries(entries).map(([key, value]) => [key, typeof value === 'string' ? { state: value, decision: null } : value]));

test('the order is topological by blockedBy, then by priority, with no priority last, then by key in its natural order', () => {
  const plan = planRun(snapshot([
    issue('ENG-10', { priority: 3 }),
    issue('ENG-9', { priority: 3 }),
    issue('ENG-2', { priority: 0 }),
    issue('ENG-1', { priority: 4, blockedBy: ['ENG-5'] }),
    issue('ENG-5', { priority: 4 }),
    issue('ENG-7', { priority: 1, blockedBy: ['ENG-2'] }),
  ]), new Map(), { maxParallel: 10 });
  // ENG-7 is the most urgent, but waits on ENG-2, which has no priority; ENG-9 comes before ENG-10.
  assert.deepEqual(plan.order, ['ENG-9', 'ENG-10', 'ENG-5', 'ENG-1', 'ENG-2', 'ENG-7']);
  assert.deepEqual(plan.next.map(({ key }) => key), ['ENG-9', 'ENG-10', 'ENG-5', 'ENG-2']);
  assert.deepEqual(plan.blocked, [{ key: 'ENG-1', reason: 'waiting', on: ['ENG-5'] }, { key: 'ENG-7', reason: 'waiting', on: ['ENG-2'] }]);
  assert.equal(plan.verdict, 'next');
});

test('next names at most maxParallel issues less those running, and waits when the running ones fill it', () => {
  const issues = snapshot([issue('ENG-1', { priority: 1 }), issue('ENG-2', { priority: 2 }), issue('ENG-3', { priority: 3 })]);
  assert.deepEqual(planRun(issues, new Map(), { maxParallel: 2 }).next, [{ key: 'ENG-1', branch: 'feat/eng-1' }, { key: 'ENG-2', branch: 'feat/eng-2' }]);
  const one = planRun(issues, states({ 'ENG-1': 'running' }), { maxParallel: 2 });
  assert.deepEqual([one.verdict, one.next.map(({ key }) => key), one.running], ['next', ['ENG-2'], ['ENG-1']]);
  const full = planRun(issues, states({ 'ENG-1': 'running' }), { maxParallel: 1 });
  assert.deepEqual([full.verdict, full.next, full.ready], ['wait', [], ['ENG-2', 'ENG-3']]);
  assert.deepEqual(nextLines(full), ['wait 1 running', 'running ENG-1']);
});

test('a done blocker frees its dependents, whether the tracker or the ledger says it is done', () => {
  const issues = snapshot([issue('ENG-1', { status: 'completed' }), issue('ENG-2', { blockedBy: ['ENG-1'] }), issue('ENG-3', { blockedBy: ['ENG-2'] })]);
  const first = planRun(issues);
  assert.deepEqual([first.next.map(({ key }) => key), first.done], [['ENG-2'], ['ENG-1']]);
  const second = planRun(issues, states({ 'ENG-2': 'done' }));
  assert.deepEqual([second.next.map(({ key }) => key), second.done], [['ENG-3'], ['ENG-1', 'ENG-2']]);
});

test('a cycle is reported blocked with its members, and an issue below it waits on it', () => {
  const plan = planRun(snapshot([
    issue('ENG-1', { blockedBy: ['ENG-2'] }),
    issue('ENG-2', { blockedBy: ['ENG-3'] }),
    issue('ENG-3', { blockedBy: ['ENG-1'] }),
    issue('ENG-4', { blockedBy: ['ENG-4'] }),
    issue('ENG-5', { blockedBy: ['ENG-3'] }),
    issue('ENG-6'),
  ]), new Map(), { maxParallel: 5 });
  assert.deepEqual(plan.order, ['ENG-6']);
  assert.deepEqual(plan.next.map(({ key }) => key), ['ENG-6']);
  assert.deepEqual(plan.blocked, [
    { key: 'ENG-1', reason: 'cycle', on: ['ENG-1', 'ENG-2', 'ENG-3'] },
    { key: 'ENG-2', reason: 'cycle', on: ['ENG-1', 'ENG-2', 'ENG-3'] },
    { key: 'ENG-3', reason: 'cycle', on: ['ENG-1', 'ENG-2', 'ENG-3'] },
    { key: 'ENG-4', reason: 'cycle', on: ['ENG-4'] },
    { key: 'ENG-5', reason: 'waiting', on: ['ENG-3'] },
  ]);
  assert.ok(nextLines(plan).includes('blocked ENG-1 cycle ENG-1,ENG-2,ENG-3'));
  const onlyCycle = planRun(snapshot([issue('ENG-1', { blockedBy: ['ENG-2'] }), issue('ENG-2', { blockedBy: ['ENG-1'] })]));
  assert.deepEqual([onlyCycle.verdict, nextLines(onlyCycle)[0]], ['done', 'done'], 'a cycle alone runs nothing, so the run is done');
  const broken = planRun(snapshot([issue('ENG-1', { blockedBy: ['ENG-2'], status: 'completed' }), issue('ENG-2', { blockedBy: ['ENG-1'] })]));
  assert.deepEqual(broken.next.map(({ key }) => key), ['ENG-2'], 'a done issue holds no cycle');
});

test('a parked issue is never started, and every issue below it is skipped and names it; a canceled one too', () => {
  const issues = snapshot([
    issue('ENG-1', { priority: 1 }),
    issue('ENG-2', { blockedBy: ['ENG-1'] }),
    issue('ENG-3', { blockedBy: ['ENG-2'] }),
    issue('ENG-4', { status: 'canceled' }),
    issue('ENG-5', { blockedBy: ['ENG-4', 'ENG-1'] }),
    issue('ENG-6'),
  ]);
  const plan = planRun(issues, states({ 'ENG-1': { state: 'parked', decision: 'export-format' } }), { maxParallel: 5 });
  assert.deepEqual(plan.parked, [{ key: 'ENG-1', decision: 'export-format' }]);
  assert.deepEqual(plan.canceled, ['ENG-4']);
  assert.deepEqual(plan.skipped, [
    { key: 'ENG-2', skipped_blocked_by: ['ENG-1'] },
    { key: 'ENG-3', skipped_blocked_by: ['ENG-1'] },
    { key: 'ENG-5', skipped_blocked_by: ['ENG-1', 'ENG-4'] },
  ]);
  assert.deepEqual(plan.next.map(({ key }) => key), ['ENG-6']);
  assert.ok(nextLines(plan).includes('skipped ENG-3 blocked_by ENG-1'));
  const after = planRun(issues, states({ 'ENG-1': 'parked', 'ENG-6': 'done' }), { maxParallel: 5 });
  assert.deepEqual([after.verdict, nextLines(after)[0]], ['done', 'done']);
});

test('the skip walk stops at a done issue, whether the tracker or the ledger says it is done', () => {
  const chain = (middle) => snapshot([
    issue('ENG-1'),
    issue('ENG-2', { blockedBy: ['ENG-1'], status: middle }),
    issue('ENG-3', { blockedBy: ['ENG-2'] }),
    issue('ENG-4', { blockedBy: ['ENG-3'] }),
  ]);
  const completed = planRun(chain('completed'), states({ 'ENG-1': 'parked' }));
  assert.deepEqual([completed.skipped, completed.next.map(({ key }) => key)], [[], ['ENG-3']], 'ENG-3 waits on a completed issue, not on the parked one');
  const logged = planRun(chain('unstarted'), states({ 'ENG-1': 'parked', 'ENG-2': 'done' }));
  assert.deepEqual([logged.skipped, logged.next.map(({ key }) => key)], [[], ['ENG-3']]);
  const both = planRun(snapshot([
    issue('ENG-1'),
    issue('ENG-2', { blockedBy: ['ENG-1'], status: 'completed' }),
    issue('ENG-3', { blockedBy: ['ENG-1', 'ENG-2'] }),
  ]), states({ 'ENG-1': 'parked' }));
  assert.deepEqual(both.skipped, [{ key: 'ENG-3', skipped_blocked_by: ['ENG-1'] }], 'a direct wait on the parked issue still skips');
});

test('planRun throws when maxParallel is not a whole number above 0', () => {
  const issues = snapshot([issue('ENG-1')]);
  for (const maxParallel of [0, -1, 1.5, '2', null, Number.NaN]) assert.throws(() => planRun(issues, new Map(), { maxParallel }), /is not a whole number above 0/u, String(maxParallel));
  assert.equal(planRun(issues, new Map(), { maxParallel: 3 }).verdict, 'next');
});

test('next is done when nothing may start and nothing runs, and waits while something runs', () => {
  const issues = snapshot([issue('ENG-1'), issue('ENG-2', { blockedBy: ['ENG-1'] })]);
  assert.equal(planRun(issues, states({ 'ENG-1': 'done', 'ENG-2': 'done' })).verdict, 'done');
  assert.equal(planRun(issues, states({ 'ENG-1': 'running' })).verdict, 'wait');
  assert.deepEqual(nextLines(planRun(issues, states({ 'ENG-1': 'done', 'ENG-2': 'done' }))), ['done']);
  const held = planRun(snapshot([issue('ENG-1', { status: 'triage' }), issue('ENG-2', { status: 'started' })]));
  assert.deepEqual([held.verdict, held.blocked], ['done', [{ key: 'ENG-1', reason: 'status', on: ['triage'] }, { key: 'ENG-2', reason: 'status', on: ['started'] }]]);
});

test('a blocker outside the snapshot blocks unless it is listed completed', () => {
  const issues = [issue('ENG-1', { blockedBy: ['OPS-1'] }), issue('ENG-2', { blockedBy: ['OPS-2'] }), issue('ENG-3', { blockedBy: ['OPS-3'] })];
  const plan = planRun(snapshot(issues, [{ key: 'OPS-1', status: 'completed' }, { key: 'OPS-2', status: 'started' }]), new Map(), { maxParallel: 5 });
  assert.deepEqual(plan.next.map(({ key }) => key), ['ENG-1']);
  assert.deepEqual(plan.blocked, [{ key: 'ENG-2', reason: 'waiting', on: ['OPS-2'] }, { key: 'ENG-3', reason: 'waiting', on: ['OPS-3'] }]);
  const canceled = planRun(snapshot([issue('ENG-1', { blockedBy: ['OPS-1'] })], [{ key: 'OPS-1', status: 'canceled' }]));
  assert.deepEqual(canceled.blocked, [{ key: 'ENG-1', reason: 'waiting', on: ['OPS-1'] }], 'a canceled blocker is not done');
});

test('the snapshot keeps only key, branch, status, blockedBy, and priority, and drops every other field', () => {
  const { snapshot: kept, problems, dropped } = validateSnapshot({
    project: 'Launch', issues: [{ ...issue('ENG-1'), title: 'Secret title', description: 'Body text', url: 'https://x' }],
    outside: [{ key: 'OPS-1', status: 'completed', title: 'Other title' }],
  });
  assert.deepEqual(problems, []);
  assert.equal(dropped, 5);
  assert.deepEqual(kept, { issues: [issue('ENG-1')], outside: [{ key: 'OPS-1', status: 'completed' }] });
  assert.doesNotMatch(JSON.stringify(kept), /title|Body|Secret|https/u);
  assert.deepEqual(validateSnapshot({ issues: [{ key: 'ENG-1', branch: 'feat/x', status: 'backlog' }] }).snapshot.issues[0], { key: 'ENG-1', branch: 'feat/x', status: 'backlog', blockedBy: [], priority: 0 });
});

test('the snapshot refuses a bad key, branch, status, blocker, or priority, and a repeated key or branch', () => {
  const problems = (issues, outside) => validateSnapshot({ issues, outside }).problems;
  assert.match(problems([{ ...issue('ENG-1'), key: 'eng-1' }])[0], /issues\[0\]\.key "eng-1" is not an issue key/u);
  assert.match(problems([{ ...issue('ENG-1'), key: '../x' }])[0], /is not an issue key/u);
  assert.match(problems([{ ...issue('ENG-1'), branch: '-x' }])[0], /starts with a dash/u);
  assert.match(problems([{ ...issue('ENG-1'), status: 'done' }])[0], /status "done" is not one of/u);
  assert.match(problems([{ ...issue('ENG-1'), blockedBy: ['nope'] }])[0], /blockedBy is not a list/u);
  assert.match(problems([{ ...issue('ENG-1'), priority: 5 }])[0], /priority 5 is not a whole number from 0 to 4/u);
  assert.match(problems([issue('ENG-1'), issue('ENG-1')]).join('\n'), /issue key ENG-1 is there twice/u);
  assert.match(problems([issue('ENG-1'), { ...issue('ENG-2'), branch: 'feat/eng-1' }]).join('\n'), /branch feat\/eng-1 is there twice/u);
  assert.match(problems([issue('ENG-1')], [{ key: 'ENG-1', status: 'completed' }]).join('\n'), /both an issue and an outside blocker/u);
  assert.deepEqual(problems([]), ['"issues" is not a non-empty list']);
  assert.deepEqual(validateSnapshot([]).problems, ['the snapshot input is not a JSON object']);
});

test('a decision id is ASCII letters, digits, dots, dashes, and underscores, with no letter a case fold admits', () => {
  for (const id of ['scope', 'Export-format', 'a.b_c-1']) assert.ok(DECISION_ID.test(id), id);
  for (const id of ['ſcope', '\u212Aey', 'é', '-x', 'a b', '']) assert.ok(!DECISION_ID.test(id), id);
});

test('issue keys and run ids match a strict pattern', () => {
  for (const key of ['ENG-1', 'A-123456789', 'TEAM2-40', '17']) assert.ok(ISSUE_KEY.test(key), key);
  for (const key of ['eng-1', 'ENG-0', 'ENG-', '-1', 'ENG-1 ', 'ENG_1', 'ENG-1\n', '../ENG-1', '0']) assert.ok(!ISSUE_KEY.test(key), key);
  for (const run of ['launch', 'q3-launch-2', '1']) assert.ok(RUN_ID.test(run), run);
  for (const run of ['Launch', '-x', '.x', 'a/b', 'a b', '', 'x'.repeat(65), '..']) assert.ok(!RUN_ID.test(run), run);
});

test('a branch passes the check only when git check-ref-format --branch takes it, with an allowlist and no leading dash', (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-refs-')));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (branch) => spawnSync('git', ['check-ref-format', '--branch', branch], { cwd, encoding: 'utf8' }).status === 0;
  assert.equal(BRANCH_CAP, 120);
  const good = ['feat/eng-12-export', 'fix/x', 'a.b_c-d/e', 'v1.2', 'x', 'x'.repeat(120), 'feat/head-room', 'abc123', 'ahead'];
  const bad = ['-x', 'a..b', 'a/.b', '.a', 'a.lock', 'a/b.lock/c', 'a/', '/a', 'a//b', 'a.', 'HEAD', 'a b', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\\b', 'a@{b', '@', 'a\u0001b', 'ä', 'a+b', '', 'x'.repeat(121)];
  for (const branch of good) {
    assert.equal(branchProblem(branch), null, branch);
    assert.ok(git(branch), `git takes ${branch}`);
  }
  for (const branch of bad) assert.notEqual(branchProblem(branch), null, JSON.stringify(branch));
  for (const branch of bad.filter((each) => each && !each.includes('\u0001'))) {
    // `@` is git's own name for HEAD, which --branch expands.
    if (git(branch)) assert.ok(['@', 'a+b', 'ä', 'x'.repeat(121)].includes(branch), `only the allowlist and the cap refuse ${branch} where git takes it`);
  }
});

test('a branch git would read as another ref is refused, in any case: refs/, the default branch, a remote, a HEAD name, a commit id', () => {
  const names = { defaultBranches: ['main', 'trunk'], remotes: ['origin', 'upstream'] };
  const refused = {
    'refs/heads/x': /starts with refs\//u,
    main: /is the default branch/u,
    trunk: /is the default branch/u,
    origin: /the name of a remote/u,
    'origin/feat-x': /starts with origin, the name of a remote/u,
    'upstream/x': /starts with upstream/u,
    FETCH_HEAD: /HEAD name/u,
    'feat/ORIG_HEAD': /HEAD name/u,
    MERGE_HEAD: /HEAD name/u,
    HEAD: /HEAD name/u,
    Main: /is the default branch/u,
    MAIN: /is the default branch/u,
    'Origin/x': /the name of a remote/u,
    'REFS/heads/x': /starts with refs\//u,
    'Refs/x': /starts with refs\//u,
    'feat/fetch_head': /HEAD name/u,
    'feat/head': /HEAD name/u,
    Head: /HEAD name/u,
    ['a'.repeat(40)]: /reads as a commit id/u,
    [`feat/${'0123456789abcdef'.repeat(4)}`]: /reads as a commit id/u,
    ['ABCDEF0123'.repeat(4)]: /reads as a commit id/u,
  };
  for (const [branch, why] of Object.entries(refused)) assert.match(branchProblem(branch, names) ?? '', why, branch);
  for (const branch of ['main-fix', 'feat/main', 'originals/x', 'feat/ahead', 'ahead', 'head-room', 'heads_up', 'a'.repeat(39), 'a'.repeat(41)]) assert.equal(branchProblem(branch, names), null, branch);
  assert.match(validateSnapshot({ issues: [{ ...issue('ENG-1'), branch: 'main' }] }, names).problems[0], /issues\[0\]\.branch "main" is the default branch/u);
});
