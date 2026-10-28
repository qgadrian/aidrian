import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assemblePrivateDistribution,
  PRIVATE_DESCRIPTOR_DENYLIST,
  assertPositiveCorePaths,
} from '../../src/project-bundle/assemble.mjs';
import { validateDataBundle } from '../../src/project-bundle/managed-projection.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const SOURCE_COMMIT = 'f714cfac938af8a70dbe7bf540f965ab7d728b05';
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

test('assembles a reproducible data-only bundle with strict empty executable closure', async () => {
  const first = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  const second = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  assert.equal(first.bundle.bundleDigest, second.bundle.bundleDigest);
  assert.deepEqual(first.bundle, second.bundle);
  assert.equal(first.version, '0.0.0');
  assert.equal(first.manifests.claude.version, first.version);
  assert.equal(first.manifests.codex.version, first.version);
  assert.equal(first.bundle.plugin.version, first.version);
  assert.equal('version' in first.catalogs.claude.plugins[0], false);
  assert.equal('version' in first.catalogs.codex.plugins[0], false);
  assert.deepEqual(first.semanticInventory, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(ROOT, 'capabilities/executables.json'))), {
    schemaVersion: 1,
    executables: [],
  });
  assert.equal(first.pluginFiles.has('hooks/hooks.json'), false);
  assert.equal(first.pluginFiles.has('.codex-plugin/plugin.json'), false);
  assert.equal(first.bundle.files.some(({ path: relative }) => relative.includes('hooks/')), false);
  assert.equal(first.bundle.files.some(({ path: relative }) => /launcher|dispatcher|approval/i.test(relative)), false);
  validateDataBundle(first.bundle);
  assert.deepEqual(Object.keys(bundlePinsFromBundle(first.bundle)).sort(), [
    'builder',
    'bundleDigest',
    'capabilityManifestDigest',
    'manifestDigest',
    'plugin',
    'provenanceManifestDigest',
    'providerManifestDigests',
    'schemaVersion',
    'sourceCommit',
  ]);
  assert.equal(
    first.bundle.provenanceManifestDigest,
    createHash('sha256')
      .update(await readFile(path.join(ROOT, 'provenance/distribution-files.json')))
      .digest('hex'),
  );
  assert.deepEqual(
    first.bundle.ledger.map(({ path: relative }) => relative),
    [...first.bundle.ledger.map(({ path: relative }) => relative)]
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  );
});

test('catalogs resolve the aidrian plugin and checked-in bytes match live assembly', async () => {
  const assembled = await assemblePrivateDistribution({ root: ROOT, sourceCommit: SOURCE_COMMIT });
  assert.equal(assembled.catalogs.claude.plugins[0].source, './plugins/aidrian');
  assert.equal(assembled.catalogs.codex.plugins[0].source.path, './plugins/aidrian');
  for (const [relative, file] of assembled.repositoryFiles) {
    assert.deepEqual(await readFile(path.join(ROOT, relative)), file.bytes, `${relative} is current`);
  }
});

test('permanently rejects all project-private knowledge descriptors', () => {
  assert.equal(PRIVATE_DESCRIPTOR_DENYLIST.length, 6);
  for (const descriptor of PRIVATE_DESCRIPTOR_DENYLIST) {
    assert.throws(() => assertPositiveCorePaths([descriptor]), new RegExp(descriptor.replaceAll('/', '\\/')));
  }
});

test('accepts one supported reviewer and Acme dual review but never substitutes an unavailable reviewer', async () => {
  const single = await assemblePrivateDistribution({
    root: ROOT,
    sourceCommit: SOURCE_COMMIT,
    reviewerPolicy: {
      supportedReviewerIds: ['claude'],
      requiredReviewerIds: ['claude'],
      availableReviewerIds: ['claude'],
    },
  });
  assert.deepEqual(single.bundle.reviewers.requiredReviewerIds, ['claude']);
  const acme = await assemblePrivateDistribution({
    root: ROOT,
    sourceCommit: SOURCE_COMMIT,
    reviewerPolicy: {
      supportedReviewerIds: ['claude', 'codex'],
      requiredReviewerIds: ['claude', 'codex'],
      availableReviewerIds: ['claude', 'codex'],
      awaitCodex: true,
    },
  });
  assert.deepEqual(acme.bundle.reviewers.reviewArguments, ['--await-codex']);
  await assert.rejects(
    assemblePrivateDistribution({
      root: ROOT,
      sourceCommit: SOURCE_COMMIT,
      reviewerPolicy: {
        supportedReviewerIds: ['claude', 'codex'],
        requiredReviewerIds: ['codex'],
        availableReviewerIds: ['claude'],
      },
    }),
    /required reviewer codex is unavailable; no fallback is permitted/,
  );
});
