import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  carriedItems,
  chainOf,
  checkBrief,
  findCarryGaps,
  findSupersededBrief,
  resolvePrior,
  snapshotPath,
  takeSnapshot,
} from '../plugins/aidrian/lib/handoff-brief.mjs';
import { checkedSha, noteFrom, openStore } from '../plugins/aidrian/lib/handoff-markers.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');

// Synthetic ids only: briefs carry real customer data, fixtures never do.
const ADVICE = 'Advice from Claude, not a spec: check each claim against the docs and code before building on it.';
const PRIOR = `# Handoff: heal cancelled subscriptions
Written: 2026-01-01 | Session phase completed: plan
${ADVICE}

## Decisions locked (do not relitigate)
- Mechanism: create a replacement with \`billing_cycle_anchor\` = paid period end.
- Model: every dispatched agent uses opus.

## Done
- Plan approved.

\`\`\`text
## Gotchas
- inside a fence: \`not-a-section-token\`
\`\`\`

## Gotchas
- Customer = \`cus_TEST0001\`, old subscription \`sub_TEST0002\`.
  - Its org is uuid \`00000000-0000-0000-0000-000000000003\`.
- Never edit \`sub_TEST0…\` in the dashboard before deploy.
- Production DB was hand-edited to show the customer active.
`;

// The five sections a brief must hold, with no identifier of their own: what a fixture that must pass adds.
const SECTIONS = `
## Objective
- Heal the cancelled subscription.

## Current state
- Worktree: none yet; create one in step 1 | Branch: to create | Pull request: none

## Still running
None.

## Next steps (ordered)
1. Run the suite.

## Open risks and questions
None.
`;
// A brief that passes the check on its own: a header with the advice line and a Supersedes field, then the sections.
const complete = (body = '', header = 'Supersedes: none') => `# Handoff: heal\nWritten: 2026-01-02 | ${header}\n${ADVICE}\n${SECTIONS}${body}`;
// PRIOR's Decisions locked and Gotchas, carried whole.
const CARRIED = PRIOR.slice(PRIOR.indexOf('## Decisions locked'));

const tempBriefDir = () => mkdtempSync(path.join(tmpdir(), 'aidrian-handoff-'));
const write = (dir, name, text) => {
  const file = path.join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
};
test('carriedItems keeps only Decisions and Gotchas items, with their sub-bullets', () => {
  const items = carriedItems(PRIOR);
  assert.deepEqual(
    items.map((item) => item.section),
    ['Decisions locked', 'Decisions locked', 'Gotchas', 'Gotchas', 'Gotchas'],
  );
  assert.deepEqual(items[2].identifiers, ['cus_TEST0001', 'sub_TEST0002', '00000000-0000-0000-0000-000000000003']);
  assert.ok(!items.some((item) => item.text.includes('not-a-section-token')), 'a fenced heading opens no section');
});

test('a fenced block in a carried section rides with the item above it', () => {
  const items = carriedItems('## Gotchas\n- Rebase with:\n```bash\ngit rebase --onto origin/main `old-head`\n```\n- Next.\n');
  assert.equal(items.length, 2);
  assert.deepEqual(items[0].identifiers, ['old-head']);
});

test('carriedItems ignores spans too short to be identifiers', () => {
  const [item] = carriedItems('## Gotchas\n- never use `!` or `ok`, use `unlink`.\n');
  assert.deepEqual(item.identifiers, ['unlink']);
});

test('a span the prior wraps across lines yields its real identifiers, not the prose between them', () => {
  const [item] = carriedItems('## Decisions locked\n- Heal with `node scripts/heal.mjs\n  --dry-run` and then `cus_TEST0001`.\n');
  assert.deepEqual(item.identifiers, ['node scripts/heal.mjs --dry-run', 'cus_TEST0001']);
});

