import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

// .github/workflows/ci.yml, read as YAML.
async function ciWorkflow() {
  const { parse } = await import('yaml');
  return parse(readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'));
}

// The `Check (Node N)` names this repository's .aidrian/config.json requires.
function requiredCheckNames() {
  const config = JSON.parse(readFileSync(path.join(ROOT, '.aidrian/config.json'), 'utf8'));
  return config.github.requiredChecks.filter((name) => /^Check \(Node \d+\)$/u.test(name));
}

// A job's name with ${{ matrix.<key> }} replaced from `values`.
const expand = (name, values) => name.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/gu, (_, key) => String(values[key]));

// Every result GitHub gives a needed job.
const RESULTS = ['success', 'failure', 'cancelled', 'skipped'];

// Each way to give every name one of RESULTS: 4 ** names.length objects.
const combinations = (names) => names.reduce((sets, name) => sets.flatMap((set) => RESULTS.map((result) => ({ ...set, [name]: result }))), [{}]);

test('Check (Node N) waits for every other job, and its step passes only when every one succeeded', async () => {
  const { jobs } = await ciWorkflow();
  const { check } = jobs;
  const others = Object.keys(jobs).filter((id) => id !== 'check');
  assert.deepEqual([...check.needs].sort(), others.sort(), 'check needs every other job');
  assert.equal(check.if, 'always()', 'a failed or cancelled job fails check instead of skipping it');
  assert.deepEqual(check.permissions, {}, 'check reads results only, with no token');
  assert.equal(check.steps.length, 1);
  const [step] = check.steps;
  const variables = others.map((id) => {
    const variable = Object.entries(step.env ?? {}).find(([, value]) => value === `\${{ needs.${id}.result }}`)?.[0];
    assert.ok(variable, `the step reads needs.${id}.result through env`);
    return variable;
  });
  // As GitHub runs a run: body with shell bash.
  for (const results of combinations(variables)) {
    const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], { env: { PATH: process.env.PATH, ...results }, encoding: 'utf8' });
    const passes = Object.values(results).every((result) => result === 'success');
    assert.equal(run.status, passes ? 0 : 1, `${JSON.stringify(results)}: ${run.stdout}${run.stderr}`);
  }
});

test('npm run check is the static checks and the tests, and CI runs the same two', async () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.check, 'npm run check:static && npm test');
  const { jobs } = await ciWorkflow();
  const runs = jobs.static.steps.filter((step) => step.run !== undefined).map((step) => step.run.trim());
  assert.deepEqual(runs.filter((run) => run !== 'npm ci'), ['npm run check:static'], 'static runs npm run check:static, once');
  assert.ok(jobs.test.steps.some((step) => /^npm test -- /u.test(step.run ?? '')), 'test runs npm test');
});

test('the Check names over matrix.node are the Check (Node N) checks .aidrian/config.json requires', async () => {
  const { jobs } = await ciWorkflow();
  const names = jobs.check.strategy.matrix.node.map((node) => expand(jobs.check.name, { node }));
  assert.deepEqual(names.sort(), requiredCheckNames().sort());
  for (const id of Object.keys(jobs)) assert.deepEqual(jobs[id].strategy.matrix.node, jobs.check.strategy.matrix.node, `${id} runs every Node version`);
});

test('the test shards are 1..N, and N is the total in the job name and in --test-shard', async () => {
  const { jobs } = await ciWorkflow();
  const { test: tests } = jobs;
  const shards = tests.strategy.matrix.shard;
  const total = shards.length;
  assert.deepEqual(shards, Array.from({ length: total }, (_, at) => at + 1));
  assert.match(tests.name, new RegExp(`\\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)$`, 'u'), 'the job name carries the total');
  const runs = tests.steps.filter((step) => /--test-shard/u.test(step.run ?? ''));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].env?.SHARD, '${{ matrix.shard }}');
  assert.match(runs[0].run, new RegExp(`^npm test -- --test-shard="\\$SHARD/${total}"$`, 'u'));
});

test('ci.yml pins every action by its commit, keeps no credentials, and puts no expression in a run: body', async () => {
  const { jobs } = await ciWorkflow();
  for (const [id, job] of Object.entries(jobs)) {
    for (const step of job.steps) {
      const label = `${id}: ${step.name}`;
      assert.doesNotMatch(step.run ?? '', /\$\{\{/u, label);
      if (!step.uses) continue;
      assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${label}: pinned by commit`);
      if (/^actions\/checkout@/u.test(step.uses)) assert.equal(step.with?.['persist-credentials'], false, label);
    }
  }
});
