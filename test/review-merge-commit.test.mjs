import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { baseMergeOf, cleanBaseMerge, isMergeCommit, parents, remergeDiff } from '../plugins/aidrian/lib/review/diff.mjs';
import { passInput } from '../plugins/aidrian/lib/review/dispatch.mjs';
import { baseMergedBrief, flowBaseBrief, reviewPrompt } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { recordPass, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { recordPending } from '../plugins/aidrian/lib/review/pending.mjs';
import { emptyState, noteOutcome, readLocalState, stateFromComment, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

// A temporary repository with `main` (plus `baseFiles`) and a `feat` branch whose one commit writes `feature`, by
// default `src/app.js` set to 2, with GitHub faked in memory, as test/review-run.test.mjs builds it. `mergeMain(files, resolution)` commits `files` on main, merges main
// into feat, and, when the merge conflicts, writes `resolution` and commits it. No GIT_DIR: every git call runs in
// the temporary folder.
function repo(t, { baseConfig = { version: 1 }, baseFiles = {}, feature = { 'src/app.js': 'export const app = 2;\n' } } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-merge-commit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
  const git = (...args) => {
    const r = run(...args);
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const commit = (message) => (git('add', '-A'), git('commit', '-q', '-m', message), git('rev-parse', 'HEAD'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  write('.aidrian/config.json', JSON.stringify(baseConfig));
  write('src/app.js', 'export const app = 1;\n');
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  commit('base');
  git('switch', '-q', '-c', 'feat');
  for (const [file, text] of Object.entries(feature)) write(file, text);
  const first = commit('change');
  const mergeMain = (files, resolution = null) => {
    git('switch', '-q', 'main');
    for (const [file, text] of Object.entries(files)) write(file, text);
    commit('on main');
    git('switch', '-q', 'feat');
    const merged = run('merge', '-q', '--no-edit', 'main');
    if (merged.status !== 0) {
      if (!resolution) throw new Error(`the merge conflicts: ${merged.stdout}${merged.stderr}`);
      for (const [file, text] of Object.entries(resolution)) write(file, text);
      commit('merge main');
    }
    return git('rev-parse', 'HEAD');
  };
  const comments = [];
  const forge = {
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    conversationComments: () => comments,
    reviews: () => [],
    reviewComments: () => [],
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body, author_association: 'MEMBER' }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const step = (deps = {}) => {
    const project = projectAt(dir);
    return reviewStep({ pr: '7' }, { project, config: loadConfig(project).config, forge, codex: () => ({ ok: true }), ...deps });
  };
  // The merge guard's answer for a merge of #7 at `head`, through the Bash rule as the hook runs it.
  const guard = (head) => check(`gh pr merge 7 --match-head-commit ${head}`, { cwd: dir, env: {}, input: {}, viewPr: () => null });
  return { dir, git, write, commit, first, mergeMain, comments, forge, step, guard, project: () => projectAt(dir) };
}

// An exec reviewer that finds nothing, and keeps each input it was given.
const recorder = () => {
  const inputs = [];
  return { inputs, exec: async (_reviewer, input) => (inputs.push(input), { status: 'done', findings: [], verdicts: [], dropped: [] }) };
};

const CONFLICT = { 'src/app.js': 'export const app = 9;\n', 'src/lib.js': 'export const lib = 1;\n' };
const RESOLVED = { 'src/app.js': 'export const app = 29;\n' };

test('cleanBaseMerge holds only for a merge from the base branch onto the reviewed head that resolved nothing', (t) => {
  const r = repo(t);
  assert.equal(isMergeCommit(r.dir, r.first), false);
  assert.equal(cleanBaseMerge(r.dir, r.first, { priorHead: r.git('rev-parse', 'main'), base: 'main' }), false, 'not a merge commit');

  const clean = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  assert.deepEqual(parents(r.dir, clean), [r.first, r.git('rev-parse', 'main')]);
  assert.equal(cleanBaseMerge(r.dir, clean, { priorHead: r.first, base: r.git('rev-parse', 'main') }), true);
  assert.equal(cleanBaseMerge(r.dir, clean, { priorHead: r.git('rev-parse', 'main~1'), base: 'main' }), false, 'its first parent is not the reviewed head');
  assert.equal(cleanBaseMerge(r.dir, clean, { priorHead: 'deadbeef', base: 'main' }), false, 'a reviewed head this checkout does not have');

  // A side branch off main that main never took: its merge resolves nothing either, but it is not the base branch.
  r.git('switch', '-q', '-c', 'side', 'main');
  r.write('src/side.js', 'export const side = 1;\n');
  r.commit('side');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'side');
  const sideMerge = r.git('rev-parse', 'HEAD');
  assert.deepEqual(remergeDiff(r.dir, sideMerge).changes, [], 'the side merge resolved nothing');
  assert.equal(cleanBaseMerge(r.dir, sideMerge, { priorHead: clean, base: r.git('rev-parse', 'main') }), false, 'its other parent is not on the base branch');
  assert.equal(baseMergeOf(r.dir, sideMerge, { priorHead: clean, base: 'main' }), null);
});

test('a merge with a resolved conflict is no clean merge, and its remerge diff holds only the resolution', (t) => {
  const r = repo(t);
  const merge = r.mergeMain(CONFLICT, RESOLVED);
  assert.equal(cleanBaseMerge(r.dir, merge, { priorHead: r.first, base: 'main' }), false);
  const scope = remergeDiff(r.dir, merge);
  // The conflict markers and both sides' lines are what the resolution removed; src/lib.js merged cleanly.
  assert.deepEqual(scope.changes, [{ file: 'src/app.js', added: 1, removed: 5, status: 'M' }]);
  assert.deepEqual(scope.addedLines, { 'src/app.js': ['export const app = 29;'] });
  assert.deepEqual([...scope.removedFiles], ['src/app.js']);
  assert.deepEqual(baseMergeOf(r.dir, merge, { priorHead: r.first, base: 'main' }), { clean: false, scope });
  assert.equal(remergeDiff(r.dir, r.first), null, 'a commit that is not a merge has no remerge diff');
});

test('a clean merge from the base branch carries the received review: no reviewer, no round, and the merge guard lets it merge', async (t) => {
  const r = repo(t);
  const first = recorder();
  assert.equal((await r.step({ exec: first.exec })).status, 'received');
  assert.equal(first.inputs.length, 1);
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  assert.match(r.guard(merge) ?? '', /Blocked/u, 'before the step, the merge head has no review');

  const again = recorder();
  const result = await r.step({ exec: again.exec });
  assert.deepEqual([result.status, result.head, result.carried_from, result.round], ['received', merge, r.first, 1]);
  assert.equal(again.inputs.length, 0, 'no reviewer ran');
  const state = readLocalState(r.project(), 7);
  assert.equal(state.rounds.length, 1, 'no round opened');
  assert.deepEqual([state.outcome.status, state.outcome.head, state.outcome.carried_from], ['received', merge, r.first]);
  assert.equal(stateFromComment(r.comments[0].body, 7).outcome.carried_from, r.first, 'the summary comment carries the record');
  assert.equal(r.guard(merge), null, 'the merge guard reads a finished review on the merge head, with no question to the Human');

  const repeat = await r.step({ exec: again.exec });
  assert.deepEqual([repeat.status, repeat.carried_from, again.inputs.length], ['received', r.first, 0], 'calling again on the same head carries again');

  // The summary comment says so where a person reads it: the merge head, the base commit, and the head reviewed.
  const main = r.git('rev-parse', 'main');
  assert.deepEqual([state.outcome.carried_base, result.carried_base], [main, main]);
  const carried = `- head \`${merge.slice(0, 7)}\` merges \`${main.slice(0, 7)}\` from the base branch and carries the review of \`${r.first.slice(0, 7)}\`: no reviewer ran on it`;
  const body = r.comments[0].body.split('\n');
  assert.deepEqual(body.slice(body.indexOf('**Carried review:**'), body.indexOf('**Carried review:**') + 2), ['**Carried review:**', carried]);
  assert.equal(body.filter((line) => line === '**Carried review:**').length, 1, 'a second carry rewrites the line, never adds one');

  // A head reviewed after it carries nothing, and the comment stops saying it does.
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('another change');
  const next = await r.step({ exec: again.exec });
  assert.deepEqual([next.status, next.carried_from], ['received', undefined]);
  assert.equal(r.comments[0].body.includes('**Carried review:**'), false);
});

test('a clean merge that brings in a new flow over the change reviews the merge head against it', async (t) => {
  const r = repo(t);
  assert.equal((await r.step({ exec: recorder().exec })).status, 'received');
  const merge = r.mergeMain({ '.aidrian/config.json': JSON.stringify({ version: 1, review: { flows: { app: { files: ['src/**'] } } } }) });
  assert.equal(cleanBaseMerge(r.dir, merge, { priorHead: r.first, base: 'main' }), true, 'git resolved nothing');
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.carried_from], ['dispatch', undefined], 'the reviewed head was never judged against the flow');
  assert.ok(result.plan.flows.includes('app'), JSON.stringify(result.plan.flows));
  assert.ok(result.dispatch.some((pass) => (pass.flows ?? []).some((flow) => flow.id === 'app')), 'the flow pass is dispatched');
  assert.ok(result.plan.reasons.includes('the merge from main changes how the project is reviewed (.aidrian/config.json review): the whole change is reviewed'), result.plan.reasons.join('; '));
  assert.notEqual(r.guard(merge), null, 'the merge guard refuses the merge head until its review finishes');
  const again = await r.step({ exec: seen.exec });
  assert.deepEqual([again.status, again.carried_from], ['dispatch', undefined], 'a later step on the merge head reviews it whole too');
});

// Commits `files` on main after feat merged it, and returns to feat: the base tip moves past the merged commit.
const advanceMain = (r, files) => {
  r.git('switch', '-q', 'main');
  for (const [file, text] of Object.entries(files)) r.write(file, text);
  r.commit('on main after the merge');
  r.git('switch', '-q', 'feat');
};
const NEW_FLOW = { '.aidrian/config.json': JSON.stringify({ version: 1, review: { flows: { app: { files: ['src/**'] } } } }) };

test('a clean merge carries no review once main, after the merged commit, adds a flow over the change', async (t) => {
  const r = repo(t);
  assert.equal((await r.step({ exec: recorder().exec })).status, 'received');
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  advanceMain(r, NEW_FLOW);
  const result = await r.step({ exec: recorder().exec });
  assert.deepEqual([result.status, result.head, result.carried_from], ['dispatch', merge, undefined], 'the reviewed head was never judged under the flow main has now');
  assert.ok(result.plan.flows.includes('app'), JSON.stringify(result.plan.flows));
  assert.ok(result.plan.reasons.includes('the merge from main changes how the project is reviewed (.aidrian/config.json review): the whole change is reviewed'), result.plan.reasons.join('; '));
});

test('a carried head is reviewed whole on a later call once main adds a flow after the merged commit', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const carried = await r.step({ exec: recorder().exec });
  assert.deepEqual([carried.status, carried.carried_from], ['received', r.first]);
  advanceMain(r, NEW_FLOW);
  const again = await r.step({ exec: recorder().exec });
  assert.deepEqual([again.status, again.carried_from], ['dispatch', undefined], 'the carried review does not hold under the new flow');
  assert.notEqual(r.guard(carried.head), null, 'the merge guard refuses the head until its review under the flow finishes');
});

test('a resolved merge is reviewed whole, not by its resolution alone, once main adds a review rule after the merged commit', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  r.mergeMain(CONFLICT, RESOLVED);
  advanceMain(r, { '.aidrian/config.json': JSON.stringify({ version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'single' }] } }) });
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.equal(result.status, 'received');
  assert.deepEqual([seen.inputs[0].remerge, seen.inputs[0].files], [undefined, null], 'no remerge scope: the pass reads the whole change');
  assert.equal(readLocalState(r.project(), 7).remerge, undefined);
});

