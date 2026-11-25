// The forge token a project run hands its issue session (lib/project-token.mjs): read outside the sandbox, which hides
// the system keyring, from the macOS keychain entry the main checkout's `.aidrian.local.json` names, then the machine's
// default entry, service aidrian-project-run, then the forge CLI's login. The start halts without one, or with one that
// may not push; the preflight names its source; and the SessionStart hook hands it, from that one source, to the
// sandboxed commands of the session holding the start's claim alone, as GH_TOKEN, through the host's session
// environment file, which the sandbox hides from every session.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { localForgeTokenKeychain } from '../plugins/aidrian/lib/config-local.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { confineReads, sandboxSettings, writeEnvFile } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { confinedShellVars, confinedTokenVars } from '../plugins/aidrian/lib/project-start.mjs';
import { apiStatus, receivePackStatus, tokenMayPush, TOKEN_READS, tokenReadProblems } from '../plugins/aidrian/lib/forges/github-token.mjs';
import { confineCheck } from '../plugins/aidrian/lib/project-confine.mjs';
import { CLAIM_VAR, DEFAULT_KEYCHAIN_SERVICE, forgeToken, gitCredentialVars, handoffProblem, keychainToken, TOKEN_FILES, tokenFiles, tokenVars } from '../plugins/aidrian/lib/project-token.mjs';
import { setupDocUrl } from '../plugins/aidrian/lib/project-preflight.mjs';
import { markPending } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, FIXTURE_TOKEN, runFixture, STARTED } from './project-start-fixture.mjs';

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
  assert.deepEqual(forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: project.exec }), { token: KEYCHAIN_TOKEN, id: 'project', source: PROJECT_SOURCE, notes: [] });
  assert.deepEqual(project.read, ['aidrian-forge'], 'the first source that gives one ends the reads');
  const fallback = entries({ 'aidrian-project-run': 'github_pat_DEFAULT0123456789' });
  const second = forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: fallback.exec });
  assert.deepEqual(second, { token: 'github_pat_DEFAULT0123456789', id: 'machine', source: DEFAULT_SOURCE, notes: [`${PROJECT_SOURCE} is not there, so the next source gives the token`] });
  assert.deepEqual(fallback.read, ['aidrian-forge', 'aidrian-project-run']);
  const machine = forgeToken({ forge, repository: REPOSITORY, platform: 'darwin', exec: entries({ 'aidrian-project-run': 'github_pat_DEFAULT0123456789' }).exec });
  assert.deepEqual(machine, { token: 'github_pat_DEFAULT0123456789', id: 'machine', source: DEFAULT_SOURCE, notes: [] }, 'no project key: the default entry first');
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
  assert.deepEqual(tokenVars('x', 'github.com'), { GH_TOKEN: 'x' });
  // gh reads a GitHub Enterprise Server host's token from GH_ENTERPRISE_TOKEN, and a ghe.com tenancy's from GH_TOKEN.
  assert.deepEqual(tokenVars('x', 'ghe.example.com'), { GH_ENTERPRISE_TOKEN: 'x' });
  assert.deepEqual(tokenVars('x', 'acme.ghe.com'), { GH_TOKEN: 'x' });
});

