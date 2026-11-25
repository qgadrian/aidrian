import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { consequenceLines, judgeResiduals, pairResiduals, residualItems, supersededAdr } from '../plugins/aidrian/lib/decisions.mjs';
import { LOCKED } from '../plugins/aidrian/lib/jsonl.mjs';
import { markKept, recordHash, residualHash, saveVerdicts, VERDICTS_FILE, withKept } from '../plugins/aidrian/lib/residual-verdicts.mjs';
import { cliCall } from './cli-call.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');

const RULE = 'Refunds open for 14 days after the order.';
const MARKER = '<!-- aidrian:decision id=refund-window status=unconfirmed class=product-behaviour domain=product date=2026-11-01 pr=none -->';
const NEW = `<!-- aidrian:decision-new id=refund-window text=${JSON.stringify(RULE)} -->`;
// docs/a.md: the rule on line 3, its marker on line 4.
const DOC = `# Refunds\n\n${RULE}\n${MARKER}\n${NEW}\n`;
const ADR = '# 1. Offer window\n\n## Context\n\nOffers expire.\n\n## Consequences\n\n- An offer closes after 7 days.\n- A closed offer cannot be reopened.\n';
const CONTRADICTING = 'Refunds close after 3 days: the longer window needs a job we do not run.';
const CLEAN = 'The refund email has no logo: the asset is not ready.';
const body = (section = 'Accepted residuals', items = [CONTRADICTING, CLEAN]) =>
  `## Summary\n\nA change.\n\n## ${section}\n\n${items.map((each) => `- ${each}`).join('\n')}\n`;

// A project folder indexing docs/a.md, with docs/adr/0001-offer-window.md unless `adr` is false.
function project(t, { adr = true, config = { version: 1 }, folder = true } = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-residuals-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, 'docs'));
  if (folder) {
    mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
    const docs = { 'a.md': { summary: 'refund rules', tags: [] }, ...(adr ? { 'adr/0001-offer-window.md': { summary: 'offer window', tags: [] } } : {}) };
    writeFileSync(path.join(dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs }));
  }
  writeFileSync(path.join(dir, 'docs/a.md'), DOC);
  if (adr) {
    mkdirSync(path.join(dir, 'docs/adr'));
    writeFileSync(path.join(dir, 'docs/adr/0001-offer-window.md'), ADR);
    writeFileSync(path.join(dir, 'docs/adr/notes.txt'), '## Consequences\n\n- not an ADR\n');
  }
  const write = (name, content) => {
    const file = path.join(dir, name);
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return file;
  };
  return { dir, write };
}
const run = (args, cwd) => spawnSync(CLI, ['decisions', 'residuals', ...args], { cwd, encoding: 'utf8' });
const row = (residual, contradicts = null, evidence) => ({ residual, contradicts, ...(evidence === undefined ? {} : { evidence }) });

test('residualItems reads the section items, null with no section and [] with an empty one', () => {
  assert.equal(residualItems('## Summary\n\nText.\n'), null);
  assert.deepEqual(residualItems('## Accepted residuals\n\n## Tests run\n'), []);
  const items = residualItems('## Accepted residuals\n\n- One,\n  wrapped.\n- Two.\n\n```md\n## Accepted residuals\n- quoted\n```\n');
  assert.deepEqual(items.map(({ text }) => text), ['- One, wrapped.', '- Two.']);
  assert.deepEqual(residualItems('## Known gaps\n\n- A gap.\n', 'Known gaps').map(({ first }) => first), ['A gap.']);
});

test('consequenceLines keeps 1-based lines of each Consequences section, skipping fences and blank lines', () => {
  const text = ['# ADR', '', '## Consequences', '', '- One.', '```md', '## Consequences', '- fenced', '```', '  - Two.  ', '## Status', '', 'Accepted.', '## Consequences', 'Three.'].join('\n');
  assert.deepEqual(consequenceLines(text), [{ line: 5, text: '- One.' }, { line: 10, text: '- Two.' }, { line: 15, text: 'Three.' }]);
  assert.deepEqual(consequenceLines('# ADR\n\n```\n## Consequences\n- fenced\n```\n'), []);
  assert.deepEqual(consequenceLines('# ADR\r\n\r\n## Consequences\r\n\r\n- One.\r\n'), [{ line: 5, text: '- One.' }]);
});

test('supersededAdr reads the first line of the Status section', () => {
  assert.equal(supersededAdr('# 1. X\n\n## Status\n\nSuperseded by [0002](0002-y.md).\n\n## Consequences\n\n- A.\n'), true);
  assert.equal(supersededAdr('# 1. X\n\n## Status\n\nAccepted. Supersedes [0001](0001-x.md).\n'), false);
  assert.equal(supersededAdr('# 1. X\n\n## Context\n\nSuperseded by nothing.\n'), false, 'only the Status section counts');
  assert.equal(supersededAdr('# 1. X\n\n## Status\n\n```\nSuperseded\n```\nAccepted.\n'), false, 'a fenced line is a quote');
  assert.equal(supersededAdr('# 1. X\r\n\r\n## Status\r\n\r\nsuperseded by 0003\r\n'), true);
});

test('a superseded ADR is left out of the pairing, and a note names it', (t) => {
  const { dir, write } = project(t);
  const index = path.join(dir, '.aidrian/knowledge/10-docs.json');
  const indexed = JSON.parse(readFileSync(index, 'utf8'));
  indexed.docs['adr/0000-old-window.md'] = { summary: 'old window', tags: [] };
  writeFileSync(index, JSON.stringify(indexed));
  writeFileSync(path.join(dir, 'docs/adr/0000-old-window.md'), '# 0. Old window\n\n## Status\n\nSuperseded by [0001](0001-offer-window.md).\n\n## Consequences\n\n- An offer never closes.\n');
  const file = write('body.md', body());
  const out = run(['--body', file], dir);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /never closes|adr docs\/adr\/0000/u);
  assert.match(out.stdout, /^adr docs\/adr\/0001-offer-window\.md:9: /mu);
  assert.match(out.stdout, /^note\tskipped superseded ADR docs\/adr\/0000-old-window\.md$/mu);
  const json = JSON.parse(run(['--body', file, '--json'], dir).stdout);
  assert.deepEqual(json.notes, ['skipped superseded ADR docs/adr/0000-old-window.md']);
  assert.ok(json.adrs.length > 0 && json.adrs.every(({ path: adr }) => adr === 'docs/adr/0001-offer-window.md'));
});

test('pairResiduals lists the record once and sets every residual beside it', () => {
  const items = [{ text: '- A.', first: 'A.' }, { text: '- B.', first: 'B.' }];
  const decisions = [
    { id: 'one', status: 'unconfirmed', newWording: 'Rule one.', doc: 'docs/a.md', line: 4, class: 'copy' },
    { id: 'two', status: 'confirmed', newWording: null, doc: 'docs/b.md', line: 9 },
  ];
  const adrs = [{ path: 'docs/adr/0001.md', lines: [{ line: 7, text: '- X.' }] }, { path: 'docs/adr/0002.md', lines: [] }];
  assert.deepEqual(pairResiduals(items, decisions, adrs), {
    decisions: [
      { id: 'one', status: 'unconfirmed', wording: 'Rule one.', doc: 'docs/a.md', line: 4 },
      { id: 'two', status: 'confirmed', wording: 'wording at docs/b.md:9', doc: 'docs/b.md', line: 9 },
    ],
    adrs: [{ path: 'docs/adr/0001.md', line: 7, text: '- X.' }],
    residuals: [
      { n: 1, residual: '- A.' },
      { n: 2, residual: '- B.' },
    ],
  });
  assert.deepEqual(pairResiduals(items, [], []), { decisions: [], adrs: [], residuals: [{ n: 1, residual: '- A.' }, { n: 2, residual: '- B.' }] });
  const rejected = pairResiduals(items, [{ ...decisions[0], status: 'rejected' }], []);
  assert.deepEqual(rejected.decisions, [], 'a rejected decision is no rule, so it is off the record');
});

