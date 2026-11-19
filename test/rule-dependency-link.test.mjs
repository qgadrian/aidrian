import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

// Agents that needed dependencies in their own task worktree hit the rule again and again: the deny said why a link is
// unsafe and named only a scratch copy for a reviewer, not how to install in the worktree they work in.
test('the deny names the allowed way to get dependencies in a worktree: the project\'s bootstrap when set, else its install', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-deplink-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  const link = 'ln -s ../../node_modules node_modules';
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const plain = check(link, { env: ENV, cwd: dir });
  assert.match(plain, /To get dependencies in a worktree, install them in that worktree: run the project's install there from its lockfile/u);
  assert.match(plain, /`git\.worktrees\.bootstrap` can name it, so `aidrian worktree new` runs it in each new worktree/u);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { worktrees: { bootstrap: 'pnpm install --frozen-lockfile' } } }));
  const named = check(link, { env: ENV, cwd: dir });
  assert.match(named, /run the project's worktree bootstrap there, `pnpm install --frozen-lockfile` \(config\.json `git\.worktrees\.bootstrap`/u);
  for (const text of [plain, named]) {
    assert.match(text, /^Blocked: linking a dependency folder lets a package manager run in the copy install through the link and change the original's packages\. /u, 'the first sentence groups the rule\'s denies');
  }
});
