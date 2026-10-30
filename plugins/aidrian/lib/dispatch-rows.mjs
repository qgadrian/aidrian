// The rows the hooks write to the dispatch log (dispatch-log.mjs): `dispatch` after an Agent call, `stop` when a subagent
// stops, `session` when a session ends, and `hook_deny` when one of the plugin's rules blocks a call; and the delivery
// check behind a `stop` row, which reads the paths a subagent's last message presents as written.
// docs/dispatch-log.md describes every field.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { stamp } from './dispatch-log.mjs';
import { fileBytes } from './fs.mjs';
import { checkoutRoots } from './git.mjs';
import { loadKnowledge } from './knowledge.mjs';
import { aggregateUsage, estimateCostUsd, filesRead, partOf, readText, subagentTranscripts, sumTokens } from './transcript.mjs';

const DESCRIPTION_CHARS = 80;
// A hook_deny row's `reason`: the start of what the rule matched.
const REASON_CHARS = 120;
const CLAIMED_PATHS = 20;
// A path an agent's last message names: a .md or .json token with a `/`, not inside a URL or a template.
const CLAIM = /(?<![\w.~/:@<>{}$*%#-])(~?[\w.-]*\/[\w.~/-]*\.(?:md|json))(?![\w/<>{}*-])/gu;
// A line that presents a file as delivered: a delivery word that is not part of a path, or the 📄 file marker.
const DELIVERY_LINE = /(?<![\w./-])(?:wrote|written|created|saved|handoffs?|outputs?)(?![\w./-])|📄/iu;

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
