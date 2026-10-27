import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import Ajv from 'ajv';

import { assertSafePath, readJsonFile, readRegularFile } from '../build/safe-files.mjs';
import {
  createIssue,
  formatDiagnostics,
  normalizeIssues,
} from '../distribution-safety/diagnostics.mjs';
import {
  inspectPathSet,
  inspectRelativePath,
} from '../distribution-safety/path-policy.mjs';

const contractRoot = new URL('../../knowledge-contract/', import.meta.url);
const readSchema = (name) => JSON.parse(
  readFileSync(new URL(name, contractRoot), 'utf8'),
);

const ajv = new Ajv({ allErrors: true, strict: true });
const validateProjectSchema = ajv.compile(readSchema('project.schema.json'));
const validateFolderSchema = ajv.compile(readSchema('folder.schema.json'));
const validateIndexSchema = ajv.compile(readSchema('index.schema.json'));

export class KnowledgeRegistryError extends Error {
  constructor(issues) {
    const normalized = normalizeIssues(issues);
    super(formatDiagnostics(normalized));
    this.name = 'KnowledgeRegistryError';
    this.issues = normalized;
  }
}

const throwIfIssues = (issues) => {
  if (issues.length > 0) throw new KnowledgeRegistryError(issues);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const inside = (root, candidate) => candidate === root || candidate.startsWith(root + '/');

const absoluteTarget = (rootDir, relativePath) => path.resolve(rootDir, relativePath);

const readJsonAt = (rootDir, relativePath) => readJsonFile(
  rootDir,
  absoluteTarget(rootDir, relativePath),
  { label: relativePath },
);

const readTextAt = (rootDir, relativePath) => readRegularFile(
  rootDir,
  absoluteTarget(rootDir, relativePath),
  { encoding: 'utf8', label: relativePath },
);

function inspectRouteSource(routes, diagnosticPath) {
  const issues = [];
  if (
    !isRecord(routes) ||
    routes.schemaVersion !== 1 ||
    !Array.isArray(routes.folderGroups) ||
    !Array.isArray(routes.explicitDocuments) ||
    !Array.isArray(routes.bootstrapDocuments) ||
    !Array.isArray(routes.unresolvedPaths) ||
    !Array.isArray(routes.silentlyDroppedPaths)
  ) {
    issues.push(createIssue('KNOWLEDGE_ROUTE_SOURCE_SCHEMA', diagnosticPath));
    return issues;
  }

  for (const group of routes.folderGroups) {
    if (
      !isRecord(group) ||
      typeof group.id !== 'string' ||
      typeof group.path !== 'string' ||
      typeof group.rootDocs !== 'boolean'
    ) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_SOURCE_SCHEMA', diagnosticPath));
    }
  }
  for (const document of [...routes.explicitDocuments, ...routes.bootstrapDocuments]) {
    if (
      !isRecord(document) ||
      typeof document.path !== 'string' ||
      typeof document.folderGroup !== 'string'
    ) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_SOURCE_SCHEMA', diagnosticPath));
    }
  }
  if (routes.unresolvedPaths.length > 0) {
    issues.push(createIssue('KNOWLEDGE_ROUTE_UNRESOLVED', diagnosticPath));
  }
  if (routes.silentlyDroppedPaths.length > 0) {
    issues.push(createIssue('KNOWLEDGE_ROUTE_SILENT_DROP', diagnosticPath));
  }
  if (isRecord(routes.summary)) {
    const expected = {
      explicitDocumentCount: routes.explicitDocuments.length,
      folderGroupCount: routes.folderGroups.length,
      unresolvedCount: routes.unresolvedPaths.length,
      silentlyDroppedCount: routes.silentlyDroppedPaths.length,
    };
    for (const [key, value] of Object.entries(expected)) {
      if (routes.summary[key] !== undefined && routes.summary[key] !== value) {
        issues.push(createIssue('KNOWLEDGE_ROUTE_SUMMARY_STALE', diagnosticPath));
      }
    }
  }
  return issues;
}

function matchesFolder(documentPath, record) {
  const relative = path.posix.relative(record.root, documentPath);
  if (relative === '' || relative === '..' || relative.startsWith('../')) return false;
  if (record.group.rootDocs && relative.includes('/')) return false;
  const included = record.descriptor.include.some((pattern) =>
    path.posix.matchesGlob(relative, pattern));
  const excluded = record.descriptor.exclude.some((pattern) =>
    path.posix.matchesGlob(relative, pattern));
  return included && !excluded;
}

