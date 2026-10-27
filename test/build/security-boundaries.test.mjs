import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdtemp, mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildCatalog, writeCatalog } from '../../src/build/build.mjs';
import { validateAgent } from '../../src/build/catalog.mjs';
import { checkGenerated } from '../../src/build/check-generated.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '../..');

const inventory = async () => JSON.parse(await readFile(path.join(ROOT, 'catalog/rules/source-inventory.json'), 'utf8'));

test('catalog readers reject leaf and ancestor symbolic links', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aidrian-inputs-'));
  await cp(path.join(ROOT, 'catalog/rules'), path.join(scratch, 'catalog/rules'), { recursive: true });
  const agentDir = path.join(scratch, 'catalog/agents/explorer');
  await cp(path.join(ROOT, 'catalog/agents/explorer'), agentDir, { recursive: true });
  const outside = path.join(scratch, 'outside.md');
  await writeFile(outside, 'outside bytes\n');
  const linkedInstructions = path.join(agentDir, 'instructions.md');
  await unlink(linkedInstructions);
  await symlink(outside, linkedInstructions);
  await assert.rejects(validateAgent(agentDir, { root: scratch }), /symbolic links are not allowed/);
  await unlink(linkedInstructions);
  await copyFile(path.join(ROOT, 'catalog/agents/explorer/instructions.md'), linkedInstructions);
  const fragment = path.join(agentDir, 'fragments/claude-symbol-warmup.md');
  await unlink(fragment);
  await symlink(outside, fragment);
  await assert.rejects(validateAgent(agentDir, { root: scratch }), /symbolic links are not allowed/);

  const ancestorRoot = await mkdtemp(path.join(os.tmpdir(), 'aidrian-ancestor-'));
  await cp(path.join(ROOT, 'catalog/rules'), path.join(ancestorRoot, 'catalog/rules'), { recursive: true });
  await mkdir(path.join(ancestorRoot, 'catalog/agents'), { recursive: true });
  await symlink(path.join(ROOT, 'catalog/agents/explorer'), path.join(ancestorRoot, 'catalog/agents/explorer'));
  await assert.rejects(validateAgent(path.join(ancestorRoot, 'catalog/agents/explorer'), { root: ancestorRoot }), /symbolic links are not allowed/);
});

test('build binds selected source identities to the supplied external inventory', async () => {
  const forged = await inventory();
  forged.entries.find((entry) => entry.path === '.claude/agents/explorer.md').sourceSha256 = '0'.repeat(64);
  await assert.rejects(buildCatalog(ROOT, {}, { candidateInventory: forged }), /explorer: agent sourceSha256 does not match/);
  const missing = await inventory();
  missing.entries = missing.entries.filter((entry) => entry.path !== '.agents/skills/grill-me/SKILL.md');
  await assert.rejects(buildCatalog(ROOT, {}, { candidateInventory: missing }), /grill-me: selected skill is missing/);
});

test('builder preserves pre-existing external directories and supports fresh scratch output', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aidrian-output-'));
  const occupied = path.join(scratch, 'occupied');
  await mkdir(occupied);
  const marker = path.join(occupied, 'marker.txt');
  await writeFile(marker, 'preserve me\n');
  await assert.rejects(writeCatalog(ROOT, occupied), /refusing to replace pre-existing external build output/);
  assert.equal(await readFile(marker, 'utf8'), 'preserve me\n');

  const fresh = path.join(scratch, 'fresh');
  const result = await writeCatalog(ROOT, fresh);
  assert.equal(result.output, fresh);
  assert.ok(result.files.includes('codex/config.toml'));
});

test('builder rejects owned output paths with a symlinked ancestor before removing outside data', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aidrian-output-ancestor-'));
  const producer = path.join(scratch, 'producer');
  await mkdir(producer);
  await cp(path.join(ROOT, 'adapters'), path.join(producer, 'adapters'), { recursive: true });
  await cp(path.join(ROOT, 'catalog'), path.join(producer, 'catalog'), { recursive: true });
  const generated = path.join(producer, 'dist/generated');
  const outside = path.join(scratch, 'outside');
  const outsideChild = path.join(outside, 'child');
  await mkdir(generated, { recursive: true });
  await mkdir(outsideChild, { recursive: true });
  const marker = path.join(outsideChild, 'marker.txt');
  await writeFile(marker, 'preserve me\n');
  await symlink(outside, path.join(generated, 'link'), 'dir');

  await assert.rejects(
    writeCatalog(producer, 'dist/generated/link/child'),
    /refusing build output with symbolic-link ancestor/,
  );
  assert.equal(await readFile(marker, 'utf8'), 'preserve me\n');
});

