// `aidrian plan` (lib/plan-cli.mjs): a status mark or a record on a local plan, and every byte it must leave alone.
import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planCommand } from '../plugins/aidrian/lib/plan-cli.mjs';
import { cliCall } from './cli-call.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const FENCE = '```';

// A plan in the shapes real ones have: plain ids, a title after the id, quoted and unquoted values, a comment after a
// value, a notes field and none, a fenced example that holds a slice heading and a status line, and no revision history.
const PLAN = `---
issue_id: "ABC-483"
status: "ready"
workspace_decision:
  mode: "worktree"
# a comment in the frontmatter
related_plans: []
---

# A plan

## Approach

An example, never read as a slice:

${FENCE}yaml
### Slice EXAMPLE
status: "pending"
${FENCE}

## Slices

### Slice S1

${FENCE}yaml
slice_id: "S1"
goal: "One: status: \\"pending\\" stays"
non_goals:
  - "status: none"
status: "pending"
notes: ""
${FENCE}

Prose, then a second block that is not the slice's own:

${FENCE}yaml
status: "example"
${FENCE}

### Slice A1 — a title: with a colon

${FENCE}yaml
slice_id: "A1"
status: pending   # waits for the reviewer
planned_commit_subject: "feat: a"
${FENCE}

### Slice B1: the row that opens its booking

${FENCE}yaml
slice_id: 'B1'
status: 'in_progress'
notes: |
  first line

  status: "not a field"
acceptance_criteria_covered:
  - "AC1"
${FENCE}

#### A heading inside the slice

### Slice INTEGRATION-REVIEW

${FENCE}yaml
slice_id: "INTEGRATION-REVIEW"
status: "deferred"
${FENCE}

## Risks

