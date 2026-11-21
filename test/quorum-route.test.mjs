import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { isClearCall, routeAfterRuling, routeFor } from '../plugins/aidrian/lib/quorum.mjs';
import { cli, temp, write, OPEN_DECISIONS, routeRepo, productConfig, pickRoute, flip, ruled, routeLedger, ledgerRoute } from './quorum-fixture.mjs';

const CLEAR = 'no,no,no,no,no';
const HARD = 'no,yes,no,no,no';
const routeCall = (hard, ...more) => ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no', '--hard', hard, ...more];

test('quorum route: with autoStart off, any call follows resolve as today', async (t) => {
  for (const approval of ['first', 'review-later']) {
    const open = routeRepo(t, productConfig({ autoStart: false, approval }));
    for (const hard of [CLEAR, HARD]) assert.deepEqual(pickRoute(await open.route(...routeCall(hard))), ['as-today', false], `decide, ${approval}, ${hard}`);
    const asks = routeRepo(t, productConfig({ autoStart: false, approval }, {}));
    for (const hard of [CLEAR, HARD]) assert.deepEqual(pickRoute(await asks.route(...routeCall(hard))), ['as-today', true], `ask, ${approval}, ${hard}`);
  }
  const unset = await routeRepo(t, { decisions: OPEN_DECISIONS }).route(...routeCall(HARD));
  assert.equal(unset.route, 'as-today', 'off is the default');
});

test('quorum route: a small, clear call is the agent\'s under decide, and the Human\'s with no quorum under ask, whatever approval says', async (t) => {
  for (const approval of ['first', 'review-later']) {
    const open = await routeRepo(t, productConfig({ autoStart: true, approval })).route(...routeCall(CLEAR));
    assert.deepEqual(pickRoute(open), ['agent', false], `decide, ${approval}`);
    assert.equal(open.resolve.authority, 'decide');
    const asks = await routeRepo(t, productConfig({ autoStart: true, approval }, {})).route(...routeCall(CLEAR));
    assert.deepEqual(pickRoute(asks), ['human', true], `ask, ${approval}`);
    assert.equal(asks.resolve.unattended, 'safe-default', 'a small, clear call follows unattended as today');
  }
});

test('quorum route: a hard call runs the quorum: review later continues only under decide, first and ask wait', async (t) => {
  assert.deepEqual(pickRoute(await routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })).route(...routeCall(HARD))), ['quorum', false]);
  assert.deepEqual(pickRoute(await routeRepo(t, productConfig({ autoStart: true, approval: 'first' })).route(...routeCall(HARD))), ['quorum', true]);
  assert.deepEqual(pickRoute(await routeRepo(t, productConfig({ autoStart: true })).route(...routeCall(HARD))), ['quorum', true], 'first is the default');
  for (const approval of ['first', 'review-later']) {
    const asks = await routeRepo(t, productConfig({ autoStart: true, approval }, {})).route(...routeCall(HARD));
    assert.deepEqual(pickRoute(asks), ['quorum', true], `ask, ${approval}`);
    assert.equal(asks.resolve.unattended, 'safe-default', 'the stricter quorum replaces the safe-default shortcut');
  }
  for (const [name, args] of [
    ['a floor class', ['--domain', 'product', '--class', 'money', '--reversible', 'no,no,no,no', '--hard', HARD]],
    ['hard to undo', ['--domain', 'product', '--class', 'copy', '--reversible', 'yes,no,no,no', '--hard', HARD]],
    ['no reversible answers', ['--domain', 'product', '--class', 'copy', '--hard', HARD]],
  ]) {
    const out = await routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })).route(...args);
    assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', true, 'ask'], name);
  }
});

