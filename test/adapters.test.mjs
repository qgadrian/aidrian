// The conformance suite of lib/hosts/ and lib/trackers/: it iterates the registries, so a new adapter is checked by
// adding it, and a fixture adapter that is never shipped proves a new host or tracker needs nothing in shared code.
// A shipped host whose hooks reach the tracker guard also needs its recorded payloads in test/fixtures/hosts/<id>/tracker.json;
// a bridge host delivers only the hooks its routes name (bridgeRoutes).

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { gateDenial, nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { GUARDED_PATHS } from '../plugins/aidrian/lib/project.mjs';
import { CONTINUE_ROUTES } from '../plugins/aidrian/lib/config-schema.mjs';
import { canBlock } from '../plugins/aidrian/lib/hook-result.mjs';
import { mergePermission as claudeMergePermission } from '../plugins/aidrian/lib/hosts/claude-code-merge.mjs';
import { pushPermission as claudePushPermission } from '../plugins/aidrian/lib/hosts/claude-code-push.mjs';
import { heldSessions, listBackground } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';
import { agentAliases, backgroundHeld, backgroundList, continueRoutes, deniedNames, detectHost, fileEditOf, fileReadOf, HOSTS, humanPrompts, MERGE_ANSWERS, mergePermission, normalizeHookInput, opaqueShellCommand, PUSH_ANSWERS, pushPermission, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import { trackerWarnings, unwatchedLine } from '../plugins/aidrian/lib/tracker-check.mjs';
import { judgeTrackerWrite, readTrackerValue, serverPrefix, unlistedTool } from '../plugins/aidrian/lib/tracker-guard.mjs';
import { expandTracker, knownServers, readToolsOf, TRACKERS, writeToolsOf } from '../plugins/aidrian/lib/trackers/index.mjs';
import fakeHost from './fixtures/adapters/fake-host.mjs';
import fakePerCall from './fixtures/adapters/fake-per-call-tracker.mjs';
import fakeTracker from './fixtures/adapters/fake-tracker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOKS = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/hooks/hooks.json'), 'utf8')).hooks;
const STANDARD_MCP = /^mcp__[^_].*?__.+$/u;
const SHAPES = new Set(['write', 'edit', 'notebook', 'patch']);
const VERIFIED = new Set(['live', 'source', 'none']);

const recorded = (host) => JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/hosts', host.id, 'tracker.json'), 'utf8'));

const DELIVERIES = new Set(['hooks-json', 'installer', 'bridge']);
const script = (event, name) => HOOKS[event].find((group) => group.hooks.some(({ command }) => command.includes(name)));
// How each hooks-json host reads a hooks.json matcher: "*", empty, or none fires on every tool; one made only of the
// `list` characters is exact names split on `separator`; any other is a regular expression that may match anywhere in
// the name. Claude Code: code.claude.com/docs/en/hooks, Matcher patterns. Codex: HookMatcher in
// codex-rs/hooks/src/engine/matcher.rs (openai/codex bd4204ef), whose list takes no `-`, space, or comma.
const MATCHER_READINGS = {
  'claude-code': { list: /^[A-Za-z0-9_ ,|-]+$/u, separator: /\s*[|,]\s*/u },
  codex: { list: /^[A-Za-z0-9_|]+$/u, separator: '|' },
  [fakeHost.id]: { list: /^[A-Za-z0-9_ ,|-]+$/u, separator: /\s*[|,]\s*/u },
};
// Whether the hooks.json matcher `matcher` fires on the tool `name` on the host `hostId`, as that host reads it.
const fires = (hostId, matcher, name) => {
  const reading = MATCHER_READINGS[hostId];
  if (reading === undefined) throw new Error(`no matcher reading for host ${hostId}; add it to MATCHER_READINGS`);
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (reading.list.test(matcher)) return matcher.split(reading.separator).includes(name);
  return new RegExp(matcher, 'u').test(name);
};

// The routes a bridge host's plugin runs: of its generated routes, plugins/aidrian/<id>/routes.generated.json, each
// { event, matcher, script, args, timeoutMs }, those whose event its plugins/aidrian/<id>/routes.mjs EVENTS maps to a
// hook of the host and whose matcher fires on a name its leaf, lib/hosts/<id>-names.mjs, can return: its built-in
// names (STANDARD_NAMES), and an MCP tool's, mcp__server__tool, when the leaf maps MCP tools (it exports mcpToolName).
// A route with no matcher is a session event's, which names no tool, so its event alone says it runs.
// Null for a host that reads hooks.json as it is, and for a bridge host that lacks one of the three, which
// routeTableProblems fails.
const routeFires = (matcher, name) => matcher === '*' || (typeof matcher === 'string' && new RegExp(matcher, 'u').test(name));
async function bridgeRoutes(host) {
  if (host.delivery !== 'bridge') return null;
  const dir = path.join(ROOT, 'plugins/aidrian', host.id);
  const [events, generated, leaf] = [path.join(dir, 'routes.mjs'), path.join(dir, 'routes.generated.json'), path.join(ROOT, 'plugins/aidrian/lib/hosts', `${host.id}-names.mjs`)];
  if (![events, generated, leaf].every((file) => existsSync(file))) return null;
  const { EVENTS } = await import(pathToFileURL(events).href);
  const { STANDARD_NAMES, mcpToolName } = await import(pathToFileURL(leaf).href);
  const routes = JSON.parse(readFileSync(generated, 'utf8'));
  if (typeof EVENTS !== 'object' || EVENTS === null || !Array.isArray(STANDARD_NAMES) || !Array.isArray(routes)) return null;
  const names = [...STANDARD_NAMES, ...(typeof mcpToolName === 'function' ? ['mcp__server__tool'] : [])];
  return routes.filter((route) => Object.hasOwn(EVENTS, route.event) && (route.matcher === null || names.some((name) => routeFires(route.matcher, name))));
}
const ROUTES = new Map(await Promise.all([...HOSTS, fakeHost].map(async (host) => [host.id, await bridgeRoutes(host)])));

// Whether the hook script `name` runs on `host`: every hook does on a hooks-json host, and on a bridge host the ones a route names.
const delivers = (host, name) => host.delivery === 'hooks-json' || (ROUTES.get(host.id) ?? []).some((route) => route.script === name);

// What a bridge host's routes lack: its event map, generated route list, or names leaf, or a route among them. A bridge
// that routes no hook runs nothing on its host, so it is no delivery.
function routeTableProblems(routes) {
  if (routes === null || routes === undefined) return ['it lacks routes.mjs EVENTS, routes.generated.json, or a names leaf with STANDARD_NAMES'];
  if (!Array.isArray(routes)) return ['its routes are not a list'];
  return routes.length > 0 ? [] : ['no generated route of its events fires on a name its leaf returns'];
}

// What a bridge's routes break. scripts/build.mjs writes each route from its hooks.json entry, with its matcher and
// timeout, and `--check` fails a stale list, so what is left is what the build does not hold: no route of an event a
// hook can block on (lib/hook-result.mjs canBlock), until a live session records its hook refusing a call; and its
// script is a file in scripts/, since the bridge cannot run one that is not.
function routeProblems(routes) {
  return routes.flatMap((route) => [
    ...(canBlock(route.event) ? [`${route.script} runs under ${route.event}, and the bridge runs no blocking route`] : []),
    ...(existsSync(path.join(ROOT, 'plugins/aidrian/scripts', route.script)) ? [] : [`${route.script} is not in scripts/`]),
  ]);
}

// Why a host that delivers no tracker hook fails to say so: its tracker guard must be verified `none`, with the routes
// left unguarded named, so no host skips the recorded tracker payloads in silence.
function unguardedTrackerProblems(host) {
  const guard = host.capabilities?.trackerGuard ?? {};
  return [
    ...(guard.verified === 'none' ? [] : [`its tracker guard is verified ${guard.verified}, not none`]),
    ...((guard.unguardedRoutes ?? []).length > 0 ? [] : ['it names no unguarded route']),
  ];
}

// What a host's raw names fail to fire. A hooks-json host's matchers run on the raw name, before any mapping reaches a hook, so a
// name that misses one means that hook never runs and the guard fails open with no word.
function matcherProblems(host) {
  const raw = (standard) => host.rawToolName(standard);
  const samples = [
    ['PreToolUse', 'hook-bash.mjs', raw('Bash')],
    ['PreToolUse', 'hook-write.mjs', raw('Edit')],
    ['PreToolUse', 'hook-write.mjs', raw('Write')],
    ...host.fileEditTools.map((tool) => ['PreToolUse', 'hook-write.mjs', tool]),
    ['PreToolUse', 'hook-tracker-pre.mjs', raw('mcp__linear__save_issue')],
    ['PostToolUse', 'hook-tracker-post.mjs', raw('mcp__linear__get_workspace')],
    ['PreToolUse', 'hook-agent-gates.mjs', raw('Bash')],
    ['PreToolUse', 'hook-agent-gates.mjs', raw('mcp__linear__save_issue')],
    ['PreToolUse', 'hook-mcp-github.mjs', raw('mcp__github__merge_pull_request')],
    ...Object.keys(host.githubTools ?? {}).map((standard) => ['PreToolUse', 'hook-mcp-github.mjs', raw(standard)]),
  ];
  return samples.filter(([event, name, tool]) => !fires(host.id, script(event, name).matcher, tool)).map(([event, name, tool]) => `${event} ${name} misses ${tool}`);
}

for (const host of [...HOSTS, fakeHost]) {
  test(`host ${host.id} declares every field of an adapter`, () => {
    for (const field of ['id', 'name', 'ai', 'modelsKey', 'pluginAgentPrefix']) assert.ok(typeof host[field] === 'string' && host[field] !== '', field);
    assert.notEqual(host.id, UNKNOWN_HOST.id);
    for (const field of ['detect', 'sessionId', 'agentName', 'effort', 'runEnv', 'agentAliases', 'toolName', 'serverSpelling', 'nativeToolName', 'rawToolName', 'toolResponse', 'hookInput', 'fileEdit']) {
      assert.equal(typeof host[field], 'function', field);
    }
    for (const field of ['identityVars', 'detectVars', 'fileEditTools']) assert.ok(Array.isArray(host[field]) && host[field].every((each) => typeof each === 'string'), field);
    assert.ok(host.fileEditTools.length > 0);
    assert.equal(typeof host.capabilities.transcripts, 'boolean');
    const { foregroundLimit, waitCall, taskOutput } = host.capabilities;
    if (foregroundLimit !== undefined || taskOutput !== undefined) assert.ok(0 < waitCall.seconds && waitCall.seconds < waitCall.toolTimeout, 'a wait call ends before its own tool timeout');
    if (foregroundLimit !== undefined) assert.ok(waitCall.toolTimeout < foregroundLimit, 'and before the host moves it');
    if (taskOutput !== undefined) assert.ok(taskOutput.taskTypes.length > 0 && [taskOutput.find, taskOutput.read].every((each) => typeof each === 'function'), 'taskOutput');
    assert.ok(DELIVERIES.has(host.delivery), `delivery names one of the three cases: ${host.delivery}`);
    assert.ok(typeof host.projectFolders === 'object' && host.projectFolders !== null);
    assert.ok(typeof host.modelChoices === 'object' && host.modelChoices !== null);
  });

  test(`host ${host.id} claims no process that does not name it`, () => {
    assert.equal(host.detect({ env: {}, input: {} }), false);
    assert.equal(host.detect({ env: { PATH: '/bin', HOME: '/home/x' }, input: { session_id: 's', tool_name: 'Bash', cwd: '/x' } }), false);
  });

  test(`host ${host.id} tells nothing of a session from an empty environment`, () => {
    for (const read of [host.sessionId, host.agentName, host.effort, host.runEnv]) assert.equal(read({}), null);
  });

  test(`host ${host.id} leaves a standard tool name and payload as they are`, () => {
    for (const name of ['Bash', 'mcp__linear__save_issue', 'mcp__plugin_a_b__get__thing']) assert.equal(host.toolName(name), name);
    const standard = { session_id: 's', tool_name: 'mcp__linear__save_issue', tool_input: { team: 'x' }, cwd: '/x' };
    assert.deepEqual(host.hookInput(standard), standard);
    assert.deepEqual(host.hookInput({}), {});
  });

  test(`host ${host.id} says every shape its file edit tools take`, () => {
    for (const tool of host.fileEditTools) {
      const edit = host.fileEdit(tool, { file_path: 'a.md', path: 'a.md', content: 'x', body: 'x', new_string: 'x', old_string: 'y', newString: 'x', oldString: 'y', command: '*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch\n', patchText: '*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch\n' });
      assert.ok(SHAPES.has(edit.shape), `${tool}: ${edit.shape}`);
      assert.ok(Array.isArray(edit.targets) && edit.targets.includes('a.md'), `${tool} targets`);
    }
  });

  test(`host ${host.id} says where the tracker guard stands, with its evidence`, () => {
    const guard = host.capabilities.trackerGuard;
    assert.ok(VERIFIED.has(guard.verified), guard.verified);
    assert.ok(typeof guard.evidence === 'string' && guard.evidence !== '');
    assert.ok(Array.isArray(guard.unguardedRoutes));
    for (const route of guard.unguardedRoutes) assert.ok(route.name && route.reason);
    if (guard.hookTrust) assert.ok(typeof guard.trustStep === 'string' && guard.trustStep !== '', 'a host whose hooks wait on trust says the step');
  });

  test(`host ${host.id} undoes its raw name for an MCP tool`, () => {
    for (const standard of ['mcp__linear__save_issue', 'mcp__linear_server__save_issue']) {
      assert.equal(host.toolName(host.rawToolName(standard)), standard);
    }
  });

  test(`host ${host.id}'s spelling of a server is itself a spelling that stays, so a second pass changes nothing`, () => {
    const once = host.serverSpelling('acme-linear');
    assert.equal(host.serverSpelling(once), once);
  });
}

test('a process no adapter claims reads a shell call`s response through every adapter`s shellOutput', () => {
  assert.deepEqual(UNKNOWN_HOST.shellOutput({ stdout: 'out', stderr: '', interrupted: false }), { output: 'out', interrupted: false });
  assert.deepEqual(UNKNOWN_HOST.shellOutput('combined output'), { output: 'combined output', interrupted: false });
  assert.deepEqual(UNKNOWN_HOST.shellOutput({ stdout: '', interrupted: true }), { output: '', interrupted: true });
  for (const response of [null, undefined, 7, [], { stdout: 7 }]) assert.deepEqual(UNKNOWN_HOST.shellOutput(response), { output: null, interrupted: false }, JSON.stringify(response));
  for (const host of HOSTS) {
    const read = host.shellOutput(null);
    assert.deepEqual(Object.keys(read).sort(), ['interrupted', 'output'], host.id);
    assert.equal(read.output, null, host.id);
  }
});

for (const host of HOSTS.filter((each) => delivers(each, 'hook-tracker-pre.mjs'))) {
  test(`host ${host.id} has recorded payloads, which say whether they are live`, () => {
    const file = path.join(ROOT, 'test/fixtures/hosts', host.id, 'tracker.json');
    assert.ok(existsSync(file), file);
    const { live, provenance, env, post, pre, standard } = recorded(host);
    assert.equal(typeof live, 'boolean');
    assert.ok(provenance.length > 0);
    if (!live) assert.match(provenance, /^NOT LIVE/u);
    assert.equal(host.detect({ env, input: {} }), true, 'its plugin hook environment names it');
    for (const other of HOSTS) if (other !== host) assert.equal(detectHost({ env, input: post }).id, host.id, `not ${other.id}`);
    assert.equal(host.hookInput(post).tool_name, standard.read);
    assert.equal(host.hookInput(pre).tool_name, standard.write);
    assert.match(standard.write, STANDARD_MCP);
    assert.equal(serverPrefix(standard.read), serverPrefix(standard.write), 'a read clears a write on its server');
  });

  test(`host ${host.id} reads the workspace from its recorded response`, () => {
    const { post, workspace } = recorded(host);
    assert.equal(readTrackerValue(post.tool_response, 'url', host), workspace);
    assert.equal(readTrackerValue(post.tool_response, 'url'), workspace, 'with the host unknown too');
  });
}

