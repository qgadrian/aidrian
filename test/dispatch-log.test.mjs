import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  claimedPaths, coverage, coverageLines, dispatchRow, formatDocs, formatReport, parseSince, sessionRow, summarize, summarizeDocs,
} from '../plugins/aidrian/lib/dispatch-log.mjs';
import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';

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
  const state = () => spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  const log = () => {
    try {
      return readFileSync(path.join(state(), 'dispatch-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const hook = (script, input) => spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env });
  return { base, dir, env, state, log, hook };
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

test('the hooks write dispatch, stop, and session rows inside a project, and nothing outside one', (t) => {
  const { base, dir, log, hook } = project(t);
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

  assert.equal(hook('hook-agent-post.mjs', { session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', description: 'Find tests' }, tool_response: { status: 'completed', agentId: 'a1', totalDurationMs: 1000 } }).status, 0);
  const stop = hook('hook-subagent-stop.mjs', { session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: agent, last_assistant_message: 'Done; nothing written.', stop_hook_active: false });
  assert.deepEqual([stop.status, stop.stderr], [0, '']);
  assert.equal(hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript, reason: 'exit' }).status, 0);
  assert.equal(hook('hook-session-end.mjs', { session_id: 's2', cwd: dir, transcript_path: path.join(base, 'empty.jsonl') }).status, 0, 'no usage: no row');

  const rows = log();
  assert.deepEqual(rows.map((row) => row.event), ['dispatch', 'stop', 'session']);
  assert.deepEqual(rows[1].tokens, { input: 10 + 10, output: 10, cache_read: 0, cache_write: 0, cache_write_5m: 0, cache_write_1h: 0 });
  const testing = 'docs/knowledge/engineering/testing.md';
  assert.deepEqual([rows[1].docs_read, rows[1].delivered, rows[1].models], [[{ path: testing, bytes: bytes(testing) }], 'chat', ['claude-sonnet-5-5']]);
  assert.deepEqual([rows[2].duration_min, rows[2].subagent_count, rows[2].models], [30, 1, ['claude-opus-5-5', 'claude-sonnet-5-5']]);
  const [rules, sharing] = ['docs/knowledge/product/product-rules.md', 'docs/knowledge/product/sharing.md'];
  assert.deepEqual(rows[2].docs_read, [{ path: rules, bytes: bytes(rules) }, { path: sharing, bytes: bytes(sharing) }], 'main reads only, sized from the project copy once the read one is gone');
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
  assert.equal(stop('out/gone.json does not exist, so I skipped it.', false).status, 0, 'a mention is not a claim');
  const inline = JSON.stringify({ status: 'done', role: 'explorer', evidence: [{ file: 'docs/absent.md', shows: 'no such doc' }] }, null, 2);
  assert.equal(stop(inline, false).status, 0, 'a handoff returned in the last message, as a read-only agent returns it, claims no file');
  assert.deepEqual(log().map((row) => row.delivered), ['missing', 'missing', 'missing', 'file', 'chat', 'chat']);
});

// Sets config.json `telemetry` in a project from project().
const setTelemetry = (dir, telemetry) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, telemetry }));

test('telemetry.enabled false: the hooks write no rows, and the delivery check still sends a subagent back', (t) => {
  const { base, dir, log, hook } = project(t);
  setTelemetry(dir, { enabled: false });
  const transcript = path.join(base, 's1.jsonl');
  writeFileSync(transcript, usageLine('m1', 'claude-opus-5-5', { input_tokens: 10, output_tokens: 1 }));
  assert.equal(hook('hook-agent-post.mjs', { session_id: 's1', cwd: dir, tool_name: 'Agent', tool_input: {}, tool_response: { agentId: 'a1' } }).status, 0);
  const sent = hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a1', last_assistant_message: 'Wrote out/handoff.json.', stop_hook_active: false });
  assert.deepEqual([sent.status, sent.stderr.startsWith('Your report names `out/handoff.json`')], [2, true]);
  assert.equal(hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript }).status, 0);
  assert.deepEqual(log(), []);
});

