// The background route of `aidrian handoff continue` (docs/handoff.md#the-background-route): the gate starts the new
// session itself through the host adapter, records its chain floor, and falls back to none when it cannot start one.
// No test starts a real session: the gate's `run` is a stand-in, and the command-line test puts a fake `claude` first on
// PATH. Temporary repositories are made with `git init` under mkdtemp and driven with `git -C`; no test sets GIT_DIR.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkBrief, chainOf } from '../plugins/aidrian/lib/handoff-brief.mjs';
import { backgroundPrompt, continueBrief } from '../plugins/aidrian/lib/handoff-continue.mjs';
import { openStore, readArmed, readFrom } from '../plugins/aidrian/lib/handoff-markers.mjs';
import { worktreeOf } from '../plugins/aidrian/lib/handoff-sections.mjs';
import { startBackground } from '../plugins/aidrian/lib/hosts/claude-code-background.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const ADVICE = 'Advice from Claude, not a spec: check each claim against the docs and code before building on it.';
const brief = (chain = 0, worktree = 'none yet') => `# Handoff: continue the widget\nWritten: 2026-11-15 | Chain: ${chain} | Supersedes: none\n${ADVICE}\n\n` +
  `## Objective\n- Ship the widget.\n\n## Current state\n- Worktree: ${worktree}\n- Branch: feat/widget\n\n## Still running\nNone.\n\n` +
  '## Next steps\n1. Ship it.\n\n## Open risks and questions\nNone.\n';
const SESSION = 'session-1';
const NEW_SESSION = 'abcd1234-0000-4000-8000-000000000001';
const CLAUDE = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: SESSION };

// A project whose config asks for `handoff`, its state folder outside it, and a fresh brief in its handoffs folder.
function setup(t, handoff = { continue: 'background' }, text = brief()) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-background-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const state = path.join(root, 'state');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state }, session: { handoff } }));
  const handoffs = path.join(state, 'handoffs');
  mkdirSync(handoffs, { recursive: true });
  const file = path.join(handoffs, '2026-11-15-widget.md');
  writeFileSync(file, text);
  const store = openStore(state, { checkouts: [dir], maxChain: 3 });
  return { root, dir, state, file, store };
}

const passCheck = (setting) => assert.equal(checkBrief(setting.file, undefined, 0, { store: setting.store }).exitCode, 0);

// A stand-in for spawnSync that answers like Claude Code 2.1.326 and records each call.
function fakeRun({ name = 'harness-handoff', start = null, list = true } = {}) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    if (start) return start(args);
    if (args[0] === 'agents') {
      const listed = [{ sessionId: SESSION, name, kind: 'interactive' }];
      if (list && calls.some((call) => call.args[0] === '--bg')) listed.push({ id: 'abcd1234', sessionId: NEW_SESSION, name, kind: 'background' });
      return { status: 0, stdout: JSON.stringify(listed), stderr: '' };
    }
    const given = args[args.indexOf('--name') + 1];
    return { status: 0, stdout: `backgrounded · abcd1234 · ${given}\n  claude agents             list sessions\n`, stderr: '' };
  };
  return { run, calls };
}

const gate = (setting, args = {}) => continueBrief(setting.file, { chainOf, cwd: setting.dir, env: { ...process.env, ...CLAUDE }, ...args });

test('the background route starts the new session, records its chain floor, and says where the work goes on', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const { run, calls } = fakeRun();
  const result = gate(setting, { run, env: { ...process.env, ...CLAUDE, CLAUDE_CODE_AGENT: 'aidrian:orchestrator', CLAUDE_EFFORT: 'high' } });
  assert.equal(result.exitCode, 0, result.err.join('\n'));
  assert.equal(result.out[0], 'continue: background');
  assert.match(result.out[1], /^say: The brief widget continues in the new background session harness-handoff \(abcd1234\), started in \S+, with nothing to type: `claude attach harness-handoff` opens it, or `claude attach abcd1234` by its id, and `claude agents` lists it\. It resumes from \S+2026-11-15-widget\.md; this session stops here\.$/u);

  const started = calls.find((call) => call.args[0] === '--bg');
  const prompt = backgroundPrompt({ marker: { brief: setting.file, slug: 'widget', chain: 0 }, maxChain: 3 });
  assert.deepEqual(started.args, ['--bg', '--name', 'harness-handoff', '--agent', 'aidrian:orchestrator', '--effort', 'high', prompt], 'the session\'s own name, agent, and effort');
  assert.equal(started.cwd, setting.dir, 'a brief with no worktree starts where the project is');
  assert.match(prompt, /^Handoff continuation: this session continues the work of the handoff brief \S+2026-11-15-widget\.md, for widget, started in the background by the session that wrote it, as continuation 1 of 3\.\nNow follow the session-continue skill's steps on this brief: /u);
  assert.match(prompt, /A later brief for this work carries Chain: 1\.$/u);
  assert.doesNotMatch(prompt, /Ship the widget/u, 'nothing of the brief\'s text');

  const floor = readFrom(setting.store, NEW_SESSION);
  assert.deepEqual({ ...floor, at: 0 }, { slug: 'widget', chain: 1, brief: setting.file, route: 'background', at: 0 }, 'the floor of the new session, as a clear delivery writes it');
  assert.equal(readArmed(setting.store, SESSION), null, 'nothing is armed: nothing waits for a clear');
});

