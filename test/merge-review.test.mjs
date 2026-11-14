import '../scripts/test-state.mjs';
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
import { answerPending, emptyState, noteOutcome, readLocalState, readRecord, recordFile, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check, checkMcp, readMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { waitingRoute } from '../plugins/aidrian/lib/rules/review-extend.mjs';
import { lexCommand, readInvocation } from '../plugins/aidrian/lib/shell-lex.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const NEXT = '1234567890abcdef1234567890abcdef12345678';

// A git repository with an origin and one commit, holding a project whose state folder is beside it (never a real
// repository's, and no GIT_DIR), and a transcript file for the hook payload.
function repo(t, config = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-merge-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
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
  // The real block: a session read the options of `gh pr merge` in a chain of help reads, and was refused three times.
  r.views.length = 0;
  assert.equal(r.run('gh pr comment --help | grep body; gh pr merge --help 2>/dev/null | grep -nE "^\\s+-"', { head: null }), null, 'a help read merges nothing');
  assert.equal(r.run('gh pr merge -h', { head: null }), null);
  assert.equal(r.run('gh pr merge 5 --squash --help', { head: null }), null, 'gh prints the help and merges nothing, whatever else is given');
  assert.deepEqual(r.views, [], 'a help read asks gh nothing');
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

// A review stopped at its round limit on HEAD: `status` is `extension_check` (the cap's check waits for its judge) or
// `round_limit`; `rounds` are the record's rounds, and `extensions` its extra-round checks.
const JUDGING = { source: 'plan', round: 1, head: HEAD, status: 'judging', mode: 'ask', red_flags: [] };
const stopped = (status, { rounds = [{ head: HEAD, open: 2 }], extensions = status === 'extension_check' ? [JUDGING] : [], head = HEAD } = {}) => (state) => {
  state.rounds.push(...rounds);
  if (extensions.length) state.extensions = extensions;
  outcome(state, status, head);
};
const OLD_TAIL = /"Wait for the review" \(first, recommended\) and "Merge anyway"/u;
const asked = (reason) => /the question "([^"]+)"/u.exec(reason ?? '')?.[1];

test('a review stopped at its round limit asks the Human to ship or to grant rounds, never to wait', (t) => {
  const r = repo(t);
  const question = 'Review of pull request #5 at abcdef1 stopped at its round limit, with 2 findings open. Ship, and file them as an issue?';
  const grant = 'Run `aidrian pr extend 5 --human approve`: it records the grant when an extension waits for the Human, and otherwise its refusal names the route to one more round.';
  for (const [status, route] of [['extension_check', waitingRoute(5, JUDGING)], ['round_limit', grant]]) {
    r.record(5, stopped(status));
    const reason = r.run('gh pr merge 5');
    assert.equal(reason, `Blocked: this merges pull request #5 at abcdef1, and the review of head abcdef1 is \`${status}\`: stopped at its round limit, with 2 findings open, and not running. ` +
      `Only the Human decides this: ask with AskUserQuestion, the question "${question}", the options "Merge with the findings filed" and "Grant more review rounds", ` +
      'and mark neither as preferred. When the Human picks "Merge with the findings filed", file the findings the review left open as a follow-up issue, then merge. ' +
      `When the Human picks "Grant more review rounds", do not merge. ${route} Or the Human merges in their own shell.`, status);
    assert.match(reason, /`aidrian pr extend 5 --human approve`/u, `${status}: both routes name the grant command`);
    assert.doesNotMatch(reason, /Wait for the review/u, status);
    assert.doesNotMatch(reason, /recommend/iu, status);
    assert.doesNotMatch(reason, /\b(?:I|you|your)\b/u, status);
    const mcp = checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: r.viewer() });
    assert.equal(mcp, reason, `${status}: the MCP tool gets the same deny`);
  }
  assert.match(r.run('gh pr merge 5') ?? '', /its refusal names the route to one more round/u, 'round_limit: the refusal names the route');
  const reasoned = repo(t);
  reasoned.record(5, (state) => (stopped('round_limit')(state), (state.outcome.reason = 'the judge stopped')));
  assert.match(reasoned.run('gh pr merge 5') ?? '', /is `round_limit` \(the judge stopped\): stopped at its round limit, with 2 findings open, and not running\./u);
});