test('the local file\'s projectRun.forgeTokenKeychain is checked, and read only from the main checkout\'s untracked file', (t) => {
  const errors = [];
  assert.equal(localForgeTokenKeychain({}, errors), null);
  assert.deepEqual(localForgeTokenKeychain({ projectRun: { forgeTokenKeychain: ENTRY } }, errors), ENTRY);
  assert.deepEqual(errors, []);
  for (const bad of [
    { projectRun: true }, { projectRun: { forgeTokenKeychain: { service: 'x' } } }, { projectRun: { forgeTokenKeychain: 'x' } },
    { projectRun: { forgeTokenKeychain: { service: ' ', account: 'a' } } },
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

test('the local file\'s projectRun and its keychain entry warn on a field a newer release adds, and keep the entry', (t) => {
  const found = [];
  const raw = { projectRun: { forgeTokenKeychain: { ...ENTRY, label: 'work' }, retries: 2 } };
  assert.deepEqual(localForgeTokenKeychain(raw, found, '.aidrian.local.json'), ENTRY);
  assert.deepEqual(found, ['.aidrian.local.json: unknown key "projectRun.retries"', '.aidrian.local.json: unknown key "projectRun.forgeTokenKeychain.label"']);
  const fx = runFixture(t, { init: false, local: raw });
  const project = findProject(fx.dir);
  assert.deepEqual([project.localForgeTokenKeychain, project.errors, project.warnings], [ENTRY, [], found]);
  // A bad value of a field the entry reads stays an error, beside the warning.
  const bad = [];
  assert.equal(localForgeTokenKeychain({ projectRun: { forgeTokenKeychain: { service: '', account: 'me', label: 'work' } } }, bad, '.aidrian.local.json'), null);
  assert.equal(bad.length, 2);
  assert.match(bad[1], /"projectRun" must be \{ "forgeTokenKeychain"/u);
});

// The claim the start gave the session it launched, from the inline settings of its `claude --bg`.
const claimOf = (fx) => {
  const [{ args }] = fx.claude.starts();
  return JSON.parse(args[args.indexOf('--settings') + 1]).env?.[CLAIM_VAR];
};

test('a Claude Code start with no forge token to hand its session halts, recording nothing; with one it starts, and the token is in no argv or file of the start', (t) => {
  assert.equal(claudeCode.capabilities.projectStart.forgeTokenEnv, true);
  const fx = runFixture(t);
  const none = { ...fx.forge, authToken: () => { throw new Error('no oauth token found for github.com'); } };
  const halted = fx.cmd(['start', 'launch', 'ENG-1'], { forge: none });
  assert.equal(halted.exitCode, 1, halted.out.join('\n'));
  assert.equal(halted.out[0], 'halt no source gives a forge token for github.com, of the forge CLI\'s login (the login: no oauth token found for github.com), and an issue session reaches the forge only with one; sign the forge CLI in with `gh auth login --hostname github.com --git-protocol https`');
  assert.deepEqual(fx.claude.starts(), [], 'no claude --bg');
  assert.deepEqual(fx.rows().filter((row) => row.event === 'start'), [], 'nothing recorded');
  const started = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(started.exitCode, 0, started.out.join('\n'));
  assert.ok(fx.forge.calls.some(([name, options]) => name === 'authToken' && options.host === 'github.com'), 'the start asked for the token');
  assert.ok(!JSON.stringify(fx.claude.calls).includes(FIXTURE_TOKEN), 'no argv of the start holds the token');
  const attempt = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1');
  for (const name of readdirSync(attempt).filter((each) => statSync(path.join(attempt, each)).isFile())) {
    assert.ok(!readFileSync(path.join(attempt, name), 'utf8').includes(FIXTURE_TOKEN), `nor the attempt's ${name}`);
  }
  assert.ok(!JSON.stringify(fx.rows()).includes(FIXTURE_TOKEN), 'nor the ledger');
  // The claim the session got in its settings, of which the attempt keeps only the digest, with the source the start checked.
  const claim = claimOf(fx);
  assert.match(claim, /^[0-9a-f]{48}$/u);
  const kept = JSON.parse(readFileSync(path.join(attempt, 'token-claim.json'), 'utf8'));
  const sha = (value) => createHash('sha256').update(value).digest('hex');
  assert.deepEqual(kept, { claim: sha(claim), source: 'login', token: sha(FIXTURE_TOKEN) });
  assert.equal(statSync(path.join(attempt, 'token-claim.json')).mode & 0o777, 0o600);
});

test('a start whose token may not push halts, though the driver\'s own login may push: the forge\'s push probe runs with that token', (t) => {
  const fx = runFixture(t);
  // A token with read-only Contents on a repository the driver may write: the probe's answer is the forge's 403.
  fx.forge.tokenPush = (token) => token !== FIXTURE_TOKEN;
  const halted = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(halted.exitCode, 1, halted.out.join('\n'));
  assert.equal(halted.out[0], 'halt the forge token from the forge CLI\'s login for github.com may not push to github.com/acme/widgets, as the forge\'s push probe with it answers (the forge answered 403); give that source a token that may write the repository\'s contents');
  assert.deepEqual(fx.claude.starts(), [], 'no claude --bg');
  assert.ok(fx.forge.calls.some(([name, repo, options]) => name === 'tokenCanPush' && repo === 'acme/widgets' && options.host === 'github.com' && options.token === 'given'));
  // A probe the forge answers with neither: the start says so, and starts nothing.
  const other = runFixture(t);
  other.forge.tokenPush = () => { throw new Error('the forge answered the push probe with 500'); };
  assert.equal(other.cmd(['start', 'launch', 'ENG-1']).out[0], 'halt whether the forge token from the forge CLI\'s login for github.com may push to github.com/acme/widgets cannot be told (the forge answered the push probe with 500); start again');
});

test('the push probe asks GitHub for the receive-pack advertisement, with the token in the environment under the host\'s variable, never an argument', () => {
  const calls = [];
  const exec = (program, args, options) => (calls.push({ program, args, options }), '403 text/plain; charset=utf-8');
  assert.deepEqual(receivePackStatus('acme/widgets', { host: 'github.com', token: 'github_pat_RO0123456789', exec }), { status: 403, type: 'text/plain; charset=utf-8' });
  receivePackStatus('acme/widgets', { host: 'ghe.example.com', token: 'ghe_token0123456789', exec });
  assert.equal(calls[0].program, process.execPath);
  assert.deepEqual(calls[0].args.slice(2), ['https://github.com/acme/widgets.git/info/refs?service=git-receive-pack', 'GH_TOKEN']);
  assert.equal(calls[0].options.env.GH_TOKEN, 'github_pat_RO0123456789');
  assert.deepEqual(calls[1].args.slice(2), ['https://ghe.example.com/acme/widgets.git/info/refs?service=git-receive-pack', 'GH_ENTERPRISE_TOKEN']);
  assert.equal(calls[1].options.env.GH_ENTERPRISE_TOKEN, 'ghe_token0123456789');
  assert.ok(calls.every((call) => !call.args.join(' ').includes('token0123456789') && !call.args.join(' ').includes('RO0123456789')), 'never an argument');
  assert.equal(calls[0].options.shell, undefined, 'no shell');
  // Only a 200 that is a receive-pack advertisement may push; a 200 of HTML, as a login page, may not.
  const may = (status, type) => tokenMayPush('acme/widgets', { host: 'github.com', token: 't', probe: () => ({ status, type }) });
  assert.deepEqual(may(200, 'application/x-git-receive-pack-advertisement'), { may: true, why: null });
  assert.deepEqual(may(200, 'text/html; charset=utf-8'), { may: false, why: 'the forge answered 200 with text/html, not a push advertisement' });
  assert.deepEqual([401, 403, 404].map((status) => may(status, 'text/plain')), [401, 403, 404].map((status) => ({ may: false, why: `the forge answered ${status}` })));
  assert.throws(() => may(500, 'text/plain'), /the forge answered the push probe with 500/u);
});

test('the machine\'s default keychain entry is read for github.com alone: an Enterprise run takes the project entry or its own login', () => {
  const both = { 'aidrian-forge': KEYCHAIN_TOKEN, 'aidrian-project-run': 'github_pat_DEFAULT0123456789' };
  const enterprise = { host: 'ghe.example.com', owner: 'acme', name: 'widgets' };
  const project = entries(both);
  assert.deepEqual(forgeToken({ forge: login(), repository: enterprise, keychain: ENTRY, platform: 'darwin', exec: project.exec }).id, 'project');
  const machineOnly = entries({ 'aidrian-project-run': 'github_pat_DEFAULT0123456789' });
  const forge = login('ghe_LOGIN0123456789');
  const read = forgeToken({ forge, repository: enterprise, platform: 'darwin', exec: machineOnly.exec });
  assert.deepEqual([read.token, read.id], ['ghe_LOGIN0123456789', 'login'], 'the Enterprise host\'s own login, never the machine entry');
  // With no token at all, the recovery names only the sources the run can use: no machine entry off github.com.
  const none = forgeToken({ forge: login(''), repository: enterprise, platform: 'darwin', exec: entries({}).exec });
  assert.match(none.problem, /; sign the forge CLI in with `gh auth login --hostname ghe\.example\.com --git-protocol https`, or name one in projectRun\.forgeTokenKeychain of \.aidrian\.local\.json$/u);
  assert.doesNotMatch(none.problem, /aidrian-project-run/u);
  assert.deepEqual(machineOnly.read, [], 'the machine entry is not even read');
  assert.deepEqual(forge.calls, [{ host: 'ghe.example.com' }]);
  // The same machine, on github.com, takes the machine entry.
  assert.equal(forgeToken({ forge: login(), repository: REPOSITORY, platform: 'darwin', exec: entries(both).exec }).id, 'machine');
  assert.equal(forgeToken({ forge: login(), repository: enterprise, platform: 'darwin', only: 'machine', exec: entries(both).exec }).problem, 'the source the start checked, machine, is not one this machine reads now');
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

// What the read probe prints for one answer of GitHub (github-token.mjs apiStatus), with `more` over a 200 that parsed.
const probed = (more = {}) => ({ status: 200, parsed: true, number: null, branch: null, rollup: true, errors: [], array: true, keys: ['state', 'workflow_runs'], remaining: '4000', retry: null, ...more });

// The GitHub adapter's reads with a fine-grained token that may push but holds no Issues permission, as the live run's
// token: GitHub answers the reactions read 403, "Resource not accessible by personal access token".
const noIssues = (asked = []) => (repo, { host, token }) => tokenReadProblems(repo, {
  host, token, probe: (route, options) => {
    asked.push([route, options.token]);
    if (route === `repos/${repo}`) return probed({ branch: 'main' });
    if (route.includes('/pulls')) return probed({ number: 12 });
    return route.includes('/reactions') ? probed({ status: 403 }) : probed();
  },
});

test('preflight blocks on a token whose reactions read the forge answers 403, naming the fine-grained permission, and the start halts on it', (t) => {
  const fx = runFixture(t);
  const asked = [];
  fx.forge.tokenReads = noIssues(asked);
  const pre = fx.cmd(['preflight', 'launch']);
  assert.equal(pre.exitCode, 1);
  assert.ok(pre.out.includes('ok access'), 'the push passed');
  assert.deepEqual(pre.out.filter((line) => line.startsWith('blocker token-reads:')), [
    `blocker token-reads: the forge token from the forge CLI's login for github.com cannot read the reactions on a pull request, as \`aidrian pr review --with-bot\` does (the forge answered 403 for github.com/acme/widgets); give it the fine-grained permission Issues: Read-only (setup: ${setupDocUrl()}#forge-token-permissions)`,
  ], pre.out.join('\n'));
  assert.ok(asked.every(([, token]) => token === FIXTURE_TOKEN), 'every read is the issue session\'s token');
  assert.ok(asked.some(([route]) => route === 'repos/acme/widgets/issues/12/reactions?per_page=1'), 'on the newest pull request');
  assert.ok(asked.some(([route]) => route === 'graphql'), 'and the check rollup gh pr checks reads');
  const halted = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.equal(halted.exitCode, 1, halted.out.join('\n'));
  assert.match(halted.out[0], /^halt the forge token from the forge CLI's login for github\.com cannot read the reactions on a pull request/u);
  assert.deepEqual(fx.claude.starts(), [], 'no session started');
  // A read the forge could not answer says nothing of the token: one retry line, no permission, and a start that may
  // pass when tried again.
  fx.forge.tokenReads = () => ({ missing: [], unverified: [], unanswered: ['pulls', 'actions'] });
  const limited = fx.cmd(['preflight', 'launch']);
  assert.deepEqual(limited.out.filter((line) => line.includes('token-reads')), ['retry token-reads: the forge could not answer the pulls, actions reads of github.com/acme/widgets with the forge token from the forge CLI\'s login for github.com; start again'], limited.out.join('\n'));
  assert.equal(limited.exitCode, 1);
  const later = fx.cmd(['start', 'launch', 'ENG-1']);
  assert.deepEqual([later.exitCode, later.out.find((line) => line.startsWith('retry: '))?.slice(0, 48)], [75, 'retry: the forge could not answer the pulls, act']);
  // A forge adapter that throws is the same: no answer.
  fx.forge.tokenReads = () => { throw new Error('socket hang up'); };
  assert.deepEqual(fx.cmd(['preflight', 'launch']).out.filter((line) => line.includes('token-reads')), ['retry token-reads: the forge could not answer the token read of github.com/acme/widgets with the forge token from the forge CLI\'s login for github.com; start again']);
});

test('the read probe asks the REST API or GraphQL with the token in the environment, and passes back only the fields a read needs', () => {
  const calls = [];
  const line = JSON.stringify(probed({ status: 403, parsed: true }));
  const exec = (program, args, options) => (calls.push({ program, args, options }), line);
  assert.deepEqual(apiStatus('repos/acme/widgets/issues/12/reactions', { host: 'github.com', token: 'github_pat_RO0123456789', exec }), JSON.parse(line));
  apiStatus('repos/acme/widgets', { host: 'ghe.example.com', token: 'ghe_token0123456789', exec });
  apiStatus('graphql', { host: 'ghe.example.com', token: 'ghe_token0123456789', query: '{"query":"{viewer{login}}"}', exec });
  assert.deepEqual(calls[0].args.slice(2), ['https://api.github.com/repos/acme/widgets/issues/12/reactions', 'GH_TOKEN']);
  assert.equal(calls[0].options.env.GH_TOKEN, 'github_pat_RO0123456789');
  assert.deepEqual(calls[1].args.slice(2), ['https://ghe.example.com/api/v3/repos/acme/widgets', 'GH_ENTERPRISE_TOKEN']);
  assert.deepEqual(calls[2].args.slice(2), ['https://ghe.example.com/api/graphql', 'GH_ENTERPRISE_TOKEN', '{"query":"{viewer{login}}"}']);
  assert.ok(calls.every((call) => !call.args.join(' ').includes('0123456789')), 'never an argument');
  assert.throws(() => apiStatus('repos/acme/widgets', { host: 'github.com', token: 't', exec: () => '200\n[{"number":' }), /JSON/u, 'a cut answer is no answer');
  assert.deepEqual(Object.values(TOKEN_READS).map((each) => each.permission), ['Metadata: Read-only, with the repository selected under Repository access', 'Pull requests: Read and write', 'Issues: Read-only', 'Commit statuses: Read-only', 'Actions: Read and write', 'Commit statuses: Read-only and Actions: Read and write']);
});

test('the token reads: refusals name their permission, the check rollup with no pull request is not verified, and an answer that says neither is unanswered', () => {
  const reads = (answer) => tokenReadProblems('acme/widgets', { host: 'github.com', token: 't', probe: (route, options) => answer(route, options) ?? probed(route.endsWith('widgets') ? { branch: 'main' } : {}) });
  assert.deepEqual(reads(() => probed({ status: 404 })).missing.map((each) => each.read), ['repository'], 'a token that cannot read the repository is one problem');
  const statuses = reads((route) => (/status$|runs/u.test(route) ? probed({ status: 403 }) : null));
  assert.deepEqual([statuses.missing.map((each) => each.read), statuses.unverified.map((each) => each.read)], [['statuses', 'actions'], ['rollup']], 'no pull request: the rollup is not verified');
  const rollup = (answer) => reads((route, options) => (route.includes('/pulls') ? probed({ number: 7 }) : options.query ? probed(answer) : null));
  assert.deepEqual(rollup({ rollup: false, errors: ['FORBIDDEN'] }).missing.map((each) => [each.read, each.permission, each.why]), [['rollup', 'Commit statuses: Read-only and Actions: Read and write', 'the forge answered 200 FORBIDDEN']]);
  const empty = rollup({ rollup: true });
  assert.deepEqual([empty.missing, empty.unanswered], [[], []], 'an empty rollup passes');
  for (const answer of [{ rollup: false, errors: ['NOT_FOUND'] }, { rollup: true, errors: ['INTERNAL'] }, { rollup: false, errors: ['RATE_LIMITED'] }, { rollup: false }]) {
    assert.deepEqual([rollup(answer).missing, rollup(answer).unanswered], [[], ['rollup']], JSON.stringify(answer));
  }
  assert.deepEqual(reads(() => probed({ status: 500 })).unanswered, ['repository', 'pulls', 'reactions', 'statuses', 'actions']);
  // A 200 of another shape than its route answers is no answer: a repository with no default branch, a pull list that is
  // no list, and workflow runs without their list.
  const shapes = reads((route) => (route === 'repos/acme/widgets/pulls?state=all&per_page=1' ? probed({ array: false, keys: ['message'] }) : route.includes('/runs') ? probed({ keys: [] }) : null));
  assert.deepEqual([shapes.missing, shapes.unanswered], [[], ['pulls', 'actions']]);
  assert.deepEqual(reads((route) => (route === 'repos/acme/widgets' ? probed({ array: false, keys: [] }) : null)).unanswered, ['repository', 'statuses'], 'a repository answer of {}');
  assert.deepEqual(reads((route) => (route === 'repos/acme/widgets' ? probed({ branch: '' }) : null)).unanswered, ['repository', 'statuses'], 'an empty default branch');
  // The reads that need only the repository's name are asked when its own read gets no answer.
  const mixed = reads((route) => (route === 'repos/acme/widgets' ? probed({ status: 500 }) : route.includes('/runs') ? probed({ status: 403 }) : null));
  assert.deepEqual([mixed.missing.map((each) => each.read), mixed.unanswered], [['actions'], ['repository', 'statuses']], 'the Actions refusal beside an unanswered repository read');
  assert.deepEqual(reads((route) => (route.includes('/pulls') ? probed({ parsed: false }) : null)).unanswered, ['pulls'], 'an unparseable 200 is no pass');
});

test('a read the forge could not answer names no permission, and a refusal beside it, or before a probe that throws, is still reported', () => {
  const reads = (pulls, issues = null) => tokenReadProblems('acme/widgets', { host: 'github.com', token: 't', probe: (route) => {
    if (route.includes('/pulls')) return pulls();
    if (issues && route.includes('/issues')) return issues();
    if (route.includes('/status')) throw new Error('timed out');
    return probed(route.endsWith('widgets') ? { branch: 'main' } : {});
  } });
  for (const limited of [{ status: 403, remaining: '0' }, { status: 403, retry: '30' }, { status: 429 }, { status: 502 }]) {
    const answer = reads(() => probed(limited));
    assert.deepEqual([answer.missing, answer.unanswered], [[], ['pulls', 'statuses']], JSON.stringify(limited));
  }
  assert.deepEqual(reads(() => probed({ status: 403 })).missing.map((each) => each.read), ['pulls'], 'a 403 with requests left is a refusal');
  const both = reads(() => probed({ number: 7 }), () => probed({ status: 403 }));
  assert.deepEqual([both.missing.map((each) => each.read), both.unanswered], [['reactions'], ['statuses']], 'the reactions refusal survives the statuses probe that threw');
});

test('the SessionStart hook hands GH_TOKEN, from the source the start checked, to the sandboxed commands of the session the start launched alone', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  // The forge CLI the hook finds on PATH, which answers its login's token, as gh does from the keyring.
  const hookToken = FIXTURE_TOKEN;
  writeFileSync(path.join(fx.bin, 'gh'), `#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && { echo ${hookToken}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const hook = (session, cwd, file, more = {}) => spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...fx.env, CLAUDE_ENV_FILE: file, CLAUDE_CODE_SESSION_ID: session, ...more }, encoding: 'utf8',
  });
  // Where the host keeps each SessionStart's file: the session's own folder of its session-env tree.
  const envFile = (name) => path.join(fx.env.CLAUDE_CONFIG_DIR, 'session-env', STARTED[0].session, `sessionstart-hook-${name}.sh`);
  const text = (file) => {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return '';
    }
  };
  // The host's file, made world-readable before the hook runs, as most of that folder is: the hook makes it owner-only.
  const file = envFile('own');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '', { mode: 0o644 });
  chmodSync(file, 0o644);
  const ran = hook(STARTED[0].session, work, file, { [CLAIM_VAR]: claim });
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(!`${ran.stdout}${ran.stderr}`.includes(hookToken), 'the hook prints no token');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const seen = spawnSync('/bin/sh', ['-c', `. '${file}'; printf '%s' "$GH_TOKEN"`], { encoding: 'utf8' });
  assert.equal(seen.stdout, hookToken);
  // The file the token went to is recorded beside the claim, for the driver to remove once the session ended.
  assert.deepEqual(tokenFiles(path.dirname(work)), { session: STARTED[0].session, files: [file] });
  // The attempt's marker comes last, after the token and the record of its handoff, so a shell that sees the marker,
  // which the sandbox proof waits for, sees that record too.
  const lines = text(file).trim().split('\n');
  assert.match(lines.at(-1), /^export AIDRIAN_ATTEMPT_ENV='launch\/ENG-1\.1\/[0-9a-f]{16}'$/u);
  assert.equal(lines.filter((line) => line.startsWith('export AIDRIAN_ATTEMPT_ENV=')).length, 1, 'once');
  assert.ok(lines.findIndex((line) => line.startsWith('export GH_TOKEN=')) < lines.length - 1, 'after the token');
  assert.ok(statSync(path.join(path.dirname(work), 'token-handoff.json')).mtimeMs <= statSync(file).mtimeMs, 'after the handoff record');
  // And git's command-scope config: every helper of the user's and the repository's config dropped, then gh's own.
  const git = spawnSync('/bin/sh', ['-c', `. '${file}'; printf '%s|' "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" "$GIT_CONFIG_KEY_1" "$GIT_CONFIG_VALUE_1"`], { encoding: 'utf8' });
  assert.equal(git.stdout, `2|credential.https://github.com.helper||credential.https://github.com.helper|!'${path.join(fx.bin, 'gh')}' auth git-credential|`);
  // The hook recorded the handoff for the start's proof check, with nothing secret.
  const attempt = path.dirname(work);
  rmSync(path.join(attempt, 'token-handoff.json'), { force: true });
  mkdirSync(path.dirname(envFile('again')), { recursive: true });
  assert.equal(hook(STARTED[0].session, work, envFile('again'), { [CLAIM_VAR]: claim }).status, 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(attempt, 'token-handoff.json'), 'utf8')), { handed: true });
  assert.deepEqual(tokenFiles(attempt).files, [file, envFile('again')], 'each SessionStart\'s file');
  // A record that cannot be written hands no token over: it would outlive the session.
  rmSync(path.join(attempt, TOKEN_FILES));
  mkdirSync(path.join(attempt, TOKEN_FILES));
  const unkept = envFile('unkept');
  mkdirSync(path.dirname(unkept), { recursive: true });
  const refused = hook(STARTED[0].session, work, unkept, { [CLAIM_VAR]: claim });
  assert.doesNotMatch(text(unkept), /GH_TOKEN/u);
  assert.match(refused.stdout, /Forge token: not handed to this session: the host's session environment file could not be recorded for removal once the session ends/u);
  assert.equal(readFileSync(path.join(attempt, 'token-handoff.json'), 'utf8').includes('"handed":false'), true, 'and records why');
  rmSync(path.join(attempt, TOKEN_FILES), { recursive: true });
  // Nor does a file outside the session's own folder, which the driver could not remove once the session ended.
  const astray = path.join(fx.root, 'session-env', 'astray.sh');
  mkdirSync(path.dirname(astray), { recursive: true });
  const outside = hook(STARTED[0].session, work, astray, { [CLAIM_VAR]: claim });
  assert.doesNotMatch(text(astray), /GH_TOKEN/u);
  assert.match(outside.stdout, /could not be recorded for removal once the session ends \(the host named no session environment file it can remove once the session ends\)/u);
  assert.equal(hook(STARTED[0].session, work, envFile('again'), { [CLAIM_VAR]: claim }).status, 0);
  // The same session without the claim, as one another person opened, gets no token, is told why, and leaves the
  // record of the successful handoff as it was.
  const bare = envFile('bare');
  mkdirSync(path.dirname(bare), { recursive: true });
  const unclaimed = hook(STARTED[0].session, work, bare);
  assert.doesNotMatch(text(bare), /GH_TOKEN|GIT_CONFIG|AIDRIAN_ATTEMPT_ENV/u, 'no token, and no marker without the claim');
  assert.match(text(bare), /^export npm_config_cache='/mu, 'the cache variables still');
  assert.match(unclaimed.stdout, /Forge token: not handed to this session: this session does not hold the claim the start gave the session it launched/u);
  assert.deepEqual(JSON.parse(readFileSync(path.join(path.dirname(work), 'token-handoff.json'), 'utf8')), { handed: true }, 'a stranger overwrites no verdict');
  // Another session in that clone, and the session elsewhere, get none either, even with the claim.
  for (const [session, cwd] of [['abcd1234-0000-4000-8000-00000000ff01', work], [STARTED[0].session, fx.dir]]) {
    const other = envFile(`${session}-${path.basename(cwd)}`);
    assert.equal(hook(session, cwd, other, { [CLAIM_VAR]: claim }).status, 0);
    assert.doesNotMatch(text(other), /GH_TOKEN/u, `${session} in ${cwd}`);
  }
  // In process: the read gets the main checkout, its pinned repository, its keychain setting, and the one source the
  // start checked; a failed read of that source hands nothing over and says why, with no other source tried.
  let asked = null;
  const claimed = { ...fx.env, [CLAIM_VAR]: claim };
  const vars = confinedTokenVars({ session: STARTED[0].session, cwd: work, env: claimed, token: (given) => ((asked = given), { token: FIXTURE_TOKEN, source: 'the forge CLI\'s login for github.com' }) });
  assert.equal(vars.folder, attempt);
  assert.equal(vars.vars.GH_TOKEN, FIXTURE_TOKEN);
  assert.deepEqual(Object.keys(vars.vars).filter((name) => name.startsWith('GIT_CONFIG')).sort(), ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_KEY_1', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_VALUE_1']);
  assert.deepEqual([asked.root, asked.repository, asked.keychain, asked.env, asked.only], [findProject(fx.dir).root, { host: 'github.com', owner: 'acme', name: 'widgets' }, null, claimed, 'login']);
  assert.deepEqual(confinedTokenVars({ session: STARTED[0].session, cwd: work, env: claimed, token: () => ({ problem: 'the login: gone' }) }), { problem: 'the login: gone', folder: attempt });
  // The same source now giving another token, as after a new login: a failed handoff, never the new token.
  assert.deepEqual(confinedTokenVars({ session: STARTED[0].session, cwd: work, env: claimed, token: () => ({ token: 'github_pat_OTHER0123456789', source: 'the forge CLI\'s login for github.com' }) }), { problem: 'the forge CLI\'s login for github.com now gives another token than the one the start checked', folder: attempt });
  assert.equal(confinedTokenVars({ session: STARTED[0].session, cwd: fx.dir, env: claimed }), null, 'no confined attempt, no answer');
});

test('in the launch window, while the host has not named the session, only the session holding the start\'s claim gets the token', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  // A pending mark for the next launch in that clone, which holds every session the host had not listed before it.
  assert.ok(markPending(DRIVER, { cwd: work, root: fx.dir, known: [DRIVER], env: fx.env }));
  const stranger = 'abcd1234-0000-4000-8000-00000000fe01';
  const token = () => ({ token: FIXTURE_TOKEN, source: 'the login' });
  const folder = path.dirname(work);
  assert.deepEqual(confinedTokenVars({ session: stranger, cwd: work, env: fx.env, token }), { problem: 'this session does not hold the claim the start gave the session it launched, so it is not that session', folder: null });
  assert.deepEqual(confinedTokenVars({ session: stranger, cwd: work, env: { ...fx.env, [CLAIM_VAR]: 'f'.repeat(48) }, token }).problem, 'this session does not hold the claim the start gave the session it launched, so it is not that session', 'a wrong claim');
  assert.equal(confinedTokenVars({ session: stranger, cwd: work, env: { ...fx.env, [CLAIM_VAR]: claim }, token }).vars.GH_TOKEN, FIXTURE_TOKEN, 'the launched session, before the host names it');
});

test('a pending mark whose folder is missing never matches a call in an attempt whose clone is missing too', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  const token = () => ({ token: FIXTURE_TOKEN, source: 'the login' });
  const stranger = 'abcd1234-0000-4000-8000-00000000fd01';
  const env = { ...fx.env, [CLAIM_VAR]: claim };
  // The pending mark of another launch, whose clone is not there, and this attempt's clone, gone too: neither resolves.
  assert.ok(markPending(DRIVER, { cwd: path.join(fx.dir, 'gone', 'work'), root: fx.dir, known: [DRIVER], env: fx.env }));
  assert.ok(statSync(path.join(path.dirname(work), 'shell-env.json')).isFile(), 'the attempt holds the shell environment');
  rmSync(work, { recursive: true, force: true });
  assert.equal(confinedTokenVars({ session: stranger, cwd: work, env, token }), null);
  assert.equal(confinedShellVars({ session: stranger, cwd: work, env }), null);
});

test('a call whose folder is missing, or beside the clone in its attempt`s folder, gets neither the shell environment nor the token', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  const token = () => ({ token: FIXTURE_TOKEN, source: 'the login' });
  const env = { ...fx.env, [CLAIM_VAR]: claim };
  const pending = 'abcd1234-0000-4000-8000-00000000fc01';
  assert.ok(markPending(DRIVER, { cwd: work, root: fx.dir, known: [DRIVER], env: fx.env }));
  // The session the run recorded, and one the pending mark starts in the clone: each gets both in its clone.
  for (const session of [STARTED[0].session, pending]) {
    assert.equal(confinedTokenVars({ session, cwd: work, env, token }).vars.GH_TOKEN, FIXTURE_TOKEN, session);
    assert.ok(confinedShellVars({ session, cwd: work, env }), session);
    for (const cwd of [path.join(work, 'missing'), path.join(path.dirname(work), 'drop'), path.join(path.dirname(work), 'missing')]) {
      assert.equal(confinedTokenVars({ session, cwd, env, token }), null, `${session} ${cwd}`);
      assert.equal(confinedShellVars({ session, cwd, env }), null, `${session} ${cwd}`);
    }
  }
});

test('the hook reads only the source the start checked: a project entry that fails then gives no token, with no fall back', () => {
  const forge = login();
  const failed = forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: keychain(exit(44)).exec, only: 'project' });
  assert.equal(failed.token, undefined);
  assert.equal(failed.problem, `${PROJECT_SOURCE}, the source the start checked, gives no token now (it is not there)`);
  assert.deepEqual(forge.calls, [], 'the forge CLI\'s login is not asked');
  const machine = forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'darwin', exec: entries({ 'aidrian-forge': KEYCHAIN_TOKEN, 'aidrian-project-run': 'github_pat_DEFAULT0123456789' }).exec, only: 'machine' });
  assert.deepEqual([machine.token, machine.id], ['github_pat_DEFAULT0123456789', 'machine'], 'the machine entry, though the project entry is there');
  assert.equal(forgeToken({ forge, repository: REPOSITORY, keychain: ENTRY, platform: 'linux', only: 'project' }).problem, 'the source the start checked, project, is not one this machine reads now');
  assert.equal(forgeToken({ forge: login(), repository: REPOSITORY, platform: 'linux' }).id, 'login');
});

