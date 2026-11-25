// `aidrian report sessions`: what sessions cost, split between the main conversation and its subagents, and per day,
// model, and effort, from the dispatch log's `session` rows. docs/dispatch-log.md#sessions describes the view.

import { loggedCost, loggedNote, money } from './dispatch-log.mjs';
import { endedSessions } from './jsonl.mjs';
import { priceFor, rowCostUsd } from './model-prices.mjs';

// The view lists this many sessions, most costly first.
const TOP_SESSIONS = 5;

const round = (usd) => Math.round(usd * 100) / 100;
const TOKEN_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h'];
const addTokens = (sum, tokens) => {
  for (const key of TOKEN_KEYS) sum[key] += Number.isFinite(tokens?.[key]) ? tokens[key] : 0;
  return sum;
};
const noTokens = () => Object.fromEntries(TOKEN_KEYS.map((key) => [key, 0]));
const allTokens = (tokens) => tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;

// One side of the sessions, main conversation or subagents: tokens, cost at today's prices and as logged, requests, and
// tool calls summed. `cost` is the side's rowCostUsd.
function addSide(sum, side, cost) {
  addTokens(sum.tokens, side.tokens);
  sum.cost_usd += cost.usd;
  sum.cost_logged_usd += cost.logged;
  for (const key of ['requests', 'tool_requests', 'tool_calls']) sum[key] += side[key] ?? 0;
  return sum;
}
const noSide = () => ({ tokens: noTokens(), cost_usd: 0, cost_logged_usd: 0, requests: 0, tool_requests: 0, tool_calls: 0 });
// A side's cost: its own tokens per model, or its summed tokens priced as the session's one model (model-prices.mjs rowCostUsd).
const sideCost = (row, side) => rowCostUsd({ models: row.models, ...side });

// Sessions that ended since `sinceMs`. A session resumed and ended again writes another row with its whole transcript,
// so the last row per session counts and the earlier ones are left out. `without_split` counts the rows written before
// session rows carried the main and subagent sides, the cache-write split, effort, and cost per model: the main,
// subagent, cache-write, and per-model figures leave them out. Costs are at today's prices (model-prices.mjs
// rowCostUsd), with `cost_logged_usd` what the rows logged; `kept_logged` counts the sessions whose total could not be
// priced again, and `sides_kept_logged` those with a main or subagent side that could not, with the dollars each kept.
export function summarizeSessions(rows, { sinceMs = 0 } = {}) {
  const ended = rows.filter((row) => row.event === 'session' && Date.parse(row.ts) >= sinceMs);
  const sessions = endedSessions(ended);
  const costs = new Map(sessions.map((row) => [row, rowCostUsd(row)]));
  const usd = (row) => costs.get(row).usd;
  const split = sessions.filter((row) => row.main && row.subagents);
  const sides = new Map(split.map((row) => [row, { main: sideCost(row, row.main), subagents: sideCost(row, row.subagents) }]));
  const main = split.reduce((sum, row) => addSide(sum, row.main, sides.get(row).main), noSide());
  const subagents = split.reduce((sum, row) => addSide(sum, row.subagents, sides.get(row).subagents), noSide());
  const keptSides = split.map((row) => Object.values(sides.get(row)).filter((cost) => !cost.exact)).filter((kept) => kept.length);
  const keptTotals = sessions.filter((row) => !costs.get(row).exact);
  const group = (keyOf) => {
    const groups = new Map();
    for (const row of sessions) {
      const key = keyOf(row);
      const entry = groups.get(key) ?? { sessions: 0, cost_usd: 0 };
      entry.sessions += 1;
      entry.cost_usd += usd(row);
      groups.set(key, entry);
    }
    return [...groups].map(([key, entry]) => ({ key, sessions: entry.sessions, cost_usd: round(entry.cost_usd) }));
  };
  const models = new Map();
  for (const row of split) {
    for (const [model, tokens] of Object.entries(row.tokens_by_model ?? {})) {
      const entry = models.get(model) ?? { model, cost_usd: 0, tokens: 0 };
      entry.cost_usd += costs.get(row).by_model[model] ?? 0;
      entry.tokens += allTokens(addTokens(noTokens(), tokens));
      models.set(model, entry);
    }
  }
  const finish = (total) => ({ ...total, cost_usd: round(total.cost_usd), cost_logged_usd: round(total.cost_logged_usd) });
  const ends = new Map();
  for (const { session_id: id } of ended) if (id) ends.set(id, (ends.get(id) ?? 0) + 1);
  const total = (list, valueOf) => list.reduce((sum, item) => sum + valueOf(item), 0);
  return {
    count: sessions.length,
    ended_more_than_once: [...ends.values()].filter((count) => count > 1).length,
    without_split: sessions.length - split.length,
    cost_usd: round(total(sessions, usd)),
    cost_logged_usd: round(total(sessions, (row) => costs.get(row).logged)),
    kept_logged: { sessions: keptTotals.length, cost_usd: round(total(keptTotals, usd)) },
    sides_kept_logged: { sessions: keptSides.length, cost_usd: round(total(keptSides.flat(), (cost) => cost.usd)) },
    main: finish(main),
    subagents: finish(subagents),
    by_day: group((row) => row.ts.slice(0, 10)).map(({ key, ...rest }) => ({ day: key, ...rest })).sort((a, b) => a.day.localeCompare(b.day)),
    // A model no price table knows today costs $0 in every figure; this names it.
    unknown_models: [...new Set(sessions.flatMap((row) => [...(Array.isArray(row.models) ? row.models : []), ...Object.keys(row.tokens_by_model ?? {})])
      .filter((model) => typeof model === 'string' && !priceFor(model)))].sort(),
    by_model: [...models.values()].map((entry) => ({ ...entry, cost_usd: round(entry.cost_usd) })).sort((a, b) => b.cost_usd - a.cost_usd || b.tokens - a.tokens),
    by_effort: group((row) => row.effort ?? null).map(({ key, ...rest }) => ({ effort: key, ...rest })).sort((a, b) => b.cost_usd - a.cost_usd),
    top: [...sessions].sort((a, b) => usd(b) - usd(a)).slice(0, TOP_SESSIONS).map((row) => ({
      session_id: row.session_id,
      ts: row.ts,
      agent: row.agent ?? null,
      effort: row.effort ?? null,
      duration_min: row.duration_min ?? null,
      cost_usd: usd(row),
      cost_logged_usd: costs.get(row).logged,
      main_cost_usd: sides.get(row)?.main.usd ?? null,
      subagents_cost_usd: sides.get(row)?.subagents.usd ?? null,
    })),
  };
}

