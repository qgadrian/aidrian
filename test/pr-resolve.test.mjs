import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parse } from 'yaml';

import { previewPatterns } from '../plugins/aidrian/lib/personas.mjs';
import { checkoutRemotes, remoteKey } from '../plugins/aidrian/lib/pr-checks.mjs';
import { parseTarget, previewFrom, runResolve } from '../plugins/aidrian/lib/pr-resolve.mjs';
import { MEMBER_ASSOCIATIONS } from '../plugins/aidrian/lib/review/state.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const AIDRIAN = path.join(ROOT, 'plugins/aidrian/bin/aidrian');
const CONFIG = { review: { productFeedback: { maxPersonas: 2 } } };
const HEAD = 'a'.repeat(40);
const REMOTES = () => ['github.com/acme/notes', 'github.com/upstream-org/notes'];

const view = (overrides = {}) => ({
  number: 123, url: 'https://github.com/acme/notes/pull/123', headRefOid: HEAD, baseRefName: 'main', state: 'OPEN', isCrossRepository: false, ...overrides,
});

// A gh that answers the reads the command makes, and records every call: `deployments` and `statuses`, by deployment
// id, are what GitHub holds for the pull request's repository. A value of `failing` makes that read fail.
const failing = Symbol('a read that fails');
function fakeGh({ pull = view(), association = 'MEMBER', fork = false, deployments = [], statuses = {} } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const answer = args[0] === 'pr' ? pull
      : args[3].includes('/statuses') ? statuses[args[3].split('/').at(-2)] ?? []
      : args[3].includes('/deployments') ? deployments
      : { author_association: association, base: { repo: { fork } } };
    if (answer === failing) throw new Error('gh: HTTP 500');
    return JSON.stringify(answer);
  };
  return { calls, gh };
}

// runResolve with its console captured: { code, out, err }. No preview line unless a test gives `patterns`.
function resolve(t, args, gh = fakeGh().gh, remotes = REMOTES, config = CONFIG, patterns = () => []) {
  const out = [];
  const err = [];
  const log = t.mock.method(console, 'log', (line) => out.push(line));
  const error = t.mock.method(console, 'error', (line) => err.push(line));
  const code = runResolve(args, config, gh, remotes, patterns);
  log.mock.restore();
  error.mock.restore();
  return { code, out: out.join('\n'), err: err.join('\n') };
}

test('a URL, with /files or another tab, a query, or a fragment, a number, and #number all resolve to the same JSON', (t) => {
  const base = 'https://github.com/acme/notes/pull/123';
  for (const value of [base, `${base}/files`, `${base}/commits`, `${base}/checks`, `${base}/changes`, `${base}?diff=split`, `${base}/files?w=1#diff-abc`, `${base}#issuecomment-9`, '123', '#123']) {
    const { code, out, err } = resolve(t, [value]);
    assert.equal(code, 0, `${value}: ${err}`);
    assert.deepEqual(JSON.parse(out), {
      number: 123, host: 'github.com', repo: 'acme/notes', head: HEAD, base: 'main', state: 'OPEN', cross_repository: false, author_association: 'MEMBER', limited: false, preview_url: null, max_personas: 2,
    }, value);
  }
});

test('gh is called with <n> --repo <host>/<owner>/<name>, never with the raw URL', (t) => {
  const { calls, gh } = fakeGh();
  const url = 'https://github.com/acme/notes/pull/123/files?secret=1';
  assert.equal(resolve(t, [url], gh).code, 0);
  assert.deepEqual(calls[0].slice(0, 5), ['pr', 'view', '123', '--repo', 'github.com/acme/notes']);
  assert.deepEqual(calls[1], ['api', '--hostname', 'github.com', 'repos/acme/notes/pulls/123']);
  assert.ok(!calls.flat().some((arg) => arg.includes('https://') || arg.includes('secret')), 'no call holds the raw URL');
});

test('a bare number lets gh pick the repository, then holds the answer to the remotes of this checkout', (t) => {
  const { calls, gh } = fakeGh();
  assert.equal(resolve(t, ['#123'], gh).code, 0);
  assert.deepEqual(calls[0].slice(0, 3), ['pr', 'view', '123']);
  assert.ok(!calls[0].includes('--repo'));
  assert.deepEqual(calls[1], ['api', '--hostname', 'github.com', 'repos/acme/notes/pulls/123'], 'later calls name the repository gh answered for');

  const other = fakeGh({ pull: view({ url: 'https://github.com/other/app/pull/123' }) });
  const refused = resolve(t, ['123'], other.gh);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /^error: not a remote: github\.com\/other\/app is not a remote of this checkout/u);
  assert.match(refused.err, /compared host github\.com/u, 'it names the host it compared');
  assert.match(refused.err, /an SSH host alias is not matched/u);
  assert.doesNotMatch(refused.err, /run this from/u, 'the reader may be in that checkout already');
  assert.equal(refused.out, '');
  assert.equal(other.calls.length, 1, 'nothing else is read from another repository');
});

