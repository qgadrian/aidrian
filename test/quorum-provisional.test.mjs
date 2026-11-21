import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commands, inferenceProblems, routeAfterRuling, routeFor } from '../plugins/aidrian/lib/quorum.mjs';
import { isDecisionId, parseDecisions } from '../plugins/aidrian/lib/decisions.mjs';
import { cli, temp, write, cite, PASSING, stand, tested, decision, decideLedger, decideProject, productLedger, OPEN_DECISIONS, routeRepo, productConfig, pickRoute, flip, ruled, ROUTE_DECIDE, routeLedger, ledgerRoute } from './quorum-fixture.mjs';

// A whole product ledger that `quorum check` reads, with every optional field a product ruling may leave behind.
const MARKED = { provisional: { marker: 'keep-one-ledger' } };
const carrying = (over = {}) => {
  const { ruling, outcome } = productLedger();
  return productLedger({
    trigger: ROUTE_DECIDE,
    ruling: { ...ruling, class: 'copy', reversible: 'no,no,no,no', docs: ['docs/rules.md'], domain: 'product', severity: 'low', reverts_by: 'revert the commit' },
    outcome: { ...outcome, flips_if: [{ fact: 'real users want it', how_to_settle: 'ask them', settles_from_repo: false, could_harden_undo: false }] },
    ...MARKED,
    ...over,
  });
};

