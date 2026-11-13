import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { escapedFixes } from '../plugins/aidrian/lib/review/bench.mjs';
import { dedupe, packageRoots, partition, sliceKey, splitPasses } from '../plugins/aidrian/lib/review/split.mjs';
import { emptyState, prunePasses, readLocalState, readRecord, recordFile, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

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
  const again = splitPasses('codex-local', slices, { kind: 'exec', halved: { [passes[0].id]: true, [`${passes[0].id}.a`]: true } });
  assert.deepEqual(again.map((pass) => pass.files), [['a1'], ['a2'], ['a3'], ['b1'], null]);
  assert.deepEqual(again.slice(0, 3).map((pass) => pass.id), [`${passes[0].id}.a.a`, `${passes[0].id}.a.b`, `${passes[0].id}.b`]);
  assert.deepEqual(again.at(-1).after, again.slice(0, -1).map((pass) => pass.id));
  const oneFile = splitPasses('codex-local', slices, { kind: 'exec', halved: { [passes[1].id]: true } });
  assert.deepEqual(oneFile.map((pass) => pass.id), passes.map((pass) => pass.id), 'one file has nothing to split');
});

test('prunePasses: the live halves of a half stay, and they go once a fix repacks the slice', () => {
  const slices = [{ key: 'src/a', files: ['a1', 'a2', 'a3'] }];
  const [whole] = splitPasses('codex-local', slices);
  const halved = { [whole.id]: true, [`${whole.id}.a`]: true };
  const live = splitPasses('codex-local', slices, { halved }).filter((pass) => pass.role === 'slice');
  const record = () => ({ ...emptyState(7, 'o/r'), halved, passes: Object.fromEntries(live.map((pass) => [pass.id, { head: 'h', files: [...pass.files], findings: 0, open: 0 }])) });
  assert.deepEqual(Object.keys(prunePasses(record(), slices).passes).sort(), live.map((pass) => pass.id).sort());
  assert.deepEqual(Object.keys(prunePasses(record(), [{ key: 'src/a', files: ['z1'] }]).passes), [], 'no result of the old packing can count again');
});

test('dedupe: one finding per mistake across passes, at its highest severity', () => {
  const merged = dedupe([
    ['slice:a', [{ file: 'x.js', line: 10, title: 'Missing null check', severity: 'medium' }]],
    ['cross', [{ file: 'x.js', line: 12, title: 'missing null check!', severity: 'high' }, { file: 'y.js', line: 1, title: 'Other', severity: 'low' }]],
  ]);
  assert.deepEqual(merged.map((each) => [each.file, each.severity, each.sources]), [['x.js', 'high', ['slice:a', 'cross']], ['y.js', 'low', ['cross']]]);
});

