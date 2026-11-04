import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { blockAbove, findWording, parseDecisions, recordAt, undoDecision, wordingProblems } from '../plugins/aidrian/lib/decisions.mjs';
import { fencedIn } from '../plugins/aidrian/lib/markdown-sections.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/bin/aidrian');

const marker = (id = 'refund-copy', status = 'unconfirmed') => `<!-- aidrian:decision id=${id} status=${status} class=copy domain=ux date=2026-11-01 pr=41 -->`;
const wording = (kind, text, id = 'refund-copy') => `<!-- aidrian:decision-${kind} id=${id} text=${JSON.stringify(text).replaceAll('-->', '-\\u002d>')} -->`;
// One decision's lines: its marker, its old wording when it has any, and its new wording.
const record = ({ id, was, wrote, status }) => [marker(id, status), ...(was === undefined ? [] : [wording('old', was, id)]), wording('new', wrote, id)];
const undone = (text, id = 'refund-copy') => {
  const out = undoDecision(text, id);
  assert.equal(out.refused, undefined, out.refused);
  return out.text;
};

test('undo replaces one line with two and two with one, every other byte as it was', () => {
  const around = ['# Refunds  ', '', 'Before.\t', ''];
  const after = ['', '  trailing spaces stay  ', 'last, no newline'];
  const doc = (rule, ...rest) => [...around, ...rule, ...rest, ...after].join('\n');
  const twoLines = ['Refunds take ten days.', 'Ask support first.'];
  const oneToTwo = doc(['Refunds take five days.'], ...record({ was: twoLines.join('\n'), wrote: 'Refunds take five days.' }));
  assert.equal(undone(oneToTwo), doc(twoLines));
  const twoToOne = doc(twoLines, ...record({ was: 'Refunds take five days.', wrote: twoLines.join('\n') }));
  assert.equal(undone(twoToOne), doc(['Refunds take five days.']));
});

test('undo keeps CRLF, on the restored lines too, and a doc with no last newline stays clean', () => {
  const rule = 'Five days.';
  const before = ['# Doc', '', rule, ...record({ was: 'Ten days.\nAsk first.', wrote: rule }), '', 'Next.', ''].join('\r\n');
  assert.equal(undone(before), ['# Doc', '', 'Ten days.', 'Ask first.', '', 'Next.', ''].join('\r\n'));
  const last = ['Above.', rule, ...record({ was: 'Ten days.', wrote: rule })].join('\r\n');
  assert.equal(undone(last), 'Above.\r\nTen days.');
  const mixed = `Above.\r\n${rule}\n${record({ was: 'Ten days.', wrote: rule }).join('\n')}\nNext.\r\n`;
  assert.equal(undone(mixed), 'Above.\r\nTen days.\nNext.\r\n', 'each kept line keeps its own ending');
});

test('undo of a gap fill deletes the wording, and leaves no double blank line', () => {
  const rule = 'Tabs go by use.';
  const fill = record({ wrote: rule });
  assert.equal(undone(['Above.', '', rule, ...fill, '', 'Below.', ''].join('\n')), 'Above.\n\nBelow.\n');
  assert.equal(undone(['Above.', '', rule, ...fill, ''].join('\n')), 'Above.\n');
  assert.equal(undone(['Above.', rule, ...fill, 'Below.', ''].join('\n')), 'Above.\nBelow.\n', 'no blank to keep');
  assert.equal(undone(['a', '', '', 'b', '', rule, ...fill, '', 'c', ''].join('\n')), 'a\n\n\nb\n\nc\n', 'a double blank elsewhere stays');
  assert.equal(undone(['Above.\r', '\r', `${rule}\r`, ...fill.map((line) => `${line}\r`), '\r', 'Below.\r', ''].join('\n')), 'Above.\r\n\r\nBelow.\r\n');
});

test('undo matches a bullet with its indented continuation, indentation included, and leaves its siblings', () => {
  const rule = '- Refunds take five days,\n  and support answers.';
  const before = ['- First.', ...rule.split('\n'), ...record({ was: '- Refunds take ten days.', wrote: rule }).map((line) => `  ${line}`), '- Last.', ''].join('\n');
  assert.equal(undone(before), '- First.\n- Refunds take ten days.\n- Last.\n');
  const unindented = ['- Refunds take five days,', 'and support answers.', ...record({ wrote: rule })].join('\n');
  assert.match(undoDecision(unindented, 'refund-copy').refused, /not found in the block/u, 'indentation is part of the wording');
  const spaces = ['- Refunds take five days,   ', '  and support answers.\t', ...record({ wrote: rule }), ''].join('\n');
  assert.equal(undone(spaces), '', 'trailing whitespace alone does not count');
});