// A record the size of a large project's: 80 decisions and 4,000 ADR consequence lines over 100 ADRs.
function largeRecord() {
  const decisions = Array.from({ length: 80 }, (_, i) => ({ id: `rule-${i}`, status: 'confirmed', newWording: `Rule ${i} holds for every order.`, doc: 'docs/a.md', line: i + 1 }));
  const adrs = Array.from({ length: 100 }, (_, a) => ({
    path: `docs/adr/${String(a).padStart(4, '0')}-topic${a}.md`,
    lines: Array.from({ length: 40 }, (_, l) => ({ line: l + 10, text: `- Consequence ${a}-${l} keeps topic ${a} stable.` })),
  }));
  return { decisions, adrs };
}

test('the record is listed once, so the pairing grows with the residuals plus the record, not their product', () => {
  const { decisions, adrs } = largeRecord();
  const residual = (i) => ({ text: `- Residual ${i}: this stays as it is for now.` });
  const size = (count) => JSON.stringify(pairResiduals(Array.from({ length: count }, (_, i) => residual(i)), decisions, adrs), null, 2).length;
  const [one, five, ten] = [size(1), size(5), size(10)];
  const perResidual = (ten - five) / 5;
  assert.ok(perResidual < 200, `each residual adds ${perResidual} bytes: it repeats no part of the record`);
  assert.ok(five - one < 1_000, `four more residuals add ${five - one} bytes to a ${one}-byte record`);
  const paired = pairResiduals([residual(1), residual(2)], decisions, adrs);
  assert.deepEqual([paired.decisions.length, paired.adrs.length], [80, 4000], 'every decision and every ADR line, once, none capped');
});

test('judgeResiduals lists contradictions with their place and every invalid row', () => {
  const pairs = pairResiduals([{ text: '- A.' }, { text: '- B.' }], [{ id: 'one', status: 'unconfirmed', newWording: 'R.', doc: 'docs/a.md', line: 4 }],
    [{ path: 'docs/adr/0001.md', lines: [{ line: 7, text: '- X.' }] }]);
  const [pair] = pairs.residuals;
  const only = (...residuals) => ({ ...pairs, residuals });
  assert.deepEqual(judgeResiduals(pairs, [row('- A.', 'one', 'R.'), row(' - B. ', 'docs/adr/0001.md:7', '- X.')]), {
    contradictions: [
      { residual: '- A.', contradicts: 'one', evidence: 'R.', place: 'docs/a.md:4' },
      { residual: '- B.', contradicts: 'docs/adr/0001.md:7', evidence: '- X.', place: 'docs/adr/0001.md:7' },
    ],
    invalid: [],
  });
  assert.deepEqual(judgeResiduals(pairs, [row('- A.'), row('- B.', null, 'anything')]), { contradictions: [], invalid: [] });
  assert.deepEqual(judgeResiduals(pairs, { rows: [] }), { contradictions: [], invalid: ['the judged file holds no rows: write { "record": ..., "rows": [...] }'] });
  const invalid = (rows) => judgeResiduals(pairs, rows).invalid;
  assert.deepEqual(invalid([row('- A.', 'one'), row('- B.')]), ['residual "- A." contradicts "one" with no quoted evidence']);
  assert.deepEqual(invalid([row('- A.', 'one', '  '), row('- B.')]), ['residual "- A." contradicts "one" with no quoted evidence']);
  assert.deepEqual(invalid([row('- A.')]), ['residual "- B." has no row']);
  assert.deepEqual(invalid([row('- A.'), row('- A.'), row('- B.')]), ['residual "- A." has 2 rows: one is owed']);
  assert.deepEqual(invalid([row('- A.', 'no-such-id', 'x'), row('- B.')]), ['residual "- A." contradicts "no-such-id", which is no decision id and no ADR path:line on record']);
  assert.deepEqual(invalid([row('- A.', 'docs/adr/0001.md:8', 'x'), row('- B.')]),
    ['residual "- A." contradicts "docs/adr/0001.md:8", which is no decision id and no ADR path:line on record'], 'only a listed line counts');
  assert.deepEqual(invalid([row('- A.'), row('- B.'), row('- C.')]), ['row "- C." names no residual of the body']);
  assert.deepEqual(invalid([row('- A.', ''), row('- B.')]), ['row "- A.": contradicts is null or the id of a decision or ADR line'], 'one mistake, one line');
  assert.deepEqual(invalid([row('- A.', 7), row('- B.')]), ['row "- A.": contradicts is null or the id of a decision or ADR line']);
  assert.deepEqual(invalid([row('- A.'), row('- B.'), 'text']), ['row "" names no residual of the body']);
  assert.deepEqual(invalid([row('- A.', ' one ', 'R.'), row('- B.')]), [], 'contradicts compares trimmed');
  assert.deepEqual(judgeResiduals(only(pair, pair, { ...pair, residual: '- B.' }), [row('- A.'), row('- B.')]).invalid,
    ['residual "- A." is in the body 2 times: merge them, or tell them apart'], 'one row per residual cannot tell two copies apart');
  const twice = pairResiduals([{ text: '- A.' }], [{ id: 'one', status: 'unconfirmed', newWording: 'R.', doc: 'docs/a.md', line: 4 },
    { id: 'one', status: 'confirmed', newWording: 'S.', doc: 'docs/b.md', line: 2 }], []);
  assert.deepEqual(judgeResiduals(twice, [row('- A.', 'one', 'R.')]), { contradictions: [], invalid: ['residual "- A." contradicts "one", an ambiguous id: 2 markers hold it'] });
  const long = `- ${'x'.repeat(80)}`;
  assert.deepEqual(judgeResiduals(only({ ...pair, residual: long }), []).invalid, [`residual "${long.slice(0, 60)}…" has no row`]);
});