test('mode auto with no continue hands off on the background route; an explicit continue wins, and ask with none stays none', (t) => {
  const outcome = (handoff) => {
    const setting = setup(t, handoff);
    passCheck(setting);
    return gate(setting, { run: fakeRun().run }).out[0];
  };
  assert.equal(outcome({ mode: 'auto' }), 'continue: background');
  assert.equal(outcome({ mode: 'auto', continue: 'clear' }), 'continue: clear');
  assert.equal(outcome({ mode: 'auto', continue: 'none' }), 'continue: none');
  assert.equal(outcome({ mode: 'ask' }), 'continue: none');
  // The derived route is the configured one, so --route background is not refused as an opt-in it lacks.
  const setting = setup(t, { mode: 'auto' });
  passCheck(setting);
  assert.equal(gate(setting, { run: fakeRun().run, override: 'background' }).out[0], 'continue: background');
});

test('the background route passes on no agent or effort it cannot read, and takes the slug for a session with no name', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const { run, calls } = fakeRun({ name: '-x' });
  const result = gate(setting, { run, env: { ...process.env, ...CLAUDE, CLAUDE_CODE_AGENT: '--dangerously-skip-permissions', CLAUDE_EFFORT: 'huge' } });
  assert.equal(result.out[0], 'continue: background');
  assert.deepEqual(calls.find((call) => call.args[0] === '--bg').args.slice(0, 3), ['--bg', '--name', 'widget']);
  assert.equal(calls.find((call) => call.args[0] === '--bg').args.length, 4, 'no --agent and no --effort');
});

test('the background route falls back to none, with the reason, when the session does not start, and records no floor', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const cases = [
    [{ error: Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }), status: null }, /^fallback: no background session started, since `claude` is not on PATH; a person resumes the brief$/u],
    [{ status: 1, stdout: '', stderr: 'Workspace not trusted. Run `claude` in /x\u001b[31m once.\nmore' }, /^fallback: no background session started, since `claude --bg` exited 1: Workspace not trusted\. Run `claude` in \/x \[31m once\.; a person/u],
    [{ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }), status: null }, /`claude --bg` did not finish \(ETIMEDOUT\)/u],
  ];
  for (const [answer, pattern] of cases) {
    const { run } = fakeRun({ start: (args) => (args[0] === '--bg' ? answer : { status: 0, stdout: '[]', stderr: '' }) });
    const result = gate(setting, { run });
    assert.deepEqual([result.exitCode, result.out[0], result.out.length], [0, 'continue: none', 2]);
    assert.match(result.out[1], pattern);
  }
  assert.deepEqual(readdirSync(setting.store.dir).filter((name) => name.startsWith('from-')), [], 'no floor');
  const thrown = gate(setting, { run: () => { throw new Error('boom'); } });
  assert.match(thrown.out[1], /^fallback: no background session started, since the host's start failed \(boom\)/u);
});

test('a started session the listing does not name yet still continues, with the prompt carrying the count and no floor', (t) => {
  const setting = setup(t);
  passCheck(setting);
  const { run } = fakeRun({ list: false });
  assert.equal(gate(setting, { run }).out[0], 'continue: background');
  assert.equal(readFrom(setting.store, NEW_SESSION), null);
});

test('the background route keeps the gate: no check, maxChain, a route the config did not opt into, and another host', (t) => {
  const setting = setup(t);
  const { run, calls } = fakeRun();
  const unchecked = gate(setting, { run });
  assert.equal(unchecked.exitCode, 1);
  assert.match(unchecked.err[0], /no passing check of its current text/u);
  writeFileSync(setting.file, brief(3));
  passCheck(setting);
  assert.match(gate(setting, { run }).out[1], /^fallback: this brief has Chain 3, and session\.handoff\.maxChain allows 3/u);
  const optIn = setup(t, { continue: 'clear' });
  passCheck(optIn);
  assert.match(gate(optIn, { run, override: 'background' }).out[1], /^fallback: --route background runs only when session\.handoff\.continue is "background"/u);
  assert.equal(gate(optIn, { run }).out[0], 'continue: clear', 'the clear route still arms');
  const codex = gate(setting, { run, env: { ...process.env, CODEX_THREAD_ID: 'thread-1' } });
  assert.match(codex.out[1], /^fallback: the background route does not run on this host \(Codex\)/u);
  assert.deepEqual(calls.filter((call) => call.args[0] === '--bg'), [], 'no session started for any of them');
});