None.
`;

// A project whose state folder is apart from it, and a plan in it. No repository, so no command asks git about the plan.
function fixture(t, text = PLAN, name = 'abc-483-implementation.md') {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-plan-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project');
  const state = path.join(root, 'state');
  const plans = path.join(state, 'plans');
  mkdirSync(path.join(dir, '.aidrian'), { recursive: true });
  mkdirSync(plans, { recursive: true });
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  const file = path.join(plans, name);
  writeFileSync(file, text);
  const run = (...args) => cliCall(['plan', ...args], { cwd: dir });
  return { root, dir, state, plans, file, run, read: () => readFileSync(file, 'utf8') };
}

// The plan's lines that differ from `before`, as [old, new]; the line counts must agree.
function changed(before, after) {
  const [old, now] = [before.split('\n'), after.split('\n')];
  assert.equal(now.length, old.length, 'no line added or removed');
  return old.map((line, at) => [line, now[at]]).filter(([a, b]) => a !== b);
}

async function accepted(fx, ...args) {
  const result = await fx.run(...args);
  assert.deepEqual([result.status, result.stderr], [0, ''], args.join(' '));
  return result;
}

// Runs a call that must refuse: exit 2, a reason, the plan's bytes as they were, and no new file beside it.
async function refused(fx, args, reason) {
  const [bytes, names] = [readFileSync(fx.file), readdirSync(fx.plans)];
  const { status, stdout, stderr } = await fx.run(...args);
  assert.deepEqual([status, stdout], [2, ''], args.join(' '));
  assert.match(stderr, reason, args.join(' '));
  assert.deepEqual(readFileSync(fx.file), bytes, `${args.join(' ')} left the plan alone`);
  assert.deepEqual(readdirSync(fx.plans), names, `${args.join(' ')} left no file beside the plan`);
}

test('set marks a slice with each status, and every byte outside its status line stays', async (t) => {
  for (const status of ['in_progress', 'complete', 'blocked']) {
    const fx = fixture(t);
    const { stdout } = await accepted(fx, 'set', fx.file, 'S1', status);
    assert.deepEqual(changed(PLAN, fx.read()), [['status: "pending"', `status: "${status}"`]]);
    assert.ok(fx.read().indexOf(`status: "${status}"`) > fx.read().indexOf('slice_id: "S1"'), 'the slice\'s own line, not the example before it');
    assert.match(stdout, new RegExp(`^${fx.file}\nline \\d+:\n- status: "pending"\n\\+ status: "${status}"\n$`, 'u'));
  }
  const fx = fixture(t);
  await accepted(fx, 'set', fx.file, 'B1', 'pending');
  assert.deepEqual(changed(PLAN, fx.read()), [["status: 'in_progress'", "status: 'pending'"]], 'single quotes stay');
  const { stdout } = await accepted(fx, 'set', fx.file, 'B1', 'pending');
  assert.match(stdout, /nothing to change/u);
});

test('set finds a slice by the first word of its heading, keeps the title, and prints the comment it removes', async (t) => {
  const fx = fixture(t);
  const { stdout } = await accepted(fx, 'set', fx.file, 'A1', 'complete');
  assert.deepEqual(changed(PLAN, fx.read()), [['status: pending   # waits for the reviewer', 'status: complete']], 'an unquoted value stays unquoted');
  assert.match(stdout, /^- status: pending {3}# waits for the reviewer$/mu);
  await accepted(fx, 'set', fx.file, 'INTEGRATION-REVIEW', 'complete');
  assert.deepEqual(changed(PLAN, fx.read()).at(-1), ['status: "deferred"', 'status: "complete"'], 'a value the schema does not list is replaced');

  // The value is the same: its comment stays, and nothing is written.
  const same = fixture(t);
  await accepted(same, 'set', same.file, 'A1', 'pending');
  assert.equal(same.read(), PLAN);
});

test('set --plan sets the frontmatter status, and complete only once every slice is', async (t) => {
  const fx = fixture(t);
  await accepted(fx, 'set', fx.file, '--plan', 'in-progress');
  assert.deepEqual(changed(PLAN, fx.read()), [['status: "ready"', 'status: "in-progress"']]);
  for (const id of ['S1', 'A1', 'B1']) await accepted(fx, 'set', fx.file, id, 'complete');
  await refused(fx, ['set', fx.file, '--plan', 'complete'], /not complete: slice "INTEGRATION-REVIEW"/u);
  await accepted(fx, 'set', fx.file, 'INTEGRATION-REVIEW', 'complete');
  await accepted(fx, 'set', fx.file, '--plan', 'complete');
  assert.match(fx.read(), /^---\nissue_id: "ABC-483"\nstatus: "complete"\n/u);
});

test('--note replaces the notes field, or adds it after the status, with quotes, colons, and a hash kept as text', async (t) => {
  const note = 'Reviewed: "fix" it, #705 \\ C:\\x ``` done';
  const line = 'notes: "Reviewed: \\"fix\\" it, #705 \\\\ C:\\\\x ``` done"';
  const fx = fixture(t);
  await accepted(fx, 'set', fx.file, 'S1', 'complete', '--note', note);
  assert.deepEqual(changed(PLAN, fx.read()), [['status: "pending"', 'status: "complete"'], ['notes: ""', line]]);
  assert.equal(JSON.parse(line.slice('notes: '.length)), note);

  // Absent: one line added, right after the status. With the status as it was, that is the whole change.
  const added = fixture(t);
  await accepted(added, 'set', added.file, 'INTEGRATION-REVIEW', 'complete', '--note', note);
  assert.equal(added.read(), PLAN.replace('status: "deferred"\n', `status: "complete"\n${line}\n`));
  const { stdout } = await accepted(added, 'set', added.file, 'INTEGRATION-REVIEW', 'complete', '--note', 'two');
  assert.match(stdout, /^\+ notes: "two"$/mu);
  assert.equal(added.read(), PLAN.replace('status: "deferred"\n', 'status: "complete"\nnotes: "two"\n'));

  // A value over several lines is replaced whole, and the field after it stays.
  const block = fixture(t);
  await accepted(block, 'set', block.file, 'B1', 'in_progress', '--note', '');
  assert.equal(block.read(), PLAN.replace('notes: |\n  first line\n\n  status: "not a field"\n', 'notes: ""\n'));

  // A list at the margin is the note's value; the blank line and the field after it are not.
  for (const value of ['"one"', '\n- one\n- two']) {
    const tail = `${value.startsWith('\n') ? 'notes:' : 'notes: '}${value}\n`;
    const spaced = fixture(t, PLAN.replace('notes: ""\n', `${tail}\nscreens_covered: []\n`));
    await accepted(spaced, 'set', spaced.file, 'S1', 'pending', '--note', 'x');
    assert.equal(spaced.read(), PLAN.replace('notes: ""\n', 'notes: "x"\n\nscreens_covered: []\n'));
  }

  const odd = fixture(t, PLAN.replace('notes: ""\n', 'notes: "one\nnot indented"\n'));
  await refused(odd, ['set', odd.file, 'S1', 'complete', '--note', 'x'], /notes: field whose end cannot be told/u);
  for (const text of ['two\nlines', 'a\r', 'tab\there', 'line\u2028sep', 'esc\u001b[31m', 'bidi\u202e']) {
    await refused(fx, ['set', fx.file, 'S1', 'blocked', '--note', text], /--note is one line of text/u);
  }
});

