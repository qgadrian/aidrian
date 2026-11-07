// Reads Claude Code transcripts (JSON Lines) for the dispatch log: token use per model, an estimated cost, the effort
// and tool calls of each request, the subagent transcripts of a session, which files an agent read, and the skills,
// draft pull requests, and review runs of a session. Counts, names, and paths only; no message text leaves this file.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readPrCall } from './rules/github/pr-body.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';

// USD per million tokens, matched by substring (or a RegExp) in this order (more specific first). List prices from
// https://platform.claude.com/docs/en/about-claude/pricing, read 2026-10-28. `cacheRead` is the cache-hit multiplier
// of the input rate where a model sets one below the standard 0.1x. Cache writes cost 1.25x (5 minutes) and 2x (1 hour).
export const PRICE_MAP = [
  { match: 'fable-5-1', input: 10, output: 50, cacheRead: 0.025 },
  { match: 'mythos-5-1', input: 10, output: 50, cacheRead: 0.025 },
  { match: 'fable-5', input: 10, output: 50 },
  { match: 'mythos-5', input: 10, output: 50 },
  { match: 'opus-5-5', input: 4, output: 20, cacheRead: 0.05 },
  { match: 'opus-5', input: 5, output: 25 },
  // Opus 4 and 4.1 kept the old $15/$75; from 4.5 on, $5/$25. A date suffix follows the version: opus-4-20250514.
  { match: 'opus-4-1', input: 15, output: 75 },
  { match: /opus-4(?:-\d{8}|$)/, input: 15, output: 75 },
  { match: 'opus-4', input: 5, output: 25 },
  { match: 'claude-3-opus', input: 15, output: 75 },
  { match: 'sonnet-5-5', input: 2, output: 10, cacheRead: 0.05 },
  { match: 'sonnet-5', input: 2, output: 10 },
  { match: 'sonnet', input: 3, output: 15 },
  { match: 'haiku-5-5', input: 0.1, output: 0.5 },
  { match: 'claude-3-5-haiku', input: 0.8, output: 4 },
  { match: 'claude-3-haiku', input: 0.25, output: 1.25 },
  { match: 'haiku', input: 1, output: 5 },
];
// The multiples of the input rate: a cache hit where the model sets none, and the two cache writes.
export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

export const priceFor = (model) =>
  PRICE_MAP.find((price) => typeof model === 'string' && (price.match instanceof RegExp ? price.match.test(model) : model.includes(price.match)));

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

// The key a request's lines share: its message id, else its request id. A line with neither is a request of its own.
const requestKey = (entry) => [entry.message?.id, entry.requestId].find((each) => typeof each === 'string' && each !== '') ?? Symbol('unkeyed');

// Usage per model over transcript text, counted once per API request: Claude Code writes one line per content block,
// each repeating its request's usage, so a per-line sum bills a request several times. Lines group by `message.id`
// (else `requestId`), and the request's last line wins. Pass the previous result as `acc` to fold in more transcripts;
// a request found in two of them still counts once.
// Returns { perModel, firstTs, lastTs, requests, tools, effort, efforts }: `tools` maps a request to the ids of its
// tool calls; `effort` is the level the host stamped on the last request, null when it stamped none, and `efforts`
// every level seen.
export function aggregateUsage(text, acc = { firstTs: null, lastTs: null, requests: new Map(), tools: new Map(), effort: null, efforts: new Set() }) {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (typeof entry.timestamp === 'string') {
      if (!acc.firstTs || entry.timestamp < acc.firstTs) acc.firstTs = entry.timestamp;
      if (!acc.lastTs || entry.timestamp > acc.lastTs) acc.lastTs = entry.timestamp;
    }
    const { usage, model, content } = entry.message ?? {};
    if (!usage || !model || model === '<synthetic>') continue;
    const key = requestKey(entry);
    acc.requests.set(key, { model, usage });
    acc.effort = typeof entry.effort === 'string' && entry.effort !== '' ? entry.effort : null;
    if (acc.effort) acc.efforts.add(acc.effort);
    for (const block of Array.isArray(content) ? content : []) {
      if (block?.type !== 'tool_use') continue;
      if (!acc.tools.has(key)) acc.tools.set(key, new Set());
      acc.tools.get(key).add(block.id ?? Symbol('tool'));
    }
  }
  return { ...acc, perModel: partOf(acc).perModel };
}

