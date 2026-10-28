import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assemblePrivateDistribution } from '../../../src/project-bundle/assemble.mjs';
import {
  applyManagedPlan,
  planManagedInstall,
} from '../../../src/project-bundle/managed-projection.mjs';

const ROOT = path.resolve(import.meta.dirname, '../../..');
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

test('Codex companion projection preserves unrelated config and rejects unowned ids and paths', async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-codex-roles-'));
  t.after(() => rm(projectRoot, { force: true, recursive: true }));
  await mkdir(path.join(projectRoot, '.codex'), { recursive: true });
  const unrelated = [
    'model = "gpt-6.1-sol"',
    '',
    '[mcp_servers.example]',
    'url = "https://example.invalid/mcp"',
    '',
  ].join('\n');
  await writeFile(path.join(projectRoot, '.codex/config.toml'), unrelated);
  const { bundle } = await assemblePrivateDistribution({ root: ROOT });
  const expectedBundlePins = bundlePinsFromBundle(bundle);
  await applyManagedPlan(await planManagedInstall({
    projectRoot,
    bundle,
    activationMode: 'marketplace-companion',
    expectedBundlePins,
    expectedPriorProjection: null,
  }));
  const config = await readFile(path.join(projectRoot, '.codex/config.toml'), 'utf8');
  assert.equal(config.startsWith(unrelated), true);
  assert.match(config, /\[agents\.explorer\]/);
  assert.match(config, /config_file = "agents\/explorer\.toml"/);
  assert.match(await readFile(path.join(projectRoot, '.codex/agents/explorer.toml'), 'utf8'), /gpt-5\.6-terra/);

  const duplicateRoot = await mkdtemp(path.join(tmpdir(), 'aidrian-codex-duplicate-'));
  t.after(() => rm(duplicateRoot, { force: true, recursive: true }));
  await mkdir(path.join(duplicateRoot, '.codex'), { recursive: true });
  await writeFile(path.join(duplicateRoot, '.codex/config.toml'), [
    '[agents.explorer]',
    'config_file = "agents/explorer.toml"',
    '',
    '[agents.explorer-copy]',
    'config_file = "agents/explorer.toml"',
    '',
  ].join('\n'));
  await assert.rejects(
    planManagedInstall({
      projectRoot: duplicateRoot,
      bundle,
      activationMode: 'marketplace-companion',
      expectedBundlePins,
      expectedPriorProjection: null,
    }),
    (error) => {
      assert.match(error.message, /config-agent-owned-collision:explorer/);
      assert.match(error.message, /config-path-duplicate:agents\/explorer\.toml/);
      assert.match(error.message, /config-path-owned-collision:agents\/explorer\.toml/);
      return true;
    },
  );
});
