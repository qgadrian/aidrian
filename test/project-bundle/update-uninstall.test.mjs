import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assemblePrivateDistribution, stableJson } from '../../src/project-bundle/assemble.mjs';
import {
  applyManagedPlan,
  applyManagedPlanForTest,
  observeNativePluginProfiles,
  planManagedInstall,
  planManagedUninstall,
} from '../../src/project-bundle/managed-projection.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_COMMIT = 'f714cfac938af8a70dbe7bf540f965ab7d728b05';
const CLAUDE = '/Users/adrian/.local/share/claude/versions/2.1.312';
const CODEX = '/opt/homebrew/Caskroom/codex/0.164.0/bin/codex';

const scratchProject = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'aidrian-managed-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true })));
  await mkdir(path.join(root, '.codex'), { recursive: true });
  await writeFile(path.join(root, '.codex/config.toml'), 'theme = "dark"\n');
  return root;
};

const nativeProfiles = async (t) => {
  const createdRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-native-observer-'));
  const root = await realpath(createdRoot);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(root, { force: true, recursive: true })));
  const directories = [
    'claude-home',
    'claude-config',
    'claude-cache',
    'codex-home',
    'codex-config',
  ];
  await Promise.all(directories.map((relative) => mkdir(path.join(root, relative), { recursive: true })));
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

const installPlan = async ({
  projectRoot,
  bundle,
  profiles,
  expectedPriorProjection = null,
  activationMode = 'project-bundle',
}) => {
  const expectedBundlePins = bundlePinsFromBundle(bundle);
  const nativeObservationToken = activationMode === 'project-bundle'
    ? await observeNativePluginProfiles({
      projectRoot,
      activationMode,
      operation: 'install',
      bundle,
      expectedBundlePins,
      profiles,
    })
    : null;
  return planManagedInstall({
    projectRoot,
    bundle,
    activationMode,
    expectedBundlePins,
    expectedPriorProjection,
    nativeObservationToken,
  });
};

