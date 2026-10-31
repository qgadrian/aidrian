import assert from 'node:assert/strict';
import test from 'node:test';

import { commandLines, lexCommand, lexInputs, lexPipeline, lexSteps, lexSubstitutions, readGit, readInvocation, readShortOptions } from '../plugins/aidrian/lib/shell-lex.mjs';

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

test('lexInputs gives each segment the heredoc bodies and here-strings it reads, the body to the segment that opened it', () => {
  const { segments, inputs } = lexInputs("python3 - <<'EOF' | tee out\nprint(1)\nEOF\ncat <<A <<<\"word\"\nbody a\nA\nls");
  assert.deepEqual(segments.map((segment) => segment[0].text), ['python3', 'tee', 'cat', 'ls']);
  assert.deepEqual(inputs, [['print(1)\n'], [], ['body a\n', 'word'], []]);
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

test('a substitution ends at its own `)`, not at one in quotes, a comment, or a heredoc body', () => {
  // A commit message with an unbalanced `)` and a code span: none of it reads as commands.
  const message = "git commit -m \"$(cat <<'EOF'\nfix: a) the first\nnever `git push --no-verify`\nEOF\n)\"";
  assert.deepEqual(lexSubstitutions(message), ["cat <<'EOF'\nfix: a) the first\nnever `git push --no-verify`\nEOF\n"]);
  assert.deepEqual(texts("x=$(cat <<'EOF'\na) note\ngit push\nEOF\n) && b"), [['x=$'], ['b']]);
  assert.deepEqual(lexSubstitutions('x=$(echo ")" \')\' \\) `echo )` "$(echo ")")") && b'), ['echo ")" \')\' \\) `echo )` "$(echo ")")"']);
  assert.deepEqual(lexSubstitutions('x=$(a # b)\n) && c'), ['a # b)\n'], 'a `)` in a comment is the comment`s');
  assert.deepEqual(texts('x=$(cat <<EOF\nhi)\nEOF) && b'), [['x=$'], ['b']], 'a delimiter followed by `)` ends the body there');
  assert.deepEqual(texts('x=$((1 + (2))) && b'), [['x=$'], ['b']]);
  assert.deepEqual(lexSubstitutions('x=$(cat <<<")"\necho hi\n) && b'), ['cat <<<")"\necho hi\n'], 'a here-string is no heredoc');
  assert.deepEqual(lexSubstitutions("x=$(cat <<'EOF'\nnever closed"), ["cat <<'EOF'\nnever closed"]);
});

test('commandLines lists the line, then every substitution that runs, nested ones included', () => {
  assert.deepEqual(commandLines('a $(b `c`) "$(d)" <(e)'), ['a $(b `c`) "$(d)" <(e)', 'b `c`', 'c', 'd', 'e']);
  assert.deepEqual(commandLines("a '$(b)' # $(c)"), ["a '$(b)' # $(c)"]);
  const deep = (depth) => (depth === 0 ? 'x' : `$(${deep(depth - 1)})`);
  assert.equal(commandLines(deep(6)).at(-1), 'x', 'six levels are read');
  assert.equal(commandLines(deep(7)).at(-1), '$(x)', 'and no more');
});

test('lexSteps gives each segment, in order, the substitutions that run as part of it', () => {
  const steps = (line) => lexSteps(line).map(({ segment, substitutions }) => [segment.map((token) => token.text).join(' '), substitutions]);
  assert.deepEqual(steps('a $(b); c "$(d)" <(e) && f'), [['a $', ['b']], ['c $(d) < (e)', ['d', 'e']], ['f', []]]);
  assert.deepEqual(steps('x=$(cd /tmp $(y)) | z'), [['x=$', ['cd /tmp $(y)']], ['z', []]], 'a nested one stays in its body');
  assert.deepEqual(steps('cat <<EOF; cd /tmp\n$(rm a)\nEOF'), [['cat', []], ['cd /tmp', ['rm a']]], 'a heredoc runs before the next segment');
  assert.deepEqual(steps('<<EOF\n$(rm a)\nEOF'), [['', ['rm a']]], 'one with no segment comes last, with an empty one');
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
  // A cluster of switches may end in an option that takes the next word, as getopt reads it.
  assert.equal(programOf('sudo -nu root rm x'), 'rm');
  assert.equal(programOf('sudo -nuroot rm x'), 'rm');
  assert.equal(programOf('timeout -vs KILL 5 rm x'), 'rm');
  assert.equal(programOf('exec -cla name rm x'), 'rm');
  assert.equal(programOf('env -iu LANG rm x'), 'rm');

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

test('readInvocation reads the command inside a subshell, a brace group, if, and while, and past a `!`', () => {
  const programs = (line) => lexCommand(line).map((segment) => readInvocation(segment).program);
  assert.equal(programOf('(git commit --amend)'), 'git', 'a subshell');
  assert.deepEqual(argsOf('(git commit --amend)'), ['commit', '--amend'], 'its `)` is no part of the last word');
  assert.deepEqual(argsOf('( git commit --amend )'), ['commit', '--amend']);
  assert.deepEqual(programs('(cd x && git commit --no-verify)'), ['cd', 'git']);
  assert.deepEqual(argsOf('git commit -m "fix (x)"'), ['commit', '-m', 'fix (x)'], 'a word keeps the `)` it opened');
  assert.deepEqual(programs('{ rm f; }'), ['rm', ''], 'a brace group');
  assert.deepEqual(programs('if test -f x; then git commit -n; elif y; then z; else rm f; fi'), ['test', 'git', 'y', 'z', 'rm', '']);
  assert.deepEqual(programs('while read -r f; do rm "$f"; done < list'), ['read', 'rm', '']);
  assert.deepEqual(programs('until x; do y; done'), ['x', 'y', '']);
  assert.equal(programOf('if ! grep -q x f; then y; fi'), 'grep', 'a `!` after a reserved word');
  assert.equal(readInvocation(lexCommand('if ! grep -q x f; then y; fi')[0]).negated, true);
  assert.equal(programOf('! (git commit --amend)'), 'git', 'a `!` before a subshell');
  assert.equal(programOf('echo done'), 'echo', 'a reserved word after the command is an argument');
});

test('env -S carries a command line, and its later words are that command`s arguments', () => {
  assert.equal(programOf("env -S 'rm /repo/package.json'"), 'rm');
  assert.deepEqual(argsOf("env -S 'rm' package.json"), ['package.json']);
  assert.deepEqual(argsOf('env --split-string="rm" package.json'), ['package.json']);
  assert.equal(programOf('env --split-string="rm /repo/package.json"'), 'rm');
  assert.equal(programOf('env -S "$CMD"'), '', 'a dynamic value names no program');
  assert.equal(programOf("env -S'rm /repo/package.json'"), 'rm', 'a value attached to -S');
  assert.deepEqual(argsOf("env -vS 'rm' package.json"), ['package.json'], 'and -S at the end of a cluster');
});

test('a wrapper that changes directory reports it, and nested changes compose', () => {
  const chdirOf = (line) => readInvocation(lexCommand(line)[0]).chdir?.text ?? null;
  assert.equal(chdirOf('env -C /src rm ../x'), '/src');
  assert.equal(chdirOf('env --chdir=/src rm ../x'), '/src');
  assert.equal(chdirOf('env -C/src rm ../x'), '/src');
  assert.equal(chdirOf('env -iC /src rm ../x'), '/src', 'at the end of a cluster');
  assert.equal(chdirOf('env -iC/src rm ../x'), '/src', 'attached inside a cluster');
  assert.equal(chdirOf('sudo -D /src rm ../x'), '/src');
  assert.equal(chdirOf('env -C src env -C lib rm ../../x'), 'src/lib');
  assert.equal(chdirOf('env -C src env -C /abs rm ../x'), '/abs', 'an absolute inner directory replaces the outer');
  assert.equal(chdirOf('env -C src --split-string="rm x"'), 'src', 'and composes with a command carried by -S');
  assert.equal(chdirOf('rm x'), null);
});

test('readShortOptions reads one word as getopt does: switches up to the option that takes a value', () => {
  const values = new Set(['-e', '-f']);
  assert.deepEqual(readShortOptions('-nE', values), { options: ['-n', '-E'], value: null });
  assert.deepEqual(readShortOptions('-es/a/b/', values), { options: ['-e'], value: { option: '-e', attached: 's/a/b/' } });
  assert.deepEqual(readShortOptions('-nf', values), { options: ['-n', '-f'], value: { option: '-f', attached: null } }, 'the next word');
  assert.deepEqual(readShortOptions('-ie', values, new Set(['-i'])), { options: ['-i'], value: { option: '-i', attached: 'e' } }, 'only the rest');
  assert.deepEqual(readShortOptions('-i', values, new Set(['-i'])), { options: ['-i'], value: { option: '-i', attached: '' } }, 'never the next word');
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

test('readInvocation reads the body of a function definition and the arm of a case, not their heads', () => {
  for (const line of ['f() { git push; }; f', 'f(){ git push; }', 'function f { git push; }', 'function f() { git push; }', 'f() (git push)']) {
    assert.ok(lexCommand(line).some((segment) => readInvocation(segment).program === 'git'), line);
  }
  for (const line of ['case x in x) git push;; esac', 'case x in (x) git push;; esac', 'case $a in x) echo; ;; y) git push;; esac']) {
    assert.ok(lexCommand(line).some((segment) => readInvocation(segment).program === 'git'), line);
  }
  assert.equal(programOf('(ls)'), 'ls)', 'a lone word stays the program');
});

test('>| writes the next word; >&word duplicates a descriptor only for digits or -, and otherwise writes the file', () => {
  const targets = (line) => lexCommand(line)[0].flatMap((token, i, segment) => (token.operator && segment[i + 1] && !segment[i + 1].fdDup ? [segment[i + 1].text] : []));
  assert.deepEqual(targets('echo x >| out'), ['out']);
  assert.deepEqual(targets('echo x >|out'), ['out']);
  assert.deepEqual(targets('echo x >&out'), ['out']);
  assert.deepEqual(targets('echo x >& out'), ['out']);
  assert.deepEqual(targets('echo x 2>&1 >&2 3>&- 4>&5-'), []);
  assert.deepEqual(argsOf('echo x >&out y'), ['x', 'y']);
});

test('readInvocation peels setsid, doas, flock, caffeinate, and coproc', () => {
  assert.equal(programOf('setsid -f git push'), 'git');
  assert.equal(programOf('doas -u root git push'), 'git');
  assert.equal(programOf('flock -w 5 /tmp/lock git push'), 'git');
  assert.equal(programOf('caffeinate -t 60 git push'), 'git');
  assert.equal(programOf('coproc git push'), 'git');
  assert.equal(programOf('coproc NAME { git push; }'), 'git');
  const shell = readInvocation(lexCommand("flock /tmp/lock -c 'git push'")[0]);
  assert.deepEqual([shell.program, ...shell.args.map((token) => token.text)], ['sh', '-c', 'git push'], 'flock -c runs a shell string');
});

test('readInvocation lists the environment changes of assignments and env, in order', () => {
  const changes = (line) => readInvocation(lexCommand(line)[0]).environment.map((change) => (change.clear ? 'clear' : `${change.name}=${change.value?.text ?? '<unset>'}`));
  assert.deepEqual(changes('A=1 env -u B -iu C D=2 gh'), ['A=1', 'B=<unset>', 'clear', 'C=<unset>', 'D=2']);
  assert.deepEqual(changes('env --ignore-env - --unset=E gh'), ['clear', 'clear', 'E=<unset>']);
  assert.deepEqual(changes("env -S 'F=3 gh' pr"), ['F=3']);
  assert.deepEqual(changes('G=4 exec -c gh'), ['G=4', 'clear']);
  assert.deepEqual(changes('G=4 exec -lca x gh'), ['G=4', 'clear']);
  assert.deepEqual(changes('G=4 exec -a c gh'), ['G=4']);
});
