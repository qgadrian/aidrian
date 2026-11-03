import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { runAttest, runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { isAncestor } from '../plugins/aidrian/lib/review/diff.mjs';
import { recordPass, recordSignoff, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { answerOwed, markRequestsSent, recordPending, runRequest } from '../plugins/aidrian/lib/review/pending.mjs';
import { answerPending, emptyState, noteOutcome, readLocalState, readRecord, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
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
  assert.match(during ?? '', /review of head .* is `running`/u, 'no record yet on disk would have let it run');
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

test('a review step that throws leaves an error outcome, and the merge stays refused', async (t) => {
  const r = repo(t, { review: { planCommand: 'exit 17' } });
  const f = feature(r);
  await assert.rejects(f.step({ exec: clean }));
  const state = readLocalState(f.project, 9);
  assert.equal(state.outcome?.status, 'error');
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
  // Offline, attest falls back to origin, a stated limit: origin's #5 is not the upstream's.
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, null, { viewPr: () => null }), 0);
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

test('an owed entry`s repository is this record`s too: a merge there is guarded', (t) => {
  const r = repo(t);
  writeLocalState(r.project, emptyState(5, 'acme/notes'));
  recordPending(r.project, { pr: 5, repo: 'upstream/notes', kind: 'request', head: HEAD, by: 'H' });
  assert.match(r.run(`gh pr merge 5 -R upstream/notes --match-head-commit ${HEAD}`) ?? '', /never sent/u);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }) ?? '', /never sent/u);
  assert.equal(r.run(`gh pr merge 5 -R third/party --match-head-commit ${HEAD}`), null);
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

test('fork: a step running on the upstream refuses its merge in every form', (t) => {
  const r = repo(t);
  r.record(5, (state) => (state.repo = 'Upstream/Notes', outcome(state, 'running')));
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /is `running`/u);
  for (const command of [`gh pr merge 5 -R upstream/notes --match-head-commit ${HEAD}`, `gh api -X PUT repos/upstream/notes/pulls/5/merge -f sha=${HEAD}`]) {
    assert.match(r.run(command) ?? '', /is `running`/u, command);
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
  const state = readLocalState(r.project, 5);
  noteOutcome(state, { status: 'received', head: r.commit }, () => false, 'Upstream/Notes');
  writeLocalState(r.project, state);
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'cr', '--findings', '0', '--fixed', '0'], r.project, null, { viewPr: view }), 0);
  const h2 = 'b'.repeat(40);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: h2 }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /not head bbbbbbb/u);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${h2}`) ?? '', /not head bbbbbbb/u);
});

test('signoff resolves the pull request`s repository, and falls back to origin offline', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  assert.equal(await runSignoff(['5', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { viewPr: () => ({ url: UPSTREAM }) }), 0);
  assert.equal(readLocalState(r.project, 5).repo, 'upstream/notes');
  assert.equal(await runSignoff(['6', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { viewPr: () => { throw new Error('offline'); } }), 0);
  assert.equal(readLocalState(r.project, 6).repo, 'acme/notes', 'offline: origin, a stated limit');
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

test('a gh api merge whose number, repository, or method the rule cannot read is refused', (t) => {
  const r = repo(t);
  for (const command of [
    'gh api -X PUT repos/acme/notes/pulls/$PR/merge',
    'gh api -X PUT "repos/acme/notes/pulls/${PR}/merge"',
    'gh api -X PUT "repos/$OWNER/notes/pulls/5/merge"',
  ]) assert.match(r.run(command) ?? '', /could not read which one/u, command);
  r.record(5, (state) => outcome(state, 'running'));
  assert.match(r.run('gh api -X "$METHOD" repos/acme/notes/pulls/5/merge') ?? '', /is `running`/u, 'a method it cannot read may be PUT');
  assert.equal(r.run('gh api repos/acme/notes/pulls/$PR'), null, 'not a merge path');
});

test('a merge inside a shell string, eval, or a heredoc fed to a shell is guarded as one run directly', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'running'));
  for (const command of [
    'bash -c "gh pr merge 5 --squash"',
    "bash -c 'gh pr merge 5'",
    'sh -c "gh api -X PUT repos/acme/notes/pulls/5/merge"',
    'eval "gh pr merge 5 --squash"',
    'eval gh pr merge 5',
    'eval -- "gh pr merge 5"',
    "bash <<'EOF'\ngh pr merge 5 --squash\nEOF",
    'sh -s <<< "gh pr merge 5"',
    'x=$(bash -c "gh pr merge 5")',
  ]) assert.match(r.run(command) ?? '', /pull request #5 at abcdef1, and the review of head abcdef1 is `running`/u, command);
  r.record(6, (state) => outcome(state, 'received'));
  assert.equal(r.run('bash -c "gh pr merge 6 --squash"'), null, 'a wrapped merge whose review finished merges');
  assert.equal(r.run("bash -c 'echo hi'"), null, 'an ordinary shell string');
  assert.equal(r.run('eval "$(ssh-agent -s)"'), null, 'an ordinary eval');
  assert.equal(r.run('bash -c "$CMD"'), null, 'a shell string the rule cannot read, naming no merge');
});

