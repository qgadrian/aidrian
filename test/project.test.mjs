import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  ['missing dir below a link outside', JSON.stringify({ dir: 'linked/new' }), /"dir" must be a relative folder inside the project$/],
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
    assert.deepEqual(project.unreadable, ['.aidrian.json'], 'its folder is not in force');
  });
}

test('.aidrian.json fails on an unknown key, and still uses its dir', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'harness', sources: [] }));
  const project = findProject(dir);
  assert.deepEqual([project.dir, project.errors, project.unreadable], ['harness', ['.aidrian.json: unknown key "sources"'], []]);
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

test('.aidrian.local.json may hold models alone; the project passes them on as written, for config.mjs to check', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const models = { claude: { agents: { explorer: { model: 'haiku' } } } };
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ models }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.sources.length, project.localModels], [[], 1, models]);
  assert.equal(findProject(path.join(ROOT, 'examples/consumer')).localModels, undefined);
});

test('.aidrian.local.json may hold names alone; the project passes them on as written, for config.mjs to check', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const names = { human: 'the product owner', extra: 1 };
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ names }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.sources.length, project.localNames], [[], 1, names]);
  assert.equal(findProject(path.join(ROOT, 'examples/consumer')).localNames, undefined);
});

test('.aidrian.local.json may hold telemetry alone; the project passes it on as written, for config.mjs to check', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const telemetry = { enabled: false, extra: 1 };
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ telemetry }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.sources.length, project.localTelemetry], [[], 1, telemetry]);
  assert.equal(findProject(path.join(ROOT, 'examples/consumer')).localTelemetry, undefined);
});

test('.aidrian.local.json github.autoMerge: "off" when unset; "on" or "off" opts in or out', (t) => {
  const dir = tempDir(t);
  // A temporary repository of its own, where git can say the local file is untracked: never GIT_DIR.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  assert.equal(findProject(dir).localAutoMerge, 'unset', 'no local file');
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ names: { human: 'the owner' } }));
  assert.equal(findProject(dir).localAutoMerge, 'unset', 'a local file without github');
  for (const value of ['on', 'off']) {
    writeFileSync(local, JSON.stringify({ github: { autoMerge: value } }));
    const project = findProject(dir);
    assert.deepEqual([project.errors, project.localAutoMerge], [[], value]);
  }
  writeFileSync(local, JSON.stringify({ github: {} }));
  assert.deepEqual([findProject(dir).errors, findProject(dir).localAutoMerge], [[], 'unset']);
  for (const [enabled, value] of [[true, 'on'], [false, 'off']]) {
    writeFileSync(local, JSON.stringify({ github: { autoMerge: { enabled } } }));
    const project = findProject(dir);
    assert.deepEqual([project.errors, project.localAutoMerge], [[], value], 'the object form');
  }
  for (const wrong of [{ enabled: 'yes' }, { enabled: true, strategy: 'merge' }, { allow: true }, {}, true, 'unset', null]) {
    writeFileSync(local, JSON.stringify({ github: { autoMerge: wrong } }));
    const project = findProject(dir);
    assert.equal(project.localAutoMerge, 'off', JSON.stringify(wrong));
    assert.equal(project.errors.length, 1, JSON.stringify(wrong));
  }
});

test('.aidrian.local.json with an error reads "off", never "unset", so it cannot follow a team default of "on"', (t) => {
  const dir = tempDir(t);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  for (const broken of [{ stray: 1 }, { sources: 'no-list' }, { github: 1 }, { github: { other: 1 } }]) {
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(broken));
    assert.equal(findProject(dir).localAutoMerge, 'off', JSON.stringify(broken));
  }
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{ not json');
  assert.equal(findProject(dir).localAutoMerge, 'off', 'unparsable');
});

test('.aidrian.local.json that git tracks: a branch could carry it, so its auto-merge switch reads "off" with an error', (t) => {
  const dir = tempDir(t);
  // A temporary repository of its own: never GIT_DIR, never a real repository.
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  assert.deepEqual([findProject(dir).errors, findProject(dir).localAutoMerge], [[], 'on'], 'untracked: the machine\'s own switch');
  git('add', '-f', '.aidrian.local.json');
  const project = findProject(dir);
  assert.equal(project.localAutoMerge, 'off');
  assert.deepEqual(project.errors, ['.aidrian.local.json: git tracks it, so a branch could carry it; "github.autoMerge" reads "off" until it is untracked (git rm --cached .aidrian.local.json)']);
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'off' } }));
  assert.deepEqual([findProject(dir).errors, findProject(dir).localAutoMerge], [[], 'off'], 'a tracked file that keeps it off is no error');
});

