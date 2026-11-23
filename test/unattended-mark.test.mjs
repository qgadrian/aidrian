// A session the background handoff route started stays held wherever its calls run: the gate's unattended mark
// (lib/unattended-mark.mjs) under the state root, which the agent gates hook reads on every call, with no project at the
// call's folder too, and the chain floor the hook also finds in the user's own store (lib/handoff-guard.mjs
// startedUnattended). No test starts a real session. Temporary repositories are made with `git init` under mkdtemp and
// driven with `git -C`. One test points GIT_DIR at a missing folder inside a temporary folder, never at a repository.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { unattendedHere } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { startedUnattended } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { noteFrom, openStore, storePath } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { defaultStateDir, findProject, projectCheckouts, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { GIT_VARS } from '../plugins/aidrian/lib/review/env.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import { humanPrompts } from '../plugins/aidrian/lib/hosts/index.mjs';
import { dropPending, isAttended, liftAttended, MARK_AGE, markFolder, markPending, markUnattended, PENDING_AGE, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { TEST_HOME } from './fixtures/test-home.mjs';
import { hookCall } from './hook-call.mjs';

// The hooks this file runs record their blocks, and the gate's marks, in the state root; keep them in a folder of its own.
process.env.XDG_STATE_HOME = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A project with `config` and a source file.
function project(t, config = { version: 1 }) {
  const dir = folder(t, 'aidrian-marked-');
  mkdirSync(path.join(dir, '.aidrian'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, 'src/app.js'), 'export {};\n');
  return dir;
}

const floor = (state, dir, session) => assert.ok(noteFrom(openStore(state, { checkouts: [dir], maxChain: 3 }), session, { slug: 'widget', chain: 1, brief: path.join(state, 'handoffs/2026-11-15-widget.md'), route: 'background' }));

test('the floor is found in the user\'s own store too, where the gate keeps it, when the hook\'s environment names another', (t) => {
  const dir = project(t);
  const found = findProject(dir);
  const { config } = loadConfig(found);
  const home = folder(t, 'aidrian-home-');
  const own = defaultStateDir(found, { config, home });
  assert.notEqual(own, stateDir(found, { config }), 'the hook\'s XDG_STATE_HOME names another store than the user\'s own');
  const session = 'abcd1234-0000-4000-8000-000000000001';
  floor(own, dir, session);
  assert.equal(startedUnattended(found, config, session, { home }), true);
  assert.equal(startedUnattended(found, config, session, { home: folder(t, 'aidrian-other-home-') }), false, 'no floor in another home');
  assert.equal(startedUnattended(found, config, 'plain-session', { home }), false);
});

test('with git unable to list the worktrees, the floor in the user\'s own store is still found', (t) => {
  const dir = project(t);
  const found = findProject(dir);
  const { config } = loadConfig(found);
  const home = folder(t, 'aidrian-home-');
  const session = 'abcd1234-0000-4000-8000-000000000009';
  floor(defaultStateDir(found, { config, home }), dir, session);
  // A folder that holds no repository, inside a temporary folder of its own: git can list no worktree.
  const saved = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(folder(t, 'aidrian-no-repository-'), 'missing');
  t.after(() => {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  });
  assert.equal(projectCheckouts(found), null, 'git cannot list the checkouts');
  assert.equal(startedUnattended(found, config, session, { home }), true, 'a floor found only adds refusals, so it needs no list');
});

test('the floor is found in the user\'s own store of the base branch\'s state.dir, which a working copy moved', (t) => {
  const dir = project(t, { version: 1, state: { dir: '~/team-state' } });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.aidrian/config.json');
  git('commit', '-q', '-m', 'config');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: folder(t, 'aidrian-working-state-') } }));
  const found = findProject(dir);
  const { config } = loadConfig(found);
  const home = folder(t, 'aidrian-home-');
  const session = 'abcd1234-0000-4000-8000-000000000002';
  floor(path.join(home, 'team-state'), dir, session);
  assert.equal(startedUnattended(found, config, session, { home }), true);
});

