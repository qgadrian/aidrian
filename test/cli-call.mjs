// Runs an `aidrian` command in the test's own process, through runCli (lib/cli.mjs), the code bin/aidrian runs, without
// starting a node process for each call: { status, stdout, stderr }, the shape a spawnSync of bin/aidrian gives with
// encoding 'utf8'. `options` are spawnSync's `cwd` and `env`; `input` throws, since a command that reads stdin runs as a
// process. Calls run one at a time, as a test file's tests do. docs/test-processes.md#commands-in-the-tests-process says
// when a test keeps a process run instead.
// First, so lib/cli.mjs finds its switch set when it loads, and exposes runCli without running a command.
import './cli-in-process.mjs';

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

import { anchorClones } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { runCli } from '../plugins/aidrian/lib/cli.mjs';
import { resetGitStall } from '../plugins/aidrian/lib/git.mjs';
import { replaceEnv } from '../plugins/aidrian/lib/hook-io.mjs';

// The output of the call running now, seen from the call's own async context only: a write from elsewhere, such as the
// test runner reporting an earlier test on stdout, goes to the stream as before.
const call = new AsyncLocalStorage();
let running = false;

const NO_STDIN = 'cliCall reads no stdin: a command that reads its input runs as a process';

// The text of a chunk a stream's write was given.
function text(chunk, encoding) {
  if (typeof chunk !== 'string') return Buffer.from(chunk).toString('utf8');
  return Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8').toString('utf8');
}

// A stream's write that keeps the call's text in `output[name]` and hands every other write to `original`.
function keep(output, name, original) {
  return function write(chunk, encoding, callback) {
    if (call.getStore() !== output) return original.call(this, chunk, encoding, callback);
    output[name] += text(chunk, encoding);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') process.nextTick(done);
    return true;
  };
}

// Swaps in what the call `output` runs under, and gives what it replaced, for restore.
function swapIn(output) {
  const saved = { cwd: process.cwd(), env: { ...process.env }, exitCode: process.exitCode, stdout: process.stdout.write, stderr: process.stderr.write, exit: process.exit, readFileSync: fs.readFileSync };
  const mine = () => call.getStore() === output;
  process.stdout.write = keep(output, 'stdout', saved.stdout);
  process.stderr.write = keep(output, 'stderr', saved.stderr);
  // A command that exits ends its process, which in a test is the test runner: the test learns it instead.
  process.exit = function exit(code) {
    if (!mine()) return saved.exit.call(process, code);
    throw new Error(`the command called process.exit(${code ?? ''}): run it as a process`);
  };
  // The runner's stdin never closes, so a command reading it would hang the file: it throws instead.
  fs.readFileSync = function readFileSync(file, ...rest) {
    if (mine() && (file === 0 || file === '/dev/stdin')) throw new Error(NO_STDIN);
    return saved.readFileSync.call(this, file, ...rest);
  };
  // So a module's `import { readFileSync } from 'node:fs'` sees the swap too, as scripts/test-state.mjs does for spawn.
  syncBuiltinESMExports();
  return saved;
}

function restore(saved) {
  process.stdout.write = saved.stdout;
  process.stderr.write = saved.stderr;
  process.exit = saved.exit;
  fs.readFileSync = saved.readFileSync;
  syncBuiltinESMExports();
  process.exitCode = saved.exitCode;
  process.chdir(saved.cwd);
  replaceEnv(saved.env);
}

export async function cliCall(args, options = {}) {
  if (Object.hasOwn(options, 'input')) throw new Error(NO_STDIN);
  if (running) throw new Error('cliCall runs one command at a time');
  const { cwd = process.cwd(), env = process.env } = options;
  const output = { stdout: '', stderr: '' };
  let saved;
  try {
    running = true;
    saved = swapIn(output);
    // What a fresh process starts without: no git call stopped yet, and no clone anchor of an earlier call.
    resetGitStall();
    anchorClones(null);
    process.chdir(cwd);
    replaceEnv(env);
    // An exit code left undefined ends a process with 0.
    const status = (await call.run(output, () => runCli(args))) ?? 0;
    return { status, stdout: output.stdout, stderr: output.stderr };
  } finally {
    if (saved) restore(saved);
    resetGitStall();
    anchorClones(null);
    running = false;
  }
}
