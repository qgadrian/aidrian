// Reads Claude Code transcripts (JSON Lines) for the dispatch log: token use per model, an estimated cost, the subagent
// transcripts of a session, and which files an agent read. Counts and paths only; no message text leaves this file.

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

// Usage per model over transcript text, counted once per API request: Claude Code writes one line per content block,
// each repeating its request's usage, so a per-line sum bills a request several times. Lines group by `message.id`
// (else `requestId`), and the request's last line wins. Pass the previous result as `acc` to fold in more transcripts;
// a request found in two of them still counts once. Returns { perModel, firstTs, lastTs, requests }.
export function aggregateUsage(text, acc = { firstTs: null, lastTs: null, requests: new Map() }) {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry.timestamp === 'string') {
      if (!acc.firstTs || entry.timestamp < acc.firstTs) acc.firstTs = entry.timestamp;
      if (!acc.lastTs || entry.timestamp > acc.lastTs) acc.lastTs = entry.timestamp;
    }
    const { usage, model, id } = entry.message ?? {};
    if (!usage || !model || model === '<synthetic>') continue;
    const key = [id, entry.requestId].find((each) => typeof each === 'string' && each !== '') ?? Symbol('unkeyed');
    acc.requests.set(key, { model, usage });
  }
  const perModel = {};
  for (const { model, usage } of acc.requests.values()) addRequest(perModel, model, usage);
  return { ...acc, perModel };
}

// Estimated USD per model and in total; a model the price map does not know is listed and costs nothing here.
export function estimateCostUsd(perModel) {
  let total = 0;
  const unknownModels = [];
  for (const [model, u] of Object.entries(perModel)) {
    const price = priceFor(model);
    if (!price) {
      unknownModels.push(model);
      continue;
    }
    const inputRate = price.input / 1_000_000;
    total += u.input * inputRate + u.cacheRead * inputRate * (price.cacheRead ?? CACHE_READ_MULT) +
      u.cacheWrite5m * inputRate * CACHE_WRITE_5M_MULT + u.cacheWrite1h * inputRate * CACHE_WRITE_1H_MULT + (u.output * price.output) / 1_000_000;
  }
  return { total: Math.round(total * 10000) / 10000, unknownModels };
}

// One token total over every model: { input, output, cache_read, cache_write }.
export function sumTokens(perModel) {
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const u of Object.values(perModel)) {
    total.input += u.input;
    total.output += u.output;
    total.cache_read += u.cacheRead;
    total.cache_write += u.cacheWrite5m + u.cacheWrite1h;
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

// Every `file_path` the transcript's Read tool calls name, in order, once each.
export function filesRead(text) {
  const read = new Set();
  for (const line of text.split('\n')) {
    const content = parseLine(line)?.message?.content;
    if (!Array.isArray(content)) continue;
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
