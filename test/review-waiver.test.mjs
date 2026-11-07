import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { brotliCompressSync } from 'node:zlib';

import { DEFAULTS, loadConfig, resolveUnattendedWaiver } from '../plugins/aidrian/lib/config.mjs';
import { machineSwitchWriteDenial } from '../plugins/aidrian/lib/config-guard.mjs';
import { commands } from '../plugins/aidrian/lib/pr.mjs';
import { findProject, projectAt } from '../plugins/aidrian/lib/project.mjs';
import { emptyState, owed, readLocalState, refreshSummary, stateFromComment, summaryBody, WAIVER_HEADING, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { guardWaiver, MAX_REASON, parseWaive, runWaive, WAIVER_DEADLINE_MS, waiverFor, waiverKind } from '../plugins/aidrian/lib/review/waiver.mjs';
import { check, checkMcp, UNREAD_REASON } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATES_HOOK = path.join(ROOT, 'plugins/aidrian/scripts/hook-agent-gates.mjs');
const LOCAL = '.aidrian.local.json';
const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const NEXT = '1234567890abcdef1234567890abcdef12345678';
const URL = 'https://github.com/Acme/Notes/pull/5';
const T0 = '2026-11-03T14:00:00.000Z';
const ALLOW = { version: 1, github: { unattendedWaiver: { allow: true } } };

// A git repository of its own (never GIT_DIR, never a real repository) with an origin and one commit, holding a project
// whose state folder is inside it, a transcript file, and an untracked local file when `local` is given. It also holds
// three commits no ref names: `A`, `B` a child of A, and `C` a sibling of A, so a moved head can descend or not.
function repo(t, { config = {}, local = null } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-waiver-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const id = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:Acme/Notes.git');
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, ...config }));
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
  const record = (pr, edit) => {
    const state = emptyState(pr, 'acme/notes');
    edit(state);
    writeLocalState(projectAt(dir), state);
  };
  return { dir, git, transcript, record, project: () => projectAt(dir), A, B, C };
}

