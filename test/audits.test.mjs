import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseReport } from '../plugins/aidrian/lib/audit-import.mjs';
import { auditNudge, evidenceProblem, listAudits, OWNER_WORDS, pendingGroups, proseProblems, proseShorthand, sidecarProblems } from '../plugins/aidrian/lib/audits.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const AIDRIAN = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
// A synthetic report in the shape of a real walk: 11 findings, a run that replaces an earlier report, Not reached and
// doc gap sections, and screenshots cited by suffix alone (`-24.jpg`), as reports written before sidecars did.
const FIXTURES = path.join(ROOT, 'test/fixtures/persona-audit');
const NEW = 'front-desk-2026-05-02-2.md';
const OLD = 'front-desk-2026-05-02.md';
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
    doc_gaps: [{ id: 'D1', text: 'Task 2 joins three outcomes in one success line.' }],
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
    [sidecar({ supersedes: 'front-desk-2026-05-02.md', carried_forward: ['F1'], not_rechecked: ['F1', 'F2'] }), /F1 also in carried_forward: a finding is listed once/],
    [sidecar({ supersedes: 'front-desk-2026-06-01.md' }), /a report cannot replace itself/],
    [sidecar({ not_reached: [{ id: 'F1', text: 'x' }] }), /not_reached\[0\]\.id: must be N1, N2/],
    [sidecar({ findings: [sidecar().findings[0], { ...sidecar().findings[1], id: 'F1' }] }), /findings: F1 used twice/],
    [sidecar({ date: 'today' }), /date: must be YYYY-MM-DD/],
  ];
  for (const [value, pattern] of cases) assert.match(sidecarProblems(value).join('\n'), pattern);
  assert.match(sidecarProblems(sidecar(), { report: 'other-2026-06-01.md' }).join('\n'), /names front-desk-2026-06-01\.md, but the sidecar belongs to other/);
});

test('with the audits folder, evidence must name a file there', (t) => {
  const dir = auditsDir(t);
  assert.equal(evidenceProblem(`front-desk-2026-05-02-2/${SHOTS[0]}`, dir), null);
  assert.match(evidenceProblem('front-desk-2026-05-02-2/shot-missing.png', dir), /names no file in/);
});

