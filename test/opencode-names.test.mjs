// The leaf that maps OpenCode's tool names to the standard ones (lib/hosts/opencode-names.mjs): the one table the adapter
// and the bridge read them from. test/opencode-bridge.test.mjs holds it to node: imports alone.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { mcpToolName, NATIVE_NAMES, RAW_NAMES, STANDARD_NAMES, infoRead, standardToolName } from '../plugins/aidrian/lib/hosts/opencode-names.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';

const MCP = 'linear_save_issue';
// What infoRead gives for a Linear server's save_issue, which OpenCode registers as { name, options: { namespace } }.
const LINEAR = { name: 'save_issue', namespace: 'linear' };
const BUILT_IN = [
  ['shell', 'Bash'], ['read', 'Read'], ['edit', 'Edit'], ['write', 'Write'], ['patch', 'Edit'], ['glob', 'Glob'], ['grep', 'Grep'],
  ['webfetch', 'WebFetch'], ['websearch', 'WebSearch'], ['skill', 'Skill'], ['subagent', 'Agent'], ['question', 'AskUserQuestion'],
  ['todowrite', 'TodoWrite'], ['opencode_list_mcp_resources', 'ListMcpResourcesTool'], ['opencode_read_mcp_resource', 'ReadMcpResourceTool'],
];
const CASES = [
  ...BUILT_IN.map(([tool, standard]) => [tool, undefined, standard]),
  ['shell', LINEAR, 'Bash'],
  [MCP, LINEAR, 'mcp__linear__save_issue'],
  ['linear-server_get_workspace', { name: 'get_workspace', namespace: 'linear-server' }, 'mcp__linear-server__get_workspace'],
  ['my_srv_do_it', { name: 'do_it', namespace: 'my_srv' }, 'mcp__my_srv__do_it'],
  ['srv_a_b', { name: 'a.b', namespace: 'srv' }, 'mcp__srv__a_b'],
  [MCP, undefined, null],
  [MCP, {}, null],
  [MCP, { namespace: 'linear' }, null],
  [MCP, { name: 'save_issue' }, null],
  [MCP, { name: 'get_workspace', namespace: 'linear' }, null],
  ['linear_save_issue', { name: 'issue', namespace: 'linear_save' }, 'mcp__linear_save__issue'],
  ['opencode_worktree_create', { name: 'worktree_create', namespace: 'opencode' }, null],
  ['automation_create', { name: 'create', namespace: 'automation' }, null],
  ['machine_list', { name: 'list', namespace: 'machine' }, null],
  ['browser_click', { name: 'click', namespace: 'browser' }, null],
  ['browser_tabs_list', { name: 'list', namespace: 'browser.tabs' }, null],
  ['a__b_c', { name: 'c', namespace: 'a__b' }, null],
  ['a b_c', { name: 'c', namespace: 'a b' }, null],
  // A standard name another server's tool could carry is not given.
  ['mcp__github__merge_pull_request', { name: '_github__merge_pull_request', namespace: 'mcp' }, null],
  ['mcp__x', { name: '_x', namespace: 'mcp' }, null],
  ['github__x', { name: 'x', namespace: 'github_' }, null],
  ['mcp_x', { name: 'x', namespace: 'mcp' }, 'mcp__mcp__x'],
  ['x_', { name: '', namespace: 'x' }, null],
  ['mcp__linear__save_issue', LINEAR, null],
  ['execute', undefined, null],
  ['Bash', undefined, null],
  ['constructor', undefined, null],
  ['__proto__', undefined, null],
  ['toString', undefined, null],
  ['', undefined, null],
  [null, undefined, null],
  [undefined, undefined, null],
  [42, LINEAR, null],
  [{ name: 'shell' }, undefined, null],
];

test('each OpenCode tool reads as its standard name: a built-in by its name, an MCP tool by its info, and null when neither says', () => {
  for (const [tool, info, expected] of CASES) assert.equal(standardToolName(tool, info), expected, JSON.stringify([tool, info]));
});

test('the info the leaf reads is the tool`s own name and its namespace, as plain JSON, and {} for anything else', () => {
  assert.deepEqual(infoRead({ name: 'save_issue', description: 'x', options: { namespace: 'linear', codemode: true }, execute() {} }), LINEAR);
  const throwing = Object.defineProperty({ name: 'x' }, 'options', { enumerable: true, get() { throw new Error('a getter that throws'); } });
  for (const info of [{ namespace: 'linear', title: 'x' }, { name: 'x' }, { name: 'x', options: { namespace: 7 } }, { name: 7, options: { namespace: 'x' } },
    { name: 'x', options: null }, null, undefined, 'text', 3, [], throwing, Object.create(null)]) {
    assert.deepEqual(infoRead(info), {}, String(info?.name));
  }
  const read = infoRead({ name: 'save_issue', options: { namespace: 'linear', secret: 'hush' }, secret: 'hush' });
  assert.deepEqual(JSON.parse(JSON.stringify(read)), read, 'what it returns is plain JSON');
  assert.deepEqual(Object.keys(read).sort(), ['name', 'namespace'], 'and holds nothing else of the info');
  assert.equal(standardToolName(MCP, infoRead({ name: 'save_issue', options: { namespace: 'linear' } })), 'mcp__linear__save_issue');
});

