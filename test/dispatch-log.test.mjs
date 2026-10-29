import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { claimedPaths, dispatchRow, formatReport, parseSince, sessionRow, summarize } from '../plugins/aidrian/lib/dispatch-log.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const SCRIPTS = path.join(ROOT, 'plugins/aidrian/scripts');
const NOW = Date.parse('2026-10-29T12:00:00Z');

const usageLine = (id, model, usage, ts = '2026-10-29T10:00:00Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage, content: [] } });

// A copy of the example consumer in a git repository, with its own state folder.
function project(t) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-dlog-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state') };
  const log = () => {
    const state = spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
    try {
      return readFileSync(path.join(state, 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env });
  return { base, dir, env, log, hook };
}

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
    'Links: https://github.com/acme/notes/blob/main/README.md, <state>/handoffs/x.md, {dir}/y.json, docs/*.md, README.md, ~/notes/todo.md.',
  ].join('\n');
  assert.deepEqual(claimedPaths(message), ['/abs/out/handoff.json', 'docs/hooks.md', 'src/a.md', '~/notes/todo.md']);
  assert.deepEqual(claimedPaths(undefined), []);
});

test('the hooks write dispatch, stop, and session rows inside a project, and nothing outside one', (t) => {
  const { base, dir, log, hook } = project(t);
  const transcript = path.join(base, 's1.jsonl');
  const agent = path.join(base, 's1/subagents/agent-a1.jsonl');
  mkdirSync(path.dirname(agent), { recursive: true });
  writeFileSync(transcript, usageLine('m1', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }, '2026-10-29T10:00:00Z') + '\n' +
    usageLine('m2', 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 100 }, '2026-10-29T10:30:00Z'));
  const read = (file) => JSON.stringify({ type: 'assistant', message: { id: file, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: file } }] } });
  writeFileSync(agent, [read(path.join(dir, 'docs/knowledge/engineering/testing.md')), read(path.join(dir, 'src/sharing.js'))].join('\n'));

  assert.equal(hook('hook-agent-post.mjs', { session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: 'Find tests' }, tool_response: { status: 'completed', agentId: 'a1', totalDurationMs: 1000 } }).status, 0);
  const stop = hook('hook-subagent-stop.mjs', { session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: agent, last_assistant_message: 'Done; nothing written.', stop_hook_active: false });
  assert.deepEqual([stop.status, stop.stderr], [0, '']);
  assert.equal(hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript, reason: 'exit' }).status, 0);
  assert.equal(hook('hook-session-end.mjs', { session_id: 's2', cwd: dir, transcript_path: path.join(base, 'empty.jsonl') }).status, 0, 'no usage: no row');

  const rows = log();
  assert.deepEqual(rows.map((row) => row.event), ['dispatch', 'stop', 'session']);
  assert.deepEqual(rows[1].tokens, { input: 10 + 10, output: 10, cache_read: 0, cache_write: 0 });
  assert.deepEqual([rows[1].docs_read, rows[1].delivered, rows[1].models], [['docs/knowledge/engineering/testing.md'], 'chat', ['claude-sonnet-5-5']]);
  assert.deepEqual([rows[2].duration_min, rows[2].subagent_count, rows[2].models], [30, 1, ['claude-opus-5-5', 'claude-sonnet-5-5']]);
  assert.ok(rows[2].cost_usd > 0);

  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-dlog-none-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.equal(hook('hook-agent-post.mjs', { cwd: outside, tool_name: 'Agent', tool_input: {}, tool_response: {} }).status, 0);
  assert.equal(log().length, 3);
});