test('a mark holds under its own id or a short one, for 30 days; a write sweeps older ones; an entry it cannot read holds', (t) => {
  const env = { ...process.env, XDG_STATE_HOME: folder(t, 'aidrian-marks-') };
  const home = folder(t, 'aidrian-home-');
  const root = folder(t, 'aidrian-root-');
  const read = (session) => readUnattendedMark(session, { env, home });
  assert.equal(read('abcd1234-0000-4000-8000-000000000003'), null, 'no folder, no mark');
  assert.ok(markUnattended('abcd1234-0000-4000-8000-000000000003', { root, env }));
  assert.ok(markUnattended('beef5678', { root, env }));
  assert.deepEqual(read('abcd1234-0000-4000-8000-000000000003'), { root });
  assert.deepEqual(read('beef5678-0000-4000-8000-000000000004'), { root }, 'a short id holds for every id that starts with it');
  assert.equal(read('beef0000-0000-4000-8000-000000000004'), null);
  assert.equal(markUnattended('../escape', { root, env }), null, 'an id that cannot name a file');
  assert.equal(markUnattended('abcd', { root: 'relative', env }), null, 'a root that is no absolute path');

  const marks = markFolder(env);
  const old = (Date.now() - MARK_AGE - 60_000) / 1000;
  utimesSync(path.join(marks, 'beef5678.json'), old, old);
  assert.equal(read('beef5678-0000-4000-8000-000000000004'), null, 'a mark past 30 days does not hold');
  assert.ok(markUnattended('cafe0001', { root, env }));
  assert.deepEqual(readdirSync(marks).sort(), ['abcd1234-0000-4000-8000-000000000003.json', 'cafe0001.json'], 'the write swept it');

  // An entry that is no file names no root, and still holds: a mark only refuses more.
  mkdirSync(path.join(marks, 'dead0001.json'));
  assert.deepEqual(read('dead0001'), { root: null });
  // The user's own folder is read too.
  mkdirSync(path.join(home, '.local/state/aidrian/unattended'), { recursive: true });
  writeFileSync(path.join(home, '.local/state/aidrian/unattended/face0001.json'), JSON.stringify({ root, at: Date.now() }));
  assert.deepEqual(read('face0001'), { root });
});

