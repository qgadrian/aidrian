import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { CASE_SCHEMA, CROSS_SCHEMA, DECIDE_LEDGER_SCHEMA, DECIDE_REBUTTAL_SCHEMA, LEDGER_SCHEMAS, governingWinner, modeOf, schemaProblems } from '../plugins/aidrian/lib/quorum.mjs';
import { cli, temp, write, project, cite, objection, ledger, legacy, PASSING, planLedger, accepts, rejects, concede, fakeCodex, codexRun, ANSWER, REBUTTALS, SKILL, skillTexts, ASKED, position, stand, point, answer, tested, FIRST, decision, decideLedger, decideProject, productLedger } from './quorum-fixture.mjs';

const FAILS = cite('code', 'src/app.js:1', 'not in the file');
const escalated = { decision: 'escalate', winner: null, change_or_reason: 'cap reached, 8 of 8 dispatches', citations: [PASSING.adr], tested: [], inferences: [] };
// The same ledger before the ruling: open, with no ruling or rebuttal.
const opened = (over = {}) => decideLedger({ status: 'open', ruling: null, rebuttals: [], ...over });

test('decide schemas: every node Codex-strict, a full ledger and each answer pass, and LEDGER_SCHEMAS holds the decide schema', () => {
  const strict = (node, where) => {
    if ([node.type].flat().includes('object')) {
      assert.equal(node.additionalProperties, false, where);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), where);
      for (const [key, child] of Object.entries(node.properties)) strict(child, `${where}.${key}`);
    }
    if (node.items) strict(node.items, `${where}[]`);
  };
  for (const [name, schema] of Object.entries({ DECIDE_LEDGER_SCHEMA, CASE_SCHEMA, CROSS_SCHEMA, DECIDE_REBUTTAL_SCHEMA })) strict(schema, name);
  assert.equal(LEDGER_SCHEMAS.decide, DECIDE_LEDGER_SCHEMA);
  assert.equal(modeOf(decideLedger()), 'decide');
  assert.deepEqual(schemaProblems(decideLedger(), DECIDE_LEDGER_SCHEMA), []);
  assert.deepEqual(schemaProblems(decideLedger({ final_ruling: escalated, human_answer: 'keep A' }), DECIDE_LEDGER_SCHEMA), []);
  const { human_answer: _, ...unanswered } = decideLedger();
  for (const [value, problem] of [
    [unanswered, '$.human_answer is missing'],
    [decideLedger({ ruling: { ...decision(), tested: undefined } }), '$.ruling.tested must be array'],
    [decideLedger({ ruling: decision({ tested: [{ citation: 0, supports: true, reason: 'r' }] }) }), '$.ruling.tested[0].of is missing'],
    [decideLedger({ ruling: decision({ winner: 'E' }) }), '$.ruling.winner must be one of A, B, C, D'],
    [decideLedger({ cross: [point('A1', 'B', [PASSING.code], { status: 'accepted' })] }), '$.cross[0].status must be one of pending, opinion, backed'],
    [decideLedger({ objections: [] }), '$.objections is not a known field'],
  ]) assert.deepEqual(schemaProblems(value, DECIDE_LEDGER_SCHEMA), [problem]);
  assert.deepEqual(schemaProblems({ case: { claim: 'c', citations: [PASSING.adr] } }, CASE_SCHEMA), []);
  assert.deepEqual(schemaProblems({ case: { claim: 'c' } }, CASE_SCHEMA), ['$.case.citations is missing']);
  const points = (count) => ({ cross: Array.from({ length: count }, () => ({ against: 'B', claim: 'c', citations: [] })) });
  assert.deepEqual(schemaProblems(points(5), CROSS_SCHEMA), []);
  assert.deepEqual(schemaProblems(points(6), CROSS_SCHEMA), ['$.cross has 6 items, more than 5']);
  assert.deepEqual(schemaProblems({ rebuttal: { verdict: 'concede', claim: 'c', citations: [PASSING.adr] } }, DECIDE_REBUTTAL_SCHEMA), []);
  assert.deepEqual(schemaProblems({ rebuttal: { verdict: 'yield', claim: 'c', citations: [] } }, DECIDE_REBUTTAL_SCHEMA), ['$.rebuttal.verdict must be one of rebut, concede']);
});