const uninstallPlan = async ({ projectRoot, profiles, expectedPriorProjection }) => {
  const nativeObservationToken = expectedPriorProjection.activationMode === 'project-bundle'
    ? await observeNativePluginProfiles({
      projectRoot,
      activationMode: expectedPriorProjection.activationMode,
      operation: 'uninstall',
      bundle: null,
      expectedBundlePins: expectedPriorProjection.bundlePins,
      profiles,
    })
    : null;
  return planManagedUninstall({ projectRoot, expectedPriorProjection, nativeObservationToken });
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
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

const rehashBundle = (value) => {
  const bundle = structuredClone(value);
  bundle.ledger = bundle.files.map(({ path: relative, mode, sha256: digest }) => ({
    path: relative,
    mode,
    sha256: digest,
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = {
    schemaVersion: bundle.schemaVersion,
    builder: bundle.builder,
    sourceCommit: bundle.sourceCommit,
    plugin: bundle.plugin,
    providerManifestDigests: bundle.providerManifestDigests,
    capabilityManifestDigest: bundle.capabilityManifestDigest,
    provenanceManifestDigest: bundle.provenanceManifestDigest,
    codexConfigBlockDigest: bundle.codexConfigBlockDigest,
    reviewers: bundle.reviewers,
    ledger: bundle.ledger,
  };
  bundle.manifestDigest = sha256(stableJson(manifest));
  bundle.bundleDigest = sha256(stableJson({ manifestDigest: bundle.manifestDigest, files: bundle.files }));
  return bundle;
};

test('managed install, update, and uninstall preserve every unowned surface', async (t) => {
  const projectRoot = await scratchProject(t);
  const profiles = await nativeProfiles(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  await mkdir(path.join(projectRoot, 'docs/private'), { recursive: true });
  await mkdir(path.join(projectRoot, '.overlays'), { recursive: true });
  await mkdir(path.join(projectRoot, '.native-provider'), { recursive: true });
  await writeFile(path.join(projectRoot, 'docs/private/knowledge.md'), 'keep knowledge\n');
  await writeFile(path.join(projectRoot, '.overlays/project.json'), '{}\n');
  await writeFile(path.join(projectRoot, '.native-provider/state.json'), '{"provider":true}\n');

  const installed = await installPlan({ projectRoot, bundle, profiles });
  await applyManagedPlan(installed);
  const updated = await installPlan({
    projectRoot,
    bundle,
    profiles,
    expectedPriorProjection: installed.nextProjection,
  });
  await applyManagedPlan(updated);
  assert.match(await readFile(path.join(projectRoot, '.codex/config.toml'), 'utf8'), /^theme = "dark"/);
  await applyManagedPlan(await uninstallPlan({
    projectRoot,
    profiles,
    expectedPriorProjection: updated.nextProjection,
  }));

  assert.equal(await readFile(path.join(projectRoot, 'docs/private/knowledge.md'), 'utf8'), 'keep knowledge\n');
  assert.equal(await readFile(path.join(projectRoot, '.overlays/project.json'), 'utf8'), '{}\n');
  assert.equal(await readFile(path.join(projectRoot, '.native-provider/state.json'), 'utf8'), '{"provider":true}\n');
  assert.equal(await readFile(path.join(projectRoot, '.codex/config.toml'), 'utf8'), 'theme = "dark"\n');
});

test('dirty and concurrent preimages fail before managed writes', async (t) => {
  const projectRoot = await scratchProject(t);
  const profiles = await nativeProfiles(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const installed = await installPlan({ projectRoot, bundle, profiles });
  await applyManagedPlan(installed);
  const owned = bundle.ledger[0].path;
  await writeFile(path.join(projectRoot, owned), 'dirty\n');
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle,
      profiles,
      expectedPriorProjection: installed.nextProjection,
    }),
    new RegExp(`dirty-preimage:${owned.replaceAll('/', '\\/')}`),
  );
  const original = Buffer.from(bundle.files.find(({ path: relative }) => relative === owned).contentBase64, 'base64');
  await writeFile(path.join(projectRoot, owned), original);
  const plan = await installPlan({
    projectRoot,
    bundle,
    profiles,
    expectedPriorProjection: installed.nextProjection,
  });
  await writeFile(path.join(projectRoot, '.codex/config.toml'), 'concurrent = true\n');
  await assert.rejects(applyManagedPlan(plan), /managed plan concurrent preimage changed: \.codex\/config\.toml/);
});

test('uninstall restores empty or non-newline config bytes and preserves config mode', async (t) => {
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  for (const original of [Buffer.alloc(0), Buffer.from('theme = "dark"')]) {
    const projectRoot = await scratchProject(t);
    const profiles = await nativeProfiles(t);
    const configPath = path.join(projectRoot, '.codex/config.toml');
    await writeFile(configPath, original);
    await chmod(configPath, 0o600);
    const installed = await installPlan({ projectRoot, bundle, profiles });
    await applyManagedPlan(installed);
    await applyManagedPlan(await uninstallPlan({
      projectRoot,
      profiles,
      expectedPriorProjection: installed.nextProjection,
    }));
    assert.deepEqual(await readFile(configPath), original);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  }
});

test('managed preflight rejects symlinked ancestors and malformed ownership rows', async (t) => {
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const symlinkProject = await scratchProject(t);
  const symlinkProfiles = await nativeProfiles(t);
  const outside = await mkdtemp(path.join(tmpdir(), 'aidrian-managed-outside-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(outside, { force: true, recursive: true })));
  await symlink(outside, path.join(symlinkProject, '.claude'));
  await assert.rejects(
    installPlan({ projectRoot: symlinkProject, bundle, profiles: symlinkProfiles }),
    /\.claude\/agents\/.+: unsafe managed output ancestor/,
  );

  const malformedProject = await scratchProject(t);
  const malformedProfiles = await nativeProfiles(t);
  const installed = await installPlan({ projectRoot: malformedProject, bundle, profiles: malformedProfiles });
  await applyManagedPlan(installed);
  const ledgerPath = path.join(malformedProject, '.aidrian/managed-projection.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.ownedFiles[0].unexpected = true;
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(
    uninstallPlan({
      projectRoot: malformedProject,
      profiles: malformedProfiles,
      expectedPriorProjection: installed.nextProjection,
    }),
    /managed projection ownedFiles entry .* must contain exactly mode, path, sha256/,
  );
});

test('candidate pins and independent prior projection fail closed before target effects', async (t) => {
  const projectRoot = await scratchProject(t);
  const first = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const second = await assemblePrivateDistribution({ root: ROOT, sourceCommit: '0'.repeat(40) });
  const expectedBundlePins = bundlePinsFromBundle(first.bundle);
  await assert.rejects(
    planManagedInstall({
      projectRoot,
      bundle: second.bundle,
      activationMode: 'marketplace-companion',
      expectedBundlePins,
      expectedPriorProjection: null,
    }),
    /does not match expectedBundlePins/,
  );
  const pinMutations = [
    (pins) => { delete pins.manifestDigest; },
    (pins) => { pins.unexpected = true; },
    (pins) => { pins.schemaVersion = 2; },
    (pins) => { pins.sourceCommit = '1'.repeat(40); },
    (pins) => { pins.builder.version += 1; },
    (pins) => { pins.plugin.version = '0.0.1'; },
    (pins) => { pins.manifestDigest = '1'.repeat(64); },
    (pins) => { pins.bundleDigest = '1'.repeat(64); },
    (pins) => { pins.provenanceManifestDigest = '1'.repeat(64); },
    (pins) => { pins.providerManifestDigests.claude = '1'.repeat(64); },
    (pins) => { pins.providerManifestDigests.codex = '1'.repeat(64); },
    (pins) => { pins.capabilityManifestDigest = '1'.repeat(64); },
  ];
  for (const mutate of pinMutations) {
    const pins = structuredClone(expectedBundlePins);
    mutate(pins);
    await assert.rejects(planManagedInstall({
      projectRoot,
      bundle: first.bundle,
      activationMode: 'marketplace-companion',
      expectedBundlePins: pins,
      expectedPriorProjection: null,
    }));
  }
  const installed = await installPlan({
    projectRoot,
    bundle: first.bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(installed);
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle: first.bundle,
      profiles: null,
      activationMode: 'marketplace-companion',
      expectedPriorProjection: null,
    }),
    /requires expectedPriorProjection/,
  );
  const wrongPrior = structuredClone(installed.nextProjection);
  wrongPrior.ownedFiles[0].sha256 = '1'.repeat(64);
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle: first.bundle,
      profiles: null,
      activationMode: 'marketplace-companion',
      expectedPriorProjection: wrongPrior,
    }),
    /ledger does not match expectedPriorProjection/,
  );
  const priorWithExtraKey = { ...installed.nextProjection, unexpected: true };
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle: first.bundle,
      profiles: null,
      activationMode: 'marketplace-companion',
      expectedPriorProjection: priorWithExtraKey,
    }),
    /expectedPriorProjection must contain exactly/,
  );
  assert.match(await readFile(path.join(projectRoot, '.codex/config.toml'), 'utf8'), /^theme = "dark"/);
});