test('a marked session is held from a folder outside its project, and in another project, before any refusal; an attended one is not', async (t) => {
  const dir = project(t);
  const outside = folder(t, 'aidrian-outside-');
  assert.equal(findProject(outside), null, 'the folder is no project');
  const other = project(t);
  const store = storePath(stateDir(findProject(dir)));
  const full = 'feed0001-0000-4000-8000-000000000001';
  const short = 'cafe0002-0000-4000-8000-000000000002';
  const gone = 'dead0003-0000-4000-8000-000000000003';
  assert.ok(markUnattended(full, { root: dir }));
  assert.ok(markUnattended('cafe0002', { root: dir }));
  // A mark whose project is gone still holds the session to what holds outside any project.
  assert.ok(markUnattended(gone, { root: path.join(outside, 'no-such-project') }));
  const marks = markFolder();
  const run = (session, command, { cwd = outside, agent = false } = {}) => hookCall(HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd, ...(agent ? { agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' } : {}) }),
    cwd, encoding: 'utf8',
  });
  const refused = [
    ['claude -p "go on"', /starts or resumes a Claude Code session outside the handoff gate/u],
    ['XDG_STATE_HOME=/tmp/elsewhere aidrian handoff continue b.md', /with XDG_STATE_HOME set or unset by the command itself/u],
    ['env -u XDG_STATE_HOME aidrian handoff continue b.md', /with XDG_STATE_HOME set or unset by the command itself/u],
    [`echo '{"handoff":{"background":"on"}}' > ${dir}/.aidrian.local.json`, /sets handoff\.background in \.aidrian\.local\.json/u],
    [`rm ${store}/from-${full}.json`, /the handoff continuation store/u],
    [`rm ${marks}/${full}.json`, /the unattended marks/u],
    [`rm -rf ${marks}`, /the unattended marks/u],
    [`chmod 777 ${marks}`, /the unattended marks/u],
    [`mv ${marks} ${outside}/kept`, /the unattended marks/u],
    [`touch -t 200001010000 ${marks}/cafe0002.json`, /the unattended marks/u],
    ['cd "$X" && rm -rf unattended', /may change the unattended marks/u],
  ];
  const allowed = ['ls', 'claude agents --json', `rm -f ${outside}/x`, 'echo hi > note.txt', 'aidrian handoff continue b.md'];
  for (const session of [full, short]) {
    for (const [command, reason] of refused) {
      const result = await run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, reason, command);
      assert.match(result.stderr, /the background handoff route started this (?:session|one), with no Human/u, command);
    }
    for (const command of allowed) assert.equal((await run(session, command)).status, 0, `${session}: ${command}`);
    // In another project, the marked project's store and switches stay guarded.
    assert.equal((await run(session, `rm ${store}/from-${full}.json`, { cwd: other })).status, 2, `${session}: the marked project's store from another project`);
    assert.equal((await run(session, `echo '{"handoff":{"background":"on"}}' > ${dir}/.aidrian.local.json`, { cwd: other })).status, 2, `${session}: a switch from another project`);
    assert.equal((await run(session, 'claude -p x', { cwd: other })).status, 2, `${session}: a start from another project`);
    assert.equal((await run(session, `rm -f ${other}/src/app.js`, { cwd: other })).status, 0, session);
  }
  assert.equal((await run(gone, 'claude -p x')).status, 2, 'a mark whose project is gone');
  assert.equal((await run(gone, `rm ${marks}/${gone}.json`)).status, 2, 'its own mark');
  assert.equal((await run(gone, 'ls')).status, 0);
  // An attended session may do all of it; a subagent of it may not change the marks.
  for (const [command] of refused) assert.equal((await run('plain-session', command)).status, 0, `attended: ${command}`);
  assert.equal((await run('plain-session', `rm ${marks}/${full}.json`, { agent: true })).status, 2, 'a subagent may not delete a mark');
  assert.equal((await run('plain-session', `printf x > ${marks}/plain-session.json`, { agent: true, cwd: dir })).status, 2, 'nor forge one, in a project');
  // The marks are still there: every refusal was judged before the call ran.
  assert.deepEqual(readUnattendedMark(full, { home: TEST_HOME }), { root: dir });
});