test('.aidrian.local.json tracked under another case: a branch could carry it, so the switch reads "off"', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const on = JSON.stringify({ github: { autoMerge: 'on' } });
  writeFileSync(path.join(dir, '.AIDRIAN.LOCAL.JSON'), on);
  git('add', '-f', '.AIDRIAN.LOCAL.JSON');
  writeFileSync(path.join(dir, '.aidrian.local.json'), on);
  assert.equal(findProject(dir).localAutoMerge, 'off');
});

test('a worktree\'s own .aidrian.local.json never sets the auto-merge switch: only the main checkout\'s does, and its other keys still apply', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const worktree = path.join(dir, 'wt/task');
  git('worktree', 'add', '-q', '-b', 'task', worktree);
  const local = (autoMerge) => JSON.stringify({ names: { human: 'Own' }, github: { autoMerge } });
  writeFileSync(path.join(worktree, '.aidrian.local.json'), local('on'));
  assert.deepEqual([findProject(worktree).localAutoMerge, findProject(worktree).localNames], ['unset', { human: 'Own' }], 'the main checkout has no file');
  for (const broken of [{ stray: 1 }, { sources: 'no-list' }]) {
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(broken));
    assert.equal(findProject(worktree).localAutoMerge, 'off', `a worktree's copy hides no error: ${JSON.stringify(broken)}`);
  }
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{}');
  assert.equal(findProject(worktree).localAutoMerge, 'unset', 'a valid main file with no setting');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'off' } }));
  assert.deepEqual([findProject(worktree).localAutoMerge, findProject(worktree).localNames], ['off', { human: 'Own' }], 'the main checkout says off');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  writeFileSync(path.join(worktree, '.aidrian.local.json'), local('off'));
  assert.equal(findProject(worktree).localAutoMerge, 'on', 'the main checkout says on, whatever the worktree\'s copy says');
  writeFileSync(path.join(worktree, '.aidrian.local.json'), '{');
  assert.deepEqual([findProject(worktree).localAutoMerge, findProject(worktree).unreadable], ['on', ['.aidrian.local.json']], 'a worktree\'s broken copy does not turn it off, and is still reported');
  writeFileSync(path.join(worktree, '.aidrian.local.json'), local('off'));
  writeFileSync(path.join(dir, '.aidrian.local.json'), '{');
  assert.deepEqual([findProject(worktree).localAutoMerge, findProject(worktree).errors], ['off', []], 'a main file that cannot be read reads off here, and is that checkout\'s error');
});

test('.aidrian.local.json takes github and decisions together, read from the main checkout in a worktree too', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const worktree = path.join(dir, 'wt/task');
  git('worktree', 'add', '-q', '-b', 'task', worktree);
  const decisions = { mode: 'decide-reversible' };
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: { enabled: true } }, decisions }));
  for (const at of [dir, worktree]) {
    const project = findProject(at);
    assert.deepEqual([project.errors, project.localAutoMerge, project.localDecisions], [[], 'on', decisions], at);
  }
});

