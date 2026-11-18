// `aidrian shell-init <shell> --install | --uninstall` (docs/handoff.md#replacing-the-terminal): the block it appends
// to the shell's startup file once and removes alone, how that block finds `aidrian` after an update moves the
// installed copy, and the session start's line for a session the shell function did not start. Every startup file is
// under a temporary HOME; the block runs in `zsh -f` and `bash --norc`, skipped where a shell is missing.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BEGIN, END, install, rcBlock } from '../plugins/aidrian/lib/shell-init.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const START = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-session-start.mjs');
const HAS = (shell) => spawnSync(shell, ['-c', 'exit 0']).status === 0;
const SHELL_ARGS = { zsh: ['-f', '-c'], bash: ['--norc', '--noprofile', '-c'] };
const SYSTEM_PATH = '/usr/bin:/bin';

function folder(t, prefix) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Runs `aidrian shell-init <args>` with HOME at `home` and no ZDOTDIR.
function shellInit(home, ...args) {
  const env = { ...process.env, HOME: home };
  delete env.ZDOTDIR;
  return spawnSync(CLI, ['shell-init', ...args], { env, encoding: 'utf8' });
}

test('--install appends the block to ~/.zshrc once, keeps every other byte, and says what it did', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = path.join(home, '.zshrc');
  const before = 'export EDITOR=nvim\nalias g=git';
  writeFileSync(rc, before);
  const first = shellInit(home, 'zsh', '--install');
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, new RegExp(`^Added the aidrian shell-init block to the end of ${rc.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}; no other line changed\\.$`, 'mu'));
  assert.match(first.stdout, /--uninstall` removes the block\.$/mu);
  const after = readFileSync(rc, 'utf8');
  assert.ok(after.startsWith(`${before}\n${BEGIN}\n`), 'the file ended with no newline: one is added, then the block');
  assert.ok(after.endsWith(`${END}\n`));

  const again = shellInit(home, 'zsh', '--install');
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already holds the current aidrian shell-init block; nothing changed\./u);
  assert.equal(readFileSync(rc, 'utf8'), after, 'a second install changes nothing');

  writeFileSync(rc, after.replace('  rc=$?', '  rc=$?\n  echo old').replace('|| rc=$?', '; rc=$?'));
  const replaced = shellInit(home, 'zsh', '--install');
  assert.match(replaced.stdout, /^Replaced the aidrian shell-init block in .* with the current one; no other line changed\.$/mu);
  assert.equal(readFileSync(rc, 'utf8'), after, 'an older block is replaced by the current one, in place');

  const gone = shellInit(home, 'zsh', '--uninstall');
  assert.equal(gone.status, 0, gone.stderr);
  assert.match(gone.stdout, /^Removed the aidrian shell-init block, lines 3-\d+, from .*; no other line changed\.$/mu);
  assert.equal(readFileSync(rc, 'utf8'), `${before}\n`, 'every other line as it was');
  const twice = shellInit(home, 'zsh', '--uninstall');
  assert.match(twice.stdout, /holds no aidrian shell-init block; nothing changed\./u);
});

test('--install creates a missing startup file, writes ~/.bashrc for bash, and follows ZDOTDIR for zsh', (t) => {
  const home = folder(t, 'aidrian-home-');
  assert.equal(shellInit(home, 'bash', '--install').status, 0);
  assert.match(readFileSync(path.join(home, '.bashrc'), 'utf8'), /^# >>> aidrian shell-init >>>\n[\s\S]*^function claude \{$/mu);
  const zdot = folder(t, 'aidrian-zdot-');
  const result = spawnSync(CLI, ['shell-init', 'zsh', '--install'], { env: { ...process.env, HOME: home, ZDOTDIR: zdot }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(path.join(zdot, '.zshrc'), 'utf8'), /aidrian shell-init zsh/u);
});

test('a line of the Human\'s own that runs aidrian shell-init counts as installed, and --uninstall leaves it', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = path.join(home, '.zshrc');
  const own = 'source ~/.aliases\neval "$(aidrian shell-init zsh)"\n';
  writeFileSync(rc, own);
  const install = shellInit(home, 'zsh', '--install');
  assert.match(install.stdout, /already runs aidrian shell-init on line 2, outside a block; nothing changed\./u);
  const uninstall = shellInit(home, 'zsh', '--uninstall');
  assert.match(uninstall.stdout, /Line 2 of .* runs aidrian shell-init outside a block, and was left as it is\./u);
  assert.equal(readFileSync(rc, 'utf8'), own);
  writeFileSync(rc, '# eval "$(aidrian shell-init zsh)" was here\n');
  assert.match(shellInit(home, 'zsh', '--install').stdout, /^Added/u, 'a comment does not count');
});

test('--uninstall refuses a start marker with no end, and keeps a startup file that is a link a link', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = path.join(home, '.zshrc');
  const broken = `alias a=b\n${BEGIN}\neval x\n`;
  writeFileSync(rc, broken);
  const result = shellInit(home, 'zsh', '--uninstall');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /start marker on line 2 but no end marker after it; nothing changed/u);
  assert.equal(readFileSync(rc, 'utf8'), broken);

  const dotfiles = folder(t, 'aidrian-dotfiles-');
  const target = path.join(dotfiles, 'zshrc');
  writeFileSync(target, 'alias a=b\n', { mode: 0o640 });
  chmodSync(target, 0o640);
  rmSync(rc);
  symlinkSync(target, rc);
  assert.equal(shellInit(home, 'zsh', '--install').status, 0);
  assert.equal(shellInit(home, 'zsh', '--uninstall').status, 0);
  assert.ok(lstatSync(rc).isSymbolicLink(), 'the link stays');
  assert.equal(readFileSync(target, 'utf8'), 'alias a=b\n');
  assert.equal(statSync(target).mode & 0o777, 0o640, 'its mode stays');
});

// Runs `script` in `shell` with HOME and the state root in `root`, a fake `claude` and a fake `aidrian` first on PATH that
// log their arguments and AIDRIAN_SHELL_PID, and bash told to expand aliases as an interactive bash does.
function inShell(t, shell, script) {
  const root = folder(t, 'aidrian-block-');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'log');
  for (const name of ['claude', 'aidrian']) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $AIDRIAN_SHELL_PID $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  }
  const rc = path.join(root, 'rc');
  writeFileSync(rc, `${rcBlock(shell)}\n`);
  const prelude = shell === 'bash' ? 'shopt -s expand_aliases\n' : '';
  const result = spawnSync(shell, [...SHELL_ARGS[shell], `${prelude}${script.replaceAll('RC', `'${rc}'`)}`], {
    env: { PATH: `${bin}:${SYSTEM_PATH}`, HOME: root, XDG_STATE_HOME: path.join(root, 'state') }, encoding: 'utf8',
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { result, calls, root };
}

for (const shell of ['zsh', 'bash']) {
  test(`in ${shell}, the installed block runs no plugin code and looks nothing up on PATH`, { skip: !HAS(shell) }, (t) => {
    const { result, calls } = inShell(t, shell, '. RC\ntype claude');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, [], 'sourcing the block runs neither aidrian nor claude');
    assert.match(result.stdout, /function/u);
    assert.doesNotMatch(rcBlock(shell), /^[^#]*\baidrian shell-init\b(?! *:)/mu, 'no line but a comment or a message runs aidrian');
  });

  test(`in ${shell}, an alias that adds a flag reaches the function, and one to another path is named on stderr`, { skip: !HAS(shell) }, (t) => {
    const flag = inShell(t, shell, "alias claude='claude --dangerously-skip-permissions'\n. RC\neval 'claude --resume x'\necho done");
    assert.equal(flag.result.status, 0, flag.result.stderr);
    assert.equal(flag.result.stderr, '', 'an alias that starts with claude says nothing');
    assert.equal(flag.calls.length, 1, 'sourcing ran nothing; the one call is the typed one');
    assert.match(flag.calls[0], /^claude \d+ --dangerously-skip-permissions --resume x$/u, 'the alias reached the function, which set the shell pid');
    const other = inShell(t, shell, "alias claude=/opt/elsewhere/claude\n. RC\necho done");
    assert.equal(other.result.status, 0, other.result.stderr);
    assert.match(other.result.stdout, /done/u, 'the block parses with the alias in place');
    assert.match(other.result.stderr, /^aidrian shell-init: the alias claude runs past the shell function, so a handoff will not replace this terminal$/mu);
    assert.deepEqual(other.calls, [], 'sourcing the block started nothing');
    const plain = inShell(t, shell, 'alias claude=claude\n. RC\necho done');
    assert.equal(plain.result.status, 0, plain.result.stderr);
    assert.equal(plain.result.stderr, '', 'an alias that is just claude, which bash prints quoted, says nothing');
  });

  test(`in ${shell}, the function reaches the record under set -e and set -u, and refuses an expiry too far ahead`, { skip: !HAS(shell) }, (t) => {
    const record = (expires) => `mkdir -p "$XDG_STATE_HOME/aidrian/handoff-terminals"; echo "abcd1234 ${expires}" > "$XDG_STATE_HOME/aidrian/handoff-terminals/$$"`;
    const soon = Math.floor(Date.now() / 1000) + 30;
    const strict = inShell(t, shell, `. RC\nset -eu\nunset XDG_STATE_HOME\nmkdir -p "$HOME/.local/state/aidrian/handoff-terminals"; echo "abcd1234 ${soon}" > "$HOME/.local/state/aidrian/handoff-terminals/$$"\nclaude --resume x`);
    assert.equal(strict.calls.length, 2, `${strict.result.stderr}: the record is read and opened with set -eu and no XDG_STATE_HOME`);
    assert.match(strict.calls[1], /^claude \d+ attach abcd1234$/u);
    const far = inShell(t, shell, `. RC\n${record(Math.floor(Date.now() / 1000) + 3600)}\nclaude --resume x\nls "$XDG_STATE_HOME/aidrian/handoff-terminals" | wc -l`);
    assert.equal(far.calls.length, 1, 'an expiry an hour ahead is refused');
    assert.match(far.result.stdout.trim(), /^0$/u, 'and the record is deleted all the same');
  });
}

test('under set -e, a program that exits non-zero still lets the function read the record', { skip: !HAS('bash') }, (t) => {
  const root = folder(t, 'aidrian-errexit-');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'log');
  writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = attach ] && exit 5\nexit 143\n`, { mode: 0o755 });
  const rc = path.join(root, 'rc');
  writeFileSync(rc, `${rcBlock('bash')}\n`);
  const soon = Math.floor(Date.now() / 1000) + 30;
  const script = `. '${rc}'\nset -e\nmkdir -p "$XDG_STATE_HOME/aidrian/handoff-terminals"; echo "abcd1234 ${soon}" > "$XDG_STATE_HOME/aidrian/handoff-terminals/$$"\nclaude --resume x\necho unreachable`;
  const result = spawnSync('bash', ['--norc', '--noprofile', '-c', script], { env: { PATH: `${bin}:${SYSTEM_PATH}`, HOME: root, XDG_STATE_HOME: path.join(root, 'state') }, encoding: 'utf8' });
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), ['--resume x', 'attach abcd1234'], 'the exit 143 did not abort the function before the record');
  assert.equal(result.status, 5, 'the function returns the last exit, which set -e then acts on');
  assert.doesNotMatch(result.stdout, /unreachable/u);
});

