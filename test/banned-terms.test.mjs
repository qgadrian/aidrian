import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { lexCommand, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';
import { bannedHits, bannedPatterns, judgeCommand, prePushProblems, published } from '../scripts/banned-terms.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/banned-terms.mjs');
const patterns = [/\bzq-\d+/iu, /secretco/iu];

test('a private word matches in any case', () => {
  assert.deepEqual(bannedHits('fix: ZQ-12 and SecretCo', patterns), ['/\\bzq-\\d+/iu', '/secretco/iu']);
  assert.deepEqual(bannedHits('fix: azq-12', patterns), []);
});

test('body and message files are read from each way gh and git take one; reads publish nothing', () => {
  const files = (command) => published(readInvocation(lexCommand(command)[0]))?.files.map(({ text }) => text) ?? null;
  for (const [command, expected] of [
    ['gh pr create --body-file a.md', ['a.md']],
    ['gh pr edit 1 --body-file=b.md', ['b.md']],
    ['gh issue create -F c.md -F "$X" --body-file -', ['c.md', '$X', '-']],
    ['gh pr create -F=d.md', ['d.md']],
    ['gh pr create -dF e.md', ['e.md']],
    ['gh issue comment 3 -Ff.md', ['f.md']],
    ['git -C x commit -F g.txt', ['g.txt']],
    ['git commit --file=h.txt', ['h.txt']],
    ['gh pr view 1 --json body', null],
    ['gh issue list --search x', null],
    ['git log --grep commit', null],
  ]) assert.deepEqual(files(command), expected, command);
});

test('a gh or git commit command is judged by its text and its body file; other commands are not read', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'bad.md'), '## Summary\nCloses ZQ-7.\n');
  writeFileSync(path.join(dir, 'good.md'), '## Summary\nfine\n');
  const judge = (command, cwd = dir) => judgeCommand(command, { cwd, patterns });
  assert.match(judge('gh pr create --title "fix ZQ-1" --body-file good.md'), /zq/);
  assert.match(judge('gh pr edit 5 --body-file bad.md'), /in bad\.md/);
  assert.match(judge(`cd ${dir} && gh pr create -t x -F bad.md`, '/'), /in bad\.md/, 'a leading cd moves the body file');
  assert.match(judge('git -C x commit -m "secretco fix"'), /secretco/);
  assert.equal(judge('gh pr create --title fix --body-file good.md'), null);
  assert.equal(judge('grep -r ZQ-1 .'), null, 'a search is not published');
  writeFileSync(path.join(dir, 'secretco.md'), 'fine\n');
  assert.equal(judge(`gh pr create --title fix --body-file ${dir}/secretco.md`), null, "a body file's path is read, never published");
  assert.equal(judge(`cd ${dir} && gh pr create --title fix -F secretco.md`, '/'), null, 'nor is a leading cd target');
  assert.match(judge('gh pr create --title "fix /secretco migration" --body-file good.md'), /secretco/, 'a path-shaped title still counts');
  assert.match(judge('gh issue create --body "See /secretco/private"'), /secretco/, 'a path-shaped body still counts');
  assert.match(judge('gh --repo o/r pr create --title secretco --body ok'), /secretco/, '--repo before the subcommand');
  assert.match(judge('gh -Ro/r issue create --title secretco --body ok'), /secretco/, '-R attached');
  assert.match(judge('gh pr create -t x -dF bad.md'), /in bad\.md/, 'a short cluster');
  for (const quoted of [`"${dir}"`, `'${dir}'`]) assert.match(judge(`cd ${quoted} && gh issue create -F bad.md`, '/'), /in bad\.md/, 'a quoted cd');
  assert.match(judge('gh pr create --title "$(cat <<\'EOF\'\nfix secretco\nEOF\n)" -F good.md'), /secretco/, 'a heredoc body');
  for (const hidden of [`cd / && cd ${dir} && gh pr create -F bad.md`, `cd ${dir}; gh pr create -F bad.md`, `(cd ${dir}) && gh issue create -F bad.md`]) {
    assert.match(judge(hidden, '/'), /unchecked file bad\.md/, `${hidden}: a folder it cannot know`);
  }
  assert.match(judge(`gh pr create -F good.md && gh issue create -F bad.md`), /in bad\.md/, 'every publishing command');
  assert.equal(judge('gh pr view 1 --json body | rg secretco'), null, 'a read is not published');
  assert.equal(judge('rg secretco . && git commit -m fine'), null, 'nor is a search beside a clean commit');
  assert.match(judge("gh issue create -t fine -F - <<'EOF'\nsecretco\nEOF"), /on its input/, 'a heredoc on stdin');
  assert.match(judge('git commit -F - <<< "secretco"'), /on its input/, 'a here-string on stdin');
  assert.match(judge("bash -lc 'gh issue create --title fine --body secretco'"), /secretco/, 'an inline shell');
  assert.match(judge("bash <<'EOF'\ngh pr create --title secretco --body ok\nEOF"), /secretco/, 'a shell reading its input');
  mkdirSync(path.join(dir, 'B'));
  writeFileSync(path.join(dir, 'B', 'good.md'), 'secretco\n');
  assert.match(judge('cd B && url=$(gh issue create -F good.md)'), /in good\.md/, 'a substitution keeps the folder of its command');
  assert.match(judge('git -C B commit -F good.md'), /in good\.md/, "git's -C");
  assert.match(judge("gh issue create -t '-Rsecretco' -b clean"), /secretco/, 'a value shaped like an option is published');
  assert.match(judge("git commit -m '-Fsecretco'"), /secretco/);
  assert.match(judge('gh pr create --title -Rsecretco --body ok'), /secretco/);
  for (const global of ['--git-dir .git', '--work-tree .', '--namespace x', '--config-env a=B']) {
    assert.match(judge(`git ${global} commit --allow-empty -m secretco`), /secretco/, `git ${global}`);
  }
  for (const repo of ['--repo=secretco/r', '--repo secretco/r', '-Rsecretco/r', '-R secretco/r']) {
    assert.equal(judge(`gh issue create ${repo} -t fine -b fine`), null, `${repo} is not published`);
  }
  mkdirSync(path.join(dir, 'real', 'nested'), { recursive: true });
  writeFileSync(path.join(dir, 'real', 'body.md'), 'secretco\n');
  symlinkSync(path.join(dir, 'real', 'nested'), path.join(dir, 'link'));
  assert.match(judge('cd link && gh issue create -F ../body.md'), /in \.\.\/body\.md/, "a symlinked folder's .. is its target's parent");
});

