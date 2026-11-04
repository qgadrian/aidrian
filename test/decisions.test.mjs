import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { ageDays, CLASS_MAX, DECISION_DOMAINS, DECISION_STATUSES, decisionClasses, decisionWarnings, escalateDocWarnings, isClassName, isDecisionLine, loadVocab, lowerMode, parseDecisions, resolveAuthority, setDecisionStatus, unattendedAnswer, undoDecision } from '../plugins/aidrian/lib/decisions.mjs';
import { findWrapViolations } from '../plugins/aidrian/lib/markdown-wrap.mjs';
import { check as prBodyDeny } from '../plugins/aidrian/lib/rules/github/pr-body.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FLOOR = ['security', 'critical-flow', 'money', 'data-loss', 'unknown'];
const ORDINARY = ['copy', 'layout', 'ordering', 'default-value', 'naming', 'module-boundary', 'backlog-rank', 'product-behaviour'];
const NO = { storedData: false, external: false, pricingOrContract: false, reachesUsersUnreviewed: false };

// DEFAULTS with `changes` over its `decisions`, for a team that opted in with a higher ceiling; nested keys are given whole.
const config = (changes = {}) => ({ decisions: { ...DEFAULTS.decisions, maxMode: 'decide-reversible', ...changes } });
const open = config({ mode: 'decide-reversible' });
const question = (changes = {}) => ({ domain: 'ux', class: 'copy', reversible: NO, ...changes });

test('decisions.json is the class list: floor classes first, every class and question defined in one line', () => {
  const { classes, reversibility } = loadVocab();
  assert.deepEqual(decisionClasses(), [...FLOOR, ...ORDINARY]);
  assert.deepEqual(classes.filter((each) => each.floor).map((each) => each.class), FLOOR);
  assert.deepEqual(Object.keys(reversibility), ['storedData', 'external', 'pricingOrContract', 'reachesUsersUnreviewed']);
  assert.match(reversibility.reachesUsersUnreviewed, /existing users.*no human review.*no off switch/u);
  for (const definition of [...classes.map((each) => each.definition), ...Object.values(reversibility)]) {
    assert.match(definition, /^[^\n]{10,}$/u);
  }
});

test('the code that reads the classes never spells one: decisions.json is the one list', () => {
  for (const file of ['decisions.mjs', 'decisions-cli.mjs', 'config.mjs']) {
    const source = readFileSync(path.join(ROOT, 'plugins/aidrian/lib', file), 'utf8');
    for (const kind of [...FLOOR, ...ORDINARY]) assert.doesNotMatch(source, new RegExp(`['"]${kind}['"]`, 'u'), `${file} ${kind}`);
  }
});

test('the default config sends every domain and class to the Human, even with every answer no', () => {
  for (const domain of DECISION_DOMAINS) {
    for (const kind of decisionClasses()) {
      assert.equal(resolveAuthority(DEFAULTS, question({ domain, class: kind })).authority, 'ask', `${domain} ${kind}`);
    }
  }
  assert.equal(resolveAuthority(DEFAULTS, question()).rule, 'mode');
  const raised = { decisions: { ...DEFAULTS.decisions, mode: 'decide-reversible' } };
  assert.deepEqual(pick(resolveAuthority(raised, question())), ['ask', 'maxMode'], 'mode alone opts nothing in: the default ceiling holds it');
});

test('a floor class, or one not in decisions.json, always asks, whatever the config says', () => {
  const everything = config({ mode: 'decide-reversible', domains: Object.fromEntries(DECISION_DOMAINS.map((domain) => [domain, 'decide-reversible'])) });
  for (const kind of FLOOR) assert.deepEqual(pick(resolveAuthority(everything, question({ class: kind }))), ['ask', 'floor-class'], kind);
  for (const kind of ['Copy', 'pricing', '', undefined, 'constructor']) assert.deepEqual(pick(resolveAuthority(everything, question({ class: kind }))), ['ask', 'unknown-class'], String(kind));
});

test('any reversibility answer that is yes or missing asks, one question at a time', () => {
  for (const key of Object.keys(NO)) {
    assert.deepEqual(pick(resolveAuthority(open, question({ reversible: { ...NO, [key]: true } }))), ['ask', 'reversibility'], `${key} yes`);
    const { [key]: _, ...missing } = NO;
    const out = resolveAuthority(open, question({ reversible: missing }));
    assert.deepEqual(pick(out), ['ask', 'reversibility'], `${key} missing`);
    assert.match(out.reason, new RegExp(`^${key} is unanswered`, 'u'));
    assert.deepEqual(pick(resolveAuthority(open, question({ reversible: { ...NO, [key]: 'no' } }))), ['ask', 'reversibility'], `${key} not a boolean`);
  }
  assert.deepEqual(pick(resolveAuthority(open, question({ reversible: undefined }))), ['ask', 'reversibility']);
});

test('"decide" needs the effective mode decide-reversible: a domain wins over mode, and maxMode caps both', () => {
  assert.deepEqual(pick(resolveAuthority(open, question())), ['decide', 'mode']);
  const domains = { ...DEFAULTS.decisions.domains, ux: 'ask', backlog: 'decide-reversible' };
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'decide-reversible', domains }), question())), ['ask', 'domains.ux']);
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'ask', domains }), question({ domain: 'backlog' }))), ['decide', 'domains.backlog']);
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'decide-reversible', maxMode: 'ask' }), question())), ['ask', 'maxMode']);
  assert.deepEqual(pick(resolveAuthority(config({ domains, maxMode: 'ask' }), question({ domain: 'backlog' }))), ['ask', 'maxMode']);
  assert.deepEqual(pick(resolveAuthority(open, question({ domain: 'finance' }))), ['ask', 'unknown-domain']);
});

test('a project escalate class or doc asks before anything weighs reversibility', () => {
  const escalating = config({ mode: 'decide-reversible', escalate: ['copy'], escalateDocs: ['docs/pricing.md', 'docs/legal/', 'docs/terms.md#refunds'] });
  assert.deepEqual(pick(resolveAuthority(escalating, question({ reversible: {} }))), ['ask', 'escalate']);
  assert.deepEqual(pick(resolveAuthority(escalating, question({ class: 'layout' }))), ['decide', 'mode']);
  const covered = [
    'docs/pricing.md', './docs/pricing.md', 'docs//pricing.md', 'docs/./pricing.md', 'docs/x/../pricing.md', 'docs/pricing.md#plans', 'docs/legal/privacy.md', 'docs/legal',
    'docs/terms.md#refunds', 'docs/./terms.md#refunds',
    'docs/terms.md', // with no section named, the doc may include the listed section
    'docs', '.', // a folder that holds a listed doc
  ];
  for (const doc of covered) assert.deepEqual(pick(resolveAuthority(escalating, question({ class: 'layout', docs: [doc] }))), ['ask', 'escalate-doc'], doc);
  for (const doc of ['docs/pricing.md.bak', 'docs/legal-notes.md', 'docs/terms.md#other', 'notes/pricing.md']) {
    assert.deepEqual(pick(resolveAuthority(escalating, question({ class: 'layout', docs: [doc] }))), ['decide', 'mode'], doc);
  }
  const spelled = config({ mode: 'decide-reversible', escalateDocs: ['./docs//legal/', 'docs/x/../a.md'] });
  for (const doc of ['docs/legal/b.md', 'docs/a.md']) assert.deepEqual(pick(resolveAuthority(spelled, question({ docs: [doc] }))), ['ask', 'escalate-doc'], `entry spelling ${doc}`);
});

