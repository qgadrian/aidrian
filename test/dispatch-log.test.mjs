import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, cpSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { coverage, coverageLines } from '../plugins/aidrian/lib/dispatch-log.mjs';
import { claimedPaths, dispatchRow, sessionRow } from '../plugins/aidrian/lib/dispatch-rows.mjs';
import { formatReport, summarize } from '../plugins/aidrian/lib/report-agents.mjs';
import { formatDocs, summarizeDocs } from '../plugins/aidrian/lib/report-docs.mjs';
import { parseSince } from '../plugins/aidrian/lib/report.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { endedSessions } from '../plugins/aidrian/lib/jsonl.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { hookCall } from './hook-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
// The lock files beside `file` (jsonl.mjs withLocks), sorted.
const lockFiles = (file) => readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.lock`)).sort();
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const SCRIPTS = path.join(ROOT, 'plugins/aidrian/scripts');
const NOW = Date.parse('2026-10-29T12:00:00Z');

const usageLine = (id, model, usage, ts = '2026-10-29T10:00:00Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content: [] } });

// A copy of the example consumer in a git repository, with its own state folder under `stateHome`.
function project(t, { stateHome = 'state' } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-dlog-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  mkdirSync(path.join(base, 'tmp'));
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, stateHome), TMPDIR: path.join(base, 'tmp') };
  const state = () => spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  const log = () => {
    try {
      return readFileSync(path.join(state(), 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  // A hook called in this process, as the host runs its script; hookProcess runs the script as its own process.
  const hook = (script, input) => hookCall(path.join(SCRIPTS, script), { input: JSON.stringify(input), env });
  const hookProcess = (script, input, options = {}) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env, ...options });
  // The session-end hook hands the session row to a detached worker: wait for it, so the worker has finished before
  // the test's folder is removed. `rows` is how many rows the log holds once it has.
  const logged = async (rows) => {
    for (const deadline = Date.now() + 15_000; log().length < rows; await sleep(25)) {
      if (Date.now() > deadline) assert.fail(`the log never reached ${rows} rows: ${JSON.stringify(log())}`);
    }
    return log();
  };
  return { base, dir, env, state, log, hook, hookProcess, logged };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a dispatch row keeps names, counts, and a short description, and never the prompt', () => {
  const row = dispatchRow(
    {
      session_id: 's1',
      tool_name: 'Agent',
      tool_input: { subagent_type: 'Explore', description: `Find the ${'x'.repeat(100)}`, prompt: 'SECRET PROMPT', name: 'scout' },
      tool_response: { status: 'completed', agentId: 'a1', content: [{ type: 'text', text: 'SECRET RESULT' }], totalDurationMs: 4200, totalToolUseCount: 7 },
    },
    { env: { CLAUDE_CODE_AGENT: 'orchestrator' }, now: NOW },
  );
  assert.deepEqual({ ...row, description: row.description.length }, {
    event: 'dispatch', ts: '2026-10-29T12:00:00.000Z', session_id: 's1', dispatcher: 'orchestrator', agent_id: 'a1', agent_type: 'Explore',
    name: 'scout', description: 80, background: false, status: 'completed', duration_ms: 4200, tool_uses: 7,
  });
  assert.doesNotMatch(JSON.stringify(row), /SECRET/);
  const background = dispatchRow({ tool_input: { run_in_background: true }, tool_response: { status: 'async_launched' }, agent_type: 'planner' }, { env: {}, now: NOW });
  assert.deepEqual([background.background, background.dispatcher, background.agent_type, background.duration_ms], [true, 'planner', 'general-purpose', null]);
});

test('claimedPaths finds .md and .json paths with a slash, and skips URLs, templates, and bare names', () => {
  const message = [
    'Wrote `/abs/out/handoff.json` and docs/hooks.md, see docs/hooks.md#rules and src/a.md:12.',
    'Saved: https://github.com/acme/notes/blob/main/README.md, <state>/handoffs/x.md, {dir}/y.json, docs/*.md, README.md, ~/notes/todo.md.',
  ].join('\n');
  assert.deepEqual(claimedPaths(message), ['/abs/out/handoff.json', 'docs/hooks.md', 'src/a.md', '~/notes/todo.md']);
  assert.deepEqual(claimedPaths(undefined), []);
});

test('claimedPaths reads only the lines that present a file as delivered', () => {
  const message = [
    'Wrote docs/new.md.',
    'docs/old.md does not exist, so I left it alone.',
    '📄 out/plan.json',
    'Read docs/output-format.md and src/handoff/notes.md first.',
    'Handoff: /abs/handoff.json',
  ].join('\n');
  assert.deepEqual(claimedPaths(message), ['docs/new.md', 'out/plan.json', '/abs/handoff.json']);
});

test('the hooks write dispatch, stop, and session rows inside a project, and nothing outside one', async (t) => {
  const { base, dir, log, hook, logged } = project(t);
  const transcript = path.join(base, 's1.jsonl');
  const agent = path.join(base, 's1/subagents/agent-a1.jsonl');
  mkdirSync(path.dirname(agent), { recursive: true });
  const read = (file, model = 'claude-sonnet-5-5') => JSON.stringify({ type: 'assistant', message: { id: file, model, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });
  // The main conversation reads one doc in the project, and one in a worktree that is gone by the end of the session.
  writeFileSync(transcript, [
    usageLine('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }, '2026-10-29T10:00:00Z'),
    usageLine('m2', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }, '2026-10-29T10:30:00Z'),
    read(path.join(dir, 'docs/knowledge/product/product-rules.md'), 'claude-opus-5-5'),
    read(path.join(base, 'gone-worktree/docs/knowledge/product/sharing.md'), 'claude-opus-5-5'),
  ].join('\n'));
  writeFileSync(agent, [read(path.join(dir, 'docs/knowledge/engineering/testing.md')), read(path.join(dir, 'src/sharing.js'))].join('\n'));
  const bytes = (doc) => statSync(path.join(dir, doc)).size;

  assert.equal((await hook('hook-agent-post.mjs', { session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: 'Find tests' }, tool_response: { status: 'completed', agentId: 'a1', totalDurationMs: 1000 } })).status, 0);
  const stop = await hook('hook-subagent-stop.mjs', { session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: agent, last_assistant_message: 'Done; nothing written.', stop_hook_active: false });
  assert.deepEqual([stop.status, stop.stderr], [0, '']);
  assert.equal((await hook('session-row.mjs', { session_id: 's2', cwd: dir, transcript_path: path.join(base, 'empty.jsonl') })).status, 0);
  assert.equal(log().length, 2, 'no usage: no row');
  assert.equal((await hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript, reason: 'exit' })).status, 0);

  const rows = await logged(3);
  assert.deepEqual(rows.map((row) => row.event), ['dispatch', 'stop', 'session']);
  assert.deepEqual(rows[1].tokens, { input: 10 + 10, output: 10, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 });
  const testing = 'docs/knowledge/engineering/testing.md';
  assert.deepEqual([rows[1].docs_read, rows[1].delivered, rows[1].models], [[{ path: testing, bytes: bytes(testing) }], 'chat', ['claude-sonnet-5-5']]);
  assert.deepEqual([rows[1].requests, rows[1].tool_requests, rows[1].tool_calls], [2, 2, 2], 'two requests, each with one Read');
  assert.deepEqual([rows[2].duration_min, rows[2].subagent_count, rows[2].models], [30, 1, ['claude-opus-5-5', 'claude-sonnet-5-5']]);
  const [rules, sharing] = ['docs/knowledge/product/product-rules.md', 'docs/knowledge/product/sharing.md'];
  assert.deepEqual(rows[2].docs_read, [{ path: rules, bytes: bytes(rules) }, { path: sharing, bytes: bytes(sharing) }], 'main reads only, sized from the project copy once the read one is gone');
  assert.ok(rows[2].cost_usd > 0);

  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-dlog-none-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal((await hook('hook-agent-post.mjs', { cwd: outside, tool_name: 'Agent', tool_input: {}, tool_response: {} })).status, 0);
  assert.equal(log().length, 3);
});

test('the delivery check sends a subagent back once for a path it named that does not exist', async (t) => {
  const { dir, log, hook } = project(t);
  mkdirSync(path.join(dir, 'out'));
  writeFileSync(path.join(dir, 'out/real.json'), '{}');
  const stop = (message, active) => hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a2', agent_type: 'planner', last_assistant_message: message, stop_hook_active: active });
  const sent = await stop('Wrote out/real.json and out/handoff.json.', false);
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^Your report names `out\/handoff\.json`, which does not exist\. If you meant to write it, write it now/);
  assert.equal((await stop('Wrote out/real.json and out/handoff.json.', true)).status, 0, 'the second stop always ends');
  assert.equal((await hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a3', last_assistant_message: 'Wrote out/none.json.' })).status, 0, 'no stop_hook_active field: never sent back');
  assert.deepEqual([(await stop('Wrote out/real.json.', false)).status], [0]);
  assert.equal((await stop('out/gone.json does not exist, so I skipped it.', false)).status, 0, 'a mention is not a claim');
  const inline = JSON.stringify({ status: 'done', role: 'explorer', evidence: [{ file: 'docs/absent.md', shows: 'no such doc' }] }, null, 2);
  assert.equal((await stop(inline, false)).status, 0, 'a handoff returned in the last message, as a read-only agent returns it, claims no file');
  assert.deepEqual(log().map((row) => [row.agent_id, row.delivered, row.sent_back]), [
    ['a2', 'missing', true], ['a2', 'missing', false], ['a3', 'missing', false], ['a2', 'file', false], ['a2', 'chat', false], ['a2', 'chat', false],
  ]);
  const agents = summarize(log()).agents.map((agent) => [agent.agent_type, agent.runs, agent.sent_back, agent.sent_back_rate, agent.runs_without_send_back]);
  assert.deepEqual(agents, [['general-purpose', 1, 0, 0, 0], ['planner', 1, 1, 1, 0]], 'a3 named a missing file and was never sent back; a2 was, once');
});

test('the delivery check finds a claimed path under the state folder, the plugin, a skill, another worktree, or a file the agent touched', async (t) => {
  const { base, dir, state, hook } = project(t);
  const git = (...args) => spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // Another worktree of the repository, with the pull request body an orchestrator wrote there.
  const other = path.join(base, 'other-worktree');
  git('worktree', 'add', '-q', '-b', 'fix/other', other);
  mkdirSync(path.join(other, 'tmp'));
  writeFileSync(path.join(other, 'tmp/pr-body-fix-other.md'), 'body');
  // The state folder's dispatch, plans, reviews, and tmp files, as the real reports named them.
  const folder = state();
  for (const file of ['dispatch/feat-139-S1-harness-mechanic.json', 'plans/140-implementation.md', 'reviews/pr-6007.json', 'tmp/pr-body-fix-12.md']) {
    mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    writeFileSync(path.join(folder, file), '{}');
  }
  // A file in another project the agent wrote with its own Write call.
  const elsewhere = path.join(base, 'elsewhere');
  mkdirSync(path.join(elsewhere, 'docs/product'), { recursive: true });
  writeFileSync(path.join(elsewhere, 'docs/product/tables.md'), 'x');
  const transcript = path.join(base, 'agent-a5.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: { file_path: path.join(elsewhere, 'docs/product/tables.md'), content: 'x' } }] } }));
  const stop = (message) => hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a5', agent_type: 'aidrian:agent-issue-writer', agent_transcript_path: transcript, last_assistant_message: message, stop_hook_active: false });
  const present = [
    'Wrote dispatch/feat-139-S1-harness-mechanic.json, plans/140-implementation.md, reviews/pr-6007.json, and tmp/pr-body-fix-12.md.',
    'Handoff follows references/issue-body.md and references/tracker.md, as written in skills/agent-issue-writer/references/issue-body.md.',
    'Output: knowledge/references/handoff.md',
    'Wrote tmp/pr-body-fix-other.md in the other worktree.',
    'Wrote docs/product/tables.md.',
  ];
  for (const message of present) assert.deepEqual([(await stop(message)).status, (await stop(message)).stderr], [0, ''], message);
  const sent = await stop('Wrote plans/never-written.md and tmp/never-written.md.');
  assert.equal(sent.status, 2, 'a path under no root is still sent back');
  assert.match(sent.stderr, /^Your report names `plans\/never-written\.md`, `tmp\/never-written\.md`, which does not exist\./u);
});

test('the delivery check sends a subagent back once for a handoff file its brief asked for, when it has no report to write there', async (t) => {
  const { base, dir, state, log, hook } = project(t);
  const dispatch = path.join(state(), 'dispatch');
  const own = path.join(dispatch, 'feat-12-S1-code-reviewer.json');
  // Another agent's handoff, on a branch whose name holds this agent's: still not this agent's.
  const other = path.join(dispatch, 'fix-code-reviewer-delivery-S1-backend-developer.json');
  const transcript = path.join(base, 'agent-a6.jsonl');
  const brief = `Review slice S1. Read the implementer's handoff at ${other}.\nHandoff file: \`${own}\`\nWrite your machine handoff there before you hand back.`;
  writeFileSync(transcript, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: brief } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `Handoff file: ${path.join(dispatch, 'x-code-reviewer.json')}` }] } }),
  ].join('\n'));
  const stop = (active, agentType = 'aidrian:code-reviewer') => hook('hook-subagent-stop.mjs', {
    cwd: dir, agent_id: 'a6', agent_type: agentType, agent_transcript_path: transcript, last_assistant_message: '', stop_hook_active: active,
  });
  const sent = await stop(false);
  assert.equal(sent.status, 2);
  assert.ok(sent.stderr.startsWith(`Your brief asks you to write your machine handoff to \`${own}\`, which does not exist.`), sent.stderr);
  assert.ok(!sent.stderr.includes(other), 'a handoff named for another agent is not asked of this one');
  assert.doesNotMatch(sent.stderr, /x-code-reviewer/u, 'only the brief, the first prompt, is read');
  assert.equal((await stop(true)).status, 0, 'the second stop always ends');
  assert.equal((await stop(false, 'aidrian:critic')).status, 0, 'an agent the brief names no handoff for is not sent back');
  mkdirSync(dispatch, { recursive: true });
  writeFileSync(own, '{}');
  assert.equal((await stop(false)).status, 0, 'once the file exists, the stop ends');
  assert.deepEqual(log().map((row) => [row.agent_type, row.delivered, row.sent_back]), [
    ['aidrian:code-reviewer', 'missing', true], ['aidrian:code-reviewer', 'missing', false], ['aidrian:critic', 'chat', false], ['aidrian:code-reviewer', 'chat', false],
  ]);
});