function inspectLink(sourcePath, rawTarget, syntax) {
  if (syntax === 'raw-html' && /[\u0000-\u0020\u007f]/u.test(rawTarget)) {
    return { ruleId: 'KNOWLEDGE_RAW_HTML_LINK_WHITESPACE', target: null };
  }
  let target = rawTarget.trim();
  if (target.startsWith('<')) {
    const close = target.indexOf('>');
    if (close === -1) {
      return { ruleId: 'KNOWLEDGE_LINK_INVALID', target: null };
    }
    target = target.slice(1, close);
  } else {
    [target] = target.split(/\s+/u);
  }
  if (target.length === 0 || target.startsWith('#')) return null;
  if (hasCharacterReference(target)) {
    return { ruleId: 'KNOWLEDGE_LINK_CHARACTER_REFERENCE', target: null };
  }
  const withoutFragment = target.split('#', 1)[0].split('?', 1)[0];
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return { ruleId: 'KNOWLEDGE_LINK_INVALID', target: null };
  }
  if (decoded.startsWith('/')) {
    return { ruleId: 'KNOWLEDGE_LINK_ROOT_RELATIVE', target: null };
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(decoded)?.[1]?.toLowerCase();
  if (scheme === 'file') {
    return { ruleId: 'KNOWLEDGE_LINK_FILE_SCHEME', target: null };
  }
  if (scheme !== undefined) {
    if (['http', 'https', 'mailto', 'tel'].includes(scheme)) return null;
    return { ruleId: 'KNOWLEDGE_LINK_UNSUPPORTED_SCHEME', target: null };
  }
  if (decoded.includes('\\') || decoded.includes('\0')) {
    return { ruleId: 'KNOWLEDGE_LINK_TRAVERSAL', target: null };
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), decoded),
  );
  if (resolved === '..' || resolved.startsWith('../') || path.posix.isAbsolute(resolved)) {
    return { ruleId: 'KNOWLEDGE_LINK_TRAVERSAL', target: null };
  }
  return { ruleId: null, target: resolved };
}

const normalizeReferenceLabel = (label) => label.trim().replace(/\s+/gu, ' ').toLowerCase();

