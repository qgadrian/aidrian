import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { flowState, invariantsOf } from '../plugins/aidrian/lib/review/flows.mjs';
import { reviewerMap, satisfies } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { parseChoice } from '../plugins/aidrian/lib/review/quota.mjs';
import { EXIT, recordAccept, recordPass, recordSignoff, recordStageSignoff, reviewInForce } from '../plugins/aidrian/lib/review/run.mjs';
import { checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { emptyState, readLocalState, stateFromComment, summaryBody } from '../plugins/aidrian/lib/review/state.mjs';
import { judgeMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';
import { runIngest, runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { repo, clean, OPEN, unverifiedNext, finding, scripted, found, toTheCap, extend, summaryOf, APPROVED_FLOWS } from './review-run-fixture.mjs';

test('a sign-off is refused for a flow the head does not ask the Human to sign, and before any review of the head', async (t) => {
  const flows = {
    pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:security-engineer'], signoff: 'human' },
    book: { files: ['src/book/**'], invariants: [{ id: 'one', text: 'One booking per slot.' }], require: ['agent:security-engineer'] },
  };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => (write('src/pay/a.js', 'export const refund = (x) => x;\n'), write('src/book/a.js', 'export const book = 1;\n')) });
  const head = r.git('rev-parse', 'HEAD');
  assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head, by: 'Tester' }), /no review of o\/r#7 ran on/u);
  await r.step({ exec: clean });
  assert.throws(() => recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'book', head, by: 'Tester' }), /flow book takes no Human sign-off .*only pay can be signed off/u);
  assert.equal(recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head, by: 'Tester' }).by, 'Tester');
});

