import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agreementProblem, bumpVersion, levelFromSubjects, parseTitle, PLUGINS, resultsProblem, setVersion, tagPattern, versionLocations } from '../scripts/version.mjs';

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

const CLAUDE_MOD = 'plugins/aidrian-claude-mod/.claude-plugin/plugin.json';
const CLAUDE_MOD_FILE = 'plugins/aidrian-claude-mod/lib/demo.mjs';
const claudeModVersion = (dir) => JSON.parse(readFileSync(path.join(dir, CLAUDE_MOD), 'utf8')).version;
const status = (git) => git('status', '--porcelain', '--untracked-files=all');
const tagsAt = (git, ref) => git('tag', '--points-at', ref).split('\n').filter(Boolean).sort();

// The released fixture with the Claude mod's manifest at `version` committed on main; tagged when `tag` is true.
function withClaudeMod(t, { version = '0.1.0', tag = true } = {}) {
  const repo = released(t);
  write(repo.dir, CLAUDE_MOD, `${JSON.stringify({ name: 'aidrian-claude-mod', version }, null, 2)}\n`);
  repo.commit('feat(claude-mod): add the Claude mod');
  if (tag) repo.git('tag', `aidrian-claude-mod-v${version}`);
  return repo;
}

test('the PLUGINS table keeps aidrian on v* tags and its four files, and the tag patterns never cross', (t) => {
  assert.deepEqual(PLUGINS.map(({ name, dir, prefix }) => [name, dir, prefix]), [
    ['aidrian', 'plugins/aidrian', 'v'],
    ['aidrian-claude-mod', 'plugins/aidrian-claude-mod', 'aidrian-claude-mod-v'],
  ]);
  assert.deepEqual(PLUGINS[0].files.map(([file]) => file), ['plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json', 'package.json', 'package-lock.json']);
  const { dir, git, commit } = withClaudeMod(t);
  git('tag', 'v0.65.0');
  const [aidrian, claudeMod] = PLUGINS.map(tagPattern);
  assert.deepEqual(git('tag', '--list', aidrian).split('\n').filter(Boolean).sort(), ['v0.65.0', 'v1.4.2']);
  assert.deepEqual(git('tag', '--list', claudeMod).split('\n').filter(Boolean), ['aidrian-claude-mod-v0.1.0']);
  git('tag', '-d', 'v0.65.0');
  // aidrian releases after the Claude mod's tag, so the newest tag is a v tag: the Claude mod still counts from its own.
  setVersion('1.5.0', dir);
  commit('chore(release): aidrian v1.5.0');
  git('tag', 'v1.5.0');
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('fix(claude-mod): a fix');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian-claude-mod=0.1.1 aidrian-claude-mod-v0.1.1 aidrian-claude-mod-v0.1.0\n');
});

test('--check and release skip a table plugin with no folder, and a folder without its manifest fails', (t) => {
  const { dir, commit } = released(t);
  assert.equal(run(dir, '--check').stdout.split('\n').filter(Boolean).length, 1, 'only aidrian is checked');
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('feat(claude-mod): a folder with no manifest');
  for (const args of [['--check'], ['release']]) {
    const result = run(dir, ...args);
    assert.equal(result.status, 1, args[0]);
    assert.match(result.stderr, /cannot read plugins\/aidrian-claude-mod\/\.claude-plugin\/plugin\.json/, args[0]);
    if (args[0] === 'release') assert.equal(result.stdout, '', 'no result line');
  }
});

test('--check treats a plugin new on the branch as new, then holds its version like any other', (t) => {
  const { dir, git, commit } = fixture(t);
  write(dir, CLAUDE_MOD, `${JSON.stringify({ name: 'aidrian-claude-mod', version: '0.1.0' }, null, 2)}\n`);
  const fresh = run(dir, '--check');
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.stdout, /\nok: aidrian-claude-mod version 0\.1\.0 in all 1 places; the plugin is new on this branch/);
  commit('feat(claude-mod): add');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  write(dir, CLAUDE_MOD, `${JSON.stringify({ name: 'aidrian-claude-mod', version: '0.2.0' }, null, 2)}\n`);
  const changed = run(dir, '--check');
  assert.equal(changed.status, 1);
  assert.match(changed.stderr, /^this branch changes the aidrian-claude-mod version/);
});

