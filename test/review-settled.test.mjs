import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { loadTable } from '../plugins/aidrian/lib/finding-disposition.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { passInput } from '../plugins/aidrian/lib/review/dispatch.mjs';
import { reviewPrompt, runExec } from '../plugins/aidrian/lib/review/reviewers.mjs';
import { lateResiduals, recordPass, reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { contextFindings, MAX_RESIDUAL_CHARS, MAX_RESIDUALS, MAX_SETTLED, namedBy, offeredCarried, recordSettled, residualTexts, RULED_HEADING, ruledLines, settledBrief, settledEntries, splitRuled } from '../plugins/aidrian/lib/review/settled.mjs';
import { emptyState, readLocalState, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';

const body = (items, section = 'Accepted residuals') => `## Summary\n\nWhy.\n\n## ${section}\n\n${items.map((item) => `- ${item}`).join('\n')}\n\n## Tests\n\n- npm test\n`;

test('residualTexts: the body section\'s items as trimmed texts, capped in count and length, each once', () => {
  assert.deepEqual(residualTexts(body(['The retry loop has no cap', '  The retry loop has no cap ', 'Slow on cold start'])), ['The retry loop has no cap', 'Slow on cold start']);
  assert.deepEqual(residualTexts(body(['Mine'], 'Known gaps'), 'Known gaps'), ['Mine'], 'the configured section name');
  assert.deepEqual(residualTexts(body(['Mine'], 'Known gaps'), null), [], 'another section is not the residuals');
  assert.deepEqual(residualTexts('## Summary\n\nNothing.\n'), []);
  assert.deepEqual(residualTexts(undefined), []);
  const many = residualTexts(body(Array.from({ length: MAX_RESIDUALS + 5 }, (_, i) => `residual ${i}`)));
  assert.equal(many.length, MAX_RESIDUALS);
  assert.equal(residualTexts(body(['x'.repeat(MAX_RESIDUAL_CHARS + 50)]))[0].length, MAX_RESIDUAL_CHARS);
});

test('recordSettled: accepted findings of any pass that no longer block, then the last rulings on a prior finding, each once', () => {
  const state = {
    passes: {
      'agent:code-reviewer': { head: 'h1', list: [
        { title: 'Accepted', file: 'a.js', severity: 'low', likelihood: 'routine', affects: 'users', state: 'accepted', disposition: 'drop_unless_cited' },
        { title: 'Labelled accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' },
        { title: 'Open', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' },
        { title: 'Fixed', file: 'a.js', severity: 'low', state: 'fixed', disposition: 'drop_unless_cited' },
      ] },
      'engine:codex-local': { head: 'h1', list: [{ title: 'Codex open', file: 'a.js', line: 2, severity: 'high' }] },
    },
  };
  const prior = { head: 'h1', ruled: [
    { title: 'Same cause, new words', file: 'b.js', line: 4, severity: 'low', already_ruled: 'Root finding', from: 'prior' },
    { title: 'Residual repeat', file: 'b.js', line: 5, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' },
    { title: 'Accepted again', file: 'a.js', line: 1, severity: 'low', already_ruled: 'Accepted', from: 'prior' },
  ] };
  const settled = recordSettled(state, prior);
  assert.deepEqual(settled.map((each) => [each.title, each.file, each.state]), [['Accepted', 'a.js', 'accepted'], ['Root finding', 'b.js', 'accepted']],
    'a blocking, open, fixed, or unclassified entry settles nothing; a residual ruling is not carried; a duplicate is kept once');
  assert.equal(settled[0].likelihood, 'routine', 'an accepted finding keeps its axes');
  assert.equal(settled[0].settled_by, 'agent:code-reviewer', 'an accepted finding names the pass that accepted it');
  assert.deepEqual(settledEntries({ priorFindings: settled }), [{ title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' }, { title: 'Root finding', file: 'b.js', severity: 'low' }]);
  assert.deepEqual(recordSettled({}, null), []);
  const lots = { passes: { p: { list: Array.from({ length: MAX_SETTLED + 10 }, (_, i) => ({ title: `t${i}`, file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' })) } } };
  assert.equal(recordSettled(lots, null).length, MAX_SETTLED);
});

// The step context passInput reads, for one pass on one head with no git history to walk.
const INSIDE = { author_association: 'MEMBER', base: { repo: { fork: false } } };
function context({ state, map, info, residuals = null, cross = false, pull = () => INSIDE }) {
  return {
    forge: { change: () => ({ isCrossRepository: cross }), pull },
    config: { github: { reviewGate: { enabled: false }, pullRequest: { residuals } } },
    root: '/nowhere', repo: 'o/r', n: 7, head: 'h1', base: 'b1', baseTip: 'b1', changes: [], scope: null, state, plan: { flows: [] },
    resultFor: () => null, sameFiles: () => true, verdictsFor: () => [], visual: null, manifest: null, isVisual: () => false, map, info,
  };
}

test('passInput: an exec pass reads the body\'s residuals and the record\'s settled findings; an agent pass reads neither', () => {
  const state = { ...emptyState(7, 'o/r'), passes: {
    'engine:codex-local': { head: 'h1', files: null, list: [{ title: 'Codex open', file: 'a.js', line: 2, severity: 'high' }], ruled: [{ title: 'Again', file: 'b.js', line: 4, severity: 'low', already_ruled: 'Root finding', from: 'prior' }] },
    'agent:code-reviewer': { head: 'h1', files: null, list: [{ title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] },
  } };
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const s = context({ state, map, info: { body: body(['The retry loop has no cap']) } });
  const stage = { name: 'independent', passes: [] };
  const exec = passInput(s, { id: 'engine:codex-local', reviewer: 'codex-local', files: null }, stage);
  assert.deepEqual(exec.acceptedResiduals, ['The retry loop has no cap']);
  assert.deepEqual(exec.priorFindings.map((each) => each.title), ['Codex open', 'Accepted', 'Root finding'], 'its own last findings, then what is settled');
  assert.deepEqual(settledEntries(exec), [
    { title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' },
    { title: 'Root finding', file: 'b.js', severity: 'low' },
    { title: 'The retry loop has no cap' },
  ]);
  const custom = passInput(context({ state, map, info: { body: body(['Mine'], 'Known gaps') }, residuals: { section: 'Known gaps' } }), { id: 'engine:codex-local', reviewer: 'codex-local', files: null }, stage);
  assert.deepEqual(custom.acceptedResiduals, ['Mine'], 'github.pullRequest.residuals.section names the section');
  const agent = passInput(s, { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null }, { name: 'local', passes: [] });
  assert.ok(!('acceptedResiduals' in agent));
  assert.deepEqual(agent.priorFindings.map((each) => each.title), ['Accepted']);
});

test('a ruling on a prior finding holds on the next head, after the finding it named has left the record', () => {
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  const state = { ...emptyState(7, 'o/r'), passes: {
    'agent:code-reviewer': { head: 'h1', files: null, list: [{ title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] },
  } };
  const first = splitRuled(answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  assert.deepEqual(first.ruled.map((each) => [each.title, each.already_ruled, each.from, each.settled_by]), [['The same cause', 'Accepted', 'prior', 'agent:code-reviewer']]);
  // The next head: the code-reviewer re-ran and no longer lists the finding; codex-local's record holds its ruling.
  state.passes['agent:code-reviewer'] = { head: 'h2', files: null, list: [] };
  state.passes['engine:codex-local'] = { head: 'h1', files: null, list: first.findings, ruled: first.ruled };
  const second = splitRuled(answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  assert.deepEqual(second.findings, [], 'the ruled finding is not re-raised on the next round');
  assert.deepEqual(second.ruled.map((each) => [each.already_ruled, each.settled_by]), [['Accepted', 'agent:code-reviewer']], 'the carried ruling still names the pass that accepted it');
});

// codex-local's answer on h1, with the code-reviewer's record on h1 holding `accepted`; then the next head's settled list.
function nextHead(accepted, h1Answer, h2List) {
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const state = { ...emptyState(7, 'o/r'), passes: { 'agent:code-reviewer': { head: 'h1', files: null, list: [accepted] } } };
  const first = splitRuled(h1Answer, settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)));
  state.passes['agent:code-reviewer'] = { head: 'h2', files: null, list: h2List };
  state.passes['engine:codex-local'] = { head: 'h1', files: null, list: first.findings, ruled: first.ruled };
  return { first, settled: settledEntries(passInput(context({ state, map, info: { body: '' } }), pass, stage)) };
}

test('a carried ruling keeps the settled finding\'s severity as its cap, not the repeat\'s', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'medium', likelihood: 'contrived', affects: 'users', state: 'accepted', disposition: 'accepted_residual' };
  const { first, settled } = nextHead(accepted, [{ file: 'a.js', line: 3, title: 'Low repeat', body: 'b', severity: 'low', already_ruled: 'Accepted' }], []);
  assert.deepEqual(first.ruled.map((each) => [each.severity, each.settled_severity]), [['low', 'medium']]);
  const medium = splitRuled([{ file: 'a.js', line: 4, title: 'Medium repeat', body: 'b', severity: 'medium', already_ruled: 'Accepted' }], settled);
  assert.deepEqual(medium.findings, [], 'a medium repeat is still waived after the original left the record');
  assert.deepEqual(medium.ruled.map((each) => [each.title, each.settled_severity]), [['Medium repeat', 'medium']]);
});

test('a carried ruling is dropped once any pass holds its source as fixed or open, or blocking', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  for (const [label, source] of [
    ['fixed', { title: 'Accepted', file: 'a.js', state: 'fixed' }],
    ['reopened', { title: 'Accepted', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' }],
    ['fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
  ]) {
    const { first, settled } = nextHead(accepted, answer, [source]);
    assert.equal(first.ruled.length, 1, `${label}: the ruling was made on h1`);
    const again = splitRuled(answer, settled);
    assert.deepEqual(again.findings.map((each) => each.title), ['The same cause'], `${label}: the repeat is new again`);
    assert.deepEqual(again.ruled, [], `${label}: nothing is waived`);
  }
  const { settled } = nextHead(accepted, answer, [{ title: 'Accepted', file: 'b.js', state: 'open' }]);
  assert.equal(splitRuled(answer, settled).ruled.length, 1, 'the same title in another file leaves the ruling standing');
});

test('a direct acceptance settles nothing while any pass lists that title in that file as fixed, open, or blocking', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const answer = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  for (const [label, other] of [
    ['fixed', { title: 'Accepted', file: 'a.js', state: 'fixed' }],
    ['open', { title: 'Accepted', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' }],
    ['fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
    ['no state', { title: 'Accepted', file: 'a.js', severity: 'low' }],
  ]) {
    const state = { passes: { 'agent:code-reviewer': { head: 'h1', list: [accepted] }, 'agent:security-reviewer': { head: 'h1', list: [other] } } };
    const settled = settledEntries({ priorFindings: recordSettled(state, null) });
    assert.deepEqual(settled, [], `${label}: the acceptance is not offered`);
    assert.deepEqual(splitRuled(answer, settled).findings.map((each) => each.title), ['The same cause'], `${label}: the repeat is new`);
  }
  const elsewhere = { passes: { 'agent:code-reviewer': { head: 'h1', list: [accepted] }, 'agent:security-reviewer': { head: 'h1', list: [{ title: 'Accepted', file: 'b.js', state: 'open' }] } } };
  assert.equal(splitRuled(answer, settledEntries({ priorFindings: recordSettled(elsewhere, null) })).ruled.length, 1, 'the same title in another file leaves the acceptance standing');
});

// An exec pass's own last result holding an acceptance, as an itemized re-attestation or the late-round rule writes it.
const OWN_ACCEPTANCES = [
  ['re-attested', { title: 'Accepted', file: 'a.js', line: 3, body: 'Why.', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }],
  ['late round', { title: 'Accepted', file: 'a.js', line: 3, body: 'Why.', severity: 'low', state: 'accepted', disposition: 'acceptable_as_is', accepted_by: 'late-round' }],
];
const STANDINGS = [['inside', {}], ['outside', { cross: true }]];
const ownInput = (own, other, over, pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null }) => {
  const passes = { 'engine:codex-local': { head: 'h1', files: null, list: [own] }, ...(other ? { 'agent:security-reviewer': { head: 'h1', files: null, list: [other] } } : {}) };
  const state = { ...emptyState(7, 'o/r'), passes };
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  return { state, input: passInput(context({ state, map, info: { body: '' }, ...over }), pass, { name: 'independent', passes: [] }) };
};
const ownRepeat = [{ file: 'a.js', line: 3, title: 'The same cause', body: 'b', severity: 'low', already_ruled: 'Accepted' }];

test('passInput: an acceptance on the pass\'s own prior list settles nothing while another pass lists it fixed, open, or blocking, inside or outside', () => {
  for (const [kind, own] of OWN_ACCEPTANCES) {
    for (const [standing, over] of STANDINGS) {
      for (const [label, other] of [
        ['fixed', { title: 'Accepted', file: 'a.js', state: 'fixed' }],
        ['open', { title: 'Accepted', file: 'a.js', severity: 'low', state: 'open', disposition: 'drop_unless_cited' }],
        ['open fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'open', disposition: 'fix_now' }],
        ['accepted fix_now', { title: 'Accepted', file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
        ['no state', { title: 'Accepted', file: 'a.js', severity: 'low' }],
      ]) {
        const name = `${kind}, ${standing}, ${label}`;
        const { input } = ownInput(own, other, over);
        assert.deepEqual(settledEntries(input), [], `${name}: the raw copy offers nothing`);
        const split = splitRuled(ownRepeat, settledEntries(input));
        assert.deepEqual([split.ruled, split.findings.map((each) => each.title)], [[], ['The same cause']], `${name}: no waiver, the repeat is new`);
      }
    }
  }
});

test('passInput: a direct acceptance with no conflict still settles, through the record, inside or outside', () => {
  for (const [kind, own] of OWN_ACCEPTANCES) {
    for (const [standing, over] of STANDINGS) {
      const name = `${kind}, ${standing}`;
      const { input } = ownInput(own, null, over);
      const acceptedBy = own.accepted_by ? { accepted_by: own.accepted_by } : {};
      assert.deepEqual(settledEntries(input), [{ title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'engine:codex-local', ...acceptedBy }], `${name}: once, from the record`);
      const split = splitRuled(ownRepeat, settledEntries(input));
      assert.deepEqual([split.findings, split.ruled.map((each) => [each.already_ruled, each.from, each.settled_by])], [[], [['Accepted', 'prior', 'engine:codex-local']]], `${name}: the repeat is waived`);
    }
  }
  const elsewhere = ownInput(OWN_ACCEPTANCES[0][1], { title: 'Accepted', file: 'b.js', state: 'open', disposition: 'drop_unless_cited' }, {});
  assert.equal(splitRuled(ownRepeat, settledEntries(elsewhere.input)).ruled.length, 1, 'the same title in another file leaves the acceptance standing');
});

test('passInput: an exec pass\'s prior findings stay as context with nothing that settles, and the record keeps its acceptance', () => {
  const [, own] = OWN_ACCEPTANCES[0];
  const { state, input } = ownInput(own, { title: 'Accepted', file: 'a.js', state: 'fixed' }, {});
  assert.deepEqual(input.priorFindings, [{ title: 'Accepted', file: 'a.js', line: 3, body: 'Why.', severity: 'low' }], 'the title, place, words, and severity stay; the acceptance goes');
  assert.equal(state.passes['engine:codex-local'].list[0].state, 'accepted', 'the input is a copy: the record is untouched');
  const agent = ownInput(own, null, {}, { id: 'engine:codex-local', reviewer: 'code-reviewer', kind: 'agent', files: null });
  assert.equal(agent.input.priorFindings[0].state, 'accepted', 'an agent pass settles nothing, and reads the finding as recorded');

  const printed = { ...own, title: 'Marked', already_ruled: 'Marked', carried: true, residual: 'Marked: why', settled_by: 'someone' };
  const marked = ownInput(printed, { title: 'Marked', file: 'a.js', state: 'open', disposition: 'drop_unless_cited' }, {});
  assert.deepEqual(settledEntries(marked.input), [], 'a list entry marked as settled offers nothing');
  assert.deepEqual(offeredCarried(marked.input), [], 'nor is it offered as a carried ruling');
  for (const key of ['already_ruled', 'carried', 'residual', 'settled_by']) assert.ok(!(key in marked.input.priorFindings[0]), `the marked copy holds no ${key}`);
  assert.deepEqual(contextFindings([{ title: 'Open', state: 'open' }, { title: 'Fixed', state: 'fixed' }, { title: 'New' }, null, 'junk']), [{ title: 'Open', state: 'open' }, { title: 'Fixed', state: 'fixed' }, { title: 'New' }], 'another state stays, and a malformed entry goes');
});

test('contextFindings: a copy whose state was accepted keeps no acceptance wording, and a fix_now stays', () => {
  const copy = { title: 'Accepted', file: 'a.js', line: 3, body: 'Why.', severity: 'low' };
  for (const [kind, own] of OWN_ACCEPTANCES) {
    assert.deepEqual(contextFindings([own]), [copy], kind);
    assert.deepEqual(ownInput(own, { title: 'Accepted', file: 'a.js', state: 'fixed' }, {}).input.priorFindings, [copy], `${kind}: as the pass reads it`);
  }
  for (const disposition of ['accepted_residual', 'acceptable_as_is', 'drop_unless_cited']) assert.deepEqual(contextFindings([{ ...copy, state: 'accepted', disposition, accepted_by: 'late-round' }]), [copy], disposition);
  assert.deepEqual(contextFindings([{ ...copy, state: 'accepted', disposition: 'fix_now', accepted_by: 'late-round' }]), [{ ...copy, disposition: 'fix_now' }], 'fix_now is no acceptance');
  assert.deepEqual(contextFindings([{ ...copy, state: 'open', disposition: 'drop_unless_cited' }]), [{ ...copy, state: 'open', disposition: 'drop_unless_cited' }], 'another state keeps its disposition');
});

test('passInput: a fallback pass\'s kept findings stay as context too, and settle nothing', () => {
  const kept = { title: 'Kept', file: 'a.js', severity: 'high', state: 'accepted', disposition: 'fix_now' };
  const state = { ...emptyState(7, 'o/r'), passes: { 'agent:stopped': { head: 'h1', files: null, open: 1, list: [kept] } } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null, fallback: { kept: ['agent:stopped'] } };
  const input = passInput(context({ state, map: { 'codex-local': { kind: 'exec' } }, info: { body: '' } }), pass, { name: 'independent', passes: [] });
  assert.deepEqual(input.priorFindings, [{ title: 'Kept', file: 'a.js', severity: 'high', disposition: 'fix_now', pass: 'agent:stopped' }]);
  assert.deepEqual(settledEntries(input), []);
});

test('a carried ruling yields to its source while any pass lists it: re-attested lower, the source\'s severity governs', () => {
  const accepted = { title: 'Accepted', file: 'a.js', severity: 'medium', likelihood: 'contrived', affects: 'users', state: 'accepted', disposition: 'accepted_residual' };
  const lower = { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' };
  const { first, settled } = nextHead(accepted, [{ file: 'a.js', line: 3, title: 'Low repeat', body: 'b', severity: 'low', already_ruled: 'Accepted' }], [lower]);
  assert.equal(first.ruled[0].settled_severity, 'medium', 'the ruling on h1 carries a medium cap');
  assert.deepEqual(settled.filter((each) => each.title === 'Accepted'), [{ title: 'Accepted', file: 'a.js', severity: 'low', settled_by: 'agent:code-reviewer' }], 'only the source, at its severity now');
  const medium = splitRuled([{ file: 'a.js', line: 4, title: 'Medium repeat', body: 'b', severity: 'medium', already_ruled: 'Accepted' }], settled);
  assert.deepEqual(medium.findings.map((each) => each.title), ['Medium repeat'], 'a medium repeat stays new');
  assert.deepEqual(medium.ruled, []);
});

test('offeredCarried: the carried rulings of an input, as ruled entries of a prior finding; nothing else', () => {
  const input = { priorFindings: [
    { title: 'Accepted', file: 'a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited', settled_by: 'agent:code-reviewer' },
    { title: 'Root', file: 'b.js', line: 4, severity: 'medium', state: 'accepted', already_ruled: 'Root', carried: true, settled_by: 'agent:code-reviewer' },
    { title: 'Codex open', file: 'a.js', line: 2, severity: 'high' },
  ] };
  assert.deepEqual(offeredCarried(input), [{ title: 'Root', file: 'b.js', line: 4, severity: 'medium', already_ruled: 'Root', from: 'prior', settled_severity: 'medium', settled_by: 'agent:code-reviewer' }]);
  assert.deepEqual(offeredCarried({}), []);
});

test('ruledLines: the waived count and titles per pass, one line each, opening no HTML comment', () => {
  const state = { passes: {
    'engine:codex-local': { head: 'abcdef1234', ruled: [{ title: 'Retry <!-- x', file: 'a.js', line: 1, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' }] },
    'agent:code-reviewer': { head: 'abcdef1234', list: [] },
  } };
  assert.deepEqual(ruledLines(state), ['', RULED_HEADING, '- engine:codex-local on `abcdef1`: 1 waived as already ruled, never counted open: `Retry &lt;!-- x` (`a.js`, low, repeats `The retry loop has no cap`, settled by an accepted residual)']);
  const byPass = { passes: { p: { head: 'h', ruled: [
    { title: 'Ping @team', file: '@scope/a.js', line: 1, severity: 'low', already_ruled: 'Ask @org/owners', from: 'prior', settled_by: 'agent:code-reviewer' },
    { title: 'Old record', file: 'a.js', line: 2, severity: 'low', already_ruled: 'R', from: 'prior' },
  ] } } };
  const line = ruledLines(byPass)[2];
  assert.equal(line, '- p on `h`: 2 waived as already ruled, never counted open: `Ping @\u200dteam` (`@\u200dscope/a.js`, low, repeats `Ask @\u200dorg/owners`, settled by `agent:code-reviewer`); `Old record` (`a.js`, low, repeats `R`, settled by a prior finding)');
  assert.doesNotMatch(line, /@[A-Za-z]/u, 'no title, file, or name mentions anyone');
  assert.deepEqual(ruledLines({ passes: {} }), []);
  const many = { passes: { p: { head: 'h', ruled: Array.from({ length: 12 }, (_, i) => ({ title: `t${i}`, file: 'a.js', already_ruled: 'R' })) } } };
  assert.match(ruledLines(many)[2], /^- p on `h`: 12 waived as already ruled, never counted open: .*`t9` \(`a\.js`, repeats `R`, settled by a prior finding\); and 2 more$/u);
  assert.ok(summaryBody({ ...emptyState(7, 'o/r'), ...state }, null, 'fix_required').includes(RULED_HEADING), 'the summary comment shows them');
});

test('ruledLines: reviewer text renders as code, never as a link, an image, an autolink, or emphasis', () => {
  const state = { passes: { p: { head: 'h', ruled: [{
    title: 'See [the fix](https://evil.example/x) and *this*', file: '![pixel](https://evil.example/p.png)', line: 1, severity: 'low',
    already_ruled: 'Read https://evil.example/y `now`', from: 'prior', settled_by: '<https://evil.example/z>',
  }] } } };
  const line = ruledLines(state)[2];
  assert.equal(line, "- p on `h`: 1 waived as already ruled, never counted open: `See [the fix](https://evil.example/x) and *this*` (`![pixel](https://evil.example/p.png)`, low, repeats `Read https://evil.example/y 'now'`, settled by `<https://evil.example/z>`)");
  // Outside the code spans, nothing reviewer-supplied is left.
  assert.doesNotMatch(line.replace(/`[^`]*`/gu, ''), /evil|\[|\]|\*|<|>/u);
});

// A repository whose feat branch changes one file, reviewed by codex-local at depth single, with GitHub faked in memory.
function repo(t, firstBody, github = {}, { rule = { depth: 'single' }, review = {}, pull = () => INSIDE, cross = false } = {}) {
  let prBody = firstBody;
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-settled-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.aidrian/config.json', JSON.stringify({ version: 1, github, review: { rules: [{ when: { lines: { over: 0 } }, ...rule }], ...review } }));
  write('src/a.js', '0\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  write('src/a.js', '1\n2\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const comments = [];
  const forge = {
    change: () => ({ number: 7, headRefOid: git('rev-parse', 'HEAD'), baseRefName: 'main', body: prBody, isCrossRepository: cross }),
    pull,
    repo: () => 'o/r',
    conversationComments: () => comments,
    postComment: (_repo, _n, text) => comments.push({ id: comments.length + 1, body: text, author_association: 'MEMBER' }),
    editComment: (_repo, id, text) => (comments.find((comment) => comment.id === id).body = text),
  };
  const project = projectAt(dir);
  const step = (exec, deps = {}) => reviewStep({ pr: '7' }, { project, config: loadConfig(project).config, forge, exec, codex: () => ({ ok: true }), ...deps });
  // A new head on feat: the file changes again.
  const push = (text) => {
    write('src/a.js', text);
    git('add', '-A');
    git('commit', '-q', '-m', text.trim());
  };
  const add = (file, text) => {
    write(file, text);
    git('add', '-A');
    git('commit', '-q', '-m', file);
  };
  return { dir, project, comments, step, push, add, head: () => git('rev-parse', 'HEAD'), setBody: (text) => (prBody = text) };
}

test('the review step: codex-local reads the body\'s residuals, its waived repeat stays on the record as ruled, out of open, and shows in the summary comment', async (t) => {
  const r = repo(t, body(['The retry loop has no cap']));
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  t.after(() => rmSync(script, { force: true }));
  const printed = [
    { file: 'src/a.js', line: 1, title: 'Retry loop unbounded', body: 'b', severity: 'low', already_ruled: 'The retry loop has no cap' },
    { file: 'src/a.js', line: 2, title: 'Retry loop unbounded, worse', body: 'b', severity: 'medium', already_ruled: 'The retry loop has no cap' },
  ];
  writeFileSync(script, `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:${JSON.stringify(printed)},verdicts:[],contracts:[],cross_notes:[]})))`);
  const inputs = [];
  // The real runExec, with codex-local's Codex run swapped for the script.
  const exec = (reviewer, input, opts) => {
    inputs.push(input);
    return runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  };
  const result = await r.step(exec);
  assert.equal(result.status, 'fix_required', 'the medium repeat of a residual stays a new, blocking finding');
  assert.deepEqual(inputs[0].acceptedResiduals, ['The retry loop has no cap']);
  const record = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.deepEqual([record.findings, record.open], [2, 1], 'the waived repeat counts among the findings, never as open');
  assert.deepEqual(record.list.map((each) => each.title), ['Retry loop unbounded, worse']);
  assert.deepEqual(record.ruled, [{ title: 'Retry loop unbounded', file: 'src/a.js', line: 1, severity: 'low', already_ruled: 'The retry loop has no cap', from: 'residual' }]);
  assert.ok(record.dropped.some((note) => /Retry loop unbounded, worse" names an accepted residual, which settles only a low finding/u.test(note)));
  const summary = r.comments.at(-1).body;
  assert.ok(summary.includes(RULED_HEADING) && summary.includes('1 waived as already ruled') && summary.includes('`Retry loop unbounded` (`src/a.js`'), 'the summary comment names the waived count and title');
});

test('the review step: a carried ruling outlives a head where codex-local does not repeat it', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 5 });
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  const answers = `${script}.json`;
  t.after(() => rmSync(script, { force: true }));
  t.after(() => rmSync(answers, { force: true }));
  writeFileSync(script, `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:JSON.parse(fs.readFileSync(${JSON.stringify(answers)},'utf8')),verdicts:[],contracts:[],cross_notes:[]})))`);
  const exec = (reviewer, input, opts) => runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  const repeat = [{ file: 'src/a.js', line: 1, title: 'Same cause, new words', body: 'b', severity: 'low', already_ruled: 'Accepted' }];
  const edit = (change) => {
    const state = readLocalState(r.project, 7);
    change(state);
    writeLocalState(r.project, state);
  };
  // h1: a code-reviewer pass accepted the finding; codex-local repeats it.
  const seeded = emptyState(7, 'o/r');
  seeded.passes['agent:code-reviewer'] = { head: 'h0', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: 'Accepted', file: 'src/a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] };
  writeLocalState(r.project, seeded);
  writeFileSync(answers, JSON.stringify(repeat));
  await r.step(exec);
  assert.equal(readLocalState(r.project, 7).passes['engine:codex-local'].ruled.length, 1, 'h1: the repeat is waived');
  // h2: the source leaves the record, and codex-local does not repeat it.
  edit((state) => delete state.passes['agent:code-reviewer']);
  r.push('1\n2\n3\n');
  writeFileSync(answers, '[]');
  await r.step(exec);
  const h2 = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.ok(!('ruled' in h2), 'h2: nothing repeated');
  assert.deepEqual(h2.carried, [{ title: 'Accepted', file: 'src/a.js', line: 1, severity: 'low', already_ruled: 'Accepted', from: 'prior', settled_severity: 'low', settled_by: 'agent:code-reviewer' }], 'h2: the offered ruling stays on the record');
  // h3: codex-local repeats it again, and it is still waived.
  r.push('1\n2\n3\n4\n');
  writeFileSync(answers, JSON.stringify(repeat));
  const result = await r.step(exec);
  const h3 = readLocalState(r.project, 7).passes['engine:codex-local'];
  assert.deepEqual([h3.findings, h3.open], [1, 0], 'h3: the repeat is not re-raised');
  assert.deepEqual(h3.ruled.map((each) => [each.already_ruled, each.settled_by]), [['Accepted', 'agent:code-reviewer']]);
  assert.equal(result.status, 'received');
});

const RAISED = 'The retry loop has no cap';
// A residual line as the pull request body template writes it: `<defect>: <why>; the code comment that marks it`.
const RESIDUAL = `${RAISED}: every caller already times out first; the comment at src/a.js marks it`;
const codexFinding = (over) => ({ file: 'a.js', line: 2, title: RAISED, body: 'b', severity: 'medium', ...over });
const repeatOf = (over) => ({ file: 'a.js', line: 3, title: 'Retry loop unbounded', body: 'b', severity: 'medium', already_ruled: RAISED, ...over });
// The settled list of the next head, with codex-local's record holding `list` and the code-reviewer's holding `others`.
const settledOn = ({ list = [codexFinding()], carried, others = [], residuals = [RESIDUAL] } = {}) => {
  const state = { passes: {
    'engine:codex-local': { head: 'h1', list, ...(carried ? { carried } : {}) },
    'agent:code-reviewer': { head: 'h1', list: others },
  } };
  return settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], residuals), acceptedResiduals: residuals });
};

test('namedBy: a residual names a finding only by its exact title, a colon, and a reason, the longest title winning', () => {
  const title = (each) => ({ title: each });
  assert.deepEqual(namedBy(RESIDUAL, [title(RAISED)]), [title(RAISED)], 'the line the body template writes');
  for (const bare of [RAISED, `${RAISED}:`, `${RAISED}:   `]) assert.deepEqual(namedBy(bare, [title(RAISED)]), [], `no reason names nothing: "${bare}"`);
  for (const near of [
    `${RAISED.toLowerCase()}: why`, `**${RAISED}**: why`, `\`${RAISED}\`: why`, `${RAISED}. Why`, `${RAISED} - why`, `${RAISED} really: why`, `Why: ${RAISED}`, `${RAISED}, and another: why`,
  ]) assert.deepEqual(namedBy(near, [title(RAISED)]), [], `a near copy names nothing: ${near}`);
  assert.deepEqual(namedBy('A: b: why', [title('A'), title('A: b')]), [title('A: b')], 'a title that opens another does not name its finding');
  const twoFiles = [{ title: RAISED, file: 'src/a.js' }, { title: RAISED, file: 'src/b.js' }];
  assert.deepEqual(namedBy(`${RAISED}: every caller times out first`, twoFiles), [], 'one title in two files, no path in the line: neither');
  assert.deepEqual(namedBy(`${RAISED}: only \`src/b.js\` retries`, twoFiles), [twoFiles[1]], 'the file whose path the line holds');
  assert.deepEqual(namedBy(`${RAISED}: src/a.js and src/b.js both time out`, twoFiles), twoFiles, 'every file whose path the line holds');
  assert.deepEqual(namedBy(`${RAISED}: see lib/src/a.js and src/b.json and src/a.js.map`, twoFiles), [], 'a path inside a longer path is not that path');
  assert.deepEqual(namedBy(`${RAISED}: every caller times out first`, [twoFiles[0]]), [twoFiles[0]], 'one file raised needs no path');
  assert.deepEqual(namedBy(`${RAISED}; Other title: why`, [title(RAISED), title('Other title')]), [], 'one line opening with two titles names neither: the body takes one line each');
});

test('residualTexts: a residual whose why runs onto continuation lines still names the finding by its opening words', () => {
  const [text] = residualTexts(`## Accepted residuals\n\n- ${RAISED}: every caller\n  already times out first\n\n## Tests\n`);
  assert.equal(text, `${RAISED}: every caller already times out first`);
  const settled = settledOn({ residuals: [text] });
  assert.deepEqual(splitRuled([repeatOf()], settled).findings, []);
});

test('an anchored residual settles a repeat up to the raised finding\'s severity, by the title or by the residual\'s text', () => {
  const settled = settledOn();
  assert.deepEqual(settled, [
    { title: RAISED, file: 'a.js', severity: 'medium', residual: RESIDUAL },
    { title: RESIDUAL, file: 'a.js', severity: 'medium', residual: RESIDUAL, raised: RAISED },
  ], 'codex-local\'s own state-less entry is the anchor, under both names');
  const ruled = { title: 'Retry loop unbounded', file: 'a.js', line: 3, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL };
  assert.deepEqual(splitRuled([repeatOf()], settled), { findings: [], ruled: [ruled], notes: [] });
  assert.deepEqual(splitRuled([repeatOf({ already_ruled: RESIDUAL })], settled), { findings: [], ruled: [ruled], notes: [] }, 'either name records the raised title');
  assert.deepEqual(settledOn({ residuals: [RAISED] }), [{ title: RAISED }], 'a title with no reason anchors nothing, and stays at low');
});

test('a residual naming no raised finding waives nothing above low', () => {
  const unnamed = 'A defect only the body mentions: why';
  for (const [label, record] of [
    ['nothing raised', { list: [] }],
    ['another finding raised', { list: [codexFinding({ title: 'Something else' })] }],
    ['no file', { list: [{ title: 'A defect only the body mentions', severity: 'medium' }] }],
  ]) {
    const settled = settledOn({ ...record, residuals: [unnamed] });
    assert.deepEqual(settled, [{ title: unnamed }], `${label}: the bare residual`);
    const medium = splitRuled([repeatOf({ already_ruled: unnamed })], settled);
    assert.deepEqual(medium.ruled, [], `${label}: a medium repeat stays new`);
    assert.match(medium.notes[0], /names an accepted residual, which settles only a low finding/u);
    assert.equal(splitRuled([repeatOf({ already_ruled: 'A defect only the body mentions' })], settled).ruled.length, 0, `${label}: its bare title names nothing`);
    assert.equal(splitRuled([repeatOf({ already_ruled: unnamed, severity: 'low' })], settled).ruled.length, 1, `${label}: a low repeat is still waived`);
  }
});

test('a low ruling on an unanchored residual never becomes an anchor on a later head', () => {
  const unnamed = 'A defect only the body mentions: why';
  const low = { title: 'A defect only the body mentions', file: 'a.js', line: 1, severity: 'low', already_ruled: unnamed, from: 'residual' };
  const state = { passes: { 'engine:codex-local': { head: 'h2', list: [], ruled: [low], carried: [{ ...low, settled_severity: 'low' }] } } };
  const settled = settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], [unnamed]), acceptedResiduals: [unnamed] });
  assert.deepEqual(settled, [{ title: unnamed }], 'only a kept anchor with its `residual` counts as raised');
});

test('an anchored residual never settles a repeat in another file, one more severe than the raised finding, or one above medium', () => {
  const settled = settledOn();
  for (const [label, repeat, note] of [
    ['another file, by title', repeatOf({ file: 'b.js' }), /in another file/u],
    ['another file, by title, low', repeatOf({ file: 'b.js', severity: 'low' }), /in another file/u],
    ['another file, by the residual\'s text, low', repeatOf({ file: 'b.js', severity: 'low', already_ruled: RESIDUAL }), /in another file/u],
    ['more severe', repeatOf({ severity: 'high' }), /less severe than it/u],
  ]) {
    const split = splitRuled([repeat], settled);
    assert.deepEqual(split.ruled, [], `${label}: nothing is waived`);
    assert.match(split.notes[0], note, label);
  }
  const low = settledOn({ list: [codexFinding({ severity: 'low' })] });
  assert.deepEqual(splitRuled([repeatOf()], low).ruled, [], 'a medium repeat of a raised low finding is new');
  assert.equal(splitRuled([repeatOf({ severity: 'low' })], low).ruled.length, 1);
  for (const severity of ['high', 'critical']) {
    const kept = [{ title: RAISED, file: 'a.js', line: 2, severity, already_ruled: RAISED, from: 'residual', settled_severity: severity, residual: RESIDUAL }];
    for (const [phase, record] of [['listed', { list: [codexFinding({ severity })] }], ['kept', { list: [], carried: kept }]]) {
      const raisedHigh = settledOn(record);
      assert.deepEqual(raisedHigh, [{ title: RESIDUAL }], `${severity}, ${phase}: it anchors nothing, and the line is a bare residual`);
      for (const repeat of [repeatOf({ severity }), repeatOf(), repeatOf({ already_ruled: RESIDUAL })]) {
        assert.deepEqual(splitRuled([repeat], raisedHigh).ruled, [], `${severity}, ${phase}: a ${repeat.severity} repeat is weighed again`);
      }
      assert.equal(splitRuled([repeatOf({ severity: 'low', already_ruled: RESIDUAL })], raisedHigh).ruled.length, 1, `${severity}, ${phase}: the bare residual still waives a low repeat`);
    }
  }
});

test('a fix or a blocking listing ends the anchor, on the raised list and on the kept one; the state-less entry never does', () => {
  const kept = [{ title: RAISED, file: 'a.js', line: 2, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL }];
  for (const [label, other] of [
    ['fixed', { title: RAISED, file: 'a.js', state: 'fixed' }],
    ['open and blocking', { title: RAISED, file: 'a.js', severity: 'medium', state: 'open', disposition: 'accepted_residual' }],
    ['open with no disposition', { title: RAISED, file: 'a.js', severity: 'medium', state: 'open' }],
    ['accepted but fix_now', { title: RAISED, file: 'a.js', severity: 'critical', state: 'accepted', disposition: 'fix_now' }],
  ]) {
    for (const [phase, record] of [['raised', { list: [codexFinding()] }], ['kept', { list: [], carried: kept }]]) {
      const settled = settledOn({ ...record, others: [other] });
      assert.deepEqual(settled, [{ title: RESIDUAL }], `${label}, ${phase}: only the bare residual is left`);
      const split = splitRuled([repeatOf()], settled);
      assert.deepEqual(split.findings.map((each) => each.title), ['Retry loop unbounded'], `${label}, ${phase}: the repeat is new`);
      assert.deepEqual(split.ruled, []);
    }
  }
  const elsewhere = settledOn({ others: [{ title: RAISED, file: 'b.js', state: 'fixed' }] });
  assert.equal(splitRuled([repeatOf()], elsewhere).ruled.length, 1, 'the same title in another file leaves it standing');
  const asIs = settledOn({ list: [], carried: kept, others: [{ title: RAISED, file: 'a.js', severity: 'low', state: 'open', disposition: 'acceptable_as_is' }] });
  assert.deepEqual(asIs.map((each) => each.severity), ['low', 'low'], 'a listing that does not block governs at its own severity, over the kept anchor');
  assert.equal(splitRuled([repeatOf()], settledOn({ list: [], carried: kept })).ruled.length, 1, 'with no listing, the kept anchor holds');
});

test('the summary names the residual that settled a waiver, and the prompt states the rule with its texts only in the JSON input', () => {
  const state = { passes: { 'engine:codex-local': { head: 'abcdef1234', ruled: [
    { title: 'Retry loop unbounded', file: 'a.js', line: 3, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL },
    { title: 'Bare', file: 'a.js', line: 4, severity: 'low', already_ruled: 'Bare text', from: 'residual' },
  ] } } };
  const line = ruledLines(state)[2];
  assert.ok(line.includes(`repeats \`${RAISED}\`, settled by the accepted residual \`${RESIDUAL.slice(0, 80)}\``), line);
  assert.ok(line.includes('repeats `Bare text`, settled by an accepted residual'), 'a residual naming nothing keeps its line');
  const mention = ruledLines({ passes: { p: { head: 'h', ruled: [{ title: 't', file: 'a.js', already_ruled: 'x', from: 'residual', residual: 'See [it](https://evil.example) @team' }] } } })[2];
  assert.ok(mention.includes('`See [it](https://evil.example) @‍team`'), 'the residual renders as code, mentioning nobody');

  const input = { base: 'b1', head: 'h1', flows: [], files: ['a.js'], priorFindings: recordSettled({ passes: { p: { list: [codexFinding()] } } }, null, [RESIDUAL]), acceptedResiduals: [RESIDUAL] };
  const [brief, json] = reviewPrompt(input).split('Input (JSON):');
  assert.match(brief, /A `priorFindings` entry with a `residual` field is a finding a reviewer raised on this pull request, named by that residual: the prior finding's rule applies to it and to that residual's text, in the entry's `file` only, and that residual settles nothing else\./u);
  assert.match(brief, /Any other residual names no raised finding, and keeps the residual's rule\./u);
  assert.ok(!brief.includes(RAISED) && !brief.includes(RESIDUAL), 'no finding or residual text in the instructions');
  assert.ok(json.includes(RESIDUAL) && json.includes(RAISED));
  assert.equal(settledBrief(settledEntries(input)), brief.split('\n').find((each) => each.startsWith('Settled findings:')));
});

test('passInput: an exec pass reads the anchored entry only while the body names the raised finding; an agent pass never does', () => {
  const state = { ...emptyState(7, 'o/r'), passes: { 'engine:codex-local': { head: 'h1', files: null, list: [codexFinding()] } } };
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const anchoredOf = (input) => input.priorFindings.filter((each) => each.residual);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body([RESIDUAL]) } }), pass, stage)).map((each) => [each.title, each.file, each.severity, each.residual]), [[RAISED, 'a.js', 'medium', RESIDUAL]]);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body(['Another residual: why']) } }), pass, stage)), []);
  assert.deepEqual(anchoredOf(passInput(context({ state, map, info: { body: body([RESIDUAL]) } }), { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null }, { name: 'local', passes: [] })), []);
});

// A review step of `r` with codex-local swapped for a script that prints the findings `answer` writes, its inputs kept.
function scripted(t, r, deps = {}) {
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  const answers = `${script}.json`;
  t.after(() => rmSync(script, { force: true }));
  t.after(() => rmSync(answers, { force: true }));
  writeFileSync(script, `import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({findings:JSON.parse(fs.readFileSync(${JSON.stringify(answers)},'utf8')),verdicts:[],contracts:[],cross_notes:[]})))`);
  const inputs = [];
  const exec = (reviewer, input, opts) => {
    inputs.push(input);
    return runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  };
  const run = async (findings, text) => {
    if (text) r.push(text);
    writeFileSync(answers, JSON.stringify(findings));
    const result = await r.step(exec, deps);
    return { result, record: readLocalState(r.project, 7).passes['engine:codex-local'] };
  };
  return { run, inputs };
}

const FILE_REPEAT = { file: 'src/a.js', line: 1, title: 'Retry loop unbounded', body: 'b', severity: 'medium', already_ruled: RAISED };
const FILE_RAISED = { file: 'src/a.js', line: 2, title: RAISED, body: 'b', severity: 'medium', already_ruled: '' };

test('the review step: a medium codex-local finding the body lists as an accepted residual stays waived on heads 2, 3, and 4, across one with no repeat', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run, inputs } = scripted(t, r);
  const h1 = await run([FILE_RAISED]);
  assert.equal(h1.result.status, 'fix_required', 'head 1: the finding blocks');
  assert.deepEqual(h1.record.list.map((each) => [each.title, each.state]), [[RAISED, undefined]], 'head 1: it sits on the record with no state');
  assert.ok(!('carried' in h1.record), 'head 1: no residual yet, so no anchor');

  r.setBody(body([RESIDUAL]));
  const h2 = await run([FILE_REPEAT], '1\n2\n3\n');
  assert.equal(h2.result.status, 'received', 'head 2: the repeat does not block');
  assert.deepEqual([h2.record.findings, h2.record.open, h2.record.list], [1, 0, []], 'head 2: the repeat is not open, and leaves the list');
  assert.deepEqual(h2.record.ruled, [{ title: 'Retry loop unbounded', file: 'src/a.js', line: 1, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL }]);
  const summary = r.comments.at(-1).body;
  assert.ok(summary.includes(`settled by the accepted residual \`${RESIDUAL.slice(0, 80)}\``), 'head 2: the summary comment names the residual');

  const h3 = await run([], '1\n2\n3\n4\n');
  assert.ok(!('ruled' in h3.record), 'head 3: Codex does not repeat it');
  assert.deepEqual(h3.record.carried.map((each) => [each.already_ruled, each.from, each.settled_severity, each.residual]), [[RAISED, 'residual', 'medium', RESIDUAL]], 'head 3: the anchor stays on the record');
  assert.equal(h3.result.status, 'received');

  const h4 = await run([{ ...FILE_REPEAT, already_ruled: RESIDUAL }], '1\n2\n3\n4\n5\n');
  assert.equal(h4.result.status, 'received', 'head 4: the repeat is still waived, named by the residual\'s text this time');
  assert.deepEqual([h4.record.open, h4.record.ruled.map((each) => [each.already_ruled, each.residual])], [0, [[RAISED, RESIDUAL]]]);
  assert.ok(inputs.at(-1).priorFindings.some((each) => each.title === RAISED && each.residual === RESIDUAL), 'head 4: the input still offers it, with nothing on any list');
});