test('docMatches folds case in its folder and section branches', () => {
  const folder = config({ mode: 'decide-reversible', escalateDocs: ['docs/a.md'] });
  assert.deepEqual(pick(resolveAuthority(folder, question({ docs: ['DOCS'] }))), ['ask', 'escalate-doc'], 'a folder that holds the entry, in another case');
  const section = config({ mode: 'decide-reversible', escalateDocs: ['docs/terms.md#refunds'] });
  assert.deepEqual(pick(resolveAuthority(section, question({ docs: ['docs/TERMS.md#refunds'] }))), ['ask', 'escalate-doc'], 'a section of the entry\'s file, in another case');
});

test('a section matches by its heading\'s slug, as the review\'s sectionOf reads it', () => {
  const listed = config({ mode: 'decide-reversible', escalateDocs: ['docs/terms.md#Refund-Policy'] });
  for (const doc of ['docs/terms.md#refund-policy', 'docs/terms.md#Refund Policy', 'docs/terms.md#refund  policy!', 'docs/terms.md#!!!']) {
    assert.deepEqual(pick(resolveAuthority(listed, question({ docs: [doc] }))), ['ask', 'escalate-doc'], doc);
  }
  assert.deepEqual(pick(resolveAuthority(listed, question({ docs: ['docs/terms.md#refund-policy-1'] }))), ['decide', 'mode']);
});

test('a doc outside the project asks, with or without an escalateDocs list', () => {
  for (const doc of ['../other.md', '..', '/etc/hosts', 'docs/../../other.md', '../other.md#section']) {
    assert.deepEqual(pick(resolveAuthority(open, question({ docs: [doc] }))), ['ask', 'doc-outside-project'], doc);
  }
  assert.deepEqual(pick(resolveAuthority(open, question({ docs: ['docs/../inside.md'] }))), ['decide', 'mode']);
});

test('the domain pause asks at the count or the age, per domain, and null turns it off', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const paused = (pending, limits = { pending: 3, oldestDays: 7 }) =>
    pick(resolveAuthority(config({ mode: 'decide-reversible', unreviewed: { remind: 'session-start', pauseDomainAt: limits } }), question({ pending }), { now }));
  const recent = { domain: 'ux', date: '2026-11-09' };
  assert.deepEqual(paused([]), ['decide', 'mode'], 'an empty list pauses nothing');
  assert.deepEqual(paused([recent, recent]), ['decide', 'mode'], 'below the count');
  assert.deepEqual(paused([recent, recent, recent]), ['ask', 'domain-paused'], 'at the count');
  assert.deepEqual(paused([{ domain: 'ux', date: '2026-11-04' }]), ['decide', 'mode'], 'six days old');
  assert.deepEqual(paused([{ domain: 'ux', date: '2026-11-03' }]), ['ask', 'domain-paused'], 'seven days old');
  assert.deepEqual(paused([recent, recent, { domain: 'ux', date: 'not a date' }]), ['ask', 'domain-paused'], 'a bad date still counts');
  const other = { domain: 'product', date: '2026-01-01' };
  assert.deepEqual(paused([other, other, other]), ['decide', 'mode'], 'another domain pauses only itself');
  assert.deepEqual(paused([recent, recent, recent], null), ['decide', 'mode'], 'null turns the pause off');
});

test('the domain pause names the docs of that domain\'s markers, once each, when the pending list gives them', () => {
  const now = new Date('2026-11-10T12:00:00Z');
  const pending = [{ domain: 'ux', date: '2026-11-09', doc: 'docs/a.md' }, { domain: 'ux', date: '2026-11-09', doc: 'notes/b.md' }, { domain: 'ux', date: '2026-11-09', doc: 'docs/a.md' }, { domain: 'product', date: '2026-11-09', doc: 'docs/other.md' }];
  const limited = config({ mode: 'decide-reversible', unreviewed: { remind: 'session-start', pauseDomainAt: { pending: 3, oldestDays: 7 } } });
  const { reason } = resolveAuthority(limited, question({ pending }), { now });
  assert.equal(reason, 'ux is paused: 3 unreviewed decisions, the pause is at 3; the markers are in docs/a.md, notes/b.md');
  const bare = pending.map(({ domain, date }) => ({ domain, date }));
  assert.equal(resolveAuthority(limited, question({ pending: bare }), { now }).reason, 'ux is paused: 3 unreviewed decisions, the pause is at 3');
});

test('lowerMode takes the lower of two modes, and an unknown mode counts as ask', () => {
  assert.equal(lowerMode('ask', 'decide-reversible'), 'ask');
  assert.equal(lowerMode('decide-reversible', 'ask'), 'ask');
  assert.equal(lowerMode('decide-reversible', 'decide-reversible'), 'decide-reversible');
  assert.equal(lowerMode('decide-reversible', 'bogus'), 'ask');
});

test('check warns for a mode or a domain above maxMode, naming the key to commit, and for nothing at or below it', () => {
  const ceiling = { maxMode: 'ask' };
  assert.deepEqual(decisionWarnings(config({ ...ceiling, mode: 'ask' })), []);
  assert.deepEqual(decisionWarnings(open), []);
  const [mode, ...noMore] = decisionWarnings(config({ ...ceiling, mode: 'decide-reversible' }));
  assert.deepEqual(noMore, []);
  assert.match(mode, /^decisions\.mode: "decide-reversible" is above decisions\.maxMode "ask".*commit decisions\.maxMode "decide-reversible"/u);
  const domains = { ...DEFAULTS.decisions.domains, ux: 'decide-reversible', product: 'ask' };
  const warned = decisionWarnings(config({ ...ceiling, domains }));
  assert.equal(warned.length, 1, '"inherit" and "ask" are not above "ask"');
  assert.match(warned[0], /^decisions\.domains\.ux: "decide-reversible" is above decisions\.maxMode "ask"/u);
});