test('the prose report may not cite a screenshot by its suffix, and its findings match the sidecar', () => {
  const text = readFileSync(path.join(FIXTURES, NEW), 'utf8');
  const problems = proseProblems(text, { findings: Array.from({ length: 11 }, (_, i) => ({ id: `F${i + 1}` })) });
  assert.deepEqual(problems, ['the report cites "-32.jpg": write the full path', 'the report cites "-24.jpg": write the full path', 'the report cites "-25.jpg": write the full path', 'the report cites "-28.jpg": write the full path']);
  assert.match(proseProblems('### F1. polish: x\n', { findings: [] }).join('\n'), /the report's findings are F1, the sidecar's none/);
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
  assert.match(draft.warnings.join('\n'), /this run replaces front-desk-2026-05-02\.md: list in not_rechecked/);
  const { warnings, ...value } = draft;
  assert.deepEqual(sidecarProblems(value, { dir, report: NEW }), []);

  const unexpanded = parseReport(readFileSync(path.join(dir, NEW), 'utf8'), { report: NEW });
  assert.match(unexpanded.warnings.join('\n'), /F3: "-24\.jpg" matched no single file in the report's folder; it is left out/);
  const old = parseReport(readFileSync(path.join(dir, OLD), 'utf8'), { report: OLD });
  assert.deepEqual(old.findings.map((f) => [f.id, f.evidence_level, f.cited]), [
    ['F1', 'read', ['src/repairs/RepairForm.tsx:40']], ['F2', 'read', ['locales/es.json:12', 'locales/es.json:30']], ['F3', 'read', ['locales/es.json:44']],
  ]);
  assert.match(old.warnings.join('\n'), /F1: write owner_description, in plain words, for ux-specialist/, 'with no owner words given');
});

test('a folder of reports without sidecars counts the newest run, and the run it replaces is not counted twice', (t) => {
  const dir = auditsDir(t);
  const [old, current] = listAudits(dir);
  assert.deepEqual([old.report, old.status, old.replaced_by, old.untriaged], [OLD, 'replaced', NEW, 0]);
  assert.deepEqual([current.report, current.status, current.untriaged], [NEW, 'no-sidecar', 15]);
  assert.equal(auditNudge(dir), 'Audit inbox: 15 untriaged findings in 1 report. The persona-audit-triage skill triages them.');
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
    { kind: 'not_rechecked', id: 'F3', title: 'Spanish mixes address', report: 'front-desk-2026-05-02.md', decision: null },
    { kind: 'not_reached', ...value.not_reached[0], report: value.report, decision: null },
    { kind: 'doc_gap', ...value.doc_gaps[0], report: value.report, decision: { decision: 'defer' } },
  ];
  const groups = pendingGroups({ items });
  assert.deepEqual(groups.map((g) => [g.kind, g.title, g.items.map((i) => i.id)]), [
    ['blocker', 'Blocker F1: a drop-in is not shown as a drop-in', ['F1']],
    ['findings', 'friction, for the server and the answers it gives', ['F2']],
    ['findings', 'polish, for how the product flows and what its words say', ['F3']],
    ['not_rechecked', 'Not re-checked from front-desk-2026-05-02.md', ['F3']],
    ['not_reached', 'Not reached: follow-ups for a rerun', ['N1']],
  ]);
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
  assert.match(result.stdout, new RegExp(`- ${OLD}: replaced by ${NEW}\n- ${NEW}: 11 findings, no sidecar: import needed\n$`, 'u'));
  assert.deepEqual(JSON.parse(run('list', '--json').stdout).map((r) => [r.report, r.status, r.findings, r.untriaged]), [[OLD, 'replaced', 3, 0], [NEW, 'no-sidecar', 11, 15]]);
  assert.match(run('record', NEW, 'F1', 'defer').stderr, /no sidecar: import needed/, 'a report needs its sidecar before a decision');

  result = run('import', NEW);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).findings.length, 11);
  assert.match(result.stderr, /warning: this run replaces/);
  assert.equal(existsSync(path.join(audits, 'front-desk-2026-05-02-2.json')), false, 'the draft is shown, not written');
  assert.match(run('import', NEW, '--not-rechecked', 'F1,F2', '--carried-forward', 'F1', '--write').stderr, /F1 also in carried_forward/);
  result = run('import', NEW, '--not-rechecked', 'F2,F3', '--carried-forward', 'F1', '--write');
  assert.equal(result.status, 0, result.stderr);
  assert.match(run('import', NEW, '--write').stderr, /exists already; a sidecar is never overwritten/);
  assert.match(run('check', NEW).stderr, /the report cites "-24\.jpg": write the full path/, 'the old prose keeps its shorthand, and check names it');

  result = run('pending', NEW);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split('\n').filter((line) => line.startsWith('## ')), [
    '## Blocker F1: a drop-in is not shown as a drop-in',
    '## friction, for the server and the answers it gives',
    '## friction, for the screens and their code',
    '## friction, for what the product should do, and its rules',
    '## friction, for how the product flows and what its words say',
    '## polish, for how the product flows and what its words say',
    `## Not re-checked from ${OLD}`,
    '## Not reached: follow-ups for a rerun',
    '## Persona doc gaps',
  ]);
  assert.match(result.stdout, new RegExp(`- ${OLD} F2: Spanish names the drop-in three ways\n- ${OLD} F3: Spanish mixes formal and informal address\n`, 'u'));
  assert.doesNotMatch(result.stdout, new RegExp(`${OLD} F1:`, 'u'), 'a carried-forward finding is not offered again');

  assert.match(run('record', NEW, 'F1', 'issue').stderr, /issue needs --issue KEY or --url URL/);
  assert.match(run('record', NEW, 'F8', 'drop').stderr, /drop needs --reason/);
  assert.match(run('record', NEW, 'F12', 'defer').stderr, /has no item F12 to triage/);
  assert.match(run('record', OLD, 'F1', 'defer').stderr, /has no item F1 to triage/, 'only the findings the new run did not re-check');
  assert.match(run('record', NEW, 'F1', 'maybe').stderr, /decision must be issue, fix-now, duplicate, drop, defer/);
  result = run('record', NEW, 'F1', 'issue', '--issue', 'ABC-1', '--url', 'https://tracker.example.com/ABC-1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^recorded ${NEW} F1: issue; 16 untriaged left in ${NEW}\n$`, 'u'));
  assert.equal(run('record', OLD, 'F2', 'duplicate', '--issue', 'ABC-2').status, 0);
  for (const id of ['F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'N1', 'N2', 'N3', 'D1']) {
    assert.equal(run('record', NEW, id, 'defer').status, 0);
  }
  result = run('record', OLD, 'F3', 'drop', '--reason', 'covered by the next Spanish pass');
  assert.match(result.stdout, new RegExp(`${NEW} is fully triaged\n$`, 'u'));
  const triage = JSON.parse(readFileSync(path.join(audits, 'triage.json'), 'utf8'));
  assert.deepEqual(triage.reports[NEW].F1, { decision: 'issue', issue: 'ABC-1', url: 'https://tracker.example.com/ABC-1', reason: null, date: triage.reports[NEW].F1.date });
  assert.deepEqual(triage.reports[OLD].F3.reason, 'covered by the next Spanish pass');
  assert.match(run('list').stdout, new RegExp(`- ${NEW}: 11 findings, fully triaged\n`, 'u'));
  assert.equal(auditNudge(audits), '');

  writeFileSync(path.join(audits, 'triage.json'), '{ cut short');
  assert.match(run('record', NEW, 'F1', 'defer').stderr, /nothing was recorded/);
  assert.equal(readFileSync(path.join(audits, 'triage.json'), 'utf8'), '{ cut short', 'an unreadable record is never replaced');
});

