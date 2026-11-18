// The session ledger hook (docs/hooks.md#session-ledger), run as the host runs it: a PostToolUse payload of a Bash call on
// stdin, in a project whose checkouts have real remotes. Every case reads what the hook appended to the session's prs.jsonl.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { forgeFor } from '../plugins/aidrian/lib/forges/index.mjs';
import * as githubCalls from '../plugins/aidrian/lib/rules/github/session-calls.mjs';
import { appendLedger, LEDGER_MAX_BYTES, ledgerRows, MAX_FOLDERS, MAX_ROWS, OUTPUT_TAIL, outputTail } from '../plugins/aidrian/lib/session-prs.mjs';
import { sessionFolder } from '../plugins/aidrian/lib/session-folder.mjs';

const ROOT_DIR = path.resolve(import.meta.dirname, '..');
const PLUGIN = path.join(ROOT_DIR, 'plugins/aidrian');
const HOOK = path.join(PLUGIN, 'scripts/hook-bash-post.mjs');
const ROOT = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-bash-post-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const STATE = path.join(ROOT, 'state');
const POSIX = process.platform !== 'win32';

// Git and the hook see only this environment: Claude Code's marker, and no git variable of the running checkout.
const ENV = { PATH: process.env.PATH, HOME: ROOT, XDG_STATE_HOME: STATE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', CLAUDECODE: '1' };

// A project checkout in its own folder, on branch `branch`, with `remotes` by name.
function checkout(name, remotes, branch = 'feat/ledger') {
  const dir = path.join(ROOT, name);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir, env: ENV }).status, 0, args.join(' '));
  git('init', '-q', '-b', 'main');
  git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  for (const [remote, url] of Object.entries(remotes)) git('remote', 'add', remote, url);
  return dir;
}

const OWN = checkout('own', { origin: 'git@github.com:acme/widgets.git' });
// A fork checkout: origin is the fork, upstream the parent.
const FORK = checkout('fork', { origin: 'https://github.com/me/widgets.git', upstream: 'https://github.com/acme/widgets.git' }, 'fix/fork');
const OTHER = checkout('other', { origin: 'https://github.com/acme/other.git' }, 'main');
const GITLAB = checkout('gitlab', { origin: 'git@gitlab.com:acme/widgets.git', made: 'https://git.example.test/acme/widgets.git' });
const NO_PROJECT = path.join(ROOT, 'no-project');
mkdirSync(NO_PROJECT);

let sessions = 0;
const nextSession = () => `session-${(sessions += 1)}`;

// Claude Code's PostToolUse payload of a Bash call: test/fixtures/hosts/claude-code/bash-post.json holds a real one.
const payload = (command, { cwd = OWN, stdout = '', session = nextSession(), response, extra = {} } = {}) => ({
  session_id: session,
  transcript_path: path.join(ROOT, 'none.jsonl'),
  cwd,
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command, description: 'x' },
  tool_response: response === undefined ? { stdout, stderr: '', interrupted: false, isImage: false, noOutputExpected: false } : response,
  ...extra,
});

function runHook(input, env = {}) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const ran = spawnSync(process.execPath, [HOOK], { input: text, encoding: 'utf8', env: { ...ENV, ...env } });
  assert.deepEqual([ran.status, ran.stdout, ran.stderr], [0, '', ''], 'the hook always exits 0 and prints nothing');
  return ran;
}

// The ledger files of `session`, under every project's state folder.
function ledgerFiles(session) {
  const projects = path.join(STATE, 'aidrian/projects');
  if (!existsSync(projects)) return [];
  return readdirSync(projects).map((id) => path.join(projects, id, 'sessions', session, 'prs.jsonl')).filter((file) => existsSync(file));
}

// The rows the hook appended for `command`, without their time.
function rows(command, options = {}, env = {}) {
  const input = payload(command, options);
  runHook(input, env);
  return ledgerFiles(input.session_id).flatMap((file) => readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)).map((line) => {
    const { at, ...row } = JSON.parse(line);
    assert.match(at, /^\d{4}-\d\d-\d\dT/u);
    return row;
  });
}

const row = (kind, repoPath, { number = null, branch = null, cwd = OWN, host = 'github.com' } = {}) =>
  ({ agentId: null, kind, forge: 'github', host, path: repoPath, number, branch, cwd });
const created = (repoPath, number, cwd = OWN) => row('created', repoPath, { number, cwd });
const pushed = (repoPath, branch, cwd = OWN) => row('pushed', repoPath, { branch, cwd });
const touched = (repoPath, fields, cwd = OWN) => row('touched', repoPath, { ...fields, cwd });
const URL_OF = (repoPath, n) => `https://github.com/${repoPath}/pull/${n}`;

// A project checkout on `branch`, with one commit, whose origin is `url` and whose pushes land in a bare repository of
// its own through `url.<bare>.insteadOf`, so git records a push as it does one to the forge. Each is new, so no push of
// another case lies within its window.
let pushRepos = 0;
function pushRepo(branch, url = 'https://github.com/acme/notes') {
  pushRepos += 1;
  const bare = path.join(ROOT, `push-${pushRepos}.git`);
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare], { env: ENV }).status, 0);
  const dir = checkout(`push-${pushRepos}`, { origin: url }, branch);
  sh(dir, `git config url.${bare}.insteadOf ${url} && git -c user.name=t -c user.email=t@t.test commit -q --allow-empty -m one`);
  return dir;
}
// Runs `command` in a shell in `dir`, as the session's call ran it.
const sh = (dir, command) => assert.equal(spawnSync('/bin/sh', ['-c', command], { cwd: dir, env: ENV }).status, 0, command);

