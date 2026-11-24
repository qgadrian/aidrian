// The one table of OpenCode's tool names and the standard names they stand for, which the adapter (opencode.mjs) reads,
// and the bridge (plugins/aidrian/opencode/bridge.mjs) too, to pick a call's routes by the standard name. It imports
// nothing, not even another lib file, so the bridge loads it in OpenCode's Bun. The names come from OpenCode 2.4.0: its
// built-in shell tool is `shell`, and its file tools `edit`, `write`, and `patch` (embedded source of its binary).

// Each built-in tool this version reads, and the standard tool of the same job; `patch` has none.
const TABLE = new Map([['shell', 'Bash'], ['edit', 'Edit'], ['write', 'Write'], ['patch', null]]);

// SHORTCUT: the tools a hook already receives under their standard name. No hook reads a file edit on OpenCode yet, so
// the file tools reach a hook under OpenCode's own names until they are renamed too.
const RENAMED = new Set(['shell']);

const frozenMap = (pairs) => Object.freeze(Object.assign(Object.create(null), Object.fromEntries(pairs)));
const reversed = (rows) => frozenMap(rows.map(([raw, standard]) => [standard, raw]));

// The standard name of OpenCode's tool `tool`, or null when this table does not hold it, as for an MCP tool or a name
// that is no string. It reads nothing from `info` yet, and never splits a name on `_`: an MCP server's name may hold one.
export function standardToolName(tool, _info) {
  if (!TABLE.has(tool)) return null;
  return RENAMED.has(tool) ? TABLE.get(tool) : tool;
}

// The part of a tool's `info` that standardToolName reads, as plain JSON: none of it yet. The bridge sends it in the
// payload as `opencode.info`, so the adapter reads the same name the bridge picked the routes by.
export function infoRead(_info) {
  return {};
}

// Every name standardToolName can return.
export const STANDARD_NAMES = Object.freeze([...new Set([...TABLE.keys()].map((tool) => standardToolName(tool)))]);

// The standard name to the one OpenCode sends a hook for a tool of that job (the adapter's rawToolName).
export const RAW_NAMES = reversed([...TABLE].filter(([, standard]) => standard !== null));

// The standard name to the one the model calls, where a hook receives the standard one (the adapter's nativeToolName).
export const NATIVE_NAMES = reversed([...TABLE].filter(([raw]) => RENAMED.has(raw)));
