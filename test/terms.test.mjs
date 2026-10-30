import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { lintTerms } from '../plugins/aidrian/lib/lint.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { addedLines, loadTerms, numbered, scanLines, termPattern } from '../plugins/aidrian/lib/terms.mjs';

const CLI = path.resolve('plugins/aidrian/lib/cli.mjs');
const HOOK = path.resolve('plugins/aidrian/scripts/hook-write.mjs');

const TERMS = {
  version: 1,
  locales: 'locales/{locale}/*.json',
  rules: [
    {
      id: 'american-spelling',
      paths: ['docs/api/**', 'src/api/**'],
      message: 'Use American spelling in public API surfaces.',
      terms: { organisation: 'organization', organisations: 'organizations', organised: 'organized' },
    },
    { id: 'es-ES guest', locale: 'es-ES', exclude: ['locales/es-ES/landing.json'], terms: { comensal: 'cliente', 'usuári*': 'utilizador' } },
    { id: 'ja-JP feedback', locale: 'ja-JP', terms: { フィードバック: 'ご感想' } },
    { id: 'soft', paths: ['**/*.md'], severity: 'warn', terms: { 'e-mail': 'email' } },
  ],
};

function repo(t, terms = TERMS, config = { version: 1, terms: { file: '.aidrian/terms.json' } }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-terms-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (rel, text) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  write('.aidrian/config.json', JSON.stringify(config));
  if (terms) write('.aidrian/terms.json', JSON.stringify(terms));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  const project = projectAt(dir);
  return { dir, project, write, git, rules: () => loadTerms(project, loadConfig(project).config).rules };
}

test('a term matches as a whole word in any case; * takes more letters; unspaced scripts match anywhere', () => {
  assert.equal(termPattern('organisation').test('The Organisation runs it'), true);
  assert.equal(termPattern('organisation').test('reorganisation'), false);
  assert.equal(termPattern('comensal').test('comensales'), false);
  assert.equal(termPattern('usuári*').test('las usuárias'), true);
  assert.equal(termPattern('retroalimentación').test('la retroalimentación.'), true);
  assert.equal(termPattern('retroalimentación').test('retroalimentaciónes'), false, 'an accented letter is part of the word');
  assert.equal(termPattern('フィードバック').test('ご意見フィードバックを'), true);
});

test('rules apply by path and locale; a locale rule reads only JSON values', (t) => {
  const { rules } = repo(t);
  const scan = (rel, text) => scanLines(numbered(text), rel, rules()).map((hit) => `${hit.line}:${hit.term}:${hit.rule.id}`);
  assert.deepEqual(scan('docs/api/intro.md', 'One organisation.\nOrganised by teams.'), ['1:organisation:american-spelling', '2:organised:american-spelling']);
  assert.deepEqual(scan('docs/intro.txt', 'organisation'), [], 'outside the paths');
  assert.deepEqual(scan('locales/es-ES/app.json', '{\n  "comensal": "El comensal llega",\n  "x": "usuários"\n}'), ['2:comensal:es-ES guest', '3:usuári*:es-ES guest']);
  assert.deepEqual(scan('locales/es-ES/app.json', '{ "comensal": "cliente" }'), [], 'a key is not a translation');
  assert.deepEqual(scan('locales/es-ES/landing.json', '{ "a": "comensal" }'), [], 'excluded');
  assert.deepEqual(scan('locales/fr-FR/app.json', '{ "a": "comensal" }'), [], 'another locale');
  assert.deepEqual(scan('locales/ja-JP/app.json', '{ "a": "\\u30d5\\u30a3\\u30fc\\u30c9\\u30d0\\u30c3\\u30af" }'), ['1:フィードバック:ja-JP feedback'], 'escapes are decoded');
});

test('the file is validated: a bad rule is named and left out, the rest apply', (t) => {
  const { project, rules } = repo(t, {
    version: 1,
    rules: [{ id: 'ok', paths: ['**'], terms: { a: 'b' } }, { id: 'bad', locale: 'es-ES', severity: 'loud', terms: {} }, { id: 'ok', paths: ['x'], terms: { c: 'd' } }],
  });
  const { errors } = loadTerms(project, loadConfig(project).config);
  assert.deepEqual(errors, [
    '.aidrian/terms.json: rule "bad": needs "paths", or "locale" with the file\'s "locales"',
    '.aidrian/terms.json: rule "bad": "severity" must be "block" or "warn"',
    '.aidrian/terms.json: rule "bad": "terms" must map each banned term to its replacement, both non-empty strings',
    '.aidrian/terms.json: rule "ok": another rule has this id',
  ]);
  assert.deepEqual(rules().map((rule) => rule.id), ['ok']);
  const check = spawnSync(process.execPath, [CLI, 'check', '--project', project.root], { encoding: 'utf8' });
  assert.equal(check.status, 1);
  assert.match(check.stderr, /rule "bad": "severity" must be/);
});

test('off without terms.file; a missing file is an error', (t) => {
  const off = repo(t, null, { version: 1 });
  assert.equal(loadTerms(off.project, loadConfig(off.project).config), null);
  assert.equal(lintTerms(off.project, loadConfig(off.project).config).summary, 'off (config.json terms.file is null)');
  const missing = repo(t, null);
  assert.match(loadTerms(missing.project, loadConfig(missing.project).config).errors[0], /terms\.json: not found/);
});

