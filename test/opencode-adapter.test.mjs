// OpenCode's adapter (lib/hosts/opencode.mjs): the translation layer between the payload the aidrian bridge sends and the
// standard names the hook scripts read. The bridge itself is not here; test/adapters.test.mjs holds every host to the
// conformance suite, and test/host-detect.test.mjs to the registry's two passes.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { nestedProtected as anyHostNested, credentialStores, fileEditOf, HOSTS, nestedGlobs, otherPlaceholders, packagePrograms, protectedFile, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import opencode, { NO_SESSION } from '../plugins/aidrian/lib/hosts/opencode.mjs';
import { readings, unwrapped } from '../plugins/aidrian/lib/package-runner.mjs';

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
    shape: 'edit', file: 'a.md', edits: [{ old_string: 'y', new_string: 'x', replace_all: true }], newText: 'x', replaceAll: true, targets: ['a.md'],
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

test('it declares none of what a later change brings: no check-run reader, instructions, GitHub tools, or opaque shell', () => {
  for (const field of ['shellRun', 'instructionFiles', 'githubTools', 'opaqueShellTools']) assert.equal(opencode[field], undefined, field);
});

// The command lexer's tokens of a command line's arguments; `null` stands for a word built at run time.
const tokens = (...words) => words.map((word) => (word === null ? { text: '$X', dynamic: true } : { text: word, dynamic: false }));
const { starts } = opencode.sessionStart;

test('its host files: the folder and both config files at the root, and the same at any depth of a clone', () => {
  assert.deepEqual(opencode.protectedPaths, ['.opencode', 'opencode.json', 'opencode.jsonc', '.agents']);
  assert.deepEqual(opencode.nestedGlobs, ['**/.opencode', '**/.opencode/**', '**/opencode.json', '**/opencode.jsonc', '**/.agents', '**/.agents/**']);
  assert.deepEqual(nestedGlobs(), opencode.nestedGlobs, 'the union: Claude Code keeps its own globs where they are');
  for (const each of ['pkg/.opencode/plugins/x.js', 'pkg/.OPENCODE/x', 'pkg/opencode.json', 'a/b/opencode.jsonc', 'pkg/.opencode', '.opencode', 'a//OpenCode.JSON',
    'pkg/.agents/skills/x/SKILL.md', 'pkg/.agents/skills/x/run.sh', 'pkg/.AGENTS/x', 'pkg/.agents', '.agents']) {
    assert.equal(opencode.nestedProtected(each.split('/')), true, each);
    assert.equal(anyHostNested(each.split('/')), true, each);
  }
  for (const each of ['pkg/opencode.md', 'pkg/src/opencode.json.ts', 'my-opencode.json', 'pkg/opencode/plugins/x.js', 'src/app.js', '',
    'pkg/agents/x.md', 'pkg/my.agents/x', 'pkg/agents.txt']) {
    assert.equal(opencode.nestedProtected(each.split('/')), false, each);
  }
});

test('its session start: only the info flags and the words and subcommands whose help says they start none are not starts', () => {
  assert.deepEqual(opencode.sessionStart.programs, ['opencode']);
  for (const args of [[], [null], ['run', 'x'], ['serve'], ['mini'], ['acp'], ['api', 'GET', '/x'], ['./src'], ['frobnicate'], ['--standalone'], ['--log-level', 'debug', 'models'],
    ['mcp'], ['session'], ['service'], ['service', 'start'], ['service', 'restart'], ['mcp', 'frob'], ['mcp', null], ['debug', 'nope'], ['auth', 'list'], ['pair']]) {
    assert.equal(starts(tokens(...args)), true, args.join(' '));
  }
  // A command that takes --server talks to the background service, which OpenCode discovers or starts: a start.
  for (const args of [['models'], ['stats'], ['reload'], ['debug', 'agents'], ['debug', 'config'], ['debug', 'heap-dump'], ['mcp', 'list'], ['mcp', 'auth'], ['mcp', 'logout'],
    ['plugin', 'list'], ['plugin', 'check'], ['plugin', 'update'], ['session', 'list'], ['session', 'delete'], ['session', 'export'], ['session', 'import'],
    ['machine', 'list'], ['machine', 'add'], ['machine', 'remove'], ['upgrade'], ['update'], ['uninstall']]) {
    assert.equal(starts(tokens(...args)), true, args.join(' '));
  }
  for (const flag of ['-h', '--help', '-v', '--version', '--completions']) assert.equal(starts(tokens(flag)), false, flag);
  assert.deepEqual(NO_SESSION.map((entry) => entry.join(' ')), ['debug paths', 'mcp add', 'plugin add', 'plugin remove', 'service status', 'service stop', 'service get', 'service set', 'service unset']);
  for (const entry of NO_SESSION) assert.equal(starts(tokens(...entry, 'x')), false, entry.join(' '));
});

