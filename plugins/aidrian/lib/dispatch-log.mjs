// The dispatch log: `dispatch-log.jsonl` in the state folder, one row per subagent dispatch, per subagent stop, per
// session end, and per block by one of the plugin's own hooks, appended unless config.json `telemetry` turns them off;
// `aidrian report` reads it. A row holds names, counts, durations, costs, and file paths; never a prompt, a command, or
// tool output. docs/dispatch-log.md describes every field.

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, fileBytes } from './config.mjs';
import { checkoutRoots } from './git.mjs';
import { appendRow, latestRows as latest, readRows } from './jsonl.mjs';
import { checkBudgets, indexRows, loadKnowledge } from './knowledge.mjs';
import { REPEATED_DENIALS } from './lesson-signals.mjs';
import { projectAt, stateDir } from './project.mjs';
import { formatSessions, summarizeSessions } from './report-sessions.mjs';
import { aggregateUsage, estimateCostUsd, filesRead, partOf, readText, subagentTranscripts, sumTokens } from './transcript.mjs';

const DESCRIPTION_CHARS = 80;
// A hook_deny row's `reason`: the start of what the rule matched.
const REASON_CHARS = 120;
const CLAIMED_PATHS = 20;
// `aidrian report docs` lists the docs with the most bytes read, and the docs with the most readers.
const TOP_DOCS = 10;
const SHARED_DOCS = 5;
// ...and at most this many of the indexed docs nobody read.
const NEVER_READ = 20;
// A path an agent's last message names: a .md or .json token with a `/`, not inside a URL or a template.
const CLAIM = /(?<![\w.~/:@<>{}$*%#-])(~?[\w.-]*\/[\w.~/-]*\.(?:md|json))(?![\w/<>{}*-])/gu;
// A line that presents a file as delivered: a delivery word that is not part of a path, or the 📄 file marker.
const DELIVERY_LINE = /(?<![\w./-])(?:wrote|written|created|saved|handoffs?|outputs?)(?![\w./-])|📄/iu;

// `config` is the project's config when the caller has it; stateDir reads it otherwise.
export const logPath = (project, config) => path.join(stateDir(project, { config }), 'dispatch-log.jsonl');
// The log's previous part, which rotation keeps beside it.
const rotatedPath = (file) => file.replace(/\.jsonl$/u, '.1.jsonl');
// A lock older than this was left by a process that died while rotating.
const STALE_LOCK_MS = 60_000;

// Appends `row`, unless `config.telemetry.enabled` is false. A log of `telemetry.maxMb` or more rotates first.
export function appendEvent(project, config, row) {
  if (!config.telemetry.enabled) return;
  const file = logPath(project, config);
  rotate(file, config.telemetry.maxMb * 1024 * 1024);
  appendRow(file, row);
}

// Moves a log of `maxBytes` or more to `dispatch-log.1.jsonl`, replacing the one there, and starts the new log with a
// `rotate` row whose `dropped` says whether older rows were lost. One process rotates at a time: it holds a lock file it
// created exclusively. A process that cannot create the lock appends to whichever log is there.
function rotate(file, maxBytes) {
  if ((fileBytes(file) ?? 0) < maxBytes) return;
  const lock = `${file}.lock`;
  let fd;
  try {
    fd = openSync(lock, 'wx');
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
    } catch {
      // The lock went away: the process that held it is done.
    }
    return;
  }
  try {
    // Another process may have rotated between the size check and the lock.
    if ((fileBytes(file) ?? 0) < maxBytes) return;
    const rotated = rotatedPath(file);
    const dropped = existsSync(rotated);
    renameSync(file, rotated);
    appendRow(file, { event: 'rotate', ts: stamp(Date.now()), session_id: null, dropped });
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}

// Every row of the log, its rotated part first: { file, rotated, rows, skipped }. `rotated` is null when there is none.
export function readLog(project, config) {
  const file = logPath(project, config);
  const rotated = rotatedPath(file);
  const older = readRows(rotated);
  const newer = readRows(file);
  return { file, rotated: existsSync(rotated) ? rotated : null, rows: [...older.rows, ...newer.rows], skipped: older.skipped + newer.skipped };
}

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

// The paths a subagent's last message presents as delivered, and those of them that exist nowhere: { claims, missing }.
export function checkDelivery(input, project) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  return { claims, missing: missingPaths(claims, cwd) };
}

// Whether the stop hook sends the subagent back, whether or not telemetry is on: a path is `missing`, and the host marks
// this stop as a first one with `stop_hook_active: false`. The stop that a send-back caused, and a payload without the
// field, always end.
export const sendsBack = (input, delivery) => delivery.missing.length > 0 && input.stop_hook_active === false;

// Which subagent stopped, as its `stop` row names it: { session_id, agent_id, agent_type }.
export function stopAgent(input) {
  return { session_id: text(input.session_id), agent_id: text(input.agent_id), agent_type: text(input.agent_type) ?? 'general-purpose' };
}

// A block by one of the plugin's own hooks (lib/hook-deny.mjs): which rule, on which tool, for which agent, and `match`,
// the rule's own words for what it matched, cut to REASON_CHARS. The agent is named as on a `dispatch` row's dispatcher.
export function denyRow(input, rule, match, { env = process.env, now = Date.now() } = {}) {
  return {
    event: 'hook_deny',
    ts: stamp(now),
    session_id: text(input.session_id),
    rule,
    tool: text(input.tool_name),
    agent_type: text(input.agent_type) ?? text(env.CLAUDE_CODE_AGENT) ?? 'main',
    reason: text(match, REASON_CHARS),
  };
}

// SubagentStop: the subagent's tokens, cost, API requests and tool calls, the knowledge docs it read with their sizes, and
// its delivery check with whether it sent the subagent back, over the requests it made itself (ownRequests).
// `docReads: false` (config.json `telemetry.docReads`) records `docs_read: null`.
export function stopRow(input, project, { now = Date.now(), docReads = true, delivery = checkDelivery(input, project) } = {}) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const own = transcript ? ownRequests(input) : undefined;
  const part = transcript ? partOf(aggregateUsage(transcript), own) : { perModel: {}, requests: 0, tool_requests: 0, tool_calls: 0 };
  const usage = part.perModel;
  const { claims, missing } = delivery;
  return {
    event: 'stop',
    ts: stamp(now),
    ...stopAgent(input),
    tokens: sumTokens(usage),
    models: Object.keys(usage),
    cost_usd: estimateCostUsd(usage).total,
    requests: part.requests,
    tool_requests: part.tool_requests,
    tool_calls: part.tool_calls,
    docs_read: !docReads ? null : transcript ? knowledgeDocsRead(filesRead(transcript, own), project) : [],
    delivered: missing.length ? 'missing' : claims.length ? 'file' : 'chat',
    paths: claims,
    sent_back: sendsBack(input, delivery),
  };
}

