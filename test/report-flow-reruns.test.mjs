import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { addCosts, GROUPS, readCheckout, readRecords, reportLines, reviewerRuns, sortReruns, totals } from '../scripts/report-flow-reruns.mjs';

const PASS = 'agent:product-manager:booking';
const WIDER = `${PASS}+sign-in`;
const FILES = ['src/booking/a.mjs', 'src/booking/b.mjs'];
// A checkout whose heads differ by `changes`, with a merge commit in each range of `merged`.
const checkout = (changes = {}, merged = []) => ({
  changed: (from, to) => changes[`${from}..${to}`] ?? [],
  merges: (from, to) => (merged.includes(`${from}..${to}`) ? 1 : 0),
});
const finding = (id = 'R1-1', pass = PASS) => ({ id, pass, title: 'A finding', severity: 'medium' });
const round = (head, findings = [], at = `2026-11-0${head.at(-1)}T10:00:00.000Z`) => ({ head, at, open: findings.length, findings });
// A record whose last round, at `h2`, the pass answered, over the delta from its result at `h1` that its dispatch names.
const record = (over = {}) => ({
  pr: 7, repo: 'o/r', updatedAt: '2026-11-09T10:00:00.000Z', rounds: [round('h1'), round('h2')],
  passes: { [PASS]: { head: 'h2', reviewer: 'product-manager', files: FILES } }, dispatched: { [PASS]: { head: 'h2', files: FILES, base: 'h1', listed: [] } }, ...over,
});
const withNote = (over) => ({ dispatched: { [PASS]: { head: 'h2', files: FILES, base: 'h1', listed: [], ...over } } });
// The same pass's earlier run under another id, over other files, and no delta between the two.
const regrouped = (files) => record({ ...withNote({ base: 'merge-base' }), passes: { ...record().passes, [WIDER]: { head: 'h1', files } } });
const only = (rec, co = checkout()) => {
  const { reruns } = sortReruns(rec, co);
  assert.equal(reruns.length, 1);
  return reruns[0];
};

test('a round of each kind goes to its own group, the first that holds, and the one a merge may explain to none', () => {
  const cases = [
    ['open finding', record({ rounds: [round('h1', [finding()]), round('h2')] }), checkout({ 'h1..h2': [FILES[0]] })],
    ['open finding', record(withNote({ listed: ['R1-1'] })), checkout()],
    ['files touched', record(), checkout({ 'h1..h2': [FILES[0]] })],
    ['files touched', record(), checkout({ 'h1..h2': [FILES[0]] }, ['h1..h2'])],
    ['file list changed', regrouped([FILES[0]]), checkout({ 'h1..h2': ['docs/x.md'] })],
    ['none of these', record(), checkout({ 'h1..h2': ['docs/x.md'] })],
  ];
  for (const [group, rec, co] of cases) assert.equal(only(rec, co).group, group);
  assert.deepEqual(new Set(cases.map(([group]) => group)), new Set(GROUPS));
  // A resolution that keeps the pull request's side changes no file of the pass, and the engine still re-runs the pass.
  const merge = only(record(), checkout({ 'h1..h2': ['src/from-main.mjs'] }, ['h1..h2']));
  assert.deepEqual([merge.group, merge.unread], [undefined, 'a merge since: its resolution or the base may be the cause']);
  const reruns = [...cases.map(([, rec, co]) => only(rec, co)), merge];
  assert.deepEqual(totals(reruns).map(({ group, count }) => [group, count]), [['open finding', 2], ['files touched', 2], ['file list changed', 1], ['none of these', 1]]);
  assert.equal(totals(reruns)[3].share, 1 / 6, 'a share is of the sorted re-runs');
});

