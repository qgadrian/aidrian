import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliCompressSync } from 'node:zlib';

import { DEFAULTS, loadConfig, resolveUnattendedWaiver } from '../plugins/aidrian/lib/config.mjs';
import { machineSwitchWriteDenial } from '../plugins/aidrian/lib/config-guard.mjs';
import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { findProject, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { baseProblem } from '../plugins/aidrian/lib/review/in-force.mjs';
import { adoptedCopy, emptyState, owed, readLocalState, refreshSummary, stateFromComment, summaryBody, WAIVER_HEADING, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { capProblem, guardWaiver, MAX_REASON, parseWaive, runWaive, takeWaivedMerge, verdictNext, WAIVER_DEADLINE_MS, waiverFor, waiverKind } from '../plugins/aidrian/lib/review/waiver.mjs';
import { budgetProblem, judgeProblem, offerWaiver, readGate, runOf, WAIVED_MERGES } from '../plugins/aidrian/lib/review/waiver-stand.mjs';
import { atCap, offerLand, runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
import { postedCopy } from '../plugins/aidrian/lib/review/publish.mjs';
import { logPath } from '../plugins/aidrian/lib/dispatch-log.mjs';
import { appendToRun } from '../plugins/aidrian/lib/project-run.mjs';
import { runFixture } from './project-start-fixture.mjs';
import { check, checkMcp, UNREAD_REASON } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

import { hookCall } from './hook-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATES_HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-agent-gates.mjs');
const LOCAL = '.aidrian.local.json';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
// Today's denial ends at the Human's own shell, with the one merge command to hand over (#390).
const SHELL_TAIL = /Or the Human merges in their own shell \(`!` in the prompt\): .*; hand over `gh pr merge 5 --match-head-commit [0-9a-f]{40}`, with the team's merge-strategy flag, for the Human to run\.$/u;
const NEXT = '1234567890abcdef1234567890abcdef12345678';
const URL = 'https://github.com/Acme/Notes/pull/5';
const T0 = '2026-11-03T14:00:00.000Z';
// The default branch's config on the forge: the working copy's state folder, and the waiver allowed.
const ALLOW = { version: 1, state: { dir: '../state' }, github: { unattendedWaiver: { allow: true } } };
const REFUSE = { version: 1, state: { dir: '../state' } };

// A git repository of its own (never GIT_DIR, never a real repository) with an origin and one commit, holding a project
// whose state folder is inside it, a transcript file, and an untracked local file when `local` is given. It also holds
// three commits no ref names: `A`, `B` a child of A, and `C` a sibling of A, so a head the review did not cover can
// descend from the reviewed one or not: neither is waived.
function repo(t, { config = {}, local = null } = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-waiver-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, ...config }));
  git('add', '.');
  git(...id, 'commit', '-qm', 'init');
  const tree = git('rev-parse', 'HEAD^{tree}');
  const child = (parent, message) => git(...id, 'commit-tree', tree, '-p', parent, '-m', message);
  const A = child('HEAD', 'reviewed');
  const B = child(A, 'pushed after the review');
  const C = child('HEAD', 'force-pushed in its place');
  if (local) writeFileSync(path.join(dir, LOCAL), JSON.stringify(local));
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  // The judge every verdict below names (waiver()), dispatched between the cap (T0) and the verdict, in the dispatch log.
  const log = logPath(projectAt(dir), loadConfig(projectAt(dir)).config);
  mkdirSync(path.dirname(log), { recursive: true });
  writeFileSync(log, `${JSON.stringify(JUDGE_ROW)}\n`);
  const record = (pr, edit) => {
    const state = emptyState(pr, 'acme/notes');
    edit(state);
    writeLocalState(projectAt(dir), state);
  };
  return { dir, git, transcript, record, project: () => projectAt(dir), A, B, C };
}

const ON = { github: { unattendedWaiver: { enabled: true } } };
const encode = (value) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

// The review bot's status card on `sha`, as the forge's review trail gives a comment: the default reviewer's, every edit
// its own, saying its review of that commit completed and found nothing.
const BOT = 'chatgpt-codex-connector';
const card = (sha = HEAD) => ({
  id: 9, login: BOT, bot: true, association: 'NONE', at: '2026-11-03T14:30:00Z', editors: [BOT], editsComplete: true,
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_any_findings: false, has_unresolved_findings: false, status: 'completed' } })} -->`,
});

// The waiver's forge seam, budgetedForge's `make`: the pull request is on `base` at `head`, the default branch is `main`,
// and `branches` maps a branch to its config.json. The review trail gives both branches' config.json and, with `bot`,
// the review bot's card passing `head` (or the commit `bot` names); `rest: true` leaves the base out of it, so the policies are read over REST.
// Every call is counted with the options it was built with, so a test can say none was made, or what each was bounded
// at. `tick` is how long each call takes on a test clock.
function teamForge(branches = { main: ALLOW }, { base = 'main', head = HEAD, view = {}, clock = null, tick = 0, bot = true, rest = false } = {}) {
  const calls = [];
  const options = [];
  const step = () => clock && (clock.now += tick);
  const text = (branch) => (Object.hasOwn(branches, branch) ? JSON.stringify(branches[branch]) : null);
  const facade = {
    change: (ref, fields, given) => (calls.push(['change', ref, fields, given?.repo ?? null]), step(), { number: Number(ref), headRefOid: head, baseRefName: base, url: URL, ...view }),
    reviewTrail: (name, n, given) => {
      calls.push(['reviewTrail', name, n, given?.host, given?.paths]);
      step();
      return {
        head, base, files: [{ path: 'src/app.js', changeType: 'MODIFIED' }], filesTotal: 1, filesComplete: true, reviews: [], reviewsComplete: true, comments: bot === false ? [] : [card(bot === true ? head : bot)], commentsComplete: true,
        branches: { default: { name: 'main', pointer: null, config: text('main'), knowledge: null }, base: rest ? null : { name: base, pointer: null, config: text(base) } },
      };
    },
    repository: (name, given) => (calls.push(['repository', name, given?.host]), step(), { default_branch: 'main' }),
    contents: (name, file, ref, given) => {
      calls.push(['contents', name, file, ref, given?.host]);
      step();
      const branch = ref.replace(/^refs\/heads\//u, '');
      if (file === '.aidrian/config.json' && Object.hasOwn(branches, branch)) return encode(branches[branch]);
      throw Object.assign(new Error('gh: Not Found (HTTP 404)'), { stderr: 'gh: Not Found (HTTP 404)' });
    },
  };
  const make = (given) => (options.push(given), facade);
  return Object.assign(make, { calls, options });
}

// The guard's own view, made only for a merge that names no head: `head` null is a gh that does not answer.
const viewer = (views, { head = HEAD, base = 'main' } = {}) => (target, where) => {
  views.push([target, where]);
  return head === null ? null : { number: Number(target ?? 5), headRefOid: head, baseRefName: base, url: URL };
};

const merge = (r, command, { forge = teamForge(), head = HEAD, base = 'main', views = [], startedAt = Date.now(), now = Date.now } = {}) =>
  check(command, { cwd: r.dir, env: {}, input: { transcript_path: r.transcript }, viewPr: viewer(views, { head, base }), waiverForge: forge, startedAt, now });

// What stopped a review at the round cap on `head`, as the review step keeps it (review/run.mjs capCause): by default
// nothing but findings, here none, so a verdict may stand.
const cause = (head = HEAD, extra = {}) => ({ head, reviewed: head, items: [], counted: 0, itemized: true, unrun: [], unsigned: [], flows: [], tests_removed: [], checks_failing: 0, bot: false, human: [], ...extra });
const roundLimit = (state, head = HEAD, extra = {}) => {
  state.outcome = { status: 'round_limit', head, at: T0, cap: cause(head, extra) };
  state.signoffable = { head, flows: [] };
};
const received = (state, head = HEAD) => (state.outcome = { status: 'received', head, at: T0 });
// A judge's verdict as `aidrian pr waive --judge` records it, naming the judge and the recording session; `judged: false`
// drops both, as a verdict recorded with no --judge holds.
const JUDGE = { judge_id: 'judge-1', session: 'sess-judge' };
const JUDGE_ROW = { event: 'dispatch', ts: '2026-11-03T14:30:00.000Z', session_id: JUDGE.session, dispatcher: 'main', agent_id: JUDGE.judge_id, agent_type: 'aidrian:code-reviewer' };
const waiver = (state, { head = HEAD, kind = 'round_cap', verdict = 'waive', at = '2026-11-03T15:00:00.000Z', reason = 'every open finding is a nit', judged = true } = {}) =>
  (state.waivers = [...(state.waivers ?? []), { head, kind, verdict, reason, judge: 'code-reviewer', ...(judged ? JUDGE : {}), at }]);

// ---- config (AC5, AC6)

test('github.unattendedWaiver: allow defaults to false, takes only a boolean, and no other key', (t) => {
  assert.deepEqual(DEFAULTS.github.unattendedWaiver, { allow: false });
  for (const [given, pattern, allow] of [[{ allow: 'yes' }, /unattendedWaiver\.allow/u, false], [{ allow: true, default: 'on' }, /unattendedWaiver\.default/u, true]]) {
    const r = repo(t, { config: { github: { unattendedWaiver: given } } });
    const { config, errors } = loadConfig(findProject(r.dir));
    assert.ok(errors.some((error) => pattern.test(error)), JSON.stringify(errors));
    assert.equal(config.github.unattendedWaiver.allow, allow, 'a wrong value keeps the default; a stray key is only an error');
  }
  const r = repo(t, { config: { github: { unattendedWaiver: { allow: true } } } });
  assert.deepEqual(loadConfig(findProject(r.dir)).errors, []);
});

test('resolveUnattendedWaiver: on only when the team allows it and the machine switch is on', () => {
  const allowed = { unattendedWaiver: { allow: true } };
  assert.deepEqual(resolveUnattendedWaiver({ unattendedWaiver: { allow: false } }, 'on'), { effective: false, reason: 'team' });
  assert.deepEqual(resolveUnattendedWaiver({}, 'on'), { effective: false, reason: 'team' }, 'no key is the default, false');
  assert.deepEqual(resolveUnattendedWaiver(allowed, 'off'), { effective: false, reason: 'local' });
  assert.deepEqual(resolveUnattendedWaiver(allowed, 'unset'), { effective: false, reason: 'local' }, 'no team default: unset is off');
  assert.deepEqual(resolveUnattendedWaiver(allowed, 'on'), { effective: true, reason: null });
});

test('the local switch reads both shapes, unset when absent, and off with one error for a wrong value', (t) => {
  const r = repo(t);
  const local = path.join(r.dir, LOCAL);
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'unset', 'no local file');
  writeFileSync(local, JSON.stringify({ names: { human: 'the owner' } }));
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'unset', 'a local file without github');
  for (const [given, value] of [['on', 'on'], ['off', 'off'], [{ enabled: true }, 'on'], [{ enabled: false }, 'off']]) {
    writeFileSync(local, JSON.stringify({ github: { unattendedWaiver: given } }));
    const project = findProject(r.dir);
    assert.deepEqual([project.errors, project.localUnattendedWaiver, project.localAutoMerge], [[], value, 'unset'], JSON.stringify(given));
  }
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'on', unattendedWaiver: 'on' } }));
  assert.deepEqual([findProject(r.dir).localAutoMerge, findProject(r.dir).localUnattendedWaiver], ['on', 'on'], 'both machine settings together');
  for (const wrong of [{ enabled: 'yes' }, { allow: true }, {}, true, 'unset', null]) {
    writeFileSync(local, JSON.stringify({ github: { unattendedWaiver: wrong } }));
    const project = findProject(r.dir);
    assert.equal(project.localUnattendedWaiver, 'off', JSON.stringify(wrong));
    assert.deepEqual(project.errors, [`${LOCAL}: "github.unattendedWaiver" must be { "enabled": true } or { "enabled": false }`], JSON.stringify(wrong));
  }
  // One wrong value turns both switches off, and its error prints once.
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'yes', unattendedWaiver: 'on' } }));
  const broken = findProject(r.dir);
  assert.deepEqual([broken.localAutoMerge, broken.localUnattendedWaiver], ['off', 'off']);
  assert.deepEqual(broken.errors, [`${LOCAL}: "github.autoMerge" must be { "enabled": true } or { "enabled": false }`]);
  // A key the team sets is ignored with a warning, and the switches the file sets hold.
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'on', unattendedWaiver: 'on', strategy: 'squash' } }));
  const team = findProject(r.dir);
  assert.deepEqual([team.localAutoMerge, team.localUnattendedWaiver, team.errors], ['on', 'on', []]);
  assert.deepEqual(team.warnings, [`${LOCAL}: unknown key "github.strategy"; only "github.autoMerge" and "github.unattendedWaiver" are machine settings`]);
  writeFileSync(local, '{ not json');
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'off', 'unparsable');
});

test('an error anywhere in the local file reads the waiver "off" though it says "on", in the main checkout and from a worktree', (t) => {
  const r = repo(t);
  writeFileSync(path.join(r.dir, '.gitignore'), `${LOCAL}\nwt/\n`);
  const local = path.join(r.dir, LOCAL);
  const stray = (waiver) => JSON.stringify({ reviewApprovals: 'maybe', github: { unattendedWaiver: waiver } });
  writeFileSync(local, stray('on'));
  const main = findProject(r.dir);
  assert.deepEqual([main.localUnattendedWaiver, main.errors], ['off', [`${LOCAL}: "reviewApprovals" must be "on" or "off"`]], 'the main checkout\'s own file');
  writeFileSync(local, JSON.stringify({ stray: 1, github: { unattendedWaiver: 'on' } }));
  const unknown = findProject(r.dir);
  assert.deepEqual([unknown.localUnattendedWaiver, unknown.errors, unknown.warnings], ['on', [], [`${LOCAL}: unknown key "stray"`]], 'an unknown key is no error');
  writeFileSync(local, JSON.stringify({ sources: 'no-list', github: { unattendedWaiver: { enabled: true } } }));
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'off', 'a wrong sources value');

  const worktree = path.join(r.dir, 'wt/task');
  r.git('worktree', 'add', '-q', '-b', 'task', worktree);
  writeFileSync(path.join(worktree, LOCAL), JSON.stringify({ github: { unattendedWaiver: 'on' } }));
  writeFileSync(local, stray('on'));
  assert.equal(findProject(worktree).localUnattendedWaiver, 'off', 'a worktree\'s valid copy hides no error in the main checkout\'s file');
  writeFileSync(local, JSON.stringify({ github: { unattendedWaiver: 'on' } }));
  assert.equal(findProject(worktree).localUnattendedWaiver, 'on', 'a valid main file still turns it on from a worktree');
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'on', 'and in the main checkout');
});

test('a local file git tracks reads the waiver switch "off" with the tracked-file error', (t) => {
  const r = repo(t, { local: ON });
  assert.deepEqual([findProject(r.dir).errors, findProject(r.dir).localUnattendedWaiver], [[], 'on'], 'untracked: the machine\'s own');
  r.git('add', '-f', LOCAL);
  const project = findProject(r.dir);
  assert.equal(project.localUnattendedWaiver, 'off');
  assert.deepEqual(project.errors, [`${LOCAL}: git tracks it, so a branch could carry it; "github.unattendedWaiver" reads "off" until it is untracked (git rm --cached ${LOCAL})`]);
});


// ---- the command (AC7)

// runWaive as the CLI runs it, over a fake forge whose pull request is at `head` and whose comments are `issue`.
// `change` replaces the head read, which runs between the record's read and its write. The base read before it names
// this checkout's own branch, or `base` when given: its config holds the same state.dir.
// `visibility` is what the forge reads the repository as; the pull request comes from inside the team.
function waive(t, r, args, { head = HEAD, change = null, issue = [], record = 'comment', base = r.git('branch', '--show-current'), visibility = 'PRIVATE' } = {}) {
  const log = t.mock.method(console, 'log', () => {});
  const headRead = change ?? ((ref, fields) => (assert.equal(fields, 'number,headRefOid,url'), { number: Number(ref), headRefOid: head, url: URL }));
  const forge = {
    visibility: () => visibility,
    pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }),
    change: (ref, fields) => (fields === 'baseRefName' ? { baseRefName: base } : fields === 'isCrossRepository' ? { isCrossRepository: false } : headRead(ref, fields)),
    conversationComments: () => issue,
    postComment: (_repo, _n, body) => (issue.push({ id: issue.length + 1, user: { login: 'someone' }, author_association: 'MEMBER', body }), issue.at(-1)),
    editComment: (_repo, id, body) => (issue.find((comment) => comment.id === id).body = body),
    viewer: () => 'someone',
  };
  const project = r.project();
  const config = { ...loadConfig(project).config, review: { ...loadConfig(project).config.review, record } };
  return runWaive(['5', ...args], project, config, { forge, repo: 'acme/notes', env: {} }).finally(() => log.mock.restore()).then((code) => ({ code, out: JSON.parse(log.mock.calls.at(-1).arguments[0]), issue }));
}

test('aidrian pr waive records a round_cap verdict on the current head, visible in the summary comment', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const { code, out, issue } = await waive(t, r, ['--verdict', 'waive', '--reason', 'the three open findings are style nits']);
  assert.equal(code, 0);
  assert.equal(out.status, 'recorded');
  assert.deepEqual({ ...out.waiver, at: null }, { head: HEAD, kind: 'round_cap', verdict: 'waive', reason: 'the three open findings are style nits', judge: 'unknown', at: null });
  assert.match(out.next, new RegExp(`gh pr merge 5 --match-head-commit ${HEAD} --repo acme/notes\``, 'u'));
  assert.equal(readLocalState(r.project(), 5).waivers.length, 1);
  assert.equal(issue.length, 1, 'posted the summary comment');
  assert.equal(stateFromComment(issue[0].body, 5).waivers[0].head, HEAD, 'the comment carries the record');
  assert.match(issue[0].body, new RegExp(`${WAIVER_HEADING.replace(/\*/gu, '\\*')}\\n- round_cap on \`abcdef1\`: waive by unknown: the three open findings are style nits \\(an audit entry, not proof\\)`, 'u'));
});

