import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { check, OVERRIDE_REASON, REQUEST_REASON } from '../plugins/aidrian/lib/rules/github/review-rounds.mjs';

// A git repository holding a project folder with `config`.
function repo(t, config = { version: 1 }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-rounds-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return { dir, run: (command) => check(command, { cwd: dir, env: {} }), write: (name, text) => writeFileSync(path.join(dir, name), text) };
}

test('an agent cannot set the extra-rounds override, in any way the shell takes it', (t) => {
  const { run } = repo(t);
  for (const command of [
    'AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 9 --request --max-rounds 12',
    'env AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 9',
    'export AIDRIAN_ALLOW_EXTRA_ROUNDS=1',
    'export AIDRIAN_ALLOW_EXTRA_ROUNDS',
    'declare -x AIDRIAN_ALLOW_EXTRA_ROUNDS=1',
    'cd x && AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 9',
    'echo $(AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 9)',
  ]) assert.equal(run(command), OVERRIDE_REASON, command);
  assert.equal(run('unset AIDRIAN_ALLOW_EXTRA_ROUNDS'), null);
  assert.equal(run('env -u AIDRIAN_ALLOW_EXTRA_ROUNDS aidrian pr review 9'), null);
  assert.equal(run('echo "$AIDRIAN_ALLOW_EXTRA_ROUNDS"'), null, 'reading it is fine');
  assert.equal(run('aidrian pr await-review 9 --request'), null);
});

test('a direct bot review request is refused; the counted commands are not', (t) => {
  const { run, write } = repo(t);
  write('req.md', '@codex review\n');
  for (const command of [
    'gh pr comment 9 --body "@codex review"',
    'gh issue comment 9 --body-file req.md',
    "gh pr review 9 --comment -b '@codex review'",
    "gh api repos/acme/notes/issues/9/comments -f body='@codex review'",
    'gh pr edit 9 --add-reviewer chatgpt-codex-connector',
  ]) assert.equal(run(command), REQUEST_REASON, command);
  assert.equal(run('gh pr comment 9 --body "Thanks, fixed in abc123."'), null);
  assert.equal(run('gh pr comment 9 --body "`@codex review` is the trigger"'), null, 'a quote is no request');
  assert.equal(run('aidrian pr review 9 --with-bot'), null);
});

test('without a review bot, or outside a project, the rule is off', (t) => {
  for (const reviewer of [null, 'none']) {
    const { run } = repo(t, { version: 1, github: { reviewer } });
    assert.equal(run('gh pr comment 9 --body "@codex review"'), null);
    assert.equal(run('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr review 9'), null);
  }
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-rounds-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  assert.equal(check('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 x', { cwd: bare, env: {} }), null);
});
