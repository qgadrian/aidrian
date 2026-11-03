import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { runAttest } from '../plugins/aidrian/lib/review-gate.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { markRequestsSent, recordPending, runRequest } from '../plugins/aidrian/lib/review/pending.mjs';
import { emptyState, noteOutcome, readLocalState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check, checkMcp, readMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { lexCommand, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const NEXT = '1234567890abcdef1234567890abcdef12345678';

// A git repository with an origin and one commit, holding a project whose state folder is inside it (never a real
// repository's, and no GIT_DIR), and a transcript file for the hook payload.
function repo(t, config = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-merge-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, ...config }));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  const project = projectAt(dir);
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  const views = [];
  // The gh seam: records each lookup; `head` null is a gh that does not answer in time.
  const viewer = (head = HEAD) => (target, where) => (views.push([target, where]), head === null ? null : { number: Number(target ?? 5), headRefOid: head });
  const run = (command, { head = HEAD } = {}) => check(command, { cwd: dir, env: {}, input: { transcript_path: transcript }, viewPr: viewer(head) });
  const answer = (question, label, timestamp) => writeFileSync(transcript, `${JSON.stringify({ type: 'user', timestamp, toolUseResult: { answers: { [question]: label } } })}\n`);
  const record = (pr, edit) => {
    const state = emptyState(pr, 'acme/notes');
    edit(state);
    writeLocalState(project, state);
  };
  return { dir, git, project, transcript, views, viewer, run, answer, record, commit: git('rev-parse', 'HEAD') };
}

const owe = (state, kind, at = '2026-11-03T13:50:00.000Z') => state.pending.push({ kind, head: HEAD, at, by: 'the Human' });
const outcome = (state, status, head = HEAD, at = '2026-11-03T14:00:00.000Z') => (state.outcome = { status, head, at });

test('the incident: a merge while the gate review runs and the requested bot review was never sent is refused', (t) => {
  const r = repo(t);
  // The Human asked for the bot review; the gate review the repo requires first was dispatched and still running.
  r.record(5984, (state) => {
    state.rounds.push({ head: HEAD });
    outcome(state, 'dispatch');
    owe(state, 'request');
    owe(state, 'review');
  });
  const reason = r.run('gh pr view 5984 && gh pr merge 5984 --squash --delete-branch');
  assert.match(reason ?? '', /pull request #5984 at abcdef1/u);
  assert.match(reason, /never sent: send it with `aidrian pr await-review 5984 --request`/u);
  assert.match(reason, /does not cancel it/u);
  assert.match(reason, /no result on record/u);
  assert.match(reason, /"Merge anyway"/u);
  // Through the Bash hook itself, as the host runs it: blocked, exit 2.
  const hook = spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-bash.mjs'], {
    input: JSON.stringify({ tool_name: 'Bash', cwd: r.dir, tool_input: { command: `gh pr view 5984 && gh pr merge 5984 --squash --match-head-commit ${HEAD}` } }),
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
  });
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /never sent/u);
});

test('an entry still owed refuses the merge whatever the outcome, and none at all', (t) => {
  const r = repo(t);
  r.record(5, (state) => (outcome(state, 'none_needed'), owe(state, 'request')));
  assert.match(r.run('gh pr merge 5') ?? '', /never sent/u, 'a finished review does not send the request');
  r.record(6, (state) => owe(state, 'request'));
  assert.match(r.run('gh pr merge 6') ?? '', /never sent/u, 'no outcome at all');
  r.record(7, (state) => {
    outcome(state, 'none_needed');
    owe(state, 'request');
    state.pending[0].sent = { at: '2026-11-03T14:05:00.000Z', head: HEAD };
  });
  assert.equal(r.run('gh pr merge 7'), null, 'a request sent is no longer owed');
});

test('a pull request with no review record merges, with no gh call', (t) => {
  const r = repo(t);
  assert.equal(r.run('gh pr merge 5 --squash'), null);
  assert.equal(r.run('gh api -X PUT repos/acme/notes/pulls/5/merge'), null);
  assert.deepEqual(r.views, []);
  r.record(6, (state) => (state.pending.push({ kind: 'request', head: HEAD, at: 'x', by: 'y', sent: { at: 'x', head: HEAD } })));
  assert.equal(r.run('gh pr merge 6'), null, 'only sent entries, and no review step: nothing to guard');
});

