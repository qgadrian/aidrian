import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asksForCount, check, pipefailToggle } from '../plugins/aidrian/lib/rules/grep-exit-chain.mjs';

// Ported from the source harness: the rule is narrow on purpose, a counting grep only where `&&` makes its status count.
const decideForCommand = (command, env) => {
  const reason = check(command, { env });
  return reason ? { decision: 'deny', reason } : { decision: 'allow' };
};
const decide = (command, env = {}) => decideForCommand(command, env).decision;

test('denies a counting grep that gates the rest of an && chain', () => {
  // The count is the answer, and a clean answer skips every check after it.
  assert.equal(decide('npm run typecheck && grep -c error /tmp/out.log && npm test'), 'deny');
  assert.equal(decide('grep -c TODO src/index.ts && echo done'), 'deny');
  assert.equal(decide('grep --count error build.log && npm run verify'), 'deny');
  assert.equal(decide('grep --cou error build.log && npm run verify'), 'deny', 'grep takes a prefix of --count');
  assert.equal(decide('grep --color error build.log && npm run verify'), 'allow');
  assert.equal(decide('rg -c "error" src && echo clean'), 'deny');
});

test('denies a counting grep that is the last link, whose status the caller reads', () => {
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log'), 'deny');
  assert.equal(decide('npm run lint && npm run typecheck && grep -rc TODO src'), 'deny');
});

test('sees the multiline spelling: a newline after && is a continuation, not a terminator', () => {
  // bash reads `grep -c foo file &&\n  npm test` as ONE gated list, so the
  // hazard is identical to the single-line form. The lexer used to let the
  // newline overwrite the pending `&&` and the hook allowed it.
  assert.equal(decide('grep -c error /tmp/out.log &&\nnpm test'), 'deny');
  assert.equal(decide('grep -c error /tmp/out.log &&\n\n  npm test'), 'deny', 'a blank line between does not end the list either');
  assert.equal(decide('npm run lint &&\ngrep -c error /tmp/out.log'), 'deny', 'and the grep as the gated last link');

  // The same continuation rule must not invent a gate where bash has none.
  assert.equal(decide('grep -c error /tmp/out.log\nnpm test'), 'allow', 'a plain newline still separates');
  assert.equal(decide('grep -c error /tmp/out.log ||\ntrue && npm test'), 'allow', '|| still neutralises across lines');
  assert.equal(decide('grep -c error /tmp/out.log |\nwc -l && npm test'), 'allow', 'a pipe still carries the status onward');
});

test('allows a counting grep whose exit status gates nothing', () => {
  assert.equal(decide('grep -c error /tmp/out.log'), 'allow', 'alone');
  assert.equal(decide('grep -c error /tmp/out.log; npm test'), 'allow', 'sequenced, not gated');
  assert.equal(decide('grep -c error /tmp/out.log || true && npm test'), 'allow', 'status neutralised');
  assert.equal(decide('grep -c error /tmp/out.log | tee counts.txt && npm test'), 'allow', 'piped onward');
  assert.equal(decide('npm test\ngrep -c error /tmp/out.log'), 'allow', 'separate lines');
});

test('under set -o pipefail a pipe no longer hides the grep`s status', () => {
  // pipefail makes the PIPELINE exit non-zero when any stage does, so a
  // succeeding `tee` stops covering for a zero-match grep and the `&&` after
  // the pipeline is skipped.
  assert.equal(decide('set -o pipefail; grep -c error log | tee counts && npm test'), 'deny');
  assert.equal(decide('set -euo pipefail\ngrep -c error log | tee counts && npm test'), 'deny', 'the option rides in a bundle');
  assert.equal(decide('set -o pipefail; npm test && grep -c error log | wc -l'), 'deny', 'and as the gated last pipeline');

  assert.equal(decide('grep -c error log | tee counts && npm test'), 'allow', 'without pipefail the pipe still neutralises');
  assert.equal(decide('set -o pipefail; set +o pipefail; grep -c error log | tee c && npm test'), 'allow', 'turned back off');
  assert.equal(decide('set -o pipefail; grep -c error log | tee c || true && npm test'), 'allow', '|| still neutralises the pipeline');
  assert.equal(decide('set -o pipefail\ngrep -c error log | wc -l'), 'allow', 'gating nothing');
});