test('quorum route: a hard call at maxAutoRuns waits for the Human with no quorum, under either answer', async (t) => {
  const open = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later', maxAutoRuns: 2 }));
  assert.deepEqual(pickRoute(await open.route(...routeCall(HARD, '--runs', '1'))), ['quorum', false], 'below the cap');
  assert.deepEqual(pickRoute(await open.route(...routeCall(HARD, '--runs', '2'))), ['human', true], 'at the cap');
  assert.deepEqual(pickRoute(await open.route(...routeCall(HARD, '--runs', '3'))), ['human', true], 'past it');
  assert.deepEqual(pickRoute(await open.route(...routeCall(CLEAR, '--runs', '9'))), ['agent', false], 'the cap counts quorums, and a small call runs none');
  const asks = routeRepo(t, productConfig({ autoStart: true, maxAutoRuns: 1 }, {}));
  assert.deepEqual(pickRoute(await asks.route(...routeCall(HARD, '--runs', '1'))), ['human', true], 'under ask');
  const byDefault = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(await byDefault.route(...routeCall(HARD, '--runs', '2'))), ['quorum', false]);
  assert.deepEqual(pickRoute(await byDefault.route(...routeCall(HARD, '--runs', '3'))), ['human', true], 'the default cap is 3');
});

test('quorum route: a missing or unknown hardness answer counts as hard', async (t) => {
  const { route } = routeRepo(t, productConfig({ autoStart: true, approval: 'first' }));
  const copy = ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no'];
  assert.equal((await route(...copy, '--hard', CLEAR)).route, 'agent', 'all no is small and clear');
  assert.equal((await route(...copy, '--hard', ' NO, no,no ,No,no')).route, 'agent', 'spelled as --reversible may be');
  for (const hard of [HARD, 'no,no,no,no', 'no,no,maybe,no,no', 'no,no,,no,no', 'no,no,no,no,no,no', '']) {
    assert.equal((await route(...copy, '--hard', hard)).route, 'quorum', JSON.stringify(hard));
  }
  assert.equal((await route(...copy)).route, 'quorum', 'no --hard at all');
  assert.equal(isClearCall(undefined), false);
});

test('quorum route: no combination routes a resolve answer of ask to the agent or to provisional work', () => {
  const rules = ['floor-class', 'unknown-class', 'escalate', 'escalate-doc', 'doc-outside-project', 'reversibility', 'domain-paused', 'maxMode', 'mode', 'no-base', 'unknown-domain'];
  const answers = [...rules.map((rule) => ({ authority: 'ask', rule })), { rule: 'no authority at all' }];
  for (const answer of answers) {
    for (const autoStart of [false, true]) {
      for (const approval of ['first', 'review-later', 'something else']) {
        for (const hard of [false, true]) {
          for (const runs of [0, 3, 9]) {
            const { route, wait } = routeFor({ autoStart, approval, maxAutoRuns: 3 }, { hard, runs, domain: 'product' }, answer);
            const named = JSON.stringify({ answer, autoStart, approval, hard, runs });
            assert.notEqual(route, 'agent', named);
            assert.equal(wait, true, named);
          }
        }
      }
    }
  }
  const decide = { authority: 'decide', rule: 'mode' };
  assert.equal(routeFor({ autoStart: true, approval: 'something else', maxAutoRuns: 3 }, { hard: true, runs: 0, domain: 'ux' }, decide).wait, true, 'only review-later continues');
});