test('residuals --body lists the record once and each residual against it, and says judgment is owed', (t) => {
  const { dir, write } = project(t);
  const out = run(['--body', write('body.md', body())], dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(out.stdout.match(/^residual \d: /gmu).length, 2);
  assert.match(out.stdout, new RegExp(`^residual 1: - ${CONTRADICTING}$`, 'mu'));
  assert.equal(out.stdout.match(/^decision refund-window /gmu).length, 1, 'each decision once');
  assert.match(out.stdout, new RegExp(`^decision refund-window unconfirmed docs/a\\.md:4: ${RULE}$`, 'mu'));
  assert.equal(out.stdout.match(/^adr docs\/adr\/0001-offer-window\.md:9: - An offer closes after 7 days\.$/gmu).length, 1, 'each ADR line once');
  assert.match(out.stdout, /^adr docs\/adr\/0001-offer-window\.md:10: - A closed offer cannot be reopened\.$/mu);
  assert.doesNotMatch(out.stdout, /not an ADR/u, 'only *.md files are read');
  assert.match(out.stdout, /\njudgment owed: product-manager returns one row per residual, \{ residual, contradicts, evidence \}\n$/u);

  const json = run(['--body', path.join(dir, 'body.md'), '--json'], dir);
  assert.equal(json.status, 0);
  assert.ok(json.stdout.split('\n').length > 10, 'pretty-printed, so a long listing reads in parts');
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(parsed.residuals, [{ n: 1, residual: `- ${CONTRADICTING}` }, { n: 2, residual: `- ${CLEAN}` }]);
  assert.deepEqual(parsed.decisions.map(({ id }) => id), ['refund-window']);
  assert.deepEqual(parsed.adrs.map(({ path: file, line }) => `${file}:${line}`), ['docs/adr/0001-offer-window.md:9', 'docs/adr/0001-offer-window.md:10']);
  assert.deepEqual([parsed.section, parsed.adrFolder, parsed.nothing, parsed.notes], ['Accepted residuals', 'docs/adr', false, []]);
});

test('--residual lists one residual and --path every line in scope; an --residual out of range fails, on an empty body too', (t) => {
  const { dir, write } = project(t);
  const many = Array.from({ length: 60 }, (_, i) => `- A closed bid is terminal, case ${i}.`).join('\n');
  writeFileSync(path.join(dir, 'docs/adr/0002-bids.md'), `# 2. Bids\n\n## Consequences\n\n${many}\n`);
  const file = write('body.md', body());
  const one = JSON.parse(run(['--body', file, '--residual', '2', '--json'], dir).stdout);
  assert.deepEqual(one.residuals, [{ n: 2, residual: `- ${CLEAN}` }]);
  assert.deepEqual([one.decisions.length, one.adrs.length], [1, 62], 'the whole record still');
  const scoped = JSON.parse(run(['--body', file, '--path', 'docs/adr/0002-bids.md/', '--json'], dir).stdout);
  assert.deepEqual([scoped.decisions.length, scoped.adrs.length, scoped.residuals.length], [0, 60, 2], 'every line in scope, none capped');
  for (const [text, count] of [[body(), 2], ['## Summary\n\nA change.\n', 0]]) {
    const out = run(['--body', write('range.md', text), '--residual', '3'], dir);
    assert.deepEqual([out.status, out.stdout], [1, ''], `${count} residuals`);
    assert.match(out.stderr, new RegExp(`--residual 3: the body has ${count} residuals`, 'u'));
  }
  const judged = run(['--body', file, '--residual', '1', '--judged', write('judged.json', [])], dir);
  assert.equal(judged.status, 1);
  assert.match(judged.stderr, /--residual and --path narrow the listing; --judged checks the whole record/u);
});

test('a contradicting residual is listed with its decision and exits 1; a clean one is not listed', (t) => {
  const { dir, write } = project(t);
  const file = write('body.md', body());
  const judged = write('judged.json', [row(`- ${CONTRADICTING}`, 'refund-window', RULE), row(`- ${CLEAN}`)]);
  const out = run(['--body', file, '--judged', judged], dir);
  assert.deepEqual([out.status, out.stderr], [1, '']);
  assert.match(out.stdout, new RegExp(`^- ${CONTRADICTING} -> refund-window, docs/a\\.md:4$`, 'mu'));
  assert.doesNotMatch(out.stdout, new RegExp(`${CLEAN}.*->`, 'u'));
  assert.match(out.stdout, /^1 contradiction\(s\), 0 invalid row\(s\)$/mu);

  const adrRow = write('adr.json', [row(`- ${CONTRADICTING}`), row(`- ${CLEAN}`, 'docs/adr/0001-offer-window.md:9', '- An offer closes after 7 days.')]);
  const adr = run(['--body', file, '--judged', adrRow], dir);
  assert.equal(adr.status, 1);
  assert.match(adr.stdout, new RegExp(`^- ${CLEAN} -> docs/adr/0001-offer-window\\.md:9$`, 'mu'));

  const json = run(['--body', file, '--judged', judged, '--json'], dir);
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.stdout).contradictions.map(({ contradicts, place }) => [contradicts, place]), [['refund-window', 'docs/a.md:4']]);
});

test('every invalid row prints invalid and exits 1', (t) => {
  const { dir, write } = project(t);
  const file = write('body.md', body());
  const cases = {
    'no evidence': [row(`- ${CONTRADICTING}`, 'refund-window'), row(`- ${CLEAN}`)],
    'no row': [row(`- ${CONTRADICTING}`)],
    'two rows': [row(`- ${CONTRADICTING}`), row(`- ${CONTRADICTING}`), row(`- ${CLEAN}`)],
    'unknown id': [row(`- ${CONTRADICTING}`, 'no-such-id', RULE), row(`- ${CLEAN}`)],
    'unlisted ADR line': [row(`- ${CONTRADICTING}`, 'docs/adr/0001-offer-window.md:3', 'x'), row(`- ${CLEAN}`)],
  };
  for (const [name, rows] of Object.entries(cases)) {
    const out = run(['--body', file, '--judged', write(`${name}.json`, rows)], dir);
    assert.equal(out.status, 1, name);
    assert.match(out.stdout, /^invalid: /mu, name);
    assert.match(out.stdout, /^0 contradiction\(s\), 1 invalid row\(s\)$/mu, name);
  }
  const broken = run(['--body', file, '--judged', write('broken.json', '[{')], dir);
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /cannot read the judged file .*broken\.json: /u);
});

test('every row null exits 0', (t) => {
  const { dir, write } = project(t);
  const out = run(['--body', write('body.md', body()), '--judged', write('judged.json', [row(`- ${CONTRADICTING}`), row(`- ${CLEAN}`)])], dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(out.stdout, 'no residual contradicts a decision on record\nnote\tno verdict was kept: the judged file does not name the record this run read\n');
});

test('a body with no section, or an empty one, has nothing to check, with --judged too', (t) => {
  const { dir, write } = project(t);
  const judged = write('judged.json', [row('- anything', 'refund-window')]);
  for (const text of ['## Summary\n\nA change.\n', '## Summary\n\nA change.\n\n## Accepted residuals\n\n## Tests run\n\n- npm test\n']) {
    const file = write('body.md', text);
    for (const extra of [[], ['--judged', judged]]) {
      const out = run(['--body', file, ...extra], dir);
      assert.deepEqual([out.status, out.stderr], [0, '']);
      assert.equal(out.stdout, 'nothing to check: the body has no "## Accepted residuals" items\n');
    }
    const json = run(['--body', file, '--json', '--judged', judged], dir);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), { residuals: [], section: 'Accepted residuals', nothing: true, notes: ['nothing to check: the body has no "## Accepted residuals" items'] });
  }
});

test('with no ADR folder the pairing still runs, and says none was found', (t) => {
  const { dir, write } = project(t, { adr: false });
  const out = run(['--body', write('body.md', body())], dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(out.stdout.match(/^adr none found$/gmu).length, 1);
  assert.equal(JSON.parse(run(['--body', path.join(dir, 'body.md'), '--json'], dir).stdout).adrFolder, null);
});

test('--adr reads another folder, and a missing --body or body file fails', (t) => {
  const { dir, write } = project(t, { adr: false });
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(path.join(dir, 'records/0002-x.md'), ADR);
  const file = write('body.md', body());
  const out = run(['--body', file, '--adr', 'records'], dir);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^adr records\/0002-x\.md:9: /mu);
  const none = run([], dir);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /residuals needs --body FILE/u);
  const missing = run(['--body', path.join(dir, 'nope.md')], dir);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /cannot read the body file .*nope\.md: ENOENT/u);
});

test('a repository with no project folder still runs: the record is the ADR lines alone', (t) => {
  const bare = project(t, { folder: false, adr: false });
  const file = bare.write('body.md', body());
  const out = run(['--body', file], bare.dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(out.stdout.match(/^decision none on record$/gmu).length, 1);
  assert.match(out.stdout, /\nnote\tno project folder: no decision on record\nnothing on record: no judgment owed\n$/u);
  const judged = run(['--body', file, '--judged', bare.write('judged.json', [])], bare.dir);
  assert.deepEqual([judged.status, judged.stdout.trim().split('\n').at(-1)], [0, 'nothing on record: no judgment owed'], 'no dispatch is owed, so no row is');
  const json = JSON.parse(run(['--body', file, '--json'], bare.dir).stdout);
  assert.deepEqual([json.nothing, json.notes], [true, ['no project folder: no decision on record', 'nothing on record: no judgment owed']]);

  const withAdr = project(t, { folder: false });
  const paired = run(['--body', withAdr.write('body.md', body())], withAdr.dir);
  assert.equal(paired.status, 0);
  assert.match(paired.stdout, /^adr docs\/adr\/0001-offer-window\.md:9: /mu);
  assert.match(paired.stdout, /\njudgment owed: /u);
});

test('a marker whose class no list holds is still on record, and can be named', (t) => {
  const { dir, write } = project(t, { adr: false });
  const retired = MARKER.replace('refund-window', 'old-window').replace('class=product-behaviour', 'class=retired-kind');
  const rule = 'Old windows stay closed.';
  writeFileSync(path.join(dir, 'docs/a.md'), `${DOC}\n${rule}\n${retired}\n<!-- aidrian:decision-new id=old-window text=${JSON.stringify(rule)} -->\n`);
  const file = write('body.md', body());
  const out = run(['--body', file], dir);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^decision old-window unconfirmed docs\/a\.md:8: wording at docs\/a\.md:8$/mu, 'the parser reads no wording for it, and its id still counts');
  const judged = run(['--body', file, '--judged', write('judged.json', [row(`- ${CONTRADICTING}`, 'old-window', rule), row(`- ${CLEAN}`)])], dir);
  assert.equal(judged.status, 1);
  assert.match(judged.stdout, new RegExp(`^- ${CONTRADICTING} -> old-window, docs/a\\.md:8$`, 'mu'));
});