test('a span the new brief wraps across lines still counts as carried', () => {
  const prior = '## Gotchas\n- Run `node scripts/heal.mjs --customer cus_TEST0001 --dry-run` before any write.\n';
  const brief = '# Handoff\n## Gotchas\n- Run `node scripts/heal.mjs --customer cus_TEST0001\n  --dry-run` before any write.\n';
  assert.deepEqual(findCarryGaps(brief, prior).missing, []);
});

test('a four-backtick fence showing a literal triple-backtick opener hides its headings', () => {
  const prior = [
    '## Decisions locked',
    '- Keep `real-id`.',
    '## Done',
    '````markdown',
    '```bash',
    '## Decisions locked',
    '- `phantom-id`',
    '````',
    '## Resume',
    '- `resume-only-id`',
  ].join('\n');
  const items = carriedItems(prior);
  assert.deepEqual(
    items.map((item) => [item.section, item.identifiers]),
    [['Decisions locked', ['real-id']]],
  );
});

test('a brief that points at the superseded one instead of carrying it is flagged', () => {
  const pointer = '# Handoff\nSupersedes the earlier brief.\n\n## Gotchas\n- The earlier brief\'s Decisions and Gotchas still hold.\n';
  const { missing, unchecked } = findCarryGaps(pointer, PRIOR);
  assert.deepEqual(
    missing.flatMap((item) => item.identifiers),
    ['billing_cycle_anchor', 'cus_TEST0001', 'sub_TEST0002', '00000000-0000-0000-0000-000000000003', 'sub_TEST0…'],
  );
  assert.deepEqual(
    unchecked.map((item) => item.text),
    ['- Model: every dispatched agent uses opus.', '- Production DB was hand-edited to show the customer active.'],
  );
});

test('an identifier named anywhere in the new brief counts as carried; an abbreviation matches by prefix', () => {
  const carried = [
    '# Handoff',
    'Supersedes the earlier brief. Dropped as obsolete: `billing_cycle_anchor` note (now in the plan).',
    '## Done',
    '- Replacement created for `cus_TEST0001` (`sub_TEST0002` cancelled; org `00000000-0000-0000-0000-000000000003`).',
  ].join('\n');
  assert.deepEqual(findCarryGaps(carried, PRIOR).missing, []);
});

test('findSupersededBrief picks the newest other brief with the exact same slug', () => {
  const dir = tempBriefDir();
  write(dir, '2026-01-01-task.md', 'old');
  write(dir, '2026-01-02-task.md', 'newer');
  write(dir, '2026-01-03-task.pm-rulings.md', 'another slug');
  write(dir, '2026-01-03-other.md', 'another task');
  const brief = path.join(dir, '2026-01-03-task.md');
  assert.equal(findSupersededBrief(brief), path.join(dir, '2026-01-02-task.md'));
  assert.equal(findSupersededBrief(path.join(dir, 'not-a-brief.md')), null);
});

test('findSupersededBrief orders by the date in the name, not mtime, and skips a later-dated brief', () => {
  const dir = tempBriefDir();
  const older = write(dir, '2026-01-01-task.md', 'old, touched last');
  write(dir, '2026-01-02-task.md', 'newer, touched first');
  write(dir, '2026-01-04-task.md', 'later than the brief');
  utimesSync(older, new Date('2030-01-01'), new Date('2030-01-01'));
  utimesSync(path.join(dir, '2026-01-02-task.md'), new Date('2020-01-01'), new Date('2020-01-01'));
  assert.equal(findSupersededBrief(path.join(dir, '2026-01-03-task.md')), path.join(dir, '2026-01-02-task.md'));
});

test('resolvePrior order: explicit, then snapshot, then same slug', () => {
  const dir = tempBriefDir();
  write(dir, '2026-01-01-task.md', PRIOR);
  const brief = write(dir, '2026-01-02-task.md', 'new');
  assert.deepEqual(resolvePrior(brief), { path: path.join(dir, '2026-01-01-task.md'), source: 'same slug' });
  mkdirSync(path.dirname(snapshotPath(brief)), { recursive: true });
  writeFileSync(snapshotPath(brief), PRIOR);
  assert.equal(resolvePrior(brief).source, 'snapshot');
  assert.deepEqual(resolvePrior(brief, '/x/prior.md'), { path: '/x/prior.md', source: 'explicit' });
});

