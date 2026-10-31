import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { dedupe, packageRoots, partition, sliceKey, splitPasses } from '../plugins/aidrian/lib/review/split.mjs';

const change = (file, lines = 10) => ({ file, added: lines, removed: 0, status: 'M' });

test('sliceKey and packageRoots: the nearest package root, else the first two segments', () => {
  const roots = packageRoots(['package.json', 'apps/web/package.json', 'services/api/go.mod', 'apps/web/src/a.ts']);
  assert.deepEqual([...roots].sort(), ['apps/web', 'services/api']);
  assert.equal(sliceKey('apps/web/src/a.ts', roots), 'apps/web');
  assert.equal(sliceKey('services/api/handlers/x.go', roots), 'services/api');
  assert.equal(sliceKey('src/lib/util.js', roots), 'src/lib');
  assert.equal(sliceKey('README.md', roots), '.');
});

test('partition: groups by key, cuts big groups at sliceLines, merges the smallest neighbours past maxSlices, and is stable', () => {
  const changes = [change('src/a/1.js', 500), change('src/a/2.js', 500), change('src/b/1.js', 50), change('src/c/1.js', 60), change('src/d/1.js', 70)];
  const slices = partition(changes, new Set(), { sliceLines: 800, maxSlices: 4 });
  assert.deepEqual(slices.map((slice) => [slice.key, slice.files]), [
    ['src/a', ['src/a/1.js']],
    ['src/a#1', ['src/a/2.js']],
    ['src/b+src/c', ['src/b/1.js', 'src/c/1.js']],
    ['src/d', ['src/d/1.js']],
  ]);
  assert.deepEqual(partition([...changes].reverse(), new Set(), { sliceLines: 800, maxSlices: 4 }), slices);
});

test('splitPasses: a pass per slice, the cross pass after all of them, and a twice-failed slice as two halves', () => {
  const slices = [{ key: 'src/a', files: ['a1', 'a2', 'a3'] }, { key: 'src/b', files: ['b1'] }];
  const passes = splitPasses('codex-local', slices, { kind: 'exec' });
  assert.deepEqual(passes.map((pass) => [pass.role, pass.files]), [['slice', ['a1', 'a2', 'a3']], ['slice', ['b1']], ['cross', null]]);
  assert.deepEqual(passes.at(-1).after, [passes[0].id, passes[1].id]);
  const halved = splitPasses('codex-local', slices, { kind: 'exec', halved: { [passes[0].id]: true } });
  assert.deepEqual(halved.map((pass) => pass.files), [['a1', 'a2'], ['a3'], ['b1'], null]);
});

test('dedupe: one finding per mistake across passes, at its highest severity', () => {
  const merged = dedupe([
    ['slice:a', [{ file: 'x.js', line: 10, title: 'Missing null check', severity: 'medium' }]],
    ['cross', [{ file: 'x.js', line: 12, title: 'missing null check!', severity: 'high' }, { file: 'y.js', line: 1, title: 'Other', severity: 'low' }]],
  ]);
  assert.deepEqual(merged.map((each) => [each.file, each.severity, each.sources]), [['x.js', 'high', ['slice:a', 'cross']], ['y.js', 'low', ['cross']]]);
});

