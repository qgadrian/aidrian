import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agreementProblem, bumpVersion, levelFromSubjects, parseTitle, setVersion, versionLocations } from '../scripts/version.mjs';

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

test('parseTitle reads the type and the breaking mark of a Conventional Commit subject', () => {
  const cases = [
    ['fix: a typo', { type: 'fix', breaking: false }],
    ['feat(review): cite focus (#7)', { type: 'feat', breaking: false }],
    ['feat!: drop the old key', { type: 'feat', breaking: true }],
    ['refactor(lib)!: rename the export', { type: 'refactor', breaking: true }],
    ['chore(release): aidrian v0.19.0', { type: 'chore', breaking: false }],
    ['Update README', null],
    ['fix:no space', null],
    ['fix: ', null],
    ['feat(scope: unclosed', null],
    ['', null],
    [undefined, null],
  ];
  for (const [subject, expected] of cases) assert.deepEqual(parseTitle(subject), expected, JSON.stringify(subject));
});

test('levelFromSubjects takes the highest level, and keeps a 0.x version below 1.0.0', () => {
  const cases = [
    [[], '1.4.2', 'patch'],
    [['fix: a', 'docs: b'], '1.4.2', 'patch'],
    [['fix: a', 'feat(x): b', 'chore: c'], '1.4.2', 'minor'],
    [['feat: a', 'fix(x)!: b'], '1.4.2', 'major'],
    [['fix(x)!: b'], '0.18.3', 'minor'],
    [['feat!: b', 'feat: c'], '0.18.3', 'minor'],
    [['Merge branch main', 'whatever'], '1.4.2', 'patch'],
    [['Feat: capitalised is another type'], '1.4.2', 'patch'],
  ];
  for (const [subjects, version, level] of cases) assert.equal(levelFromSubjects(subjects, version), level, `${subjects} at ${version}`);
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
    assert.match(result.stderr, /^the version is not the same everywhere; .* \(main's, when you resolve a merge\):\n/, args[0]);
    assert.match(result.stderr, /\n {2}plugins\/aidrian\/plugin\.json: version: "1\.4\.3"\n/, args[0]);
  }
  assert.deepEqual(versions(dir), ['1.4.2', '1.4.3', '1.4.2', '1.4.2', '1.4.2']);
});

test('an unknown argument fails without changing any file', (t) => {
  const { dir } = fixture(t);
  for (const args of [['--chek'], ['minor', '--check'], ['1.5.0']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /^usage: node scripts\/version\.mjs \[patch\|minor\|major\] \| --check \| lint-title .*\nunknown argument: /);
  }
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

test('--check skips the comparison without origin/main, and on main', (t) => {
  const { dir, git } = fixture(t);
  git('switch', '-q', 'main');
  setVersion('1.4.3', dir);
  assert.match(run(dir, '--check').stdout, /^ok: version 1\.4\.3 in all 5 places; branch check skipped: on main\n$/);
  git('update-ref', '-d', 'refs/remotes/origin/main');
  git('switch', '-q', 'feature');
  const result = run(dir, '--check');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /branch check skipped: no origin\/main to compare with\n$/);
});

test('--check passes a plugin change that keeps the version, even after main released a higher one', (t) => {
  const { dir, git, commit } = fixture(t);
  write(dir, SKILL, '# Demo, changed\n');
  write(dir, 'plugins/aidrian/skills/new/SKILL.md', '# New\n');
  const untracked = run(dir, '--check');
  assert.equal(untracked.status, 0, untracked.stderr);
  assert.match(untracked.stdout, /^ok: version 1\.4\.2 in all 5 places; the branch keeps the version of its merge base with origin\/main\n$/);
  commit('change the plugin');
  // Main released while the branch was open.
  git('switch', '-q', 'main');
  setVersion('1.5.0', dir);
  commit('chore(release): aidrian v1.5.0');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('switch', '-q', 'feature');
  assert.equal(run(dir, '--check').status, 0);
  // Merging main brings its version with it.
  git('merge', '-q', '--no-edit', 'main');
  const merged = run(dir, '--check');
  assert.equal(merged.status, 0, merged.stderr);
  assert.match(merged.stdout, /^ok: version 1\.5\.0 in all 5 places/);
});

test('--check fails a branch that changes the version, untracked, staged, or committed', (t) => {
  const { dir, git, commit } = fixture(t);
  const fails = () => {
    const result = run(dir, '--check');
    assert.equal(result.status, 1);
    return result.stderr;
  };
  assert.equal(run(dir, 'minor').status, 0, 'npm run bump still works for a local trial');
  const message = fails();
  assert.match(message, /^this branch changes the plugin version, and a pull request never does: the release workflow raises it on main/);
  assert.match(message, /Take main's version: set every place back to "1\.4\.2", the version at the merge base with origin\/main/);
  assert.match(message, /\n {2}plugins\/aidrian\/\.claude-plugin\/plugin\.json: version: "1\.4\.2" -> "1\.5\.0"\n/);
  assert.match(message, /\n {2}package-lock\.json: packages\.""\.version: "1\.4\.2" -> "1\.5\.0"\n$/);
  git('add', '-A');
  fails();
  commit('bump');
  fails();
  setVersion('1.4.2', dir);
  assert.equal(run(dir, '--check').status, 0, 'setting it back passes');
});

test('--check fails a branch that adds a version to a marketplace entry', (t) => {
  const { dir } = fixture(t);
  const file = path.join(dir, '.agents/plugins/marketplace.json');
  const market = JSON.parse(readFileSync(file, 'utf8'));
  market.plugins[0].version = '1.4.2';
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  assert.match(run(dir, '--check').stderr, /\n {2}\.agents\/plugins\/marketplace\.json: plugins\.0\.version: undefined -> "1\.4\.2"\n$/);
});

test('lint-title passes a Conventional Commit title and fails any other', (t) => {
  const { dir } = fixture(t);
  const ok = run(dir, 'lint-title', 'feat(review)!: cite focus');
  assert.equal(ok.status, 0, ok.stderr);
  const bad = run(dir, 'lint-title', 'Update the review skill');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /^the pull request title "Update the review skill" is not a Conventional Commit subject/);
  assert.equal(run(dir, 'lint-title').status, 1, 'the title is required');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

// The fixture's main, tagged v1.4.2 as the release workflow would have, and checked out.
function released(t) {
  const repo = fixture(t);
  repo.git('switch', '-q', 'main');
  repo.git('tag', 'v1.4.2');
  return repo;
}

test('release changes nothing when no commit since the tag changes the plugin', (t) => {
  const { dir, commit } = released(t);
  write(dir, 'docs/guide.md', '# Guide\n');
  commit('feat(docs): a guide');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'no commit since v1.4.2 changes plugins/aidrian/: nothing to release\n');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

test('release picks the level from the plugin commits since the tag, and prints the version last', (t) => {
  const { dir, git, commit } = released(t);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix (#20)');
  write(dir, 'docs/guide.md', '# Guide\n');
  commit('feat(docs): a guide that ships to no one');
  let result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'version 1.4.2 -> 1.4.3, for 1 plugin commit(s):\n  fix(demo): a fix (#20)\nversion=1.4.3\n');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.3'));
  commit('chore(release): aidrian v1.4.3');
  git('tag', 'v1.4.3');
  write(dir, 'plugins/aidrian/skills/new/SKILL.md', '# New\n');
  commit('feat(new): a skill');
  write(dir, SKILL, '# Demo, fixed again\n');
  commit('fix(demo): another fix');
  result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\nversion=1\.5\.0\n$/);
  assert.deepEqual(versions(dir), Array(5).fill('1.5.0'));
});

test('release --level overrides the subjects, and releases with no plugin commit', (t) => {
  const { dir } = released(t);
  const result = run(dir, 'release', '--level', 'major');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^version 1\.4\.2 -> 2\.0\.0, for --level major:\nversion=2\.0\.0\n$/);
  assert.deepEqual(versions(dir), Array(5).fill('2.0.0'));
  for (const args of [['--level'], ['--level', 'huge'], ['major']]) {
    const bad = run(dir, 'release', ...args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.match(bad.stderr, /^usage: /);
  }
});

test('release skips its own commits when it counts', (t) => {
  const { dir, commit } = released(t);
  write(dir, SKILL, '# Demo, changed\n');
  commit('chore(release)!: not a real release subject');
  assert.match(run(dir, 'release').stdout, /^no commit since v1\.4\.2/);
});

test('release fails without a v* tag, or when the latest tag is not the version in the files', (t) => {
  const { dir, git, commit } = fixture(t);
  git('switch', '-q', 'main');
  write(dir, SKILL, '# Demo, changed\n');
  commit('fix(demo): a fix');
  let result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^no v\* tag is reachable from HEAD, .* git tag v1\.4\.2 <commit> && git push origin v1\.4\.2\n$/);
  git('tag', 'v1.3.0', 'HEAD~1');
  result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^the latest tag reachable from HEAD is v1\.3\.0, but the files hold 1\.4\.2\. Tag the commit that set 1\.4\.2 as v1\.4\.2/);
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});
