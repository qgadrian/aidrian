import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { stateDir } from '../plugins/aidrian/lib/project.mjs';
import { recordPass } from '../plugins/aidrian/lib/review/run.mjs';
import { closingRange, findingsFile, shellQuote } from '../plugins/aidrian/lib/review/dispatch.mjs';
import { listedTo, recordFindings } from '../plugins/aidrian/lib/review/findings.mjs';
import { emptyState, readLocalState, recordFile, stateFromComment, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { capProblem } from '../plugins/aidrian/lib/review/waiver.mjs';
import { check as checkSignoff } from '../plugins/aidrian/lib/rules/review-signoff.mjs';
import { loadTable } from '../plugins/aidrian/lib/finding-disposition.mjs';
import { repo, clean, OPEN, acceptCommand, finding, found, holdsAll, holdComment, toTheCap, extend, summaryOf, APPROVED_FLOWS } from './review-run-fixture.mjs';

// ---- Finding ids and the posted copy, through the step ----

const BOOKING = { booking: { files: ['src/booking/**'] } };
const bookingRepo = (t, github = {}) => repo(t, { baseConfig: { version: 1, github, review: { flows: BOOKING } }, change: (write) => write('src/booking/a.js', '1\n2\n3\n') });
const attestFile = (r, pass, head, list) => recordPass(r.project, { pr: 7, repo: 'o/r', pass, head, reviewer: 'code-reviewer', findingsText: JSON.stringify(list) });
const filed = (over) => ({ title: 'Refund total unchecked', file: 'src/booking/a.js', line: 2, severity: 'medium', likelihood: 'plausible', affects: 'users', state: 'open', ...over });

test('attest mints no id on a record no step floored, or for a pass with no dispatch note; a repeat keeps its id; the next step assigns the rest', async (t) => {
  const r = bookingRepo(t);
  const head = r.git('rev-parse', 'HEAD');
  attestFile(r, 'agent:code-reviewer:booking', head, [filed()]);
  assert.equal(readLocalState(r.project, 7).passes['agent:code-reviewer:booking'].list[0].id, undefined, 'no step floored the record');
  const one = await r.step({ exec: clean });
  assert.equal(one.status, 'dispatch');
  const state = readLocalState(r.project, 7);
  assert.equal(state.floored, true);
  const [dispatched] = one.dispatch;
  assert.deepEqual([state.dispatched[dispatched.pass].stage, state.dispatched[dispatched.pass].security], ['local', false], 'the dispatch note');
  assert.match(dispatched.record, /--findings-file \S+\.findings\.json/u, 'an agent pass records its findings one by one');
  assert.doesNotMatch(dispatched.record, /--findings <n>/u);
  const assigned = state.passes['agent:code-reviewer:booking']?.list?.[0];
  if (assigned) assert.match(assigned.id, /^R\d+-\d+$/u, 'the step assigned the stored finding its id');
  attestFile(r, dispatched.pass, head, [filed()]);
  const first = readLocalState(r.project, 7).passes[dispatched.pass].list[0];
  assert.match(first.id, /^R\d+-\d+$/u, 'a dispatched pass on a floored record mints');
  attestFile(r, dispatched.pass, head, [filed({ state: 'fixed' }), filed({ title: 'Another one', line: 3 })]);
  const again = readLocalState(r.project, 7).passes[dispatched.pass].list;
  assert.deepEqual([again[0].id, again[0].mint], [first.id, first.mint], 'a finding reported again with its title and file keeps its id');
  assert.notEqual(again[1].id, first.id);
  attestFile(r, 'agent:never-dispatched', head, [filed()]);
  assert.equal(readLocalState(r.project, 7).passes['agent:never-dispatched'].list[0].id, undefined, 'a pass with no dispatch note mints none');
});

test('a pass attested before its round opened is read again at that round: a late trivial low it accepted stops blocking', async (t) => {
  const r = bookingRepo(t, { maxReviewRounds: 8, extraRounds: 'off' });
  const head = r.git('rev-parse', 'HEAD');
  const one = await r.step({ exec: clean });
  const [dispatched] = one.dispatch;
  // Four rounds on the base commit before this head, so the step that consumes the attestation opens round 5.
  const N = loadTable().lateRoundFrom;
  const state = readLocalState(r.project, 7);
  const base = r.git('rev-parse', 'HEAD~1');
  state.rounds = Array.from({ length: N - 1 }, () => ({ head: base, at: new Date().toISOString() }));
  writeLocalState(r.project, state);
  const late = filed({ severity: 'low', likelihood: 'routine', cost: 'trivial', state: 'accepted' });
  const axisless = { title: 'Copy names no next step', file: 'src/booking/a.js', line: 3, severity: 'low', state: 'accepted' };
  attestFile(r, dispatched.pass, head, [late, axisless]);
  const attested = readLocalState(r.project, 7).passes[dispatched.pass];
  assert.deepEqual([attested.list.map((each) => each.disposition), attested.open], [['fix_now', 'needs_axis'], 2], 'attested at round 4, where a trivial low is fixed and an axisless one needs axes');
  const two = await r.step({ exec: clean });
  const after = readLocalState(r.project, 7);
  assert.notEqual(two.status, 'extension_check');
  assert.equal(after.rounds.length, N, 'the step opened round 5 for the attested head');
  const pass = after.passes[dispatched.pass];
  assert.deepEqual([pass.list.map((each) => each.disposition), pass.open], [['accepted_residual', 'accepted_residual'], 0], 'read again at round 5, lateRound with or without axes');
  assert.deepEqual(pass.list.map((each) => [after.index[each.id]?.state, after.index[each.id]?.disposition]), [['accepted', 'accepted_residual'], ['accepted', 'accepted_residual']], 'the index takes the new reading');
});

test('the exec step keeps a finding`s id while it is reported again with its title and file', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\nexport const b = 3;\n') });
  const exec = async () => ({ status: 'done', findings: [{ ...finding, severity: 'medium' }], verdicts: [], dropped: [] });
  await r.step({ exec });
  const first = readLocalState(r.project, 7).passes['engine:codex-local'].list[0];
  r.write('src/app.js', 'export const app = 3;\nexport const b = 3;\n');
  r.commit();
  await r.step({ exec });
  const again = readLocalState(r.project, 7).passes['engine:codex-local'].list[0];
  assert.deepEqual([again.id, again.mint], [first.id, first.mint]);
  assert.equal(readLocalState(r.project, 7).rounds[1].findings[0].id, first.id, 'a round`s findings carry the id');
});

test('the residual rows: a row whose text the decision withholds is named by id, and a refused file is in no row; fix_required keeps the text', async (t) => {
  const N = loadTable().lateRoundFrom;
  for (const [label, visibility, over] of [
    ['a token-shaped title', 'PRIVATE', { title: 'leaks ghp_abcdefghijklmnopqrstuvwx0123', file: 'ghp_abcdefghijklmnopqrstuvwx0123' }],
    ['a security finding on a public repository', 'PUBLIC', { security: true }],
  ]) {
    const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 8, extraRounds: 'off' } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
    r.forge.visibility = () => visibility;
    const exec = async () => ({ status: 'done', findings: [{ ...finding, severity: 'low', ...over }], verdicts: [], dropped: [] });
    for (let round = 1; round < N; round += 1) {
      const early = await r.step({ exec });
      assert.equal(early.status, 'fix_required');
      if (round === 1) assert.equal(early.open[0].findings[0].title, over.title ?? finding.title, `${label}: the findings a session fixes keep their text`);
      r.write('src/app.js', `export const app = ${100 + round};\n`);
      r.commit();
    }
    const late = await r.step({ exec });
    assert.equal(late.status, 'received', label);
    assert.equal(late.residuals.length, 1);
    assert.deepEqual(Object.keys(late.residuals[0]).sort(), ['id', 'pass', 'severity', 'text'], `${label}: ${JSON.stringify(late.residuals)}`);
    assert.equal(late.residuals[0].text, 'text withheld');
    assert.equal(late.withheld, 1);
    assert.doesNotMatch(JSON.stringify(late.residuals), /ghp_|Refund|off by one/u);
  }
});

test('the review step stops on an open, blocking finding it holds no text for, and aidrian pr extend on the same record does not', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  const local = readLocalState(r.project, 7);
  const other = { ...local, revision: local.revision + 5, passes: { ...local.passes, 'engine:codex-local': { head: capped.head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R2-9', mint: 'abcdef01', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  r.comments.length = 0;
  r.comments.push({ id: 1, body: summaryBody(other, null, 'x', OPEN), author_association: 'MEMBER' });
  let ran = 0;
  const stopped = await r.step({ exec: async () => (ran += 1, { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.deepEqual([stopped.status, stopped.retry_recommended, ran], ['incomplete', false, 0]);
  assert.match(stopped.reason, /the open finding R2-9, whose text is on the machine that recorded it/u);
  assert.equal(readLocalState(r.project, 7).outcome.status, 'incomplete', 'this machine`s merge guard refuses the head');
  assert.equal(readLocalState(r.project, 7).revision, local.revision, 'the stop adopts nothing');
  const { code } = await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a valid finding', '--head', capped.head]);
  assert.equal(code, 0, 'extend still records its verdict');
});

test('the step`s summary on a public repository holds no finding text, in its lines or its record', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.forge.visibility = () => 'PUBLIC';
  const exec = async () => ({ status: 'done', findings: [{ ...finding, title: 'SENTINEL title', body: 'SENTINEL body', severity: 'medium' }], verdicts: [], dropped: [] });
  assert.equal((await r.step({ exec })).status, 'fix_required');
  const body = summaryOf(r);
  assert.doesNotMatch(body.split('\n').filter((line) => !line.startsWith('<!-- aidrian-review-state')).join('\n'), /SENTINEL/u);
  assert.doesNotMatch(JSON.stringify(stateFromComment(body, 7)), /SENTINEL/u);
  const [posted] = stateFromComment(body, 7).passes['engine:codex-local'].list;
  assert.deepEqual([posted.file, posted.line], ['src/app.js', 1], 'an exec finding keeps its place on a head whose plan does not require the security reviewer');
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].list[0].title, 'SENTINEL title', 'the local record keeps it');
});

test('the plan note keeps every pass an engine plan named, so a pass a later plan drops keeps its name on the pull request', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { flows: BOOKING } }, baseFiles: { 'src/booking/a.js': '1\n' }, change: (write) => { write('src/booking/a.js', '2\n'); write('src/app.js', 'export const app = 2;\n'); } });
  const first = await r.step({ exec: clean });
  const flowPass = first.plan.stages.flatMap((stage) => stage.passes).find((id) => id.startsWith('agent:'));
  assert.ok(flowPass, JSON.stringify(first.plan));
  r.write('src/booking/a.js', '1\n');
  r.commit('back to the base');
  const second = await r.step({ exec: clean });
  assert.ok(!second.plan.stages.flatMap((stage) => stage.passes).includes(flowPass), 'the head`s plan no longer names it');
  const note = readLocalState(r.project, 7).planNote;
  assert.ok(note.passes[flowPass], 'the note still does');
  attestFile(r, 'agent:never-planned', second.head, [filed()]);
  assert.equal(readLocalState(r.project, 7).planNote.passes['agent:never-planned'], undefined, 'a pass attest alone supplied is never added');
});

