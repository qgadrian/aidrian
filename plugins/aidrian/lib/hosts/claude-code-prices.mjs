// Claude Code's model prices, which its adapter exposes as `modelPrices`; lib/model-prices.mjs does the lookup and the math.
// USD per million tokens, list prices from the page below. `cacheRead` is a cache hit's multiple of the input rate where
// the page sets one other than 0.1; cache writes are 1.25x (5 minutes) and 2x (1 hour) on every model. `over` is the
// higher price of a request whose prompt, cache reads and writes included, is over `over.prompt` tokens.
// docs/providers/adding-a-host.md lists the fields; the model-prices skill of this repository says how to update them.

const PAGE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const READ = { source: PAGE, readOn: '2026-11-17' };
// Retired models the page no longer lists, kept at the price an earlier read of it gave. No read can confirm them again.
const RETIRED = { source: PAGE, readOn: '2026-10-28', unconfirmed: 'retired: not on the page read 2026-11-17' };

export default {
  // The model ids its model choices (`sonnet`, `opus`, `haiku`, `fable`) name today. Each needs a row of its own.
  models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  rows: [
    { match: 'fable-5-2', input: 8, output: 40, cacheRead: 0.025, ...READ },
    { match: 'mythos-5-2', input: 8, output: 40, cacheRead: 0.025, ...READ },
    { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.025, ...READ },
    { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.025, ...READ },
    { match: 'fable-5', input: 10, output: 50, ...READ },
    { match: 'mythos-5', input: 10, output: 50, ...READ },
    { match: 'opus-5-5', input: 4, output: 20, cacheRead: 0.05, ...READ },
    { match: 'opus-5', input: 5, output: 25, ...READ },
    { match: 'opus-4-8', input: 5, output: 25, ...READ },
    { match: 'opus-4-7', input: 5, output: 25, ...READ },
    { match: 'opus-4-6', input: 5, output: 25, ...READ },
    { match: 'opus-4-5', input: 5, output: 25, ...READ },
    { match: 'opus-4-1', input: 15, output: 75, ...READ },
    { match: 'opus-4', input: 15, output: 75, ...READ },
    { match: 'sonnet-5-5', input: 2, output: 10, cacheRead: 0.05, ...READ },
    { match: 'sonnet-5', input: 2, output: 10, ...READ },
    { match: 'sonnet-4-6', input: 3, output: 15, ...READ },
    { match: 'sonnet-4-5', input: 3, output: 15, ...READ },
    { match: 'sonnet-4', input: 3, output: 15, ...READ },
    { match: 'haiku-5-5', input: 0.1, output: 0.5, over: { prompt: 100_000, input: 0.5, output: 2.5 }, ...READ },
    { match: 'haiku-4-5', input: 1, output: 5, ...READ },
    { match: 'claude-3-opus', input: 15, output: 75, ...RETIRED },
    { match: 'claude-3-5-haiku', input: 0.8, output: 4, ...RETIRED },
    { match: 'claude-3-haiku', input: 0.25, output: 1.25, ...RETIRED },
    // A model of a family no row above names, such as a release newer than this table, at its family's newest price.
    // `fallback` makes a report name the model; add its own row once the page lists it.
    { match: 'fable', fallback: true, input: 8, output: 40, cacheRead: 0.025, ...READ },
    { match: 'mythos', fallback: true, input: 8, output: 40, cacheRead: 0.025, ...READ },
    { match: 'opus', fallback: true, input: 4, output: 20, cacheRead: 0.05, ...READ },
    { match: 'sonnet', fallback: true, input: 2, output: 10, cacheRead: 0.05, ...READ },
    { match: 'haiku', fallback: true, input: 0.1, output: 0.5, over: { prompt: 100_000, input: 0.5, output: 2.5 }, ...READ },
  ],
};