test('aidrian lint terms fails on a block hit, warns on a warn hit, and --staged reads the index', (t) => {
  const { dir, write, git } = repo(t);
  write('docs/api/a.md', 'The organisation.\n');
  write('notes.md', 'Send an e-mail.\n');
  git('add', '.');
  const lint = (...args) => spawnSync(process.execPath, [CLI, 'lint', 'terms', '--project', dir, ...args], { encoding: 'utf8' });
  const all = lint();
  assert.equal(all.status, 1);
  assert.match(all.stderr, /terms: docs\/api\/a\.md:1: "organisation" -> use "organization" \[american-spelling\] Use American spelling/);
  assert.match(all.stderr, /terms: warning: notes\.md:1: "e-mail" -> use "email" \[soft\]/);
  write('docs/api/a.md', 'The organization.\n');
  assert.equal(lint('--staged').status, 1, 'the index still holds the banned term');
  git('add', '.');
  const clean = lint('--staged');
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /terms: no banned terms in 4 staged files \(4 rules\)/);
});

test('the write hook refuses a block hit on the lines a write adds, and tells the agent of a warn hit', (t) => {
  const { dir, write } = repo(t);
  write('docs/api/old.md', 'Legacy organisation text.\n');
  const hook = (toolName, toolInput) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: toolName, cwd: dir, tool_input: toolInput }), encoding: 'utf8' });
  const denied = hook('Write', { file_path: 'docs/api/new.md', content: 'Hello.\nThe organisation.\n' });
  assert.equal(denied.status, 2);
  assert.match(denied.stderr, /^Blocked: this write adds 1 banned term\(s\)/);
  assert.match(denied.stderr, /docs\/api\/new\.md:2: "organisation" -> use "organization"/);
  assert.equal(hook('Write', { file_path: path.join(dir, 'docs/api/old.md'), content: 'Legacy organisation text.\nNew line.\n' }).status, 0, 'a line the file already had');
  assert.equal(hook('Edit', { file_path: 'docs/api/old.md', old_string: 'Legacy organisation text.', new_string: 'Legacy organisation text.' }).status, 0);
  assert.equal(hook('Edit', { file_path: 'docs/api/old.md', old_string: 'Legacy', new_string: 'The organisations' }).status, 2);
  write('locales/es-ES/app.json', '{\n  "guest": "cliente"\n}\n');
  const inside = hook('Edit', { file_path: 'locales/es-ES/app.json', old_string: 'cliente', new_string: 'comensal' });
  assert.equal(inside.status, 2, 'an edit inside one JSON value is read as its whole line');
  assert.match(inside.stderr, /locales\/es-ES\/app\.json:2: "comensal" -> use "cliente"/);
  assert.equal(hook('Edit', { file_path: 'locales/es-ES/app.json', old_string: '"guest"', new_string: '"comensal"' }).status, 0, 'a key stays a key');
  const patch = '*** Begin Patch\n*** Update File: locales/es-ES/app.json\n@@\n-  "a": "x"\n+  "a": "comensal"\n*** End Patch';
  assert.equal(hook('apply_patch', { command: patch }).status, 2);
  const warned = hook('Write', { file_path: 'notes.md', content: 'Send an e-mail.\n' });
  assert.equal(warned.status, 0);
  assert.match(JSON.parse(warned.stdout).hookSpecificOutput.additionalContext, /notes\.md:1: "e-mail" -> use "email" \[soft\]/);
  assert.equal(hook('Write', { file_path: 'src/app.js', content: 'organisation' }).status, 0, 'outside every rule');
});

test('addedLines reads each write tool', (t) => {
  assert.deepEqual(addedLines({ tool_name: 'Edit', tool_input: { file_path: 'a', old_string: 'x\ny', new_string: 'x\nz' } }, '/nowhere'), [{ file: 'a', lines: [{ number: 2, text: 'z' }] }]);
  const { dir, write } = repo(t);
  write('f.txt', 'one\ntwo a\nthree a\n');
  const edit = (input) => addedLines({ tool_name: 'Edit', tool_input: { file_path: 'f.txt', ...input } }, dir)[0].lines;
  assert.deepEqual(edit({ old_string: 'a', new_string: 'b\nc', replace_all: true }), [{ number: 2, text: 'two b' }, { number: 3, text: 'c' }, { number: 4, text: 'three b' }, { number: 5, text: 'c' }]);
  assert.deepEqual(edit({ edits: [{ old_string: 'one', new_string: 'uno' }, { old_string: 'uno', new_string: 'one' }] }), [], 'edits apply in order, and the end result counts');
  assert.deepEqual(edit({ edits: [{ old_string: 'one', new_string: 'uno' }, { old_string: 'two', new_string: 'dos' }] }), [{ number: 1, text: 'uno' }, { number: 2, text: 'dos a' }]);
  const patch = '*** Begin Patch\n*** Add File: n.md\n+one\n*** Delete File: gone.md\n*** Update File: u.md\n+two\n*** End Patch';
  assert.deepEqual(addedLines({ tool_name: 'apply_patch', tool_input: { command: patch } }, '/').map(({ file, lines }) => [file, lines.map((l) => l.text)]), [['n.md', ['one']], ['u.md', ['two']]]);
});