test('the review step: removing the residual from the body ends the waiver on the next head', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  await run([FILE_RAISED]);
  r.setBody(body([RESIDUAL]));
  assert.equal((await run([FILE_REPEAT], '1\n2\n3\n')).record.open, 0, 'waived while the body lists it');
  r.setBody(body([]));
  const h3 = await run([FILE_REPEAT], '1\n2\n3\n4\n');
  assert.equal(h3.result.status, 'fix_required', 'the repeat blocks again');
  assert.deepEqual([h3.record.open, h3.record.list.map((each) => each.title)], [1, ['Retry loop unbounded']], 'it comes back as new');
  assert.ok(!('carried' in h3.record), 'the anchor leaves the record');
  assert.match(h3.record.dropped.join('\n'), /names no settled finding/u);
});

test('the review step: an agent pass listing the finding as fixed ends the waiver on the next head', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  await run([FILE_RAISED]);
  r.setBody(body([RESIDUAL]));
  assert.equal((await run([FILE_REPEAT], '1\n2\n3\n')).record.open, 0);
  const state = readLocalState(r.project, 7);
  state.passes['agent:code-reviewer'] = { head: 'h2', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: RAISED, file: 'src/a.js', state: 'fixed' }] };
  writeLocalState(r.project, state);
  const h3 = await run([FILE_REPEAT], '1\n2\n3\n4\n');
  assert.equal(h3.result.status, 'fix_required');
  assert.deepEqual([h3.record.open, h3.record.list.map((each) => each.title)], [1, ['Retry loop unbounded']], 'the repeat comes back as new');
});

