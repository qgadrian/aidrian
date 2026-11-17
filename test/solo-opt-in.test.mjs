// A solo project: `solo: true` committed on the base branch turns on each unattended machine switch the local file
// leaves unset (config-local.mjs machineSwitch): the waiver, the judge's sign-off, and the background route, under the
// team's own key for each. It is read from the base branch only: the local ref may only refuse, and the forge decides
// (lib/solo.mjs). No test starts a session or reads a real forge: each forge is a stand-in. Temporary repositories are
// made with `git init` under mkdtemp and driven with `git -C`; no test sets GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { configFromText, DEFAULTS, loadConfig, machineSwitch } from '../plugins/aidrian/lib/config.mjs';
import { backgroundGate } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { detectHost } from '../plugins/aidrian/lib/hosts/index.mjs';
import { pathsProblem } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { runSettle } from '../plugins/aidrian/lib/review-gate.mjs';
import { POLICY_PATHS, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { settleSwitch } from '../plugins/aidrian/lib/review/approvals.mjs';
import { emptyState } from '../plugins/aidrian/lib/review/state.mjs';
import { guardWaiver, waiverGate } from '../plugins/aidrian/lib/review/waiver.mjs';
import { continuation } from '../plugins/aidrian/lib/session-length.mjs';
import { forgeSolo, prSolo, soloOf, viewSolo } from '../plugins/aidrian/lib/solo.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const URL = 'https://github.com/Acme/Notes/pull/5';
const REPO = 'acme/notes';
const T0 = '2026-11-03T14:00:00.000Z';
const LOCAL = '.aidrian.local.json';
// Every team key the three switches need, with `solo` on: what the base branch commits in a solo project.
const TEAM = { github: { unattendedWaiver: { allow: true } }, review: { unattendedSignoff: { allow: true } }, session: { handoff: { continue: 'background' } } };
const SOLO = { version: 1, solo: true, ...TEAM };
const NOT_SOLO = { version: 1, ...TEAM };
// The review config the review step reads from the base branch, which allows the judge's sign-off.
const BASE_REVIEW = configFromText(JSON.stringify(SOLO), 'config.json').review;

// A repository of its own with an origin on GitHub, whose default branch, as origin's ref holds it, commits `committed`.
// `working` is written over it in the working copy when given, `local` is this machine's file, and `tracked` adds it to git.
function repo(t, { committed = SOLO, working = null, local = null, tracked = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-solo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  const state = { state: { dir: path.join(root, 'state') } };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ ...committed, ...state }));
  git('add', '.aidrian/config.json');
  git('commit', '-q', '-m', 'config');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  if (working) writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ ...working, ...state }));
  if (local !== null) writeFileSync(path.join(dir, LOCAL), typeof local === 'string' ? local : JSON.stringify(local));
  if (tracked) git('add', '-f', LOCAL);
  return { dir, project: () => projectAt(dir), state };
}

const encode = (value) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

const notFound = () => {
  throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
};