test('aidrian pr waive in a fork checkout reads, records, and prints the one repository the forge names for the pull request', async (t) => {
  // Origin is acme/notes; gh's default, and the pull request, is upstream's up/notes#5.
  const r = repo(t, { local: ON });
  r.git('remote', 'add', 'upstream', 'git@github.com:Up/Notes.git');
  r.git('update-ref', `refs/remotes/upstream/${r.git('branch', '--show-current')}`, 'HEAD');
  const state = emptyState(5, 'up/notes');
  roundLimit(state);
  writeLocalState(r.project(), state, { repo: 'up/notes' });
  const asked = [];
  const forge = {
    change: (ref, fields, given) => {
      asked.push([fields, given?.repo ?? null]);
      if (fields === 'url') return { url: 'https://github.com/Up/Notes/pull/5' };
      if (fields === 'baseRefName') return { baseRefName: r.git('branch', '--show-current') };
      return { number: 5, headRefOid: HEAD, url: 'https://github.com/Up/Notes/pull/5' };
    },
    conversationComments: () => [],
  };
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  const project = r.project();
  const config = loadConfig(project).config;
  const code = await runWaive(['5', '--verdict', 'refuse', '--reason', 'R2-1 is a real fix_now'], project, { ...config, review: { ...config.review, record: 'local' } }, { forge, env: {} }).finally(() => t.mock.restoreAll());
  assert.equal(code, 0);
  assert.deepEqual(asked[0], ['url', null], 'the repository is resolved once, from the forge');
  assert.deepEqual(asked.slice(1, 3), [['baseRefName', 'up/notes'], ['number,headRefOid,url', 'up/notes']]);
  assert.ok(asked.slice(1).every(([, named]) => named === 'up/notes'), 'every later read names it');
  assert.equal(readLocalState(project, 5, 'up/notes').waivers.length, 1, 'the verdict is in up/notes\'s record');
  assert.equal(readLocalState(project, 5, 'acme/notes'), null, 'origin\'s holds none');
  // A waive's merge names that same repository.
  const named = verdictNext({ verdict: 'waive', head: HEAD }, 5, LOCAL, 'up/notes');
  assert.match(named, new RegExp(`gh pr merge 5 --match-head-commit ${HEAD} --repo up/notes\``, 'u'));
});

