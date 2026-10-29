import assert from 'node:assert/strict';
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

function tempDir(t) {
  // realpath: on macOS the temp folder is behind a symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-project-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