for (const host of HOSTS.filter((each) => !delivers(each, 'hook-tracker-pre.mjs'))) {
  test(`host ${host.id} delivers no tracker hook, and says its tracker writes pass unguarded`, () => {
    assert.deepEqual(unguardedTrackerProblems(host), []);
  });
}

test('a host that delivers no tracker hook fails unless its guard is verified none, with a route it names', () => {
  const opencode = HOSTS.find((host) => host.id === 'opencode');
  const guard = opencode.capabilities.trackerGuard;
  const as = (trackerGuard) => ({ ...opencode, capabilities: { ...opencode.capabilities, trackerGuard } });
  assert.deepEqual(unguardedTrackerProblems(as(guard)), []);
  assert.deepEqual(unguardedTrackerProblems(as({ ...guard, verified: 'source' })), ['its tracker guard is verified source, not none']);
  assert.deepEqual(unguardedTrackerProblems(as({ ...guard, unguardedRoutes: [] })), ['it names no unguarded route']);
  assert.equal(unguardedTrackerProblems(as(undefined)).length, 2);
});

for (const host of HOSTS.filter((each) => each.delivery === 'hooks-json')) {
  test(`host ${host.id}'s file edit tools reach the write hook`, () => {
    const matcher = HOOKS.PreToolUse.find((group) => group.hooks.some(({ command }) => command.includes('hook-write.mjs'))).matcher;
    for (const tool of host.fileEditTools) assert.ok(matcher.split('|').includes(tool), tool);
  });
}

for (const host of HOSTS) {
  test(`host ${host.id}'s project folders keep auto-merge off`, () => {
    for (const folder of Object.values(host.projectFolders)) assert.ok(GUARDED_PATHS.test(`${folder}/x.md`), folder);
  });

  test(`host ${host.id}'s agent names answer to the plugin's short name`, () => {
    assert.ok(agentAliases(`${host.pluginAgentPrefix}explorer`).has('explorer'));
  });
}

for (const host of [...HOSTS, fakeHost].filter((each) => each.delivery === 'hooks-json')) {
  test(`host ${host.id}'s raw names fire each hooks.json matcher, as it reads hooks.json as it is`, () => {
    assert.equal(host.delivery, 'hooks-json');
    assert.deepEqual(matcherProblems(host), []);
  });
}

for (const host of HOSTS.filter((each) => each.delivery === 'bridge')) {
  test(`host ${host.id}'s bridge runs only routes after a call, each a script on disk`, () => {
    const routes = ROUTES.get(host.id);
    assert.deepEqual(routeTableProblems(routes), []);
    assert.deepEqual(routeProblems(routes), []);
  });
}

test('a bridge host that lacks its event map, route list, or leaf, or routes nothing, fails the route table check', () => {
  const lacks = ['it lacks routes.mjs EVENTS, routes.generated.json, or a names leaf with STANDARD_NAMES'];
  assert.deepEqual(routeTableProblems(null), lacks);
  assert.deepEqual(routeTableProblems(undefined), lacks);
  assert.deepEqual(routeTableProblems({}), ['its routes are not a list']);
  assert.deepEqual(routeTableProblems([]), ['no generated route of its events fires on a name its leaf returns']);
  assert.deepEqual(routeTableProblems(ROUTES.get('opencode')), []);
});

test('a bridge route that blocks a call, or whose script is gone, is told apart', () => {
  const route = { event: 'PostToolUse', matcher: '^(?:Bash)$', script: 'hook-bash-post.mjs', args: [], timeoutMs: 5000 };
  assert.deepEqual(routeProblems([route]), []);
  assert.deepEqual(routeProblems([{ ...route, event: 'PreToolUse', script: 'hook-bash.mjs' }]), ['hook-bash.mjs runs under PreToolUse, and the bridge runs no blocking route']);
  assert.deepEqual(routeProblems([{ ...route, event: 'SessionStart', matcher: null, script: 'hook-session-start.mjs' }]), [], 'no exit of a start hook blocks');
  for (const event of ['Stop', 'SubagentStop', 'UserPromptSubmit', 'PreCompact']) {
    assert.deepEqual(routeProblems([{ ...route, event, matcher: null, script: 'hook-stop.mjs' }]), [`hook-stop.mjs runs under ${event}, and the bridge runs no blocking route`]);
  }
  assert.deepEqual(routeProblems([{ ...route, script: 'hook-gone.mjs' }]), ['hook-gone.mjs is not in scripts/']);
});

test('every host says the effort a subagent starts at, or null, so the start hook never throws on one', () => {
  for (const host of [...HOSTS, UNKNOWN_HOST]) assert.equal(typeof host.subagentEffort, 'function', host.id);
});

test('a raw_tool_name counts only where its host reads it as the call`s tool_name', () => {
  const marked = (tool, raw, given) => ({ hook_event_name: 'PreToolUse', opencode: {}, tool_name: tool, raw_tool_name: raw, tool_input: given });
  assert.equal(fileEditOf(marked('Bash', 'write', { command: 'ls', path: '/m/f', content: 'x' })), null, 'a shell call edits no file');
  assert.equal(fileReadOf(marked('Bash', 'read', { command: 'ls', path: '/m/f' })), null, 'and reads none');
  assert.deepEqual(fileEditOf(marked('Write', 'edit', { file_path: '/m/f', content: 'x', path: '/m/g' })).targets, ['/m/f'], 'edit reads as Edit, never Write');
});

// Both hosts' parsers split a patch on \n, drop one \r, and trim a line before they look for a header, but inside an Update
// section, where an indented line is context: Codex 0.172.0's apply-patch/src/streaming_parser.rs (tag rust-v0.172.0) and
// OpenCode 2.4.1's packages/util/src/patch.ts.
const patchOn = {
  codex: (text) => fileEditOf({ tool_name: 'apply_patch', tool_input: { command: text } }),
  opencode: (text) => fileEditOf(normalizeHookInput({ hook_event_name: 'PreToolUse', opencode: {}, tool_name: 'patch', tool_input: { patchText: text } }, {})),
};
const patchText = (...lines) => ['*** Begin Patch', ...lines, '*** End Patch', ''].join('\n');
for (const [id, read] of Object.entries(patchOn)) {
  test(`${id}: every header the host's parser reads is a target, and no other line is`, () => {
    for (const [lines, targets] of [
      [[' *** Update File: a.md', '@@', '+x'], ['a.md']],
      [['\t*** Add File: a.md', '+x'], ['a.md']],
      [['\u0085*** Delete File: a.md'], ['a.md']],
      [['\u2028*** Delete File: a.md'], ['a.md']],
      [['*** Add File: a.md', '+x', '  *** Update File: b.md', '@@', '+y'], ['a.md', 'b.md']],
      [['*** Delete File: a.md', ' *** Delete File: b.md', '*** Add File: c.md', '+x'], ['a.md', 'b.md', 'c.md']],
      [['*** Update File: \u2028a.md', '@@', '+x'], ['a.md']],
      [['*** Update File: a\u2028b.md', '@@', '+x'], ['a\u2028b.md', 'a']],
      [['*** Update File: a\rb.md', '@@', '+x'], ['a\rb.md', 'a']],
      [['*** Update File: a.md  ', '*** Move to: \u2028b.md ', '@@', '+x'], ['a.md', 'b.md']],
      [['*** Update File: a.md\r', '@@\r', '+x\r', '*** Delete File: b.md\r'], ['a.md', 'b.md']],
      // Context, added, and removed lines of an Update section, and an added line of an Add section, name no file.
      [['*** Update File: a.md', '@@', ' *** Update File: b.md', '+*** Add File: c.md', '-*** Delete File: d.md', ' *** Move to: e.md'], ['a.md']],
      [['*** Add File: a.md', '+*** Add File: b.md', '+ *** Add File: c.md'], ['a.md']],
    ]) {
      assert.deepEqual(read(patchText(...lines)).targets, targets, JSON.stringify(lines));
    }
    assert.ok(read(patchText('*** Update File: a.md', '@@', ' x\u2028*** Update File: kept.md')).targets.includes('kept.md'), 'each reading of a patch counts');
  });

  test(`${id}: the lines a patch adds count for the file whose header they follow, up to the next header`, () => {
    const { files } = read(patchText(' *** Add File: a.md', '+one', ' *** Update File: b.md', '@@', ' *** Update File: c.md', '+two', '*** Delete File: d.md'));
    const added = (file) => files.filter((each) => each.file === file).flatMap((each) => each.added);
    assert.deepEqual([added('a.md'), added('b.md'), added('c.md'), added('d.md')], [['one'], ['two'], [], []]);
    const mixed = read(patchText('*** Add File: a.md', '+one', ' *** Update File: b.md', '@@', '+two')).files;
    assert.deepEqual(mixed.filter((each) => each.file === 'b.md').flatMap((each) => each.added), ['two']);
    assert.ok(mixed.some((each) => each.file === 'a.md' && each.added.includes('two')), 'each reading of a patch counts');
    for (const end of ['*** End of File', '*** End of File  ']) {
      assert.deepEqual(read(patchText('*** Update File: a.md', '@@', '+one', end, '@@', '+two', '*** Delete File: b.md')).files.map((each) => [each.file, each.added]), [['a.md', ['one', 'two']]], end);
    }
    assert.deepEqual(read(patchText('*** Add File: a.md', '+one', '*** Update File: b.md', '*** Move to: c.md', '@@', '+two')).files, [{ kind: 'add', file: 'a.md', added: ['one'] }, { kind: 'update', file: 'c.md', added: ['two'] }], 'a plain patch reads once');
  });
}

// The work is counted as the elements `includes` may look at, and the processor time is bounded far above what it takes,
// so a loaded machine fails neither.
test('reading a patch takes work in proportion to its size, on each host', () => {
  const headers = 20_000;
  const text = patchText(...Array.from({ length: headers }, (_, at) => `*** Delete File: f${at}.md`));
  const { includes } = Array.prototype;
  for (const [id, read] of Object.entries(patchOn)) {
    let looked = 0;
    const began = process.cpuUsage();
    Array.prototype.includes = function counted(...args) {
      looked += this.length;
      return includes.apply(this, args);
    };
    let edit;
    try {
      edit = read(`${text}${id}`);
    } finally {
      Array.prototype.includes = includes;
    }
    const { user } = process.cpuUsage(began);
    assert.deepEqual([edit.targets.length, edit.operations.length, edit.files.length], [headers, headers, 0], id);
    assert.ok(looked < headers, `${id}: ${looked} elements looked at`);
    assert.ok(user < 20_000_000, `${id}: ${user} microseconds`);
  }
});

test('a raw_tool_name in a Claude Code or Codex payload never changes how its file edit is read', () => {
  const calls = [
    [{ CLAUDECODE: '1' }, 'Write', { file_path: '/m/f', content: 'x' }, ['/m/f']],
    [{ CLAUDECODE: '1' }, 'Edit', { file_path: '/m/f', old_string: 'a', new_string: 'b' }, ['/m/f']],
    [{ CODEX_THREAD_ID: 't' }, 'apply_patch', { command: '*** Begin Patch\n*** Delete File: /m/f\n*** End Patch\n' }, ['/m/f']],
  ];
  for (const [env, tool, given, targets] of calls) {
    for (const raw of [undefined, '', 'shell', 'edit', 'write', 'patch', 'Read', 'Write', 'apply_patch', 'nonsense', 7]) {
      const read = normalizeHookInput({ hook_event_name: 'PreToolUse', tool_name: tool, raw_tool_name: raw, tool_input: given }, env);
      assert.deepEqual(fileEditOf(read)?.targets, targets, `${tool} with raw_tool_name ${raw}`);
    }
  }
});

test('a bridge host`s routes are its generated routes of its events that fire on a name its leaf returns', () => {
  assert.deepEqual(ROUTES.get('opencode').map((route) => [route.event, route.script]),
    [['SessionStart', 'hook-session-start.mjs'], ['SubagentStart', 'hook-session-start.mjs'],
      ['PostToolUse', 'hook-markdown-wrap.mjs'], ['PostToolUse', 'hook-agent-post.mjs'], ['PostToolUse', 'hook-tracker-post.mjs'], ['PostToolUse', 'hook-bash-post.mjs'],
      ['SessionEnd', 'hook-session-end.mjs']]);
  assert.equal(routeFires('^(?:Edit|Write)$', 'edit'), false, 'a matcher fires on the standard name alone, never on OpenCode`s own');
  assert.equal(routeFires(null, 'Bash'), false, 'a route of an event with no matcher fires on no tool');
  assert.equal(routeFires('*', 'Bash'), true);
});

test('which hooks a host delivers: every one on a hooks-json host, and on a bridge host only those a route names', () => {
  for (const host of [...HOSTS, fakeHost].filter((each) => each.delivery === 'hooks-json')) {
    assert.equal(ROUTES.get(host.id), null, host.id);
    assert.equal(delivers(host, 'hook-tracker-pre.mjs'), true, host.id);
  }
  const opencode = HOSTS.find((host) => host.id === 'opencode');
  const named = ROUTES.get('opencode').map((route) => route.script);
  assert.equal(delivers(opencode, 'hook-tracker-pre.mjs'), named.includes('hook-tracker-pre.mjs'));
  assert.equal(delivers(opencode, 'hook-bash-post.mjs'), true, 'the session ledger runs on OpenCode');
  assert.equal(delivers(opencode, 'hook-nothing.mjs'), false);
});

for (const host of HOSTS) {
  test(`host ${host.id} declares the handoff continue routes it can do, each with its step, and its host process for clear`, () => {
    const routes = host.capabilities.handoffContinue?.routes;
    assert.ok(Array.isArray(routes), 'capabilities.handoffContinue.routes is a list, empty when no route runs');
    assert.deepEqual(continueRoutes(host), routes);
    for (const route of routes) {
      assert.ok(CONTINUE_ROUTES.includes(route) && route !== 'none', `${route} is a route of session.handoff.continue other than none`);
      const step = host.capabilities.handoffContinue.steps?.[route];
      assert.ok(typeof step === 'string' && step.trim() !== '', `${route} says what it takes from the Human`);
    }
    if (routes.includes('clear')) {
      assert.equal(typeof host.capabilities.handoffContinue.hookHostPid, 'function', 'clear needs the host process a hook runs under');
      assert.equal(typeof host.capabilities.handoffContinue.keepsArmed, 'function', 'clear needs to know its own command cancels nothing');
    }
    if (routes.includes('background')) {
      assert.equal(typeof host.capabilities.handoffContinue.startBackground, 'function', 'background needs a way to start the new session');
      const { startChoice, readAsked } = host.capabilities.handoffContinue;
      assert.equal(typeof startChoice, typeof readAsked, 'a host that answers a start\'s model and effort reads that answer back');
    }
    const replace = host.capabilities.handoffContinue?.replaceTerminal;
    if (replace) {
      assert.ok(routes.includes('background'), 'a terminal is replaced only after a background start');
      for (const word of [replace.program, replace.attach]) assert.match(word, /^[a-z][a-z0-9-]{0,31}$/u, 'the shell function names the program and its attach word as plain words');
      for (const name of ['hostProcess', 'isHost']) assert.equal(typeof replace[name], 'function', `replaceTerminal.${name}`);
      assert.ok(Object.hasOwn(os.constants.signals, replace.signal), 'replaceTerminal.signal is a signal name');
      assert.equal(typeof host.capabilities.handoffContinue.attachCommand, 'function', 'the say line names the command that opens the new session');
    }
  });
}