// A brief named a handoff file for an agent with no file tool or shell, or made it optional, and the agent returned its
// handoff as its report: the hook writes that report to the file, and never sends the agent back for it.
test('the stop hook writes a subagent\'s final report to the handoff file its brief asked for, instead of sending it back', async (t) => {
  const { base, dir, state, log, hook } = project(t);
  const dispatch = path.join(state(), 'dispatch');
  const transcriptFor = (id, file, lines = []) => {
    const transcript = path.join(base, `agent-${id}.jsonl`);
    writeFileSync(transcript, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: `Rule on the copy.\nHandoff file: ${file}\nTry to also write it there; if you cannot, the final message is enough.` } }),
      ...lines.map((line) => JSON.stringify(line)),
    ].join('\n'));
    return transcript;
  };
  const stop = (id, transcript, message, extra = {}) => hook('hook-subagent-stop.mjs', {
    cwd: dir, agent_id: id, agent_type: 'aidrian:product-manager', agent_transcript_path: transcript, last_assistant_message: message, stop_hook_active: false, ...extra,
  });
  const read = (file) => JSON.parse(readFileSync(file, 'utf8'));

  // A machine handoff as the last message, in a fenced block, and presented as the handoff: written as the object it is.
  const json = path.join(dispatch, 'docs-S1-product-manager.json');
  const handoff = { status: 'done', role: 'product-manager', decision: 'One rewrite drops a rule.' };
  const fenced = await stop('p1', transcriptFor('p1', json), `\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\``);
  assert.deepEqual([fenced.status, fenced.stderr], [0, '']);
  assert.deepEqual(read(json), handoff);

  // A report in prose, with a delivery line naming the file it never wrote: written as text, and not sent back for either.
  const prose = path.join(dispatch, 'docs-S2-product-manager.json');
  const said = await stop('p2', transcriptFor('p2', prose), `Verdict: not verified.\nHandoff: ${prose}`);
  assert.deepEqual([said.status, said.stderr], [0, '']);
  assert.deepEqual(read(prose), { written_by: 'stop-hook', report: `Verdict: not verified.\nHandoff: ${prose}` });

  // The report delivered through the handback tool, whose run ends with no text after it: the handback's message.
  const handedBack = path.join(dispatch, 'docs-S3-product-manager.json');
  const handback = transcriptFor('p3', handedBack, [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Reading the docs first.' }] } },
    { type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 't1', name: 'SubagentHandback', input: { message: '{"status":"done","role":"product-manager"}' } }] } },
  ]);
  assert.equal((await stop('p3', handback, 'Reading the docs first.')).status, 0);
  assert.deepEqual(read(handedBack), { status: 'done', role: 'product-manager' });

  // A file that appeared before the hook wrote, as one its dispatcher wrote, is kept as it is.
  const kept = path.join(dispatch, 'docs-S4-product-manager.json');
  writeFileSync(kept, '{"by":"dispatcher"}');
  assert.equal((await stop('p4', transcriptFor('p4', kept), 'Done.')).status, 0);
  assert.deepEqual(read(kept), { by: 'dispatcher' });

  // While a background task of its own still runs, the stop is no end of its work: nothing is written, and only the
  // background check sends it back. The handoff is not due yet, so the row does not call it missing.
  const waiting = path.join(dispatch, 'docs-S5-product-manager.json');
  const busy = transcriptFor('p5', waiting, [
    { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { subagent_type: 'Explore', prompt: 'x' } }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'launched' }] }, toolUseResult: { status: 'async_launched', agentId: 'achild001' } },
  ]);
  const held = await stop('p5', busy, 'Waiting for the helper-scout result.', { background_tasks: [{ id: 'achild001', type: 'local_agent', status: 'running' }] });
  assert.equal(held.status, 2);
  assert.match(held.stderr, /^You started background work that is still running/u);
  assert.doesNotMatch(held.stderr, /Your brief asks you to write your machine handoff to/u, 'a handoff not due yet is no send-back reason');
  assert.throws(() => readFileSync(waiting), /ENOENT/u);
  // The task done, the next stop ends and writes the handoff.
  assert.equal((await stop('p5', busy, 'The helper found nothing.', { stop_hook_active: true, background_tasks: [] })).status, 0);
  assert.deepEqual(read(waiting), { written_by: 'stop-hook', report: 'The helper found nothing.' });

  assert.deepEqual(log().map((row) => [row.agent_id, row.delivered, row.running, row.handoffs_written, row.sent_back]), [
    ['p1', 'chat', 0, 1, false], ['p2', 'file', 0, 1, false], ['p3', 'chat', 0, 1, false], ['p4', 'chat', 0, 0, false],
    ['p5', 'pending', 1, 0, true], ['p5', 'chat', 0, 1, false],
  ]);
});

