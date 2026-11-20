// The push preflight (docs/handoff.md#the-push-preflight): before a run no Human attends starts work, whether the host
// would let a session push to the repository's remote. Only a clear denial stops a run; every case it cannot read
// answers unknown and the run starts. The host sees `host/owner/repo` only, so no credential in the remote URL is ever
// sent or printed. Temporary repositories are made with `git init` under mkdtemp and driven with `git -C`; no test sets GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HOSTS, UNKNOWN_HOST } from '../plugins/aidrian/lib/hosts/index.mjs';
import { personalWords } from '../plugins/aidrian/lib/names.mjs';
import { pushPreflight } from '../plugins/aidrian/lib/push-preflight.mjs';
import fakeHost from './fixtures/adapters/fake-host.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const SESSION = 'session-1';
const REPOSITORY = 'github.com/acme/widget';
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const claudeCode = HOSTS.find((host) => host.id === 'claude-code');

// A temporary folder, a git repository with `origin` at `origin` when given.
function repository(t, { origin, init = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-push-preflight-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (init) execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  if (origin) execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', origin]);
  return dir;
}

// A host that answers `read` and records each ask.
function answering(read) {
  const asks = [];
  return { asks, host: { ...fakeHost, capabilities: { pushPermission: (ask) => { asks.push(ask); return read; } } } };
}
// A git stand-in whose `remote get-url --push --all origin` prints `url`.
const remote = (url) => () => ({ status: 0, stdout: `${url}\n`, stderr: '' });
const DENIAL = { answer: 'denied', setting: 'trust.list', file: '/srv/fake/settings.json', why: 'names no remote', fix: 'adds this remote to that list' };

// A Claude Code config folder whose settings.json holds `settings`, and whose transcript of SESSION, started in `dir`,
// says it runs in the permission mode `mode`; and the environment of a Claude Code shell that names both.
function claudeShell(t, dir, { settings, mode = 'auto' } = {}) {
  const config = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-push-config-')));
  t.after(() => rmSync(config, { recursive: true, force: true }));
  if (settings !== undefined) writeFileSync(path.join(config, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
  const transcripts = path.join(config, 'projects', dir.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  const lines = [{ type: 'permission-mode', permissionMode: 'manual', sessionId: SESSION }, { type: 'permission-mode', permissionMode: mode, sessionId: SESSION }];
  writeFileSync(path.join(transcripts, `${SESSION}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return { config, env: { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: config } };
}
const ONLY_OTHER = { autoMode: { environment: ['Trusted repo: github.com/acme/other'] } };
const TRUSTED = { autoMode: { environment: ['Trusted repo: github.com/acme/widget'] } };

test('no remote, a remote on this machine, and a folder that is no repository answer unknown, and never ask the host', (t) => {
  const { asks, host } = answering(DENIAL);
  assert.deepEqual(pushPreflight({ cwd: repository(t), host, session: SESSION }), { answer: 'unknown' }, 'no origin');
  assert.deepEqual(pushPreflight({ cwd: repository(t, { init: false }), host, session: SESSION }), { answer: 'unknown' }, 'no repository');
  const onDisk = repository(t);
  const bare = repository(t, { origin: onDisk });
  assert.deepEqual(pushPreflight({ cwd: bare, host, session: SESSION }), { answer: 'unknown' }, 'a remote on disk');
  for (const url of ['/srv/git/widget.git', './widget.git', '../widget', '~/git/widget', 'file:///srv/git/widget.git', 'FILE:///x/y/z', 'C:\\git\\widget', 'c:/git/acme/widget', '\\\\server\\share\\widget']) {
    assert.deepEqual(pushPreflight({ cwd: bare, host, session: SESSION, git: remote(url) }), { answer: 'unknown' }, url);
  }
  for (const git of [() => ({ status: 2, stdout: '', stderr: 'error: No such remote' }), () => ({ status: null, stdout: '', stderr: '' }), remote(''), () => { throw new Error('spawn'); }, () => null]) {
    assert.deepEqual(pushPreflight({ cwd: bare, host, session: SESSION, git }), { answer: 'unknown' }, String(git));
  }
  assert.deepEqual(asks, [], 'the host was never asked');
});

test('only a network URL or an scp-style host:path is a network remote: a relative path that reads like one answers unknown, and never asks the host', (t) => {
  const { asks, host } = answering(DENIAL);
  const cwd = repository(t);
  // git reads each of these as a path on this machine, from the repository's folder, though some look like host/owner/repo.
  for (const url of ['mirrors.example/acme/widget.git', 'github.com/acme/widget', 'github.com/acme/widget.git', 'acme.example/widget/repo', 'foo://github.com/acme/widget', 'rsync://github.com/acme/widget', 'github.com::acme/widget']) {
    assert.deepEqual(pushPreflight({ cwd, host, session: SESSION, git: remote(url) }), { answer: 'unknown' }, url);
  }
  assert.deepEqual(asks, [], 'the host was never asked');
  // Each network form still reaches the host as host/owner/repo.
  for (const url of ['https://github.com/acme/widget.git', 'http://github.com/acme/widget', 'ssh://git@github.com/acme/widget.git', 'git://github.com/acme/widget.git', 'git+ssh://git@github.com/acme/widget', 'git@github.com:acme/widget.git', 'github.com:acme/widget.git']) {
    const asked = answering(DENIAL);
    assert.equal(pushPreflight({ cwd, host: asked.host, session: SESSION, git: remote(url) }).answer, 'denied', url);
    assert.equal(asked.asks[0].repository, REPOSITORY, url);
  }
});

test('a host without the capability, one that throws, and one that answers allowed or unknown start the run', (t) => {
  const cwd = repository(t, { origin: 'https://github.com/acme/widget.git' });
  assert.deepEqual(pushPreflight({ cwd, host: fakeHost, session: SESSION }), { answer: 'unknown' }, 'no capability');
  assert.deepEqual(pushPreflight({ cwd, host: UNKNOWN_HOST, session: SESSION }), { answer: 'unknown' }, 'the unknown host');
  const throwing = { ...fakeHost, capabilities: { pushPermission: () => { throw new Error('boom'); } } };
  assert.deepEqual(pushPreflight({ cwd, host: throwing, session: SESSION }), { answer: 'unknown' }, 'a capability that throws');
  const named = { ...fakeHost, get name() { throw new Error('boom'); }, capabilities: { pushPermission: () => DENIAL } };
  assert.deepEqual(pushPreflight({ cwd, host: named, session: SESSION }), { answer: 'unknown' }, 'a host that throws while the message is worded');
  const allowed = answering({ answer: 'allowed', extra: 'dropped' });
  assert.deepEqual(pushPreflight({ cwd, host: allowed.host, session: SESSION, env: { A: '1' } }), { answer: 'allowed' });
  assert.deepEqual(allowed.asks, [{ repository: REPOSITORY, session: SESSION, cwd, env: { A: '1' } }], 'the host gets host/owner/repo, the session, the folder, and the environment');
  const unknown = answering({ answer: 'unknown' });
  assert.deepEqual(pushPreflight({ cwd, host: unknown.host, session: SESSION }), { answer: 'unknown' });
  // With no session given, the host's own id for this environment.
  const own = answering({ answer: 'allowed' });
  pushPreflight({ cwd, host: own.host, env: { FAKEHOST_SESSION: 'fake-1' } });
  assert.equal(own.asks[0].session, 'fake-1');
});

test('a denial gives one line that names the host, the setting, its file, the repository, the Human, and the host\'s AI', (t) => {
  const cwd = repository(t, { origin: 'git@github.com:acme/widget.git' });
  const read = pushPreflight({ cwd, host: answering(DENIAL).host, session: SESSION });
  assert.equal(read.answer, 'denied');
  assert.equal(read.repository, REPOSITORY);
  assert.equal(read.message, 'Fake Host would refuse a push to this repository\'s remote, github.com/acme/widget: trust.list in /srv/fake/settings.json names no remote. Before a run no Human attends, the Human adds this remote to that list; Faker never changes that file');
  assert.ok(!CONTROL.test(read.message), 'one line');
  assert.ok(!read.message.endsWith('.'), 'no final full stop, so a caller goes on after it');

  // Claude Code itself, in auto mode, with settings that trust only another remote.
  const { config, env } = claudeShell(t, cwd, { settings: ONLY_OTHER });
  const claude = pushPreflight({ cwd, env });
  assert.equal(claude.answer, 'denied');
  for (const words of ['Claude Code would refuse a push', 'autoMode.environment', path.join(config, 'settings.json'), REPOSITORY, 'the Human adds "$defaults" to that list', 'Claude never changes that file']) {
    assert.ok(claude.message.includes(words), `${words}: ${claude.message}`);
  }
  assert.ok(!CONTROL.test(claude.message));
  assert.deepEqual(personalWords(claude.message), []);
  assert.deepEqual(personalWords(read.message), []);
});

test('a credential in the remote URL never reaches the host or the message: only host/owner/repo does', (t) => {
  for (const url of ['https://user:secret@github.com/acme/widget.git', 'git@github.com:acme/widget.git', 'ssh://git@github.com:22/acme/widget', 'https://x-access-token:secret@GitHub.com/Acme/Widget/', 'https://user:sec:ret@github.com/acme/widget']) {
    const { asks, host } = answering(DENIAL);
    const read = pushPreflight({ cwd: repository(t, { origin: url }), host, session: SESSION });
    assert.equal(read.repository, REPOSITORY, url);
    assert.equal(asks[0].repository, REPOSITORY, url);
    assert.ok(!JSON.stringify(asks).includes('secret') && !read.message.includes('secret') && !read.message.includes('sec:'), url);
  }
  // A password that holds an `@` leaves part of itself before the host: nothing is asked or printed.
  for (const url of ['https://user:p@ss@github.com/acme/widget.git', 'https://user:p@ss:word@github.com/acme/widget']) {
    const { asks, host } = answering(DENIAL);
    assert.deepEqual(pushPreflight({ cwd: repository(t), host, session: SESSION, git: remote(url) }), { answer: 'unknown' }, url);
    assert.deepEqual(asks, [], url);
  }
  // Not host/owner/repo in plain ASCII, too long, a query or a fragment, a hidden or right-to-left character, or more
  // than one push URL: unknown, and the host is never asked.
  const { asks, host } = answering(DENIAL);
  for (const url of ['https://github.com/acme', 'github.com', 'https://github.com//widget', `https://github.com/acme/${'w'.repeat(1024)}`, 'https://github.com/acme/wid get', 'https://github.com/acme/wid\tget', 'https://github.com/acme/wid\u0007get',
    'https://github.com/acme/wid\u202eget', 'https://github.com/acme/wid\u200bget', 'https://github.com/acme/widget?token=x', 'https://github.com/acme/widget#frag',
    'https://github.com/acme/../widget', 'https://github.com/ac%me/wid$get', 'https://github.com/acme/widget\nhttps://github.com/acme/other']) {
    assert.deepEqual(pushPreflight({ cwd: repository(t), host, session: SESSION, git: remote(url) }), { answer: 'unknown' }, url);
  }
  assert.deepEqual(asks, []);
});

test('an SSH host alias answers unknown without asking the host, and a .git suffix in any case is dropped', (t) => {
  // A host with no dot, such as an alias in the SSH config, names no host a setting would: the host is never asked.
  const { asks, host } = answering(DENIAL);
  for (const url of ['git@github-work:acme/widget.git', 'github-work:acme/widget', 'ssh://git@github-work/acme/widget.git', 'https://localhost/acme/widget']) {
    assert.deepEqual(pushPreflight({ cwd: repository(t), host, session: SESSION, git: remote(url) }), { answer: 'unknown' }, url);
  }
  assert.deepEqual(asks, [], 'the host was never asked');
  for (const url of ['git@github.com:acme/widget.GIT', 'https://github.com/Acme/Widget.Git/', 'git@github.com:acme/widget.git']) {
    const asked = answering(DENIAL);
    const read = pushPreflight({ cwd: repository(t), host: asked.host, session: SESSION, git: remote(url) });
    assert.equal(read.repository, REPOSITORY, url);
    assert.equal(asked.asks[0].repository, REPOSITORY, url);
  }
});

test('the push URL is the remote judged: a pushurl of another repository is the one the host is asked about', (t) => {
  const cwd = repository(t, { origin: 'https://github.com/acme/widget.git' });
  execFileSync('git', ['-C', cwd, 'config', 'remote.origin.pushurl', 'git@github.com:acme/mirror.git']);
  const { asks, host } = answering(DENIAL);
  const read = pushPreflight({ cwd, host, session: SESSION });
  assert.equal(read.repository, 'github.com/acme/mirror');
  assert.equal(asks[0].repository, 'github.com/acme/mirror');
  // Two push URLs: no one remote to judge.
  execFileSync('git', ['-C', cwd, 'config', '--add', 'remote.origin.pushurl', 'git@github.com:acme/widget.git']);
  assert.deepEqual(pushPreflight({ cwd, host, session: SESSION }), { answer: 'unknown' });
  assert.equal(asks.length, 1, 'the host was not asked again');
});

test('aidrian push-preflight exits 0 on allowed or unknown with nothing on stderr, 1 on denied with the reason, and 2 on any argument', (t) => {
  const run = (cwd, args = [], env = process.env) => spawnSync(CLI, ['push-preflight', ...args], { cwd, env, encoding: 'utf8' });
  const plain = repository(t);
  assert.deepEqual([run(plain).status, run(plain).stdout, run(plain).stderr], [0, 'push: unknown\n', ''], 'no remote, no host');

  const denied = repository(t, { origin: 'https://user:secret@github.com/acme/widget.git' });
  const { config, env } = claudeShell(t, denied, { settings: ONLY_OTHER });
  const refused = run(denied, [], env);
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stdout, 'push: denied\n');
  assert.match(refused.stderr, /^aidrian push-preflight: Claude Code would refuse a push to this repository's remote, github\.com\/acme\/widget: autoMode\.environment in /u);
  assert.ok(refused.stderr.includes(path.join(config, 'settings.json')), refused.stderr);
  assert.ok(!refused.stderr.includes('secret'), 'no credential is printed');
  assert.equal(refused.stderr.split('\n').length, 2, 'one line');

  const trusted = repository(t, { origin: 'git@github.com:acme/widget.git' });
  const allowed = run(trusted, [], claudeShell(t, trusted, { settings: TRUSTED }).env);
  assert.deepEqual([allowed.status, allowed.stdout, allowed.stderr], [0, 'push: allowed\n', '']);
  // Not in auto mode, and settings that cannot be read: the run starts with no error shown.
  for (const [label, shell] of [['acceptEdits', { settings: ONLY_OTHER, mode: 'acceptEdits' }], ['bad JSON', { settings: '{"autoMode": {' }], ['no autoMode', { settings: {} }], ['no settings', {}]]) {
    const each = run(denied, [], claudeShell(t, denied, shell).env);
    assert.deepEqual([each.status, each.stdout, each.stderr], [0, 'push: unknown\n', ''], label);
  }

  // A folder removed under the command: no remote can be read, and the run starts.
  const gone = repository(t);
  // Node is started straight from the shell that removed it: a second shell would print its own complaint first.
  const removed = spawnSync('sh', ['-c', 'cd "$1" && rm -rf "$1" && exec "$2" "$3" push-preflight', 'sh', gone, process.execPath, path.join(ROOT, 'plugins/aidrian/lib/cli.mjs')], { encoding: 'utf8' });
  assert.deepEqual([removed.status, removed.stdout, removed.stderr], [0, 'push: unknown\n', ''], 'a removed folder');

  for (const args of [['x'], ['--help'], ['--project', plain], ['--cwd'], ['--cwd', plain, 'x'], ['--cwd', plain, '--cwd', plain], [`--cwd=${plain}`], ['--cwd', '']]) {
    const misuse = run(plain, args);
    assert.equal(misuse.status, 2, args.join(' '));
    assert.equal(misuse.stdout, '');
    assert.equal(misuse.stderr, 'usage: aidrian push-preflight [--cwd DIR]\n', args.join(' '));
  }
});

test('aidrian push-preflight --cwd judges the folder it names, not the folder it runs in', (t) => {
  const run = (cwd, args = [], env = process.env) => spawnSync(CLI, ['push-preflight', ...args], { cwd, env, encoding: 'utf8' });
  const denied = repository(t, { origin: 'https://github.com/acme/widget.git' });
  const trusted = repository(t, { origin: 'https://github.com/acme/other.git' });
  const { env } = claudeShell(t, denied, { settings: ONLY_OTHER });
  // From the trusted folder, the denied one named: denied, about the named folder's remote.
  const refused = run(trusted, ['--cwd', denied], env);
  assert.deepEqual([refused.status, refused.stdout], [1, 'push: denied\n'], refused.stderr);
  assert.ok(refused.stderr.includes('github.com/acme/widget'), refused.stderr);
  // From the denied folder, the trusted one named: allowed. A relative folder is read from where the command runs.
  assert.deepEqual([run(denied, ['--cwd', trusted], env).status, run(denied, ['--cwd', trusted], env).stdout], [0, 'push: allowed\n']);
  assert.equal(run(path.dirname(trusted), ['--cwd', path.basename(trusted)], env).stdout, 'push: allowed\n');
  // A folder that is not there has no remote to read: unknown, and the run starts.
  assert.deepEqual([run(trusted, ['--cwd', path.join(trusted, 'gone')], env).status, run(trusted, ['--cwd', path.join(trusted, 'gone')], env).stdout], [0, 'push: unknown\n']);
});

test('the autopilot skill runs the push preflight before launch, and names no host and no host setting there', () => {
  const skill = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/autopilot/SKILL.md'), 'utf8');
  const start = skill.indexOf('## Before launch');
  const launch = skill.slice(start, skill.indexOf('\n## ', start + 1)).replace(/\s+/gu, ' ');
  assert.ok(launch.includes('`aidrian push-preflight --cwd <dir>`'), launch);
  assert.match(launch, /the folder the run will work in/u, 'the folder judged is the one the run works in');
  const resume = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/autopilot/references/entry-continue.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.match(resume, /runs the push preflight with `--cwd` that worktree/u, 'a continued session judges the worktree of the work under way');
  assert.match(launch, /On exit 1/u);
  assert.match(launch, /tell the Human its printed line, and start no run unless the Human says to go on/u);
  for (const word of ['Claude Code', 'Codex', 'autoMode', 'settings.json', '$defaults']) assert.ok(!skill.includes(word), `the skill names ${word}`);
});