test('a host without the handoff continue capability has no route, the unknown one included', () => {
  assert.deepEqual(continueRoutes(fakeHost), []);
  assert.deepEqual(continueRoutes(UNKNOWN_HOST), []);
  assert.deepEqual(continueRoutes({ ...fakeHost, capabilities: { ...fakeHost.capabilities, handoffContinue: {} } }), []);
});

test('Claude Code continues by clear and in the background: its own clear and compact commands keep a continue armed, and a hook\'s parent is its process', () => {
  const claudeCode = HOSTS.find((host) => host.id === 'claude-code');
  const codex = HOSTS.find((host) => host.id === 'codex');
  const { routes, steps, keepsArmed, hookHostPid } = claudeCode.capabilities.handoffContinue;
  assert.deepEqual(routes, ['clear', 'background']);
  assert.match(steps.clear, /\/clear, then any message/u);
  assert.match(steps.background, /^nothing to type\b/u);
  for (const prompt of ['/clear', ' /clear\n', '/clear old-work', '/new', '/reset', '/reset x', '/compact', '/compact keep the test output']) {
    assert.equal(keepsArmed(prompt), true, prompt);
  }
  for (const prompt of ['clear', '/clearly', '/newer', '/resets', '/compacted', 'please /clear', '', undefined, null, 7]) assert.equal(keepsArmed(prompt), false, String(prompt));
  assert.equal(hookHostPid(), process.ppid > 1 ? process.ppid : null);
  assert.equal(hookHostPid(4242), 4242);
  for (const pid of [1, 0, -5, 2.5, '4242', null, Number.NaN]) assert.equal(hookHostPid(pid), null, String(pid));
  assert.deepEqual(codex.capabilities.handoffContinue, { routes: [] });
});

test('each hooks-json host has its own matcher reading, and Claude Code and Codex differ on a comma and a hyphen', () => {
  for (const host of [...HOSTS, fakeHost].filter((each) => each.delivery === 'hooks-json')) assert.ok(Object.hasOwn(MATCHER_READINGS, host.id), host.id);
  assert.equal(fires('claude-code', 'Edit, Write', 'Edit'), true, 'Claude Code reads a comma list as names');
  assert.equal(fires('codex', 'Edit, Write', 'Edit'), false, 'Codex reads it as a pattern that needs the comma');
  assert.equal(fires('claude-code', 'code-reviewer', 'my-code-reviewer'), false, 'Claude Code reads a hyphen name exactly');
  assert.equal(fires('codex', 'code-reviewer', 'my-code-reviewer'), true, 'Codex reads it as a pattern, unanchored');
  for (const id of ['claude-code', 'codex']) {
    assert.equal(fires(id, 'Edit|Write', 'NotebookEdit'), false, `${id} reads a | list exactly`);
    assert.equal(fires(id, 'ash.*', 'Bash'), true, `${id} reads a pattern unanchored`);
    assert.equal(fires(id, undefined, 'Bash') && fires(id, '', 'Bash') && fires(id, '*', 'Bash'), true, `${id} fires on every tool`);
  }
  assert.throws(() => fires('nohost', 'Bash', 'Bash'), /no matcher reading for host nohost/);
});

test('a host whose raw names miss the matchers is told apart: it fails that check, and has to name another delivery', () => {
  const lowerCase = { ...fakeHost, rawToolName: (standard) => standard.toLowerCase() };
  assert.match(matcherProblems(lowerCase).join('\n'), /hook-bash\.mjs misses bash/u);
});

test('an unknown host is reported as unknown, on what no adapter claims', () => {
  const host = detectHost({ env: {}, input: {} });
  assert.equal(host, UNKNOWN_HOST);
  assert.equal(host.name, 'unknown');
  for (const known of HOSTS) assert.notEqual(host.ai, known.ai);
});

test('an unknown host still normalises what a known one sends, so a detection cannot fail open', () => {
  for (const host of HOSTS.filter((each) => delivers(each, 'hook-tracker-pre.mjs'))) {
    const { pre, standard } = recorded(host);
    assert.equal(UNKNOWN_HOST.hookInput(pre).tool_name, standard.write);
  }
});

// Every tool call payload a host's fixtures record, as a PreToolUse call with no agent fields: { host, file, raw, env },
// where `raw` is what the host sends and `env` its hook environment. A fixture's payloads are its `pre` and `post`, and
// each entry that names a tool on top of its `pre`, as a forge fixture's calls do.
function recordedCalls() {
  const dir = path.join(ROOT, 'test/fixtures/hosts');
  return readdirSync(dir).flatMap((id) => readdirSync(path.join(dir, id)).filter((file) => file.endsWith('.json')).flatMap((file) => {
    const data = JSON.parse(readFileSync(path.join(dir, id, file), 'utf8'));
    const calls = Object.values(data).filter((value) => typeof value?.tool_name === 'string').map((value) => ({ ...data.pre, ...value }));
    return calls.map(({ tool_response: _response, agent_id: _id, agent_type: _type, ...call }) => {
      const raw = { ...call, hook_event_name: 'PreToolUse' };
      return { host: detectHost({ env: data.env, input: raw }), file: `${id}/${file}`, raw, env: data.env };
    });
  }));
}

test('every host\'s recorded tool calls meet the strictest-subagent rule with an agent_id and no agent_type, and their own entries otherwise', () => {
  const settings = (agents) => ({ agents, names: { human: 'the Human' } });
  const paths = { config: '.aidrian/config.json', local: '.aidrian.local.json' };
  const verdict = (agents, input) => gateDenial(input, settings(agents), paths)?.match ?? null;
  const calls = recordedCalls();
  assert.deepEqual([...new Set(calls.map(({ host }) => host.id))].sort(), HOSTS.map((host) => host.id).sort(), 'every shipped host has a recorded call');
  for (const { host, file, raw, env } of calls) {
    // The identity fields go in as the host sends them, so each adapter's reading of them is what the gate judges.
    const main = normalizeHookInput(raw, env);
    const unnamed = normalizeHookInput({ ...raw, agent_id: 'child-1' }, env);
    const named = normalizeHookInput({ ...raw, agent_id: 'child-1', agent_type: `${host.pluginAgentPrefix}reviewer` }, env);
    const tool = main.tool_name;
    const label = `${file}: ${tool}`;
    // The caller's own entry, and `*`, which names every caller.
    assert.equal(verdict({ reviewer: { deny: [tool] } }, named), `agents.reviewer.deny has "${tool}"`, label);
    assert.equal(verdict({ '*': { deny: [tool] } }, unnamed), `agents.*.deny has "${tool}"`, label);
    // Another entry's deny: main's, which a named subagent never meets.
    const mainDeny = { main: { deny: [tool] } };
    assert.equal(verdict(mainDeny, unnamed), `agents.main.deny has "${tool}"`, label);
    assert.equal(verdict(mainDeny, named), null, label);
    assert.equal(verdict(mainDeny, main), `agents.main.deny has "${tool}"`, label);
    // Another entry's allow list that lacks the tool, beside the caller's own that has it.
    const lists = { explorer: { allow: ['Read'] }, reviewer: { allow: [tool] } };
    assert.equal(verdict(lists, unnamed), 'agents.explorer.allow does not list it', label);
    assert.equal(verdict(lists, named), null, label);
    assert.equal(verdict(lists, main), null, label);
    // Every list allows it, and no entry denies it.
    assert.equal(verdict({ explorer: { allow: [tool] }, reviewer: { allow: [tool] } }, unnamed), null, label);
  }
});

for (const tracker of [...TRACKERS, fakeTracker, fakePerCall]) {
  test(`tracker ${tracker.id} declares every field of an adapter`, () => {
    for (const field of ['id', 'name']) assert.ok(typeof tracker[field] === 'string' && tracker[field] !== '', field);
    if (tracker.workspaceInput === undefined) {
      assert.ok(typeof tracker.readTool === 'string' && !tracker.readTool.includes('*'), 'a read tool is an exact name');
      assert.ok(typeof tracker.workspaceField === 'string', 'and it reports the workspace in this field');
    } else {
      assert.ok(typeof tracker.workspaceInput === 'string', 'each call names its workspace in this field');
    }
    assert.ok(tracker.writeVerbs.length > 0);
    assert.ok(tracker.team.createFields.length > 0 && tracker.team.keyFields.length > 0);
    if (tracker.project !== undefined) assert.ok(typeof tracker.project.field === 'string');
    assert.ok(Array.isArray(tracker.unguardedRoutes), 'it says which writes no hook reaches, even when none');
    for (const route of tracker.unguardedRoutes) assert.ok(route.name && route.reason);
    for (const verb of tracker.readVerbs ?? []) assert.ok(!tracker.writeVerbs.includes(verb), verb);
  });

  test(`tracker ${tracker.id} names a server list for every shipped host, from a live connection or an empty one`, () => {
    for (const host of HOSTS) assert.ok(Object.hasOwn(tracker.servers, host.id), `${host.id} has no entry: a new host needs a live look at what this tracker's connection shows there`);
  });

  test(`tracker ${tracker.id} has a server on every host, under names the guard can read`, () => {
    const hostIds = HOSTS.map((host) => host.id);
    for (const key of Object.keys(tracker.servers)) assert.ok(key === 'any' || hostIds.includes(key), `${key} is not a host`);
    for (const id of hostIds) assert.ok((tracker.servers.any ?? []).length + (tracker.servers[id] ?? []).length > 0, id);
    for (const server of knownServers(tracker)) {
      assert.equal(serverPrefix(`mcp__${server}__x`), `mcp__${server}__`, server);
    }
  });

  test(`tracker ${tracker.id} expands to a key the guard accepts, with no read covered by a write`, (t) => {
    const project = tracker.project ? { project: { values: ['P'] } } : {};
    const value = expandTracker({ enabled: true, workspace: { expect: 'https://x.example/a' }, team: { key: 'ABC', values: ['A'] }, ...project }, tracker);
    const servers = knownServers(tracker);
    if (tracker.workspaceInput === undefined) assert.deepEqual(value.readTools, readToolsOf(tracker, servers));
    else assert.equal(value.readTools, undefined);
    assert.deepEqual(value.writeTools, writeToolsOf(tracker, servers));
    for (const read of value.readTools ?? []) assert.ok(!value.writeTools.some((pattern) => nameMatches(pattern, read)), read);
    const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-adapters-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker: value }));
    const { config, errors } = loadConfig({ root: dir, paths: { config: '.aidrian/config.json' } });
    assert.deepEqual(errors, []);
    assert.equal(config.tracker.enabled, true);
  });
}

test('a new host works through the registry with no change to shared code', () => {
  const hosts = [fakeHost, ...HOSTS];
  assert.equal(detectHost({ env: { FAKEHOST_SESSION: 'a' } }, hosts).id, 'fakehost');
  assert.equal(detectHost({ env: {}, input: { fakeTurn: 't' } }, hosts).id, 'fakehost');
  assert.equal(detectHost({ env: { CLAUDECODE: '1' } }, hosts).id, 'claude-code');
  assert.equal(detectHost({ env: { FAKEHOST_SESSION: 'a' } }).id, 'unknown', 'it is not shipped');
});

test('a new host and a new tracker run the guard end to end, from its own payload', () => {
  const tracker = { ...expandTracker({ enabled: true, workspace: { expect: 'https://x.example/a' }, team: { key: 'ABC', values: ['Alpha'] } }, fakeTracker), project: null };
  const settings = { tracker, names: { human: 'the Human' } };
  const input = fakeHost.hookInput({ fakeTurn: 't', sessionId: 's', tool: 'mcp__faketracker__add_ticket', args: { projectKey: 'Beta' }, cwd: '/x' });
  assert.equal(input.tool_name, 'mcp__faketracker__add_ticket');
  const read = fakeHost.hookInput({ fakeTurn: 't', sessionId: 's', tool: 'mcp__faketracker__site_info', args: {}, result: { baseUrl: 'https://x.example/a' }, cwd: '/x' });
  assert.ok(tracker.readTools.includes(read.tool_name));
  const value = readTrackerValue(read.tool_response, 'baseUrl', fakeHost);
  assert.equal(value, 'https://x.example/a');
  const record = { value, unreadable: false, tool: read.tool_name };

  assert.match(judgeTrackerWrite(settings, input.tool_name, input.tool_input, null).reason, /has not read the connected workspace/u);
  assert.match(judgeTrackerWrite(settings, input.tool_name, input.tool_input, record).reason, /projectKey is "Beta"/u);
  assert.equal(judgeTrackerWrite(settings, input.tool_name, { projectKey: 'Alpha' }, record), null);
  assert.equal(judgeTrackerWrite(settings, input.tool_name, { projectKey: 'Alpha', ticketKey: 'ABC-1' }, record), null);
  assert.match(judgeTrackerWrite(settings, input.tool_name, { ticketKey: 'XYZ-1' }, record).reason, /ticketKey is "XYZ-1"/u);
});

