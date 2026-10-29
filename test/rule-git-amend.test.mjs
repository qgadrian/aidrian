import assert from 'node:assert/strict';
import test from 'node:test';

import { check } from '../plugins/aidrian/lib/rules/git-amend.mjs';

const ENV = {};
const deny = (command) => assert.match(check(command, { env: ENV }) ?? '', /^Blocked/, `expected deny: ${command}`);
const allow = (command) => assert.equal(check(command, { env: ENV }), null, `expected allow: ${command}`);

test('denies git commit --amend, whatever the companion flags and their order', () => {
  deny('git commit --amend');
  deny('git commit --amend --no-edit');
  deny('git commit -a --amend');
  deny('git commit --amend -F -');
  deny('git commit --no-verify --amend -m "better message"');
});

test('denies amend behind git global options, the rtk proxy, and in a later segment', () => {
  deny('git -C /somewhere/else commit --amend');
  deny('git -c core.editor=true commit --amend --no-edit');
  deny('git --no-pager commit --amend');
  deny('rtk git commit --amend');
  deny('rtk proxy git commit --amend --no-edit');
  deny('cd /tmp/x && git commit --amend');
  deny('git add -A; git commit --amend --no-edit');
});

test('allows ordinary commits, --amend in message text or after --, and other subcommands', () => {
  allow('git commit -m "fix: something"');
  allow('git commit -m "revert the --amend change"');
  allow("git commit -m 'never use --amend here'");
  allow('git commit -m msg -- --amend');
  allow('git rebase -i HEAD~3');
  allow('git commit-tree abc123');
  allow('echo git commit --amend');
  allow('man git-commit');
  allow('cat <<EOF > /tmp/notes\ngit commit --amend\nEOF');
});

test('fails open on dynamic invocations, and honors the human override', () => {
  allow('git commit $FLAGS');
  allow('git $SUBCOMMAND --amend');
  assert.equal(check('git commit --amend', { env: { AIDRIAN_ALLOW_GIT_AMEND: '1' } }), null);
  assert.match(check('git commit --amend', { env: ENV }), /new commit[\s\S]*AIDRIAN_ALLOW_GIT_AMEND=1/);
});
