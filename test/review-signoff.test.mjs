import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/review-signoff.mjs';

function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signoff-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return dir;
}

test('an agent cannot sign off a flow, however it runs aidrian', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian pr signoff 9 --flow harness-config --head abc1234',
    '/usr/local/bin/aidrian pr signoff 9 --flow x --head abc1234',
    'node plugins/aidrian/lib/cli.mjs pr signoff 9 --flow x --head abc1234',
    'node "$CLAUDE_PLUGIN_ROOT/bin/aidrian" pr signoff 9',
    'cd x && aidrian pr signoff 9',
    'echo $(aidrian pr signoff 9)',
    'env FOO=1 aidrian pr signoff 9',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  for (const command of ['aidrian pr review 9', 'aidrian pr attest 9 --check', 'echo "aidrian pr signoff 9"', 'grep signoff docs/review.md', 'node other.mjs pr signoff']) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('a sign-off inside a shell wrapper is denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'bash -c "aidrian pr signoff 9"',
    "sh -c 'aidrian pr signoff 9'",
    'zsh -lc "aidrian pr signoff 9"',
    'eval "aidrian pr signoff 9"',
    'eval -- "aidrian pr signoff 9"',
    'bash -c "eval \'aidrian pr signoff 9\'"',
    "bash <<'EOF'\naidrian pr signoff 9\nEOF",
    'bash <<< "aidrian pr signoff 9"',
    'echo "aidrian pr signoff 9" | bash',
  ]) assert.equal(check(command, { cwd }), REASON, command);
  for (const command of ['bash -c "aidrian pr review 9"', 'eval "echo pr signoff"', 'echo "pr signoff" | grep signoff', "cat <<'EOF'\naidrian pr signoff 9\nEOF"]) {
    assert.equal(check(command, { cwd }), null, command);
  }
});

test('an agent may dry-run a sign-off with --check, and every other sign-off is still denied', (t) => {
  const cwd = project(t);
  for (const command of [
    'aidrian pr signoff 9 --flow look --head abc1234 --check',
    'aidrian pr signoff 9 --flow look --accept matches-design --evidence https://github.com/o/r/pull/9#issuecomment-1 --reason "approved" --head abc1234 --check',
    'node plugins/aidrian/lib/cli.mjs pr signoff 9 --check --stage independent --head abc1234',
    'bash -c "aidrian pr signoff 9 --flow x --head abc1234 --check"',
  ]) assert.equal(check(command, { cwd }), null, command);
  for (const command of [
    'aidrian pr signoff 9 --flow look --accept matches-design --evidence https://x --reason "y" --head abc1234',
    'aidrian pr signoff 9 --flow x --head abc1234 --check-in',
    'aidrian pr signoff 9 --flow x --head abc1234 --check && aidrian pr signoff 9 --flow x --head abc1234',
    'echo "aidrian pr signoff 9 --check" | bash',
  ]) assert.equal(check(command, { cwd }), REASON, command);
});

test('outside a project the rule is off', (t) => {
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-signoff-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('aidrian pr signoff 9', { cwd: bare }), null);
});
