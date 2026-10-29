import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadKnowledge as loadKnowledgeOf, searchKnowledge } from '../plugins/aidrian/lib/knowledge.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge');

const AIDRIAN = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

const run = (args, cwd = EXAMPLE) => spawnSync(CLI, args, { cwd, encoding: 'utf8' });
const loadKnowledge = (dir) => loadKnowledgeOf(findProject(dir));
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

test('init drafts an index for a folder of docs in the project folder, and the result passes check', (t) => {
  const project = tempProject(t);
  const { status, stdout } = run(['init', 'docs/'], path.join(project, 'docs/guides'));
  assert.equal(status, 0);
  assert.equal(
    stdout,
    'wrote .aidrian/knowledge/docs.json: 4 docs in docs, each with a drafted summary and no tags\n' +
      'next: correct the summaries, add tags and "always" docs, then run aidrian check\n',
  );
  assert.deepEqual(JSON.parse(readFileSync(path.join(project, '.aidrian/knowledge/docs.json'), 'utf8')), {
    dir: 'docs',
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
  const check = spawnSync(AIDRIAN, ['check'], { cwd: project, encoding: 'utf8' });
  assert.deepEqual([check.status, check.stdout.split('\n')[0], check.stderr], [0, 'ok: .aidrian (1 buckets, 4 docs)', '']);
});

test('init names the index after the folder, and never overwrites one', (t) => {
  const project = tempProject(t);
  assert.equal(run(['init', 'docs/guides'], project).status, 0);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path.join(project, '.aidrian/knowledge/guides.json'), 'utf8')).docs), [
    'deploys.md',
    'long.md',
    'untitled.md',
  ]);
  const again = run(['init', 'other/guides'], project);
  assert.deepEqual([again.status, again.stderr], [1, '.aidrian/knowledge/guides.json already exists; edit it instead\n']);
});

test('init writes no index through a knowledge folder that links outside the project', (t) => {
  const project = tempProject(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  rmSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  symlinkSync(outside, path.join(project, '.aidrian/knowledge'));
  const { status, stderr } = run(['init', 'docs'], project);
  assert.deepEqual([status, stderr], [1, '.aidrian/knowledge/docs.json: links outside the project; nothing was written\n']);
  assert.deepEqual(readdirSync(outside), []);
});

test('init never reads a doc that links outside the folder: it leaves the doc out and names it', (t) => {
  const project = tempProject(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'secret.md'), '# Secret\n\nThe token is hunter2.\n');
  symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'docs/guides/secret.md'));
  // Inside the project, but outside the folder: still not the bucket's to read.
  symlinkSync('../../other/guides/more.md', path.join(project, 'docs/guides/more.md'));
  symlinkSync('missing.md', path.join(project, 'docs/guides/broken.md'));
  symlinkSync('deploys.md', path.join(project, 'docs/guides/deploys-link.md'));
  const { status, stdout, stderr } = run(['init', 'docs/guides'], project);
  assert.equal(status, 0);
  assert.equal(stderr, [
    'docs/guides/broken.md: links outside docs/guides; left out',
    'docs/guides/more.md: links outside docs/guides; left out',
    'docs/guides/secret.md: links outside docs/guides; left out',
    '',
  ].join('\n'));
  assert.match(stdout, /^wrote \.aidrian\/knowledge\/guides\.json: 4 docs in docs\/guides,/);
  const index = readFileSync(path.join(project, '.aidrian/knowledge/guides.json'), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(index).docs), ['deploys-link.md', 'deploys.md', 'long.md', 'untitled.md'], 'a link inside the folder stays');
  assert.doesNotMatch(index, /hunter2|Secret|More/);

  mkdirSync(path.join(project, 'linked'));
  symlinkSync(path.join(outside, 'secret.md'), path.join(project, 'linked/secret.md'));
  const none = run(['init', 'linked'], project);
  assert.deepEqual([none.status, none.stderr], [1, 'linked/secret.md: links outside linked; left out\nlinked: has no .md files\n']);
  assert.deepEqual(readdirSync(path.join(project, '.aidrian/knowledge')), ['guides.json']);
});

test('init needs a project, and refuses a folder outside it, a missing folder, a folder with no docs, and a wrong argument count', (t) => {
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
  rmSync(path.join(project, '.aidrian'), { recursive: true });
  const none = run(['init', 'docs'], project);
  assert.deepEqual([none.status, none.stderr], [1, `no project folder at or above ${project}; run aidrian init\n`]);
});

test('a doc from a local source prints its absolute path and, last, its source; check counts each source', (t) => {
  const project = tempProject(t);
  assert.equal(run(['init', 'docs'], project).status, 0);
  const source = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-source-')));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(path.join(source, 'knowledge'));
  mkdirSync(path.join(source, 'notes'));
  writeFileSync(path.join(source, 'notes/deploy-habits.md'), '# Deploy habits\n');
  const docs = { 'deploy-habits.md': { summary: 'How I check a deploy.', tags: ['testing'] } };
  writeFileSync(path.join(source, 'knowledge/personal.json'), JSON.stringify({ dir: 'notes', description: 'Mine.', always: [], docs }));
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ sources: [source] }));
  const habits = path.join(source, 'notes/deploy-habits.md');

  assert.equal(run(['route', 'testing'], project).stdout, `${habits}\t${source}\n`);
  assert.equal(run(['search', 'deploy'], project).stdout, `docs/guides/deploys.md\tDeploys: Every deploy goes through CI.\n${habits}\tHow I check a deploy.\t${source}\n`);
  assert.equal(run(['index'], project).stdout.trim().split('\n').at(-1), `${habits}\ttesting\tHow I check a deploy.\t${source}`);
  const check = spawnSync(AIDRIAN, ['check'], { cwd: project, encoding: 'utf8' });
  assert.deepEqual([check.status, check.stdout.split('\n')[0]], [0, `ok: .aidrian (1 buckets, 4 docs), ${source} (1 buckets, 1 docs)`]);

  renameSync(path.join(source, 'knowledge/personal.json'), path.join(source, 'knowledge/docs.json'));
  const clash = spawnSync(AIDRIAN, ['check'], { cwd: project, encoding: 'utf8' });
  assert.deepEqual([clash.status, clash.stderr], [1, `${source}/knowledge/docs.json: bucket "docs" is already defined by .aidrian/knowledge/docs.json\n`]);
  assert.equal(run(['route', 'testing'], project).status, 1);
});

// A project with a docs folder, an empty project folder, and the .gitignore lines `aidrian init` writes.
function tempProject(t) {
  const project = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  assert.equal(spawnSync(AIDRIAN, ['init'], { cwd: project }).status, 0);
  mkdirSync(path.join(project, 'docs/guides'), { recursive: true });
  mkdirSync(path.join(project, 'other/guides'), { recursive: true });
  writeFileSync(path.join(project, 'docs/README.md'), '---\ntitle: Start\n---\n# Getting started\n\nInstall the app with `npm ci`. Then run it.\n');
  writeFileSync(path.join(project, 'docs/guides/deploys.md'), '# Deploys\n\n```sh\nmake deploy\n```\n\n- Every deploy goes through CI. Never by hand.\n');
  writeFileSync(path.join(project, 'docs/guides/long.md'), 'word '.repeat(60));
  writeFileSync(path.join(project, 'docs/guides/untitled.md'), '\n');
  writeFileSync(path.join(project, 'other/guides/more.md'), '# More\n');
  return project;
}