test('the count is the last round`s, for the merge`s head only', (t) => {
  const r = repo(t);
  r.record(5, stopped('round_limit', { rounds: [{ head: HEAD, open: 5 }, { head: HEAD, open: 1 }] }));
  const one = r.run('gh pr merge 5') ?? '';
  assert.match(one, /is `round_limit`: stopped at its round limit, with 1 finding open, and not running\./u);
  assert.equal(asked(one), 'Review of pull request #5 at abcdef1 stopped at its round limit, with 1 finding open. Ship, and file it as an issue?');
  for (const [name, rounds] of [
    ['a last round on another head', [{ head: HEAD, open: 2 }, { head: NEXT, open: 2 }]],
    ['a round with no count', [{ head: HEAD }]],
    ['a count of zero', [{ head: HEAD, open: 0 }]],
    ['a count that is not a number', [{ head: HEAD, open: '2' }]],
    ['no round at all', []],
  ]) {
    r.record(5, stopped('round_limit', { rounds }));
    const reason = r.run('gh pr merge 5') ?? '';
    assert.match(reason, /is `round_limit`: stopped at its round limit, and not running\./u, name);
    assert.equal(asked(reason), 'Review of pull request #5 at abcdef1 stopped at its round limit. Ship, and file what it left open as an issue?', name);
    assert.doesNotMatch(reason, /findings? open/u, name);
  }
});

test('the Human`s "Merge with the findings filed" lets a capped review merge, and only a capped one', (t) => {
  const r = repo(t);
  const at = '2026-11-03T14:10:00.000Z';
  for (const status of ['round_limit', 'extension_check']) {
    r.record(5, stopped(status));
    writeFileSync(r.transcript, '');
    const question = asked(r.run('gh pr merge 5'));
    assert.ok(question, status);
    for (const [name, asks, label, when] of [
      ['an answer about another head', question.replace('abcdef1', '1234567'), 'Merge with the findings filed', at],
      ['an answer about another pull request', question.replace('#5', '#55'), 'Merge with the findings filed', at],
      ['an answer older than the outcome', question, 'Merge with the findings filed', '2026-11-03T13:00:00.000Z'],
      ['the Human granted rounds', question, 'Grant more review rounds', at],
    ]) {
      r.answer(asks, label, when);
      assert.ok(r.run('gh pr merge 5'), `${status}: ${name}`);
    }
    r.answer(question, 'Merge with the findings filed', at);
    assert.equal(r.run('gh pr merge 5'), null, status);
    assert.equal(r.run('gh pr merge 5'), null, `${status}: and on every later call`);
    r.answer(question, 'Merge anyway', at);
    assert.equal(r.run('gh pr merge 5'), null, `${status}: "Merge anyway" still waives it`);
  }
  for (const [name, edit] of [
    ['a running review', (state) => outcome(state, 'running')],
    ['a check that waits for the Human', stopped('extension_ask', { extensions: [{ ...JUDGING, status: 'asking' }] })],
    ['a capped status on another head', stopped('round_limit', { head: NEXT })],
    ['a capped status with a review owed', (state) => (stopped('round_limit')(state), owe(state, 'request'))],
  ]) {
    r.record(5, edit);
    writeFileSync(r.transcript, '');
    const question = asked(r.run('gh pr merge 5'));
    assert.ok(question, name);
    r.answer(question, 'Merge with the findings filed', at);
    assert.ok(r.run('gh pr merge 5'), name);
  }
});

