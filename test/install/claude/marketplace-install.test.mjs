import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assemblePrivateDistribution } from '../../../src/project-bundle/assemble.mjs';
import {
  observeNativePluginProfiles,
  planManagedInstall,
} from '../../../src/project-bundle/managed-projection.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLAUDE = '/Users/adrian/.local/share/claude/versions/2.1.312';
const PATH = '/Users/adrian/.local/share/mise/installs/node/26.12.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const bundlePinsFromBundle = (bundle) => ({
  schemaVersion: bundle.schemaVersion,
  sourceCommit: bundle.sourceCommit,
  builder: bundle.builder,
  plugin: bundle.plugin,
  manifestDigest: bundle.manifestDigest,
  bundleDigest: bundle.bundleDigest,
  provenanceManifestDigest: bundle.provenanceManifestDigest,
  providerManifestDigests: bundle.providerManifestDigests,
  capabilityManifestDigest: bundle.capabilityManifestDigest,
});

const isolated = async (t) => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aidrian-claude-install-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, 'home'), { recursive: true });
  await mkdir(path.join(root, 'codex-home'), { recursive: true });
  await mkdir(path.join(root, 'codex-user-home'), { recursive: true });
  return {
    root,
    env: {
      ...process.env,
      PATH,
      HOME: path.join(root, 'home'),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude-config'),
      CLAUDE_CODE_PLUGIN_CACHE_DIR: path.join(root, 'plugin-cache'),
    },
  };
};

test('Claude strictly validates and installs the actual hook-free core in an isolated home', async (t) => {
  const fixture = await isolated(t);
  const options = { cwd: fixture.root, env: fixture.env, timeout: 60_000 };
  assert.match((await run(CLAUDE, ['--version'], options)).stdout, /^2\.1\.312/);
  await run(CLAUDE, ['plugin', 'validate', '--strict', ROOT], options);
  await run(CLAUDE, ['plugin', 'validate', '--strict', path.join(ROOT, 'plugins/aidrian')], options);
  await run(CLAUDE, ['plugin', 'validate', path.join(import.meta.dirname, 'fixtures/hook-plugin')], options);
  await run(CLAUDE, ['plugin', 'marketplace', 'add', ROOT, '--scope', 'user', '--json'], options);
  const installed = await run(
    CLAUDE,
    ['plugin', 'install', 'aidrian@aidrian-private', '--scope', 'user', '--json'],
    options,
  );
  assert.match(installed.stdout, /aidrian/);
  const assembled = await assemblePrivateDistribution({ root: ROOT });
  assert.equal(assembled.version, '0.0.0');
  assert.equal('hooks' in assembled.manifests.claude, false);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(ROOT, 'plugins/aidrian/.claude-plugin/plugin.json'))).version,
    assembled.version,
  );
  const expectedBundlePins = bundlePinsFromBundle(assembled.bundle);
  const nativeObservationToken = await observeNativePluginProfiles({
    projectRoot: fixture.root,
    activationMode: 'project-bundle',
    operation: 'install',
    bundle: assembled.bundle,
    expectedBundlePins,
    profiles: [{
      providerId: 'claude',
      binaryPath: CLAUDE,
      resolvedProfileRoot: fixture.env.CLAUDE_CONFIG_DIR,
      writableRoots: {
        cache: fixture.env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
        config: fixture.env.CLAUDE_CONFIG_DIR,
        home: fixture.env.HOME,
      },
    }, {
      providerId: 'codex',
      binaryPath: '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex',
      resolvedProfileRoot: path.join(fixture.root, 'codex-home'),
      writableRoots: {
        config: path.join(fixture.root, 'codex-home'),
        home: path.join(fixture.root, 'codex-user-home'),
      },
    }],
  });
  await assert.rejects(
    planManagedInstall({
      projectRoot: fixture.root,
      bundle: assembled.bundle,
      activationMode: 'project-bundle',
      expectedBundlePins,
      expectedPriorProjection: null,
      nativeObservationToken,
    }),
    /installed-plugin:claude:aidrian@aidrian-private/,
  );
});
