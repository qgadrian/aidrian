import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agreementProblem, bumpVersion, levelFromSubjects, parseTitle, PLUGINS, resultsProblem, setVersion, versionLocations } from '../scripts/version.mjs';

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

// The release workflow's identity, and no signing, so commit-and-tag commits and tags in the scratch repository.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false', GIT_CONFIG_KEY_1: 'tag.gpgsign', GIT_CONFIG_VALUE_1: 'false',
};
const run = (dir, ...args) => spawnSync(process.execPath, [path.join(dir, 'scripts/version.mjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
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
    assert.match(result.stderr, /^(?:aidrian: )?the version is not the same everywhere; .* \(main's, when you resolve a merge\):\n/, args[0]);
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
  assert.match(run(dir, '--check').stdout, /^ok: aidrian version 1\.4\.3 in all 5 places; branch check skipped: on main\n$/);
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
  assert.match(untracked.stdout, /^ok: aidrian version 1\.4\.2 in all 5 places; the branch keeps the version of its merge base with origin\/main\n$/);
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
  assert.match(merged.stdout, /^ok: aidrian version 1\.5\.0 in all 5 places/);
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
  assert.match(message, /^this branch changes the aidrian version, and a pull request never does: the release workflow raises it on main/);
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
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'aidrian: no commit since v1.4.2 changes plugins/aidrian/: nothing to release\n');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

test('release picks the level from the plugin commits since the tag, and prints a result line', (t) => {
  const { dir, git, commit } = released(t);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix (#20)');
  write(dir, 'docs/guide.md', '# Guide\n');
  commit('feat(docs): a guide that ships to no one');
  let result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  assert.equal(result.stderr, 'aidrian 1.4.2 -> 1.4.3, for 1 plugin commit(s):\n  fix(demo): a fix (#20)\n');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.3'));
  commit('chore(release): aidrian v1.4.3');
  git('tag', 'v1.4.3');
  write(dir, 'plugins/aidrian/skills/new/SKILL.md', '# New\n');
  commit('feat(new): a skill');
  write(dir, SKILL, '# Demo, fixed again\n');
  commit('fix(demo): another fix');
  result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.5.0 v1.5.0 v1.4.3\n');
  assert.deepEqual(versions(dir), Array(5).fill('1.5.0'));
});

test('release --level overrides the subjects, and releases with no plugin commit', (t) => {
  const { dir } = released(t);
  const result = run(dir, 'release', '--level', 'major');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=2.0.0 v2.0.0 v1.4.2\n');
  assert.equal(result.stderr, 'aidrian 1.4.2 -> 2.0.0, for --level major:\n');
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
  assert.match(run(dir, 'release').stderr, /^aidrian: no commit since v1\.4\.2/);
});

test('release refuses a first release after a later plugin commit, and fails when the latest tag is not the version in the files', (t) => {
  const { dir, git, commit } = fixture(t);
  git('switch', '-q', 'main');
  write(dir, SKILL, '# Demo, changed\n');
  commit('fix(demo): a fix');
  let result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^aidrian: its first release is refused\. 1 commit\(s\) after [0-9a-f]{40}, .* git tag -a v1\.4\.2 [0-9a-f]{40} -m "aidrian v1\.4\.2" && git push origin refs\/tags\/v1\.4\.2\n$/);
  assert.equal(run(dir, 'tag-check').status, 1);
  git('tag', 'v1.3.0', 'HEAD~1');
  result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aidrian: the latest tag reachable from HEAD is v1\.3\.0, but the files hold 1\.4\.2\. Tag the commit that set 1\.4\.2 as v1\.4\.2/);
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'));
});

const COCKPIT = 'plugins/aidrian-cockpit/.claude-plugin/plugin.json';
const COCKPIT_FILE = 'plugins/aidrian-cockpit/lib/demo.mjs';
const cockpitVersion = (dir) => JSON.parse(readFileSync(path.join(dir, COCKPIT), 'utf8')).version;
const status = (git) => git('status', '--porcelain', '--untracked-files=all');
const tagsAt = (git, ref) => git('tag', '--points-at', ref).split('\n').filter(Boolean).sort();

// The released fixture with the cockpit's manifest at `version` committed on main; tagged when `tag` is true.
function withCockpit(t, { version = '0.1.0', tag = true } = {}) {
  const repo = released(t);
  write(repo.dir, COCKPIT, `${JSON.stringify({ name: 'aidrian-cockpit', version }, null, 2)}\n`);
  repo.commit('feat(cockpit): add the cockpit');
  if (tag) repo.git('tag', `aidrian-cockpit-v${version}`);
  return repo;
}

test('the PLUGINS table keeps aidrian on v* tags and its four files, and the tag patterns never cross', (t) => {
  assert.deepEqual(PLUGINS.map(({ name, dir, prefix }) => [name, dir, prefix]), [
    ['aidrian', 'plugins/aidrian', 'v'],
    ['aidrian-cockpit', 'plugins/aidrian-cockpit', 'aidrian-cockpit-v'],
  ]);
  assert.deepEqual(PLUGINS[0].files.map(([file]) => file), ['plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json', 'package.json', 'package-lock.json']);
  const { git } = withCockpit(t);
  git('tag', 'v0.65.0');
  assert.deepEqual(git('tag', '--list', 'v[0-9]*').split('\n').filter(Boolean).sort(), ['v0.65.0', 'v1.4.2']);
  assert.deepEqual(git('tag', '--list', 'aidrian-cockpit-v[0-9]*').split('\n').filter(Boolean), ['aidrian-cockpit-v0.1.0']);
});

test('--check and release skip a table plugin with no folder, and a folder without its manifest fails', (t) => {
  const { dir, commit } = released(t);
  assert.equal(run(dir, '--check').stdout.split('\n').filter(Boolean).length, 1, 'only aidrian is checked');
  write(dir, COCKPIT_FILE, 'export {};\n');
  commit('feat(cockpit): a folder with no manifest');
  for (const args of [['--check'], ['release']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /cannot read plugins\/aidrian-cockpit\/\.claude-plugin\/plugin\.json/, args[0]);
    if (args[0] === 'release') assert.equal(result.stdout, '', 'no result line');
  }
});

test('--check treats a plugin new on the branch as new, then holds its version like any other', (t) => {
  const { dir, git, commit } = fixture(t);
  write(dir, COCKPIT, `${JSON.stringify({ name: 'aidrian-cockpit', version: '0.1.0' }, null, 2)}\n`);
  const fresh = run(dir, '--check');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /\nok: aidrian-cockpit version 0\.1\.0 in all 1 places; the plugin is new on this branch/);
  commit('feat(cockpit): add');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(dir, COCKPIT, `${JSON.stringify({ name: 'aidrian-cockpit', version: '0.2.0' }, null, 2)}\n`);
  const changed = run(dir, '--check');
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /^this branch changes the aidrian-cockpit version/);
});

test('a marketplace entry counts for the plugin its name matches, and a versioned entry with an unknown name fails --check', (t) => {
  const { dir } = withCockpit(t);
  const file = path.join(dir, '.claude-plugin/marketplace.json');
  const market = JSON.parse(readFileSync(file, 'utf8'));
  market.plugins.push({ name: 'aidrian-cockpit', source: './plugins/aidrian-cockpit', version: '0.1.0' });
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  assert.deepEqual(versionLocations(dir, PLUGINS[1]).map(({ where }) => where), [`${COCKPIT}: version`, '.claude-plugin/marketplace.json: plugins.1.version']);
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), "the cockpit's entry is not aidrian's");
  market.plugins.push({ name: 'stranger', source: './plugins/stranger', version: '1.0.0' });
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^a marketplace entry sets a version, but its name is no plugin in PLUGINS .*\n {2}\.claude-plugin\/marketplace\.json: plugins\.2 \("stranger"\)\n$/);
});