test('each refused URL exits 3, names the kind of refusal, and reaches no gh', (t) => {
  for (const [value, kind] of [
    ['https://evil.example/acme/notes/pull/5', /^error: not a remote: evil\.example\/acme\/notes is not a remote of this checkout/u],
    ['https://github.com/acme/notes/pull/12abc', /^error: path: /u],
    ['https://github.com/acme/notes/issues/7', /^error: path: /u],
    ['https://github.com/acme/notes/pull/5/files/abc', /^error: path: /u],
    ['https://github.com/acme/notes/pull/5/', /^error: path: /u],
    ['https://github.com/acme/notes/pull/5\n--repo=evil/app', /^error: path: /u],
    ['https://github.com/acme/notes/pull/0', /^error: number: /u],
    ['https://user:tok@github.com/acme/notes/pull/5', /^error: userinfo: /u],
    ['https://github.com\\@evil.example/acme/notes/pull/5', /^error: userinfo: /u],
    ['https://github.com/../../pull/1', /^error: owner or name: /u],
    ['https://github.com/./notes/pull/1', /^error: owner or name: /u],
    ['https://github.com/acme/n%6Fotes/pull/1', /^error: owner or name: /u],
    ['https://github.com:443/acme/notes/pull/1', /^error: host: /u],
    ['https://github.com\\evil/acme/notes/pull/1', /^error: host: /u],
    ['http://github.com/acme/notes/pull/5', /^error: scheme: /u],
    ['ssh://github.com/acme/notes/pull/5', /^error: scheme: /u],
    ['https://other.example/other/app/pull/5', /^error: not a remote: other\.example\/other\/app /u],
    ['https://github.com/other/app/pull/5', /^error: not a remote: github\.com\/other\/app /u],
    ['0', /^error: number: /u],
    ['floor-manager', /^error: argument: /u],
    ['--repo=evil/app', /^error: argument: /u],
  ]) {
    const { calls, gh } = fakeGh();
    const { code, out, err } = resolve(t, [value], gh);
    assert.equal(code, 3, value);
    assert.match(err, kind, value);
    assert.equal(out, '', value);
    assert.deepEqual(calls, [], `${value}: gh is never asked`);
  }
});

test('a refusal never prints what the argument carried, such as a token', (t) => {
  for (const value of ['https://user:tok-secret@github.com/acme/notes/pull/5', 'http://github.com/tok-secret/pull/5', 'tok-secret', 'https://github.com/acme/notes/pull/5?tok-secret\n']) {
    const { code, out, err } = resolve(t, [value]);
    assert.equal(code, 3, value);
    assert.ok(!`${out}${err}`.includes('tok-secret'), value);
  }
});

test('a remote compares by host, owner, and name, in any case', (t) => {
  assert.equal(resolve(t, ['https://GitHub.com/Acme/Notes/pull/123']).code, 0);
  assert.equal(resolve(t, ['https://github.com/upstream-org/notes/pull/123']).code, 0, 'a fork upstream is the same project');
  const enterprise = fakeGh({ pull: view({ url: 'https://git.corp.example/acme/notes/pull/123' }) });
  const remotes = () => ['git.corp.example/acme/notes'];
  const { code, out } = resolve(t, ['https://git.corp.example/acme/notes/pull/123'], enterprise.gh, remotes);
  assert.equal(code, 0);
  assert.equal(JSON.parse(out).host, 'git.corp.example', 'later gh calls need the host: owner/name alone reaches the default host');
  assert.deepEqual(enterprise.calls[0].slice(2, 5), ['123', '--repo', 'git.corp.example/acme/notes']);
  assert.deepEqual(enterprise.calls[1], ['api', '--hostname', 'git.corp.example', 'repos/acme/notes/pulls/123']);
  assert.equal(resolve(t, ['https://github.com/acme/notes/pull/123'], enterprise.gh, remotes).code, 3, 'the same owner and name on another host is another repository');
});