const ON = { github: { unattendedWaiver: { enabled: true } } };
const encode = (value) => ({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

// The waiver's forge seam, budgetedForge's `make`: the pull request is on `base` at `head`, the default branch is `main`,
// and `branches` maps a branch to its config.json. Every call is counted with the options it was built with, so a test can
// say none was made, or what each was bounded at. `tick` is how long each call takes on a test clock.
function teamForge(branches = { main: ALLOW }, { base = 'main', head = HEAD, view = {}, clock = null, tick = 0 } = {}) {
  const calls = [];
  const options = [];
  const step = () => clock && (clock.now += tick);
  const facade = {
    change: (ref, fields, given) => (calls.push(['change', ref, fields, given?.repo ?? null]), step(), { number: Number(ref), headRefOid: head, baseRefName: base, url: URL, ...view }),
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

const roundLimit = (state, head = HEAD) => (state.outcome = { status: 'round_limit', head, at: T0 });
const received = (state, head = HEAD) => (state.outcome = { status: 'received', head, at: T0 });
const waiver = (state, { head = HEAD, kind = 'round_cap', verdict = 'waive', at = '2026-11-03T15:00:00.000Z', reason = 'every open finding is a nit' } = {}) =>
  (state.waivers = [...(state.waivers ?? []), { head, kind, verdict, reason, judge: 'code-reviewer', at }]);

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
  // One wrong key turns both switches off, and its error prints once.
  writeFileSync(local, JSON.stringify({ github: { autoMerge: 'on', unattendedWaiver: 'on', strategy: 'squash' } }));
  const broken = findProject(r.dir);
  assert.deepEqual([broken.localAutoMerge, broken.localUnattendedWaiver], ['off', 'off']);
  assert.deepEqual(broken.errors, [`${LOCAL}: unknown key "github.strategy"; only "github.autoMerge" and "github.unattendedWaiver" are machine settings`]);
  writeFileSync(local, '{ not json');
  assert.equal(findProject(r.dir).localUnattendedWaiver, 'off', 'unparsable');
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
// `change` replaces the head read, which runs between the record's read and its write.
function waive(t, r, args, { head = HEAD, change = null, issue = [], record = 'comment' } = {}) {
  const log = t.mock.method(console, 'log', () => {});
  const forge = {
    change: change ?? ((ref, fields) => (assert.equal(fields, 'number,headRefOid,url'), { number: Number(ref), headRefOid: head, url: URL })),
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
  assert.match(out.next, /gh pr merge 5 --match-head-commit abcdef1234567890/u);
  assert.equal(readLocalState(r.project(), 5).waivers.length, 1);
  assert.equal(issue.length, 1, 'posted the summary comment');
  assert.equal(stateFromComment(issue[0].body, 5).waivers[0].head, HEAD, 'the comment carries the record');
  assert.match(issue[0].body, new RegExp(`${WAIVER_HEADING.replace(/\*/gu, '\\*')}\\n- round_cap on \`abcdef1\`: waive by unknown: the three open findings are style nits \\(an audit entry, not proof\\)`, 'u'));
});

test('a second verdict rewrites the waiver list in the summary comment, not a second one', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, roundLimit);
  const issue = [{ id: 1, user: { login: 'someone' }, author_association: 'MEMBER', body: summaryBody(readLocalState(r.project(), 5), null, 'round_limit') }];
  for (const verdict of ['refuse', 'waive']) assert.equal((await waive(t, r, ['--verdict', verdict, '--reason', `judged ${verdict}`], { issue })).code, 0);
  assert.equal(issue.length, 1, 'edited, not posted');
  assert.equal(issue[0].body.split(WAIVER_HEADING).length, 2, 'one heading');
  assert.match(issue[0].body, /: refuse by unknown: judged refuse[^\n]*\n- round_cap on `abcdef1`: waive by unknown: judged waive/u);
});

test('aidrian pr waive records moved_head only for a head that descends from the reviewed one', async (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => received(state, r.A));
  const { out } = await waive(t, r, ['--verdict', 'waive', '--reason', 'the push only renames a local', '--head', r.B.slice(0, 7)], { head: r.B });
  assert.equal(out.waiver.kind, 'moved_head');
  assert.equal(out.waiver.head, r.B, 'the full current head, whatever --head spelled');
  await assert.rejects(waive(t, r, ['--verdict', 'waive', '--reason', 'x'], { head: r.C }), /head [0-9a-f]{7} does not descend from [0-9a-f]{7}, the head the last review step covered: a rewritten history needs a review/u, 'a force-push');
  await assert.rejects(waive(t, r, ['--verdict', 'waive', '--reason', 'x'], { head: NEXT }), /git cannot tell whether head 1234567 descends from/u, 'a head the checkout lacks');
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
    ['fix_required on the head', (state) => (state.outcome = { status: 'fix_required', head: HEAD, at: T0 }), {}, /is fix_required: a verdict covers only round_limit/u],
    ['blocked_quota on the head', (state) => (state.outcome = { status: 'blocked_quota', head: HEAD, at: T0 }), {}, /is blocked_quota/u],
    ['received on the head', (state) => received(state), {}, /is received/u],
    ['a moved head past an error', (state) => (state.outcome = { status: 'error', head: NEXT, at: T0 }), {}, /covered 1234567 and is error/u],
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
  assert.match(commands.pr.usage, /\| waive PR --verdict waive\|refuse --reason TEXT \[--head SHA\] \|/u);
});

// ---- the guard (AC8, AC9, AC10)

test('both switches on and a waive entry: the merge guard lets round_limit and a descending moved head merge', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const forge = teamForge();
  assert.equal(merge(r, `gh pr merge 5 --squash --match-head-commit ${HEAD}`, { forge }), null, 'round cap');
  assert.deepEqual(forge.calls.map(([name, , file, ref]) => (name === 'contents' ? [name, file, ref] : [name])), [
    ['change'],
    ['repository'],
    ['contents', '.aidrian.json', 'refs/heads/main'],
    ['contents', '.aidrian/config.json', 'refs/heads/main'],
  ], 'the view, then the default branch, which is the base: read once');
  assert.ok(forge.calls.slice(1).every((call) => call.at(-1) === 'github.com'), 'every team read names the pull request\'s host');
  assert.ok(forge.options.every((each) => each.killSignal === 'SIGKILL' && Number.isInteger(each.timeoutMs)), 'every call is bounded and killed');
  const moved = repo(t, { local: ON });
  moved.record(5, (state) => (received(state, moved.A), waiver(state, { head: moved.B, kind: 'moved_head' })));
  assert.equal(merge(moved, `gh pr merge 5 --squash --match-head-commit ${moved.B}`, { forge: teamForge(undefined, { head: moved.B }) }), null, 'moved head');
  assert.equal(merge(moved, `gh api -X PUT repos/acme/notes/pulls/5/merge -f sha=${moved.B}`, { forge: teamForge(undefined, { head: moved.B }) }), null, 'gh api naming the head');
  // The MCP merge tool takes it the same way.
  assert.equal(checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5, sha: HEAD }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([]), waiverForge: teamForge() }), null);
});

