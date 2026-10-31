import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { lintTerms } from '../plugins/aidrian/lib/lint.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { codeName, identifiers } from '../plugins/aidrian/lib/code-words.mjs';
import { proseLines } from '../plugins/aidrian/lib/markdown-prose.mjs';
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
    '.aidrian/terms.json: rule "bad": "locale" needs the file\'s "locales"',
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
  const parent = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'apply_patch', cwd: path.dirname(dir), tool_input: { command: `*** Begin Patch\n*** Add File: ${path.basename(dir)}/docs/api/a.md\n+The organisation.\n*** End Patch` } }),
    encoding: 'utf8',
  });
  assert.equal(parent.status, 2, 'a patch from a parent folder uses the project of each file');
});

test('addedLines reads each write tool', (t) => {
  assert.deepEqual(addedLines({ tool_name: 'Edit', tool_input: { file_path: 'a', old_string: 'x\ny', new_string: 'x\nz' } }, '/nowhere'), [{ file: 'a', lines: [{ number: 2, text: 'z' }], text: null, before: null, reliable: false }]);
  const { dir, write } = repo(t);
  write('f.txt', 'one\ntwo a\nthree a\n');
  const edit = (input) => addedLines({ tool_name: 'Edit', tool_input: { file_path: 'f.txt', ...input } }, dir)[0].lines;
  assert.deepEqual(edit({ old_string: 'a', new_string: 'b\nc', replace_all: true }), [{ number: 2, text: 'two b' }, { number: 3, text: 'c' }, { number: 4, text: 'three b' }, { number: 5, text: 'c' }]);
  assert.deepEqual(edit({ edits: [{ old_string: 'one', new_string: 'uno' }, { old_string: 'uno', new_string: 'one' }] }), [], 'edits apply in order, and the end result counts');
  assert.deepEqual(edit({ edits: [{ old_string: 'one', new_string: 'uno' }, { old_string: 'two', new_string: 'dos' }] }), [{ number: 1, text: 'uno' }, { number: 2, text: 'dos a' }]);
  const patch = '*** Begin Patch\n*** Add File: n.md\n+one\n*** Delete File: gone.md\n*** Update File: u.md\n*** Move to: moved.md\n@@\n+two\n*** End Patch';
  assert.deepEqual(addedLines({ tool_name: 'apply_patch', tool_input: { command: patch } }, '/').map(({ file, lines }) => [file, lines.map((l) => l.text)]), [['n.md', ['one']], ['moved.md', ['two']]]);
});

const errorsOf = (t, rules, extra = {}) => {
  const { project } = repo(t, { version: 1, ...extra, rules });
  return loadTerms(project, loadConfig(project).config).errors.map((error) => error.replace(/^\.aidrian\/terms\.json: /u, ''));
};

test('aidrian check validates prose, code, and optional paths', (t) => {
  assert.deepEqual(errorsOf(t, [{ id: 'everywhere', terms: { guest: 'client' } }]), [], 'a rule with no paths is valid');
  assert.deepEqual(errorsOf(t, [
    { id: 'a', prose: 'yes', code: 1, terms: { x: 'y' } },
    { id: 'b', prose: true, code: true, paths: ['**'], terms: { x: 'y' } },
    { id: 'c', prose: true, locale: 'es', terms: { x: 'y' } },
    { id: 'd', code: true, terms: { x: 'y' } },
    { id: 'e', code: true, paths: ['src/**'], terms: { 'part*': 'y', 'party size': 'n', partySize: 'n' } },
    { id: 'f', paths: [], terms: { x: 'y' } },
  ], { locales: 'locales/{locale}/*.json' }), [
    'rule "a": "prose" must be true or false',
    'rule "a": "code" must be true or false',
    'rule "b": "prose" and "code" cannot both be true',
    'rule "c": "prose" does not go with "locale"',
    'rule "d": a "code" rule needs "paths": code names and prose words differ',
    'rule "e": "part*": a "code" term has no "*"',
    'rule "e": "party size" and "partySize" name the same identifier',
    'rule "f": "paths" must be a list of globs',
  ]);
});

test('a rule with no paths reads every file but the terms file; a locale glob takes *', (t) => {
  const { rules } = repo(t, {
    version: 1,
    locales: 'locales/{locale}/*.json',
    rules: [
      { id: 'clients', exclude: ['vendor/**'], terms: { guest: 'client' } },
      { id: 'es', locale: 'es*', terms: { comensal: 'cliente' } },
    ],
  });
  const scan = (rel, text, options) => scanLines(numbered(text), rel, rules(), options).map((hit) => `${hit.line}:${hit.rule.id}`);
  assert.deepEqual(scan('src/a.ts', 'const guest = 1;'), ['1:clients']);
  assert.deepEqual(scan('package.json', '{ "guest": 1 }'), ['1:clients'], 'JSON keys are read');
  assert.deepEqual(scan('vendor/x.md', 'guest'), [], 'excluded');
  assert.deepEqual(scan('.aidrian/terms.json', '"guest": "client"'), [], 'the terms file names its terms');
  assert.deepEqual(scan('plans/p.md', 'guest', { ignored: true }), [], 'git ignores it');
  assert.deepEqual(scan('locales/es/a.json', '{ "a": "comensal" }'), ['1:es']);
  assert.deepEqual(scan('locales/es-ES/a.json', '{ "a": "comensal" }'), ['1:es']);
  assert.deepEqual(scan('locales/fr/a.json', '{ "a": "comensal" }'), []);
});

