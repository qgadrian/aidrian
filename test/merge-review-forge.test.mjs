import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { prEnvDenial, signoffWriteDenial } from '../plugins/aidrian/lib/handoff-guard.mjs';
import { sandboxSettings } from '../plugins/aidrian/lib/hosts/claude-code-sandbox.mjs';
import codex from '../plugins/aidrian/lib/hosts/codex.mjs';
import { runAutoMerge } from '../plugins/aidrian/lib/pr-auto-merge.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { activeRuns, initRun, recordIssue } from '../plugins/aidrian/lib/project-run.mjs';
import { currentDriver, drivesRun, endedIn, runDriver } from '../plugins/aidrian/lib/project-run-guard.mjs';
import { stateWorkFolders } from '../plugins/aidrian/lib/project-start.mjs';
import { runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { botProblem, flowsFloor, NO_BOT, readHumanSignoffs, recordHumanSignoff, signoffFile, signoffFolder, signoffFolders } from '../plugins/aidrian/lib/review/merge-trust.mjs';
import { recordSignoff } from '../plugins/aidrian/lib/review/run.mjs';
import { emptyState, readLocalState, RECORD_LIST_CAP, recordFile, recordNames, recordProblem, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check, checkMcp, endpointOf, MERGE_MUTATIONS } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { markDriver, markFolder, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { check as signoffCheck, UNATTENDED_REASON } from '../plugins/aidrian/lib/rules/review-signoff.mjs';
import { DRIVER, ISSUES, OTHER, runFixture } from './project-start-fixture.mjs';

// An unattended merge never rests on a record a confined session can write (docs/review.md, Merge trust): the merge guard
// and `aidrian pr auto-merge` confirm the team's policy and the review bot's verdict on the forge, and read the Human's
// flow sign-offs from the sign-off store, which no such session writes. Attended merges are unchanged.

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const OLD = '1234567890abcdef1234567890abcdef12345678';
const BOT = 'chatgpt-codex-connector';
const TEAM = { allow: true, strategy: 'squash', deleteBranch: true, deleteWorktree: false };
const CHECKS = { requiredChecks: ['e2e'], conditionalChecks: [], ignoreCancelledChecks: [] };
const PAYMENTS = { files: ['src/pay/**'], signoff: 'human', invariants: [{ id: 'p1', text: 'a payment is never charged twice' }] };
const configOf = (extra = {}) => ({ version: 1, state: { dir: '../state' }, github: { ...CHECKS, autoMerge: TEAM }, ...extra });

// The bot's status card, as the forge's reviewTrail gives a comment: by the bot, every edit the bot's.
const card = (sha = HEAD, { unresolved = false, any = unresolved, ...extra } = {}) => ({
  id: 9, login: BOT, bot: true, association: 'NONE', at: '2026-11-18T10:00:00Z', editors: [BOT], editsComplete: true,
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_any_findings: any, has_unresolved_findings: unresolved, status: 'completed' } })} -->`,
  ...extra,
});
// The forge's review trail of #7 at HEAD, by default one the policy and the bot both pass: the gh user's own pull
// request, its checks passed, the bot's card on the head, and both branches' config `text` from the forge.
const trailOf = (text, over = {}) => ({
  viewer: 'adrian', head: HEAD, base: 'main', author: 'adrian', draft: false, reviewDecision: '', latestReviews: [],
  checks: { head: HEAD, rows: [{ name: 'e2e', state: 'SUCCESS' }], complete: true },
  files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], filesTotal: 1, filesComplete: true,
  reviews: [], reviewsComplete: true, comments: [card()], commentsComplete: true,
  branches: { default: { name: 'main', pointer: null, config: text, knowledge: null }, base: { name: 'main', pointer: null, config: text } },
  headRef: 'feat/eng-1-export', title: 'feat(export): add CSV export', body: 'Fixes ENG-1', messages: [{ oid: HEAD, message: 'feat: export' }], messagesComplete: true,
  ...over,
});
const changing = (...paths) => ({ files: paths.map((each) => ({ path: each, changeType: 'MODIFIED' })), filesTotal: paths.length });

// A temporary git repository (never a real one, and no GIT_DIR) whose working copy commits `config`, with its origin on
// GitHub, the machine's auto-merge switch on, and its state folder beside it.
function repo(t, config = configOf()) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-trust-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  t.after(() => rmSync(signoffFolder(), { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', 'git@github.com:acme/notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  writeFileSync(path.join(dir, '.gitignore'), '.aidrian.local.json\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'config');
  writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'on' } }));
  const project = projectAt(dir);
  const record = (edit, pr = 7) => {
    const state = emptyState(pr, 'acme/notes');
    edit(state);
    writeLocalState(project, state);
  };
  return { root, dir, git, project, record, text: JSON.stringify(config), commit: git('rev-parse', 'HEAD') };
}

// A record a session wrote by hand: a finished `received` review of the head, and, with `flows`, the flows it names for
// the Human's sign-off on that head, each signed off in the record itself.
const forged = (flows = []) => (state) => {
  state.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' };
  state.signoffable = { head: HEAD, flows };
  for (const flow of flows) state.signoffs[flow] = { head: HEAD, by: 'the Human', at: '2026-11-18T09:01:00.000Z' };
};

// The forge facade `aidrian pr auto-merge` reads through, holding `config` on the default branch and `trail` as the
// review trail. `files` are the pull request's changed paths.
function cliForge(config, { trail = trailOf(config), files = ['src/app.js'] } = {}) {
  const calls = [];
  const changed = files.map((each) => ({ path: each, changeType: 'MODIFIED' }));
  const forge = {
    change: () => ({ number: 7, headRefOid: HEAD, baseRefName: 'main', author: { login: 'adrian' }, url: 'https://github.com/acme/notes/pull/7', files: changed, changedFiles: changed.length, reviewDecision: '', latestReviews: [] }),
    repository: () => ({ default_branch: 'main' }),
    contents: (repoName, file) => {
      calls.push(['contents', file]);
      if (file !== '.aidrian/config.json') throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)\n' });
      return { type: 'file', encoding: 'base64', content: Buffer.from(config).toString('base64') };
    },
    viewer: () => 'adrian',
    conversationComments: () => [],
    reviews: () => [],
    reviewComments: () => [],
    reviewTrail: (repoName, n, { host, paths } = {}) => {
      calls.push(['reviewTrail', repoName, n, host, paths]);
      return typeof trail === 'function' ? trail() : trail;
    },
  };
  return { forge, calls };
}

function autoMerge(t, r, { unattended = true, ...options } = {}) {
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  t.mock.method(console, 'error', () => {});
  const { forge, calls } = cliForge(r.text, options);
  const code = runAutoMerge(['7', '--json'], r.project, { forge, unattended: () => unattended });
  t.mock.restoreAll();
  return { code, result: JSON.parse(out.join('\n')), calls };
}

// The forge the merge guard's trust reads go through, as budgetedForge's `make`: `trail` as the review trail, and
// `config` for the REST reads a pointer to another folder needs. Each call is kept in `calls`.
const guardForge = (config, trail, calls = []) => () => ({
  repository: () => (calls.push(['repository']), { default_branch: 'main' }),
  contents: (repoName, file) => {
    calls.push(['contents', file]);
    if (file !== '.aidrian/config.json') throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)\n' });
    return { type: 'file', encoding: 'base64', content: Buffer.from(config).toString('base64') };
  },
  reviewTrail: (repoName, n, { host, paths } = {}) => {
    calls.push(['reviewTrail', repoName, n, host, paths]);
    return typeof trail === 'function' ? trail() : trail;
  },
});
const viewer = () => ({ number: 7, headRefOid: HEAD });
const merge = (r, command, { mark = { root: r.dir }, trail = trailOf(r.text), calls = [], input = { session_id: 'unattended-1' }, cwd = r.dir } = {}) =>
  check(command, { cwd, env: {}, input, viewPr: viewer, unattendedMark: () => mark, trustForge: guardForge(r.text, trail, calls) });
const mcp = (r, toolInput, { mark = { root: r.dir }, trail = trailOf(r.text), cwd = r.dir } = {}) =>
  checkMcp(toolInput, { cwd, input: { session_id: 'unattended-1' }, viewPr: viewer, unattendedMark: () => mark, trustForge: guardForge(r.text, trail) });
const MERGE = `gh pr merge 7 --squash --match-head-commit ${HEAD}`;
const noBot = (r) => trailOf(r.text, { comments: [] });

test('a forged review record with outcome received on the head, and no bot review of it on the forge, keeps auto-merge off and the merge guard denies an unattended merge', (t) => {
  const r = repo(t);
  r.record(forged());
  const off = autoMerge(t, r, { trail: noBot(r) });
  assert.equal(off.code, 1);
  assert.equal(off.result.reason, 'trust', 'its own reason, apart from the review record`s');
  assert.match(off.result.why, /chatgpt-codex-connector\[bot\] has not passed head abcdef1 on the forge/u);
  assert.deepEqual(off.calls.at(-1), ['reviewTrail', 'acme/notes', 7, 'github.com', { pointer: '.aidrian.json', config: '.aidrian/config.json', knowledge: '.aidrian/knowledge' }]);
  assert.match(merge(r, MERGE, { trail: noBot(r) }) ?? '', /^Blocked: no Human attends this session, and this merges pull request #7, but chatgpt-codex-connector\[bot\] has not passed head abcdef1/u);
  assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, sha: HEAD }, { trail: noBot(r) }) ?? '', /has not passed head abcdef1/u);
  // The bot's passing card on that head lets both through.
  assert.equal(autoMerge(t, r).code, 0);
  assert.equal(merge(r, MERGE), null);
});

