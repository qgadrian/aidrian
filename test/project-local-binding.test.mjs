// projectRun.localBinding: the team's switch that lets an issue session bind local ports, read from the default branch
// on the forge and the local ref alike, never a working copy. Off, the default, a session's sandbox keeps
// `allowLocalBinding: false`, the organization's managed settings may not set it true, and the sandbox proof probes its
// localhost listener; on, the sandbox starts with `allowLocalBinding: true`, a managed true or false passes, and
// preflight prints a note naming the host's risk. The proof drops its listener only where the session reaches this
// machine's loopback as the host runs it: on macOS, with no managed source keeping allowLocalBinding false.
// Checked on fixtures only (test/project-start-fixture.mjs, on Linux); Codex's side is in project-start-codex.test.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { accessProblem, localBindingRisk, loopbackReach, sandboxSettings } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { CONFINE_PLAN, confineCheck, probeAll } from '../plugins/aidrian/lib/project-confine.mjs';
import { localBindingNote } from '../plugins/aidrian/lib/project-preflight.mjs';
import { teamPolicy } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { runFixture, STARTED } from './project-start-fixture.mjs';

const REPOSITORY = { host: 'github.com', owner: 'acme', name: 'widgets' };
const ON = { allow: true, unverifiedHosts: true, localBinding: true };
const OFF = { allow: true, unverifiedHosts: true };

// Managed settings in `dir`, each document of `values` a managed-settings.d file, lowest rank first: { dir, plists }.
function managedAt(dir, values = []) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'managed-settings.d'), { recursive: true });
  values.forEach((value, index) => writeFileSync(path.join(dir, 'managed-settings.d', `${10 + index}.json`), JSON.stringify(value)));
  return { dir, plists: [] };
}

// Runs `body` with the adapter's loopback judged as on macOS, under the managed settings `managed`, then puts it back.
function asMacOs(t, managed) {
  const cap = claudeCode.capabilities.projectStart;
  const own = cap.confineLoopback;
  cap.confineLoopback = ({ localBinding }) => loopbackReach({ platform: 'darwin', localBinding, managed });
  t.after(() => {
    cap.confineLoopback = own;
  });
}

// The start of ENG-1 in `fx`: its --settings value, and the proof's plan in the attempt's folder.
function started(fx) {
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 0, [...result.out, ...result.err].join('\n'));
  const [{ args }] = fx.claude.starts();
  const folder = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1');
  return { settings: JSON.parse(args[args.indexOf('--settings') + 1]), plan: JSON.parse(readFileSync(path.join(folder, CONFINE_PLAN), 'utf8')), folder };
}

test('projectRun.localBinding is a boolean, false by default, and true in the team policy only when the forge and the local ref both set it', (t) => {
  const plain = runFixture(t, { init: false });
  assert.equal(loadConfig(plain.project).config.projectRun.localBinding, false);
  const bad = runFixture(t, { init: false, projectRun: { ...OFF, localBinding: 'yes' } });
  assert.match(loadConfig(bad.project).errors.join('\n'), /"projectRun\.localBinding" must be true or false/u);
  const policy = (options) => {
    const fx = runFixture(t, { init: false, ...options });
    return teamPolicy(fx.project, REPOSITORY, fx.forge).localBinding;
  };
  assert.equal(policy({ projectRun: ON }), true, 'both');
  assert.equal(policy({ projectRun: ON, forgeConfig: { version: 1, projectRun: OFF } }), false, 'the local ref alone');
  assert.equal(policy({ projectRun: OFF, forgeConfig: { version: 1, projectRun: ON } }), false, 'the forge alone');
  assert.equal(policy({}), false, 'neither');
});

test('a working copy that sets projectRun.localBinding starts a session whose sandbox still refuses local binding', (t) => {
  const fx = runFixture(t);
  const file = path.join(fx.dir, '.aidrian', 'config.json');
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), projectRun: ON }));
  const { settings, plan } = started(fx);
  assert.equal(settings.sandbox.network.allowLocalBinding, false);
  assert.equal(plan.local.host, '127.0.0.1', 'the proof still probes its localhost listener');
});

test('off, the session\'s sandbox refuses local binding and the proof probes its listener; on Linux, it binds and the listener stays required', (t) => {
  const off = started(runFixture(t));
  assert.equal(off.settings.sandbox.network.allowLocalBinding, false);
  assert.equal(off.plan.local.host, '127.0.0.1');
  assert.ok(Number.isInteger(off.plan.local.port));
  // The fixture's platform is Linux, where the host keeps the session's commands off this machine's loopback.
  const linux = started(runFixture(t, { projectRun: ON }));
  assert.equal(linux.settings.sandbox.network.allowLocalBinding, true);
  assert.equal(linux.plan.local.host, '127.0.0.1', 'the listener stays required on Linux');
  assert.ok(Number.isInteger(linux.plan.local.port));
});

test('on macOS a managed allowLocalBinding false keeps the listener required', (t) => {
  const fx = runFixture(t, { projectRun: ON });
  asMacOs(t, managedAt(path.join(fx.root, 'managed'), [{ sandbox: { network: { allowLocalBinding: false } } }]));
  const kept = started(fx);
  assert.equal(kept.settings.sandbox.network.allowLocalBinding, true);
  assert.equal(kept.plan.local.host, '127.0.0.1');
});