test('a merge that brings in a resolution and a new review rule reviews the whole change, not the resolution alone', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  const merge = r.mergeMain({ ...CONFLICT, '.aidrian/config.json': JSON.stringify({ version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'single' }] } }) }, RESOLVED);
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.equal(result.status, 'received');
  assert.deepEqual([seen.inputs[0].remerge, seen.inputs[0].files], [undefined, null], 'no remerge scope: the pass reads the whole change');
  assert.equal(readLocalState(r.project(), 7).remerge, undefined);
  assert.equal(merge, result.head);
});

test('a clean merge that edits a flow\'s invariants doc reviews the merge head; one that changes only other config carries', async (t) => {
  const flows = { app: { files: ['src/**'], invariants: 'docs/flows/app.md' } };
  const doc = '# App\n\n## Invariants\n\n### app-stays-one\n\nThe app is one module.\n';
  const reviewed = (t) => {
    const r = repo(t, { baseConfig: { version: 1, review: { flows } }, baseFiles: { 'docs/flows/app.md': doc } });
    // The flow's agent pass has no result yet: the record says the head was reviewed, as a received outcome.
    writeLocalState(r.project(), noteOutcome(emptyState(7, 'o/r'), { status: 'received', head: r.first }));
    return r;
  };
  const docs = reviewed(t);
  docs.mergeMain({ 'docs/flows/app.md': `${doc}\n### app-has-no-globals\n\nThe app keeps no global state.\n` });
  const result = await docs.step({ exec: recorder().exec });
  assert.deepEqual([result.status, result.carried_from], ['dispatch', undefined]);
  assert.ok(result.plan.reasons.includes('the merge from main changes how the project is reviewed (docs/flows/app.md): the whole change is reviewed'), result.plan.reasons.join('; '));

  const other = reviewed(t);
  other.mergeMain({ '.aidrian/config.json': JSON.stringify({ version: 1, review: { flows }, github: { maxReviewRounds: 4 } }) });
  const carried = await other.step({ exec: recorder().exec });
  assert.deepEqual([carried.status, carried.carried_from], ['received', other.first], 'a config change outside review changes no rule');
});

