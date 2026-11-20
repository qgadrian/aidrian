// The Display only rule of the session links (docs/handoff.md#the-snapshot): no hook, gate, skill, or agent decides
// anything from a floor's parent, the lineage, or the snapshot's prs and tickets, and none of these values reaches a
// model's context. The scan reads the source with comments removed, as test/host-coupling.test.mjs does; each rule has
// a sample breach that fails it.

import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const PLUGIN = path.resolve(import.meta.dirname, '../plugins/aidrian');

const walk = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(full) : [full];
}) : []);
// The code of a file with its comments removed: whole comment lines, and a trailing ` // ...`.
const code = (text) => text.split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/u.test(line)).map((line) => line.replace(/\s\/\/ .*$/u, '')).join('\n');
// A file's key: its path from the plugin folder, `/` between parts on every system, as ALLOWED and GATES spell it.
const keyOf = (relative, sep = path.sep) => relative.split(sep).join('/');
const sources = (folders) => Object.fromEntries(folders.flatMap((folder) => walk(path.join(PLUGIN, folder)))
  .filter((file) => file.endsWith('.mjs')).map((file) => [keyOf(path.relative(PLUGIN, file)), code(readFileSync(file, 'utf8'))]));

// What each file may use of the session links: the modules it imports, and the readers it names.
const USES = {
  'session links module': (text) => /from\s+['"][^'"]*session-links\.mjs['"]|import\(\s*['"][^'"]*session-links\.mjs['"]/u.test(text),
  'session rows module': (text) => /from\s+['"][^'"]*session-rows\.mjs['"]|import\(\s*['"][^'"]*session-rows\.mjs['"]/u.test(text),
  'links writer module': (text) => /from\s+['"][^'"]*session-links-writer\.mjs['"]|import\(\s*['"][^'"]*session-links-writer\.mjs['"]/u.test(text),
  readHop: (text) => /\breadHop\b/u.test(text),
  storeNames: (text) => /\bstoreNames\b/u.test(text),
  lineage: (text) => /\blineage\s*\(/u.test(text),
  parent: (text) => /\bparent:\s*(?:session|marker\.session)\b/u.test(text),
};
const ALLOWED = {
  'lib/session-snapshot.mjs': ['session links module'],
  'lib/session-prs.mjs': ['session rows module'],
  'lib/session-links.mjs': ['session rows module', 'links writer module', 'readHop', 'storeNames', 'lineage'],
  'lib/session-links-writer.mjs': ['session rows module'],
  'lib/session-rows.mjs': [],
  'lib/handoff-markers.mjs': ['readHop', 'storeNames'],
  'lib/handoff-continue.mjs': ['parent'],
  // The writer of links.jsonl: the writer's module alone, which reads no session file.
  'scripts/hook-bash-post.mjs': ['links writer module'],
};

// Each use a file of `files` makes that ALLOWED does not give it: `<file>: <use>`.
function breaches(files) {
  return Object.entries(files).flatMap(([file, text]) => Object.entries(USES).filter(([name, uses]) => uses(text) && !(ALLOWED[file] ?? []).includes(name)).map(([name]) => `${file}: ${name}`));
}

// The hooks that print: no file under scripts/ loads the snapshot or the session links' reader, by a static or a
// dynamic import. The writer's module, which the ledger's hook loads, reads no session file.
const WRITER_HOOK = 'scripts/hook-bash-post.mjs';
const printers = (files) => Object.entries(files).filter(([file, text]) => file.startsWith('scripts/') && /session-(?:snapshot|links)\.mjs/u.test(text)).map(([file]) => file);

// A gate or a guard reads every floor itself: no call of readFrom or startedInBackground passes a listing in these files.
const GATES = ['lib/handoff-continue.mjs', 'lib/handoff-guard.mjs'];
const listed = (files) => Object.entries(files).filter(([file, text]) => (GATES.includes(file) || file.startsWith('scripts/'))
  && /\b(?:readFrom|startedInBackground|floorsOf)\([^)]*\bnames\b/u.test(text)).map(([file]) => file);

// The plugin's text that a model reads: no skill or agent runs the snapshot or names a session file.
const TEXT_FOLDERS = ['skills', 'agents', 'codex', 'agents-src', 'providers', 'agent-addons'];
const WORDS = /session snapshot|prs\.jsonl|links\.jsonl/iu;
const named = (files) => Object.entries(files).filter(([, text]) => WORDS.test(text)).map(([file]) => file);

test('a file is keyed with `/` between its parts on every system, so a Windows path meets ALLOWED and GATES', () => {
  const key = keyOf(path.win32.relative('C:\\plugin', 'C:\\plugin\\scripts\\hook-bash-post.mjs'), path.win32.sep);
  assert.equal(key, WRITER_HOOK);
  assert.deepEqual(breaches({ [key]: "const links = await import('../lib/session-links-writer.mjs');" }), [], 'an import its entry allows');
  assert.deepEqual(listed({ [keyOf('lib\\handoff-guard.mjs', '\\')]: 'readFrom(store, session, { names })' }), ['lib/handoff-guard.mjs'], 'a gate file by its key');
  assert.deepEqual(Object.keys(sources(['scripts'])).filter((file) => file.includes('\\')), []);
});

test('only the listed files read the session links, each for what it may use', () => {
  assert.deepEqual(breaches(sources(['lib', 'scripts'])), []);
  assert.deepEqual(breaches({ 'lib/review-gate.mjs': "import { lineage } from './session-links.mjs';\nlineage(store, id);" }), ['lib/review-gate.mjs: session links module', 'lib/review-gate.mjs: lineage']);
  assert.deepEqual(breaches({ 'lib/handoff-guard.mjs': 'const hop = readHop(store, id);' }), ['lib/handoff-guard.mjs: readHop']);
  assert.deepEqual(breaches({ 'lib/handoff-continue.mjs': "import { readRows } from './session-rows.mjs';" }), ['lib/handoff-continue.mjs: session rows module']);
});

test('no hook loads the snapshot or the session links, so none prints a value of them', () => {
  assert.deepEqual(printers(sources(['scripts'])), []);
  assert.deepEqual(printers({ 'scripts/hook-stop.mjs': "const { snapshot } = await import('../lib/session-snapshot.mjs');" }), ['scripts/hook-stop.mjs']);
  assert.deepEqual(printers({ 'scripts/hook-stop.mjs': "const links = await import('../lib/session-links.mjs');" }), ['scripts/hook-stop.mjs']);
  assert.deepEqual(printers({ [WRITER_HOOK]: "const links = await import('../lib/session-links-writer.mjs');\nlinks.recordLinks(folder, rows);" }), [], 'the writer');
  assert.deepEqual(printers({ [WRITER_HOOK]: "const links = await import('../lib/session-links.mjs');" }), [WRITER_HOOK], 'the reader in the writer`s hook');
  assert.deepEqual(breaches({ [WRITER_HOOK]: "import { readRows } from '../lib/session-rows.mjs';" }), [`${WRITER_HOOK}: session rows module`]);
});

// No filesystem call on a row's value: the session links reach the disk only through the session folder's helpers.
const fsImports = (text) => /from\s+['"](?:node:)?fs(?:\/promises)?['"]|import\(\s*['"](?:node:)?fs/u.test(text);

test('session-links.mjs and its writer import nothing from node:fs', () => {
  const lib = sources(['lib']);
  for (const file of ['lib/session-links.mjs', 'lib/session-links-writer.mjs']) assert.equal(fsImports(lib[file]), false, file);
  assert.equal(fsImports("import { lstatSync } from 'node:fs';"), true);
});

test('a gate, a guard, and a hook count chain floors from their own listing, never one passed in', () => {
  assert.deepEqual(listed(sources(['lib', 'scripts'])), []);
  assert.deepEqual(listed({ 'lib/handoff-guard.mjs': 'readFrom(store, session, { names })' }), ['lib/handoff-guard.mjs']);
});

test('no skill or agent of the plugin runs the snapshot or names a session file', () => {
  const files = Object.fromEntries(TEXT_FOLDERS.flatMap((folder) => walk(path.join(PLUGIN, folder))).map((file) => [path.relative(PLUGIN, file), readFileSync(file, 'utf8')]));
  assert.ok(Object.keys(files).length > 10);
  assert.deepEqual(named(files), []);
  assert.deepEqual(named({ 'skills/x/SKILL.md': 'Run `aidrian session snapshot` and read its prs.' }), ['skills/x/SKILL.md']);
});