test('a trailing terminator does not stop the grep from being the last link', () => {
  // bash returns the final grep`s status either way: nothing runs after a
  // trailing newline or `;`, so they end the list without adding a command.
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log\n'), 'deny');
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log ;'), 'deny');
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log ;\n'), 'deny');

  assert.equal(
    decide('npm run lint && grep -c error /tmp/out.log ; echo done'),
    'allow',
    'a `;` with a command after it really does separate: the grep gates nothing and echo`s status is what returns',
  );
});

test('pipefailToggle reads the shapes bash accepts, and only those', () => {
  const segment = (line) => line.split(' ').map((text) => ({ text, dynamic: false }));

  assert.equal(pipefailToggle(segment('set -o pipefail')), true);
  assert.equal(pipefailToggle(segment('set -eo pipefail')), true, 'bundled with -e');
  assert.equal(pipefailToggle(segment('set -euo pipefail')), true, 'the common three');
  assert.equal(pipefailToggle(segment('set +o pipefail')), false, 'turned off');

  assert.equal(pipefailToggle(segment('set -e')), null, 'another option entirely');
  assert.equal(pipefailToggle(segment('set -o errexit')), null, 'a different -o value');
  assert.equal(pipefailToggle(segment('npm run pipefail')), null, 'not a `set` at all');
  assert.equal(pipefailToggle(segment('set -o')), null, 'no value to read');
});

test('reads bash`s other pipeline spelling, `|&`, as a pipeline', () => {
  // `|&` is `2>&1 |`. Lexed one character at a time it used to end the
  // segment on `|` and then let the `&` overwrite that separator, so the
  // pipefail rule never saw a pipeline at all.
  assert.equal(decide('set -o pipefail; grep -c error log |& tee counts && npm test'), 'deny');
  assert.equal(decide('grep -c error log |& tee counts && npm test'), 'allow', 'still neutralising without pipefail');
});

test('allows a counting grep whose list is backgrounded', () => {
  // bash returns success for an asynchronous list the moment it starts it, so
  // the grep`s count reaches no caller and gates nothing.
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log &'), 'allow');
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log & echo next'), 'allow');

  // The `&` must not become a blanket exemption: here the whole AND-list is
  // backgrounded, and inside it the grep still gates `npm test`.
  assert.equal(decide('grep -c error /tmp/out.log && npm test &'), 'deny');
});

test('allows a grep that is not counting: its non-zero exit may be the intended gate', () => {
  assert.equal(decide('grep -q error /tmp/out.log && echo found'), 'allow');
  assert.equal(decide('grep error /tmp/out.log && echo found'), 'allow');
  assert.equal(decide('grep -rn TODO src && echo found'), 'allow');
  assert.equal(decide('grep -l error src/*.ts && echo found'), 'allow');
});

test('asksForCount reads bundles and value-taking flags the way grep does', () => {
  const args = (line) => line.split(' ').map((text) => ({ text, dynamic: false }));

  assert.equal(asksForCount(args('-c pattern file')), true);
  assert.equal(asksForCount(args('-rc pattern src')), true, 'bundled after another flag');
  assert.equal(asksForCount(args('--count pattern file')), true);
  assert.equal(asksForCount(args('--count-matches pattern src')), true, "ripgrep's per-match count");

  assert.equal(asksForCount(args('-e -c file')), false, '-e swallows the next token as the pattern');
  assert.equal(asksForCount(args('-n pattern file')), false);
  assert.equal(asksForCount(args('-- -c file')), false, 'after -- everything is a pattern or a path');
  assert.equal(asksForCount(args('-A3c pattern file')), false, "the bundle's tail is -A's value");
  assert.equal(asksForCount(args('-re -c file')), false, 'a bundle that ends in -e takes the next token');
  assert.equal(asksForCount(args('--max-count 2 pattern file')), false, 'a cap is not a count');
  assert.equal(asksForCount(args('--exclude-dir=node_modules -c p src')), true, 'a long flag with its own value');
});

test('a chain operator inside a shell comment is prose, not a chain', () => {
  assert.equal(decide('grep -c foo file # never chain this && echo done'), 'allow');
  assert.equal(decide('grep -c foo file   # && npm test'), 'allow');

  // The comment ends at the line, it does not swallow it.
  assert.equal(decide('grep -c foo file # a note\nnpm run lint && grep -c x f'), 'deny');
  assert.equal(decide('echo "# not a comment && here" && grep -c x f'), 'deny', 'quoted, so not a comment at all');
});