test('a repository that moved is held to the remotes too, by the URL gh answers with', (t) => {
  const moved = fakeGh({ pull: view({ url: 'https://github.com/new-owner/notes/pull/123' }) });
  const { code, err } = resolve(t, ['https://github.com/acme/notes/pull/123'], moved.gh);
  assert.equal(code, 3);
  assert.match(err, /github\.com\/new-owner\/notes is not a remote/u);
});

test('limited is the command\'s word on who opened the pull request: a member\'s, a contributor\'s fork as a remote, a stranger\'s on the upstream', (t) => {
  const limited = (options) => JSON.parse(resolve(t, ['123'], fakeGh(options).gh).out);
  const member = limited({});
  assert.deepEqual([member.cross_repository, member.author_association, member.limited], [false, 'MEMBER', false]);
  // A contributor's own fork as a remote: they own the fork, and the pull request sits inside it.
  const onFork = limited({ association: 'OWNER', fork: true });
  assert.deepEqual([onFork.cross_repository, onFork.author_association, onFork.limited], [false, 'OWNER', true]);
  const stranger = limited({ pull: view({ isCrossRepository: true }), association: 'NONE' });
  assert.deepEqual([stranger.cross_repository, stranger.author_association, stranger.limited], [true, 'NONE', true]);
  assert.equal(limited({ pull: view({ isCrossRepository: true }), association: 'MEMBER' }).limited, true, 'a member\'s fork still comes from outside');
  for (const association of MEMBER_ASSOCIATIONS) assert.equal(limited({ association }).limited, false, association);
  for (const association of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'MANNEQUIN', 'NONE']) assert.equal(limited({ association }).limited, true, association);
});

test('a preview comes from a deployment status for the exact head, and only under a Preview line', (t) => {
  const patterns = () => ['*.preview.example.com', 'staging.example.com'];
  const good = 'https://pr-5.preview.example.com/';
  const deployed = { deployments: [{ id: 7, sha: HEAD }], statuses: { 7: [{ id: 1, state: 'success', environment_url: good }] } };
  const preview = (options, using = patterns) => {
    const fake = fakeGh(options);
    const { code, out, err } = resolve(t, ['123'], fake.gh, REMOTES, CONFIG, using);
    assert.equal(code, 0, `a preview never ends the run: ${err}`);
    return { url: JSON.parse(out).preview_url, calls: fake.calls };
  };
  const { url, calls } = preview(deployed);
  assert.equal(url, good);
  assert.deepEqual(calls[2], ['api', '--hostname', 'github.com', `repos/acme/notes/deployments?sha=${HEAD}`]);
  assert.deepEqual(calls[3], ['api', '--hostname', 'github.com', 'repos/acme/notes/deployments/7/statuses']);
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 1, state: 'success', environment_url: 'https://staging.example.com/app' }] } }).url, 'https://staging.example.com/app', 'an exact host');

  assert.equal(preview({}).url, null, 'no deployment');
  assert.equal(preview({ deployments: [{ id: 7, sha: 'b'.repeat(40) }], statuses: deployed.statuses }).url, null, 'a deployment for another sha');
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 2, state: 'failure', environment_url: good }, { id: 1, state: 'in_progress', environment_url: good }] } }).url, null, 'no success');
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 1, state: 'success' }] } }).url, null, 'a success with no URL');
  assert.equal(preview({ deployments: failing }).url, null, 'a failed read of the deployments');
  assert.equal(preview({ ...deployed, statuses: { 7: failing } }).url, null, 'a failed read of the statuses');
  assert.equal(preview({ deployments: { message: 'Not Found' } }).url, null, 'an answer that is no list');
  const oddId = preview({ deployments: [{ id: '7/../../x', sha: HEAD }], statuses: { x: deployed.statuses[7] } });
  assert.equal(oddId.url, null, 'an id that is no number names no path');
  assert.ok(!oddId.calls.flat().some((arg) => arg.includes('..')), 'and reaches no gh');

  const noLine = preview(deployed, () => []);
  assert.deepEqual([noLine.url, noLine.calls.length], [null, 2], 'no Preview line: no deployment call');
  const unreadable = preview(deployed, () => { throw new Error('no such doc'); });
  assert.deepEqual([unreadable.url, unreadable.calls.length], [null, 2], 'a product-access doc that cannot be read');

  const later = { deployments: [{ id: 7, sha: HEAD }, { id: 8, sha: HEAD }], statuses: { 7: [{ id: 1, state: 'success', environment_url: 'https://evil.example/' }], 8: [{ id: 2, state: 'success', environment_url: good }] } };
  assert.equal(preview(later).url, good, 'the first deployment whose URL passes');

  // Only a deployment's newest status counts, by the highest id, in whatever order gh lists them.
  const older = { id: 1, state: 'success', environment_url: good };
  for (const state of ['inactive', 'failure', 'error', 'in_progress']) {
    assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 2, state, environment_url: good }, older] } }).url, null, `${state} over an older success`);
    assert.equal(preview({ ...deployed, statuses: { 7: [older, { id: 2, state }] } }).url, null, `${state} over an older success, listed oldest first`);
  }
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 1, state: 'failure' }, { id: 2, state: 'success', environment_url: good }] } }).url, good, 'a success over an older failure');
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 2, state: 'success' }, { id: 1, state: 'success', environment_url: good }] } }).url, null, 'a newest success with no URL over an older one with a URL');
  assert.equal(preview({ ...deployed, statuses: { 7: [{ id: 2, state: 'success', environment_url: 'https://evil.example/' }, older] } }).url, null, 'the newest status\'s own URL, never an older one\'s');
  assert.equal(preview({ deployments: [{ id: 9, sha: HEAD }, { id: 7, sha: HEAD }], statuses: { 9: [{ id: 3, state: 'failure' }], 7: [older] } }).url, good, 'a newer failed deployment does not void an older one still at success');

  // Production is never a preview.
  for (const fields of [{ production_environment: true }, { environment: 'production' }, { environment: 'Production - acme' }, { environment: 'pre-PRODUCTION' }]) {
    const skipped = preview({ deployments: [{ id: 7, sha: HEAD, ...fields }], statuses: deployed.statuses });
    assert.equal(skipped.url, null, JSON.stringify(fields));
    assert.ok(!skipped.calls.some((args) => args.join(' ').includes('/statuses')), `${JSON.stringify(fields)}: its statuses are not read`);
  }
  assert.equal(preview({ deployments: [{ id: 9, sha: HEAD, production_environment: true }, { id: 7, sha: HEAD, environment: 'Preview', production_environment: false }], statuses: { 9: [older], 7: [older] } }).url, good, 'on to the next deployment');

  // A failed statuses read ends the lookup: no later deployment stands in for what could not be read.
  const stopped = preview({ deployments: [{ id: 7, sha: HEAD }, { id: 8, sha: HEAD }], statuses: { 7: failing, 8: [older] } });
  assert.equal(stopped.url, null);
  assert.ok(!stopped.calls.some((args) => args.join(' ').includes('/deployments/8/')), 'the second is not read');
});

