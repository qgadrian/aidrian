import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { runAwaitReview, saveRecord } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { runAttest, runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { isAncestor } from '../plugins/aidrian/lib/review/diff.mjs';
import { recordPass, recordSignoff, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { answerOwed, markRequestsSent, recordPending, runRequest } from '../plugins/aidrian/lib/review/pending.mjs';
import { answerPending, closeRun, emptyState, noteOutcome, openRun, readLocalState, readRecord, stateFromComment, summaryBody, updateLocalState, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
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
    outcome(state, 'received');
    owe(state, 'request');
    state.pending[0].sent = { at: '2026-11-03T14:05:00.000Z', head: HEAD };
  });
  assert.match(r.run('gh pr merge 7') ?? '', /sent and has no answer yet: wait for it with `aidrian pr await-review 7`/u, 'sent is not answered, and a finished review does not answer it');
  r.record(8, (state) => {
    owe(state, 'request');
    state.pending[0].sent = { at: '2026-11-03T14:05:00.000Z', head: HEAD };
  });
  assert.match(r.run('gh pr merge 8') ?? '', /has no answer yet/u, 'a record that holds only a sent request');
  r.record(9, (state) => {
    outcome(state, 'received');
    owe(state, 'request');
    state.pending[0].answered = { at: '2026-11-03T14:30:00.000Z', head: HEAD, by: 'bot' };
  });
  assert.equal(r.run('gh pr merge 9'), null, 'an answered request is no longer owed');
});