test('release raises each plugin from its own tag, and commit-and-tag makes one commit of version files and a tag each', (t) => {
  const { dir, git, commit } = withCockpit(t);
  write(dir, COCKPIT_FILE, 'export {};\n');
  commit('fix(cockpit): a fix');
  write(dir, SKILL, '# Demo, new\n');
  commit('feat(demo): a feature');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.5.0 v1.5.0 v1.4.2\naidrian-cockpit=0.1.1 aidrian-cockpit-v0.1.1 aidrian-cockpit-v0.1.0\n');
  assert.equal(resultsProblem(result.stdout), null);
  const done = run(dir, 'commit-and-tag', 'aidrian', 'aidrian-cockpit');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('log', '-1', '--format=%s'), 'chore(release): aidrian v1.5.0, aidrian-cockpit v0.1.1\n');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), [COCKPIT, 'package-lock.json', 'package.json', 'plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json'].sort());
  assert.deepEqual(tagsAt(git, 'HEAD'), ['aidrian-cockpit-v0.1.1', 'v1.5.0']);
  assert.equal(git('cat-file', '-t', 'v1.5.0'), 'tag\n', 'annotated');
  assert.equal(status(git), '');
  const again = run(dir, 'commit-and-tag', 'aidrian');
  assert.equal(again.status, 1, 'a tag never moves');
  assert.match(again.stderr, /the tag v1\.5\.0 exists/);
});