test('a review that runs, waits for the Human, covers another head, or is owed keeps the first question', (t) => {
  const r = repo(t);
  r.record(5, (state) => outcome(state, 'running'));
  assert.equal(r.run('gh pr merge 5'), 'Blocked: this merges pull request #5 at abcdef1, and the review of head abcdef1 is `running`: run `aidrian pr review 5` until it returns `received` or `none_needed`. ' +
    'Only the Human waives this: ask with AskUserQuestion, the question "Merge pull request #5 at abcdef1 before its review is finished?", the options "Wait for the review" ' +
    '(first, recommended) and "Merge anyway", and merge only when the Human picks "Merge anyway". Or the Human merges in their own shell.');
  for (const [name, edit] of [
    ['a check that waits for the Human', stopped('extension_ask', { extensions: [{ ...JUDGING, status: 'asking' }] })],
    ['a capped status on another head', stopped('round_limit', { head: NEXT })],
    ['a capped status with a review owed', (state) => (stopped('round_limit')(state), owe(state, 'request'))],
  ]) {
    r.record(5, edit);
    const reason = r.run('gh pr merge 5') ?? '';
    assert.match(reason, OLD_TAIL, name);
    assert.doesNotMatch(reason, /stopped at its round limit/u, name);
  }
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

test('the merge tool of a GitHub MCP server a Claude Code plugin installs is guarded under its plugin name', (t) => {
  const r = repo(t);
  r.record(5, (state) => (outcome(state, 'received'), owe(state, 'request')));
  const hook = (tool_name, toolInput, env = {}) => spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-mcp-github.mjs'], {
    input: JSON.stringify({ tool_name, cwd: r.dir, tool_input: toolInput }),
    encoding: 'utf8',
    env: { ...process.env, AIDRIAN_TELEMETRY: '0', ...env },
  });
  const given = { owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD };
  for (const name of ['mcp__plugin_github_github__merge_pull_request', 'mcp__plugin_acme-tools_GitHub__merge_pull_request']) {
    for (const env of [{}, { CLAUDECODE: '1' }]) {
      const denied = hook(name, given, env);
      assert.equal(denied.status, 2, `${name} ${JSON.stringify(env)}: ${denied.stderr}`);
      assert.match(denied.stderr, /never sent/u);
    }
  }
  // Another forge's server that shares the tool's name is not read as GitHub's, so its merge is not refused as unreadable.
  assert.equal(hook('mcp__plugin_gitea_gitea__merge_pull_request', { owner: 'acme', repo: 'notes', index: 5 }).status, 0);
});

const REVIEWER = 'chatgpt-codex-connector[bot]';
// A forge for pull request 5 at HEAD that records its posts; the bot's review of HEAD shows up from the `answerAt`-th
// snapshot on (never with Infinity).
function botForge(answerAt = Infinity) {
  const posts = [];
  let snapshots = 0;
  return {
    posts,
    repo: () => 'acme/notes',
    change: () => ({ number: 5 }),
    postComment: (_repo, _n, body) => posts.push(body) && { created_at: '2026-11-03T14:00:00Z' },
    reviews: (_repo, n) => {
      if (String(n) !== '5') return [];
      snapshots += 1;
      return snapshots >= answerAt ? [{ user: { login: REVIEWER }, submitted_at: '2026-11-03T14:30:00Z', commit_id: HEAD, state: 'COMMENTED' }] : [];
    },
    pull: (_repo, n) => (String(n) === '5' ? { head: { sha: HEAD } } : []),
    commit: () => ({ commit: { committer: { date: '2026-11-03T13:00:00Z' } } }),
    reviewComments: () => [],
    conversationComments: () => [],
    reactions: () => [],
  };
}
// A forge whose only read is the pull request `view` returns, as `gh pr view` answers it.
const viewing = (view) => ({ change: view });

const marks = (project, pr) => readLocalState(project, pr).pending.map((entry) => [entry.kind, Boolean(entry.sent), Boolean(entry.answered)]);

test('aidrian pr request records a request; it stays owed once sent, until the bot answers', async (t) => {
  const r = repo(t, { github: { reviewer: REVIEWER } });
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(runRequest(['5', '--head', HEAD, '--repo', 'acme/notes'], r.project, { forge: viewing(() => assert.fail('head and repository given: no gh')) }), 0);
  assert.throws(() => runRequest(['5', '--kind', 'bot'], r.project), /--kind must be one of/u);
  assert.throws(() => runRequest(['5'], r.project, { forge: viewing(() => null) }), /pass --head/u);
  assert.deepEqual(marks(r.project, 5), [['request', false, false]]);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /never sent/u);
  const config = loadConfig(r.project).config;
  const silent = botForge();
  await runAwaitReview(['5', '--request', '--timeout-sec', '0'], config, r.project, { forge: silent });
  assert.equal(silent.posts.length, 1);
  assert.deepEqual(marks(r.project, 5), [['request', true, false]], 'posted, and no answer yet');
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /has no answer yet/u);
  // Waiting without --request posts nothing; the answer that arrives during the wait answers the request.
  const later = botForge(2);
  const result = await runAwaitReview(['5', '--timeout-sec', '120', '--interval-sec', '5'], config, r.project, { forge: later, sleep: async () => {} });
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
  const there = botForge(1);
  assert.equal(await runAwaitReview(['5', '--request', '--timeout-sec', '0'], loadConfig(r.project).config, r.project, { forge: there }), 0);
  assert.equal(there.posts.length, 0, 'already present: nothing to post');
  assert.deepEqual(marks(r.project, 5), [['request', false, true]]);
});

