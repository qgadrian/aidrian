import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  alertText, bandSegments, changeRows, changesParts, COLORS, DISPLAY_CAPS, displayText, FORGES, handoffParts, harnessParts,
  isIssueLink, LISTED_TICKETS, MAX_TICKETS, NOTICES, noticeOf, plainText, SUMMARY_BUDGET, ticketRow, ticketRows, ticketsOf,
  ticketsSummary,
} from '../plugins/aidrian-claude-mod/lib/format.mjs';
import { SUMMARY_BUDGET as LINE_BUDGET } from '../plugins/aidrian/lib/session-prs.mjs';
import { DISPLAY_CAPS as SNAPSHOT_CAPS, displayText as snapshotText, snapshotLine } from '../plugins/aidrian/lib/session-snapshot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOD_LIB = path.join(ROOT, 'plugins/aidrian-claude-mod/lib');
// What a terminal must never receive: C0, DEL, and C1.
const CLEAN = /^[^\u0000-\u001f\u007f-\u009f]*$/u;
const HOSTILE = ['\u001b]52;c;aGk=\u0007', '\u001b[2J', '‮', '‏', '⁠', '\u{E0041}'];
const SECTIONS = ['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'tickets'];

const CHECKS = { passed: 3, failed: 0, pending: 0, skipped: 1 };
const pull = (number, fields = {}) => ({
  forge: 'github', host: 'github.com', repo: 'acme/notes', number, title: `Change ${number}`,
  url: `https://github.com/acme/notes/pull/${number}`, isDraft: false, state: 'open', mergeable: true,
  reviewDecision: null, unresolvedThreads: 0, checks: CHECKS, ...fields,
});
// The fixture rows: each value of state, mergeable, and reviewDecision the snapshot lists, and an unsupported row.
const FIXTURE_ROWS = [
  pull(1, { state: 'open', isDraft: true, mergeable: null, reviewDecision: 'review_required' }),
  pull(2, { state: 'merged', mergeable: true, reviewDecision: 'approved' }),
  pull(3, { state: 'closed', mergeable: false, reviewDecision: 'changes_requested', unresolvedThreads: 2 }),
  pull(4, { state: 'open', reviewDecision: null, checks: { passed: 1, failed: 1, pending: 1, skipped: 0 } }),
  { host: 'gitlab.com', repo: 'acme/notes', number: 9, title: null, url: null, isDraft: null, state: null, mergeable: null, reviewDecision: null, unresolvedThreads: null, checks: null, unsupported: true },
];
const handoff = (fields) => ({ ratio: 1.4, breakEven: null, level: 'quiet', nextRatio: 2, context: 1000, ceiling: null, chain: 0, maxChain: 3, continueArmed: false, lastBrief: null, ...fields });
const snap = (fields = {}) => ({ session: { id: 's', transcript: null, cwd: '/p' }, ...Object.fromEntries(SECTIONS.map((name) => [name, null])), errors: [], ...fields });
const textsOf = (parts) => parts.map((each) => each.text).join('');
const rowText = (row) => textsOf(row.parts);

test('displayText removes the same characters as the snapshot`s and cuts at the same lengths', () => {
  assert.deepEqual(DISPLAY_CAPS, SNAPSHOT_CAPS);
  const astral = '𝔸'.repeat(201);
  const inputs = [...HOSTILE, ' ', ' ', '​', '﻿', '\ud800', 'a\ud800b', `x${HOSTILE.join('y')}z`, '\u0085next', astral, 'plain'];
  for (const input of inputs) {
    for (const cap of Object.values(DISPLAY_CAPS)) assert.equal(displayText(input, cap), snapshotText(input, cap), JSON.stringify(input));
    assert.equal(displayText(input), snapshotText(input), JSON.stringify(input));
  }
  assert.equal([...displayText(astral, DISPLAY_CAPS.title)].length, 200);
  assert.equal(displayText(astral, DISPLAY_CAPS.title), '𝔸'.repeat(200));
});

test('the handoff segment at each level, in its color, with the line`s words', () => {
  const cases = [
    [{ level: 'quiet', ratio: 1.4 }, '1.4x', COLORS.quiet, 'subtle'],
    [{ level: 'offer', ratio: 1.8, breakEven: 23.6 }, '1.8x · handoff pays back in ~24 calls', COLORS.offer, 'warning'],
    [{ level: 'due', ratio: 2.3, breakEven: 24 }, '2.3x · handoff due, pays back in ~24 calls', COLORS.due, 'claude'],
    [{ level: 'reminded', ratio: 2.3, breakEven: 24 }, '2.3x · handoff due, pays back in ~24 calls', COLORS.reminded, 'claude'],
    [{ level: 'ceiling', ratio: 3 }, 'handoff now', COLORS.ceiling, 'error'],
  ];
  for (const [fields, words, color, key] of cases) {
    const parts = handoffParts(handoff(fields));
    assert.deepEqual(parts, [{ text: words, color }], fields.level);
    assert.equal(color, key);
    assert.equal(plainText(bandSegments(snap({ handoff: handoff(fields) }))), snapshotLine(snap({ handoff: handoff(fields) })), fields.level);
  }
  assert.deepEqual(handoffParts(handoff({ level: 'offer', ratio: 1.8 })), [{ text: '1.8x', color: COLORS.offer }], 'no break-even: no pays-back part');
});

test('an armed continuation adds its part to the level`s segment, in cyan, and replaces none', () => {
  for (const level of ['quiet', 'offer', 'due', 'reminded', 'ceiling']) {
    const armed = handoff({ level, ratio: 2.3, breakEven: 24, continueArmed: true, chain: 1, maxChain: 3 });
    const parts = handoffParts(armed);
    assert.deepEqual(parts.slice(0, 1), handoffParts({ ...armed, continueArmed: false }), level);
    assert.deepEqual(parts.at(-1), { text: 'armed 1/3', color: COLORS.armed });
    assert.equal(COLORS.armed, 'cyan');
    assert.equal(plainText(bandSegments(snap({ handoff: armed }))), snapshotLine(snap({ handoff: armed })), level);
  }
});

test('a chain above maxChain draws the chain alone, never a fraction above one', () => {
  const armed = (chain, maxChain) => handoffParts(handoff({ level: 'quiet', continueArmed: true, chain, maxChain })).at(-1);
  assert.deepEqual(armed(4, 3), { text: 'armed 4', color: COLORS.armed });
  assert.deepEqual(armed(3, 3), { text: 'armed 3/3', color: COLORS.armed });
  assert.deepEqual(armed(0, 3), { text: 'armed 0/3', color: COLORS.armed });
  for (const maxChain of [null, Number.NaN, Infinity, '3', -1, 1.5]) assert.equal(armed(2, maxChain).text, 'armed 2', String(maxChain));
  assert.doesNotMatch(textsOf(handoffParts(handoff({ continueArmed: true, chain: 4, maxChain: 3 }))), /\//u);
});

test('the handoff segment draws only finite numbers, and nothing for a level it does not know', () => {
  for (const fields of [{ ratio: 0 }, { ratio: Number.NaN }, { ratio: Infinity }, { ratio: '2.0' }, { level: 'later' }, { level: 'toString' }]) {
    assert.deepEqual(handoffParts(handoff(fields)), [], JSON.stringify(fields));
  }
  assert.equal(textsOf(handoffParts(handoff({ level: 'offer', ratio: 1.8, breakEven: Number.NaN }))), '1.8x');
  const badChain = handoffParts(handoff({ continueArmed: true, chain: '\u001b]52;x', maxChain: 3 }));
  assert.equal(textsOf(badChain), '1.4x', 'an armed continuation with no count for its chain draws no armed part');
});

test('the summary counts pull requests, not checks', () => {
  const rows = [
    pull(1, { checks: { passed: 1, failed: 1, pending: 1, skipped: 0 } }),
    pull(2, { checks: { passed: 0, failed: 0, pending: 2, skipped: 0 } }),
    pull(3, { checks: { passed: 2, failed: 0, pending: 0, skipped: 1 } }),
    pull(4, { checks: { passed: 0, failed: 0, pending: 0, skipped: 0 } }),
    pull(5, { checks: null }),
  ];
  assert.equal(textsOf(changesParts(rows)), 'PRs ✓1 ✗1 ⏳1 · #1, #2, #3, #4, #5');
  assert.equal(textsOf(changesParts([rows[0]])), 'PR ✓0 ✗1 ⏳0 · #1', 'a failed and a pending check: counted as failed');
  assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
  const colors = changesParts(rows).filter((each) => /[✓✗⏳]/u.test(each.text)).map((each) => each.color);
  assert.deepEqual(colors, [COLORS.passed, COLORS.failed, COLORS.pending]);
});

test('the summary lists the first five numbers, each in the color of its checks, and counts the rest', () => {
  const rows = [1, 2, 3, 4, 5, 6, 7].map((number) => pull(number));
  rows[1] = pull(2, { checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } });
  rows.push(pull(8, { number: null }));
  assert.equal(textsOf(changesParts(rows)), 'PRs ✓7 ✗1 ⏳0 · #1, #2, #3, #4, #5, +3', 'two past the five, and one with no number');
  assert.equal(changesParts(rows).find((each) => each.text === '#2').color, COLORS.failed);
  assert.equal(changesParts(rows).find((each) => each.text === '#1').color, COLORS.passed);
  assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
  assert.equal(textsOf(changesParts([pull(1, { number: null }), pull(2, { number: 0 })])), '2 PRs · ✓2 ✗0 ⏳0', 'no number to list');
});

test('the counts come before the numbers, so a narrow terminal cuts numbers and never a failure', () => {
  const rows = [1, 2, 3, 4, 5].map((number) => pull(number * 10_000_000)).concat(pull(6, { checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } }));
  assert.match(textsOf(changesParts(rows)).slice(0, 20), /✗1/u);
});

