// `aidrian project start` on Claude Code under the host's sandbox (lib/hosts/claude-code-sandbox.mjs,
// lib/hosts/claude-code-background.mjs startProject): the session works in a fresh clone of its attempt, starts with
// `--setting-sources user`, the sandbox settings inline, and only the team's MCP servers, and holds only once the agent
// gate hook's beacon arrives. A start halts on user settings that weaken the sandbox or run a command outside it, on this
// plugin not enabled for the user, on any other plugin, on a user or clone skill whose frontmatter declares hooks or MCP
// servers, on a link out of a skill folder, on an SSH origin, on git's `store` credential helper, on a clone that pushes
// elsewhere, and on a Linux with no bubblewrap or socat. Checked on fixtures only: no test starts a real session. The
// fixture is test/project-start-fixture.mjs, whose platform is Linux.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { forgeDomains, forgeTokenVars } from '../plugins/aidrian/lib/forges/index.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { BEACON_WAIT, IDENTIFY_CAP, startBackground, startProject } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';
import { accessProblem, BROWSER_PROFILES, cloneProblem, configFolder, confineReads, CREDENTIAL_PATHS, limitContinueProblem, mcpConfig, nestedProtected, npmGlobalConfigs, PLACEHOLDERS, PROTECTED_PATHS, sandboxSettings, secretVars, userSettingsProblem, writeEnvFile } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import { nestedProtected as anyHostNested, credentialStores, nestedGlobs, protectedPaths } from '../plugins/aidrian/lib/hosts/index.mjs';
import { GIT_PLACEHOLDERS } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { ATTEMPT_ENV, cacheVars, ENV_NAME, isRegistries, REGISTRIES, REGISTRY_NAMES, registryHosts } from '../plugins/aidrian/lib/project-registries.mjs';
import { CONFINE_PLAN } from '../plugins/aidrian/lib/project-confine.mjs';
import { placeHolders, SHELL_VARS } from '../plugins/aidrian/lib/project-start.mjs';
import { PENDING_AGE } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, fakeClaude, OWN_PLUGIN, runFixture, STARTED, testGlobalConfig } from './project-start-fixture.mjs';

const SESSION_START = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-start.mjs');
const work = (fx, attempt = 1) => path.join(runsFolder(fx.state), 'launch', 'attempts', `ENG-1.${attempt}`, 'work');
// The host's user settings of the fixture, written as `value`.
const userSettings = (fx, value) => {
  mkdirSync(fx.env.CLAUDE_CONFIG_DIR, { recursive: true });
  writeFileSync(path.join(fx.env.CLAUDE_CONFIG_DIR, 'settings.json'), typeof value === 'string' ? value : JSON.stringify(value));
};
// The host's record of installed plugins in the fixture, `plugins` by id.
const installed = (fx, plugins) => writeFileSync(path.join(fx.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
const OWN = { scope: 'user', installPath: path.resolve(import.meta.dirname, '../plugins/aidrian') };
// A halted start: exit 1, `halt <cause>` first, no session started, and nothing recorded.
function halted(fx, result, cause) {
  assert.equal(result.exitCode, 1, result.out.join('\n'));
  assert.match(result.out[0], /^halt /u);
  assert.match(result.out[0], cause);
  assert.deepEqual(fx.claude.starts(), [], 'no claude --bg');
  assert.deepEqual(fx.rows(), [], 'nothing recorded');
}
// The driver's environment with an SSH stand-in that serves the fixture's bare remote, so the start's pin can fetch
// over an SSH origin, as a driver with the user's keys does, and the gate's access check is what halts it.
const sshFetch = (fx) => {
  const script = path.join(fx.bin, 'ssh-stand-in');
  writeFileSync(script, '#!/bin/sh\nexec git upload-pack "$FIXTURE_REMOTE"\n', { mode: 0o755 });
  return { ...fx.env, GIT_SSH_COMMAND: script };
};
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// OpenCode's host files at a clone's root, and the denyWrite entries of every other host's files under the clone `work`.
const OPENCODE_FILES = ['.opencode', 'opencode.json', 'opencode.jsonc', '.agents'];
const OTHER_GLOBS = ['**/.opencode', '**/.opencode/**', '**/opencode.json', '**/opencode.jsonc', '**/.agents', '**/.agents/**'];
const otherDenied = (work) => [...OPENCODE_FILES, ...OTHER_GLOBS].map((each) => `${work}/${each}`);

// Folders for the adapter's start outside the gate: a clone, its git folder, and a granted folder, by their real paths,
// laid out as a run's attempt is, `<root>/runs/launch/attempts/ENG-1.1/`.
// With `fx`, the host's trust record of that fixture trusts the root, as the Human's trust in the runs folder does.
function folders(t, fx = null) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-sandbox-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (fx) writeFileSync(path.join(fx.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ projects: { [root]: { hasTrustDialogAccepted: true } } }));
  const attempt = path.join(root, 'runs', 'launch', 'attempts', 'ENG-1.1');
  const [cwd, git, drop] = ['work', 'git', 'drop'].map((name) => path.join(attempt, name));
  for (const each of [cwd, git, drop]) mkdirSync(each, { recursive: true });
  return { root, cwd, git, drop };
}

