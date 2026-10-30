import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSince } from '../plugins/aidrian/lib/report.mjs';
import { formatSessions, summarizeSessions } from '../plugins/aidrian/lib/report-sessions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const NOW = Date.parse('2026-10-29T12:00:00Z');

const tokens = (input, cache1h = 0, cache5m = 0) => ({
  input, output: 0, cache_read: 0, cache_write: cache1h + cache5m, cache_write_5m: cache5m, cache_write_1h: cache1h,
});
const side = (cost, input, { cache1h = 0, cache5m = 0, requests = 0, toolRequests = 0, toolCalls = 0 } = {}) => ({
  tokens: tokens(input, cache1h, cache5m), cost_usd: cost, requests, tool_requests: toolRequests, tool_calls: toolCalls,
});
// s1 ended twice (resumed): its last row counts. s3 predates the split. old is out of the window.
const SESSION_ROWS = [
  { event: 'session', ts: '2026-10-28T09:00:00Z', session_id: 's1', cost_usd: 1, effort: 'high' },
  {
    event: 'session', ts: '2026-10-28T18:30:00Z', session_id: 's1', agent: 'orchestrator', duration_min: 95.4, effort: 'high', cost_usd: 8,
    tokens_by_model: { 'claude-opus-5-5': tokens(1_500_000, 400_000), 'claude-sonnet-5-5': tokens(600_000, 0, 100_000) },
    cost_by_model: { 'claude-opus-5-5': 6.5, 'claude-sonnet-5-5': 1.5 },
    main: side(6, 1_200_000, { cache1h: 300_000, requests: 40, toolRequests: 32, toolCalls: 40 }),
    subagents: side(2, 900_000, { cache1h: 100_000, cache5m: 100_000, requests: 30, toolRequests: 20, toolCalls: 30 }),
  },
  {
    event: 'session', ts: '2026-10-29T10:00:00Z', session_id: 's2', duration_min: 20, effort: 'medium', cost_usd: 2,
    tokens_by_model: { 'claude-opus-5-5': tokens(500_000) },
    cost_by_model: { 'claude-opus-5-5': 2 },
    main: side(2, 500_000, { requests: 10, toolRequests: 8, toolCalls: 8 }),
    subagents: side(0, 0),
  },
  { event: 'session', ts: '2026-10-29T11:00:00Z', session_id: 's3', cost_usd: 0.5, tokens_by_model: { 'claude-opus-5-5': { input: 1, output: 0, cache_read: 0, cache_write: 0 } } },
  { event: 'session', ts: '2026-10-01T00:00:00Z', session_id: 'old', cost_usd: 100 },
  { event: 'stop', ts: '2026-10-29T10:00:00Z', agent_id: 'a1', cost_usd: 50 },
];

test('summarizeSessions: last row per session, main and subagent sides, cache writes, per day, model, and effort', () => {
  const summary = summarizeSessions(SESSION_ROWS, { sinceMs: parseSince('7d', NOW) });
  assert.deepEqual([summary.count, summary.ended_more_than_once, summary.without_split, summary.cost_usd], [3, 1, 1, 10.5]);
  assert.deepEqual(summary.main, side(8, 1_700_000, { cache1h: 300_000, requests: 50, toolRequests: 40, toolCalls: 48 }));
  assert.deepEqual(summary.subagents, side(2, 900_000, { cache1h: 100_000, cache5m: 100_000, requests: 30, toolRequests: 20, toolCalls: 30 }));
  assert.deepEqual(summary.by_day, [{ day: '2026-10-28', sessions: 1, cost_usd: 8 }, { day: '2026-10-29', sessions: 2, cost_usd: 2.5 }]);
  assert.deepEqual(summary.by_model, [
    { model: 'claude-opus-5-5', cost_usd: 8.5, tokens: 2_400_000 },
    { model: 'claude-sonnet-5-5', cost_usd: 1.5, tokens: 700_000 },
  ], 's3, logged before cost per model, is left out');
  assert.deepEqual(summary.by_effort, [{ effort: 'high', sessions: 1, cost_usd: 8 }, { effort: 'medium', sessions: 1, cost_usd: 2 }, { effort: null, sessions: 1, cost_usd: 0.5 }]);
  assert.deepEqual(summary.top.map((session) => [session.session_id, session.cost_usd, session.main_cost_usd]), [['s1', 8, 6], ['s2', 2, 2], ['s3', 0.5, null]]);
});

