// The dispatch log: `dispatch-log.jsonl` in the state folder, one row per subagent dispatch, per subagent stop, and per
// session end, appended by three Claude Code hooks; `aidrian report` reads it. A row holds names, counts, durations,
// costs, and file paths; never a prompt, a command, or tool output. docs/dispatch-log.md describes every field.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadConfig } from './config.mjs';
import { checkoutRoots } from './git.mjs';
import { readRows } from './jsonl.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { projectAt, stateDir } from './project.mjs';
import { aggregateUsage, estimateCostUsd, filesRead, readText, subagentTranscripts, sumTokens } from './transcript.mjs';

const DESCRIPTION_CHARS = 80;
const CLAIMED_PATHS = 20;
// A path an agent's last message names: a .md or .json token with a `/`, not inside a URL or a template.
const CLAIM = /(?<![\w.~/:@<>{}$*%#-])(~?[\w.-]*\/[\w.~/-]*\.(?:md|json))(?![\w/<>{}*-])/gu;
// A line that presents a file as delivered: a delivery word that is not part of a path, or the 📄 file marker.
const DELIVERY_LINE = /(?<![\w./-])(?:wrote|written|created|saved|handoffs?|outputs?)(?![\w./-])|📄/iu;

export const logPath = (project) => path.join(stateDir(project), 'dispatch-log.jsonl');

const stamp = (now) => new Date(now).toISOString();
const text = (value, limit = Infinity) => (typeof value === 'string' && value !== '' ? value.slice(0, limit) : null);

// PostToolUse on the Agent tool. `dispatcher` is the agent that dispatched: the hook's own agent_type inside a subagent,
// else the session's --agent, else the main session.
export function dispatchRow(input, { env = process.env, now = Date.now() } = {}) {
  const toolInput = input.tool_input ?? {};
  const response = typeof input.tool_response === 'object' && input.tool_response !== null ? input.tool_response : {};
  return {
    event: 'dispatch',
    ts: stamp(now),
    session_id: text(input.session_id),
    dispatcher: text(input.agent_type) ?? text(env.CLAUDE_CODE_AGENT) ?? 'main',
    agent_id: text(response.agentId),
    agent_type: text(toolInput.subagent_type) ?? 'general-purpose',
    name: text(toolInput.name),
    description: text(toolInput.description, DESCRIPTION_CHARS),
    background: response.status === 'async_launched' || toolInput.run_in_background === true,
    status: text(response.status),
    duration_ms: Number.isFinite(response.totalDurationMs) ? response.totalDurationMs : null,
    tool_uses: Number.isFinite(response.totalToolUseCount) ? response.totalToolUseCount : null,
  };
}

// SubagentStop: the subagent's tokens, cost, the knowledge docs it read, and whether the paths its last message presents
// as delivered exist. Returns { row, missing }; the hook sends the agent back once when `missing` is not empty.
export function stopRow(input, project, { now = Date.now() } = {}) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const usage = transcript ? aggregateUsage(transcript).perModel : {};
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  const missing = missingPaths(claims, cwd);
  const row = {
    event: 'stop',
    ts: stamp(now),
    session_id: text(input.session_id),
    agent_id: text(input.agent_id),
    agent_type: text(input.agent_type) ?? 'general-purpose',
    tokens: sumTokens(usage),
    models: Object.keys(usage),
    cost_usd: estimateCostUsd(usage).total,
    docs_read: transcript ? knowledgeDocsRead(filesRead(transcript), project) : [],
    delivered: missing.length ? 'missing' : claims.length ? 'file' : 'chat',
    paths: claims,
  };
  return { row, missing };
}

// SessionEnd: the whole session's tokens and estimated cost, main conversation and subagents together.
export function sessionRow(input, { env = process.env, now = Date.now() } = {}) {
  const main = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const subagents = main ? subagentTranscripts(main, input.session_id) : [];
  let acc;
  for (const file of [main, ...subagents].filter(Boolean)) {
    const content = readText(file);
    if (content !== null) acc = aggregateUsage(content, acc);
  }
  const perModel = acc?.perModel ?? {};
  const minutes = acc?.firstTs && acc.lastTs ? Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 6000) / 10 : null;
  const tokensByModel = Object.fromEntries(Object.entries(perModel).map(([model, usage]) => [model, sumTokens({ [model]: usage })]));
  return {
    event: 'session',
    ts: stamp(now),
    session_id: text(input.session_id),
    agent: text(env.CLAUDE_CODE_AGENT),
    reason: text(input.reason),
    duration_min: minutes,
    models: Object.keys(perModel),
    tokens_by_model: tokensByModel,
    cost_usd: estimateCostUsd(perModel).total,
    subagent_count: subagents.length,
  };
}

