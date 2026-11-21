// The fixture of the project run start tests (project-start-gate, project-start-guard, project-result,
// project-start-sandbox): a project on `main` whose origin is https://github.com/acme/widgets.git, served from a local
// bare copy by a stand-in for git's HTTPS remote helper (fixtureExecPath), with its state, worktrees, home,
// and Claude Code config folders of its own, a run `launch` its driver session started, a forge stand-in that answers
// with the committed config, and a stand-in for the host's command that answers like Claude Code 2.1.326 and files the
// agent gate hook's beacon for each session it starts, as the hook does on that session's first tool call. Every start
// is confined, so the committed config sets projectRun.unverifiedHosts, and the platform is pinned to Linux, with
// stand-ins for bubblewrap and socat on PATH; this plugin is installed at user scope in the host's config folder, as a
// confined start requires. No test starts a real session, reads a real pull request, reaches the network, or reads the
// user's own home. Temporary repositories are made with `git init` under mkdtemp and driven
// with `git -C`; no test sets GIT_DIR.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { openStore } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { noteBeacon } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { CONFINE_PLAN, CONFINE_VERDICT } from '../plugins/aidrian/lib/project-confine.mjs';
import { writeCheckedAccount, writeHandoff } from '../plugins/aidrian/lib/project-token.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { appendToRun, initRun, readRun, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';

export const DRIVER = 'abcd1234-0000-4000-8000-00000000d001';
export const OTHER = 'abcd1234-0000-4000-8000-00000000e001';
// The ids the host gives the sessions it starts, in order: the short one it prints, and the full one it lists.
export const STARTED = [
  { id: 'c0ffee01', session: 'c0ffee01-0000-4000-8000-00000000c001' },
  { id: 'c0ffee02', session: 'c0ffee02-0000-4000-8000-00000000c002' },
  { id: 'c0ffee03', session: 'c0ffee03-0000-4000-8000-00000000c003' },
  { id: 'c0ffee04', session: 'c0ffee04-0000-4000-8000-00000000c004' },
];
export const ISSUES = [
  { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted', priority: 1 },
  { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'unstarted', blockedBy: ['ENG-1'] },
  { key: 'ENG-4', branch: 'fix/eng-4-typo', status: 'unstarted', priority: 3 },
];
export const noWait = () => {};
// Appends an issue row to run `run`'s ledger, as the gate's own writes do (appendToRun).
export const recordIssue = (state, run, row) => appendToRun(state, run, () => ({ rows: [{ event: 'issue', key: row.key, state: row.state, ...(row.decision ? { decision: row.decision } : {}), at: new Date().toISOString() }] }));
// This plugin's id as the host's installed plugins name it, and its folder.
export const OWN_PLUGIN = 'aidrian@aidrian-harness';

// The global git config file of this test run, for a test that writes it: asserted first to lie inside the run's own
// state folder, AIDRIAN_TEST_STATE (scripts/test-state.mjs), so no test ever writes the developer's; its text is put
// back once the test `t` ends.
export function testGlobalConfig(t) {
  const global = process.env.GIT_CONFIG_GLOBAL;
  const state = process.env.AIDRIAN_TEST_STATE;
  const inside = typeof global === 'string' && typeof state === 'string' && state !== '' && path.isAbsolute(global)
    && !path.relative(state, global).startsWith('..') && !path.isAbsolute(path.relative(state, global)) && path.relative(state, global) !== '';
  assert.ok(inside, `GIT_CONFIG_GLOBAL, ${global}, lies outside the test run's own state folder, ${state}, so no test writes it`);
  const kept = readFileSync(global, 'utf8');
  t.after(() => writeFileSync(global, kept));
  return global;
}
const PLUGIN = path.join(import.meta.dirname, '../plugins/aidrian');

// A git exec path that is git's own but for its HTTPS remote helper, which serves the bare repository FIXTURE_REMOTE
// names over git's `connect` capability, as git's own remote-ext does: an `https://` origin then fetches and pushes with
// no network. Made once a process, in the temporary folder; its programs are links to git's.
let execPath = null;
export function fixtureExecPath() {
  if (execPath) return execPath;
  const real = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const dir = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-exec-'))), 'git-core');
  mkdirSync(dir);
  for (const name of readdirSync(real)) {
    if (!/^git-remote-https?$/u.test(name)) symlinkSync(path.join(real, name), path.join(dir, name));
  }
  const helper = [
    '#!/bin/sh',
    'while IFS= read -r line; do',
    '  case "$line" in',
    "    capabilities) printf '*connect\\n\\n' ;;",
    `    'connect git-upload-pack') printf '\\n'; exec git upload-pack "$FIXTURE_REMOTE" ;;`,
    `    'connect git-receive-pack') printf '\\n'; exec git receive-pack "$FIXTURE_REMOTE" ;;`,
    '    *) exit 1 ;;',
    '  esac',
    'done',
    '',
  ].join('\n');
  writeFileSync(path.join(dir, 'git-remote-https'), helper, { mode: 0o755 });
  symlinkSync('git-remote-https', path.join(dir, 'git-remote-http'));
  execPath = dir;
  return dir;
}

export const ORIGIN = 'https://github.com/acme/widgets.git';

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });

