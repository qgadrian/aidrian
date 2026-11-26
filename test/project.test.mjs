import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { DEFAULTS, loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { findProject, foldPath, GUARDED_PATHS, isGuardedPath, spellingProblem, spellingRule, knowledgeIn, normalizeRemote, openProject, projectAt, stateDir, stateRoot, worktreesDir } from '../plugins/aidrian/lib/project.mjs';

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
  for (const wrong of [{ enabled: 'yes' }, { allow: true }, {}, true, 'unset', null]) {
    writeFileSync(local, JSON.stringify({ github: { autoMerge: wrong } }));
    const project = findProject(dir);
    assert.equal(project.localAutoMerge, 'off', JSON.stringify(wrong));
    assert.equal(project.errors.length, 1, JSON.stringify(wrong));
  }
  // A field beside `enabled` is one this plugin does not read: a warning, and `enabled` still applies.
  writeFileSync(local, JSON.stringify({ github: { autoMerge: { enabled: true, strategy: 'merge' } } }));
  const extra = findProject(dir);
  assert.deepEqual([extra.errors, extra.warnings, extra.localAutoMerge], [[], ['.aidrian.local.json: unknown key "github.autoMerge.strategy"'], 'on']);
});

test('.aidrian.local.json with an error reads "off", never "unset", so it cannot follow a team default of "on"', (t) => {
  const dir = tempDir(t);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  for (const broken of [{ reviewApprovals: 'maybe' }, { sources: 'no-list' }, { github: 1 }, { github: { autoMerge: 'maybe' } }]) {
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(broken));
    assert.equal(findProject(dir).localAutoMerge, 'off', JSON.stringify(broken));
  }
  // An unknown key is no error: the switch resolves as if it were not there.
  for (const unknown of [{ stray: 1 }, { github: { other: 1 } }]) {
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(unknown));
    assert.equal(findProject(dir).localAutoMerge, 'unset', JSON.stringify(unknown));
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
  for (const broken of [{ reviewApprovals: 'maybe' }, { sources: 'no-list' }]) {
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
  assert.deepEqual([findProject(worktree).localAutoMerge, findProject(worktree).errors], ['off', findProject(dir).errors], 'a main file that cannot be read reads off here, with the error it has there');
  assert.equal(findProject(worktree).errors.length, 1);
});

test('a worktree with its own .aidrian.local.json reads the main checkout\'s switches with every check that checkout runs, and reports its errors', (t) => {
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
  writeFileSync(path.join(worktree, '.aidrian.local.json'), JSON.stringify({ names: { human: 'Own' } }));
  const read = (at) => {
    const project = findProject(at);
    return [project.localAutoMerge, project.localUnattendedWaiver, project.localReviewApprovals, project.errors];
  };
  const approvals = '.aidrian.local.json: "reviewApprovals" must be "on" or "off"';
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { unattendedWaiver: 'on' }, reviewApprovals: 'invalid' }));
  assert.deepEqual(read(worktree), ['off', 'off', 'off', [approvals]], 'an invalid reviewApprovals reads both switches off, with its error');
  assert.deepEqual(read(dir), ['off', 'off', 'off', [approvals]], 'as it does in the main checkout');
  const mains = [
    { reviewApprovals: 'invalid' },
    { reviewApprovals: 'invalid', github: { autoMerge: 'on' } },
    { stray: 1, github: { unattendedWaiver: 'on' } },
    { sources: 'no-list', github: { unattendedWaiver: { enabled: true } } },
    { github: { unattendedWaiver: 'on', strategy: 'squash' } },
    '{',
    { github: { unattendedWaiver: 'on' }, reviewApprovals: 'on' },
    { github: { autoMerge: 'off' }, reviewApprovals: 'off' },
    {},
  ];
  for (const main of mains) {
    writeFileSync(path.join(dir, '.aidrian.local.json'), typeof main === 'string' ? main : JSON.stringify(main));
    assert.deepEqual(read(worktree), read(dir), `the worktree reads what the main checkout reads: ${JSON.stringify(main)}`);
  }
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

