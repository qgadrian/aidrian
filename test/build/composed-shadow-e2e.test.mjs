import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseDocument } from 'yaml';

import { buildCatalog, loadProjectOverlays, loadSkillOverlays } from '../../src/build/build.mjs';
import { compareRenderedTree } from '../../src/build/compare-rendered.mjs';
import { writeTree } from './helpers.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const AGENTS = ['agent-issue-writer', 'design-source-explorer', 'doc-updater', 'explorer', 'github-archaeologist', 'harness-engineer', 'initiative-agent', 'integrator', 'planning-agent'];
const SKILLS = ['agent-issue-writer', 'design-import', 'initiative-agent', 'planning-agent', 'worktree-integrate'];

const parseClaudeFrontmatter = (bytes, id) => {
  const match = bytes.toString().match(/^---\n([\s\S]*?)\n---\n?/);
  assert.ok(match, `${id}: missing Claude YAML frontmatter`);
  const document = parseDocument(match[1], { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors.map((error) => error.message), [], `${id}: invalid Claude YAML frontmatter`);
  return document.toJS();
};

test('composed agents and workflow companions match an independent supplied committed witness', async (context) => {
  const expected = process.env.AIDRIAN_COMPOSED_EXPECTED_ROOT;
  const agentOverlayRoot = process.env.AIDRIAN_PROJECT_OVERLAYS;
  const skillOverlayRoot = process.env.AIDRIAN_SKILL_OVERLAYS;
  const skillResourceRoot = process.env.AIDRIAN_SKILL_RESOURCE_ROOT;
  if (!expected || !agentOverlayRoot || !skillOverlayRoot || !skillResourceRoot) {
    return context.skip('set composed witness and agent/skill overlay/resource roots for external committed-source proof');
  }
  const files = await buildCatalog(ROOT, await loadProjectOverlays(agentOverlayRoot), {
    candidateInventory: process.env.AIDRIAN_CANDIDATE_INVENTORY ?? null,
    skillOverlays: await loadSkillOverlays(skillOverlayRoot),
    skillResourceRoot,
  });
  const actual = await mkdtemp(path.join(os.tmpdir(), 'aidrian-composed-actual-'));
  const filter = (relative) => {
    if (relative.startsWith('claude/agents/')) {
      const id = path.posix.basename(relative, '.md');
      return AGENTS.includes(id);
    }
    if (relative.startsWith('codex/agents/')) return AGENTS.includes(path.posix.basename(relative, '.toml'));
    if (relative.startsWith('shared/skills/')) return SKILLS.includes(relative.split('/')[2]);
    return false;
  };
  await writeTree(actual, files, filter);
  const result = await compareRenderedTree(actual, expected);
  assert.equal(result.files, 47, 'expected all agents and multi-resource skill witnesses');

  const renderedClaude = {};
  const expectedClaude = {};
  for (const id of AGENTS) {
    renderedClaude[id] = parseClaudeFrontmatter(files.get(`claude/agents/${id}.md`).bytes, `rendered ${id}`);
    expectedClaude[id] = parseClaudeFrontmatter(await readFile(path.join(expected, 'claude/agents', `${id}.md`)), `expected ${id}`);
    assert.deepEqual(renderedClaude[id], expectedClaude[id], `${id}: Claude YAML semantics differ from the supplied witness`);
  }
  for (const field of ['description', 'model', 'effort', 'tools']) {
    assert.deepEqual(renderedClaude['harness-engineer'][field], expectedClaude['harness-engineer'][field], `harness-engineer: ${field} differs from the supplied witness`);
  }

  const drifted = await mkdtemp(path.join(os.tmpdir(), 'aidrian-composed-drift-'));
  await cp(actual, drifted, { recursive: true });
  await writeFile(path.join(drifted, 'claude/agents/harness-engineer.md'), 'invalid Claude role bytes\n');
  await assert.rejects(compareRenderedTree(drifted, expected), /claude\/agents\/harness-engineer\.md: bytes differ/);
});