test('a CRLF plan keeps every line end, and what is added ends the same way', async (t) => {
  const crlf = PLAN.replaceAll('\n', '\r\n');
  const fx = fixture(t, crlf);
  await accepted(fx, 'set', fx.file, 'A1', 'in_progress', '--note', 'n');
  await accepted(fx, 'set', fx.file, '--plan', 'in-progress');
  await accepted(fx, 'record', fx.file, '--by', 'product-manager', '--text', 'Approved.');
  const text = fx.read();
  assert.doesNotMatch(text, /[^\r]\n/u);
  assert.ok(text.startsWith(crlf.replace('status: pending   # waits for the reviewer\r\n', 'status: in_progress\r\nnotes: "n"\r\n').replace('status: "ready"', 'status: "in-progress"')));
  assert.match(text, /\r\n\r\n## Revision history\r\n\r\n- \d{4}-\d\d-\d\d, product-manager: Approved\.\r\n$/u);
});

test('the file keeps its mode, its other bytes, and a byte order mark', async (t) => {
  const fx = fixture(t, `\ufeff${PLAN}Not ASCII: café \u{1F600}`);
  chmodSync(fx.file, 0o640);
  const before = fx.read();
  await accepted(fx, 'set', fx.file, 'S1', 'complete');
  assert.equal(statSync(fx.file).mode & 0o777, 0o640);
  assert.deepEqual(changed(before, fx.read()), [['status: "pending"', 'status: "complete"']]);
  assert.deepEqual(readdirSync(fx.plans).filter((name) => name.endsWith('.tmp')), []);

  // The write sets the plan's permission bits, and no other mode bit.
  chmodSync(fx.file, 0o2640);
  await accepted(fx, 'set', fx.file, 'S1', 'blocked');
  assert.equal(statSync(fx.file).mode & 0o7777, 0o640);

  writeFileSync(fx.file, Buffer.concat([Buffer.from(PLAN), Buffer.from([0xff, 0x0a])]));
  await refused(fx, ['set', fx.file, 'S1', 'complete'], /cannot be read as a file of UTF-8/u);
});

test('record adds the section at the end, then appends to it in order, and changes no other line', async (t) => {
  const fx = fixture(t);
  await accepted(fx, 'record', fx.file, '--by', 'product-manager', '--text', 'Approved: the copy stays.');
  await accepted(fx, 'record', fx.file, '--by', 'the Human', '--text', 'Merged as #705. ## Not a heading, ### Slice S9');
  const date = new Date().toISOString().slice(0, 10);
  assert.equal(fx.read(), `${PLAN}\n## Revision history\n\n- ${date}, product-manager: Approved: the copy stays.\n- ${date}, the Human: Merged as #705. ## Not a heading, ### Slice S9\n`);
  await refused(fx, ['set', fx.file, 'S9', 'complete'], /no slice "S9"; it has S1, A1, B1, INTEGRATION-REVIEW/u);

  // A section in the middle, whose last entry wraps: the entry goes under it, and the blank line and heading after stay.
  const middle = `${PLAN}\n## Revision history\n\n- 2026-01-01: one,\n  wrapped\n\n## Verification\n\nx`;
  const other = fixture(t, middle);
  await accepted(other, 'record', other.file, '--by', 'a', '--text', 't');
  assert.equal(other.read(), middle.replace('  wrapped\n', `  wrapped\n- ${date}, a: t\n`));

  // An empty section, a last line with no line end, and a section that ends in prose.
  for (const [tail, want] of [
    ['\n## Revision History ##\n\n## Next\n', `\n## Revision History ##\n\n- ${date}, a: t\n\n## Next\n`],
    ['\n## Revision history\n\n- one', `\n## Revision history\n\n- one\n- ${date}, a: t\n`],
    ['\n## Revision history\n\nProse.\n', `\n## Revision history\n\nProse.\n\n- ${date}, a: t\n`],
    ['\nlast words', `\nlast words\n\n## Revision history\n\n- ${date}, a: t\n`],
  ]) {
    const each = fixture(t, PLAN + tail);
    await accepted(each, 'record', each.file, '--by', 'a', '--text', 't');
    assert.equal(each.read(), PLAN + want);
  }
});

test('record --text-file keeps its lines inside one entry, and takes none that opens a heading or a fence', async (t) => {
  const fx = fixture(t);
  const note = path.join(fx.root, 'note.md');
  const date = new Date().toISOString().slice(0, 10);
  writeFileSync(note, '\nThree findings, "closed":  \r\n\n- one: #705\n- 2026-01-01, the Human: approved\n\n');
  await accepted(fx, 'record', fx.file, '--by', 'code-reviewer', '--text-file', note);
  assert.equal(fx.read(), `${PLAN}\n## Revision history\n\n- ${date}, code-reviewer: Three findings, "closed":\n\n  - one: #705\n  - 2026-01-01, the Human: approved\n`);
  for (const line of ['## Slices', '   ### Slice S9', '#', '- ### Slice S9', '> ## x', '1. - # x', '```yaml', '  ~~~', '- ```js', '> ```', '---', '  ===', '-']) {
    writeFileSync(note, `first\n${line}\nlast\n`);
    await refused(fx, ['record', fx.file, '--by', 'a', '--text-file', note], /holds a heading, a code fence, or a line of only dashes/u);
  }
  for (const text of ['one\n\ttab', 'esc \u001b[2J', 'zero\u200bwidth', 'cr\rhere']) {
    writeFileSync(note, text);
    await refused(fx, ['record', fx.file, '--by', 'a', '--text-file', note], /character that does not show/u);
  }
  writeFileSync(note, Buffer.from([0xff, 0xfe]));
  await refused(fx, ['record', fx.file, '--by', 'a', '--text-file', note], /cannot be read as UTF-8/u);
  await refused(fx, ['record', fx.file, '--by', 'a', '--text-file', path.join(fx.root, 'none.md')], /is no file/u);
  await refused(fx, ['record', fx.file, '--by', 'a', '--text-file', fx.root], /is no file|cannot be read/u);
});

test('record refuses an empty text, a forged line, two sections, and a plan that leaves a fence open', async (t) => {
  const fx = fixture(t);
  const note = path.join(fx.root, 'note.md');
  writeFileSync(note, ' \n\n');
  for (const args of [['--text', ''], ['--text', '  '], ['--text-file', note]]) await refused(fx, ['record', fx.file, '--by', 'a', ...args], /the record is empty/u);
  await refused(fx, ['record', fx.file, '--by', 'a', '--text', 'x\n### Slice S9'], /--text is one line of text/u);
  for (const by of [[], ['--by', ' '], ['--by', 'a\n## b']]) await refused(fx, ['record', fx.file, ...by, '--text', 'x'], /--by names who/u);
  await refused(fx, ['record', fx.file, '--by', 'a'], /--text or --text-file, one of them/u);
  await refused(fx, ['record', fx.file, '--by', 'a', '--text', 'x', '--text-file', note], /--text or --text-file, one of them/u);
  await refused(fx, ['record', fx.file, 'S1', '--by', 'a', '--text', 'x'], /unexpected argument: S1/u);

  const twice = fixture(t, `${PLAN}\n## Revision history\n\n## revision history\n`);
  await refused(twice, ['record', twice.file, '--by', 'a', '--text', 'x'], /more than one Revision history/u);
  for (const tail of [`\n${FENCE}sh\nls\n`, `\n## Revision history\n\n${FENCE}sh\nls\n`]) {
    const open = fixture(t, PLAN + tail);
    await refused(open, ['record', open.file, '--by', 'a', '--text', 'x'], /leaves a code fence open/u);
  }
});

test('set refuses an unknown status, a slice the plan lacks or holds twice, and a block it cannot read', async (t) => {
  const fx = fixture(t);
  for (const status of ['done', 'in-progress', 'ready', 'Complete', '']) await refused(fx, ['set', fx.file, 'S1', status], /a slice's status is pending, in_progress, complete, blocked/u);
  for (const status of ['ready', 'open-questions', 'in_progress', 'pending']) await refused(fx, ['set', fx.file, '--plan', status], /--plan takes in-progress, complete, blocked/u);
  for (const id of ['S9', 's1', 'S', 'EXAMPLE', '—']) await refused(fx, ['set', fx.file, id, 'complete'], /the plan has no slice/u);
  await refused(fx, ['set', fx.file, 'S1'], /a slice's status is/u);
  await refused(fx, ['set', fx.file], /one slice and its status/u);
  await refused(fx, ['set', fx.file, 'S1', 'A1', 'complete'], /one slice and its status/u);
  await refused(fx, ['set', fx.file, 'S1', 'complete', '--plan', 'complete'], /never both/u);
  await refused(fx, ['set', fx.file, '--plan', 'blocked', '--note', 'x'], /--note with a slice alone/u);
  await refused(fx, ['set', fx.file, '--plan', 'complete'], /not complete: slice "S1", slice "A1", slice "B1", slice "INTEGRATION-REVIEW"/u);
  await refused(fx, [], /usage: aidrian plan set FILE SLICE/u);
  await refused(fx, ['toString', fx.file], /usage: aidrian plan set FILE SLICE/u);
  await refused(fx, ['set'], /needs the plan file/u);

  const s1 = /slice_id: "S1"[\s\S]*?```\n/u.exec(PLAN)[0];
  const cases = [
    [`${PLAN}\n### Slice S1 again\n\n${FENCE}yaml\nstatus: "pending"\n${FENCE}\n`, /2 slices named "S1"/u],
    [PLAN.replace(s1, '').replace(`${FENCE}yaml\n\nProse`, 'Prose').replace(`${FENCE}yaml\nstatus: "example"\n${FENCE}\n`, ''), /slice "S1" has no fenced block/u],
    [PLAN.replace('status: "pending"\nnotes', 'notes'), /slice "S1" has no status: line/u],
    [PLAN.replace('status: "pending"\nnotes', '  status: "pending"\nnotes'), /slice "S1" has no status: line/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: "pending"\nstatus: "blocked"\nnotes'), /slice "S1" holds 2 status: lines/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: "pending" again\nnotes'), /not one word on that line/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: "pending\n  more"\nnotes'), /not one word on that line/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: pending\n  more\nnotes'), /not one word on that line/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: &x "pending"\nnotes'), /not one word on that line/u],
    [PLAN.replace('status: "pending"\nnotes', 'status: pending#x\nnotes'), /not one word on that line/u],
    // Neither a block below the slice's section, nor a heading the Markdown reads as code, is the slice's.
    [`## Slices\n\n### Slice S1\n\nNo block.\n\n## Verification\n\n${FENCE}yaml\nstatus: "pending"\n${FENCE}\n`, /slice "S1" has no fenced block/u],
    [`## Slices\n\n    ### Slice S1\n\n${FENCE}yaml\nstatus: "pending"\n${FENCE}\n`, /no slice "S1"; it has none/u],
  ];
  for (const [text, reason] of cases) {
    const each = fixture(t, text);
    await refused(each, ['set', each.file, 'S1', 'complete'], reason);
  }
  // The slice's fence never closes, so the block could be anything after it, the next slice's included.
  const open = fixture(t, `## Slices\n\n### Slice S1\n\n${FENCE}yaml\nstatus: "pending"\n`);
  await refused(open, ['set', open.file, 'S1', 'complete'], /slice "S1" has no fenced block/u);
  const bare = fixture(t, '# No frontmatter\n\nstatus: "ready"\n');
  await refused(bare, ['set', bare.file, '--plan', 'blocked'], /no frontmatter/u);
  const empty = fixture(t, '---\nstatus: "ready"\n---\n\n# No slice\n');
  await refused(empty, ['set', empty.file, '--plan', 'complete'], /no slice to read as complete/u);
});

test('frontmatter lines that look like a slice, a fence, or a history are none, and a deeper history heading is not the section', async (t) => {
  const text = PLAN.replace('# a comment in the frontmatter\n', `### Slice S1\n## Revision history\n${FENCE}yaml\nstatus_note: x\n`)
    .replace('## Risks\n', '### Revision history\n\n- not this one\n\n## Risks\n');
  const fx = fixture(t, text);
  await accepted(fx, 'set', fx.file, 'S1', 'complete');
  assert.deepEqual(changed(text, fx.read()), [['status: "pending"', 'status: "complete"']]);
  const before = fx.read();
  await accepted(fx, 'record', fx.file, '--by', 'a', '--text', 't');
  assert.equal(fx.read(), `${before}\n## Revision history\n\n- ${new Date().toISOString().slice(0, 10)}, a: t\n`);
});

test('no character that does not show reaches the terminal from a plan, a path, or a lock', async (t) => {
  const fx = fixture(t, PLAN.replace('### Slice A1', '### Slice A\u001b[31m1\u202e').replace('goal:', 'goal\u001b:'), 'p\u001b[2Jlan.md');
  const unclean = /[\u001b\u202e]/u;
  const calls = [['set', fx.file, 'S9', 'complete'], ['set', fx.file, 'A\u001b[31m1\u202e', 'complete'], ['set', `${fx.file}.no`, 'S1', 'complete'], ['set', fx.file, '--plan', 'complete'], ['set', fx.file, 'S1', 'complete']];
  for (const args of calls) {
    const { status, stdout, stderr } = await fx.run(...args);
    assert.doesNotMatch(stdout + stderr, unclean, args.join(' '));
    assert.notEqual(stdout + stderr, '', String(status));
  }
  rmSync(`${fx.file}.lock.1.released`);
  writeFileSync(`${fx.file}.lock.1`, JSON.stringify({ pid: 1, host: 'far\u001b[31m', nonce: 'x' }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 1000));
  const { status, stderr } = await fx.run('set', fx.file, 'S1', 'blocked');
  assert.equal(status, 1);
  assert.match(stderr, /is locked by another process .*far\[31m/u);
  assert.doesNotMatch(stderr, unclean);
});

test('a heading or a status line of many spaces costs about its length to read', async (t) => {
  // Few enough that a pattern that backtracks over them fails the bound in seconds, rather than hanging the file.
  const spaces = ' '.repeat(1_200);
  const fx = fixture(t, `${PLAN}\n### Slice Z1 a${spaces}b${spaces}# #x\n\n${FENCE}yaml\nslice_id: "Z1"\nstatus:${spaces.repeat(20)}x y\n${FENCE}\n`);
  const before = process.cpuUsage();
  await refused(fx, ['set', fx.file, 'Z1', 'complete'], /not one word on that line/u);
  await accepted(fx, 'set', fx.file, 'S1', 'complete');
  const { user, system } = process.cpuUsage(before);
  assert.ok(user + system < 1_000_000, `${(user + system) / 1000} ms of processor time`);
});

test('a slice\'s own block is the one with its slice_id, so an example before it is never marked', async (t) => {
  const text = PLAN.replace('### Slice S1\n', `### Slice S1\n\n~~~yaml\nslice_id: "EX"\nstatus: "pending" # example\n### Slice A1\n~~~\n`);
  const fx = fixture(t, text);
  // No block of the section is the slice's own: another id alone, or its own twice.
  for (const each of [PLAN.replace('slice_id: "S1"', 'slice_id: "S2"'), PLAN.replace('status: "example"', 'slice_id: S1\nstatus: "example"')]) {
    const none = fixture(t, each);
    await refused(none, ['set', none.file, 'S1', 'complete'], /has (?:no|2) fenced blocks with its own slice_id/u);
  }
  await accepted(fx, 'set', fx.file, 'S1', 'complete');
  assert.deepEqual(changed(text, fx.read()), [['status: "pending"', 'status: "complete"']]);

  // With no slice_id anywhere in the slice, the first block is its own.
  const unnamed = PLAN.replace('slice_id: "S1"\n', '');
  const other = fixture(t, unnamed);
  await accepted(other, 'set', other.file, 'S1', 'complete');
  assert.deepEqual(changed(unnamed, other.read()), [['status: "pending"', 'status: "complete"']]);
});

test('a file that is not a plan of this project\'s plans folder is refused, through a link or not', async (t) => {
  const fx = fixture(t);
  const repo = path.join(fx.root, 'checkout');
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const outside = path.join(repo, 'docs/plan.md');
  writeFileSync(outside, PLAN);
  execFileSync('git', ['add', '.'], { cwd: repo });
  symlinkSync(outside, path.join(fx.plans, 'link.md'));
  symlinkSync(path.join(repo, 'docs'), path.join(fx.plans, 'folder'));
  symlinkSync(path.join(fx.root, 'gone.md'), path.join(fx.plans, 'broken.md'));
  writeFileSync(path.join(fx.state, 'plan.md'), PLAN);
  mkdirSync(path.join(fx.plans, 'sub'));
  writeFileSync(path.join(fx.plans, 'sub/plan.md'), PLAN);
  mkdirSync(path.join(fx.state, 'plans-2'));
  writeFileSync(path.join(fx.state, 'plans-2/plan.md'), PLAN);
  const others = [outside, path.join(fx.plans, 'sub/plan.md'), fx.plans, path.join(fx.plans, 'link.md'), path.join(fx.plans, 'folder/plan.md'), `${fx.plans}/folder/../plan.md`, path.join(fx.state, 'plan.md'), path.join(fx.state, 'plans-2/plan.md'), path.join(fx.plans, '../plan.md'), '../checkout/docs/plan.md'];
  for (const other of others) {
    await refused(fx, ['set', other, 'S1', 'complete'], /is not a plan directly in/u);
    await refused(fx, ['record', other, '--by', 'a', '--text', 't'], /is not a plan directly in/u);
  }
  for (const file of [outside, path.join(fx.plans, 'sub/plan.md')]) assert.equal(readFileSync(file, 'utf8'), PLAN);
  writeFileSync(path.join(fx.plans, 'notes.txt'), PLAN);
  mkdirSync(path.join(fx.plans, 'dir.md'));
  for (const none of ['gone.md', 'broken.md', 'notes.txt', 'dir.md']) await refused(fx, ['set', path.join(fx.plans, none), 'S1', 'complete'], /names no plan/u);

  // A plans folder that is itself a link, into a checkout or not, holds no local plan.
  const elsewhere = path.join(fx.root, 'elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'plan.md'), PLAN);
  for (const target of [path.join(repo, 'docs'), elsewhere]) {
    rmSync(fx.plans, { recursive: true });
    symlinkSync(target, fx.plans);
    for (const other of [path.join(target, 'plan.md'), path.join(fx.plans, 'plan.md')]) {
      const { status, stderr } = await fx.run('set', other, 'S1', 'complete');
      assert.equal(status, 2);
      assert.match(stderr, /is not a plan directly in/u);
    }
    assert.equal(readFileSync(path.join(target, 'plan.md'), 'utf8'), PLAN);
    assert.deepEqual(readdirSync(target), ['plan.md'], 'no lock file either');
  }
});

test('a link to a plan in the plans folder marks that plan, and leaves a hard link to it elsewhere alone', async (t) => {
  const fx = fixture(t);
  const hard = path.join(fx.root, 'hard.md');
  linkSync(fx.file, hard);
  const link = path.join(fx.root, 'alias.md');
  symlinkSync(fx.file, link);
  await accepted(fx, 'set', link, 'S1', 'complete');
  assert.match(fx.read(), /^status: "complete"$/mu);
  assert.equal(readFileSync(hard, 'utf8'), PLAN);
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  // From another folder, and by a path relative to it.
  const { status } = await cliCall(['plan', 'set', path.relative(fx.dir, fx.file), 'A1', 'complete', '--project', fx.dir], { cwd: fx.dir });
  assert.equal(status, 0);
});

test('a state folder inside a checkout: a plan git tracks is refused, and one it does not track is marked', async (t) => {
  const fx = fixture(t);
  execFileSync('git', ['init', '-q'], { cwd: fx.root });
  await accepted(fx, 'set', fx.file, 'S1', 'in_progress');
  execFileSync('git', ['add', '-f', fx.file], { cwd: fx.root });
  // Whatever repository the environment points git at, the plan's own folder is asked: `other` does not track it.
  const other = path.join(fx.root, 'other');
  mkdirSync(other);
  execFileSync('git', ['init', '-q'], { cwd: other });
  for (const env of [{}, { GIT_DIR: path.join(other, '.git') }]) {
    const { status, stderr } = await cliCall(['plan', 'set', fx.file, 'S1', 'complete'], { cwd: fx.dir, env: { ...process.env, ...env } });
    assert.equal(status, 2);
    assert.match(stderr, /may be a file git tracks/u);
  }
  assert.deepEqual(changed(PLAN, fx.read()), [['status: "pending"', 'status: "in_progress"']]);

  // A checkout git cannot read may track it.
  const broken = fixture(t);
  writeFileSync(path.join(broken.root, '.git'), 'gitdir: none\n');
  await refused(broken, ['set', broken.file, 'S1', 'complete'], /may be a file git tracks/u);
});

// Runs `body` with a node:fs function of the plan's replaced, and puts it back.
function swapped(name, replacement, body) {
  const real = fs[name];
  fs[name] = replacement(real);
  syncBuiltinESMExports();
  try {
    return body();
  } finally {
    fs[name] = real;
    syncBuiltinESMExports();
  }
}

// Whether the lock of `file` is held: its newest generation is not released (lib/jsonl.mjs withLocks).
function lockHeld(file) {
  const names = readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.lock.`));
  const newest = Math.max(0, ...names.filter((name) => !name.endsWith('.released')).map((name) => Number(name.split('.').at(-1))));
  return newest > 0 && !names.includes(`${path.basename(file)}.lock.${newest}.released`);
}

test('two marks at once on different slices both land, each read and written under the lock', (t) => {
  const fx = fixture(t);
  t.mock.method(console, 'log', () => {});
  // The second call runs whole between the first one's first read of the plan and its lock, as another process's would.
  const seen = [];
  let second = null;
  const opening = (real) => function openSync(...args) {
    const fd = real.apply(this, args);
    if (args[0] !== fx.file) return fd;
    seen.push(['read', lockHeld(fx.file)]);
    if (second === null) {
      second = -1;
      second = planCommand(['set', fx.file, 'A1', 'complete', '--project', fx.dir]);
      seen.length = 0;
    }
    return fd;
  };
  const renaming = (real) => function renameSync(...args) {
    if (args[1] === fx.file) seen.push(['write', lockHeld(fx.file)]);
    return real.apply(this, args);
  };
  const first = swapped('openSync', opening, () => swapped('renameSync', renaming, () => planCommand(['set', fx.file, 'S1', 'in_progress', '--project', fx.dir])));
  assert.deepEqual([first, second], [0, 0]);
  assert.deepEqual(seen, [['read', true], ['write', true]], 'the read the write is made from, and the write, are under the lock');
  assert.equal(lockHeld(fx.file), false);
  assert.deepEqual(changed(PLAN, fx.read()), [['status: "pending"', 'status: "in_progress"'], ['status: pending   # waits for the reviewer', 'status: complete']]);
});

test('a write the system refuses exits 1 and leaves the plan, no temporary file, and no held lock', (t) => {
  const fx = fixture(t);
  const errors = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const failing = () => function renameSync(from, to) {
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'\u001b[31m`), { code: 'EPERM', syscall: 'rename' });
  };
  const set = () => planCommand(['set', fx.file, 'S1', 'complete', '--project', fx.dir]);
  assert.equal(swapped('renameSync', failing, set), 1);
  assert.match(errors.mock.calls[0].arguments[0], /^EPERM: operation not permitted[^\u001b]*$/u);
  assert.equal(fx.read(), PLAN);
  assert.deepEqual(readdirSync(fx.plans).filter((name) => name.endsWith('.tmp')), []);
  assert.equal(lockHeld(fx.file), false);
  assert.equal(set(), 0);
});

