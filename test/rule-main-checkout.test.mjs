import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { bashTargets, check, checkTool } from '../plugins/aidrian/lib/rules/main-checkout.mjs';

const SCRIPTS = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts');
const ENV = {};

// A repository whose project folder turns the guard on, with a tracked src/app.js, an ignored build/, a worktree inside
// it (wt/task, ignored), one beside it, and one inside it that git does not ignore (open/task).
function fixture(t, config = { version: 1, mainCheckout: { guard: true } }) {
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
  assert.match(reason, /git worktree add "\S+\/repo\/\.worktrees\/<branch>" -b <branch>/);
  assert.match(reason, /"mainCheckout": \{ "guard": true \} in \S+\/\.aidrian\/config\.json/);
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

test('allowWrites globs, the guard off by default or by config, the override, and no project folder allow the write', (t) => {
  const globs = fixture(t, { version: 1, mainCheckout: { guard: true, allowWrites: ['notes/**', 'docs/*.md', '**/*.snap'] } }).repo;
  assert.equal(edit(path.join(globs, 'notes/a/b.md'), globs), null);
  assert.equal(edit(path.join(globs, 'docs/x.md'), globs), null);
  assert.equal(edit(path.join(globs, 'src/__snapshots__/a.snap'), globs), null);
  assert.match(edit(path.join(globs, 'docs/sub/x.md'), globs), /'docs\/sub\/x\.md'/, '* stays in one segment');

  for (const config of [{ version: 1 }, { version: 1, mainCheckout: { guard: false } }]) {
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
  assert.deepEqual(at("sed -i '' -e 's/a/b/' src/a.ts"), ['src/a.ts'], 'BSD sed`s empty suffix');
  assert.deepEqual(at("sed -n 's/a/b/p' src/a.ts"), [], 'sed without -i only prints');
  assert.deepEqual(at('tee -a src/a.ts src/b.ts'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(at('cp /tmp/a.ts src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('mv -f src/a.ts src/b.ts'), ['src/b.ts']);
  assert.deepEqual(at('rm -f src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('rm -rf src'), ['src']);
  assert.deepEqual(at('touch -d "2 days ago" src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('mkdir -p -m 755 src/new'), ['src/new']);
  assert.deepEqual(at("cat > /tmp/out.md <<'EOF'\nrm -rf src\nEOF\ngit status"), ['../tmp/out.md'], 'a heredoc body is data');
  assert.deepEqual(at('sudo rm src/a.ts'), ['src/a.ts']);
  assert.deepEqual(at('env -C src rm ../package.json'), ['package.json'], 'a wrapper`s directory moves its operands');
  assert.deepEqual(at('env -C src cmd > ../out'), ['../out'], 'but not the shell`s redirections');
  for (const command of ['git status', 'cat src/a.ts', 'git restore src/a.ts', 'npm run build', 'node scripts/x.mjs', 'ls -la']) {
    assert.deepEqual(at(command), [], command);
  }
  assert.deepEqual(at('echo hi > "$OUT/a.ts"'), [], 'a path that may expand');
  assert.deepEqual(at('echo hi > src/*.ts'), []);
  assert.deepEqual(at('cd /tmp && echo hi > a.ts'), [], 'a relative target after cd');
  assert.deepEqual(at('cd /tmp && echo hi > /repo/a.ts'), ['a.ts'], 'an absolute one still counts');
  assert.deepEqual(at('env -C "$DIR" rm x'), []);
});

test('Bash commands are judged like tool writes', (t) => {
  const { repo } = fixture(t);
  const bash = (command, cwd = repo) => check(command, { cwd, env: ENV });
  assert.match(bash('echo x > src/app.js'), /^Blocked: this command writes 'src\/app\.js', a tracked file/);
  assert.match(bash("cat > src/new.js <<'EOF'\nexport {};\nEOF"), /'src\/new\.js'/);
  assert.match(bash('git status && rm src/app.js'), /'src\/app\.js'/);
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
