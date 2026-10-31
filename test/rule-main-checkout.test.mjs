import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { bashTargets, bashWrites, check, checkTool } from '../plugins/aidrian/lib/rules/main-checkout.mjs';

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
    'git commit -am x', 'git commit -am"fix: x"', 'git commit --all -m x', 'git commit --dry-run --no-dry-run -am x',
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
    'git add src/app.js', 'git add -v src/app.js gone.txt', 'git commit -m x', 'git commit -mrelease', 'git commit -uall -m x',
    'git commit -Sabc123 -m x', 'git switch main', 'git checkout main', 'git checkout src/app.js', 'git checkout -- src/app.js',
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
  execFileSync('git', ['-C', repo, 'rm', '-q', '--cached', 'src/app.js']);
  execFileSync('git', ['-C', repo, 'add', 'src/app.js']);
  rmSync(path.join(repo, 'src'), { recursive: true, force: true });
  assert.match(denied('git add src') ?? '', /main checkout/, 'a tracked folder deleted from disk');
  assert.equal(denied('git add src/app.js'), null, 'one deleted file by name');
  const off = fixture(t, { version: 1 }).repo;
  assert.equal(check('git add -A', { cwd: off, env: ENV }), null, 'the guard is off');
});
