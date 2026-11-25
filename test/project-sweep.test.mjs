// The driver's sweep of ended attempts (lib/project-start.mjs sweepAttempts): it never removes a clone that holds work
// the forge does not have, and it removes the host files that kept a session's forge token once that session ended.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { forgetEnvFiles, sessionEnvFile } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import { attemptFolder, cloneHeads, sweepAttempts, unpushedHead } from '../plugins/aidrian/lib/project-start.mjs';
import { recordTokenFile, TOKEN_FILES, tokenRecordThere } from '../plugins/aidrian/lib/project-token.mjs';
import { DRIVER, runFixture, STARTED } from './project-start-fixture.mjs';

const CHILD = STARTED[0].session;
const BRANCH = 'feat/eng-1-export';

// A started attempt of ENG-1 whose session the host now lists as done, and the clone's git in `work`.
function ended(t) {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const folder = attemptFolder(fx.state, 'launch', 'ENG-1', 1);
  const work = path.join(folder, 'work');
  const git = (...args) => execFileSync('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { env: fx.env, encoding: 'utf8' }).trim();
  return { fx, folder, work, git, end: () => { fx.claude.states[CHILD] = 'done'; } };
}

test('an ended attempt whose clone holds a commit it never pushed keeps its folder, with a kept row and a line naming it', (t) => {
  const { fx, folder, work, git, end } = ended(t);
  git('commit', '-q', '--allow-empty', '-m', 'work the session never pushed');
  const head = git('rev-parse', 'HEAD');
  end();
  const { out } = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.deepEqual(out, [
    'ended ENG-1 no_result -> open',
    `kept ENG-1 attempt 1: its clone holds ${head.slice(0, 12)}, a commit the forge does not have, so its folder stays for the run's life; recover the work from ${work}`,
    'idle',
  ]);
  assert.equal(git('rev-parse', 'HEAD'), head, 'the commit is still there');
  const kept = fx.rows().filter((row) => row.event === 'kept');
  assert.deepEqual(kept.map(({ key, attempt, head: at }) => ({ key, attempt, head: at })), [{ key: 'ENG-1', attempt: 1, head }]);
  // A later wait asks the forge nothing more of it, and the folder stays.
  const asked = fx.forge.calls.filter(([kind]) => kind === 'hasCommit').length;
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['idle']);
  assert.equal(fx.forge.calls.filter(([kind]) => kind === 'hasCommit').length, asked);
  assert.ok(existsSync(folder));
  assert.equal(fx.rows().filter((row) => row.event === 'kept').length, 1, 'one row');
});

test('an ended attempt whose work the forge holds is swept as before', (t) => {
  const { fx, folder, git, end } = ended(t);
  git('commit', '-q', '--allow-empty', '-m', 'pushed work');
  git('push', '-q', fx.bare, `HEAD:refs/heads/${BRANCH}`);
  end();
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
  assert.equal(existsSync(folder), false);
  assert.equal(fx.rows().filter((row) => row.event === 'kept').length, 0);
  assert.ok(fx.forge.calls.some(([kind, repo, , options]) => kind === 'hasCommit' && repo === 'acme/widgets' && options.host === 'github.com'), 'asked of the pinned repository');
});

test('a forge that cannot answer whether it holds the work leaves the folder for the next wait', (t) => {
  const { fx, folder, git, end } = ended(t);
  git('commit', '-q', '--allow-empty', '-m', 'work');
  end();
  const has = fx.forge.hasCommit;
  fx.forge.hasCommit = () => {
    throw new Error('gh: HTTP 502');
  };
  assert.deepEqual(fx.cmd(['wait', 'launch', '--max-wait', '0']).out, ['ended ENG-1 no_result -> open', 'idle']);
  assert.ok(existsSync(folder), 'kept while the forge cannot tell');
  assert.equal(fx.rows().filter((row) => row.event === 'kept').length, 0, 'and no row yet');
  fx.forge.hasCommit = has;
  assert.match(fx.cmd(['wait', 'launch', '--max-wait', '0']).out[0], /^kept ENG-1 attempt 1: its clone holds [0-9a-f]{12}, a commit the forge does not have/u);
});

