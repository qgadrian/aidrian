import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkBrief, chainOf } from '../plugins/aidrian/lib/handoff-brief.mjs';
import { BRIEF_WINDOW, continueBrief, effectiveRoute } from '../plugins/aidrian/lib/handoff-continue.mjs';
import {
  arm,
  BRIEF_CAP,
  cancelArmed,
  checkedSha,
  noteFrom,
  openStore,
  promote,
  readArmed,
  readContainedBrief,
  readFrom,
  stampChecked,
  storePath,
  sweep,
  takeReady,
} from '../plugins/aidrian/lib/handoff-markers.mjs';
import { HOSTS, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const ADVICE = 'Advice from Claude, not a spec: check each claim against the docs and code before building on it.';
// A brief that passes `aidrian handoff check`: the advice line, a Supersedes field, and the five sections it requires.
const SECTIONS = '## Current state\n- Worktree: none yet | Branch: to create\n\n## Still running\nNone.\n\n## Next steps\n1. Ship it.\n\n## Open risks and questions\nNone.\n';
const brief = (chain = 0) => `# Handoff: continue the widget\nWritten: 2026-11-15 | Chain: ${chain} | Supersedes: none\n${ADVICE}\n\n## Objective\n- Ship the widget.\n\n${SECTIONS}`;
const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'session-1' };
const CODEX = { CODEX_THREAD_ID: 'thread-1' };
const SHA = 'a'.repeat(64);
const HOUR = 60 * 60 * 1000;

// A project whose config puts its state folder outside it, a handoffs folder there, and a fresh brief in it.
function setup(t, handoff = { continue: 'clear' }, { state: stateDir } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-continue-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const state = stateDir ?? path.join(root, 'state');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state }, session: { handoff } }));
  const handoffs = path.join(state === stateDir ? path.resolve(dir, state) : state, 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  const file = path.join(handoffs, '2026-11-15-widget.md');
  writeFileSync(file, brief());
  const store = openStore(path.dirname(handoffs), { checkouts: [dir], maxChain: 3 });
  return { root, dir, state: path.dirname(handoffs), handoffs, file, store };
}

const gate = (setting, args = {}) => continueBrief(args.brief ?? setting.file, { chainOf, cwd: setting.dir, env: { ...process.env, ...CLAUDE }, ...args });
const passCheck = (setting, file = setting.file) => assert.equal(checkBrief(file, undefined, 0, { store: setting.store }).exitCode, 0);
const marker = (setting, extra = {}) => ({ route: 'clear', session: 'session-1', brief: setting.file, slug: 'widget', chain: 0, sha256: SHA, ...extra });
const age = (file, ms) => utimesSync(file, new Date(Date.now() - ms), new Date(Date.now() - ms));

