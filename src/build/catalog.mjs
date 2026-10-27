import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

import { assertSafePath, hasPortablePathCollision, readJsonFile, readRegularFile } from './safe-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN = /\{\{(host|provider|slot):([a-z][a-z0-9_.-]*)\}\}/g;
const PROVIDER_SPELLING = /(?:\bClaude\b|\bCodex\b|Agent\(|SendMessage|Skill tool|\.claude\/|\.codex\/)/;

const fail = (id, message) => {
  throw new Error(`${id}: ${message}`);
};

const validateWithSchema = (id, data, schema, label) => {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(data)) {
    fail(id, `invalid ${label}: ${validate.errors.map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ')}`);
  }
};

const assertUniqueIds = (id, label, values) => {
  const ids = values.map((value) => value.id);
  if (new Set(ids).size !== ids.length) fail(id, `duplicate ${label} id`);
};

export const loadAdapter = async (provider, root = ROOT) => {
  if (!['claude', 'codex'].includes(provider)) {
    throw new Error(`unsupported provider ${provider}`);
  }
  const adapter = await readJsonFile(root, path.join(root, 'adapters', provider, 'adapter.json'), { label: `${provider} adapter` });
  if (adapter.hostPreamblePath) {
    adapter.hostPreamble = await readRegularFile(root, path.join(root, 'adapters', provider, adapter.hostPreamblePath), { encoding: 'utf8', label: `${provider} host preamble` });
  }
  return adapter;
};

export const validateAgent = async (agentDir, { root = ROOT } = {}) => {
  await assertSafePath(root, agentDir, { kind: 'directory', label: `${path.basename(agentDir)} agent directory` });
  const data = await readJsonFile(root, path.join(agentDir, 'agent.json'), { label: `${path.basename(agentDir)} agent.json` });
  const schema = await readJsonFile(root, path.join(root, 'catalog/rules/agent.schema.json'), { label: 'agent schema' });
  validateWithSchema(data.id ?? path.basename(agentDir), data, schema, 'agent.json');
  if (data.id !== path.basename(agentDir)) fail(data.id, 'directory name must equal id');
  assertUniqueIds(data.id, 'project slot', data.projectSlots);
  assertUniqueIds(data.id, 'provider fragment', data.providerFragments);
  const overlap = data.capabilities.allow.filter((item) => data.capabilities.deny.includes(item));
  if (overlap.length) fail(data.id, `capabilities both allowed and denied: ${overlap.join(', ')}`);
  const instructions = await readRegularFile(root, path.join(agentDir, data.instructions), { encoding: 'utf8', label: `${data.id} instructions` });
  const providerFragmentBytes = {};
  for (const fragment of data.providerFragments) {
    for (const provider of ['claude', 'codex']) {
      const relative = fragment[provider];
      if (relative === null) continue;
      if (path.isAbsolute(relative) || relative.split('/').includes('..')) fail(data.id, `unsafe provider fragment path ${relative}`);
      providerFragmentBytes[`${fragment.id}:${provider}`] = await readRegularFile(root, path.join(agentDir, relative), {
        encoding: 'utf8',
        label: `${data.id} provider fragment ${fragment.id} for ${provider}`,
      });
    }
  }
  const scrubbed = instructions.replace(TOKEN, '');
  if (PROVIDER_SPELLING.test(scrubbed)) fail(data.id, 'provider spelling outside a typed provider token');
  for (const slot of data.projectSlots) {
    if (PROVIDER_SPELLING.test(slot.default)) fail(data.id, `provider spelling in default project slot ${slot.id}`);
  }
  return { data, instructions, providerFragmentBytes, agentDir, root };
};

export const validateReviewerProfile = (agentId, profile, availableReviewerIds) => {
  const available = new Set(availableReviewerIds);
  for (const reviewer of profile.requiredReviewerIds) {
    if (!available.has(reviewer)) fail(agentId, `required reviewer ${reviewer} is unavailable; no fallback is permitted`);
  }
  if (profile.awaitCodex && !profile.requiredReviewerIds.includes('codex')) {
    fail(agentId, 'awaitCodex requires codex in requiredReviewerIds');
  }
  return {
    requiredReviewerIds: [...profile.requiredReviewerIds],
    reviewArguments: profile.awaitCodex ? ['--await-codex'] : [],
  };
};

