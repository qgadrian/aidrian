import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog } from '../build/build.mjs';
import { readJsonFile, readRegularFile } from '../build/safe-files.mjs';
import { validateReviewerProfile } from '../build/catalog.mjs';
import { inspectPathSet, inspectRelativePath } from '../distribution-safety/path-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PLUGIN_ID = 'aidrian';
export const BUNDLE_SCHEMA_VERSION = 1;
export const BUNDLE_BUILDER_VERSION = 1;
export const PRIVATE_DESCRIPTOR_DENYLIST = Object.freeze([
  'docs/adr/harness-knowledge.json',
  'docs/ai-rules/core/harness-knowledge.json',
  'docs/ai-rules/harness-knowledge.json',
  'docs/ai-rules/harness/harness-knowledge.json',
  'docs/ai-rules/shared/handoff-artifacts/harness-knowledge.json',
  'docs/ai-rules/shared/harness-knowledge.json',
]);

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

const sortValue = (value) => {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
};

export const stableJson = (value) => JSON.stringify(sortValue(value));
const prettyJsonBytes = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

const assertExactKeys = (value, expected, label) => {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (stableJson(actual) !== stableJson(sortedExpected)) {
    throw new Error(`${label} must contain exactly ${sortedExpected.join(', ')}`);
  }
};

export const validateExecutableManifest = (manifest) => {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('capabilities/executables.json must be an object');
  }
  assertExactKeys(manifest, ['schemaVersion', 'executables'], 'capabilities/executables.json');
  if (manifest.schemaVersion !== 1) {
    throw new Error('capabilities/executables.json schemaVersion must be 1');
  }
  if (!Array.isArray(manifest.executables)) {
    throw new Error('capabilities/executables.json executables must be an array');
  }
  if (manifest.executables.length !== 0) {
    throw new Error('capabilities/executables.json executables must remain empty');
  }
  return manifest;
};

export const assertPositiveCorePaths = (paths) => {
  const inspection = inspectPathSet(paths);
  if (inspection.issues.length) {
    const detail = inspection.issues
      .map(({ ruleId, path: candidate }) => `${ruleId}:${candidate}`)
      .sort()
      .join(', ');
    throw new Error(`core distribution contains unsafe paths: ${detail}`);
  }
  for (const candidate of paths) {
    if (PRIVATE_DESCRIPTOR_DENYLIST.includes(candidate)) {
      throw new Error(`project-private descriptor is never distributable: ${candidate}`);
    }
  }
};

const hooksFromManifests = (manifests) => {
  const candidates = [];
  const add = (origin, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value) && value.length === 0) return;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return;
    candidates.push({ origin, path: '<inline>', command: value });
  };
  add('claude-manifest-hooks', manifests.claude?.hooks);
  add('codex-manifest-hooks', manifests.codex?.extensions?.['com.openai']?.hooks);
  add('codex-compatibility-hooks', manifests.codexCompatibility?.hooks);
  return candidates;
};

const commandDetails = (binding) => {
  const details = [];
  const serialized = typeof binding.command === 'string'
    ? binding.command
    : stableJson(binding.command);
  if (/(?:^|\s)(?:sh|bash|zsh)(?:\s|$)|(?:^|\s)-c(?:\s|$)/.test(serialized)) {
    details.push('shell-command');
  }
  if (/(?:^|\s)(?:eval|-e)(?:\s|$)/.test(serialized)) details.push('inline-eval');
  if (/(?:^|\s)(?:node|python(?:3)?|sh|bash|zsh)\s+[^\s]+/.test(serialized)) {
    details.push('interpreter-script-target');
  }
  const first = serialized.trim().split(/\s+/)[0] ?? '';
  if (first && !first.includes('/') && /^[a-zA-Z0-9_.-]+$/.test(first)) {
    details.push('path-only-resolution');
  }
  return details;
};

export const semanticExecutableInventory = ({
  files,
  providerManifests,
  provenance,
  capabilities,
  bindings = [],
}) => {
  validateExecutableManifest(capabilities);
  const candidates = [];
  const add = (origin, candidatePath, detail) => {
    candidates.push({ origin, path: candidatePath, detail });
  };
  const fileEntries = files instanceof Map ? [...files] : Object.entries(files ?? {});
  assertPositiveCorePaths(fileEntries.map(([relative]) => relative));
  for (const [relative, file] of fileEntries) {
    if ((file.mode & 0o111) !== 0) add('packaged-file-mode', relative, 'executable-mode');
    if (file.bytes.subarray(0, 2).toString() === '#!') add('packaged-file-bytes', relative, 'shebang');
    if (relative === 'hooks/hooks.json' || relative.endsWith('/hooks/hooks.json')) {
      add('provider-default-hook-discovery', relative, 'hook-definition');
    }
    if (/(?:^|\/)(?:launcher|dispatcher|executable-approval|approval-store)(?:\.|\/|$)/i.test(relative)) {
      add('forbidden-production-surface', relative, 'trust-or-execution-platform');
    }
  }
  for (const row of provenance.files ?? []) {
    const mode = Number.parseInt(row.mode, 8);
    if ((mode & 0o111) !== 0) add('provenance-mode', row.target, row.mode);
    if (row.capabilities?.includes('execute')) add('provenance-capability', row.target, 'execute');
  }
  for (const row of capabilities.executables) {
    add('executable-capability-row', row.path ?? '<unknown>', 'declared executable');
  }
  for (const binding of [...hooksFromManifests(providerManifests), ...bindings]) {
    const origin = binding.origin ?? 'provider-binding';
    const candidatePath = binding.path ?? '<inline>';
    add(origin, candidatePath, 'provider-binding');
    for (const detail of commandDetails(binding)) add(origin, candidatePath, detail);
  }
  return candidates.sort(
    (left, right) => compareText(left.origin, right.origin)
      || compareText(left.path, right.path)
      || compareText(left.detail, right.detail),
  );
};

