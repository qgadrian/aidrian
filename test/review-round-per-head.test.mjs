// A review round per reviewed head: a pass `aidrian pr attest` records on a new head opens that head's round, whether
// or not a step dispatched it there (#546).
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { recordPass } from '../plugins/aidrian/lib/review/run.mjs';
import { readLocalState } from '../plugins/aidrian/lib/review/state.mjs';
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
