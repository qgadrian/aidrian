import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { consequenceLines, judgeResiduals, pairResiduals, residualItems, supersededAdr } from '../plugins/aidrian/lib/decisions.mjs';

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
  assert.match(out.stdout, /^ {2}adr docs\/adr\/0001-offer-window\.md:9: /mu);
  assert.match(out.stdout, /^note\tskipped superseded ADR docs\/adr\/0000-old-window\.md$/mu);
  const json = JSON.parse(run(['--body', file, '--json'], dir).stdout);
  assert.deepEqual(json.notes, ['skipped superseded ADR docs/adr/0000-old-window.md']);
  assert.ok(json.residuals.every((pair) => pair.adrs.every(({ path: adr }) => adr === 'docs/adr/0001-offer-window.md')));
});

test('pairResiduals sets every residual beside the whole record', () => {
  const items = [{ text: '- A.', first: 'A.' }, { text: '- B.', first: 'B.' }];
  const decisions = [
    { id: 'one', status: 'unconfirmed', newWording: 'Rule one.', doc: 'docs/a.md', line: 4, class: 'copy' },
    { id: 'two', status: 'confirmed', newWording: null, doc: 'docs/b.md', line: 9 },
  ];
  const adrs = [{ path: 'docs/adr/0001.md', lines: [{ line: 7, text: '- X.' }] }, { path: 'docs/adr/0002.md', lines: [] }];
  const pairs = pairResiduals(items, decisions, adrs);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs[1], {
    residual: '- B.',
    decisions: [
      { id: 'one', status: 'unconfirmed', wording: 'Rule one.', doc: 'docs/a.md', line: 4 },
      { id: 'two', status: 'confirmed', wording: 'wording at docs/b.md:9', doc: 'docs/b.md', line: 9 },
    ],
    adrs: [{ path: 'docs/adr/0001.md', line: 7, text: '- X.' }],
  });
  assert.deepEqual(pairResiduals(items, [], []).map(({ decisions: d, adrs: a }) => [d, a]), [[[], []], [[], []]]);
  const rejected = pairResiduals(items, [{ ...decisions[0], status: 'rejected' }], []);
  assert.deepEqual(rejected[0].decisions, [], 'a rejected decision is no rule, so it is off the record');
});

test('judgeResiduals lists contradictions with their place and every invalid row', () => {
  const [pair] = pairResiduals([{ text: '- A.' }, { text: '- B.' }], [{ id: 'one', status: 'unconfirmed', newWording: 'R.', doc: 'docs/a.md', line: 4 }],
    [{ path: 'docs/adr/0001.md', lines: [{ line: 7, text: '- X.' }] }]);
  const pairs = [pair, { ...pair, residual: '- B.' }];
  assert.deepEqual(judgeResiduals(pairs, [row('- A.', 'one', 'R.'), row(' - B. ', 'docs/adr/0001.md:7', '- X.')]), {
    contradictions: [
      { residual: '- A.', contradicts: 'one', evidence: 'R.', place: 'docs/a.md:4' },
      { residual: '- B.', contradicts: 'docs/adr/0001.md:7', evidence: '- X.', place: 'docs/adr/0001.md:7' },
    ],
    invalid: [],
  });
  assert.deepEqual(judgeResiduals(pairs, [row('- A.'), row('- B.', null, 'anything')]), { contradictions: [], invalid: [] });
  assert.deepEqual(judgeResiduals(pairs, { rows: [] }), { contradictions: [], invalid: ['the judged file is not a JSON array of rows'] });
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
  assert.deepEqual(judgeResiduals([pair, pair, { ...pair, residual: '- B.' }], [row('- A.'), row('- B.')]).invalid,
    ['residual "- A." is in the body 2 times: merge them, or tell them apart'], 'one row per residual cannot tell two copies apart');
  const twice = pairResiduals([{ text: '- A.' }], [{ id: 'one', status: 'unconfirmed', newWording: 'R.', doc: 'docs/a.md', line: 4 },
    { id: 'one', status: 'confirmed', newWording: 'S.', doc: 'docs/b.md', line: 2 }], []);
  assert.deepEqual(judgeResiduals(twice, [row('- A.', 'one', 'R.')]), { contradictions: [], invalid: ['residual "- A." contradicts "one", an ambiguous id: 2 markers hold it'] });
  const long = `- ${'x'.repeat(80)}`;
  assert.deepEqual(judgeResiduals([{ ...pair, residual: long }], []).invalid, [`residual "${long.slice(0, 60)}…" has no row`]);
});

