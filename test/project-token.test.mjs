// The forge token a project run hands its issue session (lib/project-token.mjs): read outside the sandbox, which hides
// the system keyring, from the macOS keychain entry the main checkout's `.aidrian.local.json` names, then the machine's
// default entry, service aidrian-project-run, then the forge CLI's login; the start halts without one, the preflight names its source, and the SessionStart hook hands it to
// the confined session's sandboxed commands alone, as GH_TOKEN, through the host's session environment file.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { localForgeTokenKeychain } from '../plugins/aidrian/lib/config-local.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { confinedTokenVars, SHELL_VARS } from '../plugins/aidrian/lib/project-start.mjs';
import { DEFAULT_KEYCHAIN_SERVICE, forgeToken, keychainToken, tokenVars } from '../plugins/aidrian/lib/project-token.mjs';
import { FIXTURE_TOKEN, runFixture, STARTED } from './project-start-fixture.mjs';

const SESSION_START = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-start.mjs');
const REPOSITORY = { host: 'github.com', owner: 'acme', name: 'widgets' };
const ENTRY = { service: 'aidrian-forge', account: 'acme-widgets' };
const KEYCHAIN_TOKEN = 'github_pat_KEYCHAIN0123456789';
const LOGIN_TOKEN = 'github_pat_LOGIN0123456789';

// A stand-in for execFileSync running `security`: each call kept, answering `answer()` or throwing what it throws.
function keychain(answer) {
  const calls = [];
  const exec = (program, args, options) => {
    calls.push({ program, args, options });
    return answer();
  };
  return { exec, calls };
}
const exit = (status, message = 'security: failed') => () => { throw Object.assign(new Error(message), { status }); };
const login = (token = LOGIN_TOKEN) => {
  const calls = [];
  return { calls, authToken: (options) => (calls.push(options), typeof token === 'function' ? token() : token) };
};

