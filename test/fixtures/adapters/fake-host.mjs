// A host that does not exist, shaped to differ from both real ones while reading hooks.json as it is, to prove that such a host
// is one adapter file and nothing in shared code. It is never shipped: test/adapters.test.mjs passes it to the registry's
// functions. Its MCP names join server and tool with one underscore, its payload's fields are in camelCase, and its whole-file
// write takes `path` and `body`.

const mcpPrefix = 'mcp__';

// Which part of `mcp__<server>_<tool>` is the server cannot be told from the name, so the known servers say, longest first.
function toolName(name, { servers = [] } = {}) {
  if (typeof name !== 'string' || !name.startsWith(mcpPrefix) || /^mcp__.+?__/u.test(name)) return name;
  const rest = name.slice(mcpPrefix.length);
  const server = [...servers].sort((a, b) => b.length - a.length).find((each) => rest.startsWith(`${each}_`));
  return server ? `${mcpPrefix}${server}__${rest.slice(server.length + 1)}` : name;
}

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
  toolName,
  serverSpelling: (server) => server,
  nativeToolName: (standard) => standard.replace(/^(mcp__.+?)__/u, '$1_'),
  rawToolName: (standard) => ({ Edit: 'Write' }[standard] ?? standard.replace(/^(mcp__.+?)__/u, '$1_')),
  toolResponse: (response) => (typeof response?.result === 'object' && response.result !== null ? [response.result] : []),
  hookInput(input, { servers = [] } = {}) {
    if (typeof input.fakeTurn !== 'string') return input;
    const { fakeTurn: _turn, sessionId, tool, args, result, cwd, ...rest } = input;
    const standard = toolName(tool, { servers });
    return { ...rest, session_id: sessionId, tool_name: standard, ...(standard === tool ? {} : { raw_tool_name: tool }), tool_input: args, tool_response: { result }, cwd };
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