test('residuals --body lists each residual beside each decision and ADR consequence, and says judgment is owed', (t) => {
  const { dir, write } = project(t);
  const out = run(['--body', write('body.md', body())], dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(out.stdout.match(/^residual: /gmu).length, 2);
  assert.match(out.stdout, new RegExp(`^residual: - ${CONTRADICTING}$`, 'mu'));
  assert.match(out.stdout, new RegExp(`^ {2}decision refund-window unconfirmed docs/a\\.md:4: ${RULE}$`, 'mu'));
  assert.match(out.stdout, /^ {2}adr docs\/adr\/0001-offer-window\.md:9: - An offer closes after 7 days\.$/mu);
  assert.match(out.stdout, /^ {2}adr docs\/adr\/0001-offer-window\.md:10: - A closed offer cannot be reopened\.$/mu);
  assert.doesNotMatch(out.stdout, /not an ADR/u, 'only *.md files are read');
  assert.match(out.stdout, /\njudgment owed: product-manager returns one row per residual, \{ residual, contradicts, evidence \}\n$/u);

  const json = run(['--body', path.join(dir, 'body.md'), '--json'], dir);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.residuals.length, 2);
  for (const pair of parsed.residuals) {
    assert.equal(pair.decisions[0].id, 'refund-window');
    assert.equal(pair.adrs[0].path, 'docs/adr/0001-offer-window.md');
  }
  assert.deepEqual([parsed.section, parsed.adrFolder, parsed.nothing, parsed.notes], ['Accepted residuals', 'docs/adr', false, []]);
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
  assert.equal(out.stdout, 'no residual contradicts a decision on record\n');
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
  assert.equal(out.stdout.match(/^ {2}adr none found$/gmu).length, 2);
  assert.equal(JSON.parse(run(['--body', path.join(dir, 'body.md'), '--json'], dir).stdout).adrFolder, null);
});

test('--adr reads another folder, and a missing --body or body file fails', (t) => {
  const { dir, write } = project(t, { adr: false });
  mkdirSync(path.join(dir, 'records'));
  writeFileSync(path.join(dir, 'records/0002-x.md'), ADR);
  const file = write('body.md', body());
  const out = run(['--body', file, '--adr', 'records'], dir);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^ {2}adr records\/0002-x\.md:9: /mu);
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
  assert.equal(out.stdout.match(/^ {2}decision none on record$/gmu).length, 2);
  assert.match(out.stdout, /\nnote\tno project folder: no decision on record\nnothing on record: no judgment owed\n$/u);
  const judged = run(['--body', file, '--judged', bare.write('judged.json', [])], bare.dir);
  assert.deepEqual([judged.status, judged.stdout.trim().split('\n').at(-1)], [0, 'nothing on record: no judgment owed'], 'no dispatch is owed, so no row is');
  const json = JSON.parse(run(['--body', file, '--json'], bare.dir).stdout);
  assert.deepEqual([json.nothing, json.notes], [true, ['no project folder: no decision on record', 'nothing on record: no judgment owed']]);

  const withAdr = project(t, { folder: false });
  const paired = run(['--body', withAdr.write('body.md', body())], withAdr.dir);
  assert.equal(paired.status, 0);
  assert.match(paired.stdout, /^ {2}adr docs\/adr\/0001-offer-window\.md:9: /mu);
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
  assert.match(out.stdout, /^ {2}decision old-window unconfirmed docs\/a\.md:8: wording at docs\/a\.md:8$/mu, 'the parser reads no wording for it, and its id still counts');
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
  assert.deepEqual([pairing.adrFolder, pairing.residuals[0].adrs[0].path], ['records', 'records/0002-x.md'], 'a folder inside the project is written from its root');
});

test('a record that does not read in full is noted, and never lets an empty pairing say nothing is owed', (t) => {
  const broken = project(t, { adr: false });
  writeFileSync(path.join(broken.dir, '.aidrian/knowledge/10-docs.json'), '{');
  const file = broken.write('body.md', body());
  const out = run(['--body', file, '--judged', broken.write('judged.json', [])], broken.dir);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /^problem\t.*10-docs\.json/mu);
  assert.match(out.stdout, /the decisions on record could not all be read/u);
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
  assert.equal(out.stdout.match(/^residual: /gmu).length, 2);
  const other = run(['--body', write('other.md', body())], dir);
  assert.equal(other.stdout, 'nothing to check: the body has no "## Known gaps" items\n');
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
  assert.match(read('plugins/aidrian/skills/knowledge/references/handoff.md'), /- `residual_rows` \(`product-manager`/u);
  assert.match(step, /never reworded on this branch to make a residual pass/u);
  assert.match(step, /one line of why stays in the body/u);
  assert.match(step, /an ADR whose Status starts `Superseded` is skipped/u);
  assert.match(read('plugins/aidrian/skills/pr-write/references/body-template.md'), /\(`aidrian decisions residuals`\)/u);
  const review = read('docs/review.md');
  assert.match(review, /an ADR whose Status starts `Superseded` skipped with a note/u);
  assert.match(review, /never reworded on the branch to let a residual pass/u);
  assert.match(review, /### Accepted residuals against decisions .*`github\.pullRequest\.residuals\.section`.*`aidrian decisions residuals --body <file>`.*`nothing on record: no judgment owed`.* `product-manager` returns one row per residual.*`residual -> path:line`/u);
  assert.ok(review.indexOf('### Product feedback in the rounds') < review.indexOf('### Accepted residuals against decisions'));
  assert.ok(review.indexOf('### Accepted residuals against decisions') < review.indexOf('### Out of quota'));
  assert.match(read('README.md'), /\| `aidrian decisions residuals` \|/u);
});