test('check decide: a full ledger passes unchanged, its plan citations anchored on the question file`s option and context headings', async (t) => {
  const p = decideProject(t);
  const full = decideLedger();
  // A process run, so the command's own entry in bin/aidrian stays tested.
  const result = await p.check(full, p.question, { asProcess: true });
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
  assert.deepEqual(result.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
  assert.deepEqual(result.ledger, full);
  // An anchor by heading text, by slug, and on Context pass; a quote from another option's section does not.
  const anchors = await p.check(opened({ cases: [stand('A', [ASKED.context, ASKED.c]), stand('B', [cite('plan', '#a-keep-one-ledger', 'Each round writes its own file.')])] }));
  assert.equal(anchors.status, 0, anchors.stderr);
  assert.deepEqual(anchors.lines, [
    'case B.citations[0] (plan #a-keep-one-ledger): the plan#a-keep-one-ledger does not contain the quote',
    'case B: no citation passes',
    'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 2 problems',
  ]);
  // A claim's question file anchors on `## Claim`.
  const claim = path.join(p.state, 'quorum/questions/one-ledger-is-enough-abc1234.md');
  write(p.state, 'quorum/questions/one-ledger-is-enough-abc1234.md', '# One ledger is enough\n\n## Claim\nOne ledger holds\nevery round.\n');
  const onClaim = await p.check(opened({ cases: [stand('A', [cite('plan', '#claim', 'One ledger holds every round.')]), stand('B', [cite('plan', '#Claim', 'every round')])], cross: [] }), claim);
  assert.equal(onClaim.status, 0, onClaim.stderr);
  assert.deepEqual(onClaim.lines, ['checked: mode decide, 2 cases, 0 cross points, 0 opinion, 0 problems']);
});

test('check decide: a pending cross point becomes backed or opinion by its citations; only a pending one is relabeled', async (t) => {
  const p = decideProject(t);
  const result = await p.check(opened({ cross: [point('A1', 'B', [FAILS, PASSING.code], { status: 'pending' }), point('B1', 'A', [FAILS], { status: 'pending' }), point('B2', 'A', [FAILS])] }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.cross.map((each) => each.status), ['backed', 'opinion', 'backed']);
  assert.deepEqual(result.lines.filter((line) => !line.includes('.citations[')), [
    'cross B1: relabeled opinion (was pending): no citation passes',
    'cross B2: no citation passes; kept backed',
    'checked: mode decide, 2 cases, 3 cross points, 1 opinion, 5 problems',
  ]);
});

test('check decide: each invalid ruling, final ruling, rebuttal, and concession is named, with its reason', async (t) => {
  const p = decideProject(t);
  const inferred = 'Split files read faster.\ninference: readers open one round at a time';
  const rebutted = (citations, claim) => [answer('B', 'rebut', citations, claim)];
  const finalOn = (over) => decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }), ...over });
  for (const [over, lines] of [
    [{ ruling: decision({ citations: [FAILS] }) }, ['ruling: invalid: the ruling has no passing citation']],
    [{ ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }) }) }, ['ruling: invalid: tested names 1 of 2 citations of case A']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'B1', citation: 0, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 0 of 1 citations of cross B1; 0 more than once']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'A1', citation: 3, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 1 of 1 citations of cross A1; 3 out of range']],
    [{ ruling: decision({ tested: [...tested(FIRST), { of: 'C', citation: 0, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names C, which the ruling does not rule on']],
    // An opinion is not ruled on: a verdict on it is stray, and none is needed.
    [{ cross: [point('A1', 'B', [PASSING.code]), point('B1', 'A', [FAILS], { status: 'opinion' })] }, ['ruling: invalid: tested names B1, which the ruling does not rule on']],
    [{ ruling: decision({ tested: tested(FIRST, ['A', 'B']) }) }, ["ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    // A position wins on evidence or not at all: a rule for one whose case has no passing citation goes back.
    // Its one verdict, `supports: true`, is on a citation that does not pass, so it supports nothing either.
    [{ cases: [stand('A', [FAILS]), stand('B', [ASKED.b])], ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }, ['B']) }) }, ["ruling: invalid: the winner's case has no passing citation", "ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    [{ ruling: decision({ tested: [...tested(FIRST, ['B']).filter((each) => each.of !== 'A'), { of: 'A', citation: 2, supports: true, reason: 'r' }] }) }, ['ruling: invalid: tested names 0 of 2 citations of case A; 2 out of range', "ruling: invalid: a rule rests on no supporting citation of the winner's case"]],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b], inferred)] }, ['ruling: invalid: inference untested: "readers open one round at a time"']],
    [{ cross: [point('A1', 'B', [PASSING.code], { claim: 'B is slow.\ninference: the disk is the bottleneck' }), point('B1', 'A', [PASSING.docBySlug])] }, ['ruling: invalid: inference untested: "the disk is the bottleneck"']],
    [{ rebuttals: rebutted([FAILS]) }, ['rebuttal B: invalid: the rebuttal has no passing citation']],
    [{ rebuttals: rebutted([ASKED.b]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: rebutted([PASSING.code]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: rebutted([PASSING.adr]) }, ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [{ rebuttals: [answer('B', 'concede', [])] }, ['rebuttal B: invalid: the concession has no passing citation']],
    [{ rebuttals: [answer('B', 'concede', [FAILS])] }, ['rebuttal B: invalid: the concession has no passing citation']],
    [{ rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ citations: [FAILS] }) }, ['final ruling: invalid: the ruling has no passing citation']],
    [{ rebuttals: rebutted([PASSING.fenced, PASSING.exact]), final_ruling: finalOn() }, ['final ruling: invalid: tested names 1 of 2 citations of rebuttal B']],
    [{ rebuttals: rebutted([PASSING.fenced], 'It is faster.\ninference: rounds are read alone'), final_ruling: finalOn() }, ['final ruling: invalid: inference untested: "rounds are read alone"']],
    [{ rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ winner: 'B', tested: tested({ B: 1 }, ['B']) }) }, ["final ruling: invalid: a flip rests on no supporting citation of the winner's rebuttal"]],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [FAILS])], rebuttals: rebutted([PASSING.fenced]), final_ruling: finalOn({ winner: 'B' }) }, ["final ruling: invalid: the winner's case has no passing citation"]],
  ]) {
    const result = await p.check(decideLedger({ status: 'open', ...over }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines.filter((line) => line.includes(': invalid: ')), lines, JSON.stringify(over));
  }
  // Every inference line tested, a concession citing the ruling's own evidence, and a valid final rule pass clean.
  const inferences = [{ statement: 'readers open one round at a time', holds: false, reason: 'r', citations: [] }];
  const clean = await p.check(decideLedger({ cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b], inferred)], ruling: decision({ inferences }) }));
  assert.equal(clean.status, 0, clean.stderr);
  assert.deepEqual(clean.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
});

// A citation that stopped passing supports nothing: `supports: true` on it, beside `supports: false` on one that passes,
// leaves an accept, a rule, or a flip with no supporting citation. The same verdicts swapped are valid.
test('check: only a verdict on a citation that passes now supports a plan accept, a decide rule, or a flip', async (t) => {
  const pair = (of, first, second) => [{ ...of, citation: 0, supports: first, reason: 'r' }, { ...of, citation: 1, supports: second, reason: 'r' }];
  const p = project(t);
  for (const [build, where] of [
    [(tested) => objection('A1', [FAILS, PASSING.code], { status: 'accepted', ruling: accepts({ tested }) }), 'objection A1 ruling'],
    [(tested) => objection('A1', [PASSING.code], { status: 'accepted', ruling: rejects(), rebuttal: { verdict: 'rebut', claim: 'c', citations: [FAILS, PASSING.fenced], ruling: accepts({ tested }) } }), 'objection A1 rebuttal ruling'],
  ]) {
    for (const [tested, lines] of [[pair({}, true, false), [`${where}: invalid: an accept rests on no supporting citation`]], [pair({}, false, true), []]]) {
      const result = await p.check(planLedger([build(tested)]));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines.filter((line) => line.startsWith(`${where}: invalid: `)), lines, JSON.stringify(tested));
    }
  }
  const d = decideProject(t);
  const rule = (onA) => ({ cases: [stand('A', [FAILS, ASKED.a]), stand('B', [ASKED.b])], ruling: decision({ tested: [...onA, ...tested({ B: 1, A1: 1, B1: 1 }, ['B'])] }) });
  const flip = (onB) => ({ rebuttals: [answer('B', 'rebut', [FAILS, PASSING.fenced])], final_ruling: decision({ winner: 'B', citations: [PASSING.fenced], tested: onB }) });
  for (const [build, of, line] of [
    [rule, 'A', "ruling: invalid: a rule rests on no supporting citation of the winner's case"],
    [flip, 'B', "final ruling: invalid: a flip rests on no supporting citation of the winner's rebuttal"],
  ]) {
    for (const [verdictsOn, lines] of [[pair({ of }, true, false), [line]], [pair({ of }, false, true), []]]) {
      const result = await d.check(decideLedger({ status: 'open', ...build(verdictsOn) }));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines.filter((each) => each.includes(': invalid: ')), lines, JSON.stringify(verdictsOn));
    }
  }
});

