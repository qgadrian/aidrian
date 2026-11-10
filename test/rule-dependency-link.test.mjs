import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { check, OVERRIDE } from '../plugins/aidrian/lib/rules/dependency-link.mjs';

const ENV = {};
const deny = (command) => assert.match(check(command, { env: ENV }) ?? '', /^Blocked: linking a dependency folder/, `expected deny: ${command}`);
const allow = (command) => assert.equal(check(command, { env: ENV }), null, `expected allow: ${command}`);

test('denies an ln that links a node_modules or .venv folder into another copy', () => {
  deny('ln -s /work/wt/node_modules /tmp/scratch/node_modules');
  deny('ln -sfn ../wt/node_modules node_modules');
  deny('ln --symbolic /work/wt/node_modules/ .');
  deny('ln -s /work/wt/.venv /tmp/scratch/.venv');
  deny('mkdir -p /tmp/s && cp -R src /tmp/s && ln -s "$PWD/node_modules" /tmp/s/node_modules');
  deny('(cd /tmp/s && ln -s /work/wt/node_modules)');
  deny('ln -s "$WT/node_modules" .');
  deny('rtk ln -s /work/wt/node_modules /tmp/s/node_modules');
  deny('x=$(ln -s /work/wt/node_modules /tmp/s/node_modules)');
});

test('allows other links, copies, and text that only names the folder', () => {
  allow('ln -s /work/wt/src /tmp/scratch/src');
  allow('ln -s /work/wt/node_modules/.bin/vitest /tmp/bin/vitest');
  allow('cp -R /work/wt/node_modules /tmp/scratch/node_modules');
  allow('echo ln -s a/node_modules b');
  allow('git worktree add --detach /tmp/scratch HEAD && pnpm -C /tmp/scratch install --frozen-lockfile --offline');
  allow('ls -la node_modules');
});

test('the override lets the link run', () => {
  assert.equal(check('ln -s /w/node_modules /s/node_modules', { env: { [OVERRIDE]: '1' } }), null);
});

test('the Bash hook blocks the link, and the deny names the separate copy', () => {
  const script = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
  const input = { tool_name: 'Bash', tool_input: { command: 'ln -s /work/wt/node_modules /tmp/s/node_modules' }, cwd: import.meta.dirname };
  const result = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /archive HEAD \| tar -x -C <scratch>/u);
  assert.match(result.stderr, /--frozen-lockfile --offline/u);
});