// A stop sent back for another missing file has a report the agent will correct: the hook writes the handoff only on the
// stop it lets end, so the file holds the corrected report, not the one sent back.
test('the stop hook writes the handoff from the report of the stop it lets end, not one it sent back', async (t) => {
  const { base, dir, state, log, hook } = project(t);
  const file = path.join(state(), 'dispatch', 'docs-S1-product-manager.json');
  const transcript = path.join(base, 'agent-p6.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: `Rule on the copy.\nHandoff file: ${file}` } }));
  const stop = (message, active) => hook('hook-subagent-stop.mjs', {
    cwd: dir, agent_id: 'p6', agent_type: 'aidrian:product-manager', agent_transcript_path: transcript, last_assistant_message: message, stop_hook_active: active,
  });
  const sent = await stop('Wrote docs/missing-result.md. No findings.', false);
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^Your report names `docs\/missing-result\.md`, which does not exist\./u);
  assert.doesNotMatch(sent.stderr, /Your brief asks you to write your machine handoff/u, 'the hook writes the handoff once the stop ends');
  assert.throws(() => readFileSync(file), /ENOENT/u, 'nothing is written from a report sent back');
  const corrected = 'No findings. The result doc was never needed.';
  assert.equal((await stop(corrected, true)).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { written_by: 'stop-hook', report: corrected });
  assert.deepEqual(log().map((row) => [row.handoffs_written, row.sent_back]), [[0, true], [1, false]]);
});

// A handoff file counts only when this run wrote it: a regular file changed at or after the subagent's transcript began.
// One an earlier dispatch of the same name left, a link, or a folder is stale: the stop hook replaces it with the report,
// through a new file renamed over it, so a link is never followed. A transcript with no timestamp keeps the old test.
test('the stop hook replaces a stale handoff file, a link, but keeps one this run wrote, byte for byte', async (t) => {
  const { base, dir, state, hook } = project(t);
  const dispatch = path.join(state(), 'dispatch');
  mkdirSync(dispatch, { recursive: true });
  const transcriptFor = (id, file, timestamp) => {
    const transcript = path.join(base, `agent-${id}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: 'user', ...(timestamp ? { timestamp } : {}), message: { role: 'user', content: `Handoff file: ${file}` } }));
    return transcript;
  };
  const stop = (id, transcript) => hook('hook-subagent-stop.mjs', {
    cwd: dir, agent_id: id, agent_type: 'aidrian:product-manager', agent_transcript_path: transcript, last_assistant_message: '{"status":"done","role":"product-manager"}', stop_hook_active: false,
  });
  const report = { status: 'done', role: 'product-manager' };

  // Left by an earlier dispatch, before this run began: replaced.
  const older = path.join(dispatch, 'docs-S1-product-manager.json');
  writeFileSync(older, '{"status":"done","role":"earlier"}');
  await sleep(30);
  assert.equal((await stop('s1', transcriptFor('s1', older, new Date().toISOString()))).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(older, 'utf8')), report);

  // Written by this run, after its transcript began: kept as it is.
  const newer = path.join(dispatch, 'docs-S2-product-manager.json');
  const began = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(newer, '{ "by": "the agent itself" }');
  assert.equal((await stop('s2', transcriptFor('s2', newer, began))).status, 0);
  assert.equal(readFileSync(newer, 'utf8'), '{ "by": "the agent itself" }');

  // A link, even a fresh one, is no handoff: the link is replaced, and the file it named is untouched.
  const target = path.join(base, 'elsewhere.json');
  writeFileSync(target, '{"keep":true}');
  const linked = path.join(dispatch, 'docs-S3-product-manager.json');
  symlinkSync(target, linked);
  assert.equal((await stop('s3', transcriptFor('s3', linked, began))).status, 0);
  assert.equal(lstatSync(linked).isFile(), true, 'a regular file now');
  assert.deepEqual(JSON.parse(readFileSync(linked, 'utf8')), report);
  assert.equal(readFileSync(target, 'utf8'), '{"keep":true}');

  // No timestamp in the transcript: a file that is there counts, as before.
  const plain = path.join(dispatch, 'docs-S4-product-manager.json');
  writeFileSync(plain, '{"by":"dispatcher"}');
  await sleep(30);
  assert.equal((await stop('s4', transcriptFor('s4', plain, null))).status, 0);
  assert.equal(readFileSync(plain, 'utf8'), '{"by":"dispatcher"}');
  assert.deepEqual(readdirSync(dispatch).filter((name) => name.endsWith('.tmp')), [], 'no temporary file left');
});

// Runs of one role on one branch, each briefed with its own file on a `Handoff file:` line: a later brief names the earlier
// runs' files to read. Only the marked file is the run's to write, whether the files to read are there or not, and a
// retried run's stale file of the same name is replaced. A brief with no marker that names several such files owes none.
test('the stop hook writes only the handoff file its own run was briefed with, never an earlier run\'s of the same role', async (t) => {
  const { base, dir, state, log, hook } = project(t);
  const dispatch = path.join(state(), 'dispatch');
  const file = (step) => path.join(dispatch, `ada-feat-12-${step}-product-manager.json`);
  const [gate, decide, signoff] = ['gate', 'decide', 'signoff'].map(file);
  const run = (id, brief, decision) => {
    const transcript = path.join(base, `agent-${id}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: brief } }));
    return hook('hook-subagent-stop.mjs', {
      cwd: dir, agent_id: id, agent_type: 'aidrian:product-manager', agent_transcript_path: transcript, last_assistant_message: JSON.stringify({ status: 'done', decision }), stop_hook_active: false,
    });
  };
  const read = (target) => JSON.parse(readFileSync(target, 'utf8')).decision;
  const signoffBrief = `Sign off. Read the gate at ${gate} and the decision at ${decide}.\nHandoff file: ${signoff}`;

  // The gate's input is not there yet: the sign-off is still written only under its own name.
  assert.equal((await run('s0', signoffBrief, 'early signoff')).status, 0);
  assert.equal(read(signoff), 'early signoff');
  assert.throws(() => readFileSync(gate), /ENOENT/u, 'a missing file to read is never written');

  assert.equal((await run('g1', `Gate the plan.\nHandoff file: ${gate}`, 'gate')).status, 0);
  assert.equal((await run('d1', `Read the gate at ${gate}.\n- Handoff file: \`${decide}\``, 'decide')).status, 0);
  await sleep(30);
  // A retried sign-off of the same name: its stale file is replaced, and the files it reads are kept.
  assert.equal((await run('s1', signoffBrief, 'signoff')).status, 0);
  assert.deepEqual([read(gate), read(decide), read(signoff)], ['gate', 'decide', 'signoff']);

  // No marker: the brief owes no file, even the one it says to write.
  const wording = file('wording');
  assert.equal((await run('w1', `Write your machine handoff to ${wording}.`, 'wording')).status, 0);
  assert.throws(() => readFileSync(wording), /ENOENT/u);
  assert.deepEqual(log().map((row) => [row.agent_id, row.handoffs_written]), [['s0', 1], ['g1', 1], ['d1', 1], ['s1', 1], ['w1', 0]]);

  // One path per marker line, its first token: prose after it that names a second file of the role is never read.
  // The three spellings count, in any case, with or without a list marker, and with CRLF line ends.
  const input = file('copy-input');
  const forms = [
    ['m1', (out) => `Handoff file: ${out} (after you read ${input})`],
    ['m2', (out) => `- **Handoff file:** \`${out}\`, then read ${input}.`],
    ['m3', (out) => `* **Handoff file**: ${out}. Inputs: ${input}`],
    ['m4', (out) => `handoff file: ${out}\nRead ${input}.`],
    ['m8', (out) => `Output: one JSON object. Under 4 KB. Handoff file: ${out} (return the JSON; the main session saves it).`],
  ];
  for (const [id, line] of forms) {
    for (const [end, suffix] of [['\n', ''], ['\r\n', '-crlf']]) {
      const out = file(`copy-${id}${suffix}`);
      const brief = `Rule on the copy.\n${line(out)}\n`.replaceAll('\n', end);
      assert.equal((await run(`${id}${suffix}`, brief, id)).status, 0, `${id}${suffix}`);
      assert.equal(read(out), id, `${id}${suffix}`);
    }
  }
  assert.throws(() => readFileSync(input), /ENOENT/u, 'a path in the prose after the marker is never written');
  // A marker inside a sentence names a file to read: an earlier run's file of the role is kept.
  await sleep(30);
  assert.equal((await run('m9', `Rule again. Read the earlier handoff file: ${gate} first.`, 'm9')).status, 0);
  assert.equal(read(gate), 'gate', 'a mid-sentence marker owes no file');
  // A marker the hook cannot fill is a brief's mistake: the agent is sent back once to say so, and nothing is written.
  const relative = file('copy-relative');
  const m5 = await run('m5', `Handoff file: x${relative}`, 'm5');
  assert.equal(m5.status, 2);
  assert.ok(m5.stderr.includes(`marker \`x${relative}\` is not an absolute \`.json\` path in \`${dispatch}/\``), m5.stderr);
  assert.throws(() => readFileSync(relative), /ENOENT/u, 'a marked path must be absolute, in the dispatch folder');
  // A marker with no valid path still marks the brief: the one file of the role its prose names is an input, kept.
  await sleep(30);
  for (const [id, brief] of [['m6', `Handoff file:\nRead the gate at ${gate}.`], ['m6-crlf', `Handoff file:\r\nRead the gate at ${gate}.\r\n`]]) {
    const sent = await run(id, brief, 'm6');
    assert.equal(sent.status, 2, id);
    assert.match(sent.stderr, /marker names no path, so this hook cannot write your handoff there/u, id);
  }
  assert.equal(read(gate), 'gate');
  // A backticked value is one path: a `.json` inside it does not end it early.
  const short = file('copy-short');
  assert.equal((await run('m7', `Handoff file: \`${short} copy.json\``, 'm7')).status, 0);
  assert.throws(() => readFileSync(short), /ENOENT/u, 'the shorter file is never written');
});

