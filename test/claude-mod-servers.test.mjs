// How the Claude mod reaches outside itself: the Linear servers and the one issue lookup (lib/servers.mjs), and the
// snapshot client (lib/snapshot-client.mjs), which finds the aidrian cli and the transcript and starts every process.
// The client takes its file reads, environment, and process runner as arguments: these tests pass fakes over a real
// temporary folder, so links and real paths behave as on disk.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bandSegments, changesParts } from '../plugins/aidrian-claude-mod/lib/format.mjs';
import { ISSUE_TOOL, issueLookup, LINEAR_SERVERS, ticketPrefixes } from '../plugins/aidrian-claude-mod/lib/servers.mjs';
import {
  findCli, findTranscript, OSASCRIPT, poller, runnerFor, runSnapshot, SESSION_ID, SNAPSHOT_TIMEOUT_MS, snapshotArgs,
} from '../plugins/aidrian-claude-mod/lib/snapshot-client.mjs';
import { SESSION_ID as AIDRIAN_SESSION_ID } from '../plugins/aidrian/lib/handoff-markers.mjs';
import linear from '../plugins/aidrian/lib/trackers/linear.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const ID = 'mod-1';
const MARKET = 'market';
const SHELLS = new Set(['sh', 'bash', 'zsh']);

const scratch = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-mod-')));
const write = (file, text = '') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
const kindOf = (stat) => {
  if (stat?.isFile()) return 'file';
  if (stat?.isDirectory()) return 'dir';
  return 'other';
};

// $.fs, $.process.run, $.clock.now, the env values, $.plugin.root, and enabledPlugins, as fakes over the disk.
function fakeIo({ pluginRoot, PATH = '', HOME = '', CLAUDE_CONFIG_DIR = '', enabled = {}, run = async () => ({ exitCode: 0, stdout: '{}', stderr: '' }) }) {
  const io = {
    reads: [], calls: [], clock: 0,
    fs: {
      read: async (file) => {
        io.reads.push(file);
        return readFileSync(file, 'utf8');
      },
      list: async (dir) => readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, kind: entry.isSymbolicLink() ? 'other' : kindOf(entry), isLink: entry.isSymbolicLink(), size: 0, mtimeMs: 0 })),
      stat: async (file, { resolve = false } = {}) => {
        const link = lstatSync(file);
        const target = statSync(file, { throwIfNoEntry: false });
        const out = { kind: kindOf(target), size: target?.size ?? 0, mtimeMs: target?.mtimeMs ?? 0, isLink: link.isSymbolicLink() };
        return resolve && target ? { ...out, realPath: realpathSync(file) } : out;
      },
    },
    run: async (argv, init) => {
      io.calls.push({ argv, init });
      return run(argv, init, io);
    },
    now: async () => io.clock,
    env: { PATH, HOME, CLAUDE_CONFIG_DIR },
    pluginRoot,
    enabledPlugins: async () => enabled,
  };
  return io;
}

// A config dir with the Claude mod in its plugins cache, an aidrian install there, a project, a bin folder holding
// node, and the session's transcript.
function layout({ installs = null } = {}) {
  const base = scratch();
  const config = path.join(base, 'config');
  const cache = path.join(config, 'plugins/cache', MARKET);
  const pluginRoot = path.join(cache, 'aidrian-claude-mod/0.1.0');
  mkdirSync(pluginRoot, { recursive: true });
  const install = path.join(cache, 'aidrian/1.0.0');
  const cli = write(path.join(install, 'lib/cli.mjs'), '');
  const project = path.join(base, 'project');
  mkdirSync(project);
  const bin = path.join(base, 'bin');
  write(path.join(bin, 'node'), '');
  const transcript = write(path.join(config, 'projects/-project', `${ID}.jsonl`), '{}\n');
  const entries = installs ?? [{ scope: 'user', installPath: install, version: '1.0.0' }];
  write(path.join(config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [`aidrian@${MARKET}`]: entries } }));
  const io = (options = {}) => fakeIo({ pluginRoot, PATH: bin, enabled: { [`aidrian@${MARKET}`]: true }, ...options });
  return { base, config, cache, pluginRoot, install, cli, project, bin, transcript, io };
}
const installs = (env, entries) => write(path.join(env.config, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: entries }));
const cliOf = async (io, cwd) => findCli(io, { cwd, runner: await runnerFor(io, { cwd, root: cwd }) });
const flags = (call) => call.argv.filter((arg) => arg.startsWith('--'));

