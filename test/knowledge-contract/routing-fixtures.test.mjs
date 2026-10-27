import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  makeFixture,
  readJson,
  validateFixture,
  writeJson,
} from './helpers.mjs';

test('preserves bootstrap order from the route source', async (t) => {
  const root = await makeFixture(t);
  const result = await validateFixture(root);

  assert.deepEqual(result.bootstrapOrder, [
    'docs/shared-guides/setup.md',
    'docs/shared-guides/intro.md',
  ]);
});

test('rejects duplicate bootstrap entries', async (t) => {
  const root = await makeFixture(t);
  const routes = await readJson(root, 'routes.json');
  routes.bootstrapDocuments.push(routes.bootstrapDocuments[0]);
  await writeJson(root, 'routes.json', routes);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_BOOTSTRAP_DUPLICATE/u);
});

test('rejects bootstrap content from a folder without always-loaded permission', async (t) => {
  const root = await makeFixture(t);
  const routes = await readJson(root, 'routes.json');
  routes.bootstrapDocuments = [routes.explicitDocuments[2]];
  await writeJson(root, 'routes.json', routes);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_BOOTSTRAP_NOT_ALLOWED/u);
});

test('rejects an unregistered route group', async (t) => {
  const root = await makeFixture(t);
  const project = await readJson(root, 'project.json');
  project.knowledge.folders = project.knowledge.folders.slice(0, 1);
  await writeJson(root, 'project.json', project);

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_ROUTE_GROUP_UNREGISTERED/u,
  );
});

test('rejects a routed document absent from the sole catalog', async (t) => {
  const root = await makeFixture(t);
  const catalog = await readJson(root, 'catalog.json');
  await writeJson(
    root,
    'catalog.json',
    catalog.filter(({ path }) => path !== 'docs/project-notes/operations.md'),
  );

  await assert.rejects(validateFixture(root), /KNOWLEDGE_ROUTE_NOT_CATALOGED/u);
});

test('rejects a real cataloged document with no folder owner', async (t) => {
  const root = await makeFixture(t);
  const catalog = await readJson(root, 'catalog.json');
  catalog.push({
    path: 'docs/unregistered/rogue.md',
    abstract: 'Unregistered document.',
    tags: [],
  });
  await mkdir(path.join(root, 'docs/unregistered'), { recursive: true });
  await writeFile(path.join(root, 'docs/unregistered/rogue.md'), '# Rogue\n');
  await writeJson(root, 'catalog.json', catalog);

  await assert.rejects(validateFixture(root), /KNOWLEDGE_CATALOG_UNOWNED/u);
});

test('accepts an owned catalog-only document allowed by orphan policy', async (t) => {
  const root = await makeFixture(t);
  const result = await validateFixture(root);

  assert.equal(result.documentCount, 3);
  assert.equal(
    (await readJson(root, 'catalog.json')).some(
      ({ path: documentPath }) => documentPath === 'docs/project-notes/archive.md',
    ),
    true,
  );
});

test('rejects an absent route target', async (t) => {
  const root = await makeFixture(t);
  const catalog = await readJson(root, 'catalog.json');
  const routes = await readJson(root, 'routes.json');
  const catalogEntry = catalog.find(
    ({ path }) => path === 'docs/project-notes/operations.md',
  );
  const routeEntry = routes.explicitDocuments.find(
    ({ path }) => path === 'docs/project-notes/operations.md',
  );
  catalogEntry.path = 'docs/project-notes/missing.md';
  routeEntry.path = 'docs/project-notes/missing.md';
  await writeJson(root, 'catalog.json', catalog);
  await writeJson(root, 'routes.json', routes);

  await assert.rejects(
    validateFixture(root),
    /KNOWLEDGE_(?:CATALOG_STALE|ROUTE_TARGET_MISSING)/u,
  );
});

test('enforces the folder orphan policy and its allowlist currentness', async (t) => {
  const root = await makeFixture(t);
  const descriptorPath = 'docs/project-notes/harness-knowledge.json';
  const descriptor = await readJson(root, descriptorPath);
  descriptor.orphanPolicy = { mode: 'forbid' };
  await writeJson(root, descriptorPath, descriptor);
  await assert.rejects(validateFixture(root), /KNOWLEDGE_ORPHAN_FORBIDDEN/u);

  const secondRoot = await makeFixture(t);
  const secondDescriptor = await readJson(secondRoot, descriptorPath);
  secondDescriptor.orphanPolicy.paths = ['docs/project-notes/operations.md'];
  await writeJson(secondRoot, descriptorPath, secondDescriptor);
  await assert.rejects(
    validateFixture(secondRoot),
    /KNOWLEDGE_ORPHAN_(?:UNLISTED|ALLOWLIST_STALE)/u,
  );
});