test('the body template opens a residual line with the finding\'s exact title, a colon, and the reason, which is what names it', () => {
  const template = readFileSync(new URL('../plugins/aidrian/skills/pr-write/references/body-template.md', import.meta.url), 'utf8');
  const [line] = template.split('## Accepted residuals\n\n')[1].split('\n');
  assert.match(line, /^- <the finding's exact title\b[^>]*>: <why\b/u, line);
  const raised = [{ title: RAISED }];
  assert.deepEqual(namedBy(line.replace(/^- <[^>]*>/u, RAISED), raised), raised, 'the shape the template writes is the shape namedBy reads');
});

test('a later second file ends a line that names no path; a line that names a path keeps its own file', () => {
  const noPath = `${RAISED}: every caller already times out first`;
  const named = `${RAISED}: every caller of a.js already times out first`;
  const later = [codexFinding(), codexFinding({ file: 'b.js' })];
  assert.deepEqual(settledOn({ residuals: [noPath] }).map((each) => each.file), ['a.js', 'a.js'], 'one file raised: anchored there');
  assert.deepEqual(settledOn({ list: later, residuals: [noPath] }), [{ title: noPath }], 'a second file raised: the line names neither');
  assert.deepEqual(splitRuled([repeatOf()], settledOn({ list: later, residuals: [noPath] })).ruled, [], 'and the repeat is new again');
  const pathed = settledOn({ list: later, residuals: [named] });
  assert.deepEqual([...new Set(pathed.map((each) => each.file))], ['a.js'], 'only the file the line holds');
  assert.equal(splitRuled([repeatOf()], pathed).ruled.length, 1);
  assert.deepEqual(splitRuled([repeatOf({ file: 'b.js' })], pathed).ruled, []);
});

test('the summary gives each waiver\'s severity and cap, and lists a carried anchored residual as standing on each head', () => {
  const anchor = { title: RAISED, file: 'a.js', line: 2, severity: 'medium', already_ruled: RAISED, from: 'residual', settled_severity: 'medium', residual: RESIDUAL };
  const state = { passes: {
    p: { head: 'abcdef1234', ruled: [{ ...anchor, title: 'Low repeat', severity: 'low' }], carried: [anchor, { title: 'Prior', file: 'a.js', severity: 'low', already_ruled: 'Prior', from: 'prior', settled_severity: 'low' }] },
    q: { head: 'abcdef1234', carried: [anchor] },
  } };
  const by = `settled by the accepted residual \`${RESIDUAL.slice(0, 80)}\``;
  assert.deepEqual(ruledLines(state), [
    '', RULED_HEADING,
    `- p on \`abcdef1\`: 1 waived as already ruled, never counted open: \`Low repeat\` (\`a.js\`, low, settled at medium, repeats \`${RAISED}\`, ${by})`,
    `- p on \`abcdef1\`: 1 standing on an accepted residual: \`${RAISED}\` (\`a.js\`, medium, settled at medium, ${by})`,
    `- q on \`abcdef1\`: 1 standing on an accepted residual: \`${RAISED}\` (\`a.js\`, medium, settled at medium, ${by})`,
  ], 'a pass with no repeat still shows the anchor, and a carried ruling on a prior finding is not a residual');
  assert.deepEqual(ruledLines({ passes: { p: { head: 'h', carried: [{ title: 'Prior', file: 'a.js', from: 'prior' }] } } }), []);
});

test('an outside pull request\'s residuals waive nothing, and an answer that cannot be read counts as outside', () => {
  const state = { ...emptyState(7, 'o/r'), passes: { 'engine:codex-local': { head: 'h1', files: null, list: [codexFinding()] } } };
  const map = { 'codex-local': { kind: 'exec' } };
  const pass = { id: 'engine:codex-local', reviewer: 'codex-local', files: null };
  const stage = { name: 'independent', passes: [pass] };
  const info = { body: body([RESIDUAL]) };
  const inputOf = (over) => passInput(context({ state, map, info, ...over }), pass, stage);
  assert.deepEqual(inputOf({}).acceptedResiduals, [RESIDUAL], 'inside: the body\'s line reaches the pass');
  for (const [label, over] of [
    ['a fork\'s branch', { cross: true }],
    ['no standing', { pull: () => ({ ...INSIDE, author_association: 'NONE' }) }],
    ['a base that is a fork', { pull: () => ({ ...INSIDE, base: { repo: { fork: true } } }) }],
    ['the pull read fails', { pull: () => { throw new Error('gh: 502'); } }],
    ['the pull answer is unreadable', { pull: () => ({}) }],
    ['the view answer is unreadable', { cross: null }],
  ]) {
    const input = inputOf(over);
    assert.deepEqual(input.acceptedResiduals, [], `${label}: no residuals`);
    assert.deepEqual(input.priorFindings.filter((each) => each.residual), [], `${label}: no anchors`);
    assert.deepEqual(splitRuled([repeatOf({ severity: 'low', already_ruled: RESIDUAL })], settledEntries(input)).ruled, [], `${label}: not even a low repeat`);
  }
});

test('passInput reads the author\'s standing once a step, and never for an agent pass', () => {
  const state = emptyState(7, 'o/r');
  const map = { 'codex-local': { kind: 'exec' }, 'code-reviewer': { kind: 'agent' } };
  let reads = 0;
  const s = context({ state, map, info: { body: body([RESIDUAL]) }, pull: () => {
    reads += 1;
    return INSIDE;
  } });
  const stage = { name: 'independent', passes: [] };
  passInput(s, { id: 'agent:code-reviewer', reviewer: 'code-reviewer', kind: 'agent', files: null }, stage);
  assert.equal(reads, 0);
  for (let i = 0; i < 2; i += 1) passInput(s, { id: 'engine:codex-local', reviewer: 'codex-local', files: null }, stage);
  assert.equal(reads, 1);
});

test('the review step: an outside author\'s line naming a raised finding waives nothing', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 }, { pull: () => ({ ...INSIDE, author_association: 'NONE' }) });
  const { run, inputs } = scripted(t, r);
  await run([FILE_RAISED]);
  r.setBody(body([RESIDUAL]));
  const h2 = await run([FILE_REPEAT], '1\n2\n3\n');
  assert.equal(h2.result.status, 'fix_required', 'the repeat blocks');
  assert.deepEqual(inputs.at(-1).acceptedResiduals, []);
  assert.deepEqual([h2.record.open, h2.record.list.map((each) => each.title)], [1, ['Retry loop unbounded']]);
  assert.ok(!('ruled' in h2.record) && !('carried' in h2.record));
});