// A repository whose feat branch changes files in four folders, with a split rule.
function repo(t, review = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-split-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.aidrian/config.json', JSON.stringify({ version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }], split: { sliceLines: 100, parallel: 2, maxSlices: 8 }, ...review } }));
  for (const d of ['a', 'b', 'c', 'd']) write(`src/${d}/x.js`, '0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  for (const d of ['a', 'b', 'c', 'd']) write(`src/${d}/x.js`, '1\n2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const gh = { pr: () => ({ number: 3, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main' }), repo: () => 'o/r', comments: () => [], post: () => {}, edit: () => {} };
  const step = (exec) => {
    const project = projectAt(dir);
    return reviewStep({ pr: '3' }, { project, config: loadConfig(project).config, gh, exec, codex: () => ({ ok: true }) });
  };
  return { dir, git, write, step, commit: () => (git('add', '-A'), git('commit', '-q', '-m', 'next')) };
}

test('a split review runs its slices in batches, then the cross pass with their contracts, then passes', async (t) => {
  const r = repo(t);
  const seen = [];
  const exec = async (_reviewer, input) => {
    seen.push(input.role === 'slice' ? input.files[0] : input.role);
    if (input.role === 'cross') {
      assert.deepEqual(input.slices.map((each) => each.contracts), [['a()'], ['b()'], ['c()'], ['d()']]);
      assert.equal(input.manifest.length, 4);
    }
    return { status: 'done', findings: [], verdicts: [], contracts: input.role === 'slice' ? [`${input.files[0].split('/')[1]}()`] : [], cross_notes: [], dropped: [] };
  };
  const first = await r.step(exec);
  assert.deepEqual([first.status, first.done, first.total], ['running', 2, 5]);
  assert.equal((await r.step(exec)).status, 'running');
  assert.equal((await r.step(exec)).status, 'received');
  assert.deepEqual(seen, ['src/a/x.js', 'src/b/x.js', 'src/c/x.js', 'src/d/x.js', 'cross']);
});

test('after a fix only the touched slice and the cross pass run again', async (t) => {
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  const seen = [];
  let firstRun = true;
  const exec = async (_reviewer, input) => {
    seen.push(input.role === 'slice' ? input.files[0] : input.role);
    const finding = firstRun && input.files?.[0] === 'src/b/x.js' ? [{ file: 'src/b/x.js', line: 1, title: 'bug', body: 'b', severity: 'high' }] : [];
    return { status: 'done', findings: finding, verdicts: [], contracts: [], cross_notes: [], dropped: [] };
  };
  await r.step(exec);
  const fix = await r.step(exec);
  assert.equal(fix.status, 'fix_required');
  assert.equal(fix.findings_merged.length, 1);
  firstRun = false;
  seen.length = 0;
  r.write('src/b/x.js', 'fixed\n');
  r.commit();
  await r.step(exec);
  assert.equal((await r.step(exec)).status, 'received');
  assert.deepEqual(seen, ['src/b/x.js', 'cross']);
});

test('a slice that fails twice runs as two halves; a partial review is never received', async (t) => {
  // maxSlices 2 merges the four folders into two slices of two files each.
  const r = repo(t, { split: { sliceLines: 1000, parallel: 8, maxSlices: 2 } });
  const exec = async (_reviewer, input) => (input.role === 'slice' && input.files.length > 1 ? { status: 'failed', reason: 'too big' } : { status: 'done', findings: [], verdicts: [], contracts: [], cross_notes: [], dropped: [] });
  const statuses = [];
  const reasons = [];
  for (let step = 0; step < 12 && statuses.at(-1) !== 'received'; step += 1) {
    const result = await r.step(exec);
    statuses.push(result.status);
    if (result.reason) reasons.push(result.reason);
  }
  assert.equal(statuses.at(-1), 'received');
  assert.ok(statuses.slice(0, -1).every((status) => status !== 'received'), 'nothing passes while a slice is missing');
  assert.equal(reasons.filter((reason) => /runs as two halves next/u.test(reason)).length, 2, 'each two-file slice was halved after its second failure');
});

test('the self engine splits too: one agent dispatch per slice, then the cross pass', async (t) => {
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'self' } }));
  const first = await r.step(async () => ({}));
  assert.equal(first.status, 'dispatch');
  assert.deepEqual(first.dispatch.map((each) => [each.agent, each.role]), [['code-reviewer', 'slice'], ['code-reviewer', 'slice'], ['code-reviewer', 'slice'], ['code-reviewer', 'slice']]);
});

