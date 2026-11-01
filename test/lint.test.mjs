import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DEFAULTS } from '../plugins/aidrian/lib/config.mjs';
import { decodeScalar, frontmatter, lintAgents, lintPaths, lintSkills } from '../plugins/aidrian/lib/lint.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CLI = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const LIMITS = DEFAULTS.skills;
// Built at run time, so this file holds no personal path itself.
const HOME = ['', 'Users', 'ana', ''].join('/');

function tempDir(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-lint-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function skills(t, entries) {
  const dir = tempDir(t);
  for (const [name, head] of Object.entries(entries)) {
    mkdirSync(path.join(dir, name));
    writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\n${head}\n---\n\n# ${name}\n`);
  }
  return dir;
}

// A SKILL.md of exactly `bytes` bytes, padded with a three-byte character so a check that counted characters would miss.
function sized(dir, name, bytes) {
  const head = `---\nname: ${name}\ndescription: A skill of ${bytes} bytes.\n---\n\n`;
  const pad = bytes - Buffer.byteLength(head);
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), head + '—'.repeat(Math.floor(pad / 3)) + 'a'.repeat(pad % 3));
}

const MOVE = 'move detail into references/ or steps/ files that SKILL.md names';

test('the plugin`s own skills and agents pass', () => {
  assert.deepEqual(lintSkills([path.join(ROOT, 'plugins/aidrian/skills')], LIMITS).problems, []);
  assert.deepEqual(lintAgents([path.join(ROOT, 'plugins/aidrian/agents')], LIMITS).problems, []);
});

test('a skill description over the limit fails naming the file and both numbers', (t) => {
  const dir = skills(t, { ok: `description: ${'a'.repeat(160)}`, long: `description: ${'a'.repeat(161)}` });
  assert.deepEqual(lintSkills([dir], LIMITS).problems, [`${path.join(dir, 'long/SKILL.md')}: description is 161 characters; the limit is 160`]);
});

test('missing, empty, folded, and invalid YAML descriptions fail; quoted ones are measured after decoding', (t) => {
  const dir = skills(t, {
    none: 'user-invocable: true',
    empty: 'description:',
    folded: 'description: >\n  Folded text',
    continued: 'description: Starts here\n  and continues here',
    colon: 'description: Use when: anything',
    quoted: 'description: "Use when: anything"',
    single: "description: 'It''s fine'",
  });
  const problems = lintSkills([dir], LIMITS).problems.map((problem) => problem.replace(`${dir}/`, ''));
  assert.deepEqual(problems, [
    'colon/SKILL.md: description is not a one-line YAML string: a plain string cannot hold ": " or end with ":"; quote it or use " — "',
    'continued/SKILL.md: description continues on another line, which hides its length; keep it on one line',
    'empty/SKILL.md: description is empty',
    'folded/SKILL.md: description is not a one-line YAML string: a plain string cannot start with ">"; quote it',
    'none/SKILL.md: no description',
  ]);
});

test('decodeScalar rejects what a strict YAML loader reads as structure or as a non-string', () => {
  for (const raw of ['- a list', '? key', '[a]', '{a}', '#x', '&anchor', '*alias', '!tag', '|', '>', '%x', '@x', '`x']) {
    assert.ok(decodeScalar(raw).problem, raw);
  }
  for (const raw of ['null', '~', 'true', 'No', 'off', '42', '-1.5e3', '.inf', '0x1F', '2026-10-29', 'a #comment', 'ends:']) {
    assert.ok(decodeScalar(raw).problem, raw);
  }
  assert.deepEqual(decodeScalar('"a: b \\" c"'), { value: 'a: b " c' });
  assert.ok(decodeScalar("'it's'").problem, 'a lone quote inside single quotes');
  assert.deepEqual(decodeScalar('Plain text, with commas — and dashes'), { value: 'Plain text, with commas — and dashes' });
});

test('the listing limit counts every skill`s name and description, and a skill nobody can run fails', (t) => {
  const dir = skills(t, {
    a: 'description: Twenty characters ok.',
    b: 'description: Another description.\ndisable-model-invocation: true\nuser-invocable: false',
  });
  const { problems, summary } = lintSkills([dir], { ...LIMITS, listingBytes: 40 });
  assert.equal(summary, '2 skills, 43 of 40 listing bytes');
  assert.deepEqual(problems.map((problem) => problem.replace(`${dir}/`, '')), [
    'b/SKILL.md: disable-model-invocation true and user-invocable false leave nobody able to run it',
    'the 2 skills list 43 bytes of names and descriptions; the limit is skills.listingBytes, 40',
  ]);
});