export const applyProjectOverlay = async (agent, overlay, { root = ROOT, availableReviewerIds = ['claude', 'codex'] } = {}) => {
  const id = agent.data.id;
  if (!overlay) {
    validateReviewerProfile(id, agent.data.reviewProfile, availableReviewerIds.filter((reviewer) => agent.data.providerSupport[reviewer] !== 'unsupported'));
    return { agent, slotValues: {} };
  }
  const overlaySchema = await readJsonFile(root, path.join(root, 'catalog/rules/project-overlay.schema.json'), { label: 'project overlay schema' });
  validateWithSchema(id, overlay, overlaySchema, 'project overlay');
  if (overlay.agentId !== id) fail(id, `project overlay agentId is ${overlay.agentId}`);
  const declaredSlots = new Set(agent.data.projectSlots.map((slot) => slot.id));
  for (const slot of Object.keys(overlay.slots)) {
    if (!declaredSlots.has(slot)) fail(id, `unknown project slot ${slot}`);
  }
  for (const declaration of agent.data.projectSlots) {
    if (!Object.hasOwn(overlay.slots, declaration.id)) continue;
    validateSlotValue(id, declaration, overlay.slots[declaration.id]);
  }
  const data = { ...structuredClone(agent.data), ...structuredClone(overlay.fields) };
  const agentSchema = await readJsonFile(root, path.join(root, 'catalog/rules/agent.schema.json'), { label: 'agent schema' });
  validateWithSchema(id, data, agentSchema, 'composed agent');
  validateReviewerProfile(id, data.reviewProfile, availableReviewerIds.filter((reviewer) => data.providerSupport[reviewer] !== 'unsupported'));
  return { agent: { ...agent, data }, slotValues: overlay.slots };
};

