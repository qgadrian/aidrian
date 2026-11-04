import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { ageDays, DECISION_DOMAINS, DECISION_STATUSES, decisionClasses, decisionWarnings, escalateDocWarnings, loadVocab, lowerMode, parseDecisions, resolveAuthority, setDecisionStatus } from '../plugins/aidrian/lib/decisions.mjs';
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
const problemsOf = (text) => parseDecisions(text).problems.map(({ line, problem }) => [line, problem]);

test('parseDecisions reads a marker beside its rule, with the line and every field', () => {
  const { decisions, problems } = parseDecisions(`# Refunds\n\nRefunds take five days.\n${MARKER}\nNext rule.\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual(decisions, [{ id: 'refund-copy', status: 'unconfirmed', class: 'copy', domain: 'ux', date: '2026-11-01', pr: 41, line: 4, hasOldWording: false, oldWording: null }]);
  assert.deepEqual(DECISION_STATUSES, ['unconfirmed', 'confirmed', 'rejected']);
  for (const status of DECISION_STATUSES) assert.equal(parseDecisions(`Rule.\n${MARKER.replace('unconfirmed', status)}`).decisions[0].status, status);
});

test('a marker takes any field order and any indentation, and pr=none says no pull request exists yet', () => {
  const reordered = '- Rule.\r\n  <!-- aidrian:decision pr=none date=2026-11-01 domain=product class=naming status=confirmed id=a1 -->\r\nnext\r\n';
  const { decisions, problems } = parseDecisions(reordered);
  assert.deepEqual(problems, []);
  assert.deepEqual([decisions[0].id, decisions[0].pr, decisions[0].line], ['a1', null, 2]);
});

test('a marker out of place is a problem, and still a decision, so undo is told before it looks for the rule', () => {
  const at = (text) => {
    const { decisions, problems } = parseDecisions(text);
    assert.equal(decisions.filter((each) => each.id === 'refund-copy').length, 1, text);
    return problems.map(({ line, problem }) => [line, problem]);
  };
  const expected = [
    [MARKER, 'nothing'],
    [`Rule.\n\n${MARKER}`, 'a blank line'],
    [`# Refunds\n${MARKER}`, 'a heading'],
    [`## Refunds ##\n${MARKER}`, 'a heading'],
    [`\`\`\`\nrule\n\`\`\`\n${MARKER}`, 'a code fence'],
    [`Rule.\n${MARKER.replace('refund-copy', 'other-one')}\n${MARKER}`, 'another decision line'],
    [`Rule.\n${MARKER.replace('refund-copy', 'other-one')}\n${old('ten', 'other-one')}\n${MARKER}`, 'another decision line'],
  ];
  for (const [text, what] of expected) {
    const found = at(text);
    assert.equal(found.length, 1, text);
    assert.match(found[0][1], new RegExp(`"refund-copy" sits under ${what}`, 'u'), text);
  }
  for (const text of [`Rule.\n${MARKER}`, `- Rule.\n  ${MARKER}`, `#hashtag rule\n${MARKER}`, `| a | b |\n| - | - |\n| 1 | 2 |\n${MARKER}\n\nNext.`, `| a |\n| 1 |\n${MARKER}\n${old('| 1 | was ten |')}\nNext.`]) {
    assert.deepEqual(at(text), [], text);
  }
});

test('a marker inside a table is a problem: it goes directly below the table', () => {
  for (const text of [`| a |\n| - |\n${MARKER}\n| 1 |\n`, `| a |\n| - |\n  ${MARKER}\n${old('was')}\n| 1 |\n`]) {
    const { decisions, problems } = parseDecisions(text);
    assert.equal(decisions.length, 1, text);
    assert.equal(problems.length, 1, text);
    assert.equal(problems[0].line, 3, text);
    assert.match(problems[0].problem, /"refund-copy" sits inside a table: it goes directly below the table/u, text);
  }
});

test('a quoted marker is no decision: inside a code fence or a code span, as a doc shows one', () => {
  const quoted = ['```text', MARKER, '```', '', `Write it as \`${MARKER}\`.`, '- ```md', `  ${MARKER}`, '  ```', ''].join('\n');
  assert.deepEqual(parseDecisions(quoted), { decisions: [], problems: [] });
  assert.deepEqual(parseDecisions('aidrian:decision is the marker word, and <!-- aidrian:decisions --> another comment.'), { decisions: [], problems: [] });
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
    const { decisions, problems } = parseDecisions(`first\n${line}\n\nSecond rule.\n${MARKER}\n`);
    assert.equal(decisions.length, 1, line);
    assert.equal(decisions[0].line, 5, line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 2, line);
    assert.match(problems[0].problem, expected, line);
  }
});

