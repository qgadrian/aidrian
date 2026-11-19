// The per-start sandbox proof of a confined Claude Code session (lib/project-confine.mjs): the start writes the proof's
// plan and runs a localhost listener outside the sandbox; the agent gate hook lets the session run only the exact
// `aidrian project confine <run> <issue>` until the start confirms the proof in its mark, and nothing once it failed;
// the proof tries, from inside the session's shell, every write, removal, move, link, read, and connection the sandbox
// must refuse; and the start holds the session only on a verdict that passed, with no hit on the listener and no probe
// left behind. No test runs a real sandbox: an unsandboxed run of the proof shows every probe succeed.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ATTEMPT_KEEP, KEPT_FOLDERS } from '../plugins/aidrian/lib/attempt-clone.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { CONFINE_PLAN, CONFINE_VERDICT, confineCheck, confineDenial, hostVarsProblem, isConfineCall, prepareConfine, readSmallJson, runConfine, SHELL_VARS, shellVarsProblem, startListener, unlistedHost } from '../plugins/aidrian/lib/project-confine.mjs';
import { ACTIONS, projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { projectPrompt } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { projectCommandDenial } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { REGISTRY_NAMES, registryHosts } from '../plugins/aidrian/lib/project-registries.mjs';
import { SHELL_VARS as START_SHELL_VARS } from '../plugins/aidrian/lib/project-start.mjs';
import { markFolders, markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { fakeClaude, OTHER, passVerdict, runFixture, STARTED } from './project-start-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const NAMES = { names: { human: 'the Human' } };
const SESSION = 'confined-session-1';

// An attempt's folder as the start lays it out, `<root>/state/runs/launch/attempts/ENG-1.1/`, with the keep files, the
// clone's git config and settings placeholder, the mark folders, and the shell environment the gate writes.
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
  const home = path.join(root, 'home');
  const env = { XDG_STATE_HOME: path.join(root, 'xdg') };
  for (const dir of markFolders({ env, home })) mkdirSync(dir, { recursive: true });
  const secret = path.join(home, '.npmrc');
  writeFileSync(secret, '//registry.npmjs.org/:_authToken=x\n');
  const shell = vars ?? { npm_config_cache: path.join(cache, 'npm'), GOFLAGS: '-modcacherw' };
  writeFileSync(path.join(folder, SHELL_VARS), JSON.stringify(shell));
  return { root, folder, work, git, drop, cache, home, env, secret, vars: shell };
}

// The plan of `at`, with a listener that is not there unless `listen` is given.
function plan(at, { listen = () => ({ port: 9, stop() {} }), domains = ['github.com', 'api.github.com'] } = {}) {
  const made = prepareConfine({ folder: at.folder, run: 'launch', key: 'ENG-1', attempt: 1, work: at.work, git: at.git, drop: at.drop, cache: at.cache, domains, reads: [at.secret], env: at.env, home: at.home, listen });
  assert.equal(made.problem, undefined, made.problem);
  return made;
}

const bash = (command, cwd, session = SESSION) => ({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd });

test('the proof names a host outside every allowed domain and registry, and its files are spelled as the start\'s', () => {
  assert.equal(unlistedHost(['github.com', 'api.github.com', ...registryHosts(REGISTRY_NAMES)]), 'example.com');
  assert.equal(unlistedHost(['*.com', 'example.net']), 'example.org');
  assert.equal(unlistedHost(['example.com', 'example.net', '*.example.org']), null);
  assert.equal(SHELL_VARS, START_SHELL_VARS);
  assert.ok(ACTIONS.includes('confine'));
});

test('Claude Code proves each start\'s sandbox; Codex is unchanged', () => {
  const cap = claudeCode.capabilities.projectStart;
  assert.equal(cap.confineProof, true);
  assert.equal(typeof cap.confineReads, 'function');
  const reads = cap.confineReads({ env: { PATH: '' }, home: '/user-home' });
  for (const store of ['/user-home/.ssh', '/user-home/.npmrc', '/user-home/.claude/.credentials.json']) assert.ok(reads.includes(store), store);
  assert.equal(codex.capabilities.projectStart.confineProof, undefined);
  assert.equal(codex.capabilities.projectStart.verified, 'unverified');
});

test('the prompt makes the exact confine command the session`s first call only where the host proves its sandbox', () => {
  const given = { run: 'launch', key: 'ENG-1', attempt: 1, branch: 'feat/eng-1', clone: '/c' };
  assert.match(projectPrompt({ ...given, confine: true }), /first tool call, run exactly `aidrian project confine launch ENG-1` with the Bash tool, alone/u);
  assert.doesNotMatch(projectPrompt(given), /confine/u);
});

test('run outside any sandbox, the proof finds every probe succeed, undoes each, and fails; the start reads it as failed', async (t) => {
  const at = attempt(t);
  const listener = startListener(at.folder);
  assert.equal(listener.problem, undefined, listener.problem);
  t.after(() => listener.stop());
  const made = plan(at, { listen: () => listener });
  // No test reaches the network: the unlisted host is a closed local port, which refuses as a sandbox would.
  writeFileSync(path.join(at.folder, CONFINE_PLAN), JSON.stringify({ ...made.plan, unlisted: { host: '127.0.0.1', port: 9 } }));
  const config = readFileSync(path.join(at.git, 'config'), 'utf8');
  const result = await runConfine({ run: 'launch', key: 'ENG-1', cwd: at.work, env: { CLAUDE_CODE_SESSION_ID: SESSION } });
  assert.equal(result.exitCode, 1);
  assert.match(result.out[0], /^halt the sandbox does not hold for this session/u);
  const verdict = readSmallJson(path.join(at.drop, CONFINE_VERDICT));
  assert.equal(verdict.pass, false);
  assert.equal(verdict.session, SESSION);
  const failed = verdict.failed.join('\n');
  for (const each of [
    ...markFolders({ env: at.env, home: at.home }).map((dir) => `write ${dir}/.confine-probe-`), `write ${at.folder}/confine-probe-`, `write ${at.home}/confine-probe-`,
    `write ${at.git}/config`, `write ${at.work}/.claude/settings.json`,
    `remove ${at.cache}/${ATTEMPT_KEEP}`, `remove ${at.drop}/${ATTEMPT_KEEP}`, `move ${at.cache}`, `move ${at.drop}`, `link ${at.cache}`, `write through a link ${at.drop}`,
    `read ${at.secret}`, 'reach 127.0.0.1:', 'a localhost listener outside the sandbox', 'the cache variables npm_config_cache, GOFLAGS are not in force',
  ]) assert.ok(failed.includes(each), `${each}\n${failed}`);
  assert.doesNotMatch(failed, /reach 127\.0\.0\.1:9\b/u, 'a closed port is refused');
  // Each probe that succeeded was undone: the folders, the keep files, and the git config are as the start made them.
  for (const name of KEPT_FOLDERS) {
    assert.ok(lstatSync(path.join(at.folder, name)).isDirectory(), name);
    assert.ok(existsSync(path.join(at.folder, name, ATTEMPT_KEEP)), `${name}'s keep file`);
  }
  assert.equal(readFileSync(path.join(at.git, 'config'), 'utf8'), config);
  assert.deepEqual(confineCheck({ folder: at.folder, session: SESSION }).pass, false);
  // The listener, outside the sandbox, saw the connection: the start fails the proof on that alone.
  writeFileSync(path.join(at.drop, CONFINE_VERDICT), JSON.stringify(passVerdict(made.plan, SESSION)));
  assert.match(confineCheck({ folder: at.folder, session: SESSION }).problem, /reached the localhost listener/u);
  // With the variables in force, they are no problem.
  assert.equal(shellVarsProblem(at.folder, at.vars), null);
});

test('the start holds the session only on a verdict of its own plan, with nothing left behind', (t) => {
  const at = attempt(t);
  const { plan: made } = plan(at);
  const check = () => confineCheck({ folder: at.folder, session: SESSION });
  const verdict = (value) => writeFileSync(path.join(at.drop, CONFINE_VERDICT), JSON.stringify(value));
  assert.equal(check(), null, 'no verdict yet');
  verdict(passVerdict(made, SESSION));
  assert.deepEqual(check(), { pass: true });
  verdict(passVerdict(made, null));
  assert.deepEqual(check(), { pass: true }, 'a shell that names no session');
  verdict(passVerdict(made, OTHER));
  assert.match(check().problem, /names the session/u);
  verdict({ ...passVerdict(made, SESSION), nonce: '0'.repeat(16) });
  assert.match(check().problem, /not this start's/u);
  verdict({ ...passVerdict(made, SESSION), pass: false, failed: ['write /x'] });
  assert.equal(check().problem, 'write /x');
  verdict(passVerdict(made, SESSION));
  writeFileSync(path.join(at.home, `confine-probe-${made.nonce}`), '');
  assert.match(check().problem, /a probe left .*confine-probe-/u);
  rmSync(path.join(at.home, `confine-probe-${made.nonce}`));
  rmSync(path.join(at.cache, ATTEMPT_KEEP), { force: true });
  assert.match(check().problem, /cache folder or its keep file/u);
});

test('the hook lets a session whose proof is owed run only the exact confine command, and nothing once it failed', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = (confine) => ({ root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine });
  const env = {};
  const exact = bash('aidrian project confine launch ENG-1', at.work);
  assert.equal(confineDenial(exact, { mark: mark(true), env }), null);
  assert.equal(isConfineCall(bash(`'${path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian')}' project confine launch ENG-1`, at.work), { run: 'launch', key: 'ENG-1' }), true);
  for (const command of ['aidrian project confine launch ENG-1; touch ~/x', 'aidrian project confine launch ENG-2', 'ls', 'aidrian project result launch ENG-1 --file r.json', 'AIDRIAN=1 aidrian project confine launch ENG-1']) {
    assert.match(confineDenial(bash(command, at.work), { mark: mark(true), env })?.reason ?? '', /its first call must be exactly `aidrian project confine launch ENG-1`/u, command);
  }
  assert.match(confineDenial({ session_id: SESSION, tool_name: 'Read', tool_input: { file_path: '/etc/hosts' }, cwd: at.work }, { mark: mark(true), env }).reason, /proves its sandbox/u);
  // Passed in the mark: every call goes on to the other guards.
  assert.equal(confineDenial(bash('ls', at.work), { mark: mark('passed'), env }), null);
  // Failed in the mark, or a failed verdict: nothing runs, the confine command included.
  assert.match(confineDenial(exact, { mark: mark('failed'), env }).reason, /refuses every later call/u);
  writeFileSync(path.join(at.drop, CONFINE_VERDICT), JSON.stringify({ pass: false, failed: ['write /x'] }));
  assert.match(confineDenial(exact, { mark: mark(true), env }).reason, /refuses every later call/u);
  // A verdict that passed, before the start confirmed it in the mark: the call waits.
  writeFileSync(path.join(at.drop, CONFINE_VERDICT), JSON.stringify({ pass: true }));
  assert.match(confineDenial(bash('ls', at.work), { mark: mark(true), env }).reason, /run this call again in a few seconds/u);
  // A mark whose confine state cannot be read counts as failed; one with none holds through a plan beside its clone.
  assert.match(confineDenial(exact, { mark: mark('bogus'), env }).reason, /refuses every later call/u);
  assert.match(confineDenial(bash('ls', at.work), { mark: { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1' }, env }).reason, /run this call again/u);
  // No mark, or a session marked with no proof and no plan, as on Codex: the hook leaves it to the other guards.
  assert.equal(confineDenial(bash('ls', at.work), { mark: null, env }), null);
  rmSync(path.join(at.folder, CONFINE_PLAN));
  assert.equal(confineDenial(bash('ls', at.work), { mark: { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1' }, env }), null);
});

test('a pending mark holds a call in the clone it starts to the proof, and no call elsewhere', (t) => {
  const at = attempt(t);
  plan(at);
  const pending = { root: at.root, cwd: at.work, pending: true };
  assert.match(confineDenial(bash('ls', path.join(at.work, '.claude')), { mark: pending, env: {} }).reason, /its first call must be exactly/u);
  assert.equal(confineDenial(bash('aidrian project confine launch ENG-1', at.work), { mark: pending, env: {} }), null);
  assert.equal(confineDenial(bash('ls', at.root), { mark: pending, env: {} }), null, 'a session the Human opened elsewhere');
});

test('the hook fails the proof when its own environment, the host process\'s, holds the session\'s cache variables', (t) => {
  const at = attempt(t);
  plan(at);
  const mark = { root: at.root, cwd: at.work, project: 'launch', issue: 'ENG-1', confine: true };
  // A value that names no cache folder, as the driver's own GOFLAGS, is no leak.
  assert.equal(hostVarsProblem(at.folder, { GOFLAGS: '-modcacherw' }), null);
  const exact = bash('aidrian project confine launch ENG-1', at.work);
  const denied = confineDenial(exact, { mark, env: { npm_config_cache: at.vars.npm_config_cache } });
  assert.match(denied.reason, /host process's own environment holds the cache variables npm_config_cache/u);
  const verdict = readSmallJson(path.join(at.drop, CONFINE_VERDICT));
  assert.deepEqual([verdict.pass, verdict.by, verdict.session], [false, 'hook', SESSION]);
  assert.match(confineDenial(exact, { mark, env: {} }).reason, /refuses every later call/u, 'and the session runs nothing more');
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
  const confine = hook(bash('aidrian project confine launch ENG-1', at.work));
  assert.equal(confine.status, 0, confine.stderr);
  assert.ok(markUnattended(SESSION, { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'failed' } }));
  assert.equal(hook(bash('aidrian project confine launch ENG-1', at.work)).status, 2);
  // A mark tag of another shape writes no mark.
  assert.equal(markUnattended('other-session', { root: at.root, cwd: at.work, env: at.env, tags: { project: 'launch', issue: 'ENG-1', confine: 'yes' } }), null);
});

test('`aidrian project confine` runs only in its issue`s clone, and its hook rule admits only that issue`s session', async (t) => {
  const answer = await projectCommand(['confine', 'launch', 'ENG-1'], { cwd: tmpdir(), env: {} });
  assert.equal(answer.exitCode, 1);
  assert.match(answer.err.join('\n'), /not a clone of the run launch's issue ENG-1/u);
  const fx = runFixture(t);
  const started = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(started.exitCode, 0, started.err.join('\n'));
  const work = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1', 'work');
  const own = STARTED[0].session;
  const confine = (session) => projectCommandDenial(bash('aidrian project confine launch ENG-1', work, session), NAMES, { home: fx.home });
  assert.equal(confine(own), null);
  assert.match(confine(OTHER)?.reason ?? '', /not that one/u);
});

test('a start writes the plan, holds the session once its proof passed, and files the pass in its mark; the listener stops', async (t) => {
  const fx = runFixture(t);
  const result = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  const folder = path.join(realpathSync(fx.state), 'runs', 'launch', 'attempts', 'ENG-1.1');
  const made = readSmallJson(path.join(folder, CONFINE_PLAN));
  assert.deepEqual([made.run, made.key, made.attempt, made.unlisted.host, made.local.host], ['launch', 'ENG-1', 1, 'example.com', '127.0.0.1']);
  assert.ok(made.marks.length >= 1);
  const prompt = fx.claude.starts()[0].args.at(-1);
  assert.match(prompt, /run exactly `aidrian project confine launch ENG-1`/u);
  assert.equal(readUnattendedMark(STARTED[0].session, { env: fx.env, home: fx.home }).confine, 'passed');
  const { pid } = readSmallJson(path.join(folder, 'confine-listener.json'));
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