test('takeSnapshot keeps the brief a same-path refresh would overwrite', () => {
  const dir = tempBriefDir();
  const brief = write(dir, '2026-01-02-task.md', PRIOR);
  const taken = takeSnapshot(brief);
  assert.equal(taken.source, brief);
  assert.equal(readFileSync(snapshotPath(brief), 'utf8'), PRIOR);
});

test('takeSnapshot falls back to the same-slug brief, and clears a stale snapshot when nothing is superseded', () => {
  const dir = tempBriefDir();
  const older = write(dir, '2026-01-01-task.md', PRIOR);
  const brief = path.join(dir, '2026-01-02-task.md');
  assert.equal(takeSnapshot(brief).source, older);

  const lone = path.join(dir, '2026-01-02-lone.md');
  mkdirSync(path.dirname(snapshotPath(lone)), { recursive: true });
  writeFileSync(snapshotPath(lone), 'stale');
  assert.equal(takeSnapshot(lone), null);
  assert.equal(existsSync(snapshotPath(lone)), false);
});

test('checkBrief fails on a lost identifier and keeps the snapshot for the fix round', () => {
  const dir = tempBriefDir();
  const brief = write(dir, '2026-01-02-task.md', PRIOR);
  takeSnapshot(brief);
  writeFileSync(brief, '# Handoff\n\n## Gotchas\n- The earlier brief still holds.\n');
  const result = checkBrief(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /\(snapshot\)/);
  assert.match(result.lines.join('\n'), /`cus_TEST0001`/);
  assert.equal(existsSync(snapshotPath(brief)), true);
});

test('checkBrief passes a brief that carries everything, and keeps it as the snapshot', () => {
  const dir = tempBriefDir();
  const brief = write(dir, '2026-01-02-task.md', PRIOR);
  takeSnapshot(brief);
  writeFileSync(brief, complete(`\n${CARRIED}`));
  const result = checkBrief(brief);
  assert.equal(result.exitCode, 0);
  assert.equal(result.lines.at(-1), 'OK');
  assert.equal(readFileSync(snapshotPath(brief), 'utf8'), complete(`\n${CARRIED}`));
});

test('checkBrief prints a prose-only item whole, even on the exit-0 run that keeps the snapshot', () => {
  const dir = tempBriefDir();
  const first = '- Production DB was hand-edited to show the customer active, so every check that reads the subscription row agrees.';
  const continuation = '  Restore it from the dashboard export before deploying the heal.';
  const brief = write(dir, '2026-01-02-task.md', complete(`\n## Gotchas\n${first}\n${continuation}\n`));
  takeSnapshot(brief);
  const result = checkBrief(brief);
  assert.equal(result.exitCode, 0);
  assert.equal(readFileSync(snapshotPath(brief), 'utf8'), complete(`\n## Gotchas\n${first}\n${continuation}\n`));
  const at = result.lines.indexOf(`  - [Gotchas] ${first}`);
  assert.ok(at !== -1, 'the first line is printed uncut');
  assert.equal(result.lines[at + 1], `    ${continuation}`);
});

test('checkBrief reports lines over the wrap limit, outside fences only', () => {
  const dir = tempBriefDir();
  const long = `- ${'word '.repeat(40)}`;
  const brief = write(dir, '2026-01-02-solo.md', `# Handoff\n${long}\n\`\`\`text\n${long}\n\`\`\`\n`);
  const result = checkBrief(brief);
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /Lines over 155 characters \(wrap them\): L2 \(\d+\)$/m);
  assert.match(result.lines.join('\n'), /no superseded brief found/);
});

