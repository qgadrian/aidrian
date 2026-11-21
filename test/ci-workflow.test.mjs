import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// The names of a job's records: its upload step's name over every combination of its matrix.
function recordNames(job) {
  const upload = job.steps.find((step) => /^actions\/upload-artifact@/u.test(step.uses ?? ''));
  const { matrix } = job.strategy;
  const sets = Object.keys(matrix).reduce((all, key) => all.flatMap((set) => matrix[key].map((value) => ({ ...set, [key]: value }))), [{}]);
  return sets.map((values) => expand(upload.with.name, values));
}

test('Check (Node N) waits for every other job, and passes only when every one succeeded and left its record', async (t) => {
  const { jobs } = await ciWorkflow();
  const { check } = jobs;
  const others = Object.keys(jobs).filter((id) => id !== 'check');
  assert.deepEqual([...check.needs].sort(), others.sort(), 'check needs every other job');
  assert.equal(check.if, 'always()', 'a failed or cancelled job fails check instead of skipping it');
  assert.deepEqual(check.permissions, {}, 'check reads results and records only, with no token');
  assert.equal(check.steps.length, 2);
  const step = check.steps[1];
  const variables = others.map((id) => {
    const variable = Object.entries(step.env ?? {}).find(([, value]) => value === `\${{ needs.${id}.result }}`)?.[0];
    assert.ok(variable, `the step reads needs.${id}.result through env`);
    return variable;
  });
  // The step names shell: bash, so GitHub runs its body as below; with no shell it runs bash -e, without pipefail.
  assert.equal(step.shell, 'bash', 'the step runs with shell: bash');
  // Every record, as the download step leaves them: each in a folder of its own name.
  const passed = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ci-records-')));
  t.after(() => rmSync(passed, { recursive: true, force: true }));
  const records = step.env.RECORDS.split(/\s+/u);
  const record = (name) => path.join(passed, name, 'passed');
  for (const name of records) {
    mkdirSync(path.dirname(record(name)));
    writeFileSync(record(name), 'passed\n');
  }
  const run = (results) => spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], { env: { PATH: process.env.PATH, ...results, PASSED: passed, RECORDS: step.env.RECORDS }, encoding: 'utf8' });
  for (const results of combinations(variables)) {
    const ran = run(results);
    const passes = Object.values(results).every((result) => result === 'success');
    assert.equal(ran.status, passes ? 0 : 1, `${JSON.stringify(results)}: ${ran.stdout}${ran.stderr}`);
  }
  // A result of success with one record missing, as a job cancelled before a runner took it leaves it, fails the check.
  const succeeded = Object.fromEntries(variables.map((variable) => [variable, 'success']));
  for (const name of records) {
    rmSync(record(name));
    const ran = run(succeeded);
    assert.equal(ran.status, 1, `${name}: ${ran.stdout}${ran.stderr}`);
    assert.match(ran.stdout, new RegExp(`^No record of ${name}: that job did not pass, or never ran\\.$`, 'mu'));
    writeFileSync(record(name), 'passed\n');
  }
});

test('every other job uploads its record last, only when every step before it passed, and Check looks for each', async () => {
  const { jobs } = await ciWorkflow();
  const others = Object.keys(jobs).filter((id) => id !== 'check');
  const expected = others.flatMap((id) => {
    const { steps } = jobs[id];
    const [write, upload] = steps.slice(-2);
    assert.match(upload.uses ?? '', /^actions\/upload-artifact@/u, `${id}: the last step uploads the record`);
    assert.equal(steps.filter((each) => each.uses === upload.uses).length, 1, `${id}: one record`);
    assert.equal(write.run?.trim(), 'echo passed > "$RUNNER_TEMP/passed"', `${id}: the step before writes it`);
    assert.equal(upload.with.path, '${{ runner.temp }}/passed', id);
    assert.equal(upload.with['if-no-files-found'], 'error', id);
    for (const step of steps) {
      assert.equal(step.if, undefined, `${id}: ${step.name} runs only when every step before it passed`);
      assert.equal(step['continue-on-error'], undefined, `${id}: ${step.name} fails its job when it fails`);
    }
    assert.equal(jobs[id]['continue-on-error'], undefined, id);
    return recordNames(jobs[id]);
  });
  assert.equal(new Set(expected).size, expected.length, 'every record has a name of its own');
  assert.ok(expected.every((name) => name.startsWith('passed-')), 'the download pattern matches every record');
  const [download, verify] = jobs.check.steps;
  assert.match(download.uses ?? '', /^actions\/download-artifact@/u);
  assert.deepEqual(download.with, { pattern: 'passed-*', path: verify.env.PASSED }, 'each record in a folder of its own name, where the check looks');
  assert.deepEqual(verify.env.RECORDS.split(/\s+/u).sort(), expected.sort(), 'the check looks for every record, and only those');
});

test('npm run check is the static checks and the tests, and CI runs the same two', async () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.check, 'npm run check:static && npm test');
  const { jobs } = await ciWorkflow();
  const runs = jobs.static.steps.filter((step) => step.run !== undefined).map((step) => step.run.trim());
  const work = runs.filter((run) => run !== 'npm ci' && run !== 'echo passed > "$RUNNER_TEMP/passed"');
  assert.deepEqual(work, ['npm run check:static'], 'static runs npm run check:static, once, then writes its record');
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
