import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { parseSince } from '../plugins/aidrian/lib/dispatch-log.mjs';
import { fold } from '../plugins/aidrian/lib/lesson-inbox.mjs';
import { FIXES, formatHealth, summarizeHealth } from '../plugins/aidrian/lib/report-health.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const SKILL = path.join(ROOT, 'plugins/aidrian/skills/harness-health/SKILL.md');
const NOW = Date.parse('2026-10-29T12:00:00Z');
const SINCE = parseSince('30d', NOW);
const at = (hoursAgo) => new Date(NOW - hoursAgo * 3_600_000).toISOString();

// config.json's defaults, with `health` over telemetry.health.
const configWith = (health = {}) => ({ ...DEFAULTS, telemetry: { ...DEFAULTS.telemetry, health: { ...DEFAULTS.telemetry.health, ...health } } });

// One subagent run: its dispatch row and its stop row, and a first stop row marked `missing` and `sent_back` when the
// delivery check sent it back. `legacy` writes the stop rows as they were before they recorded `sent_back`.
let runs = 0;
function run(agentType, session, description, { sentBack = false, legacy = false, docs = [] } = {}) {
  const id = `agent-${(runs += 1)}`;
  const stop = { event: 'stop', ts: at(48), session_id: session, agent_id: id, agent_type: agentType, docs_read: docs, cost_usd: 0.1 };
  const mark = (row, sent) => (legacy ? row : { ...row, sent_back: sent });
  return [
    { event: 'dispatch', ts: at(48), session_id: session, agent_id: id, agent_type: agentType, description },
    ...(sentBack ? [mark({ ...stop, delivered: 'missing' }, true)] : []),
    mark({ ...stop, delivered: 'file' }, false),
  ];
}
const A = { path: 'docs/a.md', bytes: 30000 };
const B = { path: 'docs/b.md', bytes: 2000 };
// aidrian:explorer: 10 dispatches of 6 distinct tasks (40% re-dispatched), 2 of 10 runs sent back (20%), each reading a and b.
// Explore: 3 runs, under the minimum sample. code-reviewer: 6 distinct tasks, none sent back.
const EXPLORER = [['t1', 's1'], ['t1', 's1'], ['t2', 's2'], ['t2', 's2'], ['t3', 's3'], ['t3', 's3'], ['t3', 's3'], ['t4', 's4'], ['t5', 's5'], ['t6', 's5']];
const RUN_ROWS = [
  ...EXPLORER.flatMap(([task, session], i) => run('aidrian:explorer', session, task, { sentBack: i < 2, docs: [A, B] })),
  ...['e1', 'e2', 'e3'].flatMap((task) => run('Explore', 's6', task, { docs: [B] })),
  ...['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].flatMap((task) => run('code-reviewer', 's7', task)),
];
// Twelve sessions in the order they ended: the older six at $1, the newer six at $2, but the last at $3. s1 ended twice.
const SESSION_ROWS = [
  { event: 'session', ts: at(300), session_id: 's1', cost_usd: 50, docs_read: [] },
  ...Array.from({ length: 12 }, (_, i) => ({
    event: 'session', ts: at(240 - i * 10), session_id: `s${i + 1}`, cost_usd: i < 6 ? 1 : i === 11 ? 3 : 2,
    main: { cost_usd: 0.5 }, subagents: { cost_usd: 0.5 }, docs_read: [],
  })),
];
const DENY_ROWS = [
  ...Array.from({ length: 6 }, (_, i) => ({ event: 'hook_deny', ts: at(30), session_id: i < 4 ? 's1' : 's2', rule: 'git-amend', agent_type: 'main', reason: 'this rewrites the branch tip.' })),
  { event: 'hook_deny', ts: at(30), session_id: 's3', rule: 'process-kill', agent_type: 'Explore', reason: 'this kills by name.' },
];
const OLD_ROWS = [{ event: 'hook_deny', ts: at(24 * 40), session_id: 'old', rule: 'pr-body', agent_type: 'main' }];
const ROWS = [...OLD_ROWS, ...RUN_ROWS, ...SESSION_ROWS, ...DENY_ROWS];

// a is tagged and over taggedDocBytes; c is tagged and nobody reads it; d is untagged and nobody reads it, which is fine.
const KNOWLEDGE = {
  indexed: [A, B, { path: 'docs/c.md', bytes: 5000 }, { path: 'docs/d.md', bytes: 9000 }],
  always: { bytes: 20000, budget: 16384, buckets: { engineering: 20000 } },
  tags: { 'docs/a.md': ['testing'], 'docs/b.md': ['code_style'], 'docs/c.md': ['review'], 'docs/d.md': [] },
};
const EMPTY_KNOWLEDGE = { indexed: [], always: { bytes: 0, budget: 16384, buckets: {} }, tags: {} };
// Six reviewed pull requests at 3.5 rounds each on average; 2 late findings checked, under the minimum sample.
const REVIEWS = {
  reviewer: 'chatgpt-codex-connector[bot]', merged: 8, reviewed: 6, clean_first_pass: 1, avg_rounds: 3.5, five_or_more: 2, rounds: [],
  findings: 20, findings_rounds: 18, by_round: {}, late_findings: 9, late_checked: 2, late_on_seen_line: 2, late_unchecked: {}, capped: 0, unread: 0,
  truncated: false,
};
// A P1 open 20 days, a P2, and a fix resolved 8 days ago that was seen again 2 days ago, which reopens it.
const LESSONS = fold([
  { event: 'add', id: 'aaaa0001', at: at(24 * 20), tier: 'P1', note: 'A push lost a commit' },
  { event: 'add', id: 'aaaa0002', at: at(24 * 3), tier: 'P2', note: 'Explore reads the same doc twice' },
  { event: 'add', id: 'aaaa0003', at: at(24 * 10), tier: 'P2', note: 'Amend blocked three times' },
  { event: 'resolve', id: 'aaaa0003', at: at(24 * 8), outcome: 'mechanism', link: 'abc1234' },
  { event: 'seen', id: 'aaaa0003', at: at(24 * 2), note: 'blocked again' },
]).lessons;

const mixed = (health) =>
  summarizeHealth({ rows: ROWS, sinceMs: SINCE, now: NOW, knowledge: KNOWLEDGE, reviews: REVIEWS, lessons: LESSONS, config: configWith(health) });

test('summarizeHealth ranks the problems worst first, each with its value, threshold, sample, fix, and lesson labels', () => {
  const { problems, thresholds } = mixed();
  assert.deepEqual(thresholds, { health: DEFAULTS.telemetry.health, budgets: DEFAULTS.knowledge.budgets, lessons: { maxOpen: 20, maxAgeDays: 14 } });
  assert.deepEqual(problems.map((item) => [item.kind, item.subject, item.value, item.threshold, item.sample.n, item.fix]), [
    ['p1-lesson', null, 1, 0, 3, 'lesson-triage'],
    ['always-budget', null, 20000, 16384, 4, 'split-doc'],
    ['tagged-doc', 'docs/a.md', 30000, 24576, 4, 'split-doc'],
    ['redispatch', 'aidrian:explorer', 40, 20, 10, 'agent-prompt'],
    ['sent-back', 'aidrian:explorer', 20, 10, 10, 'agent-prompt'],
    ['review-rounds', null, 3.5, 3, 6, 'round-cap'],
    ['deny-hot-spot', 'git-amend', 6, 5, 12, 'deny-rule'],
    ['fix-recurred', null, 1, 0, 1, 'lesson-triage'],
    ['cost-rise', null, 117, 50, 12, 'cost'],
    ['top-doc', 'docs/a.md', 92, 50, 31, 'split-doc'],
    ['never-read', null, 1, 0, 31, 'split-doc'],
    ['lesson-backlog', null, 20, 14, 3, 'lesson-triage'],
  ]);
  const byKind = Object.fromEntries(problems.map((item) => [item.kind, item]));
  assert.deepEqual(byKind.redispatch.lesson, { tier: 'P2', kind: 'improvement', target: 'plugin', key: 'health:redispatch:aidrian:explorer' });
  // The problems the plugin already records as automatic lessons take those lessons' keys and labels.
  assert.deepEqual(byKind['sent-back'].lesson, { tier: 'P2', kind: 'bug', target: 'plugin', key: 'delivery-check:aidrian:explorer' });
  assert.deepEqual(byKind['deny-hot-spot'].lesson, { tier: 'P2', kind: 'gap', target: 'plugin', key: 'hook-deny:git-amend' });
  assert.deepEqual(byKind['review-rounds'].lesson, { tier: 'P2', kind: null, target: 'project', key: 'review-rounds' });
  assert.equal(byKind['p1-lesson'].lesson, null, 'a lesson problem is a lesson already');
  assert.equal(byKind['never-read'].summary, '1 tagged doc never read in 31 rows with doc reads: docs/c.md.');
  assert.equal(byKind['cost-rise'].summary,
    'The newer 6 sessions cost $2.17 a session against $1.00 for the older 6, up 117%, over 50%; the most costly was s12 at $3.00.');
});

test('summarizeHealth: each signal carries its sample, and a part under minSample is not enough data, never a problem', () => {
  const { signals } = mixed();
  assert.deepEqual(Object.fromEntries(Object.entries(signals).map(([name, signal]) => [name, signal.status])), {
    budget: 'problem', docs: 'problem', agents: 'problem', reviews: 'problem', denies: 'problem', cost: 'problem', lessons: 'problem',
  });
  assert.deepEqual(signals.agents.agents.map((agent) => [agent.agent_type, agent.redispatch, agent.sent_back]), [
    ['Explore', { n: 3, percent: 0, status: 'not_enough_data' }, { n: 3, percent: 0, status: 'not_enough_data', unknown: 0 }],
    ['aidrian:explorer', { n: 10, percent: 40, status: 'problem' }, { n: 10, percent: 20, status: 'problem', unknown: 0 }],
    ['code-reviewer', { n: 6, percent: 0, status: 'ok' }, { n: 6, percent: 0, status: 'ok', unknown: 0 }],
  ]);
  assert.deepEqual(signals.reviews.late, { n: 2, on_seen_line: 2, percent: 100, status: 'not_enough_data' }, '100% of 2 is not judged');
  assert.deepEqual(signals.denies.rules.map((rule) => [rule.rule, rule.count]), [['git-amend', 6], ['process-kill', 1]], 'pr-body is older than the window');
  assert.deepEqual(signals.docs.top.map((doc) => [doc.path, doc.percent]), [['docs/a.md', 92], ['docs/b.md', 8]]);
  assert.deepEqual([signals.docs.never_read, signals.docs.never_read_tagged], [2, ['docs/c.md']]);
  assert.deepEqual([signals.cost.older, signals.cost.newer, signals.cost.change_percent], [{ n: 6, avg_usd: 1 }, { n: 6, avg_usd: 2.17 }, 117]);
  assert.deepEqual([signals.lessons.p1, signals.lessons.oldest_days, signals.lessons.recurred], [1, 20, ['aaaa0003']]);
});

test('summarizeHealth: every signal says not enough data, or unavailable, with no rows, no index, no gh, and no lessons', () => {
  const health = summarizeHealth({ rows: [], sinceMs: SINCE, now: NOW, knowledge: EMPTY_KNOWLEDGE, reviews: { reviewer: 'bot', error: 'gh: not found' }, config: configWith() });
  assert.deepEqual(health.problems, []);
  assert.deepEqual(Object.fromEntries(Object.entries(health.signals).map(([name, signal]) => [name, signal.status])), {
    budget: 'not_enough_data', docs: 'not_enough_data', agents: 'not_enough_data', reviews: 'unavailable', denies: 'not_enough_data',
    cost: 'not_enough_data', lessons: 'ok',
  });
  assert.equal(health.signals.reviews.error, 'gh: not found');
});

test('summarizeHealth: a sample under minSample in each windowed signal hides a problem the same rows show at a lower minimum', () => {
  // The same rows at minSample 13: every windowed signal has fewer samples than that, so none judges.
  const strict = mixed({ minSample: 13 });
  // The doc reads have 31 rows: still judged.
  assert.deepEqual(strict.problems.map((item) => item.kind),
    ['p1-lesson', 'always-budget', 'tagged-doc', 'fix-recurred', 'top-doc', 'never-read', 'lesson-backlog']);
  for (const name of ['agents', 'reviews', 'denies', 'cost']) assert.equal(strict.signals[name].status, 'not_enough_data', name);
  // At minSample 2 the two late findings are judged: both on a seen line, 100%, over 50%.
  assert.ok(mixed({ minSample: 2 }).problems.some((item) => item.kind === 'late-findings' && item.value === 100 && item.sample.n === 2));
  // Docs under the minimum: no top-doc and no never-read problem.
  const docs = summarizeHealth({ rows: SESSION_ROWS.slice(0, 3), sinceMs: SINCE, now: NOW, knowledge: KNOWLEDGE, reviews: REVIEWS, config: configWith() });
  assert.deepEqual([docs.signals.docs.status, docs.signals.docs.sample.n], ['not_enough_data', 2]);
});

test('summarizeHealth: a run that named a missing file before stop rows recorded sent_back is unknown, out of the sample and the rate', () => {
  // planner: 3 runs none sent back, and 2 written before `sent_back` that named a missing file. Counting `delivered: missing`
  // would make it 2 of 5 runs, 40%.
  const rows = [
    ...['p1', 'p2', 'p3'].flatMap((task) => run('planner', 's8', task)),
    ...['p4', 'p5'].flatMap((task) => run('planner', 's8', task, { sentBack: true, legacy: true })),
  ];
  const health = (more = []) =>
    summarizeHealth({ rows: [...rows, ...more], sinceMs: SINCE, now: NOW, knowledge: EMPTY_KNOWLEDGE, reviews: { error: 'gh: not found' }, config: configWith() });
  const few = health();
  assert.deepEqual(few.signals.agents.agents.map((agent) => [agent.agent_type, agent.sent_back]), [
    ['planner', { n: 3, percent: 0, status: 'not_enough_data', unknown: 2 }],
  ], '3 known runs are under minSample 5');
  assert.deepEqual(few.problems, []);
  assert.match(formatHealth(few, { file: 'f', since: '30d', skipped: 0 }), /\n {4}planner: .*, sent back not enough data \(n=3, needs 5, 2 unknown\)\n/);
  // Two more runs with sent_back reach the minimum: 1 of 5 known runs sent back, 20%, over 10%.
  const enough = health([...run('planner', 's8', 'p6', { sentBack: true }), ...run('planner', 's8', 'p7')]);
  assert.deepEqual(enough.signals.agents.agents[0].sent_back, { n: 5, percent: 20, status: 'problem', unknown: 2 });
  const [problem] = enough.problems.filter((item) => item.kind === 'sent-back');
  assert.deepEqual([problem.value, problem.sample], [20, { n: 5, of: 'runs with a known send-back' }]);
  assert.equal(problem.summary, 'planner: the delivery check sent back 1 of 5 runs (20%), over 10%; each named a file it had not written.');
  assert.match(formatHealth(enough, { file: 'f', since: '30d', skipped: 0 }), /\n {4}planner: .*, 20% sent back \(n=5, 2 unknown\)\n/);
});

test('summarizeHealth: telemetry.health thresholds move the verdicts; hook denies off leave that signal unavailable', () => {
  const loose = mixed({ redispatchPercent: 50, sentBackPercent: 25, reviewRounds: 4, denyHotSpot: 7, costRisePercent: 200, topDocPercent: 95 });
  assert.deepEqual(loose.problems.map((item) => item.kind), ['p1-lesson', 'always-budget', 'tagged-doc', 'fix-recurred', 'never-read', 'lesson-backlog']);
  assert.deepEqual(Object.fromEntries(['agents', 'reviews', 'denies', 'cost'].map((name) => [name, loose.signals[name].status])),
    { agents: 'ok', reviews: 'ok', denies: 'ok', cost: 'ok' });
  const config = configWith();
  const off = summarizeHealth({ rows: ROWS, sinceMs: SINCE, now: NOW, knowledge: KNOWLEDGE, reviews: REVIEWS, config: { ...config, telemetry: { ...config.telemetry, hookDenies: false } } });
  assert.deepEqual(off.signals.denies, { status: 'unavailable', error: 'telemetry.hookDenies is off' });
});

test('formatHealth prints the problems worst first, then each signal with its sample and threshold', () => {
  const text = formatHealth(mixed(), { file: '/s/dispatch-log.jsonl', since: '30d', skipped: 0, notes: ['Doc reads are off.'] });
  assert.equal(text, [
    'Harness health, from /s/dispatch-log.jsonl, since 30d',
    'Doc reads are off.',
    'Problems, worst first: 12',
    '  1. 1 P1 lesson open: each blocked or lost work. Fix: lesson-triage.',
    '  2. The always docs are 20000 bytes, over knowledge.budgets.alwaysBytes (16384); every session and subagent reads them. Fix: split-doc.',
    '  3. docs/a.md is 30000 bytes, over knowledge.budgets.taggedDocBytes (24576); every route to testing reads it whole. Fix: split-doc.',
    '  4. aidrian:explorer: 40% of 10 dispatches repeated a task already dispatched in the same session, over 20%. Fix: agent-prompt.',
    '  5. aidrian:explorer: the delivery check sent back 2 of 10 runs (20%), over 10%; each named a file it had not written. Fix: agent-prompt.',
    '  6. The review bot took 3.5 rounds a pull request on 6 reviewed, over 3; 2 needed 5 or more. Fix: round-cap.',
    '  7. The git-amend rule blocked 6 calls in 12 sessions, 5 or more: by main 6; most often: this rewrites the branch tip. Fix: deny-rule.',
    '  8. 1 of 1 fix in the window recurred, so the problem came back: aaaa0003. Fix: lesson-triage.',
    '  9. The newer 6 sessions cost $2.17 a session against $1.00 for the older 6, up 117%, over 50%; the most costly was s12 at $3.00. Fix: cost.',
    '  10. docs/a.md takes 92% of the 318.4 KB of knowledge docs read, over 50%: 10 reads of 29.3 KB. Fix: split-doc.',
    '  11. 1 tagged doc never read in 31 rows with doc reads: docs/c.md. Fix: split-doc.',
    '  12. The lesson inbox needs triage: the oldest is 20 days old, over lessons.maxAgeDays (14). Fix: lesson-triage.',
    'Signals; n is the sample, and a signal under 5 (telemetry.health.minSample) is not judged:',
    '  Knowledge budget: problem; always docs 20000 of 16384 bytes, 1 of 4 indexed docs tagged and over 24576 bytes',
    '  Doc reads: problem (n=31 rows); most bytes read: docs/a.md 92%, docs/b.md 8% of 318.4 KB (over 50% is a problem); ' +
      '2 indexed docs never read, 1 of them tagged',
    '  Agents: problem (thresholds: 20% re-dispatched, 10% sent back)',
    '    Explore: re-dispatched not enough data (n=3, needs 5), sent back not enough data (n=3, needs 5)',
    '    aidrian:explorer: 40% re-dispatched (n=10), 20% sent back (n=10)',
    '    code-reviewer: 0% re-dispatched (n=6), 0% sent back (n=6)',
    '  Reviews: problem; 3.5 rounds a pull request (n=6 reviewed, threshold 3); late findings not enough data (n=2, needs 5 checked)',
    '  Hook denies: problem (n=12 sessions); 7 blocks: git-amend 6, process-kill 1 (5 or more by one rule is a hot spot)',
    '  Session cost: problem (n=6 sessions a half); 12 sessions, $19.00; $2.17 a session in the newer half against $1.00, up 117% (threshold 50%)',
    '  Lessons: problem; 3 open, 1 P1, the oldest 20 days; 1 fix in the window, 1 recurred',
  ].join('\n'));
});

test('formatHealth with no data says so on every signal', () => {
  const health = summarizeHealth({ rows: [], sinceMs: SINCE, now: NOW, knowledge: EMPTY_KNOWLEDGE, reviews: { error: 'gh: not found' }, config: configWith() });
  assert.equal(formatHealth(health, { file: 'f', since: '30d', skipped: 1 }), [
    'Harness health, from f, since 30d (1 unreadable rows skipped)',
    'Problems: none at these thresholds.',
    'Signals; n is the sample, and a signal under 5 (telemetry.health.minSample) is not judged:',
    '  Knowledge budget: not enough data; always docs 0 of 16384 bytes, 0 of 0 indexed docs tagged and over 24576 bytes',
    '  Doc reads: not enough data (n=0, needs 5 rows); 0 indexed docs never read, 0 of them tagged',
    '  Agents: not enough data; no dispatches (thresholds: 20% re-dispatched, 10% sent back)',
    '  Reviews: unavailable; gh: not found',
    '  Hook denies: not enough data (n=0, needs 5 sessions); 0 blocks (5 or more by one rule is a hot spot)',
    '  Session cost: not enough data (n=0, needs 5 sessions a half); 0 sessions, $0.00',
    '  Lessons: ok; 0 open, 0 P1; 0 fixes in the window, 0 recurred',
  ].join('\n'));
});

test('every fix the report names is a row of the harness-health skill`s fix table, and the table has no other', () => {
  const rows = [...readFileSync(SKILL, 'utf8').matchAll(/^\| `([a-z-]+)` \|/gmu)].map((match) => match[1]);
  assert.deepEqual([...new Set(rows)].sort(), [...new Set(Object.values(FIXES))].sort());
});

test('aidrian report health prints the page since 30d, --json all of it, takes --prs, and runs gh in the project', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-health-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const dir = path.join(base, 'repo');
  spawnSync('git', ['init', '-q', dir]);
  for (const entry of ['.aidrian', 'docs', '.gitignore']) cpSync(path.join(ROOT, 'examples/consumer', entry), path.join(dir, entry), { recursive: true });
  // A fake gh that answers only in the project folder: no merged pull requests there, a failure anywhere else.
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'gh'), [
    '#!/bin/sh',
    `[ "$(pwd -P)" = "${dir}" ] || { echo "gh ran in $(pwd -P)" >&2; exit 1; }`,
    'case "$1" in pr) echo "[]";; repo) echo \'{"nameWithOwner":"acme/notes"}\';; *) exit 1;; esac',
  ].join('\n'), { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_STATE_HOME: path.join(base, 'state') };
  const report = (args) => spawnSync(CLI, ['report', 'health', ...args, '--project', dir], { cwd: base, env, encoding: 'utf8' });
  const empty = report([]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /^Harness health, from .*dispatch-log\.jsonl, since 30d\nProblems: none at these thresholds\.\n/);
  assert.match(empty.stdout, /\n {2}Reviews: not enough data; rounds not enough data \(n=0, needs 5 reviewed\)/);
  const state = spawnSync(CLI, ['state'], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
  mkdirSync(state, { recursive: true });
  // The fixture rows and a run written before stop rows recorded `sent_back`, moved into the last day so that they fall in any window.
  const legacy = run('planner', 's8', 'p1', { sentBack: true, legacy: true });
  const recent = [...RUN_ROWS, ...SESSION_ROWS, ...DENY_ROWS, ...legacy].map((row) => ({ ...row, ts: new Date(Date.now() - (NOW - Date.parse(row.ts)) / 20).toISOString() }));
  writeFileSync(path.join(state, 'dispatch-log.jsonl'), `${recent.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const text = report(['--prs', '5']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\nPartial: 1 agent runs named a missing file before stop rows recorded send-backs; the share sent back leaves them out\.\n/);
  assert.match(text.stdout, /\n {2}1\. aidrian:explorer: 40% of 10 dispatches repeated a task/);
  const json = JSON.parse(report(['--json', '--since', '7d']).stdout);
  assert.deepEqual(Object.keys(json), ['file', 'rotated', 'since', 'skipped', 'coverage', 'thresholds', 'problems', 'signals']);
  assert.equal(json.coverage.runs_without_send_back, 1);
  assert.equal(json.since, '7d');
  assert.deepEqual(Object.keys(json.signals), ['budget', 'docs', 'agents', 'reviews', 'denies', 'cost', 'lessons']);
  assert.equal(json.signals.reviews.rounds.n, 0);
});