// A repository whose feat branch changes files in four folders, with a split rule.
function repo(t, review = {}, github = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-split-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.aidrian/config.json', JSON.stringify({ version: 1, github, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }], split: { sliceLines: 100, parallel: 2, maxSlices: 8 }, ...review } }));
  for (const d of ['a', 'b', 'c', 'd']) write(`src/${d}/x.js`, '0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  for (const d of ['a', 'b', 'c', 'd']) write(`src/${d}/x.js`, '1\n2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const forge = { change: () => ({ number: 3, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main' }), repo: () => 'o/r', conversationComments: () => [], reviews: () => [], reviewComments: () => [], postComment: () => {}, editComment: () => {} };
  const step = (exec) => {
    const project = projectAt(dir);
    return reviewStep({ pr: '3' }, { project, config: loadConfig(project).config, forge, exec, codex: () => ({ ok: true }) });
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

const answered = { status: 'done', findings: [], verdicts: [], contracts: [], cross_notes: [], dropped: [] };

// The fixture with src/a changing four files, so its slice can be cut twice.
function fourFileSlice(t) {
  const r = repo(t, { split: { sliceLines: 1000, parallel: 8, maxSlices: 8 } });
  for (const name of ['w', 'y', 'z']) r.write(`src/a/${name}.js`, '1\n');
  r.commit();
  return r;
}

// Steps the review until it stops asking for another, and counts how often each slice's files ran.
async function runReview(r, exec, steps = 24) {
  const runs = new Map();
  const results = [];
  const counted = async (reviewer, input) => {
    if (input.role === 'slice') runs.set(input.files.join(' '), (runs.get(input.files.join(' ')) ?? 0) + 1);
    return exec(reviewer, input);
  };
  for (let step = 0; step < steps; step += 1) {
    results.push(await r.step(counted));
    if (!['running', 'incomplete'].includes(results.at(-1).status)) break;
  }
  return { runs, results, last: results.at(-1) };
}

test('a slice that times out runs as two halves on the next step, every slice of the step at once', async (t) => {
  // maxSlices 2 merges the four folders into two slices of two files each, and both time out in one step.
  const r = repo(t, { split: { sliceLines: 1000, parallel: 8, maxSlices: 2 } });
  const exec = async (_reviewer, input) => (input.role === 'slice' && input.files.length > 1 ? { status: 'timed_out', reason: 'no answer in 1 s' } : answered);
  const { runs, results, last } = await runReview(r, exec);
  assert.equal(last.status, 'received');
  assert.deepEqual([...runs.values()], [1, 1, 1, 1, 1, 1], 'each whole slice ran once, then each half once');
  const halving = results.filter((result) => /runs as two halves next/u.test(result.reason ?? ''));
  assert.ok(halving.length > 0 && halving.every((result) => result.attempts === 1), 'the first timeout halves');
});

test('a half that times out splits again, down to one file', async (t) => {
  const r = fourFileSlice(t);
  const exec = async (_reviewer, input) => (input.role === 'slice' && input.files.length > 1 ? { status: 'timed_out', reason: 'no answer in 1 s' } : answered);
  const { runs, last } = await runReview(r, exec);
  assert.equal(last.status, 'received');
  assert.deepEqual([...runs.keys()].filter((files) => files.includes(' ')).sort(), ['src/a/w.js src/a/x.js', 'src/a/w.js src/a/x.js src/a/y.js src/a/z.js', 'src/a/y.js src/a/z.js']);
  assert.ok([...runs.values()].every((count) => count === 1), `every input ran once: ${JSON.stringify([...runs])}`);
  const suffixes = Object.keys(readLocalState(projectAt(r.dir), 3).passes).map((id) => /\.[ab]\.[ab]$/u.exec(id)?.[0]).filter(Boolean).sort();
  assert.deepEqual(suffixes, ['.a.a', '.a.b', '.b.a', '.b.b'], 'the record holds the four one-file passes');
});

test('a failure that is no timeout keeps the second-failure rule, at every level', async (t) => {
  const r = fourFileSlice(t);
  const exec = async (_reviewer, input) => (input.role === 'slice' && input.files.length > 1 ? { status: 'failed', reason: 'too big' } : answered);
  const { runs, last } = await runReview(r, exec);
  assert.equal(last.status, 'received');
  assert.equal(runs.get('src/a/w.js src/a/x.js src/a/y.js src/a/z.js'), 2, 'the whole slice ran twice');
  assert.equal(runs.get('src/a/w.js src/a/x.js'), 2, 'a half that fails is cut at its second failure too, never stuck with files to split');
});

test('a timeout splits its slice even when another slice`s plain failure comes first in the step', async (t) => {
  const r = repo(t, { split: { sliceLines: 1000, parallel: 8, maxSlices: 2 } });
  const exec = async (_reviewer, input) => {
    if (input.role !== 'slice' || input.files.length < 2) return answered;
    return input.files.includes('src/a/x.js') ? { status: 'failed', reason: 'too big' } : { status: 'timed_out', reason: 'no answer in 1 s' };
  };
  const { runs, results, last } = await runReview(r, exec);
  assert.equal(last.status, 'received');
  assert.equal(runs.get('src/c/x.js src/d/x.js'), 1, 'the slice that timed out ran whole once');
  assert.equal(runs.get('src/a/x.js src/b/x.js'), 2, 'the slice that failed ran whole twice');
  assert.equal(results[0].attempts, 1);
  assert.match(results[0].reason, /too big after \d+ s; slice:.*no answer in 1 s after \d+ s; it runs as two halves next/u, 'the reason names both');
});

test('a one-file slice or the cross pass that times out has nothing to split and is stuck on its third attempt', async (t) => {
  const single = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  const alone = await runReview(single, async (_reviewer, input) => (input.files?.[0] === 'src/a/x.js' ? { status: 'timed_out', reason: 'no answer in 1 s' } : answered));
  assert.deepEqual([alone.last.status, alone.last.attempts, alone.runs.get('src/a/x.js')], ['stuck', 3, 3]);
  assert.ok(alone.results.every((result) => !/two halves/u.test(result.reason ?? '')));

  const cross = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  const last = await runReview(cross, async (_reviewer, input) => (input.role === 'cross' ? { status: 'timed_out', reason: 'no answer in 1 s' } : answered));
  assert.deepEqual([last.last.status, last.last.attempts], ['stuck', 3]);
  assert.ok(last.results.every((result) => !/two halves/u.test(result.reason ?? '')));
});

test('a plan command`s own slice pass cannot be cut, so a timeout still ends stuck on its third attempt', async (t) => {
  const r = repo(t, { planCommand: 'node plan.mjs' });
  const own = { id: 'slice:own:partition', reviewer: 'codex-local', kind: 'exec', role: 'slice', slice: 'own', files: ['src/a/x.js', 'src/b/x.js'], context: 'full' };
  const planner = `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'local',passes:[${JSON.stringify(own)}]}]})))`;
  r.git('switch', '-q', 'main');
  r.write('plan.mjs', planner);
  r.commit();
  r.git('switch', '-q', 'feat');
  r.git('rebase', '-q', 'main');
  const { last, results } = await runReview(r, async (_reviewer, input) => (input.slice === 'own' ? { status: 'timed_out', reason: 'no answer in 1 s' } : answered), 6);
  assert.deepEqual(results.at(-1).reason?.includes('slice:own:partition'), true, JSON.stringify(last));
  assert.deepEqual([last.status, last.attempts], ['stuck', 3]);
});

test('a pass records its whole seconds, and a failure says how long it ran', async (t) => {
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } });
  const slow = async (_reviewer, input) => {
    if (input.files?.[0] === 'src/a/x.js') return { status: 'failed', reason: 'boom' };
    await new Promise((done) => setTimeout(done, 1100));
    return answered;
  };
  const failed = await r.step(slow);
  assert.match(failed.reason, /: boom after \d+ s$/u);
  const state = readLocalState(projectAt(r.dir), 3);
  const entries = Object.values(state.passes);
  assert.equal(entries.length, 3);
  for (const entry of entries) assert.ok(Number.isInteger(entry.seconds) && entry.seconds >= 1, JSON.stringify(entry));
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

test('a plan command that raises the depth to split gets slices and a cross pass', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'split',stages:[]})))";
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-split-pc-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => (mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }), writeFileSync(path.join(dir, file), text));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.aidrian/config.json', JSON.stringify({ version: 1, review: { planCommand: 'node plan.mjs' } }));
  write('plan.mjs', planner);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  for (const d of ['a', 'b']) write(`src/${d}/x.js`, '1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const forge = { change: () => ({ number: 4, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main' }), repo: () => 'o/r', conversationComments: () => [], reviews: () => [], reviewComments: () => [], postComment: () => {}, editComment: () => {} };
  const project = projectAt(dir);
  const result = await reviewStep({ pr: '4' }, { project, config: loadConfig(project).config, forge, codex: () => ({ ok: true }), exec: async () => ({ status: 'done', findings: [], verdicts: [], contracts: [], cross_notes: [], dropped: [] }) });
  assert.deepEqual(result.plan.stages[0].passes.map((id) => id.split(':')[0]), ['slice', 'slice', 'cross']);
});