test('--body, --judged, and --adr are read from the current folder; --project only finds the project', (t) => {
  const { dir, write } = project(t, { adr: false });
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(path.join(dir, 'records/0002-x.md'), ADR);
  write('body.md', body());
  write('judged.json', [row(`- ${CONTRADICTING}`, ' refund-window ', RULE), row(`- ${CLEAN}`)]);
  const name = path.basename(dir);
  const out = run(['--project', name, '--body', `${name}/body.md`, '--adr', `${name}/records`, '--judged', `${name}/judged.json`], path.dirname(dir));
  assert.deepEqual([out.status, out.stderr], [1, '']);
  assert.match(out.stdout, new RegExp(`^- ${CONTRADICTING} -> refund-window, docs/a\\.md:4$`, 'mu'), 'contradicts compares trimmed');
  const pairing = JSON.parse(run(['--project', name, '--body', `${name}/body.md`, '--adr', `${name}/records`, '--json'], path.dirname(dir)).stdout);
  assert.deepEqual([pairing.adrFolder, pairing.adrs[0].path], ['records', 'records/0002-x.md'], 'a folder inside the project is written from its root');
});

test('a record that does not read in full is noted, and never lets an empty pairing say nothing is owed', (t) => {
  const broken = project(t, { adr: false });
  writeFileSync(path.join(broken.dir, '.aidrian/knowledge/10-docs.json'), '{');
  const file = broken.write('body.md', body());
  const out = run(['--body', file, '--judged', broken.write('judged.json', [])], broken.dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^problem\t.*10-docs\.json/mu);
  assert.match(out.stdout, /the decisions and ADRs on record could not all be read/u);
  assert.doesNotMatch(out.stdout, /nothing on record/u);
  const json = JSON.parse(run(['--body', file, '--json'], broken.dir).stdout);
  assert.equal(json.nothing, false);
  assert.ok(json.problems.length > 0 && json.notes.some((note) => /10-docs\.json/u.test(note)), 'the problem is in notes too');

  const withAdr = project(t);
  writeFileSync(path.join(withAdr.dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'a.md': { summary: 'refund rules', tags: [] }, 'gone.md': { summary: 'gone', tags: [] } } }));
  const paired = run(['--body', withAdr.write('body.md', body())], withAdr.dir);
  assert.equal(paired.status, 0, 'with lines on record the judgment still runs');
  assert.match(paired.stdout, /^note\t.*gone\.md/mu);

  const missing = project(t, { adr: false });
  writeFileSync(path.join(missing.dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'gone.md': { summary: 'gone', tags: [] } } }));
  const gone = run(['--body', missing.write('body.md', body())], missing.dir);
  assert.equal(gone.status, 1);
  assert.match(gone.stdout, /^problem\t.*gone\.md/mu);
});

// A project with no decision marker and the offer-window ADR in records/, a folder no knowledge index covers, so the ADR
// lines are the whole record and only `--adr records` reads them. An ADR under an indexed folder that does not read is a
// knowledge problem already.
function adrOnly(t, options) {
  const made = project(t, { adr: false, ...options });
  writeFileSync(path.join(made.dir, 'docs/a.md'), `# Refunds\n\n${RULE}\n`);
  mkdirSync(path.join(made.dir, 'records'));
  writeFileSync(path.join(made.dir, 'records/0001-offer-window.md'), ADR);
  return { ...made, file: made.write('body.md', body()) };
}
const asRoot = { skip: process.getuid?.() === 0 ? 'root reads every file' : false };

test('an ADR that does not read leaves the record partial, never nothing on record', asRoot, (t) => {
  const { dir, file } = adrOnly(t);
  chmodSync(path.join(dir, 'records/0001-offer-window.md'), 0o000);
  const out = run(['--body', file, '--adr', 'records', '--judged', file], dir);
  assert.deepEqual([out.status, out.stderr], [1, '']);
  assert.match(out.stdout, /^problem\trecords\/0001-offer-window\.md\tcannot read the ADR: EACCES$/mu);
  assert.doesNotMatch(out.stdout, /nothing on record/u);
  const json = JSON.parse(run(['--body', file, '--adr', 'records', '--json'], dir).stdout);
  assert.equal(json.nothing, false);
  assert.deepEqual(json.problems, [{ doc: 'records/0001-offer-window.md', line: null, problem: 'cannot read the ADR: EACCES' }]);
  assert.deepEqual(json.notes, ['records/0001-offer-window.md: cannot read the ADR: EACCES']);

  writeFileSync(path.join(dir, 'records/0002-x.md'), ADR);
  const paired = run(['--body', file, '--adr', 'records'], dir);
  assert.equal(paired.status, 0, 'with lines on record the judgment still runs');
  assert.match(paired.stdout, /^note\trecords\/0001-offer-window\.md: cannot read the ADR: EACCES$/mu);

  const bare = adrOnly(t, { folder: false });
  mkdirSync(path.join(bare.dir, 'docs/adr'));
  writeFileSync(path.join(bare.dir, 'docs/adr/0001-offer-window.md'), ADR);
  chmodSync(path.join(bare.dir, 'docs/adr/0001-offer-window.md'), 0o000);
  const alone = JSON.parse(run(['--body', bare.file, '--json'], bare.dir).stdout);
  assert.deepEqual([alone.nothing, alone.problems.map(({ doc }) => doc)], [false, ['docs/adr/0001-offer-window.md']], 'with no project folder too');
});

test('an ADR folder that does not read leaves the record partial, and is no missing --adr folder', asRoot, (t) => {
  const { dir, file } = adrOnly(t);
  const folder = path.join(dir, 'records');
  chmodSync(folder, 0o000);
  const out = run(['--body', file, '--adr', 'records', '--json'], dir);
  const text = run(['--body', file, '--adr', 'records'], dir);
  chmodSync(folder, 0o755);
  assert.deepEqual([out.status, out.stderr], [1, '']);
  const json = JSON.parse(out.stdout);
  assert.deepEqual([json.nothing, json.adrFolder, json.problems], [false, 'records', [{ doc: 'records', line: null, problem: 'cannot read the ADR folder: EACCES' }]]);
  assert.equal(text.status, 1);
  assert.match(text.stdout, /^problem\trecords\tcannot read the ADR folder: EACCES$/mu);
});

test('an ADR folder that is not there, or is a file, is still no ADR on record', (t) => {
  const { dir, file } = adrOnly(t);
  for (const shape of ['missing', 'file']) {
    if (shape === 'file') writeFileSync(path.join(dir, 'docs/adr'), ADR);
    const out = run(['--body', file, '--json'], dir);
    assert.equal(out.status, 0, shape);
    const json = JSON.parse(out.stdout);
    assert.deepEqual([json.nothing, json.adrFolder, json.problems], [true, null, undefined], shape);
  }
});

test('an --adr that is no folder, or a --project with no project, fails; a missing docs/adr does not', (t) => {
  const { dir, write } = project(t, { adr: false });
  const file = write('body.md', body());
  const adr = run(['--body', file, '--adr', path.join(dir, 'nowhere')], dir);
  assert.equal(adr.status, 1);
  assert.match(adr.stderr, /no ADR folder at .*nowhere/u);
  const bare = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-residuals-bare-')));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  const none = run(['--body', file, '--project', bare], dir);
  assert.equal(none.status, 1);
  assert.notEqual(none.stderr, '');
  assert.equal(run(['--body', file], dir).status, 0);
});

test('a rejected decision is off the record', (t) => {
  const { dir, write } = project(t, { adr: false });
  writeFileSync(path.join(dir, 'docs/a.md'), DOC.replace('status=unconfirmed', 'status=rejected'));
  const file = write('body.md', body());
  const out = run(['--body', file], dir);
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /refund-window/u);
  assert.match(out.stdout, /\nnothing on record: no judgment owed\n$/u);
  const judged = run(['--body', file, '--judged', write('judged.json', [row(`- ${CONTRADICTING}`, 'refund-window', RULE), row(`- ${CLEAN}`)])], dir);
  assert.equal(judged.status, 0, 'nothing is owed, so the row is never read');
});