test('on macOS with no managed false, the session reaches the loopback, so the proof runs no listener, judged from the start and never the plan', (t) => {
  const fx = runFixture(t, { projectRun: ON });
  asMacOs(t, managedAt(path.join(fx.root, 'managed')));
  const on = started(fx);
  assert.equal(on.settings.sandbox.network.allowLocalBinding, true);
  assert.deepEqual([on.settings.sandbox.network.strictAllowlist, on.settings.sandbox.network.allowAllUnixSockets], [true, false], 'nothing else of the network widens');
  assert.equal(on.plan.local, null, 'no listener to probe');
  assert.equal(existsSync(path.join(on.folder, 'confine-listener.json')), false);
  // The start judges the listener from the team's policy, never the plan: a plan with no listener fails a check made
  // for a run that does not allow local binding.
  assert.deepEqual(confineCheck({ folder: on.folder, session: STARTED[0].session, loopback: true }), { pass: true });
  assert.match(confineCheck({ folder: on.folder, session: STARTED[0].session }).problem, /localhost listener outside the sandbox is not the one the start ran/u);
});

test('a plan with no listener probes no loopback connection', async (t) => {
  const fx = runFixture(t, { projectRun: ON });
  asMacOs(t, managedAt(path.join(fx.root, 'managed')));
  const { plan } = started(fx);
  assert.equal(plan.local, null);
  // The unlisted host a closed local port, so no test reaches the network.
  const results = await probeAll({ ...plan, unlisted: { host: '127.0.0.1', port: 9 } }, {});
  const reaches = results.filter((each) => each.probe === 'reach');
  assert.deepEqual(reaches.map((each) => each.target), ['127.0.0.1:9']);
});

test('the session reaches the loopback only on macOS, with the key on, where the highest managed source that sets allowLocalBinding sets it true', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-binding-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'managed');
  const reach = (values, more = {}) => loopbackReach({ platform: 'darwin', localBinding: true, managed: managedAt(dir, values), ...more });
  assert.equal(reach([]), true, 'no managed source sets it');
  assert.equal(reach([{ sandbox: { network: { allowLocalBinding: false } } }]), false, 'a managed false');
  assert.equal(reach([{ sandbox: { network: { allowLocalBinding: false } } }, { sandbox: { network: { allowLocalBinding: true } } }]), true, 'a higher managed true');
  assert.equal(reach([{ sandbox: { network: { allowLocalBinding: true } } }, { sandbox: { network: { allowLocalBinding: false } } }]), false, 'a higher managed false');
  assert.equal(reach([], { platform: 'linux' }), false, 'Linux');
  assert.equal(reach([], { localBinding: false }), false, 'the key off');
  writeFileSync(path.join(dir, 'managed-settings.json'), 'not json');
  assert.equal(loopbackReach({ platform: 'darwin', localBinding: true, managed: { dir, plists: [] } }), false, 'managed settings that cannot be read keep the listener');
});

test('the sandbox settings take allowLocalBinding from localBinding alone', () => {
  const base = { work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home: '/home/u', platform: 'linux' };
  assert.equal(sandboxSettings(base).sandbox.network.allowLocalBinding, false);
  assert.equal(sandboxSettings({ ...base, localBinding: true }).sandbox.network.allowLocalBinding, true);
  assert.equal(sandboxSettings({ ...base, localBinding: 'yes' }).sandbox.network.allowLocalBinding, false, 'only true turns it on');
});

test('the organization\'s managed allowLocalBinding passes only at false, or at either value where the team allows local binding', (t) => {
  const fx = runFixture(t, { init: false });
  const dir = path.join(fx.root, 'managed');
  const ask = (value, localBinding) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ sandbox: { network: { allowLocalBinding: value } } }));
    return accessProblem({ env: fx.env, home: fx.home, guarded: [fx.state], pushUrl: 'https://github.com/acme/widgets.git', platform: 'linux', managed: { dir, plists: [] }, localBinding });
  };
  assert.equal(ask(false, false), null);
  assert.match(ask(true, false), /managed-settings\.json set sandbox\.network\.allowLocalBinding/u);
  assert.equal(ask(true, true), null);
  assert.equal(ask(false, true), null, 'false only narrows the session');
  assert.match(ask('yes', true), /set sandbox\.network\.allowLocalBinding/u, 'a value that is neither');
});

test('preflight prints the local-binding note naming the host\'s risk only when the forge and the local ref both set it', (t) => {
  const out = (options) => {
    const fx = runFixture(t, { init: false, ...options });
    return fx.cmd(['preflight']).out;
  };
  const on = out({ projectRun: ON });
  assert.ok(on.includes(localBindingNote(claudeCode.capabilities.projectStart, 'linux')), on.join('\n'));
  const mac = localBindingNote(claudeCode.capabilities.projectStart, 'darwin');
  assert.match(mac, /^note local-binding: the team lets issue sessions bind local ports \(projectRun\.localBinding\): on macOS .*every interface of this machine.*other machines the firewall lets through.*reaches every service listening on this machine's loopback.*bind each test server to 127\.0\.0\.1, never 0\.0\.0\.0$/u);
  assert.equal(mac.includes(localBindingRisk({ platform: 'darwin' })), true);
  assert.match(localBindingNote(claudeCode.capabilities.projectStart, 'linux'), /on Linux .*network namespace of their own/u);
  assert.match(localBindingNote(codex.capabilities.projectStart, 'darwin'), /on Codex .*no longer refuses private and link-local addresses/u);
  assert.match(localBindingNote({}, 'darwin'), /may listen on this machine's network interfaces.*127\.0\.0\.1/u, 'a host that names no risk');
  assert.match(localBindingNote({ localBindingRisk: () => { throw new Error('x'); } }, 'darwin'), /may listen on this machine's network interfaces/u);
  assert.ok(!out({}).some((line) => line.startsWith('note local-binding')), 'off');
  assert.ok(!out({ projectRun: OFF, forgeConfig: { version: 1, projectRun: ON } }).some((line) => line.startsWith('note local-binding')), 'the forge alone');
});
