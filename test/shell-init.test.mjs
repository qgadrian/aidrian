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

import { HOSTS } from '../plugins/aidrian/lib/hosts/index.mjs';
import { BEGIN, commands, END, functionLines, install, rcBlock, WRAP_REFUSED, wrapProblem, wrapsOf } from '../plugins/aidrian/lib/shell-init.mjs';

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

// Runs `script` in `shell` with HOME and the state root in `root`, fake `programs` (a `claude` and an `aidrian` unless
// given) first on PATH that log their arguments and AIDRIAN_SHELL_PID, and bash told to expand aliases as an interactive
// bash does. RC in `script` names `file`, or a file holding `block`, rcBlock(shell) unless given.
function inShell(t, shell, script, { block = rcBlock(shell), file = null, programs = ['claude', 'aidrian'] } = {}) {
  const root = folder(t, 'aidrian-block-');
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const log = path.join(root, 'log');
  for (const name of programs) {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $AIDRIAN_SHELL_PID $*" >> '${log}'\nexit 0\n`, { mode: 0o755 });
  }
  const rc = file ?? path.join(root, 'rc');
  if (file === null) writeFileSync(rc, `${block}\n`);
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

// The startup file `shell` reads under `home`, and its text.
const startup = (home, shell) => path.join(home, shell === 'zsh' ? '.zshrc' : '.bashrc');
const read = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);
const wrapArgs = (names) => names.flatMap((name) => ['--wrap', name]);
const recordFor = (expires) => `mkdir -p "$XDG_STATE_HOME/aidrian/handoff-terminals"; echo "abcd1234 ${expires}" > "$XDG_STATE_HOME/aidrian/handoff-terminals/$$"`;

test('with no wrapped name the block is today\'s, with no line of wrapped launchers, and the usage names --wrap', () => {
  for (const shell of ['zsh', 'bash']) {
    assert.doesNotMatch(rcBlock(shell), /# Wrapped launchers:/u);
    const lines = rcBlock(shell, HOSTS, ['cc']).split('\n');
    assert.equal(lines[2], '# Wrapped launchers: cc', 'the record is the third line');
    // The cc lines start at the first line after the record that names cc: the guard before its function.
    const start = lines.findIndex((line, index) => index > 2 && /\bcc\b/u.test(line));
    assert.ok(start > 2 && start < lines.indexOf('function cc {'));
    const unwrapped = [...lines.slice(0, 2), ...lines.slice(3, start), ...lines.slice(lines.indexOf(END))];
    assert.equal(unwrapped.join('\n'), rcBlock(shell), `${shell}: less its record line and the cc function and alias check, the wrapped block is today's`);
  }
  assert.equal(commands['shell-init'].usage, '(zsh | bash) [--install [--wrap NAME]... | --uninstall]');
  assert.match(commands['shell-init'].about, /--wrap/u);
});

test('a wrapped function is the host\'s own with its name and first run changed, and still opens the next session with the host program', () => {
  const own = functionLines('zsh');
  const lines = functionLines('zsh', HOSTS, ['cc']);
  assert.deepEqual(lines.slice(0, own.length), own, 'the host\'s own function and alias check come first, unchanged');
  const body = own.slice(0, own.indexOf('}') + 1);
  const expected = body.map((line) => (line === 'function claude {' ? 'function cc {' : line.replace('command claude "$@"', 'command cc "$@"')));
  const start = lines.indexOf('function cc {');
  assert.deepEqual(lines.slice(start, start + body.length), expected);
  assert.ok(expected.some((line) => line.includes('command claude attach "$id"')), 'the record loop runs the host program, never the launcher');
  assert.match(lines.slice(start + body.length).join('\n'), /case \$_aidrian_alias in cc\|cc\\ \*\|claude\|claude\\ \*\) ;;/u);
  assert.match(lines.slice(own.length, start).join('\n'), /^if builtin functions cc >\/dev\/null 2>&1 && /u, 'a guard comes before the wrapper');
  assert.equal(lines.at(-1), 'fi', 'and closes after its alias check');
});