test('aidrian audits check passes a new run whose sidecar and prose agree', (t) => {
  const { audits, run } = project(t);
  const value = sidecar();
  writeFileSync(path.join(audits, value.report), '# Persona audit\n\n## Findings\n\n### F1. blocker: x\n\n### F2. friction: y\n');
  writeFileSync(path.join(audits, 'front-desk-2026-06-01.json'), JSON.stringify(value));
  assert.match(run('check', value.report).stderr, /evidence "front-desk-2026-06-01\/shot-1\.png" names no file/);
  mkdirSync(path.join(audits, 'front-desk-2026-06-01'));
  for (const n of [1, 2, 3]) writeFileSync(path.join(audits, `front-desk-2026-06-01/shot-${n}.png`), '');
  const result = run('check', value.report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'ok: front-desk-2026-06-01.json, 2 findings, 1 not reached, 1 doc gaps\n');
  assert.match(run('list').stdout, /- front-desk-2026-06-01\.md: 2 findings, 4 of 4 items untriaged\n/);
});

test('the sidecar example persona-audit ships is valid, and its owner words are the ones the import writes', () => {
  const format = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/persona-audit/references/report-format.md'), 'utf8');
  const example = JSON.parse(/## The sidecar[\s\S]*?```json\n([\s\S]*?)```/u.exec(format)[1]);
  assert.deepEqual(sidecarProblems(example), []);
  const words = Object.fromEntries([...format.replace(/\s+/gu, ' ').matchAll(/"([^"]+)" \(`([a-z-]+)`\)/gu)].map(([, text, role]) => [role, text]));
  for (const role of ['ux-specialist', 'designer', 'frontend-developer', 'backend-developer', 'product-manager']) assert.equal(words[role], OWNER_WORDS[role], role);
  assert.deepEqual(proseShorthand(format), ['-24.jpg'], 'the format cites no screenshot by its suffix, but in the rule against it');
});
