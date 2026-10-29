import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { listTags, loadKnowledge, routeKnowledge } from '../plugins/aidrian/lib/knowledge.mjs';

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
    // Names of inherited object properties are not tags.
    { tags: ['constructor', '__proto__', 'toString'], docs: ['docs/knowledge/engineering/working-agreement.md'] },
  ];
  for (const { tags, docs } of cases) assert.deepEqual(routeKnowledge(buckets, tags), docs, tags.join(','));
  assert.deepEqual(listTags(buckets).map(([tag]) => tag), ['code_style', 'docs', 'issue_tracker', 'orchestration', 'product_sensitive', 'testing']);
});

test('nested buckets pass when path.relative returns "\\" separators, as on Windows', (t) => {
  const relative = path.relative;
  t.mock.method(path, 'relative', (from, to) => relative(from, to).replaceAll('/', '\\'));
  assert.deepEqual(loadKnowledge(EXAMPLE).errors, []);
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

test('the command line fails on --project without a folder, an unknown option, and a stray argument', () => {
  const cases = [
    [['check', '--project'], /--project needs a folder/],
    [['check', '--project', ''], /--project needs a folder/],
    [['check', '--project', '--bogus'], /--project needs a folder/],
    [['check', '--projcet', EXAMPLE], /unknown option: --projcet/],
    [['check', 'stray'], /unexpected argument: stray/],
    [['tags', 'stray'], /unexpected argument: stray/],
  ];
  for (const [args, expected] of cases) {
    const { status, stdout, stderr } = spawnSync(CLI, args, { cwd: EXAMPLE, encoding: 'utf8' });
    assert.equal(status, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^usage: aidrian-knowledge/);
    assert.match(stderr, expected);
  }
});

// Each case writes a one-bucket project, changes one thing, and expects one error.
const bucketCases = [
  ['no config', (p) => rmSync(path.join(p, '.aidrian/config.json')), /\.aidrian\/config\.json: not found/],
  ['empty bucket list', (p) => writeConfig(p, { buckets: [] }), /non-empty list/],
  ['bucket outside the project', (p) => writeConfig(p, { buckets: ['../elsewhere'] }), /relative folder inside the project/],
  ['unknown config key', (p) => writeConfig(p, { buckets: ['kb'], extra: true }), /unknown key "extra"/],
  ['no bucket.json', (p) => rmSync(path.join(p, 'kb/bucket.json')), /kb\/bucket\.json: not found/],
  ['invalid JSON', (p) => writeFileSync(path.join(p, 'kb/bucket.json'), '{'), /invalid JSON/],
  ['bad id', (p) => bucket(p, { id: 'Bad Id' }), /"id" must be/],
  ['no description', (p) => bucket(p, { description: '' }), /"description" must/],
  ['unknown bucket key', (p) => bucket(p, { owner: 'x' }), /unknown key "owner"/],
  ['old "tags" map', (p) => bucket(p, { tags: { testing: ['sub/testing.md'] } }), /unknown key "tags"/],
  ['missing doc', (p) => bucket(p, docs({ 'nope.md': { summary: 'Nope.' } })), /kb\/nope\.md does not exist/],
  ['doc outside the bucket', (p) => bucket(p, docs({ '../outside.md': { summary: 'Out.' } })), /relative \.md path inside the bucket/],
  ['not markdown', (p) => bucket(p, { always: ['rules.md', 'bucket.json'] }), /"always": "bucket\.json" must be a relative \.md path inside the bucket/],
  ['always doc listed twice', (p) => bucket(p, { always: ['rules.md', 'rules.md'] }), /"always": kb\/rules\.md is listed twice/],
  ['doc listed twice under two spellings', (p) => bucket(p, docs({ './rules.md': { summary: 'Again.' } })), /"docs": kb\/rules\.md is listed twice/],
  ['doc entry not an object', (p) => bucket(p, docs({ 'rules.md': 'The rules.' })), /"docs": kb\/rules\.md must be an object with "summary" and "tags"/],
  ['unknown doc entry key', (p) => bucket(p, docs({ 'rules.md': { summary: 'The rules.', owner: 'x' } })), /"docs": kb\/rules\.md: unknown key "owner"/],
  ['no summary', (p) => bucket(p, docs({ 'rules.md': { tags: [] } })), /kb\/rules\.md needs a one-line "summary"/],
  ['empty summary', (p) => bucket(p, docs({ 'rules.md': { summary: ' ' } })), /kb\/rules\.md needs a one-line "summary"/],
  ['summary on two lines', (p) => bucket(p, docs({ 'rules.md': { summary: 'The\nrules.' } })), /kb\/rules\.md needs a one-line "summary"/],
  ['summary with a tab', (p) => bucket(p, docs({ 'rules.md': { summary: 'The\trules.' } })), /kb\/rules\.md needs a one-line "summary"/],
  ['summary over 160 characters', (p) => bucket(p, docs({ 'rules.md': { summary: 'x'.repeat(161) } })), /"summary" is 161 characters; keep it to 160/],
  ['tags not a list', (p) => bucket(p, docs({ 'rules.md': { summary: 'The rules.', tags: 'testing' } })), /kb\/rules\.md: "tags" must be a list of tags/],
  ['bad tag name', (p) => bucket(p, docs({ 'rules.md': { summary: 'The rules.', tags: ['Not-Snake'] } })), /tag "Not-Snake" must be snake_case/],
  ['"always" as a tag', (p) => bucket(p, docs({ 'rules.md': { summary: 'The rules.', tags: ['always'] } })), /tag "always" must be snake_case and not "always"/],
  ['always doc with no entry in "docs"', (p) => { writeFileSync(path.join(p, 'kb/README.md'), '# About\n'); bucket(p, { always: ['rules.md', 'README.md'] }); }, /"always": kb\/README\.md has no entry in "docs"/],
  ['doc with no entry', (p) => writeFileSync(path.join(p, 'kb/sub/orphan.md'), '# Orphan\n'), /^kb\/sub\/orphan\.md: has no entry in kb\/bucket\.json; add it to "docs" with a summary, or delete it$/],
  // ROOT is this repository, outside the temporary project.
  ['bucket folder links outside', (p) => { symlinkSync(ROOT, path.join(p, 'ext')); writeConfig(p, { buckets: ['kb', 'ext'] }); }, /bucket "ext" must be a relative folder inside the project/],
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

test('a bucket without a "docs" map fails, and so does every doc it then leaves out', (t) => {
  for (const value of [undefined, [], {}]) {
    const project = validProject(t);
    bucket(project, { docs: value, always: [] });
    const missing = Array.isArray(value) || value === undefined ? 'kb/bucket.json: "docs" must map each doc to its summary and tags' : 'kb/bucket.json: "docs" lists no docs';
    assert.deepEqual(loadKnowledge(project).errors, [
      missing,
      'kb/rules.md: has no entry in kb/bucket.json; add it to "docs" with a summary, or delete it',
      'kb/sub/testing.md: has no entry in kb/bucket.json; add it to "docs" with a summary, or delete it',
    ]);
  }
});

test('a doc may have no tags, and its tags are read in "docs" order', (t) => {
  const project = validProject(t);
  writeFileSync(path.join(project, 'kb/sub/more.md'), '# More\n');
  bucket(project, docs({ 'sub/more.md': { summary: 'More testing.', tags: ['testing', 'testing'] }, 'rules.md': { summary: 'The rules.' } }));
  const { buckets, errors } = loadKnowledge(project);
  assert.deepEqual(errors, []);
  assert.deepEqual(buckets[0].docs.map((doc) => [doc.path, doc.tags]), [['kb/rules.md', []], ['kb/sub/testing.md', ['testing']], ['kb/sub/more.md', ['testing']]]);
  assert.deepEqual(routeKnowledge(buckets, ['testing']), ['kb/rules.md', 'kb/sub/testing.md', 'kb/sub/more.md']);
});

test('a duplicate bucket id fails, and a README in the bucket root needs no entry', (t) => {
  const project = validProject(t);
  writeFileSync(path.join(project, 'kb/README.md'), '# About this bucket\n');
  mkdirSync(path.join(project, 'kb2'));
  writeFileSync(path.join(project, 'kb2/a.md'), '# A\n');
  writeFileSync(path.join(project, 'kb2/bucket.json'), JSON.stringify({ id: 'kb', description: 'Copy.', always: ['a.md'], docs: { 'a.md': { summary: 'A.' } } }));
  writeConfig(project, { buckets: ['kb', 'kb2'] });
  const { errors } = loadKnowledge(project);
  assert.deepEqual(errors, ['kb2/bucket.json: id "kb" is used by another bucket']);
});

test('a doc that links outside its bucket fails, and a link that stays inside passes', (t) => {
  const project = validProject(t);
  symlinkSync(path.join(ROOT, 'README.md'), path.join(project, 'kb/outside.md'));
  // Stays inside the project but leaves the bucket.
  symlinkSync('../outside.md', path.join(project, 'kb/injected.md'));
  symlinkSync(path.join(project, 'kb/rules.md'), path.join(project, 'kb/sub/rules-link.md'));
  bucket(project, docs({ 'outside.md': { summary: 'Out.' }, 'injected.md': { summary: 'In.' }, 'sub/rules-link.md': { summary: 'Link.' } }));
  assert.deepEqual(loadKnowledge(project).errors, [
    'kb/bucket.json: "docs": "outside.md" must be a relative .md path inside the bucket',
    'kb/bucket.json: "docs": "injected.md" must be a relative .md path inside the bucket',
    'kb/injected.md: has no entry in kb/bucket.json; add it to "docs" with a summary, or delete it',
    'kb/outside.md: has no entry in kb/bucket.json; add it to "docs" with a summary, or delete it',
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
  writeConfig(project, { buckets: ['kb'] });
  bucket(project, {});
  return project;
}

function writeConfig(project, value) {
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify(value));
}

const BASE_DOCS = { 'rules.md': { summary: 'The rules.', tags: [] }, 'sub/testing.md': { summary: 'How to test.', tags: ['testing'] } };

// The base docs with `changes` applied: a changed entry keeps its place, a new one goes last.
function docs(changes) {
  return { docs: { ...BASE_DOCS, ...changes } };
}

function bucket(project, overrides) {
  const value = { id: 'kb', description: 'Test rules.', always: ['rules.md'], docs: BASE_DOCS, ...overrides };
  writeFileSync(path.join(project, 'kb/bucket.json'), JSON.stringify(value));
}
