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

test('ci.yml gives the check job twice its slowest measured pass to finish', async () => {
  const { check } = (await ciWorkflow()).jobs;
  assert.ok(Number.isInteger(check['timeout-minutes']), 'the check job sets its own timeout');
  assert.ok(check['timeout-minutes'] >= 2 * SLOWEST_PASS_MINUTES, `timeout-minutes ${check['timeout-minutes']} is under ${2 * SLOWEST_PASS_MINUTES}`);
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
