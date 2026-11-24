// The scope of the guards a project run added to every project (lib/handoff-guard.mjs): the main checkout's host paths
// are held for a session no Human attends, and for every subagent while the project has a run under way; and a base
// branch config that cannot be read holds a write outside every checkout only where this project keeps a run or a held
// session. A plain project with no run, attended, works as it did before project runs. Every read here is in-process,
// with the test's own home folder: no test reads the user's real state.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { baseReader, continueStoreWriteDenial, hostServiceDenial, hostSessionStartDenial, mainCheckoutWriteDenial, projectRunWriteDenial, stateFolders } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { activeRuns, appendToRun, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { ownAttemptFolder, projectRunActive } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { factReads, tally } from './git-call-log.mjs';
import { DRIVER, OTHER, runFixture } from './project-start-fixture.mjs';

// A plain project with no project run: a config.json naming a state folder of its own, one commit, and a home folder.
// `origin` adds a remote that was never fetched.
function plainProject(t, { origin = false } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-scope-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'config');
  if (origin) git('remote', 'add', 'origin', 'git@github.com:acme/new.git');
  const project = findProject(dir);
  const { config } = loadConfig(project);
  return { root, dir, home, state, project, config };
}

const write = (file, more = {}) => ({ tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, ...more });
const bash = (command, more = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...more });
const attended = () => false;

test('in a plain project with no project run, an attended session\'s subagent writes the main checkout\'s host files', (t) => {
  const fx = plainProject(t);
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), false);
  const ask = (input) => mainCheckoutWriteDenial({ session_id: OTHER, cwd: fx.dir, ...input }, fx.project, fx.config, { unattended: attended, runSession: () => projectRunActive(fx.project, fx.config, { home: fx.home }) });
  for (const file of ['.claude/agents/reviewer.md', '.claude/skills/x/SKILL.md', '.claude/commands/ship.md', '.claude/settings.local.json']) {
    const target = path.join(fx.dir, file);
    for (const input of [write(target, { agent_id: 'agent-1' }), bash(`echo x > ${target}`, { agent_id: 'agent-1' }), write(target)]) {
      assert.equal(ask(input), null, `${file} ${input.tool_name}${input.agent_id ? ' (subagent)' : ''}`);
    }
  }
});

test('while a project run is under way, no subagent writes the main checkout\'s host files, whichever session it belongs to', (t) => {
  const fx = runFixture(t);
  const target = path.join(fx.dir, '.claude/agents/merger.md');
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), true);
  const runSession = () => projectRunActive(fx.project, fx.config, { home: fx.home });
  const ask = (session, more = {}) => mainCheckoutWriteDenial(write(target, { session_id: session, cwd: fx.dir, ...more }), fx.project, fx.config, { unattended: attended, runSession });
  for (const session of [DRIVER, OTHER]) assert.match(ask(session, { agent_id: 'agent-7' })?.reason ?? '', /which no subagent writes while a project run is under way/u, session);
  assert.equal(ask(DRIVER), null, 'the main session, attended');
});

test('a folder of runs that cannot be listed reads as a run whose driver cannot be told', (t) => {
  if (process.getuid?.() === 0) return t.skip('root lists any folder');
  const fx = plainProject(t);
  mkdirSync(runsFolder(fx.state), { recursive: true });
  chmodSync(runsFolder(fx.state), 0o000);
  try {
    assert.deepEqual(activeRuns(fx.state), [{ run: null }]);
    assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), true);
  } finally {
    chmodSync(runsFolder(fx.state), 0o700);
  }
});

