// The hooks' side of a project run (lib/project-run-guard.mjs, lib/handoff-guard.mjs): every `aidrian project` command
// is authorized against its run's ledger by the host's own session id; a subagent runs only `next`; a form the hooks
// cannot read the words of is refused; no command sets a variable for it; and a subagent or a session no Human attends
// never writes in the folder of the project runs. The fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config-defaults.mjs';
import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { PastDeadline, withinDeadline } from '../plugins/aidrian/lib/deadline.mjs';
import { baseReader, continueStoreWriteDenial, handoffEnvDenial, mainCheckoutWriteDenial, PROJECT_SUB, PROJECT_WORD, projectRunWriteDenial, remoteChangeDenial, RUNS_FOLDER, stateFolders } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { ISSUE_PART, RUN_PART } from '../plugins/aidrian/lib/handoff-markers.mjs';
import claudeCode from '../plugins/aidrian/lib/hosts/claude-code.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { mainCheckoutPaths } from '../plugins/aidrian/lib/hosts/index.mjs';
import { findProject } from '../plugins/aidrian/lib/project.mjs';
import { ACTIONS } from '../plugins/aidrian/lib/project-run-cli.mjs';
import { ISSUE_KEY, RUN_ID, runsFolder } from '../plugins/aidrian/lib/project-run.mjs';
import { projectCalls, projectCommandDenial, SUBCOMMAND_RULES, SUBCOMMANDS } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { ISSUE_TAG, markPending, markUnattended, RUN_TAG } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DRIVER, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

const AGENT_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-agent-gates.mjs');
const STOP_HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-stop.mjs');
const bash = (command, more = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...more });
// A hook script run as the host runs it, with the fixture's environment: its state root, marks, and host config folder
// are the test's own, and HOME is the fixture's home folder.
const runHook = (hook, input, env) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), cwd: input.cwd, env: { ...env, HOME: path.join(path.dirname(env.XDG_STATE_HOME), '..') }, encoding: 'utf8' });
const attended = () => false;
// The clone the fixture's first start makes for issue ENG-1, where its session works.
const clone = (fx) => path.join(runsFolder(fx.state), 'launch', 'attempts', 'ENG-1.1', 'work');
const unattended = () => true;

test('a subagent runs only aidrian project next, whatever its session id', (t) => {
  const fx = runFixture(t);
  const sub = (command) => projectCommandDenial(bash(command, { session_id: DRIVER, agent_id: 'agent-7', cwd: fx.dir }), fx.config, { home: fx.home });
  for (const action of ['init launch --file x.json', 'start launch ENG-1', 'wait launch', 'result launch ENG-1 --file r.json', 'handoff launch b.md', 'summary launch']) {
    const denial = sub(`aidrian project ${action}`);
    assert.match(denial?.reason ?? '', /a subagent runs only `aidrian project next`/u, action);
    assert.match(denial.reason, /blocked for a subagent/u);
  }
  assert.equal(sub('aidrian project next launch'), null);
  assert.equal(sub('aidrian project next launch --json'), null);
});