test('the session environment file is made owner-only before anything is written, and Claude Code\'s session-env tree is hidden from the sandbox', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-envfile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'env.sh');
  writeFileSync(file, 'export A=1\n', { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.equal(writeEnvFile(file, { GH_TOKEN: 'github_pat_X0123456789' }), true);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const settings = sandboxSettings({ work: path.join(root, 'w'), git: path.join(root, 'g'), grants: [], domains: [], temp: [], home: root, platform: 'darwin' });
  const tree = path.join(root, '.claude', 'session-env');
  assert.ok(settings.sandbox.filesystem.denyRead.includes(tree), 'no sandboxed command reads another session\'s file');
  assert.ok(settings.permissions.deny.includes(`Read(/${tree}/**)`), 'nor the Read tool');
  assert.ok(confineReads({ env: {}, home: root }).includes(tree), 'and the sandbox proof tries to read it');
});


test('a hook that cannot write the token`s handoff record hands no marker, so the proof keeps waiting', { skip: process.getuid?.() === 0 }, (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  const folder = path.dirname(work);
  writeFileSync(path.join(fx.bin, 'gh'), `#!/bin/sh\n[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && { echo ${FIXTURE_TOKEN}; exit 0; }\nexit 1\n`, { mode: 0o755 });
  const file = path.join(fx.root, 'session-env', 'unrecorded', 'sessionstart-hook-0.sh');
  mkdirSync(path.dirname(file), { recursive: true });
  // The attempt's folder takes no new file, so the handoff's record cannot be written; the fake host wrote one at its
  // launch, which goes first.
  rmSync(path.join(folder, 'token-handoff.json'), { force: true });
  chmodSync(folder, 0o500);
  let ran;
  try {
    ran = spawnSync(process.execPath, [SESSION_START], {
      input: JSON.stringify({ session_id: STARTED[0].session, cwd: work, hook_event_name: 'SessionStart', source: 'startup' }),
      env: { ...fx.env, CLAUDE_ENV_FILE: file, CLAUDE_CODE_SESSION_ID: STARTED[0].session, [CLAIM_VAR]: claim }, encoding: 'utf8',
    });
  } finally {
    chmodSync(folder, 0o700);
  }
  assert.equal(ran.status, 0, ran.stderr);
  assert.throws(() => readFileSync(path.join(folder, 'token-handoff.json')), /ENOENT/u, 'no record');
  const handed = readFileSync(file, 'utf8');
  assert.match(handed, /^export npm_config_cache='/mu, 'the cache variables');
  assert.doesNotMatch(handed, /AIDRIAN_ATTEMPT_ENV/u, 'no marker');
});

test('a credential that disappears after the access check fails the start: the hook records no handoff, and the proof check reads that', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const claim = claimOf(fx);
  const work = path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
  const folder = path.dirname(work);
  // The forge CLI's login is gone by the time the session starts: gh gives no token.
  writeFileSync(path.join(fx.bin, 'gh'), '#!/bin/sh\necho "no oauth token found for github.com" >&2\nexit 1\n', { mode: 0o755 });
  const file = path.join(fx.root, 'session-env', 'gone', 'sessionstart-hook-0.sh');
  mkdirSync(path.dirname(file), { recursive: true });
  const ran = spawnSync(process.execPath, [SESSION_START], {
    input: JSON.stringify({ session_id: STARTED[0].session, cwd: work, hook_event_name: 'SessionStart', source: 'startup' }),
    env: { ...fx.env, CLAUDE_ENV_FILE: file, CLAUDE_CODE_SESSION_ID: STARTED[0].session, [CLAIM_VAR]: claim }, encoding: 'utf8',
  });
  assert.equal(ran.status, 0, ran.stderr);
  const record = JSON.parse(readFileSync(path.join(folder, 'token-handoff.json'), 'utf8'));
  assert.equal(record.handed, false);
  // The record says not handed, and it was written: the marker still follows, last, so the proof runs and fails on it.
  assert.match(readFileSync(file, 'utf8').trim().split('\n').at(-1), /^export AIDRIAN_ATTEMPT_ENV='launch\/ENG-1\.1\/[0-9a-f]{16}'$/u);
  assert.match(record.why, /^the forge CLI's login for github\.com, the source the start checked, gives no token now \(/u);
  assert.match(handoffProblem(folder), /^the forge token was not handed to the session: the forge CLI's login for github\.com, the source the start checked, gives no token now/u);
  // The proof check fails on it, before it reads anything else of the proof.
  const checked = confineCheck({ folder, session: STARTED[0].session, isAlive: () => true, sentinel: () => ({ others: 0 }) });
  assert.equal(checked.pass, false);
  assert.match(checked.problem, /^the forge token was not handed to the session/u);
  // No record at all, as a hook that never ran: the same.
  rmSync(path.join(folder, 'token-handoff.json'));
  assert.equal(confineCheck({ folder, session: STARTED[0].session, isAlive: () => true, sentinel: () => ({ others: 0 }) }).problem, 'the session\'s SessionStart hook recorded no forge token handoff, so its pushes would not sign in');
  // A start that expected no token, with no claim, is not held to one.
  rmSync(path.join(folder, 'token-claim.json'));
  assert.equal(handoffProblem(folder), null);
});

test('git takes the token through gh\'s helper alone: an empty helper resets the ones git read, appended after any command-scope entries', (t) => {
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-gitvars-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const helper = `!'${path.join(bin, 'gh')}' auth git-credential`;
  const key = 'credential.https://github.com.helper';
  assert.deepEqual(gitCredentialVars({ PATH: bin }, 'github.com'), { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: helper });
  assert.deepEqual(gitCredentialVars({ PATH: bin, GIT_CONFIG_COUNT: '1' }, 'github.com'), { GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_1: key, GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: key, GIT_CONFIG_VALUE_2: helper }, 'after the entry already there');
  assert.equal(gitCredentialVars({ PATH: bin }, 'evil.example/x'), null, 'no plain host name');
  assert.equal(gitCredentialVars({ PATH: '' }), null, 'no gh, no helper');
});