test('the store: armed, then ready at a clear, then taken once, and only by the same host process', (t) => {
  const setting = setup(t);
  const { store } = setting;
  assert.equal(readArmed(store, 'session-1'), null, 'a missing folder reads as nothing');
  assert.ok(arm(store, marker(setting)));
  assert.equal(readArmed(store, 'session-1').slug, 'widget');
  assert.deepEqual(readdirSync(store.dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
  assert.equal(promote(store, 'session-1', { hostPid: null }), null, 'no host process: nothing promoted');
  assert.equal(readArmed(store, 'session-1'), null, 'and the session is over');
  arm(store, marker(setting));
  const ready = promote(store, 'session-1', { hostPid: 4242 });
  assert.equal(ready.host_pid, 4242);
  assert.equal(readArmed(store, 'session-1'), null);
  assert.equal(takeReady(store, { hostPid: 4343 }), null, 'another host process never takes it');
  assert.equal(takeReady(store, { hostPid: 4242 }).session, 'session-1');
  assert.equal(takeReady(store, { hostPid: 4242 }), null, 'taken once');
  assert.deepEqual(readdirSync(store.dir), [], 'the claimed file goes');

  arm(store, marker(setting, { route: 'compact' }));
  assert.equal(promote(store, 'session-1', { hostPid: 4242 }), null, 'another route is not promoted at a clear');
  assert.equal(readArmed(store, 'session-1'), null, 'and is deleted with its session');
  arm(store, marker(setting));
  assert.equal(cancelArmed(store, 'session-1', { route: 'compact' }), null);
  assert.equal(cancelArmed(store, 'session-1', { route: 'clear' }).route, 'clear');
  assert.equal(readArmed(store, 'session-1'), null);
});

test('a ready marker is taken only within ten seconds after its session ended, never from the future', (t) => {
  const setting = setup(t);
  const { store } = setting;
  arm(setting.store, marker(setting));
  // Read after the write: a time taken before it may be earlier than the file's own modification time.
  const now = Date.now();
  assert.ok(promote(store, 'session-1', { hostPid: 4242, now }));
  assert.equal(takeReady(store, { hostPid: 4242, now: now + 11_000 }), null, 'too old');
  assert.equal(takeReady(store, { hostPid: 4242, now: now - 5_000 }), null, 'ended in the future');
  assert.equal(takeReady(store, { hostPid: 4242, now: now + 9_000 }).slug, 'widget');
});

test('of two ready markers of one host process, the newest is taken', (t) => {
  const setting = setup(t);
  const { store } = setting;
  arm(store, marker(setting, { session: 'older' }));
  arm(store, marker(setting, { session: 'newer' }));
  const now = Date.now();
  assert.ok(promote(store, 'older', { hostPid: 4242, now }));
  assert.ok(promote(store, 'newer', { hostPid: 4242, now: now + 1000 }));
  assert.equal(takeReady(store, { hostPid: 4242, now: now + 2000 }).session, 'newer');
  assert.equal(takeReady(store, { hostPid: 4242, now: now + 2000 }).session, 'older');
});

test('every read refuses a symlink, a wrong shape, and a time outside its window either way', (t) => {
  const setting = setup(t);
  const { store } = setting;
  const write = (name, value) => {
    mkdirSync(store.dir, { recursive: true });
    writeFileSync(path.join(store.dir, name), JSON.stringify(value));
  };
  const armed = { ...marker(setting), armed_at: Date.now() };
  for (const [label, value] of [
    ['a route outside the list', { ...armed, route: 'teleport' }],
    ['the route none', { ...armed, route: 'none' }],
    ['a slug outside the pattern', { ...armed, slug: '-widget' }],
    ['a chain past maxChain', { ...armed, chain: 4 }],
    ['a chain that is no whole number', { ...armed, chain: 1.5 }],
    ['a short sha256', { ...armed, sha256: 'abc' }],
    ['another session', { ...armed, session: 'session-2' }],
    ['a relative brief', { ...armed, brief: '2026-11-15-widget.md' }],
    ['a brief of another slug', { ...armed, brief: path.join(setting.handoffs, '2026-11-15-other.md') }],
    ['an armed time in the future', { ...armed, armed_at: Date.now() + HOUR }],
    ['an armed time past a day', { ...armed, armed_at: Date.now() - 25 * HOUR }],
  ]) {
    write('armed-session-1.json', value);
    assert.equal(readArmed(store, 'session-1'), null, label);
  }
  write('armed-session-1.json', armed);
  assert.ok(readArmed(store, 'session-1'));
  const file = path.join(store.dir, 'armed-session-1.json');
  utimesSync(file, new Date(Date.now() + HOUR), new Date(Date.now() + HOUR));
  assert.equal(readArmed(store, 'session-1'), null, 'a file modified in the future');
  age(file, 25 * HOUR);
  assert.equal(readArmed(store, 'session-1'), null, 'a file modified past a day ago');

  write('real.json', armed);
  rmSync(file);
  symlinkSync(path.join(store.dir, 'real.json'), file);
  assert.equal(readArmed(store, 'session-1'), null, 'a symlink');
  assert.equal(readArmed(store, '../real'), null, 'a session id that cannot name a file');

  write('ready-session-1.json', { ...armed, ended_at: Date.now(), host_pid: 1 });
  assert.equal(takeReady(store, { hostPid: 1 }), null, 'a host process id of 1');
  assert.ok(existsSync(path.join(store.dir, 'ready-session-1.json')), 'a refused marker is not claimed');
  assert.equal(noteFrom(store, 'session-1', { slug: 'widget', chain: 1.5, brief: setting.file, route: 'clear' }), null, 'no write of a wrong shape');
  assert.ok(noteFrom(store, 'session-1', { slug: 'widget', chain: 3, brief: setting.file, route: 'clear' }));
  assert.equal(readFrom(store, 'session-1').chain, 3);
  // A floor above the maxChain of the config that reads it is stricter, never void: a lower maxChain cannot drop it.
  assert.ok(noteFrom(store, 'session-1', { slug: 'widget', chain: 4, brief: setting.file, route: 'background' }));
  assert.equal(readFrom(store, 'session-1').chain, 4);
});

test('the sweep removes markers past a day and floors past thirty days, and leaves other files', (t) => {
  const setting = setup(t);
  const { store } = setting;
  arm(store, marker(setting));
  noteFrom(store, 'session-1', { slug: 'widget', chain: 1, brief: setting.file, route: 'clear' });
  noteFrom(store, 'session-2', { slug: 'widget', chain: 1, brief: setting.file, route: 'clear' });
  writeFileSync(path.join(store.dir, '.armed-x.json.1.0123456789ab.tmp'), '');
  writeFileSync(path.join(store.dir, 'notes.txt'), '');
  for (const name of ['armed-session-1.json', 'from-session-1.json', '.armed-x.json.1.0123456789ab.tmp', 'notes.txt']) age(path.join(store.dir, name), 25 * HOUR);
  age(path.join(store.dir, 'from-session-2.json'), 31 * 24 * HOUR);
  sweep(store);
  assert.deepEqual(readdirSync(store.dir).sort(), ['from-session-1.json', 'notes.txt']);
  sweep(openStore(path.join(setting.root, 'nowhere'), { maxChain: 3 }));
});

test('a store inside a checkout is never written or read', (t) => {
  const setting = setup(t, { continue: 'clear' }, { state: '.state' });
  assert.match(setting.store.refused, /is inside the checkout/u);
  assert.equal(arm(setting.store, marker(setting)), null);
  assert.equal(stampChecked(setting.store, setting.file, SHA), null);
  assert.equal(existsSync(storePath(setting.state)), false);
  const result = gate(setting);
  assert.deepEqual([result.exitCode, result.out[0]], [0, 'continue: none']);
  assert.match(result.out[1], /^fallback: the continuation store \S+ is inside the checkout /u);
});

test('effectiveRoute: --route picks none, clear, or compact whatever the config says, and background only when it says background', () => {
  const every = { name: 'every', capabilities: { handoffContinue: { routes: ['clear', 'compact', 'background'] } } };
  for (const configured of ['none', 'clear', 'compact', 'background']) {
    for (const override of ['none', 'clear', 'compact']) assert.deepEqual(effectiveRoute(configured, every, override), { route: override, fallback: null });
  }
  // The background route asks its gate: this machine's switch and the base branch's config.
  const open = () => ({ ok: true, maxChain: 2 });
  assert.deepEqual(effectiveRoute('background', every, 'background', open), { route: 'background', fallback: null, maxChain: 2 });
  assert.deepEqual(effectiveRoute('background', every, undefined, () => ({ ok: false, why: 'shut' })), { route: 'clear', fallback: 'shut; this handoff goes on by the clear route' });
  const backgroundOnly = { name: 'bg', capabilities: { handoffContinue: { routes: ['background'] } } };
  assert.deepEqual(effectiveRoute('background', backgroundOnly, undefined, () => ({ ok: false, why: 'shut' })), { route: 'none', fallback: 'shut; a person resumes the brief' });
  assert.equal(effectiveRoute('background', every).route, 'clear', 'no gate given is a gate that says no');
  for (const configured of ['none', 'clear', 'compact']) {
    const { route, fallback } = effectiveRoute(configured, every, 'background');
    assert.equal(route, 'none');
    assert.match(fallback, /session\.handoff\.continue is "background"/u);
  }
  assert.deepEqual(effectiveRoute('compact', every), { route: 'compact', fallback: null });
  const claude = HOSTS.find((host) => host.capabilities.handoffContinue?.routes.includes('clear'));
  assert.equal(effectiveRoute('compact', claude).route, 'none', 'a route the host does not list falls back');
  assert.equal(effectiveRoute('clear', UNKNOWN_HOST).route, 'none');
  assert.match(effectiveRoute('clear', UNKNOWN_HOST).fallback, /does not run on this host/u);
});

test('the gate arms a checked, fresh brief and says what the Human does', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const result = gate(setting);
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.equal(result.out[0], 'continue: clear');
  assert.match(result.out[1], /^say: To continue from the brief widget, type \S+, then any message\. The new session resumes from \S+2026-11-15-widget\.md; .*session-continue skill and the slug widget\.$/u);
  const armed = readArmed(setting.store, 'session-1');
  const sha = createHash('sha256').update(readFileSync(setting.file)).digest('hex');
  assert.deepEqual({ ...armed, armed_at: 0 }, { route: 'clear', session: 'session-1', brief: setting.file, slug: 'widget', chain: 0, sha256: sha, armed_at: 0 });
});

test('the gate prints continue: none for none, and a fallback line for what cannot run here, arming nothing', (t) => {
  const setting = setup(t, { continue: 'none' });
  passCheck(setting);
  assert.deepEqual(gate(setting), { exitCode: 0, out: ['continue: none'], err: [] });
  const none = (result, pattern) => {
    assert.deepEqual([result.exitCode, result.out[0], result.out.length], [0, 'continue: none', 2]);
    assert.match(result.out[1], pattern);
    assert.equal(readArmed(setting.store, 'session-1'), null);
  };
  none(gate(setting, { override: 'compact' }), /^fallback: the compact route does not run on this host/u);
  none(gate(setting, { override: 'background' }), /^fallback: --route background runs only when/u);
  none(gate(setting, { override: 'clear', env: { ...process.env, ...CODEX } }), /^fallback: the clear route does not run on this host \(Codex\)/u);
  none(gate(setting, { override: 'clear', env: process.env }), /^fallback: the clear route does not run on this host \(unknown\)/u);
  none(gate(setting, { override: 'clear', env: { ...process.env, CLAUDECODE: '1' } }), /^fallback: this host tells the command no session id/u);
  none(gate(setting, { override: 'clear', env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'a/b' } }), /no session id/u);
  writeFileSync(setting.file, brief(3));
  passCheck(setting);
  none(gate(setting, { override: 'clear' }), /^fallback: this brief has Chain 3, and session\.handoff\.maxChain allows 3/u);
  const odd = path.join(setting.handoffs, '2026-11-15-_widget.md');
  writeFileSync(odd, brief());
  none(gate(setting, { override: 'clear', brief: odd }), /^fallback: the slug "_widget" is not/u);

  writeFileSync(setting.file, brief(2));
  passCheck(setting);
  assert.equal(gate(setting, { override: 'clear' }).out[0], 'continue: clear', '--route clear arms while the config says none');
  assert.ok(readArmed(setting.store, 'session-1'));
  gate(setting, { override: 'none' });
  assert.equal(readArmed(setting.store, 'session-1'), null, 'a later run that continues nothing cancels the earlier marker');
});

