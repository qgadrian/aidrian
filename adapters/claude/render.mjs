import path from 'node:path';

import { renderInstructions } from '../../src/build/catalog.mjs';

const scalar = (value) => JSON.stringify(value);
const bareList = (values) => `[${values.join(', ')}]`;

const safePlainYaml = (value) => /^[^\n\r]+$/.test(value)
  && !/^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value)
  && !/(?:^|\s)#|:\s/.test(value)
  && !['---', '...'].includes(value);
const renderDescription = (value, style) => style === 'quoted' || !safePlainYaml(value) ? scalar(value) : value;
const renderTools = (values, style) => style === 'csv' ? values.join(', ') : bareList(values);

export const renderClaudeAgent = async (agent, adapter, options = {}) => {
  const model = adapter.models[agent.data.modelTier];
  if (!model) throw new Error(`${agent.data.id}: unsupported model tier ${agent.data.modelTier}`);
  const tools = agent.data.capabilities.allow.map((id) => {
    const tool = adapter.hostActions[id];
    if (!tool) throw new Error(`${agent.data.id}: unrenderable capability ${id} for claude`);
    return tool;
  });
  const denied = agent.data.capabilities.deny.flatMap((id) => adapter.deniedCapabilities[id] ?? []);
  const style = agent.data.providerRendering.claude;
  for (const connector of agent.data.logicalConnectors) {
    if (!adapter.connectors[connector]) throw new Error(`${agent.data.id}: unsupported logical connector ${connector} for claude`);
  }
  const lines = [
    '---',
    `name: ${agent.data.id}`,
    `description: ${renderDescription(agent.data.description, style.description)}`,
    `model: ${model}`,
    `effort: ${agent.data.effort}`,
    `color: ${adapter.presentationColors[agent.data.id] ?? 'blue'}`,
    `taskTags: ${bareList(agent.data.taskTags)}`,
    `conditionalTags: ${bareList(agent.data.conditionalTags)}`,
    `outputMode: ${agent.data.outputMode}`,
    ...(style.emitTools ? [`tools: ${renderTools(tools, style.tools)}`] : []),
    ...(style.emitDisallowedTools ? [`disallowedTools: ${bareList([...new Set(denied)])}`] : []),
    ...(agent.data.coverageExemption ? [`changedFilesCoverageExemption: ${agent.data.coverageExemption}`] : []),
    '---',
    '',
    (await renderInstructions(agent, adapter, options.slotValues)).trimEnd(),
    '',
  ];
  return lines.join('\n');
};

export const claudeAgentPath = (id) => path.posix.join('claude/agents', `${id}.md`);