test('a table row is replaced, and removed, with the rest of the table kept', () => {
  const table = ['| a | b |', '| - | - |'];
  const replaced = [...table, '| 1 | five |', '| 2 | two |', ...record({ was: '| 1 | ten |', wrote: '| 1 | five |' }), '', 'Next.', ''].join('\n');
  assert.equal(undone(replaced), `${[...table, '| 1 | ten |', '| 2 | two |'].join('\n')}\n\nNext.\n`);
  const added = [...table, '| 1 | one |', '| 2 | new |', ...record({ wrote: '| 2 | new |' }), '', 'Next.', ''].join('\n');
  assert.equal(undone(added), `${[...table, '| 1 | one |'].join('\n')}\n\nNext.\n`);
});

test('a rule ending in a code block is restored, fences, blank lines, and quoted markers included', () => {
  const code = ['```sh', 'npm test', '', `# ${marker('quoted')}`, '```'];
  const was = ['Run:', '```sh', 'make test', '```'].join('\n');
  const before = ['Run:', ...code, ...record({ was, wrote: ['Run:', ...code].join('\n') }), ''].join('\n');
  assert.deepEqual(parseDecisions(before).problems, [], 'a marker directly below the closing fence is in place');
  assert.deepEqual(wordingProblems(before), []);
  assert.equal(undone(before), `${was}\n`);
});

test('a stack undoes bottom up only, and ends at the original wording', () => {
  const stack = [
    'Third rule.',
    ...record({ id: 'first', was: 'Original rule.', wrote: 'Second rule.' }),
    ...record({ id: 'second', was: 'Second rule.', wrote: 'Third rule.' }),
    '',
    'Next.',
    '',
  ];
  const before = stack.join('\n');
  assert.deepEqual(parseDecisions(before).problems, []);
  const refused = undoDecision(before, 'first');
  assert.equal(refused.refused, 'a later decision second replaced this wording; undo that one first');
  assert.equal(refused.decision.newWording, 'Second rule.');
  assert.deepEqual(refused.block, ['Third rule.']);
  const once = undone(before, 'second');
  assert.equal(once, ['Second rule.', ...record({ id: 'first', was: 'Original rule.', wrote: 'Second rule.' }), '', 'Next.', ''].join('\n'));
  assert.equal(undone(once, 'first'), 'Original rule.\n\nNext.\n');
});

test('a broken decision line below the marker blocks undo too, naming no id it cannot read', () => {
  const first = record({ id: 'first', wrote: 'Rule.' });
  for (const line of [marker('Bad_Id'), '<!-- aidrian:decision id=open status=unconfirmed', `A prose line, then ${marker('second')}`]) {
    const out = undoDecision(['Rule.', ...first, line, ''].join('\n'), 'first');
    assert.match(out.refused, /a later decision line it cannot read/u, line);
    assert.equal(out.text, undefined, line);
  }
  const quoted = `Write \`${marker('second')}\` to record one.`;
  assert.equal(undone(['Rule.', ...first, quoted, ''].join('\n'), 'first'), `${quoted}\n`, 'a marker in a code span is a quote');
});

