import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isIgnored } from '../plugins/aidrian/lib/git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const IGNORED = ['.aidrian/plans/', '.aidrian/handoffs/', '.aidrian/lessons/', '.aidrian/dispatch-log.jsonl', '.aidrian/worktrees/', '.aidrian.local.json'];

const run = (args, cwd) => spawnSync(CLI, args, { cwd, encoding: 'utf8' });

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
  assert.deepEqual([status, stdout, stderr], [0, 'ok: .aidrian (2 buckets, 8 docs)\n', '']);
});

test('check names the missing .gitignore line for a local-state folder git does not ignore', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.gitignore'), IGNORED.filter((line) => line !== '.aidrian/lessons/').join('\n'));
  const { status, stdout, stderr } = run(['check'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.equal(stderr, '.aidrian/lessons/ is not git-ignored: add the line ".aidrian/lessons/" to .gitignore, or run aidrian init\n');
});

test('check follows worktrees.dir: another folder inside the project needs a line, one outside needs none', (t) => {
  const dir = exampleRepo(t);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, worktrees: { dir: 'trees' } }));
  assert.match(run(['check'], dir).stderr, /^trees\/ is not git-ignored: add the line "trees\/" to \.gitignore/);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, worktrees: { dir: '../trees' } }));
  assert.equal(run(['check'], dir).status, 0);
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
      'see https://github.com/qgadrian/aidrian-harness/blob/main/docs/project-folder.md#migrating\n',
  );
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
  assert.match(init.stdout, /^wrote harness\/config\.json\nadded to \.gitignore: harness\/plans\/, /);
  assert.equal(existsSync(path.join(dir, '.aidrian')), false);
  assert.deepEqual([run(['check'], dir).stdout, run(['check'], dir).status], ['ok: harness (0 buckets, 0 docs)\n', 0]);

  writeFileSync(path.join(dir, '.aidrian.json'), JSON.stringify({ dir: '../harness' }));
  const broken = run(['init'], dir);
  assert.deepEqual([broken.status, broken.stderr], [1, '.aidrian.json: "dir" must be a relative folder inside the project\n']);
});

test('init sets up an empty repository, a second run changes nothing and says so, and check then passes', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.aidrian/lessons/');

  const first = run(['init'], dir);
  assert.equal(first.status, 0, first.stderr);
  const added = IGNORED.filter((line) => line !== '.aidrian/lessons/');
  assert.equal(
    first.stdout,
    `wrote .aidrian/config.json\nadded to .gitignore: ${added.join(', ')}\n` +
      'next: add a knowledge index with aidrian-knowledge init <folder of docs>, then run aidrian check\n',
  );
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{\n  "version": 1\n}\n');
  assert.deepEqual(readdirSync(path.join(dir, '.aidrian/knowledge')), []);
  assert.equal(readFileSync(path.join(dir, '.gitignore'), 'utf8'), `node_modules/\n.aidrian/lessons/\n${added.join('\n')}\n`);

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
  assert.deepEqual([run(['check'], dir).stdout, run(['check'], path.join(dir, '.aidrian')).status], ['ok: .aidrian (0 buckets, 0 docs)\n', 0]);
});

test('init adds the missing lines to an existing project and keeps its config', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-init-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), '{"version": 1, "defaultBranch": "trunk"}');
  const { status, stdout } = run(['init'], dir);
  assert.equal(status, 0);
  assert.match(stdout, /^added to \.gitignore: \.aidrian\/plans\/, /);
  assert.equal(readFileSync(path.join(dir, '.aidrian/config.json'), 'utf8'), '{"version": 1, "defaultBranch": "trunk"}');
});

// The tree in docs/project-folder.md is the folder contract: every committed entry exists in the example consumer, every
// git-ignored entry is ignored there and is a line `aidrian init` writes, and every file in the example's folder is in it.
test('the example consumer and aidrian init match the tree in docs/project-folder.md', (t) => {
  const entries = docTree();
  assert.ok(entries.length >= 8, 'the tree block lists the folder');

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
