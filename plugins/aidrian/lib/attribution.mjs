// Who wrote a change, for config.json `attribution` (docs/config.md#attribution): the agent, its model and effort, the
// tool that ran it, and where it ran. Every value is read from the hook payload, the host's transcript, the environment,
// git, or the dispatch log, never from what an agent says about itself. A value none of them gives is left out.
// lib/rules/attribution.mjs blocks an agent's commit or new pull request that does not carry them.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

import { COMMIT_FIELDS, PR_FIELDS } from './config.mjs';
import { runGit } from './git.mjs';
import { aggregateUsage } from './transcript.mjs';

export { COMMIT_FIELDS, PR_FIELDS };

export const TRAILERS = { agent: 'Agent', model: 'Agent-Model', effort: 'Agent-Effort', tool: 'Agent-Tool', env: 'Agent-Env' };

// The end of a transcript is enough for the last request; a whole long session could outlast the hook's timeout.
const TAIL_BYTES = 1024 * 1024;
// A value that fits on one trailer line and inside single quotes in the hint.
const SAFE = /^[\w.:@/[\] -]+$/u;
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

// An agent's name without the plugin's prefix: Claude Code says `aidrian:<agent>`, Codex `aidrian-<agent>`.
export const agentName = (name) => text(name)?.replace(/^aidrian[:-]/u, '') ?? null;

