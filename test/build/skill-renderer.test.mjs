import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildCatalog } from '../../src/build/build.mjs';
import { listSkillFiles, renderSkillFiles, validateSkill } from '../../src/build/catalog.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');

test('skill rendering preserves Agent Skills body bytes and source mode', async () => {
  const files = await buildCatalog(ROOT);
  const rendered = files.get('shared/skills/grill-me/SKILL.md');
  const source = await readFile(path.join(ROOT, 'catalog/skills/grill-me/SKILL.md'));
  assert.ok(rendered);
  assert.deepEqual(rendered.bytes, source);
  assert.equal(rendered.mode, 0o644);
});

test('skill resource discovery preserves executable bits and rejects symlinks', async () => {
  const skill = await mkdtemp(path.join(os.tmpdir(), 'aidrian-skill-'));
  await mkdir(path.join(skill, 'scripts'));
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: example\n---\n');
  const executable = path.join(skill, 'scripts/run.sh');
  await writeFile(executable, '#!/bin/sh\n');
  await chmod(executable, 0o755);
  const files = await listSkillFiles(skill);
  assert.equal(files.find((file) => file.path === 'scripts/run.sh').mode, 0o755);
  await symlink('SKILL.md', path.join(skill, 'linked.md'));
  await assert.rejects(listSkillFiles(skill), /skill resources may not be symlinks \(linked\.md\)/);
});

test('composed skills use bounded declared slots across Agent Skills resources', async () => {
  const skill = await validateSkill(path.join(ROOT, 'catalog/skills/agent-issue-writer'), { root: ROOT });
  const rendered = await renderSkillFiles(skill, {
    schemaVersion: 1,
    skillId: 'agent-issue-writer',
    slots: { tracker_team_key: 'ACME', project_name_lower: 'acme', tracker_team_id: 'team-id', runtime_state_root: '.runtime' },
  }, { root: ROOT });
  const entrypoint = rendered.find((file) => file.path === 'SKILL.md').bytes.toString();
  assert.match(entrypoint, /team `ACME`/);
  assert.doesNotMatch(entrypoint, /\{\{slot:/);
  await assert.rejects(
    renderSkillFiles(skill, { schemaVersion: 1, skillId: 'agent-issue-writer', slots: { unknown: 'value' } }, { root: ROOT }),
    /unknown project slot unknown/,
  );
  await assert.rejects(
    renderSkillFiles(skill, { schemaVersion: 1, skillId: 'agent-issue-writer', slots: { tracker_team_key: 'x'.repeat(41) } }, { root: ROOT }),
    /project slot tracker_team_key exceeds maxLength 40/,
  );
});

test('project skill resources are hash-bound regular files outside the neutral bundle', async () => {
  const skill = await validateSkill(path.join(ROOT, 'catalog/skills/agent-issue-writer'), { root: ROOT });
  const resourceRoot = await mkdtemp(path.join(os.tmpdir(), 'aidrian-skill-resources-'));
  const source = Buffer.from('project-owned workflow fixture\n');
  await writeFile(path.join(resourceRoot, 'fixture.md'), source);
  const baseOverlay = {
    schemaVersion: 1,
    skillId: 'agent-issue-writer',
    slots: {},
    resources: {
      'references/fixture.md': {
        sourcePath: 'fixture.md',
        sha256: createHash('sha256').update(source).digest('hex'),
        mode: 0o644,
      },
    },
  };

  const rendered = await renderSkillFiles(skill, baseOverlay, { root: ROOT, resourceRoot });
  const fixture = rendered.find((file) => file.path === 'references/fixture.md');
  assert.deepEqual(fixture.bytes, source);
  assert.equal(fixture.mode, 0o644);

  await assert.rejects(
    renderSkillFiles(skill, {
      ...baseOverlay,
      resources: { 'references/fixture.md': { ...baseOverlay.resources['references/fixture.md'], sha256: '0'.repeat(64) } },
    }, { root: ROOT, resourceRoot }),
    /project resource references\/fixture\.md sha256 mismatch/,
  );

  await symlink('fixture.md', path.join(resourceRoot, 'linked.md'));
  await assert.rejects(
    renderSkillFiles(skill, {
      ...baseOverlay,
      resources: { 'references/fixture.md': { ...baseOverlay.resources['references/fixture.md'], sourcePath: 'linked.md' } },
    }, { root: ROOT, resourceRoot }),
    /symbolic links are not allowed/,
  );

  await assert.rejects(
    renderSkillFiles(skill, {
      ...baseOverlay,
      resources: { 'SKILL.md': baseOverlay.resources['references/fixture.md'] },
    }, { root: ROOT, resourceRoot }),
    /project resource SKILL\.md collides with a neutral skill resource/,
  );

  await assert.rejects(
    renderSkillFiles(skill, {
      ...baseOverlay,
      resources: { '../escape.md': baseOverlay.resources['references/fixture.md'] },
    }, { root: ROOT, resourceRoot }),
    /unsafe target path/,
  );
  await assert.rejects(
    renderSkillFiles(skill, {
      ...baseOverlay,
      resources: { 'references/fixture.md': { ...baseOverlay.resources['references/fixture.md'], sourcePath: '../escape.md' } },
    }, { root: ROOT, resourceRoot }),
    /unsafe source path/,
  );
});
