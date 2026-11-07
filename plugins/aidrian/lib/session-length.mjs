// The session-length reminder behind the Stop hook and the plan-approval offer: what continuing a Claude Code session
// costs against a fresh one started from a handoff brief, read from its transcript, and what the hooks tell the agent
// once config.json `session.handoff` says it is time. docs/handoff.md describes the cost model and its constants.

import { aggregateUsage, CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, priceFor } from './transcript.mjs';

// B: the tokens a fresh session reads to resume from a brief, the measured median before its first edit or dispatch.
export const RESUME_TOKENS = 44_000;
// H: the calls the long session spends writing the brief, from the measured quartiles.
export const BRIEF_CALLS = 8;
// The brief's output, in tokens, and what an output token costs in input tokens.
const BRIEF_OUTPUT_TOKENS = 3_000;
const OUTPUT_MULT = 5;

const contextOf = (usage = {}) =>
  (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);

// What the cost model reads from a main-session transcript: { calls, first, last, model, oneHourCache, compactions }.
// `first` and `last` are the context of the first and the last model call; `model` is the last call's model;
// `oneHourCache` is whether any call wrote 1-hour cache; `compactions` counts the compact_boundary entries.
export function sessionUsage(text) {
  const requests = [...aggregateUsage(text).requests.values()];
  let compactions = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('compact_boundary')) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'system' && entry.subtype === 'compact_boundary') compactions += 1;
    } catch {
      // A line that is not JSON is no compaction.
    }
  }
  return {
    calls: requests.length,
    first: contextOf(requests[0]?.usage),
    last: contextOf(requests.at(-1)?.usage),
    model: requests.at(-1)?.model ?? null,
    oneHourCache: requests.some(({ usage }) => (usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0),
    compactions,
  };
}

// The cost of continuing against handing off, in input tokens of the last call's model: { ratio, breakEven }.
// `ratio` is r = C / (W + B), what each call here costs against one in a fresh session; 0 with no calls.
// `breakEven` is N, about how many calls the work left must take before a handoff pays back, or null when C ≤ W + B.
// `briefCalls` is H; 0 leaves out the calls that write the brief.
export function handoffCost({ calls, first, last, model, oneHourCache }, { briefCalls = BRIEF_CALLS } = {}) {
  if (!calls) return { ratio: 0, breakEven: null };
  const fresh = first + RESUME_TOKENS;
  const ratio = last / fresh;
  if (last <= fresh) return { ratio, breakEven: null };
  const read = priceFor(model)?.cacheRead ?? CACHE_READ_MULT;
  const write = oneHourCache ? CACHE_WRITE_1H_MULT : CACHE_WRITE_5M_MULT;
  const cost = write * fresh + OUTPUT_MULT * BRIEF_OUTPUT_TOKENS + briefCalls * read * last;
  return { ratio, breakEven: cost / (read * (last - fresh)) };
}

// The ratio at which the cost trigger fires next: costRatio while it has not fired since the last reset (`lastRatio` 0),
// then twice the ratio of its last firing, and never below costRatio, which config.json may raise mid-session.
// Anchored on the ratio the session actually reached, so a session that keeps going is reminded a few times at most,
// and a jump far past costRatio comes back at twice where it landed.
export const nextRatio = (costRatio, lastRatio) => (lastRatio > 0 ? Math.max(costRatio, 2 * lastRatio) : costRatio);

// The context at which the token ceiling fires after `fired` firings; 0 is off.
export const tokenCeiling = (maxTokens, fired) => maxTokens * 2 ** fired;

// The ceiling's firing count after a firing at `value`: past every doubling `value` reached, so a context that jumped
// two of them in one turn is not reminded again at the next turn's end. Computed, not counted step by step; the guard
// only corrects the rounding of the logarithm, so it runs at most a few times.
function passed(value, fired, estimate, at) {
  let next = Math.max(fired + 1, estimate);
  while (value >= at(next)) next += 1;
  return next;
}
const tokensPassed = (context, maxTokens, fired) =>
  passed(context, fired, Math.floor(Math.log2(context / maxTokens)) + 1, (n) => tokenCeiling(maxTokens, n));

// What a marker holds: { lastRatio, tokens, compactions }, the cost ratio at the last cost firing (0 for none), the
// ceiling's firing count, and the compactions seen. No marker is none. A marker older versions wrote reads as follows.
// A mode word or one count is one firing of each trigger, the cost one at `costRatio`, at the session's current
// `compactions`. A JSON marker from v0.28.0 to v0.47.0 keeps its own `tokens` and `compactions`, and its `ratio`
// count reads as a cost firing at `costRatio` when above 0, or as no cost firing at 0. So an old marker that recorded a
// cost firing never brings the cost reminder back sooner than twice costRatio.
export function readMarker(text, compactions, costRatio) {
  if (text === null || text === undefined) return { lastRatio: 0, tokens: 0, compactions: 0 };
  let marker;
  try {
    marker = JSON.parse(text);
  } catch {
    marker = null;
  }
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return { lastRatio: costRatio, tokens: 1, compactions };
  const count = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
  const { lastRatio } = marker;
  const last = Number.isFinite(lastRatio) && lastRatio > 0 ? lastRatio : count(marker.ratio) > 0 ? costRatio : 0;
  return { lastRatio: last, tokens: count(marker.tokens), compactions: count(marker.compactions) };
}