test('the clone\'s refs are read as files: a detached HEAD, a packed branch, and a ref the read cannot trust', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-heads-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
  const at = (name, text) => {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), text);
  };
  assert.deepEqual(cloneHeads(path.join(dir, 'none'), BRANCH), { heads: [] }, 'no git folder, no work');
  at(`refs/heads/${BRANCH}`, `${a}\n`);
  assert.deepEqual(cloneHeads(dir, BRANCH), { problem: 'HEAD is missing' }, 'a git folder whose HEAD is gone may still hold the branch');
  rmSync(path.join(dir, 'refs'), { recursive: true });
  at('HEAD', `ref: refs/heads/${BRANCH}\n`);
  assert.deepEqual(cloneHeads(dir, BRANCH), { heads: [] }, 'a branch not born yet');
  at('packed-refs', `# pack-refs with: peeled fully-peeled sorted\n${b} refs/heads/${BRANCH}\n^${a}\n`);
  assert.deepEqual(cloneHeads(dir, BRANCH), { heads: [b] });
  at(`refs/heads/${BRANCH}`, `${a}\n`);
  assert.deepEqual(cloneHeads(dir, BRANCH), { heads: [a] }, 'a loose ref wins over the packed one');
  at('HEAD', `${b}\n`);
  assert.deepEqual(cloneHeads(dir, BRANCH), { heads: [b, a] }, 'a detached HEAD and the issue branch');
  at('HEAD', 'ref: refs/heads/../../../etc/passwd\n');
  assert.match(cloneHeads(dir, BRANCH).problem, /is not a branch's ref name/u);
  rmSync(path.join(dir, 'HEAD'));
  symlinkSync(path.join(dir, 'packed-refs'), path.join(dir, 'HEAD'));
  assert.match(cloneHeads(dir, BRANCH).problem, /^HEAD cannot be read/u, 'a link is never followed');
  // Nor a link at a folder on the way to a ref: refs/heads leading elsewhere is no ref of the clone.
  rmSync(path.join(dir, 'HEAD'));
  at('HEAD', `ref: refs/heads/${BRANCH}\n`);
  const elsewhere = path.join(dir, 'elsewhere');
  mkdirSync(path.join(elsewhere, 'feat'), { recursive: true });
  writeFileSync(path.join(elsewhere, 'feat', 'eng-1-export'), `${b}\n`);
  rmSync(path.join(dir, 'refs'), { recursive: true });
  mkdirSync(path.join(dir, 'refs'));
  symlinkSync(elsewhere, path.join(dir, 'refs', 'heads'));
  assert.deepEqual(cloneHeads(dir, BRANCH), { problem: `refs/heads/${BRANCH} lies below refs/heads, a link` });
});

test('the commit an attempt started on from another\'s kept clone is no work of its own, while that clone\'s folder is there', (t) => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-sweep-took-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const [taken, own] = ['a'.repeat(40), 'b'.repeat(40)];
  const folder = attemptFolder(state, 'launch', 'ENG-1', 2);
  const refs = (id) => {
    mkdirSync(path.join(folder, 'git', 'refs', 'heads', 'feat'), { recursive: true });
    writeFileSync(path.join(folder, 'git', 'HEAD'), `ref: refs/heads/${BRANCH}\n`);
    writeFileSync(path.join(folder, 'git', 'refs', 'heads', BRANCH), `${id}\n`);
  };
  const row = { key: 'ENG-1', attempt: 2, branch: BRANCH, took: { attempt: 1, head: taken } };
  const unpushed = (given = row) => unpushedHead({ folder, row: given, repository: { host: 'github.com', owner: 'acme', name: 'widgets' }, forge: { hasCommit: () => false } });
  const from = attemptFolder(state, 'launch', 'ENG-1', 1);
  mkdirSync(from, { recursive: true });
  refs(taken);
  assert.equal(unpushed(), null);
  assert.equal(unpushed({ ...row, took: undefined })?.head, taken, 'a row that took nothing counts it');
  assert.equal(unpushed({ ...row, took: { attempt: 1, head: own } })?.head, taken, 'as does one that took another');
  refs(own);
  assert.equal(unpushed()?.head, own, 'a commit of its own counts');
  refs(taken);
  rmSync(from, { recursive: true });
  assert.equal(unpushed()?.head, taken, 'the folder it came from is gone, so this clone holds the only copy');
});