test('attended merges are unchanged: auto-merge reads no trail and needs no bot, and the guard asks the forge nothing', (t) => {
  const r = repo(t, configOf({ github: { ...CHECKS, autoMerge: TEAM, reviewer: null } }));
  r.record(forged());
  const attended = autoMerge(t, r, { unattended: false, trail: () => assert.fail('an attended run reads no trail') });
  assert.equal(attended.code, 0, 'no bot set, a received record: on, as before');
  assert.ok(!attended.calls.some((call) => call[0] === 'reviewTrail'));
  const unattended = autoMerge(t, r, { trail: noBot(r) });
  assert.deepEqual([unattended.code, unattended.result.reason], [1, 'trust']);
  assert.equal(unattended.result.why, NO_BOT, 'the refusal names its fix, once');
  assert.equal(unattended.result.trust, 'bot', 'which half is missing');
  assert.equal(attended.result.trust, undefined, 'no trust field off the trust reason');
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  runAutoMerge(['7'], r.project, { forge: cliForge(r.text, { trail: noBot(r) }).forge, unattended: () => true });
  t.mock.restoreAll();
  assert.deepEqual(out, [`auto-merge off for #7 (trust: bot): ${NO_BOT}`], 'the plain line names the reason and the half');
  const calls = [];
  assert.equal(merge(r, MERGE, { mark: null, trail: noBot(r), calls }), null);
  assert.equal(merge(r, 'gh pr merge 7 --auto', { mark: null }), null, '--auto stays the attended session`s to run');
  assert.deepEqual(calls, []);
});

test('no record at all is no way around it: an unattended merge with none still needs the bot`s verdict', (t) => {
  const r = repo(t);
  assert.match(merge(r, MERGE, { trail: noBot(r) }) ?? '', /has not passed head abcdef1/u);
  assert.equal(merge(r, MERGE, { mark: null, trail: noBot(r) }), null, 'attended, with no record: the guard holds no review that never ran');
});

test('the bot`s verdict counts only as the bot`s own, on exactly the head, with nothing found', () => {
  const reviewer = `${BOT}[bot]`;
  const base = (over) => trailOf('{}', over);
  const passes = (trail) => botProblem(trail, HEAD, reviewer);
  assert.equal(passes(base()), null, 'its card, every edit its own');
  assert.equal(passes(base({ comments: [], reviews: [{ login: BOT, bot: true, state: 'APPROVED', commit: HEAD, at: 'x' }] })), null, 'an approving review of the head');
  assert.equal(passes(base({ comments: [card(HEAD.toUpperCase())] })), null, 'the SHA in any case');
  const refused = [
    ['a card of another commit', base({ comments: [card(OLD)] })],
    ['a card of a short SHA', base({ comments: [card(HEAD.slice(0, 10))] })],
    ['a card with findings left', base({ comments: [card(HEAD, { unresolved: true })] })],
    ['a card whose findings the user marked resolved', base({ comments: [card(HEAD, { any: true, unresolved: false })] })],
    ['a card the user edited', base({ comments: [card(HEAD, { editors: [BOT, 'adrian'] })] })],
    ['a card with an edit from a deleted account', base({ comments: [card(HEAD, { editors: [null] })] })],
    ['a card a user posted under the bot`s name', base({ comments: [card(HEAD, { bot: false })] })],
    ['a card by another bot', base({ comments: [card(HEAD, { login: 'github-actions', editors: ['github-actions'] })] })],
    ['a clean receipt, which names a short SHA', base({ comments: [{ ...card(), body: '<!-- codex-review-receipt:v1 -->\n\nCodex Review: Didn\'t find any major issues.\n\n**Reviewed commit:** `abcdef1234`' }] })],
    ['a review with findings on the head beside a clean card', base({ reviews: [{ login: BOT, bot: true, state: 'COMMENTED', commit: HEAD, at: 'x' }] })],
    ['a dismissed review on the head', base({ reviews: [{ login: BOT, bot: true, state: 'DISMISSED', commit: HEAD, at: 'x' }] })],
    ['an approval by a person under the bot`s name', base({ comments: [], reviews: [{ login: BOT, bot: false, state: 'APPROVED', commit: HEAD, at: 'x' }] })],
    ['an approval of another commit', base({ comments: [], reviews: [{ login: BOT, bot: true, state: 'APPROVED', commit: OLD, at: 'x' }] })],
    ['a forge head other than the merge`s', base({ head: OLD })],
  ];
  for (const [what, trail] of refused) assert.match(passes(trail) ?? '', /./u, what);
  assert.match(passes(base({ comments: [card(HEAD, { editsComplete: false })] })) ?? '', /gave only part of its status card's edit history/u, 'cut short, said so');
  assert.match(passes(base({ comments: [card(HEAD, { editors: [BOT, 'adrian'] })] })) ?? '', /edited by another account/u);
  assert.equal(botProblem(base(), HEAD, null), NO_BOT);
  assert.match(passes(base({ comments: [], commentsComplete: false })) ?? '', /more comments than the forge read gives/u);
});

test('an unattended merge names its number and full head, in the repository the session is pinned to, and never leaves the merge to GitHub', (t) => {
  const r = repo(t);
  r.record(forged());
  const calls = [];
  assert.match(merge(r, 'gh pr merge 7 --squash', { calls }) ?? '', /does not name both its number and its full head commit/u);
  assert.match(merge(r, `gh pr merge 7 --match-head-commit ${HEAD.slice(0, 7)}`) ?? '', /full head commit/u, 'a short head');
  assert.match(merge(r, `gh pr merge 7 -R acme/other --match-head-commit ${HEAD}`) ?? '', /it names acme\/other, and this session works in acme\/notes/u);
  assert.match(merge(r, `gh pr merge 7 --auto --match-head-commit ${HEAD}`, { calls }) ?? '', /`--auto` leaves the merge to GitHub/u);
  // The Codex connector's auto-merge tool names no head.
  assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7 }) ?? '', /does not name both its number and its full head/u);
  assert.deepEqual(calls, [], 'no forge read for a merge refused before it');
  assert.equal(merge(r, `gh pr merge 7 -R Acme/Notes --match-head-commit ${HEAD}`, { calls }), null);
  assert.deepEqual(calls, [['reviewTrail', 'acme/notes', 7, 'github.com', { pointer: '.aidrian.json', config: '.aidrian/config.json', knowledge: '.aidrian/knowledge' }]],
    'one forge read, the trail, which holds both branches` configs: the pinned repository and its host, passed explicitly');
  assert.equal(merge(r, `gh api -X PUT repos/acme/notes/pulls/7/merge -f sha=${HEAD}`), null, 'the API merge naming its head');
  // The GitHub MCP server's own merge tool names the head as expectedHeadSha, which GitHub's merge enforces.
  assert.equal(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, expectedHeadSha: HEAD }), null);
  const failing = merge(r, MERGE, { trail: () => { throw new Error('gh: Bad credentials (HTTP 401)'); } });
  assert.match(failing ?? '', /the forge could not confirm it in time \(gh: Bad credentials \(HTTP 401\)\); running the merge once more is safe/u);
});

test('a GraphQL merge, auto-merge, or queue mutation is refused to a session no Human attends, and stays an attended session`s call', (t) => {
  const r = repo(t);
  const query = path.join(r.root, 'merge.graphql');
  writeFileSync(query, 'mutation { mergePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }');
  const plain = path.join(r.root, 'viewer.graphql');
  writeFileSync(plain, 'query { viewer { login } }');
  for (const command of [
    'gh api graphql -f query=\'mutation { mergePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enablePullRequestAutoMerge(input: { pullRequestId: "PR_x" }) { clientMutationId } }\'',
    'gh api graphql -f query=\'mutation { enqueuePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }\'',
    `gh api graphql -F query=@${query}`,
    `gh api graphql --input ${query}`,
    'gh api graphql -f query="$Q"',
    `gh api graphql -F query=@${path.join(r.root, 'missing.graphql')}`,
  ]) {
    assert.match(merge(r, command) ?? '', /GraphQL call/u, command);
    assert.equal(merge(r, command, { mark: null }), null, `attended: ${command}`);
  }
  assert.equal(merge(r, `gh api graphql -F query=@${plain} -F n=$N`), null, 'a query that merges nothing');
  assert.match(merge(r, 'echo mergePullRequest | bash') ?? '', /cannot read as commands/u, 'fed text naming one');
});

