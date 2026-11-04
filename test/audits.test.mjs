import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseReport } from '../plugins/aidrian/lib/audit-import.mjs';
import { auditNudge, evidenceProblem, issueLabels, listAudits, OWNER_WORDS, pendingGroups, proseProblems, proseShorthand, searchLabels, sidecarProblems } from '../plugins/aidrian/lib/audits.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const AIDRIAN = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
// A synthetic report in the shape of a real walk: 11 findings, a run that replaces an earlier report, Not reached and
// doc gap sections, and screenshots cited by suffix alone (`-24.jpg`), as reports written before sidecars did.
const FIXTURES = path.join(ROOT, 'test/fixtures/persona-audit');
const NEW = 'front-desk-2026-05-02-2.md';
const OLD = 'front-desk-2026-05-02.md';
// How the text output names them to a person: by persona, kind, date, and run, never by file name.
const NEW_TITLE = 'The front-desk walk on 2026-05-02';
const OLD_TITLE = 'The front-desk read-only run on 2026-05-02';
// What a person reads holds no item id, such as F1, N2, or D1, and no file suffix, such as -2.md: ids are keys for the
// commands only. A path given as a location is the one exception, so callers strip the audits folder's paths first.
const BARE_ID = /\b[FND][1-9]\d*\b|-\d+\.md\b/u;
// The next step a plain import ends with is the one other exception: its command line, and each finding's "key F1",
// which the flags take, after the finding's title.
const humanText = (text) => text.split('\n').filter((line) => !/^ {2}aidrian audits /u.test(line)).join('\n').replace(/": key F[1-9]\d*$/gmu, '"');
const noIds = (text, location = null) => assert.doesNotMatch(humanText(location ? text.split(location).join('<location>') : text), BARE_ID, text);
// Every screenshot the new report cites, by full path or by suffix.
const SHOTS = [10, 13, 15, 20, 23, 24, 25, 27, 28, 29, 30, 31, 32, 33, 38].map((n) => `shot-17000000000${n}-${n}.jpg`).concat('shot-1700000000022-22.png');

// An audits folder holding both fixture reports and the new report's screenshots.
function auditsDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-audits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of [NEW, OLD]) copyFileSync(path.join(FIXTURES, name), path.join(dir, name));
  mkdirSync(path.join(dir, NEW.replace(/\.md$/u, '')));
  for (const shot of SHOTS) writeFileSync(path.join(dir, NEW.replace(/\.md$/u, ''), shot), '');
  return dir;
}

// A valid sidecar for a new run: one blocker, one friction finding, one Not reached line, and one doc gap.
function sidecar(overrides = {}) {
  return {
    version: 1,
    report: 'front-desk-2026-06-01.md',
    personas: ['front-desk'],
    date: '2026-06-01',
    supersedes: null,
    carried_forward: [],
    not_rechecked: [],
    findings: [
      {
        id: 'F1', title: 'a drop-in is not shown as a drop-in', severity: 'blocker', label: 'observed', evidence_level: 'walked',
        personas: ['front-desk'], tasks: ['Check a bike in'], owner: 'frontend-developer', owner_description: OWNER_WORDS['frontend-developer'],
        evidence: ['front-desk-2026-06-01/shot-1.png'], needs_trace: false,
      },
      {
        id: 'F2', title: 'the saved bench differs from the one shown', severity: 'friction', label: 'observed', evidence_level: 'walked',
        personas: ['front-desk'], tasks: ['Take a repair'], owner: 'backend-developer', owner_description: OWNER_WORDS['backend-developer'],
        other_owners: ['frontend-developer'], evidence: ['front-desk-2026-06-01/shot-2.png', 'front-desk-2026-06-01/shot-3.png'],
        needs_trace: true, likely_cause: 'the preview and the save pick a bench separately',
      },
    ],
    not_reached: [{ id: 'N1', text: 'Tablet width: the browser would not resize.' }],
    doc_gaps: [{ id: 'D1', text: 'Check a bike in, and hand it back joins three outcomes in one success line.' }],
    ...overrides,
  };
}

