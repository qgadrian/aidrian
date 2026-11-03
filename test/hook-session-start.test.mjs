import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { snapshotPath } from '../plugins/aidrian/lib/gate-snapshot.mjs';
import { GIT_TIMEOUT_MS } from '../plugins/aidrian/lib/git.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'plugins/aidrian/bin');
const HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs');
// An empty state folder, so a developer's own lesson inbox never reaches these tests.
const XDG = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
test.after(() => rmSync(XDG, { recursive: true, force: true }));
// The example project, copied outside any repository: in this repository it sits in whatever checkout runs the suite,
// and in a main checkout, as CI's is, its guard adds the main-checkout lines. Those have their own tests below.
const EXAMPLE = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-start-example-')), 'consumer');
cpSync(path.join(ROOT, 'examples/consumer'), EXAMPLE, { recursive: true });
test.after(() => rmSync(path.dirname(EXAMPLE), { recursive: true, force: true }));

const WITHOUT_BIN = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== BIN).join(path.delimiter);
const LINE = (command) =>
  'Project knowledge: 2 buckets, 8 docs. Read now: docs/knowledge/engineering/working-agreement.md. ' +
  `For more, run \`${command} route <tag>\` for your tags or \`${command} search <words>\` for a topic.`;
const NAMES = (ai, human = 'the Human') => `Names: call the human "${human}" and yourself "${ai}", in replies and questions alike; never "I", "me", "you", or "your".`;
const VOICE = (human = 'the Human') =>
  `Voice: when a request or premise looks wrong, or worse than an alternative, say so in one line with the reason before acting, then follow the call of "${human}". ` +
  `A question to "${human}" says what goes wrong in their terms, asks one decision, puts the recommended option first with one reason, and uses no internal IDs or labels.`;
const FORMAT = 'Format: in chat replies, use headers, quotes, and a few emoji to aid scanning; never in commits, pull requests, docs, or code.';
// What every main session starts with, after the knowledge line.
const MAIN = (ai) => `${NAMES(ai)}\n${VOICE()}\n${FORMAT}\n`;

// Without CLAUDECODE=1, which Claude Code sets for its hooks, the host is Codex. `CLAUDECODE: '1'` makes it Claude Code.
// AIDRIAN_ALLOW_MAIN_COMMIT is unset unless a test passes it, whatever the shell running the tests holds.
function hook({ input = '{}', args = [], cwd = ROOT, PATH = WITHOUT_BIN, XDG_STATE_HOME = XDG, CLAUDECODE, AIDRIAN_ALLOW_MAIN_COMMIT } = {}) {
  const env = { ...process.env, PATH, XDG_STATE_HOME, CLAUDECODE, AIDRIAN_ALLOW_MAIN_COMMIT };
  if (CLAUDECODE === undefined) delete env.CLAUDECODE;
  if (AIDRIAN_ALLOW_MAIN_COMMIT === undefined) delete env.AIDRIAN_ALLOW_MAIN_COMMIT;
  return spawnSync(process.execPath, [HOOK, ...args], { input, cwd, encoding: 'utf8', env });
}

test('at session start, one plain line names the always docs and the commands, by full path when bin/ is not on PATH', () => {
  const { status, stdout, stderr } = hook({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: EXAMPLE }) });
  assert.deepEqual([status, stdout, stderr], [0, `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${MAIN('Codex')}`, '']);
});

test('the bare command name is used when bin/ is on PATH, and the project is found from the process folder without a cwd', () => {
  const { status, stdout } = hook({ input: 'not json', cwd: path.join(EXAMPLE, 'src'), PATH: `${BIN}${path.delimiter}${WITHOUT_BIN}` });
  assert.equal(status, 0);
  assert.equal(stdout, `${LINE('aidrian-knowledge')}\n${MAIN('Codex')}`);
});

test('at subagent start, the same lines but the format line come as SubagentStart additional context', () => {
  const { status, stdout } = hook({ args: ['--subagent'], input: JSON.stringify({ cwd: EXAMPLE, agent_type: 'Explore' }), CLAUDECODE: '1' });
  assert.equal(status, 0);
  assert.deepEqual(JSON.parse(stdout), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: `${LINE(path.join(BIN, 'aidrian-knowledge'))}\n${NAMES('Claude')}\n${VOICE()}` },
  });
});

test('the names line calls the AI by its host unless config.json or .aidrian.local.json names it, the local file winning', (t) => {
  const input = JSON.stringify({ cwd: EXAMPLE });
  assert.equal(hook({ input, CLAUDECODE: '1' }).stdout.split('\n')[1], NAMES('Claude'));
  assert.equal(hook({ input }).stdout.split('\n')[1], NAMES('Codex'));

  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, names: { human: 'the team lead', ai: 'the agent' } }));
  writeFileSync(path.join(project, '.aidrian.local.json'), JSON.stringify({ names: { human: 'the "product" owner' } }));
  const lines = hook({ input: JSON.stringify({ cwd: project }), CLAUDECODE: '1' }).stdout.split('\n');
  assert.equal(lines[1], 'Names: call the human "the \\"product\\" owner" and yourself "the agent", in replies and questions alike; never "I", "me", "you", or "your".');
  assert.equal(lines[2], VOICE('the \\"product\\" owner'));
});

