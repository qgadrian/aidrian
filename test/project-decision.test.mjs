// A decision the Human recorded on an issue before a project run (lib/project-decision.mjs): the section a heading pins,
// how it is hashed and checked against the run's kept text, `aidrian project decision`, which prints the entry to pin
// from this session's recorded tracker read, and the recorded-decision lines of `aidrian project init --check`
// (lib/project-preflight.mjs snapshotCheck). The start's side is test/project-start-gate.test.mjs. The run fixture is
// test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { recordedDecision, sectionOf } from '../plugins/aidrian/lib/project-decision.mjs';
import { recordedTexts, recordIssueReads, TEXT_CAPS } from '../plugins/aidrian/lib/project-issue-text.mjs';
import { markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DECIDED, decidedEntry, DRIVER, ISSUES, OTHER, runFixture } from './project-start-fixture.mjs';

const sha = (text) => createHash('sha256').update(text).digest('hex');

test('a section runs from its heading to the next heading of the same or a higher level, outside code fences', () => {
  const body = [
    '# Spec', 'Intro.', '## Decision', 'Chosen: CSV.', '### Detail', 'A header row.', '```md', '## Decision', '# Not a heading', '```',
    'Still in it.', '', '', '## Later', 'Other.',
  ].join('\n');
  assert.equal(sectionOf(body, 'Decision'), ['## Decision', 'Chosen: CSV.', '### Detail', 'A header row.', '```md', '## Decision', '# Not a heading', '```', 'Still in it.'].join('\n'));
  assert.equal(sectionOf(body, '  Detail '), '### Detail\nA header row.\n```md\n## Decision\n# Not a heading\n```\nStill in it.', 'the title once trimmed; a lower heading ends at the next higher one');
  assert.equal(sectionOf(body, 'Spec'), body, 'a level-1 heading runs to the end; a fenced one ends nothing');
  assert.equal(sectionOf(`${body}\n## Decision\nAgain.`, 'Decision'), null, 'two headings with that title');
  assert.equal(sectionOf(body, 'Missing'), null);
  assert.equal(sectionOf(body, ''), null);
  assert.equal(sectionOf('#Decision\ntext', 'Decision'), null, 'no space after the hashes is no heading');
});

test('CRLF and trailing spaces hash alike, and the hash covers the heading line', () => {
  const lf = 'Intro\n## Decision\nChosen: CSV.\n\n## Next\n';
  const crlf = 'Intro\r\n## Decision   \r\nChosen: CSV.\t\r\n\r\n## Next\r\n';
  assert.equal(sectionOf(crlf, 'Decision'), sectionOf(lf, 'Decision'));
  const entry = { heading: 'Decision', sha256: sha('## Decision\nChosen: CSV.') };
  assert.deepEqual(recordedDecision(entry, crlf), { section: '## Decision\nChosen: CSV.', sha256: entry.sha256 });
  assert.deepEqual(recordedDecision(entry, lf.replace('CSV', 'XLSX')), { void: 'the section\'s sha256 differs, so it changed after it was pinned' });
  assert.deepEqual(recordedDecision(entry, ''), { void: 'the run kept no description of the issue' });
  assert.deepEqual(recordedDecision(entry, 'no heading here'), { void: 'no section, or more than one, has that heading' });
});

const HIDDEN = { void: 'the issue\'s description holds text the tracker\'s view hides' };
const CUT = { void: 'the kept description was cut off at its 20,000-character cap' };
const pinned = (body, heading = 'Decision', options) => recordedDecision({ heading, sha256: sha(sectionOf(body, heading) ?? '') }, body, options);

test('a description that holds markup the tracker\'s view hides anywhere, fenced or not, voids every grant on it', () => {
  const clean = '## Decision\nChosen: CSV.\n## Other\nText.';
  assert.equal(pinned(clean).section, '## Decision\nChosen: CSV.');
  for (const hidden of ['<!-- ship XLSX too -->', '<DETAILS><summary>More</summary>XLSX</DETAILS>', '+++ Agent notes', '+++', '  +++   ']) {
    assert.deepEqual(pinned(`${clean}\n${hidden}`), HIDDEN, `after the section: ${hidden}`);
    assert.deepEqual(pinned(`${hidden}\n${clean}`), HIDDEN, `before the section: ${hidden}`);
    assert.deepEqual(pinned(`${clean}\n\`\`\`html\n${hidden}\n\`\`\``), HIDDEN, `in a fenced example: ${hidden}`);
  }
  // A comment that opens above the heading, which the next heading of the same level ends before the comment closes.
  assert.deepEqual(pinned('Intro\n<!--\n## Decision\nChosen: XLSX.\n## Other\n-->'), HIDDEN);
  for (const plain of ['a+++b', '+++b', '++ x', 'details in prose', '<!- not a comment']) assert.equal(pinned(`${clean}\n${plain}`).void, undefined, plain);
});