test('while the gate starts a session, every session the host had not listed and with no mark of its own is held, in whatever folder it works', async (t) => {
  const dir = project(t);
  const outside = folder(t, 'aidrian-outside-');
  const old = 'feed0004-0000-4000-8000-000000000004';
  const fresh = 'cafe0005-0000-4000-8000-000000000005';
  const listed = 'beef0006-0000-4000-8000-000000000006';
  const pending = markPending(old, { cwd: dir, root: dir, known: [old, listed] });
  assert.ok(pending);
  t.after(() => dropPending(pending));
  const run = (session, command, cwd = dir) => hookCall(HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd }), cwd, encoding: 'utf8',
  });
  const refused = [
    [`echo '{"handoff":{"background":"on"}}' > ${dir}/.aidrian.local.json`, /sets handoff\.background in \.aidrian\.local\.json/u],
    ['claude --bg "go on"', /starts or resumes a Claude Code session outside the handoff gate/u],
    [`rm ${pending}`, /the unattended marks/u],
  ];
  for (const [command, reason] of refused) {
    // The new session may change folder before the host lists its id: below the start folder, or out of it.
    for (const cwd of [dir, path.join(dir, 'src'), outside]) {
      const result = await run(fresh, command, cwd);
      assert.equal(result.status, 2, `${cwd}: ${command}`);
      assert.match(result.stderr, reason, command);
      assert.match(result.stderr, /the background handoff route started this (?:session|one), with no Human/u, command);
    }
    assert.equal((await run(old, command)).status, 0, `the session that ran the gate: ${command}`);
    assert.equal((await run(listed, command)).status, 0, `a session the host listed before the start: ${command}`);
  }
  assert.equal((await run(fresh, 'ls')).status, 0);
  assert.equal((await run(fresh, 'ls', outside)).status, 0, 'a held session still works');

  // A pending mark that names no listing holds every session but the gate's.
  const unlisted = markPending(old, { cwd: dir, root: dir });
  assert.equal(unlisted, pending, 'the same gate\'s mark, written again');
  assert.equal((await run(listed, 'claude --bg x', outside)).status, 2, 'with no listing, a session cannot show it was there before');
  assert.equal((await run(old, 'claude --bg x', outside)).status, 0);

  // A pending mark lapses after PENDING_AGE; one it cannot read holds every session.
  const lapsed = (Date.now() - PENDING_AGE - 60_000) / 1000;
  utimesSync(pending, lapsed, lapsed);
  assert.equal((await run(fresh, 'claude --bg x')).status, 0, 'a lapsed pending mark holds nobody');
  writeFileSync(pending, 'not json');
  assert.equal((await run(fresh, 'claude --bg x', outside)).status, 2, 'an unreadable pending mark holds every session');
  assert.ok(dropPending(pending));
  assert.equal((await run(fresh, 'claude --bg x')).status, 0, 'once the gate removed it, nobody');
});