test('Claude Code declares an unverified, confined project start, and the host files it protects, at the root and at any depth', () => {
  const cap = claudeCode.capabilities.projectStart;
  assert.deepEqual([cap.verified, cap.evidence, cap.confined], ['unverified', 'fixtures and the host docs; no live run', true]);
  for (const field of ['start', 'stop', 'ended', 'find', 'access', 'cloneProblem', 'attachLine', 'stopLine', 'sessionNote', 'shellEnv']) assert.equal(typeof cap[field], 'function', field);
  assert.equal(cap.placeholders, PLACEHOLDERS);
  assert.match(cap.sessionNote({ work: '/w', branch: 'feat/x' }), /Claude Code's sandbox, in \/w.*work only in that folder.*git push origin HEAD:refs\/heads\/feat\/x.*--head feat\/x.*starts no other session/su);
  assert.deepEqual(PROTECTED_PATHS, ['.claude/settings.json', '.claude/settings.local.json', '.claude/skills', '.claude/agents', '.claude/commands', '.claude/hooks', '.claude/workflows', '.claude/scheduled_tasks.json', '.mcp.json']);
  assert.deepEqual(protectedPaths(), [...PROTECTED_PATHS, ...OPENCODE_FILES], 'the union of every host\'s: Claude Code\'s, then OpenCode\'s; Codex protects none of its own');
  for (const each of ['pkg/.claude/skills/x/SKILL.md', 'a/b/.claude/agents/x.md', 'a/.CLAUDE/Commands/x.md', 'a/.claude/settings.local.json', 'a/.claude/settings.json',
    'a/.claude/hooks/x.sh', 'a/.claude/workflows/x', 'docs/skill.md', 'a/.claude', '.claude/skills']) {
    assert.equal(nestedProtected(each.split('/')), true, each);
    assert.equal(anyHostNested(each.split('/')), true, each);
  }
  for (const each of ['a/.claude/CLAUDE.md', 'a/claude/skills/x.md', 'src/settings.json', 'a/.claude/notes.md', 'SKILLS.md']) assert.equal(nestedProtected(each.split('/')), false, each);
  // The placeholders: the settings files and .mcp.json as `{}`, the folders empty, and no scheduled tasks file.
  assert.deepEqual(PLACEHOLDERS.map((each) => [each.path, each.folder ? 'folder' : each.text]), [
    ['.claude/settings.json', '{}\n'], ['.claude/settings.local.json', '{}\n'], ['.mcp.json', '{}\n'], ['.claude/skills', 'folder'], ['.claude/agents', 'folder'],
    ['.claude/commands', 'folder'], ['.claude/hooks', 'folder'], ['.claude/workflows', 'folder'],
  ]);
});

test('the identify step ends well before a pending mark lapses, and the beacon wait is bounded', () => {
  assert.ok(IDENTIFY_CAP <= PENDING_AGE - 30_000, `${IDENTIFY_CAP} against ${PENDING_AGE}`);
  assert.equal(BEACON_WAIT, 180_000);
});

test('the sandbox settings are pinned whole: the sandbox on and required, writes to the grants and temporary folders only, credentials and the main checkout unreadable, connectors off, and a strict network allowlist', () => {
  const home = '/home/u';
  const settings = sandboxSettings({
    work: '/s/w', git: '/s/g', grants: ['/s/g', '/s/d', '/st/plans'], domains: ['github.com', 'api.github.com'], temp: ['/private/tmp', '/s/d'], home,
    config: '/cfg', platform: 'linux', main: '/m', mainGit: '/m/.git', secrets: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'], stores: ['/usr/local/etc/npmrc'],
  });
  const stores = [...CREDENTIAL_PATHS.map((each) => path.join(home, each)), '/cfg/.credentials.json', '/cfg/ide', '/cfg/.claude.json', '/cfg/.claude-trust-stage', '/cfg/session-env', '/usr/local/etc/npmrc', ...BROWSER_PROFILES.map((each) => path.join(home, each))];
  const unread = [...stores, '/m'];
  const nested = ['/s/w/**/.claude', ...['skills', 'agents', 'commands', 'hooks', 'workflows', 'scheduled_tasks.json'].flatMap((name) => [`/s/w/**/.claude/${name}`, `/s/w/**/.claude/${name}/**`])];
  assert.deepEqual(settings, {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowNestedUserNamespaces: false,
      filesystem: {
        allowWrite: ['/s/g', '/s/d', '/st/plans', '/private/tmp'],
        denyWrite: [
          '/s/w/.git', '/s/g/config', '/s/g/hooks', '/s/g/commondir', '/s/g/config.worktree', ...PROTECTED_PATHS.map((each) => `/s/w/${each}`),
          ...nested, '/s/w/**/.claude/settings*.json', '/s/w/**/SKILL.md', '/s/drop/.keep-attempt', '/s/cache/.keep-attempt',
        ],
        denyRead: unread,
        allowRead: ['/m/.git'],
      },
      network: { strictAllowlist: true, allowedDomains: ['github.com', 'api.github.com'], allowAllUnixSockets: false, allowLocalBinding: false },
      credentials: { envVars: [{ name: 'NPM_TOKEN', mode: 'deny' }, { name: 'AWS_SECRET_ACCESS_KEY', mode: 'deny' }] },
    },
    permissions: { deny: unread.flatMap((each) => [`Read(/${each})`, `Read(/${each}/**)`]) },
    disableClaudeAiConnectors: true,
    worktree: { bgIsolation: 'none' },
    autoContinueAtUsageLimit: true,
  });
  // The other hosts' files: their root entries after Claude Code's, their globs after Claude Code's own, in that order,
  // and nothing else moved.
  const united = sandboxSettings({
    work: '/s/w', git: '/s/g', grants: ['/s/g', '/s/d', '/st/plans'], domains: ['github.com', 'api.github.com'], temp: ['/private/tmp', '/s/d'], home,
    config: '/cfg', platform: 'linux', main: '/m', mainGit: '/m/.git', secrets: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'], stores: ['/usr/local/etc/npmrc'],
    hostFiles: { paths: [...PROTECTED_PATHS, ...OPENCODE_FILES], globs: nestedGlobs() },
  });
  assert.deepEqual(united.sandbox.filesystem.denyWrite, [
    '/s/w/.git', '/s/g/config', '/s/g/hooks', '/s/g/commondir', '/s/g/config.worktree', ...PROTECTED_PATHS.map((each) => `/s/w/${each}`), ...OPENCODE_FILES.map((each) => `/s/w/${each}`),
    ...nested, '/s/w/**/.claude/settings*.json', '/s/w/**/SKILL.md', ...OTHER_GLOBS.map((glob) => `/s/w/${glob}`), '/s/drop/.keep-attempt', '/s/cache/.keep-attempt',
  ]);
  const without = (value) => ({ ...value, sandbox: { ...value.sandbox, filesystem: { ...value.sandbox.filesystem, denyWrite: null } } });
  assert.deepEqual(without(united), without(settings), 'nothing but denyWrite moves');
  // The other hosts' logins and service state ride on `stores`: after npm's global config, before the browser
  // profiles, in denyRead and in the Read denies, and nothing else moves.
  const hostStores = credentialStores({ env: {}, home });
  const hidden = sandboxSettings({
    work: '/s/w', git: '/s/g', grants: ['/s/g', '/s/d', '/st/plans'], domains: ['github.com', 'api.github.com'], temp: ['/private/tmp', '/s/d'], home,
    config: '/cfg', platform: 'linux', main: '/m', mainGit: '/m/.git', secrets: ['NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY'], stores: ['/usr/local/etc/npmrc', ...hostStores],
  });
  const npm = stores.indexOf('/usr/local/etc/npmrc');
  const hiddenUnread = [...stores.slice(0, npm + 1), ...hostStores, ...stores.slice(npm + 1), '/m'];
  assert.deepEqual(hidden.sandbox.filesystem.denyRead, hiddenUnread);
  assert.deepEqual(hidden.permissions.deny, hiddenUnread.flatMap((each) => [`Read(/${each})`, `Read(/${each}/**)`]));
  const unreadAside = (value) => ({ ...value, permissions: null, sandbox: { ...value.sandbox, filesystem: { ...value.sandbox.filesystem, denyRead: null } } });
  assert.deepEqual(unreadAside(hidden), unreadAside(settings), 'nothing but the unread stores moves');
  for (const each of [path.join(home, '.codex', 'auth.json'), path.join(home, '.local', 'share', 'opencode'), path.join(home, '.config', 'opencode')]) assert.ok(hostStores.includes(each), each);
  // The proof reads them as the sandbox lists them: before the browser profiles, so none is pushed out by one.
  const proofReads = confineReads({ env: { PATH: '' }, home, stores: hostStores });
  const firstBrowser = proofReads.indexOf(path.join(home, BROWSER_PROFILES[0]));
  for (const each of hostStores) assert.ok(proofReads.indexOf(each) >= 0 && proofReads.indexOf(each) < firstBrowser, each);
  assert.equal(settings.sandbox.excludedCommands, undefined);
  assert.equal(settings.sandbox.network.allowUnixSockets, undefined);
  assert.ok(!settings.sandbox.filesystem.allowWrite.some((each) => each.endsWith('dispatch-log.jsonl')));
  assert.match(settings.permissions.deny[0], /^Read\(\/\/home\/u\/\.ssh\)$/u, 'an absolute Read rule takes //');
  const plain = sandboxSettings({ work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home, platform: 'darwin' });
  assert.equal(plain.sandbox.enableWeakerNetworkIsolation, true, 'only on macOS');
  // The git folder's placeholders and the nested .claude folder itself stay denied on every platform: on Linux a denial
  // holds a path there at launch, and the gate puts both placeholders there first.
  for (const each of [settings, plain]) {
    const [work, git] = each === plain ? ['/w', '/g'] : ['/s/w', '/s/g'];
    for (const denied of [`${git}/commondir`, `${git}/config.worktree`, `${work}/**/.claude`]) assert.ok(each.sandbox.filesystem.denyWrite.includes(denied), denied);
  }
  assert.equal(plain.sandbox.filesystem.allowRead, undefined, 'no main checkout named, nothing opened again');
  assert.ok(plain.sandbox.filesystem.denyRead.includes(path.join(home, '.claude', '.credentials.json')), 'the default config folder');
  assert.equal(sandboxSettings({ work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home, platform: 'linux', main: '/m', mainGit: '/elsewhere/git' }).sandbox.filesystem.allowRead, undefined,
    'a git folder outside the main checkout is not denied, so nothing is opened again');
  assert.deepEqual(CREDENTIAL_PATHS, [
    '.ssh', '.gnupg', '.aws', '.netrc', '.docker', '.kube', '.config/gcloud', '.azure', '.oci', 'Library/Keychains', '.password-store',
    '.config/op', '.1password', 'Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox',
    'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge', '.mozilla', '.config/google-chrome',
    '.config/chromium', '.git-credentials', '.npmrc', '.pypirc', '.cargo/credentials.toml', '.cargo/credentials', '.gem/credentials',
    '.vault-token', '.config/hub', '.claude.json', '.claude-trust-stage', '.claude/.credentials.json', '.claude/ide', '.local/share/keyrings',
    '.bash_history', '.zsh_history', '.local/share/fish',
    '.yarnrc.yml', '.yarnrc', '.config/npm/npmrc', '.bunfig.toml', '.local/share/gem/credentials', '.bundle/config',
    '.config/pnpm/rc', 'Library/Preferences/pnpm/rc', '.config/pip/pip.conf', '.pip/pip.conf', 'Library/Application Support/pip/pip.conf',
    '.config/pypoetry/auth.toml', 'Library/Application Support/pypoetry/auth.toml', '.local/share/uv/credentials',
  ]);
  // Each browser's profile folder, Chrome for Testing and headless Chrome under Google's included, is unreadable.
  const denied = sandboxSettings({ work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home, platform: 'linux' }).sandbox.filesystem.denyRead;
  for (const each of ['Library/Application Support/Google/Chrome for Testing', 'Library/Application Support/Google/Chrome-headless', 'Library/Application Support/Chromium', 'Library/Application Support/Arc', '.config/google-chrome-for-testing', '.config/google-chrome-canary', '.config/mozilla', 'snap/vivaldi', 'Library/Application Support/Microsoft Edge Dev', 'Library/Application Support/Vivaldi Snapshot', '.var/app/com.vivaldi.Vivaldi']) {
    const file = path.join(home, each);
    assert.ok(denied.some((store) => file === store || file.startsWith(`${store}/`)), each);
  }
  // The sandbox proof reads only the first stores it finds (project-confine.mjs READ_CAP), so the browser profiles come
  // after every other store, the host's own and npm's global config among them, and never push one out of the proof.
  const reads = confineReads({ env: { CLAUDE_CONFIG_DIR: '/cfg', npm_config_globalconfig: '/etc/npmrc' }, home });
  const browsers = BROWSER_PROFILES.map((each) => path.join(home, each));
  assert.deepEqual(reads.slice(-browsers.length), browsers);
  for (const each of ['/cfg/session-env', '/etc/npmrc', path.join(home, '.ssh')]) assert.ok(reads.indexOf(each) < reads.length - browsers.length, each);
  assert.ok(!CREDENTIAL_PATHS.includes('.config/gh'), 'the forge CLI\'s login stays readable');
  // Each registry token store is unreadable to a sandboxed command and to Read.
  for (const each of ['.yarnrc.yml', '.config/npm/npmrc', '.bunfig.toml', '.local/share/gem/credentials', '.npmrc', '.pypirc', '.cargo/credentials.toml', '.gem/credentials', '.bundle/config', '.config/pypoetry/auth.toml', '.local/share/uv/credentials']) {
    const file = path.join(home, each);
    assert.ok(settings.sandbox.filesystem.denyRead.includes(file), each);
    assert.ok(settings.permissions.deny.includes(`Read(/${file})`), each);
  }
  assert.ok(settings.sandbox.filesystem.denyRead.includes('/usr/local/etc/npmrc'), 'npm\'s global config');
});

test('every credential-named variable is unset in the sandbox, and the well-known ones, but the forge\'s own token', () => {
  const env = { PATH: '/bin', HOME: '/h', GH_TOKEN: 'x', GITHUB_TOKEN: 'x', STRIPE_SECRET_KEY: 'x', DB_PASSWORD: 'x', MY_API_KEY: 'x', SENTRY_AUTH_TOKEN: 'x', LANG: 'C', 'BAD-NAME_TOKEN': 'x' };
  const unset = secretVars(env, forgeTokenVars());
  for (const name of ['STRIPE_SECRET_KEY', 'DB_PASSWORD', 'MY_API_KEY', 'SENTRY_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK']) assert.ok(unset.includes(name), name);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'PATH', 'HOME', 'LANG', 'BAD-NAME_TOKEN']) assert.ok(!unset.includes(name), name);
  assert.deepEqual(forgeTokenVars(), ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']);
});

test('the forge\'s network hosts: github.com and its API host, or an Enterprise host alone', () => {
  assert.deepEqual(forgeDomains({ host: 'github.com', owner: 'a', name: 'b' }), ['github.com', 'api.github.com']);
  assert.deepEqual(forgeDomains({ host: 'git.example.com', owner: 'a', name: 'b' }), ['git.example.com']);
});

