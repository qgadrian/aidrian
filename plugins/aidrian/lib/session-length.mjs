// The session-length reminder behind the Stop hook and the plan-approval offer: what continuing a Claude Code session
// costs against a fresh one started from a handoff brief, read from its transcript, and what the hooks tell the agent
// once config.json `session.handoff` says it is time. docs/handoff.md describes the cost model and its constants.
// Both texts follow the route the session goes on by after its handoff, `session.handoff.continue` as the host can do it
// (continuation); with `none` they are what they were before the routes existed.

import { continueRoutes } from './hosts/index.mjs';
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_5M_MULT, priceFor } from './model-prices.mjs';
import { aggregateUsage } from './transcript.mjs';

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
// then, in `ask` mode, twice the ratio of its last firing, and never below costRatio, which config.json may raise
// mid-session. Anchored on the ratio the session actually reached, so a session that keeps going is asked a few times at
// most, and a jump far past costRatio comes back at twice where it landed.
// In `auto` mode a skipped firing costs the Human nothing, so the reminder comes back a step above its last firing, not
// at double: the step is costRatio − 1, at least 1, so 2, 3, 4 by default. A step of 1 is one more fresh session's worth
// of context, about 74,000 more tokens at a 30,000-token baseline, so even a costRatio of 1.1 does not fire at nearly
// every stop.
export const nextRatio = (costRatio, lastRatio, mode = 'ask') => {
  if (!(lastRatio > 0)) return costRatio;
  const next = mode === 'auto' ? lastRatio + Math.max(costRatio - 1, 1) : 2 * lastRatio;
  return Math.max(costRatio, next);
};

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
// cost firing brings the cost reminder back at the next firing after costRatio in the current mode (nextRatio): twice
// costRatio in `ask`, a step above it in `auto`.
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

// Whether the plan offer's threshold holds: { byCost, byTokens }. Halfway from a fresh session's 1 to costRatio,
// r ≥ 1 + (costRatio − 1) / 2, with a break-even, or half of maxTokens when the ceiling is set. `cost` is handoffCost's.
function offerReached(handoff, usage, cost) {
  return {
    byCost: cost.breakEven !== null && cost.ratio >= 1 + (handoff.costRatio - 1) / 2,
    byTokens: handoff.maxTokens > 0 && usage.last >= Math.ceil(handoff.maxTokens / 2),
  };
}

// The one trigger decision the Stop hook and any reader share, from sessionUsage's `usage`, config.json
// `session.handoff`, and the marker's text or null: { ratio, breakEven, level, nextRatio, context, ceiling, byCost,
// byTokens, counts }. `counts` is the marker after the compaction reset: a compaction since the marker resets both
// triggers. `byCost` and `byTokens` say whether each trigger fires on its own; `nextRatio` is the ratio the cost trigger
// fires at, `ceiling` the context the token one fires at, or null when it is off. It reads `mode` only for the step of
// nextRatio, as the Stop hook does, so `off` is the caller's to honour. `level` names the first that holds of:
// - `ceiling`: the token trigger fires; `due`: the cost trigger fires.
// - `reminded`: the marker records a firing, and the trigger that fired still holds at its first threshold, the ratio at
//   or past costRatio with a break-even, or the context at or past maxTokens.
// - `offer`: the plan offer's threshold holds; `quiet`: none does.
export function handoffStatus(usage, handoff, markerText) {
  let counts = readMarker(markerText, usage.compactions, handoff.costRatio);
  if (usage.compactions > counts.compactions) counts = { lastRatio: 0, tokens: 0, compactions: usage.compactions };
  const cost = handoffCost(usage);
  const next = nextRatio(handoff.costRatio, counts.lastRatio, handoff.mode);
  const ceiling = handoff.maxTokens > 0 ? tokenCeiling(handoff.maxTokens, counts.tokens) : null;
  const byCost = cost.breakEven !== null && cost.ratio >= next;
  const byTokens = ceiling !== null && usage.last >= ceiling;
  const held = (counts.lastRatio > 0 && cost.breakEven !== null && cost.ratio >= handoff.costRatio) ||
    (counts.tokens > 0 && handoff.maxTokens > 0 && usage.last >= handoff.maxTokens);
  const offer = offerReached(handoff, usage, cost);
  const level = [[byTokens, 'ceiling'], [byCost, 'due'], [held, 'reminded'], [offer.byCost || offer.byTokens, 'offer']]
    .find(([holds]) => holds)?.[1] ?? 'quiet';
  return { ...cost, level, nextRatio: next, context: usage.last, ceiling, byCost, byTokens, counts };
}

