// The review record is read from `state.dir`, so every command that reads it at a pull request's head checkout holds the
// working copy's value to the base branch's, as auto-merge does, and the review step reads `review.record` as the base
// branch commits it. docs/review.md#the-record describes it.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { isWithin } from '../plugins/aidrian/lib/fs.mjs';
import { DEFAULT_REVIEWER } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt, stateDir } from '../plugins/aidrian/lib/project.mjs';
import { runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { runAttest, runIngest, runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
import { baseProblem, holdToBase, insideCheckout, recourse } from '../plugins/aidrian/lib/review/in-force.mjs';
import { runRequest } from '../plugins/aidrian/lib/review/pending.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { emptyState, readLocalState, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { runWaive } from '../plugins/aidrian/lib/review/waiver.mjs';
import { check, judgeMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

const DIFFERS = /the working copy's state\.dir differs from o\/r main, and the review record is read from it/u;
const HEAD_RECORD = 'head-state/reviews/pr-7-review.json';
const HOOK = path.join(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
const CLI = path.join(import.meta.dirname, '../plugins/aidrian/bin/aidrian');
const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });

// A temporary folder that goes when the test ends, by its real path.
const folderFor = (t) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-dir-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A config whose state folder lies beside the checkout: outside every checkout, and unique to the test.
const TEAM = { version: 1, state: { dir: '../state' } };
// One whose state folder lies inside the checkout.
const INSIDE_TEAM = { version: 1, state: { dir: 'state' } };

// A repository at `<root>/<name>` with `main` carrying `baseConfig` and `baseFiles`, checked out on a `feat` branch that
// commits `headConfig`, `files`, `links` (name to target), and a code change. GitHub is faked in memory. Either config null
// writes none; a function is given the repository's folder.
function repo(t, { baseConfig, headConfig, files = {}, baseFiles = {}, links = {}, name = 'repo' }) {
  const root = folderFor(t);
  const dir = path.join(root, name);
  mkdirSync(dir);
  const given = (config) => (typeof config === 'function' ? config(dir) : config);
  const git = (...args) => {
    const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'Tester');
  if (baseConfig) write('.aidrian/config.json', JSON.stringify(given(baseConfig)));
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  write('src/app.js', 'export const app = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  write('src/app.js', 'export const app = 2;\n');
  if (headConfig) write('.aidrian/config.json', JSON.stringify(given(headConfig)));
  for (const [file, text] of Object.entries(files)) write(file, text);
  for (const [name, target] of Object.entries(links)) symlinkSync(target, path.join(dir, name));
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  const comments = [];
  const forge = {
    change: () => ({ number: 7, headRefOid: head, baseRefName: 'main', url: 'https://github.com/o/r/pull/7' }),
    repo: () => 'o/r',
    pull: () => ({ draft: false, base: { ref: 'main' }, head: { sha: head } }),
    conversationComments: () => comments,
    postComment: (_repo, _n, body) => comments.push({ id: comments.length + 1, body, author_association: 'MEMBER' }),
    editComment: (_repo, id, body) => (comments.find((c) => c.id === id).body = body),
  };
  const project = projectAt(dir);
  const config = loadConfig(project).config;
  const step = () => reviewStep({ pr: '7' }, { project, config, forge, codex: () => ({ ok: true }), exec: clean });
  return { root, dir, git, head, forge, comments, project, config, step };
}

// A checkout whose config.json names another state.dir than the base branch's, with a well-formed record in its folder.
function moved(t) {
  const record = { ...emptyState(7, 'o/r'), revision: 5, overrides: ['OTHER-OVERRIDE'] };
  return repo(t, {
    baseConfig: { version: 1, state: { dir: 'state' } },
    headConfig: { version: 1, state: { dir: 'head-state' } },
    files: { [HEAD_RECORD]: `${JSON.stringify(record)}\n` },
  });
}

const quiet = (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
};

test('stateDirProblem words the difference, with the record named, and is exported beside the committed config', async () => {
  const fromCommitted = await import('../plugins/aidrian/lib/config-committed.mjs');
  const fromConfig = await import('../plugins/aidrian/lib/config.mjs');
  assert.equal(fromConfig.stateDirProblem, fromCommitted.stateDirProblem);
  const { stateDirProblem } = fromCommitted;
  const at = (dir) => ({ state: { dir } });
  assert.equal(stateDirProblem(at('a'), at('a'), 'o/r main'), null);
  assert.equal(stateDirProblem(at(null), at(null), 'o/r main'), null);
  assert.equal(stateDirProblem(at('a'), at(null), 'o/r main'), "the working copy's state.dir differs from o/r main, and the review record is read from it");
  assert.equal(stateDirProblem(at('a'), at('b'), "the default branch's", 'the record'), "the working copy's state.dir differs from the default branch's, and the record is read from it");
});

test('the review step refuses a checkout whose state.dir differs from the base branch\'s, before it reads or writes a record', async (t) => {
  const r = moved(t);
  const before = readFileSync(path.join(r.dir, HEAD_RECORD), 'utf8');
  await assert.rejects(r.step(), DIFFERS);
  assert.equal(r.comments.length, 0);
  assert.equal(readFileSync(path.join(r.dir, HEAD_RECORD), 'utf8'), before, 'no error outcome is written');
});

test('the review step takes review.record from the base branch, not the head', async (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1, review: { record: 'local' } } });
  const result = await r.step();
  assert.equal(result.status, 'received');
  assert.equal(r.comments.length, 1, 'the base branch commits no local record, so the step posts its summary');
});

test('a base branch that commits review.record local keeps the step off the pull request when the head commits comment', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, headConfig: { version: 1, review: { record: 'comment' } } });
  assert.equal((await r.step()).status, 'received');
  assert.equal(r.comments.length, 0);
});

test('a head and a base with the same state.dir run the step as before', async (t) => {
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  assert.equal((await r.step()).status, 'received');
  assert.equal(r.comments.length, 1);
  assert.ok(existsSync(path.join(r.root, 'state/reviews/pr-7-review.json')));
});