test('a verdict whose pull request the forge cannot look up exits 3 with nothing written: aidrian pr waive and aidrian pr extend --judge alike', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  const before = JSON.stringify(readLocalState(r.project(), 5));
  // gh cannot read the pull request: origin is never taken in its place.
  const forge = { change: () => { throw new Error('gh: HTTP 502'); }, conversationComments: () => [] };
  const err = [];
  t.mock.method(console, 'error', (line) => err.push(line));
  t.mock.method(console, 'log', () => {});
  const project = r.project();
  const config = loadConfig(project).config;
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: JUDGE.session };
  try {
    assert.equal(await runWaive(['5', '--verdict', 'refuse', '--reason', 'nits', '--judge', JUDGE.judge_id], project, config, { forge, env }), 3);
    assert.equal(await runExtend(['5', '--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id], project, config, { forge, env, gate: { run: () => undefined, runHost: CONFIRMS } }), 3);
    assert.equal(await runExtend(['5', '--verdict', 'stop', '--reason', 'nits', '--judge', JUDGE.judge_id], project, config, { forge, env }), 3);
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(err.map((line) => line.split(':')[0]), ['aidrian pr waive', 'aidrian pr extend', 'aidrian pr extend']);
  assert.ok(err.every((line) => /cannot read pull request #5 on the forge, so its repository cannot be told: nothing is recorded/u.test(line)), err.join('\n'));
  assert.equal(JSON.stringify(readLocalState(r.project(), 5)), before, 'nothing written');
});

test('a verdict takes the pull request number alone: a URL is a usage error, exit 2, with nothing written', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  const before = JSON.stringify(readLocalState(r.project(), 5));
  const read = [];
  const forge = { change: (...args) => (read.push(args), { number: 5, headRefOid: HEAD, baseRefName: 'main', url: URL }), conversationComments: () => [] };
  const err = [];
  t.mock.method(console, 'error', (line) => err.push(line));
  t.mock.method(console, 'log', () => {});
  const project = r.project();
  const config = loadConfig(project).config;
  try {
    assert.equal(await runWaive([URL, '--verdict', 'refuse', '--reason', 'nits', '--judge', JUDGE.judge_id], project, config, { forge, env: {} }), 2);
    assert.equal(await runExtend([URL, '--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id], project, config, { forge, env: {} }), 2);
  } finally {
    t.mock.restoreAll();
  }
  assert.equal(err[0], 'aidrian pr waive: a verdict takes the pull request\'s number, not a URL; `aidrian pr waive <n>` reads the number in gh\'s default repository; for another repository, a dispatched judge\'s verdict is recorded with `aidrian pr extend <n> --verdict land|stop --reason "<evidence>" --head <sha> --judge <agent id> --repo OWNER/NAME`.');
  assert.match(err[1], /^aidrian pr extend: a verdict with --judge takes the pull request's number, not a URL: give 5, with --repo OWNER\/NAME/u);
  assert.deepEqual(read, [], 'nothing is read');
  assert.equal(JSON.stringify(readLocalState(r.project(), 5)), before, 'nothing written');
});

test('aidrian pr waive on a repository that is not private posts the waiver line and the record with no reason', async (t) => {
  for (const visibility of ['PUBLIC', 'INTERNAL', null]) {
    const r = repo(t, { local: ON });
    r.record(5, roundLimit);
    const { code, issue } = await waive(t, r, ['--verdict', 'waive', '--reason', 'the three open findings are style nits'], { visibility });
    assert.equal(code, 0);
    assert.equal(readLocalState(r.project(), 5).waivers[0].reason, 'the three open findings are style nits', `${visibility}: the local record keeps the reason`);
    assert.doesNotMatch(issue[0].body, /style nits/u, `${visibility}: the line names no reason`);
    assert.equal(stateFromComment(issue[0].body, 5).waivers[0].reason, undefined, `${visibility}: the posted record holds none`);
    // A judge's name is posted only where the plan or the config defines it, and this record holds no plan note.
    assert.match(issue[0].body, /- round_cap on `abcdef1`: waive by a judge \(an audit entry, not proof\)/u, `${visibility}: the line keeps the kind, head, and verdict`);
  }
});

test('aidrian pr waive refuses a failed head read after the base read, and a base it cannot read', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  await assert.rejects(waive(t, r, ['--verdict', 'refuse', '--reason', 'nits'], { change: () => { throw new Error('HTTP 502'); } }), /cannot read the pull request's head/u);
  await assert.rejects(waive(t, r, ['--verdict', 'refuse', '--reason', 'nits'], { base: null }), /cannot read the pull request's base branch/u);
  assert.equal(readLocalState(r.project(), 5).waivers, undefined);
});

test('a second verdict rewrites the waiver list in the summary comment, not a second one', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const issue = [{ id: 1, user: { login: 'someone' }, author_association: 'MEMBER', body: summaryBody(readLocalState(r.project(), 5), null, 'round_limit', { reading: { visibility: 'PRIVATE', inside: true } }) }];
  for (const verdict of ['refuse', 'waive']) assert.equal((await waive(t, r, ['--verdict', verdict, '--reason', `judged ${verdict}`], { issue })).code, 0);
  assert.equal(issue.length, 1, 'edited, not posted');
  assert.equal(issue[0].body.split(WAIVER_HEADING).length, 2, 'one heading');
  assert.match(issue[0].body, /: refuse by unknown: judged refuse[^\n]*\n- round_cap on `abcdef1`: waive by unknown: judged waive/u);
});

test('aidrian pr waive refuses a head the last review step did not cover, whatever its outcome or ancestry', async (t) => {
  for (const [name, edit] of [['received', received], ['none_needed', (state, head) => (state.outcome = { status: 'none_needed', head, at: T0 })], ['round_limit', roundLimit]]) {
    const r = repo(t, { local: ON });
    r.record(5, (state) => edit(state, r.A));
    for (const head of [r.B, r.C, NEXT]) {
      for (const verdict of ['waive', 'refuse']) {
        await assert.rejects(waive(t, r, ['--verdict', verdict, '--reason', 'the push only renames a local'], { head }), /the last review step covered [0-9a-f]{7}, not head [0-9a-f]{7}: a verdict covers only round_limit on the current head, so run `aidrian pr review 5` on it/u, `${name}, ${verdict}`);
      }
    }
    assert.equal(readLocalState(r.project(), 5).waivers, undefined, `${name}: nothing written`);
  }
  // The --head spelling still binds to the full current head.
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const { out } = await waive(t, r, ['--verdict', 'waive', '--reason', 'nits', '--head', HEAD.slice(0, 7)]);
  assert.deepEqual([out.waiver.kind, out.waiver.head], ['round_cap', HEAD], 'the full current head, whatever --head spelled');
});

test('aidrian pr waive refuses what a verdict may not cover, and every bad argument', async (t) => {
  assert.throws(() => parseWaive(['5', '--verdict', 'waive', '--reason', '  ']), /--verdict needs --reason with the evidence/u);
  assert.throws(() => parseWaive(['5', '--verdict', 'waive']), /--verdict needs --reason/u);
  assert.throws(() => parseWaive(['5', '--verdict', 'merge', '--reason', 'x']), /--verdict must be waive or refuse/u);
  assert.throws(() => parseWaive(['5', '--reason', 'x']), /--verdict must be waive or refuse/u);
  assert.throws(() => parseWaive(['5', '--verdict', 'waive', '--reason', 'x', '--head', 'main']), /--head must be a commit SHA/u);
  assert.throws(() => parseWaive(['5', '--verdict', 'waive', '--reason', 'x', '--force']), /unknown argument: --force/u);
  assert.throws(() => parseWaive(['--verdict', 'waive']), /waive needs a pull request number/u);
  assert.throws(() => parseWaive(['5', '--verdict', 'waive', '--reason', 'x'.repeat(MAX_REASON + 1)]), /--reason is longer than 2000 characters/u);
  assert.equal(parseWaive(['5', '--verdict', 'waive', '--reason', 'x'.repeat(MAX_REASON)]).reason.length, MAX_REASON);
  const cases = [
    ['a --head that is not the current head', (state) => roundLimit(state), { args: ['--head', NEXT] }, /head is abcdef1, not 1234567: the verdict binds to the current head/u],
    ['an unreadable head', (state) => roundLimit(state), { change: () => { throw new Error('HTTP 502'); } }, /cannot read the pull request's head/u],
    ['a head that is no SHA', (state) => roundLimit(state), { change: () => ({ headRefOid: 'main' }) }, /cannot read the pull request's head/u],
    ['an owed review', (state) => (roundLimit(state), state.pending.push({ kind: 'request', head: HEAD, at: T0, by: 'the Human' })), {}, /1 review entry is still owed/u],
    ['no outcome', () => {}, {}, /holds no outcome/u],
    ['fix_required on the head', (state) => (state.outcome = { status: 'fix_required', head: HEAD, at: T0 }), {}, /is fix_required: a verdict covers only round_limit on the current head/u],
    ['blocked_quota on the head', (state) => (state.outcome = { status: 'blocked_quota', head: HEAD, at: T0 }), {}, /is blocked_quota/u],
    ['received on the head', (state) => received(state), {}, /is received/u],
    ['a moved head past an error', (state) => (state.outcome = { status: 'error', head: NEXT, at: T0 }), {}, /covered 1234567, not head abcdef1/u],
  ];
  for (const [name, edit, { args = [], change = null }, pattern] of cases) {
    const r = repo(t, { local: ON });
    r.record(5, edit);
    await assert.rejects(waive(t, r, ['--verdict', 'waive', '--reason', 'x', ...args], { change }), pattern, name);
    assert.equal(readLocalState(r.project(), 5).waivers, undefined, `${name}: nothing written`);
  }
  // Through the CLI: a bad argument exits 1 with the command's name.
  const error = t.mock.method(console, 'error', () => {});
  assert.equal(await commands.pr.run(['waive', '5', '--verdict', 'merge', '--reason', 'x']), 1);
  assert.match(error.mock.calls.at(-1).arguments[0], /^aidrian pr waive: --verdict must be waive or refuse$/u);
});

test('aidrian pr waive records a waive only with this machine\'s switch on; a refuse always', async (t) => {
  for (const local of [null, { github: { unattendedWaiver: 'off' } }]) {
    const r = repo(t, local ? { local } : {});
    r.record(5, roundLimit);
    await assert.rejects(waive(t, r, ['--verdict', 'waive', '--reason', 'x']), /github\.unattendedWaiver is not on in \.aidrian\.local\.json, so the merge guard would not take a waive verdict; --verdict refuse is still recorded/u);
    assert.equal(readLocalState(r.project(), 5).waivers, undefined);
    const { out } = await waive(t, r, ['--verdict', 'refuse', '--reason', 'the findings are real']);
    assert.equal(out.waiver.verdict, 'refuse');
  }
});

test('after a refuse verdict, the next step names the answer the merge guard\'s question takes', async (t) => {
  const r = repo(t);
  r.record(5, roundLimit);
  const { out } = await waive(t, r, ['--verdict', 'refuse', '--reason', 'the findings are real']);
  assert.match(out.next, /^the guard stands: the Human merges, or answers the merge guard's question with "Merge with the findings filed"$/u);
  // The label is the one the guard's deny offers and takes at the round limit.
  const label = /with "([^"]+)"$/u.exec(out.next)[1];
  const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`) ?? '';
  assert.ok(reason.includes(`the options "${label}" and`), reason);
  const question = /the question "([^"]+)"/u.exec(reason)[1];
  writeFileSync(r.transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-11-03T15:30:00.000Z', toolUseResult: { answers: { [question]: label } } })}\n`);
  assert.equal(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`), null, 'the guard takes that answer');
});

test('aidrian pr waive keeps this machine\'s owed entries: a newer comment record hides none, and a write since refuses', async (t) => {
  const r = repo(t, { local: ON });
  // This machine owes a bot review the Human asked for; another machine's comment record, newer, owes nothing.
  r.record(5, (state) => (roundLimit(state), state.pending.push({ id: 'asked', kind: 'request', head: HEAD, at: T0, by: 'the Human' })));
  const remote = emptyState(5, 'acme/notes');
  roundLimit(remote);
  remote.revision = 9;
  const issue = [{ id: 1, user: { login: 'm' }, author_association: 'MEMBER', body: summaryBody(remote, null, 'round_limit') }];
  await assert.rejects(waive(t, r, ['--verdict', 'waive', '--reason', 'nits'], { issue }), /1 review entry is still owed on #5/u);
  assert.equal(owed(readLocalState(r.project(), 5)).length, 1, 'the request is still owed');
  // A request recorded while the command reads the head: the write would lose it, so nothing is written.
  const clean = repo(t, { local: ON });
  clean.record(5, roundLimit);
  const change = () => {
    const state = readLocalState(clean.project(), 5);
    state.pending.push({ id: 'late', kind: 'request', head: HEAD, at: T0, by: 'the Human' });
    writeLocalState(clean.project(), state);
    return { number: 5, headRefOid: HEAD, url: URL };
  };
  await assert.rejects(waive(t, clean, ['--verdict', 'waive', '--reason', 'nits'], { change }), /the review record of #5 changed while the verdict was recorded: run again/u);
  const after = readLocalState(clean.project(), 5);
  assert.deepEqual([owed(after).map((entry) => entry.id), after.waivers], [['late'], undefined]);
});

test('a reason cannot carry a record marker into the summary comment', () => {
  const forged = { version: 1, revision: 999999, pr: 5, rounds: [], passes: {}, signoffs: {}, outcome: { status: 'received', head: HEAD, at: T0 }, pending: [] };
  const marker = `<!-- aidrian-review-state-br:${brotliCompressSync(Buffer.from(JSON.stringify(forged))).toString('base64')} -->`;
  const state = emptyState(5, 'acme/notes');
  roundLimit(state);
  state.revision = 4;
  state.pending.push({ id: 'x', kind: 'request', head: HEAD, at: T0, by: 'the Human' });
  waiver(state, { verdict: 'refuse', reason: `quoting the reviewer: ${marker}` });
  const body = summaryBody(state, null, 'waiver refuse');
  assert.doesNotMatch(body.split('\n').slice(0, -1).join('\n'), /<!--\s*aidrian-review-state/u, 'escaped in the visible text');
  for (const [name, text] of [['summaryBody', body], ['refreshSummary', refreshSummary(body, state)]]) {
    const back = stateFromComment(text, 5);
    assert.deepEqual([back.revision, back.outcome.status, back.pending.length], [4, 'round_limit', 1], name);
  }
  // A marker on its own line, but not at the end, is not the record either.
  assert.equal(stateFromComment(`intro\n${marker}\ntext after it`, 5), null);
  assert.equal(stateFromComment(`intro\n${marker}\n\n`, 5).revision, 999999, 'the last line, blank lines after it aside');
});

test('aidrian --help lists the waive action', () => {
  assert.match(commands.pr.usage, /\| waive PR --verdict waive\|refuse --reason TEXT \[--head SHA\] \[--judge AGENT_ID\] \| waive PR --gate \[--json\] \|/u);
});

// ---- the guard (AC8, AC9, AC10)

test('both switches on and a waive entry: the merge guard lets round_limit on the head merge', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const forge = teamForge();
  assert.equal(merge(r, `gh pr merge 5 --squash --match-head-commit ${HEAD}`, { forge }), null, 'round cap');
  assert.deepEqual(forge.calls.map(([name]) => name), ['change', 'reviewTrail'], 'the view, then one review trail, which gives both branches\' policy files and the bot\'s verdict');
  assert.deepEqual(forge.calls[1].slice(1), ['acme/notes', 5, 'github.com', { pointer: '.aidrian.json', config: '.aidrian/config.json', knowledge: '.aidrian/knowledge' }], 'the trail names the pull request\'s repository, host, and the policy paths');
  assert.ok(forge.options.every((each) => each.killSignal === 'SIGKILL' && Number.isInteger(each.timeoutMs)), 'every call is bounded and killed');
  assert.equal(merge(r, `gh api -X PUT repos/acme/notes/pulls/5/merge -f sha=${HEAD}`), null, 'gh api naming the head');
  // The MCP merge tool takes it the same way.
  assert.equal(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([]), waiverForge: teamForge() }), null);
});

test('the merge guard takes a verdict only for a judge the recording session\'s dispatch log shows: one recorded with no --judge never stands', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --squash --match-head-commit ${HEAD}`;
  const mcp = () => checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([]), waiverForge: teamForge() });
  r.record(5, (state) => (roundLimit(state), waiver(state, { judged: false })));
  for (const reason of [merge(r, command), mcp()]) {
    assert.match(reason ?? '', /A judge's verdict cannot stand for this head: the verdict names no judge agent and session \(`aidrian pr waive --judge <agent id>`\), so the dispatch log cannot show its judge was dispatched\./u);
  }
  // A judge the log does not show, or one of another session, is refused the same way.
  for (const named of [{ judge_id: 'judge-9', session: JUDGE.session }, { judge_id: JUDGE.judge_id, session: 'sess-other' }]) {
    r.record(5, (state) => (roundLimit(state), waiver(state, { judged: false }), Object.assign(state.waivers.at(-1), named)));
    assert.match(merge(r, command) ?? '', /cannot stand for this head: the dispatch log holds no dispatch of the code-reviewer judge-\d by session sess-\w+ between the cap and the verdict/u, JSON.stringify(named));
  }
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  assert.equal(merge(r, command), null, 'the judge the log shows');
});

test('a head the last review step did not cover is never waived: after received, none_needed, or round_limit, denied with no route, nothing read', (t) => {
  for (const [name, edit] of [['received', received], ['none_needed', (state, head) => (state.outcome = { status: 'none_needed', head, at: T0 })], ['round_limit', roundLimit]]) {
    const r = repo(t, { local: ON });
    // A routine fix push after the review (B descends from A) and a force-push (C does not), each with a waive entry
    // for its head, of another kind and of the round cap's: neither lets it merge.
    for (const head of [r.B, r.C]) {
      r.record(5, (state) => (edit(state, r.A), waiver(state, { head, kind: 'moved_head' }), waiver(state, { head })));
      const forge = teamForge(undefined, { head });
      const reason = merge(r, `gh pr merge 5 --match-head-commit ${head}`, { forge });
      assert.match(reason ?? '', /the last review step covered [0-9a-f]{7}, not head [0-9a-f]{7}: run `aidrian pr review 5` until it returns `received` or `none_needed`/u, `${name} ${head === r.B ? 'push' : 'force-push'}`);
      assert.doesNotMatch(reason, /aidrian pr waive|could not be read|recorded verdict/u, name);
      assert.deepEqual(forge.calls, [], `${name}: not waivable, so nothing is read`);
    }
  }
});

test('a clock that crosses the deadline, or a read that throws outside the forge, is a denial, never a throw', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const project = r.project();
  const state = readLocalState(project, 5);
  // Each reading of the clock moves it 1400 ms: the start check passes, and the deadline falls before the trail's read.
  let tick = 0;
  const advancing = () => (tick += 1400) - 1400;
  const out = guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: advancing });
  assert.deepEqual([out.allow, out.note, out.route], [false, ', and the team\'s github.unattendedWaiver could not be read in time', '']);
  // A clock that fails on its third reading, the time left after the view, where no forge call's catch is: the throw is
  // the unread denial, not the hook's catch, which would let the merge run.
  let reads = 0;
  let failsAt = 3;
  const failing = () => {
    reads += 1;
    if (reads === failsAt) throw new RangeError('the clock passed the deadline');
    return 0;
  };
  assert.deepEqual(guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: failing }), { allow: false, note: ', and the team\'s github.unattendedWaiver could not be read in time', route: '' });
  // Through the guard: a denial reason, and the merge does not run. The hold reads the clock once a git read, first.
  let holdReads = 0;
  baseProblem(project, { repo: 'origin', git: () => ((holdReads += 1), {}) });
  assert.ok(holdReads > 0, 'the hold makes its reads');
  reads = 0;
  failsAt = holdReads + 3;
  const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { startedAt: 0, now: failing });
  assert.match(reason ?? '', /is `round_limit`.*could not be read in time/su);
});

test('a verdict counts only for a merge that names its head', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  for (const command of ['gh pr merge 5 --squash', 'gh api -X PUT repos/acme/notes/pulls/5/merge']) {
    const reason = merge(r, command);
    assert.match(reason ?? '', /is `round_limit`/u, command);
    assert.match(reason, /A judge's recorded verdict waives this head, but only for a merge that names it: merge with `gh pr merge 5 --match-head-commit abcdef1234567890abcdef1234567890abcdef12 --repo acme\/notes`, or give the merge tool its `sha`\.$/u, command);
  }
  const mcp = checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5 }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([]), waiverForge: teamForge() });
  assert.match(mcp ?? '', /only for a merge that names it/u, 'the MCP tool without sha');
});