test('a file the pass does not cover is no touch, and a finding of another reviewer is owed nothing', () => {
  assert.equal(only(record(), checkout({ 'h1..h2': ['src/booking/from-main.mjs'] })).group, 'none of these');
  for (const other of ['agent:code-reviewer', 'agent:security-engineer:booking', null]) {
    assert.equal(only(record({ rounds: [round('h1', [finding('R1-1', other)]), round('h2')] })).group, 'none of these', other);
  }
  const shared = record({ rounds: [round('h1', [finding('R1-1', WIDER)]), round('h2')] });
  assert.equal(sortReruns(shared, checkout()).reruns.find(({ pass }) => pass === PASS).group, 'open finding', 'a pass of the reviewer that shares a flow');
});

test('only a run the record shows is one: a carried finding and a round with no result are not', () => {
  const carried = record({ rounds: [round('h1', [finding()]), round('h2', [finding()]), round('h3', [finding(), finding('R3-2')])], passes: {}, dispatched: {} });
  assert.deepEqual(sortReruns(carried, checkout()).reruns.map((each) => [each.round, each.group ?? each.unread]), [
    [3, 'open finding'], [2, 'only an open finding, which may be carried'],
  ]);
  assert.equal(sortReruns(carried, checkout()).first, 1);
  // With no result at h1, the round before says nothing of a run there: it may be a first run.
  const bare = record(withNote({ base: 'merge-base' }));
  assert.match(only(bare).unread, /may be a first run/u);
  assert.deepEqual(sortReruns(record({ rounds: [round('h1')], passes: { [PASS]: { head: 'h1', files: FILES } }, dispatched: {} }), checkout()), { reruns: [], first: 1 });
  // A finding of a round a quiet push moved says not at which of its heads the pass ran.
  const quiet = record({ rounds: [{ ...round('h3', [finding()]), quiet: [{ from: 'h1' }] }, round('h2')], ...withNote({ base: 'merge-base' }) });
  assert.deepEqual(sortReruns(quiet, checkout()).reruns.map(({ unread }) => Boolean(unread)), [true, true]);
});

test('what the record or git cannot say is sorted in no group', () => {
  const unread = (rec, co) => only(rec, co).unread;
  const three = [round('h1', [finding()]), round('h2'), round('h3')];
  const apart = { rounds: three, passes: { [PASS]: { head: 'h3', files: FILES } }, dispatched: {} };
  assert.match(unread(record(apart)), /may lie between/u, 'two rounds apart, with no delta named');
  assert.match(unread(record({ ...apart, rounds: [three[0], round('h3')] }), checkout({ 'h1..h3': [FILES[0]] })) ?? 'sorted', /sorted/u, 'one round apart, the finding is owed');
  const { findings, ...bare } = round('h1');
  assert.match(unread(record({ rounds: [bare, round('h2')], ...withNote({ listed: undefined }) })), /keeps no findings/u);
  assert.match(unread(record({ passes: { [PASS]: { head: 'h2' } } })), /keeps no file list/u);
  assert.match(unread(regrouped(FILES)), /which files the pass covered before/u, 'an equal list is no proof of one list');
  const broken = { changed: () => { throw new Error('bad object'); }, merges: () => 0 };
  assert.match(unread(record(), broken), /git cannot read/u);
  assert.throws(() => readCheckout(path.join(tmpdir(), 'no-such-folder')).merges('a', 'b'), /git cannot count the merges/u);
});

test('the report says what is a floor and what is an estimate, beside its counts', () => {
  const reruns = [only(record()), only(record(), checkout({}, ['h1..h2']))];
  const lines = reportLines({ reviewer: 'product-manager', records: 3, withPass: 2, reruns, first: 1, groups: totals(reruns) });
  assert.match(lines[0], /1 re-runs sorted, 1 not sorted, and 1 runs in a first round, on 2 of 3 review records/u);
  assert.match(lines[1], /^a floor: /u);
  assert.match(lines[2], /^estimates: /u);
  assert.ok(lines.includes('  1\ta merge since: its resolution or the base may be the cause'));
  assert.ok(lines.includes('none of these\t1\t100%\t$0.00 over 0\t-'));
  assert.ok(lines.includes(`none of these\t#7\tround 2\t${PASS}\th1..h2`));
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