test('changes from more than one repository list each number with its repository`s letter, in host and path order', () => {
  const failed = { checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } };
  for (const [rows, words] of [
    [[pull(42, { repo: 'acme/api' }), pull(42, { repo: 'acme/web', ...failed })], 'PRs ✓1 ✗1 ⏳0 · a#42, b#42'],
    [[pull(42, { repo: 'upstream/widget' }), pull(42, { repo: 'fork/widget', ...failed })], 'PRs ✓1 ✗1 ⏳0 · b#42, a#42'],
    [[pull(42, { repo: 'acme/widget' }), pull(42, { host: 'git.example.com', repo: 'acme/widget', ...failed })], 'PRs ✓1 ✗1 ⏳0 · b#42, a#42'],
  ]) {
    const parts = changesParts(rows);
    assert.equal(textsOf(parts), words, rows[1].repo);
    const [first, second] = words.split(' · ')[1].split(', ');
    assert.notEqual(first, second, 'one name under two owners or two hosts: two labels');
    assert.equal(parts.find((each) => each.text === first).color, COLORS.passed, first);
    assert.equal(parts.find((each) => each.text === second).color, COLORS.failed, second);
    const reversed = [...rows].reverse();
    assert.equal(textsOf(changesParts(reversed)), `PRs ✓1 ✗1 ⏳0 · ${second}, ${first}`, 'a letter names a repository, not a place in the list');
    assert.deepEqual(changeRows(rows).map((row) => row.parts[0].text), [`PR ${first}`, `PR ${second}`]);
    for (const each of [rows, reversed]) assert.equal(plainText(bandSegments(snap({ prs: each }))), snapshotLine(snap({ prs: each })));
  }
  assert.equal(textsOf(changesParts([pull(1), pull(2, { repo: 'ACME/Notes' })])), 'PRs ✓2 ✗0 ⏳0 · #1, #2', 'one repository, in any case');
});

