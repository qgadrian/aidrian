// OpenCode's adapter (lib/hosts/opencode.mjs): the translation layer between the payload the aidrian bridge sends and the
// standard names the hook scripts read. The bridge itself is not here; test/adapters.test.mjs holds every host to the
// conformance suite, and test/host-detect.test.mjs to the registry's two passes.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fileEditOf, HOSTS, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import opencode from '../plugins/aidrian/lib/hosts/opencode.mjs';

const MARK = { version: '2.4.0' };
const SHELL = { hook_event_name: 'PostToolUse', opencode: MARK, session_id: 'ses_a', cwd: '/x', tool_name: 'shell', tool_input: { command: 'gh pr view 3' }, tool_use_id: 'call_1' };
const PATCH = '*** Begin Patch\n*** Add File: docs/new.md\n+one\n*** Update File: a.md\n*** Move to: b.md\n+two\n*** Delete File: c.md\n*** End Patch\n';

test('OpenCode is registered last, with the bridge delivery', () => {
  assert.equal(HOSTS.at(-1), opencode);
  assert.deepEqual([opencode.id, opencode.name, opencode.ai, opencode.delivery, opencode.modelsKey], ['opencode', 'OpenCode', 'OpenCode', 'bridge', 'opencode']);
  assert.deepEqual(opencode.modelChoices, { model: null, effort: null });
  assert.deepEqual(opencode.modelPrices, { models: [], rows: [] });
  assert.deepEqual(opencode.identityVars, ['OPENCODE_SESSION_ID']);
  assert.deepEqual(opencode.detectVars, ['OPENCODE', 'OPENCODE_SESSION_ID']);
  assert.deepEqual(opencode.projectFolders, {});
  assert.deepEqual(opencode.mainCheckoutPaths, { folders: [], settings: [] });
});

test('the payload mark is an object under the top-level key opencode, and nothing else', () => {
  for (const input of [{ opencode: {} }, { opencode: MARK }, SHELL]) assert.equal(opencode.payloadMark(input), true, JSON.stringify(input));
  const unmarked = [undefined, null, {}, { opencode: null }, { opencode: [] }, { opencode: '2.4.0' }, { opencode: 1 }, { opencode: true }, { tool_input: { opencode: {} } }, { ...SHELL, opencode: undefined }];
  for (const input of unmarked) assert.equal(opencode.payloadMark(input), false, JSON.stringify(input));
});