test('the stop on an adopted finding with no text names the record file; deleting the comment alone, after extend wrote it, is not enough', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  const local = readLocalState(r.project, 7);
  const other = { ...local, revision: local.revision + 5, passes: { ...local.passes, 'engine:codex-local': { head: capped.head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R2-9', mint: 'abcdef01', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  r.comments.length = 0;
  r.comments.push({ id: 1, body: summaryBody(other, null, 'x', OPEN), author_association: 'MEMBER' });
  assert.equal((await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a valid finding', '--head', capped.head])).code, 0, 'extend writes the adopted record');
  r.comments.length = 0;
  const stopped = await r.step({ exec: clean });
  assert.equal(stopped.status, 'incomplete', 'the comment is gone, and this machine`s record still holds the finding');
  const file = recordFile(r.project, 7, 'o/r');
  assert.ok(stopped.reason.includes(file), stopped.reason);
  rmSync(file);
  const fresh = await r.step({ exec: clean });
  assert.notEqual(fresh.status, 'incomplete', 'with the record file gone too, the review restarts');
  assert.equal(fresh.round, 1);
});

test('a machine with no record that runs extend on a public copy holding an untexted blocking finding: its next step stops', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  const local = readLocalState(r.project, 7);
  // Another machine's copy on a public repository: its finding's text stayed there.
  const theirs = { ...local, revision: local.revision + 5, passes: { ...local.passes, 'engine:codex-local': { head: capped.head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R2-9', mint: 'abcdef01', title: 'Theirs', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  theirs.planNote = { ...theirs.planNote, passes: { ...theirs.planNote.passes, 'engine:codex-local': { stage: 'independent', reviewer: 'codex-local', security: false } } };
  r.comments.length = 0;
  r.comments.push({ id: 1, body: summaryBody(theirs, null, 'x', { reading: { visibility: 'PUBLIC', inside: true }, root: r.dir, names: [] }), author_association: 'MEMBER' });
  assert.equal(stateFromComment(r.comments[0].body, 7).passes['engine:codex-local'].list[0].title, undefined, 'the copy holds no text');
  rmSync(recordFile(r.project, 7, 'o/r'));
  assert.equal((await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a valid finding', '--head', capped.head])).code, 0);
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].list[0].adopted, true, 'extend wrote the finding as adopted');
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.retry_recommended], ['incomplete', false]);
  assert.match(stopped.reason, /the open finding R2-9/u);
});

test('a machine with no record restarts from a public copy, whose verdicts carry no evidence: the passes run again, and then it finishes', async (t) => {
  const r = bookingRepo(t);
  r.forge.visibility = () => 'PUBLIC';
  const verdicts = [{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }];
  let runs = 0;
  const exec = async () => (runs += 1, { status: 'done', findings: [], verdicts, dropped: [] });
  const attest = (step) => { for (const pass of step.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: step.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify(verdicts) }); };
  const first = await r.step({ exec });
  assert.equal(first.status, 'dispatch');
  attest(first);
  assert.equal((await r.step({ exec })).status, 'received');
  assert.doesNotMatch(JSON.stringify(stateFromComment(r.comments.at(-1).body, 7).passes), /src\/booking\/a\.js:1/u, 'the public copy posts no evidence');
  const ran = runs;
  // Another machine: no record of its own, only the public comment.
  rmSync(recordFile(r.project, 7, 'o/r'));
  const again = await r.step({ exec });
  assert.equal(again.status, 'dispatch', 'the agent pass is dispatched again, not left as fix_required');
  attest(again);
  assert.equal((await r.step({ exec })).status, 'received');
  assert.ok(runs > ran, 'and the exec pass whose verdicts came without evidence ran again');
});

test('a machine with no record builds on a private copy whose text checks withheld the verdicts` evidence: the passes run again, and then it finishes', async (t) => {
  // The team's public-text pattern withholds the evidence from the copy of a private repository too.
  const r = bookingRepo(t, { publicText: { patterns: ['src/booking/a\\.js:1'] } });
  const verdicts = [{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }];
  let runs = 0;
  const exec = async () => (runs += 1, { status: 'done', findings: [], verdicts, dropped: [] });
  const attest = (step) => { for (const pass of step.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: step.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify(verdicts) }); };
  const first = await r.step({ exec });
  assert.equal(first.status, 'dispatch');
  attest(first);
  assert.equal((await r.step({ exec })).status, 'received');
  const posted = stateFromComment(r.comments.at(-1).body, 7);
  assert.ok(Object.values(posted.passes).some((result) => (result.verdicts ?? []).some((verdict) => verdict.verdict === 'holds' && verdict.evidence === undefined)), 'the private copy posts the verdict without its evidence');
  const ran = runs;
  // Another machine: no record of its own, only the private comment.
  rmSync(recordFile(r.project, 7, 'o/r'));
  const again = await r.step({ exec });
  assert.equal(again.status, 'dispatch', 'the agent pass is dispatched again, not left to an outside acceptance');
  attest(again);
  assert.equal((await r.step({ exec })).status, 'received');
  assert.ok(runs > ran, 'and the exec pass whose evidence was withheld ran again');
});

test('a second machine on a public repository holds on another machine`s open, blocking finding: no reviewer runs, its merge guard refuses the head, and the comment stays', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.forge.visibility = () => 'PUBLIC';
  const first = await r.step({ exec: async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] }) });
  assert.equal(first.status, 'fix_required');
  const { id } = first.open[0].findings[0];
  const body = r.comments[0].body;
  const copy = stateFromComment(body, 7);
  // Another machine: no record of its own, only the public comment.
  rmSync(recordFile(r.project, 7, 'o/r'));
  let ran = 0;
  const held = await r.step({ exec: async () => (ran += 1, { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.deepEqual([held.status, held.retry_recommended, held.held, ran], ['incomplete', false, copy.revision, 0]);
  assert.match(held.reason, new RegExp(`on the machine that wrote it, and holds the open finding ${id}, whose text is on the machine that recorded it`, 'u'));
  const noted = readLocalState(r.project, 7);
  assert.deepEqual([noted.outcome.status, noted.revision, Object.keys(noted.passes).length], ['incomplete', 0, 0], 'the stop is noted, and nothing of the copy is built on');
  assert.equal(r.comments[0].body, body, 'the comment is not edited');
  assert.equal(r.comments.length, 1);
});

test('a second machine that restarts from a public copy at the round cap opens no round past it', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, extraRounds: 'off' } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.forge.visibility = () => 'PUBLIC';
  assert.equal((await r.step({ exec: clean })).status, 'received');
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  const second = await r.step({ exec: clean });
  assert.deepEqual([second.status, second.round], ['received', 2]);
  // Another machine, with no record of its own, on a new head.
  rmSync(recordFile(r.project, 7, 'o/r'));
  r.write('src/app.js', 'export const app = 4;\n');
  r.commit();
  let ran = 0;
  const capped = await r.step({ exec: async () => (ran += 1, { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  assert.deepEqual([capped.status, ran], ['round_limit', 0], 'the copy`s two rounds count: no third round');
  assert.equal(readLocalState(r.project, 7).rounds.length, 2);
  // With the copy gone too, the review starts over from round 1, as the Human chose.
  rmSync(recordFile(r.project, 7, 'o/r'));
  r.comments.length = 0;
  const fresh = await r.step({ exec: clean });
  assert.deepEqual([fresh.status, fresh.round], ['received', 1]);
});

// ---- Findings one by one, with the finding index (S1b) ----

test('every agent pass records with --findings-file: an accepted finding whose disposition cannot be accepted still blocks, and the counts form is read as before', async (t) => {
  const r = bookingRepo(t);
  const one = await r.step({ exec: clean });
  const [pass] = one.dispatch;
  const tag = createHash('sha256').update(pass.pass).digest('hex').slice(0, 8);
  const file = path.join(stateDir(r.project), 'tmp', 'review-7-o--r', `${pass.pass.replace(/[^\w.-]/gu, '-')}-${tag}.findings.json`);
  assert.ok(pass.record.startsWith(`aidrian pr attest 7 --pass ${pass.pass} --head ${one.head} --reviewer code-reviewer --findings-file '${file}'`), pass.record);
  assert.ok(path.relative(r.dir, file).startsWith('..'), 'the findings file is outside the checkout, under the state folder');
  const table = loadTable();
  for (const [axis, words] of [['severity', table.severities], ['likelihood', table.likelihoods], ['affects', table.affects], ['cost', table.costs]]) {
    assert.ok(Array.isArray(words) && words.length, axis);
    assert.match(pass.brief, new RegExp(`\`${axis}\``, 'u'), `the brief names ${axis}, which the disposition table reads`);
  }
  // A reviewer is read-only: it returns its findings, and the session that dispatched it writes the file.
  assert.match(pass.brief, /Write no file\. Return every finding in the `findings` array of your final JSON/u);
  assert.match(pass.brief, /The dispatching session writes that array to the findings file `record` names and runs `record`/u);
  assert.doesNotMatch(pass.brief, /\b(?:write|save|create)s? (?:every finding|the findings|a file|it) (?:to|in)\b/iu, 'the brief asks the reviewer to write nothing');
  attestFile(r, pass.pass, one.head, [filed({ state: 'accepted' })]);
  const blocked = await r.step({ exec: clean });
  assert.equal(blocked.status, 'fix_required');
  assert.deepEqual(blocked.open.map((each) => [each.pass, each.open]), [[pass.pass, 1]], 'the table decides: accepted, but fix_now, so it blocks');
  assert.equal(blocked.open[0].findings[0].disposition, 'fix_now');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: one.head, reviewer: 'code-reviewer', findings: 1, fixed: 0, accepted: 1 });
  assert.equal(readLocalState(r.project, 7).passes[pass.pass].open, 0, 'the counts form still records, as before');
  const next = await r.step({ exec: clean });
  assert.ok(!(next.open ?? []).some((each) => each.pass === pass.pass), 'and its count is read');
});

test('attest: priorFindings carries each id, a returned id keeps it, a refused one is noted, and what the pass leaves out closes as not reported again with its range', async (t) => {
  const r = bookingRepo(t);
  const one = await r.step({ exec: clean });
  const [first] = one.dispatch;
  attestFile(r, first.pass, one.head, [filed(), filed({ title: 'Second defect', line: 3 })]);
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  const [a, b] = readLocalState(r.project, 7).passes[first.pass].list.map((each) => each.id);
  r.write('src/booking/a.js', '1\n2\n3\n4\n');
  const h2 = r.commit();
  const two = await r.step({ exec: clean });
  const [again] = two.dispatch;
  assert.equal(again.pass, first.pass);
  assert.deepEqual(again.priorFindings.map((each) => each.id).sort(), [a, b].sort(), 'each prior finding with its id');
  assert.match(again.brief, /set the finding's `id` to that entry's `id`, verbatim/u);
  const note = readLocalState(r.project, 7).dispatched[again.pass];
  assert.deepEqual([note.base, [...note.listed].sort()], [one.head, [a, b].sort()], 'the dispatch note keeps the delta base and the listed ids');
  attestFile(r, again.pass, h2, [filed({ title: 'Refund sum is never validated', id: a }), filed({ title: 'Third defect', line: 4, id: 'R9-9' })]);
  const recorded = readLocalState(r.project, 7).passes[again.pass];
  assert.equal(recorded.list[0].id, a, 'a reworded repeat that returns its id keeps it');
  assert.notEqual(recorded.list[1].id, 'R9-9');
  assert.deepEqual(recorded.dropped, [`${recorded.list[1].id}: its returned id is not an open finding its input listed, so it was read as no id`]);
  await r.step({ exec: clean });
  let index = readLocalState(r.project, 7).index;
  assert.deepEqual([index[a].state, index[b].state], ['open', 'not_reported'], 'left out, it closes as not reported again, never as fixed');
  assert.deepEqual(index[b].closed_in, { from: one.head, to: h2 });
  assert.equal(index[b].title, 'Second defect', 'the local record keeps its title');
  // Round 3: the fix of `a` is attested as fixed; `b` reported again is a new finding.
  r.write('src/booking/a.js', '1\n2\n3\n4\n5\n');
  const h3 = r.commit();
  const three = await r.step({ exec: clean });
  attestFile(r, three.dispatch[0].pass, h3, [filed({ title: 'Refund sum is never validated', state: 'fixed', id: a }), filed({ title: 'Second defect', line: 3, id: b })]);
  const last = readLocalState(r.project, 7);
  index = last.index;
  assert.deepEqual([index[a].state, index[a].closed_in], ['fixed', { from: h2, to: h3 }], 'a fix closes on the head it was attested, from the head that last held it open');
  assert.notEqual(last.passes[three.dispatch[0].pass].list[1].id, b, 'a closed id is final, by id or by title and file');
  assert.equal(index[b].state, 'not_reported');
});

test('the exec step: context copies carry each id, a reworded repeat that returns its id keeps it, and a finding left out closes with its range', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\nexport const b = 3;\n') });
  const inputs = [];
  let answer = [{ ...finding, severity: 'medium' }, { ...finding, title: 'Second defect', line: 2, severity: 'medium' }];
  const exec = async (_reviewer, input) => (inputs.push(input), { status: 'done', findings: answer, verdicts: [], dropped: [] });
  await r.step({ exec });
  const h1 = r.git('rev-parse', 'HEAD');
  const [a, b] = readLocalState(r.project, 7).passes['engine:codex-local'].list.map((each) => each.id);
  r.write('src/app.js', 'export const app = 3;\nexport const b = 3;\n');
  const h2 = r.commit();
  answer = [{ ...finding, title: 'Off by one, said otherwise', severity: 'medium', returned_id: a }];
  await r.step({ exec });
  assert.deepEqual(inputs.at(-1).priorFindings.map((each) => each.id), [a, b], 'the pass`s context copies carry each id');
  const state = readLocalState(r.project, 7);
  assert.equal(state.passes['engine:codex-local'].list[0].id, a);
  assert.equal(state.idCounter, 2, 'no second id is minted');
  assert.deepEqual([state.index[a].state, state.index[b].state, state.index[b].closed_in], ['open', 'not_reported', { from: h1, to: h2 }]);
  assert.equal(state.index[a].title, 'Off by one, said otherwise', 'the entry holds the latest wording');
});

const anyPath = { tracked: () => true, lines: () => 100 };
const P = (id, files, reviewer = 'codex-local', stage = 'independent') => ({ id, reviewer, stage, files });
const E = (over) => ({ file: 'src/a.js', line: 3, title: 'Null check missing', body: 'b', severity: 'medium', ...over });

test('a cut that moves, and a slice that runs as two halves, beside the cross pass: a repeat under the same title and a reworded repeat that returns its id keep their ids, and nothing closes', () => {
  const old = 'slice:codex-local:aaaaaaaaaa';
  const cross = P('cross:codex-local', null);
  const [H1, H2] = ['1'.repeat(40), '2'.repeat(40)];
  const range = (seen, to) => ({ from: seen, to });
  // src/gone.js is no tracked path, so that finding is recorded with no file; src/c.js is outside the old slice's files.
  const paths = { tracked: (file) => file !== 'src/gone.js', lines: () => 100 };
  const before = [P(old, ['src/a.js', 'src/b.js']), cross];
  for (const [label, next, outsideTo] of [
    ['a cut that moves', [P('slice:codex-local:cccccccccc', ['src/a.js', 'src/c.js']), P('slice:codex-local:dddddddddd', ['src/b.js']), P('slice:codex-local:eeeeeeeeee', ['src/e.js']), cross], 'slice:codex-local:cccccccccc'],
    ['two halves', [P(`${old}.a`, ['src/a.js']), P(`${old}.b`, ['src/b.js']), cross], cross.id],
  ]) {
    const state = { ...emptyState(7, 'o/r'), rounds: [{ head: H1 }], floored: true };
    const found = [E(), E({ title: 'B side', file: 'src/b.js' }), E({ title: 'Deleted test', file: 'src/gone.js' }), E({ title: 'Caller outside', file: 'src/c.js' })];
    recordFindings(state, old, { head: H1, reviewer: 'codex-local', list: found }, { mint: true, paths, plan: before, stage: 'independent' });
    recordFindings(state, cross.id, { head: H1, reviewer: 'codex-local', list: [] }, { mint: true, paths, plan: before, stage: 'independent' });
    recordFindings(state, null, null, { plan: before, head: H1, complete: new Set(['independent']), range });
    const [a, b, none, outside] = state.passes[old].list.map((each) => each.id);
    assert.equal(state.index[none].file, undefined, `${label}: the finding with no file`);
    assert.deepEqual(Object.values(state.index).map((entry) => entry.state), ['open', 'open', 'open', 'open'], `${label}: beside the cross pass, nothing closes on the head that recorded them`);
    assert.deepEqual([...listedTo(state, before, old)].sort(), [a, b, none, outside].sort(), `${label}: all stay with the slice that lists them`);
    const counter = state.idCounter;
    state.rounds.push({ head: H2 });
    const where = { [a]: next[0].id, [b]: next[1].id, [none]: cross.id, [outside]: outsideTo };
    for (const [id, to] of Object.entries(where)) assert.ok(listedTo(state, next, to).includes(id), `${label}: ${id} is handed on to ${to}`);
    const reports = new Map(next.map((pass) => [pass.id, []]));
    reports.get(where[a]).push(E());
    reports.get(where[b]).push(E({ title: 'The B side, reworded', file: 'src/b.js', returned_id: b }));
    reports.get(where[none]).push(E({ title: 'The deleted test, reworded', file: 'src/gone.js', returned_id: none }));
    reports.get(where[outside]).push(E({ title: 'Caller outside', file: 'src/c.js' }));
    for (const pass of next) recordFindings(state, pass.id, { head: H2, reviewer: 'codex-local', list: reports.get(pass.id) }, { mint: true, paths, listed: listedTo(state, next, pass.id), plan: next, stage: 'independent', range });
    recordFindings(state, null, null, { plan: next, head: H2, complete: new Set(['independent']), range });
    for (const id of [a, b, none, outside]) assert.ok(state.passes[where[id]].list.some((each) => each.id === id), `${label}: ${id} stays`);
    assert.equal(state.idCounter, counter, `${label}: no second id is minted`);
    assert.deepEqual([a, b, none, outside].map((id) => [state.index[id].state, state.index[id].pass]), [a, b, none, outside].map((id) => ['open', where[id]]), `${label}: nothing closes as not reported again`);
  }
});

test('a pass gone after replanning: its entry, held by no pass of its reviewer and stage, closes; another pass claims it first, and only once', () => {
  const [H1, H2] = ['1'.repeat(40), '2'.repeat(40)];
  const range = (seen, to) => ({ from: seen, to });
  const gone = 'slice:codex-local:aaaaaaaaaa';
  const build = () => {
    const state = { ...emptyState(7, 'o/r'), rounds: [{ head: H1 }, { head: H2 }], floored: true };
    recordFindings(state, gone, { head: H1, reviewer: 'codex-local', list: [E()] }, { mint: true, paths: anyPath, plan: [P(gone, ['src/a.js'])], stage: 'independent' });
    return [state, state.passes[gone].list[0].id];
  };
  const plan = [P('engine:codex-local', ['src/b.js']), P('agent:code-reviewer', null, 'code-reviewer', 'local')];
  const [state, id] = build();
  assert.deepEqual(listedTo(state, plan, 'agent:code-reviewer'), [], 'listed to no pass');
  recordFindings(state, 'engine:codex-local', { head: H2, reviewer: 'codex-local', list: [] }, { mint: true, paths: anyPath, plan, stage: 'independent', range });
  recordFindings(state, 'agent:code-reviewer', { head: H2, reviewer: 'code-reviewer', list: [] }, { mint: true, paths: anyPath, plan, stage: 'local', range });
  recordFindings(state, null, null, { plan, head: H2, complete: new Set(['local', 'independent']), range });
  assert.deepEqual([state.index[id].state, state.index[id].closed_in], ['not_reported', { from: H1, to: H2 }]);
  const [claimed, its] = build();
  const first = recordFindings(claimed, 'agent:code-reviewer', { head: H2, reviewer: 'code-reviewer', list: [E()] }, { mint: true, paths: anyPath, plan, stage: 'local', range });
  const second = recordFindings(claimed, 'engine:codex-local', { head: H2, reviewer: 'codex-local', list: [E()] }, { mint: true, paths: anyPath, plan, stage: 'independent', range });
  assert.equal(first.list[0].id, its, 'the first pass to report its title and file claims the entry');
  assert.notEqual(second.list[0].id, its, 'a second is a new finding');
  assert.equal(claimed.index[its].pass, 'agent:code-reviewer');
});

test('closed_in: a fix in a quiet push gets that push alone, and a rebased head the range from the merge base', (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const seen = r.git('rev-parse', 'HEAD');
  const base = r.git('merge-base', 'main', seen);
  r.write('src/app.js', 'export const app = 2;\n// quiet\n');
  const quiet = r.commit();
  assert.deepEqual(closingRange(r.dir, base)(seen, quiet), { from: seen, to: quiet });
  r.git('switch', '-q', '-c', 'rebased', 'main');
  r.write('src/app.js', 'export const app = 3;\n');
  const rebased = r.commit();
  assert.deepEqual(closingRange(r.dir, base)(seen, rebased), { from: base, to: rebased }, 'the head that last held it is no ancestor');
  assert.equal(closingRange(r.dir, base)(seen, rebased.slice(0, 7)), null, 'never a short SHA');
});

test('a record an earlier release wrote gets an index entry for each id it holds on its first write, and a re-recorded list or a pruned pass deletes none', (t) => {
  const r = bookingRepo(t);
  const head = r.git('rev-parse', 'HEAD');
  const s1a = { ...emptyState(7, 'o/r'), revision: 3, floored: true, idCounter: 3,
    rounds: [{ head, at: '2026-11-11T00:00:00.000Z', findings: [{ id: 'R1-3', mint: '33333333', title: 'Only in a round', file: 'src/booking/a.js', line: 1, severity: 'low', pass: 'gone' }] }],
    passes: { 'engine:codex-local': { head, reviewer: 'codex-local', findings: 2, open: 1, list: [{ id: 'R1-1', mint: '11111111', title: 'Open one', file: 'src/booking/a.js', line: 2, severity: 'medium' }, { id: 'R1-2', mint: '22222222', title: 'Fixed one', severity: 'low', state: 'fixed', disposition: 'drop_unless_cited' }] } } };
  mkdirSync(path.dirname(recordFile(r.project, 7, 'o/r')), { recursive: true });
  writeFileSync(recordFile(r.project, 7, 'o/r'), JSON.stringify(s1a));
  assert.equal(readLocalState(r.project, 7).index, undefined);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'agent:other', head, reviewer: 'code-reviewer', findings: 0, fixed: 0 });
  const { index } = readLocalState(r.project, 7);
  assert.deepEqual(Object.keys(index).sort(), ['R1-1', 'R1-2', 'R1-3']);
  assert.deepEqual([index['R1-1'].state, index['R1-2'].state, index['R1-3'].state], ['open', 'fixed', 'open']);
  assert.equal(index['R1-1'].reviewer, 'codex-local');
  const state = readLocalState(r.project, 7);
  state.passes['engine:codex-local'].list = [];
  delete state.passes['agent:other'];
  writeLocalState(r.project, state);
  assert.deepEqual(Object.keys(readLocalState(r.project, 7).index).sort(), ['R1-1', 'R1-2', 'R1-3'], 'a list re-recorded without them, or a pass gone, deletes no entry');
});