test('the gate refuses, exit 1, a brief with no passing check of its bytes, or one too old or dated in the future', (t) => {
  const setting = setup(t);
  const refused = (result, pattern) => {
    assert.deepEqual([result.exitCode, result.out], [1, []]);
    assert.match(result.err.join('\n'), pattern);
    assert.equal(readArmed(setting.store, 'session-1'), null);
  };
  refused(gate(setting), /no passing check of its current text: run `aidrian handoff check \S+` first/u);
  passCheck(setting);
  writeFileSync(setting.file, `${brief()}- One more line.\n`);
  refused(gate(setting), /no passing check/u);
  passCheck(setting);
  age(setting.file, BRIEF_WINDOW + 60_000);
  refused(gate(setting), /was last written 16 minutes ago, .*refresh the brief/u);
  utimesSync(setting.file, new Date(Date.now() + HOUR), new Date(Date.now() + HOUR));
  refused(gate(setting), /is dated in the future/u);
  writeFileSync(setting.file, brief('two'));
  assert.equal(checkBrief(setting.file, undefined, 0, { store: setting.store }).exitCode, 1, 'the check fails it');
  refused(gate(setting), /no passing check/u);
});

test('the gate takes only a regular brief right inside the handoffs folder, named and sized as a brief: exit 2 otherwise', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const outside = path.join(setting.dir, '2026-11-15-widget.md');
  writeFileSync(outside, brief());
  const link = path.join(setting.handoffs, '2026-11-15-linked.md');
  symlinkSync(setting.file, link);
  const misnamed = path.join(setting.handoffs, 'widget.md');
  writeFileSync(misnamed, brief());
  const deeper = path.join(setting.handoffs, '.prior');
  mkdirSync(deeper, { recursive: true });
  writeFileSync(path.join(deeper, '2026-11-15-widget.md'), brief());
  const big = path.join(setting.handoffs, '2026-11-15-big.md');
  writeFileSync(big, `${brief()}${'x'.repeat(BRIEF_CAP)}\n`);
  for (const [file, pattern] of [
    [outside, /is not in /u],
    [link, /is a symlink$/u],
    [misnamed, /is not named <UTC date>-<slug>\.md$/u],
    [path.join(deeper, '2026-11-15-widget.md'), /is not in /u],
    [big, /bytes or more$/u],
    [path.join(setting.handoffs, '2026-11-15-missing.md'), /does not exist/u],
    [setting.handoffs, /is not a regular file$/u],
  ]) {
    const result = gate(setting, { brief: file });
    assert.equal(result.exitCode, 2, file);
    assert.match(result.err[0], pattern, file);
  }
  assert.equal(gate(setting, { override: 'teleport' }).exitCode, 2, 'an unknown --route');
  assert.equal(readArmed(setting.store, 'session-1'), null);
});

