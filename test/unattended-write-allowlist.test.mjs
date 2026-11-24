// The write allowlist of a session no Human attends (lib/unattended-write.mjs unattendedWriteDenial), told by its
// unattended mark through the hook payload's session id: it writes only its own worktree or attempt folders, the state
// folders it writes by hand, and the temporary folder, and never a git folder, the user's or the system's git config, a
// shell startup file, another dot file of the home folder, a review or attest record, or the dispatch records; a
// pending or unreadable hold keeps only the entries refused wherever they lie. An attended session, and its subagents, are
// never held. An attempt clone links to its run's main checkout only for the session whose mark names its run and issue
// (lib/attempt-clone.mjs), in a state folder its project names, and while its `.git` points at its own git folder.
// Every read here is in-process with the test's own home folder, except the hook runs, which spawn the real hook.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { anchorClones, cloneConfigProblem, cloneGitProblem, GIT_PLACEHOLDERS } from '../plugins/aidrian/lib/attempt-clone.mjs';
import { noteStarted, openStore, startedFolders } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { PastDeadline, withinDeadline } from '../plugins/aidrian/lib/deadline.mjs';
import { committedConfig } from '../plugins/aidrian/lib/config-committed.mjs';
import { foldCase, isWithin } from '../plugins/aidrian/lib/fs.mjs';
import { protectedPaths } from '../plugins/aidrian/lib/hosts/index.mjs';
import { runGit } from '../plugins/aidrian/lib/git.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { unattendedPlaces, unattendedWriteDenial } from '../plugins/aidrian/lib/unattended-write.mjs';
import { shellWrites } from '../plugins/aidrian/lib/unattended-shell.mjs';
import { findProject, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { placeHolders } from '../plugins/aidrian/lib/project-start.mjs';
import { markPending, markUnattended, readUnattendedMark } from '../plugins/aidrian/lib/unattended-mark.mjs';

import { factReads, gitLog, tally } from './git-call-log.mjs';
import { hookCall } from './hook-call.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const WRITE_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-write.mjs');
const SESSION = 'feed00aa-0000-4000-8000-0000000000aa';
const LOCAL = '.aidrian.local.json';

const gitIn = (dir) => (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { encoding: 'utf8', stdio: 'pipe' });

function tempRoot(t, prefix) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

// A path as the places keep it: real, and in the case the disk folds to.
const realFolded = (file) => foldCase(realpathSync(file));

// A project on `main` with a linked worktree, a state folder, a home folder, a temporary folder, an XDG config folder,
// a system git config git names through GIT_CONFIG_SYSTEM, and an attempt folder; the session SESSION marked unattended
// in it. `env` is what the hook reads: the marks' state root, XDG_CONFIG_HOME, and the system git config.
function fixture(t) {
  const root = tempRoot(t, 'aidrian-allow-');
  const [dir, state, home, temp, xdg, worktree] = ['main', 'state', 'home', 'tmp', 'xdg', 'wt'].map((name) => path.join(root, name));
  const system = path.join(root, 'etc', 'gitconfig');
  for (const each of [dir, state, home, temp, xdg, path.dirname(system)]) mkdirSync(each, { recursive: true });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  writeFileSync(path.join(dir, 'README.md'), '# widgets\n');
  const git = gitIn(dir);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  git('worktree', 'add', '-q', '-b', 'feat/x', worktree);
  const attempt = path.join(state, 'runs', 'launch', 'attempts', 'ENG-1.1');
  for (const name of ['work', 'git', 'drop', 'cache']) mkdirSync(path.join(attempt, name), { recursive: true });
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks'), XDG_CONFIG_HOME: xdg, GIT_CONFIG_SYSTEM: system, HOME: home, TMPDIR: temp };
  delete env.GIT_CONFIG_NOSYSTEM;
  delete env.ZDOTDIR;
  assert.ok(markUnattended(SESSION, { root: dir, cwd: worktree, env }));
  const mark = readUnattendedMark(SESSION, { env, home });
  const project = findProject(dir);
  const { config } = loadConfig(project);
  // The guard as the agent gate hook asks it, for the session's call in `cwd`.
  const ask = (input, { held = mark, cwd = worktree, own = null, places, owner = project } = {}) => unattendedWriteDenial({ session_id: SESSION, cwd, ...input }, config, {
    mark: held,
    env,
    places: places ?? (() => unattendedPlaces({ cwd, mark: held, project: owner, config, env, home, temp: [temp], own, session: SESSION })),
  });
  // The same guard with the places read once, for a test that changes no checkout, mark, or state folder between its
  // asks: the hook reads them for every call, which runs git. A held mark's places do not depend on the call's folder
  // (placesOf reads `cwd` only for a limited mark), so a call may still name its own.
  const steady = ({ own = null } = {}) => {
    let found;
    const places = () => (found ??= unattendedPlaces({ cwd: worktree, mark, project, config, env, home, temp: [temp], own, session: SESSION }));
    return (input, { cwd = worktree } = {}) => ask(input, { cwd, places });
  };
  return { root, dir, state, home, temp, xdg, worktree, system, attempt, env, mark, project, config, ask, steady };
}

const write = (file, more = {}) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, ...more });
const bash = (command, more = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...more });