test('a review step that stops on an open, blocking finding with no text closes no index entry', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  const local = readLocalState(r.project, 7);
  local.index = { 'R1-5': { id: 'R1-5', mint: '55555555', title: 'Left out', file: 'src/booking/a.js', severity: 'medium', state: 'open', pass: 'engine:codex-local', stage: 'independent', reviewer: 'codex-local', seen: capped.head } };
  writeFileSync(recordFile(r.project, 7, 'o/r'), JSON.stringify(local));
  const other = { ...local, revision: local.revision + 5, passes: { ...local.passes, 'engine:codex-local': { head: capped.head, reviewer: 'codex-local', findings: 1, open: 1, list: [{ id: 'R2-9', mint: 'abcdef01', severity: 'high', state: 'open', disposition: 'fix_now' }] } } };
  r.comments.length = 0;
  r.comments.push({ id: 1, body: summaryBody(other, null, 'x', OPEN), author_association: 'MEMBER' });
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.retry_recommended], ['incomplete', false]);
  assert.deepEqual(readLocalState(r.project, 7).index, local.index, 'nothing closed');
});

test('review.record "local" posts nothing, whatever review.publish says', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { record: 'local', publish: { summary: 'findings', inline: true, publicSecurity: 'full' } } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  r.forge.postComment = () => assert.fail('nothing is posted');
  r.forge.editComment = () => assert.fail('nothing is edited');
  r.forge.conversationComments = () => assert.fail('nothing is read');
  const result = await r.step({ exec: async () => ({ status: 'done', findings: [finding], verdicts: [], dropped: [] }) });
  assert.equal(result.status, 'fix_required');
  assert.equal(r.comments.length, 0);
});