test('outside a project, and for any stdin, the hook prints nothing and exits 0', (t) => {
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const input of ['', 'not json', '[]', JSON.stringify({ cwd: outside }), JSON.stringify({ cwd: 42 })]) {
    for (const args of [[], ['--subagent']]) {
      const { status, stdout, stderr } = hook({ input, args, cwd: outside });
      assert.deepEqual([status, stdout, stderr], [0, '', ''], `${input} ${args}`);
    }
  }
});

test('a project with a broken folder still gets the line, plus how many problems it has and the check to run', (t) => {
  const project = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  mkdirSync(path.join(project, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, extra: 1 }));
  writeFileSync(path.join(project, '.aidrian/knowledge/kb.json'), JSON.stringify({ dir: 'missing' }));
  const { status, stdout } = hook({ input: JSON.stringify({ cwd: project }) });
  assert.equal(status, 0);
  assert.match(stdout, /^Project knowledge: 0 buckets, 0 docs\. For more, run .* for a topic\. The project folder has 2 problems; run `\S+\/aidrian check`\.\n/);
  assert.equal(stdout.split('\n').slice(1).join('\n'), MAIN('Codex'));
});

test('the main session also hears about open lessons, escalated with the command to list them once a P1 is open; a subagent does not', (t) => {
  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  const add = (note) => spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: EXAMPLE, input: note, encoding: 'utf8', env });
  assert.equal(add('the first lesson').status, 0);
  assert.equal(add('the second lesson').status, 0);

  const input = JSON.stringify({ cwd: EXAMPLE });
  const [knowledge, names, voice, format, lessons, rest] = hook({ input, XDG_STATE_HOME: xdg }).stdout.split('\n');
  assert.equal(knowledge, LINE(path.join(BIN, 'aidrian-knowledge')));
  assert.equal(names, NAMES('Codex'));
  assert.equal(voice, VOICE());
  assert.equal(format, FORMAT);
  assert.equal(lessons, 'Lesson inbox: 2 open (P2 2), the oldest from today. The lesson-triage skill drains it in a session opened for it.');
  assert.equal(rest, '');
  assert.doesNotMatch(hook({ input, args: ['--subagent'], XDG_STATE_HOME: xdg }).stdout, /Lesson inbox/);

  const urgent = spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add', '--tier', 'P1'], { cwd: EXAMPLE, input: 'lost a commit', encoding: 'utf8', env });
  assert.equal(urgent.status, 0);
  const escalated = hook({ input, XDG_STATE_HOME: xdg }).stdout.split('\n')[4];
  assert.match(escalated, /^Lesson inbox needs triage: 1 P1 open\. Tell the Human once, then go on with the task: .* `\S+\/bin\/aidrian lesson list` shows the order\.$/);
});

test('the gate snapshot is saved before the knowledge loads, so a knowledge folder that throws still leaves the gates held', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-start-'));
  const knowledge = path.join(dir, '.aidrian/knowledge');
  t.after(() => {
    chmodSync(knowledge, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(knowledge, { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, agents: { explorer: { deny: ['WebFetch'] } } }));
  chmodSync(knowledge, 0o000);
  const session = 'start-snapshot-1';
  hook({ input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: dir, session_id: session }) });
  assert.ok(existsSync(snapshotPath(session, { env: { XDG_STATE_HOME: XDG } })));
});

// The main-checkout warnings, against a temporary repository with a bare origin, each made with `git init` under
// mkdtemp and driven with `git -C`; no test sets GIT_DIR or GIT_WORK_TREE.
const AHEAD = 'Local main has 1 commit not on origin/main; only worktrees commit here. Inspect: git log origin/main..main';
const OFF = 'The main checkout is on side, not main; only worktrees change branch. Switch back: git switch main';
const DETACHED = "The main checkout's HEAD is detached, not on main. Switch back: git switch main";
const CHANGED = 'The main checkout has changed tracked files; task work belongs in a worktree. Inspect: git status';
const REAL_GIT = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();

function gitRepo(t, config = { version: 1, git: { mainCheckout: { guard: true } } }) {
  const temp = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-start-git-')));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const dir = temp();
  const origin = temp();
  const git = (...args) => {
    const result = spawnSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  };
  assert.equal(spawnSync('git', ['-C', origin, 'init', '-q', '--bare', '-b', 'main']).status, 0);
  git('init', '-q', '-b', 'main');
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, 'README.md'), '# test\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  return { dir, git };
}