test('the head needs a finished outcome on itself', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'received'));
  assert.equal(r.run('gh pr merge 5'), null);
  r.record(6, (state) => outcome(state, 'none_needed'));
  assert.equal(r.run('gh pr merge 6'), null);
  r.record(7, (state) => outcome(state, 'received', NEXT));
  assert.match(r.run('gh pr merge 7') ?? '', /covered 1234567, not head abcdef1.*aidrian pr review 7/u, 'the head moved after review');
  r.record(8, (state) => outcome(state, 'fix_required'));
  assert.match(r.run('gh pr merge 8') ?? '', /is `fix_required`/u);
  r.record(9, (state) => state.rounds.push({ head: HEAD }));
  assert.match(r.run('gh pr merge 9') ?? '', /no finished review of head abcdef1/u, 'rounds from before outcomes were kept');
});

test('a head the guard cannot read refuses the merge, and --match-head-commit needs no gh', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'received'));
  assert.match(r.run('gh pr merge 5', { head: null }) ?? '', /could not read its head commit.*--match-head-commit/u, 'a slow gh');
  assert.match(r.run('gh pr merge --squash', { head: null }) ?? '', /could not read which one/u, 'a bare merge needs the number');
  assert.match(r.run('gh pr merge "$PR"') ?? '', /could not read which one/u, 'a number the rule cannot read');
  r.views.length = 0;
  assert.equal(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`, { head: null }), null);
  assert.equal(r.run(`gh pr merge 5 --match-head-commit=${HEAD.slice(0, 7)}`, { head: null }), null);
  assert.deepEqual(r.views, [], 'given the head, gh is never asked');
  assert.equal(r.run('gh pr merge'), null, 'a bare merge reads the current branch`s pull request');
  assert.deepEqual(r.views.at(-1), [null, null]);
  assert.equal(r.run('gh pr merge 5 --disable-auto', { head: null }), null, 'turning auto-merge off merges nothing');
  assert.equal(r.run('gh pr merge 5 -R other/repo', { head: null }), null, 'another repository is not this record`s');
});

test('the Human`s "Merge anyway" waives it, for that pull request and head, after the outcome', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'running'));
  const question = 'Merge pull request #5 at abcdef1 before its review is finished?';
  assert.ok(r.run('gh pr merge 5'));
  r.answer(question, 'Wait for the review', '2026-11-03T14:10:00.000Z');
  assert.ok(r.run('gh pr merge 5'), 'the Human said wait');
  r.answer(question.replace('abcdef1', '1234567'), 'Merge anyway', '2026-11-03T14:10:00.000Z');
  assert.ok(r.run('gh pr merge 5'), 'an answer about another head');
  r.answer(question.replace('#5', '#55'), 'Merge anyway', '2026-11-03T14:10:00.000Z');
  assert.ok(r.run('gh pr merge 5'), 'an answer about another pull request');
  r.answer(question, 'Merge anyway', '2026-11-03T13:00:00.000Z');
  assert.ok(r.run('gh pr merge 5'), 'an answer older than the outcome');
  r.answer(question, 'Merge anyway', '2026-11-03T14:10:00.000Z');
  assert.equal(r.run('gh pr merge 5'), null);
  assert.ok(check('gh pr merge 5', { cwd: r.dir, env: {}, input: {}, viewPr: r.viewer() }), 'no transcript (Codex): the Human merges in their own shell');
  r.record(6, (state) => (outcome(state, 'received'), owe(state, 'request', '2026-11-03T14:20:00.000Z')));
  r.answer(question.replace('#5', '#6'), 'Merge anyway', '2026-11-03T14:10:00.000Z');
  assert.ok(r.run('gh pr merge 6'), 'an answer older than the request still owed');
});

test('gh api merges are read: a PUT or POST to pulls/<n>/merge', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'running'));
  for (const command of [
    'gh api -X PUT repos/acme/notes/pulls/5/merge',
    'gh api --method=put /repos/Acme/Notes/pulls/5/merge -f merge_method=squash',
    'gh api repos/{owner}/{repo}/pulls/5/merge -f merge_method=squash',
    `gh api -X PUT repos/acme/notes/pulls/5/merge -f sha=${HEAD}`,
  ]) assert.match(r.run(command) ?? '', /pull request #5 at abcdef1/u, command);
  assert.equal(r.run('gh api repos/acme/notes/pulls/5/merge'), null, 'a GET reads whether it merged');
  assert.equal(r.run('gh api -X PUT repos/other/repo/pulls/5/merge'), null, 'another repository');
  const read = (command) => readMerge(readInvocation(lexCommand(command)[0]), {});
  assert.deepEqual(read(`gh api -X PUT repos/acme/notes/pulls/5/merge -f sha=${HEAD}`), { pr: 5, head: HEAD, target: null, repo: 'acme/notes' });
  assert.equal(read('gh pr view 5'), null);
});