export const validateSlotValue = (agentId, declaration, value) => {
  if (value.length > declaration.maxLength) fail(agentId, `project slot ${declaration.id} exceeds maxLength ${declaration.maxLength}`);
  if (/\0|\r|'''/.test(value)) fail(agentId, `project slot ${declaration.id} contains an unsafe delimiter`);
  if (declaration.type === 'path' && (!value || value.includes('\n') || !/^[A-Za-z0-9_./*{}<> -]+$/.test(value))) {
    fail(agentId, `project slot ${declaration.id} is not a safe path value`);
  }
  if (declaration.type === 'text' && value.includes('\n')) fail(agentId, `project slot ${declaration.id} must be single-line text`);
};

export const loadAgents = async (root = ROOT) => {
  const agentsDir = path.join(root, 'catalog/agents');
  await assertSafePath(root, agentsDir, { kind: 'directory', label: 'agent catalog directory' });
  const entries = (await readdir(agentsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const agents = [];
  for (const entry of entries) agents.push(await validateAgent(path.join(agentsDir, entry.name), { root }));
  return agents;
};

const readFragment = async (agent, provider, id) => {
  const declaration = agent.data.providerFragments.find((item) => item.id === id);
  if (!declaration) fail(agent.data.id, `unknown provider fragment ${id}`);
  const relative = declaration[provider];
  if (relative === null) return '';
  if (path.isAbsolute(relative) || relative.split('/').includes('..')) fail(agent.data.id, `unsafe provider fragment path ${relative}`);
  try {
    return agent.providerFragmentBytes[`${id}:${provider}`].trimEnd();
  } catch (error) {
    fail(agent.data.id, `unreadable provider fragment ${id} for ${provider}: ${error.code ?? error.message}`);
  }
};

export const renderInstructions = async (agent, adapter, slotValues = {}) => {
  const declaredSlots = new Map(agent.data.projectSlots.map((slot) => [slot.id, slot]));
  for (const id of Object.keys(slotValues)) {
    if (!declaredSlots.has(id)) fail(agent.data.id, `unknown project slot ${id}`);
  }
  for (const [id, declaration] of declaredSlots) {
    validateSlotValue(agent.data.id, declaration, Object.hasOwn(slotValues, id) ? slotValues[id] : declaration.default);
  }
  const renderTemplate = async (template, { providerFragments = true } = {}) => {
    const rendered = [];
    let cursor = 0;
    for (const match of template.matchAll(TOKEN)) {
      rendered.push(template.slice(cursor, match.index));
      const [, kind, id] = match;
      if (kind === 'host') {
        const action = adapter.hostActions[id];
        if (!action) fail(agent.data.id, `unrenderable host action ${id} for ${adapter.provider}`);
        rendered.push(action);
      } else if (kind === 'provider') {
        if (!providerFragments) fail(agent.data.id, `nested provider fragment ${id}`);
        rendered.push(await renderTemplate(await readFragment(agent, adapter.provider, id), { providerFragments: false }));
      } else {
        const declaration = declaredSlots.get(id);
        if (!declaration) fail(agent.data.id, `unknown project slot ${id}`);
        rendered.push(Object.hasOwn(slotValues, id) ? slotValues[id] : declaration.default);
      }
      cursor = match.index + match[0].length;
    }
    rendered.push(template.slice(cursor));
    return rendered.join('');
  };
  let instructionsTemplate = agent.instructions;
  for (const fragment of agent.data.providerFragments) {
    if (fragment[adapter.provider] === null) instructionsTemplate = instructionsTemplate.replace(new RegExp(`^\\{\\{provider:${fragment.id}\\}\\}\\n(?:\\n)?`, 'm'), '');
  }
  const result = (await renderTemplate(instructionsTemplate)).trimEnd() + '\n';
  if (result.includes('{{')) fail(agent.data.id, 'unrendered template token');
  return result;
};

export const listSkillFiles = async (skillDir, { root = skillDir } = {}) => {
  const files = [];
  const visit = async (current, relative = '') => {
    await assertSafePath(root, current, { kind: 'directory', label: `${path.basename(skillDir)} skill directory` });
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = path.posix.join(relative, entry.name);
      const absolute = path.join(current, entry.name);
      if (relative === '' && entry.name === 'skill.json') continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`${path.basename(skillDir)}: skill resources may not be symlinks (${rel})`);
      if (stat.isDirectory()) await visit(absolute, rel);
      else if (stat.isFile()) files.push({ path: rel, bytes: await readRegularFile(root, absolute, { label: `${path.basename(skillDir)} skill resource ${rel}` }), mode: stat.mode & 0o777 });
      else throw new Error(`${path.basename(skillDir)}: unsupported skill resource (${rel})`);
    }
  };
  await visit(skillDir);
  if (!files.some((file) => file.path === 'SKILL.md')) throw new Error(`${path.basename(skillDir)}: missing SKILL.md`);
  return files;
};

export const validateSkill = async (skillDir, { root = ROOT } = {}) => {
  const id = path.basename(skillDir);
  await assertSafePath(root, skillDir, { kind: 'directory', label: `${id} skill directory` });
  const data = await readJsonFile(root, path.join(skillDir, 'skill.json'), { label: `${id} skill.json` });
  const schema = await readJsonFile(root, path.join(root, 'catalog/rules/skill.schema.json'), { label: 'skill schema' });
  validateWithSchema(id, data, schema, 'skill.json');
  if (data.id !== id) fail(id, 'directory name must equal id');
  assertUniqueIds(id, 'project slot', data.projectSlots);
  for (const declaration of data.projectSlots) validateSlotValue(id, declaration, declaration.default);
  const files = await listSkillFiles(skillDir, { root });
  for (const file of files) {
    const text = file.bytes.toString('utf8');
    if (!Buffer.from(text).equals(file.bytes)) continue;
    const scrubbed = text.replace(TOKEN, '');
    if (PROVIDER_SPELLING.test(scrubbed)) fail(id, `provider spelling in neutral skill resource ${file.path}`);
  }
  return { data, files, skillDir, root };
};

export const renderSkillFiles = async (skill, overlay, { root = ROOT, resourceRoot = null } = {}) => {
  const id = skill.data.id;
  const schema = await readJsonFile(root, path.join(root, 'catalog/rules/skill-overlay.schema.json'), { label: 'skill overlay schema' });
  if (overlay) {
    validateWithSchema(id, overlay, schema, 'skill overlay');
    if (overlay.skillId !== id) fail(id, `skill overlay skillId is ${overlay.skillId}`);
  }
  const declared = new Map(skill.data.projectSlots.map((slot) => [slot.id, slot]));
  const values = overlay?.slots ?? {};
  for (const slot of Object.keys(values)) if (!declared.has(slot)) fail(id, `unknown project slot ${slot}`);
  for (const [slotId, declaration] of declared) validateSlotValue(id, declaration, Object.hasOwn(values, slotId) ? values[slotId] : declaration.default);
  const renderedFiles = skill.files.map((file) => {
    const text = file.bytes.toString('utf8');
    if (!Buffer.from(text).equals(file.bytes)) return file;
    const rendered = text.replace(TOKEN, (token, kind, slotId) => {
      if (kind !== 'slot') fail(id, `unsupported ${kind} token in skill resource ${file.path}`);
      const declaration = declared.get(slotId);
      if (!declaration) fail(id, `unknown project slot ${slotId} in skill resource ${file.path}`);
      return Object.hasOwn(values, slotId) ? values[slotId] : declaration.default;
    });
    return { ...file, bytes: Buffer.from(rendered) };
  });
  const neutralNames = renderedFiles.map((file) => file.path);
  if (hasPortablePathCollision(neutralNames)) fail(id, 'neutral skill resources contain a portable path collision');
  const projectNames = [];
  for (const [relative, resource] of Object.entries(overlay?.resources ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    for (const [label, candidate] of [['target', relative], ['source', resource.sourcePath]]) {
      if (path.posix.isAbsolute(candidate) || candidate.split('/').some((segment) => segment === '.' || segment === '..')) {
        fail(id, `project resource ${relative} has an unsafe ${label} path`);
      }
    }
    if (!resourceRoot) fail(id, `project resource ${relative} requires a supplied skill resource root`);
    if (hasPortablePathCollision([...neutralNames, relative])) fail(id, `project resource ${relative} collides with a neutral skill resource`);
    if (hasPortablePathCollision([...projectNames, relative])) fail(id, `project resource ${relative} collides with another project resource`);
    const bytes = await readRegularFile(resourceRoot, path.join(resourceRoot, resource.sourcePath), { label: `${id} project resource ${relative}` });
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== resource.sha256) fail(id, `project resource ${relative} sha256 mismatch`);
    renderedFiles.push({ path: relative, bytes, mode: resource.mode });
    projectNames.push(relative);
  }
  return renderedFiles.sort((a, b) => a.path.localeCompare(b.path));
};

export const rootFromMeta = () => ROOT;