test('the adapter starts claude --bg under the sandbox settings and only the team\'s MCP servers, and holds the session on its beacon', (t) => {
  const fx = runFixture(t, { init: false });
  const { root, cwd, git, drop } = folders(t, fx);
  const calls = [];
  let beacons = 0;
  const claude = fakeClaude({ dir: fx.dir });
  const run = (command, args, options) => {
    calls.push(args);
    return claude.run(command, args, options);
  };
  const identified = [];
  const env = { ...fx.env, STRIPE_SECRET_KEY: 's', GH_TOKEN: 't' };
  const main = path.join(root, 'main');
  mkdirSync(path.join(main, '.git'), { recursive: true });
  const start = (more = {}) => startProject({
    session: DRIVER, cwd, prompt: 'Project run launch, issue ENG-1: work it.', name: 'launch · ENG-1 · 1', env, hold: () => true,
    identify: (each) => identified.push(each) > 0, beacon: () => {
      beacons += 1;
      return beacons > 3;
    }, sandbox: { git, grants: [git, drop], domains: ['github.com', 'api.github.com'], main, mainGit: path.join(main, '.git'), tokens: forgeTokenVars() },
    mcp: { tracker: { command: 'tracker-mcp' } }, home: fx.home, platform: 'linux', run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits', ...more,
  });
  const started = start();
  assert.equal(started.problem, undefined, started.problem);
  assert.equal(started.session, STARTED[0].session);
  assert.deepEqual(identified, [{ id: STARTED[0].id, session: STARTED[0].session }], 'filed before the beacon wait');
  const args = calls.find((each) => each[0] === '--bg');
  const prompt = args.at(-1);
  assert.equal(prompt, 'Project run launch, issue ENG-1: work it.');
  assert.equal(args.at(-2), '--', 'the prompt follows `--`, so --mcp-config, which takes several values, never reads it as a config');
  const at = (flag) => args.indexOf(flag);
  for (const flag of ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config']) assert.ok(at(flag) > 0 && at(flag) < args.length - 1, `${flag} before the prompt`);
  assert.equal(args[at('--setting-sources') + 1], 'user');
  const passed = JSON.parse(args[at('--settings') + 1]);
  assert.deepEqual(passed, sandboxSettings({
    work: cwd, git, grants: [git, drop], domains: ['github.com', 'api.github.com'], temp: passed.sandbox.filesystem.allowWrite.slice(2), home: fx.home,
    config: configFolder(env, fx.home), platform: 'linux', main, mainGit: path.join(main, '.git'), secrets: secretVars(env, forgeTokenVars()), stores: npmGlobalConfigs(env),
  }));
  assert.ok(passed.sandbox.filesystem.allowWrite.includes(realpathSync('/tmp')), 'the real /tmp');
  assert.ok(passed.sandbox.credentials.envVars.some((each) => each.name === 'STRIPE_SECRET_KEY'), 'a secret of the driver\'s environment');
  assert.ok(!passed.sandbox.credentials.envVars.some((each) => each.name === 'GH_TOKEN'), 'the forge token stays');
  assert.equal(passed.disableClaudeAiConnectors, true);
  assert.deepEqual(JSON.parse(args[at('--mcp-config') + 1]), mcpConfig({ tracker: { command: 'tracker-mcp' } }));
  assert.deepEqual(mcpConfig(undefined), { mcpServers: {} });

  // A clone in the main checkout, which the session may not read, starts nothing.
  const inside = fakeClaude({ dir: fx.dir });
  const refused = startProject({
    session: DRIVER, cwd, prompt: 'Work it.', name: 'launch · ENG-1 · 1', env, hold: () => true, identify: () => true, beacon: () => true,
    sandbox: { git, grants: [git, drop], domains: ['github.com'], main: root }, home: fx.home, platform: 'linux', run: inside.run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits',
  });
  assert.match(refused.problem, /lies in the main checkout .*which a confined session may not read; set state\.dir to a folder outside it/u);
  assert.deepEqual(inside.starts(), []);
});

test('a start whose beacon never comes stops the session and names the proof; one with bad folders runs no claude --bg', (t) => {
  const fx = runFixture(t, { init: false });
  const { cwd, git, drop, root } = folders(t, fx);
  const claude = fakeClaude({ dir: fx.dir });
  const base = {
    session: DRIVER, cwd, prompt: 'Work it.', name: 'launch · ENG-1 · 1', env: fx.env, hold: () => true, identify: () => true, beacon: () => false,
    sandbox: { git, grants: [git, drop], domains: ['github.com'] }, mcp: {}, home: fx.home, platform: 'linux', run: claude.run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits',
  };
  const silent = startProject(base);
  assert.equal(silent.proof, 'beacon');
  assert.equal(silent.uncertain, false);
  assert.match(silent.problem, /the plugin's agent gate hook did not run on the session's first tool call within 180 seconds.*the session was stopped/u);
  assert.deepEqual(claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id]);

  for (const [sandbox, why] of [
    [{ git, grants: [drop], domains: ['github.com'] }, /the clone's git folder is not among the folders the gate grants/u],
    [{ git: 'relative/git', grants: [git], domains: ['github.com'] }, /not an absolute path of plain text/u],
    [{ git, grants: [git, path.join(root, 'missing')], domains: ['github.com'] }, /cannot be resolved \(ENOENT\)/u],
    [{ git, grants: [git], domains: ['github.com; rm -rf /'] }, /are not host names/u],
    [{ git, grants: [git], domains: [] }, /are not host names/u],
    [{ git, grants: [git], domains: ['github.com'], main: 'relative' }, /the main checkout the gate names is not an absolute path/u],
    [{ git, grants: [git], domains: ['github.com'], main: path.join(root, 'gone') }, /the main checkout the gate names cannot be resolved/u],
    ...[
      { paths: '.opencode', globs: [] }, { paths: [], globs: null }, { paths: [] }, { paths: [''], globs: [] }, { paths: ['/etc/opencode.json'], globs: [] },
      { paths: [], globs: ['../**/.opencode'] }, { paths: ['a/../../x'], globs: [] }, { paths: ['a\\..\\x'], globs: [] }, { paths: ['.opencode\n'], globs: [] },
      { paths: [], globs: ['**/x\u0007'] }, { paths: [7], globs: [] }, 'files',
    ].map((hostFiles) => [{ git, grants: [git], domains: ['github.com'], hostFiles }, /a host file the gate denies the session is not a relative path of plain text inside its clone/u]),
    ...['/x/auth.json', ['relative/auth.json'], [''], ['/x/../etc/passwd'], ['/x/a\n'], [7], {}].map((hostStores) => [
      { git, grants: [git], domains: ['github.com'], hostStores }, /a host's login or service state the gate hides from the session is not an absolute path of plain text/u,
    ]),
    [undefined, /named no sandbox/u],
  ]) {
    const fresh = fakeClaude({ dir: fx.dir });
    const result = startProject({ ...base, sandbox, run: fresh.run });
    assert.match(result.problem, why, JSON.stringify(sandbox));
    assert.deepEqual(fresh.calls, [], 'no claude call at all');
  }
});

test('a start takes consent from the runs folder the run names, not one walked up from the clone\'s real path', (t) => {
  const fx = runFixture(t, { init: false });
  const { root, cwd, git } = folders(t);
  // The run names its runs folder through a link, and the Human trusted that spelling alone.
  const link = `${root}-linked`;
  symlinkSync(root, link);
  t.after(() => rmSync(link, { force: true }));
  const runs = path.join(link, 'runs');
  const record = path.join(fx.env.CLAUDE_CONFIG_DIR, '.claude.json');
  writeFileSync(record, JSON.stringify({ projects: { [runs]: { hasTrustDialogAccepted: true } } }));
  const claude = fakeClaude({ dir: fx.dir });
  const start = (more) => startProject({
    session: DRIVER, cwd, prompt: 'Work it.', name: 'launch · ENG-1 · 1', env: fx.env, hold: () => true, identify: () => true, beacon: () => true,
    sandbox: { git, grants: [git], domains: ['github.com'] }, home: fx.home, platform: 'linux', run: claude.run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits', ...more,
  });
  const fallback = start({});
  assert.match(fallback.problem ?? '', /trusts neither the runs folder/u, 'walked up from the clone, the link spelling is never met');
  const named = start({ runs });
  assert.equal(named.problem, undefined, named.problem);
  assert.equal(JSON.parse(readFileSync(record, 'utf8')).projects[cwd].hasTrustDialogAccepted, true, 'the clone is recorded under its real path');
});

test('a start the host refuses for an untrusted folder names the trust step: the runs folder, never the whole state folder', (t) => {
  const fx = runFixture(t, { init: false });
  const { root, cwd, git } = folders(t, fx);
  const claude = fakeClaude({ dir: fx.dir, start: () => ({ status: 1, stdout: '', stderr: 'Error: Workspace not trusted', listed: false }) });
  const result = startProject({
    session: DRIVER, cwd, prompt: 'Work it.', name: 'launch · ENG-1 · 1', env: fx.env, hold: () => true, identify: () => true, beacon: () => true,
    sandbox: { git, grants: [git], domains: ['github.com'] }, home: fx.home, platform: 'linux', run: claude.run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits',
  });
  assert.equal(result.uncertain, false);
  assert.match(result.problem, new RegExp(`Workspace not trusted; trust the project's runs folder, ${escaped(path.join(root, 'runs'))}, once by running \`claude\` there`, 'u'));
});

test('the handoff\'s background start passes no sandbox, setting sources, or MCP flags', (t) => {
  const fx = runFixture(t, { init: false });
  const claude = fakeClaude({ dir: fx.dir });
  const started = startBackground({ session: DRIVER, slug: 'brief', chain: 1, efforts: [], prompt: 'Resume the brief.', env: fx.env, hold: () => true, run: claude.run, wait: () => {}, resolve: () => '/bin/claude', readMode: () => 'acceptEdits' });
  assert.equal(started.problem, undefined);
  const [args] = claude.starts().map((call) => call.args);
  for (const flag of ['--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config']) assert.ok(!args.includes(flag), flag);
});

test('a start on Claude Code works in a fresh clone with a drop and its placeholders, never a linked worktree, and prints the unverified line', (t) => {
  const fx = runFixture(t);
  const before = fx.git('worktree', 'list', '--porcelain');
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.match(result.out[0], /^unverified: this host's project start is checked on fixtures only \(fixtures and the host docs; no live run\)/u);
  const row = fx.rows().find((each) => each.event === 'start' && each.outcome === 'started');
  assert.deepEqual([row.cwd, row.drop], [work(fx), path.join(path.dirname(work(fx)), 'drop')]);
  assert.equal(fx.git('worktree', 'list', '--porcelain'), before, 'git worktree list is unchanged');
  // The placeholders, made before the launch, so a sandbox that denies only a path there at launch holds each.
  const git = path.join(path.dirname(work(fx)), 'git');
  assert.equal(lstatSync(path.join(git, 'config.worktree')).size, 0, 'an empty config.worktree');
  for (const file of ['.claude/settings.json', '.claude/settings.local.json', '.mcp.json']) assert.equal(readFileSync(path.join(work(fx), file), 'utf8'), '{}\n', file);
  for (const folder of ['skills', 'agents', 'commands', 'hooks', 'workflows']) assert.ok(lstatSync(path.join(work(fx), '.claude', folder)).isDirectory(), folder);
  assert.throws(() => lstatSync(path.join(work(fx), '.claude/scheduled_tasks.json')), /ENOENT/u, 'no scheduled tasks file');
  // The other hosts' root files too, each file excluded beside Claude Code's, so none shows as a change.
  assert.deepEqual(readdirSync(path.join(work(fx), '.opencode')), [], 'an empty .opencode folder');
  assert.deepEqual(readdirSync(path.join(work(fx), '.agents')), [], 'an empty .agents folder');
  for (const file of ['opencode.json', 'opencode.jsonc']) assert.equal(readFileSync(path.join(work(fx), file), 'utf8'), '{}\n', file);
  const excluded = readFileSync(path.join(git, 'info', 'exclude'), 'utf8').split('\n');
  for (const line of ['/.claude/settings.json', '/.mcp.json', '/opencode.json', '/opencode.jsonc']) assert.ok(excluded.includes(line), line);
  assert.ok(!excluded.some((line) => /\.agents/u.test(line)), 'an empty folder git never shows needs no exclude line');
  // A commondir that names the git folder itself, which git reads as no other folder, so the denial holds it by path.
  assert.equal(readFileSync(path.join(git, 'commondir'), 'utf8'), GIT_PLACEHOLDERS.commondir);
  assert.equal(GIT_PLACEHOLDERS.commondir, '.\n');
  assert.equal(lstatSync(path.join(git, 'commondir')).nlink, 1);
  assert.equal(fx.git('-C', work(fx), 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(), realpathSync(git), 'git reads the git folder itself as the common one');
  assert.equal(fx.git('-C', work(fx), 'status', '--porcelain', '--untracked-files=all'), '', 'no placeholder shows as a change');
  // A tracked settings file is the base branch's own, and stays as it is.
  const tracked = runFixture(t, { files: { '.claude/settings.json': '{"permissions":{}}' } });
  assert.equal(tracked.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(readFileSync(path.join(work(tracked), '.claude/settings.json'), 'utf8'), '{"permissions":{}}');
  // So is a tracked opencode.json, with no exclude line of its own.
  const own = runFixture(t, { files: { 'opencode.json': '{"plugin":[]}\n' } });
  assert.equal(own.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(readFileSync(path.join(work(own), 'opencode.json'), 'utf8'), '{"plugin":[]}\n');
  const ownExcluded = readFileSync(path.join(path.dirname(work(own)), 'git', 'info', 'exclude'), 'utf8').split('\n');
  assert.ok(!ownExcluded.includes('/opencode.json') && ownExcluded.includes('/opencode.jsonc'), 'only the file the clone lacked');
  assert.equal(own.git('-C', work(own), 'status', '--porcelain', '--untracked-files=all'), '');
  // And a tracked .agents folder's file, as a Codex marketplace is.
  const market = runFixture(t, { files: { '.agents/plugins/marketplace.json': '{"plugins":[]}\n' } });
  assert.equal(market.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.equal(readFileSync(path.join(work(market), '.agents/plugins/marketplace.json'), 'utf8'), '{"plugins":[]}\n');
  assert.equal(market.git('-C', work(market), 'status', '--porcelain', '--untracked-files=all'), '');
});

test('a clone that tracks another host\'s root file as a link is refused at start, and nothing is written through the link', (t) => {
  // The folder links to a folder, the config file to a file: the placeholder would write {} through either.
  for (const [name, target] of [['.opencode', 'shared'], ['opencode.jsonc', 'shared/keep.md'], ['.agents', 'shared']]) {
    const fx = runFixture(t, { files: { 'shared/keep.md': 'x\n' }, links: { [name]: target } });
    const result = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(result.exitCode, 1, name);
    assert.match([...result.out, ...result.err].join('\n'), new RegExp(`holds ${escaped(name)}, a link, where its placeholder ${escaped(name)} goes.*replace the link with the folder`, 'u'), name);
    assert.deepEqual(fx.claude.starts(), [], `${name}: no claude --bg`);
    assert.deepEqual(readdirSync(path.join(work(fx), 'shared')), ['keep.md'], `${name}: the link's target folder is untouched`);
    assert.equal(readFileSync(path.join(work(fx), 'shared', 'keep.md'), 'utf8'), 'x\n', `${name}: the link's target file is untouched`);
  }
});

test('a clone whose index holds a link at another host\'s file below its root is refused at start, and nothing is written through the link', (t) => {
  for (const [name, target] of [['pkg/.opencode', '../shared'], ['pkg/opencode.json', '../shared/keep.md'], ['a/b/.OpenCode', '../../shared']]) {
    const fx = runFixture(t, { files: { 'shared/keep.md': 'x\n' }, links: { [name]: target } });
    const result = fx.cmd(['start', 'launch', 'ENG-1']);
    assert.equal(result.exitCode, 1, name);
    assert.match([...result.out, ...result.err].join('\n'), new RegExp(`holds ${escaped(name)}, a link, where a host loads its files from any depth.*replace the link with the folder`, 'u'), name);
    assert.deepEqual(fx.claude.starts(), [], `${name}: no claude --bg`);
    assert.deepEqual(readdirSync(path.join(work(fx), 'shared')), ['keep.md'], `${name}: the link's target folder is untouched`);
    assert.equal(readFileSync(path.join(work(fx), 'shared', 'keep.md'), 'utf8'), 'x\n', `${name}: the link's target file is untouched`);
  }
  // A plain folder of that name, and a link elsewhere, start as before.
  const plain = runFixture(t, { files: { 'pkg/.opencode/keep.md': 'x\n', 'shared/keep.md': 'x\n' }, links: { 'pkg/docs': '../shared' } });
  assert.equal(plain.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
});

test('projectRun.registries is a closed list of ecosystems, each to the fixed hosts its official clients install from', (t) => {
  assert.deepEqual(REGISTRIES, {
    npm: ['registry.npmjs.org', 'registry.yarnpkg.com'],
    pypi: ['pypi.org', 'files.pythonhosted.org'],
    crates: ['index.crates.io', 'static.crates.io'],
    go: ['proxy.golang.org', 'sum.golang.org'],
    rubygems: ['index.rubygems.org', 'rubygems.org'],
  });
  assert.deepEqual(REGISTRY_NAMES, ['npm', 'pypi', 'crates', 'go', 'rubygems']);
  assert.deepEqual(registryHosts(['go', 'npm', 'registry.example.com']), ['registry.npmjs.org', 'registry.yarnpkg.com', 'proxy.golang.org', 'sum.golang.org'], 'in the map\'s order; a name it does not hold adds no host');
  assert.deepEqual(registryHosts(undefined), []);
  for (const each of [[], ['npm'], [...REGISTRY_NAMES]]) assert.equal(isRegistries(each), true, JSON.stringify(each));
  for (const each of [['registry.example.com'], ['npm', 'npm'], 'npm', [null], ['NPM']]) assert.equal(isRegistries(each), false, JSON.stringify(each));
  // A config names an ecosystem, never a host: anything else is an error, and the default, none, stands.
  const fx = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, registries: ['npm', 'evil.example'] }, init: false });
  const { config, errors } = loadConfig(fx.project);
  assert.match(errors.join('\n'), /"projectRun\.registries" must be a list of registry names, each once, from "npm", "pypi", "crates", "go", or "rubygems"/u);
  assert.deepEqual(config.projectRun.registries, []);
  const good = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, registries: ['pypi', 'npm'] }, init: false });
  assert.deepEqual(loadConfig(good.project).config.projectRun.registries, ['pypi', 'npm']);
});

test('the cache variables put every package manager\'s cache, global store, and npm config in the attempt\'s cache folder, and corepack there only with npm listed', () => {
  const vars = cacheVars('/a/cache', { GOFLAGS: '-mod=mod  -modcacherw' });
  assert.deepEqual(vars, {
    npm_config_cache: '/a/cache/npm',
    npm_config_userconfig: '/a/cache/npm-user.npmrc',
    NPM_CONFIG_USERCONFIG: '/a/cache/npm-user.npmrc',
    npm_config_globalconfig: '/a/cache/npm-global.npmrc',
    NPM_CONFIG_GLOBALCONFIG: '/a/cache/npm-global.npmrc',
    PNPM_HOME: '/a/cache/pnpm',
    pnpm_config_store_dir: '/a/cache/pnpm/store',
    pnpm_config_cache_dir: '/a/cache/pnpm-cache',
    pnpm_config_state_dir: '/a/cache/pnpm-state',
    YARN_CACHE_FOLDER: '/a/cache/yarn',
    YARN_GLOBAL_FOLDER: '/a/cache/yarn-global',
    PIP_CACHE_DIR: '/a/cache/pip',
    UV_CACHE_DIR: '/a/cache/uv',
    CARGO_HOME: '/a/cache/cargo',
    GOPATH: '/a/cache/go',
    GOMODCACHE: '/a/cache/go/pkg/mod',
    GOCACHE: '/a/cache/go-build',
    GOFLAGS: '-mod=mod -modcacherw',
    GEM_HOME: '/a/cache/gem',
    BUNDLE_USER_HOME: '/a/cache/bundle',
  });
  for (const [name, value] of Object.entries(vars)) if (name !== 'GOFLAGS') assert.ok(value.startsWith('/a/cache/'), name);
  for (const kept of ['HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'COREPACK_HOME', 'COREPACK_NPM_REGISTRY', 'BUNDLE_PATH', 'npm_config_store_dir']) assert.equal(vars[kept], undefined, `${kept} stays as it is`);
  assert.equal(cacheVars('/a/cache').GOFLAGS, '-modcacherw');
  // With npm listed, corepack downloads pnpm and yarn into the cache, from the listed npm registry alone.
  const npm = cacheVars('/a/cache', {}, { registries: ['pypi', 'npm'] });
  assert.deepEqual([npm.COREPACK_HOME, npm.COREPACK_NPM_REGISTRY], ['/a/cache/corepack', 'https://registry.npmjs.org']);
  assert.equal(new URL(npm.COREPACK_NPM_REGISTRY).host, REGISTRIES.npm[0]);
  assert.equal(cacheVars('/a/cache', {}, { registries: ['pypi'] }).COREPACK_HOME, undefined);
  // A shell's variable names, shared with the host adapter.
  assert.equal(ENV_NAME.test('npm_config_cache'), true);
  assert.equal(ENV_NAME.test('a-b'), false);
  // The settings take no package manager variable: `env` would reach the host's hooks and MCP servers.
  const base = { work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home: '/home/u', platform: 'linux' };
  assert.equal(Object.hasOwn(sandboxSettings({ ...base, cacheVars: vars }), 'env'), false);
});

test('a start on Claude Code reaches the registries both reads of the default branch list, and keeps every cache in the attempt\'s folder for its sandboxed commands alone', (t) => {
  const settingsOf = (fx) => {
    const [{ args }] = fx.claude.starts();
    return { text: args[args.indexOf('--settings') + 1], value: JSON.parse(args[args.indexOf('--settings') + 1]) };
  };
  const forge = forgeDomains({ host: 'github.com' });
  const listed = { allow: true, unverifiedHosts: true, registries: ['npm', 'pypi'] };
  const fx = runFixture(t, { projectRun: listed });
  // Another host's login, which the per-start proof must find unreadable from inside the session.
  const login = path.join(fx.home, '.codex', 'auth.json');
  mkdirSync(path.dirname(login), { recursive: true });
  writeFileSync(login, '{}');
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const attempt = path.dirname(work(fx));
  const proved = JSON.parse(readFileSync(path.join(attempt, CONFINE_PLAN), 'utf8'));
  assert.ok(proved.reads.some((each) => each.path === login), 'the proof tries to read the other host\'s login');
  const cache = path.join(attempt, 'cache');
  const { text, value: settings } = settingsOf(fx);
  // Every host's files under the clone are denied too: the gate passes their union.
  for (const each of otherDenied(realpathSync(work(fx)))) assert.ok(settings.sandbox.filesystem.denyWrite.includes(each), each);
  // And every host's logins and service state go unread, by a sandboxed command and by Read.
  const stores = credentialStores({ env: fx.env, home: fx.home });
  for (const each of [path.join(fx.home, '.codex', 'auth.json'), path.join(fx.home, '.local', 'share', 'opencode'), path.join(fx.home, '.local', 'state', 'opencode'), path.join(fx.home, '.config', 'opencode')]) {
    assert.ok(stores.includes(each), each);
  }
  for (const each of stores) {
    assert.ok(settings.sandbox.filesystem.denyRead.includes(each), each);
    assert.ok(settings.permissions.deny.includes(`Read(/${each})`), each);
  }
  assert.deepEqual(settings.sandbox.network.allowedDomains, [...forge, ...REGISTRIES.npm, ...REGISTRIES.pypi]);
  assert.equal(settings.sandbox.network.strictAllowlist, true);
  assert.deepEqual(Object.keys(settings.env ?? {}), ['AIDRIAN_START_CLAIM'], 'no settings env but the start\'s claim, since the host\'s hooks and MCP servers get it');
  assert.doesNotMatch(text, /npm_config_cache|GOMODCACHE|PNPM_HOME/u);
  assert.ok(settings.sandbox.filesystem.allowWrite.includes(realpathSync(cache)), 'the cache folder is writable');
  assert.equal(lstatSync(cache).mode & 0o777, 0o700, 'owner-only');
  assert.deepEqual(readdirSync(cache).sort(), ['.keep-attempt', 'npm-global.npmrc', 'npm-user.npmrc']);
  for (const name of ['npm-global.npmrc', 'npm-user.npmrc']) assert.equal(readFileSync(path.join(cache, name), 'utf8'), '', `${name} is empty`);
  // The keep files of drop and cache, there before the launch, whose write the sandbox denies.
  for (const name of ['drop', 'cache']) {
    const keep = path.join(attempt, name, '.keep-attempt');
    assert.equal(lstatSync(keep).isFile(), true, keep);
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(path.join(realpathSync(attempt), name, '.keep-attempt')), keep);
  }
  // The variables wait in the attempt's folder, which no confined session writes, for the SessionStart hook, with the
  // attempt's marker, which the sandbox proof waits for.
  const { [ATTEMPT_ENV]: launched, ...written } = JSON.parse(readFileSync(path.join(attempt, SHELL_VARS), 'utf8'));
  assert.deepEqual(written, cacheVars(cache, fx.env, { registries: ['npm', 'pypi'] }));
  assert.match(launched, /^launch\/ENG-1\.1\/[0-9a-f]{16}$/u, 'the launch\'s marker');
  assert.equal(lstatSync(path.join(attempt, SHELL_VARS)).mode & 0o777, 0o600);

  // A registry only one read lists is not reached: a working copy or the forge alone widens nothing.
  const half = runFixture(t, { projectRun: { ...listed, registries: ['npm', 'go'] }, forgeConfig: { version: 1, projectRun: { ...listed, registries: ['go', 'crates'] } } });
  assert.equal(half.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.deepEqual(settingsOf(half).value.sandbox.network.allowedDomains, [...forge, ...REGISTRIES.go]);
  assert.equal(JSON.parse(readFileSync(path.join(path.dirname(work(half)), SHELL_VARS), 'utf8')).COREPACK_HOME, undefined, 'npm is not listed by both');

  // None listed, the default: the forge's hosts only, and the caches still in the attempt's folder.
  const none = runFixture(t);
  assert.equal(none.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  assert.deepEqual(settingsOf(none).value.sandbox.network.allowedDomains, forge);
  const { [ATTEMPT_ENV]: noneMarker, ...noneVars } = JSON.parse(readFileSync(path.join(path.dirname(work(none)), SHELL_VARS), 'utf8'));
  assert.deepEqual(noneVars, cacheVars(path.join(path.dirname(work(none)), 'cache'), none.env));
  assert.match(noneMarker, /^launch\/ENG-1\.1\/[0-9a-f]{16}$/u);
});

test('the SessionStart hook hands the cache variables to the sandboxed commands of a confined attempt\'s session alone, through the host\'s session environment file', (t) => {
  const fx = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, registries: ['npm'] } });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const attempt = path.dirname(work(fx));
  const vars = JSON.parse(readFileSync(path.join(attempt, SHELL_VARS), 'utf8'));
  const hook = (session, cwd, file) => spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...fx.env, CLAUDE_ENV_FILE: file, CLAUDE_CODE_SESSION_ID: session }, encoding: 'utf8',
  });
  // A name the gate never writes is dropped, as one the file might hold.
  writeFileSync(path.join(attempt, SHELL_VARS), JSON.stringify({ ...vars, EVIL: 'x' }));
  const file = path.join(fx.root, 'session-env', 'own.sh');
  mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(hook(STARTED[0].session, work(fx), file).status, 0);
  const text = readFileSync(file, 'utf8');
  assert.match(text, /^export npm_config_cache='/mu);
  // What a sandboxed Bash command of the session sees once the host sources the file.
  const seen = spawnSync('/bin/sh', ['-c', `. '${file}'; printf '%s\\n' "$npm_config_cache" "$GOFLAGS" "$COREPACK_NPM_REGISTRY" "$AIDRIAN_ATTEMPT_ENV"`], { encoding: 'utf8' });
  assert.deepEqual(seen.stdout.split('\n'), [vars.npm_config_cache, vars.GOFLAGS, 'https://registry.npmjs.org', '', ''], 'no marker: this hook lacks the start\'s claim');
  assert.match(vars[ATTEMPT_ENV], /^launch\/ENG-1\.1\/[0-9a-f]{16}$/u);
  assert.doesNotMatch(text, /EVIL/u, 'only the names cacheVars gives');
  // A folder shaped like an attempt's inside the clone, which the session may write, hands over nothing, though the
  // session's own mark names that run and issue.
  const crafted = path.join(work(fx), 'x', 'runs', 'launch', 'attempts', 'ENG-1.9');
  mkdirSync(path.join(crafted, 'work'), { recursive: true });
  writeFileSync(path.join(crafted, SHELL_VARS), JSON.stringify({ npm_config_cache: '/evil' }));
  const craftedFile = path.join(fx.root, 'session-env', 'crafted.sh');
  assert.equal(hook(STARTED[0].session, path.join(crafted, 'work'), craftedFile).status, 0);
  assert.throws(() => readFileSync(craftedFile), /ENOENT/u, 'nothing from the crafted folder');
  // Another session in that clone, with no mark naming the attempt, and a session elsewhere get nothing.
  for (const [session, cwd] of [['abcd1234-0000-4000-8000-00000000ff01', work(fx)], [STARTED[0].session, fx.dir]]) {
    const other = path.join(fx.root, 'session-env', `${session}-${path.basename(cwd)}.sh`);
    assert.equal(hook(session, cwd, other).status, 0);
    assert.throws(() => readFileSync(other), /ENOENT/u, `${session} in ${cwd}`);
  }
});