// A stand-in for the forge facade: the default branch `main` at the commit `head()` gives, the committed config at
// `.aidrian/config.json` (`config`, as text), no `.aidrian.json`, the pull requests in `views`, by number, the push
// permission `push()` gives, and the forge CLI's login token `token()` gives, a fine-grained one by default; a `token`
// that throws is a CLI with no login. The push probe with a token, as the start checks the issue session's, answers what
// `tokenPush(token)` gives: true, false (the forge's 403), or a throw. The user a token belongs to is what
// `tokenUser(token)` gives, and the forge CLI's own login what `viewerLogin()` gives, `octo` for both by default.
// `calls` records each call.
export const FIXTURE_TOKEN = 'github_pat_FIXTURE0123456789';
export function fakeForge(config, head, views = {}, { push = () => true, token = () => FIXTURE_TOKEN, tokenPush = () => true, tokenUser = () => 'octo', viewer = () => 'octo' } = {}) {
  const calls = [];
  const missing = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
  const forge = {
    calls,
    tokenPush,
    repository: (repo, options) => {
      calls.push(['repository', repo, options]);
      return { default_branch: 'main', permissions: { pull: true, push: push() } };
    },
    tokenCanPush: (repo, options) => {
      calls.push(['tokenCanPush', repo, { host: options?.host, token: typeof options?.token === 'string' ? 'given' : 'none' }]);
      const may = forge.tokenPush(options.token);
      return { may, why: may ? null : 'the forge answered 403' };
    },
    tokenUser,
    viewerLogin: viewer,
    tokenLogin: (options) => {
      calls.push(['tokenLogin', { host: options?.host, token: typeof options?.token === 'string' ? 'given' : 'none' }]);
      return forge.tokenUser(options.token);
    },
    viewer: (options) => {
      calls.push(['viewer', options]);
      return forge.viewerLogin();
    },
    contents: (repo, file, ref, options) => {
      calls.push(['contents', repo, file, ref, options]);
      if (file !== '.aidrian/config.json') throw missing();
      return { type: 'file', encoding: 'base64', content: Buffer.from(config()).toString('base64') };
    },
    authToken: (options) => {
      calls.push(['authToken', options]);
      return token();
    },
    branchHead: (repo, branch, options) => {
      calls.push(['branchHead', repo, branch, options]);
      return branch === 'main' ? head() : null;
    },
    change: (ref, fields, options) => {
      calls.push(['change', ref, fields, options]);
      const view = views[ref];
      if (!view) throw missing();
      return typeof view === 'function' ? view() : view;
    },
  };
  return forge;
}