test('check decide: a complete ledger with no ruling, an unanswered loser, an unruled rebut, a governing winner with no evidence, or a stale ruling exits 1 unwritten', async (t) => {
  const p = decideProject(t);
  const flip = { rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: decision({ winner: 'B', citations: [PASSING.fenced], tested: tested({ B: 1 }) }) };
  for (const [over, line] of [
    [{ ruling: null, rebuttals: [] }, 'ruling is null in a complete ledger'],
    [{ rebuttals: [] }, 'position B lost the ruling and has no rebuttal in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])] }, 'rebuttal B rebuts with no final ruling in a complete ledger'],
    // Settled by the Human, the governing winner still needs its evidence.
    [{ cases: [stand('A', [FAILS]), stand('B', [ASKED.b])], ruling: decision({ tested: tested({ A: 1, B: 1, A1: 1, B1: 1 }, ['B']) }), rebuttals: [], final_ruling: escalated, human_answer: 'keep A' }, "case A: the governing winner's case has no passing citation in a complete ledger"],
    [{ cases: [stand('A', [ASKED.a, PASSING.adr])] }, 'position B has no case in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: decision({ citations: [FAILS], tested: tested({ B: 1 }) }) }, 'final ruling: invalid: the ruling has no passing citation in a complete ledger'],
    [{ rebuttals: [answer('B', 'rebut', [FAILS])], final_ruling: decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }) }) }, 'rebuttal B: invalid: the rebuttal has no passing citation in a complete ledger'],
    [{ ...flip, cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [FAILS])] }, "case B: the governing winner's case has no passing citation in a complete ledger"],
    [{ ruling: decision({ citations: [FAILS] }) }, 'ruling: invalid: the ruling has no passing citation in a complete ledger'],
    [{ rebuttals: [answer('B', 'concede', [FAILS])] }, 'rebuttal B: invalid: the concession has no passing citation in a complete ledger'],
  ]) {
    const value = decideLedger(over);
    const result = await p.check(value);
    assert.equal(result.status, 1, line);
    assert.ok(result.stderr.includes(`: ${line}\n`), `${line}\n${result.stderr}`);
    assert.deepEqual(result.ledger, value, 'not written');
  }
  // An escalation settles an invalid ruling, answered or deferred, as an escalated objection is settled in plan mode.
  for (const human_answer of ['keep A', null]) {
    const settled = await p.check(decideLedger({ ruling: decision({ decision: 'escalate', winner: null, citations: [FAILS] }), rebuttals: [], human_answer }));
    assert.equal(settled.status, 0, settled.stderr);
    assert.deepEqual(settled.lines, ['ruling.citations[0] (code src/app.js:1): src/app.js does not contain the quote', 'ruling: invalid: the ruling has no passing citation', 'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 2 problems']);
  }
  // A flip that stands on the winner's evidence passes, and governs.
  const flipped = await p.check(decideLedger(flip));
  assert.equal(flipped.status, 0, flipped.stderr);
  assert.deepEqual(flipped.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
  assert.equal(governingWinner(decideLedger(flip)), 'B');
  assert.equal(governingWinner(decideLedger()), 'A');
  assert.equal(governingWinner(decideLedger({ final_ruling: escalated })), 'A');
  assert.equal(governingWinner(decideLedger({ ruling: decision({ decision: 'escalate', winner: null }) })), null);
});

test('check decide: each way the rebuttal round ends short escalates in the final ruling, and passes with the Human`s answer set or deferred', async (t) => {
  const p = decideProject(t);
  for (const [rebuttals, lines] of [
    // (a) an invalid rebuttal, (b) a loser that never answered, (c) a rebut the cap left without an architect's ruling.
    [[answer('B', 'rebut', [PASSING.adr])], ['rebuttal B: invalid: the rebuttal cites nothing new']],
    [[], []],
    [[answer('B', 'rebut', [PASSING.fenced])], []],
  ]) {
    for (const human_answer of ['keep A', null]) {
      const result = await p.check(decideLedger({ rebuttals, final_ruling: escalated, human_answer }));
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(result.lines, [...lines, `checked: mode decide, 2 cases, 2 cross points, 0 opinion, ${lines.length} problems`]);
    }
  }
  // A first ruling that escalates has no loser to rebut; deferred, it is complete.
  const deferred = await p.check(decideLedger({ ruling: decision({ decision: 'escalate', winner: null }), rebuttals: [] }));
  assert.equal(deferred.status, 0, deferred.stderr);
  assert.deepEqual(deferred.lines, ['checked: mode decide, 2 cases, 2 cross points, 0 opinion, 0 problems']);
});

// modes/decide.md round 4: a first ruling invalid again is replaced by the coordinator's escalate, with the architect's
// last decision and winner after check's line, its citations, and no verdicts.
test('check decide: a coordinator-written first escalate after two invalid rulings passes deferred and answered, its tested lines printed and never stale', async (t) => {
  const p = decideProject(t);
  const last = decision({ tested: tested({ A: 2, B: 1, A1: 1 }, ['B']) });
  const written = { decision: 'escalate', winner: null, change_or_reason: 'ruling: invalid: tested names 0 of 1 citations of cross B1\nThe architect ruled rule, for A.', citations: last.citations, tested: [], inferences: [] };
  const lines = ['case A', 'case B', 'cross A1', 'cross B1'].map((entry) => `ruling: invalid: tested names 0 of ${entry === 'case A' ? 2 : 1} citations of ${entry}`);
  for (const human_answer of [null, 'keep A']) {
    const before = decideLedger({ ruling: written, rebuttals: [], human_answer });
    const result = await p.check(before);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'no line is stale');
    assert.deepEqual(result.lines, [...lines, 'checked: mode decide, 2 cases, 2 cross points, 0 opinion, 4 problems']);
    assert.deepEqual(result.ledger, before, 'written back as it was');
  }
  // The architect's last ruling kept as the ruling instead: its invalid line is stale, so the run would be lost.
  const kept = await p.check(decideLedger({ ruling: last }));
  assert.equal(kept.status, 1, kept.stdout);
  assert.ok(kept.stderr.includes(': ruling: invalid: tested names 0 of 1 citations of cross B1 in a complete ledger\n'), kept.stderr);
});