test('the session environment file quotes each value for the shell, and writes nothing through a link or for a name a shell does not take', (t) => {
  const { root } = folders(t);
  const file = path.join(root, 'env.sh');
  const vars = { A_QUOTE: "it's here", SPACED: '/a b/$HOME/`x`', GOFLAGS: '-mod=mod -modcacherw' };
  assert.equal(writeEnvFile(file, vars), true);
  assert.equal(writeEnvFile(file, { LATER: 'x' }), true, 'appended');
  const seen = spawnSync('/bin/sh', ['-c', `. '${file}'; printf '%s\\n' "$A_QUOTE" "$SPACED" "$GOFLAGS" "$LATER"`], { encoding: 'utf8' });
  assert.deepEqual(seen.stdout.split('\n').slice(0, 4), ["it's here", '/a b/$HOME/`x`', '-mod=mod -modcacherw', 'x']);
  const target = path.join(root, 'target.sh');
  writeFileSync(target, '');
  symlinkSync(target, path.join(root, 'link.sh'));
  assert.equal(writeEnvFile(path.join(root, 'link.sh'), vars), false);
  assert.equal(readFileSync(target, 'utf8'), '', 'nothing through the link');
  for (const bad of [{ 'a-b': 'x' }, { A: 'x\ny' }, {}]) assert.equal(writeEnvFile(path.join(root, 'bad.sh'), bad), false, JSON.stringify(bad));
  assert.equal(writeEnvFile('relative.sh', vars), false);
  assert.equal(writeEnvFile(undefined, vars), false);
});

