import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initBucket, listTags, loadKnowledge as loadKnowledgeOf, routeKnowledge } from '../plugins/aidrian/lib/knowledge.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian-knowledge');
const REPOSITORY = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/plugin.json'), 'utf8')).repository;

const loadKnowledge = (dir) => loadKnowledgeOf(findProject(dir));

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
    { tags: ['backend'], docs: ['docs/knowledge/engineering/working-agreement.md', 'docs/knowledge/engineering/code-style.md'] },
    { tags: ['review'], docs: ['docs/knowledge/engineering/working-agreement.md', 'docs/knowledge/engineering/branches-and-reviews.md'] },
    // Names of inherited object properties are not tags.
    { tags: ['constructor', '__proto__', 'toString'], docs: ['docs/knowledge/engineering/working-agreement.md'] },
  ];
  for (const { tags, docs } of cases) assert.deepEqual(routeKnowledge(buckets, tags), docs, tags.join(','));
  assert.deepEqual(listTags(buckets).map(([tag]) => tag), ['backend', 'code_style', 'docs', 'issue_tracker', 'orchestration', 'product_sensitive', 'review', 'testing']);
});

test('nested buckets pass when path.relative returns "\\" separators, as on Windows', (t) => {
  const relative = path.relative;
  t.mock.method(path, 'relative', (from, to) => relative(from, to).replaceAll('/', '\\'));
  assert.deepEqual(loadKnowledge(EXAMPLE).errors, []);
});

test('the command line routes from a subfolder of the project', () => {
  const run = (...args) => execFileSync(CLI, args, { cwd: path.join(EXAMPLE, 'src'), encoding: 'utf8' });
  assert.equal(run('route', 'orchestration'), 'docs/knowledge/engineering/working-agreement.md\ndocs/knowledge/engineering/branches-and-reviews.md\n');
  // `e2e` is a plugin tag this project does not define: only the "always" docs.
  assert.equal(run('route', 'e2e'), 'docs/knowledge/engineering/working-agreement.md\n');
});

test('the command line rejects a tag neither the plugin nor the project defines, and lists the known ones', () => {
  const { status, stdout, stderr } = spawnSync(CLI, ['route', 'testing', 'testng'], { cwd: EXAMPLE, encoding: 'utf8' });
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /^unknown tag: testng\nknown tags: (?:.*, )?code_style, design_bundle, docs, e2e, .*\btesting\b/);
});

test('the command line fails on --project without a folder, an unknown option, and a stray argument', () => {
  const cases = [
    [['tags', '--project'], /--project needs a folder/],
    [['tags', '--project', ''], /--project needs a folder/],
    [['tags', '--project', '--bogus'], /--project needs a folder/],
    [['tags', '--projcet', EXAMPLE], /unknown option: --projcet/],
    [['tags', 'stray'], /unexpected argument: stray/],
    [['index', 'stray'], /unexpected argument: stray/],
    [['check'], /^usage: /],
  ];
  for (const [args, expected] of cases) {
    const { status, stdout, stderr } = spawnSync(CLI, args, { cwd: EXAMPLE, encoding: 'utf8' });
    assert.equal(status, 1, args.join(' '));
    assert.equal(stdout, '');
    assert.match(stderr, /^usage: aidrian-knowledge/);
    assert.match(stderr, expected);
  }
});

test('the command line names the folder to start from when there is no project', (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-none-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const { status, stderr } = spawnSync(CLI, ['tags', '--project', outside], { encoding: 'utf8' });
  assert.deepEqual([status, stderr], [1, `no project folder at or above ${outside}; run aidrian init\n`]);
});

