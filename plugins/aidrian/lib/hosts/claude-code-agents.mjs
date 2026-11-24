// The effort a Claude Code subagent runs at, as its start can tell it, for the `Agent-Effort:` hint the SubagentStart hook
// gives it (scripts/hook-session-start.mjs effortLine). The hint only saves a commit's first try: the attribution rule
// (lib/rules/attribution.mjs) reads the effort from the subagent's own transcript at commit time, and stays the authority.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { agentCall } from '../agent-models.mjs';

// This plugin's generated Claude Code agents (scripts/build.mjs), and the project folder the host reads agents from.
const PLUGIN_AGENTS = path.resolve(import.meta.dirname, '../../agents');
const PROJECT_AGENTS = '.claude/agents';
const PREFIX = 'aidrian:';
const NAME = /^[\w-]{1,64}$/u;

// The `key:` value of the frontmatter of `text`, its quotes dropped, or null.
function frontmatterValue(text, key) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  const found = block === undefined ? null : new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*$`, 'mu').exec(block);
  return found ? found[1].replace(/^(["'])(.*)\1$/u, '$2') : null;
}

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// The text of the definition of the agent `type` names: this plugin's own for `aidrian:<name>`, else the project's
// `.claude/agents/*.md` whose frontmatter `name` is `type`, as Claude Code names a custom subagent; null for another
// plugin's agent, a built-in one, or one no file defines.
function definitionOf(type, root) {
  if (type.startsWith(PREFIX)) {
    const name = type.slice(PREFIX.length);
    return NAME.test(name) ? read(path.join(PLUGIN_AGENTS, `${name}.md`)) : null;
  }
  if (!NAME.test(type) || typeof root !== 'string') return null;
  let files;
  try {
    files = readdirSync(path.join(root, PROJECT_AGENTS)).filter((file) => file.endsWith('.md')).sort();
  } catch {
    return null;
  }
  for (const file of files) {
    const text = read(path.join(root, PROJECT_AGENTS, file));
    if (text !== null && frontmatterValue(text, 'name') === type) return text;
  }
  return null;
}

// The effort the subagent of the SubagentStart payload `input` runs at, one of `efforts`, or null: the level the payload
// carries (`effort.level`), else the effort the project's config.json `models` gives this plugin's agent, as the Agent
// tool's PreToolUse hook adds it to the dispatch (agent-models.mjs agentCall), else its definition's `effort:`
// frontmatter. A dispatch that sets its own effort may still differ, which the commit check names.
export function subagentEffort({ input, root, efforts, models }) {
  const given = input?.effort?.level;
  if (efforts.includes(given)) return given;
  const type = typeof input?.agent_type === 'string' ? input.agent_type : '';
  const configured = type && models ? agentCall({ subagent_type: type }, models)?.effort : undefined;
  if (efforts.includes(configured)) return configured;
  const text = type ? definitionOf(type, root) : null;
  const declared = text === null ? null : frontmatterValue(text, 'effort');
  return efforts.includes(declared) ? declared : null;
}
