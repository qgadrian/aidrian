import assert from 'node:assert/strict';
import test from 'node:test';

import { blocks, parseFindings } from '../plugins/aidrian/lib/review/findings.mjs';
import { stderrTail } from '../plugins/aidrian/lib/review/run.mjs';

const finding = (over) => ({ title: 'Button text overflows at 360px', file: 'src/app/x.tsx', line: 4, severity: 'high', likelihood: 'routine', affects: 'users', state: 'open', ...over });

test('parseFindings: the disposition table decides which findings still block', () => {
  const result = parseFindings(JSON.stringify({ findings: [
    finding({}),
    finding({ state: 'fixed' }),
    finding({ state: 'accepted', severity: 'low', likelihood: 'contrived', affects: 'internal' }),
    finding({ state: 'accepted' }),
    finding({ state: 'open', likelihood: undefined, affects: undefined }),
  ] }));
  assert.equal(result.findings, 5);
  assert.equal(result.fixed, 1);
  const decided = result.list.map((each) => [each.state, each.disposition, blocks(each)]);
  assert.equal(decided[0][2], true, 'an open finding that is not acceptable as-is blocks');
  assert.equal(decided[1][2], false, 'a fixed finding never blocks');
  assert.notEqual(decided[2][1], 'fix_now');
  assert.equal(decided[2][2], false, 'a low, contrived, internal finding may be accepted');
  assert.equal(decided[3][1], 'fix_now');
  assert.equal(decided[3][2], true, 'a fix_now finding cannot be accepted');
  assert.equal(decided[4][1], 'needs_axis');
  assert.equal(decided[4][2], true, 'a finding with no axes blocks until it is classified');
  assert.equal(result.open, 3);
  assert.equal(result.findings - result.fixed - result.accepted, result.open);
});

test('parseFindings: a malformed file is refused, never read as zero findings', () => {
  assert.throws(() => parseFindings('nope'), /must be a JSON file/u);
  assert.throws(() => parseFindings('{"items":[]}'), /list of findings/u);
  assert.throws(() => parseFindings(JSON.stringify([{ state: 'open' }])), /needs a title/u);
  assert.throws(() => parseFindings(JSON.stringify([{ title: 'x', state: 'done' }])), /state must be/u);
  assert.throws(() => parseFindings(JSON.stringify([finding({ likelihood: 'likely' })])), /invalid likelihood/u);
  assert.deepEqual(parseFindings('[]'), { list: [], findings: 0, fixed: 0, accepted: 0, open: 0 });
});

test('stderrTail: the last lines, not only the runtime version, with tokens masked', () => {
  const stderr = 'file:///x/plan.mjs:9\n    throw new Error(boom)\n\nError: config missing for ghp_abcdefghijklmnop1234\n    at main (plan.mjs:9:11)\n\nNode.js v24.1.0\n';
  const tail = stderrTail(stderr);
  assert.match(tail, /Error: config missing/u);
  assert.match(tail, /Node\.js v24\.1\.0$/u);
  assert.doesNotMatch(tail, /ghp_/u);
  assert.ok(stderrTail('x'.repeat(5000)).length <= 803);
});
