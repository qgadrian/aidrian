import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { inspectPathSet, inspectRelativePath } from '../distribution-safety/path-policy.mjs';
import { stableJson } from './assemble.mjs';

export const MANAGED_LEDGER_PATH = '.aidrian/managed-projection.json';
export const CODEX_CONFIG_PATH = '.codex/config.toml';
export const CODEX_BLOCK_START = '# BEGIN AIDRIAN MANAGED AGENTS';
export const CODEX_BLOCK_END = '# END AIDRIAN MANAGED AGENTS';

const run = promisify(execFile);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const NATIVE_PROVIDERS = Object.freeze({
  claude: Object.freeze({
    version: '2.1.312',
    sha256: '6b5ec691195e551b02c41df9f7d723f4ea61eaa03c2df90acefe3736f1aeb620',
    argv: Object.freeze(['plugin', 'list', '--json']),
    writableRootKeys: Object.freeze(['cache', 'config', 'home']),
  }),
  codex: Object.freeze({
    version: '0.164.0',
    sha256: 'd8990e3ee7acfbc26f91265b12a1a83f0fee40d0e0f8f1f40a37d4ec21f499cf',
    argv: Object.freeze(['plugin', 'list', '--available', '--json']),
    writableRootKeys: Object.freeze(['config', 'home']),
  }),
});
const nativeObservationTokens = new WeakMap();
const exactKeys = (value, expected, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (stableJson(actual) !== stableJson(wanted)) {
    throw new Error(`${label} must contain exactly ${wanted.join(', ')}`);
  }
};

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const validateBundlePins = (pins, label = 'expectedBundlePins') => {
  exactKeys(pins, [
    'schemaVersion',
    'sourceCommit',
    'builder',
    'plugin',
    'manifestDigest',
    'bundleDigest',
    'provenanceManifestDigest',
    'providerManifestDigests',
    'capabilityManifestDigest',
  ], label);
  exactKeys(pins.builder, ['id', 'version'], `${label}.builder`);
  exactKeys(pins.plugin, ['id', 'version'], `${label}.plugin`);
  exactKeys(pins.providerManifestDigests, ['claude', 'codex'], `${label}.providerManifestDigests`);
  if (pins.schemaVersion !== 1) throw new Error(`${label}.schemaVersion must be 1`);
  if (!/^[a-f0-9]{40}$/.test(pins.sourceCommit)) throw new Error(`${label}.sourceCommit must be a full Git SHA`);
  if (pins.builder.id !== 'aidrian-project-bundle' || pins.builder.version !== 1) {
    throw new Error(`${label}.builder is unsupported`);
  }
  if (pins.plugin.id !== 'aidrian' || typeof pins.plugin.version !== 'string' || pins.plugin.version.length === 0) {
    throw new Error(`${label}.plugin is invalid`);
  }
  for (const [name, digest] of [
    ['manifestDigest', pins.manifestDigest],
    ['bundleDigest', pins.bundleDigest],
    ['provenanceManifestDigest', pins.provenanceManifestDigest],
    ['providerManifestDigests.claude', pins.providerManifestDigests.claude],
    ['providerManifestDigests.codex', pins.providerManifestDigests.codex],
    ['capabilityManifestDigest', pins.capabilityManifestDigest],
  ]) {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`${label}.${name} must be a SHA-256 digest`);
  }
  return pins;
};

const bundlePinsFromBundle = (bundle) => ({
  schemaVersion: bundle.schemaVersion,
  sourceCommit: bundle.sourceCommit,
  builder: bundle.builder,
  plugin: bundle.plugin,
  manifestDigest: bundle.manifestDigest,
  bundleDigest: bundle.bundleDigest,
  provenanceManifestDigest: bundle.provenanceManifestDigest,
  providerManifestDigests: bundle.providerManifestDigests,
  capabilityManifestDigest: bundle.capabilityManifestDigest,
});

const assertExpectedBundlePins = (bundle, expectedBundlePins) => {
  validateBundlePins(expectedBundlePins);
  const actual = bundlePinsFromBundle(bundle);
  if (stableJson(actual) !== stableJson(expectedBundlePins)) {
    throw new Error('project bundle does not match expectedBundlePins');
  }
};

const safeRelative = (relative, label = relative) => {
  const inspected = inspectRelativePath(relative);
  if (inspected.normalized === null) throw new Error(`${label}: unsafe managed path`);
  return inspected.normalized;
};

const safeTarget = async (root, relative) => {
  const normalized = safeRelative(relative);
  const absoluteRoot = path.resolve(root);
  const rootStat = await lstat(absoluteRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('managed project root must be a real directory');
  }
  const segments = normalized.split('/');
  let current = absoluteRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`${relative}: unsafe managed output ancestor`);
    }
  }
  return path.join(absoluteRoot, ...segments);
};

