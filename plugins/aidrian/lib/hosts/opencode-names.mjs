// The one table of OpenCode's tool names and the standard names they stand for, which the adapter (opencode.mjs) reads,
// and the bridge (plugins/aidrian/opencode/bridge.mjs) too, to pick a call's routes by the standard name. It imports
// nothing, not even another lib file, so the bridge loads it in OpenCode's Bun. The names come from the source of
// OpenCode 2.4.1: each built-in tool's `name` constant, and the effective name its tool registry gives a tool,
// `<namespace with "." as "_">_<name>` with each character outside [a-zA-Z0-9_-] as `_` (core/src/tool/runtime.ts).

// Each built-in tool, by the name a hook receives, and the standard tool of the same job. `patch` edits, adds, moves, and
// deletes files, all of which Edit's permission rules govern on Claude Code. `subagent` reads as Agent, the name
// Claude Code gives its subagent tool today; hooks.json matches its older name, Task, beside it. A built-in tool with
// no standard tool of the same job is listed in docs/providers/opencode.md, and test/opencode-names.test.mjs holds the
// two lists to the tools OpenCode 2.4.1 registers.
const TABLE = new Map([
  ['shell', 'Bash'], ['read', 'Read'], ['edit', 'Edit'], ['write', 'Write'], ['patch', 'Edit'], ['glob', 'Glob'],
  ['grep', 'Grep'], ['webfetch', 'WebFetch'], ['websearch', 'WebSearch'], ['skill', 'Skill'], ['subagent', 'Agent'],
  ['question', 'AskUserQuestion'], ['todowrite', 'TodoWrite'],
  ['opencode_list_mcp_resources', 'ListMcpResourcesTool'], ['opencode_read_mcp_resource', 'ReadMcpResourceTool'],
]);

// The namespaces OpenCode's own tools register under: none of them is an MCP server's, though a server may be named
// so. An MCP server's namespace is its name with each character outside [a-zA-Z0-9_-] as `_` (core/src/tool/mcp.ts),
// so it holds no `.`, and a namespace past this list, a plugin's included, reads as a server.
const OWN_NAMESPACES = new Set(['opencode', 'automation', 'machine', 'browser']);
const SERVER = /^[A-Za-z0-9_-]+$/u;

const normalized = (name) => name.replace(/[^a-zA-Z0-9_-]/gu, '_');

// The standard name of OpenCode's tool `tool`, whose `info` is what infoRead read of the event's info, or null when the
// name says nothing this table can read. A built-in tool is read by its name. Any other is an MCP tool only when `info`
// names its namespace and its own name, and `tool` is the effective name those give: mcp__<server>__<tool>, from the
// namespace and the tool's own name, never from a split of `tool` on `_`, since a server's name may hold one. A server
// that shares a namespace of OpenCode's own tools, or whose name holds `__` or ends in `_`, which the standard name
// cannot carry apart from another server's, stays null, as does a tool OpenCode itself calls `mcp__...`, which would
// read as the standard name of another tool, and a call a plugin renamed to another tool than its info describes.
export function standardToolName(tool, info) {
  if (typeof tool !== 'string') return null;
  if (TABLE.has(tool)) return TABLE.get(tool);
  const { name, namespace } = info ?? {};
  if (typeof name !== 'string' || name === '' || typeof namespace !== 'string' || !SERVER.test(namespace)) return null;
  if (OWN_NAMESPACES.has(namespace) || namespace.includes('__') || namespace.endsWith('_') || tool.startsWith('mcp__')) return null;
  if (tool !== `${namespace}_${normalized(name)}`) return null;
  return `mcp__${namespace}__${normalized(name)}`;
}

// The part of a tool's `info` that standardToolName reads, as plain JSON: its own `name` and its `options.namespace`,
// both strings, or {} when either is not. The bridge sends it in the payload as `opencode.info`, so the adapter reads
// the same name the bridge picked the routes by. An info that throws when read reads as {}.
export function infoRead(info) {
  try {
    const name = info?.name;
    const namespace = info?.options?.namespace;
    return typeof name === 'string' && typeof namespace === 'string' ? { name, namespace } : {};
  } catch {
    return {};
  }
}

// Every built-in name standardToolName can return; an MCP tool's is mcp__<server>__<tool>.
export const STANDARD_NAMES = Object.freeze([...new Set(TABLE.values())]);

// The standard name to the name OpenCode gives the tool of that job, the first in the table where two share one (Edit's
// is `edit`): what a hook receives as `raw_tool_name` and the model calls (the adapter's rawToolName and nativeToolName).
const pairs = [...TABLE].reverse().map(([raw, standard]) => [standard, raw]);
export const RAW_NAMES = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(pairs)));
export const NATIVE_NAMES = RAW_NAMES;

// OpenCode's name for the standard MCP tool name `standard`, mcp__<server>__<tool>, as its registry gives it, or null for
// a name of no MCP tool: `<server>_<tool>`, each part with the characters outside [a-zA-Z0-9_-] as `_`.
export function mcpToolName(standard) {
  const match = typeof standard === 'string' ? /^mcp__(.+?)__(.+)$/u.exec(standard) : null;
  return match ? `${normalized(match[1])}_${normalized(match[2])}` : null;
}
