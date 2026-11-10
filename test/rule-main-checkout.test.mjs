import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { findProject, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { bashTargets, bashWrites, canonical, check, checkTool } from '../plugins/aidrian/lib/rules/main-checkout.mjs';

// The hooks this file runs record their blocks in the state folder; keep those rows out of the real one.
process.env.XDG_STATE_HOME = mkdtempSync(path.join(tmpdir(), 'aidrian-state-'));
after(() => rmSync(process.env.XDG_STATE_HOME, { recursive: true, force: true }));

const SCRIPTS = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts');
const ENV = {};

// A repository whose project folder turns the guard on, with a tracked src/app.js, an ignored build/, a worktree inside
// it (wt/task, ignored), one beside it, and one inside it that git does not ignore (open/task).
function fixture(t, config = { version: 1, git: { mainCheckout: { guard: true } } }) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-guard-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  mkdirSync(path.join(repo, '.aidrian'));
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(path.join(repo, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(repo, '.gitignore'), 'build/\nwt/\n');
  writeFileSync(path.join(repo, 'src/app.js'), 'export {};\n');
  git('add', '.');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  git('worktree', 'add', '-q', '-b', 'task', path.join(repo, 'wt/task'));
  git('worktree', 'add', '-q', '-b', 'beside', path.join(base, 'beside'));
  git('worktree', 'add', '-q', '-b', 'open', path.join(repo, 'open/task'));
  return { base, repo };
}

const edit = (file, cwd, tool = 'Edit') => checkTool({ tool_name: tool, tool_input: { file_path: file }, cwd }, { env: ENV });

test('a tracked or new file in the main checkout is denied, with the worktree command, the config key, and the override', (t) => {
  const { repo } = fixture(t);
  const reason = edit(path.join(repo, 'src/app.js'), repo);
  assert.match(reason, /^Blocked: this writes 'src\/app\.js', a tracked file in the main checkout \(/);
  assert.match(reason, /`aidrian worktree new <branch>` creates one in \S+\/repo\/\.worktrees /);
  assert.match(reason, /"git": \{ "mainCheckout": \{ "guard": true \} \} in \S+\/\.aidrian\/config\.json/);
  assert.match(reason, /AIDRIAN_ALLOW_MAIN_WRITE=1/);
  assert.match(edit('src/new/file.js', repo, 'Write'), /'src\/new\/file\.js'/, 'a relative path resolves against cwd');
  assert.match(checkTool({ tool_name: 'NotebookEdit', tool_input: { notebook_path: path.join(repo, 'n.ipynb') }, cwd: repo }, { env: ENV }), /'n\.ipynb'/);
});

test('ignored paths, worktrees inside or beside the repository, and paths outside it are allowed', (t) => {
  const { base, repo } = fixture(t);
  assert.equal(edit(path.join(repo, 'build/out.js'), repo), null);
  assert.equal(edit(path.join(repo, 'wt/task/src/app.js'), repo), null);
  assert.equal(edit('src/app.js', path.join(repo, 'wt/task')), null, 'a session in the worktree');
  assert.equal(edit(path.join(base, 'beside/src/app.js'), repo), null);
  assert.equal(edit(path.join(repo, 'open/task/src/app.js'), repo), null, 'a worktree git does not ignore');
  assert.equal(edit(path.join(tmpdir(), 'scratch.txt'), repo), null);
});

test('a write to the home folder through ~ is not a write in the main checkout', (t) => {
  const { repo } = fixture(t);
  const at = (command) => check(command, { cwd: repo, env: ENV });
  for (const command of ['echo x > ~/p.txt', 'echo x >> ~/.cache/p', 'tee ~/p.txt', 'cp src/app.js ~/p.txt', 'mkdir -p ~/p', 'rm -f ~/p.txt', 'echo x > ~', 'cd /tmp && touch ~/p', 'cd /tmp && rm ~/*.txt']) {
    assert.equal(at(command), null, command);
  }
  for (const command of ['cp src/app.js -t ~/d', 'cp src/app.js --target-directory ~/d', 'dd if=a of=/tmp/x', "perl -i.bak -pe 's/a/b/' ~/p.txt", "ruby -C /tmp -i -pe 'x' ~/p.txt"]) {
    assert.equal(at(command), null, command);
  }
  // A `~` inside a word is literal, even when the rule cuts it out as a target, and a cd to ~ still leaves later relative writes denied.
  for (const command of ['touch a~/p.txt', 'touch ~other/p.txt', 'cd ~ && echo x > a.txt', 'cp src/app.js -t~/d', 'cp src/app.js -ft~/d', 'cp src/app.js --target-directory=~/d', 'cp src/app.js --target=~/d', 'mv src/app.js -t~/d', 'dd if=a of=~/x', "perl -i'~/*' -pe 's/a/b/' /tmp/a.txt", "perl -i'~/backup/*' -pe x ~/p.txt", "perl -i'old/*' -pe x ~/p.txt"]) assert.match(at(command), /^Blocked/u, command);
});

test('in a repository whose git folder is separate, the main checkout is still guarded', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-guard-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'meta.git'), repo]);
  mkdirSync(path.join(repo, '.aidrian'));
  writeFileSync(path.join(repo, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  writeFileSync(path.join(repo, 'app.js'), 'export {};\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  const identity = ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false'];
  execFileSync('git', ['-C', repo, ...identity, 'commit', '-q', '-m', 'init']);
  assert.match(edit(path.join(repo, 'app.js'), repo), /^Blocked: this writes 'app\.js', a tracked file in the main checkout \(/);
  assert.match(check('echo x > app.js', { cwd: repo, env: ENV }), /'app\.js'/);
});

test('allowWrites globs, the guard off by default or by config, the override, and no project folder allow the write', (t) => {
  const globs = fixture(t, { version: 1, git: { mainCheckout: { guard: true, allowWrites: ['notes/**', 'docs/*.md', '**/*.snap'] } } }).repo;
  assert.equal(edit(path.join(globs, 'notes/a/b.md'), globs), null);
  assert.equal(edit(path.join(globs, 'docs/x.md'), globs), null);
  assert.equal(edit(path.join(globs, 'src/__snapshots__/a.snap'), globs), null);
  assert.match(edit(path.join(globs, 'docs/sub/x.md'), globs), /'docs\/sub\/x\.md'/, '* stays in one segment');

  for (const config of [{ version: 1 }, { version: 1, git: { mainCheckout: { guard: false } } }]) {
    const off = fixture(t, config).repo;
    assert.equal(edit(path.join(off, 'src/app.js'), off), null, JSON.stringify(config));
  }

  const { repo } = fixture(t);
  assert.equal(checkTool({ tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/app.js') }, cwd: repo }, { env: { AIDRIAN_ALLOW_MAIN_WRITE: '1' } }), null);
  rmSync(path.join(repo, '.aidrian'), { recursive: true });
  assert.equal(edit(path.join(repo, 'src/app.js'), repo), null);
});

test('apply_patch: every Add, Update, Delete, and Move target is checked', (t) => {
  const { repo } = fixture(t);
  const patch = (body) => checkTool({ tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch` }, cwd: repo }, { env: ENV });
  assert.match(patch('*** Update File: src/app.js\n@@\n-a\n+b'), /'src\/app\.js'/);
  assert.match(patch('*** Add File: build/x.js\n+x\n*** Delete File: src/old.js'), /'src\/old\.js'/);
  assert.match(patch('*** Update File: build/a.js\n*** Move to: src/b.js'), /'src\/b\.js'/);
  assert.equal(patch('*** Add File: build/x.js\n+x'), null);
});

test('bashTargets finds the certain write targets, resolved against cwd, and nothing else', () => {
  const at = (command) => bashTargets(command, '/repo').map((file) => path.relative('/repo', file));
  assert.deepEqual(at('echo hi > src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('echo hi >> src/a.ts 2>&1'), ['src/a.ts']);
  assert.deepEqual(at('node build.mjs &> out.log'), ['out.log']);
  assert.deepEqual(at("sed -i 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("perl -pi -e 's/a/b/' src/a.ts src/b.ts"), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(at("perl -i.bak -pe 's/a/b/' src/a.ts"), ['src/a.ts', 'src/a.ts.bak']);
  assert.deepEqual(at("perl -0777 -i -pe 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("perl -Mstrict -pi -e 's/a/b/' src/a.ts"), ['src/a.ts'], '-M takes only the rest of its word');
  assert.deepEqual(at("perl -I lib -i -pe 's/a/b/' src/a.ts"), ['src/a.ts'], '-I takes the next word');
  assert.deepEqual(at("perl -i -e 's/a/b/' -- src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at('perl -pie script.pl src/a.ts'), ['src/a.ts', 'src/a.tse'], '-pie is -i with the suffix e, then a script file');
  assert.deepEqual(at('perl -i script.pl src/a.ts'), ['src/a.ts'], 'without -e the first operand is the script');
  assert.deepEqual(at("perl -ne 'print' src/a.ts"), [], 'without -i perl only reads');
  assert.deepEqual(at("ruby -rjson -i -pe 'sub(/a/, \"b\")' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("ruby -ne 'print' src/a.ts"), []);
  assert.deepEqual(at("perl -lpi -e 's/a/b/' src/a.ts"), ['src/a.ts'], '-l takes only digits');
  assert.deepEqual(at("ruby -Cnested -pi -e 'x' file"), ['nested/file'], 'ruby -C moves the files');
  assert.deepEqual(at('ruby script.rb -i file'), [], "a script's own -i is not ruby's");
  assert.deepEqual(at("ruby -W0pi -e 'x' file"), ['file'], 'ruby -W takes a level');
  assert.deepEqual(at("ruby -Kupi -e 'x' file"), ['file'], 'ruby -K takes one letter');
  assert.deepEqual(at("ruby -KEpi -e 'x' file"), ['file']);
  assert.deepEqual(at("perl -i.bak -pe 'x' file"), ['file', 'file.bak'], 'a suffix writes a backup');
  assert.deepEqual(at("perl -i'../main/*' -pe 'x' file"), ['file', '../main/file'], 'a * suffix names the backup');
  assert.deepEqual(at("perl -i'../main/*' -pe 'x' src/file"), ['src/file', '../main/src/file'], 'perl puts the whole operand in place of *');
  assert.deepEqual(at("ruby -i'*' -pe 'x' src/file"), ['src/file', 'src/file*'], 'ruby appends even a *');
  assert.deepEqual(at("ruby -i.orig -pe 'x' src/a.rb"), ['src/a.rb', 'src/a.rb.orig']);
  assert.deepEqual(at("ruby --disable gems -pi -e 'x' file"), ['file']);
  assert.deepEqual(at("ruby --disable=gems -pi -e 'x' file"), ['file']);
  assert.deepEqual(at("perl -dpi -e 'x' file"), ['file'], 'perl -d takes only t and :MOD');
  assert.deepEqual(at("perl -d:Trace -pi -e 'x' file"), ['file']);
  assert.deepEqual(at("ruby --encoding utf-8 -pi -e 'x' file"), ['file'], 'a long option takes the next word');
  assert.deepEqual(at("ruby -C one -C two -pi -e 'x' file"), ['one/two/file'], 'folder changes compose');
  assert.deepEqual(at('perl -xone -xtwo -pi script.pl file'), ['two/file'], 'perl keeps its last -x');
  assert.deepEqual(at('perl -xmain -x -pi script.pl file'), ['main/file'], 'a bare -x keeps the folder');
  assert.deepEqual(at("perl -c -pi -e 'x' file"), [], '-c only checks syntax');
  assert.deepEqual(at("ruby -c -pi -e 'x' file"), []);
  assert.deepEqual(at('perl script.pl -i file'), []);
  assert.deepEqual(at("perl -F'i' -ane 'print' file"), [], '-F takes the rest of its word');
  assert.deepEqual(at("ruby -r json -pi -e 'x' file"), ['file'], '-r takes the next word');
  assert.deepEqual(at("ruby -E utf-8 -pi -e 'x' file"), ['file']);
  assert.deepEqual(at("ruby -C nested -pi -e 'x' file"), ['nested/file']);
  assert.deepEqual(at('perl -xsub -i script.pl file'), ['sub/file'], 'perl -x with a folder');
  assert.deepEqual(at("ruby -C nested -pi -e 'x' /abs/file"), ['../abs/file'], 'an absolute file stays');
  assert.deepEqual(at("perl -0pi -e 's/a/b/' src/a.ts"), ['src/a.ts'], '-0 takes only digits');
  assert.deepEqual(at("perl -0777pi -e 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("perl -l012pi -e 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("ruby -0pi -e 'sub(/a/, \\\"b\\\")' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("sed -i '' -e 's/a/b/' src/a.ts"), ['src/a.ts'], 'BSD sed`s empty suffix');
  assert.deepEqual(at("sed -n 's/a/b/p' src/a.ts"), [], 'sed without -i only prints');
  assert.deepEqual(at("sed --i 's/a/b/' src/a.ts"), ['src/a.ts'], 'GNU sed takes a prefix of --in-place');
  assert.deepEqual(at('sed --in-pl=.bak --expr=s/a/b/ src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('sed --i --fi script.sed src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at("sed -i -e's/a/b/' src/a.ts"), ['src/a.ts'], 'a script attached to -e');
  assert.deepEqual(at('sed -i -fscript.sed src/a.ts'), ['src/a.ts'], 'a script file attached to -f');
  assert.deepEqual(at("sed -Ee 's/a/b/' -i src/a.ts"), ['src/a.ts'], 'a cluster that ends in -e takes the next word');
  assert.deepEqual(at("sed -ie 's/a/b/' src/a.ts"), ['src/a.ts'], '-i takes the rest of its word as the suffix');
  assert.deepEqual(at("sed -il 's/a/b/' src/a.ts"), ['src/a.ts']);
  assert.deepEqual(at("sed -i -l 's/a/b/' src/a.ts"), ['src/a.ts'], 'BSD sed`s -l takes no value');
  assert.deepEqual(at("sed -I '' 's/a/b/' src/a.ts"), ['src/a.ts'], 'BSD sed`s -I edits in place');
  assert.deepEqual(at('tee -a src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(at('cp /tmp/a.ts src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('mv -f src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts'], 'a move removes its source');
  assert.deepEqual(at('mv src/a.ts src/b.ts lib/'), ['src/a.ts', 'src/b.ts', 'lib'], 'every source of a multi-source move');
  assert.deepEqual(at('mv -t lib src/a.ts'), ['src/a.ts', 'lib']);
  assert.deepEqual(at('mv --target-directory=lib src/a.ts'), ['src/a.ts', 'lib']);
  assert.deepEqual(at('cp -t lib /tmp/a.ts /tmp/b.ts'), ['lib'], 'cp -t names its destination first');
  assert.deepEqual(at('cp -rtlib /tmp/a'), ['lib']);
  assert.deepEqual(at('cp -rt lib /tmp/a'), ['lib']);
  assert.deepEqual(at('cp --target-dir lib /tmp/a'), ['lib']);
  assert.deepEqual(at('cp -S .t /tmp/a.ts src/a.ts'), ['src/a.ts'], 'a t in -S`s suffix names no directory');
  assert.deepEqual(at('rm -f src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('unlink src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('git mv src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(at('git -C src mv -k a.ts b.ts lib/'), ['src/a.ts', 'src/b.ts', 'src/lib']);
  assert.deepEqual(at('git rm -r --cached src'), ['src']);
  assert.deepEqual(at('git rm --pathspec-from-file list.txt'), [], 'paths read from a file are not certain');
  assert.deepEqual(at('rsync -a /tmp/x/ src/'), ['src']);
  assert.deepEqual(at('rsync -a --remove-source-files src/a.ts src/b.ts /tmp/out/'), ['src/a.ts', 'src/b.ts', '../tmp/out']);
  assert.deepEqual(at('rsync -av -e ssh --remove-sou src/a.ts host:/srv/'), ['src/a.ts'], 'a remote operand is not a local write');
  assert.deepEqual(at('rsync -a src/ user@host:/srv/'), []);
  assert.deepEqual(at('rsync --partial --remove-source-files src/a.ts /tmp/out'), ['src/a.ts', '../tmp/out'], 'a switch never swallows an operand');
  assert.deepEqual(at('rm -rf src'), ['src']);
  assert.deepEqual(at('touch -d "2 days ago" src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('mkdir -p -m 755 src/new'), ['src/new']);
  assert.deepEqual(at('mkdir -pm 755 src/new'), ['src/new'], 'a cluster that ends in a value option takes the next word');
  assert.deepEqual(at('touch -cd yesterday src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('rsync -ae ssh --remove-source-files src/a.ts host:/srv/'), ['src/a.ts']);
  assert.deepEqual(at("cat > /tmp/out.md <<'EOF'\nrm -rf src\nEOF\ngit status"), ['../tmp/out.md'], 'a heredoc body is data');
  assert.deepEqual(at('sudo rm src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('env -C src rm ../package.json'), ['package.json'], 'a wrapper`s directory moves its operands');
  assert.deepEqual(at('env -C src cmd > ../out'), ['../out'], 'but not the shell`s redirections');
  assert.deepEqual(at('env -iC src rm ../package.json'), ['package.json'], 'a wrapper`s value option at the end of a cluster');
  assert.deepEqual(at('env -iCsrc rm ../package.json'), ['package.json'], 'and attached to it');
  assert.deepEqual(at('sudo -nu root rm src/a.ts'), ['src/a.ts']);
  for (const command of ['git status', 'cat src/a.ts', 'git restore src/a.ts', 'npm run build', 'node scripts/x.mjs', 'ls -la']) {
    assert.deepEqual(at(command), [], command);
  }
  assert.deepEqual(at('echo hi > "$OUT/a.ts"'), [], 'a path that may expand');
  assert.deepEqual(at('echo hi > src/*.ts'), []);
  assert.deepEqual(at('cd /tmp && echo hi > a.ts'), [], 'a relative target after cd');
  assert.deepEqual(at('cd /tmp && echo hi > /repo/a.ts'), ['a.ts'], 'an absolute one still counts');
  assert.deepEqual(at('env -C "$DIR" rm x'), []);
  assert.deepEqual(at('echo "$(rm src/a.ts)"'), ['src/a.ts'], 'a substitution that runs');
  assert.deepEqual(at('x=`touch src/a.ts` && y=$(echo $(mkdir src/new))'), ['src/a.ts', 'src/new']);
  assert.deepEqual(at('cat <(git rm src/a.ts)'), ['src/a.ts']);
  assert.deepEqual(at("cat <<'EOF'\n$(rm src/a.ts)\nEOF"), [], 'a quoted heredoc runs nothing');
  assert.deepEqual(at('cd /tmp && x=$(rm a.ts)'), [], 'a relative target after cd, in a substitution too');
  assert.deepEqual(at('(rm src/a.ts)'), ['src/a.ts'], 'inside a subshell');
  assert.deepEqual(at('{ rm src/a.ts; }'), ['src/a.ts'], 'a brace group');
  assert.deepEqual(at('if true; then rm src/a.ts; fi'), ['src/a.ts']);
  assert.deepEqual(at('while true; do touch src/a.ts; done'), ['src/a.ts']);
  assert.deepEqual(at('! rm src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('rm "src/a (1).ts"'), ['src/a (1).ts'], 'a name keeps the `)` it opened');
});

test('a cd drops only the relative targets after it, and a cd in a substitution moves only that substitution', () => {
  const at = (command) => bashTargets(command, '/repo').map((file) => path.relative('/repo', file));
  assert.deepEqual(at('echo hi > a.ts; cd /tmp'), ['a.ts'], 'a write before the cd');
  assert.deepEqual(at('rm a.ts && cd /tmp && rm b.ts'), ['a.ts']);
  assert.deepEqual(at('echo hi > a.ts; x=$(cd /tmp)'), ['a.ts']);
  assert.deepEqual(at('x=$(cd /tmp); echo hi > a.ts'), ['a.ts'], 'the outer shell never moved');
  assert.deepEqual(at('x=$(rm a.ts; cd /tmp; rm b.ts)'), ['a.ts'], 'inside a substitution, in its own order');
  assert.deepEqual(at('cd $(rm a.ts)'), ['a.ts'], 'a substitution in the cd itself runs before it');
  assert.deepEqual(at('cat <<EOF; cd /tmp\n$(rm a.ts)\nEOF'), ['a.ts'], 'a heredoc expands before the cd after it');
  assert.deepEqual(at('cd /tmp; git -C /repo rm a.ts; env -C /repo/src rm b.ts'), ['a.ts', 'src/b.ts'], 'an absolute folder is certain');
  assert.deepEqual(at('cd /tmp; git -C src rm a.ts; env -C src rm b.ts'), [], 'a relative one is not');
});

test('Bash commands are judged like tool writes', (t) => {
  const { repo } = fixture(t);
  const bash = (command, cwd = repo) => check(command, { cwd, env: ENV });
  assert.match(bash('echo x > src/app.js'), /^Blocked: this command writes 'src\/app\.js', a tracked file/);
  assert.match(bash("cat > src/new.js <<'EOF'\nexport {};\nEOF"), /'src\/new\.js'/);
  assert.match(bash('git status && rm src/app.js'), /'src\/app\.js'/);
  assert.match(bash('echo x > src/app.js; cd /tmp'), /'src\/app\.js'/, 'a write before a cd');
  assert.match(bash('echo x > src/app.js; x=$(cd /tmp)'), /'src\/app\.js'/, 'a cd in a substitution moves only it');
  assert.match(bash('mv src/app.js build/app.js'), /'src\/app\.js'/, 'moving a tracked file out removes it from the main checkout');
  assert.match(bash('mv build/a.js src/app.js build/'), /'src\/app\.js'/, 'every source of a multi-source move');
  assert.match(bash('git mv src/app.js src/main.js'), /'src\/app\.js'/);
  assert.match(bash("sed -i -e's/x/y/' src/app.js"), /'src\/app\.js'/, 'a script attached to its option');
  assert.match(bash('rsync --remove-source-files src/app.js build/app.js'), /'src\/app\.js'/);
  assert.equal(bash('rsync src/app.js build/app.js'), null, 'a copy out of the main checkout writes nothing in it');
  assert.equal(bash('cp src/app.js build/app.js'), null);
  assert.equal(bash('echo x > build/out.js'), null);
  assert.equal(bash('echo x > src/app.js', path.join(repo, 'wt/task')), null);
  assert.equal(bash('git status'), null);
  assert.equal(check('echo x > src/app.js', { cwd: repo, env: { AIDRIAN_ALLOW_MAIN_WRITE: '1' } }), null);
});

test('when git cannot tell, a tool write is denied and a Bash command runs', (t) => {
  const { base, repo } = fixture(t);
  const corrupt = path.join(base, 'corrupt-index');
  writeFileSync(corrupt, 'not an index');
  const run = (script, input) =>
    spawnSync(process.execPath, [path.join(SCRIPTS, script)], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: corrupt } });
  const tool = run('hook-write.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(repo, 'src/app.js') }, cwd: repo });
  assert.equal(tool.status, 2);
  assert.match(tool.stderr, /^Blocked: git could not tell whether 'src\/app\.js' is tracked/);
  const bash = run('hook-bash.mjs', { tool_name: 'Bash', tool_input: { command: 'echo x > src/app.js' }, cwd: repo });
  assert.deepEqual([bash.status, bash.stderr], [0, '']);
});

test('the write hook denies through stdin, and exits 0 silently for anything it cannot read', (t) => {
  const { repo } = fixture(t);
  const run = (input) => spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-write.mjs')], { input, encoding: 'utf8' });
  const denied = run(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: path.join(repo, 'src/app.js') }, cwd: repo }));
  assert.deepEqual([denied.status, denied.stdout], [2, '']);
  for (const input of ['', 'not json', '[]', '{}', JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 42 } })]) {
    const { status, stdout, stderr } = run(input);
    assert.deepEqual([status, stdout, stderr], [0, '', ''], input);
  }
});

test('bashTargets finds the targets of ln, truncate, install, and dd; with restores, those of git checkout -- and git restore', () => {
  const at = (command) => bashTargets(command, '/repo').map((file) => path.relative('/repo', file));
  assert.deepEqual(at('ln -sf /tmp/x src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('ln -s -t src /tmp/x /tmp/y'), ['src']);
  assert.deepEqual(at('truncate -s 0 src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(at('install -m 644 /tmp/x src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('install -d src/new'), ['src/new']);
  assert.deepEqual(at('dd if=/dev/zero of=src/a.ts bs=1 count=1'), ['src/a.ts']);
  // git checkout -- and git restore put a path back: the main-checkout rule lets them discard changes; the config guard asks.
  assert.deepEqual(at('git restore --source=HEAD~1 src/a.ts'), []);
  const restored = (command) => bashWrites(command, '/repo', { restores: true }).flatMap(({ files }) => files).map((file) => path.relative('/repo', file));
  assert.deepEqual(restored('git checkout main -- src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(restored('git checkout main'), [], 'a branch switch names no path');
  assert.deepEqual(restored('git restore --source=HEAD~1 src/a.ts'), ['src/a.ts']);
  assert.deepEqual(restored('git restore -s main src/a.ts'), ['src/a.ts']);
  assert.deepEqual(restored('git restore --staged src/a.ts'), [], 'only the index changes');
  assert.deepEqual(restored('git restore --staged --worktree src/a.ts'), ['src/a.ts']);
});

test('in the main checkout, only named files are staged and only the default branch is checked out', (t) => {
  const { repo, base } = fixture(t);
  execFileSync('git', ['-C', repo, 'branch', 'src']);
  execFileSync('git', ['-C', repo, 'update-ref', 'refs/remotes/origin/remote-only', 'HEAD']);
  const beside = path.join(base, 'beside');
  const denied = (command, cwd = repo) => check(command, { cwd, env: ENV });
  for (const command of [
    'git add -A', 'git add --all', 'git add --al', 'git add .', 'git add ./', 'git add *', 'git add -u', 'git add :/', 'git add src',
    `git add ${repo}`, 'git add --dry-run --no-dry-run -A', 'git add', 'git add "$FILES"',
    'git commit -am x', 'git commit -am"fix: x"', 'git commit --all -m x', 'git commit -am "GIT_DIR=$HOME"', 'git commit --dry-run --no-dry-run -am x',
    'git switch task', 'git switch -c fresh', 'git switch -cnew main', 'git switch -d main',
    'git checkout task', 'git checkout -b fresh', 'git checkout -bnew main', 'git checkout task --', 'git checkout src',
    'git checkout -', 'git checkout remote-only', 'git checkout -d main', 'git checkout --patch --no-patch task',
    'git -C src add -A', 'echo "$(git add -A)"', `env -C ${repo} git add -A`, `git -C${repo} add -A`,
    `git --work-tree=${beside} checkout task`, `git --work-tree=${beside} add -A`,
    `git --git-dir=${repo}/.git --work-tree=${repo} add src/app.js`,
  ]) {
    assert.match(denied(command) ?? '', /^Blocked: .* in the main checkout/, command);
  }
  assert.match(denied('git add ..', path.join(repo, 'src')) ?? '', /main checkout/, 'a parent folder');
  for (const command of [
    'git add src/app.js', 'git add -v src/app.js gone.txt', 'git switch main', 'git checkout main', 'git checkout src/app.js', 'git checkout -- src/app.js',
    'git checkout gone.txt', 'git checkout task -- src/app.js', 'git checkout HEAD src/app.js', 'git status', 'git pull --ff-only',
  ]) {
    assert.equal(denied(command), null, command);
  }
  assert.equal(denied('git add -A', path.join(repo, 'wt/task')), null, 'a worktree is the session`s own');
  assert.equal(denied(`env -C ${beside} git add -A`), null, 'env -C into a worktree');
  assert.equal(denied(`git -C${beside} add -A`), null, 'git -C into a worktree');
  assert.match(denied(`git --git-dir=${repo}/.git --work-tree=${repo} add -A`, beside) ?? '', /main checkout/, 'from a worktree into the main checkout');
  assert.equal(denied('cd wt/task && git add -A'), null, 'after a cd the folder is not certain');
  assert.match(denied(`git --git-dir=${repo}/.git --work-tree=${repo} checkout task`, base) ?? '', /main checkout/, 'from outside the repository');
  assert.match(denied(`git --git-dir=repo/.git --work-tree=repo -C ${base} add -A`, '/') ?? '', /main checkout/, 'relative repository paths after -C');
  assert.equal(denied(`git add ${path.join(repo, 'src/app.js')}`), null, 'an absolute path to one file');
  const meta = path.join(base, 'meta.git');
  const separate = path.join(base, 'separate');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', meta, separate]);
  execFileSync('git', ['--git-dir', meta, 'config', 'core.worktree', separate]);
  mkdirSync(path.join(separate, '.aidrian'));
  writeFileSync(path.join(separate, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  assert.match(denied(`git --git-dir=${meta} checkout task`, base) ?? '', /main checkout/, 'a separate git folder names its checkout');
  assert.match(denied(`GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git add -A`, base) ?? '', /main checkout/, 'git environment on the command');
  assert.match(denied(`env GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git checkout task`, base) ?? '', /main checkout/);
  assert.match(denied('git --icase-pathspecs add src/app.js') ?? '', /main checkout/, 'a pathspec option');
  assert.match(denied(`git -c core.worktree=${repo} add src/app.js`, base) ?? '', /main checkout/, 'a config value');
  assert.match(denied("bash -c 'git add -A'") ?? '', /main checkout/, 'an inline shell');
  assert.match(denied("sh -c 'git checkout task'") ?? '', /main checkout/);
  assert.match(denied(`GIT_INDEX_FILE=${repo}/.git/index git add -A`, beside) ?? '', /main checkout/, 'an index file names its checkout');
  assert.match(denied(`GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} bash -c 'git add -A'`, beside) ?? '', /main checkout/, 'git environment into an inline shell');
  assert.match(denied(`export GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo}; git checkout task`, beside) ?? '', /main checkout/, 'an export earlier on the line');
  assert.match(denied(`GIT_DIR="$HOME/unused"; GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git add -A`, beside) ?? '', /main checkout/, 'the last assignment wins');
  for (const command of ['branch=task; git checkout "$branch"', 'git checkout "$(printf task)"', 'flags=-am; git commit $flags x']) {
    assert.match(denied(command) ?? '', /main checkout/, `a word that may expand: ${command}`);
  }
  for (const command of ['git commit -m "$MESSAGE"', 'git commit -m"$MSG"', 'set -- m -a; git commit -m"$@"', 'git commit -m "${args[@]}"']) {
    assert.match(denied(command) ?? '', /main checkout/, `a commit word that expands: ${command}`);
  }
  assert.match(denied("bash <<'EOF'\ngit add -A\nEOF") ?? '', /main checkout/, 'a heredoc fed to a shell');
  assert.match(denied("bash <<< 'git checkout task'") ?? '', /main checkout/, 'a here-string');
  for (const command of ['MSG="m -a"; git commit -m$MSG', 'git commit --message=$MSG', 'git commit -m $MSG']) {
    assert.match(denied(command) ?? '', /main checkout/, `an unquoted expansion can split: ${command}`);
  }
  assert.match(denied(`export GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo}; bash <<< 'git add -A'`, beside) ?? '', /main checkout/, 'an export before shell input');
  assert.match(denied(`GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} /bin/bash <<< 'git add -A'`, beside) ?? '', /main checkout/, 'assignments before /bin/bash');
  assert.match(denied(`env -C ${base}/git GIT_DIR=${repo}/.git GIT_WORK_TREE=${repo} git add -A`, base) ?? '', /main checkout/, 'a wrapper folder named git');
  assert.equal(denied(`cd ${beside} && bash <<< 'git add -A'`), null, 'shell input after a cd');
  for (const command of ['git add {.,src}', 'git commit --{all,verbose} -m msg', 'git checkout task{1..1}']) {
    assert.match(denied(command) ?? '', /main checkout/, `a brace expansion: ${command}`);
  }
  assert.match(denied(`(GIT_DIR=${repo}/.git git checkout task)`, beside) ?? '', /main checkout/, 'an assignment in a subshell');
  symlinkSync('src', path.join(repo, 'link'));
  assert.equal(denied('git add link'), null, 'a symlink to a folder is one file');
  for (const command of ['(export GIT_DIR="$HOME/unused"); git add -A', 'export GIT_DIR="$HOME/unused" | cat; git add -A', 'GIT_DIR="$X" git add src/app.js']) {
    assert.match(denied(command) ?? '', /main checkout/, `an unreadable value fails closed: ${command}`);
  }
  assert.match(denied(`GIT_WORK_TREE=${repo}; GIT_DIR=${repo}/.git; export GIT_DIR GIT_WORK_TREE; git add -A`, beside) ?? '', /main checkout/, 'bare assignments');
  execFileSync('git', ['-C', repo, 'rm', '-q', '--cached', 'src/app.js']);
  execFileSync('git', ['-C', repo, 'add', 'src/app.js']);
  rmSync(path.join(repo, 'src'), { recursive: true, force: true });
  assert.match(denied('git add src') ?? '', /main checkout/, 'a tracked folder deleted from disk');
  assert.equal(denied('git add src/app.js'), null, 'one deleted file by name');
  const off = fixture(t, { version: 1 }).repo;
  assert.equal(check('git add -A', { cwd: off, env: ENV }), null, 'the guard is off');
});

test('in the main checkout, a git call that makes a commit or moves the branch is denied, naming it and the worktree command', (t) => {
  const { repo, base } = fixture(t);
  const beside = path.join(base, 'beside');
  const outside = path.join(base, 'outside');
  mkdirSync(outside);
  // A second commit, so HEAD~1 names one.
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'second']);
  const at = (command, cwd = repo, env = ENV) => check(command, { cwd, env });
  // [command, the subcommand the reason names]
  const deniedForms = [
    ['git commit -m x', 'commit'], ['git commit -mrelease', 'commit'], ['git commit -uall -m x', 'commit'],
    ['git commit -Sabc123 -m x', 'commit'], ["git commit -m 'GIT_DIR=docs'", 'commit'], ['git commit -m "a literal message"', 'commit'],
    ['git commit --amend --no-edit', 'commit'], ['git commit-tree HEAD^{tree} -m x', 'commit-tree'],
    ['git merge task', 'merge'], ['git merge --no-ff task', 'merge'], ['git merge --squash task', 'merge'], ['git merge --ff task', 'merge'],
    ['git merge --ff-only --no-ff task', 'merge'], ['git merge --ff-only -m x task', 'merge'], ['git merge --continue', 'merge'],
    // A fast-forward toward anything but the default branch's upstream moves main onto commits that are not on origin.
    ['git merge --ff-only task', 'merge'], ['git merge --ff-only fix/x', 'merge'], ['git merge --ff-only origin/task', 'merge'],
    ['git merge --ff-only main', 'merge'], ['git merge --ff-only origin/main task', 'merge'], ['git merge --ff-only task@{u}', 'merge'],
    ['git merge --ff-only -- origin/main', 'merge'],
    ['git pull --ff-only . task', 'pull'], ['git pull --ff-only origin task', 'pull'], ['git pull --ff-only origin', 'pull'],
    ['git pull --ff-only fork main', 'pull'], ['git pull --ff-only origin main task', 'pull'], ['git pull --ff-only origin main:main', 'pull'],
    ['git cherry-pick task', 'cherry-pick'], ['git revert HEAD', 'revert'], ['git rebase task', 'rebase'],
    ['git rebase --onto task HEAD~1', 'rebase'], ['git am patch.mbox', 'am'],
    // Only --abort and --quit on their own end an operation without a commit.
    ['git rebase --continue', 'rebase'], ['git rebase --skip', 'rebase'], ['git cherry-pick --continue', 'cherry-pick'],
    ['git cherry-pick --skip', 'cherry-pick'], ['git revert --continue', 'revert'], ['git am --continue', 'am'], ['git am --skip', 'am'],
    ['git rebase --abort task', 'rebase'], ['git merge --abort --no-ff', 'merge'], ['git commit --abort', 'commit'],
    ['git pull', 'pull'], ['git pull --rebase', 'pull'], ['git pull --ff-only --rebase', 'pull'], ['git pull --no-ff origin main', 'pull'],
    ['git reset --hard', 'reset'], ['git reset --hard HEAD~1', 'reset'], ['git reset --soft HEAD~1', 'reset'],
    ['git reset --mixed HEAD~1', 'reset'], ['git reset --mixed', 'reset'], ['git reset --keep task', 'reset'], ['git reset --merge', 'reset'],
    ['git reset HEAD~1', 'reset'], ['git reset task', 'reset'], ['git reset task --', 'reset'], ['git reset', 'reset'], ['git reset --', 'reset'],
    ['git reset "$REF"', 'reset'], ['git merge --ff-only "$BRANCH"', 'merge'],
    // A reset unstages only named files: a folder, a glob, or pathspec magic unstages other sessions' work.
    ['git reset .', 'reset'], ['git reset -q :/', 'reset'], ['git reset -- .', 'reset'], ['git reset src', 'reset'], ['git reset HEAD src', 'reset'],
    ["git reset '*.js'", 'reset'], ['git reset -- :/src', 'reset'], ['git reset HEAD -- .', 'reset'], ['git reset --pathspec-from-file=list', 'reset'],
    ['git reset src/app.js HEAD -- src/app.js', 'reset'],
    ['git -C src commit -m x', 'commit'], [`env -C ${repo} git rebase task`, 'rebase'], ["bash -c 'git commit -m x'", 'commit'],
    ['cd src && git commit -m x', 'commit'],
  ];
  for (const [command, subcommand] of deniedForms) {
    const reason = at(command) ?? '';
    assert.ok(reason.startsWith(`Blocked: \`git ${subcommand}\` `), `${command}: ${reason}`);
    assert.ok(reason.includes(`on the branch every session shares, in the main checkout (${repo}).`), `${command}: ${reason}`);
    assert.ok(reason.includes('`aidrian worktree new <branch>`'), command);
  }
  // Routed into the main checkout from a worktree or from outside the repository.
  for (const [command, cwd] of [
    [`git -C ${repo} commit -m x`, beside], [`git --git-dir=${repo}/.git --work-tree=${repo} commit -m x`, beside],
    [`GIT_DIR=${repo}/.git git commit --allow-empty -m x`, outside], [`git --git-dir=${repo}/.git reset --hard HEAD~1`, outside],
    [`git -C ${repo} merge task`, beside], [`git --git-dir=${repo}/.git pull --ff-only`, outside],
    [`git -C ${repo} merge --ff-only fix/x`, beside], [`git -C ${repo} merge --ff-only task`, beside], [`git -C ${repo} pull --ff-only . task`, beside],
    [`git -C ${repo} reset .`, beside], [`git -C ${repo} rebase --continue`, beside],
  ]) {
    assert.match(at(command, cwd) ?? '', /^Blocked: `git (?:commit|reset|merge|pull|rebase)` .* in the main checkout/, `${command} from ${cwd}`);
  }
  // Through `git -C <main>` from a worktree, the safe forms run as they do in the main checkout.
  for (const command of [
    `git -C ${repo} merge --ff-only origin/main`, `git -C ${repo} pull --ff-only origin main`, `git -C ${repo} merge --abort`,
    `git -C ${repo} reset src/app.js`,
  ]) {
    assert.equal(at(command, beside), null, `${command} from a worktree`);
  }

  writeFileSync(path.join(repo, 'src/app.js'), 'export const a = 1;\n');
  const allowedForms = [
    'git switch main', 'git checkout main', 'git pull --ff-only', 'git pull --ff-only origin main', 'git pull -q --ff-only',
    'git pull --ff-only --no-rebase', 'git merge --ff-only', 'git merge --ff-only origin/main', 'git merge --ff-only -q origin/main',
    'git merge --ff-only @{u}', 'git merge --ff-only @{upstream}', 'git merge --ff-only FETCH_HEAD', 'git fetch', 'git fetch origin',
    'git merge --abort', 'git merge --quit', 'git rebase --abort', 'git rebase --quit', 'git cherry-pick --abort', 'git cherry-pick --quit',
    'git revert --abort', 'git revert --quit', 'git am --abort', 'git am --quit',
    'git status', 'git log --oneline', 'git diff HEAD~1', 'git reset src/app.js', 'git reset -- src/app.js', 'git reset HEAD src/app.js',
    'git reset HEAD -- src/app.js', 'git reset -q -- src/app.js', 'git reset gone.txt', 'git -C src reset app.js',
  ];
  for (const command of allowedForms) assert.equal(at(command), null, command);

  // From a worktree every form runs, and so does a call routed into one; with the guard off, or the override, too.
  const worktree = path.join(repo, 'wt/task');
  const off = fixture(t, { version: 1 }).repo;
  const disabled = fixture(t, { version: 1, git: { mainCheckout: { guard: false } } }).repo;
  for (const command of [...deniedForms.map(([command]) => command), ...allowedForms]) {
    if (command.includes(repo) || command.startsWith('cd ')) continue;
    assert.equal(at(command, worktree), null, `from a worktree: ${command}`);
    assert.equal(at(command, beside), null, `from a worktree beside it: ${command}`);
    assert.equal(at(command, off), null, `the guard off by default: ${command}`);
    assert.equal(at(command, disabled), null, `the guard off: ${command}`);
    assert.equal(at(command, repo, { AIDRIAN_ALLOW_MAIN_WRITE: '1' }), null, `the override: ${command}`);
  }
  assert.equal(at(`git -C ${beside} commit -m x`), null, 'git -C into a worktree');
  assert.equal(at(`git -C ${beside} reset --hard HEAD~1`), null);
  assert.equal(at('cd wt/task && git rebase main'), null, 'after a cd into a worktree');
});

// A `cd` that a shell alias or function turns into a no-op can fail and still return 0, so what follows it runs in the
// main checkout. A `cd` the rule cannot trust is judged as if it failed.
const CD_LEAD = /after a cd that leaves the repository, or that this rule cannot read\./;
const firstOf = (reason) => reason.split(/\n|(?<=\.)\s/u)[0];

test('after a cd that leaves the repository, or that the rule cannot read, the main checkout is still guarded', (t) => {
  const { base, repo } = fixture(t);
  const bash = (command, cwd = repo) => check(command, { cwd, env: ENV });
  // [command, the cd the reason names, the write it names (or null for a git call)]
  for (const [command, cd, name] of [
    ['cd /tmp && echo x > a.txt', 'cd /tmp', 'a.txt'],
    ['S=/tmp/x; cd "$S"; rm -rf gx; mkdir gx', 'cd "$S"', 'gx'],
    ["cd /tmp/x || exit 1; printf 'dist/\\n' > .gitignore", 'cd /tmp/x', '.gitignore'],
    ['cd "$S" && git init -q -b main repo', 'cd "$S"', null],
    ['cd /tmp && git commit -m init', 'cd /tmp', null],
    ['pushd /tmp && git worktree add ../wt feature', 'pushd /tmp', null],
    ['cd && git branch x', 'cd', null],
    ['cd - && git checkout -b x', 'cd -', null],
    ['cd ~/x && git merge t2', 'cd ~/x', null],
    ['cd .. && git tag v0', 'cd ..', null],
    ['popd; git stash', 'popd', null],
    ["cd /tmp && bash -c 'git init'", 'cd /tmp', null],
    ["cd /tmp && bash <<< 'git commit -m x'", 'cd /tmp', null],
    ['cd /tmp && git config user.name t', 'cd /tmp', null],
    ['cd -- "$S"; mkdir gx', 'cd "$S"', 'gx'],
    ['cd -- /tmp/x && git init -q -b main repo', 'cd /tmp/x', null],
    ['cd wt/typo && git checkout -b x', 'cd wt/typo', null],
    ['cd src/missing && echo x > a.txt', 'cd src/missing', 'a.txt'],
    ['cd "$S" && rm -rf *', 'cd "$S"', '*'],
    ['cd /tmp/x; rm -f ./*.js', 'cd /tmp/x', './*.js'],
    ['cd /tmp/x && bash -c \'printf "dist/\\n" > .gitignore\'', 'cd /tmp/x', '.gitignore'],
    ['cd /tmp && git -C src commit -m x', 'cd /tmp', null],
    [`cd /tmp && git -C ${repo} branch x`, 'cd /tmp', null],
    ['cd /tmp && git "$sub" -q', 'cd /tmp', null],
    ['cd "$S"; cd gx; git init', 'cd "$S"', null],
    // The folder of a git call or a write resolves from the folders before the cd.
    ['cd /tmp && git --git-dir=.git commit -m x', 'cd /tmp', null],
    ['cd /tmp && git --work-tree=. add x', 'cd /tmp', null],
    ['cd /tmp && env -C src git commit -m x', 'cd /tmp', null],
    ['cd /tmp && GIT_DIR=.git git commit -m x', 'cd /tmp', null],
    ['cd src && cd /tmp && echo x > a.txt', 'cd /tmp', 'a.txt'],
    // `builtin cd` skips a shell function or alias, but its folder is judged the same.
    ['builtin cd /tmp && git init', 'builtin cd /tmp', null],
    ["bash -c 'builtin cd /tmp && git init'", 'builtin cd /tmp', null],
    ["cd '$x' && git init", "cd '$x'", null],
    ["cd '$S' && git init", "cd '$S'", null],
    ["cd 'my dir' && git init", "cd 'my dir'", null],
  ]) {
    const reason = bash(command) ?? '';
    const first = firstOf(reason);
    assert.match(first, CD_LEAD, command);
    assert.doesNotMatch(first, /(?:^|[\s(`'])\/\S/u, `no machine path in the first sentence: ${command}`);
    if (name) assert.ok(first.includes(`this command writes '${name}' after a cd`), `${command}: ${first}`);
    else assert.match(first, /^Blocked: `git[^`]*` .*runs after a cd/, command);
    assert.ok(reason.includes(`The cd is \`${cd}\`;`), `${command} names \`${cd}\`: ${reason}`);
    assert.ok(reason.includes(`the main checkout (${repo})`), command);
    assert.ok(reason.includes('`git -C <absolute folder>`') && reason.includes('`env -C <absolute folder>`'), command);
    assert.ok(reason.includes('aidrian worktree new <branch>') && reason.includes('AIDRIAN_ALLOW_MAIN_WRITE=1'), command);
  }

  // A cd inside the main checkout leaves the shell there whether it works or not: today's rules judge what follows.
  assert.match(bash('cd src && echo x > app.js') ?? '', /^Blocked: this command writes 'src\/app\.js', a tracked file in the main checkout/);
  assert.match(bash('cd . && git checkout -b x') ?? '', /^Blocked: `git checkout` moves the folder every session shares to another branch, in the main checkout/);
  assert.match(bash('cd src && git add -A') ?? '', /^Blocked: `git add` of anything but named files can stage other sessions' work, in the main checkout/);
  // A file the write reaches only when a cd inside the main checkout fails names that cd: here into the ignored build/.
  mkdirSync(path.join(repo, 'build'));
  const failed = bash('cd build && echo x > a.txt') ?? '';
  assert.match(failed, /^Blocked: this command writes 'a\.txt' in the main checkout if a cd before it fails\. The cd is `cd build`;/);
  assert.doesNotMatch(firstOf(failed), /(?:^|[\s(`'])\/\S/u, 'no machine path in the first sentence');
  assert.ok(failed.includes(`the main checkout (${repo})`) && failed.includes('`git -C <absolute folder>`'));
  // A glob after a cd inside the main checkout fails closed at the folders before it: if the cd fails, `rm -rf *` runs
  // at the root.
  for (const [command, name, cd] of [['cd build && rm -rf *', '*', 'cd build'], ['cd src && rm -f ./*.js', './*.js', 'cd src']]) {
    const glob = bash(command) ?? '';
    assert.ok(glob.startsWith(`Blocked: this command writes '${name}' in the main checkout if a cd before it fails. The cd is \`${cd}\`;`), `${command}: ${glob}`);
    assert.doesNotMatch(firstOf(glob), /(?:^|[\s(`'])\/\S/u, command);
  }
  // `builtin cd` skips an alias or function: the reason says only that the cd may fail.
  const builtin = bash('builtin cd /tmp && git init') ?? '';
  assert.ok(builtin.includes(`The cd is \`builtin cd /tmp\`; if it fails, the call acts on the main checkout (${repo}).\n`), builtin);
  assert.ok(!builtin.includes('alias'), 'no alias is blamed for a builtin cd');
  assert.ok((bash('cd /tmp && git init') ?? '').includes('a shell alias or function for cd can fail and still return 0'));

  for (const command of [
    'cd /tmp && git status', 'cd /tmp && git log --oneline', 'cd /tmp && git branch', 'cd /tmp && git worktree list',
    'cd /tmp && git stash list', 'cd /tmp && git config --get user.name', 'cd /tmp && git remote -v', 'cd /tmp && npm test',
    'cd /tmp && echo x > /tmp/a.txt', 'cd "$S" && git -C "$S" init -q', 'cd /tmp && git -C /tmp/x init -q',
    'cd /tmp && env -C /tmp/x git init -q', 'cd "$S" && echo x > "$S/a.txt"', 'cd wt/task && git add -A',
    `cd ${path.join(base, 'beside')} && echo x > src/app.js`, 'cd wt/task && cd /tmp && git init', 'x=$(cd /tmp); git status',
    'builtin cd wt/task && git add -A', "bash -c 'builtin cd wt/task && git add -A'", `builtin cd ${path.join(base, 'beside')} && git add -A`,
    // A residual: a git folder held in an expansion is not read after an untrusted cd.
    'cd /tmp && git --git-dir="$D" commit -m x',
  ]) {
    assert.equal(bash(command), null, command);
  }

  // From a worktree, with the guard off, and with the override, nothing changes.
  const worktree = path.join(repo, 'wt/task');
  for (const command of ['cd /tmp && git init', 'cd "$S" && echo x > a.txt']) {
    assert.equal(bash(command, worktree), null, `from a worktree: ${command}`);
    assert.equal(check(command, { cwd: repo, env: { AIDRIAN_ALLOW_MAIN_WRITE: '1' } }), null, `the override: ${command}`);
  }
  const off = fixture(t, { version: 1 }).repo;
  for (const command of ['cd /tmp && git init', 'cd "$S" && echo x > a.txt']) assert.equal(check(command, { cwd: off, env: ENV }), null, `the guard off: ${command}`);
});

test('a write into the state folder by its absolute path is allowed; a cd into it is still untrusted', (t) => {
  const { repo } = fixture(t);
  const bash = (command) => check(command, { cwd: repo, env: ENV });
  const state = stateDir(findProject(repo), { env: process.env });
  mkdirSync(path.join(state, 'plans'), { recursive: true });
  for (const command of [
    `cat > ${state}/handoff.md`,
    `cat > ${state}/plans/x.md`,
    `cat > ${state}/handoff.md <<'X'\necho x > src/app.js\nX`,
    `cat > ${state}/plans/x.md <<'X'\nplan\nX`,
    `cat > ${state}/plans/new/x.md`,
    `mkdir -p ${state}/plans/new`,
  ]) assert.equal(bash(command), null, command);
  assert.equal(edit(path.join(state, 'plans/x.md'), repo, 'Write'), null, 'a Write tool call');

  // A cd into the state folder is untrusted, as any cd that leaves the repository is: if it fails, the write lands in
  // the main checkout.
  for (const [command, cd, name] of [
    [`cd ${state} && cat > handoff.md`, `cd ${state}`, 'handoff.md'],
    [`cd ${state}/plans && cat > x.md <<'X'\nplan\nX`, `cd ${state}/plans`, 'x.md'],
    ['cd /tmp && cat > file', 'cd /tmp', 'file'],
    ['S=/tmp/x; cd "$S" && cat > file', 'cd "$S"', 'file'],
    [`cd ${state} && rm -rf ./*.md`, `cd ${state}`, './*.md'],
  ]) {
    const reason = bash(command) ?? '';
    assert.ok(reason.startsWith(`Blocked: this command writes '${name}' after a cd`), `${command}: ${reason}`);
    assert.ok(reason.includes(`The cd is \`${cd}\`;`), `${command}: ${reason}`);
  }
  // A tracked file in the main checkout, with or without a cd, and a link in the state folder into the repository, to a
  // folder, a file, or a file not made yet, which a write through it creates.
  symlinkSync(path.join(repo, 'src'), path.join(state, 'src'));
  symlinkSync(repo, path.join(state, 'repo'));
  symlinkSync(path.join(repo, 'src/app.js'), path.join(state, 'app.js'));
  symlinkSync(path.join(repo, 'src/new.js'), path.join(state, 'new.js'));
  for (const [command, rel] of [
    ['echo x > src/app.js', 'src/app.js'],
    [`cd ${state} && echo x > ${repo}/src/app.js`, 'src/app.js'],
    [`echo x > ${state}/src/app.js`, 'src/app.js'],
    [`cat > ${state}/repo/src/new.js <<'X'\nx\nX`, 'src/new.js'],
    [`echo x > ${state}/app.js`, 'src/app.js'],
    [`echo x > ${state}/new.js`, 'src/new.js'],
    [`cd ${state} && echo x > ${state}/new.js`, 'src/new.js'],
  ]) assert.match(bash(command) ?? '', new RegExp(`^Blocked: this command writes '${rel.replace('.', '\\.')}', a tracked file in the main checkout`), command);
  assert.match(edit(path.join(state, 'new.js'), repo, 'Write') ?? '', /^Blocked: this writes 'src\/new\.js'/, 'a Write tool call through a link');
});

test('a tracked link whose target does not exist is judged as itself as well as where it points', (t) => {
  const { repo } = fixture(t);
  symlinkSync('build/cc.json', path.join(repo, 'cc.json'));
  symlinkSync('/nonexistent/aidrian/x', path.join(repo, 'ext'));
  execFileSync('git', ['-C', repo, 'add', 'cc.json', 'ext']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'links']);
  const bash = (command) => check(command, { cwd: repo, env: ENV });
  for (const link of ['cc.json', 'ext']) {
    for (const command of [
      `rm ${link}`, `rm -f ${link}`, `git rm ${link}`, `unlink ${link}`, `ln -sf other ${link}`, `echo x > ${link}`, `tee ${link}`,
      `touch ${link}`, `mv ${link} /tmp/x`, `cp /tmp/x ${link}`, `sed -i s/a/b/ ${link}`, `install /tmp/x ${link}`,
      `echo x > ${path.join(repo, link)}`,
    ]) assert.match(bash(command) ?? '', new RegExp(`^Blocked: this command writes '${link.replace('.', '\\.')}', a tracked file`), command);
    assert.match(edit(path.join(repo, link), repo, 'Write') ?? '', new RegExp(`^Blocked: this writes '${link.replace('.', '\\.')}'`), `Write ${link}`);
  }
});

test('a tracked link whose target exists outside the repository is judged as itself; a file through a folder link is not', (t) => {
  const { repo } = fixture(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'target.txt'), 'x\n');
  symlinkSync(path.join(outside, 'target.txt'), path.join(repo, 'extfile'));
  symlinkSync(outside, path.join(repo, 'extdir'));
  execFileSync('git', ['-C', repo, 'add', 'extfile', 'extdir']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'links']);
  const bash = (command) => check(command, { cwd: repo, env: ENV });
  for (const link of ['extfile', 'extdir']) {
    for (const command of [`rm ${link}`, `rm -rf ${link}`, `echo x > ${link}`]) {
      assert.match(bash(command) ?? '', new RegExp(`^Blocked: this command writes '${link}', a tracked file`), command);
    }
    assert.match(edit(path.join(repo, link), repo, 'Write') ?? '', new RegExp(`^Blocked: this writes '${link}'`), `Write ${link}`);
  }
  assert.equal(bash('echo x > extdir/f.txt'), null, 'a file through the folder link is outside the repository');
  assert.equal(edit(path.join(repo, 'extdir/f.txt'), repo, 'Write'), null);
});

test('canonical leaves a link loop, a self-nesting link, and a folder it may not read as typed', (t) => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-links-')));
  t.after(() => {
    chmodSync(path.join(base, 'locked'), 0o755);
    rmSync(base, { recursive: true, force: true });
  });
  symlinkSync('a/a/a/a', path.join(base, 'a'));
  symlinkSync('c', path.join(base, 'b'));
  symlinkSync('b', path.join(base, 'c'));
  mkdirSync(path.join(base, 'locked'));
  symlinkSync('/nonexistent/aidrian/x', path.join(base, 'locked/x'));
  chmodSync(path.join(base, 'locked'), 0);
  for (const name of ['a', 'a/x', 'b', 'c/x', 'locked/x']) assert.equal(canonical(path.join(base, name)), path.join(base, name), name);
});

test('a chain of links not made yet is followed as far as the system follows one', (t) => {
  const { repo } = fixture(t);
  const links = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-chain-')));
  t.after(() => rmSync(links, { recursive: true, force: true }));
  const chain = (name, length) => {
    for (let i = 0; i < length; i += 1) symlinkSync(i === length - 1 ? path.join(repo, `src/${name}.js`) : `${name}${i + 1}`, path.join(links, `${name}${i}`));
    return path.join(links, `${name}0`);
  };
  // Under every system's limit (32 on macOS, 40 on Linux).
  assert.match(check(`echo x > ${chain('short', 30)}`, { cwd: repo, env: ENV }) ?? '', /^Blocked: this command writes 'src\/short\.js', a tracked file/);
  // Past the old 32-link cap: denied where the system follows it; where it stops sooner, the write itself fails.
  const head = chain('long', 36);
  let follows = true;
  try {
    realpathSync(head);
  } catch (error) {
    follows = error.code === 'ENOENT';
  }
  if (follows) assert.match(check(`echo x > ${head}`, { cwd: repo, env: ENV }) ?? '', /^Blocked: this command writes 'src\/long\.js', a tracked file/);
  else {
    assert.notEqual(spawnSync('sh', ['-c', `echo x > '${head}'`]).status, 0, 'the system refuses the write');
    assert.equal(existsSync(path.join(repo, 'src/long.js')), false);
  }
});

test('a state folder at, around, or inside the main checkout or its git folder gets no trust', (t) => {
  const home = process.env.HOME;
  t.after(() => {
    process.env.HOME = home;
  });
  for (const dir of ['..', '~', '.git/aidrian']) {
    const { base, repo } = fixture(t, { version: 1, git: { mainCheckout: { guard: true } }, state: { dir } });
    process.env.HOME = base;
    const bash = (command) => check(command, { cwd: repo, env: ENV });
    const state = stateDir(findProject(repo), { env: process.env });
    mkdirSync(state, { recursive: true });
    assert.ok(repo.startsWith(`${state}/`) || state.startsWith(`${repo}/`), `${dir}: ${state} holds or sits in ${repo}`);
    const tracked = path.relative(state, path.join(repo, 'src/app.js'));
    assert.match(bash(`echo x > ${path.join(state, tracked)}`) ?? '', /^Blocked: this command writes 'src\/app\.js', a tracked file/, dir);
    // After the cd, a relative write is judged at the folders before it, as after any untrusted cd: from a state folder
    // around the root, `repo/src/app.js` there is a new file in the main checkout. From one inside the git folder,
    // `../../src/app.js` resolves outside it and passes, a residual hooks.md names.
    if (dir !== '.git/aidrian') assert.ok((bash(`cd ${state} && echo x > ${tracked}`) ?? '').startsWith('Blocked: '), `${dir}: a tracked file after a cd into the state folder`);
    assert.ok((bash(`cd ${state} && cat > handoff.md`) ?? '').startsWith('Blocked: '), `${dir}: a cd into the state folder`);
    assert.ok((bash(`cd ${state} && rm -rf *`) ?? '').startsWith('Blocked: '), `${dir}: a glob after a cd into the state folder`);
    process.env.HOME = home;
  }
  // A state folder that is the main checkout itself is the main checkout: a write there is judged as any other.
  const { repo } = fixture(t, { version: 1, git: { mainCheckout: { guard: true } }, state: { dir: '.' } });
  assert.equal(stateDir(findProject(repo), { env: process.env }), repo);
  for (const command of [`cat > ${repo}/handoff.md`, `cd ${repo} && cat > handoff.md`]) {
    assert.match(check(command, { cwd: repo, env: ENV }) ?? '', /^Blocked: this command writes 'handoff\.md', a tracked file/, command);
  }
});

test('a cd reads its folder past --, and followCd keeps the folder before it', () => {
  const files = bashWrites('cd -- build && echo x > a.txt', '/repo', { followCd: true }).flatMap((write) => write.files);
  assert.ok(files.includes('/repo/build/a.txt'), JSON.stringify(files));
  assert.ok(files.includes('/repo/a.txt'), 'a cd that may fail leaves the shell where it was');
});

test('the Bash hook blocks a commit after a cd that leaves the repository', (t) => {
  const { repo } = fixture(t);
  const run = spawnSync(process.execPath, [path.join(SCRIPTS, 'hook-bash.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'cd /tmp && git commit -m init' }, cwd: repo }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /^Blocked: `git commit` runs after a cd that leaves the repository, or that this rule cannot read\. The cd is `cd \/tmp`/);
});