test('undo refuses when the marker above wrote wording this marker\'s old wording is not, so the stack would not go back', () => {
  const first = record({ id: 'first', was: 'Orig.', wrote: 'Second.' });
  const refusal = (text) => {
    const out = undoDecision(text, 'second');
    assert.equal(out.text, undefined, text);
    return out;
  };
  const other = refusal(['Third.', ...first, ...record({ id: 'second', was: 'Other.', wrote: 'Third.' }), ''].join('\n'));
  assert.match(other.refused, /its old wording is not the wording "first" wrote/u);
  assert.deepEqual([other.decision.oldWording, other.decision.newWording, other.block], ['Other.', 'Third.', ['Third.']]);
  assert.match(refusal(['Third.', ...first, ...record({ id: 'second', wrote: 'Third.' }), ''].join('\n')).refused, /its old wording is not the wording "first" wrote/u, 'no old wording at all');
  assert.equal(undone(['Third.  ', ...first, ...record({ id: 'second', was: 'Second.   ', wrote: 'Third.' }), ''].join('\n'), 'second'), `Second.   \n${first.join('\n')}\n`, 'compared as wordingProblems does: trailing whitespace aside');

  const second = record({ id: 'second', was: 'Second.', wrote: 'Third.' });
  const unreadable = '<!-- aidrian:decision-new id=first text=oops -->';
  const cases = [
    ['unreadable upper wording', [marker('first'), unreadable]],
    ['no upper new wording', [marker('first')]],
    ['a malformed upper marker', [marker('first').replace('class=copy', 'class=pricing'), wording('new', 'Second.', 'first')]],
    ['an orphaned wording line', [wording('new', 'Second.', 'first')]],
  ];
  for (const [what, upper] of cases) {
    const before = ['Third.', ...upper, ...second, ''].join('\n');
    const out = refusal(before);
    assert.match(out.refused, /the decision line above it has no wording it can read/u, what);
    assert.deepEqual([out.decision.id, out.block], ['second', ['Third.']], what);
  }
  const fenced = ['```', wording('new', 'Second.', 'first'), '```', 'Third.', ...second, ''].join('\n');
  assert.ok(undoDecision(fenced, 'second').text, 'a quoted line above is no decision line');
  const closing = ['Third.', '```', wording('new', 'Other.', 'first'), '```', ...record({ id: 'second', was: 'Second.', wrote: 'Third.\n```\n' + wording('new', 'Other.', 'first') + '\n```' }), ''].join('\n');
  assert.ok(undoDecision(closing, 'second').text, 'a closing fence above is the rule itself');
});

test('recordAt reads the raw wording from the named line down, and stops at a fence', () => {
  const broken = marker('broken').replace('class=copy', 'class=pricing');
  const oldLine = wording('old', 'Was.', 'broken');
  const newLine = wording('new', 'Rule.', 'broken');
  assert.deepEqual(recordAt(`Rule.\n${broken}\n${oldLine}\n  ${newLine}\nNext.\n`, 2), { wording: [oldLine, newLine], block: ['Rule.'] }, 'below a marker, its own line is no wording');
  assert.deepEqual(recordAt(`Rule.\n${newLine}\n${oldLine}\nNext.\n`, 2).wording, [newLine, oldLine], 'a named wording line is the first');
  assert.deepEqual(recordAt(`Rule.\n${broken}\n\`\`\`md ${newLine}\n${oldLine}\n\`\`\`\n`, 2).wording, [], 'a fence opener that names one is the fence');
  assert.deepEqual(recordAt(`Rule.\n${broken}\n\`${newLine}\` is how to write one.\n`, 2).wording, [], 'a code span is a quote');
  assert.deepEqual(recordAt(`Rule.\n${broken}\n`, 2).wording, []);
});

test('each refusal says why, and carries both wordings and the block', () => {
  const rule = 'Five days.';
  const good = record({ was: 'Ten days.', wrote: rule });
  const refusal = (text, id = 'refund-copy') => {
    const out = undoDecision(text, id);
    assert.equal(out.text, undefined, text);
    return out;
  };
  assert.match(refusal(`Rule.\n${good.join('\n')}\n`, 'no-such').refused, /no decision marker with id "no-such"/u);
  assert.match(refusal(`${rule}\n${good.join('\n')}\n\n${rule}\n${good.join('\n')}\n`).refused, /id "refund-copy" is on 2 markers: lines 2, 7/u);

  const missing = refusal(`Changed by hand.\n${good.join('\n')}\n`);
  assert.match(missing.refused, /not found in the block/u);
  assert.deepEqual([missing.decision.oldWording, missing.decision.newWording, missing.block], ['Ten days.', rule, ['Changed by hand.']]);

  const twice = refusal(`${rule}\n${rule}\n${good.join('\n')}\n`);
  assert.match(twice.refused, /found 2 times in the block/u);
  assert.deepEqual(twice.block, [rule, rule]);

  const misplaced = refusal(`${rule}\n\n${good.join('\n')}\n`);
  assert.match(misplaced.refused, /sits under a blank line/u);
  assert.deepEqual(misplaced.block, []);

  const noNew = refusal(`${rule}\n${marker()}\n${wording('old', 'Ten days.')}\n`);
  assert.match(noNew.refused, /records no wording it wrote: add a decision-new line/u);
  assert.equal(noNew.decision.oldWording, 'Ten days.');

  const unreadable = refusal(`${rule}\n${marker()}\n<!-- aidrian:decision-new id=refund-copy text=oops -->\n`);
  assert.match(unreadable.refused, /new wording is one HTML comment/u);
  assert.deepEqual([unreadable.decision.hasNewWording, unreadable.decision.newWording], [true, null]);

  const reversed = refusal(`${rule}\n${marker()}\n${wording('new', rule)}\n${wording('old', 'Ten days.')}\n`);
  assert.match(reversed.refused, /old wording comes after the new wording/u);

  const malformed = refusal(`${rule}\n${marker().replace('class=copy', 'class=pricing')}\n`);
  assert.match(malformed.refused, /class "pricing"/u, 'a malformed marker that names the id says what is wrong with it');
});