test('each record command refuses the same checkout when the forge names the base', async (t) => {
  const r = moved(t);
  quiet(t);
  const { project, config, forge, head } = r;
  await assert.rejects(runExtend(['7', '--verdict', 'stop', '--reason', 'why'], project, config, { forge, repo: 'o/r' }), DIFFERS, 'extend');
  await assert.rejects(runWaive(['7', '--verdict', 'refuse', '--reason', 'why'], project, config, { forge, repo: 'o/r' }), DIFFERS, 'waive');
  await assert.rejects(runSignoff(['7', '--last'], project, config, { forge }), DIFFERS, 'signoff --last');
  await assert.rejects(runSignoff(['7', '--flow', 'f', '--head', head], project, config, { forge }), DIFFERS, 'signoff, long form');
  await assert.rejects(runAttest(['7', '--pass', 'p', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], project, config, { forge }), DIFFERS, 'attest --pass');
  await assert.rejects(runAttest(['7', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], project, config, { forge }), DIFFERS, 'attest');
  assert.equal(readLocalState(project, 7).revision, 5, 'none of them wrote to the record');
});

test('await-review --request refuses the same checkout before it reads the record', async (t) => {
  const r = moved(t);
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(line));
  t.mock.method(console, 'log', () => {});
  assert.equal(await runAwaitReview(['7', '--request'], r.config, r.project, { forge: r.forge, env: {} }), 1);
  assert.match(errors.join('\n'), DIFFERS);
});

test('offline, attest and signoff keep their stated limit: this machine\'s record, with nothing published', async (t) => {
  const r = moved(t);
  quiet(t);
  const offline = { change: () => { throw new Error('offline'); } };
  const { project, head } = r;
  const local = { ...r.config, review: { ...r.config.review, record: 'local' } };
  assert.equal(await runAttest(['7', '--pass', 'p', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0', '--repo', 'o/r'], project, local, { forge: offline }), 0);
  assert.deepEqual(Object.keys(readLocalState(project, 7).passes), ['p']);
  assert.equal(await runAttest(['7', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0', '--repo', 'o/r'], project, local, { forge: offline }), 0);
  await assert.rejects(runSignoff(['7', '--flow', 'f', '--head', head, '--repo', 'o/r'], project, local, { forge: offline }), /no review of o\/r#7 ran on/u, 'the sign-off reaches the record');
});

test('a forge that names no base keeps a record command on the path it had', async (t) => {
  const r = moved(t);
  quiet(t);
  const unnamed = { change: () => ({ url: 'https://github.com/o/r/pull/7' }) };
  const local = { ...r.config, review: { ...r.config.review, record: 'local' } };
  assert.equal(await runAttest(['7', '--pass', 'p', '--head', r.head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, local, { forge: unnamed }), 0);
});

test('holdToBase names a base no ref resolves, and returns the base tip and its committed config', async (t) => {
  const { holdToBase } = await import('../plugins/aidrian/lib/review/in-force.mjs');
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'gone' }), /^Error: the base branch gone is not in this checkout: git fetch first$/u);
  const { baseTip, committed } = holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' });
  assert.equal(baseTip, r.git('rev-parse', 'main'));
  assert.equal(committed.state.dir, '../state');
  assert.throws(() => holdToBase(moved(t).project, null, { repo: 'o/r', base: 'main' }), DIFFERS, 'no config given: it loads the working copy\'s');
});

// ---- the base branch's tip

test('the base tip is read by full ref name', (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 } });
  const mainTip = r.git('rev-parse', 'main');
  r.git('update-ref', 'refs/remotes/origin/main', mainTip);
  r.git('branch', 'origin/main', 'feat');
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).baseTip, mainTip);
});

test('a base only a tag names is not in this checkout', (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 } });
  r.git('branch', '-m', 'main', 'trunk');
  r.git('tag', 'main', 'feat');
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /the base branch main is not in this checkout/u);
});

// ---- the project folder

const pointer = (dir) => JSON.stringify({ dir });

test('a working copy whose project folder differs from the base branch\'s is refused, before any record read', async (t) => {
  const r = repo(t, {
    baseConfig: { version: 1 },
    headConfig: { version: 1 },
    files: { '.aidrian.json': pointer('other'), 'other/config.json': JSON.stringify({ version: 1 }) },
  });
  await assert.rejects(r.step(), /^Error: the working copy's project folder differs from o\/r main, and the review record is read from it$/u);
  assert.equal(r.comments.length, 0);
});

test('a head that relocates the project folder is refused before the plan, so the base branch\'s flows stay in force', async (t) => {
  const flows = { booking: { files: ['src/**'], invariants: 'docs/flows/booking.md' } };
  const r = repo(t, {
    baseConfig: { version: 1, review: { flows } },
    headConfig: null,
    baseFiles: { 'docs/flows/booking.md': '# Booking\n\n## No double booking\nTwo bookings never hold one slot.\n' },
    files: { '.aidrian.json': pointer('other'), 'other/config.json': JSON.stringify({ version: 1 }) },
  });
  let ran = 0;
  const project = projectAt(r.dir);
  const step = reviewStep({ pr: '7' }, { project, config: loadConfig(project).config, forge: r.forge, codex: () => ({ ok: true }), exec: async () => (ran += 1, { status: 'done', findings: [], verdicts: [], dropped: [] }) });
  await assert.rejects(step, /project folder differs from o\/r main/u);
  assert.deepEqual([ran, r.comments.length, readLocalState(project, 7)], [0, 0, null]);
});

test('a base branch whose pointer file cannot be read refuses the working copy', (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 }, baseFiles: { '.aidrian.json': 'not json' }, files: { '.aidrian.json': pointer('.aidrian') } });
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /project folder differs from o\/r main/u);
});

test('the same relocated project folder on both sides is held by its own config', (t) => {
  const at = (dir) => JSON.stringify({ version: 1, state: { dir } });
  const same = repo(t, { baseConfig: null, headConfig: null, baseFiles: { '.aidrian.json': pointer('cfg'), 'cfg/config.json': at('../state') } });
  assert.equal(holdToBase(same.project, same.config, { repo: 'o/r', base: 'main' }).committed.state.dir, '../state');
  const other = repo(t, { baseConfig: null, headConfig: null, baseFiles: { '.aidrian.json': pointer('cfg'), 'cfg/config.json': at('../state') }, files: { 'cfg/config.json': at('../elsewhere') } });
  assert.throws(() => holdToBase(other.project, other.config, { repo: 'o/r', base: 'main' }), DIFFERS);
});

test('a pull request that adopts aidrian is held to a base with no config at all', (t) => {
  const r = repo(t, { baseConfig: null, headConfig: null, files: { '.aidrian.json': pointer('other'), 'other/config.json': JSON.stringify({ version: 1 }) } });
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, null);
});

// ---- a state folder inside a checkout of this repository

const tracking = (r) => {
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'main'));
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
};
const unused = () => assert.fail('the merge names its head: no view');

