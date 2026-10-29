import assert from 'node:assert/strict';
import test from 'node:test';

import { check, REASON } from '../plugins/aidrian/lib/rules/git-hook-bypass.mjs';

const deny = (command) => assert.equal(check(command), REASON, `expected deny: ${command}`);
const allow = (command) => assert.equal(check(command), null, `expected allow: ${command}`);

test('denies --no-verify on every subcommand that runs a hook, and -n on commit, alone or bundled', () => {
  deny('git commit --no-verify -m "fix: thing"');
  deny('git push --no-verify');
  deny('git merge --no-verify origin/main');
  deny('git commit -n -m "fix: thing"');
  deny('git commit -an -m "fix: thing"');
  deny('git commit -nm "fix: thing"');
});

test('denies the prefixes git takes for --no-verify, and allows other --no- options', () => {
  deny('git commit --no-veri -m "fix: thing"');
  deny('git commit -a --no-verif -m "fix: thing"');
  deny('git push --no-veri');
  deny('git push --no-verif origin HEAD');
  deny('git merge --no-veri origin/main');
  allow('git commit --no-edit -m "fix: thing"');
  allow('git commit --no-ver -m "fix: thing"');
  allow('git commit --verify -m "fix: thing"');
  allow('git push --no-thin origin HEAD');
  allow('git merge --no-ff --no-verify-signatures origin/main');
});

test('-n is --dry-run on push and --no-stat on merge, and a flag value is not a flag', () => {
  allow('git push -n origin HEAD');
  allow('git merge -n origin/main');
  allow('git commit -m "-n"');
  allow('git commit -m "--no-verify"');
  allow('git commit -F - -m "-an"');
  allow('git commit -t /tmp/-n');
  allow('git commit -m "fix" -- --no-verify');
});

test('denies the core.hooksPath override in both spellings, and HUSKY turned off', () => {
  deny('git -c core.hooksPath=/dev/null commit -m "fix: thing"');
  deny('git -ccore.hooksPath=/dev/null push');
  deny('git -c core.hooksPath=/tmp/empty merge origin/main');
  deny('HUSKY=0 git commit -m "fix: thing"');
  deny('HUSKY=false git push');
  deny('HUSKY= git commit -m "fix: thing"');
  allow('HUSKY=1 git commit -m "fix: thing"');
});

test('denies through rtk and in a later segment, including after a here-string', () => {
  deny('rtk git commit --no-verify -m "fix: thing"');
  deny('rtk proxy git push --no-verify');
  deny('cd /tmp/x && git commit --no-verify -m "fix: thing"');
  deny('git add -A; git push --no-verify');
  deny('read -r x <<<"$v"\ngit push --no-verify');
});

test('allows ordinary git work and fails open on what it cannot read', () => {
  allow('git commit -am "fix: something"');
  allow('git push -u origin my-branch');
  allow('git log --no-verify-signatures');
  allow('npm run test -- --no-verify');
  allow('git commit $FLAGS -m "fix: thing"');
  allow('git $SUBCOMMAND --no-verify');
  allow('git commit -m "unterminated');
});

test('the reason offers no override', () => {
  assert.match(REASON, /no agent-side override/);
  assert.doesNotMatch(REASON, /AIDRIAN_ALLOW/);
});