test('past z the letters go on as aa, ab, so every repository gets its own label', () => {
  const rows = Array.from({ length: 27 }, (_, index) => pull(index + 1, { repo: `acme/r${String(index).padStart(2, '0')}` }));
  const firsts = changeRows(rows).map((row) => row.parts[0].text);
  assert.deepEqual(firsts, [...'abcdefghijklmnopqrstuvwxyz'].map((letter, index) => `PR ${letter}#${index + 1}`).concat('PR aa#27'));
  assert.equal(new Set(firsts).size, 27);
  const newest = [...rows].reverse();
  assert.equal(textsOf(changesParts(newest)), 'PRs ✓27 ✗0 ⏳0 · aa#27, z#26, y#25, x#24, w#23, +22');
  assert.equal(plainText(bandSegments(snap({ prs: newest }))), snapshotLine(snap({ prs: newest })));
});

test('on a 64-column band, long repository names still show the counts and at least one whole number', () => {
  assert.equal(SUMMARY_BUDGET, 58);
  assert.equal(SUMMARY_BUDGET, LINE_BUDGET, 'the band and the line keep one budget');
  const failed = { checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } };
  const long = (end) => `acme/${'x'.repeat(95)}${end}`;
  const pair = [pull(4012, { repo: long(1) }), pull(4012, { repo: long(2), ...failed })];
  assert.equal(textsOf(changesParts(pair)), 'PRs ✓1 ✗1 ⏳0 · a#4012, b#4012');
  assert.ok(changesParts(pair).every((each) => !each.text.includes('xx')), 'no repository text on the band');
  const top = Number.MAX_SAFE_INTEGER;
  const many = Array.from({ length: 25 }, (_, index) => pull(top - index, { repo: `acme/r${String(index).padStart(2, '0')}` }));
  const dirty = HOSTILE.join('');
  const unsupported = (number) => ({ ...FIXTURE_ROWS[4], number });
  const sets = [
    [many, true],
    [[...many.slice(0, 24), { ...many[24], forge: 'gitlab' }], false],
    [Array.from({ length: 6 }, (_, index) => pull(10_000_001 + index)), true],
    [pair.map((row) => ({ ...row, host: `github.com${dirty}`, repo: `${row.repo}${dirty}` })), true],
    [[unsupported(12345), unsupported(12346), unsupported(12347), pull(12348), pull(12349)], false],
  ];
  // The labels a summary lists, without its `+N`.
  const labelsOf = (summary) => summary.split(' · ')[1].split(', ').filter((each) => !each.startsWith('+'));
  for (const [rows, github] of sets) {
    const parts = changesParts(rows);
    const text = textsOf(parts);
    const length = [...text].length;
    assert.ok(length <= SUMMARY_BUDGET, text);
    assert.ok(length + (text.match(/⏳/gu) ?? []).length <= 64 - 3, `${text}: the band's changes row is 61 columns`);
    assert.match(text, /^(?:PRs|changes) ✓\d+ ✗\d+ ⏳\d+ · [a-z]*#\d+(?:, [a-z]*#\d+)*(?:, \+\d+)?$/u);
    const label = changeRows(rows)[0].parts[0].text.split(' ')[1];
    assert.equal(text.split(' · ')[1].split(', ')[0], label, 'the first label is whole');
    for (const each of parts) assert.match(each.text, CLEAN);
    const band = plainText(bandSegments(snap({ prs: rows })));
    const line = snapshotLine(snap({ prs: rows }));
    if (github) assert.equal(band, line, text);
    else {
      // `changes` is longer than the line's `PRs`, so the band may list fewer numbers, never others.
      const [shown, listed] = [labelsOf(band), labelsOf(line)];
      assert.ok(shown.length <= listed.length, `${band}: no more labels than ${line}`);
      assert.deepEqual(shown, listed.slice(0, shown.length), `${band}: its labels lead ${line}`);
    }
  }
  assert.match(textsOf(changesParts(many)), /^PRs ✓25 ✗0 ⏳0 · a#9007199254740991, \+24$/u);
  assert.match(textsOf(changesParts(sets[1][0])), /^changes /u);
  const near = sets[4][0];
  assert.equal(plainText(bandSegments(snap({ prs: near }))), 'changes ✓2 ✗0 ⏳0 · b#12345, b#12346, b#12347, a#12348, +1');
  assert.equal(snapshotLine(snap({ prs: near })), 'PRs ✓2 ✗0 ⏳0 · b#12345, b#12346, b#12347, a#12348, a#12349', 'near the budget the band lists one number fewer');
});

test('the budget lists fewer numbers and a larger +N rather than cut one', () => {
  const six = [1, 2, 3, 4, 5, 6].map((n) => pull(123_450 + n));
  const alternating = [1, 2, 3, 4, 5, 6].map((n) => pull(12_340 + n, { repo: n % 2 ? 'a/b' : 'c/d' }));
  for (const [rows, words] of [
    [six, 'PRs ✓6 ✗0 ⏳0 · #123451, #123452, #123453, #123454, +2'],
    [six.slice(0, 5), 'PRs ✓5 ✗0 ⏳0 · #123451, #123452, #123453, #123454, #123455'],
    [alternating, 'PRs ✓6 ✗0 ⏳0 · a#12341, b#12342, a#12343, b#12344, +2'],
  ]) {
    assert.equal(textsOf(changesParts(rows)), words);
    assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })), words);
  }
  assert.equal([...textsOf(changesParts(six.slice(0, 5)))].length, SUMMARY_BUDGET, 'a summary of exactly the budget lists all five');
});

