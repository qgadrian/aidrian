// The session-length reminder behind the Stop hook: how long a Claude Code session is, read from its transcript, and what
// the hook tells the agent once config.json `session` limits are passed. docs/hooks.md#session-length describes it.

import { aggregateUsage } from './transcript.mjs';

const HOUR_MS = 3_600_000;

// { tokens, calls, hours } of a main-session transcript: the context the last API request read, the API requests made,
// and the hours worked, where a pause of more than an hour counts as one hour, so a night away is not a long session.
export function sessionLength(text) {
  const { requests } = aggregateUsage(text);
  const usage = [...requests.values()].at(-1)?.usage ?? {};
  const tokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  let worked = 0;
  let previous = null;
  for (const line of text.split('\n')) {
    let time;
    try {
      time = Date.parse(JSON.parse(line).timestamp);
    } catch {
      continue;
    }
    if (Number.isNaN(time)) continue;
    if (previous !== null && time > previous) worked += Math.min(time - previous, HOUR_MS);
    previous = Math.max(previous ?? time, time);
  }
  return { tokens, calls: requests.size, hours: worked / HOUR_MS };
}

// What passed its limit, such as ["212k tokens of context"]. A limit of 0 is off. A transcript with no Claude Code usage
// passes nothing: another host's format is not read as a session.
export function overLimits({ tokens, calls, hours }, { maxTokens, maxCalls, maxHours }) {
  if (calls === 0) return [];
  const over = [];
  if (maxTokens && tokens >= maxTokens) over.push(`${Math.round(tokens / 1000)}k tokens of context`);
  if (maxCalls && calls >= maxCalls) over.push(`${calls} model calls`);
  if (maxHours && hours >= maxHours) over.push(`${hours.toFixed(1)} hours of work`);
  return over;
}

// The message that sends the agent back for one more turn, in `ask` or `auto` mode.
export function handoffReason(mode, over) {
  const head = `This session is long: ${over.join(', ')}. A fresh session started from a handoff brief costs less per turn.`;
  if (mode === 'auto') {
    return `${head} Run the session-handoff skill now to write the brief, unless the task is done and nothing is left to resume. ` +
      'Then tell the user in one line that you wrote it, its path, and that a fresh session resumes it with the session-continue skill. ' +
      'This reminder does not come back in this session.';
  }
  return `${head} End this turn with one short question to the user: hand off now, or keep going? ` +
    'If they choose to hand off, run the session-handoff skill. If they keep going, carry on: this question does not come back in this session. ' +
    'Do no other work before you ask.';
}

// What the plan hook adds once the Human approves a plan, or null. Half a limit is enough here: the plan is on disk and
// nothing is in flight, so a handoff costs least at this moment, and the build would carry the whole planning context.
export function planApprovedContext(mode, length, limits) {
  if (mode === 'off') return null;
  const half = overLimits(length, {
    maxTokens: Math.ceil(limits.maxTokens / 2),
    maxCalls: Math.ceil(limits.maxCalls / 2),
    maxHours: limits.maxHours / 2,
  });
  if (!half.length) return null;
  const head = `The plan is approved, and this session already carries ${half.join(', ')}. ` +
    'Building in a fresh session that reads the plan costs less per turn, and now no worktree, branch, or running agent needs a brief. ';
  if (mode === 'auto') {
    return `${head}Before the first build step, run the session-handoff skill to write the brief, then tell the user its path and that ` +
      'the session-continue skill resumes it. Build here instead only when the rest takes a few calls.';
  }
  return `${head}Before the first build step, ask the user one short question: hand off now, or build here? ` +
    'Skip the question only when the rest takes a few calls.';
}
