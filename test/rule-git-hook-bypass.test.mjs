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

test('denies a core.hooksPath override in any letter case, through -c, --config-env, or the environment', () => {
  deny('git -c core.hookspath=/dev/null commit -m "fix: thing"');
  deny('git -c CORE.HooksPath=/dev/null push');
  deny('git -c "core.hooksPath=$EMPTY" commit -m "fix: thing"');
  deny('git --config-env core.hooksPath=HOOKS commit -m "fix: thing"');
  deny('git --config-env=Core.HooksPath=HOOKS push');
  deny(`GIT_CONFIG_PARAMETERS="'core.hooksPath'='/dev/null'" git commit -m "fix: thing"`);
  deny('env GIT_CONFIG_PARAMETERS="$P" git push');
  deny('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null git push');
  deny('env GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=CORE.HOOKSPATH GIT_CONFIG_VALUE_0=/dev/null git merge origin/main');
  allow('git -c user.name=x commit -m "fix: thing"');
  allow('git --config-env user.email=EMAIL commit -m "fix: thing"');
  allow('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.name GIT_CONFIG_VALUE_0=x git commit -m "fix: thing"');
  allow('GIT_CONFIG_PARAMETERS="$P" git status');
});

test('denies a git config that writes or unsets core.hooksPath, and allows reading it', () => {
  deny('git config core.hooksPath /dev/null');
  deny('git config --local core.hookspath ""');
  deny('git config --global CORE.HOOKSPATH /tmp/empty');
  deny('git config -f .git/config core.hooksPath /dev/null');
  deny('git config set core.hooksPath /dev/null');
  deny('git config unset core.hooksPath');
  deny('git config --unset core.hooksPath');
  deny('git config --unset-all core.hooksPath');
  deny('git config --add core.hooksPath /dev/null');
  deny('git config --rep core.hooksPath /dev/null');
  deny('cd /tmp/x && rtk git -C repo config core.hooksPath /dev/null');
  allow('git config core.hooksPath');
  allow('git config --get core.hooksPath');
  allow('git config --get core.hooksPath /dev/null');
  allow('git config get core.hooksPath');
  allow('git config --show-origin --get-regexp core.hookspath');
  allow('git config user.email a@example.com');
  allow('git config --file .gitconfig user.name x');
  allow('git config --list');
});

test('denies through rtk and in a later segment, including after a here-string', () => {
  deny('rtk git commit --no-verify -m "fix: thing"');
  deny('rtk proxy git push --no-verify');
  deny('cd /tmp/x && git commit --no-verify -m "fix: thing"');
  deny('git add -A; git push --no-verify');
  deny('read -r x <<<"$v"\ngit push --no-verify');
});

test('denies a bypass inside a subshell, a brace group, if, while, and past a `!`', () => {
  deny('(git commit --no-verify)');
  deny('(cd /tmp/x && git commit --no-verify -m "fix: thing")');
  deny('{ git push --no-verify; }');
  deny('if git diff --quiet; then git commit --no-verify -m x; fi');
  deny('while true; do git push -n; git commit -n; done');
  deny('! git commit --no-verify');
});

test('denies a bypass inside a substitution that runs, and not in a commit message that names one', () => {
  deny('out=$(git push --no-verify)');
  deny('echo "`git commit -n -m x`"');
  deny('x=$(git config core.hooksPath /dev/null)');
  deny('cat <(HUSKY=0 git push)');
  deny('x=$(cat <<EOF\nhi)\nEOF) && git push --no-verify');
  allow("git commit -m \"$(cat <<'EOF'\nfix: two cases: a) the first\nnever `git push --no-verify`\nEOF\n)\"");
  allow("x=$(cat <<'EOF'\na) note\ngit push --no-verify\nEOF\n)");
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