test('a session no Human attends is held to the projects its mark names, wherever its call runs', (t) => {
  const r = repo(t);
  r.record(forged());
  // A git folder of its own inside its checkout, with no project: the guard still holds it to the mark's.
  const nested = path.join(r.dir, 'q');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  assert.match(merge(r, MERGE, { cwd: nested, trail: noBot(r) }) ?? '', /has not passed head abcdef1/u);
  assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, sha: HEAD }, { cwd: nested, trail: noBot(r) }) ?? '', /has not passed head abcdef1/u);
  assert.equal(merge(r, MERGE, { cwd: nested, mark: null }), null, 'attended, outside a project: no guard, as before');
  // A mark that names no project the guard can read denies, wherever the call runs.
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  for (const mark of [{ root: null }, { root: outside }]) {
    assert.match(merge(r, MERGE, { cwd: outside, mark }) ?? '', /the project its unattended mark names cannot be read/u);
    assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, sha: HEAD }, { cwd: outside, mark }) ?? '', /cannot be read/u);
  }
  // The gate's start folder gives the folder and the records, never the policy: a main checkout that is no project denies.
  assert.match(merge(r, MERGE, { cwd: outside, mark: { root: outside, cwd: r.dir } }) ?? '', /the project its unattended mark names cannot be read/u);
  assert.equal(merge(r, MERGE, { cwd: outside, mark: { root: r.dir, cwd: r.dir } }), null);
});

test('for a session no Human attends, the merge guard asks auto-merge`s policy of the forge too', (t) => {
  const r = repo(t);
  r.record(forged());
  const off = (over, why, text = r.text) => assert.match(merge(r, MERGE, { trail: trailOf(text, over) }) ?? '', why, String(why));
  off({}, /the team does not allow auto-merge \(github\.autoMerge\.allow on main\)/u, JSON.stringify(configOf({ github: { ...CHECKS, autoMerge: { ...TEAM, allow: false } } })));
  off({ base: 'release', branches: { default: { name: 'main', pointer: null, config: r.text, knowledge: null }, base: { name: 'release', pointer: null, config: JSON.stringify(configOf({ github: { ...CHECKS, autoMerge: { allow: false } } })) } } }, /allow on release/u);
  off({}, /names no required checks/u, JSON.stringify(configOf({ github: { requiredChecks: [], autoMerge: TEAM } })));
  off(changing('AGENTS.md'), /instructs AI sessions/u);
  off(changing('.aidrian/config.json'), /instructs AI sessions|policy/u);
  off({ ...changing('src/app.js'), filesTotal: 101, filesComplete: false }, /gh listed 1 of its 101 changed files/u);
  off({ author: 'mallory' }, /it is mallory's pull request, not adrian's/u);
  off({ comments: [card(), { id: 2, login: 'mallory', bot: false, association: 'NONE', body: 'hi', editors: [], editsComplete: true }] }, /mallory commented, and is no member/u);
  off({ latestReviews: [{ author: { login: 'lead' }, state: 'CHANGES_REQUESTED' }] }, /lead requested changes/u);
  off({ draft: true }, /it is a draft/u);
  off({ checks: { head: HEAD, rows: [{ name: 'e2e', state: 'IN_PROGRESS' }], complete: true } }, /checks on head abcdef1 are pending/u);
  off({ checks: { head: HEAD, rows: [{ name: 'e2e', state: 'FAILURE' }], complete: true } }, /are failing/u);
  off({ checks: { head: HEAD, rows: [], complete: true } }, /e2e \(required, not reported yet\)/u);
  off({ checks: { head: OLD, rows: [{ name: 'e2e', state: 'SUCCESS' }], complete: true } }, /did not give every check of head abcdef1/u);
  // The main checkout's own switch, off.
  writeFileSync(path.join(r.dir, '.aidrian.local.json'), JSON.stringify({ github: { autoMerge: 'off' } }));
  off({}, /this machine has not opted in to auto-merge/u);
});

test('a project run`s issue session merges only in the repository its run pinned, read from the run`s ledger', (t) => {
  const fx = runFixture(t, { local: { handoff: { background: 'on' }, github: { autoMerge: 'on' } } });
  t.after(() => rmSync(signoffFolder(), { recursive: true, force: true }));
  const record = emptyState(7, 'acme/widgets');
  record.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' };
  writeLocalState(fx.project, record);
  const text = JSON.stringify({ ...fx.committed, github: { ...CHECKS, autoMerge: TEAM } });
  const calls = [];
  const run = (command, mark) => check(command, { cwd: fx.dir, env: {}, input: { session_id: 'issue-1' }, viewPr: viewer, unattendedMark: () => mark, trustForge: guardForge(text, trailOf(text), calls) });
  const mark = { root: fx.dir, project: 'launch', issue: 'ENG-1' };
  assert.equal(run(MERGE, mark), null);
  assert.deepEqual(calls.map((call) => call.slice(0, 4)), [['reviewTrail', 'acme/widgets', 7, 'github.com']]);
  assert.match(run(`gh pr merge 7 -R acme/notes --match-head-commit ${HEAD}`, mark) ?? '', /it names acme\/notes, and this session works in acme\/widgets/u);
  assert.match(run(MERGE, { ...mark, project: 'other-run' }) ?? '', /cannot be told: no project run of its mark pinned one/u, 'a run its mark names that is not there');
});

test('a forged sign-off in the review record, a sandbox-writable folder, does not count as the Human`s: only the sign-off store does', (t) => {
  const r = repo(t, configOf({ review: { flows: { payments: PAYMENTS } } }));
  r.record(forged(['payments']));
  // A copy of a store file planted in the reviews folder, which a confined session can write, is no store either.
  const planted = path.join(path.dirname(recordFile(r.project, 7, 'acme/notes')), 'signoffs', 'acme', 'notes', '7.json');
  mkdirSync(path.dirname(planted), { recursive: true });
  writeFileSync(planted, JSON.stringify({ version: 1, repo: 'acme/notes', pr: 7, flows: { payments: { head: HEAD, by: 'the Human', at: 'x' } } }));
  const trail = trailOf(r.text, changing('src/pay/charge.js'));
  const off = autoMerge(t, r, { files: ['src/pay/charge.js'], trail });
  assert.equal(off.code, 1);
  assert.match(off.result.why, /flow payments needs the Human's sign-off on head abcdef1 \(it changes a file of the flow\), and this machine's sign-off store holds none/u);
  assert.equal(off.result.trust, 'signoff');
  assert.deepEqual([off.result.flow, off.result.signoffClass], ['payments', 'product'], 'a flow with no security tag or reviewer is a product decision');
  assert.match(merge(r, MERGE, { trail }) ?? '', /flow payments needs the Human's sign-off/u);
  // The record naming no flow at all does not lift the floor the forge's file list gives.
  r.record(forged([]));
  assert.match(merge(r, MERGE, { trail }) ?? '', /flow payments needs the Human's sign-off on head abcdef1 \(it changes a file of the flow\)/u);
  recordHumanSignoff({ repo: 'acme/notes', pr: 7, flow: 'payments', head: OLD, by: 'Adrian' });
  assert.match(merge(r, MERGE, { trail }) ?? '', /holds none for that head/u, 'a sign-off of another head');
  recordHumanSignoff({ repo: 'acme/notes', pr: 7, flow: 'payments', head: HEAD, by: 'Adrian' });
  assert.equal(merge(r, MERGE, { trail }), null);
  assert.equal(autoMerge(t, r, { files: ['src/pay/charge.js'], trail }).code, 0);
  rmSync(signoffFolder(), { recursive: true, force: true });
  assert.equal(merge(r, MERGE), null, 'a file outside the flow asks for no sign-off');
});

test('`aidrian pr signoff` stores the head the Human typed, resolved in their checkout, never a full head the record names', async (t) => {
  const r = repo(t, configOf({ review: { flows: { payments: PAYMENTS }, record: 'local' } }));
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  // A forged record whose full head shares the typed prefix, but is no commit of this checkout.
  const forgedHead = `${r.commit.slice(0, 7)}${'f'.repeat(33)}`;
  r.record((state) => {
    state.signoffable = { head: forgedHead, flows: ['payments'] };
  });
  const forge = { change: () => ({ url: 'https://github.com/acme/notes/pull/7', baseRefName: 'main' }), reviewTrail: () => { throw new Error('offline'); } };
  const sign = (head, flags = []) => runSignoff(['7', '--flow', 'payments', '--head', head, '--repo', 'acme/notes', ...flags], r.project, loadConfig(r.project).config, { forge });
  await sign(r.commit.slice(0, 7), ['--check']);
  assert.deepEqual(readHumanSignoffs({ repo: 'acme/notes', pr: 7 }).flows, {}, '--check writes nothing');
  await sign(r.commit.slice(0, 7));
  assert.equal(readHumanSignoffs({ repo: 'acme/notes', pr: 7 }).flows.payments.head, r.commit, 'the typed head, resolved here');
  assert.equal(readLocalState(r.project, 7, 'acme/notes').signoffs.payments.head, r.commit.slice(0, 7), 'the record keeps what it kept');
  await assert.rejects(sign('deadbeef'), /is not one commit of this repository/u, 'a head this checkout does not have');
});

test('every flow the forge-only floor names on a head is one `aidrian pr signoff` accepts there', (t) => {
  const flows = { payments: PAYMENTS, refunds: { ...PAYMENTS, files: ['src/refund/**'], added: ['refund\\('] }, search: { files: ['src/search/**'], tests: ['test/search/**'], invariants: 'docs/search.md' } };
  const config = configOf({ review: { flows, planCommand: 'node plan.mjs' } });
  const r = repo(t, config);
  r.record(() => {});
  const files = [{ path: 'src/pay/a.js', changeType: 'MODIFIED' }, { path: 'test/search/a.test.js', changeType: 'DELETED' }];
  const floor = [...flowsFloor({ files, configs: [loadConfig(r.project).config], prefix: '' }).flows].sort();
  assert.deepEqual(floor, ['harness-config', 'payments', 'refunds', 'search']);
  for (const flow of floor) {
    recordSignoff(r.project, { pr: 7, repo: 'acme/notes', flow, head: HEAD, floor, by: 'Adrian', dryRun: true });
    assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'acme/notes', flow, head: HEAD, by: 'Adrian', dryRun: true }), /no review of acme\/notes#7 ran/u, 'without the floor, as before');
  }
});