test('LINEAR_SERVERS is the Linear adapter`s servers.any, then its servers[`claude-code`]', () => {
  assert.deepEqual(LINEAR_SERVERS, [...linear.servers.any, ...linear.servers['claude-code']]);
  assert.equal(ISSUE_TOOL, 'get_issue');
});

test('the client`s session id pattern is the aidrian plugin`s SESSION_ID', () => {
  assert.equal(SESSION_ID.source, AIDRIAN_SESSION_ID.source);
  assert.equal(SESSION_ID.flags, AIDRIAN_SESSION_ID.flags);
});

test('the issue lookup asks only for a key a valid prefix matched', () => {
  assert.deepEqual(issueLookup({ key: 'ABC-12', source: 'branch' }, 'ABC|XY'), { id: 'ABC-12' });
  assert.deepEqual(issueLookup({ key: 'xy-3', source: 'branch' }, 'ABC|XY'), { id: 'xy-3' });
  assert.equal(issueLookup({ key: '#12', source: 'branch' }, 'ABC'), null, 'a GitHub number has no title to look up');
  assert.equal(issueLookup({ key: 'ABC-12', source: 'branch' }, ''), null, 'no prefixes: no lookup');
  assert.equal(issueLookup({ key: 'DEF-12', source: 'branch' }, 'ABC'), null);
  assert.equal(issueLookup({ key: 'ABC-12\u001b', source: 'branch' }, 'ABC'), null);
  assert.equal(issueLookup({ key: 'ABC-12', source: 'branch' }, 'ABC|A.C'), null, 'a bad prefix');
  assert.equal(issueLookup(null, 'ABC'), null);
  const many = Array.from({ length: 33 }, (_, index) => `P${index}`);
  assert.equal(ticketPrefixes(many.join('|')), null, 'more than 32');
  assert.equal(ticketPrefixes(many.slice(0, 32).join('|')).length, 32);
});

test('the aidrian cli comes from the installed entry of the own marketplace', async () => {
  const env = layout();
  assert.deepEqual(await cliOf(env.io(), env.project), { kind: 'plugin', cli: realpathSync(env.cli), place: { configDir: env.config, marketplace: MARKET } });
});

test('another marketplace`s aidrian key is ignored', async () => {
  const env = layout();
  installs(env, { 'aidrian@elsewhere': [{ scope: 'user', installPath: env.install }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'missing');
});

test('another project`s entry is ignored, and a projectPath that only starts like the cwd holds nothing', async () => {
  const env = layout();
  const other = path.join(env.base, 'other');
  const near = path.join(env.base, 'proj');
  mkdirSync(other);
  mkdirSync(near);
  const second = path.join(env.cache, 'aidrian/2.0.0');
  write(path.join(second, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'local', projectPath: other, installPath: second }, { scope: 'project', projectPath: near, installPath: second }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'missing', 'no entry for this folder and no user entry');
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'local', projectPath: other, installPath: second }, { scope: 'user', installPath: env.install }] });
  assert.equal((await cliOf(env.io(), env.project)).cli, realpathSync(env.cli), 'the user entry');
  const sub = path.join(env.project, 'packages/app');
  mkdirSync(sub, { recursive: true });
  installs(env, { [`aidrian@${MARKET}`]: [
    { scope: 'user', installPath: env.install },
    { scope: 'project', projectPath: env.project, installPath: env.install },
    { scope: 'local', projectPath: env.project, installPath: second },
  ] });
  assert.equal((await cliOf(env.io(), sub)).cli, realpathSync(path.join(second, 'lib/cli.mjs')), 'the local entry holding the cwd first');
});

test('an install outside the marketplace`s aidrian cache, or a linked cli.mjs, is refused', async () => {
  const env = layout();
  const outside = path.join(env.base, 'elsewhere/aidrian');
  write(path.join(outside, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: outside }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused');
  const linked = path.join(env.cache, 'aidrian/link');
  symlinkSync(path.join(env.base, 'elsewhere/aidrian'), linked);
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: linked }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused', 'a link in the cache that leaves it');
  const other = path.join(env.cache, 'aidrian/3.0.0');
  mkdirSync(path.join(other, 'lib'), { recursive: true });
  symlinkSync(env.cli, path.join(other, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: other }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused', 'a symlinked lib/cli.mjs');
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: path.join(env.cache, 'aidrian') }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused', 'the cache folder itself');
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: 'config/plugins/cache/market/aidrian/1.0.0' }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused', 'a relative installPath');
});

