import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS, loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const MIGRATING = 'see https://github.com/qgadrian/aidrian-harness/blob/main/docs/project-folder.md#migrating';

test('the example consumer config is valid, turns the main-checkout guard on, and gets every other default', () => {
  const { config, errors, current } = loadConfig(findProject(EXAMPLE));
  assert.deepEqual([errors, current], [[], true]);
  assert.deepEqual(config, { ...DEFAULTS, mainCheckout: { ...DEFAULTS.mainCheckout, guard: true } });
  assert.equal(DEFAULTS.mainCheckout.guard, false, 'a project opts in; a fresh one is never blocked');
});

test('file values win; a group keeps the defaults for the keys the file leaves out', (t) => {
  const { config, errors } = loadConfig(project(t, { version: 1, defaultBranch: 'trunk', pr: { maxReviewRounds: 3, requiredChecks: ['e2e'] } }));
  assert.deepEqual(errors, []);
  assert.equal(config.defaultBranch, 'trunk');
  assert.deepEqual(config.pr, { ...DEFAULTS.pr, maxReviewRounds: 3, requiredChecks: ['e2e'] });
  assert.deepEqual(config.worktrees, DEFAULTS.worktrees);
});

test('the loaded config is frozen all the way down', (t) => {
  const { config } = loadConfig(project(t, { version: 1, mainCheckout: { allowWrites: ['notes/**'] } }));
  assert.throws(() => { config.defaultBranch = 'x'; }, TypeError);
  assert.throws(() => { config.pr.reviewer = 'x'; }, TypeError);
  assert.throws(() => config.mainCheckout.allowWrites.push('x'), TypeError);
  assert.throws(() => config.commits.types.push('x'), TypeError);
});

// Each case expects exactly one error, and the default in place of the bad value.
const errorCases = [
  ['unknown top-level key', { version: 1, extra: 1 }, /: unknown key "extra"$/],
  ['unknown key in a group', { version: 1, pr: { reviewers: 'x' } }, /: unknown key "pr\.reviewers"$/],
  ['inherited property name as a key', JSON.parse('{"version": 1, "__proto__": {}}'), /: unknown key "__proto__"$/],
  ['string instead of a list', { version: 1, commits: { types: 'feat' } }, /"commits\.types" must be a list of non-empty strings$/],
  ['group that is not an object', { version: 1, pr: [] }, /"pr" must be an object$/],
  ['negative number', { version: 1, docs: { wrapLimit: -1 } }, /"docs\.wrapLimit" must be a whole number, 0 or more$/],
  ['zero where a positive number is needed', { version: 1, pr: { maxReviewRounds: 0 } }, /"pr\.maxReviewRounds" must be a whole number above 0$/],
  ['string for a boolean', { version: 1, mainCheckout: { guard: 'no' } }, /"mainCheckout\.guard" must be true or false$/],
  ['empty string', { version: 1, defaultBranch: ' ' }, /"defaultBranch" must be a non-empty string$/],
];

for (const [name, value, expected] of errorCases) {
  test(`check fails: ${name}`, (t) => {
    const { config, errors, current } = loadConfig(project(t, value));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^\.aidrian\/config\.json: /);
    assert.match(errors[0], expected);
    assert.equal(current, true);
    for (const key of ['defaultBranch', 'pr', 'docs', 'commits', 'mainCheckout']) assert.deepEqual(config[key], DEFAULTS[key], key);
  });
}

// A missing, older, or newer version is one error that points at the migration notes, and nothing else is read.
const versionCases = [
  ['missing', { defaultBranch: 'trunk' }, 'missing'],
  ['older', { version: 0, extra: 1 }, '0'],
  ['newer', { version: 2, extra: 1 }, '2'],
  ['not a number', { version: '1' }, '"1"'],
];

for (const [name, value, shown] of versionCases) {
  test(`check fails: version ${name}`, (t) => {
    const { config, errors, current } = loadConfig(project(t, value));
    assert.deepEqual(errors, [`.aidrian/config.json: project folder version ${shown}; this plugin reads version 1; ${MIGRATING}`]);
    assert.equal(current, false);
    assert.deepEqual(config, DEFAULTS);
  });
}

test('worktrees.dir defaults to .worktrees and bootstrap to null, and a string replaces each', (t) => {
  assert.deepEqual(DEFAULTS.worktrees, { dir: '.worktrees', bootstrap: null });
  assert.deepEqual(loadConfig(project(t, { version: 1, worktrees: { bootstrap: null } })).errors, []);
  const { config } = loadConfig(project(t, { version: 1, worktrees: { dir: '../wt', bootstrap: 'npm ci' } }));
  assert.deepEqual(config.worktrees, { dir: '../wt', bootstrap: 'npm ci' });
  assert.deepEqual(loadConfig(project(t, { version: 1, worktrees: { dir: null } })).errors, [
    '.aidrian/config.json: "worktrees.dir" must be a non-empty string',
  ]);
});

test('a missing, malformed, or outside-linking file is one error, and the config is all defaults', (t) => {
  const missing = project(t, {});
  rmSync(path.join(missing.root, '.aidrian/config.json'));
  const broken = project(t, {});
  writeFileSync(path.join(broken.root, '.aidrian/config.json'), '{');
  const linked = project(t, {});
  rmSync(path.join(linked.root, '.aidrian/config.json'));
  symlinkSync(path.join(ROOT, 'package.json'), path.join(linked.root, '.aidrian/config.json'));
  const cases = [[missing, /: not found$/], [broken, /: invalid JSON/], [linked, /: links outside the project$/]];
  for (const [each, expected] of cases) {
    const { config, errors, current } = loadConfig(each);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], expected);
    assert.equal(current, false);
    assert.deepEqual(config, DEFAULTS);
  }
});

function project(t, config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return findProject(dir);
}