const hasCharacterReference = (value) =>
  /&(?:#[0-9]+;?|#x[0-9a-f]+;?|[a-z][a-z0-9]+;)/iu.test(value);

const referenceLabelIsSupported = (label) =>
  normalizeReferenceLabel(label).length > 0 &&
  !label.includes('\\') &&
  !label.includes('[') &&
  !hasCharacterReference(label);

const maskCharacters = (value) => value.replace(/[^\n]/gu, ' ');

function maskMarkdownCode(content) {
  let fence = null;
  return content
    .split(/(?<=\n)/u)
    .map((line) => {
      const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
      if (fence === null && opening !== null) {
        fence = opening[1][0];
        return maskCharacters(line);
      }
      if (fence !== null) {
        const closing = new RegExp(`^ {0,3}${fence}{3,}[ \\t]*(?:\\n)?$`, 'u');
        if (closing.test(line)) fence = null;
        return maskCharacters(line);
      }
      return line.replace(/(`+)[^`\n]*\1/gu, (span) => ' '.repeat(span.length));
    })
    .join('');
}

function extractLinkTargets(content, sourcePath, issues) {
  const targets = [];
  const renderedContent = maskMarkdownCode(content);
  const definitions = new Map();
  const definitionShape = /^ {0,3}\[((?:\\[^\n]|[^\]\\\n])*)\][ \t]*:/u;
  const supportedDefinition = /^ {0,3}\[([^\]\n]+)\]:(.*?)(?:\n)?$/u;
  const renderedLines = renderedContent.split(/(?<=\n)/u);
  const contentWithoutDefinitions = renderedLines
    .map((line, index) => {
      const shaped = definitionShape.exec(line);
      if (shaped === null) return line;
      if (!referenceLabelIsSupported(shaped[1])) {
        issues.push(createIssue(
          'KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED',
          sourcePath,
        ));
        return maskCharacters(line);
      }
      const supported = supportedDefinition.exec(line);
      if (supported === null || supported[2].trim().length === 0) {
        issues.push(createIssue(
          'KNOWLEDGE_REFERENCE_DEFINITION_UNSUPPORTED',
          sourcePath,
        ));
        return maskCharacters(line);
      }
      const nextLine = renderedLines[index + 1] ?? '';
      if (/^[ \t]{0,3}(?:"[^"\n]*"|'[^'\n]*'|\([^\n)]*\))[ \t]*(?:\n)?$/u.test(nextLine)) {
        issues.push(createIssue(
          'KNOWLEDGE_REFERENCE_DEFINITION_UNSUPPORTED',
          sourcePath,
        ));
      }
      const label = normalizeReferenceLabel(supported[1]);
      if (definitions.has(label)) {
        issues.push(createIssue('KNOWLEDGE_REFERENCE_DUPLICATE', sourcePath));
      } else {
        definitions.set(label, supported[2].trim());
      }
      return maskCharacters(line);
    })
    .join('');

  let inlineCursor = 0;
  while (inlineCursor < contentWithoutDefinitions.length) {
    const start = contentWithoutDefinitions.indexOf('](', inlineCursor);
    if (start === -1) break;
    const destinationStart = start + 2;
    const lineEnd = contentWithoutDefinitions.indexOf('\n', destinationStart);
    const close = contentWithoutDefinitions.indexOf(')', destinationStart);
    if (
      close === -1 ||
      (lineEnd !== -1 && lineEnd < close) ||
      contentWithoutDefinitions.slice(destinationStart, close).includes('(')
    ) {
      issues.push(createIssue('KNOWLEDGE_LINK_SYNTAX_UNSUPPORTED', sourcePath));
      inlineCursor = lineEnd === -1
        ? contentWithoutDefinitions.length
        : lineEnd + 1;
      continue;
    }
    targets.push({
      syntax: 'markdown',
      value: contentWithoutDefinitions.slice(destinationStart, close),
    });
    inlineCursor = close + 1;
  }

  const referencePattern = /\[([^\]\n]+)\]\[([^\]\n]*)\]/gu;
  for (const match of contentWithoutDefinitions.matchAll(referencePattern)) {
    const rawLabel = match[2] || match[1];
    if (!referenceLabelIsSupported(rawLabel)) {
      issues.push(createIssue('KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED', sourcePath));
      continue;
    }
    const label = normalizeReferenceLabel(rawLabel);
    const destination = definitions.get(label);
    if (destination !== undefined) {
      targets.push({ syntax: 'markdown', value: destination });
    }
  }
  const shortcutPattern = /\[([^\]\n]+)\]/gu;
  for (const match of contentWithoutDefinitions.matchAll(shortcutPattern)) {
    const before = contentWithoutDefinitions[match.index - 1];
    const after = contentWithoutDefinitions[match.index + match[0].length];
    if (before === ']' || after === '(' || after === '[') continue;
    if (!referenceLabelIsSupported(match[1])) {
      if (definitions.size > 0) {
        issues.push(createIssue('KNOWLEDGE_REFERENCE_LABEL_UNSUPPORTED', sourcePath));
      }
      continue;
    }
    const destination = definitions.get(normalizeReferenceLabel(match[1]));
    if (destination !== undefined) {
      targets.push({ syntax: 'markdown', value: destination });
    }
  }

  const htmlTagPattern = /<[a-z][^>]*>/giu;
  const htmlAttributePattern = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
  for (const tag of renderedContent.matchAll(htmlTagPattern)) {
    if (!/\b(?:href|src)\s*=/iu.test(tag[0])) continue;
    let parsedAttribute = false;
    for (const attribute of tag[0].matchAll(htmlAttributePattern)) {
      parsedAttribute = true;
      targets.push({
        syntax: 'raw-html',
        value: attribute[1] ?? attribute[2] ?? attribute[3],
      });
    }
    if (!parsedAttribute) {
      issues.push(createIssue('KNOWLEDGE_RAW_HTML_LINK_INVALID', sourcePath));
    }
  }
  const autolinkPattern = /<([a-z][a-z0-9+.-]*:[^<>\s]+)>/giu;
  for (const autolink of renderedContent.matchAll(autolinkPattern)) {
    targets.push({ syntax: 'markdown', value: autolink[1] });
  }
  return targets;
}