test('a config dir reached through a symlink still resolves', async () => {
  const env = layout();
  const link = path.join(env.base, 'config-link');
  symlinkSync(env.config, link);
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: path.join(link, 'plugins/cache', MARKET, 'aidrian/1.0.0') }] });
  const io = env.io({ pluginRoot: path.join(link, 'plugins/cache', MARKET, 'aidrian-claude-mod/0.1.0') });
  assert.deepEqual(await cliOf(io, env.project), { kind: 'plugin', cli: realpathSync(env.cli), place: { configDir: env.config, marketplace: MARKET } });
});

test('a --plugin-dir root reads no installed_plugins.json, and goes to the PATH fallback', async () => {
  const env = layout();
  const dev = path.join(env.base, 'dev/aidrian-claude-mod');
  mkdirSync(dev, { recursive: true });
  const io = env.io({ pluginRoot: dev });
  assert.equal((await cliOf(io, env.project)).kind, 'missing');
  assert.deepEqual(io.reads, []);
  const plugin = path.join(env.base, 'aidrian');
  write(path.join(plugin, 'lib/cli.mjs'));
  write(path.join(plugin, 'bin/aidrian'), '#!/bin/sh\n');
  const withPath = env.io({ pluginRoot: dev, PATH: `${env.bin}:${path.join(plugin, 'bin')}` });
  assert.deepEqual(await cliOf(withPath, env.project), { kind: 'path', cli: realpathSync(path.join(plugin, 'lib/cli.mjs')), place: null });
  assert.deepEqual(withPath.reads, []);
});

test('the PATH fallback skips a relative entry and one inside the session`s folder or root', async () => {
  const env = layout();
  const dev = path.join(env.base, 'dev/mod');
  mkdirSync(dev, { recursive: true });
  for (const folder of [path.join(env.project, 'tools'), path.join(env.base, 'rel')]) {
    write(path.join(folder, 'lib/cli.mjs'));
    write(path.join(folder, 'bin/aidrian'));
  }
  const relative = path.relative(process.cwd(), path.join(env.base, 'rel/bin'));
  const io = env.io({ pluginRoot: dev, PATH: [relative, path.join(env.project, 'tools/bin'), env.bin].join(':') });
  const runner = await runnerFor(io, { cwd: env.project, root: env.project });
  assert.deepEqual(runner.entries, [realpathSync(env.bin)]);
  assert.equal((await findCli(io, { cwd: env.project, runner })).kind, 'missing');
});

test('enabledPlugins with aidrian@<own marketplace> false, or unset, starts no process', async () => {
  for (const enabled of [{ [`aidrian@${MARKET}`]: false }, {}, { 'aidrian@elsewhere': true }, null]) {
    const env = layout();
    const io = env.io({ enabled });
    assert.deepEqual(await runSnapshot(io, { session: ID, cwd: env.project, root: env.project }), { kind: 'off' }, JSON.stringify(enabled));
    assert.deepEqual(io.calls, []);
  }
});

test('off only for an entry installed for the folder; with no entry and no enabledPlugins key, missing, and no PATH fallback', async () => {
  const env = layout();
  const fallback = pathPlugin(path.join(env.base, 'aidrian'));
  installs(env, {});
  for (const enabled of [{}, null, { [`aidrian@${MARKET}`]: false }]) {
    const io = env.io({ enabled, PATH: `${env.bin}:${fallback}` });
    assert.deepEqual(await runSnapshot(io, { session: ID, cwd: env.project, root: env.project }), { kind: 'missing' }, JSON.stringify(enabled));
    assert.deepEqual(io.calls, []);
  }
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'local', projectPath: path.join(env.base, 'nowhere'), installPath: env.install }] });
  assert.deepEqual(await runSnapshot(env.io({ enabled: {} }), { session: ID, cwd: env.project, root: env.project }), { kind: 'missing' }, 'another folder`s entry');
});