// Each case writes a one-bucket project, changes one thing, and expects one error.
const INDEX = '.aidrian/knowledge/kb.json';
const bucketCases = [
  // .aidrian.json marks the project root when the folder has no config.json.
  ['no config', (p) => { writeFileSync(path.join(p, '.aidrian.json'), '{"dir": ".aidrian"}'); rmSync(path.join(p, '.aidrian/config.json')); }, /^\.aidrian\/config\.json: not found$/],
  ['config of another version', (p) => writeConfig(p, { version: 2 }), /^\.aidrian\/config\.json: project folder version 2;/],
  ['unknown config key', (p) => writeConfig(p, { version: 1, extra: true }), /unknown key "extra"/],
  ['broken .aidrian.json', (p) => writeFileSync(path.join(p, '.aidrian.json'), '{'), /^\.aidrian\.json: invalid JSON/],
  ['invalid JSON', (p) => writeFileSync(path.join(p, INDEX), '{'), /^\.aidrian\/knowledge\/kb\.json: invalid JSON/],
  ['file name that is not an id', (p) => writeFileSync(path.join(p, '.aidrian/knowledge/Bad Id.json'), '{}'), /^\.aidrian\/knowledge\/Bad Id\.json: the file name is the bucket id/],
  ['no dir', (p) => bucket(p, { dir: undefined }), /kb\.json: "dir" must be a folder inside the project$/],
  ['dir outside the project', (p) => bucket(p, { dir: '../elsewhere' }), /kb\.json: "dir" must be a folder inside the project$/],
  ['dir that does not exist', (p) => bucket(p, { dir: 'nope' }), /kb\.json: "dir": "nope" does not exist \(relative to .*\)$/],
  ['dir that is a file', (p) => bucket(p, { dir: 'outside.md' }), /kb\.json: "dir" must be a folder inside the project$/],
  ['no description', (p) => bucket(p, { description: '' }), /"description" must/],
  ['unknown bucket key', (p) => bucket(p, { owner: 'x' }), /unknown key "owner"/],
  ['old "id" key', (p) => bucket(p, { id: 'kb' }), /kb\.json: unknown key "id"$/],
  ['old "tags" map', (p) => bucket(p, { tags: { testing: ['sub/testing.md'] } }), /unknown key "tags"/],
  ['missing doc', (p) => bucket(p, docs({ 'nope.md': { summary: 'Nope.' } })), /kb\/nope\.md does not exist/],
  ['doc outside the bucket', (p) => bucket(p, docs({ '../outside.md': { summary: 'Out.' } })), /relative \.md path inside the bucket/],
  ['not markdown', (p) => bucket(p, { always: ['rules.md', 'notes.txt'] }), /"always": "notes\.txt" must be a relative \.md path inside the bucket/],
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
  ['doc with no entry', (p) => writeFileSync(path.join(p, 'kb/sub/orphan.md'), '# Orphan\n'), /^kb\/sub\/orphan\.md: has no entry in \.aidrian\/knowledge\/kb\.json; add it to "docs" with a summary, or delete it$/],
  // ROOT is this repository, outside the temporary project.
  ['bucket folder links outside', (p) => { symlinkSync(ROOT, path.join(p, 'ext')); bucket(p, { dir: 'ext' }); }, /kb\.json: "dir" must be a folder inside the project$/],
  ['doc in a folder that links outside', (p) => { symlinkSync(ROOT, path.join(p, 'kb/ext')); bucket(p, { always: ['rules.md', 'ext/README.md'] }); }, /"ext\/README\.md" must be a relative \.md path inside the bucket/],
  ['index file links outside', (p) => { rmSync(path.join(p, INDEX)); symlinkSync(path.join(ROOT, 'package.json'), path.join(p, INDEX)); }, /^\.aidrian\/knowledge\/kb\.json: links outside the project$/],
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
    const missing = Array.isArray(value) || value === undefined ? `${INDEX}: "docs" must map each doc to its summary and tags` : `${INDEX}: "docs" lists no docs`;
    assert.deepEqual(loadKnowledge(project).errors, [
      missing,
      `kb/rules.md: has no entry in ${INDEX}; add it to "docs" with a summary, or delete it`,
      `kb/sub/testing.md: has no entry in ${INDEX}; add it to "docs" with a summary, or delete it`,
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

test('buckets load in file-name order, the file name is the id, and a README in the bucket root needs no entry', (t) => {
  const project = validProject(t);
  writeFileSync(path.join(project, 'kb/README.md'), '# About this bucket\n');
  mkdirSync(path.join(project, 'kb2'));
  writeFileSync(path.join(project, 'kb2/a.md'), '# A\n');
  const second = { dir: 'kb2', description: 'Second.', always: ['a.md'], docs: { 'a.md': { summary: 'A.' } } };
  writeFileSync(path.join(project, '.aidrian/knowledge/00-first.json'), JSON.stringify(second));
  // Neither a folder nor a file of another type is an index.
  mkdirSync(path.join(project, '.aidrian/knowledge/drafts.json'));
  writeFileSync(path.join(project, '.aidrian/knowledge/README.md'), '# Indexes\n');
  const { buckets, errors } = loadKnowledge(project);
  assert.deepEqual(errors, []);
  assert.deepEqual(buckets.map((each) => [each.id, each.dir]), [['00-first', 'kb2'], ['kb', 'kb']]);
  assert.deepEqual(routeKnowledge(buckets, []), ['kb2/a.md', 'kb/rules.md']);
});

test('a project with no knowledge folder has no buckets and no errors', (t) => {
  const project = validProject(t);
  rmSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  assert.deepEqual(loadKnowledge(project), { config: loadKnowledge(project).config, buckets: [], errors: [], warnings: [] });
});

test('the folder named by .aidrian.json holds config.json and the indexes', (t) => {
  const project = validProject(t);
  mkdirSync(path.join(project, 'tools'));
  renameSync(path.join(project, '.aidrian'), path.join(project, 'tools/harness'));
  writeFileSync(path.join(project, '.aidrian.json'), JSON.stringify({ dir: 'tools/harness' }));
  const { buckets, errors } = loadKnowledge(path.join(project, 'kb'));
  assert.deepEqual(errors, []);
  assert.deepEqual(routeKnowledge(buckets, ['testing']), ['kb/rules.md', 'kb/sub/testing.md']);
  writeFileSync(path.join(project, 'tools/harness/knowledge/kb.json'), '{');
  assert.match(loadKnowledge(project).errors[0], /^tools\/harness\/knowledge\/kb\.json: invalid JSON/);
});

test('a doc that links outside its bucket fails, and a link that stays inside passes', (t) => {
  const project = validProject(t);
  symlinkSync(path.join(ROOT, 'README.md'), path.join(project, 'kb/outside.md'));
  // Stays inside the project but leaves the bucket.
  symlinkSync('../outside.md', path.join(project, 'kb/injected.md'));
  symlinkSync(path.join(project, 'kb/rules.md'), path.join(project, 'kb/sub/rules-link.md'));
  bucket(project, docs({ 'outside.md': { summary: 'Out.' }, 'injected.md': { summary: 'In.' }, 'sub/rules-link.md': { summary: 'Link.' } }));
  assert.deepEqual(loadKnowledge(project).errors, [
    `${INDEX}: "docs": "outside.md" must be a relative .md path inside the bucket`,
    `${INDEX}: "docs": "injected.md" must be a relative .md path inside the bucket`,
    `kb/injected.md: has no entry in ${INDEX}; add it to "docs" with a summary, or delete it`,
    `kb/outside.md: has no entry in ${INDEX}; add it to "docs" with a summary, or delete it`,
  ]);
});

// A knowledge source in its own temporary folder, outside the project, listed in the project's .aidrian.local.json by its
// path relative to the project. Its bucket "personal" indexes notes/habits.md.
function localSource(t, project) {
  const source = mkdtempSync(path.join(tmpdir(), 'aidrian-source-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  mkdirSync(path.join(source, 'knowledge'));
  mkdirSync(path.join(source, 'notes'));
  writeFileSync(path.join(source, 'notes/habits.md'), '# Habits\n');
  writeFileSync(path.join(source, 'outside.md'), '# Outside\n');
  const index = { dir: 'notes', description: 'My notes.', always: ['habits.md'], docs: { 'habits.md': { summary: 'My testing habits.', tags: ['testing'] } } };
  writeFileSync(path.join(source, 'knowledge/personal.json'), JSON.stringify(index));
  const label = path.relative(project, source);
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ sources: [label] }));
  return { source, label, index };
}

test('a local source loads after the project folder, with absolute doc paths and its source', (t) => {
  const project = validProject(t);
  const { source, label } = localSource(t, project);
  const { buckets, errors } = loadKnowledge(project);
  assert.deepEqual(errors, []);
  assert.deepEqual(buckets.map((bucket) => [bucket.id, bucket.source, bucket.dir]), [['kb', null, 'kb'], ['personal', label, path.join(source, 'notes')]]);
  assert.deepEqual(buckets[1].docs, [{ path: path.join(source, 'notes/habits.md'), summary: 'My testing habits.', tags: ['testing'], source: label }]);
  assert.deepEqual(routeKnowledge(buckets, ['testing']), ['kb/rules.md', 'kb/sub/testing.md', path.join(source, 'notes/habits.md')]);
});

// Each case changes the local source and expects one error, which starts with the source.
const sourceCases = [
  ['a bucket id the project folder defines', (s) => renameSync(path.join(s, 'knowledge/personal.json'), path.join(s, 'knowledge/kb.json')),
    (label) => `${label}/knowledge/kb.json: bucket "kb" is already defined by .aidrian/knowledge/kb.json`],
  ['dir outside the source', (s, index) => writeIndex(s, { ...index, dir: '..' }), (label) => `${label}: knowledge/personal.json: "dir" must be a folder inside its source`],
  ['dir that links outside the source', (s, index) => { symlinkSync(ROOT, path.join(s, 'ext')); writeIndex(s, { ...index, dir: 'ext' }); },
    (label) => `${label}: knowledge/personal.json: "dir" must be a folder inside its source`],
  ['doc outside its bucket', (s, index) => writeIndex(s, { ...index, docs: { ...index.docs, '../outside.md': { summary: 'Out.' } } }),
    (label) => `${label}: knowledge/personal.json: "docs": "../outside.md" must be a relative .md path inside the bucket`],
  ['index that links outside the source', (s) => { rmSync(path.join(s, 'knowledge/personal.json')); symlinkSync(path.join(ROOT, 'package.json'), path.join(s, 'knowledge/personal.json')); },
    (label) => `${label}: knowledge/personal.json: links outside its source`],
  ['doc with no entry', (s) => writeFileSync(path.join(s, 'notes/more.md'), '# More\n'),
    (label) => `${label}: notes/more.md: has no entry in knowledge/personal.json; add it to "docs" with a summary, or delete it`],
  ['config.json of another version', (s) => writeFileSync(path.join(s, 'config.json'), '{"version": 2}'),
    (label) => `${label}: config.json: project folder version 2; this plugin reads version 1; see ${REPOSITORY}/blob/main/docs/project-folder.md#migrating`],
  ['config.json with another key', (s) => writeFileSync(path.join(s, 'config.json'), '{"version": 1, "defaultBranch": "main"}'),
    (label) => `${label}: config.json: unknown key "defaultBranch"`],
];

for (const [name, change, expected] of sourceCases) {
  test(`a local source fails: ${name}`, (t) => {
    const project = validProject(t);
    const { source, label, index } = localSource(t, project);
    writeFileSync(path.join(source, 'config.json'), '{"version": 1}');
    assert.deepEqual(loadKnowledge(project).errors, [], 'the base source is valid');
    change(source, index);
    const { buckets, errors } = loadKnowledge(project);
    assert.deepEqual(errors, [expected(label)]);
    assert.equal(buckets[0].id, 'kb', 'the project bucket still loads first');
  });
}

test('a local source of another version adds none of its buckets', (t) => {
  const project = validProject(t);
  const { source } = localSource(t, project);
  writeFileSync(path.join(source, 'config.json'), '{"version": 2}');
  assert.deepEqual(loadKnowledge(project).buckets.map((bucket) => bucket.id), ['kb']);
});

function writeIndex(source, value) {
  writeFileSync(path.join(source, 'knowledge/personal.json'), JSON.stringify(value));
}

function validProject(t) {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-knowledge-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(project, 'kb/sub'), { recursive: true });
  writeFileSync(path.join(project, 'outside.md'), '# Outside\n');
  writeFileSync(path.join(project, 'notes.txt'), 'Notes.\n');
  writeFileSync(path.join(project, 'kb/rules.md'), '# Rules\n');
  writeFileSync(path.join(project, 'kb/notes.txt'), 'Notes.\n');
  writeFileSync(path.join(project, 'kb/sub/testing.md'), '# Testing\n');
  writeConfig(project, { version: 1 });
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
  const value = { dir: 'kb', description: 'Test rules.', always: ['rules.md'], docs: BASE_DOCS, ...overrides };
  writeFileSync(path.join(project, INDEX), JSON.stringify(value));
}

test('initBucket drafts a summary past CRLF frontmatter', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-kb-init-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  mkdirSync(path.join(dir, 'notes'));
  writeFileSync(path.join(dir, 'notes/a.md'), '---\r\ntitle: hidden\r\n---\r\n# Rules\r\nKeep it short.\r\n');
  const { file } = initBucket(findProject(dir), 'notes');
  assert.equal(JSON.parse(readFileSync(path.join(dir, file), 'utf8')).docs['a.md'].summary, 'Rules: Keep it short.');
});