test('review.productFeedback.auto comes only from the main checkout\'s local file: a worktree\'s copy is not read, a tracked copy is ignored with an error', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  const worktree = path.join(dir, 'wt/task');
  git('worktree', 'add', '-q', '-b', 'task', worktree);
  const local = (auto) => JSON.stringify({ review: { productFeedback: { auto } } });
  const main = path.join(dir, '.aidrian.local.json');
  const own = path.join(worktree, '.aidrian.local.json');
  const read = (at) => findProject(at).localFeedbackAuto;

  assert.equal(read(dir), undefined, 'no file');
  writeFileSync(own, local(true));
  assert.equal(read(worktree), undefined, 'a worktree\'s own copy is not read: the main checkout has no file');
  for (const value of [true, false]) {
    writeFileSync(main, local(value));
    assert.equal(read(dir), value);
    assert.equal(read(worktree), value, 'the main checkout says so, whatever the worktree\'s copy says');
  }
  writeFileSync(own, '{');
  assert.equal(read(worktree), false, 'a worktree\'s broken copy changes nothing');
  writeFileSync(own, local(true));
  writeFileSync(main, '{');
  assert.equal(read(dir), undefined, 'a broken file reads as unset, so the team\'s value holds, never false');
  assert.equal(read(worktree), undefined);
  writeFileSync(main, local('no'));
  assert.equal(read(dir), undefined, 'an invalid value reads as unset');
  writeFileSync(main, '{}');
  assert.equal(read(dir), undefined);

  writeFileSync(main, local(false));
  writeFileSync(path.join(dir, '.gitignore'), '');
  git('add', '.aidrian.local.json');
  const tracked = findProject(dir);
  assert.equal(tracked.localFeedbackAuto, undefined, 'a tracked copy is ignored');
  assert.match(tracked.errors.join('\n'), /\.aidrian\.local\.json: git tracks it.*review\.productFeedback\.auto/u);
  assert.equal(read(worktree), undefined, 'from a worktree too');
});

test('.aidrian.local.json github.autoMerge "on" where git cannot say it is untracked reads "off" with an error', (t) => {
  // No repository: git ls-files fails, which is no answer "untracked".
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.localAutoMerge], [['.aidrian.local.json: git could not say whether it tracks it, so "github.autoMerge" reads "off"'], 'off']);
});

// The local file opts one machine in; it never sets what the team decides: strategy, cleanup, or the ceiling itself.
const localGithubCases = [
  ['a strategy', { autoMerge: 'on', strategy: 'squash' }, ['.aidrian.local.json: unknown key "github.strategy"; only "github.autoMerge" is a machine setting']],
  ['the ceiling', { allow: true }, ['.aidrian.local.json: unknown key "github.allow"; only "github.autoMerge" is a machine setting']],
  ['a team group', { autoMerge: { allow: true } }, ['.aidrian.local.json: "github.autoMerge" must be { "enabled": true } or { "enabled": false }']],
  ['a boolean', { autoMerge: true }, ['.aidrian.local.json: "github.autoMerge" must be { "enabled": true } or { "enabled": false }']],
];
for (const [name, github, errors] of localGithubCases) {
  test(`.aidrian.local.json github rejects ${name}, and auto-merge stays off`, (t) => {
    const dir = tempDir(t);
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github }));
    const project = findProject(dir);
    assert.deepEqual([project.errors, project.localAutoMerge], [errors, 'off']);
  });
}

test('.aidrian.local.json github must be an object, and auto-merge stays off', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: 'on' }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.localAutoMerge], [['.aidrian.local.json: "github" must be an object'], 'off']);
});

test('.aidrian.local.json may hold agent gates alone; the project passes them on as written, for config.mjs to check', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const agents = { main: { deny: ['Bash(git push)'] }, explorer: 'not checked here' };
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ agents }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.sources.length, project.localAgents], [[], 1, agents]);
  assert.equal(findProject(path.join(ROOT, 'examples/consumer')).localAgents, undefined);
});

// Each case expects one error; a source that is not a folder is left out, the others stay.
const localCases = [
  ['invalid JSON', '{', /^\.aidrian\.local\.json: invalid JSON/, 0],
  ['unknown key', JSON.stringify({ sources: [], dir: 'x' }), /^\.aidrian\.local\.json: unknown key "dir"$/, 0],
  ['sources that is not a list', JSON.stringify({ sources: 'kb' }), /^\.aidrian\.local\.json: "sources" must be a list of folders$/, 0],
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
    assert.deepEqual(project.unreadable, name === 'invalid JSON' ? ['.aidrian.local.json'] : [], 'only a file that cannot be read is not in force');
    assert.equal(project.localAutoMerge, 'off', 'a broken local file never turns auto-merge on');
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
  writeFileSync(path.join(dir, 'app/.aidrian.local.json'), JSON.stringify({ sources: [path.relative(path.join(dir, 'app'), shared)], github: { autoMerge: 'on' } }));

  const inWorktree = findProject(path.join(dir, 'wt/task/app'));
  assert.equal(inWorktree.root, path.join(dir, 'wt/task/app'));
  assert.deepEqual(inWorktree.errors, []);
  assert.deepEqual(inWorktree.sources.slice(1), [{ label: path.relative(path.join(dir, 'app'), shared), base: shared, index: 'knowledge', local: true }]);
  assert.deepEqual(findProject(path.join(dir, 'app')).sources.slice(1), inWorktree.sources.slice(1));
  assert.equal(inWorktree.localAutoMerge, 'on', 'the auto-merge opt-in comes from the main checkout too');
});

