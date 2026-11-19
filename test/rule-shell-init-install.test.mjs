// The shell startup file rule (lib/rules/shell-init-install.mjs): no agent runs `aidrian shell-init --install` or
// `--uninstall`, which write the Human's ~/.zshrc or ~/.bashrc; printing the function runs.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { check, REASON, SHELL_NAMES } from '../plugins/aidrian/lib/rules/shell-init-install.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const deny = (command) => assert.equal(check(command), REASON, `expected deny: ${command}`);
const allow = (command) => assert.equal(check(command), null, `expected allow: ${command}`);

test('denies an install or uninstall of the shell function, however aidrian is run and wherever the command sits', () => {
  deny('aidrian shell-init zsh --install');
  deny('aidrian shell-init bash --uninstall');
  deny('aidrian shell-init --install zsh');
  deny('/opt/plugins/cache/m/aidrian/0.68.0/bin/aidrian shell-init zsh --install');
  deny('node plugins/aidrian/lib/cli.mjs shell-init zsh --install');
  deny('cd ~ && aidrian shell-init zsh --install');
  deny('bash -c "aidrian shell-init zsh --install"');
  deny('echo "$(aidrian shell-init zsh --uninstall)"');
  deny('echo "aidrian shell-init zsh --install" | bash');
});

test('denies an install that wraps a launcher, wherever --wrap sits', () => {
  deny('aidrian shell-init zsh --install --wrap cc');
  deny('aidrian shell-init zsh --wrap cc --install');
  deny('aidrian shell-init zsh --wrap=cc --install');
});

test('denies the command carried by a program that runs its arguments or a string as a command', () => {
  deny('echo zsh | xargs aidrian shell-init --install');
  deny('find . -maxdepth 0 -exec aidrian shell-init zsh --install \\;');
  deny("watch 'aidrian shell-init zsh --install'");
  deny('script -q /dev/null aidrian shell-init zsh --uninstall');
  deny("script -c 'aidrian shell-init zsh --install' /dev/null");
  deny('parallel aidrian shell-init {} --install ::: zsh');
  deny("fish -c 'aidrian shell-init zsh --install'");
  deny("pwsh -Command 'node /opt/aidrian/lib/cli.mjs shell-init zsh --install'");
  allow('xargs -n1 echo < files');
  allow('find . -name "*.md" -exec grep -l "shell-init zsh --install" {} +');
  allow("watch 'aidrian shell-init zsh'");
});

test('each shell of the shared list runs the command in its -c string, and a shell the walk does not read carries its text', () => {
  const walked = ['sh', 'bash', 'zsh', 'dash', 'ksh'];
  for (const shell of SHELL_NAMES) {
    deny(`${shell} -c 'aidrian shell-init zsh --install'`);
    const printed = `${shell} -c 'echo aidrian shell-init zsh --install'`;
    if (walked.includes(shell)) allow(printed);
    else deny(printed);
  }
});

test('allows printing the function, other aidrian commands, and text that only names the command', () => {
  allow('aidrian shell-init zsh');
  allow('eval "$(aidrian shell-init zsh)"');
  allow('aidrian lesson list --install');
  allow('echo aidrian shell-init zsh --install');
  allow('grep -n "shell-init zsh --install" README.md');
});

test('the reason says to hand the Human the command with the ! prefix, and the Bash hook refuses the main session too', () => {
  assert.match(REASON, /^Blocked: .*write the Human's shell startup file/u);
  assert.match(REASON, /`! aidrian shell-init zsh --install`/u);
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'aidrian shell-init zsh --install' }, session_id: 's-1', cwd: process.cwd() });
  const result = spawnSync(process.execPath, [HOOK], { input, env: { ...process.env, CLAUDECODE: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /`! aidrian shell-init zsh --install`/u);
});
