// Model prices: the lookup and the cost math over the price tables the host adapters own (`modelPrices` in lib/hosts/*.mjs),
// and the cost of a dispatch-log row at today's tables (rowCostUsd), which every report view reads.
// The data lives in each adapter; this file assumes no host. docs/providers/adding-a-host.md lists a table's fields.

import { priceTables } from './hosts/index.mjs';

// The multiples of the input rate: a cache hit where the row sets none, and the two cache writes.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;
// A price row read longer ago than this is stale: `aidrian report health` names its table.
export const STALE_DAYS = 60;
const DAY_MS = 86_400_000;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// A row's `match` is a model id's version, such as `opus-4-1`. It matches where the version ends: at the end of the id,
// before a date (`-20250805`), before a hyphen and a non-digit (`-latest`, `-v1`), or before any other character but a
// hyphen or a digit, such as `[1m]` or `@`. So `opus-4` matches `claude-opus-4-20250514` and never `claude-opus-4-5`,
// whose `-0` alias (`claude-opus-4-0`) needs a row of its own. A fallback row matches its family word anywhere.
const patterns = new Map();
function matches(row, model) {
  if (row.fallback) return model.includes(row.match);
  if (!patterns.has(row.match)) patterns.set(row.match, new RegExp(`${escape(row.match)}(?=$|-\\d{8}(?!\\d)|-\\D|[^-\\d])`, 'u'));
  return patterns.get(row.match).test(model);
}

// The price of `model`: its row, with `host` and `fallback`, or null when no table prices it. Model ids name their vendor,
// so every host's table is read: a row of its own first, then a family's fallback row, which `fallback: true` flags so a
// report can name the model instead of pricing it silently as another.
export function priceFor(model, tables = priceTables()) {
  if (typeof model !== 'string' || model === '') return null;
  for (const fallback of [false, true]) {
    for (const table of tables) {
      const row = table.rows.find((each) => Boolean(each.fallback) === fallback && matches(each, model));
      if (row) return { ...row, host: table.host, fallback };
    }
  }
  return null;
}

// The prompt a request sent, which a row's `over` tier reads: every input token, cache reads and writes too.
export const promptTokens = (usage) => usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;

const usd = (usage, { input, output }, cacheRead) => (usage.input * input + usage.cacheRead * input * cacheRead +
  usage.cacheWrite5m * input * CACHE_WRITE_5M_MULT + usage.cacheWrite1h * input * CACHE_WRITE_1H_MULT + usage.output * output) / 1_000_000;
const minus = (whole, part) => Object.fromEntries(Object.entries(whole).map(([key, value]) => [key, typeof value === 'number' ? value - (part[key] ?? 0) : value]));

// The USD of one model's usage, { input, output, cacheRead, cacheWrite5m, cacheWrite1h } in tokens, at `price`.
// `usage.over` holds the part of it sent by requests whose prompt was over the row's `over.prompt`, billed at `over`'s rates.
export function costUsd(usage, price) {
  const read = price.cacheRead ?? CACHE_READ_MULT;
  if (!price.over || !usage.over) return usd(usage, price, read);
  return usd(minus(usage, usage.over), price, read) + usd(usage.over, price.over, price.over.cacheRead ?? read);
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const round4 = (usd) => Math.round(usd * 10000) / 10000;
// Sets `record[key]` as an own data property, so a model named __proto__ never reaches Object.prototype.
const setOwn = (record, key, value) => Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });

// A dispatch-log row's tokens, snake_case as the row holds them, as the usage costUsd reads. A row written before the
// cache-write split holds only `cache_write`, counted as 5-minute writes.
function usageOf(tokens) {
  const count = (value) => (Number.isFinite(value) ? value : 0);
  const split = Number.isFinite(tokens.cache_write_5m) || Number.isFinite(tokens.cache_write_1h);
  return {
    input: count(tokens.input), output: count(tokens.output), cacheRead: count(tokens.cache_read),
    cacheWrite5m: count(split ? tokens.cache_write_5m : tokens.cache_write), cacheWrite1h: split ? count(tokens.cache_write_1h) : 0,
  };
}

// The cost of `entries`, [model, tokens] pairs, at `tables`: { usd, by_model }, or null when one cannot be priced from its
// tokens: a model whose row has an `over` tier, read from tokens that do not say which part was over it.
function priced(entries, tables) {
  let total = 0;
  const byModel = {};
  for (const [model, tokens] of entries) {
    if (!isObject(tokens)) return null;
    const price = priceFor(model, tables);
    if (!price) continue;
    if (price.over && !isObject(tokens.over)) return null;
    const usage = isObject(tokens.over) ? { ...usageOf(tokens), over: usageOf(tokens.over) } : usageOf(tokens);
    const cost = costUsd(usage, price);
    setOwn(byModel, model, round4(cost));
    total += cost;
  }
  return { usd: round4(total), by_model: byModel };
}

// The cost of a dispatch-log row at the price tables as they are now: a `stop` row, a `session` row, or a session's side
// as `{ models: row.models, ...row.main }`. Returns { usd, logged, exact, by_model }: `logged` is the row's `cost_usd`,
// priced when it was written; `exact` is false when the row cannot be priced again, so `usd` is `logged` and `by_model`
// the row's `cost_by_model`. A row with `tokens_by_model`, empty or not, is priced per model; one without it that names one model, from
// its summed `tokens`. One that names several models, or holds no tokens, keeps its logged cost; one that names no model
// costs what it logged, exactly, since nothing was priced. A model no table prices costs $0 and is left out of `by_model`,
// as estimateCostUsd leaves it out. Every report view reads a row's cost through this function.
export function rowCostUsd(row, tables = priceTables()) {
  const logged = Number.isFinite(row?.cost_usd) ? row.cost_usd : 0;
  const kept = { usd: logged, logged, exact: false, by_model: isObject(row?.cost_by_model) ? { ...row.cost_by_model } : {} };
  const models = Array.isArray(row?.models) ? row.models.filter((model) => typeof model === 'string' && model !== '') : [];
  let result = null;
  // An empty `tokens_by_model`, such as a session's side that made no request, prices to $0 exactly.
  if (isObject(row?.tokens_by_model)) result = priced(Object.entries(row.tokens_by_model), tables);
  else if (!models.length) return { usd: logged, logged, exact: true, by_model: {} };
  else if (models.length === 1 && isObject(row.tokens)) result = priced([[models[0], row.tokens]], tables);
  return result ? { ...result, logged, exact: true } : kept;
}

const daysSince = (date, now) => Math.floor((now - Date.parse(date)) / DAY_MS);

// The tables with a row read more than STALE_DAYS ago, as { host, read_on, days }, the oldest such row of each.
// A row marked `unconfirmed`, a price the page no longer lists, can never be read again, so it never makes a table stale.
export function staleTables(now = Date.now(), tables = priceTables()) {
  const stale = [];
  for (const { host, rows } of tables) {
    const dates = rows.filter((row) => !row.unconfirmed).map((row) => row.readOn).sort();
    if (dates.length && daysSince(dates[0], now) > STALE_DAYS) stale.push({ host, read_on: dates[0], days: daysSince(dates[0], now) });
  }
  return stale;
}

// The model ids a table lists in `models` that no row of their own prices: a fallback row or nothing would.
export const modelsWithoutRow = (table) => table.models.filter((model) => {
  const price = priceFor(model, [table]);
  return !price || price.fallback;
});