test('escalateDocWarnings names each entry whose file or folder no tracked path matches exactly', () => {
  const tracked = ['docs/pricing.md', 'docs/legal/terms.md', 'docs/legalese.md'];
  const warned = (...entries) => escalateDocWarnings(entries, tracked);
  assert.deepEqual(warned('docs/pricing.md', './docs//pricing.md', 'docs/pricing.md#refunds', 'docs/legal/', 'docs/legal'), [], 'every spelling, a section, and a folder');
  assert.match(warned('docs/pricng.md')[0], /^decisions\.escalateDocs: "docs\/pricng\.md" matches no tracked path/u);
  assert.match(warned('docs/Pricing.md')[0], /"docs\/Pricing\.md"/u, 'another case is no match, on any disk');
  assert.equal(warned('docs/lega/').length, 1, 'a folder needs a whole path segment');
  assert.equal(warned('docs/LEGAL/').length, 1);
  assert.equal(warned('docs/pricng.md#refunds', 'docs/pricing.md').length, 1, 'one warning for each entry that misses');
});

test('check warns only when remind is off and the pause is null', () => {
  const warned = (unreviewed) => decisionWarnings(config({ unreviewed }));
  assert.deepEqual(decisionWarnings(DEFAULTS), []);
  assert.deepEqual(warned({ remind: 'off', pauseDomainAt: { pending: 1, oldestDays: 1 } }), []);
  assert.deepEqual(warned({ remind: 'session-start', pauseDomainAt: null }), []);
  assert.equal(warned({ remind: 'off', pauseDomainAt: null }).length, 1);
  assert.match(warned({ remind: 'off', pauseDomainAt: null })[0], /"remind" is "off" and "pauseDomainAt" is null/u);
});

const pick = ({ authority, rule }) => [authority, rule];

const MARKER = '<!-- aidrian:decision id=refund-copy status=unconfirmed class=copy domain=ux date=2026-11-01 pr=41 -->';
const old = (text, id = 'refund-copy') => `<!-- aidrian:decision-old id=${id} text=${JSON.stringify(text)} -->`;
const wrote = (text = 'Rule.', id = 'refund-copy') => `<!-- aidrian:decision-new id=${id} text=${JSON.stringify(text)} -->`;
const problemsOf = (text) => parseDecisions(text).problems.map(({ line, problem }) => [line, problem]);

test('parseDecisions reads a marker beside its rule, with the line and every field', () => {
  const { decisions, problems } = parseDecisions(`# Refunds\n\nRefunds take five days.\n${MARKER}\n${wrote('Refunds take five days.')}\nNext rule.\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual(decisions, [{ id: 'refund-copy', status: 'unconfirmed', class: 'copy', domain: 'ux', date: '2026-11-01', pr: 41, line: 4, through: 5, hasOldWording: false, oldWording: null, hasNewWording: true, newWording: 'Refunds take five days.' }]);
  assert.deepEqual(DECISION_STATUSES, ['unconfirmed', 'confirmed', 'rejected']);
  for (const status of DECISION_STATUSES) assert.equal(parseDecisions(`Rule.\n${MARKER.replace('unconfirmed', status)}\n${wrote()}`).decisions[0].status, status);
});

test('a marker takes any field order and any indentation, and pr=none says no pull request exists yet', () => {
  const reordered = `- Rule.\r\n  <!-- aidrian:decision pr=none date=2026-11-01 domain=product class=naming status=confirmed id=a1 -->\r\n  ${wrote('- Rule.', 'a1')}\r\nnext\r\n`;
  const { decisions, problems } = parseDecisions(reordered);
  assert.deepEqual(problems, []);
  assert.deepEqual([decisions[0].id, decisions[0].pr, decisions[0].line], ['a1', null, 2]);
});

test('a marker out of place is a problem, and still a decision, so undo is told before it looks for the rule', () => {
  const lastDecision = wrote();
  const at = (text) => {
    const { decisions, problems } = parseDecisions(text);
    assert.equal(decisions.filter((each) => each.id === 'refund-copy').length, 1, text);
    return problems.map(({ line, problem }) => [line, problem]);
  };
  const other = MARKER.replace('refund-copy', 'other-one');
  const expected = [
    [`${MARKER}\n${lastDecision}`, 'nothing'],
    [`Rule.\n\n${MARKER}\n${lastDecision}`, 'a blank line'],
    [`# Refunds\n${MARKER}\n${lastDecision}`, 'a heading'],
    [`## Refunds ##\n${MARKER}\n${lastDecision}`, 'a heading'],
  ];
  for (const [text, what] of expected) {
    const found = at(text);
    assert.equal(found.length, 1, text);
    assert.match(found[0][1], new RegExp(`"refund-copy" sits under ${what}`, 'u'), text);
  }
  const stackUnder = [
    [`${other}\n${wrote('Rule.', 'other-one')}\n${MARKER}\n${lastDecision}`, 'nothing', 2],
    [`Rule.\n\n${other}\n${wrote('Rule.', 'other-one')}\n${MARKER}\n${lastDecision}`, 'a blank line', 2],
    [`# Refunds\n${other}\n${wrote('Rule.', 'other-one')}\n${MARKER}\n${lastDecision}`, 'a heading', 2],
  ];
  for (const [text, what, count] of stackUnder) {
    const found = at(text).filter(([, problem]) => problem.includes('"refund-copy" sits'));
    assert.equal(found.length, 1, text);
    assert.match(found[0][1], new RegExp(`sits under ${what}`, 'u'), text);
    assert.equal(at(text).length, count, 'the marker above it sits there too');
  }
  for (const text of [
    `Rule.\n${MARKER}\n${lastDecision}`,
    `- Rule.\n  ${MARKER}\n  ${lastDecision}`,
    `#hashtag rule\n${MARKER}\n${lastDecision}`,
    `| a | b |\n| - | - |\n| 1 | 2 |\n${MARKER}\n${lastDecision}\n\nNext.`,
    `| a |\n| 1 |\n${MARKER}\n${old('| 1 | was ten |')}\n${lastDecision}\nNext.`,
    `\`\`\`\nrule\n\`\`\`\n${MARKER}\n${lastDecision}`,
    `Rule.\n${other}\n${wrote('Rule.', 'other-one')}\n${MARKER}\n${lastDecision}`,
    `Rule.\n${other}\n${old('ten', 'other-one')}\n${wrote('Rule.', 'other-one')}\n${MARKER}\n${lastDecision}`,
    `| a |\n| 1 |\n${other}\n${wrote('| 1 |', 'other-one')}\n${MARKER}\n${lastDecision}\n\nNext.`,
  ]) {
    assert.deepEqual(at(text), [], text);
  }
});

