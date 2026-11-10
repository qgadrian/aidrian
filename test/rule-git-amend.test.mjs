import '../scripts/test-state.mjs';
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

test('denies the prefixes git takes for --amend, and allows the options that only start alike', () => {
  deny('git commit --am');
  deny('git commit --amen --no-edit');
  deny('git commit --amend=x');
  allow('git commit --all -m "fix: thing"');
  allow('git commit --allow-empty -m "chore: empty"');
  allow('git commit --author="A <a@example.com>" -m "fix: thing"');
  allow('git commit --a -m "fix: thing"');
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

test('denies amend inside a subshell, a brace group, if, while, and past a `!`', () => {
  deny('(git commit --amend)');
  deny('(cd /tmp/x && git commit --amend --no-edit)');
  deny('{ git commit --amend; }');
  deny('if git diff --cached --quiet; then :; else git commit --amend --no-edit; fi');
  deny('while true; do git commit --amend; done');
  deny('! git commit --amend');
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

test('denies amend inside a substitution that runs, and not in text a substitution only quotes', () => {
  deny('sha=$(git commit --amend --no-edit)');
  deny('echo `git commit --amend`');
  deny('cat <(git commit --amend --no-edit)');
  deny('cat <<EOF\n$(git commit --amend --no-edit)\nEOF');
  allow("echo '$(git commit --amend)'");
  allow("git commit -m \"$(cat <<'EOF'\nfix: a) the first\nnever `git commit --amend`\nEOF\n)\"");
});

test('fails open on dynamic invocations, and honors the human override', () => {
  allow('git commit $FLAGS');
  allow('git $SUBCOMMAND --amend');
  assert.equal(check('git commit --amend', { env: { AIDRIAN_ALLOW_GIT_AMEND: '1' } }), null);
  assert.match(check('git commit --amend', { env: ENV }), /new commit[\s\S]*AIDRIAN_ALLOW_GIT_AMEND=1/);
});

test('the deny names the exact replacement, and keeps the first sentence lessons group by', () => {
  const reason = check('git commit --amend --no-edit', { env: ENV });
  assert.ok(reason.startsWith('Blocked: `git commit --amend` rewrites the branch tip, and another agent working on this branch may already have built on it. '));
  assert.match(reason, /run `git commit -m "<subject>"`, a follow-up commit on the same branch/u);
  assert.match(reason, /squash merge folds it/u);
});
