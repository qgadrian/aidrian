import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addCosts, GROUPS, readRecords, reviewerRuns, sortReruns, totals } from '../scripts/report-flow-reruns.mjs';

const PASS = 'agent:product-manager:booking';
const FILES = ['src/booking/a.mjs', 'src/booking/b.mjs'];
// A checkout whose plan at each head is `plans[head]`, over the base `main1` and FILES, and whose heads differ by `changes`.
const checkout = (plans = {}, changes = {}, apart = []) => ({
  plan: (head) => (plans[head] === null ? null : { base: 'main1', files: [...FILES, 'docs/x.md'], passes: [{ id: PASS, files: FILES }], ...plans[head] }),
  changed: (from, to) => changes[`${from}..${to}`] ?? [],
  isAncestor: (from, to) => !apart.includes(`${from}..${to}`),
});
const finding = (pass = PASS) => ({ id: 'R1-1', pass, title: 'A finding', severity: 'medium' });
const round = (head, findings = [], at = `2026-11-0${head.at(-1)}T10:00:00.000Z`) => ({ head, at, open: findings.length, findings });
// A record whose last round, at `to`, the pass answered, after a round at `h1`.
const record = (over = {}) => ({
  pr: 7, repo: 'o/r', updatedAt: '2026-11-09T10:00:00.000Z', rounds: [round('h1'), round('h2')],
  passes: { [PASS]: { head: 'h2', reviewer: 'product-manager', files: FILES } }, ...over,
});
const only = (rec, co) => {
  const { reruns } = sortReruns(rec, co);
  assert.equal(reruns.length, 1);
  return reruns[0];
};

test('a round of each kind goes to its own group, the first that holds', () => {
  const cases = [
    ['open finding', record({ rounds: [round('h1', [finding()]), round('h2')] }), checkout({}, { 'h1..h2': [FILES[0]] })],
    ['open finding', record({ dispatched: { [PASS]: { head: 'h2', files: FILES, listed: ['R1-1'] } } }), checkout()],
    ['files touched', record(), checkout({}, { 'h1..h2': [FILES[0]] })],
    ['file list changed', record(), checkout({ h1: { passes: [{ id: PASS, files: [FILES[0]] }] } }, { 'h1..h2': ['docs/x.md'] })],
    ['file list changed', record(), checkout({ h1: { passes: [{ id: `${PASS}+sign-in`, files: FILES }] } })],
    ['base merged', record(), checkout({ h1: { base: 'main0' } }, { 'h1..h2': ['docs/x.md', 'src/other.mjs'] })],
    ['none of these', record(), checkout({}, { 'h1..h2': ['docs/x.md'] })],
  ];
  for (const [group, rec, co] of cases) assert.equal(only(rec, co).group, group);
  assert.deepEqual(new Set(cases.map(([group]) => group)), new Set(GROUPS));
  const reruns = cases.map(([, rec, co]) => only(rec, co));
  assert.deepEqual(totals(reruns).map(({ group, count }) => [group, count]), [['open finding', 2], ['files touched', 1], ['file list changed', 2], ['base merged', 1], ['none of these', 1]]);
  assert.equal(totals(reruns)[4].share, 1 / 7);
});

test('a file the base brought in alone is no touch, and a finding of another pass is owed nothing', () => {
  assert.equal(only(record(), checkout({}, { 'h1..h2': ['src/booking/from-main.mjs'] })).group, 'none of these');
  for (const other of ['agent:code-reviewer', 'agent:security-engineer:booking', null]) {
    assert.equal(only(record({ rounds: [round('h1', [finding(other)]), round('h2')] }), checkout()).group, 'none of these', other);
  }
  assert.equal(only(record({ rounds: [round('h1', [finding(`${PASS}+sign-in`)]), round('h2')] }), checkout()).group, 'open finding', 'a pass of the reviewer that shares a flow');
  assert.equal(only(record(), checkout({}, {}, ['h1..h2'])).rewritten, true, 'a rewritten branch is named');
  const both = only(record(), checkout({ h1: { base: 'main0', passes: [{ id: PASS, files: [FILES[0]] }] } }, { 'h1..h2': [FILES[1]] }));
  assert.deepEqual([both.group, both.list, both.base], ['files touched', true, true], 'a later group that holds too is told');
});

