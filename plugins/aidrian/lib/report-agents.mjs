// The default view of `aidrian report`: per agent type, its dispatches, runs, cost, delivery, and doc reads from the
// dispatch log, then the blocks by the plugin's own rules. docs/dispatch-log.md describes the view.

import { docsRead, sendBackStates } from './dispatch-log.mjs';
import { latestRows as latest } from './jsonl.mjs';
import { REPEATED_DENIALS } from './lesson-signals.mjs';

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const sum = (rows, valueOf) => rows.reduce((total, row) => total + (valueOf(row) ?? 0), 0);

// Aggregates rows newer than `sinceMs`. A stop row repeats when its agent was sent back; the last one counts. A run is
// one subagent that stopped. The share sent back leaves out the runs whose send-back is unknown (sendBackStates), which
// `runs_without_send_back` counts; the averages of docs read, the runs logged with doc reads off; those of bytes read,
// also the runs whose docs were logged before sizes; tool calls per request, the runs logged before tool counts, which
// `runs_without_tool_counts` counts. The rates are rounded for the view; `redispatched` and `sent_back` count exactly.
export function summarize(rows, { sinceMs = 0 } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs && ['dispatch', 'stop', 'session'].includes(row.event));
  const dispatches = fresh.filter((row) => row.event === 'dispatch');
  const stops = latest(fresh, 'stop', 'agent_id');
  const sessions = latest(fresh, 'session', 'session_id');
  const dispatched = new Set(dispatches.map((row) => row.agent_id).filter(Boolean));
  const sentBack = sendBackStates(fresh.filter((row) => row.event === 'stop'));
  const types = [...new Set([...dispatches, ...stops].map((row) => row.agent_type))].sort();
  const agents = types.map((type) => {
    const sent = dispatches.filter((row) => row.agent_type === type);
    const done = stops.filter((row) => row.agent_type === type);
    const tasks = new Set(sent.map((row) => `${row.session_id} ${row.description}`));
    const docs = new Map();
    for (const { path: doc } of done.flatMap(docsRead)) docs.set(doc, (docs.get(doc) ?? 0) + 1);
    const withDocs = done.filter((row) => Array.isArray(row.docs_read));
    const sized = withDocs.filter((row) => docsRead(row).every((doc) => Number.isFinite(doc.bytes)));
    const counted = done.filter((row) => Number.isFinite(row.tool_calls) && Number.isFinite(row.tool_requests));
    const cost = sum(done, (row) => row.cost_usd);
    const toolRequests = sum(counted, (row) => row.tool_requests);
    const toolCalls = sum(counted, (row) => row.tool_calls);
    const known = done.filter((row) => sentBack.get(row.agent_id ?? row) !== null);
    const failed = known.filter((row) => sentBack.get(row.agent_id ?? row)).length;
    return {
      agent_type: type,
      dispatches: sent.length,
      redispatched: sent.length - tasks.size,
      redispatch_rate: sent.length ? round(1 - tasks.size / sent.length) : null,
      median_duration_ms: median(sent.map((row) => row.duration_ms)),
      median_tokens: median(done.map((row) => (row.tokens ? row.tokens.input + row.tokens.output + row.tokens.cache_read + row.tokens.cache_write : NaN))),
      cost_usd: round(cost),
      delivered: Object.fromEntries(['file', 'chat', 'missing'].map((kind) => [kind, done.filter((row) => row.delivered === kind).length])),
      top_docs: [...docs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5),
      runs: done.length,
      cost_per_run_usd: done.length ? round(cost / done.length) : null,
      sent_back: failed,
      sent_back_rate: known.length ? round(failed / known.length) : null,
      runs_without_send_back: done.length - known.length,
      avg_docs_read: withDocs.length ? round(sum(withDocs, (row) => row.docs_read.length) / withDocs.length, 1) : null,
      avg_doc_bytes: sized.length ? Math.round(sum(sized, (row) => sum(docsRead(row), (doc) => doc.bytes)) / sized.length) : null,
      requests: sum(counted, (row) => row.requests),
      tool_requests: toolRequests,
      tool_calls: toolCalls,
      tool_calls_per_request: toolRequests ? round(toolCalls / toolRequests) : null,
      runs_without_tool_counts: done.length - counted.length,
    };
  });
  return {
    agents,
    sessions: { count: sessions.length, cost_usd: round(sum(sessions, (row) => row.cost_usd)) },
    unjoined_stops: stops.filter((row) => row.agent_id && !dispatched.has(row.agent_id)).length,
    runs_without_tool_counts: sum(agents, (agent) => agent.runs_without_tool_counts),
    hook_denies: summarizeDenies(rows, { sinceMs }),
  };
}

