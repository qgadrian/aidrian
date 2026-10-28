import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  MANAGED_LEDGER_PATH,
  applyManagedPlan,
  planManagedInstall,
  planManagedUninstall,
} from '../../src/project-bundle/managed-projection.mjs';

import {
  S5_PROFILES,
  assemblePinnedS5Bundle,
  createNeutralConsumer,
  redactedLifecycleReport,
} from './helpers.mjs';

const assertMissing = async (target) => {
  await assert.rejects(access(target), (error) => error.code === 'ENOENT');
};

const installPlan = ({ fixture, bundle, profileId, expectedPriorProjection = null }) => (
  planManagedInstall({
    projectRoot: fixture.projectRoot,
    bundle,
    activationMode: 'marketplace-companion',
    expectedBundlePins: structuredClone(S5_PROFILES[profileId].pins),
    expectedPriorProjection,
    nativeObservationToken: null,
  })
);

const runLifecycle = async ({ fixtureId, initialProfileId, updateProfileId }) => {
  const fixture = await createNeutralConsumer(fixtureId);
  const initial = await assemblePinnedS5Bundle(initialProfileId);
  const update = await assemblePinnedS5Bundle(updateProfileId);
  const originalConfig = await readFile(path.join(fixture.projectRoot, '.codex/config.toml'));
  try {
    const installed = await installPlan({
      fixture,
      bundle: initial.bundle,
      profileId: initialProfileId,
    });
    await applyManagedPlan(installed);
    const installedLedger = JSON.parse(await readFile(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH)));
    assert.equal(installedLedger.bundleDigest, S5_PROFILES[initialProfileId].pins.bundleDigest);

    const updated = await installPlan({
      fixture,
      bundle: update.bundle,
      profileId: updateProfileId,
      expectedPriorProjection: installed.nextProjection,
    });
    await applyManagedPlan(updated);
    const updatedLedger = JSON.parse(await readFile(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH)));
    assert.equal(updatedLedger.bundleDigest, S5_PROFILES[updateProfileId].pins.bundleDigest);

    const rolledBack = await installPlan({
      fixture,
      bundle: initial.bundle,
      profileId: initialProfileId,
      expectedPriorProjection: updated.nextProjection,
    });
    await applyManagedPlan(rolledBack);
    const rollbackLedger = JSON.parse(await readFile(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH)));
    assert.equal(rollbackLedger.bundleDigest, S5_PROFILES[initialProfileId].pins.bundleDigest);

    const uninstalled = await planManagedUninstall({
      projectRoot: fixture.projectRoot,
      expectedPriorProjection: rolledBack.nextProjection,
      nativeObservationToken: null,
    });
    await applyManagedPlan(uninstalled);
    assert.deepEqual(await readFile(path.join(fixture.projectRoot, '.codex/config.toml')), originalConfig);
    await assertMissing(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH));
    for (const owned of rolledBack.nextProjection.ownedFiles) {
      await assertMissing(path.join(fixture.projectRoot, owned.path));
    }
    assert.equal(
      await readFile(path.join(fixture.projectRoot, 'fixture-private.txt'), 'utf8'),
      `${fixture.secret}\n`,
    );
    const report = redactedLifecycleReport({
      fixtureId,
      operation: 'install-update-rollback-uninstall',
      bundle: initial.bundle,
      ownedFiles: rolledBack.nextProjection.ownedFiles,
    });
    assert.equal(JSON.stringify(report).includes(fixture.secret), false);
    assert.equal(JSON.stringify(report).includes(fixture.root), false);
  } finally {
    await fixture.cleanup();
  }
  await assertMissing(fixture.root);
};

test('two caller-pinned neutral consumers complete companion lifecycle and exact cleanup', async () => {
  await runLifecycle({ fixtureId: 'a', initialProfileId: 'single', updateProfileId: 'dual' });
  await runLifecycle({ fixtureId: 'b', initialProfileId: 'dual', updateProfileId: 'single' });
});

test('companion preflight rejects unowned config collisions without mutation', async () => {
  const fixture = await createNeutralConsumer('companion-collision');
  const { bundle } = await assemblePinnedS5Bundle('single');
  const configPath = path.join(fixture.projectRoot, '.codex/config.toml');
  const collidingConfig = [
    'fixture = "companion-collision"',
    '',
    '[agents.explorer]',
    'config_file = "agents/explorer.toml"',
    '',
  ].join('\n');
  await writeFile(configPath, collidingConfig);
  try {
    await assert.rejects(
      installPlan({
        fixture,
        bundle,
        profileId: 'single',
      }),
      (error) => {
        assert.match(error.message, /config-agent-owned-collision:explorer/);
        assert.match(error.message, /config-path-owned-collision:agents\/explorer\.toml/);
        return true;
      },
    );
    assert.equal(await readFile(configPath, 'utf8'), collidingConfig);
    await assertMissing(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH));
  } finally {
    await fixture.cleanup();
  }
});

test('full project-bundle activation keeps the opaque native inventory dependency', async () => {
  const fixture = await createNeutralConsumer('native-guard');
  const { bundle } = await assemblePinnedS5Bundle('single');
  try {
    await assert.rejects(
      planManagedInstall({
        projectRoot: fixture.projectRoot,
        bundle,
        activationMode: 'project-bundle',
        expectedBundlePins: structuredClone(S5_PROFILES.single.pins),
        expectedPriorProjection: null,
        nativeObservationToken: null,
      }),
      /native observation token is missing or fabricated/,
    );
    await assertMissing(path.join(fixture.projectRoot, MANAGED_LEDGER_PATH));
  } finally {
    await fixture.cleanup();
  }
});
