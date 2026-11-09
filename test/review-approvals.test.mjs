import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approveLine, approvalsSwitch, matchApprovals, overruleRefusal, readApprovals } from '../plugins/aidrian/lib/review/approvals.mjs';
import { checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { flowState } from '../plugins/aidrian/lib/review/flows.mjs';
import { openProject } from '../plugins/aidrian/lib/project.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/cli.mjs');
const HEAD = 'a'.repeat(40);
const FLOWS = [{ id: 'look', invariants: [{ id: 'matches-design', approvers: ['Amy-Designer'] }, { id: 'keeps-copy' }] }];
const review = (more = {}) => ({ id: 1, state: 'APPROVED', commit_id: HEAD, user: { login: 'amy-designer' }, body: `Looks right.\n${approveLine('look', 'matches-design')}`, html_url: 'https://github.com/o/r/pull/7#pullrequestreview-1', submitted_at: '2026-11-07T10:00:00Z', ...more });
const match = (reviews, viewer = 'session-bot') => matchApprovals(reviews, { head: HEAD, viewer, flows: FLOWS }).map((each) => `${each.flow}/${each.invariant}@${each.login}`);

test('an approval counts only as APPROVED, on the head, by a listed approver who is not the token`s account, naming the invariant', () => {
  assert.deepEqual(match([review()]), ['look/matches-design@amy-designer'], 'a login compares in any case');
  for (const [why, given] of [
    ['a comment-only review', review({ state: 'COMMENTED' })],
    ['a dismissed approval', review({ state: 'DISMISSED' })],
    ['an approval of another commit', review({ commit_id: 'b'.repeat(40) })],
    ['an approver the invariant does not list', review({ user: { login: 'mallory' } })],
    ['no approve line', review({ body: 'Looks right.' })],
    ['an approve line for another invariant, which names no approvers', review({ body: approveLine('look', 'keeps-copy') })],
    ['an approve line inside other text', review({ body: `see ${approveLine('look', 'matches-design')} later` })],
  ]) assert.deepEqual(match([given]), [], why);
  assert.deepEqual(match([review()], 'AMY-DESIGNER'), [], 'the session`s own account never approves');
  assert.deepEqual(match([review()], null), [], 'with the token`s login unknown, nothing counts');
  assert.deepEqual(match([review(), review({ id: 2 })]), ['look/matches-design@amy-designer'], 'one entry per invariant and approver');
});

test('an approval counts only while it is its author`s latest verdict on the head', () => {
  const changes = (more = {}) => review({ id: 9, state: 'CHANGES_REQUESTED', body: 'The spacing is off.', ...more });
  assert.deepEqual(match([review(), changes()]), [], 'a later request for changes on the head takes the approval back');
  assert.deepEqual(match([changes(), review()]), ['look/matches-design@amy-designer'], 'an approval after a request for changes counts');
  assert.deepEqual(match([review(), review({ id: 3, state: 'COMMENTED', body: 'nit' })]), ['look/matches-design@amy-designer'], 'a comment-only review changes nothing');
  assert.deepEqual(match([review(), changes({ commit_id: 'b'.repeat(40) })]), ['look/matches-design@amy-designer'], 'a verdict on another commit is not one on the head');
  assert.deepEqual(match([review(), review({ id: 4, body: 'Approved again, no line.' })]), [], 'the latest approval must hold the line itself');
  assert.deepEqual(match([review(), changes({ user: { login: 'bo-design' } })]), ['look/matches-design@amy-designer'], 'another author`s verdict is their own');
});

test('flowState: an approved id leaves unverified, never open', () => {
  const ok = () => null;
  const verdicts = [{ invariant: 'a', verdict: 'cannot_verify', evidence: 'x', reviewer: 'r' }, { invariant: 'b', verdict: 'violated', evidence: 'x', reviewer: 'r' }];
  assert.deepEqual(flowState([{ id: 'a' }, { id: 'b' }], verdicts, ok), { signed: false, open: ['b'], unverified: ['a'], disputed: [] });
  assert.deepEqual(flowState([{ id: 'a' }, { id: 'b' }], verdicts, ok, new Set(), new Set(['a', 'b'])), { signed: false, open: ['b'], unverified: [], disputed: [] });
  assert.equal(flowState([{ id: 'a' }], verdicts, ok, new Set(), new Set(['a'])).signed, true);
});