test('builder rejects case-aliased project resources before replacing protected neutral output', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aidrian-resource-collision-'));
  const producer = path.join(scratch, 'producer');
  await mkdir(producer);
  await cp(path.join(ROOT, 'adapters'), path.join(producer, 'adapters'), { recursive: true });
  await cp(path.join(ROOT, 'catalog'), path.join(producer, 'catalog'), { recursive: true });
  const source = Buffer.from('project-owned replacement\n');
  await writeFile(path.join(producer, 'replacement.md'), source);
  const protectedNeutral = Buffer.from('protected neutral bytes\n');
  const protectedTarget = path.join(producer, 'dist/generated/shared/skills/agent-issue-writer/SKILL.md');
  await mkdir(path.dirname(protectedTarget), { recursive: true });
  await writeFile(protectedTarget, protectedNeutral);

  let denial;
  try {
    await writeCatalog(producer, 'dist/generated', {}, {
      skillOverlays: {
        'agent-issue-writer': {
          schemaVersion: 1,
          skillId: 'agent-issue-writer',
          slots: {},
          resources: {
            'skill.md': {
              sourcePath: 'replacement.md',
              sha256: createHash('sha256').update(source).digest('hex'),
              mode: 0o644,
            },
          },
        },
      },
      skillResourceRoot: producer,
    });
  } catch (error) {
    denial = error;
  }

  assert.deepEqual(await readFile(protectedTarget), protectedNeutral);
  assert.match(denial?.message ?? '', /project resource skill\.md collides with a neutral skill resource/);
});

test('all build boundary CLIs reject unknown, duplicate, missing, and flag-valued options', async () => {
  const cases = [
    ['src/build/build.mjs', ['--unknown']],
    ['src/build/build.mjs', ['--out', 'one', '--out', 'two']],
    ['src/build/build.mjs', ['--out']],
    ['src/build/build.mjs', ['--out', '--project-overlays']],
    ['src/build/classify-candidates.mjs', ['--unknown']],
    ['src/build/classify-candidates.mjs', ['--inventory', 'one', '--inventory', 'two']],
    ['src/build/classify-candidates.mjs', []],
    ['src/build/classify-candidates.mjs', ['--inventory', '--allowlist']],
    ['src/build/compare-rendered.mjs', ['--unknown']],
    ['src/build/compare-rendered.mjs', ['--actual', 'one', '--actual', 'two']],
    ['src/build/compare-rendered.mjs', []],
    ['src/build/compare-rendered.mjs', ['--actual', '--expected']],
  ];
  for (const [script, args] of cases) {
    await assert.rejects(run(process.execPath, [script, ...args], { cwd: ROOT }), /unknown argument|duplicate argument|requires a value|is required/);
  }
});

test('generated currentness compares durable names, modes, and bytes separately from determinism', async () => {
  const source = JSON.parse(await readFile(path.join(ROOT, 'test/build/generated-manifest.json'), 'utf8'));
  assert.equal((await checkGenerated()).deterministic, true);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'aidrian-manifest-'));
  const checkMutation = async (name, mutate, expected) => {
    const manifest = structuredClone(source);
    mutate(manifest.files);
    const file = path.join(scratch, `${name}.json`);
    await writeFile(file, JSON.stringify(manifest));
    await assert.rejects(checkGenerated({ manifestPath: file }), expected);
  };
  await checkMutation('missing', (files) => files.push({ name: 'ghost', mode: 420, sha256: '0'.repeat(64) }), /ghost: missing actual/);
  await checkMutation('unexpected', (files) => files.splice(0, 1), /capability-report\.json: unexpected actual/);
  await checkMutation('mode', (files) => { files[0].mode = 493; }, /capability-report\.json: mode 644 != 755/);
  await checkMutation('bytes', (files) => { files[0].sha256 = '0'.repeat(64); }, /capability-report\.json: bytes differ/);
});