test('a merge with a conflict resolution opens a round that reviews only the resolution', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  const merge = r.mergeMain(CONFLICT, RESOLVED);
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.round, result.carried_from], ['received', 2, undefined], 'it counts as a round');
  assert.equal(seen.inputs.length, 1);
  const [input] = seen.inputs;
  assert.deepEqual([input.files, input.remerge, input.head], [['src/app.js'], merge, merge], 'the pass reads only the resolved file');
  assert.match(reviewPrompt(input), new RegExp(`review only the changes the merge commit itself made, its conflict resolutions and any other edit, \`git show --remerge-diff ${merge}\``, 'u'));
  assert.equal(readLocalState(r.project(), 7).rounds.length, 2);
  assert.equal(r.guard(merge), null);
});

test('a later step on the same resolved merge, after its reviewer failed, still reviews only the resolution', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  const merge = r.mergeMain(CONFLICT, RESOLVED);
  const failed = await r.step({ exec: async () => ({ status: 'failed', reason: 'crashed' }) });
  assert.deepEqual([failed.status, readLocalState(r.project(), 7).outcome.head], ['incomplete', merge], 'the received outcome is gone from the record');
  const seen = recorder();
  assert.equal((await r.step({ exec: seen.exec })).status, 'received');
  assert.deepEqual([seen.inputs[0].files, seen.inputs[0].remerge], [['src/app.js'], merge], 'the first step on the merge head named the reviewed head it builds on');
});

test('a split review of a merge with a resolution lists only the resolved file in each slice and in the manifest', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }] } } });
  // A split step runs some passes per call: call again until it finishes.
  const until = async (exec) => {
    let result;
    for (let i = 0; i < 5 && (result?.status ?? 'running') === 'running'; i += 1) result = await r.step({ exec });
    return result;
  };
  assert.equal((await until(recorder().exec)).status, 'received');
  const merge = r.mergeMain(CONFLICT, RESOLVED);
  const seen = recorder();
  assert.equal((await until(seen.exec)).status, 'received');
  assert.ok(seen.inputs.length >= 1);
  for (const input of seen.inputs) {
    assert.equal(input.remerge, merge);
    assert.deepEqual(input.files, ['src/app.js'], `${input.role}: no file the merge only brought in from main`);
    if (input.manifest) assert.deepEqual(input.manifest.map((each) => each.file), ['src/app.js']);
  }
  assert.ok(seen.inputs.some((input) => input.manifest), 'the split passes carry the manifest');
});

test('a merge commit with no received review on record reviews as before, from the merge base', async (t) => {
  const r = repo(t);
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.round, result.carried_from], ['received', 1, undefined]);
  const [input] = seen.inputs;
  assert.deepEqual([input.base, input.head, input.context, input.files, input.remerge], [r.git('rev-parse', 'main'), merge, 'full', null, undefined]);
});

test('noteOutcome keeps carried_from only when it is a commit string', () => {
  const state = noteOutcome(emptyState(7, 'o/r'), { status: 'received', head: 'b'.repeat(40), carried_from: 'a'.repeat(40) });
  assert.equal(state.outcome.carried_from, 'a'.repeat(40));
  assert.equal(Object.hasOwn(noteOutcome(emptyState(7, 'o/r'), { status: 'received', head: 'b'.repeat(40) }).outcome, 'carried_from'), false);
});

// A merge of main into feat made by `make(r)` after `main` gained src/lib.js, once feat's first head is reviewed.
async function reviewedThenMerged(t, make, options = {}) {
  const r = repo(t, options);
  assert.equal((await r.step({ exec: recorder().exec })).status, 'received');
  r.git('switch', '-q', 'main');
  r.write('src/lib.js', 'export const lib = 1;\n');
  r.commit('on main');
  r.git('switch', '-q', 'feat');
  make(r);
  return { r, merge: r.git('rev-parse', 'HEAD') };
}

