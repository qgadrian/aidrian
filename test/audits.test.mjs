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
  assert.deepEqual(draft.doc_gaps, [{ id: 'D1', text: 'Task 2 joins check-in, hand-back and drop-in in one success line, so one missing label blocks the whole task.' }]);
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
  assert.match(run('record', NEW, 'F12', 'defer').stderr, /offers no item with that key to triage/);
  result = run('record', OLD, 'F1', 'defer');
  assert.match(result.stderr, /^The front-desk read-only run on 2026-05-02 offers no item with that key/u, 'only the findings the new run did not re-check');
  noIds(result.stderr);
  const pendingJson = JSON.parse(run('pending', NEW, '--json').stdout);
  const [blocker] = pendingJson.groups[0].items;
  assert.equal(blocker.source, `Source: the front-desk walk on 2026-05-02, finding "a drop-in is not shown as a drop-in" (${path.join(audits, NEW)})`);
  assert.equal(blocker.audit_key, `${NEW}#F1`);
  assert.match(run('record', NEW, 'F1', 'maybe').stderr, /decision must be issue, fix-now, duplicate, drop, defer/);
  result = run('record', NEW, 'F1', 'issue', '--issue', 'ABC-1', '--url', 'https://tracker.example.com/ABC-1');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `recorded "a drop-in is not shown as a drop-in": issue; 16 untriaged left in ${NEW_TITLE.toLowerCase()}\n`);
  assert.equal(run('record', OLD, 'F2', 'duplicate', '--issue', 'ABC-2').status, 0);
  for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'N1', 'N3', 'D1']) {
    assert.equal(run('record', NEW, id, 'defer').status, 0);
  }
  assert.match(run('record', NEW, 'N2', 'covered').stderr, /covered needs --reason/);
  assert.equal(run('record', NEW, 'N2', 'covered', '--reason', 'decided with the findings the walk did not re-check').status, 0);
  result = run('record', OLD, 'F3', 'drop', '--reason', 'covered by the next second-language pass');
  assert.equal(result.stdout, `recorded "the second language mixes formal and informal address": drop; ${NEW_TITLE} is fully triaged\n`);
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
  const seed = (name) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-audits-eval-'));
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
  assert.match(result.stdout, /^recorded "the desk can book a time that already passed, with no warning": decided by product-manager; /u);
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
