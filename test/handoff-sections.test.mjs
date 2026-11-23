import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { adviceProblem, carriedItems, checkBrief, manualSkillProblem, manualSkills, snapshotPath, takeSnapshot } from '../plugins/aidrian/lib/handoff-brief.mjs';
import { namesBrief, sectionProblems, supersedesOf } from '../plugins/aidrian/lib/handoff-sections.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const TEMPLATE = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/session-handoff/references/brief-template.md');
const ADVICE = 'Advice from Claude, not a spec: check each claim against the docs and code before building on it.';

// Each required section by itself, so a test can drop or replace one.
const PARTS = {
  objective: '## Objective\n- Ship the widget.\n',
  state: '## Current state\n- Worktree: none yet; create one in step 1 | Branch: to create | Pull request: none\n',
  running: '## Still running\nNone.\n',
  next: '## Next steps (ordered)\n1. Run the suite.\n',
  risks: '## Open risks and questions\nNone.\n',
};
const body = (parts = {}) => Object.entries({ ...PARTS, ...parts }).map(([, text]) => text).filter(Boolean).join('\n');
const brief = (parts, header = 'Supersedes: none') => `# Handoff: widget\nWritten: 2026-01-02 | ${header}\n${ADVICE}\n\n${body(parts)}`;
// The section a finding names: the text before its first colon.
const named = (problems) => problems.map((line) => line.split(':')[0]);

// An older brief, as this project's first briefs were written: no advice line, no Supersedes field, none of the five
// sections, and its worktree in prose.
const OLDER = `# Handoff: widget
Written: 2026-01-01

## Where things are
Main checkout: /repo, on \`main\`.

## Decisions locked (do not relitigate)
- Ship behind \`widget_flag\`.

## Next steps (ordered)
1. Run \`npm run widget\`.

## Key paths
- \`lib/widget.mjs\`

## Gotchas
- \`WIDGET_TOKEN\` expires hourly.
`;
const CARRIES_OLDER = '- Carried: `widget_flag`, `npm run widget`, `lib/widget.mjs`, `WIDGET_TOKEN`.\n';