test('a pull request with no review record merges, with no gh call', (t) => {
  const r = repo(t);
  assert.equal(r.run('gh pr merge 5 --squash'), null);
  assert.equal(r.run('gh api -X PUT repos/acme/notes/pulls/5/merge'), null);
  assert.deepEqual(r.views, []);
  r.record(6, (state) => (state.pending.push({ kind: 'request', head: HEAD, at: 'x', by: 'y', sent: { at: 'x', head: HEAD }, answered: { at: 'x', head: HEAD, by: 'bot' } })));
  assert.equal(r.run('gh pr merge 6'), null, 'only answered entries, and no review step: nothing to guard');
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

const REVIEWER = 'chatgpt-codex-connector[bot]';
// A gh for pull request 5 at HEAD that records its posts; the bot's review of HEAD shows up from the `answerAt`-th
// snapshot on (never with Infinity).
function botGh(answerAt = Infinity) {
  const posts = [];
  let snapshots = 0;
  return {
    posts,
    repo: () => 'acme/notes',
    currentPr: () => ({ number: 5 }),
    api: (p, { method, fields } = {}) => {
      if (method === 'POST') return posts.push(fields.body) && { created_at: '2026-11-03T14:00:00Z' };
      if (p.endsWith('/pulls/5/reviews')) snapshots += 1;
      if (p.endsWith('/pulls/5/reviews') && snapshots >= answerAt) return [{ user: { login: REVIEWER }, submitted_at: '2026-11-03T14:30:00Z', commit_id: HEAD, state: 'COMMENTED' }];
      if (p.endsWith('/pulls/5')) return { head: { sha: HEAD } };
      if (p.includes('/commits/')) return { commit: { committer: { date: '2026-11-03T13:00:00Z' } } };
      return [];
    },
  };
}

const marks = (project, pr) => readLocalState(project, pr).pending.map((entry) => [entry.kind, Boolean(entry.sent), Boolean(entry.answered)]);

test('aidrian pr request records a request; it stays owed once sent, until the bot answers', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(runRequest(['5', '--head', HEAD, '--repo', 'acme/notes'], r.project, { viewPr: () => assert.fail('head and repository given: no gh') }), 0);
  assert.throws(() => runRequest(['5', '--kind', 'bot'], r.project), /--kind must be one of/u);
  assert.throws(() => runRequest(['5'], r.project, { viewPr: () => null }), /pass --head/u);
  assert.deepEqual(marks(r.project, 5), [['request', false, false]]);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /never sent/u);
  const config = loadConfig(r.project).config;
  const silent = botGh();
  await runAwaitReview(['5', '--request', '--timeout-sec', '0'], config, r.project, { gh: silent });
  assert.equal(silent.posts.length, 1);
  assert.deepEqual(marks(r.project, 5), [['request', true, false]], 'posted, and no answer yet');
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /has no answer yet/u);
  // Waiting without --request posts nothing; the answer that arrives during the wait answers the request.
  const later = botGh(2);
  const result = await runAwaitReview(['5', '--timeout-sec', '120', '--interval-sec', '5'], config, r.project, { gh: later, sleep: async () => {} });
  assert.deepEqual([result, later.posts.length], [0, 0]);
  assert.deepEqual(marks(r.project, 5), [['request', true, true]]);
  assert.equal(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`), null);
});

test('an answer already there answers the request', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  recordPending(r.project, { pr: 5, repo: 'acme/notes', kind: 'request', head: HEAD, by: 't' });
  const there = botGh(1);
  assert.equal(await runAwaitReview(['5', '--request', '--timeout-sec', '0'], loadConfig(r.project).config, r.project, { gh: there }), 0);
  assert.equal(there.posts.length, 0, 'already present: nothing to post');
  assert.deepEqual(marks(r.project, 5), [['request', false, true]]);
});

test('attest and a finished review step answer a gate review; an open step does not', async (t) => {
  const r = repo(t);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(runRequest(['5', '--kind', 'review'], r.project, { viewPr: () => ({ headRefOid: r.commit, url: 'https://github.com/acme/notes/pull/5' }) }), 0);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${r.commit}`) ?? '', /no result on record/u);
  const commit = (file) => {
    writeFileSync(path.join(r.dir, file), `${file}\n`);
    r.git('add', file);
    r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', file);
    return r.git('rev-parse', 'HEAD');
  };
  const child = commit('b.txt');
  // A root commit of its own, with no history in common.
  const unrelated = r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', r.git('hash-object', '-t', 'tree', '-w', '--stdin'), '-m', 'u');
  assert.equal(await runAttest(['5', '--head', unrelated, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0', '--repo', 'acme/notes'], r.project), 0);
  assert.deepEqual(marks(r.project, 5), [['review', false, false]], 'a review of an unrelated commit does not answer it');
  assert.equal(await runAttest(['5', '--head', child, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0', '--repo', 'acme/notes'], r.project), 0);
  assert.deepEqual(marks(r.project, 5), [['review', false, true]], 'a review of a commit that descends from it does');
  recordPending(r.project, { pr: 6, repo: 'acme/notes', kind: 'review', head: HEAD, by: 't' });
  const state = readLocalState(r.project, 6);
  noteOutcome(state, { status: 'running', head: HEAD });
  assert.equal(state.pending[0].answered, undefined);
  noteOutcome(state, { status: 'received', head: HEAD });
  assert.equal(state.pending[0].answered.by, 'received');
  assert.equal(markRequestsSent(r.project, 7, HEAD), 0, 'no record, nothing to mark');
});

test('a write keeps what was recorded on disk while it worked, marks included', (t) => {
  const r = repo(t);
  const stale = emptyState(5, 'acme/notes');
  writeLocalState(r.project, stale);
  recordPending(r.project, { pr: 5, repo: 'acme/notes', kind: 'request', head: HEAD, by: 't' });
  markRequestsSent(r.project, 5, HEAD);
  const old = readLocalState(r.project, 5);
  old.pending[0].sent = undefined;
  writeLocalState(r.project, stale);
  assert.deepEqual(marks(r.project, 5), [['request', true, false]], 'the step`s copy predates the request');
  writeLocalState(r.project, old);
  assert.deepEqual(marks(r.project, 5), [['request', true, false]], 'an older copy of the entry keeps the newer mark');
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

// Pull request 9: a `feat` branch off `main` that changes `src/app.js`, so the review plan has a pass to run.
function feature(r) {
  r.git('branch', '-M', 'main');
  r.git('switch', '-q', '-c', 'feat');
  mkdirSync(path.join(r.dir, 'src'));
  writeFileSync(path.join(r.dir, 'src/app.js'), 'export const app = 2;\n');
  r.git('add', 'src');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'change');
  const head = r.git('rev-parse', 'HEAD');
  const comments = [];
  const gh = {
    pr: () => ({ number: 9, headRefOid: head, baseRefName: 'main' }),
    repo: () => 'acme/notes',
    comments: () => comments,
    post: (_repo, _n, body) => comments.push({ id: comments.length + 1, body }),
    edit: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(r.dir);
  const step = (deps, opts = {}) => reviewStep({ pr: '9', ...opts }, { project, config: loadConfig(project).config, gh, codex: () => ({ ok: true }), ...deps });
  return { head, project, step };
}

const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });

test('a request recorded while a reviewer runs survives the step`s write', async (t) => {
  const r = repo(t);
  const f = feature(r);
  const exec = async () => (recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'request', head: f.head, by: 't' }), clean());
  const result = await f.step({ exec });
  assert.equal(result.status, 'received');
  assert.deepEqual(marks(f.project, 9), [['request', false, false]]);
  assert.match(r.run(`gh pr merge 9 --match-head-commit ${f.head}`) ?? '', /never sent/u, 'a finished review does not answer the request');
});

test('aidrian pr review --with-bot: the bot`s answer answers the requests, one recorded during the wait too', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const f = feature(r);
  recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'request', head: f.head, by: 't' });
  const awaitBot = async () => {
    recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'request', head: f.head, by: 'later' });
    return { status: 'received', requested: true, head_sha: f.head, signal: { kind: 'thumbs_up' } };
  };
  const result = await f.step({ exec: clean, awaitBot }, { withBot: true });
  assert.equal(result.status, 'received');
  assert.deepEqual(marks(f.project, 9), [['request', false, true], ['request', false, true]]);
  assert.equal(r.run(`gh pr merge 9 --match-head-commit ${f.head}`), null);
});