test('a plan swapped for a link after it was judged is not read through the link', (t) => {
  const fx = fixture(t);
  t.mock.method(console, 'error', () => {});
  const other = path.join(fx.root, 'other.md');
  writeFileSync(other, PLAN);
  const swap = (real) => function openSync(...args) {
    if (args[0] === fx.file && !fs.lstatSync(fx.file).isSymbolicLink()) {
      rmSync(fx.file);
      symlinkSync(other, fx.file);
    }
    return real.apply(this, args);
  };
  assert.equal(swapped('openSync', swap, () => planCommand(['record', fx.file, '--by', 'a', '--text', 't', '--project', fx.dir])), 2);
  assert.equal(readFileSync(other, 'utf8'), PLAN);
  assert.deepEqual(readdirSync(fx.plans), [path.basename(fx.file)], 'no lock file either');
});

test('a plan whose lock another process holds is not written, and the command says so', async (t) => {
  const fx = fixture(t);
  // This process's parent holds it: a live process of this host that never releases.
  writeFileSync(`${fx.file}.lock.1`, JSON.stringify({ pid: process.ppid, host: hostname(), nonce: 'x' }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 1000));
  const { status, stderr } = await fx.run('set', fx.file, 'S1', 'complete');
  assert.equal(status, 1);
  assert.match(stderr, /is locked by another process/u);
  assert.equal(fx.read(), PLAN);
});