test('product ledger: with none of the optional fields it passes, carrying all of them it passes, and check keeps them on disk', async (t) => {
  const d = decideProject(t);
  const plain = productLedger();
  for (const field of ['class', 'reversible', 'docs', 'domain', 'severity', 'reverts_by']) assert.ok(!Object.hasOwn(plain.ruling, field), field);
  assert.deepEqual(Object.keys(plain.outcome.flips_if[0]), ['fact', 'how_to_settle']);
  assert.ok(!Object.hasOwn(plain, 'provisional'));
  assert.equal((await d.check(plain)).status, 0);
  const full = carrying();
  // A process run, so the command's own entry in bin/aidrian stays tested.
  const result = await d.check(full, d.question, { asProcess: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual([result.ledger.ruling.domain, result.ledger.ruling.docs, result.ledger.ruling.reverts_by], ['product', ['docs/rules.md'], 'revert the commit']);
  assert.deepEqual(result.ledger.outcome.flips_if, full.outcome.flips_if);
  assert.deepEqual(result.ledger.provisional, MARKED.provisional);
  assert.equal((await d.check(carrying({ ruling: { ...full.ruling, reversible: ['no', 'no', 'no', 'no'] } }))).status, 0, 'reversible as a list, as route reads it');
});

test('product ledger: a new field off its shape stops the check, and a decide ledger admits none of them', async (t) => {
  const d = decideProject(t);
  const full = carrying();
  const inRuling = (over) => ({ ruling: { ...full.ruling, ...over } });
  const inFlip = (over) => ({ outcome: { ...full.outcome, flips_if: [{ ...full.outcome.flips_if[0], ...over }] } });
  for (const [over, message] of [
    [inRuling({ class: 3 }), /\$\.ruling\.class must be string/u],
    [inRuling({ reversible: 3 }), /\$\.ruling\.reversible must be string or array/u],
    [inRuling({ reversible: [1] }), /\$\.ruling\.reversible\[0\] must be string/u],
    [inRuling({ docs: 'docs/rules.md' }), /\$\.ruling\.docs must be array/u],
    [inRuling({ docs: [1] }), /\$\.ruling\.docs\[0\] must be string/u],
    [inRuling({ domain: null }), /\$\.ruling\.domain must be string/u],
    [inRuling({ severity: 1 }), /\$\.ruling\.severity must be string/u],
    [inRuling({ reverts_by: 1 }), /\$\.ruling\.reverts_by must be string/u],
    [inRuling({ unknown: 'x' }), /\$\.ruling\.unknown is not a known field/u],
    [inFlip({ settles_from_repo: 'false' }), /settles_from_repo must be boolean/u],
    [inFlip({ could_harden_undo: null }), /could_harden_undo must be boolean/u],
    [{ provisional: 'keep-one-ledger' }, /\$\.provisional must be object/u],
    [{ provisional: null }, /\$\.provisional must be object/u],
    [{ provisional: {} }, /\$\.provisional\.marker is missing/u],
    [{ provisional: { marker: 1 } }, /\$\.provisional\.marker must be string/u],
    [{ provisional: { marker: 'a', why: 'b' } }, /\$\.provisional\.why is not a known field/u],
    [{ second_look: 'approved' }, /\$\.second_look must be object/u],
    [{ second_look: { agent: 'critic', sign_off: 'approved' } }, /\$\.second_look\.reason is missing/u],
    [{ second_look: { agent: 'critic', sign_off: 1, reason: 'r' } }, /\$\.second_look\.sign_off must be string/u],
    [{ second_look: { agent: 'critic', sign_off: 'approved', reason: 'r', by: 'x' } }, /\$\.second_look\.by is not a known field/u],
  ]) {
    const result = await d.check(carrying(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
  assert.match((await d.check(decideLedger({ ruling: decision({ domain: 'product' }) }))).stderr, /\$\.ruling\.domain is not a known field/u);
  assert.match((await d.check(decideLedger(MARKED))).stderr, /\$\.provisional is not a known field/u);
});

test('product ledger: a provisional ledger stays valid after a cited file changes, and an unmarked one does not', async (t) => {
  const d = markedProject(t);
  assert.equal((await d.check(productLedger())).status, 0);
  assert.equal((await d.check(carrying())).status, 0);
  // The one file behind the winner's case, the ruling, and the premise, so each stale rule has a line to name.
  write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  const unmarked = await d.check(productLedger());
  assert.equal(unmarked.status, 1, 'with no provisional and no answer, it is stale');
  for (const line of [/case A: the governing winner's case has no passing citation/u, /ruling: invalid: the ruling has no passing citation/u, /premise: invalid: no citation passes/u]) assert.match(unmarked.stderr, line);
  const marked = await d.check(carrying());
  assert.equal(marked.status, 0, marked.stderr);
  assert.match(marked.stdout, /premise: invalid: no citation passes/u, 'what stopped passing is still named');
  assert.equal((await d.check(carrying({ human_answer: 'approved' }))).status, 0, 'and with the Human\'s answer too');
});

test('product ledger: the stale exemption stays for an unconfirmed or confirmed marker, and ends when it is rejected or not on record', async (t) => {
  const { marker } = MARKED.provisional;
  const dead = /premise: invalid: no citation passes in a complete ledger/u;
  const changeCitation = (d) => write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  for (const [name, verb, holds, reason] of [
    ['unconfirmed', null, true, null],
    ['confirmed', 'confirmed', true, /the Human settled its marker/u],
    ['changed', 'changed', true, /the Human settled its marker/u],
    ['rejected', 'rejected', false, /was rejected/u],
    ['undone', 'undo', false, /is not on record/u],
  ]) {
    const d = markedProject(t);
    assert.equal((await d.check(carrying())).status, 0, `${name}: before the change`);
    changeCitation(d);
    assert.equal((await d.check(carrying())).status, 0, `${name}: the code changed, with the marker unconfirmed`);
    if (verb) {
      const moved = verb === 'undo' ? await d.decisions('undo', marker) : await d.decisions('set', marker, verb);
      assert.equal(moved.status, 0, moved.stderr);
    }
    const after = await d.check(carrying());
    assert.equal(after.status, holds ? 0 : 1, `${name}: ${after.stderr}`);
    if (!holds) assert.match(after.stderr, dead, name);
    assert.match(readFileSync(d.file, 'utf8'), /"provisional"/u, 'a refused ledger stays on disk as it was');
    if (reason) {
      const routed = await d.route();
      assert.deepEqual(pickRoute(routed), ['human', true], name);
      assert.match(routed.reason, reason, name);
    }
    assert.equal((await d.check(carrying({ human_answer: 'approved' }))).status, 0, `${name}: the Human's answer lifts it all`);
  }

  // The window the continue path uses: the writer has run, and its marker does not exist yet.
  const d = markedProject(t);
  const written = await provisionalOn(d, bare(), '--plan', d.question, '--marker', 'not-written-yet');
  assert.equal(written.status, 0, written.stderr);
  assert.equal((await d.check(written.ledger)).status, 0, 'with its citations holding, a ledger with no marker yet still passes');
  // A process run, so the command's own entry in bin/aidrian stays tested.
  assert.deepEqual(pickRoute(await d.route('product', { asProcess: true })), ['human', true], 'and the route waits');
  changeCitation(d);
  const early = await d.check(written.ledger);
  assert.equal(early.status, 1, 'a citation changed before the marker is on record');
  assert.match(early.stderr, dead);
});

test('product ledger: under provisional alone, a ruling no code change could break still stops the check, and an answer lifts even that', async (t) => {
  const d = decideProject(t);
  const { ruling } = carrying();
  for (const [name, over, message] of [
    ['no verdicts at all', { ruling: { ...ruling, tested: [] } }, /ruling: invalid: .*of case A/u],
    ['a verdict on nothing it rules on', { ruling: { ...ruling, tested: [...ruling.tested, { of: 'Z9', citation: 0, supports: true, reason: 'r' }] } }, /ruling: invalid: tested names Z9/u],
    ['an inference it never ruled on', { cases: [stand('A', [PASSING.adr], 'the case\ninference: users want it'), stand('B', [PASSING.code])] }, /ruling: invalid: .*users want it/u],
    ['no verdict supports the winner', { ruling: { ...ruling, tested: tested({ A: 1, B: 1 }, ['A', 'B']) } }, /ruling: invalid: no verdict on the winner's case supports it/u],
  ]) {
    const first = await d.check(carrying(over));
    assert.equal(first.status, 1, `${name}: ${first.stdout}`);
    assert.match(first.stderr, message, name);
    const answered = await d.check(carrying({ ...over, human_answer: 'approved' }));
    assert.equal(answered.status, 0, `${name}, answered: ${answered.stderr}`);
  }
});

test('product ledger: provisional holds only on a ledger route could continue on, and beside a Human answer the answer governs', async (t) => {
  const d = decideProject(t);
  const full = carrying();
  const withoutField = (key) => {
    const ruling = { ...full.ruling };
    delete ruling[key];
    return { ruling };
  };
  const escalate = { ...full.ruling, decision: 'escalate', winner: null, tested: [] };
  const flips = (entry) => ({ outcome: { ...full.outcome, flips_if: [{ ...full.outcome.flips_if[0], ...entry }] } });
  const unmarked = { ...full.outcome.flips_if[0] };
  delete unmarked.could_harden_undo;
  for (const [over, message] of [
    [{ ruling: escalate, outcome: null }, /provisional: the ruling escalates/u],
    [{ ruling: escalate, outcome: null, human_answer: 'A' }, /provisional: the ruling escalates/u],
    [{ status: 'open', ruling: null, outcome: null }, /provisional: the ledger is not complete/u],
    [{ status: 'open' }, /provisional: the ledger is not complete/u],
    [withoutField('class'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('reversible'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('docs'), /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [{ ruling: { ...full.ruling, reversible: 'no,maybe' } }, /provisional: the ledger lacks the Ruling's class, reversible, or docs/u],
    [withoutField('domain'), /provisional: the ruling names no domain/u],
    [{ ruling: { ...full.ruling, domain: ' ' } }, /provisional: the ruling names no domain/u],
    [withoutField('severity'), /provisional: the ledger lacks the Ruling's severity or reverts_by/u],
    [withoutField('reverts_by'), /provisional: the ledger lacks the Ruling's severity or reverts_by/u],
    [{ outcome: { ...full.outcome, flips_if: [unmarked] } }, /provisional: a flips_if entry lacks settles_from_repo or could_harden_undo/u],
    [flips({ could_harden_undo: true }), /provisional: a flipping fact could make the decision harder to undo/u],
  ]) {
    const result = await d.check(carrying(over));
    assert.equal(result.status, 1, JSON.stringify(over));
    assert.match(result.stderr, message);
  }
  assert.equal((await d.check(carrying(flips({ settles_from_repo: true })))).status, 0, 'a fact the repository can settle may still go on');
  const both = await d.check(carrying({ human_answer: 'No: take option B' }));
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual([both.ledger.human_answer, both.ledger.provisional], ['No: take option B', MARKED.provisional], 'both stay on record');
  const settings = { autoStart: true, approval: 'review-later', maxAutoRuns: 3 };
  const { route, wait, reason } = routeAfterRuling(settings, both.ledger, { authority: 'decide', rule: 'mode', reason: 'r' }, 'product', 'unconfirmed');
  assert.deepEqual([route, wait], ['human', true]);
  assert.match(reason, /the Human's answer governs/u);
});

test('product ledger: provisional.marker holds an id a decision marker could hold, by the one predicate the marker parser uses', async (t) => {
  const d = decideProject(t);
  const refused = ['', '  ', ' padded ', 'Not A Slug!', 'UPPER', '-lead', 'a\nb', 'a.b', 'x'.repeat(33)];
  for (const marker of refused) {
    assert.equal(isDecisionId(marker), false, JSON.stringify(marker));
    const result = await d.check(carrying({ provisional: { marker } }));
    assert.equal(result.status, 1, JSON.stringify(marker));
    assert.match(result.stderr, /provisional: marker .* is no decision marker's id/u);
  }
  for (const marker of ['a', 'a-1', '1a', 'x'.repeat(32)]) {
    assert.equal(isDecisionId(marker), true, marker);
    assert.equal((await d.check(carrying({ provisional: { marker } }))).status, 0, marker);
  }
  const parsed = (id) => parseDecisions(`Rule.\n<!-- aidrian:decision id=${id} status=unconfirmed class=copy domain=product date=2026-11-01 pr=none -->\n`).decisions.length === 1;
  for (const id of ['UPPER', '-lead', 'a.b', 'x'.repeat(33), 'a', 'a-1', 'x'.repeat(32)]) assert.equal(parsed(id), isDecisionId(id), id);
});

// `aidrian quorum provisional` on `ledger`, written first, with what it left in the file.
async function provisionalOn(d, ledger, ...flags) {
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  const text = JSON.stringify(ledger);
  writeFileSync(file, text);
  const r = await cli(['quorum', 'provisional', file, ...(flags.length ? flags : ['--plan', d.question, '--marker', MARKED.provisional.marker])], { cwd: d.root });
  const after = readFileSync(file, 'utf8');
  return { ...r, untouched: after === text, ledger: JSON.parse(after) };
}
const bare = (over = {}) => {
  const { provisional, ...rest } = carrying(over);
  return rest;
};

test('quorum provisional writes the field only on a ledger that passes the check with no exemption, and check then holds it', async (t) => {
  const d = markedProject(t);
  const done = await provisionalOn(d, bare());
  assert.deepEqual([done.status, done.stderr], [0, '']);
  assert.deepEqual(done.ledger.provisional, MARKED.provisional);
  assert.match(done.stdout, /provisional: marker keep-one-ledger/u);
  assert.equal((await d.check(done.ledger)).status, 0, 'check reads what it wrote');
  const again = await provisionalOn(d, carrying());
  assert.equal(again.status, 0, 'the same marker again changes nothing');
  assert.deepEqual(again.ledger.provisional, MARKED.provisional);
  const settle = bare({ outcome: { conditions: [], disputes: [], flips_if: [{ fact: 'f', how_to_settle: 'read it', settles_from_repo: true, could_harden_undo: false }] } });
  assert.equal((await provisionalOn(d, settle)).status, 0, 'a fact the repository can settle may still go on');
});

test('quorum provisional refuses an invalid ledger and leaves it as it found it', async (t) => {
  const d = markedProject(t);
  const { ruling, outcome } = carrying();
  const dead = cite('doc', 'docs/missing.md#x', 'nope');
  for (const [name, ledger, message] of [
    ['a dead premise', bare({ premise: { summary: 'open', citations: [dead] } }), /premise: invalid: no citation passes/u],
    ['a dead ruling citation', bare({ ruling: { ...ruling, citations: [dead] } }), /ruling: invalid: the ruling has no passing citation/u],
    ['a winner whose case has no evidence', bare({ cases: [stand('A', [dead]), stand('B', [PASSING.code])] }), /governing winner's case has no passing citation/u],
    ['a persona-only winner', bare({ witness: { persona: PASSING.adr.ref.split('#')[0], interview: [], walkthrough: null } }), /rests only on the persona doc/u],
    ['no verdicts', bare({ ruling: { ...ruling, tested: [] } }), /ruling: invalid: /u],
    ['the same faults, already marked', carrying({ premise: { summary: 'open', citations: [dead] } }), /premise: invalid: no citation passes/u],
    ['an open ledger', bare({ status: 'open' }), /provisional: the ledger is not complete/u],
    ['an escalate', bare({ ruling: { ...ruling, decision: 'escalate', winner: null, tested: [] }, outcome: null }), /provisional: the ruling escalates/u],
    ['no class', bare({ ruling: { ...ruling, class: undefined } }), /provisional: the ledger lacks the Ruling's class/u],
    ['a fact that could harden the undo', bare({ outcome: { ...outcome, flips_if: [{ ...outcome.flips_if[0], could_harden_undo: true }] } }), /provisional: a flipping fact could make the decision harder to undo/u],
    ['an answered ledger', bare({ human_answer: 'approved' }), /the Human has answered/u],
    ['another marker on record', carrying({ provisional: { marker: 'another-one' } }), /already records another-one/u],
    ['off the schema', bare({ ruling: { ...ruling, class: 3 } }), /\$\.ruling\.class must be string/u],
    ['a decide ledger', decideLedger(), /only a product ledger/u],
  ]) {
    const result = await provisionalOn(d, ledger);
    assert.equal(result.status, 1, `${name}: ${result.stdout}`);
    assert.match(result.stderr, message, name);
    assert.ok(result.untouched, `${name}: nothing written`);
  }
  write(d.root, 'docs/decisions/0001-store.md', '# 1. Store\n\n## Decision\nImplementing it changed this.\n');
  const stale = await provisionalOn(d, bare());
  assert.deepEqual([stale.status, stale.untouched], [1, true], 'a cited file that changed before the record');
});

test('quorum provisional: a bad marker or argument exits 1, writes nothing, and names the form', async (t) => {
  const d = markedProject(t);
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  for (const marker of ['', ' ', 'Not A Slug!', 'x'.repeat(33)]) {
    const result = await provisionalOn(d, bare(), '--plan', d.question, '--marker', marker);
    assert.deepEqual([result.status, result.untouched], [1, true], JSON.stringify(marker));
  }
  for (const flags of [['--plan', d.question], ['--marker', 'a'], ['--plan', d.question, '--marker', 'a', '--bogus']]) {
    const result = await provisionalOn(d, bare(), ...flags);
    assert.deepEqual([result.status, result.untouched], [1, true], flags.join(' '));
    assert.match(result.stderr, /usage: aidrian quorum provisional LEDGER --plan PLAN --marker ID/u, flags.join(' '));
  }
  // A process run, so the command's own entry in bin/aidrian stays tested.
  const none = await cli(['quorum', 'provisional', '--plan', d.question, '--marker', 'a'], { cwd: d.root, asProcess: true });
  assert.equal(none.status, 1);
  const unread = await cli(['quorum', 'provisional', `${file}.missing`, '--plan', d.question, '--marker', 'a'], { cwd: d.root });
  assert.equal(unread.status, 1);
});

test('quorum provisional reads the base branch\'s settings: it writes only where route continues or settles first', async (t) => {
  const { ruling } = carrying();
  const review = productConfig({ autoStart: true, approval: 'review-later' });
  const uxRuling = { ruling: { ...ruling, domain: 'ux' } };
  for (const [name, config, over, message] of [
    ['approval first', productConfig({ autoStart: true, approval: 'first' }), {}, /route is quorum.*approval is first/u],
    ['first by default', productConfig({ autoStart: true }), {}, /approval is first/u],
    ['autoStart off', productConfig({ autoStart: false, approval: 'review-later' }), {}, /route is as-today.*autoStart is off/u],
    ['resolve says ask', productConfig({ autoStart: true, approval: 'review-later' }, {}), {}, /route is quorum.*resolve says ask/u],
    ['a floor class', review, { ruling: { ...ruling, class: 'money' } }, /route is quorum.*resolve says ask/u],
    ['hard to undo', review, { ruling: { ...ruling, reversible: 'yes,no,no,no' } }, /route is quorum.*resolve says ask/u],
    ['an unrouted domain', review, { ruling: { ...ruling, domain: 'architecture' } }, /route is as-today.*not a domain a quorum routes/u],
    ['its own domain asks', productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }), uxRuling, /route is quorum.*resolve says ask/u],
  ]) {
    const refused = await provisionalOn(markedProject(t, config), bare(over));
    assert.equal(refused.status, 1, `${name}: ${refused.stdout}`);
    assert.match(refused.stderr, message, name);
    assert.ok(refused.untouched, `${name}: nothing written`);
  }
  assert.equal((await provisionalOn(markedProject(t), bare(uxRuling))).status, 0, 'a ux ruling resolves under ux, not under the product default');

  const raised = markedProject(t, productConfig({ autoStart: true, approval: 'first' }));
  write(raised.root, '.aidrian/config.json', JSON.stringify({ version: 1, ...review }));
  raised.git('add', '.aidrian');
  raised.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'raise');
  const stillFirst = await provisionalOn(raised, bare());
  assert.deepEqual([stillFirst.status, stillFirst.untouched], [1, true], 'a branch raising approval over its base reads the base');

  const invalid = markedProject(t);
  write(invalid.root, '.aidrian/config.json', JSON.stringify({ version: 1, quorum: { product: { approval: 'later' } } }));
  const stopped = await provisionalOn(invalid, bare());
  assert.deepEqual([stopped.status, stopped.untouched], [1, true], 'an invalid config.json stops it');
  assert.match(stopped.stderr, /"quorum\.product\.approval" must be/u);
});

// Every value of `trigger` but the one, for a run the Human started, one whose route asked, and near misses.
const OTHER_TRIGGERS = ['the Human asked', "the route, with resolve's ask", 'the route, with resolve\u2019s decide', "The route, with resolve's decide", `${ROUTE_DECIDE} `, 'the route', ''];

test('only a run the route started under decide continues: check on a provisional ledger, route --ledger, and the writer agree on each other trigger', async (t) => {
  const d = markedProject(t);
  for (const trigger of OTHER_TRIGGERS) {
    const held = await d.check(carrying({ trigger }));
    assert.equal(held.status, 1, `check: ${trigger}`);
    assert.match(held.stderr, /provisional: only a run the route started under resolve's decide continues/u, trigger);
    writeFileSync(d.file, JSON.stringify(bare({ trigger })));
    const routed = await d.route();
    assert.deepEqual([...pickRoute(routed), routed.resolve.authority], ['human', true, 'decide'], `route: ${trigger}`);
    assert.match(routed.reason, /only a run the route started under resolve's decide continues/u, trigger);
    const written = await provisionalOn(d, bare({ trigger }));
    assert.deepEqual([written.status, written.untouched], [1, true], `writer: ${trigger}`);
    assert.match(written.stderr, /only a run the route started under resolve's decide continues/u, trigger);
    assert.equal((await d.check(bare({ trigger }))).status, 0, `with no provisional, a ledger stays valid: ${trigger}`);
  }
  const { trigger: _, ...noTrigger } = bare();
  writeFileSync(d.file, JSON.stringify(noTrigger));
  assert.deepEqual(pickRoute(await d.route()), ['human', true], 'read as JSON, no trigger at all continues nothing');
  assert.equal((await d.check(carrying())).status, 0, 'the one value continues');
  assert.deepEqual(pickRoute(await d.route()), ['quorum', false]);
});

test('a ledger of another trigger waits under every setting, and a hard-to-undo seed keeps resolve\'s own answer', async (t) => {
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  for (const trigger of OTHER_TRIGGERS) {
    const ledger = routeLedger([flip('users', false, false)], { trigger });
    for (const autoStart of [false, true]) {
      for (const approval of ['first', 'review-later']) {
        assert.equal(routeAfterRuling({ autoStart, approval, maxAutoRuns: 3 }, ledger, decide, 'product').wait, true, `${trigger}, ${autoStart}, ${approval}`);
      }
    }
  }
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asks = await ledgerRoute(t, repo, routeLedger([], { trigger: "the route, with resolve's ask", ruling: ruled({ reversible: 'yes,no,no,no' }) }));
  assert.deepEqual([...pickRoute(asks), asks.resolve.authority], ['quorum', true, 'ask']);
});

test('quorum provisional refuses a ruling at or above the second look with no approved sign-off, and an unknown severity counts as above', async (t) => {
  const approved = { agent: 'critic', sign_off: 'approved', reason: 'it holds' };
  const at = (severity, second_look) => {
    const { ruling } = carrying();
    return bare({ ruling: { ...ruling, severity }, ...(second_look ? { second_look } : {}) });
  };
  const d = markedProject(t);
  for (const severity of ['high', 'critical', 'major', 'blocker', 'dire']) {
    const refused = await provisionalOn(d, at(severity));
    assert.deepEqual([refused.status, refused.untouched], [1, true], severity);
    assert.match(refused.stderr, /second look: critic must approve/u, severity);
    assert.equal((await provisionalOn(d, at(severity, approved))).status, 0, `${severity}, approved`);
  }
  for (const sign_off of ['rejected', 'Approved', '']) {
    const refused = await provisionalOn(d, at('high', { ...approved, sign_off }));
    assert.deepEqual([refused.status, refused.untouched], [1, true], sign_off);
    assert.match(refused.stderr, /second look: critic must approve/u, sign_off);
  }
  for (const agent of ['architect', 'Critic', 'aidrian:critic', '']) {
    const refused = await provisionalOn(d, at('high', { ...approved, agent }));
    assert.deepEqual([refused.status, refused.untouched], [1, true], `approved by ${JSON.stringify(agent)}`);
    assert.match(refused.stderr, /second look: critic must approve/u, agent);
    assert.ok(refused.stderr.includes(`second_look is from ${JSON.stringify(agent)}`), agent);
  }
  for (const severity of ['medium', 'low', 'nit']) assert.equal((await provisionalOn(d, at(severity))).status, 0, `${severity} is below high`);
  assert.equal((await provisionalOn(d, at('low', { ...approved, agent: 'architect' }))).status, 0, 'below the bar, no agent is required');
  const review = { autoStart: true, approval: 'review-later' };
  assert.equal((await provisionalOn(markedProject(t, productConfig(review, { ...OPEN_DECISIONS, secondLook: null })), at('critical'))).status, 0, 'null turns it off');
  const stricter = markedProject(t, productConfig(review, { ...OPEN_DECISIONS, secondLook: { agent: 'architect', minSeverity: 'medium' } }));
  const named = await provisionalOn(stricter, at('medium'));
  assert.equal(named.status, 1);
  assert.match(named.stderr, /second look: architect must approve/u, 'the agent and the level come from the base branch');
  assert.equal((await provisionalOn(stricter, at('low'))).status, 0);
  assert.equal((await provisionalOn(stricter, at('medium', approved))).status, 1, 'the default agent\'s approval does not count where the base branch names another');
  assert.equal((await provisionalOn(stricter, at('medium', { ...approved, agent: 'architect' }))).status, 0, 'the agent the base branch names');
});

test('the writer and route --ledger share one route: the writer refuses a marker the Human settled or rejected, and takes one not yet on record', async (t) => {
  for (const [answer, message] of [['confirmed', /the Human settled its marker keep-one-ledger/u], ['changed', /the Human settled its marker keep-one-ledger/u], ['rejected', /marker keep-one-ledger was rejected/u]]) {
    const d = markedProject(t);
    assert.equal((await d.decisions('set', MARKED.provisional.marker, answer)).status, 0, answer);
    for (const [name, ledger] of [['first write', bare()], ['already held', carrying()]]) {
      const refused = await provisionalOn(d, ledger);
      assert.deepEqual([refused.status, refused.untouched], [1, true], `${answer}, ${name}`);
      assert.match(refused.stderr, message, `${answer}, ${name}`);
    }
  }
  const d = markedProject(t);
  const first = await provisionalOn(d, bare(), '--plan', d.question, '--marker', 'not-written-yet');
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(pickRoute(await d.route()), ['human', true], 'and route waits until that marker exists');
});

test('quorum provisional logs resolve\'s row with resolve\'s key, and a ledger the check refuses logs none', async (t) => {
  const d = markedProject(t);
  const state = temp(t, 'aidrian-provisional-log-');
  const env = { ...process.env, XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: 'session-1' };
  const quorum = (...args) => cli(['quorum', ...args], { cwd: d.root, env });
  const rows = async () => {
    const dir = (await cli(['state'], { cwd: d.root, env })).stdout.trim();
    let text = '';
    try {
      text = readFileSync(path.join(dir, 'dispatch-log.jsonl'), 'utf8');
    } catch (error) {
      assert.equal(error.code, 'ENOENT');
    }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(({ event }) => event?.startsWith('decision_'));
  };
  const ledger = bare({ premise: { summary: 'open', citations: [cite('doc', 'docs/missing.md#x', 'nope')] } });
  writeFileSync(d.file, JSON.stringify(ledger));
  assert.equal((await quorum('provisional', d.file, '--plan', d.question, '--marker', MARKED.provisional.marker)).status, 1);
  assert.deepEqual(await rows(), [], 'refused by the check, it asks resolve nothing');
  writeFileSync(d.file, JSON.stringify(bare()));
  assert.equal((await quorum('route', '--ledger', d.file, '--domain', 'product')).status, 0);
  const written = await quorum('provisional', d.file, '--plan', d.question, '--marker', MARKED.provisional.marker);
  assert.equal(written.status, 0, written.stderr);
  const [routed, recorded, ...rest] = await rows();
  assert.deepEqual(rest, []);
  assert.deepEqual([recorded.event, recorded.rule, recorded.domain, recorded.class, recorded.key], ['decision_made', 'mode', 'product', 'copy', routed.key]);
});

// A committed project `quorum check`, `quorum provisional`, and `route --ledger` all read, with one decision marker on record.
function markedProject(t, config = productConfig({ autoStart: true, approval: 'review-later' })) {
  const d = decideProject(t);
  const { marker } = MARKED.provisional;
  write(d.root, '.aidrian/config.json', JSON.stringify({ version: 1, ...config }));
  write(d.root, '.aidrian/knowledge/10-docs.json', JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'decided.md': { summary: 'decided rules', tags: [] } } }));
  write(d.root, 'docs/decided.md', `# Decided\n\nOne ledger holds it.\n<!-- aidrian:decision id=${marker} status=unconfirmed class=copy domain=product date=${new Date().toISOString().slice(0, 10)} pr=none -->\n<!-- aidrian:decision-new id=${marker} text="One ledger holds it." -->\n`);
  d.git('add', '.aidrian', 'docs');
  d.git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'project');
  d.git('checkout', '-q', '-b', 'feature');
  const file = path.join(d.state, 'quorum/my-plan-abc.json');
  const route = async (domain = 'product', { asProcess = false } = {}) => {
    const r = await cli(['quorum', 'route', '--ledger', file, '--domain', domain], { cwd: d.root, asProcess });
    assert.deepEqual([r.status, r.stderr], [0, '']);
    return JSON.parse(r.stdout);
  };
  const decisions = (...args) => cli(['decisions', ...args], { cwd: d.root });
  return { ...d, file, route, decisions };
}

test('quorum check, then quorum route --ledger on the same file: the ledger check passes is the one route continues on', async (t) => {
  const d = markedProject(t);
  const checked = await d.check(carrying());
  assert.equal(checked.status, 0, checked.stderr);
  const out = await d.route();
  assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', false, 'decide'], out.reason);
  assert.deepEqual(out.listed, [{ fact: 'real users want it', how_to_settle: 'ask them' }]);

  // The one writer, then both readers, on one file, with a fact the repository settles first.
  const flips = [{ fact: 'the code allows it', how_to_settle: 'read it', settles_from_repo: true, could_harden_undo: false }];
  const written = await provisionalOn(d, bare({ outcome: { conditions: [], disputes: [], flips_if: flips } }));
  assert.equal(written.status, 0, written.stderr);
  assert.equal((await d.check(written.ledger)).status, 0);
  const settling = await d.route();
  assert.deepEqual([...pickRoute(settling), settling.settle], ['quorum', true, [{ fact: 'the code allows it', how_to_settle: 'read it' }]]);
});

test('quorum route --ledger: a provisional ledger continues only while its marker is unconfirmed', async (t) => {
  for (const answer of ['confirmed', 'changed']) {
    const settled = markedProject(t);
    assert.equal((await settled.check(carrying())).status, 0);
    assert.deepEqual(pickRoute(await settled.route()), ['quorum', false], 'unconfirmed continues');
    const set = await settled.decisions('set', MARKED.provisional.marker, answer);
    assert.equal(set.status, 0, set.stderr);
    const out = await settled.route();
    assert.deepEqual(pickRoute(out), ['human', true], answer);
    assert.match(out.reason, /the Human settled its marker keep-one-ledger, so read the rule in its doc/u, answer);
  }

  // Any copy the Human settled counts, whichever the scan reads first.
  const twice = markedProject(t);
  write(twice.root, '.aidrian/knowledge/10-docs.json', JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'decided.md': { summary: 'decided rules', tags: [] }, 'other.md': { summary: 'other rules', tags: [] } } }));
  write(twice.root, 'docs/other.md', `# Other\n\nAnother line.\n<!-- aidrian:decision id=${MARKED.provisional.marker} status=confirmed class=copy domain=product date=${new Date().toISOString().slice(0, 10)} pr=none -->\n<!-- aidrian:decision-new id=${MARKED.provisional.marker} text="Another line." -->\n`);
  assert.equal((await twice.check(carrying())).status, 0);
  assert.deepEqual(pickRoute(await twice.route()), ['human', true], 'one settled copy');

  const rejected = markedProject(t);
  assert.equal((await rejected.check(carrying())).status, 0);
  const set = await rejected.decisions('set', MARKED.provisional.marker, 'rejected');
  assert.equal(set.status, 0, set.stderr);
  const afterReject = await rejected.route();
  assert.deepEqual(pickRoute(afterReject), ['human', true]);
  assert.match(afterReject.reason, /marker keep-one-ledger was rejected/u);

  const undone = markedProject(t);
  assert.equal((await undone.check(carrying())).status, 0);
  const undo = await undone.decisions('undo', MARKED.provisional.marker);
  assert.equal(undo.status, 0, undo.stderr);
  assert.equal((await undone.check(carrying())).status, 0, 'the record stays valid');
  const afterUndo = await undone.route();
  assert.deepEqual(pickRoute(afterUndo), ['human', true]);
  assert.match(afterUndo.reason, /marker keep-one-ledger is not on record/u);

  const never = markedProject(t);
  assert.equal((await never.check(carrying({ provisional: { marker: 'never-written' } }))).status, 0);
  assert.deepEqual(pickRoute(await never.route()), ['human', true], 'a marker no doc holds');

  // Read as JSON, a field off its shape reads as no marker at all, and the Human's answer still comes first.
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const provisional of [null, 'x', {}, { marker: '' }, { marker: 3 }]) assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([], { provisional }))), ['human', true], JSON.stringify(provisional));
  assert.match((await ledgerRoute(t, repo, routeLedger([], { provisional: { marker: 'gone' }, human_answer: 'Yes' }))).reason, /the Human's answer governs/u);
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger())), ['quorum', false], 'no provisional, nothing to look up');
});

test('quorum route --ledger: a ledger that passed check continues under review later, so the two read the same fields', async (t) => {
  const d = decideProject(t);
  const { status, ledger: checked, stderr } = await d.check(carrying());
  assert.equal(status, 0, stderr);
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  const { route, wait, listed } = routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'product', 'unconfirmed');
  assert.deepEqual([route, wait, listed], ['quorum', false, [{ fact: 'real users want it', how_to_settle: 'ask them' }]]);
  assert.deepEqual(pickRoute(routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'ux', 'unconfirmed')), ['human', true], 'a product ruling never routes as ux');
  assert.deepEqual(pickRoute(routeAfterRuling({ autoStart: true, approval: 'review-later', maxAutoRuns: 3 }, checked, decide, 'product')), ['human', true], 'and its marker must be on record');
});

test('quorum route --ledger: only a ruling in the domain named continues, and any other asks resolve nothing', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const inDomain = (domain) => routeLedger([], { ruling: ruled({ domain }) });
  for (const domain of ['product', 'ux']) {
    const same = await ledgerRoute(t, repo, inDomain(domain), '--domain', domain);
    assert.deepEqual([...pickRoute(same), same.resolve.authority], ['quorum', false, 'decide'], domain);
  }
  const noDomain = ruled();
  delete noDomain.domain;
  const missing = await ledgerRoute(t, repo, routeLedger([], { ruling: noDomain }));
  assert.deepEqual([...pickRoute(missing), missing.resolve], ['human', true, null], 'a ruling with no domain, as on a reused ledger');
  assert.match(missing.reason, /names no domain/u);
  for (const [domain, named] of [['', 'product'], [' ', 'ux'], [null, 'product'], [3, 'ux']]) {
    const blank = await ledgerRoute(t, repo, inDomain(domain), '--domain', named);
    assert.deepEqual([...pickRoute(blank), blank.resolve], ['human', true, null], `${domain} routed as ${named}`);
    assert.match(blank.reason, /names no domain/u);
  }
  for (const [domain, named] of [['ux', 'product'], ['product', 'ux'], ['PRODUCT', 'product']]) {
    const differs = await ledgerRoute(t, repo, inDomain(domain), '--domain', named);
    assert.deepEqual([...pickRoute(differs), differs.resolve], ['human', true, null], `${domain} routed as ${named}`);
    assert.match(differs.reason, /is in the domain/u);
  }

  // The harm itself: a ux ruling routed as product, where the team keeps ux with the Human.
  const uxAsks = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }));
  assert.deepEqual(pickRoute(await ledgerRoute(t, uxAsks, inDomain('ux'))), ['human', true], 'a ux ruling routed as product');
  const underUx = await ledgerRoute(t, uxAsks, inDomain('ux'), '--domain', 'ux');
  assert.deepEqual([...pickRoute(underUx), underUx.resolve.authority], ['quorum', true, 'ask'], 'and under its own domain it waits on its own answer');

  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.deepEqual(pickRoute(await ledgerRoute(t, off, routeLedger([], { ruling: noDomain }))), ['human', true], 'under autoStart off too');
  assert.deepEqual(pickRoute(await ledgerRoute(t, off, inDomain('product'))), ['as-today', true], 'and in its domain, as today');

  // The rules that come first keep their own reason, so a reused ledger the Human answered still reads as answered.
  assert.match((await ledgerRoute(t, repo, routeLedger([], { ruling: noDomain, human_answer: 'Yes' }))).reason, /the Human's answer governs/u);
  assert.match((await ledgerRoute(t, repo, routeLedger([], { ruling: { ...noDomain, decision: 'escalate', winner: null } }))).reason, /the ruling escalates/u);
  const elsewhere = await ledgerRoute(t, repo, routeLedger([], { ruling: noDomain }), '--domain', 'architecture');
  assert.deepEqual([...pickRoute(elsewhere), elsewhere.resolve], ['as-today', true, null], 'a domain no quorum routes stays as it is, and logs nothing on a mismatch');
  const itsOwn = await ledgerRoute(t, repo, inDomain('architecture'), '--domain', 'architecture');
  assert.deepEqual([...pickRoute(itsOwn), itsOwn.resolve.rule], ['as-today', true, 'mode'], 'with the domain matching, resolve answers');
});