test('the new session starts in the brief\'s worktree when git lists it, and in the project otherwise', (t) => {
  const setting = setup(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', '-C', setting.dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(setting.root, 'widget-tree');
  git('worktree', 'add', '-q', '-b', 'feat/widget', worktree);
  const startedIn = (text) => {
    writeFileSync(setting.file, text);
    passCheck(setting);
    const { run, calls } = fakeRun();
    assert.equal(gate(setting, { run }).out[0], 'continue: background');
    return calls.find((call) => call.args[0] === '--bg').cwd;
  };
  assert.equal(startedIn(brief(0, worktree)), worktree);
  assert.equal(startedIn(brief(0, `\`${worktree}\``)), worktree, 'a value in backticks');
  const stray = path.join(setting.root, 'stray');
  mkdirSync(stray);
  assert.equal(startedIn(brief(0, stray)), setting.dir, 'a folder git does not list as a worktree');
  assert.equal(startedIn(brief(0, path.join(setting.root, 'gone'))), setting.dir, 'a folder that is not there');
  assert.equal(worktreeOf(brief(0, worktree)), worktree);
  assert.equal(worktreeOf('## Objective\n- Worktree: /elsewhere\n'), null, 'only the Current state section names it');
});

test('startBackground reads the id from the output and the session from the listing, and answers without either', () => {
  const answers = { agents: { status: 0, stdout: 'not json', stderr: '' }, bg: { status: 0, stdout: 'Starting background service…\n', stderr: '' } };
  const run = (command, args) => (args[0] === 'agents' ? answers.agents : answers.bg);
  const started = startBackground({ cwd: '/x', session: SESSION, slug: 'widget', efforts: [], prompt: 'p', run });
  assert.deepEqual(started, { id: null, session: null, name: 'widget', look: '`claude attach widget` opens it, and `claude agents` lists it' });
  answers.agents = { status: 0, stdout: JSON.stringify([{ sessionId: SESSION, name: 'my work' }]), stderr: '' };
  assert.match(startBackground({ cwd: '/x', session: SESSION, slug: 'widget', efforts: [], prompt: 'p', run }).look, /^`claude attach "my work"` opens it/u, 'a name with a space is quoted');
});

test('aidrian handoff continue starts the background session from the command line, through the claude on PATH', (t) => {
  const setting = setup(t);
  const bin = path.join(setting.root, 'bin');
  mkdirSync(bin);
  const log = path.join(setting.root, 'claude.log');
  // A fake claude: it logs each call and answers `--bg` and `agents --json` as Claude Code 2.1.326 does.
  writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cwd: process.cwd(), args }) + '\\n');
if (args[0] === 'agents') console.log(JSON.stringify([{ id: 'abcd1234', sessionId: ${JSON.stringify(NEW_SESSION)}, name: 'widget', kind: 'background' }]));
else console.log('backgrounded · abcd1234 · ' + args[args.indexOf('--name') + 1]);
`, { mode: 0o755 });
  const env = { ...process.env, ...CLAUDE, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const run = (...args) => spawnSync(CLI, ['handoff', ...args], { cwd: setting.dir, encoding: 'utf8', env });
  assert.equal(run('check', setting.file).status, 0);
  const result = run('continue', setting.file);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').slice(0, 1), ['continue: background']);
  assert.match(result.stdout, /^say: The brief widget continues in the new background session widget \(abcd1234\)/mu);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.args[0]), ['agents', '--bg', 'agents']);
  assert.equal(readFrom(setting.store, NEW_SESSION).chain, 1);

  // No claude on PATH: node alone in a folder of its own, then the system folders, which hold no claude here.
  const nodeOnly = path.join(setting.root, 'node-only');
  mkdirSync(nodeOnly);
  symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
  const system = ['/usr/bin', '/bin'];
  if (system.some((dir) => existsSync(path.join(dir, 'claude')))) return t.skip('a claude in a system folder');
  const missing = spawnSync(CLI, ['handoff', 'continue', setting.file], { cwd: setting.dir, encoding: 'utf8', env: { ...env, PATH: [nodeOnly, ...system].join(path.delimiter) } });
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /^continue: none\nfallback: no background session started, since `claude` is not on PATH/u);
});