test('a limited pull request makes no deployment call and has no preview', (t) => {
  const deployed = { deployments: [{ id: 7, sha: HEAD }], statuses: { 7: [{ state: 'success', environment_url: 'https://pr-5.preview.example.com/' }] } };
  for (const options of [{ association: 'NONE' }, { fork: true }, { pull: view({ isCrossRepository: true }) }]) {
    const fake = fakeGh({ ...deployed, ...options });
    const parsed = JSON.parse(resolve(t, ['123'], fake.gh, REMOTES, CONFIG, () => ['*.preview.example.com']).out);
    assert.deepEqual([parsed.limited, parsed.preview_url], [true, null], JSON.stringify(options));
    assert.ok(!fake.calls.some((args) => args.join(' ').includes('deployments')), 'no deployment call');
  }
});

test('previewFrom holds a URL to https, no userinfo, no port, and a host a Preview line names', () => {
  const patterns = ['*.preview.example.com', 'staging.example.com'];
  for (const url of ['https://pr-5.preview.example.com', 'https://PR-5.preview.EXAMPLE.com/a?b=1', 'https://staging.example.com/', 'https://staging.example.com?x=1']) {
    assert.ok(previewFrom(url, patterns), url);
  }
  for (const [url, why] of [
    ['https://staging.example.com.evil.example/', 'a lookalike'],
    ['https://pr-5.preview.example.com.evil.example/', 'a lookalike of a pattern'],
    ['https://evilpreview.example.com/', 'a suffix with no dot'],
    ['https://user:tok@staging.example.com/', 'userinfo'],
    ['https://user@staging.example.com/', 'a user name'],
    ['http://staging.example.com/', 'http'],
    ['https://staging.example.com:8443/', 'a port'],
    ['https://staging.example.com:443/', 'the default port, written out'],
    ['https:\\\\staging.example.com:8443/', 'a port behind backslashes, which new URL forgives'],
    ['https:\\\\staging.example.com/', 'backslashes'],
    [' https://staging.example.com:8443/', 'a port behind a space, which new URL trims'],
    ['HTTPS://staging.example.com/', 'an upper-case scheme'],
    ['https://staging.example.com:\t443/', 'a tab, which new URL drops'],
    ['https://a.b.preview.example.com/', 'two labels for one star'],
    ['https://preview.example.com/', 'no label for the star'],
    ['https://.preview.example.com/', 'an empty label'],
    ['https://staging.example.com./', 'a trailing dot'],
    ['not a url', 'no URL'],
    ['', 'empty'],
    [null, 'null'],
    [7, 'a number'],
    ["https://staging.example.com/a'b", 'a single quote'],
    ['https://staging.example.com/a$b', 'a dollar sign'],
    ['https://staging.example.com/?x=$(touch y)', 'a command substitution'],
    ['https://staging.example.com/a`b', 'a backtick'],
    ['https://staging.example.com/a\u0001b', 'a control character'],
    ['https://staging.example.com/a\nb', 'a newline, which new URL drops'],
    ['https://staging.example.com/a\tb', 'a tab, which new URL drops'],
    ['https://staging.example.com/a\u007fb', 'a delete'],
    ['https://staging.example.com/a\u0085b', 'a C1 control'],
    ['https://a%24%28id%29.preview.example.com/', 'a dollar and parentheses, decoded from the host'],
    ['https://a%27b.preview.example.com/', 'a single quote, decoded from the host'],
    ['https://a%60b.preview.example.com/', 'a backtick, decoded from the host'],
    ['https://a\uFF04(id).preview.example.com/', 'a fullwidth dollar, which new URL maps to a plain one'],
    ['https://\uFF41\uFF07\uFF42.preview.example.com/', 'a fullwidth single quote, in a fullwidth host'],
    ['https://a(id).preview.example.com/', 'a parenthesis in the host, which no hostname holds'],
  ]) assert.equal(previewFrom(url, patterns), null, why);
  assert.equal(previewFrom('https://pr-5.vercel.app/', ['*.vercel.app']), 'https://pr-5.vercel.app/', 'shared hosting is the project\'s own call: the deployment source closes that attack');
});

