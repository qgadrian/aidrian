// A decision the Human recorded on an issue before a project run (lib/project-decision.mjs): the section a heading pins,
// how it is hashed and checked against the run's kept text, `aidrian project decision`, which prints the entry to pin
// from this session's recorded tracker read, and the recorded-decision lines of `aidrian project init --check`
// (lib/project-preflight.mjs snapshotCheck). The start's side is test/project-start-gate.test.mjs. The run fixture is
// test/project-start-fixture.mjs.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { decisionCommand, recordedDecision, sectionOf, shellQuoted } from '../plugins/aidrian/lib/project-decision.mjs';
import { decisionChecks, snapshotCheck } from '../plugins/aidrian/lib/project-preflight.mjs';
import { guardedStore } from '../plugins/aidrian/lib/project-run-gate.mjs';
import { lexCommand } from '../plugins/aidrian/lib/shell-lex.mjs';
import { recordHumanSignoff, signoffFolder } from '../plugins/aidrian/lib/review/signoff-store.mjs';
import { decisionStoreFolder, forgetDecision, readRecordedDecision, recordDecision } from '../plugins/aidrian/lib/project-decision-store.mjs';
import { projectId } from '../plugins/aidrian/lib/project.mjs';
import { recordedTexts, recordIssueReads, TEXT_CAPS } from '../plugins/aidrian/lib/project-issue-text.mjs';
import { markDriver, markUnattended } from '../plugins/aidrian/lib/unattended-mark.mjs';
import { DECIDED, decidedEntry, DRIVER, ISSUES, OTHER, runFixture, STARTED } from './project-start-fixture.mjs';

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

// The fixture's project key, asked of git once (projectId reads origin and the prefix each time).
const keyOf = (fx) => (fx.projectKey ??= projectId(fx.project));
// Records ENG-1's `entry` in the fixture's recorded-decision store, as `--record` writes it.
const recordIn = (fx, entry, key = 'ENG-1') => recordDecision({ projectKey: keyOf(fx), key, heading: entry.heading, sha256: entry.sha256, env: fx.env });
const storeFile = (fx, key = 'ENG-1') => path.join(decisionStoreFolder(fx.env), keyOf(fx), `${key}.json`);

// A heading whose words a shell would expand if the printed command did not quote them.
const SHELLY = "- Pick $(id) `uname` $HOME it's";