test('summary "findings": the step`s comment lists each finding and its outcome, with no text, and a security finding only as a count while open', async (t) => {
  const lines = (n) => Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i === 0 ? n : i};\n`).join('');
  const r = repo(t, { baseConfig: { version: 1, review: { publish: { summary: 'findings' } } }, change: (write) => write('src/app.js', lines(2)) });
  r.forge.visibility = () => 'PUBLIC';
  r.forge.compareUrl = (repo, from, to) => `https://github.com/${repo}/compare/${from}...${to}`;
  let answer = [{ ...finding, title: 'SENTINEL first', severity: 'medium' }, { ...finding, title: 'SENTINEL second', line: 2, severity: 'medium' }, { ...finding, title: 'SENTINEL leaked', line: 25, severity: 'low', security: true }];
  const exec = async () => ({ status: 'done', findings: answer, verdicts: [], dropped: [] });
  await r.step({ exec });
  const h1 = r.git('rev-parse', 'HEAD');
  let body = summaryOf(r);
  assert.match(body, /\*\*Findings:\*\*/u);
  assert.match(body, /\| R1-1 \| src\/app\.js:1 \| medium \|  \| open \|/u);
  assert.match(body, /- 1 open security finding, counted and not listed/u);
  assert.doesNotMatch(body, /SENTINEL|R1-3/u);
  r.write('src/app.js', lines(3));
  const h2 = r.commit();
  answer = [];
  await r.step({ exec });
  body = summaryOf(r);
  assert.ok(body.includes(`| R1-2 | src/app.js:2 | medium |  | not reported again in [${h1.slice(0, 7)}...${h2.slice(0, 7)}](https://github.com/o/r/compare/${h1}...${h2}) |`), body);
  assert.ok(body.includes(`| R1-3 |  | low |  | not reported again in [${h1.slice(0, 7)}...${h2.slice(0, 7)}]`), 'the closed security finding: its id, severity, outcome, and range only');
  assert.doesNotMatch(body, /SENTINEL/u);
});

test('a finding attest stored without an id, listed as fixed on a record no step floored, gets its id and its closing range at the next step', async (t) => {
  const r = bookingRepo(t);
  const head = r.git('rev-parse', 'HEAD');
  attestFile(r, 'agent:code-reviewer:booking', head, [filed({ state: 'fixed' })]);
  assert.equal(readLocalState(r.project, 7).passes['agent:code-reviewer:booking'].list[0].id, undefined);
  await r.step({ exec: clean });
  const state = readLocalState(r.project, 7);
  const [fixed] = state.passes['agent:code-reviewer:booking'].list;
  assert.match(fixed.id, /^R\d+-\d+$/u);
  assert.deepEqual([state.index[fixed.id].state, state.index[fixed.id].closed_in], ['fixed', { from: r.git('merge-base', 'main', head), to: head }]);
});

test('the findings file: two pass ids that read alike get different files, the same id the same file, each under the state folder`s tmp', async (t) => {
  const { findingsFile } = await import('../plugins/aidrian/lib/review/dispatch.mjs');
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const [one, two] = ['flow:a-b:c', 'flow:a:b-c'].map((id) => findingsFile(r.project, 7, id));
  assert.notEqual(one, two);
  assert.equal(findingsFile(r.project, 7, 'flow:a-b:c'), one, 'the same id, the same file');
  for (const file of [one, two, findingsFile(r.project, 7, '../../x/../y')]) {
    assert.equal(path.dirname(file), path.join(stateDir(r.project), 'tmp', 'review-7'));
    assert.match(path.basename(file), /^[\w.-]+-[0-9a-f]{8}\.findings\.json$/u);
  }
});

test('the record command passes the findings file as one shell argument, from a state folder whose path holds a space and a quote', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, state: { dir: "../st ate's" }, review: { flows: BOOKING } }, change: (write) => write('src/booking/a.js', '1\n2\n3\n') });
  const one = await r.step({ exec: clean });
  assert.equal(one.status, 'dispatch');
  const [pass] = one.dispatch;
  const file = findingsFile(r.project, 7, pass.pass, 'o/r');
  assert.ok(file.includes("st ate's"), file);
  // A POSIX shell reads the command back into its words; the verdicts placeholder is left out, since `<` redirects.
  const words = spawnSync('sh', ['-c', `set -- ${pass.record.replace(' --verdicts <file.json>', '')}; for word in "$@"; do printf '%s\\n' "$word"; done`], { encoding: 'utf8' });
  assert.equal(words.status, 0, words.stderr);
  const argv = words.stdout.trimEnd().split('\n');
  assert.equal(argv[argv.indexOf('--findings-file') + 1], file, 'the path arrives whole');
  assert.deepEqual(argv.slice(0, 4), ['aidrian', 'pr', 'attest', '7']);
  assert.equal(shellQuote("it's a b"), "'it'\\''s a b'");
});

test('the findings file of a merged pass with three long flow ids still fits a file name, distinct and stable', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const flows = (tail) => Array.from({ length: 3 }, (_, i) => `${'f'.repeat(78)}${i}${tail}`);
  const ids = ['a', 'b'].map((tail) => `agent:code-reviewer:${flows(tail).join('+')}`);
  const [one, two] = ids.map((id) => findingsFile(r.project, 7, id));
  for (const file of [one, two]) assert.ok(Buffer.byteLength(path.basename(file)) <= 255, `${Buffer.byteLength(path.basename(file))} bytes`);
  assert.notEqual(one, two, 'two ids that share a long prefix differ by the hash of the whole id');
  assert.equal(findingsFile(r.project, 7, ids[0]), one, 'the same id, the same file');
  writeFileSync(one, '[]');
  assert.equal(readFileSync(one, 'utf8'), '[]', 'the file can be written');
});

// ---- Inline reviews on a whole step (lib/review/inline.mjs) ----

const INLINE = { version: 1, review: { publish: { inline: true } } };
const mediumFinding = { file: 'src/app.js', line: 1, title: 'the app number is wrong', body: 'It should stay 1.', severity: 'medium' };
// The forge double of `repo` with the inline review's reads and writes: every post is kept, by the viewer `me`, a
// member; every call is named in `calls`. `refuse` makes postReview refuse.
function inlineForge(r) {
  const calls = [];
  const reviews = [];
  const reviewComments = [];
  const resolved = new Set();
  const author = { user: { login: 'me' }, author_association: 'MEMBER' };
  const named = (name, fn) => (...args) => (calls.push(name), fn(...args));
  const { postComment, conversationComments, editComment } = r.forge;
  Object.assign(r.forge, {
    viewer: named('viewer', () => 'me'),
    conversationComments: named('conversationComments', conversationComments),
    postComment: named('postComment', (...args) => {
      postComment(...args);
      Object.assign(r.comments.at(-1), author);
      return { id: r.comments.at(-1).id };
    }),
    editComment: named('editComment', editComment),
    reviews: named('reviews', () => reviews),
    reviewComments: named('reviewComments', () => reviewComments),
    postReview: named('postReview', (_repo, _n, review) => {
      if (r.refuse) return { refused: true };
      const id = 900 + reviews.length;
      reviews.push({ id, body: review.body, ...author });
      const posted = review.comments.map((comment, i) => ({ id: 1000 + reviewComments.length + i, body: comment.body, path: comment.path, line: comment.line, pull_request_review_id: id, ...author }));
      reviewComments.push(...posted);
      return { refused: false, id, comments: posted.map(({ id: each, body }) => ({ id: each, body })) };
    }),
    reviewComment: named('reviewComment', (_repo, _n, id) => reviewComments.find((each) => each.id === id) ?? null),
    comment: named('comment', (_repo, id) => r.comments.find((each) => each.id === id) ?? null),
    deleteReviewComment: named('deleteReviewComment', (_repo, id) => (reviewComments.splice(reviewComments.findIndex((each) => each.id === id), 1), null)),
    deleteComment: named('deleteComment', (_repo, id) => (r.comments.splice(r.comments.findIndex((each) => each.id === id), 1), null)),
    visibility: named('visibility', r.forge.visibility),
    // A thread is its root review comment and every comment that replies to it; a reply joins it with an id from 5000.
    findingThreads: named('findingThreads', () => reviewComments.filter((each) => !each.in_reply_to_id)
      .map((root) => ({ resolved: resolved.has(root.id), complete: true, comments: [root, ...reviewComments.filter((each) => each.in_reply_to_id === root.id)] }))),
    replyToReviewComment: named('replyToReviewComment', (_repo, _n, id, body) => {
      if (r.failReply) throw new Error('gh: Bad Gateway (HTTP 502)');
      const reply = { id: 5000 + reviewComments.length, body, in_reply_to_id: id, ...author };
      reviewComments.push(reply);
      return { id: reply.id };
    }),
    resolveThread: named('resolveThread', (_repo, _n, id) => (resolved.add(id), { resolved: true })),
    unresolveThread: named('unresolveThread', (_repo, _n, id) => (resolved.delete(id), { resolved: false })),
  });
  return { calls, reviews, reviewComments, resolved };
}
const summaryComment = (r) => r.comments.find((comment) => comment.body.startsWith('<!-- aidrian-review-summary -->'));

