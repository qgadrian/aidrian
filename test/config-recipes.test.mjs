import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECIPES = path.join(ROOT, 'plugins/aidrian/recipes');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const XDG = path.join(tmpdir(), 'aidrian-recipes-state');
const DOC = readFileSync(path.join(ROOT, 'docs/config-recipes.md'), 'utf8');

const names = readdirSync(RECIPES).sort();

test('the recipes are the three the doc describes', () => {
  assert.deepEqual(names, ['autopilot', 'full-autonomy', 'hands-on']);
});

for (const name of names) {
  test(`aidrian check passes with the ${name} recipe and its local file`, (t) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-recipe-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', dir]);
    for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(EXAMPLE, entry), path.join(dir, entry), { recursive: true });
    cpSync(path.join(RECIPES, name, 'config.json'), path.join(dir, '.aidrian/config.json'));
    cpSync(path.join(RECIPES, name, 'local.json'), path.join(dir, '.aidrian.local.json'));
    const { status, stdout, stderr } = spawnSync(CLI, ['check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
    assert.equal(status, 0, stdout + stderr);
    assert.doesNotMatch(stdout + stderr, /warn|error/iu);
  });

  test(`the doc shows the ${name} recipe's files exactly`, () => {
    for (const file of ['config.json', 'local.json']) {
      const text = readFileSync(path.join(RECIPES, name, file), 'utf8').trim();
      assert.ok(DOC.includes(text), `docs/config-recipes.md lacks plugins/aidrian/recipes/${name}/${file} as written`);
    }
  });
}