test('formatSessions prints the totals, the sides, cache writes, per day, model, effort, and the most costly sessions', () => {
  const summary = summarizeSessions(SESSION_ROWS, { sinceMs: parseSince('7d', NOW) });
  assert.equal(formatSessions(summary, { file: '/s/dispatch-log.jsonl', since: '7d', skipped: 0, notes: ['Telemetry is off.'] }), [
    'Sessions, from /s/dispatch-log.jsonl, since 7d',
    'Telemetry is off.',
    'Partial: 1 of 3 sessions were logged before the main and subagent split; the main, subagent, cache-write, and per-model lines leave them out.',
    '3 sessions, $10.50 estimated; 1 ended more than once, counted at the last end',
    'Main conversation: $8.00 (80%), 2.0M tokens, 1.20 tool calls per request that made one',
    'Subagents: $2.00 (20%), 1.1M tokens, 1.50 tool calls per request that made one',
    'Cache writes: 500k tokens; 1-hour 400k (80%) at 2x the input price, 5-minute 100k at 1.25x',
    'Per day:',
    '  2026-10-28  1 session         $8.00',
    '  2026-10-29  2 sessions        $2.50',
    'Per model:',
    '  claude-opus-5-5        $8.50  2.4M tokens',
    '  claude-sonnet-5-5      $1.50  700k tokens',
    'Per effort (the main conversation at its last request):',
    '  high    1 session         $8.00',
    '  medium  1 session         $2.00',
    '  -       1 session         $0.50',
    'Most costly sessions, top 3:',
    '      $8.00  2026-10-28 18:30  s1  orchestrator, high, 95 min; main $6.00, subagents $2.00',
    '      $2.00  2026-10-29 10:00  s2  medium, 20 min; main $2.00, subagents $0.00',
    '      $0.50  2026-10-29 11:00  s3',
  ].join('\n'));
  assert.equal(formatSessions(summarizeSessions([]), { file: 'f', since: '7d', skipped: 2 }), 'Sessions, from f, since 7d (2 unreadable rows skipped)\nNo sessions yet.');
});

test('aidrian report sessions prints the view, --json all of it, and refuses --prs', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-sessions-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  const env = { ...process.env, XDG_STATE_HOME: path.join(base, 'state') };
  const report = (args) => spawnSync(CLI, ['report', 'sessions', ...args], { cwd: dir, env, encoding: 'utf8' });
  assert.match(report([]).stdout, /^Sessions, from .*dispatch-log\.jsonl, since 7d\nNo sessions yet\.\n$/);
  const state = spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  mkdirSync(state, { recursive: true });
  const recent = SESSION_ROWS.map((row, i) => ({ ...row, ts: new Date(Date.now() - (10 - i) * 60_000).toISOString() }));
  writeFileSync(path.join(state, 'dispatch-log.jsonl'), `${recent.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const text = report(['--since', '1d']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\n4 sessions, \$110\.50 estimated; 1 ended more than once/);
  const json = JSON.parse(report(['--json']).stdout);
  assert.deepEqual(Object.keys(json), [
    'file', 'rotated', 'since', 'skipped', 'coverage', 'count', 'ended_more_than_once', 'without_split', 'cost_usd', 'main', 'subagents',
    'by_day', 'by_model', 'by_effort', 'top',
  ]);
  assert.deepEqual([report(['--prs', '3']).status, report(['--prs', '3']).stderr], [1, '--prs belongs to aidrian report, aidrian report reviews, and aidrian report health, not aidrian report sessions\n']);
  assert.equal(spawnSync(CLI, ['report', 'agents', '--json'], { cwd: dir, env, encoding: 'utf8' }).status, 0, 'agents names the default view');
});
