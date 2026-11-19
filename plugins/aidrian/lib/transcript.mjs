// Reads Claude Code transcripts (JSON Lines) for the dispatch log: token use per model, an estimated cost, the effort
// and tool calls of each request, the subagent transcripts of a session, which files an agent read, and the skills,
// draft pull requests, and review runs of a session or of its last turn. Counts, names, and paths only; no message text
// leaves this file.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { costUsd, priceFor, promptTokens } from './model-prices.mjs';
import { isPrompt } from './names.mjs';
import { readBodyCall, readPrCall } from './rules/github/pr-body.mjs';
import { aidrianArgs, walkCommands } from './shell-lex.mjs';

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
const emptyUsage = () => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });

// The entry of `key` in the plain object `record`, made by `make` when missing, as an own data property: a key from a
// transcript, such as a model named __proto__, then names its own entry and never reaches Object.prototype.
function ownEntry(record, key, make) {
  if (!Object.hasOwn(record, key)) Object.defineProperty(record, key, { value: make(), enumerable: true, writable: true, configurable: true });
  return record[key];
}

// Adds one request's tokens to its model's usage. A request whose prompt is over its price row's `over.prompt` is also
// added to the usage's `over`, the part billed at the higher price (lib/model-prices.mjs costUsd); sumTokens reads the whole.
function addTokens(perModel, model, tokens) {
  const m = ownEntry(perModel, model, emptyUsage);
  const tier = priceFor(model)?.over;
  const parts = tier && promptTokens(tokens) > tier.prompt ? [m, (m.over ??= emptyUsage())] : [m];
  for (const part of parts) {
    part.calls += 1;
    for (const key of TOKEN_KEYS) part[key] += tokens[key];
  }
}