const round = (value) => String(Number(value.toFixed(2)));
const kTokens = (tokens) => `${Math.round(tokens / 1000)}k tokens of context`;
const costLine = ({ ratio, breakEven }) =>
  `each call costs ${ratio.toFixed(1)} times what it would in a fresh session started from a handoff brief, ` +
  `and a handoff pays back after about ${Math.round(breakEven)} more model calls, an estimate`;

// What the Stop hook does, or null: { reason, marker }. `handoff` is config.json `session.handoff`, `markerText` the
// marker's text or null. A compaction since the marker resets both triggers, so the session is reminded from costRatio
// again. A firing changes only what the trigger that fired holds: the cost one records its ratio, the ceiling raises its
// count past every doubling it reached.
export function stopReminder(text, handoff, markerText) {
  const usage = sessionUsage(text);
  if (!usage.calls) return null;
  let counts = readMarker(markerText, usage.compactions, handoff.costRatio);
  if (usage.compactions > counts.compactions) counts = { lastRatio: 0, tokens: 0, compactions: usage.compactions };
  const cost = handoffCost(usage);
  const ceiling = tokenCeiling(handoff.maxTokens, counts.tokens);
  const byCost = cost.breakEven !== null && cost.ratio >= nextRatio(handoff.costRatio, counts.lastRatio);
  const byTokens = handoff.maxTokens > 0 && usage.last >= ceiling;
  if (!byCost && !byTokens) return null;
  const marker = {
    lastRatio: byCost ? cost.ratio : counts.lastRatio,
    tokens: byTokens ? tokensPassed(usage.last, handoff.maxTokens, counts.tokens) : counts.tokens,
    compactions: usage.compactions,
  };
  const next = [];
  if (byTokens) next.push(`the context reaches ${Math.round(tokenCeiling(handoff.maxTokens, marker.tokens) / 1000)}k tokens`);
  if (byCost) next.push(`each call costs ${round(nextRatio(handoff.costRatio, marker.lastRatio))} times what a fresh session's would`);
  return {
    reason: handoffReason(handoff.mode, { cost: byCost ? cost : null, tokens: byTokens ? usage.last : null, next }),
    marker,
  };
}

// What the user said that makes a handoff not worth it: a fresh session needs someone to start it.
const USER_SAID = 'the user already said to finish here or that they are not watching';

// When a handoff costs more than it saves, and what the agent does then: nothing. The agent judges these; the hook cannot
// see them.
const notWorthIt = (cost, next) => 'Judge first whether a handoff is worth it. It is not when the task is done or nearly done, ' +
  (cost ? 'or the work left takes fewer model calls than the handoff needs to pay back, ' : '') +
  'when a subagent or background job is still running and its result comes back to this session, ' +
  `or when ${USER_SAID}: then end this turn without mentioning this reminder, ` +
  `which comes back once ${next.join(' or ')}. `;

// The message that sends the agent back for one more turn, in `ask` or `auto` mode. Doing nothing is a valid answer.
// `cost` is handoffCost's result when the cost trigger fired, `tokens` the context when the ceiling did, and `next`
// says when each comes back.
export function handoffReason(mode, { cost = null, tokens = null, next }) {
  const found = [tokens !== null && kTokens(tokens), cost && costLine(cost)].filter(Boolean).join(', and ');
  const why = cost ? '' : 'A fresh session started from a handoff brief works from a smaller context. ';
  const head = `This session is long: ${found}. ${why}${notWorthIt(cost, next)}`;
  if (mode === 'auto') {
    return `${head}Otherwise run the session-handoff skill now to write the brief, ` +
      'then tell the user in one line that you wrote it, its path, and that the session-continue skill resumes it.';
  }
  return `${head}Otherwise end this turn with one short question to the user: hand off now, or keep going? ` +
    'If they choose to hand off, run the session-handoff skill; if they keep going, carry on.';
}

// What the plan hook adds once the Human approves a plan, or null. Halfway to costRatio is enough here: the plan is on
// disk and nothing is in flight, so a handoff costs least at this moment, and the build would carry the whole planning
// context. It fires at r ≥ 1 + (costRatio − 1) / 2, halfway from a fresh session's 1 to costRatio, or at half of
// maxTokens when the ceiling is set.
export function planApprovedContext(handoff, usage) {
  if (handoff.mode === 'off' || !usage.calls) return null;
  const cost = handoffCost(usage);
  const byCost = cost.breakEven !== null && cost.ratio >= 1 + (handoff.costRatio - 1) / 2;
  const byTokens = handoff.maxTokens > 0 && usage.last >= Math.ceil(handoff.maxTokens / 2);
  if (!byCost && !byTokens) return null;
  const found = [byTokens && `this session already carries ${kTokens(usage.last)}`, byCost && costLine(cost)].filter(Boolean).join(', and ');
  const head = `The plan is approved, and ${found}. ` +
    'Building in a fresh session that reads the plan costs less per turn, and now no worktree, branch, or running agent needs a brief. ';
  if (handoff.mode === 'auto') {
    return `${head}Before the first build step, run the session-handoff skill to write the brief, then tell the user its path and that ` +
      `the session-continue skill resumes it. Build here instead when the rest takes a few calls, or when ${USER_SAID}.`;
  }
  return `${head}Before the first build step, ask the user one short question: hand off now, or build here? ` +
    `Skip the question when the rest takes a few calls, or when ${USER_SAID}.`;
}
