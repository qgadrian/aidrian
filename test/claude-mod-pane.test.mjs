// What the Claude mod's band and pane read, as plain values (plugins/aidrian-claude-mod/lib/pane-data.mjs): the Linear
// answer, the cache lifetime in the transcript's tail, git's answers, the effort, the model's name, and durations.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { agentRowParts, cacheTtlOf, cleanModel, dateMs, effortOf, formatDuration, issueOf, modelVersion, passResponse, repoOf, untilText } from '../plugins/aidrian-claude-mod/lib/pane-data.mjs';

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

// A response stream as turn.step's next(e) gives it: its chunks, then its result, on `result` too.
const responseOf = (chunks, usage) => {
  const result = { stopReason: usage === null ? null : 'end_turn', usage };
  const stream = (async function* () {
    yield* chunks;
    return result;
  })();
  return Object.assign(stream, { result: Promise.resolve(result) });
};

// Runs passResponse over a response, and gives each chunk it passed on with how many times it had called back by then.
const passed = async (chunks, usage) => {
  let calls = 0;
  const seen = [];
  const stream = passResponse(responseOf(chunks, usage), async () => {
    calls += 1;
  });
  let step = await stream.next();
  while (!step.done) {
    seen.push([step.value, calls]);
    step = await stream.next();
  }
  return { seen, calls, result: step.value };
};

test('a response restarts the cache countdown once, at its first piece of model output, never at an engine chunk', async () => {
  const usage = { input_tokens: 3, output_tokens: 1 };
  const marker = { kind: 'engine', ref: 1 };
  const text = { kind: 'text', index: 0, text: 'hi' };
  const streamed = await passed([marker, text, { kind: 'stop' }], usage);
  assert.deepEqual(streamed.seen, [[marker, 0], [text, 1], [{ kind: 'stop' }, 1]], 'every chunk passes on, the call at the text');
  assert.equal(streamed.calls, 1);
  assert.deepEqual(streamed.result, { stopReason: 'end_turn', usage });
  assert.equal((await passed([marker], null)).calls, 0, 'a retry marker and no response');
  assert.equal((await passed([marker], usage)).calls, 1, 'usage at the end counts when no model output streamed');
  assert.equal((await passed([], usage)).calls, 1);
  assert.equal((await passed([], null)).calls, 0);
});

test('a failed cache write never holds back the response or its result', async () => {
  const usage = { input_tokens: 3, output_tokens: 1 };
  const text = { kind: 'text', index: 0, text: 'hi' };
  for (const chunks of [[text], []]) {
    const stream = passResponse(responseOf(chunks, usage), async () => {
      throw new Error('state write refused');
    });
    const seen = [];
    let step = await stream.next();
    while (!step.done) {
      seen.push(step.value);
      step = await stream.next();
    }
    assert.deepEqual(seen, chunks);
    assert.deepEqual(step.value, { stopReason: 'end_turn', usage });
  }
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

test('a reset time is the milliseconds of a date string, or null for any value that is not one', () => {
  assert.equal(dateMs(new Date(185_000).toISOString()), 185_000);
  for (const at of ['not a date', '', '+999999-01-01T00:00:00Z', undefined, null, 7, Number.NaN]) assert.equal(dateMs(at), null, String(at));
});

test('an agent row shows its name, type, context, model, and effort, from the engine`s agent info', () => {
  const text = (parts) => parts.map((each) => each.text).join('');
  const agent = {
    name: 'reviewer', type: 'aidrian:code-reviewer', label: 'Review the diff', description: 'Review',
    model: 'claude-opus-5-5', effort: 'xhigh', contextWindowSize: 200_000, tokenCount: 96_000, status: 'running',
  };
  assert.equal(text(agentRowParts(agent, 80)), 'reviewer [aidrian:code-reviewer]  48% (96k) · 🪐 Opus 5.5 xhigh');
  assert.equal(text(agentRowParts({ ...agent, status: 'completed' }, 80)).endsWith(' · completed'), true, 'a status past running shows');
  assert.equal(text(agentRowParts({ ...agent, name: undefined }, 80)).startsWith('Review the diff ['), true, 'the label names an unnamed agent');
  assert.equal(text(agentRowParts({ ...agent, contextWindowSize: undefined, model: 'claude-sonnet-5-5[1m]', tokenCount: 1_500_000 }, 80)).includes('150% (1.5M) · 🪶 Sonnet 5.5'), true);
  const narrow = text(agentRowParts({ ...agent, name: 'a-very-long-agent-name-that-will-not-fit' }, 40));
  assert.equal(narrow.endsWith('48% (96k) · 🪐 Opus 5.5 xhigh'), true, 'the context and the model always show');
  assert.equal(narrow.includes('[aidrian:code-reviewer]'), false, 'the type drops before the name vanishes');
  assert.equal(text(agentRowParts({ name: 'x\u001b[31m', type: 'Explore' }, 80)).includes('\u001b'), false, 'no escape reaches the row');
  assert.equal(agentRowParts({ ...agent, tokenCount: 160_000 })[2].color, 'error', 'a full context is red');
});
