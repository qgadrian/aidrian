import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { claudeAgentPath, renderClaudeAgent } from '../../adapters/claude/render.mjs';
import { codexAgentPath, renderCodexAgent, renderCodexRegistry } from '../../adapters/codex/render.mjs';
import { applyProjectOverlay, loadAdapter, loadAgents, renderSkillFiles, rootFromMeta, validateSkill } from './catalog.mjs';
import { assertSafePath, hasPortablePathCollision, readJsonFile } from './safe-files.mjs';
import { parseStrictOptions } from './strict-args.mjs';

const parseArgs = (args) => parseStrictOptions(args, {
  '--out': { name: 'output', default: 'dist/generated' },
  '--project-overlays': { name: 'overlays', default: null },
  '--skill-overlays': { name: 'skillOverlays', default: null },
  '--skill-resource-root': { name: 'skillResourceRoot', default: null },
  '--candidate-inventory': { name: 'candidateInventory', default: null },
});

const sortObject = (value) => {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortObject(child)]));
  }
  return value;
};

export const loadProjectOverlays = async (overlayRoot) => {
  if (!overlayRoot) return {};
  await assertSafePath(overlayRoot, overlayRoot, { kind: 'directory', label: 'project overlay directory' });
  const overlays = {};
  for (const entry of (await readdir(overlayRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`unsupported project overlay entry ${entry.name}`);
    const id = path.basename(entry.name, '.json');
    const overlay = await readJsonFile(overlayRoot, path.join(overlayRoot, entry.name), { label: `project overlay ${entry.name}` });
    if (overlay.agentId !== id) throw new Error(`${id}: project overlay agentId must match its filename`);
    if (overlays[id]) throw new Error(`duplicate project overlay ${id}`);
    overlays[id] = overlay;
  }
  return overlays;
};

export const loadSkillOverlays = async (overlayRoot) => {
  if (!overlayRoot) return {};
  await assertSafePath(overlayRoot, overlayRoot, { kind: 'directory', label: 'skill overlay directory' });
  const overlays = {};
  for (const entry of (await readdir(overlayRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error(`unsupported skill overlay entry ${entry.name}`);
    const id = path.basename(entry.name, '.json');
    const overlay = await readJsonFile(overlayRoot, path.join(overlayRoot, entry.name), { label: `skill overlay ${entry.name}` });
    if (overlay.skillId !== id) throw new Error(`${id}: skill overlay skillId must match its filename`);
    if (overlays[id]) throw new Error(`duplicate skill overlay ${id}`);
    overlays[id] = overlay;
  }
  return overlays;
};

const sha256Pattern = /^[a-f0-9]{64}$/;

const assertSourceIdentity = (kind, declaration, entry) => {
  if (!sha256Pattern.test(declaration.sourceSha256)) throw new Error(`${declaration.id}: invalid ${kind} sourceSha256`);
  if (!entry) throw new Error(`${declaration.id}: selected ${kind} is missing from the supplied candidate inventory`);
  if (entry.sourceSha256 !== declaration.sourceSha256) throw new Error(`${declaration.id}: ${kind} sourceSha256 does not match the supplied candidate inventory`);
};

const loadCandidateInventory = async (root, supplied) => {
  if (supplied && typeof supplied === 'object') return supplied;
  const file = supplied ?? path.join(root, 'catalog/rules/source-inventory.json');
  return readJsonFile(path.dirname(file), file, { label: 'candidate inventory' });
};

export const buildCatalog = async (root = rootFromMeta(), overlays = {}, options = {}) => {
  const agents = await loadAgents(root);
  const claude = await loadAdapter('claude', root);
  const codex = await loadAdapter('codex', root);
  const allowlist = await readJsonFile(root, path.join(root, 'catalog/rules/private-allowlist.json'), { label: 'private allowlist' });
  const candidateInventory = await loadCandidateInventory(root, options.candidateInventory);
  const allowedAgents = allowlist.agents.map((entry) => entry.id).sort();
  const actualAgents = agents.map((agent) => agent.data.id).sort();
  if (allowlist.agents.some((entry) => !['shared', 'composed'].includes(entry.disposition) || entry.internalUse !== 'authorized-private')) throw new Error('catalog agents require explicit shared/composed private authorization');
  if (JSON.stringify(allowedAgents) !== JSON.stringify(actualAgents)) throw new Error('catalog agents must exactly equal the positive private allowlist');
  for (const agent of agents) {
    const declaration = allowlist.agents.find((entry) => entry.id === agent.data.id);
    assertSourceIdentity('agent', declaration, candidateInventory.entries.find((entry) => entry.path === `.claude/agents/${declaration.id}.md`));
    for (const field of ['internalUse', 'publicEligibility', 'transformation']) {
      if (declaration[field] !== agent.data.source[field]) throw new Error(`${agent.data.id}: catalog source ${field} does not match the positive private allowlist`);
    }
  }
  const files = new Map();
  const generatedNames = [];
  const addGeneratedFile = (relative, file) => {
    if (hasPortablePathCollision([...generatedNames, relative])) {
      throw new Error(`generated file ${relative} collides in the portable output namespace`);
    }
    generatedNames.push(relative);
    files.set(relative, file);
  };
  const capabilityReport = [];
  const sourceReport = { agents: [], skills: [] };
  const composedAgents = [];
  const unknownOverlays = Object.keys(overlays).filter((id) => !actualAgents.includes(id));
  if (unknownOverlays.length) throw new Error(`unknown project overlay agents: ${unknownOverlays.sort().join(', ')}`);
  for (const baseAgent of agents) {
    const availableReviewerIds = [claude, codex]
      .filter((adapter) => baseAgent.data.providerSupport[adapter.provider] !== 'unsupported')
      .map((adapter) => adapter.provider);
    const { agent, slotValues } = await applyProjectOverlay(baseAgent, overlays[baseAgent.data.id], { root, availableReviewerIds });
    composedAgents.push(agent);
    const sourceDeclaration = allowlist.agents.find((entry) => entry.id === agent.data.id);
    sourceReport.agents.push({
      id: agent.data.id,
      originalSourceSha256: sourceDeclaration.sourceSha256,
      neutralDefinitionSha256: createHash('sha256')
        .update(JSON.stringify(sortObject(baseAgent.data)))
        .update('\0')
        .update(baseAgent.instructions)
        .update('\0')
        .update(JSON.stringify(sortObject(baseAgent.providerFragmentBytes)))
        .digest('hex'),
      transformation: sourceDeclaration.transformation,
    });
    for (const adapter of [claude, codex]) {
      if (agent.data.providerSupport[adapter.provider] === 'unsupported') throw new Error(`${agent.data.id}: ${adapter.provider} provider is unsupported`);
      for (const capability of [...agent.data.capabilities.allow, ...agent.data.capabilities.deny]) {
        const support = adapter.capabilitySupport[capability];
        if (!support || support === 'unsupported') throw new Error(`${agent.data.id}: unsupported capability ${capability} for ${adapter.provider}`);
      }
    }
    addGeneratedFile(claudeAgentPath(agent.data.id), { bytes: Buffer.from(await renderClaudeAgent(agent, claude, { slotValues })), mode: 0o644 });
    addGeneratedFile(codexAgentPath(agent.data.id), { bytes: Buffer.from(await renderCodexAgent(agent, codex, { slotValues })), mode: 0o644 });
    capabilityReport.push({
      id: agent.data.id,
      capabilities: agent.data.capabilities,
      logicalConnectors: agent.data.logicalConnectors,
      sandboxIntent: agent.data.sandboxIntent,
      providerSupport: agent.data.providerSupport,
      providerProjection: {
        claude: {
          tools: agent.data.capabilities.allow.map((capability) => claude.hostActions[capability]),
          disallowedTools: agent.data.capabilities.deny.flatMap((capability) => claude.deniedCapabilities[capability] ?? []),
          logicalMcpServers: agent.data.logicalConnectors.map((connector) => claude.connectors[connector]),
        },
        codex: {
          sandboxMode: agent.data.sandboxIntent === 'read-only' ? 'read-only' : null,
          instructionOnlyCapabilities: [...agent.data.capabilities.allow, ...agent.data.capabilities.deny]
            .filter((capability) => codex.capabilitySupport[capability] === 'instruction-only'),
          logicalMcpServers: agent.data.logicalConnectors.map((connector) => codex.connectors[connector]),
        },
      },
      reviewProfile: {
        requiredReviewerIds: agent.data.reviewProfile.requiredReviewerIds,
        reviewArguments: agent.data.reviewProfile.awaitCodex ? ['--await-codex'] : [],
      },
      enforcement: Object.fromEntries([claude, codex].map((adapter) => [adapter.provider, Object.fromEntries([...agent.data.capabilities.allow, ...agent.data.capabilities.deny].map((id) => [id, adapter.capabilitySupport[id]]))])),
    });
  }
  const skillRoot = path.join(root, 'catalog/skills');
  await assertSafePath(root, skillRoot, { kind: 'directory', label: 'skill catalog directory' });
  const skillDirs = (await readdir(skillRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const allowedSkills = allowlist.skills.map((entry) => entry.id).sort();
  if (allowlist.skills.some((entry) => !['shared', 'composed'].includes(entry.disposition) || entry.internalUse !== 'authorized-private')) throw new Error('catalog skills require explicit shared/composed private authorization');
  if (JSON.stringify(allowedSkills) !== JSON.stringify(skillDirs)) throw new Error('catalog skills must exactly equal the positive private allowlist');
  const skillOverlays = options.skillOverlays ?? {};
  const unknownSkillOverlays = Object.keys(skillOverlays).filter((id) => !skillDirs.includes(id));
  if (unknownSkillOverlays.length) throw new Error(`unknown project overlay skills: ${unknownSkillOverlays.sort().join(', ')}`);
  for (const skillId of skillDirs) {
    const declaration = allowlist.skills.find((entry) => entry.id === skillId);
    assertSourceIdentity('skill', declaration, candidateInventory.entries.find((entry) => entry.path === `.agents/skills/${declaration.id}/SKILL.md`));
    const skill = await validateSkill(path.join(skillRoot, skillId), { root });
    for (const field of ['internalUse', 'publicEligibility', 'transformation']) {
      if (declaration[field] !== skill.data.source[field]) throw new Error(`${skillId}: catalog source ${field} does not match the positive private allowlist`);
    }
    const skillFiles = await renderSkillFiles(skill, skillOverlays[skillId], { root, resourceRoot: options.skillResourceRoot });
    const entrypoint = skillFiles.find((file) => file.path === 'SKILL.md');
    const neutralEntrypoint = skill.files.find((file) => file.path === 'SKILL.md');
    if (declaration.transformation === 'identity' && createHash('sha256').update(entrypoint.bytes).digest('hex') !== declaration.sourceSha256) {
      throw new Error(`${skillId}: identity skill bytes do not match the authorized source hash`);
    }
    for (const file of skillFiles) {
      addGeneratedFile(path.posix.join('shared/skills', skillId, file.path), { bytes: file.bytes, mode: file.mode });
    }
    sourceReport.skills.push({
      id: skillId,
      originalSourceSha256: declaration.sourceSha256,
      neutralEntrypointSha256: createHash('sha256').update(neutralEntrypoint.bytes).digest('hex'),
      transformation: declaration.transformation,
    });
  }
  addGeneratedFile('codex/config.toml', {
    bytes: Buffer.from(renderCodexRegistry(composedAgents)),
    mode: 0o644,
  });
  addGeneratedFile('capability-report.json', {
    bytes: Buffer.from(`${JSON.stringify(sortObject({
      schemaVersion: 1,
      agents: capabilityReport,
      providers: {
        claude: { capabilitySupport: claude.capabilitySupport, connectors: claude.connectors, hostActions: claude.hostActions, models: claude.models },
        codex: { capabilitySupport: codex.capabilitySupport, connectors: codex.connectors, hostActions: codex.hostActions, models: codex.models },
      },
    }), null, 2)}\n`),
    mode: 0o644,
  });
  addGeneratedFile('source-report.json', {
    bytes: Buffer.from(`${JSON.stringify(sortObject({ schemaVersion: 1, ...sourceReport }), null, 2)}\n`),
    mode: 0o644,
  });
  return files;
};

const statOrNull = async (target) => {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
};

const contained = (relative) => relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);

const assertSafeOutputChain = async (base, target) => {
  const absoluteBase = path.resolve(base);
  const absolute = path.resolve(target);
  const relative = path.relative(absoluteBase, absolute);
  if (!contained(relative)) throw new Error(`refusing build output outside its authorized root ${absolute}`);
  const baseStat = await lstat(absoluteBase);
  if (baseStat.isSymbolicLink()) throw new Error(`refusing build output with symbolic-link root ${absoluteBase}`);
  if (!baseStat.isDirectory()) throw new Error(`refusing build output with non-directory root ${absoluteBase}`);
  const canonicalBase = await realpath(absoluteBase);
  let current = absoluteBase;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await statOrNull(current);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`refusing build output with symbolic-link ancestor ${current}`);
    if (!stat.isDirectory()) throw new Error(`refusing build output with non-directory ancestor ${current}`);
  }
  const canonicalTarget = await realpath(absolute);
  if (!contained(path.relative(canonicalBase, canonicalTarget))) {
    throw new Error(`refusing build output whose canonical path escapes its authorized root ${absolute}`);
  }
};

export const writeCatalog = async (root, output, overlays = {}, options = {}) => {
  const files = await buildCatalog(root, overlays, options);
  const absoluteOutput = path.resolve(root, output);
  const ownedRoot = path.join(path.resolve(root), 'dist/generated');
  const relativeToOwned = path.relative(ownedRoot, absoluteOutput);
  const isOwnedOutput = relativeToOwned === '' || (relativeToOwned !== '..' && !relativeToOwned.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeToOwned));
  const outputBoundaryRoot = isOwnedOutput ? path.resolve(root) : path.dirname(absoluteOutput);
  if (absoluteOutput === path.parse(absoluteOutput).root || absoluteOutput === path.resolve(root)) {
    throw new Error(`refusing unsafe build output ${absoluteOutput}`);
  }
  await assertSafeOutputChain(outputBoundaryRoot, absoluteOutput);
  const outputStat = await statOrNull(absoluteOutput);
  if (!isOwnedOutput && outputStat) throw new Error(`refusing to replace pre-existing external build output ${absoluteOutput}`);
  if (isOwnedOutput) {
    await rm(absoluteOutput, { recursive: true, force: true });
    await mkdir(absoluteOutput, { recursive: true });
  } else {
    const parent = path.dirname(absoluteOutput);
    await assertSafePath(parent, parent, { kind: 'directory', label: 'external build output parent' });
    await mkdir(absoluteOutput);
  }
  await assertSafeOutputChain(outputBoundaryRoot, absoluteOutput);
  for (const [relative, file] of files) {
    const target = path.join(absoluteOutput, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.bytes);
    await chmod(target, file.mode);
  }
  return { output: absoluteOutput, files: [...files.keys()].sort() };
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = rootFromMeta();
  const { output, overlays: overlayRoot, skillOverlays: skillOverlayRoot, skillResourceRoot, candidateInventory } = parseArgs(process.argv.slice(2));
  const overlays = await loadProjectOverlays(overlayRoot);
  const skillOverlays = await loadSkillOverlays(skillOverlayRoot);
  const result = await writeCatalog(root, output, overlays, { candidateInventory, skillOverlays, skillResourceRoot });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