test('gh pr create records the pull request its stdout links, with the forge id, host, and path, and no raw URL, command, or output', () => {
  const recorded = rows('gh pr create --title "Add x" --body "Why"', { stdout: `${URL_OF('acme/widgets', 12)}\n` });
  assert.deepEqual(recorded, [created('acme/widgets', 12)]);
  assert.deepEqual(Object.keys(recorded[0]), ['agentId', 'kind', 'forge', 'host', 'path', 'number', 'branch', 'cwd']);
});

test('a created row comes only from a line that is exactly a pull request URL of a remote of the call`s folder', () => {
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n${URL_OF('other/repo', 9)}\n` }), [created('acme/widgets', 12)], 'other/repo is no remote of the folder');
  assert.deepEqual(rows('gh pr create --fill', { stdout: `see ${URL_OF('acme/widgets', 12)}\n${URL_OF('acme/widgets', 13)}/files\n` }), []);
  assert.deepEqual(rows('gh pr create --fill', { stdout: 'https://gitlab.com/acme/widgets/pull/4\nhttps://git.example.test/acme/widgets/pull/5\n' }), []);
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\r\n` }), [created('acme/widgets', 12)]);
  assert.deepEqual(rows(`echo ${URL_OF('acme/widgets', 12)}`, { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [], 'output is read only for gh pr create');
});

test('gh pr create --dry-run creates nothing, so a link in its preview body records no row', () => {
  const preview = `Would have created a Pull Request with:\ntitle:\tAdd x\nbody:\nFollows\n${URL_OF('acme/widgets', 12)}\n`;
  assert.deepEqual(rows('gh pr create --dry-run --title "Add x" --body-file body.md', { stdout: preview }), []);
});

test('a created row comes only from a line whose one printing command is gh pr create, after a cd or variable assignments', () => {
  const link = `${URL_OF('acme/widgets', 9)}\n`;
  assert.deepEqual(rows(`gh pr create --fill && echo ${URL_OF('acme/widgets', 9)}`, { stdout: link }), [], 'an echoed link of an allowed repository');
  assert.deepEqual(rows(`echo ${URL_OF('acme/widgets', 9)}; gh pr create --fill`, { stdout: link }), [], 'a command before it');
  assert.deepEqual(rows('gh pr create --fill | tee log', { stdout: link }), [], 'a pipe');
  assert.deepEqual(rows(`gh pr create --body "$(echo ${URL_OF('acme/widgets', 9)} >&2)" --fill`, { stdout: link }), [], 'a substitution that prints');
  assert.deepEqual(rows('X=1; gh pr create --fill', { stdout: link }), [created('acme/widgets', 9)], 'a bare assignment');
  assert.deepEqual(rows(`cd ${OWN} && GH_REPO=acme/widgets gh pr create --body "$(cat <<'EOF'\nWhy\nEOF\n)" --fill`, { stdout: link }), [created('acme/widgets', 9)], 'a cd and a heredoc body');
});

test('in a fork checkout, gh pr create printing the parent`s URL records the parent', () => {
  assert.deepEqual(rows('gh pr create --fill', { cwd: FORK, stdout: `${URL_OF('acme/widgets', 31)}\n` }), [created('acme/widgets', 31, FORK)]);
});