for (const shell of ['zsh', 'bash']) {
  const notWrapped = 'aidrian shell-init: a shell function cc already exists, so the launcher cc was not wrapped\n';

  test(`in ${shell}, a shell function of a wrapped name defined before the block stays, and the block says it did not wrap it`, { skip: !HAS(shell) }, (t) => {
    const block = `function cc { echo mine; }\n${rcBlock(shell, HOSTS, ['cc'])}`;
    const ran = inShell(t, shell, '. RC\ncc --resume x', { block, programs: ['cc', 'claude'] });
    assert.equal(ran.result.status, 0, ran.result.stderr);
    assert.equal(ran.result.stdout, 'mine\n', 'the earlier function still runs');
    assert.equal(ran.result.stderr, notWrapped);
    assert.deepEqual(ran.calls, [], 'no program of that name ran');
  });

  test(`in ${shell}, reading the startup file twice redefines the block's own wrapper and says nothing`, { skip: !HAS(shell) }, (t) => {
    const ran = inShell(t, shell, '. RC\n. RC\ncc --resume x', { block: rcBlock(shell, HOSTS, ['cc']), programs: ['cc', 'claude'] });
    assert.equal(ran.result.status, 0, ran.result.stderr);
    assert.equal(ran.result.stderr, '', 'no line on the second read');
    assert.equal(ran.calls.length, 1);
    assert.match(ran.calls[0], /^cc \d+ --resume x$/u, 'cc is the wrapper, which set the shell pid');
  });
}

test('in zsh, a hook function a terminal\'s setup registers before the block keeps running when the block names it', { skip: !HAS('zsh') }, (t) => {
  const name = 'update_terminal_cwd';
  const block = `function ${name} { echo hook-ran; }\nprecmd_functions+=(${name})\n${rcBlock('zsh', HOSTS, [name])}`;
  const ran = inShell(t, 'zsh', '. RC\nfor hook in $precmd_functions; do $hook; done', { block, programs: [name, 'claude'] });
  assert.equal(ran.result.status, 0, ran.result.stderr);
  assert.equal(ran.result.stdout, 'hook-ran\n', 'the hook ran the original function');
  assert.match(ran.result.stderr, /^aidrian shell-init: a shell function update_terminal_cwd already exists, so the launcher update_terminal_cwd was not wrapped$/mu);
  assert.deepEqual(ran.calls, [], 'no program of that name ran');
});

test('functionLines refuses a wrapped name that fails the name rule, and wraps only for exactly one host that replaces a terminal', () => {
  const host = (program) => ({ capabilities: { handoffContinue: { replaceTerminal: { program, attach: 'attach' } } } });
  assert.throws(() => functionLines('zsh', HOSTS, ['x;y']), /--wrap/u);
  assert.throws(() => functionLines('zsh', HOSTS, ['claude']), /--wrap/u);
  assert.throws(() => functionLines('zsh', [host('claude'), host('other')], ['cc']), /exactly one host/u);
  assert.throws(() => functionLines('zsh', [{ capabilities: {} }], ['cc']), /exactly one host/u);
  assert.doesNotThrow(() => functionLines('zsh', [host('claude'), host('other')]), 'two hosts with no wrapped name, as before');
  assert.equal(wrapProblem('cc'), null);
  assert.equal(wrapProblem(`c${'x'.repeat(31)}`), null, '32 characters');
  for (const name of ['if', 'command', 'local', 'cd', 'exit', 'rm', 'od', 'nocorrect']) assert.ok(WRAP_REFUSED.includes(name), name);
  for (const name of [...WRAP_REFUSED, 'claude', '', 'a b', '1cc', 'é', `c${'x'.repeat(32)}`]) assert.notEqual(wrapProblem(name), null, name);
});

test('wrapProblem refuses the functions a shell runs as hooks, any TRAP or zle- name, and builtins of bash 4 and 5', () => {
  const hooks = ['preexec', 'precmd', 'chpwd', 'periodic', 'zshaddhistory', 'zshexit', 'zsh_directory_name', 'command_not_found_handler', 'command_not_found_handle'];
  const prefixed = ['TRAPZERR', 'TRAPDEBUG', 'TRAPEXIT', 'TRAPINT', 'TRAPanything', 'zle-line-init', 'zle-keymap-select'];
  const builtins = ['shift', 'trap', 'setopt', 'mapfile', 'readarray', 'compopt', 'coproc', 'shopt'];
  for (const name of [...hooks, ...prefixed, ...builtins]) assert.notEqual(wrapProblem(name), null, name);
  for (const name of ['claude-work', 'trapper', 'Trap', 'zlestuff']) assert.equal(wrapProblem(name), null, `${name}: only the exact prefixes are refused`);
});