test('a commit subject never reaches a result line', (t) => {
  const { dir, commit } = withCockpit(t);
  write(dir, COCKPIT_FILE, 'export {};\n');
  commit('aidrian=9.9.9 v9.9.9 -');
  write(dir, COCKPIT_FILE, 'export const a = 1;\n');
  commit('aidrian-cockpit=9.9.9 aidrian-cockpit-v9.9.9 -');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian-cockpit=0.1.1 aidrian-cockpit-v0.1.1 aidrian-cockpit-v0.1.0\n');
});

test('release --level reaches aidrian alone; another plugin releases at its own level, or not at all', (t) => {
  const { dir, commit } = withCockpit(t);
  let result = run(dir, 'release', '--level', 'major');
  assert.equal(result.stdout, 'aidrian=2.0.0 v2.0.0 v1.4.2\n', 'a cockpit with no commit waiting keeps its version');
  assert.equal(cockpitVersion(dir), '0.1.0');
  setVersion('1.4.2', dir);
  write(dir, COCKPIT_FILE, 'export {};\n');
  commit('fix(cockpit): a fix');
  result = run(dir, 'release', '--level', 'major');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=2.0.0 v2.0.0 v1.4.2\naidrian-cockpit=0.1.1 aidrian-cockpit-v0.1.1 aidrian-cockpit-v0.1.0\n');
  assert.equal(run(dir, 'patch').status, 0);
  assert.equal(cockpitVersion(dir), '0.1.1', 'the bare bump acts on aidrian alone');
});

test("a plugin's first release tags its manifest's commit with no bump, and makes no commit", (t) => {
  const { dir, git } = withCockpit(t, { tag: false });
  const added = git('rev-parse', 'HEAD').trim();
  assert.equal(run(dir, 'tag-check').status, 1);
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian-cockpit=0.1.0 aidrian-cockpit-v0.1.0 -\n');
  assert.equal(status(git), '', 'a first release changes no file');
  const done = run(dir, 'commit-and-tag', 'aidrian-cockpit');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('rev-parse', 'HEAD').trim(), added, 'no commit');
  assert.deepEqual(tagsAt(git, added), ['aidrian-cockpit-v0.1.0']);
  assert.equal(run(dir, 'tag-check').status, 0);
});

test('a refused first release lets the other plugins release, and tag-check fails the run', (t) => {
  const { dir, commit } = withCockpit(t, { tag: false });
  write(dir, COCKPIT_FILE, 'export {};\n');
  commit('fix(cockpit): after the manifest');
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  assert.match(result.stderr, /^aidrian-cockpit: its first release is refused\. .*git tag -a aidrian-cockpit-v0\.1\.0 [0-9a-f]{40} -m "aidrian-cockpit v0\.1\.0" && git push origin refs\/tags\/aidrian-cockpit-v0\.1\.0$/m);
  assert.equal(cockpitVersion(dir), '0.1.0');
  const check = run(dir, 'tag-check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /aidrian-cockpit$/m);
});

test('release is all or nothing: an unreachable or disagreeing tag fails with no result and no file changed', (t) => {
  const { dir, git, commit } = withCockpit(t, { tag: false });
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  git('switch', '-q', '-c', 'side');
  write(dir, 'side.md', 'x\n');
  commit('side');
  git('tag', 'aidrian-cockpit-v0.1.0');
  git('switch', '-q', 'main');
  let result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aidrian-cockpit: a aidrian-cockpit-v\[0-9\]\* tag exists, but none is reachable from HEAD/);
  assert.equal(result.stdout, '');
  git('tag', '-d', 'aidrian-cockpit-v0.1.0');
  git('tag', 'aidrian-cockpit-v0.0.9');
  result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aidrian-cockpit: the latest tag reachable from HEAD is aidrian-cockpit-v0\.0\.9, but the files hold 0\.1\.0/);
  assert.equal(result.stdout, '');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), "aidrian's waiting fix wrote nothing");
  assert.equal(status(git), '');
});

test('commit-and-tag refuses a stray change, an unknown name, and a repeated one, with no commit and no tag', (t) => {
  const { dir, git, commit } = withCockpit(t);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  assert.equal(run(dir, 'release').status, 0);
  const head = git('rev-parse', 'HEAD');
  write(dir, 'docs/stray.md', 'x\n');
  let result = run(dir, 'commit-and-tag', 'aidrian');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paths other than the released plugins' version files changed:\n {2}docs\/stray\.md$/m);
  rmSync(path.join(dir, 'docs/stray.md'));
  for (const names of [['stranger'], ['aidrian', 'aidrian'], []]) {
    result = run(dir, 'commit-and-tag', ...names);
    assert.equal(result.status, 1, names.join(' '));
  }
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('tag', '--list', 'v1.4.3'), '');
});

