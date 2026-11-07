// Images taken outside the tool, ingested as captures of one head (issue #139): `ingestCaptures` in
// lib/review/visual.mjs and `aidrian pr ingest` (runIngest in lib/review-gate.mjs). An ingest is an audit entry, not a
// measured capture: it sits apart from the tool's entries in the manifest, and every surface marks it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { checkReview } from '../plugins/aidrian/lib/review/config.mjs';
import { captureDir, captureKeys, captureVisual, capturesBody, ingestCaptures, readManifest, uploadCaptures, visualInput, visualMatrix } from '../plugins/aidrian/lib/review/visual.mjs';
import { runIngest } from '../plugins/aidrian/lib/review-gate.mjs';

const CLI = path.resolve(import.meta.dirname, '../plugins/aidrian/lib/cli.mjs');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x10, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const HEAD = 'a'.repeat(40);
const visual = checkReview({ visual: { platform: 'web', targets: [{ files: ['src/**'], routes: ['/dashboard'] }], viewports: [360] } }, 'config.json', []).visual;
const entries = visualMatrix(visual, [{ route: '/dashboard', base: null }]);
const base = async (use) => use(async () => { throw new Error('no hook runs here'); });
const fakeAdapter = (_node, _args, { input }) => {
  const job = JSON.parse(input);
  const results = job.entries.map((entry) => {
    const file = path.join(job.outDir, `${entry.key}.png`);
    writeFileSync(file, PNG);
    return { key: entry.key, file, facts: { status: 200 } };
  });
  return { status: 0, stdout: JSON.stringify({ results }), stderr: '' };
};

// A project with one commit, so `aidrian pr ingest` has a head to check, and `write(rel, bytes)` for files in it.
function project(t) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-ingest-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  mkdirSync(path.join(dir, '.aidrian'));
  writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1 }));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const write = (rel, bytes) => {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    return file;
  };
  return { dir, git, write, project: projectAt(dir), head: git('rev-parse', 'HEAD') };
}

const ingest = (p, more = {}) => ingestCaptures({ project: p.project, pr: 7, head: HEAD, files: [p.write('shots/dashboard 360.png', PNG)], source: 'e2e-runner run 12', by: 'Tester', agent: 'e2e-runner', ...more });

test('ingestCaptures copies each image into the head`s capture folder and records its key, hash, and source apart from the tool`s entries', (t) => {
  const p = project(t);
  const shot = p.write('shots/dashboard 360.png', PNG);
  const { manifest, ingested } = ingestCaptures({ project: p.project, pr: 7, head: HEAD, files: [shot, p.write('shots/b.jpg', JPEG), p.write('shots/c.gif', GIF), p.write('shots/d.webp', WEBP)], source: '  e2e-runner   run 12 ', by: 'Tester', agent: 'e2e-runner' });
  assert.deepEqual(ingested.map((each) => [each.key.replace(/-[0-9a-f]{6}$/u, ''), each.type, path.extname(each.file)]), [
    ['ingest-dashboard-360', 'png', '.png'], ['ingest-b', 'jpg', '.jpg'], ['ingest-c', 'gif', '.gif'], ['ingest-d', 'webp', '.webp'],
  ]);
  const [first] = ingested;
  assert.equal(path.dirname(first.file), captureDir(p.project, 7, HEAD));
  assert.deepEqual(readFileSync(first.file), PNG, 'the copy holds the bytes it hashed');
  assert.deepEqual({ ...first.source, at: typeof first.source.at }, { origin: 'e2e-runner run 12', path: shot, by: 'Tester', agent: 'e2e-runner', session: 'ai', at: 'string' });
  const read = readManifest(p.project, 7, HEAD);
  assert.deepEqual([read.status, read.entries, read.ingested.length], ['ingested', [], 4], 'an ingest-only manifest has no tool entry');
  assert.deepEqual(read, manifest);
  assert.ok(captureKeys(read).has(first.key), 'a flow verdict may cite it as capture:<key>');
  assert.ok(read.reason.startsWith(`ingested, not captured: ${first.key} from \`e2e-runner run 12\` by \`Tester\` via \`e2e-runner\`; `), read.reason);
  assert.equal(captureKeys(readManifest(p.project, 7, 'b'.repeat(40))).size, 0, 'another head holds no ingest of this one');

  // The same bytes under the same name ingest again in place; the same name with other bytes is another key.
  ingestCaptures({ project: p.project, pr: 7, head: HEAD, files: [shot], source: 'a later run', by: 'Tester' });
  assert.equal(readManifest(p.project, 7, HEAD).ingested.length, 4, 'replaced, not duplicated');
  assert.equal(readManifest(p.project, 7, HEAD).ingested.find((each) => each.key === first.key).source.origin, 'a later run');
  p.write('shots/dashboard 360.png', Buffer.concat([PNG, Buffer.from('x')]));
  ingestCaptures({ project: p.project, pr: 7, head: HEAD, files: [shot], source: 'run 13', by: 'Tester' });
  assert.equal(readManifest(p.project, 7, HEAD).ingested.length, 5, 'two files that share a name never share a key');
});