test('every process starts by an absolute argv[0], never a shell, with PATH of checked entries only', async () => {
  const env = layout();
  const inside = path.join(env.project, 'node_modules/.bin');
  const root = path.join(env.base, 'root');
  for (const folder of [inside, path.join(root, 'bin')]) write(path.join(folder, 'node'));
  for (const name of ['git', 'tail', 'sh', 'bash', 'zsh']) write(path.join(env.bin, name));
  const io = env.io({ PATH: ['bin', inside, path.join(root, 'bin'), '', env.bin, '/usr/bin'].join(':') });
  assert.equal((await runSnapshot(io, { session: ID, cwd: env.project, root })).kind, 'ok');
  const runner = await runnerFor(io, { cwd: env.project, root });
  await runner.run('git', ['status']);
  await assert.rejects(runner.run('tail', ['-c', '100', env.transcript]), 'tail is no program of the resolver');
  await runner.frontmostApp();
  for (const shell of ['sh', 'bash', 'zsh', '/bin/sh', 'node; sh']) await assert.rejects(runner.run(shell, ['-c', 'true']), shell);
  assert.equal(io.calls.length, 3);
  assert.equal(io.calls[2].argv[0], OSASCRIPT);
  for (const { argv, init } of io.calls) {
    assert.ok(path.isAbsolute(argv[0]), argv[0]);
    assert.ok(!SHELLS.has(path.basename(argv[0])), argv[0]);
    assert.ok(Number.isFinite(init.timeoutMs) && init.timeoutMs > 0);
    const entries = init.env.PATH.split(':');
    assert.ok(entries.every((entry) => path.isAbsolute(entry)), init.env.PATH);
    assert.ok(entries.every((entry) => !entry.startsWith(`${env.project}/`) && entry !== env.project && !entry.startsWith(`${root}/`)), init.env.PATH);
    assert.deepEqual(Object.keys(init.env), ['PATH']);
  }
  assert.equal(io.calls[0].argv[0], realpathSync(path.join(env.bin, 'node')));
  assert.deepEqual(io.calls[0].argv.slice(1, 5), [realpathSync(env.cli), 'session', 'snapshot', '--json']);
  assert.equal(io.calls[0].init.timeoutMs, SNAPSHOT_TIMEOUT_MS);
  assert.equal(io.calls[0].init.cwd, env.project);
});

test('the snapshot`s flags are --name=value, each one argv element', () => {
  const args = snapshotArgs({ cli: '/c/cli.mjs', session: ID, transcript: '/t/--json x.jsonl', ticketPrefixes: 'ABC|XY' });
  assert.deepEqual(args, ['/c/cli.mjs', 'session', 'snapshot', '--json', `--session=${ID}`, '--transcript=/t/--json x.jsonl', '--ticket-prefixes=ABC|XY']);
  assert.deepEqual(snapshotArgs({ cli: '/c', session: '../x' }), ['/c', 'session', 'snapshot', '--json']);
});

test('the result is ok, failed, or timed out, from what the run gave', async () => {
  const env = layout();
  const cases = [
    [async () => ({ exitCode: 1, stdout: '{"prs":[]}\n', stderr: 'usage: aidrian session snapshot ...' }), 'failed'],
    [async () => ({ exitCode: 0, stdout: 'not json', stderr: '' }), 'failed'],
    [async () => ({ exitCode: 0, stdout: '[1]', stderr: '' }), 'failed'],
    [async () => { throw new Error('cannot start'); }, 'failed'],
    [async (argv, init, io) => {
      io.clock += init.timeoutMs + 1;
      throw new Error('timed out');
    }, 'timed-out'],
  ];
  // Each run that started carries the transcript it was given, which the mod reads its cache from.
  const transcript = realpathSync(env.transcript);
  for (const [run, kind] of cases) assert.deepEqual(await runSnapshot(env.io({ run }), { session: ID, cwd: env.project, root: env.project }), { kind, transcript }, kind);
  const ok = await runSnapshot(env.io({ run: async () => ({ exitCode: 0, stdout: '{"prs":[]}\n', stderr: '' }) }), { session: ID, cwd: env.project, root: env.project });
  assert.deepEqual(ok, { kind: 'ok', snapshot: { prs: [] }, transcript });
  const noNode = layout();
  assert.deepEqual(await runSnapshot(noNode.io({ PATH: '' }), { session: ID, cwd: noNode.project, root: noNode.project }), { kind: 'no-node' });
});

test('the transcript is passed only for a regular file below the config dir`s projects folder', async () => {
  const env = layout();
  const io = env.io();
  const ran = async (session) => {
    io.calls.length = 0;
    await runSnapshot(io, { session, cwd: env.project, root: env.project });
    return flags(io.calls[0]);
  };
  assert.deepEqual(await ran(ID), ['--json', `--session=${ID}`, `--transcript=${realpathSync(env.transcript)}`]);
  assert.deepEqual(await ran('../../etc/passwd'), ['--json'], 'an id that fails the pattern');
  assert.deepEqual(await ran('mod-2'), ['--json', '--session=mod-2'], 'a missing file');
  const outside = write(path.join(env.base, 'outside.jsonl'), '{}\n');
  symlinkSync(outside, path.join(env.config, 'projects/-project/mod-3.jsonl'));
  assert.deepEqual(await ran('mod-3'), ['--json', '--session=mod-3'], 'a symlink that leaves the projects folder');
  mkdirSync(path.join(env.config, 'projects/-folder/mod-4.jsonl'), { recursive: true });
  assert.deepEqual(await ran('mod-4'), ['--json', '--session=mod-4'], 'a folder');
  assert.equal(await findTranscript(io, { configDir: env.config, session: ID }), realpathSync(env.transcript));
  const home = env.io({ pluginRoot: path.join(env.base, 'dev'), HOME: env.base, PATH: '' });
  mkdirSync(path.join(env.base, 'dev'));
  symlinkSync(env.config, path.join(env.base, '.claude'));
  assert.equal(await findTranscript(home, { configDir: path.join(env.base, '.claude'), session: ID }), realpathSync(env.transcript));
});