test('a brief whose parent path is spelled in another letter case is stamped and armed on a disk that folds case', (t) => {
  const setting = setup(t);
  const spelled = path.join(setting.root, 'STATE', 'handoffs', path.basename(setting.file));
  if (!existsSync(spelled)) return t.skip('this disk keeps letter case apart');
  assert.ok(stampChecked(setting.store, spelled, SHA), 'the stamp is recorded');
  passCheck(setting, spelled);
  const result = gate(setting, { brief: spelled });
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.equal(result.out[0], 'continue: clear');
  assert.equal(readArmed(setting.store, 'session-1').slug, 'widget');
});

test('a brief in a sibling folder of the handoffs folder is refused, also through a folder link', (t) => {
  const setting = setup(t);
  const sibling = path.join(setting.state, 'handoffs-copy');
  mkdirSync(sibling);
  const copy = path.join(sibling, path.basename(setting.file));
  writeFileSync(copy, brief());
  const linked = path.join(setting.state, 'linked');
  symlinkSync(sibling, linked);
  for (const file of [copy, path.join(linked, path.basename(setting.file))]) {
    assert.match(readContainedBrief(setting.store, file).problem, /is not in /u, file);
    assert.equal(stampChecked(setting.store, file, SHA), null, file);
    const result = gate(setting, { brief: file });
    assert.equal(result.exitCode, 2, file);
    assert.match(result.err[0], /is not in /u, file);
  }
  assert.equal(readArmed(setting.store, 'session-1'), null);
});

