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

test('gh pr create records the pull request its stdout links, with the forge id, host, and path, and no raw URL, command, or output', () => {
  const recorded = rows('gh pr create --title "Add x" --body "Why"', { stdout: `${URL_OF('acme/widgets', 12)}\n` });
  assert.deepEqual(recorded, [created('acme/widgets', 12)]);
  assert.deepEqual(Object.keys(recorded[0]), ['agentId', 'kind', 'forge', 'host', 'path', 'number', 'branch', 'cwd']);
});

test('a created row comes only from a line that is exactly a pull request URL of a remote of the call`s folder', () => {
  const echoed = rows(`gh pr create --fill && echo ${URL_OF('other/repo', 9)}`, { stdout: `${URL_OF('acme/widgets', 12)}\n${URL_OF('other/repo', 9)}\n` });
  assert.deepEqual(echoed, [created('acme/widgets', 12)], 'other/repo is no remote of the folder');
  assert.deepEqual(rows('gh pr create --fill', { stdout: `see ${URL_OF('acme/widgets', 12)}\n${URL_OF('acme/widgets', 13)}/files\n` }), []);
  assert.deepEqual(rows('gh pr create --fill', { stdout: 'https://gitlab.com/acme/widgets/pull/4\nhttps://git.example.test/acme/widgets/pull/5\n' }), []);
  assert.deepEqual(rows('gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\r\n` }), [created('acme/widgets', 12)]);
  assert.deepEqual(rows(`echo ${URL_OF('acme/widgets', 12)}`, { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [], 'output is read only for gh pr create');
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
  for (const response of [null, 'text', { stdout: 7 }, []]) {
    assert.deepEqual(rows('gh pr create --fill && git push origin feat/ledger', { response }), [pushed('acme/widgets', 'feat/ledger')], JSON.stringify(response));
  }
});

test('git push records the branch of each refspec on the repository of the remote it names', () => {
  const cases = [
    ['git push origin feat/a', [pushed('acme/widgets', 'feat/a')]],
    ['git push', [pushed('acme/widgets', 'feat/ledger')]],
    ['git push -u origin HEAD', [pushed('acme/widgets', 'feat/ledger')]],
    ['git push origin @', [pushed('acme/widgets', 'feat/ledger')]],
    ['git push origin +feat:refs/heads/review', [pushed('acme/widgets', 'review')]],
    ['git push origin feat/a feat/b', [pushed('acme/widgets', 'feat/a'), pushed('acme/widgets', 'feat/b')]],
    ['git push origin refs/heads/feat/c', [pushed('acme/widgets', 'feat/c')]],
    ['git push --force-with-lease origin HEAD:feat/d', [pushed('acme/widgets', 'feat/d')]],
    [`git push ${'https://github.com/other/repo'} feat`, [pushed('other/repo', 'feat')]],
    ['git push git@github.com:other/repo.git feat', [pushed('other/repo', 'feat')]],
    ['git push origin feat/a || true', [pushed('acme/widgets', 'feat/a')]],
    ['git push origin :feat', []],
    ['git push origin --delete feat', []],
    ['git push -d origin feat', []],
    ['git push origin v1:refs/tags/v1', []],
    ['git push origin refs/tags/v1', []],
    ['git push --dry-run origin feat', []],
    ['git push --tags', []],
    ['git push "$REMOTE" feat', []],
    ['git push origin "$BRANCH"', []],
    ['git push -- -x feat', []],
    ['git push nowhere feat', []],
    ['git push https://github.com/a/b/c feat', [], 'three path parts'],
    [`git push origin ${'b'.repeat(300)}`, [], 'a refspec of 300 bytes'],
    ['git push origin a..b', []],
  ];
  for (const [command, expected, why] of cases) assert.deepEqual(rows(command), expected, why ?? command);
});

test('a push in a fork checkout records the remote it names, origin when it names none', () => {
  assert.deepEqual(rows('git push', { cwd: FORK }), [pushed('me/widgets', 'fix/fork', FORK)]);
  assert.deepEqual(rows('git push upstream fix/fork', { cwd: FORK }), [pushed('acme/widgets', 'fix/fork', FORK)]);
});

test('a push records the folder it ran in: git -C, then a cd before it on the line, else the payload folder', () => {
  assert.deepEqual(rows(`git -C ${OTHER} push`), [pushed('acme/other', 'main', OTHER)]);
  assert.deepEqual(rows(`cd ${OTHER} && npm test && git push`), [pushed('acme/other', 'main', OTHER)]);
  assert.deepEqual(rows('git -C "$W" push'), []);
  assert.deepEqual(rows('cd "$W" && git push'), []);
});

test('a row is recorded only for a host the forge adapter declares', () => {
  assert.deepEqual(rows('git push origin feat', { cwd: GITLAB }), [], 'gitlab.com');
  assert.deepEqual(rows('git push made feat', { cwd: GITLAB }), [], 'a made-up host');
  assert.deepEqual(rows('git push https://gitlab.com/acme/widgets feat'), []);
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
  const recorded = rows('git push origin feat', { extra: { agent_id: 'a1b2c3d4', agent_type: 'aidrian:harness-mechanic' } });
  assert.deepEqual(recorded, [{ ...pushed('acme/widgets', 'feat'), agentId: 'a1b2c3d4' }]);
  assert.deepEqual(rows('git push origin feat', { extra: { agent_id: '../x y' } }), [pushed('acme/widgets', 'feat')], 'an id of another shape is left out');
});

test('nothing is written for an interrupted call, a bad session id, a folder with no project, or input the hook cannot read', () => {
  assert.deepEqual(rows('git push origin feat', { response: { stdout: '', stderr: '', interrupted: true } }), []);
  for (const session of ['../x', 'a/b', '', 'x'.repeat(129)]) {
    runHook(payload('git push origin feat', { session }));
  }
  runHook({ ...payload('git push origin feat'), session_id: undefined });
  assert.deepEqual(rows('git push origin feat', { cwd: NO_PROJECT }), []);
  for (const input of ['', 'not json', '[]', '{"tool_input":{"command":7}}']) runHook(input);
  const projects = path.join(STATE, 'aidrian/projects');
  const files = existsSync(projects) ? readdirSync(projects).flatMap((id) => (existsSync(path.join(projects, id, 'sessions')) ? readdirSync(path.join(projects, id, 'sessions')) : [])) : [];
  assert.deepEqual(files.filter((name) => !/^session-\d+$/u.test(name)), [], 'no folder for a session id that fails SESSION_ID');
});

test('the session folder is 0700 and prs.jsonl 0600, appended line by line', { skip: !POSIX }, () => {
  const session = nextSession();
  runHook(payload('git push origin feat/a', { session }));
  runHook(payload('git push origin feat/b', { session }));
  const [file] = ledgerFiles(session);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch), ['feat/a', 'feat/b']);
});

// The session folder of `session` under the project of OWN, made by a first call.
function ownFolder(session) {
  runHook(payload('git push origin first', { session }));
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
  runHook(payload('git push origin feat', { session }));
  assert.equal(readFileSync(outside, 'utf8'), 'kept\n');
});

test('a symlink at prs.jsonl receives no write: the ledger opens no-follow', { skip: !POSIX }, () => {
  const outside = outsideFile('outside-symlink.txt');
  const session = nextSession();
  const folder = ownFolder(session);
  rmSync(path.join(folder, 'prs.jsonl'));
  symlinkSync(outside, path.join(folder, 'prs.jsonl'));
  runHook(payload('git push origin feat', { session }));
  assert.equal(readFileSync(outside, 'utf8'), 'kept\n');
  assert.equal(statSync(outside).nlink, 1);
});

test('a ledger another user may read receives no write: it must be 0600', { skip: !POSIX }, () => {
  const session = nextSession();
  const folder = ownFolder(session);
  const file = path.join(folder, 'prs.jsonl');
  const before = readFileSync(file, 'utf8');
  chmodSync(file, 0o644);
  runHook(payload('git push origin feat', { session }));
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('a symlinked session folder receives no write', { skip: !POSIX }, () => {
  const folder = ownFolder(nextSession());
  const moved = nextSession();
  const target = path.join(ROOT, 'elsewhere');
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, path.join(path.dirname(folder), moved));
  runHook(payload('git push origin feat', { session: moved }));
  assert.deepEqual(readdirSync(target), []);
  assert.ok(lstatSync(path.join(path.dirname(folder), moved)).isSymbolicLink());
});

test('a ledger at its cap is compacted, so the newest row shows and the file stays within the cap', { skip: !POSIX }, () => {
  const session = nextSession();
  const file = path.join(ownFolder(session), 'prs.jsonl');
  appendFileSync(file, `${' '.repeat(LEDGER_MAX_BYTES - statSync(file).size - 10)}\n`);
  runHook(payload('git push origin feat/newest', { session }));
  assert.ok(statSync(file).size <= LEDGER_MAX_BYTES);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line).branch), ['first', 'feat/newest']);
});

