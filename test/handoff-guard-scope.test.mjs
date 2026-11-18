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
import { baseReader, continueStoreWriteDenial, mainCheckoutWriteDenial, projectRunWriteDenial, stateFolders } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { activeRuns, appendToRun, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { ownAttemptFolder, projectRunActive } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
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
  for (const part of ['work', 'git', 'drop']) mkdirSync(path.join(attempt, part), { recursive: true });
  const at = new Date().toISOString();
  appendToRun(fx.state, 'launch', () => ({ rows: [
    { event: 'start', key: 'ENG-1', attempt: 1, session: DRIVER, name: 'launch ENG-1 1', cwd: path.join(attempt, 'work'), branch: 'feat/eng-1-export', drop: path.join(attempt, 'drop'), at, outcome: 'started', id: 'pid-1-0000000000000000', child: OTHER },
    { event: 'issue', key: 'ENG-1', state: 'running', at },
  ] }));
  const mark = { project: 'launch', issue: 'ENG-1' };
  assert.equal(ownAttemptFolder(fx.project, fx.config, mark, { home: fx.home }), realpathSync(attempt));
  assert.equal(ownAttemptFolder(fx.project, fx.config, { project: 'launch', issue: 'ENG-4' }, { home: fx.home }), null, 'an issue with no running confined start');
  const ask = (file, own = () => ownAttemptFolder(fx.project, fx.config, mark, { home: fx.home })) => projectRunWriteDenial(write(file, { session_id: OTHER, cwd: path.join(attempt, 'work') }), fx.project, fx.config, () => folders, { unattended: () => true, home: fx.home, own });
  for (const folder of ['work', 'git', 'drop']) assert.equal(ask(path.join(attempt, folder, 'file.txt')), null, folder);
  assert.match(ask(path.join(attempt, 'work', 'x.txt'), null)?.reason ?? '', /the folder of the project runs/u, 'a session with no attempt');
  for (const file of [path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl'), path.join(attempt, 'other.txt'), path.join(attempts, 'ENG-1.2', 'work', 'x.txt'), path.join(runsFolder(fx.state), 'launch', 'logs', 'ENG-1.1.jsonl')]) {
    assert.match(ask(file)?.reason ?? '', /the folder of the project runs/u, file);
  }
});

test('a live unattended mark that names the project is a run under way', (t) => {
  const fx = plainProject(t);
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), false);
  markUnattended(OTHER, { root: fx.dir, env: { ...process.env, XDG_STATE_HOME: path.join(fx.home, '.local/state') } });
  assert.equal(projectRunActive(fx.project, fx.config, { home: fx.home }), true);
});