// A deferred result for the fake snapshot.
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('triggers during a run coalesce into one rerun after it', async () => {
  const runs = [];
  const drawn = [];
  const where = { session: ID, cwd: '/a', root: '/a' };
  const poll = poller({ target: async () => ({ ...where }), snapshot: (asked) => {
    const next = deferred();
    runs.push({ asked, ...next });
    return next.promise;
  }, draw: (result, asked) => drawn.push({ result, asked }) });
  const first = poll.trigger();
  await Promise.resolve();
  poll.trigger();
  poll.trigger();
  await new Promise((done) => setImmediate(done));
  assert.equal(runs.length, 1, 'one call in flight');
  runs[0].resolve({ kind: 'ok', snapshot: { n: 1 } });
  await new Promise((done) => setImmediate(done));
  assert.equal(runs.length, 2, 'one rerun');
  runs[1].resolve({ kind: 'ok', snapshot: { n: 2 } });
  await first;
  assert.equal(runs.length, 2);
  assert.deepEqual(drawn.map((each) => each.result.snapshot.n), [1, 2]);
});

test('a run whose cwd changed before it ended draws nothing, and the rerun runs for the new cwd', async () => {
  const runs = [];
  const drawn = [];
  const where = { session: ID, cwd: '/a', root: '/a' };
  const poll = poller({ target: async () => ({ ...where }), snapshot: (asked) => {
    const next = deferred();
    runs.push({ asked, ...next });
    return next.promise;
  }, draw: (result, asked) => drawn.push(asked.cwd) });
  const done = poll.trigger();
  await new Promise((resolve) => setImmediate(resolve));
  where.cwd = '/b';
  poll.trigger();
  runs[0].resolve({ kind: 'ok', snapshot: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs[1].asked.cwd, '/b');
  runs[1].resolve({ kind: 'ok', snapshot: {} });
  await done;
  assert.deepEqual(drawn, ['/b']);
  where.session = 'other';
  const late = poller({ target: async () => ({ ...where }), snapshot: async () => {
    where.session = 'third';
    return { kind: 'ok', snapshot: {} };
  }, draw: () => drawn.push('late') });
  await late.trigger();
  assert.deepEqual(drawn, ['/b'], 'a session that changed: dropped');
});

const GIT_CONFIG_NONE = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_CONFIG_NONE, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  assert.equal(result.status, 0, result.stderr);
};