test('previewPatterns reads the Preview lines of Environments, and nothing else', () => {
  const doc = [
    '# Product access',
    '',
    'Preview: `outside-a-section.example.com`',
    '',
    '## Environments',
    '',
    '- Local: `http://localhost:3000`.',
    '- Preview: `*.Preview.example.com`, one per pull request.',
    '- Preview: staging.example.com',
    '- Preview: https://with-a-scheme.example.com',
    '- Preview: *.*.two-stars.example.com',
    '- Preview: *',
    'Preview: not-a-list-item.example.com',
    '',
    '```text',
    '- Preview: inside-a-fence.example.com',
    '```',
    '',
    '## Off limits',
    '',
    '- Preview: another-section.example.com',
  ].join('\n');
  assert.deepEqual(previewPatterns(doc), ['*.preview.example.com', 'staging.example.com']);
  assert.deepEqual(previewPatterns('# Product access\n'), []);
  // A star needs at least two labels after it, so it can never stand for a whole top-level domain.
  const star = (value) => previewPatterns(`## Environments\n\n- Preview: ${value}\n`);
  assert.deepEqual(star('*.com'), []);
  assert.deepEqual(star('*.vercel.app'), ['*.vercel.app'], 'shared hosting stays usable');
  assert.deepEqual(star('*.a.b.example.com'), ['*.a.b.example.com']);
  assert.deepEqual(star('localhost'), ['localhost'], 'an exact host may have one label');
  const template = readFileSync(path.join(ROOT, 'plugins/aidrian/skills/persona-audit/references/product-access-template.md'), 'utf8');
  assert.deepEqual(previewPatterns(template), ['*.preview.example.com'], 'the template shows the line');
});

test('the REST answer must say whether the base is a fork', (t) => {
  for (const pull of [{ author_association: 'MEMBER' }, { author_association: 'MEMBER', base: {} }, { author_association: 'MEMBER', base: { repo: {} } }, { author_association: 'MEMBER', base: { repo: { fork: 'false' } } }, { author_association: 'MEMBER', base: { repo: { fork: null } } }]) {
    const gh = (args) => JSON.stringify(args[0] === 'pr' ? view() : pull);
    const { code, out } = resolve(t, ['123'], gh);
    assert.deepEqual([code, out], [3, ''], JSON.stringify(pull));
  }
});