// An orchestrator's brief, as a background continuation sends it: the marker mid-line after other instructions, or on
// its own line. Each briefed file exists once the agent stops, written by the hook from its report. A brief whose
// marker the hook cannot fill, such as one with `<state>` left unexpanded, sends the agent back once, with the reason, and
// its second stop ends; a marker whose relative path the agent wrote is no mistake.
test('the stop hook fills every briefed handoff file of an orchestrator\'s briefs, and reports a marker it cannot fill', async (t) => {
  const { base, dir, state, hook } = project(t);
  const dispatch = path.join(state(), 'dispatch');
  const stop = (id, brief, active = false) => {
    const transcript = path.join(base, `agent-${id}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: brief } }));
    return hook('hook-subagent-stop.mjs', {
      cwd: dir, agent_id: id, agent_type: 'aidrian:backend-developer', agent_transcript_path: transcript, last_assistant_message: JSON.stringify({ status: 'done', decision: id }), stop_hook_active: active,
    });
  };
  for (const [id, line] of [
    ['own-line', (out) => `Implement slice S2 in the worktree.\nHandoff file: ${out}\nThen send a short summary.`],
    ['mid-line', (out) => `Output: one JSON object as final message. Under 4 KB. Handoff file: ${out} (return the JSON; the main session saves it).`],
  ]) {
    const out = path.join(dispatch, `feat-eng-7-sync-S2-${id}-backend-developer.json`);
    assert.equal((await stop(id, line(out))).status, 0, id);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).decision, id, id);
  }
  const placeholder = '<state>/dispatch/feat-eng-7-sync-S3-backend-developer.json';
  const sent = await stop('placeholder', `Implement slice S3.\nHandoff file: ${placeholder}`);
  assert.equal(sent.status, 2);
  assert.ok(sent.stderr.startsWith(`Your brief's \`Handoff file:\` marker \`${placeholder}\` is not an absolute`), sent.stderr);
  assert.match(sent.stderr, /Write no file at that path, which may lie outside the dispatch folder: end your turn with the machine handoff as your last message, and say in it that the brief's handoff path was rejected and why/u);
  assert.doesNotMatch(sent.stderr, /Write your machine handoff to that path/u, 'the brief`s path is never the hook`s write instruction');
  assert.equal((await stop('placeholder', `Implement slice S3.\nHandoff file: ${placeholder}`, true)).status, 0, 'the second stop ends');
  // A relative path an earlier run left is still a mistake to report; one this run wrote is not.
  const relative = path.join(dir, 'handoff-backend-developer.json');
  writeFileSync(relative, '{}');
  await sleep(30);
  assert.equal((await stop('stale', 'Implement slice S4.\nHandoff file: handoff-backend-developer.json')).status, 2, 'an earlier run`s file');
  const transcript = path.join(base, 'agent-fresh.jsonl');
  writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date(Date.now() - 1000).toISOString(), message: { role: 'user', content: 'Implement slice S4.\nHandoff file: handoff-backend-developer.json' } }));
  writeFileSync(relative, '{"fresh":true}');
  const fresh = await hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'fresh', agent_type: 'aidrian:backend-developer', agent_transcript_path: transcript, last_assistant_message: 'done', stop_hook_active: false });
  assert.equal(fresh.status, 0, 'a file the agent wrote in this run is no mistake');
});

// A state folder whose path holds a space: a backticked marker path is read whole, and the run's file is written.
test('the stop hook writes a marked handoff file in a state folder whose path holds a space', async (t) => {
  const { base, dir, state, hook } = project(t, { stateHome: 'state home' });
  const dispatch = path.join(state(), 'dispatch');
  assert.match(dispatch, / /u);
  const gate = path.join(dispatch, 'ada-feat-12-gate-product-manager.json');
  const signoff = path.join(dispatch, 'ada-feat-12-signoff-product-manager.json');
  const transcript = path.join(base, 'agent-sp1.jsonl');
  const brief = `Sign off. Read the gate at \`${gate}\`.\n- **Handoff file:** \`${signoff}\``;
  writeFileSync(transcript, JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: brief } }));
  const stopped = await hook('hook-subagent-stop.mjs', {
    cwd: dir, agent_id: 'sp1', agent_type: 'aidrian:product-manager', agent_transcript_path: transcript, last_assistant_message: '{"decision":"signoff"}', stop_hook_active: false,
  });
  assert.equal(stopped.status, 0);
  assert.deepEqual(JSON.parse(readFileSync(signoff, 'utf8')), { decision: 'signoff' });
  assert.throws(() => readFileSync(gate), /ENOENT/u);
});

test('claimedPaths leaves out a path shortened with an ellipsis: its full form cannot be checked', () => {
  const message = 'Wrote .../review/b-verdicts-r34-cr.json, …/dispatch/x-harness-mechanic.json, and ../docs/real.md.';
  assert.deepEqual(claimedPaths(message), ['../docs/real.md']);
});

test('a stop row counts the background tasks the subagent started that still run, and records the send-back they caused', async (t) => {
  const { base, dir, log, hook } = project(t);
  const transcript = path.join(base, 'agent-a4.jsonl');
  writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 600', run_in_background: true } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Command running in background with ID: bsleep001.' }] }, toolUseResult: { stdout: '', stderr: '', backgroundTaskId: 'bsleep001' } }),
  ].join('\n'));
  const tasks = [{ id: 'bsleep001', type: 'shell', status: 'running', command: 'sleep 600' }, { id: 'bother002', type: 'shell', status: 'running' }];
  const stop = (active, background) => hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a4', agent_type: 'fixer', agent_transcript_path: transcript, last_assistant_message: 'Done.', stop_hook_active: active, background_tasks: background });
  const sends = [];
  for (let i = 0; i < 5; i += 1) sends.push((await stop(i > 0, tasks)).status);
  assert.deepEqual([...sends, (await stop(true, tasks)).status, (await stop(false, tasks.slice(1))).status], [2, 2, 2, 2, 2, 0, 0]);
  assert.deepEqual(log().map((row) => [row.delivered, row.running, row.sent_back]), [
    ...Array(5).fill(['chat', 1, true]), ['chat', 1, false], ['chat', 0, false],
  ], 'the stop the cap let end is the one with running above 0 and sent_back false');
});

// Sets config.json `telemetry` in a project from project().
const setTelemetry = (dir, telemetry) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, telemetry }));