test('the review step: a stopped finding\'s reason reaches the fix_required list, with no key on a pass that has none', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  const { result } = await run([FILE_REPEAT]);
  assert.equal(result.status, 'fix_required');
  const [entry] = result.open;
  assert.equal(entry.dropped.length, 1);
  assert.match(entry.dropped[0], /finding "Retry loop unbounded" names no settled finding .*kept as a new finding/u);
  const clean = repo(t, body([]), { maxReviewRounds: 6 });
  const { result: plain } = await scripted(t, clean).run([FILE_RAISED]);
  assert.ok(!('dropped' in plain.open[0]), 'nothing dropped: no key');
});

test('the review step: an acceptance that stays listed on a head with no repeat keeps its ruling for the head it leaves', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  const repeat = [{ file: 'src/a.js', line: 1, title: 'Same cause, new words', body: 'b', severity: 'medium', already_ruled: 'Accepted' }];
  const seeded = emptyState(7, 'o/r');
  seeded.passes['agent:code-reviewer'] = { head: 'h0', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: 'Accepted', file: 'src/a.js', severity: 'medium', likelihood: 'contrived', affects: 'users', state: 'accepted', disposition: 'accepted_residual' }] };
  writeLocalState(r.project, seeded);
  const h1 = await run(repeat);
  assert.equal(h1.record.ruled.length, 1, 'head 1: the repeat is waived');
  const h2 = await run([], '1\n2\n3\n');
  assert.ok(!('ruled' in h2.record), 'head 2: nothing repeated, the acceptance still listed');
  assert.deepEqual(h2.record.carried, [{ title: 'Accepted', file: 'src/a.js', severity: 'medium', already_ruled: 'Accepted', from: 'prior', settled_severity: 'medium', settled_by: 'agent:code-reviewer' }], 'head 2: the ruling stays on the record');
  const state = readLocalState(r.project, 7);
  delete state.passes['agent:code-reviewer'];
  writeLocalState(r.project, state);
  const h3 = await run(repeat, '1\n2\n3\n4\n');
  assert.equal(h3.result.status, 'received', 'head 3: the acceptance left the record, and the repeat is still waived');
  assert.deepEqual([h3.record.open, h3.record.ruled.map((each) => [each.already_ruled, each.settled_severity])], [0, [['Accepted', 'medium']]]);
});

