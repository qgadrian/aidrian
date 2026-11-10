import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { fencedLines, headings, sectionItems, unfencedLines } from '../plugins/aidrian/lib/markdown-sections.mjs';

const FENCE = '```';

// A fence opened after a list marker closes on its indented bare fence; the old detector read that closer as a new
// opener and swallowed every later heading.
const LIST_FENCE = [
  '## Testing',
  '',
  `- ${FENCE}bash`,
  '  npm test',
  `  ${FENCE}`,
  '',
  '## Risks',
  '',
  '- none',
].join('\n');

test('fencedLines: a fence opened after a list marker closes on its indented fence', () => {
  assert.deepEqual(fencedLines(LIST_FENCE), [false, false, true, true, true, false, false, false, false]);
});

test('headings: a heading after a list-item fence is still a heading', () => {
  assert.deepEqual(headings(LIST_FENCE), ['Testing', 'Risks']);
  assert.deepEqual(sectionItems(LIST_FENCE, 'Risks'), [{ text: '- none', first: 'none' }]);
});

test('fencedLines: CRLF line endings read the same as LF', () => {
  const crlf = LIST_FENCE.replace(/\n/gu, '\r\n');
  assert.deepEqual(fencedLines(crlf), fencedLines(LIST_FENCE));
  assert.deepEqual(headings(crlf), ['Testing', 'Risks']);
});

test('fencedLines: a tilde fence closes only on tildes', () => {
  const body = ['~~~', `${FENCE}`, '## not a heading', '~~~', '## Real'].join('\n');
  assert.deepEqual(fencedLines(body), [true, true, true, true, false]);
  assert.deepEqual(headings(body), ['Real']);
});

test('fencedLines: an unclosed fence runs to the end without throwing', () => {
  const body = ['## Top', `${FENCE}js`, 'code', '## swallowed'].join('\n');
  assert.deepEqual(fencedLines(body), [false, true, true, true]);
  assert.deepEqual([...unfencedLines(body)], ['## Top']);
});

test('fencedLines: a fence at the inner item of a nested marker line ("- - item") is still a fence', () => {
  const body = ['- - nested item', '', `      ${FENCE}js`, '    example', `    ${FENCE}`, '', '## Risks', '- none'].join('\n');
  assert.deepEqual(fencedLines(body), [false, false, true, true, true, false, false, false]);
  assert.deepEqual(headings(body), ['Risks']);
});

test('fencedLines: a marker-only list line, then a fence four spaces in that closes two spaces in', () => {
  const body = ['## Testing', '-', `    ${FENCE}bash`, '  npm test', `  ${FENCE}`, '', '## Risks'].join('\n');
  assert.deepEqual(headings(body), ['Testing', 'Risks']);
});

test('fencedLines: a fence counts at any indentation, as the old detector did', () => {
  assert.deepEqual(fencedLines([`    ${FENCE}`, '## code', `    ${FENCE}`, '## Real'].join('\n')), [true, true, true, false]);
});

test('fencedLines: tabs after a list marker and in the body expand to 4-column stops', () => {
  const body = ['## Testing', `-\t${FENCE}bash`, '\tnpm test', `\t${FENCE}`, '', '## Risks'].join('\n');
  assert.deepEqual(fencedLines(body), [false, true, true, true, false, false]);
  assert.deepEqual(headings(body), ['Testing', 'Risks']);
});

test('fencedLines: a line that opens with inline code is not a fence', () => {
  assert.deepEqual(fencedLines(`${FENCE}code${FENCE} stays literal\n## Next`), [false, false]);
});