// A key the team sets is one the local file does not read: a warning, never an error, and never the team's value.
for (const [name, github, key] of [['a strategy', { strategy: 'squash' }, 'strategy'], ['the ceiling', { allow: true }, 'allow']]) {
  test(`.aidrian.local.json github ignores ${name} with a warning, and auto-merge stays unset`, (t) => {
    const dir = tempDir(t);
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github }));
    const project = findProject(dir);
    const warning = `.aidrian.local.json: unknown key "github.${key}"; only "github.autoMerge" and "github.unattendedWaiver" are machine settings`;
    assert.deepEqual([project.errors, project.warnings, project.localAutoMerge], [[], [warning], 'unset']);
  });
}

test('.aidrian.local.json warns on a key from a newer release, keeps the rest, and resolves the switches as if it were not there', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  mkdirSync(path.join(dir, 'kb'));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ sources: ['kb'], dir: 'x', reviewApprovals: 'off', handoff: { background: 'off' } }));
  const project = findProject(dir);
  assert.deepEqual([project.errors, project.warnings, project.unreadable], [[], ['.aidrian.local.json: unknown key "dir"'], []]);
  assert.equal(project.sources.length, 2, 'its sources still apply');
  assert.deepEqual([project.localReviewApprovals, project.localHandoffBackground], ['off', 'off'], 'a switch it sets holds');
  assert.deepEqual([project.localAutoMerge, project.localUnattendedWaiver, project.localUnattendedSignoff], ['unset', 'unset', 'unset'], 'one it leaves unset stays unset');
});

// An unknown name is quoted as JSON, so a newline in it cannot write a forged line into the check's output.
test('.aidrian.local.json quotes an unknown name, so a newline in it stays on its warning\'s line', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const forged = 'x\nok: everything passed';
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ [forged]: 1, handoff: { background: 'off', [forged]: 1 }, github: { [forged]: 1 } }));
  const project = findProject(dir);
  assert.deepEqual(project.errors, []);
  assert.deepEqual(project.warnings, [
    '.aidrian.local.json: unknown key "x\\nok: everything passed"',
    '.aidrian.local.json: unknown key "github.x\\nok: everything passed"; only "github.autoMerge" and "github.unattendedWaiver" are machine settings',
    '.aidrian.local.json: unknown key "handoff.x\\nok: everything passed"',
  ]);
  assert.ok(project.warnings.every((warning) => !/[\n\r]/u.test(warning)));
});

// JSON leaves the C1 controls and the line and paragraph separators raw, and a terminal may act on them: each is escaped.
test('.aidrian.local.json escapes a C1 control or a line separator in an unknown name, in every group that names one', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const csi = 'x\u009b2J';
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ [csi]: 1, handoff: { background: 'off', 'y\u2028z': 1 }, names: { [csi]: 'n' }, review: { [csi]: 1 } }));
  const project = findProject(dir);
  const { warnings } = loadConfig(project);
  assert.deepEqual([...project.warnings, ...warnings], [
    '.aidrian.local.json: unknown key "x\\u009b2J"',
    '.aidrian.local.json: unknown key "handoff.y\\u2028z"',
    '.aidrian.local.json: unknown key "names.x\\u009b2J"',
    '.aidrian.local.json: unknown key "review.x\\u009b2J"; only "review.engine", "review.visual", "review.productFeedback.auto", and "review.publish" are machine settings',
  ]);
  assert.ok([...project.warnings, ...warnings].every((warning) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(warning)));
});

