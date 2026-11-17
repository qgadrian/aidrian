import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECIPES = path.join(ROOT, 'plugins/aidrian/recipes');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const XDG = path.join(tmpdir(), 'aidrian-recipes-state');
const DOC = readFileSync(path.join(ROOT, 'docs/config-recipes.md'), 'utf8');
// The setup skill's reference ships with the plugin; the doc does not, so the switches must be in both.
const SETUP = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/harness-setup/references/recipes.md'), 'utf8');

const names = readdirSync(RECIPES).map((file) => file.replace(/\.json$/u, '')).sort();
// The machine switches each recipe needs, as the doc shows them: the ones that only .aidrian.local.json may hold.
const MACHINE = {
  'full-autonomy': '{ "github": { "unattendedWaiver": { "enabled": true } }, "unattendedSignoff": "on", "handoff": { "background": "on" } }',
  autopilot: '{ "handoff": { "background": "on" } }',
  'hands-on': null,
};

test('the recipes are the three the doc describes', () => {
  assert.deepEqual(names, ['autopilot', 'full-autonomy', 'hands-on']);
});

for (const name of names) {
  test(`aidrian check passes with the ${name} recipe and its machine switches`, (t) => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-recipe-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync('git', ['init', '-q', dir]);
    for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(EXAMPLE, entry), path.join(dir, entry), { recursive: true });
    cpSync(path.join(RECIPES, `${name}.json`), path.join(dir, '.aidrian/config.json'));
    if (MACHINE[name]) writeFileSync(path.join(dir, '.aidrian.local.json'), MACHINE[name]);
    const { status, stdout, stderr } = spawnSync(CLI, ['check'], { cwd: dir, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: XDG } });
    assert.equal(status, 0, stdout + stderr);
    assert.doesNotMatch(stdout + stderr, /warn|error/iu);
  });

  test(`the doc shows the ${name} recipe and its machine switches exactly`, () => {
    const text = readFileSync(path.join(RECIPES, `${name}.json`), 'utf8').trim();
    assert.ok(DOC.includes(text), `docs/config-recipes.md lacks plugins/aidrian/recipes/${name}.json as written`);
    if (MACHINE[name]) assert.ok(DOC.includes(MACHINE[name]), `docs/config-recipes.md lacks the ${name} machine switches`);
    if (MACHINE[name]) assert.ok(SETUP.includes(`\`${name}\`: \`${MACHINE[name]}\``), `the setup reference lacks the ${name} machine switches`);
    else assert.ok(SETUP.includes(`\`${name}\`: none.`), `the setup reference does not say ${name} needs no switch`);
  });
}