// A project at a new linked worktree of `r`, detached at `commit`, and the hold from there.
function linkedAt(t, r, commit) {
  const worktree = path.join(folderFor(t), 'worktree');
  r.git('worktree', 'add', '-q', '--detach', worktree, commit);
  const project = projectAt(worktree);
  const config = loadConfig(project).config;
  return { project, config, hold: () => holdToBase(project, config, { repo: 'o/r', base: 'main' }) };
}

// The refusal for a state folder in the checkout `top`, and the merge guard's denial with it.
const insideText = (top) => `the state folder is inside this repository's checkout ${top}, and the review record is read from it: in .aidrian/config.json, set "state": { "dir": null } for the default folder, or any folder outside every checkout of this repository, and commit that change alone in its own pull request, which gets no local review record, so the Human merges it. Once it lands, on each machine, from a clean checkout on the base branch, move the old folder's contents to the folder \`aidrian state\` prints.`;
const insideDenial = (top) => `Blocked: this merges pull request #7, but ${insideText(top).slice(0, -1)}. Move the state folder first; until that lands, the Human merges in their own shell.`;
const UNLISTED = "git cannot list this repository's checkouts, and the review record is read from it";

// The refusal for a checkout at the folder the records go in, and the merge guard's denial with it.
const recordsText = (records) => `the folder the review records go in is a checkout, ${records}, and the review record is read from it: move or remove that checkout on this machine, so only this machine's records stay there.`;
const recordsDenial = (records) => `Blocked: this merges pull request #7, but ${recordsText(records).slice(0, -1)}. Move that checkout first; until it is gone, the Human merges in their own shell.`;

// A repository with `state.dir` set, or unset under a temporary state home, and its state folder, which lies outside the checkout.
const stateSet = (t) => {
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  return { r, state: path.join(r.root, 'state') };
};
const stateUnset = (t) => {
  const home = process.env.XDG_STATE_HOME;
  t.after(() => (home === undefined ? delete process.env.XDG_STATE_HOME : (process.env.XDG_STATE_HOME = home)));
  process.env.XDG_STATE_HOME = folderFor(t);
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 } });
  return { r, state: stateDir(r.project) };
};
const eachState = [['state.dir set', stateSet], ['state.dir unset', stateUnset]];

const refused = (r, top) => assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), { message: insideText(top) });
const allowed = (r, dir) => assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, dir);

test('a state folder inside the checkout is refused, and the message names the checkout, the config move with null first, its own pull request the Human merges, and the move of the old folder', async (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  await assert.rejects(r.step(), { message: insideText(r.dir) });
  assert.equal(r.comments.length, 0);
  assert.equal(readLocalState(r.project, 7), null, 'no error outcome is written');
  for (const dir of ['.', 'a/b/state', '.aidrian', 'src/../state']) {
    const team = { version: 1, state: { dir } };
    const each = repo(t, { baseConfig: team, headConfig: team });
    refused(each, each.dir);
  }
  const absolute = (dir) => ({ version: 1, state: { dir: path.join(dir, 'state') } });
  const named = repo(t, { baseConfig: absolute, headConfig: absolute });
  refused(named, named.dir);
});

test('each record command refuses a state folder inside the checkout when the forge names the base', async (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  quiet(t);
  const { project, config, forge, head } = r;
  const inside = { message: insideText(r.dir) };
  writeFileSync(path.join(r.dir, 'shot.png'), 'x');
  await assert.rejects(runExtend(['7', '--verdict', 'stop', '--reason', 'why'], project, config, { forge, repo: 'o/r' }), inside, 'extend');
  await assert.rejects(runWaive(['7', '--verdict', 'refuse', '--reason', 'why'], project, config, { forge, repo: 'o/r' }), inside, 'waive');
  await assert.rejects(runSignoff(['7', '--last'], project, config, { forge }), inside, 'signoff --last');
  await assert.rejects(runSignoff(['7', '--flow', 'f', '--head', head], project, config, { forge }), inside, 'signoff, long form');
  await assert.rejects(runAttest(['7', '--pass', 'p', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], project, config, { forge }), inside, 'attest --pass');
  await assert.rejects(runAttest(['7', '--head', head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], project, config, { forge }), inside, 'attest');
  await assert.rejects(runIngest(['7', '--head', head, '--source', 'run 12', 'shot.png'], project, config, { forge, env: {} }), inside, 'ingest');
  assert.throws(() => runRequest(['7'], project, { forge }), inside, 'request');
  assert.equal(readLocalState(project, 7), null, 'none of them wrote a record');
  t.mock.restoreAll();
  const errors = [];
  t.mock.method(console, 'error', (line) => errors.push(line));
  t.mock.method(console, 'log', () => {});
  assert.equal(await runAwaitReview(['7', '--request'], config, project, { forge, env: {} }), 1, 'await-review --request');
  assert.ok(errors.join('\n').includes(insideText(r.dir)));
});

test('a state folder under the git folder is inside the checkout', (t) => {
  for (const dir of ['.git/state', '.git/worktrees/other/state']) {
    const team = { version: 1, state: { dir } };
    const r = repo(t, { baseConfig: team, headConfig: team });
    refused(r, r.dir);
  }
});

test('a state folder that does not exist yet is compared at its nearest existing parent', (t) => {
  const team = { version: 1, state: { dir: 'not/yet/here' } };
  const plain = repo(t, { baseConfig: team, headConfig: team });
  assert.equal(existsSync(path.join(plain.dir, 'not')), false);
  refused(plain, plain.dir);
  // Named outside, through a link into the checkout that does exist.
  const alias = path.join(folderFor(t), 'alias');
  const named = { version: 1, state: { dir: path.join(alias, 'not/yet/here') } };
  const through = repo(t, { baseConfig: named, headConfig: named });
  symlinkSync(through.dir, alias);
  refused(through, through.dir);
});

test('a link on the state folder\'s path into the checkout is refused, named outside or inside', (t) => {
  const outside = folderFor(t);
  // Named outside, with the link leading in: allowed until the link is there.
  const alias = path.join(outside, 'alias');
  const team = { version: 1, state: { dir: path.join(alias, 'state') } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  allowed(r, team.state.dir);
  symlinkSync(r.dir, alias);
  refused(r, r.dir);
  // Named inside, with the link leading out: in the checkout and from a linked worktree.
  mkdirSync(path.join(outside, 'state'));
  for (const [dir, link] of [['state', 'state'], ['shared/state', 'shared']]) {
    const inside = { version: 1, state: { dir } };
    const each = repo(t, { baseConfig: inside, headConfig: inside, links: { [link]: outside } });
    refused(each, each.dir);
    assert.throws(linkedAt(t, each, 'main').hold, { message: insideText(each.dir) }, `from a linked worktree, at ${dir}`);
  }
  // A broken link at the folder: named inside, from a linked worktree too.
  const broken = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM, links: { state: 'gone' } });
  refused(broken, broken.dir);
  assert.throws(linkedAt(t, broken, 'main').hold, { message: insideText(broken.dir) });
});

