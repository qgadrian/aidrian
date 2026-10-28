import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  applyManagedPlan,
  planManagedInstall,
  planManagedUninstall,
} from '../../src/project-bundle/managed-projection.mjs';

import {
  S5_PROFILES,
  assemblePinnedS5Bundle,
  createNeutralConsumer,
  readTree,
  redactedLifecycleReport,
  stableReport,
} from './helpers.mjs';

const install = async ({ fixture, assembled, profileId }) => {
  const plan = await planManagedInstall({
    projectRoot: fixture.projectRoot,
    bundle: assembled.bundle,
    activationMode: 'marketplace-companion',
    expectedBundlePins: structuredClone(S5_PROFILES[profileId].pins),
    expectedPriorProjection: null,
    nativeObservationToken: null,
  });
  await applyManagedPlan(plan);
  return plan;
};

test('neutral consumers keep project, reviewer, state, cache, log, and artifact data isolated', async () => {
  const [fixtureA, fixtureB] = await Promise.all([
    createNeutralConsumer('a-isolation'),
    createNeutralConsumer('b-isolation'),
  ]);
  const [single, dual] = await Promise.all([
    assemblePinnedS5Bundle('single'),
    assemblePinnedS5Bundle('dual'),
  ]);
  try {
    const [planA, planB] = await Promise.all([
      install({ fixture: fixtureA, assembled: single, profileId: 'single' }),
      install({ fixture: fixtureB, assembled: dual, profileId: 'dual' }),
    ]);
    assert.notEqual(fixtureA.root, fixtureB.root);
    assert.notEqual(fixtureA.cacheRoot, fixtureB.cacheRoot);
    assert.notEqual(fixtureA.logRoot, fixtureB.logRoot);
    assert.notEqual(fixtureA.artifactRoot, fixtureB.artifactRoot);
    assert.notEqual(planA.nextProjection.bundlePins.bundleDigest, planB.nextProjection.bundlePins.bundleDigest);
    assert.deepEqual(single.bundle.reviewers.requiredReviewerIds, ['claude']);
    assert.deepEqual(dual.bundle.reviewers.requiredReviewerIds, ['claude', 'codex']);

    const [treeA, treeB] = await Promise.all([
      readTree(fixtureA.root),
      readTree(fixtureB.root),
    ]);
    const bytesA = Buffer.concat(treeA.map(({ bytes }) => bytes)).toString('utf8');
    const bytesB = Buffer.concat(treeB.map(({ bytes }) => bytes)).toString('utf8');
    assert.equal(bytesA.includes(fixtureB.secret), false);
    assert.equal(bytesB.includes(fixtureA.secret), false);
    assert.equal(stableReport(single.bundle).includes(fixtureA.secret), false);
    assert.equal(stableReport(single.bundle).includes(fixtureB.secret), false);
    assert.equal(stableReport(dual.bundle).includes(fixtureA.secret), false);
    assert.equal(stableReport(dual.bundle).includes(fixtureB.secret), false);

    const reportA = redactedLifecycleReport({
      fixtureId: fixtureA.fixtureId,
      operation: 'installed',
      bundle: single.bundle,
      ownedFiles: planA.nextProjection.ownedFiles,
    });
    const reportB = redactedLifecycleReport({
      fixtureId: fixtureB.fixtureId,
      operation: 'installed',
      bundle: dual.bundle,
      ownedFiles: planB.nextProjection.ownedFiles,
    });
    const reports = JSON.stringify([reportA, reportB]);
    for (const forbidden of [fixtureA.secret, fixtureB.secret, fixtureA.root, fixtureB.root]) {
      assert.equal(reports.includes(forbidden), false);
    }
    assert.equal(await readFile(path.join(fixtureA.projectRoot, 'fixture-private.txt'), 'utf8'), `${fixtureA.secret}\n`);
    assert.equal(await readFile(path.join(fixtureB.projectRoot, 'fixture-private.txt'), 'utf8'), `${fixtureB.secret}\n`);

    await applyManagedPlan(await planManagedUninstall({
      projectRoot: fixtureA.projectRoot,
      expectedPriorProjection: planA.nextProjection,
      nativeObservationToken: null,
    }));
    await applyManagedPlan(await planManagedUninstall({
      projectRoot: fixtureB.projectRoot,
      expectedPriorProjection: planB.nextProjection,
      nativeObservationToken: null,
    }));
  } finally {
    await Promise.all([fixtureA.cleanup(), fixtureB.cleanup()]);
  }
});