test('the commit-msg hook refuses a private word and ignores comment lines', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const msg = path.join(dir, 'MSG');
  writeFileSync(msg, 'fix: thing\n# ------------------------ >8 ------------------------\n-removed zq-1\n');
  assert.equal(spawnSync('node', [SCRIPT, 'commit-msg', msg], { cwd: dir }).status, 0, 'a verbose diff below the scissors is skipped');
});

test('the git hooks call the script', () => {
  for (const hook of ['commit-msg', 'pre-push']) {
    assert.match(execFileSync('cat', [path.join(ROOT, '.githooks', hook)], { encoding: 'utf8' }), new RegExp(`banned-terms\\.mjs" ${hook}`));
  }
});

test("a linked worktree reads the main checkout's private patterns, which git does not copy", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  const git = (...args) => execFileSync('git', args, { cwd: main, stdio: 'ignore' });
  execFileSync('git', ['init', '-q', main]);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  writeFileSync(path.join(main, '.banned-terms.local'), '# private\nzq-\\d+\n');
  git('worktree', 'add', '-q', path.join(dir, 'wt'));
  assert.ok(bannedPatterns(path.join(dir, 'wt')).some((pattern) => pattern.test('ZQ-4')));
});

test("a push is judged on its branch names and on the commits its destination does not have", (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-banned-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'fix zq-1');
  const old = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', old);
  git('commit', '-q', '--allow-empty', '-m', 'fine');
  const head = git('rev-parse', 'HEAD');
  const push = (ref, remote) => prePushProblems(`refs/heads/${ref} ${head} refs/heads/${ref} ${'0'.repeat(40)}\n`, remote, { cwd: dir, patterns });
  assert.deepEqual(push('topic', 'origin'), [], "origin already has the private commit");
  assert.equal(push('topic', 'public').length, 1, 'another remote does not');
  assert.equal(push('zq-2-topic', 'origin').length, 1, 'a branch name');
});
