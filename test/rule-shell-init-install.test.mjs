// The shell startup file rule (lib/rules/shell-init-install.mjs): no agent runs `aidrian shell-init --install` or
// `--uninstall`, which write the Human's ~/.zshrc or ~/.bashrc; printing the function runs.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/shell-init-install.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const deny = (command) => assert.equal(check(command), REASON, `expected deny: ${command}`);
const allow = (command) => assert.equal(check(command), null, `expected allow: ${command}`);

test('denies an install or uninstall of the shell function, however aidrian is run and wherever the command sits', () => {
  deny('aidrian shell-init zsh --install');
  deny('aidrian shell-init bash --uninstall');
  deny('aidrian shell-init --install zsh');
  deny('/Users/x/.claude/plugins/cache/m/aidrian/0.68.0/bin/aidrian shell-init zsh --install');
  deny('node plugins/aidrian/lib/cli.mjs shell-init zsh --install');
  deny('cd ~ && aidrian shell-init zsh --install');
  deny('bash -c "aidrian shell-init zsh --install"');
  deny('echo "$(aidrian shell-init zsh --uninstall)"');
  deny('echo "aidrian shell-init zsh --install" | bash');
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
