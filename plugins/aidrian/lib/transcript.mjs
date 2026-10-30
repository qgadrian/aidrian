// Reads Claude Code transcripts (JSON Lines) for the dispatch log: token use per model, an estimated cost, the effort
// and tool calls of each request, the subagent transcripts of a session, and which files an agent read. Counts, names,
// and paths only; no message text leaves this file.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// USD per million tokens, matched by substring in this order (more specific first). List prices from
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-28. `cacheRead` is the cache-hit multiplier
// of the input rate where a model sets one below the standard 0.1x. Cache writes cost 1.25x (5 minutes) and 2x (1 hour).
export const PRICE_MAP = [
  { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.025 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.025 },
  { match: 'fable-5', input: 10, output: 50 },
  { match: 'mythos-5', input: 10, output: 50 },
  { match: 'opus-5-5', input: 4, output: 20, cacheRead: 0.05 },
  { match: 'opus-5', input: 5, output: 25 },
  { match: 'opus-4', input: 5, output: 25 },
  { match: 'sonnet-5-5', input: 2, output: 10, cacheRead: 0.05 },
  { match: 'sonnet-5', input: 2, output: 10 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'haiku-5-5', input: 0.1, output: 0.5 },
  { match: 'haiku', input: 1, output: 5 },
];
const CACHE_READ_MULT = 0.1;
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;

export const priceFor = (model) => PRICE_MAP.find((price) => typeof model === 'string' && model.includes(price.match));

const emptyUsage = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// Folds one API request's usage, and any advisor sub-inference in `usage.iterations`, into a per-model map.
function addRequest(perModel, model, usage) {
  const m = (perModel[model] ??= emptyUsage());
  m.calls += 1;
  m.input += usage.input_tokens ?? 0;
  m.output += usage.output_tokens ?? 0;
  m.cacheRead += usage.cache_read_input_tokens ?? 0;
  const created = usage.cache_creation;
  if (created && (created.ephemeral_5m_input_tokens || created.ephemeral_1h_input_tokens)) {
    m.cacheWrite5m += created.ephemeral_5m_input_tokens ?? 0;
    m.cacheWrite1h += created.ephemeral_1h_input_tokens ?? 0;
  } else {
    m.cacheWrite5m += usage.cache_creation_input_tokens ?? 0;
  }
  for (const step of Array.isArray(usage.iterations) ? usage.iterations : []) {
    if (step?.type !== 'advisor_message' || !step.model) continue;
    const a = (perModel[step.model] ??= emptyUsage());
    a.calls += 1;
    a.input += step.input_tokens ?? 0;
    a.output += step.output_tokens ?? 0;
    a.cacheRead += step.cache_read_input_tokens ?? 0;
    a.cacheWrite5m += step.cache_creation_input_tokens ?? 0;
  }
}

// The key a request's lines share: its message id, else its request id. A line with neither is a request of its own.
const requestKey = (entry) => [entry.message?.id, entry.requestId].find((each) => typeof each === 'string' && each !== '') ?? Symbol('unkeyed');

// Usage per model over transcript text, counted once per API request: Claude Code writes one line per content block,
// each repeating its request's usage, so a per-line sum bills a request several times. Lines group by `message.id`
// (else `requestId`), and the request's last line wins. Pass the previous result as `acc` to fold in more transcripts;
// a request found in two of them still counts once.
// Returns { perModel, firstTs, lastTs, requests, tools, effort, efforts }: `tools` maps a request to the ids of its
// tool calls; `effort` is the level the host stamped on the last request, null when it stamped none, and `efforts`
// every level seen.
export function aggregateUsage(text, acc = { firstTs: null, lastTs: null, requests: new Map(), tools: new Map(), effort: null, efforts: new Set() }) {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry.timestamp === 'string') {
      if (!acc.firstTs || entry.timestamp < acc.firstTs) acc.firstTs = entry.timestamp;
      if (!acc.lastTs || entry.timestamp > acc.lastTs) acc.lastTs = entry.timestamp;
    }
    const { usage, model, content } = entry.message ?? {};
    if (!usage || !model || model === '<synthetic>') continue;
    const key = requestKey(entry);
    acc.requests.set(key, { model, usage });
    acc.effort = typeof entry.effort === 'string' && entry.effort !== '' ? entry.effort : null;
    if (acc.effort) acc.efforts.add(acc.effort);
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_use') continue;
      if (!acc.tools.has(key)) acc.tools.set(key, new Set());
      acc.tools.get(key).add(block.id ?? Symbol('tool'));
    }
  }
  return { ...acc, perModel: partOf(acc).perModel };
}

// The usage per model and the request and tool-call counts of the requests in `acc` that `keep` takes by key:
// { perModel, requests, tool_requests, tool_calls }. `tool_requests` counts the requests that made a tool call.
export function partOf(acc, keep = () => true) {
  const out = { perModel: {}, requests: 0, tool_requests: 0, tool_calls: 0 };
  for (const [key, { model, usage }] of acc?.requests ?? []) {
    if (!keep(key)) continue;
    addRequest(out.perModel, model, usage);
    out.requests += 1;
    const calls = acc.tools.get(key)?.size ?? 0;
    out.tool_requests += calls ? 1 : 0;
    out.tool_calls += calls;
  }
  return out;
}

// Estimated USD in total and per model; a model the price map does not know is listed and costs nothing here.
export function estimateCostUsd(perModel) {
  let total = 0;
  const unknownModels = [];
  const byModel = {};
  for (const [model, u] of Object.entries(perModel)) {
    const price = priceFor(model);
    if (!price) {
      unknownModels.push(model);
      continue;
    }
    const inputRate = price.input / 1_000_000;
    const cost = u.input * inputRate + u.cacheRead * inputRate * (price.cacheRead ?? CACHE_READ_MULT) +
      u.cacheWrite5m * inputRate * CACHE_WRITE_5M_MULT + u.cacheWrite1h * inputRate * CACHE_WRITE_1H_MULT + (u.output * price.output) / 1_000_000;
    byModel[model] = Math.round(cost * 10000) / 10000;
    total += cost;
  }
  return { total: Math.round(total * 10000) / 10000, unknownModels, byModel };
}

// One token total over every model: { input, output, cache_read, cache_write, cache_write_5m, cache_write_1h }.
// `cache_write` is the sum of the two cache writes, which cost 1.25x and 2x the input price.
export function sumTokens(perModel) {
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 };
  for (const u of Object.values(perModel)) {
    total.input += u.input;
    total.output += u.output;
    total.cache_read += u.cacheRead;
    total.cache_write += u.cacheWrite5m + u.cacheWrite1h;
    total.cache_write_5m += u.cacheWrite5m;
    total.cache_write_1h += u.cacheWrite1h;
  }
  return total;
}

// The subagent transcripts of a session: `<transcript folder>/<session id>/subagents/*.jsonl`.
export function subagentTranscripts(transcriptPath, sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/u.test(sessionId)) return [];
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

// Every `file_path` the transcript's Read tool calls name, in order, once each. `keep` takes a request by key, as in
// partOf; the Read calls of a request it refuses are left out.
export function filesRead(text, keep = () => true) {
  const read = new Set();
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    const content = entry?.message?.content;
    if (!Array.isArray(content) || !keep(requestKey(entry))) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') read.add(block.input.file_path);
    }
  }
  return [...read];
}

export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function parseLine(line) {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