test('telemetry.enabled false: the hooks write no rows, and the delivery check still sends a subagent back', async (t) => {
  const { base, dir, log, hook } = project(t);
  setTelemetry(dir, { enabled: false });
  const transcript = path.join(base, 's1.jsonl');
  writeFileSync(transcript, usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }));
  assert.equal((await hook('hook-agent-post.mjs', { session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: {}, tool_response: { agentId: 'a1' } })).status, 0);
  const sent = await hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a1', last_assistant_message: 'Wrote out/handoff.json.', stop_hook_active: false });
  assert.deepEqual([sent.status, sent.stderr.startsWith('Your report names `out/handoff.json`')], [2, true]);
  assert.equal((await hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript })).status, 0);
  assert.equal((await hook('session-row.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript })).status, 0, 'the worker checks too');
  assert.deepEqual(log(), []);
});

// A subagent that reads its docs with a shell command, as most implementers and designers do, has them on its stop row:
// through a variable, from a folder a `cd` moved to, or relative to one the row cannot know.
test('a stop row counts the knowledge docs a subagent printed with cat, sed, or head', async (t) => {
  const { base, dir, logged, hook } = project(t);
  const agent = path.join(base, 'agent-sh.jsonl');
  const bash = (id, command) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  writeFileSync(agent, [
    bash('b1', `W=${base}/wt; cat $W/docs/knowledge/engineering/testing.md`),
    bash('b2', `cd ${dir} && sed -n 1,40p docs/knowledge/product/product-rules.md`),
    bash('b3', 'cd "$W"; head -20 docs/knowledge/product/sharing.md; grep -n x docs/knowledge/product/other.md'),
  ].join('\n'));
  assert.equal((await hook('hook-subagent-stop.mjs', { session_id: 's1', cwd: dir, agent_id: 'sh', agent_type: 'aidrian:designer', agent_transcript_path: agent, last_assistant_message: 'Done.', stop_hook_active: false })).status, 0);
  const [row] = await logged(1);
  assert.deepEqual(row.docs_read.map((doc) => doc.path).sort(), ['docs/knowledge/engineering/testing.md', 'docs/knowledge/product/product-rules.md', 'docs/knowledge/product/sharing.md']);
});

test('telemetry.docReads false: stop and session rows record docs_read null, and the rest as before', async (t) => {
  const { base, dir, hook, logged } = project(t);
  setTelemetry(dir, { docReads: false });
  const transcript = path.join(base, 's1.jsonl');
  const doc = path.join(dir, 'docs/knowledge/engineering/testing.md');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: doc } }] } }));
  await hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: transcript, last_assistant_message: 'Done.', stop_hook_active: false });
  await hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript });
  const rows = await logged(2);
  assert.deepEqual(rows.map((row) => [row.event, row.docs_read, row.tokens?.input ?? row.tokens_by_model['claude-opus-5-5'].input]), [['stop', null, 10], ['session', null, 10]]);
});

test('the session-end hook exits while its worker still reads the transcript, and the row lands once the worker finishes', { skip: process.platform === 'win32' }, async (t) => {
  const { base, dir, log, hookProcess, logged } = project(t);
  // A FIFO the test has not written yet: reading it blocks until the test writes, however fast the machine parses.
  // Before the worker, the hook read the transcript itself, so it could not exit before the test wrote it.
  const transcript = path.join(base, 's1.jsonl');
  assert.equal(spawnSync('mkfifo', [transcript]).status, 0);
  const ended = hookProcess('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript, reason: 'exit' }, { timeout: 10_000 });
  assert.deepEqual([ended.status, ended.signal], [0, null], 'the hook exited without waiting for the transcript');
  assert.deepEqual(log(), []);
  let fifo;
  for (const deadline = Date.now() + 15_000; fifo === undefined; await sleep(25)) {
    try {
      fifo = openSync(transcript, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code !== 'ENXIO' || Date.now() > deadline) throw error; // ENXIO: the worker has not opened it yet.
    }
  }
  writeSync(fifo, usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }));
  closeSync(fifo);
  const [row] = await logged(1);
  assert.deepEqual([row.event, row.session_id, row.reason, row.models], ['session', 's1', 'exit', ['claude-opus-5-5']]);
});

test('the session row is stamped with the time the session ended, which the hook hands its worker', (t) => {
  const { base, dir, log, hookProcess } = project(t);
  const transcript = path.join(base, 's1.jsonl');
  writeFileSync(transcript, usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }));
  assert.equal(hookProcess('session-row.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript, ended_at: NOW }).status, 0);
  assert.equal(log()[0].ts, new Date(NOW).toISOString());
});

test('a session that ended twice counts the row that ended last, even when it was appended first', () => {
  const session = (ts, cost) => ({ event: 'session', ts, session_id: 's1', models: ['claude-opus-5-5'], cost_usd: cost });
  const rows = [session('2026-10-29T11:00:00.000Z', 2), session('2026-10-29T10:00:00.000Z', 1), { ...session('2026-10-29T09:00:00.000Z', 5), session_id: 's2' }];
  assert.deepEqual(endedSessions(rows).map((row) => [row.session_id, row.cost_usd]), [['s1', 2], ['s2', 5]]);
  assert.deepEqual(endedSessions([session('x', 1), session('x', 2)]).map((row) => row.cost_usd), [2], 'unreadable times: the later append');
  assert.equal(summarize(rows).sessions.cost_usd, 7, 'the report sums the rows that ended last');
});

test('a log of telemetry.maxMb rotates into dispatch-log.1.jsonl, a rotate row says whether rows were lost, and reports read both', async (t) => {
  const { dir, env, state, log, hook } = project(t);
  setTelemetry(dir, { maxMb: 1 });
  const file = path.join(state(), 'dispatch-log.jsonl');
  const rotated = path.join(state(), 'dispatch-log.1.jsonl');
  const ts = new Date(Date.now() - 60_000).toISOString();
  const big = (id) => `${JSON.stringify({ event: 'dispatch', ts, session_id: 's', agent_id: id, agent_type: 'Explore', description: 'x'.repeat(1024 * 1024) })}\n`;
  const dispatch = (id) => hook('hook-agent-post.mjs', { session_id: 's', cwd: dir, tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_response: { agentId: id } });
  mkdirSync(state(), { recursive: true });
  writeFileSync(file, big('old'));
  await dispatch('a1');
  assert.equal(readFileSync(rotated, 'utf8'), big('old'));
  assert.deepEqual(log().map((row) => [row.event, row.dropped ?? row.agent_id]), [['rotate', false], ['dispatch', 'a1']]);
  await dispatch('a2');
  assert.equal(log().length, 3, 'under the limit: no rotation');
  writeFileSync(file, big('older'), { flag: 'a' });
  await dispatch('a3');
  assert.deepEqual(log().map((row) => [row.event, row.dropped ?? row.agent_id]), [['rotate', true], ['dispatch', 'a3']]);
  assert.deepEqual(lockFiles(file), ['dispatch-log.jsonl.lock.2', 'dispatch-log.jsonl.lock.2.released'], 'the lock is released');
  const json = JSON.parse(spawnSync(CLI, ['report', '--json'], { cwd: dir, env, encoding: 'utf8' }).stdout);
  assert.deepEqual(json.agents.map((agent) => [agent.agent_type, agent.dispatches]), [['Explore', 4]], 'a1, a2, and older from the rotated part; a3 from the log');

  // Another process holds the lock: append without rotating, and without waiting. Once that process is gone, the next
  // row takes the lock over and rotates.
  writeFileSync(file, big('busy'));
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)']);
  t.after(() => holder.kill());
  const lock = `${file}.lock.3`;
  writeFileSync(lock, `${JSON.stringify({ pid: holder.pid, host: hostname(), nonce: 'test' })}\n`);
  const started = Date.now();
  await dispatch('a4');
  assert.ok(Date.now() - started < 4000, 'the hook did not wait for the lock');
  assert.deepEqual(log().map((row) => row.agent_id), ['busy', 'a4']);
  holder.kill();
  await new Promise((resolve) => holder.on('exit', resolve));
  await dispatch('a5');
  assert.deepEqual(log().map((row) => row.event === 'rotate' || row.agent_id), [true, 'a5']);
  assert.deepEqual(lockFiles(file), ['dispatch-log.jsonl.lock.4', 'dispatch-log.jsonl.lock.4.released']);
});

test('processes that append to a full log at once rotate it once and lose no row', async (t) => {
  const { dir, env, state } = project(t);
  const file = path.join(state(), 'dispatch-log.jsonl');
  const rotated = path.join(state(), 'dispatch-log.1.jsonl');
  mkdirSync(state(), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ event: 'dispatch', ts: new Date().toISOString(), session_id: 's', agent_id: 'old', description: 'x'.repeat(1024 * 1024) })}\n`);
  const lib = (name) => JSON.stringify(pathToFileURL(path.join(ROOT, 'plugins/aidrian/lib', name)).href);
  const writer = (name) => {
    const code = `import { appendEvent } from ${lib('dispatch-log.mjs')};
