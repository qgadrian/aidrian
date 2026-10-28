import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
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
const CODEX = '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex';
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
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'aidrian-codex-install-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(path.join(root, 'home'), { recursive: true });
  await mkdir(path.join(root, 'codex-home'), { recursive: true });
  await mkdir(path.join(root, 'claude-home'), { recursive: true });
  await mkdir(path.join(root, 'claude-config'), { recursive: true });
  await mkdir(path.join(root, 'claude-cache'), { recursive: true });
  return {
    root,
    env: { ...process.env, PATH, HOME: path.join(root, 'home'), CODEX_HOME: path.join(root, 'codex-home') },
  };
};

test('Codex installs the portable hook-free core from an isolated private marketplace', async (t) => {
  const fixture = await isolated(t);
  const options = { cwd: fixture.root, env: fixture.env, timeout: 60_000 };
  assert.match((await run(CODEX, ['--version'], options)).stdout, /0\.164\.0/);
  await run(CODEX, ['plugin', 'marketplace', 'add', ROOT, '--json'], options);
  const installed = await run(CODEX, ['plugin', 'add', 'aidrian@aidrian-private', '--json'], options);
  assert.match(installed.stdout, /aidrian/);
  const installedPlugins = JSON.parse((await run(CODEX, ['plugin', 'list', '--json'], options)).stdout);
  const installedAidrian = installedPlugins.installed.find(
    ({ pluginId }) => pluginId === 'aidrian@aidrian-private',
  );
  assert.ok(installedAidrian, 'Codex must report the exact installed Aidrian package');
  assert.deepEqual(
    { pluginId: installedAidrian.pluginId, version: installedAidrian.version },
    { pluginId: 'aidrian@aidrian-private', version: '0.0.0' },
  );
  const assembled = await assemblePrivateDistribution({ root: ROOT });
  assert.equal(assembled.version, '0.0.0');
  assert.equal(assembled.manifests.codex.extensions?.['com.openai']?.hooks, undefined);
  const expectedBundlePins = bundlePinsFromBundle(assembled.bundle);
  const nativeObservationToken = await observeNativePluginProfiles({
    projectRoot: fixture.root,
    activationMode: 'project-bundle',
    operation: 'install',
    bundle: assembled.bundle,
    expectedBundlePins,
    profiles: [{
      providerId: 'claude',
      binaryPath: '/Users/adrian/.local/share/claude/versions/2.1.312',
      resolvedProfileRoot: path.join(fixture.root, 'claude-config'),
      writableRoots: {
        cache: path.join(fixture.root, 'claude-cache'),
        config: path.join(fixture.root, 'claude-config'),
        home: path.join(fixture.root, 'claude-home'),
      },
    }, {
      providerId: 'codex',
      binaryPath: CODEX,
      resolvedProfileRoot: fixture.env.CODEX_HOME,
      writableRoots: {
        config: fixture.env.CODEX_HOME,
        home: fixture.env.HOME,
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
    /installed-plugin:codex:aidrian@aidrian-private/,
  );
});