const decodeBundleFiles = (bundle) => {
  const files = new Map();
  const inspection = inspectPathSet(bundle.files.map((file) => file.path));
  if (inspection.issues.length) throw new Error('bundle contains duplicate, colliding, or unsafe paths');
  for (const entry of bundle.files) {
    exactKeys(entry, ['path', 'mode', 'sha256', 'contentBase64'], `bundle file ${entry.path}`);
    safeRelative(entry.path, 'bundle file');
    if (!/^0[0-7]{3}$/.test(entry.mode)) throw new Error(`${entry.path}: invalid mode`);
    const mode = Number.parseInt(entry.mode, 8);
    if ((mode & 0o111) !== 0) throw new Error(`${entry.path}: executable bundle mode is forbidden`);
    const bytes = Buffer.from(entry.contentBase64, 'base64');
    if (bytes.toString('base64') !== entry.contentBase64) throw new Error(`${entry.path}: non-canonical base64`);
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.path}: bundle content digest mismatch`);
    if (bytes.subarray(0, 2).toString() === '#!') throw new Error(`${entry.path}: bundle shebang is forbidden`);
    files.set(entry.path, { bytes, mode, sha256: entry.sha256 });
  }
  return files;
};

export const validateDataBundle = (bundle) => {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('project bundle must be an object');
  }
  exactKeys(bundle, [
    'schemaVersion',
    'builder',
    'sourceCommit',
    'plugin',
    'providerManifestDigests',
    'capabilityManifestDigest',
    'provenanceManifestDigest',
    'codexConfigBlockDigest',
    'reviewers',
    'ledger',
    'manifestDigest',
    'bundleDigest',
    'codexConfigBlock',
    'files',
  ], 'project bundle');
  if (bundle.schemaVersion !== 1) throw new Error('unsupported project bundle schemaVersion');
  exactKeys(bundle.builder, ['id', 'version'], 'project bundle builder');
  exactKeys(bundle.plugin, ['id', 'version'], 'project bundle plugin');
  if (!/^[a-f0-9]{40}$/.test(bundle.sourceCommit)) throw new Error('project bundle sourceCommit must be a full Git SHA');
  if (bundle.builder.id !== 'aidrian-project-bundle' || bundle.builder.version !== 1) {
    throw new Error('unsupported project bundle builder');
  }
  if (bundle.plugin.id !== 'aidrian') throw new Error('project bundle plugin id must be aidrian');
  if (typeof bundle.plugin.version !== 'string' || bundle.plugin.version.length === 0) {
    throw new Error('project bundle plugin version must be non-empty');
  }
  validateBundlePins(bundlePinsFromBundle(bundle), 'project bundle pins');
  if (!Array.isArray(bundle.files) || !Array.isArray(bundle.ledger)) {
    throw new Error('project bundle files and ledger must be arrays');
  }
  if (sha256(bundle.codexConfigBlock) !== bundle.codexConfigBlockDigest) {
    throw new Error('project bundle Codex config block digest mismatch');
  }
  const files = decodeBundleFiles(bundle);
  const actualLedger = [...files]
    .map(([relative, file]) => ({
      path: relative,
      mode: file.mode.toString(8).padStart(4, '0'),
      sha256: file.sha256,
    }))
    .sort((left, right) => compareText(left.path, right.path));
  if (stableJson(actualLedger) !== stableJson(bundle.ledger)) {
    throw new Error('project bundle ledger does not match its file payload');
  }
  const manifest = {
    schemaVersion: bundle.schemaVersion,
    builder: bundle.builder,
    sourceCommit: bundle.sourceCommit,
    plugin: bundle.plugin,
    providerManifestDigests: bundle.providerManifestDigests,
    capabilityManifestDigest: bundle.capabilityManifestDigest,
    provenanceManifestDigest: bundle.provenanceManifestDigest,
    codexConfigBlockDigest: bundle.codexConfigBlockDigest,
    reviewers: bundle.reviewers,
    ledger: bundle.ledger,
  };
  if (sha256(stableJson(manifest)) !== bundle.manifestDigest) {
    throw new Error('project bundle manifest digest mismatch');
  }
  if (sha256(stableJson({ manifestDigest: bundle.manifestDigest, files: bundle.files })) !== bundle.bundleDigest) {
    throw new Error('project bundle digest mismatch');
  }
  return files;
};

const stateAt = async (root, relative) => {
  const target = await safeTarget(root, relative);
  let stat;
  try {
    stat = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, sha256: null, bytes: null, mode: null };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(`${relative}: managed target must be a single-link regular file`);
  }
  const bytes = await readFile(target);
  return { exists: true, sha256: sha256(bytes), bytes, mode: stat.mode & 0o777 };
};

const stateMatches = (state, expectedSha256, expectedMode) => state.sha256 === expectedSha256
  && state.mode === expectedMode;

const ledgerMode = (entry) => Number.parseInt(entry.mode, 8);

const markerIndexes = (text) => {
  const starts = [...text.matchAll(new RegExp(`^${CODEX_BLOCK_START}$`, 'gm'))].map((match) => match.index);
  const ends = [...text.matchAll(new RegExp(`^${CODEX_BLOCK_END}$`, 'gm'))].map((match) => match.index);
  if (starts.length !== ends.length || starts.length > 1) {
    throw new Error('Codex config contains duplicate or unmatched Aidrian managed blocks');
  }
  if (starts.length === 0) return null;
  const start = starts[0];
  const end = ends[0] + CODEX_BLOCK_END.length;
  if (end < start) throw new Error('Codex config contains an inverted Aidrian managed block');
  return { start, end };
};

const stripManagedBlock = (text) => {
  const indexes = markerIndexes(text);
  if (!indexes) return { unowned: text, owned: null };
  const separatorStart = indexes.start > 0 && text[indexes.start - 1] === '\n'
    ? indexes.start - 1
    : indexes.start;
  const lineEnd = text[indexes.end] === '\n' ? indexes.end + 1 : indexes.end;
  return {
    unowned: text.slice(0, separatorStart) + text.slice(lineEnd),
    owned: text.slice(indexes.start, indexes.end),
  };
};

const codexAgentEntries = (text) => {
  const entries = [];
  const tablePattern = /^\[([^\]]+)\]\s*$/gm;
  const matches = [...text.matchAll(tablePattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const agentMatch = match[1].match(/^agents\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))$/);
    if (!agentMatch) continue;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[index + 1]?.index ?? text.length;
    const body = text.slice(bodyStart, bodyEnd);
    const configMatch = body.match(/^config_file\s*=\s*(?:"([^"]+)"|'([^']+)')\s*$/m);
    entries.push({ id: agentMatch[1] ?? agentMatch[2] ?? agentMatch[3], configPath: configMatch?.[1] ?? configMatch?.[2] ?? null });
  }
  return entries;
};

const ownedCodexAgents = (bundle) => bundle.ledger
  .filter((entry) => entry.path.startsWith('.codex/agents/') && entry.path.endsWith('.toml'))
  .map((entry) => ({
    id: path.posix.basename(entry.path, '.toml'),
    configPath: `agents/${path.posix.basename(entry.path)}`,
  }))
  .sort((left, right) => compareText(left.id, right.id));

const inspectConfigCollisions = (unownedConfig, ownedAgents) => {
  const collisions = [];
  const entries = codexAgentEntries(unownedConfig);
  const ids = new Map();
  const paths = new Map();
  for (const entry of entries) {
    if (ids.has(entry.id)) collisions.push(`config-agent-duplicate:${entry.id}`);
    ids.set(entry.id, entry);
    if (entry.configPath) {
      if (paths.has(entry.configPath)) collisions.push(`config-path-duplicate:${entry.configPath}`);
      paths.set(entry.configPath, entry);
    }
  }
  for (const owned of ownedAgents) {
    if (ids.has(owned.id)) collisions.push(`config-agent-owned-collision:${owned.id}`);
    if (paths.has(owned.configPath)) collisions.push(`config-path-owned-collision:${owned.configPath}`);
  }
  return collisions;
};

const renderManagedBlock = (bundle) => {
  const registry = bundle.codexConfigBlock.trimEnd();
  return `${CODEX_BLOCK_START}\n${registry}\n${CODEX_BLOCK_END}`;
};

const renderConfig = (existing, bundle) => {
  const { unowned } = stripManagedBlock(existing);
  const collisions = inspectConfigCollisions(unowned, ownedCodexAgents(bundle));
  if (collisions.length) return { collisions, bytes: null };
  const separator = unowned.length === 0 ? '' : '\n';
  return { collisions: [], bytes: Buffer.from(`${unowned}${separator}${renderManagedBlock(bundle)}\n`) };
};

const validateOwnedFiles = (ownedFiles, label) => {
  if (!Array.isArray(ownedFiles)) throw new Error(`${label} must be an array`);
  for (const entry of ownedFiles) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${label} entries must be objects`);
    }
    exactKeys(entry, ['path', 'mode', 'sha256'], `${label} entry ${entry.path ?? '<unknown>'}`);
    safeRelative(entry.path, `${label} entry`);
    if (!/^0[0-7]{3}$/.test(entry.mode) || (Number.parseInt(entry.mode, 8) & 0o111) !== 0) {
      throw new Error(`${entry.path}: ${label} mode must be non-executable`);
    }
    if (!DIGEST_PATTERN.test(entry.sha256)) throw new Error(`${entry.path}: ${label} digest is invalid`);
  }
  const inspection = inspectPathSet(ownedFiles.map((entry) => entry.path));
  if (inspection.issues.length) throw new Error(`${label} contains unsafe owned paths`);
  const sorted = [...ownedFiles].sort((left, right) => compareText(left.path, right.path));
  if (stableJson(sorted) !== stableJson(ownedFiles)) throw new Error(`${label} must be sorted by path`);
  return ownedFiles;
};