// The usage per model and the request and tool-call counts of the requests in `acc` that `keep` takes by key:
// { perModel, requests, tool_requests, tool_calls }. `tool_requests` counts the requests that made a tool call.
export function partOf(acc, keep = () => true) {
  const out = { perModel: {}, requests: 0, tool_requests: 0, tool_calls: 0 };
  for (const [key, { model, usage }] of acc?.requests ?? []) {
    if (!keep(key)) continue;
    addRequest(out.perModel, model, usage);
    out.requests += 1;
    const calls = acc.tools.get(key)?.size ?? 0;
    out.tool_requests += calls ? 1 : 0;
    out.tool_calls += calls;
  }
  return out;
}

// Estimated USD in total and per model; a model the price map does not know is listed and costs nothing here.
export function estimateCostUsd(perModel) {
  let total = 0;
  const unknownModels = [];
  const byModel = {};
  for (const [model, u] of Object.entries(perModel)) {
    const price = priceFor(model);
    if (!price) {
      unknownModels.push(model);
      continue;
    }
    const inputRate = price.input / 1_000_000;
    const cost = u.input * inputRate + u.cacheRead * inputRate * (price.cacheRead ?? CACHE_READ_MULT) +
      u.cacheWrite5m * inputRate * CACHE_WRITE_5M_MULT + u.cacheWrite1h * inputRate * CACHE_WRITE_1H_MULT + (u.output * price.output) / 1_000_000;
    byModel[model] = Math.round(cost * 10000) / 10000;
    total += cost;
  }
  return { total: Math.round(total * 10000) / 10000, unknownModels, byModel };
}

// One token total over every model: { input, output, cache_read, cache_write, cache_write_5m, cache_write_1h }.
// `cache_write` is the sum of the two cache writes, which cost 1.25x and 2x the input price.
export function sumTokens(perModel) {
  const total = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 };
  for (const u of Object.values(perModel)) {
    total.input += u.input;
    total.output += u.output;
    total.cache_read += u.cacheRead;
    total.cache_write += u.cacheWrite5m + u.cacheWrite1h;
    total.cache_write_5m += u.cacheWrite5m;
    total.cache_write_1h += u.cacheWrite1h;
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

// Every `file_path` the transcript's Read tool calls name, in order, once each. `keep` takes a request by key, as in
// partOf; the Read calls of a request it refuses are left out.
export function filesRead(text, keep = () => true) {
  const read = new Set();
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    const content = entry?.message?.content;
    if (!Array.isArray(content) || !keep(requestKey(entry))) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Read' && typeof block.input?.file_path === 'string') read.add(block.input.file_path);
    }
  }
  return [...read];
}

// The ids of the background tasks the transcript's own tool calls launched or resumed, read from the structured result
// Claude Code stores beside each tool result (the entry's `toolUseResult`), never from a result's text: a command's output
// or an agent's report that quotes a launch line launches nothing.
// - Bash: `backgroundTaskId`, set for a call started in the background and for one the host moved there at its timeout.
//   A call whose input asked for the background and whose entry has no structured result takes the id from the result's
//   leading `Command running in background with ID: <id>`: such a call's result is the host's, as its output goes to a file.
// - Agent: `agentId` of an `async_launched` result. A completed foreground agent is not running; a teammate is a peer.
// - SendMessage: `resumedAgentId`, an agent it resumed.
// `keep` takes a request by key, as in filesRead; a call it refuses, such as one a forked subagent inherited, launched
// nothing of its own. Any other call that names an id, such as reading a task's output file or stopping it, launched
// nothing. The stop hook reads it (dispatch-rows.mjs).
const LAUNCH_ID = /^[\w-]+$/u;
const BACKGROUND_LINE = /^Command running in background with ID: ([\w-]+)/u;
const idOf = (value) => (typeof value === 'string' && LAUNCH_ID.test(value) ? value : null);
const LAUNCHED = {
  Bash: (input, result, content) => idOf(result?.backgroundTaskId)
    ?? (input?.run_in_background === true && (result === undefined || result === null) ? idOf(BACKGROUND_LINE.exec(resultText(content))?.[1]) : null),
  Agent: (input, result) => (result?.status === 'async_launched' ? idOf(result.agentId) : null),
  SendMessage: (input, result) => idOf(result?.resumedAgentId),
};
LAUNCHED.Task = LAUNCHED.Agent;

