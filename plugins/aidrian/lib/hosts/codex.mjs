// Codex's adapter. docs/providers/adding-a-host.md lists the fields; docs/providers/codex.md says what was checked here.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { responseObjects } from './response.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// An app connector's tool reaches a hook as mcp__codex_apps__<connector>__<tool> (codex-rs/core/src/tools/handlers/mcp.rs
// at rust-v0.166.0, `hook_tool_name`), which reads as one server for every connector. The model's own flat name for it,
// mcp__codex_apps__<connector>_<tool>, is taken too, so a Codex that sends that one is not silently unguarded;
// a connector whose name holds an underscore splits at its first one in that flat form, which only names it differently.
const APP_TOOL = /^mcp__codex_apps__(.+?)__(.+)$/u;
const APP_FLAT_TOOL = /^mcp__codex_apps__([^_]+)_(.+)$/u;

const toolName = (name) => {
  if (typeof name !== 'string') return name;
  const match = APP_TOOL.exec(name) ?? APP_FLAT_TOOL.exec(name);
  return match ? `mcp__codex_apps_${match[1]}__${match[2]}` : name;
};

// A connector's tool in the standard form, as the two names above undo it.
const STANDARD_APP_TOOL = /^mcp__codex_apps_(.+?)__(.+)$/u;

// Codex replaces every character outside [A-Za-z0-9_] in a tool's qualified name (codex-mcp/src/mcp/mod.rs at rust-v0.166.0,
// `sanitize_responses_api_tool_name`), so the server linear-server reaches a hook as mcp__linear_server__<tool>.
const serverSpelling = (server) => server.replace(/[^A-Za-z0-9_]/gu, '_');

// A `*** ... File:` line opens a section of the patch, and `*** Move to:` renames the one above.
const PATCH_TARGET = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu;

function patchFiles(text) {
  const files = [];
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/u.exec(line);
    const move = /^\*\*\* Move to: (.+)$/u.exec(line);
    if (header) files.push({ file: header[1].trim(), added: [] });
    else if (move && files.at(-1)?.file) files.at(-1).file = move[1].trim();
    else if (/^\*\*\* /u.test(line)) files.push({ file: null, added: [] });
    else if (line.startsWith('+') && files.at(-1)?.file) files.at(-1).added.push(line.slice(1));
  }
  return files.filter(({ file }) => file);
}

const configFile = (env) => path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'config.toml');

// The lines of the first section whose header `matches`, without the header, or null when there is none.
function section(lines, matches) {
  const at = lines.findIndex(matches);
  if (at < 0) return null;
  const after = lines.slice(at + 1);
  const end = after.findIndex((line) => line.startsWith('['));
  return end < 0 ? after : after.slice(0, end);
}

