// The leaf that maps OpenCode's tool names to the standard ones (lib/hosts/opencode-names.mjs): the one table the adapter
// reads them from.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { NATIVE_NAMES, RAW_NAMES, STANDARD_NAMES, infoRead, standardToolName } from '../plugins/aidrian/lib/hosts/opencode-names.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';

const LEAF = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/hosts/opencode-names.mjs');
const MCP = 'linear_save_issue';
const CASES = [
  ['shell', undefined, 'Bash'],
  ['edit', undefined, 'edit'],
  ['write', undefined, 'write'],
  ['patch', undefined, 'patch'],
  ['read', undefined, null],
  ['Bash', undefined, null],
  [MCP, undefined, null],
  [MCP, { namespace: 'linear' }, null],
  ['mcp__linear__save_issue', { namespace: 'linear' }, null],
  ['constructor', undefined, null],
  ['__proto__', undefined, null],
  ['toString', undefined, null],
  ['', undefined, null],
  [null, undefined, null],
  [undefined, undefined, null],
  [42, undefined, null],
  [{ name: 'shell' }, undefined, null],
];

test('each OpenCode tool name reads as its standard name, or null when the name says nothing yet', () => {
  for (const [tool, info, expected] of CASES) assert.equal(standardToolName(tool, info), expected, JSON.stringify([tool, info]));
});

test('the info the leaf reads is empty in this version, whatever it is given', () => {
  const throwing = Object.defineProperty({}, 'namespace', { enumerable: true, get() { throw new Error('a getter that throws'); } });
  for (const info of [{ namespace: 'linear', title: 'x' }, null, undefined, 'text', 3, [], throwing, Object.create(null)]) {
    assert.deepEqual(infoRead(info), {});
  }
  assert.deepEqual(JSON.parse(JSON.stringify(infoRead({ namespace: 'linear' }))), {}, 'what it returns is plain JSON');
});

test('STANDARD_NAMES is every name the leaf can return, and nothing else', () => {
  assert.ok(Object.isFrozen(STANDARD_NAMES));
  const returned = new Set(CASES.map(([tool, info]) => standardToolName(tool, info)).filter((name) => name !== null));
  assert.deepEqual([...STANDARD_NAMES].sort(), [...returned].sort());
  assert.equal(new Set(STANDARD_NAMES).size, STANDARD_NAMES.length);
});

test('RAW_NAMES reverses every row with a standard tool and NATIVE_NAMES only the renamed ones, both frozen and with no prototype', () => {
  assert.deepEqual({ ...RAW_NAMES }, { Bash: 'shell', Edit: 'edit', Write: 'write' });
  assert.deepEqual({ ...NATIVE_NAMES }, { Bash: 'shell' });
  for (const map of [RAW_NAMES, NATIVE_NAMES]) {
    assert.ok(Object.isFrozen(map));
    assert.equal(Object.getPrototypeOf(map), null, 'no name of Object.prototype is a mapped tool');
  }
  for (const [standard, raw] of Object.entries(NATIVE_NAMES)) assert.equal(standardToolName(raw), standard);
});

test('the leaf imports node built-ins only, so it loads on its own', () => {
  const specifiers = [...readFileSync(LEAF, 'utf8').matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/gmu)]
    .map((match) => match[1] ?? match[2]);
  for (const specifier of specifiers) assert.match(specifier, /^node:/u, specifier);
  assert.doesNotMatch(readFileSync(LEAF, 'utf8'), /^\s*import\s+['"]/mu, 'no bare side-effect import');
});

test('the adapter reads names through the leaf: a marked shell call is Bash, and an unmarked one is unchanged', () => {
  const marked = { hook_event_name: 'PostToolUse', opencode: { version: '2.4.0' }, tool_name: 'shell', tool_input: { command: 'ls' } };
  assert.deepEqual(opencode.hookInput(marked), { ...marked, tool_name: 'Bash', raw_tool_name: 'shell' });
  const { opencode: _mark, ...unmarked } = marked;
  assert.equal(opencode.hookInput(unmarked), unmarked);
  for (const tool of ['edit', 'read', MCP, 'constructor']) {
    const call = { ...marked, tool_name: tool };
    assert.equal(opencode.hookInput(call), call, tool);
  }
  assert.equal(opencode.hookInput({ ...marked, tool_name: 'shell', opencode: { info: { namespace: 'x' } } }).tool_name, 'Bash');
  assert.deepEqual(['shell', 'edit', MCP, 'mcp__linear__save_issue', 'constructor'].map(opencode.toolName), ['Bash', 'edit', MCP, 'mcp__linear__save_issue', 'constructor']);
});