test('the host running the check counts as here, and a server listed for any host counts on it, with no trust check needed', () => {
  const running = { ...fakeHost, id: 'running', name: 'Running', detect: ({ env }) => env.RUNNING === '1', rawToolName: (standard) => standard, capabilities: { trackerGuard: { unguardedRoutes: [] } } };
  const tracker = { enabled: true, readTools: ['mcp__codex_apps_faketracker__site_info'], writeTools: writeToolsOf(fakeTracker, ['codex_apps_faketracker']) };
  const options = (env) => ({ env, hosts: [running], trackers: [fakeTracker] });
  assert.match(trackerWarnings(tracker, options({ RUNNING: '1' })).join('\n'), /Fake Tracker's server "faketracker" on Running/u);
  assert.deepEqual(trackerWarnings(tracker, options({})), [], 'not running, and nothing finds it set up');
  assert.match(unwatchedLine(tracker, running, [fakeTracker]), /^Tracker guard: on Running, tracker\.writeTools leaves out Fake Tracker tools on faketracker/u);
  assert.equal(unwatchedLine({ ...tracker, writeTools: writeToolsOf(fakeTracker, ['faketracker', 'codex_apps_faketracker']) }, running, [fakeTracker]), null);
  assert.equal(unwatchedLine({ ...tracker, enabled: false }, running, [fakeTracker]), null);
  assert.equal(unwatchedLine(tracker, UNKNOWN_HOST, [fakeTracker]), null, 'an unknown host has no servers to name');
});

test('a tracker whose calls name their workspace judges each call, with no session read and no read tool', (t) => {
  const expect = '11111111-1111-1111-1111-111111111111';
  const tracker = expandTracker({ enabled: true, workspace: { expect }, team: { key: 'NOTES' } }, fakePerCall);
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-per-call-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
  const { config, errors } = loadConfig({ root: dir, paths: { config: '.aidrian/config.json' } });
  assert.deepEqual(errors, []);
  assert.equal(config.tracker.enabled, true);
  assert.equal(config.tracker.workspaceInput, 'cloudId');
  assert.deepEqual(config.tracker.readTools, []);
  assert.deepEqual(config.tracker.team.values, ['NOTES'], 'a team may be written by its key alone');

  const settings = { tracker: config.tracker, names: { human: 'the Human' } };
  const write = 'mcp__faketickets__createTicket';
  const judge = (input) => judgeTrackerWrite(settings, write, input, null);
  assert.equal(judge({ cloudId: expect, projectKey: 'NOTES' }), null, 'no read is asked for');
  assert.match(judge({ cloudId: '22222222-2222-2222-2222-222222222222', projectKey: 'NOTES' }).reason, /cloudId is "22222222/u);
  assert.match(judge({ projectKey: 'NOTES' }).reason, /it names no cloudId/u, 'one that names none cannot be told from the wrong one');
  assert.match(judge({ cloudId: expect, projectKey: 'OTHER' }).reason, /projectKey is "OTHER"/u);

  const edit = 'mcp__faketickets__editTicket';
  assert.equal(judgeTrackerWrite(settings, edit, { cloudId: expect, ticketIdOrKey: '10042' }, null), null, 'a bare number names no project: that tracker\'s stated limit');
  const wrong = judgeTrackerWrite(settings, edit, { cloudId: expect, ticketIdOrKey: 'OTHER-1' }, null);
  assert.match(wrong.reason, /use the ticket's key, or its number when it has none/u, 'the adapter\'s own hint');
  assert.doesNotMatch(wrong.reason, /UUID/u);

  for (const name of ['getTicket', 'listSites', 'lookupAccountId', 'executeRead']) assert.equal(unlistedTool(config.tracker, `mcp__faketickets__${name}`), false, name);
  assert.equal(unlistedTool({ ...config.tracker, writeTools: ['mcp__faketickets__createTicket*'] }, 'mcp__faketickets__archiveTicket'), true);
  assert.match(trackerWarnings(config.tracker, { env: {}, hosts: [], trackers: [fakePerCall] }).join('\n'), /on Fake Tickets, a write through executeWrite passes unchecked/u);
});

test('the page on adding a host says what the adapter does not cover, and names every delivery case and file', () => {
  const text = readFileSync(path.join(ROOT, 'docs/providers/adding-a-host.md'), 'utf8');
  for (const delivery of DELIVERIES) assert.ok(text.includes(`\`${delivery}\``), delivery);
  for (const name of ['plugins/aidrian/hooks/hooks.json', 'scripts/version.mjs', 'test/hosts.test.mjs', 'lib/agent-models.mjs', 'What the fixtures do not prove', 'plugins/aidrian/<id>/routes.mjs', 'plugins/aidrian/<id>/routes.generated.json', 'plugins/aidrian/lib/hosts/<id>-names.mjs', 'plugins/aidrian/<id>/bridge.mjs']) assert.ok(text.includes(name), name);
  assert.doesNotMatch(text, /hookEvents/u);
  for (const field of ['serverSpelling', 'nativeToolName', 'rawToolName', 'delivery', 'workspaceInput', 'unguardedRoutes', 'capabilities.pushPermission', 'capabilities.mergePermission', 'payloadMark', 'nestedGlobs', 'packages', 'credentialStores']) assert.ok(text.includes(`\`${field}`), field);
});

test('a value the file sets for what an adapter fills stays as written', () => {
  const value = expandTracker({ enabled: true, workspace: { expect: 'x' }, idHint: 'mine', readVerbs: ['mine*'], workspaceInput: 'siteId' }, fakePerCall);
  assert.equal(value.idHint, 'mine');
  assert.deepEqual(value.readVerbs, ['mine*']);
  assert.equal(value.workspaceInput, 'siteId');
  assert.equal(value.workspace.field, 'siteId');
  assert.equal(expandTracker({ enabled: true, workspace: { expect: 'x', field: 'siteId' } }, fakePerCall).workspaceInput, 'siteId', 'a field the file names is that input');
  const filled = expandTracker({ enabled: true, workspace: { expect: 'x' } }, fakePerCall);
  assert.equal(filled.workspaceInput, fakePerCall.workspaceInput);
  assert.equal(filled.idHint, fakePerCall.idHint);
  assert.deepEqual(filled.readVerbs, fakePerCall.readVerbs);
});

test('the tracker reference reads tracker.provider before a key routes to Linear', () => {
  const text = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/knowledge/references/tracker.md'), 'utf8');
  assert.ok(text.indexOf('tracker.provider') < text.indexOf('`ABC-123` or a `linear.app` URL is Linear'));
});

test('Linear\'s key keeps its read and its hint', () => {
  const [linear] = TRACKERS;
  const value = expandTracker({ enabled: true, workspace: { expect: 'https://linear.app/acme' }, team: { key: 'A' } }, linear);
  assert.equal(value.workspaceInput, undefined);
  assert.deepEqual(value.team.values, ['A']);
  assert.match(value.idHint, /UUID/u);
});

test('a host that declares a route it cannot guard makes it visible, and so does hook trust not given', () => {
  const tracker = { enabled: true, readTools: [], writeTools: ['mcp__x__save_*'], team: { key: 'A', values: ['A'], createFields: ['team'], keyFields: ['id'] } };
  const warnings = trackerWarnings(tracker, { env: {}, hosts: [fakeHost] });
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /on Fake Host, a write through its hosted connectors passes unchecked: they run on its servers/u);
  assert.match(warnings[1], /Fake Host has no trust on record .* run fakehost trust/u);
  assert.match(warnings[2], /nobody has verified the guard on Fake Host/u, 'set up here, and verified none');
  assert.deepEqual(trackerWarnings({ ...tracker, enabled: false }, { env: {}, hosts: [fakeHost] }), [], 'silent while the guard is off');
});

test('a host\'s unguarded routes are told only where that host is set up, so another host\'s check stays quiet', (t) => {
  const tracker = { enabled: true, readTools: [], writeTools: ['mcp__x__save_*'], team: { key: 'A', values: ['A'], createFields: ['team'], keyFields: ['id'] } };
  const opencode = HOSTS.find((host) => host.id === 'opencode');
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-opencode-setup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, 'config');
  const project = path.join(root, 'project');
  mkdirSync(config);
  mkdirSync(project);
  const route = /on OpenCode, a write through any MCP tool passes unchecked: the bridge runs no route before a tool call in this version/u;
  const told = (env, ask = {}) => trackerWarnings(tracker, { env: { OPENCODE_CONFIG_DIR: config, ...env }, hosts: [opencode], root: project, ...ask });
  const there = told({ OPENCODE: '1', OPENCODE_SESSION_ID: 'ses_x' });
  assert.ok(there.some((line) => route.test(line)), 'the check runs under OpenCode');
  assert.ok(there.some((line) => /nobody has verified the guard on OpenCode/u.test(line)));
  assert.deepEqual(told({ CLAUDECODE: '1' }), [], 'it runs elsewhere, and no OpenCode config names this plugin');
  writeFileSync(path.join(config, 'opencode.json'), JSON.stringify({ plugins: ['oh-my-opencode@latest'] }));
  assert.deepEqual(told({ CLAUDECODE: '1' }), [], 'a config that names another plugin');
  writeFileSync(path.join(project, 'opencode.jsonc'), '{ "plugins": [ "github:acme/aidrian#main::path:plugins/aidrian", ], }');
  assert.ok(told({ CLAUDECODE: '1' }).some((line) => route.test(line)), 'the project\'s config names this plugin, whichever shell runs the check');
  assert.deepEqual(told({ CLAUDECODE: '1' }, { root: undefined }), [], 'and no project root was given');
  writeFileSync(path.join(config, 'opencode.json'), '{ "plugins": [ "aidrian" ] }');
  assert.ok(told({ CODEX_THREAD_ID: 't' }, { root: undefined }).some((line) => route.test(line)), 'the global config names this plugin');
  writeFileSync(path.join(config, 'opencode.json'), '{ "plugins": [ "aidrian" ');
  assert.deepEqual(told({ CLAUDECODE: '1' }, { root: undefined }), [], 'a config it cannot parse counts as none, and throws nothing');
  const trusting = (answer) => ({ ...opencode, capabilities: { ...opencode.capabilities, setUp: () => false, trackerGuard: { ...opencode.capabilities.trackerGuard, hookTrust: () => answer, trustStep: 'trust it', offStep: 'turn it on' } } });
  assert.ok(trackerWarnings(tracker, { env: {}, hosts: [trusting('trusted')] }).some((line) => route.test(line)), 'its hook trust finds it set up here');
  assert.deepEqual(trackerWarnings(tracker, { env: {}, hosts: [trusting('absent')] }), [], 'its hook trust finds it absent');
  const throwing = { ...opencode, capabilities: { ...opencode.capabilities, setUp: () => { throw new Error('x'); } } };
  assert.deepEqual(trackerWarnings(tracker, { env: {}, hosts: [throwing] }), [], 'a probe that throws counts as not set up');
});

test('no two hosts claim one file tool name, so a file edit or read is read by its own host\'s adapter', () => {
  for (const field of ['fileEditTools', 'fileReadTools']) {
    const owners = new Map();
    for (const host of HOSTS) for (const name of host[field] ?? []) owners.set(name, [...(owners.get(name) ?? []), host.id]);
    assert.deepEqual([...owners].filter(([, ids]) => ids.length > 1), [], field);
  }
});

test('the check warns of a known connection the lists leave out on a host set up here, with what to do, whatever the tracker', () => {
  const adapter = fakeTracker;
  const here = { ...fakeHost, id: 'codex', name: 'A Host', detect: () => false, rawToolName: (standard) => standard, capabilities: { trackerGuard: { unguardedRoutes: [], hookTrust: () => 'trusted' } } };
  const notHere = { ...here, capabilities: { trackerGuard: { unguardedRoutes: [], hookTrust: () => 'absent' } } };
  const written = { enabled: true, readTools: readToolsOf(adapter, ['faketracker']), writeTools: writeToolsOf(adapter, ['faketracker']) };
  const warnings = trackerWarnings(written, { env: {}, hosts: [here], trackers: [adapter] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no pattern covers add_\*, .* on Fake Tracker's server "codex_apps_faketracker" on A Host/u);
  assert.match(warnings[0], /set "provider": "faketracker" and drop both tool lists/u);
  assert.deepEqual(trackerWarnings(written, { env: {}, hosts: [notHere], trackers: [adapter] }), [], 'a host not set up here says nothing');
  const whole = knownServers(adapter);
  assert.deepEqual(trackerWarnings({ enabled: true, readTools: readToolsOf(adapter, whole), writeTools: writeToolsOf(adapter, whole) }, { env: {}, hosts: [here], trackers: [adapter] }), []);
});

// The recorded payloads through the real hooks: what the conformance above cannot see is the order of the two hooks,
// and that a refusal reaches the host as exit 2 with its reason on stderr.
for (const host of HOSTS.filter((each) => delivers(each, 'hook-tracker-pre.mjs'))) {
  test(`host ${host.id}: a recorded read then write run through the real tracker hooks`, (t) => {
    const { env, post, pre, workspace, native } = recorded(host);
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-adapters-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, '.aidrian'));
    const tracker = { enabled: true, provider: 'linear', workspace: { expect: workspace }, team: { key: 'NOTES', values: ['Notes'] } };
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, tracker }));
    const scripts = path.join(ROOT, 'plugins/aidrian/scripts');
    const session = `${host.id}-session`;
    const run = (script, payload) => spawnSync(process.execPath, [path.join(scripts, script)], {
      input: JSON.stringify({ ...payload, cwd: dir, session_id: session }),
      encoding: 'utf8',
      env: { ...process.env, ...env, XDG_STATE_HOME: path.join(dir, 'state') },
    });

    const first = run('hook-tracker-pre.mjs', pre);
    assert.equal(first.status, 2, 'no read yet');
    assert.ok(first.stderr.includes(`Call ${native.read}, then write again`), `the refusal names the read as the model sees it: ${first.stderr}`);

    assert.equal(run('hook-tracker-post.mjs', post).status, 0);
    assert.equal(run('hook-tracker-pre.mjs', pre).status, 0, 'the read clears the write');

    const elsewhere = run('hook-tracker-pre.mjs', { ...pre, tool_input: { team: 'Another team' } });
    assert.equal(elsewhere.status, 2);
    assert.match(elsewhere.stderr, /team is "Another team"/u);

    const other = JSON.parse(JSON.stringify(post));
    const wrong = 'https://linear.app/another';
    const swap = (value) => (typeof value === 'string' ? value.replaceAll(workspace, wrong) : value);
    other.tool_response = JSON.parse(swap(JSON.stringify(post.tool_response)).replaceAll(workspace.replaceAll('/', '\\/'), wrong));
    assert.equal(run('hook-tracker-post.mjs', other).status, 0);
    const refused = run('hook-tracker-pre.mjs', pre);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /the connected workspace is "https:\/\/linear\.app\/another"/u);
  });
}

test('a Claude Code Monitor call that runs a shell command reads as the standard Bash, with its own name kept', () => {
  const claude = HOSTS.find((host) => host.id === 'claude-code');
  const monitor = { session_id: 's', agent_id: 'a1', tool_name: 'Monitor', tool_input: { command: 'tail -f log', description: 'watch' }, cwd: '/x' };
  const read = claude.hookInput(monitor);
  assert.deepEqual(read, { ...monitor, tool_name: 'Bash', raw_tool_name: 'Monitor' });
  assert.deepEqual(UNKNOWN_HOST.hookInput(monitor), read, 'a payload no host claims is read the same way');
  const ws = { ...monitor, tool_input: { ws: { url: 'wss://example.test' } } };
  assert.deepEqual(claude.hookInput(ws), { ...ws, permission_tool_name: 'Bash' }, 'a WebSocket watch runs no shell, under Bash\'s permission rules');
  assert.deepEqual(deniedNames(claude.hookInput(ws)), ['Monitor', 'Bash']);
  // A gate that names Monitor still matches the call by the name it was sent as.
  assert.ok([read.tool_name, read.raw_tool_name].some((name) => nameMatches('Monitor', name)));
  for (const host of HOSTS.filter((each) => each !== claude)) assert.deepEqual(host.hookInput(monitor), monitor, host.id);
});

