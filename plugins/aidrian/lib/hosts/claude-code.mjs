// Claude Code's adapter. Its event and tool names are the standard the shared code reads, so its payload needs no mapping.
// docs/providers/adding-a-host.md lists the fields; docs/providers/claude-code.md says what was checked on this host.

import { homedir } from 'node:os';
import path from 'node:path';

import { responseObjects } from './response.mjs';

// CLAUDECODE=1 marks its hooks and its Bash tool; the others say the same for a process that lost that one.
const MARKERS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];

export default {
  id: 'claude-code',
  name: 'Claude Code',
  ai: 'Claude',
  // How the plugin's hooks reach it: it reads hooks/hooks.json as it is (docs/providers/adding-a-host.md).
  delivery: 'hooks-json',
  // The `models` key of config.json, and what the Agent tool takes for it. docs/config.md#models cites both.
  modelsKey: 'claude',
  modelChoices: { model: ['sonnet', 'opus', 'haiku', 'fable'], effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
  identityVars: ['CLAUDE_CODE_AGENT', 'CLAUDE_CODE_SESSION_ID'],
  detectVars: ['CLAUDECODE', ...MARKERS],
  detect: ({ env }) => env.CLAUDECODE === '1' || MARKERS.some((name) => Boolean(env[name])),
  sessionId: (env) => env.CLAUDE_CODE_SESSION_ID || null,
  agentName: (env) => env.CLAUDE_CODE_AGENT || null,
  effort: (env) => env.CLAUDE_EFFORT || null,
  runEnv: (env) => (env.CLAUDE_CODE_REMOTE === 'true' ? 'cloud' : null),
  // `aidrian:<agent>` for this plugin's agents, and `<plugin>:<agent>` for another's.
  pluginAgentPrefix: 'aidrian:',
  agentAliases: (type) => [type.slice(type.lastIndexOf(':') + 1)],
  toolName: (name) => name,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  // Its names are the standard, which is what hooks.json matches.
  rawToolName: (standard) => standard,
  toolResponse: responseObjects,
  hookInput: (input) => input,
  fileEditTools: ['Edit', 'Write', 'NotebookEdit'],
  fileEdit(tool, given) {
    const targets = [given.file_path ?? given.notebook_path];
    if (tool === 'Write') return { shape: 'write', file: given.file_path, content: given.content, targets };
    if (tool === 'Edit') return { shape: 'edit', file: given.file_path, edits: Array.isArray(given.edits) ? given.edits : [given], newText: given.new_string, replaceAll: given.replace_all === true, targets };
    return { shape: 'notebook', file: given.notebook_path, targets };
  },
  projectFolders: { skills: '.claude/skills', agents: '.claude/agents' },
  capabilities: {
    // Reads Claude Code's transcripts (lib/transcript.mjs): cost, names reminder, session length, and attribution's model.
    transcripts: true,
    // The settings files that say whether Claude Code asks for its generated-by footer, first that sets it wins.
    prFooterSettings: (root, env) => [
      path.join(root, '.claude/settings.local.json'),
      path.join(root, '.claude/settings.json'),
      path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'settings.json'),
    ],
    // Every MCP call reaches its hooks with no step by a person.
    trackerGuard: { verified: 'live', evidence: 'The PostToolUse payload of a real get_workspace call on Claude Code 2.1.318', unguardedRoutes: [] },
  },
};