test('extra rounds: a mistake a slice and the cross pass both report is one open finding of its round', async (t) => {
  const r = repo(t, { split: { sliceLines: 100, parallel: 8, maxSlices: 8 } }, { maxReviewRounds: 2 });
  const at = (line, title) => ({ file: 'src/a/x.js', line, title, body: 'b', severity: 'high' });
  let round = 1;
  const exec = async (_reviewer, input) => {
    const slice = input.role === 'slice' && input.files[0] === 'src/a/x.js';
    const findings = round === 1
      ? (slice ? [at(1, 'Null refund total'), at(40, 'Missing lock on save'), at(80, 'Wrong currency rounding')] : [])
      : slice ? [at(120, 'Stale cache entry'), at(160, 'Unbounded retry loop')] : input.role === 'cross' ? [at(120, 'Stale cache entry')] : [];
    return { status: 'done', findings, verdicts: [], contracts: [], cross_notes: [], dropped: [] };
  };
  const settle = async () => {
    let result = await r.step(exec);
    while (result.status === 'running') result = await r.step(exec);
    return result;
  };
  assert.equal((await settle()).status, 'fix_required');
  round = 2;
  // Long enough to hold every line a finding names: a line past the end of its file is not recorded.
  r.write('src/a/x.js', Array.from({ length: 200 }, (_, i) => `fixed ${i}\n`).join(''));
  r.commit();
  const capped = await settle();
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.history.map((each) => [each.open, each.findings.length]), [[3, 3], [2, 2]], 'the cross pass`s copy is not a third finding');
  assert.equal(capped.extension.signals.converging, true);
});