const OLD = 'fedcba9876543210fedcba9876543210fedcba98';

test('an answer counts for its own head, or for an earlier head it descends from, never by time', (t) => {
  const r = repo(t);
  const commit = (file) => {
    writeFileSync(path.join(r.dir, file), `${file}\n`);
    r.git('add', file);
    r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', file);
    return r.git('rev-parse', 'HEAD');
  };
  const a = r.commit;
  const b = commit('b.txt');
  // A root commit of its own, with no history in common.
  const unrelated = r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit-tree', r.git('hash-object', '-t', 'tree', '-w', '--stdin'), '-m', 'u');
  const git = (x, y) => isAncestor(r.dir, x, y);
  const answered = (requestHead, answerHead, seam) => {
    const state = { pending: [{ kind: 'request', head: requestHead, at: '2026-11-03T14:00:00.000Z', by: 't' }] };
    answerPending(state, 'request', { head: answerHead, by: 'bot', ...(seam ? { isAncestor: seam } : {}) });
    return Boolean(state.pending[0].answered);
  };
  assert.equal(answered(b, a, git), false, 'a late answer for A never answers the request for B, which descends from A');
  assert.equal(answered(a, b, git), true, 'an answer for B answers the request for A it descends from');
  assert.equal(answered(a, unrelated, git), false, 'unrelated heads');
  assert.equal(answered(a, b), false, 'git cannot tell: only the exact head');
  assert.equal(answered(a, a), true);
  assert.equal(answered(a, b, (x, y) => isAncestor(path.join(r.dir, 'missing'), x, y)), false, 'no repository');
});

test('await-review answers only the requests its answer covers', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  // The bot answered HEAD; OLD is a head this checkout does not know, so git cannot tell its ancestry.
  r.record(5, (state) => state.pending.push(
    { kind: 'request', head: HEAD, at: '2026-11-03T15:00:00.000Z', by: 't' },
    { kind: 'request', head: OLD, at: '2026-11-03T14:00:00.000Z', by: 't' },
  ));
  assert.equal(await runAwaitReview(['5', '--timeout-sec', '0'], loadConfig(r.project).config, r.project, { gh: botGh(1) }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, true], ['request', false, false]]);
});

test('a bot answer the step reuses answers a request made after it', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const f = feature(r);
  let asked = 0;
  const awaitBot = async () => (asked += 1, { status: 'received', requested: true, head_sha: f.head, signal: { kind: 'thumbs_up' } });
  assert.equal((await f.step({ exec: clean, awaitBot }, { withBot: true })).status, 'received');
  recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'request', head: f.head, by: 't' });
  assert.equal((await f.step({ exec: clean, awaitBot }, { withBot: true })).status, 'received');
  assert.equal(asked, 1, 'the second step reuses the answer');
  assert.deepEqual(marks(f.project, 9), [['request', false, true]]);
});