test('a head that does not descend from the reviewed one, such as a force-push, is no moved head: denied, nothing read', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (received(state, r.A), waiver(state, { head: r.C, kind: 'moved_head' })));
  const forge = teamForge(undefined, { head: r.C });
  const reason = merge(r, `gh pr merge 5 --match-head-commit ${r.C}`, { forge });
  assert.match(reason ?? '', /the last review step covered [0-9a-f]{7}, not head [0-9a-f]{7}/u);
  assert.doesNotMatch(reason, /aidrian pr waive|could not be read/u);
  assert.deepEqual(forge.calls, []);
});

test('a verdict counts only for a merge that names its head', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  for (const command of ['gh pr merge 5 --squash', 'gh api -X PUT repos/acme/notes/pulls/5/merge']) {
    const reason = merge(r, command);
    assert.match(reason ?? '', /is `round_limit`/u, command);
    assert.match(reason, /A judge's recorded verdict waives this head, but only for a merge that names it: merge with `gh pr merge 5 --match-head-commit abcdef1234567890abcdef1234567890abcdef12`, or give the merge tool its `sha`\.$/u, command);
  }
  const mcp = checkMcp({ owner: 'acme', repo: 'notes', pullNumber: 5 }, { cwd: r.dir, input: { transcript_path: r.transcript }, viewPr: viewer([]), waiverForge: teamForge() });
  assert.match(mcp ?? '', /only for a merge that names it/u, 'the MCP tool without sha');
});

test('without a verdict that stands for this head and kind, the denial is today\'s, plus the route under both switches', (t) => {
  const r = repo(t, { local: ON });
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const route = /Or the Human merges in their own shell\. Or an unattended run records the judge's verdict with `aidrian pr waive 5 --verdict waive\|refuse --reason "<evidence>" --head abcdef1234567890abcdef1234567890abcdef12`, which this repository allows \(github\.unattendedWaiver\), then merges naming that head\.$/u;
  for (const [name, edit] of [
    ['no entry', (state) => roundLimit(state)],
    ['an entry for another head', (state) => (roundLimit(state), waiver(state, { head: NEXT }))],
    ['an entry of the other kind', (state) => (roundLimit(state), waiver(state, { kind: 'moved_head' }))],
    ['a refuse verdict', (state) => (roundLimit(state), waiver(state, { verdict: 'refuse' }))],
    ['a refuse after a waive', (state) => (roundLimit(state), waiver(state), waiver(state, { verdict: 'refuse' }))],
    ['a verdict older than the outcome', (state) => (roundLimit(state), waiver(state, { at: '2026-11-03T13:00:00.000Z' }))],
    ['an outcome whose time cannot be read', (state) => (roundLimit(state), (state.outcome.at = 'soon'), waiver(state))],
  ]) {
    r.record(5, edit);
    const reason = merge(r, command);
    assert.match(reason ?? '', /the review of head abcdef1 is `round_limit`: run `aidrian pr review 5`/u, name);
    assert.match(reason, route, name);
  }
  const moved = repo(t, { local: ON });
  moved.record(5, (state) => (received(state, moved.A), waiver(state, { head: moved.A, kind: 'round_cap' })));
  assert.match(merge(moved, `gh pr merge 5 --match-head-commit ${moved.B}`, { forge: teamForge(undefined, { head: moved.B }) }) ?? '', /the last review step covered [0-9a-f]{7}, not head [0-9a-f]{7}.*aidrian pr waive 5/su);
});