// The forge as GitHub answers for REPO alone: `branches` maps a branch to the config.json it commits, the default branch
// is `main`, and the pull request is on `base`. `down` makes every call fail, as an unreachable forge does. Every call is
// counted.
function fakeForge(branches = { main: SOLO }, { base = 'main', down = false } = {}) {
  const calls = [];
  const fail = () => {
    throw Object.assign(new Error('gh: could not connect'), { stderr: 'error connecting to api.github.com' });
  };
  const facade = {
    change: (ref, fields) => (calls.push(['change', ref, fields]), down && fail(), { number: Number(ref), headRefOid: HEAD, baseRefName: base, url: URL }),
    repository: (name, given) => {
      calls.push(['repository', name, given?.host]);
      if (down) fail();
      if (name !== REPO) notFound();
      return { default_branch: 'main' };
    },
    contents: (name, file, ref) => {
      calls.push(['contents', name, file, ref]);
      if (down) fail();
      if (name !== REPO) notFound();
      const branch = ref.replace(/^refs\/heads\//u, '');
      if (file === '.aidrian/config.json' && Object.hasOwn(branches, branch)) return encode(branches[branch]);
      return notFound();
    },
  };
  // budgetedForge's `make`, for the merge guard's waiver, returns the same facade.
  const make = () => facade;
  return Object.assign(make, facade, { calls });
}

// The three switches as each command reads them, for `project` and the forge `forge`.
function switches(project, forge) {
  const waiver = waiverGate({ project, forge, repo: 'acme/notes', host: 'github.com', base: 'main', prefix: '' });
  const signoff = settleSwitch(BASE_REVIEW, project, () => soloOf(project, { forge, repo: 'acme/notes', host: 'github.com', base: 'main' }));
  const background = backgroundGate(project, loadConfig(project).config, process.env, { forgeSolo: (each) => forgeSolo(each, { forge }) });
  return { waiver: waiver.on, signoff: signoff.on, background: background.ok, why: { waiver: waiver.why, signoff: signoff.off, background: background.why } };
}

const ALL_ON = { waiver: true, signoff: true, background: true };
const ALL_OFF = { waiver: false, signoff: false, background: false };
const onOff = ({ waiver, signoff, background }) => ({ waiver, signoff, background });

test('solo is a top-level boolean, false by default, that only config.json sets', (t) => {
  assert.equal(DEFAULTS.solo, false);
  const errors = [];
  assert.equal(configFromText(JSON.stringify({ version: 1, solo: 'yes' }), 'config.json', errors).solo, false);
  assert.deepEqual(errors, ['config.json: "solo" must be true or false']);
  // The machine's file cannot set it: it is the team's word.
  const r = repo(t, { local: { solo: true } });
  assert.ok(r.project().errors.some((error) => error === `${LOCAL}: unknown key "solo"`));
});

test('machineSwitch: a local value wins, an unset one follows solo on an untracked file, and solo is read only then', (t) => {
  const project = repo(t).project();
  let reads = 0;
  const solo = () => ((reads += 1), true);
  assert.equal(machineSwitch('on', solo, project), 'on');
  assert.equal(machineSwitch('off', solo, project), 'off');
  assert.equal(reads, 0, 'a set switch reads no solo');
  assert.equal(machineSwitch('unset', solo, project), 'on');
  assert.equal(machineSwitch('unset', false, project), 'unset');
  assert.equal(machineSwitch('unset', () => 'true', project), 'unset', 'only true turns it on');
  const tracked = repo(t, { local: {}, tracked: true }).project();
  assert.equal(machineSwitch('unset', true, tracked), 'off', 'a tracked local file is no machine\'s own');
});

test('solo on the base branch, with no local setting, turns each of the three switches on', (t) => {
  const r = repo(t);
  const project = r.project();
  assert.deepEqual([project.localUnattendedWaiver, project.localUnattendedSignoff, project.localHandoffBackground], ['unset', 'unset', 'unset']);
  const forge = fakeForge();
  assert.deepEqual(onOff(switches(project, forge)), ALL_ON);
  // Through the merge guard: a recorded waive stands for a merge that names its head.
  const state = { ...emptyState(5, 'acme/notes'), outcome: { status: 'round_limit', head: HEAD, at: T0 }, waivers: [{ head: HEAD, kind: 'round_cap', verdict: 'waive', reason: 'nits', judge: 'judge', at: '2026-11-03T15:00:00.000Z' }] };
  assert.deepEqual(guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: fakeForge(), startedAt: Date.now() }), { allow: true, note: '', route: '' });
  // Through a pull request number, as aidrian pr settle reads it.
  assert.equal(prSolo(project, 5, { forge: fakeForge() }), true);
  // The base read on the forge is the pull request's, besides the default branch: both must commit it.
  assert.equal(prSolo(project, 5, { forge: fakeForge({ main: SOLO, release: NOT_SOLO }, { base: 'release' }) }), false);
  assert.equal(prSolo(project, 5, { forge: fakeForge({ main: SOLO, release: SOLO }, { base: 'release' }) }), true);
});

test('a local off wins over solo, and the waiver then reads nothing from the forge', (t) => {
  const r = repo(t, { local: { github: { unattendedWaiver: { enabled: false } }, unattendedSignoff: 'off', handoff: { background: 'off' } } });
  const forge = fakeForge();
  assert.deepEqual(onOff(switches(r.project(), forge)), ALL_OFF);
  assert.deepEqual(forge.calls, [], 'no forge read for a switch the machine turned off');
});

test('a tracked or broken local file wins over solo', (t) => {
  for (const [name, options] of [
    ['a tracked file that sets nothing', { local: {}, tracked: true }],
    ['a file with an unknown key', { local: { nonsense: true } }],
    ['a file that is no JSON', { local: '{ not json' }],
  ]) {
    const project = repo(t, options).project();
    assert.deepEqual(onOff(switches(project, fakeForge())), ALL_OFF, name);
  }
});

