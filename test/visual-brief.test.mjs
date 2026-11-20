import '../scripts/test-state.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const SKILL = path.resolve(import.meta.dirname, '../plugins/aidrian/skills/visual-brief');
const CHECK = path.join(SKILL, 'scripts/check-secrets.mjs');
const OFFLINE = path.join(SKILL, 'scripts/check-offline.mjs');
const checkOffline = (file) => spawnSync(process.execPath, [OFFLINE, file], { encoding: 'utf8' });
const scan = (...args) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });

// Keep a synthetic release-shaped file available for the isolated browser check.
const BRIEF_FIXTURE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>Morning service at West Station</title>
<style>
  body { margin: 0 auto; max-width: 52rem; padding: 1.25rem; font: 1rem/1.55 system-ui, sans-serif; color: #152535; background: #fbf8ee; }
  h1 { line-height: 1.1; }
  .times { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; margin: 0; }
  .times > div { padding: .75rem; border: 1px solid #657181; border-radius: .25rem; }
  dd { margin: 0; font-size: 1.5rem; font-weight: 700; }
  a { color: #174f7a; }
  :focus-visible { outline: 3px solid #174f7a; outline-offset: 3px; }
  @media print { nav, details { display: none; } }
</style>
<main>
  <h1>The first train leaves 20 minutes later</h1>
  <p>For riders at West Station on weekdays, the first departure moves from 06:40 to 07:00.
    Weekend hours stay at 08:00. <a href="#timetable">Timetable</a></p>
  <nav aria-label="Contents"><a href="#times">Compare times</a> · <a href="#sources">Sources</a></nav>
  <section id="times">
    <h2>First weekday departure</h2>
    <dl class="times">
      <div><dt>Previous</dt><dd>06:40</dd></div>
      <div><dt>Updated</dt><dd>07:00</dd></div>
    </dl>
    <details><summary>How the change was calculated</summary><p>Both times are local. 07:00 minus 06:40 is 20 minutes.</p></details>
  </section>
  <section id="sources">
    <h2>Sources</h2>
    <p id="timetable">Synthetic timetable, early departures. <a href="https://example.org/timetable" rel="noreferrer">Example source link</a></p>
  </section>
</main>
</html>
`;

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'visual-brief-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('visual brief is packaged for explicit invocation on both hosts', () => {
  const frontmatter = readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').split(/^---$/mu)[1];
  assert.match(frontmatter, /^name: visual-brief$/mu);
  assert.match(frontmatter, /^disable-model-invocation: true$/mu);
  assert.doesNotMatch(frontmatter, /^user-invocable: false$/mu);
  const metadata = readFileSync(path.join(SKILL, 'agents/openai.yaml'), 'utf8');
  assert.match(metadata, /^interface:\n  display_name: Visual Brief$/mu);
  assert.match(metadata, /^policy:\n  allow_implicit_invocation: false$/mu);
});

test('the checker accepts the standalone fixture and common placeholders', (t) => {
  const file = path.join(scratch(t), 'station-brief.html');
  writeFileSync(file, BRIEF_FIXTURE + [
    '<!-- Authorization: Bearer [REDACTED] -->',
    '<p>Authorization: Bearer <strong>[REDACTED]</strong></p>',
    '<p>Authorization:</p>',
    '<p>A separate note about source coverage.</p>',
    '<p>Authorization:</p><p>A separate note on the same line.</p>',
    '<p>Token:</p><p>Ordinary explanatory heading.</p>',
    '<pre>Authorization:\nBearer [REDACTED]</pre>',
    '<pre>Cookie: [REDACTED]\nSet-Cookie: &lt;redacted&gt;</pre>',
    '<code>api_key=&quot;YOUR_API_KEY&quot;</code>',
    '<code>password=\x24{PASSWORD}</code>',
    '<code>client_secret=&lt;redacted&gt;</code>',
    '<code>client_secret: &quot;&quot;</code>',
    '<p>Rotate passwords, then update the authorization header.</p>',
    '<a href="https://example.org/path?name=two&amp;region=example">Source</a>',
  ].join('\n'), { mode: 0o600 });
  const result = scan(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
});

test('the checker reports only fixed rule names and original line numbers', (t) => {
  const file = path.join(scratch(t), 'synthetic-secrets.html');
  writeFileSync(file, [
    '<!doctype html>',
    `<!-- ${'ghp_'}${'S'.repeat(36)} -->`,
    `<p>&#x73;k&#45;proj&#x2d;${'z'.repeat(35)}</p>`,
    '<code>-----BEGIN OPENSSH PRIVATE KEY-----</code>',
    '<p>Authorization: <strong>Bearer artificial-bearer-value</strong></p>',
    '<code>&quot;client_secret&quot;&colon; &quot;fictional-value&quot;</code>',
    '<a href="https&colon;&sol;&sol;fake%3Aphrase&commat;example.org">Source</a>',
    '<a href="https://example.org/?name=report&amp;X%2dAmz%2dSignature%3dfake-value">Source</a>',
    '<code>X&#45;API&#45;KEY&#x3a; definitely-fake-secret</code>',
    '<p>Ordinary evidence.</p>',
  ].join('\r\n'), { mode: 0o600 });
  const result = scan(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, [
    'credential-signature:2',
    'credential-signature:3',
    'private-key:4',
    'credential-value:5',
    'credential-value:6',
    'url-credentials:7',
    'signed-url:8',
    'credential-value:9',
    '',
  ].join('\n'), '']);
});