test('status is no gate: a confirmed or rejected marker undoes as an unconfirmed one does', () => {
  for (const status of ['confirmed', 'rejected']) {
    assert.equal(undone(['Five days.', ...record({ was: 'Ten days.', wrote: 'Five days.', status }), ''].join('\n')), 'Ten days.\n', status);
  }
});

test('blockAbove stops at a blank line outside a fence, a heading, a decision line, or the doc start', () => {
  const block = (doc) => {
    const lines = doc.split('\n');
    const { from, to } = blockAbove(lines, fencedIn(lines), lines.length - 1);
    return lines.slice(from, to);
  };
  const m = marker();
  assert.deepEqual(block(`one\ntwo\n${m}`), ['one', 'two'], 'the doc start');
  assert.deepEqual(block(`one\n\ntwo\n${m}`), ['two'], 'a blank line');
  assert.deepEqual(block(`# Title\ntwo\n${m}`), ['two'], 'a heading');
  assert.deepEqual(block(`one\n${marker('other')}\ntwo\n${m}`), ['two'], 'a decision line of another rule');
  assert.deepEqual(block(`one\n${marker('other')}\n${wording('new', 'one', 'other')}\n${m}`), ['one'], 'the stack is skipped first');
  assert.deepEqual(block(`one\n\`\`\`\n\n# not a heading\n\`\`\`\n${m}`), ['one', '```', '', '# not a heading', '```'], 'fenced lines are content');
  assert.deepEqual(block(`one\n\n${m}`), [], 'under a blank line');
  assert.deepEqual(findWording(['a', 'b  ', 'a', 'b'], { from: 0, to: 4 }, 'a\nb'), [0, 2]);
  assert.deepEqual(findWording(['a', 'b'], { from: 1, to: 2 }, 'a'), [], 'only inside the block');
});

test('list and check report a new wording that drifted, and a stack whose wordings do not chain; a confirmed marker is exempt from drift', () => {
  const rule = 'Five days.';
  const problems = (text) => wordingProblems(text).map(({ line, problem }) => [line, problem]);
  assert.deepEqual(problems(`${rule}\n${record({ wrote: rule }).join('\n')}\n`), []);
  const drifted = problems(`Six days.\n${record({ wrote: rule }).join('\n')}\n`);
  assert.equal(drifted.length, 1);
  assert.equal(drifted[0][0], 2);
  assert.match(drifted[0][1], /"refund-copy" wrote wording found 0 times in the block above it/u);
  assert.match(problems(`${rule}\n${rule}\n${record({ wrote: rule }).join('\n')}\n`)[0][1], /found 2 times/u);
  assert.deepEqual(problems(`Six days.\n${record({ wrote: rule, status: 'confirmed' }).join('\n')}\n`), [], 'confirmed: the Human may reword it');
  assert.deepEqual(problems(`Six days.\n${record({ wrote: 'Five', status: 'rejected' }).join('\n')}\n`), [], 'only an unconfirmed marker drifts');

  const first = record({ id: 'first', was: 'Orig.', wrote: 'Second.' });
  const chained = ['Third.', ...first, ...record({ id: 'second', was: 'Second.', wrote: 'Third.' })].join('\n');
  assert.deepEqual(problems(chained), []);
  const broken = problems(['Third.', ...first, ...record({ id: 'second', was: 'Other.', wrote: 'Third.' })].join('\n'));
  assert.equal(broken.length, 1);
  assert.match(broken[0][1], /"second" sits below "first", but its old wording is not the wording "first" wrote/u);
  const gapped = problems(['Third.', ...first, ...record({ id: 'second', wrote: 'Third.' })].join('\n'));
  assert.equal(gapped.length, 1, 'a later decision with no old wording breaks the chain');
  const confirmed = problems(['Six.', ...record({ id: 'first', was: 'Orig.', wrote: 'Second.', status: 'confirmed' }), ...record({ id: 'second', was: 'Other.', wrote: 'Third.', status: 'confirmed' })].join('\n'));
  assert.equal(confirmed.length, 1, 'confirmed markers still chain');
  const higher = problems(['Third.', ...record({ id: 'first', wrote: 'Gone.' }), ...record({ id: 'second', was: 'Gone.', wrote: 'Third.' })].join('\n'));
  assert.deepEqual(higher, [], 'only the bottom of a stack has to be in the doc');
  assert.deepEqual(problems(`${rule}\n${marker()}\n<!-- aidrian:decision-new id=refund-copy text=oops -->\n`), [], 'unreadable wording is a parse problem, not a drift');
});