// The words `shell` names as its own builtins and reserved words, zsh with every module it can load, run with an
// environment inside the test's temporary folder.
function shellWords(t, shell) {
  const root = folder(t, 'aidrian-words-');
  const zsh = 'for d in $module_path; do for f in $d/zsh/**/*.(so|bundle)(N); do zmodload ${${f#$d/}%.*} 2>/dev/null; done; done; print -l ${(k)builtins} ${(k)reswords}';
  const script = shell === 'zsh' ? zsh : 'compgen -b; compgen -k';
  const result = spawnSync(shell, [...SHELL_ARGS[shell], script], { env: { PATH: SYSTEM_PATH, HOME: root, XDG_STATE_HOME: path.join(root, 'state') }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\n').filter((word) => /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(word));
}

for (const shell of ['zsh', 'bash']) {
  test(`wrapProblem refuses every reserved word and builtin ${shell} lists`, { skip: !HAS(shell) }, (t) => {
    const words = shellWords(t, shell);
    assert.ok(words.length > 40, `${shell} listed its words: ${words.length}`);
    assert.deepEqual(words.filter((word) => wrapProblem(word) === null), [], `each word ${shell} lists is refused`);
  });
}

test('wrapsOf reads the line of wrapped launchers this command writes, and calls any other unreadable', () => {
  assert.deepEqual(wrapsOf(rcBlock('zsh')), { names: [], readable: true });
  assert.deepEqual(wrapsOf(rcBlock('zsh', HOSTS, ['dd', 'cc', 'dd'])), { names: ['cc', 'dd'], readable: true });
  const [begin, written, ...rest] = rcBlock('zsh').split('\n');
  const nine = Array.from({ length: 9 }, (_, index) => `w${index}`).join(' ');
  for (const line of ['# Wrapped launchers: claude', '# Wrapped launchers: preexec', '# Wrapped launchers: TRAPZERR cc', '# Wrapped launchers: x;y', '# Wrapped launchers: dd cc', '# Wrapped launchers: cc cc', '# Wrapped launchers: ', '# Wrapped launchers:', `# Wrapped launchers: ${nine}`]) {
    assert.deepEqual(wrapsOf([begin, written, line, ...rest].join('\n')), { names: [], readable: false }, line);
  }
});

for (const shell of ['zsh', 'bash']) {
  test(`in ${shell}, --install --wrap cc writes a cc function that passes the shell's pid and opens the session a record names`, { skip: !HAS(shell) }, (t) => {
    const home = folder(t, 'aidrian-home-');
    const result = shellInit(home, shell, '--install', '--wrap', 'cc');
    assert.equal(result.status, 0, result.stderr);
    const rc = startup(home, shell);
    const text = readFileSync(rc, 'utf8');
    const inside = text.slice(text.indexOf(BEGIN), text.indexOf(END));
    assert.match(inside, /^function cc \{$/mu);
    assert.match(inside, /^# Wrapped launchers: cc$/mu);
    const soon = Math.floor(Date.now() / 1000) + 30;
    const ran = inShell(t, shell, `. RC\necho $$\n${recordFor(soon)}\ncc --resume x`, { file: rc, programs: ['cc', 'claude'] });
    assert.equal(ran.result.status, 0, ran.result.stderr);
    const pid = ran.result.stdout.trim();
    assert.match(pid, /^\d+$/u);
    assert.deepEqual(ran.calls, [`cc ${pid} --resume x`, `claude ${pid} attach abcd1234`]);
  });

  test(`in ${shell}, an alias of a wrapped name that starts with it or with claude says nothing, and one to another path is named`, { skip: !HAS(shell) }, (t) => {
    const options = { block: rcBlock(shell, HOSTS, ['cc']), programs: ['cc', 'claude'] };
    for (const alias of ["alias cc='claude --flag'", "alias cc='cc --flag'", 'alias cc=cc']) {
      const quiet = inShell(t, shell, `${alias}\n. RC\necho done`, options);
      assert.equal(quiet.result.status, 0, quiet.result.stderr);
      assert.equal(quiet.result.stderr, '', alias);
    }
    const other = inShell(t, shell, 'alias cc=/opt/elsewhere/cc\n. RC\necho done', options);
    assert.equal(other.result.status, 0, other.result.stderr);
    assert.equal(other.result.stderr, 'aidrian shell-init: the alias cc runs past the shell function, so a handoff will not replace this terminal\n');
  });
}

test('--uninstall after --install --wrap cc leaves the startup file as it was', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  writeFileSync(rc, 'export EDITOR=nvim');
  assert.equal(shellInit(home, 'zsh', '--install', '--wrap', 'cc').status, 0);
  const gone = shellInit(home, 'zsh', '--uninstall');
  assert.equal(gone.status, 0, gone.stderr);
  assert.equal(read(rc), 'export EDITOR=nvim\n', 'the newline install added to a file that ended without one, and nothing else');
});

test('a re-install keeps the wrapped names, a later --wrap adds to them, and --uninstall then --install starts the list again', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  writeFileSync(rc, 'alias g=git\n');
  assert.equal(shellInit(home, 'zsh', '--install', '--wrap', 'cc').status, 0);
  const wrapped = read(rc);
  assert.equal(wrapped, `alias g=git\n${rcBlock('zsh', HOSTS, ['cc'])}\n`);
  const again = shellInit(home, 'zsh', '--install');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^.* already holds the current aidrian shell-init block; nothing changed\.$/mu);
  assert.match(again.stdout, /^It also wraps `cc`: each runs as before, and follows a handoff when it is a program on PATH that ends in `exec` of `claude`\. `--wrap` adds a name and never drops one; `--uninstall` then `--install` starts the list again\.$/mu);
  assert.equal(read(rc), wrapped, 'nothing changed');

  writeFileSync(rc, wrapped.replace('|| rc=$?', '; rc=$?'));
  const replaced = shellInit(home, 'zsh', '--install');
  assert.match(replaced.stdout, /^Replaced the aidrian shell-init block/mu);
  assert.equal(read(rc), wrapped, 'an edited block is replaced, and cc is still wrapped');

  const added = shellInit(home, 'zsh', '--install', '--wrap', 'dd');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(read(rc), `alias g=git\n${rcBlock('zsh', HOSTS, ['cc', 'dd'])}\n`);
  assert.match(added.stdout, /It also wraps `cc`, `dd`: .*`--uninstall` then `--install` starts the list again\.\n$/u, 'the output ends with how to start the list again');

  assert.equal(shellInit(home, 'zsh', '--uninstall').status, 0);
  assert.equal(shellInit(home, 'zsh', '--install', '--wrap', 'dd').status, 0);
  assert.equal(read(rc), `alias g=git\n${rcBlock('zsh', HOSTS, ['dd'])}\n`, 'dd alone');
});

test('--wrap names in any order or repeated write the same bytes, and a ninth name is refused', (t) => {
  const texts = [['b', 'a'], ['a', 'b', 'a']].map((names) => {
    const home = folder(t, 'aidrian-home-');
    assert.equal(shellInit(home, 'zsh', '--install', ...wrapArgs(names)).status, 0);
    return read(startup(home, 'zsh'));
  });
  assert.equal(texts[0], texts[1]);
  assert.match(texts[0], /^# Wrapped launchers: a b$/mu);

  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  const eight = ['ga', 'gb', 'gc', 'gd', 'ge', 'gf', 'gg', 'gh'];
  writeFileSync(rc, `${rcBlock('zsh', HOSTS, eight)}\n`);
  const before = read(rc);
  const ninth = shellInit(home, 'zsh', '--install', '--wrap', 'gi');
  assert.equal(ninth.status, 2, ninth.stdout);
  assert.match(ninth.stderr, /^usage: aidrian shell-init /u);
  assert.match(ninth.stderr, /at most 8/u);
  assert.equal(read(rc), before, 'byte for byte');
  assert.equal(shellInit(home, 'zsh', '--install', '--wrap', 'gh').status, 0, 'a name already recorded adds none');
  assert.equal(read(rc), before);
});

test('--install refuses each --wrap name the rule refuses, by its position, never echoes it, and writes nothing', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  writeFileSync(rc, 'alias g=git\n');
  const nine = Array.from({ length: 9 }, (_, index) => `w${index}`);
  const refused = [[''], ['claude'], ['a b'], ['x;y'], ['$(id)'], ['`id`'], ['./cc'], ['/usr/bin/cc'], ['a\nb'], ['a'.repeat(33)], ['1cc'], ['é'], ['if'], ['local'], ['exit'], nine, ['\u001b[31mred']];
  for (const names of refused) {
    const result = shellInit(home, 'zsh', '--install', ...wrapArgs(names));
    assert.equal(result.status, 2, JSON.stringify(names));
    const lines = result.stderr.trimEnd().split('\n');
    assert.equal(lines.length, 2, `the usage line and one reason: ${result.stderr}`);
    assert.match(lines[0], /^usage: aidrian shell-init /u);
    assert.doesNotMatch(result.stderr, /\u001b/u, 'no escape byte reaches the terminal');
    assert.equal(read(rc), 'alias g=git\n', JSON.stringify(names));
  }
  const second = shellInit(home, 'zsh', '--install', ...wrapArgs(['cc', 'x;y', 'dd']));
  assert.match(second.stderr, /--wrap name 2 of 3 /u);
  assert.doesNotMatch(second.stderr, /x;y/u, 'a value that failed the shape is never echoed');

  const empty = folder(t, 'aidrian-home-');
  assert.equal(shellInit(empty, 'zsh', '--install', '--wrap', 'x;y').status, 2);
  assert.equal(existsSync(startup(empty, 'zsh')), false, 'no startup file is created');
  for (const args of [['--wrap', '-x'], ['--wrap']]) {
    const result = shellInit(home, 'zsh', '--install', ...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(read(rc), 'alias g=git\n');
  }
});

test('a line of the Human\'s own that runs aidrian shell-init, and no block, refuses --wrap and changes nothing', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  const own = 'eval "$(aidrian shell-init zsh)"\n';
  writeFileSync(rc, own);
  const result = shellInit(home, 'zsh', '--install', '--wrap', 'cc');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /already runs aidrian shell-init on line 1, outside a block; no launcher was wrapped/u);
  assert.equal(read(rc), own);
});