test('quorum: the fall-through usage names route, and its flags stay out of USAGE, which holds to the quorum skill\'s flags', async (t) => {
  const { root } = routeRepo(t, {});
  const r = await cli(['quorum', 'nonsense'], { cwd: root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: aidrian quorum codex .*\| route --domain D --class C .*\| route --ledger LEDGER --domain D/u);
  assert.doesNotMatch(commands.quorum.usage, /route/u);
  assert.match(r.stderr, /\| provisional LEDGER --plan PLAN --marker ID/u);
  assert.doesNotMatch(commands.quorum.usage, /provisional|--marker/u);
  assert.match(commands.quorum.about, /with provisional/u);
  assert.match(commands.quorum.about, /with route/u);
});

test('the docs state what automatic product quorums cost and what they can ship', () => {
  const config = readFileSync(path.resolve(import.meta.dirname, '../docs/config.md'), 'utf8').replace(/\s+/gu, ' ');
  for (const line of [
    '`autoStart` alone decides nothing while `decisions` resolves to `ask`',
    'a team commits `decide-reversible` for a small, clear decision to be the agent\'s alone',
    'at most 22 dispatches with the default `maxLoops`, plus one read-only `explorer` dispatch for the settle step',
    '`review-later` with auto-merge can ship a choice no person reviewed',
    'Winners have varied between runs',
  ]) assert.ok(config.includes(line), line);
  const folder = readFileSync(path.resolve(import.meta.dirname, '../docs/project-folder.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(folder.includes('`aidrian quorum route --ledger LEDGER --domain D` reads LEDGER as JSON, and never runs `quorum check` on it'));
  assert.ok(folder.includes('Any domain other than `product` or `ux` is `as-today`'));
  assert.ok(folder.includes('the Human\'s answer governs'));
  assert.ok(folder.includes('For `--domain product` or `ux`, the route is `human` when `ruling.domain` is missing or differs from `--domain`'));
  assert.ok(folder.includes('`provisional` is valid on a `rule` and never on an `escalate`'));
  assert.ok(folder.includes('`aidrian quorum provisional LEDGER --plan PLAN --marker ID` is the one writer of `provisional`'));
  assert.ok(folder.includes('when its marker was rejected or is not on record'));
  assert.ok(folder.includes('the route is `human` when its marker is `confirmed`'));
  assert.ok(folder.includes('`check` cannot tell who wrote the field'));
  assert.ok(folder.includes('`check` reads no settings'));
  assert.ok(folder.includes('refuses unless the route is `quorum` with `wait` false or a `settle` list'));
  assert.ok(config.includes('Only a `product` or `ux` call routes'));
  const log = readFileSync(path.resolve(import.meta.dirname, '../docs/dispatch-log.md'), 'utf8').replace(/\s+/gu, ' ');
  assert.ok(log.includes('`aidrian quorum route` and `aidrian quorum provisional` write the same row, with the same `key`'));
  assert.match(readFileSync(path.resolve(import.meta.dirname, '../README.md'), 'utf8'), /\| `aidrian quorum` \|[^|]*one product decision/u);
});

test('an inference line matches past a curly or straight quote, and still fails on a real difference', () => {
  const claim = 'inference: The Human\u2019s \u201Cview\u201D is unclear.';
  assert.deepEqual(inferenceProblems([claim], [{ statement: 'The Human\'s "view" is unclear.' }]), []);
  assert.deepEqual(inferenceProblems(['inference: The Human\'s view is unclear.'], [{ statement: 'The Human\u2019s view is unclear.' }]), []);
  assert.equal(inferenceProblems([claim], [{ statement: 'The Human\'s "view" is clear.' }]).length, 1);
});

test('the route gives resolve\'s reason when something at the base could not be read, rather than saying auto-start is off', () => {
  const off = { autoStart: false, approval: 'first', maxAutoRuns: 1 };
  const call = { hard: true, domain: 'product' };
  const unread = { authority: 'ask', rule: 'no-base', reason: 'git could not give the unreviewed decisions', base: 'abc1234' };
  const set = { authority: 'ask', rule: 'mode', reason: 'r' };
  const ledger = routeLedger();
  for (const reason of [routeFor(off, call, unread).reason, routeAfterRuling(off, ledger, unread, 'product').reason]) assert.match(reason, /^quorum\.product\.autoStart counts as off, because git could not give the unreviewed decisions/u);
  for (const reason of [routeFor(off, call, set).reason, routeAfterRuling(off, ledger, set, 'product').reason]) assert.match(reason, /^quorum\.product\.autoStart is off at the base branch/u);
});