test('the floor of flows a merge needs the Human for comes from the forge`s file list and configs alone, as the plan selects', () => {
  const flows = { payments: PAYMENTS, search: { files: ['src/search/**'], tests: ['test/search/**'], invariants: 'docs/search.md' }, cited: { ...PAYMENTS, files: ['src/cite/**'], invariants: [{ id: 'c1', cite: 'docs/rules.md#money' }] } };
  const base = { review: { flows, planCommand: null, ignore: ['dist/**'], nonBehaviour: ['**/*.md'] } };
  const floor = (paths, { changeType = 'MODIFIED', complete = true, configs = [base], prefix = '', policyFiles = [] } = {}) =>
    [...flowsFloor({ files: paths.map((each) => ({ path: each, changeType })), complete, configs, prefix, policyFiles }).flows].sort();
  assert.deepEqual(floor(['src/app.js']), []);
  assert.deepEqual(floor(['src/pay/charge.js']), ['payments']);
  assert.deepEqual(floor(['src/pay/README.md']), [], 'a file the config sorts as no behaviour, as detectFlows does');
  assert.deepEqual(floor(['dist/pay/x.js'], { configs: [{ review: { ...base.review, flows: { payments: { ...PAYMENTS, files: ['dist/pay/**'] } } } }] }), [], 'an ignored file');
  assert.deepEqual(floor(['src/search/index.js']), [], 'a flow its reviewer signs');
  assert.deepEqual(floor(['test/search/a.test.js'], { changeType: 'DELETED' }), ['search'], 'a deleted test of any flow');
  assert.deepEqual(floor(['docs/search.md']), ['harness-config'], 'a flow`s invariants doc');
  assert.deepEqual(floor(['docs/rules.md']), ['harness-config'], 'a doc an invariant cites');
  assert.deepEqual(floor(['.aidrian/config.json']), ['harness-config'], 'the review config');
  assert.deepEqual(floor(['conf/aidrian/config.json'], { policyFiles: ['.aidrian.json', 'conf/aidrian/config.json'] }), ['harness-config'], 'a config a pointer relocates');
  assert.deepEqual(floor(['src/app.js'], { changeType: 'RENAMED' }), ['cited', 'harness-config', 'payments', 'search'], 'a rename may hide a deleted path');
  assert.deepEqual(floor(['src/app.js'], { complete: false }), ['cited', 'harness-config', 'payments', 'search'], 'a list cut short');
  const commanded = (review) => floor(['src/app.js'], { configs: [{ review: { ...base.review, ...review } }] });
  for (const review of [{ planCommand: 'node plan.mjs' }, { reviewers: { mine: { kind: 'exec', command: ['node', 'r.mjs'] } } }, { visual: { login: 'node login.mjs' } }, { visual: { preview: 'npm run preview' } }]) {
    assert.deepEqual(commanded(review), ['cited', 'harness-config', 'payments'], JSON.stringify(review));
  }
  assert.deepEqual(floor(['src/app.js'], { configs: [{ review: { flows: { payments: { ...PAYMENTS, added: ['charge\\('] } } } }] }), ['payments'], 'selected by added lines');
  assert.deepEqual(floor(['src/app.js'], { configs: [base, { review: { flows: { refunds: { ...PAYMENTS, files: ['src/app.js'] } } } }] }), ['refunds'], 'the base`s flows too');
  assert.deepEqual(floor(['web/src/pay/charge.js', 'src/pay/x.js'], { prefix: 'web/' }), ['payments'], 'paths from the project root; a file outside it selects nothing');
});

test('the review record is read bounded: a FIFO, a link, or a huge file never stalls the guard, and an unattended merge refuses on it', (t) => {
  const r = repo(t);
  r.record(forged());
  const file = recordFile(r.project, 7, 'acme/notes');
  rmSync(file);
  execFileSync('mkfifo', [file]);
  const started = Date.now();
  assert.match(merge(r, MERGE) ?? '', /the review record file .* is not a regular file/u);
  assert.ok(Date.now() - started < 3000, 'well inside the hook`s time');
  assert.equal(merge(r, MERGE, { mark: null }), null, 'attended: read as no record, at once');
  rmSync(file);
  writeFileSync(path.join(r.root, 'elsewhere.json'), '{}');
  symlinkSync(path.join(r.root, 'elsewhere.json'), file);
  assert.match(merge(r, MERGE) ?? '', /cannot be opened as a plain file/u, 'a link is never followed');
  rmSync(file);
  writeFileSync(file, '');
  truncateSync(file, 33 * 1024 * 1024);
  assert.match(merge(r, MERGE) ?? '', /is larger than/u);
});

test('`aidrian pr signoff` is refused to a subagent and a session no Human attends, whatever an answer says; the dry run still runs', (t) => {
  const r = repo(t);
  const command = `aidrian pr signoff 7 --flow payments --head ${HEAD}`;
  const free = () => false;
  assert.equal(signoffCheck(command, { cwd: r.dir, input: { agent_id: 'a1' }, unattendedMark: () => null, drives: free }), UNATTENDED_REASON);
  assert.equal(signoffCheck(command, { cwd: r.dir, input: { session_id: 's1' }, unattendedMark: () => ({ root: r.dir }), drives: free }), UNATTENDED_REASON);
  assert.equal(signoffCheck('aidrian pr signoff 7 --last', { cwd: r.dir, input: {}, unattendedMark: () => ({ root: null }), drives: free }), UNATTENDED_REASON);
  assert.equal(signoffCheck(command, { cwd: r.dir, input: { session_id: 's1' }, unattendedMark: () => null, drives: () => true }), UNATTENDED_REASON, 'a run`s driver');
  assert.equal(signoffCheck(`${command} --check`, { cwd: r.dir, input: { agent_id: 'a1' }, unattendedMark: () => ({ root: r.dir }), drives: () => true }), null);
  assert.notEqual(signoffCheck(command, { cwd: r.dir, input: {}, unattendedMark: () => null, drives: free }), UNATTENDED_REASON, 'an attended main session keeps its answer route');
});

