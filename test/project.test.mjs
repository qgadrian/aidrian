import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { findProject, normalizeRemote, openProject, projectAt, stateDir, worktreesDir } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');

test('the project is the nearest folder with .aidrian/config.json, and every path is inside its folder', () => {
  const project = findProject(path.join(EXAMPLE, 'src'));
  assert.equal(project.root, EXAMPLE);
  assert.equal(project.dir, '.aidrian');
  assert.deepEqual(project.paths, { config: '.aidrian/config.json', knowledge: '.aidrian/knowledge', local: '.aidrian.local.json' });
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

test('every spelling of one remote normalizes to host/owner/repo', () => {
  for (const url of [
    'git@github.com:Owner/Repo.git',
    'https://github.com/Owner/Repo',
    'https://GitHub.com/Owner/Repo.git/',
    'ssh://git@github.com:22/Owner/Repo.git',
    'https://user:token@github.com/Owner/Repo.git\n',
  ]) {
    assert.equal(normalizeRemote(url), 'github.com/Owner/Repo', url);
  }
  assert.equal(normalizeRemote('/srv/git/notes.git'), '/srv/git/notes');
});

test('the state folder is under XDG_STATE_HOME, named for the origin, and shared by worktrees and clones', (t) => {
  const { dir, git } = repo(t);
  git('remote', 'add', 'origin', 'git@github.com:acme/Notes.git');
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  const clone = tempDir(t);
  execFileSync('git', ['init', '-q', clone]);
  execFileSync('git', ['-C', clone, 'remote', 'add', 'origin', 'https://github.com/acme/Notes']);
  const env = { XDG_STATE_HOME: '/state' };

  const main = stateDir(findProject(dir), { env });
  assert.match(main, /^\/state\/aidrian\/projects\/notes-[0-9a-f]{8}$/);
  assert.equal(stateDir(findProject(path.join(dir, 'wt/task')), { env }), main);
  assert.equal(stateDir(projectAt(clone), { env }), main);
  assert.equal(worktreesDir(findProject(path.join(dir, 'wt/task'))), path.join(dir, '.worktrees'), 'beside the repository files');
});

test('without XDG_STATE_HOME, or with a relative one, the state folder is under ~/.local/state', (t) => {
  const { dir } = repo(t);
  for (const env of [{}, { XDG_STATE_HOME: 'relative/state' }]) {
    assert.match(stateDir(findProject(dir), { env }), new RegExp(`^${homedir()}/\\.local/state/aidrian/projects/`));
  }
});

test('without an origin, the state folder is named for the main checkout and differs per checkout', (t) => {
  const first = repo(t);
  const second = repo(t);
  const env = { XDG_STATE_HOME: '/state' };
  const one = stateDir(findProject(first.dir), { env });
  assert.equal(path.dirname(one), '/state/aidrian/projects');
  assert.match(path.basename(one), new RegExp(`^${path.basename(first.dir).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-[0-9a-f]{8}$`));
  assert.notEqual(stateDir(findProject(second.dir), { env }), one);
});

test('state.dir and worktrees.dir move the folders: ~ is home, and a relative path starts at the repository root', (t) => {
  const { dir, git } = repo(t);
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  const inWorktree = findProject(path.join(dir, 'wt/task'));
  const config = (state, worktrees = '.worktrees') => ({ ...DEFAULTS, state: { dir: state }, worktrees: { dir: worktrees, bootstrap: null } });
  assert.equal(stateDir(inWorktree, { config: config('.state') }), path.join(dir, '.state'));
  assert.equal(worktreesDir(inWorktree, { config: config('.state') }), path.join(dir, '.worktrees'));
  assert.equal(worktreesDir(inWorktree, { config: config(null, '../trees') }), path.join(path.dirname(dir), 'trees'));
  assert.equal(worktreesDir(inWorktree, { config: config(null, '~/trees') }), path.join(homedir(), 'trees'));
  assert.equal(stateDir(inWorktree, { config: config('~/state') }), path.join(homedir(), 'state'));
  assert.equal(stateDir(inWorktree, { config: config('/abs/state') }), '/abs/state');
});

// A git repository with a committed project folder.
function repo(t) {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}\n');
  writeFileSync(path.join(dir, '.gitignore'), 'wt/\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return { dir, git };
}

function tempDir(t) {
  // realpath: on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