test('a merge while the first review step`s reviewer runs is refused', async (t) => {
  const r = repo(t);
  const f = feature(r);
  let during = null;
  const exec = async () => (during = r.run(`gh pr merge 9 --match-head-commit ${f.head}`), clean());
  assert.equal((await f.step({ exec })).status, 'received');
  assert.match(during ?? '', /review step on head .* is still running/u, 'no record yet on disk would have let it run');
  assert.equal(r.run(`gh pr merge 9 --match-head-commit ${f.head}`), null, 'finished: it runs');
});

test('a gate review recorded while a reviewer runs is answered when the step finishes', async (t) => {
  const r = repo(t);
  const f = feature(r);
  const exec = async () => (recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'review', head: f.head, by: 't' }), clean());
  assert.equal((await f.step({ exec })).status, 'received');
  assert.deepEqual(marks(f.project, 9), [['review', false, true]]);
});

test('await-review for the same number in another repository leaves this record alone', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  recordPending(r.project, { pr: 5, repo: 'acme/notes', kind: 'request', head: HEAD, by: 't' });
  const config = loadConfig(r.project).config;
  assert.equal(await runAwaitReview(['5', '--repo', 'other/fork', '--timeout-sec', '0'], config, r.project, { gh: botGh(1) }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, false]], 'other/fork#5 answered, at the same commit: not this pull request');
  assert.equal(await runAwaitReview(['5', '--repo', 'Acme/Notes', '--timeout-sec', '0'], config, r.project, { gh: botGh(1) }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, true]]);
});

test('a merge in the upstream a review record names is guarded from a fork checkout', (t) => {
  const r = repo(t);
  // origin is acme/notes, the fork; the review ran against the upstream pull request.
  r.record(5, (state) => (state.repo = 'Upstream/Notes', outcome(state, 'running')));
  for (const command of ['gh pr merge 5 -R upstream/notes', 'gh pr merge https://github.com/Upstream/Notes/pull/5', 'gh api -X PUT repos/upstream/notes/pulls/5/merge']) {
    assert.match(r.run(command) ?? '', /is `running`/u, command);
  }
  assert.match(checkMcp({ owner: 'UPSTREAM', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }) ?? '', /is `running`/u);
  assert.equal(r.run('gh pr merge 5 -R third/party'), null, 'neither origin nor the record`s repository');
});

test('a run that finishes first does not release another run still open on the head', async (t) => {
  const r = repo(t);
  const f = feature(r);
  let inner = null;
  let during = null;
  const exec = async () => {
    if (inner === null) {
      inner = await f.step({ exec: clean });
      during = r.run(`gh pr merge 9 --match-head-commit ${f.head}`);
    }
    return clean();
  };
  assert.equal((await f.step({ exec })).status, 'received');
  assert.equal(inner.status, 'received', 'the second run finished first');
  assert.match(during ?? '', /still running/u, 'the first run is still open');
  assert.equal(r.run(`gh pr merge 9 --match-head-commit ${f.head}`), null, 'both finished');
  assert.deepEqual(readLocalState(f.project, 9).active, []);
});

test('a run that died stops blocking once it is stale', (t) => {
  const r = repo(t);
  // A write keeps the runs on disk, so the runs are written as openRun left them.
  const raw = (pr, at) => {
    const state = { ...emptyState(pr, 'acme/notes'), outcome: { status: 'received', head: HEAD, at: '2026-11-03T14:00:00.000Z' }, active: [{ id: 'x', head: HEAD, at }] };
    mkdirSync(path.join(stateDir(r.project), 'reviews'), { recursive: true });
    writeFileSync(path.join(stateDir(r.project), 'reviews', `pr-${pr}-review.json`), JSON.stringify(state));
  };
  raw(5, new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString());
  assert.equal(r.run('gh pr merge 5'), null, 'past the cutoff');
  raw(6, new Date().toISOString());
  assert.match(r.run('gh pr merge 6') ?? '', /still running/u);
});