test('quorum route: a bad argument exits 3 with nothing on stdout, and an invalid config exits 1', async (t) => {
  const { raw, setConfig } = routeRepo(t, productConfig({ autoStart: true }));
  const copy = ['--domain', 'product', '--class', 'copy'];
  for (const [args, problem] of [
    [[], /needs --domain and --class/u],
    [['--domain', 'product'], /needs --domain and --class/u],
    [['--class', 'copy'], /needs --domain and --class/u],
    [[...copy, '--reversible', 'no,maybe'], /--reversible takes up to 4 answers/u],
    [[...copy, '--reversible', 'no,no,no,no,no'], /--reversible takes up to 4 answers/u],
    [[...copy, '--runs', 'two'], /--runs takes a whole number/u],
    [[...copy, '--runs', '1.5'], /--runs takes a whole number/u],
    [[...copy, '--runs', '-1'], /--runs/u],
    [[...copy, '--bogus'], /Unknown option '--bogus'/u],
    [[...copy, 'stray'], /Unexpected argument 'stray'/u],
    [[...copy, '--ledger', 'x.json'], /--ledger takes no --class/u],
    [['--ledger', 'x.json', '--hard', CLEAR], /--ledger takes no --hard/u],
    [['--ledger', 'x.json', '--runs', '1'], /--ledger takes no --runs/u],
    [['--ledger', 'x.json'], /--ledger needs --domain/u],
    [['--ledger', 'missing.json', '--domain', 'product'], /missing\.json/u],
  ]) {
    const r = await raw(...args);
    assert.deepEqual([r.status, r.stdout], [3, ''], args.join(' '));
    assert.match(r.stderr, problem, args.join(' '));
    assert.match(r.stderr, /^usage: aidrian quorum route --domain D --class C /mu, 'the bad argument names the forms');
  }
  setConfig({ quorum: { product: { approval: 'later' } } });
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'asks.json', JSON.stringify(routeLedger()));
  write(state, 'silent.json', JSON.stringify(routeLedger([], { ruling: { decision: 'rule', winner: 'A' } })));
  for (const args of [
    routeCall(HARD),
    ['--ledger', path.join(state, 'asks.json'), '--domain', 'product'],
    ['--ledger', path.join(state, 'silent.json'), '--domain', 'product'],
    ['--ledger', path.join(state, 'missing.json'), '--domain', 'product'],
    ['--domain', 'product'],
  ]) {
    const invalid = await raw(...args);
    assert.deepEqual([invalid.status, invalid.stdout], [1, ''], args.join(' '));
    assert.match(invalid.stderr, /"quorum\.product\.approval" must be "first" or "review-later"/u, args.join(' '));
  }
});

test('quorum route: a branch raising autoStart or approval over its base reads the base\'s values', async (t) => {
  const off = routeRepo(t, productConfig({ autoStart: false }));
  off.git('checkout', '-q', '-b', 'feature');
  off.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(await off.route(...routeCall(HARD))), ['as-today', false], 'an uncommitted raise of autoStart');
  off.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(await off.route(...routeCall(HARD))), ['as-today', false], 'a committed raise of autoStart');

  const first = routeRepo(t, productConfig({ autoStart: true, approval: 'first', maxAutoRuns: 1 }));
  first.git('checkout', '-q', '-b', 'feature');
  first.setConfig(productConfig({ autoStart: true, approval: 'review-later', maxAutoRuns: 10 }));
  first.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(await first.route(...routeCall(HARD))), ['quorum', true], 'a committed raise of approval');
  assert.deepEqual(pickRoute(await first.route(...routeCall(HARD, '--runs', '1'))), ['human', true], 'a committed raise of maxAutoRuns');

  const late = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  assert.deepEqual(pickRoute(await late.route(...routeCall(HARD))), ['quorum', false]);
  late.git('checkout', '-q', '-b', 'feature');
  late.setConfig(productConfig({ autoStart: false }));
  late.git('commit', '-q', '-am', 'lower');
  assert.deepEqual(pickRoute(await late.route(...routeCall(HARD))), ['quorum', false], 'the base decides, in both directions');
});

test('quorum route: no readable base counts as off', async (t) => {
  // Outside git the working copy is resolve's rule, and no base is route's: resolve decides, and route stays off.
  const plain = temp(t, 'aidrian-route-plain-');
  write(plain, '.aidrian/config.json', JSON.stringify({ version: 1, ...productConfig({ autoStart: true, approval: 'review-later' }) }));
  // A process run, so the command's own entry in bin/aidrian stays tested.
  const outside = JSON.parse((await cli(['quorum', 'route', ...routeCall(HARD)], { cwd: plain, asProcess: true })).stdout);
  assert.deepEqual([outside.route, outside.resolve.authority, outside.resolve.base], ['as-today', 'decide', null]);

  // A remote of another name, with no origin: no base at all, whatever the working copy says.
  const remote = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  remote.git('remote', 'add', 'upstream', 'https://example.com/none.git');
  const noBase = await remote.route(...routeCall(HARD));
  assert.deepEqual([noBase.route, noBase.wait, noBase.resolve.rule, noBase.resolve.base], ['as-today', true, 'no-base', null]);

  // A base whose product block has an error is one no one can read as the team meant it.
  const bad = routeRepo(t, productConfig({ autoStart: true, approval: 'later' }));
  bad.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  assert.equal((await bad.route(...routeCall(HARD))).route, 'as-today');
});