test('check-results passes only well-formed result lines of PLUGINS names', (t) => {
  const { dir } = fixture(t);
  for (const good of ['', 'aidrian=1.4.3 v1.4.3 v1.4.2\n', 'aidrian=1.4.3 v1.4.3 v1.4.2\naidrian-cockpit=0.1.0 aidrian-cockpit-v0.1.0 -\n']) {
    assert.equal(resultsProblem(good), null, good);
  }
  for (const bad of [
    'version=1.4.3\n', 'aidrian=1.4.3 v1.4.3 v1.4.2\nnoise\n', 'stranger=1.0.0 v1.0.0 -\n', 'aidrian=01.4.3 v01.4.3 -\n',
    'aidrian=1.4.3 aidrian-cockpit-v1.4.3 -\n', 'aidrian-cockpit=0.1.0 v0.1.0 -\n', 'aidrian=1.4.3 v1.4.3 aidrian-cockpit-v0.1.0\n',
    'aidrian=1.4.3 v1.4.3 -\naidrian=1.4.4 v1.4.4 -\n', 'aidrian=1.4.3 v1.4.3 - x\n', 'aidrian=1.4.3 v1.4.3 $(id)\n',
  ]) {
    assert.match(resultsProblem(bad), /^not a result line: /, bad);
  }
  write(dir, 'out.txt', 'aidrian=1.4.3 v1.4.3 v1.4.2\nversion=1.4.3\n');
  assert.equal(run(dir, 'check-results', 'out.txt').status, 1);
});

// The steps of each job in .github/workflows/release.yml, read as YAML.
async function releaseWorkflow() {
  const { parse } = await import('yaml');
  return parse(readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8'));
}

test('release.yml keeps the token in a job that runs only scripts/version.mjs, and every value out of run: bodies', async () => {
  const workflow = await releaseWorkflow();
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  const jobs = Object.entries(workflow.jobs);
  const writers = jobs.filter(([, job]) => job.permissions?.contents === 'write');
  assert.equal(writers.length, 1, 'one job holds the write token');
  for (const [name, job] of jobs) {
    for (const step of job.steps) {
      const label = `${name}: ${step.name}`;
      const body = step.run ?? '';
      assert.doesNotMatch(body, /\$\{\{/u, `${label}: no expression inside a run: body`);
      assert.doesNotMatch(body, /git commit[^\n]* -a|git commit[^\n]* -am|git add[^\n]* -A|--tags\b|--follow-tags|--force|\s-f\b/u, label);
      for (const line of body.split('\n').filter((each) => /gh release create/u.test(each))) assert.match(line, /--verify-tag/u, label);
      if (/version\.mjs release[^\n]*\|/u.test(body)) assert.match(body, /set -o pipefail/u, `${label}: a piped release needs pipefail`);
      if (/actions\/checkout@/u.test(step.uses ?? '')) assert.equal(step.with?.['persist-credentials'], false, `${label}: persist-credentials: false`);
    }
  }
  const [writerName, writer] = writers[0];
  const pushAt = writer.steps.findIndex((step) => /git[^\n]*push --atomic origin/u.test(step.run ?? ''));
  assert.ok(pushAt > 0, 'the token job pushes');
  for (const step of writer.steps) {
    const label = `${writerName}: ${step.name}`;
    assert.doesNotMatch(step.run ?? '', /\bnpm\b|\bnpx\b|node --test/u, label);
    assert.doesNotMatch(step.uses ?? '', /actions\/cache/u, label);
    assert.equal(step.with?.cache, undefined, `${label}: no cache`);
    for (const node of (step.run ?? '').matchAll(/\bnode\s+(\S+)/gu)) assert.equal(node[1], 'scripts/version.mjs', label);
  }
  for (const step of writer.steps.slice(0, pushAt)) {
    const label = `${writerName}: ${step.name}`;
    if (step.uses) assert.match(step.uses, /^actions\/(?:checkout|setup-node)@/u, label);
    else assert.match(step.run, /node scripts\/version\.mjs/u, label);
    assert.equal(JSON.stringify(step.env ?? {}).includes('github.token'), false, `${label}: no token before the push`);
  }
  const tokenSteps = writer.steps.filter((step) => JSON.stringify(step.env ?? {}).includes('github.token')).map((step) => step.name);
  assert.equal(tokenSteps.length, 2, `only the push and the release notes get the token: ${tokenSteps}`);
  assert.match(writer.steps.at(-1).run, /^node scripts\/version\.mjs tag-check$/mu, 'tag-check runs last');
});