test('a pipefail toggle that may never run cannot switch pipefail off', () => {
  // bash skips `set +o pipefail` after a false test, so pipefail is still on
  // and the pipeline still carries the grep`s status. A lexer cannot evaluate
  // `false`, so the unknown resolves the safe way.
  assert.equal(
    decide('set -o pipefail; false && set +o pipefail; grep -c error log | tee counts && npm test'),
    'deny',
  );
  assert.equal(
    decide('set -o pipefail; set +o pipefail; grep -c error log | tee c && npm test'),
    'allow',
    'an unconditional toggle still turns it off',
  );
  assert.equal(
    decide('true && set -o pipefail; grep -c error log | tee c && npm test'),
    'deny',
    'and a conditional toggle may still turn it on',
  );
});

test('`&>` redirects, it does not background', () => {
  // `&>word` sends both streams to a file. Read one character at a time the
  // `&` used to end the segment first, so the grep looked backgrounded and
  // its `&&` looked like it gated nothing.
  assert.equal(decide('grep -c error log &>/tmp/count && npm test'), 'deny');
  assert.equal(decide('grep -c error log &>>/tmp/count && npm test'), 'deny', 'the appending form too');
});

test('a backgrounded list stays backgrounded across a trailing newline', () => {
  // Same class as the multiline `&&` case, mirrored: the empty run at the
  // newline used to overwrite the `&`, and the safe command was denied.
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log &'), 'allow');
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log &\n'), 'allow');
  assert.equal(decide('npm run lint && grep -c error /tmp/out.log &\n\n'), 'allow');
});

test('sees a counting grep through a transparent wrapper', () => {
  // `command`, `env` and friends run what follows and return ITS status, so
  // the hazard is identical to the bare spelling.
  assert.equal(decide('command grep -c error log && npm test'), 'deny');
  assert.equal(decide('env grep -c error log && npm test'), 'deny');
  assert.equal(decide('env FOO=1 grep -c error log && npm test'), 'deny', 'with an assignment');
  assert.equal(decide('env -u LANG grep -c error log && npm test'), 'deny', 'with a value-taking flag');
  assert.equal(decide('timeout 30 grep -c error log && npm test'), 'deny', 'timeout`s positional duration');
  assert.equal(decide('timeout --signal=TERM 1.5s grep -c error log && npm test'), 'deny');
  assert.equal(decide('sudo env command grep -c error log && npm test'), 'deny', 'nested');

  assert.equal(decide('env npm test && echo ok'), 'allow', 'the wrapper alone is not a grep');
});

test('--color does not eat the counting flag', () => {
  // GNU grep documents `--color[=WHEN]`: the value is optional and attached,
  // so a separate `-c` is the count. Treating the option as value-taking
  // swallowed it.
  assert.equal(decide('grep --color -c NOMATCH file && npm test'), 'deny');
  assert.equal(decide('grep --color=always -c pat file && npm test'), 'deny');
  assert.equal(decide('rg --color never -c pat src && npm test'), 'deny', 'ripgrep separates the value; the count still counts');
});

test('a negated pipeline inverts the hazard, so it is allowed', () => {
  // `!` flips the status before `&&` reads it: a zero count becomes success
  // and the next command RUNS. Verified against bash 5.2 by the reviewer:
  // `set -o pipefail; ! printf x | grep -c z && printf NEXT` prints NEXT.
  assert.equal(decide('set -o pipefail; ! printf x | grep -c z && printf NEXT'), 'allow');
  assert.equal(decide('! grep -c error log && npm test'), 'allow');

  assert.equal(
    decide('set -o pipefail; printf x | grep -c z && printf NEXT'),
    'deny',
    'the same pipeline without the negation is the original hazard',
  );
});

test('env`s bare -i is not a value-taking flag', () => {
  // `-i` takes a value for stdbuf and is a switch for env. A shared table got
  // that wrong and skipped the program itself.
  assert.equal(decide('env -i grep -c NOMATCH file && npm test'), 'deny');
  assert.equal(decide('stdbuf -i 0 grep -c NOMATCH file && npm test'), 'deny', 'and stdbuf`s -i still takes one');
});