test('a clone whose refs cannot be read keeps its folder, with a kept row', (t) => {
  const { fx, folder, end } = ended(t);
  writeFileSync(path.join(folder, 'git', 'HEAD'), 'garbage\n');
  end();
  const { out } = fx.cmd(['wait', 'launch', '--max-wait', '0']);
  assert.match(out[1], /^kept ENG-1 attempt 1: its clone's refs cannot be read \(HEAD names neither a branch nor a commit\)/u);
  assert.ok(existsSync(folder));
});

// The host's files under its config folder for one session, as Claude Code keeps them, each holding a token line.
function sessionEnv(fx, session, name) {
  const file = path.join(fx.env.CLAUDE_CONFIG_DIR, 'session-env', session, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "export GH_TOKEN='secret'\n", { mode: 0o600 });
  return file;
}

test('once an issue session ends, the host files the SessionStart hook handed its forge token to are removed, and no other', (t) => {
  const { fx, folder, end } = ended(t);
  const handed = [sessionEnv(fx, CHILD, 'sessionstart-hook-0.sh'), sessionEnv(fx, CHILD, 'sessionstart-hook-3.sh')];
  for (const file of handed) assert.equal(recordTokenFile(folder, { session: CHILD, file }), null);
  // Another plugin's file of the same session, and the driver's own.
  const unrecorded = sessionEnv(fx, CHILD, 'sessionstart-hook-1.sh');
  const driver = sessionEnv(fx, 'driver-session', 'sessionstart-hook-0.sh');
  // While the session runs, its files stay.
  fx.cmd(['wait', 'launch', '--max-wait', '0']);
  for (const file of handed) assert.ok(existsSync(file), 'kept while the session runs');
  end();
  fx.cmd(['wait', 'launch', '--max-wait', '0']);
  for (const file of handed) assert.equal(existsSync(file), false, `${path.basename(file)} removed`);
  assert.ok(existsSync(unrecorded) && existsSync(driver), 'no file the hook did not record');
});

test('the token files go even where the folder stays, as after an environment result, and only the launched session\'s', (t) => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-sweep-token-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const folder = attemptFolder(state, 'launch', 'ENG-1', 1);
  mkdirSync(path.join(folder, 'drop'), { recursive: true });
  const start = {
    event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch · ENG-1 · 1', cwd: path.join(folder, 'work'), branch: BRANCH,
    drop: path.join(folder, 'drop'), outcome: 'started', id: STARTED[0].id, child: CHILD, at: new Date().toISOString(),
  };
  const found = { rows: [start, { event: 'result', key: 'ENG-1', attempt: 1, status: 'environment' }], states: new Map([['ENG-1', { state: 'open' }]]) };
  const forgot = [];
  let asked = 0;
  const cap = { ended: () => ((asked += 1), true), forgetShellEnv: (given) => (forgot.push(given), []) };
  writeFileSync(path.join(folder, TOKEN_FILES), JSON.stringify({ session: CHILD, files: ['/x/session-env/a.sh'] }));
  assert.deepEqual(sweepAttempts({ state, run: 'launch', found, cap, env: {}, spawn: null }), []);
  assert.deepEqual(forgot.map(({ files, session }) => ({ files, session })), [{ files: ['/x/session-env/a.sh'], session: CHILD }]);
  assert.ok(existsSync(folder), 'the environment attempt keeps its folder');
  assert.equal(existsSync(path.join(folder, TOKEN_FILES)), false, 'the record goes once its files did');
  sweepAttempts({ state, run: 'launch', found, cap, env: {}, spawn: null });
  assert.equal(asked, 1, 'a kept folder with no record asks the host nothing again');
  // A record that names another session than the one the start launched removes nothing.
  writeFileSync(path.join(folder, TOKEN_FILES), JSON.stringify({ session: 'someone-else', files: ['/x/session-env/b.sh'] }));
  sweepAttempts({ state, run: 'launch', found, cap, env: {}, spawn: null });
  assert.equal(forgot.length, 1);
  assert.equal(existsSync(path.join(folder, TOKEN_FILES)), false, 'and the record goes');
  // A file the host could not remove stays recorded, for the next sweep, and keeps an attempt that would go otherwise.
  const plain = { rows: [start], states: found.states };
  writeFileSync(path.join(folder, TOKEN_FILES), JSON.stringify({ session: CHILD, files: ['/x/session-env/c.sh', '/x/session-env/d.sh'] }));
  sweepAttempts({ state, run: 'launch', found: plain, cap: { ended: () => true, forgetShellEnv: () => ['/x/session-env/d.sh'] }, env: {}, spawn: null });
  assert.deepEqual(JSON.parse(readFileSync(path.join(folder, TOKEN_FILES), 'utf8')), { session: CHILD, files: ['/x/session-env/d.sh'] });
  assert.ok(existsSync(folder), 'kept while a token file is left');
  sweepAttempts({ state, run: 'launch', found: plain, cap: { ended: () => true, forgetShellEnv: () => { throw new Error('busy'); } }, env: {}, spawn: null });
  assert.ok(existsSync(path.join(folder, TOKEN_FILES)), 'a removal that threw leaves every file recorded');
  // A record that is there but cannot be read stays, and keeps the folder.
  writeFileSync(path.join(folder, TOKEN_FILES), 'not json');
  sweepAttempts({ state, run: 'launch', found: plain, cap: { ended: () => true, forgetShellEnv: () => [] }, env: {}, spawn: null });
  assert.equal(readFileSync(path.join(folder, TOKEN_FILES), 'utf8'), 'not json');
  assert.ok(existsSync(folder));
  writeFileSync(path.join(folder, TOKEN_FILES), JSON.stringify({ session: CHILD, files: ['/x/session-env/e.sh'] }));
  // A handed-over result no row took in yet keeps the folder, but not the token.
  writeFileSync(path.join(folder, 'drop', 'result.json'), '{}');
  sweepAttempts({ state, run: 'launch', found: plain, cap: { ended: () => true, forgetShellEnv: () => [] }, env: {}, spawn: null });
  assert.equal(existsSync(path.join(folder, TOKEN_FILES)), false, 'the token goes though the result waits');
  assert.ok(existsSync(folder), 'the waiting result keeps the folder');
});