test('STANDARD_NAMES is every built-in name the leaf can return, and nothing else', () => {
  assert.ok(Object.isFrozen(STANDARD_NAMES));
  const returned = new Set(CASES.map(([tool, info]) => standardToolName(tool, info)).filter((name) => name !== null && !name.startsWith('mcp__')));
  assert.deepEqual([...STANDARD_NAMES].sort(), [...returned].sort());
  assert.equal(new Set(STANDARD_NAMES).size, STANDARD_NAMES.length);
});

test('RAW_NAMES and NATIVE_NAMES give each standard name OpenCode`s own, the first where two share one, frozen and with no prototype', () => {
  const expected = Object.fromEntries(BUILT_IN.filter(([tool]) => tool !== 'patch').map(([tool, standard]) => [standard, tool]));
  assert.deepEqual({ ...RAW_NAMES }, expected);
  assert.equal(RAW_NAMES.Edit, 'edit', 'Edit is the edit tool`s, not patch`s');
  assert.deepEqual({ ...NATIVE_NAMES }, expected, 'a hook receives each standard name, so the model calls the same tool');
  for (const map of [RAW_NAMES, NATIVE_NAMES]) {
    assert.ok(Object.isFrozen(map));
    assert.equal(Object.getPrototypeOf(map), null, 'no name of Object.prototype is a mapped tool');
  }
  for (const [standard, raw] of Object.entries(RAW_NAMES)) assert.equal(standardToolName(raw), standard);
});

test('an MCP tool`s standard name gives OpenCode`s own, as its registry spells it, and any other name none', () => {
  assert.equal(mcpToolName('mcp__linear__save_issue'), MCP);
  assert.equal(mcpToolName('mcp__linear-server__get_workspace'), 'linear-server_get_workspace');
  assert.equal(mcpToolName('mcp__my server__a.b'), 'my_server_a_b');
  for (const name of ['Bash', 'linear_save_issue', 'mcp__', 'mcp__x', null, 7]) assert.equal(mcpToolName(name), null, String(name));
  for (const [tool, info, standard] of CASES) if (standard?.startsWith('mcp__')) assert.equal(mcpToolName(standard), tool, `${standard} round-trips`);
});

test('the adapter reads names through the leaf: a marked call is its standard name, with OpenCode`s kept, and an unmarked one is unchanged', () => {
  const marked = { hook_event_name: 'PostToolUse', opencode: { version: '2.4.1', info: {} }, tool_name: 'shell', tool_input: { command: 'ls' } };
  assert.deepEqual(opencode.hookInput(marked), { ...marked, tool_name: 'Bash', raw_tool_name: 'shell' });
  const { opencode: _mark, ...unmarked } = marked;
  assert.equal(opencode.hookInput(unmarked), unmarked);
  for (const [tool, standard] of BUILT_IN) assert.deepEqual(opencode.hookInput({ ...marked, tool_name: tool }), { ...marked, tool_name: standard, raw_tool_name: tool }, tool);
  const mcp = { ...marked, tool_name: MCP, opencode: { info: LINEAR } };
  assert.deepEqual(opencode.hookInput(mcp), { ...mcp, tool_name: 'mcp__linear__save_issue', raw_tool_name: MCP });
  for (const call of [{ ...marked, tool_name: MCP }, { ...marked, tool_name: 'constructor' }, { ...mcp, opencode: { info: { name: 'x', namespace: 'linear' } } }]) {
    assert.equal(opencode.hookInput(call), call, call.tool_name);
  }
  assert.deepEqual(['shell', 'edit', 'subagent', MCP, 'mcp__linear__save_issue', 'constructor'].map(opencode.toolName),
    ['Bash', 'Edit', 'Agent', MCP, 'mcp__linear__save_issue', 'constructor']);
  assert.deepEqual(['Edit', 'AskUserQuestion', 'mcp__linear__save_issue', 'NotebookEdit'].map(opencode.nativeToolName), ['edit', 'question', MCP, 'NotebookEdit']);
  assert.deepEqual(['Edit', 'mcp__linear__save_issue'].map(opencode.rawToolName), ['edit', 'mcp__linear__save_issue'], 'a name alone cannot be read back, so an MCP tool keeps its standard name');
});

