// `aidrian shell-init <shell> --install | --uninstall` (docs/handoff.md#replacing-the-terminal): the block it appends
// to the shell's startup file once and removes alone, how that block finds `aidrian` after an update moves the
// installed copy, and the session start's line for a session the shell function did not start. Every startup file is
// under a temporary HOME; the block runs in `zsh -f` and `bash --norc`, skipped where a shell is missing.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { BEGIN, END, rcBlock } from '../plugins/aidrian/lib/shell-init.mjs';

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
  assert.match(again.stdout, /already holds the aidrian shell-init block; nothing changed\./u);
  assert.equal(readFileSync(rc, 'utf8'), after, 'a second install changes nothing');

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
  assert.match(readFileSync(path.join(home, '.bashrc'), 'utf8'), /^# >>> aidrian shell-init >>>\n[\s\S]*eval "\$\(aidrian shell-init bash 2>\/dev\/null\)"/u);
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

// A fake `aidrian` that answers `shell-init <shell>` with a line naming `who`.
function fakeAidrian(dir, who) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'aidrian'), `#!/bin/sh\n[ "$1" = shell-init ] && echo 'echo picked=${who}'\n`, { mode: 0o755 });
}

for (const shell of ['zsh', 'bash']) {
  test(`in ${shell}, the block runs the aidrian on PATH, else the highest installed version, else a checkout's own`, { skip: !HAS(shell) }, (t) => {
    const root = folder(t, 'aidrian-versions-');
    const versions = path.join(root, 'cache', 'aidrian');
    for (const version of ['0.9.0', '0.10.0', '0.66.2']) fakeAidrian(path.join(versions, version, 'bin'), version);
    fakeAidrian(path.join(versions, 'not-a-version', 'bin'), 'stray');
    const run = (block, PATH) => {
      const rc = path.join(root, `rc-${shell}`);
      writeFileSync(rc, `${block}\n`);
      return spawnSync(shell, [...SHELL_ARGS[shell], `. '${rc}'`], { env: { PATH, HOME: root }, encoding: 'utf8' }).stdout.trim();
    };
    const installed = rcBlock(shell, path.join(versions, '0.9.0'));
    assert.equal(run(installed, SYSTEM_PATH), 'picked=0.66.2', 'the highest version, compared as numbers, not the copy that installed it');
    const onPath = path.join(root, 'on-path');
    fakeAidrian(onPath, 'path');
    assert.equal(run(installed, `${onPath}:${SYSTEM_PATH}`), 'picked=path');
    const checkout = path.join(root, 'checkout', 'plugins', 'aidrian');
    fakeAidrian(path.join(checkout, 'bin'), 'checkout');
    assert.equal(run(rcBlock(shell, checkout), SYSTEM_PATH), 'picked=checkout');
    rmSync(versions, { recursive: true });
    assert.equal(run(installed, SYSTEM_PATH), '', 'with no copy left, it does nothing and breaks nothing');
  });
}

test('a path the block cannot quote gets no fallback', () => {
  assert.doesNotMatch(rcBlock('zsh', "/tmp/it's/aidrian/0.1.0"), /it's/u);
  assert.match(rcBlock('zsh', "/tmp/it's/aidrian/0.1.0"), /^ {2}:$/mu);
});

// A project whose machine switch and config turn the background route on in auto mode, and the session start's output
// for a Claude Code session with `env`.
function sessionStart(t, env, { local = { handoff: { background: 'on' } }, handoff = { mode: 'auto' } } = {}) {
  const dir = folder(t, 'aidrian-start-');
  // The machine switch reads "on" only in a file git can say it does not track.
  spawnSync('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, session: { handoff } }));
  if (local) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
  const input = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'start-1', cwd: dir, source: 'startup' });
  const result = spawnSync(process.execPath, [START], { input, env: { ...process.env, CLAUDECODE: '1', ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('the session start tells an attended session the shell function did not start that its terminal will not follow a handoff', (t) => {
  const line = /^Handoff terminal: this machine's background handoff route is on, but the aidrian shell function did not start this session's `claude`, .* runs `aidrian shell-init zsh --install` once, or `aidrian shell-init bash --install` for bash, and opens a new terminal\.$/mu;
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
});