// The .md and .json paths a message presents as delivered, once each, at most CLAIMED_PATHS. A path on any other line
// is a mention, such as "docs/old.md does not exist", and is never checked.
export function claimedPaths(message) {
  if (typeof message !== 'string') return [];
  const lines = message.split('\n').filter((line) => DELIVERY_LINE.test(line));
  const claims = lines.flatMap((line) => [...line.matchAll(CLAIM)].map((match) => match[1].replace(/[.]+$/u, '')));
  return [...new Set(claims)].slice(0, CLAIMED_PATHS);
}

// The claimed paths that exist nowhere: not absolute, not from `cwd`, not from its checkout or the main checkout.
export function missingPaths(claims, cwd) {
  const resolve = (base, claim) => (claim.startsWith('~/') ? path.join(homedir(), claim.slice(2)) : path.resolve(base, claim));
  let roots;
  return claims.filter((claim) => {
    if (existsSync(resolve(cwd, claim))) return false;
    if (path.isAbsolute(claim) || claim.startsWith('~/')) return true;
    roots ??= checkoutRoots(cwd);
    return !roots || ![roots.current, roots.main].some((root) => existsSync(path.join(root, claim)));
  });
}

// The knowledge docs among `files`, as the index names them. A project doc matches by its path's end, so a read in
// a worktree counts too.
function knowledgeDocsRead(files, project) {
  const docs = loadKnowledge(project).buckets.flatMap((bucket) => bucket.docs.map((doc) => doc.path));
  return docs.filter((doc) => files.some((file) => (path.isAbsolute(doc) ? file === doc : file.endsWith(`/${doc}`))));
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Aggregates rows newer than `sinceMs`. A stop row repeats when its agent was sent back; the last one counts.
export function summarize(rows, { sinceMs = 0 } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs && ['dispatch', 'stop', 'session'].includes(row.event));
  const dispatches = fresh.filter((row) => row.event === 'dispatch');
  const stops = [...new Map(fresh.filter((row) => row.event === 'stop').map((row) => [row.agent_id ?? Symbol('stop'), row])).values()];
  const sessions = [...new Map(fresh.filter((row) => row.event === 'session').map((row) => [row.session_id ?? Symbol('session'), row])).values()];
  const dispatched = new Set(dispatches.map((row) => row.agent_id).filter(Boolean));
  const types = [...new Set([...dispatches, ...stops].map((row) => row.agent_type))].sort();
  const agents = types.map((type) => {
    const sent = dispatches.filter((row) => row.agent_type === type);
    const done = stops.filter((row) => row.agent_type === type);
    const tasks = new Set(sent.map((row) => `${row.session_id} ${row.description}`));
    const docs = new Map();
    for (const doc of done.flatMap((row) => row.docs_read ?? [])) docs.set(doc, (docs.get(doc) ?? 0) + 1);
    return {
      agent_type: type,
      dispatches: sent.length,
      redispatch_rate: sent.length ? Math.round((1 - tasks.size / sent.length) * 100) / 100 : null,
      median_duration_ms: median(sent.map((row) => row.duration_ms)),
      median_tokens: median(done.map((row) => (row.tokens ? row.tokens.input + row.tokens.output + row.tokens.cache_read + row.tokens.cache_write : NaN))),
      cost_usd: Math.round(done.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0) * 100) / 100,
      delivered: Object.fromEntries(['file', 'chat', 'missing'].map((kind) => [kind, done.filter((row) => row.delivered === kind).length])),
      top_docs: [...docs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5),
    };
  });
  return {
    agents,
    sessions: { count: sessions.length, cost_usd: Math.round(sessions.reduce((sum, row) => sum + (row.cost_usd ?? 0), 0) * 100) / 100 },
    unjoined_stops: stops.filter((row) => row.agent_id && !dispatched.has(row.agent_id)).length,
  };
}