test('check decide: ids, positions, winners, rebuttals, and same_model that do not fit exit 1 unwritten, one line each', async (t) => {
  const p = decideProject(t);
  const three = { positions: [position('A', 'agent'), position('B', 'codex'), position('C', 'agent')], same_model: true, same_model_reason: 'A and C run as agents', cases: [stand('A', [ASKED.a, PASSING.adr]), stand('B', [ASKED.b]), stand('C', [ASKED.c])] };
  const threeRuled = { ...three, ruling: decision({ tested: tested({ ...FIRST, C: 1 }, ['B', 'C']) }), rebuttals: [answer('B', 'rebut', [PASSING.fenced]), answer('C', 'concede', [PASSING.adr])] };
  const finalTo = (winner) => decision({ winner, citations: [PASSING.fenced], tested: tested({ B: 1, C: 1 }) });
  for (const [over, line] of [
    [{ positions: [position('B', 'agent'), position('A', 'codex')] }, 'positions are B, A, not 2 to 4 from A to D in order'],
    [{ positions: [position('A', 'agent'), position('C', 'codex')], cases: [stand('A', [ASKED.a])], cross: [], ruling: null, rebuttals: [], status: 'open' }, 'positions are A, C, not 2 to 4 from A to D in order'],
    [{ positions: [position('A', 'agent')], cases: [stand('A', [ASKED.a])], cross: [], ruling: null, rebuttals: [], status: 'open' }, 'positions are A, not 2 to 4 from A to D in order'],
    [{ cases: [...decideLedger().cases, stand('C', [ASKED.c])] }, 'case C is not a position in this ledger'],
    [{ cases: [...decideLedger().cases, stand('A', [ASKED.a])] }, 'position A has more than one case'],
    [{ cross: [point('A6', 'B', [PASSING.code])] }, 'cross id "A6" is not A1 to D5'],
    [{ cross: [point('A1\nchecked: ok', 'B', [PASSING.code])] }, 'cross id "A1\\u000achecked: ok" is not A1 to D5'],
    [{ cross: [point('A1', 'B', [PASSING.code]), point('A1', 'B', [PASSING.adr])] }, 'cross id A1 is used more than once'],
    [{ cross: [point('A2', 'A', [PASSING.code], { by: 'B' })] }, 'cross A2 is by B, not A'],
    [{ cross: [point('C1', 'A', [PASSING.code])] }, 'cross C1 is by C, not a position in this ledger'],
    [{ cross: [point('A1', 'C', [PASSING.code])] }, 'cross A1 is against C, not a position in this ledger'],
    [{ cross: [point('A1', 'A', [PASSING.code])] }, 'cross A1 is against its own position'],
    [{ rebuttals: [answer('C', 'concede', [PASSING.adr])] }, 'rebuttal C is not a position in this ledger'],
    [{ rebuttals: [answer('A', 'concede', [PASSING.adr]), answer('B', 'concede', [PASSING.adr])] }, "rebuttal A is by the first ruling's winner"],
    [{ rebuttals: [answer('B', 'concede', [PASSING.adr]), answer('B', 'concede', [PASSING.adr])] }, 'position B has more than one rebuttal'],
    [{ ruling: decision({ winner: null }) }, 'ruling rules with no winner'],
    [{ ruling: decision({ decision: 'escalate' }), rebuttals: [] }, 'ruling escalates but names the winner A'],
    [{ ruling: decision({ winner: 'C' }) }, 'ruling names the winner C, not a position in this ledger'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: { ...escalated, winner: 'B' } }, 'final ruling escalates but names the winner B'],
    [{ ...threeRuled, final_ruling: finalTo('C') }, "final ruling names the winner C, neither the first ruling's winner nor a position that rebutted"],
    [{ ruling: decision({ decision: 'escalate', winner: null }) }, 'rebuttals and a final ruling follow a first ruling of rule only'],
    [{ ruling: decision({ decision: 'escalate', winner: null }), rebuttals: [], final_ruling: escalated }, 'rebuttals and a final ruling follow a first ruling of rule only'],
    [{ final_ruling: decision({ citations: [PASSING.fenced], tested: tested({ B: 1 }) }) }, 'final ruling rules, but no position rebutted'],
    [{ human_answer: 'keep A' }, 'human_answer: set but nothing escalated'],
    [{ rebuttals: [answer('B', 'rebut', [PASSING.fenced])], final_ruling: finalTo('A'), human_answer: 'keep A' }, 'human_answer: set but nothing escalated'],
    [{ positions: [position('A', 'agent'), position('B', 'agent')] }, 'same_model is false, but two positions share a runner'],
    [{ same_model: true, same_model_reason: 'shared' }, 'same_model is true, but no two positions share a runner'],
    [{ ...threeRuled, final_ruling: finalTo('B'), same_model_reason: null }, 'same_model is true, so same_model_reason must say why two positions share a runner'],
  ]) {
    const value = decideLedger(over);
    const result = await p.check(value);
    assert.equal(result.status, 1, line);
    assert.deepEqual(result.stderr.trim().split('\n').map((each) => each.replace(/^.*?\.json: /u, '')), [line]);
    assert.deepEqual(result.ledger, value, 'not written');
  }
  // Three positions: a final ruling for the first winner or for a position that rebutted passes.
  for (const winner of ['A', 'B']) {
    const result = await p.check(decideLedger({ ...threeRuled, final_ruling: finalTo(winner) }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.lines, ['checked: mode decide, 3 cases, 2 cross points, 0 opinion, 0 problems']);
  }
});

test('quorum codex --mode case, cross, and rebut on a decide ledger: each held to its schema and the ledger, written, one line', async (t) => {
  const run = async (mode, answered, { ledgerValue = decideLedger(), withLedger = mode !== 'case' } = {}) => {
    const fake = fakeCodex({ answer: answered });
    const r = codexRun(t, fake);
    if (ledgerValue) writeFileSync(r.ledgerFile, JSON.stringify(ledgerValue));
    const code = await r.run({}, undefined, ['--mode', mode, ...(withLedger ? ['--ledger', r.ledgerFile] : [])]);
    assert.equal(r.printed.length, 1);
    const line = JSON.parse(r.printed[0]);
    const written = line.status === 'done' ? JSON.parse(readFileSync(r.out, 'utf8')) : (assert.throws(() => readFileSync(r.out), /ENOENT/u, 'nothing written'), null);
    return { code, line, written, fake, out: r.out };
  };
  const theCase = { case: { claim: 'one file is enough', citations: [PASSING.adr] } };
  const done = await run('case', theCase);
  assert.equal(done.code, 0);
  assert.deepEqual(done.line, { status: 'done', reason: `1 case written to ${done.out}` });
  assert.deepEqual(done.written, theCase);
  assert.deepEqual(done.fake.calls[0].schema, CASE_SCHEMA);
  assert.match((await run('case', ANSWER)).line.reason, /^the answer does not follow the schema: \$\.case is missing$/u);

  const points = { cross: [{ against: 'B', claim: 'B cites no reader', citations: [PASSING.code] }, { against: 'A', claim: 'own', citations: [] }] };
  const crossed = await run('cross', points);
  assert.equal(crossed.code, 0, crossed.line.reason);
  assert.deepEqual(crossed.line, { status: 'done', reason: `2 cross points written to ${crossed.out}` });
  assert.deepEqual(crossed.fake.calls[0].schema, CROSS_SCHEMA);
  const unknown = await run('cross', { cross: [{ against: 'C', claim: 'c', citations: [] }, { against: 'D', claim: 'd', citations: [] }] });
  assert.equal(unknown.code, 1);
  assert.equal(unknown.line.reason, 'the answer does not fit the ledger: the answer cross-examines C, D, not a position in the ledger');
  const onPlan = await run('cross', points, { ledgerValue: null });
  assert.equal(onPlan.code, 1);
  assert.equal(onPlan.line.reason, '--mode cross answers a decide ledger, and this ledger is in plan mode');
  assert.equal(onPlan.fake.calls.length, 0, 'Codex never starts');

  const rebutted = { rebuttal: { verdict: 'rebut', claim: 'the record is old', citations: [PASSING.fenced] } };
  const rebut = await run('rebut', rebutted);
  assert.equal(rebut.code, 0, rebut.line.reason);
  assert.deepEqual(rebut.line, { status: 'done', reason: `1 rebuttal written to ${rebut.out}` });
  assert.deepEqual(rebut.fake.calls[0].schema, DECIDE_REBUTTAL_SCHEMA);
  const bare = await run('rebut', { rebuttal: { verdict: 'concede', claim: 'it holds', citations: [] } });
  assert.equal(bare.code, 1);
  assert.equal(bare.line.reason, 'the answer does not fit the ledger: the answer concedes with no citation, which a decide ledger needs');
  assert.equal((await run('rebut', { rebuttal: { verdict: 'concede', claim: 'it holds', citations: [PASSING.adr] } })).code, 0);
  assert.match((await run('rebut', REBUTTALS)).line.reason, /^the answer does not follow the schema: \$\.rebuttal is missing$/u);
});

