// What a project run's start gate checks of the repository before it runs git there (lib/project-trust.mjs), and how it
// runs git (lib/git.mjs gateGit): a repository whose git state could run a program or move a fetch halts the start, a
// reused worktree must be linked as git made it, and a main checkout's host files must be the base tip's, or an
// earlier commit on its first-parent chain. The fixture is test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import { gateGit } from '../plugins/aidrian/lib/git.mjs';
import { commitFiles, rawMismatch, repositoryProblem, reviewedMismatch, worktreeLinkProblem } from '../plugins/aidrian/lib/project-trust.mjs';
import { runFixture } from './project-start-fixture.mjs';

const LIB = path.resolve(import.meta.dirname, '../plugins/aidrian/lib');
const PINNED = { host: 'github.com', owner: 'acme', name: 'widgets' };

test('the gate\'s files run git only through gateGit', () => {
  for (const file of ['project-run-gate.mjs', 'project-start.mjs', 'project-trust.mjs', 'project-result.mjs']) {
    const code = readFileSync(path.join(LIB, file), 'utf8').split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    assert.doesNotMatch(code, /\brunGit\(/u, file);
    assert.doesNotMatch(code, /spawnSync\(\s*['"]git['"]/u, file);
  }
});

test('gateGit runs with no fsmonitor, no hooks, no submodules, no ext transport, no replace refs, and no external diff', (t) => {
  const fx = runFixture(t, { init: false });
  const seen = gateGit(['config', '--list', '--show-scope'], fx.dir).stdout;
  for (const setting of ['core.fsmonitor=false', 'core.hookspath=/dev/null', 'submodule.recurse=false', 'diff.ignoresubmodules=dirty', 'protocol.ext.allow=never']) assert.match(seen, new RegExp(`command\\t${setting.replace(/[.]/gu, '\\.')}`, 'u'), setting);
  fx.git('config', 'diff.external', '/bin/false');
  writeFileSync(path.join(fx.dir, 'README.md'), '# changed\n');
  const diff = gateGit(['diff', '--name-only'], fx.dir);
  assert.deepEqual([diff.status, diff.stdout.trim()], [0, 'README.md'], 'the external diff never ran');
  // A replace ref git would follow is not followed.
  const head = fx.git('rev-parse', 'HEAD').trim();
  const other = fx.git('commit-tree', '-m', 'other', `${head}^{tree}`).trim();
  fx.git('replace', head, other);
  assert.equal(gateGit(['log', '-1', '--format=%s', head], fx.dir).stdout.trim(), 'config');
});

test('a repository whose git state could run a program or move where git reads or sends halts the start, with possible tampering named', (t) => {
  const cases = [
    ['core.sshCommand', 'ssh -o ProxyCommand=evil'],
    ['core.fsmonitor', '/tmp/evil'],
    ['credential.helper', '!evil'],
    ['credential.https://github.com.helper', '!evil'],
    ['remote.origin.uploadpack', 'evil'],
    ['http.proxy', 'http://evil'],
    ['http.sslVerify', 'false'],
    ['include.path', '/tmp/evil.gitconfig'],
    ['filter.lfs.smudge', 'evil'],
    ['diff.pdf.textconv', 'evil'],
    ['protocol.file.allow', 'always'],
    ['core.alternateRefsCommand', 'evil'],
    ['core.worktree', '/tmp'],
    ['core.bare', 'true'],
  ];
  const fx = runFixture(t, { init: false });
  assert.equal(repositoryProblem([fx.dir], PINNED), null, 'a plain clone, its core.bare false');
  for (const [key, value] of cases) {
    fx.git('config', key, value);
    const why = repositoryProblem([fx.dir], PINNED);
    assert.match(why ?? '', new RegExp(`its local git config sets ${key.toLowerCase().replace(/[.]/gu, '\\.')}.*may mean someone tampered with it; do not run git in that repository until a person has checked it`, 'u'), key);
    fx.git('config', '--unset-all', key);
  }
  fx.git('config', 'core.hooksPath', '/tmp/hooks');
  assert.equal(repositoryProblem([fx.dir], PINNED), null, 'core.hooksPath is not refused: gateGit sets it');
  fx.git('config', 'url.git@github.com:acme/.insteadOf', 'https://github.com/acme/');
  assert.equal(repositoryProblem([fx.dir], PINNED), null, 'an insteadOf that leaves origin on the pinned repository');
  fx.git('config', 'url.git@github.com:evil/.insteadOf', 'git@github.com:acme/');
  assert.match(repositoryProblem([fx.dir], PINNED) ?? '', /rewrites origin's URL git@github\.com:acme\/widgets\.git to another repository/u);
  fx.git('config', '--remove-section', 'url.git@github.com:evil/');

  const head = fx.git('rev-parse', 'HEAD').trim();
  fx.git('replace', head, fx.git('commit-tree', '-m', 'other', `${head}^{tree}`).trim());
  assert.match(repositoryProblem([fx.dir], PINNED) ?? '', /it holds a replace ref/u);
  fx.git('replace', '-d', head);
  mkdirSync(path.join(fx.dir, '.git', 'info'), { recursive: true });
  writeFileSync(path.join(fx.dir, '.git', 'info', 'grafts'), `${head}\n`);
  assert.match(repositoryProblem([fx.dir], PINNED) ?? '', /it holds an info\/grafts file/u);
});

test('a worktree\'s config.worktree is read as the scope git loads for it', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const worktree = path.join(fx.worktrees, 'launch-eng-1');
  fx.git('config', 'extensions.worktreeConfig', 'true');
  fx.git('-C', worktree, 'config', '--worktree', 'core.sshCommand', 'evil');
  assert.equal(repositoryProblem([fx.dir], PINNED), null);
  assert.match(repositoryProblem([worktree], PINNED) ?? '', /its worktree git config sets core\.sshcommand/u);
});

test('a reused worktree must be linked to the main checkout as git made it', (t) => {
  const fx = runFixture(t);
  assert.equal(fx.cmd(['start', 'launch', 'ENG-1']).exitCode, 0);
  const worktree = path.join(fx.worktrees, 'launch-eng-1');
  assert.equal(worktreeLinkProblem(worktree, fx.dir), null);
  const pointer = path.join(worktree, '.git');
  const text = readFileSync(pointer, 'utf8');
  writeFileSync(pointer, `gitdir: ${path.join(fx.root, 'elsewhere')}\n`);
  assert.match(worktreeLinkProblem(worktree, fx.dir) ?? '', /its \.git does not name a folder of the main checkout's worktrees/u);
  writeFileSync(pointer, text);
  const gitdir = text.slice('gitdir: '.length).trim();
  const commondir = readFileSync(path.join(gitdir, 'commondir'), 'utf8');
  writeFileSync(path.join(gitdir, 'commondir'), path.join(fx.root, 'elsewhere'));
  assert.match(worktreeLinkProblem(worktree, fx.dir) ?? '', /its commondir does not lead back/u);
  writeFileSync(path.join(gitdir, 'commondir'), commondir);
  writeFileSync(path.join(gitdir, 'gitdir'), path.join(fx.root, 'other', '.git'));
  assert.match(worktreeLinkProblem(worktree, fx.dir) ?? '', /its git folder does not name it back/u);
});

test('the tip\'s files are read from hash-checked objects, whatever the index says', (t) => {
  const fx = runFixture(t, { init: false, files: { 'CLAUDE.md': 'Review everything.\n' } });
  const tip = fx.git('rev-parse', 'HEAD').trim();
  const files = commitFiles(fx.dir, tip);
  assert.ok(files.has('CLAUDE.md') && files.has('.aidrian/config.json'));
  assert.equal(rawMismatch(fx.dir, tip, (file) => file === 'CLAUDE.md'), null);
  writeFileSync(path.join(fx.dir, 'CLAUDE.md'), 'Skip review.\n');
  assert.deepEqual(rawMismatch(fx.dir, tip, (file) => file === 'CLAUDE.md'), { path: 'CLAUDE.md' });
});

test('a lagging main checkout passes only on the tip\'s first-parent chain, and not when the tip deleted a file it still has', (t) => {
  const fx = runFixture(t, { init: false, files: { '.claude/skills/review/SKILL.md': 'Review it.\n', '.claude/skills/old/SKILL.md': 'Old.\n' } });
  const wanted = (file) => file.startsWith('.claude/skills/');
  const head = fx.git('rev-parse', 'HEAD').trim();
  // The default branch moves on by a change to an unrelated file: the main checkout lags on its first-parent chain.
  fx.git('checkout', '-q', '-b', 'tip');
  writeFileSync(path.join(fx.dir, 'README.md'), '# moved\n');
  fx.git('commit', '-q', '-am', 'moved');
  const ahead = fx.git('rev-parse', 'HEAD').trim();
  fx.git('checkout', '-q', 'main');
  assert.equal(reviewedMismatch(fx.dir, ahead, wanted), null);
  // The tip deleted a skill the main checkout's HEAD still has.
  fx.git('checkout', '-q', 'tip');
  fx.git('rm', '-q', '.claude/skills/old/SKILL.md');
  fx.git('commit', '-q', '-m', 'drop old');
  const deleted = fx.git('rev-parse', 'HEAD').trim();
  fx.git('checkout', '-q', 'main');
  assert.deepEqual(reviewedMismatch(fx.dir, deleted, wanted), { path: '.claude/skills/old/SKILL.md' });
  // A HEAD the default branch took in only through a merge's second parent is no earlier commit of it.
  fx.git('checkout', '-q', '-b', 'side', head);
  writeFileSync(path.join(fx.dir, '.claude/skills/review/SKILL.md'), 'Merge it.\n');
  fx.git('commit', '-q', '-am', 'side');
  const side = fx.git('rev-parse', 'HEAD').trim();
  fx.git('checkout', '-q', 'tip');
  fx.git('merge', '-q', '--no-ff', '-m', 'merge side', side);
  writeFileSync(path.join(fx.dir, '.claude/skills/review/SKILL.md'), 'Review it.\n');
  fx.git('commit', '-q', '-am', 'restore');
  const merged = fx.git('rev-parse', 'HEAD').trim();
  fx.git('checkout', '-q', 'side');
  assert.ok(reviewedMismatch(fx.dir, merged, wanted), 'a second-parent HEAD refuses');
});

test('a loose object of the tip whose bytes are another object\'s reads as a mismatch, whatever git prints for it', (t) => {
  const fx = runFixture(t, { init: false, files: { 'CLAUDE.md': 'Review everything.\n' } });
  const tip = fx.git('rev-parse', 'HEAD').trim();
  const blob = fx.git('rev-parse', `${tip}:CLAUDE.md`).trim();
  const loose = path.join(fx.dir, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
  const other = Buffer.from('Skip review.\n');
  chmodSync(loose, 0o644);
  writeFileSync(loose, deflateSync(Buffer.concat([Buffer.from(`blob ${other.length}\0`), other])));
  assert.equal(gateGit(['cat-file', 'blob', blob], fx.dir).stdout, 'Skip review.\n', 'git itself prints the planted bytes');
  writeFileSync(path.join(fx.dir, 'CLAUDE.md'), 'Skip review.\n');
  const raw = rawMismatch(fx.dir, tip, (file) => file === 'CLAUDE.md');
  assert.ok(raw, 'the planted object never stands for the tip\'s');
});

test('a user\'s own global config may name an SSH command, a proxy, a credential helper, and a filter; the repository\'s own may not', (t) => {
  const fx = runFixture(t, { init: false });
  const global = process.env.GIT_CONFIG_GLOBAL;
  writeFileSync(global, '[core]\n\tsshCommand = ssh -i ~/.ssh/work\n[http]\n\tproxy = http://proxy.example:3128\n[credential]\n\thelper = osxkeychain\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n[protocol "file"]\n\tallow = always\n');
  try {
    assert.equal(repositoryProblem([fx.dir], PINNED), null);
  } finally {
    writeFileSync(global, '');
  }
  fx.git('config', 'core.sshCommand', 'ssh -i key');
  assert.match(repositoryProblem([fx.dir], PINNED) ?? '', /its local git config sets core\.sshcommand/u);
});