test('in a repository whose origin was never fetched, a held write outside the checkout is refused only where a run or a held session is kept', (t) => {
  const fx = plainProject(t, { origin: true });
  const base = baseReader(fx.project);
  assert.equal(base().failed, true);
  const folders = stateFolders(fx.project, fx.config, { home: fx.home, base });
  const outside = path.join(fx.root, 'notes.md');
  const ask = (guard, input) => guard({ session_id: OTHER, cwd: fx.dir, ...input }, fx.project, fx.config, () => folders, { unattended: attended, base, home: fx.home });
  for (const guard of [continueStoreWriteDenial, projectRunWriteDenial]) {
    for (const input of [write(outside, { agent_id: 'agent-1' }), bash(`echo x > ${fx.root}/scratch.txt`, { agent_id: 'agent-1' })]) assert.equal(ask(guard, input), null, guard.name);
  }
  // Once this project keeps a run, the folder that holds it is unknown while the base branch's config cannot be read.
  mkdirSync(path.join(runsFolder(fx.state), 'launch'), { recursive: true });
  for (const guard of [continueStoreWriteDenial, projectRunWriteDenial]) {
    const denial = ask(guard, write(outside, { agent_id: 'agent-1' }));
    assert.match(denial?.reason ?? '', /it writes outside every checkout of this project, which keeps a project run or a session no Human attends/u, guard.name);
    assert.doesNotMatch(denial.reason, /continuation store/u);
  }
});

test('a confined session writes its running attempt\'s folders in the runs folder, as the ledger names them, and nothing else there', (t) => {
  const fx = runFixture(t);
  const folders = stateFolders(fx.project, fx.config, { home: fx.home });
  const attempts = path.join(runsFolder(fx.state), 'launch', 'attempts');
  const attempt = path.join(attempts, 'ENG-1.1');
  for (const part of ['work', 'git', 'drop', 'cache']) mkdirSync(path.join(attempt, part), { recursive: true });
  const at = new Date().toISOString();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch ENG-1 1', cwd: path.join(attempt, 'work'), branch: 'feat/eng-1-export', drop: path.join(attempt, 'drop'), at, outcome: 'started', id: 'pid-1-0000000000000000', child: OTHER },
    { event: 'issue', key: 'ENG-1', state: 'running', at },
  ] }));
  const mark = { project: 'launch', issue: 'ENG-1' };
  assert.equal(ownAttemptFolder(fx.project, fx.config, mark, { home: fx.home }), realpathSync(attempt));
  assert.equal(ownAttemptFolder(fx.project, fx.config, { project: 'launch', issue: 'ENG-4' }, { home: fx.home }), null, 'an issue with no running confined start');
  const ask = (file, own = () => ownAttemptFolder(fx.project, fx.config, mark, { home: fx.home })) => projectRunWriteDenial(write(file, { session_id: OTHER, cwd: path.join(attempt, 'work') }), fx.project, fx.config, () => folders, { unattended: () => true, home: fx.home, own });
  for (const folder of ['work', 'git', 'drop', 'cache']) assert.equal(ask(path.join(attempt, folder, 'file.txt')), null, folder);
  assert.match(ask(path.join(attempt, 'work', 'x.txt'), null)?.reason ?? '', /the folder of the project runs/u, 'a session with no attempt');
  for (const file of [path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl'), path.join(attempt, 'other.txt'), path.join(attempts, 'ENG-1.2', 'work', 'x.txt'), path.join(runsFolder(fx.state), 'launch', 'logs', 'ENG-1.1.jsonl')]) {
    assert.match(ask(file)?.reason ?? '', /the folder of the project runs/u, file);
  }
});