test('a Claude Code PowerShell call is never read as Bash: its command is opaque text to the guards', () => {
  const claude = HOSTS.find((host) => host.id === 'claude-code');
  const call = { session_id: 's', agent_id: 'a1', tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem @(1, 2) `n' }, cwd: '/x' };
  assert.deepEqual(claude.hookInput(call), call, 'it keeps its name, so no Bash(prefix) pattern matches it');
  assert.equal(opaqueShellCommand(UNKNOWN_HOST.hookInput(call)), call.tool_input.command);
  for (const tool of ['Bash', 'Monitor', 'Read']) assert.equal(opaqueShellCommand(UNKNOWN_HOST.hookInput({ ...call, tool_name: tool })), null, tool);
  assert.equal(opaqueShellCommand({ ...call, tool_input: {} }), null, 'a call with no command');
});

// The writer of a session's links.jsonl is the ledger's PostToolUse Bash hook, on every host (docs/providers/adding-a-host.md
// Session links): each host's recorded payload of a shell call, its command an `aidrian worktree new`, files the row under
// the payload's session id. A host added without the fixture fails here.
// `fixture.post.tool_response` with `printed` where the host holds a shell call's output: under the fixture's
// `output_path`, its keys into the response, when it names one; else the whole response when that is the output as one
// string, else its stdout.
function outputIn(fixture, printed) {
  const response = fixture.post.tool_response;
  if (!Array.isArray(fixture.output_path)) return typeof response === 'string' ? printed : { ...response, stdout: printed };
  const copy = structuredClone(response);
  const keys = fixture.output_path;
  keys.slice(0, -1).reduce((each, key) => each[key], copy)[keys.at(-1)] = printed;
  return copy;
}

test('each host`s PostToolUse Bash payload of aidrian worktree new files a links row under the payload`s session', { skip: process.platform === 'win32' }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-links-hosts-')));
  const state = path.join(root, 'state');
  const env = { PATH: process.env.PATH, HOME: root, XDG_STATE_HOME: state, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const dir = path.join(root, 'project');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  for (const args of [['init', '-q', '-b', 'main'], ['add', '.'], ['commit', '-q', '-m', 'start'], ['worktree', 'add', '-q', '-b', 'feat/linked', path.join(root, 'tree')]]) {
    assert.equal(spawnSync('git', args, { cwd: dir, env }).status, 0, args.join(' '));
  }
  const hook = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash-post.mjs');
  try {
    for (const host of HOSTS) {
      const file = path.resolve(import.meta.dirname, 'fixtures/hosts', host.id, 'bash-post.json');
      assert.ok(existsSync(file), `${host.id} has no bash-post.json fixture`);
      const fixture = JSON.parse(readFileSync(file, 'utf8'));
      // The result `aidrian worktree new` prints, in the place the host's response holds the call's output (outputIn).
      const printed = `${JSON.stringify({ status: 'created', worktree_path: path.join(root, 'tree'), branch: 'feat/linked' })}\n`;
      const response = outputIn(fixture, printed);
      const input = { ...fixture.post, cwd: dir, tool_input: { ...fixture.post.tool_input, command: 'aidrian worktree new feat/linked' }, tool_response: response };
      const ran = spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8', env: { ...env, ...fixture.env, CLAUDECODE: fixture.env?.CLAUDECODE ?? '' } });
      assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, '', ''], host.id);
      const projects = path.join(state, 'aidrian/projects');
      const files = readdirSync(projects).map((id) => path.join(projects, id, 'sessions', fixture.post.session_id, 'links.jsonl')).filter((each) => existsSync(each));
      assert.equal(files.length, 1, host.id);
      assert.deepEqual(readFileSync(files[0], 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch), ['feat/linked'], host.id);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The push permission capability (docs/providers/adding-a-host.md, capabilities.pushPermission): what a host says of a
// push to the repository's remote before a run no Human attends starts work. Shared code reads it only through
// pushPermission in lib/hosts/index.mjs, which answers unknown for whatever is not a clear answer.
const REPOSITORY = 'github.com/acme/widget';
const DENIAL = { answer: 'denied', setting: 'a.setting', file: '/x/settings.json', why: 'names no remote', fix: 'adds one' };

test('every host answers the push permission with one of its answers, and unknown with no session', (t) => {
  const config = mkdtempSync(path.join(tmpdir(), 'aidrian-push-'));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ autoMode: { environment: ['Trusted repo: github.com/acme/other'] } }));
  assert.deepEqual(PUSH_ANSWERS, ['allowed', 'denied', 'unknown']);
  for (const host of [...HOSTS, fakeHost, UNKNOWN_HOST]) {
    const read = pushPermission(host, { repository: REPOSITORY, session: null, cwd: config, env: { CLAUDE_CONFIG_DIR: config } });
    assert.ok(PUSH_ANSWERS.includes(read.answer), host.id);
    assert.deepEqual(read, { answer: 'unknown' }, host.id);
  }
});

test('a host without the push permission capability, Codex, and the unknown host answer unknown', () => {
  const codex = HOSTS.find((host) => host.id === 'codex');
  assert.equal(fakeHost.capabilities.pushPermission, undefined, 'the fixture host is the one without it');
  for (const host of [codex, UNKNOWN_HOST]) {
    assert.equal(typeof host.capabilities.pushPermission, 'function', host.id);
    assert.deepEqual(host.capabilities.pushPermission({ repository: REPOSITORY, session: 's', cwd: '/x', env: {} }), { answer: 'unknown' }, host.id);
  }
  for (const host of [fakeHost, codex, UNKNOWN_HOST, null, undefined, {}, { capabilities: null }]) {
    assert.deepEqual(pushPermission(host, { repository: REPOSITORY, session: 's', cwd: '/x', env: {} }), { answer: 'unknown' }, String(host?.id));
  }
});

test('the push permission is unknown for a capability that throws, a junk answer, and a denial it cannot name', () => {
  const answering = (read) => ({ ...fakeHost, capabilities: { ...fakeHost.capabilities, pushPermission: () => read } });
  const throwing = { ...fakeHost, capabilities: { pushPermission: () => { throw new Error('boom'); } } };
  assert.deepEqual(pushPermission(throwing, {}), { answer: 'unknown' });
  const rejected = Promise.reject(new Error('later'));
  for (const read of [undefined, null, 'allowed', 7, [], {}, { answer: 'yes' }, { answer: 'ALLOWED' }, { answer: null }, rejected, Promise.resolve({ answer: 'allowed' })]) {
    assert.deepEqual(pushPermission(answering(read), {}), { answer: 'unknown' }, String(read?.answer ?? read));
  }
  const getter = { get answer() { throw new Error('boom'); } };
  assert.deepEqual(pushPermission(answering(getter), {}), { answer: 'unknown' });
  for (const field of ['setting', 'file', 'why', 'fix']) {
    for (const value of [undefined, '', '  ', 7, null, 'two\nlines', 'a\u0007bell', 'a\u2028line']) {
      assert.deepEqual(pushPermission(answering({ ...DENIAL, [field]: value }), {}), { answer: 'unknown' }, `${field}: ${JSON.stringify(value)}`);
    }
  }
  for (const file of ['settings.json', './x/settings.json', '~/.claude/settings.json']) {
    assert.deepEqual(pushPermission(answering({ ...DENIAL, file }), {}), { answer: 'unknown' }, `a file that is not absolute: ${file}`);
  }
  assert.deepEqual(pushPermission(answering({ ...DENIAL, extra: 'kept out' }), {}), DENIAL);
  assert.deepEqual(pushPermission(answering({ answer: 'allowed', setting: 'x' }), {}), { answer: 'allowed' });
  assert.deepEqual(pushPermission(answering({ answer: 'unknown' }), {}), { answer: 'unknown' });
  let asked = null;
  const recording = { ...fakeHost, capabilities: { pushPermission: (ask) => { asked = ask; return { answer: 'allowed' }; } } };
  const ask = { repository: REPOSITORY, session: 's', cwd: '/x', env: {} };
  pushPermission(recording, ask);
  assert.equal(asked, ask, 'the capability gets the ask as given');
});

// A Claude Code config folder whose settings.json holds `settings`, written as JSON unless it is a string.
function claudeSettings(t, settings) {
  const config = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-push-')));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  if (settings !== undefined) writeFileSync(path.join(config, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  return config;
}
const inAuto = () => 'auto';
const askClaude = (config, extra = {}) => claudePushPermission({ repository: REPOSITORY, session: 'session-1', cwd: config, env: { CLAUDE_CONFIG_DIR: config }, readMode: inAuto, ...extra });
const trusting = (environment, allow) => ({ autoMode: { environment, ...(allow ? { allow } : {}) } });

test('Claude Code in auto mode answers the push permission from auto mode\'s trusted repositories in its user settings', (t) => {
  const cases = [
    ['an environment entry names the remote', trusting(['Trusted repo: github.com/acme/widget and its remotes']), 'allowed'],
    ['"$defaults" keeps the defaults, which trust the working repository', trusting(['$defaults', 'Source control: gitlab.example.com/other']), 'allowed'],
    ['an entry for the whole organisation', trusting(['Source control: github.com/acme and all repos under it']), 'allowed'],
    ['an organisation entry with a glob', trusting(['Source control: github.com/acme/*']), 'allowed'],
    ['the path alone, with .git', trusting(['**Trusted repo**: ~/work/widget (acme/widget.git, private)']), 'allowed'],
    ['in another case, closed by a bracket', trusting(['Trusted repo: (GitHub.com/Acme/Widget)']), 'allowed'],
    ['a URL', trusting(['Remote: https://github.com/acme/widget']), 'allowed'],
    ['an allow entry that names it and holds push', trusting(['Source control: gitlab.example.com/other'], ['Git Pushes to github.com/acme/widget are fine']), 'allowed'],
    ['only another remote is trusted', trusting(['Trusted repo: github.com/acme/other']), 'denied'],
    ['a longer repository name', trusting(['Trusted repo: github.com/acme/widget-site']), 'denied'],
    ['a longer organisation name', trusting(['Trusted repo: github.com/acme-corp/widget']), 'denied'],
    ['another repository of the organisation', trusting(['Source control: github.com/acme/other and its remotes']), 'denied'],
    ['an organisation with a longer name', trusting(['Source control: github.com/acme.io']), 'denied'],
    ['an organisation at the end of a sentence', trusting(['Source control: github.com/acme.']), 'allowed'],
    ['a repository of the organisation whose name starts with a dot', trusting(['Trusted repo: github.com/acme/.github']), 'denied'],
    ['another host', trusting(['Source control: xgithub.com/acme']), 'denied'],
    ['an allow entry that names it without push', trusting(['Trusted repo: github.com/acme/other'], ['Reading github.com/acme/widget is fine']), 'denied'],
    ['an allow entry that holds push and names another', trusting(['Trusted repo: github.com/acme/other'], ['git push to github.com/acme/widget-site']), 'denied'],
  ];
  for (const [name, settings, answer] of cases) {
    const config = claudeSettings(t, settings);
    const read = askClaude(config);
    assert.equal(read.answer, answer, name);
    if (answer === 'denied') {
      assert.equal(read.setting, 'autoMode.environment', name);
      assert.equal(read.file, path.join(config, 'settings.json'), name);
      assert.ok(path.isAbsolute(read.file), name);
      assert.match(read.why, /"\$defaults"/u, name);
      assert.ok(read.fix.includes('"$defaults"') && read.fix.includes(REPOSITORY), name);
      assert.deepEqual(pushPermission({ capabilities: { pushPermission: () => read } }, {}), read, 'the registry passes the denial on');
    } else {
      assert.deepEqual(read, { answer }, name);
    }
  }
});

// An entry that trusts the remote's whole host, such as "Trusted source control: git.example.com", trusts the remote.
// `denied` from the environment needs every entry to be one the matchers read, naming some host, and none naming this
// remote; prose that names no host may trust it in words no matcher reads, so the answer is then unknown.
test('Claude Code trusts a host-wide entry, and answers unknown, never denied, beside an entry it cannot read', (t) => {
  const cases = [
    ['the host alone', ['Trusted source control: github.com'], 'allowed'],
    ['the host in another case, ending a sentence', ['Source control is GitHub.com.'], 'allowed'],
    ['the host as a URL', ['Source control: https://github.com'], 'allowed'],
    ['the host with a port', ['Source control: github.com:443'], 'allowed'],
    ['the host with a glob for every path', ['Source control: github.com/*'], 'allowed'],
    ['the host with a path to this owner, scp-style', ['Source control: git@github.com:acme'], 'allowed'],
    ['another host only', ['Trusted source control: gitlab.example.com'], 'denied'],
    ['a longer host', ['Trusted source control: xgithub.com'], 'denied'],
    ['a subdomain of the host', ['Trusted source control: enterprise.github.com'], 'denied'],
    ['the host as the start of a longer one', ['Trusted source control: github.com.example.io'], 'denied'],
    ['the host narrowed to another owner', ['Trusted source control: github.com/other'], 'denied'],
    ['the host narrowed to another owner, scp-style', ['Trusted source control: git@github.com:other/repo'], 'denied'],
    ['the host and a port, narrowed to another owner', ['Trusted source control: github.com:22/other/repo'], 'denied'],
    ['prose that names no host', ['Company: Acme builds widgets'], 'unknown'],
    ['prose that names no host beside another remote', ['Trusted repo: github.com/acme/other', 'All repositories of our organisation'], 'unknown'],
    ['prose beside another host', ['Trusted source control: gitlab.example.com', 'Our GitHub organisation'], 'unknown'],
    ['an owner and repository with no host', ['Trusted repo: acme/other'], 'unknown'],
    ['prose beside an entry that names the remote', ['Our GitHub organisation', 'Trusted repo: github.com/acme/widget'], 'allowed'],
    ['prose beside the host', ['Our GitHub organisation', 'Source control: github.com'], 'allowed'],
  ];
  for (const [name, environment, answer] of cases) {
    const read = askClaude(claudeSettings(t, trusting(environment)));
    assert.equal(read.answer, answer, name);
    if (answer !== 'denied') assert.deepEqual(read, { answer }, name);
  }
  // A host-wide entry for another remote's host.
  assert.deepEqual(askClaude(claudeSettings(t, trusting(['Trusted source control: git.example.com'])), { repository: 'git.example.com/acme/widget' }), { answer: 'allowed' });
  assert.equal(askClaude(claudeSettings(t, trusting(['Trusted source control: git.example.com'])), { repository: 'github.com/acme/widget' }).answer, 'denied');
});

// An entry is understood only when it names one source-control host or path: a word that reads like a file, such as
// `Node.js` or `README.md`, names none, and an entry that names several, or names another host beside a bare word for
// this remote's host, such as "our GitHub org", may cover this remote too. Beside any such entry the answer is unknown.
test('Claude Code counts only a source-control name as an understood trust entry, and answers unknown beside any other', (t) => {
  const OTHER = 'Trusted repo: github.com/acme/other';
  for (const entry of ['We build with Node.js', 'See README.md', 'our GitHub org, and gitlab.example.com', 'Config lives in settings.json and package-lock.json',
    'Trusted source control: gitlab.example.com and bitbucket.org', 'Trusted repos: github.com/acme/other, github.com/acme/third', 'Run scripts/setup.sh first', 'Mirrors on GITHUB too: gitlab.example.com']) {
    assert.deepEqual(askClaude(claudeSettings(t, trusting([OTHER, entry]))), { answer: 'unknown' }, entry);
    assert.deepEqual(askClaude(claudeSettings(t, trusting([entry]))), { answer: 'unknown' }, `${entry}, alone`);
  }
  // A single clear name of another repository, organisation, or host still denies.
  for (const entry of ['Source control: github.example.com/other-org and all repos under it', 'Trusted source control: gitlab.example.com', OTHER,
    'Remote: https://gitlab.example.com/acme/other.git', 'Mirror: git@gitlab.example.com:acme/other.git, read with the docs in README', 'Source control: githubusercontent.example.com']) {
    assert.equal(askClaude(claudeSettings(t, trusting([entry]))).answer, 'denied', entry);
  }
  // The remote's own host counts whatever its last label, and a path names a host whatever it ends in.
  const repository = 'code.example.sh/acme/widget';
  assert.equal(askClaude(claudeSettings(t, trusting(['Mirror: code.example.sh/acme/other'])), { repository }).answer, 'denied');
  assert.deepEqual(askClaude(claudeSettings(t, trusting(['Trusted: tools.example.sh'])), { repository }), { answer: 'unknown' }, 'a bare name with a file extension is no host');
});

// The user settings choose the entries, up to 1 MB, so reading one for a source-control name takes linear time.
test('Claude Code reads a long trust entry for a source-control name at once', (t) => {
  for (const entry of ['a'.repeat(300000), 'a.'.repeat(150000), `${'a-'.repeat(150000)}x`, `git@${'a.'.repeat(100000)}1`]) {
    const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other', entry]));
    const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/claude-code-push.mjs');
    const script = `import { pushPermission } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(pushPermission({ repository: ${JSON.stringify(REPOSITORY)}, session: 's', cwd: ${JSON.stringify(config)}, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} }, readMode: () => 'auto' })));`;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.deepEqual([ran.status, ran.signal, ran.stdout], [0, null, '{"answer":"unknown"}'], entry.slice(0, 8));
  }
});

test('Claude Code answers unknown on settings it cannot read as a clear auto mode list', (t) => {
  const cases = [
    ['no autoMode', {}],
    ['autoMode not an object', { autoMode: 'trust everything' }],
    ['autoMode a list', { autoMode: ['x'] }],
    ['no environment', { autoMode: { allow: ['git push anywhere'] } }],
    ['an empty environment', trusting([])],
    ['an environment that is no list', trusting('Trusted repo: github.com/acme/other')],
    ['a non-string entry', trusting(['Trusted repo: github.com/acme/other', 7])],
    ['an allow of another shape', trusting(['Trusted repo: github.com/acme/other'], 'git push')],
    ['an allow with a non-string entry', trusting(['Trusted repo: github.com/acme/other'], [null])],
    ['settings that are a list', '[]'],
    ['settings that are null', 'null'],
    ['bad JSON', '{"autoMode": {'],
  ];
  for (const [name, settings] of cases) assert.deepEqual(askClaude(claudeSettings(t, settings)), { answer: 'unknown' }, name);
  assert.deepEqual(askClaude(claudeSettings(t, undefined)), { answer: 'unknown' }, 'settings missing');
  const folder = claudeSettings(t, undefined);
  mkdirSync(path.join(folder, 'settings.json'));
  assert.deepEqual(askClaude(folder), { answer: 'unknown' }, 'a folder at that path');
  const denying = JSON.stringify(trusting(['Trusted repo: github.com/acme/other']));
  const large = claudeSettings(t, `${denying}${' '.repeat(1024 * 1024)}`);
  assert.deepEqual(askClaude(large), { answer: 'unknown' }, 'over 1 MB');
  assert.equal(askClaude(claudeSettings(t, `${denying}${' '.repeat(1024 * 1024 - denying.length)}`)).answer, 'denied', 'at 1 MB');
  const relative = claudeSettings(t, JSON.parse(denying));
  assert.equal(askClaude(relative).answer, 'denied', 'the same folder by its absolute path denies');
  assert.deepEqual(askClaude(relative, { env: { CLAUDE_CONFIG_DIR: path.relative(process.cwd(), relative) } }), { answer: 'unknown' }, 'a relative config folder');
  for (const repository of [undefined, '', 'github.com/acme', 'github.com//widget', 7]) {
    assert.deepEqual(askClaude(claudeSettings(t, JSON.parse(denying)), { repository }), { answer: 'unknown' }, String(repository));
  }
});

test('Claude Code reads auto mode from the user settings alone, never from the project\'s', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const cwd = path.join(config, 'work');
  mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  for (const name of ['settings.json', 'settings.local.json']) writeFileSync(path.join(cwd, '.claude', name), JSON.stringify(trusting(['$defaults'])));
  const read = askClaude(config, { cwd });
  assert.equal(read.answer, 'denied');
  assert.equal(read.file, path.join(config, 'settings.json'));
});

// A permission rule settles a command before auto mode's classifier does, and the adapter does not emulate how Claude
// Code matches one: a deny or ask rule that may reach a `git push`, or an allow rule that covers a push to `origin`, in
// the user file or the project's `.claude/settings.json` or `.claude/settings.local.json`, only makes the answer
// unknown. No rule answers allowed or denied. Auto mode drops broad allow rules, so a whole-tool allow leaves the verdict.
const PUSH_RULES = ['Bash(git push:*)', 'Bash(git push *)', 'Bash(git push)', 'Bash(GIT PUSH origin main)', 'Bash(git  push --force:*)', 'Bash(git pushall)', 'Bash(git:*)', 'Bash(git *)', 'Bash(g*)', 'Bash(git:* push)',
  'Bash', 'Bash(*)', 'Bash()', 'Bash(* --version)', 'B*', '*', 'Ba*h', 'Bash(*)(git status)', 'mcp__shell__run(git push origin)'];
const ALLOW_PUSH_RULES = ['Bash(git push:*)', 'Bash(git push *)', 'Bash(git push)', 'Bash(GIT PUSH origin main)', 'Bash(git push origin:*)', 'Bash(git:*)', 'Bash(git *)', 'Bash(g*)',
  'Bash(git:* push)', 'Bash(git  push --force:*)', 'Bash(git push -u origin:*)', 'Bash(git push --force-with-lease=main origin main)'];
const UNRELATED_RULES = ['Bash(git status)', 'Bash(git pull:*)', 'Bash(npm run *)', 'Bash(gh pr view:*)', 'Read(**)', 'WebFetch', 'mcp__github__push_files', 'mcp__github__*', 'R*', '*(git status)'];

test('Claude Code answers unknown, never denied, beside a deny or ask rule that may reach a git push, or an allow rule that covers one, and never allowed for one', (t) => {
  const ONLY_OTHER = trusting(['Trusted repo: github.com/acme/other']);
  for (const key of ['allow', 'deny', 'ask']) {
    for (const rule of key === 'allow' ? ALLOW_PUSH_RULES : PUSH_RULES) {
      assert.deepEqual(askClaude(claudeSettings(t, { ...ONLY_OTHER, permissions: { [key]: ['Bash(git status)', rule] } })), { answer: 'unknown' }, `${key} ${rule}`);
      assert.deepEqual(askClaude(claudeSettings(t, { permissions: { [key]: [rule] } })), { answer: 'unknown' }, `${key} ${rule}, no autoMode`);
      assert.deepEqual(askClaude(claudeSettings(t, { ...trusting(['$defaults']), permissions: { [key]: [rule] } })), { answer: 'unknown' }, `${key} ${rule}, "$defaults"`);
    }
    for (const rule of key === 'allow' ? [...UNRELATED_RULES, ...PUSH_RULES.filter((each) => !ALLOW_PUSH_RULES.includes(each))] : UNRELATED_RULES) {
      assert.equal(askClaude(claudeSettings(t, { ...ONLY_OTHER, permissions: { [key]: [rule] } })).answer, 'denied', `${key} ${rule}`);
      assert.deepEqual(askClaude(claudeSettings(t, { ...trusting(['$defaults']), permissions: { [key]: [rule] } })), { answer: 'allowed' }, `${key} ${rule}, "$defaults"`);
    }
  }
  // With no rule that may reach a push, "$defaults" and an entry that names the remote still answer allowed.
  assert.deepEqual(askClaude(claudeSettings(t, trusting(['$defaults']))), { answer: 'allowed' });
  assert.deepEqual(askClaude(claudeSettings(t, { ...trusting(['Trusted repo: github.com/acme/widget']), permissions: { allow: ['Bash(git status)'] } })), { answer: 'allowed' });
  // A file that cannot be read, or rules of another shape, may hold such a rule: unknown.
  for (const settings of ['{"permissions": {', { ...ONLY_OTHER, permissions: 'Bash' }, { ...ONLY_OTHER, permissions: { deny: 'Bash(git push:*)' } }, { ...ONLY_OTHER, permissions: { ask: [7] } }, { ...ONLY_OTHER, permissions: { allow: [null] } }]) {
    assert.deepEqual(askClaude(claudeSettings(t, settings)), { answer: 'unknown' }, JSON.stringify(settings));
  }
});

// The four rules the review named, each with an otherwise-denying setup, and with "$defaults", which no rule turns into
// a denial either.
test('Claude Code answers unknown for a deny, an ask, and an allow push rule, a narrow git allow, and a B* deny, where it would deny, and denies beside a whole-tool allow', (t) => {
  const ONLY_OTHER = trusting(['Trusted repo: github.com/acme/other']);
  assert.equal(askClaude(claudeSettings(t, ONLY_OTHER)).answer, 'denied', 'the setup denies with no rule');
  for (const permissions of [{ deny: ['Bash(git push:*)'] }, { ask: ['Bash(git push:*)'] }, { allow: ['Bash(git push:*)'] }, { allow: ['Bash(git:*)'] }, { allow: ['Bash(git *)'] }, { allow: ['Bash(git push -u origin:*)'] }, { deny: ['B*'] }]) {
    assert.deepEqual(askClaude(claudeSettings(t, { ...ONLY_OTHER, permissions })), { answer: 'unknown' }, JSON.stringify(permissions));
  }
  // Auto mode drops a broad allow rule, so it leaves the denial; `git pushall` is no push, and `upstream` another remote.
  for (const rule of ['Bash', 'Bash(*)', '*', 'B*', 'Bash(* --version)', 'Bash(git pushall)', 'Bash(git push originals)', 'Bash(git push upstream main)', 'Bash(git push -u upstream:*)']) {
    assert.equal(askClaude(claudeSettings(t, { ...ONLY_OTHER, permissions: { allow: [rule] } })).answer, 'denied', `allow ${rule}`);
  }
  assert.deepEqual(askClaude(claudeSettings(t, { ...trusting(['$defaults']), permissions: { allow: ['Bash(git status)'] } })), { answer: 'allowed' }, '"$defaults"');
});

// Claude Code loads `.claude/settings.json` from the session's folder alone, and `.claude/settings.local.json` from the
// repository root, a worktree's main checkout, and the session's folder (code.claude.com/docs/en/settings).
test('Claude Code reads the push rules of each project settings file from the folder it loads that file from', (t) => {
  const ONLY_OTHER = trusting(['Trusted repo: github.com/acme/other']);
  const project = (files, { below = false } = {}) => {
    const config = claudeSettings(t, ONLY_OTHER);
    const root = path.join(config, 'work');
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    mkdirSync(path.join(root, '.git'));
    for (const [name, settings] of Object.entries(files)) writeFileSync(path.join(root, '.claude', name), typeof settings === 'string' ? settings : JSON.stringify(settings));
    const cwd = below ? path.join(root, 'packages', 'app') : root;
    mkdirSync(cwd, { recursive: true });
    return askClaude(config, { cwd });
  };
  for (const name of ['settings.json', 'settings.local.json']) {
    for (const key of ['allow', 'deny', 'ask']) {
      assert.deepEqual(project({ [name]: { permissions: { [key]: ['Bash(git push:*)'] } } }), { answer: 'unknown' }, `${name} ${key}`);
      const below = project({ [name]: { permissions: { [key]: ['Bash(git push *)'] } } }, { below: true });
      if (name === 'settings.json') assert.equal(below.answer, 'denied', `${key}: the repository root's settings.json, which a session below it does not load`);
      else assert.deepEqual(below, { answer: 'unknown' }, `${key}: the repository root's settings.local.json, from a folder below it`);
      assert.equal(project({ [name]: { permissions: { [key]: ['Bash(git status)'] } } }).answer, 'denied', `${name} ${key}: an unrelated rule`);
    }
    // A project file that is there and cannot be read, or rules of another shape: no denial stands.
    for (const settings of ['{"permissions": {', '[]', { permissions: 'Bash' }, { permissions: { allow: 'Bash(git push:*)' } }, { permissions: { deny: [7] } }]) {
      assert.deepEqual(project({ [name]: settings }), { answer: 'unknown' }, `${name}: ${JSON.stringify(settings)}`);
    }
  }
  assert.equal(project({}).answer, 'denied', 'no project settings');
  // A worktree: Claude Code reads `.claude/settings.local.json` at the main checkout's root.
  const config = claudeSettings(t, ONLY_OTHER);
  const main = path.join(config, 'main');
  const worktree = path.join(config, 'worktrees', 'wt');
  mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
  mkdirSync(path.join(main, '.claude'));
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
  writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.equal(askClaude(config, { cwd: worktree }).answer, 'denied', 'a worktree with no rule');
  writeFileSync(path.join(main, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Bash(git push *)'] } }));
  assert.deepEqual(askClaude(config, { cwd: worktree }), { answer: 'unknown' }, 'the main checkout\'s local settings, from a worktree');
  // A folder that is not absolute: the project's rules cannot be read, so no answer stands, "$defaults" included.
  assert.deepEqual(askClaude(claudeSettings(t, ONLY_OTHER), { cwd: 'work' }), { answer: 'unknown' }, 'a relative folder');
  assert.deepEqual(askClaude(claudeSettings(t, trusting(['$defaults'])), { cwd: 'work' }), { answer: 'unknown' }, 'a relative folder, "$defaults"');
});