test('the sign-off store reads only files of this user`s alone, never through a link', (t) => {
  t.after(() => rmSync(signoffFolder(), { recursive: true, force: true }));
  recordHumanSignoff({ repo: 'Acme/Notes', pr: 3, flow: 'payments', head: HEAD, by: 'Adrian' });
  const file = signoffFile('acme/notes', 3);
  assert.equal(readFileSync(file, 'utf8').includes('"payments"'), true);
  assert.equal(readHumanSignoffs({ repo: 'acme/notes', pr: 3 }).flows.payments.head, HEAD);
  assert.deepEqual(readHumanSignoffs({ repo: 'acme/notes', pr: 4 }), { flows: {} }, 'no file, no sign-off');
  chmodSync(file, 0o666);
  assert.match(readHumanSignoffs({ repo: 'acme/notes', pr: 3 }).problem ?? '', /may be written another way/u);
  chmodSync(file, 0o600);
  const elsewhere = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-planted-')), '5.json');
  t.after(() => rmSync(path.dirname(elsewhere), { recursive: true, force: true }));
  writeFileSync(elsewhere, JSON.stringify({ version: 1, repo: 'acme/notes', pr: 5, flows: { payments: { head: HEAD, by: 'x', at: 'x' } } }));
  symlinkSync(elsewhere, signoffFile('acme/notes', 5));
  assert.match(readHumanSignoffs({ repo: 'acme/notes', pr: 5 }).problem ?? '', /cannot be read/u, 'a link is never followed');
  const folder = path.dirname(signoffFile('other/repo', 1));
  mkdirSync(path.dirname(folder), { recursive: true });
  symlinkSync(path.dirname(elsewhere), folder);
  assert.match(readHumanSignoffs({ repo: 'other/repo', pr: 1 }).problem ?? '', /is not a plain folder/u, 'nor a linked folder');
  assert.throws(() => recordHumanSignoff({ repo: 'acme/notes', pr: 3, flow: 'payments', head: HEAD.slice(0, 7), by: 'x' }), /full commit SHA/u);
  assert.equal(signoffFile('../etc', 1), null);
  assert.equal(signoffFile('acme/..', 1), null);
});

test('the agent gate refuses a subagent, and a session no Human attends, a write to the sign-off store; the sandbox denies it to commands and file tools', (t) => {
  const r = repo(t);
  const store = signoffFile('acme/notes', 7);
  const names = { names: { human: 'Adrian' } };
  const write = { tool_name: 'Write', tool_input: { file_path: store, content: '{}' }, cwd: r.dir };
  assert.match(signoffWriteDenial(write, names, { unattended: () => true })?.reason ?? '', /changes the sign-off store/u);
  assert.match(signoffWriteDenial({ ...write, agent_id: 'a1' }, names)?.reason ?? '', /only `aidrian pr signoff` in a main session the Human attends writes/u);
  assert.ok(signoffWriteDenial({ tool_name: 'Bash', tool_input: { command: `mkdir -p ${path.dirname(store)} && echo '{}' > ${store}` }, cwd: r.dir }, names, { unattended: () => true }));
  assert.ok(signoffWriteDenial({ tool_name: 'Bash', tool_input: { command: 'cd "$S" && rm -rf signoffs' }, cwd: r.dir }, names, { unattended: () => true }), 'by its name in a folder no path gives');
  assert.equal(signoffWriteDenial(write, names, { unattended: () => false }), null, 'an attended main session');
  const hook = spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-agent-gates.mjs'], {
    input: JSON.stringify({ session_id: 'attended-1', agent_id: 'a5f0c1', agent_type: 'aidrian:explorer', tool_name: 'Bash', tool_input: { command: `printf x > ${store}` }, cwd: r.dir }),
    encoding: 'utf8', env: { ...process.env, AIDRIAN_TELEMETRY: '0' },
  });
  assert.equal(hook.status, 2, hook.stderr);
  assert.match(hook.stderr, /the sign-off store/u);
  const home = path.join(r.root, 'home');
  const folders = signoffFolders({ home });
  assert.ok(folders.includes(signoffFolder()) && folders.includes(path.join(home, '.local/state/aidrian/signoffs')));
  const settings = sandboxSettings({ work: '/w', git: '/g', grants: ['/g'], domains: ['github.com'], temp: [], home, platform: 'linux', guarded: folders });
  for (const each of folders) {
    assert.ok(settings.sandbox.filesystem.denyWrite.includes(each), each);
    assert.ok(settings.permissions.deny.includes(`Edit(/${each})`) && settings.permissions.deny.includes(`Edit(/${each}/**)`), `the file tools: ${each}`);
  }
});

test('a session no Human attends may not move the state root of an `aidrian pr` command', () => {
  const names = { names: { human: 'Adrian' } };
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: '/w' });
  const held = { unattended: () => true };
  for (const command of ['XDG_STATE_HOME=/tmp/x aidrian pr auto-merge 7', 'env -u HOME aidrian pr signoff 7 --last', 'HOME=/w aidrian "$SUB" 7']) {
    assert.match(prEnvDenial(bash(command), names, held)?.reason ?? '', /would move the state root/u, command);
    assert.equal(prEnvDenial(bash(command), names, { unattended: () => false }), null, `attended: ${command}`);
  }
  assert.equal(prEnvDenial(bash('AIDRIAN_ALLOW_EXTRA_ROUNDS=1 aidrian pr await-review 7 --request'), names, held), null, 'a variable that moves no state root');
  assert.equal(prEnvDenial(bash('XDG_STATE_HOME=/tmp/x aidrian check'), names, held), null, 'not an `aidrian pr` command');
});

test('Codex: a writable root or a temporary folder that reaches the sign-off store halts the start; a state work folder linked to it is a problem', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-codex-store-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(root, 'state'), CODEX_HOME: path.join(root, 'codex'), HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp') };
  mkdirSync(env.CODEX_HOME);
  const store = path.join(env.XDG_STATE_HOME, 'aidrian', 'signoffs');
  mkdirSync(store, { recursive: true });
  const guarded = signoffFolders({ env, home: env.HOME });
  const access = codex.capabilities.projectStart.access;
  const toml = (lines) => writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), `[sandbox_workspace_write]\nnetwork_access = true\nexclude_slash_tmp = true\n${lines}`);
  toml(`writable_roots = [${JSON.stringify(path.join(env.XDG_STATE_HOME, 'aidrian', 'signoffs'))}]\n`);
  assert.match(access({ env, guarded }) ?? '', /makes .*signoffs writable .* which reaches .*signoffs/u);
  toml('');
  assert.equal(access({ env, guarded }), null);
  assert.match(access({ env: { ...env, TMPDIR: env.XDG_STATE_HOME }, guarded }) ?? '', /lets a session write .* which reaches .*signoffs.*exclude_tmpdir_env_var/u, '$TMPDIR holding the store');
  toml('exclude_tmpdir_env_var = true\n');
  assert.equal(access({ env: { ...env, TMPDIR: env.XDG_STATE_HOME }, guarded }), null, 'excluded');
  writeFileSync(path.join(env.CODEX_HOME, 'config.toml'), '[sandbox_workspace_write]\nnetwork_access = true\n');
  const underTmp = ['/tmp'].map((each) => realpathSync(each)).find((each) => guarded.some((folder) => folder.startsWith(`${each}${path.sep}`)));
  if (underTmp) assert.match(access({ env, guarded }) ?? '', /exclude_slash_tmp/u, '/tmp holding the store');
  // A state work folder that is a link to the store is no plain folder of the state folder.
  const state = path.join(root, 'project-state');
  mkdirSync(state);
  symlinkSync(store, path.join(state, 'tmp'));
  assert.match(stateWorkFolders(state, { env, home: env.HOME }).problem ?? '', /tmp/u);
  assert.equal(existsSync(path.join(store, 'x')), false);
});

test('a pull request that changes .aidrian/config.json, where projectRun widens what runs outside the sandbox, never auto-merges itself', (t) => {
  // includeGuardedPaths on both branches lifts the guarded-path refusals, never a policy file's (POLICY_PATHS).
  const config = configOf({ github: { ...CHECKS, autoMerge: { ...TEAM, includeGuardedPaths: true } }, projectRun: { allow: true } });
  const r = repo(t, config);
  r.record(forged());
  for (const file of ['.aidrian/config.json', 'apps/web/.aidrian/config.json', '.aidrian.json']) {
    for (const unattended of [false, true]) {
      const off = autoMerge(t, r, { files: [file], unattended, trail: trailOf(r.text, changing(file)) });
      assert.equal(off.result.reason, 'paths', `${file}, unattended ${unattended}`);
      assert.match(off.result.why, /a policy file of aidrian|a file the gate reads its policy from/u, file);
    }
    assert.match(merge(r, MERGE, { trail: trailOf(r.text, changing(file)) }) ?? '', /a policy file of aidrian|a file the gate reads its policy from/u, `the guard: ${file}`);
  }
  assert.equal(existsSync(signoffFolder()), false, 'nothing reached the store');
});