// The tools OpenCode 2.4.1 registers, as the spike read them from its source (core/src/tool/plugin/ and
// plugin-browser/src/tools.ts), by the name a hook receives: the direct tools, the Code Mode tools, Code Mode's own
// `execute`, and the tools a flag, the config, or an available model adds.
const DIRECT = ['shell', 'read', 'edit', 'write', 'patch', 'glob', 'grep', 'question', 'skill', 'subagent', 'webfetch', 'websearch'];
const CODE_MODE = [
  'opencode_session_rename', 'opencode_session_move', 'opencode_worktree_create', 'opencode_worktree_list', 'opencode_worktree_remove', 'opencode_models',
  'opencode_list_mcp_events', 'opencode_list_mcp_resources', 'opencode_read_mcp_resource', 'automation_create', 'automation_list', 'automation_pause',
  'automation_resume', 'automation_delete',
  ...['tabs_list', 'tabs_open', 'tabs_focus', 'tabs_close', 'navigate', 'back', 'forward', 'reload', 'stop', 'frames', 'snapshot', 'find', 'evaluate',
    'click', 'hover', 'drag', 'fill', 'fill_form', 'select', 'check', 'press', 'scroll', 'wait', 'screenshot', 'dialog', 'files_upload', 'files_drop',
    'files_list', 'files_get', 'console', 'network_list', 'network_get', 'trace_start', 'trace_stop', 'trace_analyze', 'cpu_start', 'cpu_stop',
    'cpu_analyze', 'heap_snapshot', 'heap_summary', 'heap_query', 'heap_object', 'heap_compare', 'lighthouse'].map((name) => `browser_${name}`),
];
const CONFIGURED = ['todowrite', 'opencode_artifact_create', 'opencode_artifact_read', 'opencode_artifact_update', 'opencode_artifact_delete',
  'opencode_session_search', 'opencode_session_read', 'opencode_session_interrupt', 'machine_list', 'generate_image', 'generate_video'];
const RECORDED = [...DIRECT, ...CODE_MODE, 'execute', ...CONFIGURED];

// The page's list of OpenCode's built-in tools no gate names by a standard name: each entry a tool's name, or a family
// as `<prefix>*`, with its reason.
const PAGE = readFileSync(path.join(import.meta.dirname, '../docs/providers/opencode.md'), 'utf8');
const UNNAMED = 'Built-in tools no gate names by a standard name';
function unnamedEntries(page) {
  const lines = page.split('\n');
  const start = lines.indexOf(`### ${UNNAMED}`);
  if (start === -1) return [];
  const end = lines.findIndex((line, at) => at > start && /^#{1,6} /u.test(line));
  return lines.slice(start + 1, end === -1 ? undefined : end).map((line) => /^- `([^`]+)`: \S/u.exec(line)?.[1]).filter(Boolean);
}
const covers = (entry, tool) => (entry.endsWith('*') ? tool.startsWith(entry.slice(0, -1)) : tool === entry);
// What the leaf and the list leave out of the recorded tools, and what either holds that is no recorded tool or both hold.
function unaccounted(recorded, entries) {
  const mapped = (tool) => standardToolName(tool) !== null;
  const listed = (tool) => entries.some((entry) => covers(entry, tool));
  return {
    neither: recorded.filter((tool) => !mapped(tool) && !listed(tool)),
    both: recorded.filter((tool) => mapped(tool) && listed(tool)),
    emptyEntries: entries.filter((entry) => !recorded.some((tool) => covers(entry, tool))),
    unrecordedTools: Object.values(RAW_NAMES).filter((tool) => !recorded.includes(tool)),
  };
}

test('every tool OpenCode 2.4.1 registers is mapped by the leaf or on the page`s list, never both, and each holds only recorded tools', () => {
  assert.equal(new Set(RECORDED).size, RECORDED.length);
  assert.equal(CODE_MODE.filter((tool) => tool.startsWith('browser_')).length, 44, 'the spike counted 44 browser tools');
  assert.ok(DIRECT.every((tool) => standardToolName(tool) !== null), 'every direct tool has a standard name');
  const entries = unnamedEntries(PAGE);
  assert.ok(entries.length > 0, `the page has a "### ${UNNAMED}" list`);
  assert.deepEqual(unaccounted(RECORDED, entries), { neither: [], both: [], emptyEntries: [], unrecordedTools: [] });
});

test('the check fails on a recorded tool neither holds, one both hold, an entry that covers no tool, and a mapping of no recorded tool', () => {
  const entries = unnamedEntries(PAGE);
  assert.deepEqual(unaccounted([...RECORDED, 'frobnicate'], entries).neither, ['frobnicate']);
  assert.deepEqual(unaccounted(RECORDED, [...entries, 'shell']).both, ['shell']);
  assert.deepEqual(unaccounted(RECORDED, [...entries, 'frob*']).emptyEntries, ['frob*']);
  assert.deepEqual(unaccounted(RECORDED.filter((tool) => tool !== 'todowrite'), entries).unrecordedTools, ['todowrite']);
});
