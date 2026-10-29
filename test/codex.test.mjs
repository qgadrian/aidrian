import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'smol-toml';

import { CODEX_AGENTS, PREFIX, compareCodexAgents, readAgents } from '../scripts/build.mjs';

const INSTALL = path.resolve(import.meta.dirname, '../plugins/aidrian/codex/install-agents.mjs');

test('the generated Codex agents are current (npm run build regenerates them)', () => {
  assert.deepEqual(compareCodexAgents(), []);
});

test('each Codex agent is valid TOML that carries its Claude Code agent', () => {
  for (const { meta, body } of readAgents()) {
    const role = parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${meta.name}.toml`), 'utf8'));
    assert.equal(role.name, `${PREFIX}${meta.name}`);
    assert.equal(role.description, meta.description.replace(/\s+/g, ' ').trim());
    assert.equal(role.model_reasoning_effort, meta.effort === 'max' ? 'xhigh' : meta.effort);
    assert.equal('model' in role, false, 'Codex roles inherit the session model');
    assert.ok(role.developer_instructions.endsWith(`${body}\n`), `${meta.name}: body`);
  }
});

test('Codex agents that cannot edit in Claude Code are told so', () => {
  const role = (name) => parse(readFileSync(path.join(CODEX_AGENTS, `${PREFIX}${name}.toml`), 'utf8')).developer_instructions;
  assert.match(role('explorer'), /You are read-only/);
  assert.match(role('integrator'), /Do not create or edit files directly/);
  assert.doesNotMatch(role('planning-agent'), /read-only|Do not create or edit files/);
});

test('install-agents adds and updates its own roles, removes stale ones, and leaves other files alone', (t) => {
  const target = mkdtempSync(path.join(tmpdir(), 'aidrian-codex-agents-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  writeFileSync(path.join(target, 'my-own-agent.toml'), 'name = "mine"\n');
  writeFileSync(path.join(target, `${PREFIX}retired.toml`), 'name = "old"\n');
  writeFileSync(path.join(target, `${PREFIX}explorer.toml`), 'name = "outdated"\n');

  const run = () => execFileSync(process.execPath, [INSTALL, '--target', target], { encoding: 'utf8' });
  assert.match(run(), /added .*; updated aidrian-explorer; removed aidrian-retired/);
  const shipped = readdirSync(CODEX_AGENTS).sort();
  assert.deepEqual(readdirSync(target).sort(), [...shipped, 'my-own-agent.toml'].sort());
  for (const file of shipped) assert.equal(readFileSync(path.join(target, file), 'utf8'), readFileSync(path.join(CODEX_AGENTS, file), 'utf8'));
  assert.match(run(), /are up to date \(9\)/);
});