// A project's checked-in `.claude/settings.json` chooses its rules, so reading one takes time linear in its length, never
// time that grows with its stars. Run in a child process, so a hang fails, not blocks.
test('Claude Code answers unknown at once for a project deny rule with thousands of stars', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const root = path.join(config, 'work');
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/claude-code-push.mjs');
  // `g` starts `git push`, so the rule may reach one: no denial stands beside it.
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`Bash(g${'*'.repeat(10000)}z)`] } }));
  const script = `import { pushPermission } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(pushPermission({ repository: ${JSON.stringify(REPOSITORY)}, session: 's', cwd: ${JSON.stringify(root)}, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} }, readMode: () => 'auto' })));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual([ran.status, ran.signal, ran.stdout], [0, null, '{"answer":"unknown"}']);
});

// The tool-name glob alone, the only rule, so its match runs: a glob read by backtracking, as a regular expression of
// `.*` runs would, takes time that grows with the stars, and the child process is stopped.
test('Claude Code reads a project tool-name glob with thousands of stars at once', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const root = path.join(config, 'work');
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/claude-code-push.mjs');
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: [`${'*'.repeat(10000)}x`] } }));
  const script = `import { pushPermission } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(pushPermission({ repository: ${JSON.stringify(REPOSITORY)}, session: 's', cwd: ${JSON.stringify(root)}, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} }, readMode: () => 'auto' })));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual([ran.status, ran.signal], [0, null], 'read within 5 seconds');
  assert.equal(JSON.parse(ran.stdout).answer, 'denied', 'a glob that matches no shell tool leaves the denial');
});

test('Claude Code answers unknown at once for a named pipe at its user settings, alone or behind a symlink', { skip: process.platform === 'win32' }, (t) => {
  for (const linked of [false, true]) {
    const config = claudeSettings(t, undefined);
    const pipe = path.join(config, linked ? 'pipe' : 'settings.json');
    assert.equal(spawnSync('mkfifo', [pipe]).status, 0, 'mkfifo');
    if (linked) symlinkSync(pipe, path.join(config, 'settings.json'));
    const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/claude-code-push.mjs');
    const script = `import { pushPermission } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(pushPermission({ repository: ${JSON.stringify(REPOSITORY)}, session: 's', cwd: '/x', env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} }, readMode: () => 'auto' })));`;
    const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
    assert.deepEqual([ran.status, ran.signal, ran.stdout], [0, null, '{"answer":"unknown"}'], linked ? 'behind a symlink' : 'alone');
  }
});