const tempDir = (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-sections-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const write = (dir, name, text) => {
  const file = path.join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
};

test('a brief with the five sections has no section finding; each missing one is one finding that names it and what to add', () => {
  assert.deepEqual(sectionProblems(brief()), []);
  for (const [part, name] of [['objective', 'Objective'], ['state', 'Current state'], ['running', 'Still running'], ['next', 'Next steps'], ['risks', 'Open risks and questions']]) {
    const problems = sectionProblems(brief({ [part]: '' }));
    assert.deepEqual(named(problems), [name], part);
    assert.match(problems[0], new RegExp(`no \`## ${name}\` section: add it, with \\S`, 'u'));
  }
  assert.match(sectionProblems(brief({ state: '' }))[0], /`Worktree: <path, or none yet>` and `Branch: <name>`, each on its own line/u);
  for (const part of ['objective', 'running', 'risks']) {
    const heading = PARTS[part].split('\n')[0];
    assert.match(sectionProblems(brief({ [part]: `${heading}\n\n` }))[0], /: the section holds no line of text: add /u, `an empty ${part}`);
  }
});

test('a heading matches by its first words in any case; a heading or a label inside a code fence counts for nothing', () => {
  assert.deepEqual(sectionProblems(brief({ state: '## current state\n- Worktree: /w | Branch: b\n', objective: '## OBJECTIVE (what done means)\n- Ship.\n' })), []);
  assert.deepEqual(named(sectionProblems(brief({ objective: '## Objectives\n- Ship.\n' }))), ['Objective'], 'a longer word is another heading');
  const fencedHeading = brief({ objective: '## Done\n```markdown\n## Objective\n- Ship.\n```\n' });
  assert.deepEqual(named(sectionProblems(fencedHeading)), ['Objective']);
  const fencedLabel = brief({ state: '## Current state\n```text\nWorktree: /w | Branch: b\n```\n' });
  assert.deepEqual(named(sectionProblems(fencedLabel)), ['Current state', 'Current state']);
  const fencedText = brief({ risks: '## Open risks and questions\n```text\nNone.\n```\n' });
  assert.deepEqual(named(sectionProblems(fencedText)), ['Open risks and questions']);
});

test('the Worktree and Branch labels: the forms real briefs use pass, prose and an empty value fail', () => {
  for (const state of [
    '- Worktree: none yet; create one in step 1 | Branch: to create',
    '- Worktree: /repo/.worktrees/widget\n- Branch: feat/widget | Pull request: none',
    '- Worktree: none yet\n- Branch: none.',
    '- **Worktree:** `/repo/.worktrees/widget` | **branch:** `feat/widget`',
  ]) assert.deepEqual(sectionProblems(brief({ state: `## Current state\n${state}\n` })), [], state);
  const prose = sectionProblems(brief({ state: '## Current state\n- Main checkout: /repo, on main\n' }));
  assert.deepEqual(prose.map((line) => /`(Worktree|Branch):`/u.exec(line)?.[1]), ['Worktree', 'Branch']);
  const empty = sectionProblems(brief({ state: '## Current state\n- Worktree: | Branch: x\n' }));
  assert.deepEqual(empty, ['Current state: no `Worktree:` value: add `Worktree: <path, or none yet>` to the section']);
});

test('Next steps needs a numbered item at the start of a line', () => {
  const next = (text) => sectionProblems(brief({ next: `## Next steps (ordered)\n${text}\n` }));
  assert.deepEqual(next('1. Run it.'), []);
  assert.deepEqual(next('1) Run it.'), []);
  assert.deepEqual(next('12. Run it.'), []);
  for (const text of ['- Run it.\n- Then ship.', '- Run it.\n  1. A sub-step.', '1.Run it.']) {
    assert.deepEqual(next(text), ['Next steps: the section has no numbered item at the start of a line: add `1. <the smallest next action>`'], text);
  }
});

test('supersedesOf reads the header value up to the next bar; a value that begins with none names no brief', () => {
  assert.equal(supersedesOf('# H\nWritten: x\n\n## Objective\nSupersedes: below.md\n'), null, 'below the first section counts for nothing');
  for (const value of ['none', 'None', 'None.', 'none (2026-11-02-quorum-skill.md is a different task)', '`none`']) {
    assert.equal(supersedesOf(`# H\nWritten: x | Supersedes: ${value}\n`), value);
    assert.equal(namesBrief(value), false, value);
  }
  assert.equal(supersedesOf('# H\nWritten: x | Supersedes: none | Chain: 1\n'), 'none');
  assert.equal(supersedesOf('# H\nsupersedes:   2026-01-01-widget.md\n'), '2026-01-01-widget.md');
  for (const value of ['2026-01-01-widget.md', 'nonexistent.md', 'the brief of 2026-01-01']) assert.equal(namesBrief(value), true, value);
});

test('carriedItems reads Decisions locked, Gotchas, Next steps, Key paths, and Open risks and questions, and no state section', () => {
  const text = [
    '## Objective', '- `obj-id`', '## Current state', '- Worktree: `/w` | Branch: `b`', '## Still running', '- `job-id`',
    '## Decisions locked', '- `dec-id`', '## Done', '- `done-id`', '## Next steps (ordered)', '1. `next-id`',
    '## Open risks and questions', '- `risk-id`', '## Key paths', '- `path-id`', '## Gotchas', '- `gotcha-id`',
  ].join('\n');
  assert.deepEqual(carriedItems(text).map((item) => [item.section, item.identifiers]), [
    ['Decisions locked', ['dec-id']], ['Next steps', ['next-id']], ['Open risks and questions', ['risk-id']],
    ['Key paths', ['path-id']], ['Gotchas', ['gotcha-id']],
  ]);
});

test('a refresh that drops an identifier of Next steps, Key paths, or Open risks fails under its section, and passes once Done or the header names it', (t) => {
  const dir = tempDir(t);
  const prior = write(dir, '2026-01-01-widget.md', brief({
    next: '## Next steps (ordered)\n1. Run `npm run widget`.\n',
    risks: '## Open risks and questions\n- The reviewer asked about `cache_ttl`.\n',
    paths: '## Key paths\n- `lib/widget.mjs`\n',
  }));
  const file = write(dir, '2026-01-02-widget.md', brief());
  const dropped = checkBrief(file, prior, 0);
  assert.equal(dropped.exitCode, 1);
  const text = dropped.lines.join('\n');
  assert.match(text, /3 identifier\(s\) no longer named\. Carry each, name it under Done once its step is done, or name it in the header with why it is obsolete:/u);
  for (const line of ['  - [Next steps] `npm run widget`', '  - [Open risks and questions] `cache_ttl`', '  - [Key paths] `lib/widget.mjs`']) assert.ok(dropped.lines.includes(line), line);
  writeFileSync(file, brief({ done: '## Done\n- Ran `npm run widget`; it passed. `lib/widget.mjs` is merged.\n' }, 'Supersedes: 2026-01-01-widget.md; dropped `cache_ttl`, answered'));
  const carried = checkBrief(file, prior, 0);
  assert.equal(carried.exitCode, 0, carried.lines.join('\n'));
  assert.ok(carried.lines.includes('  every identifier from its Decisions locked, Gotchas, Next steps, Key paths, and Open risks and questions is still named.'));
});

test('a header with no Supersedes field is a finding that names the field', (t) => {
  const result = checkBrief(write(tempDir(t), '2026-01-02-widget.md', brief({}, 'Phase completed: plan')), undefined, 0);
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.includes('Supersedes: no value in the header: add `Supersedes: <the brief this one replaces, or none>` to the line under the title'));
  assert.ok(result.lines.includes('Carry-forward: no superseded brief found; nothing to compare.'), 'a header that names no brief');
});

