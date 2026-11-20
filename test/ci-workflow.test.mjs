import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

// The slowest Check job that passed before its timeout was raised: Node 24 in 9m57s, in November 2026.
// Raise it when a slower pass is measured; the timeout keeps twice it, so load on the runner never cancels a pass.
const SLOWEST_PASS_MINUTES = 10;

async function ciWorkflow() {
  const { parse } = await import('yaml');
  return parse(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
}

// The step that runs the whole suite: a line of its run text is exactly `npm run check`.
function suiteSteps(check) {
  return check.steps.filter((step) => String(step.run ?? '').split('\n').some((line) => line.trim() === 'npm run check'));
}

function assertSuiteHasTime(check) {
  assert.ok(Number.isInteger(check['timeout-minutes']), 'the check job sets its own timeout');
  assert.ok(check['timeout-minutes'] >= 2 * SLOWEST_PASS_MINUTES, `timeout-minutes ${check['timeout-minutes']} is under ${2 * SLOWEST_PASS_MINUTES}`);
  for (const step of check.steps) {
    const minutes = step['timeout-minutes'];
    if (minutes === undefined) continue;
    assert.ok(minutes >= 2 * SLOWEST_PASS_MINUTES, `${step.name}: step timeout-minutes ${minutes} cuts the suite off before ${2 * SLOWEST_PASS_MINUTES}`);
  }
}

function assertRunsTheSuite(check) {
  assert.equal(suiteSteps(check).length, 1, 'the check job has one step that runs npm run check');
}

test('ci.yml gives the check job twice its slowest measured pass to finish', async () => {
  assertSuiteHasTime((await ciWorkflow()).jobs.check);
});

test('a step deadline under the margin fails the timeout test', async () => {
  const { check } = (await ciWorkflow()).jobs;
  const [suite] = suiteSteps(check);
  suite['timeout-minutes'] = SLOWEST_PASS_MINUTES;
  assert.throws(() => assertSuiteHasTime(check), /cuts the suite off/);
});

test('ci.yml runs the whole suite in the check job', async () => {
  assertRunsTheSuite((await ciWorkflow()).jobs.check);
});

test('a check job without the suite step fails the suite test', async () => {
  const { check } = (await ciWorkflow()).jobs;
  check.steps = check.steps.filter((step) => !suiteSteps({ steps: [step] }).length);
  assert.throws(() => assertRunsTheSuite(check), /runs npm run check/);
});

test('ci.yml never reads a cancelled or failed check as a pass', async () => {
  const { check } = (await ciWorkflow()).jobs;
  assert.equal(check['continue-on-error'], undefined, 'the job fails when a step fails');
  assert.equal(check.if, undefined, 'the job runs on every event, never skipped into a pass');
  assert.equal(check.strategy['fail-fast'], false, 'one Node version failing still runs the others to their own verdict');
  for (const step of check.steps) {
    assert.equal(step['continue-on-error'], undefined, `${step.name}: a failing step fails the job`);
    assert.equal(step.if, undefined, `${step.name}: runs only after every step before it passed`);
  }
});
