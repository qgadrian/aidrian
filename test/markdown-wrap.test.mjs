// The wrap check must report a long line, and, just as much, stay silent on correct text: a hook that fires on a good
// write gets ignored.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { affectedLines, findWrapViolations } from '../plugins/aidrian/lib/markdown-wrap.mjs';

const HOOK = path.resolve(import.meta.dirname, '../plugins/aidrian/scripts/hook-markdown-wrap.mjs');
const LIMIT = 155;
const long = (n) => 'word '.repeat(Math.ceil(n / 5) + 1).slice(0, n);
const lines = (text) => findWrapViolations(text, LIMIT).map((hit) => hit.line);

test('a line over the limit is reported with its length; one at the limit passes', () => {
  assert.deepEqual(findWrapViolations(long(LIMIT + 20), LIMIT), [{ line: 1, length: LIMIT + 20 }]);
  assert.deepEqual(findWrapViolations(long(LIMIT), LIMIT), []);
  assert.deepEqual(findWrapViolations(long(LIMIT + 20), LIMIT + 20), [], 'the limit comes from the caller');
});

test('fences close only on their own delimiter, never on an info-string line', () => {
  assert.deepEqual(lines(['```ts', long(200), '```', long(200)].join('\n')), [4]);
  assert.deepEqual(lines(['````md', '```ts', long(200), '```', '````', long(200)].join('\n')), [6], 'an inner ``` inside ````');
  assert.deepEqual(lines(['```', 'const a = 1;', '```js', long(200), '```', long(200)].join('\n')), [6], 'a ```js line is content');
  assert.deepEqual(lines(['```', long(200), '``` \t', long(200)].join('\n')), [4], 'a closer may carry trailing blanks');
  assert.deepEqual(lines(['~~~md', '```', long(200), '```', '~~~', long(200)].join('\n')), [6], 'a backtick fence does not close ~~~');
});

test('frontmatter, tables, indented code, and an unbreakable token are skipped', () => {
  assert.deepEqual(lines(['---', `description: ${long(400)}`, '---', 'Body.'].join('\n')), []);
  assert.deepEqual(lines(['Intro.', '---', long(200)].join('\n')), [3], 'a --- rule mid-document is not frontmatter');
  assert.deepEqual(lines(['---', '', long(200)].join('\n')), [3], 'a leading --- rule with no closer is not frontmatter');
  assert.deepEqual(lines(['---', `title: ${long(200)}`, '...', long(200)].join('\n')), [4], 'frontmatter may close on ...');
  assert.deepEqual(lines([`| ${long(200)} |`, `    ${long(200)}`, `\t${long(200)}`].join('\n')), []);
  assert.deepEqual(lines(`See the note at https://example.test/${'a'.repeat(160)} before you continue with the rest.`), []);
  assert.deepEqual(lines(`${'a'.repeat(150)} and then some more words here to wrap on`), [1]);
});

test('affectedLines spans the introduced text, every occurrence for replace_all, or null when it is gone', () => {
  assert.deepEqual([...affectedLines('one\ntwo\nthree\nfour', 'two\nthree')], [2, 3]);
  assert.deepEqual([...affectedLines('dup\nother\ndup', 'dup', true)], [1, 3]);
  assert.deepEqual([...affectedLines('dup\nother\ndup', 'dup')], [], 'one edit, two places it could be: name no line');
  assert.equal(affectedLines('one\ntwo', 'nowhere'), null);
});

// A project with a docs/ folder; `config` replaces its config.json.
function project(t, config = { version: 1 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-wrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify(config));
  return dir;
}

function hook(input) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [HOOK], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' });
  return { status, stdout, stderr };
}

const write = (file, content) => ({ tool_name: 'Write', tool_input: { file_path: file, content } });
const edit = (file, newString) => ({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'x', new_string: newString } });

test('the hook exits 2 naming the file, the lines, and the limit, after a write', (t) => {
  const file = path.join(project(t), 'docs/a.md');
  writeFileSync(file, `${long(200)}\nshort\n${long(170)}\n`);
  const { status, stdout, stderr } = hook(write(file, 'any'));
  assert.deepEqual([status, stdout], [2, '']);
  assert.match(stderr, /^The write to \S+a\.md succeeded; do not repeat it\. 2 line\(s\) you wrote exceed 155 characters:\n/);
  assert.match(stderr, /a\.md:1: 200 characters\n.*a\.md:3: 170 characters\n/s);
});

test('after an edit, the hook names only the touched lines, and reads fences from the whole file', (t) => {
  const dir = project(t);
  const file = path.join(dir, 'docs/a.md');
  writeFileSync(file, `${'term '.repeat(60).trim()}\nshort line\n${long(200)}\n`);
  assert.deepEqual(hook(edit(file, 'short line')), { status: 0, stdout: '', stderr: '' }, 'a long line nobody touched');
  assert.equal(hook(edit(file, long(200))).status, 2);
  assert.match(hook(edit(file, long(200))).stderr, /a\.md:3: 200 characters/);

  const fenced = path.join(dir, 'docs/b.md');
  const snippet = `const x = '${'a'.repeat(200)}';`;
  writeFileSync(fenced, ['```ts', snippet, '```', ''].join('\n'));
  assert.equal(hook(edit(fenced, snippet)).status, 0, 'an edit inside a fence is code');
  assert.equal(hook(edit(fenced, long(300))).status, 0, 'an edit whose text is no longer in the file');
});

test('the limit comes from config.json, and 0 or no project folder turns the hook off', (t) => {
  const wide = path.join(project(t, { version: 1, docs: { wrapLimit: 250 } }), 'docs/a.md');
  writeFileSync(wide, `${long(200)}\n`);
  assert.equal(hook(write(wide, 'x')).status, 0);
  const off = path.join(project(t, { version: 1, docs: { wrapLimit: 0 } }), 'docs/a.md');
  writeFileSync(off, `${long(200)}\n`);
  assert.equal(hook(write(off, 'x')).status, 0);
  const outside = path.join(mkdtempSync(path.join(tmpdir(), 'aidrian-wrap-none-')), 'a.md');
  t.after(() => rmSync(path.dirname(outside), { recursive: true, force: true }));
  writeFileSync(outside, `${long(200)}\n`);
  assert.equal(hook(write(outside, 'x')).status, 0);
});

test('other files, other tools, a missing file, and unreadable stdin exit 0 silently', (t) => {
  const dir = project(t);
  writeFileSync(path.join(dir, 'docs/a.ts'), `${long(300)}\n`);
  writeFileSync(path.join(dir, 'docs/a.md'), `${long(300)}\n`);
  for (const input of [
    write(path.join(dir, 'docs/a.ts'), long(300)),
    { tool_name: 'NotebookEdit', tool_input: { file_path: path.join(dir, 'docs/a.md'), content: long(300) } },
    write(path.join(dir, 'docs/missing.md'), long(300)),
    'not json',
    '',
    '[]',
  ]) {
    assert.deepEqual(hook(input), { status: 0, stdout: '', stderr: '' }, JSON.stringify(input));
  }
});