test('with -R or GH_REPO, the created URL`s repository must equal it', () => {
  assert.deepEqual(rows('gh pr create -R acme/other --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n` }), []);
  assert.deepEqual(rows('gh pr create -R acme/other --fill', { stdout: `${URL_OF('acme/other', 2)}\n` }), [created('acme/other', 2)]);
  assert.deepEqual(rows('GH_REPO=acme/other gh pr create --fill', { stdout: `${URL_OF('acme/other', 3)}\n` }), [created('acme/other', 3)]);
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${URL_OF('acme/other', 4)}\n` }, { GH_REPO: 'acme/other' }), [created('acme/other', 4)]);
  assert.deepEqual(rows('gh pr create --repo "$R" --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [], 'a repository the shell fills in records nothing');
});

test('the call`s folder is the one a cd before it names, and a folder the shell fills in records nothing', () => {
  assert.deepEqual(rows(`cd ${OTHER} && gh pr create --fill`, { stdout: `${URL_OF('acme/other', 5)}\n` }), [created('acme/other', 5, OTHER)]);
  assert.deepEqual(rows('cd "$X" && gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n` }), []);
});

test('only the last 64 KB of the output is read', () => {
  const filler = `${'x'.repeat(70 * 1024)}\n`;
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n${filler}` }), []);
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${filler}${URL_OF('acme/widgets', 12)}\n` }), [created('acme/widgets', 12)]);
});

test('a response the adapter cannot read gives no created row, and a push in the same call still records', () => {
  const dir = pushRepo('feat/ledger');
  sh(dir, 'git push -q origin HEAD');
  for (const response of [null, 'text', { stdout: 7 }, []]) {
    assert.deepEqual(rows('gh pr create --fill && git push origin HEAD', { cwd: dir, response }), [pushed('acme/notes', 'feat/ledger', dir)], JSON.stringify(response));
  }
});

test('a push records each branch git recorded it updated, as the remote-tracking ref`s reflog holds it', () => {
  const cases = [
    ['feat/head', 'git push -q origin HEAD', ['feat/head']],
    ['feat/local', 'git config push.default upstream && git config branch.feat/local.remote origin && git config branch.feat/local.merge refs/heads/main-line && git push -q', ['main-line']],
    ['feat', 'git push -q origin feat:release', ['release']],
    ['feat/tag', 'git tag v1 && git push -q origin tag v1', []],
    ['feat/switch', 'git branch main && git push -q origin HEAD && git switch -q main', ['feat/switch']],
    ['feat/url', 'git push -q ../BARE HEAD', [], 'a push to a URL no remote names updates no remote-tracking ref'],
  ];
  for (const [branch, written, branches, why] of cases) {
    const dir = pushRepo(branch);
    const command = written.replace('BARE', `${path.basename(dir)}.git`);
    sh(dir, command);
    assert.deepEqual(rows(command, { cwd: dir }), branches.map((each) => pushed('acme/notes', each, dir)), why ?? command);
  }
});

test('a push records the folder it ran in: git -C, then a cd before it on the line, else the payload folder', () => {
  const dir = pushRepo('feat/folder');
  sh(dir, 'git push -q origin HEAD');
  assert.deepEqual(rows(`git -C ${dir} push`), [pushed('acme/notes', 'feat/folder', dir)]);
  assert.deepEqual(rows(`cd ${dir} && npm test && git push`), [pushed('acme/notes', 'feat/folder', dir)]);
  assert.deepEqual(rows('git push', { cwd: dir }), [pushed('acme/notes', 'feat/folder', dir)]);
  assert.deepEqual(rows('git -C "$W" push', { cwd: dir }), []);
  assert.deepEqual(rows('cd "$W" && git push', { cwd: dir }), []);
});

test('a push records only what it pushed of its own folder`s HEAD, never a sibling worktree`s push in the window', () => {
  const base = pushRepo('main');
  const [a, b] = ['wt-a', 'wt-b'].map((name) => path.join(ROOT, `${path.basename(base)}-${name}`));
  sh(base, `git worktree add -q -b feat/wt-a '${a}' && git worktree add -q -b feat/wt-b '${b}'`);
  mkdirSync(path.join(a, '.aidrian'), { recursive: true });
  writeFileSync(path.join(a, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  sh(a, 'git push -q origin HEAD');
  // A's own push, moved out of the window, so only B's falls in it.
  const old = new Date(Date.now() - 2 * 60_000);
  utimesSync(path.join(base, '.git/logs/refs/remotes/origin/feat/wt-a'), old, old);
  const commit = '-c user.name=t -c user.email=t@t.test commit -q --allow-empty -m';
  sh(b, `git ${commit} b && git push -q origin HEAD`);
  sh(a, 'git push -q origin HEAD');
  assert.deepEqual(rows('git push origin HEAD', { cwd: a }), [], 'A had nothing to push');
  sh(a, `git ${commit} a && git push -q origin HEAD`);
  assert.deepEqual(rows('git push origin HEAD', { cwd: a }), [pushed('acme/notes', 'feat/wt-a', a)], 'A pushed its own branch');
});

test('a row is recorded only for a host the forge adapter declares', () => {
  const dir = pushRepo('feat/gitlab', 'https://gitlab.com/acme/notes');
  sh(dir, 'git push -q origin HEAD');
  assert.deepEqual(rows('git push', { cwd: dir }), [], 'gitlab.com');
  assert.deepEqual(rows('gh pr view 4', { cwd: GITLAB }), []);
});

test('gh pr ready, edit, merge, checks, view, and comment record a touched row', () => {
  const cases = [
    ['gh pr view 12 --json number', [touched('acme/widgets', { number: 12 })]],
    ["gh pr checks '#13' --watch", [touched('acme/widgets', { number: 13 })]],
    ['gh pr checks #13 is a shell comment', [touched('acme/widgets', { branch: 'feat/ledger' })]],
    [`gh pr merge ${URL_OF('acme/other', 7)} --squash`, [touched('acme/other', { number: 7 })]],
    ['gh pr ready feat/x', [touched('acme/widgets', { branch: 'feat/x' })]],
    ['gh pr comment --body "done" 14', [touched('acme/widgets', { number: 14 })]],
    ['gh pr edit 15 -t "New title"', [touched('acme/widgets', { number: 15 })]],
    ['gh pr merge', [touched('acme/widgets', { branch: 'feat/ledger' })]],
    ['gh pr view 12 -R acme/other', [touched('acme/other', { number: 12 })]],
    ['gh pr view "$N"', []],
    ['gh pr view 0', []],
    ['gh pr view --help', []],
    ['gh pr list', []],
    ['gh issue view 12', []],
  ];
  for (const [command, expected] of cases) assert.deepEqual(rows(command), expected, command);
});

test('in a fork checkout, a number with no repository records nothing, and -R names the parent', () => {
  assert.deepEqual(rows('gh pr checks 12', { cwd: FORK }), []);
  assert.deepEqual(rows('gh pr checks 12 -R acme/widgets', { cwd: FORK }), [touched('acme/widgets', { number: 12 }, FORK)]);
  assert.deepEqual(rows(`gh pr view ${URL_OF('acme/widgets', 12)}`, { cwd: FORK }), [touched('acme/widgets', { number: 12 }, FORK)]);
});

test('a subagent`s call records its agent id under the parent session', () => {
  const recorded = rows('gh pr view feat', { extra: { agent_id: 'a1b2c3d4', agent_type: 'aidrian:harness-mechanic' } });
  assert.deepEqual(recorded, [{ ...touched('acme/widgets', { branch: 'feat' }), agentId: 'a1b2c3d4' }]);
  assert.deepEqual(rows('gh pr view feat', { extra: { agent_id: '../x y' } }), [touched('acme/widgets', { branch: 'feat' })], 'an id of another shape is left out');
});

test('nothing is written for an interrupted call, a bad session id, a folder with no project, or input the hook cannot read', () => {
  assert.deepEqual(rows('gh pr view feat', { response: { stdout: '', stderr: '', interrupted: true } }), []);
  for (const session of ['../x', 'a/b', '', 'x'.repeat(129)]) {
    runHook(payload('gh pr view feat', { session }));
  }
  runHook({ ...payload('gh pr view feat'), session_id: undefined });
  assert.deepEqual(rows('gh pr view feat', { cwd: NO_PROJECT }), []);
  for (const input of ['', 'not json', '[]', '{"tool_input":{"command":7}}']) runHook(input);
  const projects = path.join(STATE, 'aidrian/projects');
  const files = existsSync(projects) ? readdirSync(projects).flatMap((id) => (existsSync(path.join(projects, id, 'sessions')) ? readdirSync(path.join(projects, id, 'sessions')) : [])) : [];
  assert.deepEqual(files.filter((name) => !/^session-\d+$/u.test(name)), [], 'no folder for a session id that fails SESSION_ID');
});

test('a state folder inside another checkout of the repository, such as a linked worktree, gets no ledger', () => {
  const dir = checkout('linked-state', { origin: 'git@github.com:acme/widgets.git' });
  const git = (...args) => assert.equal(spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: dir, env: ENV }).status, 0, args.join(' '));
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const tree = path.join(ROOT, 'linked-state-tree');
  git('worktree', 'add', '-q', '-b', 'feat/other', tree);
  // The project's own checkouts are its folder and the main checkout: the linked worktree is neither.
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: path.join(tree, '.state') } }));
  runHook(payload('gh pr view 3', { cwd: dir }));
  assert.equal(existsSync(path.join(tree, '.state')), false, 'nothing is written in the other worktree');
});

