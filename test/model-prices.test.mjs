// The model price tables the host adapters own, and the lookup and cost math of lib/model-prices.mjs over them.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { HOSTS, priceTables } from '../plugins/aidrian/lib/hosts/index.mjs';
import { tokensByModel } from '../plugins/aidrian/lib/dispatch-rows.mjs';
import { costUsd, modelsWithoutRow, priceFor, rowCostUsd, STALE_DAYS, staleTables } from '../plugins/aidrian/lib/model-prices.mjs';
import { aggregateUsage, estimateCostUsd } from '../plugins/aidrian/lib/transcript.mjs';

const DAY = 86_400_000;
const table = (rows, models = []) => ({ host: 'fake', models, rows });
const row = (fields) => ({ input: 1, output: 2, source: 'https://example.test/prices', readOn: '2026-01-01', ...fields });

test('a row matches its own version: never a later version, and through a date or a host suffix', () => {
  const rates = (model) => [priceFor(model)?.input, priceFor(model)?.output, priceFor(model)?.fallback];
  assert.deepEqual(rates('claude-fable-5-2'), [8, 40, false]);
  assert.equal(priceFor('claude-fable-5-2').cacheRead, 0.025);
  assert.deepEqual(rates('claude-fable-5'), [10, 50, false]);
  assert.deepEqual(rates('claude-opus-4-20250514'), [15, 75, false]);
  assert.deepEqual(rates('claude-opus-4-1-20250805'), [15, 75, false]);
  assert.deepEqual(rates('claude-opus-4-7'), [5, 25, false]);
  assert.deepEqual(rates('claude-opus-4-6[1m]'), [5, 25, false]);
  assert.deepEqual(rates('anthropic.claude-sonnet-4-5-20250929-v1:0'), [3, 15, false]);
  assert.deepEqual(rates('claude-opus-4-1@20250805'), [15, 75, false]);
  assert.deepEqual(rates('claude-opus-4-0'), [15, 75, false], 'the -0 alias of Opus 4');
  assert.deepEqual(rates('claude-sonnet-4-0'), [3, 15, false], 'the -0 alias of Sonnet 4');
  assert.deepEqual(rates('anthropic.claude-opus-4-6-v1'), [5, 25, false], 'a hyphen and a letter end the version');
  assert.deepEqual(rates('claude-3-5-haiku-latest'), [0.8, 4, false]);
  assert.deepEqual(rates('claude-3-opus-latest'), [15, 75, false]);
  assert.equal(priceFor('claude-sonnet-5').cacheRead, undefined, 'Sonnet 5 hits the cache at the standard multiple');
  assert.equal(priceFor('claude-sonnet-5-5').cacheRead, 0.05);
});

test('a retired Sonnet keeps its own price, never the newer family fallback', () => {
  const rates = (model) => [priceFor(model)?.input, priceFor(model)?.output, priceFor(model)?.cacheRead, priceFor(model)?.fallback];
  for (const model of ['claude-3-7-sonnet-20250219', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', 'claude-3-7-sonnet-latest',
    'claude-3-5-sonnet-20241022', 'claude-3-sonnet-20240229']) {
    assert.deepEqual(rates(model), [3, 15, undefined, false], model);
    assert.match(priceFor(model).unconfirmed, /^retired/u, model);
  }
});

test('a model no row of its own names is priced by its family, flagged as a fallback; an unknown family is null', () => {
  const future = priceFor('claude-sonnet-9-9');
  assert.equal(future.fallback, true);
  assert.equal(future.host, 'claude-code');
  assert.deepEqual([future.input, future.output, future.cacheRead], [2, 10, 0.05], 'the family\'s newest price');
  assert.equal(priceFor('gpt-x'), null);
  assert.equal(priceFor(''), null);
  assert.equal(priceFor(undefined), null);
});

test('a specific row of any table wins over a fallback row of an earlier one', () => {
  const tables = [table([row({ match: 'opus', fallback: true, input: 9 })]), { ...table([row({ match: 'opus-7', input: 3 })]), host: 'other' }];
  assert.deepEqual([priceFor('vendor-opus-7', tables).input, priceFor('vendor-opus-7', tables).host], [3, 'other']);
  assert.equal(priceFor('vendor-opus-8', tables).fallback, true);
});