// A project with the doc `docs/a.md`, indexed, and the doc's path.
function project(t, text) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-undo-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  writeFileSync(path.join(dir, '.aidrian/knowledge/10-docs.json'), JSON.stringify({ dir: 'docs', description: 'The rules.', docs: { 'a.md': { summary: 'a rules', tags: [] }, 'b.md': { summary: 'b rules', tags: [] } } }));
  writeFileSync(path.join(dir, 'docs/a.md'), text);
  writeFileSync(path.join(dir, 'docs/b.md'), '# Other\n');
  return { dir, file: path.join(dir, 'docs/a.md') };
}
const run = (args, cwd, env = process.env) => spawnSync(CLI, args, { cwd, encoding: 'utf8', env });

test('aidrian decisions undo writes the doc and prints what it replaced or removed', (t) => {
  const replaced = project(t, `# Doc\n\nFive days.\n${record({ was: 'Ten days.', wrote: 'Five days.' }).join('\n')}\n`);
  const out = run(['decisions', 'undo', 'refund-copy'], replaced.dir);
  assert.deepEqual([out.status, out.stderr], [0, '']);
  assert.equal(readFileSync(replaced.file, 'utf8'), '# Doc\n\nTen days.\n');
  assert.match(out.stdout, /^docs\/a\.md:3: undid refund-copy: replaced 1 line with 1\n- Five days\.\n\+ Ten days\.\n$/u);

  const removed = project(t, `Above.\n\nTabs.\n${record({ wrote: 'Tabs.' }).join('\n')}\n\nBelow.\n`);
  const gone = run(['decisions', 'undo', 'refund-copy', '--project', removed.dir], path.dirname(removed.dir));
  assert.deepEqual([gone.status, gone.stderr], [0, '']);
  assert.equal(readFileSync(removed.file, 'utf8'), 'Above.\n\nBelow.\n');
  assert.match(gone.stdout, /^docs\/a\.md:3: undid refund-copy: removed 1 line\n- Tabs\.\n$/u);
  assert.equal(JSON.parse(run(['decisions', 'list', '--json'], removed.dir).stdout).decisions.length, 0, 'its lines are gone');
});