test('a marker inside a table is a problem, a stack judged from the first line below it: it goes directly below the table', () => {
  const other = MARKER.replace('refund-copy', 'other-one');
  const cases = [
    [`| a |\n| - |\n${MARKER}\n${wrote('| a |')}\n| 1 |\n`, 3],
    [`| a |\n| - |\n  ${MARKER}\n${old('was')}\n${wrote('| a |')}\n| 1 |\n`, 3],
    [`| a |\n| - |\n${other}\n${wrote('| a |', 'other-one')}\n${MARKER}\n${wrote('| a |')}\n| 1 |\n`, 5],
  ];
  for (const [text, line] of cases) {
    const { decisions, problems } = parseDecisions(text);
    const own = problems.filter(({ problem }) => problem.includes('"refund-copy"'));
    assert.ok(decisions.some(({ id }) => id === 'refund-copy'), text);
    assert.equal(own.length, 1, text);
    assert.equal(own[0].line, line, text);
    assert.match(own[0].problem, /"refund-copy" sits inside a table: it goes directly below the table/u, text);
  }
  assert.deepEqual(parseDecisions(`| a |\n| 1 |\n${MARKER}\n${wrote('| 1 |')}\nNext.\n`).problems, [], 'below the table, the next line no row');
});

test('a quoted marker is no decision: inside a code fence or a code span, as a doc shows one', () => {
  const quoted = ['```text', MARKER, '```', '', `Write it as \`${MARKER}\`.`, '- ```md', `  ${MARKER}`, '  ```', ''].join('\n');
  assert.deepEqual(parseDecisions(quoted), { decisions: [], problems: [], unlisted: [] });
  assert.deepEqual(parseDecisions('aidrian:decision is the marker word, and <!-- aidrian:decisions --> another comment.'), { decisions: [], problems: [], unlisted: [] });
});

test('a malformed marker is reported with its line and why, never thrown, and the good ones beside it still read', () => {
  const cases = [
    ['<!-- aidrian:decision -->', /missing id, status, class, domain, date, pr/u],
    ['<!-- aidrian:decision id=a status=unconfirmed', /alone on its line/u],
    ['<!--aidrian:decision id=a status=unconfirmed class=copy domain=ux date=2026-11-01 pr=1 -->', /alone on its line/u],
    [`The rule. ${MARKER}`, /alone on its line/u],
    [`- ${MARKER}`, /alone on its line/u],
    [`${MARKER} trailing`, /alone on its line/u],
    [`${MARKER} ${MARKER}`, /"-->"/u],
    [MARKER.replace(' pr=41', ''), /missing pr/u],
    [MARKER.replace(' pr=41', ' pr=41 pr=42'), /pr is given twice/u],
    [MARKER.replace('id=refund-copy', 'id'), /"id" has no value/u],
    [MARKER.replace(' pr=41', ' pr=41 owner=x'), /unknown field "owner"/u],
    [MARKER.replace(' pr=41', ' __proto__=x pr=41'), /unknown field "__proto__"/u],
    [MARKER.replace('id=refund-copy', 'id=Refund_Copy'), /id "Refund_Copy"/u],
    [MARKER.replace('id=refund-copy', `id=${'a'.repeat(33)}`), /at most 32/u],
    [MARKER.replace('status=unconfirmed', 'status=approved'), /status "approved"/u],
    [MARKER.replace('class=copy', 'class=pricing'), /class "pricing"/u],
    [MARKER.replace('class=copy', 'class=constructor'), /class "constructor"/u],
    [MARKER.replace('class=copy', 'class=money'), /floor class/u],
    [MARKER.replace('domain=ux', 'domain=finance'), /domain "finance"/u],
    [MARKER.replace('date=2026-11-01', 'date=2026-02-30'), /date "2026-02-30"/u],
    [MARKER.replace('date=2026-11-01', 'date=yesterday'), /date "yesterday"/u],
    [MARKER.replace('pr=41', 'pr=#41'), /pr "#41"/u],
    [MARKER.replace('pr=41', 'pr=0'), /pr "0"/u],
  ];
  for (const [line, expected] of cases) {
    const { decisions, problems } = parseDecisions(`first\n${line}\n\nSecond rule.\n${MARKER}\n${wrote('Second rule.')}\n`);
    assert.equal(decisions.length, 1, line);
    assert.equal(decisions[0].line, 5, line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 2, line);
    assert.match(problems[0].problem, expected, line);
  }
});

test('a decision that replaces a rule keeps the old wording in the lines directly under it; one that fills a gap has none', () => {
  const wording = 'Refunds take "ten" days.\nAsk `support` first.';
  const one = parseDecisions(`The new rule.\n${MARKER}\n${old(wording)}\n${wrote('The new rule.')}\nNext rule.\n`);
  assert.deepEqual(one.problems, []);
  assert.deepEqual([one.decisions[0].hasOldWording, one.decisions[0].oldWording, one.decisions[0].through], [true, wording, 4]);
  const split = parseDecisions(`The new rule.\r\n${MARKER}\r\n${old('Refunds take ')}\r\n${old('ten days.')}\r\n${wrote('The new rule.')}\r\nnext\r\n`);
  assert.deepEqual(split.problems, []);
  assert.equal(split.decisions[0].oldWording, 'Refunds take ten days.', 'long wording spans lines, so each stays under the wrap limit');
  const gap = parseDecisions(`The new rule.\n${MARKER}\n${wrote('The new rule.')}\n`).decisions[0];
  assert.deepEqual([gap.hasOldWording, gap.oldWording, gap.hasNewWording, gap.newWording], [false, null, true, 'The new rule.']);
  assert.deepEqual(parseDecisions(`\`\`\`\n${old('quoted')}\n${wrote('quoted')}\n\`\`\`\n`), { decisions: [], problems: [], unlisted: [] }, 'a quoted line is not a line of wording');
});