test('aidrian handoff check stamps the brief and aidrian handoff continue arms it, from the command line', (t) => {
  const setting = setup(t);
  const env = { ...process.env, ...CLAUDE };
  const run = (...args) => spawnSync(CLI, ['handoff', ...args], { cwd: setting.dir, encoding: 'utf8', env });
  assert.equal(run('continue').status, 2, 'usage');
  assert.equal(run('continue', setting.file, '--prior', setting.file).status, 2, '--prior is not an option of continue');
  assert.equal(run('check', setting.file, '--route', 'clear').status, 2, '--route is not an option of check');
  assert.match(run('continue', setting.file, '--route', 'teleport').stderr, /--route must be "none", "clear", "compact", "background"/u);
  assert.equal(run('continue', setting.file).status, 1, 'no check yet');
  assert.equal(run('check', setting.file).status, 0);
  assert.ok(checkedSha(setting.store, '2026-11-15-widget.md'));
  const armed = run('continue', setting.file);
  assert.deepEqual([armed.status, armed.stdout.split('\n')[0]], [0, 'continue: clear']);
  assert.match(armed.stdout, /^say: /mu);
});

test('aidrian handoff route prints the route this host runs, none on a fallback, and writes nothing', (t) => {
  const run = (setting, env, ...args) => spawnSync(CLI, ['handoff', 'route', ...args], { cwd: setting.dir, encoding: 'utf8', env: { ...process.env, ...env } });
  const lines = (result) => [result.status, ...result.stdout.trimEnd().split('\n')];
  const clear = setup(t);
  passCheck(clear);
  const before = readdirSync(clear.store.dir).sort();
  assert.deepEqual(lines(run(clear, CLAUDE)), [0, 'route: clear']);
  assert.deepEqual(lines(run(clear, CLAUDE, '--route', 'none')), [0, 'route: none']);
  // A route the host does not run: what the gate would fall back from, so the skill settles nothing for it.
  const [status, first, fallback] = lines(run(clear, CODEX));
  assert.deepEqual([status, first], [0, 'route: none'], 'Codex lists no route');
  assert.match(fallback, /^fallback: the clear route does not run on this host \(Codex\)/u);
  assert.match(lines(run(clear, CLAUDE, '--route', 'compact'))[2], /^fallback: the compact route does not run on this host/u);
  assert.match(lines(run(clear, CLAUDE, '--route', 'background'))[2], /^fallback: --route background runs only when/u);
  const compact = setup(t, { continue: 'compact' });
  assert.deepEqual(lines(run(compact, CLAUDE)).slice(0, 2), [0, 'route: none'], 'a configured route this release does not run');
  assert.deepEqual(lines(run(setup(t, { continue: 'none' }), CLAUDE)), [0, 'route: none']);
  assert.equal(run(clear, CLAUDE, '--route', 'teleport').status, 2);
  assert.equal(run(clear, CLAUDE, clear.file).status, 2, 'it takes no brief');
  assert.deepEqual(readdirSync(clear.store.dir).sort(), before, 'it writes nothing');
  assert.equal(readArmed(clear.store, 'session-1'), null);
  assert.equal(existsSync(storePath(compact.state)), false, 'nor makes the store');
});