test('a marketplace entry counts for the plugin its name matches, and a versioned entry with an unknown name fails --check', (t) => {
  const { dir } = withClaudeMod(t);
  const file = path.join(dir, '.claude-plugin/marketplace.json');
  const market = JSON.parse(readFileSync(file, 'utf8'));
  market.plugins.push({ name: 'aidrian-claude-mod', source: './plugins/aidrian-claude-mod', version: '0.1.0' });
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  assert.deepEqual(versionLocations(dir, PLUGINS[1]).map(({ where }) => where), [`${CLAUDE_MOD}: version`, '.claude-plugin/marketplace.json: plugins.1.version']);
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), "the Claude mod's entry is not aidrian's");
  market.plugins.push({ name: 'stranger', source: './plugins/stranger', version: '1.0.0' });
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  const result = run(dir, '--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^a marketplace entry sets a version, but its name is no plugin in PLUGINS .*\n {2}\.claude-plugin\/marketplace\.json: plugins\.2 \("stranger"\)\n$/);
});

test('release raises each plugin from its own tag, and commit-and-tag makes one commit of version files and a tag each', (t) => {
  const { dir, git, commit } = withClaudeMod(t);
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('fix(claude-mod): a fix');
  write(dir, SKILL, '# Demo, new\n');
  commit('feat(demo): a feature');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.5.0 v1.5.0 v1.4.2\naidrian-claude-mod=0.1.1 aidrian-claude-mod-v0.1.1 aidrian-claude-mod-v0.1.0\n');
  assert.equal(resultsProblem(result.stdout), null);
  const done = run(dir, 'commit-and-tag', 'aidrian', 'aidrian-claude-mod');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('log', '-1', '--format=%s'), 'chore(release): aidrian v1.5.0, aidrian-claude-mod v0.1.1\n');
  assert.deepEqual(git('show', '--name-only', '--format=', 'HEAD').split('\n').filter(Boolean).sort(), [CLAUDE_MOD, 'package-lock.json', 'package.json', 'plugins/aidrian/.claude-plugin/plugin.json', 'plugins/aidrian/plugin.json'].sort());
  assert.deepEqual(tagsAt(git, 'HEAD'), ['aidrian-claude-mod-v0.1.1', 'v1.5.0']);
  assert.equal(git('cat-file', '-t', 'v1.5.0'), 'tag\n', 'annotated');
  assert.equal(status(git), '');
  const again = run(dir, 'commit-and-tag', 'aidrian');
  assert.equal(again.status, 1, 'a tag never moves');
  assert.match(again.stderr, /the tag v1\.5\.0 exists/);
});

test('a commit subject never reaches a result line', (t) => {
  const { dir, commit } = withClaudeMod(t);
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('aidrian=9.9.9 v9.9.9 -');
  write(dir, CLAUDE_MOD_FILE, 'export const a = 1;\n');
  commit('aidrian-claude-mod=9.9.9 aidrian-claude-mod-v9.9.9 -');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian-claude-mod=0.1.1 aidrian-claude-mod-v0.1.1 aidrian-claude-mod-v0.1.0\n');
});