test('old wording that cannot be read is reported, and the decision says it has some rather than reading as a gap', () => {
  const cases = [
    ['<!-- aidrian:decision-old id=refund-copy text=ten days -->', /text="/u],
    ['<!-- aidrian:decision-old id=refund-copy -->', /text="/u],
    ['<!-- aidrian:decision-old id=refund-copy text="a\\q" -->', /JSON string/u],
    ['<!-- aidrian:decision-old id=refund-copy text="a --> b" -->', /-\\u002d>/u],
    ['<!-- aidrian:decision-old id=refund-copy text="" -->', /empty/u],
    [old('ten', 'other-id'), /id "other-id"/u],
    [`rule ${old('ten')}`, /text="/u],
  ];
  for (const [line, expected] of cases) {
    const { decisions, problems } = parseDecisions(`The new rule.\n${MARKER}\n${line}\n${old('more')}\n${wrote('The new rule.')}\n`);
    assert.deepEqual([decisions[0].hasOldWording, decisions[0].oldWording], [true, null], line);
    assert.equal(decisions[0].newWording, 'The new rule.', line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 3, line);
    assert.match(problems[0].problem, expected, line);
  }
  assert.deepEqual(problemsOf(`rule\n${old('ten')}\n`), [[2, 'old wording with no decision marker directly above it']]);
  assert.deepEqual(problemsOf(`rule\n${MARKER}\n${wrote('rule')}\n\n${old('ten')}\n`), [[5, 'old wording with no decision marker directly above it']], 'a gap between them');
  assert.deepEqual(parseDecisions(`rule\n${MARKER}\n${wrote('rule')}\n\n${old('ten')}\n`).decisions[0].hasOldWording, false);
});

test('new wording joins its pieces, and is required: unreadable, under the wrong id, before the old lines, or missing is a problem', () => {
  const split = parseDecisions(`The new rule.\nIts second line.\n${MARKER}\n${old('Was.')}\n${wrote('The new rule.\n')}\n${wrote('Its second line.')}\nnext\n`);
  assert.deepEqual(split.problems, []);
  assert.equal(split.decisions[0].newWording, 'The new rule.\nIts second line.');
  assert.deepEqual([split.decisions[0].line, split.decisions[0].through], [3, 6]);

  const cases = [
    ['<!-- aidrian:decision-new id=refund-copy text=oops -->', /new wording is one HTML comment/u],
    ['<!-- aidrian:decision-new id=refund-copy text="a\\q" -->', /new wording: text is not a JSON string/u],
    ['<!-- aidrian:decision-new id=refund-copy text="a --> b" -->', /new wording holds "-->"/u],
    ['<!-- aidrian:decision-new id=refund-copy text="" -->', /new wording is empty/u],
    [wrote('Rule.', 'other-id'), /new wording with id "other-id"/u],
  ];
  for (const [line, expected] of cases) {
    const { decisions, problems } = parseDecisions(`Rule.\n${MARKER}\n${line}\n${wrote('more')}\n`);
    assert.deepEqual([decisions[0].hasNewWording, decisions[0].newWording, decisions[0].through], [true, null, 4], line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 3, line);
    assert.match(problems[0].problem, expected, line);
  }

  const reversed = parseDecisions(`Rule.\n${MARKER}\n${wrote()}\n${old('Was.')}\n`);
  assert.deepEqual(reversed.problems.map(({ line }) => line), [4]);
  assert.match(reversed.problems[0].problem, /old wording comes after the new wording/u);
  assert.deepEqual([reversed.decisions[0].hasOldWording, reversed.decisions[0].oldWording], [true, null]);

  const missing = `"refund-copy" records no wording it wrote: add a decision-new line`;
  assert.deepEqual(problemsOf(`Rule.\n${MARKER}\n`), [[2, missing]], 'at the end of the run');
  assert.deepEqual(problemsOf(`Rule.\n${MARKER}\n${old('Was.')}\nNext.\n`), [[2, missing]], 'old wording alone');
  assert.deepEqual(problemsOf(`Rule.\n${MARKER}\n\n${wrote()}\n`), [[2, missing], [4, 'new wording with no decision marker directly above it']], 'a gap before it');
  const other = MARKER.replace('refund-copy', 'other-one');
  assert.deepEqual(problemsOf(`Rule.\n${MARKER}\n${other}\n${wrote('Rule.', 'other-one')}\n`), [[2, missing]], 'the next marker closes the run');
  assert.equal(parseDecisions(`Rule.\n${MARKER}\n`).decisions[0].hasNewWording, false);

  for (const line of [old('x'), wrote('x'), `  ${wrote('x')}`, MARKER]) assert.equal(isDecisionLine(line), true, line);
  for (const line of ['Rule.', `rule ${wrote('x')}`, '<!-- aidrian:decision-new id=open']) assert.equal(isDecisionLine(line), false, line);
});

test('setDecisionStatus rewrites only the status of that marker, byte for byte around it', () => {
  const other = MARKER.replace('refund-copy', 'other-one');
  const quoted = ['```', MARKER, '```'].join('\n');
  const before = `# Doc  \r\n\r\n${quoted}\nRule.\n${other}\n${wrote('Rule.', 'other-one')}\n\nRule.\n${MARKER}\n${old('status=unconfirmed stays')}\n${wrote()}\n\tlast line, no newline`;
  const { text, from, line } = setDecisionStatus(before, 'refund-copy', 'rejected');
  assert.deepEqual([from, line], ['unconfirmed', 11]);
  assert.equal(text, before.replace(`Rule.\n${MARKER}`, `Rule.\n${MARKER.replace('status=unconfirmed', 'status=rejected')}`));
  assert.equal(parseDecisions(text).decisions.find((each) => each.id === 'refund-copy').oldWording, 'status=unconfirmed stays', 'old wording stays');
  assert.equal(setDecisionStatus(MARKER.replace('status=unconfirmed', 'status=rejected'), 'refund-copy', 'rejected').text, MARKER.replace('status=unconfirmed', 'status=rejected'));
  assert.equal(setDecisionStatus(before, 'no-such-id', 'confirmed'), null);
  assert.equal(setDecisionStatus(`${MARKER}\n${MARKER}\n`, 'refund-copy', 'confirmed'), null, 'two markers of one id name no one marker');
  const reordered = '<!-- aidrian:decision status=unconfirmed pr=none date=2026-11-01 domain=ux class=copy id=first-field -->';
  assert.equal(setDecisionStatus(reordered, 'first-field', 'confirmed').text, reordered.replace('status=unconfirmed', 'status=confirmed'));
  const tight = '<!-- aidrian:decision id=tight pr=none date=2026-11-01 domain=ux class=copy status=unconfirmed-->';
  const rewritten = setDecisionStatus(`Rule.\n${tight}\n`, 'tight', 'confirmed').text;
  assert.equal(rewritten, `Rule.\n${tight.replace('status=unconfirmed-->', 'status=confirmed-->')}\n`, 'status last, with a tight close, keeps the close');
  assert.equal(parseDecisions(rewritten).decisions[0].status, 'confirmed');
});

test('the longest marker stays on one screen, and the wrap check never reports a marker or old wording line', () => {
  const longestOf = (words) => words.reduce((a, b) => (b.length > a.length ? b : a));
  const floor = new Set(loadVocab().classes.filter((each) => each.floor).map((each) => each.class));
  const kind = longestOf(decisionClasses().filter((each) => !floor.has(each)));
  const longest = `<!-- aidrian:decision id=${'a'.repeat(32)} status=unconfirmed class=${kind} domain=${longestOf(DECISION_DOMAINS)} date=2026-11-01 pr=99999 -->`;
  assert.deepEqual(parseDecisions(`Rule.\n${longest}\n<!-- aidrian:decision-new id=${'a'.repeat(32)} text="Rule." -->`).problems, []);
  assert.ok(longest.length <= DEFAULTS.docs.wrapLimit, `${longest.length} characters`);
  const ownClass = (name) => longest.replace(`class=${kind}`, `class=${name}`);
  assert.ok(isClassName('a'.repeat(CLASS_MAX)));
  assert.equal(isClassName('a'.repeat(CLASS_MAX + 1)), false);
  assert.equal(ownClass('a'.repeat(CLASS_MAX)).length, DEFAULTS.docs.wrapLimit, 'the longest project class just fits');
  assert.ok(ownClass('a'.repeat(CLASS_MAX + 1)).length > DEFAULTS.docs.wrapLimit, 'one more would not');
  const longOld = old(`${'word '.repeat(60)}end`);
  const longNew = wrote(`${'word '.repeat(60)}end`);
  assert.deepEqual(findWrapViolations(`Rule.\n${longest}\n  ${longOld}\n  ${longNew}\n`, 60), []);
  const prose = `The rule says <!-- aidrian:decision is a marker --> and ${'word '.repeat(30)}end`;
  assert.deepEqual(findWrapViolations(prose, 60).map(({ line }) => line), [1], 'prose that mentions one is still prose');
  assert.deepEqual(findWrapViolations(`<!-- aidrian:decision id=open ${'word '.repeat(30)}end`, 60).map(({ line }) => line), [1], 'an unclosed comment is no marker');
});

test('the docs say what the code does for removed, rejected markers, undo refusals, the pause, and the rule\'s limit', () => {
  const read = (file) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/g, ' ');
  const folder = read('docs/project-folder.md');
  assert.match(folder, /A marker the merge base held in an unindexed file, which `HEAD` still holds in that file, is not `removed`\./u);
  assert.match(folder, /A rejected marker is exempt too: `set rejected` changes no wording, so a later hand edit is expected\./u);
  assert.match(folder, /For an unknown id it prints the reason alone\./u);
  assert.match(folder, /a later decision or one it cannot read, such as an unterminated comment or a marker on a prose line/u);
  assert.match(folder, /a decision line directly above whose new wording is not this marker's old wording, or cannot be read/u);
  assert.match(folder, /A problem the merge base already has, the same text on the same line, stays in the list, marked `inherited: true`/u);
  assert.match(folder, /For a marker that does not parse, or one in a file no index lists, it prints the reason, the raw wording lines, and the block\./u);
  assert.match(folder, /the list says those markers could not be scanned, as a `note` row, or in `notes` in the JSON, and still exits 0\./u);
  assert.match(folder, /A marker in a tracked Markdown file no index lists is a `problem`/u);
  assert.match(read('docs/config.md'), /a stack whose wordings do not chain, or a marker in a tracked Markdown file no index lists\./u);
  assert.match(read('docs/config.md'), /The base is the local `origin\/HEAD`, so after that answer merges, `resolve` stays paused until a fetch\./u);
  assert.match(read('docs/hooks.md'), /The rule stops accidents and is no security boundary: a form it does not read, such as `xargs` or `npx`, runs\./u);
});

test('ageDays counts whole days from the marker date, and a date ahead of the clock is zero', () => {
  const now = new Date('2026-11-04T12:00:00Z');
  assert.equal(ageDays('2026-11-04', now), 0);
  assert.equal(ageDays('2026-11-01', now), 3);
  assert.equal(ageDays('2026-12-01', now), 0);
});

// A project with `pullRequest` as its contract, and the rule's answer for a `gh pr create` of `body`.
function bodyRule(t, pullRequest, requiredSections = ['Summary', 'Tests run']) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-decisions-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, github: { requiredSections, pullRequest } }));
  return (body) => prBodyDeny(`gh pr create --title x --body-file - <<'EOF'\n${body}EOF\n`, { cwd: dir, env: {}, listOpenPrs: () => [] });
}