test('approvals need the team switch and the machine switch, and a forge read that fails gives none', () => {
  const project = (localReviewApprovals) => ({ localReviewApprovals, paths: { local: '.aidrian.local.json' } });
  assert.match(approvalsSwitch({ approvals: { allow: false } }, project('on')).off, /review\.approvals\.allow/u);
  assert.match(approvalsSwitch({ approvals: { allow: true } }, project('unset')).off, /reviewApprovals is not "on"/u);
  assert.deepEqual(approvalsSwitch({ approvals: { allow: true } }, project('on')), { on: true, off: null });
  const forge = { viewer: () => 'session-bot', reviews: () => [review()] };
  assert.equal(readApprovals(forge, 'o/r', 7, { head: HEAD, flows: FLOWS }).approvals.length, 1);
  for (const broken of [{ ...forge, reviews: () => { throw new Error('HTTP 502'); } }, { ...forge, viewer: () => { throw new Error('HTTP 401'); } }]) {
    const read = readApprovals(broken, 'o/r', 7, { head: HEAD, flows: FLOWS });
    assert.deepEqual(read.approvals, []);
    assert.match(read.error, /could not be read, so none counts: HTTP/u);
  }
});

test('config: review.approvals takes only allow, and an invariant`s approvers must be a list of names', () => {
  const errors = [];
  assert.deepEqual(checkReview({ approvals: { allow: true } }, 'c.json', errors).approvals, { allow: true });
  assert.deepEqual(checkReview({}, 'c.json', errors).approvals, { allow: false });
  assert.deepEqual(errors, []);
  checkReview({ approvals: { allow: 'yes' } }, 'c.json', errors);
  checkReview({ flows: { look: { files: ['src/**'], invariants: [{ id: 'a', text: 'b', approvers: 'amy' }] } } }, 'c.json', errors);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /"review\.approvals" must be/u);
  assert.match(errors[1], /approvers is a non-empty list of logins/u);
});

function gitProject(t, local) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-approvals-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  if (local !== undefined) writeFileSync(path.join(dir, '.aidrian.local.json'), JSON.stringify(local));
  return dir;
}

test('the machine switch: "on" only in an untracked local file; anything else reads off or unset', (t) => {
  assert.equal(openProject(gitProject(t)).localReviewApprovals, 'unset');
  assert.equal(openProject(gitProject(t, { reviewApprovals: 'off' })).localReviewApprovals, 'off');
  const bad = openProject(gitProject(t, { reviewApprovals: true }));
  assert.deepEqual([bad.localReviewApprovals, bad.errors], ['off', ['.aidrian.local.json: "reviewApprovals" must be "on" or "off"']]);
  const on = gitProject(t, { reviewApprovals: 'on' });
  assert.equal(openProject(on).localReviewApprovals, 'on');
  execFileSync('git', ['-C', on, 'add', '-f', '.aidrian.local.json']);
  const tracked = openProject(on);
  assert.equal(tracked.localReviewApprovals, 'off', 'a file a branch could carry is no machine`s switch');
  assert.match(tracked.errors.join('\n'), /"reviewApprovals" reads "off" until it is untracked/u);
});

test('aidrian lint review: an approver that is not a login is an error', (t) => {
  const dir = gitProject(t);
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src/a.js'), '');
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, review: { flows: {
    look: { files: ['src/**'], invariants: [{ id: 'matches-design', text: 'Does it match the design?', approvers: ['amy-designer', 'Amy Designer', '-amy'] }] },
  } } }));
  execFileSync('git', ['-C', dir, 'add', '-A']);
  const run = spawnSync(process.execPath, [CLI, 'lint', 'review', '--project', dir], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, [
    'review: flow look: invariant matches-design names approver "Amy Designer", which is not a login',
    'review: flow look: invariant matches-design names approver "-amy", which is not a login',
    '',
  ].join('\n'));
});