test('prose reads a Markdown file in its own voice', () => {
  const text = [
    'You read this.',
    '```js',
    'you();',
    '```',
    '~~~~',
    '```',
    'still you',
    '~~~~',
    '> you said',
    'Run `you` or ``a `you` b`` at https://x.io/you now.',
    'He said "you are" and “you too”.',
    'An open quote: "you wrap',
    'onto here" and you.',
    'you <!-- lint-skip -->',
    'show-your-work and you-know-who',
  ].join('\n');
  assert.deepEqual(proseLines(text).map((line, i) => (line !== null && termPattern('you', { compound: true }).test(line) ? i + 1 : null)).filter(Boolean), [1, 13]);
});

test('a prose rule reads what a write adds to the prose, and only warns without the whole file', (t) => {
  const { dir, write } = repo(t, { version: 1, rules: [{ id: 'second-person', paths: ['docs/**/*.md'], prose: true, terms: { you: 'the agent' } }] });
  write('docs/a.md', 'Intro.\n```\nexample\n```\nyou <!-- lint-skip -->\nEnd.\n');
  const hook = (toolName, toolInput) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: toolName, cwd: dir, tool_input: toolInput }), encoding: 'utf8' });
  assert.equal(hook('Edit', { file_path: 'docs/a.md', old_string: 'example', new_string: 'you run it' }).status, 0, 'inside a fence');
  assert.equal(hook('Edit', { file_path: 'docs/a.md', old_string: 'End.', new_string: 'Then you run it.' }).status, 2, 'in prose');
  assert.equal(hook('Edit', { file_path: 'docs/a.md', old_string: 'you <!-- lint-skip -->', new_string: 'you' }).status, 2, 'moved out of a lint-skip line');
  assert.equal(hook('Write', { file_path: 'docs/a.md', content: 'End.\nIntro.\n```\nexample\n```\nyou <!-- lint-skip -->\n' }).status, 0, 'a reorder');
  assert.equal(hook('Write', { file_path: 'docs/new.md', content: '```\nyou\n```\n' }).status, 0, 'a new file with a fence');
  const fallback = hook('Edit', { file_path: 'docs/a.md', old_string: 'not there', new_string: 'you' });
  assert.equal(fallback.status, 0, 'an Edit whose old text is gone only warns');
  assert.match(JSON.parse(fallback.stdout).hookSpecificOutput.additionalContext, /"you" -> use "the agent"/);
  const patch = hook('apply_patch', { command: '*** Begin Patch\n*** Update File: docs/a.md\n@@\n+you\n*** End Patch' });
  assert.equal(patch.status, 0, 'a patch only warns');
  assert.match(JSON.parse(patch.stdout).hookSpecificOutput.additionalContext, /\[second-person\]/);
});

test('a code rule matches whole identifiers in any case style, on agent writes only', (t) => {
  for (const name of ['partySize', 'PartySize', 'party_size', 'PARTY_SIZE', 'party-size', 'party size']) assert.equal(codeName(name), 'party size', name);
  assert.equal(codeName('HTMLParser'), 'html parser');
  assert.deepEqual(identifiers("const a = 'party' + \"party\" + `party ${party}`; // party"), ['const', 'a']);
  assert.deepEqual(identifiers('x = /* party */ party_size'), ['x', 'party_size']);
  const { dir, write, git, rules } = repo(t, {
    version: 1,
    rules: [{ id: 'guest-count', paths: ['src/**'], exclude: ['src/legacy/**'], code: true, severity: 'warn', terms: { party: 'numberOfGuests', 'party size': 'numberOfGuests' } }],
  });
  const scan = (rel, text) => scanLines(numbered(text), rel, rules()).map((hit) => `${hit.line}:${hit.term}`);
  assert.deepEqual(scan('src/a.ts', 'const partySize = booking.party;\nconst minimumPartySize = thirdParty;\nconst PARTY_SIZE = 1;'), ['1:party size', '1:party', '3:party size']);
  assert.deepEqual(scan('src/legacy/a.ts', 'const party = 1;'), []);
  const hook = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: 'src/b.ts', content: 'const party_size = 2;\n' } }), encoding: 'utf8' });
  assert.equal(hook.status, 0);
  assert.match(JSON.parse(hook.stdout).hookSpecificOutput.additionalContext, /src\/b\.ts:1: "party size" -> use "numberOfGuests" \[guest-count\]/);
  write('src/c.ts', 'const party = 1;\n');
  git('add', '.');
  const lint = spawnSync(process.execPath, [CLI, 'lint', 'terms', '--project', dir], { encoding: 'utf8' });
  assert.equal(lint.status, 0, 'lint leaves code names to the project linter');
  assert.doesNotMatch(lint.stderr, /party/);
});