test('an octopus merge of main and a side branch is no base merge: it reviews as before, from the merge base', async (t) => {
  const { r, merge } = await reviewedThenMerged(t, (r) => {
    r.git('switch', '-q', '-c', 'side', 'main~1');
    r.write('src/side.js', 'export const side = 1;\n');
    r.commit('side');
    r.git('switch', '-q', 'feat');
    r.git('merge', '-q', '--no-edit', 'main', 'side');
  });
  assert.equal(parents(r.dir, merge).length, 3);
  assert.equal(baseMergeOf(r.dir, merge, { priorHead: r.first, base: 'main' }), null);
  assert.equal(remergeDiff(r.dir, merge), null, 'an octopus merge has no remerge diff');
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.carried_from, seen.inputs.length, seen.inputs[0].files, seen.inputs[0].remerge], ['received', undefined, 1, null, undefined]);
});

test('a merge that edits a file it had no conflict in reviews that edit', async (t) => {
  const { r, merge } = await reviewedThenMerged(t, (r) => {
    r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
    r.write('src/evil.js', 'export const evil = 1;\n');
    r.commit('merge main');
  });
  assert.deepEqual(baseMergeOf(r.dir, merge, { priorHead: r.first, base: 'main' }).scope.changes, [{ file: 'src/evil.js', added: 1, removed: 0, status: 'A' }]);
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.round, seen.inputs[0].files, seen.inputs[0].remerge], ['received', 2, ['src/evil.js'], merge]);
});

test('a merge whose own edit is only a comment opens a round: a merge from the base branch after a received outcome is never quiet', async (t) => {
  const { r, merge } = await reviewedThenMerged(t, (r) => {
    r.git('merge', '-q', '--no-commit', '--no-ff', 'main');
    r.write('src/app.js', '// why the app is two\nexport const app = 2;\n');
    r.commit('merge main');
  });
  assert.deepEqual(baseMergeOf(r.dir, merge, { priorHead: r.first, base: 'main' }).scope.changes.map((change) => change.file), ['src/app.js']);
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.round, seen.inputs[0]?.remerge], ['received', 2, merge]);
  assert.equal(readLocalState(r.project(), 7).rounds.at(-1).quiet, undefined);
});

// With no received outcome, or from another branch, nothing marks the merge as the base branch's: for the round count,
// what it brought is its change, judged as a push's is. The passes it touches run either way, and a pass after a merge
// from the base reads only this pull request's own change, plus the file of an open finding it must check again: never
// the base's code.
test('any other merge is judged by its change like a push: one bringing only docs keeps the round, one bringing code opens one', async (t) => {
  const finding = { file: 'src/app.js', line: 1, title: 'off by one', body: 'x', severity: 'high' };
  for (const [what, files, round] of [['docs', { 'docs/guide.md': 'hello\n' }, 1], ['code', { 'src/lib.js': 'export const lib = 1;\n' }, 2]]) {
    const r = repo(t);
    assert.equal((await r.step({ exec: async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] }) })).status, 'fix_required', what);
    const merge = r.mergeMain(files);
    const seen = recorder();
    const result = await r.step({ exec: seen.exec });
    assert.deepEqual([result.round, result.carried_from, seen.inputs.length, seen.inputs[0].context, seen.inputs[0].remerge], [round, undefined, 1, 'delta', undefined], `${what} from main after fix_required`);
    assert.deepEqual([seen.inputs[0].base, seen.inputs[0].baseMerged.from, seen.inputs[0].files], [r.git('rev-parse', 'main'), r.first, ['src/app.js']], `${what}: only the open finding's file, never what main brought`);
    const { rounds } = readLocalState(r.project(), 7);
    assert.deepEqual([rounds.length, rounds.at(-1).head, rounds[0].quiet?.[0].from], [round, merge, round === 1 ? r.first : undefined], what);
  }

  const r = repo(t);
  assert.equal((await r.step({ exec: recorder().exec })).status, 'received');
  r.git('switch', '-q', '-c', 'side', 'main');
  r.write('docs/side.md', 'hello\n');
  r.commit('side');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'side');
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.round, result.carried_from, seen.inputs[0]?.context], [1, undefined, 'delta'], 'docs from another branch after received');
  assert.deepEqual(readLocalState(r.project(), 7).rounds[0].quiet.map((each) => each.from), [r.first]);
});

// A head whose review ended fix_required, never received, with a finding on `file`. An agent pass the plan dispatches
// first, as a flow's, finds nothing: its record lets the engine's pass end the round.
async function fixRequired(t, options = {}, file = 'src/app.js') {
  const r = repo(t, options);
  const finding = { file, line: 1, title: 'off by one', body: 'x', severity: 'high' };
  const exec = async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] });
  let result = await r.step({ exec });
  if (result.status === 'dispatch') {
    for (const pass of result.dispatch) recordPass(r.project(), { pr: 7, repo: 'o/r', pass: pass.pass, head: result.head, reviewer: pass.agent, findings: 0, fixed: 0 });
    result = await r.step({ exec });
  }
  assert.equal(result.status, 'fix_required');
  return r;
}

test('after fix_required, a fix and a merge from the base: the delta reads only the pull request\'s own files, never one only the base changed', async (t) => {
  const r = await fixRequired(t);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.round, result.carried_from], ['received', 2, undefined]);
  const [input] = seen.inputs;
  assert.deepEqual([input.base, input.head, input.context, input.files, input.remerge], [r.git('rev-parse', 'main'), merge, 'delta', ['src/app.js'], undefined], 'src/lib.js came from main alone');
  assert.deepEqual(input.baseMerged, { base: r.git('rev-parse', 'main'), from: r.first, merges: [merge], rolledBack: [] });
  const prompt = reviewPrompt(input);
  assert.match(prompt, /Report findings only in these files: src\/app\.js\./u);
  assert.match(prompt, new RegExp(`only what this pull request changes, \`git diff ${input.baseMerged.base} ${merge}\`, or what a merge commit itself changed, \`git show --remerge-diff ${merge}\``, 'u'));
});