test('quorum route prints resolve\'s own answer, pause and doc rules included', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asked = ['--domain', 'product', '--class', 'copy', '--reversible', 'no,no,no,no'];
  const resolveAnswer = async (...more) => JSON.parse((await cli(['decisions', 'resolve', ...asked, ...more], { cwd: repo.root })).stdout);
  assert.deepEqual((await repo.route(...asked, '--hard', HARD)).resolve, await resolveAnswer());
  const out = await repo.route(...asked, '--hard', HARD);
  assert.deepEqual(Object.keys(out), ['route', 'wait', 'reason', 'resolve']);
  assert.equal(typeof out.reason, 'string');

  const docs = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, escalateDocs: ['docs/terms.md'] }));
  const held = await docs.route(...asked, '--hard', HARD, '--doc', 'docs/terms.md');
  assert.deepEqual([...pickRoute(held), held.resolve.rule], ['quorum', true, 'escalate-doc']);

  const marker = '<!-- aidrian:decision id=a status=unconfirmed class=copy domain=product date=2020-01-01 pr=none -->';
  const paused = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, unreviewed: { pauseDomainAt: { pending: 1, oldestDays: 1 } } }));
  write(paused.root, 'docs/a.md', `Rule.\n${marker}\n<!-- aidrian:decision-new id=a text="Rule." -->\n`);
  paused.git('add', '.');
  paused.git('commit', '-q', '-m', 'marker');
  const stopped = await paused.route(...asked, '--hard', HARD);
  assert.deepEqual([...pickRoute(stopped), stopped.resolve.rule], ['quorum', true, 'domain-paused'], 'the pending markers count');
});

test('quorum route --ledger: under review later, each flipping fact decides whether work continues', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const of = (entry) => ({ fact: entry.fact, how_to_settle: entry.how_to_settle });
  const user = flip('real users want it', false, false);
  const repoFact = flip('the code allows it', true, false);
  const harder = flip('it stores data', false, true);

  const none = await ledgerRoute(t, repo, routeLedger());
  assert.deepEqual([...pickRoute(none), none.settle, none.listed], ['quorum', false, [], []], 'no flipping fact continues');
  assert.equal(none.resolve.authority, 'decide');

  const listed = await ledgerRoute(t, repo, routeLedger([user]));
  assert.deepEqual([...pickRoute(listed), listed.settle, listed.listed], ['quorum', false, [], [of(user)]], 'a real-user fact continues and is listed');

  const settle = await ledgerRoute(t, repo, routeLedger([user, repoFact]));
  assert.deepEqual([...pickRoute(settle), settle.settle, settle.listed], ['quorum', true, [of(repoFact)], [of(user)]], 'a fact the repository can settle waits until it is settled');

  const harden = await ledgerRoute(t, repo, routeLedger([user, repoFact, harder]));
  assert.deepEqual([...pickRoute(harden), harden.settle], ['human', true, []], 'a fact that could make the decision harder to undo waits');
  assert.deepEqual(harden.listed, [of(user), of(repoFact), of(harder)]);
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([flip('both', true, true)]))), ['human', true], 'settling cannot lift a fact that could harden the undo');

  const escalates = await ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'escalate', winner: null }) }));
  assert.deepEqual([...pickRoute(escalates), escalates.resolve.authority], ['human', true, 'decide'], 'an escalate waits');
  const escalatesWithWinner = await ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'escalate' }) }));
  assert.deepEqual(pickRoute(escalatesWithWinner), ['human', true], 'an escalate waits on its own rule, with a winner named');
  assert.match(escalatesWithWinner.reason, /the ruling escalates/u);

  const mixed = await ledgerRoute(t, repo, routeLedger([user, harder]));
  assert.deepEqual([...pickRoute(mixed), mixed.listed], ['human', true, [of(user), of(harder)]], 'one fact that could harden the undo holds the whole list');

  const unknown = await ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ decision: 'accept' }) }));
  assert.deepEqual(pickRoute(unknown), ['human', true], 'a decision of no known kind waits');
  assert.match(unknown.reason, /neither rules nor escalates/u);

  const noHow = await ledgerRoute(t, repo, routeLedger([{ fact: 'users', settles_from_repo: false, could_harden_undo: false }]));
  assert.deepEqual(pickRoute(noHow), ['human', true], 'a fact with no how_to_settle waits');
  assert.match(noHow.reason, /lacks its fact or how_to_settle/u);
});

