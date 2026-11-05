// A host that does not exist, shaped to differ from both real ones while reading hooks.json as it is, to prove that such a host
// is one adapter file and nothing in shared code. It is never shipped: test/adapters.test.mjs passes it to the registry's
// functions. Its payload's fields are in camelCase, and its whole-file write takes `path` and `body`.

export default {
  id: 'fakehost',
  name: 'Fake Host',
  ai: 'Faker',
  delivery: 'hooks-json',
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
  toolName: (name) => name,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard,
  rawToolName: (standard) => ({ Edit: 'Write' }[standard] ?? standard),
  toolResponse: (response) => (typeof response?.result === 'object' && response.result !== null ? [response.result] : []),
  hookInput(input) {
    if (typeof input.fakeTurn !== 'string') return input;
    const { fakeTurn: _turn, sessionId, tool, args, result, cwd, ...rest } = input;
    return { ...rest, session_id: sessionId, tool_name: tool, tool_input: args, tool_response: { result }, cwd };
  },
  fileEditTools: ['Write'],
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
      offStep: 'run fakehost enable',
    },
  },
};