// DEL too, and the names the local file's errors print: a review.publish field, an agent name, and a rejected gate
// pattern. Each stays the error it was; only its quoting changes.
test('.aidrian.local.json escapes DEL, and a control in a review.publish field, an agent name, or a gate pattern, keeping each an error', (t) => {
  const dir = tempDir(t);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
  const del = `x${String.fromCodePoint(0x7f)}y`;
  const csi = `p${String.fromCodePoint(0x9b)}q`;
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({
    [del]: 1,
    review: { publish: { [csi]: 1 } },
    agents: { [csi]: { deny: ['Bash'] }, explorer: { allow: [`Bash(git ${csi} *)`], deny: [`Read${csi}(`] } },
  }));
  const project = findProject(dir);
  const { errors, warnings, gateErrors } = loadConfig(project);
  assert.deepEqual([project.errors, project.warnings, warnings], [[], ['.aidrian.local.json: unknown key "x\\u007fy"'], []]);
  assert.deepEqual(errors, [
    '.aidrian.local.json: "review.publish.p\\u009bq" is the team\'s: "review.publish" in the local settings file may set only "summary": "counts" and "inline": false',
    '.aidrian.local.json: "agents.p\\u009bq": an agent name is "*", "main", or an agent name such as explorer',
    '.aidrian.local.json: "agents.explorer.allow" has "Bash(git p\\u009bq *)": Bash(...) takes a command prefix without "*", such as Bash(git push)',
    '.aidrian.local.json: "agents.explorer.deny" has "Readp\\u009bq(": a pattern is a tool name such as Read, a name ending in "*" such as mcp__github__*, or Bash(<command prefix>)',
  ]);
  assert.deepEqual(gateErrors.map(({ problem }) => problem.split(':')[0]), ['"agents.p\\u009bq"', '"agents.explorer.deny" has "Readp\\u009bq("'], 'the gate errors stay gate errors');
  assert.ok([...project.warnings, ...errors].every((line) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(line)));
});