test('quorum route --ledger: a ledger that lost human_answer routes to human, and never says the Human answered', async (t) => {
  const missing = routeLedger();
  delete missing.human_answer;
  for (const approval of ['first', 'review-later']) {
    const out = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval })), missing);
    assert.deepEqual(pickRoute(out), ['human', true], approval);
    assert.match(out.reason, /the ledger lacks human_answer/u);
    assert.doesNotMatch(out.reason, /answered|governs/u);
  }
  const off = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: false })), missing);
  assert.deepEqual(pickRoute(off), ['human', true], 'under autoStart off too');
  const unanswered = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' })), routeLedger());
  assert.deepEqual(pickRoute(unanswered), ['quorum', false], 'null is the field saying no one has answered yet');
});

test('quorum route --ledger: a flips_if entry missing either boolean waits, and no entry shape reads as false', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const [name, entry] of [
    ['neither', flip('x')],
    ['no settles_from_repo', { fact: 'x', how_to_settle: 'y', could_harden_undo: false }],
    ['no could_harden_undo', { fact: 'x', how_to_settle: 'y', settles_from_repo: false }],
    ['a string for false', flip('x', 'false', false)],
    ['null for false', flip('x', false, null)],
    ['not an object', 'x'],
  ]) {
    const out = await ledgerRoute(t, repo, routeLedger([flip('fine', false, false), entry]));
    assert.deepEqual(pickRoute(out), ['human', true], name);
  }
});

test('quorum route --ledger: a ledger without the Ruling\'s class, reversible, docs, severity, or reverts_by, or without a usable outcome, routes to human', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const without = (key) => {
    const ruling = ruled();
    delete ruling[key];
    return routeLedger([], { ruling });
  };
  for (const [name, ledger] of [
    ['no class', without('class')],
    ['no reversible', without('reversible')],
    ['no docs', without('docs')],
    ['no severity', without('severity')],
    ['no reverts_by', without('reverts_by')],
    ['an empty severity', routeLedger([], { ruling: ruled({ severity: ' ' }) })],
    ['an empty reverts_by', routeLedger([], { ruling: ruled({ reverts_by: '' }) })],
    ['an empty class', routeLedger([], { ruling: ruled({ class: '' }) })],
    ['a reversible word that is no answer', routeLedger([], { ruling: ruled({ reversible: 'no,maybe,no,no' }) })],
    ['docs that are not a list of paths', routeLedger([], { ruling: ruled({ docs: 'docs/a.md' }) })],
    ['a doc that is not a path', routeLedger([], { ruling: ruled({ docs: [3] }) })],
    ['no ruling', routeLedger([], { ruling: null })],
    ['a ledger of another mode', routeLedger([], { mode: 'decide' })],
    ['no outcome', routeLedger([], { outcome: null })],
    ['no flips_if', routeLedger([], { outcome: { conditions: [], disputes: [] } })],
    ['not an object', ['a list']],
    ['a ruling of no known decision', routeLedger([], { ruling: ruled({ decision: 'accept' }) })],
  ]) {
    const out = await ledgerRoute(t, repo, ledger);
    assert.deepEqual(pickRoute(out), ['human', true], name);
  }
  assert.equal((await ledgerRoute(t, repo, without('class'))).resolve, null, 'with no question to ask, nothing was resolved');
  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.deepEqual(pickRoute(await ledgerRoute(t, off, without('docs'))), ['human', true], 'under autoStart off too');
  assert.deepEqual(pickRoute(await ledgerRoute(t, off, routeLedger([flip('x')]))), ['human', true], 'and for a flips_if entry');
});

