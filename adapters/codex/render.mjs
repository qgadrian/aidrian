import path from 'node:path';

import { renderInstructions } from '../../src/build/catalog.mjs';

const escapeToml = (value) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

const formatTags = (tags) => tags.map((tag) => `\`${tag}\``).join(', ');

const normalizeEffectiveTags = (instructions, agent) => {
  const conditional = agent.data.conditionalTags.length
    ? `; may additionally load conditionalTags: ${formatTags(agent.data.conditionalTags)} when the task warrants.`
    : '.';
  return instructions.replace(
    /this role's taskTags via docs\/ai-rules\/context-map\.json\./g,
    `this role's effective tags: ${formatTags(agent.data.taskTags)} via docs/ai-rules/context-map.json${conditional}`,
  );
};

export const renderCodexAgent = async (agent, adapter, options = {}) => {
  const model = adapter.models[agent.data.modelTier];
  if (!model) throw new Error(`${agent.data.id}: unsupported model tier ${agent.data.modelTier}`);
  for (const connector of agent.data.logicalConnectors) {
    if (!adapter.connectors[connector]) throw new Error(`${agent.data.id}: unsupported logical connector ${connector} for codex`);
  }
  const instructions = normalizeEffectiveTags(await renderInstructions(agent, adapter, options.slotValues), agent);
  const preambleAgent = { ...agent, instructions: adapter.hostPreamble ?? '' };
  const preamble = await renderInstructions(preambleAgent, adapter, options.slotValues);
  const mirrorNote = `This role mirrors \`.claude/agents/${agent.data.id}.md\`, which is the source of truth for this role.`;
  const taggedInstructions = [preamble.trimEnd(), mirrorNote, instructions.trimEnd()].filter(Boolean).join('\n\n');
  if (taggedInstructions.includes("'''")) throw new Error(`${agent.data.id}: final instructions contain unsupported TOML delimiter`);
  const lines = [
    `# GENERATED FROM .claude/agents/${agent.data.id}.md. DO NOT EDIT MANUALLY.`,
    `# output_mode = "${agent.data.outputMode}"`,
    `model = "${model}"`,
    `model_reasoning_effort = "${agent.data.effort}"`,
  ];
  if (agent.data.sandboxIntent === 'read-only') lines.push('sandbox_mode = "read-only"');
  lines.push('', "developer_instructions = '''", taggedInstructions.trimEnd(), "'''", '');
  return lines.join('\n');
};

export const codexAgentPath = (id) => path.posix.join('codex/agents', `${id}.toml`);

export const renderCodexRegistry = (agents) => {
  const lines = ['# GENERATED CUSTOM AGENT REGISTRY. DO NOT EDIT.'];
  for (const agent of [...agents].sort((a, b) => a.data.id.localeCompare(b.data.id))) {
    lines.push('', `[agents.${agent.data.id}]`);
    lines.push(`description = "${escapeToml(agent.data.description)}"`);
    lines.push(`config_file = "agents/${agent.data.id}.toml"`);
  }
  return `${lines.join('\n')}\n`;
};