test('checkBrief fails a brief with no advice line above its first section, and passes it once there', () => {
  const dir = tempBriefDir();
  const body = '\n## Next steps (ordered)\n1. Run the suite.\n';
  const brief = write(dir, '2026-01-02-solo.md', `# Handoff: solo\nWritten: 2026-01-02${body}`);
  const missing = checkBrief(brief);
  assert.equal(missing.exitCode, 1);
  assert.match(missing.lines.join('\n'), /^No advice line above the first section: add "Advice from <writer>, not a spec: /m);
  writeFileSync(brief, `# Handoff: solo${body}${ADVICE}\n`);
  assert.equal(checkBrief(brief).exitCode, 1, 'the line counts only above the first section');
  writeFileSync(brief, `# Handoff: solo\nWritten: 2026-01-02\n${ADVICE}${body}`);
  const alone = checkBrief(brief);
  assert.equal(alone.exitCode, 1, 'an advice line and a Next steps section alone');
  assert.deepEqual(alone.lines.filter((line) => /^[A-Z][\w ]+: /u.test(line)).map((line) => line.split(':')[0]),
    ['Objective', 'Current state', 'Still running', 'Open risks and questions', 'Supersedes']);
  writeFileSync(brief, complete());
  assert.equal(checkBrief(brief).exitCode, 0);
});

test('an explicit --prior wins over the same-slug brief', () => {
  const dir = tempBriefDir();
  write(dir, '2026-01-01-task.md', '## Gotchas\n- `only-in-same-slug`\n');
  const renamed = write(dir, '2026-01-01-old-name.md', PRIOR);
  const brief = write(dir, '2026-01-02-task.md', '# Handoff\n- `only-in-same-slug`\n');
  const result = checkBrief(brief, renamed);
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.join('\n'), /old-name\.md \(explicit\)/);
});

test('aidrian handoff: exit codes for usage, snapshot, findings, a clean brief, and an unreadable input', () => {
  const dir = tempBriefDir();
  const older = write(dir, '2026-01-01-task.md', PRIOR);
  const brief = path.join(dir, '2026-01-02-task.md');
  const run = (...args) => spawnSync(CLI, ['handoff', ...args], { cwd: dir, encoding: 'utf8' });
  assert.equal(run().status, 2);
  assert.equal(run('check').status, 2);
  assert.deepEqual([run('check', brief, '--prior', path.join(dir, 'missing.md')).status, run('check', brief).stderr], [2, `${brief} does not exist\n`]);
  assert.match(run('snapshot', brief).stdout, /^saved \S+2026-01-01-task\.md to \S+\.prior\/2026-01-02-task\.md\n$/);
  writeFileSync(brief, '# Handoff\n');
  const findings = run('check', brief);
  assert.equal(findings.status, 1);
  assert.match(findings.stderr, /identifier\(s\) no longer named/);
  assert.ok(readFileSync(older, 'utf8').includes(CARRIED));
  writeFileSync(brief, complete(`\n${CARRIED}`));
  assert.deepEqual([run('check', brief).status, run('check', brief).stdout.trim().split('\n').at(-1)], [0, 'OK']);
  const notAFile = path.join(dir, 'folder.md');
  mkdirSync(notAFile);
  assert.deepEqual([run('check', notAFile).status, run('check', notAFile).stderr], [2, `${notAFile} is not a file\n`]);
});

test('the line-length limit comes from config.json, and 0 turns it off', () => {
  const dir = tempBriefDir();
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, docs: { wrapLimit: 0 } }));
  const brief = write(dir, '2026-01-02-solo.md', complete(`- ${'word '.repeat(40)}\n`));
  assert.equal(spawnSync(CLI, ['handoff', 'check', brief], { cwd: dir, encoding: 'utf8' }).status, 0);
  assert.equal(checkBrief(brief, undefined, 155).exitCode, 1);
});

