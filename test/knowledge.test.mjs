import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findProjectRoot, listTags, loadKnowledge, routeKnowledge } from '../plugins/aidrian/lib/knowledge.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge');

test('the example consumer passes the check', () => {
  const { buckets, errors } = loadKnowledge(EXAMPLE);
  assert.deepEqual(errors, []);
  assert.deepEqual(buckets.map((bucket) => bucket.id), ['engineering', 'product']);
});

test('routing returns "always" docs first, then tagged docs, in bucket order and without repeats', () => {
  const { buckets } = loadKnowledge(EXAMPLE);
  const cases = [
    { tags: [], docs: ['docs/knowledge/engineering/working-agreement.md'] },
    {
      tags: ['testing', 'product_sensitive'],
      docs: [
        'docs/knowledge/engineering/working-agreement.md',
        'docs/knowledge/engineering/testing.md',
        'docs/knowledge/product/product-rules.md',
        'docs/knowledge/product/sharing.md',
      ],
    },
    { tags: ['testing', 'testing', 'not_a_tag'], docs: ['docs/knowledge/engineering/working-agreement.md', 'docs/knowledge/engineering/testing.md'] },
  ];
  for (const { tags, docs } of cases) assert.deepEqual(routeKnowledge(buckets, tags), docs, tags.join(','));
  assert.deepEqual(listTags(buckets).map(([tag]) => tag), ['code_style', 'docs', 'issue_tracker', 'orchestration', 'product_sensitive', 'testing']);
});

test('the project root is found from a subfolder', () => {
  assert.equal(findProjectRoot(path.join(EXAMPLE, 'src')), EXAMPLE);
});

test('the command line checks and routes', () => {
  const run = (...args) => execFileSync(CLI, args, { cwd: path.join(EXAMPLE, 'src'), encoding: 'utf8' });
  assert.equal(run('check'), 'ok: 2 buckets, 8 docs\n');
  assert.equal(run('route', 'orchestration'), 'docs/knowledge/engineering/working-agreement.md\ndocs/knowledge/engineering/branches-and-reviews.md\n');
  // `e2e` is a plugin tag this project does not define: only the "always" docs.
  assert.equal(run('route', 'e2e'), 'docs/knowledge/engineering/working-agreement.md\n');
});

test('the command line rejects a tag neither the plugin nor the project defines, and lists the known ones', () => {
  const { status, stdout, stderr } = spawnSync(CLI, ['route', 'testing', 'testng'], { cwd: EXAMPLE, encoding: 'utf8' });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^unknown tag: testng\nknown tags: code_style, design_bundle, docs, e2e, .*\btesting\b/);
});

// Each case writes a one-bucket project, changes one thing, and expects one error.
const bucketCases = [
  ['no manifest', (p) => rmSync(path.join(p, '.aidrian/knowledge.json')), /\.aidrian\/knowledge\.json: not found/],
  ['empty bucket list', (p) => manifest(p, { buckets: [] }), /non-empty list/],
  ['bucket outside the project', (p) => manifest(p, { buckets: ['../elsewhere'] }), /relative folder inside the project/],
  ['unknown manifest key', (p) => manifest(p, { buckets: ['kb'], extra: true }), /unknown key "extra"/],
  ['no bucket.json', (p) => rmSync(path.join(p, 'kb/bucket.json')), /kb\/bucket\.json: not found/],
  ['invalid JSON', (p) => writeFileSync(path.join(p, 'kb/bucket.json'), '{'), /invalid JSON/],
  ['bad id', (p) => bucket(p, { id: 'Bad Id' }), /"id" must be/],
  ['no description', (p) => bucket(p, { description: '' }), /"description" must/],
  ['unknown bucket key', (p) => bucket(p, { owner: 'x' }), /unknown key "owner"/],
  ['missing doc', (p) => bucket(p, { tags: { testing: ['sub/testing.md', 'nope.md'] } }), /kb\/nope\.md does not exist/],
  ['doc outside the bucket', (p) => bucket(p, { tags: { testing: ['sub/testing.md', '../outside.md'] } }), /relative \.md path inside the bucket/],
  ['not markdown', (p) => bucket(p, { always: ['rules.md', 'bucket.json'] }), /relative \.md path inside the bucket/],
  ['doc listed twice', (p) => bucket(p, { always: ['rules.md', 'rules.md'] }), /listed twice/],
  ['bad tag name', (p) => bucket(p, { tags: { testing: ['sub/testing.md'], 'Not-Snake': ['rules.md'] } }), /tag "Not-Snake" must be snake_case/],
  ['"always" as a tag', (p) => bucket(p, { tags: { testing: ['sub/testing.md'], always: ['rules.md'] } }), /tag "always" must be snake_case and not "always"/],
  ['empty tag', (p) => bucket(p, { tags: { testing: ['sub/testing.md'], e2e: [] } }), /tag "e2e" lists no docs/],
  ['doc no tag loads', (p) => writeFileSync(path.join(p, 'kb/sub/orphan.md'), '# Orphan\n'), /kb\/sub\/orphan\.md: no tag loads this doc/],
  // ROOT is this repository, outside the temporary project.
  ['bucket folder links outside', (p) => { symlinkSync(ROOT, path.join(p, 'ext')); manifest(p, { buckets: ['kb', 'ext'] }); }, /bucket "ext" must be a relative folder inside the project/],
  ['doc in a folder that links outside', (p) => { symlinkSync(ROOT, path.join(p, 'kb/ext')); bucket(p, { always: ['rules.md', 'ext/README.md'] }); }, /"ext\/README\.md" must be a relative \.md path inside the bucket/],
  ['bucket.json links outside', (p) => { rmSync(path.join(p, 'kb/bucket.json')); symlinkSync(path.join(ROOT, 'package.json'), path.join(p, 'kb/bucket.json')); }, /kb\/bucket\.json: links outside the project/],
];