test('ingestCaptures refuses a text file, a missing file, a file outside the working tree and the state folder, an empty source, and a short head, by name', (t) => {
  const p = project(t);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-outside-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'shot.png'), PNG);
  symlinkSync(path.join(outside, 'shot.png'), path.join(p.dir, 'linked.png'));
  const inState = path.join(stateDir(p.project), 'shots', 'kept.png');
  mkdirSync(path.dirname(inState), { recursive: true });
  writeFileSync(inState, PNG);
  const good = p.write('shots/good.png', PNG);
  for (const dryRun of [false, true]) {
    const run = (files, more = {}) => ingestCaptures({ project: p.project, pr: 7, head: HEAD, files, source: 'e2e-runner', by: 'Tester', dryRun, ...more });
    assert.throws(() => run([good, p.write('notes.txt', 'not an image\n')]), /notes\.txt is not an image: PNG, JPEG, GIF, or WebP/u);
    assert.throws(() => run([good, path.join(p.dir, 'gone.png')]), /gone\.png is not a file/u);
    assert.throws(() => run([good, path.join(outside, 'shot.png')]), /shot\.png is outside the working tree and the state folder/u);
    assert.throws(() => run([path.join(p.dir, 'linked.png')]), /linked\.png is outside the working tree and the state folder/u, 'a link is judged by where it points');
    assert.throws(() => run([good], { source: '   ' }), /--source needs text: say where the image came from/u);
    // The source reaches the review summary, whose record marker is an HTML comment: no source may plant one.
    assert.throws(() => run([good], { source: 'run 12 <!-- aidrian-review-state-br:AAAA -->' }), /--source cannot hold < or >/u);
    assert.throws(() => run([good], { head: 'abc1234' }), /head must be the full commit SHA/u);
    assert.ok(!existsSync(captureDir(p.project, 7, HEAD)), `a refusal copies nothing and writes no manifest (dryRun ${dryRun})`);
  }
  const dry = ingestCaptures({ project: p.project, pr: 7, head: HEAD, files: [good, inState], source: 'e2e-runner', by: 'Tester', dryRun: true });
  assert.equal(dry.ingested.length, 2, 'a file in the state folder is taken too');
  assert.ok(!existsSync(captureDir(p.project, 7, HEAD)), 'a dry run copies nothing and writes no manifest');
});

test('captureVisual captures over an ingest-only manifest and carries its ingested list through every write', async (t) => {
  const p = project(t);
  const { ingested: [shot] } = ingest(p);
  const run = (more) => captureVisual({ project: p.project, pr: 7, head: HEAD, visual, entries, env: {}, withBase: base, ...more });
  const unavailable = await run({ baseUrl: null });
  assert.equal(unavailable.status, 'unavailable', 'an ingest-only manifest is never taken for a capture');
  assert.deepEqual(unavailable.ingested.map((each) => each.key), [shot.key]);
  assert.ok(/^no base URL: /u.test(unavailable.reason) && unavailable.reason.endsWith(`; ingested, not captured: ${shot.key} from \`e2e-runner run 12\` by \`Tester\` via \`e2e-runner\``), unavailable.reason);
  assert.deepEqual(readManifest(p.project, 7, HEAD), unavailable);
  const failed = await run({ baseUrl: 'http://localhost:3000', spawn: () => ({ status: 1, stdout: '', stderr: 'boom\n' }) });
  assert.deepEqual([failed.status, failed.reason, failed.ingested.length], ['failed', `boom; ingested, not captured: ${shot.key} from \`e2e-runner run 12\` by \`Tester\` via \`e2e-runner\``, 1]);
  const captured = await run({ baseUrl: 'http://localhost:3000', spawn: fakeAdapter });
  assert.deepEqual([captured.status, captured.reason, captured.entries.filter((entry) => entry.sha256).length, captured.ingested.length], ['captured', undefined, 1, 1]);
  const reused = await run({ baseUrl: 'http://localhost:3000', spawn: () => assert.fail('captured twice') });
  assert.deepEqual(reused, captured, 'the captured reuse path returns the merged manifest intact');
  assert.deepEqual([...captureKeys(reused)].sort(), [entries[0].key, shot.key].sort());
});