test('the same call made again adds no row', { skip: !POSIX }, () => {
  const session = nextSession();
  const file = path.join(ownFolder(session), 'prs.jsonl');
  runHook(payload('git push origin feat', { session }));
  const size = statSync(file).size;
  for (let at = 0; at < 3; at += 1) runHook(payload('git push origin feat', { session }));
  assert.equal(statSync(file).size, size);
});

test('creating a session folder sweeps the folders untouched for 30 days', { skip: !POSIX }, () => {
  const old = nextSession();
  const folder = ownFolder(old);
  const then = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  utimesSync(path.join(folder, 'prs.jsonl'), then, then);
  utimesSync(folder, then, then);
  runHook(payload('git push origin feat', { session: nextSession() }));
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

// A checkout whose origin fetches from the parent and pushes to the fork, and one whose folder name holds a bidi control.
const PUSH_URL = checkout('push-url', { origin: 'https://github.com/acme/widgets.git' }, 'feat/push');
assert.equal(spawnSync('git', ['config', 'remote.origin.pushurl', 'git@github.com:me/widgets.git'], { cwd: PUSH_URL, env: ENV }).status, 0);
const BIDI = checkout('bidi‮own', { origin: 'https://github.com/acme/widgets.git' });
mkdirSync(path.join(OWN, 'sub'), { recursive: true });

test('the folder of a call comes from an absolute cd, git -C, or env -C, and the payload folder only on a line that changes no directory', () => {
  assert.deepEqual(rows('cd sub && gh pr create --fill', { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [], 'a relative cd');
  assert.deepEqual(rows(`cd ${OTHER} && git push`), [pushed('acme/other', 'main', OTHER)]);
  assert.deepEqual(rows(`git push && cd ${OTHER}`), [], 'the payload folder may be the one the line ended in');
  assert.deepEqual(rows(`cd ${OTHER}; git push`), [], 'a cd that is no leading cd with &&');
  assert.deepEqual(rows('git push'), [pushed('acme/widgets', 'feat/ledger')]);
  assert.deepEqual(rows('git -C sub push'), [], 'a relative git -C');
  assert.deepEqual(rows(`env -C ${OTHER} git push`), [pushed('acme/other', 'main', OTHER)]);
  assert.deepEqual(rows("bash -c 'cd sub && git push'"), [], 'a relative cd in a shell the line runs');
  assert.deepEqual(rows('echo "$(pwd)" && git push'), [pushed('acme/widgets', 'feat/ledger')]);
});

test('a call whose repository or config the line may move records nothing', () => {
  const cases = [
    'gh pr view 12 --json $FIELDS',
    'export GH_REPO=acme/other; gh pr view 12',
    'GH_REPO=acme/other; gh pr view 12',
    'unset GH_REPO && gh pr view 12',
    'git -c remote.origin.url=https://github.com/x/y push',
    'git --git-dir=/x/.git push',
    'git --work-tree=/x push origin feat',
    'git --config-env=remote.origin.url=V push',
    'GIT_DIR=/x/.git git push',
    'export GIT_DIR=/x/.git && git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.url GIT_CONFIG_VALUE_0=x git push',
    'GIT_DIR=/x/.git gh pr view 12',
    'git push --repo "$R"',
    'git push --repo $R feat',
  ];
  for (const command of cases) assert.deepEqual(rows(command), [], command);
  assert.deepEqual(rows('git --no-pager push origin feat'), [pushed('acme/widgets', 'feat')], 'a switch that moves nothing');
  assert.deepEqual(rows(`gh pr create --body "$(cat <<'EOF'\nWhy\nEOF\n)" --title t`, { stdout: `${URL_OF('acme/widgets', 12)}\n` }), [created('acme/widgets', 12)], 'the canonical heredoc body is quoted');
});

test('a push reads the remote`s push URL before its URL', () => {
  assert.deepEqual(rows('git push', { cwd: PUSH_URL }), [pushed('me/widgets', 'feat/push', PUSH_URL)]);
  assert.deepEqual(rows('gh pr view 3', { cwd: PUSH_URL }), [touched('acme/widgets', { number: 3 }, PUSH_URL)], 'gh reads the fetch URL');
});

test('a bare owner/name in -R or GH_REPO records nothing while GH_HOST is set', () => {
  assert.deepEqual(rows('GH_HOST=ghe.example.test gh pr view 12 -R acme/other'), []);
  assert.deepEqual(rows('gh pr view 12 -R acme/other', {}, { GH_HOST: 'ghe.example.test' }), []);
  assert.deepEqual(rows('GH_HOST=ghe.example.test GH_REPO=acme/other gh pr view 12'), []);
  assert.deepEqual(rows('GH_HOST=ghe.example.test gh pr view 12 -R github.com/acme/other'), [touched('acme/other', { number: 12 })]);
  assert.deepEqual(rows('env -u GH_HOST gh pr view 12 -R acme/other', {}, { GH_HOST: 'ghe.example.test' }), [touched('acme/other', { number: 12 })]);
});

test('a folder or a branch holding a hidden character writes nothing', () => {
  assert.deepEqual(rows(`cd '${BIDI}' && git push`), [], 'a bidi control in the folder');
  assert.deepEqual(rows('git push origin \'feat‮x\''), [], 'a bidi control in a refspec');
  assert.deepEqual(rows('git push origin \'feat​x\''), [], 'a zero-width space in a refspec');
  assert.deepEqual(rows(`git push origin 'feat\u001b[2J'`), [], 'an escape in a refspec');
});

// ledgerRows over a fake git: `remotes` by name and URL, and the branch every folder is on. `calls` holds the folder of
// each git read.
function fakeGit(remotes, branch = 'feat', pushUrls = []) {
  const calls = [];
  const read = (args, folder) => {
    calls.push(folder);
    const lines = [...Object.entries(remotes).map(([name, url]) => `remote.${name}.url ${url}`), ...pushUrls.map(([name, url]) => `remote.${name}.pushurl ${url}`)];
    if (args[0] === 'config') return { status: 0, stdout: lines.join('\n') };
    return { status: 0, stdout: `${branch}\n` };
  };
  return { read, calls };
}
const unit = (command, cwd, read, output = null) =>
  ledgerRows({ command, cwd, output, forge: forgeFor(cwd), readers: { [githubCalls.FORGE]: githubCalls }, read, at: 'T' }).map(({ at, ...each }) => each);
const ORIGIN = { origin: 'https://github.com/acme/widgets.git' };

test('a row`s cwd is absolute within 1,024 bytes', () => {
  const at = `/${'a'.repeat(1023)}`;
  assert.deepEqual(unit('git push', at, fakeGit(ORIGIN).read), [pushed('acme/widgets', 'feat', at)]);
  assert.deepEqual(unit('git push', `/${'a'.repeat(1024)}`, fakeGit(ORIGIN).read), []);
});

test('a remote word that starts with - records nothing, even where a remote has that name', () => {
  const { read } = fakeGit({ ...ORIGIN, '-x': 'https://github.com/acme/dash.git' });
  assert.deepEqual(unit('git push -- -x feat', '/w', read), []);
  assert.deepEqual(unit('git push -- origin feat', '/w', read), [pushed('acme/widgets', 'feat', '/w')]);
});

test('one call has git read at most MAX_FOLDERS folders and writes at most MAX_ROWS rows', () => {
  const { read, calls } = fakeGit(ORIGIN);
  const many = Array.from({ length: 20 }, (_, at) => `git -C /w/${at} push origin feat`).join(' && ');
  const recorded = unit(many, '/w', read);
  assert.ok(new Set(calls).size <= MAX_FOLDERS, `${new Set(calls).size} folders`);
  assert.equal(recorded.length, MAX_FOLDERS);
  const branches = Array.from({ length: 40 }, (_, at) => `b${at}`).join(' ');
  assert.equal(unit(`git push origin ${branches}`, '/w', fakeGit(ORIGIN).read).length, MAX_ROWS);
});

test('the output tail keeps a first line the cut did not split', () => {
  const link = URL_OF('acme/widgets', 12);
  const whole = `${'x'.repeat(100)}\n${link}\n${'z'.repeat(OUTPUT_TAIL - link.length - 2)}\n`;
  assert.ok(outputTail(whole).startsWith(`${link}\n`));
  assert.deepEqual(unit('gh pr create --fill', '/w', fakeGit(ORIGIN).read, whole), [created('acme/widgets', 12, '/w')]);
  const split = `${'x'.repeat(100)}\n${link}${'z'.repeat(OUTPUT_TAIL - 2)}\nnext\n`;
  assert.equal(outputTail(split), 'next\n');
});

test('a push URL, when set, is the push`s repository alone: one that names none records nothing', () => {
  const push = (pushUrls) => unit('git push', '/w', fakeGit(ORIGIN, 'feat', pushUrls).read);
  assert.deepEqual(push([['origin', 'git@github.com:me/widgets.git']]), [pushed('me/widgets', 'feat', '/w')]);
  for (const url of ['/srv/git/widgets', 'file:///srv/git/widgets', 'DISABLED', `https://github.com/me/${'w'.repeat(1100)}`]) assert.deepEqual(push([['origin', url]]), [], url.slice(0, 40));
  assert.deepEqual(push([['origin', 'DISABLED'], ['origin', 'git@github.com:me/widgets.git']]), [], 'a later push URL never replaces an unreadable first one');
  assert.deepEqual(push([['origin', 'git@github.com:me/widgets.git'], ['origin', 'git@github.com:other/widgets.git']]), [pushed('me/widgets', 'feat', '/w')], 'the first push URL');
});

test('a --repo value the shell fills in records nothing, even where a remote has that name', () => {
  const { read } = fakeGit({ ...ORIGIN, $R: 'https://github.com/acme/dollar.git' });
  assert.deepEqual(unit('git push --repo "$R"', '/w', read), []);
  assert.deepEqual(unit('git push --repo "$R" feat', '/w', read), []);
  assert.deepEqual(unit('git push --repo=origin', '/w', read), [pushed('acme/widgets', 'feat', '/w')]);
  assert.deepEqual(unit('git push --repo=origin feat', '/w', read), [], 'git takes a positional word over --repo: feat is the repository');
});

test('a line that reads a shell file into the shell, or runs cd through builtin, records nothing', () => {
  assert.deepEqual(rows('source ./env.sh && gh pr view 12'), []);
  assert.deepEqual(rows('. ./env.sh; gh pr view 12'), []);
  assert.deepEqual(rows('builtin source ./env.sh && git push origin feat'), []);
  assert.deepEqual(rows(`builtin cd ${OTHER} && git push`), [], 'the payload folder may be the one the line ended in');
  assert.deepEqual(rows(`git push && builtin pushd ${OTHER}`), []);
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