// config.json in `root`, with the folder version and the `quorum` group given.
const writeQuorum = (root, quorum) => write(root, '.aidrian/config.json', JSON.stringify({ version: 1, quorum }));

// `aidrian quorum roles` as a coordinator runs it, from `cwd`: exit code, stderr, and the one JSON line, parsed.
// `roles` runs it in the test's process; `rolesIn` with `asProcess` runs bin/aidrian.
async function rolesIn({ cwd, asProcess = false }, ...args) {
  const r = await cli(['quorum', 'roles', ...args], { cwd, asProcess });
  assert.equal(r.error, undefined, 'roles finished');
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return { status: r.status, stderr: r.stderr, lines, out: r.status === 0 ? JSON.parse(lines[0]) : null };
}
const roles = (cwd, ...args) => rolesIn({ cwd }, ...args);

test('quorum roles: with no quorum config, each mode prints today\'s roles, judge, and caps as one JSON line', async (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  // A process run, so the command's own entry in bin/aidrian stays tested.
  const plan = await rolesIn({ cwd: dir, asProcess: true }, 'plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(plan.lines.length, 1, 'one line');
  assert.deepEqual(plan.out, {
    mode: 'plan',
    roles: {
      A: { provider: 'agent', agent: 'code-reviewer', fallback: null },
      B: { provider: 'codex', agent: null, fallback: 'product-manager' },
    },
    judge: { agent: 'architect' },
    caps: { maxObjections: 5, maxDispatches: 8 },
  });
  const decide = await roles(dir, 'decide');
  assert.equal(decide.status, 0, decide.stderr);
  assert.equal(decide.lines.length, 1, 'one line');
  assert.deepEqual(decide.out, {
    mode: 'decide',
    roles: {
      odd: { positions: ['A', 'C'], provider: 'agent', agent: 'code-reviewer', fallback: null },
      even: { positions: ['B', 'D'], provider: 'codex', agent: null, fallback: 'code-reviewer' },
    },
    swap: true,
    judge: { agent: 'architect' },
    caps: { 2: 9, 3: 12, 4: 16 },
  });
});

// The mode files name today's values as the defaults: each is what `roles` prints with no quorum config, so the text
// and DEFAULTS.quorum cannot drift apart.
test('quorum roles: the defaults the mode files name are the values roles prints with no quorum config', async (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  const texts = skillTexts();
  const flat = (file) => texts[file].replace(/\s+/gu, ' ');
  const plan = (await roles(dir, 'plan')).out;
  const planText = flat('modes/plan.md');
  assert.equal(plan.roles.A.provider, 'agent');
  assert.equal(plan.roles.B.provider, 'codex');
  for (const sentence of [
    `- **A, "it will break"**: \`${plan.roles.A.agent}\`. A always runs as a host agent.`,
    `Codex, through \`aidrian quorum codex\`; its agent fallback is \`${plan.roles.B.fallback}\`.`,
    `- **Architect**: \`${plan.judge.agent}\`.`,
    `at most \`maxObjections\` objections (default ${plan.caps.maxObjections})`,
    `${plan.caps.maxDispatches} by default`,
  ]) assert.ok(planText.includes(sentence), `plan.md: ${sentence}`);
  const decide = (await roles(dir, 'decide')).out;
  const decideText = flat('modes/decide.md');
  assert.equal(decide.roles.odd.provider, 'agent');
  assert.equal(decide.roles.even.provider, 'codex');
  assert.equal(decide.swap, true);
  const words = { 2: 'two', 3: 'three', 4: 'four' };
  for (const sentence of [
    `\`A\` and \`C\` run as \`${decide.roles.odd.agent}\`.`,
    `\`B\` and \`D\` run on Codex through \`aidrian quorum codex\`; their fallback agent is \`${decide.roles.even.fallback}\`.`,
    `- **Judge**: \`${decide.judge.agent}\`.`,
    `the judge (its agent, \`${decide.judge.agent}\` by default, on the host's model)`,
    // The swap gives A even's role and B odd's: with the defaults, A on Codex with even's fallback, B as odd's agent.
    `\`A\` takes \`even\`'s provider, agent, and fallback, and \`B\` takes \`odd\`'s; by default, \`A\` runs on Codex, with \`${decide.roles.even.fallback}\` as its fallback, and \`B\` runs as \`${decide.roles.odd.agent}\`.`,
    `With the default runners that is ${decide.caps[2]} for ${words[2]}, ${decide.caps[3]} for ${words[3]}, and ${decide.caps[4]} for ${words[4]}.`,
  ]) assert.ok(decideText.includes(sentence), `decide.md: ${sentence}`);
});

test('quorum roles: a config sets the roles, judge, swap, and caps it prints; A stays a host agent; a bad mode exits 1', async (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  writeQuorum(dir, {
    judge: { agent: 'staff-architect' },
    plan: { a: { agent: 'security-reviewer' }, b: { provider: 'agent' }, maxObjections: 3, maxDispatches: 6 },
    decide: { odd: { provider: 'codex' }, even: { provider: 'agent', agent: 'product-manager' }, swap: false },
  });
  // A folder below the project reads the project's config, as every aidrian command does.
  mkdirSync(path.join(dir, 'src'));
  const plan = await roles(path.join(dir, 'src'), 'plan');
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(plan.out, {
    mode: 'plan',
    roles: {
      A: { provider: 'agent', agent: 'security-reviewer', fallback: null },
      B: { provider: 'agent', agent: 'product-manager', fallback: null },
    },
    judge: { agent: 'staff-architect' },
    caps: { maxObjections: 3, maxDispatches: 6 },
  });
  const decide = await roles(dir, 'decide');
  assert.equal(decide.status, 0, decide.stderr);
  // Odd on Codex puts A and C there: three positions hold two Codex runners, so 3 * 3 + 2 + 2 = 13.
  assert.deepEqual(decide.out, {
    mode: 'decide',
    roles: {
      odd: { positions: ['A', 'C'], provider: 'codex', agent: null, fallback: 'code-reviewer' },
      even: { positions: ['B', 'D'], provider: 'agent', agent: 'product-manager', fallback: null },
    },
    swap: false,
    judge: { agent: 'staff-architect' },
    caps: { 2: 9, 3: 13, 4: 16 },
  });
  writeQuorum(dir, { decide: { odd: { provider: 'agent' }, even: { provider: 'agent' } } });
  assert.deepEqual((await roles(dir, 'decide')).out.caps, { 2: 8, 3: 11, 4: 14 }, 'no Codex runner, no fallback');
  for (const args of [['debate'], [], ['plan', 'decide'], ['PLAN']]) {
    const bad = await roles(dir, ...args);
    assert.equal(bad.status, 1, args.join(' '));
    assert.deepEqual(bad.lines, [], 'no JSON line');
    assert.match(bad.stderr, /^aidrian quorum: roles takes one mode, plan, decide, or product/u);
  }
});

test('quorum roles: an invalid quorum config exits 1 naming each key, and prints no roles', async (t) => {
  const dir = temp(t, 'aidrian-quorum-roles-');
  for (const [quorum, key] of [
    [{ plan: { b: { provider: 'Codex' } } }, /"quorum\.plan\.b\.provider" must be "agent" or "codex"/u],
    [{ plan: { maxDispatches: 4 } }, /"quorum\.plan\.maxDispatches" must be a whole number, 5 or more/u],
    [{ plan: { a: { provider: 'codex' } } }, /unknown key "quorum\.plan\.a\.provider"/u],
  ]) {
    writeQuorum(dir, quorum);
    for (const mode of ['plan', 'decide']) {
      const result = await roles(dir, mode);
      assert.equal(result.status, 1, `${mode}: ${JSON.stringify(quorum)}`);
      assert.match(result.stderr, key);
      assert.deepEqual(result.lines, [], 'no defaults printed');
    }
  }
});

test('check: a plan ledger with runners holds same_model to whether A and B share a runner; one without keeps the old rule', async (t) => {
  const p = project(t);
  const base = (extra) => ({ ...ledger([objection('A1', [PASSING.code])]), ...extra });
  // B fell back to an agent: both ran as agents, so the models match and the reason says why.
  const fellBack = base({ runners: { A: 'agent', B: 'agent' }, same_model: true, same_model_reason: 'failed: codex exited 1' });
  for (const passes of [fellBack, base({ runners: { A: 'agent', B: 'codex' }, same_model: false, same_model_reason: null })]) {
    const result = await p.check(passes);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.ledger.runners, passes.runners, 'runners kept');
  }
  for (const [before, message] of [
    [{ ...fellBack, same_model: false, same_model_reason: null }, /: same_model is false, but the runners match: A agent, B agent$/mu],
    [base({ runners: { A: 'agent', B: 'codex' }, same_model: true, same_model_reason: 'Codex host' }), /: same_model is true, but the runners differ: A agent, B codex$/mu],
    [{ ...fellBack, same_model_reason: ' ' }, /: same_model is true, so same_model_reason must say why A and B share a runner$/mu],
    [{ ...fellBack, runners: { A: 'agent', B: 'claude' } }, /: \$\.runners\.B must be one of agent, codex$/mu],
    // Plan adversary A has no Codex path, so a ledger never records it there.
    [{ ...fellBack, runners: { A: 'codex', B: 'codex' } }, /: \$\.runners\.A must be one of agent$/mu],
    [{ ...fellBack, runners: { A: 'agent' } }, /: \$\.runners\.B is missing$/mu],
  ]) {
    const result = await p.check(before);
    assert.equal(result.status, 1, message.source);
    assert.match(result.stderr, message);
    assert.deepEqual(result.ledger, before, 'not written back');
  }
  // Without runners, same_model true needs only a reason, as before runners existed: the ledger cannot show the runs.
  const old = await p.check(base({ same_model: true, same_model_reason: 'unavailable: the codex CLI is not installed' }));
  assert.equal(old.status, 0, old.stderr);
  assert.equal(Object.hasOwn(old.ledger, 'runners'), false, 'check adds no runners');
});