test('--install for bash on macOS warns when ~/.bash_profile does not source ~/.bashrc', (t) => {
  const home = folder(t, 'aidrian-home-');
  const env = { HOME: home };
  const warned = install('bash', { env, platform: 'darwin' });
  assert.match(warned.out.join('\n'), /^On macOS a new terminal starts bash as a login shell, which reads ~\/\.bash_profile, and it does not source ~\/\.bashrc/mu);
  writeFileSync(path.join(home, '.bash_profile'), '[ -f ~/.bashrc ] && . ~/.bashrc\n');
  assert.doesNotMatch(install('bash', { env, platform: 'darwin' }).out.join('\n'), /login shell/u);
  rmSync(path.join(home, '.bash_profile'));
  assert.doesNotMatch(install('bash', { env, platform: 'linux' }).out.join('\n'), /login shell/u);
  assert.doesNotMatch(install('zsh', { env, platform: 'darwin' }).out.join('\n'), /login shell/u);
});

// A project whose machine switch and config turn the background route on in auto mode, and the session start's output
// for a Claude Code session with `env`.
function sessionStart(t, env, { local = { handoff: { background: 'on' } }, handoff = { mode: 'auto' }, home = folder(t, 'aidrian-home-') } = {}) {
  const dir = folder(t, 'aidrian-start-');
  // The machine switch reads "on" only in a file git can say it does not track.
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, session: { handoff } }));
  if (local) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'start-1', cwd: dir, source: 'startup' });
  const result = spawnSync(process.execPath, [START], { input, env: { ...process.env, CLAUDECODE: '1', HOME: home, ZDOTDIR: '', ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('the session start tells an attended session the shell function did not start that its terminal will not follow a handoff', (t) => {
  const line = /^Handoff terminal: this machine's background handoff route is on, but the aidrian shell function did not start this session's `claude`, .* this session hands "the Human" `! aidrian shell-init zsh --install`, or `! aidrian shell-init bash --install` for bash, to run once before opening a new terminal, and never runs it itself, since it writes "the Human"'s shell startup file\. A copy of the plugin older than this one answers `unknown command: shell-init`: the plugin is updated first, with `claude plugin update aidrian@aidrian-harness`\.$/mu;
  assert.match(sessionStart(t, { CLAUDE_CODE_SESSION_ATTENDED: '1' }), line);
  for (const [name, env, options] of [
    ['the shell function started it', { CLAUDE_CODE_SESSION_ATTENDED: '1', AIDRIAN_SHELL_PID: '4242' }, {}],
    ['a background session', { CLAUDE_CODE_SESSION_ATTENDED: '0' }, {}],
    ['the machine switch is off', { CLAUDE_CODE_SESSION_ATTENDED: '1' }, { local: null }],
    ['ask mode', { CLAUDE_CODE_SESSION_ATTENDED: '1' }, { handoff: { mode: 'ask', continue: 'background' } }],
    ['the clear route', { CLAUDE_CODE_SESSION_ATTENDED: '1' }, { handoff: { mode: 'auto', continue: 'clear' } }],
  ]) {
    assert.doesNotMatch(sessionStart(t, env, options), /Handoff terminal/u, name);
  }
  // A session started where the startup file did not run, such as an editor's terminal: an install would change nothing.
  const home = folder(t, 'aidrian-home-');
  writeFileSync(path.join(home, '.zshrc'), `alias g=git\n${rcBlock('zsh')}\n`);
  assert.doesNotMatch(sessionStart(t, { CLAUDE_CODE_SESSION_ATTENDED: '1' }, { home }), /Handoff terminal/u, 'the current block is installed');
});

test('the session start names a startup file whose block differs from the current one, and never rewrites it', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = path.join(home, '.zshrc');
  const old = `alias g=git\n${rcBlock('zsh').replace('|| rc=$?', '; rc=$?')}\n`;
  writeFileSync(rc, old);
  const env = { CLAUDE_CODE_SESSION_ATTENDED: '1', AIDRIAN_SHELL_PID: '4242' };
  const stale = /^Handoff terminal: the aidrian shell function block in .*\.zshrc differs from this plugin's, so a handoff may not replace the terminal as this version does\. This session hands "the Human" the command `! aidrian shell-init zsh --install`, which replaces the block, and never runs it or edits the file itself\.$/mu;
  assert.match(sessionStart(t, env, { home }), stale);
  assert.equal(readFileSync(rc, 'utf8'), old, 'the file is left as it was');
  writeFileSync(rc, `alias g=git\n${rcBlock('zsh')}\n`);
  assert.doesNotMatch(sessionStart(t, env, { home }), /Handoff terminal/u, 'the current block');
  writeFileSync(rc, old);
  assert.doesNotMatch(sessionStart(t, env, { home, local: null }), /Handoff terminal/u, 'the machine switch is off');
});