test('the delivery check sends a subagent back once for a path it named that does not exist', (t) => {
  const { dir, log, hook } = project(t);
  mkdirSync(path.join(dir, 'out'));
  writeFileSync(path.join(dir, 'out/real.json'), '{}');
  const stop = (message, active) => hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a2', agent_type: 'planner', last_assistant_message: message, stop_hook_active: active });
  const sent = stop('Wrote out/real.json and out/handoff.json.', false);
  assert.equal(sent.status, 2);
  assert.match(sent.stderr, /^Your report names `out\/handoff\.json`, which does not exist\. If you meant to write it, write it now/);
  assert.equal(stop('Wrote out/real.json and out/handoff.json.', true).status, 0, 'the second stop always ends');
  assert.equal(hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a3', last_assistant_message: 'Wrote out/none.json.' }).status, 0, 'no stop_hook_active field: never sent back');
  assert.deepEqual([stop('Wrote out/real.json.', false).status], [0]);
  assert.deepEqual(log().map((row) => row.delivered), ['missing', 'missing', 'missing', 'file']);
});

test('every dispatch-log hook exits 0 silently on a payload it cannot read', () => {
  for (const script of ['hook-agent-post.mjs', 'hook-subagent-stop.mjs', 'hook-session-end.mjs']) {
    for (const input of ['', 'not json', '[]', '{}', JSON.stringify({ cwd: 42, tool_name: 'Agent' })]) {
      const { status, stdout, stderr } = spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input, encoding: 'utf8', cwd: tmpdir() });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${script} ${input}`);
    }
  }
});

test('summarize: per agent type dispatches, re-dispatch rate, medians, cost, delivery, top docs; then sessions', () => {
  const ts = '2026-10-29T11:00:00Z';
  const rows = [
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a1', agent_type: 'Explore', description: 'Find tests', duration_ms: 1000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a2', agent_type: 'Explore', description: 'Find tests', duration_ms: 3000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a3', agent_type: 'Explore', description: 'Map hooks', duration_ms: 2000 },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'missing', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'file', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a2', agent_type: 'Explore', tokens: { input: 3000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.25, delivered: 'chat', docs_read: ['a.md', 'b.md'] },
    { event: 'stop', ts, agent_id: 'zz', agent_type: 'planner', tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0 }, cost_usd: 0, delivered: 'chat', docs_read: [] },
    { event: 'session', ts, session_id: 's', cost_usd: 4.5 },
    { event: 'session', ts: '2026-10-01T00:00:00Z', session_id: 'old', cost_usd: 100 },
    { event: 'unknown', ts },
  ];
  const summary = summarize(rows, { sinceMs: parseSince('7d', NOW) });
  assert.deepEqual(summary.agents[0], {
    agent_type: 'Explore', dispatches: 3, redispatch_rate: 0.33, median_duration_ms: 2000, median_tokens: 2000, cost_usd: 0.75,
    delivered: { file: 1, chat: 1, missing: 0 }, top_docs: [['a.md', 2], ['b.md', 1]],
  });
  assert.equal(summary.agents[1].dispatches, 0);
  assert.deepEqual([summary.sessions, summary.unjoined_stops], [{ count: 1, cost_usd: 4.5 }, 1]);
  const text = formatReport(summary, { file: '/s/dispatch-log.jsonl', since: '7d', skipped: 2 });
  assert.match(text, /^Dispatch log \/s\/dispatch-log\.jsonl, since 7d \(2 unreadable rows skipped\)\n/);
  assert.match(text, /Explore: 3 dispatches, 33% re-dispatched, median 2s and 2k tokens, \$0\.75, delivered 1 file \/ 1 chat \/ 0 missing\n {2}docs read: a\.md \(2\), b\.md \(1\)/);
  assert.match(text, /Sessions: 1, \$4\.50 estimated/);
  assert.match(text, /1 stop rows have no dispatch row/);
});

test('parseSince takes a span or a date; aidrian report prints the log, --json the summary', (t) => {
  assert.equal(parseSince('24h', NOW), NOW - 86_400_000);
  assert.equal(parseSince('2026-10-01', NOW), Date.parse('2026-10-01T00:00:00Z'));
  assert.throws(() => parseSince('soon'), /--since takes/);
  const { dir, env } = project(t);
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.match(report([]).stdout, /^Dispatch log .*dispatch-log\.jsonl, since 7d\nNo rows yet\.\n$/);
  assert.deepEqual(Object.keys(JSON.parse(report(['--json']).stdout)), ['file', 'since', 'skipped', 'agents', 'sessions', 'unjoined_stops']);
  assert.equal(report(['--since', 'soon']).status, 1);
  assert.equal(report(['--prs', '0']).status, 1);
});

test('sessionRow without a transcript has no models', () => {
  assert.deepEqual(sessionRow({ session_id: 's' }, { env: {}, now: NOW }).models, []);
});