// The last `bytes` of `file`, from its first whole line; null when it cannot be read.
export function readTail(file, bytes = TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const content = buffer.toString('utf8');
    return start === 0 ? content : content.slice(content.indexOf('\n') + 1);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// Where the session runs: `cloud` in a Claude Code cloud session, `ci` on a CI runner, else `local`.
export function runEnv(env) {
  if (env.CLAUDE_CODE_REMOTE === 'true') return 'cloud';
  if (env.GITHUB_ACTIONS === 'true' || (text(env.CI) && env.CI !== 'false' && env.CI !== '0')) return 'ci';
  return 'local';
}

// { agent, model, effort, tool, env } of the agent making this tool call; null where nothing tells.
// A subagent's call names it (`agent_id`, `agent_type`), and its own transcript sits beside the session's. It inherits the
// session's environment, so CLAUDE_EFFORT and CLAUDE_CODE_AGENT speak only for the main session.
export function currentAuthor(input, env = process.env) {
  const agentId = text(input.agent_id);
  const main = text(input.transcript_path);
  const subagent = Boolean(agentId);
  const file = subagent
    ? main && /^[\w-]+$/u.test(agentId) && /^[\w-]+$/u.test(input.session_id ?? '')
      ? path.join(path.dirname(main), input.session_id, 'subagents', `agent-${agentId}.jsonl`)
      : null
    : main;
  const transcript = file ? readTail(file) : null;
  const usage = transcript ? aggregateUsage(transcript) : null;
  const last = usage ? [...usage.requests.values()].at(-1) : null;
  return {
    agent: agentName(input.agent_type) ?? (subagent ? null : agentName(env.CLAUDE_CODE_AGENT) ?? 'main'),
    model: text(last?.model),
    effort: text(usage?.effort) ?? (subagent ? null : text(env.CLAUDE_EFFORT)),
    tool: env.CODEX_THREAD_ID ? 'Codex' : 'Claude Code',
    env: runEnv(env),
  };
}

// The trailer lines the configured `fields` ask for, as `Key: value`, for the values that are known.
export function expectedTrailers(fields, author) {
  return fields.filter((field) => author[field] && SAFE.test(author[field])).map((field) => `${TRAILERS[field]}: ${author[field]}`);
}

// The trailer lines a commit carries, as `Key: value`: each `--trailer` value, which git takes with `:` or `=`, and the
// message's trailer block, as git reads one by default: its last paragraph, past the subject, when every line is a
// `Key: value` trailer or a continuation indented under one. `messages` are the -m values in order, which git joins as
// paragraphs, or a -F file's text.
export function carriedTrailers(messages, trailers) {
  const paragraphs = messages.join('\n\n').replace(/\r\n/gu, '\n').split(/\n[ \t]*\n/u).map((part) => part.trim()).filter(Boolean);
  const block = paragraphs.length > 1 ? paragraphs.at(-1).split('\n') : [];
  const isBlock = block.length > 0 && block.every((line) => /^[A-Za-z0-9-]+:\s*\S/u.test(line) || /^\s+\S/u.test(line));
  const fromMessage = isBlock ? block.filter((line) => !/^\s/u.test(line)).map((line) => line.replace(/^([A-Za-z0-9-]+):\s*/u, '$1: ').trim()) : [];
  const fromOptions = trailers.map((line) => line.trim().replace(/^([A-Za-z0-9-]+)\s*[:=]\s*/u, '$1: '));
  return new Set([...fromOptions, ...fromMessage]);
}

// The agents of a pull request with their models, in first-seen order: each `Agent:` trailer on the branch's commits
// (with that commit's `Agent-Model:`), then each agent this session dispatched (with the models its `stop` rows name).
// `main` and the names in `exclude` are left out. Returns [{ name, models }].
export function prAgents({ commits = [], rows = [], sessionId, exclude = [] }) {
  const skip = new Set(['main', ...exclude.map(agentName)]);
  const agents = new Map();
  const add = (name, model) => {
    const key = agentName(name);
    if (!key || skip.has(key)) return;
    if (!agents.has(key)) agents.set(key, new Set());
    if (text(model)) agents.get(key).add(text(model));
  };
  for (const { agent, model } of commits) add(agent, model);
  for (const row of rows) {
    if (row.session_id !== sessionId) continue;
    if (row.event === 'dispatch') add(row.agent_type);
    if (row.event === 'stop') for (const model of Array.isArray(row.models) ? row.models : []) add(row.agent_type, model);
  }
  return [...agents].map(([name, models]) => ({ name, models: [...models] }));
}

// The `Agent:` and `Agent-Model:` trailers of the commits on `head` that `base` lacks: [{ agent, model }]. `head` is a
// branch, or `<owner>:<branch>` as gh takes it; HEAD by default. [] when git cannot tell.
export function branchCommits(cwd, base, head = 'HEAD') {
  const format = '%(trailers:key=Agent,valueonly,separator=%x1f)%x1e%(trailers:key=Agent-Model,valueonly,separator=%x1f)%x1d';
  const branch = head.replace(/^[^:]+:/u, '');
  const tips = branch === 'HEAD' ? ['HEAD'] : [branch, `origin/${branch}`];
  for (const tip of tips) {
    for (const ref of [`origin/${base}`, base]) {
      const result = runGit(['log', `${ref}..${tip}`, `--format=${format}`, '--'], cwd);
      if (result.status !== 0) continue;
      return result.stdout.split('\x1d').map((entry) => entry.trim()).filter(Boolean).flatMap((entry) => {
        const [agents = [], models = []] = entry.split('\x1e').map((part) => part.split('\x1f').map((each) => each.trim()).filter(Boolean));
        return agents.map((agent) => ({ agent, model: models[0] ?? null }));
      });
    }
  }
  return [];
}

// The lines a pull request body ends with: `Authored-with: <tool> — <model> (<effort> effort, <env>)`, then one
// `Assisted-by: <agent> (<models>)` per agent. Only the configured, known parts; [] when none is.
export function prLines(fields, author, agents = []) {
  const has = (field) => fields.includes(field) && author[field] && SAFE.test(author[field]);
  const lead = [has('tool') && author.tool, has('model') && author.model].filter(Boolean).join(' — ');
  const notes = [has('effort') && `${author.effort} effort`, has('env') && author.env].filter(Boolean).join(', ');
  const lines = [];
  if (lead || notes) lines.push(`Authored-with: ${[lead, notes && `(${notes})`].filter(Boolean).join(' ')}`);
  if (fields.includes('agents')) {
    for (const { name, models } of agents) lines.push(`Assisted-by: ${name}${models.length ? ` (${models.join(', ')})` : ''}`);
  }
  return lines;
}

const assisted = (line) => line.slice('Assisted-by:'.length).trim().split(/[\s(]/u)[0];

// The lines of `expected` (from prLines) that `body` lacks: the `Authored-with:` line as written, and an `Assisted-by:`
// line for each agent, in any order and whatever models it names.
export function prMissing(body, expected) {
  const lines = body.split(/\r?\n/u).map((line) => line.trim());
  const named = new Set(lines.filter((line) => line.startsWith('Assisted-by:')).map(assisted));
  return expected.filter((line) => (line.startsWith('Assisted-by:') ? !named.has(assisted(line)) : !lines.includes(line)));
}