test('its packages run as its program, Claude Code\'s too, and a package runner of one is read as that program', () => {
  assert.deepEqual(opencode.packages, { '@opencode/cli': 'opencode', 'opencode-ai': 'opencode' });
  assert.deepEqual(packagePrograms(), { '@anthropic-ai/claude-code': 'claude', '@opencode/cli': 'opencode', 'opencode-ai': 'opencode' });
  for (const [program, words, expected] of [
    ['npx', ['@opencode/cli', 'run', 'x'], ['opencode', ['run', 'x']]], ['npx', ['-y', '@opencode/cli@2.4.0', 'auth', 'login'], ['opencode', ['auth', 'login']]],
    ['pnpm', ['dlx', 'opencode-ai', 'plugin', 'add', 'x'], ['opencode', ['plugin', 'add', 'x']]], ['bunx', ['@anthropic-ai/claude-code', '-p', 'x'], ['claude', ['-p', 'x']]],
    ['npx', ['@changesets/cli', 'publish'], ['changeset', ['publish']]], ['npx', ['prettier', '.'], ['prettier', ['.']]], ['opencode', ['run'], ['opencode', ['run']]],
    // A package of a program no host owns, given as an option's value, is not the program.
    ['npx', ['--package', '@changesets/cli', 'npm', 'publish'], ['npm', ['publish']]],
    ['npm', ['exec', '--package', '@changesets/cli', '--', 'npm', 'publish'], ['npm', ['publish']]],
  ]) {
    const read = unwrapped(program, words);
    assert.deepEqual([read.program, read.args], expected, `${program} ${words.join(' ')}`);
  }
  assert.deepEqual(unwrapped('npx', [null, 'run'], (each) => each), { program: 'npx', args: [null, 'run'] }, 'a package built at run time stays the runner');
  // A host's program a later word or an option's value names is one reading; the program the runner plainly runs is
  // the other, so neither guard loses the real program's checks to a host's name.
  for (const [program, words, expected] of [
    ['npx', ['npm', 'publish', 'opencode'], [['npm', ['publish', 'opencode']], ['opencode', []]]],
    ['npx', ['--package', 'opencode-ai', 'npm', 'publish'], [['npm', ['publish']], ['opencode', ['npm', 'publish']]]],
    ['npm', ['exec', '--', 'gh', 'auth', 'login', 'claude'], [['gh', ['auth', 'login', 'claude']], ['claude', []]]],
    ['npx', ['@opencode/cli', 'run'], [['opencode', ['run']]]], ['npx', ['prettier', '.'], [['prettier', ['.']]]],
  ]) {
    assert.deepEqual(readings(program, words).map((each) => [each.program, each.args]), expected, `${program} ${words.join(' ')}`);
  }
  // A word that names a property every object has is no runner, no package of another name, and no mapped tool.
  for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.deepEqual(unwrapped(name, ['x']), { program: name, args: ['x'] }, `the program ${name}`);
    assert.deepEqual(unwrapped('npx', [name, 'x']), { program: name, args: ['x'] }, `the package ${name}`);
    assert.equal(opencode.nativeToolName(name), name, `the tool ${name}`);
    assert.equal(opencode.rawToolName(name), name, `the raw tool ${name}`);
    assert.equal(codex.rawToolName(name), name, `Codex's raw tool ${name}`);
  }
});

