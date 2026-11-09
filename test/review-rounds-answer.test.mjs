import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, OVERRIDE_REASON } from '../plugins/aidrian/lib/rules/github/review-rounds.mjs';

function setup(t, answers) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-rounds-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { reviewer: 'bot[bot]' } }));
  const file = path.join(dir, 't.jsonl');
  writeFileSync(file, answers.map((one) => JSON.stringify({ type: 'user', toolUseResult: { answers: one } })).join('\n'));
  return { cwd: dir, input: { transcript_path: file } };
}

test('the round override runs only as the exact raise the Human approved in the session', (t) => {
  const context = setup(t, [{ 'Raise the cap on #12 to --max-rounds 4?': 'Approve (Recommended)' }]);
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4', context), null);
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 12 --request --max-rounds 4', context), null);
  for (const command of [
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 5',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 1 --max-rounds 4',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds "$N"',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr attest 12 --max-rounds 4',
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 npm test',
    'export AIDRIAN_ALLOW_EXTRA_ROUNDS=1',
  ]) assert.equal(check(command, context), OVERRIDE_REASON, command);
});

test('with no Approve answer the round override stays denied', (t) => {
  const command = 'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 12 --max-rounds 4';
  assert.equal(check(command, setup(t, [{ 'Raise the cap on #12 to --max-rounds 4?': 'Deny' }])), OVERRIDE_REASON);
  assert.equal(check(command, setup(t, [])), OVERRIDE_REASON);
});