test('Claude Code reads no mode, at once, from a named pipe in a transcript\'s place', { skip: process.platform === 'win32' }, (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const cwd = path.join(config, 'work');
  const transcripts = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  assert.equal(spawnSync('mkfifo', [path.join(transcripts, 'session-1.jsonl')]).status, 0, 'mkfifo');
  const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/index.mjs');
  const script = `import { HOSTS, pushPermission } from ${JSON.stringify(module)};
const host = HOSTS.find((each) => each.id === 'claude-code');
process.stdout.write(JSON.stringify(pushPermission(host, { repository: ${JSON.stringify(REPOSITORY)}, session: 'session-1', cwd: ${JSON.stringify(cwd)}, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} } })));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual([ran.status, ran.signal, ran.stdout], [0, null, '{"answer":"unknown"}']);
});

test('Claude Code follows a symlink to its user settings', { skip: process.platform === 'win32' }, (t) => {
  const config = claudeSettings(t, undefined);
  const real = path.join(config, 'real.json');
  writeFileSync(real, JSON.stringify(trusting(['Trusted repo: github.com/acme/other'])));
  symlinkSync(real, path.join(config, 'settings.json'));
  assert.equal(askClaude(config).answer, 'denied');
});

test('Claude Code answers unknown outside auto mode and then reads no settings file', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  for (const mode of ['acceptEdits', 'manual', 'plan', 'dontAsk', null, '(unreadable)', undefined]) {
    const read = [];
    const env = new Proxy({ CLAUDE_CONFIG_DIR: config }, { get: (target, name) => { read.push(name); return target[name]; } });
    let asked = null;
    const readMode = (ask) => { asked = ask; return mode; };
    assert.deepEqual(claudePushPermission({ repository: REPOSITORY, session: 'session-1', cwd: '/work', env, readMode }), { answer: 'unknown' }, String(mode));
    assert.deepEqual(read, [], `${mode}: no config folder looked up, so no settings file read`);
    assert.equal(asked.env, env);
    assert.deepEqual([asked.session, asked.cwd], ['session-1', '/work'], 'the mode is read for the session about to start work');
  }
});

test('Claude Code\'s adapter answers denied from a transcript in auto mode and settings that trust only another remote', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const cwd = path.join(config, 'work');
  const transcripts = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  const lines = [{ type: 'permission-mode', permissionMode: 'manual', sessionId: 'session-1' }, { type: 'permission-mode', permissionMode: 'auto', sessionId: 'session-1' }];
  writeFileSync(path.join(transcripts, 'session-1.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  const claudeCode = HOSTS.find((host) => host.id === 'claude-code');
  const read = pushPermission(claudeCode, { repository: REPOSITORY, session: 'session-1', cwd, env: { CLAUDE_CONFIG_DIR: config } });
  assert.equal(read.answer, 'denied');
  assert.deepEqual(Object.keys(read).sort(), ['answer', 'file', 'fix', 'setting', 'why']);
  assert.equal(read.setting, 'autoMode.environment');
  assert.equal(read.file, path.join(config, 'settings.json'));
  assert.ok(read.fix.includes(REPOSITORY));
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify(trusting(['$defaults'])));
  assert.deepEqual(pushPermission(claudeCode, { repository: REPOSITORY, session: 'session-1', cwd, env: { CLAUDE_CONFIG_DIR: config } }), { answer: 'allowed' });
  assert.deepEqual(pushPermission(claudeCode, { repository: REPOSITORY, session: 'session-2', cwd, env: { CLAUDE_CONFIG_DIR: config } }), { answer: 'unknown' }, 'a session with no transcript');
});

// capabilities.mergePermission: whether a host blocks by default a merge no human approved, and no setting it can read names one.
// Shared code reads it only through mergePermission in lib/hosts/index.mjs, for a preflight note. Claude Code answers
// `uncovered` for one shape alone, checked on fixtures only, from its documentation.
const UNCOVERED = { answer: 'uncovered', setting: 'a.setting', file: '/x/settings.json', why: 'it blocks a merge' };

test('the merge permission is unknown for a host without it, one that throws, a junk answer, and an uncovered it cannot name', () => {
  assert.deepEqual(MERGE_ANSWERS, ['uncovered', 'unknown']);
  const others = HOSTS.filter((host) => host.id !== 'claude-code');
  for (const host of [...others, fakeHost, UNKNOWN_HOST]) assert.equal(host.capabilities.mergePermission, undefined, `${host.id} leaves the capability out`);
  for (const host of [...others, fakeHost, UNKNOWN_HOST, null, undefined, {}, { capabilities: null }]) {
    assert.deepEqual(mergePermission(host, { session: 's', cwd: '/x', env: {} }), { answer: 'unknown' }, String(host?.id));
  }
  const answering = (read) => ({ ...fakeHost, capabilities: { ...fakeHost.capabilities, mergePermission: () => read } });
  assert.deepEqual(mergePermission({ capabilities: { mergePermission: () => { throw new Error('boom'); } } }, {}), { answer: 'unknown' });
  const rejected = Promise.reject(new Error('later'));
  for (const read of [undefined, null, 'uncovered', 7, [], {}, { answer: 'allowed' }, { answer: 'covered' }, { ...UNCOVERED, answer: 'denied' }, rejected, Promise.resolve(UNCOVERED)]) {
    assert.deepEqual(mergePermission(answering(read), {}), { answer: 'unknown' }, String(read?.answer ?? read));
  }
  for (const field of ['setting', 'file', 'why']) {
    for (const value of [undefined, '', '  ', 7, null, 'two\nlines', 'a\u0007bell', 'a line']) {
      assert.deepEqual(mergePermission(answering({ ...UNCOVERED, [field]: value }), {}), { answer: 'unknown' }, `${field}: ${JSON.stringify(value)}`);
    }
  }
  assert.deepEqual(mergePermission(answering({ ...UNCOVERED, file: 'settings.json' }), {}), { answer: 'unknown' }, 'a file that is not absolute');
  assert.deepEqual(mergePermission(answering({ ...UNCOVERED, extra: 'kept out' }), {}), UNCOVERED);
  assert.deepEqual(mergePermission(answering({ answer: 'unknown', setting: 'x' }), {}), { answer: 'unknown' });
  let asked = null;
  const ask = { session: 's', cwd: '/x', env: {} };
  mergePermission({ capabilities: { mergePermission: (given) => { asked = given; return UNCOVERED; } } }, ask);
  assert.equal(asked, ask, 'the capability gets the ask as given');
});

const askMerge = (config, extra = {}) => claudeMergePermission({ session: 'session-1', cwd: config, env: { CLAUDE_CONFIG_DIR: config }, readMode: inAuto, ...extra });
const rules = (list, ...entries) => ({ permissions: { [list]: entries } });

test('Claude Code in auto mode answers uncovered when no readable setting names a merge, and unknown beside any that may', (t) => {
  const cases = [
    ['no permissions and no auto mode list', {}, 'uncovered'],
    ['narrow rules that reach no merge', { permissions: { allow: ['Bash(git push:*)', 'Bash(git merge-base:*)', 'Bash(npm test)', 'Read(**)'], deny: ['Bash(rm:*)'], ask: ['Bash(gh pr create *)'] } }, 'uncovered'],
    ['an allow list that speaks of no merge', { autoMode: { allow: ['$defaults', 'Deploying to staging is allowed'] } }, 'uncovered'],
    ['custom block lists that keep the built-in rules', { autoMode: { soft_deny: ['$defaults', 'Never merge on Fridays'], hard_deny: ['$defaults'], classifyAllShell: true } }, 'uncovered'],
    ['an allow rule for the merge command', rules('allow', 'Bash(gh pr merge:*)'), 'unknown'],
    ['an allow rule for the command\'s program', rules('allow', 'Bash(gh:*)'), 'unknown'],
    ['an allow rule with a glob inside', rules('allow', 'Bash(gh pr *)'), 'unknown'],
    ['an allow rule that names the repository first', rules('allow', 'Bash(gh -R acme/widget pr merge 12)'), 'unknown'],
    ['a broad shell rule', rules('allow', 'Bash(*)'), 'unknown'],
    ['a tool-name glob', rules('allow', 'B*'), 'unknown'],
    ['a tool that merges a pull request', rules('allow', 'mcp__github__merge_pull_request'), 'unknown'],
    ['a deny rule', rules('deny', 'Bash(gh pr merge *)'), 'unknown'],
    ['an ask rule', rules('ask', 'Bash(GH PR  MERGE *)'), 'unknown'],
    ['an allow entry that speaks of a merge', { autoMode: { allow: ['$defaults', 'Merging reviewed work is allowed'] } }, 'unknown'],
    ['an allow entry that speaks of pull requests', { autoMode: { allow: ['Pull requests of acme/widget may land'] } }, 'unknown'],
    ['an allow entry that speaks of a PR', { autoMode: { allow: ['Landing a PR is routine'] } }, 'unknown'],
    ['an environment entry that speaks of a merge', { autoMode: { environment: ['$defaults', 'Our bot merges everything'] } }, 'unknown'],
    ['a block list without the built-in rules', { autoMode: { soft_deny: ['Never drop a table'] } }, 'unknown'],
    ['a hard block list without the built-in rules', { autoMode: { hard_deny: [] } }, 'unknown'],
    ['an auto mode that is no object', { autoMode: [] }, 'unknown'],
    ['an auto mode of null', { autoMode: null }, 'unknown'],
    ['an allow that is no list', { autoMode: { allow: 'none' } }, 'unknown'],
    ['an allow that holds a non-string', { autoMode: { allow: [7] } }, 'unknown'],
    ['a block list that is no list', { autoMode: { soft_deny: '$defaults' } }, 'unknown'],
    ['an auto mode key this does not know', { autoMode: { soft_allow: [] } }, 'unknown'],
    ['permissions that are no object', { permissions: [] }, 'unknown'],
    ['a rule list that is no list', { permissions: { allow: 'Bash' } }, 'unknown'],
    ['a rule that is no string', { permissions: { deny: [{}] } }, 'unknown'],
    ['a file that is no JSON', '{ nope', 'unknown'],
    ['a file that is no object', '[]', 'unknown'],
    ['a file over the size limit', JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }), 'unknown'],
    ['no user settings file', undefined, 'unknown'],
  ];
  for (const [name, settings, answer] of cases) {
    const config = claudeSettings(t, settings);
    const read = askMerge(config);
    assert.equal(read.answer, answer, name);
    if (answer === 'unknown') {
      assert.deepEqual(read, { answer }, name);
      continue;
    }
    assert.deepEqual([read.setting, read.file], ['autoMode.allow', path.join(config, 'settings.json')], name);
    assert.match(read.why, /blocks by default a merge of a pull request no human approved, and the settings this check can read hold no rule or entry that names a merge$/u, name);
    assert.deepEqual(mergePermission({ capabilities: { mergePermission: () => read } }, {}), read, 'the registry passes it on');
  }
});

test('Claude Code reads no project settings for a merge: an issue session loads the user settings alone', (t) => {
  for (const name of ['settings.json', 'settings.local.json']) {
    for (const text of [JSON.stringify(rules('allow', 'Bash(gh pr merge:*)')), JSON.stringify({ autoMode: { allow: ['Merging is fine'] } }), '{ nope']) {
      const config = claudeSettings(t, {});
      const cwd = path.join(config, 'work');
      mkdirSync(path.join(cwd, '.claude'), { recursive: true });
      mkdirSync(path.join(cwd, '.git'));
      writeFileSync(path.join(cwd, '.claude', name), text);
      assert.equal(askMerge(config, { cwd }).answer, 'uncovered', `${name}: ${text}`);
    }
  }
  const config = claudeSettings(t, {});
  assert.deepEqual(askMerge(config, { env: { CLAUDE_CONFIG_DIR: 'relative' } }), { answer: 'unknown' }, 'a config folder that is not absolute');
});

test('Claude Code answers the merge permission unknown outside auto mode and then reads no settings file', (t) => {
  const config = claudeSettings(t, {});
  for (const mode of ['acceptEdits', 'manual', 'plan', 'dontAsk', null, '(unreadable)', undefined]) {
    const read = [];
    const env = new Proxy({ CLAUDE_CONFIG_DIR: config }, { get: (target, name) => { read.push(name); return target[name]; } });
    assert.deepEqual(claudeMergePermission({ session: 'session-1', cwd: '/work', env, readMode: () => mode }), { answer: 'unknown' }, String(mode));
    assert.deepEqual(read, [], `${mode}: no config folder looked up, so no settings file read`);
  }
});

test('Claude Code\'s adapter answers uncovered from a transcript in auto mode, and writes no settings', (t) => {
  const config = claudeSettings(t, {});
  const cwd = path.join(config, 'work');
  const transcripts = path.join(config, 'projects', cwd.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(path.join(transcripts, 'session-1.jsonl'), `${JSON.stringify({ type: 'permission-mode', permissionMode: 'auto', sessionId: 'session-1' })}\n`);
  const claudeCode = HOSTS.find((host) => host.id === 'claude-code');
  const env = { CLAUDE_CONFIG_DIR: config };
  assert.equal(mergePermission(claudeCode, { session: 'session-1', cwd, env }).answer, 'uncovered');
  assert.deepEqual(mergePermission(claudeCode, { session: 'session-2', cwd, env }), { answer: 'unknown' }, 'a session with no transcript');
  assert.equal(readFileSync(path.join(config, 'settings.json'), 'utf8'), '{}', 'the settings file is as it was');
  assert.equal(existsSync(path.join(cwd, '.claude')), false, 'no project settings file is made');
});

// capabilities.backgroundSessions: which background sessions a host holds, which of a given set it still holds, or
// why it cannot. Shared code reads `list` and `held` only through backgroundList and backgroundHeld in
// lib/hosts/index.mjs, which never throw, and `stopLine` directly, through a guard that catches a throw; a run stops a
// held session through capabilities.projectStart.stop, never through backgroundSessions.
// Every call here goes through the run stand-in, so no test starts a process.
const CLAUDE = '/usr/local/bin/claude';
const WORKING = '306d6ea0-6f93-4ac6-abe0-473db3caabb0';
const BLOCKED = '42cf8d0a-1111-4222-8333-444455556666';
const DONE = '189eaf3d-aaaa-4bbb-8ccc-ddddeeeeffff';
const OWN = '0badf00d-1234-4567-89ab-cdef01234567';
const TASKED = '48fd3d0f-5555-4666-8777-888899990000';
// The row shapes `claude agents --json` gave on 2.1.331: the interactive session itself, which carries no `id`, a
// background one at work, one waiting on a response, one whose turn ended that the supervisor still holds, and one
// whose turn ended while a task it started still runs (`state: "working"`, `status: "idle"`). `startedAt` is a number of
// milliseconds on every row.
const ROWS_2_1_331 = [
  { kind: 'interactive', sessionId: OWN, name: 'main', cwd: '/work', startedAt: 1_700_000_000_000, state: 'working', status: 'busy', pid: 101 },
  { kind: 'background', id: '306d6ea0', sessionId: WORKING, name: 'widget · 1', cwd: '/runs/w/1', startedAt: 1_700_000_100_000, state: 'working', status: 'busy', pid: 102 },
  { kind: 'background', id: '42cf8d0a', sessionId: BLOCKED, name: 'TAX-8 · 1', cwd: '/runs/t/8', startedAt: 1_700_000_200_000, state: 'blocked', status: 'idle', pid: 103 },
  { kind: 'background', id: '189eaf3d', sessionId: DONE, name: 'harness-supporter', cwd: '/work', startedAt: 1_700_000_300_000, state: 'done', status: 'idle', pid: 104 },
  { kind: 'background', id: '48fd3d0f', sessionId: TASKED, name: 'opencode · 10', cwd: '/work', startedAt: 1_700_000_400_000, state: 'working', status: 'idle', pid: 105 },
];

// A fake `claude` whose `agents --json` lists `rows` (a string is printed as it is), recording each call's arguments.
function agentsListing(rows, { status = 0 } = {}) {
  const calls = [];
  const run = (_claude, args) => {
    calls.push(args);
    return { status, stdout: typeof rows === 'string' ? rows : JSON.stringify(rows), stderr: '' };
  };
  return { run, calls, resolve: () => CLAUDE };
}

const hostOf = (id) => HOSTS.find((host) => host.id === id);
const oneLine = (text) => typeof text === 'string' && text.trim() !== '' && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text);

test('every host and the unknown host answer backgroundList with rows or a one-line reason, and never throw', () => {
  const run = () => { throw new Error('no process may start'); };
  for (const host of [...HOSTS, fakeHost, UNKNOWN_HOST, null, undefined, {}]) {
    const read = backgroundList(host, { env: {}, run });
    const reason = read.problem ?? read.unsupported;
    assert.ok(Array.isArray(read.sessions) || oneLine(reason), `${host?.id}: ${JSON.stringify(read)}`);
    const held = backgroundHeld(host, { sessions: [{ id: 'abcd1234', session: null }], env: {}, run });
    assert.ok(Array.isArray(held.held) || oneLine(held.problem ?? held.unsupported), `${host?.id}: ${JSON.stringify(held)}`);
  }
  assert.deepEqual(Object.keys(backgroundList(hostOf('claude-code'), { env: {}, run })), ['problem'], 'Claude Code with no claude on PATH');
  assert.match(backgroundList(hostOf('claude-code'), { env: {}, run }).problem, /`claude` is not on PATH/u);
});

test('Codex and OpenCode say by design that they hold no idle background session, apart from a failure', () => {
  // Each declares its reason and nothing else, so neither wrapper asks it anything or starts a process.
  const run = () => { throw new Error('no process may start'); };
  for (const [id, reason] of [['codex', /codex exec/u], ['opencode', /starts no background session/u]]) {
    const host = hostOf(id);
    assert.deepEqual(Object.keys(host.capabilities.backgroundSessions), ['unsupported'], `${id} declares its reason and nothing else`);
    for (const read of [backgroundList(host, { env: {}, run }), backgroundHeld(host, { sessions: [{ id: 'x' }], env: {}, run })]) {
      assert.deepEqual(Object.keys(read).sort(), ['byDesign', 'unsupported'], id);
      assert.equal(read.byDesign, true);
      assert.match(read.unsupported, reason);
    }
  }
  for (const host of [fakeHost, UNKNOWN_HOST]) {
    const read = backgroundList(host, { env: {} });
    assert.ok(oneLine(read.problem), host.id);
    assert.equal(read.byDesign, undefined, `${host.id}: a host that says nothing is a problem, not a design`);
  }
});

test('Claude Code maps the 2.1.331 row shapes, reading the listing once without --all', () => {
  const { run, calls, resolve } = agentsListing(ROWS_2_1_331);
  const read = listBackground({ env: {}, run, resolve });
  assert.deepEqual(calls, [['agents', '--json']]);
  assert.deepEqual(read, {
    sessions: [
      { id: '306d6ea0', session: WORKING, name: 'widget · 1', cwd: '/runs/w/1', startedAt: 1_700_000_100_000, idle: false, waiting: false },
      { id: '42cf8d0a', session: BLOCKED, name: 'TAX-8 · 1', cwd: '/runs/t/8', startedAt: 1_700_000_200_000, idle: true, waiting: true },
      { id: '189eaf3d', session: DONE, name: 'harness-supporter', cwd: '/work', startedAt: 1_700_000_300_000, idle: true, waiting: false },
      { id: '48fd3d0f', session: TASKED, name: 'opencode · 10', cwd: '/work', startedAt: 1_700_000_400_000, idle: false, waiting: false },
    ],
  }, 'a row still working is never idle, whatever its status says');
});

test('Claude Code leaves out a row it cannot hold to a background session, and backgroundList reads an unprintable name or folder as null', () => {
  const rows = [
    { kind: 'background', id: 'aaaa1111', sessionId: 'no', name: 'short id', cwd: '/x', status: 'idle' },
    { kind: 'background', id: 'bbbb2222', name: 'no session id', cwd: '/x', status: 'idle' },
    { kind: 'background', sessionId: 'cccc3333-0000', name: 'two\nlines', cwd: '/x\u202e', status: 'IDLE', state: 'done' },
    { kind: 'background', id: 'bad id!', sessionId: 'dddd4444-0000', name: 7, cwd: null, startedAt: '2023-11-14T22:20:00.000Z', status: 'idle' },
    { kind: 'background', id: 'eeee5555', sessionId: 'eeee5555-0000', name: 'stopped', cwd: '/x', startedAt: Number.NaN, state: 'stopped', status: 'idle' },
    { kind: 'background', id: 'ffff6666', sessionId: 'ffff6666-0000', name: '   ', cwd: ' ', state: 'done', status: 'idle' },
    null,
    'text',
  ];
  const { run, resolve } = agentsListing(rows);
  // The adapter passes the listing's name, folder, and start time on as they are: only backgroundList cleans them.
  assert.deepEqual(listBackground({ env: {}, run, resolve }).sessions.map(({ name, cwd, startedAt }) => [name, cwd, startedAt]), [
    ['two\nlines', '/x\u202e', undefined], [7, null, '2023-11-14T22:20:00.000Z'], ['stopped', '/x', null], ['   ', ' ', undefined],
  ]);
  const host = { ...fakeHost, capabilities: { backgroundSessions: { list: ({ env }) => listBackground({ env, run, resolve }) } } };
  assert.deepEqual(backgroundList(host, { env: {} }), {
    sessions: [
      { id: 'cccc3333-0000', session: 'cccc3333-0000', name: null, cwd: null, startedAt: null, idle: false, waiting: false },
      { id: 'dddd4444-0000', session: 'dddd4444-0000', name: null, cwd: null, startedAt: null, idle: false, waiting: false },
      { id: 'eeee5555', session: 'eeee5555-0000', name: 'stopped', cwd: '/x', startedAt: null, idle: false, waiting: false },
      { id: 'ffff6666', session: 'ffff6666-0000', name: null, cwd: null, startedAt: null, idle: true, waiting: false },
    ],
  }, 'a status other than idle, in any case, is never idle, nor idle in no state or another state; with no row id, the session id names it; a startedAt that is no number reads null; a name or folder of spaces only reads null');
});

test('Claude Code answers a problem when claude is not on PATH and when the listing gives no answer', () => {
  assert.match(listBackground({ env: {}, run: () => ({ status: 0, stdout: '[]' }), resolve: () => null }).problem, /`claude` is not on PATH/u);
  assert.match(heldSessions({ sessions: [{ id: '306d6ea0' }], env: {}, run: () => ({ status: 0, stdout: '[]' }), resolve: () => null }).problem, /`claude` is not on PATH/u);
  for (const [what, listing] of [['an exit 1', agentsListing([], { status: 1 })], ['no JSON', agentsListing('not json')], ['no list', agentsListing('{}')]]) {
    assert.match(listBackground({ env: {}, ...listing }).problem, /`claude agents --json` did not answer/u, what);
    assert.match(heldSessions({ sessions: [{ id: '306d6ea0' }], env: {}, ...listing }).problem, /`claude agents --json` did not answer/u, what);
  }
  const failed = { env: {}, run: () => ({ error: Object.assign(new Error('spawn'), { code: 'ETIMEDOUT' }) }), resolve: () => CLAUDE };
  assert.ok(oneLine(listBackground(failed).problem));
});

test('Claude Code held matches a full id, a printed short id, and no row, from one listing read', () => {
  const { run, calls, resolve } = agentsListing(ROWS_2_1_331);
  const sessions = [
    { id: '42cf8d0a', session: BLOCKED },
    { id: 'zzzz9999', session: DONE },
    { id: '306d6ea0', session: null },
    { id: '306d6e' },
    { id: 'ffff0000', session: 'ffff0000-1111-4222-8333-444455556666' },
    { id: '0badf00d', session: OWN },
    { id: '48fd3d0f', session: TASKED },
    { id: '' },
    {},
  ];
  assert.deepEqual(heldSessions({ sessions, env: {}, run, resolve }), { held: [true, true, true, true, false, false, true, null, null] },
    'the full id decides when given; a short id matches the row id or the start of its session id; an interactive row is no background session');
  assert.deepEqual(calls, [['agents', '--json']]);
});

test('Claude Code\'s adapter answers backgroundList and backgroundHeld through a claude on PATH', { skip: process.platform === 'win32' }, (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-bg-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n');
  chmodSync(path.join(bin, 'claude'), 0o755);
  const claudeCode = hostOf('claude-code');
  const { run, calls } = agentsListing(ROWS_2_1_331);
  const env = { PATH: bin };
  assert.deepEqual(backgroundList(claudeCode, { env, run }).sessions.map(({ id, idle }) => [id, idle]), [['306d6ea0', false], ['42cf8d0a', true], ['189eaf3d', true], ['48fd3d0f', false]]);
  assert.deepEqual(backgroundHeld(claudeCode, { sessions: [{ id: '189eaf3d', session: DONE }, { id: 'ffff0000' }], env, run }), { held: [true, false] });
  assert.deepEqual(calls, [['agents', '--json'], ['agents', '--json']]);
  const { stop, stopLine } = claudeCode.capabilities.backgroundSessions;
  assert.equal(stop, undefined, 'a run stops a held session with the project start\'s stop');
  assert.equal(stopLine({ id: '189eaf3d' }), '`claude stop 189eaf3d` stops it');
});

test('the background session wrappers turn a throw, a promise, and each wrong shape into a problem', () => {
  const answering = (backgroundSessions) => ({ ...fakeHost, capabilities: { ...fakeHost.capabilities, backgroundSessions } });
  const lists = (read) => answering({ list: () => read, held: () => read });
  const isProblem = (read, what) => {
    assert.deepEqual(Object.keys(read), ['problem'], `${what}: ${JSON.stringify(read)}`);
    assert.ok(oneLine(read.problem), what);
  };
  const rejected = Promise.reject(new Error('later'));
  const wrong = [
    ['no answer', undefined], ['null', null], ['text', 'idle'], ['an array', []], ['an empty object', {}],
    ['an empty problem', { problem: '' }], ['a blank problem', { problem: '  ' }], ['a problem on two lines', { problem: 'a\nb' }],
    ['a problem with a bidi mark', { problem: 'a\u202eb' }], ['a problem that is no text', { problem: 7 }],
    ['an empty unsupported', { unsupported: '' }], ['an unsupported with a zero-width space', { unsupported: 'a\u200bb' }],
    ['a call that answers unsupported, which only the whole capability declares', { unsupported: 'it holds none' }],
    ['a rejected promise', rejected], ['a promise', Promise.resolve({ sessions: [] })],
  ];
  for (const [what, read] of wrong) {
    isProblem(backgroundList(lists(read), {}), `list: ${what}`);
    isProblem(backgroundHeld(lists(read), { sessions: [{ id: 'a' }] }), `held: ${what}`);
  }
  for (const [what, sessions] of [['no array', { id: 'a' }], ['a row that is no object', ['a']], ['a row with no id', [{ session: 'x' }]], ['an empty id', [{ id: '' }]], ['an id that is no text', [{ id: 7 }]], ['an id on two lines', [{ id: 'a\nb' }]]]) {
    isProblem(backgroundList(lists({ sessions }), {}), `sessions: ${what}`);
  }
  const throwing = answering({ list: () => { throw new Error('boom'); }, held: () => { throw new Error('boom'); } });
  isProblem(backgroundList(throwing, {}), 'list throws');
  isProblem(backgroundHeld(throwing, { sessions: [{ id: 'a' }] }), 'held throws');
  const getter = { get sessions() { throw new Error('boom'); } };
  isProblem(backgroundList(lists(getter), {}), 'a getter that throws');
  isProblem(backgroundHeld(lists({ get held() { throw new Error('boom'); } }), { sessions: [{ id: 'a' }] }), 'a held getter that throws');
  isProblem(backgroundHeld(lists({ held: [] }), { get sessions() { throw new Error('boom'); } }), 'an ask whose sessions getter throws');
  const unnamed = { get name() { throw new Error('boom'); }, get id() { throw new Error('boom'); }, capabilities: { backgroundSessions: { list: () => ({ sessions: [] }), held: () => ({ held: [true] }) } } };
  assert.deepEqual(backgroundList(unnamed, {}), { sessions: [] }, 'a host name getter that throws');
  assert.deepEqual(backgroundHeld(unnamed, { sessions: [{ id: 'a' }] }), { held: [true] }, 'a host name getter that throws');
  const hidden = { get capabilities() { throw new Error('boom'); } };
  isProblem(backgroundList(hidden, {}), 'a capabilities getter that throws');
  isProblem(backgroundHeld(hidden, { sessions: [{ id: 'a' }] }), 'a capabilities getter that throws');
  for (const [what, held] of [['shorter', [true]], ['longer', [true, false, null]], ['no array', true], ['a value outside true, false, null', [true, 'yes']]]) {
    isProblem(backgroundHeld(lists({ held }), { sessions: [{ id: 'a' }, { id: 'b' }] }), `held: ${what}`);
  }
  for (const [what, ask] of [['no ask', undefined], ['no sessions', {}], ['sessions no array', { sessions: 'a' }], ['a member that is no object', { sessions: ['a'] }]]) {
    isProblem(backgroundHeld(lists({ held: [] }), ask), `ask: ${what}`);
  }
  isProblem(backgroundList(answering({ held: () => ({ held: [] }) }), {}), 'no list');
  isProblem(backgroundHeld(answering({ list: () => ({ sessions: [] }) }), { sessions: [{ id: 'a' }] }), 'no held');
  isProblem(backgroundList(answering(null), {}), 'a capability that is null');
  for (const host of [...HOSTS, fakeHost, UNKNOWN_HOST]) {
    for (const read of [backgroundList(host, { env: {} }), backgroundList(answering(() => {}), {}), backgroundHeld(lists({ held: 1 }), { sessions: [] })]) {
      const reason = read.problem ?? read.unsupported;
      assert.ok(!reason.startsWith(host.name), `${host.id}: a reason follows the host's name, never repeats it: ${reason}`);
    }
  }
});