// What the Stop hook does, or null: { reason, marker }. `handoff` is config.json `session.handoff`, `markerText` the
// marker's text or null; handoffStatus decides whether a trigger fires. A firing changes only what the trigger that fired
// holds: the cost one records its ratio, the ceiling raises its count past every doubling it reached. `continuation` is
// the hooks' { route, how }.
export function stopReminder(text, handoff, markerText, continuation = {}) {
  const usage = sessionUsage(text);
  if (!usage.calls) return null;
  const { ratio, breakEven, byCost, byTokens, counts } = handoffStatus(usage, handoff, markerText);
  if (!byCost && !byTokens) return null;
  const marker = {
    lastRatio: byCost ? ratio : counts.lastRatio,
    tokens: byTokens ? tokensPassed(usage.last, handoff.maxTokens, counts.tokens) : counts.tokens,
    compactions: usage.compactions,
  };
  const next = [];
  if (byTokens) next.push(`the context reaches ${Math.round(tokenCeiling(handoff.maxTokens, marker.tokens) / 1000)}k tokens`);
  if (byCost) next.push(`each call costs ${round(nextRatio(handoff.costRatio, marker.lastRatio, handoff.mode))} times what a fresh session's would`);
  return {
    reason: handoffReason(handoff.mode, { cost: byCost ? { ratio, breakEven } : null, tokens: byTokens ? usage.last : null, next, ...continuation }),
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

// The route the hooks word a handoff for, from config.json `session.handoff` and the session's host: { route, how },
// where `how` is the host's phrase for what the route takes from the Human (its adapter's `steps[route]`). The gate's
// module, which decides the route for the command too, loads only when the config asks for a route the host has.
export async function continuation(handoff, host) {
  if ((handoff.continue ?? 'none') === 'none' || !continueRoutes(host).length) return { route: 'none', how: null };
  const { effectiveRoute } = await import('./handoff-continue.mjs');
  const { route } = effectiveRoute(handoff.continue, host);
  return { route, how: route === 'none' ? null : host.capabilities.handoffContinue.steps?.[route] ?? null };
}

// With the clear route, the session-handoff skill's continue step arms the continuation after the brief and prints the
// line for the Human, who then clears the session: this one does nothing more.
const continues = ({ route, how }) => route === 'clear' && typeof how === 'string';
const SET_UP = 'to write the brief and set up the continuation: its continue step prints what to tell the user. Say that in one line';
const askHow = (how) => `Say in it what a handoff takes from them: ${how}. `;

// The message that sends the agent back for one more turn, in `ask` or `auto` mode. Doing nothing is a valid answer.
// `cost` is handoffCost's result when the cost trigger fired, `tokens` the context when the ceiling did, and `next`
// says when each comes back. `route` and `how` are continuation's.
export function handoffReason(mode, { cost = null, tokens = null, next, route = 'none', how = null }) {
  const found = [tokens !== null && kTokens(tokens), cost && costLine(cost)].filter(Boolean).join(', and ');
  const why = cost ? '' : 'A fresh session started from a handoff brief works from a smaller context. ';
  const head = `This session is long: ${found}. ${why}${notWorthIt(cost, next)}`;
  const clear = continues({ route, how });
  if (mode === 'auto') {
    if (clear) return `${head}Otherwise run the session-handoff skill now ${SET_UP}, then end this turn.`;
    return `${head}Otherwise run the session-handoff skill now to write the brief, ` +
      'then tell the user in one line that you wrote it, its path, and that the session-continue skill resumes it.';
  }
  return `${head}Otherwise end this turn with one short question to the user: hand off now, or keep going? ` +
    (clear ? askHow(how) : '') +
    'If they choose to hand off, run the session-handoff skill; if they keep going, carry on.';
}

// What the plan hook adds once the Human approves a plan, or null. Halfway to costRatio is enough here: the plan is on
// disk and nothing is in flight, so a handoff costs least at this moment, and the build would carry the whole planning
// context. It fires at r ≥ 1 + (costRatio − 1) / 2, halfway from a fresh session's 1 to costRatio, or at half of
// maxTokens when the ceiling is set (offerReached, which handoffStatus's `offer` reads too). `continuation` is the hooks'
// { route, how }: with the clear route the build starts in the session the clear begins, never here.
export function planApprovedContext(handoff, usage, { route = 'none', how = null } = {}) {
  if (handoff.mode === 'off' || !usage.calls) return null;
  const cost = handoffCost(usage);
  const { byCost, byTokens } = offerReached(handoff, usage, cost);
  if (!byCost && !byTokens) return null;
  const found = [byTokens && `this session already carries ${kTokens(usage.last)}`, byCost && costLine(cost)].filter(Boolean).join(', and ');
  const head = `The plan is approved, and ${found}. ` +
    'Building in a fresh session that reads the plan costs less per turn, and now no worktree, branch, or running agent needs a brief. ';
  const clear = continues({ route, how });
  if (handoff.mode === 'auto') {
    if (clear) {
      return `${head}Build here when the rest takes a few calls, or when ${USER_SAID}. ` +
        `Otherwise, before the first build step, run the session-handoff skill ${SET_UP}, end this turn, and do not start the build here.`;
    }
    return `${head}Before the first build step, run the session-handoff skill to write the brief, then tell the user its path and that ` +
      `the session-continue skill resumes it. Build here instead when the rest takes a few calls, or when ${USER_SAID}.`;
  }
  return `${head}Before the first build step, ask the user one short question: hand off now, or build here? ` +
    (clear ? askHow(how) : '') +
    `Skip the question when the rest takes a few calls, or when ${USER_SAID}.`;
}