test('its logins and service state: OpenCode\'s data, state, and config folders, and Codex\'s auth.json, under the XDG folders and their defaults', () => {
  const home = '/home/u';
  const under = (...parts) => path.join(home, ...parts);
  assert.deepEqual(opencode.credentialStores({ env: {}, home }), [under('.local/share/opencode'), under('.local/state/opencode'), under('.config/opencode')]);
  const env = { XDG_DATA_HOME: '/x/data', XDG_STATE_HOME: '/x/state', XDG_CONFIG_HOME: '/x/config', OPENCODE_CONFIG_DIR: '/x/oc', CODEX_HOME: '/x/codex' };
  assert.deepEqual(opencode.credentialStores({ env, home }), [
    '/x/data/opencode', under('.local/share/opencode'), '/x/state/opencode', under('.local/state/opencode'), '/x/config/opencode', under('.config/opencode'), '/x/oc',
  ]);
  assert.deepEqual(opencode.credentialStores({ env: { XDG_DATA_HOME: 'relative' }, home })[0], under('.local/share/opencode'), 'a relative XDG folder is not read');
  assert.deepEqual(codex.credentialStores({ env, home }), ['/x/codex/auth.json', under('.codex/auth.json')]);
  assert.deepEqual(credentialStores({ env, home }), [...codex.credentialStores({ env, home }), ...opencode.credentialStores({ env, home })], 'the union, Claude Code declaring none of its own here');
});

test('its lists hold their shape: no entry of more than two words, and no lone word that is also a config command', () => {
  const config = opencode.configCommands;
  assert.deepEqual(config.programs, ['opencode']);
  for (const entry of NO_SESSION) {
    assert.ok(entry.length >= 1 && entry.length <= 2, entry.join(' '));
    if (entry.length === 1) assert.ok(!config.subcommands.some((each) => each[0] === entry[0]), `${entry[0]} alone is also a config command`);
  }
  const first = [['mcp', 'add'], ['mcp', 'auth'], ['mcp', 'logout'], ['auth', 'login'], ['auth', 'logout'], ['auth', 'import'], ['auth', 'switch'], ['plugin', 'add'], ['plugin', 'remove'], ['plugin', 'update'], ['service', 'set'], ['service', 'unset']];
  assert.deepEqual(config.subcommands.slice(0, first.length), first, 'the first draft\'s twelve, whatever the reading showed');
  assert.deepEqual(config.subcommands.slice(first.length), [['machine', 'add'], ['machine', 'remove'], ['pair'], ['auth'], ['session', 'import'], ['session', 'delete'], ['uninstall'], ['upgrade'], ['update'], ['service', 'stop']],
    'pairings, auth whole as auth export\'s help was not read, the session store, the program itself, and the shared service');
  assert.deepEqual(config.valueOptions, ['--server', '--log-level', '--completions', '--session', '-s', '--prompt']);
  assert.ok(!NO_SESSION.some((entry) => entry[0] === 'auth'), 'a word not read in full has no entry');
});