test('quorum route --ledger: only review later under decide continues; first, ask, and off wait with every fact listed', async (t) => {
  const facts = [flip('users', false, false), flip('code', true, false), flip('undo', false, true)];
  const all = facts.map(({ fact, how_to_settle }) => ({ fact, how_to_settle }));
  const first = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'first' })), routeLedger(facts));
  assert.deepEqual([...pickRoute(first), first.settle, first.listed], ['quorum', true, [], all], 'under first the Human sees them all');
  const firstClear = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: true, approval: 'first' })), routeLedger([flip('users', false, false)]));
  assert.deepEqual(pickRoute(firstClear), ['quorum', true], 'a real-user fact does not lift first');

  const asks = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, {}));
  const underAsk = await ledgerRoute(t, asks, routeLedger([flip('users', false, false)]));
  assert.deepEqual([...pickRoute(underAsk), underAsk.resolve.authority], ['quorum', true, 'ask'], 'ask under review later waits');

  const open = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  for (const [name, ruling] of [
    ['hard to undo', ruled({ reversible: 'no,yes,no,no' })],
    ['too few answers', ruled({ reversible: 'no,no' })],
    ['a floor class', ruled({ class: 'security' })],
  ]) {
    const out = await ledgerRoute(t, open, routeLedger([], { ruling }));
    assert.deepEqual([...pickRoute(out), out.resolve.authority], ['quorum', true, 'ask'], name);
  }
  assert.deepEqual(pickRoute(await ledgerRoute(t, open, routeLedger([], { ruling: ruled({ reversible: ['no', 'no', 'no', 'no'] }) }))), ['quorum', false], 'answers as a list');

  const doc = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, escalateDocs: ['docs/terms.md'] }));
  const held = await ledgerRoute(t, doc, routeLedger([], { ruling: ruled({ docs: ['docs/terms.md'] }) }));
  assert.deepEqual([...pickRoute(held), held.resolve.rule], ['quorum', true, 'escalate-doc'], 'the Ruling\'s docs reach resolve');

  const off = await ledgerRoute(t, routeRepo(t, productConfig({ autoStart: false, approval: 'review-later' })), routeLedger([flip('users', false, false)]));
  assert.deepEqual(pickRoute(off), ['as-today', true], 'a product ruling is the Human\'s today, under decide too');

  const uxBlock = { ...OPEN_DECISIONS, domains: { product: 'ask' } };
  const domains = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, uxBlock));
  assert.deepEqual(pickRoute(await ledgerRoute(t, domains, routeLedger())), ['quorum', true], 'the product domain');
  assert.deepEqual(pickRoute(await ledgerRoute(t, domains, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux')), ['quorum', false], 'or the one named, each read on its own');
});

test('quorum route --ledger: a base raised on the branch does not count, and a ledger that does not parse is a bad argument', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'first' }));
  repo.git('checkout', '-q', '-b', 'feature');
  repo.setConfig(productConfig({ autoStart: true, approval: 'review-later' }));
  repo.git('commit', '-q', '-am', 'raise');
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger())), ['quorum', true]);
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'broken.json', '{ not json');
  const broken = await repo.raw('--ledger', path.join(state, 'broken.json'), '--domain', 'product');
  assert.deepEqual([broken.status, broken.stdout], [3, '']);
});