test('concurrent writers keep every entry: the record is locked and replaced whole', async (t) => {
  const r = repo(t);
  const pending = pathToFileURL(path.resolve('plugins/aidrian/lib/review/pending.mjs')).href;
  const project = pathToFileURL(path.resolve('plugins/aidrian/lib/project.mjs')).href;
  const writers = 6;
  const each = 12;
  const code = (i) => `import { recordPending } from '${pending}'; import { projectAt } from '${project}';
    const p = projectAt(${JSON.stringify(r.dir)});
    for (let j = 0; j < ${each}; j += 1) recordPending(p, { pr: 5, repo: 'acme/notes', kind: 'request', head: '${HEAD}', by: '${i}-' + j });`;
  await Promise.all(Array.from({ length: writers }, (_, i) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code(i)], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(stderr))));
  })));
  const by = new Set(readLocalState(r.project, 5).pending.map((entry) => entry.by));
  assert.equal(by.size, writers * each);
});

test('a write from an older copy of the record keeps the newer outcome and rounds', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  writeLocalState(r.project, emptyState(5, 'acme/notes'));
  // await-review reads the record first...
  const record = { state: readLocalState(r.project, 5), comments: [] };
  // ...then a review step records its round and returns unsatisfied...
  const step = readLocalState(r.project, 5);
  step.rounds.push({ head: HEAD, at: '2026-11-03T14:00:00.000Z' });
  noteOutcome(step, { status: 'unsatisfied', head: HEAD, reason: 'no engine' });
  writeLocalState(r.project, step);
  // ...and await-review saves what it read, with its own change.
  record.state.extensions = [{ source: 'bot', round: 1, status: 'checked' }];
  await saveRecord(record, { project: r.project, config: loadConfig(r.project).config, gh: null, base: { n: '5', repo: 'acme/notes' }, status: 'received' });
  const saved = readLocalState(r.project, 5);
  assert.deepEqual([saved.outcome.status, saved.rounds.length, saved.extensions.length], ['unsatisfied', 1, 1]);
  assert.equal(saved.revision, step.revision + 1, 'the save is a revision after the step`s, not a copy of it');
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /is `unsatisfied`/u);
  // A full write from the older copy, as attest or extend makes, keeps them too.
  const older = { ...record.state, extensions: [] };
  writeLocalState(r.project, older);
  const kept = readLocalState(r.project, 5);
  assert.deepEqual([kept.outcome.status, kept.rounds.length], ['unsatisfied', 1]);
});

test('a review step that throws leaves an error outcome, and the merge stays refused', async (t) => {
  const r = repo(t, { review: { planCommand: 'exit 17' } });
  const f = feature(r);
  await assert.rejects(f.step({ exec: clean }));
  const state = readLocalState(f.project, 9);
  assert.deepEqual([state.outcome?.status, state.active], ['error', []]);
  assert.match(r.run(`gh pr merge 9 --match-head-commit ${f.head}`) ?? '', /is `error`/u);
});

test('every request records the pull request`s own repository, and attest resolves the same one', async (t) => {
  const r = repo(t);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  // origin is acme/notes, the fork; gh's default repository is the upstream.
  const upstream = () => ({ headRefOid: r.commit, url: 'https://github.com/Upstream/Notes/pull/5' });
  assert.equal(runRequest(['5'], r.project, { viewPr: upstream }), 0);
  assert.equal(runRequest(['5', '--kind', 'review'], r.project, { viewPr: upstream }), 0);
  assert.deepEqual(readLocalState(r.project, 5).pending.map((entry) => [entry.kind, entry.repo]), [['request', 'upstream/notes'], ['review', 'upstream/notes']]);
  await assert.rejects(runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, null, { viewPr: () => null }), /pass --repo/u, 'never origin by guess');
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0', '--repo', 'acme/notes'], r.project), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, false], ['review', false, false]], 'an attest of origin`s #5 is not the upstream`s');
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, null, { viewPr: upstream }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, false], ['review', false, true]], 'attest resolves the upstream, as the request did');
  assert.equal(answerOwed(r.project, 5, 'request', { head: r.commit, by: 't', repo: 'acme/notes' }), 0, 'an answer on origin`s #5 is not the upstream`s');
  assert.equal(answerOwed(r.project, 5, 'request', { head: r.commit, by: 't', repo: 'UPSTREAM/notes' }), 1);
});

