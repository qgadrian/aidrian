// A host that does not exist, shaped to differ from both real ones, to prove that a new host is one adapter file and
// nothing in shared code. It is never shipped: test/adapters.test.mjs passes it to the registry's functions.
// It names its tools `server/tool`, its payload's fields in camelCase, and its file edits `edit_file`.

const toolName = (name) => {
  if (typeof name !== 'string') return name;
  const [server, tool] = name.split('/');
  return tool ? `mcp__${server}__${tool}` : name;
};

export default {
  id: 'fakehost',
  name: 'Fake Host',
  ai: 'Faker',
  modelsKey: 'fakehost',
  modelChoices: { model: null, effort: null },
  identityVars: ['FAKEHOST_SESSION'],
  detectVars: ['FAKEHOST_SESSION'],
  detect: ({ env, input }) => Boolean(env.FAKEHOST_SESSION) || typeof input?.fakeTurn === 'string',
  sessionId: (env) => env.FAKEHOST_SESSION || null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  pluginAgentPrefix: 'aidrian/',
  agentAliases: (type) => (type.startsWith('aidrian/') ? [type.slice('aidrian/'.length)] : []),
  toolName,
  toolResponse: (response) => (typeof response?.result === 'object' && response.result !== null ? [response.result] : []),
  hookInput(input) {
    if (typeof input.fakeTurn !== 'string') return input;
    const { fakeTurn: _turn, sessionId, tool, args, result, cwd, ...rest } = input;
    return { ...rest, session_id: sessionId, tool_name: toolName(tool), tool_input: args, tool_response: { result }, cwd };
  },
  hookEvents: { SessionStart: 'start', SubagentStart: null, UserPromptSubmit: 'prompt', PreToolUse: 'before', PostToolUse: 'after', PreCompact: null, Stop: 'stop', SubagentStop: null, SessionEnd: 'end' },
  fileEditTools: ['edit_file'],
  fileEdit: (_tool, given) => ({ shape: 'write', file: given.path, content: given.body, targets: [given.path] }),
  projectFolders: { agents: '.fakehost/agents' },
  capabilities: {
    transcripts: false,
    trackerGuard: {
      verified: 'none',
      evidence: 'A fixture',
      unguardedRoutes: [{ name: 'its hosted connectors', reason: 'they run on its servers, where no hook fires' }],
      hookTrust: () => 'untrusted',
      trustStep: 'run fakehost trust',
    },
  },
};