test('after fix_required, a merge from the base whose resolution takes the base\'s side: the delta holds the resolution, not the base\'s file', async (t) => {
  const r = await fixRequired(t, { feature: { 'src/app.js': 'export const app = 2;\n', 'src/extra.js': 'export const extra = 1;\n' } });
  // The resolution keeps main's line, so the pull request's whole change no longer holds src/app.js: only the merge's
  // own resolution diff does.
  const merge = r.mergeMain(CONFLICT, { 'src/app.js': 'export const app = 9;\n' });
  assert.equal(r.git('diff', '--name-only', r.git('merge-base', 'main', 'HEAD'), 'HEAD'), 'src/extra.js', 'the three-dot diff holds only src/extra.js');
  const seen = recorder();
  assert.equal((await r.step({ exec: seen.exec })).status, 'received');
  const [input] = seen.inputs;
  assert.deepEqual([input.base, input.baseMerged.from, input.context, input.files], [r.git('rev-parse', 'main'), r.first, 'delta', ['src/app.js']], 'the resolution is reviewed; src/lib.js, which main alone brought, is not');
  assert.deepEqual(input.baseMerged.merges, [merge]);
});

test('after fix_required, a merge from the base whose resolution keeps the branch\'s side: that resolution is still reviewed', async (t) => {
  const r = await fixRequired(t, { feature: { 'src/app.js': 'export const app = 2;\n', 'src/extra.js': 'export const extra = 1;\n' } }, 'src/extra.js');
  r.write('src/extra.js', 'export const extra = 2;\n');
  r.commit('fix');
  // src/app.js reads as at the earlier head, so the change since it does not hold the file: only the merge's own does.
  const merge = r.mergeMain(CONFLICT, { 'src/app.js': 'export const app = 2;\n' });
  const seen = recorder();
  assert.equal((await r.step({ exec: seen.exec })).status, 'received');
  const [input] = seen.inputs;
  assert.deepEqual([input.context, [...input.files].sort()], ['delta', ['src/app.js', 'src/extra.js']], 'the kept side is reviewed; src/lib.js, which main alone brought, is not');
  assert.deepEqual(input.baseMerged.merges, [merge]);
});

test('after fix_required, an open finding whose file changed nothing since stays in the list of a delta after a base merge', async (t) => {
  const r = await fixRequired(t);
  r.write('src/own.js', 'export const own = 1;\n');
  r.commit('more');
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const [input] = seen.inputs;
  assert.equal(input.context, 'delta');
  assert.deepEqual([...input.files].sort(), ['src/app.js', 'src/own.js'], 'src/app.js holds the open finding, so the reviewer can raise it again');
});

test('a merge inside the base branch\'s own history is not one of the branch\'s merges', async (t) => {
  const r = await fixRequired(t);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  r.git('switch', '-q', '-c', 'topic', 'main');
  r.write('src/topic.js', 'export const topic = 1;\n');
  r.commit('topic');
  r.git('switch', '-q', 'main');
  r.git('merge', '-q', '--no-ff', '--no-edit', 'topic');
  r.git('switch', '-q', 'feat');
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const [input] = seen.inputs;
  assert.deepEqual([input.files, input.baseMerged.merges], [['src/app.js'], [merge]], 'main\'s own merge of topic is the base\'s');
});

test('a merge on a topic branch forked before the earlier head, merged into the pull request since, is one of the branch\'s merges', async (t) => {
  const r = await fixRequired(t, { baseFiles: { 'src/t.js': 'export const t = 1;\n' } });
  const fork = r.git('merge-base', 'main', r.first);
  r.git('switch', '-q', 'main');
  r.write('src/t.js', 'export const t = 9;\n');
  r.commit('on main');
  // topic forked before the earlier head, and its own merge of main resolved src/t.js to main's side: that resolution
  // is in no merge-base diff, and its merge does not descend from the earlier head.
  r.git('switch', '-q', '-c', 'topic', fork);
  r.write('src/t.js', 'export const t = 2;\n');
  r.commit('topic');
  assert.throws(() => r.git('merge', '-q', '--no-edit', 'main'));
  r.write('src/t.js', 'export const t = 9;\n');
  const topicMerge = r.commit('merge main into topic');
  r.git('switch', '-q', 'feat');
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  r.git('merge', '-q', '--no-edit', 'topic');
  const merge = r.git('rev-parse', 'HEAD');
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const [input] = seen.inputs;
  assert.equal(input.context, 'delta');
  assert.deepEqual([...input.baseMerged.merges].sort(), [merge, topicMerge].sort(), 'topic\'s merge of main is the branch\'s own');
  assert.deepEqual([...input.files].sort(), ['src/app.js', 'src/t.js'], 'topic\'s resolution is reviewed');
});

test('a push that takes a file back to the base\'s text, then a base merge: that rollback is reviewed, never carried', async (t) => {
  const r = repo(t, { feature: { 'src/app.js': 'export const app = 2;\n', 'src/extra.js': 'export const extra = 1;\n' } });
  assert.equal((await r.step({ exec: recorder().exec })).status, 'received');
  r.write('src/app.js', 'export const app = 1;\n');
  r.commit('roll back');
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  assert.equal(r.git('diff', '--name-only', r.git('merge-base', 'main', 'HEAD'), 'HEAD'), 'src/extra.js', 'the merge-base diff no longer holds src/app.js');
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.equal(seen.inputs.length, 1, 'the earlier head\'s clean result is not reused: the rollback is the pull request\'s change');
  const [input] = seen.inputs;
  assert.deepEqual([result.status, input.context, input.files, input.base, input.baseMerged.from, input.baseMerged.merges], ['received', 'delta', ['src/app.js'], r.git('rev-parse', 'main'), r.first, [merge]]);
  // The diff from the merge base is empty there: the reviewer reads the rollback from the earlier head.
  assert.equal(r.git('diff', input.base, input.head, '--', 'src/app.js'), '');
  assert.deepEqual(input.baseMerged.rolledBack, ['src/app.js']);
  assert.match(r.git('diff', input.baseMerged.from, input.head, '--', 'src/app.js'), /^-export const app = 2;$/mu);
  const rollback = `git diff ${r.first} ${merge} -- <file>`;
  for (const each of [input, { ...input, role: 'slice', manifest: [] }]) assert.ok(reviewPrompt(each).includes(rollback), each.role ?? 'whole pass');
  assert.ok(baseMergedBrief(input).includes(`took src/app.js back to the base's text since ${r.first}`), baseMergedBrief(input));
  assert.ok(baseMergedBrief(input).includes(rollback), 'the agent brief names the rollback\'s diff');
});