test('its environment rule needs both of its variables, and a marked payload is OpenCode\'s alone', () => {
  assert.equal(opencode.detect({ env: { OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_a' }, input: {} }), true);
  for (const env of [{ OPENCODE: '1' }, { OPENCODE_SESSION_ID: 'ses_a' }, { OPENCODE: '0', OPENCODE_SESSION_ID: 'ses_a' }, { OPENCODE: '1', OPENCODE_SESSION_ID: '' }]) {
    assert.equal(opencode.detect({ env, input: {} }), false, JSON.stringify(env));
  }
  assert.equal(opencode.detect({ env: {}, input: { opencode: {} } }), true);
  assert.equal(opencode.detect({ env: { CLAUDECODE: '1', CODEX_THREAD_ID: 't' }, input: {} }), false, 'it names no other host\'s variable');
  for (const input of [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, { hook_event_name: 'PostToolUse', tool_name: 'shell' }]) {
    assert.equal(opencode.detect({ env: { OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_a' }, input }), false, `an unmarked hook payload: ${input.hook_event_name}`);
  }
});

test('the session comes from OPENCODE_SESSION_ID, and nothing else of a session is told', () => {
  assert.equal(opencode.sessionId({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_df7be4557ffeQDs22tHr3NYxUx' }), 'ses_df7be4557ffeQDs22tHr3NYxUx');
  assert.equal(opencode.sessionId({ OPENCODE: '1' }), null);
  for (const read of [opencode.agentName, opencode.effort, opencode.runEnv]) assert.equal(read({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_a' }), null);
});

test('a marked shell call reads as the standard Bash, with its own name kept', () => {
  assert.deepEqual(opencode.hookInput(SHELL), { ...SHELL, tool_name: 'Bash', raw_tool_name: 'shell' });
  assert.deepEqual(UNKNOWN_HOST.hookInput(SHELL), { ...SHELL, tool_name: 'Bash', raw_tool_name: 'shell' }, 'a payload no host claims is read the same way');
  for (const tool of ['edit', 'write', 'patch', 'read', 'mcp__linear__save_issue']) {
    const call = { ...SHELL, tool_name: tool };
    assert.equal(opencode.hookInput(call), call, `${tool} is not mapped`);
  }
});

test('a shell call without the mark keeps its name on every host and on none', () => {
  const { opencode: _mark, ...unmarked } = SHELL;
  for (const host of [...HOSTS, UNKNOWN_HOST]) assert.deepEqual(host.hookInput(unmarked), unmarked, host.id);
  assert.deepEqual(opencode.hookInput({}), {});
});

test('its tool names: the shell tool and the file tools as OpenCode sends them, and every other name as it is', () => {
  assert.deepEqual(['Bash', 'Edit', 'Write', 'NotebookEdit', 'mcp__linear__save_issue'].map(opencode.rawToolName), ['shell', 'edit', 'write', 'NotebookEdit', 'mcp__linear__save_issue']);
  assert.deepEqual(['Bash', 'Edit', 'AskUserQuestion'].map(opencode.nativeToolName), ['shell', 'Edit', 'AskUserQuestion']);
  assert.equal(opencode.toolName('mcp__linear__save_issue'), 'mcp__linear__save_issue');
  assert.equal(opencode.serverSpelling('linear-server'), 'linear-server');
  assert.deepEqual(opencode.agentAliases('aidrian-explorer'), ['explorer']);
  assert.equal(opencode.pluginAgentPrefix, 'aidrian-');
});

test('a shell call\'s output is the text under output.output, completed or backgrounded, and nothing else', () => {
  const completed = { output: { output: 'https://github.com/acme/widgets/pull/12\n', exitCode: 0 }, content: [], metadata: { status: 'completed' } };
  assert.deepEqual(opencode.shellOutput(completed), { output: 'https://github.com/acme/widgets/pull/12\n', interrupted: false });
  const backgrounded = { output: { output: 'started in the background\n' }, metadata: { status: 'running' } };
  assert.deepEqual(opencode.shellOutput(backgrounded), { output: 'started in the background\n', interrupted: false });
  for (const response of [null, undefined, 'text', 7, [], {}, { output: 'text' }, { output: null }, { output: { output: 7 } }, { stdout: 'text' }]) {
    assert.deepEqual(opencode.shellOutput(response), { output: null, interrupted: false }, JSON.stringify(response));
  }
  assert.deepEqual(UNKNOWN_HOST.shellOutput(completed), { output: 'https://github.com/acme/widgets/pull/12\n', interrupted: false }, 'a host no adapter claims reads it too');
});

test('a tool response is read as the shared shapes', () => {
  assert.deepEqual(opencode.toolResponse({ url: 'x' }), [{ url: 'x' }]);
  assert.deepEqual(opencode.toolResponse({ content: [{ type: 'text', text: '{"url":"y"}' }] }), [{ content: [{ type: 'text', text: '{"url":"y"}' }] }, { url: 'y' }]);
  assert.deepEqual(opencode.toolResponse('not json'), []);
});

// The input fields come from the tool schemas embedded in the installed OpenCode 2.4.0 binary, read as text (edit: path,
// oldString, newString, replaceAll; write: path, content; patch: patchText), not from a recorded live payload.
test('its file tools say the shape of each edit, as the schemas in the 2.4.0 binary name their fields, not yet a live payload', () => {
  assert.deepEqual(opencode.fileEditTools, ['edit', 'write', 'patch']);
  assert.deepEqual(opencode.fileEdit('write', { path: 'a.md', content: 'x' }), { shape: 'write', file: 'a.md', content: 'x', targets: ['a.md'] });
  assert.deepEqual(opencode.fileEdit('edit', { path: 'a.md', oldString: 'y', newString: 'x', replaceAll: true }), {
    shape: 'edit', file: 'a.md', edits: [{ old_string: 'y', new_string: 'x' }], newText: 'x', replaceAll: true, targets: ['a.md'],
  });
  assert.equal(opencode.fileEdit('edit', { path: 'a.md', oldString: 'y', newString: 'x', replaceAll: 'yes' }).replaceAll, false, 'only true replaces all');
  assert.deepEqual(opencode.fileEdit('patch', { patchText: PATCH }), {
    shape: 'patch',
    text: PATCH,
    files: [{ file: 'docs/new.md', added: ['one'] }, { file: 'b.md', added: ['two'] }],
    targets: ['docs/new.md', 'a.md', 'b.md', 'c.md'],
  });
  assert.deepEqual(opencode.fileEdit('patch', {}), { shape: 'patch', text: '', files: [], targets: [] });
});

test('the registry finds its file edits by its tool names', () => {
  assert.deepEqual(fileEditOf({ tool_name: 'patch', tool_input: { patchText: PATCH } }).targets, ['docs/new.md', 'a.md', 'b.md', 'c.md']);
  assert.equal(fileEditOf({ tool_name: 'write', tool_input: { path: 'a.md', content: 'x' } }).file, 'a.md');
});

test('its capabilities: no transcripts, no handoff route, a push it cannot judge, and a tracker guard that holds no write', () => {
  const { capabilities } = opencode;
  assert.equal(capabilities.transcripts, false);
  assert.deepEqual(capabilities.handoffContinue, { routes: [] });
  assert.deepEqual(capabilities.pushPermission(), { answer: 'unknown' });
  assert.equal(capabilities.trackerGuard.verified, 'none');
  assert.match(capabilities.trackerGuard.evidence, /forwards no MCP tool call/u);
  assert.deepEqual(capabilities.trackerGuard.unguardedRoutes, [{ name: 'any MCP tool', reason: 'the bridge forwards no MCP tool call to a hook in this version' }]);
});

test('it declares none of what a later change brings: no check-run reader, session start, host files, or instructions', () => {
  for (const field of ['shellRun', 'sessionStart', 'configCommands', 'protectedPaths', 'nestedProtected', 'nestedGlobs', 'instructionFiles', 'githubTools', 'opaqueShellTools']) {
    assert.equal(opencode[field], undefined, field);
  }
});

// Whether OpenCode is set up to run this plugin here, from its config files alone (capabilities.setUp): `aidrian check`
// reads it, so its warnings do not hang on which shell runs the check.
function places(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const project = path.join(root, 'project');
  mkdirSync(config);
  mkdirSync(path.join(project, '.opencode'), { recursive: true });
  return { root, config, project, env: { OPENCODE_CONFIG_DIR: config } };
}
const setUp = (ask) => opencode.capabilities.setUp(ask);
const GIT = 'github:acme/aidrian#main::path:plugins/aidrian';

test('OpenCode is set up here when its global config names this plugin, in each form it installs from', (t) => {
  const { config, project, env } = places(t);
  const file = path.join(config, 'opencode.json');
  assert.equal(setUp({ env, root: project }), false, 'no config at all');
  const named = [GIT, 'git+ssh://git@github.com/acme/aidrian.git#v1.0.0::path:plugins/aidrian', '/srv/harness/plugins/aidrian/', 'aidrian', 'aidrian@0.85.0', { package: GIT, options: {} }];
  for (const entry of named) {
    writeFileSync(file, JSON.stringify({ plugins: ['oh-my-opencode@latest', entry] }));
    assert.equal(setUp({ env, root: project }), true, JSON.stringify(entry));
  }
  writeFileSync(file, JSON.stringify({ plugin: [GIT] }));
  assert.equal(setUp({ env, root: project }), true, 'the singular key too');
  for (const entry of ['oh-my-opencode@latest', 'aidrian-extra', 'github:acme/aidrian', '/x/plugins/aidrian-old', { options: {} }, 7, null]) {
    writeFileSync(file, JSON.stringify({ plugins: [entry] }));
    assert.equal(setUp({ env, root: project }), false, JSON.stringify(entry));
  }
  writeFileSync(file, JSON.stringify({ model: 'aidrian', plugins: 'aidrian' }));
  assert.equal(setUp({ env, root: project }), false, 'the name outside a plugin list');
});

test('it reads JSONC with comments and trailing commas, in the global folder, the project root, and its .opencode folder', (t) => {
  const { config, project, env } = places(t);
  const text = `{\n  // the plugins\n  "plugins": [\n    /* this one */ "${GIT}",\n  ],\n}\n`;
  const files = [path.join(config, 'opencode.jsonc'), path.join(project, 'opencode.json'), path.join(project, 'opencode.jsonc'), path.join(project, '.opencode', 'opencode.json'), path.join(project, '.opencode', 'opencode.jsonc')];
  for (const file of files) {
    writeFileSync(file, text);
    assert.equal(setUp({ env, root: project }), true, file);
    rmSync(file);
  }
  const file = path.join(project, 'opencode.jsonc');
  writeFileSync(file, '{ "plugins": [ // "aidrian"\n ] }');
  assert.equal(setUp({ env, root: project }), false, 'a name in a comment');
  writeFileSync(file, '{ "plugins": ["a//b", "x/*y", "plugins/aidrian", "q\\",]"] }');
  assert.equal(setUp({ env, root: project }), true, 'comment marks and a bracket inside strings');
  assert.equal(setUp({ env }), false, 'with no project root, only the global folder counts');
});

test('the global folder is OPENCODE_CONFIG_DIR, else opencode under XDG_CONFIG_HOME, else under ~/.config', (t) => {
  const { root } = places(t);
  const home = path.join(root, 'home');
  const xdg = path.join(root, 'xdg');
  for (const folder of [path.join(home, '.config/opencode'), path.join(xdg, 'opencode')]) mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(home, '.config/opencode/opencode.json'), JSON.stringify({ plugins: [GIT] }));
  assert.equal(setUp({ env: { HOME: home } }), true, '~/.config/opencode');
  assert.equal(setUp({ env: { HOME: home, XDG_CONFIG_HOME: xdg } }), false, 'XDG_CONFIG_HOME wins over ~/.config');
  assert.equal(setUp({ env: { HOME: home, XDG_CONFIG_HOME: 'relative' } }), true, 'a relative XDG_CONFIG_HOME is no folder');
  writeFileSync(path.join(xdg, 'opencode/opencode.jsonc'), JSON.stringify({ plugins: [GIT] }));
  assert.equal(setUp({ env: { HOME: home, XDG_CONFIG_HOME: xdg } }), true);
  assert.equal(setUp({ env: { HOME: home, XDG_CONFIG_HOME: xdg, OPENCODE_CONFIG_DIR: path.join(root, 'none') } }), false, 'OPENCODE_CONFIG_DIR wins');
});

test('a config it cannot read or parse counts as no setup, and the probe never throws or waits', (t) => {
  const { config, project, env } = places(t);
  const file = path.join(project, 'opencode.json');
  for (const text of ['{', '{ "plugins": [', '/* open', `{ "plugins": ["${GIT}" }`, 'null', '[]', `"${GIT}"`, '\u0000', '']) {
    writeFileSync(file, text);
    assert.equal(setUp({ env, root: project }), false, JSON.stringify(text));
  }
  rmSync(file);
  mkdirSync(path.join(config, 'opencode.json'));
  assert.equal(setUp({ env, root: project }), false, 'a folder in the file\'s place');
  if (process.platform !== 'win32') {
    assert.equal(spawnSync('mkfifo', [path.join(project, 'opencode.jsonc')]).status, 0);
    assert.equal(setUp({ env, root: project }), false, 'a named pipe is never read');
  }
  for (const ask of [undefined, {}, { env: {}, root: 7 }, { env: { OPENCODE_CONFIG_DIR: 7, HOME: 7 } }]) assert.equal(typeof setUp(ask), 'boolean', JSON.stringify(ask));
});

test('a config over 1 MiB is not read, so it counts as no setup, and one of exactly 1 MiB is', (t) => {
  const { project, env } = places(t);
  const file = path.join(project, 'opencode.json');
  const text = JSON.stringify({ plugins: [GIT] });
  const padded = (bytes) => `${text}${' '.repeat(bytes - Buffer.byteLength(text))}`;
  writeFileSync(file, padded(1024 * 1024));
  assert.equal(setUp({ env, root: project }), true, 'exactly 1 MiB');
  writeFileSync(file, padded(1024 * 1024 + 1));
  assert.equal(setUp({ env, root: project }), false, 'one byte over');
});
