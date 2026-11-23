// OpenCode's adapter, for OpenCode 2.0 and later. docs/providers/adding-a-host.md lists the fields.
// OpenCode runs no hooks.json: the aidrian bridge, a server plugin, sends a hook script the standard envelope with
// OpenCode's own tool name, input, and result inside, and a top-level `opencode` object that marks the payload as
// OpenCode's. This file maps that to the standard names, so the hook scripts read it as they read any host's.
// The facts below come from OpenCode 2.4.0: the types of @opencode/plugin@2.4.0 and the embedded source of its binary.

import { setUp } from './opencode-setup.mjs';
import { patchEdit } from './patch.mjs';
import { responseObjects } from './response.mjs';

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// The bridge puts the mark at the top level of the payload, where only the host process writes; a tool's own input sits
// under `tool_input`, so no tool call can add it.
const payloadMark = (input) => isObject(input?.opencode);

// Its built-in shell tool is `shell`, and its file tools `edit`, `write`, and `patch` (embedded source of 2.4.0).
const RAW_TOOLS = { Bash: 'shell', Edit: 'edit', Write: 'write' };
const NATIVE_TOOLS = { Bash: 'shell' };

export default {
  id: 'opencode',
  name: 'OpenCode',
  ai: 'OpenCode',
  // How the plugin's hooks reach it: a bridge plugin runs the hook scripts its routes name, on OpenCode's tool events
  // (docs/providers/adding-a-host.md). A hook no route names does not run here.
  delivery: 'bridge',
  modelsKey: 'opencode',
  // No agents of this plugin run here yet, so no model or effort is read for it, and nothing reads its transcripts.
  modelChoices: { model: null, effort: null },
  modelPrices: { models: [], rows: [] },
  identityVars: ['OPENCODE_SESSION_ID'],
  detectVars: ['OPENCODE', 'OPENCODE_SESSION_ID'],
  payloadMark,
  // Every command its shell tool runs has OPENCODE=1 and OPENCODE_SESSION_ID, the calling session's id. Those variables
  // claim a process only when it holds no hook payload: a payload the bridge sent carries the mark, so one without it,
  // under variables inherited from an OpenCode shell, is another host's hook that lost its own marks, and the unknown host
  // reads it through every adapter. It names no other host's variable: lib/hosts/index.mjs asks it last, so a process
  // another host's detection claims is never read as OpenCode's.
  detect: ({ env, input }) => payloadMark(input)
    || (typeof input?.hook_event_name !== 'string' && env.OPENCODE === '1' && Boolean(env.OPENCODE_SESSION_ID)),
  sessionId: (env) => env.OPENCODE_SESSION_ID || null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  pluginAgentPrefix: 'aidrian-',
  agentAliases: (type) => (type.startsWith('aidrian-') ? [type.slice('aidrian-'.length)] : []),
  // The bridge forwards no MCP tool call, so no MCP name is mapped yet.
  toolName: (name) => name,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => NATIVE_TOOLS[standard] ?? standard,
  rawToolName: (standard) => RAW_TOOLS[standard] ?? standard,
  toolResponse: responseObjects,
  // A shell call's result, `{ output: { output, exitCode }, content, metadata }`: the command's output is the text under
  // `output.output`. The bridge sends only a call that completed, so none is interrupted.
  shellOutput: (response) => ({ output: typeof response?.output?.output === 'string' ? response.output.output : null, interrupted: false }),
  // A marked shell call reads as the standard Bash; `raw_tool_name` keeps what OpenCode sent (lib/hosts/index.mjs toolNames).
  hookInput(input) {
    if (!payloadMark(input) || input.tool_name !== 'shell') return input;
    return { ...input, tool_name: 'Bash', raw_tool_name: 'shell' };
  },
  // Its file tools and their inputs, read as text from the tool schemas embedded in the installed OpenCode 2.4.0 binary
  // (the `edit` tool's is { path, oldString, newString, replaceAll }), not from a recorded live payload: `write` { path,
  // content }, `edit` as given, and `patch` { patchText } in the `*** Begin Patch` format. No hook receives a file edit on
  // OpenCode in this version; the conformance suite asks every host to say these.
  fileEditTools: ['edit', 'write', 'patch'],
  fileEdit(tool, given) {
    if (tool === 'write') return { shape: 'write', file: given.path, content: given.content, targets: [given.path] };
    if (tool === 'edit') {
      return { shape: 'edit', file: given.path, edits: [{ old_string: given.oldString, new_string: given.newString }], newText: given.newString, replaceAll: given.replaceAll === true, targets: [given.path] };
    }
    return patchEdit(String(given.patchText ?? ''));
  },
  projectFolders: {},
  mainCheckoutPaths: { folders: [], settings: [] },
  capabilities: {
    transcripts: false,
    trackerGuard: {
      verified: 'none',
      evidence: 'the bridge forwards no MCP tool call to a hook, so no tracker write is judged on OpenCode',
      unguardedRoutes: [{ name: 'any MCP tool', reason: 'the bridge forwards no MCP tool call to a hook in this version' }],
    },
    // Whether OpenCode is set up to run this plugin here, `setUp({ env, root })`, from its config files alone
    // (opencode-setup.mjs): `aidrian check` names OpenCode's unguarded routes only then (lib/tracker-check.mjs).
    setUp,
    // Nothing here says whether OpenCode would let a session push to the remote.
    pushPermission: () => ({ answer: 'unknown' }),
    handoffContinue: { routes: [] },
  },
};
