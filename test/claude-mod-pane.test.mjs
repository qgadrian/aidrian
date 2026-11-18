// What the Claude mod's band and pane read, as plain values (plugins/aidrian-claude-mod/lib/pane-data.mjs): the Linear
// answer, the cache lifetime in the transcript's tail, git's answers, the effort, the model's name, and durations.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { cacheTtlOf, cleanModel, effortOf, formatDuration, issueOf, modelVersion, repoOf, untilText } from '../plugins/aidrian-claude-mod/lib/pane-data.mjs';

const text = (value) => [{ type: 'text', text: JSON.stringify(value) }];

test('the issue is the title, state, and url Linear answered, as raw strings, or null', () => {
  const url = 'https://linear.app/acme/issue/ABC-12/ship';
  assert.deepEqual(issueOf('ABC-12', text({ title: 'Ship', status: 'In Progress', url })), { key: 'ABC-12', title: 'Ship', status: 'In Progress', url });
  assert.deepEqual(issueOf('ABC-12', text({ title: 'Ship', status: { name: 'Done' } })), { key: 'ABC-12', title: 'Ship', status: 'Done', url: '' });
  assert.deepEqual(issueOf('ABC-12', text({ title: 7, status: ['x'], url: null })), { key: 'ABC-12', title: '', status: '', url: '' });
  for (const content of [[], [{ type: 'text', text: 'not json' }], text([1]), [{ type: 'image' }], null, undefined]) {
    assert.equal(issueOf('ABC-12', content), null, JSON.stringify(content));
  }
});

const reply = (buckets, isSidechain = false) => JSON.stringify({ type: 'assistant', isSidechain, message: { usage: { input_tokens: 3, cache_creation: buckets } } });

test('the cache lifetime is the bucket the last main-chain reply wrote to', () => {
  assert.equal(cacheTtlOf(reply({ ephemeral_5m_input_tokens: 1687, ephemeral_1h_input_tokens: 0 })), 300_000);
  assert.equal(cacheTtlOf(reply({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 1687 })), 300_000);
  assert.equal(cacheTtlOf(reply({ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 900 })), 3_600_000);
  const tail = ['partial line {"cache_creation"', reply({ ephemeral_5m_input_tokens: 10 }), reply({ ephemeral_1h_input_tokens: 500 }, true), '{"type":"user"}'].join('\n');
  assert.equal(cacheTtlOf(tail), 300_000, 'a subagent line and a cut line are skipped');
  assert.equal(cacheTtlOf(reply({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 })), null, 'a reply that wrote nothing keeps the lifetime');
  assert.equal(cacheTtlOf(''), null);
});

test('the checkout is the branch, or a linked worktree`s folder name, with a dot for changes', () => {
  assert.deepEqual(repoOf({ branch: 'main\n', gitDir: '/w/tiger/.git\n', status: '' }), { label: 'main', isWorktree: false, isDirty: false });
  assert.deepEqual(repoOf({ branch: 'feat/x', gitDir: '/w/tiger/.git/worktrees/feature\n', status: ' M a.js\n' }), { label: 'feature', isWorktree: true, isDirty: true });
  assert.deepEqual(repoOf({ branch: 'evil\u001b]52;x\u0007\u202e', gitDir: '/w/.git', status: '\n' }).label, 'evil]52;x');
  const inWorktreesFolder = repoOf({ branch: 'main\n', gitDir: '/w/worktrees/tiger/.git\n', status: '' });
  assert.deepEqual(inWorktreesFolder, { label: 'main', isWorktree: false, isDirty: false }, 'a main checkout under a worktrees folder');
  const submodule = repoOf({ branch: 'main', gitDir: '/w/tiger/.git/worktrees/feature/modules/lib', status: '' });
  assert.equal(submodule.isWorktree, false, 'only the end of the path names a linked worktree');
  assert.equal(repoOf({ branch: '\n', gitDir: '/w/tiger/.git', status: '' }).label, 'detached', 'a detached checkout');
});

test('the effort is the one Claude Code picks, in its order', () => {
  const settings = { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'low' } } };
  assert.equal(effortOf({ seen: 'max', fromEnv: 'low', model: 'claude-opus-5-5', settings }), 'max', 'the last turn');
  assert.equal(effortOf({ fromEnv: 'xhigh', model: 'claude-opus-5-5', settings }), 'xhigh', 'the variable');
  assert.equal(effortOf({ model: 'claude-opus-5-5[1m]', settings }), 'low', 'the model`s entry');
  assert.equal(effortOf({ model: 'claude-opus-5-5', settings: { effortLevel: 'high' } }), 'medium', 'the top-level level is ignored from Opus 5.5');
  assert.equal(effortOf({ model: 'claude-sonnet-4-5', settings: { effortLevel: 'high' } }), 'high');
  assert.equal(effortOf({ model: 'claude-opus-4-7', settings: {} }), 'xhigh');
  assert.equal(effortOf({ model: 'claude-haiku-4', settings: null }), null);
  assert.equal(effortOf({ model: 'Opus 5.5', settings: {} }), null, 'a name that is no model id');
});

test('the model reads as a person names it', () => {
  assert.deepEqual(modelVersion('claude-opus-5-5-20260101'), { family: 'opus', major: 5, minor: 5 });
  assert.equal(modelVersion('gpt-5'), null);
  assert.equal(cleanModel('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(cleanModel('Opus 5.5 (1M context)'), 'Opus 5.5');
  assert.equal(cleanModel('claude-haiku-4'), 'Haiku 4');
  assert.equal(cleanModel('custom-model'), 'custom-model');
  assert.equal(cleanModel('evil\u001b[31m\u202emodel\u0007'), 'evil[31mmodel', 'no hidden character reaches the band or the pane');
});

test('a duration shows its two largest units', () => {
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(45_000), '45s');
  assert.equal(formatDuration(185_000), '3m05s');
  assert.equal(formatDuration(3 * 3_600_000), '3h00m');
  assert.equal(formatDuration(50 * 3_600_000), '2d2h');
});

test('the time until a reset is a duration, or empty for a date that does not parse', () => {
  assert.equal(untilText(new Date(185_000).toISOString(), 0), '3m05s');
  assert.equal(untilText(new Date(0).toISOString(), 5_000), '0s');
  for (const at of ['not a date', '', undefined, null, 7]) assert.equal(untilText(at, 0), '', String(at));
});
