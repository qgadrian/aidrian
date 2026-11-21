// lib/hook-io.mjs: how a hook script tells it runs as the main script, and callHook, which runs a hook's body in a
// test's own process as a host runs its script (test/hook-call.mjs).
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { GIT_TIMEOUT_MS, runGit } from '../plugins/aidrian/lib/git.mjs';
import { block, callHook, isMain, print } from '../plugins/aidrian/lib/hook-io.mjs';
import { hookCall } from './hook-call.mjs';

test('a hook that cannot resolve how it was started runs: a gate that cannot tell is not skipped', () => {
  assert.equal(isMain(pathToFileURL(path.join(tmpdir(), 'no-such-folder', 'hook.mjs')).href), true);
  assert.equal(isMain(pathToFileURL(path.join(import.meta.dirname, 'hook-call.mjs')).href), false, 'a module the test imports is not the main script');
  assert.equal(isMain(import.meta.url), true, 'node --test runs each test file as its main script');
});

test('callHook gives the exit code, stderr, and stdout a host would see, and restores the folder and environment', async () => {
  const before = { cwd: process.cwd(), env: { ...process.env } };
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-io-')));
  const result = await callHook(async () => {
    print(`${process.cwd()} ${process.env.HOOK_IO_X}`);
    await block({}, 'test', 'refused');
  }, {}, { cwd: dir, env: { ...process.env, HOOK_IO_X: 'set' } });
  assert.deepEqual(result, { status: 2, stderr: 'refused\n', stdout: `${dir} set\n` });
  assert.deepEqual({ cwd: process.cwd(), env: { ...process.env } }, before);
});

test('a folder that does not exist fails the call loudly and leaves the next call working', async () => {
  const before = { cwd: process.cwd(), env: { ...process.env } };
  await assert.rejects(callHook(async () => {}, {}, { cwd: path.join(tmpdir(), 'no-such-folder') }), { code: 'ENOENT' });
  assert.deepEqual({ cwd: process.cwd(), env: { ...process.env } }, before);
  assert.equal((await callHook(async () => {}, {})).status, 0);
});

test('an environment value of undefined leaves the variable out, as spawnSync does', async () => {
  const { stdout } = await callHook(async () => print(String('HOOK_IO_Y' in process.env)), {}, { env: { ...process.env, HOOK_IO_Y: undefined } });
  assert.equal(stdout, 'false\n');
});

test('a hook call starts with no stopped git call, as a fresh process does', async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'hook-io-')));
  const bin = path.join(dir, 'bin');
  const script = path.join(dir, 'hook.mjs');
  writeFileSync(script, `import { runGit } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '../plugins/aidrian/lib/git.mjs')).href)};\n` +
    `import { print } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, '../plugins/aidrian/lib/hook-io.mjs')).href)};\n` +
    'export async function handle() { print(String(runGit([\'--version\'], process.cwd()).status)); }\n');
  // A git that hangs past the limit marks git as stalled in this process.
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    assert.equal(runGit(['--version'], dir).status, null, `stopped after ${GIT_TIMEOUT_MS} ms`);
  } finally {
    process.env.PATH = saved;
  }
  assert.equal((await hookCall(script, { cwd: dir })).stdout, '0\n', 'the hook ran git again');
});
