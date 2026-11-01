import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isIgnored } from '../plugins/aidrian/lib/git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const XDG = path.join(tmpdir(), 'aidrian-check-state');
const STATE = new RegExp(`^${XDG}/aidrian/projects/[a-z0-9-]+-[0-9a-f]{8}$`);
const REPOSITORY = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/plugin.json'), 'utf8')).repository;

const run = (args, cwd) => spawnSync(CLI, args, { cwd, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
const ok = (stdout) => stdout.split('\n')[0];
const stateLine = (stdout) => stdout.split('\n')[1].replace(/^state: /, '');

// A git repository with the example consumer's project folder, docs, and .gitignore copied in.
function exampleRepo(t) {
  // realpath: git prints real paths, and on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(EXAMPLE, entry), path.join(dir, entry), { recursive: true });
  return dir;
}

test('check passes on a copy of the example consumer in its own repository', (t) => {
  const dir = exampleRepo(t);
  const { status, stdout, stderr } = run(['check'], path.join(dir, 'docs'));
  assert.deepEqual([status, ok(stdout), stderr], [0, 'ok: .aidrian (2 buckets, 8 docs)', '']);
  assert.match(stateLine(stdout), STATE);
  assert.match(stdout.split('\n')[2], /^budget: \d+ of 16384 always-doc bytes \(engineering \d+, product 0\)$/);
  assert.equal(stdout.split('\n').length, 4);
});

test('check fails, and session start warns, when the running plugin is older than the version config.json requires', (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/config.json');
  const config = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: '999.0.0' } }));
  const { status, stderr } = run(['check'], dir);
  assert.equal(status, 1);
  assert.match(stderr, /^this project requires aidrian 999\.0\.0 or later, and this session runs \d+\.\d+\.\d+ from \S+plugins\/aidrian: update the plugin, then start a new session$/mu);
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs')], { input: JSON.stringify({ cwd: dir }), encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
  assert.match(hook.stdout, /^Plugin too old: this project requires aidrian 999\.0\.0 or later/mu);
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: '0.1.0' } }));
  assert.equal(run(['check'], dir).status, 0, 'a floor at or below the running plugin passes');
  writeFileSync(file, JSON.stringify({ ...config, requires: { aidrian: 'latest' } }));
  assert.match(run(['check'], dir).stderr, /"requires\.aidrian" must be a plugin version such as "0\.17\.0", or null/u);
});

test('check warns past the knowledge budgets, and fails when the always docs pass twice theirs', (t) => {
  const dir = exampleRepo(t);
  const bytes = (doc) => statSync(path.join(dir, 'docs/knowledge', doc)).size;
  const always = bytes('engineering/working-agreement.md');
  // branches-and-reviews.md is the largest tagged doc of the example, so it is the only one over this limit.
  const largest = bytes('engineering/branches-and-reviews.md');
  const check = (budgets) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, knowledge: { budgets } }));
    return run(['check'], dir);
  };
  const warned = check({ alwaysBytes: always - 1, taggedDocBytes: largest - 1 });
  assert.equal(warned.status, 0);
  assert.match(warned.stdout, new RegExp(`\nbudget: ${always} of ${always - 1} always-doc bytes \\(engineering ${always}, product 0\\)\n$`));
  assert.deepEqual(warned.stderr.split('\n'), [
    `warning: always docs: ${always} bytes, over knowledge.budgets.alwaysBytes (${always - 1}); every session and subagent reads them: ` +
      'keep one or two short docs, and move the rest behind tags or to search',
    `warning: docs/knowledge/engineering/branches-and-reviews.md: ${largest} bytes, over knowledge.budgets.taggedDocBytes (${largest - 1}); ` +
      'every route to orchestration, review reads it whole: split it into a short rule card and a reference, or drop its tags so only search finds it',
    '',
  ]);
  const failed = check({ alwaysBytes: Math.floor((always - 1) / 2) });
  assert.deepEqual([failed.status, failed.stdout], [1, '']);
  assert.match(failed.stderr, new RegExp(`^always docs: ${always} bytes, over twice knowledge\\.budgets\\.alwaysBytes \\(${Math.floor((always - 1) / 2)}\\); `));
});

test('state prints the state folder, with or without a project folder', (t) => {
  const dir = exampleRepo(t);
  const { status, stdout } = run(['state'], path.join(dir, 'docs'));
  assert.equal(status, 0);
  assert.match(stdout.trim(), STATE);
  assert.equal(stdout.trim(), stateLine(run(['check'], dir).stdout));
  assert.match(run(['state'], tmpdir()).stdout.trim(), STATE);
});

