// Checks against the real Claude Code, Codex, and OpenCode command lines. No model runs and no login are needed.
// Each test skips when its command is not on PATH (as in CI), or when AIDRIAN_SKIP_HOSTS=1; OpenCode's also skips below
// major version 2.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

import { SESSION_HOOKS } from '../plugins/aidrian/opencode/bridge.mjs';
import { DELETED_EVENT, EVENTS } from '../plugins/aidrian/opencode/routes.mjs';

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
// The OpenCode gate: OpenCode 2.0 and later loads a server plugin from a package, so an older one, or output with no
// version in it, skips. The version is the first <digits>.<digits>.<digits> of `opencode --version`'s output.
function opencodeSkip(output) {
  const major = /(\d+)\.\d+\.\d+/u.exec(output ?? '')?.[1];
  if (major === undefined) return 'opencode --version printed no version';
  return Number(major) >= 2 ? false : `opencode ${major}.x is older than 2.0`;
}
// An environment isolated from the user's OpenCode: HOME, OPENCODE_TEST_HOME, the XDG folders, OpenCode's config folder,
// and TMPDIR inside `home`, each made, and no OPENCODE_* or AIDRIAN_OPENCODE_* variable inherited from `from`.
function isolatedOpencode(home, from = process.env) {
  const env = {
    ...Object.fromEntries(Object.entries(from).filter(([key]) => !/^(?:AIDRIAN_)?OPENCODE/u.test(key))),
    HOME: home,
    OPENCODE_TEST_HOME: home,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    OPENCODE_CONFIG_DIR: path.join(home, 'config/opencode'),
    TMPDIR: path.join(home, 'tmp'),
  };
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_DIR', 'TMPDIR']) mkdirSync(env[key], { recursive: true });
  return env;
}
// An opencode runner that refuses a call without --standalone, which keeps it off the user's background service; only
// --version and a --help last reach no server.
const opencodeRunner = (env, cwd) => (...args) => {
  assert.ok(args.includes('--standalone') || ['--version', '--help'].includes(args.at(-1)), `opencode ${args.join(' ')} passes no --standalone`);
  return run('opencode', args, { env, cwd });
};
// The OpenCode test's skip reason, from `opencode --version` run in a throwaway isolated home that is removed after.
function skipUnlessOpencode(from = process.env) {
  if (from.AIDRIAN_SKIP_HOSTS === '1') return 'AIDRIAN_SKIP_HOSTS=1';
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-probe-')));
  try {
    return opencodeSkip(opencodeRunner(isolatedOpencode(home, from), home)('--version'));
  } catch {
    return 'opencode is not on PATH';
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
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

test('the OpenCode gate runs on major version 2 and later, and skips an older version or output with no version', () => {
  for (const output of ['1.14.0', 'opencode v1.14.0\n']) assert.match(opencodeSkip(output), /older than 2\.0/u, output);
  for (const output of ['2.0.0', 'opencode v2.4.0\n', '3.1.0']) assert.equal(opencodeSkip(output), false, output);
  for (const output of ['', 'opencode\n', 'v2', undefined]) assert.equal(opencodeSkip(output), 'opencode --version printed no version', String(output));
});

test('the OpenCode probe runs --version in a throwaway isolated home, and no call runs without --standalone', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-fake-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const record = path.join(dir, 'env.txt');
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'opencode'), `#!/bin/sh\nenv > '${record}'\necho 'opencode v2.4.0'\n`);
  chmodSync(path.join(bin, 'opencode'), 0o755);
  const from = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: '/real/home', OPENCODE_CONFIG: '/real/opencode.json', AIDRIAN_OPENCODE_TRACE: '/real/trace' };
  assert.equal(skipUnlessOpencode(from), false);
  const seen = Object.fromEntries(readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.match(seen.HOME, /aidrian-opencode-probe-/u);
  assert.equal(seen.OPENCODE_TEST_HOME, seen.HOME);
  for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_DIR', 'TMPDIR']) assert.ok(seen[key].startsWith(`${seen.HOME}/`), key);
  assert.equal(seen.OPENCODE_CONFIG, undefined);
  assert.equal(seen.AIDRIAN_OPENCODE_TRACE, undefined);
  assert.equal(existsSync(seen.HOME), false, 'the probe home is removed');
  rmSync(record);
  assert.equal(skipUnlessOpencode({ ...from, AIDRIAN_SKIP_HOSTS: '1' }), 'AIDRIAN_SKIP_HOSTS=1');
  assert.equal(existsSync(record), false, 'AIDRIAN_SKIP_HOSTS=1 runs nothing');
  const opencode = opencodeRunner(from, dir);
  for (const args of [['plugin', 'list'], ['models'], ['debug', 'config']]) assert.throws(() => opencode(...args), /passes no --standalone/u, args.join(' '));
  assert.equal(existsSync(record), false, 'a refused call runs nothing');
});

