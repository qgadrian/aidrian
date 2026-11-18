// The Display only rule of the session links (docs/handoff.md#the-snapshot): no hook, gate, skill, or agent decides
// anything from a floor's parent, the lineage, or the snapshot's prs and ticket, and none of these values reaches a
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
const sources = (folders) => Object.fromEntries(folders.flatMap((folder) => walk(path.join(PLUGIN, folder)))
  .filter((file) => file.endsWith('.mjs')).map((file) => [path.relative(PLUGIN, file), code(readFileSync(file, 'utf8'))]));

// What each file may use of the session links: the modules it imports, and the readers it names.
const USES = {
  'session links module': (text) => /from\s+['"][^'"]*session-links\.mjs['"]|import\(\s*['"][^'"]*session-links\.mjs['"]/u.test(text),
  'session rows module': (text) => /from\s+['"][^'"]*session-rows\.mjs['"]|import\(\s*['"][^'"]*session-rows\.mjs['"]/u.test(text),
  readHop: (text) => /\breadHop\b/u.test(text),
  storeNames: (text) => /\bstoreNames\b/u.test(text),
  lineage: (text) => /\blineage\s*\(/u.test(text),
  parent: (text) => /\bparent:\s*(?:session|marker\.session)\b/u.test(text),
};
const ALLOWED = {
  'lib/session-snapshot.mjs': ['session links module'],
  'lib/session-prs.mjs': ['session rows module'],
  'lib/session-links.mjs': ['session rows module', 'readHop', 'storeNames', 'lineage'],
  'lib/session-rows.mjs': [],
  'lib/handoff-markers.mjs': ['readHop', 'storeNames'],
  'lib/handoff-continue.mjs': ['parent'],
};

// Each use a file of `files` makes that ALLOWED does not give it: `<file>: <use>`.
function breaches(files) {
  return Object.entries(files).flatMap(([file, text]) => Object.entries(USES).filter(([name, uses]) => uses(text) && !(ALLOWED[file] ?? []).includes(name)).map(([name]) => `${file}: ${name}`));
}

// The hooks that print: no file under scripts/ loads the snapshot or the session links, by a static or a dynamic import.
const printers = (files) => Object.entries(files).filter(([file, text]) => file.startsWith(`scripts${path.sep}`) && /session-(?:snapshot|links)\.mjs/u.test(text)).map(([file]) => file);

// A gate or a guard reads every floor itself: no call of readFrom or startedInBackground passes a listing in these files.
const GATES = ['lib/handoff-continue.mjs', 'lib/handoff-guard.mjs'];
const listed = (files) => Object.entries(files).filter(([file, text]) => (GATES.includes(file) || file.startsWith(`scripts${path.sep}`))
  && /\b(?:readFrom|startedInBackground|floorsOf)\([^)]*\bnames\b/u.test(text)).map(([file]) => file);

// The plugin's text that a model reads: no skill or agent runs the snapshot or names a session file.
const TEXT_FOLDERS = ['skills', 'agents', 'codex', 'agents-src', 'providers', 'agent-addons'];
const WORDS = /session snapshot|prs\.jsonl|links\.jsonl/iu;
const named = (files) => Object.entries(files).filter(([, text]) => WORDS.test(text)).map(([file]) => file);

test('only the listed files read the session links, each for what it may use', () => {
  assert.deepEqual(breaches(sources(['lib', 'scripts'])), []);
  assert.deepEqual(breaches({ 'lib/review-gate.mjs': "import { lineage } from './session-links.mjs';\nlineage(store, id);" }), ['lib/review-gate.mjs: session links module', 'lib/review-gate.mjs: lineage']);
  assert.deepEqual(breaches({ 'lib/handoff-guard.mjs': 'const hop = readHop(store, id);' }), ['lib/handoff-guard.mjs: readHop']);
  assert.deepEqual(breaches({ 'lib/handoff-continue.mjs': "import { readRows } from './session-rows.mjs';" }), ['lib/handoff-continue.mjs: session rows module']);
});

test('no hook loads the snapshot or the session links, so none prints a value of them', () => {
  assert.deepEqual(printers(sources(['scripts'])), []);
  assert.deepEqual(printers({ [path.join('scripts', 'hook-stop.mjs')]: "const { snapshot } = await import('../lib/session-snapshot.mjs');" }), [path.join('scripts', 'hook-stop.mjs')]);
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