test('a residual the body holds twice is invalid', (t) => {
  const { dir, write } = project(t);
  const file = write('body.md', body('Accepted residuals', [CLEAN, CLEAN]));
  const out = run(['--body', file, '--judged', write('judged.json', [row(`- ${CLEAN}`)])], dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^invalid: residual "- The refund email has no logo: the asset is not ready\." is in the body 2 times: merge them, or tell them apart$/mu);
  assert.match(out.stdout, /^0 contradiction\(s\), 1 invalid row\(s\)$/mu);
});

test('the section config.json github.pullRequest.residuals names is the one read', (t) => {
  const { dir, write } = project(t, { config: { version: 1, github: { pullRequest: { residuals: { section: 'Known gaps', fields: ['why'] } } } } });
  const out = run(['--body', write('body.md', body('Known gaps'))], dir);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.stdout.match(/^residual \d: /gmu).length, 2);
  const other = run(['--body', write('other.md', body())], dir);
  assert.equal(other.stdout, 'nothing to check: the body has no "## Known gaps" items\n');
});

// The verdict store: the residuals a judged run found clean, kept while the residual and the record are unchanged.
const call = (args, cwd) => cliCall(['decisions', 'residuals', ...args], { cwd });
const listed = async (file, dir, ...extra) => JSON.parse((await call(['--body', file, '--json', ...extra], dir)).stdout);
const owedTexts = ({ residuals, owed }) => residuals.filter(({ n }) => owed.includes(n)).map(({ residual }) => residual);
// In an empty repository, with a state folder of the project's own, so a command makes the fewest git calls.
const storeProject = (t, options) => {
  const made = project(t, options);
  if (options?.folder === false) return made;
  writeFileSync(path.join(made.dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: path.join(made.dir, 'state') } }));
  for (const part of ['objects', 'refs']) mkdirSync(path.join(made.dir, '.git', part), { recursive: true });
  writeFileSync(path.join(made.dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  return { ...made, store: path.join(made.dir, 'state/decisions', VERDICTS_FILE) };
};
const THREE = [CLEAN, 'The export has no header: nobody reads it.', 'The menu closes late: the fix needs a redesign.'];
const rowsOf = (items) => items.map((each) => row(`- ${each}`));
const EVERY = 'every residual was judged against this record';

// A judged run whose file names the record the listing before it printed, as the skill writes it.
async function judge({ dir, write }, file, rows, ...extra) {
  const { record } = await listed(file, dir, ...extra);
  return call(['--body', file, '--judged', write('judged.json', { record, rows }), ...extra], dir);
}

// A project whose body holds the three clean residuals, every one judged clean.
async function judgedProject(t, options) {
  const made = storeProject(t, options);
  const file = made.write('body.md', body('Accepted residuals', THREE));
  const judged = await judge(made, file, rowsOf(THREE));
  assert.deepEqual([judged.status, judged.stderr], [0, '']);
  return { ...made, file };
}

test('a first run owes every residual, and a second over the same body and record owes none', async (t) => {
  const { dir, write, store } = storeProject(t);
  const file = write('body.md', body('Accepted residuals', THREE));
  const first = await listed(file, dir);
  assert.deepEqual([first.nothing, first.owed], [false, [1, 2, 3]]);
  assert.ok(first.residuals.every((each) => !Object.hasOwn(each, 'kept')));
  await call(['--body', file, '--judged', write('judged.json', { record: first.record, rows: rowsOf(THREE) })], dir);
  const second = await listed(file, dir);
  assert.deepEqual([second.nothing, second.owed, second.residuals.map(({ kept }) => kept)], [true, [], [true, true, true]]);
  assert.ok(second.notes.includes(EVERY));
  const text = await call(['--body', file], dir);
  assert.equal(text.status, 0);
  assert.match(text.stdout, new RegExp(`^residual 1 \\(kept\\): - ${CLEAN}$`, 'mu'));
  assert.ok(text.stdout.endsWith(`\n${EVERY}\n`));
  assert.doesNotMatch(text.stdout, /judgment owed/u);
  const entry = JSON.parse(readFileSync(store, 'utf8')).kept[0];
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'record', 'residual']);
  assert.ok([entry.residual, entry.record].every((hash) => /^[0-9a-f]{64}$/u.test(hash)), 'two hashes, and no text of the body');
});

test('only a changed residual is owed, and any change to the record makes every residual owed', async (t) => {
  const { dir, write, file } = await judgedProject(t);
  const changed = `${THREE[1].slice(0, -1)}!`;
  assert.deepEqual(owedTexts(await listed(write('changed.md', body('Accepted residuals', [THREE[0], changed, THREE[2]])), dir)), [`- ${changed}`]);
  const everyOwed = async (what, name, text, ...extra) => {
    const at = path.join(dir, name);
    const before = readFileSync(at, 'utf8');
    writeFileSync(at, text);
    assert.deepEqual((await listed(file, dir, ...extra)).owed, [1, 2, 3], what);
    writeFileSync(at, before);
  };
  const adr = 'docs/adr/0001-offer-window.md';
  await everyOwed('an ADR line', adr, ADR.replace('7 days', '8 days'));
  await everyOwed('a decision\'s wording', 'docs/a.md', DOC.replaceAll('14 days', '15 days'));
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(path.join(dir, 'records/0001-offer-window.md'), ADR);
  assert.deepEqual((await listed(file, dir, '--adr', 'records')).owed, [1, 2, 3], 'another ADR folder');
  assert.deepEqual((await listed(file, dir)).owed, [], 'all put back');
});

test('the record hash covers every field of a listed decision and ADR line, and the ADR folder', () => {
  const decision = { id: 'one', status: 'confirmed', wording: 'R.', doc: 'docs/a.md', line: 4 };
  const adr = { path: 'docs/adr/1.md', line: 7, text: '- X.' };
  const hash = ({ decisions = [decision], adrs = [adr], folder = 'docs/adr', texts = [] } = {}) => recordHash({ decisions, adrs }, folder, texts);
  const same = hash();
  assert.equal(hash({ decisions: [{ ...decision, doc: 'docs/b.md', line: 9 }] }), same, 'where a decision sits is no part of the record');
  for (const other of [{ decisions: [{ ...decision, id: 'two' }] }, { decisions: [{ ...decision, status: 'unconfirmed' }] }, { decisions: [{ ...decision, wording: 'R' }] },
    { adrs: [{ ...adr, path: 'docs/adr/2.md' }] }, { adrs: [{ ...adr, line: 8 }] }, { adrs: [{ ...adr, text: '- X' }] }, { adrs: [] }, { decisions: [] },
    { folder: 'docs/decisions' }, { folder: null }, { texts: ['the doc'] }]) assert.notEqual(hash(other), same, JSON.stringify(other));
});

test('a decision with no wording on record is judged from its doc, so a change there makes every residual owed', async (t) => {
  const { dir, write } = storeProject(t);
  const bare = `# Refunds\n\n${RULE}\n${MARKER.replace('status=unconfirmed', 'status=confirmed')}\n`;
  writeFileSync(path.join(dir, 'docs/a.md'), bare);
  const file = write('body.md', body('Accepted residuals', THREE));
  const first = await listed(file, dir);
  assert.equal(first.decisions[0].wording, 'wording at docs/a.md:4');
  await call(['--body', file, '--judged', write('judged.json', { record: first.record, rows: rowsOf(THREE) })], dir);
  assert.deepEqual((await listed(file, dir)).owed, []);
  writeFileSync(path.join(dir, 'docs/a.md'), bare.replace('14 days', '15 days'));
  assert.deepEqual((await listed(file, dir)).owed, [1, 2, 3]);
});