import { DEFAULTS } from ${lib('config.mjs')};
import { findProject } from ${lib('project.mjs')};
const project = findProject(${JSON.stringify(dir)});
const config = { ...DEFAULTS, telemetry: { ...DEFAULTS.telemetry, maxMb: 1 } };
for (let i = 0; i < 50; i++) appendEvent(project, config, { event: 'dispatch', ts: new Date().toISOString(), session_id: 's', agent_id: '${name}-' + i });`;
    return new Promise((resolve, reject) => {
      spawn(process.execPath, ['--input-type=module', '-e', code], { env, stdio: 'inherit' })
        .on('error', reject)
        .on('exit', (status) => (status === 0 ? resolve() : reject(new Error(`writer exited ${status}`))));
    });
  };
  const names = ['a', 'b', 'c', 'd'];
  await Promise.all(names.map(writer));
  const rows = (at) => readFileSync(at, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const all = [...rows(rotated), ...rows(file)];
  assert.equal(all.filter((row) => row.event === 'rotate').length, 1, 'one process rotated');
  assert.equal(all.find((row) => row.event === 'rotate').dropped, false);
  assert.deepEqual(all.filter((row) => row.agent_id === 'old').length, 1);
  for (const name of names) assert.equal(all.filter((row) => row.agent_id?.startsWith(`${name}-`)).length, 50, name);
  assert.equal(lockFiles(file).filter((name) => !name.endsWith('.released')).length, 1, 'one generation of the lock is left, released');
  assert.ok(lockFiles(file).at(-1).endsWith('.released'));
});

test('every dispatch-log hook exits 0 silently on a payload it cannot read', async () => {
  for (const script of ['hook-agent-post.mjs', 'hook-subagent-stop.mjs', 'hook-session-end.mjs']) {
    // Real runs for the payloads only the script's own stdin read sees, which hands the hook {} for each
    // (lib/hook-io.mjs readHookInput); the JSON objects are called in this process.
    for (const input of ['', 'not json', '[]']) {
      const { status, stdout, stderr } = spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input, encoding: 'utf8', cwd: tmpdir() });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${script} ${input}`);
    }
    for (const input of ['{}', JSON.stringify({ cwd: 42, tool_name: 'Agent' })]) {
      const { status, stdout, stderr } = await hookCall(path.join(SCRIPTS, script), { input, cwd: tmpdir() });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${script} ${input}`);
    }
  }
});

test('summarize: per agent type dispatches, re-dispatch rate, medians, cost, delivery, runs, docs, tool calls; then sessions and hook denies', () => {
  // a1's rows predate sizes in docs_read, tool counts, and sent_back: bare paths count the same, and its run leaves the
  // averages and the share sent back they feed; its `missing` row leaves its send-back unknown. a2 was sent back once.
  const ts = '2026-10-29T11:00:00Z';
  const deny = (session, rule, agent, reason) => ({ event: 'hook_deny', ts, session_id: session, rule, tool: 'Bash', agent_type: agent, reason });
  const rows = [
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a1', agent_type: 'Explore', description: 'Find tests', duration_ms: 1000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a2', agent_type: 'Explore', description: 'Find tests', duration_ms: 3000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a3', agent_type: 'Explore', description: 'Map hooks', duration_ms: 2000 },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'missing', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'file', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a2', agent_type: 'Explore', delivered: 'missing', sent_back: true },
    {
      event: 'stop', ts, agent_id: 'a2', agent_type: 'Explore', tokens: { input: 3000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.25, delivered: 'chat', sent_back: false,
      docs_read: [{ path: 'a.md', bytes: 1024 }, { path: 'b.md', bytes: 2048 }], requests: 10, tool_requests: 4, tool_calls: 6,
    },
    { event: 'stop', ts, agent_id: 'zz', agent_type: 'planner', tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, cost_usd: 0, delivered: 'chat', docs_read: null, requests: 1, tool_requests: 0, tool_calls: 0 },
    { event: 'session', ts, session_id: 's', cost_usd: 4.5 },
    { event: 'session', ts: '2026-10-01T00:00:00Z', session_id: 'old', cost_usd: 100 },
    ...Array.from({ length: 3 }, () => deny('s', 'git-amend', 'main', '`git commit --amend` rewrites the branch tip')),
    deny('s2', 'git-amend', 'aidrian:explorer', '`git commit --amend` rewrites the branch tip'),
    deny('s2', 'agent-gates', 'aidrian:explorer', 'agents.explorer.deny has "Bash"'),
    deny('s2', 'agent-gates', 'aidrian:explorer', 'agents.explorer.allow does not list it'),
    { ...deny('old', 'process-kill', 'main', 'x'), ts: '2026-10-01T00:00:00Z' },
    { event: 'unknown', ts },
  ];
  const summary = summarize(rows, { sinceMs: parseSince('7d', NOW) });
  assert.deepEqual(summary.agents[0], {
    agent_type: 'Explore', dispatches: 3, redispatched: 1, redispatch_rate: 0.33, median_duration_ms: 2000, median_tokens: 2000, cost_usd: 0.75,
    delivered: { file: 1, chat: 1, missing: 0, pending: 0 }, top_docs: [['a.md', 2], ['b.md', 1]],
    runs: 2, cost_per_run_usd: 0.38, sent_back: 1, sent_back_rate: 1, runs_without_send_back: 1, avg_docs_read: 1.5, avg_doc_bytes: 3072,
    requests: 10, tool_requests: 4, tool_calls: 6, tool_calls_per_request: 1.5, runs_without_tool_counts: 1,
  });
  assert.deepEqual([summary.agents[1].dispatches, summary.agents[1].runs, summary.agents[1].avg_docs_read, summary.agents[1].tool_calls_per_request], [0, 1, null, null]);
  assert.deepEqual([summary.sessions, summary.unjoined_stops, summary.runs_without_tool_counts], [{ count: 1, cost_usd: 4.5 }, 1, 1]);
  assert.deepEqual(summary.hook_denies, {
    count: 6,
    sessions: 2,
    by_rule: [
      { rule: 'git-amend', count: 4, agents: [['main', 3], ['aidrian:explorer', 1]], repeated_runs: 1, reasons: [['`git commit --amend` rewrites the branch tip', 4]] },
      {
        rule: 'agent-gates', count: 2, agents: [['aidrian:explorer', 2]], repeated_runs: 0,
        reasons: [['agents.explorer.allow does not list it', 1], ['agents.explorer.deny has "Bash"', 1]],
      },
    ],
  }, 'the old row is out of the window');
  const text = formatReport(summary, { file: '/s/dispatch-log.jsonl', since: '7d', skipped: 2 });
  assert.equal(text, [
    'Dispatch log /s/dispatch-log.jsonl, since 7d (2 unreadable rows skipped)',
    'Partial: 1 agent runs were logged before tool counts; tool calls per request leave them out.',
    'Explore: 3 dispatches, 33% re-dispatched, median 2s and 2k tokens, $0.75, delivered 1 file / 1 chat / 0 missing',
    '  2 runs, $0.38 a run, 100% sent back by the delivery check, 1.50 tool calls per request that made one',
    '  docs read: 1.5 docs and 3.0 KB a run; a.md (2), b.md (1)',
    'planner: 0 dispatches, - re-dispatched, median - and 0k tokens, $0.00, delivered 0 file / 1 chat / 0 missing',
    '  1 runs, $0.00 a run, 0% sent back by the delivery check, - tool calls per request that made one',
    'Sessions: 1, $4.50 estimated, main conversation and subagents together',
    '1 stop rows have no dispatch row (a background dispatch, or a host change)',
    'Hook denies: 6 in 2 sessions',
    '  git-amend: 4, by main 3, aidrian:explorer 1; 1 agent run blocked 3 times or more for the same reason, an automatic lesson',
    '    most often: `git commit --amend` rewrites the branch tip',
    '  agent-gates: 2, by aidrian:explorer 2',
    '    most often: agents.explorer.allow does not list it',
  ].join('\n'));
  assert.match(formatReport(summarize([]), { file: 'f', since: '7d', skipped: 0 }), /\nNo rows yet\.$/);
  const onlyDenies = formatReport(summarize([deny('s', 'pr-body', 'main', 'the body has no `## Summary` section.')]), { file: 'f', since: '7d', skipped: 0 });
  assert.match(onlyDenies, /\nSessions: 0, .*\nHook denies: 1 in 1 session\n {2}pr-body: 1, by main 1\n/, 'denies alone are rows');
  assert.match(formatReport(summarize([rows[0]]), { file: 'f', since: '7d', skipped: 0 }), /\nHook denies: none$/);
});