test('a SKILL.md warns above 7,500 bytes and fails at 8,000, where Codex cuts it, counting bytes', (t) => {
  const dir = tempDir(t);
  for (const bytes of [7500, 7501, 7999, 8000, 8001]) sized(dir, `s${bytes}`, bytes);
  const { problems, warnings } = lintSkills([dir], LIMITS);
  const strip = (lines) => lines.map((line) => line.replace(`${dir}/`, ''));
  assert.deepEqual(strip(warnings), [
    `s7501/SKILL.md: 7501 bytes, near Codex's 8000-byte cut; ${MOVE}`,
    `s7999/SKILL.md: 7999 bytes, near Codex's 8000-byte cut; ${MOVE}`,
  ]);
  assert.deepEqual(strip(problems), [
    `s8000/SKILL.md: 8000 bytes; Codex cuts a SKILL.md at 8000, so ${MOVE}`,
    `s8001/SKILL.md: 8001 bytes; Codex cuts a SKILL.md at 8000, so ${MOVE}`,
  ]);
});

test('aidrian lint skills checks a project`s own skill folder, or the folder given, and a warning alone passes', (t) => {
  const dir = tempDir(t);
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const own = path.join(dir, '.claude/skills');
  sized(own, 'near', 7600);
  const run = (...args) => spawnSync(CLI, ['lint', 'skills', ...args], { cwd: dir, encoding: 'utf8' });
  const warned = run();
  assert.deepEqual([warned.status, warned.stderr], [0, `skills: warning: ${own}/near/SKILL.md: 7600 bytes, near Codex's 8000-byte cut; ${MOVE}\n`]);
  assert.match(warned.stdout, /^skills: 1 skills, \d+ of 9216 listing bytes\n$/);

  const other = path.join(dir, 'skills');
  sized(other, 'cut', 8000);
  const failed = run(other);
  assert.deepEqual([failed.status, failed.stderr], [1, `skills: ${other}/cut/SKILL.md: 8000 bytes; Codex cuts a SKILL.md at 8000, so ${MOVE}\n`]);
});

test('agents: name is the file name, and the model and effort are known', (t) => {
  const dir = tempDir(t);
  const agent = (file, head) => writeFileSync(path.join(dir, file), `---\n${head}\n---\nBody.\n`);
  agent('good.md', 'name: good\ndescription: Does good work.\nmodel: claude-opus-5-5\neffort: high');
  agent('renamed.md', 'name: other\ndescription: Named wrong.');
  agent('model.md', 'name: model\ndescription: Odd model.\nmodel: gpt\neffort: extreme');
  writeFileSync(path.join(dir, 'plain.md'), 'No frontmatter.\n');
  const problems = lintAgents([dir], LIMITS).problems.map((problem) => problem.replace(`${dir}/`, ''));
  assert.deepEqual(problems, [
    'model.md: model "gpt" is not one of haiku, sonnet, opus, fable, inherit, or a claude-* model id',
    'model.md: effort "extreme" is not one of low, medium, high, xhigh, max',
    'plain.md: no YAML frontmatter',
    'renamed.md: name must be "renamed", the file name',
  ]);
});

test('frontmatter reads top-level keys only', () => {
  assert.deepEqual(frontmatter('---\nname: x\ntools:\n  - Read\ndescription: d\n---\n'), { descriptionContinues: false, name: 'x', tools: '', description: 'd' });
  assert.equal(frontmatter('# no frontmatter'), null);
});

test('paths: a personal home folder in a tracked, untracked, or staged file fails; ignored files and CI and placeholder homes pass', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'a.md'), `one\nsee ${HOME}project/notes.md\n`);
  writeFileSync(path.join(dir, 'ok.md'), '/home/runner/work/x\n/home/you/kb\n/Users/example/x\n/home/\n');
  writeFileSync(path.join(dir, 'untracked.md'), `${HOME}x\n`);
  writeFileSync(path.join(dir, 'logo.png'), `${HOME}x\n`);
  writeFileSync(path.join(dir, 'ignored.md'), `${HOME}x\n`);
  writeFileSync(path.join(dir, '.gitignore'), 'ignored.md\n');
  git('add', 'a.md', 'ok.md', 'logo.png', '.gitignore');
  assert.deepEqual(lintPaths(dir).problems, [`a.md:2: a personal home folder: see ${HOME}project/notes.md`, `untracked.md:1: a personal home folder: ${HOME}x`]);
  assert.equal(lintPaths(dir).summary, 'no personal paths in 3 tracked and 1 untracked files');
  git('add', 'untracked.md');
  git('rm', '-q', '--cached', 'untracked.md');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  assert.deepEqual(lintPaths(dir, true).problems, [], 'nothing staged');
  git('add', 'untracked.md');
  assert.deepEqual(lintPaths(dir, true).problems, [`untracked.md:1: a personal home folder: ${HOME}x`]);
});