// Folds one API request's usage, and any advisor sub-inference in `usage.iterations`, into a per-model map.
function addRequest(perModel, model, usage) {
  const created = usage.cache_creation;
  const split = created && (created.ephemeral_5m_input_tokens || created.ephemeral_1h_input_tokens);
  addTokens(perModel, model, {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
    cacheWrite5m: (split ? created.ephemeral_5m_input_tokens : usage.cache_creation_input_tokens) ?? 0,
    cacheWrite1h: (split ? created.ephemeral_1h_input_tokens : 0) ?? 0,
  });
  for (const step of Array.isArray(usage.iterations) ? usage.iterations : []) {
    if (step?.type !== 'advisor_message' || !step.model) continue;
    addTokens(perModel, step.model, {
      input: step.input_tokens ?? 0,
      output: step.output_tokens ?? 0,
      cacheRead: step.cache_read_input_tokens ?? 0,
      cacheWrite5m: step.cache_creation_input_tokens ?? 0,
      cacheWrite1h: 0,
    });
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

// Estimated USD in total and per model, at the host adapters' prices (lib/model-prices.mjs). A model no table prices is
// listed in `unknownModels` and costs nothing here. `aidrian report health` names a model only a fallback row prices.
export function estimateCostUsd(perModel) {
  let total = 0;
  const unknownModels = [];
  const byModel = {};
  for (const [model, usage] of Object.entries(perModel)) {
    const price = priceFor(model);
    if (!price) {
      unknownModels.push(model);
      continue;
    }
    const cost = costUsd(usage, price);
    ownEntry(byModel, model, () => Math.round(cost * 10000) / 10000);
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

// Every `file_path` the transcript's Read, Write, Edit, MultiEdit, and NotebookEdit calls name, once each: the files the
// agent touched with its file tools, which the delivery check reads a claimed path's root from (delivery-check.mjs).
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export function filesTouched(text) {
  const files = new Set();
  for (const line of text.split('\n')) {
    const content = parseLine(line)?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const file = block?.type === 'tool_use' && FILE_TOOLS.has(block.name) ? block.input?.file_path ?? block.input?.notebook_path : null;
      if (typeof file === 'string') files.add(file);
    }
  }
  return [...files];
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

// A pull request update: `gh pr edit`, which a pr-write run uses to publish into a pull request that is open already.
const editsPr = ({ segment }) => readPrCall(segment)?.subcommand === 'edit';

// Whether a walked command runs a review: `aidrian pr review` or `aidrian pr await-review`, by any path to aidrian.
function runsReview({ invocation }) {
  const words = aidrianArgs(invocation);
  return words?.[0]?.text === 'pr' && ['review', 'await-review'].includes(words[1]?.text);
}

// Whether a walked command runs the auto-merge gate, `aidrian pr auto-merge`, by any path to aidrian.
function runsGate({ invocation }) {
  const words = aidrianArgs(invocation);
  return words?.[0]?.text === 'pr' && words[1]?.text === 'auto-merge';
}

// The pull request number a gate command was given, as `12`, `#12`, or a pull request URL; null when it names none or
// one this cannot read, such as a dynamic word.
const PR_ARGUMENT = /^(?:#?(\d+)|https?:\/\/\S+\/pull\/(\d+)\/?)$/u;
function gateTarget({ invocation }) {
  const word = aidrianArgs(invocation).slice(2).find((token) => token.dynamic || !token.text.startsWith('-'));
  const named = word && !word.dynamic ? PR_ARGUMENT.exec(word.text) : null;
  return named ? Number(named[1] ?? named[2]) : null;
}

// The pull request a `gh pr merge` command names: its number, 0 for a merge that names none (the current branch's), or
// null for any other command or a target it cannot read.
function mergeTarget({ segment }) {
  const call = readBodyCall(segment);
  if (call?.noun !== 'pr' || call.subcommand !== 'merge') return null;
  if (!call.target) return 0;
  const named = call.target.dynamic ? null : PR_ARGUMENT.exec(call.target.text);
  return named ? Number(named[1] ?? named[2]) : null;
}

// The commands a Bash command line runs that pass `test`; none for a line the lexer cannot read.
const matching = (command, test) => {
  try {
    return walkCommands(command, null).filter(test);
  } catch {
    return [];
  }
};
// Whether any command a Bash command line runs passes `test`.
const runs = (command, test) => matching(command, test).length > 0;

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
// A call's output without the lines that quote its command, as a hook's refusal or a permission denial does, dropped
// whole: a line that holds the whole command or its first line, which a denial prefixes, and a line that is, trimmed,
// another line of the command. Those others must match whole: a short one, such as `fi` or `}`, is part of many lines.
const withoutCommand = (output, command) => {
  const [first, ...rest] = command.split('\n').map((line) => line.trim());
  const held = [command, first].filter(Boolean);
  const whole = new Set(rest.filter(Boolean));
  return output.split('\n').filter((line) => !held.some((part) => line.includes(part)) && !whole.has(line.trim())).join('\n');
};
const printedReview = (output, command) =>
  [...withoutCommand(output, command).matchAll(REVIEW_OUTPUT)].some((match) => REVIEW_STATUS_SET.has(match[1]));

// The verdicts `aidrian pr auto-merge` printed in a call's output: [{ pr, path }], one per verdict, where `path` is the
// changed file of a refusal that names one, else null (lib/pr-auto-merge.mjs runAutoMerge prints them). A verdict is a
// line that starts `auto-merge on for #<n> ` or `auto-merge off for #<n>: `, or, under --json, a line that is one object
// with a boolean `effective` and a whole-number `pr`. A refusal names a path when its sentence, the `why` of the object
// under `reason` "paths", opens `it changes "<path>",` as each refusal of pathsProblem that names a changed file does:
// a guarded path, a policy file, a file the gate reads its policy from, the release script, a start-loaded knowledge doc,
// and a file outside the project's folder. A refusal for a rename, a file count, or any other reason names none.
// test/transcript.test.mjs builds those sentences from pathsProblem itself, so its wording and this reader stay in step.
// The `s` flag lets the sentence hold a line separator, such as U+2028 in a path, which `.` would stop at.
const GATE_LINE = /^auto-merge (on|off) for #(\d+)(?: at [0-9a-f]+: |: )(.*)$/su;
const CHANGED_PATH = /^it changes ("(?:[^"\\]|\\.)*"),/u;
const changedPath = (why) => {
  const quoted = typeof why === 'string' ? CHANGED_PATH.exec(why)?.[1] : undefined;
  if (!quoted) return null;
  try {
    return JSON.parse(quoted);
  } catch {
    return null;
  }
};
export function gateVerdicts(output) {
  const verdicts = [];
  for (const line of output.split(/\r?\n/u)) {
    const plain = GATE_LINE.exec(line);
    if (plain) {
      verdicts.push({ pr: Number(plain[2]), path: plain[1] === 'off' ? changedPath(plain[3]) : null });
      continue;
    }
    if (!line.startsWith('{')) continue;
    let object;
    try {
      object = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof object?.effective !== 'boolean' || !Number.isSafeInteger(object.pr) || object.pr < 1) continue;
    verdicts.push({ pr: object.pr, path: !object.effective && object.reason === 'paths' ? changedPath(object.why) : null });
  }
  return verdicts;
}

// The pull requests a merge call that ran merged: each target it named, and for a merge that named none, the number gh
// printed in its `merged pull request <repo>#<n>` line, or null, any pull request, when it printed none: gh prints that
// line on a terminal only, and a merge read as any pull request can only miss a refusal, never invent one.
const MERGED_LINE = /merged pull request (?:[\w.-]+\/[\w.-]+)?#(\d+)/giu;
function mergedPulls(targets, output) {
  const merged = targets.flatMap((target) => {
    if (target > 0) return [target];
    const printed = [...output.matchAll(MERGED_LINE)].map((match) => Number(match[1]));
    return printed.length ? printed : [null];
  });
  return [...new Set(merged)];
}

const resultText = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n') : '';

// What a tool call does that sessionActions or turnActions counts, or null: { skill, review, draft, edit, gate, merges }.
// `gates` are the targets of its `aidrian pr auto-merge` commands, and `merges` those of its `gh pr merge` commands.
function actionOf(block) {
  if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
    const skill = block.input.skill.replace(/^\//u, '');
    return { skill, review: REVIEW_SKILLS.has(baseName(skill)), draft: false, edit: false, gates: [], merges: [] };
  }
  if (block.name !== 'Bash' || typeof block.input?.command !== 'string') return null;
  const review = runs(block.input.command, runsReview);
  const draft = runs(block.input.command, createsDraft);
  const edit = runs(block.input.command, editsPr);
  const gates = matching(block.input.command, runsGate).map(gateTarget);
  const merges = matching(block.input.command, (walked) => mergeTarget(walked) !== null).map(mergeTarget);
  return review || draft || edit || gates.length || merges.length ? { skill: null, review, draft, edit, gates, merges, command: block.input.command } : null;
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
      for (const skill of typedSkills(entry)) {
        skills.add(skill);
        if (REVIEW_SKILLS.has(baseName(skill))) commandReviews.add(entry.uuid ?? line);
      }
      settleCalls(entry, calls);
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

const baseName = (skill) => skill.split(':').at(-1);

// This plugin's skills a slash command typed in a user entry names; none for any other entry. Only the entry's string or
// text blocks are read, so a tool result that quotes a command is none.
function typedSkills(entry) {
  if (entry?.type !== 'user') return [];
  const content = entry.message?.content;
  const typed = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '';
  return [...typed.matchAll(COMMAND_NAME)].map((match) => match[1]).filter(isPluginSkill);
}

// Reads one entry's tool calls and results into `calls`, as sessionActions counts them: a call actionOf counts is added
// under its id, once, and a result settles the call of its id. `ran` is a result that is no error, `opened` a draft
// create's such result that names a pull request URL, and `reviewed` a review skill that ran or a review command whose
// result printed its JSON. `verdicts` are what a gate call printed (gateVerdicts), error or not, since a refusal exits 1,
// read from the output without the lines that quote the command, for the pull requests the gates were given when each
// was given one, and only when it holds one verdict per gate command the call ran: a verdict line another command
// printed for the same pull request, or a path that quotes the command, leaves none. `merged` are
// the pull requests a merge call merged, when its result is no error. Returns the calls a result settled in this entry,
// in order.
function settleCalls(entry, calls) {
  const settled = [];
  const content = entry?.message?.content;
  if (!Array.isArray(content)) return settled;
  for (const block of content) {
    if (block?.type === 'tool_use' && typeof block.id === 'string' && !calls.has(block.id)) {
      const action = actionOf(block);
      if (action) calls.set(block.id, { ...action, ran: false, opened: false, reviewed: false, verdicts: [], merged: [] });
    }
    const call = block?.type === 'tool_result' ? calls.get(block.tool_use_id) : undefined;
    if (!call) continue;
    const output = resultText(block.content);
    if (block.is_error !== true) {
      call.ran = true;
      if (call.draft && PR_URL.test(output)) call.opened = true;
    }
    call.reviewed ||= call.review && (call.skill ? call.ran : printedReview(output, call.command));
    if (call.gates.length) {
      // With every gate's pull request known, a verdict for another one, which another command printed, is dropped.
      const given = call.gates.includes(null) ? null : new Set(call.gates);
      const verdicts = gateVerdicts(withoutCommand(output, call.command)).filter(({ pr }) => !given || given.has(pr));
      call.verdicts = verdicts.length === call.gates.length ? verdicts : [];
    }
    if (call.merges.length && block.is_error !== true) call.merged = mergedPulls(call.merges, output);
    settled.push(call);
  }
  return settled;
}

// The skills whose run opens or updates a pull request through a draft create or `gh pr edit`.
const DRAFT_SKILLS = new Set(['pr-write']);

// A prompt the Human wrote: a user entry names.mjs reads as a prompt, not the host's own (isMeta), a subagent's
// (isSidechain), or a compaction summary, with no origin or a human one; or a message the Human typed while the agent
// worked, which Claude Code writes as a `queued_command` attachment with no user entry (rules/review-extend.mjs names the
// shape). A task notification marked as such is none. The reading is broad on purpose: a boundary it misses can only
// send a turn back wrongly, while an extra one only narrows the turn, which keeps the check silent.
const humanPrompt = (entry) => {
  if (entry.type === 'attachment') return entry.attachment?.type === 'queued_command' && (entry.attachment.origin?.kind ?? 'human') === 'human';
  return entry.type === 'user' && entry.isMeta !== true && entry.isSidechain !== true && entry.isCompactSummary !== true
    && (entry.origin?.kind ?? 'human') === 'human' && isPrompt(entry.message?.content);
};

// What the main session did since the Human's last prompt, in transcript order: [{ kind: 'draft' | 'review' }],
// { kind: 'gate', pr, path }, { kind: 'merge', pr } (pr null: a merge of no known pull request), and { kind: 'reply', text }, or the whole transcript's with no such
// prompt. A draft is a draft create that opened a
// pull request, or a `gh pr edit` that ran after a pr-write run (a Skill call that ran, or a typed command) with no
// review earlier in the turn: a pr-write run that published nothing, such as one stopped on a failed check, is none,
// and an update after a review is the loop's own, as when it copies residuals into the body, even when the turn
// started at the loop on an earlier turn's pull request. A draft create after a review still counts. A review is what sessionActions counts as a review run. A call
// counts only by its result, as there. A gate is one verdict an `aidrian pr auto-merge` call printed (settleCalls): a
// call that printed none, such as an error exit, is none. A merge is a pull request a `gh pr merge` call that ran merged.
// A reply is the text of an assistant message, for the merge hand-back check to find an item an earlier report of the
// turn gave. A subagent's entries are skipped. The stop hook's review-loop check reads it (stop-review-loop.mjs), and its
// merge hand-back check the gates, merges, and replies (stop-handback.mjs mergeHandBack). It is read in the hook only:
// the replies are the session's own text, and no caller writes them anywhere.
export function turnActions(text) {
  const entries = text.split('\n').map(parseLine).filter((entry) => entry && entry.isSidechain !== true);
  const start = Math.max(entries.findLastIndex(humanPrompt), 0);
  const calls = new Map();
  const actions = [];
  let writing = false;
  let reviewed = false;
  const review = () => {
    actions.push({ kind: 'review' });
    reviewed = true;
  };
  for (const entry of entries.slice(start)) {
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) actions.push({ kind: 'reply', text: block.text });
      }
    }
    for (const skill of typedSkills(entry)) {
      if (DRAFT_SKILLS.has(baseName(skill))) writing = true;
      if (REVIEW_SKILLS.has(baseName(skill))) review();
    }
    for (const call of settleCalls(entry, calls)) {
      if (call.skill && call.ran && DRAFT_SKILLS.has(baseName(call.skill))) writing = true;
      if (call.opened || (writing && !reviewed && call.edit && call.ran)) {
        actions.push({ kind: 'draft' });
        writing = false;
      }
      if (call.reviewed) review();
      for (const { pr, path: file } of call.verdicts) actions.push({ kind: 'gate', pr, path: file });
      for (const pr of call.merged) actions.push({ kind: 'merge', pr });
    }
  }
  return actions;
}

// The text of the transcript's first user message: a subagent's brief, the prompt its dispatcher wrote. A string, or the
// text blocks of a content array joined by new lines; null when the first user message has neither.
// SHORTCUT: a forked subagent's transcript starts with its parent's messages, so its first user message is the parent's;
// a check that reads the brief then finds nothing of this agent's, which lets the stop end. Reading the fork's own
// prompt would need the `.meta.json` beside the transcript to name where it starts.
export function firstPrompt(text) {
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    if (entry?.type !== 'user') continue;
    const content = entry.message?.content;
    if (typeof content === 'string') return content;
    const texts = Array.isArray(content) ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string') : [];
    return texts.length ? texts.map((block) => block.text).join('\n') : null;
  }
  return null;
}

// The message of the transcript's last handback call when no assistant text follows it, else null: the report a subagent
// delivered through the host's handback tool, which ends its run, so its last message may hold no text of the report.
// Claude Code names the tool SubagentHandback; a host whose transcript this module does not read has none.
const HANDBACK_TOOL = 'SubagentHandback';
export function lastHandback(text) {
  let message = null;
  for (const line of text.split('\n')) {
    const entry = parseLine(line);
    const content = entry?.type === 'assistant' ? entry.message?.content : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === HANDBACK_TOOL && typeof block.input?.message === 'string') message = block.input.message;
      else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') message = null;
    }
  }
  return message;
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