test('parseSince takes a span or a date; aidrian report prints the log, --json the summary', (t) => {
  assert.equal(parseSince('24h', NOW), NOW - 86_400_000);
  assert.equal(parseSince('2026-10-01', NOW), Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(() => parseSince('soon'), /--since takes/);
  for (const date of ['2026-02-31', '2026-13-01', '2026-00-10']) assert.throws(() => parseSince(date), /--since takes/, date);
  const { dir, env } = project(t);
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.match(report([]).stdout, /^Dispatch log .*dispatch-log\.jsonl, since 7d\nNo rows yet\.\n$/);
  assert.deepEqual(Object.keys(JSON.parse(report(['--json']).stdout)), [
    'file', 'rotated', 'since', 'skipped', 'coverage', 'agents', 'sessions', 'unjoined_stops', 'runs_without_tool_counts', 'hook_denies',
  ]);
  assert.equal(report(['--since', 'soon']).status, 1);
  assert.deepEqual([report(['--prs', '0']).status, report(['reviews', '--prs', 'x']).stderr], [1, '--prs takes a whole number above 0\n']);
});

// Reads of the example consumer's docs: three subagents, one sent back once, a main conversation, a row from before sizes
// were logged, and an old row the default window leaves out.
const DOC = (name) => `docs/knowledge/${name}.md`;
const read = (name, bytes) => ({ path: DOC(name), bytes });
const DOC_ROWS = [
  { event: 'stop', ts: '2026-10-29T10:00:00Z', agent_id: 'a1', agent_type: 'Explore', docs_read: [read('engineering/working-agreement', 479)] },
  { event: 'stop', ts: '2026-10-29T10:05:00Z', agent_id: 'a1', agent_type: 'Explore', docs_read: [read('engineering/working-agreement', 479), read('engineering/testing', 323)] },
  { event: 'stop', ts: '2026-10-29T10:10:00Z', agent_id: 'a2', agent_type: 'planner', docs_read: [read('engineering/working-agreement', 479), read('engineering/branches-and-reviews', 401)] },
  { event: 'stop', ts: '2026-10-29T10:20:00Z', agent_id: 'a3', agent_type: 'code-reviewer', docs_read: [read('engineering/working-agreement', 479), read('engineering/testing', 323), read('engineering/code-style', 314)] },
  { event: 'stop', ts: '2026-10-29T10:25:00Z', agent_id: 'a4', agent_type: 'Explore', docs_read: [DOC('product/sharing')] },
  { event: 'session', ts: '2026-10-29T11:00:00Z', session_id: 's1', docs_read: [read('engineering/working-agreement', 479), read('product/product-rules', 241)] },
  { event: 'dispatch', ts: '2026-10-29T10:00:00Z', agent_id: 'a1', agent_type: 'Explore' },
  { event: 'stop', ts: '2026-10-01T00:00:00Z', agent_id: 'old', agent_type: 'planner', docs_read: [read('engineering/issue-tracker', 308)] },
];

test('summarizeDocs: per doc reads, size, reads × size, and readers; most bytes first, unknown sizes last', () => {
  const { docs, totals } = summarizeDocs(DOC_ROWS, { sinceMs: parseSince('7d', NOW) });
  assert.deepEqual(docs.map((doc) => [doc.path, doc.reads, doc.bytes, doc.read_bytes, doc.readers]), [
    [DOC('engineering/working-agreement'), 4, 479, 1916, ['Explore', 'code-reviewer', 'main', 'planner']],
    [DOC('engineering/testing'), 2, 323, 646, ['Explore', 'code-reviewer']],
    [DOC('engineering/branches-and-reviews'), 1, 401, 401, ['planner']],
    [DOC('engineering/code-style'), 1, 314, 314, ['code-reviewer']],
    [DOC('product/product-rules'), 1, 241, 241, ['main']],
    [DOC('product/sharing'), 1, null, null, ['Explore']],
  ]);
  assert.deepEqual(totals, { docs: 6, reads: 10, read_bytes: 3518, readers: ['Explore', 'code-reviewer', 'main', 'planner'], rows: 5 });

  const indexed = ['engineering/working-agreement', 'engineering/issue-tracker', 'product/sharing', 'product/notes'].map((name, i) => read(name, 100 * (i + 1)));
  const withIndex = summarizeDocs(DOC_ROWS, { sinceMs: parseSince('7d', NOW), indexed });
  assert.deepEqual(withIndex.never_read, [read('engineering/issue-tracker', 200), read('product/notes', 400)], 'in index order; the old row is out of the window');
  const always = { bytes: 479, budget: 16384, buckets: { engineering: 479, product: 0 } };
  const text = formatDocs(withIndex, { file: '/s/dispatch-log.jsonl', since: '7d', skipped: 0, notes: ['Partial: a note.'], always });
  assert.equal(text, [
    'Knowledge docs read, from /s/dispatch-log.jsonl, since 7d',
    'Partial: a note.',
    'Always docs: 479 of 16384 bytes, read by every session and subagent (engineering 479, product 0)',
    '10 reads of 6 docs, 3.4 KB in all, by 4 readers: Explore, code-reviewer, main, planner',
    'Most bytes read (reads × size), top 6:',
    `      4 ×    0.5 KB =    1.9 KB  ${DOC('engineering/working-agreement')}  (Explore, code-reviewer, main, planner)`,
    `      2 ×    0.3 KB =    0.6 KB  ${DOC('engineering/testing')}  (Explore, code-reviewer)`,
    `      1 ×    0.4 KB =    0.4 KB  ${DOC('engineering/branches-and-reviews')}  (planner)`,
    `      1 ×    0.3 KB =    0.3 KB  ${DOC('engineering/code-style')}  (code-reviewer)`,
    `      1 ×    0.2 KB =    0.2 KB  ${DOC('product/product-rules')}  (main)`,
    `      1 ×         ? =         ?  ${DOC('product/sharing')}  (Explore)`,
    'Read by the most readers:',
    `  4 of 4  ${DOC('engineering/working-agreement')}`,
    `  2 of 4  ${DOC('engineering/testing')}`,
    'Indexed docs never read since 7d, 2:',
    `     0.2 KB  ${DOC('engineering/issue-tracker')}`,
    `     0.4 KB  ${DOC('product/notes')}`,
  ].join('\n'));
  assert.match(formatDocs(summarizeDocs([]), { file: 'f', since: '7d', skipped: 1 }), /^Knowledge docs read, from f, since 7d \(1 unreadable rows skipped\)\nNo knowledge doc reads yet\.$/);
  const over = formatDocs(summarizeDocs([], { indexed }), { file: 'f', since: '7d', skipped: 0, always: { bytes: 20000, budget: 16384, buckets: {} } });
  assert.equal(over, 'Knowledge docs read, from f, since 7d\nAlways docs: 20000 of 16384 bytes, over knowledge.budgets.alwaysBytes, read by every session and subagent\nNo knowledge doc reads yet.', 'no rows: no doc is called unread');
  const many = Array.from({ length: 23 }, (_, i) => read(`n${i}`, 10));
  const none = formatDocs(summarizeDocs([{ event: 'stop', ts: '2026-10-29T10:00:00Z', agent_id: 'a', docs_read: [] }], { indexed: many }), { file: 'f', since: '7d', skipped: 0 });
  assert.match(none, /^Knowledge docs read, from f, since 7d\n1 agent and session rows recorded doc reads, and none read a knowledge doc\.\nIndexed docs never read since 7d, 23:\n/);
  assert.match(none, /n19\.md\n {2}and 3 more; --json lists them all$/);
});

test('aidrian report docs prints the doc view, --json all of it; a stray word or --prs is an error', (t) => {
  const { dir, env, state } = project(t);
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  const always = 'Always docs: 479 of 16384 bytes, read by every session and subagent (engineering 479, product 0)';
  assert.equal(report(['docs']).stdout.split('\n').slice(1).join('\n'), `${always}\nNo knowledge doc reads yet.\n`);
  mkdirSync(state(), { recursive: true });
  const recent = DOC_ROWS.map((row) => ({ ...row, ts: new Date(Date.now() - 3_600_000).toISOString() }));
  writeFileSync(path.join(state(), 'dispatch-log.jsonl'), `${recent.map((row) => JSON.stringify(row)).join('\n')}\nnot json\n`);
  const text = report(['docs', '--since', '1d']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /since 1d \(1 unreadable rows skipped\)\nAlways docs: 479 of 16384 bytes, .*\n11 reads of 7 docs, .* by 4 readers/);
  assert.match(text.stdout, /\nIndexed docs never read since 1d, 1:\n {5}0\.\d KB {2}docs\/knowledge\/engineering\/docs-ownership\.md\n$/);
  const json = JSON.parse(report(['docs', '--json']).stdout);
  assert.deepEqual(Object.keys(json), ['file', 'rotated', 'since', 'skipped', 'coverage', 'always', 'docs', 'totals', 'never_read']);
  assert.deepEqual(json.always, { bytes: 479, budget: 16384, buckets: { engineering: 479, product: 0 } });
  assert.deepEqual(json.docs[0], { path: DOC('engineering/working-agreement'), reads: 4, bytes: 479, read_bytes: 1916, readers: ['Explore', 'code-reviewer', 'main', 'planner'] });
  assert.deepEqual([report(['nope']).status, report(['nope']).stderr], [1, 'unknown report: nope; use aidrian report, or aidrian report docs, sessions, reviews, findings, health\n']);
  assert.deepEqual([report(['docs', 'more']).status, report(['docs', '--prs', '1']).status], [1, 1]);
});

test('coverage: telemetry off, doc reads off, rows written without doc reads or send-backs, and rows rotated out before the window', () => {
  const sinceMs = parseSince('7d', NOW);
  const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
  const rows = [
    { event: 'rotate', ts: day(3), dropped: true },
    { event: 'stop', ts: day(3), agent_id: 'a1', docs_read: null },
    { event: 'stop', ts: day(2), agent_id: 'a1', docs_read: [] },
    { event: 'stop', ts: day(2), agent_id: 'a2', docs_read: null, delivered: 'missing' },
    { event: 'session', ts: day(1), session_id: 's', docs_read: null },
    { event: 'session', ts: day(9), session_id: 'old', docs_read: null },
    { event: 'stop', ts: day(2), agent_id: 'a3', docs_read: [], delivered: 'missing', sent_back: false },
  ];
  const off = { telemetry: { ...DEFAULTS.telemetry, enabled: false } };
  const cover = coverage(rows, off, { sinceMs });
  assert.deepEqual(
    cover,
    { enabled: false, doc_reads: true, hook_denies: true, rows_without_doc_reads: 2, runs_without_send_back: 1, rotated_out_before: null },
    'a1 counts its last row; a2 named a missing file before sent_back, a3 after; the old row is out of the window, and older than it',
  );
  assert.equal(coverage(rows.slice(0, 5), DEFAULTS, { sinceMs }).rotated_out_before, day(3));
  assert.equal(coverage(rows.slice(1, 5), DEFAULTS, { sinceMs }).rotated_out_before, null, 'no rotate row that dropped rows: nothing is lost');
  assert.deepEqual(coverageLines(coverage(rows.slice(0, 5), { telemetry: { ...DEFAULTS.telemetry, docReads: false } }, { sinceMs })), [
    'Doc reads are off (telemetry.docReads is false): new rows do not record them.',
    'Partial: 2 agent and session rows in the window were written with doc reads off.',
    `Partial: the log starts at ${day(3)}; older rows were rotated out at telemetry.maxMb.`,
  ]);
  assert.deepEqual(coverageLines(cover, { docReads: false, hookDenies: true }), ['Telemetry is off (telemetry.enabled is false): the hooks write no rows, so this shows only older ones.']);
  assert.deepEqual(coverageLines(cover, { docReads: false, sendBacks: true }), [
    'Telemetry is off (telemetry.enabled is false): the hooks write no rows, so this shows only older ones.',
    'Partial: 1 agent runs named a missing file before stop rows recorded send-backs; the share sent back leaves them out.',
  ], 'only the view that shows send-backs says some are unknown');
  assert.deepEqual(coverageLines(coverage([], DEFAULTS)), []);
  const noDenies = coverage([], { telemetry: { ...DEFAULTS.telemetry, hookDenies: false } });
  assert.deepEqual([coverageLines(noDenies), coverageLines(noDenies, { hookDenies: true })], [
    [], ['Hook denies are off (telemetry.hookDenies is false): the hooks still block, and log no hook_deny rows.'],
  ], 'only the view that shows hook denies says they are off');
});

test('aidrian report and report docs say when telemetry is off, and --json carries the coverage', (t) => {
  const { dir, env } = project(t);
  setTelemetry(dir, { enabled: false });
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.match(report([]).stdout, /^Dispatch log .*, since 7d\nTelemetry is off \(telemetry\.enabled is false\): .*\nNo rows yet\.\n$/);
  assert.match(report(['docs']).stdout, /^Knowledge docs read, .*\nTelemetry is off .*\nAlways docs: .*\nNo knowledge doc reads yet\.\n$/);
  assert.deepEqual(JSON.parse(report(['--json']).stdout).coverage, {
    enabled: false, doc_reads: true, hook_denies: true, rows_without_doc_reads: 0, runs_without_send_back: 0, rotated_out_before: null,
  });
});

test('sessionRow splits main and subagents, with effort, cost per model, cache writes, and tool calls', (t) => {
  const { base, dir } = project(t);
  const line = (id, model, usage, { effort = 'high', tools = 0 } = {}) => JSON.stringify({
    type: 'assistant', effort, timestamp: '2026-10-29T10:00:00Z',
    message: { id, model, usage, content: Array.from({ length: tools }, (_, i) => ({ type: 'tool_use', id: `${id}-t${i}`, name: 'Bash', input: {} })) },
  });
  const main = path.join(base, 's1.jsonl');
  writeFileSync(main, [
    line('m1', 'claude-opus-5-5', { input_tokens: 1_000_000, cache_creation: { ephemeral_1h_input_tokens: 1_000_000 } }, { tools: 3 }),
    line('m2', 'claude-opus-5-5', { output_tokens: 1000 }, { effort: 'medium' }),
  ].join('\n'));
  mkdirSync(path.join(base, 's1/subagents'), { recursive: true });
  writeFileSync(path.join(base, 's1/subagents/agent-a.jsonl'), [
    line('m2', 'claude-opus-5-5', { output_tokens: 1000 }, { effort: 'low' }),
    line('a1', 'claude-sonnet-5-5', { input_tokens: 1_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000 } }, { effort: 'low', tools: 1 }),
  ].join('\n'));
  const row = sessionRow({ session_id: 's1', transcript_path: main }, findProject(dir), { env: {}, now: NOW });
  assert.deepEqual([row.effort, row.effort_varied], ['medium', true], 'the main conversation`s levels only');
  // Opus: 4 input + 8 for 1-hour writes + 0.02 output. Sonnet: 2 input + 2.5 for 5-minute writes.
  assert.deepEqual(row.cost_by_model, { 'claude-opus-5-5': 12.02, 'claude-sonnet-5-5': 4.5 });
  assert.deepEqual(row.main, {
    tokens: { input: 1_000_000, output: 1000, cache_read: 0, cache_write: 1_000_000, cache_write_5m: 0, cache_write_1h: 1_000_000 },
    cost_usd: 12.02, requests: 2, tool_requests: 1, tool_calls: 3,
  }, 'm2, repeated in the subagent transcript, stays the main conversation`s');
  assert.deepEqual(row.subagents, {
    tokens: { input: 1_000_000, output: 0, cache_read: 0, cache_write: 1_000_000, cache_write_5m: 1_000_000, cache_write_1h: 0 },
    cost_usd: 4.5, requests: 1, tool_requests: 1, tool_calls: 1,
  });
  assert.equal(row.cost_usd, 16.52);
  assert.deepEqual([row.skills, row.drafts_opened, row.review_runs], [[], 0, 0], 'no skill, draft, or review call');
});