test('a first run is no re-run, and what the record or git cannot say is sorted in no group', () => {
  const untouched = { h1: { passes: [] } };
  assert.deepEqual(sortReruns(record(), checkout(untouched)), { reruns: [], first: 1, lists: { compared: 1, equal: 1 } });
  const first = record({ rounds: [round('h1')], passes: { [PASS]: { head: 'h1', files: FILES } } });
  assert.deepEqual(sortReruns(first, checkout()), { reruns: [], first: 1, lists: { compared: 1, equal: 1 } });
  assert.match(only(record(), checkout({ h2: null })).unread, /cannot be rebuilt/u);
  const { findings, ...bare } = round('h1');
  assert.match(only(record({ rounds: [bare, round('h2')] }), checkout()).unread, /keeps no findings/u);
  assert.match(only(record(), checkout({ h2: { passes: [] } })).unread, /lacks the pass/u);
  assert.equal(sortReruns(record({ passes: {}, rounds: [round('h1', [finding('agent:code-reviewer')])] }), checkout()).first, 0);
});

test('a round is found by a pass result, by a finding left open, and by the heads its findings were seen and fixed at', () => {
  const rounds = [round('h1', [finding()]), round('h2', [finding()]), round('h3'), { ...round('h5'), quiet: [{ from: 'h4' }] }];
  const rec = record({ rounds, passes: { [PASS]: { head: 'h4', files: FILES } }, index: { 'R1-1': { pass: PASS, seen: 'h1', state: 'fixed', closed_in: { from: 'h1', to: 'h3' } } } });
  assert.deepEqual(sortReruns(rec, checkout()).reruns.map((each) => [each.round, each.from, each.to]), [[2, 'h1', 'h2'], [3, 'h2', 'h3'], [4, 'h3', 'h4']]);
});

test('a re-run costs what its run spent since its agent stopped before, and a run answers one re-run', () => {
  const dispatch = (agent_id, description) => ({ event: 'dispatch', agent_id, description, agent_type: 'aidrian:product-manager' });
  const stop = (agent_id, ts, cost_usd, session_id = 's1') => ({ event: 'stop', agent_id, ts, cost_usd, session_id, agent_type: 'aidrian:product-manager' });
  const runs = reviewerRuns([
    dispatch('a', 'Product review of PR 700'), dispatch('b', 'Judge residuals of PR 700'), dispatch('c', 'PR 800 product review'), dispatch('d', 'Re-check the fix'),
    stop('a', '2026-11-01T10:05:00.000Z', 2), stop('b', '2026-11-02T10:01:00.000Z', 9), stop('c', '2026-11-02T10:02:00.000Z', 9), stop('a', '2026-11-02T10:05:00.000Z', 2.5),
    stop('d', '2026-11-03T10:05:00.000Z', 1, 's2'), { ...stop('e', '2026-11-02T10:00:30.000Z', 9), agent_type: 'aidrian:code-reviewer' },
  ], 'product-manager');
  const rec = record({ pr: 700, rounds: [round('h1'), round('h2'), round('h3'), round('h4')] });
  const reruns = [2, 3, 4].map((each) => ({ pr: 700, repo: 'o/r', round: each, group: 'files touched' }));
  addCosts(reruns, [rec], runs, (session, { pr }) => session === 's2' && pr === 700);
  assert.deepEqual(reruns.map(({ cost }) => cost), [0.5, 1, undefined]);
  // A quiet push moved the round's `at` past the run that answered its first head.
  const quiet = record({ pr: 700, rounds: [round('h1'), { ...round('h3'), quiet: [{ from: 'h2', at: round('h2').at }] }] });
  const moved = [{ pr: 700, repo: 'o/r', round: 2, group: 'files touched' }];
  addCosts(moved, [quiet], runs.filter(({ agent }) => agent === 'a'), () => false);
  assert.equal(moved[0].cost, 0.5);
  const firstRound = [{ pr: 700, repo: 'o/r', round: 1, group: 'files touched' }];
  addCosts(firstRound, [quiet], runs.filter(({ agent, cost }) => agent === 'a' && cost === 0.5), () => false);
  assert.equal(firstRound[0].cost, undefined, 'nor does the round before it end at the moved time');
  const [touched] = totals(reruns).filter(({ group }) => group === 'files touched');
  assert.deepEqual([touched.count, touched.costed, touched.cost], [3, 2, 1.5]);
});

test('readRecords reads one record a pull request and repository, the latest written, and skips what is no review record', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-reruns-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'reviews'));
  const write = (name, value) => writeFileSync(path.join(dir, 'reviews', name), typeof value === 'string' ? value : JSON.stringify(value));
  write('pr-7-review.json', record({ updatedAt: '2026-11-01T00:00:00.000Z' }));
  write('pr-7-review-o--r.json', record({ updatedAt: '2026-11-02T00:00:00.000Z' }));
  write('pr-8-review-o--r.json', record({ pr: 8 }));
  write('pr-9.json', { pr: 9, reviewer: 'x', findings: [] });
  write('pr-10-review.json', '{');
  write('other.json', record({ pr: 11 }));
  assert.deepEqual(readRecords(dir).map(({ pr, updatedAt }) => [pr, updatedAt.slice(0, 10)]).sort(), [[7, '2026-11-02'], [8, '2026-11-09']]);
});