// A forked subagent's transcript starts with a copy of its parent's, and a copied request stays the parent's: its tokens
// and Read calls count on the parent's row, as a session row counts them for its main conversation. Returns `keep` for
// partOf and filesRead: it refuses a request that the main conversation's transcript holds, or the transcript of the
// subagent that spawned this one, which the `.meta.json` beside this one's transcript names as `parentAgentId`.
function ownRequests(input) {
  const agent = input.agent_transcript_path;
  const parents = [input.transcript_path];
  let parent;
  try {
    parent = JSON.parse(readText(agent.replace(/\.jsonl$/u, '.meta.json')) ?? 'null')?.parentAgentId;
  } catch {
    // No readable .meta.json: the main conversation is the only parent.
  }
  if (typeof parent === 'string' && /^[\w-]+$/u.test(parent)) parents.push(path.join(path.dirname(agent), `agent-${parent}.jsonl`));
  const inherited = new Set();
  for (const file of parents) {
    const content = typeof file === 'string' && file !== agent ? readText(file) : null;
    if (content) for (const key of aggregateUsage(content).requests.keys()) inherited.add(key);
  }
  return (key) => !inherited.has(key);
}

// SessionEnd: the whole session's tokens and estimated cost, main conversation and subagents together and each apart,
// the effort of the main conversation, and the knowledge docs it read; each subagent's own reads are on its `stop` row.
// `docReads` works as in stopRow.
export function sessionRow(input, project, { env = process.env, now = Date.now(), docReads = true } = {}) {
  const main = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const subagents = main ? subagentTranscripts(main, input.session_id) : [];
  const mainText = main && readText(main);
  let acc = mainText ? aggregateUsage(mainText) : undefined;
  // A request that a subagent transcript repeats stays the main conversation's.
  const mainKeys = new Set(acc?.requests.keys());
  const effort = acc?.effort ?? null;
  const effortVaried = (acc?.efforts.size ?? 0) > 1;
  for (const content of subagents.map(readText)) {
    if (content) acc = aggregateUsage(content, acc);
  }
  const perModel = acc?.perModel ?? {};
  const minutes = acc?.firstTs && acc.lastTs ? Math.round((Date.parse(acc.lastTs) - Date.parse(acc.firstTs)) / 6000) / 10 : null;
  const tokensByModel = Object.fromEntries(Object.entries(perModel).map(([model, usage]) => [model, sumTokens({ [model]: usage })]));
  const cost = estimateCostUsd(perModel);
  const side = ({ perModel: usage, requests, tool_requests: toolRequests, tool_calls: toolCalls }) =>
    ({ tokens: sumTokens(usage), cost_usd: estimateCostUsd(usage).total, requests, tool_requests: toolRequests, tool_calls: toolCalls });
  return {
    event: 'session',
    ts: stamp(now),
    session_id: text(input.session_id),
    agent: text(env.CLAUDE_CODE_AGENT),
    reason: text(input.reason),
    duration_min: minutes,
    effort,
    effort_varied: effortVaried,
    models: Object.keys(perModel),
    tokens_by_model: tokensByModel,
    cost_usd: cost.total,
    cost_by_model: cost.byModel,
    main: side(partOf(acc, (key) => mainKeys.has(key))),
    subagents: side(partOf(acc, (key) => !mainKeys.has(key))),
    subagent_count: subagents.length,
    docs_read: !docReads ? null : mainText ? knowledgeDocsRead(filesRead(mainText), project) : [],
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

// The knowledge docs among `files`, as { path, bytes }: the path as the index names it, and the size of the copy that
// was read, or of the project's copy once that one is gone. A project doc matches by its path's end, so a read in a
// worktree counts too.
function knowledgeDocsRead(files, project) {
  const docs = loadKnowledge(project).buckets.flatMap((bucket) => bucket.docs.map((doc) => doc.path));
  return docs.flatMap((doc) => {
    const file = files.find((each) => (path.isAbsolute(doc) ? each === doc : each.endsWith(`/${doc}`)));
    return file ? [{ path: doc, bytes: fileBytes(file) ?? fileBytes(path.resolve(project.root, doc)) }] : [];
  });
}

// A row's `docs_read` as { path, bytes }. A row written before sizes were logged holds bare paths, of unknown size.
const docsRead = (row) =>
  (Array.isArray(row.docs_read) ? row.docs_read : []).map((entry) => (typeof entry === 'string' ? { path: entry, bytes: null } : entry));

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
const sum = (rows, valueOf) => rows.reduce((total, row) => total + (valueOf(row) ?? 0), 0);

// Whether each run among `stops` was sent back by the delivery check: true, false, or null for unknown, keyed by
// agent_id. A stop row without an agent_id is a run of its own, so it is its own key here as in latestRows. A row says
// so in `sent_back`; a row from before that field is unknown when its `delivered` is `missing`, and was never sent back
// otherwise. A run is sent back when any of its rows was, else unknown when any is.
function sendBackStates(stops) {
  const runs = new Map();
  for (const row of stops) {
    const key = row.agent_id ?? row;
    const states = [runs.get(key), typeof row.sent_back === 'boolean' ? row.sent_back : row.delivered === 'missing' ? null : false];
    runs.set(key, states.includes(true) ? true : states.includes(null) ? null : false);
  }
  return runs;
}

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

// What a report over `rows` cannot see: { enabled, doc_reads, hook_denies, rows_without_doc_reads, runs_without_send_back,
// rotated_out_before }. `enabled`, `doc_reads`, and `hook_denies` are the switches now. `rows_without_doc_reads` counts
// the stop and session rows since `sinceMs` written while doc reads were off; `runs_without_send_back`, the runs since
// then whose send-back is unknown (sendBackStates). `rotated_out_before` is the oldest row's time when rotation dropped
// older rows and the window starts before it; else null. A time telemetry was off leaves no rows, so no report can see it.
export function coverage(rows, config, { sinceMs = 0 } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs);
  const counted = [...latest(fresh, 'stop', 'agent_id'), ...latest(fresh, 'session', 'session_id')];
  const sendBacks = sendBackStates(fresh.filter((row) => row.event === 'stop'));
  const oldest = rows.reduce((min, row) => Math.min(min, Date.parse(row.ts) || Infinity), Infinity);
  const lost = rows.some((row) => row.event === 'rotate' && row.dropped === true);
  return {
    enabled: config.telemetry.enabled,
    doc_reads: config.telemetry.docReads,
    hook_denies: config.telemetry.hookDenies,
    rows_without_doc_reads: counted.filter((row) => row.docs_read === null).length,
    runs_without_send_back: [...sendBacks.values()].filter((state) => state === null).length,
    rotated_out_before: lost && oldest > sinceMs && oldest !== Infinity ? new Date(oldest).toISOString() : null,
  };
}

// The lines that tell a reader the report is incomplete, and why. `docReads: false` leaves out the doc-read lines, for a
// view that shows no doc reads; `hookDenies: true` adds the hook-deny line, and `sendBacks: true` the send-back line, for
// the view that shows them.
export function coverageLines(cover, { docReads = true, hookDenies = false, sendBacks = false } = {}) {
  const lines = [];
  if (!cover.enabled) lines.push('Telemetry is off (telemetry.enabled is false): the hooks write no rows, so this shows only older ones.');
  else {
    if (docReads && !cover.doc_reads) lines.push('Doc reads are off (telemetry.docReads is false): new rows do not record them.');
    if (hookDenies && !cover.hook_denies) lines.push('Hook denies are off (telemetry.hookDenies is false): the hooks still block, and log no hook_deny rows.');
  }
  if (docReads && cover.rows_without_doc_reads) {
    lines.push(`Partial: ${cover.rows_without_doc_reads} agent and session rows in the window were written with doc reads off.`);
  }
  if (sendBacks && cover.runs_without_send_back) {
    lines.push(
      `Partial: ${cover.runs_without_send_back} agent runs named a missing file before stop rows recorded send-backs; ` +
        'the share sent back leaves them out.',
    );
  }
  if (cover.rotated_out_before) {
    lines.push(`Partial: the log starts at ${cover.rotated_out_before}; older rows were rotated out at telemetry.maxMb.`);
  }
  return lines;
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

// Per knowledge doc read since `sinceMs`: `reads`, `bytes` (its size as last logged), `read_bytes` (reads × bytes), and
// `readers`, the agent types that read it plus `main` for a main conversation. Most bytes read first. A stop row counts
// for its subagent and a session row for its main conversation, so no read counts twice. `totals.rows` counts the rows
// that recorded doc reads. With `indexed`, the index's docs as { path, bytes }, `never_read` lists those nobody read.
export function summarizeDocs(rows, { sinceMs = 0, indexed } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs);
  const counted = new Set([...latest(fresh, 'stop', 'agent_id'), ...latest(fresh, 'session', 'session_id')]);
  const byPath = new Map();
  let recorded = 0;
  for (const row of fresh.filter((each) => counted.has(each))) {
    if (Array.isArray(row.docs_read)) recorded += 1;
    const reader = row.event === 'session' ? 'main' : (row.agent_type ?? 'general-purpose');
    for (const { path: doc, bytes } of docsRead(row)) {
      const entry = byPath.get(doc) ?? { path: doc, reads: 0, bytes: null, readers: new Set() };
      entry.reads += 1;
      if (Number.isFinite(bytes)) entry.bytes = bytes;
      entry.readers.add(reader);
      byPath.set(doc, entry);
    }
  }
  const docs = [...byPath.values()]
    .map(({ path: doc, reads, bytes, readers }) => ({ path: doc, reads, bytes, read_bytes: bytes === null ? null : reads * bytes, readers: [...readers].sort() }))
    .sort((a, b) => (b.read_bytes ?? -1) - (a.read_bytes ?? -1) || b.reads - a.reads || a.path.localeCompare(b.path));
  const total = (key) => docs.reduce((sum, doc) => sum + (doc[key] ?? 0), 0);
  const readers = [...new Set(docs.flatMap((doc) => doc.readers))].sort();
  const summary = { docs, totals: { docs: docs.length, reads: total('reads'), read_bytes: total('read_bytes'), readers, rows: recorded } };
  return indexed ? { ...summary, never_read: indexed.filter((doc) => !byPath.has(doc.path)) } : summary;
}

// The project's indexed docs in index order, as { path, bytes }, its `always` docs against their budget, and `tags`, each
// indexed doc's tags by path.
export function knowledgeOf(project, config) {
  const { buckets } = loadKnowledge(project);
  const rows = indexRows(buckets);
  const indexed = rows.map((doc) => ({ path: doc.path, bytes: fileBytes(path.resolve(project.root, doc.path)) }));
  const tags = Object.fromEntries(rows.map((doc) => [doc.path, doc.tags]));
  return { indexed, always: checkBudgets(project.root, buckets, config.knowledge.budgets).always, tags };
}

export function formatDocs({ docs, totals, never_read: neverRead }, { file, since, skipped, notes = [], always }) {
  const lines = [`Knowledge docs read, from ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`, ...notes];
  if (always) {
    const buckets = Object.entries(always.buckets).map(([id, bytes]) => `${id} ${bytes}`).join(', ');
    const over = always.bytes > always.budget ? ', over knowledge.budgets.alwaysBytes' : '';
    lines.push(`Always docs: ${always.bytes} of ${always.budget} bytes${over}, read by every session and subagent${buckets ? ` (${buckets})` : ''}`);
  }
  if (!totals.rows) return [...lines, 'No knowledge doc reads yet.'].join('\n');
  const kb = (bytes) => (bytes === null ? '?' : `${(bytes / 1024).toFixed(1)} KB`);
  if (!docs.length) lines.push(`${totals.rows} agent and session rows recorded doc reads, and none read a knowledge doc.`);
  else lines.push(
    `${totals.reads} reads of ${totals.docs} docs, ${kb(totals.read_bytes)} in all, by ${totals.readers.length} readers: ${totals.readers.join(', ')}`,
    `Most bytes read (reads × size), top ${Math.min(TOP_DOCS, docs.length)}:`,
    ...docs.slice(0, TOP_DOCS).map((doc) =>
      `  ${String(doc.reads).padStart(5)} × ${kb(doc.bytes).padStart(9)} = ${kb(doc.read_bytes).padStart(9)}  ${doc.path}  (${doc.readers.join(', ')})`),
  );
  const shared = docs.filter((doc) => doc.readers.length > 1).sort((a, b) => b.readers.length - a.readers.length || b.reads - a.reads).slice(0, SHARED_DOCS);
  if (shared.length) {
    lines.push('Read by the most readers:', ...shared.map((doc) => `  ${doc.readers.length} of ${totals.readers.length}  ${doc.path}`));
  }
  if (neverRead?.length) {
    lines.push(
      `Indexed docs never read since ${since}, ${neverRead.length}:`,
      ...neverRead.slice(0, NEVER_READ).map((doc) => `  ${kb(doc.bytes).padStart(9)}  ${doc.path}`),
      ...(neverRead.length > NEVER_READ ? [`  and ${neverRead.length - NEVER_READ} more; --json lists them all`] : []),
    );
  }
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

// The views of `aidrian report`; the first is the default.
const VIEWS = ['agents', 'docs', 'sessions', 'reviews', 'health'];
// The views that read the review bot's pull requests, and so take --prs.
const PR_VIEWS = ['agents', 'reviews', 'health'];
// `aidrian report reviews` and `health` read this many merged pull requests unless --prs says otherwise.
const DEFAULT_PRS = 20;

export const commands = {
  report: {
    usage: '[agents|docs|sessions|reviews|health] [--since 7d] [--prs N] [--json] [--project DIR]',
    about: 'summarize the dispatch log per agent type with hook denies, per knowledge doc read (docs), or per session ' +
      '(sessions), the bot reviews of the last N merged pull requests (reviews), or every signal against its threshold ' +
      '(health, since 30d by default); --prs N on the default view adds reviews',
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { since: { type: 'string' }, prs: { type: 'string' }, json: { type: 'boolean' }, project: { type: 'string' } },
      });
      const view = positionals[0] ?? VIEWS[0];
      if (positionals.length > 1 || !VIEWS.includes(view)) {
        console.error(`unknown report: ${positionals.join(' ')}; use aidrian report, or aidrian report ${VIEWS.slice(1).join(', ')}`);
        return 1;
      }
      if (!PR_VIEWS.includes(view) && values.prs !== undefined) {
        console.error(`--prs belongs to aidrian report, aidrian report reviews, and aidrian report health, not aidrian report ${view}`);
        return 1;
      }
      const prs = Number(values.prs ?? DEFAULT_PRS);
      if (!Number.isInteger(prs) || prs < 1) {
        console.error('--prs takes a whole number above 0');
        return 1;
      }
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      // Health judges each signal on a sample, so it reads a month by default.
      const since = values.since ?? (view === 'health' ? '30d' : '7d');
      let sinceMs;
      try {
        sinceMs = parseSince(since);
      } catch (error) {
        console.error(error.message);
        return 1;
      }
      if (view === 'reviews') {
        // The log plays no part: the pull requests are the last N merged, or those merged since --since when it is given.
        const { formatReviews, ghAt, reviewRounds } = await import('./report-reviews.mjs');
        const reviews = reviewRounds(prs, config.github.reviewer, ghAt(project.root), { sinceMs: values.since === undefined ? null : sinceMs });
        const label = values.since ?? null;
        console.log(values.json ? JSON.stringify({ since: label, prs, ...reviews }) : formatReviews(reviews, { since: label }));
        return 0;
      }
      const { file, rotated, rows, skipped } = readLog(project, config);
      const cover = coverage(rows, config, { sinceMs });
      if (view === 'health') {
        // Every other view's numbers, each against its threshold; the reviews are those merged in the same window.
        const { formatHealth, summarizeHealth } = await import('./report-health.mjs');
        const { ghAt, reviewRounds } = await import('./report-reviews.mjs');
        const { inboxPath, lessons } = await import('./lesson-inbox.mjs');
        const health = summarizeHealth({
          rows,
          sinceMs,
          knowledge: knowledgeOf(project, config),
          reviews: reviewRounds(prs, config.github.reviewer, ghAt(project.root), { sinceMs }),
          lessons: lessons(inboxPath(project, config)),
          config,
        });
        const notes = coverageLines(cover, { hookDenies: true, sendBacks: true });
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...health }) : formatHealth(health, { file, since, skipped, notes }));
        return 0;
      }
      if (view === 'sessions') {
        const sessions = summarizeSessions(rows, { sinceMs });
        const notes = coverageLines(cover, { docReads: false });
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...sessions }) : formatSessions(sessions, { file, since, skipped, notes }));
        return 0;
      }
      if (view === 'docs') {
        const { indexed, always } = knowledgeOf(project, config);
        const docs = summarizeDocs(rows, { sinceMs, indexed });
        const notes = coverageLines(cover);
        console.log(values.json ? JSON.stringify({ file, rotated, since, skipped, coverage: cover, always, ...docs }) : formatDocs(docs, { file, since, skipped, notes, always }));
        return 0;
      }
      const summary = summarize(rows, { sinceMs });
      const text = () => formatReport(summary, { file, since, skipped, notes: coverageLines(cover, { hookDenies: true, sendBacks: true }) });
      if (values.prs !== undefined) {
        // The alias the reviews view grew from: the default view, then the reviews of the last N merged pull requests.
        const { formatReviews, ghAt, reviewRounds } = await import('./report-reviews.mjs');
        summary.reviews = reviewRounds(prs, config.github.reviewer, ghAt(project.root));
        if (!values.json) console.log(`${text()}\n${formatReviews(summary.reviews)}`);
      } else if (!values.json) {
        console.log(text());
      }
      if (values.json) console.log(JSON.stringify({ file, rotated, since, skipped, coverage: cover, ...summary }));
      return 0;
    },
  },
};
