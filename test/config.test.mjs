import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS, findProjectRoot, loadConfig } from '../plugins/aidrian/lib/config.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');

test('the example consumer config is valid and gets every default', () => {
  const { config, errors } = loadConfig(EXAMPLE);
  assert.deepEqual(errors, []);
  assert.deepEqual(config, { ...DEFAULTS, buckets: ['docs/knowledge/engineering', 'docs/knowledge/product'] });
});

test('file values win; a group keeps the defaults for the keys the file leaves out', (t) => {
  const { config, errors } = loadConfig(project(t, { buckets: ['kb'], defaultBranch: 'trunk', pr: { maxReviewRounds: 3, requiredChecks: ['e2e'] } }));
  assert.deepEqual(errors, []);
  assert.equal(config.defaultBranch, 'trunk');
  assert.deepEqual(config.pr, { ...DEFAULTS.pr, maxReviewRounds: 3, requiredChecks: ['e2e'] });
  assert.deepEqual(config.worktrees, DEFAULTS.worktrees);
});

test('the loaded config is frozen all the way down', (t) => {
  const { config } = loadConfig(project(t, { buckets: ['kb'], mainCheckout: { allowWrites: ['notes/**'] } }));
  assert.throws(() => { config.defaultBranch = 'x'; }, TypeError);
  assert.throws(() => { config.pr.reviewer = 'x'; }, TypeError);
  assert.throws(() => config.mainCheckout.allowWrites.push('x'), TypeError);
  assert.throws(() => config.buckets.push('x'), TypeError);
});

// Each case expects exactly one error, and the default in place of the bad value.
const errorCases = [
  ['unknown top-level key', { buckets: ['kb'], extra: 1 }, /: unknown key "extra"$/],
  ['unknown key in a group', { buckets: ['kb'], pr: { reviewers: 'x' } }, /: unknown key "pr\.reviewers"$/],
  ['inherited property name as a key', JSON.parse('{"buckets": ["kb"], "__proto__": {}}'), /: unknown key "__proto__"$/],
  ['missing buckets', {}, /"buckets" must be a non-empty list of folders$/],
  ['empty buckets', { buckets: [] }, /"buckets" must be a non-empty list of folders$/],
  ['string instead of a list', { buckets: ['kb'], commits: { types: 'feat' } }, /"commits\.types" must be a list of non-empty strings$/],
  ['group that is not an object', { buckets: ['kb'], pr: [] }, /"pr" must be an object$/],
  ['negative number', { buckets: ['kb'], docs: { wrapLimit: -1 } }, /"docs\.wrapLimit" must be a whole number, 0 or more$/],
  ['zero where a positive number is needed', { buckets: ['kb'], pr: { maxReviewRounds: 0 } }, /"pr\.maxReviewRounds" must be a whole number above 0$/],
  ['string for a boolean', { buckets: ['kb'], mainCheckout: { guard: 'no' } }, /"mainCheckout\.guard" must be true or false$/],
  ['empty string', { buckets: ['kb'], defaultBranch: ' ' }, /"defaultBranch" must be a non-empty string$/],
];

for (const [name, value, expected] of errorCases) {
  test(`check fails: ${name}`, (t) => {
    const { config, errors } = loadConfig(project(t, value));
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], /^\.aidrian\/config\.json: /);
    assert.match(errors[0], expected);
    for (const key of ['defaultBranch', 'pr', 'docs', 'commits', 'mainCheckout']) assert.deepEqual(config[key], DEFAULTS[key], key);
  });
}

test('null is a valid worktree bootstrap, and a command string replaces it', (t) => {
  assert.deepEqual(loadConfig(project(t, { buckets: ['kb'], worktrees: { bootstrap: null } })).errors, []);
  const { config } = loadConfig(project(t, { buckets: ['kb'], worktrees: { bootstrap: 'npm ci' } }));
  assert.deepEqual(config.worktrees, { dir: '.aidrian/worktrees', bootstrap: 'npm ci' });
});

test('a missing, malformed, or outside-linking file is one error, and the config is all defaults', (t) => {
  const missing = project(t, {});
  rmSync(path.join(missing, '.aidrian/config.json'));
  const broken = project(t, {});
  writeFileSync(path.join(broken, '.aidrian/config.json'), '{');
  const linked = project(t, {});
  rmSync(path.join(linked, '.aidrian/config.json'));
  symlinkSync(path.join(ROOT, 'package.json'), path.join(linked, '.aidrian/config.json'));
  const cases = [[missing, /: not found$/], [broken, /: invalid JSON/], [linked, /: links outside the project$/]];
  for (const [dir, expected] of cases) {
    const { config, errors } = loadConfig(dir);
    assert.equal(errors.length, 1, errors.join('\n'));
    assert.match(errors[0], expected);
    assert.deepEqual(config, DEFAULTS);
  }
});

test('the project root is found from a subfolder, and is null outside any project', (t) => {
  assert.equal(findProjectRoot(path.join(EXAMPLE, 'src')), EXAMPLE);
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-none-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(findProjectRoot(outside), null);
});

function project(t, config) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return dir;
}
