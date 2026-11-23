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

import { hidesText, recordedDecision, sectionOf } from '../plugins/aidrian/lib/project-decision.mjs';
import { recordIssueReads } from '../plugins/aidrian/lib/project-issue-text.mjs';
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

test('a section that holds markup the tracker\'s view hides is void, however it hashes', () => {
  for (const hidden of ['<!-- ship XLSX too -->', '<details><summary>More</summary>XLSX</details>', '+++ Agent notes', '  +++']) {
    const body = `## Decision\nChosen: CSV.\n${hidden}\n`;
    const section = sectionOf(body, 'Decision');
    assert.equal(hidesText(section), true, hidden);
    assert.deepEqual(recordedDecision({ heading: 'Decision', sha256: sha(section) }, body), { void: 'the section holds text the tracker\'s view hides' }, hidden);
  }
  assert.equal(hidesText('## Decision\nA diff line: a+++b'), false);
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
  const fx = withRead(t, `${DECIDED.description}\n<!-- and XLSX -->`);
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Notes']).err[0], /the section holds text the tracker's view hides/u);
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