test('a row with no number takes no letter and makes no numbers span repositories', () => {
  const rows = [pull(3), pull(8, { number: null, repo: 'acme/other' })];
  assert.equal(textsOf(changesParts(rows)), 'PRs ✓2 ✗0 ⏳0 · #3, +1');
  assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
  const texts = changeRows(rows).map(rowText);
  assert.match(texts[0], /^PR #3github\.com\/acme\/notes/u);
  assert.match(texts[1], /^PRgithub\.com\/acme\/other/u);
});

test('the words of a change come from the forge table', () => {
  assert.deepEqual(Object.keys(FORGES), ['github']);
  assert.equal(textsOf(changesParts([pull(1)])), 'PR ✓1 ✗0 ⏳0 · #1');
  assert.equal(textsOf(changesParts([pull(1), pull(2), pull(3)])), 'PRs ✓3 ✗0 ⏳0 · #1, #2, #3');
  const elsewhere = pull(7, { forge: 'gitlab' });
  assert.match(textsOf(changesParts([elsewhere])), /^change ✓1 ✗0 ⏳0 · #7$/u);
  assert.match(textsOf(changesParts([pull(1), elsewhere])), /^changes ✓2 ✗0 ⏳0 · #1, #7$/u, 'rows of two forges');
  assert.match(textsOf(changesParts([pull(1), FIXTURE_ROWS[4]])), /^changes ✓1 ✗0 ⏳0 · a#1, b#9$/u, 'a forge row and an unsupported one, on two hosts');
  const [row] = changeRows([elsewhere]);
  assert.match(rowText(row), /^change #7/u);
  assert.equal(row.link, null, 'a forge with no entry gets no link, though its url is a github.com pull request');
  assert.equal(changeRows([pull(1, { forge: 'constructor' })])[0].link, null);
});

test('a pull request link only for its own repository and number on github.com', () => {
  assert.equal(changeRows([pull(12)])[0].link, 'https://github.com/acme/notes/pull/12');
  assert.equal(changeRows([pull(12, { url: 'https://github.com/Acme/Notes/pull/12' })])[0].link, 'https://github.com/Acme/Notes/pull/12');
  const refused = [
    'https://github.com/acme/notes/pull/13', 'https://github.com/acme/other/pull/12', 'http://github.com/acme/notes/pull/12',
    'https://github.com.example.org/acme/notes/pull/12', 'https://github.com/acme/notes/pull/12/files', 'https://github.com/acme/notes/pull/12?x=1',
    'javascript:alert(1)', 'file:///etc/passwd', 'https://github.com/acme/notes/pull/12\u001b]52;x', null, 42,
  ];
  for (const url of refused) assert.equal(changeRows([pull(12, { url })])[0].link, null, String(url));
  assert.equal(changeRows([pull(12, { host: 'github.example.org' })])[0].link, null, 'another host');
  assert.equal(changeRows([pull(1, { repo: 'acme/..', url: 'https://github.com/acme/../pull/1' })])[0].link, null);
});

test('the pane reads each value the snapshot lists for a row, and an unsupported row with no forge', () => {
  const texts = changeRows(FIXTURE_ROWS).map(rowText);
  assert.match(texts[0], /^PR a#1github\.com\/acme\/notesChange 1draftreview required✓3✗0⏳0$/u);
  assert.match(texts[1], /^PR a#2.*mergedapproved/u);
  assert.match(texts[2], /^PR a#3.*closedconflictschanges requested💬 2/u);
  assert.match(texts[3], /^PR a#4.*open✓1✗1⏳1$/u);
  assert.equal(texts[4], 'change b#9gitlab.com/acme/notesunsupported');
  assert.equal(changeRows(FIXTURE_ROWS)[4].link, null);
  const states = new Set(FIXTURE_ROWS.map((row) => row.state));
  for (const value of ['open', 'closed', 'merged']) assert.ok(states.has(value), value);
  for (const value of [true, false, null]) assert.ok(FIXTURE_ROWS.some((row) => row.mergeable === value), String(value));
  for (const value of ['approved', 'changes_requested', 'review_required', null]) assert.ok(FIXTURE_ROWS.some((row) => row.reviewDecision === value), String(value));
  assert.ok(FIXTURE_ROWS.some((row) => row.unsupported && !Object.hasOwn(row, 'forge')));
  assert.match(rowText(changeRows([pull(5, { stale: true })])[0]), /stale$/u);
  assert.doesNotMatch(rowText(changeRows([pull(5, { state: 'reopened', reviewDecision: 'maybe', mergeable: 'no' })])[0]), /reopened|maybe|conflicts/u);
});

test('a number that is not a safe integer draws nothing', () => {
  const [row] = changeRows([pull('\u001b]52;x', { url: null, title: 'T' })]);
  assert.match(rowText(row), /^PRgithub\.com/u);
  assert.doesNotMatch(rowText(row), /52|#/u);
  const counts = changeRows([pull(1, { unresolvedThreads: 1.5, checks: { passed: Number.NaN, failed: -1, pending: '2', skipped: 0 } })])[0];
  assert.doesNotMatch(rowText(counts), /💬|✓|✗|⏳/u);
  const harness = harnessParts({ lessons: { open: 3, byTier: { P1: '2' } }, decisions: { provisional: Infinity }, worktrees: { mergedNotCleaned: 2 ** 60 }, audits: { untriaged: -1 } });
  assert.deepEqual(harness, []);
});

test('the harness row shows each count above zero, and no row when all are zero', () => {
  const full = snap({ lessons: { open: 4, byTier: { P1: 1, P2: 3, P3: 0 } }, decisions: { provisional: 2 }, worktrees: { owned: 3, mergedNotCleaned: 1 }, audits: { untriaged: 3 } });
  assert.equal(textsOf(harnessParts(full)), '📥 1 P1 · ⚖️ 2 decisions · 🧹 1 worktree · 🔎 3 findings');
  assert.equal(plainText(bandSegments(full)), snapshotLine(full));
  const zero = snap({ lessons: { open: 0, byTier: { P1: 0, P2: 0, P3: 0 } }, decisions: { provisional: 0 }, worktrees: { owned: 0, mergedNotCleaned: 0 }, audits: { untriaged: 0 } });
  assert.deepEqual(bandSegments(zero), []);
  assert.equal(snapshotLine(zero), '');
});

test('null sections, and absent ones, draw no segment and no zero', () => {
  assert.deepEqual(bandSegments(snap()), []);
  assert.deepEqual(bandSegments({ session: { id: null, transcript: null, cwd: '/p' }, errors: [] }), []);
  for (const name of SECTIONS) {
    const without = snap();
    delete without[name];
    assert.deepEqual(bandSegments(without), [], name);
    const rest = snap({ handoff: handoff({}), prs: [pull(1)], lessons: { open: 1, byTier: { P1: 1, P2: 0, P3: 0 } }, decisions: { provisional: 1 } });
    delete rest[name];
    assert.doesNotMatch(plainText(bandSegments(rest)), /(?:📥|⚖️|🧹|🔎) 0\b/u, name);
  }
  for (const value of [null, undefined, 'x', [], 42]) assert.deepEqual(bandSegments(value), [], String(value));
  assert.deepEqual(changeRows(null), []);
  assert.deepEqual(changeRows([null, 'x', 3]), []);
  assert.equal(ticketRow(null), null);
});

test('no hidden character reaches the band or the pane', () => {
  const dirty = HOSTILE.join('');
  const row = pull(5, { title: `Fix${dirty} it`, repo: `acme/notes${dirty}`, host: `github.com${dirty}`, url: `https://github.com/acme/notes/pull/5${dirty}` });
  const shown = [...bandSegments(snap({ prs: [row], handoff: handoff({}) })).flatMap((segment) => segment.parts), ...changeRows([row])[0].parts];
  const ticket = ticketRow({ key: `ABC-1${dirty}`, source: 'branch' }, { title: `Issue${dirty} title`, status: `In${dirty} Progress`, url: `https://linear.app/acme/issue/ABC-1${dirty}` });
  for (const each of [...shown, ...ticket.parts]) {
    assert.match(each.text, CLEAN, JSON.stringify(each.text));
    for (const hidden of ['‮', '‏', '⁠', '\u{E0041}']) assert.ok(!each.text.includes(hidden), JSON.stringify(each.text));
    assert.equal(typeof each.color, 'string');
    assert.ok(!each.color.includes('\u001b'));
  }
  assert.match(textsOf(changeRows([row])[0].parts), /Fix\]52;c;aGk=\[2J it/u);
  assert.equal(changeRows([row])[0].link, null);
  assert.equal(ticket.link, null);
  assert.match(textsOf(ticket.parts), /^ABC-1\]52;c;aGk=\[2JIssue\]52;c;aGk=\[2J title/u);
  const key = `ABC-1${dirty}`;
  const rows = ticketRows([{ key, source: 'pr' }, { key: `#4${dirty}`, source: 'branch' }], [{ key, title: `Issue${dirty}`, status: `In${dirty}`, url: `https://linear.app/acme/issue/ABC-1${dirty}` }]);
  assert.equal(rows.length, 2);
  for (const each of rows.flatMap((row) => row.parts)) {
    assert.match(each.text, CLEAN, JSON.stringify(each.text));
    for (const hidden of ['‮', '‏', '⁠', '\u{E0041}']) assert.ok(!each.text.includes(hidden), JSON.stringify(each.text));
  }
  assert.deepEqual(rows.map((row) => row.link), [null, null]);
});

test('ticketsOf reads the list, else an older plugin`s one ticket, 10 at most', () => {
  assert.equal(MAX_TICKETS, 10);
  const twelve = Array.from({ length: 12 }, (_, index) => ({ key: `ABC-${index + 1}`, source: 'pr' }));
  assert.deepEqual(ticketsOf(snap({ tickets: twelve })), twelve.slice(0, 10));
  assert.deepEqual(ticketsOf(snap({ tickets: [null, 'ABC-1', 7, [], { key: 'ABC-2', source: 'pr' }] })), [{ key: 'ABC-2', source: 'pr' }], 'entries that are no object are dropped');
  const legacy = { key: 'ABC-1', source: 'branch' };
  assert.deepEqual(ticketsOf({ ticket: legacy }), [legacy], 'an older aidrian plugin prints one ticket');
  assert.deepEqual(ticketsOf({ tickets: [], ticket: legacy }), [], 'the list wins, even empty');
  for (const value of [null, 'tickets', 42, [], {}, { ticket: null }, { ticket: 'ABC-1' }]) assert.deepEqual(ticketsOf(value), [], JSON.stringify(value));
});

test('ticketRows gives one row a ticket, each with the issue of its own key alone', () => {
  const issue = { key: 'ABC-15', title: 'Close the gaps', status: 'Todo', url: 'https://linear.app/acme/issue/ABC-15' };
  const rows = ticketRows([{ key: 'ABC-12', source: 'pr' }, { key: 'ABC-15', source: 'pr' }], [issue, { key: 'XY-1', title: 'Elsewhere', status: 'Done', url: 'https://linear.app/acme/issue/XY-1' }]);
  assert.deepEqual(rows.map(rowText), ['ABC-12', 'ABC-15Close the gapsTodo']);
  assert.deepEqual(rows.map((row) => row.link), [null, issue.url]);
  assert.ok(!rows.some((row) => rowText(row).includes('Elsewhere')), 'an issue of another key shows nowhere');
  assert.deepEqual(ticketRows([{ key: 'ABC-12' }, { key: 'ABC-12' }, { key: 'abc-12' }]).map(rowText), ['ABC-12'], 'a repeated key gives one row');
  assert.deepEqual(ticketRows([{ key: '#42', source: 'branch' }, { source: 'pr' }, null, { key: '' }]).map(rowText), ['#42'], 'a ticket with no key gives no row');
  assert.deepEqual(ticketRows(null), []);
  assert.deepEqual(ticketRows([{ key: 'ABC-12' }], 'issues').map(rowText), ['ABC-12']);
});

test('ticketsSummary lists three rows and counts the rest', () => {
  assert.equal(LISTED_TICKETS, 3);
  const rowsOf = (count) => ticketRows(Array.from({ length: count }, (_, index) => ({ key: `ABC-${index + 1}` })));
  for (const [count, listed, more] of [[0, 0, 0], [1, 1, 0], [3, 3, 0], [5, 3, 2]]) {
    const summary = ticketsSummary(rowsOf(count));
    assert.deepEqual(summary.listed.map(rowText), rowsOf(count).slice(0, listed).map(rowText), String(count));
    assert.equal(summary.more, more, String(count));
  }
});

test('the ticket row links only to the Linear page of the key looked up', () => {
  const ticket = { key: 'ABC-12', source: 'branch' };
  assert.equal(ticketRow(ticket, { title: 'T', url: 'https://linear.app/acme/issue/ABC-12' }).link, 'https://linear.app/acme/issue/ABC-12');
  assert.equal(ticketRow(ticket, { title: 'T', url: 'https://linear.app/acme/issue/ABC-12/fix-the-thing' }).link, 'https://linear.app/acme/issue/ABC-12/fix-the-thing');
  const refused = [
    'javascript:alert(1)', 'file:///etc/passwd', 'https://linear.app.example.org/acme/issue/ABC-12', 'https://linear.app/acme/issue/ABC-13',
    'http://linear.app/acme/issue/ABC-12', 'https://linear.app/acme/issue/ABC-12?x=1', 'https://evil.example/https://linear.app/acme/issue/ABC-12', 42,
  ];
  for (const url of refused) assert.equal(ticketRow(ticket, { title: 'T', url }).link, null, String(url));
  assert.equal(ticketRow({ key: '#42', source: 'branch' }, { url: 'https://linear.app/acme/issue/ABC-12' }).link, null);
  assert.equal(rowText(ticketRow({ key: '#42', source: 'branch' })), '#42');
  assert.equal(isIssueLink('https://linear.app/acme/issue/abc-12', 'ABC-12'), true);
});

test('alertText removes escape sequences and bidi controls from an answer line and a folder name', () => {
  const alert = alertText({ text: 'Done\u001b]52;c;aGk=\u0007 \u001b[2Jnow‮', title: 'proj\u001b]52;x\u0007‮ect' });
  assert.equal(alert.text, 'Done]52;c;aGk= [2Jnow');
  assert.equal(alert.title, 'proj]52;xect');
  for (const value of Object.values(alert)) assert.match(value, CLEAN);
  assert.equal([...alertText({ text: 'x'.repeat(500) }).text].length, DISPLAY_CAPS.title);
  assert.deepEqual(alertText({ text: 42, title: null }), { text: '', title: '' });
});

test('an alert`s title is cut at a name`s length, by code point', () => {
  assert.equal(alertText({ title: 'n'.repeat(150) }).title, 'n'.repeat(DISPLAY_CAPS.name));
  assert.equal(alertText({ title: '𝔸'.repeat(150) }).title, '𝔸'.repeat(DISPLAY_CAPS.name));
});

test('a Linear link`s slug holds only letters, digits, and dashes', () => {
  const base = 'https://linear.app/acme/issue/ABC-12';
  assert.equal(isIssueLink(`${base}/Fix-the-THING-2`, 'ABC-12'), true);
  for (const slug of ['/a b', '/a.b', '/a_b', '/%2e%2e', '/@evil.example', '/a/b', '/a?b', '/a#b', '/', '/а', `/${'a'.repeat(201)}`]) {
    assert.equal(isIssueLink(`${base}${slug}`, 'ABC-12'), false, slug);
  }
});

test('the pane`s notice for each result that holds no snapshot', () => {
  // The product words, each in full. A plugin that is installed is never called not installed: node not found, and an
  // entry that failed the safety checks, say so.
  assert.deepEqual(Object.keys(NOTICES).sort(), ['failed', 'missing', 'no-node', 'off', 'refused', 'timed-out']);
  const words = {
    missing: 'The aidrian plugin is not installed for this folder: install it to see the handoff verdict, the changes this session touched, and the harness signals.',
    'no-node': "The aidrian plugin is installed, but no node was found in a PATH folder outside this session's folder, the only place the mod runs programs from: install Node, or start Claude Code with Node's folder on PATH.",
    refused: "The aidrian plugin installed for this folder failed the mod's safety checks (its files are missing, a link, or outside Claude Code's plugin cache), so the mod does not run it: reinstall it.",
    failed: 'The aidrian plugin returned no snapshot: update it to the latest release.',
    'timed-out': 'The aidrian snapshot took longer than 10 seconds and was stopped: the band shows the model, limits, and cache until the next try, at the next turn or within a minute.',
    off: "The aidrian plugin is off for this folder: turn it on in Claude Code's plugin settings to see the handoff verdict, the changes this session touched, and the harness signals.",
  };
  for (const [kind, text] of Object.entries(words)) assert.equal(noticeOf({ kind }), text, kind);
  for (const kind of ['no-node', 'refused']) assert.doesNotMatch(noticeOf({ kind }), /not installed/u, kind);
  for (const result of [{ kind: 'ok', snapshot: {} }, { kind: 'toString' }, null]) assert.equal(noticeOf(result), null);
});

test('no file of the Claude mod`s lib imports a Node built-in or uses process', () => {
  const files = readdirSync(MOD_LIB).filter((name) => name.endsWith('.mjs'));
  assert.deepEqual(files.sort(), ['format.mjs', 'pane-data.mjs', 'servers.mjs', 'snapshot-client.mjs']);
  for (const name of files) {
    const text = readFileSync(path.join(MOD_LIB, name), 'utf8');
    const code = text.split('\n').filter((line) => !/^\s*\/\//u.test(line)).join('\n');
    const specifiers = [...code.matchAll(/\b(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/gu)].map((match) => match[1]);
    assert.deepEqual(specifiers.filter((specifier) => !specifier.startsWith('./')), [], name);
    assert.doesNotMatch(code, /\bnode:|\brequire\s*\(|\bprocess\s*[.[]|\bglobalThis\b|\bBuffer\b/u, name);
  }
});