// Isolated from the user's OpenCode: a new HOME with every OpenCode folder inside it, no OPENCODE_* variable inherited,
// --standalone on every call, and `opencode service` never run.
test('OpenCode loads the plugin folder as a package from its config, and the bridge\'s setup runs', { skip: skipUnlessOpencode() }, (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = isolatedOpencode(home);
  const cwd = path.join(home, 'work');
  mkdirSync(cwd);
  const config = path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json');
  writeFileSync(config, JSON.stringify({ plugins: [PLUGIN] }));
  const opencode = opencodeRunner(env, cwd);
  const setupsIn = (trace) => {
    try {
      return readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(({ step }) => step === 'setup');
    } catch {
      return [];
    }
  };

  // The only config OpenCode reads is this test's.
  const sources = JSON.parse(opencode('debug', 'config', '--standalone'));
  assert.deepEqual(sources.map((source) => source.path), [config, env.OPENCODE_CONFIG_DIR]);
  assert.deepEqual(sources[0].info, { plugins: [PLUGIN] });

  // The command that writes the setup line is `models --standalone`, the first of plugin list, debug config, and models
  // that does: plugins can add models, so the list waits for them. On OpenCode 2.4.0 `plugin list --standalone` asks its
  // private server before any plugin has loaded, and always prints "No plugins found", even with --builtin, so it is not
  // asserted here. The id the list would show is held by the manifest test in test/opencode-bridge.test.mjs.
  // `models` polls its server's plugin.list every 25 ms for at most 5 seconds, OpenCode 2.4.0's own wait that no flag
  // changes, then lists and stops the server: on a loaded machine the plugin can take longer, and its setup never
  // finishes or writes a line.
  // So the call is made up to 3 times, each with its own trace file and a new private server, while none wrote a line;
  // a later one loads from the cache the earlier filled. The attempt that wrote one must hold exactly one.
  const ATTEMPTS = 3;
  let found = [];
  for (let attempt = 1; attempt <= ATTEMPTS && !found.length; attempt += 1) {
    const trace = path.join(home, `trace-${attempt}.jsonl`);
    opencodeRunner({ ...env, AIDRIAN_OPENCODE_TRACE: trace }, cwd)('models', '--standalone');
    found = setupsIn(trace);
  }
  assert.notEqual(found.length, 0, `no models --standalone of ${ATTEMPTS} ran the bridge's setup within OpenCode 2.4.0's 5-second plugin.list wait`);
  assert.equal(found.length, 1, 'models --standalone ran the bridge\'s setup once');
  // One hook for each OpenCode hook of EVENTS, `context` among them for the start, and `compaction`, which carries the
  // start lines too (bridge.mjs SESSION_HOOKS). SessionEnd's `session.deleted` is an event the bridge reads from the
  // event stream, not a hook it registers, so it is no part of the count; the count stays exact, so a hook lost fails.
  const hooks = Object.values(EVENTS).filter((hook) => hook !== DELETED_EVENT);
  assert.ok(Object.values(EVENTS).includes(DELETED_EVENT) && hooks.length > 0, 'EVENTS names SessionEnd`s event and the hooks the count holds');
  assert.equal(found[0].status, new Set([...hooks, ...SESSION_HOOKS]).size, 'setup registered one hook for each OpenCode hook of EVENTS, and the session hooks');
});