test('the session folder is 0700 and prs.jsonl 0600, appended line by line', { skip: !POSIX }, () => {
  const session = nextSession();
  runHook(payload('gh pr view feat/a', { session }));
  runHook(payload('gh pr view feat/b', { session }));
  const [file] = ledgerFiles(session);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch), ['feat/a', 'feat/b']);
});

// The session folder of `session` under the project of OWN, made by a first call.
function ownFolder(session) {
  runHook(payload('gh pr view first', { session }));
  const [file] = ledgerFiles(session);
  return path.dirname(file);
}

// A file outside the session folder that would take a write if a defence were missing: mode 0600, this user's, one link,
// so only the defence under test stands between it and the hook.
function outsideFile(name) {
  const file = path.join(ROOT, name);
  writeFileSync(file, 'kept\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

test('a hard link at prs.jsonl receives no write: one link is required', { skip: !POSIX }, () => {
  const outside = outsideFile('outside-hard.txt');
  const session = nextSession();
  const folder = ownFolder(session);
  rmSync(path.join(folder, 'prs.jsonl'));
  linkSync(outside, path.join(folder, 'prs.jsonl'));
  runHook(payload('gh pr view feat', { session }));
  assert.equal(readFileSync(outside, 'utf8'), 'kept\n');
});

test('a symlink at prs.jsonl receives no write: the ledger opens no-follow', { skip: !POSIX }, () => {
  const outside = outsideFile('outside-symlink.txt');
  const session = nextSession();
  const folder = ownFolder(session);
  rmSync(path.join(folder, 'prs.jsonl'));
  symlinkSync(outside, path.join(folder, 'prs.jsonl'));
  runHook(payload('gh pr view feat', { session }));
  assert.equal(readFileSync(outside, 'utf8'), 'kept\n');
  assert.equal(statSync(outside).nlink, 1);
});

test('a ledger another user may read receives no write: it must be 0600', { skip: !POSIX }, () => {
  const session = nextSession();
  const folder = ownFolder(session);
  const file = path.join(folder, 'prs.jsonl');
  const before = readFileSync(file, 'utf8');
  chmodSync(file, 0o644);
  runHook(payload('gh pr view feat', { session }));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a symlinked session folder receives no write', { skip: !POSIX }, () => {
  const folder = ownFolder(nextSession());
  const moved = nextSession();
  const target = path.join(ROOT, 'elsewhere');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, path.join(path.dirname(folder), moved));
  runHook(payload('gh pr view feat', { session: moved }));
  assert.deepEqual(readdirSync(target), []);
  assert.ok(lstatSync(path.join(path.dirname(folder), moved)).isSymbolicLink());
});

test('a ledger at its cap is compacted, so the newest row shows and the file stays within the cap', { skip: !POSIX }, () => {
  const session = nextSession();
  const file = path.join(ownFolder(session), 'prs.jsonl');
  appendFileSync(file, `${' '.repeat(LEDGER_MAX_BYTES - statSync(file).size - 10)}\n`);
  runHook(payload('gh pr view feat/newest', { session }));
  assert.ok(statSync(file).size <= LEDGER_MAX_BYTES);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch), ['first', 'feat/newest']);
});

test('the same call made again within a minute adds no row', { skip: !POSIX }, () => {
  const session = nextSession();
  const file = path.join(ownFolder(session), 'prs.jsonl');
  runHook(payload('gh pr view feat', { session }));
  const size = statSync(file).size;
  for (let at = 0; at < 3; at += 1) runHook(payload('gh pr view feat', { session }));
  assert.equal(statSync(file).size, size);
});

