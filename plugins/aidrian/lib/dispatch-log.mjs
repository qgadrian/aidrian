// The dispatch log: `dispatch-log.jsonl` in the state folder, one row per subagent dispatch, per subagent stop, and per
// session end, appended by three Claude Code hooks unless config.json `telemetry` turns them off; `aidrian report` reads
// it. A row holds names, counts, durations, costs, and file paths; never a prompt, a command, or tool output.
// docs/dispatch-log.md describes every field.

import { closeSync, existsSync, openSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { commandConfig, fileBytes } from './config.mjs';
import { checkoutRoots } from './git.mjs';
import { appendRow, readRows } from './jsonl.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { projectAt, stateDir } from './project.mjs';
import { aggregateUsage, estimateCostUsd, filesRead, readText, subagentTranscripts, sumTokens } from './transcript.mjs';

const DESCRIPTION_CHARS = 80;
const CLAIMED_PATHS = 20;
// `aidrian report docs` lists the docs with the most bytes read, and the docs with the most readers.
const TOP_DOCS = 10;
const SHARED_DOCS = 5;
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

// Appends `row`, unless `config.telemetry.enabled` is false. A log of `telemetry.max_mb` or more rotates first.
export function appendEvent(project, config, row) {
  if (!config.telemetry.enabled) return;
  const file = logPath(project, config);
  rotate(file, config.telemetry.max_mb * 1024 * 1024);
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
// The stop hook sends the agent back once when `missing` is not empty, whether or not telemetry is on.
export function checkDelivery(input, project) {
  const cwd = typeof input.cwd === 'string' ? input.cwd : project.root;
  const claims = claimedPaths(input.last_assistant_message);
  return { claims, missing: missingPaths(claims, cwd) };
}

// SubagentStop: the subagent's tokens, cost, the knowledge docs it read with their sizes, and its delivery check.
// `docReads: false` (config.json `telemetry.doc_reads`) records `docs_read: null`.
export function stopRow(input, project, { now = Date.now(), docReads = true, delivery = checkDelivery(input, project) } = {}) {
  const transcript = typeof input.agent_transcript_path === 'string' ? readText(input.agent_transcript_path) : null;
  const usage = transcript ? aggregateUsage(transcript).perModel : {};
  const { claims, missing } = delivery;
  return {
    event: 'stop',
    ts: stamp(now),
    session_id: text(input.session_id),
    agent_id: text(input.agent_id),
    agent_type: text(input.agent_type) ?? 'general-purpose',
    tokens: sumTokens(usage),
    models: Object.keys(usage),
    cost_usd: estimateCostUsd(usage).total,
    docs_read: !docReads ? null : transcript ? knowledgeDocsRead(filesRead(transcript), project) : [],
    delivered: missing.length ? 'missing' : claims.length ? 'file' : 'chat',
    paths: claims,
  };
}

// SessionEnd: the whole session's tokens and estimated cost, main conversation and subagents together, and the knowledge
// docs the main conversation read; each subagent's own reads are on its `stop` row. `docReads` works as in stopRow.
export function sessionRow(input, project, { env = process.env, now = Date.now(), docReads = true } = {}) {
  const main = typeof input.transcript_path === 'string' ? input.transcript_path : null;
  const subagents = main ? subagentTranscripts(main, input.session_id) : [];
  const mainText = main && readText(main);
  let acc;
  for (const content of [mainText, ...subagents.map(readText)]) {
    if (content) acc = aggregateUsage(content, acc);
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

// The rows that count once: a subagent's last `stop` row, since its agent may be sent back, and a session's last row.
const latest = (rows, event, key) => [...new Map(rows.filter((row) => row.event === event).map((row) => [row[key] ?? Symbol(event), row])).values()];

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
  const stops = latest(fresh, 'stop', 'agent_id');
  const sessions = latest(fresh, 'session', 'session_id');
  const dispatched = new Set(dispatches.map((row) => row.agent_id).filter(Boolean));
  const types = [...new Set([...dispatches, ...stops].map((row) => row.agent_type))].sort();
  const agents = types.map((type) => {
    const sent = dispatches.filter((row) => row.agent_type === type);
    const done = stops.filter((row) => row.agent_type === type);
    const tasks = new Set(sent.map((row) => `${row.session_id} ${row.description}`));
    const docs = new Map();
    for (const { path: doc } of done.flatMap(docsRead)) docs.set(doc, (docs.get(doc) ?? 0) + 1);
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

// Per knowledge doc read since `sinceMs`: `reads`, `bytes` (its size as last logged), `read_bytes` (reads × bytes), and
// `readers`, the agent types that read it plus `main` for a main conversation. Most bytes read first. A stop row counts
// for its subagent and a session row for its main conversation, so no read counts twice.
export function summarizeDocs(rows, { sinceMs = 0 } = {}) {
  const fresh = rows.filter((row) => Date.parse(row.ts) >= sinceMs);
  const counted = new Set([...latest(fresh, 'stop', 'agent_id'), ...latest(fresh, 'session', 'session_id')]);
  const byPath = new Map();
  for (const row of fresh.filter((each) => counted.has(each))) {
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
  return { docs, totals: { docs: docs.length, reads: total('reads'), read_bytes: total('read_bytes'), readers: [...new Set(docs.flatMap((doc) => doc.readers))].sort() } };
}

export function formatDocs({ docs, totals }, { file, since, skipped }) {
  const lines = [`Knowledge docs read, from ${file}, since ${since}${skipped ? ` (${skipped} unreadable rows skipped)` : ''}`];
  if (!docs.length) return [...lines, 'No knowledge doc reads yet.'].join('\n');
  const kb = (bytes) => (bytes === null ? '?' : `${(bytes / 1024).toFixed(1)} KB`);
  lines.push(
    `${totals.reads} reads of ${totals.docs} docs, ${kb(totals.read_bytes)} in all, by ${totals.readers.length} readers: ${totals.readers.join(', ')}`,
    `Most bytes read (reads × size), top ${Math.min(TOP_DOCS, docs.length)}:`,
    ...docs.slice(0, TOP_DOCS).map((doc) =>
      `  ${String(doc.reads).padStart(5)} × ${kb(doc.bytes).padStart(9)} = ${kb(doc.read_bytes).padStart(9)}  ${doc.path}  (${doc.readers.join(', ')})`),
  );
  const shared = docs.filter((doc) => doc.readers.length > 1).sort((a, b) => b.readers.length - a.readers.length || b.reads - a.reads).slice(0, SHARED_DOCS);
  if (shared.length) {
    lines.push('Read by the most readers:', ...shared.map((doc) => `  ${doc.readers.length} of ${totals.readers.length}  ${doc.path}`));
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

export const commands = {
  report: {
    usage: '[docs] [--since 7d] [--prs N] [--json] [--project DIR]',
    about: 'summarize the dispatch log per agent type, or with docs per knowledge doc read; --prs adds the bot review rounds of the last N merged pull requests',
    async run(args) {
      const { values, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: { since: { type: 'string' }, prs: { type: 'string' }, json: { type: 'boolean' }, project: { type: 'string' } },
      });
      const docsView = positionals[0] === 'docs';
      if (positionals.length > (docsView ? 1 : 0)) {
        console.error(`unknown report: ${positionals.join(' ')}; use aidrian report or aidrian report docs`);
        return 1;
      }
      if (docsView && values.prs !== undefined) {
        console.error('--prs belongs to aidrian report, not aidrian report docs');
        return 1;
      }
      const project = projectAt(path.resolve(values.project ?? '.'));
      const config = commandConfig(project);
      const since = values.since ?? '7d';
      let sinceMs;
      try {
        sinceMs = parseSince(since);
      } catch (error) {
        console.error(error.message);
        return 1;
      }
      const { file, rows, skipped } = readLog(project, config);
      if (docsView) {
        const docs = summarizeDocs(rows, { sinceMs });
        console.log(values.json ? JSON.stringify({ file, since, skipped, ...docs }) : formatDocs(docs, { file, since, skipped }));
        return 0;
      }
      const summary = summarize(rows, { sinceMs });
      if (values.prs !== undefined) {
        const count = Number(values.prs);
        if (!Number.isInteger(count) || count < 1) {
          console.error('--prs takes a whole number above 0');
          return 1;
        }
        const { reviewRounds, formatRounds } = await import('./pr-review-rounds.mjs');
        summary.reviews = reviewRounds(count, config.github.reviewer);
        if (!values.json) console.log(`${formatReport(summary, { file, since, skipped })}\n${formatRounds(summary.reviews)}`);
      } else if (!values.json) {
        console.log(formatReport(summary, { file, since, skipped }));
      }
      if (values.json) console.log(JSON.stringify({ file, since, skipped, ...summary }));
      return 0;
    },
  },
};