test('inline on: one whole step posts one review with the finding`s thread, records it, and a second step posts nothing and lists it as mapped', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const exec = async () => found(mediumFinding);
  const first = await r.step({ exec });
  assert.equal(first.status, 'fix_required');
  assert.deepEqual(posts.calls, ['conversationComments', 'reviews', 'reviewComments', 'visibility', 'conversationComments', 'postReview', 'postComment'], 'the step`s forge calls, in order: the posted record read again just before the post');
  assert.deepEqual([first.inline_review.posted, first.inline_review.threads, first.inline_review.review_id], [true, ['R1-1'], 900]);
  assert.deepEqual(posts.reviewComments.map((each) => [each.path, each.line]), [['src/app.js', 1]]);
  assert.ok(posts.reviewComments[0].body.startsWith('<!-- aidrian-review-finding:R1-1 -->\naidrian review, finding R1-1\n'));
  const local = readLocalState(r.project, 7);
  assert.deepEqual(local.index['R1-1'].thread, { reviewId: 900, commentId: 1000 });
  assert.deepEqual(stateFromComment(summaryComment(r).body, 7).index['R1-1'].thread, { reviewId: 900, commentId: 1000 }, 'the posted record holds the thread');
  assert.deepEqual(first.engine_comments.map((each) => [each.kind, each.id]), [['review_comment', 1000], ['review', 900]], 'what this step posted is the engine`s, mapped');
  assert.deepEqual(first.engine_comments_unmapped, []);
  assert.ok(!posts.calls.some((name) => name.startsWith('delete') || name === 'reviewComment'), 'no candidate for the delete, so no call for it');

  posts.calls.length = 0;
  const second = await r.step({ exec });
  assert.equal(second.inline_review, undefined, 'a second step posts nothing');
  assert.ok(!posts.calls.includes('postReview'));
  assert.deepEqual(second.engine_comments.map((each) => each.id), [900, 1000], 'and lists the thread as mapped');
  assert.deepEqual(second.engine_comments_unmapped, []);
});

test('inline: a step that cannot read the marked posts returns neither list, and before the first id mints nothing; later it posts no review', async (t) => {
  for (const broken of [() => { throw new Error('gh: Bad Gateway (HTTP 502)'); }, () => [{ body: 'no id' }]]) {
    const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
    const posts = inlineForge(r);
    r.forge.reviewComments = broken;
    const first = await r.step({ exec: async () => found(mediumFinding) });
    assert.equal(first.status, 'fix_required');
    assert.ok(first.engine_comments_unread && !('engine_comments' in first) && !('engine_comments_unmapped' in first));
    assert.match(first.ids_unminted, /no finding id is minted/u);
    assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].list[0].id, undefined, 'no id is minted');
    assert.equal(readLocalState(r.project, 7).floored, false, 'and attest mints none either');
    assert.ok(!posts.calls.includes('postReview'));
  }
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  r.forge.reviews = () => { throw new Error('gh: Bad Gateway (HTTP 502)'); };
  const state = { ...emptyState(7, 'o/r'), idCounter: 3 };
  writeLocalState(r.project, state);
  const later = await r.step({ exec: async () => found(mediumFinding) });
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].list[0].id, 'R1-4', 'a record past its first id still mints');
  assert.deepEqual([later.inline_review.posted, posts.calls.includes('postReview')], [false, false], 'and posts no review');
});

test('inline: attest on a fresh record after a deleted summary stores no id, and the next step assigns ids above the highest marker', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const first = await r.step({ exec: async () => found(mediumFinding, { ...mediumFinding, title: 'second', line: 1, file: 'src/app.js', body: 'b' }) });
  assert.deepEqual(first.inline_review.threads.length + first.inline_review.in_body.length, 2);
  // The Human deletes the summary comment, and this machine's record is gone: the review restarts.
  r.comments.splice(r.comments.indexOf(summaryComment(r)), 1);
  rmSync(path.join(stateDir(r.project), 'reviews'), { recursive: true, force: true });
  const attested = recordPass(r.project, { pr: 7, repo: 'o/r', pass: 'agent:code-reviewer', head: first.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([{ title: 'attested', file: 'src/app.js', line: 1, state: 'open', severity: 'medium', likelihood: 'plausible', affects: 'internal', cost: 'bounded' }]) });
  assert.equal(attested.list[0].id, undefined, 'attest on a fresh record stores no id');
  await r.step({ exec: async () => found(mediumFinding) });
  const ids = Object.keys(readLocalState(r.project, 7).index);
  assert.ok(ids.length && ids.every((id) => Number(id.split('-')[1]) > 2), `every id is above R1-2, the highest marker: ${ids}`);
  assert.equal(posts.reviewComments.filter((each) => each.body.startsWith('<!-- aidrian-review-finding:R1-1 -->')).length, 1, 'no second comment under an id a marker carries');
});

test('inline: a held record and a step that cannot read the posts: every marked post unmapped, or neither list', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  await r.step({ exec: async () => found(mediumFinding) });
  const summary = summaryComment(r);
  summary.body = holdComment(summary.body, readLocalState(r.project, 7).revision + 3);
  const held = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.equal(held.held !== undefined, true);
  assert.deepEqual(held.engine_comments, [], 'a step that stops before it maps anything maps nothing');
  assert.deepEqual(held.engine_comments_unmapped.map((each) => each.id).sort(), [1000, 900].sort());
  r.forge.reviews = () => { throw new Error('down'); };
  const unread = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.ok(unread.engine_comments_unread && !('engine_comments' in unread) && !('engine_comments_unmapped' in unread));
  assert.ok(posts.reviews.length === 1);
});

// A first step that posts the finding inline on a private repository, then the finding marked security in this machine's
// record: the next step runs on a public reading.
async function postedThenMarked(t, baseConfig = INLINE) {
  const r = repo(t, { baseConfig, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const first = await r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(first.inline_review.threads, ['R1-1']);
  const state = readLocalState(r.project, 7);
  state.index['R1-1'].security = true;
  writeLocalState(r.project, state);
  r.forge.visibility = () => 'PUBLIC';
  return { r, posts, first };
}

test('the delete follows the record, no switch: the local file`s inline false and a base branch that set review.record "local" after the post each delete their own comment', async (t) => {
  const local = await postedThenMarked(t);
  local.r.write('.aidrian.local.json', JSON.stringify({ review: { publish: { inline: false } } }));
  const off = await local.r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(off.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }]);
  assert.equal(local.posts.reviewComments.length, 0, 'the comment is gone');
  assert.ok(!local.posts.calls.slice(local.posts.calls.indexOf('deleteReviewComment')).includes('postReview'), 'and nothing is posted');
  assert.deepEqual(readLocalState(local.r.project, 7).index['R1-1'].thread, { reviewId: 900 }, 'the write takes the id out of the thread');

  const based = await postedThenMarked(t);
  based.r.git('switch', '-q', 'main');
  based.r.write('.aidrian/config.json', JSON.stringify({ version: 1, review: { record: 'local', publish: { inline: true } } }));
  based.r.git('add', '-A');
  based.r.git('commit', '-q', '-m', 'record local');
  based.r.git('switch', '-q', 'feat');
  const quiet = await based.r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(quiet.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }], 'review.record "local" stops no delete');
  assert.ok(!('engine_comments' in quiet) && !('engine_comments_unread' in quiet), 'a local record reads no pull request comment');
});

test('the delete on a member`s machine that reads a mark another machine set, also on a step that stops for a finding with no text', async (t) => {
  const { r, posts } = await postedThenMarked(t);
  // This machine's record carries no mark; another machine's posted copy, at a higher revision, does.
  const state = readLocalState(r.project, 7);
  delete state.index['R1-1'].security;
  writeLocalState(r.project, state);
  const remote = { ...readLocalState(r.project, 7), revision: state.revision + 4 };
  remote.index = { ...remote.index, 'R1-1': { ...remote.index['R1-1'], security: true }, 'R1-7': { id: 'R1-7', mint: 'abcdef01', severity: 'medium', state: 'open', disposition: 'fix_now', pass: 'engine:codex-local' } };
  remote.passes = { ...remote.passes, 'engine:codex-local': { ...remote.passes['engine:codex-local'], list: [...remote.passes['engine:codex-local'].list, { id: 'R1-7', mint: 'abcdef01', severity: 'medium', state: 'open', disposition: 'fix_now' }] } };
  summaryComment(r).body = summaryBody(remote, null, 'x', OPEN);
  const stopped = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.equal(stopped.status, 'incomplete');
  assert.match(stopped.reason, /the open finding R1-7, whose text is on the machine that recorded it/u);
  assert.deepEqual(stopped.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }], 'the delete runs before the stop');
  assert.equal(posts.reviewComments.length, 0);
});

test('the delete on a held record: this machine`s own comment goes, the record`s revision stays, and the step after it makes no call for it', async (t) => {
  const { r, posts } = await postedThenMarked(t);
  const revision = readLocalState(r.project, 7).revision;
  const summary = summaryComment(r);
  summary.body = holdComment(summary.body, revision + 3);
  const held = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.equal(held.held, revision + 3);
  assert.deepEqual(held.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }]);
  assert.equal(readLocalState(r.project, 7).revision, revision, 'no record is written');
  assert.deepEqual(readLocalState(r.project, 7).index['R1-1'].thread, { reviewId: 900, commentId: 1000 }, 'the hold stays as it was');
  posts.calls.length = 0;
  const again = await r.step({ exec: () => assert.fail('no reviewer runs') });
  assert.deepEqual(again.comment_deletes.gone, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }]);
  assert.ok(!posts.calls.includes('reviewComment') && !posts.calls.includes('deleteReviewComment'), 'no call for a comment the whole read no longer holds');
});

test('the delete reaches an unmapped marked comment of a security id, and leaves one of another id and another member`s', async (t) => {
  const { r, posts } = await postedThenMarked(t);
  const mark = (id) => `<!-- aidrian-review-finding:${id} -->\naidrian review, finding ${id}\ntext`;
  // A comment a lost write left unmapped, one of an id that is not security-marked, and another member's.
  posts.reviewComments.push(
    { id: 2001, body: mark('R1-1'), user: { login: 'me' }, author_association: 'MEMBER' },
    { id: 2002, body: mark('R1-9'), user: { login: 'me' }, author_association: 'MEMBER' },
    { id: 2003, body: mark('R1-1'), user: { login: 'pat' }, author_association: 'COLLABORATOR' },
  );
  const result = await r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(result.comment_deletes.deleted.map((each) => each.id).sort(), [1000, 2001]);
  assert.deepEqual(result.comment_deletes.waiting, [{ finding: 'R1-1', kind: 'review_comment', id: 2003, login: 'pat' }]);
  assert.deepEqual(posts.reviewComments.map((each) => each.id), [2002, 2003]);
});