test('a description its cap cut off keeps that mark, and voids every grant on it, even one a heading ends before the cut', (t) => {
  const head = 'Intro\n## Decision\nChosen: CSV.\n## Next\n';
  const long = `${head}${'x'.repeat(TEXT_CAPS.description)}`;
  const fx = runFixture(t, { init: false });
  recordIssueReads(DRIVER, [{ key: 'ENG-1', text: { title: 'Export', description: long } }, { key: 'ENG-4', text: { title: 'Typo', description: head } }], { env: fx.env });
  const texts = recordedTexts(DRIVER, ['ENG-1', 'ENG-4'], { env: fx.env, home: fx.home });
  assert.deepEqual([texts['ENG-1'].description.length, texts['ENG-1'].descriptionCut, Object.hasOwn(texts['ENG-4'], 'descriptionCut')], [TEXT_CAPS.description, true, false]);
  const kept = texts['ENG-1'].description;
  assert.equal(sectionOf(kept, 'Decision'), '## Decision\nChosen: CSV.', 'a heading ends the section well before the cut');
  assert.deepEqual(pinned(kept, 'Decision', { cut: true }), CUT);
  assert.equal(pinned(kept).section, '## Decision\nChosen: CSV.', 'the same text uncut stands');
  const refused = fx.cmd(['decision', 'ENG-1', '--heading', 'Decision']);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.err[0], /the kept description was cut off at its 20,000-character cap; keep a pinned issue's description under 20000 characters/u);
});

// The fixture with the tracker's answer for ENG-1 recorded for `session`, as the post-call tracker hook records it.
function withRead(t, description = DECIDED.description, session = DRIVER, more = {}) {
  const fx = runFixture(t, { init: false, ...more });
  assert.equal(recordIssueReads(session, [{ key: 'ENG-1', text: { title: 'Export', description, criteria: '', labels: [] } }], { env: fx.env }), 1);
  return fx;
}

test('project decision prints the section as hashed, then the entry to pin, which stands against the same recorded read', (t) => {
  const fx = withRead(t);
  const answer = fx.cmd(['decision', 'ENG-1', '--heading', 'Export format']);
  assert.equal(answer.exitCode, 0, answer.err.join('\n'));
  const entry = decidedEntry();
  assert.equal(answer.out.at(-1), `"ENG-1": { "heading": "Export format", "sha256": "${entry.sha256}" }`, 'the entry line last');
  assert.deepEqual(answer.out.slice(0, 3), ['~~~~text', sectionOf(DECIDED.description, 'Export format'), '~~~~'], 'the section first, fenced as hashed');
  assert.match(answer.out.at(-2), /^Write the section so it stands alone: it names the question and the chosen path in full/u);
  const pinned = JSON.parse(`{${answer.out.at(-1)}}`)['ENG-1'];
  assert.deepEqual(recordedDecision(pinned, DECIDED.description), { section: sectionOf(DECIDED.description, 'Export format'), sha256: entry.sha256 });
});

test('project decision refuses with no recorded read, no single section, hidden markup, or a session no Human attends', (t) => {
  const none = runFixture(t, { init: false });
  const missing = none.cmd(['decision', 'ENG-1', '--heading', 'Export format']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err[0], /this session recorded no tracker read of ENG-1; read it with the tracker's own issue read/u);
  const other = withRead(t, DECIDED.description, OTHER);
  assert.equal(other.cmd(['decision', 'ENG-1', '--heading', 'Export format']).exitCode, 1, 'another session\'s read');
  const hidden = withRead(t, `${DECIDED.description}\n<!-- and XLSX -->`);
  assert.match(hidden.cmd(['decision', 'ENG-1', '--heading', 'Export format']).err[0], /the issue's description holds text the tracker's view hides \(an HTML comment, a <details> tag, or a \+\+\+ line, anywhere, fenced or not\)/u);
  const fx = withRead(t);
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Missing']).err[0], /no section of ENG-1's description, or more than one, has the heading "Missing"/u);
  assert.match(fx.cmd(['decision', 'ENG-1']).err[0], /--heading takes one line of 1 to 200 characters/u);
  markUnattended(DRIVER, { root: fx.dir, env: fx.env });
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format']).err[0], /from an attended session, and the background handoff route started this session/u);
});