const tokenCount = (count) => (count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : `${Math.round(count / 1000)}k`);
const percentOf = (part, whole) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '');
const share = (part, whole) => (whole > 0 ? ` (${percentOf(part, whole)})` : '');
// A side's share of both sides' cost, and its logged cost when today's prices moved it: ` (80%; logged $6.00)`.
const sideShare = (line, whole) => {
  const parts = [percentOf(line.cost_usd, whole), loggedCost(line.cost_usd, line.cost_logged_usd)].filter(Boolean);
  return parts.length ? ` (${parts.join('; ')})` : '';
};
const perToolRequest = (side) => (side.tool_requests ? (side.tool_calls / side.tool_requests).toFixed(2) : '-');
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function formatSessions(summary, { file, since, skipped, notes = [] }) {
  const lines = [`Sessions, from ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}; costs at today's list prices`, ...notes];
  if (summary.without_split) {
    lines.push(`Partial: ${summary.without_split} of ${plural(summary.count, 'session')} were logged before the main and subagent split; ` +
      'the main, subagent, cache-write, and per-model lines leave them out.');
  }
  const kept = summary.kept_logged ?? { sessions: 0 };
  if (kept.sessions) {
    lines.push(`Partial: ${kept.sessions} of ${plural(summary.count, 'session')} were logged without the tokens to price them again, ` +
      `and keep their logged cost, ${money(kept.cost_usd)}.`);
  }
  const keptSides = summary.sides_kept_logged ?? { sessions: 0 };
  if (keptSides.sessions) {
    lines.push(`Partial: the main and subagent lines keep the logged cost, ${money(keptSides.cost_usd)}, of ` +
      `${plural(keptSides.sessions, 'session')} logged without the tokens to price each side again.`);
  }
  if (!summary.count) return [...lines, 'No sessions yet.'].join('\n');
  const { main, subagents } = summary;
  const twice = summary.ended_more_than_once ? `; ${summary.ended_more_than_once} ended more than once, counted at the last end` : '';
  const sides = main.cost_usd + subagents.cost_usd;
  const writes = main.tokens.cache_write + subagents.tokens.cache_write;
  const hour = main.tokens.cache_write_1h + subagents.tokens.cache_write_1h;
  lines.push(
    `${plural(summary.count, 'session')}, ${money(summary.cost_usd)} estimated${loggedNote(summary.cost_usd, summary.cost_logged_usd)}${twice}`,
    ...(summary.unknown_models?.length ? [`Unpriced models, counted as $0: ${summary.unknown_models.join(', ')}`] : []),
    `Main conversation: ${money(main.cost_usd)}${sideShare(main, sides)}, ` +
      `${tokenCount(allTokens(main.tokens))} tokens, ${perToolRequest(main)} tool calls per request that made one`,
    `Subagents: ${money(subagents.cost_usd)}${sideShare(subagents, sides)}, ` +
      `${tokenCount(allTokens(subagents.tokens))} tokens, ${perToolRequest(subagents)} tool calls per request that made one`,
    `Cache writes: ${tokenCount(writes)} tokens; 1-hour ${tokenCount(hour)}${share(hour, writes)} at 2x the input price, ` +
      `5-minute ${tokenCount(writes - hour)} at 1.25x`,
    'Per day:',
    ...summary.by_day.map((day) => `  ${day.day}  ${plural(day.sessions, 'session').padEnd(12)}  ${money(day.cost_usd).padStart(9)}`),
  );
  if (summary.by_model.length) {
    const width = Math.max(...summary.by_model.map((model) => model.model.length));
    lines.push('Per model:', ...summary.by_model.map((model) =>
      `  ${model.model.padEnd(width)}  ${money(model.cost_usd).padStart(9)}  ${tokenCount(model.tokens)} tokens`));
  }
  lines.push('Per effort (the main conversation at its last request):', ...summary.by_effort.map((effort) =>
    `  ${(effort.effort ?? '-').padEnd(6)}  ${plural(effort.sessions, 'session').padEnd(12)}  ${money(effort.cost_usd).padStart(9)}`));
  lines.push(`Most costly sessions, top ${summary.top.length}:`, ...summary.top.map((session) => {
    const details = [session.agent, session.effort, session.duration_min === null ? null : `${Math.round(session.duration_min)} min`].filter(Boolean);
    const split = session.main_cost_usd === null ? '' : `; main ${money(session.main_cost_usd)}, subagents ${money(session.subagents_cost_usd)}`;
    return `  ${money(session.cost_usd).padStart(9)}  ${session.ts.slice(0, 16).replace('T', ' ')}  ${session.session_id}` +
      `${details.length ? `  ${details.join(', ')}` : ''}${split}`;
  }));
  return lines.join('\n');
}