// The refused writes of the fixture `fx`, each with what its reason must say.
const refusedOf = (fx) => [
  [path.join(fx.dir, '.git', 'config'), /the repository's shared git config/u],
  [path.join(fx.dir, '.git', 'hooks', 'pre-commit'), /the repository's shared git hooks/u],
  [path.join(fx.worktree, '.git'), /the checkout's pointer to its git folder/u],
  [path.join(fx.home, '.gitconfig'), /the user's git config/u],
  [path.join(fx.xdg, 'git', 'config'), /the user's git config/u],
  // Outside every place, the system's git config is refused before git is asked to name it.
  [fx.system, /the system's git config|outside the places/u],
  [path.join(fx.home, '.zshrc'), /a shell startup file/u],
  [path.join(fx.home, '.bashrc'), /a shell startup file/u],
  [path.join(fx.home, '.profile'), /a shell startup file/u],
  // The host's user-level settings and instruction files: outside every place, whichever host.
  [path.join(fx.home, '.claude', 'settings.json'), /a dot file or folder of the user's home folder/u],
  [path.join(fx.home, '.codex', 'config.toml'), /a dot file or folder of the user's home folder/u],
  [path.join(fx.root, 'elsewhere', 'notes.md'), /outside the places a session no Human attends may write/u],
];

test('a session no Human attends may not write git config or hooks, the user\'s or system\'s git config, or a startup file, by the write tool or the shell', (t) => {
  const fx = fixture(t);
  for (const [file, reason] of refusedOf(fx)) {
    for (const input of [write(file), bash(`echo x >> ${file}`), bash(`cp /dev/null ${file}`), bash(`printf x | tee ${file}`), write(file, { agent_id: 'a5f0c1' })]) {
      const denial = fx.ask(input);
      assert.ok(denial, `${input.tool_name} ${input.tool_input.command ?? file}`);
      assert.match(denial.reason, reason, file);
    }
  }
  // Code an interpreter runs, which names the file only in its text.
  assert.match(fx.ask(bash(`python3 -c "open('${fx.home}/.zshrc', 'a').write('x')"`))?.reason ?? '', /a shell startup file/u);
  // A target in a folder no path gives, by its name.
  assert.match(fx.ask(bash('cd "$X" && echo x >> .bashrc'))?.reason ?? '', /names a shell startup file, a git config/u);
  // A glob that may reach a startup file.
  assert.ok(fx.ask(bash(`rm -f ${fx.home}/.z*`)));
});

test('a session no Human attends may run interpreter code that only reads a file in a home dot folder, but not code that writes one', (t) => {
  const fx = fixture(t);
  const file = path.join(fx.home, '.local', 'state', 'aidrian', 'projects', 'p', 'tmp', 'review-7-r2-plan.json');
  for (const code of [`require("${file}")`, `const r=require("${file}"); console.log(r.status)`, `const r = require("${file}"); console.log(JSON.stringify(r.open, null, 2))`]) {
    assert.equal(fx.ask(bash(`node -e '${code}'`)), null, code);
  }
  assert.match(fx.ask(bash(`node -e 'require("fs").writeFileSync("${file}", "")'`))?.reason ?? '', /a dot file or folder of the user's home folder/u);
  assert.match(fx.ask(bash(`node -e 'const r=require("${file}"); require("fs").writeFileSync("${file}", "")'`))?.reason ?? '', /a dot file or folder of the user's home folder/u);
});

test('a file tool`s `~` path is the home folder, as the host resolves it: a write to ~/.zshrc or ~/.gitconfig is refused', (t) => {
  const fx = fixture(t);
  const saved = process.env.HOME;
  process.env.HOME = fx.home;
  t.after(() => (saved === undefined ? delete process.env.HOME : (process.env.HOME = saved)));
  assert.ok(fx.ask(write('~/.zshrc')), 'Write ~/.zshrc');
  assert.ok(fx.ask({ tool_name: 'Edit', tool_input: { file_path: '~/.gitconfig', old_string: 'a', new_string: 'b' } }), 'Edit ~/.gitconfig');
  assert.ok(fx.ask({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '~/x.ipynb', new_source: 'x' } }), 'NotebookEdit ~/x.ipynb');
  // A `~` that is not the whole first part is a plain name: a file in the call's folder.
  assert.equal(fx.ask(write('~notes.md')), null);
  assert.equal(fx.ask(write(path.join(fx.worktree, 'notes.md'))), null);
});

test('the system git config is the one git names, wherever it was built to keep it', (t) => {
  const fx = fixture(t);
  const elsewhere = path.join(fx.root, 'opt', 'homebrew', 'etc', 'gitconfig');
  mkdirSync(path.dirname(elsewhere), { recursive: true });
  const env = { ...fx.env, GIT_CONFIG_SYSTEM: elsewhere };
  // Inside the temporary folder, where every other write passes: only git's name for it refuses it.
  const places = () => unattendedPlaces({ cwd: fx.worktree, mark: fx.mark, project: fx.project, config: fx.config, env, home: fx.home, temp: [fx.root] });
  assert.match(fx.ask(write(elsewhere), { places })?.reason ?? '', /the system's git config/u);
  assert.equal(fx.ask(write(path.join(fx.root, 'opt', 'notes.md')), { places }), null);
});

test('a session no Human attends writes its own worktree, its attempt\'s work and drop folders, the state folders it writes by hand, and the temporary folder', (t) => {
  const fx = fixture(t);
  const own = () => fx.attempt;
  const allowed = [
    path.join(fx.worktree, 'src', 'export.js'),
    ...['plans', 'tmp', 'handoffs', 'quorum'].map((name) => path.join(fx.state, name, 'x.md')),
    path.join(fx.state, 'dispatch', 'feat-x-S1-explorer.json'),
    path.join(fx.state, 'quorum', 'product', 'ledger.md'),
    path.join(fx.state, 'reviews', 'pr-7.json'),
    path.join(fx.state, 'reviews', '.pr-7.json.tmp'),
    path.join(fx.state, 'reviews', 'pr-7', 'captures', 'abc', 'home.png'),
    path.join(fx.temp, 'scratch.txt'),
    ...['work', 'drop', 'cache'].map((name) => path.join(fx.attempt, name, 'x.json')),
  ];
  for (const file of allowed) {
    mkdirSync(path.dirname(file), { recursive: true });
    for (const input of [write(file), bash(`echo x > ${file}`)]) {
      // The shell may not write the manifest itself, only rename a copy over it (see the attest-record test).
      if (input.tool_name === 'Bash' && path.basename(file) === 'pr-7.json') continue;
      assert.equal(fx.ask(input, { own }), null, `${input.tool_name} ${file}`);
    }
  }
  assert.equal(fx.ask(bash('cp notes.md .')), null, 'a copy into its worktree');
  assert.equal(fx.ask(bash(`rm -f ${fx.worktree}/*.log`)), null, 'a glob in its worktree');
  // Its attempt's git folder and its work folder's pointer stay refused.
  for (const [file, reason] of [['git/config', /the attempt clone's git config/u], ['git/hooks/pre-push', /the attempt clone's git hooks/u], ['git/x.json', /the attempt clone's git folder/u], ['work/.git', /the attempt clone's pointer/u]]) {
    assert.match(fx.ask(write(path.join(fx.attempt, file)), { own })?.reason ?? '', reason, file);
  }
  // Without its attempt, those folders are no place of the session's.
  assert.match(fx.ask(write(path.join(fx.attempt, 'work', 'x.json')))?.reason ?? '', /outside the places/u);
  // Another checkout, of another repository, is not its worktree.
  const other = path.join(fx.root, 'other');
  mkdirSync(other);
  gitIn(other)('init', '-q', '-b', 'main');
  assert.match(fx.ask(write(path.join(other, 'a.txt')), { cwd: other })?.reason ?? '', /outside the places/u);
});

test('a state work folder that is a link is no place of the session\'s', (t) => {
  const fx = fixture(t);
  const target = path.join(fx.root, 'elsewhere');
  mkdirSync(target);
  symlinkSync(target, path.join(fx.state, 'plans'));
  assert.match(fx.ask(write(path.join(fx.state, 'plans', 'x.md')))?.reason ?? '', /outside the places/u);
});

test('an attended session and its subagents are not held, whatever they write', (t) => {
  const fx = fixture(t);
  for (const [file] of refusedOf(fx)) {
    for (const input of [write(file), bash(`echo x >> ${file}`), write(file, { agent_id: 'a5f0c1' })]) assert.equal(fx.ask(input, { held: null }), null, file);
  }
  assert.equal(fx.ask(bash('git config --global user.name x && claude mcp add x y && crontab f'), { held: null }), null, 'programs');
});

test('the guard fails closed when a session\'s own mark names no project its places can be told from', (t) => {
  const fx = fixture(t);
  const held = { root: path.join(fx.root, 'no-such-project') };
  assert.match(fx.ask(write(path.join(fx.worktree, 'a.txt')), { held, owner: null })?.reason ?? '', /the places this session may write cannot be told/u);
  assert.equal(fx.ask(bash('ls -la')), null, 'a call that writes nothing is not asked');
});

test('a pending or unreadable hold refuses only the entries refused wherever they lie, and says a start is in progress', (t) => {
  const fx = fixture(t);
  const other = path.join(fx.root, 'other');
  mkdirSync(other);
  gitIn(other)('init', '-q', '-b', 'main');
  for (const [held, owner, said] of [[{ root: fx.dir, cwd: fx.worktree, pending: true }, fx.project, /a project start is in progress/u], [{ root: null }, null, /its unattended mark cannot be read/u]]) {
    const label = JSON.stringify(held);
    // Another session's own work, in another repository or anywhere outside the home folder's dot entries, passes.
    for (const file of [path.join(other, 'a.txt'), path.join(fx.root, 'elsewhere', 'b.md'), path.join(fx.worktree, 'src.js')]) {
      assert.equal(fx.ask(write(file), { held, owner, cwd: other }), null, `${label} ${file}`);
    }
    assert.equal(fx.ask(bash(`echo x > "$TMPDIR/x" && echo y > "$UNSET_DIR/notes.md"`), { held, owner, cwd: other }), null, `${label} a variable target outside the refused names`);
    // The entries refused wherever they lie stay refused.
    for (const [input, reason] of [
      [write(path.join(other, '.git', 'config')), /shared git config/u],
      [write(path.join(other, '.git', 'hooks', 'pre-commit')), /shared git hooks/u],
      [write(path.join(fx.home, '.gitconfig')), /the user's git config/u],
      [write(fx.system), /the system's git config/u],
      [bash(`echo x >> ${fx.home}/.zshrc`), /a shell startup file/u],
      [write(path.join(fx.home, '.claude', 'settings.json')), /a dot file or folder/u],
      [bash('echo x >> "$UNSET_DIR/.bashrc"'), /names a shell startup file/u],
      [bash('git config --global user.name x'), /the user's git config/u],
      [write(path.join(fx.home, 'Library', 'LaunchAgents', 'com.x.plist')), /the user's launch agents/u],
      [write(path.join(fx.home, '.claude', 'projects', '-x', 'feed0000-0000-4000-8000-000000000001.jsonl')), /the host's session transcripts/u],
    ]) {
      const denial = fx.ask(input, { held, owner, cwd: other });
      assert.match(denial?.reason ?? '', reason, `${label} ${input.tool_input.command ?? input.tool_input.file_path}`);
      assert.match(denial.reason, said, label);
    }
  }
  // A pending hold's state folders pass among the home folder's dot entries.
  const state = path.join(fx.home, '.local', 'state', 'p');
  writeFileSync(path.join(fx.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  const project = findProject(fx.dir);
  const held = { root: fx.dir, cwd: fx.worktree, pending: true };
  const places = () => unattendedPlaces({ cwd: other, mark: held, project, config: loadConfig(project).config, env: fx.env, home: fx.home, temp: [fx.temp] });
  assert.equal(fx.ask(write(path.join(state, 'plans', 'x.md')), { held, places, cwd: other }), null);
  assert.match(fx.ask(write(path.join(fx.home, '.local', 'other.md')), { held, places, cwd: other })?.reason ?? '', /a dot file or folder/u);
  // Its audits folder passes but for the triage record, which a removal of the whole state folder also meets.
  assert.equal(fx.ask(write(path.join(state, 'audits', 'host-2026-11-22.md')), { held, places, cwd: other }), null);
  assert.match(fx.ask(write(path.join(state, 'audits', 'triage.json')), { held, places, cwd: other })?.reason ?? '', /triage record/u);
  assert.match(fx.ask(bash(`rm -rf ${state}`), { held, places, cwd: other })?.reason ?? '', /triage record/u);
  // A mark that cannot be read may be an issue session's: none of the audits folder passes.
  const unread = { root: null };
  const unreadPlaces = () => unattendedPlaces({ cwd: other, mark: unread, project, config: loadConfig(project).config, env: fx.env, home: fx.home, temp: [fx.temp] });
  assert.match(fx.ask(write(path.join(state, 'audits', 'host-2026-11-22.md')), { held: unread, places: unreadPlaces, cwd: other })?.reason ?? '', /issue session never writes/u);
});

test('a persona audit\'s report, sidecar, and screenshots pass by hand, and its triage record never does', (t) => {
  const fx = fixture(t);
  const audits = path.join(fx.state, 'audits');
  mkdirSync(audits, { recursive: true });
  // A persona may be named anything a file is, `triage.json` included: only the record, its lock, and its copies refuse.
  for (const name of ['host-2026-11-22.md', 'host-2026-11-22.json', 'host-2026-11-22/home.png', 'triage.json-2026-11-22.md', 'triage.json.md']) {
    const file = path.join(audits, name);
    for (const input of [write(file), bash(`echo x > ${file}`)]) assert.equal(fx.ask(input), null, name);
  }
  for (const name of ['triage.json', 'triage.json.lock', 'triage.json.lock.3', 'triage.json.lock.3.released', 'triage.json.123.tmp', 'TRIAGE.JSON']) {
    const file = path.join(audits, name);
    for (const input of [write(file), bash(`echo x > ${file}`), bash(`rm -f ${file}`)]) assert.match(fx.ask(input)?.reason ?? '', /triage record/u, name);
  }
  assert.match(fx.ask(bash(`rm -rf ${audits}`))?.reason ?? '', /triage record/u);
  assert.ok(fx.ask(bash(`rm -rf ${fx.state}`)), 'the whole state folder');
  // A hard link to the record, made before, is the record.
  writeFileSync(path.join(audits, 'triage.json'), '{}\n');
  mkdirSync(path.join(fx.state, 'tmp'), { recursive: true });
  linkSync(path.join(audits, 'triage.json'), path.join(fx.state, 'tmp', 'alias.json'));
  assert.match(fx.ask(write(path.join(fx.state, 'tmp', 'alias.json')))?.reason ?? '', /triage record/u);
  // A project run's issue session writes none of the audits folder.
  assert.match(fx.ask(write(path.join(audits, 'host-2026-11-22.md')), { held: { root: fx.dir, project: 'launch', issue: 'ENG-1' } })?.reason ?? '', /issue session never writes/u);
});

test('a state folder inside the session\'s own worktree keeps its triage record, and an audits folder that is a checkout grants nothing', (t) => {
  const fx = fixture(t);
  const state = path.join(fx.worktree, '.state');
  mkdirSync(state, { recursive: true });
  writeFileSync(path.join(fx.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  let project = findProject(fx.dir);
  let places = () => unattendedPlaces({ cwd: fx.worktree, mark: fx.mark, project, config: loadConfig(project).config, env: fx.env, home: fx.home, temp: [fx.temp] });
  assert.equal(fx.ask(write(path.join(state, 'audits', 'host-2026-11-22.md')), { places }), null);
  assert.equal(fx.ask(bash(`mkdir -p ${path.join(state, 'audits')}`), { places }), null, 'a fresh audits folder');
  mkdirSync(path.join(state, 'audits'));
  assert.equal(fx.ask(bash(`mkdir -p ${path.join(state, 'audits')}`), { places }), null, 'an audits folder already there');
  assert.match(fx.ask(bash(`rmdir ${path.join(state, 'audits')}`), { places })?.reason ?? '', /triage record/u, 'a removal of it');
  assert.match(fx.ask(write(path.join(state, 'audits', 'triage.json')), { places })?.reason ?? '', /triage record/u);
  // Another checkout of the repository at `<state>/audits`: the audits grant never reaches into it.
  const other = path.join(fx.root, 'other-state');
  mkdirSync(other);
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/audits', path.join(other, 'audits'));
  writeFileSync(path.join(fx.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: other } }));
  project = findProject(fx.dir);
  places = () => unattendedPlaces({ cwd: fx.worktree, mark: fx.mark, project, config: loadConfig(project).config, env: fx.env, home: fx.home, temp: [fx.temp] });
  assert.ok(fx.ask(write(path.join(other, 'audits', 'README.md')), { places }), 'a checkout at the audits folder');
});

test('a target in /dev passes, by its spelled path', (t) => {
  const fx = fixture(t);
  for (const command of ['make 2>/dev/null', 'make >/dev/null 2>&1', 'echo x > /dev/stderr', 'echo x > /dev/stdout', 'echo x > /dev/tty', 'echo x > /dev/fd/2', 'cp /dev/null /dev/null']) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
  assert.ok(fx.ask(bash('echo x > /dev/disk0')), 'another device');
});

test('a target built from a variable is expanded from the hook\'s environment, and refused when it cannot be', (t) => {
  const fx = fixture(t);
  mkdirSync(path.join(fx.xdg, 'git'), { recursive: true });
  const refused = [
    ['echo x >> "$HOME/.zshrc"', /a shell startup file/u],
    ['cp f ${HOME}/.gitconfig', /the user's git config/u],
    ['echo x >> $HOME/.claude/settings.json', /a dot file or folder/u],
    ['echo x | tee "$XDG_CONFIG_HOME/git/config"', /the user's git config/u],
    ['echo x > "$(git rev-parse --git-common-dir)/hooks/pre-commit"', /a git folder git names/u],
    ['echo x > "$(git rev-parse --git-path hooks)/pre-push"', /a git folder git names/u],
    ['HOME=/tmp; echo x >> "$HOME/.zshrc"', /names a shell startup file/u],
    ['echo x > "$HOME/notes.md"', /outside the places/u],
    ['echo x > /etc/$name', /outside the places/u],
    [`echo x > ${fx.dir}/.git/$name`, /the repository's shared git folder/u],
    ['echo x > "$X/.bashrc"', /names a shell startup file/u],
  ];
  for (const [command, reason] of refused) assert.match(fx.ask(bash(command))?.reason ?? '', reason, command);
  assert.equal(fx.ask(bash('echo x > "$TMPDIR/scratch.txt"')), null, 'the temporary folder, by its variable');
  // A target with no literal path before its variable is judged by its names alone.
  for (const command of ['echo x > "$OUT"', 'for f in a.md b.md; do sed -i \'\' s/a/b/ "$f"; done', 'out=$(mktemp); npm test > "$out"', 'mkdir -p "$dir"', `echo x > ${fx.worktree}/build-$n.log`, `echo x > "${fx.temp}/$name"`]) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
  const zdot = path.join(fx.temp, 'zdot');
  const env = { ...fx.env, ZDOTDIR: zdot };
  const places = () => unattendedPlaces({ cwd: fx.worktree, mark: fx.mark, project: fx.project, config: fx.config, env, home: fx.home, temp: [fx.temp] });
  const denial = unattendedWriteDenial({ session_id: SESSION, cwd: fx.worktree, ...bash('echo x >> "$ZDOTDIR/.zshrc"') }, fx.config, { mark: fx.mark, env, places });
  assert.match(denial?.reason ?? '', /a shell startup file/u, 'ZDOTDIR, inside the temporary folder');
});

test('a program that writes its own config is refused to a session no Human attends', (t) => {
  const fx = fixture(t);
  const ask = fx.steady();
  const refused = [
    ['git config --global user.name x', /the user's git config/u],
    ['git config --system core.editor vi', /run a program/u],
    ['git config --system color.ui true', /the system's git config/u],
    ['git config user.name x', /the repository's shared git config/u],
    ['git -C .. config --worktree user.name x', /the worktree's git config/u],
    ['git config --file ~/.gitconfig user.name x', /the user's git config/u],
    [`git config --file ${path.join(fx.temp, 'c')} core.hooksPath /x`, /run a program/u],
    [`git config --file ${path.join(fx.temp, 'c')} alias.x '!sh'`, /run a program/u],
    ['git config --edit', /run a program/u],
    ['git config set --global user.email a@b.c', /the user's git config/u],
    [`git worktree add ${path.join(fx.root, 'elsewhere')}`, /outside the places/u],
    [`git clone https://example.invalid/x.git ${path.join(fx.home, '.x')}`, /a dot file or folder/u],
    [`git -C ${fx.root} clone https://example.invalid/x.git`, /outside the places/u],
    [`git init ${path.join(fx.root, 'fresh')}`, /outside the places/u],
    ['git init', /pointer to its git folder/u],
    ['gh auth setup-git', /the user's git config/u],
    ['claude mcp add srv -- npx srv', /the host's own config/u],
    ['claude config set -g theme dark', /the host's own config/u],
    ['claude plugin install x', /the host's own config/u],
    ['claude plugin marketplace add o/r', /the host's own config/u],
    ['codex mcp add srv -- npx srv', /the host's own config/u],
    ['codex login', /the host's own config/u],
    ['npm config set registry https://example.invalid', /the user's config of npm/u],
    ['pnpm config set x y', /the user's config of pnpm/u],
    ['yarn config set x y', /the user's config of yarn/u],
    ['npm set x=y', /the user's config of npm/u],
    ['gh config set editor vi', /the forge CLI's own config/u],
    ['gh extension install o/gh-x', /the forge CLI's own config/u],
    ['crontab jobs.txt', /scheduled jobs/u],
    ['launchctl load ~/Library/LaunchAgents/x.plist', /launch jobs/u],
    ['defaults write com.x key 1', /the user's config of defaults/u],
    ['gh auth login --with-token', /the forge CLI's own login/u],
    ['gh auth logout', /the forge CLI's own login/u],
    ['gh auth switch -u other', /the forge CLI's own login/u],
    ['gh auth refresh -s repo', /the forge CLI's own login/u],
    ['gh -R o/r config set editor vi', /the forge CLI's own config/u],
    ['npm login', /the user's config of npm/u],
    ['npm adduser', /the user's config of npm/u],
    // Past a global option that takes a value, and through a package runner.
    ['codex --profile p login', /the host's own config/u],
    ['claude --settings f.json mcp add srv -- npx srv', /the host's own config/u],
    ['npx codex login', /the host's own config/u],
    ['npx -y @openai/codex@latest login', /the host's own config/u],
    ['pnpm dlx codex login', /the host's own config/u],
    ['bunx claude mcp add srv -- x', /the host's own config/u],
    ['yarn dlx codex mcp add srv -- x', /the host's own config/u],
    // OpenCode's: the config, credential, and pairing subcommands, and auth whole.
    ['opencode plugin add x', /the host's own config/u],
    ['opencode auth login', /the host's own config/u],
    ['opencode auth export', /the host's own config/u],
    ['opencode auth list', /the host's own config/u],
    // Past the value of an option the list does not name, by the two-word entries `auth` alone does not shadow.
    ['opencode --dir /x auth login', /the host's own config/u],
    ['opencode -m x auth switch', /the host's own config/u],
    ['opencode pair --remote', /the host's own config/u],
    ['opencode machine add m', /the host's own config/u],
    ['opencode machine remove m', /the host's own config/u],
    ['opencode --log-level debug mcp add srv -- npx srv', /the host's own config/u],
    ['opencode service set port 1', /the host's own config/u],
    ['opencode session import s.json', /the host's own config/u],
    ['opencode session delete ses_a', /the host's own config/u],
    ['opencode uninstall --force', /the host's own config/u],
    ['opencode upgrade', /the host's own config/u],
    ['opencode update 2.5.0', /the host's own config/u],
    ['opencode service stop', /the host's own config/u],
    // Through a package runner, by each host's own package name.
    ['npx @opencode/cli auth login', /the host's own config/u],
    ['npx -y @opencode/cli@2.4.0 plugin add x', /the host's own config/u],
    ['pnpm dlx @opencode/cli plugin add x', /the host's own config/u],
    ['npx opencode-ai plugin add x', /the host's own config/u],
    ['bunx opencode-ai mcp add srv -- x', /the host's own config/u],
    ['bunx opencode-ai mcp add s', /the host's own config/u],
    ['npx @anthropic-ai/claude-code mcp add s -- x', /the host's own config/u],
    // Past a runner's global option that takes the next word, before the runner's own word.
    ['npm --workspace web exec opencode plugin add x', /the host's own config/u],
    ['npm -w web exec opencode plugin add x', /the host's own config/u],
    ['npm -C /tmp/p x codex login', /the host's own config/u],
    ['npx --prefix /tmp/p codex login', /the host's own config/u],
    ['pnpm --dir web dlx @opencode/cli plugin add x', /the host's own config/u],
    ['pnpm -C web exec codex login', /the host's own config/u],
    ['pnpm --filter web exec opencode plugin add x', /the host's own config/u],
    // Past any option of the runner, one no list names too, before or after its own word, as npm's `--cache <dir>`.
    ['npm --cache /d exec codex login', /the host's own config/u],
    ['npm exec --cache /d claude mcp add s -- x', /the host's own config/u],
    ['npx --cache /d @anthropic-ai/claude-code mcp add s -- x', /the host's own config/u],
    ['pnpm --dir x dlx opencode-ai plugin add x', /the host's own config/u],
    ['yarn --cwd x dlx codex login', /the host's own config/u],
  ];
  for (const [command, reason] of refused) assert.match(ask(bash(command))?.reason ?? '', reason, command);
  for (const command of ['git config user.name', 'git config --get user.name', 'git config -l', 'git config get user.name', `git config --file ${path.join(fx.temp, 'c')} user.name x`,
    `git worktree add ${path.join(fx.temp, 'wt2')}`, `git clone https://example.invalid/x.git ${path.join(fx.temp, 'x')}`, 'crontab -l', 'launchctl list', 'defaults read com.x', 'claude mcp list', 'codex mcp list', 'npm config get registry', 'gh config get editor', 'gh auth status', 'codex --profile p exec x', 'npx prettier --check .', 'pnpm dlx create-x', 'pnpm install',
    'opencode mcp list', 'opencode plugin list', 'opencode machine list', 'opencode --version', 'opencode service status', 'npx @opencode/cli mcp list', 'npx @anthropic-ai/claude-code mcp list']) {
    assert.equal(ask(bash(command)), null, command);
  }
});

test('a git call that writes its output to a file names that file to the write allowlist, in every spelling', (t) => {
  const fx = fixture(t);
  const ref = path.join(fx.dir, '.git', 'refs', 'heads', 'feat', 'x');
  const elsewhere = path.join(fx.root, 'elsewhere');
  for (const [command, reason] of [
    [`git log -1 --format=%H --output=${ref} HEAD`, /git folder|shared git/u],
    [`git log -1 --format=%H --output ${ref} HEAD`, /git folder|shared git/u],
    [`git show --output=${path.join(elsewhere, 'x')} HEAD`, /outside the places/u],
    [`git diff --output ${path.join(fx.home, '.zshrc')}`, /a shell startup file/u],
    [`git -C ${fx.root} diff --output=x`, /outside the places/u],
    [`git format-patch -1 -o ${elsewhere}`, /outside the places/u],
    [`git format-patch -1 -o${elsewhere}`, /outside the places/u],
    [`git format-patch -1 -ko ${elsewhere}`, /outside the places/u],
    [`git format-patch -1 --output-directory=${elsewhere}`, /outside the places/u],
    [`git format-patch -1 --output-directory ${elsewhere}`, /outside the places/u],
    [`git archive -o ${path.join(elsewhere, 'a.tar')} HEAD`, /outside the places/u],
    [`git archive --output=${path.join(elsewhere, 'a.tar')} HEAD`, /outside the places/u],
    [`git archive --output ${path.join(fx.home, '.zshrc')} HEAD`, /a shell startup file/u],
    ['git log --output="$OUT" -1', /whose name is missing or built at run time/u],
    // Every leading -C moves the folder a relative name lies in, the last one included: the name lies in the last.
    [`git -C ${fx.worktree} -C ${path.join(fx.home, '.claude')} log -1 --output=settings.json`, /a dot file or folder of the user's home folder/u],
    [`git -C ${fx.worktree} -C ${path.join(fx.attempt, 'git')} log -1 --output=config`, /git folder|shared git|outside the places/u],
    [`git -C ${fx.worktree} -C ${path.join(fx.home, '.claude')} format-patch -1 -o out`, /a dot file or folder of the user's home folder/u],
    // git bundle create writes the file it names first, past its options.
    [`git bundle create ${path.join(elsewhere, 'all.bundle')} --all`, /outside the places/u],
    [`git bundle create -q --version=3 ${path.join(fx.home, '.zshrc')} HEAD`, /a shell startup file/u],
    [`git -C ${fx.worktree} -C ${path.join(fx.home, '.claude')} bundle create settings.json HEAD`, /a dot file or folder of the user's home folder/u],
    ['git bundle create "$OUT" HEAD', /whose name is missing or built at run time/u],
    ['git bundle create', /whose name is missing or built at run time/u],
  ]) assert.match(fx.ask(bash(command))?.reason ?? '', reason, command);
  for (const command of [`git log -1 --output=${path.join(fx.temp, 'log.txt')}`, `git format-patch -1 -o ${path.join(fx.temp, 'p')}`, 'git log --oneline -3', 'git diff --output-indicator-new=+ HEAD', 'git log -- --output=x', `git bundle create ${path.join(fx.temp, 'all.bundle')} --all`, 'git bundle create - HEAD', `git bundle verify ${path.join(fx.root, 'elsewhere', 'x.bundle')}`, `git -C ${fx.root} -C ${fx.worktree} log -1 --output=log.txt`]) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
});

test('a session no Human attends never publishes, withdraws, or changes a package or its owners on a registry', (t) => {
  const fx = fixture(t);
  const refused = [
    'npm publish', 'npm publish --access public', 'npm --registry https://registry.npmjs.org publish', 'npm unpublish x@1.0.0', 'npm dist-tag add x@1.0.0 latest',
    'npm deprecate x "gone"', 'npm owner add other x', 'npm access set status=public x', 'npm token create',
    'pnpm publish', 'pnpm -r publish', 'pnpm unpublish x', 'pnpm dist-tag add x@1 next', 'pnpm deprecate x y', 'pnpm owner add a x', 'pnpm access public x', 'pnpm token list',
    'yarn publish', 'yarn unpublish x', 'yarn dist-tag add x@1 next', 'yarn deprecate x y', 'yarn owner add a x', 'yarn access public x', 'yarn token list',
    'yarn npm publish', 'yarn npm tag add x@1 next', 'yarn npm login', 'yarn tag add x@1 next', 'yarn login',
    'bun publish', 'bun pm publish', 'bun unpublish x', 'bun dist-tag add x@1 next', 'bun deprecate x y', 'bun owner add a x', 'bun access public x', 'bun token list',
    'gem push x-1.0.0.gem', 'gem yank x -v 1.0.0', 'gem owner x -a a@b.c', 'gem signin',
    'cargo publish', 'cargo publish --registry r', 'cargo yank --version 1.0.0', 'cargo owner --add a', 'cargo login',
    'twine upload dist/*', 'python -m twine upload dist/*', 'python3 -m twine upload dist/*', 'uvx twine upload dist/*', 'pipx run twine upload dist/*', 'npx twine upload dist/*',
    'uv publish', 'uv publish --token x', 'poetry publish', 'poetry publish --build', 'npx npm publish',
    // Release tools, through a runner and npm's and pnpm's exec forms, and Ruby's release task.
    'lerna publish', 'npx lerna publish', 'pnpm dlx lerna publish', 'npx changeset publish', 'npx @changesets/cli publish', 'pnpm dlx @changesets/cli@2 publish',
    'npm exec -- lerna publish', 'npm exec lerna publish', 'npm x changeset publish', 'pnpm exec changeset publish', 'npm exec -- npm publish',
    'npx --package @changesets/cli npm publish', 'npm exec --package @changesets/cli -- npm publish',
    // A host's name later in the call, or as an option's value, leaves the real program's check in place.
    'npx npm publish codex', 'npx --package opencode-ai npm publish', 'npm exec -- npm publish claude',
    'bundle exec rake release', 'rake release',
    // Options before the subcommand, in any order and form.
    'pnpm --filter web publish', 'pnpm -F web publish', 'pnpm --filter=web publish', 'yarn workspace web publish', 'yarn workspace web npm publish',
    'cargo +nightly publish', 'npm --loglevel verbose publish', 'npm --registry=https://registry.npmjs.org publish',
  ];
  for (const command of refused) assert.match(fx.ask(bash(command))?.reason ?? '', /a package on a registry, or its owners/u, command);
  for (const command of ['npm install', 'npm ci', 'npm run publish-docs', 'npm view x', 'pnpm install', 'yarn install', 'yarn npm info x', 'bun install', 'gem install x', 'bundle install',
    'cargo build', 'cargo fetch', 'twine check dist/*', 'python -m pip install x', 'uv sync', 'uv add x', 'poetry install', 'npm pack',
    'npm owner ls x', 'npm dist-tag ls x', 'pnpm owner ls x', 'npm access list packages', 'lerna run build', 'npx changeset version', 'npm exec -- tsc',
    'bundle exec rake test', 'cargo +nightly build', 'yarn workspace web build']) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
});

test('an attempt\'s work, drop, or cache folder replaced by a link is no place of the session\'s, and writes through it are refused', (t) => {
  for (const name of ['cache', 'drop', 'work']) {
    const fx = fixture(t);
    const own = () => fx.attempt;
    const folder = path.join(fx.attempt, name);
    mkdirSync(path.join(fx.home, '.claude'), { recursive: true });
    assert.equal(fx.ask(write(path.join(folder, 'x.json')), { own }), null, `${name} as a plain folder`);
    rmSync(folder, { recursive: true, force: true });
    symlinkSync(path.join(fx.home, '.claude'), folder);
    for (const target of [path.join(folder, 'settings.json'), path.join(fx.home, '.claude', 'settings.json')]) {
      assert.match(fx.ask(write(target), { own })?.reason ?? '', new RegExp(`the attempt's ${name} folder, which is no plain folder but a link|a dot file or folder of the user's home folder`, 'u'), `${name}: ${target}`);
    }
    assert.match(fx.ask(write(path.join(folder, 'settings.json')), { own })?.reason ?? '', new RegExp(`the attempt's ${name} folder, which is no plain folder`, 'u'), name);
  }
  // The keep file that holds drop and cache in place is refused, by the write tool and the shell.
  const fx = fixture(t);
  const own = () => fx.attempt;
  for (const name of ['drop', 'cache']) {
    const keep = path.join(fx.attempt, name, '.keep-attempt');
    for (const input of [write(keep), bash(`rm -f ${keep}`)]) assert.match(fx.ask(input, { own })?.reason ?? '', /the keep file of an attempt's folder/u, `${input.tool_name} ${keep}`);
  }
});

test('the agent gate hook refuses a program that writes its own config to a marked session', async (t) => {
  const fx = fixture(t);
  const run = (command) => hookCall(HOOK, { input: JSON.stringify({ session_id: SESSION, cwd: fx.worktree, ...bash(command) }), cwd: fx.worktree, env: fx.env, encoding: 'utf8' });
  for (const command of ['git config --global user.name x', 'claude mcp add srv -- npx srv', 'codex login', 'npm config set x y', 'crontab jobs.txt', 'gh auth setup-git', 'defaults write com.x k 1', 'launchctl load x.plist']) {
    const result = await run(command);
    assert.equal(result.status, 2, `${command}: ${result.stderr}`);
  }
  assert.equal((await run('git config --get user.name')).status, 0);
});

test('a link a command makes is judged by the path it points at', (t) => {
  const fx = fixture(t);
  assert.match(fx.ask(bash('ln -s ~/.zshrc l && echo x >> l'))?.reason ?? '', /makes a link to .*a shell startup file/u);
  assert.match(fx.ask(bash(`ln ${path.join(fx.dir, '.git', 'config')} c`))?.reason ?? '', /the repository's shared git config/u);
  assert.match(fx.ask(bash(`cp -s ${path.join(fx.root, 'elsewhere', 'x')} l`))?.reason ?? '', /lies outside the places/u);
  assert.match(fx.ask(bash(`cp -l ${fx.home}/.bashrc b`))?.reason ?? '', /a shell startup file/u);
  assert.match(fx.ask(bash('ln -s ../../.git/hooks h'), { cwd: path.join(fx.worktree, 'a') })?.reason ?? '', /makes a link/u);
  assert.equal(fx.ask(bash('ln -s src/index.js main.js')), null, 'a link inside its worktree');
  assert.equal(fx.ask(bash(`ln -s ${fx.temp}/x y`)), null, 'a link to the temporary folder');
});

test('a subagent\'s handoff file in the dispatch folder passes, and the dispatch log and a nested dispatch path are refused', (t) => {
  const fx = fixture(t);
  const dispatch = path.join(fx.state, 'dispatch');
  mkdirSync(dispatch, { recursive: true });
  const handoff = path.join(dispatch, 'feat-project-autopilot-S5b-harness-mechanic.json');
  for (const input of [write(handoff), bash(`echo '{}' > ${handoff}`)]) assert.equal(fx.ask(input), null, input.tool_name);
  for (const file of [path.join(dispatch, 'feat-x', 'S1-explorer.json'), path.join(dispatch, 'notes.md')]) {
    assert.match(fx.ask(write(file))?.reason ?? '', /the dispatch records/u, file);
  }
  for (const input of [write(path.join(fx.state, 'dispatch-log.jsonl')), bash(`echo '{}' >> ${fx.state}/dispatch-log.jsonl`)]) {
    assert.match(fx.ask(input)?.reason ?? '', /the dispatch log/u, input.tool_name);
  }
});

test('a review or attest record, and the dispatch records, are refused by the write tool, the shell, and a delete', (t) => {
  const fx = fixture(t);
  const reviews = path.join(fx.state, 'reviews');
  mkdirSync(reviews, { recursive: true });
  for (const name of ['pr-7-review.json', 'pr-7-review-o--r.json', 'pr-7-o--r.json', 'pr-7/findings/x.json']) {
    const file = path.join(reviews, name);
    for (const input of [write(file), bash(`echo '{}' > ${file}`), bash(`rm -f ${file}`)]) {
      assert.match(fx.ask(input)?.reason ?? '', /the review and attest records/u, `${input.tool_input.command ?? file}`);
    }
  }
  assert.match(fx.ask(bash(`rm -rf ${reviews}`))?.reason ?? '', /the review and attest records/u);
  assert.match(fx.ask(bash(`rm -rf ${fx.state}/dispatch`))?.reason ?? '', /the dispatch records/u);
  assert.match(fx.ask(bash(`rm -f ${reviews}/pr-7-*.json`))?.reason ?? '', /the review and attest records/u);
  assert.equal(fx.ask(bash(`rm -f ${reviews}/pr-7/captures/abc/*.png`)), null, 'a capture glob');
});

test('a review manifest, named as the review gate\'s old attest record, never takes a reviewer key', (t) => {
  const fx = fixture(t);
  const reviews = path.join(fx.state, 'reviews');
  mkdirSync(reviews, { recursive: true });
  const manifest = path.join(reviews, 'pr-7.json');
  const copy = path.join(reviews, '.pr-7.json.tmp');
  const forged = JSON.stringify({ pr: 7, head: 'a'.repeat(40), reviewer: 'me' });
  assert.match(fx.ask(write(manifest, { tool_input: { file_path: manifest, content: forged } }))?.reason ?? '', /attest record/u);
  assert.match(fx.ask(write(copy, { tool_input: { file_path: copy, content: forged } }))?.reason ?? '', /attest record/u);
  assert.match(fx.ask({ tool_name: 'Edit', tool_input: { file_path: manifest, old_string: '"pr": 7', new_string: '"pr": 7, "reviewer": "me"' } })?.reason ?? '', /attest record/u);
  assert.match(fx.ask(bash(`printf '%s' '${forged}' > ${manifest}`))?.reason ?? '', /attest record/u);
  assert.match(fx.ask(bash(`echo e30= | base64 -d > ${manifest}`))?.reason ?? '', /attest record/u, 'content made at run time');
  assert.match(fx.ask(bash(`echo e30= | base64 -d > ${copy} && mv ${copy} ${manifest}`))?.reason ?? '', /attest record/u, 'a copy written in the same call');
  writeFileSync(copy, forged);
  assert.match(fx.ask(bash(`mv ${copy} ${manifest}`))?.reason ?? '', /attest record/u, 'a forged copy on disk');
  writeFileSync(copy, JSON.stringify({ pr: 7, rounds: [], findings: [{ specialist: 'code-reviewer' }] }));
  assert.equal(fx.ask(bash(`mv ${copy} ${manifest}`)), null, 'the rename the manifest reference asks for');
  assert.equal(fx.ask(write(copy, { tool_input: { file_path: copy, content: '{"pr":7,"findings":[{"specialist":"code-reviewer"}]}' } })), null);
  assert.equal(fx.ask(bash(`rm -f ${manifest}`)), null, 'a delete');
  // The key as JSON reads it, escapes included; a key nested below the top level is not the gate's.
  const escaped = '{"pr":7,"head":"' + 'a'.repeat(40) + '","revi\\u0065wer":"me"}';
  assert.equal(JSON.parse(escaped).reviewer, 'me');
  assert.match(fx.ask(write(manifest, { tool_input: { file_path: manifest, content: escaped } }))?.reason ?? '', /attest record/u, 'an escaped key');
  assert.match(fx.ask({ tool_name: 'Edit', tool_input: { file_path: manifest, old_string: '"pr": 7', new_string: '"pr": 7, "revi\\u0065wer": "me"' } })?.reason ?? '', /attest record/u, 'an escaped key in an edit');
  assert.equal(fx.ask(write(manifest, { tool_input: { file_path: manifest, content: '{"pr":7,"findings":[{"reviewer":"code-reviewer"}]}' } })), null, 'a nested key');
  writeFileSync(copy, escaped);
  assert.match(fx.ask(bash(`mv ${copy} ${manifest}`))?.reason ?? '', /attest record/u, 'an escaped key on disk');
});

test('the session\'s own worktree is the folder its mark says it started in, never the call\'s folder, and comes before the home folder\'s dot entries', (t) => {
  const fx = fixture(t);
  const second = path.join(fx.root, 'wt2');
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/y', second);
  assert.match(fx.ask(write(path.join(second, 'a.txt')), { cwd: second })?.reason ?? '', /outside the places/u, 'another worktree of the same repository');
  assert.match(fx.ask(write(path.join(fx.dir, 'a.txt')), { cwd: fx.dir })?.reason ?? '', /outside the places/u, 'the main checkout');
  // A mark filed before the start folder was recorded, with no start record to name that folder, has no worktree.
  assert.match(fx.ask(write(path.join(fx.worktree, 'a.txt')), { held: { root: fx.dir } })?.reason ?? '', /outside the places/u);
  assert.match(fx.ask(write(path.join(fx.dir, 'a.txt')), { held: { root: fx.dir }, cwd: fx.dir })?.reason ?? '', /outside the places/u);
  // A repository under a dot folder of the home folder writes itself, but never its git folder.
  const dotfiles = path.join(fx.home, '.dotfiles');
  mkdirSync(dotfiles);
  writeFileSync(path.join(dotfiles, 'README.md'), '#\n');
  const git = gitIn(dotfiles);
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'x');
  mkdirSync(path.join(dotfiles, '.aidrian'));
  writeFileSync(path.join(dotfiles, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: fx.state } }));
  const owner = findProject(dotfiles);
  const held = { root: dotfiles, cwd: dotfiles };
  assert.equal(fx.ask(write(path.join(dotfiles, 'zshrc')), { held, owner, cwd: dotfiles }), null);
  assert.match(fx.ask(write(path.join(dotfiles, '.git', 'info', 'exclude')), { held, owner, cwd: dotfiles })?.reason ?? '', /the repository's shared git folder/u);
  assert.match(fx.ask(write(path.join(fx.home, '.zshrc')), { held, owner, cwd: dotfiles })?.reason ?? '', /a shell startup file/u, 'the refused list stays first');
});

// Next.js route segment folders, whose names hold glob and shell characters: a dynamic segment, a catch-all, an optional
// catch-all, a route group, a parallel route slot, and intercepting routes.
const SEGMENTS = ['[uid]', '[...slug]', '[[...slug]]', '(group)', '@slot', '(.)photo', '(..)(..)feed'];

// The start record a gate files for the session it started (handoff-markers.mjs noteStarted), in the store of the state
// folder `state`: `id` and `session` name the new session, `cwd` the folder it started in.
function recordStart(fx, { cwd, id = SESSION, session = SESSION, ran = 'feed00aa-0000-4000-8000-0000000000bb' }) {
  const store = openStore(fx.state, { checkouts: fx.project.checkouts, maxChain: fx.config.session.handoff.maxChain });
  const brief = path.join(fx.state, 'handoffs', '2026-11-21-eng-1.md');
  assert.ok(noteStarted(store, ran, { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id, session, name: null, cwd }));
}

// Two task worktrees nested in the fixture's main checkout, as Claude Code's own worktrees under `.claude/worktrees/` are.
function nestedWorktrees(fx) {
  const [first, second] = ['eng-1-hours', 'eng-2-billing'].map((name) => path.join(fx.dir, '.claude', 'worktrees', name));
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/hours', first);
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/billing', second);
  return { first, second };
}

test('a mark filed before the start folder was recorded writes only the worktree its start record names, whatever its folders are named, and none with no record', (t) => {
  const fx = fixture(t);
  const { first, second } = nestedWorktrees(fx);
  const files = SEGMENTS.map((segment) => path.join(first, 'src', 'app', 'api', segment, 'route.ts'));
  const edit = (file) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });
  // The mark an older gate filed, { root, at }, whose root is the main checkout wherever the session started.
  const held = { root: fx.dir };
  // The places, told once for the mark and its session, as one hook call tells them.
  const told = (session = SESSION) => unattendedPlaces({ cwd: first, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session });
  const askWith = (found) => (input, cwd = first) => fx.ask(input, { held, cwd, places: () => found })?.reason ?? null;

  // No start record: the session cannot tell where it started, so it writes no checkout, nested or not.
  const none = askWith(told());
  for (const file of [files[0], path.join(second, 'a.ts'), path.join(fx.dir, 'README.md')]) assert.match(none(write(file)) ?? '', /outside the places/u, `no record: ${file}`);

  // A record of another session names no folder of this one's.
  recordStart(fx, { cwd: second, id: 'feed00aa-0000-4000-8000-0000000000cc', session: 'feed00aa-0000-4000-8000-0000000000cc', ran: 'feed00aa-0000-4000-8000-0000000000c0' });
  assert.match(askWith(told())(write(files[0])) ?? '', /outside the places/u, 'another session\'s record');

  // The record of its own start, by its full id or by the short id the host printed, names the worktree it started in.
  for (const [id, session] of [[SESSION, SESSION], [SESSION.slice(0, 8), null]]) {
    recordStart(fx, { cwd: first, id, session });
    const ask = askWith(told());
    for (const file of files) {
      for (const input of [edit(file), write(file), write(file, { agent_id: 'a5f0c1' })]) assert.equal(ask(input), null, `${id} ${input.tool_name} ${file}`);
      const spelled = path.relative(first, file);
      for (const command of [`printf x > '${spelled}'`, `printf x > "${file}"`, `sed -i '' 's/a/b/' '${spelled}'`]) assert.equal(ask(bash(command)), null, `${id} ${command}`);
    }
    // The other task worktree, another session's, and the main checkout around it stay outside.
    for (const file of [path.join(second, 'src', 'a.ts'), path.join(fx.dir, 'README.md'), path.join(fx.worktree, 'a.ts')]) {
      assert.match(ask(write(file)) ?? '', /outside the places/u, `${id} ${file}`);
      assert.match(ask(bash(`printf x > "${file}"`)) ?? '', /outside the places/u, `${id} shell ${file}`);
    }
    // The same names outside every place, and the entries refused wherever they lie, stay refused.
    for (const segment of SEGMENTS) assert.match(ask(edit(path.join(fx.root, 'elsewhere', segment, 'route.ts'))) ?? '', /outside the places/u, `${id} ${segment}`);
    for (const [file, reason] of refusedOf(fx)) assert.match(ask(write(file)) ?? '', file.startsWith(fx.worktree) ? /outside the places/u : reason, `${id} ${file}`);
    assert.match(ask(write(path.join(first, '.git'))) ?? '', /pointer to its git folder/u, id);
    assert.match(ask(write(path.join(first, '.claude', 'settings.json'))) ?? '', /a host file a later session/u, id);
    rmSync(path.join(fx.state, 'handoffs', '.continue', 'started-feed00aa-0000-4000-8000-0000000000bb.json'));
  }

  // Two records of its start that name two folders tell none.
  recordStart(fx, { cwd: first });
  recordStart(fx, { cwd: second, ran: 'feed00aa-0000-4000-8000-0000000000b1' });
  assert.match(askWith(told())(write(files[0])) ?? '', /outside the places/u, 'records that disagree');

  // A project run's issue session works in its attempt's clone, which its mark names: one whose mark names no start
  // folder gets no worktree, whatever a start record says.
  const issue = { root: fx.dir, project: 'launch', issue: 'ENG-1' };
  assert.match(fx.ask(write(files[0]), { held: issue, cwd: first })?.reason ?? '', /outside the places/u);
  assert.match(fx.ask(write(path.join(fx.dir, 'README.md')), { held: issue, cwd: fx.dir })?.reason ?? '', /outside the places/u);
});

test('the agent gate hook finds the start record of a session whose mark names no start folder by the payload\'s session id', async (t) => {
  const fx = fixture(t);
  const { first, second } = nestedWorktrees(fx);
  assert.ok(markUnattended(SESSION, { root: fx.dir, env: fx.env }));
  recordStart(fx, { cwd: first });
  const run = (file) => hookCall(HOOK, { input: JSON.stringify({ session_id: SESSION, cwd: first, ...write(file) }), cwd: first, env: fx.env, encoding: 'utf8' });
  const own = await run(path.join(first, 'src', 'a.ts'));
  assert.equal(own.status, 0, own.stderr);
  const other = await run(path.join(second, 'src', 'a.ts'));
  assert.equal(other.status, 2, other.stderr);
  assert.match(other.stderr, /outside the places/u);
});

test('a session started in the main checkout never writes the git pointer or the host files of a checkout nested in it, directly, through a folder, a glob, or a link', (t) => {
  const fx = fixture(t);
  const { first, second } = nestedWorktrees(fx);
  const held = { root: fx.dir, cwd: fx.dir };
  const found = unattendedPlaces({ cwd: fx.dir, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION });
  const ask = (input) => fx.ask(input, { held, cwd: fx.dir, places: () => found })?.reason ?? null;
  // Its own checkout, the task worktrees in it included, it writes.
  for (const file of [path.join(fx.dir, 'README.md'), path.join(first, 'src', 'a.ts'), path.join(second, 'src', 'a.ts')]) assert.equal(ask(write(file)), null, file);
  // The host files a later session in a nested checkout loads.
  for (const top of [first, second]) {
    for (const file of [path.join(top, '.claude', 'settings.json'), path.join(top, '.claude', 'skills', 'x', 'SKILL.md'), path.join(top, '.mcp.json')]) {
      assert.match(ask(write(file)) ?? '', /a host file a later session/u, file);
      assert.match(ask(bash(`printf x > "${file}"`)) ?? '', /a host file a later session/u, `shell ${file}`);
    }
  }
  // Each nested checkout's `.git` pointer, written, removed, or moved, by itself or with a folder that holds it.
  const pointer = /pointer to its git folder|nested checkout's git folder|host file a later session/u;
  for (const command of [`printf x > "${first}/.git"`, `rm -f "${first}/.git"`, `rm -rf "${first}"`, `mv "${first}" "${fx.temp}/moved"`,
    `rm -rf "${path.join(fx.dir, '.claude', 'worktrees')}"`, `rm -rf "${path.join(fx.dir, '.claude')}"`, `rm -rf "${fx.dir}"`]) {
    assert.match(ask(bash(command)) ?? '', pointer, command);
  }
  // A glob that may reach one: by a folder it expands to, or by a part that names `.git`.
  for (const command of [`rm -rf ${path.join(fx.dir, '.claude', 'worktrees')}/*`, `rm -f ${path.join(fx.dir, '.claude', 'worktrees')}/*/.git`, `rm -rf ${first}/.g*`, `rm -rf ${fx.dir}/src/*/.git`]) {
    assert.match(ask(bash(command)) ?? '', pointer, command);
  }
  // A link whose real path no longer names `.git`, and a `.git` named in a folder no path gives.
  const repo = path.join(fx.dir, 'vendor', 'lib');
  const store = path.join(fx.dir, 'vendor', 'store');
  mkdirSync(store, { recursive: true });
  mkdirSync(repo, { recursive: true });
  symlinkSync(store, path.join(repo, '.git'));
  assert.match(ask(write(path.join(repo, '.git', 'config'))) ?? '', /nested checkout's git folder/u, 'a .git link');
  assert.match(ask(bash(`printf x > "${path.join(repo, '.git', 'HEAD')}"`)) ?? '', /nested checkout's git folder/u, 'a .git link by the shell');
  // From the temporary folder, where the path as the call's folder gives it passes, the name still refuses.
  const fromTemp = (command) => fx.ask(bash(command), { held, cwd: fx.temp, places: () => found })?.reason ?? null;
  assert.match(fromTemp('cd "$X" && printf x > .git/HEAD') ?? '', /names a `\.git` entry/u, 'a folder no path gives');
  assert.equal(fromTemp('cd "$X" && printf x > notes.md'), null);
  // `.gitignore` and `.github` are no git entries.
  for (const file of [path.join(first, '.gitignore'), path.join(first, '.github', 'x.md')]) assert.equal(ask(write(file)), null, file);
  assert.equal(ask(bash('cd "$X" && printf x > .gitignore')), null);
});

test('a start record grants only from a store the handoff writer would keep, and a start folder only a linked worktree from any folder in it, or the main checkout from its top', (t) => {
  const fx = fixture(t);
  const { first } = nestedWorktrees(fx);
  const held = { root: fx.dir };
  const placesFor = (project, config) => unattendedPlaces({ cwd: first, mark: held, project, config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION });
  // A state folder inside the worktree beside the main checkout: the handoff writer refuses a store there, so its
  // record names no folder.
  const sibling = path.join(fx.worktree, 'state');
  writeFileSync(path.join(fx.dir, '.aidrian', 'config.json'), JSON.stringify({ version: 1, state: { dir: sibling } }));
  const project = findProject(fx.dir);
  const { config } = loadConfig(project);
  const loose = openStore(sibling, { checkouts: project.checkouts, maxChain: config.session.handoff.maxChain });
  assert.equal(loose.refused, null, 'a reader that knows only the project\'s own checkouts keeps it');
  const brief = path.join(sibling, 'handoffs', '2026-11-21-eng-1.md');
  assert.ok(noteStarted(loose, 'feed00aa-0000-4000-8000-0000000000bb', { sha256: 'a'.repeat(64), slug: 'eng-1', brief, chain: 1, id: SESSION, session: SESSION, name: null, cwd: first }));
  assert.equal(placesFor(project, config).worktree, null, 'a record in a sibling worktree\'s store');
  writeFileSync(path.join(fx.dir, '.aidrian', 'config.json'), JSON.stringify({ version: 1, state: { dir: fx.state } }));

  // A start in a folder inside a linked worktree, as a package of a monorepo is, by the record or the mark, grants that
  // worktree; the main checkout grants itself from its top.
  const src = path.join(first, 'src', 'pkg');
  mkdirSync(src, { recursive: true });
  const markFor = (held) => unattendedPlaces({ cwd: src, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION });
  assert.equal(markFor({ root: fx.dir, cwd: src }).worktree, realFolded(first), 'a mark naming a folder in the worktree');
  assert.equal(markFor({ root: fx.dir, cwd: fx.dir }).worktree, realFolded(fx.dir), 'a mark naming the main checkout');
  assert.equal(markFor({ root: fx.dir, cwd: path.join(fx.dir, '.aidrian') }).worktree, null, 'a mark naming a folder in the main checkout');
  recordStart(fx, { cwd: src });
  const inside = placesFor(fx.project, fx.config);
  assert.equal(inside.worktree, realFolded(first), 'a record naming a folder in the worktree');
  assert.equal(fx.ask(write(path.join(first, 'README.md')), { held, cwd: src, places: () => inside }), null);

  // A task worktree since removed, its folder left as a plain one, resolves to the main checkout around it: none.
  rmSync(path.join(fx.state, 'handoffs', '.continue', 'started-feed00aa-0000-4000-8000-0000000000bb.json'));
  recordStart(fx, { cwd: first });
  assert.ok(placesFor(fx.project, fx.config).worktree, 'the live worktree');
  gitIn(fx.dir)('worktree', 'remove', '--force', first);
  mkdirSync(path.join(first, 'src'), { recursive: true });
  const removed = placesFor(fx.project, fx.config);
  assert.equal(removed.worktree, null, 'a removed worktree\'s folder');
  const ask = (input, found) => fx.ask(input, { held, cwd: first, places: () => found })?.reason ?? null;
  for (const file of [path.join(first, 'src', 'a.ts'), path.join(fx.dir, 'README.md')]) assert.match(ask(write(file), removed) ?? '', /outside the places/u, file);
  // A mark that names that folder, or a folder below it, gets none either.
  const plain = { root: fx.dir, cwd: path.join(first, 'src') };
  assert.equal(unattendedPlaces({ cwd: first, mark: plain, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION }).worktree, null);
});

test('a temporary folder that holds a checkout passes none of it: the checkout\'s own rules win', (t) => {
  const fx = fixture(t);
  const { first, second } = nestedWorktrees(fx);
  // The whole fixture under the temporary folder, as /tmp holds it where tmpdir() is /tmp.
  const placesFor = (held) => unattendedPlaces({ cwd: first, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.root], session: SESSION });
  const ask = (input, held, found) => fx.ask(input, { held, cwd: first, places: () => found })?.reason ?? null;
  // With no start record, the checkouts are withheld, and still outside.
  const withheld = { root: fx.dir };
  const none = placesFor(withheld);
  for (const file of [path.join(fx.dir, 'README.md'), path.join(first, 'a.ts'), path.join(second, '.claude', 'settings.json'), path.join(fx.worktree, 'a.ts'), path.join(fx.worktree, '.git')]) {
    assert.match(ask(write(file), withheld, none) ?? '', /outside the places|pointer to its git folder/u, file);
    assert.match(ask(bash(`printf x > "${file}"`), withheld, none) ?? '', /outside the places|pointer to its git folder/u, `shell ${file}`);
  }
  assert.equal(ask(write(path.join(fx.root, 'elsewhere', 'notes.md')), withheld, none), null, 'the temporary folder outside every checkout');
  assert.match(ask(write(path.join(fx.root, 'elsewhere', '.opencode', 'plugins', 'x.js')), withheld, none) ?? '', /a host file a session started below that temporary folder loads/u, 'a host file there');
  // With its own worktree, the others stay outside, and its host files and git pointer refused.
  recordStart(fx, { cwd: first });
  const own = placesFor(withheld);
  assert.equal(ask(write(path.join(first, 'a.ts')), withheld, own), null);
  assert.match(ask(write(path.join(first, '.claude', 'settings.json')), withheld, own) ?? '', /a host file a later session/u);
  for (const file of [path.join(second, 'a.ts'), path.join(fx.worktree, 'a.ts'), path.join(fx.dir, 'README.md')]) assert.match(ask(write(file), withheld, own) ?? '', /outside the places/u, file);
});

test('a session no Human attends never writes a host file in a temporary folder, by the write tool, the shell, a move, or a link, and other files there pass', (t) => {
  const fx = fixture(t);
  const ask = fx.steady();
  const reason = /a host file a session started below that temporary folder loads/u;
  // OpenCode's files and Claude Code's nested ones, from the one union of the hosts' lists.
  const refused = ['.opencode/plugins/x.js', 'opencode.json', 'a/opencode.json', 'A/OpenCode.JSONC',
    'a/.claude/skills/x/SKILL.md', 'a/.claude/settings.json', 'docs/SKILL.md', 'a/.agents/skills/x/run.sh',
    // The instruction files a host loads from every folder above a session, from the hosts' instructionNames.
    'CLAUDE.md', 'AGENTS.md', 'a/CLAUDE.local.md', 'a/.claude/CLAUDE.md', 'a/agents.md', 'AGENTS.override.md'];
  for (const file of refused) {
    const target = path.join(fx.temp, file);
    for (const input of [write(target), bash(`echo x > ${target}`), bash(`mkdir -p ${path.dirname(target)} && touch ${target}`), bash(`cp /dev/null ${target}`)]) {
      assert.match(ask(input)?.reason ?? '', reason, `${input.tool_input.command ?? 'Write'} ${file}`);
    }
  }
  for (const file of ['a/notes.md', 'a/opencode.md', 'a/src/opencode.json.ts', 'scratch.txt', 'a/.claude/notes.md', 'a/CLAUDE.md.bak', 'a/MY-AGENTS.md']) {
    const target = path.join(fx.temp, file);
    for (const input of [write(target), bash(`echo x > ${target}`)]) assert.equal(ask(input), null, `${input.tool_name} ${file}`);
  }
  // By the variable, as a review's exec reviewer in a base checkout under TMPDIR would load it.
  for (const name of ['CLAUDE.md', 'AGENTS.md']) assert.match(ask(bash(`echo x > $TMPDIR/${name}`))?.reason ?? '', reason, `$TMPDIR/${name}`);
  assert.equal(ask(bash('echo x > $TMPDIR/notes.md')), null, '$TMPDIR/notes.md');
  assert.equal(ask(bash(`rm -rf ${path.join(fx.temp, 'a')}`)), null, 'a removal of a folder there');
  // A tree prepared under another name, which passes, then moved or linked in.
  const stage = path.join(fx.temp, 'stage');
  assert.equal(ask(write(path.join(stage, 'plugins', 'x.js'))), null, 'the prepared tree');
  mkdirSync(path.join(stage, 'plugins'), { recursive: true });
  writeFileSync(path.join(stage, 'plugins', 'x.js'), 'x\n');
  for (const command of [`mv ${stage} ${path.join(fx.temp, '.opencode')}`, `ln -s ${stage} ${path.join(fx.temp, 'a', '.opencode')}`, `ln -s ${path.join(fx.temp, '.opencode', 'plugins')} p`]) {
    assert.match(ask(bash(command))?.reason ?? '', reason, command);
  }
});

test('a copy, move, or link into a folder is judged by the name it makes there, in a temporary folder and at the worktree\'s root, and a rename is not', (t) => {
  const fx = fixture(t);
  const ask = fx.steady();
  const wt = fx.worktree;
  const x = path.join(fx.temp, 'x');
  mkdirSync(x);
  const later = /a host file a later session/u;
  const temp = /a host file a session started below that temporary folder loads/u;
  const refused = [
    [`cp -R ${wt}/pkg/.claude ${wt}/`, later], [`mv ${wt}/pkg/.claude ${wt}/`, later],
    [`cp ${wt}/pkg/opencode.json ${x}/`, temp], [`cp -R ${wt}/pkg/.opencode ${x}/`, temp], [`mv ${wt}/pkg/.opencode ${x}`, temp],
    [`ln -s ${wt}/pkg/.opencode ${x}/`, temp], [`cp -t ${x} ${wt}/pkg/opencode.json`, temp], [`cp ${wt}/a.md ${wt}/pkg/opencode.json ${x}`, temp],
    ['cp stage/opencode.json .', later], ['cp stage/.mcp.json .', later], ['cp -R stage/.agents .', later], ['git mv pkg/.claude .', later],
    // rsync makes the same names, a destination from a variable the hook expands included.
    [`rsync -a ${wt}/pkg/.claude ${wt}/`, later], [`rsync -a ${wt}/pkg/.opencode $TMPDIR/x/`, temp], [`rsync -a ${wt}/pkg/opencode.json ${x}/`, temp],
    // A `..` right after the variable is not folded into it before the hook expands it.
    [`cp ${wt}/pkg/opencode.json $TMPDIR/../${path.basename(fx.temp)}/x/`, temp], [`rsync -a ${wt}/pkg/.opencode $TMPDIR/../${path.basename(fx.temp)}/x/`, temp],
    // rsync never renames a folder source: a destination not there yet gets it inside.
    [`rsync -a ${wt}/pkg/.opencode ${path.join(fx.temp, 'new')}`, temp],
    // rsync -R and cp --parents make the source's relative path there; a remote-spelled source lands by its last part.
    [`rsync -aR .claude/settings.json ${wt}/`, later], [`cp --parents .claude/settings.json ${wt}/`, later],
    ['rsync -aR p/.opencode/plugins/x.js $TMPDIR/w/', temp], [`rsync -a -e ./sh x:/abs/.opencode ${path.join(fx.temp, 'w')}/`, temp],
    // When the remote shell the call names may run here (anything but ssh or rsh, bare or in a system program folder),
    // a single-colon destination is local by its path part, a shim named ssh by a path included.
    [`rsync -a -e ./sh notes.md x:${wt}/.claude/settings.json`, later], [`rsync -a -e ./ssh notes.md x:${wt}/.claude/settings.json`, later], [`rsync -aR -e ./sh .claude/settings.json x:${wt}/`, later],
    [`RSYNC_RSH=./sh rsync -a pkg/opencode.json x:${x}/`, temp], [`rsync -a --rsh=./sh pkg/.opencode x:$TMPDIR/x/`, temp],
  ];
  for (const [command, reason] of refused) assert.match(ask(bash(command))?.reason ?? '', reason, command);
  // A destination led by `~` keeps its `~/..` for the reader to expand, as a variable's does.
  assert.ok(shellWrites('cp pkg/opencode.json ~/../scratch/', wt, {}).manifests.some((each) => each.text === '~/../scratch/opencode.json'), 'cp into ~/../scratch/');
  // One operand: the link is made in the shell's folder, by the name of what it links to.
  assert.match(ask(bash(`ln -s ${wt}/pkg/.opencode`), { cwd: x })?.reason ?? '', temp, 'ln with one operand');
  for (const command of [`cp notes.md ${x}/`, 'cp x .', 'mv a.txt b.txt', `mv ${wt}/pkg/.opencode ${path.join(fx.temp, 'y')}`,
    `rsync -a notes.md ${x}/`, `rsync -a pkg/ ${path.join(fx.temp, 'w')}/`, `rsync -a pkg/notes.md ${path.join(fx.temp, 'new.md')}`,
    `rsync -aR --no-R p/.opencode/plugins/x.js ${x}/`]) {
    assert.equal(ask(bash(command)), null, command);
  }
  // Read by the writes the command makes, with no git call: a bracketed IPv6 host makes the same writes as the
  // `x:` destination refused above, and ssh, which reaches another machine, or a daemon URL makes none.
  const writes = (command) => shellWrites(command, wt, fx.env).manifests.map(({ text }) => text);
  assert.deepEqual(writes(`rsync -a -e ./sh notes.md [::1]:${wt}/.claude/settings.json`), writes(`rsync -a -e ./sh notes.md x:${wt}/.claude/settings.json`));
  assert.ok(writes(`rsync -a -e ./sh notes.md [::1]:${wt}/.claude/settings.json`).includes(`${wt}/.claude/settings.json`));
  for (const command of ['rsync -a -e ssh dist/ host:/var/www/', 'rsync -avz -e "ssh -p 2222" notes.md deploy@server:site/', 'rsync -a -e ./sh a rsync://x/module/d/']) {
    assert.deepEqual(writes(command), [], command);
  }
  // The review manifest's rename keeps its verdict, with the manifest there and without it.
  const reviews = path.join(fx.state, 'reviews');
  mkdirSync(reviews, { recursive: true });
  const [copy, manifest] = [path.join(reviews, '.pr-7.json.tmp'), path.join(reviews, 'pr-7.json')];
  writeFileSync(copy, JSON.stringify({ pr: 7, rounds: [], findings: [] }));
  assert.equal(ask(bash(`mv ${copy} ${manifest}`)), null, 'the rename, no manifest there');
  writeFileSync(manifest, '{}\n');
  assert.equal(ask(bash(`mv ${copy} ${manifest}`)), null, 'the rename over the manifest');
});

test('the configured worktrees folder of a session started in the main checkout keeps its root host files refused with no checkout in it', (t) => {
  const fx = fixture(t);
  const held = { root: fx.dir, cwd: fx.dir };
  const placesWith = (config = fx.config) => unattendedPlaces({ cwd: fx.dir, mark: held, project: fx.project, config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION });
  const withDir = (dir) => ({ ...fx.config, git: { ...fx.config.git, worktrees: { ...fx.config.git.worktrees, dir } } });
  const ask = (input, found) => fx.ask(input, { held, cwd: fx.dir, places: () => found })?.reason ?? null;
  const trees = path.join(fx.dir, '.worktrees');
  for (const made of [false, true]) {
    if (made) mkdirSync(trees);
    const found = placesWith();
    for (const file of ['.opencode/plugins/x.js', 'opencode.json', '.mcp.json', '.agents/skills/x/SKILL.md']) {
      const target = path.join(trees, file);
      assert.match(ask(write(target), found) ?? '', /a host file a later session/u, `${made} ${file}`);
      assert.match(ask(bash(`printf x > "${target}"`), found) ?? '', /a host file a later session/u, `${made} shell ${file}`);
    }
    assert.equal(ask(write(path.join(trees, 'notes.md')), found), null, `${made} notes.md`);
  }
  // A worktrees folder in a host's own folder, and the folders between it and the top.
  const claude = placesWith(withDir('.claude/worktrees'));
  for (const file of [path.join(fx.dir, '.claude', 'worktrees', 'opencode.json'), path.join(fx.dir, '.claude', 'opencode.json')]) {
    assert.match(ask(write(file), claude) ?? '', /a host file a later session/u, file);
  }
  // A folder outside the main checkout adds nothing; the default one adds the root list once.
  const outside = placesWith(withDir('../trees')).refused.map((entry) => entry.path);
  const inside = placesWith().refused.map((entry) => entry.path);
  assert.equal(outside.length, inside.length - protectedPaths().length);
  assert.ok(!outside.some((each) => isWithin(realFolded(trees), each)), 'no entry under the default folder');
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/three', path.join(trees, 'eng-3'));
  const listed = placesWith().refused.filter((entry) => entry.path === path.join(realFolded(trees), 'opencode.json'));
  assert.equal(listed.length, 1, 'held once, with a checkout in it');
});

test('a session started in the main checkout never writes a host file in a folder between it and a checkout nested in it, and lists each such folder once', (t) => {
  const fx = fixture(t);
  const { first, second } = nestedWorktrees(fx);
  const third = path.join(fx.dir, '.worktrees', 'eng-3');
  const direct = path.join(fx.dir, 'eng-4');
  const inner = path.join(first, '.claude', 'worktrees', 'b');
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/three', third);
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/four', direct);
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/inner', inner);
  const held = { root: fx.dir, cwd: fx.dir };
  const found = unattendedPlaces({ cwd: fx.dir, mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION });
  const ask = (input) => fx.ask(input, { held, cwd: fx.dir, places: () => found })?.reason ?? null;
  for (const file of ['.worktrees/.opencode/plugins/x.js', '.worktrees/opencode.json', '.claude/worktrees/opencode.jsonc', '.claude/worktrees/.mcp.json', '.claude/.opencode/plugins/x.js']) {
    const target = path.join(fx.dir, file);
    assert.match(ask(write(target)) ?? '', /a host file a later session/u, file);
    assert.match(ask(bash(`printf x > "${target}"`)) ?? '', /a host file a later session/u, `shell ${file}`);
  }
  for (const file of [path.join(fx.dir, '.worktrees', 'notes.md'), path.join(fx.dir, '.claude', 'worktrees', 'notes.md'), path.join(first, 'src', 'a.ts')]) {
    assert.equal(ask(write(file)), null, file);
    assert.equal(ask(bash(`printf x > "${file}"`)), null, `shell ${file}`);
  }
  assert.match(ask(bash(`rm -f ${path.join(fx.dir, '.worktrees')}/.o*/plugins/x.js`)) ?? '', /a host file a later session/u, 'a glob whose part may name the folder');
  // Each folder that holds a root host file, once: the top, each nested checkout, a worktree nested in a worktree
  // included, and each folder between, and no other.
  const folders = found.refused.filter((entry) => path.basename(entry.path) === 'opencode.json' && /a host file a later session in that checkout/u.test(entry.what)).map((entry) => path.dirname(entry.path));
  const expected = [fx.dir, first, second, third, direct, inner, path.join(fx.dir, '.claude', 'worktrees'), path.join(fx.dir, '.claude'), path.join(fx.dir, '.worktrees'),
    path.join(first, '.claude', 'worktrees'), path.join(first, '.claude')].map(realFolded);
  assert.deepEqual([...folders].sort(), [...expected].sort());
});

test('a main checkout git cannot read, with a .git on disk, grants no checkout and no temporary folder; one outside git keeps the temporary folder', (t) => {
  const fx = fixture(t);
  const broken = path.join(fx.root, 'broken');
  mkdirSync(path.join(broken, 'src'), { recursive: true });
  writeFileSync(path.join(broken, '.git'), `gitdir: ${path.join(fx.root, 'gone')}\n`);
  const placesFor = (root) => unattendedPlaces({ cwd: root, mark: { root, cwd: root }, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.root], session: SESSION });
  const found = placesFor(broken);
  assert.equal(found.worktree, null);
  assert.deepEqual(found.temp, []);
  for (const file of [path.join(broken, 'src', 'a.ts'), path.join(fx.root, 'elsewhere', 'notes.md')]) {
    assert.match(fx.ask(write(file), { held: { root: broken, cwd: broken }, cwd: broken, places: () => found })?.reason ?? '', /outside the places/u, file);
  }
  // A folder with no .git at or above it is outside git: the temporary folder still passes.
  const plain = path.join(fx.root, 'plain');
  mkdirSync(plain);
  assert.equal(placesFor(plain).temp.length, 1);
});

test('the start record scan checks the guards\' deadline on each file it reads', (t) => {
  const fx = fixture(t);
  recordStart(fx, { cwd: fx.worktree });
  const store = openStore(fx.state, { checkouts: fx.project.checkouts, maxChain: fx.config.session.handoff.maxChain });
  assert.deepEqual(startedFolders(store, SESSION), [fx.worktree]);
  // startedFolders checks the deadline on each entry of the store it reads, so a spent budget meets it there.
  assert.throws(() => withinDeadline(performance.now() - 1, () => startedFolders(store, SESSION)), PastDeadline);
  // And before the store is listed at all: an empty store meets a spent budget too.
  const empty = openStore(mkdtempSync(path.join(fx.root, 'empty-state-')), { checkouts: fx.project.checkouts, maxChain: fx.config.session.handoff.maxChain });
  assert.deepEqual(startedFolders(empty, SESSION), []);
  assert.throws(() => withinDeadline(performance.now() - 1, () => startedFolders(empty, SESSION)), PastDeadline);
  // And the places read through it give the deadline's refusal, never a worktree.
  assert.throws(() => withinDeadline(performance.now() - 1, () => unattendedPlaces({ cwd: fx.worktree, mark: { root: fx.dir }, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION })), PastDeadline);
});

test('one call of the places reads each checkout\'s roots once, though its state folders and its worktree each ask for them', (t) => {
  const fx = fixture(t);
  const reads = factReads(t, () => assert.ok(unattendedPlaces({ cwd: fx.worktree, mark: fx.mark, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], session: SESSION })?.worktree));
  const roots = reads.filter((line) => line.endsWith(' roots'));
  assert.ok(roots.includes(`${fx.dir} roots`) && roots.includes(`${fx.worktree} roots`), `both checkouts' roots are read: ${roots.join(' | ')}`);
  assert.deepEqual(tally(roots), Object.fromEntries(roots.map((line) => [line, 1])), 'each folder\'s roots once');
});

// The git commands a guard reads with, as `<command> <first arguments>`: a logged call outside them writes.
const GIT_READS = [/^rev-parse\b/u, /^config --get\b/u, /^config --get-regexp\b/u, /^config --file\b/u, /^worktree list\b/u, /^remote$/u, /^show\b/u, /^var\b/u, /^ls-files\b/u, /^cat-file\b/u];

test('one agent gate hook call of a marked session\'s write in its worktree runs only git reads, and no more of them than it measured', async (t) => {
  const fx = fixture(t);
  const git = gitLog(t);
  const file = path.join(fx.worktree, 'notes.md');
  const result = await hookCall(HOOK, { input: JSON.stringify({ session_id: SESSION, cwd: fx.worktree, ...write(file) }), cwd: fx.worktree, env: { ...fx.env, PATH: git.path }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  // Each line is `<working folder> <arguments>`, its folder one of the fixture's, or the root folder where git names
  // its config files.
  const calls = git.calls().map((line) => {
    if (line.startsWith(`${path.sep} `)) return line.slice(2);
    assert.ok(line.startsWith(`${fx.root}${path.sep}`), `a git call in the fixture or the root folder: ${line}`);
    return line.slice(line.indexOf(' ', fx.root.length) + 1);
  });
  assert.ok(calls.length > 0, 'the hook reads git');
  for (const call of calls) assert.ok(GIT_READS.some((read) => read.test(call)), `a git read: ${call}`);
  // 45 before the places read each checkout's facts once, 32 after.
  assert.ok(calls.length <= 32, `at most 32 git calls, as measured once the places read each checkout's facts once: ${calls.length}`);
});

test('a `.git` entry in an attempt folder or a state folder a session writes is refused too', (t) => {
  const fx = fixture(t);
  const ask = (input) => fx.ask(input)?.reason ?? null;
  const tmp = path.join(fx.state, 'tmp');
  mkdirSync(tmp, { recursive: true });
  for (const file of [path.join(tmp, 'clone', '.git', 'config'), path.join(fx.state, 'plans', 'x', '.git')]) {
    assert.match(ask(write(file)) ?? '', /nested checkout's git folder/u, file);
    assert.match(ask(bash(`printf x > "${file}"`)) ?? '', /nested checkout's git folder/u, `shell ${file}`);
  }
  assert.match(ask(bash(`rm -rf ${tmp}/*/.git`)) ?? '', /nested checkout's git folder/u, 'a glob');
  assert.equal(ask(write(path.join(tmp, 'notes.md'))), null);
  // An attempt's work folder, an issue session's place.
  const held = { root: fx.dir, cwd: path.join(fx.attempt, 'work'), project: 'launch', issue: 'ENG-1' };
  const own = () => fx.attempt;
  const found = unattendedPlaces({ cwd: path.join(fx.attempt, 'work'), mark: held, project: fx.project, config: fx.config, env: fx.env, home: fx.home, temp: [fx.temp], own, session: SESSION });
  const inAttempt = (input) => fx.ask(input, { held, cwd: path.join(fx.attempt, 'work'), places: () => found })?.reason ?? null;
  assert.match(inAttempt(write(path.join(fx.attempt, 'work', 'pkg', '.git', 'config'))) ?? '', /nested checkout's git folder/u);
  assert.equal(inAttempt(write(path.join(fx.attempt, 'work', 'pkg', 'a.ts'))), null);
});

test('the agent gate hook holds a marked session to its places, a pending hold to the refused entries, and lets a call run when it cannot read its input', async (t) => {
  const fx = fixture(t);
  const zdot = path.join(fx.temp, 'zdot');
  // A system git config inside the temporary folder, where only git's name for it refuses it.
  const system = path.join(fx.temp, 'etc', 'gitconfig');
  const env = { ...fx.env, ZDOTDIR: zdot, GIT_CONFIG_SYSTEM: system };
  // Called in this process as the host runs the script; `call` spawned starts it as its own program, for its reading of stdin.
  const spawned = (script, options) => spawnSync(process.execPath, [script], options);
  const run = (session, input, { script = HOOK, cwd = fx.worktree, call = hookCall } = {}) => call(script, { input: typeof input === 'string' ? input : JSON.stringify({ session_id: session, cwd, ...input }), cwd, env, encoding: 'utf8' });
  const refused = [
    [write(system), /the system's git config/u],
    [write(path.join(fx.dir, '.git', 'hooks', 'pre-commit')), /the repository's shared git hooks/u],
    // Inside the temporary folder, where every other write passes.
    [bash(`echo 'export PATH=/x' >> ${zdot}/.zshrc`), /a shell startup file/u],
    [write(path.join(fx.xdg, 'git', 'config')), /the user's git config/u],
  ];
  for (const [input, reason] of refused) {
    const result = await run(SESSION, input);
    assert.equal(result.status, 2, `${input.tool_input.command ?? input.tool_input.file_path}: ${result.stderr}`);
    assert.match(result.stderr, reason);
  }
  for (const input of [write(path.join(fx.worktree, 'src.js')), bash(`echo x > ${path.join(fx.state, 'tmp', 'x')}`), bash('make 2>/dev/null')]) {
    const result = await run(SESSION, input);
    assert.equal(result.status, 0, result.stderr);
  }
  for (const script of [HOOK, WRITE_HOOK]) assert.equal((await run(SESSION, 'not json', { script, call: spawned })).status, 0, 'an input it cannot read lets the call run');
  // A pending mark with no session listed holds every other session: one writing its own file in another repository
  // passes, and one writing that repository's shared git config does not.
  const other = path.join(fx.root, 'other');
  mkdirSync(other);
  gitIn(other)('init', '-q', '-b', 'main');
  assert.ok(markPending('feed00aa-0000-4000-8000-0000000000dd', { cwd: fx.worktree, root: fx.dir, known: [], env: fx.env }));
  const another = 'feed00aa-0000-4000-8000-0000000000ee';
  const own = await run(another, write(path.join(other, 'notes.md')), { cwd: other });
  assert.equal(own.status, 0, own.stderr);
  const user = await run(another, write(path.join(other, '.git', 'config')), { cwd: other });
  assert.equal(user.status, 2, user.stderr);
  assert.match(user.stderr, /a project start is in progress/u);
});

// A clone whose path, ledger, and main checkout a session could have made itself: `state` holds
// `runs/<run>/ledger.jsonl` with an init row that names `main`, written once, and a start row that names the work folder.
function clone({ state, main, run = 'r1', key = 'ENG-1' }) {
  const attempt = path.join(state, 'runs', run, 'attempts', `${key}.1`);
  const work = path.join(attempt, 'work');
  mkdirSync(path.join(attempt, 'drop'), { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(attempt, 'git'), work], { stdio: 'pipe' });
  const at = new Date().toISOString();
  const ledger = path.join(state, 'runs', run, 'ledger.jsonl');
  const rows = [
    ...(existsSync(ledger) ? [] : [{ event: 'init', run, main, session: SESSION, at }]),
    { event: 'start', key, attempt: 1, session: SESSION, name: `${run} · ${key} · 1`, cwd: work, drop: path.join(attempt, 'drop'), at, outcome: 'started' },
  ];
  appendFileSync(ledger, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { attempt, work };
}

// A main checkout whose machine file turns merging, the waiver, and the background route on.
function onMain(dir, config = null) {
  mkdirSync(dir, { recursive: true });
  gitIn(dir)('init', '-q', '-b', 'main');
  if (config) {
    mkdirSync(path.join(dir, '.aidrian'));
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  }
  writeFileSync(path.join(dir, LOCAL), JSON.stringify({ github: { autoMerge: 'on', unattendedWaiver: 'on' }, handoff: { background: 'on' } }));
}

const switches = (work) => {
  const found = projectAt(work);
  return { main: realpathSync(found.checkouts.at(-1)), on: [found.localAutoMerge, found.localUnattendedWaiver, found.localHandoffBackground] };
};

test('a fabricated state tree links no clone: the switches read off without the session\'s mark, or with one that names another main checkout, run, or issue', (t) => {
  const root = tempRoot(t, 'aidrian-fake-');
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks') };
  const home = path.join(root, 'home');
  mkdirSync(home);
  t.after(() => anchorClones(null));
  const fakeMain = path.join(root, 'fake-main');
  onMain(fakeMain);
  const { work } = clone({ state: path.join(root, 'fake-state'), main: fakeMain });
  const off = { main: realpathSync(work), on: ['off', 'off', 'off'] };
  anchorClones({ session: 'no-mark-session', env, home });
  assert.deepEqual(switches(work), off, 'no mark');
  for (const [label, tags, rootOf] of [
    ['a mark naming the run, the issue, and the fake main', { project: 'r1', issue: 'ENG-1' }, fakeMain],
    ['a mark naming another issue', { project: 'r1', issue: 'ENG-2' }, fakeMain],
    ['a mark naming another run', { project: 'r2', issue: 'ENG-1' }, fakeMain],
  ]) {
    const session = `fake-${label.length}-${tags.project}-${tags.issue}`;
    assert.ok(markUnattended(session, { root: rootOf, env, tags }));
    anchorClones({ session, env, home });
    assert.deepEqual(switches(work), off, label);
  }
});

test('a clone links only in a state folder its project names, never one a session made in a work folder or the temporary folder', (t) => {
  const root = tempRoot(t, 'aidrian-anchor-');
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks') };
  const home = path.join(root, 'home');
  mkdirSync(home);
  t.after(() => anchorClones(null));
  const state = path.join(root, 'state');
  const main = path.join(root, 'main');
  onMain(main, { version: 1, state: { dir: state } });
  assert.ok(markUnattended(SESSION, { root: main, env, tags: { project: 'r1', issue: 'ENG-1' } }));
  anchorClones({ session: SESSION, env, home });
  // The real one: the run's main checkout stands as the clone's, and its switches are read.
  const real = clone({ state, main });
  assert.deepEqual(switches(real.work), { main: realpathSync(main), on: ['on', 'on', 'on'] });
  // The same tree, made by the session in its state work folder or in the temporary folder, names the real main too.
  for (const made of [path.join(state, 'tmp', 'x'), path.join(root, 'tmp', 'y')]) {
    const fake = clone({ state: made, main });
    assert.deepEqual(switches(fake.work), { main: realpathSync(fake.work), on: ['off', 'off', 'off'] }, made);
  }
  // Before the gate files the new session's mark, its pending mark anchors the clone it starts the session in, and no other.
  const second = clone({ state, main, key: 'ENG-2' });
  anchorClones({ session: 'not-yet-listed', env, home });
  assert.equal(switches(real.work).main, realpathSync(real.work), 'no mark at all');
  assert.ok(markPending('driver-session', { cwd: real.work, root: main, known: [], env }));
  anchorClones({ session: 'not-yet-listed', env, home });
  assert.equal(switches(real.work).main, realpathSync(main), 'the clone the gate starts the session in');
  assert.equal(switches(second.work).main, realpathSync(second.work), 'another clone of the run');
});

test('a call in an attempt clone whose .git points at another git folder is refused', (t) => {
  const root = tempRoot(t, 'aidrian-pointer-');
  const { attempt, work } = clone({ state: path.join(root, 'state'), main: path.join(root, 'main') });
  assert.equal(cloneConfigProblem(work), null, 'the pointer git wrote');
  assert.equal(cloneConfigProblem(path.join(attempt, 'drop')), null, 'the drop folder of a clone whose pointer holds');
  const other = path.join(root, 'other.git');
  execFileSync('git', ['init', '-q', '--bare', other], { stdio: 'pipe' });
  writeFileSync(path.join(work, '.git'), `gitdir: ${other}\n`);
  assert.match(cloneConfigProblem(work) ?? '', /points at another git folder than its own/u);
  writeFileSync(path.join(work, '.git'), 'gitdir: ../elsewhere\n');
  assert.match(cloneConfigProblem(work) ?? '', /points at another git folder than its own/u);
  rmSync(path.join(work, '.git'));
  mkdirSync(path.join(work, '.git'));
  assert.match(cloneConfigProblem(work) ?? '', /is not a pointer file to its own git folder/u);
  rmSync(path.join(work, '.git'), { recursive: true });
  symlinkSync(path.join(attempt, 'git'), path.join(work, '.git'));
  assert.match(cloneConfigProblem(work) ?? '', /is not a pointer file to its own git folder/u);
});

test('a .git pointer whose `..` follows a link is read where git lands, past the link\'s target, not folded before it', (t) => {
  const root = tempRoot(t, 'aidrian-pointer-dots-');
  const { attempt, work } = clone({ state: path.join(root, 'state'), main: path.join(root, 'main') });
  // `away/git` is another git folder; `work/l` leads to `away/a/b`, so `l/../../git` is `attempt/git` to the eye and
  // `away/git` to git.
  const away = path.join(root, 'away');
  mkdirSync(path.join(away, 'a', 'b'), { recursive: true });
  execFileSync('git', ['init', '-q', '--bare', path.join(away, 'git')], { stdio: 'pipe' });
  symlinkSync(path.join(away, 'a', 'b'), path.join(work, 'l'));
  writeFileSync(path.join(work, '.git'), 'gitdir: l/../../git\n');
  assert.equal(path.resolve(work, 'l/../../git'), path.join(attempt, 'git'), 'folded, the spelling names the attempt\'s own');
  assert.equal(execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: work, encoding: 'utf8' }).trim(), realpathSync(path.join(away, 'git')), 'git runs on the other one');
  assert.match(cloneConfigProblem(work) ?? '', /points at another git folder than its own/u);
});

test('a call in an attempt clone whose git folder holds a commondir or config.worktree file is refused, and the clone links to no main checkout', (t) => {
  const root = tempRoot(t, 'aidrian-extras-');
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks') };
  const home = path.join(root, 'home');
  mkdirSync(home);
  t.after(() => anchorClones(null));
  const state = path.join(root, 'state');
  const main = path.join(root, 'main');
  onMain(main, { version: 1, state: { dir: state } });
  assert.ok(markUnattended(SESSION, { root: main, env, tags: { project: 'r1', issue: 'ENG-1' } }));
  anchorClones({ session: SESSION, env, home });
  const { attempt, work } = clone({ state, main });
  assert.equal(cloneConfigProblem(work), null);
  assert.equal(switches(work).main, realpathSync(main), 'linked before the plant');
  for (const [name, text] of [['commondir', `${path.join(main, '.git')}\n`], ['commondir', ''], ['commondir', '.'], ['commondir', './\n'], ['commondir', '..\n'], ['commondir', '.\n\n'],
    ['config.worktree', '[core]\n\thooksPath = /x\n']]) {
    const planted = path.join(attempt, 'git', name);
    writeFileSync(planted, text);
    anchorClones({ session: SESSION, env, home });
    assert.match(cloneConfigProblem(work) ?? '', /through which git reads another config/u, `${name} ${JSON.stringify(text)}`);
    assert.equal(switches(work).main, realpathSync(work), `${name} ${JSON.stringify(text)}: no link`);
    rmSync(planted);
  }
  // The gate's placeholders, an empty config.worktree and a commondir of `.` and a newline, each a regular file with one
  // link, add nothing and pass; a second link, a symbolic link, a folder, or any other text refuses.
  for (const [name, text] of Object.entries(GIT_PLACEHOLDERS)) {
    const placeholder = path.join(attempt, 'git', name);
    writeFileSync(placeholder, text);
    anchorClones({ session: SESSION, env, home });
    assert.equal(cloneConfigProblem(work), null, `the ${name} placeholder`);
    assert.equal(switches(work).main, realpathSync(main), `${name}: still linked`);
    linkSync(placeholder, path.join(root, 'second-link'));
    assert.match(cloneConfigProblem(work) ?? '', /through which git reads another config/u, `${name}: a second hard link`);
    rmSync(path.join(root, 'second-link'));
    rmSync(placeholder);
    writeFileSync(path.join(root, 'same-text'), text);
    symlinkSync(path.join(root, 'same-text'), placeholder);
    assert.match(cloneConfigProblem(work) ?? '', /through which git reads another config/u, `${name}: a symbolic link to the same text`);
    rmSync(placeholder);
    mkdirSync(placeholder);
    assert.match(cloneConfigProblem(work) ?? '', /through which git reads another config/u, `${name}: a folder`);
    rmSync(placeholder, { recursive: true });
  }
});

test('git reads a commondir of `.` and a newline as the git folder itself: status, commit, fetch, and push work in a clone the gate makes, and an empty one makes git die', (t) => {
  const root = tempRoot(t, 'aidrian-commondir-');
  const origin = path.join(root, 'origin.git');
  const main = path.join(root, 'main');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { stdio: 'pipe' });
  onMain(main);
  const inMain = gitIn(main);
  writeFileSync(path.join(main, 'README.md'), '# widgets\n');
  inMain('add', 'README.md');
  inMain('commit', '-q', '-m', 'one');
  inMain('push', '-q', origin, 'HEAD:refs/heads/main');
  // The clone as lib/project-start.mjs prepareAttempt makes it, in an attempt's folder, with the git folder's placeholders.
  const attempt = path.join(root, 'state', 'runs', 'r1', 'attempts', 'ENG-1.1');
  const [work, git] = ['work', 'git'].map((name) => path.join(attempt, name));
  mkdirSync(attempt, { recursive: true });
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', '--separate-git-dir', git, main, work], { stdio: 'pipe' });
  const inWork = gitIn(work);
  inWork('remote', 'set-url', 'origin', origin);
  inWork('checkout', '-q', '-b', 'feat/eng-1', 'origin/main');
  assert.equal(placeHolders({ work, git }), null);
  assert.equal(readFileSync(path.join(git, 'commondir'), 'utf8'), '.\n');
  assert.equal(inWork('rev-parse', '--path-format=absolute', '--git-common-dir').trim(), realpathSync(git), 'the common folder is the git folder itself');
  assert.equal(inWork('rev-parse', '--path-format=absolute', '--git-dir').trim(), realpathSync(git));
  writeFileSync(path.join(work, 'x.txt'), 'x\n');
  assert.equal(inWork('status', '--porcelain'), '?? x.txt\n');
  inWork('add', 'x.txt');
  inWork('commit', '-q', '-m', 'two');
  inWork('fetch', '-q', 'origin');
  inWork('push', '-q', 'origin', 'HEAD:refs/heads/feat/eng-1');
  assert.equal(execFileSync('git', ['-C', origin, 'rev-parse', 'refs/heads/feat/eng-1'], { encoding: 'utf8' }), inWork('rev-parse', 'HEAD'), 'the push landed');
  assert.equal(inWork('worktree', 'list', '--porcelain').match(/^worktree /gmu)?.length, 1, 'git sees one checkout, no linked worktree');
  // The plugin's own git calls there pass the clone check.
  assert.equal(cloneConfigProblem(work), null);
  assert.equal(runGit(['status', '--porcelain'], work).status, 0);
  // The host's placeholder for a denied absent file on Linux is empty, and git dies on it.
  writeFileSync(path.join(git, 'commondir'), '');
  assert.throws(() => inWork('status'), /failed to read .*commondir/u);
});

test('the agent gate hook refuses every call in an attempt clone whose commondir is not the gate\'s placeholder, before any git runs there', async (t) => {
  const root = tempRoot(t, 'aidrian-hook-commondir-');
  const state = path.join(root, 'state');
  const main = path.join(root, 'main');
  onMain(main, { version: 1, state: { dir: state } });
  const { attempt, work } = clone({ state, main });
  const env = { ...process.env, XDG_STATE_HOME: path.join(root, 'marks') };
  const run = () => hookCall(HOOK, { input: JSON.stringify({ session_id: SESSION, cwd: work, tool_name: 'Read', tool_input: { file_path: path.join(work, 'x') } }), cwd: work, env, encoding: 'utf8' });
  const commondir = path.join(attempt, 'git', 'commondir');
  writeFileSync(commondir, GIT_PLACEHOLDERS.commondir);
  const passed = await run();
  assert.equal(passed.status, 0, passed.stderr);
  for (const text of [`${path.join(main, '.git')}\n`, '', '../git\n']) {
    writeFileSync(commondir, text);
    const refused = await run();
    assert.equal(refused.status, 2, JSON.stringify(text));
    assert.match(refused.stderr, /holds .*commondir, through which git reads another config/u, JSON.stringify(text));
  }
});

test('every plugin git call in an attempt clone whose git folder holds a commondir, or whose config runs a program, runs no git', (t) => {
  const root = tempRoot(t, 'aidrian-rungit-');
  const state = path.join(root, 'state');
  const main = path.join(root, 'main');
  onMain(main, { version: 1, state: { dir: state } });
  const { attempt, work } = clone({ state, main });
  mkdirSync(path.join(work, 'src'));
  for (const cwd of [work, path.join(work, 'src'), path.join(attempt, 'git')]) assert.equal(runGit(['rev-parse', '--git-dir'], cwd).status, 0, cwd);
  const planted = path.join(attempt, 'git', 'commondir');
  writeFileSync(planted, `${path.join(main, '.git')}\n`);
  for (const cwd of [work, path.join(work, 'src'), path.join(attempt, 'git')]) {
    const refused = runGit(['rev-parse', '--git-dir'], cwd);
    assert.deepEqual([refused.status, refused.error?.code], [null, 'EREFUSED'], cwd);
    assert.match(refused.stderr, /holds .*commondir, through which git reads another config/u);
  }
  // The attempt's own folder, where the gate makes the clone, and its drop folder are no clone's.
  assert.equal(cloneGitProblem(attempt), null);
  assert.equal(cloneGitProblem(path.join(attempt, 'drop')), null);
  rmSync(planted);
  execFileSync('git', ['config', '--file', path.join(attempt, 'git', 'config'), 'core.hooksPath', path.join(root, 'hooks')]);
  assert.match(runGit(['status'], work).stderr, /sets core\.hookspath, which makes git run a program/u);
  assert.equal(cloneGitProblem(path.join(root, 'elsewhere')), null, 'a folder of no attempt');
  execFileSync('git', ['config', '--file', path.join(attempt, 'git', 'config'), '--unset', 'core.hooksPath']);
  // The committed config, read through git show, runs no git there either, and throws as when git fails.
  const project = { root: work, paths: { config: '.aidrian/config.json' } };
  assert.doesNotThrow(() => committedConfig(project, 'HEAD'), 'no commondir: git runs');
  writeFileSync(planted, `${path.join(main, '.git')}\n`);
  assert.throws(() => committedConfig(project, 'HEAD'), /git show HEAD:\.\/\.aidrian\/config\.json failed: .*commondir, through which git reads another config/u);
  writeFileSync(planted, GIT_PLACEHOLDERS.commondir);
  assert.equal(runGit(['rev-parse', '--git-dir'], work).status, 0, 'the gate\'s placeholder passes');
  assert.doesNotThrow(() => committedConfig(project, 'HEAD'));
});

test('a git call whose folder reaches an attempt clone through a link and `..` is refused where the system lands, not where the spelling folds', (t) => {
  const root = tempRoot(t, 'aidrian-rungit-dots-');
  const state = path.join(root, 'state');
  const main = path.join(root, 'main');
  onMain(main, { version: 1, state: { dir: state } });
  const { attempt, work } = clone({ state, main });
  mkdirSync(path.join(work, 'sub'));
  const outside = path.join(root, 'x');
  mkdirSync(outside);
  symlinkSync(path.join(work, 'sub'), path.join(outside, 'link'));
  // `x/link/..` folds to `x` as text, and is `work` to the system: git runs in the clone.
  const cwd = `${outside}/link/..`;
  assert.equal(path.resolve(cwd), outside);
  assert.equal(spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd, encoding: 'utf8' }).stdout.trim(), realpathSync(path.join(attempt, 'git')), 'git runs in the clone');
  writeFileSync(path.join(attempt, 'git', 'commondir'), `${path.join(main, '.git')}\n`);
  assert.match(cloneGitProblem(cwd) ?? '', /holds .*commondir, through which git reads another config/u);
  const refused = runGit(['rev-parse', '--git-dir'], cwd);
  assert.deepEqual([refused.status, refused.error?.code], [null, 'EREFUSED']);
});

test('a confined session never writes a host file its clone loads from any depth, by the write tool, the shell, a link, or a glob', (t) => {
  const fx = fixture(t);
  const ask = fx.steady({ own: () => fx.attempt });
  const work = path.join(fx.attempt, 'work');
  for (const file of ['pkg/.claude/skills/x/SKILL.md', 'a/b/.claude/agents/x.md', 'a/.claude/commands/c.md', 'a/.claude/settings.local.json', 'a/.claude/settings.json',
    'a/.claude/hooks/h.sh', 'docs/SKILL.md', 'pkg/.agents/skills/x/run.sh']) {
    const target = path.join(work, file);
    for (const input of [write(target), bash(`echo x > ${target}`), bash(`cp /dev/null ${target}`)]) {
      assert.match(ask(input)?.reason ?? '', /a host file a later session in that clone loads from any depth/u, `${input.tool_name} ${file}`);
    }
  }
  // At the clone's root, `.agents` is a root host file, met before the any-depth rule.
  const rootSkill = path.join(work, '.agents/skills/foo/SKILL.md');
  for (const input of [write(rootSkill), bash(`echo x > ${rootSkill}`), bash(`cp /dev/null ${rootSkill}`)]) {
    assert.match(ask(input)?.reason ?? '', /a host file a later session/u, `${input.tool_name} .agents/skills/foo/SKILL.md`);
  }
  assert.match(ask(bash(`rm -rf ${path.join(work, 'pkg', '.claude')}`))?.reason ?? '', /from any depth/u, 'a nested .claude folder itself');
  // A skill folder that links out of .claude/skills: a write through the link, or to its target, refuses.
  mkdirSync(path.join(work, '.agents', 'skills', 'foo'), { recursive: true });
  mkdirSync(path.join(work, '.claude', 'skills'), { recursive: true });
  symlinkSync('../../.agents/skills/foo', path.join(work, '.claude', 'skills', 'foo'));
  for (const target of [path.join(work, '.claude/skills/foo/SKILL.md'), path.join(work, '.agents/skills/foo/SKILL.md')]) {
    assert.match(ask(write(target))?.reason ?? '', /a host file a later session/u, target);
    assert.match(ask(bash(`echo x > ${target}`))?.reason ?? '', /a host file a later session/u, target);
  }
  // A glob that may reach one.
  for (const command of [`rm -f ${work}/*/.claude/skills/x.md`, `rm -f ${work}/pkg/.c*/settings.json`, `cp x ${work}/docs/*.md`, `rm -f ${work}/*/.agents/skills/x/run.sh`]) {
    assert.match(ask(bash(command))?.reason ?? '', /a host file a later session in that c(?:heckout|lone) loads/u, command);
  }
  for (const file of ['pkg/src/x.js', 'a/.claude/notes.md', 'a/claude/skills/x.md', 'docs/README.md', 'pkg/agents/x.md']) {
    assert.equal(ask(write(path.join(work, file))), null, file);
    assert.equal(ask(bash(`echo x > ${path.join(work, file)}`)), null, file);
  }
  assert.equal(ask(bash(`rm -f ${work}/src/*.js`)), null, 'a glob that names no host file');
  // OpenCode's folder and config files, at any depth and in any case.
  for (const file of ['pkg/.opencode/plugins/x.js', 'pkg/.OPENCODE/x', 'pkg/opencode.json', 'a/b/opencode.jsonc']) {
    const target = path.join(work, file);
    for (const input of [write(target), bash(`echo x > ${target}`), bash(`cp /dev/null ${target}`)]) {
      assert.match(ask(input)?.reason ?? '', /a host file a later session in that clone loads from any depth/u, `${input.tool_name} ${file}`);
    }
  }
  for (const command of [`rm -f ${work}/*/.opencode/plugins/x.js`, `cp x ${work}/pkg/opencode.js*`]) {
    assert.match(ask(bash(command))?.reason ?? '', /a host file a later session in that c(?:heckout|lone) loads/u, command);
  }
  for (const file of ['pkg/opencode.md', 'pkg/src/opencode.json.ts']) {
    assert.equal(ask(write(path.join(work, file))), null, file);
    assert.equal(ask(bash(`echo x > ${path.join(work, file)}`)), null, file);
  }
  // A glob whose middle part may name a config file's name names no host file: only a last part names a file.
  for (const command of [`rm -rf ${work}/packages/*/dist`, `cp x ${work}/packages/*/README.txt`]) assert.equal(ask(bash(command)), null, command);
});

test('a write through a tracked .opencode link of the clone, or to the plain folder it leads to, is refused', (t) => {
  const fx = fixture(t);
  const ask = fx.steady({ own: () => fx.attempt });
  const work = path.join(fx.attempt, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(fx.attempt, 'git'), work], { stdio: 'pipe' });
  mkdirSync(path.join(work, 'shared'), { recursive: true });
  mkdirSync(path.join(work, 'pkg'));
  writeFileSync(path.join(work, 'shared', 'keep.md'), 'x\n');
  symlinkSync('../shared', path.join(work, 'pkg', '.opencode'));
  gitIn(work)('add', '.');
  gitIn(work)('commit', '-q', '-m', 'link');
  const nested = /a host file a later session in that clone loads from any depth/u;
  for (const file of ['shared/plugins/x.js', 'pkg/.opencode/plugins/x.js']) {
    const target = path.join(work, file);
    for (const input of [write(target), bash(`echo x > ${target}`)]) assert.match(ask(input)?.reason ?? '', nested, `${input.tool_name} ${file}`);
  }
  assert.equal(ask(write(path.join(work, 'pkg', 'src', 'x.js'))), null);
});

test('a write through a .claude link of the clone, or to the folder it leads to, is refused as the host file it is; one past no link passes', (t) => {
  const fx = fixture(t);
  const own = () => fx.attempt;
  const work = path.join(fx.attempt, 'work');
  // The clone, with pkg/.claude a link to shared, committed, as a branch a session checked out could hold it.
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(fx.attempt, 'git'), work], { stdio: 'pipe' });
  mkdirSync(path.join(work, 'shared', 'commands'), { recursive: true });
  mkdirSync(path.join(work, 'pkg'));
  writeFileSync(path.join(work, 'shared', 'commands', 'ok.md'), '---\nhooks: {}\n---\n');
  symlinkSync('../shared', path.join(work, 'pkg', '.claude'));
  gitIn(work)('add', '.');
  gitIn(work)('commit', '-q', '-m', 'link');
  const nested = /a host file a later session in that clone loads from any depth/u;
  for (const file of ['pkg/.claude/commands/evil.md', 'shared/commands/evil.md', 'pkg/.claude/settings.local.json', 'shared/settings.json', 'shared/skills/x/run.sh']) {
    const target = path.join(work, file);
    for (const input of [write(target), bash(`echo x > ${target}`)]) assert.match(fx.ask(input, { own })?.reason ?? '', nested, `${input.tool_name} ${file}`);
  }
  for (const file of ['shared/notes.md', 'pkg/.claude/notes.md', 'pkg/src/x.js']) assert.equal(fx.ask(write(path.join(work, file)), { own }), null, file);
  // A link git does not know of is judged by its spelled path alone.
  rmSync(path.join(work, 'pkg', '.claude'));
  gitIn(work)('rm', '-q', '--cached', 'pkg/.claude');
  symlinkSync('../shared', path.join(work, 'pkg', '.claude'));
  assert.match(fx.ask(write(path.join(work, 'pkg/.claude/commands/evil.md')), { own })?.reason ?? '', nested, 'through an untracked link, as spelled');
  assert.match(fx.ask(bash(`ln -s ../shared ${path.join(work, 'lib', '.claude')}`), { own })?.reason ?? '', nested, 'making a .claude link');
});

test('a clone whose whole git index lists more than 1 MiB still lets writes pass, and its indexed .claude link still refuses one to its target', (t) => {
  const fx = fixture(t);
  const own = () => fx.attempt;
  const work = path.join(fx.attempt, 'work');
  const inWork = gitIn(work);
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(fx.attempt, 'git'), work], { stdio: 'pipe' });
  mkdirSync(path.join(work, 'shared', 'commands'), { recursive: true });
  mkdirSync(path.join(work, 'pkg'));
  mkdirSync(path.join(work, 'src'));
  writeFileSync(path.join(work, 'shared', 'commands', 'ok.md'), 'ok\n');
  symlinkSync('../shared', path.join(work, 'pkg', '.claude'));
  inWork('add', '.');
  // 12,000 index entries with long names, put in the index straight, as a large repository tracks them.
  const blob = execFileSync('git', ['-C', work, 'hash-object', '-w', '--stdin'], { input: 'x\n', encoding: 'utf8' }).trim();
  const long = 'a'.repeat(80);
  const entries = Array.from({ length: 12_000 }, (_, at) => `100644 ${blob}\tsrc/generated/${long}-${at}.js\n`).join('');
  execFileSync('git', ['-C', work, 'update-index', '--index-info'], { input: entries, stdio: ['pipe', 'pipe', 'pipe'] });
  const whole = execFileSync('git', ['-C', work, 'ls-files', '--stage', '-z'], { maxBuffer: 64 * 1024 * 1024 });
  assert.ok(whole.length > 1024 * 1024, `the whole index lists ${whole.length} bytes`);
  assert.equal(fx.ask(write(path.join(work, 'src', 'x.js')), { own }), null, 'Write src/x.js');
  assert.equal(fx.ask(bash(`echo x > ${path.join(work, 'src', 'y.js')}`), { own }), null, 'a Bash write');
  assert.match(fx.ask(write(path.join(work, 'shared', 'commands', 'evil.md')), { own })?.reason ?? '', /a host file a later session in that clone loads from any depth/u, 'the indexed link\'s target');
});

test('the host files a later session loads stay refused in its own worktree and its attempt\'s clone, by the write tool and the shell', (t) => {
  const fx = fixture(t);
  const ask = fx.steady({ own: () => fx.attempt });
  for (const top of [fx.worktree, path.join(fx.attempt, 'work')]) {
    for (const file of ['.claude/settings.json', '.claude/settings.local.json', '.claude/skills/x/SKILL.md', '.claude/agents/a.md', '.claude/commands/c.md', '.claude/hooks/h.sh', '.claude/workflows/w.md', '.claude/scheduled_tasks.json', '.mcp.json',
      '.opencode/plugins/x.js', 'opencode.json', 'opencode.jsonc', '.agents/skills/x/SKILL.md', '.agents/skills/x/run.sh', '.agents/plugins/marketplace.json']) {
      const target = path.join(top, file);
      for (const input of [write(target), bash(`echo x > ${target}`), bash(`mkdir -p ${path.dirname(target)} && touch ${target}`)]) {
        assert.match(ask(input)?.reason ?? '', /a host file a later session in that checkout loads/u, `${input.tool_name} ${file} in ${top}`);
      }
    }
    assert.match(ask(bash(`rm -rf ${path.join(top, '.claude')}`))?.reason ?? '', /a host file a later session/u, 'a folder that holds them');
    assert.equal(ask(write(path.join(top, '.claude', 'notes.md'))), null, 'another file of .claude, which the next start compares with the base tip');
    assert.equal(ask(write(path.join(top, 'src', 'x.js'))), null);
  }
});

test('a host file named .jsonc is a file, refused through a hard link beside it; .mcp.json stays one, and .opencode stays a folder', (t) => {
  const fx = fixture(t);
  const ask = fx.steady();
  const refused = /a host file a later session in that checkout loads/u;
  for (const name of ['opencode.jsonc', '.mcp.json']) {
    writeFileSync(path.join(fx.worktree, name), '{}\n');
    const alias = path.join(fx.worktree, `alias-of${name}`);
    linkSync(path.join(fx.worktree, name), alias);
    for (const input of [write(alias), bash(`echo x > ${alias}`)]) assert.match(ask(input)?.reason ?? '', refused, `${input.tool_name} through a hard link to ${name}`);
  }
  for (const input of [write(path.join(fx.worktree, '.opencode/a/b')), bash(`echo x > ${path.join(fx.worktree, '.opencode/a/b')}`)]) {
    assert.match(ask(input)?.reason ?? '', refused, `${input.tool_name} .opencode/a/b, in the folder entry`);
  }
  assert.equal(ask(write(path.join(fx.worktree, 'notes.md'))), null, 'a file with no second link');
});

test('a target built at run time refuses when the whole command names a refused path, a startup file, a home dot entry, or a git folder; a loop or mktemp passes', (t) => {
  const fx = fixture(t);
  for (const command of [
    'd=~/.ssh; echo x > "$d/k"',
    'p=.git/hooks; echo x > "$p/pre-commit"',
    `f=${fx.dir}/.git/config; echo x >> "$f"`,
    `g=${fx.home}/.gitconfig; cp x "$g"`,
    'cat ~/.zshrc > "$out"',
    'repo=x/.git; echo x > "$repo/HEAD"',
  ]) {
    const denial = fx.ask(bash(command));
    assert.match(denial?.reason ?? '', /a path built at run time.*write to a literal path instead/u, command);
  }
  for (const command of ['for f in a.md b.md; do echo x > "$f"; done', 'out=$(mktemp); npm test > "$out"', 'echo x > "$out" && cat .gitignore']) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
  // A bare variable from a call folder outside every place is judged by its names alone.
  const outside = path.join(fx.root, 'outside');
  mkdirSync(outside);
  assert.equal(fx.ask(bash('echo x > "$out"'), { cwd: outside }), null);
});

test('mkdir of the reviews or dispatch folder itself passes; below it, with a mode, or rm, rmdir, or mv of it refuse', (t) => {
  const fx = fixture(t);
  const [reviews, dispatch] = ['reviews', 'dispatch'].map((name) => path.join(fx.state, name));
  for (const command of [`mkdir -p ${reviews}`, `mkdir ${dispatch}`, `mkdir -p ${reviews} ${dispatch}`, `mkdir -p ${reviews} && echo '{}' > ${reviews}/pr-7.json.tmp`]) {
    assert.equal(fx.ask(bash(command)), null, command);
  }
  for (const [command, reason] of [
    [`mkdir -p ${reviews}/sub`, /the review and attest records/u],
    [`mkdir -m 777 ${reviews}`, /the review and attest records/u],
    [`mkdir -pm 777 ${dispatch}`, /the dispatch records/u],
    [`mkdir --mode=777 ${dispatch}`, /the dispatch records/u],
    [`mkdir -p ${reviews} && touch ${reviews}`, /the review and attest records/u],
    [`rm -rf ${reviews}`, /the review and attest records/u],
    [`rmdir ${dispatch}`, /the dispatch records/u],
    [`mv ${reviews} ${fx.temp}/old`, /the review and attest records/u],
  ]) {
    assert.match(fx.ask(bash(command))?.reason ?? '', reason, command);
  }
  assert.match(fx.ask(write(reviews))?.reason ?? '', /the review and attest records/u, 'the write tool on the folder itself');
});

// A host's own scratch folder under the home folder, such as a job's `tmp` in a host dot folder, is refused, and an agent
// that read only "only the Human does" tried the same write three times in a run. The refusal names where scratch work
// goes instead: the temporary folder and the state folder's tmp, by their paths.
test('a refused write to a home dot folder, or to a path built at run time beside one, names the temporary folders to write instead', (t) => {
  const fx = fixture(t);
  const job = path.join(fx.home, '.claude', 'jobs', 'f5fa4566', 'tmp');
  const tmp = path.join(realFolded(fx.state), 'tmp');
  for (const input of [bash(`node --test > ${job}/changed.log 2>&1`), bash(`mkdir -p ${job}/oc1/home`), bash(`D=${job}/probe; mkdir -p $D`), write(path.join(job, 'x.txt'), { agent_id: 'a5f0c1' })]) {
    const reason = fx.ask(input)?.reason ?? '';
    assert.match(reason, /a dot file or folder of the user's home folder/u, input.tool_input.command ?? input.tool_input.file_path);
    assert.ok(reason.includes(`write scratch files in ${realFolded(fx.temp)}`), reason);
    assert.ok(reason.includes(tmp), reason);
  }
  // The temporary folder it names passes.
  assert.equal(fx.ask(bash(`node --test > ${fx.temp}/changed.log 2>&1`)), null);
});

// A script an interpreter runs may write any path its text names, so one that names a home dot path is refused, even
// when the path is only text the script puts in a file. A background session rewriting its handoff brief with a Python
// heredoc, whose text quoted a plugin path for the Human, was refused twice, was told only where scratch files go, and
// then built the path at run time to get past the rule. The refusal says the path was read from an interpreter's code,
// input, or words, and names the file tool, which writes only the file it names, whatever its text says.
test('a script whose text names a home dot path is refused with the file tool as the route, and the file tool writes that text', (t) => {
  const fx = fixture(t);
  const handoffs = path.join(fx.state, 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  const brief = path.join(handoffs, 'brief.md');
  const quoted = path.join(fx.home, '.claude', 'plugins', 'cache', 'aidrian', '0.86.2', 'bin', 'aidrian');
  const command = `python3 -I - ${brief} > ${handoffs}/brief.tmp <<'EOF'\nimport sys\nt=open(sys.argv[1]).read()\nt=t.replace("old", "run ${quoted} report")\nsys.stdout.write(t)\nEOF\nmv ${handoffs}/brief.tmp ${brief}`;
  // An interpreter's code, its input, and its other words, such as a destination its script takes from `sys.argv`, all
  // say where the path was read; the route is for text that only goes in a file.
  for (const input of [bash(command), bash(`python3 -c 'print("${quoted}")' > ${handoffs}/brief.tmp`), bash(`python3 - ${quoted} <<'EOF'\nimport sys\nopen(sys.argv[1], 'w').write('x')\nEOF`)]) {
    const reason = fx.ask(input)?.reason ?? '';
    assert.match(reason, /a dot file or folder of the user's home folder/u, input.tool_input.command);
    assert.match(reason, /names .* in an interpreter's code, input, or words, which may write it/u, reason);
    assert.match(reason, /when that text only goes in a file, write the file with the file tool instead, which writes only the file it names/u, reason);
  }
  // A write the shell itself makes to a home dot path keeps its own refusal: the path is no text of a script.
  const direct = fx.ask(bash(`echo x > ${quoted}`))?.reason ?? '';
  assert.match(direct, /a dot file or folder of the user's home folder/u);
  assert.doesNotMatch(direct, /in an interpreter's code/u);
  // So does a target the guard reads by its name, in a folder no path gives: it is no interpreter's text.
  const unplaced = fx.ask(bash(`cd "$X" && echo x > a/${quoted}`))?.reason ?? '';
  assert.match(unplaced, /a dot file or folder of the user's home folder/u, unplaced);
  assert.doesNotMatch(unplaced, /in an interpreter's code/u);
  // A whole line read for want of an interpreter's code holds the shell's own words, such as that target: the refusal
  // says the call writes the path.
  const line = fx.ask(bash(`printf 'print(1)' | python3 - && cd "$X" && echo x > a/${quoted}`))?.reason ?? '';
  assert.match(line, /a dot file or folder of the user's home folder/u, line);
  assert.doesNotMatch(line, /in an interpreter's code/u);
  // The route it names: the file tool writes the brief, whatever path its text quotes.
  assert.equal(fx.ask(write(brief, { tool_input: { file_path: brief, content: `Run ${quoted} report --since 24h.\n` } })), null);
  assert.equal(fx.ask({ tool_name: 'Edit', tool_input: { file_path: brief, old_string: 'old', new_string: `run ${quoted} report` } }), null);
});

// A file tool's target is judged both folded as text and where the system lands (fs.mjs systemPath): a `..` after a
// link climbs from the link's target, so `<worktree>/a/out/../x`, with `out` a link outside the places, lands outside
// while its folded text stays in the worktree.
test('a Write or an Edit through a link and a `..` that lands outside the places is refused, and one that stays in passes', (t) => {
  const fx = fixture(t);
  const outside = path.join(fx.root, 'outside', 'deep');
  mkdirSync(outside, { recursive: true });
  mkdirSync(path.join(fx.worktree, 'a'));
  symlinkSync(outside, path.join(fx.worktree, 'a', 'out'));
  const ask = fx.steady();
  const through = `${fx.worktree}/a/out/../x.txt`;
  assert.equal(path.resolve(through), path.join(fx.worktree, 'a', 'x.txt'), 'the text folds into the worktree');
  for (const input of [write(through), { tool_name: 'Edit', tool_input: { file_path: through, old_string: 'a', new_string: 'b' } }, write('a/out/../x.txt')]) {
    assert.match(ask(input)?.reason ?? '', /outside the places a session no Human attends may write/u, JSON.stringify(input));
  }
  assert.equal(ask(write(path.join(fx.worktree, 'a', 'x.txt'))), null, 'the same file named without the link');
  mkdirSync(path.join(fx.worktree, 'b'));
  symlinkSync(path.join(fx.worktree, 'b'), path.join(fx.worktree, 'a', 'in'));
  assert.equal(ask(write(`${fx.worktree}/a/in/../y.txt`)), null, 'a link that stays in the worktree');
});

// A folder that holds a checkout of the repository git lists, wherever it lies, is refused to a removal or move: the
// checkout and its `.git` pointer would go with it.
test('removing or moving a temporary folder above a sibling worktree is refused, and removing a plain folder passes', (t) => {
  const fx = fixture(t);
  const work = path.join(fx.temp, 'work');
  mkdirSync(work);
  gitIn(fx.dir)('worktree', 'add', '-q', '-b', 'feat/sib', path.join(work, 'sib'));
  mkdirSync(path.join(fx.temp, 'other'));
  mkdirSync(path.join(fx.worktree, 'node_modules', 'x'), { recursive: true });
  const ask = fx.steady();
  for (const command of [`rm -rf ${work}`, `mv ${work} ${fx.temp}/moved`, `rm -rf ${fx.temp}/work/`]) {
    assert.match(ask(bash(command))?.reason ?? '', /a folder that holds a checkout of the repository/u, command);
  }
  for (const command of [`rm -rf ${fx.temp}/other`, 'rm -rf node_modules', `touch ${work}/note.txt`]) assert.equal(ask(bash(command)), null, command);
});
