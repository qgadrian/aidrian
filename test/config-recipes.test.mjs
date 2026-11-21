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
  // `solo: true` turns the three unattended switches on for a machine that leaves them unset, so it needs no local file.
  'full-autonomy-solo': null,
};
// The projectRun keys that open a confined session's sandbox further: a team sets each after reading its risk.
const SANDBOX_OPT_INS = ['registries', 'unverifiedHosts', 'outsideSandbox', 'mcpServers'];
// The projectRun keys that turn a preflight blocker into a risk the team takes: a team sets each after reading it.
const RISK_ACCEPTANCES = ['workflowSecretsAccepted', 'forgeProtectionAccepted'];

const recipe = (name) => JSON.parse(readFileSync(path.join(RECIPES, `${name}.json`), 'utf8'));
// Every leaf of `value` as a dotted path.
const leaves = (value, prefix = '') => (value !== null && typeof value === 'object' && !Array.isArray(value)
  ? Object.entries(value).flatMap(([key, each]) => leaves(each, `${prefix}${key}.`))
  : [prefix.slice(0, -1)]);
const has = (value, dotted) => dotted.split('.').every((key) => {
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return false;
  value = value[key];
  return true;
});

test('the recipes are the four the doc describes', () => {
  assert.deepEqual(names, ['autopilot', 'full-autonomy', 'full-autonomy-solo', 'hands-on']);
});

test('the solo recipe is the full-autonomy recipe with solo and project runs, and nothing else', () => {
  const { solo, projectRun, ...rest } = recipe('full-autonomy-solo');
  assert.equal(solo, true);
  assert.deepEqual(projectRun, { allow: true });
  assert.deepEqual(rest, recipe('full-autonomy'), 'every key full-autonomy sets, as it sets it');
});

test('no recipe turns on a machine switch, which only the main checkout\'s local file may hold', () => {
  const switches = Object.values(MACHINE).filter(Boolean).flatMap((text) => leaves(JSON.parse(text)));
  assert.ok(switches.length > 0);
  for (const name of names) for (const dotted of switches) assert.equal(has(recipe(name), dotted), false, `${name} sets ${dotted}`);
});

test('no recipe opens a project run\'s sandbox further', () => {
  for (const name of names) for (const key of SANDBOX_OPT_INS) assert.equal(has(recipe(name), `projectRun.${key}`), false, `${name} sets projectRun.${key}`);
});

test('no recipe accepts a risk the preflight blocks', () => {
  for (const name of names) for (const key of RISK_ACCEPTANCES) assert.equal(has(recipe(name), `projectRun.${key}`), false, `${name} sets projectRun.${key}`);
});

test('the setup reference offers every recipe', () => {
  for (const name of names) assert.ok(SETUP.includes(`(\`${name}\`)`), `the setup reference does not offer ${name}`);
});

// Claude Code's AskUserQuestion takes 2 to 4 choices a question, so a fifth choice is a call the host rejects.
test('each working-style question of the setup reference offers 2 to 4 choices', () => {
  const section = SETUP.split(/^## The question$/mu)[1]?.split(/^## /mu)[0];
  assert.ok(section, 'the setup reference has no "## The question" section');
  const numbered = section.match(/^\d+\. /gmu) ?? [];
  assert.ok(numbered.length >= 2 && numbered.length <= 4, `the working-style question offers ${numbered.length} numbered choices`);
  const followUp = section.match(/^- \*\*/gmu) ?? [];
  assert.ok(followUp.length === 0 || (followUp.length >= 2 && followUp.length <= 4), `the follow-up question offers ${followUp.length} choices`);
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