test('the search stops at the top of the git checkout: a worktree whose branch has no project folder has none', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  // The branch predates the project folder, which the main checkout adds after it.
  const old = path.join(dir, '.worktrees/old');
  git('worktree', 'add', '-q', '-b', 'old', old);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}\n');
  mkdirSync(path.join(old, 'src'));

  assert.equal(findProject(dir).root, dir);
  assert.equal(findProject(old), null);
  assert.equal(findProject(path.join(old, 'src')), null);
  assert.equal(findProject(path.join(old, 'missing/sub')), null, 'from a folder that does not exist yet');
  const link = path.join(tempDir(t), 'link');
  symlinkSync(dir, link);
  assert.equal(findProject(path.join(link, '.worktrees/old/src')), null, 'from a path spelled through a symlink');
  assert.equal(findProject(link).root, link, 'which the project root keeps');
  assert.equal(projectAt(old).root, old, 'a command there works with the defaults');

  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs')], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: path.join(old, 'src') }),
    encoding: 'utf8',
  });
  assert.deepEqual([hook.status, hook.stdout, hook.stderr], [0, '', ''], 'the hooks stay silent there');
});

test('finding the project runs no git without a project folder above, and git once in a worktree that has one', (t) => {
  const dir = tempDir(t);
  const bin = tempDir(t);
  const log = path.join(bin, 'calls');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}\n');
  writeFileSync(path.join(dir, '.gitignore'), 'wt/\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  const calls = (start) => {
    writeFileSync(log, '');
    const script = `import { findProject } from ${JSON.stringify(path.join(ROOT, 'plugins/aidrian/lib/project.mjs'))};
      process.stdout.write(String(findProject(${JSON.stringify(start)})?.root ?? null));`;
    const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    const root = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env, encoding: 'utf8' });
    return [root, readFileSync(log, 'utf8').split('\n').filter(Boolean).length];
  };
  assert.deepEqual(calls(tempDir(t)), ['null', 0]);
  assert.deepEqual(calls(path.join(dir, 'wt/task')), [path.join(dir, 'wt/task'), 1]);
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

test('two projects in one repository get their own state folders, and a project at the root keeps its id', (t) => {
  const { dir, git } = repo(t);
  git('remote', 'add', 'origin', 'git@github.com:acme/Notes.git');
  for (const sub of ['apps/a', 'apps/b']) {
    mkdirSync(path.join(dir, sub, '.aidrian'), { recursive: true });
    writeFileSync(path.join(dir, sub, '.aidrian/config.json'), '{"version": 1}\n');
  }
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'apps');
  git('worktree', 'add', '-q', '-b', 'task', path.join(dir, 'wt/task'));
  const env = { XDG_STATE_HOME: '/state' };

  const root = stateDir(findProject(dir), { env });
  assert.equal(root, `/state/aidrian/projects/notes-${createHash('sha256').update('github.com/acme/Notes').digest('hex').slice(0, 8)}`);
  const a = stateDir(findProject(path.join(dir, 'apps/a')), { env });
  const b = stateDir(findProject(path.join(dir, 'apps/b')), { env });
  assert.equal(new Set([root, a, b]).size, 3);
  assert.match(path.basename(a), /^notes-[0-9a-f]{8}$/);
  assert.equal(stateDir(findProject(path.join(dir, 'wt/task/apps/a')), { env }), a, 'a worktree shares the subfolder project');
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
  const config = (state, worktrees = '.worktrees') => ({ ...DEFAULTS, state: { dir: state }, git: { ...DEFAULTS.git, worktrees: { dir: worktrees, bootstrap: null } } });
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