test('attest and a finished review step answer a gate review; an open step does not', async (t) => {
  const r = repo(t);
  const quiet = { log: console.log, error: console.error };
  console.log = console.error = () => {};
  t.after(() => Object.assign(console, quiet));
  assert.equal(runRequest(['5', '--kind', 'review'], r.project, { forge: viewing(() => ({ headRefOid: r.commit, url: 'https://github.com/acme/notes/pull/5' })) }), 0);
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
  const forge = {
    change: () => ({ number: 8, headRefOid: head, baseRefName: 'main' }),
    repo: () => 'acme/notes',
    conversationComments: () => comments,
    reviews: () => [],
    reviewComments: () => [],
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body }),
    editComment: () => {},
  };
  const project = projectAt(r.dir);
  const exec = async () => assert.fail('a docs-only change runs no reviewer');
  const result = await reviewStep({ pr: '8' }, { project, config: loadConfig(project).config, forge, exec, codex: () => ({ ok: true }) });
  assert.equal(result.status, 'none_needed');
  assert.equal(comments.length, 0, 'an early return still posts nothing');
  const { outcome } = readLocalState(project, 8);
  assert.deepEqual([outcome.status, outcome.head], ['none_needed', head]);
  assert.deepEqual(outcome.reasons, ['only files that cannot change behaviour'], 'the plan\'s reasons, which aidrian pr auto-merge reads');
  assert.equal(outcome.depth, 'none', 'the plan\'s depth, which aidrian pr auto-merge reads');
  assert.equal(r.run(`gh pr merge 8 --match-head-commit ${head}`), null);
  assert.match(r.run(`gh pr merge 8 --match-head-commit ${HEAD}`) ?? '', /covered .*, not head abcdef1/u, 'a later head is not reviewed');
});

// Pull request 10: a README-only change, planned by a plan command on `main` that prints `plan`.
async function plannedReadme(t, plan) {
  const r = repo(t, { review: { planCommand: 'node plan.mjs' } });
  r.git('branch', '-M', 'main');
  writeFileSync(path.join(r.dir, 'plan.mjs'), `let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(${JSON.stringify(JSON.stringify(plan))}))\n`);
  r.git('add', 'plan.mjs');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'planner');
  r.git('switch', '-q', '-c', 'feat');
  writeFileSync(path.join(r.dir, 'README.md'), 'hello\n');
  r.git('add', 'README.md');
  r.git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'readme');
  const head = r.git('rev-parse', 'HEAD');
  const forge = {
    change: () => ({ number: 10, headRefOid: head, baseRefName: 'main' }),
    repo: () => 'acme/notes',
    conversationComments: () => [],
    reviews: () => [],
    reviewComments: () => [],
    postComment: () => ({}),
    editComment: () => ({}),
  };
  const project = projectAt(r.dir);
  const reviewers = [];
  const exec = async (reviewer) => (reviewers.push(reviewer.name ?? reviewer), clean());
  const result = await reviewStep({ pr: '10' }, { project, config: loadConfig(project).config, forge, exec, codex: () => ({ ok: true }) });
  return { r, head, project, result, reviewers };
}

test('a plan command that raises the depth with no pass of its own gets the built-in passes, never none_needed', async (t) => {
  const { r, head, project, result, reviewers } = await plannedReadme(t, { depth: 'single', stages: [] });
  assert.notEqual(result.status, 'none_needed', 'the plan command asked for a review');
  assert.equal(result.status, 'received', JSON.stringify(result));
  assert.equal(reviewers.length, 1, 'the built-in engine pass reviewed the change');
  const { outcome } = readLocalState(project, 10);
  assert.deepEqual([outcome.status, outcome.head], ['received', head]);
  assert.equal(result.depth, 'single');
  assert.equal(r.run(`gh pr merge 10 --match-head-commit ${head}`), null);
});