const turnedOff = (lines) => lines.some((line) => /^\s*enabled\s*=\s*false\b/u.test(line));
const holdsHash = (lines) => lines.some((line) => /^\s*trusted_hash\s*=\s*(?:"[^"]+"|'[^']+')/u.test(line));

// Whether Codex would run this plugin's tracker hooks: 'trusted'; 'untrusted'; 'off', when the plugin or one of those hooks is
// turned off; or 'absent' when no Codex here has the plugin installed. Codex keeps one `[hooks.state."<plugin
// id>:hooks/hooks.json:<event>:<group>:<handler>"]` per hook, and a hook runs when that holds a `trusted_hash` and
// `enabled` is not false (hooks/src/engine/discovery.rs:1000-1020 at rust-v0.166.0). A hash an update made stale still reads
// as trusted: only `/hooks` can tell, since that takes hashing the hook as Codex does.
// The answer is one of those four words, so no value of the file, which holds a token, leaves this function.
function hookTrust(env) {
  let lines;
  try {
    lines = readFileSync(configFile(env), 'utf8').split(/\r?\n/u);
  } catch {
    return 'absent';
  }
  const plugin = section(lines, (line) => /^\[plugins\."aidrian@[^"]+"\]/u.test(line));
  if (plugin === null) return 'absent';
  if (turnedOff(plugin)) return 'off';
  const states = trackerHookKeys().map((key) => section(lines, (line) => /^\[hooks\.state\."[^"]*aidrian[^"]*hooks\/hooks\.json:/u.test(line) && line.trimEnd().endsWith(`:${key}"]`)));
  if (states.some((state) => state !== null && turnedOff(state))) return 'off';
  return states.every((state) => state !== null && holdsHash(state)) ? 'trusted' : 'untrusted';
}

// The trust keys of the tracker hooks, `<event>:<group>:<handler>`, read from hooks.json so a reordered file cannot go stale.
// Trust is per hook, so trust in another of this plugin's hooks says nothing about these.
function trackerHookKeys() {
  const { hooks } = JSON.parse(readFileSync(new URL('../../hooks/hooks.json', import.meta.url), 'utf8'));
  const keys = [];
  for (const [event, script] of [['PreToolUse', 'hook-tracker-pre.mjs'], ['PostToolUse', 'hook-tracker-post.mjs']]) {
    hooks[event].forEach((group, at) => group.hooks.forEach((hook, handler) => {
      if (hook.command.includes(script)) keys.push(`${event === 'PreToolUse' ? 'pre_tool_use' : 'post_tool_use'}:${at}:${handler}`);
    }));
  }
  return keys;
}

// Every event of hooks.json has a Codex event of the same name (hooks/src/events/common.rs at rust-v0.166.0).
const EVENTS = ['SessionStart', 'SubagentStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop', 'SubagentStop', 'SessionEnd'];

export default {
  id: 'codex',
  name: 'Codex',
  ai: 'Codex',
  modelsKey: 'codex',
  // Codex reads any model name and names these efforts. docs/config.md#models cites both.
  modelChoices: { model: null, effort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'] },
  identityVars: ['CODEX_THREAD_ID'],
  detectVars: ['CODEX_THREAD_ID', 'PLUGIN_ROOT'],
  // A tool hook's payload holds `turn_id`, a plugin hook has PLUGIN_ROOT equal to CLAUDE_PLUGIN_ROOT, and a shell Codex runs
  // has CODEX_THREAD_ID (hooks/src/schema.rs, hooks/src/engine/discovery.rs:314-316, core/src/exec_env.rs at rust-v0.166.0).
  // PLUGIN_ROOT alone may be inherited from anywhere, and CODEX_THREAD_ID alone by a Claude Code started from a Codex shell,
  // which CLAUDECODE tells apart.
  detect: ({ env, input }) => typeof input?.turn_id === 'string'
    || (Boolean(env.PLUGIN_ROOT) && env.PLUGIN_ROOT === env.CLAUDE_PLUGIN_ROOT)
    || (Boolean(env.CODEX_THREAD_ID) && env.CLAUDECODE !== '1'),
  sessionId: (env) => env.CODEX_THREAD_ID || null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  // Codex installs this plugin's agents as roles named `aidrian-<agent>`.
  pluginAgentPrefix: 'aidrian-',
  agentAliases: (type) => (type.startsWith('aidrian-') ? [type.slice('aidrian-'.length)] : []),
  toolName,
  serverSpelling,
  // The name the model calls a tool by: the namespace and the name it sees, run together, with one underscore here.
  nativeToolName(standard) {
    const match = STANDARD_APP_TOOL.exec(standard);
    return match ? `mcp__codex_apps__${match[1]}_${match[2]}` : standard;
  },
  // The MCP result as it comes off the wire: `content`, and sometimes `structuredContent`, which is that tool's own object.
  toolResponse(response) {
    const [direct, ...rest] = responseObjects(response);
    const structured = direct?.structuredContent ?? direct?.structured_content;
    return [direct, ...(isObject(structured) ? [structured] : []), ...rest].filter(Boolean);
  },
  // `raw_tool_name` keeps what Codex sent, so a pattern a project wrote in that form still matches (lib/hosts/index.mjs toolNames).
  hookInput(input) {
    const name = toolName(input.tool_name);
    return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
  },
  hookEvents: Object.fromEntries(EVENTS.map((event) => [event, event])),
  fileEditTools: ['apply_patch'],
  fileEdit(_tool, given) {
    const text = String(given.command ?? given.input ?? '');
    return { shape: 'patch', text, files: patchFiles(text), targets: [...text.matchAll(PATCH_TARGET)].map((match) => match[1].trim()) };
  },
  projectFolders: {},
  capabilities: {
    // Codex keeps its own transcript format, which lib/transcript.mjs does not read.
    transcripts: false,
    trackerGuard: {
      verified: 'source',
      evidence: 'rust-v0.166.0 source, a live codex exec call of the Linear app, and a recorded payload; no live hook has run',
      // MCP servers and app connectors both go through McpHandler and its PreToolUse hook. Hosted tools reach no hook, but
      // no tracker write goes through one.
      unguardedRoutes: [],
      hookTrust,
      trustStep: 'open Codex and trust them in its hooks panel, /hooks, after each install and update',
      offStep: 'open Codex and turn them back on in its hooks panel, /hooks, or enable the plugin',
    },
  },
};