test('the local switch off: today\'s denial, no route, and no forge read at all', (t) => {
  for (const local of [null, { github: { unattendedWaiver: 'off' } }]) {
    const r = repo(t, local ? { local } : {});
    r.record(5, (state) => (roundLimit(state), waiver(state)));
    const forge = teamForge();
    const views = [];
    const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge, views });
    assert.match(reason ?? '', /Or the Human merges in their own shell\.$/u);
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
    assert.match(reason ?? '', /Or the Human merges in their own shell\.$/u, name);
    assert.doesNotMatch(reason, /aidrian pr waive|could not be read|recorded verdict/u, name);
  }
  // Allowed on both: the base's config is read after the default branch's.
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const forge = teamForge({ main: ALLOW, release: ALLOW }, { base: 'release' });
  assert.equal(merge(r, `gh pr merge 5 --match-head-commit ${HEAD}`, { forge }), null);
  assert.deepEqual(forge.calls.filter(([name]) => name === 'contents').map((call) => call[3]), ['refs/heads/main', 'refs/heads/main', 'refs/heads/release', 'refs/heads/release']);
});

test('a team it cannot read keeps the denial, and says so', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  const unread = /is `round_limit`: run `aidrian pr review 5` until it returns `received` or `none_needed`, and the team's github\.unattendedWaiver could not be read in time\. Only the Human/u;
  const command = `gh pr merge 5 --match-head-commit ${HEAD}`;
  const failing = Object.assign(() => ({ change: () => ({ number: 5, headRefOid: HEAD, baseRefName: 'main', url: URL }), repository: () => { throw new Error('gh: HTTP 502'); }, contents: () => assert.fail('no read after a failure') }), {});
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
  // Each call takes 1.3 s on the test clock: the view gets 3 s, each read 1 s, the one begun at 3.9 s the 0.1 s left, and
  // none begins at 4 s.
  const clock = { now: 0 };
  const slow = teamForge({ main: ALLOW, release: ALLOW }, { base: 'release', clock, tick: 1300 });
  const project = r.project();
  const out = guardWaiver({ project, state: readLocalState(project, 5), pr: 5, head: HEAD, named: true, forge: slow, startedAt: 0, now: () => clock.now });
  assert.deepEqual([out.allow, out.note], [false, ', and the team\'s github.unattendedWaiver could not be read in time']);
  assert.deepEqual(slow.options.map((each) => each.timeoutMs), [3000, 1000, 1000, 100]);
  assert.ok(clock.now <= WAIVER_DEADLINE_MS + 1300, 'the last call began before the deadline');
  // Two waivable merges in one command: the first spends the time, so the second reads nothing and is denied.
  const shared = { now: 0 };
  const forge = teamForge(undefined, { clock: shared, tick: 600 });
  const reason = merge(r, `gh pr merge 5 --match-head-commit ${HEAD} && gh pr merge 6 --match-head-commit ${NEXT}`, { forge, startedAt: 0, now: () => shared.now });
  assert.match(reason ?? '', /pull request #6 at 1234567, and the review of head 1234567 is `round_limit`.*could not be read in time/su);
  assert.equal(forge.calls.length, 4, 'only the first merge read anything');
  assert.ok(shared.now <= WAIVER_DEADLINE_MS);
});