test('inline: a member`s marker at the counter`s digit limit stops the step as incomplete rather than mint past it, and one past the limit is ignored', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const mark = (id) => `<!-- aidrian-review-finding:${id} -->\naidrian review, finding ${id}\ntext`;
  posts.reviewComments.push({ id: 3001, body: mark('R1-1234567'), user: { login: 'pat' }, author_association: 'MEMBER' });
  const ignored = await r.step({ exec: async () => found(mediumFinding) });
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].list[0].id, 'R1-1', 'a marker past six digits raises nothing');
  assert.deepEqual(ignored.engine_comments_unmapped, [], 'and is no marker at all');
  posts.reviewComments.push({ id: 3002, body: mark('R1-999999'), user: { login: 'pat' }, author_association: 'MEMBER' });
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  let ran = 0;
  const stopped = await r.step({ exec: async () => (ran += 1, found(mediumFinding)) });
  assert.deepEqual([stopped.status, stopped.retry_recommended, ran], ['incomplete', false, 0]);
  assert.match(stopped.reason, /the finding id counter of #7 is at its limit/u);
});

test('the counter at its limit through the review`s own ids stops a step that would mint, and says no marker raised it', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  assert.equal((await r.step({ exec: async () => found(mediumFinding) })).status, 'fix_required');
  const state = readLocalState(r.project, 7);
  state.idCounter = 999999;
  writeLocalState(r.project, state);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  let ran = 0;
  const stopped = await r.step({ exec: async () => (ran += 1, found(mediumFinding)) });
  assert.deepEqual([stopped.status, stopped.retry_recommended, ran], ['incomplete', false, 0]);
  assert.match(stopped.reason, /at its limit of 999999, reached by the ids this review minted/u);
  assert.doesNotMatch(stopped.reason, /marker/u);
  assert.equal(readLocalState(r.project, 7).outcome.status, 'incomplete', 'the stop is the head`s outcome, so the merge guard reads it');
});

test('the counter at its limit stops no step whose every pass has its result on the head: it mints nothing', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 2;\n') });
  assert.equal((await r.step({ exec: async () => found(mediumFinding) })).status, 'fix_required');
  const state = readLocalState(r.project, 7);
  state.idCounter = 999999;
  writeLocalState(r.project, state);
  const again = await r.step({ exec: () => assert.fail('no reviewer runs: the pass has its result on this head') });
  assert.equal(again.status, 'fix_required', 'the step goes on to its result');
  assert.deepEqual(again.open[0].findings.map((each) => each.id), ['R1-1']);
});

test('two writers: a record that lost the write that mapped a finding`s thread posts no second thread for it', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const first = await r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(first.inline_review.threads, ['R1-1']);
  // This machine's record is a write that never read the one that mapped R1-1's thread, at a higher revision, as when
  // two machines step at once: the posted record still maps it.
  const stale = readLocalState(r.project, 7);
  delete stale.index['R1-1'].thread;
  stale.revision += 5;
  writeLocalState(r.project, stale);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('not the fix');
  const second = await r.step({ exec: async () => found(mediumFinding) });
  assert.equal(second.status, 'fix_required');
  assert.equal(second.inline_review, undefined, 'no second thread, and no fresh id for it');
  assert.deepEqual([posts.reviews.length, posts.reviewComments.length], [1, 1]);
  const local = readLocalState(r.project, 7);
  assert.deepEqual(local.index['R1-1'].thread, { reviewId: 900, commentId: 1000 }, 'the write keeps the mapping it merged back');
  assert.deepEqual(Object.keys(local.index), ['R1-1']);
  assert.deepEqual(stateFromComment(summaryComment(r).body, 7).index['R1-1'].thread, { reviewId: 900, commentId: 1000 });
});

test('two writers: a comment another write posts after the step read the marked posts, merged in and marked security, is read and deleted, not called gone', async (t) => {
  const r = repo(t, { baseConfig: INLINE, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  await r.step({ exec: async () => found(mediumFinding) });
  // The finding is recorded and unposted: its thread is gone from the pull request and from both copies.
  posts.reviews.length = 0;
  posts.reviewComments.length = 0;
  const state = readLocalState(r.project, 7);
  delete state.index['R1-1'].thread;
  writeLocalState(r.project, state);
  summaryComment(r).body = summaryBody(readLocalState(r.project, 7), null, 'x', OPEN);
  r.forge.visibility = () => 'PUBLIC';
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('not the fix');
  // While this step's reviewer runs, another machine posts the finding's thread and its record maps it; the reviewer
  // here rates the finding high.
  const second = await r.step({ exec: async () => {
    const body = posts.reviewComments.length ? null : '<!-- aidrian-review-finding:R1-1 -->\naidrian review, finding R1-1\n> the app number is wrong';
    if (body) posts.reviewComments.push({ id: 1001, body, path: 'src/app.js', line: 1, pull_request_review_id: 901, user: { login: 'me' }, author_association: 'MEMBER' });
    const remote = readLocalState(r.project, 7);
    remote.index['R1-1'].thread = { reviewId: 901, commentId: 1001 };
    remote.revision += 3;
    summaryComment(r).body = summaryBody(remote, null, 'x', OPEN);
    return found({ ...mediumFinding, severity: 'high' });
  } });
  assert.deepEqual(second.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1001 }], 'read by its own id and deleted');
  assert.deepEqual(second.comment_deletes.gone, []);
  assert.ok(!posts.reviewComments.some((each) => each.id === 1001), 'the other write`s comment is gone from the pull request');
});

test('the delete runs under publicSecurity "full" too: a comment posted with its text before the mark goes, and the step posts no text for it', async (t) => {
  const { r, posts } = await postedThenMarked(t, { version: 1, review: { publish: { inline: true, publicSecurity: 'full' } } });
  const result = await r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(result.comment_deletes.deleted, [{ finding: 'R1-1', kind: 'review_comment', id: 1000 }]);
  assert.equal(posts.reviewComments.length, 0);
  assert.ok(!posts.reviews.slice(1).some((review) => review.body.includes('It should stay 1.')), 'no later post carries its text');
});

// ---- Replies on a whole step (lib/review/inline.mjs answerThreads) ----

// A first step that posts the medium finding inline, then a fix pushed, which the reviewer no longer reports.
async function postedThenFixed(t, baseConfig = INLINE) {
  const r = repo(t, { baseConfig, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const posts = inlineForge(r);
  const first = await r.step({ exec: async () => found(mediumFinding) });
  assert.deepEqual(first.inline_review.threads, ['R1-1']);
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  posts.calls.length = 0;
  return { r, posts, first };
}

test('replies on: one whole step after a fix replies on the thread and resolves it, records both marks, and a further step posts nothing', async (t) => {
  const { r, posts, first } = await postedThenFixed(t);
  const second = await r.step({ exec: clean });
  assert.equal(second.status, 'received');
  assert.deepEqual(posts.calls, ['conversationComments', 'reviews', 'reviewComments', 'visibility', 'conversationComments', 'viewer', 'findingThreads', 'replyToReviewComment', 'resolveThread', 'editComment'], 'the step`s forge calls, in order: one read of every thread');
  assert.deepEqual(second.replies, { replied: ['R1-1'], resolved: ['R1-1'], reopened: [], open: [], waiting: [], left: [], unanswered: [] });
  const reply = posts.reviewComments.find((each) => each.in_reply_to_id === 1000);
  const local = readLocalState(r.project, 7);
  assert.equal(local.index['R1-1'].state, 'not_reported');
  const { from, to } = local.index['R1-1'].closed_in;
  assert.equal(to, second.head);
  assert.equal(reply.body, ['<!-- aidrian-review-finding:R1-1 -->', 'aidrian review, finding R1-1', `Not reported again in ${from.slice(0, 7)}...${to.slice(0, 7)}.`].join('\n'), 'no link where the forge builds none, and no reviewer text');
  assert.ok(posts.resolved.has(1000));
  assert.deepEqual(local.index['R1-1'].thread, { reviewId: 900, commentId: 1000, replied: true, replyId: reply.id, resolved: true, resolvedByEngine: true });
  assert.deepEqual(stateFromComment(summaryComment(r).body, 7).index['R1-1'].thread, local.index['R1-1'].thread, 'the posted record holds the marks');
  assert.deepEqual(second.engine_comments.map((each) => each.id).sort(), [900, 1000, reply.id].sort(), 'the reply is the engine`s, mapped');
  assert.deepEqual(second.engine_comments_unmapped, []);
  assert.equal(first.replies, undefined, 'a step with nothing closed answers nothing');

  posts.calls.length = 0;
  const third = await r.step({ exec: clean });
  assert.equal(third.replies, undefined);
  assert.ok(!posts.calls.some((name) => ['viewer', 'findingThreads', 'replyToReviewComment', 'resolveThread'].includes(name)), 'a further step makes no call for the thread');
  assert.equal(posts.reviewComments.filter((each) => each.in_reply_to_id === 1000).length, 1);
});

test('replies: a failure on the step that returns received is named, and the next run retries it', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  r.failReply = true;
  const second = await r.step({ exec: clean });
  assert.equal(second.status, 'received');
  assert.deepEqual(second.replies.unanswered, ['R1-1'], 'the received result names the unanswered thread');
  assert.equal(readLocalState(r.project, 7).index['R1-1'].thread.replied, undefined);
  assert.ok(!posts.calls.includes('resolveThread'));
  r.failReply = false;
  const third = await r.step({ exec: clean });
  assert.equal(third.status, 'received');
  assert.deepEqual([third.replies.replied, third.replies.resolved, third.replies.unanswered], [['R1-1'], ['R1-1'], []], 'the next run answers it');
});

test('replies: a clean merge from the base branch, which carries the review, retries a reply the received step could not post', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  r.failReply = true;
  assert.deepEqual((await r.step({ exec: clean })).replies.unanswered, ['R1-1']);
  r.failReply = false;
  r.git('switch', '-q', 'main');
  r.write('src/lib.js', 'export const lib = 1;\n');
  r.commit('on main');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  const carried = await r.step({ exec: () => assert.fail('no reviewer runs on a carried review') });
  assert.equal(carried.status, 'received');
  assert.ok(carried.carried_from, 'the review is carried');
  assert.deepEqual([carried.replies.replied, carried.replies.resolved, carried.replies.unanswered], [['R1-1'], ['R1-1'], []]);
  assert.equal(posts.reviewComments.filter((each) => each.in_reply_to_id === 1000).length, 1);
  const thread = readLocalState(r.project, 7).index['R1-1'].thread;
  assert.deepEqual([thread.replied, thread.resolved], [true, true], 'the carried step keeps the marks');
  assert.deepEqual(stateFromComment(summaryComment(r).body, 7).index['R1-1'].thread, thread, 'and posts them');
});

test('replies: a closed finding whose thread another member`s login started is listed apart with that login, gets no post, and is not unanswered', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  Object.assign(posts.reviewComments[0], { user: { login: 'teammate' }, author_association: 'COLLABORATOR' });
  const second = await r.step({ exec: clean });
  assert.deepEqual([second.replies.waiting, second.replies.unanswered], [[{ finding: 'R1-1', login: 'teammate' }], []]);
  assert.ok(!posts.calls.includes('replyToReviewComment') && !posts.calls.includes('resolveThread'), 'this machine posts nothing on it');
  assert.ok(!JSON.stringify(readLocalState(r.project, 7)).includes('teammate'), 'the record stores no login');
  assert.ok(!summaryComment(r).body.includes('teammate'));
});