test('a linked worktree reached through a link is compared where it is', (t) => {
  const outside = folderFor(t);
  mkdirSync(path.join(outside, 'real'));
  symlinkSync(path.join(outside, 'real'), path.join(outside, 'alias'));
  const team = { version: 1, state: { dir: path.join(outside, 'alias/tree/state') } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  allowed(r, team.state.dir);
  r.git('worktree', 'add', '-q', '--detach', path.join(outside, 'alias/tree'), 'main');
  refused(r, path.join(outside, 'real/tree'));
});

// Whether this disk reads a name in another case as the same file.
const caseSensitiveDisk = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-case-'));
  writeFileSync(path.join(dir, 'probe'), '');
  const sensitive = !existsSync(path.join(dir, 'PROBE'));
  rmSync(dir, { recursive: true, force: true });
  return sensitive;
})();

test('a state folder named in another case than the checkout is refused', { skip: caseSensitiveDisk }, (t) => {
  const shouted = (dir) => ({ version: 1, state: { dir: path.join(dir.toUpperCase(), 'state') } });
  const r = repo(t, { baseConfig: shouted, headConfig: shouted });
  refused(r, r.dir);
});

test('a state folder behind a broken link is compared as named, in any case or Unicode form', (t) => {
  const shouted = (dir) => ({ version: 1, state: { dir: path.join(dir.toUpperCase(), 'broken/state') } });
  const loud = repo(t, { baseConfig: shouted, headConfig: shouted, links: { broken: 'gone' } });
  refused(loud, loud.dir);
  const decomposed = (dir) => ({ version: 1, state: { dir: path.join(dir.normalize('NFD'), 'broken/state') } });
  const accent = repo(t, { baseConfig: decomposed, headConfig: decomposed, links: { broken: 'gone' }, name: 'café' });
  refused(accent, accent.dir);
});

test('a broken link on the path of a state folder outside the checkout is allowed', (t) => {
  const outside = folderFor(t);
  symlinkSync(path.join(outside, 'gone'), path.join(outside, 'broken'));
  const team = { version: 1, state: { dir: path.join(outside, 'broken/state') } };
  allowed(repo(t, { baseConfig: team, headConfig: team }), team.state.dir);
});

test('a state folder beside the repository is allowed', (t) => {
  const outside = folderFor(t);
  const team = { version: 1, state: { dir: outside } };
  allowed(repo(t, { baseConfig: team, headConfig: team }), outside);
  allowed(repo(t, { baseConfig: TEAM, headConfig: TEAM }), '../state');
});

test('a relative state.dir from a linked worktree lies in the main checkout and is refused there', async (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  tracking(r);
  const linked = linkedAt(t, r, 'main');
  assert.throws(linked.hold, { message: insideText(r.dir) });
  const step = reviewStep({ pr: '7' }, { project: linked.project, config: linked.config, forge: r.forge, codex: () => ({ ok: true }), exec: clean });
  await assert.rejects(step, { message: insideText(r.dir) });
  assert.equal(r.comments.length, 0);
  assert.equal(judgeMerge({ project: linked.project, pr: 7, head: r.head, viewPr: unused }), insideDenial(r.dir));
});

test('a state folder inside a linked worktree is refused from the main checkout', (t) => {
  const tree = path.join(folderFor(t), 'tree');
  const team = { version: 1, state: { dir: path.join(tree, 'state') } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  allowed(r, team.state.dir);
  r.git('worktree', 'add', '-q', '--detach', tree, 'main');
  refused(r, tree);
  // A worktree whose folder is gone holds no checkout, listed or not.
  rmSync(tree, { recursive: true, force: true });
  assert.match(r.git('worktree', 'list', '--porcelain'), new RegExp(`^worktree ${tree}$`, 'mu'));
  allowed(r, team.state.dir);
});

test('a state folder outside every checkout is allowed, inside an outer repository that tracks this checkout too', async (t) => {
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  tracking(r);
  const outer = (...args) => execFileSync('git', ['-C', r.root, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  outer('init', '-q', '-b', 'main');
  mkdirSync(path.join(r.root, 'state/reviews'), { recursive: true });
  writeFileSync(path.join(r.root, 'state/reviews/pr-7-review.json'), `${JSON.stringify(emptyState(7, 'o/r'))}\n`);
  outer('add', 'repo', 'state');
  outer('commit', '-q', '-m', 'outer');
  allowed(r, '../state');
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
  assert.equal((await r.step()).status, 'received');
  // The folder inside this checkout is refused, with an outer repository around it or not.
  const inside = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  execFileSync('git', ['-C', inside.root, 'init', '-q', '-b', 'main']);
  refused(inside, inside.dir);
});

test('a state folder that is its own repository, outside the checkout, is allowed', (t) => {
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  tracking(r);
  mkdirSync(path.join(r.root, 'state'));
  const own = (...args) => execFileSync('git', ['-C', path.join(r.root, 'state'), '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', ...args], { encoding: 'utf8' });
  own('init', '-q', '-b', 'main');
  writeFileSync(path.join(r.root, 'state/keep.txt'), 'x\n');
  own('add', 'keep.txt');
  own('commit', '-q', '-m', 'one');
  allowed(r, '../state');
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
});

// A repository at <root>/repo whose git folder lies at <root>/gitdir, with a config that names `dir`, given <root> when a function.
function separateGitDir(t, dir) {
  const root = folderFor(t);
  const top = path.join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', '--separate-git-dir', path.join(root, 'gitdir'), top]);
  const git = (...args) => execFileSync('git', ['-C', top, '-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', ...args], { encoding: 'utf8' });
  const value = typeof dir === 'function' ? dir(root) : dir;
  mkdirSync(path.join(top, '.aidrian'));
  writeFileSync(path.join(top, '.aidrian/config.json'), JSON.stringify({ version: 1, state: { dir: value } }));
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const project = projectAt(top);
  return { root, top, git, value, project, config: loadConfig(project).config };
}

test('a state folder inside a separate git dir, outside the checkout, is allowed', (t) => {
  allowed(separateGitDir(t, '../gitdir/state'), '../gitdir/state');
  // By its full path, from the checkout and from a linked worktree.
  const full = separateGitDir(t, (root) => path.join(root, 'gitdir/state'));
  allowed(full, full.value);
  full.git('worktree', 'add', '-q', '--detach', path.join(full.root, 'linked'), 'main');
  const project = projectAt(path.join(full.root, 'linked'));
  assert.equal(holdToBase(project, loadConfig(project).config, { repo: 'o/r', base: 'main' }).committed.state.dir, full.value);
});

test('a state folder inside the checkout of a separate git dir is refused', (t) => {
  const r = separateGitDir(t, 'state');
  refused(r, r.top);
});

test('the folder of a bare repository is no checkout, so a state folder there is allowed from its linked worktree', (t) => {
  const absolute = (dir) => ({ version: 1, state: { dir: path.join(dir, 'state') } });
  const r = repo(t, { baseConfig: absolute, headConfig: absolute });
  r.git('switch', '-q', 'main');
  const linked = linkedAt(t, r, 'main');
  r.git('config', 'core.bare', 'true');
  assert.equal(linked.hold().committed.state.dir, path.join(r.dir, 'state'));
});

test('a null state.dir clears the refusal in every shape, with no list of the checkouts', (t) => {
  for (const team of [{ version: 1 }, { version: 1, state: { dir: null } }]) {
    const r = repo(t, { baseConfig: team, headConfig: team, files: { 'state/keep.txt': 'x\n' } });
    tracking(r);
    const calls = gitCalls(t, () => assert.deepEqual(insideCheckout(r.project, r.config, () => ({})), { problem: null }));
    assert.deepEqual(calls.filter((call) => call.includes(' worktree list ')), []);
    allowed(r, null);
    assert.equal(linkedAt(t, r, 'main').hold().committed.state.dir, null);
    assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
  }
});

// ---- the merge guard

test('the merge guard denies a state folder inside the checkout and says to move it first, the Human merging until then', (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  tracking(r);
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), insideDenial(r.dir));
  assert.equal(readLocalState(r.project, 7), null, 'the hold applies with no record');
  const answers = [{ question: `Merge pull request #7 at ${r.head.slice(0, 7)} before its review is finished?`, answer: 'Merge anyway', at: null }];
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused, answers }), insideDenial(r.dir), 'the answer does not waive it');
  assert.equal(check(`gh pr merge 7 --match-head-commit ${r.head}`, { cwd: r.dir, env: {}, viewPr: unused }), insideDenial(r.dir), 'the Bash rule reaches it');
  assert.equal(recourse('anything else'), 'Merge from a checkout on the base branch, or the Human merges in their own shell.');
});

