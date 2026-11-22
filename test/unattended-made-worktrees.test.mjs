// A session no Human attends writes the task worktrees `aidrian worktree new` made in it, as its start worktree
// (lib/unattended-write.mjs madePlaces), so an orchestrator that started in one worktree can dispatch an editing subagent
// to another it made: the command records each one for its caller's session in the continuation store
// (lib/handoff-markers.mjs noteWorktree), which such a session never writes by hand. A worktree another session made, one
// made by plain `git worktree add`, one a project run's issue session made, and one a record names in a dot folder of the
// home folder or through a link stay outside. Every read here is in the test's process.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { madeWorktrees, noteWorktree, openStore, storePath, sweep } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { unattendedPlaces, unattendedWriteDenial } from '../plugins/aidrian/lib/unattended-write.mjs';
import { createWorktree } from '../plugins/aidrian/lib/worktree.mjs';

import { hookCall } from './hook-call.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const SESSION = 'feed00aa-0000-4000-8000-0000000000aa';
const OTHER = 'feed00aa-0000-4000-8000-0000000000bb';

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });

// A project on `main` with `.worktrees/` ignored, a state folder outside it, and a linked worktree `wt` the session
// SESSION started in, marked unattended there with `tags`. `made(branch, session)` runs `aidrian worktree new` from that
// worktree as the host's shell of `session` would; `ask(input)` asks the guard as the agent gate hook does.
function fixture(t, { tags = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-made-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const [dir, state, home, temp, start] = ['main', 'state', 'home', 'tmp', 'wt'].map((name) => path.join(root, name));
  for (const each of [dir, state, home, temp]) mkdirSync(each, { recursive: true });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  git('worktree', 'add', '-q', '-b', 'feat/start', start);
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks'), HOME: home, TMPDIR: temp };
  assert.ok(markUnattended(SESSION, { root: dir, cwd: start, env, tags }));
  const mark = readUnattendedMark(SESSION, { env, home });
  const project = findProject(dir);
  const { config } = loadConfig(project);
  const made = (branch, session = SESSION) => createWorktree({ branch }, { cwd: start, env: { ...env, CLAUDE_CODE_SESSION_ID: session } }).worktree_path;
  const ask = (input) => unattendedWriteDenial({ session_id: SESSION, cwd: start, ...input }, config, {
    mark,
    env,
    places: () => unattendedPlaces({ cwd: start, mark, project, config, env, home, temp: [temp], session: SESSION }),
  });
  const store = () => openStore(state, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  return { root, dir, state, home, start, env, git, made, ask, store };
}

const write = (file, more = {}) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, ...more });