test('a subagent and a marked session may not repoint a git remote or gh\'s default repository; reads, and an attended session, may', async (t) => {
  const dir = project(t);
  const outside = folder(t, 'aidrian-outside-');
  const marked = 'feed0006-0000-4000-8000-000000000006';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command, { cwd = dir, agent = false } = {}) => hookCall(HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd, ...(agent ? { agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' } : {}) }),
    cwd, encoding: 'utf8',
  });
  const refused = [
    'git remote set-url origin git@github.com:someone/else.git',
    'git -C . remote add upstream https://github.com/someone/else',
    'git remote rename upstream origin',
    'git config remote.origin.url git@github.com:someone/else.git',
    'gh repo set-default someone/else',
    'bash -c "git remote set-url origin x"',
    '$GIT remote set-url origin x',
    // git config: a remote key's write or removal, gh's default repository, an include, a URL rewrite, an alias, and
    // the forms that write keys they do not name.
    'git config --unset remote.origin.url',
    'git config set remote.origin.url x',
    'git config remote.origin.gh-resolved base',
    'git config include.path /tmp/evil.cfg',
    'git config includeIf.gitdir:~/.path /tmp/evil.cfg',
    'git config --global url.git@github.com:someone/.insteadOf git@github.com:Acme/',
    'git config alias.remote "!echo"',
    'git config --edit',
    'git config -e',
    'git config --rename-section remote.upstream remote.origin',
    'git config --remove-section remote.origin',
    'git -c alias.st=status st',
    'git -calias.st=status st',
    'git --config-env alias.st=CMD st',
    'gh alias set co "pr checkout"',
    // Words split by quotes or a backslash read whole.
    "git rem''ote set-url origin x",
    'git re\\mote add up x',
    "gh re''po set-default x/y",
    // A trailing read word is a value pattern once the key is given: the call still writes.
    'git config remote.origin.url git@github.com:someone/else.git get',
    'git config remote.origin.url git@github.com:someone/else.git list',
    'git config remote.origin.url git@github.com:someone/else.git --get',
    'git config remote.origin.url git@github.com:someone/else.git -l',
  ];
  const allowed = [
    'git remote -v', 'git remote get-url origin', 'git config --get remote.origin.url', 'git config remote.origin.url',
    'git config --get-all remote.origin.url', 'git config --list', 'git config user.name t', 'gh repo set-default --view', 'git fetch origin',
    'git -c core.pager=cat log -1', 'gh alias list',
    // Other programs whose words name such an action are no git or gh call, whatever their variables.
    'grep -rn "remote add" "$DIR"', 'rg "set-url" remote $X', 'npm test -- --grep "remote rename" $ARGS',
  ];
  for (const [who, session, options] of [['a marked session', marked, {}], ['a subagent', 'plain-session', { agent: true }], ['a marked session outside its project', marked, { cwd: outside }]]) {
    for (const command of refused) {
      const result = await run(session, command, options);
      assert.equal(result.status, 2, `${who}: ${command}`);
      assert.match(result.stderr, /changes which repository the checkout's git remotes or gh's default name, or how git reads them, where the plugin reads the team's policy on the forge, such as solo/u, `${who}: ${command}`);
    }
    for (const command of allowed) {
      const result = await run(session, command, options);
      // A marked session's write of the repository's own git config is the write allowlist's to refuse
      // (lib/unattended-write.mjs), never this guard's.
      if (command === 'git config user.name t' && session === marked) {
        assert.equal(result.status, 2, `${who}: ${command}`);
        assert.match(result.stderr, /the repository's shared git config/u, `${who}: ${command}`);
        assert.doesNotMatch(result.stderr, /changes which repository/u, `${who}: ${command}`);
        continue;
      }
      assert.equal(result.status, 0, `${who}: ${command}`);
    }
  }
  for (const command of refused) assert.equal((await run('plain-session', command)).status, 0, `attended: ${command}`);
});

test('a subagent and a marked session may not erase the machine\'s local file by any Bash write, though it names no key', async (t) => {
  // The project has no gates: the guard holds without them.
  const dir = project(t);
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ unattendedSignoff: 'off' }));
  const marked = 'feed0007-0000-4000-8000-000000000007';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command, { agent = false } = {}) => hookCall(HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: dir, ...(agent ? { agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' } : {}) }),
    cwd: dir, encoding: 'utf8',
  });
  const refused = [
    `rm ${local}`, 'rm -f .aidrian.local.json', `mv ${local} ${dir}/kept.json`, ': > .aidrian.local.json', `cp /dev/null ${local}`, 'truncate -s 0 .aidrian.local.json', 'rm .aidrian.*',
    // Split by quotes; a link made from it; a clean or stash that takes ignored files; a variable or bracket glob that
    // may spell it.
    'rm .aid""rian.local.json', 'ln -s .aidrian.local.json alias', 'ln .aidrian.local.json hard', 'cp -l .aidrian.local.json hard', 'cp -s .aidrian.local.json soft',
    'git clean -fdx', 'git clean -X -f', 'git stash -a', 'git stash push --all',
    'F=.aidrian.local.json; rm "$F"', 'F=.aidrian.local.json; echo {} > "$F"', 'rm .aidrian.loca[l].json',
  ];
  for (const [who, session, options] of [['a marked session', marked, {}], ['a subagent', 'plain-session', { agent: true }]]) {
    for (const command of refused) {
      const result = await run(session, command, options);
      assert.equal(result.status, 2, `${who}: ${command}`);
      assert.match(result.stderr, /it writes, moves, links, or removes \.aidrian\.local\.json, or may, which holds the machine's switches/u, `${who}: ${command}`);
    }
    assert.equal((await run(session, `cat ${local}`, options)).status, 0, `${who}: a read`);
    for (const command of [`cp ${local} ${dir}/copy.json`, 'git clean -fd', 'git stash', 'F=notes.txt; rm "$F"']) assert.equal((await run(session, command, options)).status, 0, `${who}: ${command}`);
    assert.equal((await run(session, 'rm -f notes.txt', options)).status, 0, `${who}: another file`);
  }
  for (const command of refused) assert.equal((await run('plain-session', command)).status, 0, `attended: ${command}`);
});

