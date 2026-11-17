// Model prices: the lookup and the cost math over the price tables the host adapters own (`modelPrices` in lib/hosts/*.mjs).
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