test('overruleRefusal names both routes for an invariant unverified on the head, and none for any other', () => {
  const invariants = { head: HEAD, items: [{ flow: 'look', invariant: 'matches-design', state: 'unverified' }, { flow: 'pay', invariant: 'cap', state: 'violated' }] };
  const refuse = (more) => overruleRefusal({ pr: 7, repo: 'o/r', flow: 'look', invariant: 'matches-design', head: HEAD, invariants, ...more });
  const routes = refuse();
  assert.match(routes, /^invariant matches-design of flow look is not disputed on aaaaaaa of o\/r#7: it is unverified/u);
  assert.ok(routes.includes(`aidrian pr ingest 7 --head ${HEAD} --source "<where they came from>" <image>...`), routes);
  assert.match(routes, /when the base branch sets review\.visual, ingest the images that show it with `aidrian pr ingest /u, 'the ingest route counts only where the review reads captures');
  assert.match(routes, /and have a reviewer cite `capture:<key>` in its verdict; or the Human accepts it in their own shell with `aidrian pr signoff /u);
  assert.ok(routes.includes(`aidrian pr signoff 7 --flow look --accept matches-design --evidence "<URL of a comment or review of this pull request>" --reason "<what it shows>" --head ${HEAD}`), routes);
  assert.match(refuse({ head: HEAD.slice(0, 7) }), /aidrian pr ingest 7/u, 'a short spelling of the head is the same commit');
  const today = (flow, invariant) => `invariant ${invariant} of flow ${flow} is not disputed on aaaaaaa of o/r#7: --overrule settles only a violated verdict another reviewer answers holds or not_affected with evidence. Fix the code, or have a reviewer record its verdict with evidence first`;
  for (const [why, more] of [
    ['a violated invariant', { flow: 'pay', invariant: 'cap' }],
    ['an invariant the review does not list', { invariant: 'nope' }],
    ['the invariants of another head', { invariants: { ...invariants, head: 'b'.repeat(40) } }],
    ['no review record of the invariants', { invariants: undefined }],
  ]) assert.equal(refuse(more), today(more.flow ?? 'look', more.invariant ?? 'matches-design'), why);
});

test('aidrian pr settle refuses with a switch off, on the harness flow, and for anything but a ruling', async () => {
  const { runSettle } = await import('../plugins/aidrian/lib/review-gate.mjs');
  const on = { localUnattendedSignoff: 'on', paths: { local: '.aidrian.local.json' } };
  const allow = { review: { unattendedSignoff: { allow: true } } };
  const ruling = ['7', '--flow', 'look', '--accept', 'fit', '--evidence', 'https://x/y', '--reason', 'r', '--head', HEAD];
  await assert.rejects(runSettle(ruling, on, allow), /needs --judge/u);
  await assert.rejects(runSettle([...ruling, '--judge', 'critic'], on, { review: {} }), /review\.unattendedSignoff\.allow is not true/u);
  await assert.rejects(runSettle([...ruling, '--judge', 'critic'], { paths: { local: 'l' } }, allow), /unattendedSignoff is not "on"/u);
  await assert.rejects(runSettle(['7', '--flow', 'look', '--head', HEAD, '--judge', 'critic'], on, allow), /stay with the Human/u);
  await assert.rejects(runSettle(['7', '--last', '--accept', 'x', '--judge', 'critic'], on, allow), /stay with the Human/u);
  await assert.rejects(runSettle(['7', '--flow', 'harness-config', '--accept', 'x', '--judge', 'critic'], on, allow), /only the Human settles it/u);
});

test('the team and machine unattended sign-off switches parse strictly', () => {
  const bad = [];
  assert.deepEqual(checkReview({ unattendedSignoff: { allow: true } }, 'c.json', bad).unattendedSignoff, { allow: true });
  assert.deepEqual(checkReview({}, 'c.json', bad).unattendedSignoff, { allow: false });
  checkReview({ unattendedSignoff: 'on' }, 'c.json', bad);
  assert.match(bad.join(), /"review\.unattendedSignoff" must be/u);
});
