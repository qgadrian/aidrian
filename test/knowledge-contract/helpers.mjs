import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateKnowledgeRegistry } from '../../src/project-bundle/knowledge-registry.mjs';

export const validFixtureRoot = fileURLToPath(
  new URL('../../knowledge-contract/fixtures/valid/', import.meta.url),
);

export async function makeFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'aidrian-knowledge-'));
  await cp(validFixtureRoot, root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), 'utf8'));
}

export async function writeJson(root, relativePath, value) {
  await writeFile(
    path.join(root, relativePath),
    JSON.stringify(value, null, 2) + '\n',
  );
}

export const validateFixture = (root) => validateKnowledgeRegistry({
  rootDir: root,
  projectPath: 'project.json',
});