test('project decision prints, --record writes, --forget removes, and a malformed entry is replaced or removed, all from one recorded read', (t) => {
  // One fixture and as few commands as the cases need: each `aidrian project decision` reads the base branch's config
  // through git about twenty times, and the suite's child-process budget holds them.
  const fx = withRead(t, `${DECIDED.description}\n\n## ${SHELLY}\n\nChosen: CSV.\n`);
  const entry = decidedEntry();
  const file = storeFile(fx);
  const read = () => readRecordedDecision({ projectKey: keyOf(fx), key: 'ENG-1', env: fx.env });

  // Without --record: the section as hashed, then its sha256 and the command that records it. The heading, which starts
  // with a dash, goes in attached; the printed one is attached too, and one POSIX shell word, single-quoted, so
  // `$(...)`, a backtick, and `$VAR` never expand; nothing is written.
  const preview = fx.cmd(['decision', 'ENG-1', `--heading=${SHELLY}`]);
  assert.equal(preview.exitCode, 0, preview.err.join('\n'));
  const section = `## ${SHELLY}\n\nChosen: CSV.`;
  const sha256 = createHash('sha256').update(section).digest('hex');
  assert.deepEqual(preview.out.slice(0, 3), ['~~~~text', section, '~~~~'], 'the section first, fenced as hashed');
  assert.match(preview.out.at(-2), /^Write the section so it stands alone: it names the question and the chosen path in full/u);
  assert.equal(shellQuoted(SHELLY), "'- Pick $(id) `uname` $HOME it'\\''s'");
  const line = preview.out.at(-1);
  assert.equal(line, `sha256 ${sha256}; record it with \`aidrian project decision ENG-1 --heading='- Pick $(id) \`uname\` $HOME it'\\''s' --record\``);
  assert.equal(existsSync(decisionStoreFolder(fx.env)), false, 'nothing written');

  // The printed command, read back into the words a shell hands over (the plugin's own lexer: no shell runs), records
  // it: an owner-only entry under owner-only folders, from the same read.
  const words = lexCommand(line.slice(line.indexOf('`') + 1, line.lastIndexOf('`')))[0].map((word) => word.text);
  assert.deepEqual(words.slice(0, 4), ['aidrian', 'project', 'decision', 'ENG-1']);
  const recorded = fx.cmd(words.slice(2));
  assert.equal(recorded.exitCode, 0, recorded.err.join('\n'));
  assert.equal(recorded.out.at(-1), `recorded-decision: ENG-1 recorded in ${file}, sha256 ${sha256}`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(path.dirname(file)).mode & 0o777, 0o700);
  const stored = read().entry;
  assert.deepEqual({ ...stored, at: typeof stored.at }, { heading: SHELLY, sha256, by: 'human', at: 'string' });

  // --forget removes it; the store says when there is none. Arguments that conflict are refused before any read.
  assert.deepEqual(fx.cmd(['decision', 'ENG-1', '--forget']).out, [`recorded-decision: ENG-1 forgotten, ${file} removed`]);
  assert.equal(existsSync(file), false);
  assert.deepEqual(forgetDecision({ projectKey: keyOf(fx), key: 'ENG-1', env: fx.env }), { file, removed: false });
  const direct = (more) => decisionCommand({ project: fx.project, config: fx.config, key: 'ENG-1', env: fx.env, ...more }).err[0];
  assert.match(direct({ heading: 'Export format', record: true, forget: true }), /--record and --forget each act alone/u);
  assert.match(direct({ heading: 'Export format', forget: true }), /--forget takes no --heading/u);
  assert.match(direct({}), /--heading takes one line of 1 to 200 characters/u);

  // A malformed entry whose place, owner, type, and links pass: a start reads no grant, --record replaces it whole, and
  // --forget removes one of another shape; a file another user could write still refuses both.
  // The command records and forgets through these two, so they are called as it calls them.
  const store = { projectKey: keyOf(fx), key: 'ENG-1', env: fx.env };
  writeFileSync(file, '{ not json', { mode: 0o600 });
  assert.match(read().problem, /cannot be read as a recorded-decision store file/u, 'a start reads it as no grant');
  recordDecision({ ...store, heading: 'Export format', sha256: entry.sha256 });
  assert.equal(read().entry.sha256, entry.sha256, 'replaced whole');
  writeFileSync(file, JSON.stringify({ heading: 'x' }), { mode: 0o600 });
  assert.deepEqual(forgetDecision(store), { file, removed: true }, 'an entry of another shape');
  writeFileSync(file, '{ not json', { mode: 0o600 });
  chmodSync(file, 0o666);
  assert.throws(() => forgetDecision(store), /may be written another way than by the store/u);
  assert.throws(() => recordDecision({ ...store, heading: 'Export format', sha256: entry.sha256 }), /may be written another way than by the store/u);
  assert.equal(existsSync(file), true);

  // init --check asks the team switch before it opens any store, as start does.
  const keys = [];
  const spy = (given) => {
    keys.push(given.key);
    return { entry: null };
  };
  const ask = (policy, base = {}) => decisionChecks({ policy, base, mayStart: new Set(['ENG-1', 'ENG-4']), texts: {}, project: fx.project, env: fx.env, read: spy });
  ask({ recordedDecisions: false });
  ask({ problem: 'the forge did not answer' }, { config: { projectRun: { recordedDecisions: false } } });
  ask({ problem: 'the forge did not answer' });
  assert.deepEqual(keys, [], 'the switch off opens no store');
  ask({ recordedDecisions: true });
  ask({ problem: 'the forge did not answer' }, { config: { projectRun: { recordedDecisions: true } } });
  assert.deepEqual(keys, ['ENG-1', 'ENG-4', 'ENG-1', 'ENG-4']);
});

test('a store folder that is a link gets nothing made in its target, in the recorded-decision store and the sign-off store alike', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-store-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(root, 'state') };
  const target = path.join(root, 'elsewhere');
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(path.join(env.XDG_STATE_HOME, 'aidrian'), { recursive: true, mode: 0o700 });
  symlinkSync(target, decisionStoreFolder(env));
  symlinkSync(target, signoffFolder(env));
  assert.throws(() => recordDecision({ projectKey: 'proj', key: 'ENG-1', heading: 'Export format', sha256: 'a'.repeat(64), env }), /the recorded-decision store cannot be trusted: .*recorded-decisions is not a plain folder/u);
  assert.throws(() => recordHumanSignoff({ repo: 'acme/widgets', pr: 7, flow: 'payments', head: 'a'.repeat(40), by: 'the Human', env }), /the sign-off store cannot be trusted: .*signoffs is not a plain folder/u);
  assert.deepEqual(readdirSync(target), [], 'no folder was made where the links point');
});

