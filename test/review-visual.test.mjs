import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { attachMode, captureDir, captureKeys, captureVisual, capturesBody, readManifest, uploadCaptures, visualMatrix, visualRoutes } from '../plugins/aidrian/lib/review/visual.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const visualConfig = (over = {}) => checkReview({ visual: {
  platform: 'web',
  targets: [{ files: ['re:^src/app/.*\\.tsx$'], routes: ['/dashboard'] }, { files: ['src/components/**'], routes: ['/dashboard', '/{locale}/book'] }],
  viewports: [360, 1280],
  locales: ['en', 'de'],
  variants: [{ id: 'hospitality', account: 'demo-h' }, { id: 'appointments', account: 'demo-a' }],
  login: 'node scripts/login.mjs',
  ...over,
} }, 'config.json', []).visual;

function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-visual-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  return projectAt(dir);
}

// A fake adapter: writes a PNG per entry (or the bytes `bytes(entry)` returns) and reports facts.
const fakeAdapter = (bytes = () => PNG, seen = []) => (_node, _args, { input }) => {
  const job = JSON.parse(input);
  seen.push(job);
  const results = job.entries.map((entry) => {
    const file = path.join(job.outDir, `${entry.key}.png`);
    writeFileSync(file, bytes(entry));
    return { key: entry.key, file, facts: { status: 200, overflowX: entry.width === 360 ? { scrollWidth: 400, clientWidth: 360 } : null, clippedText: [], smallTargets: [] } };
  });
  return { status: 0, stdout: JSON.stringify({ results }), stderr: '' };
};
const base = (hook) => async (use) => use(hook);

test('routes come from the targets a change touches; the matrix is route x variant x locale x width, with {locale} filled', () => {
  const visual = visualConfig();
  assert.deepEqual(visualRoutes(visual, [{ file: 'src/components/Button.tsx' }]), ['/dashboard', '/{locale}/book']);
  assert.deepEqual(visualRoutes(visual, [{ file: 'src/lib/x.ts' }]), []);
  const entries = visualMatrix(visual, ['/dashboard', '/{locale}/book']);
  assert.equal(entries.length, 2 * 2 * 2 * 2);
  assert.ok(entries.some((entry) => entry.key === 'locale-book-f45c08--360--de--appointments'));
  const keys = visualMatrix(visual, ['/a/b', '/a-b', '/A/b']).map((entry) => entry.key.split('--')[0]);
  assert.equal(new Set(keys).size, 3, 'routes that slug alike keep their own capture');
  const many = Array.from({ length: 30 }, (_, i) => `/r${i}`);
  assert.throws(() => visualMatrix(visual, many), /240 images, past 200.*\/r0, \/r1/u);
});

test('attach: private repositories attach, public ones keep captures local, and the config decides when it says so', () => {
  assert.equal(attachMode(visualConfig(), 'PRIVATE'), 'auto');
  assert.equal(attachMode(visualConfig(), 'INTERNAL'), 'auto');
  assert.equal(attachMode(visualConfig(), 'PUBLIC'), 'local');
  assert.equal(attachMode(visualConfig(), null), 'local', 'an unknown visibility never uploads');
  assert.equal(attachMode(visualConfig({ attach: 'auto' }), 'PUBLIC'), 'auto');
  assert.equal(attachMode(visualConfig({ attach: 'off' }), 'PRIVATE'), 'off');
});

test('captureVisual signs in per variant from the base, captures once per head, and keeps no secret on disk', async (t) => {
  const p = project(t);
  const visual = visualConfig();
  const entries = visualMatrix(visual, ['/{locale}/book']);
  const hooks = [];
  const hook = async (command, input) => (hooks.push([command, input]), JSON.stringify({ storageState: { cookies: [{ name: 's', value: 'secret' }] }, ...(input.variant === 'appointments' ? { baseUrl: 'https://appts.localhost:3000' } : {}) }));
  const seen = [];
  const manifest = await captureVisual({ project: p, pr: 7, head: 'a'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(hook), spawn: fakeAdapter(undefined, seen) });
  assert.equal(manifest.status, 'captured');
  assert.equal(manifest.entries.filter((entry) => entry.sha256).length, 8);
  assert.deepEqual(hooks.map(([command, input]) => [command, input.account]), [['node scripts/login.mjs', 'demo-h'], ['node scripts/login.mjs', 'demo-a']]);
  assert.ok(seen[0].entries.some((job) => job.url === 'https://appts.localhost:3000/de/book'), 'a variant may sign in on its own host');
  assert.ok(seen[0].entries.some((job) => job.url === 'http://localhost:3000/en/book'));
  const files = (await import('node:fs')).readdirSync(captureDir(p, 7, 'a'.repeat(40)));
  assert.ok(!files.some((file) => file.startsWith('.auth-')), 'storage states are removed after the capture');
  const again = await captureVisual({ project: p, pr: 7, head: 'a'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(hook), spawn: () => assert.fail('captured twice') });
  assert.deepEqual(again, manifest);
  assert.equal(captureKeys(readManifest(p, 7, 'a'.repeat(40))).size, 8);
});