test('cost: cache reads at the row multiple, writes at 1.25x and 2x, and the part over a tier at its rates', () => {
  const usage = { calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000 };
  assert.equal(costUsd(usage, { input: 4, output: 20, cacheRead: 0.05 }), 4 + 20 + 0.2 + 5 + 8);
  assert.equal(costUsd(usage, { input: 4, output: 20 }), 4 + 20 + 0.4 + 5 + 8, 'the standard 0.1x');
  const tiered = { input: 1, output: 2, over: { prompt: 10, input: 10, output: 20 } };
  const over = { calls: 1, input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  const whole = { calls: 2, input: 2_000_000, output: 2_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, over };
  assert.equal(costUsd(whole, tiered), 1 + 2 + 10 + 20);
});

// Snake_case tokens, as a dispatch-log row holds them.
const tokens = (fields = {}) => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0, ...fields });

test('rowCostUsd prices a row at the tables as they are now, not as the row logged it', () => {
  const old = [table([row({ match: 'm-1', input: 10, output: 50 })])];
  const now = [table([row({ match: 'm-1', input: 4, output: 20, cacheRead: 0.05 })])];
  const usage = tokens({ input: 1_000_000, output: 100_000, cache_read: 1_000_000, cache_write: 1_000_000, cache_write_1h: 1_000_000 });
  const logged = rowCostUsd({ tokens_by_model: { 'x-m-1': { ...usage, over: tokens() } } }, old).usd;
  assert.equal(logged, 10 + 5 + 1 + 20, 'at the old table: input, output, a 0.1x cache read, and a 2x one-hour write');
  const priced = rowCostUsd({ tokens_by_model: { 'x-m-1': { ...usage, over: tokens() } }, cost_usd: logged }, now);
  assert.deepEqual(priced, { usd: 14.2, logged: 36, exact: true, by_model: { 'x-m-1': 14.2 } }, '4 + 2 + 0.2 + 8 at today`s table');
  // A row with no tokens per model that names one model is priced from its summed tokens; a split row's `cache_write`
  // alone is a 5-minute write.
  assert.deepEqual(rowCostUsd({ models: ['x-m-1'], tokens: usage, cost_usd: 36 }, now), priced);
  assert.equal(rowCostUsd({ models: ['x-m-1'], tokens: { input: 0, output: 0, cache_read: 0, cache_write: 1_000_000 } }, now).usd, 5);
});

test('rowCostUsd keeps the logged cost of a row it cannot price again, and says so', () => {
  const now = [table([row({ match: 'm-1', input: 4, output: 20 }), row({ match: 'm-2', input: 1, output: 2 })])];
  const usage = tokens({ input: 1_000_000 });
  // Two models and only their summed tokens: which model sent which token is unknown.
  assert.deepEqual(rowCostUsd({ models: ['x-m-1', 'x-m-2'], tokens: usage, cost_usd: 3 }, now), { usd: 3, logged: 3, exact: false, by_model: {} });
  // So are the sides of such a session, and its cost per model stays as logged.
  assert.deepEqual(rowCostUsd({ models: ['x-m-1', 'x-m-2'], tokens: usage, cost_usd: 3, cost_by_model: { 'x-m-1': 2, 'x-m-2': 1 } }, now).by_model, { 'x-m-1': 2, 'x-m-2': 1 });
  assert.equal(rowCostUsd({ models: ['x-m-1'], cost_usd: 3 }, now).exact, false, 'one model and no tokens');
  assert.deepEqual(rowCostUsd({ models: [], cost_usd: 0 }, now), { usd: 0, logged: 0, exact: true, by_model: {} }, 'nothing was priced');
  // An empty `tokens_by_model`, as a session's side that made no request, is priced, at $0, whatever models the session names.
  assert.deepEqual(rowCostUsd({ models: ['x-m-1', 'x-m-2'], tokens_by_model: {}, cost_usd: 0 }, now), { usd: 0, logged: 0, exact: true, by_model: {} });
  // A model whose row has an `over` tier, from tokens written before rows split out the part over it.
  const tiered = [table([row({ match: 'm-1', input: 1, output: 2, over: { prompt: 10, input: 10, output: 20 } })])];
  assert.equal(rowCostUsd({ tokens_by_model: { 'x-m-1': usage }, cost_usd: 7 }, tiered).exact, false);
  assert.equal(rowCostUsd({ models: ['x-m-1'], tokens: usage, cost_usd: 7 }, tiered).exact, false);
});