test('without a verdict that stands for this head and kind, the denial is today\'s, plus the route under both switches', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const route = /for the Human to run\. Or, under the unattended waiver this repository allows \(github\.unattendedWaiver\), a run with no Human present reads `waiver` in the JSON of `aidrian pr review 5 --repo acme\/notes`, and only when it says a judge may rule runs the one judge its `dispatch` names, as the pr-review-loop skill's references\/review-plan\.md § At the cap says, then records that judge's verdict with `aidrian pr extend 5 --verdict land\|stop --reason "<evidence>" --head abcdef1234567890abcdef1234567890abcdef12 --judge <agent id> --repo acme\/notes`, and on `land` merges naming that head\.$/u;
  for (const [name, edit] of [
    ['no entry', (state) => roundLimit(state)],
    ['an entry for another head', (state) => (roundLimit(state), waiver(state, { head: NEXT }))],
    ['an entry of another kind', (state) => (roundLimit(state), waiver(state, { kind: 'moved_head' }))],
    ['a refuse verdict', (state) => (roundLimit(state), waiver(state, { verdict: 'refuse' }))],
    ['a refuse after a waive', (state) => (roundLimit(state), waiver(state), waiver(state, { verdict: 'refuse' }))],
    ['a verdict older than the outcome', (state) => (roundLimit(state), waiver(state, { at: '2026-11-03T13:00:00.000Z' }))],
    ['an outcome whose time cannot be read', (state) => (roundLimit(state), (state.outcome.at = 'soon'), waiver(state))],
  ]) {
    r.record(5, edit);
    const reason = merge(r, command);
    assert.match(reason ?? '', /the review of head abcdef1 is `round_limit`: stopped at its round limit, and not running\. /u, name);
    assert.match(reason, route, name);
  }
  // A head past a finished review has no waiver route: the review can still run on it.
  const moved = repo(t, { local: ON });
  moved.record(5, (state) => received(state, moved.A));
  const movedReason = merge(moved, `gh pr merge 5 --match-head-commit ${moved.B}`, { forge: teamForge(undefined, { head: moved.B }) }) ?? '';
  assert.match(movedReason, /the last review step covered [0-9a-f]{7}, not head [0-9a-f]{7}: run `aidrian pr review 5`/u);
  assert.doesNotMatch(movedReason, /aidrian pr waive/u);
});

test('the local switch off: today\'s denial, no route, and no forge read at all', (t) => {
  for (const local of [null, { github: { unattendedWaiver: 'off' } }]) {
    const r = repo(t, local ? { local } : {});
    r.record(5, (state) => (roundLimit(state), waiver(state)));
    const forge = teamForge();
    const views = [];
    const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge, views });
    assert.match(reason ?? '', SHELL_TAIL);
    assert.doesNotMatch(reason, /aidrian pr waive/u);
    assert.deepEqual([forge.calls, forge.options, views], [[], [], []], 'no network');
  }
});

test('the team refuses on the default or the base branch: today\'s denial, and no route', (t) => {
  for (const [name, branches, base] of [
    ['default branch false', { main: { version: 1 } }, 'main'],
    ['base false', { main: ALLOW, release: { version: 1, github: { unattendedWaiver: { allow: false } } } }, 'release'],
    ['default false, base true', { main: { version: 1 }, release: ALLOW }, 'release'],
    ['the key in a broken shape', { main: { version: 1, github: { unattendedWaiver: { allow: 'yes' } } } }, 'main'],
  ]) {
    const r = repo(t, { local: ON });
    r.record(5, (state) => (roundLimit(state), waiver(state)));
    const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge: teamForge(branches, { base }) });
    assert.match(reason ?? '', SHELL_TAIL, name);
    assert.doesNotMatch(reason, /aidrian pr waive|could not be read|recorded verdict/u, name);
  }
  // Allowed on both: the trail gives the base's config beside the default branch's, so nothing is read over REST.
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const forge = teamForge({ main: ALLOW, release: ALLOW }, { base: 'release' });
  assert.equal(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge }), null);
  assert.deepEqual(forge.calls.map(([name]) => name), ['change', 'reviewTrail']);
  // A trail that does not give the base's files: the policies are read over REST, the default branch first, then the base.
  const fallback = teamForge({ main: ALLOW, release: ALLOW }, { base: 'release', rest: true });
  assert.equal(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge: fallback }), null);
  assert.deepEqual(fallback.calls.filter(([name]) => name === 'contents').map((call) => call[3]), ['refs/heads/main', 'refs/heads/main', 'refs/heads/release', 'refs/heads/release']);
  const refused = teamForge({ main: ALLOW, release: { version: 1 } }, { base: 'release', rest: true });
  assert.doesNotMatch(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge: refused }) ?? '', /aidrian pr waive|recorded verdict/u, 'the base read over REST refuses too');
});

test('a team it cannot read keeps the denial, and says so', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const unread = /is `round_limit`: stopped at its round limit, and not running, and the team's github\.unattendedWaiver could not be read in time\. Only the Human/u;
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const failing = Object.assign(() => ({ change: () => ({ number: 5, headRefOid: HEAD, baseRefName: 'main', url: URL }), reviewTrail: () => { throw new Error('gh: HTTP 502'); }, repository: () => assert.fail('no read after a failure'), contents: () => assert.fail('no read after a failure') }), {});
  assert.match(merge(r, command, { forge: failing }) ?? '', unread, 'a failed read');
  assert.match(merge(r, command, { forge: teamForge(undefined, { view: { baseRefName: undefined, url: undefined } }) }) ?? '', unread, 'a view without the base or URL');
  const reason = merge(r, command, { forge: Object.assign(() => ({ change: () => { throw new Error('gh: timed out'); } }), {}) });
  assert.match(reason ?? '', unread, 'a view that fails');
  assert.doesNotMatch(reason, /aidrian pr waive/u, 'no route when the team is unread');
});

test('the hook budget: one clock from the hook\'s start for the whole command, and each read bounded by the time left', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  r.record(6, (state) => (roundLimit(state, NEXT), waiver(state, { head: NEXT })));
  // The hook started 2 s ago: no read begins, and the denial says why.
  const late = teamForge();
  assert.match(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge: late, startedAt: Date.now() - 2000 }) ?? '', /could not be read in time/u);
  assert.deepEqual(late.calls, [], 'too late to begin');
  // Each call takes 1.3 s on the test clock, and the trail leaves out the base, so the policies are read over REST too:
  // the view gets 3 s, the trail the 2.7 s left, each REST read 1 s, the one begun at 3.9 s the 0.1 s left, and none
  // begins at 4 s.
  const clock = { now: 0 };
  const slow = teamForge({ main: ALLOW, release: ALLOW }, { base: 'release', clock, tick: 1300, rest: true });
  const project = r.project();
  const out = guardWaiver({ project, state: readLocalState(project, 5), pr: 5, head: HEAD, named: true, forge: slow, startedAt: 0, now: () => clock.now });
  assert.deepEqual([out.allow, out.note], [false, ', and the team\'s github.unattendedWaiver could not be read in time']);
  assert.deepEqual(slow.options.map((each) => each.timeoutMs), [3000, 2700, 1000, 100]);
  assert.ok(clock.now <= WAIVER_DEADLINE_MS + 1300, 'the last call began before the deadline');
  // Two waivable merges in one command: the first spends the time, so the second reads nothing and is denied.
  const shared = { now: 0 };
  const forge = teamForge(undefined, { clock: shared, tick: 800 });
  const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD} && gh pr merge 6 --match-head-commit ${NEXT}`, { forge, startedAt: 0, now: () => shared.now });
  assert.match(reason ?? '', /pull request #6 at 1234567, and the review of head 1234567 is `round_limit`.*could not be read in time/su);
  assert.equal(forge.calls.length, 2, 'only the first merge read anything');
  assert.ok(shared.now <= WAIVER_DEADLINE_MS);
});

test('the hook budget under solo: an unset switch reads git once, before any forge read, and a stalled git read refuses the merge', (t) => {
  const team = { solo: true, github: { unattendedWaiver: { allow: true } } };
  const r = repo(t, { config: team });
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const branches = { main: { version: 1, ...team } };
  // Solo on the default branch, as the local ref and GitHub both commit it: the verdict stands with no machine switch.
  assert.equal(r.project().localUnattendedWaiver, 'unset');
  assert.equal(merge(r, command, { forge: teamForge(branches) }), null, 'solo turns the unset switch on');
  // A git that stalls on its read of the local file: each such read takes 2 s on the test clock. A git on PATH logs it
  // and runs the real one; the clock counts the log.
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-slow-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = path.join(bin, 'ls-files.log');
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" ls-files "*) echo x >> '${log}';; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path0 = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${path0}`;
  t.after(() => (process.env.PATH = path0));
  const reads = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
  const start = 1_000_000;
  const forge = teamForge(branches);
  const reason = merge(r, command, { forge, startedAt: start, now: () => start + 2000 * reads() });
  assert.match(reason ?? '', /the review of head abcdef1 is `round_limit`/u, 'the merge is refused');
  assert.doesNotMatch(reason, /could not be read in time/u, 'an unset switch says nothing of an unread team value');
  assert.deepEqual(forge.calls, [], 'no forge read once the git reads spent the start budget');
  assert.equal(reads(), 1, 'the local file was read once, before the start check');
});

test('the hook budget under solo, in real time: a git that hangs on the local file is stopped at its read limit, and the merge refused', (t) => {
  const team = { solo: true, github: { unattendedWaiver: { allow: true } } };
  const r = repo(t, { config: team });
  r.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const project = r.project();
  const state = readLocalState(project, 5);
  // A git on PATH that sleeps 10 s when asked whether git tracks the local file, and runs the real one otherwise.
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-hung-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" ls-files "*) exec sleep 10;; esac\nexec '${real}' "$@"\n`, { mode: 0o755 });
  const path0 = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${path0}`;
  t.after(() => (process.env.PATH = path0));
  const forge = teamForge({ main: { version: 1, ...team } });
  // The hook started 3.5 s ago, so 0.5 s is left: each read is held to that, below git's own 2 s limit (lib/git.mjs).
  const started = Date.now();
  const out = guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge, startedAt: started - (WAIVER_DEADLINE_MS - 500) });
  const took = Date.now() - started;
  assert.deepEqual(out, { allow: false, note: '', route: '' }, 'the merge is refused');
  assert.ok(took < 1500, `the guard answered in ${took} ms: the hung read was stopped at the time left, not at git's 2 s or the hung git's 10 s`);
  assert.deepEqual(forge.calls, [], 'no forge read past the stopped git read');
});

test('the guard\'s own head lookup shares the deadline: past it, a merge that names no head is refused with no lookup', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  r.record(6, (state) => roundLimit(state, NEXT));
  // The waived merge's two reads, 2 s each, bring the clock to 4 s; the next merge names no head.
  const clock = { now: 0 };
  const forge = teamForge(undefined, { clock, tick: 2000 });
  const views = [];
  const reason = check(`gh pr merge 5 --match-head-commit ${HEAD} && gh pr merge 6 --squash`, {
    cwd: r.dir, env: {}, input: { transcript_path: r.transcript }, viewPr: viewer(views), waiverForge: forge, startedAt: 0, now: () => clock.now,
  });
  assert.equal(forge.calls.length, 2, 'the first merge was waived');
  assert.equal(clock.now, WAIVER_DEADLINE_MS);
  assert.match(reason ?? '', /^Blocked: this merges pull request #6, and the merge guard could not read its head commit in time to check its review\. Name both: `gh pr merge <PR> --match-head-commit <sha>`/u);
  assert.deepEqual(views, [], 'no lookup made');
  // With time left, the lookup is bounded by it.
  const bounded = [];
  const timed = (target, where, options) => (bounded.push(options), { number: Number(target), headRefOid: NEXT, baseRefName: 'main', url: URL });
  check('gh pr merge 6 --squash', { cwd: r.dir, env: {}, input: { transcript_path: r.transcript }, viewPr: timed, startedAt: 0, now: () => 3500 });
  assert.deepEqual(bounded, [{ timeoutMs: 500 }]);
});

test('what a verdict never waives: an owed review, any other outcome on the head, an unreadable head or merge text', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  r.record(5, (state) => (roundLimit(state), waiver(state), state.pending.push({ kind: 'request', head: HEAD, at: T0, by: 'the Human' })));
  const owedReason = merge(r, command);
  assert.match(owedReason ?? '', /never sent: send it with `aidrian pr await-review 5 --request`/u, 'an owed review');
  assert.doesNotMatch(owedReason, /aidrian pr waive/u);
  for (const status of ['blocked_quota', 'fix_required', 'error', 'running', 'stuck']) {
    r.record(5, (state) => ((state.outcome = { status, head: HEAD, at: T0 }), waiver(state)));
    const forge = teamForge();
    const reason = merge(r, command, { forge });
    assert.match(reason ?? '', new RegExp(`the review of head abcdef1 is \`${status}\``, 'u'), status);
    assert.doesNotMatch(reason, /aidrian pr waive/u, status);
    assert.deepEqual(forge.calls, [], `${status}: not waivable, so nothing is read`);
  }
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  assert.match(merge(r, 'gh pr merge 5', { head: null }) ?? '', /could not read its head commit in time/u, 'an unreadable head');
  assert.equal(merge(r, `echo 'gh pr merge 5' | bash`), UNREAD_REASON, 'unreadable merge text');
  // checkMcp answers as check does.
  const mcp = (input, options = {}) => checkMcp(input, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([], options), waiverForge: teamForge() });
  assert.equal(mcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }), null);
  assert.match(mcp({ owner: 'acme', repo: 'notes', pullNumber: 5 }, { head: null }) ?? '', /could not read its head commit in time/u);
  r.record(5, (state) => ((state.outcome = { status: 'blocked_quota', head: HEAD, at: T0 }), waiver(state)));
  assert.match(mcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }) ?? '', /is `blocked_quota`/u);
});

