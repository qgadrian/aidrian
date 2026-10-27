import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { validateKnowledgeRegistry } from '../../src/project-bundle/knowledge-registry.mjs';
import { validFixtureRoot } from './helpers.mjs';

const readJson = async (filePath) => JSON.parse(await readFile(filePath, 'utf8'));

const fixtureRoutes = await readJson(path.join(validFixtureRoot, 'routes.json'));
const fixtureResult = validateKnowledgeRegistry({
  rootDir: validFixtureRoot,
  projectPath: 'project.json',
});

for (const group of fixtureRoutes.folderGroups) {
  test(`fixture discovered group ${group.id} satisfies the contract`, async () => {
    const result = await fixtureResult;
    const validated = result.groups.find(({ id }) => id === group.id);
    assert.deepEqual(validated, {
      id: group.id,
      path: group.path,
      documentCount: fixtureRoutes.explicitDocuments.filter(
        (document) => document.folderGroup === group.id,
      ).length,
    });
  });
}

const externalRoot = process.env.AIDRIAN_KNOWLEDGE_PROJECT_ROOT;
const externalCatalogPath = process.env.AIDRIAN_KNOWLEDGE_CATALOG;
const externalRoutePath = process.env.AIDRIAN_KNOWLEDGE_ROUTE_SOURCE;
const externalValues = [externalRoot, externalCatalogPath, externalRoutePath];

if (externalValues.some(Boolean) && !externalValues.every(Boolean)) {
  throw new Error(
    'AIDRIAN_KNOWLEDGE_PROJECT_ROOT, AIDRIAN_KNOWLEDGE_CATALOG, and '
      + 'AIDRIAN_KNOWLEDGE_ROUTE_SOURCE must be supplied together',
  );
}

if (externalValues.every(Boolean)) {
  const [catalog, routes] = await Promise.all([
    readJson(path.join(externalRoot, externalCatalogPath)),
    readJson(path.join(externalRoot, externalRoutePath)),
  ]);
  const bootstrapGroups = new Set(
    routes.bootstrapDocuments.map(({ folderGroup }) => folderGroup),
  );
  const allowedLinkRoots = [
    ...new Set(routes.folderGroups.map(({ path: groupPath }) =>
      groupPath.split('/', 1)[0])),
  ].sort();
  const catalogPathsByGroup = new Map(
    routes.folderGroups.map(({ id }) => [id, []]),
  );
  for (const { path: documentPath } of catalog) {
    const owner = routes.folderGroups
      .filter((group) => group.rootDocs
        ? path.posix.dirname(documentPath) === group.path
        : documentPath.startsWith(group.path + '/'))
      .sort((left, right) => right.path.length - left.path.length)[0];
    if (owner !== undefined) {
      catalogPathsByGroup.get(owner.id).push(
        path.posix.relative(owner.path, documentPath),
      );
    }
  }
  const descriptors = routes.folderGroups.map((group) => {
    const ownedCatalogPaths = catalogPathsByGroup.get(group.id).sort();
    const include = ownedCatalogPaths.length > 0
      ? ownedCatalogPaths
      : ['__no-catalog-documents__'];
    return {
      path: path.posix.join(group.path, 'harness-knowledge.json'),
      descriptor: {
        schemaVersion: 1,
        id: group.id,
        kind: 'project-knowledge',
        owner: 'external-project',
        visibility: 'project-private',
        include,
        exclude: [],
        allowedLinkRoots,
        routeSource: {
          format: 'routed-inventory-v1',
          groupId: group.id,
        },
        orphanPolicy: { mode: 'allow' },
        mayContributeAlwaysLoaded: bootstrapGroups.has(group.id),
      },
    };
  });
  const project = {
    schemaVersion: 1,
    projectId: 'external-project',
    knowledge: {
      catalog: {
        path: externalCatalogPath,
        format: 'document-index-v1',
      },
      routeSource: {
        path: externalRoutePath,
        format: 'routed-inventory-v1',
      },
      folders: descriptors.map(({ path: descriptorPath }) => descriptorPath),
    },
  };
  const externalResult = validateKnowledgeRegistry({
    rootDir: externalRoot,
    registry: {
      projectPath: 'external-project.json',
      project,
      catalog,
      routes,
      descriptors,
    },
  });

  for (const group of routes.folderGroups) {
    test(`external discovered group ${group.id} satisfies the contract`, async () => {
      const result = await externalResult;
      const validated = result.groups.find(({ id }) => id === group.id);
      assert.deepEqual(validated, {
        id: group.id,
        path: group.path,
        documentCount: routes.explicitDocuments.filter(
          (document) => document.folderGroup === group.id,
        ).length,
      });
    });
  }

  test('external route inventory is covered without dropped groups or documents', async () => {
    const result = await externalResult;
    assert.equal(result.folderCount, routes.folderGroups.length);
    assert.equal(result.documentCount, routes.explicitDocuments.length);
    assert.deepEqual(
      result.bootstrapOrder,
      routes.bootstrapDocuments.map(({ path: documentPath }) => documentPath),
    );
    assert.deepEqual(routes.unresolvedPaths, []);
    assert.deepEqual(routes.silentlyDroppedPaths, []);
  });
}