test('a session no Human attends, and its subagents, write a task worktree `aidrian worktree new` made in it', (t) => {
  const fx = fixture(t);
  const made = fx.made('feat/slice');
  assert.deepEqual(madeWorktrees(fx.store(), SESSION), [realpathSync(made)], 'the command records it for the session');
  const file = path.join(made, 'scripts', 'support', 'react-server-condition.ts');
  assert.equal(fx.ask(write(file)), null, 'the session');
  assert.equal(fx.ask(write(file, { agent_id: 'a5f0c1' })), null, 'its subagent');
  assert.equal(fx.ask({ tool_name: 'Bash', tool_input: { command: `cd ${made} && echo x > notes.md` } }), null, 'the shell');
  assert.equal(fx.ask(write(path.join(fx.start, 'a.ts'))), null, 'its start worktree still');
  // Kept as the start worktree is: its pointer and host files stay refused, and the main checkout stays outside.
  assert.match(fx.ask(write(path.join(made, '.git')))?.reason ?? '', /the checkout's pointer to its git folder/u);
  assert.match(fx.ask(write(path.join(made, '.claude', 'settings.json')))?.reason ?? '', /a host file a later session in that checkout loads/u);
  assert.match(fx.ask(write(path.join(fx.dir, 'README.md')))?.reason ?? '', /outside the places/u);
});

test('a worktree another session made, or plain `git worktree add` made, stays outside, and so does one made with no session', (t) => {
  const fx = fixture(t);
  const theirs = fx.made('feat/theirs', OTHER);
  const plain = path.join(fx.dir, '.worktrees', 'plain');
  fx.git('worktree', 'add', '-q', '-b', 'feat/plain', plain);
  const nameless = createWorktree({ branch: 'feat/nameless' }, { cwd: fx.start, env: fx.env }).worktree_path;
  for (const each of [theirs, plain, nameless]) {
    const denial = fx.ask(write(path.join(each, 'a.ts')));
    assert.match(denial?.reason ?? '', /outside the places a session no Human attends may write: .*a task worktree `aidrian worktree new` made in it/u, each);
  }
  assert.deepEqual(madeWorktrees(fx.store(), SESSION), []);
});

test('a project run\'s issue session stays confined to its attempt, whatever worktree the command made for it', (t) => {
  const fx = fixture(t, { tags: { project: 'launch', issue: 'ENG-1' } });
  const made = fx.made('feat/eng-1-more');
  assert.deepEqual(madeWorktrees(fx.store(), SESSION), [realpathSync(made)]);
  assert.match(fx.ask(write(path.join(made, 'a.ts')))?.reason ?? '', /outside the places/u);
});

test('a record grants only a linked worktree git lists at that path: never the main checkout, a link, a home dot folder, or a host folder', (t) => {
  const fx = fixture(t);
  const store = fx.store();
  // The main checkout, and a folder that is no checkout.
  const loose = path.join(fx.root, 'loose');
  mkdirSync(loose);
  // A worktree the record names in a dot folder of the home folder, and one in the main checkout's skills folder.
  const dotted = path.join(fx.home, '.claude', 'skills', 'planted');
  const skills = path.join(fx.dir, '.claude', 'skills', 'planted');
  for (const [each, branch] of [[dotted, 'feat/dotted'], [skills, 'feat/skills']]) {
    mkdirSync(path.dirname(each), { recursive: true });
    fx.git('worktree', 'add', '-q', '-b', branch, each);
  }
  // A made worktree whose folder was moved away and replaced by a link to the home folder.
  const linked = fx.made('feat/linked');
  renameSync(linked, `${linked}-moved`);
  symlinkSync(fx.home, linked);
  for (const each of [fx.dir, loose, dotted, skills]) assert.ok(noteWorktree(store, SESSION, each), each);
  for (const each of [path.join(fx.dir, 'a.ts'), path.join(loose, 'a.ts'), path.join(dotted, 'SKILL.md'), path.join(skills, 'SKILL.md'), path.join(linked, 'a.ts')]) {
    assert.ok(fx.ask(write(each)), each);
  }
});

test('the agent gate hook grants the made worktree by the payload\'s session id, and refuses the session\'s own write of a record', async (t) => {
  const fx = fixture(t);
  const made = fx.made('feat/slice');
  const run = (file, session = SESSION) => hookCall(HOOK, { input: JSON.stringify({ session_id: session, cwd: fx.start, agent_id: 'a5f0c1', agent_type: 'aidrian:backend-developer', ...write(file) }), cwd: fx.start, env: fx.env });
  const own = await run(path.join(made, 'src', 'a.ts'));
  assert.equal(own.status, 0, own.stderr);
  const record = path.join(storePath(fx.state), 'worktree-feed00aa-0000-4000-8000-0000000000aa.0123456789ab.json');
  const forged = await run(record);
  assert.equal(forged.status, 2, forged.stderr);
  assert.match(forged.stderr, /continuation store/u);
});

test('a worktree record lives 30 days, and the sweep removes it after', (t) => {
  const fx = fixture(t);
  const store = fx.store();
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  assert.ok(noteWorktree(store, SESSION, fx.start, { now }));
  assert.deepEqual(madeWorktrees(store, SESSION, { now: now + 29 * day }), [fx.start]);
  assert.deepEqual(madeWorktrees(store, OTHER, { now }), []);
  assert.deepEqual(madeWorktrees(store, SESSION, { now: now + 31 * day }), [], 'past its age');
  assert.equal(noteWorktree(store, SESSION, 'relative/path'), null, 'a path that is not absolute');
  sweep(store, now + 29 * day);
  // A second on, past the file's own modification time, which may fall a few milliseconds after `now`.
  assert.deepEqual(madeWorktrees(store, SESSION, { now: now + 1000 }), [fx.start], 'kept by a sweep inside its age');
  sweep(store, now + 31 * day);
  assert.deepEqual(madeWorktrees(store, SESSION, { now: now + 1000 }), [], 'swept');
});