// The session start guard as a subagent (`agent`) or a main session no Human attends (`unattended`) meets `command`.
const startAsk = (command, { agent = 'agent-1', unattended = () => false } = {}) => hostSessionStartDenial(
  bash(command, { session_id: OTHER, cwd: '/x', ...(agent ? { agent_id: agent } : {}) }), { names: { human: 'the Human' } }, { unattended },
);
const OPENCODE_STARTS = ['opencode', 'opencode run x', 'opencode serve', 'opencode mini', 'opencode ./src', 'opencode mcp frob', 'opencode service start',
  'opencode auth list', 'opencode --standalone', '/opt/homebrew/bin/opencode run x', 'bash -c "opencode run x"', 'opencode $SUB',
  // A command that talks to the background service, which OpenCode discovers or starts, and one that may restart it.
  'opencode models', 'opencode session list', 'opencode mcp list', 'opencode upgrade',
  // A help flag past a `--`, or beside a word the shell expands, is no help read; `-v` past the first word is no version read.
  'opencode run -- --help', 'opencode run $PROMPT --help', 'opencode run {--,x} --help', 'opencode --help {--,x}', 'opencode serve -v',
  // Through a package runner, by its packages' names.
  'npx @opencode/cli run x', 'npx -y @opencode/cli@2.4.0 run x', 'pnpm dlx @opencode/cli run x', 'bunx opencode-ai serve', 'npx opencode-ai', 'npm exec opencode-ai run x',
  // Past a runner's global option that takes the next word, before the runner's own word.
  'npm --workspace web exec opencode run x', 'npm -w web exec opencode run x', 'npm --prefix /tmp/p exec opencode run x', 'npm -C /tmp/p x opencode run x',
  'npx --prefix /tmp/p opencode run x', 'pnpm --dir web dlx @opencode/cli run x', 'pnpm -C web exec opencode run x', 'pnpm --filter web exec opencode run x', 'pnpm -F web exec opencode run x'];

test('a subagent, and a session the background route started, may not start an OpenCode session, and may run what starts none', () => {
  for (const command of OPENCODE_STARTS) {
    assert.match(startAsk(command)?.reason ?? '', /starts or resumes a session of OpenCode outside the handoff gate/u, command);
    assert.match(startAsk(command, { agent: null, unattended: () => true })?.reason ?? '', /outside the handoff gate/u, `unattended: ${command}`);
    assert.equal(startAsk(command, { agent: null }), null, `an attended main session may: ${command}`);
  }
  for (const command of ['opencode --version', 'opencode -h', 'opencode serve --help', 'opencode run -h', 'opencode mcp add --help', 'npx @opencode/cli serve --help', 'opencode mcp add x', 'opencode service stop', 'opencode debug paths', 'echo opencode', 'npx @opencode/cli --version', 'npx prettier .', 'npx prettier --check .',
    'npm -w opencode exec prettier .', 'pnpm --dir opencode exec prettier .', 'pnpm -C x run opencode']) {
    assert.equal(startAsk(command), null, command);
  }
  // Claude Code's package too.
  assert.match(startAsk('npx @anthropic-ai/claude-code -p x')?.reason ?? '', /starts or resumes a session of Claude Code outside the handoff gate/u);
});

test('a package runner is read as the host program it names past any of its options, and a host program named later counts too', () => {
  for (const [command, host] of [['npm --cache /d exec claude -p hi', 'Claude Code'], ['npm exec --cache /d claude -p hi', 'Claude Code'],
    ['npx --cache /d @anthropic-ai/claude-code -p hi', 'Claude Code'], ['pnpm --dir x dlx opencode-ai run x', 'OpenCode'], ['npm --loglevel=silent --cache /d x codex exec hi', 'Codex'],
    // The one false reading: a host's program named as a later argument of another program.
    ['npx prettier claude', 'Claude Code']]) {
    const why = new RegExp(`starts or resumes a session of ${host} outside the handoff gate`, 'u');
    assert.match(startAsk(command)?.reason ?? '', why, command);
    assert.match(startAsk(command, { agent: null, unattended: () => true })?.reason ?? '', why, `unattended: ${command}`);
  }
  for (const command of ['npm --cache /d exec prettier .', 'npm --cache /d install', 'pnpm --dir x install opencode-plugin']) assert.equal(startAsk(command), null, command);
});