test('the latest gate run decides: a refusal or a fallback cancels the marker the session armed before', (t) => {
  const setting = setup(t);
  passCheck(setting);
  assert.equal(gate(setting).exitCode, 0);
  assert.ok(readArmed(setting.store, 'session-1'));
  const other = path.join(setting.handoffs, '2026-11-15-other.md');
  writeFileSync(other, brief());
  assert.equal(gate(setting, { brief: other }).exitCode, 1, 'brief B has no check');
  assert.equal(readArmed(setting.store, 'session-1'), null, 'the refusal cancelled brief A');
  assert.equal(gate(setting).exitCode, 0);
  assert.equal(gate(setting, { override: 'compact' }).out[1].startsWith('fallback: '), true);
  assert.equal(readArmed(setting.store, 'session-1'), null, 'the fallback cancelled it');
});

test('the gate refuses a brief whose Chain is below the floor this session was given, though its check passed', (t) => {
  const setting = setup(t);
  passCheck(setting);
  noteFrom(setting.store, 'session-1', { slug: 'widget', chain: 2, brief: setting.file, route: 'clear' });
  const result = gate(setting);
  assert.deepEqual([result.exitCode, result.out], [1, []]);
  assert.match(result.err[0], /the brief's Chain is below this session's floor 2, which a continuation from the brief widget gave it; set Chain: 2/u);
  assert.equal(readArmed(setting.store, 'session-1'), null);
  // A continued session that hands off under another slug is held to its floor all the same.
  noteFrom(setting.store, 'session-1', { slug: 'other', chain: 2, brief: path.join(setting.handoffs, '2026-11-15-other.md'), route: 'clear' });
  const renamed = gate(setting);
  assert.deepEqual([renamed.exitCode, renamed.out], [1, []], 'a floor given for another slug holds too');
  assert.match(renamed.err[0], /below this session's floor 2, which a continuation from the brief other gave it/u);
  assert.equal(readArmed(setting.store, 'session-1'), null);
  writeFileSync(setting.file, brief(2));
  passCheck(setting);
  assert.equal(gate(setting).exitCode, 0, 'at the floor it arms');
});

test('a FIFO or a folder named like a brief exits 2 at once, and reads nothing', (t) => {
  const setting = setup(t);
  const fifo = path.join(setting.handoffs, '2026-11-15-pipe.md');
  execFileSync('mkfifo', [fifo]);
  const folder = path.join(setting.handoffs, '2026-11-15-folder.md');
  mkdirSync(folder);
  for (const file of [fifo, folder]) {
    const result = spawnSync(CLI, ['handoff', 'continue', file], { cwd: setting.dir, encoding: 'utf8', env: { ...process.env, ...CLAUDE }, timeout: 15_000 });
    assert.deepEqual([result.signal, result.status], [null, 2], file);
    assert.match(result.stderr, /is not a regular file\n$/u, file);
  }
});

test('a store behind a symlink is refused: a linked .continue, or a handoffs folder that resolves inside a checkout', (t) => {
  const setting = setup(t);
  const elsewhere = path.join(setting.root, 'elsewhere');
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, storePath(setting.state));
  const linked = openStore(setting.state, { checkouts: [setting.dir], maxChain: 3 });
  assert.match(linked.refused, /is a symlink/u);
  assert.equal(arm(linked, marker(setting)), null);
  assert.deepEqual(readdirSync(elsewhere), []);

  const state = path.join(setting.root, 'state2');
  mkdirSync(state);
  mkdirSync(path.join(setting.dir, 'notes'));
  symlinkSync(path.join(setting.dir, 'notes'), path.join(state, 'handoffs'));
  assert.match(openStore(state, { checkouts: [setting.dir], maxChain: 3 }).refused, /is inside the checkout/u);
});