test('replies: a finding whose comment the engine deleted gets no reply', async (t) => {
  const { r, posts } = await postedThenMarked(t, { version: 1, review: { publish: { inline: true, publicSecurity: 'full' } } });
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit('fix');
  posts.calls.length = 0;
  const second = await r.step({ exec: clean });
  assert.deepEqual(second.comment_deletes.deleted.map((each) => each.finding), ['R1-1']);
  assert.equal(readLocalState(r.project, 7).index['R1-1'].state, 'not_reported');
  assert.equal(second.replies, undefined);
  assert.ok(!posts.calls.includes('replyToReviewComment') && !posts.calls.includes('findingThreads'));
});

test('replies: false, the local file`s inline false, and review.record "local" post no reply and resolve nothing', async (t) => {
  const off = await postedThenFixed(t, { version: 1, review: { publish: { inline: true, replies: false } } });
  const local = await postedThenFixed(t);
  local.r.write('.aidrian.local.json', JSON.stringify({ review: { publish: { inline: false } } }));
  const kept = await postedThenFixed(t);
  kept.r.git('switch', '-q', 'main');
  kept.r.write('.aidrian/config.json', JSON.stringify({ version: 1, review: { record: 'local', publish: { inline: true } } }));
  kept.r.git('add', '-A');
  kept.r.git('commit', '-q', '-m', 'record local');
  kept.r.git('switch', '-q', 'feat');
  for (const { r, posts } of [off, local, kept]) {
    const second = await r.step({ exec: clean });
    assert.equal(readLocalState(r.project, 7).index['R1-1'].state, 'not_reported', `the finding closed: ${second.status} ${second.reason ?? ''}`);
    assert.equal(second.replies, undefined);
    assert.ok(!['viewer', 'findingThreads', 'replyToReviewComment', 'resolveThread'].some((name) => posts.calls.includes(name)), posts.calls.join(','));
  }
});

test('replies: a finding answered and then marked security loses the engine`s reply and its thread root on the next step', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  const second = await r.step({ exec: clean });
  const replyId = second.replies && readLocalState(r.project, 7).index['R1-1'].thread.replyId;
  assert.ok(Number.isSafeInteger(replyId));
  const state = readLocalState(r.project, 7);
  state.index['R1-1'].security = true;
  writeLocalState(r.project, state);
  r.forge.visibility = () => 'PUBLIC';
  posts.calls.length = 0;
  const third = await r.step({ exec: clean });
  assert.deepEqual(third.comment_deletes.deleted.map((each) => each.id), [replyId, 1000], 'the reply first, then the root');
  assert.ok(!posts.reviewComments.some((each) => each.id === replyId || each.id === 1000), 'both are gone from the pull request');
  assert.deepEqual(readLocalState(r.project, 7).index['R1-1'].thread, { reviewId: 900, replied: true, resolved: true, resolvedByEngine: true });
  assert.equal(third.replies, undefined, 'and nothing is posted again');
});

// ---- A security mark the step sets itself (the second sweep in run.mjs finish) ----

// The twin of the posted finding R1-1, at its place, that its reviewer flags as security: recording it marks R1-1 in the
// same step, after the step's first sweep.
const securityTwin = { file: 'src/app.js', line: 1, title: 'the number leaks a secret', body: 'flagged', severity: 'low', security: true };
// The same twin returned as a repeat of a residual the pull request body accepts: a ruling, which never blocks, so the
// step that records it returns received.
const RESIDUAL = 'The number may leak in a log line';
const rulingTwin = { ...securityTwin, already_ruled: RESIDUAL };
const withResidual = (r) => {
  const change = r.forge.change;
  r.forge.change = (...args) => ({ ...change(...args), body: `## Summary\n\nWhy.\n\n## Accepted residuals\n\n- ${RESIDUAL}\n` });
};

test('the delete in the step that sets the mark: an exec pass`s security twin deletes the engine`s reply and root that step, and its record maps neither', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  const answered = await r.step({ exec: clean });
  const replyId = readLocalState(r.project, 7).index['R1-1'].thread.replyId;
  assert.ok(answered.replies?.replied?.includes('R1-1') && Number.isSafeInteger(replyId));
  // The next push: its exec pass reports the security twin.
  r.write('src/app.js', 'export const app = 4;\n');
  r.commit('next');
  r.forge.visibility = () => 'PUBLIC';
  posts.calls.length = 0;
  const marked = await r.step({ exec: async () => found(securityTwin) });
  assert.equal(readLocalState(r.project, 7).index['R1-1'].security, true, 'the step`s own exec pass set the mark');
  assert.deepEqual(marked.comment_deletes.deleted.map((each) => each.id), [replyId, 1000], 'the reply, then the root, in the same step');
  assert.ok(!posts.reviewComments.some((each) => each.id === replyId || each.id === 1000));
  const posted = stateFromComment(summaryComment(r).body, 7).index['R1-1'];
  assert.equal(posted.security, true);
  assert.equal(posted.thread?.commentId, undefined, 'the posted record points at no deleted comment');
  assert.equal(posted.thread?.replyId, undefined);
  assert.equal(marked.comment_deletes.deleted.length, new Set(marked.comment_deletes.deleted.map((each) => each.id)).size, 'each comment deleted once');
  posts.calls.length = 0;
  const after = await r.step({ exec: async () => found(securityTwin) });
  assert.ok(!posts.calls.some((name) => name.startsWith('delete')), 'the step after it deletes nothing more');
  assert.equal(after.comment_deletes, undefined);
});

test('the delete in the step that sets the mark, on a step that returns received; a private repository keeps the comment', async (t) => {
  const { r, posts } = await postedThenFixed(t);
  withResidual(r);
  r.forge.visibility = () => 'PUBLIC';
  const received = await r.step({ exec: async () => found(rulingTwin) });
  assert.equal(received.status, 'received');
  assert.equal(readLocalState(r.project, 7).index['R1-1'].security, true, 'the ruling, a twin, marked the posted finding');
  assert.deepEqual(received.comment_deletes.deleted.map((each) => each.id), [1000]);
  assert.ok(!posts.reviewComments.some((each) => each.id === 1000));
  assert.equal(stateFromComment(summaryComment(r).body, 7).index['R1-1'].thread?.commentId, undefined);
  assert.equal(received.replies, undefined, 'and no reply goes to the finding the step marked');

  const kept = await postedThenFixed(t);
  withResidual(kept.r);
  const quiet = await kept.r.step({ exec: async () => found(rulingTwin) });
  assert.equal(quiet.status, 'received');
  assert.equal(quiet.comment_deletes, undefined, 'on a private repository nothing is deleted');
  assert.ok(kept.posts.reviewComments.some((each) => each.id === 1000));
});

test('the delete in the step that sets the mark follows publicSecurity "full": a root that holds the finding`s text goes, the textless reply stays', async (t) => {
  const { r, posts } = await postedThenFixed(t, { version: 1, review: { publish: { inline: true, publicSecurity: 'full' } } });
  await r.step({ exec: clean });
  const replyId = readLocalState(r.project, 7).index['R1-1'].thread.replyId;
  r.write('src/app.js', 'export const app = 4;\n');
  r.commit('next');
  r.forge.visibility = () => 'PUBLIC';
  const marked = await r.step({ exec: async () => found(securityTwin) });
  assert.deepEqual([marked.comment_deletes.deleted.map((each) => each.id), marked.comment_deletes.textless.map((each) => each.id)], [[1000], [replyId]]);
  assert.ok(posts.reviewComments.some((each) => each.id === replyId) && !posts.reviewComments.some((each) => each.id === 1000));
});

test('the two sweeps of a step read the repository`s visibility once between them, on a private repository that keeps the comment', async (t) => {
  const { r, posts } = await postedThenMarked(t);
  let reads = 0;
  r.forge.visibility = () => (reads += 1, 'PRIVATE');
  posts.calls.length = 0;
  const step = await r.step({ exec: async () => found(mediumFinding) });
  assert.equal(step.comment_deletes, undefined, 'a private repository keeps the comment');
  assert.ok(posts.reviewComments.some((each) => each.id === 1000));
  // One read for the step's post context, one shared by both sweeps.
  assert.equal(reads, 2, 'the second sweep reuses the first sweep`s read');
});

// #251: in a checkout whose remotes name more than one repository, the sign-off and round-raise rules count the Human's
// answer only on a command that names its repository, so every command the step prints ends in `--repo`.
// The state folder is keyed by the origin, so each test that needs no particular one gets its own.
let remoteSeed = 0;
const moreRemotes = (r, origin = `https://github.com/several-${process.pid}-${(remoteSeed += 1)}/r.git`) => {
  r.git('remote', 'add', 'origin', origin);
  r.git('remote', 'add', 'other', 'https://github.com/qg/voila.git');
};

test('with remotes of several repositories, the human_required sign-off names --repo, and runs on the Human`s answer as printed', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, headConfig: { version: 1 }, change: (write) => write('src/booking/book.js', 'x\n') });
  moreRemotes(r, 'https://github.com/o/r.git');
  const first = await r.step({ exec: clean });
  for (const pass of first.dispatch) {
    const ids = pass.flows.flatMap((flow) => flow.invariants.map((each) => [flow.id, each.id]));
    recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0,
      verdictsText: JSON.stringify(ids.map(([flow, invariant]) => ({ flow, invariant, verdict: 'holds', evidence: 'src/booking/book.js:1' }))) });
  }
  const human = await r.step({ exec: clean });
  assert.deepEqual([human.status, human.command], ['human_required', [`aidrian pr signoff 7 --flow harness-config --head ${human.head} --repo o/r`]]);
  const file = path.join(r.dir, '..', 't.jsonl');
  writeFileSync(file, JSON.stringify({ type: 'user', toolUseResult: { answers: { [`Sign off o/r#7 at ${human.head.slice(0, 7)}: harness-config/signoff?`]: 'Approve' } } }));
  assert.equal(checkSignoff(human.command[0], { cwd: r.dir, input: { transcript_path: file } }), null, 'the printed command runs on the answer');
  assert.ok(checkSignoff(human.command[0].replace(' --repo o/r', ''), { cwd: r.dir, input: { transcript_path: file } }), 'control: without --repo it is denied');
});

test('with remotes of one repository, the printed commands carry no --repo', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, headConfig: { version: 1 }, change: (write) => write('src/booking/book.js', 'x\n') });
  r.git('remote', 'add', 'origin', `https://github.com/single-${process.pid}/r.git`);
  r.git('remote', 'add', 'origin-https', `https://github.com/single-${process.pid}/r`);
  const first = await r.step({ exec: clean });
  for (const pass of first.dispatch) {
    const ids = pass.flows.flatMap((flow) => flow.invariants.map((each) => [flow.id, each.id]));
    recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0,
      verdictsText: JSON.stringify(ids.map(([flow, invariant]) => ({ flow, invariant, verdict: 'holds', evidence: 'src/booking/book.js:1' }))) });
  }
  assert.deepEqual((await r.step({ exec: clean })).command, [`aidrian pr signoff 7 --flow harness-config --head ${first.head}`]);
});