export const assertSemanticExecutableClosure = (input) => {
  const candidates = semanticExecutableInventory(input);
  if (candidates.length) {
    const detail = candidates
      .map(({ origin, path: candidatePath, detail: kind }) => `${origin}:${candidatePath}:${kind}`)
      .join('\n');
    throw new Error(`production semantic executable inventory must be empty\n${detail}`);
  }
};

const providerManifests = (version, agentPaths) => ({
  claude: {
    name: PLUGIN_ID,
    displayName: 'Aidrian Private Harness',
    version,
    description: 'Private shared harness agents and skills.',
    author: { name: 'Acme' },
    agents: agentPaths.map((agentPath) => `./${agentPath}`),
    skills: ['./skills/'],
  },
  codex: {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: PLUGIN_ID,
    version,
    description: 'Private shared harness skills and project-agent resources.',
    author: { name: 'Acme' },
  },
});

const marketplaceCatalogs = () => ({
  claude: {
    name: 'aidrian-private',
    owner: { name: 'Acme' },
    description: 'Private Aidrian harness marketplace.',
    plugins: [{
      name: PLUGIN_ID,
      source: './plugins/aidrian',
      description: 'Private shared harness agents and skills.',
      category: 'Development',
      strict: true,
    }],
  },
  codex: {
    name: 'aidrian-private',
    interface: { displayName: 'Aidrian Private Harness' },
    plugins: [{
      name: PLUGIN_ID,
      source: { source: 'local', path: './plugins/aidrian' },
      interface: {
        displayName: 'Aidrian Private Harness',
        shortDescription: 'Private shared harness skills and project-agent resources.',
      },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Developer Tools',
    }],
  },
});

const currentCommit = (root) => execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

const validateReviewerPolicy = ({
  supportedReviewerIds = ['claude', 'codex'],
  requiredReviewerIds = ['claude'],
  availableReviewerIds = supportedReviewerIds,
  awaitCodex = false,
}) => {
  if (!Array.isArray(supportedReviewerIds) || supportedReviewerIds.length === 0) {
    throw new Error('supportedReviewerIds must be a non-empty array');
  }
  if (!Array.isArray(requiredReviewerIds) || requiredReviewerIds.length === 0) {
    throw new Error('requiredReviewerIds must be a non-empty array');
  }
  const declared = new Set(supportedReviewerIds);
  for (const reviewer of requiredReviewerIds) {
    if (!declared.has(reviewer)) {
      throw new Error(`required reviewer ${reviewer} is not declared supported; no fallback is permitted`);
    }
  }
  const validated = validateReviewerProfile(
    'project-bundle',
    { requiredReviewerIds, awaitCodex },
    availableReviewerIds,
  );
  return {
    supportedReviewerIds: [...supportedReviewerIds],
    requiredReviewerIds: validated.requiredReviewerIds,
    reviewArguments: validated.reviewArguments,
  };
};

const buildFileSets = (generated, manifests) => {
  const pluginFiles = new Map([
    ['.claude-plugin/plugin.json', { bytes: prettyJsonBytes(manifests.claude), mode: 0o644 }],
    ['plugin.json', { bytes: prettyJsonBytes(manifests.codex), mode: 0o644 }],
  ]);
  const bundleFiles = new Map();
  let codexConfigBlock = null;
  for (const [relative, file] of generated) {
    if (relative.startsWith('claude/agents/')) {
      const name = relative.slice('claude/agents/'.length);
      pluginFiles.set(`agents/${name}`, file);
      bundleFiles.set(`.claude/agents/${name}`, file);
    } else if (relative.startsWith('codex/agents/')) {
      const name = relative.slice('codex/agents/'.length);
      bundleFiles.set(`.codex/agents/${name}`, file);
    } else if (relative.startsWith('shared/skills/')) {
      const name = relative.slice('shared/skills/'.length);
      pluginFiles.set(`skills/${name}`, file);
      bundleFiles.set(`.agents/skills/${name}`, file);
    } else if (relative === 'codex/config.toml') {
      codexConfigBlock = file.bytes.toString('utf8');
    } else if (!['capability-report.json', 'source-report.json'].includes(relative)) {
      throw new Error(`unsupported generated resource ${relative}`);
    }
  }
  if (!codexConfigBlock) throw new Error('generated Codex registry is missing');
  return { pluginFiles, bundleFiles, codexConfigBlock };
};