test('release --level reaches aidrian alone; another plugin releases at its own level, or not at all', (t) => {
  const { dir, commit } = withClaudeMod(t);
  let result = run(dir, 'release', '--level', 'major');
  assert.equal(result.stdout, 'aidrian=2.0.0 v2.0.0 v1.4.2\n', 'a Claude mod with no commit waiting keeps its version');
  assert.equal(claudeModVersion(dir), '0.1.0');
  setVersion('1.4.2', dir);
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('fix(claude-mod): a fix');
  result = run(dir, 'release', '--level', 'major');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=2.0.0 v2.0.0 v1.4.2\naidrian-claude-mod=0.1.1 aidrian-claude-mod-v0.1.1 aidrian-claude-mod-v0.1.0\n');
  assert.equal(run(dir, 'patch').status, 0);
  assert.equal(claudeModVersion(dir), '0.1.1', 'the bare bump acts on aidrian alone');
});

test("a plugin's first release tags its manifest's commit with no bump, and makes no commit", (t) => {
  const { dir, git } = withClaudeMod(t, { tag: false });
  const added = git('rev-parse', 'HEAD').trim();
  assert.equal(run(dir, 'tag-check').status, 1);
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -\n');
  assert.equal(status(git), '', 'a first release changes no file');
  const done = run(dir, 'commit-and-tag', 'aidrian-claude-mod');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('rev-parse', 'HEAD').trim(), added, 'no commit');
  assert.deepEqual(tagsAt(git, added), ['aidrian-claude-mod-v0.1.0']);
  assert.equal(run(dir, 'tag-check').status, 0);
});

test('a refused first release lets the other plugins release, and tag-check fails the run', (t) => {
  const { dir, commit } = withClaudeMod(t, { tag: false });
  write(dir, CLAUDE_MOD_FILE, 'export {};\n');
  commit('fix(claude-mod): after the manifest');
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  assert.match(result.stderr, /^aidrian-claude-mod: its first release is refused\. .*git tag -a aidrian-claude-mod-v0\.1\.0 [0-9a-f]{40} -m "aidrian-claude-mod v0\.1\.0" && git push origin refs\/tags\/aidrian-claude-mod-v0\.1\.0$/m);
  assert.equal(claudeModVersion(dir), '0.1.0');
  const check = run(dir, 'tag-check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /aidrian-claude-mod$/m);
});

test('release is all or nothing: an unreachable or disagreeing tag fails with no result and no file changed', (t) => {
  const { dir, git, commit } = withClaudeMod(t, { tag: false });
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  git('switch', '-q', '-c', 'side');
  write(dir, 'side.md', 'x\n');
  commit('side');
  git('tag', 'aidrian-claude-mod-v0.1.0');
  git('switch', '-q', 'main');
  let result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aidrian-claude-mod: a aidrian-claude-mod-v\[0-9\]\* tag exists, but none is reachable from HEAD/);
  assert.equal(result.stdout, '');
  git('tag', '-d', 'aidrian-claude-mod-v0.1.0');
  git('tag', 'aidrian-claude-mod-v0.0.9');
  result = run(dir, 'release');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^aidrian-claude-mod: the latest tag reachable from HEAD is aidrian-claude-mod-v0\.0\.9, but the files hold 0\.1\.0/);
  assert.equal(result.stdout, '');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), "aidrian's waiting fix wrote nothing");
  assert.equal(status(git), '');
});

test("commit-and-tag decides per version location, so a marketplace that versions both plugins takes one release and a first one", (t) => {
  const { dir, git, commit } = withClaudeMod(t, { tag: false });
  const file = path.join(dir, '.claude-plugin/marketplace.json');
  const market = JSON.parse(readFileSync(file, 'utf8'));
  market.plugins[0].version = '1.4.2';
  market.plugins.push({ name: 'aidrian-claude-mod', source: './plugins/aidrian-claude-mod', version: '0.1.0' });
  writeFileSync(file, `${JSON.stringify(market, null, 2)}\n`);
  commit('chore: version both plugins in the marketplace');
  const added = git('log', '--diff-filter=A', '--format=%H', '--', CLAUDE_MOD).trim();
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  const result = run(dir, 'release');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\naidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -\n');
  const before = git('rev-parse', 'HEAD').trim();
  const done = run(dir, 'commit-and-tag', 'aidrian', 'aidrian-claude-mod');
  assert.equal(done.status, 0, done.stderr);
  assert.equal(git('rev-parse', 'HEAD~1').trim(), before, 'one commit');
  assert.equal(git('log', '-1', '--format=%s'), 'chore(release): aidrian v1.4.3, aidrian-claude-mod v0.1.0\n', 'the subject names each released plugin');
  assert.ok(git('show', '--name-only', '--format=', 'HEAD').split('\n').includes('.claude-plugin/marketplace.json'), 'the shared file is staged once');
  assert.deepEqual(tagsAt(git, 'HEAD'), ['v1.4.3']);
  assert.deepEqual(tagsAt(git, added), ['aidrian-claude-mod-v0.1.0']);
  assert.equal(status(git), '');
});