test('the keychain entry is read with security from PATH, an argv with no shell, and a missing entry is told apart from a failed read', () => {
  const found = keychain(() => `${KEYCHAIN_TOKEN}\n`);
  assert.deepEqual(keychainToken(ENTRY, { exec: found.exec }), { token: KEYCHAIN_TOKEN });
  assert.ok(path.isAbsolute(found.calls[0].program) && path.basename(found.calls[0].program) === 'security', found.calls[0].program);
  assert.deepEqual(found.calls[0].args, ['find-generic-password', '-s', 'aidrian-forge', '-a', 'acme-widgets', '-w']);
  assert.equal(found.calls[0].options.shell, undefined, 'no shell reads the names');
  assert.equal(found.calls[0].options.timeout, 1500);
  keychainToken({ service: DEFAULT_KEYCHAIN_SERVICE }, { exec: found.exec });
  assert.deepEqual(found.calls[1].args, ['find-generic-password', '-s', 'aidrian-project-run', '-w'], 'the default entry, any account');
  assert.match(keychainToken(ENTRY, { env: { PATH: '' }, exec: found.exec }).problem, /security tool is not on PATH/u);
  assert.deepEqual(keychainToken(ENTRY, { exec: keychain(exit(44)).exec }), { missing: true }, 'security exits 44 when no entry matches');
  assert.match(keychainToken(ENTRY, { exec: keychain(exit(51, 'User interaction is not allowed.')).exec }).problem, /could not be read \(User interaction is not allowed\.\)/u);
  assert.match(keychainToken(ENTRY, { exec: keychain(() => { throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' }); }).exec }).problem, /did not answer in 1\.5 s/u);
  assert.match(keychainToken(ENTRY, { exec: keychain(() => 'a b\n').exec }).problem, /not shaped like a token/u);
});

const PROJECT_SOURCE = 'the project\'s keychain entry service "aidrian-forge", account "acme-widgets" (projectRun.forgeTokenKeychain)';
const DEFAULT_SOURCE = 'the machine\'s default keychain entry, service "aidrian-project-run"';
// A keychain whose entries are `given`, by service: each read kept, an entry not there exits 44.
const entries = (given) => {
  const read = [];
  const exec = (_program, args) => {
    const service = args[args.indexOf('-s') + 1];
    read.push(service);
    if (!Object.hasOwn(given, service)) exit(44)();
    return given[service];
  };
  return { exec, read };
};

test('on macOS the token comes from the project\'s keychain entry, then the machine\'s default entry, then the forge CLI\'s login', () => {
  const forge = login();
  const project = entries({ 'aidrian-forge': KEYCHAIN_TOKEN, 'aidrian-project-run': 'github_pat_DEFAULT0123456789' });
  assert.deepEqual(forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: project.exec }), { token: KEYCHAIN_TOKEN, source: PROJECT_SOURCE, notes: [] });
  assert.deepEqual(project.read, ['aidrian-forge'], 'the first source that gives one ends the reads');
  const fallback = entries({ 'aidrian-project-run': 'github_pat_DEFAULT0123456789' });
  const second = forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: fallback.exec });
  assert.deepEqual(second, { token: 'github_pat_DEFAULT0123456789', source: DEFAULT_SOURCE, notes: [`${PROJECT_SOURCE} is not there, so the next source gives the token`] });
  assert.deepEqual(fallback.read, ['aidrian-forge', 'aidrian-project-run']);
  const machine = forgeToken({ forge, repository: REPOSITORY, platform: 'darwin', exec: entries({ 'aidrian-project-run': 'github_pat_DEFAULT0123456789' }).exec });
  assert.deepEqual(machine, { token: 'github_pat_DEFAULT0123456789', source: DEFAULT_SOURCE, notes: [] }, 'no project key: the default entry first');
  assert.deepEqual(forge.calls, [], 'the forge CLI is not asked while a keychain entry gives the token');
  const neither = entries({});
  const last = forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: neither.exec });
  assert.equal(last.token, LOGIN_TOKEN);
  assert.equal(last.source, 'the forge CLI\'s login for github.com');
  assert.deepEqual(last.notes, [`${PROJECT_SOURCE} is not there, so the next source gives the token`], 'a default entry that is not there is no note');
  assert.deepEqual(forge.calls, [{ host: 'github.com' }]);
  const locked = forgeToken({ forge: login(), repository: REPOSITORY, platform: 'darwin', exec: keychain(exit(51, 'User interaction is not allowed.')).exec });
  assert.deepEqual(locked.notes, [`${DEFAULT_SOURCE} it could not be read (User interaction is not allowed.), so the next source gives the token`]);
});

test('off macOS the key is a note that it is unsupported, and the forge CLI\'s login gives the token', () => {
  const read = forgeToken({ forge: login(), repository: REPOSITORY, keychain: ENTRY, platform: 'linux', exec: () => assert.fail('no keychain on Linux') });
  assert.equal(read.token, LOGIN_TOKEN);
  assert.deepEqual(read.notes, ['projectRun.forgeTokenKeychain in .aidrian.local.json reads the macOS keychain, which linux has not, so the forge CLI\'s login gives the token']);
});

