// A session the background handoff route started stays held wherever its calls run: the gate's unattended mark
// (lib/unattended-mark.mjs) under the state root, which the agent gates hook reads on every call, with no project at the
// call's folder too, and the chain floor the hook also finds in the user's own store (lib/handoff-guard.mjs
// startedUnattended). No test starts a real session. Temporary repositories are made with `git init` under mkdtemp and
// driven with `git -C`; no test sets GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { startedUnattended } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { noteFrom, openStore, storePath } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { defaultStateDir, findProject, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { GIT_VARS } from '../plugins/aidrian/lib/review/env.mjs';
import { dropPending, MARK_AGE, markFolder, markPending, markUnattended, PENDING_AGE, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';

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

test('a marked session is held from a folder outside its project, and in another project, before any refusal; an attended one is not', (t) => {
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
  const run = (session, command, { cwd = outside, agent = false } = {}) => spawnSync(process.execPath, [HOOK], {
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
      const result = run(session, command);
      assert.equal(result.status, 2, `${session}: ${command}`);
      assert.match(result.stderr, reason, command);
      assert.match(result.stderr, /the background handoff route started this (?:session|one), with no Human/u, command);
    }
    for (const command of allowed) assert.equal(run(session, command).status, 0, `${session}: ${command}`);
    // In another project, the marked project's store and switches stay guarded.
    assert.equal(run(session, `rm ${store}/from-${full}.json`, { cwd: other }).status, 2, `${session}: the marked project's store from another project`);
    assert.equal(run(session, `echo '{"handoff":{"background":"on"}}' > ${dir}/.aidrian.local.json`, { cwd: other }).status, 2, `${session}: a switch from another project`);
    assert.equal(run(session, 'claude -p x', { cwd: other }).status, 2, `${session}: a start from another project`);
    assert.equal(run(session, `rm -f ${other}/src/app.js`, { cwd: other }).status, 0, session);
  }
  assert.equal(run(gone, 'claude -p x').status, 2, 'a mark whose project is gone');
  assert.equal(run(gone, `rm ${marks}/${gone}.json`).status, 2, 'its own mark');
  assert.equal(run(gone, 'ls').status, 0);
  // An attended session may do all of it; a subagent of it may not change the marks.
  for (const [command] of refused) assert.equal(run('plain-session', command).status, 0, `attended: ${command}`);
  assert.equal(run('plain-session', `rm ${marks}/${full}.json`, { agent: true }).status, 2, 'a subagent may not delete a mark');
  assert.equal(run('plain-session', `printf x > ${marks}/plain-session.json`, { agent: true, cwd: dir }).status, 2, 'nor forge one, in a project');
  // The marks are still there: every refusal was judged before the call ran.
  assert.deepEqual(readUnattendedMark(full), { root: dir });
});

test('while the gate starts a session, every session the host had not listed and with no mark of its own is held, in whatever folder it works', (t) => {
  const dir = project(t);
  const outside = folder(t, 'aidrian-outside-');
  const old = 'feed0004-0000-4000-8000-000000000004';
  const fresh = 'cafe0005-0000-4000-8000-000000000005';
  const listed = 'beef0006-0000-4000-8000-000000000006';
  const pending = markPending(old, { cwd: dir, root: dir, known: [old, listed] });
  assert.ok(pending);
  t.after(() => dropPending(pending));
  const run = (session, command, cwd = dir) => spawnSync(process.execPath, [HOOK], {
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
      const result = run(fresh, command, cwd);
      assert.equal(result.status, 2, `${cwd}: ${command}`);
      assert.match(result.stderr, reason, command);
      assert.match(result.stderr, /the background handoff route started this (?:session|one), with no Human/u, command);
    }
    assert.equal(run(old, command).status, 0, `the session that ran the gate: ${command}`);
    assert.equal(run(listed, command).status, 0, `a session the host listed before the start: ${command}`);
  }
  assert.equal(run(fresh, 'ls').status, 0);
  assert.equal(run(fresh, 'ls', outside).status, 0, 'a held session still works');

  // A pending mark that names no listing holds every session but the gate's.
  const unlisted = markPending(old, { cwd: dir, root: dir });
  assert.equal(unlisted, pending, 'the same gate\'s mark, written again');
  assert.equal(run(listed, 'claude --bg x', outside).status, 2, 'with no listing, a session cannot show it was there before');
  assert.equal(run(old, 'claude --bg x', outside).status, 0);

  // A pending mark lapses after PENDING_AGE; one it cannot read holds every session.
  const lapsed = (Date.now() - PENDING_AGE - 60_000) / 1000;
  utimesSync(pending, lapsed, lapsed);
  assert.equal(run(fresh, 'claude --bg x').status, 0, 'a lapsed pending mark holds nobody');
  writeFileSync(pending, 'not json');
  assert.equal(run(fresh, 'claude --bg x', outside).status, 2, 'an unreadable pending mark holds every session');
  assert.ok(dropPending(pending));
  assert.equal(run(fresh, 'claude --bg x').status, 0, 'once the gate removed it, nobody');
});

test('a subagent and a marked session may not repoint a git remote or gh\'s default repository; reads, and an attended session, may', (t) => {
  const dir = project(t);
  const outside = folder(t, 'aidrian-outside-');
  const marked = 'feed0006-0000-4000-8000-000000000006';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command, { cwd = dir, agent = false } = {}) => spawnSync(process.execPath, [HOOK], {
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
      const result = run(session, command, options);
      assert.equal(result.status, 2, `${who}: ${command}`);
      assert.match(result.stderr, /changes which repository the checkout's git remotes or gh's default name, or how git reads them, where the plugin reads the team's policy on the forge, such as solo/u, `${who}: ${command}`);
    }
    for (const command of allowed) assert.equal(run(session, command, options).status, 0, `${who}: ${command}`);
  }
  for (const command of refused) assert.equal(run('plain-session', command).status, 0, `attended: ${command}`);
});

test('a subagent and a marked session may not erase the machine\'s local file by any Bash write, though it names no key', (t) => {
  // The project has no gates: the guard holds without them.
  const dir = project(t);
  const local = path.join(dir, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ unattendedSignoff: 'off' }));
  const marked = 'feed0007-0000-4000-8000-000000000007';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command, { agent = false } = {}) => spawnSync(process.execPath, [HOOK], {
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
      const result = run(session, command, options);
      assert.equal(result.status, 2, `${who}: ${command}`);
      assert.match(result.stderr, /it writes, moves, links, or removes \.aidrian\.local\.json, or may, which holds the machine's switches/u, `${who}: ${command}`);
    }
    assert.equal(run(session, `cat ${local}`, options).status, 0, `${who}: a read`);
    for (const command of [`cp ${local} ${dir}/copy.json`, 'git clean -fd', 'git stash', 'F=notes.txt; rm "$F"']) assert.equal(run(session, command, options).status, 0, `${who}: ${command}`);
    assert.equal(run(session, 'rm -f notes.txt', options).status, 0, `${who}: another file`);
  }
  for (const command of refused) assert.equal(run('plain-session', command).status, 0, `attended: ${command}`);
});

test('a marked session may not run the handoff gate with a variable that moves the repository git reads, or gh\'s config', (t) => {
  const dir = project(t);
  const marked = 'feed0008-0000-4000-8000-000000000008';
  assert.ok(markUnattended(marked, { root: dir }));
  const run = (session, command) => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd: dir }), cwd: dir, encoding: 'utf8',
  });
  // Any variable, not only the ones that move what the gate reads.
  for (const name of [...GIT_VARS, 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'NODE_OPTIONS', 'HTTPS_PROXY']) {
    const result = run(marked, `${name}=/tmp/elsewhere aidrian handoff continue b.md`);
    assert.equal(result.status, 2, name);
    assert.match(result.stderr, new RegExp(`with ${name} set or unset by the command itself`, 'u'), name);
    assert.equal(run('plain-session', `${name}=/tmp/elsewhere aidrian handoff continue b.md`).status, 0, `attended: ${name}`);
  }
  const exported = run(marked, 'export NODE_OPTIONS=--require=/tmp/x.js; aidrian handoff route');
  assert.equal(exported.status, 2);
  assert.match(exported.stderr, /with NODE_OPTIONS set or unset by the command itself/u);
  assert.equal(run(marked, 'aidrian handoff route').status, 0, 'with no variable');
});
