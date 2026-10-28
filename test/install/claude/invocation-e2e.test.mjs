import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLAUDE = '/Users/adrian/.local/share/claude/versions/2.1.312';
const CLAUDE_SHA256 = '6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620';
const GRILL_ME_SHA256 = '60b6a50ff6d1760553771937fc11d1543ba79c6c0cebcdeb0164da0ec79e1db8';
const PATH = '/Users/adrian/.local/share/mise/installs/node/26.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const MAX_BUFFER = 1 * 1024 * 1024;

const runNonInteractiveCommand = (executable, argv, { cwd, env, timeout }) => {
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new TypeError('timeout must be a positive finite integer');
  }
  return new Promise((resolve, reject) => {
    const child = execFile(executable, argv, {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: MAX_BUFFER,
      shell: false,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end();
  });
};

test('runNonInteractiveCommand sends immediate EOF to child stdin', async () => {
  const marker = 'AIDRIAN_CLAUDE_STDIN_EOF';
  const result = await runNonInteractiveCommand(process.execPath, [
    '--input-type=module',
    '-e',
    `process.stdin.resume(); process.stdin.once('end', () => process.stdout.write('${marker}'));`,
  ], { cwd: ROOT, env: process.env, timeout: 10_000 });
  assert.equal(result.stdout, marker);
  assert.equal(result.stderr, '');
});

test('runNonInteractiveCommand rejects output above one MiB', async () => {
  await assert.rejects(
    runNonInteractiveCommand(process.execPath, [
      '--input-type=module',
      '-e',
      `process.stdout.write('x'.repeat(${MAX_BUFFER + 1}));`,
    ], { cwd: ROOT, env: process.env, timeout: 10_000 }),
    (error) => {
      assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      assert.equal(Buffer.byteLength(error.stdout, 'utf8') <= MAX_BUFFER, true);
      assert.equal(Buffer.byteLength(error.stderr, 'utf8') <= MAX_BUFFER, true);
      return true;
    },
  );
});

const isolated = async (t, label) => {
  const configuredRoot = process.env.AIDRIAN_CLAUDE_CANARY_ROOT;
  const root = configuredRoot
    ? path.resolve(configuredRoot)
    : await mkdtemp(path.join(tmpdir(), 'aidrian-claude-native-'));
  if (configuredRoot) {
    assert.equal(
      root.startsWith('/private/tmp/') || root.startsWith(`${path.resolve(tmpdir())}${path.sep}`),
      true,
      'Claude canary root must be an isolated temporary directory',
    );
  } else {
    t.after(() => rm(root, { force: true, recursive: true }));
  }
  const projectRoot = path.join(root, label);
  await mkdir(path.join(root, 'home'), { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  return {
    root: projectRoot,
    env: {
      ...process.env,
      PATH,
      HOME: path.join(root, 'home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'plugin-cache'),
    },
  };
};

test('Claude 2.1.312 invokes a real packaged role and skill from the installed hook-free core', async (t) => {
  assert.equal(createHash('sha256').update(await readFile(CLAUDE)).digest('hex'), CLAUDE_SHA256);
  const fixture = await isolated(t, 'core-project');
  const options = { cwd: fixture.root, env: fixture.env, timeout: 180_000 };
  assert.match((await runNonInteractiveCommand(CLAUDE, ['--version'], options)).stdout, /^2\.1\.312/);
  await assert.doesNotReject(
    runNonInteractiveCommand(CLAUDE, ['auth', 'status'], options),
    'native Claude E2E requires fresh authentication in the isolated canary home',
  );
  await runNonInteractiveCommand(CLAUDE, ['plugin', 'marketplace', 'add', ROOT, '--scope', 'user', '--json'], options);
  await runNonInteractiveCommand(CLAUDE, ['plugin', 'install', 'aidrian@aidrian-private', '--scope', 'user', '--json'], options);
  const packagedSkill = await readFile(path.join(ROOT, 'plugins/aidrian/skills/grill-me/SKILL.md'));
  assert.equal(createHash('sha256').update(packagedSkill).digest('hex'), GRILL_ME_SHA256);
  const installedPlugins = JSON.parse((await runNonInteractiveCommand(CLAUDE, ['plugin', 'list', '--json'], options)).stdout);
  const installedAidrian = installedPlugins.find(({ id }) => id === 'aidrian@aidrian-private');
  assert.ok(installedAidrian, 'Claude must report the exact installed Aidrian package');
  assert.deepEqual(
    { id: installedAidrian.id, version: installedAidrian.version },
    { id: 'aidrian@aidrian-private', version: '0.0.0' },
  );
  const installedSkill = await readFile(path.join(installedAidrian.installPath, 'skills/grill-me/SKILL.md'));
  assert.equal(createHash('sha256').update(installedSkill).digest('hex'), GRILL_ME_SHA256);
  const packagedExplorer = await readFile(path.join(ROOT, 'plugins/aidrian/agents/explorer.md'), 'utf8');
  const sentinelMatch = packagedExplorer.match(/^Enumeration completeness \(([^)]+)\):$/m);
  assert.ok(sentinelMatch);
  const roleSentinel = sentinelMatch[1];
  const rolePrompt = [
    'Inspect only your immutable role instructions.',
    'Reply with only the text inside parentheses in the heading whose prefix is `Enumeration completeness`.',
  ].join(' ');
  assert.equal(rolePrompt.includes(roleSentinel), false);
  const role = await runNonInteractiveCommand(CLAUDE, [
    '--agent',
    'aidrian:explorer',
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    '-p',
    rolePrompt,
  ], options);
  assert.equal(role.stdout.trim(), roleSentinel);
  await mkdir(path.join(fixture.root, 'ui'), { recursive: true });
  await writeFile(path.join(fixture.root, 'button-plan.md'), [
    '# Button rename plan',
    'Rename the label declared in ui/button.txt.',
    'Open question: should the old label remain as an alias for one release?',
    '',
  ].join('\n'));
  await writeFile(path.join(fixture.root, 'ui/button.txt'), 'label=Save\n');
  const skill = await runNonInteractiveCommand(CLAUDE, [
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    '-p',
    '/aidrian:grill-me Stress-test button-plan.md. Follow the skill workflow.',
  ], options);
  assert.match(skill.stdout, /Save/);
  assert.match(skill.stdout, /recommend/i);
  assert.equal((skill.stdout.match(/\?/g) ?? []).length, 1, 'grill-me must ask one question at a time');
});

test('Claude discovers and dispatches the excluded hook fixture only after controlled definition preflight', async (t) => {
  const fixture = await isolated(t, 'hook-project');
  const plugin = path.join(import.meta.dirname, 'fixtures/hook-plugin');
  const definition = await readFile(path.join(plugin, 'hooks/hooks.json'));
  const pinnedDigest = 'b76b7f486ffc392540dbefbe7e691e81f6c27d9a952c7bf1d0165a3451b9d530';
  assert.equal(createHash('sha256').update(definition).digest('hex'), pinnedDigest);
  const canary = path.join(fixture.root, 'claude-hook-canary.log');
  await assert.doesNotReject(
    runNonInteractiveCommand(CLAUDE, ['auth', 'status'], { cwd: fixture.root, env: fixture.env, timeout: 60_000 }),
    'native Claude hook fixture requires fresh authentication in the isolated canary home',
  );
  const result = await runNonInteractiveCommand(CLAUDE, [
    '--plugin-dir',
    plugin,
    '--permission-mode',
    'plan',
    '--no-session-persistence',
    '-p',
    'Reply with exactly AIDRIAN_CLAUDE_HOOK_OK.',
  ], {
    cwd: fixture.root,
    env: { ...fixture.env, AIDRIAN_FIXTURE_CANARY: canary },
    timeout: 180_000,
  });
  assert.match(result.stdout, /AIDRIAN_CLAUDE_HOOK_OK/);
  assert.equal(await readFile(canary, 'utf8'), 'claude-hook\n');
});