test('quorum route: a domain other than product or ux follows resolve as today, in both forms, whatever the settings say', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const asked = ['--class', 'copy', '--reversible', 'no,no,no,no'];
  for (const [domain, wait, rule] of [['architecture', false, 'mode'], ['backlog', false, 'mode'], ['nonsense', true, 'unknown-domain']]) {
    for (const hard of [HARD, CLEAR, undefined]) {
      const out = await repo.route('--domain', domain, ...asked, ...(hard ? ['--hard', hard] : []));
      assert.deepEqual([...pickRoute(out), out.resolve.rule], ['as-today', wait, rule], `${domain}, ${hard}`);
    }
    const after = await ledgerRoute(t, repo, routeLedger([flip('users', false, false)], { ruling: ruled({ domain }) }), '--domain', domain);
    assert.deepEqual([...pickRoute(after), after.resolve.rule], ['as-today', true, rule], `${domain} after a ruling`);
    const mismatch = await ledgerRoute(t, repo, routeLedger([flip('users', false, false)]), '--domain', domain);
    assert.deepEqual([...pickRoute(mismatch), mismatch.resolve], ['as-today', true, null], `${domain} after a product ruling asks resolve nothing`);
    assert.match(mismatch.reason, /is not a domain a quorum routes$/u, 'with no answer, it names none');
    assert.match(after.reason, /resolve's answer stands/u);
    assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([], { status: 'open', human_answer: 'x' }), '--domain', domain)), ['as-today', true], `${domain} before any ledger rule`);
  }
  assert.equal((await repo.route('--domain', 'ux', ...asked, '--hard', HARD)).route, 'quorum', 'ux runs the quorum');
  assert.equal((await repo.route('--domain', 'ux', ...asked, '--hard', CLEAR)).route, 'agent', 'and a small ux call is the agent\'s');
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux')), ['quorum', false]);
});

test('quorum route --ledger: --domain is required, so a ux ruling never resolves under product\'s laxer answer', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }, { ...OPEN_DECISIONS, domains: { ux: 'ask' } }));
  const state = temp(t, 'aidrian-route-state-');
  write(state, 'ledger.json', JSON.stringify(routeLedger()));
  const none = await repo.raw('--ledger', path.join(state, 'ledger.json'));
  assert.deepEqual([none.status, none.stdout], [3, '']);
  assert.match(none.stderr, /--ledger needs --domain/u);
  const ux = await ledgerRoute(t, repo, routeLedger([], { ruling: ruled({ domain: 'ux' }) }), '--domain', 'ux');
  assert.deepEqual([...pickRoute(ux), ux.resolve.authority], ['quorum', true, 'ask']);
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger(), '--domain', 'product')), ['quorum', false]);
});

test('quorum route --ledger: the Human\'s answer governs, under either approval', async (t) => {
  for (const approval of ['first', 'review-later']) {
    const repo = routeRepo(t, productConfig({ autoStart: true, approval }));
    for (const human_answer of ['No: take option B', 'Yes', '']) {
      const out = await ledgerRoute(t, repo, routeLedger([flip('users', false, false)], { human_answer }));
      assert.deepEqual(pickRoute(out), ['human', true], `${approval}: ${human_answer}`);
      assert.match(out.reason, /the Human's answer governs/u);
    }
  }
  const off = routeRepo(t, productConfig({ autoStart: false }));
  assert.match((await ledgerRoute(t, off, routeLedger([], { human_answer: 'Yes' }))).reason, /the Human's answer governs/u, 'off too');
});

test('quorum route --ledger: a ledger that is not complete routes to human', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const noStatus = routeLedger();
  delete noStatus.status;
  for (const [name, ledger] of [['open', routeLedger([], { status: 'open' })], ['missing', noStatus], ['another word', routeLedger([], { status: 'done' })]]) {
    assert.deepEqual(pickRoute(await ledgerRoute(t, repo, ledger)), ['human', true], name);
  }
  assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger())), ['quorum', false], 'complete continues');
});

test('quorum route --ledger: a rule with no named winner, or a flips_if entry with no fact or how to settle it, routes to human', async (t) => {
  const repo = routeRepo(t, productConfig({ autoStart: true, approval: 'review-later' }));
  const noWinner = ruled();
  delete noWinner.winner;
  for (const [name, ruling] of [['missing', noWinner], ['null', ruled({ winner: null })], ['empty', ruled({ winner: '' })], ['blank', ruled({ winner: '  ' })], ['a number', ruled({ winner: 1 })]]) {
    assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([], { ruling }))), ['human', true], `winner ${name}`);
  }
  const marks = { settles_from_repo: false, could_harden_undo: false };
  for (const [name, entry] of [
    ['no fact', { how_to_settle: 'ask', ...marks }],
    ['no how_to_settle', { fact: 'users', ...marks }],
    ['an empty fact', { fact: '', how_to_settle: 'ask', ...marks }],
    ['an empty how_to_settle', { fact: 'users', how_to_settle: ' ', ...marks }],
    ['an object for a fact', { fact: { a: 1 }, how_to_settle: 'ask', ...marks }],
    ['a number for how_to_settle', { fact: 'users', how_to_settle: 5, ...marks }],
  ]) {
    assert.deepEqual(pickRoute(await ledgerRoute(t, repo, routeLedger([flip('fine', false, false), entry]))), ['human', true], name);
  }
});