test('check with mode: an open ledger\'s cap per adversary is config.json quorum.plan.maxObjections; a complete one, or one with no mode, never reads it', async (t) => {
  const p = project(t);
  writeQuorum(p.root, { plan: { maxObjections: 3 } });
  const four = planLedger([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code])));
  const refused = await p.check(four);
  assert.equal(refused.status, 1, refused.stdout);
  assert.match(refused.stderr, /: A raised 4 objections, more than the 3 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu);
  assert.deepEqual(refused.ledger, four, 'not written back');
  const three = planLedger([1, 2, 3].flatMap((n) => [objection(`A${n}`, [PASSING.code]), objection(`B${n}`, [PASSING.code], { by: 'B' })]));
  const result = await p.check(three);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.lines, ['checked: mode plan, 6 objections, 0 opinion, 0 problems']);
  // A ledger with no mode keeps its old cap of 7, whatever the config says, and so does a broken config.
  const old = legacy([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code], { status: 'accepted', ruling: { decision: 'accept', change_or_reason: 'r', citations: [PASSING.code] } })));
  for (const quorum of [{ plan: { maxObjections: 3 } }, { plan: { maxObjections: 9 } }]) {
    writeQuorum(p.root, quorum);
    const kept = await p.check(old);
    assert.equal(kept.status, 0, kept.stderr);
    assert.deepEqual(kept.lines, ['checked: mode plan, 4 objections, 0 opinion, 0 problems']);
  }
  // With mode, open, a broken config stops the check, naming the key, before it writes anything.
  const broken = await p.check(three);
  assert.equal(broken.status, 1, broken.stdout);
  assert.match(broken.stderr, /"quorum\.plan\.maxObjections" must be a whole number from 1 to 5/u);
  assert.deepEqual(broken.ledger, three, 'not written back');
  // A complete ledger keeps the ceiling of 5: a cap lowered after the run finished never voids it or the Human's answers.
  const finished = planLedger([1, 2, 3, 4].map((n) => objection(`A${n}`, [PASSING.code], { status: 'rejected', ruling: rejects(), rebuttal: concede([PASSING.plan]) })), { status: 'complete' });
  for (const quorum of [{ plan: { maxObjections: 3 } }, { plan: { maxObjections: 9 } }]) {
    writeQuorum(p.root, quorum);
    const done = await p.check(finished);
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(done.lines, ['checked: mode plan, 4 objections, 0 opinion, 0 problems']);
  }
  writeQuorum(p.root, { plan: { maxObjections: 3 } });
  const reopened = await p.check({ ...finished, status: 'open' });
  assert.equal(reopened.status, 1, 'the same ledger open is held to the configured cap');
  assert.match(reopened.stderr, /: A raised 4 objections, more than the 3 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu);
  const six = planLedger(Array.from({ length: 6 }, (_, i) => objection(`A${i + 1}`, [PASSING.code], { status: 'rejected', ruling: rejects(), rebuttal: concede([PASSING.plan]) })), { status: 'complete' });
  assert.match((await p.check(six)).stderr, /: A raised 6 objections, more than the 5 quorum\.plan\.maxObjections allows in a ledger with a mode$/mu, 'complete: the ceiling holds');
});