test('rowCostUsd prices the part over a row`s over.prompt at its tier, to the dollar estimateCostUsd gave', () => {
  // Haiku 5.5 bills a request whose prompt is over 100k tokens at its `over` rates.
  const line = (id, input) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-haiku-5-5', usage: { input_tokens: input, output_tokens: 1000 } } });
  const { perModel } = aggregateUsage([line('m1', 150_000), line('m2', 20_000)].join('\n'));
  const logged = estimateCostUsd(perModel).total;
  const byModel = tokensByModel(perModel);
  assert.deepEqual(byModel['claude-haiku-5-5'].over, tokens({ input: 150_000, output: 1000 }));
  assert.deepEqual(rowCostUsd({ tokens_by_model: byModel, cost_usd: logged }), { usd: logged, logged, exact: true, by_model: estimateCostUsd(perModel).byModel });
  assert.ok(logged > rowCostUsd({ tokens_by_model: { 'claude-haiku-5-5': { ...byModel['claude-haiku-5-5'], over: tokens() } } }).usd, 'the tier costs more');
});

test('rowCostUsd prices a model no table knows at $0, and leaves it out of the cost per model', () => {
  const now = [table([row({ match: 'm-1', input: 4, output: 20 })])];
  const usage = tokens({ input: 1_000_000 });
  assert.deepEqual(rowCostUsd({ tokens_by_model: { 'x-m-1': { ...usage, over: tokens() }, 'gpt-x': { ...usage, over: tokens() } } }, now),
    { usd: 4, logged: 0, exact: true, by_model: { 'x-m-1': 4 } });
  assert.deepEqual(rowCostUsd({ models: ['gpt-x'], tokens: usage, cost_usd: 0 }, now), { usd: 0, logged: 0, exact: true, by_model: {} });
  // A model named __proto__ is a key of its own, never the object's prototype.
  const odd = rowCostUsd(JSON.parse('{"tokens_by_model":{"__proto__":{"input":1000000,"over":{}}}}'), [table([row({ match: '__proto__', input: 1 })])]);
  assert.deepEqual([Object.keys(odd.by_model), Object.getPrototypeOf(odd.by_model) === Object.prototype], [['__proto__'], true]);
});

test('a table goes stale past STALE_DAYS from its oldest confirmed row; an unconfirmed row never makes it stale', () => {
  const now = Date.parse('2026-01-01') + (STALE_DAYS + 1) * DAY;
  assert.deepEqual(staleTables(now, [table([row({ match: 'a' })])]), [{ host: 'fake', read_on: '2026-01-01', days: STALE_DAYS + 1 }]);
  assert.deepEqual(staleTables(now - 2 * DAY, [table([row({ match: 'a' })])]), []);
  assert.deepEqual(staleTables(now, [table([row({ match: 'a', unconfirmed: 'retired' })])]), []);
  assert.deepEqual(staleTables(now, [table([])]), [], 'a host with no prices is never stale');
});

test('modelsWithoutRow names a listed model that only a fallback row, or no row, prices', () => {
  const rows = [row({ match: 'm-1' }), row({ match: 'm', fallback: true })];
  assert.deepEqual(modelsWithoutRow(table(rows, ['x-m-1', 'x-m-2', 'y'])), ['x-m-2', 'y']);
});

for (const host of HOSTS) {
  const prices = priceTables([host])[0];

  test(`host ${host.id}: every model it lists has a row of its own, and every model choice names a listed model`, () => {
    assert.deepEqual(modelsWithoutRow(prices), []);
    const aliases = Array.isArray(host.modelChoices.model) ? host.modelChoices.model : [];
    if (aliases.length) assert.ok(prices.rows.length, 'a host with model choices prices its models');
    for (const alias of aliases) assert.ok(prices.models.some((model) => model.includes(alias)), `${alias} names no model in modelPrices.models`);
  });

  test(`host ${host.id}: every price row names its source page and the date it was read`, () => {
    for (const each of prices.rows) {
      assert.match(each.source, /^https:\/\//u, each.match);
      assert.match(each.readOn, /^\d{4}-\d{2}-\d{2}$/u, each.match);
      assert.ok(Number.isFinite(each.input) && Number.isFinite(each.output), each.match);
    }
  });
}