test('rulings are read from every pass record: a slice whose file list changed keeps them', () => {
  const ruling = { title: 'Same cause', file: 'a.js', line: 3, severity: 'low', already_ruled: 'Root', from: 'prior', settled_severity: 'medium' };
  const state = { passes: { 'slice:codex-local:0123456789': { head: 'h1', files: ['a.js', 'b.js'], list: [], ruled: [ruling] } } };
  const fresh = recordSettled(state, null);
  assert.deepEqual(fresh.map((each) => [each.title, each.file, each.severity, each.carried]), [['Root', 'a.js', 'medium', true]], 'no prior result of its own, and the ruling still holds');
  assert.equal(splitRuled([repeatOf({ severity: 'medium', already_ruled: 'Root' })], settledEntries({ priorFindings: fresh })).ruled.length, 1);
});

test('the review step: fields a reviewer prints on an exec finding settle nothing, on the record or on the next head', async (t) => {
  const printed = { state: 'accepted', disposition: 'acceptable_as_is', accepted_by: 'late-round', residual: RESIDUAL, carried: true, settled_severity: 'medium' };
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run, inputs } = scripted(t, r);
  const h1 = await run([{ ...FILE_RAISED, ...printed }]);
  assert.equal(h1.result.status, 'fix_required', 'head 1: a printed acceptance does not close it');
  assert.equal(h1.record.open, 1);
  for (const key of Object.keys(printed)) assert.ok(!(key in h1.record.list[0]), `${key} never reaches the record`);
  const h2 = await run([{ ...FILE_REPEAT, ...printed }], '1\n2\n3\n');
  assert.equal(h2.result.status, 'fix_required', 'head 2: with no line in the body, the repeat blocks');
  assert.deepEqual(h2.record.ruled, undefined);
  assert.ok(!('carried' in h2.record));
  assert.deepEqual(inputs.at(-1).priorFindings.filter((each) => each.state === 'accepted' || each.residual || each.carried), [], 'head 2: nothing it printed is offered as settled');
  assert.match(h2.record.dropped.join('\n'), /names no settled finding/u);
});