test('a plan command that raises the depth with its own pass runs only that pass, as before', async (t) => {
  const own = { id: 'own:lint', reviewer: 'codex-local', kind: 'exec', files: null, context: 'full' };
  const { result, reviewers } = await plannedReadme(t, { depth: 'single', stages: [{ name: 'independent', passes: [own] }] });
  assert.equal(result.status, 'received', JSON.stringify(result));
  assert.equal(reviewers.length, 1, 'the plan command`s pass, and no built-in engine pass beside it');
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
  const forge = {
    change: () => ({ number: 9, headRefOid: head, baseRefName: 'main' }),
    repo: () => 'acme/notes',
    conversationComments: () => comments,
    reviews: () => [],
    reviewComments: () => [],
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(r.dir);
  const step = (deps, opts = {}) => reviewStep({ pr: '9', ...opts }, { project, config: loadConfig(project).config, forge, codex: () => ({ ok: true }), ...deps });
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
  assert.equal(await runAwaitReview(['5', '--timeout-sec', '0'], loadConfig(r.project).config, r.project, { forge: botForge(1) }), 0);
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
  assert.equal(await runAwaitReview(['5', '--repo', 'other/fork', '--timeout-sec', '0'], config, r.project, { forge: botForge(1) }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, false]], 'other/fork#5 answered, at the same commit: not this pull request');
  assert.equal(await runAwaitReview(['5', '--repo', 'Acme/Notes', '--timeout-sec', '0'], config, r.project, { forge: botForge(1) }), 0);
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
  assert.equal(runRequest(['5'], r.project, { forge: viewing(upstream) }), 0);
  assert.equal(runRequest(['5', '--kind', 'review'], r.project, { forge: viewing(upstream) }), 0);
  assert.deepEqual(readLocalState(r.project, 5).pending.map((entry) => [entry.kind, entry.repo]), [['request', 'upstream/notes'], ['review', 'upstream/notes']]);
  // Offline, attest falls back to origin, a stated limit: origin's #5 is not the upstream's.
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, null, { forge: viewing(() => null) }), 0);
  assert.deepEqual(marks(r.project, 5), [['request', false, false], ['review', false, false]], 'an attest of origin`s #5 is not the upstream`s');
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, null, { forge: viewing(upstream) }), 0);
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
  // A private repository's comment, from inside the team, with its checks passing every string: the whole record.
  const comments = [{ id: 1, body: summaryBody(remote, null, 'fix_required', { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } }), author_association: 'MEMBER' }];
  const record = { ...readRecord(project, 5, comments, 'acme/notes'), comments };
  record.state.extensions = [{ source: 'bot', round: 3, status: 'asking' }];
  let edited = null;
  const forge = { editComment: (_repo, _id, body) => ((edited = body), {}) };
  return { record, forge, published: () => stateFromComment(edited, 5) };
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
  runRequest(['5', '--kind', 'review'], r.project, { forge: viewing(() => ({ headRefOid: r.commit, url: UPSTREAM })) });
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
  runRequest(['5', '--kind', 'review'], r.project, { forge: viewing(view) });
  const state = readLocalState(r.project, 5);
  noteOutcome(state, { status: 'received', head: r.commit }, () => false, 'Upstream/Notes');
  writeLocalState(r.project, state);
  assert.equal(await runAttest(['5', '--head', r.commit, '--reviewer', 'cr', '--findings', '0', '--fixed', '0'], r.project, null, { forge: viewing(view) }), 0);
  const h2 = 'b'.repeat(40);
  assert.match(checkMcp({ owner: 'Upstream', repo: 'Notes', pullNumber: 5, sha: h2 }, { cwd: r.dir, input: {}, viewPr: () => null }) ?? '', /not head bbbbbbb/u);
  assert.match(r.run(`gh pr merge 5 --match-head-commit ${h2}`) ?? '', /not head bbbbbbb/u);
});