test('the real aidrian cli, run with the argv the client builds, gives an object every section format.mjs reads is a key of', async () => {
  const base = scratch();
  const project = path.join(base, 'project');
  write(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  git(project, 'init', '-q', '-b', 'feat/ABC-7-thing');
  git(project, 'add', '.');
  git(project, 'commit', '-q', '-m', 'start');
  const config = path.join(base, 'claude');
  const fixture = readFileSync(path.join(ROOT, 'test/fixtures/transcripts/handoff-cost.jsonl'), 'utf8').trimEnd().split('\n');
  const firstCall = fixture.findIndex((line) => JSON.parse(line).type === 'assistant');
  write(path.join(config, 'projects/-project', `${ID}.jsonl`), `${fixture.slice(0, firstCall + 1).join('\n')}\n`);
  const dev = path.join(base, 'dev/aidrian-claude-mod');
  mkdirSync(dev, { recursive: true });
  const PATH = [path.join(ROOT, 'plugins/aidrian/bin'), path.dirname(process.execPath), ...String(process.env.PATH).split(path.delimiter)].join(':');
  const run = async (argv, init) => {
    const result = spawnSync(argv[0], argv.slice(1), { cwd: init.cwd, env: { ...process.env, ...GIT_CONFIG_NONE, ...init.env }, encoding: 'utf8', timeout: init.timeoutMs });
    if (result.error) throw result.error;
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const io = fakeIo({ pluginRoot: dev, PATH, CLAUDE_CONFIG_DIR: config, run });
  const result = await runSnapshot(io, { session: ID, cwd: project, root: project, ticketPrefixes: 'ABC' });
  assert.equal(result.kind, 'ok', JSON.stringify(result));
  assert.equal(io.calls.length, 1);
  assert.equal(io.calls[0].argv[1], realpathSync(path.join(ROOT, 'plugins/aidrian/lib/cli.mjs')));
  const { snapshot } = result;
  for (const name of ['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'ticket']) assert.ok(Object.hasOwn(snapshot, name), name);
  assert.equal(snapshot.session.transcript, realpathSync(path.join(config, 'projects/-project', `${ID}.jsonl`)));
  assert.notEqual(snapshot.handoff, null, JSON.stringify(snapshot.errors));
  assert.deepEqual(snapshot.ticket, { key: 'ABC-7', source: 'branch' });
  assert.deepEqual(changesParts(snapshot.prs), []);
  assert.deepEqual(bandSegments(snapshot).map((segment) => segment.id), ['handoff']);
});

// The focus check's script, constant: the mod compares its focusApp setting with the output and never puts it in here.
const FOCUS = 'tell application "System Events" to get name of first process whose frontmost is true';

// A plugin folder like the aidrian plugin's: bin/aidrian beside lib/cli.mjs.
function pathPlugin(folder) {
  write(path.join(folder, 'lib/cli.mjs'));
  write(path.join(folder, 'bin/aidrian'), '#!/bin/sh\n');
  return path.join(folder, 'bin');
}

test('a case alias of a folder inside the session`s folder is no PATH entry, and finds no program', async (t) => {
  const env = layout();
  const upper = path.join(env.base, 'PROJECT');
  if (!existsSync(upper)) {
    t.skip('the temporary folder is case-sensitive');
    return;
  }
  write(path.join(env.project, 'tools/node'));
  const dev = path.join(env.base, 'dev/mod');
  mkdirSync(dev, { recursive: true });
  pathPlugin(path.join(env.project, 'vendor/aidrian'));
  const alias = [path.join(upper, 'tools'), path.join(upper, 'vendor/aidrian/bin')];
  const io = env.io({ pluginRoot: dev, PATH: [...alias, env.bin].join(':') });
  const runner = await runnerFor(io, { cwd: env.project, root: env.project });
  assert.deepEqual(runner.entries, [realpathSync(env.bin)]);
  assert.equal((await findCli(io, { cwd: env.project, runner })).kind, 'missing');
  const linked = path.join(env.base, 'outbin');
  mkdirSync(linked);
  symlinkSync(path.join(upper, 'tools/node'), path.join(linked, 'node'));
  const viaLink = await runnerFor(env.io({ pluginRoot: dev, PATH: linked }), { cwd: env.project, root: env.project });
  assert.equal(await viaLink.which('node'), null, 'a program whose real path is a case alias inside the cwd');
});

test('the resolver runs only node and git, looks aidrian up, and runs osascript with its own focus script', async () => {
  const env = layout();
  for (const name of ['git', 'tail', 'python3', 'sh', 'aidrian', 'curl']) write(path.join(env.bin, name));
  const io = env.io();
  const runner = await runnerFor(io, { cwd: env.project, root: env.project });
  for (const name of ['node', 'git']) await runner.run(name, ['x']);
  // The mod reads files through $.fs: tail, though on a checked PATH entry, is refused like any other program.
  for (const name of ['tail', 'python3', 'sh', 'aidrian', 'curl', 'osascript', 'env']) await assert.rejects(runner.run(name, ['-c', 'true']), name);
  assert.equal(await runner.which('tail'), null);
  assert.equal(await runner.which('aidrian'), realpathSync(path.join(env.bin, 'aidrian')));
  assert.equal(await runner.which('python3'), null);
  const before = io.calls.length;
  await runner.frontmostApp();
  assert.deepEqual(io.calls.slice(before).map((call) => call.argv), [[OSASCRIPT, '-e', FOCUS]]);
  assert.equal(runner.frontmostApp.length, 0, 'the focus check takes no argument');
  const answered = await runnerFor(env.io({ run: async () => ({ exitCode: 0, stdout: 'kitty\n', stderr: '' }) }), { cwd: env.project, root: env.project });
  assert.equal(await answered.frontmostApp(), 'kitty');
  const refused = await runnerFor(env.io({ run: async () => ({ exitCode: 1, stdout: 'kitty\n', stderr: '' }) }), { cwd: env.project, root: env.project });
  assert.equal(await refused.frontmostApp(), null);
});

test('the PATH fallback`s cli lies below the plugin folder of the aidrian command found, and is no link', async () => {
  const env = layout();
  const dev = path.join(env.base, 'dev/mod');
  mkdirSync(dev, { recursive: true });
  const escaped = path.join(env.base, 'escaped');
  mkdirSync(path.join(escaped, 'bin'), { recursive: true });
  write(path.join(env.base, 'shared/lib/cli.mjs'));
  write(path.join(escaped, 'bin/aidrian'), '#!/bin/sh\n');
  symlinkSync(path.join(env.base, 'shared/lib'), path.join(escaped, 'lib'));
  assert.equal((await cliOf(env.io({ pluginRoot: dev, PATH: path.join(escaped, 'bin') }), env.project)).kind, 'missing', 'a lib folder that leaves the plugin');
  const linkedCli = path.join(env.base, 'linked');
  write(path.join(linkedCli, 'bin/aidrian'), '#!/bin/sh\n');
  write(path.join(linkedCli, 'real-cli.mjs'));
  mkdirSync(path.join(linkedCli, 'lib'));
  symlinkSync(path.join(linkedCli, 'real-cli.mjs'), path.join(linkedCli, 'lib/cli.mjs'));
  assert.equal((await cliOf(env.io({ pluginRoot: dev, PATH: path.join(linkedCli, 'bin') }), env.project)).kind, 'missing', 'a linked cli.mjs, though it stays in the plugin');
});

test('the PATH fallback`s cli is not run when it lies inside the session`s folder, though its bin folder does not', async () => {
  const env = layout();
  const dev = path.join(env.base, 'dev/mod');
  mkdirSync(dev, { recursive: true });
  const plugin = path.join(env.base, 'aidrian');
  const bin = pathPlugin(plugin);
  const lib = path.join(plugin, 'lib');
  const io = env.io({ pluginRoot: dev, PATH: `${env.bin}:${bin}` });
  assert.equal((await findCli(io, { cwd: lib, runner: await runnerFor(io, { cwd: lib, root: lib }) })).kind, 'missing');
  assert.equal((await findCli(io, { cwd: env.project, runner: await runnerFor(io, { cwd: env.project, root: env.project }) })).kind, 'path');
});

test('an installed lib/cli.mjs that is a link is refused, though it points inside the same install', async () => {
  const env = layout();
  const other = path.join(env.cache, 'aidrian/4.0.0');
  write(path.join(other, 'lib/real-cli.mjs'));
  symlinkSync(path.join(other, 'lib/real-cli.mjs'), path.join(other, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: other }] });
  assert.equal((await cliOf(env.io(), env.project)).kind, 'refused');
});

test('an installed entry that fails its checks refuses with no PATH fallback; with no entry the fallback runs', async () => {
  const env = layout();
  const fallback = pathPlugin(path.join(env.base, 'aidrian'));
  const io = (options) => env.io({ PATH: `${env.bin}:${fallback}`, ...options });
  const outside = path.join(env.base, 'elsewhere/aidrian');
  write(path.join(outside, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: outside }] });
  assert.equal((await cliOf(io(), env.project)).kind, 'refused', 'an entry outside the cache: refused, and PATH not tried');
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'local', projectPath: path.join(env.base, 'nowhere'), installPath: env.install }] });
  assert.equal((await cliOf(io(), env.project)).kind, 'path', 'no entry for this folder');
  installs(env, { 'aidrian@elsewhere': [{ scope: 'user', installPath: env.install }] });
  assert.equal((await cliOf(io(), env.project)).kind, 'path', 'no key for this marketplace');
});