const validateExpectedPriorProjection = (expectedPriorProjection) => {
  exactKeys(expectedPriorProjection, [
    'schemaVersion',
    'bundlePins',
    'activationMode',
    'ownedFiles',
    'codexConfigBlockSha256',
    'codexConfigPreexisting',
  ], 'expectedPriorProjection');
  if (expectedPriorProjection.schemaVersion !== 1) {
    throw new Error('expectedPriorProjection schemaVersion must be 1');
  }
  validateBundlePins(expectedPriorProjection.bundlePins, 'expectedPriorProjection.bundlePins');
  if (!['project-bundle', 'marketplace-companion'].includes(expectedPriorProjection.activationMode)) {
    throw new Error('expectedPriorProjection activationMode is invalid');
  }
  validateOwnedFiles(expectedPriorProjection.ownedFiles, 'expectedPriorProjection.ownedFiles');
  if (!DIGEST_PATTERN.test(expectedPriorProjection.codexConfigBlockSha256)) {
    throw new Error('expectedPriorProjection codexConfigBlockSha256 must be a SHA-256 digest');
  }
  if (typeof expectedPriorProjection.codexConfigPreexisting !== 'boolean') {
    throw new Error('expectedPriorProjection codexConfigPreexisting must be boolean');
  }
  return expectedPriorProjection;
};

const parseLedger = (bytes) => {
  const ledger = JSON.parse(bytes.toString('utf8'));
  exactKeys(ledger, [
    'schemaVersion',
    'activationMode',
    'bundleDigest',
    'ownedFiles',
    'codexConfigBlockSha256',
    'codexConfigPreexisting',
  ], 'managed projection ledger');
  if (ledger.schemaVersion !== 1) throw new Error('unsupported managed projection ledger');
  if (!['project-bundle', 'marketplace-companion'].includes(ledger.activationMode)) {
    throw new Error('invalid managed projection activationMode');
  }
  validateOwnedFiles(ledger.ownedFiles, 'managed projection ownedFiles');
  if (typeof ledger.codexConfigPreexisting !== 'boolean') {
    throw new Error('managed projection codexConfigPreexisting must be boolean');
  }
  if (!/^[a-f0-9]{64}$/.test(ledger.bundleDigest)
    || !/^[a-f0-9]{64}$/.test(ledger.codexConfigBlockSha256)) {
    throw new Error('managed projection ledger contains an invalid digest');
  }
  return ledger;
};

const ledgerBytes = (activationMode, bundle, ownedFiles, block, configPreexisting) => Buffer.from(`${JSON.stringify({
  schemaVersion: 1,
  activationMode,
  bundleDigest: bundle.bundleDigest,
  ownedFiles: ownedFiles.map(({ path: relative, mode, sha256: digest }) => ({
    path: relative,
    mode: typeof mode === 'number' ? mode.toString(8).padStart(4, '0') : mode,
    sha256: digest,
  })),
  codexConfigBlockSha256: sha256(block),
  codexConfigPreexisting: configPreexisting,
}, null, 2)}\n`);

const assertPriorMatchesLedger = (ledger, expectedPriorProjection) => {
  const actual = {
    bundleDigest: ledger.bundleDigest,
    activationMode: ledger.activationMode,
    ownedFiles: ledger.ownedFiles,
    codexConfigBlockSha256: ledger.codexConfigBlockSha256,
    codexConfigPreexisting: ledger.codexConfigPreexisting,
  };
  const expected = {
    bundleDigest: expectedPriorProjection.bundlePins.bundleDigest,
    activationMode: expectedPriorProjection.activationMode,
    ownedFiles: expectedPriorProjection.ownedFiles,
    codexConfigBlockSha256: expectedPriorProjection.codexConfigBlockSha256,
    codexConfigPreexisting: expectedPriorProjection.codexConfigPreexisting,
  };
  if (stableJson(actual) !== stableJson(expected)) {
    throw new Error('managed projection ledger does not match expectedPriorProjection');
  }
};