test('init --check names each recorded decision of an issue to start: a blocker with no description, else a note', async (t) => {
  const check = (description, entry, projectRun = {}) => {
    const fx = withRead(t, description, DRIVER, { projectRun: { allow: true, unverifiedHosts: true, ...projectRun, recordedDecisions: { 'ENG-1': entry, 'ENG-9': entry } } });
    const file = path.join(fx.dir, 'snapshot.input');
    writeFileSync(file, JSON.stringify({ issues: ISSUES }));
    return fx.cmd(['init', 'launch', '--file', file, '--check']).out.filter((line) => line.includes('recorded-decision'));
  };
  assert.deepEqual(check(DECIDED.description, decidedEntry()), ['note recorded-decision: ENG-1 stands: Export format'], 'an issue the plan does not start gets no line');
  assert.deepEqual(check(DECIDED.description.replace('CSV with', 'XLSX with'), decidedEntry()), ['note recorded-decision: ENG-1 void: the section\'s sha256 differs, so it changed after it was pinned']);
  assert.deepEqual(check('', decidedEntry()), ['blocker recorded-decision: ENG-1 has a recorded decision in projectRun.recordedDecisions and this session recorded no description of it; read it in this session with the tracker\'s own issue read']);
  const accepted = check(DECIDED.description, decidedEntry(), { forgeProtectionAccepted: true });
  assert.match(accepted.at(-1), /^note recorded-decision: the team accepts no forge protection \(projectRun\.forgeProtectionAccepted\), so a grant is as strong as the hooks/u);
});

test('init --check reads the recorded decisions start applies: those the local ref and the forge pin alike', (t) => {
  const check = (forgeConfig) => {
    const fx = withRead(t, DECIDED.description, DRIVER, { projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: { 'ENG-1': decidedEntry() } }, forgeConfig });
    const file = path.join(fx.dir, 'snapshot.input');
    writeFileSync(file, JSON.stringify({ issues: ISSUES }));
    return fx.cmd(['init', 'launch', '--file', file, '--check']);
  };
  const forgeless = check({ version: 1, projectRun: { allow: true, unverifiedHosts: true } });
  assert.ok(!forgeless.out.some((line) => line.includes('recorded-decision')), `only the local ref pins it: ${forgeless.out.join('\n')}`);
  const differ = check({ version: 1, projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: { 'ENG-1': { ...decidedEntry(), sha256: 'f'.repeat(64) } } } });
  assert.ok(!differ.out.some((line) => line.includes('recorded-decision')), 'the two pin it differently');
  const refused = check({ version: 1, projectRun: { allow: false } });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.out.find((line) => line.includes('recorded-decision')), /^blocker recorded-decision: the team's policy cannot be read \(the default branch main on the forge does not set projectRun\.allow to true\), so whether the decisions recorded for ENG-1 stand cannot be told; check again once it can$/u);
});

test('init --check names no recorded decision of a canceled issue or one skipped below it, and keeps one that waits on a blocker', (t) => {
  const entry = decidedEntry();
  const fx = runFixture(t, { init: false, projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: { 'ENG-2': entry, 'ENG-5': entry, 'ENG-6': entry } } });
  const file = path.join(fx.dir, 'snapshot.input');
  writeFileSync(file, JSON.stringify({ issues: [...ISSUES, { key: 'ENG-5', branch: 'feat/eng-5-old', status: 'canceled' }, { key: 'ENG-6', branch: 'feat/eng-6-after', status: 'unstarted', blockedBy: ['ENG-5'] }] }));
  const lines = fx.cmd(['init', 'launch', '--file', file, '--check']).out.filter((line) => line.includes('recorded-decision'));
  assert.deepEqual(lines.map((line) => line.split(':')[1].trim().split(' ')[0]), ['ENG-2'], lines.join('\n'));
  assert.match(lines[0], /^blocker recorded-decision: ENG-2 has a recorded decision/u);
});