test('cookie headers and wrapped assignments report the line where the field starts', (t) => {
  const file = path.join(scratch(t), 'synthetic-headers.html');
  writeFileSync(file, [
    '<pre>Cookie: session=fictional-session',
    'Set-Cookie: preview=illustrative-cookie; Path=/',
    'Authorization:',
    'Bearer fictional-credential',
    '{&quot;client_secret&quot;:',
    ' &quot;illustrative-client-value&quot;}</pre>',
    '<p>Authorization:',
    '<strong>Bearer another-synthetic-value</strong></p>',
    '<p>Authorization: Bearer',
    '<span>one-more-synthetic-value</span></p>',
  ].join('\n'), { mode: 0o600 });
  const result = scan(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, [
    'credential-value:1',
    'credential-value:2',
    'credential-value:3',
    'credential-value:5',
    'credential-value:7',
    'credential-value:9',
    '',
  ].join('\n'), '']);
});

test('the checker gives generic usage and read errors without leaking a supplied path', (t) => {
  const missing = path.join(scratch(t), 'private-location.html');
  for (const args of [[], [missing, 'ignored'], ['--bad-option']]) {
    const result = scan(...args);
    assert.deepEqual([result.status, result.stdout, result.stderr], [2, '', 'Usage: node check-secrets.mjs <html-file>\n']);
  }
  const result = scan(missing);
  assert.deepEqual([result.status, result.stdout, result.stderr], [2, '', 'Could not read HTML file.\n']);
});

test('scan detects credential-bearing environment variable assignments', (t) => {
  const file = path.join(scratch(t), 'environment.html');
  writeFileSync(file, [
    '<pre>POSTGRES_PASSWORD=fictional-db-password',
    'SERVICE_API_KEY=&quot;fictional-opaque-value&quot;',
    'MAIL_PASSWD=[REDACTED]',
    'APP_SECRET_KEY=YOUR_SECRET',
    'MAX_PASSWORD_LENGTH=24</pre>',
  ].join('\n'));
  const result = scan(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, 'credential-value:1\ncredential-value:2\n', '']);
});

test('scan checks cookie pair values independently and ignores Set-Cookie attributes', (t) => {
  const file = path.join(scratch(t), 'cookies.html');
  writeFileSync(file, [
    '<pre>Set-Cookie: session=[REDACTED]; Path=/; Secure; HttpOnly',
    'Cookie: session=&lt;redacted&gt;; preferences=&quot;[REDACTED]&quot;',
    'Cookie: session=[REDACTED]; preferences=fictional-value',
    'Set-Cookie: session=fictional-value; Path=/',
    'Cookie:',
    '<strong>session=fictional-wrapped-value</strong></pre>',
  ].join('\n'));
  const result = scan(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [1, 'credential-value:3\ncredential-value:4\ncredential-value:5\n', '']);
});

test('offline check accepts the standalone fixture and locally authored SVG', (t) => {
  const file = path.join(scratch(t), 'offline.html');
  writeFileSync(file, BRIEF_FIXTURE.replace('</main>', [
    '<!-- <script>Quoted markup</script> -->',
    '<p>&lt;iframe src=&quot;example&quot;&gt;</p>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" aria-label="Sample">',
    '<defs><linearGradient id="shade"><stop offset="0%" stop-color="#fff"/></linearGradient></defs>',
    '<rect width="50" height="50" fill="url(#shade)"/>',
    '</svg>',
    '</main>',
  ].join('\n')));
  const result = checkOffline(file);
  assert.deepEqual([result.status, result.stdout, result.stderr], [0, '', '']);
});

test('offline check rejects active markup and resource-bearing syntax without echoing it', (t) => {
  const file = path.join(scratch(t), 'contains-markup.html');
  for (const [rule, markup] of [
    ['offline-element', '<script>synthetic text</script>'],
    ['offline-element', '<img src="https://example.org/image">'],
    ['offline-element', '<link rel="dns-prefetch" href="//example.org">'],
    ['offline-element', '<iframe srcdoc="synthetic text"></iframe>'],
    ['offline-element', '<svg><foreignObject>synthetic text</foreignObject></svg>'],
    ['offline-element', '<form action="/submit"></form>'],
    ['offline-meta', '<meta http-equiv="refresh" content="1">'],
    ['offline-attribute', '<p onpointerover="synthetic text">Paragraph</p>'],
    ['offline-attribute', '<a href="#times" ping="https://example.org/">Anchor</a>'],
    ['offline-attribute', '<svg><use href="https://example.org/graphic"/></svg>'],
    ['offline-citation', '<a href="jav&#97;script:void(0)">Anchor</a>'],
    ['offline-citation', '<a href="//example.org/" rel="noreferrer">Anchor</a>'],
    ['offline-citation', '<a href="https://example.org/">Citation</a>'],
    ['offline-css', '<style>@import "https://example.org/style";</style>'],
    ['offline-css', '<style>.x { background: image-set("https://example.org/image" 1x); }</style>'],
    ['offline-css', '<p style="background:&#117;rl(https://example.org/image)">Paragraph</p>'],
    ['offline-css', '<svg><rect fill="url(https://example.org/paint)"/></svg>'],
    ['offline-markup', '<p class="a" CLASS="b">Duplicate attribute</p>'],
  ]) {
    writeFileSync(file, '<!doctype html>\n' + markup);
    const result = checkOffline(file);
    assert.deepEqual([result.status, result.stdout, result.stderr], [1, rule + ':2\n', ''], markup);
  }
});