// A stand-in for spawnSync that answers like Claude Code 2.1.326: the driver session is listed, then each session `--bg`
// starts, in the folder it started in, under its name, with the ids of STARTED in order. `states` sets a listed
// session's state by its full id ('working' by default); `stop` marks it stopped. `start` replaces the answer of `--bg`.
// With `env`, each session `--bg` lists files its beacon under that environment, as the agent gate hook does on the
// session's first tool call; `beacon: false` files none, as a host that does not run the plugin's hooks. Where the
// start wrote a sandbox proof plan beside the clone, each such session also hands over the verdict `confine` gives for
// that plan (passVerdict by default, as a session whose sandbox refused every probe; null hands none over).
// `stoppable: false` makes every `claude stop` fail, as a supervisor that does not answer.
export function fakeClaude({ dir, start = null, hidden = false, env = null, beacon = true, confine = passVerdict, stoppable = true } = {}) {
  const calls = [];
  const sessions = [];
  const states = {};
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === 'stop') {
      const found = sessions.find((each) => each.id === args[1] || each.sessionId === args[1]);
      // As 2.1.326 lists a session `claude stop` stopped: `stopped`, not `done`.
      if (found && stoppable) states[found.sessionId] = 'stopped';
      return { status: found && stoppable ? 0 : 1, stdout: '', stderr: '' };
    }
    if (args[0] === 'agents') {
      const listed = [{ sessionId: DRIVER, name: 'driver', kind: 'interactive', cwd: dir, state: 'working' }, ...sessions.map((each) => ({ ...each, state: states[each.sessionId] ?? 'working' }))];
      return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    }
    const ids = STARTED[sessions.length];
    const name = args[args.indexOf('--name') + 1];
    if (start) {
      const answer = start({ args, options, ids, name });
      if (answer.listed) sessions.push({ id: ids.id, sessionId: ids.session, name, kind: 'background', cwd: options.cwd });
      return answer;
    }
    if (!hidden) sessions.push({ id: ids.id, sessionId: ids.session, name, kind: 'background', cwd: options.cwd });
    if (!hidden && env && beacon) noteBeacon(ids.session, { env });
    if (!hidden && confine) handVerdict(options.cwd, ids.session, confine);
    return { status: 0, stdout: `backgrounded · ${ids.id} · ${name}\n`, stderr: '' };
  };
  return { run, calls, sessions, states, starts: () => calls.filter((call) => call.args[0] === '--bg') };
}

// The verdict of a session whose sandbox refused every probe of `plan`, as `aidrian project confine` writes it.
export const passVerdict = (plan, session) => ({ version: 1, run: plan.run, key: plan.key, attempt: plan.attempt, nonce: plan.nonce, session, pass: true, failed: [], probes: 12, at: new Date().toISOString() });

// Writes in the drop folder beside the clone `work` the verdict `confine(plan, session)` gives, when the start wrote a
// plan there; and, where the start wrote a token claim, the SessionStart hook's record that it handed the token over.
export function handVerdict(work, session, confine = passVerdict) {
  const folder = path.dirname(work);
  if (existsSync(path.join(folder, 'token-claim.json'))) writeHandoff(folder, { handed: true });
  let plan;
  try {
    plan = JSON.parse(readFileSync(path.join(folder, CONFINE_PLAN), 'utf8'));
  } catch {
    return;
  }
  const verdict = confine(plan, session);
  if (verdict) writeFileSync(path.join(folder, 'drop', CONFINE_VERDICT), JSON.stringify(verdict));
}