test('a merge fed to a shell as text the rule cannot read is refused; other text fed to a shell runs', (t) => {
  const r = repo(t);
  for (const command of ['echo "gh pr merge 5 --squash" | bash', "printf 'gh api -X PUT repos/acme/notes/pulls/5/merge' | sh -s"]) {
    assert.match(r.run(command) ?? '', /feeds a shell text the merge guard cannot read as commands/u, command);
  }
  assert.equal(r.run('cat setup.sh | bash'), null, 'a pipe into a shell naming no merge');
  assert.equal(r.run('bash scripts/build.sh'), null, 'a script');
  assert.equal(r.run('echo "gh pr merge 5"'), null, 'a merge named as text, run by no shell');
});

test('the record is scoped to the merge`s repository: origin#5 and upstream#5 share a number, not a review', (t) => {
  const r = repo(t);
  // A fork checkout: origin is acme/notes. The Human asked for a bot review of upstream/notes#5, never sent.
  writeLocalState(r.project, emptyState(5, 'acme/notes'));
  recordPending(r.project, { pr: 5, repo: 'upstream/notes', kind: 'request', head: HEAD, by: 'H' });
  for (const command of [`gh pr merge 5 -R acme/notes --match-head-commit ${HEAD}`, `gh api -X PUT repos/acme/notes/pulls/5/merge -f sha=${HEAD}`, `gh pr merge https://github.com/acme/notes/pull/5 --match-head-commit ${HEAD}`]) {
    assert.equal(r.run(command), null, `${command}: the upstream's request is not origin's`);
  }
  assert.equal(checkMcp({ owner: 'Acme', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }), null, 'the MCP merge of origin#5');
  // Fork safety: the upstream's merge stays guarded, and so does a merge that names no repository, whose gh default may be the upstream.
  assert.match(r.run(`gh pr merge 5 -R upstream/notes --match-head-commit ${HEAD}`) ?? '', /never sent/u);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }) ?? '', /never sent/u);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /never sent/u, 'no repository named');
  assert.match(r.run('gh pr merge 5 -R "$REPO"') ?? '', /never sent/u, 'a repository the rule cannot read');
});

test('an outcome is the record`s repository`s: another repository`s step neither blocks nor clears a merge', (t) => {
  const r = repo(t);
  // The review step ran on upstream/notes#5 and is still running; origin acme/notes#5 has no review of its own.
  r.record(5, (state) => (state.repo = 'upstream/notes', state.rounds.push({ head: HEAD }), outcome(state, 'running')));
  assert.equal(r.run('gh pr merge 5 -R acme/notes', { head: null }), null, 'origin#5: no record of its own, no gh call needed');
  assert.equal(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: {}, viewPr: r.viewer() }), null);
  assert.match(r.run('gh pr merge 5 -R upstream/notes') ?? '', /is `running`/u);
  // A step finished on origin#5 does not clear the gate review the upstream still owes.
  r.record(6, (state) => {
    outcome(state, 'received');
    state.pending.push({ kind: 'review', head: HEAD, at: '2026-11-03T13:50:00.000Z', by: 'H', repo: 'upstream/notes' });
  });
  assert.equal(r.run('gh pr merge 6 -R acme/notes'), null);
  assert.match(r.run('gh api -X PUT repos/upstream/notes/pulls/6/merge') ?? '', /no result on record/u);
});