test('with remotes of several repositories, the overrule, accept, and settle commands name --repo', async (t) => {
  const disputed = repo(t, { baseConfig: { version: 1, review: { flows: { booking: { files: ['src/booking/**'] } } } }, change: (write) => write('src/booking/a.js', '1\n') });
  moreRemotes(disputed);
  const first = await disputed.step({ exec: clean });
  recordPass(disputed.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: holdsAll(first.dispatch[0], 'src/booking/a.js:1') });
  const violated = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'booking', invariant: 'unspecified', verdict: 'violated', evidence: 'src/booking/a.js:1' }], dropped: [] });
  const [flow] = (await disputed.step({ exec: violated })).flows;
  const overrule = `aidrian pr signoff 7 --flow booking --overrule unspecified --head ${first.head} --reason "<why>" --repo o/r`;
  assert.deepEqual([flow.overrule, flow.next[0].commands], [[overrule], [overrule]]);

  const r = repo(t, { baseConfig: { version: 1, review: { flows: APPROVED_FLOWS, unattendedSignoff: { allow: true } } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  moreRemotes(r);
  r.write('.aidrian.local.json', JSON.stringify({ unattendedSignoff: 'on' }));
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  const [next] = (await r.step({ exec: clean })).flows[0].next;
  assert.deepEqual(next.commands, [`${acceptCommand('look', 'matches-design', one.head)} --repo o/r`]);
  assert.match(next.settle, / --judge <agent> --repo o\/r$/u);
});

test('with remotes of several repositories, the review step`s rerun at the cap names --repo', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  moreRemotes(r);
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: 2, fixed: 0 });
  await r.step({ exec: clean });
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, 'extension_check');
  assert.ok(capped.dispatch[0].record.endsWith(' --repo o/r'), `the judge's record command names the repository (#302): ${capped.dispatch[0].record}`);
  await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a real high-severity bug', '--head', capped.head]);
  const ask = await r.step({ exec: clean });
  assert.deepEqual([ask.status, ask.then, ask.record], ['extension_ask', 'aidrian pr review 7 --repo o/r', "aidrian pr extend 7 --human approve|deny --check 'plan' --repo o/r"]);
  assert.match(ask.question, /^Pull request o\/r#7 reached/u);
});

test('the review step on one repository ignores this machine`s record of the same number in another', async (t) => {
  // #251 security review: one record file a pull request number, so another repository's record of #7 may be here.
  const control = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const fresh = await control.step({ exec: clean });
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  // Left under the old file name, origin's, before the record was keyed by repository (#305).
  const other = emptyState(7, 'qg/voila');
  other.rounds = [{ head: 'a'.repeat(40) }, { head: 'b'.repeat(40) }, { head: 'c'.repeat(40) }];
  mkdirSync(path.dirname(recordFile(r.project, 7)), { recursive: true });
  writeFileSync(recordFile(r.project, 7), JSON.stringify({ ...other, revision: 1 }));
  const step = await r.step({ exec: clean });
  assert.equal(step.repo, 'o/r');
  assert.equal(step.round, fresh.round, 'the rounds of qg/voila#7 do not count on o/r#7');
  assert.equal(readLocalState(r.project, 7).repo, 'o/r', 'the step builds its own record');
});

// #303: a review reads its policy from the reviewed pull request's own base branch, the one of the remote that names its
// repository, never origin's.
test('a review step on another remote`s repository holds to that remote`s base branch config', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 3 } }, change: (write) => write('src/app.js', 'b\n') });
  const owner = `base-${process.pid}`;
  r.git('remote', 'add', 'origin', `https://github.com/${owner}/r.git`);
  r.git('remote', 'add', 'upstream', 'https://github.com/up/r.git');
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'main'));
  // The upstream's main: the same history, with a base config of its own.
  r.git('switch', '-q', '-c', 'upstream-main', 'main');
  r.write('.aidrian/config.json', JSON.stringify({ version: 1, github: { maxReviewRounds: 7 } }));
  r.git('add', '-A');
  r.git('commit', '-q', '-m', 'upstream policy');
  r.git('update-ref', 'refs/remotes/upstream/main', r.git('rev-parse', 'HEAD'));
  r.git('switch', '-q', 'feat');
  r.git('branch', '-q', '-D', 'upstream-main');
  assert.equal((await r.step({ exec: clean }, { repo: 'up/r' })).max_rounds, 7, 'the upstream`s pull request takes the upstream`s cap');
  assert.equal((await r.step({ exec: clean }, { repo: `${owner}/r` })).max_rounds, 3, 'origin`s takes origin`s');
  r.git('update-ref', '-d', 'refs/remotes/upstream/main');
  await assert.rejects(r.step({ exec: clean }, { repo: 'up/r' }), /the base branch main of up\/r is not fetched from upstream, the remote that names it: git fetch upstream main first/u, 'never origin`s or a local branch in its place');
});

test('a step that errs on one repository notes the error on its own record, never on another`s of that number', async (t) => {
  // run.mjs's error note: the security re-review of #251 found it written over origin's record for another repository.
  const r = repo(t, { change: (write) => write('src/app.js', 'b\n') });
  const owner = `err-${process.pid}`;
  r.git('remote', 'add', 'origin', `https://github.com/${owner}/r.git`);
  r.git('remote', 'add', 'upstream', 'https://github.com/up/r.git');
  r.git('update-ref', 'refs/remotes/upstream/main', r.git('rev-parse', 'main'));
  // origin's record of #7, under the old file name, with a finished review.
  const origin = { ...emptyState(7, `${owner}/r`), rounds: [{ head: 'a'.repeat(40) }, { head: 'b'.repeat(40) }], outcome: { status: 'received', head: 'b'.repeat(40), at: 'x' }, revision: 2 };
  origin.pending = [{ id: 'origin-owed', kind: 'review', head: 'b'.repeat(40), at: '2026-11-01T10:00:00.000Z', by: 'H' }];
  mkdirSync(path.dirname(recordFile(r.project, 7)), { recursive: true });
  writeFileSync(recordFile(r.project, 7), JSON.stringify(origin));
  const before = readFileSync(recordFile(r.project, 7), 'utf8');
  await assert.rejects(r.step({ exec: async () => { throw new Error('the reviewer crashed'); } }, { repo: 'up/r' }), /the reviewer crashed/u);
  const upstream = readLocalState(r.project, 7, 'up/r');
  assert.equal(upstream.outcome.status, 'error', 'the error is noted on up/r#7');
  assert.ok(upstream.rounds.length <= 1, 'with none of origin`s rounds');
  assert.deepEqual(upstream.pending.map((entry) => entry.id), [], 'and none of the entries origin owes: the step`s writes merged in no other record`s');
  assert.equal(readFileSync(recordFile(r.project, 7), 'utf8'), before, 'origin`s record is untouched');
});

// Two flows, booking answered by the local stage and pay by the independent model alone, to the last of two rounds:
// round 1 ends fix_required on one open local finding, a fix is pushed, and in round 2 the independent model gives pay
// `payVerdict` and the code reviewer lists `item` open. Returns the repository and the step at the cap.
async function capOnLocal(t, { payVerdict, item }) {
  const flows = { booking: { files: ['src/booking/**'] }, pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, extraRounds: 'off' }, review: { flows } }, change: (write) => (write('src/booking/a.js', '1\n'), write('src/pay/a.js', '1\n')) });
  const verdicts = (pay) => async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'booking', invariant: 'unspecified', verdict: 'holds', evidence: 'src/booking/a.js:1' }, { flow: 'pay', invariant: 'unspecified', verdict: pay, evidence: 'src/pay/a.js:1' }], dropped: [] });
  const one = await r.step({ exec: verdicts('holds') });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: 1, fixed: 0, verdictsText: holdsAll(one.dispatch[0], 'src/booking/a.js:1') });
  assert.equal((await r.step({ exec: verdicts('holds') })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const last = await r.step({ exec: verdicts(payVerdict) });
  assert.equal(last.status, 'dispatch', 'round 2 ran the independent stage first, then asks the code reviewer');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: last.dispatch[0].pass, head: last.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([item]), verdictsText: holdsAll(last.dispatch[0], 'src/booking/a.js:1') });
  const capped = await r.step({ exec: verdicts(payVerdict) });
  assert.deepEqual([capped.status, capped.stage], ['round_limit', 'local'], 'the cap is judged at the local stage');
  return { r, capped, verdicts };
}
const localItem = (severity) => ({ title: 'A name shadows the import', file: 'src/booking/a.js', line: 1, severity, likelihood: 'routine', affects: 'users', state: 'open' });

test('the cap`s cause holds every flow left unheld, not only the judged stage`s: an independent-only violation refuses on the head and the next', async (t) => {
  const { r, capped, verdicts } = await capOnLocal(t, { payVerdict: 'violated', item: localItem('low') });
  assert.deepEqual(capped.flows ?? [], [], 'the local stage answers for booking alone');
  const cause = readLocalState(r.project, 7).outcome.cap;
  assert.deepEqual([cause.flows, cause.items.map((each) => [each.severity, each.stage]), cause.unrun], [['pay'], [['low', 'local']], []]);
  assert.match(capProblem(readLocalState(r.project, 7), capped.head) ?? '', /flow pay has an invariant violated, unverified, or unsigned/u);
  // A fix pushed past the cap: the round's whole cause, kept on it, is read again.
  r.write('src/booking/a.js', '3\n');
  const pushed = r.commit();
  assert.equal((await r.step({ exec: verdicts('violated') })).status, 'round_limit');
  const after = readLocalState(r.project, 7);
  assert.deepEqual([after.outcome.cap.head, after.outcome.cap.reviewed, after.outcome.cap.unsigned], [pushed, capped.head, ['pay']]);
  assert.match(capProblem(after, pushed) ?? '', /flow pay has an invariant violated/u);
  assert.ok(stateFromComment(r.comments[0].body, 7).rounds.every((round) => !('cap' in round)), 'the posted copy keeps no round cause');
});

test('a verdict may stand on a real two-stage cap whose last round left one listed medium local finding', async (t) => {
  const { r, capped } = await capOnLocal(t, { payVerdict: 'holds', item: localItem('medium') });
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.outcome.cap.flows, state.outcome.cap.unrun, state.outcome.cap.itemized], [[], [], true]);
  assert.equal(capProblem(state, capped.head), null);
});

test('a verdict may stand on a real single-stage cap: one medium finding of the exec reviewer in each round, on the cap and the next pushed head', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, extraRounds: 'off' } }, change: (write) => write('src/app.js', '1\n') });
  const finding = async () => ({ status: 'done', findings: [{ title: 'Refund total unchecked', file: 'src/app.js', line: 1, severity: 'medium', likelihood: 'routine', affects: 'users', cost: 'bounded', state: 'open' }], verdicts: [], dropped: [] });
  assert.equal((await r.step({ exec: finding })).status, 'fix_required');
  r.write('src/app.js', '2\n');
  r.commit();
  const capped = await r.step({ exec: finding });
  assert.equal(capped.status, 'round_limit');
  const state = readLocalState(r.project, 7);
  assert.deepEqual([state.outcome.cap.itemized, state.outcome.cap.unrun, state.outcome.cap.flows, state.outcome.cap.items.map((each) => each.severity)], [true, [], [], ['medium']]);
  assert.equal(capProblem(state, capped.head), null);
  r.write('src/app.js', '3\n');
  const pushed = r.commit();
  assert.equal((await r.step({ exec: finding })).status, 'round_limit');
  const again = readLocalState(r.project, 7);
  assert.equal(again.outcome.cap.reviewed, capped.head);
  assert.equal(capProblem(again, pushed), null, 'the fix no round reviewed: the last round`s medium finding decides');
});
