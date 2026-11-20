// Checks against the real Claude Code and Codex command lines. No model runs and no login are needed.
// Each test skips when its command is not on PATH (as in CI), or when AIDRIAN_SKIP_HOSTS=1.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT, 'plugins/aidrian');
const EXAMPLE = path.join(ROOT, 'examples/consumer');
const MARKETPLACE = JSON.parse(readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8')).name;
const VERSION = JSON.parse(readFileSync(path.join(PLUGIN, '.claude-plugin/plugin.json'), 'utf8')).version;
const SKILLS = readdirSync(path.join(PLUGIN, 'skills')).sort();
const AGENTS = readdirSync(path.join(PLUGIN, 'agents')).map((file) => file.replace(/\.md$/, '')).sort();
const HOOK_EVENTS = Object.keys(JSON.parse(readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8')).hooks).sort();
const MANUAL_SKILL = 'visual-brief';

const skipUnless = (command) => {
  if (process.env.AIDRIAN_SKIP_HOSTS === '1') return 'AIDRIAN_SKIP_HOSTS=1';
  return spawnSync(command, ['--version']).status === 0 ? false : `${command} is not on PATH`;
};
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: 'utf8', timeout: 120_000, ...options });

// Use the catalog exposed to clients, without starting a thread or a model turn.
async function codexSkillCatalog(cwd, env) {
  const server = spawn('codex', ['app-server', '--stdio'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise((resolve) => server.once('close', resolve));
  let processError;
  server.on('error', (error) => { processError = error; });
  server.stdin.on('error', (error) => { processError = error; });
  const messages = createInterface({ input: server.stdout });
  const send = (message) => server.stdin.write(JSON.stringify(message) + '\n');
  const timeout = setTimeout(() => server.kill('SIGKILL'), 15_000);
  try {
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'aidrian-hosts-test', version: '1' } } });
    for await (const line of messages) {
      const message = JSON.parse(line);
      if (message.id === 1) {
        assert.ok(message.result, 'app-server initialize failed');
        send({ method: 'initialized' });
        send({ id: 2, method: 'skills/list', params: { cwds: [cwd] } });
      }
      if (message.id === 2) {
        assert.ok(message.result, 'app-server skills/list failed');
        return message.result.data[0].skills;
      }
    }
    throw processError ?? new Error('app-server did not return a skills catalog');
  } finally {
    messages.close();
    server.kill();
    await closed;
    clearTimeout(timeout);
  }
}

test('Claude Code validates the marketplace and plugin, and loads every agent, skill, and hook event', { skip: skipUnless('claude') }, () => {
  assert.match(run('claude', ['plugin', 'validate', '--strict', ROOT]), /Validation passed/);
  assert.match(run('claude', ['plugin', 'validate', '--strict', PLUGIN]), /Validation passed/);

  const details = run('claude', ['--plugin-dir', PLUGIN, 'plugin', 'details', 'aidrian']);
  const listed = (kind) => details.match(new RegExp(`^\\s*${kind} \\((\\d+)\\)\\s+(.*)$`, 'm'))?.[2].replace(/\s+\(.*\)$/, '').split(', ').sort();
  assert.deepEqual(listed('Skills'), SKILLS);
  assert.deepEqual(listed('Agents'), AGENTS);
  assert.deepEqual(listed('Hooks'), HOOK_EVENTS, 'every event in hooks.json loads');
});

test('Codex packages all skills, lists the manual skill in its catalog, and loads implicit skills and agents in a session', { skip: skipUnless('codex') }, async (t) => {
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
  assert.deepEqual(readdirSync(path.join(cached, 'skills')).sort(), SKILLS, 'all skill folders reach the installation');
  run(process.execPath, [path.join(cached, 'codex/install-agents.mjs')], { env });

  const prompt = run('codex', ['debug', 'prompt-input', 'hello'], { env, cwd: EXAMPLE });
  for (const skill of SKILLS) assert.equal(prompt.includes(`aidrian:${skill}:`), skill !== MANUAL_SKILL, `implicit skill ${skill}`);
  for (const agent of AGENTS) assert.ok(prompt.includes(`aidrian-${agent}:`), `agent ${agent}`);
  assert.ok(prompt.includes('Project rules live in knowledge buckets'), 'the example AGENTS.md');

  const catalog = await codexSkillCatalog(EXAMPLE, env);
  const manual = catalog.find((skill) => skill.name === `aidrian:${MANUAL_SKILL}`);
  assert.ok(manual?.enabled, 'manual skill is discoverable and enabled in the explicit catalog');
  assert.equal(manual.interface?.displayName, 'Visual Brief');
  assert.equal(realpathSync(manual.path), realpathSync(path.join(cached, 'skills', MANUAL_SKILL, 'SKILL.md')));
  assert.equal(manual.pluginId, `aidrian@${MARKETPLACE}`);
});

test('Codex gives a role the model and effort that a project install writes from models.codex', { skip: skipUnless('codex') }, (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-codex-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: path.join(home, 'home'), CODEX_HOME: path.join(home, 'codex') };
  const project = path.join(home, 'project');
  for (const dir of [env.HOME, env.CODEX_HOME, path.join(project, '.aidrian')]) mkdirSync(dir, { recursive: true });
  run('git', ['init', '-q'], { cwd: project });
  const models = { codex: { agents: { 'planning-agent': { model: 'gpt-5.5', effort: 'low' } } } };
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, models }));
  // Codex reads a project's .codex folder only once the project is trusted.
  writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`);

  run(process.execPath, [path.join(PLUGIN, 'codex/install-agents.mjs'), '--target', path.join(project, '.codex/agents')], { env });
  const prompt = run('codex', ['debug', 'prompt-input', 'hello'], { env, cwd: project });
  assert.match(prompt, /aidrian-planning-agent: \{\\n[^}]*This role's model is set to `gpt-5\.5` and its reasoning effort is set to `low`\./);
});