test('a block whose line of wrapped launchers this command did not write is replaced, wrapping only what --wrap names', (t) => {
  const [begin, written, ...rest] = rcBlock('zsh').split('\n');
  for (const line of ['# Wrapped launchers: claude', '# Wrapped launchers: x;y']) {
    const block = [begin, written, line, ...rest].join('\n');
    for (const [wraps, expected] of [[[], rcBlock('zsh')], [['dd'], rcBlock('zsh', HOSTS, ['dd'])]]) {
      const home = folder(t, 'aidrian-home-');
      const rc = startup(home, 'zsh');
      writeFileSync(rc, `alias g=git\n${block}\n`);
      const result = shellInit(home, 'zsh', '--install', ...wrapArgs(wraps));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(read(rc), `alias g=git\n${expected}\n`, `${line} ${wraps}`);
      assert.match(result.stdout, /line of wrapped launchers was not one this command wrote.*`--wrap`/u);
    }
  }
});

test('the session start counts a block that wraps a launcher and is otherwise current as current', (t) => {
  const home = folder(t, 'aidrian-home-');
  const rc = startup(home, 'zsh');
  const wrapped = `alias g=git\n${rcBlock('zsh', HOSTS, ['cc'])}\n`;
  writeFileSync(rc, wrapped);
  assert.doesNotMatch(sessionStart(t, { CLAUDE_CODE_SESSION_ATTENDED: '1', AIDRIAN_SHELL_PID: '4242' }, { home }), /Handoff terminal/u, 'no stale line');
  assert.doesNotMatch(sessionStart(t, { CLAUDE_CODE_SESSION_ATTENDED: '1' }, { home }), /Handoff terminal/u, 'it holds the current block');
  writeFileSync(rc, wrapped.replace('|| rc=$?', '; rc=$?'));
  assert.match(sessionStart(t, { CLAUDE_CODE_SESSION_ATTENDED: '1', AIDRIAN_SHELL_PID: '4242' }, { home }), /^Handoff terminal: the aidrian shell function block in .*\.zshrc differs from this plugin's/mu);
});

