import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { findProject, openProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');

test('the project is the nearest folder with .aidrian/config.json, and every path is inside its folder', () => {
  const project = findProject(path.join(EXAMPLE, 'src'));
  assert.equal(project.root, EXAMPLE);
  assert.equal(project.dir, '.aidrian');
  assert.deepEqual(project.paths, {
    config: '.aidrian/config.json',
    knowledge: '.aidrian/knowledge',
    plans: '.aidrian/plans',
    handoffs: '.aidrian/handoffs',
    lessons: '.aidrian/lessons',
    dispatchLog: '.aidrian/dispatch-log.jsonl',
    worktrees: '.aidrian/worktrees',
    local: '.aidrian.local.json',
  });
  assert.deepEqual(project.sources, [{ label: '.aidrian', base: EXAMPLE, index: '.aidrian/knowledge', local: false }]);
  assert.deepEqual(project.errors, []);
});

test('outside any project there is none, and openProject describes one that does not exist yet', (t) => {
  const dir = tempDir(t);
  assert.equal(findProject(dir), null);
  assert.equal(findProject(path.join(dir, 'missing/sub')), null);
  assert.deepEqual([openProject(dir).dir, openProject(dir).errors], ['.aidrian', []]);
});

test('.aidrian.json moves the folder, and marks the project root even before the folder exists', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, 'tools/src'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: './tools/harness/' }));
  const project = findProject(path.join(dir, 'tools/src'));
  assert.deepEqual([project.root, project.dir, project.paths.config, project.errors], [dir, 'tools/harness', 'tools/harness/config.json', []]);
  assert.equal(project.sources[0].index, 'tools/harness/knowledge');
});

// Each case expects one error, and the default folder in its place.
const overrideCases = [
  ['invalid JSON', '{', /^\.aidrian\.json: invalid JSON/],
  ['not an object', '["harness"]', /^\.aidrian\.json: must be a JSON object$/],
  ['no dir', '{}', /^\.aidrian\.json: "dir" must be a relative folder inside the project$/],
  ['absolute dir', JSON.stringify({ dir: '/etc' }), /"dir" must be a relative folder inside the project$/],
  ['dir outside the project', JSON.stringify({ dir: '../harness' }), /"dir" must be a relative folder inside the project$/],
  ['dir that is the project root', JSON.stringify({ dir: '.' }), /"dir" must be a relative folder inside the project$/],
  ['dir that links outside', JSON.stringify({ dir: 'linked' }), /"dir" must be a relative folder inside the project$/],
];

for (const [name, text, expected] of overrideCases) {
  test(`.aidrian.json fails: ${name}`, (t) => {
    const dir = tempDir(t);
    symlinkSync(ROOT, path.join(dir, 'linked'));
    writeFileSync(path.join(dir, '.aidrian.json'), text);
    const project = findProject(dir);
    assert.equal(project.dir, '.aidrian');
    assert.equal(project.errors.length, 1, project.errors.join('\n'));
    assert.match(project.errors[0], expected);
  });
}

test('.aidrian.json fails on an unknown key, and still uses its dir', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'harness', sources: [] }));
  const project = findProject(dir);
  assert.deepEqual([project.dir, project.errors], ['harness', ['.aidrian.json: unknown key "sources"']]);
});

test('.aidrian.local.json adds sources after the project folder: ~ is the home folder, other paths start at the project', (t) => {
  const dir = tempDir(t);
  const home = tempDir(t);
  const shared = tempDir(t);
  mkdirSync(path.join(home, 'kb/personal'), { recursive: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  const sources = ['~/kb/personal', path.relative(dir, shared), shared];
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'harness' }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ sources }));
  const project = findProject(dir);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.sources, [
    { label: 'harness', base: dir, index: 'harness/knowledge', local: false },
    { label: '~/kb/personal', base: path.join(home, 'kb/personal'), index: 'knowledge', local: true },
    { label: sources[1], base: shared, index: 'knowledge', local: true },
    { label: shared, base: shared, index: 'knowledge', local: true },
  ]);
});

// Each case expects one error; a source that is not a folder is left out, the others stay.
const localCases = [
  ['invalid JSON', '{', /^\.aidrian\.local\.json: invalid JSON/, 0],
  ['unknown key', JSON.stringify({ sources: [], dir: 'x' }), /^\.aidrian\.local\.json: unknown key "dir"$/, 0],
  ['no sources', '{}', /^\.aidrian\.local\.json: "sources" must be a list of folders$/, 0],
  ['a source that is not text', JSON.stringify({ sources: ['kb', 3] }), /"sources" must be a list of folders$/, 0],
  ['a missing source', JSON.stringify({ sources: ['kb', 'nope'] }), /^\.aidrian\.local\.json: source "nope" is not a folder$/, 1],
  ['a source that is a file', JSON.stringify({ sources: ['notes.md', 'kb'] }), /source "notes\.md" is not a folder$/, 1],
];

for (const [name, text, expected, kept] of localCases) {
  test(`.aidrian.local.json fails: ${name}`, (t) => {
    const dir = tempDir(t);
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
    mkdirSync(path.join(dir, 'kb'));
    writeFileSync(path.join(dir, 'notes.md'), '# Notes\n');
    writeFileSync(path.join(dir, '.aidrian.local.json'), text);
    const project = findProject(dir);
    assert.equal(project.errors.length, 1, project.errors.join('\n'));
    assert.match(project.errors[0], expected);
    assert.equal(project.sources.length, 1 + kept);
  });
}

test('a git worktree has no copy of .aidrian.local.json, so its sources come from the main checkout', (t) => {
  const dir = tempDir(t);
  const shared = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, 'app/.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, 'app/.aidrian/config.json'), '{"version": 1}\n');
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\nwt/\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  // A nested project: the local file sits next to its project folder, not at the repository root.
  writeFileSync(path.join(dir, 'app/.aidrian.local.json'), JSON.stringify({ sources: [path.relative(path.join(dir, 'app'), shared)] }));

  const inWorktree = findProject(path.join(dir, 'wt/task/app'));
  assert.equal(inWorktree.root, path.join(dir, 'wt/task/app'));
  assert.deepEqual(inWorktree.errors, []);
  assert.deepEqual(inWorktree.sources.slice(1), [{ label: path.relative(path.join(dir, 'app'), shared), base: shared, index: 'knowledge', local: true }]);
  assert.deepEqual(findProject(path.join(dir, 'app')).sources.slice(1), inWorktree.sources.slice(1));
});

function tempDir(t) {
  // realpath: on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
