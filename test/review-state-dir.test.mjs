// The review record is read from `state.dir`, so every command that reads it at a pull request's head checkout holds the
// working copy's value to the base branch's, as auto-merge does, and the review step reads `review.record` as the base
// branch commits it. docs/review.md#the-record describes it.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadConfig } from '../plugins/aidrian/lib/config.mjs';
import { DEFAULT_REVIEWER } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { projectAt } from '../plugins/aidrian/lib/project.mjs';
import { runAwaitReview } from '../plugins/aidrian/lib/pr-await-review.mjs';
import { runAttest, runIngest, runSignoff } from '../plugins/aidrian/lib/review-gate.mjs';
import { runExtend } from '../plugins/aidrian/lib/review/extension.mjs';
import { holdToBase } from '../plugins/aidrian/lib/review/in-force.mjs';
import { runRequest } from '../plugins/aidrian/lib/review/pending.mjs';
import { reviewStep } from '../plugins/aidrian/lib/review/run.mjs';
import { emptyState, readLocalState, summaryBody, writeLocalState } from '../plugins/aidrian/lib/review/state.mjs';
import { runWaive } from '../plugins/aidrian/lib/review/waiver.mjs';
import { check, judgeMerge } from '../plugins/aidrian/lib/rules/github/merge-review.mjs';

const DIFFERS = /the working copy's state\.dir differs from o\/r main, and the review record is read from it/u;
const HEAD_RECORD = 'head-state/reviews/pr-7-review.json';
const clean = async () => ({ status: 'done', findings: [], verdicts: [], dropped: [] });

// A repository with `main` carrying `baseConfig` and `baseFiles`, checked out on a `feat` branch that commits
// `headConfig`, `files`, `links` (name to target), and a code change. GitHub is faked in memory. Either config null writes none.
function repo(t, { baseConfig, headConfig, files = {}, baseFiles = {}, links = {} }) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-dir-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
  if (baseConfig) write('.aidrian/config.json', JSON.stringify(baseConfig));
  for (const [file, text] of Object.entries(baseFiles)) write(file, text);
  write('src/app.js', 'export const app = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feat');
  write('src/app.js', 'export const app = 2;\n');
  if (headConfig) write('.aidrian/config.json', JSON.stringify(headConfig));
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
  return { dir, git, head, forge, comments, project, config, step };
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
  const r = repo(t, { baseConfig: { version: 1, state: { dir: 'state' } }, headConfig: { version: 1, state: { dir: 'state' } } });
  assert.equal((await r.step()).status, 'received');
  assert.equal(r.comments.length, 1);
  assert.ok(existsSync(path.join(r.dir, 'state/reviews/pr-7-review.json')));
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
  const r = repo(t, { baseConfig: { version: 1, state: { dir: 'state' } }, headConfig: { version: 1, state: { dir: 'state' } } });
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'gone' }), /^Error: the base branch gone is not in this checkout: git fetch first$/u);
  const { baseTip, committed } = holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' });
  assert.equal(baseTip, r.git('rev-parse', 'main'));
  assert.equal(committed.state.dir, 'state');
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
  const same = repo(t, { baseConfig: null, headConfig: null, baseFiles: { '.aidrian.json': pointer('cfg'), 'cfg/config.json': at('state') } });
  assert.equal(holdToBase(same.project, same.config, { repo: 'o/r', base: 'main' }).committed.state.dir, 'state');
  const other = repo(t, { baseConfig: null, headConfig: null, baseFiles: { '.aidrian.json': pointer('cfg'), 'cfg/config.json': at('state') }, files: { 'cfg/config.json': at('elsewhere') } });
  assert.throws(() => holdToBase(other.project, other.config, { repo: 'o/r', base: 'main' }), DIFFERS);
});

test('a pull request that adopts aidrian is held to a base with no config at all', (t) => {
  const r = repo(t, { baseConfig: null, headConfig: null, files: { '.aidrian.json': pointer('other'), 'other/config.json': JSON.stringify({ version: 1 }) } });
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, null);
});

// ---- files in the state folder

test('a state folder that holds tracked files is refused, whatever the base branch says', async (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'state/reviews/pr-7-review.json': `${JSON.stringify(emptyState(7, 'o/r'))}\n` } });
  await assert.rejects(r.step(), /^Error: the state folder holds files git tracks at this checkout, and the review record is read from it$/u);
  assert.equal(r.comments.length, 0);
});