test('uninstall preserves post-install unowned config and rejects ledger or mode-only drift', async (t) => {
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-managed-absent-config-'));
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(projectRoot, { force: true, recursive: true })));
  const installed = await installPlan({
    projectRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(installed);
  const configPath = path.join(projectRoot, '.codex/config.toml');
  const managed = await readFile(configPath);
  const postInstallUnowned = Buffer.from('theme = "added-later"\n');
  await writeFile(configPath, Buffer.concat([managed, postInstallUnowned]));
  await chmod(configPath, 0o600);
  const uninstall = await uninstallPlan({
    projectRoot,
    profiles: null,
    expectedPriorProjection: installed.nextProjection,
  });
  await applyManagedPlan(uninstall);
  assert.deepEqual(await readFile(configPath), postInstallUnowned);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);

  const driftRoot = await scratchProject(t);
  const driftInstalled = await installPlan({
    projectRoot: driftRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(driftInstalled);
  const owned = driftInstalled.nextProjection.ownedFiles[0];
  await chmod(path.join(driftRoot, owned.path), 0o600);
  await assert.rejects(
    uninstallPlan({
      projectRoot: driftRoot,
      profiles: null,
      expectedPriorProjection: driftInstalled.nextProjection,
    }),
    new RegExp(`dirty-preimage:${owned.path.replaceAll('/', '\\/')}`),
  );
  const ledgerPath = path.join(driftRoot, '.aidrian/managed-projection.json');
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'));
  ledger.codexConfigBlockSha256 = '1'.repeat(64);
  await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
  await assert.rejects(
    uninstallPlan({
      projectRoot: driftRoot,
      profiles: null,
      expectedPriorProjection: driftInstalled.nextProjection,
    }),
    /ledger does not match expectedPriorProjection/,
  );
});

test('project ledger cannot authorize a tampered owned set, mode, hash, or block', async (t) => {
  const projectRoot = await scratchProject(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const installed = await installPlan({
    projectRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(installed);
  const ledgerPath = path.join(projectRoot, '.aidrian/managed-projection.json');
  const original = JSON.parse(await readFile(ledgerPath, 'utf8'));
  const mutations = [
    (ledger) => { ledger.ownedFiles.pop(); },
    (ledger) => { ledger.ownedFiles[0].mode = '0600'; },
    (ledger) => { ledger.ownedFiles[0].sha256 = '1'.repeat(64); },
    (ledger) => { ledger.codexConfigBlockSha256 = '1'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const ledger = structuredClone(original);
    mutate(ledger);
    await writeFile(ledgerPath, `${JSON.stringify(ledger)}\n`);
    await assert.rejects(
      uninstallPlan({
        projectRoot,
        profiles: null,
        expectedPriorProjection: installed.nextProjection,
      }),
      /ledger does not match expectedPriorProjection/,
    );
  }
  await writeFile(ledgerPath, `${JSON.stringify(original)}\n`);
});

test('retired file and concurrent config mode drift are detected', async (t) => {
  const projectRoot = await scratchProject(t);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const installed = await installPlan({
    projectRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(installed);
  const current = installed.nextProjection.ownedFiles[1];
  await chmod(path.join(projectRoot, current.path), 0o600);
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle,
      profiles: null,
      activationMode: 'marketplace-companion',
      expectedPriorProjection: installed.nextProjection,
    }),
    new RegExp(`dirty-preimage:${current.path.replaceAll('/', '\\/')}`),
  );
  await chmod(path.join(projectRoot, current.path), 0o644);
  const retired = installed.nextProjection.ownedFiles[0];
  const nextBundle = structuredClone(bundle);
  nextBundle.files = nextBundle.files.filter(({ path: relative }) => relative !== retired.path);
  const rehashed = rehashBundle(nextBundle);
  await chmod(path.join(projectRoot, retired.path), 0o600);
  await assert.rejects(
    installPlan({
      projectRoot,
      bundle: rehashed,
      profiles: null,
      activationMode: 'marketplace-companion',
      expectedPriorProjection: installed.nextProjection,
    }),
    new RegExp(`dirty-preimage:${retired.path.replaceAll('/', '\\/')}`),
  );
  await chmod(path.join(projectRoot, retired.path), 0o644);
  const plan = await installPlan({
    projectRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
    expectedPriorProjection: installed.nextProjection,
  });
  await chmod(path.join(projectRoot, '.codex/config.toml'), 0o600);
  await assert.rejects(applyManagedPlan(plan), /concurrent preimage changed: \.codex\/config\.toml/);
});

test('rollback restores bytes and mode and discloses injected restore failure', async (t) => {
  const { bundle } = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const restoredRoot = await scratchProject(t);
  const installed = await installPlan({
    projectRoot: restoredRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(installed);
  const plan = await installPlan({
    projectRoot: restoredRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
    expectedPriorProjection: installed.nextProjection,
  });
  const firstPath = plan.writes[0].path;
  const beforeBytes = await readFile(path.join(restoredRoot, firstPath));
  const beforeMode = (await stat(path.join(restoredRoot, firstPath))).mode & 0o777;
  await assert.rejects(
    applyManagedPlanForTest(plan, {
      afterMutationApplied: ({ mutationIndex }) => {
        if (mutationIndex === 1) throw new Error('injected primary mutation failure');
      },
      beforeRollbackRestore: () => {},
    }),
    /injected primary mutation failure/,
  );
  assert.deepEqual(await readFile(path.join(restoredRoot, firstPath)), beforeBytes);
  assert.equal((await stat(path.join(restoredRoot, firstPath))).mode & 0o777, beforeMode);

  const failedRoot = await scratchProject(t);
  const failedPlan = await installPlan({
    projectRoot: failedRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await assert.rejects(
    applyManagedPlanForTest(failedPlan, {
      afterMutationApplied: ({ mutationIndex }) => {
        if (mutationIndex === 1) throw new Error('injected primary mutation failure');
      },
      beforeRollbackRestore: ({ path: relative }) => {
        throw new Error(`injected restore failure for ${relative}`);
      },
    }),
    (error) => {
      assert.match(error.message, /injected primary mutation failure/);
      assert.match(error.message, /managed rollback incomplete/);
      assert.match(error.message, /restore failed: injected restore failure/);
      return true;
    },
  );

  const concurrentRoot = await scratchProject(t);
  const concurrentInstalled = await installPlan({
    projectRoot: concurrentRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
  });
  await applyManagedPlan(concurrentInstalled);
  const concurrentPlan = await installPlan({
    projectRoot: concurrentRoot,
    bundle,
    profiles: null,
    activationMode: 'marketplace-companion',
    expectedPriorProjection: concurrentInstalled.nextProjection,
  });
  const concurrentPath = concurrentPlan.writes[0].path;
  await assert.rejects(
    applyManagedPlanForTest(concurrentPlan, {
      afterMutationApplied: async ({ path: relative, mutationIndex }) => {
        if (mutationIndex === 1) {
          await chmod(path.join(concurrentRoot, relative), 0o600);
          throw new Error('injected primary mode-race failure');
        }
      },
      beforeRollbackRestore: () => {},
    }),
    (error) => {
      assert.match(error.message, /injected primary mode-race failure/);
      assert.match(error.message, new RegExp(`${concurrentPath.replaceAll('/', '\\/')}: concurrent postimage changed; left untouched`));
      return true;
    },
  );
  assert.equal((await stat(path.join(concurrentRoot, concurrentPath))).mode & 0o777, 0o600);
});

test('apply rejects forged unmanaged or executable plans before output', async (t) => {
  const projectRoot = await scratchProject(t);
  const plan = (pathValue, mode, bytes) => ({
    projectRoot,
    operation: 'install',
    activationMode: 'marketplace-companion',
    nativeObservationToken: null,
    nextProjection: null,
    writes: [{
      path: pathValue,
      mode,
      bytes,
      sha256: '0'.repeat(64),
      preimageSha256: null,
      preimageMode: null,
    }],
    deletes: [],
  });
  await assert.rejects(
    applyManagedPlan(plan('docs/private/knowledge.md', 0o644, Buffer.from('replace\n'))),
    /unmanaged write target/,
  );
  await assert.rejects(
    applyManagedPlan(plan('.claude/agents/unsafe.md', 0o755, Buffer.from('#!/bin/sh\n'))),
    /managed write mode must be non-executable/,
  );
  assert.equal(await readFile(path.join(projectRoot, '.codex/config.toml'), 'utf8'), 'theme = "dark"\n');
});