test('telemetry.docReads false: stop and session rows record docs_read null, and the rest as before', (t) => {
  const { base, dir, log, hook } = project(t);
  setTelemetry(dir, { docReads: false });
  const transcript = path.join(base, 's1.jsonl');
  const doc = path.join(dir, 'docs/knowledge/engineering/testing.md');
  writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: 'tool_use', name: 'Read', input: { file_path: doc } }] } }));
  hook('hook-subagent-stop.mjs', { cwd: dir, agent_id: 'a1', agent_type: 'Explore', agent_transcript_path: transcript, last_assistant_message: 'Done.', stop_hook_active: false });
  hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: transcript });
  const rows = log();
  assert.deepEqual(rows.map((row) => [row.event, row.docs_read, row.tokens?.input ?? row.tokens_by_model['claude-opus-5-5'].input]), [['stop', null, 10], ['session', null, 10]]);
});

test('a log of telemetry.maxMb rotates into dispatch-log.1.jsonl, a rotate row says whether rows were lost, and reports read both', (t) => {
  const { dir, env, state, log, hook } = project(t);
  setTelemetry(dir, { maxMb: 1 });
  const file = path.join(state(), 'dispatch-log.jsonl');
  const rotated = path.join(state(), 'dispatch-log.1.jsonl');
  const ts = new Date(Date.now() - 60_000).toISOString();
  const big = (id) => `${JSON.stringify({ event: 'dispatch', ts, session_id: 's', agent_id: id, agent_type: 'Explore', description: 'x'.repeat(1024 * 1024) })}\n`;
  const dispatch = (id) => hook('hook-agent-post.mjs', { session_id: 's', cwd: dir, tool_name: 'Agent', tool_input: { subagent_type: 'Explore' }, tool_response: { agentId: id } });
  mkdirSync(state(), { recursive: true });
  writeFileSync(file, big('old'));
  dispatch('a1');
  assert.equal(readFileSync(rotated, 'utf8'), big('old'));
  assert.deepEqual(log().map((row) => [row.event, row.dropped ?? row.agent_id]), [['rotate', false], ['dispatch', 'a1']]);
  dispatch('a2');
  assert.equal(log().length, 3, 'under the limit: no rotation');
  writeFileSync(file, big('older'), { flag: 'a' });
  dispatch('a3');
  assert.deepEqual(log().map((row) => [row.event, row.dropped ?? row.agent_id]), [['rotate', true], ['dispatch', 'a3']]);
  assert.equal(statSync(`${file}.lock`, { throwIfNoEntry: false }), undefined, 'the lock is gone');
  const json = JSON.parse(spawnSync(CLI, ['report', '--json'], { cwd: dir, env, encoding: 'utf8' }).stdout);
  assert.deepEqual(json.agents.map((agent) => [agent.agent_type, agent.dispatches]), [['Explore', 4]], 'a1, a2, and older from the rotated part; a3 from the log');

  // Another process holds the lock: append without rotating. A lock older than a minute is cleared for the next row.
  writeFileSync(file, big('busy'));
  writeFileSync(`${file}.lock`, '');
  dispatch('a4');
  assert.deepEqual(log().map((row) => row.agent_id), ['busy', 'a4']);
  utimesSync(`${file}.lock`, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
  dispatch('a5');
  dispatch('a6');
  assert.deepEqual(log().map((row) => row.event === 'rotate' || row.agent_id), [true, 'a6']);
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
  // a1's rows predate sizes in docs_read: bare paths count the same.
  const ts = '2026-10-29T11:00:00Z';
  const rows = [
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a1', agent_type: 'Explore', description: 'Find tests', duration_ms: 1000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a2', agent_type: 'Explore', description: 'Find tests', duration_ms: 3000 },
    { event: 'dispatch', ts, session_id: 's', agent_id: 'a3', agent_type: 'Explore', description: 'Map hooks', duration_ms: 2000 },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'missing', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a1', agent_type: 'Explore', tokens: { input: 1000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.5, delivered: 'file', docs_read: ['a.md'] },
    { event: 'stop', ts, agent_id: 'a2', agent_type: 'Explore', tokens: { input: 3000, output: 0, cache_read: 0, cache_write: 0 }, cost_usd: 0.25, delivered: 'chat', docs_read: [{ path: 'a.md', bytes: 10 }, { path: 'b.md', bytes: 20 }] },
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
  assert.deepEqual(Object.keys(JSON.parse(report(['--json']).stdout)), ['file', 'rotated', 'since', 'skipped', 'coverage', 'agents', 'sessions', 'unjoined_stops']);
  assert.equal(report(['--since', 'soon']).status, 1);
  assert.equal(report(['--prs', '0']).status, 1);
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
  assert.deepEqual([report(['nope']).status, report(['nope']).stderr], [1, 'unknown report: nope; use aidrian report, aidrian report docs, or aidrian report sessions\n']);
  assert.deepEqual([report(['docs', 'more']).status, report(['docs', '--prs', '1']).status], [1, 1]);
});

test('coverage: telemetry off, doc reads off, rows written without doc reads, and rows rotated out before the window', () => {
  const sinceMs = parseSince('7d', NOW);
  const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
  const rows = [
    { event: 'rotate', ts: day(3), dropped: true },
    { event: 'stop', ts: day(3), agent_id: 'a1', docs_read: null },
    { event: 'stop', ts: day(2), agent_id: 'a1', docs_read: [] },
    { event: 'stop', ts: day(2), agent_id: 'a2', docs_read: null },
    { event: 'session', ts: day(1), session_id: 's', docs_read: null },
    { event: 'session', ts: day(9), session_id: 'old', docs_read: null },
  ];
  const off = { telemetry: { ...DEFAULTS.telemetry, enabled: false } };
  const cover = coverage(rows, off, { sinceMs });
  assert.deepEqual(cover, { enabled: false, doc_reads: true, rows_without_doc_reads: 2, rotated_out_before: null }, 'a1 counts its last row; the old row is out of the window, and older than it');
  assert.equal(coverage(rows.slice(0, 5), DEFAULTS, { sinceMs }).rotated_out_before, day(3));
  assert.equal(coverage(rows.slice(1, 5), DEFAULTS, { sinceMs }).rotated_out_before, null, 'no rotate row that dropped rows: nothing is lost');
  assert.deepEqual(coverageLines(coverage(rows.slice(0, 5), { telemetry: { ...DEFAULTS.telemetry, docReads: false } }, { sinceMs })), [
    'Doc reads are off (telemetry.docReads is false): new rows do not record them.',
    'Partial: 2 agent and session rows in the window were written with doc reads off.',
    `Partial: the log starts at ${day(3)}; older rows were rotated out at telemetry.maxMb.`,
  ]);
  assert.deepEqual(coverageLines(cover, { docReads: false }), ['Telemetry is off (telemetry.enabled is false): the hooks write no rows, so this shows only older ones.']);
  assert.deepEqual(coverageLines(coverage([], DEFAULTS)), []);
});

test('aidrian report and report docs say when telemetry is off, and --json carries the coverage', (t) => {
  const { dir, env } = project(t);
  setTelemetry(dir, { enabled: false });
  const report = (args) => spawnSync(CLI, ['report', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.match(report([]).stdout, /^Dispatch log .*, since 7d\nTelemetry is off \(telemetry\.enabled is false\): .*\nNo rows yet\.\n$/);
  assert.match(report(['docs']).stdout, /^Knowledge docs read, .*\nTelemetry is off .*\nAlways docs: .*\nNo knowledge doc reads yet\.\n$/);
  assert.deepEqual(JSON.parse(report(['--json']).stdout).coverage, { enabled: false, doc_reads: true, rows_without_doc_reads: 0, rotated_out_before: null });
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
});

test('a request a forked subagent`s transcript repeats from its parent counts once, on the parent`s row: its Read and its tokens', (t) => {
  const { base, dir, log, hook } = project(t);
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
    assert.equal(hook('hook-subagent-stop.mjs', { ...stop, agent_transcript_path: path.join(subagents, `agent-${id}.jsonl`) }).status, 0);
  }
  assert.equal(hook('hook-session-end.mjs', { session_id: 's1', cwd: dir, transcript_path: main }).status, 0);

  const rows = log();
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