test('a judged run takes rows for the owed residuals alone, and exits over the whole body', async (t) => {
  const { dir, write } = await judgedProject(t);
  const added = 'The footer is grey: the palette is not ready.';
  const grown = write('grown.md', body('Accepted residuals', [...THREE, added]));
  const grew = await listed(grown, dir);
  assert.deepEqual(owedTexts(grew), [`- ${added}`]);
  assert.match((await call(['--body', grown], dir)).stdout, /\njudgment owed for residual 4: product-manager returns one row per residual, /u);
  const none = await call(['--body', grown, '--judged', write('none.json', [])], dir);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /^invalid: residual "- The footer is grey: the palette is not ready\." has no row$/mu);
  assert.match(none.stdout, /^0 contradiction\(s\), 1 invalid row\(s\)$/mu);
  const bad = await call(['--body', grown, '--judged', write('bad.json', [row(`- ${added}`, 'refund-window', RULE)])], dir);
  assert.equal(bad.status, 1, 'one contradiction among kept and new fails the whole body');
  const good = await call(['--body', grown, '--judged', write('good.json', { record: grew.record, rows: [row(`- ${added}`)] })], dir);
  assert.deepEqual([good.status, good.stderr], [0, '']);
  assert.equal(good.stdout, 'no residual contradicts a decision on record\nnote\t3 residuals kept from an earlier judgment of this record\n');
  assert.deepEqual((await listed(grown, dir)).owed, []);
});

test('a contradiction, or a run with an invalid row, is never stored, and a contradiction found later drops what was kept', async (t) => {
  const { dir, write } = storeProject(t);
  const file = write('body.md', body());
  const bad = [row(`- ${CONTRADICTING}`, 'refund-window', RULE), row(`- ${CLEAN}`)];
  const { record } = await listed(file, dir);
  for (const rows of [bad, [row(`- ${CONTRADICTING}`, 'no-such-id', 'x'), row(`- ${CLEAN}`)], [row(`- ${CLEAN}`)]]) {
    assert.equal((await call(['--body', file, '--judged', write('judged.json', { record, rows })], dir)).status, 1);
    assert.deepEqual((await listed(file, dir)).owed, [1, 2], 'a run that does not exit 0 stores nothing');
  }
  assert.equal((await call(['--body', file, '--judged', write('judged.json', { record, rows: rowsOf([CONTRADICTING, CLEAN]) })], dir)).status, 0);
  assert.deepEqual((await listed(file, dir)).owed, []);
  assert.deepEqual((await listed(file, dir, '--rejudge')).owed, [1, 2], '--rejudge ignores the store');
  const unruled = await call(['--body', file, '--judged', write('empty.json', []), '--rejudge'], dir);
  assert.equal(unruled.status, 1, 'with --rejudge a kept residual needs a row of its own');
  assert.equal((await call(['--body', file, '--judged', write('judged.json', bad), '--rejudge'], dir)).status, 1);
  assert.deepEqual(owedTexts(await listed(file, dir)), [`- ${CONTRADICTING}`]);
});

test('withKept adds a clean row for a kept residual with none of its own, and a row given counts', () => {
  const residuals = [{ n: 1, residual: '- A.', kept: true }, { n: 2, residual: '- B.' }];
  assert.deepEqual(withKept([row('- B.')], residuals), [row('- B.'), row('- A.')]);
  const given = [row(' - A. ', 'one', 'R.'), row('- B.')];
  assert.deepEqual(withKept(given, residuals), given);
  assert.deepEqual(withKept({ rows: [] }, residuals), { rows: [] });
  assert.deepEqual(withKept([null, 'text'], residuals), [null, 'text', row('- A.')]);
});

test('a run narrowed with --residual or --path stores nothing and reuses nothing', async (t) => {
  const { dir, write } = storeProject(t);
  const file = write('body.md', body('Accepted residuals', THREE));
  const { record } = await listed(file, dir);
  const judged = write('judged.json', { record, rows: rowsOf(THREE) });
  for (const narrow of [['--path', 'docs/adr'], ['--residual', '1']]) {
    assert.equal((await call(['--body', file, '--judged', judged, ...narrow], dir)).status, 1);
  }
  assert.deepEqual((await listed(file, dir)).owed, [1, 2, 3]);
  await call(['--body', file, '--judged', judged], dir);
  const part = await listed(file, dir, '--path', 'docs/adr');
  assert.deepEqual([part.nothing, part.owed, part.residuals.some(({ kept }) => kept), part.record, part.notes], [false, [1, 2, 3], false, null, []]);
  assert.deepEqual((await listed(file, dir, '--residual', '2')).owed, [2]);
});

// Over `file`, whose three residuals are kept, `what` leaves part of the record unread: nothing is stored or reused, and a note says so.
async function keepsNothing(what, { dir, write, store }, file, ...extra) {
  const held = readFileSync(store, 'utf8');
  const part = await listed(file, dir, ...extra);
  assert.deepEqual([part.owed, part.nothing, part.record], [[1, 2, 3], false, null], what);
  assert.ok(part.notes.length > 1, `${what}: a note says what could not be read`);
  assert.equal(part.notes.at(-1), 'no verdict is kept or reused while the problems noted here stand', what);
  assert.equal((await call(['--body', file, '--judged', write('part.json', { record: part.record, rows: rowsOf(THREE) }), ...extra], dir)).status, 0, what);
  assert.equal(readFileSync(store, 'utf8'), held, `${what}: nothing was stored`);
}

test('while a decision could not be read, or a scan failed, nothing is stored or reused, and a note says so', async (t) => {
  const made = await judgedProject(t);
  const index = path.join(made.dir, '.aidrian/knowledge/10-docs.json');
  const broken = JSON.parse(readFileSync(index, 'utf8'));
  broken.docs['gone.md'] = { summary: 'gone', tags: [] };
  const other = (marker) => `${DOC}\n${marker.replace('refund-window', 'other')}\n`;
  const breaks = [
    ['an indexed doc that is not there', index, JSON.stringify(broken)],
    ['a marker that does not parse', path.join(made.dir, 'docs/a.md'), other(MARKER.replace('status=unconfirmed', 'status=maybe'))],
    ['the wording of a marker whose class no list holds', path.join(made.dir, 'docs/a.md'), other(`${MARKER.replace('class=product-behaviour', 'class=no-such-class')}\n${NEW}`)],
  ];
  for (const [what, at, text] of breaks) {
    const before = readFileSync(at, 'utf8');
    writeFileSync(at, text);
    await keepsNothing(what, made, made.file);
    writeFileSync(at, before);
  }
  rmSync(path.join(made.dir, '.git/HEAD'));
  await keepsNothing('a git scan that failed', made, made.file);
});

test('while an ADR or the ADR folder could not be read, nothing is stored or reused', asRoot, async (t) => {
  const made = storeProject(t);
  const file = made.write('body.md', body('Accepted residuals', THREE));
  const folder = path.join(made.dir, 'records');
  mkdirSync(folder);
  writeFileSync(path.join(folder, '0001-offer-window.md'), ADR);
  assert.equal((await judge(made, file, rowsOf(THREE), '--adr', 'records')).status, 0);
  const unread = path.join(folder, '0002-unread.md');
  writeFileSync(unread, ADR);
  chmodSync(unread, 0o000);
  await keepsNothing('an ADR that does not read', made, file, '--adr', 'records');
  rmSync(unread);
  chmodSync(folder, 0o000);
  await keepsNothing('an ADR folder that does not read', made, file, '--adr', 'records').finally(() => chmodSync(folder, 0o755));
});

test('rows judged against another record exit 1, and rows that name no record keep nothing, as a note says', async (t) => {
  const { dir, write } = storeProject(t);
  const file = write('body.md', body('Accepted residuals', THREE));
  const { record } = await listed(file, dir);
  // A merge from the base branch brings a decision the rows never answered.
  writeFileSync(path.join(dir, 'docs/a.md'), `${DOC}\nEvery export starts with a header row.\n${MARKER.replace('refund-window', 'export-header')}\n`);
  const other = 'note\tno verdict was kept: the judged file does not name the record this run read\n';
  const stale = await call(['--body', file, '--judged', write('judged.json', { record, rows: rowsOf(THREE) })], dir);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /^invalid: the judged file answers another record than this run read: list again, and judge again$/mu);
  assert.match(stale.stdout, /^0 contradiction\(s\), 1 invalid row\(s\)$/mu);
  for (const [what, rows] of [['no record', { rows: rowsOf(THREE) }], ['a null record', { record: null, rows: rowsOf(THREE) }], ['rows alone', rowsOf(THREE)]]) {
    const out = await call(['--body', file, '--judged', write('judged.json', rows)], dir);
    assert.deepEqual([out.status, out.stdout], [0, `no residual contradicts a decision on record\n${other}`], what);
  }
  const later = await listed(file, dir);
  assert.deepEqual(later.owed, [1, 2, 3]);
  assert.notEqual(later.record, record);
  assert.match((await call(['--body', file], dir)).stdout, new RegExp(`^record ${later.record}$`, 'mu'));
});