test('sessionRow records the skills, draft pull requests, and review runs of the main conversation and its subagents', async (t) => {
  const { base, dir } = project(t);
  const call = (id, name, input) => JSON.stringify({
    type: 'assistant', timestamp: '2026-10-29T10:00:00Z',
    message: { id: `m-${id}`, model: 'claude-opus-5-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] },
  });
  const result = (id, content) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
  const main = path.join(base, 's2.jsonl');
  writeFileSync(main, [call('k1', 'Skill', { skill: 'aidrian:plan-implement' }), result('k1', 'Launching skill: aidrian:plan-implement'),
    call('g1', 'Bash', { command: 'gh pr create --draft --title t --body-file b.md' }), result('g1', 'https://github.com/acme/notes/pull/3')].join('\n'));
  mkdirSync(path.join(base, 's2/subagents'), { recursive: true });
  writeFileSync(path.join(base, 's2/subagents/agent-a.jsonl'), [call('r1', 'Bash', { command: 'aidrian pr await-review 3' }), result('r1', '{\n  "status": "received",\n  "pr": 3\n}')].join('\n'));
  const row = sessionRow({ session_id: 's2', transcript_path: main }, findProject(dir), { env: { CLAUDE_CODE_AGENT: 'aidrian:orchestrator' }, now: NOW });
  assert.deepEqual([row.agent, row.skills, row.drafts_opened, row.review_runs], ['aidrian:orchestrator', ['aidrian:plan-implement'], 1, 1]);
  assert.doesNotMatch(JSON.stringify(row), /gh pr create|pull\/3|await-review|received/, 'the row holds no command and no output');
});

test('a request a forked subagent`s transcript repeats from its parent counts once, on the parent`s row: its Read and its tokens', async (t) => {
  const { base, dir, hook, logged } = project(t);
  const main = path.join(base, 's1.jsonl');
  const subagents = path.join(base, 's1/subagents');
  mkdirSync(subagents, { recursive: true });
  const read = (id, doc) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: path.join(dir, doc) } }] } });
  const [rules, testing, sharing] = ['docs/knowledge/product/product-rules.md', 'docs/knowledge/engineering/testing.md', 'docs/knowledge/product/sharing.md'];
  // a1 is forked from the main conversation, and a2 from a1, which a2's .meta.json names as its parent.
  writeFileSync(main, read('m1', rules));
  writeFileSync(path.join(subagents, 'agent-a1.jsonl'), [read('m1', rules), read('a1-1', testing)].join('\n'));
  writeFileSync(path.join(subagents, 'agent-a2.jsonl'), [read('m1', rules), read('a1-1', testing), read('a2-1', sharing)].join('\n'));
  writeFileSync(path.join(subagents, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'Explore', parentAgentId: 'a1' }));
  for (const id of ['a2', 'a1']) {
    const stop = { session_id: 's1', cwd: dir, transcript_path: main, agent_id: id, agent_type: 'Explore', last_assistant_message: 'Done.', stop_hook_active: false };
    assert.equal((await hook('hook-subagent-stop.mjs', { ...stop, agent_transcript_path: path.join(subagents, `agent-${id}.jsonl`) })).status, 0);
  }
  assert.equal((await hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: main })).status, 0);

  const rows = await logged(3);
  const one = { input: 10, output: 5, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 };
  assert.deepEqual(rows.map((row) => [row.agent_id ?? 'main', row.docs_read.map((doc) => doc.path), row.tokens ?? row.main.tokens]), [
    ['a2', [sharing], one],
    ['a1', [testing], one],
    ['main', [rules], one],
  ], 'each row holds only the requests it made');
  assert.deepEqual(rows[2].subagents.tokens, { ...one, input: 20, output: 10 }, 'the session`s subagent side is the sum of the stop rows');
  const bytes = (doc) => statSync(path.join(dir, doc)).size;
  const { docs, totals } = summarizeDocs(rows);
  assert.deepEqual(docs.find((doc) => doc.path === rules), { path: rules, reads: 1, bytes: bytes(rules), read_bytes: bytes(rules), readers: ['main'] });
  assert.deepEqual([totals.reads, totals.read_bytes], [3, bytes(rules) + bytes(testing) + bytes(sharing)]);
});

test('sessionRow without a transcript has no models and no docs read', () => {
  const row = sessionRow({ session_id: 's' }, null, { env: {}, now: NOW });
  assert.deepEqual([row.models, row.docs_read], [[], []]);
});