test('an exec reviewer of a delta after a base merge reads the merge base as `base`: its own diff holds none of the base\'s lines', async (t) => {
  const lines = (first, last) => `${first}\nb\nc\nd\ne\n${last}\n`;
  const r = await fixRequired(t, { baseFiles: { 'src/app.js': lines('a', 'f') }, feature: { 'src/app.js': lines('A', 'f') } });
  r.write('src/app.js', lines('AA', 'f'));
  r.commit('fix');
  // main edits the same file far from the pull request's line, so the merge is clean and the file holds both.
  const merge = r.mergeMain({ 'src/app.js': lines('a', 'F') });
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const [input] = seen.inputs;
  assert.deepEqual([input.base, input.head, input.context, input.files, input.baseMerged.from], [r.git('rev-parse', 'main'), merge, 'delta', ['src/app.js'], r.first]);
  const own = r.git('diff', '--unified=0', input.base, input.head, '--', ...input.files);
  assert.match(own, /^\+AA$/mu);
  assert.doesNotMatch(own, /^\+F$/mu, 'main\'s line is not the pull request\'s');
});

test('a file-scoped pass reuses no earlier result across a base merge that changed how the project is reviewed', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec',files:['docs/guide.md']}]}]})))";
  const review = { planCommand: 'node scripts/plan.mjs', reviewers: { lint: { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' } } };
  const r = repo(t, {
    baseConfig: { version: 1, review },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    feature: { 'src/app.js': 'export const app = 2;\n', 'docs/guide.md': 'hello\n' },
  });
  const isLint = (input) => JSON.stringify(input.files) === '["docs/guide.md"]';
  const first = recorder();
  assert.equal((await r.step({ exec: first.exec })).status, 'received');
  assert.equal(first.inputs.filter(isLint).length, 1);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('push');
  // A rule that changes no pass of this plan: only the review's rules moved, and docs/guide.md is untouched since.
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n', '.aidrian/config.json': JSON.stringify({ version: 1, review: { ...review, rules: [{ when: { lines: { over: 100000 } }, depth: 'split' }] } }) });
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const lint = seen.inputs.find(isLint);
  assert.ok(lint, `the lint pass runs again: its earlier result was judged without main's new rule (${JSON.stringify(seen.inputs.map((input) => input.files))})`);
  assert.deepEqual([lint.base, lint.context, lint.baseMerged], [r.git('rev-parse', 'main'), 'full', undefined]);
});

test('the flow brief of a delta after a base merge points at the pull request\'s own change, never the range that holds the base\'s code', () => {
  const brief = flowBaseBrief({ base: 'ccc', head: 'bbb', flowBase: 'ccc', baseMerged: { base: 'ccc', from: 'aaa', merges: ['bbb'] } });
  assert.doesNotMatch(brief, /aaa\.\.bbb/u);
  assert.match(brief, /own change in the listed files/u);
  assert.match(flowBaseBrief({ base: 'aaa', head: 'bbb', flowBase: 'ccc' }), /aaa\.\.bbb/u);
});

test('the prompt of a delta after a base merge names the pull request\'s own diff, never the range that holds the base\'s code', () => {
  const merges = ['ddd', 'eee'];
  const input = { base: 'ccc', head: 'bbb', files: ['src/app.js'], flows: [], priorFindings: [], baseMerged: { base: 'ccc', from: 'aaa', merges } };
  for (const each of [input, { ...input, role: 'slice', manifest: [] }]) {
    const prompt = reviewPrompt(each);
    assert.doesNotMatch(prompt, /git diff aaa bbb/u, each.role ?? 'whole pass');
    assert.match(prompt, /git diff ccc bbb -- <file>/u, each.role ?? 'whole pass');
    for (const merge of merges) assert.match(prompt, new RegExp(`git show --remerge-diff ${merge}`, 'u'));
    assert.match(prompt, /Between aaa and bbb this branch merged the base branch/u, 'the brief names the earlier head, `baseMerged.from`');
  }
  assert.match(reviewPrompt({ ...input, base: 'aaa', baseMerged: undefined }), /run `git diff aaa bbb`/u, 'with no base merge, the range from the earlier head');
});

test('passInput: a blocking finding handed to the pass from another keeps its file in the list of a delta after a base merge', (t) => {
  const r = repo(t);
  r.write('src/own.js', 'export const own = 1;\n');
  const head = r.commit('more');
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'local', passes: [pass] };
  // An open entry of a pass the plan no longer holds goes to the first pass of its reviewer and stage (findings.mjs listing).
  const index = { 'R1-1': { title: 'handed on', file: 'src/handed.js', line: 1, severity: 'high', state: 'open', pass: 'engine:codex-gone', reviewer: 'codex-local', stage: 'local' } };
  const prior = { head: r.first, files: null, list: [] };
  const s = {
    config: { github: { reviewGate: { enabled: false }, pullRequest: { residuals: null } } },
    root: r.dir, repo: 'o/r', n: 7, head, base: 'b1', baseTip: 'b1', changes: [], scope: null,
    state: { ...emptyState(7, 'o/r'), index }, plan: { flows: [], stages: [stage] },
    resultFor: () => prior, sameFiles: () => true, verdictsFor: () => [], visual: null, manifest: null, isVisual: () => false, map: {}, info: {},
    boundFor: () => ({ base: 'b1', merges: [head], files: new Set(['src/own.js']), resolved: [] }),
    delta: () => [{ file: 'src/own.js', status: 'A', added: 1, removed: 0 }],
  };
  const input = passInput(s, pass, stage);
  assert.equal(input.context, 'delta');
  assert.deepEqual([...input.files].sort(), ['src/handed.js', 'src/own.js'], 'the reviewer can raise the handed finding again');
  assert.deepEqual(input.priorFindings.map((finding) => finding.id), ['R1-1']);
});

test('passInput: a scoped pass of a delta after a base merge lists the file of a blocking finding it holds outside its own files', (t) => {
  const r = repo(t);
  r.write('src/own.js', 'export const own = 1;\n');
  const head = r.commit('more');
  const pass = { id: 'slice:1', reviewer: 'codex-local', role: 'slice', slice: 1, files: ['src/own.js'] };
  const stage = { name: 'local', passes: [pass] };
  // The slice's own earlier result holds a blocking finding on a file outside its files, so the index keeps it there.
  const finding = { id: 'R1-1', title: 'outside the slice', file: 'src/handed.js', line: 1, severity: 'high', state: 'open' };
  const index = { 'R1-1': { ...finding, pass: 'slice:1', reviewer: 'codex-local', stage: 'local' } };
  const prior = { head: r.first, files: ['src/own.js'], list: [finding], open: 1 };
  const s = {
    config: { github: { reviewGate: { enabled: false }, pullRequest: { residuals: null } } },
    root: r.dir, repo: 'o/r', n: 7, head, base: 'b1', baseTip: 'b1', changes: [{ file: 'src/own.js', status: 'A', added: 1, removed: 0 }], scope: null,
    state: { ...emptyState(7, 'o/r'), index, passes: { 'slice:1': prior } }, plan: { flows: [], stages: [stage] },
    resultFor: () => prior, sameFiles: () => true, verdictsFor: () => [], visual: null, manifest: null, isVisual: () => false, map: {}, info: {},
    boundFor: () => ({ base: 'b1', merges: [head], files: new Set(['src/own.js']), resolved: [], rolledBack: [] }),
    delta: () => [{ file: 'src/own.js', status: 'A', added: 1, removed: 0 }],
  };
  const input = passInput(s, pass, stage);
  assert.equal(input.context, 'delta');
  assert.deepEqual([...input.files].sort(), ['src/handed.js', 'src/own.js'], 'the slice can raise its finding again, so it never closes as not reported');
  assert.deepEqual(input.priorFindings.map((finding) => finding.id), ['R1-1']);
  assert.match(reviewPrompt(input), /Review the diff of these files only: src\/own\.js, src\/handed\.js/u);
  // A pass with no file of its own left but the finding's still reads a delta, not the whole change.
  const bare = { ...pass, files: [] };
  const only = passInput({ ...s, plan: { flows: [], stages: [{ name: 'local', passes: [bare] }] } }, bare, { name: 'local', passes: [bare] });
  assert.deepEqual([only.context, only.files], ['delta', ['src/handed.js']]);
});

test('after fix_required, a flow\'s agent pass of a delta after a base merge is briefed on the pull request\'s own change', async (t) => {
  const r = await fixRequired(t, { baseConfig: { version: 1, review: { flows: { app: { files: ['src/**'] } } } } });
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const result = await r.step({ exec: recorder().exec });
  assert.equal(result.status, 'dispatch');
  const pass = result.dispatch.find((each) => each.flows.length);
  assert.ok(pass, JSON.stringify(result.dispatch.map((each) => each.pass)));
  assert.deepEqual([pass.base, pass.context, pass.files, pass.flowBase], [r.git('rev-parse', 'main'), 'delta', ['src/app.js'], r.git('rev-parse', 'main')]);
  assert.deepEqual(pass.baseMerged, { base: r.git('rev-parse', 'main'), from: r.first, merges: [result.head], rolledBack: [] });
  assert.ok(pass.brief.includes(baseMergedBrief(pass)), pass.brief);
  assert.ok(pass.brief.includes(flowBaseBrief(pass)), pass.brief);
  assert.match(pass.brief, /Find bugs in this pull request's own change in the listed files/u);
  assert.doesNotMatch(pass.brief, new RegExp(`${r.first}\\.\\.`, 'u'));
});

test('after fix_required, a merge from a base that changed how the project is reviewed reviews the whole change, not its own files alone', async (t) => {
  const r = await fixRequired(t);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  // A rule that changes no pass of this plan: only the review's rules moved, not what runs.
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n', '.aidrian/config.json': JSON.stringify({ version: 1, review: { rules: [{ when: { lines: { over: 100000 } }, depth: 'split' }] } }) });
  const seen = recorder();
  await r.step({ exec: seen.exec });
  const [input] = seen.inputs;
  assert.deepEqual([input.base, input.context, input.files, input.baseMerged], [r.git('rev-parse', 'main'), 'full', null, undefined], 'the earlier head was reviewed without main\'s new rule');
});

test('a merge with -s ours, which drops what main brought, is no clean merge, and its reviewer runs on the drop', async (t) => {
  const { r, merge } = await reviewedThenMerged(t, (r) => r.git('merge', '-q', '--no-edit', '-s', 'ours', 'main'));
  assert.equal(r.git('rev-parse', `${merge}^{tree}`), r.git('rev-parse', `${r.first}^{tree}`), 'the merge has the reviewed head\'s tree');
  assert.deepEqual(baseMergeOf(r.dir, merge, { priorHead: r.first, base: 'main' }).scope.changes, [{ file: 'src/lib.js', added: 0, removed: 1, status: 'D' }]);
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.equal(seen.inputs.length, 1, 'the reviewed head\'s pass does not carry: the merge changed src/lib.js');
  assert.deepEqual([result.status, seen.inputs[0].files, seen.inputs[0].remerge], ['received', ['src/lib.js'], merge]);
});

test('a modify/delete conflict kept as the modified side, and a binary conflict kept as ours, are changes of the merge', async (t) => {
  const r = repo(t, { baseFiles: { 'src/gone.js': 'export const gone = 1;\n', 'assets/logo.bin': '\u0000\u0001base' } });
  r.write('src/gone.js', 'export const gone = 2;\n');
  r.write('assets/logo.bin', '\u0000\u0002feat');
  const reviewed = r.commit('feat edits');
  r.git('switch', '-q', 'main');
  r.git('rm', '-q', 'src/gone.js');
  r.write('assets/logo.bin', '\u0000\u0003main');
  r.commit('on main');
  r.git('switch', '-q', 'feat');
  assert.throws(() => r.git('merge', '-q', '--no-edit', 'main'));
  r.git('checkout', '--ours', 'assets/logo.bin');
  r.git('add', 'src/gone.js', 'assets/logo.bin');
  const merge = r.commit('merge main');
  const result = baseMergeOf(r.dir, merge, { priorHead: reviewed, base: 'main' });
  assert.equal(result.clean, false);
  assert.deepEqual(result.scope.changes.map((change) => [change.file, change.added, change.removed, change.status]).sort(), [['assets/logo.bin', 0, 0, 'M'], ['src/gone.js', 0, 0, 'M']]);
});

test('a carried outcome answers no owed review: a gate review dispatched for the merge head still stops the merge', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  recordPending(r.project(), { pr: 7, repo: 'o/r', kind: 'review', head: merge, by: 'the Human' });
  const result = await r.step({ exec: recorder().exec });
  assert.deepEqual([result.status, result.carried_from], ['received', r.first]);
  assert.equal(readLocalState(r.project(), 7).pending[0].answered, undefined);
  assert.match(r.guard(merge) ?? '', /a review dispatched at .* has no result on record/u);
});

test('a resolved merge with a flow points the flow brief at the remerge diff, and an agent pass is briefed on it', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { flows: { app: { files: ['src/**'] } } } } });
  await r.step({ exec: recorder().exec });
  // The flow has no invariants doc, so the first step does not finish: the record says it did, as a reviewed head.
  writeLocalState(r.project(), noteOutcome(readLocalState(r.project(), 7), { status: 'received', head: r.first }));
  const merge = r.mergeMain(CONFLICT, RESOLVED);
  const result = await r.step({ exec: recorder().exec });
  assert.equal(result.status, 'dispatch');
  const [pass] = result.dispatch;
  assert.deepEqual([pass.remerge, pass.files], [merge, ['src/app.js']]);
  assert.match(pass.brief, new RegExp(`review only the changes the merge commit itself made, its conflict resolutions and any other edit, \`git show --remerge-diff ${merge}\``, 'u'));
  // A delta pass of the same merge: bugs in the remerge diff, invariants on the whole change.
  const prompt = reviewPrompt({ ...pass, base: r.first, flowBase: pass.base });
  assert.match(prompt, new RegExp(`Find bugs in \`git show --remerge-diff ${merge}\`, but judge every flow invariant on the whole change, \`git diff ${pass.base} ${merge}\``, 'u'));
  assert.doesNotMatch(prompt, new RegExp(`Find bugs in ${r.first}`, 'u'));
});