test('a refused entry and a missing node each give their own result, and start no process', async () => {
  const env = layout();
  const outside = path.join(env.base, 'elsewhere/aidrian');
  write(path.join(outside, 'lib/cli.mjs'));
  installs(env, { [`aidrian@${MARKET}`]: [{ scope: 'user', installPath: outside }] });
  const refused = env.io();
  assert.deepEqual(await runSnapshot(refused, { session: ID, cwd: env.project, root: env.project }), { kind: 'refused' });
  assert.deepEqual(refused.calls, []);
  const noNode = layout();
  const io = noNode.io({ PATH: '' });
  assert.deepEqual(await runSnapshot(io, { session: ID, cwd: noNode.project, root: noNode.project }), { kind: 'no-node' });
  assert.deepEqual(io.calls, []);
});

test('of two local entries holding the cwd, the one with the longer projectPath is chosen', async () => {
  const env = layout();
  const second = path.join(env.cache, 'aidrian/2.0.0');
  write(path.join(second, 'lib/cli.mjs'));
  for (const entries of [
    [{ scope: 'local', projectPath: env.base, installPath: env.install }, { scope: 'local', projectPath: env.project, installPath: second }],
    [{ scope: 'local', projectPath: env.project, installPath: second }, { scope: 'local', projectPath: env.base, installPath: env.install }],
  ]) {
    installs(env, { [`aidrian@${MARKET}`]: entries });
    assert.equal((await cliOf(env.io(), env.project)).cli, realpathSync(path.join(second, 'lib/cli.mjs')));
  }
});

