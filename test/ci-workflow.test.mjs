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

// Every step whose run text names `npm run check`, however it wraps it; assertRunsTheSuite then pins the one to the bare command.
function suiteSteps(check) {
  return check.steps.filter((step) => String(step.run ?? '').includes('npm run check'));
}

// Only the job and the suite step must outlast the slowest pass. A setup step, such as checkout or npm ci,
// finishes before the suite starts and its own deadline never shortens the suite's, so this ignores it:
// a short deadline there fails that step on its own, and the job timeout above still bounds the whole run.
function assertSuiteHasTime(check) {
  assert.ok(Number.isInteger(check['timeout-minutes']), 'the check job sets its own timeout');
  assert.ok(check['timeout-minutes'] >= 2 * SLOWEST_PASS_MINUTES, `timeout-minutes ${check['timeout-minutes']} is under ${2 * SLOWEST_PASS_MINUTES}`);
  for (const step of suiteSteps(check)) {
    const minutes = step['timeout-minutes'];
    if (minutes === undefined) continue;
    assert.ok(minutes >= 2 * SLOWEST_PASS_MINUTES, `${step.name}: step timeout-minutes ${minutes} cuts the suite off before ${2 * SLOWEST_PASS_MINUTES}`);
  }
}

// The suite step runs `npm run check` alone, so no shell operator, condition, or later command can skip or swallow it,
// and nothing outside the shell can skip it or turn its failure into a pass.
function assertRunsTheSuite(check) {
  const steps = suiteSteps(check);
  assert.equal(steps.length, 1, 'the check job has one step that runs npm run check');
  const [suite] = steps;
  assert.equal(String(suite.run).trim(), 'npm run check', `${suite.name}: the step runs npm run check alone, not ${JSON.stringify(suite.run)}`);
  assert.equal(suite.if, undefined, `${suite.name}: the suite step has no if, so it is never skipped`);
  assert.equal(suite['continue-on-error'], undefined, `${suite.name}: the suite step has no continue-on-error, so its failure fails the job`);
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

test('a setup step deadline under the margin passes the timeout test', async () => {
  const { check } = (await ciWorkflow()).jobs;
  const setup = check.steps.filter((step) => !suiteSteps({ steps: [step] }).length);
  assert.ok(setup.length > 0, 'the check job has setup steps before the suite');
  for (const step of setup) step['timeout-minutes'] = 5;
  assertSuiteHasTime(check);
});

test('ci.yml runs the whole suite in the check job', async () => {
  assertRunsTheSuite((await ciWorkflow()).jobs.check);
});

test('a check job without the suite step fails the suite test', async () => {
  const { check } = (await ciWorkflow()).jobs;
  check.steps = check.steps.filter((step) => !suiteSteps({ steps: [step] }).length);
  assert.throws(() => assertRunsTheSuite(check), /runs npm run check/);
});

for (const run of ['npm run check || true', 'false && npm run check', 'if false; then\n  npm run check\nfi\n', 'npm run check\ntrue\n']) {
  test(`a suite step whose run is ${JSON.stringify(run)} fails the suite test`, async () => {
    const { check } = (await ciWorkflow()).jobs;
    suiteSteps(check)[0].run = run;
    assert.throws(() => assertRunsTheSuite(check), /runs npm run check alone/);
  });
}

test('a suite step with surrounding whitespace passes the suite test', async () => {
  const { check } = (await ciWorkflow()).jobs;
  suiteSteps(check)[0].run = '\n  npm run check  \n';
  assertRunsTheSuite(check);
});

for (const [key, value, message] of [
  ['if', "github.event_name == 'push'", /never skipped/],
  ['continue-on-error', true, /its failure fails the job/],
]) {
  test(`a suite step with ${key} fails the suite test`, async () => {
    const { check } = (await ciWorkflow()).jobs;
    suiteSteps(check)[0][key] = value;
    assert.throws(() => assertRunsTheSuite(check), message);
  });
}

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