export function launchedTaskIds(text, keep = () => true) {
  const calls = new Map();
  const ids = new Set();
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && typeof block.id === 'string' && Object.hasOwn(LAUNCHED, block.name) && keep(requestKey(entry))) {
        calls.set(block.id, { read: LAUNCHED[block.name], input: block.input });
      } else if (block?.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const { read, input } = calls.get(block.tool_use_id);
        const result = typeof entry.toolUseResult === 'object' && !Array.isArray(entry.toolUseResult) ? entry.toolUseResult : undefined;
        const id = read(input, result, block.content);
        if (id) ids.add(id);
      }
    }
  }
  return ids;
}

// A draft pull request create and a review run are read from the commands a Bash call runs (shell-lex walkCommands),
// never from its text, so a heredoc body, an `echo`, or a quoted grep pattern that names one is neither.
// A draft create is `gh pr create` (or its alias `gh pr new`) with --draft or -d, as the pull request body rule reads it.
const createsDraft = ({ segment }) => {
  const call = readPrCall(segment);
  return call?.subcommand === 'create' && call.draft;
};

// Whether a walked command runs a review: `aidrian pr review` or `aidrian pr await-review`, by any path to aidrian.
function runsReview({ invocation }) {
  const words = aidrianArgs(invocation);
  return words?.[0]?.text === 'pr' && ['review', 'await-review'].includes(words[1]?.text);
}

// Whether any command a Bash command line runs passes `test`; a line the lexer cannot read runs none.
const runs = (command, test) => {
  try {
    return walkCommands(command, null).some(test);
  } catch {
    return false;
  }
};

// A review round's own steps: the pr-review-loop and pr-review skills, and the commands that run a review.
const REVIEW_SKILLS = new Set(['pr-review-loop', 'pr-review']);
// A slash command as the host writes it into the user's turn. Only one that names this plugin's skill counts as a
// skill run: the others are the host's own commands, such as clearing the conversation.
const COMMAND_NAME = /<command-name>\/?([\w:.-]+)<\/command-name>/gu;
let pluginSkills;
const isPluginSkill = (name) => {
  try {
    pluginSkills ??= new Set(readdirSync(path.join(import.meta.dirname, '..', 'skills')));
  } catch {
    pluginSkills = new Set();
  }
  return pluginSkills.has(name.split(':').at(-1));
};
const PR_URL = /\/pull\/\d+/u;
// What shows a review command ran: the one JSON object `aidrian pr review` and `aidrian pr await-review` print, which
// opens with its `status`, one of these, and the pull request's `pr` (lib/review/run.mjs EXIT and `finish`, which
// lib/review/step.mjs and lib/review/stages.mjs call, and lib/pr-await-review.mjs `result`; test/transcript.test.mjs holds the list to their source). An exit code cannot show
// it: it is the whole line's, and `false && aidrian pr review 12` ends `Exit code 1` with no review run.
export const REVIEW_OUTPUT_STATUSES = Object.freeze([
  'dispatch', 'running', 'fix_required', 'received', 'none_needed', 'human_required', 'timed_out', 'checks_pending',
  'blocked_quota', 'round_limit', 'unsatisfied', 'incomplete', 'stuck', 'too_large', 'already_present', 'no_reviewer',
  'review_required', 'extension_check', 'extension_ask',
]);
const REVIEW_STATUS_SET = new Set(REVIEW_OUTPUT_STATUSES);
const REVIEW_OUTPUT = /"status"\s*:\s*"([a-z_]+)"\s*,\s*"pr"\s*:\s*(?:\d+|null)\b/gu;
// Whether a Bash call's result holds a review command's output. The command's own text is taken out first: a hook's
// refusal or a permission denial quotes it, and a quoted command is no output.
const printedReview = (output, command) =>
  [...output.split(command).join('\n').matchAll(REVIEW_OUTPUT)].some((match) => REVIEW_STATUS_SET.has(match[1]));

