import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { x as extractTar } from 'tar';

import { stableJson } from '../../src/project-bundle/assemble.mjs';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const S5_SOURCE_COMMIT = 'abc1757d1a7f2f8a84bb24969284f0ee4ea3e335';

const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const S5_PROFILES = Object.freeze({
  single: Object.freeze({
    reviewerPolicy: Object.freeze({
      supportedReviewerIds: Object.freeze(['claude', 'codex']),
      requiredReviewerIds: Object.freeze(['claude']),
      availableReviewerIds: Object.freeze(['claude']),
      awaitCodex: false,
    }),
    pins: Object.freeze({
      schemaVersion: 1,
      sourceCommit: S5_SOURCE_COMMIT,
      builder: Object.freeze({ id: 'aidrian-project-bundle', version: 1 }),
      plugin: Object.freeze({ id: 'aidrian', version: '0.0.0' }),
      manifestDigest: 'fe7028e07a544c5e5225d4a40e97d27526c425f2e0c8168fd4b526abeda53ae2',
      bundleDigest: '051218f70486d34a16080bebbbdab9ddb6d66da8f49efc50f3772f63f757d301',
      provenanceManifestDigest: '4331f27b57889e1f1d1688cd150ec22b74b41485e63f95e492e3c23f58a18f63',
      providerManifestDigests: Object.freeze({
        claude: 'eb6194109987466e180984182d57f973dc514430be83dc3c86df8c364aca76ec',
        codex: 'de26b94aad710ec249af9653c14e9d1e863578099206db958b6a6118450bd92f',
      }),
      capabilityManifestDigest: '4e392e91e7fb4ec3c68be43f6f7de88f17a24e22ba64b4acc396880a075d68cf',
    }),
    bundleStableSha256: '08dd98aa9765b615bf1d4de025bcb8475918e45fee208c04d02c31f013083090',
  }),
  dual: Object.freeze({
    reviewerPolicy: Object.freeze({
      supportedReviewerIds: Object.freeze(['claude', 'codex']),
      requiredReviewerIds: Object.freeze(['claude', 'codex']),
      availableReviewerIds: Object.freeze(['claude', 'codex']),
      awaitCodex: true,
    }),
    pins: Object.freeze({
      schemaVersion: 1,
      sourceCommit: S5_SOURCE_COMMIT,
      builder: Object.freeze({ id: 'aidrian-project-bundle', version: 1 }),
      plugin: Object.freeze({ id: 'aidrian', version: '0.0.0' }),
      manifestDigest: 'f5e1920409ba01cf0cc3dcb3187a9471337953f01e3fa3223a98b73ccc72bd44',
      bundleDigest: '8318ae7186412f3f4622ad1186ada992788461572c7781ea6071b8e83b48955a',
      provenanceManifestDigest: '4331f27b57889e1f1d1688cd150ec22b74b41485e63f95e492e3c23f58a18f63',
      providerManifestDigests: Object.freeze({
        claude: 'eb6194109987466e180984182d57f973dc514430be83dc3c86df8c364aca76ec',
        codex: 'de26b94aad710ec249af9653c14e9d1e863578099206db958b6a6118450bd92f',
      }),
      capabilityManifestDigest: '4e392e91e7fb4ec3c68be43f6f7de88f17a24e22ba64b4acc396880a075d68cf',
    }),
    bundleStableSha256: '2784de4240d833d66ac3b99900f7aba00672f11c7ae5a2f306b92a1adc2e80cd',
  }),
});

export const bundlePinsFromBundle = (bundle) => ({
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

const withPinnedS5Source = async (callback) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-s5-source-'));
  const archivePath = path.join(fixtureRoot, 'source.tar');
  const sourceRoot = path.join(fixtureRoot, 'source');
  try {
    await mkdir(sourceRoot);
    await execFileAsync('git', [
      'archive',
      '--format=tar',
      '--output',
      archivePath,
      S5_SOURCE_COMMIT,
    ], { cwd: ROOT });
    await extractTar({ cwd: sourceRoot, file: archivePath, strict: true });
    await symlink(path.join(ROOT, 'node_modules'), path.join(sourceRoot, 'node_modules'), 'dir');
    const moduleUrl = pathToFileURL(path.join(sourceRoot, 'src/project-bundle/assemble.mjs'));
    moduleUrl.searchParams.set('fixture', randomUUID());
    const pinnedModule = await import(moduleUrl.href);
    return await callback({ sourceRoot, pinnedModule });
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
};

export const assemblePinnedS5Bundle = async (profileId) => {
  const profile = S5_PROFILES[profileId];
  if (!profile) throw new Error(`unknown S5 fixture profile ${profileId}`);
  return withPinnedS5Source(async ({ sourceRoot, pinnedModule }) => {
    const assembled = await pinnedModule.assemblePrivateDistribution({
      root: sourceRoot,
      sourceCommit: S5_SOURCE_COMMIT,
      reviewerPolicy: structuredClone(profile.reviewerPolicy),
    });
    assert.deepEqual(bundlePinsFromBundle(assembled.bundle), structuredClone(profile.pins));
    assert.equal(sha256(pinnedModule.stableJson(assembled.bundle)), profile.bundleStableSha256);
    return assembled;
  });
};

export const assemblePinnedS5BundleWithPolicy = async (reviewerPolicy) => (
  withPinnedS5Source(({ sourceRoot, pinnedModule }) => (
    pinnedModule.assemblePrivateDistribution({
      root: sourceRoot,
      sourceCommit: S5_SOURCE_COMMIT,
      reviewerPolicy,
    })
  ))
);

export const createNeutralConsumer = async (fixtureId) => {
  const root = await mkdtemp(path.join(tmpdir(), `aidrian-neutral-${fixtureId}-`));
  const projectRoot = path.join(root, 'project');
  const stateRoot = path.join(root, 'state');
  const cacheRoot = path.join(stateRoot, 'cache');
  const logRoot = path.join(stateRoot, 'logs');
  const artifactRoot = path.join(stateRoot, 'artifacts');
  await Promise.all([
    mkdir(path.join(projectRoot, '.codex'), { recursive: true }),
    mkdir(cacheRoot, { recursive: true }),
    mkdir(logRoot, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  await writeFile(path.join(projectRoot, '.codex/config.toml'), `fixture = "${fixtureId}"\n`);
  const secret = `SYNTHETIC_${fixtureId.toUpperCase()}_SECRET_7c1149`;
  await writeFile(path.join(projectRoot, 'fixture-private.txt'), `${secret}\n`);
  let cleaned = false;
  return {
    fixtureId,
    root,
    projectRoot,
    stateRoot,
    cacheRoot,
    logRoot,
    artifactRoot,
    secret,
    async cleanup() {
      if (cleaned) return;
      assert.equal(path.basename(root).startsWith(`aidrian-neutral-${fixtureId}-`), true);
      await rm(root, { force: true, recursive: true });
      cleaned = true;
    },
  };
};

export const readTree = async (root) => {
  const files = [];
  const visit = async (directory, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${relative}: fixture tree contains a symbolic link`);
      if (stat.isDirectory()) await visit(absolute, relative);
      else if (stat.isFile()) files.push({ path: relative, bytes: await readFile(absolute) });
      else throw new Error(`${relative}: fixture tree contains a non-regular entry`);
    }
  };
  await visit(root);
  return files;
};

export const redactedLifecycleReport = ({ fixtureId, operation, bundle, ownedFiles }) => ({
  fixtureId,
  operation,
  bundleDigest: bundle.bundleDigest,
  managedFileCount: ownedFiles.length,
});

export const stableReport = (value) => stableJson(value);