// The disposition table with the late-round rule on from the first round.
const LATE_TABLE = { ...loadTable(), lateRoundFrom: 1 };
const LATE_FINDING = { file: 'src/a.js', line: 2, title: 'Late nit', body: 'b', severity: 'low', already_ruled: '' };
const LATE_REPEAT = { file: 'src/a.js', line: 1, title: 'Late nit, new words', body: 'b', severity: 'low', already_ruled: 'Late nit' };
const lateRow = (line) => ({ pass: 'engine:codex-local', title: 'Late nit', file: 'src/a.js', line, severity: 'low' });

test('a late-round residual stays in residuals, once, when a reviewer returns it as already ruled or the pass only carries it', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r, { dispositionTable: LATE_TABLE });
  const h1 = await run([LATE_FINDING]);
  assert.deepEqual([h1.result.status, h1.result.residuals], ['received', [lateRow(2)]], 'head 1: listed');
  const h2 = await run([LATE_REPEAT], '1\n2\n3\n');
  assert.deepEqual([h2.record.list, h2.record.ruled.map((each) => each.accepted_by)], [[], ['late-round']], 'head 2: ruled, off the list');
  assert.deepEqual(h2.result.residuals, [lateRow(1)], 'head 2: under the title the record accepted');
  const h3 = await run([], '1\n2\n3\n4\n');
  assert.deepEqual([h3.record.ruled, h3.record.carried.map((each) => each.accepted_by)], [undefined, ['late-round']], 'head 3: carried, with no repeat');
  assert.deepEqual(h3.result.residuals, [lateRow(1)], 'head 3: still named');
  const h4 = await run([LATE_REPEAT], '1\n2\n3\n4\n5\n');
  assert.deepEqual([h4.record.ruled.length, h4.record.carried.length], [1, 1], 'head 4: both ruled and carried');
  assert.deepEqual(h4.result.residuals, [lateRow(1)], 'head 4: one row');
});

// A residual line as the session writes it from a late row, naming the finding by its title.
const LATE_LINE = 'Late nit: only reached at boot; the comment at src/a.js marks it';

test('a late-round residual whose line the body holds may leave residuals: the line holds it, and a low repeat stays waived', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r, { dispositionTable: LATE_TABLE });
  const h1 = await run([LATE_FINDING]);
  assert.deepEqual([h1.result.status, h1.result.residuals], ['received', [lateRow(2)]], 'head 1: the row names it for the body');
  r.setBody(body([LATE_LINE]));
  const h2 = await run([], '1\n2\n3\n');
  assert.equal(h2.result.status, 'received');
  assert.equal(h2.result.residuals, undefined, 'head 2: the row goes');
  assert.deepEqual(h2.record.carried.map((each) => [each.already_ruled, each.from, each.settled_severity, each.residual]), [['Late nit', 'residual', 'low', LATE_LINE]], 'head 2: the line holds it');
  const h3 = await run([LATE_REPEAT], '1\n2\n3\n4\n');
  assert.deepEqual([h3.result.status, h3.record.open, h3.record.ruled.map((each) => each.residual)], ['received', 0, [LATE_LINE]], 'head 3: the repeat is waived on the line');
  assert.equal(h3.result.residuals, undefined, 'head 3: no row comes back');
  r.setBody(body([]));
  const h4 = await run([], '1\n2\n3\n4\n5\n');
  assert.equal(h4.record.carried, undefined, 'head 4: dropping the line ends it');
});