test('no token from either source is a problem naming both and the fix, and a broad token a note naming its kind, never the token', () => {
  const none = forgeToken({ forge: login(() => { throw new Error('no oauth token found for github.com'); }), repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: keychain(exit(44)).exec });
  assert.equal(none.token, undefined);
  assert.equal(none.problem, `no source gives a forge token for github.com, of ${PROJECT_SOURCE}, ${DEFAULT_SOURCE}, the forge CLI's login (the login: no oauth token found for github.com), and an issue session reaches the forge only with one; sign the forge CLI in with \`gh auth login --hostname github.com --git-protocol https\`, or add a keychain entry of service "aidrian-project-run", or name one in projectRun.forgeTokenKeychain of .aidrian.local.json`);
  assert.match(forgeToken({ forge: login(''), repository: REPOSITORY, platform: 'linux' }).problem, /^no source gives a forge token for github\.com, of the forge CLI's login \(the login: it gave no token\)/u);
  const classic = forgeToken({ forge: login('gho_classic0123456789'), repository: REPOSITORY, platform: 'linux' });
  assert.deepEqual(classic.notes, ['it is an OAuth token of gh\'s own login, which reaches every repository and scope its user has, not only this one; a fine-grained token limited to this repository narrows that']);
  assert.ok(!JSON.stringify({ ...classic, token: null }).includes('gho_classic'), 'only `token` holds it');
  assert.deepEqual(tokenVars('x'), { GH_TOKEN: 'x' });
});

test('the local file\'s projectRun.forgeTokenKeychain is checked, and read only from the main checkout\'s untracked file', (t) => {
  const errors = [];
  assert.equal(localForgeTokenKeychain({}, errors), null);
  assert.deepEqual(localForgeTokenKeychain({ projectRun: { forgeTokenKeychain: ENTRY } }, errors), ENTRY);
  assert.deepEqual(errors, []);
  for (const bad of [
    { projectRun: true }, { projectRun: { forgeTokenKeychain: ENTRY, allow: true } }, { projectRun: { forgeTokenKeychain: { service: 'x' } } },
    { projectRun: { forgeTokenKeychain: { ...ENTRY, extra: 1 } } }, { projectRun: { forgeTokenKeychain: { service: ' ', account: 'a' } } },
    { projectRun: { forgeTokenKeychain: { service: 'a\nb', account: 'a' } } }, { projectRun: { forgeTokenKeychain: { service: 'x'.repeat(256), account: 'a' } } },
  ]) {
    const found = [];
    assert.equal(localForgeTokenKeychain(bad, found, '.aidrian.local.json'), null, JSON.stringify(bad));
    assert.match(found[0], /^\.aidrian\.local\.json: "projectRun" must be \{ "forgeTokenKeychain": \{ "service": "<name>", "account": "<name>" \} \}/u);
  }
  const fx = runFixture(t, { init: false, local: { handoff: { background: 'on' }, projectRun: { forgeTokenKeychain: ENTRY } } });
  const project = findProject(fx.dir);
  assert.deepEqual(project.localForgeTokenKeychain, ENTRY);
  assert.deepEqual(project.errors, []);
  execFileSync('git', ['-C', fx.dir, 'add', '-f', '.aidrian.local.json'], { stdio: 'pipe' });
  const tracked = findProject(fx.dir);
  assert.equal(tracked.localForgeTokenKeychain, null, 'a tracked file could travel with a branch');
  assert.ok(tracked.errors.some((each) => /git tracks it, so a branch could carry it; "projectRun\.forgeTokenKeychain" is ignored/u.test(each)), tracked.errors.join('\n'));
});

test('a Claude Code start with no forge token to hand its session halts, recording nothing; with one it starts, and the token is in no argv or file of the start', (t) => {
  assert.equal(claudeCode.capabilities.projectStart.forgeTokenEnv, true);
  const fx = runFixture(t);
  const none = { ...fx.forge, authToken: () => { throw new Error('no oauth token found for github.com'); } };
  const halted = fx.cmd(['start', 'launch', 'ENG-1'], { forge: none });
  assert.equal(halted.exitCode, 1, halted.out.join('\n'));
  assert.equal(halted.out[0], 'halt no source gives a forge token for github.com, of the forge CLI\'s login (the login: no oauth token found for github.com), and an issue session reaches the forge only with one; sign the forge CLI in with `gh auth login --hostname github.com --git-protocol https`, or add a keychain entry of service "aidrian-project-run", or name one in projectRun.forgeTokenKeychain of .aidrian.local.json');
  assert.deepEqual(fx.claude.starts(), [], 'no claude --bg');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'start'), [], 'nothing recorded');
  const started = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(started.exitCode, 0, started.out.join('\n'));
  assert.ok(fx.forge.calls.some(([name, options]) => name === 'authToken' && options.host === 'github.com'), 'the start asked for the token');
  assert.ok(!JSON.stringify(fx.claude.calls).includes(FIXTURE_TOKEN), 'no argv of the start holds the token');
  const attempt = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1');
  assert.ok(!readFileSync(path.join(attempt, SHELL_VARS), 'utf8').includes(FIXTURE_TOKEN), 'nor the attempt\'s shell variables');
  assert.ok(!JSON.stringify(fx.rows()).includes(FIXTURE_TOKEN), 'nor the ledger');
});

