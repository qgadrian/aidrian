import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { aggregateUsage, estimateCostUsd, filesRead, partOf, priceFor, subagentTranscripts, sumTokens } from '../plugins/aidrian/lib/transcript.mjs';

// One transcript line: an assistant message with usage, as Claude Code writes it.
const usageLine = (id, model, usage, { ts = '2026-10-29T10:00:00Z', content = [] } = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content } });

test('usage counts once per request: the lines of one message id repeat its usage, and the last one wins', () => {
  const text = [
    usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 100 }),
    usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 100 }, { ts: '2026-10-29T10:05:00Z' }),
    usageLine('m2', 'claude-sonnet-5-5', { input_tokens: 5, output_tokens: 2, cache_creation: { ephemeral_5m_input_tokens: 3, ephemeral_1h_input_tokens: 4 } }),
    usageLine('m3', '<synthetic>', { input_tokens: 999 }),
    'not json',
    '',
  ].join('\n');
  const { perModel, firstTs, lastTs } = aggregateUsage(text);
  assert.deepEqual(perModel['claude-opus-5-5'], { calls: 1, input: 10, output: 7, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0 });
  assert.deepEqual(perModel['claude-sonnet-5-5'], { calls: 1, input: 5, output: 2, cacheRead: 0, cacheWrite5m: 3, cacheWrite1h: 4 });
  assert.equal(perModel['<synthetic>'], undefined);
  assert.deepEqual([firstTs, lastTs], ['2026-10-29T10:00:00Z', '2026-10-29T10:05:00Z']);
  assert.deepEqual(sumTokens(perModel), { input: 15, output: 9, cache_read: 100, cache_write: 7, cache_write_5m: 3, cache_write_1h: 4 });
});

test('effort is the last request`s stamped level; tool calls count once per tool id, per request', () => {
  const tool = (id) => ({ type: 'tool_use', id, name: 'Read', input: {} });
  const line = (id, effort, content) => JSON.stringify({ type: 'assistant', effort, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content } });
  const text = [
    line('m1', 'high', [tool('t1')]),
    line('m1', 'high', [tool('t2')]),
    line('m1', 'high', [tool('t2')]),
    line('m2', 'medium', [{ type: 'text', text: 'SECRET' }]),
    line('m3', 'medium', [tool('t3')]),
  ].join('\n');
  const acc = aggregateUsage(text);
  assert.deepEqual([acc.effort, [...acc.efforts]], ['medium', ['high', 'medium']]);
  assert.deepEqual(partOf(acc), { perModel: acc.perModel, requests: 3, tool_requests: 2, tool_calls: 3 });
  assert.deepEqual(partOf(acc, (key) => key === 'm1'), { perModel: { 'claude-opus-5-5': { calls: 1, input: 1, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } }, requests: 1, tool_requests: 1, tool_calls: 2 });
  assert.equal(aggregateUsage(line('m4', undefined, []), acc).effort, null, 'a last request with no level: null, not an older level');
  assert.doesNotMatch(JSON.stringify(partOf(acc)), /SECRET/);
});

test('a request found in two transcripts folded into one result counts once', () => {
  const line = usageLine('shared', 'claude-opus-5-5', { input_tokens: 1, output_tokens: 1 });
  const once = aggregateUsage(line);
  assert.equal(aggregateUsage(line, once).perModel['claude-opus-5-5'].calls, 1);
});

test('cost follows the price map: cache reads and writes at their multipliers, unknown models listed', () => {
  assert.equal(priceFor('claude-opus-5-5').input, 4);
  assert.equal(priceFor('claude-sonnet-4-6').input, 3, 'the family fallback');
  const perModel = {
    'claude-opus-5-5': { calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 },
    'gpt-x': { calls: 1, input: 5, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
  };
  // 4 input + 20 output + 4 * 0.05 cache read + 4 * 1.25 + 4 * 2 cache writes.
  assert.deepEqual(estimateCostUsd(perModel), { total: 37.2, unknownModels: ['gpt-x'], byModel: { 'claude-opus-5-5': 37.2 } });
});

test('filesRead lists each Read file_path once; subagentTranscripts finds a session`s subagent files', (t) => {
  const read = (file) => usageLine(file, 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] });
  const other = usageLine('x', 'claude-opus-5-5', {}, { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'cat /a.md' } }] });
  assert.deepEqual(filesRead([read('/r/a.md'), other, read('/r/b.md'), read('/r/a.md')].join('\n')), ['/r/a.md', '/r/b.md']);
  assert.deepEqual(filesRead([read('/r/a.md'), read('/r/b.md')].join('\n'), (key) => key !== '/r/a.md'), ['/r/b.md'], 'only the requests `keep` takes');

  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-transcript-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 's-1/subagents'), { recursive: true });
  writeFileSync(path.join(dir, 's-1/subagents/agent-a.jsonl'), '');
  writeFileSync(path.join(dir, 's-1/subagents/agent-a.meta.json'), '{}');
  assert.deepEqual(subagentTranscripts(path.join(dir, 's-1.jsonl'), 's-1'), [path.join(dir, 's-1/subagents/agent-a.jsonl')]);
  assert.deepEqual(subagentTranscripts(path.join(dir, 's-1.jsonl'), '../s-1'), [], 'a session id never builds a path outside');
  assert.deepEqual(subagentTranscripts(path.join(dir, 'none.jsonl'), 'none'), []);
});