test('check on a decide ledger never reads config.json: a broken quorum config leaves it passing', async (t) => {
  const p = decideProject(t);
  writeQuorum(p.root, { plan: { maxObjections: 9 } });
  for (const value of [opened(), decideLedger()]) {
    const result = await p.check(value);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.lines.at(-1), /^checked: mode decide, /u);
  }
});

test('quorum docs name the readers of the quorum config: check for maxObjections, roles for the rest', () => {
  const ledgerText = skillTexts()['references/ledger.md'].replace(/\s+/gu, ' ');
  assert.match(ledgerText, /- `objections\[\]\.id`:[^-]*`quorum\.plan\.maxObjections`/u, 'ledger.md: the id bullet names the configured cap');
  const config = readFileSync(path.resolve(import.meta.dirname, '../docs/config.md'), 'utf8').split('\n## Quorum\n')[1].split('\n## ')[0].replace(/\s+/gu, ' ');
  assert.match(config, /`aidrian quorum check` reads `quorum\.plan\.maxObjections`/u);
  assert.match(config, /`aidrian quorum roles plan` and `aidrian quorum roles decide` read the whole group/u);
  assert.match(ledgerText, /- `runners\.A`: always `agent`/u, 'ledger.md: A has no Codex path');
});

test('the objection cap is never hard-coded where the coordinator keeps objections', () => {
  for (const file of ['modes/plan.md', 'references/ledger.md']) {
    const text = readFileSync(path.join(SKILL, file), 'utf8').replace(/\s+/gu, ' ');
    assert.doesNotMatch(text, /first \d+ objections/u, `${file} keeps a fixed number of objections`);
  }
  const ledger = readFileSync(path.join(SKILL, 'references/ledger.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.match(ledger, /the first `maxObjections` objections, as `aidrian quorum roles plan` prints it/u);
});

// Product mode: a recommendation the Human settles, with no rebuttal round and a persona no ruling may rest on alone.
const PERSONA_REF = 'docs/waiter.md#Who';

test('product ledger: a complete rule passes with no rebuttal, and unanswered it stays deferred', async (t) => {
  const d = decideProject(t);
  const result = await d.check(productLedger());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checked: mode product, 2 cases, 0 cross points/u);
});

test('product ledger: the shape rules stop the check', async (t) => {
  const d = decideProject(t);
  for (const [over, message] of [
    [{ outcome: null }, /outcome is null under a rule/u],
    [{ cross: [{ id: 'A1', by: 'U', against: 'A', claim: 'c', citations: [], status: 'pending' }] }, /not U1 to U5 or E1 to E5/u],
    [{ ruling: null, outcome: null }, /ruling is null/u],
    [{ draft: { winner: 'C', reason: 'r', walkthrough: 'w' } }, /draft names C/u],
    [{ loops: [{ back_to: 'interview', reason: 'r' }] }, /no end user took part/u],
    [{ positions: ['A', 'B', 'C', 'D'].map((id) => position(id, 'agent')), same_model: true, same_model_reason: 'all agents' }, /at most 3 positions/u],
  ]) {
    const result = await d.check(productLedger(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
});

test('product ledger: a Human answer is allowed on a rule, which a decide ledger refuses', async (t) => {
  const d = decideProject(t);
  assert.equal((await d.check(productLedger({ human_answer: 'approved' }))).status, 0);
  assert.equal((await d.check(decideLedger({ human_answer: 'approved' }))).status, 1);
});

test('product ledger: a winner resting only on the persona doc does not stand, and a premise needs a passing citation', async (t) => {
  const d = decideProject(t);
  const persona = { persona: PASSING.adr.ref.split('#')[0], interview: [], walkthrough: null };
  const rests = await d.check(productLedger({ witness: persona }));
  assert.equal(rests.status, 1, 'the only supporting citation is the persona doc');
  assert.match(rests.stderr, /rests only on the persona doc/u);
  const other = await d.check(productLedger({ witness: { persona: PERSONA_REF.split('#')[0], interview: [{ question: 'q', answer: 'a' }], walkthrough: 'w' } }));
  assert.equal(other.status, 0, other.stderr);
  const premise = await d.check(productLedger({ premise: { summary: 'open', citations: [cite('doc', 'docs/missing.md#x', 'nope')] } }));
  assert.equal(premise.status, 1);
  assert.match(premise.stderr, /premise: invalid/u);
});

test('quorum roles product: the end user, the grillers, and a fixed cap', async (t) => {
  const { out } = await roles(temp(t, 'aidrian-quorum-roles-'), 'product');
  assert.equal(out.judge.agent, 'product-manager');
  assert.equal(out.roles.witness.agent, 'ux-researcher');
  assert.equal(out.roles.engineer.agent, 'architect');
  assert.deepEqual(out.caps, { maxLoops: 2, maxDispatches: 22 });
});

const xPoint = (id, citations, status = 'pending') => ({ id, by: id[0], against: 'B', claim: `point ${id}`, citations, status });

test('product ledger: pending examiner points are relabeled on disk, and a ruling must test a backed one', async (t) => {
  const d = decideProject(t);
  const open = { status: 'open', ruling: null, outcome: null, cross: [xPoint('U1', [PASSING.code]), xPoint('E2', [cite('doc', 'docs/missing.md#x', 'nope')])] };
  const result = await d.check(productLedger(open));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.ledger.cross.map(({ status }) => status), ['backed', 'opinion']);
  assert.ok(!Object.hasOwn(result.ledger, 'rebuttals'), 'the decide view stays out of the file');
  const missed = await d.check(productLedger({ status: 'open', cross: [xPoint('U1', [PASSING.code], 'backed')] }));
  assert.match(missed.stdout, /ruling: invalid: .*U1/u);
});

test('product ledger: a coordinator-written escalate passes, answered or deferred, and an outcome on it does not', async (t) => {
  const d = decideProject(t);
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'invalid twice', citations: [PASSING.adr], tested: [], inferences: [] };
  assert.equal((await d.check(productLedger({ ruling: escalate, outcome: null }))).status, 0);
  assert.equal((await d.check(productLedger({ ruling: escalate, outcome: null, human_answer: 'A' }))).status, 0);
  assert.match((await d.check(productLedger({ ruling: escalate }))).stderr, /outcome: set but no ruling rules/u);
});

test('product ledger: an open rule with no outcome goes back, and repeats stop the check', async (t) => {
  const d = decideProject(t);
  const open = await d.check(productLedger({ status: 'open', outcome: null }));
  assert.match(open.stdout, /ruling: invalid: a rule has no outcome/u);
  const repeated = await d.check(productLedger({ status: 'open', cross: [xPoint('U1', [PASSING.code]), xPoint('U1', [PASSING.code])] }));
  assert.match(repeated.stderr, /U1 is used more than once/u);
  assert.match((await d.check(productLedger({ witness: { persona: '/abs/waiter.md', interview: [], walkthrough: null } }))).stderr, /not a path inside the repository/u);
  assert.match((await d.check(productLedger({ ruling: null, outcome: null, status: 'open', human_answer: 'A' }))).stderr, /nothing was ruled/u);
});

test('product ledger: the persona guard holds for a code citation, and an answer survives a lost citation', async (t) => {
  const d = decideProject(t);
  const persona = PASSING.code.ref.split(':')[0];
  const cases = [stand('A', [PASSING.code]), stand('B', [PASSING.adr])];
  const rests = await d.check(productLedger({ cases, witness: { persona, interview: [], walkthrough: null } }));
  assert.match(rests.stderr, /rests only on the persona doc/u);
  const lost = [stand('A', [cite('doc', 'docs/missing.md#x', 'nope')]), stand('B', [PASSING.code])];
  assert.equal((await d.check(productLedger({ cases: lost }))).status, 1, 'unanswered, it is stale');
  assert.equal((await d.check(productLedger({ cases: lost, human_answer: 'approved' }))).status, 0, 'answered, it stands');
});

test('quorum premise: only an open: false answer with passing citations ends a run', async (t) => {
  const p = project(t);
  const runPremise = async (answer, asProcess = false) => {
    const file = path.join(p.state, 'premise.json');
    writeFileSync(file, JSON.stringify(answer));
    return cli(['quorum', 'premise', file], { cwd: p.root, asProcess });
  };
  const premise = (citations) => ({ summary: 's', citations });
  // A process run, so the command's own entry in bin/aidrian stays tested.
  assert.equal((await runPremise({ open: false, premise: premise([PASSING.adr]) }, true)).status, 0);
  const open = await runPremise({ open: true, premise: premise([PASSING.adr]) });
  assert.equal(open.status, 1);
  assert.match(open.stdout, /only an answer with open: false/u);
  assert.equal((await runPremise({ open: false, premise: premise([cite('doc', 'docs/missing.md#x', 'nope')]) })).status, 1);
  const shapeless = await runPremise({ open: false });
  assert.equal(shapeless.status, 1);
  assert.match(shapeless.stdout, /premise/u);
});

test('product ledger: the guard covers every persona doc with no witness, and a premise never cites the question file', async (t) => {
  const d = decideProject(t);
  const persona = PASSING.adr.ref.split('#')[0];
  assert.match((await d.check(productLedger({ persona_docs: [persona] }))).stderr, /rests only on the persona doc/u);
  assert.match((await d.check(productLedger({ premise: { summary: 's', citations: [cite('plan', '#context', 'x')] } }))).stderr, /cites the question file/u);
});

test('product ledger: an open run may loop up to the cap, and a complete one keeps the ceiling', async (t) => {
  const d = decideProject(t);
  const loops = (n) => Array.from({ length: n }, () => ({ back_to: 'grill', reason: 'r' }));
  assert.equal((await d.check(productLedger({ status: 'open', loops: loops(2) }))).status, 0);
  assert.match((await d.check(productLedger({ status: 'open', loops: loops(3) }))).stderr, /loops: 3, more than the 2 allowed/u);
  assert.equal((await d.check(productLedger({ loops: loops(3) }))).status, 0);
});

test('product ledger: a deferred question on dead evidence goes stale, under an escalation too', async (t) => {
  const d = decideProject(t);
  const dead = cite('doc', 'docs/missing.md#x', 'nope');
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences: [] };
  const cases = [stand('A', [dead]), stand('B', [PASSING.code])];
  assert.equal((await d.check(productLedger({ ruling: escalate, outcome: null, cases }))).status, 1);
  assert.equal((await d.check(productLedger({ ruling: escalate, outcome: null, cases, human_answer: 'A' }))).status, 0);
});

test('product ledger: an unanswered escalation with an invalid ruling is not reused, and an answered one stands', async (t) => {
  const d = decideProject(t);
  const escalate = { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences: [] };
  const noCitation = { ...escalate, citations: [] };
  assert.match((await d.check(productLedger({ ruling: noCitation, outcome: null }))).stderr, /the ruling has no passing citation/u);
  const partial = { ...escalate, tested: tested({ A: 1 }) };
  assert.match((await d.check(productLedger({ ruling: partial, outcome: null }))).stderr, /ruling: invalid: tested names/u);
  assert.equal((await d.check(productLedger({ ruling: escalate, outcome: null }))).status, 0, 'a coordinator-written escalate has no verdicts');
  assert.equal((await d.check(productLedger({ ruling: partial, outcome: null, human_answer: 'A' }))).status, 0);
});

test('product ledger: a no-verdict escalation keeps only its coverage exemption', async (t) => {
  const d = decideProject(t);
  const inferences = [{ statement: 's', holds: true, reason: 'r', citations: [] }];
  const result = await d.check(productLedger({ ruling: { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences }, outcome: null }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /holds on no passing citation/u);
});

test('product ledger: an inference quoting the exempt words does not slip past the coverage exemption', async (t) => {
  const d = decideProject(t);
  for (const statement of ['tested names are reliable', 'inference untested is harmless']) {
    const inferences = [{ statement, holds: true, reason: 'r', citations: [] }];
    const result = await d.check(productLedger({ ruling: { decision: 'escalate', winner: null, change_or_reason: 'r', citations: [PASSING.adr], tested: [], inferences }, outcome: null }));
    assert.equal(result.status, 1, statement);
  }
});

test('product ledger: a malformed citation beside a passing one does not void a complete ruling', async (t) => {
  const d = decideProject(t);
  const bad = cite('doc', 'docs/waiter.md', 'no anchor');
  const cross = [{ id: 'U1', by: 'U', against: 'B', claim: 'point', citations: [PASSING.code, bad], status: 'backed' }];
  const ruling = decision({ tested: [...tested({ A: 1, B: 1 }, ['B']), { of: 'U1', citation: 0, supports: true, reason: 'r' }, { of: 'U1', citation: 1, supports: false, reason: 'r' }] });
  const result = await d.check(productLedger({ cross, ruling }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cross U1\.citations\[1\]/u, 'the bad citation is still named');
  const dead = await d.check(productLedger({ cross: [{ ...cross[0], citations: [bad] }], ruling: decision({ tested: [...tested({ A: 1, B: 1 }, ['B']), { of: 'U1', citation: 0, supports: false, reason: 'r' }] }) }));
  assert.equal(dead.status, 1, 'a point left with no passing citation still goes stale');
});