// A git that hangs for any call whose arguments hold `word`, and runs the real git otherwise; `word` '' hangs on all.
function hangingGit(t, word) {
  const bin = mkdtempSync(path.join(tmpdir(), 'aidrian-start-bin-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const match = word ? `*" ${word} "*` : '*';
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${match}) exec sleep 30;; esac\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return `${bin}${path.delimiter}${WITHOUT_BIN}`;
}

const after = (stdout) => stdout.split('\n').slice(4, -1);

test('the main session hears about unpushed commits on main, after the lessons line; even with origin, nothing', (t) => {
  const { dir, git } = gitRepo(t);
  const input = JSON.stringify({ cwd: dir });
  assert.deepEqual(after(hook({ input }).stdout), [], 'even with origin/main');
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  assert.deepEqual(after(hook({ input }).stdout), [AHEAD]);

  const xdg = mkdtempSync(path.join(tmpdir(), 'aidrian-start-state-'));
  t.after(() => rmSync(xdg, { recursive: true, force: true }));
  const env = { ...process.env, XDG_STATE_HOME: xdg, PATH: WITHOUT_BIN };
  assert.equal(spawnSync(path.join(BIN, 'aidrian'), ['lesson', 'add'], { cwd: dir, input: 'a lesson', encoding: 'utf8', env }).status, 0);
  const [lessons, ahead] = after(hook({ input, XDG_STATE_HOME: xdg }).stdout);
  assert.match(lessons, /^Lesson inbox: 1 open/);
  assert.equal(ahead, AHEAD);
});

test('the main checkout off main, detached, or with changed tracked files gets its line; untracked files alone do not', (t) => {
  const { dir, git } = gitRepo(t);
  const input = JSON.stringify({ cwd: dir });
  writeFileSync(path.join(dir, 'notes.md'), 'scratch\n');
  assert.deepEqual(after(hook({ input }).stdout), [], 'clean on main, with an untracked file');
  git('switch', '-q', '-c', 'side');
  assert.deepEqual(after(hook({ input }).stdout), [OFF]);
  git('switch', '-q', '--detach', 'main');
  assert.deepEqual(after(hook({ input }).stdout), [DETACHED]);
  git('switch', '-q', 'main');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  assert.deepEqual(after(hook({ input }).stdout), [CHANGED]);
});

test('no main-checkout line in a subagent, with the guard off, or without an origin/main ref', (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  const input = JSON.stringify({ cwd: dir });
  const { additionalContext } = JSON.parse(hook({ input, args: ['--subagent'] }).stdout).hookSpecificOutput;
  assert.equal(additionalContext.split('\n').length, 3);
  assert.doesNotMatch(additionalContext, /main checkout|Local main/);

  const off = gitRepo(t, { version: 1, git: { mainCheckout: { guard: false } } });
  off.git('commit', '-q', '--allow-empty', '-m', 'stray');
  off.git('switch', '-q', '-c', 'side');
  assert.deepEqual(after(hook({ input: JSON.stringify({ cwd: off.dir }) }).stdout), []);

  git('remote', 'remove', 'origin');
  assert.deepEqual(after(hook({ input }).stdout), [OFF], 'no origin/main drops only the unpushed line');
});

const INHERITED =
  'AIDRIAN_ALLOW_MAIN_COMMIT is set in this session, so the commit guard lets every commit through. ' +
  'Tell the Human: restart the session without it, and use it per command in their own terminal.';

test('a main session that inherits AIDRIAN_ALLOW_MAIN_COMMIT=1 hears so while the guard is on, before the main-checkout lines', (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  const input = JSON.stringify({ cwd: dir });
  assert.deepEqual(after(hook({ input, AIDRIAN_ALLOW_MAIN_COMMIT: '1' }).stdout), [INHERITED, AHEAD]);
  assert.deepEqual(after(hook({ input }).stdout), [AHEAD], 'unset: no line');
  assert.deepEqual(after(hook({ input, AIDRIAN_ALLOW_MAIN_COMMIT: '0' }).stdout), [AHEAD], 'only 1 lets commits through');
  const { additionalContext } = JSON.parse(hook({ input, args: ['--subagent'], AIDRIAN_ALLOW_MAIN_COMMIT: '1' }).stdout).hookSpecificOutput;
  assert.doesNotMatch(additionalContext, /AIDRIAN_ALLOW_MAIN_COMMIT/, 'the main session only');

  const off = gitRepo(t, { version: 1, git: { mainCheckout: { guard: false } } });
  assert.deepEqual(after(hook({ input: JSON.stringify({ cwd: off.dir }), AIDRIAN_ALLOW_MAIN_COMMIT: '1' }).stdout), [], 'guard off: nothing to let through');
});

test('a git that hangs costs the main-checkout lines it stops and nothing else: the hook exits 0 inside its time', (t) => {
  const { dir, git } = gitRepo(t);
  git('commit', '-q', '--allow-empty', '-m', 'stray');
  git('switch', '-q', '-c', 'side');
  writeFileSync(path.join(dir, 'README.md'), '# changed\n');
  const input = JSON.stringify({ cwd: dir });
  for (const [word, lines] of [['status', [AHEAD, OFF]], ['rev-list', []], ['', []]]) {
    const started = Date.now();
    const { status, stdout, stderr } = hook({ input, PATH: hangingGit(t, word) });
    assert.deepEqual([status, stderr], [0, ''], word);
    assert.match(stdout, /^Project knowledge: /, word);
    assert.deepEqual(after(stdout), lines, word || 'every git call');
    assert.ok(Date.now() - started < GIT_TIMEOUT_MS + 1500, `${word}: ${Date.now() - started} ms`);
  }
});