test('gh api placeholders are filled one part at a time', (t) => {
  const r = repo(t);
  // origin is acme/notes; GH_REPO fills only the placeholder part.
  r.record(5, (state) => outcome(state, 'running'));
  const run = (command) => check(command, { cwd: r.dir, env: {}, input: {}, viewPr: r.viewer() });
  assert.match(run('GH_REPO=other/notes gh api -X PUT repos/acme/{repo}/pulls/5/merge') ?? '', /is `running`/u, 'acme/notes, not other/notes');
  assert.equal(run('GH_REPO=other/notes gh api -X PUT repos/{owner}/{repo}/pulls/5/merge'), null, 'other/notes: another repository');
});

// Another machine's record of #5 at revision 12, in the summary comment, as await-review reads it.
function commentRecord(project) {
  const remote = emptyState(5, 'acme/notes');
  remote.revision = 12;
  remote.rounds = [{ head: 'a', at: '1' }, { head: 'b', at: '2' }, { head: 'c', at: '3' }];
  remote.passes = { 'engine:codex': { head: 'c', findings: 0, open: 0 } };
  remote.outcome = { status: 'fix_required', head: 'c', at: '2026-11-03T10:00:00Z' };
  remote.pending = [{ id: 'remote', kind: 'request', head: 'c', at: '2026-11-03T09:00:00Z', by: 't' }];
  const comments = [{ id: 1, body: summaryBody(remote, null, 'fix_required') }];
  const record = { ...readRecord(project, 5, comments, 'acme/notes'), comments };
  record.state.extensions = [{ source: 'bot', round: 3, status: 'asking' }];
  let edited = null;
  const gh = { api: (_url, opts) => ((edited = opts.fields.body), {}) };
  return { record, gh, published: () => stateFromComment(edited, 5) };
}

test('await-review`s save builds on the comment`s newer record, never publishes an empty one over it', async (t) => {
  const r = repo(t);
  const { record, gh, published } = commentRecord(r.project);
  await saveRecord(record, { project: r.project, config: loadConfig(r.project).config, gh, base: { n: '5', repo: 'acme/notes' }, status: 'round_limit' });
  const out = published();
  assert.deepEqual([out.revision, out.rounds.length, Object.keys(out.passes).length, out.outcome?.status, out.extensions.length], [13, 3, 1, 'fix_required', 1]);
  assert.equal(readLocalState(r.project, 5).revision, 13, 'and keeps it here');
});

test('await-review`s save reconciles an older local record with the comment`s', async (t) => {
  const r = repo(t);
  const local = emptyState(5, 'acme/notes');
  local.revision = 2;
  local.active = [{ id: 'run', head: 'c', at: new Date().toISOString() }];
  local.pending = [{ id: 'mine', kind: 'review', head: 'c', at: '2026-11-03T11:00:00Z', by: 't' }];
  local.outcome = { status: 'running', head: 'c', at: '2026-11-03T11:00:00Z' };
  mkdirSync(path.join(stateDir(r.project), 'reviews'), { recursive: true });
  writeFileSync(path.join(stateDir(r.project), 'reviews', 'pr-5-review.json'), JSON.stringify(local));
  const { record, gh } = commentRecord(r.project);
  record.state = { ...record.state, ...stateFromComment(record.comments[0].body, 5), extensions: record.state.extensions };
  await saveRecord(record, { project: r.project, config: loadConfig(r.project).config, gh, base: { n: '5', repo: 'acme/notes' }, status: 'round_limit' });
  const saved = readLocalState(r.project, 5);
  assert.equal(saved.rounds.length, 3, 'the comment`s rounds');
  assert.deepEqual(saved.active.map((run) => run.id), ['run'], 'this machine`s runs');
  assert.deepEqual(saved.pending.map((entry) => entry.id).sort(), ['mine', 'remote'], 'both lists of owed reviews');
  assert.equal(saved.outcome.status, 'running', 'the later outcome');
});

