// The local review state is keyed by each repository's own owner/name, whichever remote is origin, and a reader gets its
// own repository's record or none (the security re-review of #251). One test per scenario the review probed.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { gateReview, readRecord, writeRecord } from '../plugins/aidrian/lib/review-gate.mjs';
import { sweepDrafts } from '../plugins/aidrian/lib/review/drafts.mjs';
import { emptyState, noteLocalOutcome, otherRecordMessage, readLocalState, recordFile, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { check as mergeRule } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { check as fallbackRule } from '../plugins/aidrian/lib/rules/review-fallback.mjs';
import { question } from '../plugins/aidrian/lib/review/quota.mjs';

const HEAD = 'a'.repeat(40);

// A checkout with `remotes` ([name, url]), its own state folder, and one commit.
function checkout(t, remotes) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-record-repo-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'repo');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (const [name, url] of remotes) git('remote', 'add', name, url);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: '../state' } }));
  git('add', '.');
  git('commit', '-qm', 'init');
  const project = projectAt(dir);
  const transcript = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcript, '');
  return { dir, git, project, transcript };
}

// A record written before the key, under the old name, naming `repo`.
function legacy(project, pr, repo, edit = () => {}) {
  const state = { ...emptyState(pr, repo), revision: 3 };
  edit(state);
  mkdirSync(path.dirname(recordFile(project, pr)), { recursive: true });
  writeFileSync(recordFile(project, pr), `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

const running = (state) => {
  state.rounds.push({ head: HEAD });
  state.outcome = { status: 'running', head: HEAD, at: '2026-11-10T10:00:00.000Z' };
};
const merge = (c, command) => mergeRule(command, { cwd: c.dir, env: {}, input: { transcript_path: c.transcript }, viewPr: () => ({ number: 5, headRefOid: HEAD }) });

test('every repository`s record is its own file, whichever remote is origin', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  assert.match(path.basename(recordFile(c.project, 5, 'o/r')), /^pr-5-review-o--r\.json$/u, 'origin`s is keyed too');
  assert.match(path.basename(recordFile(c.project, 5, 'Up/R')), /^pr-5-review-up--r\.json$/u);
});

test('a held-finding stop noted on one repository never builds on another`s record', (t) => {
  // noteLocalOutcome, as the review step's held-finding stop and the bot cap call it, and run.mjs's error note.
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const before = legacy(c.project, 12, 'o/r', running);
  noteLocalOutcome(c.project, 12, 'up/r', { status: 'incomplete', head: HEAD, reason: 'held' });
  const upstream = readLocalState(c.project, 12, 'up/r');
  assert.deepEqual([upstream.repo, upstream.rounds.length, upstream.outcome.status], ['up/r', 0, 'incomplete'], 'a fresh record of its own');
  assert.equal(JSON.parse(readFileSync(recordFile(c.project, 12), 'utf8')).rounds.length, before.rounds.length, 'origin`s record is untouched');
  assert.equal(readLocalState(c.project, 12, 'o/r').outcome.status, 'running');
});

test('a write of origin`s record never overwrites another repository`s, so its merge stays refused', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/acme/notes.git'], ['upstream', 'https://github.com/up/notes.git']]);
  legacy(c.project, 5, 'up/notes', running);
  writeLocalState(c.project, emptyState(5, 'acme/notes'));
  assert.match(merge(c, `gh pr merge 5 -R up/notes --match-head-commit ${HEAD}`) ?? '', /is `running`/u, 'the upstream`s record is still there');
  assert.equal(readLocalState(c.project, 5, 'up/notes').outcome.status, 'running');
  // The same for the attest record.
  const reviews = path.dirname(recordFile(c.project, 5));
  writeFileSync(path.join(reviews, 'pr-6.json'), JSON.stringify({ pr: 6, repo: 'up/notes', head: 'abcdef1', reviewer: 'upstream-reviewer', findings: 0, fixed: 0 }));
  writeRecord(c.project, { pr: 6, repo: 'acme/notes', head: 'abcdef1', reviewer: 'origin-reviewer', findings: 0, fixed: 0, note: null });
  assert.equal(gateReview(c.project, 6, 'up/notes').reviewer, 'upstream-reviewer');
  assert.equal(readRecord(c.project, 6, 'acme/notes').reviewer, 'origin-reviewer');
});