test('routeAfterRuling: no combination with a resolve answer of ask, or a wait case, prints wait false', () => {
  const decide = { authority: 'decide', rule: 'mode', reason: 'r' };
  const asks = ['floor-class', 'unknown-class', 'escalate', 'escalate-doc', 'doc-outside-project', 'reversibility', 'domain-paused', 'maxMode', 'mode', 'no-base', 'unknown-domain'].map((rule) => ({ authority: 'ask', rule, reason: 'r' }));
  const noStatus = routeLedger();
  delete noStatus.status;
  const noAnswer = routeLedger();
  delete noAnswer.human_answer;
  const noWinner = ruled();
  delete noWinner.winner;
  const clean = [routeLedger(), routeLedger([flip('users', false, false)])];
  // Each ledger in the domain asked about, so it waits on its own rule and not on a domain that differs.
  const inDomain = (ledger, domain) => (ledger?.ruling ? { ...ledger, ruling: { ...ledger.ruling, domain } } : ledger);
  const waiting = [
    routeLedger([flip('code', true, false)]),
    routeLedger([flip('undo', false, true)]),
    routeLedger([flip('both', true, true)]),
    routeLedger([flip('unmarked')]),
    routeLedger([flip('half', false)]),
    routeLedger([{ settles_from_repo: false, could_harden_undo: false }]),
    routeLedger([{ fact: 'users', settles_from_repo: false, could_harden_undo: false }]),
    routeLedger([flip('users', false, false), flip('undo', false, true)]),
    routeLedger([], { human_answer: 'Yes' }),
    routeLedger([], { human_answer: '' }),
    noAnswer,
    routeLedger([], { status: 'open' }),
    noStatus,
    routeLedger([], { ruling: null }),
    routeLedger([], { ruling: ruled({ decision: 'escalate', winner: null }) }),
    routeLedger([], { ruling: ruled({ decision: 'escalate' }) }),
    routeLedger([], { ruling: ruled({ decision: 'accept' }) }),
    routeLedger([], { ruling: noWinner }),
    routeLedger([], { outcome: null }),
    routeLedger([], { mode: 'decide' }),
    routeLedger([], { trigger: 'the Human asked' }),
    routeLedger([], { trigger: "the route, with resolve's ask" }),
    routeLedger([], { trigger: undefined }),
    null,
    [],
    'a word',
  ];
  const settingsList = [false, true].flatMap((autoStart) => ['first', 'review-later', 'something else'].map((approval) => ({ autoStart, approval, maxAutoRuns: 3 })));
  for (const settings of settingsList) {
    for (const domain of ['product', 'ux', 'architecture', 'nonsense']) {
      const named = (ledger, answer) => JSON.stringify({ settings, domain, ledger, answer });
      for (const each of [...clean, ...waiting]) {
        const ledger = inDomain(each, domain);
        for (const answer of [...asks, { rule: 'no authority at all' }, null]) {
          assert.equal(routeAfterRuling(settings, ledger, answer, domain).wait, true, named(ledger, answer));
        }
      }
      for (const each of waiting) {
        const ledger = inDomain(each, domain);
        assert.equal(routeAfterRuling(settings, ledger, decide, domain).wait, true, named(ledger, decide));
      }
      for (const each of clean) {
        const ledger = inDomain(each, domain);
        const continues = settings.autoStart && settings.approval === 'review-later' && ['product', 'ux'].includes(domain);
        assert.equal(routeAfterRuling(settings, ledger, decide, domain).wait, !continues, named(ledger, decide));
        for (const other of [undefined, null, '', 'elsewhere', domain.toUpperCase()]) {
          const off = inDomain(each, other);
          assert.equal(routeAfterRuling(settings, off, decide, domain).wait, true, named(off, decide));
        }
      }
    }
  }
});
