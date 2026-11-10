import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test, { after } from 'node:test';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');

// Runs the hook with `input` on stdin and no override set.
function bashHook(input, env = {}) {
  return spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, ...env } });
}

const bash = (command, cwd = process.cwd()) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd });
// A folder outside any repository, so a commit there meets no main-checkout guard, whatever checkout runs the suite.
const OUTSIDE = mkdtempSync(path.join(tmpdir(), 'aidrian-bash-'));
after(() => rmSync(OUTSIDE, { recursive: true, force: true }));

test('a command a rule objects to exits 2 with that rule`s reason on stderr', () => {
  const { status, stdout, stderr } = bashHook(bash('git commit --amend'));
  assert.deepEqual([status, stdout], [2, '']);
  assert.match(stderr, /^Blocked: `git commit --amend`/);
});

test('rules run in order and the first objection wins', () => {
  const { status, stderr } = bashHook(bash('git commit --amend --no-verify'));
  assert.equal(status, 2);
  assert.match(stderr, /^Blocked: this skips a git hook\./, 'the hook-bypass rule runs before the amend rule');
  assert.equal(bashHook(bash('git commit --amend --no-verify'), { AIDRIAN_ALLOW_GIT_AMEND: '1' }).status, 2);
});

test('every rule is wired: process kill and listing, and the grep chain', () => {
  assert.match(bashHook(bash('pkill -f eslint')).stderr, /^Blocked: stopping processes by name/);
  assert.match(bashHook(bash('ps aux')).stderr, /^Blocked: this process listing prints full command lines/);
  assert.match(bashHook(bash('grep -c x f && npm test')).stderr, /^Blocked: a counting grep is chained with `&&`/);
  assert.equal(bashHook(bash('pkill -f eslint'), { AIDRIAN_ALLOW_PROCESS_KILL_BY_NAME: '1' }).status, 0);
});

test('the pull request body rule is wired, inside a project folder', () => {
  const inExample = (command) => JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: path.resolve(import.meta.dirname, '../examples/consumer') });
  // A body and a title the public text rule reads, so the result is the same with or without a private words file in
  // the checkout running the suite: that rule runs first, and would refuse a call with neither.
  assert.match(bashHook(inExample(['gh', 'pr', 'create', '--fill', '--title', 'x', '--body', 'y'].join(' '))).stderr, /^Blocked: `--fill` writes the body/);
});

test('an allowed command, another tool, and any unreadable stdin exit 0 silently', () => {
  for (const input of [
    bash('git log -1 --oneline'),
    bash('git commit -m "fix: x"', OUTSIDE),
    JSON.stringify({ tool_name: 'Edit', tool_input: { command: 'git commit --amend' } }),
    JSON.stringify({ tool_name: 'Bash' }),
    JSON.stringify({ tool_name: 'Bash', tool_input: { command: 42 } }),
    '',
    'not json',
    '[]',
  ]) {
    assert.deepEqual(Object.values((({ status, stdout, stderr }) => ({ status, stdout, stderr }))(bashHook(input))), [0, '', ''], input);
  }
});

test('a rule that throws lets only itself through: a later rule still blocks', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-bash-throw-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_') && !name.startsWith('AIDRIAN_'))) };
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, env, stdio: 'ignore' });
  git('init', '-q');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n.worktrees/\n');
  writeFileSync(path.join(dir, 'app.js'), 'x\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  // The first rule of the hook is replaced, in the hook process only, by one that throws on every command.
  const preload = path.join(dir, 'throwing-rule.mjs');
  writeFileSync(preload, `import * as module from 'node:module';
const source = "export function check() { throw new Error('rule failed'); }";
const RULE = '/lib/rules/git-hook-bypass.mjs';
if (module.registerHooks) {
  module.registerHooks({ load: (url, context, next) => (url.endsWith(RULE) ? { format: 'module', source, shortCircuit: true } : next(url, context)) });
} else {
  const hooks = \`export async function load(url, context, next) { return url.endsWith(\${JSON.stringify(RULE)}) ? { format: 'module', source: \${JSON.stringify(source)}, shortCircuit: true } : next(url, context); }\`;
  module.register(\`data:text/javascript,\${encodeURIComponent(hooks)}\`);
}
`);
  const run = (command) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, HOOK], { input: bash(command, dir), encoding: 'utf8', env });
  const blocked = run('echo y > app.js');
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.match(blocked.stderr, /^Blocked: this command writes 'app\.js', a tracked file in the main checkout/);
  // Outside any repository, the hook-bypass rule alone would block this: with it replaced, nothing does.
  const skip = (cwd, args = []) => spawnSync(process.execPath, [...args, HOOK], { input: bash('git commit --no-verify -m x', cwd), encoding: 'utf8', env }).status;
  assert.deepEqual([skip(OUTSIDE), skip(OUTSIDE, ['--import', pathToFileURL(preload).href])], [2, 0], 'the injected rule is the one that throws');
});