test('origin renamed to upstream: the old record stays its repository`s, and the new origin gets none of it', (t) => {
  // `gh repo fork` renames origin to upstream and adds the fork as origin.
  const c = checkout(t, [['origin', 'https://github.com/acme/notes.git']]);
  legacy(c.project, 5, 'acme/notes', running);
  c.git('remote', 'rename', 'origin', 'upstream');
  c.git('remote', 'add', 'origin', 'https://github.com/me/notes.git');
  assert.equal(readLocalState(c.project, 5, 'me/notes'), null, 'the fork`s #5 has no record');
  assert.equal(merge(c, `gh pr merge 5 -R me/notes --match-head-commit ${HEAD}`), null, 'so its merge is not held by acme/notes#5');
  writeLocalState(c.project, emptyState(5, 'me/notes'));
  assert.match(merge(c, `gh pr merge 5 -R acme/notes --match-head-commit ${HEAD}`) ?? '', /is `running`/u, 'the fork`s write left acme/notes#5 in place');
  writeLocalState(c.project, { ...readLocalState(c.project, 5, 'acme/notes') });
  assert.equal(existsSync(recordFile(c.project, 5)), false, 'acme/notes`s own write moves it to its file');
  assert.equal(readLocalState(c.project, 5, 'acme/notes').outcome.status, 'running');
});

test('an old-name record that names no repository is served to origin alone', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  legacy(c.project, 7, null, running);
  assert.equal(readLocalState(c.project, 7, 'up/r'), null);
  assert.equal(readLocalState(c.project, 7, 'o/r').outcome.status, 'running');
});

test('the quota-fallback rule never takes another repository`s stop as the call`s', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const stop = { head: HEAD, stage: 'independent', reviewer: 'codex-local', passes: ['engine:codex-local'], reason: 'usage limit', at: '2026-11-01T10:00:00.000Z', choice: null };
  legacy(c.project, 12, 'o/r', (state) => (state.quotaStops = [stop]));
  const asked = question({ pr: 12, stop, repo: 'up/r', repoArg: ' --repo up/r' });
  writeFileSync(c.transcript, `${JSON.stringify({ type: 'user', timestamp: '2026-11-01T10:05:00.000Z', toolUseResult: { questions: [{ question: asked.question }], answers: { [asked.question]: asked.options[0].label } } })}\n`);
  assert.match(fallbackRule(asked.options[0].run, { cwd: c.dir, input: { transcript_path: c.transcript } }) ?? '', /holds no such choice/u, 'up/r#12 has no stop of its own');
});

test('drafts: a draft naming no repository goes only when every repository holding a record of its number has ended', (t) => {
  const c = checkout(t, [['origin', 'https://github.com/o/r.git'], ['upstream', 'https://github.com/up/r.git']]);
  const tmp = path.join(stateDir(c.project), 'tmp');
  const draft = (name) => {
    mkdirSync(path.join(tmp, name), { recursive: true });
    writeFileSync(path.join(tmp, name, 'agent-code-reviewer-1a2b3c4d.findings.json'), '[]');
  };
  writeLocalState(c.project, emptyState(9, 'o/r'));
  writeLocalState(c.project, emptyState(9, 'up/r'));
  for (const name of ['review-9', 'review-9-up--r']) draft(name);
  const states = { 'o/r': 'OPEN', 'up/r': 'MERGED' };
  const forge = { change: (_ref, _fields, options) => ({ state: states[options.repo] ?? 'OPEN' }) };
  const first = sweepDrafts(c.project, { forge });
  assert.deepEqual(first.removed, [{ pr: 9, repo: 'up/r', state: 'merged', files: ['review-9-up--r'] }], 'the upstream`s own folder, by its own state');
  assert.deepEqual(first.kept, [{ pr: 9, reason: 'open' }], 'the legacy draft waits for o/r#9, still open, though the newest record`s #9 merged');
  assert.equal(existsSync(path.join(tmp, 'review-9')), true);
  states['o/r'] = 'CLOSED';
  assert.deepEqual(sweepDrafts(c.project, { forge }).removed.map((row) => row.files), [['review-9']], 'once every one has ended');
});

test('the other-repository refusal never suggests switching to the other repository', () => {
  const message = otherRecordMessage(9, 'qg/voila', 'acme/notes', 'this command records on');
  assert.doesNotMatch(message, /--repo qg\/voila/u);
  assert.match(message, /`aidrian pr review 9 --repo acme\/notes`/u);
});