test('check names the missing .gitignore line for the local sources file, and for a state folder inside the repository', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.gitignore'), '');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  const { status, stdout, stderr } = run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(
    stderr,
    '.aidrian.local.json is not git-ignored: add the line ".aidrian.local.json" to .gitignore, or run aidrian init\n' +
      '.state/ is not git-ignored: add the line ".state/" to .gitignore, or run aidrian init\n' +
      '.worktrees/ is not git-ignored: add the line ".worktrees/" to .gitignore, or run aidrian init\n',
  );
  assert.match(run(['init'], dir).stdout, /^added to \.gitignore: \.aidrian\.local\.json, \.state\/, \.worktrees\/\n/);
  assert.equal(stateLine(run(['check'], dir).stdout), path.join(dir, '.state'));
});

test('a nested project ignores a state folder outside it in the repository root .gitignore', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, 'app/.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, 'app/.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '.state' } }));
  const init = run(['init'], path.join(dir, 'app'));
  assert.equal(init.stdout, 'added to .gitignore: .aidrian.local.json\nadded to ../.gitignore: .state/, .worktrees/\n' +
    'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check\n');
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), '.state/\n.worktrees/\n');
  assert.equal(run(['check'], path.join(dir, 'app')).status, 0);
});

test('init in a linked worktree writes only inside that worktree, never the main checkout .gitignore', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const git = (...args) => execFileSync('git', ['-C', main, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
  execFileSync('git', ['init', '-q', '-b', 'main', main]);
  writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git('add', '.gitignore');
  git('commit', '-q', '-m', 'init');
  const tree = path.join(dir, 'tree');
  git('worktree', 'add', '-q', '-b', 'task', tree);
  const init = run(['init'], tree);
  assert.equal(init.status, 0, init.stderr);
  assert.equal(readFileSync(path.join(main, '.gitignore'), 'utf8'), 'node_modules/\n', 'the main checkout .gitignore is untouched');
  assert.equal(existsSync(path.join(main, '.aidrian')), false, 'no project folder in the main checkout');
  assert.ok(existsSync(path.join(tree, '.aidrian/config.json')));
  assert.equal(readFileSync(path.join(tree, '.gitignore'), 'utf8'), 'node_modules/\n.aidrian.local.json\n');
  assert.doesNotMatch(init.stdout, /\.\.\/main|\.worktrees/);
  assert.equal(run(['check'], tree).status, 0);
});

test('check follows worktrees.dir: a folder inside the project needs a line, one outside the repository needs none', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { dir: 'trees' } } }));
  assert.equal(run(['check'], dir).stderr, 'trees/ is not git-ignored: add the line "trees/" to .gitignore, or run aidrian init\n');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { dir: '../trees' } } }));
  assert.equal(run(['check'], dir).status, 0);
});

test('check names a bad name in config.json and in .aidrian.local.json', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: '' } }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ names: { robot: 'the agent' } }));
  const { status, stdout, stderr } = run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(stderr, '.aidrian/config.json: "names.human" must be a non-empty string\n.aidrian.local.json: unknown key "names.robot"\n');
});

test('check names a bad agent gate in config.json and in .aidrian.local.json', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, agents: { explorer: { deny: ['Bash(git *)'] } } }));
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ agents: { main: { only: ['Read'] } } }));
  const { status, stdout, stderr } = run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(
    stderr,
    '.aidrian/config.json: "agents.explorer.deny" has "Bash(git *)": Bash(...) takes a command prefix without "*", such as Bash(git push)\n'
      + '.aidrian.local.json: unknown key "agents.main.only"\n',
  );
});

test('check fails on a version this plugin does not read, and reads no index then', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 2 }));
  writeFileSync(path.join(dir, '.aidrian/knowledge/engineering.json'), '{"a format": "of version 2"}');
  const { status, stderr } = run(['check'], dir);
  assert.equal(status, 1);
  assert.equal(
    stderr,
    '.aidrian/config.json: project folder version 2; this plugin reads version 1; ' +
      `see ${REPOSITORY}/blob/main/docs/project-folder.md#migrating\n`,
  );
});