test('a marked session may not run the handoff gate with a variable that moves the repository git reads, or gh\'s config', async (t) => {
  const dir = project(t);
  const marked = 'feed0008-0000-4000-8000-000000000008';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command) => hookCall(HOOK, {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: dir }), cwd: dir, encoding: 'utf8',
  });
  // Any variable, not only the ones that move what the gate reads.
  for (const name of [...GIT_VARS, 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
    const result = await run(marked, `${name}=/tmp/elsewhere aidrian handoff continue b.md`);
    assert.equal(result.status, 2, name);
    assert.match(result.stderr, new RegExp(`with ${name} set or unset by the command itself`, 'u'), name);
    assert.equal((await run('plain-session', `${name}=/tmp/elsewhere aidrian handoff continue b.md`)).status, 0, `attended: ${name}`);
  }
  // The script itself, so its own entry stays covered.
  const exported = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: marked, tool_name: 'Bash', tool_input: { command: 'export NODE_OPTIONS=--require=/tmp/x.js; aidrian handoff route' }, cwd: dir }), cwd: dir, encoding: 'utf8',
  });
  assert.equal(exported.status, 2);
  assert.match(exported.stderr, /with NODE_OPTIONS set or unset by the command itself/u);
  assert.equal((await run(marked, 'aidrian handoff route')).status, 0, 'with no variable');
});