const nextProjectionSnapshot = ({
  expectedBundlePins,
  activationMode,
  requested,
  block,
  codexConfigPreexisting,
}) => ({
  schemaVersion: 1,
  bundlePins: structuredClone(expectedBundlePins),
  activationMode,
  ownedFiles: requested.map(({ path: relative, mode, sha256: digest }) => ({
    path: relative,
    mode: mode.toString(8).padStart(4, '0'),
    sha256: digest,
  })),
  codexConfigBlockSha256: sha256(block),
  codexConfigPreexisting,
});

const discoverIds = async (root, relativeRoot, extension) => {
  const absolute = path.join(root, ...relativeRoot.split('/'));
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => extension ? entry.isFile() && entry.name.endsWith(extension) : entry.isDirectory())
    .map((entry) => extension ? entry.name.slice(0, -extension.length) : entry.name)
    .sort(compareText);
};

const parseClaudePluginList = (value) => {
  if (!Array.isArray(value)) throw new Error('Claude 2.1.312 plugin list must be a bare array');
  const pluginIds = [];
  for (const row of value) {
    exactKeys(row, [
      'id',
      'version',
      'scope',
      'enabled',
      'installPath',
      'readFromFolder',
      'folderVersion',
      'installedAt',
      'lastUpdated',
      'projectEnabled',
    ], 'Claude 2.1.312 installed plugin row');
    if (typeof row.id !== 'string' || row.id.length === 0
      || typeof row.version !== 'string' || row.version.length === 0
      || !['user', 'project', 'local'].includes(row.scope)
      || typeof row.enabled !== 'boolean'
      || typeof row.installPath !== 'string'
      || typeof row.readFromFolder !== 'string'
      || typeof row.folderVersion !== 'string'
      || typeof row.installedAt !== 'string'
      || typeof row.lastUpdated !== 'string'
      || typeof row.projectEnabled !== 'boolean') {
      throw new Error('Claude 2.1.312 installed plugin row has an unsupported shape');
    }
    pluginIds.push(row.id);
  }
  return pluginIds;
};

const parseCodexPluginList = (value) => {
  exactKeys(value, ['installed', 'available'], 'Codex 0.164.0 plugin list');
  if (!Array.isArray(value.installed) || !Array.isArray(value.available)) {
    throw new Error('Codex 0.164.0 plugin list installed and available must be arrays');
  }
  const pluginIds = [];
  for (const row of value.installed) {
    exactKeys(row, [
      'pluginId',
      'name',
      'marketplaceName',
      'version',
      'installed',
      'enabled',
      'source',
      'marketplaceSource',
      'installPolicy',
      'authPolicy',
    ], 'Codex 0.164.0 installed plugin row');
    if (typeof row.pluginId !== 'string' || row.pluginId.length === 0
      || typeof row.name !== 'string' || row.name.length === 0
      || typeof row.marketplaceName !== 'string' || row.marketplaceName.length === 0
      || typeof row.version !== 'string' || row.version.length === 0
      || row.installed !== true
      || typeof row.enabled !== 'boolean'
      || typeof row.installPolicy !== 'string'
      || typeof row.authPolicy !== 'string') {
      throw new Error('Codex 0.164.0 installed plugin row has an unsupported shape');
    }
    pluginIds.push(row.pluginId);
  }
  return pluginIds;
};

const parseNativePluginList = (providerId, version, stdout) => {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(`${providerId} ${version} plugin list returned invalid JSON`);
  }
  let pluginIds;
  if (providerId === 'claude' && version === '2.1.312') pluginIds = parseClaudePluginList(value);
  else if (providerId === 'codex' && version === '0.164.0') pluginIds = parseCodexPluginList(value);
  else throw new Error(`unsupported native plugin-list parser ${providerId} ${version}`);
  const sorted = [...pluginIds].sort(compareText);
  if (new Set(sorted).size !== sorted.length) {
    throw new Error(`${providerId} ${version} plugin list contains duplicate plugin ids`);
  }
  return sorted;
};

export const __testOnlyParseNativePluginList = (providerId, version, stdout) => (
  parseNativePluginList(providerId, version, stdout)
);