test('an ingest after a captured manifest keeps it captured, with its entries, and is never uploaded', async (t) => {
  const p = project(t);
  const captured = await captureVisual({ project: p.project, pr: 7, head: HEAD, visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base, spawn: fakeAdapter });
  const { manifest, ingested: [shot] } = ingest(p);
  assert.deepEqual([manifest.status, manifest.reason, manifest.entries], ['captured', undefined, captured.entries]);
  assert.deepEqual([...captureKeys(manifest)].sort(), [entries[0].key, shot.key].sort());
  const sent = [];
  uploadCaptures({ project: p.project, pr: 7, manifest, repo: 'o/r', image: (_repo, files) => (sent.push(...files.map((file) => path.basename(file))), { status: 0, stdout: '' }) });
  assert.deepEqual(sent, [`${entries[0].key}.png`], 'only the tool`s own capture goes up');
  // An ingest on an uncaptured head rewrites the note, never stacks it.
  const q = project(t);
  await captureVisual({ project: q.project, pr: 7, head: HEAD, visual, entries, baseUrl: null, env: {}, withBase: base });
  ingest(q);
  const again = ingest(q, { source: 'run 13', agent: null }).manifest;
  assert.match(again.reason, /^no base URL: [^;]*; ingested, not captured: ingest-dashboard-360-[0-9a-f]{6} from `run 13` by `Tester`$/u, 'the Human`s own shell: the plain name');
});