test('each command is authorized against the ledger by the host\'s session id: the driver\'s commands, and the issue session\'s result', (t) => {
  const fx = runFixture(t);
  const ask = (command, session) => projectCommandDenial(bash(command, { session_id: session, cwd: fx.dir }), fx.config, { unattended: attended, home: fx.home });
  assert.equal(ask('aidrian project start launch ENG-1', DRIVER), null);
  assert.equal(ask('aidrian project wait launch --max-wait 60', DRIVER), null);
  assert.match(ask('aidrian project start launch ENG-1', OTHER).reason, /`aidrian project start` is the driver's, and this session is not the driver of the run launch/u);
  assert.match(ask(`cd ${fx.root} && aidrian project wait launch --project ${fx.dir}`, OTHER).reason, /is the driver's/u, 'from another folder, by --project');
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const child = STARTED[0].session;
  assert.equal(ask('aidrian project result launch ENG-1 --file /tmp/r.json', child), null);
  assert.match(ask('aidrian project result launch ENG-1 --file /tmp/r.json', DRIVER).reason, /records the result of the issue's own session, and only the session the run started for the issue ENG-1/u);
  assert.match(ask('aidrian project start launch ENG-4', child).reason, /is the driver's/u);
  // A run the hook cannot read lets the command run; the command reads the same files and refuses.
  assert.equal(ask('aidrian project start nope ENG-1', OTHER), null);
  assert.equal(ask('aidrian project next launch', OTHER), null);
});

test('init through the hook is held to attendedProblem with the hook\'s own payload', (t) => {
  const fx = runFixture(t, { init: false });
  const ask = (session) => projectCommandDenial(bash('aidrian project init launch --file snapshot.json.input', { session_id: session, cwd: fx.dir }), fx.config, { home: fx.home });
  assert.equal(ask(DRIVER), null);
  markUnattended(OTHER, { root: fx.dir, env: fx.env });
  assert.match(ask(OTHER).reason, /makes this session a project run's driver, and the background handoff route started this session/u);
  markPending('abcd1234-0000-4000-8000-00000000ff01', { cwd: fx.dir, root: fx.dir, env: fx.env });
  assert.match(ask(DRIVER).reason, /another session's handoff gate is starting a background session/u);
});

test('a dynamic subcommand word after project is refused to every session', (t) => {
  const fx = runFixture(t);
  for (const command of ['aidrian project "$(echo init)" launch --file x.json', 'A=init; aidrian project $A launch --file x.json', 'aidrian project `echo start` launch ENG-1']) {
    for (const who of [attended, unattended]) {
      const denial = projectCommandDenial(bash(command, { session_id: DRIVER, cwd: fx.dir }), fx.config, { unattended: who, home: fx.home });
      assert.match(denial?.reason ?? '', /a subcommand word after `project` built from a variable or a substitution/u, command);
    }
  }
  const words = projectCommandDenial(bash('aidrian project start $RUN ENG-1', { session_id: DRIVER, cwd: fx.dir }), fx.config, { unattended: attended, home: fx.home });
  assert.match(words.reason, /names its run, issue, file, or project folder with a word built from a variable/u);
});

test('a command word built from a variable, a runner, and a shell the hooks cannot read are refused to a subagent and an unattended session', (t) => {
  const fx = runFixture(t);
  const forms = [
    ['$AIDRIAN project start launch ENG-1', /a command word built from a variable/u],
    ['echo launch ENG-1 | xargs aidrian project start', /`xargs`, which runs its arguments/u],
    ['npx aidrian project start launch ENG-1', /`npx`/u],
    ['find . -maxdepth 0 -exec aidrian project start launch ENG-1 \\;', /`find`/u],
    ['bash run.sh project start launch ENG-1', /a shell fed text the hooks cannot read|`bash`/u],
    ['echo "aidrian project start launch ENG-1" | bash', /a shell fed text the hooks cannot read/u],
  ];
  for (const [command, why] of forms) {
    const input = bash(command, { session_id: DRIVER, cwd: fx.dir });
    assert.match(projectCommandDenial(input, fx.config, { unattended, home: fx.home })?.reason ?? '', why, command);
    assert.match(projectCommandDenial({ ...input, agent_id: 'agent-7' }, fx.config, { home: fx.home })?.reason ?? '', why, `${command} (subagent)`);
    assert.equal(projectCommandDenial(input, fx.config, { unattended: attended, home: fx.home }), null, `${command} (attended)`);
  }
  const opaque = { tool_name: 'PowerShell', tool_input: { command: '& aidrian project start launch ENG-1' }, session_id: DRIVER, cwd: fx.dir };
  assert.match(projectCommandDenial(opaque, fx.config, { unattended, home: fx.home }).reason, /a command in a shell the hooks cannot read that names `project` and a subcommand/u);
  assert.equal(projectCommandDenial({ ...opaque, tool_input: { command: 'Get-ChildItem project' } }, fx.config, { unattended, home: fx.home }), null);
  assert.deepEqual(projectCalls(bash('find . -name project -print')), { calls: [], hidden: null }, 'project with no subcommand word');
});

test('no command sets, exports, or unsets a variable for any aidrian project subcommand, such as the session id', (t) => {
  const fx = runFixture(t);
  for (const command of [
    'CLAUDE_CODE_SESSION_ID=abcd1234-0000-4000-8000-00000000d001 aidrian project start launch ENG-1',
    'env CLAUDE_CODE_SESSION_ID=x aidrian project result launch ENG-1 --file r.json',
    'export XDG_STATE_HOME=/tmp/x; aidrian project next launch',
    'FOO=1 aidrian project wait launch',
    'unset HOME; aidrian project handoff launch b.md',
  ]) {
    const input = bash(command, { session_id: OTHER, cwd: fx.dir });
    assert.match(handoffEnvDenial(input, DEFAULTS, { unattended })?.reason ?? '', /runs `aidrian handoff` or `aidrian project` with \S+ set or unset by the command itself/u, command);
    assert.ok(handoffEnvDenial({ ...input, agent_id: 'agent-7' }, DEFAULTS), `${command} (subagent)`);
    assert.equal(handoffEnvDenial(input, DEFAULTS, { unattended: attended }), null, `${command} (attended)`);
  }
  const opaque = { tool_name: 'PowerShell', tool_input: { command: '$env:CLAUDE_CODE_SESSION_ID="x"; aidrian project start launch ENG-1' }, session_id: OTHER };
  assert.ok(handoffEnvDenial(opaque, DEFAULTS, { unattended }));
});

test('a subagent and an unattended session never write in the folder of the project runs', (t) => {
  const fx = runFixture(t);
  assert.equal(runsFolder(fx.state), path.join(fx.state, RUNS_FOLDER));
  const ledger = path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl');
  const ask = (input, who) => projectRunWriteDenial({ session_id: OTHER, cwd: fx.dir, ...input }, fx.project, fx.config, () => fx.state, { unattended: who });
  const writes = [
    { tool_name: 'Write', tool_input: { file_path: ledger, content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: path.join(runsFolder(fx.state), 'launch', 'snapshot.json'), old_string: 'a', new_string: 'b' } },
    bash(`echo '{"event":"driver"}' >> ${ledger}`),
    bash(`rm -rf ${runsFolder(fx.state)}`),
    bash(`cp /tmp/x ${path.join(runsFolder(fx.state), 'launch', 'results', 'ENG-1.json')}`),
    bash(`chmod 777 ${fx.state}`),
    bash(`tee ${runsFolder(fx.state)}/*/ledger.jsonl < /dev/null`),
    bash('cd "$STATE" && echo x > runs/launch/ledger.jsonl'),
  ];
  for (const input of writes) {
    const label = input.tool_input.command ?? input.tool_input.file_path;
    assert.match(ask(input, unattended)?.reason ?? '', /the folder of the project runs, whose ledger names the session that drives each run/u, label);
    assert.ok(ask({ ...input, agent_id: 'agent-7' }, attended), `${label} (subagent)`);
    assert.equal(ask(input, attended), null, `${label} (attended)`);
  }
  assert.equal(ask(bash(`cat ${ledger}`), unattended), null, 'a read');
  assert.equal(ask(bash(`echo x > ${path.join(fx.root, 'elsewhere.txt')}`), unattended), null);
  assert.equal(ask({ tool_name: 'Write', tool_input: { file_path: path.join(fx.dir, 'notes.md'), content: 'x' } }, unattended), null);
});

test('every subcommand the command takes has a hook rule, and one with no rule is refused', (t) => {
  for (const action of ACTIONS) assert.ok(SUBCOMMAND_RULES.includes(action), `no hook rule for aidrian project ${action}`);
  // Every subcommand word the hooks know has its rule now; a later one with none is refused with "no rule yet".
  for (const sub of SUBCOMMANDS) assert.ok(SUBCOMMAND_RULES.includes(sub), `no hook rule for aidrian project ${sub}`);
  const fx = runFixture(t);
  // A word the command does not take at all is refused too, and an option word is not a subcommand.
  const unknown = projectCommandDenial(bash('aidrian project frobnicate launch ENG-1', { session_id: DRIVER, cwd: fx.dir }), fx.config, { unattended: attended, home: fx.home });
  assert.match(unknown?.reason ?? '', /the hooks hold no rule for `aidrian project frobnicate`, a word the command does not take/u);
  assert.equal(projectCommandDenial(bash('aidrian project --help', { session_id: DRIVER, cwd: fx.dir }), fx.config, { unattended: attended, home: fx.home }), null);
});

test('report and recorded are the driver\'s; preflight is read-only, and a subagent runs none of them', (t) => {
  const fx = runFixture(t);
  const ask = (command, session, more = {}) => projectCommandDenial(bash(command, { session_id: session, cwd: fx.dir, ...more }), fx.config, { unattended: attended, home: fx.home });
  for (const command of ['aidrian project report launch', 'aidrian project report launch --json', 'aidrian project recorded launch ENG-1']) {
    assert.equal(ask(command, DRIVER), null, command);
    assert.match(ask(command, OTHER)?.reason ?? '', /is the driver's, and this session is not the driver of the run launch/u, command);
    assert.match(ask(command, DRIVER, { agent_id: 'agent-7' })?.reason ?? '', /a subagent runs only `aidrian project next`/u, command);
  }
  assert.equal(ask('aidrian project preflight', OTHER), null, 'any main session reads the checks');
  assert.match(ask('aidrian project preflight', DRIVER, { agent_id: 'agent-7' })?.reason ?? '', /a subagent runs only/u);
});

test('the copies of the run id, issue key, and command word patterns match their sources', () => {
  for (const copy of [RUN_TAG, RUN_PART]) assert.equal(copy.source, RUN_ID.source);
  for (const copy of [ISSUE_TAG, ISSUE_PART]) assert.equal(copy.source, ISSUE_KEY.source);
  assert.ok(PROJECT_SUB.test('stop-action') && PROJECT_WORD.test('Project'));
});

test('an issue session whose clone\'s config moves state.dir still cannot write the run ledger the base branch names', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const worktree = clone(fx);
  const elsewhere = path.join(fx.root, 'elsewhere');
  const committed = JSON.parse(readFileSync(path.join(worktree, '.aidrian/config.json'), 'utf8'));
  writeFileSync(path.join(worktree, '.aidrian/config.json'), JSON.stringify({ ...committed, state: { dir: elsewhere } }));
  const project = findProject(worktree);
  const { config } = loadConfig(project);
  assert.equal(config.state.dir, elsewhere, 'the working copy names another folder');
  const folders = stateFolders(project, config, { home: fx.home });
  assert.ok(folders.includes(fx.state), 'the base branch\'s folder is guarded too');
  const ledger = path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl');
  const store = path.join(fx.state, 'handoffs', '.continue', `started-${DRIVER}.json`);
  const ask = (deny, file) => deny({ tool_name: 'Write', tool_input: { file_path: file, content: '{}' }, session_id: STARTED[0].session, cwd: worktree }, project, config, () => folders, { unattended });
  assert.match(ask(projectRunWriteDenial, ledger)?.reason ?? '', /the folder of the project runs/u);
  assert.match(ask(continueStoreWriteDenial, store)?.reason ?? '', /the handoff continuation store/u);
  // The hook resolves the same folders: through the agent gate script, as the issue's session.
  const hook = runHook(AGENT_HOOK, { session_id: STARTED[0].session, tool_name: 'Write', tool_input: { file_path: ledger, content: '{}' }, cwd: worktree }, fx.env);
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /the folder of the project runs/u);
});

test('a subagent and an unattended session may not move a remote-tracking ref; a read, and an attended session, may', (t) => {
  const fx = runFixture(t);
  const ask = (command, who) => remoteChangeDenial(bash(command, { session_id: OTHER, cwd: fx.dir }), fx.config, { unattended: who });
  for (const command of [
    'git update-ref refs/remotes/origin/HEAD 1234567',
    'git update-ref -d refs/remotes/origin/main',
    'printf "update refs/remotes/origin/main x\\n" | git update-ref --stdin',
    'git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/evil',
    'git symbolic-ref -d refs/remotes/origin/HEAD',
    'git remote set-head origin evil',
    // The spellings git expands to a remote-tracking ref, and a reason that is no ref.
    'git symbolic-ref -m x refs/remotes/origin/HEAD refs/heads/main',
    'git symbolic-ref -qm x refs/remotes/origin/HEAD refs/heads/main',
    'git fetch . +HEAD:remotes/origin/main',
    'git fetch . +HEAD:refs/REMOTES/origin/main',
    'git pull . +HEAD:refs/remotes/origin/main',
    'git fetch . refs/heads/main --refmap=+refs/heads/main:refs/remotes/origin/main',
    'git fetch . refs/heads/main --refmap +refs/heads/main:remotes/origin/main',
    'git push . HEAD:origin/main',
    'git push . HEAD:remotes/origin/main',
    'git remote set-head origin -a evil',
  ]) {
    assert.match(ask(command, unattended)?.reason ?? '', /or a remote-tracking ref/u, command);
    assert.equal(ask(command, attended), null, `${command} (attended)`);
  }
  for (const command of [
    'git symbolic-ref refs/remotes/origin/HEAD', 'git symbolic-ref -q --short refs/remotes/origin/HEAD', 'git update-ref refs/heads/feat/x HEAD', 'git fetch origin',
    'git fetch origin main', 'git pull origin main', 'git pull --rebase origin main', 'git fetch . +HEAD:origin/main', 'git fetch origin main:refs/heads/main',
    'git push origin HEAD:refs/heads/feat/x', 'git push . HEAD:refs/heads/feat/x', 'git fetch --refmap= origin main',
    // origin/HEAD set again from the forge's own default branch, as the issue session's push refusal advises.
    'git remote set-head origin -a', 'git remote set-head origin --auto',
  ]) assert.equal(ask(command, unattended), null, command);
});

test('the hook scripts hold the new guards: a subagent\'s project start, an unattended write into the runs, and an issue session\'s stop', (t) => {
  const fx = runFixture(t);
  const sub = runHook(AGENT_HOOK, { session_id: DRIVER, agent_id: 'a5f0c1', agent_type: 'aidrian:explorer', tool_name: 'Bash', tool_input: { command: 'aidrian project start launch ENG-1' }, cwd: fx.dir }, fx.env);
  assert.equal(sub.status, 2, sub.stderr);
  assert.match(sub.stderr, /a subagent runs only `aidrian project next`/u);
  assert.equal(runHook(AGENT_HOOK, { session_id: DRIVER, tool_name: 'Bash', tool_input: { command: 'aidrian project start launch ENG-1' }, cwd: fx.dir }, fx.env).status, 0, 'the driver');
  assert.equal(runHook(AGENT_HOOK, { session_id: OTHER, tool_name: 'Bash', tool_input: { command: 'aidrian project start launch ENG-1' }, cwd: fx.dir }, fx.env).status, 2, 'another session');

  const ledger = path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl');
  markUnattended(OTHER, { root: fx.dir, env: fx.env });
  const write = runHook(AGENT_HOOK, { session_id: OTHER, tool_name: 'Bash', tool_input: { command: `echo '{}' >> ${ledger}` }, cwd: fx.dir }, fx.env);
  assert.equal(write.status, 2, write.stderr);
  assert.match(write.stderr, /the folder of the project runs/u);

  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const child = STARTED[0].session;
  const stop = (active) => runHook(STOP_HOOK, { session_id: child, stop_hook_active: active, last_assistant_message: 'Done.', cwd: clone(fx) }, fx.env);
  const held = stop(false);
  assert.equal(held.status, 2, held.stderr);
  assert.match(held.stderr, /This session works the issue ENG-1 of the project run launch/u);
  assert.equal(stop(true).status, 0, 'once only');
});

test('when the base branch\'s config cannot be read, a held session\'s write outside every checkout is refused; the main checkout\'s config folder stays guarded', (t) => {
  // A linked worktree of the main checkout, as a session the background handoff route started may run in.
  const fx = runFixture(t);
  const worktree = path.join(fx.worktrees, 'launch-eng-1');
  fx.git('worktree', 'add', '-q', '-b', 'feat/eng-1-export', worktree);
  const committed = JSON.parse(readFileSync(path.join(worktree, '.aidrian/config.json'), 'utf8'));
  writeFileSync(path.join(worktree, '.aidrian/config.json'), JSON.stringify({ ...committed, state: { dir: path.join(fx.root, 'elsewhere') } }));
  // Every ref the base is read through is gone, as a session that deleted them would leave it.
  fx.git('update-ref', '-d', 'refs/remotes/origin/main');
  const project = findProject(worktree);
  const { config } = loadConfig(project);
  const base = baseReader(project);
  assert.equal(base().failed, true);
  const folders = stateFolders(project, config, { home: fx.home, base });
  assert.ok(folders.includes(fx.state), 'the main checkout\'s config still names the real folder');
  const ledger = path.join(runsFolder(fx.state), 'launch', 'ledger.jsonl');
  const write = (file, who) => projectRunWriteDenial({ tool_name: 'Write', tool_input: { file_path: file, content: '{}' }, session_id: STARTED[0].session, cwd: worktree }, project, config, () => folders, { unattended: who, base });
  assert.match(write(ledger, unattended)?.reason ?? '', /the folder of the project runs/u);
  assert.match(write(path.join(fx.root, 'anywhere.txt'), unattended)?.reason ?? '', /it writes outside every checkout of this project, which keeps a project run or a session no Human attends, and the base branch's config\.json.*cannot be read/u, 'any write outside every checkout');
  assert.equal(write(path.join(worktree, 'notes.md'), unattended), null, 'a write inside the checkout');
  assert.equal(write(path.join(fx.root, 'anywhere.txt'), attended), null, 'an attended session');
  const store = continueStoreWriteDenial({ tool_name: 'Write', tool_input: { file_path: path.join(fx.root, 'anywhere.txt'), content: 'x' }, session_id: STARTED[0].session, cwd: worktree }, project, config, () => folders, { unattended, base });
  assert.match(store?.reason ?? '', /it writes outside every checkout of this project/u);
  assert.doesNotMatch(store.reason, /continuation store/u, 'a write that names no store is not said to change it');
});

test('the remote-tracking ref guard covers branch deletions with --remotes and fetch or push refspecs into refs/remotes/', (t) => {
  const fx = runFixture(t);
  const ask = (command, who) => remoteChangeDenial(bash(command, { session_id: OTHER, cwd: fx.dir }), fx.config, { unattended: who });
  for (const command of ['git branch -d -r origin/main', 'git branch -rD origin/main', 'git branch --delete --remotes origin/main', 'git push . :refs/remotes/origin/main', 'git fetch . +HEAD:refs/remotes/origin/main', 'git fetch origin +refs/heads/x:refs/remotes/origin/main']) {
    assert.match(ask(command, unattended)?.reason ?? '', /or a remote-tracking ref/u, command);
    assert.equal(ask(command, attended), null, `${command} (attended)`);
  }
  for (const command of ['git branch -d feat/x', 'git branch -r', 'git fetch origin', 'git push origin HEAD:refs/heads/feat/x']) assert.equal(ask(command, unattended), null, command);
});

test('the agent gate hook reads the base branch\'s config at most once a call, and checks its deadline before the read', (t) => {
  const fx = runFixture(t, { init: false });
  const real = process.env.PATH.split(path.delimiter).map((dir) => path.join(dir, 'git')).find((file) => existsSync(file) && !file.startsWith(fx.root));
  const wrap = path.join(fx.root, 'wrapbin');
  mkdirSync(wrap);
  const log = path.join(fx.root, 'git.log');
  writeFileSync(path.join(wrap, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const env = { ...fx.env, PATH: `${wrap}${path.delimiter}${fx.env.PATH}` };
  markUnattended(OTHER, { root: fx.dir, env });
  for (const target of [path.join(fx.root, 'elsewhere.txt'), path.join(runsFolder(fx.state), 'r', 'ledger.jsonl')]) {
    writeFileSync(log, '');
    runHook(AGENT_HOOK, { session_id: OTHER, tool_name: 'Bash', tool_input: { command: `echo x > ${target}` }, cwd: fx.dir }, env);
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const configReads = calls.filter((line) => /^show [0-9a-f]+:\.\/\.aidrian\/config\.json$/u.test(line));
    const tipReads = calls.filter((line) => line === 'rev-parse --verify --quiet refs/remotes/origin/HEAD^{commit}');
    assert.ok(configReads.length <= 1, `${target}: the base config read ${configReads.length} times\n${calls.join('\n')}`);
    assert.ok(tipReads.length <= 1, `${target}: the base tip looked up ${tipReads.length} times\n${calls.join('\n')}`);
  }
  // A budget already spent: the read never runs, and the deadline's refusal answers instead.
  assert.throws(() => withinDeadline(performance.now() - 1, () => baseReader(fx.project)()), PastDeadline);
});

// A session the background handoff route starts runs in the handing-off session's folder, which may be a linked worktree.
test('a subagent and an unattended session may not write the main checkout\'s host paths a worktree session reads, in either layout', (t) => {
  for (const inRepo of [false, true]) {
    const fx = runFixture(t, { inRepo });
    const worktree = path.join(fx.worktrees, 'launch-eng-1');
    fx.git('worktree', 'add', '-q', '-b', 'feat/eng-1-export', worktree);
    const project = findProject(worktree);
    const ask = (input, who, runSession) => mainCheckoutWriteDenial({ session_id: STARTED[0].session, cwd: worktree, ...input }, project, fx.config, { unattended: who, runSession });
    for (const file of ['.claude/settings.local.json', '.claude/skills/merge-it/SKILL.md', '.claude/agents/merger.md', '.claude/commands/ship.md']) {
      const target = path.join(fx.dir, file);
      for (const input of [{ tool_name: 'Write', tool_input: { file_path: target, content: '{}' } }, bash(`echo x > ${target}`)]) {
        assert.match(ask(input, unattended)?.reason ?? '', /which the host reads from the main checkout in every worktree session/u, `${inRepo}: ${file}`);
        assert.ok(ask({ ...input, agent_id: 'agent-7' }, attended, () => true), `${inRepo}: ${file} (a subagent of the run's driver)`);
        assert.equal(ask({ ...input, agent_id: 'agent-7' }, attended, () => false), null, `${inRepo}: ${file} (a subagent of a session that drives no run)`);
        assert.equal(ask(input, attended), null, `${inRepo}: ${file} (attended)`);
      }
    }
    assert.ok(ask(bash(`rm -rf ${path.join(fx.dir, '.claude')}`), unattended), 'a folder that holds them');
    assert.equal(ask({ tool_name: 'Write', tool_input: { file_path: path.join(worktree, '.claude/skills/x/SKILL.md'), content: 'x' } }, unattended), null, 'the worktree\'s own');
    assert.equal(ask({ tool_name: 'Write', tool_input: { file_path: path.join(fx.dir, 'README.md'), content: 'x' } }, unattended), null);
  }
  const fx = runFixture(t);
  markUnattended(OTHER, { root: fx.dir, env: fx.env });
  const hook = runHook(AGENT_HOOK, { session_id: OTHER, tool_name: 'Write', tool_input: { file_path: path.join(fx.dir, '.claude/settings.local.json'), content: '{"disableAllHooks":true}' }, cwd: fx.dir }, fx.env);
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /which the host reads from the main checkout in every worktree session/u);
});

test('each host declares the main-checkout paths its worktree sessions read, and the instruction files above them', () => {
  assert.deepEqual(claudeCode.mainCheckoutPaths.folders, ['.claude/skills', '.claude/agents', '.claude/commands']);
  assert.deepEqual(claudeCode.mainCheckoutPaths.settings.map((each) => each.file), ['.claude/settings.local.json']);
  assert.deepEqual(codex.mainCheckoutPaths, { folders: [], settings: [] });
  const { folders, settings } = mainCheckoutPaths();
  assert.deepEqual([folders, settings.map((each) => each.file)], [claudeCode.mainCheckoutPaths.folders, ['.claude/settings.local.json']]);
  assert.deepEqual(claudeCode.instructionFiles.files, ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']);
  assert.deepEqual(codex.instructionFiles.files, ['AGENTS.md', 'AGENTS.override.md']);
});