test('waiverKind and waiverFor: the one kind a verdict covers, and the entry that stands', () => {
  const state = emptyState(5, 'acme/notes');
  assert.equal(waiverKind(state, HEAD), null, 'no outcome');
  roundLimit(state);
  assert.equal(waiverKind(state, HEAD), 'round_cap');
  assert.equal(waiverKind(state, HEAD.slice(0, 7)), 'round_cap', 'a short spelling of the head');
  assert.equal(waiverKind(state, NEXT), null, 'a head past the cap\'s head');
  received(state);
  assert.equal(waiverKind(state, HEAD), null, 'a finished review needs no waiver');
  assert.equal(waiverKind(state, NEXT), null, 'a head past a finished review: the review can still run');
  state.outcome = { status: 'running', head: HEAD, at: T0 };
  assert.equal(waiverKind(state, NEXT), null, 'past a step still running');
  roundLimit(state);
  waiver(state);
  waiver(state, { head: NEXT, kind: 'moved_head' });
  assert.equal(waiverFor(state, HEAD, 'round_cap')?.verdict, 'waive');
  assert.equal(waiverFor(state, NEXT, 'round_cap'), null, 'an entry for another head');
  state.outcome.at = 'not a time';
  assert.equal(waiverFor(state, HEAD, 'round_cap'), null, 'an outcome time that cannot be read lets none stand');
});

// ---- under autopilot: the bot, the findings at the cap, the gate, and the judge (S7)

// An open finding of the record's index, a local reviewer's by default.
const openFinding = (id, extra = {}) => ({ id, title: { 'R1-1': 'the loop retries forever', 'R1-2': 'a name shadows the import' }[id] ?? `finding ${id}`, file: `src/${id}.js`, state: 'open', severity: 'medium', stage: 'local', reviewer: 'self', pass: 'self:0', ...extra });

test('a verdict never stands in for the review bot: no card, a card of another head, or no reviewer set keeps the denial, and says why', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  for (const [name, forge, why] of [
    ['no card', teamForge(undefined, { bot: false }), /chatgpt-codex-connector\[bot\] has not passed head abcdef1 on the forge/u],
    ['a card of the head before', teamForge(undefined, { bot: NEXT }), /has not passed head abcdef1 on the forge/u],
    ['no reviewer set', teamForge({ main: { version: 1, github: { unattendedWaiver: { allow: true }, reviewer: null } } }), /no review bot is set/u],
  ]) {
    const reason = merge(r, command, { forge }) ?? '';
    assert.match(reason, /the review of head abcdef1 is `round_limit`/u, name);
    assert.match(reason, /A judge's verdict cannot stand for this head: it never stands in for the review bot, and /u, name);
    assert.doesNotMatch(reason, /aidrian pr waive/u, `${name}: no route to record a verdict that cannot stand`);
    assert.match(reason, why, name);
    assert.deepEqual(forge.calls.map(([call]) => call), ['change', 'reviewTrail'], `${name}: one trail read`);
  }
  assert.equal(merge(r, command, { forge: teamForge() }), null, 'the bot passed this head: the verdict stands');
  // No verdict yet, and no bot set: the denial offers no route to a verdict that could not stand.
  r.record(5, (state) => roundLimit(state));
  const unbotted = merge(r, command, { forge: teamForge({ main: { ...ALLOW, github: { ...ALLOW.github, reviewer: null } } }) }) ?? '';
  assert.match(unbotted, /A judge's verdict cannot stand for this head: it never stands in for the review bot, and no review bot is set/u);
  assert.doesNotMatch(unbotted, /aidrian pr waive/u);
});

test('a verdict waives only medium-or-lower findings of this machine\'s reviewers: a high, security, bot, unweighed, or uncounted one keeps the denial', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const item = (extra = {}) => ({ id: 'R2-1', severity: 'medium', stage: 'local', reviewer: 'self', pass: 'self:0', ...extra });
  // Through the cap's cause, and through the finding index, which meets the same rules.
  for (const [name, edit, pattern] of [
    ['a high finding', { items: [item({ severity: 'high' })], counted: 1 }, /finding R2-1 is high, above medium/u],
    ['a critical one by a synonym', { items: [item({ severity: 'blocker' })], counted: 1 }, /finding R2-1 is critical, above medium/u],
    ['a marked medium finding', { items: [item({ security: true })], counted: 1 }, /finding R2-1 is a security finding/u],
    ['the security reviewer\'s low finding', { items: [item({ severity: 'low', reviewer: 'agent:security-engineer' })], counted: 1 }, /finding R2-1 is a security finding/u],
    ['the bot\'s low finding', { items: [item({ severity: 'low', stage: 'remote', reviewer: 'pr-bot' })], counted: 1 }, /finding R2-1 is not one of this machine's reviewers' \(stage remote\)/u],
    ['a severity the table does not know', { items: [item({ severity: 'dire' })], counted: 1 }, /finding R2-1 is of no known severity/u],
    ['a finding id of no known shape', { items: [item({ id: '<img src=x>', severity: 'high' })], counted: 1 }, /: a finding is high, above medium/u],
    ['findings counted, not listed', { items: [], counted: 2, itemized: false }, /2 open findings are counted, not each listed with its severity/u],
    ['an index entry of the bot', { index: { 'R1-1': openFinding('R1-1', { severity: 'low', stage: 'remote', reviewer: 'pr-bot' }) } }, /finding R1-1 is not one of this machine's reviewers'/u],
    ['an index entry with no stage the plan note resolves', { index: { 'R1-1': openFinding('R1-1', { stage: undefined, pass: 'engine:other' }) } }, /finding R1-1 is not one of this machine's reviewers' \(stage unknown\)/u],
  ]) {
    const { index = {}, ...extra } = edit;
    r.record(5, (state) => {
      roundLimit(state, HEAD, extra);
      waiver(state);
      state.index = index;
    });
    const reason = merge(r, command) ?? '';
    assert.match(reason, /A judge's verdict cannot stand for this head: /u, name);
    assert.match(reason, pattern, name);
  }
  // Medium and low local findings, a closed high one, and every open finding listed: the verdict stands.
  r.record(5, (state) => {
    roundLimit(state, HEAD, { items: [item(), item({ id: 'R2-2', severity: 'minor', stage: 'independent', reviewer: 'codex-local', pass: 'engine:codex-local' })], counted: 2 });
    waiver(state);
    state.index = { 'R1-1': openFinding('R1-1'), 'R1-2': openFinding('R1-2', { severity: 'minor', stage: 'independent', reviewer: 'codex-local' }), 'R1-3': openFinding('R1-3', { title: 'the token leaks into the log', file: 'src/log.js', severity: 'high', state: 'fixed' }) };
  });
  assert.equal(merge(r, command), null);
  // An accepted residual above low on a pass record holds it for the Human, as it holds auto-merge.
  const held = emptyState(5, 'acme/notes');
  roundLimit(held);
  held.passes = { 'self:0': { head: HEAD, ruled: [{ title: 't', file: 'a.js', severity: 'medium', residual: 'the retry has no cap' }] } };
  assert.match(capProblem(held, HEAD) ?? '', /an accepted residual waived a finding above low severity/u);
});

test('a verdict stands only when open findings are the whole cause of the cap: every other cause, and a record with none, keeps the denial', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  for (const [name, edit, pattern] of [
    ['a record from before causes were kept', (state) => delete state.outcome.cap, /keeps no cause of the round cap on this head/u],
    ['a cause of another head', (state) => (state.outcome.cap.head = NEXT), /keeps no cause of the round cap on this head/u],
    ['a violated or unverified invariant', (state) => (state.outcome.cap.flows = ['payments']), /flow payments has an invariant violated, unverified, or unsigned/u],
    ['a deleted flow test', (state) => (state.outcome.cap.tests_removed = ['payments']), /deletes a test of flow payments/u],
    ['a failing flow check', (state) => (state.outcome.cap.checks_failing = 1), /a check the flows require fails/u],
    ['the bot\'s own round limit', (state) => (state.outcome.cap.bot = true), /the review bot reached its own round limit/u],
    ['a pass that never reviewed the head', (state) => (state.outcome.cap.unrun = ['engine:codex-local']), /pass engine:codex-local never reviewed this head/u],
    // A fix pushed that no round reviewed: the last round's own findings and flows decide.
    ['an unreviewed head whose last round left a flow unsigned', (state) => Object.assign(state.outcome.cap, { reviewed: NEXT, unsigned: ['payments'] }), /flow payments has an invariant violated/u],
    ['an unreviewed head whose last round kept no flows', (state) => Object.assign(state.outcome.cap, { reviewed: NEXT, unsigned: null }), /names no flows it left unsigned/u],
    ['an unreviewed head whose last round counted only', (state) => Object.assign(state.outcome.cap, { reviewed: NEXT, counted: 2, itemized: false }), /2 open findings are counted/u],
    ['an unreviewed head whose last round left a violated invariant', (state) => Object.assign(state.outcome.cap, { reviewed: NEXT, counted: 1, items: [{ severity: null, pass: null, stage: null }] }), /a finding is not one of this machine's reviewers'|of no known severity/u],
  ]) {
    r.record(5, (state) => (roundLimit(state), waiver(state), edit(state)));
    const reason = merge(r, command) ?? '';
    assert.match(reason, /A judge's verdict cannot stand for this head: /u, name);
    assert.match(reason, pattern, name);
  }
  // An unreviewed head whose last round left only medium local findings, the bot having passed the current head: it stands.
  r.record(5, (state) => (roundLimit(state, HEAD, { reviewed: NEXT, counted: 1, items: [{ id: 'R2-1', severity: 'medium', stage: 'local', reviewer: 'self', pass: 'self:0' }] }), waiver(state)));
  assert.equal(merge(r, command), null);
});

test('a verdict never lifts a sign-off the Human owes on the head: a flow the record names, one the forge may select, or one the cause names', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const payments = { version: 1, state: { dir: '../state' }, github: { unattendedWaiver: { allow: true } }, review: { flows: { payments: { files: ['src/**'], signoff: 'human', invariants: [{ id: 'p1', text: 'a payment is never charged twice' }] } } } };
  for (const [name, edit, branches] of [
    ['a flow the record names for the Human', (state) => (state.signoffable.flows = ['payments']), undefined],
    ['a flow the forge\'s files select', () => {}, { main: payments }],
    ['a flow the cause names', (state) => (state.outcome.cap.human = ['payments']), undefined],
    ['a record that names no flows for this head', (state) => (state.signoffable = { head: NEXT, flows: [] }), undefined],
  ]) {
    r.record(5, (state) => (roundLimit(state), waiver(state), edit(state)));
    const reason = merge(r, command, { forge: teamForge(branches) }) ?? '';
    assert.match(reason, /A judge's verdict cannot stand for this head: (flow payments needs the Human's sign-off on head abcdef1|the record names no flows the Human signs off on this head)/u, name);
  }
});

// The gate's forge, the facade itself: teamForge's, for the pull request #5 on `base`.
const gateForge = (branches, options) => teamForge(branches, options)({});

// `aidrian pr waive 5 --gate --json` as the CLI runs it, over `forge`, with `run` the session's project run.
// A host whose hook confirms a judge's dispatch, as Claude Code's does.
const CONFIRMS = { name: 'claude-code', capabilities: { judgeDispatch: true } };
async function gate(t, r, { forge = gateForge(), run = undefined, args = ['--json'], runHost = CONFIRMS } = {}) {
  const out = [];
  const err = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  t.mock.method(console, 'error', (line) => err.push(line));
  try {
    const project = r.project();
    const code = await runWaive(['5', '--gate', ...args], project, loadConfig(project).config, { forge, gate: { run: () => run, runHost } });
    return { code, out, err, result: out.length && args.includes('--json') ? JSON.parse(out.at(-1)) : null };
  } finally {
    t.mock.restoreAll();
  }
}