// The `hook_deny` rows since `sinceMs`: { count, sessions, by_rule }, the rules with the most blocks first. Per rule:
// `count`, `agents` and `reasons` as [name, count] pairs, most first, at most three reasons, and `repeated_sessions`,
// the sessions it blocked REPEATED_DENIALS times or more, which is when a block becomes an automatic lesson.
export function summarizeDenies(rows, { sinceMs = 0 } = {}) {
  const denies = rows.filter((row) => row.event === 'hook_deny' && Date.parse(row.ts) >= sinceMs);
  const add = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  const ranked = (map) => [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  const rules = new Map();
  for (const row of denies) {
    const rule = typeof row.rule === 'string' ? row.rule : 'unknown';
    const entry = rules.get(rule) ?? { agents: new Map(), sessions: new Map(), reasons: new Map() };
    add(entry.agents, row.agent_type ?? 'main');
    if (row.session_id) add(entry.sessions, row.session_id);
    if (row.reason) add(entry.reasons, row.reason);
    rules.set(rule, entry);
  }
  const byRule = [...rules].map(([rule, entry]) => ({
    rule,
    count: sum([...entry.agents.values()], (count) => count),
    agents: ranked(entry.agents),
    repeated_sessions: [...entry.sessions.values()].filter((count) => count >= REPEATED_DENIALS).length,
    reasons: ranked(entry.reasons).slice(0, 3),
  }));
  return {
    count: denies.length,
    sessions: new Set(denies.map((row) => row.session_id).filter(Boolean)).size,
    by_rule: byRule.sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
  };
}

export function formatReport(summary, { file, since, skipped, notes = [] }) {
  const lines = [`Dispatch log ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`, ...notes];
  const denies = summary.hook_denies ?? { count: 0, sessions: 0, by_rule: [] };
  if (!summary.agents.length && !summary.sessions.count && !denies.count) return [...lines, 'No rows yet.'].join('\n');
  if (summary.runs_without_tool_counts) {
    lines.push(`Partial: ${summary.runs_without_tool_counts} agent runs were logged before tool counts; tool calls per request leave them out.`);
  }
  const seconds = (msValue) => (msValue === null ? '-' : `${Math.round(msValue / 1000)}s`);
  const thousands = (value) => (value === null ? '-' : `${Math.round(value / 1000)}k`);
  const percent = (rate) => (rate === null ? '-' : `${Math.round(rate * 100)}%`);
  for (const agent of summary.agents) {
    const { file: written, chat, missing } = agent.delivered;
    lines.push(
      `${agent.agent_type}: ${agent.dispatches} dispatches, ${percent(agent.redispatch_rate)} re-dispatched, ` +
        `median ${seconds(agent.median_duration_ms)} and ${thousands(agent.median_tokens)} tokens, $${agent.cost_usd.toFixed(2)}, ` +
        `delivered ${written} file / ${chat} chat / ${missing} missing`,
    );
    if (agent.runs) {
      lines.push(
        `  ${agent.runs} runs, $${agent.cost_per_run_usd.toFixed(2)} a run, ${percent(agent.sent_back_rate)} sent back by the delivery check, ` +
          `${agent.tool_calls_per_request === null ? '-' : agent.tool_calls_per_request.toFixed(2)} tool calls per request that made one`,
      );
    }
    if (agent.avg_docs_read !== null) {
      const bytes = agent.avg_doc_bytes === null ? '' : ` and ${(agent.avg_doc_bytes / 1024).toFixed(1)} KB`;
      const top = agent.top_docs.map(([doc, count]) => `${doc} (${count})`).join(', ');
      lines.push(`  docs read: ${agent.avg_docs_read.toFixed(1)} docs${bytes} a run${top ? `; ${top}` : ''}`);
    }
  }
  lines.push(`Sessions: ${summary.sessions.count}, $${summary.sessions.cost_usd.toFixed(2)} estimated, main conversation and subagents together`);
  if (summary.unjoined_stops) lines.push(`${summary.unjoined_stops} stop rows have no dispatch row (a background dispatch, or a host change)`);
  lines.push(...formatDenies(denies));
  return lines.join('\n');
}

// The hook-deny lines of the default view: per rule, its blocks, the agents it blocked, and what it matched most often.
function formatDenies(denies) {
  if (!denies.count) return ['Hook denies: none'];
  const sessions = `${denies.sessions} session${denies.sessions === 1 ? '' : 's'}`;
  return [`Hook denies: ${denies.count} in ${sessions}`, ...denies.by_rule.flatMap((rule) => {
    const repeated = rule.repeated_sessions
      ? `; ${rule.repeated_sessions} session${rule.repeated_sessions === 1 ? '' : 's'} blocked ${REPEATED_DENIALS} times or more, an automatic lesson`
      : '';
    const line = `  ${rule.rule}: ${rule.count}, by ${rule.agents.map(([agent, count]) => `${agent} ${count}`).join(', ')}${repeated}`;
    return rule.reasons.length ? [line, `    most often: ${rule.reasons[0][0]}`] : [line];
  })];
}