test('check warns on a tag outside the vocabulary, untagged docs, and a placeholder description, and still passes', (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  const index = JSON.parse(readFileSync(file, 'utf8'));
  index.description = 'Docs in docs/knowledge/product.';
  index.docs['product-rules.md'].tags = ['prodcut_sensitive', 'billing'];
  index.docs['sharing.md'].tags = [];
  writeFileSync(file, JSON.stringify(index));
  const { status, stderr } = run(['check'], dir);
  assert.equal(status, 0);
  assert.deepEqual(stderr.split('\n'), [
    'warning: .aidrian/knowledge/product.json: "description" is still the placeholder "Docs in docs/knowledge/product."; say what the bucket covers',
    'warning: docs/knowledge/product/product-rules.md: tag "prodcut_sensitive" is not one the plugin asks for; did you mean "product_sensitive"?',
    'warning: docs/knowledge/product/product-rules.md: tag "billing" is not one the plugin asks for; only a skill or dispatch of your own routes to it',
    'note: 1 of 8 docs have no tags; no agent routes to them',
    '',
  ]);
});

test('check fails on an index whose dir does not exist, apart from one outside the project', (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"dir": "docs/knowledge/product"', '"dir": "docs/gone"'));
  const { status, stderr } = run(['check'], dir);
  assert.deepEqual([status, stderr], [1, `.aidrian/knowledge/product.json: "dir": "docs/gone" does not exist (relative to ${dir})\n`]);
});

test('check fails on an index whose dir is not a folder inside the project', (t) => {
  const dir = exampleRepo(t);
  const file = path.join(dir, '.aidrian/knowledge/product.json');
  writeFileSync(file, readFileSync(file, 'utf8').replace('"dir": "docs/knowledge/product"', '"dir": "../product"'));
  const { status, stderr } = run(['check'], dir);
  assert.deepEqual([status, stderr], [1, '.aidrian/knowledge/product.json: "dir" must be a folder inside the project\n']);
});

test('a project whose .aidrian.json names another folder sets up and checks that folder', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-check-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: 'harness' }));
  const init = run(['init'], dir);
  assert.equal(init.status, 0, init.stderr);
  assert.match(init.stdout, /^wrote harness\/config\.json\nadded to \.gitignore: \.aidrian\.local\.json, \.worktrees\/\n/);
  assert.equal(existsSync(path.join(dir, '.aidrian')), false);
  assert.deepEqual([ok(run(['check'], dir).stdout), run(['check'], dir).status], ['ok: harness (0 buckets, 0 docs)', 0]);

  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: '../harness' }));
  const broken = run(['init'], dir);
  assert.deepEqual([broken.status, broken.stderr], [1, '.aidrian.json: "dir" must be a relative folder inside the project\n']);
});

test('init writes nothing through a symlink that leaves the project, and follows one that stays inside', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const outside = path.join(base, 'outside');
  mkdirSync(outside);
  writeFileSync(path.join(outside, 'gitignore'), 'keep\n');
  const repo = (name) => {
    const dir = path.join(base, name);
    execFileSync('git', ['init', '-q', dir]);
    return dir;
  };

  // .aidrian.json names a folder that does not exist yet, below a link that leaves the project.
  const named = repo('named');
  symlinkSync(outside, path.join(named, 'link'));
  writeFileSync(path.join(named, '.aidrian.json'), JSON.stringify({ dir: 'link/new' }));
  const viaNamed = run(['init'], named);
  assert.deepEqual([viaNamed.status, viaNamed.stderr], [1, '.aidrian.json: "dir" must be a relative folder inside the project\n']);

  // The project folder is a link that leaves the project, or a broken one.
  const linked = repo('linked');
  symlinkSync(outside, path.join(linked, '.aidrian'));
  const viaFolder = run(['init'], linked);
  const refused = (rel, dir) => `${rel}: links outside ${dir}; init wrote nothing\n`;
  assert.deepEqual([viaFolder.status, viaFolder.stderr], [1, refused('.aidrian/knowledge', linked) + refused('.aidrian/config.json', linked)]);
  const broken = repo('broken');
  symlinkSync(path.join(outside, 'gone'), path.join(broken, '.aidrian'));
  assert.equal(run(['init'], broken).status, 1);

  // The .gitignore is a link that leaves the repository: init stops before it writes the project folder.
  const ignore = repo('ignore');
  symlinkSync(path.join(outside, 'gitignore'), path.join(ignore, '.gitignore'));
  const viaIgnore = run(['init'], ignore);
  assert.deepEqual([viaIgnore.status, viaIgnore.stderr], [1, refused('.gitignore', ignore)]);
  assert.equal(existsSync(path.join(ignore, '.aidrian')), false);

  assert.deepEqual(readdirSync(outside), ['gitignore']);
  assert.equal(readFileSync(path.join(outside, 'gitignore'), 'utf8'), 'keep\n');

  const inside = repo('inside');
  mkdirSync(path.join(inside, 'harness'));
  symlinkSync(path.join(inside, 'harness'), path.join(inside, '.aidrian'));
  const followed = run(['init'], inside);
  assert.equal(followed.status, 0, followed.stderr);
  assert.equal(readFileSync(path.join(inside, 'harness/config.json'), 'utf8'), '{\n  "version": 1\n}\n');
});