test('the pull request body rule takes both forms of the decisions list, and a closed list still refuses the heading', (t) => {
  const tests = '## Tests run\n- `npm test`: pass\n';
  const section = `## Summary\nDone.\n\n## Decisions\n- refund-copy: copy, ux. Five days.\n\n${tests}`;
  const subList = `## Summary\nDone.\n\nDecisions:\n\n- refund-copy: copy, ux. Five days.\n\n${tests}`;
  const free = bodyRule(t, {});
  assert.equal(free(section), null, 'no closed list');
  assert.equal(free(subList), null, 'no closed list');
  const listed = bodyRule(t, { sections: ['Summary', 'Tests run', 'Decisions'] });
  assert.equal(listed(section), null, 'a closed list with Decisions');
  const closed = bodyRule(t, { sections: ['Summary', 'Tests run'] });
  assert.equal(closed(subList), null, 'a closed list without Decisions takes the sub-list');
  assert.match(closed(section), /adds the section\(s\) `## Decisions`/u, 'a closed list stays closed');
  const noSummary = bodyRule(t, { sections: ['Why', 'Tests run'] }, ['Why']);
  const firstSection = `## Why\nDone.\n\nDecisions:\n\n- refund-copy: copy, ux, fills a gap. Five days.\n\n${tests}`;
  assert.equal(noSummary(firstSection), null, 'with Summary off the closed list, the sub-list goes under its first section');
  assert.match(noSummary(firstSection.replace('Decisions:', '## Decisions')), /adds the section\(s\) `## Decisions`/u);
});

