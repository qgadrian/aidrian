import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assemblePrivateDistribution } from '../../src/project-bundle/assemble.mjs';
import {
  __testOnlyParseNativePluginList,
  applyManagedPlan,
  observeNativePluginProfiles,
  planManagedInstall,
} from '../../src/project-bundle/managed-projection.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_COMMIT = 'f714cfac938af8a70dbe7bf540f965ab7d728b05';
const CLAUDE = '/Users/adrian/.local/share/claude/versions/2.1.312';
const CODEX = '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex';
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

const scratch = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'aidrian-collision-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true })));
  return root;
};

const nativeProfiles = async (t) => {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-collision-profiles-'));
  const root = await realpath(createdRoot);
  t.after(() => rm(root, { force: true, recursive: true }));
  await Promise.all([
    'claude-home',
    'claude-config',
    'claude-cache',
    'codex-home',
    'codex-config',
  ].map((relative) => mkdir(path.join(root, relative), { recursive: true })));
  return [{
    providerId: 'claude',
    binaryPath: CLAUDE,
    resolvedProfileRoot: path.join(root, 'claude-config'),
    writableRoots: {
      cache: path.join(root, 'claude-cache'),
      config: path.join(root, 'claude-config'),
      home: path.join(root, 'claude-home'),
    },
  }, {
    providerId: 'codex',
    binaryPath: CODEX,
    resolvedProfileRoot: path.join(root, 'codex-config'),
    writableRoots: {
      config: path.join(root, 'codex-config'),
      home: path.join(root, 'codex-home'),
    },
  }];
};

const observeInstall = ({ projectRoot, bundle, profiles }) => observeNativePluginProfiles({
  projectRoot,
  activationMode: 'project-bundle',
  operation: 'install',
  bundle,
  expectedBundlePins: bundlePinsFromBundle(bundle),
  profiles,
});