test('a state folder git ignores is held like any other', async (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state/\n' } });
  mkdirSync(path.join(r.dir, 'state/reviews'), { recursive: true });
  writeFileSync(path.join(r.dir, 'state/reviews/pr-7-review.json'), `${JSON.stringify(emptyState(7, 'o/r'))}\n`);
  assert.equal((await r.step()).status, 'received');
});

test('a link on the state folder\'s path is refused', (t) => {
  const team = { version: 1, state: { dir: 'shared/state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'elsewhere/keep.txt': 'x\n' }, links: { shared: 'elsewhere' } });
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /the state folder holds files git tracks at this checkout/u);
});

test('a tracked file beside the state folder is no reason to refuse', (t) => {
  const team = { version: 1, state: { dir: 'data/state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'data/readme.md': 'x\n', 'data/statement.md': 'x\n' } });
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, 'data/state');
});

test('state.dir "." is refused, since the checkout holds tracked files', (t) => {
  const team = { version: 1, state: { dir: '.' } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /the state folder holds files git tracks at this checkout/u);
});

// Whether this disk reads a name in another case as the same file.
const caseSensitiveDisk = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aidrian-case-'));
  writeFileSync(path.join(dir, 'probe'), '');
  const sensitive = !existsSync(path.join(dir, 'PROBE'));
  rmSync(dir, { recursive: true, force: true });
  return sensitive;
})();

test('a tracked path the disk reads as the state folder is refused', { skip: caseSensitiveDisk }, (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'STATE/reviews/pr-7-review.json': `${JSON.stringify(emptyState(7, 'o/r'))}\n` } });
  const refused = () => assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /the state folder holds files git tracks at this checkout/u);
  refused();
  // With the disk spelling the folder as state.dir names it, the tracked name alone differs in case.
  renameSync(path.join(r.dir, 'STATE'), path.join(r.dir, 'renaming'));
  renameSync(path.join(r.dir, 'renaming'), path.join(r.dir, 'state'));
  refused();
});

test('a tracked path reached through a link on the state folder\'s path is refused', (t) => {
  const team = { version: 1, state: { dir: 'alias/state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'alias\n', 'real/state/keep.json': '{}\n' } });
  symlinkSync('real', path.join(r.dir, 'alias'));
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /the state folder holds files git tracks at this checkout/u);
});

test('a broken link on the path of a state folder outside the checkout is not listed', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(path.join(outside, 'gone'), path.join(outside, 'broken'));
  const team = { version: 1, state: { dir: path.join(outside, 'broken/state') } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, team.state.dir);
});

test('a state folder outside the checkout is not listed', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const team = { version: 1, state: { dir: outside } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, outside);
});

// ---- the merge guard

const tracking = (r) => {
  r.git('update-ref', 'refs/remotes/origin/main', r.git('rev-parse', 'main'));
  r.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
};
const unused = () => assert.fail('the merge names its head: no view');

// A project at a new linked worktree of `r`, detached at `commit`, and the hold from there.
function linkedAt(t, r, commit) {
  const folder = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-linked-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const worktree = path.join(folder, 'worktree');
  r.git('worktree', 'add', '-q', '--detach', worktree, commit);
  const project = projectAt(worktree);
  const config = loadConfig(project).config;
  return { project, config, hold: () => holdToBase(project, config, { repo: 'o/r', base: 'main' }) };
}

const TRACKED = /^Error: the state folder holds files git tracks at this checkout, and the review record is read from it$/u;

test('a state folder in the main checkout is listed there from a linked worktree', async (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'state/reviews/pr-7-review.json': `${JSON.stringify(emptyState(7, 'o/r'))}\n` } });
  tracking(r);

  // The main checkout tracks a file in the state folder: refused from a linked worktree on the base.
  const linked = linkedAt(t, r, 'main');
  assert.throws(linked.hold, TRACKED);
  const step = reviewStep({ pr: '7' }, { project: linked.project, config: linked.config, forge: r.forge, codex: () => ({ ok: true }), exec: clean });
  await assert.rejects(step, TRACKED);
  assert.equal(r.comments.length, 0);
  assert.match(judgeMerge({ project: linked.project, pr: 7, head: r.head, viewPr: unused }), /the state folder holds files git tracks at this checkout/u);

  // The main checkout clean: it holds, from a linked worktree on the base and from one that tracks the same path.
  r.git('switch', '-q', 'main');
  assert.equal(linked.hold().committed.state.dir, 'state');
  assert.equal(judgeMerge({ project: linked.project, pr: 7, head: r.head, viewPr: unused }), null);
  assert.equal(linkedAt(t, r, r.head).hold().committed.state.dir, 'state');
});