test('a working copy that alone says solo turns nothing on, even when the forge says solo and the local ref does not', (t) => {
  // The pull request's own change: the working copy says solo, the base branch does not, locally or on the forge.
  const branch = repo(t, { committed: NOT_SOLO, working: SOLO });
  assert.equal(loadConfig(branch.project()).config.solo, true, 'the working copy says it');
  assert.deepEqual(onOff(switches(branch.project(), fakeForge({ main: NOT_SOLO }))), ALL_OFF);
  // The working copy and the forge say solo, but this checkout's ref of the base branch does not: a local ref may only
  // refuse, and refuses.
  const stale = repo(t, { committed: NOT_SOLO, working: SOLO });
  const forge = fakeForge({ main: SOLO });
  assert.deepEqual(onOff(switches(stale.project(), forge)), ALL_OFF);
});

test('a local ref that says solo turns nothing on when the forge says no or cannot be read', (t) => {
  const r = repo(t);
  for (const [name, forge] of [
    ['the forge says false', fakeForge({ main: NOT_SOLO })],
    ['the forge has no config', fakeForge({})],
    ['the forge is unreachable', fakeForge(undefined, { down: true })],
    ['the base says false', fakeForge({ main: SOLO, release: NOT_SOLO }, { base: 'release' })],
  ]) {
    const project = r.project();
    const base = name === 'the base says false' ? 'release' : 'main';
    // The background route has no pull request: it reads the default branch alone.
    if (base === 'main') {
      const background = backgroundGate(project, loadConfig(project).config, process.env, { forgeSolo: (each) => forgeSolo(each, { forge }) });
      assert.equal(background.ok, false, `background: ${name}`);
      assert.match(background.why, /this machine has not turned the background route on/u);
    }
    assert.equal(waiverGate({ project, forge, repo: 'acme/notes', host: 'github.com', base, prefix: '' }).on, false, `waiver: ${name}`);
    assert.equal(settleSwitch(BASE_REVIEW, project, () => soloOf(project, { forge, repo: 'acme/notes', host: 'github.com', base })).on, false, `signoff: ${name}`);
    assert.equal(prSolo(project, 5, { forge }), false, `pr: ${name}`);
  }
  // With no forge reader at all, the background gate fails closed.
  assert.equal(backgroundGate(r.project(), loadConfig(r.project()).config).ok, false);
  // A checkout whose origin names no forge repository reads no solo.
  const local = repo(t);
  execFileSync('git', ['-C', local.dir, 'remote', 'set-url', 'origin', '/srv/git/notes']);
  assert.equal(forgeSolo(local.project(), { forge: fakeForge() }), false);
});

test('the team\'s own key for each switch is still required: solo replaces only the machine\'s word', (t) => {
  const bare = { version: 1, solo: true };
  const r = repo(t, { committed: bare });
  const project = r.project();
  const forge = fakeForge({ main: bare });
  const waiver = waiverGate({ project, forge, repo: 'acme/notes', host: 'github.com', base: 'main', prefix: '' });
  assert.deepEqual([waiver.on, waiver.reason], [false, 'team']);
  const signoff = settleSwitch(configFromText(JSON.stringify(bare), 'x').review, project, () => soloOf(project, { forge, repo: 'acme/notes', host: 'github.com', base: 'main' }));
  assert.deepEqual(signoff, { on: false, off: 'the team does not allow it: review.unattendedSignoff.allow is not true on the base branch' });
  const background = backgroundGate(project, loadConfig(project).config, process.env, { forgeSolo: (each) => forgeSolo(each, { forge }) });
  assert.match(background.why, /does not resolve session\.handoff\.continue to "background"/u);
});

test('the session-length hook words a handoff by the base branch\'s local ref, and reads no forge', async (t) => {
  const host = detectHost({ env: { CLAUDECODE: '1' } });
  const solo = repo(t).project();
  assert.equal((await continuation({ continue: 'background' }, host, solo, loadConfig(solo).config)).route, 'background');
  const plain = repo(t, { committed: NOT_SOLO }).project();
  assert.equal((await continuation({ continue: 'background' }, host, plain, loadConfig(plain).config)).route, 'clear');
});