test('captureVisual: no base URL, a missing Playwright, or a failed login is a status for reviewers, not a crash', async (t) => {
  const p = project(t);
  const visual = visualConfig({ variants: [], login: undefined });
  const entries = visualMatrix(visual, ['/dashboard']);
  const none = await captureVisual({ project: p, pr: 1, head: 'b'.repeat(40), visual, entries, baseUrl: null, env: {}, withBase: base(async () => '') });
  assert.equal(none.status, 'unavailable');
  assert.match(none.reason, /no base URL/u);
  const retried = await captureVisual({ project: p, pr: 1, head: 'b'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => ''), spawn: fakeAdapter() });
  assert.equal(retried.status, 'captured', 'a capture that did not run is tried again on the same head');
  const missing = await captureVisual({ project: p, pr: 1, head: 'c'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => ''), spawn: () => ({ status: 3, stdout: '', stderr: 'Playwright is not installed in this project\n' }) });
  assert.deepEqual([missing.status, missing.reason], ['unavailable', 'Playwright is not installed in this project']);
  const down = (_node, _args, { input }) => ({ status: 0, stdout: JSON.stringify({ results: JSON.parse(input).entries.map((entry) => ({ key: entry.key, error: 'net::ERR_CONNECTION_REFUSED' })) }), stderr: '' });
  const refused = await captureVisual({ project: p, pr: 1, head: 'f'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => ''), spawn: down });
  assert.equal(refused.status, 'failed');
  assert.match(refused.reason, /4 of 4 captures failed: net::ERR_CONNECTION_REFUSED/u);
  const recovered = await captureVisual({ project: p, pr: 1, head: 'f'.repeat(40), visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => ''), spawn: fakeAdapter() });
  assert.equal(recovered.status, 'captured', 'a capture whose pages all failed runs again once the server is up');
  const login = await captureVisual({ project: p, pr: 1, head: 'd'.repeat(40), visual: visualConfig(), entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => { throw new Error('bad password'); }) });
  assert.equal(login.status, 'failed');
  assert.match(login.reason, /hospitality: bad password/u);
  const preview = await captureVisual({ project: p, pr: 1, head: 'e'.repeat(40), visual: { ...visual, preview: 'node scripts/preview.mjs' }, entries, baseUrl: null, env: {}, withBase: base(async () => 'https://pr-1.preview.example\n'), spawn: fakeAdapter() });
  assert.equal(preview.baseUrl, 'https://pr-1.preview.example');
});

test('uploadCaptures sends only this head\'s PNGs whose bytes match the manifest, once, and never blocks without gh-image', async (t) => {
  const p = project(t);
  const visual = visualConfig({ variants: [], login: undefined, locales: undefined });
  const head = 'f'.repeat(40);
  const manifest = await captureVisual({ project: p, pr: 2, head, visual: { ...visual, locales: [] }, entries: visualMatrix({ ...visual, locales: [] }, ['/dashboard']), baseUrl: 'http://localhost:3000', env: {}, withBase: base(async () => ''), spawn: fakeAdapter((entry) => (entry.width === 1280 ? Buffer.from('GIF89a') : PNG)) });
  assert.deepEqual(manifest.entries.map((entry) => [entry.width, entry.error ?? 'ok']), [[360, 'ok'], [1280, 'not a PNG']]);
  // A planted file that the manifest names but whose bytes changed is not uploaded.
  const planted = { ...manifest, entries: [...manifest.entries, { key: 'planted', file: path.join(captureDir(p, 2, head), 'planted.png'), sha256: '0'.repeat(64) }] };
  writeFileSync(planted.entries.at(-1).file, PNG);
  const sent = [];
  const image = (_repo, files) => (sent.push(files.map((file) => path.basename(file))), { status: 0, stdout: files.map((file) => `![${path.basename(file, '.png')}](https://github.com/user-attachments/assets/${path.basename(file, '.png')})`).join('\n') });
  const first = uploadCaptures({ project: p, pr: 2, manifest: planted, repo: 'o/r', image });
  assert.deepEqual(sent, [['dashboard-89347b--360--default--default.png']]);
  assert.equal(Object.keys(first.uploaded).length, 1);
  assert.equal(first.error, null);
  assert.deepEqual(uploadCaptures({ project: p, pr: 2, manifest, uploaded: first.uploaded, repo: 'o/r', image: () => assert.fail('uploaded twice') }).uploaded, {});
  const missing = uploadCaptures({ project: p, pr: 2, manifest, repo: 'o/r', image: () => ({ status: 1, stderr: 'unknown command "image" for "gh"' }) });
  assert.match(missing.error, /gh extension install drogers0\/gh-image/u);
  const body = capturesBody(manifest, first.uploaded, { mode: 'auto', visibility: 'PRIVATE', error: null });
  assert.match(body, /^<!-- aidrian-visual-captures -->/u);
  assert.match(body, /Attach: \*\*auto\*\*, private repository/u);
  assert.match(body, /horizontal overflow 400>360/u);
  assert.match(body, /error: not a PNG/u);
});
