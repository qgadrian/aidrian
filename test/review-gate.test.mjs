import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { awaitReview, runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { asksForReview, markerFor, OVERRIDE, readRecord, writeRecord } from '../plugins/aidrian/lib/review-gate.mjs';
import { check } from '../plugins/aidrian/lib/rules/github/review-request.mjs';

const STATE = process.env.XDG_STATE_HOME;
after(() => (STATE === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = STATE)));

const CLI = path.resolve('plugins/aidrian/lib/cli.mjs');
const GATE = { version: 1, github: { reviewGate: { enabled: true, checklist: 'docs/review-checklist.md' } } };

// A git repository with an origin and one commit, holding a project folder with `config`.
function repo(t, config = GATE, origin = 'git@github.com:Acme/Notes.git') {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gate-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The state folder is keyed by the origin, which every repository here shares: each gets its own.
  process.env.XDG_STATE_HOME = path.join(dir, '.state');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', origin);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const project = projectAt(dir);
  return { dir, project, head: git('rev-parse', 'HEAD'), run: (command, env = {}) => check(command, { cwd: dir, env }), write: (name, text) => writeFileSync(path.join(dir, name), text) };
}

const reviewed = (project, pr) => writeRecord(project, { pr, repo: 'acme/notes', head: 'abcdef1', reviewer: 'code-reviewer', findings: 1, fixed: 1, note: null });

test('a request is a body asking @codex review outside code and quotes', () => {
  assert.equal(asksForReview('@codex review'), true);
  assert.equal(asksForReview('please, @Codex security review this'), true);
  assert.equal(asksForReview('`@codex review` is the trigger'), false);
  assert.equal(asksForReview('> @codex review\nthanks'), false);
  assert.equal(asksForReview('```\n@codex review\n```'), false);
  assert.equal(asksForReview('@codex reviewer'), false);
});

test('gh comment requests are refused until a review is on record, in every way gh takes a body', (t) => {
  const { run, project, write } = repo(t);
  write('req.md', '@codex review\n');
  write('req.json', JSON.stringify({ body: '@codex review' }));
  const commands = [
    'gh pr comment 5 --body "@codex review"',
    'gh pr comment 5 -b"@codex review"',
    'gh issue comment 5 --body-file req.md',
    "gh pr review 5 --comment -b '@codex review'",
    `gh pr comment 5 --body "$(cat <<'EOF'\n@codex review\nEOF\n)"`,
    'gh api repos/acme/notes/issues/5/comments -f body="@codex review"',
    'gh api repos/{owner}/{repo}/issues/5/comments -F body=@req.md',
    'gh api -X POST repos/acme/notes/issues/5/comments --input req.json',
    'git push && gh pr comment https://github.com/acme/notes/pull/5 -b "@codex review"',
    'gh pr edit 5 --add-reviewer chatgpt-codex-connector',
    'gh issue comment https://github.com/acme/notes/issues/5 --body "@codex review"',
  ];
  for (const command of commands) assert.match(run(command) ?? 'passed', /^Blocked: this asks the review bot to review pull request #5,/, command);
  assert.match(run(commands[0]), /against docs\/review-checklist\.md/);
  assert.match(run(commands[0]), /aidrian pr attest 5 --head <sha>/);
  reviewed(project, 5);
  for (const command of commands) assert.equal(run(command), null, command);
});

test('what is not a request to this repository passes; a request without a number is refused', (t) => {
  const { run } = repo(t);
  for (const command of [
    'gh pr comment 5 --body "LGTM"',
    'gh pr comment 5 --body "`@codex review` is how to ask"',
    'gh api repos/acme/notes/issues/5/comments --jq ".[].body"',
    'gh api -X GET repos/acme/notes/issues/5/comments -f body="@codex review"',
    'gh pr comment 5 -R other/repo -b "@codex review"',
    'gh issue comment https://github.com/other/repo/issues/5 -b "@codex review"',
    'gh pr comment 5 --body-file - ',
    'echo "gh pr comment 5 -b @codex review"',
    'gh pr edit 5 --add-reviewer someone',
  ]) assert.equal(run(command), null, command);
  assert.match(run('gh pr comment -b "@codex review"'), /the pull request number could not be read/);
  assert.match(run('gh pr create -t x -b y --reviewer chatgpt-codex-connector[bot]'), /could not be read/, 'a new pull request has no review yet');
});

test('a marker for this pull request and repository passes; one for another does not', (t) => {
  const { run } = repo(t);
  const marker = (pr, repoName) => markerFor({ pr, repo: repoName, head: 'abcdef1', reviewer: 'x', findings: 0, fixed: 0 });
  assert.equal(run(`gh pr comment 5 -b "@codex review ${marker(5, 'acme/notes')}"`), null);
  assert.match(run(`gh pr comment 5 -b "@codex review ${marker(6, 'acme/notes')}"`), /^Blocked/);
  assert.match(run(`gh pr comment 5 -b "@codex review ${marker(5, 'other/notes')}"`), /^Blocked/);
});

test('the override passes the request and records itself for the pull request', (t) => {
  const { run, project } = repo(t);
  assert.equal(run('gh pr comment 9 -b "@codex review"', { [OVERRIDE]: '1' }), null);
  assert.equal(readRecord(project, 9).reviewer, 'override');
  assert.equal(run('gh pr comment 9 -b "@codex review"'), null);
});

test('the gate is off by default', (t) => {
  const { run } = repo(t, { version: 1 });
  assert.equal(run('gh pr comment 5 -b "@codex review"'), null);
  assert.deepEqual(loadConfig(projectAt(repo(t, { version: 1 }).dir)).config.github.reviewGate, { enabled: false, checklist: null });
});

test('aidrian pr attest records the review and prints the marker; --check reads it', (t) => {
  const { dir, head, project } = repo(t);
  const run = (...args) => spawnSync(process.execPath, [CLI, 'pr', 'attest', ...args], { cwd: dir, encoding: 'utf8', env: process.env });
  assert.equal(run('7', '--check').status, 3);
  assert.match(run('7', '--head', 'deadbee', '--reviewer', 'r', '--findings', '0', '--fixed', '0').stderr, /--head deadbee is not a commit/);
  assert.match(run('7', '--head', head, '--reviewer', 'r', '--findings', '1', '--fixed', '2').stderr, /--fixed cannot exceed --findings/);
  const done = run('#7', '--head', head, '--reviewer', 'code-reviewer', '--findings', '2', '--fixed', '1');
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, new RegExp(`<!-- aidrian-review: pr=7 repo=acme/notes head=${head} reviewer=code-reviewer findings=2 fixed=1 -->`));
  assert.equal(run('7', '--check').status, 0);
  assert.equal(readRecord(project, 7).head, head);
});

