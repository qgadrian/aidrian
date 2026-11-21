// test/cli-call.mjs cliCall: an `aidrian` command run in the test's process gives what bin/aidrian gives as a process,
// and leaves the process as it found it.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { commands } from '../plugins/aidrian/lib/check.mjs';
import { cliCall } from './cli-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

// What the process holds that a call swaps out for its run.
const processState = () => ({ cwd: process.cwd(), env: { ...process.env }, exitCode: process.exitCode, stdout: process.stdout.write, stderr: process.stderr.write, exit: process.exit, readFileSync: fs.readFileSync });

test('check, an unknown command, an unknown option, and --help give what a process run of bin/aidrian gives', async () => {
  for (const args of [['check'], ['check', '--project', EXAMPLE], ['no-such-command'], ['check', '--no-such-option'], ['--help'], []]) {
    const spawned = spawnSync(CLI, args, { cwd: EXAMPLE, encoding: 'utf8' });
    const called = await cliCall(args, { cwd: EXAMPLE });
    assert.deepEqual(called, { status: spawned.status, stdout: spawned.stdout, stderr: spawned.stderr }, args.join(' '));
  }
  assert.equal((await cliCall(['check'], { cwd: EXAMPLE })).status, 0, 'the example consumer passes, so the comparison above is not of two failures');
});

test('importing lib/cli.mjs without the test switch runs the command, so only test code can stop it', () => {
  const cli = path.join(ROOT, 'plugins/aidrian/lib/cli.mjs');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(cli)});`, 'eval', 'no-such-command'], { cwd: EXAMPLE, encoding: 'utf8' });
  assert.equal(imported.status, 1);
  assert.match(imported.stderr, /\n\nunknown command: no-such-command\n$/u);
});

test('the call gets its own folder and environment, and the process gets its own back', async (t) => {
  const before = processState();
  t.mock.method(commands.state, 'run', async () => {
    console.log(`${process.cwd()} ${process.env.CLI_CALL_X} ${'HOME' in process.env}`);
    return 3;
  });
  const result = await cliCall(['state'], { cwd: tmpdir(), env: { ...process.env, CLI_CALL_X: 'set', HOME: undefined } });
  assert.deepEqual(result, { status: 3, stdout: `${realpathSync(tmpdir())} set false\n`, stderr: '' });
  assert.deepEqual(processState(), before);
});

test('a command that throws reaches the test, and the process is restored', async (t) => {
  const before = processState();
  t.mock.method(commands.state, 'run', async () => {
    process.chdir(path.parse(process.cwd()).root);
    process.env.CLI_CALL_LEAK = '1';
    process.exitCode = 7;
    process.stdout.write = () => true;
    throw new Error('boom');
  });
  await assert.rejects(cliCall(['state'], { cwd: EXAMPLE }), /^Error: boom$/u);
  assert.deepEqual(processState(), before);
  assert.equal('CLI_CALL_LEAK' in process.env, false);
});

test('a command that calls process.exit throws to the test instead of ending the test run', async (t) => {
  const before = processState();
  t.mock.method(commands.state, 'run', async () => process.exit(4));
  await assert.rejects(cliCall(['state']), /process\.exit\(4\): run it as a process/u);
  assert.deepEqual(processState(), before);
});

test('a command that reads stdin throws to the test instead of waiting on the test runner stdin, and reads go on after', async () => {
  // lesson add reads the lesson from stdin (lib/lesson-cli.mjs), through its own `import { readFileSync } from 'node:fs'`.
  await assert.rejects(cliCall(['lesson', 'add'], { cwd: EXAMPLE }), /cliCall reads no stdin/u);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync, fs.readFileSync, 'the named export is the real one again');
  assert.match(readFileSync(path.join(EXAMPLE, '.aidrian/config.json'), 'utf8'), /"version"/u);
});

test('a write from outside the call goes to the stream, and the call keeps only its own', async (t) => {
  const seen = [];
  const original = process.stderr.write;
  t.after(() => {
    process.stderr.write = original;
  });
  process.stderr.write = (chunk) => seen.push(String(chunk));
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(commands.state, 'run', async () => {
    console.error('inside');
    await held;
    return 0;
  });
  const running = cliCall(['state']);
  await new Promise((resolve) => setImmediate(resolve));
  process.stderr.write('outside\n');
  // A second call while one runs, and a call given stdin, throw.
  await assert.rejects(cliCall(['check']), /one command at a time/u);
  release();
  assert.deepEqual(await running, { status: 0, stdout: '', stderr: 'inside\n' });
  assert.deepEqual(seen, ['outside\n']);
  await assert.rejects(cliCall(['check'], { input: '' }), /reads no stdin/u);
});