test('aidrian pr waive --gate exits 0 only when the waiver may run: the round cap on the head, the team and machine on, the findings waivable, the bot passed', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const on = await gate(t, r);
  assert.equal(on.code, 0, on.err.join('\n'));
  assert.deepEqual(on.result, { may: true, why: null, pr: 5, head: HEAD, repo: 'acme/notes', base: 'main' });
  const plain = await gate(t, r, { args: [] });
  assert.equal(plain.code, 0);
  assert.equal(plain.out.at(-1), `waiver may run for #5 at abcdef1: dispatch one fresh judge, and record its verdict with --head ${HEAD} --judge <agent id>`);
  const off = async (name, forge, pattern, { local = ON, edit = roundLimit, config = {}, ...options } = {}) => {
    const each = repo(t, { ...(local ? { local } : {}), config });
    each.record(5, edit);
    const result = await gate(t, each, { forge, ...options });
    assert.equal(result.code, 1, name);
    assert.equal(result.result.may, false, name);
    assert.match(result.result.why, pattern, name);
  };
  await off('the default branch does not allow it', gateForge({ main: REFUSE }), /the team does not allow it \(github\.unattendedWaiver\.allow on acme\/notes main\)/u);
  await off('the base does not allow it', gateForge({ main: ALLOW, release: REFUSE }, { base: 'release' }), /github\.unattendedWaiver\.allow on acme\/notes release/u);
  await off('this machine has not opted in', gateForge(), /this machine has not opted in/u, { local: null });
  await off('a received review', gateForge(), /is received: a verdict covers only round_limit/u, { edit: received });
  await off('a head pushed after the cap', gateForge(undefined, { head: NEXT }), /the last review step covered abcdef1, not head 1234567/u);
  await off('a high finding open', gateForge(), /finding R1-1 is high/u, { edit: (state) => (roundLimit(state), (state.index = { 'R1-1': openFinding('R1-1', { severity: 'high' }) })) });
  await off('the bot has not passed the head', gateForge(undefined, { bot: false }), /a verdict never stands in for the review bot, and chatgpt-codex-connector\[bot\] has not passed head abcdef1/u);
  await off('a judge already ruled on the head', gateForge(), /a judge already gave its verdict on head abcdef1 \(refuse\): one judge rules per head/u, { edit: (state) => (roundLimit(state), waiver(state, { verdict: 'refuse' })) });
  await off('a host that does not confirm a judge', gateForge(), /this host \(codex\) does not confirm a judge's dispatch in the dispatch log/u, { runHost: { name: 'codex', capabilities: {} } });
  await off('telemetry off', gateForge(), /telemetry\.enabled is false, so the hooks write no dispatch log/u, { config: { telemetry: { enabled: false } } });
  await off('a flow the Human signs off, with no sign-off', gateForge(), /flow payments needs the Human's sign-off on head abcdef1/u, { edit: (state) => (roundLimit(state), (state.signoffable.flows = ['payments'])) });
  await off('a working copy whose state folder is not the default branch\'s', gateForge({ main: { ...ALLOW, state: { dir: '../elsewhere' } } }), /state\.dir/u);
  // The forge's view fails: an error, exit 3.
  const failed = await gate(t, r, { forge: { change: () => { throw new Error('gh: HTTP 502'); } } });
  assert.equal(failed.code, 3);
  assert.match(failed.err.join('\n'), /^aidrian pr waive: could not read pull request #5 \(gh: HTTP 502\)$/u);
  assert.throws(() => parseWaive(['5', '--gate', '--verdict', 'waive']), /--gate takes only --json, not --verdict/u);
});

test('aidrian pr waive --gate reads the team\'s switch through the forge, never the working copy', async (t) => {
  // The working copy allows it, GitHub's default branch does not: off.
  const allowed = repo(t, { local: ON, config: { github: { unattendedWaiver: { allow: true } } } });
  allowed.record(5, roundLimit);
  const off = await gate(t, allowed, { forge: gateForge({ main: REFUSE }) });
  assert.deepEqual([off.code, off.result.may], [1, false]);
  assert.match(off.result.why, /the team does not allow it/u);
  // The working copy says nothing, GitHub allows it on both branches: on.
  const silent = repo(t, { local: ON });
  silent.record(5, roundLimit);
  assert.equal((await gate(t, silent, { forge: gateForge({ main: ALLOW }) })).code, 0);
});

test('a project run counts the pull requests it merged on a verdict: at WAIVED_MERGES no verdict may run, and the issue is parked', async (t) => {
  const fx = runFixture(t);
  // The gate holds a session of the run to the repository the run pinned: a pull request of another is refused.
  const pinnedOff = await gate(t, { project: () => fx.project }, { run: 'launch' });
  assert.deepEqual([pinnedOff.code, pinnedOff.result.may], [1, false]);
  assert.match(pinnedOff.result.why, /the pull request is in acme\/notes, and this session's project run works in /u);
  const unread = await gate(t, { project: () => fx.project }, { run: 'gone' });
  assert.match(unread.result.why, /the ledger of this session's project run cannot be read/u);
  const { owner, name } = fx.run().init.repository;
  const repoOf = `${owner}/${name}`;
  const recordWaived = (n, verdict = 'waive') => {
    const state = emptyState(n, repoOf);
    roundLimit(state);
    waiver(state, { verdict });
    writeLocalState(fx.project, state);
  };
  const merged = (...prs) => appendToRun(fx.state, 'launch', () => ({ rows: prs.map((pr) => ({ event: 'result', key: 'WID-1', attempt: 1, session: 'child', via: 'drop', status: 'merged', pr, verified: true, at: new Date().toISOString() })) }));
  const budget = (pr = 9) => budgetProblem({ project: fx.project, config: fx.config, run: 'launch', pr });
  assert.equal(budget(), null, 'no merges yet');
  for (const n of [1, 2]) recordWaived(n);
  recordWaived(3, 'refuse');
  merged(1, 2, 3);
  assert.equal(budget(), null, 'two waived merges, and a third merged on a refuse, which is no waiver');
  // A waive on a head other than the one that merged stands for nothing that merged: not counted.
  const stale = emptyState(5, repoOf);
  roundLimit(stale);
  waiver(stale, { head: NEXT });
  writeLocalState(fx.project, stale);
  merged(5);
  assert.equal(budget(), null, 'a verdict on another head than the merged one is no waived merge');
  recordWaived(4);
  merged(4);
  assert.equal(WAIVED_MERGES, 3);
  assert.match(budget() ?? '', /project run launch merged 3 pull requests on a judge's verdict already, its most \(3\): park the issue for the Human/u);
  assert.equal(budget(4), null, 'the pull request itself is not counted against itself');
  assert.match(budgetProblem({ project: fx.project, config: fx.config, run: null, pr: 9 }) ?? '', /names a project run that cannot be read/u);
  assert.match(budgetProblem({ project: fx.project, config: fx.config, run: 'gone', pr: 9 }) ?? '', /the ledger of project run gone cannot be read/u);
  assert.equal(budgetProblem({ project: fx.project, config: fx.config, run: undefined, pr: 9 }), null, 'no run: no budget');
  // runOf reads the run off a mark: none, the run, or a mark whose tags cannot be read.
  assert.deepEqual([runOf(null), runOf({ root: '/x' }), runOf({ root: '/x', project: 'launch', issue: 'WID-1' }), runOf({ root: '/x', project: null, issue: null })], [undefined, undefined, 'launch', null]);
});

test('aidrian pr waive --judge keeps the judge\'s agent id and the session, and refuses one this session\'s dispatch log does not show', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const project = r.project();
  const config = loadConfig(project).config;
  const log = logPath(project, config);
  mkdirSync(path.dirname(log), { recursive: true });
  const row = (extra = {}) => JSON.stringify({ event: 'dispatch', ts: '2026-11-03T14:30:00.000Z', session_id: 'sess-1', dispatcher: 'main', agent_id: 'judge-1', agent_type: 'aidrian:code-reviewer', ...extra });
  writeFileSync(log, `${[row({ agent_id: 'judge-2', agent_type: 'aidrian:explorer' }), row({ agent_id: 'judge-3', session_id: 'other' }), row({ agent_id: 'judge-4', ts: '2026-11-03T13:00:00.000Z' })].join('\n')}\n`);
  const record = (judge) => {
    const forge = {
      change: (ref, fields) => (fields === 'baseRefName' ? { baseRefName: r.git('branch', '--show-current') } : { number: 5, headRefOid: HEAD, url: URL }),
      conversationComments: () => [],
    };
    t.mock.method(console, 'log', () => {});
    return runWaive(['5', '--verdict', 'waive', '--reason', 'nits', '--judge', judge], project, { ...config, review: { ...config.review, record: 'local' } }, { forge, repo: 'acme/notes', env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'sess-1' } }).finally(() => t.mock.restoreAll());
  };
  for (const [judge, why] of [['judge-1', 'no row'], ['judge-2', 'an explorer, not a code-reviewer'], ['judge-3', 'another session'], ['judge-4', 'dispatched before the cap']]) {
    await assert.rejects(record(judge), /the dispatch log holds no dispatch of the code-reviewer judge-\d by session sess-1 between the cap and the verdict/u, why);
  }
  assert.equal(readLocalState(project, 5).waivers, undefined, 'nothing written');
  writeFileSync(log, `${row()}\n`, { flag: 'a' });
  assert.equal(await record('judge-1'), 0);
  const [entry] = readLocalState(project, 5).waivers;
  assert.deepEqual([entry.judge_id, entry.session, entry.verdict], ['judge-1', 'sess-1', 'waive']);
  assert.throws(() => parseWaive(['5', '--verdict', 'waive', '--reason', 'x', '--judge', '$(id)']), /--judge must be the judge's agent id/u);
});

// ---- the one route at the cap: the review step's `waiver`, and `aidrian pr extend --verdict land` (issue 634)

// A check at the cap waiting for its judge, as the review step leaves it: the outcome `extension_check` on `head`, with
// the cap's cause, and the plan's check of round 2 judging.
const atCheck = (state, head = HEAD, extra = {}) => {
  roundLimit(state, head, extra);
  state.outcome.status = 'extension_check';
  state.extensions = [{ source: 'plan', round: 2, head, at: T0, mode: 'ask', max: 2, granted_before: 0, status: 'judging', by: null, reasons: [] }];
};

// The review gate's forge and `aidrian pr extend`'s in one: the pull request is on this checkout's own branch, which,
// as the default branch, holds `policy` (by default allowing the waiver), so holdToBase and the gate read the same base.
// `comments` are the pull request's comments; `visibility` answers the forge's reading of the repository.
function landForge(r, { policy = ALLOW, comments = [], visibility = () => 'PRIVATE', ...options } = {}) {
  const branch = r.git('branch', '--show-current');
  const make = teamForge({ main: policy, [branch]: policy }, { base: branch, ...options });
  const issue = comments;
  const facade = make({});
  return Object.assign({
    ...facade,
    visibility,
    pull: () => ({ author_association: 'MEMBER', base: { repo: { fork: false } } }),
    change: (ref, fields, given) => (fields === 'isCrossRepository' ? { isCrossRepository: false } : facade.change(ref, fields, given)),
    conversationComments: () => issue,
    postComment: (_repo, _n, body) => (issue.push({ id: issue.length + 1, user: { login: 'someone' }, author_association: 'MEMBER', body }), issue.at(-1)),
    editComment: (_repo, id, body) => (issue.find((comment) => comment.id === id).body = body),
    viewer: () => 'someone',
  }, { calls: make.calls });
}

// `aidrian pr extend 5 ...` as the CLI runs it, in the judge's session, on a host that confirms the judge.
async function extend(t, r, args, { forge = landForge(r), runHost = CONFIRMS } = {}) {
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(line));
  try {
    const project = r.project();
    const code = await runExtend(['5', ...args], project, loadConfig(project).config, { forge, repo: 'acme/notes', env: { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: JUDGE.session }, gate: { run: () => undefined, runHost } });
    return { code, out: JSON.parse(out.at(-1)) };
  } finally {
    t.mock.restoreAll();
  }
}

test('the review step reports the waiver gate at the cap, and offers its judge `land` only when the gate says a judge may rule', (t) => {
  const r = repo(t, { local: ON });
  const config = loadConfig(r.project()).config;
  const seams = (forge = gateForge()) => ({ forge, run: () => undefined, runHost: CONFIRMS });
  const capped = (status) => ({ status, pr: 5, repo: 'acme/notes', head: HEAD });
  // At round_limit, with no check: the gate's word, and one judge for landing alone.
  r.record(5, roundLimit);
  const limit = offerLand(capped('round_limit'), offerWaiver(capped('round_limit'), r.project(), config, seams()));
  assert.deepEqual(limit.waiver, { may: true, why: null });
  assert.deepEqual([limit.dispatch[0].pass, limit.dispatch[0].agent], ['waiver-judge', 'code-reviewer']);
  assert.equal(limit.dispatch[0].record, `aidrian pr extend 5 --verdict land|stop --reason "<evidence>" --head ${HEAD} --judge <agent id>`);
  assert.match(limit.dispatch[0].brief, /`waiver\.may` is true[\s\S]*Verdict `land` only when every open finding is `accepted_residual`/u);
  // At a check waiting for its judge: read as the round_limit the judge's stop leaves, and the third verdict offered.
  r.record(5, atCheck);
  const judging = { ...capped('extension_check'), dispatch: [{ pass: 'extension-judge', agent: 'code-reviewer', brief: 'Read-only.', record: `aidrian pr extend 5 --verdict extend|stop --reason "<evidence>" --head ${HEAD} --check 'plan'` }] };
  const check = offerLand(judging, offerWaiver(judging, r.project(), config, seams()));
  assert.equal(check.waiver.may, true, check.waiver.why);
  assert.equal(check.dispatch[0].record, `aidrian pr extend 5 --verdict land|stop --reason "<evidence>" --head ${HEAD} --check 'plan' --judge <agent id>`);
  assert.equal(check.dispatch[0].record_extend, `aidrian pr extend 5 --verdict extend --reason "<evidence>" --head ${HEAD} --check 'plan'`, 'extend takes no --judge');
  assert.match(check.dispatch[0].brief, /^Read-only\. `waiver\.may` is true: .*a third verdict is open: `land`/u);
  // Whatever the gate refuses, the step says why and offers no `land`: the same gate as `aidrian pr waive --gate`.
  r.record(5, (state) => (atCheck(state), (state.index = { 'R1-1': openFinding('R1-1', { severity: 'high' }) })));
  const high = offerLand({ ...judging, dispatch: [...judging.dispatch] }, offerWaiver(judging, r.project(), config, seams()));
  assert.equal(high.waiver.may, false);
  assert.match(high.waiver.why, /finding R1-1 is high/u);
  assert.equal(high.dispatch[0].record, judging.dispatch[0].record, 'no land offered');
  r.record(5, roundLimit);
  const noBot = offerLand(capped('round_limit'), offerWaiver(capped('round_limit'), r.project(), config, seams(gateForge(undefined, { bot: false }))));
  assert.match(noBot.waiver.why, /a verdict never stands in for the review bot/u);
  assert.equal(noBot.dispatch, undefined, 'no judge dispatched');
  // A machine that has not opted in reads nothing from the forge.
  const off = repo(t);
  off.record(5, roundLimit);
  const make = teamForge();
  assert.match(offerWaiver(capped('round_limit'), off.project(), config, seams(make({}))).why, /this machine has not opted in/u);
  assert.equal(make.calls.length, 0, 'no forge read');
});

test('aidrian pr extend --verdict land at the check: stops it, the cap stands, and the waive aidrian pr waive records lets the merge guard merge', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  const { code, out } = await extend(t, r, ['--verdict', 'land', '--reason', 'R2-1 is acceptable_as_is at src/a.js:3', '--head', HEAD, '--judge', JUDGE.judge_id]);
  assert.equal(code, 0);
  assert.deepEqual({ ...out.waiver, at: null }, { head: HEAD, kind: 'round_cap', verdict: 'waive', reason: 'R2-1 is acceptable_as_is at src/a.js:3', judge: 'unknown', ...JUDGE, at: null });
  assert.deepEqual([out.extension.status, out.extension.by], ['stopped', 'judge']);
  assert.match(out.next, new RegExp(`gh pr merge 5 --match-head-commit ${HEAD} --repo acme/notes\`[\\s\\S]*run no review step on this head first`, 'u'), 'the merge names the pull request\'s repository');
  const state = readLocalState(r.project(), 5);
  assert.deepEqual([state.outcome.status, state.outcome.at, state.outcome.cap.head], ['round_limit', T0, HEAD], 'the cap stands, at the time it was reached');
  assert.equal(state.extensions[0].judge.verdict, 'land');
  assert.equal(merge(r, `gh pr merge 5 --squash --match-head-commit ${HEAD}`), null, 'no aidrian pr waive call');
  // One judge per head: the gate now says one ruled, and a second land is refused, writing nothing.
  await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'again', '--judge', JUDGE.judge_id]), /a judge already gave its verdict on head abcdef1 \(waive\): one judge rules per head/u);
  assert.equal(readLocalState(r.project(), 5).waivers.length, 1);
});

