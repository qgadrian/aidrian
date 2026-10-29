import assert from 'node:assert/strict';
import test from 'node:test';

import { lexCommand, lexPipeline, lexSubstitutions, readGit, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';

const texts = (line) => lexCommand(line).map((segment) => segment.map((token) => token.text));
const programOf = (line) => readInvocation(lexCommand(line)[0]).program;
const argsOf = (line) => readInvocation(lexCommand(line)[0]).args.map((token) => token.text);

test('quotes, escapes, and substitutions: text without quotes, and dynamic when it may expand', () => {
  assert.deepEqual(lexCommand(`echo 'a $b' "c d" e\\ f`), [[
    { text: 'echo', dynamic: false },
    { text: 'a $b', dynamic: false },
    { text: 'c d', dynamic: false },
    { text: 'e f', dynamic: false },
  ]]);
  assert.deepEqual(lexCommand('echo "$HOME" $(pwd) `id` *.md').flat().map((token) => token.dynamic), [false, true, true, true, true]);
  assert.deepEqual(texts('python3 -c "print(f\\"{x:>9}\\")"'), [['python3', '-c', 'print(f"{x:>9}")']], 'an escaped quote does not close');
});

test('lexPipeline records the operator that ended each segment, and a newline never eats a pending one', () => {
  assert.deepEqual(lexPipeline('a && b').separators, ['&&', null]);
  assert.deepEqual(lexPipeline('a | b').separators, ['|', null]);
  assert.deepEqual(lexPipeline('a ; b').separators, [';', null]);
  assert.deepEqual(lexPipeline('a || b').separators, ['||', null]);
  assert.deepEqual(lexPipeline('a |& b').separators, ['|&', null], "bash's `2>&1 |`, one operator");
  assert.deepEqual(lexPipeline('a & b').separators, ['&', null], 'and a bare & is still asynchronous');
  assert.deepEqual(lexPipeline('a |&\nb').separators, ['|&', null], 'a pipeline continues across a newline too');

  assert.deepEqual(lexCommand('echo hi # && rm -rf /'), [[{ text: 'echo', dynamic: false }, { text: 'hi', dynamic: false }]]);
  assert.deepEqual(lexPipeline('echo hi # && rm -rf /').separators, [null]);
  assert.equal(lexCommand('echo hi # a note\necho bye').length, 2, 'the comment ends at the line, not the command');
  assert.deepEqual(texts('cat file#1.txt'), [['cat', 'file#1.txt']], 'mid-word a # is an ordinary character');
  assert.deepEqual(texts("echo '# quoted'"), [['echo', '# quoted']]);

  assert.deepEqual(lexPipeline('a &\nb').separators, ['&', null], 'still backgrounded');
  assert.deepEqual(lexPipeline('a &\n').separators, ['&'], 'and at the very end');
  assert.deepEqual(lexPipeline('a ;\nb').separators, [';', null]);
  assert.deepEqual(lexPipeline('a &&\nb').separators, ['&&', null], 'a newline after an operator continues the line');
  assert.deepEqual(lexPipeline('a ||\n\nb').separators, ['||', null]);
  assert.deepEqual(lexPipeline('a |\nb').separators, ['|', null]);
  assert.deepEqual(lexPipeline('a\nb').separators, ['\n', null], 'a bare newline still ends the list');

  assert.deepEqual(lexPipeline('a &>/tmp/x').separators, [null], '&> redirects both streams; it never splits a list');
  assert.deepEqual(texts('a &>/tmp/x'), [['a', '&>', '/tmp/x']]);
  assert.deepEqual(texts('a &>>/tmp/x'), [['a', '&>>', '/tmp/x']]);
  assert.equal(readInvocation(lexCommand('a &>/tmp/x')[0]).args.length, 0, 'the target is not an argument');
});

test('redirections: an fd prefix belongs to the operator, and 2>&1 is a descriptor, not a path', () => {
  const [segment] = lexCommand('node build.mjs 2>&1 > out.txt');
  assert.deepEqual(segment.map((token) => token.text), ['node', 'build.mjs', '>', '&1', '>', 'out.txt']);
  assert.equal(segment[3].fdDup, true);
  assert.deepEqual(argsOf('node build.mjs 2>&1 > out.txt'), ['build.mjs']);
});

test('a heredoc body is data; the lines after it are commands', () => {
  assert.deepEqual(texts("cat > /tmp/out.md <<'EOF'\nrm -rf src\nEOF\ngit status"), [['cat', '>', '/tmp/out.md'], ['git', 'status']]);
  assert.deepEqual(texts('read -r x <<<"$v"\ngit push'), [['read', '-r', 'x', '<<<', '$v'], ['git', 'push']]);
  assert.deepEqual(texts("cat <<< 'x'\ngit push"), [['cat', '<<<', 'x'], ['git', 'push']]);
  assert.deepEqual(texts('cat <<<x\ncat <<EOF\nrm -rf /\nEOF\necho done'), [['cat', '<<<', 'x'], ['cat'], ['echo', 'done']]);
  assert.deepEqual(argsOf('grep -c a <<<"$v"'), ['-c', 'a'], 'a here-string word is not an argument');
});

test('lexSubstitutions returns the substitutions that run, and none that are only text', () => {
  assert.deepEqual(lexSubstitutions('echo $(a) `b` "$(c) `d`"'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(lexSubstitutions('x=$(a $(b))'), ['a $(b)'], 'a nested body is returned once, as the outer one');
  assert.deepEqual(lexSubstitutions('cat <<EOF\n$(a) `b`\nEOF'), ['a', 'b'], 'an unquoted heredoc expands');
  assert.deepEqual(lexSubstitutions("echo '$(a)' \\$(b) # $(c)"), [], 'single quotes, an escape and a comment do not');
  for (const delimiter of ["'EOF'", '"EOF"', '\\EOF', "E'O'F"]) {
    assert.deepEqual(lexSubstitutions(`cat <<${delimiter}\n$(a)\nEOF`), [], `<<${delimiter} does not expand`);
  }
  assert.deepEqual(lexSubstitutions('cat <<<"$(a)"\necho $(b)'), ['a', 'b'], 'a here-string expands, and the lines after it run');
  assert.deepEqual(lexSubstitutions("cat <<<'$(a)'"), [], 'a single-quoted here-string word is text');
  assert.deepEqual(lexSubstitutions('diff <(a) >(b)'), ['a', 'b'], 'a process substitution runs its body');
});

test('readInvocation peels the wrappers that return the wrapped command`s status', () => {
  assert.equal(programOf('command grep -c x f'), 'grep');
  assert.equal(programOf('env grep -c x f'), 'grep');
  assert.equal(programOf('env FOO=1 BAR=2 grep -c x f'), 'grep', 'assignments the wrapper carries');
  assert.equal(programOf('env -u LANG grep -c x f'), 'grep', 'a value-taking wrapper flag');
  assert.equal(programOf('env -i -- grep -c x f'), 'grep', 'an explicit end of flags');
  assert.equal(programOf('timeout 30 grep -c x f'), 'grep', 'timeout`s positional duration');
  assert.equal(programOf('nohup nice -n 10 grep -c x f'), 'grep', 'nested wrappers');
  assert.equal(programOf('sudo env command /usr/bin/grep -c x f'), 'grep', 'and a path at the end of them');
  assert.deepEqual(argsOf('command grep -c x f'), ['-c', 'x', 'f'], 'the wrapped command`s own arguments');
  assert.equal(programOf('rtk git status'), 'git', 'the rtk proxy');
  assert.equal(programOf('rtk proxy git status'), 'git');

  assert.equal(programOf('git commit -m hi'), 'git', 'an ordinary command is untouched');
  assert.equal(programOf('timeout grep -c x f'), '-c', 'the duration is taken by position');
  assert.equal(programOf('envsubst < in'), 'envsubst', 'a program whose name merely starts with env');

  // Option arity is per wrapper: `-i` takes a value for stdbuf and is a switch for env.
  assert.equal(programOf('env -i rm package.json'), 'rm');
  assert.equal(programOf('stdbuf -i 0 grep x f'), 'grep');
  assert.equal(programOf('stdbuf -i0 -oL grep x f'), 'grep', 'an attached value is one token');
  assert.equal(programOf('sudo -u root rm x'), 'rm');
  assert.equal(programOf('sudo -uroot rm x'), 'rm');

  assert.equal(programOf('! rm package.json'), 'rm');
  assert.equal(readInvocation(lexCommand('! rm package.json')[0]).negated, true);
  assert.equal(readInvocation(lexCommand('! env -i rm x')[0]).negated, true, 'ahead of the wrappers');
  assert.equal(readInvocation(lexCommand('rm package.json')[0]).negated, false);

  assert.equal(programOf('time rm package.json'), 'rm');
  assert.equal(programOf('time -p rm package.json'), 'rm');
  assert.equal(programOf('/usr/bin/time -o out rm x'), 'time', 'the external binary is not peeled');
  assert.equal(programOf('env - rm package.json'), 'rm', 'env`s bare dash implies -i');
  assert.equal(programOf('sudo -D /tmp rm package.json'), 'rm');
  assert.equal(programOf('sudo -h host rm package.json'), 'rm');
  for (const duration of ['30', '30s', '.5', '1.5', '1e2', '1E2', '1.5e-3', 'inf', 'infinity', '+1', '0x1p2']) {
    assert.equal(programOf(`timeout ${duration} rm package.json`), 'rm', duration);
  }

  assert.equal(programOf('builtin rm package.json'), 'builtin', 'builtin runs shell builtins only');
  assert.equal(programOf('exec rm package.json'), 'rm');
});

test('env -S carries a command line, and its later words are that command`s arguments', () => {
  assert.equal(programOf("env -S 'rm /repo/package.json'"), 'rm');
  assert.deepEqual(argsOf("env -S 'rm' package.json"), ['package.json']);
  assert.deepEqual(argsOf('env --split-string="rm" package.json'), ['package.json']);
  assert.equal(programOf('env --split-string="rm /repo/package.json"'), 'rm');
  assert.equal(programOf('env -S "$CMD"'), '', 'a dynamic value names no program');
});

test('a wrapper that changes directory reports it, and nested changes compose', () => {
  const chdirOf = (line) => readInvocation(lexCommand(line)[0]).chdir?.text ?? null;
  assert.equal(chdirOf('env -C /src rm ../x'), '/src');
  assert.equal(chdirOf('env --chdir=/src rm ../x'), '/src');
  assert.equal(chdirOf('env -C/src rm ../x'), '/src');
  assert.equal(chdirOf('sudo -D /src rm ../x'), '/src');
  assert.equal(chdirOf('env -C src env -C lib rm ../../x'), 'src/lib');
  assert.equal(chdirOf('env -C src env -C /abs rm ../x'), '/abs', 'an absolute inner directory replaces the outer');
  assert.equal(chdirOf('env -C src --split-string="rm x"'), 'src', 'and composes with a command carried by -S');
  assert.equal(chdirOf('rm x'), null);
});

test('readGit reads the subcommand past git`s global options, and gives up on a dynamic one', () => {
  const gitOf = (line) => readGit(lexCommand(line)[0]);
  assert.equal(gitOf('git -C /x -c a=b --no-pager commit -m x').subcommand, 'commit');
  assert.deepEqual(gitOf('git -c core.hooksPath=/dev/null push').globals.map((token) => token.text), ['-c', 'core.hooksPath=/dev/null']);
  assert.equal(gitOf('git --config-env core.hooksPath=VAR commit').subcommand, 'commit', '--config-env takes the next token');
  assert.deepEqual(gitOf('rtk proxy git commit --amend').rest.map((token) => token.text), ['--amend']);
  assert.equal(gitOf('git $SUB --amend'), null);
  assert.equal(gitOf('echo git commit'), null);
});