test('a state root that is a link gets nothing made in its target: both stores refuse the write and the read, and a start makes no sandbox folder there', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-store-root-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { XDG_STATE_HOME: path.join(root, 'state') };
  const target = path.join(root, 'elsewhere');
  mkdirSync(target, { mode: 0o700 });
  mkdirSync(env.XDG_STATE_HOME, { mode: 0o700 });
  symlinkSync(target, path.join(env.XDG_STATE_HOME, 'aidrian'));
  assert.throws(() => recordDecision({ projectKey: 'proj', key: 'ENG-1', heading: 'Export format', sha256: 'a'.repeat(64), env }), /the recorded-decision store cannot be trusted: .*aidrian is not a plain folder/u);
  assert.throws(() => recordHumanSignoff({ repo: 'acme/widgets', pr: 7, flow: 'payments', head: 'a'.repeat(40), by: 'the Human', env }), /the sign-off store cannot be trusted: .*aidrian is not a plain folder/u);
  assert.match(readRecordedDecision({ projectKey: 'proj', key: 'ENG-1', env }).problem, /cannot be trusted: .*aidrian is not a plain folder/u, 'a read refuses it too');
  guardedStore({ env, home: root });
  assert.deepEqual(readdirSync(target), [], 'no folder was made where the link points');
});

test('project decision refuses with no recorded read, no single section, hidden markup, a session no Human attends, one that drove a run, and a store not the user\'s alone', (t) => {
  const fx = runFixture(t, { init: false });
  const readFor = (session, description) => assert.equal(recordIssueReads(session, [{ key: 'ENG-1', text: { title: 'Export', description, criteria: '', labels: [] } }], { env: fx.env }), 1);
  const missing = fx.cmd(['decision', 'ENG-1', '--heading', 'Export format']);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.err[0], /this session recorded no tracker read of ENG-1; read it with the tracker's own issue read/u);
  readFor(OTHER, DECIDED.description);
  assert.equal(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format']).exitCode, 1, 'another session\'s read');
  readFor(DRIVER, `${DECIDED.description}\n<!-- and XLSX -->`);
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Export format']).err[0], /the issue's description holds text the tracker's view hides \(an HTML comment, a <details> tag, or a \+\+\+ line, anywhere, fenced or not\)/u);
  readFor(DRIVER, DECIDED.description);
  assert.match(fx.cmd(['decision', 'ENG-1', '--heading', 'Missing']).err[0], /no section of ENG-1's description, or more than one, has the heading "Missing"/u);
  // A session no Human attends, and one that drove a run, record and forget nothing.
  const driver = STARTED[0].session;
  markUnattended(OTHER, { root: fx.dir, env: fx.env });
  markDriver(driver, { run: 'launch', root: fx.dir, state: fx.state, env: fx.env });
  // Both forms meet the same checks before either acts; the hook rule covers each form (project-start-guard.test.mjs).
  const unattended = fx.cmd(['decision', 'ENG-1', '--heading', 'Export format', '--record'], { session: OTHER });
  assert.equal(unattended.exitCode, 1);
  assert.match(unattended.err[0], /from an attended session, and the background handoff route started this session/u);
  assert.match(fx.cmd(['decision', 'ENG-1', '--forget'], { session: driver }).err[0], /this session drove a project run, which may run on with no Human, so it records and forgets no decision/u);
  assert.equal(existsSync(decisionStoreFolder(fx.env)), false, 'nothing written');
  // A store folder another user may write.
  mkdirSync(path.join(decisionStoreFolder(fx.env), keyOf(fx)), { recursive: true });
  chmodSync(decisionStoreFolder(fx.env), 0o777);
  assert.throws(() => recordDecision({ projectKey: keyOf(fx), key: 'ENG-1', heading: 'Export format', sha256: decidedEntry().sha256, env: fx.env }), /the recorded-decision store cannot be trusted: .* may be written by another user/u);
});

test('init --check names each recorded decision of an issue to start: a blocker with no description, else a note', async (t) => {
  const fx = runFixture(t, { init: false, projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: true } });
  for (const key of ['ENG-1', 'ENG-9']) recordIn(fx, decidedEntry(), key);
  const file = path.join(fx.dir, 'snapshot.input');
  writeFileSync(file, JSON.stringify({ issues: ISSUES }));
  // Each check reads ENG-1 again, as the tracker answered it last.
  const check = (description) => {
    assert.equal(recordIssueReads(DRIVER, [{ key: 'ENG-1', text: { title: 'Export', description, criteria: '', labels: [] } }], { env: fx.env }), 1);
    return fx.cmd(['init', 'launch', '--file', file, '--check']).out.filter((line) => line.includes('recorded-decision'));
  };
  assert.deepEqual(check(DECIDED.description), ['note recorded-decision: ENG-1 stands: Export format'], 'an issue the plan does not start gets no line');
  assert.deepEqual(check(DECIDED.description.replace('CSV with', 'XLSX with')), ['note recorded-decision: ENG-1 void: the section\'s sha256 differs, so it changed after it was pinned']);
  assert.deepEqual(check(''), ['blocker recorded-decision: ENG-1 has a recorded decision in this machine\'s recorded-decision store and this session recorded no description of it; read it in this session with the tracker\'s own issue read']);
  // A state folder init refuses, here a runs folder that is a symlink, is a snapshot blocker of its own, and then no
  // recorded decision is named as standing: the check calls snapshotCheck in this process, as the command does.
  assert.equal(recordIssueReads(DRIVER, [{ key: 'ENG-1', text: { title: 'Export', description: DECIDED.description, criteria: '', labels: [] } }], { env: fx.env }), 1);
  const elsewhere = path.join(fx.root, 'elsewhere-runs');
  mkdirSync(elsewhere, { mode: 0o700 });
  symlinkSync(elsewhere, path.join(fx.state, 'runs'));
  const refused = snapshotCheck({ project: fx.project, config: fx.config, file, session: DRIVER, env: fx.env, home: fx.home, forge: fx.forge });
  assert.equal(refused.exitCode, 1);
  assert.ok(refused.out.some((line) => /^blocker snapshot: the folder .*runs is a symlink, so no project run is kept there$/u.test(line)), refused.out.join('\n'));
  assert.ok(!refused.out.some((line) => line.includes('recorded-decision')), 'no stands line while init would refuse the state folder');
});