// The project, run, and helpers. `projectRun` is the committed projectRun, which allows runs and unverified hosts by
// default; `working` a working copy config.json
// written over the committed one; `local` the machine's git-ignored file; `forgeConfig` the config the forge answers
// with, the committed one by default; `bootstrap` the worktrees' bootstrap command; `ignore` more .gitignore lines;
// `files` more files committed with the config, by path; `links` symbolic links committed with it, each path to its
// target; `inRepo` keeps the worktrees in `.worktrees` of the checkout;
// `config` more keys of the committed config.json, its `git` group merged with the worktrees folder.
export function runFixture(t, { projectRun = { allow: true, unverifiedHosts: true }, solo, local = { handoff: { background: 'on' } }, forgeConfig, bootstrap, ignore = [], issues = ISSUES, init = true, files = {}, links = {}, inRepo = false, config: extra = {} } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const state = path.join(root, 'state');
  const worktrees = inRepo ? path.join(dir, '.worktrees') : path.join(root, 'worktrees');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const claudeConfig = path.join(root, 'claude-config');
  for (const each of [dir, state, ...(inRepo ? [] : [worktrees]), home, bin]) mkdirSync(each, { recursive: true, mode: 0o700 });
  const committed = { version: 1, state: { dir: state }, projectRun, ...(solo === undefined ? {} : { solo }), ...extra, git: { ...extra.git, worktrees: { dir: inRepo ? '.worktrees' : worktrees, ...(bootstrap ? { bootstrap } : {}) } } };
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(committed));
  writeFileSync(path.join(dir, '.gitignore'), ['.aidrian.local.json', '*.input', ...(inRepo ? ['.worktrees/'] : []), ...ignore, ''].join('\n'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  for (const [file, target] of Object.entries(links)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    symlinkSync(target, path.join(dir, file));
  }
  writeFileSync(path.join(dir, 'README.md'), '# widgets\n');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', ORIGIN);
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The remote answers from a local bare copy, through the environment's git exec path (fixtureExecPath), so origin's
  // URL stays the pinned one and no git config of the repository names a program, which the start gate refuses
  // (lib/project-trust.mjs repositoryProblem).
  const bare = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, bare], { stdio: 'pipe' });
  if (local) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  // The programs the host's sandbox needs on Linux, which the start looks for on PATH.
  for (const name of ['bwrap', 'socat']) writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const transcripts = path.join(claudeConfig, 'projects', dir.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(path.join(transcripts, `${DRIVER}.jsonl`), `${JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: DRIVER })}\n`);
  // This plugin, installed at user scope, as a session started with --setting-sources user loads it.
  mkdirSync(path.join(claudeConfig, 'plugins'), { recursive: true });
  writeFileSync(path.join(claudeConfig, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { [OWN_PLUGIN]: [{ scope: 'user', installPath: PLUGIN }] } }));
  // The Human trusted the state folder once, as they trust the runs folder: each start records it for its clone.
  mkdirSync(state, { recursive: true });
  const trusted = { hasTrustDialogAccepted: true };
  writeFileSync(path.join(claudeConfig, '.claude.json'), JSON.stringify({ projects: { [state]: trusted, [realpathSync(state)]: trusted } }));
  const env = {
    ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: DRIVER, CLAUDE_CONFIG_DIR: claudeConfig, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(home, '.local/state'), GIT_EXEC_PATH: fixtureExecPath(), FIXTURE_REMOTE: bare,
  };
  const project = findProject(dir);
  const { config } = loadConfig(project);
  const text = () => JSON.stringify(forgeConfig ?? committed);
  const forge = fakeForge(text, () => execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim());
  const claude = fakeClaude({ dir, env });
  const store = openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  if (init) {
    const file = path.join(dir, 'snapshot.json.input');
    writeFileSync(file, JSON.stringify({ issues }));
    const started = initRun({ project, config, run: 'launch', file, session: DRIVER, env, home });
    if (started.exitCode !== 0) throw new Error(started.err.join('\n'));
    // The account a passed preflight checked the forge's rules for, which every start holds the token to.
    writeCheckedAccount(runsFolder(state), { host: 'github.com', owner: 'acme', name: 'widgets' }, 'octo');
  }
  const as = (session) => ({ ...env, CLAUDE_CODE_SESSION_ID: session });
  // `aidrian project` in this process as the session `session`, the driver by default.
  const cmd = (args, { session = DRIVER, ...more } = {}) => projectCommand(args, { cwd: dir, env: as(session), home, forge, spawn: claude.run, wait: noWait, pause: noWait, platform: 'linux', ...more });
  const run = () => readRun(state, 'launch');
  const rows = () => run().rows;
  return { root, dir, state, worktrees, home, bin, bare, env, as, git, project, config, forge, claude, store, cmd, run, rows, committed };
}