test('the guard\'s own head lookup shares the deadline: past it, a merge that names no head is refused with no lookup', (t) => {
  const r = repo(t, { local: ON });
  r.record(5, (state) => (roundLimit(state), waiver(state)));
  r.record(6, (state) => roundLimit(state, NEXT));
  // The waived merge's four reads, 1 s each, bring the clock to 4 s; the next merge names no head.
  const clock = { now: 0 };
  const forge = teamForge(undefined, { clock, tick: 1000 });
  const views = [];
  const reason = check(`gh pr merge 5 --match-head-commit ${HEAD} && gh pr merge 6 --squash`, {
    cwd: r.dir, env: {}, input: { transcript_path: r.transcript }, viewPr: viewer(views), waiverForge: forge, startedAt: 0, now: () => clock.now,
  });
  assert.equal(forge.calls.length, 4, 'the first merge was waived');
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

test('waiverKind and waiverFor: the kinds a verdict covers, and the entry that stands', () => {
  const yes = () => true;
  const state = emptyState(5, 'acme/notes');
  assert.equal(waiverKind(state, HEAD, yes), null, 'no outcome');
  roundLimit(state);
  assert.equal(waiverKind(state, HEAD, yes), 'round_cap');
  assert.equal(waiverKind(state, HEAD.slice(0, 7), yes), 'round_cap', 'a short spelling of the head');
  assert.equal(waiverKind(state, NEXT, yes), 'moved_head');
  assert.equal(waiverKind(state, NEXT, () => false), null, 'a head that does not descend');
  assert.equal(waiverKind(state, NEXT, () => null), null, 'a head git cannot place');
  received(state);
  assert.equal(waiverKind(state, HEAD, yes), null, 'a finished review needs no waiver');
  assert.equal(waiverKind(state, NEXT, yes), 'moved_head');
  state.outcome = { status: 'running', head: HEAD, at: T0 };
  assert.equal(waiverKind(state, NEXT, yes), null, 'past a step still running');
  received(state);
  waiver(state, { head: NEXT, kind: 'moved_head' });
  assert.equal(waiverFor(state, NEXT, 'moved_head')?.verdict, 'waive');
  assert.equal(waiverFor(state, NEXT, 'round_cap'), null);
  assert.equal(waiverFor(state, HEAD, 'moved_head'), null);
  state.outcome.at = 'not a time';
  assert.equal(waiverFor(state, NEXT, 'moved_head'), null, 'an outcome time that cannot be read lets none stand');
});

// ---- the config guard and aidrian check (AC12)

test('a subagent may not set the waiver switch in the local file; the main session may', (t) => {
  const state = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-')));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const r = repo(t);
  const run = (input) => spawnSync(process.execPath, [GATES_HOOK], { input: JSON.stringify(input), cwd: r.dir, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: state } });
  const subagent = (tool, toolInput) => ({ tool_name: tool, tool_input: toolInput, agent_type: 'aidrian:explorer', agent_id: 'a5f0c1', cwd: r.dir });
  const on = JSON.stringify({ github: { unattendedWaiver: 'on' } });
  for (const [tool, toolInput] of [
    ['Write', { file_path: LOCAL, content: on }],
    ['Write', { file_path: path.join(r.dir, LOCAL), content: JSON.stringify(ON) }],
    ['Edit', { file_path: LOCAL, old_string: '"off"', new_string: '"unattendedWaiver": "on"' }],
    ['Bash', { command: `echo '${on}' > ${LOCAL}` }],
  ]) {
    const result = run(subagent(tool, toolInput));
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
    assert.equal(run(input).status, 2, name);
  }
  assert.equal(machineSwitchWriteDenial(subagent('apply_patch', { command: patch('-  "names": {}', '+  "names": { "human": "x" }') }), findProject(r.dir), { names: { human: 'x' } }), null, 'another key');
  assert.equal(run(subagent('Write', { file_path: LOCAL, content: JSON.stringify({ names: { human: 'x' } }) })).status, 0, 'other local writes run');
  const { agent_id: _id, agent_type: _type, ...main } = subagent('Write', { file_path: LOCAL, content: on });
  assert.equal(run(main).status, 0, 'the main session may');
});

test('aidrian check warns, and still passes, when the waiver switch is on and the team does not allow it', (t) => {
  const r = repo(t, { local: ON });
  writeFileSync(path.join(r.dir, '.gitignore'), `${LOCAL}\nstate/\n.worktrees/\n`);
  const aidrianCheck = () => spawnSync(path.join(ROOT, 'plugins/aidrian/bin/aidrian'), ['check'], { cwd: r.dir, encoding: 'utf8' });
  const warned = aidrianCheck();
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /^warning: unattended waiver is on locally but the team does not allow it$/mu);
  writeFileSync(path.join(r.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: 'state' }, github: { unattendedWaiver: { allow: true } } }));
  const allowed = aidrianCheck();
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /unattended waiver/u, 'allowed by the team: nothing to say');
});