for (const [name, change, expected] of bucketCases) {
  test(`check fails: ${name}`, (t) => {
    const project = validProject(t);
    assert.deepEqual(loadKnowledge(project).errors, [], 'the base project is valid');
    change(project);
    const { errors } = loadKnowledge(project);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], expected);
  });
}

test('a duplicate bucket id fails, and a README in the bucket root needs no tag', (t) => {
  const project = validProject(t);
  writeFileSync(path.join(project, 'kb/README.md'), '# About this bucket\n');
  mkdirSync(path.join(project, 'kb2'));
  writeFileSync(path.join(project, 'kb2/a.md'), '# A\n');
  writeFileSync(path.join(project, 'kb2/bucket.json'), JSON.stringify({ id: 'kb', description: 'Copy.', always: ['a.md'] }));
  manifest(project, { buckets: ['kb', 'kb2'] });
  const { errors } = loadKnowledge(project);
  assert.deepEqual(errors, ['kb2/bucket.json: id "kb" is used by another bucket']);
});

test('a doc that links outside the project fails, and a link that stays inside passes', (t) => {
  const project = validProject(t);
  symlinkSync(path.join(ROOT, 'README.md'), path.join(project, 'kb/outside.md'));
  symlinkSync(path.join(project, 'kb/rules.md'), path.join(project, 'kb/sub/rules-link.md'));
  bucket(project, { always: ['rules.md', 'outside.md'], tags: { testing: ['sub/testing.md', 'sub/rules-link.md'] } });
  assert.deepEqual(loadKnowledge(project).errors, [
    'kb/bucket.json: "always": "outside.md" must be a relative .md path inside the bucket',
    'kb/outside.md: no tag loads this doc; add it to "always" or a tag in kb/bucket.json, or delete it',
  ]);
});

function validProject(t) {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-knowledge-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian'));
  mkdirSync(path.join(project, 'kb/sub'), { recursive: true });
  writeFileSync(path.join(project, 'outside.md'), '# Outside\n');
  writeFileSync(path.join(project, 'kb/rules.md'), '# Rules\n');
  writeFileSync(path.join(project, 'kb/sub/testing.md'), '# Testing\n');
  manifest(project, { buckets: ['kb'] });
  bucket(project, {});
  return project;
}

function manifest(project, value) {
  writeFileSync(path.join(project, '.aidrian/knowledge.json'), JSON.stringify(value));
}

function bucket(project, overrides) {
  const value = { id: 'kb', description: 'Test rules.', always: ['rules.md'], tags: { testing: ['sub/testing.md'] }, ...overrides };
  writeFileSync(path.join(project, 'kb/bucket.json'), JSON.stringify(value));
}