test('the host removes only a regular file of its own folder for that session, never through a link', (t) => {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-session-env-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { CLAUDE_CONFIG_DIR: path.join(home, 'config') };
  const own = path.join(env.CLAUDE_CONFIG_DIR, 'session-env', CHILD);
  const other = path.join(env.CLAUDE_CONFIG_DIR, 'session-env', 'other-session');
  for (const dir of [own, other]) mkdirSync(dir, { recursive: true });
  const outside = path.join(home, 'keep.txt');
  for (const file of [path.join(own, 'a.sh'), path.join(other, 'a.sh'), outside]) writeFileSync(file, 'x');
  symlinkSync(outside, path.join(own, 'link.sh'));
  const files = [path.join(own, 'a.sh'), path.join(other, 'a.sh'), outside, path.join(own, 'link.sh'), path.join(own, 'gone.sh'), `${own}/../other-session/a.sh`];
  // Every file still there that it did not remove is left, for the record to keep: only the one removed, and one
  // gone already, are not.
  assert.deepEqual(forgetEnvFiles({ files, session: CHILD, env }), [path.join(other, 'a.sh'), outside, path.join(own, 'link.sh'), `${own}/../other-session/a.sh`]);
  assert.equal(existsSync(path.join(own, 'a.sh')), false);
  assert.equal(readFileSync(outside, 'utf8'), 'x', 'nothing outside, and no link followed');
  assert.ok(existsSync(path.join(other, 'a.sh')), 'another session\'s file stays');
  assert.ok(existsSync(path.join(own, 'link.sh')), 'a link is no regular file');
  writeFileSync(path.join(own, 'x'), 'x');
  assert.deepEqual(forgetEnvFiles({ files: [path.join(own, 'x')], session: '../config', env }), [path.join(own, 'x')], 'a session id that is no plain name removes nothing');
  // Under another config folder, as a driver resumed with another CLAUDE_CONFIG_DIR, the file is left, not dropped.
  assert.deepEqual(forgetEnvFiles({ files: [path.join(own, 'x')], session: CHILD, env: { CLAUDE_CONFIG_DIR: path.join(home, 'elsewhere') } }), [path.join(own, 'x')]);
  // The file the host names for a SessionStart is one the hook may hand the token to only when it lies there too.
  assert.equal(sessionEnvFile({ env: { ...env, CLAUDE_ENV_FILE: path.join(own, 'b.sh') }, session: CHILD }), path.join(own, 'b.sh'));
  for (const file of [path.join(other, 'b.sh'), path.join(home, 'b.sh'), 'relative.sh', undefined]) {
    assert.equal(sessionEnvFile({ env: { ...env, CLAUDE_ENV_FILE: file }, session: CHILD }), null, String(file));
  }
});

test('a token record counts as gone only when the system says so, and one that cannot be read is never replaced', (t) => {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-token-record-')));
  t.after(() => {
    chmodSync(folder, 0o700);
    rmSync(folder, { recursive: true, force: true });
  });
  assert.equal(tokenRecordThere(folder), false);
  writeFileSync(path.join(folder, TOKEN_FILES), 'not json');
  assert.equal(tokenRecordThere(folder), true);
  const file = path.join(folder, 'sessionstart-hook-1.sh');
  assert.match(recordTokenFile(folder, { session: CHILD, file }), /cannot be read/u, 'a later SessionStart never overwrites it');
  assert.equal(readFileSync(path.join(folder, TOKEN_FILES), 'utf8'), 'not json');
  // A folder the look cannot search: the record may be there.
  rmSync(path.join(folder, TOKEN_FILES));
  chmodSync(folder, 0o600);
  assert.equal(tokenRecordThere(folder), true);
});