// The user's own state folder is read beside the state root's, and no HOME or XDG_STATE_HOME moves it, so a call that
// gives no `home` reads the marks and floors of the sessions running on the machine, and fails while one hands off.
test('every test call that reads the unattended marks or the user\'s own chain floors passes a home folder', () => {
  const reader = /\b(?:readUnattendedMark|unattendedHere|continueBrief|routeOf|startedUnattended)\(/u;
  const missing = [];
  for (const name of readdirSync(import.meta.dirname).filter((each) => each.endsWith('.test.mjs')).sort()) {
    readFileSync(path.join(import.meta.dirname, name), 'utf8').split('\n').forEach((line, at) => {
      if (reader.test(line) && !/^\s*(?:import|\/\/|\*)/u.test(line) && !/[{,]\s*home\s*[:,}]/u.test(line)) missing.push(`${name}:${at + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(missing, [], 'pass `home`, such as TEST_HOME from test/fixtures/test-home.mjs');
});

test('a background session the Human types into is attended from then on; a peer, the start prompt, a foreign transcript, and an issue session are not', async (t) => {
  const dir = project(t);
  const session = 'feed0009-0000-4000-8000-000000000009';
  const projects = path.join(TEST_HOME, '.claude', 'projects', '-x');
  mkdirSync(projects, { recursive: true });
  const transcript = path.join(projects, `${session}.jsonl`);
  t.after(() => rmSync(transcript, { force: true }));
  const entry = (more) => ({ type: 'user', isSidechain: false, entrypoint: 'cli', message: { role: 'user', content: 'x' }, ...more });
  const start = entry({ origin: { kind: 'human' }, turnOrigin: 'human', turnPosition: { promptIndex: 1, turnIndex: 1 } });
  const peer = entry({ isMeta: true, origin: { kind: 'peer', from: 'uds:/tmp/x.sock' }, turnOrigin: 'peer', turnPosition: { promptIndex: 2, turnIndex: 3 } });
  const typed = entry({ origin: { kind: 'human' }, turnOrigin: 'human', turnPosition: { promptIndex: 3, turnIndex: 4 } });
  const lines = (file, ...entries) => writeFileSync(file, `${entries.map((each) => JSON.stringify(each)).join('\n')}\n`);
  // As the agent gate hook asks: the adapter vouches for the session's own transcript, then for each entry of it.
  const lift = (id, file) => {
    const real = claudeCode.ownTranscript(file, { session: id, home: TEST_HOME });
    return real !== null && liftAttended(id, real, { home: TEST_HOME, isHuman: claudeCode.humanPrompt });
  };
  const read = (id) => readUnattendedMark(id, { home: TEST_HOME });
  assert.ok(markUnattended(session, { root: dir }));
  // A real background start also files a chain floor, which holds the session in its project on its own.
  const found = findProject(dir);
  const { config } = loadConfig(found);
  const home = folder(t, 'aidrian-home-');
  const state = defaultStateDir(found, { config, home });
  floor(state, dir, session);
  const store = openStore(state, { checkouts: [dir], maxChain: 3 });
  assert.equal(startedUnattended(found, config, session, { home }), true, 'the floor holds before the Human types');
  for (const [what, entries] of [['the start prompt', [start]], ['a peer message', [start, peer]], ['a meta entry marked human', [start, { ...typed, isMeta: true }]], ['a subagent\'s', [start, { ...typed, isSidechain: true }]]]) {
    lines(transcript, ...entries);
    assert.equal(lift(session, transcript), false, what);
    assert.ok(read(session), what);
  }
  // A transcript outside the host's own folder, which a session could write, proves nothing; nor one named for another session.
  const elsewhere = path.join(folder(t, 'aidrian-transcript-'), `${session}.jsonl`);
  lines(elsewhere, start, typed);
  assert.equal(lift(session, elsewhere), false, 'a foreign transcript');
  const other = path.join(projects, 'feed000b-0000-4000-8000-00000000000b.jsonl');
  t.after(() => rmSync(other, { force: true }));
  lines(other, start, typed);
  assert.equal(lift(session, other), false, 'another session\'s transcript');
  // A projects folder that is a link may lead anywhere a session writes.
  const linkedHome = folder(t, 'aidrian-linked-home-');
  const target = folder(t, 'aidrian-linked-target-');
  mkdirSync(path.join(linkedHome, '.claude'), { recursive: true });
  symlinkSync(target, path.join(linkedHome, '.claude', 'projects'));
  mkdirSync(path.join(target, '-z'));
  const linked = path.join(linkedHome, '.claude', 'projects', '-z', `${session}.jsonl`);
  lines(linked, start, typed);
  assert.equal(claudeCode.ownTranscript(linked, { session, home: linkedHome }), null, 'a linked projects folder');
  // A project run's issue session stays held whoever types.
  const issue = 'feed000a-0000-4000-8000-00000000000a';
  assert.ok(markUnattended(issue, { root: dir, tags: { project: 'r1', issue: 'ENG-1' } }));
  const issueTranscript = path.join(projects, `${issue}.jsonl`);
  t.after(() => rmSync(issueTranscript, { force: true }));
  lines(issueTranscript, start, typed);
  assert.equal(lift(issue, issueTranscript), false, 'an issue session');
  assert.ok(read(issue));
  // A session with a stronger mark beside its plain one is never lifted, on the first lift too.
  const both = 'feed000d-0000-4000-8000-00000000000d';
  assert.ok(markUnattended(both, { root: dir }));
  const short = path.join(markFolder(), `${both.slice(0, 8)}.json`);
  writeFileSync(short, JSON.stringify({ root: dir, project: 'r1', issue: 'ENG-1', at: Date.now() }));
  t.after(() => rmSync(short, { force: true }));
  const bothTranscript = path.join(projects, `${both}.jsonl`);
  t.after(() => rmSync(bothTranscript, { force: true }));
  lines(bothTranscript, start, typed);
  assert.equal(read(both)?.issue, 'ENG-1', 'the read gives the stronger hold, whatever the scan order');
  assert.equal(lift(both, bothTranscript), false, 'a stronger hold beside a plain one');
  assert.equal(isAttended(both, { home: TEST_HOME }), false);
  // The Human typed: the session is attended, its mark read as none and its background floor no longer holding it.
  lines(transcript, start, peer, typed);
  assert.equal(lift(session, transcript), true);
  assert.equal(read(session), null);
  assert.equal(isAttended(session, { home: TEST_HOME }), true);
  assert.equal(isAttended(issue, { home: TEST_HOME }), false);
  assert.equal(startedUnattended(found, config, session, { home }), false, 'the floor no longer holds it in its project');
  assert.equal(unattendedHere(session, { store, env: process.env, home, now: Date.now() }), false, 'nor the continuation and its Stop hook');
  // A mark filed under a short id, as when the host's listing lags, and one in the user's own folder, are lifted where they are.
  const shortSession = 'feed000e-0000-4000-8000-00000000000e';
  const shortMark = path.join(markFolder(), `${shortSession.slice(0, 8)}.json`);
  writeFileSync(shortMark, JSON.stringify({ root: dir, at: Date.now() }));
  t.after(() => rmSync(shortMark, { force: true }));
  const ownSession = 'feed000f-0000-4000-8000-00000000000f';
  const ownMarks = path.join(home, '.local/state/aidrian/unattended');
  mkdirSync(ownMarks, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(ownMarks, `${ownSession}.json`), JSON.stringify({ root: dir, at: Date.now() }));
  for (const id of [shortSession, ownSession]) {
    const file = path.join(projects, `${id}.jsonl`);
    t.after(() => rmSync(file, { force: true }));
    lines(file, start, typed);
    assert.ok(readUnattendedMark(id, { home }), `${id} is held`);
    const real = claudeCode.ownTranscript(file, { session: id, home: TEST_HOME });
    assert.equal(liftAttended(id, real, { home, isHuman: claudeCode.humanPrompt }), true, id);
    assert.equal(readUnattendedMark(id, { home }), null, `${id} is attended`);
  }
  // An issue mark filed beside the lifted plain one later still holds: attendance lifts only the plain hold.
  const later = path.join(markFolder(), `${session.slice(0, 8)}.json`);
  writeFileSync(later, JSON.stringify({ root: dir, project: 'r1', issue: 'ENG-1', at: Date.now() }));
  t.after(() => rmSync(later, { force: true }));
  assert.equal(read(session)?.issue, 'ENG-1', 'a stronger hold later in the scan');
});

test('the agent gate hook never lifts a session from a transcript outside the account home, nor on a subagent\'s call', async (t) => {
  const dir = project(t);
  const session = 'feed000c-0000-4000-8000-00000000000c';
  const projects = path.join(TEST_HOME, '.claude', 'projects', '-y');
  mkdirSync(projects, { recursive: true });
  const transcript = path.join(projects, `${session}.jsonl`);
  t.after(() => rmSync(transcript, { force: true }));
  const typed = { type: 'user', isSidechain: false, entrypoint: 'cli', origin: { kind: 'human' }, turnOrigin: 'human', turnPosition: { promptIndex: 2, turnIndex: 2 }, message: { role: 'user', content: 'go' } };
  writeFileSync(transcript, `${JSON.stringify(typed)}\n`);
  assert.ok(markUnattended(session, { root: dir }));
  // The hook runs in this process: a HOME pointed elsewhere moves no trust, since the adapter reads the account's home.
  const saved = { HOME: process.env.HOME, CLAUDECODE: process.env.CLAUDECODE };
  Object.assign(process.env, { HOME: TEST_HOME, CLAUDECODE: '1' });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const run = (input) => hookCall(HOOK, { input: JSON.stringify({ session_id: session, cwd: dir, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'true' }, ...input }), cwd: dir, encoding: 'utf8' });
  assert.equal((await run({ agent_id: 'a5f0c1', agent_type: 'aidrian:explorer' })).status, 0);
  assert.equal((await run({})).status, 0);
  assert.ok(readUnattendedMark(session, { home: TEST_HOME }), 'still held');
  assert.equal(humanPrompts({ session_id: session, transcript_path: transcript }), null, 'no transcript of the account home');
});