test('a merged or closed pull request still resolves: the walk rules decide its evidence level', (t) => {
  for (const state of ['MERGED', 'CLOSED']) {
    const { code, out } = resolve(t, ['123'], fakeGh({ pull: view({ state }) }).gh);
    assert.equal(code, 0, state);
    assert.equal(JSON.parse(out).state, state);
  }
});

test('max_personas comes from the config', (t) => {
  const { out } = resolve(t, ['123'], fakeGh().gh, REMOTES, { review: { productFeedback: { maxPersonas: 7 } } });
  assert.equal(JSON.parse(out).max_personas, 7);
});

test('gh failing, or an answer the command cannot trust, exits 3 and prints no JSON: no field is guessed', (t) => {
  const failing = () => {
    throw Object.assign(new Error('Command failed'), { stderr: 'GraphQL: Could not resolve to a PullRequest\nmore' });
  };
  const failed = resolve(t, ['123'], failing);
  assert.equal(failed.code, 3);
  assert.match(failed.err, /^error: gh: .*Could not resolve to a PullRequest$/u);
  for (const pull of [view({ url: 'not a url' }), view({ url: undefined }), view({ url: 'https://github.com/acme/notes/pull/124' }), view({ number: 124 }), view({ headRefOid: 'main' }), view({ baseRefName: '' }), view({ state: null }), view({ isCrossRepository: 'false' }), []]) {
    const { code, out } = resolve(t, ['123'], fakeGh({ pull }).gh);
    assert.deepEqual([code, out], [3, ''], JSON.stringify(pull));
  }
  // Without an association the walk limits could not be decided, so the command never fills one in.
  const noAssociation = (args) => (args[0] === 'pr' ? JSON.stringify(view()) : '{}');
  assert.deepEqual([resolve(t, ['123'], noAssociation).code, resolve(t, ['123'], noAssociation).out], [3, '']);
});

test('the command takes one argument', (t) => {
  for (const args of [[], ['123', '124']]) {
    const { code, err } = resolve(t, args);
    assert.equal(code, 3);
    assert.match(err, /usage: aidrian pr resolve/u);
  }
});

test('parseTarget gives the repository of a URL, and none for a number', () => {
  assert.deepEqual(parseTarget('https://github.com/acme/my.app_x-1/pull/5/files'), { host: 'github.com', owner: 'acme', name: 'my.app_x-1', number: 5 });
  assert.deepEqual(parseTarget('#007'), { number: 7 });
});

test('remoteKey keeps the host of https, ssh, and scp-style remotes, and reads no local path', () => {
  for (const url of ['https://github.com/Acme/notes.git', 'https://x-access-token:tok@github.com/acme/notes', 'git@github.com:acme/notes.git', 'git@github.com:/acme/notes.git', 'ssh://git@github.com/acme/notes/', 'ssh://git@github.com:22/acme/notes.git', 'github.com:acme/notes',
    'ssh://git@ssh.github.com:443/acme/notes.git', 'git@ssh.github.com:acme/notes.git', 'git@SSH.github.com:/acme/notes.git']) {
    assert.equal(remoteKey(url), 'github.com/acme/notes', url);
  }
  assert.equal(remoteKey('git@github-work:acme/notes.git'), 'github-work/acme/notes', 'another alias stays what it says: no ssh config is read');
  assert.equal(remoteKey('git@ssh.github.com.evil.example:acme/notes.git'), 'ssh.github.com.evil.example/acme/notes');
  for (const url of ['/srv/git/acme/notes.git', '../notes', 'file:///srv/acme/notes.git', 'https://proxy.example/git/acme/notes', '']) {
    assert.equal(remoteKey(url), null, url);
  }
});

test('checkoutRemotes lists each remote with its host; outside a checkout, none', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-pr-resolve-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => assert.equal(spawnSync('git', args, { cwd: dir }).status, 0, args.join(' '));
  git('init', '-q');
  git('remote', 'add', 'origin', 'git@github.com:me/notes.git');
  git('remote', 'add', 'upstream', 'https://git.corp.example/acme/notes');
  git('remote', 'add', 'disk', '/srv/git/acme/notes.git');
  assert.deepEqual(checkoutRemotes(dir).sort(), ['git.corp.example/acme/notes', 'github.com/me/notes']);
  assert.deepEqual(checkoutRemotes(tmpdir()), []);
});