test('npm\'s global config files are read from the prefix the environment names and the one npm on PATH lies under', (t) => {
  const { root } = folders(t);
  const bin = path.join(root, 'prefix', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
  assert.deepEqual(npmGlobalConfigs({ PATH: `relative${path.delimiter}${bin}`, NPM_CONFIG_PREFIX: '/opt/npm' }), ['/opt/npm/etc/npmrc', path.join(root, 'prefix', 'etc', 'npmrc')]);
  assert.deepEqual(npmGlobalConfigs({ PATH: '', npm_config_prefix: 'relative' }), []);
  // The user and global config files the driver's npm variables name, in either case, join them.
  assert.deepEqual(npmGlobalConfigs({ PATH: '', npm_config_userconfig: '/work/.npmrc-ci', NPM_CONFIG_GLOBALCONFIG: '/etc/npmrc-ci', NPM_CONFIG_USERCONFIG: 'relative' }), ['/work/.npmrc-ci', '/etc/npmrc-ci']);
  const settings = sandboxSettings({ work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home: '/home/u', platform: 'linux', stores: npmGlobalConfigs({ PATH: '', npm_config_userconfig: '/work/.npmrc-ci' }) });
  assert.ok(settings.sandbox.filesystem.denyRead.includes('/work/.npmrc-ci'));
  assert.ok(settings.permissions.deny.includes('Read(//work/.npmrc-ci)'));
});

test('a start halts unless the default branch sets projectRun.unverifiedHosts', (t) => {
  const fx = runFixture(t, { projectRun: { allow: true } });
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.match(result.out[0], /^halt this host's project start is not verified on a live host/u);
  assert.match(result.out[1], /^unverified: /u);
  assert.deepEqual(fx.claude.starts(), []);
});

test('a host whose project start is not confined halts', (t) => {
  const cap = claudeCode.capabilities.projectStart;
  cap.confined = false;
  t.after(() => {
    cap.confined = true;
  });
  const fx = runFixture(t);
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /not confined to a fresh clone under its own sandbox/u);
});

test('a start whose session never files the beacon gives the attempt back and halts the run', (t) => {
  const fx = runFixture(t);
  const claude = fakeClaude({ dir: fx.dir, env: fx.env, beacon: false });
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
  assert.equal(result.exitCode, 1);
  assert.match(result.out.find((line) => line.startsWith('halt ')), /failed its proof: the plugin's agent gate hook did not run/u);
  const rows = fx.rows();
  assert.deepEqual([rows.at(-3).outcome, rows.at(-3).proof, rows.at(-2).state, rows.at(-1).event], ['void', true, 'open', 'halt']);
  assert.deepEqual(claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id]);
});

test('a start halts, recording nothing, unless the user\'s settings enable this plugin or install it at user scope', (t) => {
  const project = runFixture(t);
  installed(project, { [OWN_PLUGIN]: [{ scope: 'project', projectPath: project.dir, installPath: OWN.installPath }] });
  halted(project, project.cmd(['start', 'launch', 'ENG-1']), /this plugin is not enabled in the host's user settings.*`claude plugin install aidrian@<marketplace> --scope user`.*"enabledPlugins": \{ "aidrian@<marketplace>": true \}/u);
  const none = runFixture(t);
  installed(none, {});
  halted(none, none.cmd(['start', 'launch', 'ENG-1']), /this plugin is not enabled/u);
  const off = runFixture(t);
  userSettings(off, { enabledPlugins: { [OWN_PLUGIN]: false } });
  halted(off, off.cmd(['start', 'launch', 'ENG-1']), /this plugin is not enabled/u);
  const enabled = runFixture(t);
  installed(enabled, { [OWN_PLUGIN]: [{ scope: 'project', projectPath: enabled.dir, installPath: OWN.installPath }] });
  userSettings(enabled, { enabledPlugins: { [OWN_PLUGIN]: true } });
  assert.equal(enabled.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, 'enabled in the user\'s settings');
});

// The default branch revokes the exception after the base ref this checkout holds: the start pins the base tip, reads
// the policy once at that commit, and judges the user's settings by it, as it would a start after the revoke.
test('an outsideSandbox exception the default branch revokes before the pin no longer lets the user\'s settings through', (t) => {
  const fx = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: ['apiKeyHelper'] } });
  userSettings(fx, { apiKeyHelper: '/bin/key' });
  const main = path.join(fx.root, 'main-moves');
  execFileSync('git', ['clone', '-q', fx.bare, main], { stdio: 'pipe' });
  writeFileSync(path.join(main, '.aidrian/config.json'), `${JSON.stringify({ ...fx.committed, projectRun: { allow: true, unverifiedHosts: true } })}\n`);
  fx.git('-C', main, 'commit', '-q', '-am', 'revoke the exception');
  fx.git('-C', main, 'push', '-q', fx.bare, 'HEAD:refs/heads/main');
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /set apiKeyHelper/u);
});