// A gh that answers the reads of one pull request with nothing, and records its posts.
const quietGh = () => {
  const posts = [];
  return {
    posts,
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 5 }),
    api: (p, { method, fields } = {}) => {
      if (method === 'POST') return posts.push(fields.body) && { created_at: '2026-08-23T07:00:00Z' };
      if (p.endsWith('/pulls/5')) return { head: { sha: 'abcdef1234' } };
      if (p.includes('/commits/')) return { commit: { committer: { date: '2026-08-23T06:00:00Z' } } };
      return [];
    },
  };
};

test('aidrian pr await-review --request posts nothing without a review, and carries the marker with one', async (t) => {
  const { project } = repo(t);
  const config = loadConfig(project).config;
  const gh = quietGh();
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  const opts = ['5', '--request', '--timeout-sec', '0'];
  assert.equal(await runAwaitReview(opts, config, project, { gh }), 5);
  assert.deepEqual(gh.posts, []);
  reviewed(project, 5);
  assert.equal(await runAwaitReview(opts, config, project, { gh }), 2);
  assert.equal(gh.posts.length, 1);
  assert.match(gh.posts[0], /^@codex review/);
  assert.match(gh.posts[0], /<!-- aidrian-review: pr=5 repo=acme\/notes head=abcdef1 reviewer=code-reviewer findings=1 fixed=1 -->$/);
  const plain = await awaitReview({ pr: '5', repo: null, reviewer: 'bot', request: true, timeoutSec: 0, intervalSec: 60 }, { gh: quietGh() });
  assert.equal(plain.status, 'timed_out', 'without a gate the request posts as before');
});

test('the MCP hook holds the gate for the GitHub comment tools', (t) => {
  const { dir, project } = repo(t);
  const hook = (toolInput, tool = 'mcp__github__add_issue_comment') =>
    spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-mcp-github.mjs'], {
      input: JSON.stringify({ tool_name: tool, cwd: dir, tool_input: toolInput }),
      encoding: 'utf8',
      env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
    });
  const denied = hook({ owner: 'acme', repo: 'notes', issue_number: 5, body: '@codex review' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /pull request #5/);
  assert.equal(hook({ owner: 'other', repo: 'x', issue_number: 5, body: '@codex review' }).status, 0);
  assert.equal(hook({ owner: 'acme', repo: 'notes', pullNumber: 5, body: 'thanks' }, 'mcp__github__pull_request_review_write').status, 0);
  reviewed(project, 5);
  assert.equal(hook({ owner: 'acme', repo: 'notes', issue_number: 5, body: '@codex review' }).status, 0);
});