test('a session no Human attends may not read OpenCode\'s service password or reach its background service, by any spelling, and other ports pass', () => {
  const env = { HOME: '/home/user', XDG_STATE_HOME: '/xs', NUM: 7 };
  const ask = (command, unattended = () => true) => hostServiceDenial(bash(command, { session_id: OTHER, cwd: '/x' }), { names: { human: 'the Human' } }, { unattended, env, home: '/home/user' });
  const refused = [
    'cat ~/.local/state/opencode/service.json', 'cat $HOME/.local/state/opencode/service.json', 'cat "${HOME}"/.local/state/opencode/service.json',
    'cat /home/user/.local/state/opencode/service.json', 'jq -r .password $XDG_STATE_HOME/opencode/service.json', 'cat /XS/OpenCode/service.json',
    'python3 -c "print(open(\'/xs/opencode/service.json\').read())"', 'ls ~/.config/opencode', 'cat ~/.local/share/opencode/auth.json',
    'curl -u opencode:pw http://127.0.0.1:49374/api/session', 'curl localhost:49374/api/info', 'curl \'http://[::1]:49374/api/info\'',
    // A path the shell reads the same, with a `.` part, a doubled slash, or a `..` part.
    'cat ~/.local/state/./opencode/service.json', 'cat ~/.local/state//opencode/service.json', 'cat /xs/x/../opencode/service.json',
    'cat $XDG_STATE_HOME/./opencode/service.json', 'ls ~/.config//opencode/',
    // A variable that names a property every object has, or a value that is no text, expands to nothing.
    'echo $constructor ${toString} $__proto__ $NUM; cat ~/.local/state/opencode/service.json',
  ];
  for (const command of refused) {
    assert.match(ask(command)?.reason ?? '', /local service starts a session no guard holds/u, command);
    assert.equal(ask(command, () => false), null, `an attended session may: ${command}`);
  }
  for (const command of ['curl http://localhost:3000', 'curl 127.0.0.1:493740', 'cat ~/.local/state/opencode-old/x', 'cat notes.md', 'ls ~/.local/state']) {
    assert.equal(ask(command), null, command);
  }
});

test('the service guard asks whether a Human attends only for a command that names the service, since the hook\'s answer runs git', () => {
  const env = { HOME: '/home/user', XDG_STATE_HOME: '/xs' };
  let asked = 0;
  const unattended = () => (asked += 1) > 0;
  const ask = (command) => hostServiceDenial(bash(command, { session_id: OTHER, cwd: '/x' }), { names: { human: 'the Human' } }, { unattended, env, home: '/home/user' });
  for (const command of ['git status', 'npm test', 'curl http://localhost:3000', 'cat notes.md']) assert.equal(ask(command), null, command);
  assert.equal(asked, 0, 'no command that names neither a store nor a port asks');
  assert.match(ask('curl localhost:49374/api/info')?.reason ?? '', /local service starts a session no guard holds/u);
  assert.equal(asked, 1, 'a command that names the port asks once');
});

test('a live unattended mark that names the project is a run under way', (t) => {
  const fx = plainProject(t);
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), false);
  markUnattended(OTHER, { root: fx.dir, env: { ...process.env, XDG_STATE_HOME: path.join(fx.home, '.local/state') } });
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), true);
});

test('one call for the whole list of state folders reads each checkout\'s roots once, and the lazy form is still an iterator', (t) => {
  const fx = plainProject(t);
  let folders;
  const reads = factReads(t, () => (folders = stateFolders(fx.project, fx.config, { home: fx.home })));
  assert.ok(Array.isArray(folders) && folders.includes(fx.state), `the list holds the configured state folder: ${folders}`);
  const roots = reads.filter((line) => line.endsWith(' roots'));
  assert.ok(roots.includes(`${fx.dir} roots`), `the checkout's roots are read: ${roots.join(' | ')}`);
  assert.deepEqual(tally(roots), Object.fromEntries(roots.map((line) => [line, 1])), 'each folder\'s roots once');
  const lazy = stateFolders(fx.project, fx.config, { home: fx.home, lazy: true });
  assert.ok(!Array.isArray(lazy) && typeof lazy.next === 'function', 'with lazy, an iterator');
  assert.deepEqual([...lazy], folders, 'that gives the same folders');
});
