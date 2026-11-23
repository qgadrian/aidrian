// A review round per reviewed head: a pass `aidrian pr attest` records on a new head opens that head's round, whether
// or not a step dispatched it there (#546).
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordPass } from '../plugins/aidrian/lib/review/run.mjs';
import { readLocalState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { clean, repo } from './review-run-fixture.mjs';

// A repository whose booking flow the code-reviewer agent reviews, with a cap of `maxReviewRounds`.
const booking = (t, github) => repo(t, { baseConfig: { version: 1, github, review: { flows: { booking: { files: ['src/booking/**'] } } } }, change: (write) => write('src/booking/a.js', 'export const a = 0;\n') });
const push = (r, k) => (r.write('src/booking/a.js', `export const a = ${k};\n`), r.commit(`fix ${k}`));
const attest = (r, pass, head) => recordPass(r.project, { pr: 7, repo: 'o/r', pass, head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });

test('seven passes on seven heads, each dispatched by a step, are seven rounds', async (t) => {
  const r = booking(t, { maxReviewRounds: 10 });
  const rounds = [];
  for (let k = 1; k <= 7; k += 1) {
    const step = await r.step({ exec: clean });
    assert.equal(step.status, 'dispatch');
    attest(r, step.dispatch[0].pass, step.head);
    const judged = await r.step({ exec: clean });
    assert.equal(judged.round_kept, undefined, 'a code change keeps no round');
    rounds.push(judged.round);
    push(r, k);
  }
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(readLocalState(r.project, 7).rounds.length, 7);
});

test('seven passes attested on seven heads with no step between are seven rounds', async (t) => {
  const r = booking(t, { maxReviewRounds: 10 });
  const first = await r.step({ exec: clean });
  const pass = first.dispatch[0].pass;
  const rounds = [];
  let head = first.head;
  for (let k = 1; k <= 7; k += 1) {
    attest(r, pass, head);
    const judged = await r.step({ exec: clean });
    assert.equal(judged.status, 'fix_required');
    rounds.push(judged.round);
    head = push(r, k);
  }
  assert.deepEqual(rounds, [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(readLocalState(r.project, 7).rounds.map((round) => round.quiet), Array(7).fill(undefined), 'no round was kept');
});

test('a pass attested on a head past the cap stops at the cap', async (t) => {
  const r = booking(t, { maxReviewRounds: 2, extraRounds: 'off' });
  const first = await r.step({ exec: clean });
  const pass = first.dispatch[0].pass;
  attest(r, pass, first.head);
  assert.equal((await r.step({ exec: clean })).round, 1);
  attest(r, pass, push(r, 1));
  const second = await r.step({ exec: clean });
  assert.deepEqual([second.status, second.round], ['round_limit', 2], 'round 2 is the last: its finding needs a fix past the cap');
  attest(r, pass, push(r, 2));
  const third = await r.step({ exec: clean });
  assert.deepEqual([third.status, third.round, readLocalState(r.project, 7).rounds.length], ['round_limit', 2, 2]);
});

const crashed = async () => ({ status: 'failed', reason: 'crashed' });
// Booking's code-reviewer pass attested clean on `head`, its flow's one invariant held.
const holds = JSON.stringify([{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }]);
const attestClean = (r, pass, head) => recordPass(r.project, { pr: 7, repo: 'o/r', pass, head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holds });

// Booking's code-reviewer pass is dispatched and attested clean on the first head, and the engine's pass of every file
// passes there. A comment push outside the flow is quiet, and the code-reviewer pass is attested clean on it.
test('a quiet push with a pass attested on it keeps the round on its head when another pass fails', async (t) => {
  const r = booking(t, { maxReviewRounds: 10 });
  const first = await r.step({ exec: clean });
  const pass = first.dispatch[0].pass;
  attestClean(r, pass, first.head);
  const judged = await r.step({ exec: clean });
  assert.deepEqual([judged.status, judged.round], ['received', 1]);
  r.write('src/app.js', '// the app number\nexport const app = 1;\n');
  const pushed = r.commit('a comment');
  attestClean(r, pass, pushed);
  const failed = await r.step({ exec: crashed });
  assert.deepEqual([failed.status, failed.round, failed.round_kept?.from], ['incomplete', 1, first.head], 'the output still names the kept round');
  const [round, ...more] = readLocalState(r.project, 7).rounds;
  assert.deepEqual([round.head, round.quiet?.map((each) => each.from), more.length], [pushed, [first.head], 0], 'the attested pass is a review of the new head');
});

// A plan command's one stage of two exec passes of two files. An exec pass is never dispatched, so its attest records
// no file list, and the step does not use that result for a pass with one: the pass runs again.
test('a pass attested on a head with other file coverage gives the round back when another pass fails', async (t) => {
  const planner = "let s='';const F=['docs/guide.md','src/app.js'];process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec',files:F},{id:'extra:types',reviewer:'types',kind:'exec',files:F}]}]})))";
  const reviewer = { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' };
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs', reviewers: { lint: reviewer, types: reviewer } } },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    change: (write) => write('src/app.js', 'export const app = 2;\n'),
  });
  const first = await r.step({ exec: clean });
  assert.deepEqual([first.status, first.round], ['received', 1]);
  r.write('src/app.js', 'export const app = 3;\n');
  const pushed = r.commit('a fix');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'extra:lint', head: pushed, reviewer: 'lint', findings: 0, fixed: 0 });
  assert.equal(readLocalState(r.project, 7).passes['extra:lint'].files, null, 'the attested result covers no file list');
  const failed = await r.step({ exec: crashed });
  assert.equal(failed.status, 'incomplete');
  assert.deepEqual(readLocalState(r.project, 7).rounds.map((round) => round.head), [first.head], 'no usable result on the new head: no round opens');
});
