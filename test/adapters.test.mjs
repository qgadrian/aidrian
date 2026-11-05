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
  for (const field of ['serverSpelling', 'nativeToolName', 'rawToolName', 'delivery', 'workspaceInput', 'unguardedRoutes']) assert.ok(text.includes(`\`${field}`), field);
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