test('a link on the state folder\'s path in the main checkout is compared there from a linked worktree', (t) => {
  const team = { version: 1, state: { dir: 'shared/state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { 'elsewhere/keep.txt': 'x\n' }, links: { shared: 'elsewhere' } });
  assert.throws(linkedAt(t, r, 'main').hold, TRACKED);
});

test('a link that leads out of the checkout on the state folder\'s path is refused', (t) => {
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  mkdirSync(path.join(outside, 'state'));
  for (const [dir, link] of [['state', 'state'], ['shared/state', 'shared']]) {
    const team = { version: 1, state: { dir } };
    const r = repo(t, { baseConfig: team, headConfig: team, links: { [link]: outside } });
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), TRACKED, `in the checkout, at ${dir}`);
    assert.throws(linkedAt(t, r, 'main').hold, TRACKED, `from a linked worktree, at ${dir}`);
  }
  // The same link in no index is allowed: nothing git tracks is on the path.
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state\n' } });
  symlinkSync(outside, path.join(r.dir, 'state'));
  assert.equal(holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }).committed.state.dir, 'state');
});

test('a broken link at the state folder in the main checkout is compared there from a linked worktree', (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, links: { state: 'gone' } });
  assert.throws(linkedAt(t, r, 'main').hold, TRACKED);
});

// A repository of its own at `folder` in `r`, with one empty commit: { git, commit }.
function nestedAt(r, folder) {
  const dir = path.join(r.dir, folder);
  mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.email=t@example.com', '-c', 'user.name=Tester', ...args], { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'one');
  return { git, commit: git('rev-parse', 'HEAD') };
}

test('every checkout around the state folder is listed', (t) => {
  const hold = (r) => () => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' });
  const merge = (r) => judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused });

  // A nested checkout at the folder, with no index around it naming the folder: it holds. The outer index's entry at the
  // folder is a tracked path there.
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state/\n' } });
  tracking(r);
  const { commit } = nestedAt(r, 'state');
  assert.equal(hold(r)().committed.state.dir, 'state');
  assert.equal(merge(r), null);
  r.git('update-index', '--add', '--cacheinfo', `160000,${commit},state`);
  assert.throws(hold(r), TRACKED);
  assert.match(merge(r), /the state folder holds files git tracks at this checkout/u);

  // Two checkouts in from the outer one: its entry at a folder above the state folder counts too.
  const deep = { version: 1, state: { dir: 'a/b/state' } };
  const d = repo(t, { baseConfig: deep, headConfig: deep, files: { '.gitignore': 'a/\n' } });
  const middle = nestedAt(d, 'a');
  nestedAt(d, 'a/b/state');
  assert.equal(hold(d)().committed.state.dir, 'a/b/state');
  d.git('update-index', '--add', '--cacheinfo', `160000,${middle.commit},a`);
  assert.throws(hold(d), TRACKED);
});

test('files the outer checkout tracks at the state folder are refused with a nested repository there', async (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state/\n' } });
  tracking(r);
  nestedAt(r, 'state');
  const record = 'state/reviews/pr-7-review.json';
  mkdirSync(path.join(r.dir, 'state/reviews'));
  writeFileSync(path.join(r.dir, record), `${JSON.stringify(emptyState(7, 'o/r'))}\n`);
  r.git('update-index', '--add', '--cacheinfo', `100644,${r.git('rev-parse', 'HEAD:src/app.js')},${record}`);
  await assert.rejects(r.step(), TRACKED);
  assert.equal(r.comments.length, 0);
  assert.match(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), /the state folder holds files git tracks at this checkout/u);
});