test('a store that does not read, or holds what the code does not know, keeps nothing, and the run still answers', async (t) => {
  const { dir, write, file, store } = await judgedProject(t);
  const residuals = THREE.map((each, index) => ({ n: index + 1, residual: `- ${each}` }));
  const good = JSON.parse(readFileSync(store, 'utf8'));
  for (const text of ['', '{', '[]', 'null', JSON.stringify({ ...good, version: 2 }), JSON.stringify({ kept: good.kept }), JSON.stringify({ version: 1, kept: true }),
    JSON.stringify({ version: 1, kept: good.kept.map(({ residual }) => ({ residual })) }),
    JSON.stringify({ version: 1, kept: good.kept.map((each) => ({ ...each, residual: { toString: 1 } })) }),
    JSON.stringify({ version: 1, kept: good.kept.map((each) => ({ ...each, record: { toString: 1 } })) }), JSON.stringify({ version: 1, kept: [null, 'x', 7] })]) {
    writeFileSync(store, text);
    assert.deepEqual(markKept(residuals, store, good.kept[0].record), residuals, text);
  }
  writeFileSync(store, '{');
  assert.deepEqual((await listed(file, dir)).owed, [1, 2, 3]);
  rmSync(path.dirname(store), { recursive: true });
  writeFileSync(path.dirname(store), 'a file where the folder goes');
  assert.deepEqual((await listed(file, dir)).owed, [1, 2, 3]);
  const out = await judge({ dir, write }, file, rowsOf(THREE));
  assert.equal(out.status, 0, 'the verdict stands');
  assert.match(out.stdout, /^note\tno verdict was kept: /mu);
});

test('saveVerdicts keeps the newest verdicts, writes only what changes, and never under another record', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-verdicts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'decisions', VERDICTS_FILE);
  const [one, two] = ['a'.repeat(64), 'b'.repeat(64)];
  const residuals = [{ n: 1, residual: '- A.' }];
  const save = (record, extra) => saveVerdicts(store, record, { residuals, rows: [row('- A.')], clean: true, ...extra });
  const saved = { lost: false, problem: null };
  const held = () => JSON.parse(readFileSync(store, 'utf8')).kept;
  assert.deepEqual(save(one, { clean: false, rows: [row('- A.', 'x')] }), saved);
  assert.equal(existsSync(store), false, 'nothing to drop, nothing written');
  save(one, { at: 'first' });
  save(one, { at: 'second' });
  assert.deepEqual(held(), [{ residual: residualHash('- A.'), record: one, at: 'first' }]);
  assert.ok(existsSync(`${store}.lock.3.released`), 'each run took the store\'s lock, and released it');
  save(two);
  assert.equal(markKept(residuals, store, two)[0].kept, true);
  save(one, { clean: false, rows: [row('- A.', 'x')] });
  assert.deepEqual([markKept(residuals, store, one)[0].kept, markKept(residuals, store, two)[0].kept], [undefined, true], 'only that record\'s verdict is dropped');
  const many = Array.from({ length: 1_100 }, (_, i) => `- ${i}.`);
  save(one, { residuals: many.map((residual, i) => ({ n: i + 1, residual })), rows: many.map((residual) => row(residual)) });
  assert.equal(held().length, 1_000);
  assert.equal(held().at(-1).residual, residualHash('- 1099.'));
});

test('a clean run writes only the residuals its rows judged, so it restores none another run dropped meanwhile', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-verdicts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = path.join(dir, 'decisions', VERDICTS_FILE);
  const record = 'a'.repeat(64);
  const residuals = [{ n: 1, residual: '- A.' }, { n: 2, residual: '- B.' }];
  const kept = () => markKept(residuals, store, record).filter((each) => each.kept).map(({ n }) => n);
  saveVerdicts(store, record, { residuals, rows: [row('- A.')], clean: true });
  assert.deepEqual(kept(), [1]);
  // This run read A as kept, and before it saves its row for B another run finds A contradicts a decision.
  saveVerdicts(store, record, { residuals, rows: [row('- A.', 'one', 'R.')], clean: false });
  saveVerdicts(store, record, { residuals, rows: [row('- B.')], clean: true });
  assert.deepEqual(kept(), [2]);
  const marked = residuals.map((each) => ({ ...each, kept: true }));
  const rows = [row('- A.'), row('- B.')];
  assert.deepEqual(saveVerdicts(store, record, { residuals: marked, rows, clean: true }), { lost: false, problem: null }, 'a residual with its own row needs no kept verdict');
  assert.deepEqual(kept(), [1, 2]);
});

test('a clean run whose kept verdict another run dropped before it answered exits 1, with rows to save or none', async (t) => {
  const { dir, write, file, store } = await judgedProject(t);
  const held = readFileSync(store, 'utf8');
  const { record } = JSON.parse(held).kept[0];
  const judged = write('judged.json', '');
  const read = fs.readFileSync;
  // Another run drops every verdict once this one has read the store, as it reads its judged file.
  fs.readFileSync = function readFileSync(name, ...rest) {
    if (name === judged) rmSync(store, { force: true });
    return read.call(this, name, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fs.readFileSync = read;
    syncBuiltinESMExports();
  });
  for (const rows of [{ record, rows: rowsOf(THREE.slice(0, 1)) }, { record, rows: [] }, []]) {
    writeFileSync(store, held);
    writeFileSync(judged, JSON.stringify(rows));
    const out = await call(['--body', file, '--judged', judged], dir);
    assert.equal(out.status, 1, JSON.stringify(rows));
    assert.match(out.stdout, /^invalid: a kept verdict was dropped while this run judged: list again, and judge again$/mu);
    assert.equal(existsSync(store), false, 'nothing is kept from it');
  }
});

// The store's next lock, taken by process `pid` of this machine; `release` lets it go.
function lockHeldBy(pid, store) {
  const next = 1 + Math.max(0, ...fs.readdirSync(path.dirname(store)).map((name) => Number(/\.lock\.(\d+)$/u.exec(name)?.[1] ?? 0)));
  const name = `${realpathSync(path.dirname(store))}/${VERDICTS_FILE}.lock.${next}`;
  writeFileSync(name, JSON.stringify({ pid, host: hostname(), nonce: 'other' }));
  return { name, release: () => writeFileSync(`${name}.released`, '') };
}

// Every wait for a lock ends at once: a pause moves the clock past it.
function skipLockWaits(t) {
  const now = Date.now;
  let ahead = 0;
  t.mock.method(Date, 'now', () => now() + ahead);
  t.mock.method(Atomics, 'wait', () => {
    ahead += 60_000;
    return 'timed-out';
  });
}

// Every way the store's lock cannot be taken, as a function that sets it up and gives the one that takes it down.
const UNWRITABLE = 'a folder that cannot be written';
const NO_LOCK = {
  'held by another run': (t, store) => {
    skipLockWaits(t);
    return lockHeldBy(process.pid, store).release;
  },
  [UNWRITABLE]: (t, store) => {
    chmodSync(path.dirname(store), 0o555);
    return () => chmodSync(path.dirname(store), 0o755);
  },
  'a lock that cannot be created': (t, store) => {
    const write = fs.writeFileSync;
    const swap = (fn) => {
      fs.writeFileSync = fn;
      syncBuiltinESMExports();
    };
    swap((name, ...rest) => {
      if (String(name).includes(`${path.basename(store)}.lock.`)) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return write(name, ...rest);
    });
    return () => swap(write);
  },
};