test("a missing tag fails with the tag-by-hand message in a shallow clone, and when the manifest was added at another version", (t) => {
  const { dir, git, commit } = released(t);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  const clone = path.join(dir, '..', `${path.basename(dir)}-shallow`);
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', '--no-tags', '-b', 'main', `file://${dir}`, clone], { stdio: 'pipe' });
  let result = run(clone, 'release');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^aidrian: no v\[0-9\]\* tag is reachable from HEAD, and this clone is shallow, so there is nothing to count commits from\. Tag the commit that set 1\.4\.2 once, then push the tag: git tag v1\.4\.2 <commit> && git push origin v1\.4\.2\n$/);
  assert.equal(result.stdout, '');
  write(dir, CLAUDE_MOD, `${JSON.stringify({ name: 'aidrian-claude-mod', version: '0.0.0' }, null, 2)}\n`);
  commit('feat(claude-mod): add at 0.0.0');
  write(dir, CLAUDE_MOD, `${JSON.stringify({ name: 'aidrian-claude-mod', version: '0.1.0' }, null, 2)}\n`);
  commit('feat(claude-mod): raise to 0.1.0');
  result = run(dir, 'release');
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /^aidrian-claude-mod: no aidrian-claude-mod-v\[0-9\]\* tag is reachable from HEAD, and the commit that added .* holds 0\.0\.0, not 0\.1\.0, so there is nothing to count commits from\. Tag the commit that set 0\.1\.0 once/);
  assert.equal(result.stdout, '');
  assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), "aidrian's waiting fix wrote nothing");
});

test('commit-and-tag refuses a stray change, an unknown name, and a repeated one, with no commit and no tag', (t) => {
  const { dir, git, commit } = withClaudeMod(t);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  assert.equal(run(dir, 'release').status, 0);
  const head = git('rev-parse', 'HEAD');
  write(dir, 'docs/stray.md', 'x\n');
  let result = run(dir, 'commit-and-tag', 'aidrian');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /paths other than the released plugins' version files changed:\n {2}docs\/stray\.md$/m);
  rmSync(path.join(dir, 'docs/stray.md'));
  write(dir, SKILL, '# Demo, changed after the release\n');
  result = run(dir, 'commit-and-tag', 'aidrian');
  assert.equal(result.status, 1, 'a tracked file changed');
  assert.match(result.stderr, /paths other than the released plugins' version files changed:\n {2}plugins\/aidrian\/skills\/demo\/SKILL\.md$/m);
  git('checkout', '--', SKILL);
  for (const names of [['stranger'], ['aidrian', 'aidrian'], []]) {
    result = run(dir, 'commit-and-tag', ...names);
    assert.equal(result.status, 1, names.join(' '));
  }
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('tag', '--list', 'v1.4.3'), '');
});