const resultText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n') : '';

// What a tool call does that sessionActions counts, or null: { skill, review, draft }.
function actionOf(block) {
  if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
    const skill = block.input.skill.replace(/^\//u, '');
    return { skill, review: REVIEW_SKILLS.has(skill.split(':').at(-1)), draft: false };
  }
  if (block.name !== 'Bash' || typeof block.input?.command !== 'string') return null;
  const review = runs(block.input.command, runsReview);
  const draft = runs(block.input.command, createsDraft);
  return review || draft ? { skill: null, review, draft, command: block.input.command } : null;
}

// What a session did that the health report judges, over its transcripts: { skills, drafts_opened, review_runs }.
// A tool call counts only by its result, matched by id, because a hook or the permissions can refuse it after the
// call is written: a call with no id, or with no result, as in a session cut off mid-call, counts nowhere.
// - `skills`, sorted, are the skills a Skill call ran, whose result is not an error, and the slash commands typed in the
//   user's turn that name this plugin's skill. A slash command has no tool result: the host ran it before the turn.
// - `drafts_opened` counts the draft pull request creates whose result is not an error and names a pull request URL.
// - `review_runs` counts the review skills run, as `skills` reads them, and the Bash calls that run `aidrian pr review`
//   or `aidrian pr await-review` whose result holds that command's JSON output, error or not: the exit is the whole
//   line's, so `aidrian pr review 12; test -f x` can fail after a review ran and `false && aidrian pr review 12` with none.
// A call a forked subagent's transcript repeats counts once, by its id. Names and counts only: no command or output
// leaves this function.
export function sessionActions(texts) {
  const skills = new Set();
  const commandReviews = new Set();
  const calls = new Map();
  for (const text of texts) {
    for (const line of text.split('\n')) {
      const entry = parseLine(line);
      const content = entry?.message?.content;
      if (entry?.type === 'user') {
        const typed = typeof content === 'string' ? content
          : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '';
        for (const match of typed.matchAll(COMMAND_NAME)) {
          if (!isPluginSkill(match[1])) continue;
          skills.add(match[1]);
          if (REVIEW_SKILLS.has(match[1].split(':').at(-1))) commandReviews.add(entry.uuid ?? line);
        }
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string' && !calls.has(block.id)) {
          const action = actionOf(block);
          if (action) calls.set(block.id, { ...action, ran: false, opened: false, reviewed: false });
        }
        const call = block?.type === 'tool_result' ? calls.get(block.tool_use_id) : undefined;
        if (!call) continue;
        const output = resultText(block.content);
        if (block.is_error !== true) {
          call.ran = true;
          if (call.draft && PR_URL.test(output)) call.opened = true;
        }
        call.reviewed ||= call.review && (call.skill ? call.ran : printedReview(output, call.command));
      }
    }
  }
  const all = [...calls.values()];
  for (const call of all) if (call.skill && call.ran) skills.add(call.skill);
  return {
    skills: [...skills].sort(),
    drafts_opened: all.filter((call) => call.opened).length,
    review_runs: commandReviews.size + all.filter((call) => call.reviewed).length,
  };
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