test('a state folder that is its own repository with commits is refused', (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state/\n' } });
  const own = nestedAt(r, 'state');
  writeFileSync(path.join(r.dir, 'state/keep.txt'), 'x\n');
  own.git('add', 'keep.txt');
  own.git('commit', '-q', '-m', 'two');
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), TRACKED);
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
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team });
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

test('a list git cannot answer stops a command, and lets a merge go on', (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team });
  tracking(r);
  const before = process.env.PATH;
  process.env.PATH = fakeGit(t, '*" ls-files "*', 'exit 1');
  t.after(() => (process.env.PATH = before));
  assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /git cannot list the state folder at this checkout/u);
  assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null);
});

test('a checkout lookup git cannot answer stops a command, lets a merge go on, and no repository around is no failure', (t) => {
  const team = { version: 1, state: { dir: 'state' } };
  const r = repo(t, { baseConfig: team, headConfig: team, files: { '.gitignore': 'state/\n' } });
  tracking(r);
  const before = process.env.PATH;
  t.after(() => (process.env.PATH = before));
  const lookup = '*" rev-parse --show-toplevel "*';
  for (const [name, act] of [
    ['an owner git refuses', 'echo "fatal: detected dubious ownership in repository" >&2; exit 128'],
    ['a git file that leads nowhere', 'echo "fatal: not a git repository: /gone" >&2; exit 128'],
    ['another status', 'echo "not a git repository (or any of the parent directories): .git" >&2; exit 1'],
    ['a read that was stopped', 'kill -9 $$'],
  ]) {
    process.env.PATH = fakeGit(t, lookup, act);
    assert.throws(() => holdToBase(r.project, r.config, { repo: 'o/r', base: 'main' }), /git cannot list the state folder at this checkout/u, name);
    assert.equal(judgeMerge({ project: r.project, pr: 7, head: r.head, viewPr: unused }), null, name);
  }
  process.env.PATH = before;

  // A folder in no work tree, with git itself answering.
  const inGit = { version: 1, state: { dir: '.git/state' } };
  const g = repo(t, { baseConfig: inGit, headConfig: inGit });
  mkdirSync(path.join(g.dir, '.git/state'));
  assert.throws(() => holdToBase(g.project, g.config, { repo: 'o/r', base: 'main' }), /git cannot list the state folder at this checkout/u);

  // No repository around the folder, whatever language the machine reads git in.
  const outside = realpathSync(mkdtempSync(path.join(tmpdir(), 'aidrian-state-out-')));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const out = { version: 1, state: { dir: outside } };
  const o = repo(t, { baseConfig: out, headConfig: out });
  process.env.PATH = fakeGit(t, lookup, '[ "$LC_ALL" = C ] || { echo "Schwerwiegend: Kein Git-Repository" >&2; exit 128; }');
  assert.equal(holdToBase(o.project, o.config, { repo: 'o/r', base: 'main' }).committed.state.dir, outside);
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

const HOOK = path.join(import.meta.dirname, '../plugins/aidrian/scripts/hook-bash.mjs');
for (const [name, match, make] of [
  ['the base ref', '*refs/remotes/origin*', moved],
  ['the base\'s config', '*" show "*', moved],
  ['the list of tracked files', '*" ls-files "*', (t) => repo(t, { baseConfig: { version: 1, state: { dir: 'state' } }, headConfig: { version: 1, state: { dir: 'state' } } })],
  ['the checkout lookup', '*" rev-parse --show-toplevel "*', (t) => repo(t, { baseConfig: { version: 1, state: { dir: 'state' } }, headConfig: { version: 1, state: { dir: 'state' } } })],
]) {
  test(`a git that stalls on ${name} lets the merge go on inside the hook's 5 s`, (t) => {
    const r = make(t);
    rmSync(path.join(r.dir, HEAD_RECORD), { force: true });
    tracking(r);
    const started = Date.now();
    const hook = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: 'Bash', cwd: r.dir, tool_input: { command: `gh pr merge 7 --match-head-commit ${r.head}` } }),
      encoding: 'utf8',
      env: { ...process.env, AIDRIAN_TELEMETRY: '0', PATH: fakeGit(t, match, 'exec sleep 30') },
    });
    assert.ok(Date.now() - started < 5000, `the hook took ${Date.now() - started} ms`);
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