test('a pull request that adds solo changes a policy file, which auto-merge never lets through', () => {
  assert.ok(POLICY_PATHS.test('.aidrian/config.json'));
  const pr = { files: [{ path: '.aidrian/config.json', changeType: 'MODIFIED' }], changedFiles: 1 };
  assert.match(pathsProblem(pr, '', { includeGuardedPaths: true }), /a policy file of aidrian, which includeGuardedPaths never lets through/u);
  assert.match(pathsProblem(pr, ''), /which instructs AI sessions, or decides CI's verdict or auto-merge/u);
});

test('viewSolo reads solo at the repository and base a pull request view names, and an unreadable URL reads nothing', (t) => {
  const project = repo(t).project();
  assert.equal(viewSolo(project, { baseRefName: 'main', url: URL }, { forge: fakeForge() }), true);
  const release = fakeForge({ main: SOLO, release: NOT_SOLO });
  assert.equal(viewSolo(project, { baseRefName: 'release', url: URL }, { forge: release }), false, 'the base must commit it too');
  assert.ok(release.calls.some(([name, , file, ref]) => name === 'contents' && file === '.aidrian/config.json' && ref === 'refs/heads/release'), 'the base was read');
  // Another repository than this checkout's: read there, where the stand-in has none, so it is false.
  const other = fakeForge();
  assert.equal(viewSolo(project, { baseRefName: 'main', url: 'https://github.com/Other/Repo/pull/5' }, { forge: other }), false);
  assert.deepEqual(other.calls[0], ['repository', 'other/repo', 'github.com'], 'the URL\'s repository and host');
  for (const view of [{ baseRefName: 'main', url: 'not a url' }, { baseRefName: 'main' }, { url: URL }, null]) {
    const forge = fakeForge();
    assert.equal(viewSolo(project, view, { forge }), false, JSON.stringify(view));
    assert.deepEqual(forge.calls, [], `${JSON.stringify(view)}: nothing read`);
  }
});

test('solo reads origin from the repository\'s own git config alone, and only one URL of it', (t) => {
  const r = repo(t);
  assert.equal(forgeSolo(r.project(), { forge: fakeForge() }), true);
  execFileSync('git', ['-C', r.dir, 'config', '--add', 'remote.origin.url', 'git@github.com:Acme/Notes.git']);
  assert.equal(forgeSolo(r.project(), { forge: fakeForge() }), false, 'two URLs');
  // Origin named only in a file the repository's config includes: no read follows the include.
  const included = repo(t);
  execFileSync('git', ['-C', included.dir, 'remote', 'remove', 'origin']);
  const extra = path.join(included.dir, '..', 'origin.cfg');
  writeFileSync(extra, '[remote "origin"]\n\turl = git@github.com:Acme/Notes.git\n');
  execFileSync('git', ['-C', included.dir, 'config', 'include.path', extra]);
  assert.equal(execFileSync('git', ['-C', included.dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim(), 'git@github.com:Acme/Notes.git', 'git itself follows the include');
  assert.equal(forgeSolo(included.project(), { forge: fakeForge() }), false);
});

test('aidrian pr settle follows solo for a machine that sets no switch', async (t) => {
  const project = repo(t).project();
  const config = loadConfig(project).config;
  const ruling = ['5', '--flow', 'look', '--accept', 'fit', '--evidence', 'https://x/y', '--reason', 'r', '--head', HEAD, '--judge', 'critic', '--check'];
  await assert.rejects(runSettle(ruling, project, config, { forge: fakeForge({ main: NOT_SOLO }) }), /a judge's ruling does not count here: this machine has not turned it on/u);
  // With solo, the switch lets the ruling through to the sign-off's own checks.
  await assert.rejects(runSettle(ruling, project, config, { forge: fakeForge() }), (error) => !/does not count here/u.test(error.message));
});

test('aidrian handoff route reads solo through gh, on the command line: background with solo, clear without', (t) => {
  const r = repo(t);
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-fake-gh-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // A gh that answers the two reads the forge makes for acme/notes on github.com, from FAKE_CONFIG, and 404 to the rest.
  writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const args = process.argv.slice(2);
const route = args.find((arg) => arg.startsWith('repos/')) ?? '';
const host = args[args.indexOf('--hostname') + 1];
if (args[0] !== 'api' || host !== 'github.com') process.exit(2);
if (route === 'repos/acme/notes') { process.stdout.write(JSON.stringify({ default_branch: 'main' })); process.exit(0); }
if (route === 'repos/acme/notes/contents/.aidrian/config.json?ref=refs%2Fheads%2Fmain') {
  process.stdout.write(JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(process.env.FAKE_CONFIG).toString('base64') }));
  process.exit(0);
}
process.stderr.write('gh: Not Found (HTTP 404)\\n');
process.exit(1);
`, { mode: 0o755 });
  const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
  const route = (team) => spawnSync(CLI, ['handoff', 'route'], {
    cwd: r.dir, encoding: 'utf8', env: { ...process.env, CLAUDECODE: '1', PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_CONFIG: JSON.stringify(team) },
  });
  const solo = route(SOLO);
  assert.equal(solo.stdout, 'route: background\n', solo.stderr);
  assert.match(route(NOT_SOLO).stdout, /^route: clear\nfallback: this machine has not turned the background route on/u);
});
