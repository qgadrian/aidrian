import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  alertText, bandSegments, changeRows, changesParts, COLORS, DISPLAY_CAPS, displayText, FORGES, handoffParts, harnessParts,
  isIssueLink, NOTICES, noticeOf, plainText, ticketRow,
} from '../plugins/aidrian-claude-mod/lib/format.mjs';
import { DISPLAY_CAPS as SNAPSHOT_CAPS, displayText as snapshotText, snapshotLine } from '../plugins/aidrian/lib/session-snapshot.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MOD_LIB = path.join(ROOT, 'plugins/aidrian-claude-mod/lib');
// What a terminal must never receive: C0, DEL, and C1.
const CLEAN = /^[^\u0000-\u001f\u007f-\u009f]*$/u;
const HOSTILE = ['\u001b]52;c;aGk=\u0007', '\u001b[2J', '‮', '‏', '⁠', '\u{E0041}'];
const SECTIONS = ['handoff', 'prs', 'lessons', 'worktrees', 'decisions', 'audits', 'ticket'];

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

test('the same number in two repositories carries each repository name', () => {
  const rows = [pull(42, { repo: 'acme/api' }), pull(42, { repo: 'acme/web', checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } })];
  assert.equal(textsOf(changesParts(rows)), 'PRs ✓1 ✗1 ⏳0 · api#42, web#42');
  assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
  assert.equal(textsOf(changesParts([pull(1), pull(2)])), 'PRs ✓2 ✗0 ⏳0 · #1, #2', 'one repository: bare numbers');
});

test('a label names the owner, then the host, only when the repository name alone would collide', () => {
  const failed = { checks: { passed: 0, failed: 1, pending: 0, skipped: 0 } };
  const owners = [pull(42, { repo: 'upstream/widget' }), pull(42, { repo: 'fork/widget', ...failed })];
  assert.equal(textsOf(changesParts(owners)), 'PRs ✓1 ✗1 ⏳0 · upstream/widget#42, fork/widget#42');
  const hosts = [pull(42, { repo: 'acme/widget' }), pull(42, { host: 'git.example.com', repo: 'acme/widget', ...failed })];
  assert.equal(textsOf(changesParts(hosts)), 'PRs ✓1 ✗1 ⏳0 · github.com/acme/wid…#42, git.example.com/acm…#42');
  for (const rows of [owners, hosts]) assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
});

test('a long repository name is cut so the number after it always shows', () => {
  const rows = [pull(42, { repo: `acme/${'a'.repeat(60)}` }), pull(43, { repo: 'acme/web' })];
  assert.equal(textsOf(changesParts(rows)), `PRs ✓2 ✗0 ⏳0 · ${'a'.repeat(19)}…#42, web#43`);
  assert.equal(plainText(bandSegments(snap({ prs: rows }))), snapshotLine(snap({ prs: rows })));
});

test('the words of a change come from the forge table', () => {
  assert.deepEqual(Object.keys(FORGES), ['github']);
  assert.equal(textsOf(changesParts([pull(1)])), 'PR ✓1 ✗0 ⏳0 · #1');
  assert.equal(textsOf(changesParts([pull(1), pull(2), pull(3)])), 'PRs ✓3 ✗0 ⏳0 · #1, #2, #3');
  const elsewhere = pull(7, { forge: 'gitlab' });
  assert.match(textsOf(changesParts([elsewhere])), /^change ✓1 ✗0 ⏳0 · #7$/u);
  assert.match(textsOf(changesParts([pull(1), elsewhere])), /^changes ✓2 ✗0 ⏳0 · #1, #7$/u, 'rows of two forges');
  assert.match(textsOf(changesParts([pull(1), FIXTURE_ROWS[4]])), /^changes ✓1 ✗0 ⏳0 · github\.com\/acme\/not…#1, gitlab\.com\/acme\/not…#9$/u, 'a forge row and an unsupported one, on two hosts');
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
  assert.match(texts[0], /^PR #1github\.com\/acme\/notesChange 1draftreview required✓3✗0⏳0$/u);
  assert.match(texts[1], /^PR #2.*mergedapproved/u);
  assert.match(texts[2], /^PR #3.*closedconflictschanges requested💬 2/u);
  assert.match(texts[3], /^PR #4.*open✓1✗1⏳1$/u);
  assert.equal(texts[4], 'change #9gitlab.com/acme/notesunsupported');
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