test('the captures comment and the reviewer input mark each ingest, with its source, and the comment keeps the local path out', (t) => {
  const p = project(t);
  const { manifest, ingested: [shot] } = ingest(p, { source: 'e2e | run `12` @team [x](https://e.example)', by: '@amy' });
  const body = capturesBody(manifest, {}, { mode: 'local', visibility: 'PUBLIC', error: null });
  assert.ok(body.includes('\nAttach: **local**, public repository. 1 ingested, not captured.\n'), 'the Attach line gives the count only');
  assert.match(body, /#### Ingested, not captured\n\n\| Capture \| Source \| By \|\n\| --- \| --- \| --- \|\n/u);
  // Origin, name, and agent are code spans: no mention, link, or markup of theirs renders.
  assert.ok(body.includes(`| \`${shot.key}\` | \`\`e2e \\| run \`12\` @team [x](https://e.example)\`\` | \`@amy\` via \`e2e-runner\` |`), body);
  assert.equal(body.split('\n').filter((line) => line.includes('@team')).length, 1, 'the source shows once, in its code span');
  assert.ok(!body.includes(shot.source.path), 'the comment is posted: the local path stays in the manifest');
  const input = visualInput(manifest, {}, null);
  assert.equal(input.status, 'ingested');
  assert.deepEqual(input.captures, [{ key: shot.key, file: shot.file, ingested: true, source: shot.source }]);
  assert.match(input.cite, /capture:<key>; an entry with ingested: true was taken outside the tool and carries no measured facts/u);
});

test('aidrian pr ingest: --check records nothing, a refusal throws, a short head is stored as the full SHA, and an unknown flag is refused', async (t) => {
  const p = project(t);
  const shot = p.write('shots/look.png', PNG);
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const run = (...args) => runIngest(['7', ...args], projectAt(p.dir), null, { forge: { change: () => ({ url: 'https://github.com/o/r/pull/7' }), conversationComments: () => [] }, env: {} });
  const short = p.head.slice(0, 7);
  assert.equal(await run('--head', short, '--source', 'e2e-runner run 12', '--repo', 'o/r', '--check', shot), 0);
  assert.ok(!existsSync(captureDir(p.project, 7, p.head)), '--check recorded nothing');
  await assert.rejects(run('--head', short, '--source', 'e2e-runner', '--check', p.write('notes.txt', 'x\n')), /notes\.txt is not an image/u);
  await assert.rejects(run('--head', short, '--source', '', shot), /--source needs text/u);
  await assert.rejects(run('--head', short, '--source', 'x <!-- aidrian-review-state-br:AAAA -->', '--check', shot), /--source cannot hold < or >/u);
  await assert.rejects(run('--head', short, shot), /--head, --source, and at least one image file are required/u);
  await assert.rejects(run('--head', short, '--source', 'x'), /--head, --source, and at least one image file are required/u);
  await assert.rejects(run('--head', 'f'.repeat(40), '--source', 'x', shot), /--head f{40} is not a commit in this repository/u);
  await assert.rejects(run('--head', short, '--source', 'x', '--key', 'mine', shot), /unknown argument: --key/u);
  await assert.rejects(run('--head', short, '--source', '--check', shot), /--source needs a value/u);
  await assert.rejects(runIngest(['--check'], projectAt(p.dir)), /ingest needs a pull request number/u);
  assert.equal(await run('--head', short, '--source', 'e2e-runner run 12', '--repo', 'o/r', shot), 0);
  t.mock.restoreAll();
  const manifest = readManifest(p.project, 7, p.head);
  assert.equal(manifest?.head, p.head, 'the manifest is filed under the full SHA the review step reads');
  const [{ key }] = manifest.ingested;
  assert.deepEqual(lines, [
    `ok: the command would ingest 1 image(s) as captures of ${short}; --check recorded nothing`,
    `ingested ${shot} as capture:${key} of ${short} from e2e-runner run 12 by Tester`,
    'no captures comment on o/r#7 yet: the review posts one when it captures this head',
    'Run `aidrian pr review` again.',
  ]);
});

test('aidrian pr ingest: a forge failure on the captures comment loses no ingest, and a comment of another head is left as it is', async (t) => {
  const p = project(t);
  const shot = p.write('shots/look.png', PNG);
  const [lines, warnings, edits] = [[], [], []];
  t.mock.method(console, 'log', (line) => lines.push(line));
  t.mock.method(console, 'error', (line) => warnings.push(line));
  const ingestWith = (forge) => runIngest(['7', '--head', p.head, '--source', 'run 12', '--repo', 'o/r', shot], projectAt(p.dir), null, { forge, env: {} });
  assert.equal(await ingestWith({ conversationComments: () => { throw new Error('gh: HTTP 502'); } }), 0);
  assert.equal(readManifest(p.project, 7, p.head)?.ingested.length, 1, 'the ingest is recorded');
  assert.deepEqual(warnings, ['warning: the captures comment on o/r#7 was not updated (gh: HTTP 502); the ingest is recorded']);
  const other = { id: 5, author_association: 'MEMBER', body: '<!-- aidrian-visual-captures -->\n### Visual capture: `1234567`\n' };
  assert.equal(await ingestWith({ conversationComments: () => [other], editComment: (...args) => edits.push(args) }), 0);
  assert.deepEqual(edits, [], 'the comment shows another head');
  assert.ok(lines.includes('the captures comment on o/r#7 shows another head; it was not edited'), lines.join('\n'));
});

test('aidrian pr ingest edits the captures comment only from a manifest this machine captured, only a trusted or own comment, and only by its exact heading', async (t) => {
  const p = project(t);
  const shot = p.write('shots/look.png', PNG);
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const sha = p.head.slice(0, 7);
  const ingestWith = (comments, edits, more = {}) => runIngest(['7', '--head', p.head, '--source', 'run 12', '--repo', 'o/r', shot], projectAt(p.dir), more.config ?? null, {
    forge: { viewer: () => 'session-bot', conversationComments: () => comments, editComment: (_repo, id, body) => edits.push([id, body]), ...more.forge }, env: {},
  });
  const comment = (more) => ({ id: 9, author_association: 'MEMBER', user: { login: 'amy' }, body: `<!-- aidrian-visual-captures -->\n### Visual capture: \`${sha}\`\n\nAttach: **auto**, private repository. 1 of 1 captured.`, ...more });

  // This machine captured the head: its own captures comment is rewritten, once.
  await captureVisual({ project: p.project, pr: 7, head: p.head, visual, entries, baseUrl: 'http://localhost:3000', env: {}, withBase: base, spawn: fakeAdapter });
  const edits = [];
  assert.equal(await ingestWith([comment()], edits), 0);
  assert.equal(edits.length, 1);
  assert.match(edits[0][1], /#### Ingested, not captured/u);
  // An outsider's marker comment for the head is no captures comment; the session's own login's is.
  const outsider = [];
  await ingestWith([comment({ author_association: 'NONE', user: { login: 'mallory' } })], outsider);
  assert.deepEqual(outsider, []);
  const own = [];
  await ingestWith([comment({ author_association: 'NONE', user: { login: 'session-bot' } })], own);
  assert.equal(own.length, 1, 'the session`s own comment counts');
  // The head is matched by the heading line itself, never by the same text inside a source of another head's comment.
  const elsewhere = [];
  await ingestWith([comment({ body: `<!-- aidrian-visual-captures -->\n### Visual capture: \`1234567\`\n\n| \`ingest-x-abcdef\` | \`### Visual capture: \`${sha}\`\` | \`Tester\` |` })], elsewhere);
  assert.deepEqual(elsewhere, []);

  // Another machine captured the head: this one holds only the ingest, so the comment is left as that machine wrote it.
  rmSync(stateDir(p.project), { recursive: true, force: true });
  lines.length = 0;
  const foreign = [];
  assert.equal(await ingestWith([comment()], foreign), 0);
  assert.deepEqual(foreign, []);
  assert.ok(lines.includes(`the captures comment of ${sha} was written by another machine; run the review there to show the ingest`), lines.join('\n'));

  // With the review record local there is no captures comment: the pull request is not read.
  lines.length = 0;
  assert.equal(await ingestWith(null, [], { config: { review: { record: 'local' } }, forge: { conversationComments: () => assert.fail('read the pull request') } }), 0);
  assert.ok(lines.includes('the review record is local, so no captures comment shows the ingest'), lines.join('\n'));
});

test('aidrian pr ingest records the session kind: the Human`s shell gives the plain name, an AI session its agent or that it names none', async (t) => {
  const p = project(t);
  const shot = p.write('shots/look.png', PNG);
  t.mock.method(console, 'log', () => {});
  const by = async (env) => {
    await runIngest(['7', '--head', p.head, '--source', 'run 12', '--repo', 'o/r', shot], projectAt(p.dir), null, { env, forge: { conversationComments: () => [] } });
    const [entry] = readManifest(p.project, 7, p.head).ingested;
    return [entry.source.session, entry.source.agent, readManifest(p.project, 7, p.head).reason.split(' by ')[1]];
  };
  assert.deepEqual(await by({}), ['shell', null, '`Tester`']);
  assert.deepEqual(await by({ CLAUDECODE: '1' }), ['ai', null, '`Tester` in an AI session, agent unknown']);
  assert.deepEqual(await by({ CODEX_THREAD_ID: 't-1' }), ['ai', null, '`Tester` in an AI session, agent unknown'], 'any host the host layer detects');
  assert.deepEqual(await by({ CLAUDECODE: '1', CLAUDE_CODE_AGENT: 'e2e-runner' }), ['ai', 'e2e-runner', '`Tester` via `e2e-runner`']);
});

test('aidrian pr with no action prints a usage that names ingest', (t) => {
  const p = project(t);
  const { status, stderr } = spawnSync(process.execPath, [CLI, 'pr'], { cwd: p.dir, encoding: 'utf8' });
  assert.equal(status, 1);
  assert.match(stderr, /aidrian pr ingest PR --head SHA --source TEXT \[--repo OWNER\/NAME\] \[--check\] FILE\.\.\./u);
});