// The late-round rule on from the second round, so a first round's medium finding blocks and a low one after it is accepted.
const SECOND_ROUND_TABLE = { ...loadTable(), lateRoundFrom: 2 };
// A medium finding on round 1, a low of its title and file the late-round rule accepts on round 2, the body's line on it
// with no repeat on round 3: the record then holds a carried low anchor and a round entry at medium.
async function lowAcceptedOverMedium(t) {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run, inputs } = scripted(t, r, { dispositionTable: SECOND_ROUND_TABLE });
  const h1 = await run([FILE_RAISED]);
  assert.equal(h1.result.status, 'fix_required', 'round 1: the medium finding blocks');
  const h2 = await run([{ ...FILE_RAISED, severity: 'low' }], '1\n2\n3\n');
  assert.deepEqual([h2.result.status, h2.record.list.map((each) => each.accepted_by)], ['received', ['late-round']], 'round 2: the rule accepts the low');
  assert.deepEqual(h2.result.residuals.map((each) => [each.title, each.severity]), [[RAISED, 'low']], 'round 2: its row names it');
  r.setBody(body([RESIDUAL]));
  const h3 = await run([], '1\n2\n3\n4\n');
  assert.deepEqual(h3.record.carried.map((each) => [each.already_ruled, each.settled_severity, each.residual]), [[RAISED, 'low', RESIDUAL]], 'round 3: the line anchors at low');
  assert.deepEqual(readLocalState(r.project, 7).rounds.flatMap((round) => round.findings ?? []).map((each) => [each.title, each.severity]), [[RAISED, 'medium']], 'the round entry still holds the medium');
  return { run, inputs, r };
}

test('a line on a late-round low anchors at low: an earlier round entry at medium waives no medium repeat', async (t) => {
  const { run, inputs } = await lowAcceptedOverMedium(t);
  const h4 = await run([FILE_REPEAT], '1\n2\n3\n4\n5\n');
  assert.deepEqual([h4.result.status, h4.record.open, h4.record.ruled], ['fix_required', 1, undefined], 'the medium repeat blocks');
  assert.deepEqual([...new Set(settledEntries(inputs.at(-1)).map((each) => each.severity))], ['low'], 'the input offers it at low alone');
  assert.match(h4.record.dropped.join('\n'), /less severe than it/u);
});

test('a line on a late-round low still waives a low repeat, with an earlier round entry at medium', async (t) => {
  const { run } = await lowAcceptedOverMedium(t);
  const h4 = await run([{ ...FILE_REPEAT, severity: 'low' }], '1\n2\n3\n4\n5\n');
  assert.deepEqual([h4.result.status, h4.record.open], ['received', 0]);
  assert.deepEqual(h4.record.ruled.map((each) => [each.already_ruled, each.settled_severity, each.residual]), [[RAISED, 'low', RESIDUAL]]);
});

// A second finding of another title, which blocks a head on its own.
const FILE_OTHER = { file: 'src/a.js', line: 4, title: 'Another defect', body: 'b', severity: 'medium', already_ruled: '' };
const LOW_REPEAT = { ...FILE_REPEAT, severity: 'low' };
const LOW_FINDING = { ...FILE_RAISED, severity: 'low' };
// Round 1's medium finding, round 2's low of its title and file, which the late-round rule accepts, and round 3's reviewer
// returning the low as already ruled, all with no line in the body: the record then holds a ruling at low and a round entry
// at medium. `extraHead` adds a head that only carries the ruling; `other` makes round 2 block on another finding.
async function lowRuledOverMedium(t, { extraHead = false, other = false } = {}) {
  const r = repo(t, body([]), { maxReviewRounds: 7 });
  const { run, inputs } = scripted(t, r, { dispositionTable: SECOND_ROUND_TABLE });
  assert.equal((await run([FILE_RAISED])).result.status, 'fix_required', 'round 1: the medium finding blocks');
  const h2 = await run([LOW_FINDING, ...(other ? [FILE_OTHER] : [])], '1\n2\n3\n');
  assert.deepEqual([h2.result.status, h2.record.list[0].accepted_by], [other ? 'fix_required' : 'received', 'late-round'], 'round 2: the rule accepts the low');
  const h3 = await run([LOW_REPEAT], '1\n2\n3\n4\n');
  assert.deepEqual([h3.result.status, h3.record.list, h3.record.ruled.map((each) => [each.already_ruled, each.from, each.settled_severity, each.accepted_by])], ['received', [], [[RAISED, 'prior', 'low', 'late-round']]], 'round 3: ruled, off the list');
  if (extraHead) {
    const h4 = await run([], '1\n2\n3\n4\n5\n');
    assert.deepEqual([h4.record.ruled, h4.record.carried.map((each) => [each.already_ruled, each.from, each.settled_severity])], [undefined, [[RAISED, 'prior', 'low']]], 'a head that only carries the ruling');
  }
  assert.deepEqual(readLocalState(r.project, 7).rounds.flatMap((round) => round.findings ?? []).filter((each) => each.title === RAISED).map((each) => each.severity), ['medium'], 'the round entry still holds the medium');
  r.setBody(body([RESIDUAL]));
  return { run, inputs, r };
}

for (const [label, options] of [
  ['the ruling made on the head before the line', {}],
  ['a head that only carries the ruling', { extraHead: true }],
  ['the low\'s head blocked on another finding', { other: true }],
]) {
  test(`a line on a low the record holds as a ruling stays at low over a medium round entry: ${label}`, async (t) => {
    const { run, inputs } = await lowRuledOverMedium(t, options);
    const repeat = await run([FILE_REPEAT], '1\n2\n3\n4\n5\n6\n');
    assert.deepEqual([repeat.result.status, repeat.record.open, repeat.record.ruled], ['fix_required', 1, undefined], 'the medium repeat blocks');
    assert.deepEqual([...new Set(settledEntries(inputs.at(-1)).filter((each) => each.file).map((each) => each.severity))], ['low'], 'the input offers it at low alone');
    assert.match(repeat.record.dropped.join('\n'), /less severe than it/u);
  });

  test(`a line on a low the record holds as a ruling still waives a low repeat: ${label}`, async (t) => {
    const { run } = await lowRuledOverMedium(t, options);
    const repeat = await run([LOW_REPEAT], '1\n2\n3\n4\n5\n6\n');
    assert.deepEqual([repeat.result.status, repeat.record.open, repeat.record.ruled.map((each) => each.settled_severity)], ['received', 0, ['low']]);
    assert.deepEqual(repeat.result.residuals.map((each) => [each.title, each.severity]), [[RAISED, 'low']], 'the ruling keeps its row, which a session skips');
  });
}

test('a medium raised over a low the record holds stands on the line once the author rewords it', async (t) => {
  const reworded = `${RAISED}: every caller times out first, and the comment at src/a.js marks it`;
  for (const start of [lowAcceptedOverMedium, lowRuledOverMedium]) {
    const { run, r: held } = await start(t);
    const raised = await run([FILE_RAISED], '1\n2\n3\n4\n5\n6\n');
    assert.deepEqual([raised.result.status, raised.record.open], ['fix_required', 1], 'the new medium blocks');
    held.setBody(body([reworded]));
    const waived = await run([FILE_REPEAT], '1\n2\n3\n4\n5\n6\n7\n');
    assert.deepEqual([waived.result.status, waived.record.ruled.map((each) => [each.already_ruled, each.settled_severity, each.residual])], ['received', [[RAISED, 'medium', reworded]]], 'the listing governs at medium');
    const again = await run([FILE_REPEAT], '1\n2\n3\n4\n5\n6\n7\n8\n');
    assert.deepEqual([again.result.status, again.record.ruled.map((each) => each.settled_severity)], ['received', ['medium']], 'and the anchor keeps its severity on the next head');
  }
});

test('any ruling on a prior finding governs over a round entry, in ruled or carried; a ruling on an unnamed residual does not', () => {
  const noted = { title: RAISED, file: 'a.js', line: 2, severity: 'medium' };
  const ruling = { title: 'Other words', file: 'a.js', line: 3, severity: 'low', already_ruled: RAISED, from: 'prior', settled_severity: 'low' };
  const severities = (record) => {
    const state = { rounds: [{ head: 'h1', findings: [noted] }], passes: { 'engine:codex-local': { head: 'h2', list: [], ...record } } };
    return [...new Set(settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], [RESIDUAL]), acceptedResiduals: [RESIDUAL] }).filter((each) => each.file).map((each) => each.severity))];
  };
  assert.deepEqual(severities({}), ['medium'], 'with no ruling, the round entry anchors');
  assert.deepEqual(severities({ ruled: [ruling] }), ['low'], 'a ruling the pass made');
  assert.deepEqual(severities({ carried: [ruling] }), ['low'], 'a ruling the pass carries');
  assert.deepEqual(severities({ ruled: [{ ...ruling, accepted_by: 'late-round' }] }), ['low'], 'a late-round ruling');
  assert.deepEqual(severities({ ruled: [{ ...ruling, settled_severity: undefined }] }), ['low'], 'with no cap on record, the ruling\'s own severity');
  assert.deepEqual(severities({ ruled: [{ ...ruling, from: 'residual' }] }), ['medium'], 'a ruling on a residual with no text is no anchor');
  assert.deepEqual(severities({ ruled: [null, 'x'], carried: 'x' }), ['medium'], 'malformed entries read as nothing');
});

test('a late-round residual two arrays or two passes hold is one row per title and file, named for the first pass holding it', () => {
  const late = { file: 'a.js', severity: 'low', accepted_by: 'late-round' };
  const ruled = { ...late, title: 'Other words', line: 7, already_ruled: 'Late', settled_severity: 'low', from: 'prior' };
  const carried = { ...late, title: 'Late', line: 8, already_ruled: 'Late', settled_severity: 'low', from: 'prior' };
  const records = { a: { list: [{ ...late, title: 'Late', line: 6, state: 'accepted', disposition: 'accepted_residual' }], ruled: [ruled], carried: [carried] }, b: { list: null, carried: [carried] } };
  const passes = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(lateResiduals(passes, (pass) => records[pass.id]), [{ pass: 'a', title: 'Late', file: 'a.js', line: 6, severity: 'low' }]);
  assert.deepEqual(lateResiduals(passes.slice(1), (pass) => records[pass.id]), [{ pass: 'b', title: 'Late', file: 'a.js', line: 8, severity: 'low' }]);
  assert.deepEqual(lateResiduals([{ id: 'c' }], () => ({ carried: [{ ...late, title: 'Repeat', line: 9, already_ruled: 'Capped', settled_severity: 'medium', from: 'prior' }] })), [{ pass: 'c', title: 'Capped', file: 'a.js', line: 9, severity: 'medium' }], 'a row names the severity the record accepted, not the repeat\'s');
  assert.deepEqual(lateResiduals(passes, () => null), [], 'a pass with no result names nothing');
  assert.deepEqual(lateResiduals([{ id: 'c' }], () => ({ ruled: [{ title: 'Earlier', file: 'a.js', severity: 'low', already_ruled: 'Earlier', from: 'prior' }, null] })), [], 'a ruling with no accepted_by is no late residual');
});