test('a merge git cannot read is reviewed as any head is, and the plan says why', async (t) => {
  const r = repo(t);
  await r.step({ exec: recorder().exec });
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  // A config git refuses for merges only: merge-tree and the remerge diff fail, the other reads work.
  r.git('config', 'merge.conflictStyle', 'bogus');
  const seen = recorder();
  const result = await r.step({ exec: seen.exec });
  assert.deepEqual([result.status, result.carried_from, seen.inputs.length, seen.inputs[0].remerge, seen.inputs[0].files], ['received', undefined, 1, undefined, null]);
  assert.ok(result.plan.reasons.some((reason) => /^the merge from main could not be read \(.*\): the whole change is reviewed$/u.test(reason)), result.plan.reasons.join('; '));
  assert.equal(readLocalState(r.project(), 7).outcome.head, merge);
});

test('a prior none_needed is not carried: the merge head plans its review again', async (t) => {
  const r = repo(t, { feature: { 'docs/guide.md': 'hello\n' } });
  assert.equal((await r.step({ exec: recorder().exec })).status, 'none_needed');
  const merge = r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const result = await r.step({ exec: recorder().exec });
  assert.deepEqual([result.status, result.head, result.carried_from], ['none_needed', merge, undefined]);
  assert.equal(Object.hasOwn(readLocalState(r.project(), 7).outcome, 'carried_from'), false);
});