test('aidrian pr extend --verdict land is refused whenever the gate refuses, and writes nothing', async (t) => {
  const r = repo(t, { local: ON });
  const before = (edit) => (r.record(5, edit), JSON.stringify(readLocalState(r.project(), 5)));
  for (const [name, edit, options, pattern] of [
    ['a high finding', (state) => (atCheck(state), (state.index = { 'R1-1': openFinding('R1-1', { severity: 'high' }) })), {}, /may not land #5: finding R1-1 is high/u],
    ['a security finding', (state) => atCheck(state, HEAD, { items: [{ id: 'R2-1', severity: 'low', stage: 'local', reviewer: 'agent:security-engineer', pass: 'self:0' }], counted: 1 }), {}, /finding R2-1 is a security finding/u],
    ['the bot has not passed the head', atCheck, { forge: landForge(r, { bot: false }) }, /a verdict never stands in for the review bot/u],
    ['the team does not allow it', atCheck, { forge: landForge(r, { policy: REFUSE }) }, /the team does not allow it/u],
    ['a host that does not confirm a judge', atCheck, { runHost: { name: 'codex', capabilities: {} } }, /does not confirm a judge's dispatch/u],
    ['a flow left unsigned', (state) => atCheck(state, HEAD, { flows: ['payments'] }), {}, /flow payments has an invariant violated, unverified, or unsigned/u],
    ['a head pushed after the cap', atCheck, { forge: landForge(r, { head: NEXT }) }, /the check was for abcdef1, and the pull request is at 1234567 now/u],
    ['a received review', received, {}, /the review of head abcdef1 is received: a verdict covers only round_limit/u],
  ]) {
    const kept = before(edit);
    await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id], options), pattern, name);
    assert.equal(JSON.stringify(readLocalState(r.project(), 5)), kept, `${name}: nothing written`);
  }
  // A judge the dispatch log does not show: the gate passes, and the writer `aidrian pr waive` uses refuses.
  const kept = before(atCheck);
  await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', 'judge-9']), /the dispatch log holds no dispatch of the code-reviewer judge-9/u);
  assert.equal(JSON.stringify(readLocalState(r.project(), 5)), kept);
});

// ---- the unattended rule at the cap: a red flag under "auto" and the waiver stops with no question (issue 260)

// A check at the cap under github.extraRounds `mode`, whose round history raised a red flag.
const atFlaggedCheck = (mode) => (state) => {
  atCheck(state);
  Object.assign(state.extensions[0], { mode, red_flags: ['looping: R2-1 came back at src/a.js:3 after its fix in round 2'] });
};
const EXTEND_OVER_FLAG = ['--verdict', 'extend', '--reason', 'R2-1 at src/a.js:3 is a valid medium finding', '--head', HEAD];
// The review step at the cap after the verdict, as it reads this machine's record: no history is read on a decided head.
const stepAfter = (r, mode) => atCap({ state: readLocalState(r.project(), 5), source: 'plan', round: 2, head: HEAD, policy: { mode, max: 2 }, pr: 5, repo: 'acme/notes', history: () => assert.fail('no history read') });

test('the unattended rule: under "auto" with the waiver counting, an extend over a red flag is round_limit, never extension_ask, and says why', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atFlaggedCheck('auto'));
  const { code, out } = await extend(t, r, EXTEND_OVER_FLAG);
  assert.equal(code, 0);
  assert.deepEqual([out.extension.status, out.extension.by], ['stopped', 'unattended']);
  assert.equal(out.extension.reasons[0], 'R2-1 at src/a.js:3 is a valid medium finding', 'the judge\'s evidence is kept');
  assert.match(out.extension.reasons[1], /^red flags \(looping\) stand under github\.extraRounds "auto" and the unattended waiver, so the cap stands with no extra round and no question to the Human$/u);
  assert.match(out.next, /^the cap stands on a red flag under the unattended rule: run aidrian pr review 5\b.*, which reports round_limit/u);
  const step = stepAfter(r, 'auto');
  assert.deepEqual([step.status, step.extension.status, step.extension.by], ['round_limit', 'stopped', 'unattended']);
  // The summary comment names the rule and the flags on any repository, and the reasons where the copy holds them.
  assert.match(summaryBody(readLocalState(r.project(), 5), null, 'round_limit'), /\n- round 2 on `abcdef1`: stopped by the unattended rule \(over red flags: looping\)\n/u);
  assert.match(summaryBody(readLocalState(r.project(), 5), null, 'round_limit', { reading: { visibility: 'PRIVATE', inside: true } }), /- round 2 on `abcdef1`: stopped by the unattended rule: R2-1 at src\/a\.js:3 is a valid medium finding; red flags \(looping\) stand under github\.extraRounds "auto" and the unattended waiver[^\n]*\(over red flags: looping\)/u);
});

test('the unattended rule: with either switch off, or the team switch only in the working copy, an extend over a red flag still asks the Human', async (t) => {
  for (const [name, options, forge] of [
    ['the team does not allow it on the forge, though the working copy does', { local: ON, config: { github: { unattendedWaiver: { allow: true } } } }, (r) => landForge(r, { policy: REFUSE })],
    ['this machine has not opted in', {}, (r) => landForge(r)],
  ]) {
    const r = repo(t, options);
    r.record(5, atFlaggedCheck('auto'));
    const { code, out } = await extend(t, r, EXTEND_OVER_FLAG, { forge: forge(r) });
    assert.deepEqual([code, out.extension.status, out.extension.by], [0, 'asking', 'judge'], name);
    const step = stepAfter(r, 'auto');
    assert.equal(step.status, 'extension_ask', name);
    assert.match(step.question, /The round history raised red flags \(looping\), and the judge still recommends one more round/u, name);
  }
});

test('the unattended rule: under "ask", an extend over a red flag asks the Human with the waiver on, and reads no switch', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atFlaggedCheck('ask'));
  const forge = landForge(r);
  const { code, out } = await extend(t, r, EXTEND_OVER_FLAG, { forge });
  assert.deepEqual([code, out.extension.status, out.extension.by], [0, 'asking', 'judge']);
  assert.equal(stepAfter(r, 'ask').status, 'extension_ask');
  assert.equal(forge.calls.filter(([call]) => call === 'repository' || call === 'contents').length, 0, 'no policy read for the switch');
});

// The words of one command line as a shell reads them: single- and double-quoted parts kept whole.
const words = (line) => [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)].map((m) => m[1] ?? m[2] ?? m[3]);

test('every verdict runs as the record line the step prints says: extend with record_extend, land and stop with record and --judge', async (t) => {
  const r = repo(t, { local: ON });
  // The step's own check at the cap, with land offered: its dispatch as atCap builds it and offerLand changes it.
  const built = emptyState(5, 'acme/notes');
  atCheck(built);
  const result = atCap({ state: built, source: 'plan', round: 2, head: HEAD, policy: { mode: 'ask', max: 2 }, pr: 5, history: () => ({ rounds: [{ round: 1, head: HEAD, open: 1, findings: [] }], originalFiles: null, files: null }) });
  assert.equal(result.status, 'extension_check');
  const [judge] = offerLand({ ...result, pr: 5, head: HEAD }, { may: true, why: null }).dispatch;
  const run = (line, verdict) => {
    const filled = line.replace('land|stop', verdict).replace('<evidence>', 'R2-1 is acceptable_as_is at src/a.js:3').replace('<agent id>', JUDGE.judge_id);
    const [cli, pr, action, ...args] = words(filled);
    assert.deepEqual([cli, pr, action, args[0]], ['aidrian', 'pr', 'extend', '5']);
    return extend(t, r, args.slice(1));
  };
  for (const [verdict, line, status, waived] of [['extend', judge.record_extend, 'asking', null], ['land', judge.record, 'stopped', 'waive'], ['stop', judge.record, 'stopped', 'refuse']]) {
    r.record(5, atCheck);
    const { code, out } = await run(line, verdict);
    assert.deepEqual([code, out.extension.status, out.waiver?.verdict ?? null], [0, status, waived], verdict);
  }
});

test('aidrian pr extend --verdict land is refused when the record file changed after the read it was built from', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  // The pull request's summary comment holds a newer copy, so the record is built on it, and the forge's reading of
  // the repository, which that choice asks for after this machine's file was read, is when another write lands.
  const copy = emptyState(5, 'acme/notes');
  atCheck(copy);
  copy.revision = 50;
  const comments = [{ id: 1, user: { login: 'someone' }, author_association: 'MEMBER', body: summaryBody(copy, null, 'extension_check', { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } }) }];
  let wrote = false;
  const visibility = () => {
    if (!wrote) {
      wrote = true;
      const current = readLocalState(r.project(), 5);
      current.note = 'written between the reads';
      writeLocalState(r.project(), current);
    }
    return 'PRIVATE';
  };
  await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id], { forge: landForge(r, { comments, visibility }) }), /the review record of #5 changed while the verdict was recorded: run again/u);
  assert.ok(wrote, 'the write came between the read and the verdict');
  const kept = readLocalState(r.project(), 5);
  assert.deepEqual([kept.note, kept.waivers, kept.extensions[0].status], ['written between the reads', undefined, 'judging'], 'that write stands, and nothing was recorded over it');
});

test('aidrian pr extend --verdict land weighs the reviews another record file owes for the pull request: one owed refuses, writing nothing', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  // A record of the same number, written before records were keyed by repository, owes a review of acme/notes#5.
  const other = emptyState(5, 'other/notes');
  other.pending = [{ id: 'owed-1', kind: 'review', head: HEAD, at: T0, by: 'someone', repo: 'acme/notes' }];
  writeLocalState(r.project(), other, { repo: 'other/notes' });
  const before = JSON.stringify(readLocalState(r.project(), 5, 'acme/notes'));
  await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id]), /may not land #5: 1 review entry is still owed on #5: a verdict never covers an owed review/u);
  assert.equal(JSON.stringify(readLocalState(r.project(), 5, 'acme/notes')), before, 'nothing written');
});

test('a record newer than the file on disk that holds the owed review answered lands: the entry is counted once, as that record holds it', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, atCheck);
  const owing = { id: 'owed-1', kind: 'review', head: HEAD, at: T0, by: 'someone', repo: 'acme/notes' };
  const other = emptyState(5, 'other/notes');
  other.pending = [owing];
  writeLocalState(r.project(), other, { repo: 'other/notes' });
  // The summary comment's copy is newer than this machine's file, and holds that review answered.
  const copy = emptyState(5, 'acme/notes');
  atCheck(copy);
  copy.revision = 50;
  copy.pending = [{ ...owing, answered: { at: '2026-11-03T14:10:00.000Z', head: HEAD, by: 'received' } }];
  const comments = [{ id: 1, user: { login: 'someone' }, author_association: 'MEMBER', body: summaryBody(copy, null, 'extension_check', { reading: { visibility: 'PRIVATE', inside: true }, checker: { allows: () => true } }) }];
  const { code, out } = await extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id], { forge: landForge(r, { comments }) });
  assert.deepEqual([code, out.waiver.verdict], [0, 'waive']);
  // The record the write kept holds that review once, answered, as the gate weighed it: one merge for both.
  const kept = readLocalState(r.project(), 5, 'acme/notes');
  assert.deepEqual(kept.pending.filter((entry) => entry.id === 'owed-1').map((entry) => Boolean(entry.answered)), [true]);
  assert.deepEqual([owed(kept), owed(adoptedCopy(r.project(), kept))], [[], []]);
});