test('user settings that run a command outside the sandbox, or any other plugin, halt the start unless projectRun.outsideSandbox names them', (t) => {
  for (const [settings, cause, name] of [
    [{ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] } }, /user settings set hooks, a command the host runs outside the sandbox/u, 'hooks'],
    [{ apiKeyHelper: '/bin/key' }, /set apiKeyHelper/u, 'apiKeyHelper'],
    [{ statusLine: { type: 'command', command: 'x' } }, /set statusLine/u, 'statusLine'],
  ]) {
    const fx = runFixture(t);
    userSettings(fx, settings);
    halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), cause);
    const allowed = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: [name] } });
    userSettings(allowed, settings);
    assert.equal(allowed.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, name);
  }
  // Listed only in a working copy, not by the forge: nothing is widened.
  const local = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: ['hooks'] }, forgeConfig: { version: 1, projectRun: { allow: true, unverifiedHosts: true } } });
  userSettings(local, { hooks: { PreToolUse: [{}] } });
  halted(local, local.cmd(['start', 'launch', 'ENG-1']), /set hooks/u);

  // Any other plugin counts, hooks or none: its LSP servers, monitors, and MCP servers run outside the sandbox too.
  const plugin = (fx, manifest, flags = { 'x@market': true }) => {
    const place = path.join(fx.root, 'plugin-x');
    mkdirSync(path.join(place, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(place, '.claude-plugin', 'plugin.json'), JSON.stringify(manifest));
    installed(fx, { 'x@market': [{ scope: 'user', installPath: place }], [OWN_PLUGIN]: [OWN] });
    userSettings(fx, { enabledPlugins: { ...flags, [OWN_PLUGIN]: true } });
  };
  const hooked = runFixture(t);
  plugin(hooked, { name: 'x', hooks: './hooks.json' });
  halted(hooked, hooked.cmd(['start', 'launch', 'ENG-1']), /the plugin x@market is enabled, and a plugin's hooks, MCP and LSP servers, and monitors run outside the sandbox/u);
  const quiet = runFixture(t);
  plugin(quiet, { name: 'x', lspServers: { ts: { command: 'tsserver' } } });
  halted(quiet, quiet.cmd(['start', 'launch', 'ENG-1']), /the plugin x@market is enabled/u);
  const unflagged = runFixture(t);
  plugin(unflagged, { name: 'x' }, {});
  halted(unflagged, unflagged.cmd(['start', 'launch', 'ENG-1']), /the plugin x@market is enabled/u, 'no entry follows its default, which is on');
  const off = runFixture(t);
  plugin(off, { name: 'x', hooks: './hooks.json' }, { 'x@market': false });
  assert.equal(off.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, 'a plugin the user turned off');
  const listed = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: ['x@market'] } });
  plugin(listed, { name: 'x', hooks: './hooks.json' });
  assert.equal(listed.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, 'a plugin the team names');
  // A plugin turned off that a named, enabled plugin depends on still loads.
  const needed = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: ['x@market'] } });
  plugin(needed, { name: 'x', dependencies: ['y'] });
  const records = JSON.parse(readFileSync(path.join(needed.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json'), 'utf8')).plugins;
  installed(needed, { ...records, 'y@market': [{ scope: 'user', installPath: path.join(needed.root, 'plugin-y') }] });
  userSettings(needed, { enabledPlugins: { 'x@market': true, 'y@market': false, [OWN_PLUGIN]: true } });
  halted(needed, needed.cmd(['start', 'launch', 'ENG-1']), /the plugin y@market is enabled/u);
  // Enabled with no install record: what it runs cannot be told.
  const ghost = runFixture(t);
  userSettings(ghost, { enabledPlugins: { 'ghost@market': true, [OWN_PLUGIN]: true } });
  halted(ghost, ghost.cmd(['start', 'launch', 'ENG-1']), /the plugin ghost@market is enabled in the host's user settings with no install record/u);
  assert.equal(userSettingsProblem({}, { folder: path.join(ghost.root, 'nowhere') }), null, 'no plugins at all');
  assert.equal(userSettingsProblem({ statusLine: null }, { folder: path.join(ghost.root, 'nowhere') }), null, 'a key set to null is unset');
});

test('a user skill, agent, or command whose frontmatter declares hooks or MCP servers halts the start unless the team names it', (t) => {
  const write = (fx, file, text) => {
    const full = path.join(fx.env.CLAUDE_CONFIG_DIR, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  };
  for (const [file, text] of [
    ['skills/deploy/SKILL.md', '---\nname: deploy\nhooks:\n  PreToolUse: []\n---\n'],
    ['agents/x.md', '---\n"mcpServers": {}\n---\n'],
    ['commands/ship.md', '---\n  "hooks" : {}\n---\n'],
  ]) {
    const fx = runFixture(t);
    write(fx, file, text);
    halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), new RegExp(`~/\\.claude/${escaped(file)}, in the host's user config folder, declares hooks or MCP servers`, 'u'));
    const named = runFixture(t, { projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: [`~/.claude/${file}`] } });
    write(named, file, text);
    assert.equal(named.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, file);
  }
  const body = runFixture(t);
  write(body, 'skills/x/SKILL.md', '---\nname: x\n---\nhooks: in the body only\n');
  assert.equal(body.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, 'only the frontmatter counts');
});