test('a refused undo exits 1, writes nothing, and prints the reason, both wordings, and the block', (t) => {
  const text = `Changed by hand.\n${record({ was: 'Ten days.', wrote: 'Five days.' }).join('\n')}\n`;
  const { dir, file } = project(t, text);
  const { status, stdout, stderr } = run(['decisions', 'undo', 'refund-copy'], dir);
  assert.deepEqual([status, stdout], [1, '']);
  assert.match(stderr, /^cannot undo "refund-copy" at docs\/a\.md:2: its new wording is not found in the block above it/u);
  assert.match(stderr, /^old wording: "Ten days\."$/mu);
  assert.match(stderr, /^new wording: "Five days\."$/mu);
  assert.match(stderr, /^block above the marker:\n {2}Changed by hand\.$/mu);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('undo refuses an unknown id, a malformed marker, an id on two docs, and a doc that is not UTF-8, writing nothing', (t) => {
  const doc = `Five days.\n${record({ wrote: 'Five days.' }).join('\n')}\n`;
  const { dir, file } = project(t, doc);
  const unknown = run(['decisions', 'undo', 'no-such'], dir);
  assert.deepEqual([unknown.status, unknown.stdout], [1, '']);
  assert.match(unknown.stderr, /no decision marker with id "no-such"/u);

  writeFileSync(path.join(dir, 'docs/b.md'), `Five days.\n${marker('broken').replace('date=2026-11-01', 'date=soon')}\n${wording('old', 'Ten days.', 'broken')}\n${wording('new', 'Five days.', 'broken')}\n`);
  const malformed = run(['decisions', 'undo', 'broken'], dir);
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /cannot undo "broken" at docs\/b\.md:2: date "soon"/u);
  assert.match(malformed.stderr, /^wording lines from docs\/b\.md:2:\n {2}<!-- aidrian:decision-old id=broken text="Ten days\." -->\n {2}<!-- aidrian:decision-new id=broken text="Five days\." -->$/mu);
  assert.match(malformed.stderr, /^block above the marker:\n {2}Five days\.$/mu);
  assert.doesNotMatch(unknown.stderr, /wording|block/u, 'an unknown id has neither');

  writeFileSync(path.join(dir, 'docs/b.md'), `Five days.\n${marker('Bad_Id')}\n${wording('new', 'Five days.', 'orphan')}\n`);
  const orphan = run(['decisions', 'undo', 'orphan'], dir);
  assert.equal(orphan.status, 1);
  assert.match(orphan.stderr, /cannot undo "orphan" at docs\/b\.md:3: new wording with no decision marker directly above it/u);
  assert.match(orphan.stderr, /^wording lines from docs\/b\.md:3:\n {2}<!-- aidrian:decision-new id=orphan text="Five days\." -->$/mu, 'the named line itself');

  writeFileSync(path.join(dir, 'docs/b.md'), doc);
  const repeated = run(['decisions', 'undo', 'refund-copy'], dir);
  assert.equal(repeated.status, 1);
  assert.match(repeated.stderr, /id "refund-copy" is on 2 markers: docs\/a\.md:2, docs\/b\.md:2/u);
  assert.match(repeated.stderr, /^new wording: "Five days\."$/mu);
  assert.equal(readFileSync(file, 'utf8'), doc);

  const latin = Buffer.concat([Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from(`\nFive days.\n${record({ id: 'bytes', wrote: 'Five days.' }).join('\n')}\n`)]);
  writeFileSync(path.join(dir, 'docs/b.md'), latin);
  const bytes = run(['decisions', 'undo', 'bytes'], dir);
  assert.equal(bytes.status, 1);
  assert.match(bytes.stderr, /not valid UTF-8/u);
  assert.deepEqual(readFileSync(path.join(dir, 'docs/b.md')), latin);

  for (const args of [['decisions', 'undo'], ['decisions', 'undo', 'a', 'b']]) {
    const bad = run(args, dir);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /undo needs one id/u);
  }
});

test('undo restores wording with a character past ASCII, written raw or escaped', (t) => {
  const raw = ['Cinq jours, déjà.', marker(), `<!-- aidrian:decision-old id=refund-copy text="Dix jours, déjà." -->`, '<!-- aidrian:decision-new id=refund-copy text="Cinq jours, d\\u00e9j\\u00e0." -->', ''].join('\n');
  const { dir, file } = project(t, raw);
  assert.equal(run(['decisions', 'undo', 'refund-copy'], dir).status, 0);
  assert.equal(readFileSync(file, 'utf8'), 'Dix jours, déjà.\n');
});

test('undo refuses a tracked doc in a guarded main checkout, as set does, and passes in a task worktree', (t) => {
  const text = `Five days.\n${record({ was: 'Ten days.', wrote: 'Five days.' }).join('\n')}\n`;
  const { dir, file } = project(t, text);
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, git: { mainCheckout: { guard: true } } }));
  writeFileSync(path.join(dir, '.gitignore'), '.worktrees/\n');
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'docs');
  const { AIDRIAN_ALLOW_MAIN_WRITE: _, ...env } = process.env;

  const refused = run(['decisions', 'undo', 'refund-copy'], dir, env);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /aidrian worktree new <branch>/u);
  assert.equal(readFileSync(file, 'utf8'), text);

  const tree = path.join(dir, '.worktrees/task');
  git('worktree', 'add', '-q', '-b', 'task', tree);
  assert.equal(run(['decisions', 'undo', 'refund-copy'], tree, env).status, 0, 'a task worktree passes');
  assert.equal(readFileSync(path.join(tree, 'docs/a.md'), 'utf8'), 'Ten days.\n');
  assert.equal(readFileSync(file, 'utf8'), text);

  assert.equal(run(['decisions', 'undo', 'refund-copy'], dir, { ...env, AIDRIAN_ALLOW_MAIN_WRITE: '1' }).status, 0, 'the override');
});