test('the MCP merge tool is guarded too', (t) => {
  const r = repo(t);
  r.record(5, (state) => (outcome(state, 'received'), owe(state, 'request')));
  const mcp = (toolInput) => checkMcp(toolInput, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: r.viewer() });
  assert.match(mcp({ owner: 'acme', repo: 'notes', pullNumber: 5 }) ?? '', /never sent/u);
  assert.equal(mcp({ owner: 'acme', repo: 'notes', pullNumber: 6 }), null);
  assert.equal(mcp({ owner: 'other', repo: 'notes', pullNumber: 5 }), null);
  assert.match(mcp({ owner: 'acme', repo: 'notes' }) ?? '', /gh pr merge <PR> --match-head-commit/u);
  const hook = (toolInput) => spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-mcp-github.mjs'], {
    input: JSON.stringify({ tool_name: 'mcp__github__merge_pull_request', cwd: r.dir, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
  });
  const denied = hook({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD });
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /never sent/u);
  assert.equal(hook({ owner: 'acme', repo: 'notes', pullNumber: 6, sha: HEAD }).status, 0);
});

test('aidrian pr request records the request; await-review sends it; attest and a finished review clear a gate review', async (t) => {
  const r = repo(t);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(runRequest(['5', '--head', HEAD], r.project), 0);
  assert.throws(() => runRequest(['5', '--kind', 'bot'], r.project), /--kind must be one of/u);
  assert.throws(() => runRequest(['5'], r.project, { viewPr: () => null }), /pass --head/u);
  assert.equal(runRequest(['5', '--kind', 'review'], r.project, { viewPr: () => ({ headRefOid: HEAD }) }), 0);
  const kinds = () => readLocalState(r.project, 5).pending.map((entry) => [entry.kind, Boolean(entry.sent)]);
  assert.deepEqual(kinds(), [['request', false], ['review', false]]);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /never sent.*no result on record/su);

  // await-review posts the request: it is sent.
  const posts = [];
  const gh = {
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 5 }),
    api: (p, { method, fields } = {}) => {
      if (method === 'POST') return posts.push(fields.body) && { created_at: '2026-11-03T14:00:00Z' };
      if (p.endsWith('/pulls/5')) return { head: { sha: HEAD } };
      if (p.includes('/commits/')) return { commit: { committer: { date: '2026-11-03T13:00:00Z' } } };
      return [];
    },
  };
  const config = loadConfig(r.project).config;
  await runAwaitReview(['5', '--request', '--timeout-sec', '0'], config, r.project, { gh });
  assert.equal(posts.length, 1);
  assert.deepEqual(kinds(), [['request', true], ['review', false]]);

  // attest records the gate review: it is no longer owed.
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project), 0);
  assert.deepEqual(kinds(), [['request', true]]);

  // A finished review step clears a gate review too; an open one keeps it.
  recordPending(r.project, { pr: 6, repo: 'acme/notes', kind: 'review', head: HEAD, by: 't' });
  const state = readLocalState(r.project, 6);
  noteOutcome(state, { status: 'running', head: HEAD });
  assert.equal(state.pending.length, 1);
  noteOutcome(state, { status: 'received', head: HEAD });
  assert.deepEqual(state.pending, []);
  assert.equal(markRequestsSent(r.project, 7, HEAD), 0, 'no record, nothing to mark');
});

test('a review step that needs no review leaves a finished outcome the guard reads', async (t) => {
  const r = repo(t);
  r.git('branch', '-M', 'main');
  r.git('switch', '-q', '-c', 'feat');
  mkdirSync(path.join(r.dir, 'docs'));
  writeFileSync(path.join(r.dir, 'docs/guide.md'), 'hello\n');
  r.git('add', 'docs');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'docs');
  const head = r.git('rev-parse', 'HEAD');
  const comments = [];
  const gh = {
    pr: () => ({ number: 8, headRefOid: head, baseRefName: 'main' }),
    repo: () => 'acme/notes',
    comments: () => comments,
    post: (_repo, _n, body) => comments.push({ id: comments.length + 1, body }),
    edit: () => {},
  };
  const project = projectAt(r.dir);
  const exec = async () => assert.fail('a docs-only change runs no reviewer');
  const result = await reviewStep({ pr: '8' }, { project, config: loadConfig(project).config, gh, exec, codex: () => ({ ok: true }) });
  assert.equal(result.status, 'none_needed');
  assert.equal(comments.length, 0, 'an early return still posts nothing');
  const { outcome } = readLocalState(project, 8);
  assert.deepEqual([outcome.status, outcome.head], ['none_needed', head]);
  assert.equal(r.run(`gh pr merge 8 --match-head-commit ${head}`), null);
  assert.match(r.run(`gh pr merge 8 --match-head-commit ${HEAD}`) ?? '', /covered .*, not head abcdef1/u, 'a later head is not reviewed');
});