// A store that holds a verdict of each of THREE, and `save`, which takes a judged run's rows into it.
function heldStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-verdicts-'));
  const store = path.join(dir, 'decisions', VERDICTS_FILE);
  const residuals = THREE.map((each, index) => ({ n: index + 1, residual: `- ${each}`, kept: true }));
  const save = (rows, options) => saveVerdicts(store, 'a'.repeat(64), { residuals, rows, clean: true, ...options });
  save(rowsOf(THREE));
  const before = readFileSync(store, 'utf8');
  return { dir, store, save, before };
}

for (const [what, unlockable] of Object.entries(NO_LOCK)) {
  test(`with no store lock, a run that needs a kept verdict fails, and one with rows of its own answers: ${what}`, what === UNWRITABLE ? asRoot : {}, (t) => {
    const { dir, store, save, before } = heldStore();
    const undo = unlockable(t, store);
    t.after(() => {
      undo();
      rmSync(dir, { recursive: true, force: true });
    });
    const tryAgain = { code: LOCKED, message: /^the kept verdicts cannot be checked, so run this again, or list and judge with --rejudge: \S/u };
    assert.throws(() => save([]), tryAgain, 'every row from the store');
    assert.throws(() => save(rowsOf(THREE.slice(0, 1))), tryAgain, 'some rows from the store');
    assert.throws(() => save(rowsOf(THREE.slice(0, 1)), { named: false }), tryAgain, 'rows alone, with no record');
    for (const [rows, clean] of [[rowsOf(THREE), true], [[row(`- ${THREE[0]}`, 'refund-window', RULE)], false]]) {
      const { lost, problem } = save(rows, { clean });
      assert.deepEqual([lost, typeof problem], [false, 'string'], `its own rows, clean ${clean}`);
    }
    assert.equal(readFileSync(store, 'utf8'), before, 'and no run wrote anything');
    undo();
    assert.deepEqual(save([]), { lost: false, problem: null }, 'the same run answers once the lock can be taken');
  });
}

test('a released lock, one whose process is gone, and none at all stop no run', (t) => {
  const { dir, store, save, before } = heldStore();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const answers = (why) => assert.deepEqual(save([]), { lost: false, problem: null }, why);
  lockHeldBy(process.pid, store).release();
  answers('released');
  lockHeldBy(2 ** 31 - 1, store);
  answers('its process no longer runs');
  rmSync(path.dirname(store), { recursive: true });
  mkdirSync(path.dirname(store));
  writeFileSync(store, before);
  answers('no lock was ever taken');
});

test('a judged run in a folder it may not write prints no verdict when it needs a kept one, and else answers with a note', asRoot, async (t) => {
  let open = () => {};
  // Registered first, so it runs before the project's folder is deleted.
  t.after(() => open());
  const { dir, write, file, store } = await judgedProject(t);
  const judged = (rows, ...extra) => call(['--body', file, '--judged', write('judged.json', rows), ...extra], dir);
  open = () => chmodSync(path.dirname(store), 0o755);
  chmodSync(path.dirname(store), 0o555);
  const needs = await judged([]);
  assert.deepEqual([needs.status, needs.stdout], [1, '']);
  assert.match(needs.stderr, /^the kept verdicts cannot be checked, .* --rejudge: EACCES: .*\n$/u);
  const { record } = JSON.parse(readFileSync(store, 'utf8')).kept[0];
  const own = await judged({ record, rows: rowsOf(THREE) }, '--rejudge');
  assert.deepEqual([own.status, own.stderr], [0, '']);
  assert.match(own.stdout, /^no residual contradicts a decision on record\n(?:.*\n)*note\tno verdict was kept: EACCES: /u);
  const against = await judged([row(`- ${THREE[0]}`, 'refund-window', RULE)]);
  assert.deepEqual([against.status, against.stderr], [1, '']);
  assert.match(against.stdout, /^note\tan earlier verdict may still be kept, so list with --rejudge: EACCES: /mu);
});

test('a residual the body holds twice is never kept, and with no project folder nothing is', async (t) => {
  const { dir, write } = await judgedProject(t);
  assert.deepEqual((await listed(write('twice.md', body('Accepted residuals', [CLEAN, CLEAN])), dir)).owed, [1, 2]);
  const bare = project(t, { folder: false });
  const file = bare.write('body.md', body('Accepted residuals', THREE));
  assert.equal((await call(['--body', file, '--judged', bare.write('judged.json', rowsOf(THREE))], bare.dir)).status, 0);
  assert.deepEqual((await listed(file, bare.dir)).owed, [1, 2, 3]);
});

test('pr-write runs the residuals check before the body ships, and the docs say what is judged', () => {
  const read = (file) => readFileSync(path.join(ROOT, file), 'utf8').replace(/\s+/gu, ' ');
  const skill = read('plugins/aidrian/skills/pr-write/SKILL.md');
  assert.match(skill, /\*\*Residuals\.\*\*.*references\/residuals\.md/u);
  assert.match(skill, /- `aidrian decisions residuals` does not exit 0 after one fix round;/u);
  const step = read('plugins/aidrian/skills/pr-write/references/residuals.md');
  assert.match(step, /aidrian decisions residuals --body <file> --json/u);
  assert.match(step, /Dispatch `product-manager`/u);
  assert.match(step, /--judged/u);
  assert.match(step, /the body ships only then/u);
  assert.match(step, /`residual_rows`/u);
  assert.match(step, /a `rejected` one is no rule, so the command leaves it out/u);
  assert.match(step, /nothing on record: no judgment owed/u);
  for (const text of [step, read('docs/review.md')]) assert.match(text, /Deleting the bullet while the defect still ships is never a fix/iu);
  assert.match(read('plugins/aidrian/skills/pr-write/references/body-template.md'), /never delete the bullet alone while the defect ships/u);
  assert.match(read('docs/config.md'), /`aidrian decisions list`, `set`, `undo`, and `residuals` read it from the working copy/u);
  assert.match(read('docs/config.md'), /`aidrian decisions residuals` reads `residuals\.section` too/u);
  assert.match(read('docs/project-folder.md'), /`aidrian decisions residuals` sets a pull request body's accepted residuals against these markers/u);
  assert.match(read('plugins/aidrian/skills/knowledge/references/handoff.md'), /- `residual_rows` \(`product-manager`.*? per owed residual\./u);
  assert.match(step, /every residual was judged against this record/u);
  assert.match(step, /the owed residuals alone/u);
  assert.match(step, /another `record` than the run reads exits 1: run step 1 again, and judge again/u);
  assert.match(step, /`\{ "record": <step 1's record>, "rows": \[\.\.\.\] \}`.*`aidrian decisions residuals --body <file> --judged <that file>`, with the same `--adr <folder>` as step 1/u);
  assert.match(step, /An exit 1 that says `the kept verdicts cannot be checked` judged nothing: run the same command again/u);
  assert.match(step, /never reworded on this branch to make a residual pass/u);
  assert.match(step, /one line of why stays in the body/u);
  assert.match(step, /an ADR whose Status starts `Superseded` is skipped/iu);
  for (const text of [step, read('docs/review.md')]) for (const flag of ['`--residual <n>`', '`--path <doc or folder>`']) assert.ok(text.includes(flag), flag);
  assert.match(read('plugins/aidrian/skills/pr-write/references/body-template.md'), /\(`aidrian decisions residuals`\)/u);
  const review = read('docs/review.md');
  assert.match(review, /an ADR whose Status starts `Superseded` skipped with a note/u);
  assert.match(review, /never reworded on the branch to let a residual pass/u);
  assert.match(review, /### Accepted residuals against decisions .*`github\.pullRequest\.residuals\.section`.*`aidrian decisions residuals --body <file>`.*`nothing on record: no judgment owed`.* `product-manager` returns one row per residual.*`residual -> path:line`/u);
  assert.ok(review.indexOf('### Product feedback in the rounds') < review.indexOf('### Accepted residuals against decisions'));
  assert.ok(review.indexOf('### Accepted residuals against decisions') < review.indexOf('### Out of quota'));
  assert.match(read('README.md'), /\| `aidrian decisions residuals` \|/u);
});