test('the background session wrappers pass a clear answer on, with only the fields of a row', () => {
  let asked = null;
  const row = { id: 'abcd1234', session: 'abcd1234-0000', name: 'widget · 1', cwd: '/w', startedAt: 5, idle: true, waiting: false, extra: 'kept out' };
  const host = { ...fakeHost, capabilities: { ...fakeHost.capabilities, backgroundSessions: {
    list: (ask) => { asked = ask; return { sessions: [row, { id: 'efgh5678', name: 'a\u202eb', cwd: 'x\ny', startedAt: 'soon', idle: 'yes' }] }; },
    held: (ask) => { asked = ask; return { held: ask.sessions.map((each) => each.id === 'abcd1234') }; },
  } } };
  const ask = { env: {}, run: () => ({}) };
  assert.deepEqual(backgroundList(host, ask), { sessions: [
    { id: 'abcd1234', session: 'abcd1234-0000', name: 'widget · 1', cwd: '/w', startedAt: 5, idle: true, waiting: false },
    { id: 'efgh5678', session: null, name: null, cwd: null, startedAt: null, idle: false, waiting: false },
  ] });
  assert.equal(asked, ask, 'the capability gets the ask as given');
  const heldAsk = { sessions: [{ id: 'abcd1234' }, { id: 'zzzz0000' }], env: {} };
  assert.deepEqual(backgroundHeld(host, heldAsk), { held: [true, false] });
  assert.equal(asked, heldAsk);
  assert.deepEqual(backgroundHeld(host, { sessions: [] }), { held: [] });
  assert.deepEqual(backgroundList({ ...fakeHost, capabilities: { backgroundSessions: { list: () => ({ problem: 'the listing timed out' }) } } }, {}), { problem: 'the listing timed out' });
});

test('humanPrompts dates each transcript entry by the adapter\'s entryTime, and Claude Code reads its timestamp', () => {
  const input = { transcript_path: '/transcripts/s-1.jsonl', session_id: 's-1' };
  const host = (extra) => ({ ...UNKNOWN_HOST, id: 'stub', payloadMark: () => true, humanPrompt: () => true, ownTranscript: (file) => file, ...extra });
  const dated = humanPrompts(input, [host({ entryTime: (entry) => entry.t })]);
  assert.equal(dated.timeOf({ t: 5 }), 5);
  assert.ok(Number.isNaN(dated.timeOf({ t: 'soon' })), 'a time that is no number is none');
  assert.ok(Number.isNaN(humanPrompts(input, [host({})]).timeOf({ t: 5 })), 'a host that declares no entryTime dates no entry');
  const claudeCode = HOSTS.find((each) => each.id === 'claude-code');
  assert.equal(claudeCode.entryTime({ timestamp: '2026-11-24T12:00:00.000Z' }), Date.parse('2026-11-24T12:00:00.000Z'));
  for (const entry of [{}, null, { timestamp: 7 }, { timestamp: 'not a time' }]) assert.ok(Number.isNaN(claudeCode.entryTime(entry)), JSON.stringify(entry));
});