test('on the pull request that moves the folder out, neither checkout sends a session back', async (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: { version: 1 } });
  tracking(r);
  // The head differs from the base, and sends the session to a checkout on the base branch.
  await assert.rejects(r.step(), DIFFERS);
  assert.match(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), /state\.dir differs from .*\. Merge from a checkout on the base branch, or the Human merges in their own shell\.$/u);
  // That checkout says the Human merges.
  const base = linkedAt(t, r, 'main');
  assert.throws(base.hold, { message: insideText(r.dir) });
  assert.equal(judgeMerge({ project: base.project, pr: 7, head: r.head, viewPr: unused }), insideDenial(r.dir));
});

test('the merge guard denies a checkout whose state.dir differs from the base branch\'s, even with a finished record there', (t) => {
  const r = repo(t, {
    baseConfig: { version: 1, state: { dir: 'state' } },
    headConfig: { version: 1, state: { dir: 'head-state' } },
  });
  tracking(r);
  writeLocalState(r.project, { ...emptyState(7, 'o/r'), outcome: { status: 'received', head: r.head, at: '2026-11-03T14:00:00.000Z' } });
  const reason = judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused });
  assert.match(reason, /the working copy's state\.dir differs from/u);
  assert.match(reason, /Merge from a checkout on the base branch, or the Human merges in their own shell/u);
  assert.match(check(`gh pr merge 7 --match-head-commit ${r.head}`, { cwd: r.dir, env: {}, viewPr: unused }), /state\.dir differs from/u, 'the Bash rule reaches it');
});

test('the merge guard denies the same checkout with no record to read there', (t) => {
  const r = moved(t);
  rmSync(path.join(r.dir, HEAD_RECORD));
  tracking(r);
  assert.match(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), /state\.dir differs from/u);
});

test('the merge guard holds to the base a view names, before it reads the record the view found', (t) => {
  const r = moved(t);
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'main'));
  const viewPr = () => ({ number: 7, headRefOid: r.head, baseRefName: 'main' });
  assert.match(judgeMerge({ project: r.project, viewPr }), /state\.dir differs from \S+ main/u);
});

test('the merge guard denies a project folder the base branch does not name', (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 }, files: { '.aidrian.json': pointer('other'), 'other/config.json': JSON.stringify({ version: 1 }) } });
  tracking(r);
  assert.match(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), /project folder differs from/u);
});

test('the merge guard denies a working tree that replaces the base branch\'s project folder with a link', (t) => {
  const at = JSON.stringify({ version: 1, state: { dir: 'state' } });
  const r = repo(t, { baseConfig: null, headConfig: null, baseFiles: { '.aidrian.json': pointer('cfg'), 'cfg/config.json': at } });
  tracking(r);
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-cfg-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(path.join(outside, 'config.json'), JSON.stringify({ version: 1, state: { dir: 'head-state' } }));
  rmSync(path.join(r.dir, 'cfg'), { recursive: true });
  symlinkSync(outside, path.join(r.dir, 'cfg'));
  assert.match(judgeMerge({ project: projectAt(r.dir), pr: 7, head: r.head, viewPr: unused }), /project folder differs from/u);
});

test('the merge guard, with the same state.dir and no record, still allows', (t) => {
  const r = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  tracking(r);
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
});