test('a Human sign-off survives a push that touches nothing of the flow, and not one that does', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], invariants: [{ id: 'cap', text: 'A refund never exceeds the charge.' }], require: ['agent:security-engineer'], signoff: 'human' } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', 'export const refund = (x) => x;\n') });
  const attest = (dispatch, head) => recordPass(r.project, { pr: 7, repo: 'o/r', pass: dispatch.pass, head, reviewer: 'security-engineer', findings: 0, fixed: 0, verdictsText: JSON.stringify([{ flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/pay/a.js:1' }]) });
  const first = await r.step({ exec: clean });
  attest(first.dispatch[0], first.head);
  const asked = await r.step({ exec: clean });
  assert.equal(asked.status, 'human_required');
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'pay', head: first.head, by: 'Tester' });
  assert.equal((await r.step({ exec: clean })).status, 'received');

  r.write('src/other.js', 'export const other = 1;\n');
  r.commit('unrelated');
  const kept = await r.step({ exec: clean });
  assert.equal(kept.status, 'received', 'nothing since the signed head touches the flow');
  assert.match(r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body, /recorded on `[0-9a-f]{7}` and kept/u);

  r.write('src/pay/a.js', 'export const refund = (x) => Math.min(x, 10);\n');
  const touched = r.commit('touch the flow');
  const again = await r.step({ exec: clean });
  assert.equal(again.status, 'dispatch');
  attest(again.dispatch[0], touched);
  assert.equal((await r.step({ exec: clean })).status, 'human_required', 'a change to the flow asks the Human again');
});

test('the visual capture runs before the visual reviewers, attaches on a private repository, and its captures are flow evidence', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/components/**'], routes: ['/dashboard'] }], viewports: [360, 1280], checklist: 'docs/fit.md#fit-checks' };
  const flows = { ui: { files: ['src/components/**'], invariants: [{ id: 'fit', text: 'No horizontal overflow at the fit-check widths.' }], require: ['agent:designer'] } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows, visual } },
    baseFiles: { 'docs/fit.md': '# Fit\n\n## Fit checks\nNo page scrolls sideways at 360, 768, or 1280 px.\n' },
    change: (write) => write('src/components/Button.tsx', 'export const Button = () => <button className="px-2" />;\n'),
  });
  r.write('.aidrian.local.json', JSON.stringify({ review: { visual: { baseUrl: 'http://localhost:3000' } } }));
  const captureSpawn = (_node, _args, { input }) => {
    const job = JSON.parse(input);
    const results = job.entries.map((entry) => {
      const file = path.join(job.outDir, `${entry.key}.png`);
      writeFileSync(file, Buffer.concat([PNG, Buffer.from(entry.key)]));
      return { key: entry.key, file, facts: { status: 200, overflowX: null, clippedText: [], smallTargets: [] } };
    });
    return { status: 0, stdout: JSON.stringify({ results }), stderr: '' };
  };
  const uploads = [];
  r.forge.visibility = () => 'PRIVATE';
  // Every step of this pull request uploads through the step's forge, as the gh-image extension would: no `image` is given.
  r.forge.uploadImages = (_repo, files) => (uploads.push(files.length), files.map((file) => `![${path.basename(file, '.png')}](https://github.com/user-attachments/assets/u-${path.basename(file, '.png')})`).join('\n'));
  const step = (deps = {}) => r.step(deps);
  const first = await step({ exec: clean, captureSpawn });
  assert.equal(first.status, 'dispatch');
  const [pass] = first.dispatch;
  assert.equal(pass.agent, 'designer');
  assert.equal(pass.visual.status, 'captured');
  assert.deepEqual(pass.visual.captures.map((capture) => [capture.key, Boolean(capture.url)]), [['dashboard-89347b--360--default--default', true], ['dashboard-89347b--1280--default--default', true]]);
  assert.match(pass.visual.checklist.text, /sideways/u);
  assert.match(pass.record, /--findings-file/u);
  assert.match(pass.brief, /captures in `visual`/u);
  assert.deepEqual(uploads, [2]);
  assert.ok(r.comments.some((c) => c.body.startsWith('<!-- aidrian-visual-captures -->') && /Attach: \*\*auto\*\*, private repository/u.test(c.body)));
  assert.equal((await step({ exec: clean, captureSpawn: () => assert.fail('captured twice') })).status, 'dispatch', 'one capture per head');

  const findings = JSON.stringify([{ title: 'Label clipped at 360px', severity: 'medium', likelihood: 'routine', affects: 'users', state: 'open' }]);
  const verdict = (evidence) => JSON.stringify([{ flow: 'ui', invariant: 'fit', verdict: 'holds', evidence }]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: findings, verdictsText: verdict('capture:dashboard-89347b--360--default--default') });
  const blocked = await step({ exec: clean });
  assert.equal(blocked.status, 'fix_required');
  assert.equal(blocked.open[0].findings[0].title, 'Label clipped at 360px');
  assert.deepEqual(blocked.flows, [], 'a capture of this head is evidence');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: verdict('capture:dashboard-89347b--768--default--default') });
  const unknown = await step({ exec: clean });
  assert.deepEqual(unknown.flows, [{ flow: 'ui', violated: [], unverified: ['fit'], next: [unverifiedNext('ui', 'fit', first.head, [`designer answered holds, but its evidence does not count (no capture "dashboard-89347b--768--default--default" of ${first.head.slice(0, 7)}): dispatch that reviewer again to cite path:line, test:<name>, or capture:<key>, which closes this with no sign-off`])] }], 'a capture key the manifest does not have is no evidence; with captures of the head, no capture line');
  assert.match(r.comments.find((c) => c.body.startsWith('<!-- aidrian-review-summary -->')).body, /visual capture of `[0-9a-f]{7}`: captured \(2 of 2\); attach \*\*auto\*\*, private repository/u);

  // A clean pass whose verdict cites a capture carries forward over a push that touches nothing of it, and still
  // counts on a machine without the images: the record holds the captured keys.
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: verdict('capture:dashboard-89347b--360--default--default') });
  assert.equal((await step({ exec: clean })).status, 'received');
  r.write('docs/notes.md', 'notes\n');
  r.commit('docs only');
  const { captureDir } = await import('../plugins/aidrian/lib/review/visual.mjs');
  rmSync(captureDir(r.project, 7, first.head), { recursive: true, force: true });
  const carried = await step({ exec: clean });
  assert.equal(carried.status, 'received', 'the earlier head\'s capture evidence still holds');
});

test('an invariant that cites a doc section carries that section as its source, read from the base, and a change to the doc needs the Human', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: [{ id: 'no-double', cite: 'docs/flows/booking.md#no-double-booking' }], require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
    write('src/booking/book.js', 'export const book = () => 1;\n');
    write('docs/flows/booking.md', '# Booking\n\n## No double booking\nRewritten by the pull request.\n');
  } });
  const first = await r.step({ exec: clean });
  const invariant = first.dispatch.find((each) => each.agent === 'product-manager').flows.find((flow) => flow.id === 'booking').invariants[0];
  assert.equal(invariant.text, 'Does the change keep "No double booking" as the cited section defines it?');
  assert.match(invariant.source, /^No double booking\n\nTwo bookings never hold one slot\.$/u, 'the base branch\'s section, not the pull request\'s');
  assert.ok(first.plan.flows.includes('harness-config'), 'the cited doc changed');
});

test('an edit to a cited doc outside the cited section needs no Human; inside it, or renaming its heading, does', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: [{ id: 'no-double', cite: 'docs/flows/booking.md#no-double-booking' }], require: ['agent:product-manager'] } };
  const plan = async (doc) => {
    const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
      write('src/booking/book.js', 'export const book = () => 1;\n');
      write('docs/flows/booking.md', doc);
    } });
    return (await r.step({ exec: clean })).plan.flows;
  };
  const outside = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge, ever.\n');
  assert.ok(!outside.includes('harness-config'), 'only the refund section changed');
  const appended = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n\n## Alerts\nNew.\n');
  assert.ok(!appended.includes('harness-config'), 'a section added after the cited one');
  const inside = await plan('# Booking\n\n## No double booking\nTwo bookings may share a slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(inside.includes('harness-config'), 'the cited section changed');
  const renamed = await plan('# Booking\n\n## No overlapping booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(renamed.includes('harness-config'), 'the cited heading is gone');
  const split = await plan('# Booking\n\n## No double booking\n\n## Split\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(split.includes('harness-config'), 'a heading inserted inside the cited section moves its text out, though no line of it changed');
  const tail = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Split\n\n## Refund cap\nA refund never exceeds the charge.\n');
  assert.ok(!tail.includes('harness-config'), 'a heading added after all of its text leaves the cited text as it was');
  const merged = await plan('# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\nA refund never exceeds the charge.\n');
  assert.ok(merged.includes('harness-config'), 'the next heading removed: the cited section now runs on');
});

test('a flow whose invariants doc is cited whole still needs the Human for any edit to it', async (t) => {
  const flows = { booking: { files: ['src/booking/**'], invariants: 'docs/flows/booking.md', require: ['agent:product-manager'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => {
    write('src/booking/book.js', 'export const book = () => 1;\n');
    write('docs/flows/booking.md', '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n\n## Refund cap\nA refund never exceeds the charge, ever.\n');
  } });
  assert.ok((await r.step({ exec: clean })).plan.flows.includes('harness-config'));
});

test('a sign-off of harness-config does not survive a push that changes a project reviewer\'s script', async (t) => {
  const reviewers = { lint: { kind: 'exec', command: ['scripts/review-lint.sh'], stage: 'local' } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { reviewers } },
    baseFiles: { 'scripts/review-lint.sh': '#!/bin/sh\necho \'{"findings":[]}\'\n' },
    change: (write) => write('scripts/review-lint.sh', '#!/bin/sh\necho \'{"findings":[]}\' # v2\n'),
  });
  const verdicts = JSON.stringify([{ flow: 'harness-config', invariant: 'review-not-weakened', verdict: 'holds', evidence: 'scripts/review-lint.sh:1' }]);
  const exec = async () => ({ status: 'done', findings: [], verdicts: [{ flow: 'harness-config', invariant: 'review-not-weakened', verdict: 'holds', evidence: 'scripts/review-lint.sh:1' }], dropped: [] });
  // Runs steps, recording every dispatched agent pass as clean, until the review stops for something else.
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) {
      const result = await r.step({ exec });
      if (result.status !== 'dispatch') return result;
      for (const each of result.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: each.pass, head: result.head, reviewer: each.agent, findings: 0, fixed: 0, verdictsText: verdicts });
    }
    throw new Error('the review did not settle');
  };
  const asked = await settle();
  assert.equal(asked.status, 'human_required');
  assert.deepEqual(asked.flows, ['harness-config']);
  recordSignoff(r.project, { pr: 7, repo: 'o/r', flow: 'harness-config', head: asked.head, by: 'Tester' });
  assert.equal((await settle()).status, 'received');
  r.write('src/other.js', 'export const other = 1;\n');
  r.commit('unrelated');
  assert.equal((await settle()).status, 'received', 'an unrelated push keeps the sign-off');
  r.write('scripts/review-lint.sh', '#!/bin/sh\necho \'{"findings":[]}\' # v3\n');
  r.commit('change the reviewer again');
  assert.equal((await settle()).status, 'human_required', 'the reviewer script changed since the sign-off');
});

test('extra rounds "ask": a converging review at the cap dispatches the judge, then asks the Human, and a grant is one round', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  assert.equal(EXIT.extension_check, 10);
  assert.deepEqual(capped.dispatch.map((each) => [each.pass, each.agent]), [['extension-judge', 'code-reviewer']]);
  assert.match(capped.dispatch[0].record, new RegExp(`aidrian pr extend 7 --verdict extend\\|stop --reason "<evidence>" --head ${capped.head}`));
  assert.deepEqual(capped.extension.history.map((round) => [round.round, round.open]), [[1, 2], [2, 1]], 'each round keeps its open findings');
  assert.deepEqual([capped.extension.signals.converging, capped.extension.mode, capped.extension.max_extra], [true, 'ask', 2]);
  assert.deepEqual(capped.extension.files, ['src/booking/a.js']);
  assert.equal(capped.open[0].open, 1, 'the work left is still named');

  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 is a real high-severity bug', '--head', capped.head]);
  assert.deepEqual([verdict.code, verdict.out.extension.status], [0, 'asking']);
  const ask = await r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask');
  assert.equal(EXIT.extension_ask, 11);
  assert.equal(ask.question, 'Pull request o/r#7 reached its review-round cap. Grant one extra review round, round 3?', 'it names the repository, which the review-extend rule binds the answer to');
  assert.deepEqual(ask.options, ['Approve round 3', 'Deny']);
  assert.equal(ask.max_rounds, 2, 'asking grants nothing yet');

  await extend(t, r, ['--human', 'approve']);
  const granted = await r.step({ exec: clean });
  assert.deepEqual([granted.status, granted.max_rounds], ['fix_required', 3], 'the granted round lets a fix take a new head');
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  assert.deepEqual([three.status, three.round, three.max_rounds], ['dispatch', 3, 3]);
  const state = readLocalState(r.project, 7);
  assert.deepEqual(state.extensions.map((entry) => [entry.round, entry.status, entry.by, entry.human?.by]), [[2, 'granted', 'human', 'Tester']]);
  assert.match(r.comments[0].body, /\*\*Extra rounds:\*\*\n- round 2 on `[0-9a-f]{7}`: granted by the Human \(Tester; an audit entry, not proof\)/u);
});

test('the merge guard reads the open count the step at the cap wrote, on the capped head only', async (t) => {
  const guard = (r, head) => judgeMerge({ project: projectAt(r.dir), pr: 7, head, viewPr: () => null, answers: [] }) ?? '';
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  assert.match(guard(r, capped.head), /is `extension_check`: stopped at its round limit, with 1 finding open, and not running\./u);
  // A fix pushed after round 2: the cap meets a head no round reviewed, so the last round's count is not this head's.
  const fixed = await toTheCap(t, {}, { fixFirst: true });
  assert.equal(fixed.capped.status, 'extension_check');
  const reason = guard(fixed.r, fixed.capped.head);
  assert.match(reason, /is `extension_check`: stopped at its round limit, and not running\./u);
  assert.match(reason, /stopped at its round limit\. Ship, and file what it left open as an issue\?/u);
  assert.doesNotMatch(reason, /findings? open/u);
});

test('extra rounds: a fix pushed past the cap reaches the judge as unreviewed, and a stop says so on the pull request', async (t) => {
  const { r, capped, last } = await toTheCap(t, {}, { fixFirst: true });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.unreviewed_head, { head: capped.head, from: last, fix: { added: 1, removed: 1, files: ['src/booking/a.js'], code_added: 1 } });
  assert.deepEqual(readLocalState(r.project, 7).extensions[0].unreviewed, { head: capped.head, from: last });
  await extend(t, r, ['--verdict', 'stop', '--reason', 'the finding was low severity']);
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.unreviewed_head], ['round_limit', true]);
  assert.match(r.comments[0].body, new RegExp(`- fix head \`${capped.head.slice(0, 7)}\`, pushed after round 2 on \`${last.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds: a fix pushed after the judge`s stop keeps the stop, and the result names the fix as unreviewed', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  await extend(t, r, ['--verdict', 'stop', '--reason', 'the finding is a nit']);
  const before = await r.step({ exec: clean });
  assert.deepEqual([before.status, 'unreviewed_head' in before], ['round_limit', false], 'round 2 reviewed the head the stop was for');
  r.write('src/booking/a.js', '3\n');
  const pushed = r.commit('a fix after the stop');
  const after = await r.step({ exec: clean });
  assert.deepEqual([after.status, after.extension.by, after.unreviewed_head], ['round_limit', 'judge', true]);
  assert.match(r.comments[0].body, new RegExp(`- round 2 on \`${capped.head.slice(0, 7)}\`: stopped by the judge: the finding is a nit\\n- fix head \`${pushed.slice(0, 7)}\`, pushed after round 2 on \`${capped.head.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds "ask" on an unreviewed fix: the question names the fix, aidrian pr extend prints the same, and a grant reviews it', async (t) => {
  const { r, capped } = await toTheCap(t, {}, { fixFirst: true });
  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'src/booking/a.js:1 was a valid high finding; the fix is one line', '--head', capped.head]);
  const ask = await r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask');
  assert.equal(ask.question, `Pull request o/r#7 reached its review-round cap, and its fix head ${capped.head.slice(0, 7)} is reviewed by no pass. Grant one extra review round, round 3, to review that fix?`);
  assert.ok(verdict.out.next.includes(`"${ask.question}"`), 'the verdict`s next step asks the same question');
  assert.doesNotMatch(r.comments[0].body, /is reviewed by no pass/u, 'a check waiting for the Human is no stop');
  await extend(t, r, ['--human', 'approve']);
  const three = await r.step({ exec: clean });
  assert.deepEqual([three.status, three.round, three.max_rounds, three.head], ['dispatch', 3, 3, capped.head], 'round 3 reviews the fix');
  assert.doesNotMatch(r.comments[0].body, /is reviewed by no pass/u, 'a granted round is no stop');
});

test('extra rounds: at the ceiling, a fix pushed after the last round is named as unreviewed', async (t) => {
  const { r } = await toTheCap(t, { extraRounds: 'auto', maxExtraRounds: 1 });
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid high finding']);
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: three.dispatch[0].pass, head: three.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const ceiling = await r.step({ exec: clean });
  assert.deepEqual([ceiling.status, ceiling.extension.by, 'unreviewed_head' in ceiling], ['round_limit', 'ceiling', false], 'round 3 reviewed this head');
  r.write('src/booking/a.js', '4\n');
  const pushed = r.commit('a fix past the ceiling');
  const after = await r.step({ exec: clean });
  assert.deepEqual([after.status, after.extension.by, after.unreviewed_head], ['round_limit', 'ceiling', true]);
  assert.match(r.comments[0].body, new RegExp(`- round 3 on \`${three.head.slice(0, 7)}\`: stopped by the ceiling[^\\n]*\\n- fix head \`${pushed.slice(0, 7)}\`, pushed after round 3 on \`${three.head.slice(0, 7)}\`, is reviewed by no pass`, 'u'));
});

test('extra rounds: a last round that opens on a new head and reaches the cap in the same run is no unreviewed head', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 } }, change: (write) => write('src/app.js', 'export const app = 2;\n') });
  const item = (line, title) => ({ file: 'src/app.js', line, title, body: 'x', severity: 'high' });
  const found = [[item(1, 'Null refund total'), item(40, 'Missing lock on save')], [item(80, 'Wrong currency rounding')]];
  let call = 0;
  const exec = async () => ({ status: 'done', findings: found[call++], verdicts: [], dropped: [] });
  assert.equal((await r.step({ exec })).status, 'fix_required');
  r.write('src/app.js', 'export const app = 3;\n');
  r.commit();
  const capped = await r.step({ exec });
  assert.deepEqual([call, capped.round], [2, 2], 'round 2 opened and ran its reviewer in this run');
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.ok(!('unreviewed_head' in capped.extension), 'round 2 reviewed this head');
  assert.equal(readLocalState(r.project, 7).extensions[0].unreviewed, undefined);
});

test('extra rounds "auto": the judge`s extend grants the round without the Human', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'auto' });
  assert.equal(capped.status, 'extension_check');
  const verdict = await extend(t, r, ['--verdict', 'extend', '--reason', 'valid medium finding at src/booking/a.js:1']);
  assert.equal(verdict.out.extension.status, 'granted');
  assert.match(verdict.out.next, /round 3 is granted: run aidrian pr review 7/u);
  assert.deepEqual([(await r.step({ exec: clean })).status], ['fix_required']);
});

test('extra rounds: the judge`s stop and "off" leave round_limit; a red flag goes to the judge, then the Human', async (t) => {
  const judged = await toTheCap(t, {});
  await extend(t, judged.r, ['--verdict', 'stop', '--reason', 'the fixes over-engineer the refund path']);
  const stopped = await judged.r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.extension.status, stopped.extension.by, stopped.extension.reasons], ['round_limit', 'stopped', 'judge', ['the fixes over-engineer the refund path']]);

  const flat = await toTheCap(t, { extraRounds: 'auto' }, { first: 1, second: 1 });
  assert.equal(flat.capped.status, 'extension_check', 'not converging is no dead end: the judge reads it');
  assert.deepEqual([flat.capped.extension.by, flat.capped.extension.signals.converging], [null, false]);
  assert.match(flat.capped.extension.red_flags[0], /^not converging: round 2 left 1 open finding, round 1 left 1/u);
  assert.match(flat.capped.dispatch[0].brief, /extension\.red_flags/u);
  await extend(t, flat.r, ['--verdict', 'extend', '--reason', 'the open finding is a valid high']);
  const ask = await flat.r.step({ exec: clean });
  assert.equal(ask.status, 'extension_ask', 'under "auto", an extend over a red flag still needs the Human');
  assert.match(ask.question, /red flags \(not converging\)[\s\S]*round 3\?$/u);
  assert.doesNotMatch(ask.question, /round [12]\b/u, 'the question names no round but the one it grants');
  await extend(t, flat.r, ['--human', 'approve']);
  assert.equal((await flat.r.step({ exec: clean })).max_rounds, 3, 'the Human`s approval opens the round');
  flat.r.write('src/booking/a.js', '3\n');
  flat.r.commit('the fix the round was granted for');
  const three = await flat.r.step({ exec: clean });
  assert.deepEqual([three.round, three.max_rounds, three.dispatch?.length > 0], [3, 3, true], 'the push the round was granted for keeps the grant: the flag is not new');

  const off = await toTheCap(t, { extraRounds: 'off' });
  assert.deepEqual([off.capped.status, off.capped.extension], ['round_limit', { status: 'off', mode: 'off' }]);
});

test('extra rounds: the policy is the base branch`s, so a working-copy edit cannot turn it on or raise the ceiling', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'off' });
  assert.equal(capped.status, 'round_limit');
  r.write('.aidrian/config.json', JSON.stringify({ version: 1, github: { maxReviewRounds: 2, extraRounds: 'auto', maxExtraRounds: 9 } }));
  const again = await r.step({ exec: clean });
  assert.deepEqual([again.status, again.extension.status], ['round_limit', 'off']);
});

test('extra rounds: github.maxExtraRounds is a hard ceiling, and the check repeats at each new cap', async (t) => {
  const { r, capped } = await toTheCap(t, { extraRounds: 'auto', maxExtraRounds: 1 });
  assert.equal(capped.status, 'extension_check');
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid high finding']);
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '3\n');
  r.commit();
  const three = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: three.dispatch[0].pass, head: three.head, reviewer: 'code-reviewer', findings: 0, fixed: 0 });
  const again = await r.step({ exec: clean });
  assert.equal(again.round, 3);
  assert.deepEqual([again.status, again.extension.by, again.extension.round], ['round_limit', 'ceiling', 3]);
  assert.match(again.extension.reasons[0], /1 extra round granted already, and github\.maxExtraRounds is 1/u);
});

// A fix that grows the change past the bloat limit: 60 new lines, against the one line the pull request first added.
const bloat = (r) => {
  r.write('src/booking/a.js', `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\n`);
  return r.commit('a large fix');
};

test('extra rounds: a push after the judge`s extend is read again; a new red flag goes back to the judge, none keeps the question, and a stale approval is refused', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid', '--head', capped.head]);
  assert.equal((await r.step({ exec: clean })).status, 'extension_ask');
  const pushed = bloat(r);
  await assert.rejects(extend(t, r, ['--human', 'approve']), new RegExp(`the check was for ${capped.head.slice(0, 7)}, and the pull request is at ${pushed.slice(0, 7)} now`, 'u'));
  const stopped = await r.step({ exec: clean });
  assert.deepEqual([stopped.status, stopped.extension.status, stopped.extension.by, stopped.extension.signals.bloating], ['extension_check', 'judging', null, true]);
  assert.match(stopped.extension.reasons.at(-1), new RegExp(`read again on ${pushed.slice(0, 7)}, pushed after the decision on ${capped.head.slice(0, 7)}`, 'u'));

  const clean2 = await toTheCap(t, {});
  await extend(t, clean2.r, ['--verdict', 'extend', '--reason', 'valid']);
  clean2.r.write('src/booking/a.js', '3\n');
  const small = clean2.r.commit('a small fix');
  const back = await clean2.r.step({ exec: clean });
  assert.deepEqual([back.status, back.extension.status], ['extension_ask', 'asking'], 'a push with no new red flag keeps the question waiting');
  const approved = await extend(t, clean2.r, ['--human', 'approve']);
  assert.deepEqual([approved.code, approved.out.extension.status, approved.out.extension.head], [0, 'granted', small], 'the approval records on the pushed head with no second judge run');
});

// A quiet push moves a round to a new head. The checks at the cap still measure the round from the head it first
// reviewed, and still read the head it stands on now as the one it reviewed.
test('extra rounds: a round is measured from its first head, so what a quiet push added is its fix', async (t) => {
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag}(${i});\n`).join('');
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2, extraRounds: 'ask' } }, change: (write) => write('src/app.js', lines(10, 'first')) });
  const inTest = { file: 'test/app.test.js', line: 1, title: 'a test asserts nothing', body: 'x', severity: 'high' };
  const seen = scripted(found(finding), found(), found(inTest), found(inTest));
  assert.equal((await r.step({ exec: seen.exec })).status, 'fix_required');

  r.write('test/app.test.js', lines(100, 'check'));
  const quiet = r.commit('a quiet push');
  assert.deepEqual([(await r.step({ exec: seen.exec })).round, readLocalState(r.project, 7).rounds[0].head], [1, quiet], 'the round moved');

  r.write('src/app.js', lines(10, 'first') + lines(50, 'fix'));
  const fix = r.commit('the fix');
  const capped = await r.step({ exec: seen.exec });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.original_files, ['src/app.js'], 'a file the quiet push added is not one the pull request first changed');
  assert.deepEqual(capped.extension.signals.evidence.bloating, { fix_added: 150, fix_added_all: 150, original_added: 10, limit: 40 }, 'the quiet lines are fix growth');
  assert.deepEqual([capped.extension.signals.bloating, capped.extension.signals.drifting], [true, true]);
  assert.deepEqual(capped.extension.history.map((round) => [round.round, round.head, round.fix.added]), [[1, quiet, 150], [2, fix, 0]]);

  r.write('test/app.test.js', lines(100, 'check') + lines(20, 'more'));
  const lastQuiet = r.commit('a quiet push in the last round');
  const moved = await r.step({ exec: seen.exec });
  assert.equal(moved.status, 'extension_check', JSON.stringify(moved.extension?.reasons));
  assert.deepEqual(moved.extension.history.map((round) => [round.round, round.head, round.fix.added]), [[1, quiet, 150], [2, lastQuiet, 20]], 'each fix ends at the next round\'s first head');
  assert.ok(!('unreviewed_head' in moved.extension), 'the last round reviewed the head it moved to');
  assert.equal(readLocalState(r.project, 7).extensions[0].unreviewed, undefined);

  r.write('src/app.js', lines(10, 'first') + lines(51, 'fix'));
  const loud = r.commit('a fix no round reviewed');
  const past = await r.step({ exec: seen.exec });
  assert.deepEqual([past.extension.unreviewed_head?.head, past.extension.unreviewed_head?.from], [loud, lastQuiet], 'it names the head the last round reviewed');
  assert.deepEqual(past.extension.unreviewed_head.fix, { added: 1, removed: 0, files: ['src/app.js'], code_added: 1 }, 'its fix is that push alone, not what the quiet push before it added');
  assert.equal(past.extension.history.at(-1).fix.added, 21, 'the signals still measure the round from its first head');
  assert.equal(past.extension.signals.evidence.bloating.fix_added, 171);
  assert.equal(JSON.stringify(past.extension.history).includes('reviewed_fix'), false, 'the judge reads one fix per round');

  r.write('src/app.js', lines(10, 'first') + lines(50, 'fix'));
  r.write('test/app.test.js', lines(100, 'check'));
  r.commit('drop what the last quiet push added');
  const undone = await r.step({ exec: seen.exec });
  assert.deepEqual(undone.extension.unreviewed_head.fix, { added: 0, removed: 20, files: ['test/app.test.js'], code_added: 0 }, 'a push that deletes reviewed lines is no empty fix');
  assert.equal(undone.extension.history.at(-1).fix.added, 0, 'against the first head it reads as nothing');
});

test('extra rounds: a grant whose round has not opened goes back to the judge when the next head raises a red flag', async (t) => {
  const { r } = await toTheCap(t, { extraRounds: 'auto' });
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid']);
  assert.equal((await r.step({ exec: clean })).max_rounds, 3, 'granted');
  bloat(r);
  const revoked = await r.step({ exec: clean });
  assert.deepEqual([revoked.status, revoked.max_rounds, revoked.round, revoked.extension.by], ['extension_check', 2, 2, null], 'round 3 does not open on the judge`s old word');
});

test('extra rounds: aidrian pr extend writes the summary comment, so another machine continues from it', async (t) => {
  const { r, capped } = await toTheCap(t, {});
  assert.equal(capped.status, 'extension_check');
  const local = path.join(stateDir(r.project), 'reviews', 'pr-7-review-o--r.json');
  rmSync(local);
  await extend(t, r, ['--verdict', 'extend', '--reason', 'valid', '--head', capped.head]);
  assert.equal(r.comments.length, 1, 'the one summary comment, edited in place');
  assert.equal(stateFromComment(r.comments[0].body, 7).extensions[0].status, 'asking');
  assert.match(r.comments[0].body, /### ⏸️ Review: extension_check[\s\S]*- round 2 on `[0-9a-f]{7}`: asking by the judge: valid/u, 'the review step`s text stays; the list follows the record');
  rmSync(local);
  assert.equal((await r.step({ exec: clean })).status, 'extension_ask', 'the verdict came back from the pull request');
  rmSync(local);
  await extend(t, r, ['--human', 'approve']);
  rmSync(local);
  assert.deepEqual([(await r.step({ exec: clean })).max_rounds], [3], 'so did the approval');
});

test('--with-bot: the bot is held to the plan`s cap; a cap an earlier request recorded counts only under the Human`s override', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const seen = [];
  const awaitBot = async (opts) => (seen.push([opts.maxRounds, opts.keepRecordedCap]), { status: 'received', requested: true, signal: { kind: 'thumbs_up' } });
  await r.step({ exec: clean, awaitBot, env: {} }, { withBot: true });
  const other = repo(t, { change: (write) => write('src/app.js', '8\n') });
  await other.step({ exec: clean, awaitBot, env: { AIDRIAN_ALLOW_EXTRA_ROUNDS: '1' } }, { withBot: true });
  assert.deepEqual(seen, [[3, false], [3, true]]);
  // #235: an approved raise runs at exactly its --max-rounds, so a higher cap an earlier request recorded never counts.
  const raised = repo(t, { change: (write) => write('src/app.js', '7\n') });
  await raised.step({ exec: clean, awaitBot, env: { AIDRIAN_ALLOW_EXTRA_ROUNDS: '1' } }, { withBot: true, maxRounds: 6 });
  assert.deepEqual(seen.at(-1), [6, false]);
});

test('extra rounds: a finding attested as fixed is not an open finding of its round, so it never reads as a loop', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const r = repo(t, { baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } }, change: (write) => write('src/booking/a.js', '1\n') });
  const item = (title, line, state) => ({ title, file: 'src/booking/a.js', line, severity: 'high', likelihood: 'routine', affects: 'users', state });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([item('Null refund total', 10, 'open'), item('Missing lock on save', 60, 'open')]) });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  r.write('src/booking/a.js', '2\n');
  r.commit();
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findingsText: JSON.stringify([item('Null refund total', 10, 'fixed'), item('Wrong currency rounding', 120, 'open')]) });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.history.map((round) => [round.open, round.findings.map((each) => each.title)]), [[2, ['Null refund total', 'Missing lock on save']], [1, ['Wrong currency rounding']]]);
  assert.deepEqual([capped.extension.signals.converging, capped.extension.signals.looping], [true, false]);
});

test('extra rounds: merging the base branch in between rounds is no fix, even in a file the pull request changes', async (t) => {
  const flows = { booking: { files: ['src/booking/**'] } };
  const lines = (first) => `${[first, ...Array.from({ length: 9 }, (_, i) => `keep ${i}`)].join('\n')}\n`;
  const r = repo(t, {
    baseConfig: { version: 1, github: { maxReviewRounds: 2 }, review: { flows } },
    baseFiles: { 'src/booking/a.js': lines('start') },
    change: (write) => write('src/booking/a.js', lines('changed')),
  });
  const one = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: one.dispatch[0].pass, head: one.head, reviewer: 'code-reviewer', findings: 2, fixed: 0 });
  assert.equal((await r.step({ exec: clean })).status, 'fix_required');
  // The base gains 100 lines at the end of the same file, and the branch merges it in.
  r.git('switch', '-q', 'main');
  r.write('src/booking/a.js', `${lines('start')}${Array.from({ length: 100 }, (_, i) => `base ${i}`).join('\n')}\n`);
  r.commit('base grows');
  r.git('switch', '-q', 'feat');
  r.git('merge', '-q', '--no-edit', 'main');
  const two = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: two.dispatch[0].pass, head: two.head, reviewer: 'code-reviewer', findings: 1, fixed: 0 });
  const capped = await r.step({ exec: clean });
  assert.equal(capped.status, 'extension_check', JSON.stringify(capped.extension?.reasons));
  assert.deepEqual(capped.extension.history.map((round) => round.fix?.added), [0, 0], 'the merge added nothing of the pull request`s own');
  assert.equal(capped.extension.signals.bloating, false);
});

test('--with-bot: a request on an extra round is for the plan`s head only; for a moved head the step asks to run again', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', '9\n') });
  const seen = [];
  const awaitBot = async (opts) => (seen.push([opts.validHead, opts.grantFloor]), { status: 'head_moved', requested: false, head_sha: 'f'.repeat(40) });
  const moved = await r.step({ exec: clean, awaitBot, env: {} }, { withBot: true });
  assert.deepEqual([moved.status, moved.retry_recommended], ['incomplete', true]);
  assert.match(moved.reason, /moved to fffffff before the request on an extra round/u);
  assert.deepEqual(seen, [[moved.head, 3]], 'the grant floor is the cap without grants');
});

// Out of quota (lib/review/quota.mjs): the Human's choice replaces the stopped passes, for the head it stopped on only.
const outOfQuota = async () => ({ status: 'quota', reason: 'You hit your usage limit' });

test('out of quota with no flag: blocked_quota asks one question, and the next call runs the reviewer again', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 5;\n') });
  let ran = 0;
  const exec = async () => (ran += 1, outOfQuota());
  const first = await r.step({ exec });
  assert.deepEqual([first.status, first.pass, EXIT[first.status]], ['blocked_quota', 'engine:codex-local', 3]);
  assert.match(first.question, /^Codex is out of quota, so the independent review of pull request o\/r#7 stopped on head [0-9a-f]{7}\..*never as an independent review\.$/u);
  assert.deepEqual(first.options.map((each) => each.label), ['Run a critic agent (Recommended)', 'The Human reviews it', 'Wait for Codex quota']);
  assert.deepEqual(first.options.map((each) => each.run), ['aidrian pr review 7 --quota-fallback agent:critic', 'aidrian pr review 7 --quota-fallback human', null]);
  assert.equal(first.quota_fallback, undefined);
  const again = await r.step({ exec });
  assert.deepEqual([again.status, ran], ['blocked_quota', 2], 'nothing picks a fallback by itself: the reviewer runs again');
  assert.equal(again.dispatch, undefined);
  assert.deepEqual(readLocalState(r.project, 7).quotaStops.map((stop) => [stop.stage, stop.reviewer, stop.choice]), [['independent', 'codex-local', null]], 'one stop per head and stage');
  assert.match(summaryOf(r), /Codex was out of quota on `[0-9a-f]{7}`, and the independent stage stopped: nothing replaced it/u);
  r.write('src/app.js', 'export const app = 6;\n');
  r.commit();
  await assert.rejects(r.step({ exec }, { quotaFallback: 'agent:critic' }), /no quota stop is on record for head [0-9a-f]{7} of #7/u, 'the flag answers a stop on the current head only');
  assert.throws(() => parseChoice('agent:'), /--quota-fallback must be/u);
  assert.throws(() => parseChoice('codex'), /--quota-fallback must be/u);
});

test('out of quota, the critic as the fallback: a dispatch in the stopped pass`s place, recorded as no independent review', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 7;\n') });
  let ran = 0;
  const exec = async () => (ran += 1, outOfQuota());
  assert.equal((await r.step({ exec })).status, 'blocked_quota');
  const fallback = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, fallback.stage, ran], ['dispatch', 'independent', 1], 'Codex is not asked again on this head');
  const [pass] = fallback.dispatch;
  assert.deepEqual([pass.pass, pass.agent, pass.fallback.replaces, pass.context, pass.files], ['fallback:independent:codex-local:critic', 'critic', 'codex-local', 'full', null]);
  assert.match(pass.brief, /Codex is out of quota.*recorded as a fallback, not as an independent review/u);
  assert.match(pass.record, /^aidrian pr attest 7 --pass fallback:independent:codex-local:critic --head [0-9a-f]{40} --reviewer critic /u);
  assert.match(fallback.quota_fallback[0].note, /ran on a fallback the Human chose: the critic agent, on the session's own model\. This is not an independent review\./u);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 1, fixed: 0 });
  const open = await r.step({ exec });
  assert.deepEqual([open.status, open.open.map((each) => each.pass)], ['fix_required', ['fallback:independent:codex-local:critic']], 'its findings block like any pass');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 1, fixed: 1 });
  const done = await r.step({ exec });
  assert.deepEqual([done.status, done.quota_fallback[0].choice, ran], ['received', 'agent:critic', 1]);
  assert.match(summaryOf(r), /Codex was out of quota on `[0-9a-f]{7}`, so the independent stage ran on a fallback the Human chose: the critic agent, on the session's own model\. This is not an independent review\./u);
  assert.equal(stateFromComment(summaryOf(r), 7).quotaStops[0].choice, 'agent:critic', 'the record another machine reads holds the choice');

  r.write('src/app.js', 'export const app = 8;\n');
  r.commit();
  const next = await r.step({ exec: async () => (ran += 1, clean()) });
  assert.deepEqual([next.status, ran, next.quota_fallback], ['received', 2, undefined], 'a later push runs Codex again');
});

test('out of quota with --with-bot: the review bot`s usage limit is a stop the critic can stand in for too', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 9;\n') });
  const awaitBot = async () => ({ status: 'blocked_quota', requested: true, reason: 'Codex usage limits reached' });
  const stopped = await r.step({ exec: clean, awaitBot }, { withBot: true });
  assert.deepEqual([stopped.status, stopped.pass, stopped.options[0].run], ['blocked_quota', 'engine:pr-bot', 'aidrian pr review 7 --with-bot --quota-fallback agent:critic']);
  const fallback = await r.step({ exec: clean, awaitBot }, { withBot: true, quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, fallback.stage, fallback.dispatch[0].pass], ['dispatch', 'remote', 'fallback:remote:pr-bot:critic']);
});

test('out of quota, the Human`s review: the stage waits for the Human`s own sign-off, then passes, said as no independent review', async (t) => {
  const r = repo(t, { change: (write) => write('src/app.js', 'export const app = 10;\n') });
  assert.equal((await r.step({ exec: outOfQuota })).status, 'blocked_quota');
  const head = r.git('rev-parse', 'HEAD');
  assert.throws(() => recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head, by: 'Tester' }), /no Human review of the independent stage is waiting/u, 'a stage sign-off never skips a reviewer the Human did not replace');
  const asked = await r.step({ exec: outOfQuota }, { quotaFallback: 'human' });
  assert.deepEqual([asked.status, asked.stage, asked.flows, asked.command, EXIT[asked.status]], ['human_required', 'independent', [], [`aidrian pr signoff 7 --stage independent --head ${head}`], 9]);
  assert.match(summaryOf(r), /the Human chose to review the independent stage; their sign-off is needed\. This is not an independent review\./u);
  recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head, by: 'Tester' });
  const done = await r.step({ exec: outOfQuota });
  assert.deepEqual([done.status, done.quota_fallback[0].signed_off_by], ['received', 'Tester']);
  assert.match(summaryOf(r), /so the Human reviewed the independent stage instead, signed off by Tester \(an audit entry, not proof\)\. This is not an independent review\./u);
});

test('out of quota where the plan requires an independent model: no fallback is offered, and none meets the rule', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const blocked = await r.step({ exec: outOfQuota });
  assert.deepEqual([blocked.status, blocked.question, blocked.options], ['blocked_quota', undefined, undefined]);
  assert.match(blocked.fallback_refused, /requires an independent model.*neither a same-model agent nor the Human's sign-off counts as one/u);
  for (const choice of ['agent:critic', 'human']) {
    const refused = await r.step({ exec: outOfQuota }, { quotaFallback: choice });
    assert.equal(refused.status, 'unsatisfied', choice);
    assert.match(refused.reason, /requires an independent model/u);
  }
  assert.equal(readLocalState(r.project, 7).quotaStops.at(-1).choice, null, 'a refused choice is not recorded');

  // Whatever the fallback's reviewer is named, its pass is not an independent model.
  const map = reviewerMap({ review: { reviewers: { critic: { kind: 'agent', agent: 'critic', independent: true } } } });
  assert.equal(satisfies('independent-model', [{ id: 'fallback:independent:codex-local:critic', reviewer: 'critic', kind: 'agent', fallback: { replaces: 'codex-local' } }], map), false);
  assert.equal(satisfies('independent-model', [{ id: 'engine:critic', reviewer: 'critic', kind: 'agent' }], map), true, 'the same reviewer outside a fallback still counts');
  assert.equal(satisfies('independent-model', [{ id: 'slice:codex-local:0123456789', reviewer: 'codex-local', kind: 'exec', beforeQuota: true }], reviewerMap({ review: { reviewers: {} } })), false, 'a slice that finished before the stop reviewed only part of the change');
});

// A split of two slices where Codex answers one slice with a finding and runs out of quota on the other.
function splitStop(t) {
  const r = repo(t, { baseConfig: { version: 1, review: { rules: [{ when: { lines: { over: 1 } }, depth: 'split' }] } }, change: (write) => (write('src/a/x.js', '1\n'), write('src/b/x.js', '2\n')) });
  const found = { file: 'src/a/x.js', line: 1, title: 'slice a finding', body: 'x', severity: 'high' };
  let ran = 0;
  const exec = async (_reviewer, input) => (ran += 1, input.files?.includes('src/b/x.js') ? outOfQuota() : { status: 'done', findings: [found], verdicts: [], dropped: [] });
  return { r, exec, ran: () => ran };
}

test('out of quota on one slice of a split, the critic as the fallback: the finished slice`s findings still block and reach the critic', async (t) => {
  const { r, exec, ran } = splitStop(t);
  const stopped = await r.step({ exec });
  assert.deepEqual([stopped.status, ran()], ['blocked_quota', 2]);
  const finished = Object.keys(readLocalState(r.project, 7).passes).find((id) => id.startsWith('slice:codex-local:'));
  const fallback = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([fallback.status, ran()], ['dispatch', 2], 'no slice runs again');
  const [pass] = fallback.dispatch;
  assert.equal(pass.pass, 'fallback:independent:codex-local:critic');
  assert.deepEqual(pass.priorFindings.map((each) => [each.title, each.pass]), [['slice a finding', finished]], 'the critic reads what the finished slice found');
  assert.ok(fallback.plan.stages.find((stage) => stage.name === 'independent').passes.includes(finished), 'the finished slice stays in its stage');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: fallback.head, reviewer: 'critic', findings: 0, fixed: 0 });
  const after = await r.step({ exec });
  assert.deepEqual([after.status, after.open.map((each) => each.pass)], ['fix_required', [finished]], 'the finished slice`s finding still blocks');
});

test('out of quota on one slice of a split, the Human`s review: the finished slice`s findings block before the sign-off', async (t) => {
  const { r, exec } = splitStop(t);
  assert.equal((await r.step({ exec })).status, 'blocked_quota');
  const asked = await r.step({ exec }, { quotaFallback: 'human' });
  assert.deepEqual([asked.status, asked.open.map((each) => each.findings[0].title)], ['fix_required', ['slice a finding']]);
});

test('two reviewers out of quota in one stage: each keeps its own stop and choice, and one stage sign-off covers both', async (t) => {
  const planner = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify({depth:'single',stages:[{name:'independent',passes:[{id:'extra:lint',reviewer:'lint',kind:'exec',files:null}]}]})))";
  const r = repo(t, {
    baseConfig: { version: 1, review: { planCommand: 'node scripts/plan.mjs', reviewers: { lint: { kind: 'exec', command: ['node', 'scripts/lint.mjs'], stage: 'independent' } } } },
    baseFiles: { 'scripts/plan.mjs': planner, 'scripts/lint.mjs': '\n' },
    change: (write) => write('src/app.js', 'export const app = 11;\n'),
  });
  const calls = { 'codex-local': 0, lint: 0 };
  const exec = async (reviewer) => {
    calls[reviewer.name] += 1;
    if (reviewer.name === 'codex-local') return outOfQuota();
    return calls.lint === 1 ? { status: 'failed', reason: 'boom' } : outOfQuota();
  };
  assert.equal((await r.step({ exec })).pass, 'engine:codex-local');
  const second = await r.step({ exec }, { quotaFallback: 'agent:critic' });
  assert.deepEqual([second.status, second.pass], ['blocked_quota', 'extra:lint']);
  assert.deepEqual(readLocalState(r.project, 7).quotaStops.map((stop) => [stop.reviewer, stop.choice]), [['codex-local', 'agent:critic'], ['lint', null]], 'the second stop leaves the first one`s choice');
  const third = await r.step({ exec }, { quotaFallback: 'human' });
  assert.deepEqual([third.status, third.dispatch.map((each) => each.pass), calls['codex-local']], ['dispatch', ['fallback:independent:codex-local:critic'], 1]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: third.dispatch[0].pass, head: third.head, reviewer: 'critic', findings: 0, fixed: 0 });
  const asked = await r.step({ exec });
  assert.deepEqual([asked.status, asked.command], ['human_required', [`aidrian pr signoff 7 --stage independent --head ${third.head}`]]);
  recordStageSignoff(r.project, { pr: 7, repo: 'o/r', stage: 'independent', head: third.head, by: 'Tester' });
  const done = await r.step({ exec });
  assert.deepEqual([done.status, done.quota_fallback.map((each) => [each.replaces, each.choice])], ['received', [['codex-local', 'agent:critic'], ['lint', 'human']]]);
});

test('invariantsOf: a repeated heading is its own invariant, numbered as GitHub numbers its anchor, so one verdict never signs off both', () => {
  const read = () => '# Rules\n\n## Keep\nThe first.\n\n### Examples\nOne.\n\n## Keep\nThe second.\n\n### Examples\nTwo.\n';
  const { invariants, repeated } = invariantsOf({ invariants: 'r.md' }, read);
  assert.deepEqual(invariants.map((each) => [each.id, each.cite, each.text]), [
    ['keep', 'r.md#keep', 'Keep: The first.'], ['examples', 'r.md#examples', 'Examples: One.'],
    ['keep-1', 'r.md#keep-1', 'Keep: The second.'], ['examples-1', 'r.md#examples-1', 'Examples: Two.'],
  ]);
  assert.deepEqual(repeated, [{ heading: 'Keep', ids: ['keep', 'keep-1'] }, { heading: 'Examples', ids: ['examples', 'examples-1'] }]);
  const state = flowState(invariants, [{ invariant: 'keep', verdict: 'holds', evidence: 'ok' }, { invariant: 'examples', verdict: 'holds', evidence: 'ok' }, { invariant: 'examples-1', verdict: 'holds', evidence: 'ok' }], () => null);
  assert.deepEqual(state, { signed: false, open: [], unverified: ['keep-1'], disputed: [] });
});

// The merge guard (lib/rules/github/merge-review.mjs) and the quota fallback: a stop is an open review, a fallback is a
// finished one once the step that follows it says `received`, and the Human's stage sign-off counts the same way.
test('the merge guard refuses a head stopped on quota, and a fallback`s review counts as done once the step finishes', async (t) => {
  const guard = (r, head) => judgeMerge({ project: projectAt(r.dir), pr: 7, head, viewPr: () => null, answers: [] });
  const viaCritic = repo(t, { change: (write) => write('src/app.js', 'export const app = 12;\n') });
  const stopped = await viaCritic.step({ exec: outOfQuota });
  assert.match(guard(viaCritic, stopped.head) ?? '', /the review of head [0-9a-f]{7} is `blocked_quota`/u, 'a quota stop is an open review');
  const dispatched = await viaCritic.step({ exec: outOfQuota }, { quotaFallback: 'agent:critic' });
  assert.match(guard(viaCritic, dispatched.head) ?? '', /is `dispatch`/u, 'the fallback pass is still out');
  recordPass(viaCritic.project, { pr: 7, repo: 'o/r', pass: dispatched.dispatch[0].pass, head: dispatched.head, reviewer: 'critic', findings: 0, fixed: 0 });
  assert.equal((await viaCritic.step({ exec: outOfQuota })).status, 'received');
  assert.equal(guard(viaCritic, dispatched.head), null, 'the critic`s finished pass is review done for the merge guard');

  const viaHuman = repo(t, { change: (write) => write('src/app.js', 'export const app = 13;\n') });
  const first = await viaHuman.step({ exec: outOfQuota });
  assert.equal((await viaHuman.step({ exec: outOfQuota }, { quotaFallback: 'human' })).status, 'human_required');
  assert.match(guard(viaHuman, first.head) ?? '', /is `human_required`/u);
  recordStageSignoff(viaHuman.project, { pr: 7, repo: 'o/r', stage: 'independent', head: first.head, by: 'Tester' });
  assert.match(guard(viaHuman, first.head) ?? '', /is `human_required`/u, 'the sign-off counts once the review step reads it, as a flow sign-off does');
  assert.equal((await viaHuman.step({ exec: outOfQuota })).status, 'received');
  assert.equal(guard(viaHuman, first.head), null, 'the Human`s stage sign-off is review done for the merge guard');

  viaHuman.write('src/app.js', 'export const app = 14;\n');
  const next = viaHuman.commit();
  assert.equal((await viaHuman.step({ exec: outOfQuota })).status, 'blocked_quota');
  assert.match(guard(viaHuman, next) ?? '', /is `blocked_quota`/u, 'the choice was for the earlier head: the new head is stopped again');
});

test('a --quota-fallback refused for an independent-model plan, or given with no stop, leaves the head unfinished for the merge guard', async (t) => {
  const flows = { pay: { files: ['src/pay/**'], require: ['independent-model'] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/pay/a.js', '1\n') });
  const stopped = await r.step({ exec: outOfQuota });
  assert.equal((await r.step({ exec: outOfQuota }, { quotaFallback: 'agent:critic' })).status, 'unsatisfied');
  assert.match(judgeMerge({ project: projectAt(r.dir), pr: 7, head: stopped.head, viewPr: () => null, answers: [] }) ?? '', /is `unsatisfied`/u);
  r.write('src/pay/a.js', '2\n');
  const next = r.commit();
  await assert.rejects(r.step({ exec: outOfQuota }, { quotaFallback: 'human' }), /no quota stop is on record/u);
  assert.match(judgeMerge({ project: projectAt(r.dir), pr: 7, head: next, viewPr: () => null, answers: [] }) ?? '', /is `error`/u, 'a step that throws leaves `error` on the head');
});

// The approver's review of the APPROVED_FLOWS design (test/review-run-fixture.mjs) on `head`.
const approval = (head, more = {}) => ({ id: 41, state: 'APPROVED', commit_id: head, user: { login: 'amy-designer' }, body: 'Checked the screenshots.\naidrian-approve: look/matches-design\n', html_url: 'https://github.com/o/r/pull/7#pullrequestreview-41', ...more });

// The review of that flow on its first head, with the code reviewer's verdicts recorded: the copy holds, and the design
// cannot be verified. The forge's token is `session-bot`, and the approver's review is on the head.
async function unverifiedDesign(t, review = { flows: APPROVED_FLOWS, approvals: { allow: true } }) {
  const r = repo(t, { baseConfig: { version: 1, review }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs for the visual capture' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  r.forge.viewer = () => 'session-bot';
  r.forge.reviews = () => [approval(first.head)];
  return { r, head: first.head };
}

test('a named approver`s review of the head closes an unverified invariant once both switches are on, and the summary lists it', async (t) => {
  const { r, head } = await unverifiedDesign(t);
  const off = await r.step({ exec: clean });
  assert.deepEqual([off.status, off.flows], ['fix_required', [{ flow: 'look', violated: [], unverified: ['matches-design'], next: [unverifiedNext('look', 'matches-design', head)] }]], 'the machine switch is off: the approval counts for nothing, and no approval line is offered');
  assert.match(off.approvals.off, /reviewApprovals is not "on" in \.aidrian\.local\.json/u, 'the review says which switch is off');
  r.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  const on = await r.step({ exec: clean });
  assert.equal(on.status, 'received');
  assert.deepEqual(on.approvals.closed, [{ flow: 'look', invariant: 'matches-design', login: 'amy-designer', url: 'https://github.com/o/r/pull/7#pullrequestreview-41', at: null }]);
  // The posted body is escaped, code spans included: a zero-width space follows the @, so the approver is not mentioned.
  assert.match(r.comments[0].body, new RegExp(`- look/matches-design: approved by \`@\u200bamy-designer\` on \`${head.slice(0, 7)}\`: https://github\\.com/o/r/pull/7#pullrequestreview-41`, 'u'));
});

test('approvals: the team switch is the base branch`s, and a forge read that fails closes nothing while the step still answers', async (t) => {
  const { r } = await unverifiedDesign(t, { flows: APPROVED_FLOWS });
  r.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  const team = await r.step({ exec: clean });
  assert.deepEqual([team.status, team.flows[0].unverified], ['fix_required', ['matches-design']]);
  assert.match(team.approvals.off, /review\.approvals\.allow is not true on the base branch/u);

  const { r: failing } = await unverifiedDesign(t);
  failing.write('.aidrian.local.json', JSON.stringify({ reviewApprovals: 'on' }));
  failing.forge.reviews = () => { throw new Error('gh: HTTP 502'); };
  const broken = await failing.step({ exec: clean });
  assert.deepEqual([broken.status, broken.flows[0].unverified, broken.approvals.closed], ['fix_required', ['matches-design'], []]);
  assert.match(broken.approvals.error, /could not be read, so none counts: gh: HTTP 502/u);
});

test('the Human accepts an unverified invariant on outside evidence for one head; a violated one, or one not unverified, is refused', async (t) => {
  const flows = { ...APPROVED_FLOWS, pay: { files: ['src/ui/**'], invariants: [{ id: 'cap', text: 'Does a refund stay under the charge?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const evidence = 'https://github.com/o/r/pull/7#issuecomment-99';
  const checkEvidence = (url) => (url === evidence ? 'comment' : (() => { throw new Error(`--evidence ${url} is not a comment, review, or review comment of o/r#7 that the forge can find`); })());
  const accept = (more = {}) => recordAccept(r.project, { pr: 7, repo: 'o/r', flow: 'look', invariant: 'matches-design', head: r.git('rev-parse', 'HEAD'), by: 'Tester', reason: 'the designer approved the screenshots', evidence, checkEvidence, ...more });
  assert.throws(() => accept(), /no review of o\/r#7 ran on/u, 'before any review of the head');
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'violated', evidence: 'src/ui/a.js:1' },
  ]) });
  const blocked = await r.step({ exec: clean });
  assert.deepEqual(blocked.flows.map((flow) => [flow.flow, flow.violated, flow.unverified]), [['look', [], ['matches-design']], ['pay', ['cap'], []]]);
  assert.throws(() => accept({ reason: ' ' }), /--accept needs --reason/u);
  assert.throws(() => accept({ flow: 'pay', invariant: 'cap' }), /is violated on .*never clears a violated invariant/u);
  assert.throws(() => accept({ invariant: 'keeps-copy' }), /is not unverified on/u);
  assert.throws(() => accept({ evidence: 'https://github.com/o/r/pull/8#issuecomment-1' }), /is not a comment, review, or review comment of o\/r#7/u);
  assert.throws(() => accept({ evidence: 'not a url' }), /needs --evidence/u);
  assert.equal(accept({ dryRun: true }).kind, 'comment');
  assert.equal(readLocalState(r.project, 7).acceptances, undefined, 'a dry run records nothing');
  assert.equal(accept().by, 'Tester');
  const after = await r.step({ exec: clean });
  assert.deepEqual(after.flows.map((flow) => [flow.flow, flow.violated, flow.unverified]), [['pay', ['cap'], []]], 'the acceptance closes the design invariant; the violated one stays open');
  assert.match(summaryOf(r), new RegExp(`- look/matches-design: accepted by Tester on \`${first.head.slice(0, 7)}\` on outside evidence: ${evidence}: the designer approved the screenshots`, 'u'));
  r.write('src/ui/a.js', 'export const screen = 2;\n');
  const next = r.commit();
  const again = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: again.dispatch[0].pass, head: next, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  const moved = await r.step({ exec: clean });
  assert.deepEqual(moved.flows.map((flow) => [flow.flow, flow.unverified]), [['look', ['matches-design']]], 'an acceptance holds for its head only');
});

test('a judge`s ruling closes an unverified invariant only with both switches on, and never on the harness flow', async (t) => {
  const { r, head } = await unverifiedDesign(t, { flows: APPROVED_FLOWS, unattendedSignoff: { allow: true } });
  const evidence = 'https://github.com/o/r/pull/7#issuecomment-99';
  recordAccept(r.project, { pr: 7, repo: 'o/r', flow: 'look', invariant: 'matches-design', head, by: 'judge:critic', reason: 'the diff renders nothing new', evidence, checkEvidence: () => 'comment' });
  const off = await r.step({ exec: clean });
  assert.deepEqual([off.status, off.flows[0].unverified], ['fix_required', ['matches-design']], 'the machine switch is off: the ruling counts for nothing');
  assert.equal(off.flows[0].next[0].settle, undefined);
  r.write('.aidrian.local.json', JSON.stringify({ unattendedSignoff: 'on' }));
  const on = await r.step({ exec: clean });
  assert.equal(on.status, 'received');
  assert.match(summaryOf(r), /look\/matches-design: accepted by judge:critic/u, 'the summary names the judge');
});

test('a judge`s ruling counts for nothing when the base branch does not allow it, and next offers no settle route', async (t) => {
  const { r, head } = await unverifiedDesign(t, { flows: APPROVED_FLOWS });
  r.write('.aidrian.local.json', JSON.stringify({ unattendedSignoff: 'on' }));
  recordAccept(r.project, { pr: 7, repo: 'o/r', flow: 'look', invariant: 'matches-design', head, by: 'judge:critic', reason: 'r', evidence: 'https://github.com/o/r/pull/7#issuecomment-99', checkEvidence: () => 'comment' });
  const step = await r.step({ exec: clean });
  assert.deepEqual([step.flows[0].unverified, step.flows[0].next[0].settle], [['matches-design'], undefined]);
});

test('with both switches on, next prints the settle route, and evidence that fails its citation is named as the reviewer`s to fix', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { flows: APPROVED_FLOWS, unattendedSignoff: { allow: true } } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  r.write('.aidrian.local.json', JSON.stringify({ unattendedSignoff: 'on' }));
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'not_affected', evidence: 'The change adds no markup.' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  const [next] = (await r.step({ exec: clean })).flows[0].next;
  assert.match(next.settle, /^aidrian pr settle 7 --flow look --accept matches-design /u);
  assert.match(next.notes[0], /code-reviewer answered not_affected, but its evidence does not count .*dispatch that reviewer again/u);
});

// The ingest route beside the --accept route of #122 above (issue #139): images taken outside the tool, ingested as
// captures of the head, close an unverified invariant when a reviewer cites one as `capture:<key>`. Here the base
// branch sets review.visual and this machine has no base URL, so the tool's own capture lands unavailable.
test('a reviewer citing an ingested capture closes an unverified invariant on that head; an unknown key, another head`s ingest, or a violated verdict does not', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/ui/**'], routes: ['/look'] }], viewports: [360] };
  const flows = { look: { files: ['src/ui/**'], require: ['agent:designer'], invariants: [{ id: 'matches-design', text: 'Does the screen still match the approved design?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, visual } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const { ingestCaptures } = await import('../plugins/aidrian/lib/review/visual.mjs');
  const head = r.git('rev-parse', 'HEAD');
  const shot = path.join(stateDir(r.project), 'shots', 'look-360.png');
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, PNG);
  const { ingested: [{ key }] } = ingestCaptures({ project: r.project, pr: 7, head, files: [shot], source: 'e2e-runner run 12', by: 'Tester' });
  writeFileSync(shot, Buffer.concat([PNG, Buffer.from('main')]));
  const { ingested: [{ key: elsewhere }] } = ingestCaptures({ project: r.project, pr: 7, head: r.git('rev-parse', 'main'), files: [shot], source: 'e2e-runner run 11', by: 'Tester' });
  r.forge.visibility = () => 'PUBLIC';
  const first = await r.step({ exec: clean });
  const [pass] = first.dispatch;
  assert.equal(pass.agent, 'designer');
  assert.equal(pass.visual.status, 'unavailable', 'the tool did not capture the head');
  assert.deepEqual(pass.visual.captures.map((capture) => [capture.key, capture.ingested, capture.source?.origin]), [[key, true, 'e2e-runner run 12']]);
  const cite = (evidence, verdict = 'holds') => recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head, reviewer: 'designer', findingsText: '[]', verdictsText: JSON.stringify([{ flow: 'look', invariant: 'matches-design', verdict, evidence }]) });
  cite('capture:nope');
  assert.deepEqual((await r.step({ exec: clean })).flows.map((flow) => [flow.flow, flow.unverified]), [['look', ['matches-design']]], 'a key never ingested is no evidence');
  cite(`capture:${elsewhere}`);
  assert.deepEqual((await r.step({ exec: clean })).flows.map((flow) => [flow.flow, flow.unverified]), [['look', ['matches-design']]], 'an ingest of another head does not count on this one');
  cite(`capture:${key}`, 'violated');
  assert.deepEqual((await r.step({ exec: clean })).flows.map((flow) => [flow.flow, flow.violated]), [['look', ['matches-design']]], 'a violated verdict keeps the flow open whatever it cites');
  cite(`capture:${key}`);
  const closed = await r.step({ exec: clean });
  assert.deepEqual([closed.status, closed.flows ?? []], ['received', []], 'the ingested capture is the evidence that closes it');
  // The repository reads as public, so the posted line names no reason and no person; the record keeps both.
  assert.doesNotMatch(summaryOf(r), /Tester|e2e-runner/u, 'the public comment names no reason and no person');
  // The designer pass has its result on the head, so the tool's own reason gives way; the ingest note stays.
  assert.match(summaryBody(readLocalState(r.project, 7), null, 'x', OPEN), new RegExp(`- visual capture of \`${head.slice(0, 7)}\`: unavailable; the visual passes reviewed this head without the capture \\(ingested, not captured: ${key} from \`e2e-runner run 12\` by \`Tester\`\\)`, 'u'));
});

// The late order: the images are ingested after the visual reviewer answered. The step dispatches no visual reviewer
// again, so the session runs it by hand with the ingested files and records the pass again. This pins today's
// behaviour: the re-recorded citation closes the invariant, while the summary's visual line and the record's captured
// keys stay as the capture left them, since the capture does not run again for this head.
test('an ingest after the visual reviewer answered counts once the pass is recorded again citing it; the summary line and the record keys stay as they were', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/ui/**'], routes: ['/look'] }], viewports: [360] };
  const flows = { look: { files: ['src/ui/**'], require: ['agent:designer'], invariants: [{ id: 'matches-design', text: 'Does the screen still match the approved design?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, visual } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  r.forge.visibility = () => 'PUBLIC';
  const first = await r.step({ exec: clean });
  const [pass] = first.dispatch;
  const record = (evidence, verdict) => recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: JSON.stringify([{ flow: 'look', invariant: 'matches-design', verdict, evidence }]) });
  record('no capture of the head', 'cannot_verify');
  assert.deepEqual((await r.step({ exec: clean })).flows.map((flow) => [flow.flow, flow.unverified]), [['look', ['matches-design']]]);
  const line = () => summaryOf(r).split('\n').find((each) => each.startsWith('- visual capture of'));
  const [lineBefore, keysBefore] = [line(), readLocalState(r.project, 7).captured];
  const shot = path.join(stateDir(r.project), 'shots', 'look-360.png');
  mkdirSync(path.dirname(shot), { recursive: true });
  writeFileSync(shot, PNG);
  const capturesComment = () => r.comments.find((c) => c.body.startsWith('<!-- aidrian-visual-captures -->')).body;
  const commentBefore = capturesComment();
  t.mock.method(console, 'log', () => {});
  const ingest = (...more) => runIngest(['7', '--head', first.head, '--source', 'e2e-runner run 12', '--repo', 'o/r', ...more, shot], projectAt(r.dir), null, { forge: r.forge, env: {} });
  assert.equal(await ingest('--check'), 0);
  assert.equal(capturesComment(), commentBefore, '--check edits nothing');
  assert.equal(await ingest(), 0);
  t.mock.restoreAll();
  const { readManifest } = await import('../plugins/aidrian/lib/review/visual.mjs');
  const [{ key }] = readManifest(r.project, 7, first.head).ingested;
  // The late ingest leaves its trace on the pull request: the captures comment is rewritten with it.
  assert.ok(capturesComment().includes(`| \`${key}\` | \`e2e-runner run 12\` | \`Tester\` |`), capturesComment());
  // The designer already has its result on this head, so the rewrite keeps the line that it reviewed the head without the capture.
  assert.match(capturesComment(), /unavailable; the visual passes reviewed this head without the capture\./u);
  record(`capture:${key}`, 'holds');
  const closed = await r.step({ exec: clean });
  assert.deepEqual([closed.status, closed.flows ?? []], ['received', []], 'the re-recorded citation of the ingest closes the invariant');
  assert.equal(line(), lineBefore, 'the summary line does not show a late ingest');
  assert.deepEqual(readLocalState(r.project, 7).captured, keysBefore, 'nor do the record`s captured keys: the ingest counts only on the machine that holds it');
  assert.doesNotMatch(lineBefore, /ingested/u);
});

test('a failed capture stops asking to wait in the summary and the captures comment once a visual pass has its result on that head', async (t) => {
  const visual = { platform: 'web', targets: [{ files: ['src/ui/**'], routes: ['/look'] }], viewports: [360] };
  const flows = { look: { files: ['src/ui/**'], require: ['agent:designer'], invariants: [{ id: 'matches-design', text: 'Does the screen still match the approved design?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, visual } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  const [pass] = first.dispatch;
  const line = () => summaryOf(r).split('\n').find((each) => each.startsWith('- visual capture of'));
  const capturesComment = () => r.comments.find((c) => c.body.startsWith('<!-- aidrian-visual-captures -->')).body;
  // No visual pass has a result yet: the failure and its reason stand.
  assert.match(capturesComment(), /unavailable: no base URL/u);
  assert.match(line(), /: unavailable \(no base URL/u);
  assert.deepEqual(readLocalState(r.project, 7).visual.passes, [pass.pass]);
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: pass.pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: JSON.stringify([{ flow: 'look', invariant: 'matches-design', verdict: 'holds', evidence: 'src/ui/a.js:1' }]) });
  await r.step({ exec: clean });
  assert.equal(line(), `- visual capture of \`${first.head.slice(0, 7)}\`: unavailable; the visual passes reviewed this head without the capture; attach **auto**, private repository`);
  assert.match(capturesComment(), /^Attach: \*\*auto\*\*, private repository\. unavailable; the visual passes reviewed this head without the capture\.$/mu);
  assert.doesNotMatch(capturesComment(), /no base URL/u);
  // The next step leaves the comment as it is.
  let edits = 0;
  const edit = r.forge.editComment;
  r.forge.editComment = (...args) => ((args[1] === r.comments.find((c) => c.body.startsWith('<!-- aidrian-visual-captures -->')).id && (edits += 1)), edit(...args));
  await r.step({ exec: clean });
  assert.equal(edits, 0);
});

test('summaryBody: a failed capture`s line keeps its reason until a visual pass it was taken for has a result on its head', () => {
  const head = 'a'.repeat(40);
  const state = (passes, visual = {}) => ({ ...emptyState(7, 'o/r'), passes, visual: { head, status: 'failed', mode: 'auto', visibility: 'PRIVATE', captured: 0, of: 2, passes: ['designer'], reason: 'visual-preview: preview of aaaaaaa is still deploying; wait for the deploy and run aidrian pr review again', ...visual } });
  const line = (record) => summaryBody(record, null, 'x', OPEN).split('\n').find((each) => each.startsWith('- visual capture of'));
  assert.match(line(state({})), /failed \(visual-preview: preview of aaaaaaa is still deploying; wait for the deploy/u, 'no pass result');
  assert.match(line(state({ designer: { head: 'b'.repeat(40), reviewer: 'designer', findings: 0, open: 0 } })), /still deploying/u, 'a result on another head');
  assert.match(line(state({ 'code-reviewer': { head, reviewer: 'code-reviewer', findings: 0, open: 0 } })), /still deploying/u, 'a result of a pass that is not visual');
  assert.match(line(state({ designer: { head, reviewer: 'designer', findings: 0, open: 0 } }, { passes: undefined })), /still deploying/u, 'a record from before visual.passes');
  const reviewed = line(state({ designer: { head, reviewer: 'designer', findings: 0, open: 0 } }));
  assert.equal(reviewed, '- visual capture of `aaaaaaa`: failed; the visual passes reviewed this head without the capture; attach **auto**, private repository');
  assert.match(line(state({ designer: { head, reviewer: 'designer', findings: 0, open: 0 } }, { reason: 'still deploying; ingested, not captured: ingest-x-abcdef from `run 1` by `Tester`' })), /without the capture \(ingested, not captured: ingest-x-abcdef/u, 'the ingest note stays');
});

// What a line shows outside its code spans, by CommonMark's rule: a run of backticks opens a span that only a run of
// the same length closes.
function outsideSpans(line) {
  let out = '';
  for (let i = 0; i < line.length;) {
    const run = /^`+/u.exec(line.slice(i));
    if (!run) { out += line[i]; i += 1; continue; }
    const close = line.slice(i + run[0].length).search(new RegExp(`(?<!\`)${run[0]}(?!\`)`, 'u'));
    if (close === -1) { out += line.slice(i); break; }
    i += run[0].length + close + run[0].length;
  }
  return out;
}

test('the summary`s visual line fits every ingest note into its clip: whole entries only, each span closed, and no mention outside one', async (t) => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const visual = { platform: 'web', targets: [{ files: ['src/ui/**'], routes: ['/look'] }], viewports: [360] };
  const flows = { look: { files: ['src/ui/**'], require: ['agent:designer'], invariants: [{ id: 'matches-design', text: 'Does the screen still match the approved design?' }] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, visual } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  r.forge.visibility = () => 'PUBLIC';
  const { ingestCaptures } = await import('../plugins/aidrian/lib/review/visual.mjs');
  const head = r.git('rev-parse', 'HEAD');
  const dir = path.join(stateDir(r.project), 'shots');
  mkdirSync(dir, { recursive: true });
  for (const [i, source] of [`@x ${'a'.repeat(296)}`, 'e2e @team run 1', 'e2e @team run 2', 'e2e @team run 3'].entries()) {
    const shot = path.join(dir, `look-${i}.png`);
    writeFileSync(shot, Buffer.concat([PNG, Buffer.from(String(i))]));
    ingestCaptures({ project: r.project, pr: 7, head, files: [shot], source, by: 'Tester' });
  }
  await r.step({ exec: clean });
  assert.doesNotMatch(summaryOf(r), /Tester|e2e @/u, 'the public comment names no reason and no person');
  // The line as a private repository's comment shows it, from the record.
  const line = summaryBody(readLocalState(r.project, 7), null, 'x', OPEN).split('\n').find((each) => each.startsWith('- visual capture of'));
  assert.match(line, /no base URL: .*; ingested, not captured: ingest-look-0-[0-9a-f]{6} from `@\u200bx a+…` by `Tester`.* and \d more, listed in the captures comment\)/u, line);
  assert.equal((line.match(/`/gu) ?? []).length % 2, 0, 'every code span is closed');
  assert.doesNotMatch(outsideSpans(line), /@/u, line);
});

test('aidrian pr signoff --check runs every refusal of --flow, --overrule, --accept, and --stage, and records nothing', async (t) => {
  const flows = { ...APPROVED_FLOWS, pay: { files: ['src/ui/**'], invariants: [{ id: 'cap', text: 'Does a refund stay under the charge?' }], signoff: 'human' } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, record: 'local' } }, change: (write) => write('src/ui/a.js', 'export const screen = 1;\n') });
  const first = await r.step({ exec: clean });
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'code-reviewer', findings: 0, fixed: 0, verdictsText: JSON.stringify([
    { flow: 'look', invariant: 'matches-design', verdict: 'cannot_verify', evidence: 'no app runs' },
    { flow: 'look', invariant: 'keeps-copy', verdict: 'holds', evidence: 'src/ui/a.js:1' },
    { flow: 'pay', invariant: 'cap', verdict: 'holds', evidence: 'src/ui/a.js:1' },
  ]) });
  await r.step({ exec: clean });
  const evidence = 'https://github.com/o/r/pull/7#pullrequestreview-5';
  // The engine's own posts, each a comment of this pull request, are never outside evidence (R7, G3).
  const engine = {
    'https://github.com/o/r/pull/7#discussion_r11': { kind: 'review_comment', body: '<!-- aidrian-review-finding:R1-1 -->\naidrian review, finding R1-1\n**medium**' },
    'https://github.com/o/r/pull/7#issuecomment-12': { kind: 'comment', body: '<!-- aidrian-review-summary -->\n### Review: received' },
    'https://github.com/o/r/pull/7#issuecomment-13': { kind: 'comment', body: '<!-- aidrian-product-feedback: pr=7 repo=o/r -->\nfeedback' },
  };
  const forge = { change: () => ({ url: 'https://github.com/o/r/pull/7' }), changeEvidence: (_repo, _n, url, { withBody }) => (url === evidence ? { kind: 'review', body: 'The designer approved the screenshots.' } : withBody ? engine[url] ?? null : null) };
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const signoff = (...args) => runSignoff(['7', ...args, '--head', first.head, '--repo', 'o/r', '--check'], projectAt(r.dir), loadConfig(projectAt(r.dir)).config, { forge });
  const before = readFileSync(path.join(stateDir(r.project), 'reviews', 'pr-7-review-o--r.json'), 'utf8');
  assert.equal(await signoff('--flow', 'pay'), 0);
  assert.equal(await signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', evidence, '--reason', 'the designer approved it'), 0);
  await assert.rejects(signoff('--flow', 'look'), /flow look takes no Human sign-off/u);
  await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', 'https://github.com/o/r/pull/7#issuecomment-1', '--reason', 'x'), /is not a comment, review, or review comment of o\/r#7 that the forge can find/u);
  for (const url of Object.keys(engine)) {
    await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', url, '--reason', 'x'), /is a post of the review engine itself .* never outside evidence/u, url);
  }
  await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--evidence', 'https://github.com/user-attachments/assets/shot-1', '--reason', 'x'), /cite the URL of the comment or review that holds an attachment, never the attachment's own URL/u, 'an upload is refused, with the way to cite it');
  await assert.rejects(signoff('--flow', 'look', '--accept', 'keeps-copy', '--evidence', evidence, '--reason', 'x'), /is not unverified on/u);
  await assert.rejects(signoff('--flow', 'look', '--overrule', 'matches-design', '--reason', 'x'), /is not disputed on/u);
  await assert.rejects(signoff('--stage', 'independent'), /no Human review of the independent stage is waiting/u);
  await assert.rejects(signoff('--flow', 'look', '--accept', 'matches-design', '--reason', 'x'), /--accept needs --flow, --evidence, and --reason/u);
  // The review-signoff rule lets any command with a word `--check` run, so the parser must never read that word as a
  // value or skip it: each of these is refused, and records nothing, where it would otherwise sign off flow pay.
  const real = (...args) => runSignoff(args, projectAt(r.dir), loadConfig(projectAt(r.dir)).config, { forge });
  const tail = ['--head', first.head, '--repo', 'o/r'];
  for (const [args, refusal] of [
    [['7', '--flow', 'pay', ...tail, '--reason', '--check'], /--reason needs a value/u],
    [['7', '--flow', '--check', ...tail], /--flow needs a value/u],
    [['7', '--flow', 'pay', ...tail, '--', '--check'], /unknown argument: --$/u],
    [['7', '--flow', 'pay', ...tail, '--reason=--check'], /unknown argument: --reason=--check/u],
    [['--check', '--flow', 'pay', ...tail], /signoff needs a pull request number/u],
  ]) await assert.rejects(real(...args), refusal, args.join(' '));
  t.mock.restoreAll();
  assert.deepEqual(lines.map((line) => line.split(';')[0]), [
    `ok: the command would record Tester's sign-off of flow pay on ${first.head.slice(0, 7)}`,
    `ok: the command would record Tester's acceptance of invariant matches-design of flow look on ${first.head.slice(0, 7)}`,
  ]);
  assert.equal(readFileSync(path.join(stateDir(r.project), 'reviews', 'pr-7-review-o--r.json'), 'utf8'), before, 'the record is as it was');
});

test('fix_required names the next step of every open invariant: the fix, the approval line, the acceptance, and the capture`s status', async (t) => {
  const visual = { platform: 'web', targets: [{ files: ['src/components/**'], routes: ['/dashboard'] }], viewports: [360] };
  const flows = { ui: { files: ['src/components/**'], require: ['agent:designer'], invariants: [
    { id: 'no-crash', text: 'Does the screen still render?' },
    { id: 'fit', text: 'Does the screen still match the approved design?', approvers: ['amy-designer', 'bo-design'] },
  ] } };
  const r = repo(t, { baseConfig: { version: 1, review: { flows, visual, approvals: { allow: true } } }, change: (write) => write('src/components/Button.tsx', 'export const Button = () => <button />;\n') });
  r.write('.aidrian.local.json', JSON.stringify({ review: { visual: { baseUrl: 'http://localhost:3000' } }, reviewApprovals: 'on' }));
  r.forge.visibility = () => 'PRIVATE';
  r.forge.viewer = () => 'session-bot';
  r.forge.reviews = () => [];
  const captureSpawn = () => ({ status: 3, stdout: '', stderr: 'playwright is not installed: run npm i -D playwright\n' });
  const first = await r.step({ exec: clean, captureSpawn });
  assert.equal(first.dispatch[0].agent, 'designer');
  recordPass(r.project, { pr: 7, repo: 'o/r', pass: first.dispatch[0].pass, head: first.head, reviewer: 'designer', findingsText: '[]', verdictsText: JSON.stringify([
    { flow: 'ui', invariant: 'no-crash', verdict: 'violated', evidence: 'src/components/Button.tsx:1' },
    { flow: 'ui', invariant: 'fit', verdict: 'cannot_verify', evidence: 'no capture of the head' },
  ]) });
  const blocked = await r.step({ exec: clean, captureSpawn });
  assert.equal(blocked.status, 'fix_required');
  assert.deepEqual(blocked.flows[0].next, [
    { invariant: 'no-crash', state: 'violated', commands: [], notes: ['fix the code'] },
    unverifiedNext('ui', 'fit', first.head, [
      `ask for an approving review of ${first.head} by amy-designer or bo-design, whose body holds the line: aidrian-approve: ui/fit`,
      `the visual capture of ${first.head.slice(0, 7)} is unavailable: playwright is not installed: run npm i -D playwright`,
    ]),
  ]);
  assert.ok(blocked.flows[0].next.every((entry) => entry.commands.every((command) => command.startsWith('aidrian pr signoff '))), 'commands are sign-off commands only');
});

test('approvals: a pull request cannot turn the team switch on for its own review, and turning it on is a change to the review', () => {
  const base = { rules: [], ignore: [], nonBehaviour: [], flows: {}, planCommand: null, reviewers: {}, approvals: { allow: false } };
  const { review, changed } = reviewInForce(base, { ...base, approvals: { allow: true } });
  assert.deepEqual([review.approvals, changed], [{ allow: false }, ['approvals']]);
  assert.deepEqual(reviewInForce(null, { ...base, approvals: { allow: true } }).review.approvals, { allow: false });
});

test('reviewInForce: a pull request cannot turn on unattended rulings for itself', () => {
  const base = checkReview({}, 'c.json', []);
  const head = { ...base, unattendedSignoff: { allow: true } };
  const { review, changed } = reviewInForce(base, head);
  assert.deepEqual([review.unattendedSignoff, changed], [{ allow: false }, ['unattendedSignoff']]);
  assert.deepEqual(reviewInForce(null, head).review.unattendedSignoff, { allow: false }, 'with no base config, the default holds');
});