test('a store whose folder every user may write, or another user owns, is refused; a marker or brief of another user is never read', { skip: (process.platform === 'win32' || process.getuid?.() === 0) && 'no user ids, or root owns anything' }, (t) => {
  const setting = setup(t);
  const uid = process.getuid();
  mkdirSync(storePath(setting.state), { recursive: true });
  for (const dir of [setting.state, setting.handoffs, storePath(setting.state)]) {
    chmodSync(dir, 0o777);
    const loose = openStore(setting.state, { checkouts: [setting.dir], maxChain: 3 });
    assert.match(loose.refused, /is writable by every user/u, dir);
    assert.ok(loose.refused.includes(dir), dir);
    assert.equal(arm(loose, marker(setting)), null, dir);
    chmodSync(dir, 0o775);
    assert.equal(openStore(setting.state, { checkouts: [setting.dir], maxChain: 3 }).refused, null, `${dir}: a folder its group may write passes`);
    chmodSync(dir, 0o700);
  }
  chmodSync(storePath(setting.state), 0o777);
  passCheck(setting);
  const result = gate(setting);
  assert.deepEqual([result.exitCode, result.out[0]], [0, 'continue: none']);
  assert.match(result.out[1], /^fallback: the folder \S+ of the continuation store is writable by every user/u);
  chmodSync(storePath(setting.state), 0o700);

  assert.match(openStore(setting.state, { checkouts: [setting.dir], maxChain: 3, uid: uid + 1 }).refused, /is owned by another user/u);
  const { store } = setting;
  assert.ok(arm(store, marker(setting)));
  assert.ok(readArmed(store, 'session-1'));
  const stranger = { ...store, uid: uid + 1 };
  assert.equal(readArmed(stranger, 'session-1'), null, 'a marker of another user is never read');
  assert.match(readContainedBrief(stranger, setting.file).problem, /is owned by another user/u);
  assert.equal(readContainedBrief(store, setting.file).problem, undefined);
});

