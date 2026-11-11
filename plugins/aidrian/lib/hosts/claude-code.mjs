// Claude Code's adapter. Its event and tool names are the standard the shared code reads, so its payload needs no mapping but
// for the GitHub MCP server a plugin installs.
// docs/providers/adding-a-host.md lists the fields; docs/providers/claude-code.md says what was checked on this host.

import { homedir } from 'node:os';
import path from 'node:path';

import { responseObjects } from './response.mjs';

// CLAUDECODE=1 marks its hooks and its Bash tool; the others say the same for a process that lost that one.
const MARKERS = ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_AGENT', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_EFFORT'];

// An MCP server a plugin bundles reaches a hook as mcp__plugin_<plugin>_<server>__<tool> (code.claude.com/docs/en/hooks), so the
// GitHub MCP server installed through a plugin is mcp__plugin_github_github__merge_pull_request. That name is read as
// mcp__github__<tool> when the tool is one the GitHub MCP hook judges and a word of the plugin and server names holds "github",
// in any case. The tool name alone is not enough: other forges' servers, such as Gitea's or Bitbucket's, have a
// merge_pull_request or update_pull_request of their own, and the merge guard refuses a merge whose head it cannot read.
// A GitHub server under a name with no "github" in it stays unread: docs/providers/claude-code.md#a-github-mcp-server-from-a-plugin.
const GITHUB_TOOLS = ['merge_pull_request', 'update_pull_request', 'update_pull_request_draft_state', 'add_issue_comment', 'add_reply_to_pull_request_comment', 'pull_request_review_write'];
const WORD = '[A-Za-z0-9-]';
// Words joined by single underscores, one of them holding "github"; anchored, and with no lookaround, so Codex's regex reads it too.
const SEGMENT = `(?:${WORD}+_)*${WORD}*[Gg][Ii][Tt][Hh][Uu][Bb]${WORD}*(?:_${WORD}+)*`;
// hooks.json's matcher for these names, as written there; test/host-plugin-github.test.mjs holds the two equal.
export const PLUGIN_GITHUB_MATCHER = `^mcp__plugin_${SEGMENT}__(?:${GITHUB_TOOLS.join('|')})$`;
const PLUGIN_GITHUB_TOOL = new RegExp(PLUGIN_GITHUB_MATCHER, 'u');

const toolName = (name) => (typeof name === 'string' && PLUGIN_GITHUB_TOOL.test(name) ? `mcp__github__${name.slice(name.lastIndexOf('__') + 2)}` : name);

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
  toolName,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  // Its names are the standard, which is what hooks.json matches; a plugin's GitHub server has its own matcher there.
  rawToolName: (standard) => standard,
  toolResponse: responseObjects,
  // `raw_tool_name` keeps what Claude Code sent, so a pattern a project wrote in that form still matches (lib/hosts/index.mjs toolNames).
  hookInput(input) {
    const name = toolName(input.tool_name);
    return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
  },
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
    // Also opts it into the review-rounds rule's reading of the Human's answers and typed grants of review rounds.
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