test('a carried outcome reports the round cap the step reports, an extra round granted included', async (t) => {
  const r = repo(t);
  const first = await r.step({ exec: recorder().exec });
  // One extra round the Human approved at the cap, under the default github.extraRounds "ask".
  const state = readLocalState(r.project(), 7);
  state.extensions = [{ source: 'plan', round: first.max_rounds, head: r.first, status: 'granted', human: { answer: 'approve', by: 'the Human' } }];
  writeLocalState(r.project(), state);
  r.mergeMain({ 'src/lib.js': 'export const lib = 1;\n' });
  const carried = await r.step({ exec: recorder().exec });
  assert.deepEqual([carried.carried_from, carried.max_rounds], [r.first, first.max_rounds + 1]);
});

test('a directory rename split is a conflict with no conflicted file: the merge is not clean', async (t) => {
  const r = repo(t, { baseFiles: { 'dir/x': 'x\n', 'dir/y': 'y\n' } });
  // feat moves dir/ to two folders, so git cannot tell where main's new dir/new goes.
  r.git('rm', '-q', 'dir/x', 'dir/y');
  r.write('a/x', 'x\n');
  r.write('b/y', 'y\n');
  const split = r.commit('split');
  r.git('switch', '-q', 'main');
  r.write('dir/new', 'new\n');
  r.commit('main adds dir/new');
  r.git('switch', '-q', 'feat');
  assert.throws(() => r.git('merge', '-q', '--no-edit', 'main'), 'the merge stops on the split');
  const merge = r.commit('merge main as git left it');
  const result = baseMergeOf(r.dir, merge, { priorHead: split, base: 'main' });
  assert.equal(result.clean, false, 'git merge-tree exits 1 with no conflicted file');
  assert.deepEqual(result.scope.changes.map((change) => change.file), ['dir']);
});