// On Windows Node reports every writable folder with the other-write bit, and the process has no user id.
test('a store opened with no user id is never refused for the mode of its folders', { skip: process.platform === 'win32' && 'chmod sets no other-write bit here' }, (t) => {
  const setting = setup(t);
  mkdirSync(storePath(setting.state), { recursive: true });
  for (const dir of [setting.state, setting.handoffs, storePath(setting.state)]) chmodSync(dir, 0o777);
  const store = openStore(setting.state, { checkouts: [setting.dir], maxChain: 3, uid: null });
  assert.equal(store.refused, null);
  assert.ok(arm(store, marker(setting)), 'the store keeps its markers');
});

test('a store spelled in another letter case is still inside its checkout', { skip: !['darwin', 'win32'].includes(process.platform) && 'the disk does not fold case' }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-case-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = path.join(root, 'CaseRepo');
  mkdirSync(path.join(checkout, '.state/handoffs'), { recursive: true });
  const store = openStore(path.join(root, 'caserepo/.state'), { checkouts: [checkout], maxChain: 3 });
  assert.match(store.refused, /is inside the checkout/u);
});

test('the sweep deletes only the file names the store writes', (t) => {
  const setting = setup(t);
  const { store } = setting;
  arm(store, marker(setting));
  const foreign = ['user-work.tmp', 'armed-notes.txt', '.notes.tmp', 'ready-a.json.bak'];
  for (const name of foreign) writeFileSync(path.join(store.dir, name), 'x');
  writeFileSync(path.join(store.dir, '.armed-s.json.12.0123456789ab.tmp'), '');
  for (const name of readdirSync(store.dir)) age(path.join(store.dir, name), 2 * 24 * HOUR);
  sweep(store);
  assert.deepEqual(readdirSync(store.dir).sort(), [...foreign].sort());
});

test('a store the disk will not write exits 2 with the error code, not a stack trace', { skip: process.getuid?.() === 0 && 'root writes anywhere' }, (t) => {
  const setting = setup(t);
  passCheck(setting);
  chmodSync(setting.store.dir, 0o500);
  let result;
  try {
    result = spawnSync(CLI, ['handoff', 'continue', setting.file], { cwd: setting.dir, encoding: 'utf8', env: { ...process.env, ...CLAUDE } });
  } finally {
    chmodSync(setting.store.dir, 0o700);
  }
  assert.equal(result.status, 2);
  assert.equal(result.stderr, `could not arm the continuation of ${setting.file} (EACCES)\n`);
});