// A field a newer release adds inside a setting this plugin reads: a warning, and the setting's own field still applies.
// A bad value of the field it reads stays an error.
const localFieldCases = [
  ['github.autoMerge', { github: { autoMerge: { enabled: false, until: 'tomorrow' } } }, 'localAutoMerge', 'off', 'github.autoMerge.until',
    { github: { autoMerge: { enabled: 'no', until: 'tomorrow' } } }, '"github.autoMerge" must be { "enabled": true } or { "enabled": false }'],
  ['github.unattendedWaiver', { github: { unattendedWaiver: { enabled: false, until: 'tomorrow' } } }, 'localUnattendedWaiver', 'off', 'github.unattendedWaiver.until',
    { github: { unattendedWaiver: { until: 'tomorrow' } } }, '"github.unattendedWaiver" must be { "enabled": true } or { "enabled": false }'],
  ['handoff', { handoff: { background: 'off', delay: 5 } }, 'localHandoffBackground', 'off', 'handoff.delay',
    { handoff: { background: 'yes', delay: 5 } }, '"handoff" must be { "background": "on" } or { "background": "off" }'],
];
for (const [name, local, key, value, field, bad, error] of localFieldCases) {
  test(`.aidrian.local.json ${name} warns on a field a newer release adds, and keeps its own`, (t) => {
    const dir = tempDir(t);
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1}');
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
    const project = findProject(dir);
    assert.deepEqual([project.errors, project.warnings, project[key]], [[], [`.aidrian.local.json: unknown key "${field}"`], value]);
    writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(bad));
    const broken = findProject(dir);
    assert.deepEqual([broken.errors, broken.warnings, broken[key]], [[`.aidrian.local.json: ${error}`], [`.aidrian.local.json: unknown key "${field}"`], 'off']);
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

test('under the test runner, a state root in the real home folder is refused, and one in a temporary folder is not', () => {
  const real = path.join(homedir(), '.local/state/aidrian');
  assert.equal(stateRoot({}), real, 'outside the test runner the default stands');
  assert.throws(() => stateRoot({ NODE_TEST_CONTEXT: 'child-v8' }), /a test reached the real state root .*--import \.\/scripts\/test-state\.mjs/u);
  assert.throws(() => stateRoot({ NODE_TEST_CONTEXT: 'child-v8', XDG_STATE_HOME: path.join(homedir(), '.local/state') }), /real state root/u);
  const temp = realpathSync(tmpdir());
  assert.equal(stateRoot({ NODE_TEST_CONTEXT: 'child-v8', XDG_STATE_HOME: path.join(temp, 'state') }), path.join(temp, 'state/aidrian'));
  assert.equal(stateRoot({ NODE_TEST_CONTEXT: 'child-v8', XDG_STATE_HOME: '/state' }), '/state/aidrian', 'a root outside the home folder is no developer`s');
  const own = path.join(homedir(), 'tmp-test-state');
  assert.equal(stateRoot({ NODE_TEST_CONTEXT: 'child-v8', XDG_STATE_HOME: own, AIDRIAN_TEST_STATE: own }), path.join(own, 'aidrian'), 'the run`s own test state folder');
});

test('a test file run without the preload keeps its state and temporary files out of the real folders', (t) => {
  const outer = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-plain-run-')));
  t.after(() => rmSync(outer, { recursive: true, force: true }));
  const file = path.join(outer, 'plain.test.mjs');
  const from = (relative) => JSON.stringify(pathToFileURL(path.join(ROOT, relative)).href);
  writeFileSync(file, [
    `import ${from('scripts/test-state.mjs')};`,
    "import { tmpdir } from 'node:os';",
    `import { stateRoot } from ${from('plugins/aidrian/lib/project.mjs')};`,
    'process.stdout.write(JSON.stringify({ root: stateRoot(), tmp: tmpdir() }));',
  ].join('\n'));
  // `node --test <file>` with no --import and none of the preload's variables, as an agent runs one file.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['XDG_STATE_HOME', 'AIDRIAN_TEST_STATE', 'NODE_TEST_CONTEXT'].includes(name)));
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env: { ...env, TMPDIR: outer } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const seen = JSON.parse(/\{"root".*?\}/u.exec(run.stdout)[0]);
  assert.ok(seen.root.startsWith(outer) && seen.tmp.startsWith(outer), JSON.stringify(seen));
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

test('GUARDED_PATHS holds every host\'s instruction files, by name at any depth, and by folder or file where the host reads them', () => {
  const families = {
    'AGENTS.md and CLAUDE.md, at any depth': ['AGENTS.md', 'CLAUDE.md', 'packages/api/AGENTS.md', 'a/b/c/CLAUDE.md', 'apps/web/agents.md'],
    'GEMINI.md': ['GEMINI.md', 'docs/GEMINI.md', 'a/b/gemini.md'],
    'a host name with an infix': ['AGENTS.override.md', 'sub/AGENTS.override.md', 'CLAUDE.local.md', 'deep/er/CLAUDE.local.md'],
    'other hosts\' names': ['AGENT.md', 'QWEN.md', 'WARP.md', 'CRUSH.md', 'CONVENTIONS.md', 'sub/conventions.md', 'x/Qwen.md'],
    'GitHub Copilot': ['.github/copilot-instructions.md', '.github/instructions/a.instructions.md', '.github/instructions/deep/b.md'],
    'Cursor': ['.cursor/rules/a.mdc', 'packages/x/.cursor/rules/a.mdc', '.cursorrules', 'packages/x/.cursorrules'],
    'Cline': ['.clinerules', '.clinerules/a.md', 'pkg/.clinerules/b.md'],
    'Windsurf': ['.windsurf/rules/a.md', 'pkg/.windsurf/rules/a.md', '.windsurfrules', 'pkg/.windsurfrules'],
    'Claude Code\'s folder, at any depth': ['.claude', '.claude/settings.json', 'apps/web/.claude/settings.json', 'a/b/.claude/agents/x.md', 'pkg/.claude'],
  };
  for (const [family, files] of Object.entries(families)) {
    for (const file of files) assert.ok(GUARDED_PATHS.test(file) && isGuardedPath(file), `${family}: ${file}`);
  }
  for (const file of ['docs/agents.mdx', 'docs/agent-sources.md', 'docs/claude-notes.md', 'NOTSKILL.md', '.claude.md', 'pkg/.claude.md', 'pkg/.claudex/a.md', 'src/.cursorrules.js', '.github/instructions-old.md', 'docs/cursor/a.md', 'windsurf.md', '.github/dependabot.yml', 'README.md']) {
    assert.deepEqual([GUARDED_PATHS.test(file), isGuardedPath(file)], [false, false], file);
  }
  // Another spelling a disk that folds names reads as the same path, which the pattern alone does not take.
  for (const file of ['.github/in\ufb06ructions/x.md', '.github/copilot-in\ufb05ructions.md', '.github/work\ufb02ows/ci.yml', '.GITHUB/WORK\ufb02OWS/ci.yml']) {
    assert.deepEqual([GUARDED_PATHS.test(file), isGuardedPath(file)], [false, true], file);
  }
});

// The one spelling rule: names the harness holds by their exact spelling, a folder's with a trailing slash.
test('spellingProblem refuses a path that is a held name, a file in a held folder, or a folder that holds one, in another spelling', () => {
  const names = ['.aidrian.json', 'docs/rules.md', '.aidrian/knowledge/', '.github/workflows/', '.github'];
  const refused = { '.AIDRIAN.JSON': '.aidrian.json', 'docs/RULES.md': 'docs/rules.md', DOCS: 'docs', '.aidrian/Knowledge/x.json': '.aidrian/knowledge', '.aidrian/KNOWLEDGE': '.aidrian/knowledge', '.github/work\ufb02ows/ci.yml': '.github/workflows', '.GITHUB': '.github' };
  for (const [file, name] of Object.entries(refused)) assert.equal(spellingProblem(file, names), `${JSON.stringify(file)} is ${JSON.stringify(name)} in another spelling, which a disk that ignores case or Unicode form reads as the same path`, file);
  for (const file of ['.aidrian.json', 'docs/rules.md', 'docs', 'docs/other.md', 'DOCS/other.md', '.aidrian/knowledge/x.json', '.github/workflows/ci.yml', '.GITHUB/ISSUE_TEMPLATE/a.md', 'src/a.js']) assert.equal(spellingProblem(file, names), null, file);
  // A guarded path by its fold alone, and two spellings of one name the harness holds.
  assert.match(spellingProblem('.github/in\ufb06ructions/x.md', []) ?? '', /is a guarded path in another spelling/u);
  assert.equal(spellingRule([], { guarded: false })('.github/in\ufb06ructions/x.md'), null, 'unless the rule leaves that clause out, as the push guard does');
  assert.equal(spellingProblem('CLAUDE.md', ['CLAUDE.md']), null);
  assert.match(spellingProblem('CLAUDE.md', ['CLAUDE.md', 'claude.md']) ?? '', /^"CLAUDE\.md" is "claude\.md" in another spelling/u);
  // A path past the rule's bounds is refused before it is folded, whatever names it holds.
  const deep = `${'a/'.repeat(65)}x.md`;
  for (const file of [deep, `docs/${'x'.repeat(4092)}`]) assert.match(spellingProblem(file, []) ?? '', /is deeper than 64 folders or longer than 4096 bytes, which no guard judges$/u, file.slice(0, 20));
  for (const file of [`${'a/'.repeat(64)}x.md`, `docs/${'x'.repeat(4091)}`]) assert.equal(spellingProblem(file, []), null, 'at the bounds');
});

// A refusal compares folds, so a fold that told apart two paths equal in lower case would drop one.
test('foldPath gives one fold to every two spellings that are equal in lower case, in upper case, or in a Unicode form', () => {
  const differ = [];
  for (let code = 1; code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const letter = String.fromCodePoint(code);
    // Between letters, so no word-final form is picked.
    const others = [letter.toLowerCase(), letter.toUpperCase(), letter.normalize('NFC'), letter.normalize('NFD')].filter((each) => each !== letter);
    if (others.some((each) => foldPath(`a${each}a`) !== foldPath(`a${letter}a`))) differ.push(code.toString(16));
  }
  assert.deepEqual(differ, []);
  assert.equal(foldPath('STRA\u1e9eE/x'), foldPath('stra\u00dfe/x'));
  assert.notEqual(foldPath('docs/a.md'), foldPath('docs/b.md'));
});

test('knowledgeIn: the knowledge index folder beside a located config.json, with its repository prefix', () => {
  assert.equal(knowledgeIn('.aidrian/config.json'), '.aidrian/knowledge');
  assert.equal(knowledgeIn('apps/web/harness/config.json'), 'apps/web/harness/knowledge');
});