test('pr-write and its body template name both forms of the decisions list', () => {
  for (const file of ['plugins/aidrian/skills/pr-write/SKILL.md', 'plugins/aidrian/skills/pr-write/references/body-template.md']) {
    const text = readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(text, /## Decisions/u, file);
    assert.match(text, /`?Decisions:`?/u, file);
    assert.match(text, /first section on the closed list when Summary is not on it/u, file);
  }
  const skill = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/pr-write/SKILL.md'), 'utf8');
  assert.match(skill, /aidrian decisions list --added-since origin\/<base>/u);
  assert.match(skill, /Every run, run `aidrian decisions list --added-since origin\/<base> --json`; exit 1 is the stop below for an unclear base\./u, 'the list runs whatever the queue');
  assert.match(skill, /Unless config\.json `decisions\.record\.queue` is `report`, list each of its `decisions`/u, 'only the body listing depends on the queue');
  assert.match(skill, /each of its `settled` as settled in this branch/u);
  assert.match(skill, /each of its `removed` as removed in this branch/u);
  assert.match(skill, /When one of its `decisions` has `pr` null, replace `pr=none` on that marker line with the pull request's number, then commit and push only that\.\s+Never on a `settled` entry\./u);
  assert.match(skill, /That push moves the head: it comes before the review of the new head, or the report says it did not\./u);
  assert.match(skill.replace(/\s+/gu, ' '), /A row marked `inherited` was there before this branch, so leave it out; an unmarked problem on a marker the merge base has goes under Risk and stops nothing\./u);
  assert.doesNotMatch(skill, /A problem on an inherited marker/u);
  assert.match(skill, /that list reports a problem in a marker the branch added, other than the `pr=none` Publish fixes: route it back to the same writer\./u, 'the stop stays');
  assert.ok(Buffer.byteLength(skill) <= 7500, `${Buffer.byteLength(skill)} bytes`);
  const rule = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/knowledge/references/decisions.md'), 'utf8');
  assert.match(rule, /A writer on a branch whose pull request already exists writes the real number\./u);
  assert.match(rule, /\*\*Old wording is required\.\*\*/u);
  assert.match(rule, /\*\*New wording is required\.\*\*/u);
  assert.match(rule, /The wording must sit in one block.*a rule spanning blocks takes one decision per block/u);
  assert.doesNotMatch(skill, /grep '\^\+<!--/u, 'the parser reads the markers, not a grep');
  const template = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/pr-write/references/body-template.md'), 'utf8');
  assert.match(template, /replaces a written rule \| fills a gap/u);
  assert.match(template, /`hasOldWording`/u);
  assert.match(template, /a bullet shows the status when it is not `unconfirmed`/iu);
  assert.match(template, /A marker of `removed` is listed as removed in this branch/u);
});

test('a project class resolves as an ordinary class, and a built-in keeps its floor', () => {
  const classes = { 'pricing-page': 'the words and layout of the pricing page' };
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'decide-reversible', classes }), question({ class: 'pricing-page' }))), ['decide', 'mode']);
  assert.deepEqual(pick(resolveAuthority(config({ classes }), question({ class: 'pricing-page' }))), ['ask', 'mode']);
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'decide-reversible', classes, escalate: ['pricing-page'] }), question({ class: 'pricing-page' }))), ['ask', 'escalate']);
  assert.deepEqual(pick(resolveAuthority(open, question({ class: 'pricing-page' }))), ['ask', 'unknown-class'], 'another project has no such class');
  for (const kind of FLOOR) {
    const lifted = config({ mode: 'decide-reversible', classes: { [kind]: 'an ordinary class now' } });
    assert.deepEqual(pick(resolveAuthority(lifted, question({ class: kind }))), ['ask', 'floor-class'], `${kind} stays a floor class`);
  }
  assert.deepEqual(pick(resolveAuthority(config({ mode: 'decide-reversible', classes }), question({ class: 'constructor' }))), ['ask', 'unknown-class'], 'nothing an object inherits is a class');
});

test('unattendedAnswer parks what the setting says, by what the project listed, whichever rule matched first', () => {
  const answer = (safeDefaults, changes = {}, asked = {}) => unattendedAnswer({ ...config(changes).decisions, unattended: { safeDefaults } }, question(asked));
  const docs = ['docs/pricing.md'];
  const listed = { escalate: ['copy', 'security'], escalateDocs: docs, classes: { custom: 'a project class' } };
  for (const mode of ['outside-escalated', 'all']) {
    assert.equal(answer(mode, listed), 'park', `${mode}: a class the project listed`);
    assert.equal(answer(mode, listed, { class: 'layout', docs }), 'park', `${mode}: a doc the project listed`);
    assert.equal(answer(mode, listed, { class: 'layout', docs: ['../away.md', 'docs/pricing.md'] }), 'park', `${mode}: the rule says outside the project, and a later doc is listed`);
    assert.equal(answer(mode, listed, { class: 'security' }), 'park', `${mode}: a floor class the project also listed`);
    assert.equal(answer(mode, listed, { class: 'money', docs }), 'park', `${mode}: a floor class on a listed doc`);
    assert.equal(answer(mode, listed, { class: 'layout' }), 'safe-default', `${mode}: an ordinary class no list names`);
    assert.equal(answer(mode, listed, { class: 'custom' }), 'safe-default', `${mode}: a project class no list names`);
    assert.equal(answer(mode, { escalate: ['custom'], classes: listed.classes }, { class: 'custom' }), 'park', `${mode}: a project class the project listed`);
  }
  for (const kind of [...FLOOR, 'no-such-class']) {
    assert.equal(answer('outside-escalated', {}, { class: kind }), 'park', kind);
    assert.equal(answer('all', {}, { class: kind }), 'safe-default', kind);
  }
  assert.equal(answer(null, {}, { class: 'layout' }), 'park', 'a block no one can read parks everything');
});

test('a marker of a project class reads, is set, and is undone only where the project has that class', () => {
  const classes = { 'pricing-page': 'the words of the pricing page' };
  const line = '<!-- aidrian:decision id=a status=unconfirmed class=pricing-page domain=ux date=2026-01-01 pr=none -->';
  const text = `Rule.\n${line}\n${wrote('Rule.', 'a')}\n`;
  assert.deepEqual(problemsOf(text).map(([, problem]) => problem), ['class "pricing-page" is no class of decisions.json or config.json decisions.classes', 'new wording with no decision marker directly above it']);
  const read = parseDecisions(text, { classes });
  assert.deepEqual([read.problems, read.decisions.map((each) => each.class)], [[], ['pricing-page']]);
  assert.equal(setDecisionStatus(text, 'a', 'confirmed'), null);
  assert.match(setDecisionStatus(text, 'a', 'confirmed', { classes }).text, /status=confirmed class=pricing-page/u);
  assert.ok(undoDecision(text, 'a').refused);
  assert.equal(undoDecision(text, 'a', { classes }).text, '');
  const floor = line.replace('pricing-page', 'money');
  assert.match(parseDecisions(`Rule.\n${floor}\n`, { classes: { money: 'lifted' } }).problems[0].problem, /is a floor class/u);
});

test('the docs say what list --added-since holds and where a symlinked folder stops, and decision-review relays notes first', () => {
  const read = (file) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/gu, ' ');
  const scope = /`decisions`, `settled`, and `removed` are the branch's; `problems` may also hold rows marked `inherited`/u;
  assert.match(read('docs/project-folder.md'), scope);
  assert.match(read('docs/config.md'), scope);
  assert.match(readFileSync(path.join(ROOT, 'plugins/aidrian/lib/decisions-cli.mjs'), 'utf8').split('\n')[6], /decisions, settled, and removed are the branch's; problems may also hold rows marked inherited/u);
  assert.match(read('docs/project-folder.md'), /A doc reached through a symlink is the file it reaches\. At `--added-since` a doc indexed through a symlink is not read, and a new marker in it reports as stray\./u);
  const review = read('plugins/aidrian/skills/decision-review/SKILL.md');
  assert.match(review, /Relay each entry of `notes`/u);
  assert.ok(review.indexOf('`notes`') < review.indexOf('None: say so and stop.'), 'a batch of none must not hide a scan that failed');
});

