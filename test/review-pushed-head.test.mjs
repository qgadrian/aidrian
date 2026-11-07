import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';

// A pull request on branch `feat`, pushed to a bare `origin`, whose forge reports `reported.head`: a test moves it to
// play a forge that has, or has not yet, seen a push.
function pushedRepo(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pushed-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'work');
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  const commit = (msg) => (git('add', '-A'), git('commit', '-q', '-m', msg), git('rev-parse', 'HEAD'));
  spawnSync('git', ['init', '-q', '--bare', path.join(root, 'origin.git')]);
  mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  write('.aidrian/config.json', JSON.stringify({ version: 1 }));
  write('src/app.js', 'export const app = 1;\n');
  commit('base');
  git('push', '-q', 'origin', 'main');
  git('switch', '-q', '-c', 'feat');
  write('src/app.js', 'export const app = 2;\n');
  const reported = { head: commit('change') };
  git('push', '-q', '-u', 'origin', 'feat');
  const forge = {
    change: () => ({ number: 7, headRefOid: reported.head, headRefName: 'feat', baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    conversationComments: () => [],
    postComment: () => {},
    editComment: () => {},
  };
  const step = (exec) => {
    const project = projectAt(dir);
    return reviewStep({ pr: '7' }, { project, config: { ...loadConfig(project).config, review: { ...loadConfig(project).config.review, record: 'local' } }, forge, codex: () => ({ ok: true }), exec });
  };
  return { git, write, commit, reported, step };
}

const finding = { file: 'src/app.js', line: 1, title: 'off by one', body: 'x', severity: 'high' };

test('the first review step after a push reviews the pushed head while the forge still reports the old one', async (t) => {
  const r = pushedRepo(t);
  const seen = [];
  const exec = async (_reviewer, input) => (seen.push([input.head, input.context]), seen.length === 1 ? { status: 'done', findings: [finding], verdicts: [], dropped: [] } : { status: 'done', findings: [], verdicts: [], dropped: [] });
  const first = await r.step(exec);
  assert.deepEqual([first.status, first.round, first.head], ['fix_required', 1, r.reported.head]);

  r.write('src/app.js', 'export const app = 3;\n');
  const fixed = r.commit('fix');
  r.git('push', '-q');
  // The forge has not seen the push yet: it still reports the head of round 1.
  const second = await r.step(exec);
  assert.deepEqual([second.status, second.round, second.head], ['received', 2, fixed], 'a new round on the pushed head, not round 1 re-served');
  assert.deepEqual(seen.at(-1), [fixed, 'delta']);
});

test('a local commit past the pull request\'s head is named, not answered with the older round', async (t) => {
  const r = pushedRepo(t);
  let ran = 0;
  const exec = async () => (ran += 1, { status: 'done', findings: [finding], verdicts: [], dropped: [] });
  assert.equal((await r.step(exec)).status, 'fix_required');
  r.write('src/app.js', 'export const app = 3;\n');
  const local = r.commit('fix, not pushed');
  const result = await r.step(exec);
  assert.deepEqual([result.status, result.head, result.local_head, result.retry_recommended], ['incomplete', r.reported.head, local, true]);
  assert.match(result.reason, /push, then run the step again/u);
  assert.equal(ran, 1, 'nothing ran on the older head');
});

test('a checkout on another branch, stacked on the pull request, reviews the head the forge reports', async (t) => {
  const r = pushedRepo(t);
  r.git('switch', '-q', '-c', 'stacked');
  r.write('src/other.js', 'export const other = 1;\n');
  r.commit('stacked work');
  // codex-local reads the checkout, so this step stops on the checkout, with the reported head named: never `stacked`.
  const result = await r.step(async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] }));
  assert.equal(result.head, r.reported.head);
  assert.equal(result.local_head, undefined);
});