const realDirectory = async (candidate, label) => {
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = path.resolve(candidate);
  let canonical;
  let stat;
  try {
    canonical = await realpath(resolved);
    stat = await lstat(resolved);
  } catch (error) {
    throw new Error(`${label} must be an existing resolved real directory: ${error.message}`);
  }
  if (canonical !== resolved || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a resolved real directory`);
  }
  return resolved;
};

const normalizeNativeProfile = async (profile) => {
  exactKeys(profile, [
    'providerId',
    'binaryPath',
    'resolvedProfileRoot',
    'writableRoots',
  ], 'native plugin profile');
  const supported = NATIVE_PROVIDERS[profile.providerId];
  if (!supported) throw new Error(`unsupported native provider ${profile.providerId}`);
  exactKeys(profile.writableRoots, supported.writableRootKeys, `${profile.providerId} writableRoots`);
  if (typeof profile.binaryPath !== 'string' || !path.isAbsolute(profile.binaryPath)) {
    throw new Error(`${profile.providerId} binaryPath must be absolute`);
  }
  const requestedBinary = path.resolve(profile.binaryPath);
  const resolvedBinary = await realpath(requestedBinary);
  if (requestedBinary !== resolvedBinary) {
    throw new Error(`${profile.providerId} binaryPath must be the final resolved provider binary`);
  }
  const binaryDigest = sha256(await readFile(resolvedBinary));
  if (binaryDigest !== supported.sha256) {
    throw new Error(`${profile.providerId} provider binary hash is unsupported`);
  }
  const writableRoots = {};
  for (const key of supported.writableRootKeys) {
    writableRoots[key] = await realDirectory(
      profile.writableRoots[key],
      `${profile.providerId} writableRoots.${key}`,
    );
  }
  if (new Set(Object.values(writableRoots)).size !== Object.keys(writableRoots).length) {
    throw new Error(`${profile.providerId} writable roots must be distinct`);
  }
  const resolvedProfileRoot = await realDirectory(
    profile.resolvedProfileRoot,
    `${profile.providerId} resolvedProfileRoot`,
  );
  if (resolvedProfileRoot !== writableRoots.config) {
    throw new Error(`${profile.providerId} resolvedProfileRoot must equal its config root`);
  }
  return {
    providerId: profile.providerId,
    binaryPath: requestedBinary,
    resolvedBinary,
    binarySha256: binaryDigest,
    version: supported.version,
    resolvedProfileRoot,
    writableRoots,
  };
};

const runNativeObservation = async (projectRoot, profiles) => {
  const normalized = [];
  for (const profile of profiles) normalized.push(await normalizeNativeProfile(profile));
  normalized.sort((left, right) => compareText(left.providerId, right.providerId));
  if (stableJson(normalized.map(({ providerId }) => providerId)) !== stableJson(['claude', 'codex'])) {
    throw new Error('native observation requires exactly one Claude and one Codex active profile');
  }
  const inventory = [];
  for (const profile of normalized) {
    const env = {
      ...process.env,
      HOME: profile.writableRoots.home,
    };
    if (profile.providerId === 'claude') {
      env.CLAUDE_CONFIG_DIR = profile.writableRoots.config;
      env.CLAUDE_CODE_PLUGIN_CACHE_DIR = profile.writableRoots.cache;
    } else {
      env.CODEX_HOME = profile.writableRoots.config;
    }
    let stdout;
    try {
      ({ stdout } = await run(profile.resolvedBinary, NATIVE_PROVIDERS[profile.providerId].argv, {
        cwd: projectRoot,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      }));
    } catch (error) {
      throw new Error(`${profile.providerId} native plugin observation failed: ${error.message}`);
    }
    inventory.push({
      providerId: profile.providerId,
      resolvedProfileRoot: profile.resolvedProfileRoot,
      pluginIds: parseNativePluginList(profile.providerId, profile.version, stdout),
    });
  }
  return { profiles: normalized, inventory };
};

export const observeNativePluginProfiles = async ({
  projectRoot,
  activationMode,
  operation,
  bundle = null,
  expectedBundlePins,
  profiles,
}) => {
  if (activationMode !== 'project-bundle') {
    throw new Error('native plugin observation is required only for project-bundle activation');
  }
  if (!['install', 'uninstall'].includes(operation)) throw new Error('native observation operation is invalid');
  validateBundlePins(expectedBundlePins);
  if (operation === 'install') assertExpectedBundlePins(bundle, expectedBundlePins);
  else if (bundle !== null) throw new Error('uninstall native observation bundle must be null');
  if (!Array.isArray(profiles)) throw new Error('native observation profiles must be an array');
  const resolvedProjectRoot = path.resolve(projectRoot);
  const observation = await runNativeObservation(resolvedProjectRoot, profiles);
  const token = Object.freeze(() => {
    throw new Error('native observation tokens are opaque capabilities');
  });
  nativeObservationTokens.set(token, {
    projectRoot: resolvedProjectRoot,
    activationMode,
    operation,
    bundleDigest: expectedBundlePins.bundleDigest,
    profiles: observation.profiles,
    inventory: observation.inventory,
    planned: false,
    consumed: false,
    plan: null,
  });
  return token;
};

const claimNativeObservation = ({
  token,
  projectRoot,
  activationMode,
  operation,
  bundleDigest,
}) => {
  const state = nativeObservationTokens.get(token);
  if (!state) throw new Error('native observation token is missing or fabricated');
  if (state.planned || state.consumed) throw new Error('native observation token was already used');
  if (state.projectRoot !== path.resolve(projectRoot)
    || state.activationMode !== activationMode
    || state.operation !== operation
    || state.bundleDigest !== bundleDigest) {
    throw new Error('native observation token binding mismatch');
  }
  state.planned = true;
  return state;
};

const aidrianPluginIds = (inventory) => inventory
  .flatMap(({ providerId, pluginIds }) => pluginIds
    .filter((id) => id === 'aidrian' || id.startsWith('aidrian@'))
    .map((id) => `${providerId}:${id}`))
  .sort(compareText);

const requestedFiles = (activationMode, bundleFiles) => [...bundleFiles]
  .filter(([relative]) => activationMode === 'project-bundle' || relative.startsWith('.codex/agents/'))
  .map(([relative, file]) => ({ path: relative, mode: file.mode, sha256: file.sha256, bytes: file.bytes }))
  .sort((left, right) => compareText(left.path, right.path));

const isManagedTarget = (relative) => relative === CODEX_CONFIG_PATH
  || relative === MANAGED_LEDGER_PATH
  || /^\.claude\/agents\/[^/]+\.md$/.test(relative)
  || /^\.codex\/agents\/[^/]+\.toml$/.test(relative)
  || /^\.agents\/skills\/[^/]+\/.+/.test(relative);

const validateManagedPlan = (plan) => {
  if (!plan || typeof plan !== 'object' || !['install', 'uninstall'].includes(plan.operation)) {
    throw new Error('invalid managed plan operation');
  }
  if (typeof plan.projectRoot !== 'string' || !Array.isArray(plan.writes) || !Array.isArray(plan.deletes)) {
    throw new Error('managed plan root, writes, and deletes are required');
  }
  const validatePreimage = (entry) => {
    if (entry.preimageSha256 !== null && !/^[a-f0-9]{64}$/.test(entry.preimageSha256)) {
      throw new Error(`${entry.path}: managed plan preimage digest is invalid`);
    }
    if (entry.preimageMode !== null
      && (!Number.isInteger(entry.preimageMode) || entry.preimageMode < 0 || entry.preimageMode > 0o777)) {
      throw new Error(`${entry.path}: managed plan preimage mode is invalid`);
    }
    if ((entry.preimageSha256 === null) !== (entry.preimageMode === null)) {
      throw new Error(`${entry.path}: managed plan preimage digest and mode must both be present or absent`);
    }
  };
  for (const entry of plan.writes) {
    const relative = safeRelative(entry.path, 'managed plan write');
    if (!isManagedTarget(relative)) throw new Error(`${relative}: unmanaged write target`);
    if (!Buffer.isBuffer(entry.bytes)) throw new Error(`${relative}: managed write bytes must be a Buffer`);
    if (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || (entry.mode & 0o111) !== 0) {
      throw new Error(`${relative}: managed write mode must be non-executable`);
    }
    if (entry.bytes.subarray(0, 2).toString() === '#!') throw new Error(`${relative}: managed write shebang is forbidden`);
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(entry.bytes) !== entry.sha256) {
      throw new Error(`${relative}: managed write digest mismatch`);
    }
    validatePreimage(entry);
  }
  for (const entry of plan.deletes) {
    const relative = safeRelative(entry.path, 'managed plan delete');
    if (!isManagedTarget(relative)) throw new Error(`${relative}: unmanaged delete target`);
    validatePreimage(entry);
  }
};

const preflightProjection = async ({
  projectRoot,
  bundle,
  activationMode,
  expectedPriorProjection,
  nativeInventory,
}) => {
  if (!['project-bundle', 'marketplace-companion'].includes(activationMode)) {
    throw new Error('activationMode must be project-bundle or marketplace-companion');
  }
  const bundleFiles = validateDataBundle(bundle);
  const collisions = [];
  const ledgerState = await stateAt(projectRoot, MANAGED_LEDGER_PATH);
  const previousLedger = ledgerState.exists ? parseLedger(ledgerState.bytes) : null;
  if (previousLedger && expectedPriorProjection === null) {
    throw new Error('existing managed projection requires expectedPriorProjection');
  }
  if (!previousLedger && expectedPriorProjection !== null) {
    throw new Error('expectedPriorProjection was supplied but no managed projection is installed');
  }
  if (previousLedger) assertPriorMatchesLedger(previousLedger, expectedPriorProjection);
  if (previousLedger && previousLedger.activationMode !== activationMode) {
    collisions.push(`activation-mode:${previousLedger.activationMode}:${activationMode}`);
  }
  if (activationMode === 'project-bundle') {
    for (const id of aidrianPluginIds(nativeInventory)) collisions.push(`installed-plugin:${id}`);
  }
  const [claudeRoles, codexRoles, agentSkills] = await Promise.all([
    discoverIds(projectRoot, '.claude/agents', '.md'),
    discoverIds(projectRoot, '.codex/agents', '.toml'),
    discoverIds(projectRoot, '.agents/skills', null),
  ]);
  const requested = requestedFiles(activationMode, bundleFiles);
  const previousOwned = new Map((expectedPriorProjection?.ownedFiles ?? []).map((entry) => [entry.path, entry]));
  for (const file of requested) {
    const state = await stateAt(projectRoot, file.path);
    const previous = previousOwned.get(file.path);
    if (previous) {
      if (!state.exists || !stateMatches(state, previous.sha256, ledgerMode(previous))) {
        collisions.push(`dirty-preimage:${file.path}`);
      }
    } else if (state.exists) {
      collisions.push(`managed-path:${file.path}`);
    }
  }
  for (const [relative, previous] of previousOwned) {
    if (requested.some((file) => file.path === relative)) continue;
    const state = await stateAt(projectRoot, relative);
    if (!state.exists || !stateMatches(state, previous.sha256, ledgerMode(previous))) {
      collisions.push(`dirty-preimage:${relative}`);
    }
  }
  const ownedRoles = new Set(ownedCodexAgents(bundle).map(({ id }) => id));
  if (activationMode === 'project-bundle') {
    for (const entry of bundle.ledger.filter(({ path: relative }) => relative.startsWith('.claude/agents/'))) {
      const id = path.posix.basename(entry.path, '.md');
      if (claudeRoles.includes(id) && !previousOwned.has(entry.path)) collisions.push(`role-id:claude:${id}`);
    }
    for (const entry of bundle.ledger.filter(({ path: relative }) => relative.startsWith('.agents/skills/'))) {
      const id = entry.path.split('/')[2];
      if (agentSkills.includes(id) && ![...previousOwned.keys()].some((owned) => owned.startsWith(`.agents/skills/${id}/`))) {
        collisions.push(`skill-id:${id}`);
      }
    }
  }
  for (const id of codexRoles) {
    if (ownedRoles.has(id) && !previousOwned.has(`.codex/agents/${id}.toml`)) collisions.push(`role-id:codex:${id}`);
  }
  const configState = await stateAt(projectRoot, CODEX_CONFIG_PATH);
  const existingConfig = configState.bytes?.toString('utf8') ?? '';
  const configParts = stripManagedBlock(existingConfig);
  if (configParts.owned && !previousLedger) collisions.push('orphan-managed-config-block');
  if (expectedPriorProjection
    && sha256(configParts.owned ?? '') !== expectedPriorProjection.codexConfigBlockSha256) {
    collisions.push(`dirty-preimage:${CODEX_CONFIG_PATH}:managed-block`);
  }
  const renderedConfig = renderConfig(existingConfig, bundle);
  collisions.push(...renderedConfig.collisions);
  return {
    bundleFiles,
    requested,
    previousLedger,
    ledgerState,
    configState,
    renderedConfig,
    collisions: [...new Set(collisions)].sort(),
  };
};

export const planManagedInstall = async ({
  projectRoot,
  bundle,
  activationMode,
  expectedBundlePins,
  expectedPriorProjection,
  nativeObservationToken = null,
}) => {
  assertExpectedBundlePins(bundle, expectedBundlePins);
  if (expectedPriorProjection !== null) validateExpectedPriorProjection(expectedPriorProjection);
  let nativeState = null;
  if (activationMode === 'project-bundle') {
    nativeState = claimNativeObservation({
      token: nativeObservationToken,
      projectRoot,
      activationMode,
      operation: 'install',
      bundleDigest: expectedBundlePins.bundleDigest,
    });
  } else if (nativeObservationToken !== null) {
    throw new Error('marketplace-companion activation must not carry a native observation token');
  }
  const preflight = await preflightProjection({
    projectRoot,
    bundle,
    activationMode,
    expectedPriorProjection,
    nativeInventory: nativeState?.inventory ?? [],
  });
  if (preflight.collisions.length) {
    throw new Error(`managed projection preflight failed\n${preflight.collisions.join('\n')}`);
  }
  const writes = preflight.requested.map((file) => {
    const previous = preflight.previousLedger?.ownedFiles.find((owned) => owned.path === file.path);
    return {
      ...file,
      preimageSha256: previous?.sha256 ?? null,
      preimageMode: previous ? ledgerMode(previous) : null,
    };
  });
  const nextPaths = new Set(preflight.requested.map((file) => file.path));
  const deletes = (preflight.previousLedger?.ownedFiles ?? [])
    .filter((entry) => !nextPaths.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      preimageSha256: entry.sha256,
      preimageMode: ledgerMode(entry),
    }));
  const block = renderManagedBlock(bundle);
  const configPreexisting = expectedPriorProjection?.codexConfigPreexisting ?? preflight.configState.exists;
  const nextLedger = ledgerBytes(
    activationMode,
    bundle,
    preflight.requested,
    block,
    configPreexisting,
  );
  writes.push({
    path: CODEX_CONFIG_PATH,
    bytes: preflight.renderedConfig.bytes,
    mode: preflight.configState.mode ?? 0o644,
    sha256: sha256(preflight.renderedConfig.bytes),
    preimageSha256: preflight.configState.sha256,
    preimageMode: preflight.configState.mode,
  });
  writes.push({
    path: MANAGED_LEDGER_PATH,
    bytes: nextLedger,
    mode: 0o644,
    sha256: sha256(nextLedger),
    preimageSha256: preflight.ledgerState.sha256,
    preimageMode: preflight.ledgerState.mode,
  });
  const plan = {
    projectRoot: path.resolve(projectRoot),
    operation: 'install',
    activationMode,
    nativeObservationToken,
    writes,
    deletes,
    nextProjection: nextProjectionSnapshot({
      expectedBundlePins,
      activationMode,
      requested: preflight.requested,
      block,
      codexConfigPreexisting: configPreexisting,
    }),
  };
  if (nativeState) nativeState.plan = plan;
  return plan;
};

export const planManagedUninstall = async ({
  projectRoot,
  expectedPriorProjection,
  nativeObservationToken = null,
}) => {
  validateExpectedPriorProjection(expectedPriorProjection);
  let nativeState = null;
  if (expectedPriorProjection.activationMode === 'project-bundle') {
    nativeState = claimNativeObservation({
      token: nativeObservationToken,
      projectRoot,
      activationMode: expectedPriorProjection.activationMode,
      operation: 'uninstall',
      bundleDigest: expectedPriorProjection.bundlePins.bundleDigest,
    });
  } else if (nativeObservationToken !== null) {
    throw new Error('marketplace-companion uninstall must not carry a native observation token');
  }
  const ledgerState = await stateAt(projectRoot, MANAGED_LEDGER_PATH);
  if (!ledgerState.exists) throw new Error('managed projection is not installed');
  const ledger = parseLedger(ledgerState.bytes);
  assertPriorMatchesLedger(ledger, expectedPriorProjection);
  const collisions = [];
  const deletes = [];
  for (const entry of ledger.ownedFiles) {
    const state = await stateAt(projectRoot, entry.path);
    if (!state.exists || !stateMatches(state, entry.sha256, ledgerMode(entry))) {
      collisions.push(`dirty-preimage:${entry.path}`);
    } else {
      deletes.push({
        path: entry.path,
        preimageSha256: entry.sha256,
        preimageMode: ledgerMode(entry),
      });
    }
  }
  const configState = await stateAt(projectRoot, CODEX_CONFIG_PATH);
  const existing = configState.bytes?.toString('utf8') ?? '';
  const parts = stripManagedBlock(existing);
  if (!parts.owned || sha256(parts.owned) !== expectedPriorProjection.codexConfigBlockSha256) {
    collisions.push(`dirty-preimage:${CODEX_CONFIG_PATH}:managed-block`);
  }
  if (collisions.length) throw new Error(`managed uninstall preflight failed\n${collisions.sort().join('\n')}`);
  const writes = [];
  const bytes = Buffer.from(parts.unowned);
  const ownedOnlyPostimage = Buffer.from(`${parts.owned}\n`);
  if (expectedPriorProjection.codexConfigPreexisting
    || bytes.length !== 0
    || !configState.bytes.equals(ownedOnlyPostimage)) {
    writes.push({
      path: CODEX_CONFIG_PATH,
      bytes,
      mode: configState.mode ?? 0o644,
      sha256: sha256(bytes),
      preimageSha256: configState.sha256,
      preimageMode: configState.mode,
    });
  } else {
    deletes.push({
      path: CODEX_CONFIG_PATH,
      preimageSha256: configState.sha256,
      preimageMode: configState.mode,
    });
  }
  deletes.push({
    path: MANAGED_LEDGER_PATH,
    preimageSha256: ledgerState.sha256,
    preimageMode: ledgerState.mode,
  });
  const plan = {
    projectRoot: path.resolve(projectRoot),
    operation: 'uninstall',
    activationMode: expectedPriorProjection.activationMode,
    nativeObservationToken,
    writes,
    deletes,
    nextProjection: null,
  };
  if (nativeState) nativeState.plan = plan;
  return plan;
};

const assertSafeWriteChain = async (root, relative) => {
  return safeTarget(root, relative);
};

const atomicRestore = async (root, relative, bytes, mode) => {
  const target = await assertSafeWriteChain(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.aidrian-restore-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    try {
      await rm(temporary, { force: true });
    } catch (cleanupError) {
      error.message += `; restore temporary cleanup failed: ${cleanupError.message}`;
    }
    throw error;
  }
};

const freshNativeObservationBeforeApply = async (plan) => {
  if (plan.activationMode !== 'project-bundle') {
    if (plan.nativeObservationToken !== null) {
      throw new Error('non-project managed plan must not carry a native observation token');
    }
    return;
  }
  const state = nativeObservationTokens.get(plan.nativeObservationToken);
  if (!state || state.plan !== plan || !state.planned || state.consumed) {
    throw new Error('managed plan native observation token is missing, fabricated, or replayed');
  }
  state.consumed = true;
  const profileRequests = state.profiles.map((profile) => ({
    providerId: profile.providerId,
    binaryPath: profile.resolvedBinary,
    resolvedProfileRoot: profile.resolvedProfileRoot,
    writableRoots: profile.writableRoots,
  }));
  const fresh = await runNativeObservation(plan.projectRoot, profileRequests);
  if (stableJson(fresh.profiles) !== stableJson(state.profiles)
    || stableJson(fresh.inventory) !== stableJson(state.inventory)) {
    throw new Error('native plugin observation changed before managed apply');
  }
  const collisions = aidrianPluginIds(fresh.inventory);
  if (collisions.length) {
    throw new Error(`native Aidrian plugin collision before managed apply\n${collisions.join('\n')}`);
  }
};

const applyManagedPlanInternal = async (plan, testHooks = null) => {
  validateManagedPlan(plan);
  const all = [
    ...plan.writes.map((entry) => ({ ...entry, action: 'write' })),
    ...plan.deletes.map((entry) => ({ ...entry, action: 'delete' })),
  ];
  const paths = all.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length) throw new Error('managed plan contains duplicate targets');
  const before = new Map();
  for (const entry of all) {
    const state = await stateAt(plan.projectRoot, entry.path);
    if (!stateMatches(state, entry.preimageSha256, entry.preimageMode)) {
      throw new Error(`managed plan concurrent preimage changed: ${entry.path}`);
    }
    before.set(entry.path, state);
  }
  await freshNativeObservationBeforeApply(plan);
  const staged = [];
  const applied = [];
  let mutationIndex = 0;
  try {
    for (const entry of plan.writes) {
      const target = await assertSafeWriteChain(plan.projectRoot, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = path.join(path.dirname(target), `.${path.basename(target)}.aidrian-${randomUUID()}`);
      await writeFile(temporary, entry.bytes, { flag: 'wx', mode: entry.mode });
      await chmod(temporary, entry.mode);
      staged.push({ temporary, target, entry });
    }
    for (const stagedEntry of staged) {
      const state = await stateAt(plan.projectRoot, stagedEntry.entry.path);
      if (!stateMatches(
        state,
        stagedEntry.entry.preimageSha256,
        stagedEntry.entry.preimageMode,
      )) {
        throw new Error(`managed plan concurrent preimage changed: ${stagedEntry.entry.path}`);
      }
      await rename(stagedEntry.temporary, stagedEntry.target);
      applied.push({
        entry: stagedEntry.entry,
        postimageSha256: stagedEntry.entry.sha256,
        postimageMode: stagedEntry.entry.mode,
      });
      const postimage = await stateAt(plan.projectRoot, stagedEntry.entry.path);
      if (!stateMatches(postimage, stagedEntry.entry.sha256, stagedEntry.entry.mode)) {
        throw new Error(`managed plan postimage verification failed: ${stagedEntry.entry.path}`);
      }
      mutationIndex += 1;
      await testHooks?.afterMutationApplied({
        path: stagedEntry.entry.path,
        action: 'write',
        mutationIndex,
      });
    }
    for (const entry of plan.deletes) {
      const target = await assertSafeWriteChain(plan.projectRoot, entry.path);
      const state = await stateAt(plan.projectRoot, entry.path);
      if (!stateMatches(state, entry.preimageSha256, entry.preimageMode)) {
        throw new Error(`managed plan concurrent preimage changed: ${entry.path}`);
      }
      await unlink(target);
      applied.push({ entry, postimageSha256: null, postimageMode: null });
      const postimage = await stateAt(plan.projectRoot, entry.path);
      if (!stateMatches(postimage, null, null)) {
        throw new Error(`managed plan postimage verification failed: ${entry.path}`);
      }
      mutationIndex += 1;
      await testHooks?.afterMutationApplied({ path: entry.path, action: 'delete', mutationIndex });
    }
  } catch (error) {
    const rollbackFailures = [];
    for (const entry of staged) {
      try {
        await rm(entry.temporary, { force: true });
      } catch (cleanupError) {
        rollbackFailures.push(`${entry.entry.path}: staged temporary cleanup failed: ${cleanupError.message}`);
      }
    }
    for (const { entry, postimageSha256, postimageMode } of [...applied].reverse()) {
      const relative = entry.path;
      const original = before.get(relative);
      let current;
      try {
        current = await stateAt(plan.projectRoot, relative);
      } catch (stateError) {
        rollbackFailures.push(`${relative}: rollback preimage read failed: ${stateError.message}`);
        continue;
      }
      if (!stateMatches(current, postimageSha256, postimageMode)) {
        rollbackFailures.push(`${relative}: concurrent postimage changed; left untouched`);
        continue;
      }
      try {
        await testHooks?.beforeRollbackRestore({ path: relative });
        if (!original.exists) {
          const target = await assertSafeWriteChain(plan.projectRoot, relative);
          await rm(target, { force: true });
        } else {
          await atomicRestore(plan.projectRoot, relative, original.bytes, original.mode);
        }
        const restored = await stateAt(plan.projectRoot, relative);
        if (!stateMatches(restored, original.sha256, original.mode)) {
          throw new Error('restored digest or mode does not match the original preimage');
        }
      } catch (restoreError) {
        rollbackFailures.push(`${relative}: restore failed: ${restoreError.message}`);
      }
    }
    if (rollbackFailures.length) {
      error.message += `\nmanaged rollback incomplete\n${rollbackFailures.sort().join('\n')}`;
    }
    throw error;
  }
  return { operation: plan.operation, written: plan.writes.map(({ path: relative }) => relative), deleted: plan.deletes.map(({ path: relative }) => relative) };
};

export const applyManagedPlan = async (plan) => applyManagedPlanInternal(plan);

export const applyManagedPlanForTest = async (plan, hooks) => {
  exactKeys(hooks, ['afterMutationApplied', 'beforeRollbackRestore'], 'managed apply test hooks');
  if (typeof hooks.afterMutationApplied !== 'function' || typeof hooks.beforeRollbackRestore !== 'function') {
    throw new Error('managed apply test hooks must be functions');
  }
  return applyManagedPlanInternal(plan, hooks);
};