test('every run passes the newest copy of the session`s transcript', async () => {
  const env = layout();
  const older = env.transcript;
  const newer = write(path.join(env.config, 'projects/-elsewhere', `${ID}.jsonl`), '{}\n');
  const at = (file, seconds) => utimesSync(file, seconds, seconds);
  at(older, 1_000);
  at(newer, 2_000);
  const io = env.io();
  const where = { session: ID, cwd: env.project, root: env.project };
  const client = poller({ target: async () => where, draw: () => undefined, snapshot: (asked) => runSnapshot(io, asked) });
  await client.trigger();
  assert.equal(flags(io.calls.at(-1)).at(-1), `--transcript=${realpathSync(newer)}`);
  at(older, 3_000);
  await client.trigger();
  assert.equal(flags(io.calls.at(-1)).at(-1), `--transcript=${realpathSync(older)}`, 'the next run looks again');
  assert.equal(await findTranscript(io, { configDir: env.config, session: ID }), realpathSync(older));
});

test('a session folder or root that cannot be resolved leaves no PATH entry', async () => {
  const env = layout();
  const gone = path.join(env.base, 'gone');
  for (const fences of [{ cwd: gone, root: env.project }, { cwd: env.project, root: gone }, { cwd: 'project', root: env.project }]) {
    const runner = await runnerFor(env.io(), fences);
    assert.deepEqual(runner.entries, [], JSON.stringify(fences));
    assert.equal(await runner.which('node'), null);
  }
});

test('a program on a checked entry whose real path lies inside the session`s folder is not run', async () => {
  const env = layout();
  const inside = write(path.join(env.project, 'evil-node'));
  const out = path.join(env.base, 'outbin');
  mkdirSync(out);
  symlinkSync(inside, path.join(out, 'node'));
  const io = env.io({ PATH: out });
  const runner = await runnerFor(io, { cwd: env.project, root: env.project });
  assert.deepEqual(runner.entries, [realpathSync(out)]);
  assert.equal(await runner.which('node'), null);
  assert.deepEqual(await runSnapshot(io, { session: ID, cwd: env.project, root: env.project }), { kind: 'no-node' });
  assert.deepEqual(io.calls, []);
});

// The snapshot starts git and gh by name from the PATH it is given, so a folder whose git or gh resolves into the
// session's folder or root gives no PATH entry, though its own real path lies outside both.
test('a PATH folder whose git or gh links into the session`s folder or root, or to nothing, leaves no entry', async () => {
  const env = layout();
  const root = path.join(env.base, 'root');
  const linkIn = (name, target) => {
    const folder = path.join(env.base, `${name}-${path.basename(path.dirname(target))}`);
    mkdirSync(folder, { recursive: true });
    symlinkSync(write(target), path.join(folder, name));
    return folder;
  };
  const planted = [
    linkIn('git', path.join(env.project, 'tools/git')),
    linkIn('gh', path.join(env.project, 'vendor/gh')),
    linkIn('git', path.join(root, 'bin/git')),
    linkIn('gh', path.join(root, 'cli/gh')),
  ];
  const dangling = path.join(env.base, 'dangling');
  mkdirSync(dangling);
  symlinkSync(path.join(env.project, 'later/git'), path.join(dangling, 'git'));
  planted.push(dangling);
  const kept = linkIn('gh', path.join(env.base, 'elsewhere/gh'));
  write(path.join(env.bin, 'git'));
  const io = env.io({ PATH: [...planted, kept, env.bin].join(':') });
  const runner = await runnerFor(io, { cwd: env.project, root });
  assert.deepEqual(runner.entries, [realpathSync(kept), realpathSync(env.bin)]);
  assert.equal(await runner.which('git'), realpathSync(path.join(env.bin, 'git')));
  assert.equal((await runSnapshot(io, { session: ID, cwd: env.project, root })).kind, 'ok');
  assert.equal(io.calls[0].init.env.PATH, [realpathSync(kept), realpathSync(env.bin)].join(':'));
});

test('a non-zero exit is failed, whatever the output', async () => {
  const env = layout();
  for (const exitCode of [1, 2, -1, null]) {
    const io = env.io({ run: async () => ({ exitCode, stdout: '{"prs":[]}', stderr: '' }) });
    assert.deepEqual(await runSnapshot(io, { session: ID, cwd: env.project, root: env.project }), { kind: 'failed', transcript: realpathSync(env.transcript) }, String(exitCode));
  }
});