test('init --check reads the store only where the team switch is on on the local ref and the forge alike', (t) => {
  const check = (forgeConfig) => {
    const fx = withRead(t, DECIDED.description, DRIVER, { projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: true }, forgeConfig });
    recordIn(fx, decidedEntry());
    const file = path.join(fx.dir, 'snapshot.input');
    writeFileSync(file, JSON.stringify({ issues: ISSUES }));
    return fx.cmd(['init', 'launch', '--file', file, '--check']);
  };
  const forgeless = check({ version: 1, projectRun: { allow: true, unverifiedHosts: true } });
  assert.ok(!forgeless.out.some((line) => line.includes('recorded-decision')), `only the local ref turns it on: ${forgeless.out.join('\n')}`);
  const refused = check({ version: 1, projectRun: { allow: false } });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.out.find((line) => line.includes('recorded-decision')), /^blocker recorded-decision: the team's policy cannot be read \(the default branch main on the forge does not set projectRun\.allow to true\), so whether the decisions recorded for ENG-1 stand cannot be told; check again once it can$/u);
});

test('init --check names no recorded decision of a canceled issue or one skipped below it, and keeps one that waits on a blocker', (t) => {
  const entry = decidedEntry();
  const fx = runFixture(t, { init: false, projectRun: { allow: true, unverifiedHosts: true, recordedDecisions: true } });
  for (const key of ['ENG-2', 'ENG-5', 'ENG-6']) recordIn(fx, entry, key);
  const file = path.join(fx.dir, 'snapshot.input');
  writeFileSync(file, JSON.stringify({ issues: [...ISSUES, { key: 'ENG-5', branch: 'feat/eng-5-old', status: 'canceled' }, { key: 'ENG-6', branch: 'feat/eng-6-after', status: 'unstarted', blockedBy: ['ENG-5'] }] }));
  const lines = fx.cmd(['init', 'launch', '--file', file, '--check']).out.filter((line) => line.includes('recorded-decision'));
  assert.deepEqual(lines.map((line) => line.split(':')[1].trim().split(' ')[0]), ['ENG-2'], lines.join('\n'));
  assert.match(lines[0], /^blocker recorded-decision: ENG-2 has a recorded decision/u);
});
