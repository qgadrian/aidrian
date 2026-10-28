import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  S5_PROFILES,
  assemblePinnedS5Bundle,
  assemblePinnedS5BundleWithPolicy,
  ROOT,
} from './helpers.mjs';

const EXPECTED_PROVIDER_SURFACES = Object.freeze([
  'claude:producer-project-role',
  'codex:producer-project-role',
  'claude:neutral-fixture-a-invocation',
  'codex:neutral-fixture-a-invocation',
  'claude:neutral-fixture-b-invocation',
  'codex:neutral-fixture-b-invocation',
  'claude+codex:full-project-bundle-activation-and-native-mode-collision',
]);

const parseProviderRows = (document) => {
  const match = document.match(
    /<!-- provider-attended-rows:start -->\n```json\n([\s\S]+?)\n```\n<!-- provider-attended-rows:end -->/,
  );
  assert.ok(match, 'docs/providers.md must contain the provider-attended row block');
  return JSON.parse(match[1]);
};

const assertProviderRowsUnverified = (document) => {
  const rows = parseProviderRows(document);
  assert.deepEqual(
    rows.map(({ provider, surface }) => `${provider}:${surface}`),
    EXPECTED_PROVIDER_SURFACES,
  );
  assert.equal(rows.every(({ status }) => status === 'unverified'), true);
  assert.equal(rows.some(({ provider }) => /opencode/i.test(provider)), false);
  const fullMode = rows.find(({ surface }) => (
    surface === 'full-project-bundle-activation-and-native-mode-collision'
  ));
  assert.equal(fullMode.dependency, 'opaque native inventory token');
  return rows;
};

test('immutable S5 fixture profiles preserve independent caller pins and reviewer subsets', async () => {
  const [single, dual] = await Promise.all([
    assemblePinnedS5Bundle('single'),
    assemblePinnedS5Bundle('dual'),
  ]);
  assert.deepEqual(single.bundle.reviewers, {
    supportedReviewerIds: ['claude', 'codex'],
    requiredReviewerIds: ['claude'],
    reviewArguments: [],
  });
  assert.deepEqual(dual.bundle.reviewers, {
    supportedReviewerIds: ['claude', 'codex'],
    requiredReviewerIds: ['claude', 'codex'],
    reviewArguments: ['--await-codex'],
  });
  assert.equal(single.bundle.sourceCommit, dual.bundle.sourceCommit);
  assert.notEqual(single.bundle.bundleDigest, dual.bundle.bundleDigest);
  assert.equal(single.bundle.bundleDigest, S5_PROFILES.single.pins.bundleDigest);
  assert.equal(dual.bundle.bundleDigest, S5_PROFILES.dual.pins.bundleDigest);
});

test('an unavailable configured required reviewer fails by ID without fallback', async () => {
  const profile = structuredClone(S5_PROFILES.dual.reviewerPolicy);
  profile.availableReviewerIds = ['claude'];
  await assert.rejects(
    assemblePinnedS5BundleWithPolicy(profile),
    /required reviewer codex is unavailable; no fallback is permitted/,
  );
});

test('durable provider-attended rows remain unverified and reject unsupported promotion', async () => {
  const document = await readFile(path.join(ROOT, 'docs/providers.md'), 'utf8');
  assert.equal(assertProviderRowsUnverified(document).length, 7);
  const promoted = document.replace('"status": "unverified"', '"status": "pass"');
  assert.throws(
    () => assertProviderRowsUnverified(promoted),
    /false !== true/,
  );
});