test('the merge guard holds a merge of this checkout\'s repositories, and no other', (t) => {
  const r = moved(t);
  tracking(r);
  r.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
  r.git('remote', 'add', 'parent', 'https://github.com/up/stream.git');
  rmSync(path.join(r.dir, HEAD_RECORD));
  const merge = (repoName) => judgeMerge({ project: r.project, pr: 7, head: r.head, repo: repoName, viewPr: unused });
  assert.match(merge(null), /state\.dir differs from/u, 'no repository named');
  assert.match(merge('O/R'), /state\.dir differs from o\/r's default branch/u, 'its origin, in any case');
  assert.match(merge('up/stream'), /state\.dir differs from/u, 'another of its remotes');
  assert.equal(merge('someone/else'), null, 'a repository this checkout has no remote for');
});

// A `git` first on PATH for the rest of the test, that runs `act` on calls matching `match` and the real one on the rest.
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
function fakeGit(t, match, act) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-git-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase " $* " in ${match}) ${act};; esac\nexec "${REAL_GIT}" "$@"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH}`;
}

// The git calls `act` makes while a `git` that logs each one comes first on PATH, each as `line` prints it: by default
// `<working folder> <args>`.
function gitCalls(t, act, line = '"$(pwd -P)" "$*"') {
  const log = path.join(folderFor(t), 'git.log');
  const before = process.env.PATH;
  process.env.PATH = fakeGit(t, '*', `printf '%s %s\\n' ${line} >> "${log}"`);
  try {
    act();
  } finally {
    process.env.PATH = before;
  }
  return readFileSync(log, 'utf8').trim().split('\n');
}

test('a checkout list git cannot answer stops a command, and lets a merge go on', (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  tracking(r);
  const before = process.env.PATH;
  t.after(() => (process.env.PATH = before));
  const list = '*" worktree list "*';
  const lookup = '*" --git-common-dir "*';
  for (const [name, match, act] of [
    ['a failed list', list, 'exit 1'],
    ['an owner git refuses', list, 'echo "fatal: detected dubious ownership in repository" >&2; exit 128'],
    ['a list that was stopped', list, 'kill -9 $$'],
    ['a checkout lookup that fails', lookup, 'exit 1'],
    ['a checkout lookup that was stopped', lookup, 'kill -9 $$'],
  ]) {
    process.env.PATH = fakeGit(t, match, act);
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), { message: UNLISTED }, name);
    assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null, name);
  }
});

test('a checkout listed through a link is compared on disk', (t) => {
  const outside = folderFor(t);
  const tree = path.join(outside, 'tree');
  const team = { version: 1, state: { dir: path.join(tree, 'state') } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  r.git('worktree', 'add', '-q', '--detach', tree, 'main');
  symlinkSync(tree, path.join(outside, 'alias'));
  const before = process.env.PATH;
  t.after(() => (process.env.PATH = before));
  process.env.PATH = fakeGit(t, '*" worktree list "*', `printf 'worktree %s\\nHEAD x\\n\\n' "${path.join(outside, 'alias')}"; exit 0`);
  refused(r, path.join(outside, 'alias'));
});

test('a hold with no time left has no answer', (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  const late = () => {
    throw new Error('the hold has no time left');
  };
  assert.deepEqual(insideCheckout(r.project, r.config, late), { problem: UNLISTED, unread: true });
  let reads = 0;
  const lateAtTheList = () => {
    reads += 1;
    return reads > 1 ? late() : {};
  };
  assert.deepEqual(insideCheckout(r.project, r.config, lateAtTheList), { problem: UNLISTED, unread: true });
  const { r: unset } = stateUnset(t);
  assert.deepEqual(insideCheckout(unset.project, unset.config, late), { problem: UNLISTED, unread: true }, 'with state.dir unset');
});

test('the checkouts are listed from the project root, never from the state folder', (t) => {
  const r = repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM });
  tracking(r);
  // The state folder is a repository of its own, which git would answer for if it ran there.
  const state = path.join(r.dir, 'state');
  mkdirSync(state);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: state });
  const linked = linkedAt(t, r, 'main');
  const merge = (project) => judgeMerge({ project, pr: 7, head: r.head, viewPr: unused });
  let warned = '';
  const calls = gitCalls(t, () => {
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), { message: insideText(r.dir) });
    assert.throws(linked.hold, { message: insideText(r.dir) });
    assert.equal(merge(r.project), insideDenial(r.dir));
    assert.equal(merge(linked.project), insideDenial(r.dir));
    warned = spawnSync(CLI, ['check'], { cwd: r.dir, encoding: 'utf8', env: process.env }).stderr;
  });
  assert.ok(warned.includes(`warning: ${insideText(r.dir)}`), 'the check gave the same answer');
  const lists = calls.filter((call) => call.endsWith(' worktree list --porcelain'));
  assert.deepEqual(lists.map((call) => call.split(' ')[0]), [r.dir, linked.project.root, r.dir, linked.project.root, r.dir]);
  for (const call of calls) assert.equal(isWithin(state, call.split(' ')[0]), false, call);
});

test('every git read in the hold takes the caller\'s options', (t) => {
  const git = () => ({ env: { ...process.env, AIDRIAN_HOLD_READ: 'held' } });
  const reads = (r) => gitCalls(t, () => assert.equal(baseProblem(r.project, { repo: 'o/r', git }), null), '"${AIDRIAN_HOLD_READ:-unheld}" "$*"');
  const set = repo(t, { baseConfig: TEAM, headConfig: TEAM });
  tracking(set);
  const calls = reads(set);
  assert.ok(calls.some((call) => call.includes(' worktree list ')), 'the checkout list');
  assert.ok(calls.filter((call) => call.includes(' --git-common-dir ')).length >= 2, 'the main checkout lookup and this checkout\'s');
  for (const call of calls) assert.match(call, /^held /u);
  const { r: unset } = stateUnset(t);
  tracking(unset);
  const own = reads(unset);
  assert.ok(own.some((call) => call.includes(' --get remote.origin.url')), 'the origin the state folder is named by');
  assert.ok(own.some((call) => call.includes(' --git-common-dir ')), 'the main checkout the state folder is named by, with no origin');
  assert.ok(own.some((call) => call.includes(' --show-prefix')), 'the project\'s folder in the repository');
  for (const call of own) assert.match(call, /^held /u);
});

test('a checkout at the folder the records go in is refused', async (t) => {
  for (const [name, make] of eachState) {
    const { r, state } = make(t);
    tracking(r);
    const records = path.join(state, 'reviews');
    const refusal = { message: recordsText(records) };
    mkdirSync(state, { recursive: true });
    r.git('worktree', 'add', '-q', '--detach', records, 'main');
    const linked = linkedAt(t, r, 'main');
    let warned = '';
    const calls = gitCalls(t, () => {
      assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), refusal, name);
      assert.throws(linked.hold, refusal, name);
      assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), recordsDenial(records), name);
      assert.equal(judgeMerge({ project: linked.project, pr: 7, head: r.head, viewPr: unused }), recordsDenial(records), name);
      warned = spawnSync(CLI, ['check'], { cwd: r.dir, encoding: 'utf8', env: process.env }).stderr;
    });
    assert.ok(warned.includes(`warning: ${recordsText(records)}`), `${name}: the check gives the same answer`);
    for (const call of calls) assert.equal(isWithin(state, call.split(' ')[0]), false, `${name}: ${call}`);
    await assert.rejects(r.step(), refusal, name);
    assert.equal(r.comments.length, 0, name);

    // Gone, the folder is allowed again, and the other kinds of checkout there are refused the same.
    r.git('worktree', 'remove', '--force', records);
    assert.doesNotThrow(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), name);
    mkdirSync(records);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: records });
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), refusal, `${name}: a repository of its own`);
    rmSync(records, { recursive: true });
    symlinkSync(linked.project.root, records);
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), refusal, `${name}: through a link`);
  }
});

test('a folder the records go in that holds no checkout stays allowed, and so does a checkout elsewhere under the state folder', (t) => {
  for (const [name, make] of eachState) {
    const { r, state } = make(t);
    tracking(r);
    writeLocalState(r.project, emptyState(7, 'o/r'));
    assert.ok(existsSync(path.join(state, 'reviews', 'pr-7-review.json')), `${name}: the folder these tests name is the one the record goes in`);
    r.git('worktree', 'add', '-q', '--detach', path.join(state, 'trees', 'one'), 'main');
    r.git('worktree', 'add', '-q', '--detach', path.join(state, 'trees', 'reviews'), 'main');
    r.git('worktree', 'add', '-q', '--detach', path.join(state, 'reviews', 'pr-7'), 'main');
    assert.doesNotThrow(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), name);
    assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null, name);
    assert.deepEqual(insideCheckout(r.project, r.config, () => ({})), { problem: null }, name);
    const { stderr } = spawnSync(CLI, ['check'], { cwd: r.dir, encoding: 'utf8', env: process.env });
    assert.ok(!stderr.includes('records go in'), `${name}: ${stderr}`);
  }
});

test('a base pointer that cannot be read stops a command, and lets a merge go on', (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 }, baseFiles: { '.aidrian.json': 'not json' }, files: { '.aidrian.json': pointer('.aidrian') } });
  tracking(r);
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /project folder differs from/u);
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
});

test('the hold is skipped when the guard\'s time is gone', (t) => {
  const r = moved(t);
  rmSync(path.join(r.dir, HEAD_RECORD));
  tracking(r);
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused, startedAt: Date.now() - 60_000 }), null);
});

for (const [name, match, make, bound] of [
  ['the base ref', '*refs/remotes/origin*', moved, 5000],
  ['the base\'s config', '*" show "*', moved, 5000],
  ['the checkout list', '*" worktree list "*', (t) => repo(t, { baseConfig: INSIDE_TEAM, headConfig: INSIDE_TEAM }), 4000],
  ['the state folder\'s name', '*" --show-prefix "*', (t) => stateUnset(t).r, 5000],
]) {
  test(`a git that stalls on ${name} lets the merge go on within ${bound} ms`, (t) => {
    const r = make(t);
    rmSync(path.join(r.dir, HEAD_RECORD), { force: true });
    tracking(r);
    const started = Date.now();
    const hook = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: r.dir, tool_input: { command: `gh pr merge 7 --match-head-commit ${r.head}` } }),
      encoding: 'utf8',
      env: { ...process.env, AIDRIAN_TELEMETRY: '0', PATH: fakeGit(t, match, 'exec sleep 30') },
    });
    assert.ok(Date.now() - started < bound, `the hook took ${Date.now() - started} ms`);
    assert.equal(hook.status, 0, hook.stderr);
  });
}

test('the merge guard keeps its path when no ref names the base', (t) => {
  const r = moved(t);
  rmSync(path.join(r.dir, HEAD_RECORD));
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
});

// ---- waive and extend publish only after the hold, by the base branch's review.record

// A record waiting for the judge's word on the head, for `extend`.
const judging = (r) => writeLocalState(r.project, { ...emptyState(7, 'o/r'), extensions: [{ source: 'plan', round: 3, head: r.head, status: 'judging', mode: 'ask', red_flags: [] }] });
const roundCapped = (r) => writeLocalState(r.project, { ...emptyState(7, 'o/r'), outcome: { status: 'round_limit', head: r.head, at: '2026-11-03T14:00:00.000Z' } });

test('extend keeps its local write and publishes nothing when the pull request cannot be read', async (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 } });
  quiet(t);
  judging(r);
  const offline = { ...r.forge, change: () => { throw new Error('offline'); } };
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  assert.equal(await runExtend(['7', '--verdict', 'stop', '--reason', 'why'], r.project, r.config, { forge: offline, repo: 'o/r', env: {} }), 0);
  assert.equal(readLocalState(r.project, 7).extensions[0].status, 'stopped');
  assert.equal(r.comments.length, 0);
  assert.match(JSON.parse(lines.at(-1)).summary_error, /nothing was posted/u);
});

test('waive refuses when the pull request names no base, before it reads the record', async (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1 } });
  quiet(t);
  roundCapped(r);
  const unnamed = { ...r.forge, change: () => ({ headRefOid: r.head }) };
  await assert.rejects(runWaive(['7', '--verdict', 'refuse', '--reason', 'why'], r.project, r.config, { forge: unnamed, repo: 'o/r', env: {} }), /cannot read the pull request's base branch/u);
  assert.equal(readLocalState(r.project, 7).waivers, undefined);
});

test('a head that commits review.record local still posts on waive and extend', async (t) => {
  const r = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1, review: { record: 'local' } } });
  quiet(t);
  roundCapped(r);
  assert.equal(await runWaive(['7', '--verdict', 'refuse', '--reason', 'why'], r.project, r.config, { forge: { ...r.forge, viewer: () => 'someone' }, repo: 'o/r', env: {} }), 0);
  assert.equal(r.comments.length, 1, 'waive posts');
  judging(r);
  r.comments.length = 0;
  assert.equal(await runExtend(['7', '--verdict', 'stop', '--reason', 'why'], r.project, r.config, { forge: { ...r.forge, viewer: () => 'someone' }, repo: 'o/r', env: {} }), 0);
  assert.equal(r.comments.length, 1, 'extend posts');
});

test('a base branch that commits review.record local keeps waive and extend off the pull request', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, headConfig: { version: 1, review: { record: 'comment' } } });
  quiet(t);
  roundCapped(r);
  assert.equal(await runWaive(['7', '--verdict', 'refuse', '--reason', 'why'], r.project, r.config, { forge: r.forge, repo: 'o/r', env: {} }), 0);
  judging(r);
  assert.equal(await runExtend(['7', '--verdict', 'stop', '--reason', 'why'], r.project, r.config, { forge: r.forge, repo: 'o/r', env: {} }), 0);
  assert.equal(r.comments.length, 0);
});

// Whether `run` reads the pull request's comments, seen through a fake on PATH.
async function readsComments(t, run) {
  const bin = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-fake-')));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const seen = path.join(bin, 'seen');
  writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ntouch "${seen}"\nexit 1\n`, { mode: 0o755 });
  const before = process.env.PATH;
  process.env.PATH = `${bin}:${before}`;
  t.after(() => (process.env.PATH = before));
  await run();
  process.env.PATH = before;
  return existsSync(seen);
}
const attestReadsComments = (t, r) => readsComments(t, async () => assert.equal(await runAttest(['7', '--pass', 'p', '--head', r.head, '--reviewer', 'code-reviewer', '--findings', '0', '--fixed', '0'], r.project, r.config, { forge: r.forge }), 0));
const signoffReadsComments = (t, r) => readsComments(t, () => assert.rejects(runSignoff(['7', '--flow', 'f', '--head', r.head], r.project, r.config, { forge: r.forge }), /no review of o\/r#7 ran on/u));

test('attest takes review.record from the base branch: a local base stays off the pull request, a local head does not', async (t) => {
  quiet(t);
  const offHead = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, headConfig: { version: 1, review: { record: 'comment' } } });
  assert.equal(await attestReadsComments(t, offHead), false);
  const onHead = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1, review: { record: 'local' } } });
  assert.equal(await attestReadsComments(t, onHead), true);
});