test('`aidrian project init` marks its session the run`s driver, held as one no Human attends for the runs folder, the marks, and the sign-off store, until the run`s recorded end', (t) => {
  const fx = runFixture(t);
  const seen = { env: fx.env, home: fx.home };
  const state = realpathSync(fx.state);
  assert.deepEqual(runDriver(DRIVER, seen), { run: 'launch', project: fx.project, root: fx.run().init.main, state }, 'by its mark alone, naming its state folder');
  assert.equal(drivesRun(OTHER, seen), false);
  // The call's folder plays no part: a nested git folder, or one outside the project.
  const nested = path.join(fx.dir, 'q');
  mkdirSync(nested);
  execFileSync('git', ['init', '-q'], { cwd: nested });
  const outside = mkdtempSync(path.join(tmpdir(), 'aidrian-driver-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const hook = (session, command, cwd) => spawnSync(process.execPath, ['plugins/aidrian/scripts/hook-agent-gates.mjs'], {
    input: JSON.stringify({ session_id: session, tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8', env: { ...fx.env, AIDRIAN_TELEMETRY: '0' },
  });
  const ledger = path.join(fx.state, 'runs', 'launch', 'ledger.jsonl');
  const snapshot = path.join(fx.state, 'runs', 'launch', 'snapshot.json');
  const store = path.join(signoffFolder(fx.env), 'acme', 'widgets', '7.json');
  for (const cwd of [fx.dir, nested, outside]) {
    for (const command of [`echo '{}' >> ${ledger}`, `printf x > ${snapshot}`, `printf x > ${store}`]) {
      const result = hook(DRIVER, command, cwd);
      assert.equal(result.status, 2, `${cwd}: ${command}: ${result.stderr}`);
    }
  }
  assert.equal(hook(OTHER, `printf x > ${store}`, fx.dir).status, 0, 'a session the Human attends, with no driver mark');
  const signoff = `aidrian pr signoff 7 --flow payments --head ${HEAD}`;
  for (const cwd of [fx.dir, nested]) {
    assert.equal(signoffCheck(signoff, { cwd, input: { session_id: DRIVER }, unattendedMark: () => null, drives: () => drivesRun(DRIVER, seen) }), UNATTENDED_REASON, `the driver, from ${cwd}`);
    assert.equal(signoffCheck(signoff, { cwd, input: { session_id: OTHER }, unattendedMark: () => ({ root: fx.dir }), drives: () => false }), UNATTENDED_REASON, `a marked session, from ${cwd}`);
  }
  assert.notEqual(signoffCheck(signoff, { cwd: fx.dir, input: { session_id: OTHER }, unattendedMark: () => null, drives: () => drivesRun(OTHER, seen) }), UNATTENDED_REASON);
  // Whatever its age, the mark holds; one that cannot be read holds, and so does a state folder with no such ledger.
  const mark = path.join(fx.env.XDG_STATE_HOME, 'aidrian', 'unattended', `driver.${DRIVER}.json`);
  const old = Date.now() / 1000 - 400 * 24 * 3600;
  utimesSync(mark, old, old);
  assert.equal(runDriver(DRIVER, seen)?.run, 'launch', 'a year-old mark still holds');
  const text = readFileSync(mark, 'utf8');
  writeFileSync(mark, 'not json');
  assert.deepEqual(runDriver(DRIVER, seen), { run: null, project: null, root: null, state: null });
  writeFileSync(mark, text.replace(JSON.stringify(state), JSON.stringify(outside)));
  assert.equal(runDriver(DRIVER, seen)?.run, 'launch', 'the ledger is read only in the state folder the mark names; none there holds');
  writeFileSync(mark, text);
  // Every issue parked is no end: sign-offs are still owed. Only the driver's recorded end releases it.
  for (const issue of fx.run().snapshot.issues) recordIssue(fx.state, 'launch', { key: issue.key, state: 'parked', decision: 'd1' });
  assert.equal(drivesRun(DRIVER, seen), true, 'a run whose issues are all parked still holds its driver');
  assert.notEqual(fx.cmd(['end', 'launch'], { session: OTHER }).exitCode, 0, 'only the driver records the end');
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal(runDriver(DRIVER, seen), null, 'the recorded end releases it');
  assert.match(fx.cmd(['start', 'launch', 'ENG-1']).err.join('\n'), /ended/u, 'a run that ended starts no issue');
});

test('an end row a session other than the run`s driver wrote releases nothing: the driver stays held and the run active', (t) => {
  const fx = runFixture(t);
  const seen = { env: fx.env, home: fx.home };
  const ledger = path.join(fx.state, 'runs', 'launch', 'ledger.jsonl');
  // A stray end row, as a session that may write the ledger by mistake, or a planted one, would leave it.
  appendFileSync(ledger, `${JSON.stringify({ event: 'end', session: OTHER, at: new Date().toISOString() })}\n`);
  assert.equal(endedIn(fx.run()), false);
  assert.equal(runDriver(DRIVER, seen)?.run, 'launch', 'the driver is still held');
  assert.equal(currentDriver(DRIVER, seen)?.run, 'launch', 'and still the run`s driver');
  assert.deepEqual(activeRuns(fx.state), [{ run: 'launch' }], 'the run is still under way');
  assert.doesNotMatch(fx.cmd(['start', 'launch', 'ENG-1']).err.join('\n'), /ended/u, 'a stray end row ends no run');
  // The driver's own end row, by custody, releases it, once the issue that start began has settled: end refuses while
  // an issue runs.
  recordIssue(fx.state, 'launch', { key: 'ENG-1', state: 'parked', decision: 'd1' });
  assert.equal(fx.cmd(['end', 'launch']).exitCode, 0);
  assert.equal(endedIn(fx.run()), true);
  assert.equal(runDriver(DRIVER, seen), null);
  assert.deepEqual(activeRuns(fx.state), []);
});

test('`aidrian project init` refuses when it cannot file the driver mark, before any row', (t) => {
  const fx = runFixture(t, { init: false });
  const folder = path.join(fx.env.XDG_STATE_HOME, 'aidrian', 'unattended');
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(path.dirname(folder), { recursive: true });
  writeFileSync(folder, 'a file where the marks folder goes');
  const file = path.join(fx.dir, 'snapshot.json.input');
  writeFileSync(file, JSON.stringify({ issues: ISSUES }));
  const result = fx.cmd(['init', 'launch', '--file', file]);
  assert.equal(result.exitCode, 1);
  assert.match(result.err.join('\n'), /driver mark cannot be filed/u);
  assert.equal(existsSync(path.join(fx.state, 'runs', 'launch')), false, 'no run folder, no row');
});

test('a project run`s driver merges as a session no Human attends: the guard holds it to merge trust, and auto-merge says trust', (t) => {
  const r = repo(t);
  r.record(forged());
  const home = path.join(r.root, 'home');
  const session = 'abcd1234-0000-4000-8000-00000000d0d0';
  const state = path.join(r.root, 'state-of-run');
  mkdirSync(state);
  markDriver(session, { run: 'launch', root: r.dir, state });
  t.after(() => rmSync(path.join(markFolder(), `driver.${session}.json`), { force: true }));
  const guard = check(MERGE, { cwd: r.dir, env: {}, input: { session_id: session }, viewPr: viewer, home, trustForge: guardForge(r.text, noBot(r)) });
  assert.match(guard ?? '', /^Blocked: no Human attends this session, .* has not passed head abcdef1/u, 'by the default reader, from its driver mark');
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  const code = runAutoMerge(['7', '--json'], r.project, { forge: cliForge(r.text, { trail: noBot(r) }).forge, session, home });
  t.mock.restoreAll();
  assert.deepEqual([code, JSON.parse(out.join('\n')).reason], [1, 'trust']);
  // A driver held with no project it can read authorizes nothing.
  writeFileSync(path.join(markFolder(), `driver.${session}.json`), 'not json');
  assert.match(check(MERGE, { cwd: r.dir, env: {}, input: { session_id: session }, viewPr: viewer, home, trustForge: guardForge(r.text, trailOf(r.text)) }) ?? '', /cannot be read/u);
});

test('many planted record files, or too many bytes of them, refuse an unattended merge inside the hook`s time', (t) => {
  const r = repo(t);
  r.record(forged());
  const folder = path.dirname(recordFile(r.project, 7, 'acme/notes'));
  const body = JSON.stringify({ ...emptyState(7, 'acme/notes'), pad: 'x'.repeat(200_000) });
  for (let i = 0; i < 20; i += 1) writeFileSync(path.join(folder, `pr-7-review-o${i}--n.json`), body);
  const started = Date.now();
  assert.match(merge(r, MERGE) ?? '', /more than 8 review record files of #7/u);
  assert.ok(Date.now() - started < 3000, 'well inside the hook`s time');
  for (let i = 0; i < 20; i += 1) rmSync(path.join(folder, `pr-7-review-o${i}--n.json`));
  for (let i = 0; i < 5; i += 1) {
    const file = path.join(folder, `pr-7-review-b${i}--n.json`);
    writeFileSync(file, '');
    truncateSync(file, 2 * 1024 * 1024 - 1);
  }
  assert.match(merge(r, MERGE) ?? '', /hold more than 8388608 bytes/u);
  assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, sha: HEAD }) ?? '', /hold more than/u);
});