test('release --expect fails before writing unless its result lines are those, and --level auto or empty reads the subjects', (t) => {
  const { dir } = released(t);
  write(dir, SKILL, '# Demo, fixed\n');
  execFileSync('git', ['-C', dir, ...IDENTITY, 'commit', '-qam', 'fix(demo): a fix']);
  for (const expect of ['aidrian=1.5.0 v1.5.0 v1.4.2\n', '', 'noise\n']) {
    const bad = run(dir, 'release', '--level', 'auto', '--expect', expect);
    assert.equal(bad.status, 1, JSON.stringify(expect));
    assert.equal(bad.stdout, '');
    assert.deepEqual(versions(dir), Array(5).fill('1.4.2'), `${JSON.stringify(expect)} wrote nothing`);
  }
  const good = run(dir, 'release', '--level', '', '--expect', 'aidrian=1.4.3 v1.4.3 v1.4.2');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  for (const args of [['--expect'], ['--level', 'auto', '--level', 'major'], ['--other', 'x']]) assert.match(run(dir, 'release', ...args).stderr, /^usage: /, args.join(' '));
});

test('commit-and-tag --results takes the plugins and their tags from result lines, and an empty block releases nothing', (t) => {
  const { dir, git, commit } = withClaudeMod(t);
  const head = git('rev-parse', 'HEAD');
  const none = run(dir, 'commit-and-tag', '--results', '');
  assert.equal(none.status, 0, none.stderr);
  assert.equal(git('rev-parse', 'HEAD'), head);
  write(dir, SKILL, '# Demo, fixed\n');
  commit('fix(demo): a fix');
  assert.equal(run(dir, 'release').stdout, 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  for (const results of ['aidrian=1.4.4 v1.4.4 v1.4.2', 'noise', 'aidrian=1.4.3 v1.4.3 v1.4.2\naidrian=1.4.3 v1.4.3 v1.4.2']) {
    const bad = run(dir, 'commit-and-tag', '--results', results);
    assert.equal(bad.status, 1, results);
  }
  assert.equal(git('tag', '--list', 'v1.4.*').split('\n').filter(Boolean).length, 1, 'no tag made');
  const done = run(dir, 'commit-and-tag', '--results', 'aidrian=1.4.3 v1.4.3 v1.4.2\n');
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(tagsAt(git, 'HEAD'), ['v1.4.3']);
});

test('check-results passes only well-formed result lines of PLUGINS names', (t) => {
  const { dir } = fixture(t);
  for (const good of ['', 'aidrian=1.4.3 v1.4.3 v1.4.2\n', 'aidrian=1.4.3 v1.4.3 v1.4.2\naidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -\n']) {
    assert.equal(resultsProblem(good), null, good);
  }
  for (const bad of [
    'version=1.4.3\n', 'aidrian=1.4.3 v1.4.3 v1.4.2\nnoise\n', 'stranger=1.0.0 v1.0.0 -\n', 'aidrian=01.4.3 v01.4.3 -\n',
    'aidrian=1.4.3 aidrian-claude-mod-v1.4.3 -\n', 'aidrian-claude-mod=0.1.0 v0.1.0 -\n', 'aidrian=1.4.3 v1.4.3 aidrian-claude-mod-v0.1.0\n',
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

const isCheckout = (step) => /^actions\/checkout@/u.test(step.uses ?? '');
const isSetupNode = (step) => /^actions\/setup-node@/u.test(step.uses ?? '');
const VERIFY = /git merge-base --is-ancestor "\$SHA" origin\/main/u;
// One call of the release script, whose every argument is a word or one double-quoted variable.
const VERSION_CALL = /^node scripts\/version\.mjs(?: (?:[a-z-]+|"\$[A-Z_]+"))+$/u;

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
      for (const line of body.split('\n').filter((each) => /\bnpm ci\b/u.test(each))) assert.match(line, /--ignore-scripts/u, `${label}: no install script runs`);
      if (isCheckout(step)) {
        assert.equal(step.with?.['persist-credentials'], false, `${label}: persist-credentials: false`);
        assert.equal(step.with?.['fetch-depth'], 0, `${label}: the whole history`);
        assert.equal(step.with?.['fetch-tags'], true, `${label}: every tag`);
      }
    }
  }
  const check = workflow.jobs.check;
  const outputsAt = check.steps.findIndex((step) => step.id === 'version');
  const installAt = check.steps.findIndex((step) => /\bnpm ci\b/u.test(step.run ?? ''));
  assert.ok(outputsAt > 0 && installAt > outputsAt, 'the check job writes its outputs before it installs');
  const [writerName, writer] = writers[0];
  const pushAt = writer.steps.findIndex((step) => /git[^\n]*push --atomic origin/u.test(step.run ?? ''));
  assert.ok(pushAt > 0, 'the token job pushes');
  assert.ok(isCheckout(writer.steps[0]), 'the token job checks out first');
  const verify = writer.steps[1];
  assert.match(verify.run ?? '', VERIFY, 'right after the checkout, the commit must be on main');
  assert.match(verify.run, /\^\[0-9a-f\]\{40\}\$/u, 'and a full sha');
  assert.equal(verify.env?.SHA, '${{ needs.check.outputs.sha }}');
  for (const step of writer.steps) {
    const label = `${writerName}: ${step.name}`;
    assert.doesNotMatch(step.run ?? '', /\bnpm\b|\bnpx\b|node --test/u, label);
    assert.doesNotMatch(step.uses ?? '', /actions\/cache/u, label);
    assert.equal(step.with?.cache, undefined, `${label}: no cache`);
    for (const node of (step.run ?? '').matchAll(/\bnode\s+(\S+)/gu)) assert.equal(node[1], 'scripts/version.mjs', label);
    if (isSetupNode(step)) {
      assert.equal(step.with?.['package-manager-cache'], false, `${label}: package-manager-cache: false`);
      assert.equal(step.with?.token, '', `${label}: no token for the action`);
    }
  }
  for (const step of writer.steps.slice(0, pushAt)) {
    const label = `${writerName}: ${step.name}`;
    if (step.uses) assert.ok(isCheckout(step) || isSetupNode(step), label);
    else if (step !== verify) assert.match(step.run.trim(), VERSION_CALL, `${label}: one call of scripts/version.mjs`);
    assert.equal(JSON.stringify(step.env ?? {}).includes('github.token'), false, `${label}: no token before the push`);
  }
  const tokenSteps = writer.steps.filter((step) => JSON.stringify(step.env ?? {}).includes('github.token')).map((step) => step.name);
  assert.equal(tokenSteps.length, 2, `only the push and the release notes get the token: ${tokenSteps}`);
  assert.match(writer.steps.at(-1).run, /^node scripts\/version\.mjs tag-check$/mu, 'tag-check runs last');
});

// A run: body of the token job, run as GitHub runs it, with `stubs` (name -> sh script) first on PATH, in a folder that
// is also $LOG. Returns spawnSync's result and `log`, that folder.
function runStep(t, body, { cwd, env = {}, stubs = {} }) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-step-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  for (const [name, script] of Object.entries(stubs)) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\n${script}\n`);
    chmodSync(path.join(bin, name), 0o755);
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', body], { cwd, encoding: 'utf8', env: { ...process.env, ...env, LOG: bin, PATH: `${bin}:${process.env.PATH}` } });
  return { ...result, log: bin };
}

const tokenStep = async (pattern) => (await releaseWorkflow()).jobs.release.steps.find((step) => pattern.test(step.run ?? '')).run;

test("the token job's first step fails unless the check job's commit is a full sha, checked out, and on main", async (t) => {
  const body = await tokenStep(VERIFY);
  const { dir, git, commit } = fixture(t);
  git('switch', '-q', 'main');
  const main = git('rev-parse', 'HEAD').trim();
  assert.equal(runStep(t, body, { cwd: dir, env: { SHA: main } }).status, 0, 'a commit on main');
  for (const sha of ['main', main.slice(0, 12), main.toUpperCase(), `${main}\nx`, '']) {
    assert.equal(runStep(t, body, { cwd: dir, env: { SHA: sha } }).status, 1, JSON.stringify(sha));
  }
  git('switch', '-q', 'feature');
  write(dir, SKILL, '# Demo, off main\n');
  commit('fix(demo): off main');
  const off = git('rev-parse', 'HEAD').trim();
  const result = runStep(t, body, { cwd: dir, env: { SHA: off } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the check job's commit is not on main/u);
  assert.equal(runStep(t, body, { cwd: dir, env: { SHA: main } }).status, 1, 'the checkout is another commit');
});

// A git that logs a push's arguments and its GIT_CONFIG_ pairs, and gives FAKE_HEAD for rev-parse.
const FAKE_GIT = 'if [ "$1" = rev-parse ]; then echo "$FAKE_HEAD"; exit 0; fi\nprintf \'%s\\n\' "$@" > "$LOG/git.args"\nenv | grep \'^GIT_CONFIG_\' | sort > "$LOG/git.env"';

test('the push step pushes the release commit and each tag of the result lines atomically, and runs no hook', async (t) => {
  const body = await tokenStep(/git[^\n]*push --atomic origin/u);
  const stubs = { git: FAKE_GIT, base64: 'cat > /dev/null; echo QUFB' };
  // The git arguments of the push, or null when it pushed nothing; HEAD at `head`, the check job's commit at b...b.
  const push = (results, head) => {
    const result = runStep(t, body, { cwd: tmpdir(), env: { RESULTS: results, BASE: 'b'.repeat(40), FAKE_HEAD: head, TOKEN: 'secret' }, stubs });
    assert.equal(result.status, 0, result.stderr);
    const args = path.join(result.log, 'git.args');
    return existsSync(args) ? { args: readFileSync(args, 'utf8').split('\n').filter(Boolean), config: readFileSync(path.join(result.log, 'git.env'), 'utf8') } : null;
  };
  const both = push('aidrian=1.4.3 v1.4.3 v1.4.2\naidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -', 'a'.repeat(40));
  assert.deepEqual(both.args, ['push', '--atomic', 'origin', 'HEAD:refs/heads/main', 'refs/tags/v1.4.3', 'refs/tags/aidrian-claude-mod-v0.1.0']);
  assert.match(both.config, /^GIT_CONFIG_COUNT=2$/mu);
  assert.match(both.config, /^GIT_CONFIG_KEY_1=core\.hooksPath$/mu);
  assert.match(both.config, /^GIT_CONFIG_VALUE_1=\/dev\/null$/mu);
  const first = push('aidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -', 'b'.repeat(40));
  assert.deepEqual(first.args, ['push', '--atomic', 'origin', 'refs/tags/aidrian-claude-mod-v0.1.0'], 'a first release alone pushes only its tag');
  assert.equal(push('', 'b'.repeat(40)), null, 'nothing released, nothing pushed');
});

test('the notes step publishes each tag from its previous one, and only aidrian as the latest release', async (t) => {
  const body = await tokenStep(/gh release create/u);
  const result = runStep(t, `${body}\ncat "$LOG/gh.calls"`, {
    cwd: tmpdir(),
    env: { RESULTS: 'aidrian=1.4.3 v1.4.3 v1.4.2\naidrian-claude-mod=0.1.0 aidrian-claude-mod-v0.1.0 -\n' },
    stubs: { gh: 'printf \'%s|\' "$@" >> "$LOG/gh.calls"; echo >> "$LOG/gh.calls"' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean), [
    'release|create|v1.4.3|--verify-tag|--generate-notes|--title|aidrian v1.4.3|--notes-start-tag|v1.4.2|',
    'release|create|aidrian-claude-mod-v0.1.0|--verify-tag|--generate-notes|--title|aidrian-claude-mod v0.1.0|--latest=false|',
  ]);
});