test('the long form of signoff takes review.record from the base branch', async (t) => {
  quiet(t);
  const offHead = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, headConfig: { version: 1, review: { record: 'comment' } } });
  assert.equal(await signoffReadsComments(t, offHead), false);
  const onHead = repo(t, { baseConfig: { version: 1 }, headConfig: { version: 1, review: { record: 'local' } } });
  assert.equal(await signoffReadsComments(t, onHead), true);
});

test('signoff --last takes review.record from the base branch', async (t) => {
  quiet(t);
  const reads = async (baseRecord, headRecord) => {
    const r = repo(t, { baseConfig: { version: 1, review: { record: baseRecord } }, headConfig: { version: 1, review: { record: headRecord } } });
    let count = 0;
    const forge = { ...r.forge, conversationComments: () => (count += 1, []) };
    await assert.rejects(runSignoff(['7', '--last'], r.project, r.config, { forge }), /no review of o\/r#7 ran/u);
    return count;
  };
  assert.equal(await reads('local', 'comment'), 0, 'a local base stays off the pull request');
  assert.equal(await reads('comment', 'local'), 1, 'a local head does not');
});

// `await-review --request` with the bot's rounds at the cap, and a member's summary comment that holds a newer record.
async function awaitAtCap(t, baseRecord, headRecord) {
  const github = { extraRounds: 'ask' };
  const r = repo(t, { baseConfig: { version: 1, github, review: { record: baseRecord } }, headConfig: { version: 1, github, review: { record: headRecord } } });
  const at = '2026-08-23T08:00:00Z';
  const body = summaryBody({ ...emptyState(7, 'o/r'), revision: 9, overrides: ['FROM-COMMENT'] }, null, 'x');
  r.comments.push({ id: 1, body, user: { login: 'someone' }, author_association: 'MEMBER', created_at: at });
  const reviews = [1, 2, 3].map((id) => ({ id, user: { login: DEFAULT_REVIEWER }, submitted_at: at, commit_id: r.git('rev-parse', 'main'), state: 'COMMENTED' }));
  const forge = {
    ...r.forge,
    change: () => ({ number: 7 }),
    viewer: () => 'someone',
    pull: () => ({ title: 't', body: 'b', base: { ref: 'main' }, head: { sha: r.head, ref: 'feat', repo: { full_name: 'o/r' } } }),
    commit: () => ({ commit: { committer: { date: at } } }),
    reviews: () => reviews,
    reviewComments: () => [],
    reactions: () => [],
  };
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  await runAwaitReview(['7', '--request', '--timeout-sec', '0'], r.config, r.project, { forge, git: { pushedHead: () => null, behind: () => false }, env: {}, now: () => Date.parse('2026-08-23T09:00:00Z'), sleep: async () => {} });
  t.mock.restoreAll();
  return { status: JSON.parse(lines.at(-1)).status, overrides: readLocalState(r.project, 7)?.overrides, edited: r.comments[0].body !== body, comments: r.comments.length };
}

test('await-review at the cap takes review.record from the base branch', async (t) => {
  const off = await awaitAtCap(t, 'local', 'comment');
  assert.equal(off.status, 'extension_check');
  assert.deepEqual([off.overrides, off.edited, off.comments], [[], false, 1], 'a local base neither reads nor writes the comment');
  const on = await awaitAtCap(t, 'comment', 'local');
  assert.equal(on.status, 'extension_check');
  assert.deepEqual([on.overrides, on.edited], [['FROM-COMMENT'], true], 'a local head does not keep it off');
});

// ---- ingest and request

test('ingest refuses the same checkout when the forge names the base', async (t) => {
  const r = moved(t);
  quiet(t);
  writeFileSync(path.join(r.dir, 'shot.png'), 'x');
  await assert.rejects(runIngest(['7', '--head', r.head, '--source', 'run 12', 'shot.png'], r.project, r.config, { forge: r.forge, env: {} }), DIFFERS);
});

test('ingest reads review.record from the base branch', async (t) => {
  const r = repo(t, { baseConfig: { version: 1, review: { record: 'local' } }, headConfig: { version: 1, review: { record: 'comment' } } });
  const lines = [];
  t.mock.method(console, 'log', (line) => lines.push(line));
  const shot = path.join(r.dir, 'shot.png');
  writeFileSync(shot, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  assert.equal(await runIngest(['7', '--head', r.head, '--source', 'run 12', shot], r.project, r.config, { forge: r.forge, env: {} }), 0);
  assert.ok(lines.includes('the review record is local, so no captures comment shows the ingest'));
});

test('aidrian pr request refuses the same checkout when it reads the base', (t) => {
  const r = moved(t);
  quiet(t);
  assert.throws(() => runRequest(['7'], r.project, { forge: r.forge }), DIFFERS);
});