test('chainOf reads Chain: n above the first section; none is 0, and a value that is no whole number is null', () => {
  assert.equal(chainOf(`# Handoff\nWritten: 2026-11-15 | Chain: 2\n${ADVICE}\n`), 2);
  assert.equal(chainOf(`# Handoff\nWritten: 2026-11-15\n${ADVICE}\n\n## Done\n- Chain: 5\n`), 0, 'below the first section counts for nothing');
  for (const value of ['two', '-1', '1.5', '']) assert.equal(chainOf(`# Handoff\nWritten: x | Chain: ${value}\n`), null, value);
});

test('checkBrief fails a Chain that is no whole number, and one below the floor it is given', () => {
  const dir = tempBriefDir();
  const brief = write(dir, '2026-01-02-solo.md', `# Handoff\nWritten: 2026-01-02 | Chain: x\n${ADVICE}\n`);
  const bad = checkBrief(brief, undefined, 0);
  assert.equal(bad.exitCode, 1);
  assert.match(bad.lines.join('\n'), /Chain: the value is not a whole number/u);
  writeFileSync(brief, complete('', 'Chain: 1 | Supersedes: none'));
  assert.equal(checkBrief(brief, undefined, 0, { floor: 1 }).exitCode, 0);
  const low = checkBrief(brief, undefined, 0, { floor: 2 });
  assert.equal(low.exitCode, 1);
  assert.match(low.lines.join('\n'), /Chain: 1 is below 2, the count this session continues: write `Chain: 2`/u);
});

test('a passing check stamps a brief inside <state>/handoffs/ with its bytes, and only there; the command holds the session floor', (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-stamp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  const state = path.join(root, 'state');
  mkdirSync(path.join(project, '.aidrian'), { recursive: true });
  mkdirSync(path.join(state, 'handoffs'), { recursive: true });
  writeFileSync(path.join(project, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: state } }));
  const store = openStore(state, { checkouts: [project], maxChain: 3 });
  const text = complete('', 'Chain: 0 | Supersedes: none');
  const inside = write(path.join(state, 'handoffs'), '2026-11-15-task.md', text);
  const outside = write(project, '2026-11-15-task.md', text);
  assert.equal(checkBrief(outside, undefined, 0, { store }).exitCode, 0);
  assert.equal(checkedSha(store, '2026-11-15-task.md'), null, 'no stamp for a brief outside the handoffs folder');
  assert.equal(checkBrief(inside, undefined, 0, { store }).exitCode, 0);
  const stamped = checkedSha(store, '2026-11-15-task.md');
  assert.match(stamped, /^[0-9a-f]{64}$/u);
  writeFileSync(inside, `${text}- More.\n`);
  assert.equal(checkBrief(inside, undefined, 0).exitCode, 0);
  assert.equal(checkedSha(store, '2026-11-15-task.md'), stamped, 'a check with no store stamps nothing');

  const env = { ...process.env, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'continued-1' };
  const check = () => spawnSync(CLI, ['handoff', 'check', inside], { cwd: project, encoding: 'utf8', env });
  assert.equal(check().status, 0, 'no floor yet');
  assert.notEqual(checkedSha(store, '2026-11-15-task.md'), stamped, 'the command stamps the changed brief');
  noteFrom(store, 'continued-1', { slug: 'task', chain: 1, brief: inside, route: 'clear' });
  const low = check();
  assert.equal(low.status, 1);
  assert.match(low.stderr, /Chain: 0 is below 1/u);
  // A session continued from one brief that hands off under another slug is still the same run of continuations.
  noteFrom(store, 'continued-1', { slug: 'other', chain: 2, brief: path.join(state, 'handoffs/2026-11-15-other.md'), route: 'clear' });
  const renamed = check();
  assert.equal(renamed.status, 1, 'a floor given for another slug holds too');
  assert.match(renamed.stderr, /Chain: 0 is below 2/u);
});
