import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agreementProblem, bumpVersion, compareVersions, setVersion, versionLocations } from '../scripts/version.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const COPIED = [
  'plugins/aidrian/.claude-plugin/plugin.json',
  'plugins/aidrian/plugin.json',
  'package.json',
  'package-lock.json',
  '.claude-plugin/marketplace.json',
  '.agents/plugins/marketplace.json',
  'scripts/version.mjs',
];
const SKILL = 'plugins/aidrian/skills/demo/SKILL.md';
const IDENTITY = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];

// A scratch repository with this one's version files and script at version 1.4.2, one plugin skill, a `main` that is
// also `origin/main`, and the branch `feature` checked out.
function fixture(t) {
  // realpath: git prints real paths, and on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-version-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of COPIED) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  setVersion('1.4.2', dir);
  write(dir, SKILL, '# Demo\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...IDENTITY, ...args], { stdio: 'pipe', encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', '-c', 'feature');
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  return { dir, git, commit };
}

function write(dir, file, text) {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/version.mjs'), ...args], { encoding: 'utf8' });
const versions = (dir) => versionLocations(dir).map(({ version }) => version);

test('bumpVersion raises one part and resets the parts below it', () => {
  assert.equal(bumpVersion('1.4.2', 'patch'), '1.4.3');
  assert.equal(bumpVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(bumpVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(bumpVersion('0.9.9', 'minor'), '0.10.0');
  assert.throws(() => bumpVersion('1.4.2', 'huge'), /unknown level "huge": use patch, minor, major/);
  assert.throws(() => bumpVersion('1.4', 'patch'), /not an x\.y\.z version: "1\.4"/);
});

test('compareVersions orders by number, not by text', () => {
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0);
  assert.ok(compareVersions('1.4.2', '1.4.3') < 0);
  assert.equal(compareVersions('1.4.2', '1.4.2'), 0);
});

test('this repository writes one version, in these places', () => {
  const locations = versionLocations();
  assert.deepEqual(locations.map(({ where }) => where), [
    'plugins/aidrian/.claude-plugin/plugin.json: version',
    'plugins/aidrian/plugin.json: version',
    'package.json: version',
    'package-lock.json: version',
    'package-lock.json: packages."".version',
  ]);
  assert.equal(agreementProblem(locations), null);
});

test('npm run bump writes the new version everywhere and changes nothing else', (t) => {
  const { dir } = fixture(t);
  const before = Object.fromEntries(COPIED.map((file) => [file, readFileSync(path.join(dir, file), 'utf8')]));
  const minor = run(dir, 'minor');
  assert.equal(minor.status, 0, minor.stderr);
  assert.match(minor.stdout, /^version 1\.4\.2 -> 1\.5\.0 in:\n {2}plugins\/aidrian\/\.claude-plugin\/plugin\.json: version\n/);
  assert.deepEqual(versions(dir), Array(5).fill('1.5.0'));
  for (const file of COPIED) {
    const after = readFileSync(path.join(dir, file), 'utf8');
    assert.equal(after, before[file].replaceAll('"version": "1.4.2"', '"version": "1.5.0"'), file);
  }
  assert.equal(run(dir).status, 0);
  assert.deepEqual(versions(dir), Array(5).fill('1.5.1'), 'patch by default');
});

test('a marketplace entry that sets a version is one more place to bump', (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, '.claude-plugin/marketplace.json');
  const market = JSON.parse(readFileSync(file, 'utf8'));
  market.plugins[0].version = '1.4.2';
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  assert.equal(run(dir, 'patch').status, 0);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).plugins[0].version, '1.4.3');
  assert.deepEqual(versions(dir), Array(6).fill('1.4.3'));
});

test('bump and --check refuse files that disagree, and bump then changes nothing', (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, 'plugins/aidrian/plugin.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"1.4.2"', '"1.4.3"'));
  for (const args of [['patch'], ['--check']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /^the version is not the same everywhere; .* then run npm run bump:\n/, args[0]);
    assert.match(result.stderr, /\n {2}plugins\/aidrian\/plugin\.json: version: "1\.4\.3"\n/, args[0]);
  }
  assert.deepEqual(versions(dir), ['1.4.2', '1.4.3', '1.4.2', '1.4.2', '1.4.2']);
});

test('an unknown argument fails without changing any file', (t) => {
  const { dir } = fixture(t);
  for (const args of [['--chek'], ['minor', '--check'], ['1.5.0']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /^usage: node scripts\/version\.mjs \[patch\|minor\|major\] \| --check\nunknown argument: /);
  }
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

test('--check skips the comparison without origin/main, and on main', (t) => {
  const { dir, git } = fixture(t);
  write(dir, SKILL, '# Demo, changed\n');
  git('switch', '-q', 'main');
  assert.match(run(dir, '--check').stdout, /^ok: version 1\.4\.2 in all 5 places; bump check skipped: on main\n$/);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  git('switch', '-q', 'feature');
  const result = run(dir, '--check');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /bump check skipped: no origin\/main to compare with\n$/);
});

test('--check needs no bump for changes outside the plugin', (t) => {
  const { dir, commit } = fixture(t);
  write(dir, 'docs/guide.md', '# Guide\n');
  write(dir, 'test/demo.test.mjs', '// a test\n');
  write(dir, 'README.md', '# Readme\n');
  commit('docs and tests');
  const result = run(dir, '--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing under plugins\/aidrian\/ changed since origin\/main\n$/);
});

test('--check fails on a plugin change, untracked, staged, or committed, until the version goes up', (t) => {
  const { dir, git, commit } = fixture(t);
  const fails = () => {
    const result = run(dir, '--check');
    assert.equal(result.status, 1);
    return result.stderr;
  };
  write(dir, 'plugins/aidrian/skills/new/SKILL.md', '# New\n');
  assert.equal(fails(), 'this branch changes plugins/aidrian/ (plugins/aidrian/skills/new/SKILL.md) but keeps version 1.4.2,'
    + " not above origin/main's 1.4.2: run npm run bump\n");
  git('add', '-A');
  fails();
  commit('new skill');
  fails();
  assert.equal(run(dir).status, 0);
  const result = run(dir, '--check');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /version 1\.4\.3 is above origin\/main's 1\.4\.2\n$/);
});

test('--check counts a file moved out of the plugin as a plugin change', (t) => {
  const { dir, git, commit } = fixture(t);
  mkdirSync(path.join(dir, 'docs'));
  git('mv', SKILL, 'docs/SKILL.md');
  commit('move the skill out');
  assert.match(run(dir, '--check').stderr, /^this branch changes plugins\/aidrian\/ \(plugins\/aidrian\/skills\/demo\/SKILL\.md\)/);
});

test('--check fails again when main reaches the branch\'s version, until the next bump', (t) => {
  const { dir, git, commit } = fixture(t);
  write(dir, SKILL, '# Demo, changed\n');
  assert.equal(run(dir).status, 0);
  commit('change and bump');
  assert.equal(run(dir, '--check').status, 0);
  // Another branch merged first, with the same bump.
  git('switch', '-q', 'main');
  setVersion('1.4.3', dir);
  commit('the other branch');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', 'feature');
  assert.match(run(dir, '--check').stderr, /\(3 files, plugins\/aidrian\/\.claude-plugin\/plugin\.json first\) but keeps version 1\.4\.3, not above origin\/main's 1\.4\.3/);
  assert.equal(run(dir).status, 0);
  assert.equal(run(dir, '--check').status, 0);
});
