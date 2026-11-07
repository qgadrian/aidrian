import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { approveLine, approvalsSwitch, matchApprovals, readApprovals } from '../plugins/aidrian/lib/review/approvals.mjs';
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