const bundleFromFiles = ({
  files,
  sourceCommit,
  version,
  manifests,
  capabilities,
  provenanceBytes,
  reviewerPolicy,
  codexConfigBlock,
}) => {
  assertPositiveCorePaths([...files.keys()]);
  const ledger = [...files]
    .map(([relative, file]) => ({
      path: relative,
      mode: (file.mode & 0o777).toString(8).padStart(4, '0'),
      sha256: sha256(file.bytes),
    }))
    .sort((left, right) => compareText(left.path, right.path));
  const providerManifestDigests = {
    claude: sha256(prettyJsonBytes(manifests.claude)),
    codex: sha256(prettyJsonBytes(manifests.codex)),
  };
  const capabilityManifestDigest = sha256(prettyJsonBytes(capabilities));
  const provenanceManifestDigest = sha256(provenanceBytes);
  const codexConfigBlockDigest = sha256(codexConfigBlock);
  const manifest = {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    builder: { id: 'aidrian-project-bundle', version: BUNDLE_BUILDER_VERSION },
    sourceCommit,
    plugin: { id: PLUGIN_ID, version },
    providerManifestDigests,
    capabilityManifestDigest,
    provenanceManifestDigest,
    codexConfigBlockDigest,
    reviewers: reviewerPolicy,
    ledger,
  };
  const manifestDigest = sha256(stableJson(manifest));
  const payload = ledger.map((entry) => ({
    ...entry,
    contentBase64: files.get(entry.path).bytes.toString('base64'),
  }));
  const bundleDigest = sha256(stableJson({ manifestDigest, files: payload }));
  return {
    ...manifest,
    manifestDigest,
    bundleDigest,
    codexConfigBlock,
    files: payload,
  };
};

export const assemblePrivateDistribution = async ({
  root = ROOT,
  sourceCommit = null,
  overlays = {},
  catalogOptions = {},
  reviewerPolicy = {},
  semanticBindings = [],
} = {}) => {
  const packageJson = await readJsonFile(root, path.join(root, 'package.json'), { label: 'package.json' });
  const capabilities = validateExecutableManifest(await readJsonFile(
    root,
    path.join(root, 'capabilities/executables.json'),
    { label: 'capabilities/executables.json' },
  ));
  const provenanceBytes = await readRegularFile(
    root,
    path.join(root, 'provenance/distribution-files.json'),
    { label: 'provenance/distribution-files.json' },
  );
  const provenance = JSON.parse(provenanceBytes.toString('utf8'));
  const generated = await buildCatalog(root, overlays, catalogOptions);
  const claudeAgentPaths = [...generated.keys()]
    .filter((relative) => relative.startsWith('claude/agents/'))
    .map((relative) => `agents/${relative.slice('claude/agents/'.length)}`)
    .sort(compareText);
  const manifests = providerManifests(packageJson.version, claudeAgentPaths);
  const catalogs = marketplaceCatalogs();
  const { pluginFiles, bundleFiles, codexConfigBlock } = buildFileSets(generated, manifests);
  assertSemanticExecutableClosure({
    files: pluginFiles,
    providerManifests: manifests,
    provenance,
    capabilities,
    bindings: semanticBindings,
  });
  const validatedReviewers = validateReviewerPolicy(reviewerPolicy);
  const bundle = bundleFromFiles({
    files: bundleFiles,
    sourceCommit: sourceCommit ?? currentCommit(root),
    version: packageJson.version,
    manifests,
    capabilities,
    provenanceBytes,
    reviewerPolicy: validatedReviewers,
    codexConfigBlock,
  });
  const repositoryFiles = new Map([
    ['.claude-plugin/marketplace.json', { bytes: prettyJsonBytes(catalogs.claude), mode: 0o644 }],
    ['.agents/plugins/marketplace.json', { bytes: prettyJsonBytes(catalogs.codex), mode: 0o644 }],
    ...[...pluginFiles].map(([relative, file]) => [`plugins/aidrian/${relative}`, file]),
  ]);
  return {
    version: packageJson.version,
    semanticInventory: [],
    manifests,
    catalogs,
    pluginFiles,
    repositoryFiles,
    bundle,
  };
};

export const writeRepositoryMarketplace = async (options = {}) => {
  const root = options.root ?? ROOT;
  const assembled = await assemblePrivateDistribution(options);
  const ownedRoots = [
    path.join(root, 'plugins/aidrian'),
    path.join(root, '.claude-plugin'),
    path.join(root, '.agents/plugins'),
  ];
  for (const ownedRoot of ownedRoots) await rm(ownedRoot, { force: true, recursive: true });
  for (const [relative, file] of assembled.repositoryFiles) {
    const inspected = inspectRelativePath(relative);
    if (inspected.normalized === null) throw new Error(`unsafe repository output ${relative}`);
    const target = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    await chmod(target, file.mode);
  }
  return assembled;
};
