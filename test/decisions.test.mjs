import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { slug } from '../plugins/aidrian/lib/review/flows.mjs';
import { anchorSlug, DECISION_DOMAINS, decisionClasses, decisionWarnings, loadVocab, lowerMode, resolveAuthority } from '../plugins/aidrian/lib/decisions.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FLOOR = ['security', 'critical-flow', 'money', 'data-loss', 'unknown'];
const ORDINARY = ['copy', 'layout', 'ordering', 'default-value', 'naming', 'module-boundary', 'backlog-rank'];
const NO = { storedData: false, external: false, pricingOrContract: false, visibleBeforeReview: false };

// DEFAULTS with `changes` over its `decisions`, for a team that opted in with a higher ceiling; nested keys are given whole.
const config = (changes = {}) => ({ decisions: { ...DEFAULTS.decisions, maxMode: 'decide-reversible', ...changes } });
const open = config({ mode: 'decide-reversible' });
const question = (changes = {}) => ({ domain: 'ux', class: 'copy', reversible: NO, ...changes });

test('decisions.json is the class list: floor classes first, every class and question defined in one line', () => {
  const { classes, reversibility } = loadVocab();
  assert.deepEqual(decisionClasses(), [...FLOOR, ...ORDINARY]);
  assert.deepEqual(classes.filter((each) => each.floor).map((each) => each.class), FLOOR);
  assert.deepEqual(Object.keys(reversibility), ['storedData', 'external', 'pricingOrContract', 'visibleBeforeReview']);
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

test('a section matches by its heading\'s slug, as the review\'s sectionOf reads it, and that slug is the review\'s', () => {
  const listed = config({ mode: 'decide-reversible', escalateDocs: ['docs/terms.md#Refund-Policy'] });
  for (const doc of ['docs/terms.md#refund-policy', 'docs/terms.md#Refund Policy', 'docs/terms.md#refund  policy!', 'docs/terms.md#!!!']) {
    assert.deepEqual(pick(resolveAuthority(listed, question({ docs: [doc] }))), ['ask', 'escalate-doc'], doc);
  }
  assert.deepEqual(pick(resolveAuthority(listed, question({ docs: ['docs/terms.md#refund-policy-1'] }))), ['decide', 'mode']);
  for (const text of ['Refund Policy', ' -Mixed  CASE- ', 'café: déjà-vu!', 'a_b.c', '--', '', 'Año 2026 (nuevo)']) assert.equal(anchorSlug(text), slug(text), text);
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

test('check warns only when remind is off and the pause is null', () => {
  const warned = (unreviewed) => decisionWarnings(config({ unreviewed }));
  assert.deepEqual(decisionWarnings(DEFAULTS), []);
  assert.deepEqual(warned({ remind: 'off', pauseDomainAt: { pending: 1, oldestDays: 1 } }), []);
  assert.deepEqual(warned({ remind: 'session-start', pauseDomainAt: null }), []);
  assert.equal(warned({ remind: 'off', pauseDomainAt: null }).length, 1);
  assert.match(warned({ remind: 'off', pauseDomainAt: null })[0], /"remind" is "off" and "pauseDomainAt" is null/u);
});

const pick = ({ authority, rule }) => [authority, rule];