test('a repeat within a minute is written when another kind of row for its branch came between', { skip: !POSIX }, () => {
  const folder = sessionFolder(path.join(ROOT, 'unit-state'), 'unit-repeat', { checkouts: [] });
  const make = (kind, second) => ({ at: `2026-11-18T10:00:0${second}.000Z`, agentId: null, kind, forge: 'github', host: 'github.com', path: 'acme/widgets', number: null, branch: 'feat', cwd: ROOT });
  assert.deepEqual([make('touched', 0), make('pushed', 1), make('touched', 2), make('touched', 3)].map((each) => appendLedger(folder, [each])), [true, true, true, false]);
  assert.deepEqual(readFileSync(path.join(folder, 'prs.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind), ['touched', 'pushed', 'touched']);
});

test('creating a session folder sweeps the folders untouched for 30 days', { skip: !POSIX }, () => {
  const old = nextSession();
  const folder = ownFolder(old);
  const then = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(folder, 'prs.jsonl'), then, then);
  utimesSync(folder, then, then);
  runHook(payload('gh pr view feat', { session: nextSession() }));
  assert.equal(existsSync(folder), false);
});

test('each host`s recorded payload records the created pull request through its adapter', () => {
  for (const host of ['claude-code', 'codex']) {
    const fixture = JSON.parse(readFileSync(path.join(ROOT_DIR, 'test/fixtures/hosts', host, 'bash-post.json'), 'utf8'));
    assert.equal(typeof fixture.live, 'boolean');
    if (!fixture.live) assert.match(fixture.provenance, /^NOT LIVE/u);
    const session = nextSession();
    const input = { ...fixture.post, session_id: session, cwd: OWN };
    const env = { PATH: ENV.PATH, HOME: ROOT, XDG_STATE_HOME: STATE, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...fixture.env };
    runHook(input, { ...env, CLAUDECODE: fixture.env.CLAUDECODE ?? '' });
    const lines = ledgerFiles(session).flatMap((file) => readFileSync(file, 'utf8').trim().split('\n'));
    assert.deepEqual(lines.map((line) => JSON.parse(line).number), [fixture.number], host);
  }
});

// A checkout whose folder name holds a bidi control.
const BIDI = checkout('bidi‮own', { origin: 'https://github.com/acme/widgets.git' });
mkdirSync(path.join(OWN, 'sub'), { recursive: true });

test('the folder of a call comes from an absolute cd, git -C, or env -C, and the payload folder only on a line that changes no directory', () => {
  assert.deepEqual(rows('cd sub && gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [], 'a relative cd');
  assert.deepEqual(rows(`cd ${OTHER} && gh pr view 3`), [touched('acme/other', { number: 3 }, OTHER)]);
  assert.deepEqual(rows(`gh pr view 3 && cd ${OTHER}`), [], 'the payload folder may be the one the line ended in');
  assert.deepEqual(rows(`cd ${OTHER}; gh pr view 3`), [], 'a cd that is no leading cd with &&');
  assert.deepEqual(rows('gh pr view 3'), [touched('acme/widgets', { number: 3 })]);
  assert.deepEqual(rows(`env -C ${OTHER} gh pr view 3`), [touched('acme/other', { number: 3 }, OTHER)]);
  assert.deepEqual(rows("bash -c 'cd sub && gh pr view 3'"), [], 'a relative cd in a shell the line runs');
  assert.deepEqual(rows('echo "$(pwd)" && gh pr view 3'), [touched('acme/widgets', { number: 3 })]);
});

test('a call whose repository or config the line may move records nothing', () => {
  const cases = [
    'gh pr view 12 --json $FIELDS',
    'export GH_REPO=acme/other; gh pr view 12',
    'GH_REPO=acme/other; gh pr view 12',
    'unset GH_REPO && gh pr view 12',
    'GIT_DIR=/x/.git gh pr view 12',
  ];
  for (const command of cases) assert.deepEqual(rows(command), [], command);
  // A push git recorded in this folder, which each line below may not be the one that made it.
  const dir = pushRepo('feat/moved');
  sh(dir, 'git push -q origin HEAD');
  const pushes = [
    'git -c remote.origin.url=https://github.com/x/y push',
    'git --git-dir=/x/.git push',
    'git --work-tree=/x push origin feat',
    'git --config-env=remote.origin.url=V push',
    'GIT_DIR=/x/.git git push',
    'export GIT_DIR=/x/.git && git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=x git push',
  ];
  for (const command of pushes) assert.deepEqual(rows(command, { cwd: dir }), [], command);
  assert.deepEqual(rows('git --no-pager push origin HEAD', { cwd: dir }), [pushed('acme/notes', 'feat/moved', dir)], 'a switch that moves nothing');
  assert.deepEqual(rows(`gh pr create --body "$(cat <<'EOF'\nWhy\nEOF\n)" --title t`, { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [created('acme/widgets', 12)], 'the canonical heredoc body is quoted');
});

test('a bare owner/name in -R or GH_REPO records nothing while GH_HOST is set', () => {
  assert.deepEqual(rows('GH_HOST=ghe.example.test gh pr view 12 -R acme/other'), []);
  assert.deepEqual(rows('gh pr view 12 -R acme/other', {}, { GH_HOST: 'ghe.example.test' }), []);
  assert.deepEqual(rows('GH_HOST=ghe.example.test GH_REPO=acme/other gh pr view 12'), []);
  assert.deepEqual(rows('GH_HOST=ghe.example.test gh pr view 12 -R github.com/acme/other'), [touched('acme/other', { number: 12 })]);
  assert.deepEqual(rows('env -u GH_HOST gh pr view 12 -R acme/other', {}, { GH_HOST: 'ghe.example.test' }), [touched('acme/other', { number: 12 })]);
});

test('a folder or a branch holding a hidden character writes nothing', () => {
  assert.deepEqual(rows(`cd '${BIDI}' && gh pr view 3`), [], 'a bidi control in the folder');
  assert.deepEqual(rows('gh pr view \'feat‮x\''), [], 'a bidi control in a branch');
  assert.deepEqual(rows('gh pr view \'feat​x\''), [], 'a zero-width space in a branch');
  assert.deepEqual(rows(`gh pr view 'feat\u001b[2J'`), [], 'an escape in a branch');
});

// ledgerRows over a fake git: `remotes` by name and URL, the branch every folder is on, more config lines as
// `git config --get-regexp` prints them, and the git common dir every folder has, or none; its HEAD is PUSHED_HEAD.
// `calls` holds the folder of each git read.
function fakeGit(remotes, branch = 'feat', config = [], common = null) {
  const calls = [];
  const read = (args, folder) => {
    calls.push(folder);
    const lines = [...Object.entries(remotes).map(([name, url]) => `remote.${name}.url ${url}`), ...config];
    if (args[0] === 'config') return { status: 0, stdout: lines.join('\n') };
    if (args[0] === 'rev-parse' && common === null) return { status: 128, stdout: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: args[1] === 'HEAD' ? `${PUSHED_HEAD}\n` : `${common}\n` };
    return { status: 0, stdout: `${branch}\n` };
  };
  return { read, calls };
}
// A git common dir whose remote-tracking refs `refs`, each a path under refs/remotes/, a push updated to PUSHED_HEAD
// just now.
const PUSHED_HEAD = '1'.repeat(40);
let commons = 0;
function pushedCommon(refs) {
  commons += 1;
  const common = path.join(ROOT, `common-${commons}`);
  for (const ref of refs) {
    const file = path.join(common, 'logs/refs/remotes', ref);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${'0'.repeat(40)} ${PUSHED_HEAD} T <t@t.test> ${Math.floor(Date.now() / 1000)} +0000\tupdate by push\n`);
  }
  return common;
}
const unit = (command, cwd, read, output = null) =>
  ledgerRows({ command, cwd, output, forge: forgeFor(cwd), readers: { [githubCalls.FORGE]: githubCalls }, read, at: 'T' }).map(({ at, ...each }) => each);
const ORIGIN = { origin: 'https://github.com/acme/widgets.git' };

test('a row`s cwd is absolute within 1,024 bytes', () => {
  const at = `/${'a'.repeat(1023)}`;
  assert.deepEqual(unit('gh pr view 3', at, fakeGit(ORIGIN).read), [touched('acme/widgets', { number: 3 }, at)]);
  assert.deepEqual(unit('gh pr view 3', `/${'a'.repeat(1024)}`, fakeGit(ORIGIN).read), []);
});

test('one call has git read at most MAX_FOLDERS folders and writes at most MAX_ROWS rows', () => {
  const { read, calls } = fakeGit(ORIGIN, 'feat', [], pushedCommon(['origin/feat']));
  const many = Array.from({ length: 20 }, (_, at) => `git -C /w/${at} push origin feat`).join(' && ');
  const recorded = unit(many, '/w', read);
  assert.ok(new Set(calls).size <= MAX_FOLDERS, `${new Set(calls).size} folders`);
  assert.equal(recorded.length, MAX_FOLDERS);
  const common = pushedCommon(Array.from({ length: 40 }, (_, at) => `origin/b${at}`));
  assert.equal(unit('git push', '/w', fakeGit(ORIGIN, 'feat', [], common).read).length, MAX_ROWS);
});

test('the output tail keeps a first line the cut did not split', () => {
  const link = URL_OF('acme/widgets', 12);
  const whole = `${'x'.repeat(100)}\n${link}\n${'z'.repeat(OUTPUT_TAIL - link.length - 2)}\n`;
  assert.ok(outputTail(whole).startsWith(`${link}\n`));
  assert.deepEqual(unit('gh pr create --fill', '/w', fakeGit(ORIGIN).read, whole), [created('acme/widgets', 12, '/w')]);
  const split = `${'x'.repeat(100)}\n${link}${'z'.repeat(OUTPUT_TAIL - 2)}\nnext\n`;
  assert.equal(outputTail(split), 'next\n');
});

test('a remote git reads as a local path names no repository, so its calls and pushes record nothing', () => {
  // As remoteIdentity reads a remote: a `file:` URL with a host, and a drive path, are folders on disk too.
  for (const url of ['archive/widgets', 'file:///srv/acme/widgets', 'file://github.com/acme/widgets', 'C:\\srv\\widgets']) {
    assert.deepEqual(unit('gh pr view 3', '/w', fakeGit({ origin: url }).read), [], url);
    assert.deepEqual(unit('git push', '/w', fakeGit({ origin: url }, 'feat', [], pushedCommon(['origin/feat'])).read), [], url);
  }
  assert.deepEqual(unit('gh pr view 3', '/w', fakeGit({ origin: 'git@github.com:acme/widgets' }).read), [touched('acme/widgets', { number: 3 }, '/w')], 'git`s host:path form');
});

test('a push URL, when set, is the push`s repository alone: one that names none records nothing', () => {
  const push = (pushUrls) => unit('git push', '/w', fakeGit(ORIGIN, 'feat', pushUrls.map(([name, url]) => `remote.${name}.pushurl ${url}`), pushedCommon(['origin/feat'])).read);
  assert.deepEqual(push([['origin', 'git@github.com:me/widgets.git']]), [pushed('me/widgets', 'feat', '/w')], 'a push URL on the fork records the fork');
  assert.deepEqual(push([]), [pushed('acme/widgets', 'feat', '/w')], 'no push URL: the fetch URL');
  for (const url of ['/srv/git/widgets', 'file:///srv/git/widgets', 'DISABLED', `https://github.com/me/${'w'.repeat(1100)}`]) assert.deepEqual(push([['origin', url]]), [], url.slice(0, 40));
  assert.deepEqual(push([['origin', 'DISABLED'], ['origin', 'git@github.com:me/widgets.git']]), [], 'a later push URL never replaces an unreadable first one');
  assert.deepEqual(push([['origin', 'git@github.com:me/widgets.git'], ['origin', 'git@github.com:other/widgets.git']]), [pushed('me/widgets', 'feat', '/w')], 'the first push URL');
  assert.deepEqual(unit('gh pr view 3', '/w', fakeGit(ORIGIN, 'feat', ['remote.origin.pushurl git@github.com:me/widgets.git']).read), [touched('acme/widgets', { number: 3 }, '/w')], 'a gh call still reads the fetch URL');
});

test('a gh pr call with no target records the pull request gh checked out, and an owner:branch target its head`s fork', () => {
  const read = fakeGit(ORIGIN, 'feat', ['branch.feat.merge refs/pull/42/head']).read;
  assert.deepEqual(unit('gh pr view', '/w', read), [touched('acme/widgets', { number: 42 }, '/w')], 'branch.feat.merge refs/pull/42/head, as gh pr checkout sets it');
  assert.deepEqual(unit('gh pr view', '/w', fakeGit(ORIGIN, 'feat', ['branch.feat.merge refs/heads/feat']).read), [touched('acme/widgets', { branch: 'feat' }, '/w')]);
  assert.deepEqual(unit('gh pr view feat', '/w', read), [touched('acme/widgets', { branch: 'feat' }, '/w')], 'a branch named: gh looks the branch up');
  assert.deepEqual(unit('gh pr checks me:fix/x', '/w', fakeGit(ORIGIN).read), [touched('me/widgets', { branch: 'fix/x' }, '/w')], 'owner:branch');
  assert.deepEqual(unit('gh pr checks me:fix/x -R acme/other', '/w', fakeGit(ORIGIN).read), [touched('me/other', { branch: 'fix/x' }, '/w')]);
  for (const word of ['bad--owner:fix', 'me:/fix', 'me:a:b', 'git@github.com:acme/widgets']) assert.deepEqual(unit(`gh pr view '${word}'`, '/w', fakeGit(ORIGIN).read), [], word);
});

test('a gh pr call with no target records nothing when a later command on the line moves HEAD', () => {
  const { read } = fakeGit(ORIGIN);
  for (const after of ['git switch main', 'git checkout main', 'git -C /w worktree add ../x main']) assert.deepEqual(unit(`gh pr view && ${after}`, '/w', read), [], after);
  assert.deepEqual(unit('git switch feat && gh pr view', '/w', read), [touched('acme/widgets', { branch: 'feat' }, '/w')], 'a move before it');
  assert.deepEqual(unit('gh pr view 3 && git switch main', '/w', read), [touched('acme/widgets', { number: 3 }, '/w')], 'a target');
});

test('a line that reads a shell file into the shell, or runs cd through builtin, records nothing', () => {
  assert.deepEqual(rows('source ./env.sh && gh pr view 12'), []);
  assert.deepEqual(rows('. ./env.sh; gh pr view 12'), []);
  assert.deepEqual(rows('builtin source ./env.sh && gh pr view 12'), []);
  assert.deepEqual(rows(`builtin cd ${OTHER} && gh pr view 12`), [], 'the payload folder may be the one the line ended in');
  assert.deepEqual(rows(`gh pr view 12 && builtin pushd ${OTHER}`), []);
});

test('a line of thousands of gh calls is read in linear time', () => {
  // 8,000 calls: about 60 ms read in one pass, about 5 s if each call were checked against every other.
  const line = Array.from({ length: 8000 }, (_, at) => `gh pr view ${at + 1}`).join('; ');
  const started = Date.now();
  const recorded = unit(line, '/w', fakeGit(ORIGIN).read);
  const took = Date.now() - started;
  assert.equal(recorded.length, MAX_ROWS);
  assert.ok(took < 2000, `${took} ms`);
});

test('the ledger takes no row for a folder that is not on disk, and keeps its newest rows past the cap', { skip: !POSIX }, () => {
  const state = path.join(ROOT, 'unit-state');
  const folder = sessionFolder(state, 'unit-ledger', { checkouts: [] });
  const file = path.join(folder, 'prs.jsonl');
  const make = (branch, cwd = ROOT) => ({ at: 'T', agentId: null, kind: 'pushed', forge: 'github', host: 'github.com', path: 'acme/widgets', number: null, branch, cwd });
  assert.equal(appendLedger(folder, [make('gone', path.join(ROOT, 'no-such-folder'))]), false);
  assert.equal(existsSync(file), false);
  const bytes = (row) => Buffer.byteLength(`${JSON.stringify(row)}\n`);
  const size = () => (existsSync(file) ? statSync(file).size : 0);
  let index = 0;
  // Old rows up to the cap, each appended in place; the newest, longer than any of them, then passes it.
  while (size() + bytes(make(`old-${index}`)) <= LEDGER_MAX_BYTES) {
    assert.equal(appendLedger(folder, [make(`old-${index}`)]), true);
    index += 1;
  }
  assert.ok(size() + bytes(make('newest-row-x')) > LEDGER_MAX_BYTES);
  assert.equal(appendLedger(folder, [make('newest-row-x')]), true);
  const branches = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch);
  assert.ok(statSync(file).size <= LEDGER_MAX_BYTES, `${statSync(file).size} bytes`);
  assert.equal(branches.at(-1), 'newest-row-x');
  assert.equal(branches.at(-2), `old-${index - 1}`, 'the newest old rows stay');
  assert.ok(!branches.includes('old-0'), 'the oldest go');
  assert.ok(statSync(file).size <= LEDGER_MAX_BYTES / 2 + 1024, 'compacted to about half the cap');
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a ledger two racing appends pushed past the cap is compacted on the next write, not left unwritable', { skip: !POSIX }, () => {
  const folder = sessionFolder(path.join(ROOT, 'unit-state'), 'unit-over-cap', { checkouts: [] });
  const file = path.join(folder, 'prs.jsonl');
  const make = (branch) => ({ at: 'T', agentId: null, kind: 'pushed', forge: 'github', host: 'github.com', path: 'acme/widgets', number: null, branch, cwd: ROOT });
  const line = (branch) => `${JSON.stringify(make(branch))}\n`;
  let text = '';
  for (let index = 0; Buffer.byteLength(text) < LEDGER_MAX_BYTES + 300; index += 1) text += line(`old-${index}`);
  // Cut to exactly 300 bytes past the cap, so the tail read starts inside a line.
  text = text.slice(Buffer.byteLength(text) - LEDGER_MAX_BYTES - 300);
  writeFileSync(file, text, { mode: 0o600 });
  assert.equal(statSync(file).size, LEDGER_MAX_BYTES + 300);
  assert.equal(appendLedger(folder, [make('after-the-race')]), true, 'the over-cap ledger takes the row');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((each) => JSON.parse(each));
  assert.equal(rows.at(-1).branch, 'after-the-race', 'the row reads back');
  assert.ok(statSync(file).size <= LEDGER_MAX_BYTES, `${statSync(file).size} bytes`);
});

// The code of a file, without its comment lines and its text after ` // `.
const code = (text) => text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');
const FORGE_WORDS = /github|gitlab|graphql|statusCheckRollup|['"`]gh['"`]/iu;

test('the forge seam: session-prs.mjs and the hook name no forge; the gh reading sits in the forge-keyed rule', () => {
  for (const file of ['lib/session-prs.mjs', 'lib/git-push.mjs']) assert.doesNotMatch(code(readFileSync(path.join(PLUGIN, file), 'utf8')), FORGE_WORDS, file);
  // The hook names the rule's module path to load it, and nothing else of a forge.
  const hook = code(readFileSync(HOOK, 'utf8')).replace(/import\('\.\.\/lib\/rules\/[\w-]+\/session-calls\.mjs'\)/gu, '');
  assert.doesNotMatch(hook, FORGE_WORDS);
  const rule = readFileSync(path.join(PLUGIN, 'lib/rules/github/session-calls.mjs'), 'utf8');
  assert.match(rule, /GH_REPO/u);
  assert.doesNotMatch(code(rule), /\b(?:spawn|spawnSync|execFile|execSync|runGit|runGh|forgeFor)\(/u, 'the rule runs nothing');
});

test('the PostToolUse Bash group comes last in hooks.json, so the tracker hooks keep their trust keys', () => {
  const { hooks } = JSON.parse(readFileSync(path.join(PLUGIN, 'hooks/hooks.json'), 'utf8'));
  const last = hooks.PostToolUse.at(-1);
  assert.equal(last.matcher, 'Bash');
  assert.deepEqual(last.hooks.map(({ command }) => command), ['node "$CLAUDE_PLUGIN_ROOT/scripts/hook-bash-post.mjs"']);
  assert.ok(!JSON.stringify(hooks.PostToolUseFailure ?? []).includes('hook-bash-post.mjs'), 'no row for a call that failed');
});

// A project checkout with one commit and a worktree of `branch`, under `parent` (a folder that may be reached by a
// symlink), whose origin is `origin` or none. `listed` is the worktree's path as `git worktree list` prints it.
let worktreeRepos = 0;
function worktreeRepo(branch, { origin = 'git@github.com:acme/widgets.git', parent = ROOT } = {}) {
  worktreeRepos += 1;
  const dir = path.join(parent, `wt-${worktreeRepos}`);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const env = { ...ENV, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => {
    const ran = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    assert.equal(ran.status, 0, `${args.join(' ')}: ${ran.stderr}`);
    return ran.stdout;
  };
  git('init', '-q', '-b', 'main');
  if (origin) git('remote', 'add', 'origin', origin);
  git('add', '.');
  git('commit', '-q', '-m', 'start');
  git('worktree', 'add', '-q', '-b', branch, path.join(parent, `wt-${worktreeRepos}-tree`));
  const listed = git('worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))[1];
  return { dir, listed };
}

// The rows the hook appended to the session's links.jsonl for `command` run in `cwd`.
function linkRows(command, cwd, session = nextSession()) {
  runHook(payload(command, { cwd, session }));
  const projects = path.join(STATE, 'aidrian/projects');
  return readdirSync(projects).map((id) => path.join(projects, id, 'sessions', session, 'links.jsonl')).filter((file) => existsSync(file))
    .flatMap((file) => readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)));
}

test('aidrian worktree new records one links row under the payload`s session: its branch, git`s path, and origin', { skip: !POSIX }, () => {
  const { dir, listed } = worktreeRepo('feat/wt');
  const [only, ...more] = linkRows('aidrian worktree new feat/wt', dir);
  assert.deepEqual(more, []);
  assert.deepEqual({ ...only, at: 'x' }, { at: 'x', kind: 'worktree', host: 'github.com', path: 'acme/widgets', branch: 'feat/wt', cwd: listed });
  assert.deepEqual(linkRows('cd /tmp && aidrian worktree new feat/wt --base origin/main', dir).length, 1);
  const none = worktreeRepo('feat/no-origin', { origin: null });
  assert.deepEqual(linkRows('aidrian worktree new feat/no-origin', none.dir).map(({ host, path: repo }) => [host, repo]), [[null, null]]);
});

test('a shell-filled branch, an option, --plan, or a branch git lists no worktree for records no links row', { skip: !POSIX }, () => {
  const { dir } = worktreeRepo('feat/quiet');
  for (const command of ['aidrian worktree new "$B"', 'aidrian worktree new -x', 'aidrian worktree new feat/quiet --plan', 'aidrian worktree new feat/never']) {
    assert.deepEqual(linkRows(command, dir), [], command);
  }
});

test('in a checkout under a symlinked folder, the row`s cwd is the path git worktree list prints', { skip: !POSIX }, () => {
  const real = path.join(ROOT, 'real-parent');
  mkdirSync(real);
  const linked = path.join(ROOT, 'linked-parent');
  symlinkSync(real, linked);
  const { dir, listed } = worktreeRepo('feat/linked', { parent: linked });
  const [row] = linkRows('aidrian worktree new feat/linked', dir);
  assert.equal(row.cwd, listed);
});