test('the docs name both team keys, the changed default, each decision row, and the override threshold', () => {
  const read = (file) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/gu, ' ');
  const config = read('docs/config.md');
  for (const key of ['decisions.classes', 'decisions.unattended.safeDefaults']) assert.match(config, new RegExp(`\\| \`${key.replace('.', '\\.')}\` \\|.*Team only\\.`, 'u'), key);
  const changed = config.slice(config.indexOf('### Changed defaults'), config.indexOf('### No review bot'));
  assert.match(changed, /`decisions\.unattended\.safeDefaults` is new, `"outside-escalated"`\. An unattended `autopilot` run now parks a floor class/u);
  assert.match(changed, /"safeDefaults": "all"/u);
  assert.match(config, /asks: `authority` stays `ask` under every setting\. An \[unattended run\]\(#unattended-runs\) under `safeDefaults` `"all"` may still act on one with a safe default\./u);
  assert.match(config, /No setting lets an agent approve a critical-flow sign-off or a security verdict; the skill text holds that rule, and no command checks it\./u);
  assert.match(config, /`unattended` is `park` where nobody can say what the project listed: the rule `no-base`; a base commit whose config\.json is missing, does not parse, or has another version; and an error under `decisions` at that commit\. A config\.json with no `decisions` key takes the defaults\./u);
  assert.match(config, /A marker whose only problem is a class in neither list still counts, so a commit that removes a class lifts no pause\./u);
  assert.match(config, /\| `telemetry\.enabled` \| `false` stops the hooks and `aidrian decisions` from writing/u);
  assert.match(read('plugins/aidrian/skills/decision-review/SKILL.md'), /Report each row about a class no list holds the same way: that marker counts toward the domain pause/u);
  assert.match(read('plugins/aidrian/lib/decisions.json'), /the one place the built-in decision classes and the reversibility questions live; config\.json decisions\.classes adds a project's own classes/u);
  assert.match(read('plugins/aidrian/lib/dispatch-log.mjs'), /per answer of `aidrian decisions`/u);
  assert.match(read('plugins/aidrian/lib/decisions.mjs'), /the only place the built-in decision classes .* `decisions\.classes` adds a project's classes/u);
  assert.match(config, /`maxMode`, `classes`, `escalate`, `escalateDocs`, `unattended`, `secondLook`, and `record` are the team's\./u);
  assert.match(config, /\| `decisionOverridePercent` \|/u);
  assert.match(config, /\| `decisionMinSample` \|/u);
  const log = read('docs/dispatch-log.md');
  for (const row of ['decision_made', 'decision_escalated', 'decision_confirmed', 'decision_overridden']) assert.match(log, new RegExp(`### .*\`${row}\``, 'u'), row);
  assert.match(log, /a repeated `resolve` writes a second row, with the same `key`, and the report counts one decision per `key`/u);
  assert.match(log, /A row that cannot be written fails no command/u);
});

test('the knowledge index finds docs/config.md by the words a search for its decisions uses', () => {
  const { docs } = JSON.parse(readFileSync(path.join(ROOT, '.aidrian/knowledge/10-harness.json'), 'utf8'));
  const { summary } = docs['config.md'];
  assert.ok(summary.length <= 160, `${summary.length} characters`);
  for (const word of ['decisions', 'decision', 'authority', 'roles', 'auto-merge']) assert.ok(summary.includes(word), word);
});

test('a marker whose only problem is its class is on record; any other problem is not', () => {
  const marker = (changes = '') => `<!-- aidrian:decision id=a status=unconfirmed class=gone domain=ux date=2026-01-01 pr=none${changes} -->`;
  const { decisions, problems, unlisted } = parseDecisions(`Rule.\n${marker()}\n${wrote('Rule.', 'a')}\n`);
  assert.deepEqual([decisions, unlisted.map(({ id, class: kind, line }) => [id, kind, line])], [[], [['a', 'gone', 2]]]);
  assert.match(problems[0].problem, /class "gone" is no class of decisions\.json/u, 'still reported');
  assert.deepEqual(parseDecisions(`Rule.\n${marker().replace('date=2026-01-01', 'date=soon')}\n`).unlisted, [], 'a second problem');
  assert.deepEqual(parseDecisions(`Rule.\n${marker().replace('class=gone', 'class=money')}\n`).unlisted, [], 'a floor class is no decision an agent made');
});

test('every test file that spawns aidrian decisions keeps its state apart, whatever command runs it', () => {
  const dir = path.join(ROOT, 'test');
  const spawning = readdirSync(dir).filter((file) => file.endsWith('.test.mjs')).filter((file) => /\[\s*'decisions',\s*'(?:resolve|list|set|undo)'/u.test(readFileSync(path.join(dir, file), 'utf8')));
  assert.ok(spawning.length >= 2);
  for (const file of spawning) assert.match(readFileSync(path.join(dir, file), 'utf8'), /^import '\.\.\/scripts\/test-state\.mjs';\n/u, file);
});

test('a yes on the fourth question decides only where the team allows auto-merge and the mode is decide-reversible', () => {
  const YES = { ...NO, reachesUsersUnreviewed: true };
  const allowed = (changes) => ({ ...config(changes), github: { autoMerge: { allow: true } } });
  const mode = { mode: 'decide-reversible' };
  const decided = resolveAuthority(allowed(mode), question({ reversible: YES }));
  assert.deepEqual(pick(decided), ['decide', 'mode']);
  assert.match(decided.reason, /reachesUsersUnreviewed is yes, which github\.autoMerge\.allow accepts at the base branch/u);
  assert.doesNotMatch(resolveAuthority(allowed(mode), question()).reason, /accepts/u, 'all no is the plain reason');

  const asks = (cfg, asked, rule = 'reversibility') => assert.deepEqual(pick(resolveAuthority(cfg, question(asked))), ['ask', rule]);
  asks(open, { reversible: YES });
  asks({ ...open, github: { autoMerge: { allow: false } } }, { reversible: YES });
  asks(allowed({}), { reversible: YES });
  asks({ decisions: { ...DEFAULTS.decisions, mode: 'decide-reversible' }, github: { autoMerge: { allow: true } } }, { reversible: YES }, 'reversibility');
  asks(allowed({ mode: 'decide-reversible', domains: { ...DEFAULTS.decisions.domains, ux: 'ask' } }), { reversible: YES });
  assert.deepEqual(pick(resolveAuthority(allowed({ domains: { ...DEFAULTS.decisions.domains, ux: 'decide-reversible' } }), question({ reversible: YES }))), ['decide', 'domains.ux']);
  for (const key of ['storedData', 'external', 'pricingOrContract']) asks(allowed(mode), { reversible: { ...YES, [key]: true } });
  asks(allowed(mode), { reversible: { ...NO, reachesUsersUnreviewed: undefined } });
  asks(allowed(mode), { reversible: YES, class: 'money' }, 'floor-class');
  asks(allowed({ ...mode, escalate: ['copy'] }), { reversible: YES }, 'escalate');
  asks(allowed({ ...mode, escalateDocs: ['docs/a.md'] }), { reversible: YES, docs: ['docs/a.md'] }, 'escalate-doc');
  const paused = allowed({ ...mode, unreviewed: { remind: 'off', pauseDomainAt: { pending: 1, oldestDays: 100 } } });
  asks(paused, { reversible: YES, pending: [{ domain: 'ux', date: '2026-11-01' }] }, 'domain-paused');
});
