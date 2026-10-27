import assert from 'node:assert/strict';
import { unlink } from 'node:fs/promises';
import test from 'node:test';

import {
  makeFixture,
  readJson,
  validateFixture,
  writeJson,
} from './helpers.mjs';

test('validates the strict project, catalog, and folder schemas', async (t) => {
  const root = await makeFixture(t);
  const result = await validateFixture(root);

  assert.equal(result.projectId, 'sample-project');
  assert.equal(result.catalogPath, 'catalog.json');
  assert.equal(result.folderCount, 2);
  assert.equal(result.documentCount, 3);
});

test('rejects duplicate stable folder IDs', async (t) => {
  const root = await makeFixture(t);
  const descriptorPath = 'docs/project-notes/harness-knowledge.json';
  const descriptor = await readJson(root, descriptorPath);
  descriptor.id = 'shared-guides';
  await writeJson(root, descriptorPath, descriptor);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_DUPLICATE_ID/u);
});

test('rejects an absent declared descriptor path', async (t) => {
  const root = await makeFixture(t);
  await unlink(`${root}/docs/project-notes/harness-knowledge.json`);

  await assert.rejects(validateFixture(root), /ENOENT|no such file/iu);
});

test('rejects a stale catalog entry whose target is absent', async (t) => {
  const root = await makeFixture(t);
  const catalog = await readJson(root, 'catalog.json');
  catalog.push({
    path: 'docs/shared-guides/missing.md',
    abstract: 'Missing document.',
    tags: [],
  });
  await writeJson(root, 'catalog.json', catalog);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_CATALOG_STALE/u);
});

test('admits exactly one project catalog and no folder-local catalog', async (t) => {
  const root = await makeFixture(t);
  const project = await readJson(root, 'project.json');
  project.knowledge.catalog = [project.knowledge.catalog, {
    path: 'other-index.json',
    format: 'document-index-v1',
  }];
  await writeJson(root, 'project.json', project);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_PROJECT_SCHEMA/u);

  const restoredRoot = await makeFixture(t);
  const descriptorPath = 'docs/shared-guides/harness-knowledge.json';
  const descriptor = await readJson(restoredRoot, descriptorPath);
  descriptor.catalog = { path: 'folder-index.json' };
  await writeJson(restoredRoot, descriptorPath, descriptor);

  await assert.rejects(validateFixture(restoredRoot), /KNOWLEDGE_FOLDER_SCHEMA/u);
});