test('a Supersedes value that names a brief nothing was compared with fails; --prior compares it; none prints nothing to compare', (t) => {
  const dir = tempDir(t);
  const older = write(dir, '2026-01-01-old-name.md', OLDER);
  const file = write(dir, '2026-01-02-widget.md', brief({ done: `## Done\n${CARRIES_OLDER}` }, 'Supersedes: 2026-01-01-old-name.md'));
  const alone = checkBrief(file, undefined, 0);
  assert.equal(alone.exitCode, 1);
  assert.ok(alone.lines.includes('Carry-forward: the header names `Supersedes: 2026-01-01-old-name.md`, but no superseded brief was found, so nothing was compared: run the check with `--prior <that brief>`'));
  assert.ok(!alone.lines.some((line) => line.includes('nothing to compare.')));
  const compared = checkBrief(file, older, 0);
  assert.equal(compared.exitCode, 0, compared.lines.join('\n'));
  assert.ok(compared.lines.includes(`Carry-forward against ${older} (explicit):`));
  for (const header of ['Supersedes: none', 'Supersedes: None', 'Supersedes: none (2026-11-02-quorum-skill.md is a different task)', 'Supersedes: none | Chain: 1']) {
    const lone = write(dir, '2026-01-02-lone.md', brief({}, header));
    const result = checkBrief(lone, undefined, 0);
    assert.equal(result.exitCode, 0, header);
    assert.deepEqual(result.lines, [`handoff check: ${lone}`, 'Carry-forward: no superseded brief found; nothing to compare.', 'OK'], header);
    rmSync(snapshotPath(lone), { force: true });
  }
});

test('a superseded brief of an older format is a valid prior: a complete brief that carries it passes, one that drops a fact fails', (t) => {
  const dir = tempDir(t);
  write(dir, '2026-01-01-widget.md', OLDER);
  assert.equal(sectionProblems(OLDER).length, 4, 'the older brief would fail as the brief under check');
  const file = write(dir, '2026-01-02-widget.md', brief({ done: `## Done\n${CARRIES_OLDER}` }, 'Supersedes: 2026-01-01-widget.md'));
  const result = checkBrief(file, undefined, 0);
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.match(result.lines.join('\n'), /\(same slug\)/u);
  rmSync(snapshotPath(file), { force: true });
  writeFileSync(file, brief({ done: `## Done\n${CARRIES_OLDER.replace('`widget_flag`, ', '').replace(', `WIDGET_TOKEN`', '')}` }, 'Supersedes: 2026-01-01-widget.md'));
  const dropped = checkBrief(file, undefined, 0);
  assert.equal(dropped.exitCode, 1);
  assert.ok(dropped.lines.includes('  - [Decisions locked] `widget_flag`'));
  assert.ok(dropped.lines.includes('  - [Gotchas] `WIDGET_TOKEN`'));
});

test('a pass keeps the brief as its snapshot, a failure leaves the snapshot as it was, and the next check compares with what passed', (t) => {
  const dir = tempDir(t);
  const file = write(dir, '2026-01-02-widget.md', OLDER);
  takeSnapshot(file);
  writeFileSync(file, brief({ done: '## Done\n- Nothing carried.\n' }, 'Supersedes: 2026-01-01-widget.md'));
  assert.equal(checkBrief(file, undefined, 0).exitCode, 1);
  assert.equal(readFileSync(snapshotPath(file), 'utf8'), OLDER, 'a failing check leaves the snapshot');
  const passing = brief({ done: `## Done\n${CARRIES_OLDER}`, paths: '## Key paths\n- `lib/widget.mjs`\n' }, 'Supersedes: 2026-01-01-widget.md');
  writeFileSync(file, passing);
  assert.equal(checkBrief(file, undefined, 0).exitCode, 0);
  assert.equal(readFileSync(snapshotPath(file), 'utf8'), passing, 'a pass keeps what passed');
  const again = checkBrief(file, undefined, 0);
  assert.equal(again.exitCode, 0, 'an unchanged brief passes again');
  assert.ok(again.lines.includes(`Carry-forward against ${snapshotPath(file)} (snapshot):`));
  writeFileSync(file, passing.replace('`lib/widget.mjs`, ', '').replace('\n## Key paths\n- `lib/widget.mjs`\n', ''));
  const edited = checkBrief(file, undefined, 0);
  assert.equal(edited.exitCode, 1, 'an edit that drops an identifier is compared with the kept copy');
  assert.ok(edited.lines.includes(`Carry-forward against ${snapshotPath(file)} (snapshot):`));
  assert.ok(edited.lines.includes('  - [Key paths] `lib/widget.mjs`'));
  assert.equal(readFileSync(snapshotPath(file), 'utf8'), passing, 'the failure keeps what last passed');
});