function inspectLinks({ owners, contents }) {
  const issues = [];
  for (const [sourcePath, sourceRecord] of owners) {
    const content = contents.get(sourcePath);
    if (content === undefined) continue;
    for (const target of extractLinkTargets(content, sourcePath, issues)) {
      const inspected = inspectLink(sourcePath, target.value, target.syntax);
      if (inspected === null) continue;
      if (inspected.ruleId !== null) {
        issues.push(createIssue(inspected.ruleId, sourcePath));
        continue;
      }
      const targetRecord = owners.get(inspected.target);
      if (targetRecord === undefined || targetRecord === sourceRecord) continue;
      if (
        !sourceRecord.descriptor.allowedLinkRoots.some((root) =>
          inside(root, inspected.target))
      ) {
        issues.push(createIssue('KNOWLEDGE_CROSS_ROOT_LINK', sourcePath));
      }
      if (
        sourceRecord.descriptor.visibility === 'shared' &&
        targetRecord.descriptor.visibility === 'project-private'
      ) {
        issues.push(createIssue('KNOWLEDGE_SHARED_PRIVATE_LINK', sourcePath));
      }
    }
  }
  return issues;
}

async function loadDiskRegistry(rootDir, projectPath) {
  const project = await readJsonAt(rootDir, projectPath);
  if (!validateProjectSchema(project)) {
    throw new KnowledgeRegistryError([
      createIssue('KNOWLEDGE_PROJECT_SCHEMA', projectPath),
    ]);
  }
  const [catalog, routes, descriptors] = await Promise.all([
    readJsonAt(rootDir, project.knowledge.catalog.path),
    readJsonAt(rootDir, project.knowledge.routeSource.path),
    Promise.all(project.knowledge.folders.map(async (descriptorPath) => ({
      path: descriptorPath,
      descriptor: await readJsonAt(rootDir, descriptorPath),
    }))),
  ]);
  return { projectPath, project, catalog, routes, descriptors };
}

async function assertPreloadedAuthorities(rootDir, registry, issues) {
  const { project } = registry;
  const [catalog, routes] = await Promise.all([
    readJsonAt(rootDir, project.knowledge.catalog.path),
    readJsonAt(rootDir, project.knowledge.routeSource.path),
  ]);
  if (!isDeepStrictEqual(catalog, registry.catalog)) {
    issues.push(createIssue(
      'KNOWLEDGE_CATALOG_AUTHORITY_MISMATCH',
      project.knowledge.catalog.path,
    ));
  }
  if (!isDeepStrictEqual(routes, registry.routes)) {
    issues.push(createIssue(
      'KNOWLEDGE_ROUTE_AUTHORITY_MISMATCH',
      project.knowledge.routeSource.path,
    ));
  }
}

/**
 * Validate a project knowledge registry without changing routing or resolver state.
 * Pass projectPath for the normal on-disk contract, or registry for externally
 * supplied descriptor conformance against declared on-disk catalog/route data.
 */