test('the other hosts\' placeholders: a folder, or a file holding {}, for each root host file the starting host does not protect', () => {
  assert.deepEqual(otherPlaceholders(claudeCode), [{ path: '.opencode', folder: true }, { path: 'opencode.json', text: '{}\n' }, { path: 'opencode.jsonc', text: '{}\n' }, { path: '.agents', folder: true }]);
  const one = { protectedPaths: ['x/skills', 'x.json'] };
  const own = { protectedPaths: ['x.json'] };
  assert.deepEqual(otherPlaceholders(own, [one, own]), [{ path: 'x/skills', folder: true }]);
  const forOpenCode = otherPlaceholders(opencode);
  for (const each of opencode.protectedPaths) assert.ok(!forOpenCode.some((placeholder) => placeholder.path === each), each);
  assert.ok(forOpenCode.some((each) => each.path === '.claude/scheduled_tasks.json'), 'the residual the plan names for a second confined host');
  assert.deepEqual(['.mcp.json', 'opencode.jsonc', 'x.JSON', '.opencode', '.claude/skills'].map(protectedFile), [true, true, false, false, false]);
  // Shared code names no OpenCode file: the placeholders and the write guard read them from the adapters.
  for (const file of ['project-run-gate.mjs', 'project-start.mjs', 'unattended-write.mjs', 'unattended-shell.mjs', 'package-runner.mjs', 'handoff-guard.mjs']) {
    assert.doesNotMatch(readFileSync(path.join(import.meta.dirname, '../plugins/aidrian/lib', file), 'utf8'), /opencode/iu, file);
  }
  const guard = readFileSync(path.join(import.meta.dirname, '../plugins/aidrian/lib/unattended-write.mjs'), 'utf8');
  assert.match(guard, /!protectedFile\(each\)/u, 'hostRefused types a name as otherPlaceholders does');
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

test('it reads each folder above the project root up to the top, the folders above home too, as OpenCode does', (t) => {
  const { root } = places(t);
  const home = path.join(root, 'home');
  const project = path.join(home, 'code', 'team', 'app');
  mkdirSync(project, { recursive: true });
  const env = { HOME: home, OPENCODE_CONFIG_DIR: path.join(root, 'none') };
  const named = JSON.stringify({ plugins: [GIT] });
  for (const file of [path.join(home, 'code', 'opencode.json'), path.join(home, 'code', 'team', '.opencode', 'opencode.jsonc'), path.join(home, 'opencode.json'), path.join(home, '.opencode', 'opencode.json')]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, named);
    assert.equal(setUp({ env, root: project }), true, file);
    rmSync(file);
  }
  for (const file of [path.join(root, 'opencode.json'), path.join(root, '.opencode', 'opencode.jsonc')]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, named);
    assert.equal(setUp({ env, root: project }), true, `a folder above home, for a project under it: ${file}`);
    assert.equal(setUp({ env, root: home }), true, `a folder above home, for home itself as the root: ${file}`);
    assert.equal(setUp({ env: { ...env, HOME: path.join(root, 'elsewhere') }, root: project }), true, `a root not under home: ${file}`);
    rmSync(file);
  }
  assert.equal(setUp({ env, root: project }), false, 'no config on the way up');
  // At most 64 folders, the root among them; a folder that is not there reads as no config.
  writeFileSync(path.join(root, 'opencode.json'), named);
  const deep = (depth) => path.join(root, ...Array.from({ length: depth }, () => 'd'));
  assert.equal(setUp({ env, root: deep(63) }), true, 'the 64th folder up');
  assert.equal(setUp({ env, root: deep(64) }), false, 'the 65th folder up');
});

test('it reads the config file OPENCODE_CONFIG names, by an absolute path only', (t) => {
  const { root, project, env } = places(t);
  const file = path.join(root, 'shared.jsonc');
  assert.equal(setUp({ env: { ...env, OPENCODE_CONFIG: file }, root: project }), false, 'a file that is not there');
  writeFileSync(file, `{ "plugin": ["${GIT}"], }`);
  assert.equal(setUp({ env: { ...env, OPENCODE_CONFIG: file }, root: project }), true);
  assert.equal(setUp({ env: { ...env, OPENCODE_CONFIG: file } }), true, 'with no project root too');
  assert.equal(setUp({ env: { ...env, OPENCODE_CONFIG: 'shared.jsonc' }, root: project }), false, 'a relative path');
  assert.equal(setUp({ env, root: project }), false, 'unset');
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