test('a skill, agent, or command of the clone, at any depth, whose frontmatter declares hooks or MCP servers, or a link out of its folder, halts the start unless the team names it', (t) => {
  const skill = { '.claude/skills/deploy/SKILL.md': '---\nname: deploy\nhooks:\n  PreToolUse: []\n---\nDeploy it.\n' };
  const fx = runFixture(t, { files: skill });
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /\.claude\/skills\/deploy\/SKILL\.md in the attempt's clone declares hooks or MCP servers in its frontmatter/u);
  const named = runFixture(t, { files: skill, projectRun: { allow: true, unverifiedHosts: true, outsideSandbox: ['.claude/skills/deploy/SKILL.md'] } });
  assert.equal(named.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const body = runFixture(t, { files: { '.claude/agents/x.md': '---\nname: x\n---\nhooks: are named in the body only\n' } });
  assert.equal(body.cmd(['start', 'launch', 'ENG-1']).exitCode, 0, 'only the frontmatter counts');
  const nested = runFixture(t, { files: { 'packages/web/.claude/agents/x.md': '---\nname: x\n"hooks": {}\n---\n' } });
  halted(nested, nested.cmd(['start', 'launch', 'ENG-1']), /packages\/web\/\.claude\/agents\/x\.md in the attempt's clone declares hooks/u);

  const { cwd } = folders(t);
  const put = (file, text) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), text);
  };
  put('.claude/commands/ship.md', '---\nhooks: {}\n---\n');
  assert.match(cloneProblem({ work: cwd }), /\.claude\/commands\/ship\.md/u);
  rmSync(path.join(cwd, '.claude'), { recursive: true });
  put('a/b/.claude/skills/x/SKILL.md', "---\n'mcpServers' : { db: {} }\n---\n");
  assert.match(cloneProblem({ work: cwd }), /a\/b\/\.claude\/skills\/x\/SKILL\.md in the attempt's clone declares hooks or MCP servers/u, 'a quoted, spaced key at any depth');
  rmSync(path.join(cwd, 'a'), { recursive: true });
  // A skill folder that links out of .claude/skills, as to a shared .agents folder a session may write.
  put('.agents/skills/foo/SKILL.md', '---\nname: foo\n---\n');
  mkdirSync(path.join(cwd, '.claude/skills'), { recursive: true });
  symlinkSync('../../.agents/skills/foo', path.join(cwd, '.claude/skills/foo'));
  assert.match(cloneProblem({ work: cwd }), /\.claude\/skills\/foo in the attempt's clone is a link that leads out of its folder/u);
  assert.equal(cloneProblem({ work: cwd, allowed: ['.claude/skills/foo'] }), null, 'a link the team names');
  put('.claude/skills/baz/SKILL.md', '---\nname: baz\n---\n');
  symlinkSync('baz', path.join(cwd, '.claude/skills/bar'));
  assert.equal(cloneProblem({ work: cwd, allowed: ['.claude/skills/foo'] }), null, 'a link inside its folder passes');
  symlinkSync('foo', path.join(cwd, '.claude/skills/qux'));
  assert.match(cloneProblem({ work: cwd, allowed: ['.claude/skills/foo'] }), /\.claude\/skills\/qux in the attempt's clone is a link that leads out/u, 'a link through a named link still leads out');
});

test('a .claude that is a link, at the clone\'s root or at any depth, halts the start whatever the team names, and no placeholder is written through a link', (t) => {
  const { root, cwd, git } = folders(t);
  const linked = /is a link, and the host loads the skills, agents, commands, hooks, and settings of a \.claude folder from wherever it leads.*replace the link with the folder/u;
  // A nested link to a folder whose commands declare hooks: no walk of .claude folders would read it.
  mkdirSync(path.join(cwd, 'shared', 'commands'), { recursive: true });
  writeFileSync(path.join(cwd, 'shared', 'commands', 'ok.md'), '---\nhooks: {}\n---\n');
  mkdirSync(path.join(cwd, 'pkg'));
  symlinkSync('../shared', path.join(cwd, 'pkg', '.claude'));
  assert.match(cloneProblem({ work: cwd }) ?? '', new RegExp(`^pkg/\\.claude in the attempt's clone ${linked.source}`, 'u'));
  assert.match(cloneProblem({ work: cwd, allowed: ['pkg/.claude', 'shared/commands/ok.md'] }) ?? '', linked, 'no name lifts it');
  rmSync(path.join(cwd, 'pkg', '.claude'));
  symlinkSync('../shared', path.join(cwd, 'pkg', '.Claude'));
  assert.match(cloneProblem({ work: cwd }) ?? '', /^pkg\/\.Claude in the attempt's clone is a link/u, 'any case, as a disk that folds case reads it');
  rmSync(path.join(cwd, 'pkg'), { recursive: true });
  assert.equal(cloneProblem({ work: cwd }), null, 'shared alone is no .claude folder');
  // A root link that leads out of the clone: the start halts, and the placeholders leave its target untouched.
  const outside = path.join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, path.join(cwd, '.claude'));
  assert.match(cloneProblem({ work: cwd }) ?? '', new RegExp(`^\\.claude in the attempt's clone ${linked.source}`, 'u'));
  assert.match(placeHolders({ work: cwd, git, placeholders: PLACEHOLDERS })?.problem ?? '', /holds \.claude, a link, where its placeholder \.claude\/settings\.json goes.*replace the link with the folder/u);
  assert.deepEqual(readdirSync(outside), [], 'the link\'s target is untouched');
  // A link deeper in the path, as .claude/skills, is refused part by part as well.
  rmSync(path.join(cwd, '.claude'));
  mkdirSync(path.join(cwd, '.claude'));
  symlinkSync(outside, path.join(cwd, '.claude', 'skills'));
  assert.match(placeHolders({ work: cwd, git, placeholders: PLACEHOLDERS })?.problem ?? '', /holds \.claude\/skills, a link, where its placeholder \.claude\/skills goes/u);
  assert.deepEqual(readdirSync(outside), [], 'still untouched');
  rmSync(path.join(cwd, '.claude', 'skills'));
  // With no link, each placeholder goes in, and the git folder's own two.
  assert.equal(placeHolders({ work: cwd, git, placeholders: PLACEHOLDERS }), null);
  assert.equal(readFileSync(path.join(git, 'commondir'), 'utf8'), '.\n');
  assert.equal(readFileSync(path.join(git, 'config.worktree'), 'utf8'), '');
  assert.ok(lstatSync(path.join(cwd, '.claude', 'skills')).isDirectory());
});

test('a start whose clone holds a nested .claude link halts through the gate', (t) => {
  const fx = runFixture(t, { files: { 'shared/commands/ok.md': '---\nhooks: {}\n---\n' }, links: { 'pkg/.claude': '../shared' } });
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /pkg\/\.claude in the attempt's clone is a link/u);
});

test('the user\'s sandbox settings pass only with keys that narrow it, and network.allowedDomains; a grant into a guarded folder, or settings that cannot be read, halt the start', (t) => {
  const fx = runFixture(t, { init: false });
  const guarded = [path.join(fx.home, '.local', 'state'), fx.state];
  const ask = (settings, more = {}) => {
    userSettings(fx, settings);
    return accessProblem({ env: fx.env, home: fx.home, guarded, pushUrl: 'https://github.com/acme/widgets.git', platform: 'linux', ...more });
  };
  assert.equal(ask({}), null);
  assert.equal(ask({ sandbox: {
    enabled: false, failIfUnavailable: false, allowUnsandboxedCommands: true, autoAllowBashIfSandboxed: false, enableWeakerNestedSandbox: true,
    enableWeakerNetworkIsolation: true, allowAppleEvents: true, allowNestedUserNamespaces: true,
    filesystem: { denyRead: ['~/secret'], denyWrite: ['/etc'] },
    network: { allowedDomains: ['registry.npmjs.org'], deniedDomains: ['evil.example'], strictAllowlist: false, allowAllUnixSockets: true, allowLocalBinding: true },
    credentials: { files: [{ path: '~/.x', mode: 'deny' }], envVars: [{ name: 'X', mode: 'mask' }] },
  } }), null, 'scalars --settings overrides, lists that narrow, and allowedDomains');
  for (const [settings, key] of [
    [{ excludedCommands: ['docker'] }, 'excludedCommands'],
    [{ filesystem: { allowWrite: ['~/'] } }, 'filesystem.allowWrite'],
    [{ filesystem: { allowRead: ['~/.ssh'] } }, 'filesystem.allowRead'],
    [{ filesystem: { disabled: true } }, 'filesystem.disabled'],
    [{ ignoreViolations: { '*': ['/x'] } }, 'ignoreViolations'],
    [{ network: { allowUnixSockets: ['/var/run/docker.sock'] } }, 'network.allowUnixSockets'],
    [{ network: { httpProxyPort: 8080 } }, 'network.httpProxyPort'],
    [{ network: { socksProxyPort: 1080 } }, 'network.socksProxyPort'],
    [{ network: { allowMachLookup: ['com.apple.x'] } }, 'network.allowMachLookup'],
    [{ network: { tlsTerminate: true } }, 'network.tlsTerminate'],
    [{ ripgrep: { command: '/bin/rg' } }, 'ripgrep'],
    [{ bwrapPath: '/opt/bwrap' }, 'bwrapPath'],
    [{ credentials: { envVars: [{ name: 'X', mode: 'allow' }] } }, 'credentials.envVars'],
    [{ someFutureKey: true }, 'someFutureKey'],
  ]) {
    assert.match(ask({ sandbox: settings }) ?? 'null', new RegExp(`user settings set sandbox\\.${escaped(key)}, which does not only narrow the sandbox`, 'u'), key);
  }
  assert.match(ask({ sandbox: true }), /user settings set sandbox to a value that is not an object/u);
  assert.match(ask({ permissions: { additionalDirectories: [fx.state] } }), new RegExp(`grant ${escaped(fx.state)}, which reaches`, 'u'));
  assert.match(ask({ permissions: { additionalDirectories: [path.join(fx.state, 'runs')] } }), /which reaches/u, 'a folder in a guarded one');
  assert.match(ask({ permissions: { allow: [`Edit(/${fx.home}/**)`] } }), /which reaches/u, 'an Edit rule cut at its glob');
  assert.match(ask({ permissions: { additionalDirectories: ['relative'] } }), /a path the gate cannot place/u);
  assert.equal(ask({ permissions: { allow: ['Edit(src/**)', 'Bash(npm test)'] } }), null, 'a rule from the session\'s folder');
  assert.match(ask('{ not json'), /cannot be read: it is not JSON/u);
  assert.match(ask('[]'), /are not a JSON object/u);
  for (const platform of ['darwin', 'linux']) {
    assert.match(ask({}, { platform, pushUrl: 'git@github.com:acme/widgets.git' }), /origin's URL, which the attempt's clone pushes to, goes over SSH.*`git remote set-url origin https:\/\/<host>\/<owner>\/<name>\.git`/u, platform);
    assert.match(ask({}, { platform, pushUrl: 'ssh://git@github.com/acme/widgets.git' }), /goes over SSH/u, platform);
  }
  assert.match(ask({}, { pushUrl: null }), /git names no URL origin pushes to/u);
  assert.equal(ask({}, { platform: 'darwin' }), null, 'HTTPS on macOS');
  assert.match(ask({}, { helpers: ['store'] }), /git's credential helper `store` keeps the push token in ~\/\.git-credentials.*`gh auth setup-git`/u);
  // gh's setup leaves a `store` entry in place, and the check reads every scope: the fix names the file that holds it.
  assert.match(ask({}, { helpers: ['store'] }), /`gh auth setup-git`, which leaves the `store` helper in place, and remove that one from the file that defines it, which `git config --show-origin --show-scope --get-regexp '\^credential\\\.\.\*helper\$'` names$/u);
  assert.match(ask({}, { pushUrl: 'git@github.com:acme/widgets.git' }), /remove any url\.<base>\.insteadOf rule that rewrites it to SSH from the file that defines it, which `git config --show-origin --show-scope --get-regexp 'insteadof\$'` names$/u);
  assert.match(ask({}, { helpers: ['store --file ~/.creds'] }), /credential helper `store`/u);
  assert.equal(ask({}, { helpers: ['!gh auth git-credential', 'osxkeychain'] }), null, 'the forge CLI\'s helper and the keychain');
  assert.match(ask({}, { env: { ...fx.env, PATH: '/nowhere' } }), /bwrap is not on PATH/u);
  assert.equal(ask({}, { env: { ...fx.env, PATH: '/nowhere' }, platform: 'darwin' }), null);
});

test('an origin that pushes over SSH halts the start on every platform, through the gate, and the remedy names set-url', (t) => {
  for (const platform of ['darwin', 'linux']) {
    const fx = runFixture(t);
    fx.git('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
    halted(fx, fx.cmd(['start', 'launch', 'ENG-1'], { platform, env: sshFetch(fx) }), /origin's URL, which the attempt's clone pushes to, goes over SSH/u);
  }
  // The clone takes origin's URL, not its pushurl: an SSH URL with an HTTPS pushurl still halts, and the reverse passes.
  const fetchSsh = runFixture(t);
  fetchSsh.git('remote', 'set-url', 'origin', 'git@github.com:acme/widgets.git');
  fetchSsh.git('config', 'remote.origin.pushurl', 'https://github.com/acme/widgets.git');
  halted(fetchSsh, fetchSsh.cmd(['start', 'launch', 'ENG-1'], { env: sshFetch(fetchSsh) }), /goes over SSH/u);
  const pushSsh = runFixture(t);
  pushSsh.git('config', 'remote.origin.pushurl', 'git@github.com:acme/widgets.git');
  const passed = pushSsh.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(passed.exitCode, 0, passed.err.join('\n'));
  assert.equal(pushSsh.git('-C', work(pushSsh), 'remote', 'get-url', '--push', 'origin').trim(), 'https://github.com/acme/widgets.git', 'the clone pushes over HTTPS');
});

test('an HTTPS origin that the user\'s git config rewrites to SSH with url.<base>.insteadOf halts the start, and the halt names the rule', (t) => {
  const global = testGlobalConfig(t);
  writeFileSync(global, '[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n');
  const fx = runFixture(t);
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1'], { env: sshFetch(fx) }), /goes over SSH \(git@github\.com:acme\/widgets\.git\).*remove any url\.<base>\.insteadOf rule that rewrites it to SSH from the file that defines it/u);
});

test('a clone that would push to another URL than the access check read, through the user\'s pushInsteadOf, halts the start', (t) => {
  const global = testGlobalConfig(t);
  writeFileSync(global, '[url "git@github.com:acme/"]\n\tpushInsteadOf = https://github.com/acme/\n');
  const fx = runFixture(t);
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /the attempt's clone pushes to git@github\.com:acme\/widgets\.git, not https:\/\/github\.com\/acme\/widgets\.git, the URL the host's access check read/u);
  // A rewrite that puts a token in the URL prints it masked.
  writeFileSync(global, '[url "https://bot:s3cr3t-token@github.com/acme/"]\n\tpushInsteadOf = https://github.com/acme/\n');
  const tokened = runFixture(t);
  const result = tokened.cmd(['start', 'launch', 'ENG-1']);
  halted(tokened, result, /the attempt's clone pushes to https:\/\/bot:\[redacted\]@github\.com\/acme\/widgets\.git, not https:\/\/github\.com\/acme\/widgets\.git/u);
  assert.doesNotMatch([...result.out, ...result.err].join('\n'), /s3cr3t/u);
});

test('git\'s store credential helper in the user\'s git config halts the start through the gate', (t) => {
  const global = testGlobalConfig(t);
  writeFileSync(global, '[credential "https://github.com"]\n\thelper = store\n');
  const fx = runFixture(t);
  halted(fx, fx.cmd(['start', 'launch', 'ENG-1']), /credential helper `store`/u);
});

test('the session loads only the MCP servers both the local ref and the forge name alike, never a project .mcp.json', (t) => {
  const servers = { tracker: { command: 'tracker-mcp', args: ['--read-only'] }, docs: { type: 'http', url: 'https://docs.example.com/mcp' } };
  const fx = runFixture(t, {
    projectRun: { allow: true, unverifiedHosts: true, mcpServers: servers },
    forgeConfig: { version: 1, projectRun: { allow: true, unverifiedHosts: true, mcpServers: { tracker: servers.tracker, docs: { type: 'http', url: 'https://evil.example.com/mcp' } } } },
    files: { '.mcp.json': JSON.stringify({ mcpServers: { planted: { command: 'sh' } } }) },
  });
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  const [{ args }] = fx.claude.starts();
  assert.deepEqual(JSON.parse(args[args.indexOf('--mcp-config') + 1]), { mcpServers: { tracker: servers.tracker } });
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableClaudeAiConnectors, true, 'no claude.ai connector either');
  const none = runFixture(t);
  none.cmd(['start', 'launch', 'ENG-1']);
  const [{ args: plain }] = none.claude.starts();
  assert.equal(plain[plain.indexOf('--mcp-config') + 1], '{"mcpServers":{}}', 'none by default');
  const settings = JSON.parse(plain[plain.indexOf('--settings') + 1]);
  assert.equal(settings.sandbox.filesystem.denyRead.at(-1), none.dir, 'the main checkout is unreadable');
  assert.equal(settings.sandbox.filesystem.allowRead[0], path.join(none.dir, '.git'), 'but its git folder, whose objects the clone borrows');
});

test('limitContinueProblem: a project settings file that sets autoContinueAtUsageLimit is named, and does not count', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'limit-continue-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const project = path.join(root, 'project');
  mkdirSync(config, { recursive: true });
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: config };
  const plain = limitContinueProblem({ env, home: root, project });
  const scope = ' (this check reads that file only; managed policy and --settings, which can set or override the key, go unverified)';
  assert.ok(plain.endsWith(`do not set "autoContinueAtUsageLimit": true, which a project run asks for so that a usage limit does not stop the driver for good; add it${scope}`), `no project file: ${plain}`);
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(project, '.claude', name);
    writeFileSync(file, JSON.stringify({ autoContinueAtUsageLimit: true }));
    const named = limitContinueProblem({ env, home: root, project });
    assert.ok(named.startsWith(plain.slice(0, -scope.length)), named);
    assert.ok(named.endsWith(`add it there: ${file} sets it, but the host ignores this key in a project's settings, so a project file does not count${scope}`), named);
    rmSync(file);
  }
  writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ other: true }));
  assert.equal(limitContinueProblem({ env, home: root, project }), plain, 'a project file without the key is not named');
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ autoContinueAtUsageLimit: true }));
  writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ autoContinueAtUsageLimit: false }));
  assert.equal(limitContinueProblem({ env, home: root, project }), null, 'the user settings decide');
});