export function formatReport(summary, { file, since, skipped }) {
  const lines = [`Dispatch log ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`];
  if (!summary.agents.length && !summary.sessions.count) return [...lines, 'No rows yet.'].join('\n');
  const seconds = (msValue) => (msValue === null ? '-' : `${Math.round(msValue / 1000)}s`);
  const thousands = (value) => (value === null ? '-' : `${Math.round(value / 1000)}k`);
  for (const agent of summary.agents) {
    const { file: written, chat, missing } = agent.delivered;
    lines.push(
      `${agent.agent_type}: ${agent.dispatches} dispatches, ${agent.redispatch_rate === null ? '-' : `${Math.round(agent.redispatch_rate * 100)}%`} re-dispatched, ` +
        `median ${seconds(agent.median_duration_ms)} and ${thousands(agent.median_tokens)} tokens, $${agent.cost_usd.toFixed(2)}, ` +
        `delivered ${written} file / ${chat} chat / ${missing} missing`,
    );
    if (agent.top_docs.length) lines.push(`  docs read: ${agent.top_docs.map(([doc, count]) => `${doc} (${count})`).join(', ')}`);
  }
  lines.push(`Sessions: ${summary.sessions.count}, $${summary.sessions.cost_usd.toFixed(2)} estimated, main conversation and subagents together`);
  if (summary.unjoined_stops) lines.push(`${summary.unjoined_stops} stop rows have no dispatch row (a background dispatch, or a host change)`);
  return lines.join('\n');
}

// `7d`, `24h`, `30m`, or a date (YYYY-MM-DD): the earliest time to report, in ms.
export function parseSince(value, now = Date.now()) {
  const span = /^(\d+)([dhm])$/u.exec(value);
  if (span) return now - Number(span[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[span[2]];
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(value) ? Date.parse(`${value}T00:00:00Z`) : NaN;
  if (Number.isNaN(date)) throw new Error(`--since takes 7d, 24h, 30m, or YYYY-MM-DD, not ${value}`);
  return date;
}

export const commands = {
  report: {
    usage: '[--since 7d] [--prs N] [--json] [--project DIR]',
    about: 'summarize the dispatch log per agent type, and with --prs the bot review rounds of the last N merged pull requests',
    async run(args) {
      const { values } = parseArgs({ args, options: { since: { type: 'string' }, prs: { type: 'string' }, json: { type: 'boolean' }, project: { type: 'string' } } });
      const project = projectAt(path.resolve(values.project ?? '.'));
      const since = values.since ?? '7d';
      let sinceMs;
      try {
        sinceMs = parseSince(since);
      } catch (error) {
        console.error(error.message);
        return 1;
      }
      const file = logPath(project);
      const { rows, skipped } = readRows(file);
      const summary = summarize(rows, { sinceMs });
      if (values.prs !== undefined) {
        const count = Number(values.prs);
        if (!Number.isInteger(count) || count < 1) {
          console.error('--prs takes a whole number above 0');
          return 1;
        }
        const { reviewRounds, formatRounds } = await import('./pr-review-rounds.mjs');
        summary.reviews = reviewRounds(count, loadConfig(project).config.github.reviewer);
        if (!values.json) console.log(`${formatReport(summary, { file, since, skipped })}\n${formatRounds(summary.reviews)}`);
      } else if (!values.json) {
        console.log(formatReport(summary, { file, since, skipped }));
      }
      if (values.json) console.log(JSON.stringify({ file, since, skipped, ...summary }));
      return 0;
    },
  },
};
