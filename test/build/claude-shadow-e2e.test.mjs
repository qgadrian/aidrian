import assert from 'node:assert/strict';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCatalog, loadProjectOverlays } from '../../src/build/build.mjs';
import { compareRenderedTree } from '../../src/build/compare-rendered.mjs';
import { writeTree } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('external Claude shadow comparison accepts an independent supplied witness and reports byte drift', async (context) => {
  const expected = process.env.AIDRIAN_CLAUDE_EXPECTED_ROOT;
  const overlayRoot = process.env.AIDRIAN_PROJECT_OVERLAYS;
  if (!expected || !overlayRoot) return context.skip('set AIDRIAN_CLAUDE_EXPECTED_ROOT and AIDRIAN_PROJECT_OVERLAYS for external S1 proof');
  const files = await buildCatalog(ROOT, await loadProjectOverlays(overlayRoot), { candidateInventory: process.env.AIDRIAN_CANDIDATE_INVENTORY ?? null });
  const actual = await mkdtemp(path.join(os.tmpdir(), 'aidrian-claude-actual-'));
  const filter = (relative) => ['claude/agents/explorer.md', 'claude/agents/github-archaeologist.md'].includes(relative);
  await writeTree(actual, files, filter);
  assert.deepEqual(await compareRenderedTree(actual, expected), { files: 2 });
  const drifted = await mkdtemp(path.join(os.tmpdir(), 'aidrian-claude-drift-'));
  await cp(expected, drifted, { recursive: true });
  await writeFile(path.join(drifted, 'claude/agents/explorer.md'), 'external snapshot drift\n');
  await assert.rejects(compareRenderedTree(actual, drifted), /claude\/agents\/explorer\.md: bytes differ/);
});