test('a record whose pending is no list, or that names no repository, never throws in the merge guard or the gate', async (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const gateOf = (each) => readGate({ pr: 5 }, each.project(), { forge: gateForge(), run: () => undefined, runHost: CONFIRMS });
  // Its own record's pending, and another repository's record of the same number, hold an object, not a list.
  r.record(5, (state) => (roundLimit(state), (state.pending = {})));
  const other = emptyState(5, 'other/notes');
  writeLocalState(r.project(), other, { repo: 'other/notes' });
  const file = readLocalState(r.project(), 5, 'other/notes');
  writeLocalState(r.project(), Object.assign(file, { pending: {} }), { repo: 'other/notes' });
  assert.equal(typeof (merge(r, command) ?? ''), 'string');
  assert.deepEqual(gateOf(r), { code: 0, may: true, why: null, head: HEAD, repo: 'acme/notes', base: 'main' }, 'a pending that is no list owes nothing');
  // A record that names no repository.
  const unnamed = repo(t, { local: ON });
  const state = emptyState(5, null);
  roundLimit(state);
  writeLocalState(unnamed.project(), state);
  assert.equal(typeof (merge(unnamed, command) ?? ''), 'string');
  assert.equal(adoptedCopy(unnamed.project(), state), state, 'no repository: nothing is looked up');
  assert.deepEqual(gateOf(unnamed), { code: 0, may: true, why: null, head: HEAD, repo: 'acme/notes', base: 'main' }, 'the gate names it for the pull request\'s repository, as the writer does');
  // A record that names another repository than the pull request's is refused, with the reason the writer gives.
  const mismatch = readGate({ pr: 5 }, unnamed.project(), { forge: gateForge(), run: () => undefined, runHost: CONFIRMS, record: () => ({ ...state, repo: 'other/notes' }) });
  assert.deepEqual([mismatch.code, mismatch.may], [1, false]);
  assert.match(mismatch.why, /the review record of #5 this command built is other\/notes's, not acme\/notes's/u);
});

test('an origin record that names no repository weighs the reviews another record owes, as its write would: land refused, nothing written', async (t) => {
  const r = repo(t, { local: ON });
  const legacy = emptyState(5, null);
  atCheck(legacy);
  writeLocalState(r.project(), legacy);
  const other = emptyState(5, 'other/notes');
  other.pending = [{ id: 'owed-1', kind: 'review', head: HEAD, at: T0, by: 'someone', repo: 'acme/notes' }];
  writeLocalState(r.project(), other, { repo: 'other/notes' });
  const before = JSON.stringify(readLocalState(r.project(), 5, 'acme/notes'));
  assert.equal(JSON.parse(before).repo ?? null, null, 'the record names no repository');
  await assert.rejects(extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--judge', JUDGE.judge_id]), /may not land #5: 1 review entry is still owed on #5/u);
  assert.equal(JSON.stringify(readLocalState(r.project(), 5, 'acme/notes')), before, 'nothing written');
});

test('at a round_limit with no check, the judge it dispatched lands with one extend call, and its stop records the refuse', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const landed = await extend(t, r, ['--verdict', 'land', '--reason', 'nits', '--head', HEAD, '--judge', JUDGE.judge_id]);
  assert.deepEqual([landed.code, landed.out.extension, landed.out.waiver.verdict], [0, null, 'waive']);
  assert.equal(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`), null);
  // Its stop is the waiver's refuse, so no second judge rules on the head, and the guard keeps its denial.
  r.record(5, roundLimit);
  const stopped = await extend(t, r, ['--verdict', 'stop', '--reason', 'R2-1 is a real fix_now', '--judge', JUDGE.judge_id]);
  assert.deepEqual([stopped.code, stopped.out.waiver.verdict], [0, 'refuse']);
  assert.match(stopped.out.next, /the cap stands: report round_limit/u);
  assert.match(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`) ?? '', /stopped at its round limit/u);
  const config = loadConfig(r.project()).config;
  const after = offerWaiver({ status: 'round_limit', pr: 5, repo: 'acme/notes', head: HEAD }, r.project(), config, { forge: gateForge(), run: () => undefined, runHost: CONFIRMS });
  assert.match(after.why, /a judge already gave its verdict on head abcdef1 \(refuse\)/u);
});

// ---- the config guard and aidrian check (AC12)

test('a subagent may not set the waiver switch in the local file; the main session may', async (t) => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const r = repo(t);
  // The hook called in this process, as the host runs its script; `call` spawned starts the script as its own program.
  const spawned = (script, options) => spawnSync(process.execPath, [script], options);
  const run = (input, call = hookCall) => call(GATES_HOOK, { input: JSON.stringify(input), cwd: r.dir, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state } });
  const subagent = (tool, toolInput) => ({ tool_name: tool, tool_input: toolInput, agent_type: 'aidrian:explorer', agent_id: 'a5f0c1', cwd: r.dir });
  const on = JSON.stringify({ github: { unattendedWaiver: 'on' } });
  for (const [tool, toolInput] of [
    ['Write', { file_path: LOCAL, content: on }],
    ['Write', { file_path: path.join(r.dir, LOCAL), content: JSON.stringify(ON) }],
    ['Edit', { file_path: LOCAL, old_string: '"off"', new_string: '"unattendedWaiver": "on"' }],
    ['Bash', { command: `echo '${on}' > ${LOCAL}` }],
  ]) {
    const result = await run(subagent(tool, toolInput));
    assert.equal(result.status, 2, JSON.stringify(toolInput));
    assert.match(result.stderr, /github\.unattendedWaiver/u);
    assert.match(result.stderr, /only the main session may let a recorded judge verdict waive the merge guard/u);
  }
  // apply_patch is not applied here: a changed line that names the key, or a value on its own line, is the switch.
  const patch = (...lines) => `*** Begin Patch\n*** Update File: ${LOCAL}\n@@\n${lines.join('\n')}\n*** End Patch\n`;
  for (const [name, text] of [
    ['the key on the changed line', patch('-    "unattendedWaiver": { "enabled": false }', '+    "unattendedWaiver": { "enabled": true }')],
    ['the value on its own line, the key as context', patch('   "github": {', '     "unattendedWaiver": {', '-      "enabled": false', '+      "enabled": true')],
    ['auto-merge\'s value on its own line', patch('     "autoMerge": {', '-      "enabled" : false', '+      "enabled" : true')],
  ]) {
    const input = subagent('apply_patch', { command: text });
    assert.ok(machineSwitchWriteDenial(input, findProject(r.dir), { names: { human: 'the owner' } }), name);
    assert.equal((await run(input)).status, 2, name);
  }
  assert.equal(machineSwitchWriteDenial(subagent('apply_patch', { command: patch('-  "names": {}', '+  "names": { "human": "x" }') }), findProject(r.dir), { names: { human: 'x' } }), null, 'another key');
  assert.equal((await run(subagent('Write', { file_path: LOCAL, content: JSON.stringify({ names: { human: 'x' } }) }))).status, 0, 'other local writes run');
  const { agent_id: _id, agent_type: _type, ...main } = subagent('Write', { file_path: LOCAL, content: on });
  assert.equal((await run(main, spawned)).status, 0, 'the main session may');
});

test('aidrian check warns, and still passes, when the waiver switch is on and the team does not allow it', (t) => {
  const r = repo(t, { local: ON });
  writeFileSync(path.join(r.dir, '.gitignore'), `${LOCAL}\n.worktrees/\n`);
  const aidrianCheck = () => spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['check'], { cwd: r.dir, encoding: 'utf8' });
  const warned = aidrianCheck();
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /^warning: unattended waiver is on locally but the team does not allow it$/mu);
  writeFileSync(path.join(r.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' }, github: { unattendedWaiver: { allow: true } } }));
  const allowed = aidrianCheck();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /unattended waiver/u, 'allowed by the team: nothing to say');
});

test('the posted copy keeps no judge id, session, or cap cause, on a private repository too; a refusal prints neither id unless it has its shape', (t) => {
  const state = emptyState(5, 'acme/notes');
  roundLimit(state);
  waiver(state);
  Object.assign(state.waivers[0], { judge_id: 'judge-1', session: '0b7c1d9e-1111-4222-8333-444455556666' });
  for (const visibility of ['PRIVATE', 'PUBLIC']) {
    const { copy } = postedCopy(state, { reading: { visibility, inside: true } });
    assert.ok(copy.waivers.every((entry) => !('judge_id' in entry) && !('session' in entry)), visibility);
    assert.equal(copy.outcome?.cap, undefined, visibility);
  }
  assert.ok(state.waivers[0].judge_id && state.outcome.cap, 'the local record keeps both');
  const project = repo(t).project();
  const why = judgeProblem({ project, config: loadConfig(project).config, state, entry: { ...state.waivers[0], judge_id: '<script>', session: 'x y' } });
  assert.match(why ?? '', /no dispatch of the code-reviewer \(an id of no known shape\) by session \(an id of no known shape\)/u);
});

test('parallel issues of a run that each count the budget below its most: the merge guard takes the last waived merge for one, under the ledger lock, and refuses the other', async (t) => {
  const fx = runFixture(t);
  const { owner, name } = fx.run().init.repository;
  const r = repo(t, { local: ON });
  for (const n of [1, 2]) {
    const state = emptyState(n, `${owner}/${name}`);
    roundLimit(state);
    waiver(state);
    writeLocalState(r.project(), state);
  }
  appendToRun(fx.state, 'launch', () => ({ rows: [1, 2].map((pr) => ({ event: 'result', key: 'WID-1', attempt: 1, session: 'child', via: 'drop', status: 'merged', pr, verified: true, at: new Date().toISOString() })) }));
  for (const n of [5, 7]) r.record(n, (state) => (roundLimit(state), waiver(state)));
  const project = r.project();
  const memo = () => ({ run: 'launch', home: fx.project });
  const merge = (pr) => guardWaiver({ project, state: readLocalState(project, pr), pr, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: () => 0, memo: memo() });
  // Before either merge, each counts two of three spent: each may merge, as its gate and auto-merge read it.
  for (const pr of [5, 7]) assert.equal(budgetProblem({ project, home: fx.project, config: fx.config, run: 'launch', pr }), null, `#${pr}`);
  const first = merge(5);
  assert.deepEqual([first.allow, first.note, first.route], [true, '', '']);
  assert.equal(fx.rows().filter((row) => row.event === 'waived').length, 0, 'nothing is taken before the merge guard\'s every check passed');
  assert.equal(first.take(), null, 'taken once they did');
  const second = merge(7);
  assert.equal(second.allow, false);
  assert.match(second.route, /A judge's verdict cannot stand for this head: project run launch merged 3 pull requests on a judge's verdict already, its most \(3\)/u);
  assert.deepEqual(fx.rows().filter((row) => row.event === 'waived').map((row) => [row.pr, row.head]), [[5, HEAD]], 'the take is in the ledger, once');
  const retry = merge(5);
  assert.deepEqual([retry.allow, retry.take()], [true, null], 'the same pull request merged again, as a retry, takes nothing more');
  assert.equal(fx.rows().filter((row) => row.event === 'waived').length, 1);
  assert.match(budgetProblem({ project, home: fx.project, config: fx.config, run: 'launch', pr: 7 }) ?? '', /its most \(3\)/u, 'the read-only count sees the take too');
  // A ledger another process holds locked refuses the take: no merge on a budget it could not count.
  const ledger = path.join(fx.state, 'runs', 'launch', 'ledger.jsonl');
  const jsonl = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/jsonl.mjs');
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { withLocks } from ${JSON.stringify(jsonl)}; withLocks([${JSON.stringify(ledger)}], () => { process.stdout.write('held\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000); });`], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const locked = takeWaivedMerge({ project, home: fx.project, config: fx.config, run: 'launch', pr: 9, head: HEAD, waitMs: 0 });
  assert.match(locked ?? '', /could not be locked or written to take this merge from its budget/u);
});

test('the guard reads the sign-off store and the run`s budget only with time left: past the deadline it is the unread denial, and the hook ends inside 5 s', async (t) => {
  const fx = runFixture(t);
  const { owner, name } = fx.run().init.repository;
  const r = repo(t, { local: ON });
  // Five merged pull requests of the run, each on a verdict, kept in this checkout's records; the run's ledger lives only
  // in the main checkout `fx`, whose config names its state folder.
  for (const n of [1, 2, 3, 4, 6]) {
    const state = emptyState(n, `${owner}/${name}`);
    roundLimit(state);
    waiver(state);
    writeLocalState(r.project(), state);
  }
  appendToRun(fx.state, 'launch', () => ({ rows: [1, 2, 3, 4, 6].map((pr) => ({ event: 'result', key: 'WID-1', attempt: 1, session: 'child', via: 'drop', status: 'merged', pr, verified: true, at: new Date().toISOString() })) }));
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const project = r.project();
  const state = readLocalState(project, 5);
  const memo = () => ({ run: 'launch', home: fx.project });
  // Read through the main checkout: the budget is spent, counted no further than its most.
  const spent = guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: () => 0, memo: memo() });
  assert.match(spent.route, /A judge's verdict cannot stand for this head: project run launch merged 3 pull requests on a judge's verdict already, its most \(3\)/u);
  // The view and the trail end past the deadline: neither the store nor the ledger is read, and the denial is unread.
  const clock = { now: 0 };
  const late = guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(undefined, { clock, tick: 2100 }), startedAt: 0, now: () => clock.now, memo: memo() });
  assert.deepEqual([late.allow, late.note, late.route], [false, ', and the team\'s github.unattendedWaiver could not be read in time', '']);
  // A sign-off owed is not even read past it: the denial is still the unread one, not the store's.
  const owing = { ...state, signoffable: { head: HEAD, flows: ['payments'] } };
  const lateClock = { now: 0 };
  const lateOwed = guardWaiver({ project, state: owing, pr: 5, head: HEAD, named: true, forge: teamForge(undefined, { clock: lateClock, tick: 2100 }), startedAt: 0, now: () => lateClock.now, memo: memo() });
  assert.deepEqual([lateOwed.note, lateOwed.route], [', and the team\'s github.unattendedWaiver could not be read in time', '']);
  // The deadline passes while the run's records are counted: the count stops, and the verdict cannot stand.
  let calls = 0;
  guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: () => ((calls += 1), 0), memo: { home: fx.project } });
  const before = calls;
  let seen = 0;
  const started = Date.now();
  const counted = guardWaiver({ project, state, pr: 5, head: HEAD, named: true, forge: teamForge(), startedAt: 0, now: () => ((seen += 1) > before ? WAIVER_DEADLINE_MS + 1 : 0), memo: memo() });
  assert.ok(Date.now() - started < 5000, 'the hook ends inside its 5 s');
  assert.match(counted.route, /A judge's verdict cannot stand for this head: the hook ran out of time counting the project run's waived merges/u);
});