test('bench: an escaped fix is found for a project at the root and below it, by its path from the repository top', (t) => {
  for (const prefix of ['', 'apps/web/']) {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-escaped-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const git = (...args) => {
      const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z' } });
      assert.equal(run.status, 0, run.stderr);
      return run.stdout.trim();
    };
    git('init', '-q', '-b', 'main');
    const project = path.join(dir, prefix);
    mkdirSync(path.join(project, 'src'), { recursive: true });
    const file = (name, text) => writeFileSync(path.join(project, name), text);
    file('src/a.js', '1\n');
    file('src/other.js', '1\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    file('src/a.js', '2\n');
    git('commit', '-qam', 'feat: the change');
    const head = git('rev-parse', 'HEAD');
    file('src/a.js', '3\n');
    file('src/other.js', '2\n');
    git('commit', '-qam', 'fix: what it broke');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const found = escapedFixes(project, { base, head, baseRefName: 'main', mergedAt: '2026-01-01T00:00:00Z' });
    assert.deepEqual(found, [{ source: 'escaped', file: `${prefix}src/a.js`, line: null }], prefix || 'root');
  }
});

test('dedupe never throws on, and never merges, findings that have no title', () => {
  const merged = dedupe([
    ['slice:a', [{ id: 'R1-1', file: 'x.js', line: 10, severity: 'medium' }, { id: 'R1-2', file: 'x.js', line: 11, title: '', severity: 'low' }]],
    ['cross', [{ id: 'R1-3', file: 'x.js', line: 10, severity: 'high' }, { id: 'R1-4', file: 'x.js', line: 12, title: 'Missing null check', severity: 'low' }]],
  ]);
  assert.deepEqual(merged.map((each) => each.id), ['R1-1', 'R1-2', 'R1-3', 'R1-4']);
});

test('a machine with no record restarts from a public copy: every slice runs again with its report, then the cross pass', async (t) => {
  const r = repo(t);
  const seen = [];
  const exec = async (_reviewer, input) => {
    seen.push(input.role === 'slice' ? input.files[0] : input.role);
    if (input.role === 'cross') assert.deepEqual(input.slices.map((each) => each.contracts), [['a()'], ['b()'], ['c()'], ['d()']], 'the cross pass reads every slice`s report');
    return { status: 'done', findings: [], verdicts: [], contracts: input.role === 'slice' ? [`${input.files[0].split('/')[1]}()`] : [], cross_notes: [], dropped: [] };
  };
  assert.equal((await r.step(exec)).status, 'running');
  // Another machine with no record reads the public copy of this record, then writes what it read, as `aidrian pr extend` does.
  const project = projectAt(r.dir);
  const before = readLocalState(project, 3);
  const body = summaryBody(before, null, 'running', { reading: { visibility: 'PUBLIC', inside: true }, root: r.dir, names: [] });
  rmSync(recordFile(project, 3));
  const restarted = readRecord(project, 3, [{ id: 1, body, author_association: 'MEMBER' }], 'o/r', { visibility: 'PUBLIC', inside: true }).state;
  assert.deepEqual(restarted.passes, {}, 'no finished slice of the copy is taken without its report');
  assert.equal(restarted.rounds.length, before.rounds.length, 'the round count is the copy`s');
  writeLocalState(project, restarted);
  seen.length = 0;
  let result = await r.step(exec);
  while (result.status === 'running') result = await r.step(exec);
  assert.equal(result.status, 'received');
  assert.deepEqual(seen.slice(-1), ['cross']);
  assert.equal(seen.filter((each) => each !== 'cross').length, 4, 'every slice ran again');
  assert.equal(readLocalState(project, 3).rounds.length, before.rounds.length, 'in the round the copy opened');
});