test('a pass where the copy cannot be written exits 0 with the same lines', (t) => {
  const dir = tempDir(t);
  writeFileSync(path.join(dir, '.prior'), 'a file where the folder would go');
  const file = write(dir, '2026-01-02-widget.md', brief());
  const result = checkBrief(file, undefined, 0);
  assert.deepEqual([result.exitCode, result.lines], [0, [`handoff check: ${file}`, 'Carry-forward: no superseded brief found; nothing to compare.', 'OK']]);
});

test('the shipped template holds every required section, the advice line, and a Supersedes value', () => {
  const file = readFileSync(TEMPLATE, 'utf8');
  const fenced = /^```markdown\n([\s\S]*?)^```$/mu.exec(file);
  const template = fenced ? fenced[1] : file;
  assert.deepEqual(sectionProblems(template), []);
  assert.equal(adviceProblem(template), null);
  assert.ok(supersedesOf(template), 'the header has a Supersedes value');
});

test('aidrian handoff check: a named superseded brief with nothing to compare exits 1; with --prior it exits 0', (t) => {
  const dir = tempDir(t);
  const older = write(dir, '2026-01-01-old-name.md', OLDER);
  const file = write(dir, '2026-01-02-widget.md', brief({ done: `## Done\n${CARRIES_OLDER}` }, 'Supersedes: 2026-01-01-old-name.md'));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  const run = (...args) => spawnSync(CLI, ['handoff', 'check', file, ...args], { cwd: dir, encoding: 'utf8' });
  const alone = run();
  assert.equal(alone.status, 1);
  assert.match(alone.stderr, /`--prior <that brief>`/u);
  assert.equal(run('--prior', older).status, 0);
});

// A background continuation whose first step was `/aidrian:autopilot` stopped at once: the Skill tool refuses a skill
// with `disable-model-invocation: true`. The check fails such a brief before any continuation starts.
test('the check fails a brief whose first next step runs a skill only a person can start', (t) => {
  const skills = manualSkills();
  assert.ok(skills.has('autopilot') && !skills.has('plan-implement'), 'the plugin\'s manual-only skills, read from their frontmatter');
  const at = (step) => manualSkillProblem(brief({ next: `## Next steps (ordered)\n${step}\n2. Run /aidrian:autopilot later.\n` }));
  for (const step of [
    '1. Load the `knowledge` skill, then run `/aidrian:autopilot /state/plans/x.md`.',
    '1. Run /autopilot on the plan.',
    '1. Run the `autopilot` skill on the plan,\n   then report.',
    '1. Run the `autopilot`\n   skill on the plan.',
    '1. Type /aidrian:autopilot on the plan.',
    '1. Run the checks and tell the Human to type /aidrian:autopilot.',
    '1. Load the plan.\n\n   Run /aidrian:autopilot on it.',
  ]) assert.match(at(step) ?? '', /^Next steps: step 1 runs `autopilot`, which only a person can start/u, step);
  for (const step of [
    '1. Run the `plan-implement` skill on /state/plans/autopilot.md.',
    '1. Read the `project-autopilot` skill\'s SKILL.md at its absolute path.',
    '1. Open /repo/skills/autopilot/SKILL.md.',
    '1. Read /autopilot.md, then run the checks.',
    '1. Run the checks.\n\nThe Human may later run /aidrian:autopilot.',
  ]) assert.equal(at(step), null, `${step}: a later step, a path, or reading a skill is no start`);

  const file = write(tempDir(t), 'b.md', brief({ next: '## Next steps (ordered)\n1. Run `/aidrian:autopilot <plan>`.\n' }));
  const checked = checkBrief(file, undefined, 0);
  assert.equal(checked.exitCode, 1);
  assert.ok(checked.lines.some((line) => line.startsWith('Next steps: step 1 runs `autopilot`')), checked.lines.join('\n'));
});