test('aidrian lint terms --rule runs one rule, and names a rule that is not there', (t) => {
  const { dir, write, git } = repo(t);
  write('docs/api/a.md', 'The organisation.\n');
  write('notes.md', 'Send an e-mail.\n');
  git('add', '.');
  const lint = (...args) => spawnSync(process.execPath, [CLI, 'lint', 'terms', '--project', dir, ...args], { encoding: 'utf8' });
  const soft = lint('--rule', 'soft');
  assert.equal(soft.status, 0, 'the block rule is not run');
  assert.match(soft.stderr, /warning: notes\.md:1: "e-mail"/);
  assert.match(soft.stdout, /\(1 rules\)/);
  assert.match(lint('--rule', 'nope').stderr, /no rule "nope"/);
});

test('no rule reads a lockfile, a minified bundle, or binary content, on writes as in lint', (t) => {
  const { dir } = repo(t, { version: 1, rules: [{ id: 'clients', terms: { guest: 'client' } }] });
  const hook = (file, content) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: file, content } }), encoding: 'utf8' }).status;
  assert.equal(hook('package-lock.json', '{"guest":"guest"}'), 0);
  assert.equal(hook('dist/bundle.min.js', 'guest'), 0);
  assert.equal(hook('data.bin', 'a\0guest\0'), 0);
  assert.equal(hook('notes.md', 'guest'), 2);
});

test('a code rule keeps comments and template literals masked across lines when it sees the whole file', (t) => {
  const { dir } = repo(t, { version: 1, rules: [{ id: 'names', paths: ['src/**'], code: true, terms: { party: 'guests' } }] });
  const hook = (content) => spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: 'Write', cwd: dir, tool_input: { file_path: 'src/a.ts', content } }), encoding: 'utf8' }).status;
  assert.equal(hook('/*\nparty\n*/\n'), 0, 'a block comment');
  assert.equal(hook('const s = `\nparty\n`;\n'), 0, 'a template literal');
  assert.equal(hook("const a = 'it\\'s';\nconst party = 1;\n"), 2, 'an escaped quote ends nothing');
  assert.equal(hook('// party\nconst party = 1;\n'), 2, 'a line comment ends at its line');
  assert.equal(hook("const s = 'a \\\nparty';\n"), 0, 'a string continued over a line break');
  assert.equal(hook("const s = 'a \\\r\nparty';\r\n"), 0, 'over a CRLF line break');
});

test('a prose rule masks a quotation that wraps over lines, straight or curly, until the paragraph ends', () => {
  const hits = (text) => proseLines(text).map((line, i) => (line !== null && termPattern('you', { compound: true }).test(line) ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(hits('The quote is: "first line\nyou must wait\nlast line". Then you go.'), [3]);
  assert.deepEqual(hits('A “curly\nyou quote” and you.'), [2]);
  assert.deepEqual(hits('An unclosed "quote\n\nyou are back in prose.'), [3], 'a blank line ends the paragraph');
});

test('a quoted URL keeps its closing quote, and code names keep letters of any script', () => {
  const hits = (text) => proseLines(text).map((line, i) => (line !== null && termPattern('you', { compound: true }).test(line) ? i + 1 : null)).filter(Boolean);
  assert.deepEqual(hits('See "https://example.com" and you should continue.\nYou must wait.'), [1, 2]);
  assert.deepEqual(hits('See “https://example.com” and you go.'), [1]);
  assert.deepEqual(hits('``a ```b`` and you `x`'), [1], 'a longer backtick run inside a span');
  assert.deepEqual(hits('See `https://example.com` and you can `run` it.'), [1], 'a URL in a code span');
  assert.deepEqual(hits('Run `first line\nyou\nlast line` now, you.'), [3], 'a code span that wraps');
  assert.deepEqual(hits('Use the ` character; you can type it.'), [1], 'an unmatched backtick is text');
  assert.deepEqual(hits('Use \\`you\\` here.'), [1], 'escaped backticks open no span');
  assert.deepEqual(identifiers('const caféparty = partyé;'), ['const', 'caféparty', 'partyé']);
  assert.equal(codeName('caféParty'), 'café party');
  assert.notEqual(codeName('partyé'), 'party');
});

test('the terms file is skipped however config.json spells its path', (t) => {
  const { rules } = repo(t, { version: 1, rules: [{ id: 'clients', terms: { guest: 'client' } }] }, { version: 1, terms: { file: '././.aidrian/../.aidrian/terms.json' } });
  assert.deepEqual(scanLines(numbered('"guest": "client"'), '.aidrian/terms.json', rules()), []);
});