test('init sets up an empty repository, a second run changes nothing and says so, and check then passes', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/');

  const first = run(['init'], dir);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(
    first.stdout,
    'wrote .aidrian/config.json\nadded to .gitignore: .aidrian.local.json, .worktrees/\n' +
      'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check\n',
  );
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{\n  "version": 1\n}\n');
  assert.deepEqual(readdirSync(path.join(dir, '.aidrian/knowledge')), []);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), 'node_modules/\n.aidrian.local.json\n.worktrees/\n');

  // Every file outside .git, with its content.
  const files = (folder) =>
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !path.relative(folder, entry.parentPath).split(path.sep).includes('.git'))
      .map((entry) => [path.relative(folder, path.join(entry.parentPath, entry.name)), readFileSync(path.join(entry.parentPath, entry.name), 'utf8')])
      .sort();
  const before = files(dir);
  const second = run(['init'], dir);
  assert.deepEqual([second.status, second.stdout], [0, 'nothing to do: .aidrian is set up\n']);
  assert.deepEqual(files(dir), before);
  assert.deepEqual([ok(run(['check'], dir).stdout), run(['check'], path.join(dir, '.aidrian')).status], ['ok: .aidrian (0 buckets, 0 docs)', 0]);
});

test('init adds the missing lines to an existing project and keeps its config', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1, "git": {"defaultBranch": "trunk"}}');
  const { status, stdout } = run(['init'], dir);
  assert.equal(status, 0);
  assert.equal(stdout.split('\n')[0], 'added to .gitignore: .aidrian.local.json, .worktrees/');
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{"version": 1, "git": {"defaultBranch": "trunk"}}');
});

// The tree in docs/project-folder.md is the folder contract: every committed entry exists in the example consumer, every
// git-ignored entry is ignored there and is a line `aidrian init` writes, and every file in the example's folder is in it.
test('the example consumer and aidrian init match the tree in docs/project-folder.md', (t) => {
  const entries = docTree();
  assert.ok(entries.length >= 4, 'the tree block lists the folder');

  const committed = entries.filter((entry) => entry.kind === 'committed');
  const ignored = entries.filter((entry) => entry.kind === 'git-ignored').map((entry) => entry.path);
  const pattern = (entry) => new RegExp(`^${entry.path.replace(/[.]/g, '\\.').replace('<bucket-id>', '[a-z0-9][a-z0-9-]*')}$`);
  const exampleFiles = readdirSync(path.join(EXAMPLE, '.aidrian'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(EXAMPLE, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/'));

  for (const entry of committed) {
    if (!entry.optional) assert.ok(exampleFiles.some((file) => pattern(entry).test(file)), `${entry.path} is in the example`);
  }
  for (const file of exampleFiles) assert.ok(committed.some((entry) => pattern(entry).test(file)), `${file} is in the tree`);
  for (const entry of ignored) assert.equal(isIgnored(EXAMPLE, entry), true, `${entry} is ignored in the example`);

  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-tree-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  assert.equal(run(['init'], dir).status, 0);
  assert.deepEqual(readFileSync(path.join(dir, '.gitignore'), 'utf8').trim().split('\n').sort(), [...ignored].sort());
});

// Each line of the tree block: { path, kind, optional }. A folder line without a note is the parent of the lines below it.
function docTree() {
  const doc = readFileSync(path.join(ROOT, 'docs/project-folder.md'), 'utf8');
  const block = /## Structure\n\n```text\n([\s\S]*?)\n```/.exec(doc)[1];
  const entries = [];
  let parent = '';
  for (const line of block.split('\n')) {
    const [, branch, name, note] = /^([├└]── )?(\S+)\s*(.*)$/.exec(line);
    const kind = /\((optional, )?(committed|git-ignored)\)$/.exec(note);
    if (!branch) parent = kind ? '' : name;
    if (kind) entries.push({ path: `${branch ? parent : ''}${name}`, kind: kind[2], optional: Boolean(kind[1]) });
  }
  return entries;
}