test('only a toggle that runs in the parent shell may turn pipefail off', () => {
  // A `set +o` inside a pipeline or backgrounded runs in a CHILD and cannot
  // change the parent's options, so pipefail is still on and the hazard live.
  assert.equal(
    decide('set -o pipefail; set +o pipefail | cat; grep -c NOMATCH /dev/null | tee /tmp/count && npm test'),
    'deny',
  );
  assert.equal(
    decide('set -o pipefail; set +o pipefail & grep -c NOMATCH /dev/null | tee /tmp/c && npm test'),
    'deny',
    'backgrounded is a child too',
  );
  assert.equal(
    decide('set -o pipefail; set +o pipefail; grep -c e log | tee c && npm test'),
    'allow',
    'a plain foreground toggle still turns it off',
  );
});

test('sees a counting grep past the remaining wrapper spellings', () => {
  assert.equal(decide('env - grep -c NOMATCH file && npm test'), 'deny', 'env`s bare dash switch');
  assert.equal(decide('timeout .5 grep -c NOMATCH file && npm test'), 'deny', 'a leading-decimal duration');
  assert.equal(decide('sudo -D /tmp grep -c NOMATCH file && npm test'), 'deny', 'sudo`s chdir operand');
  assert.equal(decide('sudo -h host grep -c NOMATCH file && npm test'), 'deny', 'sudo`s host operand');
});

test('sees the grep through env -S and every timeout duration', () => {
  assert.equal(decide("env -S 'grep -c NOMATCH /dev/null' && npm test"), 'deny');
  assert.equal(decide('timeout 1e2 grep -c NOMATCH file && npm test'), 'deny');
  assert.equal(decide('timeout inf grep -c NOMATCH file && npm test'), 'deny');
});

test('the wrapper corrections reach this hook too', () => {
  assert.equal(decide("env -S 'grep' -c NOMATCH /dev/null && npm test"), 'deny', 'arguments after the carried command');
  assert.equal(decide('timeout +1 grep -c NOMATCH file && npm test'), 'deny');
  assert.equal(decide('timeout 0x1p2 grep -c NOMATCH file && npm test'), 'deny');

  // `builtin grep` runs no grep at all, so denying it was a false positive.
  assert.equal(decide('builtin grep -c NOMATCH f && npm test'), 'allow');
});

test('judges a substitution that runs as a list of its own', () => {
  assert.equal(decide('echo "$(grep -c error build.log && npm test)"'), 'deny');
  assert.equal(decide('x=`npm run lint && grep -c error build.log`'), 'deny');
  assert.equal(decide('cat <(grep -c error build.log && npm test)'), 'deny');
  assert.equal(decide('n=$(grep -c error build.log || true); echo "$n"'), 'allow');
  assert.equal(decide("echo '$(grep -c error build.log && npm test)'"), 'allow');
});

test('fails open on what a lexer cannot resolve', () => {
  assert.equal(decide('grep $FLAGS error log && npm test'), 'allow', 'the flags are dynamic');
  assert.equal(decide(''), 'allow');
  assert.equal(
    decide("cat <<'EOF' && npm test\ngrep -c error log && echo hi\nEOF"),
    'allow',
    'a heredoc body is data, not a command',
  );
  assert.equal(decide('echo "grep -c error log && npm test"'), 'allow', 'quoted text is not a command');
});

test('the human override releases the whole session', () => {
  const command = 'grep -c error /tmp/out.log && npm test';
  assert.equal(decide(command), 'deny');
  assert.equal(decide(command, { AIDRIAN_ALLOW_GREP_EXIT_CHAIN: '1' }), 'allow');
  assert.equal(decide(command, { AIDRIAN_ALLOW_GREP_EXIT_CHAIN: 'yes' }), 'deny', 'only the exact 1');
});

test('the deny text names the command and every way out', () => {
  const { reason } = decideForCommand('grep -c error /tmp/out.log && npm test', {});
  assert.match(reason, /grep -c error \/tmp\/out\.log && npm test/, 'the reader sees which command');
  assert.match(reason, /\|\| true/, 'the in-place fix');
  assert.match(reason, /grep -q/, 'the right tool when the intent is presence');
  assert.match(reason, /AIDRIAN_ALLOW_GREP_EXIT_CHAIN=1/, 'the escape hatch');
});