test('a decision that replaces a rule keeps the old wording in the lines directly under it; one that fills a gap has none', () => {
  const wording = 'Refunds take "ten" days.\nAsk `support` first.';
  const one = parseDecisions(`The new rule.\n${MARKER}\n${old(wording)}\nNext rule.\n`);
  assert.deepEqual(one.problems, []);
  assert.deepEqual([one.decisions[0].hasOldWording, one.decisions[0].oldWording], [true, wording]);
  const split = parseDecisions(`The new rule.\r\n${MARKER}\r\n${old('Refunds take ')}\r\n${old('ten days.')}\r\nnext\r\n`);
  assert.deepEqual(split.problems, []);
  assert.equal(split.decisions[0].oldWording, 'Refunds take ten days.', 'long wording spans lines, so each stays under the wrap limit');
  const gap = parseDecisions(`The new rule.\n${MARKER}\n`).decisions[0];
  assert.deepEqual([gap.hasOldWording, gap.oldWording], [false, null]);
  assert.deepEqual(parseDecisions(`\`\`\`\n${old('quoted')}\n\`\`\`\n`), { decisions: [], problems: [] }, 'a quoted line is not a line of old wording');
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
    const { decisions, problems } = parseDecisions(`The new rule.\n${MARKER}\n${line}\n${old('more')}\n`);
    assert.deepEqual([decisions[0].hasOldWording, decisions[0].oldWording], [true, null], line);
    assert.equal(problems.length, 1, line);
    assert.equal(problems[0].line, 3, line);
    assert.match(problems[0].problem, expected, line);
  }
  assert.deepEqual(problemsOf(`rule\n${old('ten')}\n`), [[2, 'old wording with no decision marker directly above it']]);
  assert.deepEqual(problemsOf(`rule\n${MARKER}\n\n${old('ten')}\n`), [[4, 'old wording with no decision marker directly above it']], 'a gap between them');
  assert.deepEqual(parseDecisions(`rule\n${MARKER}\n\n${old('ten')}\n`).decisions[0].hasOldWording, false);
});

test('setDecisionStatus rewrites only the status of that marker, byte for byte around it', () => {
  const other = MARKER.replace('refund-copy', 'other-one');
  const quoted = ['```', MARKER, '```'].join('\n');
  const before = `# Doc  \r\n\r\n${quoted}\nRule.\n${other}\n\nRule.\n${MARKER}\n${old('status=unconfirmed stays')}\n\tlast line, no newline`;
  const { text, from, line } = setDecisionStatus(before, 'refund-copy', 'rejected');
  assert.deepEqual([from, line], ['unconfirmed', 10]);
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
  assert.deepEqual(parseDecisions(`Rule.\n${longest}`).problems, []);
  assert.ok(longest.length <= DEFAULTS.docs.wrapLimit, `${longest.length} characters`);
  const longOld = old(`${'word '.repeat(60)}end`);
  assert.deepEqual(findWrapViolations(`Rule.\n${longest}\n  ${longOld}\n`, 60), []);
  const prose = `The rule says <!-- aidrian:decision is a marker --> and ${'word '.repeat(30)}end`;
  assert.deepEqual(findWrapViolations(prose, 60).map(({ line }) => line), [1], 'prose that mentions one is still prose');
  assert.deepEqual(findWrapViolations(`<!-- aidrian:decision id=open ${'word '.repeat(30)}end`, 60).map(({ line }) => line), [1], 'an unclosed comment is no marker');
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
  assert.match(skill, /That push moves the head: it comes before the review of the new head, or the report says it did not\./u);
  assert.ok(Buffer.byteLength(skill) <= 7500, `${Buffer.byteLength(skill)} bytes`);
  const rule = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/knowledge/references/decisions.md'), 'utf8');
  assert.match(rule, /A writer on a branch whose pull request already exists writes the real number\./u);
  assert.doesNotMatch(skill, /grep '\^\+<!--/u, 'the parser reads the markers, not a grep');
  const template = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/pr-write/references/body-template.md'), 'utf8');
  assert.match(template, /replaces a written rule \| fills a gap/u);
  assert.match(template, /`hasOldWording`/u);
  assert.match(template, /a bullet shows the status when it is not `unconfirmed`/iu);
});