test('accepted_by reaches a ruling only from the record\'s accepted entry, never from what a reviewer prints', () => {
  const printed = { ...ownRepeat[0], accepted_by: 'late-round' };
  const [[, attested], [, late]] = OWN_ACCEPTANCES;
  const fromRecord = (own) => settledEntries(ownInput(own, null, {}).input);
  assert.deepEqual(splitRuled([printed], fromRecord(attested)).ruled.map((each) => each.accepted_by), [undefined], 'a printed value on a repeat of another acceptance');
  assert.deepEqual(splitRuled(ownRepeat, fromRecord(late)).ruled.map((each) => each.accepted_by), ['late-round'], 'the record\'s own');
  assert.deepEqual(splitRuled([{ ...printed, accepted_by: 'someone' }], fromRecord(late)).ruled.map((each) => each.accepted_by), ['late-round'], 'a printed value replaces nothing');
  assert.deepEqual(settledEntries({ priorFindings: contextFindings([late]) }), [], 'the context copy offers no acceptance to take it from');
  const state = { passes: { p: { head: 'h1', list: [], ruled: [{ title: 'Repeat', file: 'a.js', line: 1, severity: 'low', already_ruled: 'Late', from: 'prior', settled_severity: 'low', accepted_by: 'late-round' }] } } };
  const offered = recordSettled(state, null);
  assert.deepEqual(offered.map((each) => each.accepted_by), ['late-round'], 'a ruling carries the acceptance it recorded');
  assert.deepEqual(offeredCarried({ priorFindings: offered }).map((each) => each.accepted_by), ['late-round']);
  assert.deepEqual(settledEntries({ priorFindings: offered }).map((each) => each.accepted_by), ['late-round']);
});

test('the review step: a printed accepted_by reaches no residuals, on a new finding or on a repeat of an acceptance', async (t) => {
  const r = repo(t, body([]), { maxReviewRounds: 6 });
  const { run } = scripted(t, r);
  const seeded = emptyState(7, 'o/r');
  seeded.passes['agent:code-reviewer'] = { head: 'h0', reviewer: 'code-reviewer', files: null, findings: 1, open: 0, list: [{ title: 'Accepted', file: 'src/a.js', severity: 'low', state: 'accepted', disposition: 'drop_unless_cited' }] };
  writeLocalState(r.project, seeded);
  const { record, result } = await run([
    { file: 'src/a.js', line: 1, title: 'Same cause', body: 'b', severity: 'low', already_ruled: 'Accepted', accepted_by: 'late-round' },
    { file: 'src/a.js', line: 2, title: 'New', body: 'b', severity: 'low', already_ruled: '', accepted_by: 'late-round' },
  ]);
  assert.equal(result.residuals, undefined);
  assert.deepEqual(record.ruled.map((each) => [each.already_ruled, each.accepted_by]), [['Accepted', undefined]]);
  assert.deepEqual(record.list.map((each) => [each.title, each.accepted_by, each.state]), [['New', undefined, undefined]]);
});

test('the review step: a printed state, disposition, or acceptance settles nothing, and a late-round acceptance on the record still settles', async (t) => {
  const printed = { state: 'accepted', disposition: 'acceptable_as_is', accepted_by: 'late-round' };
  const answer = { file: 'src/a.js', line: 2, title: 'Printed', body: 'b', severity: 'low', ...printed };
  const inputs = [];
  // An exec outcome that still holds the printed fields, so this reads the step's own rule, not the output cleaner's.
  const exec = async (_reviewer, input) => {
    inputs.push(input);
    return { status: 'done', findings: [answer], ruled: [], carried: [], verdicts: [], contracts: [], cross_notes: [], dropped: [] };
  };
  const early = repo(t, body([]), { maxReviewRounds: 6 });
  const first = await early.step(exec);
  assert.equal(first.status, 'fix_required', 'before the late rounds a low finding blocks, whatever it prints');
  const [kept] = readLocalState(early.project, 7).passes['engine:codex-local'].list;
  for (const key of Object.keys(printed)) assert.ok(!(key in kept), `${key} never reaches the record`);
  early.push('1\n2\n3\n');
  await early.step(exec);
  assert.deepEqual(settledEntries(inputs.at(-1)), [], 'a printed value settles nothing on the next head');

  const late = repo(t, body([]), { maxReviewRounds: 6 });
  const deps = { dispositionTable: LATE_TABLE };
  assert.equal((await late.step(exec, deps)).status, 'received');
  late.push('1\n2\n3\n');
  await late.step(exec, deps);
  const entries = settledEntries(inputs.at(-1));
  assert.deepEqual(entries, [{ title: 'Printed', file: 'src/a.js', severity: 'low', settled_by: 'engine:codex-local', accepted_by: 'late-round' }], 'the rule\'s own acceptance settles, through the record');
  assert.deepEqual(inputs.at(-1).priorFindings[0], { file: 'src/a.js', line: 2, title: 'Printed', body: 'b', severity: 'low' }, 'its context copy shows no acceptance');
  assert.equal(splitRuled([{ file: 'src/a.js', line: 3, title: 'Same cause', body: 'b', severity: 'low', already_ruled: 'Printed' }], entries).ruled.length, 1);
});

test('the review step at depth split: a repack deletes the slice before the exec pass runs, and the round entry still anchors the line', async (t) => {
  const file = 'src/deep/x.js';
  const r = repo(t, body([]), { maxReviewRounds: 6 }, {
    rule: { depth: 'split', require: ['agent:code-reviewer'] }, review: { split: { sliceLines: 800, parallel: 8, maxSlices: 8 } },
  });
  r.add(file, '1\n');
  const script = path.join(r.dir, '..', `${path.basename(r.dir)}-reviewer.mjs`);
  const answers = `${script}.json`;
  t.after(() => rmSync(script, { force: true }));
  t.after(() => rmSync(answers, { force: true }));
  // A slice holding the file answers with the findings written; every other pass finds nothing.
  writeFileSync(script, `import fs from 'node:fs';let text='';process.stdin.on('data',(chunk)=>text+=chunk);process.stdin.on('end',()=>{const input=JSON.parse(text);const here=input.role==='slice'&&input.files.includes(${JSON.stringify(file)});console.log(JSON.stringify({findings:here?JSON.parse(fs.readFileSync(${JSON.stringify(answers)},'utf8')):[],verdicts:[],contracts:[],cross_notes:[]}))})`);
  const inputs = [];
  const exec = (reviewer, input, opts) => {
    inputs.push(input);
    return runExec({ ...reviewer, builtIn: undefined, command: [process.execPath, script], timeoutSec: 10 }, input, opts);
  };
  const passes = () => readLocalState(r.project, 7).passes;
  // Attests each dispatched agent with no findings and steps until the head has its answer; `onDispatch` runs at the first one.
  const settle = async (onDispatch = () => {}) => {
    let result = await r.step(exec);
    while (['dispatch', 'running'].includes(result.status)) {
      if (result.status === 'dispatch') {
        onDispatch();
        for (const each of result.dispatch) recordPass(r.project, { pr: 7, repo: 'o/r', pass: each.pass, head: result.head, reviewer: each.pass.replace('agent:', ''), findings: 0, fixed: 0 });
      }
      result = await r.step(exec);
    }
    return result;
  };

  writeFileSync(answers, JSON.stringify([{ ...FILE_RAISED, file }]));
  const first = await settle();
  assert.equal(first.status, 'fix_required', 'head 1: the finding blocks');
  const slice = Object.keys(passes()).find((id) => id.startsWith('slice:') && passes()[id].files.includes(file));
  assert.ok(passes()[slice].list.some((each) => each.title === RAISED), 'head 1: its slice lists it');
  assert.deepEqual(readLocalState(r.project, 7).rounds[0].findings.map((each) => [each.title, each.file, each.severity]), [[RAISED, file, 'medium']], 'head 1: its round entry holds it');

  // A package root above the folder changes the key of the file's slice, so that slice's record goes when the agent is dispatched.
  r.setBody(body([RESIDUAL]));
  r.add('src/package.json', '{}\n');
  writeFileSync(answers, JSON.stringify([{ ...FILE_REPEAT, file }]));
  inputs.length = 0;
  let pruned = null;
  const second = await settle(() => (pruned ??= !(slice in passes())));
  assert.equal(pruned, true, 'head 2: the old slice left the record before any exec pass ran');
  assert.equal(second.status, 'received', 'head 2: the repeat is waived on the round entry\'s word');
  const here = inputs.find((input) => input.role === 'slice' && input.files.includes(file));
  assert.ok(here.priorFindings.some((each) => each.title === RAISED && each.file === file && each.residual === RESIDUAL), 'head 2: the pass was offered the anchor');
  const record = Object.values(passes()).find((each) => each.ruled);
  assert.deepEqual(record.ruled.map((each) => [each.already_ruled, each.settled_severity, each.residual]), [[RAISED, 'medium', RESIDUAL]]);
});

test('a round entry anchors only while no pass lists it, under the same cap, and not when capped to nothing', () => {
  const round = (findings) => ({ head: 'h1', findings });
  const noted = { title: RAISED, file: 'a.js', line: 2, severity: 'medium' };
  const settledWith = (rounds, list = []) => {
    const state = { rounds, passes: { 'engine:codex-local': { head: 'h2', list } } };
    return settledEntries({ priorFindings: recordSettled(state, state.passes['engine:codex-local'], [RESIDUAL]), acceptedResiduals: [RESIDUAL] });
  };
  assert.deepEqual(settledWith([round([noted])]).map((each) => [each.title, each.severity]), [[RAISED, 'medium'], [RESIDUAL, 'medium']]);
  assert.deepEqual(settledWith([round([{ ...noted, severity: 'high' }])]), [{ title: RESIDUAL }], 'above medium anchors nothing');
  assert.deepEqual(settledWith([round(null), round([null, 'x', { title: 'flow f: invariant i violated', file: null, line: null, severity: null }])]), [{ title: RESIDUAL }], 'null or malformed entries read as nothing');
  assert.deepEqual(settledWith([round(null)]), [{ title: RESIDUAL }], 'a pass counted without its findings leaves none');
  const lower = settledWith([round([noted])], [codexFinding({ severity: 'low' })]);
  assert.deepEqual([...new Set(lower.map((each) => each.severity))], ['low'], 'a listing governs over the round entry');
  const fixed = settledWith([round([noted])], [{ title: RAISED, file: 'a.js', state: 'fixed' }]);
  assert.deepEqual(fixed, [{ title: RESIDUAL }], 'a fix listing ends it while it stands');
});