test('preflight says ok access with a note naming the token\'s source, and a blocker when there is none', (t) => {
  const fx = runFixture(t, { init: false, local: { handoff: { background: 'on' }, projectRun: { forgeTokenKeychain: ENTRY } } });
  const ok = fx.cmd(['preflight']).out;
  assert.ok(ok.includes('ok access'), ok.join('\n'));
  assert.deepEqual(ok.filter((line) => line.startsWith('note token:')), [
    'note token: the forge CLI\'s login for github.com gives the issue sessions their forge token',
    'note token: projectRun.forgeTokenKeychain in .aidrian.local.json reads the macOS keychain, which linux has not, so the forge CLI\'s login gives the token',
  ]);
  assert.ok(!ok.join('\n').includes(FIXTURE_TOKEN), 'the preflight never prints the token');
  const classic = fx.cmd(['preflight'], { forge: { ...fx.forge, authToken: () => 'ghp_classic0123456789' } }).out;
  assert.ok(classic.includes('ok access'));
  assert.ok(classic.some((line) => /^note token: it is a classic personal access token, which reaches every repository/u.test(line)), classic.join('\n'));
  const none = fx.cmd(['preflight'], { forge: { ...fx.forge, authToken: () => { throw new Error('not logged in'); } } }).out;
  assert.match(none.find((line) => line.startsWith('blocker access:')) ?? '', /^blocker access: no source gives a forge token for github\.com, of the forge CLI's login \(the login: not logged in\)/u);
});

test('the SessionStart hook hands GH_TOKEN, read again for itself, to the sandboxed commands of a confined attempt\'s session alone', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  // The forge CLI the hook finds on PATH, which answers its login's token, as gh does from the keyring.
  const hookToken = 'github_pat_HOOK0123456789';
  writeFileSync(path.join(fx.bin, 'gh'), `#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && { echo ${hookToken}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const hook = (session, cwd, file) => spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...fx.env, CLAUDE_ENV_FILE: file, CLAUDE_CODE_SESSION_ID: session }, encoding: 'utf8',
  });
  const file = path.join(fx.root, 'session-env', 'own.sh');
  mkdirSync(path.dirname(file), { recursive: true });
  const ran = hook(STARTED[0].session, work, file);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(!`${ran.stdout}${ran.stderr}`.includes(hookToken), 'the hook prints no token');
  const seen = spawnSync('/bin/sh', ['-c', `. '${file}'; printf '%s' "$GH_TOKEN"`], { encoding: 'utf8' });
  assert.equal(seen.stdout, hookToken);
  // Another session in that clone, and the session elsewhere, get no token.
  for (const [session, cwd] of [['abcd1234-0000-4000-8000-00000000ff01', work], [STARTED[0].session, fx.dir]]) {
    const other = path.join(fx.root, 'session-env', `${session}-${path.basename(cwd)}.sh`);
    assert.equal(hook(session, cwd, other).status, 0);
    let text = '';
    try {
      text = readFileSync(other, 'utf8');
    } catch {
      text = '';
    }
    assert.doesNotMatch(text, /GH_TOKEN/u, `${session} in ${cwd}`);
  }
  // In process: the read gets the main checkout, its pinned repository, and its keychain setting.
  let asked = null;
  const vars = confinedTokenVars({ session: STARTED[0].session, cwd: work, env: fx.env, token: (given) => ((asked = given), { token: 'github_pat_STANDIN0123' }) });
  assert.deepEqual(vars, { GH_TOKEN: 'github_pat_STANDIN0123' });
  assert.deepEqual([asked.root, asked.repository, asked.keychain, asked.env], [findProject(fx.dir).root, { host: 'github.com', owner: 'acme', name: 'widgets' }, null, fx.env]);
  assert.equal(confinedTokenVars({ session: STARTED[0].session, cwd: work, env: fx.env, token: () => ({ problem: 'none' }) }), null);
});