test('marketplace companion and full project projection are mutually exclusive', async (t) => {
  const projectRoot = await scratch(t);
  const profiles = await nativeProfiles(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const companion = await planManagedInstall({
    projectRoot,
    bundle,
    activationMode: 'marketplace-companion',
    expectedBundlePins: bundlePinsFromBundle(bundle),
    expectedPriorProjection: null,
  });
  await applyManagedPlan(companion);
  const nativeObservationToken = await observeInstall({ projectRoot, bundle, profiles });
  await assert.rejects(
    planManagedInstall({
      projectRoot,
      bundle,
      activationMode: 'project-bundle',
      expectedBundlePins: bundlePinsFromBundle(bundle),
      expectedPriorProjection: companion.nextProjection,
      nativeObservationToken,
    }),
    /activation-mode:marketplace-companion:project-bundle/,
  );
});

test('preflight reports role, skill, config, and managed-path collisions before provider mutation', async (t) => {
  const projectRoot = await scratch(t);
  const profiles = await nativeProfiles(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  await mkdir(path.join(projectRoot, '.claude/agents'), { recursive: true });
  await mkdir(path.join(projectRoot, '.codex/agents'), { recursive: true });
  await mkdir(path.join(projectRoot, '.agents/skills/grill-me'), { recursive: true });
  await writeFile(path.join(projectRoot, '.claude/agents/explorer.md'), 'unowned\n');
  await writeFile(path.join(projectRoot, '.codex/agents/explorer.toml'), 'unowned\n');
  await writeFile(path.join(projectRoot, '.agents/skills/grill-me/SKILL.md'), 'unowned\n');
  await writeFile(path.join(projectRoot, '.codex/config.toml'), [
    '[agents.explorer]',
    'description = "unowned"',
    'config_file = "agents/explorer.toml"',
    '',
  ].join('\n'));
  const nativeObservationToken = await observeInstall({ projectRoot, bundle, profiles });
  let providerMutationCalled = false;
  await assert.rejects(
    async () => {
      await planManagedInstall({
        projectRoot,
        bundle,
        activationMode: 'project-bundle',
        expectedBundlePins: bundlePinsFromBundle(bundle),
        expectedPriorProjection: null,
        nativeObservationToken,
      });
      providerMutationCalled = true;
    },
    (error) => {
      assert.match(error.message, /role-id:claude:explorer/);
      assert.match(error.message, /role-id:codex:explorer/);
      assert.match(error.message, /skill-id:grill-me/);
      assert.match(error.message, /config-agent-owned-collision:explorer/);
      assert.match(error.message, /config-path-owned-collision:agents\/explorer\.toml/);
      assert.match(error.message, /managed-path:\.claude\/agents\/explorer\.md/);
      return true;
    },
  );
  assert.equal(providerMutationCalled, false);
});

test('strict versioned provider parsers reject unknown and duplicate inventory', () => {
  const claudeRow = {
    id: 'aidrian@aidrian-private',
    version: '0.0.0',
    scope: 'user',
    enabled: true,
    installPath: '/private/tmp/plugin',
    readFromFolder: '/private/tmp/source',
    folderVersion: '0.0.0',
    installedAt: '2026-10-28T00:00:00.000Z',
    lastUpdated: '2026-10-28T00:00:00.000Z',
    projectEnabled: false,
  };
  assert.deepEqual(__testOnlyParseNativePluginList('claude', '2.1.312', '[]'), []);
  assert.deepEqual(
    __testOnlyParseNativePluginList('claude', '2.1.312', JSON.stringify([claudeRow])),
    ['aidrian@aidrian-private'],
  );
  assert.throws(
    () => __testOnlyParseNativePluginList('claude', '2.1.312', JSON.stringify([{ ...claudeRow, extra: true }])),
    /must contain exactly/,
  );
  assert.throws(
    () => __testOnlyParseNativePluginList('claude', '2.1.312', JSON.stringify([claudeRow, claudeRow])),
    /duplicate plugin ids/,
  );
  const codexRow = {
    pluginId: 'aidrian@aidrian-private',
    name: 'aidrian',
    marketplaceName: 'aidrian-private',
    version: '0.0.0',
    installed: true,
    enabled: true,
    source: { source: 'local', path: '/private/tmp/source' },
    marketplaceSource: { source: '/private/tmp/marketplace' },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_INSTALL',
  };
  assert.deepEqual(
    __testOnlyParseNativePluginList('codex', '0.164.0', JSON.stringify({
      installed: [codexRow],
      available: [],
    })),
    ['aidrian@aidrian-private'],
  );
  assert.throws(
    () => __testOnlyParseNativePluginList('codex', '0.164.0', JSON.stringify({
      installed: [codexRow, codexRow],
      available: [],
    })),
    /duplicate plugin ids/,
  );
  assert.throws(
    () => __testOnlyParseNativePluginList('codex', '0.165.0', '{"installed":[],"available":[]}'),
    /unsupported native plugin-list parser/,
  );
});

test('native observation binds both profiles and rejects fabricated, replayed, root, and fresh-state drift', async (t) => {
  const projectRoot = await scratch(t);
  const otherRoot = await scratch(t);
  const profiles = await nativeProfiles(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const expectedBundlePins = bundlePinsFromBundle(bundle);
  const before = await readdir(projectRoot);
  const token = await observeInstall({ projectRoot, bundle, profiles });
  assert.deepEqual(await readdir(projectRoot), before, 'native list observation must not create project output');
  await assert.rejects(
    planManagedInstall({
      projectRoot,
      bundle,
      activationMode: 'project-bundle',
      expectedBundlePins,
      expectedPriorProjection: null,
      nativeObservationToken: {},
    }),
    /missing or fabricated/,
  );
  await assert.rejects(
    planManagedInstall({
      projectRoot: otherRoot,
      bundle,
      activationMode: 'project-bundle',
      expectedBundlePins,
      expectedPriorProjection: null,
      nativeObservationToken: token,
    }),
    /binding mismatch/,
  );
  const replayToken = await observeInstall({ projectRoot, bundle, profiles });
  const plan = await planManagedInstall({
    projectRoot,
    bundle,
    activationMode: 'project-bundle',
    expectedBundlePins,
    expectedPriorProjection: null,
    nativeObservationToken: replayToken,
  });
  await assert.rejects(
    planManagedInstall({
      projectRoot,
      bundle,
      activationMode: 'project-bundle',
      expectedBundlePins,
      expectedPriorProjection: null,
      nativeObservationToken: replayToken,
    }),
    /already used/,
  );
  await rm(profiles[0].writableRoots.cache, { force: true, recursive: true });
  await assert.rejects(applyManagedPlan(plan), /writableRoots\.cache/);
  assert.deepEqual(await readdir(projectRoot), before, 'failed fresh observation must precede target effects');

  const otherProfiles = await nativeProfiles(t);
  const symlinkPath = path.join(otherProfiles[1].writableRoots.home, 'codex-symlink');
  await symlink(otherProfiles[1].binaryPath, symlinkPath);
  t.after(() => rm(symlinkPath, { force: true }));
  const mismatchedProfiles = structuredClone(otherProfiles);
  mismatchedProfiles[1].binaryPath = symlinkPath;
  await assert.rejects(
    observeInstall({ projectRoot, bundle, profiles: mismatchedProfiles }),
    /final resolved provider binary/,
  );
  const wrongHashProfiles = structuredClone(otherProfiles);
  wrongHashProfiles[1].binaryPath = '/bin/echo';
  await assert.rejects(
    observeInstall({ projectRoot, bundle, profiles: wrongHashProfiles }),
    /provider binary hash is unsupported/,
  );
  await assert.rejects(
    observeInstall({ projectRoot, bundle, profiles: [otherProfiles[0], otherProfiles[0]] }),
    /exactly one Claude and one Codex/,
  );
  await assert.rejects(
    observeInstall({
      projectRoot: path.join(projectRoot, 'missing-project'),
      bundle,
      profiles: otherProfiles,
    }),
    /native plugin observation failed/,
  );
});
