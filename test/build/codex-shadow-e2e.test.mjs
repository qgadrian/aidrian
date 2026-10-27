import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCatalog, loadProjectOverlays } from '../../src/build/build.mjs';
import { compareRenderedTree } from '../../src/build/compare-rendered.mjs';
import { writeTree } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('external Codex shadow comparison accepts an independent supplied witness and reports mode drift', async (context) => {
  const expected = process.env.AIDRIAN_CODEX_EXPECTED_ROOT;
  const overlayRoot = process.env.AIDRIAN_PROJECT_OVERLAYS;
  if (!expected || !overlayRoot) return context.skip('set AIDRIAN_CODEX_EXPECTED_ROOT and AIDRIAN_PROJECT_OVERLAYS for external S1 proof');
  const files = await buildCatalog(ROOT, await loadProjectOverlays(overlayRoot), { candidateInventory: process.env.AIDRIAN_CANDIDATE_INVENTORY ?? null });
  const actual = await mkdtemp(path.join(os.tmpdir(), 'aidrian-codex-actual-'));
  const filter = (relative) => ['codex/agents/explorer.toml', 'codex/agents/github-archaeologist.toml'].includes(relative);
  await writeTree(actual, files, filter);
  assert.deepEqual(await compareRenderedTree(actual, expected), { files: 2 });
  const drifted = await mkdtemp(path.join(os.tmpdir(), 'aidrian-codex-drift-'));
  await cp(expected, drifted, { recursive: true });
  await chmod(path.join(drifted, 'codex/agents/explorer.toml'), 0o755);
  await assert.rejects(compareRenderedTree(actual, drifted), /codex\/agents\/explorer\.toml: mode 644 != 755/);
});
