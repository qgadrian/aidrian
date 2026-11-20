// The conformance suite of lib/hosts/ and lib/trackers/: it iterates the registries, so a new adapter is checked by
// adding it, and a fixture adapter that is never shipped proves a new host or tracker needs nothing in shared code.
// A shipped host also needs its recorded payloads in test/fixtures/hosts/<id>/tracker.json.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os, { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { GUARDED_PATHS } from '../plugins/aidrian/lib/project.mjs';
import { CONTINUE_ROUTES } from '../plugins/aidrian/lib/config-schema.mjs';
import { pushPermission as claudePushPermission } from '../plugins/aidrian/lib/hosts/claude-code-push.mjs';
import { agentAliases, continueRoutes, deniedNames, detectHost, HOSTS, opaqueShellCommand, PUSH_ANSWERS, pushPermission, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
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
const fires = (matcher, name) => matcher === '*' || new RegExp(`^(?:${matcher})$`, 'u').test(name);

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
  return samples.filter(([event, name, tool]) => !fires(script(event, name).matcher, tool)).map(([event, name, tool]) => `${event} ${name} misses ${tool}`);
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
      const edit = host.fileEdit(tool, { file_path: 'a.md', path: 'a.md', content: 'x', body: 'x', new_string: 'x', old_string: 'y', command: '*** Begin Patch\n*** Add File: a.md\n+x\n*** End Patch\n' });
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

for (const host of HOSTS) {
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

  test(`host ${host.id}'s file edit tools reach the write hook`, () => {
    const matcher = HOOKS.PreToolUse.find((group) => group.hooks.some(({ command }) => command.includes('hook-write.mjs'))).matcher;
    for (const tool of host.fileEditTools) assert.ok(matcher.split('|').includes(tool), tool);
  });

  test(`host ${host.id}'s project folders keep auto-merge off`, () => {
    for (const folder of Object.values(host.projectFolders)) assert.ok(GUARDED_PATHS.test(`${folder}/x.md`), folder);
  });

  test(`host ${host.id}'s agent names answer to the plugin's short name`, () => {
    assert.ok(agentAliases(`${host.pluginAgentPrefix}explorer`).has('explorer'));
  });
}

for (const host of [...HOSTS, fakeHost]) {
  test(`host ${host.id}'s raw names fire each hooks.json matcher, as it reads hooks.json as it is`, () => {
    assert.equal(host.delivery, 'hooks-json');
    assert.deepEqual(matcherProblems(host), []);
  });
}

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
  for (const host of HOSTS) {
    const { pre, standard } = recorded(host);
    assert.equal(UNKNOWN_HOST.hookInput(pre).tool_name, standard.write);
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
  for (const name of ['plugins/aidrian/hooks/hooks.json', 'scripts/version.mjs', 'test/hosts.test.mjs', 'lib/agent-models.mjs', 'What the fixtures do not prove']) assert.ok(text.includes(name), name);
  assert.doesNotMatch(text, /hookEvents/u);
  for (const field of ['serverSpelling', 'nativeToolName', 'rawToolName', 'delivery', 'workspaceInput', 'unguardedRoutes', 'capabilities.pushPermission']) assert.ok(text.includes(`\`${field}`), field);
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
for (const host of HOSTS) {
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
      // The result `aidrian worktree new` prints, in the place the host's response holds the call's output: the whole
      // response when it is the output as one string, else its stdout.
      const printed = `${JSON.stringify({ status: 'created', worktree_path: path.join(root, 'tree'), branch: 'feat/linked' })}\n`;
      const response = typeof fixture.post.tool_response === 'string' ? printed : { ...fixture.post.tool_response, stdout: printed };
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

// A permission rule that allows the push the run will make approves it before auto mode's classifier runs, in the user
// settings or in the project's `.claude/settings.json` or `.claude/settings.local.json`: a rule for any remote that
// covers a plain `git push`, or one for `origin` with any branch. A narrower push rule settles nothing, but no denial
// stands beside it either, since it may be the very push the run makes.
const SETTLING_RULES = ['Bash(git push:*)', 'Bash(git push *)', 'Bash(git push)', 'Bash(git push*)', 'Bash(git:*)', 'Bash(git *)', ' Bash( git push:* ) ', 'Bash(git push origin:*)', 'Bash(git push origin *)', 'Bash(git push * *)'];
const NARROWER_RULES = ['Bash(git push origin main)', 'Bash(git * main)', 'Bash(git push upstream:*)', 'Bash(git push upstream *)', 'Bash(git push --force:*)', 'Bash(git push -u origin:*)', 'Bash(git push origin feat/*)', 'Bash(git push origin)'];

test('Claude Code answers allowed for a permission rule that allows the push the run makes, and unknown, not denied, for a narrower push rule', (t) => {
  const ONLY_OTHER = trusting(['Trusted repo: github.com/acme/other']);
  const TRUSTED = trusting(['Trusted repo: github.com/acme/widget']);
  const withRules = (environment, allow) => ({ ...environment, permissions: { allow } });
  for (const rule of SETTLING_RULES) {
    assert.deepEqual(askClaude(claudeSettings(t, withRules(ONLY_OTHER, ['Bash(git status)', rule]))), { answer: 'allowed' }, `settles: ${rule}`);
    // With no auto mode list the rule still approves the push before any classifier reads one.
    assert.deepEqual(askClaude(claudeSettings(t, { permissions: { allow: [rule] } })), { answer: 'allowed' }, `settles with no autoMode: ${rule}`);
  }
  for (const rule of NARROWER_RULES) {
    assert.deepEqual(askClaude(claudeSettings(t, withRules(ONLY_OTHER, ['Bash(git status)', rule]))), { answer: 'unknown' }, `narrower, would deny: ${rule}`);
    assert.deepEqual(askClaude(claudeSettings(t, withRules(TRUSTED, [rule]))), { answer: 'allowed' }, `narrower, a trusted remote: ${rule}`);
    assert.deepEqual(askClaude(claudeSettings(t, { permissions: { allow: [rule] } })), { answer: 'unknown' }, `narrower, no autoMode: ${rule}`);
  }
});

// A `permissions.deny` rule refuses a matching command in every mode, and a `permissions.ask` rule asks before it, with
// no one there to answer in a run no Human attends; both come before auto mode's trust and before any allow rule.
test('Claude Code answers denied for a deny or ask rule that matches the push the run makes, before trust and allow rules', (t) => {
  const user = (settings) => {
    const config = claudeSettings(t, settings);
    return { config, read: askClaude(config) };
  };
  const environments = [
    ['another remote', trusting(['Trusted repo: github.com/acme/other'])],
    ['"$defaults"', trusting(['$defaults'])],
    ['a trusted remote', trusting(['Trusted repo: github.com/acme/widget'])],
    ['no autoMode', {}],
  ];
  for (const [key, setting] of [['deny', 'permissions.deny'], ['ask', 'permissions.ask']]) {
    for (const rule of ['Bash(git push:*)', 'Bash(git push *)', 'Bash(git:*)', 'Bash(git push origin:*)', 'Bash', 'Bash(*)']) {
      for (const [label, environment] of environments) {
        const { config, read } = user({ ...environment, permissions: { allow: ['Bash(git push:*)'], [key]: ['Bash(git status)', rule] } });
        assert.equal(read.answer, 'denied', `${key} ${rule}, ${label}`);
        assert.equal(read.setting, setting, `${key} ${rule}, ${label}`);
        assert.equal(read.file, path.join(config, 'settings.json'), `${key} ${rule}, ${label}`);
        assert.ok(read.why.includes(`\`${rule}\``), `${key} ${rule}: ${read.why}`);
        assert.deepEqual(pushPermission({ capabilities: { pushPermission: () => read } }, {}), read, 'the registry passes the denial on');
      }
    }
    assert.match(user({ permissions: { [key]: ['Bash(git push:*)'] } }).read.fix, /removes that rule/u, key);
    // A rule for another push settles nothing: the run may make a push it does not match.
    for (const rule of ['Bash(git push origin main)', 'Bash(git push upstream:*)', 'Bash(git push --force:*)', 'Bash(git status)', 'Read(**)']) {
      assert.deepEqual(user({ ...trusting(['$defaults']), permissions: { [key]: [rule] } }).read, { answer: 'allowed' }, `${key} ${rule}`);
    }
    // A rule too long to quote on one line is named without its text.
    const long = user({ permissions: { [key]: [`Bash(git *${'*'.repeat(300)})`] } }).read;
    assert.equal(long.answer, 'denied', key);
    assert.ok(!long.why.includes('*'.repeat(300)) && long.why.includes('a rule'), `${key}: ${long.why}`);
  }
  // Deny comes before ask: the deny rule is the one named.
  assert.equal(user({ permissions: { ask: ['Bash(git push:*)'], deny: ['Bash(git push:*)'] } }).read.setting, 'permissions.deny');
  // In the project's files, from the session's folder.
  for (const name of ['settings.json', 'settings.local.json']) {
    for (const key of ['deny', 'ask']) {
      const config = claudeSettings(t, trusting(['$defaults']));
      const root = path.join(config, 'work');
      mkdirSync(path.join(root, '.claude'), { recursive: true });
      mkdirSync(path.join(root, '.git'));
      writeFileSync(path.join(root, '.claude', name), JSON.stringify({ permissions: { [key]: ['Bash(git push *)'] } }));
      const read = askClaude(config, { cwd: root });
      assert.deepEqual([read.answer, read.setting, read.file], ['denied', `permissions.${key}`, path.join(root, '.claude', name)], `${name} ${key}`);
    }
  }
  // An unreadable file, or deny and ask rules of another shape, say nothing for certain: unknown.
  for (const settings of ['{"permissions": {', { ...trusting(['$defaults']), permissions: { deny: 'Bash(git push:*)' } }, { ...trusting(['$defaults']), permissions: { ask: [7] } }, { ...trusting(['$defaults']), permissions: 'Bash' }]) {
    assert.deepEqual(user(settings).read, { answer: 'unknown' }, JSON.stringify(settings));
  }
  const config = claudeSettings(t, trusting(['$defaults']));
  const root = path.join(config, 'work');
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, '.claude', 'settings.json'), '{"permissions": {"deny": ');
  assert.deepEqual(askClaude(config, { cwd: root }), { answer: 'unknown' }, 'a project file that cannot be read');
});

test('Claude Code answers unknown, not denied, when a permission rule may allow a git push, in the user or the project settings', (t) => {
  const ONLY_OTHER = trusting(['Trusted repo: github.com/acme/other']);
  const withRules = (allow) => ({ ...ONLY_OTHER, permissions: { allow } });
  // Unrelated rules, and the broad ones auto mode drops on entry: bare `Bash`, `Bash(*)`, and a leading wildcard.
  const unrelated = ['Bash(git status)', 'Bash(git pull:*)', 'Bash(git pushall)', 'Bash(git:* push)', 'Bash(npm run *)', 'Read(**)', 'WebFetch', 'Bash(gh pr view:*)', 'Bash', 'Bash(*)', 'Bash(* --version)', 'Bash()'];
  for (const rule of SETTLING_RULES) assert.deepEqual(askClaude(claudeSettings(t, withRules(['Bash(git status)', rule]))), { answer: 'allowed' }, `user file: ${rule}`);
  for (const rule of NARROWER_RULES) assert.deepEqual(askClaude(claudeSettings(t, withRules(['Bash(git status)', rule]))), { answer: 'unknown' }, `user file: ${rule}`);
  for (const rule of unrelated) assert.equal(askClaude(claudeSettings(t, withRules([rule]))).answer, 'denied', `user file: ${rule}`);
  // The project's files, in the session's folder and in the root of the repository it is in.
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
    assert.deepEqual(project({ [name]: { permissions: { allow: ['Bash(git push:*)'] } } }), { answer: 'allowed' }, name);
    assert.deepEqual(project({ [name]: { permissions: { allow: ['Bash(git push *)'] } } }, { below: true }), { answer: 'allowed' }, `${name} at the repository root, from a folder below it`);
    assert.deepEqual(project({ [name]: { permissions: { allow: ['Bash(git push origin main)'] } } }), { answer: 'unknown' }, `${name}: a narrower rule`);
    assert.equal(project({ [name]: { permissions: { allow: ['Bash(git status)'] } } }).answer, 'denied', `${name}: an unrelated rule`);
    assert.equal(project({ [name]: { permissions: { deny: ['Bash(git push:*)'] } } }).answer, 'denied', `${name}: a deny rule`);
    // A project file that is there and cannot be read, or rules of another shape: no denial stands.
    for (const settings of ['{"permissions": {', '[]', { permissions: 'Bash' }, { permissions: { allow: 'Bash(git push:*)' } }, { permissions: { allow: [7] } }]) {
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
  writeFileSync(path.join(main, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git push *)'] } }));
  assert.deepEqual(askClaude(config, { cwd: worktree }), { answer: 'allowed' }, 'the main checkout\'s local settings, from a worktree');
  assert.deepEqual(askClaude(claudeSettings(t, ONLY_OTHER), { cwd: 'work' }), { answer: 'unknown' }, 'a relative folder');
  assert.deepEqual(askClaude(claudeSettings(t, { ...ONLY_OTHER, permissions: { allow: 'Bash' } })), { answer: 'unknown' }, 'user rules of another shape');
});

// A project's checked-in `.claude/settings.json` chooses its rules' globs, so matching one against `git push` takes time
// linear in its length, never time that grows with its stars. Run in a child process, so a hang fails, not blocks.
test('Claude Code answers unknown at once for a project allow rule with thousands of stars', (t) => {
  const config = claudeSettings(t, trusting(['Trusted repo: github.com/acme/other']));
  const root = path.join(config, 'work');
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  const module = path.join(ROOT, 'plugins/aidrian/lib/hosts/claude-code-push.mjs');
  // `g` starts some `git push`, so the rule may allow one: no denial stands beside it.
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [`Bash(g${'*'.repeat(10000)}z)`] } }));
  const script = `import { pushPermission } from ${JSON.stringify(module)};
process.stdout.write(JSON.stringify(pushPermission({ repository: ${JSON.stringify(REPOSITORY)}, session: 's', cwd: ${JSON.stringify(root)}, env: { CLAUDE_CONFIG_DIR: ${JSON.stringify(config)} }, readMode: () => 'auto' })));`;
  const ran = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.deepEqual([ran.status, ran.signal, ran.stdout], [0, null, '{"answer":"unknown"}']);
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
