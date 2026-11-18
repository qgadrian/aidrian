// The fixture of the project run start tests (project-start-gate, project-start-guard, project-result): a project on
// `main` whose origin is github.com/acme/widgets, with its state, worktrees, home, and Claude Code config folders of its
// own, a run `launch` its driver session started, a forge stand-in that answers with the committed config, and a
// stand-in for the host's command that answers like Claude Code 2.1.326. No test starts a real session, reads a real
// pull request, or reads the user's own home. Temporary repositories are made with `git init` under mkdtemp and driven
// with `git -C`; no test sets GIT_DIR.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { openStore } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { projectCommand } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { initRun, readRun } from '../plugins/aidrian/lib/project-run.mjs';

export const DRIVER = 'abcd1234-0000-4000-8000-00000000d001';
export const OTHER = 'abcd1234-0000-4000-8000-00000000e001';
// The ids the host gives the sessions it starts, in order: the short one it prints, and the full one it lists.
export const STARTED = [
  { id: 'c0ffee01', session: 'c0ffee01-0000-4000-8000-00000000c001' },
  { id: 'c0ffee02', session: 'c0ffee02-0000-4000-8000-00000000c002' },
  { id: 'c0ffee03', session: 'c0ffee03-0000-4000-8000-00000000c003' },
];
export const ISSUES = [
  { key: 'ENG-1', branch: 'feat/eng-1-export', status: 'unstarted', priority: 1 },
  { key: 'ENG-2', branch: 'feat/eng-2-import', status: 'unstarted', blockedBy: ['ENG-1'] },
  { key: 'ENG-4', branch: 'fix/eng-4-typo', status: 'unstarted', priority: 3 },
];
export const noWait = () => {};

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });

// A stand-in for the forge facade: the default branch `main` at the commit `head()` gives, the committed config at
// `.aidrian/config.json` (`config`, as text), no `.aidrian.json`, and the pull requests in `views`, by number. `calls`
// records each call.
export function fakeForge(config, head, views = {}) {
  const calls = [];
  const missing = () => Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
  return {
    calls,
    repository: (repo, options) => {
      calls.push(['repository', repo, options]);
      return { default_branch: 'main' };
    },
    contents: (repo, file, ref, options) => {
      calls.push(['contents', repo, file, ref, options]);
      if (file !== '.aidrian/config.json') throw missing();
      return { type: 'file', encoding: 'base64', content: Buffer.from(config()).toString('base64') };
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
}

// A stand-in for spawnSync that answers like Claude Code 2.1.326: the driver session is listed, then each session `--bg`
// starts, in the folder it started in, under its name, with the ids of STARTED in order. `states` sets a listed
// session's state by its full id ('working' by default); `stop` marks it stopped. `start` replaces the answer of `--bg`.
export function fakeClaude({ dir, start = null, hidden = false } = {}) {
  const calls = [];
  const sessions = [];
  const states = {};
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (args[0] === 'stop') {
      const found = sessions.find((each) => each.id === args[1] || each.sessionId === args[1]);
      // As 2.1.326 lists a session `claude stop` stopped: `stopped`, not `done`.
      if (found) states[found.sessionId] = 'stopped';
      return { status: found ? 0 : 1, stdout: '', stderr: '' };
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
    return { status: 0, stdout: `backgrounded · ${ids.id} · ${name}\n`, stderr: '' };
  };
  return { run, calls, sessions, states, starts: () => calls.filter((call) => call.args[0] === '--bg') };
}

// The project, run, and helpers. `projectRun` is the committed projectRun; `working` a working copy config.json
// written over the committed one; `local` the machine's git-ignored file; `forgeConfig` the config the forge answers
// with, the committed one by default; `bootstrap` the worktrees' bootstrap command; `ignore` more .gitignore lines;
// `files` more files committed with the config, by path; `inRepo` keeps the worktrees in `.worktrees` of the checkout.
export function runFixture(t, { projectRun = { allow: true }, solo, local = { handoff: { background: 'on' } }, forgeConfig, bootstrap, ignore = [], issues = ISSUES, init = true, files = {}, inRepo = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const state = path.join(root, 'state');
  const worktrees = inRepo ? path.join(dir, '.worktrees') : path.join(root, 'worktrees');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const claudeConfig = path.join(root, 'claude-config');
  for (const each of [dir, state, ...(inRepo ? [] : [worktrees]), home, bin]) mkdirSync(each, { recursive: true, mode: 0o700 });
  const committed = { version: 1, state: { dir: state }, projectRun, ...(solo === undefined ? {} : { solo }), git: { worktrees: { dir: inRepo ? '.worktrees' : worktrees, ...(bootstrap ? { bootstrap } : {}) } } };
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(committed));
  writeFileSync(path.join(dir, '.gitignore'), ['.aidrian.local.json', '*.input', ...(inRepo ? ['.worktrees/'] : []), ...ignore, ''].join('\n'));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
  writeFileSync(path.join(dir, 'README.md'), '# widgets\n');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/widgets.git');
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  // The remote answers from a local bare copy: git's SSH command runs its upload-pack, so origin's URL stays the pinned one.
  const bare = path.join(root, 'remote.git');
  execFileSync('git', ['clone', '-q', '--bare', dir, bare], { stdio: 'pipe' });
  const ssh = path.join(bin, 'fake-ssh');
  writeFileSync(ssh, `#!/bin/sh\nexec git upload-pack '${bare}'\n`, { mode: 0o755 });
  git('config', 'core.sshCommand', ssh);
  if (local) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
  writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const transcripts = path.join(claudeConfig, 'projects', dir.replace(/[^A-Za-z0-9]/gu, '-'));
  mkdirSync(transcripts, { recursive: true });
  writeFileSync(path.join(transcripts, `${DRIVER}.jsonl`), `${JSON.stringify({ type: 'permission-mode', permissionMode: 'acceptEdits', sessionId: DRIVER })}\n`);
  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: DRIVER, CLAUDE_CONFIG_DIR: claudeConfig, PATH: `${bin}${path.delimiter}${process.env.PATH}`, XDG_STATE_HOME: path.join(home, '.local/state') };
  const project = findProject(dir);
  const { config } = loadConfig(project);
  const text = () => JSON.stringify(forgeConfig ?? committed);
  const forge = fakeForge(text, () => execFileSync('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).trim());
  const claude = fakeClaude({ dir });
  const store = openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  if (init) {
    const file = path.join(dir, 'snapshot.json.input');
    writeFileSync(file, JSON.stringify({ issues }));
    const started = initRun({ project, config, run: 'launch', file, session: DRIVER, env, home });
    if (started.exitCode !== 0) throw new Error(started.err.join('\n'));
  }
  const as = (session) => ({ ...env, CLAUDE_CODE_SESSION_ID: session });
  // `aidrian project` in this process as the session `session`, the driver by default.
  const cmd = (args, { session = DRIVER, ...more } = {}) => projectCommand(args, { cwd: dir, env: as(session), home, forge, spawn: claude.run, wait: noWait, pause: noWait, ...more });
  const run = () => readRun(state, 'launch');
  const rows = () => run().rows;
  return { root, dir, state, worktrees, home, bin, bare, env, as, git, project, config, forge, claude, store, cmd, run, rows, committed };
}