export async function validateKnowledgeRegistry({
  rootDir,
  projectPath,
  registry,
} = {}) {
  if (typeof rootDir !== 'string' || rootDir.length === 0) {
    throw new TypeError('rootDir is required');
  }
  if ((projectPath === undefined) === (registry === undefined)) {
    throw new TypeError('provide exactly one of projectPath or registry');
  }

  const loaded = projectPath === undefined
    ? { projectPath: registry.projectPath ?? 'project.json', ...registry }
    : await loadDiskRegistry(rootDir, projectPath);
  const issues = [];

  if (!validateProjectSchema(loaded.project)) {
    issues.push(createIssue('KNOWLEDGE_PROJECT_SCHEMA', loaded.projectPath));
    throwIfIssues(issues);
  }
  if (registry !== undefined) {
    await assertPreloadedAuthorities(rootDir, loaded, issues);
  }
  if (!validateIndexSchema(loaded.catalog)) {
    issues.push(createIssue(
      'KNOWLEDGE_CATALOG_SCHEMA',
      loaded.project.knowledge.catalog.path,
    ));
  }
  issues.push(...inspectRouteSource(
    loaded.routes,
    loaded.project.knowledge.routeSource.path,
  ));
  if (!Array.isArray(loaded.descriptors)) {
    issues.push(createIssue('KNOWLEDGE_FOLDER_SCHEMA', loaded.projectPath));
  }
  throwIfIssues(issues);

  const declaredDescriptorPaths = loaded.project.knowledge.folders;
  issues.push(...inspectPathSet([
    loaded.project.knowledge.catalog.path,
    loaded.project.knowledge.routeSource.path,
    ...declaredDescriptorPaths,
  ]).issues);

  const suppliedDescriptors = new Map();
  for (const entry of loaded.descriptors) {
    if (!isRecord(entry) || typeof entry.path !== 'string') {
      issues.push(createIssue('KNOWLEDGE_FOLDER_SCHEMA', loaded.projectPath));
      continue;
    }
    if (suppliedDescriptors.has(entry.path)) {
      issues.push(createIssue('KNOWLEDGE_DESCRIPTOR_DUPLICATE', entry.path));
    }
    suppliedDescriptors.set(entry.path, entry.descriptor);
  }
  for (const descriptorPath of declaredDescriptorPaths) {
    if (!suppliedDescriptors.has(descriptorPath)) {
      issues.push(createIssue('KNOWLEDGE_DESCRIPTOR_MISSING', descriptorPath));
    }
  }
  for (const descriptorPath of suppliedDescriptors.keys()) {
    if (!declaredDescriptorPaths.includes(descriptorPath)) {
      issues.push(createIssue('KNOWLEDGE_DESCRIPTOR_UNDECLARED', descriptorPath));
    }
  }

  const groupsById = new Map();
  const groupPaths = [];
  for (const group of loaded.routes.folderGroups) {
    if (!isRecord(group)) continue;
    const inspectedPath = inspectRelativePath(group.path);
    issues.push(...inspectedPath.issues);
    if (groupsById.has(group.id)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_GROUP_DUPLICATE', group.path));
    } else {
      groupsById.set(group.id, group);
    }
    groupPaths.push(group.path);
  }
  issues.push(...inspectPathSet(groupPaths).issues);

  const records = [];
  const descriptorIds = new Map();
  const recordsByGroup = new Map();
  for (const descriptorPath of declaredDescriptorPaths) {
    const descriptor = suppliedDescriptors.get(descriptorPath);
    if (descriptor === undefined) continue;
    if (!validateFolderSchema(descriptor)) {
      issues.push(createIssue('KNOWLEDGE_FOLDER_SCHEMA', descriptorPath));
      continue;
    }
    if (descriptorIds.has(descriptor.id)) {
      issues.push(createIssue('KNOWLEDGE_DUPLICATE_ID', descriptorPath));
    } else {
      descriptorIds.set(descriptor.id, descriptorPath);
    }
    for (const allowedRoot of descriptor.allowedLinkRoots) {
      issues.push(...inspectRelativePath(allowedRoot).issues);
    }
    if (descriptor.orphanPolicy.mode === 'allow-listed') {
      issues.push(...inspectPathSet(descriptor.orphanPolicy.paths).issues);
    }

    const root = path.posix.dirname(descriptorPath);
    const group = groupsById.get(descriptor.routeSource.groupId);
    if (group === undefined) {
      issues.push(createIssue('KNOWLEDGE_DESCRIPTOR_UNROUTED', descriptorPath));
      continue;
    }
    if (group.path !== root) {
      issues.push(createIssue('KNOWLEDGE_DESCRIPTOR_ROOT_MISMATCH', descriptorPath));
    }
    if (recordsByGroup.has(group.id)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_GROUP_DUPLICATE', group.path));
    }
    const record = { descriptorPath, descriptor, root, group };
    records.push(record);
    recordsByGroup.set(group.id, record);
  }
  for (const group of loaded.routes.folderGroups) {
    if (!recordsByGroup.has(group.id)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_GROUP_UNREGISTERED', group.path));
    }
  }

  for (const record of records) {
    try {
      await assertSafePath(rootDir, absoluteTarget(rootDir, record.root), {
        kind: 'directory',
        label: record.root,
      });
    } catch {
      issues.push(createIssue('KNOWLEDGE_FOLDER_ROOT_MISSING', record.root));
    }
  }

  const catalogPaths = [];
  const catalogPathSet = new Set();
  for (const entry of loaded.catalog) {
    const inspected = inspectRelativePath(entry.path);
    issues.push(...inspected.issues);
    if (catalogPathSet.has(entry.path)) {
      issues.push(createIssue('KNOWLEDGE_CATALOG_DUPLICATE', entry.path));
    } else {
      catalogPathSet.add(entry.path);
      catalogPaths.push(entry.path);
    }
  }
  issues.push(...inspectPathSet(catalogPaths).issues);

  const routePaths = new Set();
  const routeRecords = new Map();
  for (const document of loaded.routes.explicitDocuments) {
    if (!isRecord(document)) continue;
    const inspected = inspectRelativePath(document.path);
    issues.push(...inspected.issues);
    if (routePaths.has(document.path)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_DUPLICATE', document.path));
    } else {
      routePaths.add(document.path);
    }
    if (document.exists === false) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_DECLARED_MISSING', document.path));
    }
    const record = recordsByGroup.get(document.folderGroup);
    if (record === undefined) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_GROUP_UNKNOWN', document.path));
      continue;
    }
    if (!inside(record.root, document.path)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_ROOT_MISMATCH', document.path));
    }
    if (record.group.rootDocs && path.posix.dirname(document.path) !== record.root) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_ROOT_DOC_NESTED', document.path));
    }
    if (!matchesFolder(document.path, record)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_NOT_INCLUDED', document.path));
    }
    if (!catalogPathSet.has(document.path)) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_NOT_CATALOGED', document.path));
    }
    routeRecords.set(document.path, record);
  }

  const contents = new Map();
  for (const catalogPath of catalogPaths) {
    try {
      contents.set(catalogPath, await readTextAt(rootDir, catalogPath));
    } catch {
      issues.push(createIssue('KNOWLEDGE_CATALOG_STALE', catalogPath));
    }
  }
  for (const routePath of routePaths) {
    if (contents.has(routePath)) continue;
    try {
      contents.set(routePath, await readTextAt(rootDir, routePath));
    } catch {
      issues.push(createIssue('KNOWLEDGE_ROUTE_TARGET_MISSING', routePath));
    }
  }

  const owners = new Map();
  for (const catalogPath of catalogPaths) {
    const matches = records.filter((record) => matchesFolder(catalogPath, record));
    if (matches.length === 0) {
      issues.push(createIssue('KNOWLEDGE_CATALOG_UNOWNED', catalogPath));
    } else if (matches.length > 1) {
      issues.push(createIssue('KNOWLEDGE_CATALOG_MULTI_OWNER', catalogPath));
    } else {
      owners.set(catalogPath, matches[0]);
    }
  }
  for (const [routePath, routeRecord] of routeRecords) {
    const owner = owners.get(routePath);
    if (owner !== undefined && owner !== routeRecord) {
      issues.push(createIssue('KNOWLEDGE_ROUTE_OWNER_MISMATCH', routePath));
    }
  }

  for (const record of records) {
    const orphans = new Set(
      [...owners]
        .filter(([documentPath, owner]) => owner === record && !routePaths.has(documentPath))
        .map(([documentPath]) => documentPath),
    );
    if (record.descriptor.orphanPolicy.mode === 'forbid') {
      for (const orphan of orphans) {
        issues.push(createIssue('KNOWLEDGE_ORPHAN_FORBIDDEN', orphan));
      }
    }
    if (record.descriptor.orphanPolicy.mode === 'allow-listed') {
      const allowed = new Set(record.descriptor.orphanPolicy.paths);
      for (const orphan of orphans) {
        if (!allowed.has(orphan)) {
          issues.push(createIssue('KNOWLEDGE_ORPHAN_UNLISTED', orphan));
        }
      }
      for (const allowedPath of allowed) {
        if (!orphans.has(allowedPath)) {
          issues.push(createIssue('KNOWLEDGE_ORPHAN_ALLOWLIST_STALE', allowedPath));
        }
      }
    }
  }

  const bootstrapOrder = [];
  const seenBootstrap = new Set();
  for (const document of loaded.routes.bootstrapDocuments) {
    if (!isRecord(document)) continue;
    bootstrapOrder.push(document.path);
    if (seenBootstrap.has(document.path)) {
      issues.push(createIssue('KNOWLEDGE_BOOTSTRAP_DUPLICATE', document.path));
    }
    seenBootstrap.add(document.path);
    const record = routeRecords.get(document.path);
    if (record === undefined) {
      issues.push(createIssue('KNOWLEDGE_BOOTSTRAP_NOT_ROUTED', document.path));
      continue;
    }
    if (record.group.id !== document.folderGroup) {
      issues.push(createIssue('KNOWLEDGE_BOOTSTRAP_GROUP_MISMATCH', document.path));
    }
    if (!record.descriptor.mayContributeAlwaysLoaded) {
      issues.push(createIssue('KNOWLEDGE_BOOTSTRAP_NOT_ALLOWED', document.path));
    }
  }

  issues.push(...inspectLinks({ owners, contents }));
  throwIfIssues(issues);

  return {
    projectId: loaded.project.projectId,
    catalogPath: loaded.project.knowledge.catalog.path,
    routeSourcePath: loaded.project.knowledge.routeSource.path,
    folderCount: records.length,
    documentCount: routePaths.size,
    bootstrapOrder,
    groups: loaded.routes.folderGroups.map((group) => ({
      id: group.id,
      path: group.path,
      documentCount: loaded.routes.explicitDocuments.filter(
        (document) => document.folderGroup === group.id,
      ).length,
    })),
  };
}