test('a complete sidecar is valid, and each field it gets wrong is named', () => {
  assert.deepEqual(sidecarProblems(sidecar()), []);
  const finding = (changes) => sidecar({ findings: [{ ...sidecar().findings[1], ...changes }] });
  const cases = [
    [finding({ evidence: ['-24.jpg'] }), /evidence "-24\.jpg" is shorthand: write the full path/],
    [finding({ evidence: ['/tmp/shot.png'] }), /must be relative to the audits folder/],
    [finding({ evidence: ['../other/shot.png'] }), /must be relative to the audits folder/],
    [finding({ evidence: ['shot.png'] }), /must name a file in a report's folder/],
    [finding({ severity: 'blocker', evidence_level: 'read' }), /a blocker is only a walked, observed finding/],
    [finding({ evidence: [], cited: undefined }), /an observed finding cites evidence or cited/],
    [finding({ needs_trace: 'yes' }), /needs_trace must be true or false/],
    [finding({ needs_trace: false }), /likely_cause is text, and only on a finding with needs_trace true/],
    [finding({ owner_description: '' }), /owner_description must say in plain words/],
    [finding({ owner: 'The UX team' }), /owner must be an agent role/],
    [sidecar({ not_rechecked: ['F3'] }), /not_rechecked: needs supersedes/],
    [sidecar({ supersedes: 'front-desk-2026-05-02.md', carried_forward: ['F1'], not_rechecked: ['F1', 'F2'] }), /1 finding of the replaced report also in carried_forward: a finding is listed once/],
    [sidecar({ supersedes: 'front-desk-2026-06-01.md' }), /a report cannot replace itself/],
    [sidecar({ not_reached: [{ id: 'F1', text: 'x' }] }), /not_reached\[0\]\.id: must be N and the item's number in its section/],
    [sidecar({ findings: [sidecar().findings[0], { ...sidecar().findings[1], id: 'F1' }] }), /findings: "a drop-in is not shown as a drop-in", "the saved bench differs from the one shown" share one key/],
    [sidecar({ date: 'today' }), /date: must be YYYY-MM-DD/],
  ];
  for (const [value, pattern] of cases) {
    const problems = sidecarProblems(value).join('\n');
    assert.match(problems, pattern);
    noIds(problems);
  }
  assert.match(sidecarProblems(sidecar({ supersedes: 'front-desk-2026-05-02.md', carried_forward: ['F1'], not_rechecked: ['F1'] }), { replacedTitle: () => 'the part note is hidden' }).join('\n'),
    /"the part note is hidden" also in carried_forward/, 'named by title when the replaced report can be read');
  assert.match(sidecarProblems(finding({ owner: 'The UX team' })).join('\n'), /^finding "the saved bench differs from the one shown": owner must be/mu);
  assert.match(sidecarProblems(sidecar(), { report: 'other-2026-06-01.md' }).join('\n'), /names front-desk-2026-06-01\.md, but the sidecar belongs to other/);
});

test('with the audits folder, evidence must name a file there', (t) => {
  const dir = auditsDir(t);
  assert.equal(evidenceProblem(`front-desk-2026-05-02-2/${SHOTS[0]}`, dir), null);
  assert.match(evidenceProblem('front-desk-2026-05-02-2/shot-missing.png', dir), /names no file in/);
});

test('the prose report may not cite a screenshot by its suffix, and its findings match the sidecar by title', (t) => {
  const dir = auditsDir(t);
  const text = readFileSync(path.join(FIXTURES, NEW), 'utf8');
  const { findings } = parseReport(text, { report: NEW, dir });
  const problems = proseProblems(text, { findings });
  assert.deepEqual(problems, [
    'finding "the bench a repair lands on differs from the bench the form showed" cites a screenshot by its suffix alone, "-32.jpg": write the full path',
    'finding "the part-to-order note is not on the board card" cites a screenshot by its suffix alone, "-24.jpg": write the full path',
    'finding "the part-to-order note is not on the board card" cites a screenshot by its suffix alone, "-25.jpg": write the full path',
    'finding "the move list highlights a bench that is booked later" cites a screenshot by its suffix alone, "-28.jpg": write the full path',
  ]);
  assert.deepEqual(proseProblems('### polish: x\n', { findings: [] }), ['the report\'s finding "x" is not in the sidecar']);
  assert.deepEqual(proseProblems('## Findings\n', { findings: [{ title: 'y' }] }), ['the sidecar\'s finding "y" is not in the report']);
  assert.deepEqual(proseProblems('### polish: a\n### polish: b\n', { findings: [{ title: 'b' }, { title: 'a' }] }), ['the report and the sidecar list the findings in another order']);
  assert.deepEqual(proseProblems('### blocker: a\n### polish: b\n', { findings: [{ title: 'a' }, { title: 'b' }] }), [], 'a heading with no id is the format now');
});

test('a report written before sidecars parses into a draft: findings, the report it replaces, Not reached, doc gaps', (t) => {
  const dir = auditsDir(t);
  const draft = parseReport(readFileSync(path.join(dir, NEW), 'utf8'), { report: NEW, dir, ownerWords: OWNER_WORDS });
  assert.equal(draft.findings.length, 11);
  assert.deepEqual(draft.findings.map((f) => f.id), ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11']);
  assert.equal(draft.supersedes, OLD);
  assert.deepEqual([draft.personas, draft.date], [['front-desk'], '2026-05-02']);
  const [f1, f2, f3, , f5, f6] = draft.findings;
  assert.deepEqual([f1.severity, f1.label, f1.evidence_level, f1.owner, f1.tasks], ['blocker', 'observed', 'walked', 'frontend-developer', ['Check a bike in']]);
  assert.deepEqual(f2.tasks, ['Take a repair', 'Check a bike in']);
  assert.deepEqual(f2.other_owners, ['frontend-developer']);
  assert.equal(f2.needs_trace, true, 'its cause "was not traced"');
  assert.equal(f1.needs_trace, false);
  assert.ok(f2.evidence.includes('front-desk-2026-05-02-2/shot-1700000000032-32.jpg'), 'the suffix -32.jpg names its one file');
  assert.deepEqual(f3.evidence, ['front-desk-2026-05-02-2/shot-1700000000023-23.jpg', 'front-desk-2026-05-02-2/shot-1700000000024-24.jpg', 'front-desk-2026-05-02-2/shot-1700000000025-25.jpg']);
  assert.deepEqual(f5.other_owners, ['product-manager']);
  assert.deepEqual(f6.tasks, ['All tasks']);
  assert.equal(f1.owner_description, OWNER_WORDS['frontend-developer']);
  assert.equal(draft.not_reached.length, 3);
  assert.deepEqual(draft.doc_gaps, [{ id: 'D1', text: '"Check a bike in, and hand it back when it is done" joins check-in, hand-back and drop-in in one success line, so one missing label blocks the whole task.' }]);
  const { warnings, ...value } = draft;
  assert.deepEqual(sidecarProblems(value, { dir, report: NEW }), []);

  const unexpanded = parseReport(readFileSync(path.join(dir, NEW), 'utf8'), { report: NEW });
  assert.match(unexpanded.warnings.join('\n'), /"the part-to-order note is not on the board card": the screenshot "-24\.jpg" matched no single file in the report's folder, so it is left out/);
  noIds(unexpanded.warnings.join('\n'));
  const old = parseReport(readFileSync(path.join(dir, OLD), 'utf8'), { report: OLD });
  assert.deepEqual(old.findings.map((f) => [f.id, f.evidence_level, f.cited]), [
    ['F1', 'read', ['src/repairs/RepairForm.tsx:40']], ['F2', 'read', ['locales/second.json:12', 'locales/second.json:30']], ['F3', 'read', ['locales/second.json:44']],
  ]);
  assert.match(old.warnings.join('\n'), /"the part note sits behind a collapsed "Optional" section": write owner_description, in plain words, for ux-specialist/, 'with no owner words given');
  const fresh = parseReport('## Findings\n\n### blocker: one\n\n### polish: two\n', { report: 'front-desk-2026-06-01.md' });
  assert.deepEqual(fresh.findings.map((f) => [f.id, f.title]), [['F1', 'one'], ['F2', 'two']], 'a heading with no id takes the key of its place');
});

test('a folder of reports without sidecars counts the newest run, and the findings of the run it replaces once, as awaiting the sort', (t) => {
  const dir = auditsDir(t);
  const [old, current] = listAudits(dir);
  assert.deepEqual([old.report, old.status, old.replaced_by, old.untriaged], [OLD, 'replaced', NEW, 0]);
  assert.deepEqual([current.report, current.status, current.untriaged, current.awaiting_sort], [NEW, 'no-sidecar', 18, 3], 'its own 15 items and the 3 findings it must sort');
  assert.equal(old.awaiting_sort, 3);
  assert.equal(auditNudge(dir), 'Audit inbox: 18 untriaged findings in 1 report. The persona-audit-triage skill triages them.');
});

test('the start line is empty without audits, and never throws on a broken folder', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-audits-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(auditNudge(path.join(dir, 'missing')), '');
  assert.equal(auditNudge(dir), '');
  writeFileSync(path.join(dir, 'front-desk-2026-06-01.md'), '## Findings\n\n### F1. polish: x\n');
  writeFileSync(path.join(dir, 'triage.json'), 'not json');
  assert.equal(auditNudge(dir), '', 'an unreadable triage record prints nothing');
  writeFileSync(path.join(dir, 'triage.json'), '{"version":1,"reports":{}}');
  writeFileSync(path.join(dir, 'front-desk-2026-06-01.json'), '{ broken');
  assert.equal(auditNudge(dir), 'Audit inbox: 1 untriaged finding in 1 report. The persona-audit-triage skill triages them.', 'an invalid sidecar counts its prose');
});

test('pending orders the items: blockers alone, then by severity and owner, then the replaced run, reruns, and doc gaps', () => {
  const value = sidecar({ supersedes: 'front-desk-2026-05-02.md', not_rechecked: ['F3'] });
  value.findings.push({ ...value.findings[1], id: 'F3', severity: 'polish', owner: 'ux-specialist', owner_description: OWNER_WORDS['ux-specialist'], needs_trace: false, likely_cause: undefined });
  delete value.findings[2].likely_cause;
  const items = [
    ...value.findings.map((f) => ({ kind: 'finding', ...f, report: value.report, decision: null })),
    { kind: 'not_rechecked', id: 'F3', title: 'the second language mixes address', report: 'front-desk-2026-05-02.md', decision: null },
    { kind: 'not_reached', ...value.not_reached[0], report: value.report, decision: null },
    { kind: 'doc_gap', ...value.doc_gaps[0], report: value.report, decision: { decision: 'defer' } },
  ];
  const groups = pendingGroups({ items });
  assert.deepEqual(groups.map((g) => [g.kind, g.title, g.items.map((i) => i.id)]), [
    ['blocker', 'Blocker, for the screens and their code', ['F1']],
    ['findings', 'Friction, for the server and the answers it gives', ['F2']],
    ['findings', 'Polish, for how the product flows and what its words say', ['F3']],
    ['not_rechecked', 'Not re-checked from the front-desk audit on 2026-05-02', ['F3']],
    ['not_reached', 'Not reached: follow-ups for a rerun', ['N1']],
  ]);
  // A Not reached line that restates the not re-checked findings is offered with them, as covered.
  const restating = { kind: 'not_reached', id: 'N2', text: 'The second language: not walked.', covered_by: 'not_rechecked', report: value.report, decision: null };
  const withCovered = pendingGroups({ items: [...items, restating] });
  assert.deepEqual(withCovered.find((g) => g.kind === 'not_rechecked').items.map((i) => [i.id, i.proposed ?? null]), [['F3', null], ['N2', 'covered']]);
  assert.deepEqual(withCovered.find((g) => g.kind === 'not_reached').items.map((i) => i.id), ['N1']);
  const alone = pendingGroups({ items: [restating] });
  assert.deepEqual(alone.map((g) => [g.kind, g.items.map((i) => [i.id, i.proposed])]), [['not_reached', [['N2', 'covered']]]], 'with the findings decided, it stays a rerun, still proposed as covered');
});

// `aidrian audits` in a project whose config.json puts the state folder in a temporary folder.
function project(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'aidrian-audits-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  mkdirSync(path.join(root, '.aidrian/knowledge'), { recursive: true });
  writeFileSync(path.join(root, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  const audits = path.join(state, 'audits');
  mkdirSync(audits, { recursive: true });
  for (const name of [NEW, OLD]) copyFileSync(path.join(FIXTURES, name), path.join(audits, name));
  mkdirSync(path.join(audits, NEW.replace(/\.md$/u, '')));
  for (const shot of SHOTS) writeFileSync(path.join(audits, NEW.replace(/\.md$/u, ''), shot), '');
  const run = (...args) => spawnSync(AIDRIAN, ['audits', ...args], { cwd: root, encoding: 'utf8' });
  return { root, audits, run };
}

test('aidrian audits: list, import after review, pending, and record every decision until the report is triaged', (t) => {
  const { audits, run } = project(t);
  let result = run('list');
  assert.equal(result.status, 0, result.stderr);
  // A replaced run never reads as done while its findings wait for the import to sort them.
  assert.match(result.stdout, new RegExp(`\n- ${OLD_TITLE}: replaced by ${NEW_TITLE.toLowerCase()}; its 3 findings have no decision yet, and wait for that report's import to sort them\n- ${NEW_TITLE}: 11 findings, no sidecar: import needed, then sort the 3 findings of the run it replaces\n`, 'u'));
  assert.doesNotMatch(result.stdout, /triaged|nothing of it is left/u);
  noIds(result.stdout);
  assert.deepEqual(JSON.parse(run('list', '--json').stdout).map((r) => [r.report, r.status, r.findings, r.untriaged]), [[OLD, 'replaced', 3, 0], [NEW, 'no-sidecar', 11, 18]]);
  assert.deepEqual(JSON.parse(run('list', '--json').stdout).map((r) => r.awaiting_sort), [3, 3]);
  assert.match(run('record', NEW, 'F1', 'defer').stderr, /no sidecar: import needed/, 'a report needs its sidecar before a decision');

  result = run('import', NEW);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).findings.length, 11);
  assert.match(result.stderr, new RegExp(`^warning: This run replaces ${OLD_TITLE.toLowerCase()}\\. Sort each of its findings: carried forward, when a finding of this run covers it, or not re-checked, when this run did not look at it\\.\n`, 'mu'));
  assert.match(result.stderr, new RegExp([
    'Next: sort the earlier run\'s findings with the Human, then write the sidecar. Each finding, with the key the flags take:',
    '  - "the part note sits behind a collapsed "Optional" section": key F1',
    '  - "the second language names the drop-in three ways": key F2',
    '  - "the second language mixes formal and informal address": key F3',
    'Move the key of each finding a finding of this run covers to --carried-forward, and keep the rest in --not-rechecked:',
    `  aidrian audits import ${NEW} --not-rechecked F1,F2,F3 --carried-forward '' --write`,
  ].map((line) => line.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\n') + '\n$', 'u'), 'the plain import ends with the next step, each finding led by its title');
  noIds(result.stderr);
  const jsonWarnings = JSON.parse(run('import', NEW, '--json').stdout).warnings.join('\n');
  assert.match(jsonWarnings, /:\n {2}- "the part note sits behind a collapsed "Optional" section"\n {2}- "the second language names the drop-in three ways"/u, '--json lists the titles in the warning');
  const envelope = JSON.parse(run('import', NEW, '--json').stdout);
  assert.deepEqual(envelope.replaced.map((one) => one.id), ['F1', 'F2', 'F3'], '--json maps each title to the key the flags take');
  assert.equal(envelope.draft.findings.length, 11);
  assert.equal(existsSync(path.join(audits, 'front-desk-2026-05-02-2.json')), false, 'the draft is shown, not written');
  result = run('import', NEW, '--not-rechecked', 'F1,F2', '--carried-forward', 'F1', '--write');
  assert.match(result.stderr, /"the part note sits behind a collapsed "Optional" section" also in carried_forward/);
  noIds(result.stderr);
  result = run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.match(run('list').stdout, new RegExp(`\n- ${OLD_TITLE}: replaced by ${NEW_TITLE.toLowerCase()}, which triages the 2 findings of it not re-checked\n`, 'u'));
  assert.match(run('import', NEW, '--write').stderr, /The sidecar exists already, and a sidecar is never overwritten/);
  result = run('check', NEW);
  assert.match(result.stderr, /- finding "the part-to-order note is not on the board card" cites a screenshot by its suffix alone, "-24\.jpg"/, 'the old prose keeps its shorthand, and check names it');
  noIds(result.stderr, audits);

  result = run('pending', NEW);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('## ')), [
    '## Blocker, for the screens and their code',
    '## Friction, for the server and the answers it gives',
    '## Friction, for the screens and their code',
    '## Friction, for what the product should do, and its rules',
    '## Friction, for how the product flows and what its words say',
    '## Polish, for how the product flows and what its words say',
    `## Not re-checked from ${OLD_TITLE.toLowerCase()}`,
    '## Not reached: follow-ups for a rerun',
    '## Persona doc gaps',
  ]);
  assert.match(result.stdout, /\n- the second language names the drop-in three ways\n- the second language mixes formal and informal address\n- The second language: not walked; the read-only report's second-language findings stand unverified\. \(covered by the findings above\)\n## Not reached: follow-ups for a rerun\n- Tablet width/u, 'a Not reached line that restates them is offered with the not re-checked findings, once');
  assert.doesNotMatch(result.stdout, /collapsed "Optional" section/u, 'a carried-forward finding is not offered again');
  noIds(result.stdout);

  assert.match(run('record', NEW, 'F1', 'issue').stderr, /issue needs --issue KEY or --url URL/);
  assert.match(run('record', NEW, 'F8', 'drop').stderr, /drop needs --reason/);
  assert.match(run('record', NEW, 'F12', 'defer').stderr, /^One key names no item open to triage through the front-desk walk on 2026-05-02, so nothing was recorded/u);
  result = run('record', OLD, 'F1', 'defer');
  assert.match(result.stderr, /^One key names no item open to triage through the front-desk read-only run on 2026-05-02/u, 'only the findings the new run did not re-check');
  noIds(result.stderr);
  const pendingJson = JSON.parse(run('pending', NEW, '--json').stdout);
  const [blocker] = pendingJson.groups[0].items;
  assert.equal(blocker.source, `Source: the front-desk walk on 2026-05-02, finding "a drop-in is not shown as a drop-in" (${path.join(audits, NEW)})`);
  assert.equal(blocker.audit_key, `${NEW}#F1`);
  assert.match(run('record', NEW, 'F1', 'maybe').stderr, /decision must be issue, fix-now, duplicate, drop, defer/);
  result = run('record', NEW, 'F1', 'issue', '--issue', 'ABC-1', '--url', 'https://tracker.example.com/ABC-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `recorded "a drop-in is not shown as a drop-in": issue\n16 untriaged left in ${NEW_TITLE.toLowerCase()}\n`);
  assert.equal(run('record', OLD, 'F2', 'duplicate', '--issue', 'ABC-2').status, 0);
  for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'N1', 'N3', 'D1']) {
    assert.equal(run('record', NEW, id, 'defer').status, 0);
  }
  assert.match(run('record', NEW, 'N2', 'covered').stderr, /covered needs --reason/);
  assert.equal(run('record', NEW, 'N2', 'covered', '--reason', 'decided with the findings the walk did not re-check').status, 0);
  result = run('record', OLD, 'F3', 'drop', '--reason', 'covered by the next second-language pass');
  assert.equal(result.stdout, `recorded "the second language mixes formal and informal address": drop\n${NEW_TITLE} is fully triaged\n`);
  noIds(result.stdout);
  const triage = JSON.parse(readFileSync(path.join(audits, 'triage.json'), 'utf8'));
  assert.deepEqual(triage.reports[NEW].F1, { decision: 'issue', issue: 'ABC-1', url: 'https://tracker.example.com/ABC-1', reason: null, doc: null, by: null, date: triage.reports[NEW].F1.date });
  assert.deepEqual(triage.reports[OLD].F3.reason, 'covered by the next second-language pass');
  assert.match(run('list').stdout, new RegExp(`- ${OLD_TITLE}: replaced by ${NEW_TITLE.toLowerCase()}; nothing of it is left to triage\n- ${NEW_TITLE}: 11 findings, fully triaged\n`, 'u'));
  assert.equal(run('pending', NEW).stdout, `${NEW_TITLE}: fully triaged\n`);
  assert.equal(auditNudge(audits), '');

  writeFileSync(path.join(audits, 'triage.json'), '{ cut short');
  assert.match(run('record', NEW, 'F1', 'defer').stderr, /nothing was recorded/);
  assert.equal(readFileSync(path.join(audits, 'triage.json'), 'utf8'), '{ cut short', 'an unreadable record is never replaced');
});

test('aidrian audits check passes a new run whose sidecar and prose agree', (t) => {
  const { audits, run } = project(t);
  const value = sidecar();
  writeFileSync(path.join(audits, value.report), '# Persona audit\n\n## Findings\n\n### blocker: a drop-in is not shown as a drop-in\n\n### friction: the saved bench differs from the one shown\n');
  writeFileSync(path.join(audits, 'front-desk-2026-06-01.json'), JSON.stringify(value));
  let failed = run('check', value.report);
  assert.match(failed.stderr, /^- finding "a drop-in is not shown as a drop-in": evidence "front-desk-2026-06-01\/shot-1\.png" names no file/mu);
  noIds(failed.stderr, audits);
  mkdirSync(path.join(audits, 'front-desk-2026-06-01'));
  for (const n of [1, 2, 3]) writeFileSync(path.join(audits, `front-desk-2026-06-01/shot-${n}.png`), '');
  const result = run('check', value.report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok: the sidecar of the front-desk walk on 2026-06-01: 2 findings, 1 not reached, 1 doc gaps\n');
  assert.equal(result.stderr, '', 'a task named by its title draws no warning');
  // A task named by its number: the check still passes, and warns.
  writeFileSync(path.join(audits, value.report), `${readFileSync(path.join(audits, value.report), 'utf8')}\n## Persona doc gaps\n\n- Task 2 joins three outcomes in one success line.\n`);
  const numbered = run('check', value.report);
  assert.equal(numbered.status, 0, numbered.stderr);
  assert.equal(numbered.stderr, 'warning: the report says "Task 2", which no reader can place: name the task by its title\n');
  assert.match(run('list').stdout, /- The front-desk walk on 2026-06-01: 2 findings, 4 of 4 items untriaged\n/);
});

test('the sidecar example persona-audit ships is valid, and its owner words are the ones the import writes', () => {
  const format = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/persona-audit/references/report-format.md'), 'utf8');
  const example = JSON.parse(/## The sidecar[\s\S]*?```json\n([\s\S]*?)```/u.exec(format)[1]);
  assert.deepEqual(sidecarProblems(example), []);
  const words = Object.fromEntries([...format.replace(/\s+/gu, ' ').matchAll(/"([^"]+)" \(`([a-z-]+)`\)/gu)].map(([, text, role]) => [role, text]));
  for (const role of ['ux-specialist', 'designer', 'frontend-developer', 'backend-developer', 'product-manager']) assert.equal(words[role], OWNER_WORDS[role], role);
  assert.deepEqual(proseShorthand(format), ['-24.jpg'], 'the format cites no screenshot by its suffix, but in the rule against it');
});

test('each issue gets the configured labels: plain ones as they are, one persona label per persona, and its severity', () => {
  const labels = ['persona-audit', 'persona:{persona}', 'severity:{severity}', '{persona}-{severity}'];
  assert.deepEqual(issueLabels(labels, { personas: ['front-desk', 'owner'], severity: 'friction' }), [
    'persona-audit', 'persona:front-desk', 'persona:owner', 'severity:friction', 'front-desk-friction', 'owner-friction',
  ]);
  assert.deepEqual(issueLabels(labels, { id: 'N1', text: 'Tablet width' }, ['front-desk']), ['persona-audit', 'persona:front-desk'], 'a Not reached line takes the report\'s personas and no severity');
  assert.deepEqual(searchLabels(labels), ['persona-audit']);
});

test('pending --json carries the issue creation mode, the duplicate search label, and each item\'s labels from config.json', (t) => {
  const { root, run } = project(t);
  assert.equal(run('import', NEW, '--not-rechecked', 'F2', '--carried-forward', 'F1', '--write').status, 0);
  let out = JSON.parse(run('pending', NEW, '--json').stdout);
  assert.deepEqual([out.issue_creation, out.search_labels], ['confirm', ['persona-audit']]);
  assert.deepEqual(out.groups[0].items[0].labels, ['persona-audit', 'persona:front-desk', 'severity:blocker']);
  assert.deepEqual(out.groups.find((g) => g.kind === 'not_reached').items[0].labels, ['persona-audit', 'persona:front-desk']);
  assert.match(run('pending', NEW).stdout, /^Issues: each draft is shown to the Human before it is created\.\nDuplicates: open issues labelled persona-audit are searched first\.\n/u);

  const configFile = path.join(root, '.aidrian/config.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  writeFileSync(configFile, JSON.stringify({ ...config, audits: { triage: { issueCreation: 'auto', labels: ['ux-audit', 'sev-{severity}'] } } }));
  out = JSON.parse(run('pending', NEW, '--json').stdout);
  assert.deepEqual([out.issue_creation, out.search_labels, out.groups[0].items[0].labels], ['auto', ['ux-audit'], ['ux-audit', 'sev-blocker']]);
  writeFileSync(configFile, JSON.stringify({ ...config, audits: { triage: { issueCreation: 'always' } } }));
  const refused = run('pending', NEW, '--json');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /"audits\.triage\.issueCreation" must be "confirm" or "auto"/, 'a bad mode stops the command instead of falling back');
});

test('no text a person reads holds a bare finding id or a file suffix: list, pending, import, check, record, and the start line', (t) => {
  const { audits, run } = project(t);
  const human = [];
  // Everything but the draft sidecar `import` prints on stdout, which is the file it would write, for the commands.
  const read = (...args) => {
    const result = run(...args);
    const draft = args[0] === 'import' && !args.includes('--write');
    human.push([args.join(' '), `${draft ? '' : result.stdout}${result.stderr}`]);
    return result;
  };
  read('list');
  read('import', NEW);
  read('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F2');
  assert.equal(read('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  read('check', NEW);
  read('list');
  read('pending', NEW);
  read('record', NEW, 'F1', 'defer');
  read('record', OLD, 'F2', 'defer');
  read('record', NEW, 'F99', 'defer');
  read('pending', OLD);
  human.push(['start line', auditNudge(audits)]);
  // A second walk on the same day: told apart by an ordinal, not by its file suffix.
  copyFileSync(path.join(FIXTURES, NEW), path.join(audits, 'front-desk-2026-05-02-3.md'));
  human.push(['list, two walks on one day', read('list').stdout]);
  assert.match(human.at(-1)[1], /- The second front-desk walk on 2026-05-02: 11 findings, no sidecar: import needed[^\n]*\n/u);
  for (const [what, text] of human) {
    assert.ok(text.trim(), `${what} printed something`);
    assert.doesNotMatch(humanText(text.split(audits).join('<audits folder>')), BARE_ID, `${what}:\n${text}`);
  }
});

// The behaviour cases of the persona-audit-triage skill run with model calls, so not here; their scaffolds run here.
test('the triage eval scaffolds seed the bike-shop reports in the run folder\'s own state, without the skill under test', (t) => {
  const evals = path.join(ROOT, 'plugins/aidrian/evals');
  const dirs = [];
  const seed = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-audits-eval-'));
    dirs.push(dir);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const result = spawnSync('sh', [path.join(evals, name, 'scaffold.sh')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const list = spawnSync(path.join(dir, 'plugins/aidrian/bin/aidrian'), ['audits', 'list', '--json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.equal(existsSync(path.join(dir, 'plugins/aidrian/skills/persona-audit-triage')), false, 'the baseline arm cannot read the skill');
    assert.ok(existsSync(path.join(dir, '.eval-state/audits', NEW)), 'the reports sit in the run folder\'s state');
    return JSON.parse(list.stdout).map((r) => [r.report, r.status]);
  };
  assert.deepEqual(seed('persona-audit-triage-import'), [[OLD, 'replaced'], [NEW, 'no-sidecar']]);
  assert.deepEqual(seed('persona-audit-triage-confirm'), [[OLD, 'replaced'], [NEW, 'ok']]);
  assert.deepEqual(seed('persona-audit-triage-trigger'), [[OLD, 'replaced'], [NEW, 'ok']]);
  assert.deepEqual(seed('persona-audit-triage-no-tracker'), [[OLD, 'replaced'], [NEW, 'ok']]);

  // What the run reads: screenshots a session can open, the product doc the walk cites, and a tracker with no network.
  const [confirm, noTracker] = dirs.slice(1, 2).concat(dirs[3]);
  const shots = path.join(confirm, '.eval-state/audits/front-desk-2026-05-02-2');
  const jpeg = readFileSync(path.join(shots, SHOTS[0])).toString('hex');
  assert.ok(jpeg.startsWith('ffd8ff'), 'a JPEG');
  assert.ok(jpeg.includes('ffc0') && jpeg.includes('ffc4'), 'baseline, with Huffman tables: the API rejected one without');
  const png = readFileSync(path.join(shots, 'shot-1700000000022-22.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [64, 48]);
  const route = (dir, tag) => spawnSync(path.join(dir, 'plugins/aidrian/bin/aidrian-knowledge'), ['route', tag], { cwd: dir, encoding: 'utf8' }).stdout;
  assert.match(route(confirm, 'issue_tracker'), /bike-shop\/tracker\.md/u);
  assert.match(route(confirm, 'personas'), /bike-shop\/product-access\.md/u);
  assert.match(readFileSync(path.join(confirm, 'bike-shop/product-access.md'), 'utf8'), /## Open questions\n\n- May the front desk book a time that has already passed/u);
  assert.ok(existsSync(path.join(confirm, 'tracker/1-repaint-the-waiting-area.md')));
  assert.doesNotMatch(route(noTracker, 'issue_tracker'), /tracker\.md/u, 'this case\'s project names no tracker');
  assert.equal(existsSync(path.join(noTracker, 'tracker')), false);
});

test('record: decided waits for a final outcome, documented cites a doc, rank sets a priority apart from the severity, and --by names who picked', (t) => {
  const { root, audits, run } = project(t);
  assert.equal(run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  const untriagedCount = () => JSON.parse(run('list', '--json').stdout).find((r) => r.report === NEW).untriaged;
  const start = untriagedCount();

  // decided: the decision text and who took it; the item stays untriaged.
  assert.match(run('record', NEW, 'F7', 'decided', '--by', 'product-manager').stderr, /decided needs --reason, the decision itself/);
  assert.match(run('record', NEW, 'F7', 'decided', '--reason', 'block past times').stderr, /decided needs --by, who made the decision/);
  assert.match(run('record', NEW, 'F7', 'decided', '--reason', 'x', '--by', 'The PM').stderr, /--by names who made the pick: human, or the role/);
  let result = run('record', NEW, 'F7', 'decided', '--reason', 'staff may not book a time that has passed', '--by', 'product-manager');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^recorded "the desk can book a time that already passed, with no warning": decided by product-manager\n/u);
  assert.equal(untriagedCount(), start, 'a decided finding is still untriaged');
  assert.match(run('pending', NEW).stdout, /\n- the desk can book a time that already passed, with no warning \(decided by product-manager: staff may not book a time that has passed\)\n/u);

  // documented: needs a doc of the project, by path and section; a final outcome.
  assert.match(run('record', NEW, 'F11', 'documented').stderr, /documented needs --doc <path#section>/);
  assert.match(run('record', NEW, 'F11', 'documented', '--doc', 'docs/hours.md').stderr, /documented needs --doc <path#section>/, 'a path alone names no section');
  assert.match(run('record', NEW, 'F11', 'documented', '--doc', 'docs/hours.md#opening').stderr, /--doc names no file in the project/);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/hours.md'), '# Hours\n\n## Opening\n');
  assert.equal(run('record', NEW, 'F11', 'documented', '--doc', 'docs/hours.md#opening').status, 0);
  assert.equal(untriagedCount(), start - 1, 'documented is final');

  // rank: a priority with who set it, kept apart from the severity, shown by pending, first in its group.
  assert.match(run('rank', NEW, 'F6', 'top', '--by', 'product-manager').stderr, /priority must be urgent, high, medium, low/);
  assert.match(run('rank', NEW, 'F6', 'urgent').stderr, /a priority needs --by/);
  assert.equal(run('rank', NEW, 'F1', 'medium', '--by', 'product-manager', '--reason', 'staff can still seat them').status, 0);
  assert.equal(run('rank', NEW, 'F6', 'urgent', '--by', 'human').status, 0);
  const text = run('pending', NEW).stdout;
  assert.match(text, /## Blocker, for the screens and their code\n- a drop-in is not shown as a drop-in \(priority medium, set by product-manager\)\n/u, 'the severity stays; the priority shows beside it');
  assert.match(text, /## Friction, for the screens and their code\n- old messages stay on screen and say the wrong thing \(priority urgent, set by the Human\)\n- the move list/u, 'a set priority comes first in its group');
  assert.equal(untriagedCount(), start - 1, 'a priority is no decision');
  // A later decision keeps the priority, and the sidecar's severity is never rewritten.
  assert.equal(run('record', NEW, 'F1', 'issue', '--issue', 'ABC-9', '--by', 'ux-specialist').status, 0);
  const triage = JSON.parse(readFileSync(path.join(audits, 'triage.json'), 'utf8')).reports[NEW];
  assert.deepEqual([triage.F1.decision, triage.F1.by, triage.F1.priority.value, triage.F1.priority.set_by], ['issue', 'ux-specialist', 'medium', 'product-manager']);
  assert.equal(triage.F7.reason, 'staff may not book a time that has passed');
  assert.equal(triage.F11.doc, 'docs/hours.md#opening');
  const sidecar = JSON.parse(readFileSync(path.join(audits, 'front-desk-2026-05-02-2.json'), 'utf8'));
  assert.equal(sidecar.findings[0].severity, 'blocker');
  noIds(text);
});

test('record takes the audit_key pending prints, so a walk and the run it replaces never mix up one id; several keys land whole or not at all', (t) => {
  const { root, audits, run } = project(t);
  assert.equal(run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  const triage = () => JSON.parse(readFileSync(path.join(audits, 'triage.json'), 'utf8')).reports;

  // pending --json gives each item its key and the exact command that records it.
  const items = JSON.parse(run('pending', NEW, '--json').stdout).groups.flatMap((g) => g.items);
  const older = items.find((i) => i.kind === 'not_rechecked' && i.id === 'F2');
  assert.equal(older.audit_key, `${OLD}#F2`);
  assert.equal(older.record, `aidrian audits record ${NEW} '${OLD}#F2'`);
  assert.equal(items.find((i) => i.kind === 'finding' && i.id === 'F2').record, `aidrian audits record ${NEW} '${NEW}#F2'`);

  // Both reports hold an F2: the key through the walk lands on the replaced run's, a bare id on the walk's own.
  let result = run('record', NEW, `${OLD}#F2`, 'defer');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^recorded "the second language names the drop-in three ways": defer\n/u);
  assert.deepEqual([triage()[OLD]?.F2?.decision, triage()[NEW]?.F2], ['defer', undefined], 'the replaced run\'s finding, not the walk\'s');
  assert.equal(run('record', NEW, 'F2', 'drop', '--reason', 'seen once').status, 0);
  assert.deepEqual([triage()[OLD].F2.decision, triage()[NEW].F2.decision], ['defer', 'drop']);
  assert.match(run('record', NEW, `${OLD}#F1`, 'defer').stderr, /One key names no item open to triage/u, 'a carried-forward finding is offered by no report');

  // Several keys in one call: every one valid, or nothing is written.
  const before = readFileSync(path.join(audits, 'triage.json'), 'utf8');
  result = run('record', NEW, `F8,F99,${OLD}#F7`, 'defer');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^2 keys name no item open to triage through the front-desk walk on 2026-05-02, so nothing was recorded/u);
  assert.equal(readFileSync(path.join(audits, 'triage.json'), 'utf8'), before, 'nothing written');
  result = run('record', NEW, `F8,F9, F10,${OLD}#F3`, 'issue', '--issue', 'ABC-7');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter(Boolean), [
    'recorded "Fast entry has no place for a note": issue',
    'recorded "the drop-in screen is titled "Fast entry"": issue',
    'recorded "the Created message names no customer or bench": issue',
    'recorded "the second language mixes formal and informal address": issue',
    '11 untriaged left in the front-desk walk on 2026-05-02',
  ]);
  assert.deepEqual(['F8', 'F9', 'F10'].map((id) => triage()[NEW][id].issue).concat(triage()[OLD].F3.issue), ['ABC-7', 'ABC-7', 'ABC-7', 'ABC-7']);
  assert.equal(run('rank', NEW, 'F4,F6', 'high', '--by', 'product-manager').status, 0, 'rank takes several keys too');
  assert.deepEqual(['F4', 'F6'].map((id) => triage()[NEW][id].priority.value), ['high', 'high']);
  noIds(result.stdout);

  // --doc: the heading as written or its slug, checked against the doc's headings, stored as the slug.
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/rules.md'), '# Rules\n\n## Known Gaps / Do Not Infer\n\n## Opening hours\n');
  assert.equal(run('record', NEW, 'F11', 'documented', '--doc', 'docs/rules.md#Known Gaps / Do Not Infer').status, 0);
  assert.equal(triage()[NEW].F11.doc, 'docs/rules.md#known-gaps--do-not-infer');
  assert.equal(run('record', NEW, 'F5', 'documented', '--doc', 'docs/rules.md#opening-hours').status, 0, 'the slug works too');
  result = run('record', NEW, 'F7', 'documented', '--doc', 'docs/rules.md#Closing hours');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--doc names no section "Closing hours" in docs\/rules\.md; its sections are: rules, known-gaps--do-not-infer, opening-hours\. It takes a file of the project, then # and its section, as the heading is written \("docs\/rules\.md#Known gaps \/ Do not infer"\) or as its slug/u);
  assert.match(run('record', NEW, 'F7', 'documented', '--doc', 'Known Gaps').stderr, /documented needs --doc <path#section>: a file of the project, then # and its section/u);
});

test('pending marks a line of an older report that names a task by its number, and leaves the stored line as it is', (t) => {
  const { audits, run } = project(t);
  const report = 'front-desk-2026-06-02.md';
  const value = { ...sidecar(), report, date: '2026-06-02', findings: [], doc_gaps: [{ id: 'D1', text: 'Task 2 joins three outcomes in one success line.' }], not_reached: [{ id: 'N1', text: 'Tablet width.' }] };
  writeFileSync(path.join(audits, report), '# Persona audit\n');
  writeFileSync(path.join(audits, 'front-desk-2026-06-02.json'), JSON.stringify(value));
  const items = JSON.parse(run('pending', report, '--json').stdout).groups.flatMap((g) => g.items);
  assert.deepEqual(items.find((i) => i.id === 'D1').numbered_task, ['Task 2']);
  assert.equal(items.find((i) => i.id === 'D1').text, 'Task 2 joins three outcomes in one success line.', 'the stored line is never rewritten');
  assert.equal(items.find((i) => i.id === 'N1').numbered_task, undefined);
  assert.match(run('pending', report).stdout, /- Task 2 joins three outcomes in one success line\. \(as the report wrote it: say which task in words\)\n/u);
});

test('a verdict is evidence, not a decision: it cites a real section, holds back an issue or a fix until the Human decides, and outlasts later decisions', (t) => {
  const { root, audits, run } = project(t);
  assert.equal(run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/rules.md'), '# Rules\n\n## Bench headroom\n\nA bench keeps ten minutes of headroom.\n');
  const triage = () => JSON.parse(readFileSync(path.join(audits, 'triage.json'), 'utf8')).reports[NEW];
  const verdict = (id, value, reason, by = 'product-manager') => run('verdict', NEW, id, value, '--by', by, '--reason', reason);
  const RULE = '"A bench keeps ten minutes of headroom." docs/rules.md#bench-headroom';
  const pendingItem = (id) => JSON.parse(run('pending', NEW, '--json').stdout).groups.flatMap((g) => g.items).find((i) => i.report === NEW && i.id === id);
  const untriagedCount = () => JSON.parse(run('list', '--json').stdout).find((r) => r.report === NEW).untriaged;

  // The shape: a role, a reason, and for breaks and conforms a section that exists.
  assert.match(run('verdict', NEW, 'F2', 'maybe', '--by', 'product-manager', '--reason', 'x').stderr, /verdict must be breaks, conforms, silent/u);
  assert.match(run('verdict', NEW, 'F2', 'silent', '--reason', 'x').stderr, /a verdict needs --by, the role of the agent/u);
  assert.match(verdict('F2', 'silent', 'x', 'human').stderr, /a verdict needs --by, the role of the agent/u, 'the Human decides; a verdict is the product owner\'s');
  assert.match(run('verdict', NEW, 'F2', 'silent', '--by', 'product-manager').stderr, /a silent verdict needs --reason: what was searched/u);
  assert.match(verdict('F2', 'conforms', 'enough headroom').stderr, /a conforms verdict quotes the rule in --reason and cites it as path#section/u);
  assert.match(verdict('F2', 'breaks', '"x" docs/missing.md#a').stderr, /the verdict names no file in the project/u);
  assert.match(verdict('F2', 'breaks', '"x" docs/rules.md#closing').stderr, /the verdict names no section "closing" in docs\/rules\.md; its sections are: rules, bench-headroom/u);
  assert.equal(existsSync(path.join(audits, 'triage.json')), false, 'nothing recorded so far');

  // A verdict changes no state: the item stays untriaged, with no decision recorded.
  const start = untriagedCount();
  assert.equal(pendingItem('F2').held, null);
  assert.ok(pendingItem('F2').allowed_decisions.includes('issue'));
  let result = verdict('F2', 'conforms', RULE);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^recorded "the bench a repair lands on differs from the bench the form showed": verdict conforms, from product-manager\n/u);
  assert.equal(verdict('F5', 'silent', 'searched the rules and the decision records; nothing says when an undo ends').status, 0);
  assert.equal(triage().F2.decision, undefined, 'a verdict is no decision');
  assert.equal(triage().F2.verdict.value, 'conforms');
  assert.equal(untriagedCount(), start);

  // pending marks a held item and prints the decisions it can take, so a session cannot offer a refused one.
  assert.equal(pendingItem('F2').held, 'conforms');
  assert.equal(pendingItem('F2').verdict.reason, RULE);
  assert.deepEqual(pendingItem('F2').allowed_decisions, ['duplicate', 'drop', 'defer', 'documented', 'decided']);
  assert.equal(pendingItem('F5').held, 'silent');
  assert.deepEqual(pendingItem('F5').allowed_decisions, ['duplicate', 'drop', 'defer', 'decided']);
  assert.deepEqual(pendingItem('F6').allowed_decisions, ['issue', 'fix-now', 'duplicate', 'drop', 'defer', 'documented', 'decided']);
  assert.ok(pendingItem('N2').allowed_decisions.includes('covered'), 'only a line that restates the findings not re-checked');
  assert.match(run('pending', NEW).stdout, /\(verdict conforms, from product-manager; the Human decides before any draft\)\n/u);

  // record enforces the same rule: one held key writes nothing.
  const before = readFileSync(path.join(audits, 'triage.json'), 'utf8');
  result = run('record', NEW, 'F2,F6', 'issue', '--issue', 'ABC-1');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Nothing was recorded\. Issue is not open for:\n- "the bench a repair lands on differs from the bench the form showed": the verdict is that the product conforms to the rule, so the Human decides first/u);
  noIds(result.stderr);
  assert.match(run('record', NEW, 'F5', 'fix-now').stderr, /the verdict is that no rule settles it, so the Human decides first/u);
  assert.match(run('record', NEW, 'F5', 'documented', '--doc', 'docs/rules.md#rules').stderr, /the verdict is that the docs do not settle it/u);
  assert.match(run('record', NEW, 'F6', 'covered', '--reason', 'x').stderr, /it does not restate the findings not re-checked/u);
  assert.equal(readFileSync(path.join(audits, 'triage.json'), 'utf8'), before);

  // An agent's own decision releases nothing; the Human's does, and the verdict outlasts every later decision.
  assert.equal(run('record', NEW, 'F2', 'decided', '--reason', 'show the saved bench first', '--by', 'ux-specialist').status, 0);
  assert.equal(pendingItem('F2').held, 'conforms');
  assert.match(run('record', NEW, 'F2', 'issue', '--issue', 'ABC-1').stderr, /the Human decides first/u);
  assert.equal(run('record', NEW, 'F2', 'decided', '--reason', 'show the saved bench before saving', '--by', 'human').status, 0);
  assert.equal(pendingItem('F2').held, null, 'released');
  assert.ok(pendingItem('F2').allowed_decisions.includes('issue'));
  assert.equal(run('record', NEW, 'F2', 'defer').status, 0);
  assert.equal(run('record', NEW, 'F2', 'issue', '--issue', 'ABC-1').status, 0, 'a defer between keeps the release');
  assert.equal(triage().F2.decision, 'issue');
  assert.deepEqual([triage().F2.verdict.value, triage().F2.verdict.by, triage().F2.verdict.settled.reason], ['conforms', 'product-manager', 'show the saved bench before saving']);

  // Held after a defer too, and a new verdict after a release holds again. breaks holds nothing.
  assert.equal(verdict('F4', 'silent', 'searched the rules').status, 0);
  assert.equal(run('record', NEW, 'F4', 'decided', '--reason', 'warn first', '--by', 'human').status, 0);
  assert.equal(verdict('F4', 'conforms', RULE).status, 0);
  assert.equal(pendingItem('F4').held, 'conforms');
  assert.equal(run('record', NEW, 'F5', 'defer', '--reason', 'waits for the Human').status, 0);
  assert.match(run('record', NEW, 'F5', 'issue', '--issue', 'ABC-2').stderr, /the Human decides first/u);
  assert.equal(verdict('F3', 'conforms', RULE).status, 0);
  assert.equal(run('record', NEW, 'F3', 'documented', '--doc', 'docs/rules.md#bench-headroom').status, 0);
  assert.equal(verdict('F7', 'breaks', RULE).status, 0);
  assert.equal(run('record', NEW, 'F7', 'issue', '--issue', 'ABC-3').status, 0);
  assert.equal(run('rank', NEW, 'F7', 'high', '--by', 'human').status, 0);
  assert.deepEqual([triage().F7.verdict.value, triage().F7.priority.value], ['breaks', 'high'], 'a priority and a verdict keep each other');
  assert.equal(triage().F2.history, undefined);
});

test('a sidecar that parses to anything but an object is one invalid report: list, pending, record, and the start line keep working', (t) => {
  const { root, audits, run } = project(t);
  const report = 'front-desk-2026-06-02.md';
  const file = path.join(audits, 'front-desk-2026-06-02.json');
  writeFileSync(path.join(audits, report), '## Findings\n\n### polish: a label is cut off\n\n- Owner: `ux-specialist`.\n');
  assert.equal(run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  for (const value of ['null', 'false', '0', '""', '[]', '"text"', '12']) {
    writeFileSync(file, value);
    const list = run('list');
    assert.equal(list.status, 0, `${value}: ${list.stderr}`);
    assert.match(list.stdout, /- The front-desk audit on 2026-06-02: |- The front-desk read-only run on 2026-06-02: /u, value);
    assert.match(list.stdout, /invalid sidecar: the sidecar must be a JSON object/u, value);
    assert.match(auditNudge(audits), /^Audit inbox: \d+ untriaged findings in 2 reports\./u, value);
    const listed = JSON.parse(run('list', '--json').stdout).find((r) => r.report === report);
    assert.deepEqual([listed.status, listed.findings], ['invalid', 1], value);
    assert.equal(run('pending', NEW).status, 0, 'another report still works');
    assert.match(run('pending', report).stderr, /invalid sidecar: the sidecar must be a JSON object/u, value);
    assert.match(run('record', report, 'F1', 'defer').stderr, /invalid sidecar: the sidecar must be a JSON object/u, value);
    assert.match(run('check', report).stderr, /the sidecar must be a JSON object/u, value);
    assert.equal(run('record', NEW, 'F11', 'defer').status, 0, 'and can still be recorded');
  }
  // The start line through the hook, with a sidecar of JSON null beside a good report.
  writeFileSync(file, 'null');
  const hook = spawnSync(process.execPath, [path.join(ROOT, 'plugins/aidrian/scripts/hook-session-start.mjs')], { input: JSON.stringify({ cwd: root }), cwd: root, encoding: 'utf8' });
  assert.equal(hook.status, 0);
  assert.match(hook.stdout, /^Audit inbox: \d+ untriaged findings in 2 reports\./mu);
  // A draft file with the same values is refused, not a crash.
  const draft = path.join(root, 'draft.json');
  for (const value of ['null', 'false', '[]']) {
    writeFileSync(draft, value);
    const result = run('import', report, '--from', draft);
    assert.deepEqual([result.status, result.stderr], [1, `${draft}: the sidecar must be a JSON object\n`], value);
  }
  // A triage record no command can read stops each with one line, never a stack trace.
  writeFileSync(path.join(audits, 'triage.json'), '{ cut short');
  for (const args of [['list'], ['pending', NEW], ['check', NEW], ['import', report]]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /triage\.json: invalid JSON/u, args.join(' '));
    assert.doesNotMatch(result.stderr, /\n\s+at /u, args.join(' '));
  }
});

test('a key resolves only within the selected report and the run it replaces: another report is never written, by record, rank, or verdict', (t) => {
  const { root, audits, run } = project(t);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs/rules.md'), '# Rules\n');
  assert.equal(run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write').status, 0);
  const other = 'floor-staff-2026-07-01.md';
  writeFileSync(path.join(audits, other), '## Findings\n\n### polish: an unrelated label\n\n- Owner: `ux-specialist`.\n');
  writeFileSync(path.join(audits, 'floor-staff-2026-07-01.json'), JSON.stringify({ ...sidecar(), report: other, personas: ['floor-staff'], date: '2026-07-01', findings: [{ ...sidecar().findings[0], id: 'F1', title: 'an unrelated label', severity: 'polish', evidence: [], cited: ['x.md:1'] }] }));
  assert.equal(run('check', other).stderr, '');
  const triageFile = path.join(audits, 'triage.json');

  // A mixed batch with one key of an unrelated report writes nothing; the same key alone is refused too.
  for (const args of [
    ['record', NEW, `F4,${other}#F1`, 'drop', '--reason', 'x'],
    ['record', NEW, `${other}#F1`, 'drop', '--reason', 'x'],
    ['record', other, `${NEW}#F4`, 'drop', '--reason', 'x'],
    ['rank', NEW, `F4,${other}#F1`, 'high', '--by', 'human'],
    ['verdict', NEW, `F4,${other}#F1`, 'silent', '--by', 'product-manager', '--reason', 'searched'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, /key names? no item open to triage through/u, args.join(' '));
    assert.equal(existsSync(triageFile), false, `${args.join(' ')} wrote nothing`);
  }

  // The selected report's own items and what it offers of the run it replaces still resolve.
  assert.equal(run('record', other, `${other}#F1`, 'defer').status, 0);
  assert.equal(run('record', NEW, `F4,${OLD}#F2`, 'defer').status, 0);
  // A replaced report selects its own findings, through the report that offers them, and nothing of that report.
  assert.equal(run('record', OLD, 'F3', 'defer').status, 0);
  assert.match(run('record', OLD, `${NEW}#F5`, 'defer').stderr, /One key names no item open to triage through the front-desk read-only run/u);
  const { reports } = JSON.parse(readFileSync(triageFile, 'utf8'));
  assert.deepEqual([Object.keys(reports[NEW]), Object.keys(reports[OLD]).sort(), Object.keys(reports[other])], [['F4'], ['F2', 'F3'], ['F1']]);
});

test('a sidecar is checked against the report it replaces: that report exists, and each key it sorts names a finding of it', (t) => {
  const { audits, run } = project(t);
  const file = path.join(audits, 'front-desk-2026-05-02-2.json');
  const write = (changes) => {
    const draft = JSON.parse(run('import', NEW, '--json').stdout).draft;
    writeFileSync(file, JSON.stringify({ ...draft, ...changes }));
  };
  const entry = () => JSON.parse(run('list', '--json').stdout).find((r) => r.report === NEW);

  // import refuses an unknown key, naming no id.
  let result = run('import', NEW, '--not-rechecked', 'F2,F999', '--carried-forward', 'F1', '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /carried_forward and not_rechecked: 1 key names no finding of the front-desk read-only run on 2026-05-02/u);
  noIds(result.stderr);
  assert.equal(existsSync(file), false);

  // A sidecar already on disk with an unknown key is one invalid report: no placeholder finding, and the real items wait.
  write({ not_rechecked: ['F2', 'F999'] });
  assert.deepEqual([entry().status, entry().problems], ['invalid', ['carried_forward and not_rechecked: 1 key names no finding of the front-desk read-only run on 2026-05-02']]);
  assert.doesNotMatch(run('list').stdout, /no longer holds/u);
  assert.match(run('list').stdout, /replaced by the front-desk walk on 2026-05-02; its 3 findings have no decision yet/u, 'the replaced report\'s findings still wait for the sort');
  assert.match(run('check', NEW).stderr, /- carried_forward and not_rechecked: 1 key names no finding/u);
  assert.match(run('pending', NEW).stderr, /invalid sidecar: carried_forward and not_rechecked: 1 key names no finding/u);
  assert.match(run('record', NEW, 'F1', 'defer').stderr, /invalid sidecar/u);

  // The report it replaces is gone: a clear problem, and with no such report nothing is hidden.
  write({ not_rechecked: ['F2', 'F3'], carried_forward: ['F1'] });
  assert.equal(entry().status, 'ok', 'a real sidecar stays valid');
  rmSync(path.join(audits, OLD));
  const gone = /supersedes: names the front-desk audit on 2026-05-02, which is not in the audits folder: restore it, or write the sidecar with supersedes null/u;
  assert.equal(entry().status, 'invalid');
  assert.match(entry().problems[0], gone);
  assert.match(run('check', NEW).stderr, gone);
  rmSync(file);
  result = run('import', NEW, '--write');
  assert.equal(result.status, 1);
  assert.match(result.stderr, gone);
  noIds(result.stderr);
  // With supersedes null, through a draft file, it imports.
  const draft = path.join(audits, 'draft.json');
  const parsed = JSON.parse(run('import', NEW, '--json').stdout).draft;
  writeFileSync(draft, JSON.stringify({ ...parsed, supersedes: null, not_reached: parsed.not_reached.map(({ covered_by: coveredBy, ...line }) => line) }));
  assert.equal(run('import', NEW, '--from', draft, '--write').status, 0);
  assert.equal(entry().status, 'ok');
});
