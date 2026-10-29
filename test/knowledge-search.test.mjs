import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadKnowledge, searchKnowledge } from '../plugins/aidrian/lib/knowledge.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge');

const run = (args, cwd = EXAMPLE) => spawnSync(CLI, args, { cwd, encoding: 'utf8' });
const paths = (stdout) => stdout.trim().split('\n').map((line) => line.split('\t')[0]);

test('search ranks tag hits above path and summary hits, and keeps bucket order on a tie', () => {
  const { buckets } = loadKnowledge(EXAMPLE);
  // "product": tag (2) on both product docs, plus path (1) on both, plus summary (1) on branches-and-reviews.
  const hits = searchKnowledge(buckets, ['product']);
  assert.deepEqual(hits.map((hit) => [hit.path, hit.score]), [
    ['docs/knowledge/product/product-rules.md', 3],
    ['docs/knowledge/product/sharing.md', 3],
    ['docs/knowledge/engineering/branches-and-reviews.md', 1],
  ]);
  // Words are lowercased, and a quoted phrase counts word by word.
  assert.deepEqual(searchKnowledge(buckets, ['SHARING rules']).map((hit) => [hit.path, hit.score]), [
    ['docs/knowledge/product/sharing.md', 3],
    ['docs/knowledge/engineering/working-agreement.md', 1],
    ['docs/knowledge/product/product-rules.md', 1],
  ]);
});

test('search prints path and summary for the best 8, --all prints every hit, and no hit exits 1', () => {
  const top = run(['search', 'docs']);
  assert.equal(top.status, 0);
  assert.equal(top.stdout.trim().split('\n').length, 8);
  assert.equal(
    top.stdout.split('\n')[0],
    'docs/knowledge/engineering/docs-ownership.md\tWho owns each docs folder, and when docs change with the code.',
  );

  const limited = searchKnowledge(loadKnowledge(EXAMPLE).buckets, ['e'], 3);
  assert.equal(limited.length, 3);
  assert.equal(paths(run(['search', 'e', '--all']).stdout).length, 8);

  const none = run(['search', 'zebra']);
  assert.deepEqual([none.status, none.stdout, none.stderr], [1, '', 'no match\n']);
});

test('search needs a word, and --all belongs to search only', () => {
  const cases = [
    [['search'], /search needs at least one word/],
    [['route', 'testing', '--all'], /unknown option: --all/],
  ];
  for (const [args, expected] of cases) {
    const { status, stderr } = run(args);
    assert.equal(status, 1, args.join(' '));
    assert.match(stderr, expected);
  }
});

test('index prints every doc as path, comma-separated tags, and summary', () => {
  const { status, stdout } = run(['index']);
  assert.equal(status, 0);
  const rows = stdout.trim().split('\n').map((line) => line.split('\t'));
  assert.equal(rows.length, 8);
  assert.ok(rows.every((row) => row.length === 3));
  assert.deepEqual(rows[0], [
    'docs/knowledge/engineering/working-agreement.md',
    '',
    'Rules for every agent and session: read before changing, keep changes small, ship tests and docs with behavior, no secrets.',
  ]);
  assert.deepEqual(rows[2].slice(0, 2), ['docs/knowledge/engineering/testing.md', 'testing']);
});

test('init drafts a bucket and a config for a project with neither, and the result passes check', (t) => {
  const project = tempProject(t);
  const { status, stdout } = run(['init', 'docs/'], project);
  assert.equal(status, 0);
  assert.equal(
    stdout,
    'wrote docs/bucket.json: 4 docs, each with a drafted summary and no tags\n' +
      'wrote .aidrian/config.json: buckets ["docs"]\n' +
      'next: correct the summaries, add tags and "always" docs, then run aidrian-knowledge check\n',
  );
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, '.aidrian/config.json'), 'utf8')), { buckets: ['docs'] });
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, 'docs/bucket.json'), 'utf8')), {
    id: 'docs',
    description: 'Docs in docs.',
    always: [],
    docs: {
      'README.md': { summary: 'Getting started: Install the app with `npm ci`.', tags: [] },
      'guides/deploys.md': { summary: 'Deploys: Every deploy goes through CI.', tags: [] },
      // Cut to 160 characters, the last one an ellipsis.
      'guides/long.md': { summary: `${'word '.repeat(31)}word…`, tags: [] },
      'guides/untitled.md': { summary: 'untitled', tags: [] },
    },
  });
  assert.equal(run(['check'], project).stdout, 'ok: 1 buckets, 4 docs\n');
});

test('init keeps an existing config, says when it does not list the bucket, and never overwrites a bucket.json', (t) => {
  const project = tempProject(t);
  mkdirSync(path.join(project, '.aidrian'));
  writeFileSync(path.join(project, '.aidrian/config.json'), '{"buckets": ["other"]}\n');
  const first = run(['init', 'docs'], path.join(project, 'docs/guides'));
  assert.equal(first.status, 0);
  assert.match(first.stdout, /\nadd "docs" to "buckets" in \.aidrian\/config\.json\n/);
  assert.equal(readFileSync(path.join(project, '.aidrian/config.json'), 'utf8'), '{"buckets": ["other"]}\n');

  const again = run(['init', 'docs'], project);
  assert.deepEqual([again.status, again.stderr], [1, 'docs/bucket.json already exists; edit it instead\n']);
});

test('init refuses a folder outside the project, a missing folder, a folder with no docs, and a wrong argument count', (t) => {
  const project = tempProject(t);
  mkdirSync(path.join(project, 'empty'));
  const cases = [
    [['init', '../elsewhere'], /^\.\.\/elsewhere: must be a folder inside the project\n$/],
    [['init', 'nope'], /^nope: must be a folder inside the project\n$/],
    [['init', 'empty'], /^empty: has no \.md files\n$/],
    [['init'], /init needs one folder/],
    [['init', 'docs', 'more'], /init needs one folder/],
  ];
  for (const [args, expected] of cases) {
    const { status, stderr } = run(args, project);
    assert.equal(status, 1, args.join(' '));
    assert.match(stderr, expected);
  }
});

// A project with a docs folder and no aidrian files.
function tempProject(t) {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, 'docs/guides'), { recursive: true });
  writeFileSync(path.join(project, 'docs/README.md'), '---\ntitle: Start\n---\n# Getting started\n\nInstall the app with `npm ci`. Then run it.\n');
  writeFileSync(path.join(project, 'docs/guides/deploys.md'), '# Deploys\n\n```sh\nmake deploy\n```\n\n- Every deploy goes through CI. Never by hand.\n');
  writeFileSync(path.join(project, 'docs/guides/long.md'), 'word '.repeat(60));
  writeFileSync(path.join(project, 'docs/guides/untitled.md'), '\n');
  return project;
}