test('await-review`s save replaces only the bot`s extra-round checks', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const state = emptyState(5, 'acme/notes');
  state.extensions = [{ source: 'plan', round: 2, status: 'granted' }, { source: 'bot', round: 1, status: 'judging' }];
  writeLocalState(r.project, state);
  const record = { state: { ...readLocalState(r.project, 5), extensions: [{ source: 'bot', round: 1, status: 'granted' }] }, comments: [] };
  await saveRecord(record, { project: r.project, config: loadConfig(r.project).config, gh: null, base: { n: '5', repo: 'acme/notes' }, status: 'received' });
  assert.deepEqual(readLocalState(r.project, 5).extensions.map((entry) => `${entry.source}:${entry.status}`), ['plan:granted', 'bot:granted']);
});

test('an owed entry`s repository is this record`s too: a merge there is guarded', (t) => {
  const r = repo(t);
  writeLocalState(r.project, emptyState(5, 'acme/notes'));
  recordPending(r.project, { pr: 5, repo: 'upstream/notes', kind: 'request', head: HEAD, by: 'H' });
  assert.match(r.run(`gh pr merge 5 -R upstream/notes --match-head-commit ${HEAD}`) ?? '', /never sent/u);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }) ?? '', /never sent/u);
  assert.equal(r.run(`gh pr merge 5 -R third/party --match-head-commit ${HEAD}`), null);
});

test('three writers: a write from an older copy never reuses a revision or drops a round', (t) => {
  const r = repo(t);
  const base = emptyState(5, 'acme/notes');
  base.rounds.push({ head: 'h1', at: '2026-01-01T00:00:00Z' });
  writeLocalState(r.project, base);
  const step = readLocalState(r.project, 5);
  writeLocalState(r.project, readLocalState(r.project, 5));
  const late = readLocalState(r.project, 5);
  const held = late.revision;
  step.rounds.push({ head: 'h2', at: '2026-01-02T00:00:00Z' });
  noteOutcome(step, { status: 'received', head: 'h2' });
  writeLocalState(r.project, step);
  const afterStep = readLocalState(r.project, 5);
  writeLocalState(r.project, late);
  const end = readLocalState(r.project, 5);
  assert.ok(afterStep.revision > held, 'the step`s write is past the copy the late writer holds');
  assert.deepEqual([end.rounds.map((round) => round.head), end.outcome.status, end.revision > afterStep.revision], [['h1', 'h2'], 'received', true]);
});

test('attest, signoff, and extend apply their change to the record as it is now', (t) => {
  const r = repo(t);
  writeLocalState(r.project, emptyState(5, 'acme/notes'));
  const stale = readLocalState(r.project, 5);
  const step = readLocalState(r.project, 5);
  noteOutcome(step, { status: 'unsatisfied', head: HEAD });
  writeLocalState(r.project, step);
  recordPass(r.project, { pr: 5, repo: 'acme/notes', pass: 'p', head: HEAD, reviewer: 'r', findings: 0, fixed: 0 });
  recordSignoff(r.project, { pr: 5, repo: 'acme/notes', flow: 'f', head: HEAD, by: 'H' });
  const now = readLocalState(r.project, 5);
  assert.deepEqual([now.outcome.status, Object.keys(now.passes), Object.keys(now.signoffs)], ['unsatisfied', ['p'], ['f']]);
  assert.ok(now.revision > stale.revision + 1);
});

test('a finished step answers only its own repository`s gate reviews', () => {
  const state = emptyState(5, 'acme/notes');
  state.pending.push({ id: 'x', kind: 'review', head: HEAD, repo: 'upstream/notes', at: 'a', by: 'h' }, { id: 'y', kind: 'review', head: HEAD, repo: 'acme/notes', at: 'a', by: 'h' });
  noteOutcome(state, { status: 'received', head: HEAD }, () => false, 'Acme/Notes');
  assert.deepEqual(state.pending.map((entry) => Boolean(entry.answered)), [false, true]);
});

// A fork checkout: origin is acme/notes, and gh's default repository, where pull request #5 lives, is Upstream/Notes.
const UPSTREAM = 'https://github.com/Upstream/Notes/pull/5';

test('fork: a gate review owed with no run yet refuses the upstream merge', (t) => {
  const r = repo(t);
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  runRequest(['5', '--kind', 'review'], r.project, { viewPr: () => ({ headRefOid: r.commit, url: UPSTREAM }) });
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: r.commit }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /no result on record/u);
});