test('bench: recall per source, and split passes when it finds as much as single less the tolerance', async () => {
  const { covers, recall, verdict } = await import('../plugins/aidrian/lib/review/bench.mjs');
  const problems = [{ source: 'bot', file: 'a.js', line: 10 }, { source: 'human', file: 'b.js', line: 50 }, { source: 'escaped', file: 'c.js', line: null }];
  assert.equal(covers([{ file: 'a.js', line: 19 }], problems[0]), true);
  assert.equal(covers([{ file: 'a.js', line: 21 }], problems[0]), false);
  assert.equal(covers([{ file: 'c.js', line: 400 }], problems[2]), true, 'an escaped problem matches by file');
  const single = recall(problems, [{ file: 'a.js', line: 10 }, { file: 'b.js', line: 50 }]);
  const split = recall(problems, [{ file: 'a.js', line: 12 }]);
  assert.deepEqual(single, { bot: { found: 1, total: 1 }, human: { found: 1, total: 1 }, escaped: { found: 0, total: 1 } });
  assert.deepEqual(verdict([{ single, split }], 1), { single: 2, split: 1, total: 3, passes: true });
  assert.equal(verdict([{ single, split }], 0).passes, false);
});

test('an agent slice`s contracts reach the cross pass through attest', async (t) => {
  const { recordPass } = await import('../plugins/aidrian/lib/review/run.mjs');
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  r.write('.aidrian.local.json', JSON.stringify({ review: { engine: 'self' } }));
  const project = projectAt(r.dir);
  const first = await r.step(async () => ({}));
  for (const pass of first.dispatch) {
    recordPass(project, { pr: 3, repo: 'o/r', pass: pass.pass, head: pass.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify({ verdicts: [], contracts: [`${pass.files[0]} exports x`], cross_notes: [] }) });
  }
  const cross = await r.step(async () => ({}));
  assert.equal(cross.dispatch[0].role, 'cross');
  assert.deepEqual(cross.dispatch[0].slices.map((each) => each.contracts[0]), ['src/a/x.js exports x', 'src/b/x.js exports x', 'src/c/x.js exports x', 'src/d/x.js exports x']);
});

test('bench: a reviewer run that fails makes the sample incomplete, never a measured zero', async (t) => {
  const { reviewAt } = await import('../plugins/aidrian/lib/review/bench.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-bench-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const failing = { name: 'f', kind: 'exec', command: [process.execPath, '-e', 'process.exit(1)'], timeoutSec: 5 };
  const context = { base: 'a', head: 'b', changes: [change('src/a.js')], roots: new Set(), env: process.env };
  for (const split of [false, true]) await assert.rejects(reviewAt(dir, failing, { ...context, split }), (error) => error.incomplete === true);
});

test('a slice that covers other files after a fix keeps none of its old history', async (t) => {
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  const seen = [];
  const exec = async (_reviewer, input) => {
    seen.push([input.role, input.files, input.context, input.priorFindings.length]);
    const bug = input.files?.includes('src/b/x.js') && !input.files.includes('src/a/y.js') ? [{ file: 'src/b/x.js', line: 1, title: 'bug', body: 'b', severity: 'high' }] : [];
    return { status: 'done', findings: bug, verdicts: [], contracts: [], cross_notes: [], dropped: [] };
  };
  await r.step(exec);
  assert.equal((await r.step(exec)).status, 'fix_required');
  // A new file in src/a makes the src/a slice cover two files: its id stays, its files change.
  r.write('src/a/y.js', '1\n');
  r.commit();
  seen.length = 0;
  await r.step(exec);
  const slice = seen.find(([role, files]) => role === 'slice' && files.includes('src/a/y.js'));
  assert.deepEqual([slice[2], slice[3]], ['full', 0], 'the repacked slice is reviewed whole, with no other slice`s findings');
});

test('a pull request cannot shrink its own split: review.split comes from the base and its change needs the Human', async () => {
  const { reviewInForce } = await import('../plugins/aidrian/lib/review/run.mjs');
  const base = { rules: [], ignore: [], nonBehaviour: [], flows: {}, planCommand: null, reviewers: {}, split: { sliceLines: 100, parallel: 4, maxSlices: 8 } };
  const { review, changed } = reviewInForce(base, { ...base, split: { sliceLines: 10000, parallel: 4, maxSlices: 2 } });
  assert.deepEqual([review.split, changed], [base.split, ['split']]);
});