test('a records folder a confined session filled with planted entries refuses an unattended merge inside the hook`s time', (t) => {
  const r = repo(t);
  r.record(forged());
  const folder = path.dirname(recordFile(r.project, 7, 'acme/notes'));
  // Entries of another number: no record file of #7 among them, so only the listing itself could stall the guard.
  for (let i = 0; i <= RECORD_LIST_CAP; i += 1) writeFileSync(path.join(folder, `pr-9${i}-x.json`), '');
  const started = Date.now();
  assert.match(merge(r, MERGE) ?? '', new RegExp(`holds more than ${RECORD_LIST_CAP} entries`, 'u'));
  assert.match(mcp(r, { owner: 'acme', repo: 'notes', pullNumber: 7, sha: HEAD }) ?? '', /holds more than/u);
  assert.ok(Date.now() - started < 2500, `inside the agent gate hook's budget: ${Date.now() - started} ms`);
  // Past the hook's deadline, the walk stops and refuses too.
  assert.match(recordProblem(r.project, 7, { pastDeadline: () => true }) ?? '', /could not be listed in time/u);
  assert.ok(RECORD_LIST_CAP >= 10_000, 'far above what a project`s records take');
});

test('a records folder that cannot be opened, or whose listing fails partway, refuses an unattended merge', (t) => {
  const r = repo(t);
  r.record(forged());
  const folder = path.dirname(recordFile(r.project, 7, 'acme/notes'));
  const failing = (code, after = 0) => () => {
    if (after < 0) throw Object.assign(new Error(code), { code });
    let read = 0;
    return { readSync: () => {
      if (read >= after) throw Object.assign(new Error(code), { code });
      read += 1;
      return { name: `pr-7-review-x${read}--y.json` };
    }, closeSync() {} };
  };
  assert.match(recordNames(folder, 7, { opendir: failing('EACCES', -1) }).problem, /cannot be listed \(EACCES\)/u);
  assert.deepEqual(recordNames(folder, 7, { opendir: failing('ENOENT', -1) }), { names: [] }, 'a folder that is not there holds none');
  const partway = recordNames(folder, 7, { opendir: failing('EIO', 3) });
  assert.match(partway.problem, /failed partway \(EIO\)/u);
  assert.equal(partway.names.length, 3);
  // Through the guard: a folder it cannot open refuses the merge.
  chmodSync(folder, 0o000);
  try {
    assert.match(merge(r, MERGE) ?? '', /cannot be listed/u);
  } finally {
    chmodSync(folder, 0o700);
  }
});

test('a merge mutation is read in every `gh api` call, whatever the endpoint`s spelling', (t) => {
  const r = repo(t);
  for (const mutation of MERGE_MUTATIONS) {
    const field = `-f query='mutation { ${mutation}(input: { pullRequestId: "PR_x" }) { clientMutationId } }'`;
    for (const endpoint of ['graphql', '/graphql', 'graphql/', 'https://api.github.com/graphql', "'graphql?x=1'", 'repos/acme/notes']) {
      const command = `gh api -X POST ${endpoint} ${field}`;
      assert.match(merge(r, command) ?? '', /GraphQL call/u, command);
      assert.equal(merge(r, command, { mark: null }), null, `attended: ${command}`);
    }
  }
  const query = path.join(r.root, 'm.graphql');
  writeFileSync(query, 'mutation { enqueuePullRequest(input: { pullRequestId: "PR_x" }) { clientMutationId } }');
  for (const endpoint of ['/graphql', 'https://api.github.com/graphql/', '"$EP"']) {
    assert.match(merge(r, `gh api ${endpoint} -F query=@${query}`) ?? '', /GraphQL call/u, `a query file at ${endpoint}`);
    assert.match(merge(r, `gh api ${endpoint} -f query="$Q"`) ?? '', /GraphQL call/u, `a dynamic query at ${endpoint}`);
  }
  assert.equal(endpointOf('https://ghe.example.com/api/graphql?x=1'), 'graphql');
  assert.equal(endpointOf('/repos/acme/notes/pulls/7/'), 'repos/acme/notes/pulls/7');
});

test('a review or comment list the forge cut short refuses an unattended merge', (t) => {
  const r = repo(t);
  r.record(forged());
  assert.match(merge(r, MERGE, { trail: trailOf(r.text, { commentsComplete: false }) }) ?? '', /gave only part of its comments/u);
  assert.match(merge(r, MERGE, { trail: trailOf(r.text, { reviewsComplete: false }) }) ?? '', /gave only part of its reviews/u);
});

test('an in-process sign-off is refused to a session with an unattended mark or a driver mark', async (t) => {
  const r = repo(t, configOf({ review: { flows: { payments: PAYMENTS }, record: 'local' } }));
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.record((state) => {
    state.signoffable = { head: r.commit, flows: ['payments'] };
  });
  const forge = { change: () => ({ url: 'https://github.com/acme/notes/pull/7', baseRefName: 'main' }), reviewTrail: () => { throw new Error('offline'); } };
  const sign = (session, extra = []) => runSignoff(['7', '--flow', 'payments', '--head', r.commit, '--repo', 'acme/notes', ...extra], r.project, loadConfig(r.project).config, { forge, session });
  const marked = 'abcd1234-0000-4000-8000-00000000e0e0';
  const driver = 'abcd1234-0000-4000-8000-00000000e0e1';
  markUnattended(marked, { root: r.dir });
  markDriver(driver, { run: 'launch', root: r.dir, state: r.root });
  t.after(() => ['', 'driver.'].forEach((prefix) => [marked, driver].forEach((id) => rmSync(path.join(markFolder(), `${prefix}${id}.json`), { force: true }))));
  for (const session of [marked, driver]) await assert.rejects(sign(session), /this session has no Human at hand .* or drives a project run/u, session);
  const quiet = console.log;
  console.log = () => {};
  t.after(() => (console.log = quiet));
  await sign(marked, ['--check']);
  assert.deepEqual(readHumanSignoffs({ repo: 'acme/notes', pr: 7 }).flows, {}, 'the dry run records nothing');
  await sign('abcd1234-0000-4000-8000-00000000e0e2');
  assert.equal(readHumanSignoffs({ repo: 'acme/notes', pr: 7 }).flows.payments.head, r.commit, 'a session the Human attends');
});

// The closing-word rule at merge time (lib/closing-words.mjs, merge-review.mjs mergeClosesProblem): a merge no Human asks
// for, of a project run's issue's pull request, closes or links no other issue of a team the run knows, whatever its
// title, body, and commits say on the forge then, and whatever subject and body the merge itself gives.
function closingRun(t, { teams } = {}) {
  const fx = runFixture(t, { local: { handoff: { background: 'on' }, github: { autoMerge: 'on' } }, init: teams === undefined });
  if (teams !== undefined) {
    // The driver's snapshot names every team of the tracker workspace.
    const file = path.join(fx.dir, 'snapshot.json.input');
    writeFileSync(file, JSON.stringify({ issues: ISSUES, teams }));
    const started = initRun({ project: fx.project, config: fx.config, run: 'launch', file, session: DRIVER, env: fx.env, home: fx.home });
    assert.equal(started.exitCode, 0, started.err.join('\n'));
  }
  t.after(() => rmSync(signoffFolder(), { recursive: true, force: true }));
  const record = emptyState(7, 'acme/widgets');
  record.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' };
  writeLocalState(fx.project, record);
  const text = JSON.stringify({ ...fx.committed, github: { ...CHECKS, autoMerge: TEAM } });
  const run = (command, { mark = { root: fx.dir, project: 'launch', issue: 'ENG-1' }, over = {} } = {}) =>
    check(command, { cwd: fx.dir, env: {}, input: { session_id: 'issue-1' }, viewPr: viewer, unattendedMark: () => mark, trustForge: guardForge(text, trailOf(text, over)) });
  const mcpRun = (toolInput, { mark = { root: fx.dir, project: 'launch', issue: 'ENG-1' }, over = {} } = {}) =>
    checkMcp(toolInput, { cwd: fx.dir, input: { session_id: 'issue-1' }, viewPr: viewer, unattendedMark: () => mark, trustForge: guardForge(text, trailOf(text, over)) });
  return { fx, run, mcpRun };
}