test('fork: a run open on the upstream refuses its merge in every form', (t) => {
  const r = repo(t);
  openRun(r.project, { pr: 5, repo: 'Upstream/Notes', head: HEAD, id: 'run' });
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /still running/u);
  for (const command of [`gh pr merge 5 -R upstream/notes --match-head-commit ${HEAD}`, `gh api -X PUT repos/upstream/notes/pulls/5/merge -f sha=${HEAD}`]) {
    assert.match(r.run(command) ?? '', /still running/u, command);
  }
  assert.match(check('gh pr merge "$PR" -R upstream/notes', { cwd: r.dir, env: {}, input: {}, viewPr: () => null }) ?? '', /could not read which one/u, 'a number it cannot read, whatever the target');
});

test('fork: received on H1, attest, then a merge of the upstream at H2 is refused', async (t) => {
  const r = repo(t);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  const view = () => ({ headRefOid: r.commit, url: UPSTREAM });
  runRequest(['5', '--kind', 'review'], r.project, { viewPr: view });
  openRun(r.project, { pr: 5, repo: 'Upstream/Notes', head: r.commit, id: 'run' });
  const state = readLocalState(r.project, 5);
  noteOutcome(state, { status: 'received', head: r.commit }, () => false, 'Upstream/Notes');
  writeLocalState(r.project, state);
  closeRun(r.project, 5, 'run');
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'cr', '--findings', '0', '--fixed', '0'], r.project, null, { viewPr: view }), 0);
  const h2 = 'b'.repeat(40);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: h2 }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /not head bbbbbbb/u);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${h2}`) ?? '', /not head bbbbbbb/u);
});

test('signoff resolves the pull request`s repository, never origin by guess', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  await assert.rejects(runSignoff(['5', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { viewPr: () => { throw new Error('offline'); } }), /pass --repo/u);
  assert.equal(await runSignoff(['5', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { viewPr: () => ({ url: UPSTREAM }) }), 0);
  assert.equal(readLocalState(r.project, 5).repo, 'upstream/notes');
});

test('extend keeps a write another writer made to the record mid-call', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const state = emptyState(5, 'acme/notes');
  state.extensions = [{ source: 'plan', round: 2, head: HEAD, status: 'judging', mode: 'ask', reasons: [] }];
  writeLocalState(r.project, state);
  const gh = {
    comments: () => [],
    pr: () => {
      updateLocalState(r.project, 5, 'acme/notes', (now) => {
        now.extensions = [...now.extensions, { source: 'bot', round: 1, head: HEAD, status: 'judging' }];
      }, { revise: true });
      return { headRefOid: HEAD };
    },
  };
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  assert.equal(await runExtend(['5', '--verdict', 'extend', '--reason', 'r'], r.project, loadConfig(r.project).config, { gh, repo: 'acme/notes', env: {} }), 0);
  assert.deepEqual(readLocalState(r.project, 5).extensions.map((entry) => `${entry.source}:${entry.status}`), ['plan:asking', 'bot:judging']);
});

test('recordPass builds on a newer comment record, keeping its rounds and passes', (t) => {
  const r = repo(t);
  const local = emptyState(5, 'acme/notes');
  local.rounds = [{ head: 'a', at: '1' }];
  writeLocalState(r.project, local);
  const { record } = commentRecord(r.project);
  recordPass(r.project, { pr: 5, repo: 'acme/notes', pass: 'p', head: HEAD, reviewer: 'r', findings: 0, fixed: 0, remote: record.comments });
  const now = readLocalState(r.project, 5);
  assert.deepEqual([now.rounds.length, Object.keys(now.passes).sort()], [3, ['engine:codex', 'p']]);
});

test('a review step leaves another repository`s gate review owed', async (t) => {
  const r = repo(t);
  const f = feature(r);
  recordPending(f.project, { pr: 9, repo: 'upstream/notes', kind: 'review', head: f.head, by: 't' });
  recordPending(f.project, { pr: 9, repo: 'acme/notes', kind: 'review', head: f.head, by: 't' });
  assert.equal((await f.step({ exec: clean })).status, 'received');
  assert.deepEqual(readLocalState(f.project, 9).pending.map((entry) => [entry.repo, Boolean(entry.answered)]), [['upstream/notes', false], ['acme/notes', true]]);
});
