// A host whose hooks run in process, shaped like the case docs/providers/adding-a-host.md calls `bridge`: its tool names are
// lower case and join server and tool with one underscore with no `mcp__`, so no matcher in hooks.json fires on what it sends. A
// bridge plugin it would need, which this fixture is not, maps the call first and turns exit 2 into a throw. Never shipped.

const STANDARD = { bash: 'Bash', edit: 'Edit', write: 'Write', read: 'Read' };
const RAW = Object.fromEntries(Object.entries(STANDARD).map(([raw, standard]) => [standard, raw]));

function toolName(name, { servers = [] } = {}) {
  if (typeof name !== 'string') return name;
  if (Object.hasOwn(STANDARD, name)) return STANDARD[name];
  const server = [...servers].sort((a, b) => b.length - a.length).find((each) => name.startsWith(`${each}_`));
  return server ? `mcp__${server}__${name.slice(server.length + 1)}` : name;
}

export default {
  id: 'fakebridge',
  name: 'Fake Bridge',
  ai: 'Bridger',
  delivery: 'bridge',
  modelsKey: 'fakebridge',
  modelChoices: { model: null, effort: null },
  identityVars: [],
  detectVars: ['FAKEBRIDGE'],
  detect: ({ env }) => Boolean(env.FAKEBRIDGE),
  sessionId: () => null,
  agentName: () => null,
  effort: () => null,
  runEnv: () => null,
  pluginAgentPrefix: 'aidrian-',
  agentAliases: () => [],
  toolName,
  serverSpelling: (server) => server.replace(/-/gu, '_'),
  nativeToolName: (standard) => standard.replace(/^mcp__(.+?)__/u, '$1_'),
  rawToolName: (standard) => RAW[standard] ?? standard.replace(/^mcp__(.+?)__/u, '$1_'),
  toolResponse: (response) => (typeof response === 'object' && response !== null ? [response] : []),
  hookInput(input, options) {
    const name = toolName(input.tool_name, options);
    return name === input.tool_name ? input : { ...input, tool_name: name, raw_tool_name: input.tool_name };
  },
  fileEditTools: ['edit'],
  fileEdit: (_tool, given) => ({ shape: 'write', file: given.path, content: given.body, targets: [given.path] }),
  projectFolders: {},
  capabilities: { transcripts: false, trackerGuard: { verified: 'none', evidence: 'A fixture', unguardedRoutes: [] } },
};