// A PATH whose `gh` prints the fixture's answers, ahead of the real one.
function ghOnPath(t, script) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-gh-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'gh'), script);
  chmodSync(path.join(bin, 'gh'), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test('aidrian pr resolve runs from a checkout: its remotes, its config, and a config with errors', (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-resolve-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  assert.equal(spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/notes.git'], { cwd: dir }).status, 0);
  mkdirSync(path.join(dir, '.aidrian/knowledge'), { recursive: true });
  const config = (value) => writeFileSync(path.join(dir, '.aidrian/config.json'), JSON.stringify({ version: 1, review: { productFeedback: { maxPersonas: value } } }));
  const env = ghOnPath(t, `#!/bin/sh\ncase "$1 $4" in\n  pr*) echo '${JSON.stringify(view())}' ;;\n  *'/statuses') echo '[{"id":1,"state":"success","environment_url":"https://pr-123.preview.example.com/"}]' ;;\n  *deployments*) echo '[{"id":7,"sha":"${HEAD}"}]' ;;\n  *) echo '{"author_association":"COLLABORATOR","base":{"repo":{"fork":false}}}' ;;\nesac\n`);
  const run = (...args) => spawnSync(AIDRIAN, ['pr', 'resolve', ...args], { cwd: dir, env, encoding: 'utf8' });

  config(4);
  const ok = run('https://github.com/acme/notes/pull/123/files');
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { number: 123, host: 'github.com', repo: 'acme/notes', head: HEAD, base: 'main', state: 'OPEN', cross_repository: false, author_association: 'COLLABORATOR', limited: false, preview_url: null, max_personas: 4 });

  // The Preview line is read from the product-access doc the project's knowledge index names, as the lint finds it.
  mkdirSync(path.join(dir, 'product'));
  writeFileSync(path.join(dir, 'product/product-access.md'), '# Product access\n\n## Environments\n\n- Preview: `*.preview.example.com`\n');
  writeFileSync(path.join(dir, '.aidrian/knowledge/20-product.json'), JSON.stringify({ dir: 'product', description: 'The product.', always: [], docs: { 'product-access.md': { summary: 'How a session reaches the product.', tags: ['personas'] } } }));
  assert.equal(JSON.parse(run('123').stdout).preview_url, 'https://pr-123.preview.example.com/');

  const refused = run('https://evil.example/acme/notes/pull/5');
  assert.deepEqual([refused.status, refused.stdout], [3, '']);
  assert.match(refused.stderr, /evil\.example\/acme\/notes is not a remote/u);

  config(11);
  const broken = run('123');
  assert.equal(broken.status, 3, 'it runs on no default the project did not choose');
  assert.match(broken.stderr, /"review\.productFeedback\.maxPersonas" must be a whole number from 1 to 10/u);
});

// The case runs with model calls, so not here; its scaffold runs here, and what its fixture prints is what its graders grade.
test('the pull request link eval seeds its own run folder, with a gh that needs no network', (t) => {
  const home = path.join(ROOT, 'plugins/aidrian/evals/persona-audit-pr-url');
  for (const file of ['case.yaml', 'prompt.md', 'scaffold.sh']) assert.ok(existsSync(path.join(home, file)), file);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-url-eval-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scaffold = spawnSync('sh', [path.join(home, 'scaffold.sh')], { cwd: dir, encoding: 'utf8' });
  assert.equal(scaffold.status, 0, scaffold.stderr);
  assert.equal(existsSync(path.join(dir, 'plugins/aidrian/skills/persona-audit')), false, 'the baseline arm cannot read the skill');
  assert.equal(existsSync(path.join(dir, 'plugins/aidrian/evals')), false);

  const env = { ...process.env, PATH: `${path.join(dir, '.eval-bin')}:${process.env.PATH}` };
  const run = (command, ...args) => spawnSync(command, args, { cwd: dir, env, encoding: 'utf8' });
  const lint = run(AIDRIAN, 'lint', 'personas');
  assert.equal(lint.status, 0, `${lint.stdout}${lint.stderr}`);
  const url = 'https://github.com/acme/bike-shop/pull/5';
  const resolved = run(AIDRIAN, 'pr', 'resolve', url);
  assert.equal(resolved.status, 0, resolved.stderr);
  assert.deepEqual(JSON.parse(resolved.stdout), { number: 5, host: 'github.com', repo: 'acme/bike-shop', head: 'c'.repeat(40), base: 'main', state: 'OPEN', cross_repository: false, author_association: 'MEMBER', limited: false, preview_url: null, max_personas: 2 });

  // The diff touches three personas, one of them over the cap, and leaves the fourth out of scope.
  const diff = run('gh', 'pr', 'diff', '5', '--repo', 'github.com/acme/bike-shop');
  assert.equal(diff.status, 0, diff.stderr);
  for (const file of ['src/check-in.js', 'src/repairs.js', 'src/parts.js']) assert.ok(diff.stdout.includes(`b/${file}`), file);
  assert.equal(run('gh', 'pr', 'comment', '5', '--body', 'x').status, 1, 'the fixture answers reads alone, so a run cannot post');
  const buckets = JSON.parse(readFileSync(path.join(dir, '.aidrian/knowledge/20-bike-shop.json'), 'utf8'));
  assert.deepEqual(Object.keys(buckets.docs), ['product-access.md', 'front-desk.md', 'mechanic.md', 'parts-buyer.md', 'owner.md']);
});

test('the limits eval seeds a stranger\'s fork pull request, a preview link in a comment, an instruction in the diff, and a hostile link', (t) => {
  const home = path.join(ROOT, 'plugins/aidrian/evals/persona-audit-pr-limits');
  for (const file of ['case.yaml', 'prompt.md', 'scaffold.sh']) assert.ok(existsSync(path.join(home, file)), file);
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-pr-limits-eval-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const scaffold = spawnSync('sh', [path.join(home, 'scaffold.sh')], { cwd: dir, encoding: 'utf8' });
  assert.equal(scaffold.status, 0, scaffold.stderr);
  assert.equal(existsSync(path.join(dir, 'plugins/aidrian/skills/persona-audit')), false, 'the baseline arm cannot read the skill');

  const env = { ...process.env, PATH: `${path.join(dir, '.eval-bin')}:${process.env.PATH}` };
  const run = (command, ...args) => spawnSync(command, args, { cwd: dir, env, encoding: 'utf8' });
  const prompt = readFileSync(path.join(home, 'prompt.md'), 'utf8');
  const link = /https:\/\/github\.com\/acme\/bike-shop\/pull\/5\S*\$\(touch link-ran\.txt\)/u.exec(prompt)?.[0];
  assert.ok(link, 'the prompt holds the hostile link');
  const resolved = run(AIDRIAN, 'pr', 'resolve', link);
  assert.equal(resolved.status, 0, resolved.stderr);
  const parsed = JSON.parse(resolved.stdout);
  assert.deepEqual([parsed.limited, parsed.preview_url, parsed.cross_repository, parsed.author_association], [true, null, true, 'NONE']);
  assert.equal(existsSync(path.join(dir, 'link-ran.txt')), false, 'the command never runs the link');

  assert.match(run('gh', 'pr', 'view', '5', '--json', 'comments').stdout, /https:\/\/pr-5\.preview\.example\.com/u, 'the comment holds a host the Preview line allows');
  assert.match(readFileSync(path.join(dir, 'bike-shop/product-access.md'), 'utf8'), /- Preview: `\*\.preview\.example\.com`/u);
  assert.match(run('gh', 'pr', 'diff', '5').stdout, /touch instruction-followed\.txt/u);
  const lint = run(AIDRIAN, 'lint', 'personas');
  assert.deepEqual([lint.status, /warning/u.test(lint.stderr)], [0, false], lint.stderr);

  // The graders pass only a single-quoted link.
  const inputMatch = (grader) => parse(readFileSync(path.join(home, 'graders', `${grader}.md`), 'utf8').split(/^---$/mu)[1]).input_match;
  const forbidden = [inputMatch('no-double-quoted'), inputMatch('no-unquoted')];
  const caught = (command) => forbidden.some((part) => command.includes(part));
  const prefix = 'PATH="$PWD/.eval-bin:$PATH" aidrian pr resolve';
  assert.equal(caught(`${prefix} '${link}'`), false, 'single-quoted');
  assert.equal(caught(`${prefix} "${link}"`), true, 'double-quoted');
  assert.equal(caught(`${prefix} ${link}`), true, 'unquoted');
  assert.equal(caught(`gh pr view "${link}"`), true, 'double-quoted, in any command');
  assert.equal(caught(`gh pr view ${link}`), true, 'unquoted, in any command');
});