test('bin/aidrian runs it as a process, and an unknown option exits 1 with nothing written', async (t) => {
  const fx = fixture(t);
  const ran = spawnSync(CLI, ['plan', 'set', fx.file, 'S1', 'complete'], { cwd: fx.dir, encoding: 'utf8' });
  assert.deepEqual([ran.status, ran.stderr], [0, '']);
  const before = fx.read();
  for (const args of [['set', fx.file, 'S1', 'blocked', '--text', 'x'], ['record', fx.file, '--by', 'a', '--text', 'x', '--note', 'y']]) assert.equal((await fx.run(...args)).status, 1, args.join(' '));
  assert.equal(fx.read(), before);
});

test('the orchestrator asks one question before a record, and the skills name the command for a local plan', () => {
  const read = (rel) => readFileSync(path.resolve(import.meta.dirname, '../plugins/aidrian', rel), 'utf8');
  const rule = /Does a record change what any slice must do\? A yes is content\./u;
  for (const rel of ['agents-src/coordination/orchestrator.md', 'agents/orchestrator.md', 'codex/agents/aidrian-orchestrator.toml']) {
    assert.match(read(rel), /Plan content: `planning-agent`\. Never rewrite its plan\. A slice's status, notes, or a record that changes no slice: `aidrian plan`\./u, rel);
    assert.match(read(rel), rule, rel);
  }
  const steps = read('skills/issue-implement/steps/phases-1-4-implement.md');
  assert.match(steps, /1\. \*\*Plan state\.\*\*[\s\S]*?`aidrian plan set <plan> <slice> in_progress`[\s\S]*?When git tracks the plan file[\s\S]*?`planning-agent` makes this edit and step 9's[\s\S]*?9\. \*\*Commit\.\*\*[\s\S]*?`aidrian plan set <plan> <slice> complete`/u);
  assert.match(read('skills/issue-implement/steps/phases-5-8-close.md'), /`aidrian plan set <plan> INTEGRATION-REVIEW complete --note '[^']+'`\.\nWhen git tracks the plan, `planning-agent` makes that edit/u);
  assert.match(read('skills/planning-agent/references/plan-file.md'), /## Re-entry contract[\s\S]*?`aidrian plan set <plan> <slice> <status> \[--note TEXT\]`[\s\S]*?`aidrian plan record /u);
});
