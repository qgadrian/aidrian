// Checks against the real Claude Code and Codex command lines. No model runs and no login are needed.
// Each test skips when its command is not on PATH (as in CI), or when AIDRIAN_SKIP_HOSTS=1.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const MARKETPLACE = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8')).name;
const VERSION = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version;
const SKILLS = readdirSync(path.join(PLUGIN, 'skills')).sort();
const AGENTS = readdirSync(path.join(PLUGIN, 'agents')).map((file) => file.replace(/\.md$/, '')).sort();

const skipUnless = (command) => {
  if (process.env.AIDRIAN_SKIP_HOSTS === '1') return 'AIDRIAN_SKIP_HOSTS=1';
  return spawnSync(command, ['--version']).status === 0 ? false : `${command} is not on PATH`;
};
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });

test('Claude Code validates the marketplace and plugin, and loads every agent and skill', { skip: skipUnless('claude') }, () => {
  assert.match(run('claude', ['plugin', 'validate', '--strict', ROOT]), /Validation passed/);
  assert.match(run('claude', ['plugin', 'validate', '--strict', PLUGIN]), /Validation passed/);

  const details = run('claude', ['--plugin-dir', PLUGIN, 'plugin', 'details', 'aidrian']);
  const listed = (kind) => details.match(new RegExp(`^\\s*${kind} \\((\\d+)\\)\\s+(.*)$`, 'm'))?.[2].split(', ').sort();
  assert.deepEqual(listed('Skills'), SKILLS);
  assert.deepEqual(listed('Agents'), AGENTS);
});

test('Codex installs the plugin, and a project session sees every skill, agent, and AGENTS.md', { skip: skipUnless('codex') }, (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'aidrian-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(home, 'home'), CODEX_HOME: path.join(home, 'codex') };
  mkdirSync(env.HOME);
  mkdirSync(env.CODEX_HOME);

  run('codex', ['plugin', 'marketplace', 'add', ROOT], { env });
  run('codex', ['plugin', 'add', `aidrian@${MARKETPLACE}`], { env });
  const installed = JSON.parse(run('codex', ['plugin', 'list', '--json'], { env })).installed;
  assert.deepEqual(installed.map((p) => [p.pluginId, p.version, p.enabled]), [[`aidrian@${MARKETPLACE}`, VERSION, true]]);

  const cached = path.join(env.CODEX_HOME, 'plugins/cache', MARKETPLACE, 'aidrian', VERSION);
  run(process.execPath, [path.join(cached, 'codex/install-agents.mjs')], { env });

  const prompt = run('codex', ['debug', 'prompt-input', 'hello'], { env, cwd: EXAMPLE });
  for (const skill of SKILLS) assert.ok(prompt.includes(`aidrian:${skill}:`), `skill ${skill}`);
  for (const agent of AGENTS) assert.ok(prompt.includes(`aidrian-${agent}:`), `agent ${agent}`);
  assert.ok(prompt.includes('Project rules live in knowledge buckets'), 'the example AGENTS.md');
});