test('signoff resolves the pull request`s repository, and falls back to origin offline', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  // No review ran on the head, so the sign-off is refused, naming the repository it resolved.
  await assert.rejects(runSignoff(['5', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { forge: viewing(() => ({ url: UPSTREAM })) }), /no review of upstream\/notes#5 ran on/u);
  await assert.rejects(runSignoff(['6', '--flow', 'f', '--head', r.commit], r.project, loadConfig(r.project).config, { forge: viewing(() => { throw new Error('offline'); }) }), /no review of acme\/notes#6 ran on/u, 'offline: origin, a stated limit');
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
  // Each repository keeps its own record (#305): the upstream's entry stays owed in its own.
  const owed = (repoOf) => readLocalState(f.project, 9, repoOf).pending.map((entry) => [entry.repo, Boolean(entry.answered)]);
  assert.deepEqual([owed('upstream/notes'), owed('acme/notes')], [[['upstream/notes', false]], [['acme/notes', true]]]);
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
  for (const command of ["cat <<'EOF' | bash\ngh pr merge 5\nEOF", "cat <<'EOF' | tee x | bash\ngh pr merge 5 --squash\nEOF"]) {
    assert.match(r.run(command) ?? '', /feeds a shell text the merge guard cannot read as commands/u, `a heredoc piped into a shell: ${command}`);
  }
  assert.equal(r.run("cat <<'EOF' | bash\nnpm test\nEOF"), null, 'a heredoc piped into a shell naming no merge');
  assert.equal(r.run("cat > notes.md <<'EOF'\ngh pr merge 5\nEOF"), null, 'a heredoc that only feeds a file');
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

// #251 security review: this machine keeps one record a pull request number, so in a checkout whose remotes name
// several repositories it may hold another repository's record of the same number.
test('a long-form sign-off on one repository refuses this machine`s record of the same number in another', async (t) => {
  const r = repo(t, { review: { record: 'local' } });
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  // A record of qg/voila#9 left under the old file name, origin's, before the record was keyed by repository (#305).
  const other = emptyState(9, 'qg/voila');
  noteOutcome(other, { status: 'human_required', head: r.commit }, () => false, 'qg/voila');
  mkdirSync(path.dirname(recordFile(r.project, 9)), { recursive: true });
  writeFileSync(recordFile(r.project, 9), JSON.stringify({ ...other, revision: 1 }));
  const forge = viewing(() => ({ url: 'https://github.com/acme/notes/pull/9', baseRefName: 'main' }));
  await assert.rejects(runSignoff(['9', '--flow', 'f', '--head', r.commit, '--repo', 'acme/notes'], r.project, loadConfig(r.project).config, { forge }),
    /the review record of #9 is for qg\/voila, not acme\/notes: this command records on the pull request that record names\. Give --repo qg\/voila/u);
  await assert.rejects(runSignoff(['9', '--flow', 'f', '--overrule', 'x', '--reason', 'r', '--head', r.commit, '--repo', 'acme/notes'], r.project, loadConfig(r.project).config, { forge }), /is for qg\/voila, not acme\/notes/u);
});

test('a sign-off with `--repo=<value>` beside `--repo` is refused by the command, which the hook leaves to it', async (t) => {
  // The review-signoff rule reads `--repo=qg/voila` as an unknown flag, not a second --repo; the command must refuse it.
  const r = repo(t, { review: { record: 'local' } });
  await assert.rejects(runSignoff(['9', '--flow', 'f', '--head', r.commit, '--repo', 'acme/notes', '--repo=qg/voila'], r.project, loadConfig(r.project).config, { forge: viewing(() => { throw new Error('no forge read'); }) }),
    /unknown argument: --repo=qg\/voila/u);
});

// #305 audit: with records of one number for several repositories, a merge that names none is not checked against
// whichever was written last: the guard asks for the repository.
test('a merge naming no repository, of a number recorded for several repositories, is refused until it names one', (t) => {
  const r = repo(t);
  r.git('remote', 'add', 'upstream', 'https://github.com/Up/Notes.git');
  r.record(5, (state) => outcome(state, 'running'));
  const upstream = emptyState(5, 'up/notes');
  outcome(upstream, 'received');
  writeLocalState(r.project, upstream);
  const denied = r.run(`gh pr merge 5 --match-head-commit ${HEAD}`) ?? '';
  assert.match(denied, /with no repository named, and this machine holds review records of #5 for several repositories \(acme\/notes, up\/notes\)/u, 'the newest record, the upstream`s finished one, does not clear origin`s running review');
  assert.match(denied, /`gh pr merge 5 -R <owner>\/<name> --match-head-commit <sha>`/u);
  assert.match(r.run(`gh pr merge 5 -R acme/notes --match-head-commit ${HEAD}`) ?? '', /is `running`/u, 'named: origin`s own record');
  assert.equal(r.run(`gh pr merge 5 -R up/notes --match-head-commit ${HEAD}`), null, 'named: the upstream`s own record');
  assert.equal(r.run(`gh pr merge 6 --match-head-commit ${HEAD}`), null, 'a number with no record is not ambiguous');
});
