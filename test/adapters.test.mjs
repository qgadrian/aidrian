// The conformance suite of lib/hosts/ and lib/trackers/: it iterates the registries, so a new adapter is checked by
// adding it, and a fixture adapter that is never shipped proves a new host or tracker needs nothing in shared code.
// A shipped host also needs its recorded payloads in test/fixtures/hosts/<id>/tracker.json.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { nameMatches } from '../plugins/aidrian/lib/agent-gates.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { GUARDED_PATHS } from '../plugins/aidrian/lib/project.mjs';
import { agentAliases, detectHost, HOSTS, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import { trackerWarnings } from '../plugins/aidrian/lib/tracker-check.mjs';
import { judgeTrackerWrite, readTrackerValue, serverPrefix } from '../plugins/aidrian/lib/tracker-guard.mjs';
import { expandTracker, knownServers, readToolsOf, TRACKERS, writeToolsOf } from '../plugins/aidrian/lib/trackers/index.mjs';
import fakeHost from './fixtures/adapters/fake-host.mjs';
import fakeTracker from './fixtures/adapters/fake-tracker.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const HOOKS = JSON.parse(readFileSync(path.join(ROOT, 'plugins/aidrian/hooks/hooks.json'), 'utf8')).hooks;
const STANDARD_MCP = /^mcp__[^_].*?__.+$/u;
const SHAPES = new Set(['write', 'edit', 'notebook', 'patch']);
const VERIFIED = new Set(['live', 'source', 'none']);

const recorded = (host) => JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/hosts', host.id, 'tracker.json'), 'utf8'));

for (const host of [...HOSTS, fakeHost]) {
  test(`host ${host.id} declares every field of an adapter`, () => {
    for (const field of ['id', 'name', 'ai', 'modelsKey', 'pluginAgentPrefix']) assert.ok(typeof host[field] === 'string' && host[field] !== '', field);
    assert.notEqual(host.id, UNKNOWN_HOST.id);
    for (const field of ['detect', 'sessionId', 'agentName', 'effort', 'runEnv', 'agentAliases', 'toolName', 'toolResponse', 'hookInput', 'fileEdit']) {
      assert.equal(typeof host[field], 'function', field);
    }
    for (const field of ['identityVars', 'detectVars', 'fileEditTools']) assert.ok(Array.isArray(host[field]) && host[field].every((each) => typeof each === 'string'), field);
    assert.ok(host.fileEditTools.length > 0);
    assert.equal(typeof host.capabilities.transcripts, 'boolean');
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

  test(`host ${host.id} maps every event hooks.json uses`, () => {
    assert.deepEqual(Object.keys(host.hookEvents).sort(), Object.keys(HOOKS).sort());
    for (const event of Object.values(host.hookEvents)) assert.ok(event === null || typeof event === 'string');
  });
}

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

for (const tracker of [...TRACKERS, fakeTracker]) {
  test(`tracker ${tracker.id} declares every field of an adapter`, () => {
    for (const field of ['id', 'name', 'readTool', 'workspaceField']) assert.ok(typeof tracker[field] === 'string' && tracker[field] !== '', field);
    assert.ok(!tracker.readTool.includes('*'), 'a read tool is an exact name');
    assert.ok(tracker.writeVerbs.length > 0);
    assert.ok(tracker.team.createFields.length > 0 && tracker.team.keyFields.length > 0);
    assert.ok(typeof tracker.project.field === 'string');
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
    const value = expandTracker({ enabled: true, workspace: { expect: 'https://x.example/a' }, team: { key: 'ABC', values: ['A'] }, project: { values: ['P'] } }, tracker);
    const servers = knownServers(tracker);
    assert.deepEqual(value.readTools, readToolsOf(tracker, servers));
    assert.deepEqual(value.writeTools, writeToolsOf(tracker, servers));
    for (const read of value.readTools) assert.ok(!value.writeTools.some((pattern) => nameMatches(pattern, read)), read);
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
  const input = fakeHost.hookInput({ fakeTurn: 't', sessionId: 's', tool: 'faketracker/add_ticket', args: { projectKey: 'Beta' }, cwd: '/x' });
  assert.equal(input.tool_name, 'mcp__faketracker__add_ticket');
  const read = fakeHost.hookInput({ fakeTurn: 't', sessionId: 's', tool: 'faketracker/site_info', args: {}, result: { baseUrl: 'https://x.example/a' }, cwd: '/x' });
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

test('a host that declares a route it cannot guard makes it visible, and so does hook trust not given', () => {
  const tracker = { enabled: true, readTools: [], writeTools: ['mcp__x__save_*'], team: { key: 'A', values: ['A'], createFields: ['team'], keyFields: ['id'] } };
  const warnings = trackerWarnings(tracker, { env: {}, hosts: [fakeHost] });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /on Fake Host, a write through its hosted connectors passes unchecked: they run on its servers/u);
  assert.match(warnings[1], /Fake Host has no trust on record .* run fakehost trust/u);
  assert.deepEqual(trackerWarnings({ ...tracker, enabled: false }, { env: {}, hosts: [fakeHost] }), [], 'silent while the guard is off');
});

test('the check warns of a known connection the lists leave out on a host set up here, with what to do, whatever the tracker', () => {
  const adapter = fakeTracker;
  const here = { ...fakeHost, id: 'codex', name: 'A Host', capabilities: { trackerGuard: { unguardedRoutes: [], hookTrust: () => 'trusted' } } };
  const notHere = { ...here, capabilities: { trackerGuard: { unguardedRoutes: [], hookTrust: () => 'absent' } } };
  const written = { enabled: true, readTools: readToolsOf(adapter, ['faketracker']), writeTools: writeToolsOf(adapter, ['faketracker']) };
  const warnings = trackerWarnings(written, { env: {}, hosts: [here], trackers: [adapter] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no pattern covers Fake Tracker's server "codex_apps_faketracker" on A Host/u);
  assert.match(warnings[0], /set "provider": "faketracker" and drop both tool lists/u);
  assert.deepEqual(trackerWarnings(written, { env: {}, hosts: [notHere], trackers: [adapter] }), [], 'a host not set up here says nothing');
  const whole = knownServers(adapter);
  assert.deepEqual(trackerWarnings({ enabled: true, readTools: readToolsOf(adapter, whole), writeTools: writeToolsOf(adapter, whole) }, { env: {}, hosts: [here], trackers: [adapter] }), []);
});

// The recorded payloads through the real hooks: what the conformance above cannot see is the order of the two hooks,
// and that a refusal reaches the host as exit 2 with its reason on stderr.
for (const host of HOSTS) {
  test(`host ${host.id}: a recorded read then write run through the real tracker hooks`, (t) => {
    const { env, post, pre, workspace, standard } = recorded(host);
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
    assert.ok(first.stderr.includes(`Call ${standard.read}`) || first.stderr.includes(standard.read), first.stderr);

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