test('the merge guard refuses a run issue\'s merge whose body, title, commits, or merge text close or name another issue, read at merge time', (t) => {
  const { run, mcpRun } = closingRun(t);
  assert.equal(run(MERGE), null, 'its own issue only');
  for (const [over, why] of [
    [{ body: 'Fixes ENG-1, ENG-2' }, /its body says "Fixes ENG-2", so its merge would close an issue other than its own issue ENG-1/u],
    [{ title: 'feat: export for ENG-4' }, /its title names "ENG-4"/u],
    [{ messages: [{ oid: HEAD, message: 'Closes ENG-2' }] }, /commit abcdef1 says "Closes ENG-2"/u],
    [{ messagesComplete: false }, /the forge did not give its title and every commit message/u],
  ]) assert.match(run(MERGE, { over }) ?? '', why, JSON.stringify(over));
  // The body edited after a passing auto-merge: the guard reads the forge again at the merge.
  assert.equal(run(MERGE, { over: { body: 'Fixes ENG-1' } }), null);
  assert.match(run(MERGE, { over: { body: 'Fixes ENG-1\nFixes ENG-4' } }) ?? '', /"Fixes ENG-4"/u);
  // The merge's own commit subject and body, and text the guard cannot read.
  assert.match(run(`gh pr merge 7 -t 'Closes ENG-2' --match-head-commit ${HEAD}`) ?? '', /the merge commit's subject says "Closes ENG-2"/u);
  assert.match(run(`gh pr merge 7 -b 'resolves ENG-4' --match-head-commit ${HEAD}`) ?? '', /the merge commit's body says "resolves ENG-4"/u);
  assert.match(run(`gh pr merge 7 -F body.md --match-head-commit ${HEAD}`) ?? '', /comes from a file or a variable the guard cannot read/u);
  assert.match(mcpRun({ owner: 'acme', repo: 'widgets', pullNumber: 7, sha: HEAD, commit_message: 'Fixes ENG-2' }) ?? '', /the merge commit's body says "Fixes ENG-2"/u);
  assert.equal(mcpRun({ owner: 'acme', repo: 'widgets', pullNumber: 7, sha: HEAD, commit_message: 'Fixes ENG-1' }), null);
});

test('the merge guard holds the run\'s driver, whose mark names no issue, to the issue whose branch the pull request is from; an attended merge reads none of it', (t) => {
  const { fx, run } = closingRun(t);
  const driver = { root: fx.dir, cwd: null };
  assert.equal(run(MERGE, { mark: driver }), null);
  assert.match(run(MERGE, { mark: driver, over: { body: 'Fixes ENG-1 and ENG-4' } }) ?? '', /"Fixes ENG-4", so its merge would close an issue other than its own issue ENG-1/u);
  assert.equal(run(MERGE, { mark: driver, over: { headRef: 'feat/not-a-run-issue', body: 'Fixes ENG-4' } }), null, 'a pull request of no run issue is not held');
  // A mark whose tags name an issue it cannot read names none: any reference refuses.
  assert.match(run(MERGE, { mark: { root: fx.dir, project: null, issue: null } }) ?? '', /mark names none it can read/u);
  const attended = check(`gh pr merge 7 -t 'Closes ENG-2' --match-head-commit ${HEAD}`, { cwd: fx.dir, env: {}, input: {}, viewPr: viewer, unattendedMark: () => null, trustForge: () => assert.fail('an attended merge asks the forge nothing') });
  assert.equal(attended, null);
});

test('a missing sign-off of a security flow is a security decision: a flow whose id holds security, or whose require names security-engineer', (t) => {
  for (const [flows, id] of [
    [{ 'payments-security': PAYMENTS }, 'payments-security'],
    [{ payments: { ...PAYMENTS, require: ['agent:security-engineer'] } }, 'payments'],
  ]) {
    const r = repo(t, configOf({ review: { flows } }));
    r.record((state) => (state.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' }));
    const off = autoMerge(t, r, { files: ['src/pay/charge.js'], trail: trailOf(r.text, changing('src/pay/charge.js')) });
    assert.deepEqual([off.result.trust, off.result.flow, off.result.signoffClass], ['signoff', id, 'security'], id);
  }
});

test('a run whose snapshot names the workspace\'s teams refuses a key of a team outside the run, in a body, a title, and a merge body', (t) => {
  const { run } = closingRun(t, { teams: ['ENG', 'OPS', 'SEC'] });
  assert.match(run(MERGE, { over: { body: 'Fixes ENG-1, OPS-5' } }) ?? '', /its body says "Fixes OPS-5"/u);
  assert.match(run(MERGE, { over: { title: 'feat: export for SEC-2' } }) ?? '', /its title names "SEC-2"/u);
  assert.match(run(`gh pr merge 7 -b 'Closes OPS-5' --match-head-commit ${HEAD}`) ?? '', /the merge commit's body says "Closes OPS-5"/u);
  // No team is named UTF or SHA: those tokens are still no keys.
  assert.equal(run(MERGE, { over: { title: 'fix: utf-8 BOM', messages: [{ oid: HEAD, message: 'Fixed SHA-256 check' }] } }), null);
  // With no teams in the snapshot, only the run's own teams are known, the residual docs/config.md names.
  const { run: plain } = closingRun(t);
  assert.equal(plain(MERGE, { over: { body: 'Fixes ENG-1, OPS-5' } }), null);
});

test('a missing sign-off is a security decision when any unsigned flow is a security one, even when the first is not', (t) => {
  const r = repo(t, configOf({ review: { flows: { payments: PAYMENTS, 'zz-security': { ...PAYMENTS } } } }));
  r.record((state) => (state.outcome = { status: 'received', head: HEAD, at: '2026-11-18T09:00:00.000Z' }));
  const off = autoMerge(t, r, { files: ['src/pay/charge.js'], trail: trailOf(r.text, changing('src/pay/charge.js')) });
  assert.deepEqual([off.result.trust, off.result.flow, off.result.signoffClass], ['signoff', 'payments', 'security']);
});

// A record stopped at the round cap on HEAD with nothing but findings behind it, naming no flow for the Human, and a
// judge's waive there.
const waivedCap = (state) => {
  state.outcome = {
    status: 'round_limit', head: HEAD, at: '2026-11-18T09:00:00.000Z',
    cap: { head: HEAD, reviewed: HEAD, items: [], counted: 0, itemized: true, unrun: [], unsigned: [], flows: [], tests_removed: [], checks_failing: 0, bot: false, human: [] },
  };
  state.signoffable = { head: HEAD, flows: [] };
  state.waivers = [{ head: HEAD, kind: 'round_cap', verdict: 'waive', reason: 'nits', judge: 'unknown', at: '2026-11-18T09:30:00.000Z' }];
};

test('a session no Human attends merging on a judge`s verdict at the round cap: the guard reads the review trail once, and still asks merge trust', (t) => {
  const config = configOf({ github: { ...CHECKS, autoMerge: TEAM, unattendedWaiver: { allow: true } } });
  const r = repo(t, config);
  // The machine opts in to the waiver beside auto-merge, which repo() turned on.
  const local = path.join(r.dir, '.aidrian.local.json');
  writeFileSync(local, JSON.stringify({ github: { ...JSON.parse(readFileSync(local, 'utf8')).github, unattendedWaiver: 'on' } }));
  r.record(waivedCap);
  const text = JSON.stringify(config);
  const run = (trail, { url = 'https://github.com/acme/notes/pull/7', mark = { root: r.dir } } = {}) => {
    const calls = [];
    const forge = () => ({ ...guardForge(text, trail, calls)(), change: (ref) => (calls.push(['change', ref]), { number: 7, headRefOid: HEAD, baseRefName: 'main', url }) });
    const reason = check(MERGE, { cwd: r.dir, env: {}, input: { session_id: 'unattended-1' }, viewPr: viewer, unattendedMark: () => mark, waiverForge: forge, trustForge: forge });
    return { reason, trails: calls.filter(([name]) => name === 'reviewTrail').length, rest: calls.filter(([name]) => name === 'repository' || name === 'contents').length, calls };
  };
  const { calls: _calls, ...once } = run(trailOf(text));
  assert.deepEqual(once, { reason: null, trails: 1, rest: 0 }, 'the waiver`s trail serves merge trust, and no policy is read over REST');
  // Merge trust still holds the waived merge: a draft is refused on the same trail.
  const draft = run(trailOf(text, { draft: true }));
  assert.match(draft.reason ?? '', /^Blocked: no Human attends this session, .* it is a draft/u);
  assert.equal(draft.trails, 1);
  // With no bot pass, the verdict does not stand, and the guard's own denial names why.
  assert.match(run(noBot(r)).reason ?? '', /is `round_limit`.*A judge's verdict cannot stand for this head: it never stands in for the review bot/su);
  // The waiver's view names another repository than the one this session is pinned to: merge trust does not take the
  // waiver's trail, and reads its own of the pinned repository.
  const other = run(trailOf(text), { url: 'https://github.com/other/fork/pull/7' });
  assert.deepEqual(other.calls.filter(([name]) => name === 'reviewTrail').map((call) => call[1]), ['other/fork', 'acme/notes']);
  // A session of a project run is held to the run's budget of waived merges in the guard too: a run whose ledger cannot
  // be read counts nothing, and the verdict does not stand.
  assert.match(run(trailOf(text), { mark: { root: r.dir, project: 'gone', issue: 'WID-1' } }).reason ?? '', /A judge's verdict cannot stand for this head: the ledger of project run gone cannot be read/u);
});