test('paths --staged reads what the index holds, so a partly staged file is judged as it will be committed', (t) => {
  const dir = tempDir(t);
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'clean.md'), 'clean\n');
  writeFileSync(path.join(dir, 'fixed.md'), `${HOME}x\n`);
  writeFileSync(path.join(dir, 'gone.md'), `${HOME}y\n`);
  git('add', '.');
  // After staging: a personal path added but not staged, one removed but not staged, and a file deleted but not staged.
  writeFileSync(path.join(dir, 'clean.md'), `${HOME}z\n`);
  writeFileSync(path.join(dir, 'fixed.md'), 'fixed in the working tree only\n');
  rmSync(path.join(dir, 'gone.md'));
  assert.deepEqual(lintPaths(dir, true).problems, [`fixed.md:1: a personal home folder: ${HOME}x`, `gone.md:1: a personal home folder: ${HOME}y`]);
  assert.deepEqual(lintPaths(dir).problems, [`clean.md:1: a personal home folder: ${HOME}z`], 'without --staged it reads the working tree');
});

test('aidrian lint runs every lint on a project and prints the always-doc budget per bucket', (t) => {
  const run = (args, cwd = ROOT) => spawnSync(CLI, ['lint', ...args], { cwd, encoding: 'utf8' });
  const all = run(['--project', 'examples/consumer']);
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /^skills: 0 skills, 0 of 9216 listing bytes\nagents: 0 agents\npaths: no personal paths in \d+ tracked and \d+ untracked files\n/);
  assert.match(all.stdout, /\nbudget: \d+ of 16384 always-doc bytes \(engineering \d+, product 0\)\nterms: no banned terms in \d+ tracked files \(2 rules\)\nreview: 0 flows, 0 project reviewers, all pointing at real files\n$/);

  const dir = tempDir(t);
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'kb'));
  const budget = (alwaysBytes) => {
    writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, knowledge: { budgets: { alwaysBytes } } }));
    return run(['budget'], dir);
  };
  writeFileSync(path.join(dir, 'kb/rules.md'), '# Rules\n\nAlways read this.\n');
  writeFileSync(path.join(dir, '.aidrian/knowledge/kb.json'), JSON.stringify({ dir: 'kb', description: 'Rules.', always: ['rules.md'], docs: { 'rules.md': { summary: 'The rules.' } } }));
  const advice = 'every session and subagent reads them: keep one or two short docs, and move the rest behind tags or to search\n';
  const near = budget(20);
  assert.deepEqual([near.status, near.stdout, near.stderr], [0, 'budget: 27 of 20 always-doc bytes (kb 27)\n', `budget: warning: always docs: 27 bytes, over knowledge.budgets.alwaysBytes (20); ${advice}`]);
  const over = budget(13);
  assert.deepEqual([over.status, over.stderr], [1, `budget: always docs: 27 bytes, over twice knowledge.budgets.alwaysBytes (13); ${advice}`]);
  assert.deepEqual([run(['nope']).status, run(['nope']).stderr], [1, 'unknown lint: nope; use one of skills, agents, paths, budget, terms, review\n']);
});

test('aidrian lint review: dead flow globs, a missing invariants doc, and a bad cite are errors; no invariants is a warning', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-lint-review-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', dir]);
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  mkdirSync(path.join(dir, 'src/booking'), { recursive: true });
  writeFileSync(path.join(dir, 'src/booking/a.js'), '');
  writeFileSync(path.join(dir, 'inv.md'), '# Booking\n\n## Never double book\n');
  writeFileSync(path.join(dir, 'long.md'), `# Long\n\n## Rules\n\n${Array.from({ length: 50 }, (_, i) => `- Rule ${i}: ${'x'.repeat(90)}`).join('\n')}\n`);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, review: { flows: {
    booking: { files: ['src/booking/**'], invariants: 'inv.md' },
    gone: { files: ['src/gone/**'], invariants: 'missing.md' },
    loose: { files: ['src/booking/**'], invariants: [{ id: 'x', text: 'y', cite: 'inv.md#nope' }] },
    focused: { files: ['src/booking/**'], invariants: [
      { id: 'miss', cite: 'long.md#rules', focus: 'Nothing like this' },
      { id: 'wide', text: 'Does the change remove a rule?', cite: 'long.md#rules' },
      { id: 'narrow', cite: 'long.md#rules', focus: 'Rule 1' },
    ] },
    bare: { files: ['src/booking/**'] },
  } } }));
  spawnSync('git', ['-C', dir, 'add', '-A']);
  const run = spawnSync(CLI, ['lint', 'review', '--project', dir], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, [
    'review: warning: flow focused: invariant wide text asks with "remove", so yes would be the breach: ask whether the change still keeps the rule',
    'review: warning: flow focused: invariant wide cites 5145 characters of #rules; the reviewer reads the first 4000: add "focus" to name the blocks it judges against',
    'review: warning: flow bare states no invariants: its reviewer checks only that nothing in it is removed or weakened',
    'review: flow gone: files "src/gone/**" matches no tracked file',
    'review: flow gone: invariants missing.md is missing',
    'review: flow loose: invariant x cites #nope, a heading inv.md does not have',
    'review: flow focused: invariant miss has focus "Nothing like this", which starts no top-level block of #rules',
    '',
  ].join('\n'));
});
